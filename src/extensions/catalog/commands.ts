/**
 * @oakoliver/specify-cli - ``specify extension catalog`` commands
 *
 * Port of ``specify_cli/extensions/catalog/`` (``__init__.py``,
 * ``_helpers.py``, ``command_list.py``, ``command_add.py``,
 * ``command_remove.py``).
 *
 * @module extensions/catalog/commands
 */

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type GroupSpec, type ParsedArgs, defineCommand, dispatchGroup } from '../../cli-args.js';
import { CliExit, console, escapeMarkup } from '../../console.js';
import { displayProjectPath } from '../../utils.js';
import { dumpYaml, parseYaml } from '../../yaml.js';
import { pyEquals, exists, readTextUtf8 } from '../compat.js';
import { ExtensionCatalog } from '../extension-catalog.js';
import { ValidationError } from '../errors.js';
import { type Dict, isMapping } from '../manifest.js';
import { requireSpecifyProject } from '../root-helpers.js';

export const CATALOG_APP_HELP =
  'Manage extension catalogs.\n\n' +
  'Catalogs are either install sources (install_allowed) or discovery-only ' +
  "search surfaces. The built-in 'community' catalog is discovery-only by " +
  'design: it is unvetted, so it is searchable but not installable. To install ' +
  "something you found there, either use 'specify extension add <name> --from " +
  "<url>' after vetting it, or curate your own catalog you control. Never flip a " +
  'discovery-only catalog to install_allowed — that is the vetting boundary.';

// ============================================================================
// Helpers
// ============================================================================

/** Load extension catalog CLI config with user-facing shape errors. */
export function loadCatalogCommandConfig(projectRoot: string, configPath: string): Dict {
  let config: unknown;
  try {
    config = parseYaml(readTextUtf8(configPath));
  } catch (error) {
    const configLabel = escapeMarkup(String(displayProjectPath(projectRoot, configPath)));
    console.print(`[red]Error:[/red] Failed to read ${configLabel}: ${escapeMarkup((error as Error).message)}`);
    throw new CliExit(1);
  }
  if (config === null || config === undefined) return {};
  if (!isMapping(config)) {
    const configLabel = escapeMarkup(String(displayProjectPath(projectRoot, configPath)));
    console.print(`[red]Error:[/red] Invalid catalog config ${configLabel}: expected a YAML mapping at the root.`);
    throw new CliExit(1);
  }
  return config;
}

function saveCatalogConfig(configPath: string, config: Dict): void {
  writeFileSync(
    configPath,
    dumpYaml(config, { defaultFlowStyle: false, sortKeys: false, allowUnicode: true }),
    'utf-8',
  );
}

// ============================================================================
// catalog list
// ============================================================================

