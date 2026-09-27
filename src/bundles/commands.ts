/**
 * @oakoliver/specify-cli - ``specify bundle`` commands
 *
 * CLI adapter for the bundle command group (``search``, ``info``, ``list``,
 * ``install``, ``add``, ``update``, ``remove``, ``validate``, ``build``,
 * ``init``) and the nested ``catalog`` group (``list``, ``add``, ``remove``).
 * Domain behavior lives in the CLI-free modules of this package.
 *
 * Port of ``specify_cli/bundles/_commands.py``, ``command_*.py`` and
 * ``bundles/catalog/*.py``.
 *
 * @module bundles/commands
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { console, errConsole, escapeMarkup, CliExit } from '../console.js';
import { defineCommand, dispatchGroup, type GroupSpec, type ParsedArgs } from '../cli-args.js';
import { BundlerError } from './index.js';
import { activeIntegration, findProjectRoot, requireProjectRoot } from './project.js';
import { loadRecords } from './records.js';
import { detectConflicts } from './conflict.js';
import { CatalogStack, type ResolvedBundle } from './catalog-stack.js';
import { Scope, loadSourceStack } from './catalogs.js';
import { addSource, removeSource } from './catalog-config.js';
import { BundleManifest } from './manifest.js';
import { resolveInstallPlan } from './resolver.js';
import { installBundle, removeBundle, type PrimitiveInstaller } from './installer.js';
import { validateManifest } from './validator.js';
import { makeReferenceChecker } from './references.js';
import { buildBundle } from './packager.js';
import { DefaultPrimitiveInstaller, makeCatalogFetcher } from './adapters.js';
import { downloadManifest, localManifestSource, validateManifestStructure } from './sources.js';
import { pyJsonDumps, pyRepr, resolvePath } from './pycompat.js';

// ============================================================================
// Injectable seams (tests replace entries)
// ============================================================================

export const commandDeps = {
  downloadManifest: (resolved: ResolvedBundle, opts: { offline: boolean }): Promise<BundleManifest> =>
    downloadManifest(resolved, opts),
  makeInstaller: (opts: { allowNetwork: boolean }): PrimitiveInstaller => new DefaultPrimitiveInstaller(opts),
  async speckitVersion(): Promise<string> {
    const mod = await import('../assets.js');
    return mod.getSpeckitVersion();
  },
  /** Scaffold a project via ``specify init --here --force`` (non-interactive). */
  async runInitCommand(args: string[]): Promise<number | void> {
    const mod = await import('../init.js');
    return mod.runInitCommand(args);
  },
  async resolveDefaultInitIntegration(): Promise<string> {
    const mod = await import('../agent-config.js');
    return mod.resolveDefaultInitIntegration();
  },
  userConfigDir(): string {
    // User-scope Spec Kit config lives under ~/.specify.
    return path.join(homedir(), '.specify');
  },
  /** ``os.name == "nt"`` equivalent. */
  isWindows(): boolean {
    return process.platform === 'win32';
  },
};

// ============================================================================
// Shared infrastructure (port of _commands.py)
// ============================================================================

/** Print an actionable error to stderr and exit non-zero. */
function fail(message: string): never {
  // stderr keeps --json stdout parseable; escape untrusted text so '[...]' is
  // never parsed as markup.
  errConsole.print(`[red]Error:[/red] ${escapeMarkup(message)}`);
  throw new CliExit(1);
}

function failFrom(exc: unknown): never {
  if (exc instanceof BundlerError) fail(exc.message);
  throw exc;
}

function buildStack(projectRoot: string, opts: { offline: boolean }): CatalogStack {
  const fetcher = makeCatalogFetcher({ allowNetwork: !opts.offline });
  return CatalogStack.load(projectRoot, fetcher, commandDeps.userConfigDir());
}

/** Trust framing for a catalog entry (FR-010): org-curated vs community. */
function trustLevel(verified: boolean): string {
  return verified ? 'verified' : 'community';
}

function trustBadge(verified: boolean): string {
  return verified ? '[green]✔ verified[/green]' : '[yellow]community[/yellow]';
}

