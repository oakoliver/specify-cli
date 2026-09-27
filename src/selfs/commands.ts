/**
 * @oakoliver/specify-cli - `specify self` command group
 *
 * Port of spec-kit `selfs/__init__.py` (the nested Typer app). Dispatches
 * `specify self check` and `specify self upgrade [--dry-run] [--tag vX.Y.Z]`.
 *
 * @module selfs/commands
 */

import { CliExit } from '../console.js';
import { selfCheck } from './check.js';
import { selfUpgrade } from './upgrade.js';

export { selfCheck } from './check.js';
export { selfUpgrade } from './upgrade.js';

// ============================================================================
// Help text (mirrors upstream Typer docstrings/option help)
// ============================================================================

export const SELF_HELP = `Usage: specify self [OPTIONS] COMMAND [ARGS]...

  Manage the specify CLI itself: check for newer releases, preview upgrades
  with --dry-run, and upgrade in place.

Options:
  --help  Show this message and exit.

Commands:
  check    Check whether a newer specify-cli release is available. Read-only.
  upgrade  Upgrade specify-cli to the latest release (or a pinned --tag).
`;

export const SELF_CHECK_HELP = `Usage: specify self check [OPTIONS]

  Check whether a newer specify-cli release is available. Read-only.

  This command only checks for updates; it does not modify your installation.
  Use \`specify self upgrade\` to actually perform the upgrade once you've seen
  the result here, or \`specify self upgrade --dry-run\` to preview the
  installer command without running it.

Options:
  --help  Show this message and exit.
`;

export const SELF_UPGRADE_HELP = `Usage: specify self upgrade [OPTIONS]

  Upgrade specify-cli to the latest release (or a pinned --tag).

  Bare invocation executes immediately with no confirmation prompt, matching
  npm install -g / bun add -g / pnpm add -g conventions. Use --dry-run to
  preview without mutating anything. See \`specify self check\` for the
  non-destructive read-only counterpart.

  Detection classifies the runtime into npm (global) / pnpm (global) /
  bun (global) / yarn (global) / npx (ephemeral) / source-checkout /
  unsupported. Only the global package-manager installs are upgraded
  automatically; the other three paths print path-specific guidance and
  exit 0.

  Exit codes:
    0      success or no-op-success (already on latest, --dry-run, or
           non-upgradable path with guidance shown)
    1      target-tag resolution failure or --tag regex validation failure
    2      verification mismatch when the installer exited 0 but
           \`specify --version\` does not resolve to the target tag; if the
           installer itself exits 2, that installer failure code is
           propagated verbatim
    3      installer binary not found on PATH, or resolved installer path is
           missing / non-executable
    124    internal installer timeout when SPECIFY_UPGRADE_TIMEOUT_SECS is set,
           or a real installer exit code 124 propagated verbatim; scripts
           should treat 124 as ambiguous and inspect the failure message
    other  installer exit code propagated verbatim

  Environment variables:
    SPECIFY_UPGRADE_TIMEOUT_SECS  Optional integer/float seconds. Caps how
      long the installer subprocess may run. Unset (default) means no
      timeout — interrupt with Ctrl+C if the installer hangs.

Options:
  --dry-run   Print the preview (method, current, target, installer argv) and
              exit 0 without launching the installer subprocess.
  --tag TEXT  Pin the target version (vX.Y.Z[suffix]). Without --tag, the
              latest stable release is resolved via the npm registry.
  --help      Show this message and exit.
`;

// ============================================================================
// Dispatcher
// ============================================================================

function usageError(usage: string, message: string): number {
  process.stderr.write(`${usage}\nTry 'specify self --help' for help.\n\nError: ${message}\n`);
  return 2;
}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Entry point for `specify self ...` (args exclude the word `self`). */
export async function runSelfCommand(args: string[]): Promise<number> {
  try {
    const [sub, ...rest] = args;
    if (sub === undefined) {
      return usageError('Usage: specify self [OPTIONS] COMMAND [ARGS]...', 'Missing command.');
    }
    if (sub === '--help' || sub === '-h') {
      out(SELF_HELP);
      return 0;
    }

    if (sub === 'check') {
      if (rest.includes('--help') || rest.includes('-h')) {
        out(SELF_CHECK_HELP);
        return 0;
      }
      if (rest.length > 0) {
        const extra = rest[0];
        return usageError(
          'Usage: specify self check [OPTIONS]',
          extra.startsWith('-') ? `No such option: ${extra}` : `Got unexpected extra argument (${extra})`,
        );
      }
      return await selfCheck();
    }

    if (sub === 'upgrade') {
      if (rest.includes('--help') || rest.includes('-h')) {
        out(SELF_UPGRADE_HELP);
        return 0;
      }
      let dryRun = false;
      let tag: string | null = null;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--dry-run') {
          dryRun = true;
        } else if (a === '--tag') {
          if (i + 1 >= rest.length) {
            return usageError('Usage: specify self upgrade [OPTIONS]', "Option '--tag' requires an argument.");
          }
          tag = rest[++i];
        } else if (a.startsWith('--tag=')) {
          tag = a.slice('--tag='.length);
        } else if (a.startsWith('-')) {
          return usageError('Usage: specify self upgrade [OPTIONS]', `No such option: ${a}`);
        } else {
          return usageError('Usage: specify self upgrade [OPTIONS]', `Got unexpected extra argument (${a})`);
        }
      }
      return await selfUpgrade({ dryRun, tag });
    }

    return usageError(
      'Usage: specify self [OPTIONS] COMMAND [ARGS]...',
      `No such command '${sub}'.`,
    );
  } catch (e) {
    if (e instanceof CliExit) return e.code;
    throw e;
  }
}
