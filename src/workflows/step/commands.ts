/**
 * @oakoliver/specify-cli - Workflow Step Commands
 *
 * ``specify workflow step list|add|remove|search|info|catalog``
 * (port of ``workflows/step/__init__.py`` + ``workflows/step/command_*.py``).
 *
 * @module workflows/step/commands
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { defineCommand, dispatchGroup, type GroupSpec } from '../../cli-args.js';
import { CliExit, console, escapeMarkup } from '../../console.js';
import { isHttpsOrLocalhostHttp } from '../../download-security.js';
import { isEmptyYamlDocument, parseYaml } from '../../yaml.js';
import { httpDeps, responseUrl } from '../catalog/domain.js';
import { readResponseWithinLimit, rejectInsecureDownloadRedirect, requireSpecifyProject } from '../commands.js';
import { STEP_REGISTRY } from '../index.js';
import {
  isMapping,
  isRelativeTo,
  osErrorMessage,
  pathExists,
  pyRepr,
  pyStr,
  pyTruthy,
  relativeParts,
  resolvePath,
} from '../overlay/py-compat.js';
import { runWorkflowStepCatalogCommand } from './catalog/commands.js';
import { StepCatalog, StepCatalogError, StepRegistry, StepValidationError } from './catalog/domain.js';
import {
  resolveStepsBaseDirOrExit,
  stepPackageLimits,
  validateStepIdOrExit,
} from './helpers.js';

// ============================================================================
// STEP_REGISTRY access (Map or plain-object registry)
// ============================================================================

function builtinStepKeys(): string[] {
  const reg = STEP_REGISTRY as unknown;
  if (reg instanceof Map) return [...(reg as Map<string, unknown>).keys()];
  return Object.keys(reg as Record<string, unknown>);
}

function builtinStepHas(key: string): boolean {
  const reg = STEP_REGISTRY as unknown;
  if (reg instanceof Map) return (reg as Map<string, unknown>).has(key);
  return Object.prototype.hasOwnProperty.call(reg as Record<string, unknown>, key);
}

// ============================================================================
// Path helpers
// ============================================================================

/** ``pathlib.PurePosixPath(p).parts`` */
export function posixParts(p: string): string[] {
  const parts: string[] = [];
  if (p.startsWith('/')) parts.push(p.startsWith('//') && !p.startsWith('///') ? '//' : '/');
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    parts.push(seg);
  }
  return parts;
}

/** Match portable path/case aliases of the two required package files. */
function isRequiredPackageFile(relPath: unknown): boolean {
  if (typeof relPath !== 'string') return false;
  const parts = posixParts(relPath.replace(/\\/g, '/'));
  return parts.length === 1 && ['step.yml', '__init__.py'].includes(parts[0].toLowerCase());
}

async function safeFetch(url: string): Promise<Uint8Array> {
  if (!isHttpsOrLocalhostHttp(url)) throw new Error(`Refusing to fetch from non-HTTPS URL: ${url}`);
  const resp = await httpDeps.openUrl(url, { timeout: 30, redirectValidator: rejectInsecureDownloadRedirect });
  const finalUrl = responseUrl(resp, url);
  if (!isHttpsOrLocalhostHttp(finalUrl)) throw new Error(`Redirect to non-HTTPS URL: ${finalUrl}`);
  return await readResponseWithinLimit(resp);
}

