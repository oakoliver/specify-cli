#!/usr/bin/env node
/**
 * @oakoliver/specify-cli - CLI Entry Point
 *
 * Root command app — port of the Typer `app` assembled in upstream
 * spec-kit `specify_cli/__init__.py` (v1.0.12). Every sub-command is
 * implemented in its own domain module; this file only wires them up.
 *
 * Usage: specify <command> [options]
 *
 * @module cli
 */

import { console, showBanner } from './console.js';
import { dispatchGroup, formatGroupHelp, type GroupSpec } from './cli-args.js';
import { printVersion, showRootBanner } from './app.js';
import { runInitCommand } from './init.js';
import { runCheckCommand } from './command-check.js';
import { runVersionCommand } from './command-version.js';
import { runSelfCommand } from './selfs/commands.js';
import { runExtensionCommand } from './extensions/commands.js';
import { runIntegrationCommand } from './integrations/commands.js';
import { runEventCommand } from './events/commands.js';
import { runPresetCommand } from './presets/commands.js';
import { runArtifactCommand } from './artifacts/commands.js';
import { runBundleCommand } from './bundles/commands.js';
import { runWorkflowCommand } from './workflows/commands.js';
import { runDoctorCommand, runStatusCommand } from './doctor.js';

// ============================================================================
// Root App
// ============================================================================

/** Root command group (mirrors upstream registration order). */
export const ROOT_APP: GroupSpec = {
  name: 'specify',
  help: 'Setup tool for Specify spec-driven development projects',
  options: [{ name: 'version', flags: ['--version', '-V'], type: 'boolean', help: 'Show version and exit.' }],
  commands: [
    { name: 'init', help: 'Initialize a new Specify project.', run: (a) => runInitCommand(a) },
    { name: 'check', help: 'Check that all required tools are installed.', run: (a) => runCheckCommand(a) },
    { name: 'version', help: 'Display version and system information.', run: (a) => runVersionCommand(a) },
    {
      name: 'self',
      help: 'Manage the specify CLI itself: check for newer releases, preview upgrades with --dry-run, and upgrade in place.',
      run: (a) => runSelfCommand(a),
    },
    { name: 'extension', help: 'Manage spec-kit extensions', run: (a) => runExtensionCommand(a) },
    { name: 'integration', help: 'Manage coding agent integrations', run: (a) => runIntegrationCommand(a) },
    { name: 'event', help: 'Manage and execute event-driven commands', run: (a) => runEventCommand(a) },
    { name: 'preset', help: 'Manage spec-kit presets', run: (a) => runPresetCommand(a) },
    {
      name: 'artifact',
      help: 'Introspect commands, templates, scripts, and hooks Spec Kit exposes.',
      run: (a) => runArtifactCommand(a),
    },
    { name: 'bundle', help: 'Discover, install, and author Spec Kit bundles', run: (a) => runBundleCommand(a) },
    { name: 'workflow', help: 'Manage and run automation workflows', run: (a) => runWorkflowCommand(a) },
    // Port-specific additions (not in upstream spec-kit).
    { name: 'doctor', help: 'Diagnose issues with the project setup (specify-cli addition).', run: (a) => runDoctorCommand(a) },
    { name: 'status', help: 'Show project status overview (specify-cli addition).', run: (a) => runStatusCommand(a) },
  ],
};

// ============================================================================
// Main
// ============================================================================

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  // Root eager options (upstream `_version_callback` / BannerGroup help).
  if (argv[0] === '--version' || argv[0] === '-V') {
    printVersion();
    return 0;
  }
  if (argv.length === 0) {
    // Upstream root callback: banner + usage hint when no sub-command given.
    showRootBanner(argv);
    return 0;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    showBanner();
    console.write(formatGroupHelp(ROOT_APP, 'specify'));
    return 0;
  }
  return dispatchGroup(ROOT_APP, argv, 'specify');
}

// Run only when executed directly (not when imported by tests).
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1] ?? '';
    return /(?:^|[\\/])(?:cli\.(?:ts|js)|specify)$/.test(entry) || entry.endsWith('/bin/specify');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // Exit quietly when output is piped into a consumer that closes early (e.g. `| head`).
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') process.exit(0);
      throw err;
    });
  }
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Error: ${msg}\n`);
      process.exitCode = 1;
    });
}
