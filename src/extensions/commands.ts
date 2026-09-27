/**
 * @oakoliver/specify-cli - ``specify extension`` CLI adapter
 *
 * Port of ``specify_cli/extensions/_commands.py`` registration plus the
 * ``command_list.py``, ``command_add.py``, ``command_remove.py``,
 * ``command_search.py``, ``command_info.py``, ``command_enable.py``,
 * ``command_disable.py``, ``command_set_priority.py`` and
 * ``command_update.py`` handlers.
 *
 * @module extensions/commands
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type GroupSpec,
  type ParsedArgs,
  UsageError,
  defineCommand,
  dispatchGroup,
  parseArgs,
  type CommandSpec,
  runCommand,
} from '../cli-args.js';
import { CliExit, Panel, confirm, console, escapeMarkup } from '../console.js';
import { emitJson, emitJsonError, installedListItem } from '../installed-list-json.js';
import { resolveSpecifyProjectRoot } from '../project.js';
import { isHttpsOrLocalhostHttp } from '../download-security.js';
import { formatClineCommandName } from '../integrations/cline.js';
import { formatForgeCommandName } from '../integrations/forge.js';
import { urlHostname, urlparse, urlPort } from '../bundles/pycompat.js';
import { CATALOG_APP_HELP, CATALOG_GROUP } from './catalog/commands.js';
import {
  commandSafeId,
  getSpeckitVersion,
  installExtensionFromUrl,
  loadInitOptions,
  locateBundledExtension,
  refreshEventsAndWarn,
  requireSpecifyProject,
  resolveCatalogExtension,
  resolveInstalledExtension,
} from './command-shared.js';
import { runUpdateCommand } from './command-update-transaction.js';
import { resolveStrictFalse, unlink } from './fs-utils.js';
import { CompatibilityError, ExtensionError, ValidationError } from './errors.js';
import { ExtensionCatalog } from './extension-catalog.js';
import { HookExecutor } from './hooks.js';
import { ExtensionManager } from './manager.js';
import { type Dict, type ExtensionManifest, REINSTALL_COMMAND, isMapping, normalizePriority } from './manifest.js';

// Shared ``_commands.py`` helpers, re-exported under the conventional module.
export {
  commandSafeId,
  installExtensionFromUrl,
  refreshEventsAndWarn,
  resolveCatalogExtension,
  resolveInstalledExtension,
  validateSafeCacheDir,
} from './command-shared.js';
export { runUpdateCommand } from './command-update-transaction.js';
export { runExtensionCatalogCommand } from './catalog/commands.js';

// ============================================================================
// Helpers
// ============================================================================

function s(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

function expandUser(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Python ``f"{n:,}"`` for numbers. */
function groupDigits(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  const [intPart, frac] = String(n).split('.');
  return Number(intPart).toLocaleString('en-US') + (frac ? `.${frac}` : '');
}

function statsLine(ext: Dict): string[] {
  const stats: string[] = [];
  const downloads = ext.downloads;
  if (downloads !== null && downloads !== undefined) {
    stats.push(
      typeof downloads === 'number' && typeof downloads !== 'boolean'
        ? `Downloads: ${groupDigits(downloads)}`
        : `Downloads: ${escapeMarkup(s(downloads))}`,
    );
  }
  const stars = ext.stars;
  if (stars !== null && stars !== undefined) stats.push(`Stars: ${escapeMarkup(s(stars))}`);
  return stats;
}

function configHomeReport(
  extensionId: string,
  deployed: string[],
  skipped: string[],
  failed: string[],
): string {
  const configHome = `.specify/extensions/${escapeMarkup(String(extensionId))}`;
  if (deployed.length) {
    console.print('\n[bold cyan]Config scaffolded:[/bold cyan]');
    for (const cfg of deployed) console.print(`  • ${configHome}/${escapeMarkup(String(cfg))}`);
  }
  if (skipped.length) {
    console.print(`\n[dim]Config files already exist (preserved): ${escapeMarkup(skipped.join(', '))}[/dim]`);
  }
  if (failed.length) {
    console.print(
      `\n[yellow]Warning:[/yellow] Config templates not scaffolded: ` +
        `${escapeMarkup(failed.join(', '))}. ` +
        'Verify the extension manifest and template files.',
    );
  }
  return configHome;
}

// ============================================================================
// list
// ============================================================================

