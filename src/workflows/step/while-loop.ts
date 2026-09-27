/**
 * @oakoliver/specify-cli - While Loop Step
 *
 * Port of ``specify_cli/workflows/step/while_loop/__init__.py``: repeat while
 * condition is truthy.
 *
 * @module workflows/step/while-loop
 */

import {
  StepBase,
  StepContext,
  StepResult,
  StepStatus,
  dget,
  dhas,
  isInt,
  pyTypeName,
  stepIdRepr,
  type Dict,
} from '../base.js';
import { conditionValidationErrors, evaluateCondition } from '../expressions.js';

/**
 * Repeat nested steps while condition is truthy.
 *
 * Evaluates condition *before* each iteration. If falsy on first check, the
 * body never runs. ``max_iterations`` is an optional safety cap (defaults to
 * 10 if omitted).
 */
export class WhileStep extends StepBase {
  static override typeKey = 'while';

  execute(config: Dict, context: StepContext): StepResult {
    const condition = dget(config, 'condition', false);
    let maxIterations = dget(config, 'max_iterations', null);
    if (maxIterations === null || maxIterations === undefined) maxIterations = 10;
    const nestedSteps = dget(config, 'steps', []);

    const result = evaluateCondition(condition, context);

    if (result && !Array.isArray(nestedSteps)) {
      return new StepResult({
        status: StepStatus.FAILED,
        output: { condition_result: true, max_iterations: maxIterations, loop_type: 'while' },
        error:
          `While step ${stepIdRepr(config)}: 'steps' must be a ` +
          `list of steps, got ${pyTypeName(nestedSteps)}.`,
      });
    }

    if (result) {
      return new StepResult({
        status: StepStatus.COMPLETED,
        output: { condition_result: true, max_iterations: maxIterations, loop_type: 'while' },
        nextSteps: nestedSteps as Dict[],
      });
    }

    return new StepResult({
      status: StepStatus.COMPLETED,
      output: { condition_result: false, max_iterations: maxIterations, loop_type: 'while' },
    });
  }

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    const id = stepIdRepr(config);
    errors.push(...conditionValidationErrors('While', config));
    const maxIter = dget(config, 'max_iterations', null);
    if (maxIter !== null && maxIter !== undefined) {
      if (!isInt(maxIter) || maxIter < 1) {
        errors.push(`While step ${id}: 'max_iterations' must be an integer >= 1.`);
      }
    }
    if (!dhas(config, 'steps')) {
      errors.push(`While step ${id} is missing 'steps' field.`);
    }
    const nested = dget(config, 'steps', []);
    if (!Array.isArray(nested)) {
      errors.push(`While step ${id}: 'steps' must be a list.`);
    }
    return errors;
  }
}
