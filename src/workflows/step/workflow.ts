/**
 * @oakoliver/specify-cli - Workflow (call) Step
 *
 * Port of ``specify_cli/workflows/step/workflow/__init__.py`` (upstream
 * #4764): installed workflow calls are scoped execution handled by the engine.
 *
 * @module workflows/step/workflow
 */

import { StepBase, StepContext, StepResult, StepStatus, type Dict } from '../base.js';
import { validateCall } from '../composition.js';

/** ``type: workflow`` — calls an installed workflow inside the current run. */
export class WorkflowStep extends StepBase {
  static override typeKey = 'workflow';

  override validate(config: Dict): string[] {
    return [...super.validate(config), ...validateCall(config)];
  }

  execute(_config: Dict, _context: StepContext): StepResult {
    return new StepResult({ status: StepStatus.FAILED, error: 'Workflow calls require the workflow engine' });
  }
}
