/**
 * @oakoliver/specify-cli - Bundle project detection
 *
 * Spec Kit project detection and active-integration resolution.
 *
 * Port of ``specify_cli/bundles/project.py``.
 *
 * @module bundles/project
 */

import { existsSync, lstatSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { resolveInitDirOverride } from '../project.js';
import { BundlerError } from './index.js';
import { ensureWithin, loadJson } from './yamlio.js';
import { dget, isMapping, pyTruthy, resolvePath } from './pycompat.js';

export const DEFAULT_INTEGRATION = 'copilot';

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Return the nearest ancestor (incl. *start*) containing a ``.specify/`` dir,
 * or null. A symlinked ``.specify`` is not accepted as a project root.
 *
 * When *start* is omitted the ``SPECIFY_INIT_DIR`` override is honored first;
 * with an explicit override this may **throw** rather than return (a
 * set-but-invalid value throws ``CliExit`` and a symlinked ``.specify`` throws
 * {@link BundlerError}).
 */
export function findProjectRoot(start: string | null = null): string | null {
  if (start === null) {
    const override = resolveInitDirOverride();
    if (override !== null && override !== undefined) {
      const overridePath = String(override);
      if (isSymlink(path.join(overridePath, '.specify'))) {
        throw new BundlerError(
          'SPECIFY_INIT_DIR is not a safe Spec Kit project ' +
            `(symlinked .specify/ directory is not allowed): ${overridePath}`,
        );
      }
      return overridePath;
    }
  }

  let current = resolvePath(start || process.cwd());
  for (;;) {
    const marker = path.join(current, '.specify');
    if (isDir(marker) && !isSymlink(marker)) return current;
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
 * ``default_integration`` is authoritative (matching the canonical reader in
 * ``integration_state``); ``integration``/``id``/``active`` are fallbacks.
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
    let value: unknown = null;
    for (const key of ['default_integration', 'integration', 'id', 'active']) {
      const candidate = dget(data, key);
      if (pyTruthy(candidate)) {
        value = candidate;
        break;
      }
    }
    if (typeof value === 'string' && value) return value;
  }
  return null;
}
