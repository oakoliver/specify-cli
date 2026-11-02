/**
 * @oakoliver/specify-cli - MCP tools
 *
 * Ports of spec-kit v1.2.5:
 * - `mcp_server/catalog.py` + `executor.py` (#4822): `specify_list_commands`,
 *   `specify_describe_command`, `specify_run_command`;
 * - `mcp_version.py` (#4864): `specify_version`;
 * - `artifacts/mcp_list.py` (#4867) / `mcp_info.py` (#4885):
 *   `specify_artifact_list`, `specify_artifact_info`;
 * - `workflows/mcp_list.py` (#5115): `specify_workflow_list`;
 * - the explicit MCP inventories of `artifacts/_mcp.py` and
 *   `workflows/_mcp.py` (#5054).
 *
 * @module mcp-server/tools
 */

import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

import {
  ARTIFACT_INFO_OPERATION,
  ARTIFACT_LIST_CURSOR_MAX_LENGTH,
  ARTIFACT_LIST_MAX_LIMIT,
  ARTIFACT_LIST_OPERATION,
  ArtifactInfoError,
  ArtifactListError,
  getArtifactInfo,
  listArtifacts,
} from '../artifacts/operations.js';
import type { ArtifactKind } from '../artifacts/models.js';
import { VERSION_OPERATION, collectVersionResult, versionResultPayload } from '../operation-version.js';
import {
  WORKFLOW_LIST_MAX_LIMIT,
  WORKFLOW_LIST_OPERATION,
  WorkflowListError,
  listWorkflows,
} from '../workflows/operation-list.js';
import type { ArgumentModel } from './arguments.js';

// ============================================================================
// Results
// ============================================================================

export interface TextContent {
  text: string;
  type: 'text';
}

/** `mcp.types.CallToolResult` (wire key order: content, isError, structuredContent). */
export interface CallToolResult {
  content: TextContent[];
  isError: boolean;
  structuredContent?: Record<string, unknown>;
}

/** A successful structured result: pretty text (model_dump_json(indent=2)) + structured copy. */
export function structuredResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ text: JSON.stringify(payload, null, 2), type: 'text' }],
    isError: false,
    structuredContent: payload,
  };
}

function toolError(
  code: string,
  message: string,
  opts: { details?: Record<string, unknown>; retryable?: boolean | null } = {},
): CallToolResult {
  const error: Record<string, unknown> = { code, message, details: opts.details ?? {} };
  if (opts.retryable !== null && opts.retryable !== undefined) error.retryable = opts.retryable;
  return { content: [{ text: `${code}: ${message}`, type: 'text' }], isError: true, structuredContent: { error } };
}

const MAX_WIRE_RESPONSE_BYTES = 1024 * 1024;
const WIRE_ENVELOPE_RESERVE_BYTES = 1024;

/** Bound the serialized result plus conservative JSON-RPC envelope space. */
export function wireResponseSize(result: CallToolResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8') + WIRE_ENVELOPE_RESERVE_BYTES;
}

// ============================================================================
// Tool definition
// ============================================================================

export interface ToolContext {
  /** Absolute directory the server was launched from (default project). */
  launchDirectory: string;
}

