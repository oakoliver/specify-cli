/**
 * Experimental stdio MCP server (spec-kit v1.2.5 `specify mcp`).
 *
 * Wire parity: tests/fixtures/mcp/wire.json was recorded from upstream
 * `specify mcp` (Python 1.2.5, mcp 2.3 / pydantic 2.14) by
 * tests/fixtures/generate/mcp_wire.py, against a project created with
 * `specify init proj --integration claude --script sh`. This suite creates
 * the same project with this port's `specify init`, replays every request
 * and requires the identical JSON-RPC response. The only intended
 * difference is the adapted version payload schema (runtime name/version
 * instead of `python`, plus `upstream_spec_kit_version`).
 *
 * Also ports tests/specify_cli/mcp_server/*, test_mcp_version.py,
 * test_command_mcp.py and the artifact/workflow MCP adapter tests.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { console as appConsole, setPromptInput } from '../src/console.js';
import { runInitCommand } from '../src/init.js';
import { ArgumentValidationError, validateArguments } from '../src/mcp-server/arguments.js';
import { parseWireJson, PyFloat, pyFloatRepr } from '../src/mcp-server/json-wire.js';
import { HANDSHAKE_PROTOCOL_VERSIONS, SpecifyMcpServer, runStdioServer } from '../src/mcp-server/server.js';
import { MCP_TOOLS } from '../src/mcp-server/tool-catalog.js';
import {
  ARTIFACT_TOOLS,
  WORKFLOW_TOOLS,
  isVersionPayload,
  mcpExecutorDeps,
  mcpVersionDeps,
  runVersionCommandProcess,
} from '../src/mcp-server/tools.js';
import { collectVersionResult } from '../src/operation-version.js';
import { runMcpCommand } from '../src/command-mcp.js';

interface WireEntry {
  label: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

const WIRE = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'mcp', 'wire.json'), 'utf8')) as WireEntry[];

let work: string;
let project: string;

beforeAll(async () => {
  work = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-mcp-')));
  const prev = process.cwd();
  process.chdir(work);
  setPromptInput([]);
  appConsole.beginCapture();
  try {
    const code = await runInitCommand(['proj', '--integration', 'claude', '--script', 'sh', '--ignore-agent-tools', '--non-interactive']);
    expect(code).toBe(0);
  } finally {
    appConsole.endCapture();
    setPromptInput(null);
    process.chdir(prev);
  }
  project = join(work, 'proj');
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

async function initialized(launchDirectory = project): Promise<SpecifyMcpServer> {
  const server = new SpecifyMcpServer({ launchDirectory });
  await server.handleLine(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }),
  );
  return server;
}

async function rpc(server: SpecifyMcpServer, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const line = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, ...msg }));
  return JSON.parse(line!) as Record<string, unknown>;
}

async function call(server: SpecifyMcpServer, name: string, args?: unknown): Promise<Record<string, unknown>> {
  const params: Record<string, unknown> = { name };
  if (args !== undefined) params.arguments = args;
  return (await rpc(server, { method: 'tools/call', params })).result as Record<string, unknown>;
}

/** Map the port's adapted version schema back to upstream's shape. */
function unadaptVersionSchema(schema: Record<string, unknown>, runtimeDef: string): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(schema)) as Record<string, any>;
  delete s.properties.upstream_spec_kit_version;
  s.required = s.required.filter((r: string) => r !== 'upstream_spec_kit_version');
  const rt = s.$defs[runtimeDef];
  rt.properties = { python: { title: 'Python', type: 'string' }, openssl: rt.properties.openssl };
  rt.required = ['python', 'openssl'];
  return s;
}

// ============================================================================
// Wire parity with upstream
// ============================================================================

