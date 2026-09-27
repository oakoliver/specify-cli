/**
 * @oakoliver/specify-cli - `specify check` CLI adapter
 *
 * Port of spec-kit `command_check.py` (v1.0.12) argument handling. The
 * command itself lives in `check.ts`.
 *
 * @module command-check
 */

import { check } from './check.js';
import { CliExit } from './console.js';

export const CHECK_HELP = `Usage: specify check [OPTIONS]

  Check that all required tools are installed.

Options:
  --help  Show this message and exit.
`;

/** Entry point for `specify check ...` (args exclude the word `check`). */
export async function runCheckCommand(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(CHECK_HELP);
    return 0;
  }
  if (args.length > 0) {
    const extra = args[0];
    process.stderr.write(
      `Usage: specify check [OPTIONS]\nTry 'specify check --help' for help.\n\nError: ` +
        (extra.startsWith('-') ? `No such option: ${extra}` : `Got unexpected extra argument (${extra})`) +
        '\n',
    );
    return 2;
  }
  try {
    await check();
    return 0;
  } catch (e) {
    if (e instanceof CliExit) return e.code;
    throw e;
  }
}
