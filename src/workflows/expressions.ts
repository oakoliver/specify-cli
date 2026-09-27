/**
 * @oakoliver/specify-cli - Workflow Expression Evaluator
 *
 * Port of ``specify_cli/workflows/expressions.py``.
 *
 * Sandboxed expression evaluator for workflow templates. Provides a safe
 * Jinja2 subset for evaluating expressions in workflow YAML. Templates cannot
 * perform file I/O, import modules, or run arbitrary code — the evaluator only
 * walks the namespace and applies a fixed set of filters.
 *
 * @module workflows/expressions
 */

import {
  ValueError,
  isDict,
  pyCompare,
  pyContains,
  pyEquals,
  pyParseFloat,
  pyParseInt,
  pyRepr,
  pyStr,
  pyTruthy,
  pyTypeName,
  type Dict,
} from './base.js';

// ============================================================================
// Filters
// ============================================================================

/**
 * The filters the expression evaluator recognizes. Used to tell a
 * *registered* filter used in an unsupported form (e.g. `| join` with no
 * argument) apart from a genuinely unknown filter name.
 */
const REGISTERED_FILTERS: readonly string[] = ['default', 'join', 'map', 'contains', 'from_json'];

/** Return *defaultValue* when *value* is ``None`` or empty string. */
function filterDefault(value: unknown, defaultValue: unknown = ''): unknown {
  if (value === null || value === undefined || value === '') return defaultValue;
  return value;
}

/** Join a list into a string with *separator*. */
function filterJoin(value: unknown, separator: unknown = ', '): string {
  if (typeof separator !== 'string') {
    throw new ValueError(`join: expected a string separator, got ${pyTypeName(separator)}`);
  }
  if (Array.isArray(value)) return value.map((v) => pyStr(v)).join(separator);
  return pyStr(value);
}

/** Map a list of dicts to a specific attribute (dot notation supported). */
function filterMap(value: unknown, attr: unknown): unknown[] {
  if (typeof attr !== 'string') {
    throw new ValueError(`map: expected a string attribute name, got ${pyTypeName(attr)}`);
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      if (isDict(item)) {
        const parts = attr.split('.');
        let v: unknown = item;
        for (const part of parts) {
          if (isDict(v)) {
            v = Object.prototype.hasOwnProperty.call(v, part) ? v[part] : null;
          } else {
            v = null;
            break;
          }
        }
        result.push(v === undefined ? null : v);
      } else {
        result.push(item);
      }
    }
    return result;
  }
  return [];
}

/** Check if a string or list contains *substring*. */
function filterContains(value: unknown, substring: unknown): boolean {
  if (typeof value === 'string') {
    if (typeof substring !== 'string') {
      throw new ValueError(
        'contains: expected a string argument when the value is a ' +
          `string, got ${pyTypeName(substring)}`,
      );
    }
    return value.includes(substring);
  }
  if (Array.isArray(value)) return value.some((v) => pyEquals(v, substring));
  return false;
}

