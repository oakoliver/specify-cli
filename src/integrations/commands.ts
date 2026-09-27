/**
 * @oakoliver/specify-cli - Integration Commands
 *
 * `specify integration ...` CLI adapter: ports of `integrations/_commands.py`
 * and every `integrations/command_*.py` handler (list, install, uninstall,
 * switch, use, upgrade, status, scaffold, search, info). The nested
 * `catalog` sub-app is delegated to `./catalog/commands.ts`.
 *
 * @module integrations/commands
 */

import { statSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';

import { console, CliExit, escapeMarkup, Table } from '../console.js';
import { requireSpecifyProject } from '../project.js';
import { defineCommand, dispatchGroup, type GroupSpec, type OptionSpec, type ParsedArgs } from '../cli-args.js';
import {
  invokePrefixForIntegration,
  invokeSeparatorForIntegration,
  withIntegrationSetting,
} from '../integration-runtime.js';
import {
  dedupeIntegrationKeys,
  defaultIntegrationKey,
  installedIntegrationKeys,
  integrationSettings,
  pythonJsonDumps,
  type IntegrationState,
} from '../integration-state.js';
import { buildIntegrationStatusReport, type IntegrationStatusReport } from '../integration-status.js';
import {
  ensureExecutableScripts,
  installSharedInfra,
  installSharedInfraOrExit,
} from '../shared-infra.js';
import { resolveEvents } from '../events/index.js';
import {
  INTEGRATION_REGISTRY,
  getIntegration,
  IntegrationCatalog,
  IntegrationCatalogError,
  IntegrationValidationError,
} from './index.js';
import type { IntegrationBase } from './base.js';
import { IntegrationManifest } from './manifest.js';
import {
  printCliWarning,
  SharedTemplateRefreshError,
  clearInitOptionsForIntegration,
  cliErrorDetail,
  cliPhaseLabel,
  getSpeckitVersion,
  readIntegrationJson,
  refreshInitOptionsSpeckitVersion,
  registerExtensionsForAgent,
  registerPresetsForAgent,
  removeIntegrationJson,
  resolveIntegrationOptions,
  resolveIntegrationScriptType,
  resolveScriptType,
  resyncManifestAfterRegistration,
  setDefaultIntegration,
  setDefaultIntegrationOrExit,
  unregisterEnabledExtensionCommandsForAgent,
  unregisterExtensionsForAgent,
  unregisterPresetsForAgent,
  updateInitOptionsForIntegration,
  writeIntegrationJson,
} from './helpers.js';
import {
  PresetRegistryUnreadableError,
  installedCommandPresetsAffectingAgent,
  installedPresetsAffectingAgent,
  legacyCommandRootChanged,
  legacyCommandRootUpgradePending,
  manifestTracksSkillLayout,
} from './command-upgrade-layout.js';
import { scaffoldIntegration, supportedIntegrationScaffoldTypes } from './command-scaffold-generation.js';
import { runIntegrationCatalogCommand } from './catalog/commands.js';

// ============================================================================
// Shared helpers
// ============================================================================

const IS_WINDOWS = process.platform === 'win32';

export { printCliWarning };

function registryKeys(): string[] {
  const reg = INTEGRATION_REGISTRY as unknown;
  if (reg instanceof Map) return [...(reg as Map<string, unknown>).keys()];
  return Object.keys(reg as Record<string, unknown>);
}

function registryHas(key: string): boolean {
  const reg = INTEGRATION_REGISTRY as unknown;
  if (reg instanceof Map) return (reg as Map<string, unknown>).has(key);
  return Object.prototype.hasOwnProperty.call(reg as object, key);
}

function registryGet(key: string): IntegrationBase | undefined {
  const reg = INTEGRATION_REGISTRY as unknown;
  if (reg instanceof Map) return (reg as Map<string, IntegrationBase>).get(key);
  return (reg as Record<string, IntegrationBase>)[key];
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function integrationName(integration: IntegrationBase | null | undefined, fallback: string): string {
  const cfg = (integration?.config ?? {}) as Record<string, unknown>;
  const name = cfg['name'];
  return name === undefined || name === null ? fallback : String(name);
}

function manifestPathFor(projectRoot: string, key: string): string {
  return join(projectRoot, '.specify', 'integrations', `${key}.manifest.json`);
}

/** Python `Path.exists()` (follows symlinks). */
function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Upstream `_utils._display_project_path`. */
function displayProjectPath(projectRoot: string, path: string): string {
  const abs = resolvePath(projectRoot, path);
  const rel = relative(resolvePath(projectRoot), abs);
  if (rel && !rel.startsWith('..')) return rel.split(sep).join('/');
  return path.split(sep).join('/');
}

function errorText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Python `_MANIFEST_READ_ERRORS` — any non-CLI error while loading a manifest. */
function isManifestReadError(exc: unknown): boolean {
  return exc instanceof Error && !(exc instanceof CliExit);
}

function loadIntegrationEvents(
  integration: IntegrationBase,
  projectRoot: string,
  parsedOptions: Record<string, unknown> | null,
): Record<string, Record<string, unknown>> {
  return resolveEvents(
    integration.key,
    (integration.config ?? null) as Record<string, unknown> | null,
    projectRoot,
    parsedOptions,
  ) as unknown as Record<string, Record<string, unknown>>;
}

function makeExecutable(projectRoot: string): void {
  if (!IS_WINDOWS) ensureExecutableScripts(projectRoot);
}

// ============================================================================
// list
// ============================================================================

export async function integrationList(opts: { catalog?: boolean } = {}): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const current = readIntegrationJson(projectRoot);
  const defaultKey = defaultIntegrationKey(current);
  const installedKeys = new Set(installedIntegrationKeys(current));

  if (opts.catalog) {
    const ic = new IntegrationCatalog(projectRoot);
    let entries: Array<Record<string, unknown>>;
    try {
      entries = (await ic.search()) as Array<Record<string, unknown>>;
    } catch (exc) {
      if (exc instanceof IntegrationCatalogError) {
        console.print(`[red]Error:[/red] ${errorText(exc)}`);
        throw new CliExit(1);
      }
      throw exc;
    }

    if (!entries || entries.length === 0) {
      console.print('[yellow]No integrations found in catalog.[/yellow]');
      return;
    }

    const table = new Table({ title: 'Integration Catalog' });
    table.addColumn('ID', { style: 'cyan' });
    table.addColumn('Name');
    table.addColumn('Version');
    table.addColumn('Source');
    table.addColumn('Status');
    table.addColumn('Multi-install Safe');

    const sorted = [...entries].sort((a, b) => {
      const ai = String(a['id']);
      const bi = String(b['id']);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });
    for (const entry of sorted) {
      const eid = String(entry['id']);
      const catName = String(entry['_catalog_name'] ?? '');
      const installAllowed = entry['_install_allowed'] ?? true;
      let status: string;
      if (eid === defaultKey) status = '[green]installed (default)[/green]';
      else if (installedKeys.has(eid)) status = '[green]installed[/green]';
      else if (registryHas(eid)) status = 'built-in';
      else if (installAllowed === false) status = 'discovery-only';
      else status = '';
      let safe = '';
      if (registryHas(eid)) safe = registryGet(eid)?.multiInstallSafe ? 'yes' : 'no';
      table.addRow(eid, String(entry['name'] ?? eid), String(entry['version'] ?? ''), catName, status, safe);
    }
    console.print(table);
    return;
  }

  const keys = registryKeys();
  if (keys.length === 0) {
    console.print('[yellow]No integrations available.[/yellow]');
    return;
  }

  const table = new Table({ title: 'Coding Agent Integrations' });
  table.addColumn('Key', { style: 'cyan' });
  table.addColumn('Name');
  table.addColumn('Status');
  table.addColumn('CLI Required');
  table.addColumn('Multi-install Safe');

  for (const key of sortedStrings(keys)) {
    const integration = registryGet(key);
    const cfg = (integration?.config ?? {}) as Record<string, unknown>;
    const name = String(cfg['name'] ?? key);
    const requiresCli = Boolean(cfg['requires_cli'] ?? false);
    let status = '';
    if (key === defaultKey) status = '[green]installed (default)[/green]';
    else if (installedKeys.has(key)) status = '[green]installed[/green]';
    const cliReq = requiresCli ? 'yes' : 'no (IDE)';
    const safe = integration?.multiInstallSafe ? 'yes' : 'no';
    table.addRow(key, name, status, cliReq, safe);
  }

  console.print(table);

  if (installedKeys.size > 0) {
    console.print(`\n[dim]Default integration:[/dim] [cyan]${defaultKey || 'none'}[/cyan]`);
    console.print(`[dim]Installed integrations:[/dim] [cyan]${sortedStrings(installedKeys).join(', ')}[/cyan]`);
  } else {
    console.print('\n[yellow]No integration currently installed.[/yellow]');
    console.print('Install one with: [cyan]specify integration install <key>[/cyan]');
  }
}

// ============================================================================
// install
// ============================================================================

export interface IntegrationInstallOptions {
  script?: string | null;
  force?: boolean;
  integrationOptions?: string | null;
}

export async function integrationInstall(key: string, opts: IntegrationInstallOptions = {}): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const integration = getIntegration(key);
  if (!integration) {
    console.print(`[red]Error:[/red] Unknown integration '${key}'`);
    console.print(`Available integrations: ${sortedStrings(registryKeys()).join(', ')}`);
    throw new CliExit(1);
  }

  const current = readIntegrationJson(projectRoot);
  const defaultKey = defaultIntegrationKey(current);
  const installedKeys = installedIntegrationKeys(current);

  if (installedKeys.includes(key)) {
    console.print(`[yellow]Integration '${key}' is already installed.[/yellow]`);
    if (defaultKey === key) {
      console.print('It is already the default integration.');
    } else {
      console.print(
        `To make it the default integration, run [cyan]specify integration use ${key}[/cyan].`,
      );
    }
    console.print(
      `To refresh its managed files or options, run [cyan]specify integration upgrade ${key}[/cyan].`,
    );
    console.print('No files were changed.');
    throw new CliExit(0);
  }

  if (installedKeys.length > 0 && !opts.force) {
    const unsafeKeys: string[] = [];
    for (const installedKey of installedKeys) {
      const installedIntegration = getIntegration(installedKey);
      if (!installedIntegration || !installedIntegration.multiInstallSafe) unsafeKeys.push(installedKey);
    }
    if (unsafeKeys.length > 0 || !integration.multiInstallSafe) {
      console.print(`[red]Error:[/red] Installed integrations: ${installedKeys.join(', ')}.`);
      if (defaultKey) console.print(`Default integration: [cyan]${defaultKey}[/cyan].`);
      console.print(
        'Installing multiple integrations is only automatic when all involved ' +
          'integrations are declared multi-install safe.',
      );
      console.print(`To replace the default integration, run [cyan]specify integration switch ${key}[/cyan].`);
      console.print(
        `To install '${key}' alongside the existing integrations anyway, ` +
          'retry the same install command with [cyan]--force[/cyan].',
      );
      throw new CliExit(1);
    }
  }

  const selectedScript = resolveScriptType(projectRoot, opts.script ?? null);

  const [rawOptions, parsedOptions] = resolveIntegrationOptions(
    integration,
    current,
    key,
    opts.integrationOptions ?? null,
  );

  let infraIntegration: IntegrationBase = integration;
  let infraKey = key;
  let infraParsed = parsedOptions;
  if (defaultKey) {
    const defaultIntegration = getIntegration(defaultKey);
    if (defaultIntegration) {
      infraIntegration = defaultIntegration;
      infraKey = defaultKey;
      infraParsed = resolveIntegrationOptions(defaultIntegration, current, defaultKey, null)[1];
    }
  }
  installSharedInfraOrExit(projectRoot, selectedScript, {
    invokeSeparator: invokeSeparatorForIntegration(infraIntegration, current, infraKey, infraParsed, projectRoot),
    invokePrefix: invokePrefixForIntegration(infraIntegration, infraKey, infraParsed, projectRoot),
  });
  makeExecutable(projectRoot);

  const manifest = new IntegrationManifest(integration.key, projectRoot, getSpeckitVersion());

  const eventsMap = loadIntegrationEvents(integration, projectRoot, parsedOptions);

  try {
    integration.setup(projectRoot, manifest, parsedOptions, {
      scriptType: selectedScript,
      rawOptions,
      events: eventsMap,
    });
    manifest.save();
    const newInstalled = dedupeIntegrationKeys([...installedKeys, integration.key]);
    const newDefault = defaultKey || integration.key;
    const settings = withIntegrationSetting(current, integration.key, integration, {
      scriptType: selectedScript,
      rawOptions,
      parsedOptions,
      projectRoot,
    });
    writeIntegrationJson(projectRoot, newDefault, newInstalled, settings);
    if (newDefault === integration.key) {
      updateInitOptionsForIntegration(projectRoot, integration, selectedScript, parsedOptions);
    } else {
      refreshInitOptionsSpeckitVersion(projectRoot);
    }
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    try {
      integration.teardown(projectRoot, manifest, { force: true });
    } catch (rollbackErr) {
      printCliWarning('rollback', 'integration', key, rollbackErr, {
        continuing: 'The original install failure is still the primary error.',
      });
    }
    if (installedKeys.length > 0) {
      writeIntegrationJson(projectRoot, defaultKey, installedKeys, integrationSettings(current));
    } else {
      removeIntegrationJson(projectRoot);
    }
    console.print(
      `[red]Error:[/red] Failed to ${cliPhaseLabel('install', 'integration', key)}: ${cliErrorDetail(exc)}`,
    );
    throw new CliExit(1);
  }

  const name = integrationName(integration, key);
  console.print(`\n[green]✓[/green] Integration '${name}' installed successfully`);
  if (defaultKey) console.print(`[dim]Default integration remains:[/dim] [cyan]${defaultKey}[/cyan]`);
}

