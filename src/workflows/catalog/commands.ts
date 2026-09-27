/**
 * @oakoliver/specify-cli - Workflow Catalog Commands
 *
 * ``specify workflow catalog list|add|remove``
 * (port of ``workflows/catalog/__init__.py`` + ``workflows/catalog/command_*.py``).
 *
 * @module workflows/catalog/commands
 */

import { defineCommand, dispatchGroup, type GroupSpec } from '../../cli-args.js';
import { CliExit, console, escapeMarkup } from '../../console.js';
import { requireSpecifyProject } from '../commands.js';
import { WorkflowCatalog, WorkflowCatalogError, WorkflowValidationError, type CatalogConfigRow } from './domain.js';

// ============================================================================
// Shared rendering
// ============================================================================

/** Print catalog source rows exactly like the upstream ``catalog list`` commands. */
export function printCatalogSources(title: string, configs: CatalogConfigRow[]): void {
  console.print(`\n[bold cyan]${title}:[/bold cyan]\n`);
  configs.forEach((cfg, i) => {
    const installStatus = cfg.install_allowed ? '[green]install allowed[/green]' : '[yellow]discovery only[/yellow]';
    console.print(`  [${i}] [bold]${escapeMarkup(String(cfg.name))}[/bold] — ${installStatus}`);
    console.print(`      ${escapeMarkup(String(cfg.url))}`);
    if (cfg.description) console.print(`      [dim]${escapeMarkup(String(cfg.description))}[/dim]`);
    console.print();
  });
}

// ============================================================================
// Commands
// ============================================================================

/** The workflow ``catalog`` Typer sub-app. */
export const CATALOG_GROUP: GroupSpec = {
  name: 'catalog',
  help: 'Manage workflow catalogs',
  commands: [
    defineCommand({ name: 'list', help: 'List configured workflow catalog sources.' }, () => {
      const catalog = new WorkflowCatalog(requireSpecifyProject());
      let configs: CatalogConfigRow[];
      try {
        configs = catalog.getCatalogConfigs();
      } catch (exc) {
        if (!(exc instanceof WorkflowCatalogError)) throw exc;
        console.print(`[red]Error:[/red] ${exc.message}`);
        throw new CliExit(1);
      }
      printCatalogSources('Workflow Catalog Sources', configs);
    }),
    defineCommand(
      {
        name: 'add',
        help: 'Add a workflow catalog source.',
        arguments: [{ name: 'url', help: 'Catalog URL to add', required: true }],
        options: [{ name: 'name', flags: ['--name'], help: 'Catalog name', default: null }],
      },
      (parsed) => {
        const url = String(parsed.args.url);
        const catalog = new WorkflowCatalog(requireSpecifyProject());
        let status: string;
        try {
          status = catalog.addCatalog(url, (parsed.options.name as string | null | undefined) ?? null);
        } catch (exc) {
          if (!(exc instanceof WorkflowValidationError)) throw exc;
          console.print(`[red]Error:[/red] ${exc.message}`);
          throw new CliExit(1);
        }
        const safeUrl = escapeMarkup(url.trim());
        if (status === 'unchanged') {
          console.print(`[green]✓[/green] Catalog source already configured: ${safeUrl}`);
        } else {
          console.print(`[green]✓[/green] Catalog source added: ${safeUrl}`);
        }
      },
    ),
    defineCommand(
      {
        name: 'remove',
        help: 'Remove a workflow catalog source by index.',
        arguments: [{ name: 'index', help: "Catalog index to remove (from 'catalog list')", required: true, type: 'int' }],
      },
      (parsed) => {
        const catalog = new WorkflowCatalog(requireSpecifyProject());
        let removedName: string;
        try {
          removedName = catalog.removeCatalog(parsed.args.index as number);
        } catch (exc) {
          if (!(exc instanceof WorkflowValidationError)) throw exc;
          console.print(`[red]Error:[/red] ${exc.message}`);
          throw new CliExit(1);
        }
        console.print(`[green]✓[/green] Catalog source '${removedName}' removed`);
      },
    ),
  ],
};

// ============================================================================
// Dispatcher
// ============================================================================

/**
 * Run ``specify workflow catalog <args>``; returns the exit code.
 *
 * @param args argv after ``workflow catalog``.
 */
export async function runWorkflowCatalogCommand(args: string[]): Promise<number> {
  return dispatchGroup(CATALOG_GROUP, args, 'specify workflow catalog');
}
