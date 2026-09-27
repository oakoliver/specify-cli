/**
 * @oakoliver/specify-cli - ``specify workflow add``
 *
 * Install a workflow from the catalog, a URL, or a local path
 * (port of ``workflows/command_add.py``). The CLI adapter in
 * ``./commands.ts`` parses argv and calls {@link workflowAdd}.
 *
 * @module workflows/command-add
 */

import { closeSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

import { resolveGithubReleaseAssetApiUrl } from '../authentication/github-http.js';
import { githubProviderHosts } from '../authentication/http.js';
import { CliExit, confirm, console, escapeMarkup, Panel } from '../console.js';
import {
  archiveFormatFromContentType,
  archiveFormatFromName,
  archiveSuffix,
  type ArchiveFormat,
  isHttpsOrLocalhostHttp,
  readResponseLimited,
  safeExtractArchive,
} from '../download-security.js';
import { YAMLError } from '../yaml.js';
import { httpDeps, responseUrl } from './catalog/domain.js';
import {
  commitWorkflowFile,
  discardCommittedBackupFile,
  enforceWorkflowYamlSize,
  installWorkflowFromCatalog,
  installWorkflowPackage,
  openWorkflowRegistry,
  readResponseWithinLimit,
  rejectInsecureDownloadRedirect,
  rejectUnsafeDir,
  requireSpecifyProject,
  safeDiscardStagedWorkflowFile,
  safeRollbackCommittedWorkflowFile,
  safeWorkflowIdDir,
  sniffWorkflowArchiveFormat,
  stageWorkflowFile,
  validateWorkflowIdOrExit,
  workflowInstallTransaction,
  workflowPackageRoot,
  workflowYamlIsDeclared,
} from './commands.js';
import { validateWorkflow, WorkflowDefinition } from './engine.js';
import { loadCustomSteps } from './index.js';
import { isOsError } from './overlay/operations.js';
import { isDir, isFile, isMapping, osErrorMessage, pathExists, pyHome, pyRepr, pyTruthy, pyUrlParse } from './overlay/py-compat.js';

// ============================================================================
// Helpers
// ============================================================================

/** Options for {@link workflowAdd} (mirrors the Typer parameters). */
export interface WorkflowAddOptions {
  /** Workflow ID, URL, or local path (positional ``SOURCE``). */
  source: string;
  /** ``--dev``: install from a local workflow YAML file or directory. */
  dev?: boolean;
  /** ``--from``: install from a custom URL (``source`` is then the expected ID). */
  fromUrl?: string | null;
}

/**
 * Best-effort unlink of a partially-downloaded workflow temp file. A cleanup
 * failure never masks the error already propagating -- it is only warned about.
 */
export function cleanupDownloadTmpPath(tmpPath: string | null): void {
  if (tmpPath === null) return;
  try {
    unlinkSync(tmpPath);
  } catch (cleanupExc) {
    if (isOsError(cleanupExc) && cleanupExc.code === 'ENOENT') return;
    console.print(
      '[yellow]Warning:[/yellow] Could not remove temporary ' +
        `workflow download file: ${escapeMarkup(osErrorMessage(cleanupExc))} ` +
        `(path: ${escapeMarkup(tmpPath)})`,
    );
  }
}

/** Return whether a directory contains anything beyond workflow.yml. */
export function workflowPackageHasCompanions(packageDir: string): boolean {
  return readdirSync(packageDir).some((name) => name !== 'workflow.yml');
}

/** ``Path(source).expanduser()`` */
function expandUser(p: string): string {
  if (p === '~') return pyHome();
  if (p.startsWith('~/')) return join(pyHome(), p.slice(2));
  return p;
}

function isYamlSuffix(p: string): boolean {
  const suffix = extname(p).toLowerCase();
  return suffix === '.yml' || suffix === '.yaml';
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
  if (headers && typeof headers === 'object') {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(headers as Record<string, string>)) {
      if (k.toLowerCase() === lower) return v;
    }
  }
  return null;
}