// ============================================================================
// uninstall
// ============================================================================

function setDefaultAfterRemoval(
  projectRoot: string,
  current: IntegrationState,
  key: string,
  defaultKey: string | null,
  installedKeys: string[],
): void {
  const remaining = installedKeys.filter((installed) => installed !== key);
  const newDefault = defaultKey !== key ? defaultKey : remaining.length > 0 ? remaining[0] : null;
  if (remaining.length > 0) {
    const newIntegration = defaultKey === key && newDefault ? getIntegration(newDefault) : null;
    if (defaultKey === key && newDefault && newIntegration) {
      const [rawOptions, parsedOptions] = resolveIntegrationOptions(newIntegration, current, newDefault, null);
      setDefaultIntegrationOrExit(projectRoot, current, newDefault, newIntegration, remaining, {
        rawOptions,
        parsedOptions,
      });
    } else {
      writeIntegrationJson(projectRoot, newDefault, remaining, integrationSettings(current));
    }
  } else {
    removeIntegrationJson(projectRoot);
  }
}

export async function integrationUninstall(key: string | null, opts: { force?: boolean } = {}): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const current = readIntegrationJson(projectRoot);
  const defaultKey = defaultIntegrationKey(current);
  const installedKeys = installedIntegrationKeys(current);

  if (key === null || key === undefined) {
    if (!defaultKey) {
      console.print('[yellow]No integration is currently installed.[/yellow]');
      throw new CliExit(0);
    }
    key = defaultKey;
  }

  if (!installedKeys.includes(key)) {
    console.print(`[red]Error:[/red] Integration '${key}' is not installed.`);
    throw new CliExit(1);
  }

  const integration = getIntegration(key);

  const manifestPath = manifestPathFor(projectRoot, key);
  if (!pathExists(manifestPath)) {
    console.print(`[yellow]No manifest found for integration '${key}'. Nothing to uninstall.[/yellow]`);
    setDefaultAfterRemoval(projectRoot, current, key, defaultKey, installedKeys);
    if (defaultKey === key) clearInitOptionsForIntegration(projectRoot, key);
    throw new CliExit(0);
  }

  let manifest: IntegrationManifest;
  try {
    manifest = IntegrationManifest.load(key, projectRoot);
  } catch (exc) {
    if (!isManifestReadError(exc)) throw exc;
    console.print(`[red]Error:[/red] Integration manifest for '${key}' is unreadable.`);
    console.print(`Manifest: ${manifestPath}`);
    console.print(
      `To recover, delete the unreadable manifest, run ` +
        `[cyan]specify integration uninstall ${key}[/cyan] to clear stale metadata, ` +
        `then run [cyan]specify integration install ${key}[/cyan] to regenerate.`,
    );
    console.print(`[dim]Details:[/dim] ${errorText(exc)}`);
    throw new CliExit(1);
  }

  let removed: string[];
  let skipped: string[];
  if (!integration) {
    console.print(
      `[yellow]Warning:[/yellow] Integration '${key}' not found ` +
        'in registry. Falling back to manifest-based cleanup.',
    );
    [removed, skipped] = manifest.uninstall(projectRoot, { force: opts.force ?? false });
  } else {
    [removed, skipped] = integration.teardown(projectRoot, manifest, { force: opts.force ?? false });
  }

  setDefaultAfterRemoval(projectRoot, current, key, defaultKey, installedKeys);

  if (defaultKey === key) clearInitOptionsForIntegration(projectRoot, key);

  const name = integration ? integrationName(integration, key) : key;
  console.print(`\n[green]✓[/green] Integration '${name}' uninstalled`);
  if (removed.length > 0) console.print(`  Removed ${removed.length} file(s)`);
  if (skipped.length > 0) {
    console.print(`\n[yellow]⚠[/yellow]  ${skipped.length} modified file(s) were preserved:`);
    for (const path of skipped) console.print(`    ${displayProjectPath(projectRoot, path)}`);
  }
}