describe('wire parity with upstream specify mcp 1.2.5', () => {
  test('fixture covers every registered tool', () => {
    const called = new Set(
      WIRE.filter((e) => e.request.method === 'tools/call').map((e) => (e.request.params as { name: string }).name),
    );
    for (const t of MCP_TOOLS) {
      if (t.name === 'specify_run_command' || t.name === 'specify_list_commands' || t.name === 'specify_version') continue;
      expect(called.has(t.name as string)).toBe(true);
    }
  });

  for (const entry of WIRE) {
    test(entry.label, async () => {
      const server = await initialized();
      const line = await server.handleLine(JSON.stringify(entry.request));
      const actual = JSON.parse(line!.split(project).join('<PROJECT>')) as Record<string, any>;
      if (entry.label === 'tools-list') {
        const expected = entry.response as Record<string, any>;
        const tools = actual.result.tools.map((t: Record<string, any>) => {
          if (t.name === 'specify_version') return { ...t, outputSchema: unadaptVersionSchema(t.outputSchema, 'VersionRuntimeResult') };
          if (t.name === 'specify_run_command') return { ...t, outputSchema: unadaptVersionSchema(t.outputSchema, 'RuntimeInfo') };
          return t;
        });
        expect(tools).toEqual(expected.result.tools);
        // Key order of the schemas is part of the wire bytes.
        expect(JSON.stringify(tools)).toBe(JSON.stringify(expected.result.tools));
        return;
      }
      expect(actual).toEqual(entry.response);
      // Byte-level: compact JSON with the same key order.
      expect(JSON.stringify(actual)).toBe(JSON.stringify(entry.response));
    });
  }
});

// ============================================================================
// Protocol
// ============================================================================

describe('protocol', () => {
  test('negotiates handshake versions and falls back to the latest', async () => {
    for (const v of HANDSHAKE_PROTOCOL_VERSIONS) {
      const server = new SpecifyMcpServer({ launchDirectory: project });
      const r = await rpc(server, {
        method: 'initialize',
        params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } },
      });
      expect((r.result as Record<string, unknown>).protocolVersion).toBe(v);
    }
    const server = new SpecifyMcpServer({ launchDirectory: project });
    const r = await rpc(server, {
      method: 'initialize',
      params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    expect((r.result as Record<string, unknown>).protocolVersion).toBe('2025-11-25');
  });

  test('requests before initialize and malformed params are invalid', async () => {
    const server = new SpecifyMcpServer({ launchDirectory: project });
    expect((await rpc(server, { method: 'tools/list' })).error).toEqual({
      code: -32602,
      message: 'Invalid request parameters',
      data: '',
    });
    expect((await rpc(server, { method: 'initialize', params: {} })).error).toBeDefined();
    const ready = await initialized();
    expect((await rpc(ready, { method: 'tools/call' })).error).toEqual({ code: -32602, message: 'Invalid request parameters', data: '' });
    expect((await rpc(ready, { method: 'tools/call', params: { name: 5 } })).error).toBeDefined();
    expect((await rpc(ready, { method: 'tools/call', params: { name: 'specify_version', arguments: [] } })).error).toBeDefined();
  });

  test('malformed JSON, invalid envelopes and notifications get no response', async () => {
    const server = await initialized();
    expect(await server.handleLine('not json')).toBeNull();
    expect(await server.handleLine('[1,2]')).toBeNull();
    expect(await server.handleLine('{"id":8,"method":"ping"}')).toBeNull();
    expect(await server.handleLine('{"jsonrpc":"2.0","id":null,"method":"ping"}')).toBeNull();
    expect(await server.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toBeNull();
    expect(await server.handleLine('{"jsonrpc":"2.0","id":"s","method":"ping"}')).toBe('{"jsonrpc":"2.0","id":"s","result":{}}');
  });

  test('prompts and resources are empty', async () => {
    const server = await initialized();
    expect((await rpc(server, { method: 'prompts/list' })).result).toEqual({ prompts: [] });
    expect((await rpc(server, { method: 'resources/list' })).result).toEqual({ resources: [] });
  });

  test('stdio transport writes one line per response', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on('data', (c) => chunks.push(String(c)));
    const prev = process.cwd();
    process.chdir(project);
    const done = runStdioServer({ input, output });
    process.chdir(prev);
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }) + '\n',
    );
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    input.end();
    await done;
    const lines = chunks.join('').split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[1])).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
  });

  test('launch directory must be absolute', () => {
    expect(() => new SpecifyMcpServer({ launchDirectory: 'relative' })).toThrow('MCP server launch directory must be absolute');
  });
});

// ============================================================================
// Argument validation (pydantic parity)
// ============================================================================

