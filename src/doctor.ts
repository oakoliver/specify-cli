/**
 * @oakoliver/specify-cli - Doctor & Status Commands
 *
 * Port-specific diagnostics (not present in upstream spec-kit). Since the
 * v1.0.12 sync these are thin views over the upstream-parity modules:
 * integration state/status (`integration-status.ts`), extension and preset
 * managers, and the workflow registry.
 *
 * @module doctor
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { console, escapeMarkup } from './console.js';
import { getSpeckitVersion } from './assets.js';
import { loadInitOptions } from './init-options.js';
import { buildIntegrationStatusReport } from './integration-status.js';
import { ExtensionManager } from './extensions/index.js';
import { PresetManager } from './presets/index.js';
import { resolveInitDirOverride } from './project.js';
import { UPSTREAM_SPEC_KIT_VERSION } from './version.js';

// ============================================================================
// Helpers
// ============================================================================

/** Locate the project root: SPECIFY_INIT_DIR override, else walk up from cwd. */
export function findSpecifyRoot(startDir: string = process.cwd()): string | null {
  const override = resolveInitDirOverride();
  if (override) return override;
  let current = startDir;
  for (;;) {
    if (existsSync(join(current, '.specify'))) return current;
    const parent = join(current, '..');
    if (parent === current) return null;
    current = parent;
  }
}

function countEntries(dir: string, dirsOnly = false): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(
      (d) => !d.name.startsWith('.') && (!dirsOnly || d.isDirectory()),
    ).length;
  } catch {
    return 0;
  }
}

// ============================================================================
// Doctor
// ============================================================================

/**
 * `specify doctor` — diagnose the project's health. Returns exit code 1 when
 * errors are found, 0 otherwise (warnings do not fail).
 */
export async function runDoctorCommand(args: string[] = []): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.print('Usage: specify doctor\n\n Diagnose issues with the Spec Kit project in the current directory.');
    return 0;
  }
  console.print('[bold]Spec Kit Doctor[/bold]\n');
  const root = findSpecifyRoot();
  if (!root) {
    console.print('[red]Error:[/red] Not a Spec Kit project (no .specify/ directory)');
    console.print('Run "specify init" first, or set SPECIFY_INIT_DIR to a project root.');
    return 1;
  }
  let issues = 0;
  let warnings = 0;
  const ok = (msg: string): void => console.print(`[green]✓[/green] ${msg}`);
  const warn = (msg: string): void => {
    warnings++;
    console.print(`[yellow]⚠[/yellow] ${msg}`);
  };
  const err = (msg: string): void => {
    issues++;
    console.print(`[red]✗[/red] ${msg}`);
  };

  ok(`Found Spec Kit project at: [dim]${escapeMarkup(root)}[/dim]`);

  for (const dir of ['.specify/templates', '.specify/scripts', '.specify/memory']) {
    if (existsSync(join(root, dir))) ok(`Directory exists: [dim]${dir}[/dim]`);
    else err(`Missing directory: ${dir}`);
  }

  const opts = loadInitOptions(root);
  if (Object.keys(opts).length > 0) {
    ok(
      `Init options: integration=${escapeMarkup(String(opts.integration ?? opts.ai ?? 'unknown'))}, ` +
        `script=${escapeMarkup(String(opts.script ?? 'sh'))}`,
    );
  } else {
    warn('No .specify/init-options.json found (project may need re-init)');
  }

  const report = buildIntegrationStatusReport(root);
  for (const key of report.installed_integrations) {
    const m = report.manifests[key];
    const tracked = m ? m.tracked_files : 0;
    ok(`Integration ${escapeMarkup(key)}: ${tracked} tracked file(s)`);
  }
  for (const f of report.findings) {
    const line = escapeMarkup(f.message) + (f.suggestion ? ` [dim](${escapeMarkup(f.suggestion)})[/dim]` : '');
    if (f.severity === 'error') err(line);
    else warn(line);
  }

  try {
    const exts = new ExtensionManager(root).listInstalled();
    ok(`Extensions: ${exts.length} installed (${exts.filter((e) => e.enabled).length} enabled)`);
  } catch (e) {
    err(`Extension registry unreadable: ${escapeMarkup((e as Error).message)}`);
  }
  try {
    const presets = new PresetManager(root).listInstalled();
    ok(`Presets: ${presets.length} installed (${presets.filter((p) => p.enabled).length} enabled)`);
  } catch (e) {
    err(`Preset registry unreadable: ${escapeMarkup((e as Error).message)}`);
  }

  if (existsSync(join(root, '.git'))) ok('Git repository initialized');
  else warn('No git repository (consider running "git init" or "specify extension add git")');

  console.print('\n[dim]' + '─'.repeat(50) + '[/dim]');
  if (issues === 0 && warnings === 0) {
    console.print('[green]No issues found! Your Spec Kit project is healthy.[/green]');
    return 0;
  }
  if (issues === 0) {
    console.print(`[yellow]${warnings} warning(s), 0 issues. Project is functional.[/yellow]`);
    return 0;
  }
  console.print(
    `[red]${issues} issue(s), ${warnings} warning(s).[/red] See 'specify integration status' for details.`,
  );
  return 1;
}