// ============================================================================
// switch
// ============================================================================

export interface IntegrationSwitchOptions {
  script?: string | null;
  force?: boolean;
  refreshSharedInfra?: boolean;
  integrationOptions?: string | null;
}

export async function integrationSwitch(target: string, opts: IntegrationSwitchOptions = {}): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const force = opts.force ?? false;
  const targetIntegration = getIntegration(target);
  if (!targetIntegration) {
    console.print(`[red]Error:[/red] Unknown integration '${target}'`);
    console.print(`Available integrations: ${sortedStrings(registryKeys()).join(', ')}`);
    throw new CliExit(1);
  }

  let current = readIntegrationJson(projectRoot);
  let installedKeys = installedIntegrationKeys(current);
  const installedKey = defaultIntegrationKey(current);
  const integrationOptions = opts.integrationOptions ?? null;

  if (installedKey === target) {
    if (integrationOptions !== null) {
      console.print(
        '[red]Error:[/red] --integration-options cannot be used when switching ' +
          'to an already installed integration.',
      );
      console.print(
        `Run [cyan]specify integration upgrade ${target} --integration-options ...[/cyan] ` +
          'to update managed files/options.',
      );
      throw new CliExit(1);
    }
    if (force) {
      const [rawOptions, parsedOptions] = resolveIntegrationOptions(targetIntegration, current, target, null);
      setDefaultIntegrationOrExit(projectRoot, current, target, targetIntegration, installedKeys, {
        rawOptions,
        parsedOptions,
        refreshTemplatesForce: true,
      });
      console.print(
        `\n[green]✓[/green] Default integration remains [bold]${target}[/bold]; ` +
          'shared infrastructure refreshed.',
      );
      throw new CliExit(0);
    }
    console.print(
      `[yellow]Integration '${target}' is already the default integration. Nothing to switch.[/yellow]`,
    );
    throw new CliExit(0);
  }

  if (installedKeys.includes(target)) {
    if (integrationOptions !== null) {
      console.print(
        '[red]Error:[/red] --integration-options cannot be used when switching ' +
          'to an already installed integration.',
      );
      console.print(
        `Run [cyan]specify integration upgrade ${target} --integration-options ...[/cyan] ` +
          `to update managed files/options, then [cyan]specify integration use ${target}[/cyan].`,
      );
      throw new CliExit(1);
    }
    const [rawOptions, parsedOptions] = resolveIntegrationOptions(targetIntegration, current, target, null);
    setDefaultIntegrationOrExit(projectRoot, current, target, targetIntegration, installedKeys, {
      rawOptions,
      parsedOptions,
      refreshTemplatesForce: force,
    });
    await registerExtensionsForAgent(projectRoot, target, {
      continuing: 'The integration switch succeeded, but installed extensions may need re-registration.',
    });
    await registerPresetsForAgent(projectRoot, target, {
      continuing: 'The integration switch succeeded, but installed presets may need re-registration.',
    });
    console.print(`\n[green]✓[/green] Default integration set to [bold]${target}[/bold].`);
    throw new CliExit(0);
  }

  const selectedScript = resolveScriptType(projectRoot, opts.script ?? null);

  // Resolve and validate target options before uninstalling the current
  // integration so invalid options cannot leave the project half-switched.
  const [targetRawOptions, targetParsedOptions] = resolveIntegrationOptions(
    targetIntegration,
    current,
    target,
    integrationOptions,
  );
  targetIntegration.isSkillsMode(targetParsedOptions, projectRoot);

  // Phase 1: Uninstall current integration (if any)
  if (installedKey) {
    const currentIntegration = getIntegration(installedKey);
    const manifestPath = manifestPathFor(projectRoot, installedKey);

    if (currentIntegration && pathExists(manifestPath)) {
      console.print(`Uninstalling current integration: [cyan]${installedKey}[/cyan]`);
      let oldManifest: IntegrationManifest;
      try {
        oldManifest = IntegrationManifest.load(installedKey, projectRoot);
      } catch (exc) {
        if (!isManifestReadError(exc)) throw exc;
        console.print(
          `[red]Error:[/red] Could not read integration manifest for '${installedKey}': ${manifestPath}`,
        );
        console.print(`[dim]${errorText(exc)}[/dim]`);
        console.print(
          `To recover, delete the unreadable manifest at ${manifestPath}, ` +
            `run [cyan]specify integration uninstall ${installedKey}[/cyan], then retry.`,
        );
        throw new CliExit(1);
      }
      const [removed, skipped] = currentIntegration.teardown(projectRoot, oldManifest, { force });
      if (removed.length > 0) console.print(`  Removed ${removed.length} file(s)`);
      if (skipped.length > 0) console.print(`  [yellow]⚠[/yellow]  ${skipped.length} modified file(s) preserved`);
    } else if (!currentIntegration && pathExists(manifestPath)) {
      console.print(`Uninstalling unknown integration '${installedKey}' via manifest`);
      try {
        const oldManifest = IntegrationManifest.load(installedKey, projectRoot);
        const [removed, skipped] = oldManifest.uninstall(projectRoot, { force });
        if (removed.length > 0) console.print(`  Removed ${removed.length} file(s)`);
        if (skipped.length > 0) console.print(`  [yellow]⚠[/yellow]  ${skipped.length} modified file(s) preserved`);
      } catch (exc) {
        if (!isManifestReadError(exc)) throw exc;
        console.print(`[yellow]Warning:[/yellow] Could not read manifest for '${installedKey}': ${errorText(exc)}`);
      }
    } else {
      console.print(`[red]Error:[/red] Integration '${installedKey}' is installed but has no manifest.`);
      console.print(
        `Run [cyan]specify integration uninstall ${installedKey}[/cyan] to clear metadata, ` +
          `then retry [cyan]specify integration switch ${target}[/cyan].`,
      );
      throw new CliExit(1);
    }

    await unregisterExtensionsForAgent(projectRoot, installedKey, {
      continuing: 'Continuing with integration switch; old extension artifacts may need manual cleanup.',
    });
    await unregisterPresetsForAgent(projectRoot, installedKey, {
      continuing: 'Continuing with integration switch; old preset artifacts may need manual cleanup.',
    });

    // Clear metadata so a failed Phase 2 doesn't leave stale references
    installedKeys = installedKeys.filter((installed) => installed !== installedKey);
    clearInitOptionsForIntegration(projectRoot, installedKey);
    if (installedKeys.length > 0) {
      const fallbackKey = installedKeys[0];
      const fallbackIntegration = getIntegration(fallbackKey);
      if (fallbackIntegration) {
        const [fallbackRaw, fallbackParsed] = resolveIntegrationOptions(
          fallbackIntegration,
          current,
          fallbackKey,
          null,
        );
        setDefaultIntegrationOrExit(projectRoot, current, fallbackKey, fallbackIntegration, installedKeys, {
          rawOptions: fallbackRaw,
          parsedOptions: fallbackParsed,
        });
      } else {
        writeIntegrationJson(projectRoot, fallbackKey, installedKeys, integrationSettings(current));
      }
    } else {
      removeIntegrationJson(projectRoot);
    }
    current = readIntegrationJson(projectRoot);
  }

  // Refresh shared infrastructure to the current CLI version, preserving
  // customizations unless --refresh-shared-infra is passed (#2293).
  installSharedInfraOrExit(projectRoot, selectedScript, {
    force: opts.refreshSharedInfra ?? false,
    refreshManaged: true,
    invokeSeparator: invokeSeparatorForIntegration(targetIntegration, current, target, targetParsedOptions, projectRoot),
    invokePrefix: invokePrefixForIntegration(targetIntegration, target, targetParsedOptions, projectRoot),
    refreshHint:
      'To overwrite customizations, re-run with ' +
      '[cyan]specify integration switch ... --refresh-shared-infra[/cyan].',
  });
  makeExecutable(projectRoot);

  // Phase 2: Install target integration
  console.print(`Installing integration: [cyan]${target}[/cyan]`);
  const manifest = new IntegrationManifest(targetIntegration.key, projectRoot, getSpeckitVersion());

  const eventsMap = loadIntegrationEvents(targetIntegration, projectRoot, targetParsedOptions);
  try {
    targetIntegration.setup(projectRoot, manifest, targetParsedOptions, {
      scriptType: selectedScript,
      rawOptions: targetRawOptions,
      events: eventsMap,
    });
    manifest.save();
    setDefaultIntegration(
      projectRoot,
      current,
      targetIntegration.key,
      targetIntegration,
      dedupeIntegrationKeys([...installedKeys, targetIntegration.key]),
      {
        scriptType: selectedScript,
        rawOptions: targetRawOptions,
        parsedOptions: targetParsedOptions,
      },
    );
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    try {
      targetIntegration.teardown(projectRoot, manifest, { force: true });
    } catch (rollbackErr) {
      printCliWarning('rollback', 'integration', target, rollbackErr, {
        continuing: 'The original switch failure is still the primary error.',
      });
    }
    if (installedKeys.length > 0) {
      const fallbackKey = installedKeys[0];
      const fallbackIntegration = getIntegration(fallbackKey);
      if (fallbackIntegration) {
        const [rawOptions, parsedOptions] = resolveIntegrationOptions(fallbackIntegration, current, fallbackKey, null);
        let restored = true;
        try {
          setDefaultIntegration(projectRoot, current, fallbackKey, fallbackIntegration, installedKeys, {
            rawOptions,
            parsedOptions,
          });
        } catch (restoreErr) {
          if (!(restoreErr instanceof SharedTemplateRefreshError)) throw restoreErr;
          restored = false;
          console.print(
            `[yellow]Warning:[/yellow] Failed to restore default integration '${fallbackKey}': ${errorText(restoreErr)}`,
          );
        }
        if (restored) {
          await registerExtensionsForAgent(projectRoot, fallbackKey, {
            continuing: 'The switch was rolled back; installed extensions may need re-registration.',
          });
          await registerPresetsForAgent(projectRoot, fallbackKey, {
            continuing: 'The switch was rolled back; installed presets may need re-registration.',
          });
        }
      } else {
        writeIntegrationJson(projectRoot, fallbackKey, installedKeys, integrationSettings(current));
      }
    } else {
      removeIntegrationJson(projectRoot);
    }
    console.print(
      `[red]Error:[/red] Failed to ${cliPhaseLabel('install', 'integration', target)} ` +
        `during switch: ${cliErrorDetail(exc)}`,
    );
    throw new CliExit(1);
  }

  await registerExtensionsForAgent(projectRoot, target, {
    continuing: 'The integration switch succeeded, but installed extensions may need re-registration.',
  });
  await registerPresetsForAgent(projectRoot, target, {
    continuing: 'The integration switch succeeded, but installed presets may need re-registration.',
  });

  const name = integrationName(targetIntegration, target);
  console.print(`\n[green]✓[/green] Switched to integration '${name}'`);
}