/** Parse a JSON string into a typed value (list/dict/scalar). */
function filterFromJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new ValueError(`from_json: expected a JSON string, got ${pyTypeName(value)}`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (exc) {
    throw new ValueError(`from_json: invalid JSON: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
}

// ============================================================================
// Path resolution & namespace
// ============================================================================

/**
 * The one definition of an indexed path segment. ``resolveDotPath`` matches
 * against it, and the condition gate below reuses it.
 */
const INDEXED_SEGMENT = /^([\p{L}\p{N}\p{M}_-]+)\[(\d+)\]$/u;
const PLAIN_SEGMENT = /^[\p{L}\p{N}\p{M}_-]+$/u;
const LEADING_WORD = /^[\p{L}\p{N}\p{M}_]+/u;

function dictGet(obj: Dict, key: string): unknown {
  const v = Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null;
  return v === undefined ? null : v;
}

/**
 * Resolve a dotted path like ``steps.specify.output.file`` against *obj*.
 * Supports dict key access and list indexing (e.g., ``task_list[0]``).
 */
function resolveDotPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    const idxMatch = INDEXED_SEGMENT.exec(part);
    if (idxMatch) {
      const key = idxMatch[1] as string;
      const idx = parseInt(idxMatch[2] as string, 10);
      if (isDict(current)) current = dictGet(current, key);
      else return null;
      if (Array.isArray(current) && idx >= 0 && idx < current.length) current = current[idx];
      else return null;
    } else if (isDict(current)) {
      current = dictGet(current, part);
    } else {
      return null;
    }
    if (current === null || current === undefined) return null;
  }
  return current;
}

/** Minimal shape of a context accepted by the evaluator (a ``StepContext``). */
export interface ExpressionContext {
  inputs?: Dict | null;
  steps?: Record<string, unknown> | null;
  item?: unknown;
  fanIn?: Dict | null;
  runId?: string | null;
  workflowDir?: string | null;
}

/** Build the variable namespace from a StepContext. */
function buildNamespace(context: unknown): Dict {
  const ns: Dict = {};
  const ctx = (isDict(context) ? context : {}) as ExpressionContext & Dict;
  if ('inputs' in ctx) ns.inputs = ctx.inputs || {};
  if ('steps' in ctx) ns.steps = ctx.steps || {};
  if ('item' in ctx) ns.item = ctx.item === undefined ? null : ctx.item;
  if ('fanIn' in ctx) ns.fan_in = ctx.fanIn || {};
  // Engine-managed runtime metadata. Always present (even outside a run) so
  // templates referencing it never error.
  const runId = ctx.runId || '';
  const workflowDir = ctx.workflowDir || '';
  ns.context = { run_id: runId, workflow_dir: workflowDir };
  return ns;
}

// ============================================================================
// Block scanning
// ============================================================================

function isQuote(ch: string): boolean {
  return ch === "'" || ch === '"';
}

/** True when *stripped* is exactly one top-level ``{{ ... }}`` block. */
function isSingleExpression(stripped: string): boolean {
  if (!(stripped.startsWith('{{') && stripped.endsWith('}}'))) return false;
  const inner = stripped.slice(2, -2);
  if (!inner.trim()) return false;
  let quote: string | null = null;
  const n = inner.length;
  for (let i = 0; i < n; i++) {
    const ch = inner[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (isQuote(ch)) {
      quote = ch;
    } else if (ch === '}' && i + 1 < n && inner[i + 1] === '}') {
      return false;
    }
  }
  return true;
}

/** Index of the ``}}`` closing the block opened by the ``{{`` at *start*, or -1. */
function findBlockClose(text: string, start: number): number {
  let quote: string | null = null;
  const n = text.length;
  for (let i = start + 2; i < n; i++) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (isQuote(ch)) {
      quote = ch;
    } else if (ch === '}' && i + 1 < n && text[i + 1] === '}') {
      return i;
    }
  }
  return -1;
}

/**
 * How interpolation will fail on the first block it cannot close with the
 * quote-aware scan, or ``null`` when every block closes.
 */
function firstUnclosableBlock(text: string): 'evaluated' | 'verbatim' | null {
  let i = 0;
  for (;;) {
    const start = text.indexOf('{{', i);
    if (start === -1) return null;
    const close = findBlockClose(text, start);
    if (close === -1) return text.indexOf('}}', start + 2) !== -1 ? 'evaluated' : 'verbatim';
    i = close + 2;
  }
}

/** Substitute every top-level ``{{ ... }}`` block in *template*, quote-aware. */
function interpolateExpressions(template: string, namespace: Dict): string {
  const out: string[] = [];
  let i = 0;
  const n = template.length;
  while (i < n) {
    const start = template.indexOf('{{', i);
    if (start === -1) {
      out.push(template.slice(i));
      break;
    }
    out.push(template.slice(i, start));
    let close = findBlockClose(template, start);
    if (close === -1) {
      const rawClose = template.indexOf('}}', start + 2);
      if (rawClose === -1) {
        out.push(template.slice(start));
        break;
      }
      close = rawClose;
    }
    const val = evaluateSimpleExpression(template.slice(start + 2, close).trim(), namespace);
    out.push(val !== null && val !== undefined ? pyStr(val) : '');
    i = close + 2;
  }
  return out.join('');
}

/**
 * Return the index of the first occurrence of *token* in *text* that lies
 * outside any quoted string or nested bracket, or ``-1``.
 */
function findTopLevel(text: string, token: string): number {
  let quote: string | null = null;
  let depth = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (isQuote(ch)) {
      quote = ch;
    } else if ('([{'.includes(ch)) {
      depth += 1;
    } else if (')]}'.includes(ch)) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && text.startsWith(token, i)) {
      return i;
    }
  }
  return -1;
}

/** Split *text* on each top-level occurrence of *sep*. */
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (;;) {
    const idx = findTopLevel(text.slice(start), sep);
    if (idx === -1) {
      parts.push(text.slice(start));
      return parts;
    }
    parts.push(text.slice(start, start + idx));
    start += idx + sep.length;
  }
}

/** Split *text* on commas that are not inside quotes or nested brackets. */
function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of text) {
    if (quote !== null) {
      buf += ch;
      if (ch === quote) quote = null;
    } else if (isQuote(ch)) {
      quote = ch;
      buf += ch;
    } else if ('([{'.includes(ch)) {
      depth += 1;
      buf += ch;
    } else if (')]}'.includes(ch)) {
      depth = Math.max(0, depth - 1);
      buf += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  return parts;
}

/** ``True`` only when *expr* is exactly one bracketed list literal. */
function isSingleListLiteral(expr: string): boolean {
  if (!(expr.startsWith('[') && expr.endsWith(']'))) return false;
  let quote: string | null = null;
  let depth = 0;
  const n = expr.length;
  for (let i = 0; i < n; i++) {
    const ch = expr[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (isQuote(ch)) quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) return i === n - 1;
    }
  }
  return false;
}

// ============================================================================
// Filter application
// ============================================================================

/** Apply a single pipe filter segment to *value*. */
function applyFilter(value: unknown, filterExpr: string, namespace: Dict): unknown {
  const leadingMatch = LEADING_WORD.exec(filterExpr);
  const leading = leadingMatch ? leadingMatch[0] : null;
  if (leading === 'from_json') {
    if (filterExpr !== 'from_json') {
      throw new ValueError(
        "from_json: expected '| from_json' with no arguments or " +
          `trailing tokens, got '| ${filterExpr}'`,
      );
    }
    return filterFromJson(value);
  }

  let filterMatch = /^([\p{L}\p{N}\p{M}_]+)\(([^\n]+)\)$/u.exec(filterExpr);
  if (filterMatch && findTopLevel(filterMatch[2] as string, ',') !== -1) filterMatch = null;
  if (filterMatch) {
    const fname = filterMatch[1] as string;
    const farg = evaluateSimpleExpression((filterMatch[2] as string).trim(), namespace);
    if (fname === 'default') return filterDefault(value, farg);
    if (fname === 'join') return filterJoin(value, farg);
    if (fname === 'map') return filterMap(value, farg);
    if (fname === 'contains') return filterContains(value, farg);
  }
  if (filterExpr === 'default') return filterDefault(value);

  const name = leading ?? filterExpr;
  const expected =
    "expected one of default or default('x'), join('sep'), " +
    "map('attr'), contains('s'), or from_json";
  if (REGISTERED_FILTERS.includes(name)) {
    throw new ValueError(
      `filter '${name}' used in an unsupported form (got ` + `'| ${filterExpr}'): ${expected}`,
    );
  }
  throw new ValueError(`unknown filter '${name}': ${expected} (got '| ${filterExpr}')`);
}

// ============================================================================
// Expression evaluation
// ============================================================================

/**
 * Order matters -- multi-char operators first, so "!=" is not split as "!" + "=".
 */
const COMPARISON_OPERATORS = ['!=', '==', '>=', '<=', '>', '<', ' not in ', ' in '] as const;

/**
 * Set only while ``collectLeaves`` probes an expression; ``null`` everywhere
 * else. (Evaluation is synchronous, so a module-level slot is safe.)
 */
let leafSink: string[] | null = null;

/** Namespace placeholder for the parse probe: an always-empty mapping. */
class ProbeNamespace {}

function probeRoots(): Dict {
  const ns: Dict = {};
  for (const root of NAMESPACE_ROOTS) ns[root] = new ProbeNamespace();
  return ns;
}

/**
 * Evaluate a simple expression against the namespace.
 *
 * Supports dot-path access, comparisons, boolean operators, ``in``/``not in``,
 * pipe filters, and string/numeric/boolean/null/list literals.
 */
function evaluateSimpleExpression(exprIn: string, namespace: Dict): unknown {
  const expr = exprIn.trim();

  // String literal — only when the WHOLE expression is one quoted string.
  const first = expr.slice(0, 1);
  if ((first === "'" || first === '"') && expr.indexOf(first, 1) === expr.length - 1) {
    return expr.slice(1, -1);
  }

  // Pipe filters (top-level only), chained left-to-right.
  const pipeIdx = findTopLevel(expr, '|');
  if (pipeIdx !== -1) {
    const segments = splitTopLevel(expr, '|');
    const head = (segments[0] as string).trim();
    let ambiguousOp: string | null = head.startsWith('not ') ? 'not' : null;
    if (ambiguousOp === null) {
      for (const op of ['!=', '==', '>=', '<=', '>', '<', ' not in ', ' in ', ' or ', ' and ']) {
        if (findTopLevel(head, op) !== -1) {
          ambiguousOp = op.trim();
          break;
        }
      }
    }
    if (ambiguousOp !== null) {
      throw new ValueError(
        `ambiguous filter precedence in '${expr}': ` +
          `'| ${(segments[1] as string).trim()}' would apply to the result of ` +
          `'${head}', not to an operand of '${ambiguousOp}'. Filter the ` +
          'operand in its own expression instead.',
      );
    }
    let value = evaluateSimpleExpression(head, namespace);
    const sink = leafSink;
    for (const segment of segments.slice(1)) {
      if (sink === null) {
        value = applyFilter(value, segment.trim(), namespace);
        continue;
      }
      try {
        value = applyFilter(value, segment.trim(), namespace);
      } catch {
        value = new ProbeNamespace();
      }
    }
    return value;
  }

  // Boolean operators — 'or' first (lower precedence).
  const orIdx = findTopLevel(expr, ' or ');
  if (orIdx !== -1) {
    const left = evaluateSimpleExpression(expr.slice(0, orIdx).trim(), namespace);
    const right = evaluateSimpleExpression(expr.slice(orIdx + 4).trim(), namespace);
    return pyTruthy(left) || pyTruthy(right);
  }

  const andIdx = findTopLevel(expr, ' and ');
  if (andIdx !== -1) {
    const left = evaluateSimpleExpression(expr.slice(0, andIdx).trim(), namespace);
    const right = evaluateSimpleExpression(expr.slice(andIdx + 5).trim(), namespace);
    return pyTruthy(left) && pyTruthy(right);
  }

  if (expr.startsWith('not ')) {
    const inner = evaluateSimpleExpression(expr.slice(4).trim(), namespace);
    return !pyTruthy(inner);
  }

  for (const op of COMPARISON_OPERATORS) {
    const opIdx = findTopLevel(expr, op);
    if (opIdx !== -1) {
      const left = evaluateSimpleExpression(expr.slice(0, opIdx).trim(), namespace);
      const right = evaluateSimpleExpression(expr.slice(opIdx + op.length).trim(), namespace);
      switch (op) {
        case '==':
          return pyEquals(left, right);
        case '!=':
          return !pyEquals(left, right);
        case '>':
        case '<':
        case '>=':
        case '<=':
          return safeCompare(left, right, op);
        case ' in ':
          return safeMembership(left, right, false);
        case ' not in ':
          return safeMembership(left, right, true);
      }
    }
  }

  // Numeric literal
  const num = expr.includes('.') ? pyParseFloat(expr) : pyParseInt(expr);
  if (num !== null) return num;

  // Boolean literal
  if (expr.toLowerCase() === 'true') return true;
  if (expr.toLowerCase() === 'false') return false;

  // Null
  if (expr.toLowerCase() === 'none' || expr.toLowerCase() === 'null') return null;

  // List literal (simple)
  if (isSingleListLiteral(expr)) {
    const inner = expr.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevelCommas(inner)
      .filter((i) => i.trim())
      .map((i) => evaluateSimpleExpression(i.trim(), namespace));
  }

  // Variable reference (dot-path).
  if (leafSink !== null) leafSink.push(expr);
  return resolveDotPath(namespace, expr);
}

/** Return *value* as a number if it is a numeric string, else unchanged. */
function coerceNumber(value: unknown): unknown {
  if (typeof value === 'string') {
    const n = value.includes('.') ? pyParseFloat(value) : pyParseInt(value);
    return n === null ? value : n;
  }
  return value;
}

/** Safely evaluate ``left in right`` (or ``not in``) without crashing. */
function safeMembership(left: unknown, right: unknown, negate: boolean): boolean {
  let contained: boolean;
  try {
    contained = pyContains(right, left);
  } catch (exc) {
    if (!(exc instanceof TypeError)) throw exc;
    contained = false;
  }
  return negate ? !contained : contained;
}

function isNumeric(v: unknown): boolean {
  return typeof v === 'number' || typeof v === 'boolean';
}

/** Compare two values for ordering, coercing numeric strings when possible. */
function safeCompare(left: unknown, right: unknown, op: '>' | '<' | '>=' | '<='): boolean {
  const cl = coerceNumber(left);
  const cr = coerceNumber(right);
  if (isNumeric(cl) && isNumeric(cr)) {
    left = cl;
    right = cr;
  }
  let cmp: number;
  try {
    cmp = pyCompare(left, right);
  } catch (exc) {
    if (exc instanceof TypeError) return false;
    throw exc;
  }
  if (Number.isNaN(cmp)) return false;
  if (op === '>') return cmp > 0;
  if (op === '<') return cmp < 0;
  if (op === '>=') return cmp >= 0;
  return cmp <= 0;
}

/**
 * Evaluate a template string with ``{{ ... }}`` expressions.
 *
 * If the entire string is a single expression, returns the raw value
 * (preserving type). Otherwise, substitutes each expression inline and
 * returns a string. Non-string templates are returned unchanged.
 */
export function evaluateExpression(template: unknown, context: unknown): unknown {
  if (typeof template !== 'string') return template === undefined ? null : template;
  const namespace = buildNamespace(context);
  const stripped = template.trim();
  if (isSingleExpression(stripped)) {
    return evaluateSimpleExpression(stripped.slice(2, -2).trim(), namespace);
  }
  return interpolateExpressions(template, namespace);
}

/**
 * Evaluate a condition expression and return a boolean.
 *
 * Plain "false"/"true" strings (after stripping) are treated as booleans.
 */
export function evaluateCondition(condition: unknown, context: unknown): boolean {
  const result = evaluateExpression(condition, context);
  if (typeof result === 'string') {
    const lower = result.trim().toLowerCase();
    if (lower === 'false') return false;
    if (lower === 'true') return true;
  }
  return pyTruthy(result);
}

/** True when a string *condition* is silently treated as always-true text. */
export function conditionIsNeverEvaluated(condition: unknown): boolean {
  if (typeof condition !== 'string') return false;
  if (condition === '') return false;
  const stripped = condition.trim();
  if (!stripped) return true;
  if (stripped.toLowerCase() === 'true' || stripped.toLowerCase() === 'false') return false;
  if (!stripped.includes('{{')) return true;
  return firstUnclosableBlock(stripped) === 'verbatim';
}

/** True when *condition* holds ``{{ }}`` blocks but is spliced into text, not evaluated. */
export function conditionIsInterpolatedToText(condition: unknown): boolean {
  if (typeof condition !== 'string') return false;
  const stripped = condition.trim();
  if (!stripped || !stripped.includes('{{')) return false;
  if (conditionIsNeverEvaluated(condition) || conditionHasMalformedExpressionBlock(condition)) {
    return false;
  }
  return !isSingleExpression(stripped);
}

/**
 * True when *condition* holds a ``{{`` block the quote-aware scan cannot close,
 * but which interpolation still evaluates through its raw-close fallback.
 */
export function conditionHasMalformedExpressionBlock(condition: unknown): boolean {
  if (typeof condition !== 'string') return false;
  const stripped = condition.trim();
  if (!stripped || stripped.toLowerCase() === 'true' || stripped.toLowerCase() === 'false') {
    return false;
  }
  return firstUnclosableBlock(stripped) === 'evaluated';
}

/** Remove every ``{{``/``}}`` that lies outside a quoted operand. */
function stripStrayDelimiters(text: string): string {
  const out: string[] = [];
  let quote: string | null = null;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (quote !== null) {
      out.push(ch);
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (isQuote(ch)) {
      quote = ch;
      out.push(ch);
      i += 1;
      continue;
    }
    if (text.startsWith('{{', i) || text.startsWith('}}', i)) {
      i += 2;
      while (i < n && /\s/.test(text[i] as string)) i += 1;
      while (out.length && /^\s$/.test(out[out.length - 1] as string)) out.pop();
      out.push(' ');
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/** Python ``json.dumps(s, ensure_ascii=False)`` for a string. */
function jsonDumpsStr(s: string): string {
  return JSON.stringify(s);
}

/**
 * Render *condition* wrapped in ``{{ }}`` as a quoted, paste-ready YAML scalar.
 */
export function formatConditionCorrection(condition: unknown): string {
  const core = stripStrayDelimiters(pyStr(condition)).trim();
  const body = core ? '{{ ' + core + ' }}' : '{{ }}';
  return jsonDumpsStr(body);
}

/** True when a quote opened in *text* is never closed. */
function hasUnbalancedQuote(text: string): boolean {
  let quote: string | null = null;
  for (const ch of text) {
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (isQuote(ch)) {
      quote = ch;
    }
  }
  return quote !== null;
}

const BRACKET_PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** The operators the evaluator delimits with spaces. */
const WORD_OPERATORS: readonly string[] = [' or ', ' and ', ...COMPARISON_OPERATORS].filter((op) =>
  op.startsWith(' '),
);

/** True when brackets outside a quoted operand do not nest and match. */
function hasUnbalancedBracket(text: string): boolean {
  const stack: string[] = [];
  let quote: string | null = null;
  for (const ch of text) {
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (isQuote(ch)) {
      quote = ch;
    } else if ('([{'.includes(ch)) {
      stack.push(ch);
    } else if (ch in BRACKET_PAIRS && (!stack.length || stack.pop() !== BRACKET_PAIRS[ch])) {
      return true;
    }
  }
  return stack.length > 0;
}

/** Python ``str.rstrip()`` / ``str.lstrip()`` (whitespace). */
function rstrip(s: string): string {
  return s.replace(/\s+$/, '');
}
function lstrip(s: string): string {
  return s.replace(/^\s+/, '');
}

/** True when an operator in *text* is missing an operand on either side. */
function hasIncompleteOperand(text: string): boolean {
  const stripped = text.trim();
  if (!stripped) return true;
  if (stripped === 'and' || stripped === 'or' || stripped === 'not' || stripped.endsWith(' not')) {
    return true;
  }
  for (const op of WORD_OPERATORS) {
    if (stripped.endsWith(rstrip(op)) || stripped.startsWith(lstrip(op))) return true;
  }
  for (const op of [' or ', ' and ', ...COMPARISON_OPERATORS]) {
    if (findTopLevel(stripped, op) === -1) continue;
    if (splitTopLevel(stripped, op).some((segment) => !segment.trim())) return true;
  }
  return (
    findTopLevel(stripped, '|') !== -1 &&
    splitTopLevel(stripped, '|').some((segment) => !segment.trim())
  );
}

/** The roots ``buildNamespace`` supplies. */
const NAMESPACE_ROOTS = ['inputs', 'steps', 'item', 'fan_in', 'context'] as const;

/** Whether ``resolveDotPath`` can walk *segment*: a name, or a name it indexes. */
function isPathSegment(segment: string): boolean {
  return PLAIN_SEGMENT.test(segment) || INDEXED_SEGMENT.test(segment);
}

/** The evaluator's own complaint about how *text* is wired, or ``null``. */
function evaluatorRejects(text: string): string | null {
  try {
    evaluateSimpleExpression(text, probeRoots());
  } catch (exc) {
    if (exc instanceof ValueError) {
      const message = exc.message;
      if (message.includes("got '| ")) {
        const idx = message.indexOf(':');
        return idx === -1 ? message : message.slice(0, idx);
      }
    }
    return null;
  }
  return null;
}

/** Every substring *text* hands to the evaluator as a name to resolve. */
function collectLeaves(text: string): string[] {
  const leaves: string[] = [];
  const previous = leafSink;
  leafSink = leaves;
  try {
    evaluateSimpleExpression(text, probeRoots());
  } catch {
    // probe values, reported by evaluatorRejects
  } finally {
    leafSink = previous;
  }
  return leaves;
}

/** Why the evaluator cannot resolve the name *leaf*, or ``null``. */
function unresolvableLeaf(leaf: string): string | null {
  const segments = splitTopLevel(leaf, '.');
  const firstSeg = (segments[0] as string).trim();
  if (!isPathSegment(firstSeg)) return `${pyRepr(leaf)} is not a name the evaluator can resolve`;
  let root = firstSeg;
  const indexedRoot = INDEXED_SEGMENT.exec(root);
  if (indexedRoot !== null && indexedRoot[1] === 'item') root = indexedRoot[1];
  if (!(NAMESPACE_ROOTS as readonly string[]).includes(root)) {
    return `${pyRepr(firstSeg)} is not one of the namespace roots (${NAMESPACE_ROOTS.join(', ')})`;
  }
  for (const segment of segments.slice(1)) {
    if (!isPathSegment(segment.trim())) return `${pyRepr(segment.trim())} is not a valid path segment`;
  }
  return null;
}

/** The first name in *text* the evaluator cannot resolve, or ``null``. */
function unresolvableTerm(text: string): string | null {
  const stripped = text.trim();
  if (!stripped) return 'an operand is empty';
  for (const leaf of collectLeaves(stripped)) {
    const reason = unresolvableLeaf(leaf);
    if (reason !== null) return reason;
  }
  return null;
}

/** Why wrapping *core* in ``{{ }}`` would not yield the expression intended. */
function wrappingWouldNotRepair(core: string): string | null {
  if (!core) return 'there is no expression here to wrap';
  if (hasUnbalancedQuote(core)) return 'the quote opened in it is never closed';
  if (hasUnbalancedBracket(core)) return 'its brackets do not balance';
  if (hasIncompleteOperand(core)) return 'an operator in it is missing an operand';
  const unresolvable = unresolvableTerm(core);
  if (unresolvable !== null) return unresolvable;
  const rejected = evaluatorRejects(core);
  if (rejected !== null) return `the evaluator rejects it (${rejected})`;
  return null;
}

/** The advice sentence for a condition that is never evaluated. */
export function formatConditionRemediation(condition: unknown): string {
  const core = stripStrayDelimiters(pyStr(condition)).trim();
  const reason = wrappingWouldNotRepair(core);
  if (reason === null) {
    return 'Wrap the expression: ' + formatConditionCorrection(condition) + '.';
  }
  return (
    `No correction is offered because ${reason}: wrapping it as written would ` +
    'produce a different expression from the one intended, and its result can ' +
    'silently invert the condition rather than repair it. Complete the ' +
    'expression, or use the literal true or false.'
  );
}

/**
 * Shared validator messages for the ``condition`` field of the ``if``,
 * ``while`` and ``do-while`` steps (identical text upstream, differing only in
 * the step label).
 */
export function conditionValidationErrors(label: string, config: Dict): string[] {
  const errors: string[] = [];
  const id = pyRepr(Object.prototype.hasOwnProperty.call(config, 'id') ? config.id : '?');
  if (!Object.prototype.hasOwnProperty.call(config, 'condition')) {
    errors.push(`${label} step ${id} is missing 'condition' field.`);
    return errors;
  }
  const condition = config.condition;
  if (typeof condition !== 'string' && typeof condition !== 'boolean') {
    errors.push(
      `${label} step ${id}: 'condition' must be a string or boolean, got ${pyTypeName(condition)}.`,
    );
  } else if (conditionIsNeverEvaluated(condition)) {
    errors.push(
      `${label} step ${id}: 'condition' ${pyRepr(condition)} is not a single complete '{{ }}' block, so ` +
        'it is never evaluated as an expression and is always true. ' +
        formatConditionRemediation(condition),
    );
  } else if (conditionHasMalformedExpressionBlock(condition)) {
    errors.push(
      `${label} step ${id}: 'condition' ${pyRepr(condition)} opens a '{{' the interpolator cannot ` +
        "close, so it falls back to the first raw '}}' and evaluates a " +
        'truncated expression instead of the one written. Balance the ' +
        'delimiters and quotes.',
    );
  } else if (conditionIsInterpolatedToText(condition)) {
    errors.push(
      `${label} step ${id}: 'condition' ${pyRepr(condition)} holds more than one '{{ }}' block, or ` +
        'text around one, so it is substituted into a string and coerced by ' +
        'bool() instead of being evaluated. Put the whole expression inside a ' +
        "single '{{ }}' block.",
    );
  }
  return errors;
}
