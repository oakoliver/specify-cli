/**
 * @oakoliver/specify-cli - Fan-In Step
 *
 * Port of ``specify_cli/workflows/step/fan_in/__init__.py``: join point for
 * parallel steps.
 *
 * @module workflows/step/fan-in
 */

import {
  StepBase,
  StepContext,
  StepResult,
  StepStatus,
  dget,
  isDict,
  pyRepr,
  pyTypeName,
  stepIdRepr,
  type Dict,
} from '../base.js';
import { evaluateExpression } from '../expressions.js';

/**
 * Join point that aggregates results from ``wait_for:`` steps.
 *
 * Reads completed step outputs from ``context.steps`` and collects them into
 * ``output.results``. Does not block; relies on the engine executing steps
 * sequentially.
 */
export class FanInStep extends StepBase {
  static override typeKey = 'fan-in';

  execute(config: Dict, context: StepContext): StepResult {
    const id = stepIdRepr(config);
    const waitFor = dget(config, 'wait_for', []);
    let outputConfig = dget(config, 'output', null);
    if (outputConfig === null || outputConfig === undefined) {
      outputConfig = {};
    } else if (!isDict(outputConfig)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error:
          `Fan-in step ${id}: 'output' must be a ` +
          `mapping of key -> expression, got ${pyTypeName(outputConfig)}.`,
        output: { results: [] },
      });
    }

    if (!Array.isArray(waitFor)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Fan-in step ${id}: 'wait_for' must be a list of step IDs, got ${pyTypeName(waitFor)}.`,
        output: { results: [] },
      });
    }

    const badEntries = waitFor.filter((w) => typeof w !== 'string');
    if (badEntries.length) {
      const first = badEntries[0];
      return new StepResult({
        status: StepStatus.FAILED,
        error:
          `Fan-in step ${id}: 'wait_for' entries ` +
          `must be step-id strings, got ${pyTypeName(first)} (${pyRepr(first)}).`,
        output: { results: [] },
      });
    }

    const results: unknown[] = [];
    for (const stepId of waitFor as string[]) {
      const stepData = Object.prototype.hasOwnProperty.call(context.steps, stepId)
        ? context.steps[stepId]
        : {};
      results.push(isDict(stepData) ? dget(stepData, 'output', {}) : {});
    }

    const prevFanIn = context.fanIn;
    context.fanIn = { results };
    const resolvedOutput: Dict = { results };
    try {
      for (const [key, expr] of Object.entries(outputConfig as Dict)) {
        if (typeof expr === 'string' && expr.includes('{{')) {
          resolvedOutput[key] = evaluateExpression(expr, context);
        } else {
          resolvedOutput[key] = expr;
        }
      }
    } finally {
      context.fanIn = prevFanIn;
    }

    return new StepResult({ status: StepStatus.COMPLETED, output: resolvedOutput });
  }

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    const id = stepIdRepr(config);
    const waitFor = dget(config, 'wait_for', []);
    if (!Array.isArray(waitFor) || !waitFor.length) {
      errors.push(`Fan-in step ${id}: 'wait_for' must be a non-empty list of step IDs.`);
    }
    const output = dget(config, 'output', null);
    if (output !== null && output !== undefined && !isDict(output)) {
      errors.push(
        `Fan-in step ${id}: 'output' must be a mapping of key -> expression, got ${pyTypeName(output)}.`,
      );
    }
    return errors;
  }
}