/** OS-appropriate default script flavor (FR-013). */
function defaultScriptType(): string {
  return commandDeps.isWindows() ? 'ps' : 'sh';
}

/**
 * Idempotently scaffold a Spec Kit project here via the existing ``init``
 * machinery (``--here --force``, non-interactive).
 */
async function runInit(integration: string, opts: { scriptType: string; offline?: boolean }): Promise<void> {
  const args = [
    '--here',
    '--force',
    '--ignore-agent-tools',
    '--non-interactive',
    '--script',
    opts.scriptType,
    '--integration',
    integration,
  ];
  if (opts.offline) args.push('--offline');
  let code: number | void;
  try {
    code = await commandDeps.runInitCommand(args);
  } catch (exc) {
    if (!(exc instanceof CliExit)) throw exc;
    code = exc.code;
  }
  if (typeof code === 'number' && code !== 0) {
    throw new BundlerError(`Failed to initialize a Spec Kit project (integration '${integration}').`);
  }
}

/** Precedence (FR-013): explicit override -> bundle-declared -> default. */
async function resolveInitIntegration(override: string | null, manifest: BundleManifest | null): Promise<string> {
  if (override) return override;
  if (manifest !== null && manifest.integration !== null) return manifest.integration.id;
  return commandDeps.resolveDefaultInitIntegration();
}

/** Return informational overlaps between *manifest* and installed bundles. */
function bundleOverlaps(projectRoot: string, manifest: BundleManifest | null): string[] {
  if (manifest === null) return [];
  try {
    const report = detectConflicts(manifest, activeIntegration(projectRoot), loadRecords(projectRoot));
    return [...report.overlaps];
  } catch (exc) {
    if (exc instanceof BundlerError) return [];
    throw exc;
  }
}

function printJson(payload: unknown): void {
  process.stdout.write(pyJsonDumps(payload) + '\n');
}

