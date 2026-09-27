/**
 * @oakoliver/specify-cli - Workflow resume owner-state resolution
 *
 * Port of ``specify_cli/workflows/_command_resume_state.py``
 * (resume-private installed-workflow owner state resolution).
 *
 * @module workflows/command-resume-state
 */

import { lstatSync, statSync } from 'node:fs';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';

import { ValueError } from './base.js';

/** Return whether any component of an absolute path is a symlink. */
export function pathHasSymlinkComponent(path: string): boolean {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      // A missing component is not a symlink.
    }
  }
  return false;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Determine which project's registry gates resuming a run.
 *
 * ``installedRegistryRoot`` is only persisted when the run's installed
 * workflow belongs to a *different* project than the one whose ``runs/``
 * directory holds this run's state. The common case stores ``null`` and falls
 * back to the *current* ``projectRoot``. A persisted cross-project root that no
 * longer exists must fail closed.
 */
export function resolveRunOwnerRoot(installedRegistryRoot: string | null | undefined, projectRoot: string): string {
  if (installedRegistryRoot) {
    const candidate = installedRegistryRoot;
    if (isAbsolute(candidate) && !pathHasSymlinkComponent(candidate) && isDir(candidate)) {
      return candidate;
    }
    throw new ValueError('Installed workflow owner is unavailable; cannot safely resume');
  }
  return projectRoot;
}