export interface ToolDefinition {
  name: string;
  arguments: ArgumentModel;
  call(args: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult>;
}

// ============================================================================
// Legacy command catalog (catalog.py / executor.py)
// ============================================================================

const VERSION_DESCRIPTION = {
  command: 'version',
  description: 'Return the installed Spec Kit CLI version, runtime, system, and feature capabilities.',
  arguments: [] as unknown[],
  read_only: true,
  json_output: true,
};
const SUPPORTED_COMMANDS: Record<string, typeof VERSION_DESCRIPTION> = { version: VERSION_DESCRIPTION };

/** Sanitized command error suitable for conversion to an MCP tool error. */
export class CommandAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CommandAdapterError';
  }
  payload(): Record<string, unknown> {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export function unavailableCommand(command: string): CommandAdapterError {
  return new CommandAdapterError(
    'unavailable_command',
    `Command '${command}' is not available through the experimental Spec Kit MCP server.`,
    { command, available_commands: Object.keys(SUPPORTED_COMMANDS) },
  );
}

function adapterError(err: CommandAdapterError): CallToolResult {
  return { content: [{ text: `${err.code}: ${err.message}`, type: 'text' }], isError: true, structuredContent: err.payload() };
}

const INVALID_OUTPUT_MESSAGE = 'The Specify CLI returned invalid machine-readable output.';

function adapterFailure(reason: string): CommandAdapterError {
  return new CommandAdapterError('adapter_internal_error', INVALID_OUTPUT_MESSAGE, { command: 'version', reason });
}

/** Process seam for `specify_run_command` (upstream runs `python -P -m specify_cli.mcp_server._worker`). */
export const mcpExecutorDeps = {
  /** argv prefix that invokes this CLI (runtime + entry script). */
  cliArgv: (): string[] => [process.execPath, process.argv[1] ?? ''],
  run: (argv: string[]): { status: number | null; stdout: Buffer; stderr: Buffer; error?: Error } => {
    const r = spawnSync(argv[0], argv.slice(1), { maxBuffer: 16 * 1024 * 1024 });
    return {
      status: r.status,
      stdout: r.stdout ?? Buffer.alloc(0),
      stderr: r.stderr ?? Buffer.alloc(0),
      error: r.error,
    };
  },
};

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
}

/** Strict structural check of the (adapted) `specify version --json` payload. */
export function isVersionPayload(p: unknown): p is Record<string, unknown> {
  if (!isPlain(p) || !exactKeys(p, ['cli_version', 'upstream_spec_kit_version', 'runtime', 'system', 'features'])) {
    return false;
  }
  const { runtime, system, features } = p;
  return (
    typeof p.cli_version === 'string' &&
    typeof p.upstream_spec_kit_version === 'string' &&
    isPlain(runtime) &&
    exactKeys(runtime, ['name', 'version', 'openssl']) &&
    typeof runtime.name === 'string' &&
    typeof runtime.version === 'string' &&
    (runtime.openssl === null || typeof runtime.openssl === 'string') &&
    isPlain(system) &&
    exactKeys(system, ['platform', 'architecture', 'os_version']) &&
    Object.values(system).every((v) => typeof v === 'string') &&
    isPlain(features) &&
    Object.values(features).every((v) => typeof v === 'boolean')
  );
}

function decodeUtf8(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw adapterFailure('invalid_utf8');
  }
}

function parseObject(raw: string, reason: string): Record<string, unknown> {
  if (!raw.trim()) throw adapterFailure(reason);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw adapterFailure(reason);
  }
  if (!isPlain(payload)) throw adapterFailure(reason);
  return payload;
}

/** Run `specify version --json` through the real CLI process (executor.py `_run_version`). */
export function runVersionCommandProcess(): Record<string, unknown> {
  const argv = [...mcpExecutorDeps.cliArgv(), 'version', '--json'];
  const completed = mcpExecutorDeps.run(argv);
  if (completed.error) throw adapterFailure('process_launch_failed');
  const stdout = decodeUtf8(completed.stdout);
  const stderr = decodeUtf8(completed.stderr);
  if (completed.status === 0) {
    if (stderr.trim()) throw adapterFailure('mixed_success_output');
    const payload = parseObject(stdout, 'invalid_success_output');
    if (!isVersionPayload(payload)) throw adapterFailure('invalid_success_payload');
    return payload;
  }
  if (stdout.trim()) throw adapterFailure('mixed_failure_output');
  const payload = parseObject(stderr, 'invalid_failure_output');
  const error = payload.error;
  if (
    !exactKeys(payload, ['error']) ||
    !isPlain(error) ||
    !exactKeys(error, ['code', 'message', 'details']) ||
    typeof error.code !== 'string' ||
    typeof error.message !== 'string' ||
    !isPlain(error.details)
  ) {
    throw adapterFailure('invalid_failure_payload');
  }
  throw new CommandAdapterError(error.code, error.message, error.details);
}

const commandArgumentsModel = (name: string): ArgumentModel => ({
  title: `${name}Arguments`,
  fields: [{ name: 'command', type: 'str', required: true }],
  closed: false,
});