describe('argument validation', () => {
  const model = {
    title: 'mArguments',
    fields: [
      { name: 'a', type: 'int' as const, default: 1, ge: 1 },
      { name: 'b', type: 'str' as const, nullable: true, default: null },
    ],
    closed: true,
  };
  const message = (args: Record<string, unknown>): string => {
    try {
      validateArguments(model, args);
    } catch (e) {
      return (e as ArgumentValidationError).message;
    }
    return '';
  };

  test('long input reprs are truncated like pydantic-core', () => {
    expect(message({ a: 'x'.repeat(300) })).toBe(
      "1 validation error for mArguments\na\n  Input should be a valid integer [type=int_type, input_value='xxxxxxxxxxxxxxxxxxxxxxxx...xxxxxxxxxxxxxxxxxxxxxxx', input_type=str]\n    For further information visit https://errors.pydantic.dev/2.14/v/int_type",
    );
    expect(message({ b: { k: 'v'.repeat(200) } })).toContain(
      "input_value={'k': 'vvvvvvvvvvvvvvvvvv...vvvvvvvvvvvvvvvvvvvvvv'}, input_type=dict]",
    );
  });

  test('lists, None, floats and negative ints render like Python', () => {
    expect(message({ b: [1, 2] })).toContain('input_value=[1, 2], input_type=list]');
    expect(message({ zz: null })).toContain('Extra inputs are not permitted [type=extra_forbidden, input_value=None, input_type=NoneType]');
    expect(message({ a: new PyFloat(1.5) })).toContain('input_value=1.5, input_type=float]');
    expect(message({ a: -5 })).toContain('Input should be greater than or equal to 1 [type=greater_than_equal, input_value=-5, input_type=int]');
  });

  test('wire JSON keeps Python float/int distinction', () => {
    const v = parseWireJson('{"a": 2.0, "b": 2, "c": 1e30}') as Record<string, unknown>;
    expect(v.a).toBeInstanceOf(PyFloat);
    expect(v.b).toBe(2);
    expect(pyFloatRepr((v.a as PyFloat).value)).toBe('2.0');
    expect(pyFloatRepr((v.c as PyFloat).value)).toBe('1e+30');
    expect(() => parseWireJson('{"a": 1,}')).toThrow();
  });

  test('float limit is rejected on the wire', async () => {
    const server = await initialized();
    const line = await server.handleLine(
      '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"specify_artifact_list","arguments":{"limit":2.0}}}',
    );
    expect(JSON.parse(line!).result.content[0].text).toBe(
      "Error executing tool specify_artifact_list: 1 validation error for specify_artifact_listArguments\nlimit\n  Input should be a valid integer [type=int_type, input_value=2.0, input_type=float]\n    For further information visit https://errors.pydantic.dev/2.14/v/int_type",
    );
  });

  test('multiple errors are reported in field order, then extras', async () => {
    const server = await initialized();
    const r = await call(server, 'specify_artifact_list', { limit: 2, x: 1, cursor: '01' });
    expect((r.content as Array<{ text: string }>)[0].text).toBe(
      "Error executing tool specify_artifact_list: 2 validation errors for specify_artifact_listArguments\ncursor\n  String should match pattern '^(0|[1-9][0-9]*)$' [type=string_pattern_mismatch, input_value='01', input_type=str]\n    For further information visit https://errors.pydantic.dev/2.14/v/string_pattern_mismatch\nx\n  Extra inputs are not permitted [type=extra_forbidden, input_value=1, input_type=int]\n    For further information visit https://errors.pydantic.dev/2.14/v/extra_forbidden",
    );
    const tooLong = await call(server, 'specify_artifact_list', { cursor: '123456789012345678901' });
    expect((tooLong.content as Array<{ text: string }>)[0].text).toContain(
      'String should have at most 20 characters [type=string_too_long',
    );
    const boolLimit = await call(server, 'specify_artifact_list', { limit: true });
    expect((boolLimit.content as Array<{ text: string }>)[0].text).toContain('input_value=True, input_type=bool]');
  });
});

// ============================================================================
// Version tools (test_mcp_version.py, mcp_server/test_executor.py)
// ============================================================================

