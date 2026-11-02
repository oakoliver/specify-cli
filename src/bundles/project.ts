/**
 * @oakoliver/specify-cli - Bundle project detection
 *
 * Spec Kit project detection and active-integration resolution.
 *
 * Port of ``specify_cli/bundles/project.py``.
 *
 * @module bundles/project
 */

import { existsSync, lstatSync } from 'node:fs';
import * as path from 'node:path';

import { errConsole, CliExit } from '../console.js';
import { ProjectPolicyError, projectFiles } from '../file-policy.js';
import { ProjectResolutionError, resolveInitDirOverrideUnrendered } from '../project.js';
import { cleanIntegrationKey, dedupeIntegrationKeys } from '../integration-state.js';
import { BundlerError } from './index.js';
import { ensureWithin, loadJson } from './yamlio.js';
import { isMapping, resolvePath } from './pycompat.js';

export const DEFAULT_INTEGRATION = 'copilot';


// ``_file_policy.ProjectPolicyError`` / ``project_files`` (shared port in src/file-policy.ts).
export { ProjectPolicyError };

function lstatMode(p: string): 'missing' | 'link' | 'dir' | 'file' | 'other' {
  let st;
  try {
    st = lstatSync(p);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw exc;
  }
  if (st.isSymbolicLink()) return 'link';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

/**
 * Injectable seam for ``specify_cli._file_policy.project_files``. The
 * integrator can point ``projectFiles`` at the shared FileHelper port; it must
 * throw {@link ProjectPolicyError} (or a subclass) on a policy failure.
 */
export const projectPolicyDeps = {
  projectFiles(projectRoot: string): unknown {
    return projectFiles(projectRoot);
  },
};

/** ``_project.preflight_project_policy`` (errors carry the policy error as cause). */
export function preflightProjectPolicy(projectRoot: string): void {
  try {
    projectPolicyDeps.projectFiles(projectRoot);
  } catch (exc) {
    if (!(exc instanceof ProjectPolicyError)) throw exc;
    const marker = path.join(projectRoot, '.specify');
    const mode = lstatMode(marker);
    let message: string;
    if (mode === 'link') {
      message = `Refusing to use symlinked .specify path: ${marker}. ${exc.message}`;
    } else if (mode !== 'missing' && mode !== 'dir') {
      message = `Not a Spec Kit project: .specify path exists but is not a directory: ${marker}`;
    } else {
      message = exc.message;
    }
    const error = new ProjectResolutionError(message);
    (error as Error & { cause?: unknown }).cause = exc;
    throw error;
  }
}

function preflightPolicy(root: string): void {
  try {
    projectPolicyDeps.projectFiles(root);
  } catch (exc) {
    if (exc instanceof ProjectPolicyError) throw new BundlerError(exc.message, { cause: exc });
    throw exc;
  }
}

/**
 * Return the nearest ancestor (incl. *start*) containing a ``.specify/``
 * entry, or null.
 *
 * A present ``.specify`` entry establishes the candidate boundary. Forbidden
 * links, non-directory markers and corrupt policy fail there instead of
 * silently selecting an ancestor. Only absent markers continue ancestor
 * discovery.
 *
 * When *start* is omitted the ``SPECIFY_INIT_DIR`` override is honored first;
 * with an explicit override this may **throw** rather than return (a policy
 * failure throws {@link BundlerError}; any other invalid value prints the
 * error and throws ``CliExit``).
 */
export function findProjectRoot(start: string | null = null): string | null {
  if (start === null) {
    let override: string | null;
    try {
      override = resolveInitDirOverrideUnrendered();
      // ADAPTATION: upstream's ``_resolve_init_dir_override_unrendered``
      // preflights the policy itself; run it here so the bundler keeps the
      // contract whether or not the shared resolver does.
      if (override !== null) preflightProjectPolicy(override);
    } catch (exc) {
      if (!(exc instanceof ProjectResolutionError)) throw exc;
      const cause = (exc as Error & { cause?: unknown }).cause;
      if (cause instanceof ProjectPolicyError) throw new BundlerError(exc.message, { cause });
      errConsole.print(`[red]Error:[/red] ${exc.message}`);
      throw new CliExit(1);
    }
    // An explicit override is strict: do not return null here, because bundle
    // install treats null as "init the current directory".
    if (override !== null && override !== undefined) return String(override);
  }

  let current = resolvePath(start || process.cwd());
  for (;;) {
    const marker = path.join(current, '.specify');
    let present = true;
    try {
      lstatSync(marker);
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === 'ENOENT') {
        present = false;
      } else {
        const error = new ProjectPolicyError(`Cannot inspect project marker ${marker}: ${(exc as Error).message}`);
        throw new BundlerError(error.message, { cause: error });
      }
    }
    if (present) {
      preflightPolicy(current);
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Return the Spec Kit project root or throw an actionable error. */
export function requireProjectRoot(start: string | null = null): string {
  const root = findProjectRoot(start);
  if (root === null) {
    throw new BundlerError(
      'Not a Spec Kit project (no .specify/ directory). ' +
        "Run 'specify bundle init' or 'specify init' first.",
    );
  }
  return root;
}

/**
 * Return the project's active integration id, if recorded in
 * ``.specify/integration.json``. Returns null when it cannot be determined.
 *
 * Resolves the way the canonical reader does: ``default_integration`` is
 * authoritative; ``integration`` (the legacy alias), then ``id``/``active``,
 * are fallbacks, and each candidate is cleaned before selecting it (a
 * whitespace-only default does not shadow a valid legacy key). Installed-only
 * state promotes ``installed_integrations[0]`` like
 * ``normalize_integration_state``.
 */
export function activeIntegration(projectRoot: string): string | null {
  let marker = path.join(projectRoot, '.specify', 'integration.json');
  try {
    marker = ensureWithin(projectRoot, marker);
  } catch (exc) {
    if (exc instanceof BundlerError) return null;
    throw exc;
  }
  if (!existsSync(marker)) return null;
  let data: unknown;
  try {
    data = loadJson(marker);
  } catch (exc) {
    if (exc instanceof BundlerError) return null;
    throw exc;
  }
  if (isMapping(data)) {
    for (const field of ['default_integration', 'integration', 'id', 'active']) {
      const cleaned = cleanIntegrationKey(data[field]);
      if (cleaned) return cleaned;
    }
    const installed = data.installed_integrations;
    if (Array.isArray(installed)) {
      const installedKeys = dedupeIntegrationKeys(installed);
      if (installedKeys.length) return installedKeys[0];
    }
  }
  return null;
}