// ============================================================================
// Status
// ============================================================================

/** `specify status` — project overview. */
export async function runStatusCommand(args: string[] = []): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.print('Usage: specify status\n\n Show an overview of the Spec Kit project in the current directory.');
    return 0;
  }
  const root = findSpecifyRoot();
  if (!root) {
    console.print('[red]Error:[/red] Not a Spec Kit project (no .specify/ directory)');
    return 1;
  }
  const opts = loadInitOptions(root);
  const report = buildIntegrationStatusReport(root);

  console.print('[bold]Project Status[/bold]\n');
  console.print(`[dim]Project Root:[/dim] ${escapeMarkup(root)}`);
  console.print(`[dim]Integration: [/dim] ${escapeMarkup(String(report.default_integration ?? opts.integration ?? 'unknown'))}`);
  console.print(`[dim]Scripts:     [/dim] ${escapeMarkup(String(opts.script ?? 'sh'))}`);
  console.print(`[dim]Initialized: [/dim] ${escapeMarkup(String(opts.speckit_version ?? 'unknown'))}`);
  console.print(`[dim]CLI Version: [/dim] ${getSpeckitVersion()} (spec-kit ${UPSTREAM_SPEC_KIT_VERSION} parity)`);

  console.print('\n[bold]Integrations[/bold]');
  if (report.installed_integrations.length === 0) {
    console.print('[dim]  No integrations installed.[/dim]');
  }
  for (const key of report.installed_integrations) {
    const m = report.manifests[key];
    const isDefault = key === report.default_integration ? ' [dim](default)[/dim]' : '';
    console.print(`  [green]●[/green] ${escapeMarkup(key)}${isDefault} [dim]${m ? m.tracked_files : 0} files[/dim]`);
  }
  console.print(`[dim]  Health: ${report.status}[/dim]`);

  console.print('\n[bold]Extensions[/bold]');
  let exts: { id: string; version: string; enabled: boolean }[] = [];
  try {
    exts = new ExtensionManager(root).listInstalled();
  } catch {
    /* unreadable registry: reported by doctor */
  }
  if (exts.length === 0) console.print('[dim]  No extensions installed.[/dim]');
  for (const e of exts) {
    console.print(`  ${e.enabled ? '[green]●[/green]' : '[dim]○[/dim]'} ${escapeMarkup(e.id)} v${escapeMarkup(String(e.version))}`);
  }

  console.print('\n[bold]Presets[/bold]');
  let presets: { id: string; version: string; enabled: boolean }[] = [];
  try {
    presets = new PresetManager(root).listInstalled();
  } catch {
    /* unreadable registry: reported by doctor */
  }
  if (presets.length === 0) console.print('[dim]  No presets installed.[/dim]');
  for (const p of presets) {
    console.print(`  ${p.enabled ? '[green]●[/green]' : '[dim]○[/dim]'} ${escapeMarkup(p.id)} v${escapeMarkup(String(p.version))}`);
  }

  console.print('\n[bold]Workflows[/bold]');
  console.print(`[dim]  Installed:[/dim] ${countEntries(join(root, '.specify', 'workflows'), true) - (existsSync(join(root, '.specify', 'workflows', 'runs')) ? 1 : 0)}`);
  console.print(`[dim]  Runs:     [/dim] ${countEntries(join(root, '.specify', 'workflows', 'runs'), true)}`);

  console.print('\n[bold]Memory[/bold]');
  console.print(`[dim]  Files:[/dim] ${countEntries(join(root, '.specify', 'memory'))}`);
  console.print('');
  return 0;
}