/** ``specify extension list``. */
export async function extensionList(opts: { available?: boolean; all?: boolean; json?: boolean } = {}): Promise<void> {
  if (opts.json) {
    try {
      const projectRoot = resolveSpecifyProjectRoot();
      const manager = new ExtensionManager(projectRoot);
      const installed = manager.listInstalled().sort((a, b) => {
        const pa = normalizePriority(a.priority);
        const pb = normalizePriority(b.priority);
        if (pa !== pb) return pa - pb;
        const ia = String(a.id ?? '');
        const ib = String(b.id ?? '');
        return ia < ib ? -1 : ia > ib ? 1 : 0;
      });
      emitJson(installed.map((ext) => installedListItem(ext as unknown as Dict, { includeHooks: true })));
      return;
    } catch (error) {
      if (error instanceof CliExit) throw error;
      emitJsonError(error as Error);
    }
  }

  const projectRoot = requireSpecifyProject();
  const manager = new ExtensionManager(projectRoot);
  const installed = manager.listInstalled();

  if (!installed.length && !(opts.available || opts.all)) {
    console.print('[yellow]No extensions installed.[/yellow]');
    console.print('\nInstall an extension with:');
    console.print('  specify extension add <extension-name>');
    return;
  }

  if (installed.length) {
    console.print('\n[bold cyan]Installed Extensions:[/bold cyan]\n');
    for (const ext of installed) {
      const enabled = Boolean(ext.enabled);
      const statusIcon = enabled ? '✓' : '✗';
      const statusColor = enabled ? 'green' : 'red';
      console.print(
        `  [${statusColor}]${statusIcon}[/${statusColor}] [bold]${escapeMarkup(ext.name)}[/bold] (v${escapeMarkup(s(ext.version))})`,
      );
      console.print(`     [dim]${escapeMarkup(ext.id)}[/dim]`);
      console.print(`     ${escapeMarkup(ext.description)}`);
      console.print(
        `     Commands: ${ext.command_count} | Hooks: ${ext.hook_count} | Priority: ${ext.priority} | Status: ${enabled ? 'Enabled' : 'Disabled'}`,
      );
      console.print();
    }
  }

  if (opts.available || opts.all) {
    console.print('\nInstall an extension:');
    console.print('  [cyan]specify extension add <name>[/cyan]');
  }
}

// ============================================================================
// add
// ============================================================================

