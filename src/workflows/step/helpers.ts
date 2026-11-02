/**
 * @oakoliver/specify-cli - Workflow Step Command Helpers
 *
 * Shared validation helpers for workflow step commands
 * (port of ``workflows/step/_helpers.py``).
 *
 * Preserves the CLI-coupled ``*OrExit`` entry points used by the registered
 * step commands. The behaviour lives in ``./installer.ts``; these wrappers
 * print the shared error prefix and exit, while the domain module stays
 * CLI-independent.
 *
 * @module workflows/step/helpers
 */

import { CliExit, console, escapeMarkup } from '../../console.js';
import {
  MAX_STEP_PACKAGE_BYTES,
  MAX_STEP_PACKAGE_DEPTH,
  MAX_STEP_PACKAGE_FILES,
  RESERVED_STEP_IDS,
  StepInstallError,
  WINDOWS_INVALID_CHARS,
  WINDOWS_RESERVED_NAMES,
  resolveStepsBaseDir,
  stepPackageLimits,
  validateStepId,
} from './installer.js';

export {
  MAX_STEP_PACKAGE_BYTES,
  MAX_STEP_PACKAGE_DEPTH,
  MAX_STEP_PACKAGE_FILES,
  RESERVED_STEP_IDS,
  StepInstallError,
  WINDOWS_INVALID_CHARS,
  WINDOWS_RESERVED_NAMES,
  resolveStepsBaseDir,
  stepPackageLimits,
  validateStepId,
};

/**
 * Validate that ``stepId`` is a single safe path component; exits with
 * code 1 on failure.
 */
export function validateStepIdOrExit(stepId: string): void {
  try {
    validateStepId(stepId);
  } catch (exc) {
    if (!(exc instanceof StepInstallError)) throw exc;
    console.print(`[red]Error:[/red] ${escapeMarkup(exc.message)}`);
    throw new CliExit(1);
  }
}

/** Resolve .specify/workflows/steps while refusing symlinked parent directories. */
export function resolveStepsBaseDirOrExit(projectRoot: string): string {
  try {
    return resolveStepsBaseDir(projectRoot);
  } catch (exc) {
    if (!(exc instanceof StepInstallError)) throw exc;
    console.print(`[red]Error:[/red] ${escapeMarkup(exc.message)}`);
    throw new CliExit(1);
  }
}
