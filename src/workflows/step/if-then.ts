/**
 * @oakoliver/specify-cli - If/Then/Else Step
 *
 * Port of ``specify_cli/workflows/step/if_then/__init__.py``: conditional
 * branching.
 *
 * @module workflows/step/if-then
 */

import {
  StepBase,
  StepContext,
  StepResult,
  StepStatus,
  dget,
  dhas,
  pyRepr,
  pyTypeName,
  stepIdRepr,
  type Dict,
} from '../base.js';
import { conditionValidationErrors, evaluateCondition } from '../expressions.js';

/**
 * Branch based on a boolean condition expression.
 *
 * Both ``then:`` and ``else:`` contain inline step arrays — full step
 * definitions, not ID references.
 */
export class IfThenStep extends StepBase {
  static override typeKey = 'if';

  execute(config: Dict, context: StepContext): StepResult {
    const condition = dget(config, 'condition', false);
    const result = evaluateCondition(condition, context);

    let branchName: string;
    let branch: unknown;
    if (result) {
      branchName = 'then';
      branch = dget(config, 'then', []);
    } else {
      branchName = 'else';
      branch = dget(config, 'else', []);
    }

    if ((branch === null || branch === undefined) && branchName === 'else') {
      branch = [];
    } else if (!Array.isArray(branch)) {
      return new StepResult({
        status: StepStatus.FAILED,
        output: { condition_result: result },
        error:
          `If step ${stepIdRepr(config)}: ${pyRepr(branchName)} must be ` +
          `a list of steps, got ${pyTypeName(branch)}.`,
      });
    }

    return new StepResult({
      status: StepStatus.COMPLETED,
      output: { condition_result: result },
      nextSteps: branch as Dict[],
    });
  }

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    const id = stepIdRepr(config);
    errors.push(...conditionValidationErrors('If', config));
    if (!dhas(config, 'then')) {
      errors.push(`If step ${id} is missing 'then' field.`);
    }
    const thenBranch = dget(config, 'then', []);
    if (!Array.isArray(thenBranch)) {
      errors.push(`If step ${id}: 'then' must be a list of steps.`);
    }
    const elseBranch = dget(config, 'else', null);
    if (elseBranch !== null && elseBranch !== undefined && !Array.isArray(elseBranch)) {
      errors.push(`If step ${id}: 'else' must be a list of steps.`);
    }
    return errors;
  }
}
