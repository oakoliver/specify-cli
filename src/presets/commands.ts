/**
 * @oakoliver/specify-cli - ``specify preset`` CLI commands
 *
 * Port of ``specify_cli/presets/_commands.py`` and the ``command_*.py``
 * handlers (list, add, remove, update, search, resolve, info, set-priority,
 * enable, disable). The nested ``catalog`` group lives in
 * ``src/presets/catalog/commands.ts``.
 *
 * @module presets/commands
 */

import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import { getSpeckitVersion, locateBundledPreset } from '../assets.js';
import { resolveGithubReleaseAssetApiUrl } from '../authentication/github-http.js';
import {
  UsageError,
  defineCommand,
  dispatchGroup,
  parseArgs,
  reportUsageError,
  runHandled,
  type CommandSpec,
  type GroupSpec,
  type ParsedArgs,
  type SubcommandDef,
} from '../cli-args.js';
import { CliExit, console, echo, escapeMarkup } from '../console.js';
import {
  archiveFormatFromName,
  archiveSuffix,
  detectArchiveFormat,
  isHttpsOrLocalhostHttp,
  isSafeDownloadRedirect,
  readResponseLimited,
} from '../download-security.js';
import { REINSTALL_COMMAND, normalizePriority } from '../extensions/index.js';
import { emitJson, emitJsonError, installedListItem } from '../installed-list-json.js';
import { URLError, githubProviderHosts, openUrl } from '../authentication/http.js';
import { requireSpecifyProject, resolveSpecifyProjectRoot } from '../project.js';
import { presetCatalogGroup } from './catalog/commands.js';
import { PresetCatalog } from './catalog.js';
import { PresetManager, type UnmetExtensionDependency } from './manager.js';
import {
  PresetCompatibilityError,
  PresetError,
  PresetManifest,
  PresetValidationError,
  pathExists,
  pyStr,
  pyTruthy,
} from './manifest.js';
import { PresetResolver } from './resolver.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

// ============================================================================
// Shared CLI infrastructure (``_commands.py``)
// ============================================================================

/**
 * Lowest priority a user may request. Lower numbers win resolution, so the
 * stack is anchored at 1.
 */
export const MINIMUM_PRESET_PRIORITY = 1;

