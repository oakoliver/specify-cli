/**
 * @oakoliver/specify-cli - Workflow run installed-ownership resolution
 *
 * Port of ``specify_cli/workflows/_command_run_ownership.py``: maps a direct
 * ``workflow.yml`` path back to the installed workflow (registry root, id) it
 * belongs to, so ``workflow run <path>`` cannot bypass the disabled check.
 *
 * @module workflows/command-run-ownership
 */

import { lstatSync, readlinkSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, parse, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import { CliExit, escapeMarkup, type Console } from '../console.js';
import {
  RESERVED_WORKFLOW_IDS,
  WORKFLOW_ID_PATTERN,
  openWorkflowRegistry,
  rejectUnsafeDir,
} from './commands.js';

/** A path split into (anchor, parts) like ``PurePath.parts``. */
function splitParts(p: string): { anchor: string; parts: string[] } {
  const { root } = parse(p);
  const rest = p.slice(root.length).split(/[\\/]+/).filter(Boolean);
  return { anchor: root, parts: root ? [root, ...rest] : rest };
}

/** ``Path(*parts[:k])``. */
function joinParts(parts: string[], k: number): string {
  const slice = parts.slice(0, k);
  if (!slice.length) return '.';
  return join(...slice);
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** ``os.path.samefile`` (raises when either path is missing). */
function samefile(a: string, b: string): boolean {
  const sa = statSync(a);
  const sb = statSync(b);
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

/** Return whether two existing paths identify the same filesystem entry. */
export function sameExistingPath(left: string, right: string): boolean {
  try {
    return samefile(left, right);
  } catch {
    return normalize(left) === normalize(right);
  }
}

/**
 * Find the *nearest* (innermost) ``.specify/workflows/<id>`` owner in
 * *parts*, scanning from the end of the path. Returns the index of the owning
 * ``.specify`` segment, or ``null``.
 */
export function scanForWorkflowOwner(parts: string[]): number | null {
  for (let i = parts.length - 3; i >= 0; i--) {
    if ((parts[i] as string).toLowerCase() === '.specify' && (parts[i + 1] as string).toLowerCase() === 'workflows') {
      return i;
    }
  }
  return null;
}

/** Expand one symlink component while preserving the remaining path. */
function expandFirstSymlinkTarget(path: string): string | null {
  const { anchor, parts } = splitParts(path);
  const abs = isAbsolute(path);
  let current = abs ? anchor : '';
  const start = abs ? 1 : 0;
  for (let index = start; index < parts.length; index++) {
    current = current ? join(current, parts[index] as string) : (parts[index] as string);
    if (!isSymlink(current)) continue;
    let target: string;
    try {
      target = readlinkSync(current);
    } catch {
      return null;
    }
    if (!isAbsolute(target)) target = join(dirname(current), target);
    const expanded = join(target, ...parts.slice(index + 1));
    return normalize(resolve(expanded));
  }
  return null;
}

/**
 * Map a direct ``workflow.yml`` *sourcePath* back to the installed workflow
 * (``registryRoot``, ``registeredId``) it belongs to, if any. Returns
 * ``[null, null]`` for a genuinely standalone external workflow file.
 */
export function resolveInstalledWorkflowOwnership(
  sourcePath: string,
  err: Console,
): [string | null, string | null] {
  const ownershipFor = (candidate: string): [string, string] | null => {
    const { anchor, parts } = splitParts(candidate);
    const i = scanForWorkflowOwner(parts);
    if (i === null) return null;
    const registryRoot = i ? joinParts(parts, i) : anchor || '.';
    const candidateSpecify = joinParts(parts, i + 1);
    const candidateWorkflows = joinParts(parts, i + 2);
    const candidateIdDir = joinParts(parts, i + 3);
    const canonicalSpecify = join(registryRoot, '.specify');
    const canonicalWorkflows = join(canonicalSpecify, 'workflows');
    rejectUnsafeDir(canonicalSpecify, '.specify');
    rejectUnsafeDir(canonicalWorkflows, '.specify/workflows');
    rejectUnsafeDir(candidateSpecify, '.specify');
    rejectUnsafeDir(candidateWorkflows, '.specify/workflows');
    try {
      if (!samefile(candidateSpecify, canonicalSpecify)) return null;
      if (!samefile(candidateWorkflows, canonicalWorkflows)) return null;
    } catch {
      return null;
    }
    const registry = openWorkflowRegistry(registryRoot, err);
    let registeredId: string | null = null;
    for (const workflowId of Object.keys(registry.list())) {
      if (typeof workflowId !== 'string' || RESERVED_WORKFLOW_IDS.has(workflowId) || !WORKFLOW_ID_PATTERN.test(workflowId)) {
        continue;
      }
      try {
        if (samefile(candidateIdDir, join(canonicalWorkflows, workflowId))) {
          registeredId = workflowId;
          break;
        }
      } catch {
        continue;
      }
    }
    if (registeredId === null) return null;
    for (let k = i + 2; k <= parts.length; k++) {
      if (isSymlink(joinParts(parts, k))) {
        err.print(
          '[red]Error:[/red] Refusing to run: ' +
            `.specify/workflows/${escapeMarkup(registeredId)} ` +
            'contains a symlinked path component',
        );
        throw new CliExit(1);
      }
    }
    return [registryRoot, registeredId];
  };

  const lexical = normalize(resolve(sourcePath));
  let ownership = ownershipFor(lexical);
  if (ownership !== null) return ownership;

  let candidate = lexical;
  const seen = new Set([candidate]);
  for (let n = 0; n < 40; n++) {
    const expanded = expandFirstSymlinkTarget(candidate);
    if (expanded === null || seen.has(expanded)) break;
    ownership = ownershipFor(expanded);
    if (ownership !== null) return ownership;
    seen.add(expanded);
    candidate = expanded;
  }

  let resolved: string;
  try {
    resolved = realpathLoose(sourcePath);
  } catch {
    return [null, null];
  }
  if (resolved === lexical) return [null, null];
  ownership = ownershipFor(resolved);
  return ownership !== null ? ownership : [null, null];
}

/** ``Path.resolve(strict=False)``: resolve symlinks for the existing prefix. */
function realpathLoose(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let head = abs;
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs;
      tail.push(basename(head));
      head = parent;
    }
  }
}