function errMsg(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// ============================================================================
// step add
// ============================================================================

/** Install a custom step type from the step catalog. */
export async function workflowStepAdd(stepId: string): Promise<void> {
  const projectRoot = requireSpecifyProject();

  const catalog = new StepCatalog(projectRoot);
  let info: Record<string, unknown> | null;
  try {
    info = await catalog.getStepInfo(stepId);
  } catch (exc) {
    if (!(exc instanceof StepCatalogError)) throw exc;
    console.print(`[red]Error:[/red] ${exc.message}`);
    throw new CliExit(1);
  }

  if (!info || Object.keys(info).length === 0) {
    console.print(`[red]Error:[/red] Step type '${stepId}' not found in catalog`);
    throw new CliExit(1);
  }

  if (!pyTruthy('_install_allowed' in info ? info._install_allowed : true)) {
    console.print(`[yellow]Warning:[/yellow] Step type '${stepId}' is from a discovery-only catalog`);
    console.print('Direct installation is not enabled for this catalog source.');
    throw new CliExit(1);
  }

  // Reject step IDs that collide with built-in step types.
  if (builtinStepHas(stepId)) {
    console.print(`[red]Error:[/red] Step type '${stepId}' conflicts with a built-in step type`);
    throw new CliExit(1);
  }

  // Reject if already installed.
  let registry = new StepRegistry(projectRoot);
  if (registry.isInstalled(stepId)) {
    console.print(
      `[red]Error:[/red] Step type '${stepId}' is already installed. ` +
        'Remove it first with: [cyan]specify workflow step remove ' +
        `${stepId}[/cyan]`,
    );
    throw new CliExit(1);
  }

  const malformedYml = () => {
    console.print(
      `[red]Error:[/red] Catalog entry for '${stepId}' has a malformed ` + 'step.yml URL; expected a non-empty string',
    );
    throw new CliExit(1);
  };
  const declaredStepYmlUrl = info.step_yml_url ?? null;
  if (declaredStepYmlUrl !== null && typeof declaredStepYmlUrl !== 'string') malformedYml();
  const stepYmlUrl: unknown = pyTruthy(declaredStepYmlUrl) ? declaredStepYmlUrl : (info.url ?? null);
  if (stepYmlUrl === null || (typeof stepYmlUrl === 'string' && !stepYmlUrl.trim())) {
    console.print(`[red]Error:[/red] Catalog entry for '${stepId}' has no URL`);
    throw new CliExit(1);
  }
  if (typeof stepYmlUrl !== 'string') malformedYml();
  const ymlUrl = stepYmlUrl as string;

  // Derive __init__.py URL or use explicit init_url.
  let initUrl: unknown = info.init_url ?? null;
  if (initUrl !== null && (typeof initUrl !== 'string' || !initUrl.trim())) {
    console.print(
      `[red]Error:[/red] Catalog entry for '${stepId}' has a malformed ` + '__init__.py URL; expected a non-empty string',
    );
    throw new CliExit(1);
  }
  if (!initUrl) {
    if (ymlUrl.endsWith('step.yml')) {
      initUrl = ymlUrl.slice(0, -'step.yml'.length) + '__init__.py';
    } else {
      console.print(
        `[red]Error:[/red] Cannot derive __init__.py URL from '${ymlUrl}'. ` +
          "Catalog entry should provide 'init_url' or a 'url' ending in 'step.yml'.",
      );
      throw new CliExit(1);
    }
  }

  // Preflight the declared file count before any request.
  let extraFiles: unknown = info.extra_files ?? null;
  if (extraFiles !== null && !isMapping(extraFiles)) {
    console.print(
      "[yellow]Warning:[/yellow] Catalog entry 'extra_files' is not a mapping; " +
        'additional package files will not be downloaded.',
    );
    extraFiles = {};
  }
  const extraEntries = Object.entries((extraFiles as Record<string, unknown> | null) ?? {});
  const declaredExtraCount = extraEntries.filter(([relPath]) => !isRequiredPackageFile(relPath)).length;
  const packageFileCount = 2 + declaredExtraCount;
  if (packageFileCount > stepPackageLimits.maxFiles) {
    console.print(
      `[red]Error:[/red] Step package declares ${packageFileCount} files, ` +
        `exceeding the ${stepPackageLimits.maxFiles}-file limit`,
    );
    throw new CliExit(1);
  }

  validateStepIdOrExit(stepId);

  const stepsBaseDir = resolveStepsBaseDirOrExit(projectRoot);
  const stepDir = resolvePath(join(stepsBaseDir, stepId));
  const relParts = relativeParts(stepDir, stepsBaseDir);
  if (relParts === null || relParts.length !== 1 || relParts[0] !== stepId) {
    console.print(`[red]Error:[/red] Invalid step id '${stepId}'`);
    throw new CliExit(1);
  }

  if (pathExists(stepDir)) {
    console.print(
      `[red]Error:[/red] Step directory already exists at '${stepDir}'. ` +
        `Remove it manually or use: [cyan]specify workflow step remove ${stepId}[/cyan]`,
    );
    throw new CliExit(1);
  }

  // Stage on the same filesystem so the final rename is atomic.
  let tmpPath: string;
  try {
    mkdirSync(stepsBaseDir, { recursive: true });
    tmpPath = mkdtempSync(join(stepsBaseDir, 'speckit_step_tmp_'));
  } catch (exc) {
    console.print(`[red]Error:[/red] Failed to create staging directory: ${osErrorMessage(exc)}`);
    throw new CliExit(1);
  }

  let stepMeta: Record<string, unknown> = {};
  let typeKey: unknown;
  try {
    let stepYmlContent: Uint8Array;
    let initPyContent: Uint8Array;
    try {
      stepYmlContent = await safeFetch(ymlUrl);
      initPyContent = await safeFetch(initUrl as string);
    } catch (exc) {
      console.print(`[red]Error:[/red] Failed to download step files: ${errMsg(exc)}`);
      throw new CliExit(1);
    }

    let packageBytes = stepYmlContent.length + initPyContent.length;
    if (packageBytes > stepPackageLimits.maxBytes) {
      console.print(`[red]Error:[/red] Step package exceeds the ` + `${stepPackageLimits.maxBytes}-byte total size limit`);
      throw new CliExit(1);
    }

    // Validate step.yml
    let meta: unknown;
    let isEmptyDocument: boolean;
    try {
      const stepYmlText = new TextDecoder('utf-8', { fatal: true }).decode(stepYmlContent);
      isEmptyDocument = isEmptyYamlDocument(stepYmlText);
      meta = parseYaml(stepYmlText);
    } catch (exc) {
      console.print(`[red]Error:[/red] Invalid step.yml: ${errMsg(exc)}`);
      throw new CliExit(1);
    }

    // Only a genuinely empty document defaults to {}.
    if ((meta === null || meta === undefined) && isEmptyDocument) {
      meta = {};
    } else if (!isMapping(meta)) {
      console.print('[red]Error:[/red] step.yml must be a YAML mapping');
      throw new CliExit(1);
    }

    const rawStepMeta = 'step' in (meta as Record<string, unknown>) ? (meta as Record<string, unknown>).step : {};
    if (!isMapping(rawStepMeta)) {
      console.print("[red]Error:[/red] step.yml 'step' field must be a mapping");
      throw new CliExit(1);
    }
    stepMeta = rawStepMeta;
    typeKey = 'type_key' in stepMeta ? stepMeta.type_key : '';
    if (!pyTruthy(typeKey)) {
      console.print("[red]Error:[/red] step.yml missing 'step.type_key' field");
      throw new CliExit(1);
    }

    if (typeKey !== stepId) {
      console.print(
        `[red]Error:[/red] step.yml type_key (${pyRepr(typeKey)}) does not match ` + `catalog ID (${pyRepr(stepId)})`,
      );
      throw new CliExit(1);
    }

    // Write the two required files.
    try {
      writeFileSync(join(tmpPath, 'step.yml'), stepYmlContent);
      writeFileSync(join(tmpPath, '__init__.py'), initPyContent);
    } catch (exc) {
      console.print(`[red]Error:[/red] Failed to write step files to staging directory: ${osErrorMessage(exc)}`);
      throw new CliExit(1);
    }

    // Optionally download additional package files (relative path -> URL).
    for (const [relPath, fileUrl] of extraEntries) {
      if (typeof relPath !== 'string' || !relPath.trim()) {
        console.print("[red]Error:[/red] Catalog entry 'extra_files' contains an " + 'empty or non-string path key');
        throw new CliExit(1);
      }
      if (isRequiredPackageFile(relPath)) continue;
      const parts = posixParts(relPath);
      if (parts.length === 0 || parts.some((seg) => seg === '' || seg === '.' || seg === '..')) {
        console.print(`[red]Error:[/red] extra_files path '${relPath}' is not a ` + 'valid relative file path');
        throw new CliExit(1);
      }
      if (typeof fileUrl !== 'string' || !fileUrl.trim()) {
        console.print(`[red]Error:[/red] extra_files entry '${relPath}' has an ` + 'empty or non-string URL');
        throw new CliExit(1);
      }
      const resolvedBase = resolvePath(tmpPath);
      const dest = resolvePath(relPath.startsWith('/') ? relPath : join(tmpPath, relPath));
      if (!isRelativeTo(dest, resolvedBase)) {
        console.print(`[red]Error:[/red] extra_files path '${relPath}' is outside ` + 'the step package directory');
        throw new CliExit(1);
      }
      let fileContent: Uint8Array;
      try {
        fileContent = await safeFetch(fileUrl);
      } catch (exc) {
        console.print(`[red]Error:[/red] Failed to download extra file '${relPath}': ${errMsg(exc)}`);
        throw new CliExit(1);
      }
      packageBytes += fileContent.length;
      if (packageBytes > stepPackageLimits.maxBytes) {
        console.print(`[red]Error:[/red] Step package exceeds the ` + `${stepPackageLimits.maxBytes}-byte total size limit`);
        throw new CliExit(1);
      }
      try {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, fileContent);
      } catch (exc) {
        console.print(`[red]Error:[/red] Failed to write extra file '${relPath}': ${osErrorMessage(exc)}`);
        throw new CliExit(1);
      }
    }

    // Atomically rename the staging directory to the final location.
    try {
      renameSync(tmpPath, stepDir);
    } catch (exc) {
      console.print(`[red]Error:[/red] Failed to install step '${stepId}': ${osErrorMessage(exc)}`);
      throw new CliExit(1);
    }
  } finally {
    // Clean up if the rename hasn't moved tmpPath yet (i.e. on any failure).
    rmSync(tmpPath, { recursive: true, force: true });
  }

  const stepName = pyTruthy(info.name) ? info.name : stepId;
  const stepVersion = pyTruthy(info.version) ? info.version : pyTruthy(stepMeta.version) ? stepMeta.version : '0.0.0';

  registry = new StepRegistry(projectRoot);
  try {
    registry.add(stepId, {
      name: stepName,
      version: stepVersion,
      description: 'description' in info ? info.description : 'description' in stepMeta ? stepMeta.description : '',
      author: 'author' in info ? info.author : 'author' in stepMeta ? stepMeta.author : '',
      source: 'catalog',
      catalog_name: '_catalog_name' in info ? info._catalog_name : '',
      type_key: typeKey,
    });
  } catch (exc) {
    if (!(exc instanceof StepValidationError)) throw exc;
    // Roll back the just-installed directory.
    rmSync(stepDir, { recursive: true, force: true });
    console.print(`[red]Error:[/red] ${exc.message}`);
    throw new CliExit(1);
  }

  console.print(`[green]✓[/green] Step type '${pyStr(stepName)}' (${stepId}) installed`);
  console.print('  Use [cyan]specify workflow step list[/cyan] to verify the installation.');
}

