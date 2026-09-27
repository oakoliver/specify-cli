/**
 * @oakoliver/specify-cli - `specify self check`
 *
 * Port of spec-kit `selfs/command_check.py` (v1.0.12). Read-only: reports
 * whether a newer @oakoliver/specify-cli release is available on npm.
 *
 * @module selfs/check
 */

import { console } from '../console.js';
import {
  MANUAL_TAG_PLACEHOLDER,
  isNewer,
  manualInstallCommands,
  manualTagOrPlaceholder,
  normalizeTag,
  versionDeps,
} from '../version.js';

// ============================================================================
// Command
// ============================================================================

function printManualFallback(tag: string | null): void {
  console.print('\nManual fallback:');
  // ADAPTATION: upstream prints `uv tool install specify-cli --force --from
  // git+https://github.com/github/spec-kit.git@<tag>` and `pipx install --force ...`.
  for (const line of manualInstallCommands(tag)) console.print(`  ${line}`);
}

/** Check whether a newer release is available. Read-only; always exits 0. */
export async function selfCheck(): Promise<number> {
  const installed = versionDeps.getInstalledVersion();
  const [tag, failureReason] = await versionDeps.fetchLatestReleaseTag();

  if (tag === null) {
    console.print(`Installed: ${installed}`);
    console.print(`[yellow]Could not check latest release:[/yellow] ${failureReason}`);
    return 0;
  }

  const manualTag = manualTagOrPlaceholder(tag);
  const latestDisplay = manualTag || MANUAL_TAG_PLACEHOLDER;

  if (manualTag === null) {
    if (installed === 'unknown') {
      console.print('Current version could not be determined.');
    } else {
      console.print(`Installed: ${installed}`);
    }
    console.print(`Latest release: ${latestDisplay}`);
    // ADAPTATION: upstream says "from GitHub."
    console.print('[yellow]Could not validate latest release tag from the npm registry.[/yellow]');
    printManualFallback(manualTag);
    return 0;
  }

  if (installed === 'unknown') {
    console.print('Current version could not be determined.');
    console.print(`Latest release: ${latestDisplay}`);
    printManualFallback(manualTag);
    console.print('\nIf this install can still be detected:');
    console.print('  specify self upgrade');
    return 0;
  }

  if (isNewer(normalizeTag(manualTag), installed)) {
    console.print(`[green]Update available:[/green] ${installed} → ${latestDisplay}`);
    console.print('\nTo upgrade:');
    console.print('  specify self upgrade');
    printManualFallback(manualTag);
    return 0;
  }

  console.print(`[green]Up to date:[/green] ${installed}`);
  return 0;
}
