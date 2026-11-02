/**
 * @oakoliver/specify-cli - Workflow Step Commands
 *
 * ``specify workflow step list|add|remove|search|info|catalog``
 * (port of ``workflows/step/__init__.py`` + ``workflows/step/command_*.py``).
 *
 * @module workflows/step/commands
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resolveGithubReleaseAssetApiUrl } from '../../authentication/github-http.js';
import { githubProviderHosts } from '../../authentication/http.js';
import { defineCommand, dispatchGroup, type GroupSpec } from '../../cli-args.js';
import { CliExit, confirm, console, escapeMarkup, Panel } from '../../console.js';
import {
  archiveFormatFromContentType,
  archiveFormatFromName,
  archiveSuffix,
  isHttpsOrLocalhostHttp,
  readResponseLimited,
  safeExtractArchive,
  type ArchiveFormat,
} from '../../download-security.js';
import { Version } from '../../version.js';
import { httpDeps, responseUrl } from '../catalog/domain.js';
import { rejectInsecureDownloadRedirect, requireSpecifyProject } from '../commands.js';
import { STEP_REGISTRY } from '../index.js';
import {
  isDir,
  isMapping,
  isRelativeTo,
  isSymlink,
  osErrorMessage,
  pathExists,
  pyHome,
  pyRepr,
  pyStr,
  pyTruthy,
  pyUrlParse,
  relativeParts,
  resolvePath,
} from '../overlay/py-compat.js';
import { runWorkflowStepCatalogCommand } from './catalog/commands.js';
import { StepCatalog, StepCatalogError, StepRegistry, StepValidationError } from './catalog/domain.js';
import { availableVersions, validateChecksums } from './catalog/versions.js';
import { resolveStepsBaseDirOrExit, validateStepIdOrExit } from './helpers.js';
import {
  StepInstallError,
  checkInstallable,
  installStepPackage,
  resolvePackageRoot,
  stepInstallTransaction,
  stepPackageLimits,
  validateStepPackage,
} from './installer.js';

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
  return parts.length === 1 && ['step.yml', '__init__.py'].includes((parts[0] as string).toLowerCase());
}

/** Step catalog file responses are capped per file (``_MAX_STEP_CATALOG_RESPONSE_BYTES``). */
export const MAX_STEP_CATALOG_RESPONSE_BYTES = 50 * 1024 * 1024;

async function safeFetch(url: string): Promise<Uint8Array> {
  if (!isHttpsOrLocalhostHttp(url)) throw new Error(`Refusing to fetch from non-HTTPS URL: ${url}`);
  const resp = await httpDeps.openUrl(url, { timeout: 30, redirectValidator: rejectInsecureDownloadRedirect });
  const finalUrl = responseUrl(resp, url);
  if (!isHttpsOrLocalhostHttp(finalUrl)) throw new Error(`Redirect to non-HTTPS URL: ${finalUrl}`);
  return await readResponseLimited(resp, {
    maxBytes: MAX_STEP_CATALOG_RESPONSE_BYTES,
    errorType: Error,
    label: 'step package response',
  });
}

function errMsg(exc: unknown): string {
  if (exc instanceof Error && (exc as NodeJS.ErrnoException).code) return osErrorMessage(exc);
  return exc instanceof Error ? exc.message : String(exc);
}

function responseHeader(resp: unknown, name: string): string | null {
  const r = resp as {
    getheader?: (n: string) => string | null | undefined;
    headers?: { get?: (n: string) => string | null } | Record<string, string>;
  };
  if (typeof r.getheader === 'function') return r.getheader(name) ?? null;
  const headers = r.headers;
  if (headers && typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get: (n: string) => string | null }).get(name) ?? null;
  }
  return null;
}

/** ``Path(p).expanduser()`` */
function expandUser(p: string): string {
  if (p === '~') return pyHome();
  if (p.startsWith('~/')) return join(pyHome(), p.slice(2));
  return p;
}