// ============================================================================
// step remove
// ============================================================================

/** Uninstall a custom step type. */
export function workflowStepRemove(stepId: string): void {
  const projectRoot = requireSpecifyProject();

  validateStepIdOrExit(stepId);

  const registry = new StepRegistry(projectRoot);
  const inRegistry = registry.isInstalled(stepId);

  const stepsBaseDir = resolveStepsBaseDirOrExit(projectRoot);
  const stepDir = resolvePath(join(stepsBaseDir, stepId));
  const relParts = relativeParts(stepDir, stepsBaseDir);
  if (relParts === null || relParts.length !== 1 || relParts[0] !== stepId) {
    console.print(`[red]Error:[/red] Invalid step id '${stepId}'`);
    throw new CliExit(1);
  }

  const dirExists = pathExists(stepDir);

  if (!inRegistry && !dirExists) {
    console.print(`[red]Error:[/red] Step type '${stepId}' is not installed`);
    throw new CliExit(1);
  }

  if (!inRegistry && dirExists) {
    console.print(
      `[yellow]Warning:[/yellow] '${stepId}' has no registry entry ` +
        '(registry may have been reset). Removing the orphaned directory.',
    );
  }

  if (dirExists && !inRegistry) {
    try {
      rmSync(stepDir, { recursive: true });
    } catch (exc) {
      console.print(`[red]Error:[/red] Failed to remove step directory ${stepDir}: ${osErrorMessage(exc)}`);
      throw new CliExit(1);
    }
  } else if (inRegistry) {
    const registryMetadata = registry.get(stepId);
    try {
      registry.remove(stepId);
    } catch (exc) {
      if (!(exc instanceof StepValidationError)) throw exc;
      console.print(`[red]Error:[/red] ${exc.message}`);
      throw new CliExit(1);
    }
    if (dirExists) {
      try {
        rmSync(stepDir, { recursive: true });
      } catch (exc) {
        // Restore the original registry entry verbatim (bypass add()).
        try {
          if (registryMetadata !== null && registryMetadata !== undefined) {
            registry.data.steps[stepId] = registryMetadata;
            registry.save();
          }
        } catch (restoreExc) {
          console.print(
            `[yellow]Warning:[/yellow] Failed to restore registry entry ` +
              `for '${stepId}' after directory removal failure: ${errMsg(restoreExc)}`,
          );
        }
        console.print(`[red]Error:[/red] Failed to remove step directory ${stepDir}: ${osErrorMessage(exc)}`);
        throw new CliExit(1);
      }
    }
  }
  console.print(`[green]✓[/green] Step type '${stepId}' uninstalled`);
}