// ============================================================================
// use
// ============================================================================

export async function integrationUse(key: string, opts: { force?: boolean } = {}): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const current = readIntegrationJson(projectRoot);
  const installedKeys = installedIntegrationKeys(current);
  if (!installedKeys.includes(key)) {
    console.print(`[red]Error:[/red] Integration '${key}' is not installed.`);
    if (installedKeys.length > 0) {
      console.print(`[yellow]Installed integrations:[/yellow] ${installedKeys.join(', ')}`);
    } else {
      console.print('Install one with: [cyan]specify integration install <key>[/cyan]');
    }
    throw new CliExit(1);
  }

  const integration = getIntegration(key);
  if (!integration) {
    console.print(`[red]Error:[/red] Unknown integration '${key}'`);
    throw new CliExit(1);
  }

  const [rawOptions, parsedOptions] = resolveIntegrationOptions(integration, current, key, null);
  setDefaultIntegrationOrExit(projectRoot, current, key, integration, installedKeys, {
    rawOptions,
    parsedOptions,
    refreshTemplatesForce: opts.force ?? false,
    refreshHint: `To overwrite customizations, re-run with [cyan]specify integration use ${key} --force[/cyan].`,
  });
  await registerExtensionsForAgent(projectRoot, key, {
    continuing: 'The integration was selected, but installed extensions may need re-registration.',
  });
  await registerPresetsForAgent(projectRoot, key, {
    continuing: 'The integration was selected, but installed presets may need re-registration.',
  });
  console.print(`[green]✓[/green] Default integration set to [bold]${key}[/bold].`);
}

// ============================================================================
// upgrade
// ============================================================================

export interface IntegrationUpgradeOptions {
  force?: boolean;
  script?: string | null;
  integrationOptions?: string | null;
}