/** ``specify extension add``. */
export async function extensionAdd(
  extension: string,
  opts: { dev?: boolean; fromUrl?: string | null; force?: boolean; priority?: number } = {},
): Promise<void> {
  const dev = opts.dev ?? false;
  const fromUrl = opts.fromUrl ?? null;
  const force = opts.force ?? false;
  const priority = opts.priority ?? 10;

  const projectRoot = requireSpecifyProject();
  if (priority < 1) {
    console.print('[red]Error:[/red] Priority must be a positive integer (1 or higher)');
    throw new CliExit(1);
  }

  const manager = new ExtensionManager(projectRoot);
  const speckitVersion = getSpeckitVersion();

  if (force) console.print('[yellow]--force:[/yellow] Will overwrite if already installed');

  let safeUrl = '';
  if (fromUrl && !dev) {
    let hostname: string | null;
    try {
      const parsed = urlparse(fromUrl);
      hostname = urlHostname(parsed);
      urlPort(parsed);
    } catch {
      console.print(`[red]Error:[/red] Invalid URL: ${escapeMarkup(fromUrl)}`);
      throw new CliExit(1);
    }
    if (!hostname) {
      console.print(`[red]Error:[/red] Invalid URL: ${escapeMarkup(fromUrl)}`);
      throw new CliExit(1);
    }
    if (!isHttpsOrLocalhostHttp(fromUrl)) {
      console.print('[red]Error:[/red] URL must use HTTPS for security.');
      console.print('HTTP is only allowed for loopback URLs.');
      throw new CliExit(1);
    }

    safeUrl = escapeMarkup(fromUrl);
    console.print();
    console.print(
      new Panel(
        '[bold]You are installing an extension directly from an external URL,\n' +
          'bypassing your trusted (install-allowed) extension catalogs.[/bold]\n\n' +
          `URL: ${safeUrl}\n\n` +
          'Only install extensions from sources you trust.',
        {
          title: '[bold yellow]⚠ Untrusted Source[/bold yellow]',
          borderStyle: 'yellow',
          padding: [1, 2],
        },
      ),
    );
    console.print();
    const ok = await confirm('Continue with installation?', { default: false });
    if (!ok) {
      console.print('Cancelled');
      throw new CliExit(0);
    }
  }

  const safeExtension = escapeMarkup(extension);

  try {
    const manifest: ExtensionManifest = await console.status(
      `[cyan]Installing extension: ${safeExtension}[/cyan]`,
      async () => {
        if (dev) {
          const sourcePath = resolveStrictFalse(expandUser(extension));
          const safeSourcePath = escapeMarkup(sourcePath);
          if (!existsSync(sourcePath)) {
            console.print(`[red]Error:[/red] Directory not found: ${safeSourcePath}`);
            throw new CliExit(1);
          }
          if (!existsSync(join(sourcePath, 'extension.yml'))) {
            console.print(`[red]Error:[/red] No extension.yml found in ${safeSourcePath}`);
            throw new CliExit(1);
          }
          if (force) {
            console.print(
              `[yellow]--force:[/yellow] Installing from [cyan]${safeSourcePath}[/cyan] (will overwrite if already installed)...`,
            );
          }
          return manager.installFromDirectory(sourcePath, speckitVersion, {
            priority,
            linkCommands: true,
            force,
          });
        }

        if (fromUrl) {
          console.print(`Downloading from ${safeUrl}...`);
          return installExtensionFromUrl(manager, projectRoot, fromUrl, speckitVersion, { priority, force });
        }

        let bundledPath = locateBundledExtension(extension);
        if (bundledPath !== null && bundledPath !== undefined) {
          return manager.installFromDirectory(bundledPath, speckitVersion, { priority, force });
        }

        const catalog = new ExtensionCatalog(projectRoot);
        const [extInfo, catalogError] = await resolveCatalogExtension(extension, catalog, 'add');
        if (catalogError) {
          console.print(
            `[red]Error:[/red] Could not query extension catalog: ${escapeMarkup(catalogError.message)}`,
          );
          throw new CliExit(1);
        }
        if (!extInfo) {
          console.print(`[red]Error:[/red] Extension '${safeExtension}' not found in catalog`);
          console.print('\nSearch available extensions:');
          console.print('  specify extension search');
          throw new CliExit(1);
        }

        const resolvedId = extInfo.id;
        if (resolvedId !== extension) {
          bundledPath = locateBundledExtension(resolvedId);
          if (bundledPath !== null && bundledPath !== undefined) {
            return manager.installFromDirectory(bundledPath, speckitVersion, { priority, force });
          }
        }

        if (extInfo.bundled && !extInfo.download_url) {
          console.print(
            `[red]Error:[/red] Extension '${escapeMarkup(String(extInfo.id))}' is bundled with spec-kit ` +
              'but could not be found in the installed package.',
          );
          console.print('\nThis usually means the spec-kit installation is incomplete or corrupted.');
          console.print('Try reinstalling spec-kit:');
          console.print(`  ${REINSTALL_COMMAND}`);
          throw new CliExit(1);
        }

        const installAllowed = Object.prototype.hasOwnProperty.call(extInfo, '_install_allowed')
          ? extInfo._install_allowed
          : true;
        if (!installAllowed) {
          const catalogName = escapeMarkup(s(extInfo._catalog_name ?? 'community'));
          const cmdId = commandSafeId(extInfo.id);
          console.print(
            `[red]Error:[/red] '${safeExtension}' was found in the ` +
              `'${catalogName}' catalog, which is discovery-only — a search ` +
              'surface, not an install source.',
          );
          console.print(
            '\nDiscovery-only catalogs are intentionally not installable so ' +
              "unvetted extensions can't be pulled in without review. Don't flip " +
              'such a catalog to install_allowed. Instead, once you\'ve vetted this ' +
              'extension:',
          );
          console.print(
            '  • install it directly from its archive URL:\n' +
              `      specify extension add ${cmdId} --from <archive-url>`,
          );
          console.print('  • or add it to a catalog you curate and control (install_allowed: true).');
          throw new CliExit(1);
        }

        const extensionId = extInfo.id as string;
        console.print(
          `Downloading ${escapeMarkup(s(extInfo.name))} v${escapeMarkup(s(extInfo.version ?? 'unknown'))}...`,
        );
        const archivePath = await catalog.downloadExtension(extensionId);
        try {
          return manager.installFromZip(archivePath, speckitVersion, {
            priority,
            force,
            catalogName: (extInfo._catalog_name ?? null) as string | null,
          });
        } finally {
          unlink(archivePath, true);
        }
      },
    );

    console.print('\n[green]✓[/green] Extension installed successfully!');
    console.print(`\n[bold]${escapeMarkup(s(manifest.name))}[/bold] (v${escapeMarkup(s(manifest.version))})`);
    console.print(`  ${escapeMarkup(s(manifest.description))}`);

    await refreshEventsAndWarn(projectRoot);

    for (const warning of manifest.warnings) {
      console.print(`\n[yellow]⚠  Compatibility warning:[/yellow] ${escapeMarkup(s(warning))}`);
    }

    const selectedAi = (loadInitOptions(projectRoot) as Dict).ai;
    const isCline = selectedAi === 'cline';
    const isForge = selectedAi === 'forge';

    console.print('\n[bold cyan]Provided commands:[/bold cyan]');
    for (const cmd of manifest.commands) {
      let cmdName: string = cmd.name;
      if (isCline) cmdName = formatClineCommandName(cmdName);
      else if (isForge) cmdName = formatForgeCommandName(cmdName);
      console.print(`  • ${escapeMarkup(s(cmdName))} - ${escapeMarkup(s(cmd.description ?? ''))}`);
    }

    const regMeta = manager.registry.get(manifest.id);
    let regSkills: unknown = regMeta ? regMeta.registered_skills ?? [] : [];
    if (!Array.isArray(regSkills)) regSkills = [];
    if ((regSkills as unknown[]).length) {
      console.print(`\n[green]✓[/green] ${(regSkills as unknown[]).length} agent skill(s) auto-registered`);
    }

    const [deployed, skipped, failed] = manager.scaffoldConfig(manifest.id);
    const configHome = configHomeReport(manifest.id, deployed, skipped, failed);
    if (failed.length || !(deployed.length || skipped.length)) {
      console.print('\n[yellow]⚠[/yellow]  Configuration may be required');
      console.print(`   Check: ${configHome}/`);
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      console.print(`\n[red]Validation Error:[/red] ${escapeMarkup(e.message)}`);
      throw new CliExit(1);
    }
    if (e instanceof CompatibilityError) {
      console.print(`\n[red]Compatibility Error:[/red] ${escapeMarkup(e.message)}`);
      throw new CliExit(1);
    }
    if (e instanceof ExtensionError) {
      console.print(`\n[red]Error:[/red] ${escapeMarkup(e.message)}`);
      throw new CliExit(1);
    }
    throw e;
  }
}