/** ``tempfile.TemporaryDirectory(prefix=...)`` as a callback scope. */
async function withTemporaryDirectory<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function errMsg(exc: unknown): string {
  if (isOsError(exc)) return osErrorMessage(exc);
  return exc instanceof Error ? exc.message : String(exc);
}

// ============================================================================
// Local YAML install
// ============================================================================

/** Validate and install a workflow from a local YAML file. */
export function validateAndInstallLocal(
  projectRoot: string,
  workflowsDir: string,
  yamlPath: string,
  sourceLabel: string,
  expectedId: string | null = null,
): void {
  let sourceContent: Buffer;
  let sourceMode: number;
  let definition: WorkflowDefinition;
  try {
    const fd = openSync(yamlPath, 'r');
    try {
      sourceMode = fstatSync(fd).mode & 0o7777;
      sourceContent = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (exc) {
    console.print(`[red]Error:[/red] Failed to read workflow YAML: ` + `${escapeMarkup(errMsg(exc))}`);
    throw new CliExit(1);
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(sourceContent);
    definition = WorkflowDefinition.fromString(text);
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    if (!(exc instanceof Error) && !(exc instanceof YAMLError)) throw exc;
    console.print(`[red]Error:[/red] Invalid workflow YAML: ${escapeMarkup(errMsg(exc))}`);
    throw new CliExit(1);
  }

  // Non-string ids fall through to validateWorkflow, which reports a typed
  // error; only None/empty/whitespace-only ids are rejected as missing.
  const defId: unknown = definition.id;
  if (defId === null || defId === undefined || defId === '' || (typeof defId === 'string' && !defId.trim())) {
    console.print("[red]Error:[/red] Workflow definition has an empty or missing 'id'");
    throw new CliExit(1);
  }

  const errors = validateWorkflow(definition);
  if (errors.length) {
    console.print('[red]Error:[/red] Workflow validation failed:');
    for (const err of errors) console.print(`  • ${escapeMarkup(String(err))}`);
    throw new CliExit(1);
  }

  if (expectedId !== null && definition.id !== expectedId) {
    console.print(
      `[red]Error:[/red] Workflow ID in YAML (${escapeMarkup(pyRepr(definition.id))}) ` +
        `does not match the requested workflow ID (${escapeMarkup(pyRepr(expectedId))}).`,
    );
    throw new CliExit(1);
  }

  const workflowId = String(definition.id);
  const destDir = safeWorkflowIdDir(workflowsDir, workflowId);
  const destFile = join(destDir, 'workflow.yml');
  const existedBefore = isDir(destDir);

  let stagedFile: ReturnType<typeof stageWorkflowFile>;
  try {
    stagedFile = stageWorkflowFile(destDir);
  } catch (exc) {
    if (!isOsError(exc)) throw exc;
    console.print(
      `[red]Error:[/red] Failed to install workflow ` + `'${escapeMarkup(workflowId)}': ${escapeMarkup(errMsg(exc))}`,
    );
    throw new CliExit(1);
  }

  try {
    // Write the exact bytes parsed above so a concurrent source edit cannot
    // desynchronize installed content from validated metadata.
    stagedFile.writeBytes(sourceContent);
    stagedFile.setMode(sourceMode);
  } catch (exc) {
    if (!isOsError(exc)) throw exc;
    safeDiscardStagedWorkflowFile(stagedFile, destDir, existedBefore);
    console.print(
      `[red]Error:[/red] Failed to install workflow ` + `'${escapeMarkup(workflowId)}': ${escapeMarkup(errMsg(exc))}`,
    );
    throw new CliExit(1);
  }

  try {
    workflowInstallTransaction(projectRoot, () => {
      const transactionExistedBefore = existedBefore || pathExists(destFile);
      const transactionRegistry = openWorkflowRegistry(projectRoot);
      let backupFile: string | null;
      try {
        backupFile = commitWorkflowFile(stagedFile, destFile, transactionExistedBefore);
      } catch (exc) {
        if (!isOsError(exc)) throw exc;
        safeDiscardStagedWorkflowFile(stagedFile, destDir, existedBefore);
        console.print(
          `[red]Error:[/red] Failed to install workflow ` +
            `'${escapeMarkup(workflowId)}': ` +
            `${escapeMarkup(errMsg(exc))}`,
        );
        throw new CliExit(1);
      }
      try {
        const entry: Record<string, unknown> = {
          name: definition.name,
          version: definition.version,
          description: definition.description,
          source: sourceLabel,
        };
        const existing = transactionRegistry.get(workflowId);
        if (isMapping(existing) && !pyTruthy('enabled' in existing ? existing.enabled : true)) entry.enabled = false;
        transactionRegistry.add(workflowId, entry);
      } catch (exc) {
        if (exc instanceof CliExit) throw exc;
        safeRollbackCommittedWorkflowFile(destFile, destDir, transactionExistedBefore, backupFile);
        console.print(
          `[red]Error:[/red] Failed to update workflow registry for ` +
            `'${escapeMarkup(workflowId)}': ` +
            `${escapeMarkup(errMsg(exc))}`,
        );
        throw new CliExit(1);
      }
      // Registry update succeeded while the transaction lock is held.
      discardCommittedBackupFile(backupFile);
    });
  } catch (exc) {
    if (exc instanceof CliExit) {
      safeDiscardStagedWorkflowFile(stagedFile, destDir, existedBefore);
      throw exc;
    }
    if (!isOsError(exc)) throw exc;
    safeDiscardStagedWorkflowFile(stagedFile, destDir, existedBefore);
    console.print(
      `[red]Error:[/red] Failed to lock workflow install ` + `'${escapeMarkup(workflowId)}': ${escapeMarkup(errMsg(exc))}`,
    );
    throw new CliExit(1);
  }
  console.print(
    `[green]✓[/green] Workflow '${escapeMarkup(String(definition.name))}' ` + `(${escapeMarkup(workflowId)}) installed`,
  );
}

async function installArchive(
  projectRoot: string,
  workflowsDir: string,
  archivePath: string,
  sourceLabel: string,
  extra: { sourceName?: string; contentType?: string | null; expectedId?: string | null } = {},
): Promise<void> {
  await withTemporaryDirectory('speckit-workflow-archive-', async (tmpdirPath) => {
    let packageRoot: string;
    try {
      if (extra.sourceName !== undefined) {
        await safeExtractArchive(archivePath, tmpdirPath, { sourceName: extra.sourceName, contentType: extra.contentType ?? null });
      } else {
        await safeExtractArchive(archivePath, tmpdirPath);
      }
      packageRoot = workflowPackageRoot(tmpdirPath);
    } catch (exc) {
      if (exc instanceof CliExit || isOsError(exc) || !(exc instanceof Error)) throw exc;
      console.print(`[red]Error:[/red] Invalid workflow archive: ` + `${escapeMarkup(exc.message)}`);
      throw new CliExit(1);
    }
    if (extra.expectedId !== undefined) {
      await installWorkflowPackage(projectRoot, workflowsDir, packageRoot, sourceLabel, { expectedId: extra.expectedId });
    } else {
      await installWorkflowPackage(projectRoot, workflowsDir, packageRoot, sourceLabel);
    }
  });
}

// ============================================================================
// workflow add
// ============================================================================

/**
 * Install a workflow from catalog, URL, or local path
 * (``specify workflow add SOURCE [--dev] [--from URL]``).
 *
 * @throws CliExit on any failure (exit 0 when the user cancels an untrusted-URL install).
 */
export async function workflowAdd(opts: WorkflowAddOptions): Promise<void> {
  const source = opts.source;
  const dev = opts.dev ?? false;
  const fromUrl = opts.fromUrl ?? null;

  const projectRoot = requireSpecifyProject();
  await loadCustomSteps(projectRoot);
  openWorkflowRegistry(projectRoot);
  const workflowsDir = join(projectRoot, '.specify', 'workflows');
  // With --from, source names the expected workflow ID: validate it up front.
  if (fromUrl !== null && !dev) validateWorkflowIdOrExit(source);
  // Reject a symlinked .specify / .specify/workflows before any write.
  rejectUnsafeDir(join(projectRoot, '.specify'), '.specify');
  rejectUnsafeDir(workflowsDir, '.specify/workflows');

  const installLocal = (yamlPath: string, label: string, expectedId: string | null = null): void =>
    validateAndInstallLocal(projectRoot, workflowsDir, yamlPath, label, expectedId);

  // Explicit local install. --dev takes precedence over --from.
  if (dev) {
    const devPath = expandUser(source);
    if (isFile(devPath) && isYamlSuffix(devPath)) {
      installLocal(devPath, devPath);
      return;
    }
    if (isFile(devPath) && archiveFormatFromName(devPath) !== null) {
      await installArchive(projectRoot, workflowsDir, devPath, devPath);
      return;
    }
    if (isDir(devPath)) {
      const devWfFile = join(devPath, 'workflow.yml');
      if (!isFile(devWfFile)) {
        console.print(`[red]Error:[/red] No workflow.yml found in ${escapeMarkup(source)}`);
        throw new CliExit(1);
      }
      if (workflowPackageHasCompanions(devPath)) {
        await installWorkflowPackage(projectRoot, workflowsDir, devPath, devPath);
      } else {
        installLocal(devWfFile, devPath);
      }
      return;
    }
    console.print(
      '[red]Error:[/red] --dev source must be a workflow YAML file, ' +
        'supported archive, or directory containing workflow.yml: ' +
        `${escapeMarkup(source)}`,
    );
    throw new CliExit(1);
  }

  // Try as URL -- either the positional source is a URL, or --from names one.
  let downloadUrl: string | null =
    fromUrl !== null ? fromUrl : source.startsWith('http://') || source.startsWith('https://') ? source : null;
  if (downloadUrl !== null) {
    try {
      pyUrlParse(downloadUrl);
    } catch {
      console.print(`[red]Error:[/red] Invalid URL: ${escapeMarkup(downloadUrl)}`);
      throw new CliExit(1);
    }
    if (!isHttpsOrLocalhostHttp(downloadUrl)) {
      console.print('[red]Error:[/red] Only HTTPS URLs are allowed, except HTTP for localhost.');
      throw new CliExit(1);
    }

    if (fromUrl !== null) {
      const safeUrl = escapeMarkup(fromUrl);
      console.print();
      console.print(
        new Panel(
          '[bold]You are installing a workflow from an external URL ' +
            'that is not\nlisted in any of your configured workflow ' +
            'catalogs.[/bold]\n\n' +
            `URL: ${safeUrl}\n\n` +
            'Only install workflows from sources you trust.',
          {
            title: '[bold yellow]⚠ Untrusted Source[/bold yellow]',
            borderStyle: 'yellow',
            padding: [1, 2],
          },
        ),
      );
      console.print();
      if (!(await confirm('Continue with installation?', { default: false }))) {
        console.print('Cancelled');
        throw new CliExit(0);
      }
    }

    let extraHeaders: Record<string, string> | undefined;
    const resolvedWfUrl = await resolveGithubReleaseAssetApiUrl(downloadUrl, httpDeps.openUrl, {
      timeout: 30,
      githubHosts: githubProviderHosts(),
      redirectValidator: rejectInsecureDownloadRedirect,
    });
    if (resolvedWfUrl) {
      downloadUrl = resolvedWfUrl;
      extraHeaders = { Accept: 'application/octet-stream' };
    }

    const requestUrl: string = downloadUrl as string;
    let tmpPath: string | null = null;
    let downloadedArchiveFormat: ArchiveFormat | null = null;
    let finalUrl: string = requestUrl;
    let contentType: string | null = null;
    try {
      const resp = await httpDeps.openUrl(requestUrl, {
        timeout: 30,
        extraHeaders,
        redirectValidator: rejectInsecureDownloadRedirect,
      });
      finalUrl = responseUrl(resp, requestUrl);
      if (!isHttpsOrLocalhostHttp(finalUrl)) {
        console.print(`[red]Error:[/red] URL redirected to non-HTTPS: ${escapeMarkup(finalUrl)}`);
        throw new CliExit(1);
      }
      contentType = responseHeader(resp, 'Content-Type');
      downloadedArchiveFormat =
        archiveFormatFromName(finalUrl) ?? archiveFormatFromName(requestUrl) ?? archiveFormatFromContentType(contentType);
      const declaredYaml = workflowYamlIsDeclared(finalUrl, contentType);
      const suffix =
        downloadedArchiveFormat !== null ? archiveSuffix(downloadedArchiveFormat) : declaredYaml ? '.yml' : '.download';
      // Create the temp file before reading so a failed read can remove it.
      tmpPath = join(tmpdir(), `tmp${randomBytes(6).toString('hex')}${suffix}`);
      writeFileSync(tmpPath, new Uint8Array(0), { flag: 'wx', mode: 0o600 });
      let downloadedContent: Uint8Array;
      if (downloadedArchiveFormat !== null) {
        downloadedContent = await readResponseLimited(resp, { errorType: Error, label: 'workflow archive download' });
      } else if (declaredYaml) {
        downloadedContent = await readResponseWithinLimit(resp);
      } else {
        downloadedContent = await readResponseLimited(resp, { errorType: Error, label: 'workflow download' });
        downloadedArchiveFormat = sniffWorkflowArchiveFormat(downloadedContent) as ArchiveFormat | null;
        if (downloadedArchiveFormat === null) enforceWorkflowYamlSize(downloadedContent);
      }
      writeFileSync(tmpPath, downloadedContent);
    } catch (exc) {
      cleanupDownloadTmpPath(tmpPath);
      if (exc instanceof CliExit) throw exc;
      console.print(`[red]Error:[/red] Failed to download workflow: ${escapeMarkup(errMsg(exc))}`);
      throw new CliExit(1);
    }
    const downloadedPath = tmpPath as string;
    try {
      if (downloadedArchiveFormat === null) {
        installLocal(downloadedPath, requestUrl, fromUrl ? source : null);
      } else {
        await installArchive(projectRoot, workflowsDir, downloadedPath, requestUrl, {
          sourceName: finalUrl,
          contentType,
          expectedId: fromUrl ? source : null,
        });
      }
    } finally {
      // Best-effort: never mask the install outcome with a cleanup failure.
      try {
        unlinkSync(downloadedPath);
      } catch (exc) {
        if (!(isOsError(exc) && exc.code === 'ENOENT')) {
          console.print(
            '[yellow]Warning:[/yellow] Could not remove temporary ' +
              `workflow download file: ${escapeMarkup(osErrorMessage(exc))} ` +
              `(path: ${escapeMarkup(downloadedPath)})`,
          );
        }
      }
    }
    return;
  }

  // Try as a local file/directory.
  const sourcePath = source;
  if (pathExists(sourcePath)) {
    if (isFile(sourcePath) && isYamlSuffix(sourcePath)) {
      installLocal(sourcePath, sourcePath);
      return;
    } else if (isFile(sourcePath) && archiveFormatFromName(sourcePath) !== null) {
      await installArchive(projectRoot, workflowsDir, sourcePath, sourcePath);
      return;
    } else if (isDir(sourcePath)) {
      const wfFile = join(sourcePath, 'workflow.yml');
      if (!isFile(wfFile)) {
        console.print(`[red]Error:[/red] No workflow.yml found in ${escapeMarkup(source)}`);
        throw new CliExit(1);
      }
      if (workflowPackageHasCompanions(sourcePath)) {
        await installWorkflowPackage(projectRoot, workflowsDir, sourcePath, sourcePath);
      } else {
        installLocal(wfFile, sourcePath);
      }
      return;
    }
  }

  // Try from catalog.
  await installWorkflowFromCatalog(projectRoot, workflowsDir, source);
}
