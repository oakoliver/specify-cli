/**
 * @oakoliver/specify-cli - Shared infrastructure for ``specify extension`` commands
 *
 * Port of ``specify_cli/extensions/_commands.py``: helpers shared by several
 * extension subcommands and by ``specify init --extension``.
 *
 * @module extensions/command-shared
 */

import { randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, rmSync, statSync, writeSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

import { Table, console, escapeMarkup, CliExit } from '../console.js';
import { getSpeckitVersion, locateBundledExtension } from '../assets.js';
import { loadInitOptions } from '../init-options.js';
import { displayProjectPath } from '../utils.js';
import { archiveFormatFromName, detectArchiveFormat, isHttpsOrLocalhostHttp, readResponseLimited } from '../download-security.js';
import { ExtensionCatalog } from './extension-catalog.js';
import { ExtensionError } from './errors.js';
import type { ExtensionManager, InstalledExtensionRecord } from './manager.js';
import { type Dict, type ExtensionManifest, VALID_EXTENSION_ARTIFACT_NAME_PATTERN } from './manifest.js';
import { isRelativeTo, resolveStrictFalse } from './fs-utils.js';
import { requireSpecifyProject } from './root-helpers.js';

export { requireSpecifyProject, getSpeckitVersion, locateBundledExtension, loadInitOptions, displayProjectPath };

// ============================================================================
// Safe IDs
// ============================================================================

/**
 * Return an extension ID that is safe to embed in a suggested shell command,
 * or a literal placeholder for catalog-controlled text that is not.
 */
export function commandSafeId(rawId: unknown, placeholder = '<extension-id>'): string {
  const text = rawId === null || rawId === undefined ? 'None' : String(rawId);
  if (text.startsWith('-')) return placeholder;
  if (VALID_EXTENSION_ARTIFACT_NAME_PATTERN.test(text)) return text;
  return placeholder;
}

// ============================================================================
// Event refresh
// ============================================================================

interface EventsModule {
  refreshIntegrationEvents(projectRoot: string): void | Promise<void>;
  EventRefreshError: new (...args: never[]) => Error & { failures: Array<[string, string]> };
}

/**
 * Refresh native event config and surface failures (R3). A refresh failure
 * must not abort the command, but it must be surfaced.
 */
export async function refreshEventsAndWarn(projectRoot: string): Promise<void> {
  let events: EventsModule;
  try {
    events = (await import('../events/index.js')) as unknown as EventsModule;
  } catch {
    // Events runtime unavailable in this build: nothing to refresh.
    return;
  }
  if (typeof events.refreshIntegrationEvents !== 'function') return;
  try {
    await events.refreshIntegrationEvents(projectRoot);
  } catch (exc) {
    if (events.EventRefreshError && exc instanceof events.EventRefreshError) {
      const failures = (exc as { failures: Array<[string, string]> }).failures ?? [];
      console.print(
        `\n[yellow]⚠[/yellow]  Extension updated, but event refresh failed ` +
          `for ${failures.length} integration(s); a stale native hook may ` +
          'still be active. Re-run [cyan]specify integration upgrade ' +
          '<key>[cyan][/cyan][/cyan] to retry.',
      );
      for (const [key, detail] of failures) {
        console.print(`    ${key}: ${escapeMarkup(String(detail))}`);
      }
      return;
    }
    throw exc;
  }
}

// ============================================================================
// Download cache
// ============================================================================

/** Relative path, below the project root, of the extension URL download cache. */
const CACHE_REL_PARTS = ['.specify', 'extensions', '.cache', 'downloads'];

function isSymlinkPath(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDirPath(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create and validate the extension URL download cache one component at a
 * time, refusing symlinked components (portable path-wise walk).
 */
export function validateSafeCacheDir(projectRoot: string): string {
  const downloadDir = join(projectRoot, ...CACHE_REL_PARTS);
  let projectRootResolved: string;
  try {
    projectRootResolved = resolveStrictFalse(projectRoot);
  } catch (exc) {
    console.print(
      `[red]Error:[/red] Could not prepare download cache directory: ${escapeMarkup((exc as Error).message)}`,
    );
    throw new CliExit(1);
  }
  let current = projectRoot;
  for (const part of CACHE_REL_PARTS) {
    current = join(current, part);
    if (isSymlinkPath(current)) {
      console.print('[red]Error:[/red] Refusing to use symlinked download cache directory');
      throw new CliExit(1);
    }
    try {
      mkdirSync(current);
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        if (code === 'ELOOP' || code === 'ENOTDIR') {
          console.print('[red]Error:[/red] Refusing to use symlinked download cache directory');
          throw new CliExit(1);
        }
        console.print(
          `[red]Error:[/red] Could not prepare download cache directory: ${escapeMarkup((exc as Error).message)}`,
        );
        throw new CliExit(1);
      }
    }
    if (isSymlinkPath(current) || !isDirPath(current)) {
      console.print('[red]Error:[/red] Refusing to use symlinked download cache directory');
      throw new CliExit(1);
    }
    if (!isRelativeTo(resolveStrictFalse(current), projectRootResolved)) {
      console.print('[red]Error:[/red] Download cache directory escapes project root');
      throw new CliExit(1);
    }
  }
  return downloadDir;
}

/** Exclusively create a download file inside the validated cache dir. */
function safeCreateDownloadFile(projectRoot: string, downloadDir: string, filename: string): string {
  const target = join(downloadDir, filename);
  if (isSymlinkPath(downloadDir) || !isDirPath(downloadDir)) {
    throw Object.assign(new Error('Download cache directory is not a real directory'), { code: 'ENOTDIR' });
  }
  if (!isRelativeTo(resolveStrictFalse(downloadDir), resolveStrictFalse(projectRoot))) {
    throw Object.assign(new Error('Download cache directory escapes project root'), { code: 'ENOTDIR' });
  }
  if (isSymlinkPath(target)) {
    throw Object.assign(new Error('Refusing to write through a symlinked download file'), { code: 'ELOOP' });
  }
  return target;
}

// ============================================================================
// URL install
// ============================================================================

/**
 * Download an archive from ``url`` and install it, reusing the hardened path:
 * HTTPS enforcement, authenticated + redirect-guarded fetch, bounded read,
 * archive-format detection, and an exclusively created transient download.
 * Throws {@link ExtensionError} on any failure.
 */
export async function installExtensionFromUrl(
  manager: ExtensionManager,
  projectRoot: string,
  url: string,
  speckitVersion: string,
  opts: { priority?: number; force?: boolean } = {},
): Promise<ExtensionManifest> {
  if (!isHttpsOrLocalhostHttp(url)) {
    throw new ExtensionError('URL must use HTTPS (HTTP is only allowed for localhost)');
  }

  const downloadDir = validateSafeCacheDir(projectRoot);
  const archiveFilename = `extension-url-download-${randomBytes(16).toString('hex')}.archive`;

  let archiveData: Uint8Array;
  let finalUrl: string;
  let contentType: string | null;
  try {
    const dlCatalog = new ExtensionCatalog(projectRoot);
    let downloadUrl = url;
    let extraHeaders: Record<string, string> | null = null;
    const resolvedUrl = await dlCatalog.resolveGithubReleaseAssetApiUrl(downloadUrl);
    if (resolvedUrl) {
      downloadUrl = resolvedUrl;
      extraHeaders = { Accept: 'application/octet-stream' };
    }
    const response = await dlCatalog.openUrl(downloadUrl, { timeout: 60, extraHeaders });
    archiveData = await readResponseLimited(response as never, {
      errorType: ExtensionError,
      label: `extension ${url}`,
    });
    finalUrl = ExtensionCatalog.responseUrl(response, downloadUrl);
    contentType = ExtensionCatalog.responseHeader(response, 'Content-Type');
  } catch (exc) {
    if (exc instanceof ExtensionError) throw exc;
    throw new ExtensionError(`Failed to download from ${url}: ${ExtensionCatalog.urlErrorText(exc)}`, { cause: exc });
  }

  let archivePath: string;
  try {
    archivePath = safeCreateDownloadFile(projectRoot, downloadDir, archiveFilename);
  } catch (exc) {
    throw new ExtensionError(`Could not safely create download file: ${(exc as Error).message}`, { cause: exc });
  }

  let created = false;
  try {
    let fd: number;
    try {
      fd = openSync(
        archivePath,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      created = true;
    } catch (exc) {
      throw new ExtensionError(`Could not safely create download file: ${(exc as Error).message}`, { cause: exc });
    }
    try {
      let written = 0;
      while (written < archiveData.length) {
        written += writeSync(fd, archiveData, written, archiveData.length - written);
      }
    } catch (exc) {
      throw new ExtensionError(`Could not safely write download file: ${(exc as Error).message}`, { cause: exc });
    } finally {
      closeSync(fd);
    }

    const formatSource = archiveFormatFromName(finalUrl) !== null ? finalUrl : url;
    try {
      detectArchiveFormat(archivePath, {
        archiveFile: archiveData,
        sourceName: formatSource,
        contentType,
        errorType: ExtensionError,
      });
    } catch (exc) {
      if (exc instanceof ExtensionError) {
        throw new ExtensionError(
          `${url} did not return a ZIP archive or tar.gz/tgz archive ` +
            `(got ${archiveData.length} bytes). This usually means the request ` +
            'was not authenticated and a login/HTML page was returned. ' +
            'Verify the URL and configured credentials.',
          { cause: exc },
        );
      }
      throw exc;
    }

    try {
      return manager.installFromZip(archivePath, speckitVersion, {
        priority: opts.priority ?? 10,
        force: opts.force ?? false,
        archiveFile: archiveData,
      });
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (typeof code === 'string' && !(exc instanceof ExtensionError)) {
        throw new ExtensionError(
          `Could not install extension from downloaded archive: ${(exc as Error).message}`,
          { cause: exc },
        );
      }
      throw exc;
    }
  } finally {
    if (created) {
      try {
        rmSync(archivePath, { force: true });
      } catch {
        // best effort
      }
    }
  }
}

// ============================================================================
// Argument resolution
// ============================================================================

/**
 * Resolve an extension argument (ID or display name) to an installed
 * extension. Returns ``[id, displayName]`` or ``[null, null]`` when
 * ``allowNotFound``. Exits (1) when ambiguous or not found.
 */
export function resolveInstalledExtension(
  argument: string,
  installedExtensions: InstalledExtensionRecord[],
  commandName = 'command',
  allowNotFound = false,
): [string | null, string | null] {
  for (const ext of installedExtensions) {
    if (ext.id === argument) return [ext.id, ext.name];
  }
  const nameMatches = installedExtensions.filter((ext) => ext.name.toLowerCase() === argument.toLowerCase());
  if (nameMatches.length === 1) return [nameMatches[0].id, nameMatches[0].name];
  if (nameMatches.length > 1) {
    console.print(
      `[red]Error:[/red] Extension name '${escapeMarkup(argument)}' is ambiguous. ` +
        'Multiple installed extensions share this name:',
    );
    const table = new Table({ title: 'Matching extensions' });
    table.addColumn('ID', { style: 'cyan', noWrap: true });
    table.addColumn('Name', { style: 'white' });
    table.addColumn('Version', { style: 'green' });
    for (const ext of nameMatches) {
      table.addRow(
        escapeMarkup(String(ext.id ?? '')),
        escapeMarkup(String(ext.name ?? '')),
        escapeMarkup(String(ext.version ?? '')),
      );
    }
    console.print(table);
    console.print('\nPlease rerun using the extension ID:');
    console.print(`  [bold]specify extension ${commandName} <extension-id>[/bold]`);
    throw new CliExit(1);
  }
  if (allowNotFound) return [null, null];
  console.print(`[red]Error:[/red] Extension '${escapeMarkup(argument)}' is not installed`);
  throw new CliExit(1);
}

/**
 * Resolve an extension argument (ID or display name) from the catalog.
 * Returns ``[info, null]`` when found, ``[null, error]`` on catalog error,
 * ``[null, null]`` when not found. Exits (1) when ambiguous.
 */
export async function resolveCatalogExtension(
  argument: string,
  catalog: ExtensionCatalog,
  commandName = 'info',
): Promise<[Dict | null, Error | null]> {
  try {
    const extInfo = await catalog.getExtensionInfo(argument);
    if (extInfo) return [extInfo, null];

    const searchResults = await catalog.search();
    const argumentLower = argument.toLowerCase();
    const nameMatches = searchResults.filter(
      (ext) => String(ext.name ?? '').toLowerCase() === argumentLower,
    );
    if (nameMatches.length === 1) return [nameMatches[0], null];
    if (nameMatches.length > 1) {
      console.print(
        `[red]Error:[/red] Extension name '${escapeMarkup(argument)}' is ambiguous. ` +
          'Multiple catalog extensions share this name:',
      );
      const table = new Table({ title: 'Matching extensions' });
      table.addColumn('ID', { style: 'cyan', noWrap: true });
      table.addColumn('Name', { style: 'white' });
      table.addColumn('Version', { style: 'green' });
      table.addColumn('Catalog', { style: 'dim' });
      for (const ext of nameMatches) {
        table.addRow(
          escapeMarkup(String(ext.id ?? '')),
          escapeMarkup(String(ext.name ?? '')),
          escapeMarkup(String(ext.version ?? '')),
          escapeMarkup(String(ext._catalog_name ?? '')),
        );
      }
      console.print(table);
      console.print('\nPlease rerun using the extension ID:');
      console.print(`  [bold]specify extension ${commandName} <extension-id>[/bold]`);
      throw new CliExit(1);
    }
    return [null, null];
  } catch (exc) {
    if (exc instanceof ExtensionError) return [null, exc];
    throw exc;
  }
}