describe('specify_version', () => {
  test('returns the shared operation result as structured content', async () => {
    const server = await initialized();
    const r = await call(server, 'specify_version', {});
    expect(r.isError).toBe(false);
    const structured = r.structuredContent as Record<string, unknown>;
    expect(isVersionPayload(structured)).toBe(true);
    expect((r.content as Array<{ text: string }>)[0].text).toBe(JSON.stringify(structured, null, 2));
    const expected = await collectVersionResult();
    expect(structured.cli_version).toBe(expected.cliVersion);
  });

  test('incomplete operation results become invalid_operation_result', async () => {
    const saved = mcpVersionDeps.collect;
    mcpVersionDeps.collect = async () => ({ ...(await collectVersionResult()), runtime: null });
    try {
      const r = await call(await initialized(), 'specify_version', {});
      expect(r).toEqual({
        content: [{ text: 'invalid_operation_result: The version operation returned an invalid result.', type: 'text' }],
        isError: true,
        structuredContent: {
          error: { code: 'invalid_operation_result', message: 'The version operation returned an invalid result.', details: {} },
        },
      });
    } finally {
      mcpVersionDeps.collect = saved;
    }
  });

  test('unexpected failures are sanitized', async () => {
    const saved = mcpVersionDeps.collect;
    mcpVersionDeps.collect = async () => {
      throw new Error('SECRET /Users/x');
    };
    try {
      const r = await call(await initialized(), 'specify_version', {});
      expect(JSON.stringify(r)).not.toContain('SECRET');
      expect((r.structuredContent as any).error.code).toBe('internal_error');
    } finally {
      mcpVersionDeps.collect = saved;
    }
  });
});

describe('specify_run_command executor', () => {
  const saved = { ...mcpExecutorDeps };
  const fake = (status: number, stdout: string, stderr = '') => () => ({
    status,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
  });
  const valid = JSON.stringify({
    cli_version: '1.2.3',
    upstream_spec_kit_version: '1.2.5',
    runtime: { name: 'Node', version: '22.0.0', openssl: null },
    system: { platform: 'X', architecture: 'y', os_version: 'z' },
    features: { a: true },
  });

  const reason = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (e) {
      return (e as { details?: Record<string, unknown> }).details?.reason ?? (e as Error).message;
    }
    return null;
  };

  test('validates the child process output strictly', () => {
    try {
      mcpExecutorDeps.run = fake(0, valid);
      expect(runVersionCommandProcess().cli_version).toBe('1.2.3');
      mcpExecutorDeps.run = fake(0, valid, 'noise');
      expect(reason(runVersionCommandProcess)).toBe('mixed_success_output');
      mcpExecutorDeps.run = fake(0, 'nope');
      expect(reason(runVersionCommandProcess)).toBe('invalid_success_output');
      mcpExecutorDeps.run = fake(0, JSON.stringify({ cli_version: '1' }));
      expect(reason(runVersionCommandProcess)).toBe('invalid_success_payload');
      mcpExecutorDeps.run = fake(1, 'x', '{}');
      expect(reason(runVersionCommandProcess)).toBe('mixed_failure_output');
      mcpExecutorDeps.run = fake(1, '', '{"error": 1}');
      expect(reason(runVersionCommandProcess)).toBe('invalid_failure_payload');
      mcpExecutorDeps.run = () => ({ status: 0, stdout: Buffer.from([0xff]), stderr: Buffer.alloc(0) });
      expect(reason(runVersionCommandProcess)).toBe('invalid_utf8');
      mcpExecutorDeps.run = () => ({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: new Error('x') });
      expect(reason(runVersionCommandProcess)).toBe('process_launch_failed');
      mcpExecutorDeps.run = fake(1, '', JSON.stringify({ error: { code: 'internal_error', message: 'Unable', details: {} } }));
      expect(reason(runVersionCommandProcess)).toBe('Unable');
    } finally {
      Object.assign(mcpExecutorDeps, saved);
    }
  });

  test('runs the real CLI end to end', async () => {
    mcpExecutorDeps.cliArgv = () => [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts')];
    try {
      const r = await call(await initialized(), 'specify_run_command', { command: 'version' });
      expect(r.isError).toBe(false);
      expect(isVersionPayload(r.structuredContent)).toBe(true);
    } finally {
      Object.assign(mcpExecutorDeps, saved);
    }
  });
});

// ============================================================================
// Artifact and workflow tools
// ============================================================================

