/**
 * @oakoliver/specify-cli - Integration Catalog Commands
 *
 * `specify integration catalog list|add|remove` (ports of
 * `integrations/catalog/command_list.py`, `command_add.py`,
 * `command_remove.py`). The catalog domain classes live in
 * `src/integrations/index.ts` and are re-exported here for compatibility.
 *
 * @module integrations/catalog/commands
 */

import { console, CliExit, escapeMarkup } from '../../console.js';
import { requireSpecifyProject } from '../../project.js';
import { IntegrationCatalog, IntegrationCatalogError } from '../index.js';
import { defineCommand, dispatchGroup, type GroupSpec } from '../../cli-args.js';

export {
  IntegrationCatalog,
  IntegrationCatalogEntry,
  IntegrationCatalogError,
  IntegrationDescriptor,
  IntegrationDescriptorError,
  IntegrationValidationError,
} from '../index.js';

export const CATALOG_APP_HELP = 'Manage integration catalog sources';

type CatalogConfig = Record<string, unknown>;

function errorText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// ============================================================================
// catalog list
// ============================================================================

/** List configured integration catalog sources. */
export async function integrationCatalogList(): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const catalog = new IntegrationCatalog(projectRoot);
  const envOverride = (process.env.SPECKIT_INTEGRATION_CATALOG_URL ?? '').trim();

  let projectConfigs: CatalogConfig[] | null;
  let configs: CatalogConfig[];
  try {
    if (envOverride) {
      projectConfigs = null;
      configs = (await catalog.getCatalogConfigs()) as unknown as CatalogConfig[];
    } else {
      projectConfigs = ((await catalog.getProjectCatalogConfigs()) ?? null) as unknown as CatalogConfig[] | null;
      configs = projectConfigs !== null ? projectConfigs : ((await catalog.getCatalogConfigs()) as unknown as CatalogConfig[]);
    }
  } catch (exc) {
    if (exc instanceof IntegrationCatalogError) {
      console.print(`[red]Error:[/red] ${errorText(exc)}`);
      throw new CliExit(1);
    }
    throw exc;
  }

  console.print('\n[bold cyan]Integration Catalog Sources:[/bold cyan]\n');
  if (envOverride) {
    console.print('  SPECKIT_INTEGRATION_CATALOG_URL is set; it supersedes configured catalog files.');
    console.print('  Project/user catalog sources are not active while the env override is set.\n');
    console.print('[bold]Active catalog source from environment (non-removable here):[/bold]\n');
  } else if (projectConfigs === null) {
    console.print('  No project-level catalog sources configured.\n');
    console.print('[bold]Active catalog sources (non-removable here):[/bold]\n');
  } else {
    console.print('[bold]Project catalog sources (removable):[/bold]\n');
  }

  configs.forEach((cfg, i) => {
    const installStatus = cfg['install_allowed'] ? '[green]install allowed[/green]' : '[yellow]discovery only[/yellow]';
    const rawName = cfg['name'];
    let displayName = rawName !== null && rawName !== undefined ? String(rawName).trim() : '';
    if (!displayName) displayName = `catalog-${i + 1}`;
    const safeName = escapeMarkup(displayName);
    if (envOverride || projectConfigs === null) {
      console.print(`  - [bold]${safeName}[/bold] — ${installStatus}`);
    } else {
      console.print(`  [${i}] [bold]${safeName}[/bold] — ${installStatus}`);
    }
    console.print(`      ${escapeMarkup(String(cfg['url'] ?? ''))}`);
    if (cfg['description']) console.print(`      [dim]${escapeMarkup(String(cfg['description']))}[/dim]`);
    console.print();
  });
}

// ============================================================================
// catalog add
// ============================================================================

/** Add an integration catalog source to the project config. */
export async function integrationCatalogAdd(url: string, name: string | null = null): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const catalog = new IntegrationCatalog(projectRoot);

  // Normalize once here so the success message reflects what was stored.
  const normalizedUrl = url.trim();

  let status: string;
  try {
    status = String(await catalog.addCatalog(normalizedUrl, name));
  } catch (exc) {
    if (exc instanceof IntegrationCatalogError) {
      console.print(`[red]Error:[/red] ${errorText(exc)}`);
      throw new CliExit(1);
    }
    throw exc;
  }

  const safeUrl = escapeMarkup(normalizedUrl);
  if (status === 'unchanged') {
    console.print(`[green]✓[/green] Catalog source already configured: ${safeUrl}`);
  } else {
    console.print(`[green]✓[/green] Catalog source added: ${safeUrl}`);
  }
}

// ============================================================================
// catalog remove
// ============================================================================

/** Remove an integration catalog source by 0-based index. */
export async function integrationCatalogRemove(index: number): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const catalog = new IntegrationCatalog(projectRoot);

  let removedName: string;
  try {
    removedName = String(await catalog.removeCatalog(index));
  } catch (exc) {
    if (exc instanceof IntegrationCatalogError) {
      console.print(`[red]Error:[/red] ${errorText(exc)}`);
      throw new CliExit(1);
    }
    throw exc;
  }

  console.print(`[green]✓[/green] Catalog source '${removedName}' removed`);
}

// ============================================================================
// Dispatcher
// ============================================================================

const CATALOG_GROUP: GroupSpec = {
  name: 'catalog',
  help: CATALOG_APP_HELP,
  noArgsIsHelp: true,
  commands: [
    defineCommand(
      { name: 'list', help: 'List configured integration catalog sources.' },
      async () => integrationCatalogList(),
    ),
    defineCommand(
      {
        name: 'add',
        help: 'Add an integration catalog source to the project config.',
        arguments: [
          {
            name: 'url',
            required: true,
            help:
              'Catalog URL to add (HTTPS required, except http://localhost, ' +
              'http://127.0.0.1, or http://[::1] for local testing)',
          },
        ],
        options: [{ name: 'name', flags: ['--name'], type: 'string', help: 'Catalog name' }],
      },
      async (p) => integrationCatalogAdd(String(p.args['url']), (p.options['name'] as string | null | undefined) ?? null),
    ),
    defineCommand(
      {
        name: 'remove',
        help: 'Remove an integration catalog source by 0-based index.',
        arguments: [{ name: 'index', required: true, type: 'int', help: "Catalog index to remove (from 'catalog list')" }],
      },
      async (p) => integrationCatalogRemove(p.args['index'] as number),
    ),
  ],
};

/**
 * Run `specify integration catalog <subcommand> ...`.
 * `args` excludes the `integration catalog` words. Returns the exit code.
 */
export async function runIntegrationCatalogCommand(
  args: string[],
  progName = 'specify integration catalog',
): Promise<number> {
  return dispatchGroup(CATALOG_GROUP, args, progName);
}