function toPosixPath(p: string): string {
  const absolute = p.startsWith('/');
  const parts = p.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  return (absolute ? '/' : '') + (parts.join('/') || (absolute ? '' : '.'));
}

export async function integrationUpgrade(key: string | null, opts: IntegrationUpgradeOptions = {}): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const force = opts.force ?? false;
  const current = readIntegrationJson(projectRoot);
  const installedKey = defaultIntegrationKey(current);
  const installedKeys = installedIntegrationKeys(current);

  if (key === null || key === undefined) {
    if (!installedKey) {
      console.print('[yellow]No integration is currently installed.[/yellow]');
      throw new CliExit(0);
    }
    key = installedKey;
  }

  if (!installedKeys.includes(key)) {
    console.print(`[red]Error:[/red] Integration '${key}' is not installed.`);
    throw new CliExit(1);
  }

  const integration = getIntegration(key);
  if (!integration) {
    console.print(`[red]Error:[/red] Unknown integration '${key}'`);
    throw new CliExit(1);
  }

  const manifestPath = manifestPathFor(projectRoot, key);
  if (!pathExists(manifestPath)) {
    console.print(`[yellow]No manifest found for integration '${key}'. Nothing to upgrade.[/yellow]`);
    console.print(`Run [cyan]specify integration install ${key}[/cyan] to perform a fresh install.`);
    throw new CliExit(0);
  }

  let oldManifest: IntegrationManifest;
  try {
    oldManifest = IntegrationManifest.load(key, projectRoot);
  } catch (exc) {
    if (!isManifestReadError(exc)) throw exc;
    console.print(`[red]Error:[/red] Integration manifest for '${key}' is unreadable: ${errorText(exc)}`);
    throw new CliExit(1);
  }

  const modified = oldManifest.checkModified();
  if (modified.length > 0 && !force) {
    console.print(`[yellow]⚠[/yellow]  ${modified.length} file(s) have been modified since installation:`);
    for (const rel of modified) console.print(`    ${rel}`);
    console.print('\nUse [cyan]--force[/cyan] to overwrite modified files, or resolve manually.');
    throw new CliExit(1);
  }

  const selectedScript = resolveIntegrationScriptType(projectRoot, current, key, opts.script ?? null);

  const [rawOptions, parsedOptions] = resolveIntegrationOptions(
    integration,
    current,
    key,
    opts.integrationOptions ?? null,
  );

  const legacyPending = legacyCommandRootUpgradePending(integration, oldManifest);

  // Guard: Kilo's legacy command root migration with preset overrides installed.
  if (key === 'kilocode' && legacyPending) {
    const config = (integration.registrarConfig ?? {}) as unknown as Record<string, unknown>;
    const legacy = String(config['legacy_dir'] ?? 'legacy command directory');
    const canonical = String(config['dir'] ?? 'canonical command directory');
    let affectedPresets: string[];
    try {
      affectedPresets = installedCommandPresetsAffectingAgent(projectRoot, key);
    } catch (exc) {
      if (!(exc instanceof PresetRegistryUnreadableError)) throw exc;
      console.print(
        `[red]Error:[/red] Cannot migrate '${key}' command directory ` +
          `from [cyan]${legacy}[/cyan] to [cyan]${canonical}[/cyan]: ` +
          'the preset registry could not be read to verify installed presets.',
      );
      console.print(`[dim]Details:[/dim] ${cliErrorDetail(exc)}`);
      console.print(
        'A command directory migration cannot reconcile preset command ' +
          'artifacts while the preset registry state is unknown. Fix or ' +
          'restore [cyan].specify/presets/.registry[/cyan] and retry.',
      );
      throw new CliExit(1);
    }
    if (affectedPresets.length > 0) {
      const presetList = sortedStrings(affectedPresets).join(', ');
      console.print(
        `[red]Error:[/red] Cannot migrate '${key}' command directory ` +
          `from [cyan]${legacy}[/cyan] to [cyan]${canonical}[/cyan] while ` +
          `preset override(s) are installed: [bold]${presetList}[/bold].`,
      );
      console.print(
        'Preset command artifacts cannot yet be reconciled across this ' +
          'command directory migration, so the upgrade is refused before ' +
          'changing files.',
      );
      console.print(
        'Remove the preset(s), run the upgrade, then reinstall them:\n' +
          '  [cyan]specify preset remove <id>[/cyan]\n' +
          `  [cyan]specify integration upgrade ${key} --script ${selectedScript} --force[/cyan]\n` +
          '  [cyan]specify preset add <id>[/cyan]',
      );
      throw new CliExit(1);
    }
  }

  // Reject command<->skills layout changes while preset artifacts are tracked (#3415).
  if (manifestTracksSkillLayout(oldManifest) !== integration.isSkillsMode(parsedOptions, projectRoot)) {
    let affectedPresets: string[];
    try {
      affectedPresets = installedPresetsAffectingAgent(projectRoot, key);
    } catch (exc) {
      if (!(exc instanceof PresetRegistryUnreadableError)) throw exc;
      console.print(
        `[red]Error:[/red] Cannot change '${key}' command layout: the ` +
          'preset registry could not be read to verify installed presets.',
      );
      console.print(`[dim]Details:[/dim] ${cliErrorDetail(exc)}`);
      console.print(
        'A layout change cannot reconcile preset artifacts, so the ' +
          'migration is refused while the preset registry state is ' +
          'unknown. Fix or restore ' +
          '[cyan].specify/presets/.registry[/cyan] and retry.',
      );
      throw new CliExit(1);
    }
    if (affectedPresets.length > 0) {
      const presetList = sortedStrings(affectedPresets).join(', ');
      console.print(
        `[red]Error:[/red] Cannot change '${key}' command layout while ` +
          `preset override(s) are installed: [bold]${presetList}[/bold].`,
      );
      console.print(
        'Preset artifacts cannot be safely reconciled across a ' +
          'command↔skills layout change, so the migration is refused ' +
          'before changing files.',
      );
      console.print(
        'Remove the preset(s), run the upgrade, then reinstall them:\n' +
          '  [cyan]specify preset remove <id>[/cyan]\n' +
          `  [cyan]specify integration upgrade ${key} ` +
          '--integration-options "..."[/cyan]\n' +
          '  [cyan]specify preset add <id>[/cyan]',
      );
      throw new CliExit(1);
    }
  }

  // Ensure shared infrastructure is up to date; --force overwrites existing files.
  let infraIntegration: IntegrationBase = integration;
  let infraKey = key;
  let infraParsed = parsedOptions;
  if (installedKey && installedKey !== key) {
    const defaultIntegration = getIntegration(installedKey);
    if (defaultIntegration) {
      infraIntegration = defaultIntegration;
      infraKey = installedKey;
      infraParsed = resolveIntegrationOptions(defaultIntegration, current, installedKey, null)[1];
    }
  }
  installSharedInfraOrExit(projectRoot, selectedScript, {
    force,
    invokeSeparator: invokeSeparatorForIntegration(infraIntegration, current, infraKey, infraParsed, projectRoot),
    invokePrefix: invokePrefixForIntegration(infraIntegration, infraKey, infraParsed, projectRoot),
  });
  makeExecutable(projectRoot);

  // Phase 1: Install new files (overwrites existing; old-only files remain)
  console.print(`Upgrading integration: [cyan]${key}[/cyan]`);
  const newManifest = new IntegrationManifest(key, projectRoot, getSpeckitVersion());

  const eventsMap = loadIntegrationEvents(integration, projectRoot, parsedOptions);
  try {
    integration.setup(projectRoot, newManifest, parsedOptions, {
      scriptType: selectedScript,
      rawOptions,
      events: eventsMap,
    });
    const settings = withIntegrationSetting(current, key, integration, {
      scriptType: selectedScript,
      rawOptions,
      parsedOptions,
      projectRoot,
    });
    if (installedKey === key) {
      try {
        installSharedInfra(projectRoot, selectedScript, {
          invokeSeparator: invokeSeparatorForIntegration(
            integration,
            { integration_settings: settings },
            key,
            parsedOptions,
            projectRoot,
          ),
          invokePrefix: invokePrefixForIntegration(integration, key, parsedOptions, projectRoot),
          force,
          refreshManaged: true,
        });
      } catch (exc) {
        if (exc instanceof CliExit) throw exc;
        throw new SharedTemplateRefreshError(
          `Failed to refresh shared infrastructure for '${key}': ${errorText(exc)}`,
        );
      }
      makeExecutable(projectRoot);
    }
    newManifest.save();
    writeIntegrationJson(projectRoot, installedKey, installedKeys, settings);
    if (installedKey === key) {
      updateInitOptionsForIntegration(projectRoot, integration, selectedScript, parsedOptions);
    } else {
      refreshInitOptionsSpeckitVersion(projectRoot);
    }
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    // Don't teardown — setup overwrites in-place.
    console.print(`[red]Error:[/red] Failed to ${cliPhaseLabel('upgrade', 'integration', key)}.`);
    console.print(`[dim]Details:[/dim] ${cliErrorDetail(exc)}`);
    console.print('[yellow]The previous integration files may still be in place.[/yellow]');
    throw new CliExit(1);
  }

  // Phase 2: Remove stale files from old manifest that are not in the new one
  const oldFiles = oldManifest.files;
  const newFiles = newManifest.files;
  const exclusions = new Set([...integration.staleCleanupExclusions()].map((p) => toPosixPath(p)));
  const staleKeys = Object.keys(oldFiles).filter((k) => !(k in newFiles) && !exclusions.has(k));
  if (staleKeys.length > 0) {
    const staleManifest = new IntegrationManifest(key, projectRoot, 'stale-cleanup');
    const staleFiles: Record<string, string> = {};
    for (const k of staleKeys) staleFiles[k] = oldFiles[k];
    (staleManifest as unknown as { _files: Record<string, string> })._files = staleFiles;
    // removeManifest: false — this throwaway manifest shares `key` with the
    // real one just saved above.
    const [staleRemoved] = staleManifest.uninstall(projectRoot, { force: true, removeManifest: false });
    if (staleRemoved.length > 0) {
      console.print(`  Removed ${staleRemoved.length} stale file(s) from previous install`);
    }
  }

  if (legacyCommandRootChanged(integration, projectRoot, oldManifest, newManifest)) {
    await unregisterEnabledExtensionCommandsForAgent(projectRoot, key, {
      continuing:
        'The integration command directory changed, but legacy enabled ' +
        'extension artifacts may need manual cleanup.',
    });
  }

  // Re-register enabled extensions and presets only for the active integration (#2948).
  if (key === installedKey) {
    await registerExtensionsForAgent(projectRoot, key, {
      force: true,
      continuing: 'The integration was upgraded, but installed extensions may need re-registration.',
    });
    await registerPresetsForAgent(projectRoot, key, {
      continuing: 'The integration was upgraded, but installed presets may need re-registration.',
    });
    await resyncManifestAfterRegistration(newManifest, key, {
      continuing:
        'The integration was upgraded, but the manifest may report ' +
        'preset/extension overrides as modified files.',
    });
  }

  const name = integrationName(integration, key);
  console.print(`\n[green]✓[/green] Integration '${name}' upgraded successfully`);
}