/** Render argv as a copy-pastable PowerShell command. */
export function renderPowershellArgv(argv: string[]): string {
  return '& ' + argv.map((arg) => "'" + arg.replace(/'/g, "''") + "'").join(' ');
}

/** Python ``shlex.quote``. */
export function shlexQuote(s: string): string {
  if (!s) return "''";
  if (/^[\w@%+=:,./-]+$/.test(s) && /^[\x00-\x7f]*$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'"'"'`) + "'";
}

/** Python ``shlex.join``. */
export function shlexJoin(argv: string[]): string {
  return argv.map(shlexQuote).join(' ');
}

/** Reject a non-positive priority before destructive work begins. */
export function validatePriority(priority: number): void {
  if (priority < MINIMUM_PRESET_PRIORITY) {
    console.print(
      `[red]Error:[/red] Priority must be a positive integer (${MINIMUM_PRESET_PRIORITY} or higher)`,
    );
    throw new CliExit(1);
  }
}

/** Re-export of ``_require_specify_project`` (src/project.ts). */
export { requireSpecifyProject };

/**
 * Return an extension ID that is safe to embed in a suggested shell command
 * (upstream ``extensions._commands._command_safe_id``).
 */
export function commandSafeId(rawId: unknown, placeholder = '<extension-id>'): string {
  const text = pyStr(rawId);
  if (text.startsWith('-')) return placeholder;
  const candidate = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (/^[a-z0-9-]+$/.test(candidate)) return text;
  return placeholder;
}

// ============================================================================
// preset add
// ============================================================================

/** Warn when a preset's declared extension dependencies are unsatisfied. */
export function warnUnmetExtensionDependencies(manager: PresetManager, manifest: PresetManifest): void {
  const unmet: UnmetExtensionDependency[] = manager.findUnmetExtensionDependencies(manifest);
  if (!unmet.length) return;

  console.print();
  console.print('[yellow]![/yellow]  This preset depends on extensions that are not satisfied:');
  let needsCatalog = false;
  for (const dep of unmet) {
    let usesCatalog = false;
    const extensionId = escapeMarkup(dep.id);
    const commandId = commandSafeId(dep.id);
    const reason = dep.reason;
    let label: string;
    let remedy: string;
    if (reason === 'missing') {
      console.print(`    [yellow]${extensionId}[/yellow] is not installed`);
      label = 'Install with';
      remedy = `specify extension add ${commandId}`;
      usesCatalog = true;
    } else if (reason === 'corrupt') {
      console.print(`    [yellow]${extensionId}[/yellow] has an unreadable registry entry`);
      label = 'Reinstall with';
      remedy = `specify extension add ${commandId} --force`;
      usesCatalog = true;
    } else if (reason === 'stale') {
      console.print(`    [yellow]${extensionId}[/yellow] is registered but its files are missing`);
      label = 'Reinstall with';
      remedy = `specify extension add ${commandId} --force`;
      usesCatalog = true;
    } else if (reason === 'disabled') {
      console.print(`    [yellow]${extensionId}[/yellow] is installed but disabled`);
      label = 'Enable with';
      remedy = `specify extension enable ${commandId}`;
    } else {
      console.print(
        `    [yellow]${extensionId}[/yellow] ` +
          `${escapeMarkup(pyStr(dep.installed))} does not satisfy ` +
          `${escapeMarkup(pyStr(dep.version))}`,
      );
      label = 'Needs';
      remedy = `a release of ${commandId} satisfying ${escapeMarkup(pyStr(dep.version))}`;
    }
    console.print(`      ${label}: ${remedy}`);
    needsCatalog = needsCatalog || usesCatalog;
  }
  console.print();
  console.print('[dim]The preset is installed.[/dim]');
  if (unmet.some((d) => ['missing', 'corrupt', 'stale', 'disabled'].includes(d.reason))) {
    console.print(
      '[dim]Anything relying on an unavailable extension does nothing until that is resolved.[/dim]',
    );
  }
  if (unmet.some((d) => d.reason === 'version')) {
    console.print(
      '[dim]Where only a version constraint is unmet the extension is ' +
        'still used, so it may not behave as the preset expects.[/dim]',
    );
  }
  if (needsCatalog) {
    console.print(
      '[dim]If an extension is listed only in a discovery-only catalog, ' +
        'that command is refused and prints the ' +
        '--from <archive-url> form to use instead.[/dim]',
    );
  }
}

/** Options of {@link presetAdd} (mirrors the Typer parameters). */
export interface PresetAddOptions {
  presetId?: string | null;
  fromUrl?: string | null;
  dev?: string | null;
  priority?: number;
}

interface ResponseLike {
  geturl?: () => string;
  url?: string;
  getheader?: (name: string) => string | null | undefined;
  headers?: { get?: (name: string) => string | null };
}

function responseFinalUrl(resp: unknown, fallback: string): string {
  const r = resp as ResponseLike;
  if (r && typeof r.geturl === 'function') return r.geturl();
  if (r && typeof r.url === 'string' && r.url) return r.url;
  return fallback;
}

function responseContentType(resp: unknown): string | null {
  const r = resp as ResponseLike;
  if (r && typeof r.getheader === 'function') return r.getheader('Content-Type') ?? null;
  if (r && r.headers && typeof r.headers.get === 'function') return r.headers.get('Content-Type');
  return null;
}

/** Python ``urlparse(url).port`` validation (``ValueError`` on invalid ports). */
function validateUrlPort(url: string): void {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url);
  if (!m) return;
  const netloc = m[1];
  if ((netloc.includes('[') && !netloc.includes(']')) || (netloc.includes(']') && !netloc.includes('['))) {
    throw new Error('Invalid IPv6 URL');
  }
  const hostPort = netloc.includes('@') ? netloc.slice(netloc.lastIndexOf('@') + 1) : netloc;
  let portText: string | null = null;
  if (hostPort.startsWith('[')) {
    const after = hostPort.slice(hostPort.indexOf(']') + 1);
    if (after.startsWith(':')) portText = after.slice(1);
  } else if (hostPort.includes(':')) {
    portText = hostPort.slice(hostPort.indexOf(':') + 1);
  }
  if (portText) {
    if (!/^\d+$/.test(portText)) throw new Error('invalid port');
    if (Number(portText) > 65535) throw new Error('Port out of range 0-65535');
  }
}

const INSTALLED_MSG = (manifest: PresetManifest, priority: number) =>
  `[green]✓[/green] Preset '${manifest.name}' v${manifest.version} installed (priority ${priority})`;

/** Install a preset (``specify preset add``). Throws {@link CliExit} on failure. */
export async function presetAdd(opts: PresetAddOptions = {}): Promise<void> {
  const presetId = opts.presetId ?? null;
  let fromUrl = opts.fromUrl ?? null;
  const dev = opts.dev ?? null;
  const priority = opts.priority ?? 10;

  const projectRoot = requireSpecifyProject();
  validatePriority(priority);

  const manager = new PresetManager(projectRoot);
  const speckitVersion = getSpeckitVersion();
  let manifest: PresetManifest;

  try {
    if (dev) {
      const devPath = nodePath.resolve(dev);
      if (!pathExists(devPath)) {
        console.print(`[red]Error:[/red] Directory not found: ${dev}`);
        throw new CliExit(1);
      }
      console.print(`Installing preset from [cyan]${devPath}[/cyan]...`);
      manifest = manager.installFromDirectory(devPath, speckitVersion, priority);
      console.print(INSTALLED_MSG(manifest, priority));
    } else if (fromUrl) {
      try {
        validateUrlPort(fromUrl);
      } catch {
        console.print(`[red]Error:[/red] Invalid URL: ${escapeMarkup(fromUrl)}`);
        throw new CliExit(1);
      }

      const validateDownloadRedirect = (oldUrl: string, newUrl: string): void => {
        if (!isSafeDownloadRedirect(oldUrl, newUrl)) {
          throw new URLError(
            'redirect target must use HTTPS without entering a local ' +
              'target, or stay within loopback over HTTP',
          );
        }
      };

      if (!isHttpsOrLocalhostHttp(fromUrl)) {
        console.print(
          '[red]Error:[/red] URL must use HTTPS with a hostname and be ' +
            'a valid URL with a host. HTTP is only allowed for localhost, ' +
            '127.0.0.1, and ::1.',
        );
        throw new CliExit(1);
      }

      console.print(`Installing preset from [cyan]${escapeMarkup(fromUrl)}[/cyan]...`);
      const tmp = mkdtempSync(nodePath.join(tmpdir(), 'specify-preset-dl-'));
      try {
        let archivePath = nodePath.join(tmp, 'preset.archive');
        try {
          let extraHeaders: Record<string, string> | undefined;
          const resolvedFromUrl = (await resolveGithubReleaseAssetApiUrl(fromUrl, openUrl, {
            githubHosts: githubProviderHosts(),
          })) as string | null | undefined;
          if (resolvedFromUrl) {
            fromUrl = resolvedFromUrl;
            extraHeaders = { Accept: 'application/octet-stream' };
          }
          const effectiveUrl = fromUrl as string;
          const response = await openUrl(effectiveUrl, {
            timeout: 60,
            extraHeaders,
            redirectValidator: validateDownloadRedirect,
          });
          const finalUrl = responseFinalUrl(response, effectiveUrl);
          if (!isHttpsOrLocalhostHttp(finalUrl)) {
            console.print(
              '[red]Error:[/red] Preset URL redirected to a disallowed URL: ' +
                `${finalUrl}. Redirect targets must use HTTPS with a hostname, ` +
                'or HTTP for localhost (127.0.0.1, ::1).',
            );
            throw new CliExit(1);
          }
          const archiveData = await readResponseLimited(response as Parameters<typeof readResponseLimited>[0], {
            errorType: PresetError,
            label: `preset ${effectiveUrl}`,
          });
          const contentType = responseContentType(response);
          writeFileSync(archivePath, archiveData);
          const formatSource = archiveFormatFromName(finalUrl) !== null ? finalUrl : effectiveUrl;
          const archiveFormat = detectArchiveFormat(archivePath, {
            sourceName: formatSource,
            contentType,
            errorType: PresetError,
          });
          const detectedPath = nodePath.join(tmp, `preset${archiveSuffix(archiveFormat)}`);
          renameSync(archivePath, detectedPath);
          archivePath = detectedPath;
        } catch (e) {
          if (e instanceof CliExit) throw e;
          const message = e instanceof Error ? e.message : String(e);
          console.print(`[red]Error:[/red] Failed to download: ${escapeMarkup(message)}`);
          throw new CliExit(1);
        }

        manifest = manager.installFromZip(archivePath, speckitVersion, priority);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
      console.print(INSTALLED_MSG(manifest, priority));
    } else if (presetId) {
      const bundledPath = locateBundledPreset(presetId);
      if (bundledPath) {
        console.print(`Installing bundled preset [cyan]${presetId}[/cyan]...`);
        manifest = manager.installFromDirectory(bundledPath, speckitVersion, priority);
        console.print(INSTALLED_MSG(manifest, priority));
      } else {
        const catalog = new PresetCatalog(projectRoot);
        const packInfo = await catalog.getPackInfo(presetId);

        if (!packInfo) {
          console.print(`[red]Error:[/red] Preset '${presetId}' not found in catalog`);
          throw new CliExit(1);
        }

        if (pyTruthy(packInfo.bundled) && !pyTruthy(packInfo.download_url)) {
          console.print(
            `[red]Error:[/red] Preset '${presetId}' is bundled with spec-kit ` +
              `but could not be found in the installed package.`,
          );
          console.print('\nThis usually means the spec-kit installation is incomplete or corrupted.');
          console.print('Try reinstalling spec-kit:');
          console.print(`  ${REINSTALL_COMMAND}`);
          throw new CliExit(1);
        }

        if (!pyTruthy('_install_allowed' in packInfo ? packInfo._install_allowed : true)) {
          const catalogName = '_catalog_name' in packInfo ? packInfo._catalog_name : 'unknown';
          console.print(
            `[red]Error:[/red] Preset '${presetId}' is from the '${pyStr(catalogName)}' catalog which is discovery-only (install not allowed).`,
          );
          console.print(
            'Add the catalog with --install-allowed or install from the preset\'s repository directly with --from.',
          );
          throw new CliExit(1);
        }

        console.print(`Installing preset [cyan]${pyStr('name' in packInfo ? packInfo.name : presetId)}[/cyan]...`);

        let archivePath: string | null = null;
        try {
          archivePath = await catalog.downloadPack(presetId);
          manifest = manager.installFromZip(archivePath, speckitVersion, priority, {
            catalogName: (packInfo._catalog_name ?? null) as string | null,
          });
          console.print(INSTALLED_MSG(manifest, priority));
        } finally {
          if (archivePath !== null && pathExists(archivePath)) {
            try {
              unlinkSync(archivePath);
            } catch {
              // missing_ok
            }
          }
        }
      }
    } else {
      console.print('[red]Error:[/red] Specify a preset ID, --from URL, or --dev path');
      throw new CliExit(1);
    }

    warnUnmetExtensionDependencies(manager, manifest);
  } catch (e) {
    if (e instanceof PresetCompatibilityError) {
      console.print(`[red]Compatibility Error:[/red] ${escapeMarkup(e.message)}`);
      throw new CliExit(1);
    }
    if (e instanceof PresetValidationError) {
      console.print(`[red]Validation Error:[/red] ${escapeMarkup(e.message)}`);
      throw new CliExit(1);
    }
    if (e instanceof PresetError) {
      console.print(`[red]Error:[/red] ${escapeMarkup(e.message)}`);
      throw new CliExit(1);
    }
    throw e;
  }
}

// ============================================================================
// preset list
// ============================================================================

function sortByResolution<T extends { priority?: unknown; id?: unknown }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const pa = (a.priority ?? 10) as number;
    const pb = (b.priority ?? 10) as number;
    if (pa !== pb) return pa - pb;
    const ia = pyStr(a.id ?? '');
    const ib = pyStr(b.id ?? '');
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

/** List installed presets (``specify preset list``). */
export function presetList(opts: { json?: boolean } = {}): void {
  if (opts.json) {
    try {
      const projectRoot = resolveSpecifyProjectRoot();
      const manager = new PresetManager(projectRoot);
      const installed = sortByResolution(manager.listInstalled());
      emitJson(installed.map((pack) => installedListItem(pack as unknown as Dict, { includeHooks: false })));
      return;
    } catch (error) {
      if (error instanceof CliExit) throw error;
      emitJsonError(error as Error);
    }
  }

  const projectRoot = requireSpecifyProject();
  const manager = new PresetManager(projectRoot);
  let installed = manager.listInstalled();

  if (!installed.length) {
    console.print('[yellow]No presets installed.[/yellow]');
    console.print('\nInstall a preset with:');
    console.print('  [cyan]specify preset add <pack-name>[/cyan]');
    return;
  }

  installed = sortByResolution(installed);

  console.print(
    '\n[bold cyan]Installed Presets[/bold cyan] [dim](in resolution order — highest precedence first)[/dim]\n',
  );
  for (const pack of installed) {
    const status = pyTruthy(pack.enabled ?? true) ? '[green]enabled[/green]' : '[red]disabled[/red]';
    const pri = pack.priority ?? 10;
    const name = escapeMarkup(pyStr(pack.name));
    const packId = escapeMarkup(pyStr(pack.id));
    const version = escapeMarkup(pyStr(pack.version));
    console.print(`  [bold]${name}[/bold] (${packId}) v${version} — ${status} — priority ${pri}`);
    console.print(`    ${escapeMarkup(pyStr(pack.description))}`);
    const tags = pack.tags;
    if (Array.isArray(tags) && tags.length) {
      const tagsStr = escapeMarkup(tags.map((t) => pyStr(t)).join(', '));
      console.print(`    [dim]Tags: ${tagsStr}[/dim]`);
    }
    console.print(`    [dim]Templates: ${pack.template_count}[/dim]`);
    console.print();
  }

  console.print(
    '[dim]Lower priority number = higher precedence. Ties are broken by preset id (alphabetical).[/dim]',
  );
}

// ============================================================================
// preset remove
// ============================================================================

/** Remove an installed preset (``specify preset remove``). */
export function presetRemove(presetId: string): void {
  const projectRoot = requireSpecifyProject();
  const manager = new PresetManager(projectRoot);

  if (!manager.registry.isInstalled(presetId)) {
    console.print(`[red]Error:[/red] Preset '${presetId}' is not installed`);
    throw new CliExit(1);
  }

  if (manager.remove(presetId)) {
    console.print(`[green]✓[/green] Preset '${presetId}' removed successfully`);
  } else {
    console.print(`[red]Error:[/red] Failed to remove preset '${presetId}'`);
    throw new CliExit(1);
  }
}

// ============================================================================
// preset update
// ============================================================================

/** Replace an installed preset using the normal remove and add flows (``specify preset update``). */
export async function presetUpdate(opts: {
  presetId: string;
  fromUrl?: string | null;
  dev?: string | null;
  priority?: number;
}): Promise<void> {
  const presetId = opts.presetId;
  const fromUrl = opts.fromUrl ?? null;
  const dev = opts.dev ?? null;
  const priority = opts.priority ?? 10;

  if (fromUrl !== null && dev !== null) {
    console.print('[red]Error:[/red] --from and --dev are mutually exclusive');
    throw new CliExit(1);
  }
  if (fromUrl === '') {
    console.print('[red]Error:[/red] --from must not be empty');
    throw new CliExit(1);
  }
  if (dev === '') {
    console.print('[red]Error:[/red] --dev must not be empty');
    throw new CliExit(1);
  }

  validatePriority(priority);

  const projectRoot = requireSpecifyProject();
  const manager = new PresetManager(projectRoot);
  if (!manager.registry.isInstalled(presetId)) {
    console.print(`[red]Error:[/red] Preset '${presetId}' is not installed`);
    throw new CliExit(1);
  }

  presetCommandHooks.presetRemove(presetId);

  const retryArgs = ['specify', 'preset', 'add'];
  const retryOptions: string[] = [];
  if (fromUrl !== null) retryOptions.push('--from', fromUrl);
  if (dev !== null) retryOptions.push('--dev', dev);
  retryOptions.push('--priority', String(priority));
  if (presetId.startsWith('-')) retryArgs.push(...retryOptions, '--', presetId);
  else retryArgs.push(presetId, ...retryOptions);

  const reportAddFailure = (): void => {
    let retryLabel: string;
    let renderedArgs: string;
    if (process.platform === 'win32') {
      retryLabel = 'Retry in PowerShell: ';
      renderedArgs = renderPowershellArgv(retryArgs);
    } else {
      retryLabel = 'Retry with: ';
      renderedArgs = shlexJoin(retryArgs);
    }
    console.print('[red]Error:[/red] Preset update failed; the previous preset was removed.');
    console.print(`${retryLabel}[cyan]${escapeMarkup(renderedArgs)}[/cyan]`, { softWrap: true });
  };

  try {
    await presetCommandHooks.presetAdd({ presetId, fromUrl, dev, priority });
  } catch (error) {
    if (error instanceof CliExit) {
      reportAddFailure();
      throw new CliExit(error.code || 1);
    }
    console.print(`[red]Error:[/red] ${escapeMarkup(error instanceof Error ? error.message : String(error))}`);
    reportAddFailure();
    throw new CliExit(1);
  }
}

/**
 * Patch points mirroring upstream's ``_commands.preset_add`` /
 * ``_commands.preset_remove`` indirection (tests monkeypatch these).
 */
export const presetCommandHooks: {
  presetAdd: (opts: PresetAddOptions) => Promise<void>;
  presetRemove: (presetId: string) => void;
} = {
  presetAdd: (opts) => presetAdd(opts),
  presetRemove: (id) => presetRemove(id),
};

// ============================================================================
// preset search
// ============================================================================

/** Search for presets in the catalog (``specify preset search``). */
export async function presetSearch(opts: { query?: string | null; tag?: string | null; author?: string | null } = {}): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const catalog = new PresetCatalog(projectRoot);

  let results: Dict[];
  try {
    results = await catalog.search({ query: opts.query ?? null, tag: opts.tag ?? null, author: opts.author ?? null });
  } catch (e) {
    if (e instanceof PresetError) {
      console.print(`[red]Error:[/red] ${escapeMarkup(e.message)}`);
      throw new CliExit(1);
    }
    throw e;
  }

  if (!results.length) {
    console.print('[yellow]No presets found matching your criteria.[/yellow]');
    return;
  }

  console.print(`\n[bold cyan]Presets (${results.length} found):[/bold cyan]\n`);
  for (const pack of results) {
    const name = escapeMarkup(pyStr('name' in pack ? pack.name : pack.id));
    const packId = escapeMarkup(pyStr(pack.id));
    const version = escapeMarkup(pyStr('version' in pack ? pack.version : '?'));
    console.print(`  [bold]${name}[/bold] (${packId}) v${version}`);
    console.print(`    ${escapeMarkup(pyStr('description' in pack ? pack.description : ''))}`);
    const tags = 'tags' in pack ? pack.tags : [];
    if (Array.isArray(tags) && tags.length) {
      console.print(`    [dim]Tags: ${escapeMarkup(tags.map((t) => pyStr(t)).join(', '))}[/dim]`);
    }
    console.print();
  }
}

// ============================================================================
// preset resolve
// ============================================================================

/** Show which template will be resolved for a given name (``specify preset resolve``). */
export function presetResolve(templateName: string): void {
  const isCommand = templateName.includes('.');
  const validName = isCommand
    ? /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(templateName)
    : /^[a-z0-9-]+$/.test(templateName);
  if (!validName) {
    echo(
      `Error: invalid template name '${templateName}'; ` +
        'use lowercase letters, digits, and hyphens, with non-empty ' +
        'dot-separated segments for commands',
      { err: true },
    );
    throw new CliExit(1);
  }

  const projectRoot = requireSpecifyProject();
  const resolver = new PresetResolver(projectRoot);
  const templateType = isCommand ? 'command' : 'template';

  const layers = resolver.collectAllLayers(templateName, templateType);
  const safeTemplateName = escapeMarkup(templateName);

  if (layers.length) {
    const displayLayer = layers[0];
    console.print(`  [bold]${safeTemplateName}[/bold]: ${escapeMarkup(displayLayer.path)}`);
    console.print(`    [dim](top layer from: ${escapeMarkup(displayLayer.source)})[/dim]`);

    const hasComposition = layers[0].strategy !== 'replace' && layers.some((l) => l.strategy !== 'replace');
    if (hasComposition) {
      let composed: string | null;
      try {
        composed = resolver.resolveContent(templateName, templateType);
      } catch (exc) {
        composed = null;
        console.print(
          `    [yellow]Warning: composition error: ${escapeMarkup(exc instanceof Error ? exc.message : String(exc))}[/yellow]`,
        );
      }
      if (composed === null) {
        console.print(
          "    [yellow]Warning: composition cannot produce output (no base layer with 'replace' strategy)[/yellow]",
        );
      } else {
        console.print(
          '    [dim]Final output is composed from multiple preset layers; the path above is the highest-priority contributing layer.[/dim]',
        );
      }
      console.print('\n  [bold]Composition chain:[/bold]');
      let effectiveBaseIdx: number | null = null;
      for (let idx = 0; idx < layers.length; idx++) {
        if (layers[idx].strategy === 'replace') {
          effectiveBaseIdx = idx;
          break;
        }
      }
      const contributing = effectiveBaseIdx !== null ? layers.slice(0, effectiveBaseIdx + 1) : layers;
      [...contributing].reverse().forEach((layer, i) => {
        let strategyLabel = layer.strategy;
        if (strategyLabel === 'replace' && i === 0) strategyLabel = 'base';
        console.print(
          `    ${i + 1}. \\[${escapeMarkup(strategyLabel)}] ${escapeMarkup(layer.source)} → ${escapeMarkup(layer.path)}`,
        );
      });
    }
  } else {
    const result = resolver.resolveWithSource(templateName, templateType);
    if (result) {
      console.print(`  [bold]${safeTemplateName}[/bold]: ${escapeMarkup(result.path)}`);
      console.print(`    [dim](from: ${escapeMarkup(result.source)})[/dim]`);
    } else {
      console.print(`  [yellow]${safeTemplateName}[/yellow]: not found`);
      console.print('    [dim]No template with this name exists in the resolution stack[/dim]');
    }
  }
}

// ============================================================================
// preset info
// ============================================================================

/** Show detailed information about a preset (``specify preset info``). */
export async function presetInfo(presetId: string): Promise<void> {
  const projectRoot = requireSpecifyProject();
  const safePresetId = escapeMarkup(presetId);
  const manager = new PresetManager(projectRoot);
  const localPack = manager.getPack(presetId);

  if (localPack) {
    console.print(`\n[bold cyan]Preset: ${escapeMarkup(pyStr(localPack.name))}[/bold cyan]\n`);
    console.print(`  ID:          ${escapeMarkup(pyStr(localPack.id))}`);
    console.print(`  Version:     ${escapeMarkup(pyStr(localPack.version))}`);
    console.print(`  Description: ${escapeMarkup(pyStr(localPack.description))}`);
    if (pyTruthy(localPack.author)) console.print(`  Author:      ${escapeMarkup(pyStr(localPack.author))}`);
    const localTags = localPack.tags;
    if (Array.isArray(localTags) && localTags.length) {
      console.print(`  Tags:        ${escapeMarkup(localTags.map((t) => pyStr(t)).join(', '))}`);
    }
    console.print(`  Templates:   ${localPack.templates.length}`);
    for (const tmpl of localPack.templates) {
      const tmplName = escapeMarkup(pyStr(tmpl.name));
      const tmplType = escapeMarkup(pyStr(tmpl.type));
      const tmplDesc = escapeMarkup(pyStr('description' in tmpl ? tmpl.description : ''));
      console.print(`    - ${tmplName} (${tmplType}): ${tmplDesc}`);
    }
    const presetData = (localPack.data.preset ?? {}) as Dict;
    const repo = presetData.repository;
    if (pyTruthy(repo)) console.print(`  Repository:  ${escapeMarkup(pyStr(repo))}`);
    const licenseVal = presetData.license;
    if (pyTruthy(licenseVal)) console.print(`  License:     ${escapeMarkup(pyStr(licenseVal))}`);
    console.print('\n  [green]Status: installed[/green]');
    const packMetadata = manager.registry.get(presetId);
    const priority = normalizePriority(packMetadata !== null ? packMetadata.priority ?? null : null);
    console.print(`  [dim]Priority:[/dim] ${priority}`);
    console.print();
    return;
  }

  const catalog = new PresetCatalog(projectRoot);
  let packInfo: Dict | null;
  try {
    packInfo = await catalog.getPackInfo(presetId);
  } catch (e) {
    if (!(e instanceof PresetError)) throw e;
    packInfo = null;
  }

  if (!packInfo) {
    console.print(`[red]Error:[/red] Preset '${presetId}' not found (not installed and not in catalog)`);
    throw new CliExit(1);
  }

  const name = escapeMarkup(pyStr('name' in packInfo ? packInfo.name : presetId));
  console.print(`\n[bold cyan]Preset: ${name}[/bold cyan]\n`);
  console.print(`  ID:          ${escapeMarkup(pyStr(packInfo.id))}`);
  console.print(`  Version:     ${escapeMarkup(pyStr('version' in packInfo ? packInfo.version : '?'))}`);
  console.print(`  Description: ${escapeMarkup(pyStr('description' in packInfo ? packInfo.description : ''))}`);
  if (pyTruthy(packInfo.author)) console.print(`  Author:      ${escapeMarkup(pyStr(packInfo.author))}`);
  const catalogTags = 'tags' in packInfo ? packInfo.tags : [];
  if (Array.isArray(catalogTags) && catalogTags.length) {
    console.print(`  Tags:        ${escapeMarkup(catalogTags.map((t) => pyStr(t)).join(', '))}`);
  }
  if (pyTruthy(packInfo.repository)) console.print(`  Repository:  ${escapeMarkup(pyStr(packInfo.repository))}`);
  if (pyTruthy(packInfo.license)) console.print(`  License:     ${escapeMarkup(pyStr(packInfo.license))}`);
  console.print('\n  [yellow]Status: not installed[/yellow]');
  console.print(`  Install with: [cyan]specify preset add ${safePresetId}[/cyan]`);
  console.print();
}

// ============================================================================
// preset set-priority / enable / disable
// ============================================================================

function requireInstalledMetadata(manager: PresetManager, presetId: string): Dict {
  if (!manager.registry.isInstalled(presetId)) {
    console.print(`[red]Error:[/red] Preset '${presetId}' is not installed`);
    throw new CliExit(1);
  }
  const metadata = manager.registry.get(presetId);
  if (metadata === null) {
    console.print(`[red]Error:[/red] Preset '${presetId}' not found in registry (corrupted state)`);
    throw new CliExit(1);
  }
  return metadata;
}

/** Set the resolution priority of an installed preset (``specify preset set-priority``). */
export function presetSetPriority(presetId: string, priority: number): void {
  const projectRoot = requireSpecifyProject();
  validatePriority(priority);

  const manager = new PresetManager(projectRoot);
  const metadata = requireInstalledMetadata(manager, presetId);

  const rawPriority = metadata.priority;
  if (typeof rawPriority === 'number' && Number.isInteger(rawPriority) && rawPriority === priority) {
    console.print(`[yellow]Preset '${presetId}' already has priority ${priority}[/yellow]`);
    throw new CliExit(0);
  }

  const oldPriority = normalizePriority(rawPriority ?? null);

  manager.registry.update(presetId, { priority });
  manager.reconcileConstitution(`Failed to reconcile constitution after changing priority for preset ${presetId}`);

  console.print(`[green]✓[/green] Preset '${presetId}' priority changed: ${oldPriority} → ${priority}`);
  console.print('\n[dim]Lower priority = higher precedence in template resolution[/dim]');
}

/** Enable a disabled preset (``specify preset enable``). */
export function presetEnable(presetId: string): void {
  const projectRoot = requireSpecifyProject();
  const manager = new PresetManager(projectRoot);
  const metadata = requireInstalledMetadata(manager, presetId);

  if (pyTruthy('enabled' in metadata ? metadata.enabled : true)) {
    console.print(`[yellow]Preset '${presetId}' is already enabled[/yellow]`);
    throw new CliExit(0);
  }

  manager.registry.update(presetId, { enabled: true });
  manager.reconcileConstitution(`Failed to reconcile constitution after enabling preset ${presetId}`);

  console.print(`[green]✓[/green] Preset '${presetId}' enabled`);
  console.print('\nTemplates from this preset will now be included in resolution.');
  console.print('[dim]Note: Previously registered commands/skills remain active.[/dim]');
}

/** Disable a preset without removing it (``specify preset disable``). */
export function presetDisable(presetId: string): void {
  const projectRoot = requireSpecifyProject();
  const manager = new PresetManager(projectRoot);
  const metadata = requireInstalledMetadata(manager, presetId);

  if (!pyTruthy('enabled' in metadata ? metadata.enabled : true)) {
    console.print(`[yellow]Preset '${presetId}' is already disabled[/yellow]`);
    throw new CliExit(0);
  }

  manager.registry.update(presetId, { enabled: false });
  manager.reconcileConstitution(`Failed to reconcile constitution after disabling preset ${presetId}`);

  console.print(`[green]✓[/green] Preset '${presetId}' disabled`);
  console.print('\nTemplates from this preset will be skipped during resolution.');
  console.print('[dim]Note: Previously registered commands/skills remain active until preset removal.[/dim]');
  console.print(`To re-enable: specify preset enable ${presetId}`);
}

// ============================================================================
// CLI wiring
// ============================================================================

const LIST_SPEC: CommandSpec = {
  name: 'list',
  help: 'List installed presets.',
  options: [{ name: 'json', flags: ['--json'], type: 'boolean', help: 'Output installed presets as JSON' }],
};

const ADD_SPEC: CommandSpec = {
  name: 'add',
  help: 'Install a preset.',
  arguments: [{ name: 'preset_id', required: false, help: 'Preset ID to install from catalog' }],
  options: [
    { name: 'from_url', flags: ['--from'], help: 'Install from a .zip, .tar.gz, or .tgz URL' },
    { name: 'dev', flags: ['--dev'], help: 'Install from local directory (development mode)' },
    {
      name: 'priority',
      flags: ['--priority'],
      type: 'int',
      default: 10,
      help: 'Resolution priority (lower = higher precedence, default 10)',
    },
  ],
};

const REMOVE_SPEC: CommandSpec = {
  name: 'remove',
  help: 'Remove an installed preset.',
  arguments: [{ name: 'preset_id', required: true, help: 'Preset ID to remove' }],
};

const UPDATE_SPEC: CommandSpec = {
  name: 'update',
  help: 'Replace an installed preset using the normal remove and add flows.',
  arguments: [{ name: 'preset_id', required: true, help: 'Installed preset ID to replace' }],
  options: [
    { name: 'from_url', flags: ['--from'], help: 'Install the replacement from a .zip, .tar.gz, or .tgz URL' },
    { name: 'dev', flags: ['--dev'], help: 'Install the replacement from a local directory (development mode)' },
    {
      name: 'priority',
      flags: ['--priority'],
      type: 'int',
      default: 10,
      help: 'Resolution priority for the replacement (default 10)',
    },
  ],
};

const SEARCH_SPEC: CommandSpec = {
  name: 'search',
  help: 'Search for presets in the catalog.',
  arguments: [{ name: 'query', required: false, help: 'Search query' }],
  options: [
    { name: 'tag', flags: ['--tag'], help: 'Filter by tag' },
    { name: 'author', flags: ['--author'], help: 'Filter by author' },
  ],
};

const RESOLVE_SPEC: CommandSpec = {
  name: 'resolve',
  help: 'Show which template will be resolved for a given name.',
  arguments: [{ name: 'template_name', required: true, help: 'Template name to resolve (e.g., spec-template)' }],
};

const INFO_SPEC: CommandSpec = {
  name: 'info',
  help: 'Show detailed information about a preset.',
  arguments: [{ name: 'preset_id', required: true, help: 'Preset ID to get info about' }],
};

const SET_PRIORITY_SPEC: CommandSpec = {
  name: 'set-priority',
  help: 'Set the resolution priority of an installed preset.',
  arguments: [
    { name: 'preset_id', required: true, help: 'Preset ID' },
    { name: 'priority', required: true, type: 'int', help: 'New priority (lower = higher precedence)' },
  ],
};

const ENABLE_SPEC: CommandSpec = {
  name: 'enable',
  help: 'Enable a disabled preset.',
  arguments: [{ name: 'preset_id', required: true, help: 'Preset ID to enable' }],
};

const DISABLE_SPEC: CommandSpec = {
  name: 'disable',
  help: 'Disable a preset without removing it.',
  arguments: [{ name: 'preset_id', required: true, help: 'Preset ID to disable' }],
};

function optStr(parsed: ParsedArgs, key: string): string | null {
  const v = parsed.options[key];
  return v === undefined || v === null ? null : String(v);
}

function argStr(parsed: ParsedArgs, key: string): string | null {
  const v = parsed.args[key];
  return v === undefined || v === null ? null : String(v);
}

/**
 * ``specify preset list`` keeps parse failures on the JSON error contract when
 * ``--json`` was requested (upstream ``InstalledListJSONCommand``).
 */
const listCommand: SubcommandDef = {
  name: 'list',
  help: LIST_SPEC.help,
  run: async (args, progName) => {
    const jsonOutput = args.includes('--json');
    let parsed: ParsedArgs;
    try {
      parsed = parseArgs(LIST_SPEC, args, progName);
    } catch (e) {
      if (e instanceof UsageError) {
        if (jsonOutput) {
          return runHandled(() => {
            emitJsonError(e, e.exitCode);
          }, progName);
        }
        return reportUsageError(e, progName);
      }
      throw e;
    }
    if (parsed.help) {
      return defineCommand(LIST_SPEC, () => 0).run(['--help'], progName);
    }
    return runHandled(() => presetList({ json: !!parsed.options.json }), progName);
  },
};

/** The ``specify preset`` Typer app. */
export const presetGroup: GroupSpec = {
  name: 'preset',
  help: 'Manage spec-kit presets',
  noArgsIsHelp: false,
  commands: [
    listCommand,
    defineCommand(ADD_SPEC, (p) =>
      presetAdd({
        presetId: argStr(p, 'preset_id'),
        fromUrl: optStr(p, 'from_url'),
        dev: optStr(p, 'dev'),
        priority: p.options.priority as number,
      }),
    ),
    defineCommand(REMOVE_SPEC, (p) => presetRemove(argStr(p, 'preset_id') as string)),
    defineCommand(UPDATE_SPEC, (p) =>
      presetUpdate({
        presetId: argStr(p, 'preset_id') as string,
        fromUrl: optStr(p, 'from_url'),
        dev: optStr(p, 'dev'),
        priority: p.options.priority as number,
      }),
    ),
    defineCommand(SEARCH_SPEC, (p) =>
      presetSearch({ query: argStr(p, 'query'), tag: optStr(p, 'tag'), author: optStr(p, 'author') }),
    ),
    defineCommand(RESOLVE_SPEC, (p) => presetResolve(argStr(p, 'template_name') as string)),
    defineCommand(INFO_SPEC, (p) => presetInfo(argStr(p, 'preset_id') as string)),
    defineCommand(SET_PRIORITY_SPEC, (p) =>
      presetSetPriority(argStr(p, 'preset_id') as string, p.args.priority as number),
    ),
    defineCommand(ENABLE_SPEC, (p) => presetEnable(argStr(p, 'preset_id') as string)),
    defineCommand(DISABLE_SPEC, (p) => presetDisable(argStr(p, 'preset_id') as string)),
    {
      name: 'catalog',
      help: 'Manage preset catalogs',
      run: (args, progName) => dispatchGroup(presetCatalogGroup, args, progName),
    },
  ],
};

/**
 * Run ``specify preset <args...>`` and return the exit code.
 *
 * @param args Arguments after the ``preset`` word (e.g. ``['catalog', 'list']``)
 */
export async function runPresetCommand(args: string[]): Promise<number> {
  return runHandled(() => dispatchGroup(presetGroup, args, 'specify preset'), 'specify preset');
}
