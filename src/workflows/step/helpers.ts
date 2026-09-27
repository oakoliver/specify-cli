/**
 * @oakoliver/specify-cli - Workflow Step Command Helpers
 *
 * Shared validation helpers for workflow step commands
 * (port of ``workflows/step/_helpers.py``).
 *
 * @module workflows/step/helpers
 */

import { join } from 'node:path';

import { CliExit, console } from '../../console.js';
import { isDir, isRelativeTo, isSymlink, pathExists, resolvePath } from '../overlay/py-compat.js';

// ============================================================================
// Limits & reserved names
// ============================================================================

/**
 * Custom step packages are downloaded one file at a time; mirror the archive
 * ceilings so a catalog cannot turn individually valid files into an
 * unbounded aggregate download.
 */
export const MAX_STEP_PACKAGE_FILES = 512;
export const MAX_STEP_PACKAGE_BYTES = 50 * 1024 * 1024; // 50 MiB

/** Limits read at call time (tests may lower them, like the upstream monkeypatch points). */
export const stepPackageLimits: { maxFiles: number; maxBytes: number } = {
  maxFiles: MAX_STEP_PACKAGE_FILES,
  maxBytes: MAX_STEP_PACKAGE_BYTES,
};

export const RESERVED_STEP_IDS: ReadonlySet<string> = new Set(['.cache', 'step-registry.json']);

export const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export const WINDOWS_INVALID_CHARS: ReadonlySet<string> = new Set('<>:"|?*'.split(''));

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that ``stepId`` is a single safe path component; exits with
 * code 1 on failure.
 */
export function validateStepIdOrExit(stepId: string): void {
  const stem = stepId ? stepId.split('.')[0].toLowerCase() : '';
  const chars = [...stepId];
  if (
    !stepId ||
    !stepId.trim() ||
    stepId !== stepId.trim() ||
    stepId.includes('/') ||
    stepId.includes('\\') ||
    stepId === '.' ||
    stepId === '..' ||
    stepId.startsWith('.') ||
    stepId.endsWith('.') ||
    stepId.endsWith(' ') ||
    RESERVED_STEP_IDS.has(stepId.toLowerCase()) ||
    WINDOWS_RESERVED_NAMES.has(stem) ||
    chars.some((c) => WINDOWS_INVALID_CHARS.has(c)) ||
    chars.some((c) => (c.codePointAt(0) ?? 0) < 32)
  ) {
    console.print(
      `[red]Error:[/red] Invalid step id '${stepId}': must be a single safe ` +
        'path component (no separators, no leading dot, not a reserved name, ' +
        'no invalid filename characters)',
    );
    throw new CliExit(1);
  }
}

/** Resolve .specify/workflows/steps while refusing symlinked parent directories. */
export function resolveStepsBaseDirOrExit(projectRoot: string): string {
  const projectRootResolved = resolvePath(projectRoot);
  const stepsBaseDirUnresolved = join(projectRoot, '.specify', 'workflows', 'steps');

  let current = projectRoot;
  for (const part of ['.specify', 'workflows', 'steps']) {
    current = join(current, part);
    if (isSymlink(current)) {
      console.print(`[red]Error:[/red] Refusing to use symlinked step directory '${current}'`);
      throw new CliExit(1);
    }
    if (pathExists(current) && !isDir(current)) {
      console.print(`[red]Error:[/red] Step directory path is not a directory: '${current}'`);
      throw new CliExit(1);
    }
  }

  const stepsBaseDir = resolvePath(stepsBaseDirUnresolved);
  if (!isRelativeTo(stepsBaseDir, projectRootResolved)) {
    console.print(`[red]Error:[/red] Step directory escapes project root: '${stepsBaseDir}'`);
    throw new CliExit(1);
  }
  return stepsBaseDir;
}
