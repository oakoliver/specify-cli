/**
 * @oakoliver/specify-cli - Step Catalog Commands
 *
 * ``specify workflow step catalog list|add|remove``
 * (port of ``workflows/step/catalog/__init__.py`` + ``workflows/step/catalog/command_*.py``).
 *
 * @module workflows/step/catalog/commands
 */

import { defineCommand, dispatchGroup, type GroupSpec } from '../../../cli-args.js';
import { CliExit, console, escapeMarkup } from '../../../console.js';
import { printCatalogSources } from '../../catalog/commands.js';
import { requireSpecifyProject } from '../../commands.js';
import { StepCatalog, StepCatalogError, StepValidationError, type CatalogConfigRow } from './domain.js';

/** The step ``catalog`` Typer sub-app. */
export const STEP_CATALOG_GROUP: GroupSpec = {
  name: 'catalog',
  help: 'Manage step catalogs',
  commands: [
    defineCommand({ name: 'list', help: 'List configured step catalog sources.' }, () => {
      const catalog = new StepCatalog(requireSpecifyProject());
      let configs: CatalogConfigRow[];
      try {
        configs = catalog.getCatalogConfigs();
      } catch (exc) {
        if (!(exc instanceof StepCatalogError)) throw exc;
        console.print(`[red]Error:[/red] ${exc.message}`);
        throw new CliExit(1);
      }
      printCatalogSources('Step Catalog Sources', configs);
    }),
    defineCommand(
      {
        name: 'add',
        help: 'Add a step catalog source.',
        arguments: [{ name: 'url', help: 'Catalog URL to add', required: true }],
        options: [{ name: 'name', flags: ['--name'], help: 'Catalog name', default: null }],
      },
      (parsed) => {
        const url = String(parsed.args.url);
        const catalog = new StepCatalog(requireSpecifyProject());
        let status: string;
        try {
          status = catalog.addCatalog(url, (parsed.options.name as string | null | undefined) ?? null);
        } catch (exc) {
          if (!(exc instanceof StepValidationError)) throw exc;
          console.print(`[red]Error:[/red] ${exc.message}`);
          throw new CliExit(1);
        }
        const safeUrl = escapeMarkup(url.trim());
        if (status === 'unchanged') {
          console.print(`[green]✓[/green] Step catalog source already configured: ${safeUrl}`);
        } else {
          console.print(`[green]✓[/green] Step catalog source added: ${safeUrl}`);
        }
      },
    ),
    defineCommand(
      {
        name: 'remove',
        help: 'Remove a step catalog source by index.',
        arguments: [
          { name: 'index', help: "Catalog index to remove (from 'step catalog list')", required: true, type: 'int' },
        ],
      },
      (parsed) => {
        const catalog = new StepCatalog(requireSpecifyProject());
        let removedName: string;
        try {
          removedName = catalog.removeCatalog(parsed.args.index as number);
        } catch (exc) {
          if (!(exc instanceof StepValidationError)) throw exc;
          console.print(`[red]Error:[/red] ${exc.message}`);
          throw new CliExit(1);
        }
        console.print(`[green]✓[/green] Step catalog source '${removedName}' removed`);
      },
    ),
  ],
};

/**
 * Run ``specify workflow step catalog <args>``; returns the exit code.
 *
 * @param args argv after ``workflow step catalog``.
 */
export async function runWorkflowStepCatalogCommand(args: string[]): Promise<number> {
  return dispatchGroup(STEP_CATALOG_GROUP, args, 'specify workflow step catalog');
}
