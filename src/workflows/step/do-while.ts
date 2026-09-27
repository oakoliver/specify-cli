/**
 * @oakoliver/specify-cli - Do-While Loop Step
 *
 * Port of ``specify_cli/workflows/step/do_while/__init__.py``: execute at
 * least once, then repeat while condition is truthy.
 *
 * @module workflows/step/do-while
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
import { conditionValidationErrors } from '../expressions.js';

/**
 * Execute body at least once, then check condition.
 *
 * Continues while condition is truthy. ``max_iterations`` is an optional
 * safety cap (defaults to 10 if omitted). The engine re-evaluates
 * ``step_config['condition']`` after each iteration.
 */
export class DoWhileStep extends StepBase {
  static override typeKey = 'do-while';

  execute(config: Dict, _context: StepContext): StepResult {
    let maxIterations = dget(config, 'max_iterations', null);
    if (maxIterations === null || maxIterations === undefined) maxIterations = 10;
    const nestedSteps = dget(config, 'steps', []);
    const condition = dget(config, 'condition', 'false');

    if (!Array.isArray(nestedSteps)) {
      return new StepResult({
        status: StepStatus.FAILED,
        output: { condition, max_iterations: maxIterations, loop_type: 'do-while' },
        error:
          `Do-while step ${stepIdRepr(config)}: 'steps' must be ` +
          `a list of steps, got ${pyTypeName(nestedSteps)}.`,
      });
    }

    return new StepResult({
      status: StepStatus.COMPLETED,
      output: { condition, max_iterations: maxIterations, loop_type: 'do-while' },
      nextSteps: nestedSteps as Dict[],
    });
  }

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    const id = stepIdRepr(config);
    errors.push(...conditionValidationErrors('Do-while', config));
    const maxIter = dget(config, 'max_iterations', null);
    if (maxIter !== null && maxIter !== undefined) {
      if (!isInt(maxIter) || maxIter < 1) {
        errors.push(`Do-while step ${id}: 'max_iterations' must be an integer >= 1.`);
      }
    }
    if (!dhas(config, 'steps')) {
      errors.push(`Do-while step ${id} is missing 'steps' field.`);
    }
    const nested = dget(config, 'steps', []);
    if (!Array.isArray(nested)) {
      errors.push(`Do-while step ${id}: 'steps' must be a list.`);
    }
    return errors;
  }
}