describe('artifact and workflow tools', () => {
  test('artifact list pages through the whole inventory', async () => {
    const server = await initialized();
    const all = await call(server, 'specify_artifact_list', { limit: 1000 });
    const total = ((all.structuredContent as any).rows as unknown[]).length;
    let cursor: string | null = null;
    let seen = 0;
    do {
      const args: Record<string, unknown> = { limit: 7 };
      if (cursor !== null) args.cursor = cursor;
      const page = (await call(server, 'specify_artifact_list', args)).structuredContent as any;
      seen += page.rows.length;
      expect(page.truncated).toBe(page.next_cursor !== null);
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(seen).toBe(total);
  });

  test('artifact list reports persisted-policy failures', async () => {
    const root = join(work, 'policy');
    mkdirSync(join(root, '.specify'), { recursive: true });
    writeFileSync(join(root, '.specify', 'init-options.json'), '{"allow_symlinks": "yes"}');
    const r = await call(await initialized(), 'specify_artifact_list', { project_directory: root });
    expect((r.structuredContent as any).error.code).toBe('artifact_resolution_failed');
    expect((r.structuredContent as any).error.message).toContain('allow_symlinks must be a JSON boolean');
  });

  test('artifact info returns the full composition stack', async () => {
    const r = await call(await initialized(), 'specify_artifact_info', { identifier: 'command:speckit.plan' });
    expect(r.isError).toBe(false);
    const s = r.structuredContent as any;
    expect(Object.keys(s)).toEqual(['id', 'name', 'kind', 'description', 'stack']);
    expect(s.id).toBe('command:speckit.plan');
  });

  test('workflow list refuses symlinked storage without leaking paths', async () => {
    const root = join(work, 'linked');
    mkdirSync(join(root, '.specify'), { recursive: true });
    mkdirSync(join(work, 'elsewhere'));
    symlinkSync(join(work, 'elsewhere'), join(root, '.specify', 'workflows'), 'dir');
    const r = await call(await initialized(), 'specify_workflow_list', { project_directory: root });
    expect(r).toEqual({
      content: [{ text: 'unsafe_workflow_storage: The selected workflow storage is unsafe or unreadable.', type: 'text' }],
      isError: true,
      structuredContent: {
        error: {
          code: 'unsafe_workflow_storage',
          message: 'The selected workflow storage is unsafe or unreadable.',
          details: {},
          retryable: false,
        },
      },
    });
  });

  test('workflow list reports corrupted registry entries as warnings in order', async () => {
    const root = join(work, 'warn');
    mkdirSync(join(root, '.specify', 'workflows'), { recursive: true });
    writeFileSync(
      join(root, '.specify', 'workflows', 'workflow-registry.json'),
      JSON.stringify({ schema_version: '1.0', workflows: { bad: 'x', good: { name: 'Good', version: 2 } } }),
    );
    const r = await call(await initialized(), 'specify_workflow_list', { project_directory: root, limit: 1 });
    expect(r.structuredContent).toEqual({
      items: [{ kind: 'warning', code: 'invalid_registry_entry', workflow_id: 'bad', message: "Skipping corrupted registry entry 'bad'." }],
      truncated: true,
    });
    const full = await call(await initialized(), 'specify_workflow_list', { project_directory: root });
    expect((full.structuredContent as any).items[1]).toEqual({
      kind: 'workflow',
      id: 'good',
      name: 'Good',
      version: '2',
      description: null,
      enabled: true,
    });
  });
});

// ============================================================================
// Inventories and CLI
// ============================================================================

describe('inventories and CLI', () => {
  test('artifact and workflow inventories expose only implemented tools', () => {
    expect(ARTIFACT_TOOLS.filter((t) => t.disposition === 'available').map((t) => t.mcpToolName)).toEqual([
      'specify_artifact_list',
      'specify_artifact_info',
    ]);
    expect(WORKFLOW_TOOLS.filter((t) => t.disposition === 'available').map((t) => t.mcpToolName)).toEqual([
      'specify_workflow_list',
    ]);
    const names = MCP_TOOLS.map((t) => t.name);
    for (const t of [...ARTIFACT_TOOLS, ...WORKFLOW_TOOLS]) {
      expect(names.includes(t.mcpToolName)).toBe(t.disposition === 'available');
    }
  });

  test('specify mcp --help', async () => {
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
    try {
      expect(await runMcpCommand(['--help'])).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    expect(out.join('')).toContain('Run the experimental MCP server over stdio.');
  });
});
