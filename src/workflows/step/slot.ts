/**
 * @oakoliver/specify-cli - Slot Step
 *
 * Port of ``specify_cli/workflows/step/slot/__init__.py``: a named, no-op
 * workflow slot.
 *
 * An upstream workflow declares a slot at the position where a downstream
 * project may extend it. The step ``id`` is the overlay anchor; ``name`` is
 * only the human-readable slot label. A project overlay fills the slot with the
 * standard ``replace`` operation on the slot step's ``id``. Unfilled slots are
 * skipped when the workflow runs.
 *
 * @module workflows/step/slot
 */

import { StepBase, StepContext, StepResult, StepStatus, dget, stepIdRepr, type Dict } from '../base.js';

/** Provide a named workflow slot that skips when unfilled. */
export class SlotStep extends StepBase {
  static override typeKey = 'slot';

  execute(config: Dict, context: StepContext): StepResult {
    if (context.insideFanOut) {
      return new StepResult({
        status: StepStatus.FAILED,
        error:
          `Slot step ${stepIdRepr(config)} is not supported ` +
          'inside fan-out templates because overlays cannot address ' +
          'runtime-multiplied templates.',
      });
    }
    return new StepResult({
      status: StepStatus.SKIPPED,
      output: { slot: dget(config, 'name', null) ?? null },
    });
  }

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    const name = dget(config, 'name', null);
    if (name === null || name === undefined) {
      errors.push(`Slot step ${stepIdRepr(config)} requires a 'name' field (the slot label).`);
    } else if (typeof name !== 'string' || !name.trim()) {
      errors.push(`Slot step ${stepIdRepr(config)}: 'name' must be a non-blank string.`);
    }
    return errors;
  }
}