// ============================================================================
// remove
// ============================================================================

/** ``specify extension remove``. */
export async function extensionRemove(
  extension: string,
  opts: { keepConfig?: boolean; force?: boolean } = {},
): Promise<void> {
  const keepConfig = opts.keepConfig ?? false;
  const projectRoot = requireSpecifyProject();
  const manager = new ExtensionManager(projectRoot);

  const installed = manager.listInstalled();
  const [extensionId, displayName] = resolveInstalledExtension(extension, installed, 'remove') as [string, string];
  const safeExtensionId = escapeMarkup(String(extensionId));

  const extManifest = manager.getExtension(extensionId);
  const regMeta = manager.registry.get(extensionId);
  const registeredCommands = isMapping(regMeta) ? regMeta.registered_commands : undefined;
  let cmdCount: number;
  if (isMapping(registeredCommands)) {
    cmdCount = Math.max(
      0,
      ...Object.values(registeredCommands)
        .filter((v) => Array.isArray(v))
        .map((v) => (v as unknown[]).length),
    );
  } else {
    cmdCount = extManifest ? extManifest.commands.length : 0;
  }
  const rawSkills = regMeta ? regMeta.registered_skills : undefined;
  const skillCount = Array.isArray(rawSkills) ? rawSkills.length : 0;

  if (!opts.force) {
    console.print('\n[yellow]⚠  This will remove:[/yellow]');
    console.print(`   • ${cmdCount} command${cmdCount !== 1 ? 's' : ''} per agent`);
    if (skillCount) console.print(`   • ${skillCount} agent skill(s)`);
    console.print(`   • Extension directory: .specify/extensions/${safeExtensionId}/`);
    if (!keepConfig) console.print('   • Config files (will be backed up)');
    console.print();
    if (!(await confirm('Continue?'))) {
      console.print('Cancelled');
      throw new CliExit(0);
    }
  }

  const success = manager.remove(extensionId, keepConfig);
  if (success) {
    console.print(`\n[green]✓[/green] Extension '${escapeMarkup(String(displayName))}' removed successfully`);
    if (keepConfig) console.print(`\nConfig files preserved in .specify/extensions/${safeExtensionId}/`);
    else console.print(`\nConfig files backed up to .specify/extensions/.backup/${safeExtensionId}/`);
    await refreshEventsAndWarn(projectRoot);
    console.print(`\nTo reinstall: specify extension add ${safeExtensionId}`);
  } else {
    console.print('[red]Error:[/red] Failed to remove extension');
    throw new CliExit(1);
  }
}

// ============================================================================
// search
// ============================================================================

/** ``specify extension search``. */
export async function extensionSearch(
  query: string | null,
  opts: { tag?: string | null; author?: string | null; verified?: boolean } = {},
): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const catalog = new ExtensionCatalog(projectRoot);
  try {
    console.print('🔍 Searching extension catalog...');
    const results = await catalog.search({
      query,
      tag: opts.tag ?? null,
      author: opts.author ?? null,
      verifiedOnly: opts.verified ?? false,
    });

    if (!results.length) {
      console.print('\n[yellow]No extensions found matching criteria[/yellow]');
      if (query || opts.tag || opts.author || opts.verified) {
        console.print('\nTry:');
        console.print('  • Broader search terms');
        console.print('  • Remove filters');
        console.print('  • specify extension search (show all)');
      }
      throw new CliExit(0);
    }

    console.print(`\n[green]Found ${results.length} extension(s):[/green]\n`);
    for (const ext of results) {
      const verifiedBadge = ext.verified ? ' [green]✓ Verified[/green]' : '';
      console.print(`[bold]${escapeMarkup(s(ext.name))}[/bold] (v${escapeMarkup(s(ext.version))})${verifiedBadge}`);
      console.print(`  ${escapeMarkup(s(ext.description))}`);
      console.print(`\n  [dim]Author:[/dim] ${escapeMarkup(s(ext.author ?? 'Unknown'))}`);
      const extTags = ext.tags ?? [];
      if (Array.isArray(extTags) && extTags.length) {
        console.print(`  [dim]Tags:[/dim] ${escapeMarkup(extTags.map((t) => s(t)).join(', '))}`);
      }

      const catalogName = escapeMarkup(s(ext._catalog_name ?? ''));
      const installAllowed = Object.prototype.hasOwnProperty.call(ext, '_install_allowed') ? ext._install_allowed : true;
      if (catalogName) {
        if (installAllowed) console.print(`  [dim]Catalog:[/dim] ${catalogName}`);
        else console.print(`  [dim]Catalog:[/dim] ${catalogName} [yellow](discovery only — not installable)[/yellow]`);
      }

      const stats = statsLine(ext);
      if (stats.length) console.print(`  [dim]${stats.join(' | ')}[/dim]`);
      if (ext.repository) console.print(`  [dim]Repository:[/dim] ${escapeMarkup(s(ext.repository))}`);

      const cmdId = commandSafeId(ext.id);
      if (installAllowed) {
        console.print(`\n  [cyan]Install:[/cyan] specify extension add ${cmdId}`);
      } else {
        console.print(`\n  [yellow]⚠[/yellow]  Not directly installable from '${catalogName}' (discovery-only).`);
        console.print(`  Once vetted, install it directly: specify extension add ${cmdId} --from <archive-url>`);
        console.print("  Don't flip a discovery-only catalog to install_allowed — that's the vetting boundary.");
      }
      console.print();
    }
  } catch (e) {
    if (e instanceof ExtensionError) {
      console.print(`\n[red]Error:[/red] ${escapeMarkup(e.message)}`);
      console.print('\nTip: The catalog may be temporarily unavailable. Try again later.');
      throw new CliExit(1);
    }
    throw e;
  }
}

