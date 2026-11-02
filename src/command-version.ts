/**
 * @oakoliver/specify-cli - `specify version`
 *
 * Port of spec-kit `command_version.py` (v1.2.5): displays version and
 * system information, local CLI feature capabilities (`--features`), or the
 * complete version information as JSON (`--json`, #4821) collected by the
 * shared `version` operation (#4863).
 *
 * @module command-version
 */

import { getSpeckitVersion } from './assets.js';
import { CliExit, Panel, Table, console, escapeMarkup } from './console.js';
import { printBanner } from './ui.js';
import { collectVersionResult, featureCapabilities, versionResultPayload } from './operation-version.js';
import { pyJsonDumps } from './utils.js';
import { UPSTREAM_SPEC_KIT_VERSION, getRuntimeInfo } from './version.js';
import type { RuntimeInfo } from './version.js';

const INTERNAL_ERROR_MESSAGE = 'Unable to collect version information.';

export { featureCapabilities } from './operation-version.js';

// ============================================================================
// Injection surface (tests)
// ============================================================================

export const versionCommandDeps = {
  getSpeckitVersion: (): string => getSpeckitVersion(),
  getRuntimeInfo: (): Promise<RuntimeInfo> => getRuntimeInfo(),
  // Keep the animated gradient banner of this port (upstream: show_banner()).
  showBanner: (): Promise<void> => printBanner(),
  write: (text: string): void => {
    console.out(text, '');
  },
  writeErr: (text: string): void => {
    process.stderr.write(text);
  },
};

// ============================================================================
// Rendering
// ============================================================================

/** Build the upstream "Specify CLI Information" panel (Rich Table in a Panel). */
export function buildInfoPanel(rows: ReadonlyArray<readonly [string, string]>): Panel {
  const infoTable = new Table({ showHeader: false, box: null, padding: [0, 2] });
  infoTable.addColumn('Key', { style: 'cyan', justify: 'right' });
  infoTable.addColumn('Value', { style: 'white' });
  for (const [k, v] of rows) infoTable.addRow(escapeMarkup(k), escapeMarkup(v));
  return new Panel(infoTable, {
    title: '[bold cyan]Specify CLI Information[/bold cyan]',
    borderStyle: 'cyan',
    padding: [1, 2],
  });
}

/** Build the info table rows reported by `specify version`. */
export function buildInfoRows(cliVersion: string, info: RuntimeInfo): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['CLI Version', cliVersion],
    // ADAPTATION: extra row stating upstream parity (not present upstream).
    ['Upstream Parity', `spec-kit ${UPSTREAM_SPEC_KIT_VERSION}`],
    ['', ''],
    // ADAPTATION: upstream reports the Python version; we report Node or Bun.
    [info.runtimeName, info.runtimeVersion],
    ['Platform', info.platform],
    ['Architecture', info.architecture],
    ['OS Version', info.osVersion],
  ];
  // Skip the row when the runtime exposes no TLS library version (upstream: no ssl module).
  if (info.openssl) rows.push(['OpenSSL', info.openssl]);
  return rows;
}

// ============================================================================
// Command
// ============================================================================

export const VERSION_HELP = `Usage: specify version [OPTIONS]

  Display version and system information.

Options:
  --features  Show local CLI feature capabilities.
  --json      Emit complete version information as JSON.
  --help      Show this message and exit.
`;

async function version(features: boolean, jsonOutput: boolean): Promise<void> {
  if (jsonOutput) {
    // --features is an exact alias here: it neither filters nor changes the bytes.
    let rendered: string;
    try {
      const result = await collectVersionResult({
        cliVersionGetter: versionCommandDeps.getSpeckitVersion,
        runtimeInfoGetter: versionCommandDeps.getRuntimeInfo,
      });
      rendered = pyJsonDumps(versionResultPayload(result), { indent: 2 });
    } catch {
      // JSON mode must normalize every unexpected command failure.
      const failure = { error: { code: 'internal_error', message: INTERNAL_ERROR_MESSAGE, details: {} } };
      versionCommandDeps.writeErr(pyJsonDumps(failure, { indent: 2 }) + '\n');
      throw new CliExit(1);
    }
    versionCommandDeps.write(rendered + '\n');
    return;
  }

  const cliVersion = versionCommandDeps.getSpeckitVersion();
  if (features) {
    const capabilities = featureCapabilities();
    versionCommandDeps.write(`Spec Kit CLI: ${cliVersion}\n\nFeatures:\n`);
    for (const [key, enabled] of Object.entries(capabilities)) {
      versionCommandDeps.write(`- ${key.replace(/_/g, ' ')}: ${enabled ? 'yes' : 'no'}\n`);
    }
    return;
  }

  await versionCommandDeps.showBanner();
  const info = await versionCommandDeps.getRuntimeInfo();
  console.print(buildInfoPanel(buildInfoRows(cliVersion, info)));
  console.print();
}

/** Entry point for `specify version ...` (args exclude the word `version`). */
export async function runVersionCommand(args: string[]): Promise<number> {
  let features = false;
  let jsonOutput = false;
  for (const a of args) {
    if (a === '--help' || a === '-h') {
      versionCommandDeps.write(VERSION_HELP);
      return 0;
    }
  }
  for (const a of args) {
    if (a === '--features') features = true;
    else if (a === '--json') jsonOutput = true;
    else {
      process.stderr.write(
        `Usage: specify version [OPTIONS]\nTry 'specify version --help' for help.\n\nError: ` +
          (a.startsWith('-') ? `No such option: ${a}` : `Got unexpected extra argument (${a})`) +
          '\n',
      );
      return 2;
    }
  }
  try {
    await version(features, jsonOutput);
    return 0;
  } catch (e) {
    if (e instanceof CliExit) return e.code;
    throw e;
  }
}