// ============================================================================
// step list / search / info
// ============================================================================

/** List installed step types (built-in and custom). */
export function workflowStepList(): void {
  const projectRoot = requireSpecifyProject();
  const specifyDir = join(projectRoot, '.specify');

  let installed: Record<string, unknown> = {};
  if (existsSync(specifyDir)) installed = new StepRegistry(projectRoot).list();

  console.print('\n[bold cyan]Installed Step Types:[/bold cyan]\n');

  const builtIn = builtinStepKeys()
    .filter((k) => !Object.prototype.hasOwnProperty.call(installed, k))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (builtIn.length) {
    console.print('  [bold]Built-in:[/bold]');
    for (const key of builtIn) console.print(`    • ${key}`);
    console.print();
  }

  const installedKeys = Object.keys(installed).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (installedKeys.length) {
    console.print('  [bold]Custom (installed):[/bold]');
    for (const key of installedKeys) {
      const rawMeta = installed[key];
      const meta = isMapping(rawMeta) ? rawMeta : {};
      const name = escapeMarkup(pyStr('name' in meta ? meta.name : key));
      const safeKey = escapeMarkup(String(key));
      const version = escapeMarkup(pyStr('version' in meta ? meta.version : '?'));
      console.print(`    • [bold]${name}[/bold] (${safeKey}) v${version}`);
    }
    console.print();
  }

  if (!builtIn.length && !installedKeys.length) console.print('[yellow]No step types found.[/yellow]');

  if (existsSync(specifyDir)) {
    console.print('  Install a new step type with: [cyan]specify workflow step add <id>[/cyan]');
  }
}