// ============================================================================
// info
// ============================================================================

/** Print formatted extension info from catalog data. */
export function printExtensionInfo(extInfo: Dict, manager: ExtensionManager): void {
  const verifiedBadge = extInfo.verified ? ' [green]✓ Verified[/green]' : '';
  console.print(`\n[bold]${escapeMarkup(s(extInfo.name))}[/bold] (v${escapeMarkup(s(extInfo.version))})${verifiedBadge}`);
  console.print(`ID: ${escapeMarkup(s(extInfo.id))}`);
  console.print();
  console.print(`${escapeMarkup(s(extInfo.description))}`);
  console.print();
  console.print(`[dim]Author:[/dim] ${escapeMarkup(s(extInfo.author ?? 'Unknown'))}`);
  console.print(`[dim]License:[/dim] ${escapeMarkup(s(extInfo.license ?? 'Unknown'))}`);
  if (extInfo.category) console.print(`[dim]Category:[/dim] ${escapeMarkup(s(extInfo.category))}`);
  if (extInfo.effect) console.print(`[dim]Effect:[/dim] ${escapeMarkup(s(extInfo.effect))}`);
  if (extInfo._catalog_name) {
    const installAllowed = Object.prototype.hasOwnProperty.call(extInfo, '_install_allowed')
      ? extInfo._install_allowed
      : true;
    const installNote = installAllowed ? '' : ' [yellow](discovery only)[/yellow]';
    console.print(`[dim]Source catalog:[/dim] ${escapeMarkup(s(extInfo._catalog_name))}${installNote}`);
  }
  console.print();

  if (extInfo.requires) {
    console.print('[bold]Requirements:[/bold]');
    const reqs = extInfo.requires;
    if (reqs.speckit_version) console.print(`  • Spec Kit: ${escapeMarkup(s(reqs.speckit_version))}`);
    if (reqs.tools) {
      for (const tool of reqs.tools) {
        const toolName = escapeMarkup(s(tool.name));
        const toolVersion = escapeMarkup(s(tool.version ?? 'any'));
        const required = tool.required ? ' (required)' : ' (optional)';
        console.print(`  • ${toolName}: ${toolVersion}${required}`);
      }
    }
    console.print();
  }

  if (extInfo.provides) {
    console.print('[bold]Provides:[/bold]');
    const provides = extInfo.provides;
    if (provides.commands) console.print(`  • Commands: ${escapeMarkup(s(provides.commands))}`);
    if (provides.hooks) console.print(`  • Hooks: ${escapeMarkup(s(provides.hooks))}`);
    console.print();
  }

  const infoTags = extInfo.tags ?? [];
  if (Array.isArray(infoTags) && infoTags.length) {
    console.print(`[bold]Tags:[/bold] ${escapeMarkup(infoTags.map((t) => s(t)).join(', '))}`);
    console.print();
  }

  const stats = statsLine(extInfo);
  if (stats.length) {
    console.print(`[bold]Statistics:[/bold] ${stats.join(' | ')}`);
    console.print();
  }

  console.print('[bold]Links:[/bold]');
  if (extInfo.repository) console.print(`  • Repository: ${escapeMarkup(s(extInfo.repository))}`);
  if (extInfo.homepage) console.print(`  • Homepage: ${escapeMarkup(s(extInfo.homepage))}`);
  if (extInfo.documentation) console.print(`  • Documentation: ${escapeMarkup(s(extInfo.documentation))}`);
  if (extInfo.changelog) console.print(`  • Changelog: ${escapeMarkup(s(extInfo.changelog))}`);
  console.print();

  const isInstalled = manager.registry.isInstalled(extInfo.id);
  const installAllowed = Object.prototype.hasOwnProperty.call(extInfo, '_install_allowed')
    ? extInfo._install_allowed
    : true;
  const safeId = escapeMarkup(s(extInfo.id));
  const cmdId = commandSafeId(extInfo.id);
  if (isInstalled) {
    console.print('[green]✓ Installed[/green]');
    const metadata = manager.registry.get(extInfo.id);
    const priority = normalizePriority(isMapping(metadata) ? metadata.priority : null);
    console.print(`[dim]Priority:[/dim] ${priority}`);
    console.print(`\nTo remove: specify extension remove ${cmdId}`);
  } else if (installAllowed) {
    console.print('[yellow]Not installed[/yellow]');
    console.print(`\n[cyan]Install:[/cyan] specify extension add ${cmdId}`);
  } else {
    const catalogName = escapeMarkup(s(extInfo._catalog_name ?? 'community'));
    console.print('[yellow]Not installed[/yellow]');
    console.print(
      `\n[yellow]⚠[/yellow]  '${safeId}' is in the '${catalogName}' catalog, which is ` +
        'discovery-only (a search surface, not an install source).',
    );
    const downloadUrl = extInfo.download_url;
    if (downloadUrl) {
      console.print(`Candidate archive (vet before installing): ${escapeMarkup(s(downloadUrl))}`);
      console.print(`Once vetted, install directly: specify extension add ${cmdId} --from <archive-url>`);
    } else {
      console.print(
        "Once you've vetted its release archive, install directly: " +
          `specify extension add ${cmdId} --from <archive-url>`,
      );
    }
    console.print(
      'Discovery-only catalogs are intentionally not install sources — don\'t set install_allowed on them.',
    );
  }
}