// ============================================================================
// status
// ============================================================================

function printIntegrationStatusReport(report: IntegrationStatusReport): void {
  const status = report.status;
  const statusLabel =
    ({ ok: '[green]OK[/green]', warning: '[yellow]WARNING[/yellow]', error: '[red]ERROR[/red]' } as Record<string, string>)[
      String(status)
    ] ?? String(status).toUpperCase();
  const installed = report.installed_integrations ?? [];
  const installedDisplay = installed.map((item) => escapeMarkup(String(item))).join(', ');

  console.print(`Integration status: ${statusLabel}`);
  console.print(`Default integration: ${escapeMarkup(String(report.default_integration || 'none'))}`);
  console.print(`Installed integrations: ${installed.length > 0 ? installedDisplay : 'none'}`);
  const mis = report.multi_install_safe;
  const misDisplay = mis === null || mis === undefined ? 'unknown' : mis ? 'yes' : 'no';
  console.print(`Multi-install safe: ${misDisplay}`);
  console.print(
    `Shared templates target alignment: ${escapeMarkup(String(report.shared_templates_target_alignment || 'none'))}`,
  );
  console.print(`Modified managed files: ${report.modified_managed_files ?? 0}`);
  console.print(`Missing managed files: ${report.missing_managed_files ?? 0}`);
  console.print(`Invalid manifest paths: ${report.invalid_manifest_paths ?? 0}`);
  console.print(`Unchecked manifests: ${report.unchecked_manifests ?? 0}`);

  const findings = report.findings ?? [];
  if (findings.length === 0) return;

  console.print();
  console.print('[bold]Findings:[/bold]');
  for (const item of findings) {
    const severity = item.severity ?? '';
    const severityLabel =
      ({ error: '[red]error[/red]', warning: '[yellow]warning[/yellow]' } as Record<string, string>)[severity] ??
      severity;
    let prefix = `- ${severityLabel} ${escapeMarkup(String(item.code ?? ''))}`;
    if (item.integration) prefix += ` (${escapeMarkup(String(item.integration))})`;
    console.print(`${prefix}: ${escapeMarkup(String(item.message ?? ''))}`, { softWrap: true });
    if (item.suggestion) {
      console.print(`  Suggestion: ${escapeMarkup(String(item.suggestion))}`, { softWrap: true });
    }
  }
}

export async function integrationStatus(opts: { json?: boolean } = {}): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const report = buildIntegrationStatusReport(projectRoot);

  if (opts.json) {
    process.stdout.write(pythonJsonDumps(report, 2) + '\n');
  } else {
    printIntegrationStatusReport(report);
  }

  if (report.status === 'error') throw new CliExit(1);
}

// ============================================================================
// scaffold
// ============================================================================

export const INTEGRATION_SCAFFOLD_TYPES = supportedIntegrationScaffoldTypes();

export async function integrationScaffold(key: string, integrationType = 'markdown'): Promise<void> {
  // scaffold targets the source repo layout, not a .specify/ project, so
  // SPECIFY_INIT_DIR does not apply here.
  const projectRoot = process.cwd();
  let result;
  try {
    result = scaffoldIntegration(projectRoot, key, integrationType);
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    console.print(`[red]Error:[/red] ${errorText(exc)}`);
    throw new CliExit(1);
  }

  const relPosix = (p: string): string => relative(projectRoot, p).split(sep).join('/');
  console.print(`[green]Created integration scaffold:[/green] ${result.key}`);
  console.print(`  ${relPosix(result.integrationFile)}`);
  console.print(`  ${relPosix(result.testFile)}`);
  console.print();
  console.print('[bold]Next steps:[/bold]');
  result.nextSteps.forEach((step, index) => console.print(`${index + 1}. ${step}`));
}

// ============================================================================
// search
// ============================================================================

