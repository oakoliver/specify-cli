/**
 * @oakoliver/specify-cli - Shared ``artifact.list`` / ``artifact.info`` operations
 *
 * Port of spec-kit v1.2.5 ``artifacts/_operation_list.py`` (#4866) and
 * ``artifacts/_operation_info.py`` (#4882): transport-neutral typed
 * operations shared by the CLI adapter (``specify artifact list|info``) and
 * the MCP tools (``specify_artifact_list`` / ``specify_artifact_info``).
 *
 * @module artifacts/operations
 */

import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { ProjectPolicyError, projectFiles } from '../file-policy.js';
import { PresetError } from '../presets/manifest.js';
import { pyRepr } from '../events/py-compat.js';
import { ArtifactCatalog } from './catalog.js';
import {
  IdentifierComponentError,
  deriveHookPublicId,
  derivePublicId,
  parseHookArtifactName,
  validateComponent,
} from './identifiers.js';
import {
  AmbiguousArtifactError,
  ArtifactError,
  ArtifactNotFoundError,
  ArtifactResolutionError,
  HookStackEntry,
  NotASpecKitProjectError,
  StackLayer,
  type ArtifactKind,
} from './models.js';
import { isOSError } from './resolution.js';

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Operation descriptor shared by delivery adapters. */
export interface OperationDescriptor {
  operationId: string;
  contractVersion: string;
  capabilities: ReadonlySet<'local-read'>;
  networkAccess: 'none';
}

/** Expected transport-neutral failure carrying a stable code and details. */
export class ArtifactOperationError extends ArtifactError {
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;
  constructor(opts: { code: string; message: string; details: Record<string, unknown>; retryable?: boolean }) {
    super(opts.message);
    this.code = opts.code;
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
  }
}

// ============================================================================
// artifact.list
// ============================================================================

export const ARTIFACT_LIST_MAX_LIMIT = 1000;
export const ARTIFACT_LIST_CURSOR_MAX_LENGTH = 20;

export const ARTIFACT_LIST_OPERATION: OperationDescriptor = Object.freeze({
  operationId: 'artifact.list',
  contractVersion: '2',
  capabilities: new Set(['local-read'] as const),
  networkAccess: 'none',
});

export interface ArtifactListRequest {
  projectDirectory: string;
  limit?: number | null;
  cursor?: string | null;
}

export interface ArtifactListResult {
  rows: Array<Record<string, unknown>>;
  nextCursor: string | null;
  truncated: boolean;
}

export class ArtifactListError extends ArtifactOperationError {}

export class ArtifactListProjectDirectoryError extends ArtifactListError {
  constructor(projectDirectory: string) {
    super({
      code: 'invalid_project_directory',
      message: 'project_directory must be an absolute path',
      details: { project_directory: projectDirectory },
    });
  }
}

export class ArtifactListProjectError extends ArtifactListError {
  constructor(projectDirectory: string) {
    super({
      code: 'not_a_spec_kit_project',
      message: 'not a Spec Kit project: no .specify/ directory found',
      details: { project_directory: projectDirectory },
    });
  }
}

export class ArtifactListResolutionError extends ArtifactListError {
  constructor(projectDirectory: string, message = 'artifact resolution failed') {
    super({ code: 'artifact_resolution_failed', message, details: { project_directory: projectDirectory } });
  }
}

export class ArtifactListPaginationError extends ArtifactListError {
  constructor(field: 'limit' | 'cursor', value: unknown) {
    super({
      code: 'invalid_pagination',
      message:
        field === 'limit'
          ? `artifact list limit must be between 1 and ${ARTIFACT_LIST_MAX_LIMIT}`
          : 'artifact list cursor must be a canonical decimal offset',
      details: { field, value, max_limit: ARTIFACT_LIST_MAX_LIMIT },
    });
  }
}

function paginationOffset(request: ArtifactListRequest): number {
  const limit = request.limit ?? null;
  if (limit !== null && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > ARTIFACT_LIST_MAX_LIMIT)) {
    throw new ArtifactListPaginationError('limit', limit);
  }
  const cursor = request.cursor ?? null;
  if (cursor === null) return 0;
  if (
    typeof cursor !== 'string' ||
    !cursor ||
    cursor.length > ARTIFACT_LIST_CURSOR_MAX_LENGTH ||
    !/^[0-9]+$/.test(cursor) ||
    (cursor.length > 1 && cursor.startsWith('0'))
  ) {
    throw new ArtifactListPaginationError('cursor', cursor);
  }
  return Number.parseInt(cursor, 10);
}

