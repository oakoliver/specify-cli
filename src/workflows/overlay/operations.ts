/**
 * @oakoliver/specify-cli - Workflow Overlay Operations
 *
 * Domain operations used by the workflow overlay and resolve commands
 * (port of ``workflows/overlay/operations.py``).
 *
 * @module workflows/overlay/operations
 */

import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

import { CliExit, console, errConsole, escapeMarkup } from '../../console.js';
import { normalizePriority } from '../../extensions/index.js';
import { dumpYaml, parseYaml, YAMLError } from '../../yaml.js';
import {
  commitWorkflowFile,
  discardCommittedBackupFile,
  rejectUnsafeDir,
  rejectUnsafeWorkflowStorage,
  safeDiscardStagedWorkflowFile,
  stageWorkflowFile,
} from '../commands.js';
import { sortedEntries } from './layer-sources.js';
import {
  isDir,
  isFile,
  isMapping,
  isRelativeTo,
  isSymlink,
  osErrorMessage,
  pathExists,
  pathLexists,
  pyRepr,
  resolvePath,
} from './py-compat.js';
import { FileNotFoundError } from '../base.js';
import { WorkflowResolver } from './resolver.js';
import { RESERVED_WORKFLOW_IDS, SAFE_ID_PATTERN, validateOverlayYaml } from './schema.js';

// ============================================================================
// Helpers
// ============================================================================

/** True for a Node filesystem error (Python ``OSError``). */
export function isOsError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string' &&
    /^E[A-Z0-9]+$/.test((err as NodeJS.ErrnoException).code ?? '')
  );
}

/** Validate a single-segment overlay/workflow id from CLI arguments. */
export function validateOverlayIdOrExit(idValue: unknown, label: string): void {
  if (typeof idValue !== 'string' || !idValue) {
    errConsole.print(`[red]Error:[/red] ${label} is required and must be a non-empty string.`);
    throw new CliExit(1);
  }
  if (!SAFE_ID_PATTERN.test(idValue)) {
    errConsole.print(
      `[red]Error:[/red] Invalid ${label} ${pyRepr(idValue)}: ` + 'only lowercase letters, digits, and hyphens are allowed.',
    );
    throw new CliExit(1);
  }
}

/** Validate a workflow id, treating the overlay root as reserved. */
export function validateWorkflowIdOrExit(workflowId: unknown): void {
  validateOverlayIdOrExit(workflowId, 'workflow ID');
  if (RESERVED_WORKFLOW_IDS.has(workflowId as string)) {
    errConsole.print(`[red]Error:[/red] Invalid workflow ID ${pyRepr(workflowId)}: ` + 'reserved name.');
    throw new CliExit(1);
  }
}

/** Return the project-local overlay root after rejecting unsafe ancestors. */
function overlayRoot(projectRoot: string): string {
  rejectUnsafeWorkflowStorage(projectRoot);
  const root = join(projectRoot, '.specify', 'workflows', 'overlays');
  rejectUnsafeDir(root, '.specify/workflows/overlays');
  return root;
}

/** Return the project-local overlay directory for a workflow id. */
export function projectOverlayDir(projectRoot: string, workflowId: string): string {
  validateWorkflowIdOrExit(workflowId);
  const root = overlayRoot(projectRoot);
  return ensureContainedDir(join(root, workflowId), root);
}

function ensureContainedDir(path: string, root: string): string {
  rejectUnsafeDir(root, '.specify/workflows/overlays');
  if (isSymlink(path)) {
    errConsole.print(`[red]Error:[/red] Refusing to use symlinked path ${path}.`);
    throw new CliExit(1);
  }
  if (pathExists(path) && !isDir(path)) {
    errConsole.print(`[red]Error:[/red] Overlay directory path is not a directory: ${path}.`);
    throw new CliExit(1);
  }
  if (!isRelativeTo(resolvePath(path), resolvePath(root))) {
    errConsole.print(`[red]Error:[/red] Path traversal detected: ${path} is outside the allowed directory.`);
    throw new CliExit(1);
  }
  return path;
}

/** Locate a project-local overlay file by its manifest ID, not filename. */
export function findOverlayFile(projectRoot: string, workflowId: string, overlayId: string): string | null {
  validateWorkflowIdOrExit(workflowId);
  validateOverlayIdOrExit(overlayId, 'overlay ID');
  const dir = projectOverlayDir(projectRoot, workflowId);
  if (!isDir(dir)) return null;
  let entries: string[];
  try {
    entries = sortedEntries(dir);
  } catch {
    return null;
  }
  const matches: string[] = [];
  for (const path of entries) {
    const suffix = extname(path);
    if (!isFile(path) || (suffix !== '.yml' && suffix !== '.yaml')) continue;
    if (isSymlink(path)) continue;
    const [data] = readOverlay(path);
    if (data === null) continue;
    if (data.id === overlayId) matches.push(path);
  }
  if (matches.length > 1) {
    errConsole.print(
      `[red]Error:[/red] Duplicate overlay ID '${overlayId}' in ${matches.join(', ')}. ` +
        'Resolve the duplicate manifest IDs before continuing.',
    );
    throw new CliExit(1);
  }
  return matches.length ? matches[0] : null;
}