/** Search the step type catalog. */
export async function workflowStepSearch(query: string | null): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const catalog = new StepCatalog(projectRoot);

  let results: Record<string, unknown>[];
  try {
    results = await catalog.search(query);
  } catch (exc) {
    if (!(exc instanceof StepCatalogError)) throw exc;
    console.print(`[red]Error:[/red] ${exc.message}`);
    throw new CliExit(1);
  }

  if (results.length === 0) {
    if (query) console.print(`[yellow]No step types found matching '${query}'.[/yellow]`);
    else console.print('[yellow]No step types found in catalog.[/yellow]');
    return;
  }

  console.print(`\n[bold cyan]Step Types (${results.length}):[/bold cyan]\n`);
  for (const step of results) {
    const installNote = pyTruthy('_install_allowed' in step ? step._install_allowed : true)
      ? ''
      : ' [dim](discovery only)[/dim]';
    const idValue = 'id' in step ? step.id : '?';
    const name = escapeMarkup(pyStr('name' in step ? step.name : idValue));
    const stepId = escapeMarkup(pyStr(idValue));
    const version = escapeMarkup(pyStr('version' in step ? step.version : '?'));
    console.print(`  [bold]${name}[/bold] (${stepId}) v${version}${installNote}`);
    const desc = 'description' in step ? step.description : '';
    if (pyTruthy(desc)) console.print(`    ${escapeMarkup(pyStr(desc))}`);
    console.print();
  }
}