/** Return one typed artifact inventory page for an explicit project. */
export function listArtifacts(request: ArtifactListRequest): ArtifactListResult {
  const projectDirectory = request.projectDirectory;
  if (!isAbsolute(projectDirectory)) throw new ArtifactListProjectDirectoryError(projectDirectory);
  const offset = paginationOffset(request);

  let rows: Array<Record<string, unknown>>;
  try {
    if (isDir(projectDirectory)) projectFiles(projectDirectory);
    rows = new ArtifactCatalog(projectDirectory).listArtifactsWithStack();
  } catch (e) {
    if (e instanceof ProjectPolicyError) throw new ArtifactListResolutionError(projectDirectory, e.message);
    if (e instanceof NotASpecKitProjectError) throw new ArtifactListProjectError(projectDirectory);
    if (e instanceof ArtifactResolutionError || isOSError(e) || e instanceof PresetError) {
      throw new ArtifactListResolutionError(projectDirectory);
    }
    throw e;
  }
  const limit = request.limit ?? null;
  const pageRows = limit === null ? rows.slice(offset) : rows.slice(offset, offset + limit);
  const pageEnd = offset + pageRows.length;
  const truncated = pageEnd < rows.length;
  return { rows: pageRows, nextCursor: truncated ? String(pageEnd) : null, truncated };
}

// ============================================================================
// artifact.info
// ============================================================================

export const ARTIFACT_INFO_OPERATION: OperationDescriptor = Object.freeze({
  operationId: 'artifact.info',
  contractVersion: '1',
  capabilities: new Set(['local-read'] as const),
  networkAccess: 'none',
});

export interface ArtifactInfoRequest {
  projectDirectory: string;
  identifier: string;
  kind?: ArtifactKind | null;
}

export interface ArtifactInfoNamedArtifact {
  id: string;
  name: string;
  kind: 'command' | 'template' | 'script';
  description: string;
  stack: StackLayer[];
}

export interface ArtifactInfoHookArtifact {
  id: string;
  name: string;
  kind: 'hook';
  description: string;
  eventName: string;
  targetCommand: string;
  registered: boolean;
  stack: HookStackEntry[];
}

/** Transport-neutral typed artifact information. */
export class ArtifactInfoResult {
  constructor(readonly artifact: ArtifactInfoNamedArtifact | ArtifactInfoHookArtifact) {}

  toJsonDict(): Record<string, unknown> {
    const a = this.artifact;
    if (a.kind === 'hook') {
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        description: a.description,
        eventName: a.eventName,
        targetCommand: a.targetCommand,
        registered: a.registered,
        stack: a.stack.map((e) => e.toJsonDict()),
      };
    }
    return { id: a.id, name: a.name, kind: a.kind, description: a.description, stack: a.stack.map((e) => e.toJsonDict()) };
  }
}

export class ArtifactInfoError extends ArtifactOperationError {}

export class ArtifactInfoProjectDirectoryError extends ArtifactInfoError {
  constructor(projectDirectory: string) {
    super({
      code: 'invalid_project_directory',
      message: 'project_directory must be an absolute path',
      details: { project_directory: projectDirectory },
    });
  }
}

export class ArtifactInfoProjectError extends ArtifactInfoError {
  constructor(projectDirectory: string) {
    super({
      code: 'not_a_spec_kit_project',
      message: 'not a Spec Kit project: no .specify/ directory found',
      details: { project_directory: projectDirectory },
    });
  }
}

export class ArtifactInfoKindError extends ArtifactInfoError {
  constructor(kind: unknown) {
    super({
      code: 'invalid_artifact_kind',
      message: `invalid artifact kind ${pyRepr(kind)}: expected one of command, template, script, hook`,
      details: { kind },
    });
  }
}

export class ArtifactInfoIdentifierError extends ArtifactInfoError {
  constructor(identifier: unknown) {
    super({
      code: 'invalid_artifact_identifier',
      message: `unknown artifact ${String(identifier)}`,
      details: { identifier },
    });
  }
}

export class ArtifactInfoNotFoundError extends ArtifactInfoError {
  constructor(identifier: string) {
    super({ code: 'unknown_artifact', message: `unknown artifact ${identifier}`, details: { identifier } });
  }
}

export class ArtifactInfoHookNotFoundError extends ArtifactInfoError {
  constructor(identifier: string) {
    super({ code: 'unknown_hook', message: `unknown artifact ${identifier}`, details: { identifier } });
  }
}

