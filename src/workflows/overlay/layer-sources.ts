/**
 * @oakoliver/specify-cli - Workflow Overlay Layer Sources
 *
 * Collects overlay layers from project-local storage and the base workflow
 * (port of ``workflows/overlay/layer_sources.py``).
 *
 * @module workflows/overlay/layer-sources
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { ValueError } from '../base.js';
import { parseYaml, yamlHasNode, YAMLError } from '../../yaml.js';
import {
  isDir,
  isFile,
  isMapping,
  isRelativeTo,
  isSymlink,
  osErrorMessage,
  pathExists,
  pyRepr,
  resolvePath,
} from './py-compat.js';
import { Overlay, RESERVED_WORKFLOW_IDS, SAFE_ID_PATTERN, validateOverlayYaml } from './schema.js';

// ============================================================================
// Types
// ============================================================================

/** A single layer in the workflow overlay stack. */
export interface Layer {
  content: Overlay;
  source: string;
  tier: string;
  priority: number;
  path: string | null;
}

/** Raised when an overlay file cannot be loaded or validated (Python ``ValueError`` subclass). */
export class OverlayLoadError extends ValueError {
  readonly path: string;
  readonly errors: string[];

  constructor(path: string, errors: string[]) {
    super(`Invalid overlay ${path}:\n  - ` + errors.join('\n  - '));
    this.name = 'OverlayLoadError';
    this.path = path;
    this.errors = errors;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function validateWorkflowId(workflowId: unknown, contextPath: string): void {
  if (typeof workflowId !== 'string' || !SAFE_ID_PATTERN.test(workflowId) || RESERVED_WORKFLOW_IDS.has(workflowId)) {
    throw new OverlayLoadError(contextPath, [`Invalid workflow ID: ${pyRepr(workflowId)}`]);
  }
}

function ensureContainedDir(path: string, root: string): void {
  if (isSymlink(path)) {
    throw new OverlayLoadError(path, ['Symlinked overlay directories are not allowed']);
  }
  if (pathExists(path) && !isDir(path)) {
    throw new OverlayLoadError(path, ['Overlay directory path is not a directory']);
  }
  if (!isRelativeTo(resolvePath(path), resolvePath(root))) {
    throw new OverlayLoadError(path, ['Path traversal detected: directory escapes allowed root']);
  }
}

/** Return the workflow storage root after rejecting unsafe ancestors. */
export function resolveWorkflowsRoot(projectRoot: string): string {
  const projectRootResolved = resolvePath(projectRoot);
  const workflowsRoot = join(projectRoot, '.specify', 'workflows');

  let current = projectRoot;
  for (const part of ['.specify', 'workflows']) {
    current = join(current, part);
    if (isSymlink(current)) {
      throw new OverlayLoadError(current, [`Symlinked workflow directories are not allowed (${current})`]);
    }
    if (pathExists(current) && !isDir(current)) {
      throw new OverlayLoadError(current, [`Workflow directory path is not a directory (${current})`]);
    }
  }

  if (!isRelativeTo(resolvePath(workflowsRoot), projectRootResolved)) {
    throw new OverlayLoadError(workflowsRoot, ['Workflow directory escapes the project root']);
  }
  return workflowsRoot;
}

/** Return the unresolved overlay root after rejecting unsafe ancestors. */
export function resolveProjectOverlayRoot(projectRoot: string): string {
  const workflowsRoot = resolveWorkflowsRoot(projectRoot);
  const overlaysRoot = join(workflowsRoot, 'overlays');
  if (isSymlink(overlaysRoot)) {
    throw new OverlayLoadError(overlaysRoot, [`Symlinked overlay directories are not allowed (${overlaysRoot})`]);
  }
  if (pathExists(overlaysRoot) && !isDir(overlaysRoot)) {
    throw new OverlayLoadError(overlaysRoot, [`Overlay directory path is not a directory (${overlaysRoot})`]);
  }
  return overlaysRoot;
}

/** Sorted directory entries as full paths (``sorted(dir.iterdir())``). */
export function sortedEntries(dir: string): string[] {
  return readdirSync(dir)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => join(dir, name));
}

// ============================================================================
// Sources
// ============================================================================

/** Project-local overlays: ``.specify/workflows/overlays/<id>/*.yml``. */
export class ProjectOverlaySource {
  readonly tier = 'project-overlay';
  readonly projectRoot: string;
  overlaysDir: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.overlaysDir = join(projectRoot, '.specify', 'workflows', 'overlays');
  }

