/**
 * @oakoliver/specify-cli - Switch Step
 *
 * Port of ``specify_cli/workflows/step/switch/__init__.py``: multi-branch
 * dispatch.
 *
 * @module workflows/step/switch
 */

import {
  StepBase,
  StepContext,
  StepResult,
  StepStatus,
  dget,
  dhas,
  isDict,
  pyRepr,
  pyStr,
  pyTypeName,
  stepIdRepr,
  type Dict,
} from '../base.js';
import { evaluateExpression } from '../expressions.js';

/**
 * Multi-branch dispatch on an expression.
 *
 * Evaluates ``expression:`` once, matches against ``cases:`` keys (exact
 * match; the resolved value is string-coerced and stripped of surrounding
 * whitespace first). Falls through to ``default:`` if no case matches.
 */
export class SwitchStep extends StepBase {
  static override typeKey = 'switch';

  execute(config: Dict, context: StepContext): StepResult {
    const expression = dget(config, 'expression', '');
    const value = evaluateExpression(expression, context);
    const strValue = value !== null && value !== undefined ? pyStr(value).trim() : '';

    const cases = dget(config, 'cases', {});
    if (!isDict(cases)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Switch step ${stepIdRepr(config)}: 'cases' must be a mapping, got ${pyTypeName(cases)}.`,
        output: { matched_case: null, expression_value: value },
      });
    }
    for (const [caseKey, caseSteps] of Object.entries(cases)) {
      if (pyStr(caseKey) === strValue) {
        if (!Array.isArray(caseSteps)) {
          return SwitchStep.nonListBranchFailure(config, `case ${pyRepr(pyStr(caseKey))}`, caseSteps, value);
        }
        return new StepResult({
          status: StepStatus.COMPLETED,
          output: { matched_case: pyStr(caseKey), expression_value: value },
          nextSteps: caseSteps as Dict[],
        });
      }
    }

    let defaultSteps = dget(config, 'default', []);
    if (defaultSteps === null || defaultSteps === undefined) {
      defaultSteps = [];
    } else if (!Array.isArray(defaultSteps)) {
      return SwitchStep.nonListBranchFailure(config, "'default'", defaultSteps, value);
    }
    return new StepResult({
      status: StepStatus.COMPLETED,
      output: { matched_case: '__default__', expression_value: value },
      nextSteps: defaultSteps as Dict[],
    });
  }

  /** Fail the step for a non-list branch instead of crashing the run. */
  static nonListBranchFailure(config: Dict, branchLabel: string, branch: unknown, value: unknown): StepResult {
    return new StepResult({
      status: StepStatus.FAILED,
      output: { matched_case: null, expression_value: value },
      error: `Switch step ${stepIdRepr(config)}: ${branchLabel} must be a list of steps, got ${pyTypeName(branch)}.`,
    });
  }

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    const id = stepIdRepr(config);
    if (!dhas(config, 'expression')) {
      errors.push(`Switch step ${id} is missing 'expression' field.`);
    }
    if (!dhas(config, 'cases')) {
      errors.push(`Switch step ${id} is missing 'cases' field.`);
    }
    const cases = dget(config, 'cases', {});
    if (!isDict(cases)) {
      errors.push(`Switch step ${id}: 'cases' must be a mapping.`);
    } else {
      for (const [key, val] of Object.entries(cases)) {
        if (!Array.isArray(val)) {
          errors.push(`Switch step ${id}: case ${pyRepr(key)} must be a list of steps.`);
        }
      }
    }
    const def = dget(config, 'default', null);
    if (def !== null && def !== undefined && !Array.isArray(def)) {
      errors.push(`Switch step ${id}: 'default' must be a list of steps.`);
    }
    return errors;
  }
}
