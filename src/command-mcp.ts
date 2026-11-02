/**
 * @oakoliver/specify-cli - `specify mcp`
 *
 * Port of spec-kit v1.2.5 `command_mcp.py` (#4822, #4969): runs the
 * experimental MCP server over stdio.
 *
 * @module command-mcp
 */

import { runStdioServer } from './mcp-server/server.js';

export const MCP_HELP = `Usage: specify mcp [OPTIONS]

  Run the experimental MCP server over stdio.

Options:
  --help  Show this message and exit.
`;

/** Entry point for `specify mcp ...` (args exclude the word `mcp`). */
export async function runMcpCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(MCP_HELP);
    return 0;
  }
  if (args.length > 0) {
    const extra = args[0];
    process.stderr.write(
      `Usage: specify mcp [OPTIONS]\nTry 'specify mcp --help' for help.\n\nError: ` +
        (extra.startsWith('-') ? `No such option: ${extra}` : `Got unexpected extra argument (${extra})`) +
        '\n',
    );
    return 2;
  }
  await runStdioServer();
  return 0;
}