/** Remove a temp directory; mirror ``TemporaryDirectory.cleanup`` warning semantics. */
function cleanupTempDir(dir: string, label: string, primaryError: unknown, committed: boolean): void {
  try {
    rmSync(dir, { recursive: true });
  } catch (cleanupExc) {
    if (pathExists(dir)) {
      console.print(
        '[yellow]Warning:[/yellow] Could not remove temporary ' +
          `step ${label} directory: ${escapeMarkup(errMsg(cleanupExc))} (path: ${escapeMarkup(dir)})`,
      );
    }
    if (primaryError === null && !committed) {
      throw new StepInstallError(`Failed to remove temporary step ${label} directory: ${errMsg(cleanupExc)}`, {
        cause: cleanupExc,
      });
    }
    // Do not raise from cleanup: preserve a primary error, or report a
    // successful install with a warning only.
  }
}

// ============================================================================
// step add
// ============================================================================

function printInstalled(stepId: string, entry: Record<string, unknown>): void {
  const stepName = pyTruthy(entry.name) ? entry.name : stepId;
  console.print(`[green]✓[/green] Step type '${escapeMarkup(pyStr(stepName))}' (${escapeMarkup(stepId)}) installed`);
  console.print('  Use [cyan]specify workflow step list[/cyan] to verify the installation.');
}

/** Install a complete step package from a local directory (``--dev``). */
function installFromDev(projectRoot: string, stepId: string, dev: string, opts: { force: boolean }): void {
  const devPath = expandUser(dev);
  if (isSymlink(devPath)) {
    throw new StepInstallError(`Refusing to install from a symlinked source directory: '${devPath}'`);
  }
  if (!isDir(devPath)) {
    throw new StepInstallError(
      `--dev source must be a directory containing step.yml and __init__.py: '${devPath}'`,
    );
  }
  const entry = installStepPackage(projectRoot, stepId, devPath, { source: 'local', force: opts.force });
  printInstalled(stepId, entry);
}