export async function integrationSearch(
  query: string | null,
  opts: { tag?: string | null; author?: string | null } = {},
): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const integrationConfig = readIntegrationJson(projectRoot);
  const installedKey = defaultIntegrationKey(integrationConfig);
  const catalog = new IntegrationCatalog(projectRoot);
  const tag = opts.tag ?? null;
  const author = opts.author ?? null;

  let results: Array<Record<string, unknown>>;
  try {
    results = (await catalog.search(query, tag, author)) as Array<Record<string, unknown>>;
  } catch (exc) {
    if (exc instanceof IntegrationValidationError) {
      console.print(`[red]Error:[/red] ${errorText(exc)}`);
      console.print(
        '\nTip: Check the configuration file path shown above for invalid catalog configuration ' +
          '(for example, .specify/integration-catalogs.yml or ~/.specify/integration-catalogs.yml).',
      );
      throw new CliExit(1);
    }
    if (exc instanceof IntegrationCatalogError) {
      console.print(`[red]Error:[/red] ${errorText(exc)}`);
      if ((process.env.SPECKIT_INTEGRATION_CATALOG_URL ?? '').trim()) {
        console.print(
          '\nTip: Check the SPECKIT_INTEGRATION_CATALOG_URL environment variable for an invalid ' +
            'catalog URL, or unset it to use the configured catalog files ' +
            '(.specify/integration-catalogs.yml or ~/.specify/integration-catalogs.yml).',
        );
      } else {
        console.print('\nTip: The catalog may be temporarily unavailable. Try again later.');
      }
      throw new CliExit(1);
    }
    throw exc;
  }

  if (!results || results.length === 0) {
    console.print('\n[yellow]No integrations found matching criteria[/yellow]');
    if (query || tag || author) {
      console.print('\nTry:');
      console.print('  • Broader search terms');
      console.print('  • Remove filters');
      console.print('  • specify integration search (show all)');
    }
    return;
  }

  console.print(`\n[green]Found ${results.length} integration(s):[/green]\n`);
  const sorted = [...results].sort((a, b) => {
    const ai = String(a['id'] ?? '');
    const bi = String(b['id'] ?? '');
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  for (const integ of sorted) {
    const iidValue = String(integ['id'] ?? '?');
    const iid = escapeMarkup(iidValue);
    const name = escapeMarkup(String(integ['name'] ?? iidValue));
    const version = escapeMarkup(String(integ['version'] ?? '?'));
    console.print(`[bold]${name}[/bold] (${iid}) v${version}`);
    const desc = integ['description'] ?? '';
    if (desc) console.print(`  ${escapeMarkup(String(desc))}`);

    const authorValue = escapeMarkup(String(integ['author'] ?? 'Unknown'));
    console.print(`\n  [dim]Author:[/dim] ${authorValue}`);
    const tags = integ['tags'] ?? [];
    if (Array.isArray(tags) && tags.length > 0) {
      console.print(`  [dim]Tags:[/dim] ${escapeMarkup(tags.map((t) => String(t)).join(', '))}`);
    }

    const catNameValue = integ['_catalog_name'] ?? '';
    const catName = escapeMarkup(String(catNameValue));
    const installAllowed = integ['_install_allowed'] ?? true;
    if (catNameValue) {
      if (installAllowed) {
        console.print(`  [dim]Catalog:[/dim] ${catName}`);
      } else {
        console.print(`  [dim]Catalog:[/dim] ${catName} [yellow](discovery only — not installable)[/yellow]`);
      }
    }

    if (iidValue === installedKey) {
      console.print('\n  [green]✓ Installed[/green] (currently active)');
    } else if (registryHas(iidValue)) {
      console.print(`\n  [cyan]Install:[/cyan] specify integration install ${iid}`);
    } else if (installAllowed) {
      console.print(
        "\n  [yellow]Found in catalog.[/yellow] Only built-in integration IDs can be installed with 'specify integration install'.",
      );
    } else {
      console.print(`\n  [yellow]⚠[/yellow]  Not directly installable from '${catName}'.`);
    }
    console.print();
  }
}

// ============================================================================
// info
// ============================================================================

export async function integrationInfo(integrationId: string): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const catalog = new IntegrationCatalog(projectRoot);
  const installedKey = defaultIntegrationKey(readIntegrationJson(projectRoot));
  const safeIntegrationId = escapeMarkup(String(integrationId));

  let info: Record<string, unknown> | null = null;
  let catalogError: Error | null = null;
  try {
    info = ((await catalog.getIntegrationInfo(integrationId)) ?? null) as Record<string, unknown> | null;
  } catch (exc) {
    if (!(exc instanceof IntegrationCatalogError)) throw exc;
    info = null;
    catalogError = exc as Error;
  }

  if (info) {
    const name = escapeMarkup(String(info['name'] ?? integrationId));
    const version = escapeMarkup(String(info['version'] ?? '?'));
    console.print(`\n[bold cyan]${name}[/bold cyan] (${safeIntegrationId}) v${version}`);
    if (info['description']) console.print(`  ${escapeMarkup(String(info['description']))}`);
    console.print();

    console.print(`  [dim]Author:[/dim] ${escapeMarkup(String(info['author'] ?? 'Unknown'))}`);
    if (info['license']) console.print(`  [dim]License:[/dim] ${escapeMarkup(String(info['license']))}`);

    const tags = info['tags'] ?? [];
    if (Array.isArray(tags) && tags.length > 0) {
      console.print(`  [dim]Tags:[/dim] ${escapeMarkup(tags.map((t) => String(t)).join(', '))}`);
    }

    const catNameValue = info['_catalog_name'] ?? '';
    const catName = escapeMarkup(String(catNameValue));
    const installAllowed = info['_install_allowed'] ?? true;
    if (catNameValue) {
      const installNote = installAllowed ? '' : ' [yellow](discovery only)[/yellow]';
      console.print(`  [dim]Source catalog:[/dim] ${catName}${installNote}`);
    }

    if (info['repository']) console.print(`  [dim]Repository:[/dim] ${escapeMarkup(String(info['repository']))}`);

    if (integrationId === installedKey) {
      console.print('\n  [green]✓ Installed[/green] (currently active)');
    } else if (registryHas(integrationId)) {
      console.print('\n  [dim]Built-in integration (not currently active)[/dim]');
    }
    return;
  }

  if (registryHas(integrationId)) {
    const integration = registryGet(integrationId);
    const name = integrationName(integration, integrationId);
    console.print(`\n[bold cyan]${name}[/bold cyan] (${integrationId})`);
    console.print('  [dim]Built-in integration (not listed in catalog)[/dim]');
    if (integrationId === installedKey) console.print('\n  [green]✓ Installed[/green] (currently active)');
    if (catalogError) console.print(`\n[yellow]Catalog unavailable:[/yellow] ${errorText(catalogError)}`);
    return;
  }

  if (catalogError) {
    console.print(`[red]Error:[/red] Could not query integration catalog: ${errorText(catalogError)}`);
    if (catalogError instanceof IntegrationValidationError) {
      console.print(
        '\nCheck the configuration file path shown above ' +
          '(.specify/integration-catalogs.yml or ~/.specify/integration-catalogs.yml), ' +
          'or use a built-in integration ID directly.',
      );
    } else if ((process.env.SPECKIT_INTEGRATION_CATALOG_URL ?? '').trim()) {
      console.print(
        '\nCheck whether SPECKIT_INTEGRATION_CATALOG_URL is set correctly and reachable, ' +
          'or unset it to use the configured catalog files, or use a built-in integration ID directly.',
      );
    } else {
      console.print('\nTry again when online, or use a built-in integration ID directly.');
    }
  } else {
    console.print(`[red]Error:[/red] Integration '${safeIntegrationId}' not found`);
    console.print('\nTry: specify integration search');
  }
  throw new CliExit(1);
}

// ============================================================================
// Dispatcher
// ============================================================================

export const INTEGRATION_APP_HELP = 'Manage coding agent integrations';

