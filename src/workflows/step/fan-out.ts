/**
 * @oakoliver/specify-cli - Fan-Out Step
 *
 * Port of ``specify_cli/workflows/step/fan_out/__init__.py``: dispatch a step
 * template over a collection.
 *
 * @module workflows/step/fan-out
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
  pyTypeName,
  stepIdRepr,
  type Dict,
} from '../base.js';
import { evaluateExpression } from '../expressions.js';

/**
 * Dispatch a step template for each item in a collection.
 *
 * The engine executes the nested ``step:`` template once per item, setting
 * ``context.item`` for each iteration. ``max_concurrency`` controls
 * parallelism: ``<= 1`` (the default) runs items sequentially, while ``> 1``
 * runs up to that many items concurrently (see ``WorkflowEngine.runFanOut``).
 */
export class FanOutStep extends StepBase {
  static override typeKey = 'fan-out';

  execute(config: Dict, context: StepContext): StepResult {
    const id = stepIdRepr(config);
    const itemsExpr = dget(config, 'items', '[]');
    const items = evaluateExpression(itemsExpr, context);
    const maxConcurrency = dget(config, 'max_concurrency', 1);
    const stepTemplate = dget(config, 'step', {});

    if (!isDict(stepTemplate)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error:
          `Fan-out step ${id}: 'step' must be a ` +
          `mapping (nested step template), got ${pyTypeName(stepTemplate)}.`,
        output: { items: [], max_concurrency: maxConcurrency, step_template: {}, item_count: 0 },
      });
    }

    if (!Array.isArray(items)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error:
          `Fan-out step ${id}: 'items' must ` +
          `resolve to a list, got ${pyTypeName(items)} from ${pyRepr(itemsExpr)}.`,
        output: {
          items: [],
          max_concurrency: maxConcurrency,
          step_template: stepTemplate,
          item_count: 0,
        },
      });
    }

    return new StepResult({
      status: StepStatus.COMPLETED,
      output: {
        items,
        max_concurrency: maxConcurrency,
        step_template: stepTemplate,
        item_count: items.length,
      },
    });
  }

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    const id = stepIdRepr(config);
    if (!dhas(config, 'items')) {
      errors.push(`Fan-out step ${id} is missing 'items' field.`);
    }
    if (!dhas(config, 'step')) {
      errors.push(`Fan-out step ${id} is missing 'step' field (nested step template).`);
    } else if (!isDict(config.step)) {
      errors.push(`Fan-out step ${id}: 'step' must be a mapping.`);
    }
    return errors;
  }
}