const LIST_COMMANDS: ToolDefinition = {
  name: 'specify_list_commands',
  arguments: { title: 'specify_list_commandsArguments', fields: [], closed: false },
  async call() {
    return structuredResult({ commands: Object.values(SUPPORTED_COMMANDS).map((c) => ({ ...c })) });
  },
};

const DESCRIBE_COMMAND: ToolDefinition = {
  name: 'specify_describe_command',
  arguments: commandArgumentsModel('specify_describe_command'),
  async call(args) {
    const description = SUPPORTED_COMMANDS[String(args.command)];
    if (!Object.prototype.hasOwnProperty.call(SUPPORTED_COMMANDS, String(args.command)) || !description) {
      return adapterError(unavailableCommand(String(args.command)));
    }
    return structuredResult({ ...description });
  },
};

const RUN_COMMAND: ToolDefinition = {
  name: 'specify_run_command',
  arguments: commandArgumentsModel('specify_run_command'),
  async call(args) {
    try {
      if (args.command !== 'version') throw unavailableCommand(String(args.command));
      return structuredResult(runVersionCommandProcess());
    } catch (e) {
      if (e instanceof CommandAdapterError) return adapterError(e);
      throw e;
    }
  },
};

// ============================================================================
// specify_version (mcp_version.py)
// ============================================================================

export const VERSION_TOOL = Object.freeze({
  operationId: VERSION_OPERATION.operationId,
  cliPath: 'specify version',
  mcpToolName: 'specify_version',
  contractVersion: VERSION_OPERATION.contractVersion,
  disposition: 'available' as const,
  dispositionReason: null,
  capabilities: VERSION_OPERATION.capabilities,
  networkAccess: VERSION_OPERATION.networkAccess,
});

/** Injection seam for the version tool (upstream patches `collect_version_result`). */
export const mcpVersionDeps = { collect: () => collectVersionResult() };

const VERSION: ToolDefinition = {
  name: 'specify_version',
  arguments: { title: 'specify_versionArguments', fields: [], closed: true },
  async call() {
    let payload: Record<string, unknown>;
    try {
      const result = await mcpVersionDeps.collect();
      if (result.runtime === null || result.system === null) {
        return toolError('invalid_operation_result', 'The version operation returned an invalid result.', {
          retryable: null,
        });
      }
      payload = versionResultPayload(result);
      if (!isVersionPayload(payload)) {
        return toolError('invalid_operation_result', 'The version operation returned an invalid result.', {
          retryable: null,
        });
      }
    } catch {
      return toolError('internal_error', 'Unable to collect version information.', { retryable: null });
    }
    return structuredResult(payload);
  },
};

// ============================================================================
// Artifact tools (artifacts/mcp_list.py, mcp_info.py)
// ============================================================================

const ARTIFACT_LIST_DEFAULT_LIMIT = 100;

function boundResult(
  result: CallToolResult,
  tooLarge: () => CallToolResult,
  maxBytes = MAX_WIRE_RESPONSE_BYTES,
): CallToolResult {
  return wireResponseSize(result) <= maxBytes ? result : tooLarge();
}

const STACK_KEYS = ['id', 'layer', 'sourceId', 'presetId', 'presetName', 'strategy', 'active', 'hidden', 'manifestPath', 'lookupId', 'sourcePath'];
const HOOK_STACK_KEYS = [...STACK_KEYS, 'priority', 'optional'];

/** Re-key an object in the result model's declared field order (pydantic dump order). */
function ordered(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = o[k];
  return out;
}

function orderedArtifact(row: Record<string, unknown>): Record<string, unknown> {
  if (row.kind === 'hook') {
    const out = ordered(row, ['id', 'name', 'kind', 'description', 'eventName', 'targetCommand', 'registered']);
    out.stack = (row.stack as Array<Record<string, unknown>>).map((e) => ordered(e, HOOK_STACK_KEYS));
    return out;
  }
  const out = ordered(row, ['id', 'name', 'kind', 'description']);
  out.stack = (row.stack as Array<Record<string, unknown>>).map((e) => ordered(e, STACK_KEYS));
  return out;
}