/** Install a step package archive from a direct URL (``--from``). */
async function installFromUrl(
  projectRoot: string,
  stepId: string,
  fromUrl: string,
  opts: { force: boolean },
): Promise<void> {
  let hostname: string | null;
  try {
    hostname = pyUrlParse(fromUrl).hostname;
  } catch {
    throw new StepInstallError(`Invalid URL: ${fromUrl}`);
  }
  if (!hostname) throw new StepInstallError(`Invalid URL: ${fromUrl}`);
  if (!isHttpsOrLocalhostHttp(fromUrl)) {
    throw new StepInstallError('URL must use HTTPS for security. HTTP is only allowed for loopback URLs.');
  }

  // Reject before the trust prompt and before any network request.
  checkInstallable(projectRoot, stepId, { force: opts.force });

  // Prompt BEFORE any request so the user can see and answer it; a declined
  // prompt issues no request and exits 0.
  // ADAPTATION: the port runs JavaScript step code, so the warning says
  // "executable code" where upstream says "executable Python".
  console.print();
  console.print(
    new Panel(
      '[bold]You are installing a workflow step type directly from an ' +
        'external URL.\nA step package contains executable code.[/bold]\n\n' +
        `URL: ${escapeMarkup(fromUrl)}\n\n` +
        'Only install step packages from sources you trust.',
      { title: '[bold yellow]⚠ Untrusted Source[/bold yellow]', borderStyle: 'yellow', padding: [1, 2] },
    ),
  );
  console.print();
  if (!(await confirm('Continue with installation?', { default: false }))) {
    console.print('Cancelled');
    throw new CliExit(0);
  }

  let downloadUrl = fromUrl;
  let extraHeaders: Record<string, string> | undefined;
  let tmpPath: string | null = null;
  let entry: Record<string, unknown>;
  try {
    const resolvedUrl = await resolveGithubReleaseAssetApiUrl(fromUrl, httpDeps.openUrl, {
      timeout: 30,
      githubHosts: githubProviderHosts(),
      redirectValidator: rejectInsecureDownloadRedirect,
    });
    if (resolvedUrl) {
      downloadUrl = resolvedUrl;
      extraHeaders = { Accept: 'application/octet-stream' };
    }

    const resp = await httpDeps.openUrl(downloadUrl, {
      timeout: 30,
      extraHeaders,
      redirectValidator: rejectInsecureDownloadRedirect,
    });
    const finalUrl = responseUrl(resp, downloadUrl);
    if (!isHttpsOrLocalhostHttp(finalUrl)) throw new StepInstallError(`URL redirected to non-HTTPS: ${finalUrl}`);
    const contentType = responseHeader(resp, 'Content-Type');
    const declarations: Array<[string, string, ArchiveFormat | null]> = [
      ['requested URL', fromUrl, archiveFormatFromName(fromUrl)],
      ['final URL', finalUrl, archiveFormatFromName(finalUrl)],
      ['Content-Type', contentType ?? '', archiveFormatFromContentType(contentType)],
    ];
    const recognized = declarations.filter((item) => item[2] !== null);
    const archiveFormat = recognized.length ? recognized[0]![2] : null;
    if (recognized.some((item) => item[2] !== archiveFormat)) {
      const details = recognized.map(([label, , declared]) => `${label} declares ${declared}`).join(', ');
      throw new StepInstallError(`Archive format mismatch: ${details}`);
    }
    const downloaded = await readResponseLimited(resp, { errorType: Error, label: 'step archive download' });

    tmpPath = join(tmpdir(), `tmp${randomBytes(6).toString('hex')}${archiveFormat ? archiveSuffix(archiveFormat) : '.archive'}`);
    writeFileSync(tmpPath, downloaded, { flag: 'wx', mode: 0o600 });

    let extractTmp: string;
    try {
      extractTmp = mkdtempSync(join(tmpdir(), 'speckit-step-archive-'));
    } catch (exc) {
      throw new StepInstallError(`Failed to create temporary step archive directory: ${errMsg(exc)}`, { cause: exc });
    }
    let committed = false;
    let primaryError: unknown = null;
    try {
      // safeExtractArchive re-detects and confirms the archive bytes.
      safeExtractArchive(tmpPath, extractTmp, {
        sourceName: recognized.length ? recognized[0]![1] : null,
        contentType,
      });
      const packageRoot = resolvePackageRoot(extractTmp);
      entry = installStepPackage(projectRoot, stepId, packageRoot, { source: 'url', force: opts.force });
      committed = true;
    } catch (exc) {
      primaryError = exc;
      throw exc;
    } finally {
      cleanupTempDir(extractTmp, 'archive', primaryError, committed);
    }
  } catch (exc) {
    if (exc instanceof CliExit || exc instanceof StepInstallError) throw exc;
    throw new StepInstallError(`Failed to install step from URL: ${errMsg(exc)}`, { cause: exc });
  } finally {
    if (tmpPath !== null) {
      try {
        unlinkSync(tmpPath);
      } catch (cleanupExc) {
        if ((cleanupExc as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.print(
            '[yellow]Warning:[/yellow] Could not remove temporary ' +
              `step download file: ${escapeMarkup(errMsg(cleanupExc))} ` +
              `(path: ${escapeMarkup(tmpPath)})`,
          );
        }
      }
    }
  }
  printInstalled(stepId, entry!);
}

/** Options for {@link installFromCatalog}. */
interface CatalogInstallOptions {
  force: boolean;
  version?: string | null;
  selectedInfo?: Record<string, unknown> | null;
}

/**
 * Install a step package from the step catalog. The catalog fetch
 * (URL/derivation/count preflight) stays a catalog concern; the materialized
 * files are then handed to the shared installer.
 */
async function installFromCatalog(projectRoot: string, stepId: string, opts: CatalogInstallOptions): Promise<void> {
  const version = opts.version ?? null;
  let info: Record<string, unknown> | null;
  if (opts.selectedInfo !== undefined && opts.selectedInfo !== null) {
    info = opts.selectedInfo;
  } else {
    const catalog = new StepCatalog(projectRoot);
    try {
      info = version !== null ? await catalog.getStepInfo(stepId, version) : await catalog.getStepInfo(stepId);
    } catch (exc) {
      if (!(exc instanceof StepCatalogError)) throw exc;
      throw new StepInstallError(exc.message, { cause: exc });
    }
  }

  if (!info || Object.keys(info).length === 0) {
    throw new StepInstallError(
      version !== null
        ? `Step type '${stepId}' version '${version}' not found in the winning catalog`
        : `Step type '${stepId}' not found in catalog`,
    );
  }

  if (!pyTruthy('_install_allowed' in info ? info._install_allowed : true)) {
    console.print(`[yellow]Warning:[/yellow] Step type '${escapeMarkup(stepId)}' is from a discovery-only catalog`);
    console.print('Direct installation is not enabled for this catalog source.');
    throw new CliExit(1);
  }

  try {
    validateChecksums(info, stepId, { required: version !== null });
  } catch (exc) {
    if (!(exc instanceof StepCatalogError)) throw exc;
    throw new StepInstallError(exc.message, { cause: exc });
  }
  const checksums = info.sha256;

  // Reject built-in collisions and duplicates before any download.
  checkInstallable(projectRoot, stepId, { force: opts.force });

  const declaredStepYmlUrl = info.step_yml_url ?? null;
  if (declaredStepYmlUrl !== null && typeof declaredStepYmlUrl !== 'string') {
    throw new StepInstallError(
      `Catalog entry for '${stepId}' has a malformed step.yml URL; expected a non-empty string`,
    );
  }
  const stepYmlUrl: unknown = pyTruthy(declaredStepYmlUrl) ? declaredStepYmlUrl : (info.url ?? null);
  if (stepYmlUrl === null || (typeof stepYmlUrl === 'string' && !stepYmlUrl.trim())) {
    throw new StepInstallError(`Catalog entry for '${stepId}' has no URL`);
  }
  if (typeof stepYmlUrl !== 'string') {
    throw new StepInstallError(
      `Catalog entry for '${stepId}' has a malformed step.yml URL; expected a non-empty string`,
    );
  }

  // Derive __init__.py URL or use explicit init_url.
  let initUrl: unknown = info.init_url ?? null;
  if (initUrl !== null && (typeof initUrl !== 'string' || !initUrl.trim())) {
    throw new StepInstallError(
      `Catalog entry for '${stepId}' has a malformed __init__.py URL; expected a non-empty string`,
    );
  }
  if (!initUrl) {
    if (stepYmlUrl.endsWith('step.yml')) {
      initUrl = stepYmlUrl.slice(0, -'step.yml'.length) + '__init__.py';
    } else {
      throw new StepInstallError(
        `Cannot derive __init__.py URL from '${stepYmlUrl}'. ` +
          "Catalog entry should provide 'init_url' or a 'url' ending in 'step.yml'.",
      );
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
    throw new StepInstallError(
      `Step package declares ${packageFileCount} files, exceeding the ` +
        `${stepPackageLimits.maxFiles}-entry limit (files and directories combined)`,
    );
  }

  const fetchChecked = async (url: string, name: string): Promise<Uint8Array> => {
    const content = await safeFetch(url);
    if (
      isMapping(checksums) &&
      Object.keys(checksums).length > 0 &&
      createHash('sha256').update(content).digest('hex').toLowerCase() !== pyStr(checksums[name]).toLowerCase()
    ) {
      throw new StepInstallError(`SHA-256 checksum mismatch for '${name}'`);
    }
    return content;
  };

  let packageDir: string;
  try {
    packageDir = mkdtempSync(join(tmpdir(), 'speckit-step-package-'));
  } catch (exc) {
    throw new StepInstallError(`Failed to create temporary step package directory: ${errMsg(exc)}`, { cause: exc });
  }
  let committed = false;
  let primaryError: unknown = null;
  let entry: Record<string, unknown>;
  try {
    let stepYmlContent: Uint8Array;
    let initPyContent: Uint8Array;
    try {
      stepYmlContent = await fetchChecked(stepYmlUrl, 'step.yml');
      initPyContent = await fetchChecked(initUrl as string, '__init__.py');
    } catch (exc) {
      throw new StepInstallError(`Failed to download step files: ${errMsg(exc)}`, { cause: exc });
    }

    let packageBytes = stepYmlContent.length + initPyContent.length;
    if (packageBytes > stepPackageLimits.maxBytes) {
      throw new StepInstallError(`Step package exceeds the ${stepPackageLimits.maxBytes}-byte total size limit`);
    }

    try {
      writeFileSync(join(packageDir, 'step.yml'), stepYmlContent);
      writeFileSync(join(packageDir, '__init__.py'), initPyContent);
    } catch (exc) {
      throw new StepInstallError(`Failed to write step files to staging directory: ${errMsg(exc)}`, { cause: exc });
    }

    // Optionally download additional package files (relative path -> URL).
    for (const [relPath, fileUrl] of extraEntries) {
      if (typeof relPath !== 'string' || !relPath.trim()) {
        throw new StepInstallError("Catalog entry 'extra_files' contains an empty or non-string path key");
      }
      if (isRequiredPackageFile(relPath)) continue; // already written above
      const parts = posixParts(relPath);
      if (parts.length === 0 || parts.some((seg) => seg === '' || seg === '.' || seg === '..')) {
        throw new StepInstallError(`extra_files path '${relPath}' is not a valid relative file path`);
      }
      if (typeof fileUrl !== 'string' || !fileUrl.trim()) {
        throw new StepInstallError(`extra_files entry '${relPath}' has an empty or non-string URL`);
      }
      const resolvedBase = resolvePath(packageDir);
      const dest = resolvePath(relPath.startsWith('/') ? relPath : join(packageDir, relPath));
      if (!isRelativeTo(dest, resolvedBase)) {
        throw new StepInstallError(`extra_files path '${relPath}' is outside the step package directory`);
      }
      let fileContent: Uint8Array;
      try {
        fileContent = await fetchChecked(fileUrl, relPath);
      } catch (exc) {
        throw new StepInstallError(`Failed to download extra file '${relPath}': ${errMsg(exc)}`, { cause: exc });
      }
      packageBytes += fileContent.length;
      if (packageBytes > stepPackageLimits.maxBytes) {
        throw new StepInstallError(`Step package exceeds the ${stepPackageLimits.maxBytes}-byte total size limit`);
      }
      try {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, fileContent);
      } catch (exc) {
        throw new StepInstallError(`Failed to write extra file '${relPath}': ${errMsg(exc)}`, { cause: exc });
      }
    }

    if (version !== null || 'releases' in info) {
      const stepMeta = validateStepPackage(packageDir, stepId);
      const declaredVersion = stepMeta.version;
      let matches = false;
      try {
        matches =
          typeof declaredVersion === 'string' &&
          new Version(declaredVersion).equals(new Version(info.version as string));
      } catch {
        matches = false;
      }
      if (!matches) {
        throw new StepInstallError(
          `step.yml version (${pyRepr(declaredVersion)}) does not match ` +
            `catalog version (${pyRepr(info.version ?? null)})`,
        );
      }
    }

    entry = installStepPackage(projectRoot, stepId, packageDir, {
      source: 'catalog',
      catalogName: '_catalog_name' in info ? info._catalog_name : '',
      catalogMetadata: info,
      force: opts.force,
    });
    committed = true;
  } catch (exc) {
    primaryError = exc;
    throw exc;
  } finally {
    cleanupTempDir(packageDir, 'package', primaryError, committed);
  }

  printInstalled(stepId, entry!);
}

/** Options for {@link workflowStepAdd}. */
export interface WorkflowStepAddOptions {
  /** ``--dev``: install from a local step package directory. */
  dev?: string | null;
  /** ``--from``: install from a .zip/.tar.gz/.tgz archive URL. */
  fromUrl?: string | null;
  /** ``--force``: replace an existing installation. */
  force?: boolean;
  /** ``--version``: install an exact catalog release. */
  version?: string | null;
}

/** Install a custom step type from the catalog, a local directory, or a URL. */
export async function workflowStepAdd(stepId: string, opts: WorkflowStepAddOptions = {}): Promise<void> {
  const dev = opts.dev ?? null;
  const fromUrl = opts.fromUrl ?? null;
  const force = opts.force ?? false;
  const version = opts.version ?? null;

  const projectRoot = requireSpecifyProject();

  if (dev !== null && fromUrl !== null) {
    console.print('[red]Error:[/red] --dev and --from are mutually exclusive');
    throw new CliExit(1);
  }
  if (dev !== null && !dev.trim()) {
    console.print('[red]Error:[/red] --dev value must not be empty');
    throw new CliExit(1);
  }
  if (fromUrl !== null && !fromUrl.trim()) {
    console.print('[red]Error:[/red] --from value must not be empty');
    throw new CliExit(1);
  }
  if (version !== null && (dev !== null || fromUrl !== null)) {
    console.print('[red]Error:[/red] --version requires a catalog step ID');
    throw new CliExit(1);
  }
  if (version !== null && !version.trim()) {
    console.print('[red]Error:[/red] --version value must not be empty');
    throw new CliExit(1);
  }

  validateStepIdOrExit(stepId);

  try {
    if (dev !== null) installFromDev(projectRoot, stepId, dev, { force });
    else if (fromUrl !== null) await installFromUrl(projectRoot, stepId, fromUrl, { force });
    else await installFromCatalog(projectRoot, stepId, { force, version });
  } catch (exc) {
    if (!(exc instanceof StepInstallError)) throw exc;
    for (const note of exc.notes) console.print(`[yellow]Warning:[/yellow] ${escapeMarkup(note)}`);
    console.print(`[red]Error:[/red] ${escapeMarkup(exc.message)}`);
    throw new CliExit(1);
  }
}

/**
 * Install a bundle-selected release with the normal step ID preflight
 * (``_install_preselected_step``). ``selectedInfo`` is the catalog record
 * the bundler already selected; it is used without a second catalog lookup.
 * Install failures propagate as {@link StepInstallError}.
 */
export async function installPreselectedStep(
  stepId: string,
  opts: { version: string | null; selectedInfo: Record<string, unknown> },
): Promise<void> {
  const projectRoot = requireSpecifyProject();
  validateStepIdOrExit(stepId);
  await installFromCatalog(projectRoot, stepId, {
    force: false,
    version: opts.version,
    selectedInfo: opts.selectedInfo,
  });
}

// ============================================================================
// step remove
// ============================================================================

/**
 * Remove a step's registry entry and directory while the lock is held. The
 * registry and step directory are resolved here, after the lock is acquired,
 * so a concurrent install cannot be lost or resurrected by a stale snapshot.
 */
function removeStepLocked(projectRoot: string, stepId: string): void {
  const safeStepId = escapeMarkup(stepId);
  const registry = new StepRegistry(projectRoot);
  const inRegistry = registry.isInstalled(stepId);

  const stepsBaseDir = resolveStepsBaseDirOrExit(projectRoot);
  const stepDir = resolvePath(join(stepsBaseDir, stepId));
  const relParts = relativeParts(stepDir, stepsBaseDir);
  if (relParts === null || relParts.length !== 1 || relParts[0] !== stepId) {
    console.print(`[red]Error:[/red] Invalid step id '${safeStepId}'`);
    throw new CliExit(1);
  }

  const dirExists = pathExists(stepDir);

  if (!inRegistry && !dirExists) {
    console.print(`[red]Error:[/red] Step type '${safeStepId}' is not installed`);
    throw new CliExit(1);
  }

  if (!inRegistry && dirExists) {
    console.print(
      `[yellow]Warning:[/yellow] '${safeStepId}' has no registry entry ` +
        '(registry may have been reset). Removing the orphaned directory.',
    );
  }

  if (dirExists && !inRegistry) {
    try {
      rmSync(stepDir, { recursive: true });
    } catch (exc) {
      console.print(
        '[red]Error:[/red] Failed to remove step directory ' +
          `${escapeMarkup(stepDir)}: ${escapeMarkup(osErrorMessage(exc))}`,
      );
      throw new CliExit(1);
    }
  } else if (inRegistry) {
    const registryMetadata = registry.get(stepId);
    try {
      registry.remove(stepId);
    } catch (exc) {
      if (!(exc instanceof StepValidationError)) throw exc;
      console.print(`[red]Error:[/red] ${escapeMarkup(exc.message)}`);
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
              `for '${safeStepId}' after directory removal failure: ${escapeMarkup(errMsg(restoreExc))}`,
          );
        }
        console.print(
          '[red]Error:[/red] Failed to remove step directory ' +
            `${escapeMarkup(stepDir)}: ${escapeMarkup(osErrorMessage(exc))}`,
        );
        throw new CliExit(1);
      }
    }
  }
}