export class ArtifactInfoAmbiguousError extends ArtifactInfoError {
  constructor(identifier: string, message: string) {
    super({ code: 'ambiguous_artifact', message, details: { identifier } });
  }
}

export class ArtifactInfoResolutionError extends ArtifactInfoError {
  constructor(projectDirectory: string, identifier: string, message = 'artifact resolution failed') {
    super({
      code: 'artifact_resolution_failed',
      message,
      details: { project_directory: projectDirectory, identifier },
    });
  }
}

export class ArtifactInfoInvalidResultError extends ArtifactInfoError {
  constructor(projectDirectory: string, identifier: string) {
    super({
      code: 'invalid_operation_result',
      message: 'artifact resolution failed',
      details: { project_directory: projectDirectory, identifier },
    });
  }
}

const NAMED_RESULT_KEYS = ['description', 'id', 'kind', 'name', 'stack'];
const HOOK_RESULT_KEYS = ['description', 'eventName', 'id', 'kind', 'name', 'registered', 'stack', 'targetCommand'];
const STACK_KEYS = [
  'active',
  'hidden',
  'id',
  'layer',
  'lookupId',
  'manifestPath',
  'presetId',
  'presetName',
  'sourceId',
  'sourcePath',
  'strategy',
];
const HOOK_STACK_KEYS = [...STACK_KEYS, 'optional', 'priority'].sort();

function keysEqual(o: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(o).sort();
  return keys.length === expected.length && keys.every((k, i) => k === expected[i]);
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const optStr = (v: unknown): boolean => v === null || typeof v === 'string';

function convertNamedStack(value: unknown, artifactId: string, invalid: () => Error): StackLayer[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid();
  return value.map((item) => {
    if (!isPlain(item) || !keysEqual(item, STACK_KEYS)) throw invalid();
    if (
      item.id !== artifactId ||
      ![null, 'project', 'preset', 'extension'].includes(item.layer as never) ||
      !optStr(item.sourceId) ||
      !optStr(item.presetId) ||
      !optStr(item.presetName) ||
      !['replace', 'wrap', 'prepend', 'append'].includes(item.strategy as never) ||
      typeof item.active !== 'boolean' ||
      typeof item.hidden !== 'boolean' ||
      !optStr(item.manifestPath) ||
      !optStr(item.lookupId) ||
      !optStr(item.sourcePath)
    ) {
      throw invalid();
    }
    return new StackLayer(item as never);
  });
}

function convertHookStack(value: unknown, artifactId: string, invalid: () => Error): HookStackEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid();
  return value.map((item) => {
    if (!isPlain(item) || !keysEqual(item, HOOK_STACK_KEYS)) throw invalid();
    if (
      item.id !== artifactId ||
      !['preset', 'extension'].includes(item.layer as never) ||
      typeof item.sourceId !== 'string' ||
      !optStr(item.presetId) ||
      !optStr(item.presetName) ||
      item.strategy !== 'additive' ||
      typeof item.active !== 'boolean' ||
      typeof item.hidden !== 'boolean' ||
      typeof item.manifestPath !== 'string' ||
      typeof item.lookupId !== 'string' ||
      item.sourcePath !== null ||
      typeof item.priority !== 'number' ||
      !Number.isInteger(item.priority) ||
      typeof item.optional !== 'boolean'
    ) {
      throw invalid();
    }
    return new HookStackEntry(item as never);
  });
}

