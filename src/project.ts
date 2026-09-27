/**
 * @oakoliver/specify-cli - Project resolution
 *
 * Port of upstream `_project.py` (SPECIFY_INIT_DIR override, project root
 * resolution) plus `requireSpecifyProject()` from `specify_cli/__init__.py`.
 *
 * @module project
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliExit, errConsole } from './console.js';
import { resolvePathLoose } from './download-security.js';

/** A project-root error that callers can render for their own surface. */
export class ProjectResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectResolutionError';
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve `SPECIFY_INIT_DIR` without emitting output. Throws {@link ProjectResolutionError}. */
export function resolveInitDirOverrideUnrendered(): string | null {
  const raw = process.env.SPECIFY_INIT_DIR ?? '';
  if (!raw) return null;
  const initRoot = resolvePathLoose(path.resolve(process.cwd(), raw));
  if (!isDir(initRoot)) {
    throw new ProjectResolutionError(`SPECIFY_INIT_DIR does not point to an existing directory: ${raw}`);
  }
  if (!isDir(path.join(initRoot, '.specify'))) {
    throw new ProjectResolutionError(`SPECIFY_INIT_DIR is not a Spec Kit project (no .specify/ directory): ${initRoot}`);
  }
  return initRoot;
}

/**
 * Resolve the `SPECIFY_INIT_DIR` project override. Returns the validated
 * absolute project root or null when unset; on error prints
 * `[red]Error:[/red] ...` to stderr and throws `CliExit(1)`.
 */
export function resolveInitDirOverride(): string | null {
  try {
    return resolveInitDirOverrideUnrendered();
  } catch (e) {
    if (e instanceof ProjectResolutionError) {
      errConsole.print(`[red]Error:[/red] ${e.message}`);
      throw new CliExit(1);
    }
    throw e;
  }
}

/** Return the active project root without rendering errors (throws ProjectResolutionError). */
export function resolveSpecifyProjectRoot(): string {
  const override = resolveInitDirOverrideUnrendered();
  if (override !== null) return override;
  const projectRoot = process.cwd();
  if (!isDir(path.join(projectRoot, '.specify'))) {
    throw new ProjectResolutionError('Not a Spec Kit project (no .specify/ directory)');
  }
  return projectRoot;
}

/**
 * Return the project root if it is a Spec Kit project, else print the
 * upstream error to stderr and throw `CliExit(1)` (`_require_specify_project`).
 */
export function requireSpecifyProject(): string {
  const override = resolveInitDirOverride();
  if (override !== null) return override;
  const projectRoot = process.cwd();
  if (isDir(path.join(projectRoot, '.specify'))) return projectRoot;
  errConsole.print('[red]Error:[/red] Not a Spec Kit project (no .specify/ directory)');
  errConsole.print('Run this command from a Spec Kit project root or set SPECIFY_INIT_DIR to one.');
  throw new CliExit(1);
}
