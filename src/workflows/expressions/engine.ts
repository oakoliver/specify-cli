/**
 * @oakoliver/specify-cli - Workflow expression engine selection point
 *
 * Port of ``specify_cli/workflows/expressions/engine.py``. Every runtime use
 * (``api.ts``) and every validation use (``diagnostics.ts``) imports the
 * evaluator only through this module, so one line here switches both.
 *
 * @module workflows/expressions/engine
 */

export {
  COMPARISON_OPERATORS,
  WORD_OPERATORS,
  collectLeaves,
  evaluateTemplate,
  evaluatorRejects,
  firstUnclosableBlock,
  hasIncompleteOperand,
  isSingleExpression,
} from './engine-current.js';