function ensureContainedPath(path: string, root: string): string {
  rejectUnsafeDir(root, '.specify/workflows/overlays');
  if (isSymlink(path)) {
    errConsole.print(`[red]Error:[/red] Refusing to use symlinked path ${path}.`);
    throw new CliExit(1);
  }
  if (!isRelativeTo(resolvePath(path), resolvePath(root))) {
    errConsole.print(`[red]Error:[/red] Path traversal detected: ${path} is outside the allowed directory.`);
    throw new CliExit(1);
  }
  return path;
}

/** Read and parse an overlay YAML file, returning ``[data, errors]``. */
export function readOverlay(path: string): [Record<string, unknown> | null, string[]] {
  let content: string;
  try {
    const bytes = readFileSync(path);
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (exc) {
    return [null, [`Failed to read ${path}: ${osErrorMessage(exc)}`]];
  }
  let data: unknown;
  try {
    data = parseYaml(content);
  } catch (exc) {
    if (exc instanceof YAMLError) return [null, [`Invalid YAML in ${path}: ${exc.message}`]];
    return [null, [`Invalid YAML in ${path}: ${exc instanceof Error ? exc.message : String(exc)}`]];
  }
  if (!isMapping(data)) return [null, [`Overlay ${path} must be a YAML mapping.`]];
  return [data, []];
}

/** Serialize an overlay manifest like ``yaml.safe_dump(sort_keys=False, allow_unicode=True)``. */
function dumpOverlay(data: Record<string, unknown>): string {
  return dumpYaml(data, { sortKeys: false, allowUnicode: true });
}

/** Stage + atomically commit *text* onto *targetPath*. Throws on OS errors. */
function writeOverlayAtomically(targetPath: string, text: string): string | null {
  const existedBefore = pathExists(targetPath);
  const parent = dirname(targetPath);
  const staged = stageWorkflowFile(parent);
  try {
    staged.writeBytes(Buffer.from(text, 'utf-8'));
    return commitWorkflowFile(staged, targetPath, existedBefore);
  } catch (exc) {
    safeDiscardStagedWorkflowFile(staged, parent, existedBefore);
    throw exc;
  }
}

function isPositiveCliPriority(priority: unknown): priority is number {
  return typeof priority === 'number' && Number.isInteger(priority) && priority >= 1;
}

// ============================================================================
// Operations
// ============================================================================

/**
 * Add a project-local overlay from a YAML file.
 *
 * Returns the path of the installed overlay file, or null on failure.
 */
export function workflowOverlayAdd(projectRoot: string, source: string, priority: number | null = null): string | null {
  rejectUnsafeWorkflowStorage(projectRoot);
  const [data, errors] = readOverlay(source);
  if (data === null) {
    for (const err of errors) errConsole.print(`[red]Error:[/red] ${err}`);
    return null;
  }

  // Apply --priority override before validation so a valid CLI priority can
  // fix a missing or invalid priority in the file.
  if (priority !== null && priority !== undefined) {
    if (!isPositiveCliPriority(priority)) {
      errConsole.print('[red]Error:[/red] Priority must be >= 1.');
      return null;
    }
    data.priority = normalizePriority(priority);
  }

  const [overlay, validationErrors] = validateOverlayYaml(data);
  if (overlay === null) {
    errConsole.print('[red]Error:[/red] Overlay validation failed:');
    for (const err of validationErrors) errConsole.print(`  • ${err}`);
    return null;
  }
  data.priority = overlay.priority;

  const targetDir = projectOverlayDir(projectRoot, overlay.extends);
  // Reuse an existing .yaml file so we don't create a duplicate .yml layer.
  const existing = findOverlayFile(projectRoot, overlay.extends, overlay.id);
  let targetPath: string;
  if (existing !== null) {
    targetPath = existing;
  } else {
    targetPath = ensureContainedPath(join(targetDir, `${overlay.id}.yml`), overlayRoot(projectRoot));
    // Overlay identity is the manifest ``id``, not the filename, so
    // ``<id>.yml`` can legitimately already hold a DIFFERENT overlay (or a
    // directory/FIFO/socket). Fail closed rather than destroying it.
    if (pathLexists(targetPath)) {
      if (isSymlink(targetPath) || !isFile(targetPath)) {
        errConsole.print(
          `[red]Error:[/red] ${escapeMarkup(targetPath)} exists ` +
            'and is not a regular file. Rename or remove it before ' +
            `adding overlay ${escapeMarkup(pyRepr(overlay.id))}.`,
        );
        return null;
      }
      const [occupant, readErrors] = readOverlay(targetPath);
      const occupantId = isMapping(occupant) ? occupant.id : null;
      if (!(typeof occupantId === 'string' && occupantId === overlay.id)) {
        let detail: string;
        if (typeof occupantId === 'string' && occupantId) {
          detail = `already holds overlay ${escapeMarkup(pyRepr(occupantId))}`;
        } else if (readErrors.length > 0) {
          detail = 'could not be parsed as an overlay ' + `(${escapeMarkup(readErrors.join('; '))})`;
        } else {
          detail = "is not a readable overlay manifest (no usable 'id')";
        }
        errConsole.print(
          `[red]Error:[/red] ${escapeMarkup(targetPath)} ${detail}. ` +
            'Rename or remove it before adding overlay ' +
            `${escapeMarkup(pyRepr(overlay.id))}.`,
        );
        return null;
      }
    }
  }

  let backup: string | null = null;
  try {
    mkdirSync(targetDir, { recursive: true });
    backup = writeOverlayAtomically(targetPath, dumpOverlay(data));
  } catch (exc) {
    if (!isOsError(exc)) throw exc;
    errConsole.print(`[red]Error:[/red] Failed to write overlay: ${osErrorMessage(exc)}`);
    return null;
  }
  discardCommittedBackupFile(backup);

  console.print(`[green]✓[/green] Overlay '${overlay.id}' added for workflow '${overlay.extends}'`);
  return targetPath;
}

/** Update a single field in a project-local overlay file. */
function updateOverlayField(
  projectRoot: string,
  workflowId: string,
  overlayId: string,
  field: string,
  value: unknown,
): boolean {
  rejectUnsafeWorkflowStorage(projectRoot);
  const path = findOverlayFile(projectRoot, workflowId, overlayId);
  if (path === null) {
    errConsole.print(`[red]Error:[/red] Overlay '${overlayId}' not found for workflow '${workflowId}'`);
    return false;
  }

  const [data, errors] = readOverlay(path);
  if (data === null) {
    for (const err of errors) errConsole.print(`[red]Error:[/red] ${err}`);
    return false;
  }

  data[field] = value;
  const [overlay, validationErrors] = validateOverlayYaml(data);
  if (overlay === null) {
    errConsole.print('[red]Error:[/red] Overlay validation failed:');
    for (const err of validationErrors) errConsole.print(`  • ${err}`);
    return false;
  }

  let backup: string | null = null;
  try {
    backup = writeOverlayAtomically(path, dumpOverlay(data));
  } catch (exc) {
    if (!isOsError(exc)) throw exc;
    errConsole.print(`[red]Error:[/red] Failed to write overlay: ${osErrorMessage(exc)}`);
    return false;
  }
  discardCommittedBackupFile(backup);
  return true;
}

/** Set the priority of a project-local overlay. */
export function workflowOverlaySetPriority(
  projectRoot: string,
  workflowId: string,
  overlayId: string,
  priority: number,
): boolean {
  if (!isPositiveCliPriority(priority)) {
    errConsole.print('[red]Error:[/red] Priority must be >= 1.');
    throw new CliExit(1);
  }
  const normalizedPriority = normalizePriority(priority);
  if (updateOverlayField(projectRoot, workflowId, overlayId, 'priority', normalizedPriority)) {
    console.print(`[green]✓[/green] Priority of overlay '${overlayId}' set to ${normalizedPriority}`);
    return true;
  }
  return false;
}

/** Enable a project-local overlay. */
export function workflowOverlayEnable(projectRoot: string, workflowId: string, overlayId: string): boolean {
  if (updateOverlayField(projectRoot, workflowId, overlayId, 'enabled', true)) {
    console.print(`[green]✓[/green] Overlay '${overlayId}' enabled`);
    return true;
  }
  return false;
}

/** Disable a project-local overlay. */
export function workflowOverlayDisable(projectRoot: string, workflowId: string, overlayId: string): boolean {
  if (updateOverlayField(projectRoot, workflowId, overlayId, 'enabled', false)) {
    console.print(`[green]✓[/green] Overlay '${overlayId}' disabled`);
    return true;
  }
  return false;
}

/** Remove a project-local overlay file. */
export function workflowOverlayRemove(projectRoot: string, workflowId: string, overlayId: string): boolean {
  rejectUnsafeWorkflowStorage(projectRoot);
  const path = findOverlayFile(projectRoot, workflowId, overlayId);
  if (path === null) {
    errConsole.print(`[red]Error:[/red] Overlay '${overlayId}' not found for workflow '${workflowId}'`);
    return false;
  }
  try {
    unlinkSync(path);
  } catch (exc) {
    if (!isOsError(exc)) throw exc;
    errConsole.print(`[red]Error:[/red] Failed to remove overlay: ${osErrorMessage(exc)}`);
    return false;
  }
  console.print(`[green]✓[/green] Overlay '${overlayId}' removed`);
  return true;
}

/** Row returned by ``workflowOverlayList``. */
export interface OverlayListRow {
  id: string;
  source: string;
  tier: string;
  priority: number;
  enabled: boolean;
  path: string | null;
}

/**
 * List all overlays for a workflow and print a summary.
 *
 * Returns the raw list data for machine-readable callers, or null on error.
 */
export function workflowOverlayList(projectRoot: string, workflowId: string): OverlayListRow[] | null {
  rejectUnsafeWorkflowStorage(projectRoot);
  validateWorkflowIdOrExit(workflowId);
  const resolver = new WorkflowResolver(projectRoot);
  let layers;
  try {
    layers = resolver.collectAllLayers(workflowId, { includeDisabled: true });
  } catch (exc) {
    if (isOsError(exc) || !(exc instanceof Error)) throw exc;
    errConsole.print(`[red]Error:[/red] ${exc.message}`);
    return null;
  }
  const overlays = layers.filter((layer) => layer.tier !== 'base');

  if (overlays.length === 0) {
    console.print(`[yellow]No overlays found for workflow '${workflowId}'.[/yellow]`);
    return [];
  }

  console.print(`Overlays for workflow '${workflowId}':`);
  const rows: OverlayListRow[] = [];
  for (const layer of overlays) {
    const overlay = layer.content;
    rows.push({
      id: overlay.id,
      source: layer.source,
      tier: layer.tier,
      priority: normalizePriority(overlay.priority),
      enabled: overlay.enabled,
      path: layer.path ? layer.path : null,
    });
    const enabledMarker = overlay.enabled ? 'enabled' : 'disabled';
    console.print(
      `  • ${overlay.id} (priority=${normalizePriority(overlay.priority)}, ` +
        `source=${layer.source}, ${enabledMarker})`,
    );
  }
  return rows;
}

/** Serializable attribution payload returned by ``workflowResolve``. */
export interface WorkflowResolvePayload {
  workflow_id: string;
  layers: Array<{ source: string; tier: string; priority: number | null }>;
  attribution: Array<{ step_id: string; source: string }>;
}

/** Print layer attribution for a resolved workflow. */
export function workflowResolve(projectRoot: string, workflowId: string): WorkflowResolvePayload | null {
  rejectUnsafeWorkflowStorage(projectRoot);
  validateWorkflowIdOrExit(workflowId);
  const resolver = new WorkflowResolver(projectRoot);
  let resolved;
  try {
    resolved = resolver.resolveWithLayers(workflowId);
  } catch (exc) {
    if (exc instanceof FileNotFoundError || (isOsError(exc) && exc.code === 'ENOENT')) {
      errConsole.print(`[red]Error:[/red] Workflow '${workflowId}' not found`);
      return null;
    }
    if (isOsError(exc) || !(exc instanceof Error)) throw exc;
    errConsole.print(`[red]Error:[/red] ${exc.message}`);
    return null;
  }
  const [, layers, attribution] = resolved;

  console.print(`Resolved workflow '${workflowId}':`);
  console.print('Layers (highest precedence first):');
  for (const layer of layers) {
    const priority = layer.tier === 'base' ? 'n/a' : String(normalizePriority(layer.priority));
    // ``\[`` keeps the literal bracket so the tier label is not parsed as markup.
    console.print(`  • \\[${escapeMarkup(layer.tier)}] ` + `${escapeMarkup(layer.source)} ` + `(priority=${priority})`);
  }

  console.print('Step attribution:');
  for (const composed of attribution) {
    console.print(`  • ${escapeMarkup(composed.step_id)}: ` + `${escapeMarkup(composed.source)}`);
  }

  return {
    workflow_id: workflowId,
    layers: layers.map((layer) => ({
      source: layer.source,
      tier: layer.tier,
      priority: layer.tier === 'base' ? null : normalizePriority(layer.priority),
    })),
    attribution: attribution.map((composed) => ({ step_id: composed.step_id, source: composed.source })),
  };
}
