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
import { CliExit, errConsole, escapeMarkup } from './console.js';
import { resolvePathLoose } from './download-security.js';
import type { FileHelper } from './file-helper.js';
import { ProjectPolicyError, projectFiles } from './file-policy.js';
import { pyJsonDumps } from './utils.js';

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
  let initRoot: string;
  try {
    initRoot = resolvePathLoose(path.resolve(process.cwd(), raw));
  } catch (e) {
    throw new ProjectResolutionError(`Cannot resolve SPECIFY_INIT_DIR '${raw}': ${(e as Error).message}`);
  }
  if (!isDir(initRoot)) {
    throw new ProjectResolutionError(`SPECIFY_INIT_DIR does not point to an existing directory: ${raw}`);
  }
  preflightProjectPolicy(initRoot);
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
    if (e instanceof ProjectResolutionError) renderProjectError(e);
    throw e;
  }
}

function isSymlinkPath(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Validate at the resolved project boundary without printing or caching (#4934). */
export function preflightProjectPolicy(projectRoot: string): void {
  try {
    projectFiles(projectRoot);
  } catch (e) {
    if (!(e instanceof ProjectPolicyError)) throw e;
    const marker = path.join(projectRoot, '.specify');
    let error: ProjectResolutionError;
    if (isSymlinkPath(marker)) {
      error = new ProjectResolutionError(`Refusing to use symlinked .specify path: ${marker}. ${e.message}`);
    } else if (lexists(marker) && !isDir(marker)) {
      error = new ProjectResolutionError(
        `Not a Spec Kit project: .specify path exists but is not a directory: ${marker}`,
      );
    } else {
      error = new ProjectResolutionError(e.message);
    }
    (error as { cause?: unknown }).cause = e;
    throw error;
  }
}

/**
 * Whether the running command emits machine-readable output (upstream reads
 * the click context's `json_output` / `as_json` params). The CLI dispatcher
 * sets this from argv; commands may also set it explicitly.
 */
export const projectErrorContext = { json: false };

/** Render a project failure on the current command's error surface, then exit 1. */
export function renderProjectError(error: ProjectResolutionError): never {
  if (projectErrorContext.json) {
    process.stderr.write(pyJsonDumps({ error: error.message }, { ensureAscii: false }) + '\n');
  } else {
    errConsole.print(`[red]Error:[/red] ${escapeMarkup(error.message)}`);
  }
  const exit = new CliExit(1);
  (exit as { cause?: unknown }).cause = error;
  throw exit;
}

/** Resolve the active project and hand its current policy to domain consumers. */
export function resolveSpecifyProjectFiles(): FileHelper {
  return projectFiles(resolveSpecifyProjectRoot());
}

/** Return the active project root without rendering errors (throws ProjectResolutionError). */
export function resolveSpecifyProjectRoot(): string {
  const override = resolveInitDirOverrideUnrendered();
  if (override !== null) return override;
  const projectRoot = process.cwd();
  preflightProjectPolicy(projectRoot);
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
  const projectRoot = override !== null ? override : process.cwd();
  try {
    preflightProjectPolicy(projectRoot);
  } catch (e) {
    if (e instanceof ProjectResolutionError) renderProjectError(e);
    throw e;
  }
  if (isDir(path.join(projectRoot, '.specify'))) return projectRoot;
  errConsole.print('[red]Error:[/red] Not a Spec Kit project (no .specify/ directory)');
  errConsole.print('Run this command from a Spec Kit project root or set SPECIFY_INIT_DIR to one.');
  throw new CliExit(1);
}