/** List all active extension catalogs. */
export function catalogList(): void {
  const projectRoot = requireSpecifyProject();
  const catalog = new ExtensionCatalog(projectRoot);

  let activeCatalogs;
  try {
    activeCatalogs = catalog.getActiveCatalogs();
  } catch (error) {
    if (error instanceof ValidationError) {
      console.print(`[red]Error:[/red] ${escapeMarkup(error.message)}`);
      throw new CliExit(1);
    }
    throw error;
  }

  console.print('\n[bold cyan]Active Extension Catalogs:[/bold cyan]\n');
  for (const entry of activeCatalogs) {
    const installStr = entry.install_allowed ? '[green]install allowed[/green]' : '[yellow]discovery only[/yellow]';
    console.print(`  [bold]${escapeMarkup(entry.name)}[/bold] (priority ${entry.priority})`);
    if (entry.description) console.print(`     ${escapeMarkup(entry.description)}`);
    console.print(`     URL: ${escapeMarkup(String(entry.url))}`);
    console.print(`     Install: ${installStr}`);
    console.print();
  }

  if (activeCatalogs.some((entry) => !entry.install_allowed)) {
    console.print(
      '[dim]Discovery-only catalogs are searchable but not installable by design ' +
        '(unvetted sources). To install something you found in one, vet it and run ' +
        "'specify extension add <name> --from <url>', or add it to a catalog you " +
        "control. Don't flip a discovery-only catalog to install_allowed.[/dim]\n",
    );
  }

  const configPath = join(projectRoot, '.specify', 'extension-catalogs.yml');
  const userConfigPath = join(homedir(), '.specify', 'extension-catalogs.yml');
  if (process.env.SPECKIT_CATALOG_URL) {
    console.print('[dim]Catalog configured via SPECKIT_CATALOG_URL environment variable.[/dim]');
    return;
  }
  let projLoaded: boolean;
  try {
    projLoaded = exists(configPath) && catalog.loadCatalogConfig(configPath) !== null;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    projLoaded = false;
  }
  if (projLoaded) {
    const configLabel = escapeMarkup(String(displayProjectPath(projectRoot, configPath)));
    console.print(`[dim]Config: ${configLabel}[/dim]`);
    return;
  }
  let userLoaded: boolean;
  try {
    userLoaded = exists(userConfigPath) && catalog.loadCatalogConfig(userConfigPath) !== null;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    userLoaded = false;
  }
  if (userLoaded) {
    console.print('[dim]Config: ~/.specify/extension-catalogs.yml[/dim]');
  } else {
    console.print('[dim]Using built-in default catalog stack.[/dim]');
    console.print('[dim]Add .specify/extension-catalogs.yml to customize.[/dim]');
  }
}

// ============================================================================
// catalog add
// ============================================================================

/** Add a catalog to .specify/extension-catalogs.yml. */
export function catalogAdd(
  url: string,
  opts: { name: string; priority?: number; installAllowed?: boolean; description?: string },
): void {
  const projectRoot = requireSpecifyProject();
  const specifyDir = join(projectRoot, '.specify');
  const name = opts.name;
  const priority = opts.priority ?? 10;
  const installAllowed = opts.installAllowed ?? false;
  const description = opts.description ?? '';

  try {
    ExtensionCatalog.validateCatalogUrl(url);
  } catch (error) {
    if (error instanceof ValidationError) {
      console.print(`[red]Error:[/red] ${escapeMarkup(error.message)}`);
      throw new CliExit(1);
    }
    throw error;
  }

  const configPath = join(specifyDir, 'extension-catalogs.yml');
  const config: Dict = exists(configPath) ? loadCatalogCommandConfig(projectRoot, configPath) : {};

  const catalogs = Object.prototype.hasOwnProperty.call(config, 'catalogs') ? config.catalogs : [];
  if (!Array.isArray(catalogs)) {
    console.print("[red]Error:[/red] Invalid catalog config: 'catalogs' must be a list.");
    throw new CliExit(1);
  }

  const safeName = escapeMarkup(name);
  const safeUrl = escapeMarkup(url);
  const entry: Dict = {
    name,
    url,
    priority,
    install_allowed: installAllowed,
    description,
  };

  for (const existing of catalogs) {
    if (isMapping(existing) && existing.name === name) {
      const identical = ['url', 'priority', 'install_allowed', 'description'].every((field) =>
        pyEquals(Object.prototype.hasOwnProperty.call(existing, field) ? existing[field] : null, entry[field]),
      );
      if (identical) return;
      console.print(`[yellow]Warning:[/yellow] A catalog named '${safeName}' already exists.`);
      console.print("Use 'specify extension catalog remove' first, or choose a different name.");
      throw new CliExit(1);
    }
  }

  catalogs.push(entry);
  config.catalogs = catalogs;
  saveCatalogConfig(configPath, config);

  const installLabel = installAllowed ? 'install allowed' : 'discovery only';
  console.print(`\n[green]✓[/green] Added catalog '[bold]${safeName}[/bold]' (${installLabel})`);
  console.print(`  URL: ${safeUrl}`);
  console.print(`  Priority: ${priority}`);
  const configLabel = escapeMarkup(String(displayProjectPath(projectRoot, configPath)));
  console.print(`\nConfig saved to ${configLabel}`);
}

