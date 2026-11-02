/**
 * @oakoliver/specify-cli - Shared, read-only `workflow.list` operation
 *
 * Port of spec-kit v1.2.5 `workflows/_operation_list.py` and `_storage.py`
 * (#5115): lists the installed-workflow registry without importing custom
 * steps or repairing its contents; used by `specify workflow list` and the
 * `specify_workflow_list` MCP tool.
 *
 * @module workflows/operation-list
 */

import { lstatSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { ProjectPolicyError, projectFiles } from '../file-policy.js';
import { isOsError } from '../file-helper.js';
import { WorkflowRegistry } from './catalog/domain.js';

export const WORKFLOW_LIST_MAX_LIMIT = 1000;

export const WORKFLOW_LIST_OPERATION = Object.freeze({
  operationId: 'workflow.list' as const,
  contractVersion: '1' as const,
  capabilities: new Set(['local-read'] as const),
  networkAccess: 'none' as const,
});

export interface WorkflowListRequest {
  projectDirectory: string;
  /** CLI retains its complete listing; MCP supplies an explicit bounded limit. */
  limit?: number | null;
}

export interface WorkflowListEntry {
  kind: 'workflow';
  id: string;
  name: string;
  version: string;
  description: string | null;
  enabled: boolean;
}

export interface WorkflowListWarning {
  kind: 'warning';
  code: 'invalid_registry_entry';
  workflow_id: string;
  message: string;
}

export interface WorkflowListResult {
  /** Warnings stay in registry order, including an all-invalid registry. */
  items: Array<WorkflowListEntry | WorkflowListWarning>;
  truncated: boolean;
}

/** Expected operation failure; adapters own presentation and sanitization. */
export class WorkflowListError extends Error {
  readonly code: string;
  readonly details: Record<string, string> = {};
  readonly retryable = false;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkflowListError';
    this.code = code;
  }
}

/** A workflow storage directory is symlinked or has the wrong type. */
export class WorkflowStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowStorageError';
  }
}

/** Check storage without creating directories or following child symlinks. */
export function validateWorkflowStorage(projectRoot: string): void {
  for (const suffix of ['.specify', '.specify/workflows', '.specify/workflows/runs', '.specify/workflows/overlays']) {
    const p = join(projectRoot, suffix);
    let isLink = false;
    try {
      isLink = lstatSync(p).isSymbolicLink();
    } catch {
      isLink = false;
    }
    if (isLink) throw new WorkflowStorageError(`Refusing to use symlinked ${suffix} path`);
    let exists = false;
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
      exists = true;
    } catch {
      exists = false;
    }
    if (exists && !isDir) throw new WorkflowStorageError(`${suffix} path exists but is not a directory`);
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const pyStr = (v: unknown): string => (typeof v === 'string' ? v : v === null ? 'None' : v === true ? 'True' : v === false ? 'False' : String(v));

function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/** Read the registry without importing custom steps or repairing its contents. */
export function listWorkflows(request: WorkflowListRequest): WorkflowListResult {
  const root = request.projectDirectory;
  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new WorkflowListError('invalid_project_directory', 'project_directory must be an absolute path');
  }
  const limit = request.limit ?? null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > WORKFLOW_LIST_MAX_LIMIT)) {
    throw new WorkflowListError('invalid_limit', `limit must be between 1 and ${WORKFLOW_LIST_MAX_LIMIT}`);
  }
  let files;
  try {
    let rootIsDirectory = false;
    try {
      rootIsDirectory = statSync(root).isDirectory();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    }
    if (!rootIsDirectory) {
      throw new WorkflowListError('not_a_spec_kit_project', 'Not a Spec Kit project (no .specify/ directory)');
    }
    files = projectFiles(root);
    if (!isDirectory(join(root, '.specify'))) {
      throw new WorkflowListError('not_a_spec_kit_project', 'Not a Spec Kit project (no .specify/ directory)');
    }
    validateWorkflowStorage(root);
  } catch (e) {
    if (e instanceof WorkflowListError) throw e;
    if (e instanceof ProjectPolicyError || e instanceof WorkflowStorageError || isOsError(e)) {
      throw new WorkflowListError('unsafe_workflow_storage', (e as Error).message);
    }
    throw e;
  }

  let installed: Record<string, unknown>;
  try {
    installed = new WorkflowRegistry(root, { readFiles: files }).list() as Record<string, unknown>;
  } catch (e) {
    if (e instanceof Error && 'code' in e) {
      throw new WorkflowListError('workflow_registry_read_failed', `Failed to read workflow registry: ${e.message}`);
    }
    throw e;
  }

  const entries = Object.entries(installed);
  const selected = limit === null ? entries : entries.slice(0, limit);
  const items: Array<WorkflowListEntry | WorkflowListWarning> = [];
  for (const [workflowId, metadata] of selected) {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      items.push({
        kind: 'warning',
        code: 'invalid_registry_entry',
        workflow_id: workflowId,
        message: `Skipping corrupted registry entry '${workflowId}'.`,
      });
      continue;
    }
    const m = metadata as Record<string, unknown>;
    const description = 'description' in m ? m.description : '';
    items.push({
      kind: 'workflow',
      id: workflowId,
      name: pyStr('name' in m ? m.name : workflowId),
      version: pyStr('version' in m ? m.version : '?'),
      description: pyTruthy(description) ? pyStr(description) : null,
      enabled: pyTruthy('enabled' in m ? m.enabled : true),
    });
  }
  return { items, truncated: limit !== null && entries.length > limit };
}
