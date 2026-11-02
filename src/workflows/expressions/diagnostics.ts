/**
 * @oakoliver/specify-cli - Workflow condition diagnostics
 *
 * Port of ``specify_cli/workflows/expressions/diagnostics.py``: condition
 * validation and remediation for the ``if``, ``while`` and ``do-while`` steps.
 *
 * @module workflows/expressions/diagnostics
 */

import { pyRepr, pyStr, pyTypeName, type Dict } from '../base.js';
import {
  collectLeaves,
  evaluatorRejects,
  firstUnclosableBlock,
  hasIncompleteOperand,
  isSingleExpression,
} from './engine.js';
import { INDEXED_SEGMENT, NAMESPACE_ROOTS, PLAIN_SEGMENT } from './namespace.js';
import { isQuote, splitTopLevel, stripStrayDelimiters } from './template.js';

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
export function hasUnbalancedQuote(text: string): boolean {
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

/** True when brackets outside a quoted operand do not nest and match. */
export function hasUnbalancedBracket(text: string): boolean {
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

/** Whether ``resolveDotPath`` can walk *segment*: a name, or a name it indexes. */
function isPathSegment(segment: string): boolean {
  return PLAIN_SEGMENT.test(segment) || INDEXED_SEGMENT.test(segment);
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
export function unresolvableTerm(text: string): string | null {
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