function optStr(parsed: ParsedArgs, key: string): string | null {
  const value = parsed.options[key];
  return typeof value === 'string' ? value : null;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// ============================================================================
// bundle search
// ============================================================================

export async function bundleSearch(query: string, opts: { offline: boolean; asJson: boolean }): Promise<void> {
  let results: ResolvedBundle[];
  try {
    const projectRoot = findProjectRoot() ?? process.cwd();
    const stack = buildStack(projectRoot, { offline: opts.offline });
    results = await stack.search(query);
  } catch (exc) {
    failFrom(exc);
  }

  if (opts.asJson) {
    printJson(
      results.map((r) => ({
        id: r.entry.id,
        name: r.entry.name,
        role: r.entry.role,
        version: r.entry.version,
        description: r.entry.description,
        source: r.source.id,
        install_policy: r.source.install_policy,
        verified: r.entry.verified,
        trust: trustLevel(r.entry.verified),
      })),
    );
    return;
  }

  if (!results.length) {
    console.print('[yellow]No matching bundles found.[/yellow]');
    return;
  }

  console.print('\n[bold cyan]Bundles:[/bold cyan]\n');
  for (const r of results) {
    const policy = !r.source.installAllowed ? '[dim](discovery-only)[/dim]' : '';
    console.print(
      `  [bold]${escapeMarkup(r.entry.id)}[/bold] ` +
        `v${escapeMarkup(r.entry.version)} — ` +
        `${escapeMarkup(r.entry.name)} ` +
        `[dim](${escapeMarkup(r.entry.role)})[/dim] ` +
        `${trustBadge(r.entry.verified)} ${policy}`,
    );
    console.print(`    ${escapeMarkup(r.entry.description)}`);
    console.print(`    [dim]source: ${escapeMarkup(r.source.id)}[/dim]`);
  }
}

// ============================================================================
// bundle info
// ============================================================================

interface ComponentView {
  kind: string;
  id: string;
  version: string | null;
  priority?: number;
  strategy?: string;
}

/** Flatten a manifest's components to JSON-friendly dicts. */
function manifestComponentView(manifest: BundleManifest | null): ComponentView[] {
  if (manifest === null) return [];
  return manifest.components.map((component) => {
    const item: ComponentView = { kind: component.kind, id: component.id, version: component.version };
    if (component.priority !== null) item.priority = component.priority;
    if (component.strategy !== null) item.strategy = component.strategy;
    return item;
  });
}

function formatComponent(item: ComponentView): string {
  let label = item.version ? `${item.id} v${item.version}` : item.id;
  const extras: string[] = [];
  if (item.priority !== undefined && item.priority !== null) extras.push(`priority=${item.priority}`);
  if (item.strategy !== undefined && item.strategy !== null) extras.push(`strategy=${item.strategy}`);
  if (extras.length) label += ` (${extras.join(', ')})`;
  return label;
}

export async function bundleInfo(bundleId: string, opts: { offline: boolean; asJson: boolean }): Promise<void> {
  let projectRoot: string;
  let resolved: ResolvedBundle;
  let manifest: BundleManifest;
  try {
    projectRoot = findProjectRoot() ?? process.cwd();
    const stack = buildStack(projectRoot, { offline: opts.offline });
    resolved = await stack.resolve(bundleId);
    // `info` must show the fully expanded component set that `install` would
    // apply; if the manifest can't be resolved, fail loudly.
    manifest = await commandDeps.downloadManifest(resolved, { offline: opts.offline });
  } catch (exc) {
    failFrom(exc);
  }

  const overlaps = bundleOverlaps(projectRoot, manifest);
  const components = manifestComponentView(manifest);

  const entry = resolved.entry;
  if (opts.asJson) {
    printJson({
      id: entry.id,
      name: entry.name,
      version: entry.version,
      role: entry.role,
      description: entry.description,
      author: entry.author,
      license: entry.license,
      source: resolved.source.id,
      install_policy: resolved.source.install_policy,
      provides: entry.provides,
      requires: { speckit_version: entry.requires_speckit_version },
      verified: entry.verified,
      trust: trustLevel(entry.verified),
      integration: manifest && manifest.integration ? manifest.integration.id : null,
      components,
      overlaps,
    });
    return;
  }

  console.print(
    `\n[bold cyan]${escapeMarkup(entry.id)}[/bold cyan] ` +
      `v${escapeMarkup(entry.version)} — ` +
      `${escapeMarkup(entry.name)}`,
  );
  console.print(`  Role: ${escapeMarkup(entry.role)}`);
  console.print(`  ${escapeMarkup(entry.description)}`);
  console.print(`  Author: ${escapeMarkup(entry.author)}   License: ${escapeMarkup(entry.license)}`);
  console.print(`  Source: ${escapeMarkup(resolved.source.id)} (${resolved.source.install_policy})`);
  console.print(`  Trust: ${trustBadge(entry.verified)}`);
  if (entry.requires_speckit_version) {
    console.print(`  Requires Spec Kit: ${escapeMarkup(entry.requires_speckit_version)}`);
  }
  if (manifest && manifest.integration) {
    console.print(`  Integration: ${escapeMarkup(manifest.integration.id)}`);
  }

  if (components.length) {
    console.print('\n  [bold]Components[/bold] (added on install):');
    for (const kind of ['extensions', 'presets', 'steps', 'workflows']) {
      const items = components.filter((c) => c.kind === kind);
      if (!items.length) continue;
      console.print(`    [bold]${kind}:[/bold]`);
      for (const item of items) console.print(`      - ${escapeMarkup(formatComponent(item))}`);
    }
  } else {
    console.print('\n  [bold]Provides:[/bold]');
    for (const kind of ['extensions', 'presets', 'steps', 'workflows']) {
      const count = entry.provides[kind] ?? 0;
      if (count) console.print(`    ${kind}: ${escapeMarkup(String(count))}`);
    }
  }

  if (overlaps.length) {
    console.print('\n  [yellow]Overlaps with already-installed bundles:[/yellow]');
    for (const overlap of overlaps) console.print(`    [yellow]-[/yellow] ${escapeMarkup(overlap)}`);
  }

  if (!resolved.installAllowed) {
    console.print(
      '\n  [yellow]This source is discovery-only; the bundle cannot be installed from here.[/yellow]',
    );
  }
}

// ============================================================================
// bundle list
// ============================================================================

export async function bundleList(opts: { asJson: boolean }): Promise<void> {
  let records;
  try {
    const projectRoot = requireProjectRoot();
    records = loadRecords(projectRoot);
  } catch (exc) {
    failFrom(exc);
  }

  if (opts.asJson) {
    printJson(records.map((r) => r.toDict()));
    return;
  }

  if (!records.length) {
    console.print('[yellow]No bundles installed.[/yellow]');
    console.print('\nInstall one with: [cyan]specify bundle install <id>[/cyan]');
    return;
  }

  console.print('\n[bold cyan]Installed bundles:[/bold cyan]\n');
  for (const record of records) {
    console.print(
      `  [bold]${escapeMarkup(record.bundle_id)}[/bold] ` +
        `v${escapeMarkup(record.version)} ` +
        `[dim](${record.contributed_components.length} components, ` +
        `installed ${escapeMarkup(record.installed_at)})[/dim]`,
    );
  }
}

// ============================================================================
// bundle install / add
// ============================================================================

export async function bundleInstall(
  bundleId: string,
  opts: { integration?: string | null; offline?: boolean; refresh?: boolean } = {},
): Promise<void> {
  const integration = opts.integration ?? null;
  const offline = opts.offline ?? false;
  const refresh = opts.refresh ?? false;
  let result;
  try {
    let projectRoot = findProjectRoot();

    let manifest: BundleManifest;
    const localManifest = await localManifestSource(bundleId);
    if (localManifest !== null) {
      manifest = localManifest;
      validateManifestStructure(manifest, { source: `Local bundle source ${pyRepr(bundleId)}` });
    } else {
      const stack = buildStack(projectRoot ?? process.cwd(), { offline });
      const resolved = await stack.resolve(bundleId);
      if (!resolved.installAllowed) {
        throw new BundlerError(
          `Bundle '${bundleId}' resolves only from a discovery-only source ` +
            `('${resolved.source.id}'); it cannot be installed from there.`,
        );
      }
      manifest = await commandDeps.downloadManifest(resolved, { offline });
    }

    if (projectRoot === null) {
      const initIntegration = await resolveInitIntegration(integration, manifest);
      // Resolve all hard compatibility gates before `specify init` so an
      // incompatible bundle never leaves an initialized project behind.
      resolveInstallPlan(manifest, {
        speckitVersion: await commandDeps.speckitVersion(),
        activeIntegration: initIntegration,
        integrationExplicit: true,
      });
      console.print(
        `[cyan]No Spec Kit project here; initializing with integration ` +
          `'${escapeMarkup(initIntegration)}'…[/cyan]`,
      );
      await runInit(initIntegration, { scriptType: defaultScriptType(), offline });
      projectRoot = requireProjectRoot();
    }

    for (const overlap of bundleOverlaps(projectRoot, manifest)) {
      console.print(`[yellow]![/yellow] ${escapeMarkup(overlap)}`);
    }

    // The project's recorded active integration is authoritative; an explicit
    // --integration only confirms the target when it cannot be determined.
    const detected = activeIntegration(projectRoot);
    const plan = resolveInstallPlan(manifest, {
      speckitVersion: await commandDeps.speckitVersion(),
      activeIntegration: detected !== null ? detected : integration,
      integrationExplicit: Boolean(integration) && detected === null,
    });
    for (const warning of plan.warnings) console.print(`[yellow]![/yellow] ${escapeMarkup(warning)}`);

    result = await installBundle(
      projectRoot,
      plan,
      commandDeps.makeInstaller({ allowNetwork: !offline }),
      manifest,
      refresh,
    );
  } catch (exc) {
    failFrom(exc);
  }

  const refreshSummary = refresh
    ? `, ${result.refreshed.length} refreshed, ${result.uninstalled.length} removed`
    : '';
  console.print(
    `[green]✓[/green] Installed '${escapeMarkup(result.bundle_id)}' ` +
      `(${result.installed.length} added, ${result.skipped.length} already present` +
      `${refreshSummary}).`,
  );
}

// ============================================================================
// bundle update
// ============================================================================

export async function bundleUpdate(
  bundleId: string | null,
  opts: { all?: boolean; integration?: string | null; offline?: boolean } = {},
): Promise<void> {
  const allBundles = opts.all ?? false;
  const integration = opts.integration ?? null;
  const offline = opts.offline ?? false;
  try {
    const projectRoot = requireProjectRoot();
    const records = loadRecords(projectRoot);
    if (!allBundles && !bundleId) throw new BundlerError('Specify a bundle id or use --all.');
    const targets = allBundles ? records.map((r) => r.bundle_id) : [bundleId as string];
    if (!targets.length) {
      console.print('[yellow]No installed bundles to update.[/yellow]');
      return;
    }

    const stack = buildStack(projectRoot, { offline });
    const installer = commandDeps.makeInstaller({ allowNetwork: !offline });
    for (const target of targets) {
      if (!records.some((r) => r.bundle_id === target)) {
        throw new BundlerError(`Bundle '${target}' is not installed.`);
      }
      const resolved = await stack.resolve(target);
      if (!resolved.installAllowed) {
        throw new BundlerError(
          `Bundle '${target}' resolves only from a discovery-only source ` +
            `('${resolved.source.id}'); it cannot be updated from there. ` +
            'Update requires an install-allowed source (FR-025).',
        );
      }
      const manifest = await commandDeps.downloadManifest(resolved, { offline });
      const detected = activeIntegration(projectRoot);
      const plan = resolveInstallPlan(manifest, {
        speckitVersion: await commandDeps.speckitVersion(),
        activeIntegration: detected !== null ? detected : integration,
        integrationExplicit: Boolean(integration) && detected === null,
      });
      await installBundle(projectRoot, plan, installer, manifest, true);
      console.print(`[green]✓[/green] Updated '${escapeMarkup(target)}' to v${escapeMarkup(plan.version)}.`);
    }
  } catch (exc) {
    failFrom(exc);
  }
}

// ============================================================================
// bundle remove
// ============================================================================

export async function bundleRemove(bundleId: string): Promise<void> {
  let result;
  try {
    const projectRoot = requireProjectRoot();
    result = await removeBundle(projectRoot, bundleId, commandDeps.makeInstaller({ allowNetwork: true }));
  } catch (exc) {
    failFrom(exc);
  }
  console.print(
    `[green]✓[/green] Removed '${escapeMarkup(result.bundle_id)}' ` +
      `(${result.uninstalled.length} uninstalled, ${result.skipped.length} kept for other bundles).`,
  );
}

// ============================================================================
// bundle validate
// ============================================================================

function resolveManifestPath(p: string | null): string {
  let target = resolvePath(p || process.cwd());
  if (isDir(target)) target = path.join(target, 'bundle.yml');
  if (!isFile(target) && !isDir(target)) {
    throw new BundlerError(`No bundle.yml found at '${target}'.`);
  }
  return target;
}

export async function bundleValidate(opts: { path?: string | null; offline?: boolean } = {}): Promise<void> {
  let report;
  let manifest: BundleManifest;
  try {
    const manifestPath = resolveManifestPath(opts.path ?? null);
    manifest = BundleManifest.fromFile(manifestPath);
    const refRoot = findProjectRoot(path.dirname(manifestPath)) ?? process.cwd();
    const refWarnings: string[] = [];
    const checker = makeReferenceChecker(refRoot, { allowNetwork: !opts.offline, warnings: refWarnings });
    report = await validateManifest(manifest, checker);
    report.warnings.push(...refWarnings);
  } catch (exc) {
    failFrom(exc);
  }

  for (const warning of report.warnings) console.print(`[yellow]![/yellow] ${escapeMarkup(warning)}`);
  if (!report.ok) {
    console.print('[red]Manifest is invalid:[/red]');
    for (const error of report.errors) console.print(`  [red]-[/red] ${escapeMarkup(error)}`);
    throw new CliExit(1);
  }
  console.print(`[green]✓[/green] ${escapeMarkup(manifest.bundle.id)} is well-formed and valid.`);
}

// ============================================================================
// bundle build
// ============================================================================

export async function bundleBuild(opts: { path?: string | null; output?: string | null } = {}): Promise<void> {
  let result;
  try {
    let bundleDir = resolvePath(opts.path || process.cwd());
    if (isFile(bundleDir)) bundleDir = path.dirname(bundleDir);
    result = buildBundle(bundleDir, opts.output ?? null);
  } catch (exc) {
    failFrom(exc);
  }
  console.print(
    `[green]✓[/green] Built ${escapeMarkup(path.basename(result.artifact_path))} ` +
      `(${result.file_count} files) → ` +
      `${escapeMarkup(result.artifact_path)}`,
  );
}

// ============================================================================
// bundle init
// ============================================================================

export async function bundleInit(
  bundle: string | null,
  opts: { integration?: string | null; offline?: boolean } = {},
): Promise<void> {
  const integration = opts.integration ?? null;
  const offline = opts.offline ?? false;
  let projectRoot: string | null;
  try {
    projectRoot = findProjectRoot();
    if (projectRoot === null) {
      const initIntegration = await resolveInitIntegration(integration, null);
      console.print(
        `[cyan]Initializing a Spec Kit project with integration '${escapeMarkup(initIntegration)}'…[/cyan]`,
      );
      await runInit(initIntegration, { scriptType: defaultScriptType(), offline });
      projectRoot = requireProjectRoot();
    }
  } catch (exc) {
    failFrom(exc);
  }

  console.print(`[green]✓[/green] Spec Kit project ready at ${escapeMarkup(projectRoot)}.`);
  if (bundle) await bundleInstall(bundle, { integration, offline });
}

// ============================================================================
// bundle catalog list / add / remove
// ============================================================================

export async function catalogList(): Promise<void> {
  let sources;
  try {
    const projectRoot = requireProjectRoot();
    sources = loadSourceStack(projectRoot, commandDeps.userConfigDir());
  } catch (exc) {
    failFrom(exc);
  }

  console.print('\n[bold cyan]Catalog stack[/bold cyan] (highest precedence first):\n');
  const onlyBuiltin = sources.every((s) => s.scope === Scope.BUILTIN);
  for (const source of sources) {
    console.print(
      `  [bold]${escapeMarkup(source.id)}[/bold]  ` +
        `priority=${source.priority}  ` +
        `policy=${source.install_policy}  scope=${source.scope}`,
    );
    console.print(`    [dim]${escapeMarkup(source.url)}[/dim]`);
  }
  if (onlyBuiltin) console.print('\n[dim]Using the built-in default stack.[/dim]');
}

export async function catalogAdd(
  url: string,
  opts: { policy?: string; priority?: number; sourceId?: string | null } = {},
): Promise<void> {
  let source;
  let status;
  try {
    const projectRoot = requireProjectRoot();
    [source, status] = addSource(projectRoot, url, {
      policy: opts.policy ?? 'install-allowed',
      priority: opts.priority ?? 10,
      sourceId: opts.sourceId ?? null,
    });
  } catch (exc) {
    failFrom(exc);
  }

  const safeId = escapeMarkup(source.id);
  if (status === 'unchanged') {
    console.print(
      `[green]✓[/green] Catalog '${safeId}' already configured ` +
        `(priority ${source.priority}, ${source.install_policy}).`,
    );
  } else {
    console.print(
      `[green]✓[/green] Added catalog '${safeId}' (priority ${source.priority}, ${source.install_policy}).`,
    );
  }
}

export async function catalogRemove(idOrUrl: string): Promise<void> {
  let removed: string;
  try {
    const projectRoot = requireProjectRoot();
    removed = removeSource(projectRoot, idOrUrl);
  } catch (exc) {
    failFrom(exc);
  }
  console.print(`[green]✓[/green] Removed catalog source '${escapeMarkup(removed)}'.`);
}

// ============================================================================
// CLI wiring
// ============================================================================

const BUNDLE_SOURCE_HELP =
  'Bundle id (from the catalog stack) or a local path to a .zip artifact, bundle directory, or bundle.yml';
const OFFLINE_OPTION = { name: 'offline', flags: ['--offline'], type: 'boolean' as const, help: 'Do not access the network' };
const JSON_OPTION = { name: 'json', flags: ['--json'], type: 'boolean' as const, help: 'Emit JSON to stdout' };
const INTEGRATION_OVERRIDE = { name: 'integration', flags: ['--integration'], help: 'Override integration' };
const REFRESH_OPTION = {
  name: 'refresh',
  flags: ['--refresh'],
  type: 'boolean' as const,
  help: 'Refresh owned components from this bundle source',
};

const catalogGroup: GroupSpec = {
  name: 'catalog',
  help: 'Manage bundle catalog sources',
  commands: [
    defineCommand(
      { name: 'list', help: 'Print the active, priority-ordered catalog stack with scope and policy.' },
      () => catalogList(),
    ),
    defineCommand(
      {
        name: 'add',
        help: 'Register a project-scoped catalog source and persist it.',
        arguments: [{ name: 'url', required: true, help: 'Catalog URL' }],
        options: [
          { name: 'policy', flags: ['--policy'], default: 'install-allowed', help: 'install-allowed | discovery-only' },
          { name: 'priority', flags: ['--priority'], type: 'int', default: 10, help: 'Source priority (lower = higher)' },
          { name: 'id', flags: ['--id'], help: 'Explicit source id' },
        ],
      },
      (p) =>
        catalogAdd(String(p.args.url), {
          policy: optStr(p, 'policy') ?? 'install-allowed',
          priority: typeof p.options.priority === 'number' ? p.options.priority : 10,
          sourceId: optStr(p, 'id'),
        }),
    ),
    defineCommand(
      {
        name: 'remove',
        help: "Remove a project-scoped catalog source (built-in defaults can't be deleted).",
        arguments: [{ name: 'id_or_url', required: true, help: 'Source id or url to remove' }],
      },
      (p) => catalogRemove(String(p.args.id_or_url)),
    ),
  ],
};

const bundleGroup: GroupSpec = {
  name: 'bundle',
  help: 'Discover, install, and author Spec Kit bundles',
  commands: [
    {
      name: 'catalog',
      help: catalogGroup.help,
      run: (args, progName) => dispatchGroup(catalogGroup, args, progName),
    },
    defineCommand(
      {
        name: 'search',
        help: 'List matching bundles across the active catalog stack.',
        arguments: [{ name: 'query', default: '', help: 'Optional text query' }],
        options: [OFFLINE_OPTION, JSON_OPTION],
      },
      (p) =>
        bundleSearch(typeof p.args.query === 'string' ? p.args.query : '', {
          offline: Boolean(p.options.offline),
          asJson: Boolean(p.options.json),
        }),
    ),
    defineCommand(
      {
        name: 'info',
        help: 'Show full metadata and the fully expanded component set (== what install adds).',
        arguments: [{ name: 'bundle_id', required: true, help: 'Bundle id to inspect' }],
        options: [OFFLINE_OPTION, JSON_OPTION],
      },
      (p) => bundleInfo(String(p.args.bundle_id), { offline: Boolean(p.options.offline), asJson: Boolean(p.options.json) }),
    ),
    defineCommand(
      { name: 'list', help: 'List bundles currently installed in the project with versions.', options: [JSON_OPTION] },
      (p) => bundleList({ asJson: Boolean(p.options.json) }),
    ),
    defineCommand(
      {
        name: 'install',
        help:
          "Install a bundle's full component set through each primitive's machinery.\n\n" +
          '``bundle_id`` may be a catalog bundle id, or a local path to a built\n' +
          'artifact (``.zip``), a bundle directory, or a ``bundle.yml`` file. Local\n' +
          'sources install directly without consulting the catalog stack. Use\n' +
          '``--refresh`` to update owned components from a newer local source.',
        shortHelp: "Install a bundle's full component set through each primitive's machinery.",
        arguments: [{ name: 'bundle_id', required: true, help: BUNDLE_SOURCE_HELP }],
        options: [INTEGRATION_OVERRIDE, OFFLINE_OPTION, REFRESH_OPTION],
      },
      (p) =>
        bundleInstall(String(p.args.bundle_id), {
          integration: optStr(p, 'integration'),
          offline: Boolean(p.options.offline),
          refresh: Boolean(p.options.refresh),
        }),
    ),
    defineCommand(
      {
        name: 'add',
        help: "Install a bundle's full component set (alias for install).",
        arguments: [{ name: 'bundle_id', required: true, help: BUNDLE_SOURCE_HELP }],
        options: [INTEGRATION_OVERRIDE, OFFLINE_OPTION, REFRESH_OPTION],
      },
      (p) =>
        bundleInstall(String(p.args.bundle_id), {
          integration: optStr(p, 'integration'),
          offline: Boolean(p.options.offline),
          refresh: Boolean(p.options.refresh),
        }),
    ),
    defineCommand(
      {
        name: 'update',
        help: "Re-resolve and refresh a bundle's components via each primitive's update path.",
        arguments: [{ name: 'bundle_id', help: 'Bundle id, or omit with --all' }],
        options: [
          { name: 'all', flags: ['--all'], type: 'boolean', help: 'Update every installed bundle' },
          INTEGRATION_OVERRIDE,
          OFFLINE_OPTION,
        ],
      },
      (p) =>
        bundleUpdate(typeof p.args.bundle_id === 'string' ? p.args.bundle_id : null, {
          all: Boolean(p.options.all),
          integration: optStr(p, 'integration'),
          offline: Boolean(p.options.offline),
        }),
    ),
    defineCommand(
      {
        name: 'remove',
        help: 'Uninstall only the components this bundle contributed (no collateral removals).',
        arguments: [{ name: 'bundle_id', required: true, help: 'Installed bundle id to remove' }],
      },
      (p) => bundleRemove(String(p.args.bundle_id)),
    ),
    defineCommand(
      {
        name: 'validate',
        help: 'Report whether the manifest is well-formed and references resolve.',
        options: [
          { name: 'path', flags: ['--path'], type: 'path', help: 'Bundle directory or bundle.yml (default: cwd)' },
          {
            name: 'offline',
            flags: ['--offline'],
            type: 'boolean',
            help: 'Do not access catalogs; verify references against bundled/installed only',
          },
        ],
      },
      (p) => bundleValidate({ path: optStr(p, 'path'), offline: Boolean(p.options.offline) }),
    ),
    defineCommand(
      {
        name: 'build',
        help: 'Produce a single versioned distributable artifact (.zip).',
        options: [
          { name: 'path', flags: ['--path'], type: 'path', help: 'Bundle directory (default: cwd)' },
          { name: 'output', flags: ['--output'], type: 'path', help: 'Output directory for the artifact' },
        ],
      },
      (p) => bundleBuild({ path: optStr(p, 'path'), output: optStr(p, 'output') }),
    ),
    defineCommand(
      {
        name: 'init',
        help: 'Ensure the project is initialized (idempotent), then optionally install a bundle.',
        arguments: [{ name: 'bundle', help: 'Optional bundle to install after init' }],
        options: [
          { name: 'integration', flags: ['--integration'], help: 'Integration override' },
          OFFLINE_OPTION,
        ],
      },
      (p) =>
        bundleInit(typeof p.args.bundle === 'string' ? p.args.bundle : null, {
          integration: optStr(p, 'integration'),
          offline: Boolean(p.options.offline),
        }),
    ),
  ],
};

/**
 * Dispatch ``specify bundle ...``. *args* excludes the ``bundle`` word
 * (e.g. ``['catalog', 'list']``). Returns the exit code.
 */
export async function runBundleCommand(args: string[]): Promise<number> {
  try {
    return await dispatchGroup(bundleGroup, args, 'specify bundle');
  } catch (exc) {
    if (exc instanceof CliExit) return exc.code;
    throw exc;
  }
}