/** ``specify extension info``. */
export async function extensionInfo(extension: string): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const catalog = new ExtensionCatalog(projectRoot);
  const manager = new ExtensionManager(projectRoot);
  const installed = manager.listInstalled();

  const [resolvedInstalledId, resolvedInstalledName] = resolveInstalledExtension(extension, installed, 'info', true);
  const lookupKey = resolvedInstalledId ? resolvedInstalledId : extension;
  const [extInfo, catalogError] = await resolveCatalogExtension(lookupKey, catalog, 'info');

  if (extInfo) {
    printExtensionInfo(extInfo, manager);
    return;
  }

  if (resolvedInstalledId) {
    const extManifest = manager.getExtension(resolvedInstalledId);
    const metadata = manager.registry.get(resolvedInstalledId);
    const metadataIsDict = isMapping(metadata);
    if (!metadataIsDict) {
      console.print(
        '[yellow]Warning:[/yellow] Extension metadata appears to be corrupted; ' +
          'some information may be unavailable.',
      );
    }
    const version = metadataIsDict ? (metadata as Dict).version ?? 'unknown' : 'unknown';
    console.print(`\n[bold]${escapeMarkup(s(resolvedInstalledName))}[/bold] (v${escapeMarkup(s(version))})`);
    console.print(`ID: ${escapeMarkup(s(resolvedInstalledId))}`);
    console.print();

    if (extManifest) {
      console.print(`${escapeMarkup(s(extManifest.description))}`);
      console.print();
      const author = isMapping(extManifest.data.extension) ? extManifest.data.extension.author : undefined;
      if (author) console.print(`[dim]Author:[/dim] ${escapeMarkup(s(author))}`);
      if (extManifest.category) console.print(`[dim]Category:[/dim] ${escapeMarkup(s(extManifest.category))}`);
      if (extManifest.effect) console.print(`[dim]Effect:[/dim] ${escapeMarkup(s(extManifest.effect))}`);
      console.print();

      if (extManifest.commands.length) {
        const selectedAi = (loadInitOptions(projectRoot) as Dict).ai;
        const formatCommandName =
          selectedAi === 'cline' ? formatClineCommandName : selectedAi === 'forge' ? formatForgeCommandName : null;
        console.print('[bold]Commands:[/bold]');
        for (const cmd of extManifest.commands) {
          let cmdName: string = cmd.name;
          if (formatCommandName !== null) cmdName = formatCommandName(cmdName);
          console.print(`  • ${escapeMarkup(s(cmdName))}: ${escapeMarkup(s(cmd.description ?? ''))}`);
        }
        console.print();
      }
    }

    if (catalogError) {
      console.print(`[yellow]Catalog unavailable:[/yellow] ${escapeMarkup(catalogError.message)}`);
      console.print('[dim]Note: Using locally installed extension; catalog info could not be verified.[/dim]');
    } else {
      console.print('[yellow]Note:[/yellow] Not found in catalog (custom/local extension)');
    }
    console.print();
    console.print('[green]✓ Installed[/green]');
    const priority = normalizePriority(metadataIsDict ? (metadata as Dict).priority : null);
    console.print(`[dim]Priority:[/dim] ${priority}`);
    console.print(`\nTo remove: specify extension remove ${escapeMarkup(s(resolvedInstalledId))}`);
    return;
  }

  if (catalogError) {
    console.print(`[red]Error:[/red] Could not query extension catalog: ${escapeMarkup(catalogError.message)}`);
    console.print('\nTry again when online, or use the extension ID directly.');
  } else {
    console.print(`[red]Error:[/red] Extension '${escapeMarkup(extension)}' not found`);
    console.print('\nTry: specify extension search');
  }
  throw new CliExit(1);
}

// ============================================================================
// enable / disable
// ============================================================================

function setHooksEnabledInConfig(hookExecutor: HookExecutor, extensionId: string, enabled: boolean): void {
  const config = hookExecutor.getProjectConfig();
  if ('hooks' in config) {
    for (const hookName of Object.keys(config.hooks)) {
      for (const hook of config.hooks[hookName]) {
        if (hook.extension === extensionId) hook.enabled = enabled;
      }
    }
    hookExecutor.saveProjectConfig(config);
  }
}

