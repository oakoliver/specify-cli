/**
 * @oakoliver/specify-cli - The current workflow expression engine
 *
 * Port of ``specify_cli/workflows/expressions/engine_current.py``: the grammar
 * walk, the filter dispatcher, template interpolation, and the probe
 * primitives the condition diagnostics consume. Imported only by ``engine.ts``
 * and the package facade.
 *
 * @module workflows/expressions/engine-current
 */

import { ValueError, pyEquals, pyParseFloat, pyParseInt, pyStr, pyTruthy, type Dict } from '../base.js';
import {
  REGISTERED_FILTERS,
  ZERO_ARG_FILTERS,
  filterContains,
  filterDefault,
  filterJoin,
  filterMap,
  filterSplit,
} from './filters.js';
import { NAMESPACE_ROOTS, resolveDotPath } from './namespace.js';
import { safeCompare, safeMembership } from './operators.js';
import {
  collapseWhitespace,
  findBlockClose,
  findTopLevel,
  isSingleExpression,
  isSingleListLiteral,
  isWrappedInParens,
  splitTopLevel,
  splitTopLevelCommas,
} from './template.js';

export { firstUnclosableBlock, isSingleExpression } from './template.js';

const LEADING_WORD = /^[\p{L}\p{N}\p{M}_]+/u;

/** Apply a single pipe filter segment to *value*. */
function applyFilter(value: unknown, filterExpr: string, namespace: Dict): unknown {
  const leadingMatch = LEADING_WORD.exec(filterExpr);
  const leading = leadingMatch ? leadingMatch[0] : null;
  // Zero-argument filters are strict: no arguments, no trailing tokens.
  if (leading !== null && Object.prototype.hasOwnProperty.call(ZERO_ARG_FILTERS, leading)) {
    if (filterExpr !== leading) {
      throw new ValueError(
        `${leading}: expected '| ${leading}' with no arguments or ` +
          `trailing tokens, got '| ${filterExpr}'`,
      );
    }
    return (ZERO_ARG_FILTERS[leading] as (v: unknown) => unknown)(value);
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
    if (fname === 'split') return filterSplit(value, farg);
  }
  if (filterExpr === 'default') return filterDefault(value);

  const name = leading ?? filterExpr;
  const expected =
    "expected one of default or default('x'), join('sep'), " +
    "map('attr'), contains('s'), split('sep'), from_json, upper, " +
    'lower, length, or to_json';
  if (REGISTERED_FILTERS.includes(name)) {
    throw new ValueError(
      `filter '${name}' used in an unsupported form (got ` + `'| ${filterExpr}'): ${expected}`,
    );
  }
  throw new ValueError(`unknown filter '${name}': ${expected} (got '| ${filterExpr}')`);
}

/** Order matters -- multi-char operators first, so "!=" is not split as "!" + "=". */
export const COMPARISON_OPERATORS = ['!=', '==', '>=', '<=', '>', '<', ' not in ', ' in '] as const;

/**
 * Set only while ``collectLeaves`` probes an expression; ``null`` everywhere
 * else. (Evaluation is synchronous, so a module-level slot is safe.)
 */
export let leafSink: string[] | null = null;

/**
 * Namespace for the parse probe: every root exists, every leaf is absent.
 * Passed as the outer namespace it also tells the evaluator to visit both
 * operands of ``and``/``or`` instead of short-circuiting.
 */
class ProbeNamespace {
  [key: string]: unknown;
}

function probeRoots(): Dict {
  const ns = new ProbeNamespace();
  for (const root of NAMESPACE_ROOTS) ns[root] = new ProbeNamespace();
  return ns as Dict;
}

/**
 * Evaluate a simple expression against the namespace.
 *
 * Supports dot-path access, comparisons, boolean operators, ``in``/``not in``,
 * parenthesised groups, pipe filters, and string/numeric/boolean/null/list
 * literals.
 */
function evaluateSimpleExpression(exprIn: string, namespace: Dict): unknown {
  const expr = collapseWhitespace(exprIn);

  // String literal — only when the WHOLE expression is one quoted string.
  const first = expr.slice(0, 1);
  if ((first === "'" || first === '"') && expr.indexOf(first, 1) === expr.length - 1) {
    return expr.slice(1, -1);
  }

  // A parenthesised group wrapping the whole expression.
  if (isWrappedInParens(expr)) return evaluateSimpleExpression(expr.slice(1, -1), namespace);

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

  const probing = namespace instanceof ProbeNamespace;

  // Boolean operators — 'or' first (lower precedence). Runtime short-circuits;
  // validation probes still visit operands that runtime can skip.
  const orIdx = findTopLevel(expr, ' or ');
  if (orIdx !== -1) {
    const left = evaluateSimpleExpression(expr.slice(0, orIdx).trim(), namespace);
    if (pyTruthy(left) && !probing) return true;
    const right = evaluateSimpleExpression(expr.slice(orIdx + 4).trim(), namespace);
    return pyTruthy(left) || pyTruthy(right);
  }

  const andIdx = findTopLevel(expr, ' and ');
  if (andIdx !== -1) {
    const left = evaluateSimpleExpression(expr.slice(0, andIdx).trim(), namespace);
    if (!pyTruthy(left) && !probing) return false;
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
 * Evaluate *template* against an already-built *namespace*: the raw value
 * when the whole template is one ``{{ ... }}`` block, else an interpolated
 * string.
 */
export function evaluateTemplate(template: string, namespace: Dict): unknown {
  const stripped = template.trim();
  if (isSingleExpression(stripped)) {
    return evaluateSimpleExpression(stripped.slice(2, -2).trim(), namespace);
  }
  return interpolateExpressions(template, namespace);
}

/** The evaluator's own complaint about how *text* is wired, or ``null``. */
export function evaluatorRejects(text: string): string | null {
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
export function collectLeaves(text: string): string[] {
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

/** The operators the evaluator delimits with spaces. */
export const WORD_OPERATORS: readonly string[] = [' or ', ' and ', ...COMPARISON_OPERATORS].filter((op) =>
  op.startsWith(' '),
);

function rstrip(s: string): string {
  return s.replace(/\s+$/, '');
}
function lstrip(s: string): string {
  return s.replace(/^\s+/, '');
}

/** True when an operator in *text* is missing an operand on either side. */
export function hasIncompleteOperand(text: string): boolean {
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