const ARTIFACT_LIST: ToolDefinition = {
  name: 'specify_artifact_list',
  arguments: {
    title: 'specify_artifact_listArguments',
    fields: [
      { name: 'project_directory', type: 'str', nullable: true, default: null },
      { name: 'limit', type: 'int', default: ARTIFACT_LIST_DEFAULT_LIMIT, ge: 1, le: ARTIFACT_LIST_MAX_LIMIT },
      {
        name: 'cursor',
        type: 'str',
        nullable: true,
        default: null,
        maxLength: ARTIFACT_LIST_CURSOR_MAX_LENGTH,
        pattern: '^(0|[1-9][0-9]*)$',
      },
    ],
    closed: true,
  },
  async call(args, ctx) {
    const limit = args.limit as number;
    const tooLarge = (): CallToolResult =>
      toolError('response_too_large', 'The artifact list result exceeds the MCP response-size limit.', {
        details: { max_bytes: MAX_WIRE_RESPONSE_BYTES, requested_limit: limit },
        retryable: true,
      });
    const dir = args.project_directory === null ? ctx.launchDirectory : (args.project_directory as string);
    try {
      const result = listArtifacts({ projectDirectory: dir, limit, cursor: args.cursor as string | null });
      if (result.truncated !== (result.nextCursor !== null)) throw new TypeError('inconsistent continuation');
      return boundResult(
        structuredResult({
          rows: result.rows.map(orderedArtifact),
          next_cursor: result.nextCursor,
          truncated: result.truncated,
        }),
        tooLarge,
      );
    } catch (e) {
      if (e instanceof ArtifactListError) {
        return boundResult(toolError(e.code, e.message, { details: e.details, retryable: e.retryable }), tooLarge);
      }
      if (e instanceof TypeError) {
        return boundResult(
          toolError('invalid_operation_result', 'The artifact list operation returned an invalid result.', { retryable: false }),
          tooLarge,
        );
      }
      return boundResult(toolError('internal_error', 'Unable to list Spec Kit artifacts.', { retryable: false }), tooLarge);
    }
  },
};

const ARTIFACT_INFO: ToolDefinition = {
  name: 'specify_artifact_info',
  arguments: {
    title: 'specify_artifact_infoArguments',
    fields: [
      { name: 'identifier', type: 'str', required: true },
      { name: 'kind', type: 'literal', nullable: true, default: null, literals: ['command', 'template', 'script', 'hook'] },
      { name: 'project_directory', type: 'str', nullable: true, default: null },
    ],
    closed: true,
  },
  async call(args, ctx) {
    const tooLarge = (): CallToolResult =>
      toolError('response_too_large', 'The artifact info result exceeds the MCP response-size limit.', {
        details: { max_bytes: MAX_WIRE_RESPONSE_BYTES },
        retryable: true,
      });
    const dir = args.project_directory === null ? ctx.launchDirectory : (args.project_directory as string);
    try {
      const result = getArtifactInfo({
        projectDirectory: dir,
        identifier: args.identifier as string,
        kind: args.kind as ArtifactKind | null,
      });
      return boundResult(structuredResult(orderedArtifact(result.toJsonDict())), tooLarge);
    } catch (e) {
      if (e instanceof ArtifactInfoError) {
        return boundResult(toolError(e.code, e.message, { details: e.details, retryable: e.retryable }), tooLarge);
      }
      return boundResult(toolError('internal_error', 'Unable to inspect the Spec Kit artifact.', { retryable: false }), tooLarge);
    }
  },
};

// ============================================================================
// specify_workflow_list (workflows/mcp_list.py)
// ============================================================================

const WORKFLOW_ERROR_MESSAGES: Record<string, string> = {
  invalid_project_directory: 'project_directory must be an absolute path.',
  not_a_spec_kit_project: 'The selected directory is not a Spec Kit project.',
  unsafe_workflow_storage: 'The selected workflow storage is unsafe or unreadable.',
  workflow_registry_read_failed: 'Unable to read the workflow registry.',
  invalid_limit: 'The workflow list limit is invalid.',
};

