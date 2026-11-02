/**
 * @oakoliver/specify-cli - Experimental stdio MCP server
 *
 * Port of spec-kit v1.2.5 `mcp_server/server.py` (#4822) and `command_mcp.py`.
 *
 * ADAPTATION: upstream builds on the `mcp` Python SDK (`MCPServer`) and
 * pydantic. This port has no runtime dependencies, so it implements the
 * stdio transport directly: newline-delimited JSON-RPC 2.0 with the
 * `initialize` handshake (protocol versions 2024-11-05 .. 2025-11-25,
 * falling back to 2025-11-25), `ping`, `tools/list`, `tools/call`, and empty
 * `prompts/list` / `resources/list`. Responses, tool schemas, argument
 * validation errors and tool results match what the upstream SDK writes on
 * the wire (see tests/mcp-server.test.ts and tests/fixtures/mcp/wire.json).
 *
 * @module mcp-server/server
 */

import { createInterface } from 'node:readline';

import { ArgumentValidationError, validateArguments } from './arguments.js';
import { parseWireJson, PyFloat } from './json-wire.js';
import { MCP_TOOLS } from './tool-catalog.js';
import { MCP_TOOL_DEFINITIONS, requireAbsoluteLaunchDirectory, type CallToolResult, type ToolDefinition } from './tools.js';

/** Protocol versions accepted by the `initialize` handshake. */
export const HANDSHAKE_PROTOCOL_VERSIONS: readonly string[] = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
export const LATEST_HANDSHAKE_VERSION = '2025-11-25';

export const SERVER_INFO = Object.freeze({
  description: 'Experimental stdio-only MCP adapter for stable Specify CLI JSON commands.',
  name: 'specify',
  title: 'Spec Kit CLI',
  version: 'experimental',
});

const CAPABILITIES = {
  prompts: { listChanged: false },
  resources: { listChanged: false, subscribe: false },
  tools: { listChanged: false },
};

type JsonRpcId = string | number;

interface JsonRpcError {
  code: number;
  message: string;
  data: unknown;
}

const INVALID_PARAMS: JsonRpcError = { code: -32602, message: 'Invalid request parameters', data: '' };

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof PyFloat);
}

/** One server instance: a JSON-RPC message handler bound to a launch directory. */
export class SpecifyMcpServer {
  readonly launchDirectory: string;
  private initialized = false;
  private readonly tools: Map<string, ToolDefinition>;

  constructor(opts: { launchDirectory?: string } = {}) {
    this.launchDirectory = requireAbsoluteLaunchDirectory(opts.launchDirectory ?? process.cwd());
    this.tools = new Map(MCP_TOOL_DEFINITIONS.map((t) => [t.name, t]));
  }

  /** Names of the registered tools, in registration order. */
  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Handle one raw line. Returns the serialized response line (without the
   * trailing newline), or null for notifications and messages that get no
   * response (malformed JSON, invalid envelopes).
   */
  async handleLine(line: string): Promise<string | null> {
    if (!line.trim()) return null;
    let message: unknown;
    try {
      message = parseWireJson(line);
    } catch {
      return null;
    }
    if (!isPlain(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return null;
    if (!('id' in message)) {
      this.handleNotification(message.method);
      return null;
    }
    const id = message.id;
    if (!(typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id)))) return null;
    const outcome = await this.handleRequest(message.method, message.params);
    const response: Record<string, unknown> = { jsonrpc: '2.0', id };
    if ('error' in outcome) response.error = outcome.error;
    else response.result = outcome.result;
    return JSON.stringify(response);
  }

  private handleNotification(_method: string): void {
    // notifications/initialized and others need no response.
  }

  private async handleRequest(
    method: string,
    params: unknown,
  ): Promise<{ result: unknown } | { error: JsonRpcError }> {
    if (method === 'initialize') return this.initialize(params);
    if (method === 'ping') return { result: {} };
    if (!this.initialized) return { error: INVALID_PARAMS };
    if (params !== undefined && params !== null && !isPlain(params)) return { error: INVALID_PARAMS };
    switch (method) {
      case 'tools/list':
        return { result: { tools: this.toolNames().map((n) => MCP_TOOLS.find((t) => t.name === n)!) } };
      case 'tools/call':
        return this.callTool(params as Record<string, unknown> | undefined);
      case 'prompts/list':
        return { result: { prompts: [] } };
      case 'resources/list':
        return { result: { resources: [] } };
      default:
        return { error: { code: -32601, message: 'Method not found', data: method } };
    }
  }

  private initialize(params: unknown): { result: unknown } | { error: JsonRpcError } {
    if (
      !isPlain(params) ||
      typeof params.protocolVersion !== 'string' ||
      !isPlain(params.capabilities) ||
      !isPlain(params.clientInfo) ||
      typeof params.clientInfo.name !== 'string' ||
      typeof params.clientInfo.version !== 'string'
    ) {
      return { error: INVALID_PARAMS };
    }
    const requested = params.protocolVersion;
    const negotiated = HANDSHAKE_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_HANDSHAKE_VERSION;
    this.initialized = true;
    return { result: { capabilities: CAPABILITIES, protocolVersion: negotiated, serverInfo: { ...SERVER_INFO } } };
  }

  private async callTool(params: Record<string, unknown> | undefined): Promise<{ result: unknown } | { error: JsonRpcError }> {
    if (!params || typeof params.name !== 'string') return { error: INVALID_PARAMS };
    const rawArgs = params.arguments;
    if (rawArgs !== undefined && rawArgs !== null && !isPlain(rawArgs)) return { error: INVALID_PARAMS };
    const name = params.name;
    const tool = this.tools.get(name);
    if (!tool) {
      const unknown: CallToolResult = { content: [{ text: `Unknown tool: ${name}`, type: 'text' }], isError: true };
      return { result: unknown };
    }
    let args: Record<string, unknown>;
    try {
      args = validateArguments(tool.arguments, (rawArgs as Record<string, unknown> | undefined) ?? {});
    } catch (e) {
      if (e instanceof ArgumentValidationError) {
        const failed: CallToolResult = {
          content: [{ text: `Error executing tool ${name}: ${e.message}`, type: 'text' }],
          isError: true,
        };
        return { result: failed };
      }
      throw e;
    }
    try {
      return { result: await tool.call(args, { launchDirectory: this.launchDirectory }) };
    } catch (e) {
      const failed: CallToolResult = {
        content: [{ text: `Error executing tool ${name}: ${e instanceof Error ? e.message : String(e)}`, type: 'text' }],
        isError: true,
      };
      return { result: failed };
    }
  }
}

/** Create the experimental local stdio MCP server. */
export function createServer(opts: { launchDirectory?: string } = {}): SpecifyMcpServer {
  return new SpecifyMcpServer(opts);
}

/** Run the MCP server using stdio and no alternate transport. */
export async function runStdioServer(
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<void> {
  const server = createServer();
  const rl = createInterface({ input: io.input, crlfDelay: Infinity, terminal: false });
  for await (const line of rl) {
    const response = await server.handleLine(line);
    if (response !== null) io.output.write(response + '\n');
  }
}