// ============================================================================
// catalog remove
// ============================================================================

/** Remove a catalog from .specify/extension-catalogs.yml. */
export function catalogRemove(name: string): void {
  const projectRoot = requireSpecifyProject();
  const configPath = join(projectRoot, '.specify', 'extension-catalogs.yml');
  if (!exists(configPath)) {
    console.print('[red]Error:[/red] No catalog config found. Nothing to remove.');
    throw new CliExit(1);
  }

  const config = loadCatalogCommandConfig(projectRoot, configPath);
  let catalogs = Object.prototype.hasOwnProperty.call(config, 'catalogs') ? config.catalogs : [];
  if (!Array.isArray(catalogs)) {
    console.print("[red]Error:[/red] Invalid catalog config: 'catalogs' must be a list.");
    throw new CliExit(1);
  }
  const safeName = escapeMarkup(name);
  const originalCount = catalogs.length;
  catalogs = catalogs.filter((c: unknown) => isMapping(c) && c.name !== name);

  if (catalogs.length === originalCount) {
    console.print(`[red]Error:[/red] Catalog '${safeName}' not found.`);
    throw new CliExit(1);
  }

  config.catalogs = catalogs;
  saveCatalogConfig(configPath, config);

  console.print(`[green]✓[/green] Removed catalog '${safeName}'`);
  if (!catalogs.length) {
    console.print('\n[dim]No catalogs remain in config. Built-in defaults will be used.[/dim]');
  }
}

// ============================================================================
// CLI adapter
// ============================================================================

export const CATALOG_GROUP: GroupSpec = {
  name: 'catalog',
  help: CATALOG_APP_HELP,
  noArgsIsHelp: false,
  commands: [
    defineCommand({ name: 'list', help: 'List all active extension catalogs.' }, () => {
      catalogList();
      return 0;
    }),
    defineCommand(
      {
        name: 'add',
        help: 'Add a catalog to .specify/extension-catalogs.yml.',
        arguments: [{ name: 'url', required: true, help: 'Catalog URL (must use HTTPS)' }],
        options: [
          { name: 'name', flags: ['--name'], type: 'string', required: true, help: 'Catalog name' },
          {
            name: 'priority',
            flags: ['--priority'],
            type: 'int',
            default: 10,
            help: 'Priority (lower = higher priority)',
            showDefault: true,
          },
          {
            name: 'installAllowed',
            flags: ['--install-allowed'],
            negFlags: ['--no-install-allowed'],
            type: 'boolean',
            default: false,
            showDefault: true,
            help:
              'Mark this catalog as a trusted install source. Only enable this for a ' +
              'catalog you own and vet; leave it off (the default) for discovery-only ' +
              'search surfaces. Never enable it for an unvetted public catalog.',
          },
          { name: 'description', flags: ['--description'], type: 'string', default: '', help: 'Description of the catalog' },
        ],
      },
      (p: ParsedArgs) => {
        catalogAdd(String(p.args.url), {
          name: String(p.options.name),
          priority: p.options.priority as number,
          installAllowed: Boolean(p.options.installAllowed),
          description: String(p.options.description ?? ''),
        });
        return 0;
      },
    ),
    defineCommand(
      {
        name: 'remove',
        help: 'Remove a catalog from .specify/extension-catalogs.yml.',
        arguments: [{ name: 'name', required: true, help: 'Catalog name to remove' }],
      },
      (p: ParsedArgs) => {
        catalogRemove(String(p.args.name));
        return 0;
      },
    ),
  ],
};

/** ``specify extension catalog ...`` dispatcher (``args`` excludes ``catalog``). */
export async function runExtensionCatalogCommand(
  args: string[],
  progName = 'specify extension catalog',
): Promise<number> {
  return dispatchGroup(CATALOG_GROUP, args, progName);
}
