/**
 * @oakoliver/specify-cli - ``specify preset catalog`` CLI commands
 *
 * Port of ``specify_cli/presets/catalog/`` (``command_list.py``,
 * ``command_add.py``, ``command_remove.py``).
 *
 * @module presets/catalog/commands
 */

import { writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import { defineCommand, type CommandSpec, type GroupSpec } from '../../cli-args.js';
import { CliExit, console, escapeMarkup } from '../../console.js';
import { displayProjectPath } from '../../utils.js';
import { dumpYaml, parseYaml } from '../../yaml.js';
import { PresetCatalog } from '../catalog.js';
import { requireSpecifyProject } from '../commands.js';
import { PresetValidationError, userHome, deepEqual, isMapping, pathExists, pyStr, readTextStrict } from '../manifest.js';

// ============================================================================
// catalog list
// ============================================================================

/** List all active preset catalogs (``specify preset catalog list``). */
export function presetCatalogList(): void {
  const projectRoot = requireSpecifyProject();
  const catalog = new PresetCatalog(projectRoot);

  let activeCatalogs;
  try {
    activeCatalogs = catalog.getActiveCatalogs();
  } catch (e) {
    if (e instanceof PresetValidationError) {
      console.print(`[red]Error:[/red] ${escapeMarkup(e.message)}`);
      throw new CliExit(1);
    }
    throw e;
  }

  console.print('\n[bold cyan]Active Preset Catalogs:[/bold cyan]\n');
  for (const entry of activeCatalogs) {
    const installStr = entry.install_allowed ? '[green]install allowed[/green]' : '[yellow]discovery only[/yellow]';
    console.print(`  [bold]${escapeMarkup(entry.name)}[/bold] (priority ${entry.priority})`);
    if (entry.description) console.print(`     ${escapeMarkup(entry.description)}`);
    console.print(`     URL: ${escapeMarkup(entry.url)}`);
    console.print(`     Install: ${installStr}`);
    console.print();
  }

  const configPath = nodePath.join(projectRoot, '.specify', 'preset-catalogs.yml');
  const userConfigPath = nodePath.join(userHome(), '.specify', 'preset-catalogs.yml');
  if (process.env.SPECKIT_PRESET_CATALOG_URL) {
    console.print('[dim]Catalog configured via SPECKIT_PRESET_CATALOG_URL environment variable.[/dim]');
    return;
  }
  let projLoaded: boolean;
  try {
    projLoaded = pathExists(configPath) && catalog.loadCatalogConfig(configPath) !== null;
  } catch (e) {
    if (!(e instanceof PresetValidationError)) throw e;
    projLoaded = false;
  }
  if (projLoaded) {
    console.print(`[dim]Config: ${displayProjectPath(projectRoot, configPath)}[/dim]`);
    return;
  }
  let userLoaded: boolean;
  try {
    userLoaded = pathExists(userConfigPath) && catalog.loadCatalogConfig(userConfigPath) !== null;
  } catch (e) {
    if (!(e instanceof PresetValidationError)) throw e;
    userLoaded = false;
  }
  if (userLoaded) {
    console.print('[dim]Config: ~/.specify/preset-catalogs.yml[/dim]');
  } else {
    console.print('[dim]Using built-in default catalog stack.[/dim]');
    console.print('[dim]Add .specify/preset-catalogs.yml to customize.[/dim]');
  }
}

// ============================================================================
// catalog add
// ============================================================================

function writeCatalogConfig(configPath: string, config: Record<string, unknown>): void {
  writeFileSync(
    configPath,
    dumpYaml(config, { defaultFlowStyle: false, sortKeys: false, allowUnicode: true }),
    'utf-8',
  );
}

/** Add a catalog to .specify/preset-catalogs.yml (``specify preset catalog add``). */
export function presetCatalogAdd(opts: {
  url: string;
  name: string;
  priority?: number;
  installAllowed?: boolean;
  description?: string;
}): void {
  const { url, name } = opts;
  const priority = opts.priority ?? 10;
  const installAllowed = opts.installAllowed ?? false;
  const description = opts.description ?? '';

  const projectRoot = requireSpecifyProject();
  const specifyDir = nodePath.join(projectRoot, '.specify');

  const tmpCatalog = new PresetCatalog(projectRoot);
  try {
    tmpCatalog.validateCatalogUrl(url);
  } catch (e) {
    if (e instanceof PresetValidationError) {
      console.print(`[red]Error:[/red] ${escapeMarkup(e.message)}`);
      throw new CliExit(1);
    }
    throw e;
  }

  const configPath = nodePath.join(specifyDir, 'preset-catalogs.yml');

  let config: Record<string, unknown>;
  if (pathExists(configPath)) {
    let loaded: unknown;
    try {
      loaded = parseYaml(readTextStrict(configPath));
    } catch (e) {
      const configLabel = displayProjectPath(projectRoot, configPath);
      console.print(
        `[red]Error:[/red] Failed to read ${escapeMarkup(configLabel)}: ${escapeMarkup(e instanceof Error ? e.message : String(e))}`,
      );
      throw new CliExit(1);
    }
    if (loaded === null || loaded === undefined) {
      config = {};
    } else if (!isMapping(loaded)) {
      console.print('[red]Error:[/red] Invalid catalog config: expected a mapping.');
      throw new CliExit(1);
    } else {
      config = loaded;
    }
  } else {
    config = {};
  }

  const catalogs = 'catalogs' in config ? config.catalogs : [];
  if (!Array.isArray(catalogs)) {
    console.print("[red]Error:[/red] Invalid catalog config: 'catalogs' must be a list.");
    throw new CliExit(1);
  }

  const safeName = escapeMarkup(name);
  const safeUrl = escapeMarkup(url);

  const entry: Record<string, unknown> = {
    name,
    url,
    priority,
    install_allowed: installAllowed,
    description,
  };

  for (const existing of catalogs) {
    if (isMapping(existing) && existing.name === name) {
      if (
        ['url', 'priority', 'install_allowed', 'description'].every((field) =>
          deepEqual(field in existing ? existing[field] : undefined, entry[field]),
        )
      ) {
        return;
      }
      console.print(`[yellow]Warning:[/yellow] A catalog named '${safeName}' already exists.`);
      console.print("Use 'specify preset catalog remove' first, or choose a different name.");
      throw new CliExit(1);
    }
  }

  catalogs.push(entry);
  config.catalogs = catalogs;
  writeCatalogConfig(configPath, config);

  const installLabel = installAllowed ? 'install allowed' : 'discovery only';
  console.print(`\n[green]✓[/green] Added catalog '[bold]${safeName}[/bold]' (${installLabel})`);
  console.print(`  URL: ${safeUrl}`);
  console.print(`  Priority: ${priority}`);
  const configLabel = escapeMarkup(displayProjectPath(projectRoot, configPath));
  console.print(`\nConfig saved to ${configLabel}`);
}

// ============================================================================
// catalog remove
// ============================================================================

/** Remove a catalog from .specify/preset-catalogs.yml (``specify preset catalog remove``). */
export function presetCatalogRemove(name: string): void {
  const projectRoot = requireSpecifyProject();
  const configPath = nodePath.join(projectRoot, '.specify', 'preset-catalogs.yml');
  if (!pathExists(configPath)) {
    console.print('[red]Error:[/red] No preset catalog config found. Nothing to remove.');
    throw new CliExit(1);
  }

  let loaded: unknown;
  try {
    loaded = parseYaml(readTextStrict(configPath));
  } catch (e) {
    console.print(
      `[red]Error:[/red] Failed to read preset catalog config: ${e instanceof Error ? e.message : String(e)}`,
    );
    throw new CliExit(1);
  }
  let config: Record<string, unknown>;
  if (loaded === null || loaded === undefined) {
    config = {};
  } else if (!isMapping(loaded)) {
    console.print('[red]Error:[/red] Invalid catalog config: expected a mapping.');
    throw new CliExit(1);
  } else {
    config = loaded;
  }

  let catalogs = 'catalogs' in config ? config.catalogs : [];
  if (!Array.isArray(catalogs)) {
    console.print("[red]Error:[/red] Invalid catalog config: 'catalogs' must be a list.");
    throw new CliExit(1);
  }
  const safeName = escapeMarkup(pyStr(name));

  const originalCount = catalogs.length;
  catalogs = catalogs.filter((c: unknown) => isMapping(c) && c.name !== name);

  if ((catalogs as unknown[]).length === originalCount) {
    console.print(`[red]Error:[/red] Catalog '${safeName}' not found.`);
    throw new CliExit(1);
  }

  config.catalogs = catalogs;
  writeCatalogConfig(configPath, config);

  console.print(`[green]✓[/green] Removed catalog '${safeName}'`);
  if (!(catalogs as unknown[]).length) {
    console.print('\n[dim]No catalogs remain in config. Built-in defaults will be used.[/dim]');
  }
}

// ============================================================================
// CLI wiring
// ============================================================================

const CATALOG_LIST_SPEC: CommandSpec = { name: 'list', help: 'List all active preset catalogs.' };

const CATALOG_ADD_SPEC: CommandSpec = {
  name: 'add',
  help: 'Add a catalog to .specify/preset-catalogs.yml.',
  arguments: [{ name: 'url', required: true, help: 'Catalog URL (must use HTTPS)' }],
  options: [
    { name: 'name', flags: ['--name'], required: true, help: 'Catalog name' },
    { name: 'priority', flags: ['--priority'], type: 'int', default: 10, help: 'Priority (lower = higher priority)' },
    {
      name: 'install_allowed',
      flags: ['--install-allowed'],
      negFlags: ['--no-install-allowed'],
      type: 'boolean',
      default: false,
      help: 'Allow presets from this catalog to be installed',
    },
    { name: 'description', flags: ['--description'], default: '', help: 'Description of the catalog' },
  ],
};

const CATALOG_REMOVE_SPEC: CommandSpec = {
  name: 'remove',
  help: 'Remove a catalog from .specify/preset-catalogs.yml.',
  arguments: [{ name: 'name', required: true, help: 'Catalog name to remove' }],
};

/** The nested ``specify preset catalog`` Typer app. */
export const presetCatalogGroup: GroupSpec = {
  name: 'catalog',
  help: 'Manage preset catalogs',
  commands: [
    defineCommand(CATALOG_LIST_SPEC, () => presetCatalogList()),
    defineCommand(CATALOG_ADD_SPEC, (p) =>
      presetCatalogAdd({
        url: String(p.args.url),
        name: String(p.options.name),
        priority: p.options.priority as number,
        installAllowed: !!p.options.install_allowed,
        description: String(p.options.description ?? ''),
      }),
    ),
    defineCommand(CATALOG_REMOVE_SPEC, (p) => presetCatalogRemove(String(p.args.name))),
  ],
};
