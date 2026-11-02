/**
 * @oakoliver/specify-cli - Workflow expression evaluator (package facade)
 *
 * Port of ``specify_cli/workflows/expressions/__init__.py``. Sandboxed
 * expression evaluator for workflow templates: a safe Jinja2 subset that only
 * walks the namespace and applies a fixed set of filters. Split by
 * responsibility like upstream:
 *
 * - ``namespace``/``filters``/``operators``/``template`` — shared leaves;
 * - ``engine-current`` — the hand-written evaluator behind the contract;
 * - ``engine`` — the selection point;
 * - ``api`` — the public evaluation entry points;
 * - ``diagnostics`` — condition validation and remediation.
 *
 * @module workflows/expressions
 */

export { evaluateCondition, evaluateExpression } from './api.js';
export {
  conditionHasMalformedExpressionBlock,
  conditionIsInterpolatedToText,
  conditionIsNeverEvaluated,
  conditionValidationErrors,
  formatConditionCorrection,
  formatConditionRemediation,
  hasUnbalancedBracket,
  hasUnbalancedQuote,
  unresolvableTerm,
} from './diagnostics.js';
export {
  COMPARISON_OPERATORS,
  WORD_OPERATORS,
  collectLeaves,
  evaluatorRejects,
  hasIncompleteOperand,
} from './engine.js';
export { REGISTERED_FILTERS } from './filters.js';
export type { ExpressionContext } from './namespace.js';
export { stripStrayDelimiters } from './template.js';