/** Uninstall a custom step type. */
export function workflowStepRemove(stepId: string): void {
  const projectRoot = requireSpecifyProject();

  validateStepIdOrExit(stepId);

  // Removal mutates the same directory and registry as `step add`, so it
  // shares the install lock to prevent lost or resurrected registry entries.
  try {
    stepInstallTransaction(projectRoot, () => removeStepLocked(projectRoot, stepId));
  } catch (exc) {
    if (!(exc instanceof StepInstallError)) throw exc;
    // Report the underlying acquisition error so the message is not
    // prefixed twice by the helper's own lock-failure text.
    const cause = exc.cause ?? exc;
    console.print(
      '[red]Error:[/red] Failed to lock step removal ' + `'${escapeMarkup(stepId)}': ${escapeMarkup(errMsg(cause))}`,
    );
    throw new CliExit(1);
  }

  console.print(`[green]✓[/green] Step type '${escapeMarkup(stepId)}' uninstalled`);
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

/**
 * Render a registry entry's provenance as a human-facing source label. Local
 * and URL installs deliberately store no path/URL, so only the kind is shown.
 */
function formatSource(installedMeta: Record<string, unknown>): string {
  const source = installedMeta.source;
  if (source === 'catalog') {
    const catalogName = installedMeta.catalog_name;
    if (pyTruthy(catalogName)) return `catalog (${escapeMarkup(pyStr(catalogName))})`;
    return 'catalog';
  }
  if (source === 'local' || source === 'url') return String(source);
  return '';
}

/** Show details for a step type (``--versions`` lists releases in the winning catalog). */
export async function workflowStepInfo(stepId: string, opts: { versions?: boolean } = {}): Promise<void> {
  const versions = opts.versions ?? false;
  const projectRoot = requireSpecifyProject();
  const safeStepId = escapeMarkup(String(stepId));

  const registry = new StepRegistry(projectRoot);
  const installedMeta = registry.get(stepId);

  const isBuiltin = builtinStepHas(stepId) && !pyTruthy(installedMeta);

  if (isBuiltin) {
    if (versions) {
      console.print(`[red]Error:[/red] Built-in step type '${safeStepId}' has no catalog releases`);
      throw new CliExit(1);
    }
    console.print(`\n[bold cyan]${safeStepId}[/bold cyan] [dim](built-in)[/dim]`);
    console.print(`  Type key: ${safeStepId}`);
    console.print('  [green]Built-in step type[/green]');
    return;
  }

  if (versions) {
    const catalog = new StepCatalog(projectRoot);
    let info: Record<string, unknown> | null;
    let releases: string[];
    try {
      info = await catalog.getStepInfo(stepId);
      if (info === null) {
        console.print(`[red]Error:[/red] Step type '${safeStepId}' not found`);
        throw new CliExit(1);
      }
      releases = availableVersions(info, stepId);
    } catch (exc) {
      if (!(exc instanceof StepCatalogError)) throw exc;
      console.print(`[red]Error:[/red] ${exc.message}`);
      throw new CliExit(1);
    }
    const name = escapeMarkup(pyStr('name' in info ? info.name : stepId));
    const policy = pyTruthy('_install_allowed' in info ? info._install_allowed : true)
      ? ''
      : ' [dim](discovery only; not installable)[/dim]';
    console.print(`\n[bold cyan]${name}[/bold cyan] (${safeStepId})${policy}`);
    releases.forEach((release, index) => {
      const label = index === 0 ? ' (current)' : '';
      console.print(`  ${escapeMarkup(release)}${label}`);
    });
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
    const sourceLabel = formatSource(installedMeta);
    if (sourceLabel) console.print(`  Source:      ${sourceLabel}`);
    console.print('  [green]Installed[/green]');
    return;
  }

  const catalog = new StepCatalog(projectRoot);
  let info: Record<string, unknown> | null;
  try {
    info = await catalog.getStepInfo(stepId);
  } catch (exc) {
    if (!(exc instanceof StepCatalogError)) throw exc;
    console.print(`[red]Error:[/red] ${exc.message}`);
    throw new CliExit(1);
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
        help: 'Install a custom step type from the catalog, a local directory, or a URL.',
        arguments: [{ name: 'step_id', help: 'Step type ID', required: true }],
        options: [
          { name: 'dev', flags: ['--dev'], type: 'string', help: 'Install from a local step package directory' },
          { name: 'from_url', flags: ['--from'], type: 'string', help: 'Install from a .zip/.tar.gz/.tgz archive URL' },
          { name: 'force', flags: ['--force'], type: 'boolean', help: 'Replace an existing installation' },
          { name: 'version', flags: ['--version'], type: 'string', help: 'Install an exact catalog release' },
        ],
      },
      async (parsed) => {
        const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
        await workflowStepAdd(String(parsed.args.step_id), {
          dev: str(parsed.options.dev),
          fromUrl: str(parsed.options.from_url),
          force: Boolean(parsed.options.force),
          version: str(parsed.options.version),
        });
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
        options: [
          { name: 'versions', flags: ['--versions'], type: 'boolean', help: 'List releases in the winning catalog' },
        ],
      },
      async (parsed) => {
        await workflowStepInfo(String(parsed.args.step_id), { versions: Boolean(parsed.options.versions) });
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