  /** Collect project-local overlays for the given workflow id. */
  collect(workflowId: string, opts: { includeDisabled?: boolean } = {}): Layer[] {
    const includeDisabled = opts.includeDisabled ?? false;
    this.overlaysDir = resolveProjectOverlayRoot(this.projectRoot);
    validateWorkflowId(workflowId, this.overlaysDir);
    const workflowOverlayDir = join(this.overlaysDir, workflowId);
    ensureContainedDir(workflowOverlayDir, this.overlaysDir);
    if (!isDir(workflowOverlayDir)) return [];

    const layers: Layer[] = [];
    const overlayPathsById = new Map<string, string>();
    let entries: string[];
    try {
      entries = sortedEntries(workflowOverlayDir);
    } catch (exc) {
      throw new OverlayLoadError(workflowOverlayDir, [`Cannot enumerate overlays: ${osErrorMessage(exc)}`]);
    }
    for (const path of entries) {
      const suffix = extname(path);
      if (!isFile(path) || (suffix !== '.yml' && suffix !== '.yaml')) continue;
      if (isSymlink(path)) {
        throw new OverlayLoadError(path, ['Symlinked overlay files are not allowed']);
      }
      let data: unknown;
      let isEmptyDocument: boolean;
      try {
        const text = readFileSync(path, 'utf-8');
        isEmptyDocument = !yamlHasNode(text);
        data = parseYaml(text);
      } catch (exc) {
        if (exc instanceof YAMLError) {
          throw new OverlayLoadError(path, [`Invalid YAML: ${exc.message}`]);
        }
        throw new OverlayLoadError(path, [`Cannot load overlay: ${osErrorMessage(exc)}`]);
      }
      // Only a genuinely EMPTY document becomes an empty mapping; every
      // other non-mapping shape reaches the validator unchanged.
      if (isEmptyDocument) data = {};
      if (!includeDisabled && isMapping(data) && data.enabled === false) continue;

      const [overlay, errors] = validateOverlayYaml(data);
      if (overlay === null || errors.length > 0) {
        throw new OverlayLoadError(path, errors);
      }
      if (overlay.extends !== workflowId) {
        throw new OverlayLoadError(path, [
          `Overlay extends ${pyRepr(overlay.extends)}, but is stored under ` + `workflow ${pyRepr(workflowId)}.`,
        ]);
      }
      const firstPath = overlayPathsById.get(overlay.id);
      if (firstPath !== undefined) {
        throw new OverlayLoadError(path, [
          `Duplicate overlay id ${pyRepr(overlay.id)}; also declared in ` + `${firstPath}.`,
        ]);
      }
      overlayPathsById.set(overlay.id, path);
      layers.push({
        content: overlay,
        source: `project:${overlay.id}`,
        tier: this.tier,
        priority: overlay.priority,
        path,
      });
    }
    return layers;
  }
}

/** Base workflow layer: ``.specify/workflows/<id>/workflow.yml``. */
export class BaseWorkflowSource {
  readonly tier = 'base';
  readonly projectRoot: string;
  workflowsDir: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.workflowsDir = join(projectRoot, '.specify', 'workflows');
  }

  /** Return the base workflow as a single layer if it exists. */
  collect(workflowId: string, _opts: { includeDisabled?: boolean } = {}): Layer[] {
    this.workflowsDir = resolveWorkflowsRoot(this.projectRoot);
    validateWorkflowId(workflowId, this.workflowsDir);
    const workflowDir = join(this.workflowsDir, workflowId);
    ensureContainedDir(workflowDir, this.workflowsDir);
    const path = join(workflowDir, 'workflow.yml');
    if (isSymlink(path)) {
      throw new OverlayLoadError(path, ['Symlinked workflow files are not allowed']);
    }
    if (!isFile(path)) return [];
    const overlay = new Overlay({ id: workflowId, extends: workflowId, priority: 0, edits: [] });
    return [{ content: overlay, source: 'base', tier: this.tier, priority: 0, path }];
  }
}