function convertCatalogResult(payload: unknown, request: ArtifactInfoRequest): ArtifactInfoResult {
  const invalid = (): Error => new ArtifactInfoInvalidResultError(request.projectDirectory, request.identifier);
  if (!isPlain(payload)) throw invalid();
  const kind = payload.kind;
  if (kind === 'hook') {
    if (!keysEqual(payload, HOOK_RESULT_KEYS)) throw invalid();
    const { id, name, description, eventName, targetCommand, registered } = payload;
    if (
      typeof id !== 'string' ||
      typeof name !== 'string' ||
      typeof description !== 'string' ||
      typeof eventName !== 'string' ||
      typeof targetCommand !== 'string' ||
      typeof registered !== 'boolean'
    ) {
      throw invalid();
    }
    let expected: string;
    try {
      expected = deriveHookPublicId(eventName, targetCommand);
    } catch (e) {
      if (e instanceof IdentifierComponentError) throw invalid();
      throw e;
    }
    if (id !== expected || name !== (id.startsWith('hook:') ? id.slice(5) : id)) throw invalid();
    return new ArtifactInfoResult({
      id,
      name,
      kind: 'hook',
      description,
      eventName,
      targetCommand,
      registered,
      stack: convertHookStack(payload.stack, id, invalid),
    });
  }
  if (kind !== 'command' && kind !== 'template' && kind !== 'script') throw invalid();
  if (!keysEqual(payload, NAMED_RESULT_KEYS)) throw invalid();
  const { id, name, description } = payload;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof description !== 'string') throw invalid();
  let expected: string;
  try {
    expected = derivePublicId(kind, name);
  } catch (e) {
    if (e instanceof IdentifierComponentError) throw invalid();
    throw e;
  }
  if (id !== expected) throw invalid();
  return new ArtifactInfoResult({ id, name, kind, description, stack: convertNamedStack(payload.stack, id, invalid) });
}

function tryParseHook(name: string): boolean {
  try {
    parseHookArtifactName(name);
    return true;
  } catch (e) {
    if (e instanceof IdentifierComponentError) return false;
    throw e;
  }
}

function validateIdentifier(identifier: string, kind: ArtifactKind | null): void {
  if (kind === 'hook') {
    if (identifier.startsWith('hook:') && tryParseHook(identifier.slice(5))) return;
    if (!tryParseHook(identifier)) throw new ArtifactInfoIdentifierError(identifier);
    return;
  }
  const colon = identifier.indexOf(':');
  if (colon < 0) return;
  const prefix = identifier.slice(0, colon);
  const bare = identifier.slice(colon + 1);
  if (prefix === 'command' || prefix === 'template' || prefix === 'script') {
    try {
      validateComponent(bare, `${prefix} name`);
    } catch (e) {
      if (e instanceof IdentifierComponentError) throw new ArtifactInfoIdentifierError(identifier);
      throw e;
    }
    return;
  }
  if (prefix === 'hook') {
    if (!tryParseHook(bare)) throw new ArtifactInfoIdentifierError(identifier);
    return;
  }
  throw new ArtifactInfoIdentifierError(identifier);
}

function requestsHook(identifier: string, kind: ArtifactKind | null): boolean {
  return kind === 'hook' || (kind === null && identifier.startsWith('hook:'));
}

/** Return typed artifact information for an explicit Spec Kit project. */
export function getArtifactInfo(request: ArtifactInfoRequest): ArtifactInfoResult {
  const projectDirectory = request.projectDirectory;
  const kind = request.kind ?? null;
  if (!isAbsolute(projectDirectory)) throw new ArtifactInfoProjectDirectoryError(projectDirectory);
  if (kind !== null && !['command', 'template', 'script', 'hook'].includes(kind)) {
    throw new ArtifactInfoKindError(kind);
  }
  if (typeof request.identifier !== 'string' || !request.identifier) {
    throw new ArtifactInfoIdentifierError(request.identifier);
  }
  validateIdentifier(request.identifier, kind);
  try {
    if (isDir(projectDirectory)) projectFiles(projectDirectory);
  } catch (e) {
    if (e instanceof ProjectPolicyError) {
      throw new ArtifactInfoResolutionError(projectDirectory, request.identifier, e.message);
    }
    throw e;
  }
  if (!isDir(join(projectDirectory, '.specify'))) throw new ArtifactInfoProjectError(projectDirectory);

  let payload: Record<string, unknown>;
  try {
    payload = new ArtifactCatalog(projectDirectory).getArtifactInfo(request.identifier, kind);
  } catch (e) {
    if (e instanceof NotASpecKitProjectError) throw new ArtifactInfoProjectError(projectDirectory);
    if (e instanceof AmbiguousArtifactError) throw new ArtifactInfoAmbiguousError(request.identifier, e.message);
    if (e instanceof ArtifactNotFoundError) {
      if (requestsHook(request.identifier, kind)) throw new ArtifactInfoHookNotFoundError(request.identifier);
      throw new ArtifactInfoNotFoundError(request.identifier);
    }
    if (e instanceof ArtifactResolutionError) {
      throw new ArtifactInfoResolutionError(projectDirectory, request.identifier, e.message);
    }
    if (isOSError(e) || e instanceof PresetError) {
      throw new ArtifactInfoResolutionError(projectDirectory, request.identifier);
    }
    throw e;
  }
  return convertCatalogResult(payload, request);
}