/** ``specify extension enable``. */
export async function extensionEnable(extension: string): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const manager = new ExtensionManager(projectRoot);
  const hookExecutor = new HookExecutor(projectRoot);

  const installed = manager.listInstalled();
  const [extensionId, displayName] = resolveInstalledExtension(extension, installed, 'enable') as [string, string];

  const metadata = manager.registry.get(extensionId);
  if (metadata === null || !isMapping(metadata)) {
    console.print(
      `[red]Error:[/red] Extension '${escapeMarkup(String(extensionId))}' ` +
        'not found in registry (corrupted state)',
    );
    throw new CliExit(1);
  }
  if ('enabled' in metadata ? metadata.enabled : true) {
    console.print(`[yellow]Extension '${escapeMarkup(String(displayName))}' is already enabled[/yellow]`);
    throw new CliExit(0);
  }

  manager.registry.update(extensionId, { enabled: true });
  setHooksEnabledInConfig(hookExecutor, extensionId, true);

  console.print(`[green]✓[/green] Extension '${escapeMarkup(String(displayName))}' enabled`);
  await refreshEventsAndWarn(projectRoot);

  let deployed: string[];
  let skipped: string[];
  let failed: string[];
  try {
    [deployed, skipped, failed] = manager.scaffoldConfig(extensionId);
  } catch (exc) {
    console.print(
      `\n[yellow]Warning:[/yellow] Failed to scaffold config for extension '${escapeMarkup(String(displayName))}'.`,
    );
    console.print(`[dim]Details: ${escapeMarkup((exc as Error).message)}[/dim]`);
    [deployed, skipped, failed] = [[], [], []];
  }
  configHomeReport(extensionId, deployed, skipped, failed);
}

/** ``specify extension disable``. */
export async function extensionDisable(extension: string): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const manager = new ExtensionManager(projectRoot);
  const hookExecutor = new HookExecutor(projectRoot);

  const installed = manager.listInstalled();
  const [extensionId, displayName] = resolveInstalledExtension(extension, installed, 'disable') as [string, string];

  const metadata = manager.registry.get(extensionId);
  if (metadata === null || !isMapping(metadata)) {
    console.print(
      `[red]Error:[/red] Extension '${escapeMarkup(String(extensionId))}' ` +
        'not found in registry (corrupted state)',
    );
    throw new CliExit(1);
  }
  if (!('enabled' in metadata ? metadata.enabled : true)) {
    console.print(`[yellow]Extension '${escapeMarkup(String(displayName))}' is already disabled[/yellow]`);
    throw new CliExit(0);
  }

  manager.registry.update(extensionId, { enabled: false });
  setHooksEnabledInConfig(hookExecutor, extensionId, false);

  console.print(`[green]✓[/green] Extension '${escapeMarkup(String(displayName))}' disabled`);
  console.print('\nCommands will no longer be available. Hooks will not execute.');
  console.print(`To re-enable: specify extension enable ${escapeMarkup(String(extensionId))}`);
  await refreshEventsAndWarn(projectRoot);
}

// ============================================================================
// set-priority
// ============================================================================

/** ``specify extension set-priority``. */
export async function extensionSetPriority(extension: string, priority: number): Promise<void> {
  const projectRoot = requireSpecifyProject();
  if (priority < 1) {
    console.print('[red]Error:[/red] Priority must be a positive integer (1 or higher)');
    throw new CliExit(1);
  }
  const manager = new ExtensionManager(projectRoot);
  const installed = manager.listInstalled();
  const [extensionId, displayName] = resolveInstalledExtension(extension, installed, 'set-priority') as [
    string,
    string,
  ];

  const metadata = manager.registry.get(extensionId);
  if (metadata === null || !isMapping(metadata)) {
    console.print(
      `[red]Error:[/red] Extension '${escapeMarkup(String(extensionId))}' ` +
        'not found in registry (corrupted state)',
    );
    throw new CliExit(1);
  }

  const rawPriority = metadata.priority;
  if (typeof rawPriority === 'number' && Number.isInteger(rawPriority) && rawPriority === priority) {
    console.print(`[yellow]Extension '${escapeMarkup(String(displayName))}' already has priority ${priority}[/yellow]`);
    throw new CliExit(0);
  }

  const oldPriority = normalizePriority(rawPriority);
  manager.registry.update(extensionId, { priority });

  console.print(
    `[green]✓[/green] Extension '${escapeMarkup(String(displayName))}' priority changed: ${oldPriority} → ${priority}`,
  );
  console.print('\n[dim]Lower priority = higher precedence in template resolution[/dim]');
}

// ============================================================================
// CLI adapter
// ============================================================================

const LIST_SPEC: CommandSpec = {
  name: 'list',
  help: 'List installed extensions.',
  options: [
    { name: 'available', flags: ['--available'], type: 'boolean', help: 'Show available extensions from catalog' },
    { name: 'all', flags: ['--all'], type: 'boolean', help: 'Show both installed and available' },
    { name: 'json', flags: ['--json'], type: 'boolean', help: 'Output installed extensions as JSON' },
  ],
};