/** Show details for a step type. */
export async function workflowStepInfo(stepId: string): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const safeStepId = escapeMarkup(String(stepId));

  const registry = new StepRegistry(projectRoot);
  const installedMeta = registry.get(stepId);

  const isBuiltin = builtinStepHas(stepId) && !pyTruthy(installedMeta);

  if (isBuiltin) {
    console.print(`\n[bold cyan]${safeStepId}[/bold cyan] [dim](built-in)[/dim]`);
    console.print(`  Type key: ${safeStepId}`);
    console.print('  [green]Built-in step type[/green]');
    return;
  }

  const printDetails = (meta: Record<string, unknown>): void => {
    const name = escapeMarkup(pyStr('name' in meta ? meta.name : stepId));
    const version = escapeMarkup(pyStr('version' in meta ? meta.version : '?'));
    console.print(`\n[bold cyan]${name}[/bold cyan] (${safeStepId})`);
    console.print(`  Version:     ${version}`);
    if (pyTruthy(meta.author)) console.print(`  Author:      ${escapeMarkup(pyStr(meta.author))}`);
    if (pyTruthy(meta.description)) console.print(`  Description: ` + `${escapeMarkup(pyStr(meta.description))}`);
  };

  if (pyTruthy(installedMeta) && isMapping(installedMeta)) {
    printDetails(installedMeta);
    console.print('  [green]Installed[/green]');
    return;
  }

  const catalog = new StepCatalog(projectRoot);
  let info: Record<string, unknown> | null;
  try {
    info = await catalog.getStepInfo(stepId);
  } catch (exc) {
    if (!(exc instanceof StepCatalogError)) throw exc;
    info = null;
  }

  if (info && Object.keys(info).length > 0) {
    printDetails(info);
    console.print('  [yellow]Not installed[/yellow]');
    console.print(`\n  Install with: [cyan]specify workflow step add ${safeStepId}[/cyan]`);
  } else {
    console.print(`[red]Error:[/red] Step type '${safeStepId}' not found`);
    throw new CliExit(1);
  }
}

// ============================================================================
// Dispatcher
// ============================================================================

/** The ``step`` Typer sub-app (with the nested ``catalog`` app). */
export const STEP_GROUP: GroupSpec = {
  name: 'step',
  help: 'Manage workflow step types',
  commands: [
    {
      name: 'catalog',
      help: 'Manage step catalogs',
      run: (args) => runWorkflowStepCatalogCommand(args),
    },
    defineCommand({ name: 'list', help: 'List installed step types (built-in and custom).' }, () => {
      workflowStepList();
    }),
    defineCommand(
      {
        name: 'add',
        help: 'Install a custom step type from the step catalog.',
        arguments: [{ name: 'step_id', help: 'Step type ID from catalog', required: true }],
      },
      async (parsed) => {
        await workflowStepAdd(String(parsed.args.step_id));
      },
    ),
    defineCommand(
      {
        name: 'remove',
        help: 'Uninstall a custom step type.',
        arguments: [{ name: 'step_id', help: 'Step type ID to uninstall', required: true }],
      },
      (parsed) => {
        workflowStepRemove(String(parsed.args.step_id));
      },
    ),
    defineCommand(
      {
        name: 'search',
        help: 'Search the step type catalog.',
        arguments: [{ name: 'query', help: 'Search query', required: false }],
      },
      async (parsed) => {
        const query = parsed.args.query;
        await workflowStepSearch(query === null || query === undefined ? null : String(query));
      },
    ),
    defineCommand(
      {
        name: 'info',
        help: 'Show details for a step type.',
        arguments: [{ name: 'step_id', help: 'Step type ID', required: true }],
      },
      async (parsed) => {
        await workflowStepInfo(String(parsed.args.step_id));
      },
    ),
  ],
};

/**
 * Run ``specify workflow step <args>``; returns the exit code.
 *
 * @param args argv after ``workflow step``.
 */
export async function runWorkflowStepCommand(args: string[]): Promise<number> {
  return dispatchGroup(STEP_GROUP, args, 'specify workflow step');
}