const SCRIPT_OPTION: OptionSpec = {
  name: 'script',
  flags: ['--script'],
  type: 'string',
  help: 'Script type: sh, ps, or py (default: from init-options.json or platform default)',
};

function optStr(p: ParsedArgs, name: string): string | null {
  const v = p.options[name];
  return v === undefined || v === null ? null : String(v);
}

function optBool(p: ParsedArgs, name: string): boolean {
  return Boolean(p.options[name]);
}

function argStr(p: ParsedArgs, name: string): string | null {
  const v = p.args[name];
  return v === undefined || v === null ? null : String(v);
}

const INTEGRATION_GROUP: GroupSpec = {
  name: 'integration',
  help: INTEGRATION_APP_HELP,
  noArgsIsHelp: true,
  commands: [
    defineCommand(
      {
        name: 'install',
        help: 'Install an integration into an existing project.',
        arguments: [{ name: 'key', required: true, help: 'Integration key to install (e.g. claude, copilot)' }],
        options: [
          SCRIPT_OPTION,
          {
            name: 'force',
            flags: ['--force'],
            type: 'boolean',
            help: 'Allow multi-install when integrations are not declared safe',
          },
          {
            name: 'integration_options',
            flags: ['--integration-options'],
            type: 'string',
            help: 'Options for the integration (e.g. --integration-options="--commands-dir .myagent/cmds")',
          },
        ],
      },
      async (p) =>
        integrationInstall(String(argStr(p, 'key')), {
          script: optStr(p, 'script'),
          force: optBool(p, 'force'),
          integrationOptions: optStr(p, 'integration_options'),
        }),
    ),
    defineCommand(
      {
        name: 'uninstall',
        help: 'Uninstall an integration, safely preserving modified files.',
        arguments: [
          { name: 'key', required: false, help: 'Integration key to uninstall (default: current integration)' },
        ],
        options: [{ name: 'force', flags: ['--force'], type: 'boolean', help: 'Remove files even if modified' }],
      },
      async (p) => integrationUninstall(argStr(p, 'key'), { force: optBool(p, 'force') }),
    ),
    defineCommand(
      {
        name: 'switch',
        help: 'Switch from the current integration to a different one.',
        arguments: [{ name: 'target', required: true, help: 'Integration key to switch to' }],
        options: [
          SCRIPT_OPTION,
          {
            name: 'force',
            flags: ['--force'],
            type: 'boolean',
            help: 'Force removal of modified files during uninstall of the previous integration',
          },
          {
            name: 'refresh_shared_infra',
            flags: ['--refresh-shared-infra'],
            type: 'boolean',
            help: 'Also overwrite shared infrastructure files even if you customized them (otherwise customizations are preserved)',
          },
          {
            name: 'integration_options',
            flags: ['--integration-options'],
            type: 'string',
            help: 'Options for the target integration',
          },
        ],
      },
      async (p) =>
        integrationSwitch(String(argStr(p, 'target')), {
          script: optStr(p, 'script'),
          force: optBool(p, 'force'),
          refreshSharedInfra: optBool(p, 'refresh_shared_infra'),
          integrationOptions: optStr(p, 'integration_options'),
        }),
    ),
    defineCommand(
      {
        name: 'upgrade',
        help:
          'Upgrade an integration by reinstalling with diff-aware file handling.\n\n' +
          'Compares manifest hashes to detect locally modified files and\n' +
          'blocks the upgrade unless --force is used.',
        shortHelp: 'Upgrade an integration by reinstalling with diff-aware file handling.',
        arguments: [
          { name: 'key', required: false, help: 'Integration key to upgrade (default: current integration)' },
        ],
        options: [
          { name: 'force', flags: ['--force'], type: 'boolean', help: 'Force upgrade even if files are modified' },
          SCRIPT_OPTION,
          {
            name: 'integration_options',
            flags: ['--integration-options'],
            type: 'string',
            help: 'Options for the integration',
          },
        ],
      },
      async (p) =>
        integrationUpgrade(argStr(p, 'key'), {
          force: optBool(p, 'force'),
          script: optStr(p, 'script'),
          integrationOptions: optStr(p, 'integration_options'),
        }),
    ),
    defineCommand(
      {
        name: 'list',
        help: 'List available integrations and installed status.',
        options: [
          {
            name: 'catalog',
            flags: ['--catalog'],
            type: 'boolean',
            help: 'Browse full catalog (built-in + community)',
          },
        ],
      },
      async (p) => integrationList({ catalog: optBool(p, 'catalog') }),
    ),
    defineCommand(
      {
        name: 'status',
        help: "Report the current project's integration status without changing files.",
        options: [
          { name: 'json_output', flags: ['--json'], type: 'boolean', help: 'Emit machine-readable integration status.' },
        ],
      },
      async (p) => integrationStatus({ json: optBool(p, 'json_output') }),
    ),
    defineCommand(
      {
        name: 'use',
        help: 'Set the default integration without uninstalling other integrations.',
        arguments: [{ name: 'key', required: true, help: 'Installed integration key to make the default' }],
        options: [
          {
            name: 'force',
            flags: ['--force'],
            type: 'boolean',
            help: 'Overwrite existing shared infrastructure files, including customizations, while changing the default',
          },
        ],
      },
      async (p) => integrationUse(String(argStr(p, 'key')), { force: optBool(p, 'force') }),
    ),
    defineCommand(
      {
        name: 'search',
        help: 'Search for integrations in the active catalog stack.',
        arguments: [{ name: 'query', required: false, help: 'Search query (optional)' }],
        options: [
          { name: 'tag', flags: ['--tag'], type: 'string', help: 'Filter by tag' },
          { name: 'author', flags: ['--author'], type: 'string', help: 'Filter by author' },
        ],
      },
      async (p) => integrationSearch(argStr(p, 'query'), { tag: optStr(p, 'tag'), author: optStr(p, 'author') }),
    ),
    defineCommand(
      {
        name: 'info',
        help: 'Show catalog details for a single integration.',
        arguments: [{ name: 'integration_id', required: true, help: 'Integration ID' }],
      },
      async (p) => integrationInfo(String(argStr(p, 'integration_id'))),
    ),
    defineCommand(
      {
        name: 'scaffold',
        help: 'Create a minimal built-in integration package and test skeleton.',
        arguments: [{ name: 'key', required: true, help: 'Integration key in lowercase kebab-case, e.g. my-agent' }],
        options: [
          {
            name: 'integration_type',
            flags: ['--type'],
            type: 'string',
            choices: [...INTEGRATION_SCAFFOLD_TYPES],
            caseSensitive: false,
            default: 'markdown',
            help: `Scaffold type: ${INTEGRATION_SCAFFOLD_TYPES.join(', ')}`,
          },
        ],
      },
      async (p) =>
        integrationScaffold(String(argStr(p, 'key')), String(optStr(p, 'integration_type') ?? 'markdown').toLowerCase()),
    ),
    {
      name: 'catalog',
      help: 'Manage integration catalog sources',
      run: (args: string[], progName: string) => runIntegrationCatalogCommand(args, progName),
    },
  ],
};

// Legacy v1.1.0 aliases (hidden): `add` -> install, `remove` -> uninstall.
for (const cmd of INTEGRATION_GROUP.commands) {
  if (cmd.name === 'install') cmd.aliases = ['add'];
  if (cmd.name === 'uninstall') cmd.aliases = ['remove'];
}

/**
 * Run `specify integration <subcommand> ...` (`args` excludes the
 * `integration` word). Returns the process exit code.
 */
export async function runIntegrationCommand(args: string[], progName = 'specify integration'): Promise<number> {
  return dispatchGroup(INTEGRATION_GROUP, args, progName);
}