/** Group spec for ``specify extension``. */
export const EXTENSION_GROUP: GroupSpec = {
  name: 'extension',
  help: 'Manage spec-kit extensions',
  commands: [
    defineCommand(
      {
        name: 'add',
        help: 'Install an extension.',
        arguments: [{ name: 'extension', required: true, help: 'Extension name or path' }],
        options: [
          { name: 'dev', flags: ['--dev'], type: 'boolean', help: 'Install from local directory' },
          { name: 'from', flags: ['--from'], type: 'string', help: 'Install from custom URL' },
          { name: 'force', flags: ['--force'], type: 'boolean', help: 'Overwrite if already installed' },
          {
            name: 'priority',
            flags: ['--priority'],
            type: 'int',
            default: 10,
            showDefault: true,
            help: 'Resolution priority (lower = higher precedence, default 10)',
          },
        ],
      },
      (p: ParsedArgs) =>
        extensionAdd(String(p.args.extension), {
          dev: Boolean(p.options.dev),
          fromUrl: (p.options.from as string | undefined) ?? null,
          force: Boolean(p.options.force),
          priority: p.options.priority as number,
        }),
    ),
    defineCommand(
      {
        name: 'disable',
        help: 'Disable an extension without removing it.',
        arguments: [{ name: 'extension', required: true, help: 'Extension ID or name to disable' }],
      },
      (p: ParsedArgs) => extensionDisable(String(p.args.extension)),
    ),
    defineCommand(
      {
        name: 'enable',
        help: 'Enable a disabled extension.',
        arguments: [{ name: 'extension', required: true, help: 'Extension ID or name to enable' }],
      },
      (p: ParsedArgs) => extensionEnable(String(p.args.extension)),
    ),
    defineCommand(
      {
        name: 'info',
        help: 'Show detailed information about an extension.',
        arguments: [{ name: 'extension', required: true, help: 'Extension ID or name' }],
      },
      (p: ParsedArgs) => extensionInfo(String(p.args.extension)),
    ),
    {
      name: 'list',
      help: 'List installed extensions.',
      run: (args, progName) => runListCommand(args, progName),
    },
    defineCommand(
      {
        name: 'remove',
        help: 'Uninstall an extension.',
        arguments: [{ name: 'extension', required: true, help: 'Extension ID or name to remove' }],
        options: [
          { name: 'keepConfig', flags: ['--keep-config'], type: 'boolean', help: "Don't remove config files" },
          { name: 'force', flags: ['--force'], type: 'boolean', help: 'Skip confirmation' },
        ],
      },
      (p: ParsedArgs) =>
        extensionRemove(String(p.args.extension), {
          keepConfig: Boolean(p.options.keepConfig),
          force: Boolean(p.options.force),
        }),
    ),
    defineCommand(
      {
        name: 'search',
        help: 'Search for available extensions in catalog.',
        arguments: [{ name: 'query', required: false, help: 'Search query (optional)' }],
        options: [
          { name: 'tag', flags: ['--tag'], type: 'string', help: 'Filter by tag' },
          { name: 'author', flags: ['--author'], type: 'string', help: 'Filter by author' },
          { name: 'verified', flags: ['--verified'], type: 'boolean', help: 'Show only verified extensions' },
        ],
      },
      (p: ParsedArgs) =>
        extensionSearch((p.args.query as string | undefined) ?? null, {
          tag: (p.options.tag as string | undefined) ?? null,
          author: (p.options.author as string | undefined) ?? null,
          verified: Boolean(p.options.verified),
        }),
    ),
    defineCommand(
      {
        name: 'set-priority',
        help: 'Set the resolution priority of an installed extension.',
        arguments: [
          { name: 'extension', required: true, help: 'Extension ID or name' },
          { name: 'priority', required: true, type: 'int', help: 'New priority (lower = higher precedence)' },
        ],
      },
      (p: ParsedArgs) => extensionSetPriority(String(p.args.extension), p.args.priority as number),
    ),
    defineCommand(
      {
        name: 'update',
        help: 'Update extension(s) to latest version.',
        arguments: [{ name: 'extension', required: false, help: 'Extension ID or name to update (or all)' }],
      },
      (p: ParsedArgs) => runUpdateCommand((p.args.extension as string | undefined) ?? null),
    ),
    {
      name: 'catalog',
      help: CATALOG_APP_HELP,
      run: (args, progName) => dispatchGroup(CATALOG_GROUP, args, progName),
    },
  ],
};

/** ``extension list`` keeps parse failures on the JSON error contract when ``--json`` is given. */
async function runListCommand(args: string[], progName: string): Promise<number> {
  if (args.includes('--json') && !args.includes('--help')) {
    try {
      parseArgs(LIST_SPEC, args, progName);
    } catch (e) {
      if (e instanceof UsageError) {
        try {
          emitJsonError(e, e.exitCode);
        } catch (exit) {
          if (exit instanceof CliExit) return exit.code;
          throw exit;
        }
      }
      throw e;
    }
  }
  return runCommand(LIST_SPEC, args, progName, (p: ParsedArgs) =>
    extensionList({
      available: Boolean(p.options.available),
      all: Boolean(p.options.all),
      json: Boolean(p.options.json),
    }),
  );
}

/**
 * ``specify extension ...`` dispatcher. ``args`` excludes the ``extension``
 * word (e.g. ``['catalog', 'list']``). Returns the process exit code.
 */
export async function runExtensionCommand(args: string[]): Promise<number> {
  try {
    return await dispatchGroup(EXTENSION_GROUP, args, 'specify extension');
  } catch (e) {
    if (e instanceof CliExit) return e.code;
    throw e;
  }
}