const WORKFLOW_LIST: ToolDefinition = {
  name: 'specify_workflow_list',
  arguments: {
    title: 'specify_workflow_listArguments',
    fields: [
      { name: 'project_directory', type: 'str', nullable: true, default: null },
      { name: 'limit', type: 'int', default: 100, ge: 1, le: WORKFLOW_LIST_MAX_LIMIT },
    ],
    closed: true,
  },
  async call(args, ctx) {
    const limit = args.limit as number;
    const dir = args.project_directory === null ? ctx.launchDirectory : (args.project_directory as string);
    let response: CallToolResult;
    try {
      const result = listWorkflows({ projectDirectory: dir, limit });
      if (result.items.length > limit || (result.truncated && result.items.length !== limit)) {
        response = toolError('invalid_operation_result', 'The workflow list result is invalid.', { retryable: false });
      } else {
        response = structuredResult({
          items: result.items.map((item) =>
            item.kind === 'warning'
              ? ordered(item as unknown as Record<string, unknown>, ['kind', 'code', 'workflow_id', 'message'])
              : ordered(item as unknown as Record<string, unknown>, ['kind', 'id', 'name', 'version', 'description', 'enabled']),
          ),
          truncated: result.truncated,
        });
      }
    } catch (e) {
      // Registry/OS exception strings can contain paths or untrusted data; MCP never exposes them.
      if (e instanceof WorkflowListError) {
        response = toolError(e.code, WORKFLOW_ERROR_MESSAGES[e.code] ?? 'Unable to list workflows.', { retryable: false });
      } else {
        response = toolError('internal_error', 'Unable to list installed workflows.', { retryable: false });
      }
    }
    if (wireResponseSize(response) > MAX_WIRE_RESPONSE_BYTES) {
      return toolError('response_too_large', 'Workflow list response exceeds the byte limit; retry with a smaller limit.', {
        retryable: true,
      });
    }
    return response;
  },
};

/** Every registered tool, in upstream registration order. */
export const MCP_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  LIST_COMMANDS,
  DESCRIBE_COMMAND,
  RUN_COMMAND,
  VERSION,
  ARTIFACT_LIST,
  ARTIFACT_INFO,
  WORKFLOW_LIST,
];

// ============================================================================
// MCP inventories (artifacts/_mcp.py, workflows/_mcp.py)
// ============================================================================

export interface ToolInventory {
  operationId: string;
  cliPath: string;
  mcpToolName: string;
  contractVersion: string | null;
  disposition: 'available' | 'unavailable' | 'excluded';
  dispositionReason: string | null;
  capabilities: readonly string[];
  networkAccess: 'none' | 'optional' | 'required';
}

export const ARTIFACT_TOOLS: readonly ToolInventory[] = [
  {
    operationId: ARTIFACT_LIST_OPERATION.operationId,
    cliPath: 'specify artifact list',
    mcpToolName: 'specify_artifact_list',
    contractVersion: ARTIFACT_LIST_OPERATION.contractVersion,
    disposition: 'available',
    dispositionReason: null,
    capabilities: ['local-read'],
    networkAccess: 'none',
  },
  {
    operationId: ARTIFACT_INFO_OPERATION.operationId,
    cliPath: 'specify artifact info',
    mcpToolName: 'specify_artifact_info',
    contractVersion: ARTIFACT_INFO_OPERATION.contractVersion,
    disposition: 'available',
    dispositionReason: null,
    capabilities: ['local-read'],
    networkAccess: 'none',
  },
  {
    operationId: 'artifact.lookup',
    cliPath: 'specify artifact lookup',
    mcpToolName: 'specify_artifact_lookup',
    contractVersion: null,
    disposition: 'unavailable',
    dispositionReason: 'The artifact.lookup CLI leaf does not yet have a shared typed operation.',
    capabilities: ['local-read'],
    networkAccess: 'none',
  },
];

export { WORKFLOW_TOOLS } from './workflow-inventory.js';
export { WORKFLOW_LIST_OPERATION };

/** Validate an absolute launch directory (upstream: ValueError). */
export function requireAbsoluteLaunchDirectory(dir: string): string {
  if (!isAbsolute(dir)) throw new Error('MCP server launch directory must be absolute');
  return dir;
}
