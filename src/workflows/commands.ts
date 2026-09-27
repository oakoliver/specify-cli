/**
 * @oakoliver/specify-cli - Workflow Commands
 *
 * Port of ``specify_cli/workflows/_commands.py`` (shared infrastructure for
 * ``specify workflow`` commands) and the ``workflows/command_*.py`` handlers:
 * run, resume, status, list, remove, search, info, update, enable, disable and
 * resolve. ``add`` lives in ``command-add.ts``; the nested ``catalog``,
 * ``step`` and ``overlay`` sub-apps live in their own modules.
 *
 * @module workflows/commands
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync as realpath,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { resolveGithubReleaseAssetApiUrl } from '../authentication/github-http.js';
import { githubProviderHosts } from '../authentication/http.js';
import { defineCommand, dispatchGroup, type GroupSpec } from '../cli-args.js';
import { CliExit, confirm, console, errConsole, escapeMarkup, type Console } from '../console.js';
import {
  archiveFormatFromContentType,
  archiveFormatFromName,
  detectArchiveFormat,
  isHttpsOrLocalhostHttp,
  isSafeDownloadRedirect,
  readResponseLimited,
  safeExtractArchive,
} from '../download-security.js';
import { resolveInitDirOverride } from '../project.js';
import { ensureSafeSharedDirectory, verifyArchiveSha256 } from '../shared-infra.js';
import { InvalidVersion, Version } from '../version.js';
import { YAMLError } from '../yaml.js';
import {
  FileNotFoundError,
  ValueError,
  dget,
  errorMessage,
  isDict,
  pyJsonDumps,
  pyRepr,
  pyStr,
  pyTruthy,
  runtimeIO,
  type Dict,
} from './base.js';
import { WorkflowCatalog, WorkflowCatalogError, WorkflowRegistry, httpDeps, responseUrl } from './catalog/domain.js';
import { runWorkflowCatalogCommand } from './catalog/commands.js';
import { resolveRunOwnerRoot as resolveRunOwnerRootImpl } from './command-resume-state.js';
import {
  resolveInstalledWorkflowOwnership as resolveInstalledWorkflowOwnershipImpl,
  sameExistingPath,
} from './command-run-ownership.js';
import { workflowAdd } from './command-add.js';
import { RunState, WorkflowDefinition, WorkflowEngine, validateWorkflow } from './engine.js';
import { loadCustomSteps } from './index.js';
import { runWorkflowOverlayCommand } from './overlay/commands.js';
import { workflowResolve } from './overlay/operations.js';
import { runWorkflowStepCommand } from './step/commands.js';

// ============================================================================
// OS error helpers
// ============================================================================

/** Create an ``OSError``-like error (Node errno-style ``code``). */
export function osError(message: string, code = 'EIO'): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  e.name = 'OSError';
  return e;
}

/** True for a Node filesystem error / ``OSError`` equivalent. */
export function isOsError(exc: unknown): exc is NodeJS.ErrnoException {
  if (!(exc instanceof Error)) return false;
  const code = (exc as NodeJS.ErrnoException).code;
  return exc.name === 'OSError' || (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code));
}

/** Python ``str(OSError)`` rendering for a Node fs error (best effort). */
export function osErrorText(exc: unknown): string {
  const e = exc as NodeJS.ErrnoException;
  if (!(exc instanceof Error)) return String(exc);
  const errnoMap: Record<string, [number, string]> = {
    ENOENT: [2, 'No such file or directory'],
    EACCES: [13, 'Permission denied'],
    EPERM: [1, 'Operation not permitted'],
    EEXIST: [17, 'File exists'],
    ENOTDIR: [20, 'Not a directory'],
    EISDIR: [21, 'Is a directory'],
    ENOTEMPTY: [66, 'Directory not empty'],
    ELOOP: [62, 'Too many levels of symbolic links'],
    ENOSPC: [28, 'No space left on device'],
  };
  if (e.name !== 'OSError' && typeof e.code === 'string' && errnoMap[e.code] && e.path) {
    const [num, text] = errnoMap[e.code] as [number, string];
    const dest = (e as NodeJS.ErrnoException & { dest?: string }).dest;
    return dest
      ? `[Errno ${num}] ${text}: ${pyRepr(e.path)} -> ${pyRepr(dest)}`
      : `[Errno ${num}] ${text}: ${pyRepr(e.path)}`;
  }
  return e.message;
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** ``os.path.samestat``. */
function samestat(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** ``Path.resolve()`` (symlinks resolved for the existing prefix). */
function resolveLoose(p: string): string {
  const abs = resolve(p);
  const tail: string[] = [];
  let head = abs;
  for (;;) {
    try {
      const real = realpath(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs;
      tail.push(basename(head));
      head = parent;
    }
  }
}

/** ``child.relative_to(root)`` succeeded. */
function isRelativeTo(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

// ============================================================================
// Consoles & registry
// ============================================================================

/**
 * Console for error text: stderr under ``--json`` so the JSON stdout stream
 * stays parseable, the normal console otherwise.
 */
export function errorConsole(jsonOutput: boolean): Console {
  return jsonOutput ? errConsole : console;
}

/** Construct a WorkflowRegistry, exiting cleanly on an unreadable file. */
export function openWorkflowRegistry(projectRoot: string, out: Console | null = null): WorkflowRegistry {
  try {
    return new WorkflowRegistry(projectRoot);
  } catch (exc) {
    if (!isOsError(exc)) throw exc;
    (out ?? console).print(
      `[red]Error:[/red] Failed to read workflow registry: ${escapeMarkup(osErrorText(exc))}`,
    );
    throw new CliExit(1);
  }
}

/** Fail closed for corrupted or explicitly disabled registry entries. */
export function requireEnabledWorkflow(registryRoot: string, workflowId: string, out: Console): boolean {
  const metadata = openWorkflowRegistry(registryRoot, out).get(workflowId);
  if (metadata !== null && metadata !== undefined && !isDict(metadata)) {
    out.print(`[red]Error:[/red] Registry entry for '${escapeMarkup(workflowId)}' is corrupted`);
    throw new CliExit(1);
  }
  if (isDict(metadata) && !pyTruthy(dget(metadata, 'enabled', true))) {
    out.print(
      `[red]Error:[/red] Workflow '${escapeMarkup(workflowId)}' is disabled. ` +
        `Enable with: specify workflow enable ${escapeMarkup(workflowId)}`,
    );
    throw new CliExit(1);
  }
  return metadata !== null && metadata !== undefined;
}

/** Forward to the resume-private owner-state resolver. */
export function resolveRunOwnerRoot(installedRegistryRoot: string | null, projectRoot: string): string {
  return resolveRunOwnerRootImpl(installedRegistryRoot, projectRoot);
}

/**
 * Parse repeated ``key=value`` CLI inputs into a dict. Exits with an error on
 * any entry missing ``=``.
 */
export function parseInputValues(inputValues: string[] | null | undefined, opts: { jsonOutput?: boolean } = {}): Dict {
  const inputs: Dict = {};
  for (const kv of inputValues ?? []) {
    const eq = kv.indexOf('=');
    if (eq === -1) {
      errorConsole(Boolean(opts.jsonOutput)).print(
        `[red]Error:[/red] Invalid input format: ${pyRepr(kv)} (expected key=value)`,
      );
      throw new CliExit(1);
    }
    inputs[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  return inputs;
}

/**
 * Refuse to proceed when *path* is a symlink or an existing non-directory.
 * Absence is tolerated.
 */
export function rejectUnsafeDir(path: string, label: string): void {
  if (isSymlink(path)) {
    errConsole.print(`[red]Error:[/red] Refusing to use symlinked ${label} path`);
    throw new CliExit(1);
  }
  if (pathExists(path) && !isDir(path)) {
    errConsole.print(`[red]Error:[/red] ${label} path exists but is not a directory`);
    throw new CliExit(1);
  }
}

/** Refuse symlinked workflow storage directories before workflow commands run. */
export function rejectUnsafeWorkflowStorage(projectRoot: string): void {
  rejectUnsafeDir(join(projectRoot, '.specify'), '.specify');
  rejectUnsafeDir(join(projectRoot, '.specify', 'workflows'), '.specify/workflows');
  rejectUnsafeDir(join(projectRoot, '.specify', 'workflows', 'runs'), '.specify/workflows/runs');
  rejectUnsafeDir(join(projectRoot, '.specify', 'workflows', 'overlays'), '.specify/workflows/overlays');
}

/** Forward to the run-private installed-workflow ownership resolver. */
export function resolveInstalledWorkflowOwnership(sourcePath: string, err: Console): [string | null, string | null] {
  return resolveInstalledWorkflowOwnershipImpl(sourcePath, err);
}

export const WORKFLOW_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const RESERVED_WORKFLOW_IDS: ReadonlySet<string> = new Set(['overlays', 'runs', 'steps']);

/** Reject insecure redirects before they are followed. */
export function rejectInsecureDownloadRedirect(oldUrl: string, newUrl: string): void {
  if (isSafeDownloadRedirect(oldUrl, newUrl)) return;
  const e = new Error(
    'redirect target must use HTTPS without entering a local target; ' +
      'loopback HTTP may only redirect from another loopback URL',
  );
  e.name = 'URLError';
  throw e;
}

/**
 * Workflow YAML definitions are small step/metadata text, not binaries, so
 * this is generous headroom. Mutable so tests can override it (upstream tests
 * monkeypatch ``_MAX_WORKFLOW_YAML_BYTES``).
 */
export const workflowLimits = { maxWorkflowYamlBytes: 5 * 1024 * 1024, downloadChunkSize: 65536 };

function responseHeader(resp: unknown, name: string): string | null {
  const r = resp as {
    getheader?: (n: string) => string | null | undefined;
    headers?: { get?: (n: string) => string | null } | Record<string, string>;
  };
  try {
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
  } catch {
    return null;
  }
  return null;
}

/**
 * Read *response* fully, enforcing *maxBytes* via bounded streaming. A
 * ``Content-Length`` header is checked up front, and the bytes actually read
 * are also counted.
 */
export async function readResponseWithinLimit(response: unknown, maxBytes: number | null = null): Promise<Uint8Array> {
  const limit = maxBytes ?? workflowLimits.maxWorkflowYamlBytes;
  const rawLength = responseHeader(response, 'Content-Length');
  let contentLength: number | null = null;
  if (rawLength !== null && rawLength !== undefined) {
    const n = Number.parseInt(String(rawLength).trim(), 10);
    contentLength = /^\s*[+-]?\d+\s*$/.test(String(rawLength)) && Number.isFinite(n) ? n : null;
  }
  if (contentLength !== null && contentLength > limit) {
    throw new ValueError(
      `response declared ${contentLength} bytes, exceeding the ${limit}-byte workflow size limit`,
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (chunk: Uint8Array): void => {
    total += chunk.length;
    if (total > limit) throw new ValueError(`response exceeds the ${limit}-byte workflow size limit`);
    chunks.push(chunk);
  };
  const r = response as {
    read?: (n?: number) => unknown;
    body?: { getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof r.read === 'function') {
    for (;;) {
      const chunk = (await r.read(workflowLimits.downloadChunkSize)) as Uint8Array | string | null | undefined;
      if (!chunk || chunk.length === 0) break;
      push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    }
  } else if (r.body && typeof r.body.getReader === 'function') {
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) push(value);
    }
  } else if (typeof r.arrayBuffer === 'function') {
    push(new Uint8Array(await r.arrayBuffer()));
  }
  return Buffer.concat(chunks);
}

/** Return whether response metadata explicitly identifies workflow YAML. */
export function workflowYamlIsDeclared(sourceName: string, contentType: string | null | undefined): boolean {
  let path: string;
  try {
    path = new URL(sourceName).pathname;
  } catch {
    path = sourceName.split(/[?#]/)[0] ?? '';
  }
  path = path.toLowerCase();
  const mediaType = (contentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return (
    path.endsWith('.yml') ||
    path.endsWith('.yaml') ||
    ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml'].includes(mediaType)
  );
}

/** Return a supported archive format when suffixless response bytes match. */
export function sniffWorkflowArchiveFormat(data: Uint8Array): string | null {
  try {
    return detectArchiveFormat('workflow-download', { archiveFile: Buffer.from(data) }) as string;
  } catch {
    return null;
  }
}

/** Raise when downloaded YAML exceeds the workflow size limit. */
export function enforceWorkflowYamlSize(data: Uint8Array): void {
  if (data.length > workflowLimits.maxWorkflowYamlBytes) {
    throw new ValueError(`response exceeds the ${workflowLimits.maxWorkflowYamlBytes}-byte workflow size limit`);
  }
}

/** Validate that ``workflowId`` is a safe installed-workflow directory name. */
export function validateWorkflowIdOrExit(workflowId: string): void {
  if (RESERVED_WORKFLOW_IDS.has(workflowId) || !WORKFLOW_ID_PATTERN.test(workflowId)) {
    console.print(`[red]Error:[/red] Invalid workflow ID: ${escapeMarkup(pyRepr(workflowId))}`);
    throw new CliExit(1);
  }
}

/** Validate the per-id install directory before any write and return it. */
export function safeWorkflowIdDir(workflowsDir: string, workflowId: string): string {
  const safeId = escapeMarkup(workflowId);
  validateWorkflowIdOrExit(workflowId);

  const destDir = join(workflowsDir, workflowId);
  rejectUnsafeDir(destDir, `.specify/workflows/${safeId}`);
  if (!isRelativeTo(resolveLoose(destDir), resolveLoose(workflowsDir))) {
    console.print(`[red]Error:[/red] Invalid workflow ID: ${escapeMarkup(pyRepr(workflowId))}`);
    throw new CliExit(1);
  }
  const workflowYml = join(destDir, 'workflow.yml');
  if (isSymlink(workflowYml)) {
    console.print(
      '[red]Error:[/red] Refusing to write through symlinked ' + `.specify/workflows/${safeId}/workflow.yml`,
    );
    throw new CliExit(1);
  }
  if (pathExists(workflowYml) && !isFile(workflowYml)) {
    console.print(`[red]Error:[/red] .specify/workflows/${safeId}/workflow.yml exists but is not a file`);
    throw new CliExit(1);
  }
  return destDir;
}

// ============================================================================
// Staged file install primitives
// ============================================================================

/** Exclusive staging inode kept open until its atomic commit. */
export class StagedWorkflowFile {
  path: string;
  fd: number;

  constructor(path: string, fd: number) {
    this.path = path;
    this.fd = fd;
  }

  private write(chunks: Uint8Array[]): void {
    ftruncateSync(this.fd, 0);
    let position = 0;
    for (const chunk of chunks) {
      let offset = 0;
      while (offset < chunk.length) {
        const written = writeSync(this.fd, chunk, offset, chunk.length - offset, position);
        if (written <= 0) throw osError('Failed to write staged workflow file');
        offset += written;
        position += written;
      }
    }
  }

  writeBytes(data: Uint8Array): void {
    this.write([data]);
  }

  verifyPath(): void {
    let pathStat: Stats;
    let openStat: Stats;
    try {
      pathStat = lstatSync(this.path);
      openStat = fstatSync(this.fd);
    } catch {
      throw osError('Staged workflow file changed before commit');
    }
    if (!pathStat.isFile() || !samestat(pathStat, openStat)) {
      throw osError('Staged workflow file changed before commit');
    }
  }

  setMode(mode: number): void {
    if (process.platform !== 'win32') fchmodSync(this.fd, mode);
  }

  close(): void {
    if (this.fd < 0) return;
    const fd = this.fd;
    this.fd = -1;
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function mkstemp(dir: string, prefix: string, suffix: string, mode = 0o600): [number, string] {
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = join(dir, `${prefix}${randomBytes(6).toString('base64url').replace(/[-_]/g, 'x')}${suffix}`);
    try {
      const fd = openSync(name, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
      return [fd, name];
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw exc;
    }
  }
  throw osError('No usable temporary file name found', 'EEXIST');
}

const O_NOFOLLOW = (fsConstants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/**
 * Reserve a same-directory staging file so new/updated workflow.yml content
 * can be written and validated without touching an existing destination file
 * before the final atomic swap.
 */
export function stageWorkflowFile(destDir: string, opts: { useProjectFileMode?: boolean } = {}): StagedWorkflowFile {
  const createdDir = !pathExists(destDir);
  mkdirSync(destDir, { recursive: true });
  let fd = -1;
  let stagedFile: string | null = null;
  try {
    [fd, stagedFile] = mkstemp(destDir, '.workflow.yml.', '.tmp');
    if (opts.useProjectFileMode) {
      closeSync(fd);
      fd = -1;
      unlinkSync(stagedFile);
      fd = openSync(stagedFile, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o666);
    }
  } catch (exc) {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    if (stagedFile !== null) {
      try {
        unlinkSync(stagedFile);
      } catch {
        // ignore
      }
    }
    if (createdDir) {
      try {
        rmdirSync(destDir);
      } catch (cleanupExc) {
        console.print(
          '[yellow]Warning:[/yellow] Failed to remove incomplete ' +
            `workflow directory: ${escapeMarkup(osErrorText(cleanupExc))}`,
        );
      }
    }
    throw exc;
  }
  return new StagedWorkflowFile(stagedFile, fd);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Serialize workflow file swaps with their registry updates.
 *
 * Upstream holds an ``flock`` on ``.specify/.workflow-install.lock``. Node has
 * no ``flock``, so the port keeps the same (symlink-checked) lock file and
 * serializes on an exclusively created sibling directory
 * ``.workflow-install.lock.d`` (removed on exit; reclaimed when stale).
 * Accepts a synchronous or asynchronous body.
 */
export function workflowInstallTransaction<T>(projectRoot: string, fn: () => T): T {
  const lockDir = join(projectRoot, '.specify');
  try {
    ensureSafeSharedDirectory(projectRoot, lockDir, { context: 'workflow install lock directory' });
  } catch (exc) {
    if (isOsError(exc)) throw exc;
    throw osError(errorMessage(exc), 'EPERM');
  }
  const lockFile = join(lockDir, '.workflow-install.lock');
  if (isSymlink(lockFile)) throw osError(`Refusing to use symlinked workflow install lock: ${lockFile}`, 'ELOOP');

  const fd = openSync(lockFile, fsConstants.O_RDWR | fsConstants.O_CREAT | O_NOFOLLOW, 0o600);
  let mutex: string | null = null;
  const release = (): void => {
    if (mutex !== null) {
      try {
        rmdirSync(mutex);
      } catch {
        // ignore
      }
      mutex = null;
    }
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  };
  try {
    if (isSymlink(lockFile)) throw osError(`Refusing to use symlinked workflow install lock: ${lockFile}`, 'ELOOP');
    const mutexPath = `${lockFile}.d`;
    for (;;) {
      try {
        mkdirSync(mutexPath);
        mutex = mutexPath;
        break;
      } catch (exc) {
        if ((exc as NodeJS.ErrnoException).code !== 'EEXIST') throw exc;
        try {
          if (Date.now() - statSync(mutexPath).mtimeMs > LOCK_STALE_MS) rmdirSync(mutexPath);
        } catch {
          // Raced with the holder; retry.
        }
        sleepSync(50);
      }
    }
  } catch (exc) {
    release();
    throw exc;
  }
  let result: T;
  try {
    result = fn();
  } catch (exc) {
    release();
    throw exc;
  }
  if (result && typeof (result as unknown as Promise<unknown>).then === 'function') {
    return (result as unknown as Promise<unknown>).then(
      (v) => {
        release();
        return v;
      },
      (e: unknown) => {
        release();
        throw e;
      },
    ) as unknown as T;
  }
  release();
  return result;
}

/**
 * Atomically swap ``stagedFile`` onto ``destFile``. If a prior file existed,
 * it is first renamed to a unique sibling (path returned) so a later failure
 * can restore it via rename.
 */
export function commitWorkflowFile(
  stagedFile: string | StagedWorkflowFile,
  destFile: string,
  existedBefore: boolean,
): string | null {
  const stagedPath = stagedFile instanceof StagedWorkflowFile ? stagedFile.path : stagedFile;
  if (stagedFile instanceof StagedWorkflowFile) stagedFile.verifyPath();
  if (existedBefore && pathExists(destFile)) {
    const destState = lstatSync(destFile);
    const mode = destState.mode & 0o7777;
    if (stagedFile instanceof StagedWorkflowFile) stagedFile.setMode(mode);
    else if (process.platform !== 'win32') {
      // chmod the path directly.
      const f = openSync(stagedPath, 'r');
      try {
        fchmodSync(f, mode);
      } finally {
        closeSync(f);
      }
    }
    const [fd, backupName] = mkstemp(dirname(destFile), `.${basename(destFile)}.`, '.bak');
    let placeholderState: Stats;
    try {
      placeholderState = fstatSync(fd);
    } finally {
      closeSync(fd);
    }
    const backupFile = backupName;
    try {
      renameSync(destFile, backupFile);
    } catch (moveExc) {
      let backupState: Stats | null = null;
      try {
        backupState = lstatSync(backupFile);
      } catch {
        // ignore
      }
      if (backupState !== null && samestat(destState, backupState)) {
        try {
          renameSync(backupFile, destFile);
        } catch (restoreExc) {
          throw osError(
            `Failed to stage prior workflow (${osErrorText(moveExc)}); failed ` +
              `to restore it from ${backupFile} (${osErrorText(restoreExc)}). ` +
              `The prior workflow remains at ${backupFile}.`,
          );
        }
      } else if (backupState !== null && samestat(placeholderState, backupState)) {
        try {
          unlinkSync(backupFile);
        } catch {
          // ignore
        }
      }
      throw moveExc;
    }
    try {
      if (stagedFile instanceof StagedWorkflowFile) {
        stagedFile.verifyPath();
        stagedFile.close();
      }
      renameSync(stagedPath, destFile);
    } catch (commitExc) {
      try {
        renameSync(backupFile, destFile);
      } catch (restoreExc) {
        throw osError(
          `Failed to commit workflow file (${osErrorText(commitExc)}); failed ` +
            `to restore the prior workflow from ${backupFile} ` +
            `(${osErrorText(restoreExc)}). The prior workflow remains at ` +
            `${backupFile}.`,
        );
      }
      throw commitExc;
    }
    return backupFile;
  }
  if (stagedFile instanceof StagedWorkflowFile) {
    stagedFile.verifyPath();
    stagedFile.close();
  }
  renameSync(stagedPath, destFile);
  return null;
}

/** Clean up after a pre-commit failure (the staged file was never swapped in). */
export function discardStagedWorkflowFile(
  stagedFile: string | StagedWorkflowFile,
  destDir: string,
  existedBefore: boolean,
): void {
  const stagedPath = stagedFile instanceof StagedWorkflowFile ? stagedFile.path : stagedFile;
  if (stagedFile instanceof StagedWorkflowFile) stagedFile.close();
  try {
    unlinkSync(stagedPath);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== 'ENOENT') throw exc;
  }
  if (!existedBefore && pathExists(destDir)) {
    try {
      rmdirSync(destDir);
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw exc;
    }
  }
}

/** Undo a successful ``commitWorkflowFile`` swap after a later failure. */
export function rollbackCommittedWorkflowFile(
  destFile: string,
  destDir: string,
  existedBefore: boolean,
  backupFile: string | null,
): void {
  if (backupFile !== null) {
    renameSync(backupFile, destFile);
    return;
  }
  try {
    unlinkSync(destFile);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code !== 'ENOENT') throw exc;
  }
  if (!existedBefore && pathExists(destDir)) {
    try {
      rmdirSync(destDir);
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw exc;
    }
  }
}

/** Guarded wrapper: a cleanup failure is reported, never crashes. */
export function safeDiscardStagedWorkflowFile(
  stagedFile: string | StagedWorkflowFile,
  destDir: string,
  existedBefore: boolean,
): void {
  try {
    discardStagedWorkflowFile(stagedFile, destDir, existedBefore);
  } catch (exc) {
    if (!isOsError(exc)) throw exc;
    console.print(
      '[yellow]Warning:[/yellow] Failed to clean up incomplete workflow ' + `install: ${escapeMarkup(osErrorText(exc))}`,
    );
  }
}

/** Guarded wrapper: a rollback failure is reported, never crashes. */
export function safeRollbackCommittedWorkflowFile(
  destFile: string,
  destDir: string,
  existedBefore: boolean,
  backupFile: string | null,
): void {
  try {
    rollbackCommittedWorkflowFile(destFile, destDir, existedBefore, backupFile);
  } catch (exc) {
    if (!isOsError(exc)) throw exc;
    console.print(
      '[yellow]Warning:[/yellow] Failed to restore prior workflow file ' +
        `after registry update failure: ${escapeMarkup(osErrorText(exc))}`,
    );
  }
}

/** Discard the renamed-aside prior file once the registry update succeeded. */
export function discardCommittedBackupFile(backupFile: string | null): void {
  if (backupFile === null) return;
  try {
    unlinkSync(backupFile);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (!isOsError(exc)) throw exc;
    console.print(
      '[yellow]Warning:[/yellow] Workflow installed, but its backup file ' +
        `could not be cleaned up: ${escapeMarkup(osErrorText(exc))}. Remove it ` +
        `manually: ${escapeMarkup(backupFile)}`,
    );
  }
}

/** Resolve a root-level or single-nested workflow package. */
export function workflowPackageRoot(extractedRoot: string): string {
  if (isFile(join(extractedRoot, 'workflow.yml'))) return extractedRoot;
  const entries = readdirSync(extractedRoot);
  if (entries.length === 1) {
    const only = join(extractedRoot, entries[0] as string);
    if (isDir(only) && !isSymlink(only) && isFile(join(only, 'workflow.yml'))) return only;
  }
  throw new ValueError(
    'Archive must contain workflow.yml at its root or in exactly one ' + 'top-level directory',
  );
}

/** Reject links and special files before copying a local package. */
export function validateLocalWorkflowPackage(packageDir: string): void {
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) throw new ValueError(`Workflow package contains symlink: ${path}`);
      if (!st.isDirectory() && !st.isFile()) {
        throw new ValueError(`Workflow package contains unsupported file: ${path}`);
      }
      if (st.isDirectory()) walk(path);
    }
  };
  walk(packageDir);
}

/** Options for {@link installWorkflowPackage}. */
export interface InstallWorkflowPackageOptions {
  expectedId?: string | null;
  expectedVersion?: string | null;
  expectedInstalledVersion?: string | null;
  catalogInfo?: Dict | null;
}

/** Validate and atomically install a complete workflow package directory. */
export async function installWorkflowPackage(
  projectRoot: string,
  workflowsDir: string,
  packageDir: string,
  sourceLabel: string,
  opts: InstallWorkflowPackageOptions = {},
): Promise<void> {
  const expectedId = opts.expectedId ?? null;
  const expectedVersion = opts.expectedVersion ?? null;
  const expectedInstalledVersion = opts.expectedInstalledVersion ?? null;
  const catalogInfo = opts.catalogInfo ?? null;
  const workflowFile = join(packageDir, 'workflow.yml');
  let definition: WorkflowDefinition;
  try {
    validateLocalWorkflowPackage(packageDir);
    const bytes = readFileSync(workflowFile);
    definition = WorkflowDefinition.fromString(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (exc) {
    if (isOsError(exc) || exc instanceof ValueError || exc instanceof YAMLError || exc instanceof TypeError) {
      console.print(`[red]Error:[/red] Invalid workflow package: ${escapeMarkup(osErrorText(exc))}`);
      throw new CliExit(1);
    }
    throw exc;
  }

  const errors = validateWorkflow(definition);
  if (errors.length) {
    console.print('[red]Error:[/red] Workflow validation failed:');
    for (const error of errors) console.print(`  • ${escapeMarkup(pyStr(error))}`);
    throw new CliExit(1);
  }
  if (typeof definition.id !== 'string' || !definition.id.trim()) {
    console.print("[red]Error:[/red] Workflow definition has an empty or missing 'id'");
    throw new CliExit(1);
  }
  const defId = definition.id;
  if (expectedId !== null && defId !== expectedId) {
    console.print(
      '[red]Error:[/red] Workflow ID in YAML ' +
        `(${escapeMarkup(pyRepr(defId))}) does not match the requested ` +
        `workflow ID (${escapeMarkup(pyRepr(expectedId))}).`,
    );
    throw new CliExit(1);
  }
  if (expectedVersion !== null && pyStr(definition.version) !== expectedVersion) {
    console.print(
      '[red]Error:[/red] Downloaded workflow version ' +
        `(${escapeMarkup(pyStr(definition.version))}) does not match the catalog ` +
        `version (${escapeMarkup(expectedVersion)}).`,
    );
    throw new CliExit(1);
  }

  const destDir = safeWorkflowIdDir(workflowsDir, defId);
  const stagedDir = mkdtempSync(join(workflowsDir, `.${defId}.installing-`));
  try {
    const packageRoot = resolveLoose(packageDir);
    cpSync(packageDir, stagedDir, {
      recursive: true,
      force: true,
      filter: (src) => !(dirname(resolveLoose(src)) === packageRoot && basename(src) === 'overlays'),
    });
  } catch (exc) {
    rmSync(stagedDir, { recursive: true, force: true });
    if (!isOsError(exc)) throw exc;
    console.print(`[red]Error:[/red] Failed to stage workflow package: ${escapeMarkup(osErrorText(exc))}`);
    throw new CliExit(1);
  }

  let backupDir: string | null = null;
  try {
    workflowInstallTransaction(projectRoot, () => {
      const registry = openWorkflowRegistry(projectRoot);
      const existing = registry.get(defId);
      if (
        expectedInstalledVersion !== null &&
        (!isDict(existing) ||
          dget(existing, 'source', null) !== 'catalog' ||
          pyStr(dget(existing, 'version', null)) !== expectedInstalledVersion)
      ) {
        console.print(
          `[yellow]Warning:[/yellow] Workflow '${escapeMarkup(defId)}' changed during update; rerun the command.`,
        );
        throw new CliExit(1);
      }
      if (pathExists(destDir)) {
        backupDir = mkdtempSync(join(workflowsDir, `.${defId}.backup-`));
        rmdirSync(backupDir);
        renameSync(destDir, backupDir);
      }
      try {
        renameSync(stagedDir, destDir);
      } catch (exc) {
        if (backupDir !== null) {
          renameSync(backupDir, destDir);
          backupDir = null;
        }
        throw exc;
      }

      const entry: Dict = {
        name: definition.name,
        version: definition.version,
        description: definition.description,
        source: sourceLabel,
      };
      if (catalogInfo !== null) {
        entry.source = 'catalog';
        entry.catalog_name = dget(catalogInfo, '_catalog_name', '');
        entry.url = dget(catalogInfo, 'url', '');
      }
      if (isDict(existing) && !pyTruthy(dget(existing, 'enabled', true))) entry.enabled = false;
      try {
        registry.add(defId, entry);
      } catch (exc) {
        if (!(isOsError(exc) || exc instanceof TypeError || exc instanceof ValueError)) throw exc;
        let failedDir: string | null = null;
        try {
          failedDir = mkdtempSync(join(workflowsDir, `.${defId}.failed-`));
          rmdirSync(failedDir);
          renameSync(destDir, failedDir);
          if (backupDir !== null) {
            renameSync(backupDir, destDir);
            backupDir = null;
          }
        } catch (rollbackExc) {
          console.print(
            '[yellow]Warning:[/yellow] Failed to fully restore the prior ' +
              `workflow package: ${escapeMarkup(osErrorText(rollbackExc))}`,
          );
        } finally {
          if (failedDir !== null && pathExists(failedDir)) {
            try {
              rmSync(failedDir, { recursive: true });
            } catch (cleanupExc) {
              console.print(
                '[yellow]Warning:[/yellow] Could not remove failed ' +
                  `workflow package: ${escapeMarkup(osErrorText(cleanupExc))}`,
              );
            }
          }
        }
        throw exc;
      }
    });
  } catch (exc) {
    if (pathExists(stagedDir)) rmSync(stagedDir, { recursive: true, force: true });
    if (exc instanceof CliExit) throw exc;
    if (isOsError(exc) || exc instanceof TypeError || exc instanceof ValueError) {
      console.print(`[red]Error:[/red] Failed to install workflow package: ${escapeMarkup(osErrorText(exc))}`);
      throw new CliExit(1);
    }
    throw exc;
  }
  if (pathExists(stagedDir)) rmSync(stagedDir, { recursive: true, force: true });

  const finalBackup = backupDir as string | null;
  if (finalBackup !== null) {
    try {
      rmSync(finalBackup, { recursive: true });
    } catch (exc) {
      console.print(
        '[yellow]Warning:[/yellow] Workflow installed, but its backup ' +
          `directory could not be removed: ${escapeMarkup(osErrorText(exc))}`,
      );
    }
  }
  console.print(
    `[green]✓[/green] Workflow '${escapeMarkup(pyStr(definition.name))}' ` + `(${escapeMarkup(defId)}) installed`,
  );
}

// ============================================================================
// Project resolution
// ============================================================================

/**
 * Return the project root if it is a spec-kit project, else exit; then
 * refuse symlinked workflow storage (``_commands._require_specify_project``).
 */
export function requireSpecifyProject(): string {
  const override = resolveInitDirOverride();
  let projectRoot: string;
  if (override !== null && override !== undefined) {
    projectRoot = override;
  } else {
    projectRoot = process.cwd();
    if (!isDir(join(projectRoot, '.specify'))) {
      errConsole.print('[red]Error:[/red] Not a Spec Kit project (no .specify/ directory)');
      errConsole.print('Run this command from a Spec Kit project root or set SPECIFY_INIT_DIR to one.');
      throw new CliExit(1);
    }
  }
  rejectUnsafeWorkflowStorage(projectRoot);
  return projectRoot;
}

// ============================================================================
// Run outcome payloads
// ============================================================================

/** Terminal error for a failed/aborted run, if any. */
export function failedStepError(state: RunState): string | null {
  if (state.status !== 'failed' && state.status !== 'aborted') return null;
  return state.error ?? null;
}

/** Whether a recorded step result is a gate. */
export function isGateStep(step: Dict): boolean {
  const stepType = dget(step, 'type', null);
  if (stepType === 'gate') return true;
  if (pyTruthy(stepType)) return false;
  const output = dget(step, 'output', null);
  return isDict(output) && Object.prototype.hasOwnProperty.call(output, 'on_reject');
}

/** Normalise a gate's ``options`` to a stable ``string[]`` (or ``null``). */
export function normalizeGateOptions(options: unknown): string[] | null {
  if (options === null || options === undefined) return null;
  if (Array.isArray(options)) return options.map((o) => pyStr(o));
  return [pyStr(options)];
}

/** Gate detail for the structured outcome, when the run rests at a gate. */
export function gateOutcome(state: RunState): Dict | null {
  if (state.status !== 'paused' && state.status !== 'aborted') return null;
  const step = state.currentStepId !== null ? (state.stepResults ?? {})[state.currentStepId] : undefined;
  if (!isDict(step) || !isGateStep(step)) return null;
  const rawOutput = dget(step, 'output', null);
  const output = isDict(rawOutput) ? rawOutput : {};
  const message = dget(output, 'message', null);
  const choice = dget(output, 'choice', null);
  return {
    step_id: state.currentStepId,
    message: message === null || message === undefined ? null : pyStr(message),
    options: normalizeGateOptions(dget(output, 'options', null)),
    choice: choice === null || choice === undefined ? null : pyStr(choice),
  };
}

/** Machine-readable summary of a run/resume outcome. */
export function workflowRunPayload(state: RunState): Dict {
  const payload: Dict = {
    run_id: state.runId,
    workflow_id: state.workflowId,
    status: state.status,
    current_step_id: state.currentStepId,
    current_step_index: state.currentStepIndex,
  };
  const gate = gateOutcome(state);
  if (gate !== null) payload.gate = gate;
  const error = failedStepError(state);
  if (error !== null) payload.error = error;
  return payload;
}

/** Exit code for a finished run/resume: non-zero on terminal failure. */
export function runOutcomeExitCode(statusValue: string): number {
  return statusValue === 'failed' || statusValue === 'aborted' ? 1 : 0;
}

/** Write a workflow payload as machine-readable JSON to stdout. */
export function emitWorkflowJson(payload: Dict): void {
  process.stdout.write(pyJsonDumps(payload, 2) + '\n');
}

/**
 * Redirect everything written to stdout onto stderr while *active* (so a
 * ``--json`` stream stays clean while steps run). Also flags
 * ``runtimeIO.stdoutToStderr`` so subprocesses spawned by steps route their
 * inherited stdout onto stderr.
 */
export async function stdoutToStderrWhen<T>(active: boolean, fn: () => Promise<T>): Promise<T> {
  if (!active) return fn();
  const origWrite = process.stdout.write;
  const prevFlag = runtimeIO.stdoutToStderr;
  runtimeIO.stdoutToStderr = true;
  (process.stdout as unknown as { write: unknown }).write = (...args: unknown[]): boolean =>
    (process.stderr.write as (...a: unknown[]) => boolean).apply(process.stderr, args);
  try {
    return await fn();
  } finally {
    (process.stdout as unknown as { write: unknown }).write = origWrite;
    runtimeIO.stdoutToStderr = prevFlag;
  }
}

// ============================================================================
// Catalog install
// ============================================================================

/** ``urlparse(url).port`` raises ``ValueError`` (non-numeric / out-of-range port). */
function urlHasInvalidPort(url: string): boolean {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url);
  if (!m) return false;
  let netloc = (m[1] as string).split('@').pop() as string;
  if (netloc.startsWith('[')) {
    const close = netloc.indexOf(']');
    if (close === -1) return true;
    netloc = netloc.slice(close + 1);
  }
  const colon = netloc.lastIndexOf(':');
  if (colon === -1) return false;
  const port = netloc.slice(colon + 1);
  if (port === '') return false;
  if (!/^\d+$/.test(port)) return true;
  return parseInt(port, 10) > 65535;
}

function versionsMatch(actual: unknown, expected: string): boolean {
  try {
    return new Version(pyStr(actual)).equals(new Version(expected));
  } catch (exc) {
    if (exc instanceof InvalidVersion) return pyStr(actual) === expected;
    throw exc;
  }
}

/**
 * Download, validate, and register a catalog workflow. Shared by
 * ``workflow add`` and ``workflow update``. Throws ``CliExit`` on any failure;
 * the registry entry is only written on full success.
 */
export async function installWorkflowFromCatalog(
  projectRoot: string,
  workflowsDir: string,
  workflowId: string,
  expectedVersion: string | null = null,
  expectedInstalledVersion: string | null = null,
): Promise<void> {
  const safeWfId = escapeMarkup(workflowId);

  const catalog = new WorkflowCatalog(projectRoot);
  let info: Dict | null;
  try {
    info = await catalog.getWorkflowInfo(workflowId);
  } catch (exc) {
    if (exc instanceof WorkflowCatalogError) {
      console.print(`[red]Error:[/red] ${escapeMarkup(exc.message)}`);
      throw new CliExit(1);
    }
    throw exc;
  }

  if (!info || !Object.keys(info).length) {
    console.print(`[red]Error:[/red] Workflow '${safeWfId}' not found in catalog`);
    throw new CliExit(1);
  }

  if (!pyTruthy(dget(info, '_install_allowed', true))) {
    console.print(`[yellow]Warning:[/yellow] Workflow '${safeWfId}' is from a discovery-only catalog`);
    console.print('Direct installation is not enabled for this catalog source.');
    throw new CliExit(1);
  }

  let workflowUrl = dget(info, 'url', null);
  if (!pyTruthy(workflowUrl)) {
    console.print(`[red]Error:[/red] Workflow '${safeWfId}' does not have an install URL in the catalog`);
    throw new CliExit(1);
  }
  if (typeof workflowUrl !== 'string') {
    console.print(`[red]Error:[/red] Workflow '${safeWfId}' has a malformed install URL.`);
    throw new CliExit(1);
  }

  if (urlHasInvalidPort(workflowUrl)) {
    console.print(`[red]Error:[/red] Workflow '${safeWfId}' has a malformed install URL.`);
    throw new CliExit(1);
  }
  if (!isHttpsOrLocalhostHttp(workflowUrl)) {
    console.print(
      `[red]Error:[/red] Workflow '${safeWfId}' has an invalid install URL. ` +
        'Only HTTPS URLs are allowed, except HTTP for localhost/loopback.',
    );
    throw new CliExit(1);
  }

  const workflowDir = safeWorkflowIdDir(workflowsDir, workflowId);
  const workflowFile = join(workflowDir, 'workflow.yml');
  const existedBefore = isDir(workflowDir);

  let stagedFile: StagedWorkflowFile;
  try {
    stagedFile = stageWorkflowFile(workflowDir, { useProjectFileMode: !pathExists(workflowFile) });
  } catch (exc) {
    if (!isOsError(exc)) throw exc;
    console.print(
      `[red]Error:[/red] Failed to install workflow '${safeWfId}' from catalog: ` + `${escapeMarkup(osErrorText(exc))}`,
    );
    throw new CliExit(1);
  }

  const originalWorkflowUrl: string = workflowUrl;
  let downloadedArchiveFormat: string | null = null;
  let archiveContentType: string | null = null;
  let downloadedContent: Uint8Array = new Uint8Array(0);
  try {
    let extraHeaders: Record<string, string> | undefined;
    const resolvedWorkflowUrl = await resolveGithubReleaseAssetApiUrl(workflowUrl, httpDeps.openUrl, {
      timeout: 30,
      githubHosts: githubProviderHosts(),
      redirectValidator: rejectInsecureDownloadRedirect,
    });
    if (resolvedWorkflowUrl) {
      workflowUrl = resolvedWorkflowUrl;
      extraHeaders = { Accept: 'application/octet-stream' };
    }

    const response = await httpDeps.openUrl(workflowUrl as string, {
      timeout: 30,
      extraHeaders,
      redirectValidator: rejectInsecureDownloadRedirect,
    });
    const finalUrl = responseUrl(response, workflowUrl as string);
    if (!isHttpsOrLocalhostHttp(finalUrl)) {
      safeDiscardStagedWorkflowFile(stagedFile, workflowDir, existedBefore);
      console.print(
        `[red]Error:[/red] Workflow '${safeWfId}' redirected to non-HTTPS URL: ${escapeMarkup(finalUrl)}`,
      );
      throw new CliExit(1);
    }
    archiveContentType = responseHeader(response, 'Content-Type');
    downloadedArchiveFormat =
      (archiveFormatFromName(finalUrl) as string | null) ??
      (archiveFormatFromName(originalWorkflowUrl) as string | null) ??
      (archiveFormatFromContentType(archiveContentType) as string | null);
    if (downloadedArchiveFormat !== null) {
      downloadedContent = await readResponseLimited(response, {
        errorType: ValueError,
        label: `workflow '${workflowId}' archive download`,
      });
    } else if (workflowYamlIsDeclared(finalUrl, archiveContentType)) {
      downloadedContent = await readResponseWithinLimit(response);
    } else {
      downloadedContent = await readResponseLimited(response, {
        errorType: ValueError,
        label: `workflow '${workflowId}' download`,
      });
      downloadedArchiveFormat = sniffWorkflowArchiveFormat(downloadedContent);
      if (downloadedArchiveFormat === null) enforceWorkflowYamlSize(downloadedContent);
    }
    stagedFile.writeBytes(downloadedContent);
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    safeDiscardStagedWorkflowFile(stagedFile, workflowDir, existedBefore);
    console.print(
      `[red]Error:[/red] Failed to install workflow '${safeWfId}' from catalog: ${escapeMarkup(osErrorText(exc))}`,
    );
    throw new CliExit(1);
  }

  if (downloadedArchiveFormat !== null) {
    const extractDir = mkdtempSync(join(tmpdir(), 'speckit-workflow-archive-'));
    try {
      verifyArchiveSha256(downloadedContent, dget(info, 'sha256', null) as string | null, workflowId, ValueError);
      await safeExtractArchive(stagedFile.path, extractDir, {
        archiveFile: Buffer.from(downloadedContent),
        sourceName: originalWorkflowUrl,
        contentType: archiveContentType,
      });
      const packageRoot = workflowPackageRoot(extractDir);
      safeDiscardStagedWorkflowFile(stagedFile, workflowDir, existedBefore);
      await installWorkflowPackage(projectRoot, workflowsDir, packageRoot, workflowUrl as string, {
        expectedId: workflowId,
        expectedVersion,
        expectedInstalledVersion,
        catalogInfo: { ...info, url: workflowUrl },
      });
    } catch (exc) {
      if (exc instanceof CliExit) throw exc;
      if (isOsError(exc) || exc instanceof ValueError || (exc instanceof Error && exc.name === 'ValueError')) {
        safeDiscardStagedWorkflowFile(stagedFile, workflowDir, existedBefore);
        console.print(`[red]Error:[/red] Invalid workflow archive: ${escapeMarkup(osErrorText(exc))}`);
        throw new CliExit(1);
      }
      throw exc;
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
    return;
  }

  let definition: WorkflowDefinition;
  try {
    definition = WorkflowDefinition.fromString(new TextDecoder('utf-8', { fatal: true }).decode(downloadedContent));
  } catch (exc) {
    if (exc instanceof TypeError || exc instanceof ValueError || exc instanceof YAMLError) {
      safeDiscardStagedWorkflowFile(stagedFile, workflowDir, existedBefore);
      console.print(`[red]Error:[/red] Downloaded workflow is invalid: ${escapeMarkup(errorMessage(exc))}`);
      throw new CliExit(1);
    }
    throw exc;
  }

  const errors = validateWorkflow(definition);
  if (errors.length) {
    safeDiscardStagedWorkflowFile(stagedFile, workflowDir, existedBefore);
    console.print('[red]Error:[/red] Downloaded workflow validation failed:');
    for (const err of errors) console.print(`  • ${escapeMarkup(pyStr(err))}`);
    throw new CliExit(1);
  }

  if (pyTruthy(definition.id) && definition.id !== workflowId) {
    safeDiscardStagedWorkflowFile(stagedFile, workflowDir, existedBefore);
    console.print(
      `[red]Error:[/red] Workflow ID in YAML (${escapeMarkup(pyRepr(definition.id))}) ` +
        `does not match catalog key (${escapeMarkup(pyRepr(workflowId))}). ` +
        'The catalog entry may be misconfigured.',
    );
    throw new CliExit(1);
  }

  if (expectedVersion !== null && !versionsMatch(definition.version, expectedVersion)) {
    safeDiscardStagedWorkflowFile(stagedFile, workflowDir, existedBefore);
    console.print(
      `[red]Error:[/red] Downloaded workflow version (${escapeMarkup(pyStr(definition.version))}) ` +
        `does not match the catalog version (${escapeMarkup(expectedVersion)}). ` +
        'The catalog entry may be stale or misconfigured.',
    );
    throw new CliExit(1);
  }

  try {
    workflowInstallTransaction(projectRoot, () => {
      const transactionExistedBefore = existedBefore || pathExists(workflowFile);
      const transactionRegistry = openWorkflowRegistry(projectRoot);
      if (expectedInstalledVersion !== null) {
        const current = transactionRegistry.get(workflowId);
        if (
          !isDict(current) ||
          dget(current, 'source', null) !== 'catalog' ||
          !versionsMatch(dget(current, 'version', null), expectedInstalledVersion)
        ) {
          console.print(
            `[yellow]Warning:[/yellow] Workflow '${safeWfId}' ` +
              'changed during update; rerun the command to use its ' +
              'current source and version.',
          );
          throw new CliExit(1);
        }
      }
      let backupFile: string | null;
      try {
        backupFile = commitWorkflowFile(stagedFile, workflowFile, transactionExistedBefore);
      } catch (exc) {
        if (!isOsError(exc)) throw exc;
        safeDiscardStagedWorkflowFile(stagedFile, workflowDir, existedBefore);
        console.print(
          '[red]Error:[/red] Failed to install workflow ' +
            `'${safeWfId}' from catalog: ${escapeMarkup(osErrorText(exc))}`,
        );
        throw new CliExit(1);
      }

      const entry: Dict = {
        name: pyTruthy(definition.name) ? definition.name : dget(info as Dict, 'name', workflowId),
        version: pyTruthy(definition.version) ? definition.version : dget(info as Dict, 'version', '0.0.0'),
        description: pyTruthy(definition.description) ? definition.description : dget(info as Dict, 'description', ''),
        source: 'catalog',
        catalog_name: dget(info as Dict, '_catalog_name', ''),
        url: workflowUrl,
      };
      const existing = transactionRegistry.get(workflowId);
      if (isDict(existing) && !pyTruthy(dget(existing, 'enabled', true))) entry.enabled = false;
      try {
        transactionRegistry.add(workflowId, entry);
      } catch (exc) {
        if (!(isOsError(exc) || exc instanceof TypeError || exc instanceof ValueError)) throw exc;
        safeRollbackCommittedWorkflowFile(workflowFile, workflowDir, transactionExistedBefore, backupFile);
        console.print(
          '[red]Error:[/red] Failed to update workflow registry for ' +
            `'${escapeMarkup(workflowId)}': ${escapeMarkup(osErrorText(exc))}`,
        );
        throw new CliExit(1);
      }
      discardCommittedBackupFile(backupFile);
    });
  } catch (exc) {
    if (exc instanceof CliExit) {
      safeDiscardStagedWorkflowFile(stagedFile, workflowDir, existedBefore);
      throw exc;
    }
    if (isOsError(exc)) {
      safeDiscardStagedWorkflowFile(stagedFile, workflowDir, existedBefore);
      console.print(
        `[red]Error:[/red] Failed to lock workflow install '${safeWfId}': ${escapeMarkup(osErrorText(exc))}`,
      );
      throw new CliExit(1);
    }
    throw exc;
  }
  console.print(
    `[green]✓[/green] Workflow '${escapeMarkup(pyStr(dget(info, 'name', workflowId)))}' ` + 'installed from catalog',
  );
}

/** Update enabled state from a fresh registry snapshot while locked. */
export function setWorkflowEnabled(workflowId: string, enabled: boolean): void {
  const projectRoot = requireSpecifyProject();
  const safeId = escapeMarkup(workflowId);
  try {
    workflowInstallTransaction(projectRoot, () => {
      const registry = openWorkflowRegistry(projectRoot);
      const metadata = registry.get(workflowId);
      if (metadata === null || metadata === undefined) {
        console.print(`[red]Error:[/red] Workflow '${safeId}' is not installed`);
        throw new CliExit(1);
      }
      if (!isDict(metadata)) {
        console.print(`[red]Error:[/red] Registry entry for '${safeId}' is corrupted`);
        throw new CliExit(1);
      }
      const current = pyTruthy(dget(metadata, 'enabled', true));
      const state = enabled ? 'enabled' : 'disabled';
      if (current === enabled) {
        console.print(`[yellow]Workflow '${safeId}' is already ${state}[/yellow]`);
        throw new CliExit(0);
      }
      try {
        registry.add(workflowId, { ...metadata, enabled });
      } catch (exc) {
        if (!isOsError(exc)) throw exc;
        console.print(
          `[red]Error:[/red] Failed to update workflow registry for '${safeId}': ${escapeMarkup(osErrorText(exc))}`,
        );
        throw new CliExit(1);
      }
    });
  } catch (exc) {
    if (isOsError(exc)) {
      console.print(
        `[red]Error:[/red] Failed to lock workflow registry for '${safeId}': ${escapeMarkup(osErrorText(exc))}`,
      );
      throw new CliExit(1);
    }
    throw exc;
  }
  const state = enabled ? 'enabled' : 'disabled';
  console.print(`[green]✓[/green] Workflow '${safeId}' ${state}`);
}

// ============================================================================
// Command handlers
// ============================================================================

const STATUS_COLORS: Record<string, string> = {
  completed: 'green',
  paused: 'yellow',
  failed: 'red',
  aborted: 'red',
};

function expandUser(p: string): string {
  if (p === '~') return process.env.HOME ?? p;
  if (p.startsWith('~/')) return join(process.env.HOME ?? '~', p.slice(2));
  return p;
}

function stepStartPrinter(sid: string, label: string): void {
  console.print(`  ▸ \\[${escapeMarkup(pyStr(sid))}] ${escapeMarkup(pyStr(label))} …`);
}

/** ``specify workflow run``: run a workflow from an installed ID or local YAML path. */
export async function workflowRun(source: string, inputValues: string[] | null, jsonOutput = false): Promise<number> {
  const sourcePath = expandUser(source);
  const lower = sourcePath.toLowerCase();
  const isFileSource = (lower.endsWith('.yml') || lower.endsWith('.yaml')) && isFile(sourcePath);

  let projectRoot: string;
  if (isFileSource) {
    const override = resolveInitDirOverride();
    projectRoot = override !== null && override !== undefined ? override : process.cwd();
    rejectUnsafeWorkflowStorage(projectRoot);
  } else {
    projectRoot = requireSpecifyProject();
  }

  await loadCustomSteps(projectRoot);
  const engine = new WorkflowEngine(projectRoot);
  if (!jsonOutput) engine.onStepStart = stepStartPrinter;

  const err = errorConsole(jsonOutput);

  let registeredId: string | null = null;
  let registryRoot = projectRoot;
  if (!isFileSource) {
    if (RESERVED_WORKFLOW_IDS.has(source) || !WORKFLOW_ID_PATTERN.test(source)) {
      err.print(`[red]Error:[/red] Invalid workflow ID: ${escapeMarkup(pyRepr(source))}`);
      throw new CliExit(1);
    }
    registeredId = source;
  } else {
    const [ownerRoot, ownerId] = resolveInstalledWorkflowOwnership(sourcePath, err);
    if (ownerId !== null && ownerRoot !== null) {
      registryRoot = ownerRoot;
      registeredId = ownerId;
    }
  }

  if (registeredId !== null) requireEnabledWorkflow(registryRoot, registeredId, err);

  let definition: WorkflowDefinition;
  try {
    definition = engine.loadWorkflow(isFileSource ? sourcePath : source);
  } catch (exc) {
    if (exc instanceof FileNotFoundError || (exc as NodeJS.ErrnoException)?.code === 'ENOENT') {
      err.print(`[red]Error:[/red] Workflow not found: ${source}`);
      throw new CliExit(1);
    }
    if (exc instanceof ValueError || (exc instanceof Error && exc.name === 'ValueError')) {
      err.print(`[red]Error:[/red] Invalid workflow: ${escapeMarkup(exc.message)}`);
      throw new CliExit(1);
    }
    throw exc;
  }

  const errors = engine.validate(definition);
  if (errors.length) {
    err.print('[red]Workflow validation failed:[/red]');
    for (const verr of errors) err.print(`  • ${escapeMarkup(pyStr(verr))}`);
    throw new CliExit(1);
  }

  const inputs = parseInputValues(inputValues, { jsonOutput });

  if (!jsonOutput) {
    console.print(`\n[bold cyan]Running workflow:[/bold cyan] ${pyStr(definition.name)} (${pyStr(definition.id)})`);
    console.print(`[dim]Version: ${pyStr(definition.version)}[/dim]\n`);
  }

  let state: RunState;
  try {
    state = await stdoutToStderrWhen(jsonOutput, () =>
      engine.execute(definition, inputs, {
        installedWorkflowId: registeredId,
        installedRegistryRoot:
          registeredId && !sameExistingPath(registryRoot, projectRoot) ? realpath(registryRoot) : null,
      }),
    );
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    if (exc instanceof ValueError || (exc instanceof Error && exc.name === 'ValueError')) {
      err.print(`[red]Error:[/red] ${escapeMarkup(exc.message)}`);
      throw new CliExit(1);
    }
    err.print(`[red]Workflow failed:[/red] ${escapeMarkup(errorMessage(exc))}`);
    throw new CliExit(1);
  }

  if (jsonOutput) {
    emitWorkflowJson(workflowRunPayload(state));
    return runOutcomeExitCode(state.status);
  }

  const color = STATUS_COLORS[state.status] ?? 'white';
  console.print(`\n[${color}]Status: ${state.status}[/${color}]`);
  console.print(`[dim]Run ID: ${state.runId}[/dim]`);

  const errMsg = failedStepError(state);
  if (errMsg) console.print(`[red]Error:[/red] ${escapeMarkup(errMsg)}`);

  if (state.status === 'paused') {
    console.print(`\nResume with: [cyan]specify workflow resume ${state.runId}[/cyan]`);
  }
  return runOutcomeExitCode(state.status);
}

/** ``specify workflow resume``: resume a paused or failed workflow run. */
export async function workflowResume(runId: string, inputValues: string[] | null, jsonOutput = false): Promise<number> {
  const projectRoot = requireSpecifyProject();
  await loadCustomSteps(projectRoot);
  const engine = new WorkflowEngine(projectRoot);
  if (!jsonOutput) engine.onStepStart = stepStartPrinter;

  const inputs = parseInputValues(inputValues, { jsonOutput });
  const err = errorConsole(jsonOutput);

  let preState: RunState;
  try {
    preState = RunState.load(runId, projectRoot);
  } catch (exc) {
    if (exc instanceof FileNotFoundError) {
      err.print(`[red]Error:[/red] Run not found: ${runId}`);
      throw new CliExit(1);
    }
    if (exc instanceof ValueError) {
      err.print(`[red]Error:[/red] ${escapeMarkup(exc.message)}`);
      throw new CliExit(1);
    }
    if (isOsError(exc)) {
      err.print(`[red]Resume failed:[/red] ${escapeMarkup(osErrorText(exc))}`);
      throw new CliExit(1);
    }
    throw exc;
  }

  if (preState.installedWorkflowId !== null) {
    let ownerRoot: string;
    try {
      ownerRoot = resolveRunOwnerRoot(preState.installedRegistryRoot, projectRoot);
    } catch (exc) {
      if (exc instanceof ValueError) {
        err.print(`[red]Error:[/red] ${escapeMarkup(exc.message)}`);
        throw new CliExit(1);
      }
      throw exc;
    }
    requireEnabledWorkflow(ownerRoot, preState.installedWorkflowId, err);
  } else if (!preState.installedOriginTracked) {
    if (requireEnabledWorkflow(projectRoot, preState.workflowId, err)) {
      preState.installedWorkflowId = preState.workflowId;
    }
    preState.installedOriginTracked = true;
    try {
      preState.save();
    } catch (exc) {
      if (!isOsError(exc)) throw exc;
      err.print(`[red]Resume failed:[/red] ${escapeMarkup(osErrorText(exc))}`);
      throw new CliExit(1);
    }
  }

  let state: RunState;
  try {
    state = await stdoutToStderrWhen(jsonOutput, () =>
      engine.resume(runId, Object.keys(inputs).length ? inputs : null),
    );
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    if (exc instanceof FileNotFoundError) {
      err.print(`[red]Error:[/red] Run not found: ${runId}`);
      throw new CliExit(1);
    }
    if (exc instanceof ValueError || (exc instanceof Error && exc.name === 'ValueError')) {
      err.print(`[red]Error:[/red] ${escapeMarkup(exc.message)}`);
      throw new CliExit(1);
    }
    err.print(`[red]Resume failed:[/red] ${escapeMarkup(errorMessage(exc))}`);
    throw new CliExit(1);
  }

  if (jsonOutput) {
    emitWorkflowJson(workflowRunPayload(state));
    return runOutcomeExitCode(state.status);
  }

  const color = STATUS_COLORS[state.status] ?? 'white';
  console.print(`\n[${color}]Status: ${state.status}[/${color}]`);
  const errMsg = failedStepError(state);
  if (errMsg) console.print(`[red]Error:[/red] ${escapeMarkup(errMsg)}`);
  return runOutcomeExitCode(state.status);
}

/** ``specify workflow status``: show workflow run status. */
export function workflowStatus(runId: string | null, jsonOutput = false): number {
  const projectRoot = requireSpecifyProject();
  const engine = new WorkflowEngine(projectRoot);

  if (runId) {
    const err = errorConsole(jsonOutput);
    let state: RunState;
    try {
      state = RunState.load(runId, projectRoot);
    } catch (exc) {
      if (exc instanceof FileNotFoundError) {
        err.print(`[red]Error:[/red] Run not found: ${runId}`);
        throw new CliExit(1);
      }
      if (exc instanceof ValueError) {
        err.print(`[red]Error:[/red] ${escapeMarkup(exc.message)}`);
        throw new CliExit(1);
      }
      if (isOsError(exc)) {
        err.print(`[red]Error:[/red] ${escapeMarkup(osErrorText(exc))}`);
        throw new CliExit(1);
      }
      throw exc;
    }

    if (jsonOutput) {
      const steps: Dict = {};
      for (const [sid, sd] of Object.entries(state.stepResults)) steps[sid] = dget(sd, 'status', 'unknown');
      emitWorkflowJson({
        ...workflowRunPayload(state),
        created_at: state.createdAt,
        updated_at: state.updatedAt,
        steps,
      });
      return 0;
    }

    const colors: Record<string, string> = { ...STATUS_COLORS, running: 'blue', created: 'dim' };
    const color = colors[state.status] ?? 'white';
    console.print(`\n[bold cyan]Workflow Run: ${state.runId}[/bold cyan]`);
    console.print(`  Workflow: ${state.workflowId}`);
    console.print(`  Status:   [${color}]${state.status}[/${color}]`);
    console.print(`  Created:  ${state.createdAt}`);
    console.print(`  Updated:  ${state.updatedAt}`);
    if (state.currentStepId) console.print(`  Current:  ${state.currentStepId}`);

    const errMsg = failedStepError(state);
    if (errMsg) console.print(`  [red]Error:    ${escapeMarkup(errMsg)}[/red]`);

    const entries = Object.entries(state.stepResults);
    if (entries.length) {
      console.print(`\n  [bold]Steps (${entries.length}):[/bold]`);
      for (const [stepId, stepData] of entries) {
        const s = pyStr(dget(stepData, 'status', 'unknown'));
        const sc = ({ completed: 'green', failed: 'red', paused: 'yellow' } as Record<string, string>)[s] ?? 'white';
        console.print(`    [${sc}]●[/${sc}] ${stepId}: ${s}`);
      }
    }
    return 0;
  }

  const runs = engine.listRuns();
  if (jsonOutput) {
    emitWorkflowJson({
      runs: runs.map((r) => ({
        run_id: r.run_id,
        workflow_id: dget(r, 'workflow_id', null),
        status: dget(r, 'status', 'unknown'),
        updated_at: dget(r, 'updated_at', null),
      })),
    });
    return 0;
  }

  if (!runs.length) {
    console.print('[yellow]No workflow runs found.[/yellow]');
    return 0;
  }

  console.print('\n[bold cyan]Workflow Runs:[/bold cyan]\n');
  for (const runData of runs) {
    const s = pyStr(dget(runData, 'status', 'unknown'));
    const sc =
      ({ completed: 'green', failed: 'red', paused: 'yellow', running: 'blue' } as Record<string, string>)[s] ?? 'white';
    console.print(
      `  [${sc}]●[/${sc}] ${pyStr(runData.run_id)}  ` +
        `${pyStr(dget(runData, 'workflow_id', '?'))}  ` +
        `[${sc}]${s}[/${sc}]  ` +
        `[dim]${pyStr(dget(runData, 'updated_at', '?'))}[/dim]`,
    );
  }
  return 0;
}

/** ``specify workflow list``: list installed workflows. */
export function workflowList(): number {
  const projectRoot = requireSpecifyProject();
  const registry = openWorkflowRegistry(projectRoot);
  const installed = registry.list();
  const entries = Object.entries(installed);

  if (!entries.length) {
    console.print('[yellow]No workflows installed.[/yellow]');
    console.print('\nInstall a workflow with:');
    console.print('  [cyan]specify workflow add <workflow-id>[/cyan]');
    return 0;
  }

  console.print('\n[bold cyan]Installed Workflows:[/bold cyan]\n');
  for (const [wfId, wfData] of entries) {
    const safeId = escapeMarkup(wfId);
    if (!isDict(wfData)) {
      console.print(`  [yellow]Warning:[/yellow] Skipping corrupted registry entry '${safeId}'.\n`);
      continue;
    }
    const marker = pyTruthy(dget(wfData, 'enabled', true)) ? '' : ' [red]\\[disabled][/red]';
    const name = escapeMarkup(pyStr(dget(wfData, 'name', wfId)));
    const version = escapeMarkup(pyStr(dget(wfData, 'version', '?')));
    console.print(`  [bold]${name}[/bold] (${safeId}) v${version}${marker}`);
    const desc = dget(wfData, 'description', '');
    if (pyTruthy(desc)) console.print(`    ${escapeMarkup(pyStr(desc))}`);
    console.print();
  }
  return 0;
}

/** Stage a workflow directory and persist removal while locked. */
function removeWorkflowLocked(projectRoot: string, workflowsDir: string, workflowId: string): string | null {
  const registry = openWorkflowRegistry(projectRoot);
  const safeId = escapeMarkup(workflowId);
  if (!registry.isInstalled(workflowId)) {
    console.print(`[red]Error:[/red] Workflow '${safeId}' is not installed`);
    throw new CliExit(1);
  }

  const unresolvedDir = join(workflowsDir, workflowId);
  if (isSymlink(unresolvedDir)) {
    console.print(`[red]Error:[/red] Refusing to remove symlinked .specify/workflows/${safeId}`);
    throw new CliExit(1);
  }

  const workflowDir = resolveLoose(unresolvedDir);
  const resolvedWorkflows = resolveLoose(workflowsDir);
  if (!isRelativeTo(workflowDir, resolvedWorkflows)) {
    console.print(`[red]Error:[/red] Invalid workflow ID: ${escapeMarkup(pyRepr(workflowId))}`);
    throw new CliExit(1);
  }
  const relParts = relative(resolvedWorkflows, workflowDir).split(sep).filter(Boolean);
  if (relParts.length !== 1 || relParts[0] !== workflowId) {
    console.print(`[red]Error:[/red] Invalid workflow ID: ${escapeMarkup(pyRepr(workflowId))}`);
    throw new CliExit(1);
  }

  if (pathExists(workflowDir) && !isDir(workflowDir)) {
    console.print(`[red]Error:[/red] .specify/workflows/${safeId} exists but is not a directory`);
    throw new CliExit(1);
  }

  let stagedDir: string | null = null;
  if (pathExists(workflowDir)) {
    try {
      const reserved = mkdtempSync(join(workflowsDir, `.${workflowId}.removing-`));
      rmdirSync(reserved);
      renameSync(workflowDir, reserved);
      stagedDir = reserved;
    } catch (exc) {
      if (!isOsError(exc)) throw exc;
      console.print(
        '[red]Error:[/red] Failed to stage workflow directory ' +
          `${escapeMarkup(workflowDir)} for removal: ${escapeMarkup(osErrorText(exc))}`,
      );
      throw new CliExit(1);
    }
  }

  try {
    registry.remove(workflowId);
  } catch (exc) {
    if (!(isOsError(exc) || exc instanceof TypeError || exc instanceof ValueError)) throw exc;
    if (stagedDir !== null) {
      try {
        renameSync(stagedDir, workflowDir);
      } catch (restoreExc) {
        console.print(
          '[yellow]Warning:[/yellow] Failed to restore workflow ' +
            'directory after registry update failure; it remains ' +
            `staged at ${escapeMarkup(stagedDir)}: ${escapeMarkup(osErrorText(restoreExc))}`,
        );
      }
    }
    console.print(
      `[red]Error:[/red] Failed to update workflow registry for '${safeId}': ${escapeMarkup(osErrorText(exc))}`,
    );
    throw new CliExit(1);
  }
  return stagedDir;
}

/** ``specify workflow remove``: uninstall a workflow. */
export function workflowRemove(workflowId: string): number {
  const projectRoot = requireSpecifyProject();
  const workflowsDir = join(projectRoot, '.specify', 'workflows');
  validateWorkflowIdOrExit(workflowId);
  const safeId = escapeMarkup(workflowId);

  let stagedDir: string | null;
  try {
    stagedDir = workflowInstallTransaction(projectRoot, () => removeWorkflowLocked(projectRoot, workflowsDir, workflowId));
  } catch (exc) {
    if (!isOsError(exc)) throw exc;
    console.print(`[red]Error:[/red] Failed to lock workflow removal '${safeId}': ${escapeMarkup(osErrorText(exc))}`);
    throw new CliExit(1);
  }

  console.print(`[green]✓[/green] Workflow '${workflowId}' removed`);

  if (stagedDir !== null) {
    try {
      rmSync(stagedDir, { recursive: true });
    } catch (exc) {
      console.print(
        `[yellow]Warning:[/yellow] Workflow '${safeId}' was removed, but its ` +
          `staged directory could not be deleted: ${escapeMarkup(osErrorText(exc))}. ` +
          `Remove it manually: ${escapeMarkup(stagedDir)}`,
      );
    }
  }
  return 0;
}

/** ``specify workflow search``: search workflow catalogs. */
export async function workflowSearch(query: string | null, tag: string | null, author: string | null): Promise<number> {
  const projectRoot = requireSpecifyProject();
  const catalog = new WorkflowCatalog(projectRoot);

  let results: Dict[];
  try {
    results = await catalog.search({ query, tag, author });
  } catch (exc) {
    if (exc instanceof WorkflowCatalogError) {
      console.print(`[red]Error:[/red] ${escapeMarkup(exc.message)}`);
      throw new CliExit(1);
    }
    throw exc;
  }

  if (!results.length) {
    console.print('[yellow]No workflows found.[/yellow]');
    return 0;
  }

  console.print(`\n[bold cyan]Workflows (${results.length}):[/bold cyan]\n`);
  for (const wf of results) {
    const name = escapeMarkup(pyStr(dget(wf, 'name', dget(wf, 'id', '?'))));
    const wfId = escapeMarkup(pyStr(dget(wf, 'id', '?')));
    const version = escapeMarkup(pyStr(dget(wf, 'version', '?')));
    console.print(`  [bold]${name}[/bold] (${wfId}) v${version}`);
    const desc = dget(wf, 'description', '');
    if (pyTruthy(desc)) console.print(`    ${escapeMarkup(pyStr(desc))}`);
    const tags = dget(wf, 'tags', []);
    if (Array.isArray(tags) && tags.length) {
      console.print(`    [dim]Tags: ${escapeMarkup(tags.map((t) => pyStr(t)).join(', '))}[/dim]`);
    }
    console.print();
  }
  return 0;
}

/** ``specify workflow info``: show workflow details and step graph. */
export async function workflowInfo(workflowId: string): Promise<number> {
  const projectRoot = requireSpecifyProject();
  const registry = openWorkflowRegistry(projectRoot);
  const installed = registry.get(workflowId);
  const engine = new WorkflowEngine(projectRoot);

  let definition: WorkflowDefinition | null = null;
  try {
    definition = engine.loadWorkflow(workflowId);
  } catch (exc) {
    if (exc instanceof FileNotFoundError || (exc as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // Fall back to catalog lookup below.
    } else if (exc instanceof ValueError || (exc instanceof Error && exc.name === 'ValueError')) {
      console.print(`[red]Error:[/red] Invalid workflow: ${escapeMarkup(exc.message)}`);
      throw new CliExit(1);
    } else {
      throw exc;
    }
  }

  if (definition) {
    console.print(
      `\n[bold cyan]${escapeMarkup(pyStr(definition.name))}[/bold cyan] (${escapeMarkup(pyStr(definition.id))})`,
    );
    console.print(`  Version:     ${escapeMarkup(pyStr(definition.version))}`);
    if (pyTruthy(definition.author)) console.print(`  Author:      ${escapeMarkup(pyStr(definition.author))}`);
    if (pyTruthy(definition.description)) {
      console.print(`  Description: ${escapeMarkup(pyStr(definition.description))}`);
    }
    if (pyTruthy(definition.defaultIntegration)) {
      console.print(`  Integration: ${escapeMarkup(pyStr(definition.defaultIntegration))}`);
    }
    if (pyTruthy(installed)) console.print('  [green]Installed[/green]');

    if (pyTruthy(definition.inputs) && isDict(definition.inputs)) {
      console.print('\n  [bold]Inputs:[/bold]');
      for (const [name, inp] of Object.entries(definition.inputs)) {
        if (isDict(inp)) {
          const req = pyTruthy(dget(inp, 'required', null)) ? 'required' : 'optional';
          console.print(`    ${escapeMarkup(pyStr(name))} (${escapeMarkup(pyStr(dget(inp, 'type', 'string')))}) — ${req}`);
        }
      }
    }

    if (Array.isArray(definition.steps) && definition.steps.length) {
      console.print(`\n  [bold]Steps (${definition.steps.length}):[/bold]`);
      for (const step of definition.steps as Dict[]) {
        const stype = isDict(step) ? dget(step, 'type', 'command') : 'command';
        const sid = isDict(step) ? dget(step, 'id', '?') : '?';
        console.print(`    → ${escapeMarkup(pyStr(sid))} \\[${escapeMarkup(pyStr(stype))}]`);
      }
    }
    return 0;
  }

  const catalog = new WorkflowCatalog(projectRoot);
  let info: Dict | null;
  try {
    info = await catalog.getWorkflowInfo(workflowId);
  } catch (exc) {
    if (!(exc instanceof WorkflowCatalogError)) throw exc;
    info = null;
  }

  if (info && Object.keys(info).length) {
    console.print(
      `\n[bold cyan]${escapeMarkup(pyStr(dget(info, 'name', workflowId)))}[/bold cyan] (${escapeMarkup(workflowId)})`,
    );
    console.print(`  Version:     ${escapeMarkup(pyStr(dget(info, 'version', '?')))}`);
    if (pyTruthy(dget(info, 'description', null))) {
      console.print(`  Description: ${escapeMarkup(pyStr(info.description))}`);
    }
    const infoTags = dget(info, 'tags', []);
    if (Array.isArray(infoTags) && infoTags.length) {
      console.print(`  Tags:        ${escapeMarkup(infoTags.map((t) => pyStr(t)).join(', '))}`);
    }
    console.print('  [yellow]Not installed[/yellow]');
    return 0;
  }
  console.print(`[red]Error:[/red] Workflow '${escapeMarkup(workflowId)}' not found`);
  throw new CliExit(1);
}

/** ``specify workflow update``: update installed workflow(s) to the latest catalog version. */
export async function workflowUpdate(workflowId: string | null): Promise<number> {
  const projectRoot = requireSpecifyProject();
  const registry = openWorkflowRegistry(projectRoot);
  const workflowsDir = join(projectRoot, '.specify', 'workflows');
  rejectUnsafeDir(join(projectRoot, '.specify'), '.specify');
  rejectUnsafeDir(workflowsDir, '.specify/workflows');

  const installed = registry.list() as Dict;
  let targets: string[];
  if (workflowId) {
    if (!registry.isInstalled(workflowId)) {
      console.print(`[red]Error:[/red] Workflow '${escapeMarkup(workflowId)}' is not installed`);
      throw new CliExit(1);
    }
    targets = [workflowId];
  } else {
    targets = Object.keys(installed);
  }

  if (!targets.length) {
    console.print('[yellow]No workflows installed[/yellow]');
    return 0;
  }

  const catalog = new WorkflowCatalog(projectRoot);
  console.print('🔄 Checking for updates...\n');

  const updatesAvailable: Array<{ id: string; installed: string; available: string }> = [];
  let checked = 0;
  for (const wfId of targets) {
    const safeId = escapeMarkup(pyStr(wfId));
    const metadata = installed[wfId];
    if (!isDict(metadata)) {
      console.print(`⚠  ${safeId}: Registry entry is corrupted (skipping)`);
      continue;
    }
    if (dget(metadata, 'source', null) !== 'catalog') {
      console.print(`⚠  ${safeId}: Not installed from a catalog — re-add to update (skipping)`);
      continue;
    }
    let installedVersion: Version;
    try {
      installedVersion = new Version(pyStr(dget(metadata, 'version', null)));
    } catch (exc) {
      if (!(exc instanceof InvalidVersion)) throw exc;
      console.print(
        `⚠  ${safeId}: Invalid installed version '${escapeMarkup(pyStr(dget(metadata, 'version', null)))}' in registry (skipping)`,
      );
      continue;
    }
    let info: Dict | null;
    try {
      info = await catalog.getWorkflowInfo(wfId);
    } catch (exc) {
      if (exc instanceof WorkflowCatalogError) {
        console.print(`[red]Error:[/red] ${escapeMarkup(exc.message)}`);
        throw new CliExit(1);
      }
      throw exc;
    }
    if (!info || !Object.keys(info).length) {
      console.print(`⚠  ${safeId}: Not found in catalog (skipping)`);
      continue;
    }
    if (!pyTruthy(dget(info, '_install_allowed', true))) {
      console.print(
        `⚠  ${safeId}: Updates not allowed from '${escapeMarkup(pyStr(dget(info, '_catalog_name', 'catalog')))}' (skipping)`,
      );
      continue;
    }
    let catalogVersion: Version;
    try {
      catalogVersion = new Version(pyStr(dget(info, 'version', null)));
    } catch (exc) {
      if (!(exc instanceof InvalidVersion)) throw exc;
      console.print(
        `⚠  ${safeId}: Invalid catalog version '${escapeMarkup(pyStr(dget(info, 'version', null)))}' (skipping)`,
      );
      continue;
    }
    checked += 1;
    if (catalogVersion.gt(installedVersion)) {
      updatesAvailable.push({ id: wfId, installed: installedVersion.toString(), available: catalogVersion.toString() });
    } else {
      console.print(`✓ ${safeId}: Up to date (v${installedVersion.toString()})`);
    }
  }

  if (!updatesAvailable.length) {
    if (!checked) console.print('\n[yellow]No workflows were eligible for update[/yellow]');
    else if (checked === targets.length) console.print('\n[green]All workflows are up to date![/green]');
    else {
      console.print(
        '\n[green]All checked workflows are up to date[/green] ' + `[yellow](${targets.length - checked} skipped)[/yellow]`,
      );
    }
    return 0;
  }

  console.print('\n[bold]Updates available:[/bold]\n');
  for (const update of updatesAvailable) {
    console.print(`  • ${escapeMarkup(update.id)}: ${update.installed} → ${update.available}`);
  }
  console.print();
  if (!(await confirm('Update these workflows?'))) {
    console.print('Cancelled');
    return 0;
  }

  console.print();
  const failed: string[] = [];
  for (const update of updatesAvailable) {
    try {
      await installWorkflowFromCatalog(projectRoot, workflowsDir, update.id, update.available, update.installed);
    } catch (exc) {
      if (exc instanceof CliExit) {
        failed.push(update.id);
        continue;
      }
      if (isOsError(exc)) {
        console.print(
          `[red]Error:[/red] Filesystem error updating '${escapeMarkup(update.id)}': ${escapeMarkup(osErrorText(exc))}`,
        );
        failed.push(update.id);
        continue;
      }
      throw exc;
    }
  }

  if (failed.length) {
    console.print(`\n[red]Failed to update:[/red] ${failed.map((f) => escapeMarkup(f)).join(', ')}`);
    throw new CliExit(1);
  }
  return 0;
}

/** ``specify workflow enable``. */
export function workflowEnable(workflowId: string): number {
  setWorkflowEnabled(workflowId, true);
  return 0;
}

/** ``specify workflow disable``. */
export function workflowDisable(workflowId: string): number {
  setWorkflowEnabled(workflowId, false);
  console.print(`To re-enable: specify workflow enable ${escapeMarkup(workflowId)}`);
  return 0;
}

/** ``specify workflow resolve``: show layer attribution for a resolved workflow. */
export function workflowResolveCmd(workflowId: string): number {
  const projectRoot = requireSpecifyProject();
  if (workflowResolve(projectRoot, workflowId) === null) throw new CliExit(1);
  return 0;
}

// ============================================================================
// CLI dispatcher
// ============================================================================

const JSON_OPT = (help: string) => ({ name: 'json', flags: ['--json'], type: 'boolean' as const, help });

const WORKFLOW_GROUP: GroupSpec = {
  name: 'workflow',
  help: 'Manage and run automation workflows',
  commands: [
    defineCommand(
      {
        name: 'run',
        help: 'Run a workflow from an installed ID or local YAML path.',
        arguments: [{ name: 'source', required: true, help: 'Workflow ID or YAML file path' }],
        options: [
          { name: 'input', flags: ['--input', '-i'], multiple: true, help: 'Input values as key=value pairs' },
          JSON_OPT('Emit the run outcome as a single JSON object instead of formatted text.'),
        ],
      },
      (p) => workflowRun(p.args.source as string, (p.options.input as string[]) ?? [], Boolean(p.options.json)),
    ),
    defineCommand(
      {
        name: 'resume',
        help: 'Resume a paused or failed workflow run.',
        arguments: [{ name: 'run_id', required: true, help: 'Run ID to resume' }],
        options: [
          { name: 'input', flags: ['--input', '-i'], multiple: true, help: 'Updated input values as key=value pairs' },
          JSON_OPT('Emit the resume outcome as a single JSON object instead of formatted text.'),
        ],
      },
      (p) => workflowResume(p.args.run_id as string, (p.options.input as string[]) ?? [], Boolean(p.options.json)),
    ),
    defineCommand(
      {
        name: 'status',
        help: 'Show workflow run status.',
        arguments: [{ name: 'run_id', required: false, help: 'Run ID to inspect (shows all if omitted)' }],
        options: [JSON_OPT('Emit run status as a single JSON object instead of formatted text.')],
      },
      (p) => workflowStatus((p.args.run_id as string | undefined) ?? null, Boolean(p.options.json)),
    ),
    defineCommand({ name: 'list', help: 'List installed workflows.' }, () => workflowList()),
    defineCommand(
      {
        name: 'add',
        help: 'Install a workflow from catalog, URL, or local path.',
        arguments: [{ name: 'source', required: true, help: 'Workflow ID, URL, or local path' }],
        options: [
          { name: 'dev', flags: ['--dev'], type: 'boolean', help: 'Install from a local workflow YAML file or directory' },
          { name: 'from', flags: ['--from'], help: 'Install from a custom URL' },
        ],
      },
      async (p) => {
        await workflowAdd({
          source: p.args.source as string,
          dev: Boolean(p.options.dev),
          fromUrl: (p.options.from as string | undefined) ?? null,
        });
      },
    ),
    defineCommand(
      {
        name: 'remove',
        help: 'Uninstall a workflow.',
        arguments: [{ name: 'workflow_id', required: true, help: 'Workflow ID to uninstall' }],
      },
      (p) => workflowRemove(p.args.workflow_id as string),
    ),
    defineCommand(
      {
        name: 'update',
        help: 'Update installed workflow(s) to the latest catalog version.',
        arguments: [{ name: 'workflow_id', required: false, help: 'Workflow ID to update (default: all)' }],
      },
      (p) => workflowUpdate((p.args.workflow_id as string | undefined) ?? null),
    ),
    defineCommand(
      {
        name: 'enable',
        help: 'Enable a disabled workflow.',
        arguments: [{ name: 'workflow_id', required: true, help: 'Workflow ID to enable' }],
      },
      (p) => workflowEnable(p.args.workflow_id as string),
    ),
    defineCommand(
      {
        name: 'disable',
        help: 'Disable a workflow without removing it.',
        arguments: [{ name: 'workflow_id', required: true, help: 'Workflow ID to disable' }],
      },
      (p) => workflowDisable(p.args.workflow_id as string),
    ),
    defineCommand(
      {
        name: 'search',
        help: 'Search workflow catalogs.',
        arguments: [{ name: 'query', required: false, help: 'Search query' }],
        options: [
          { name: 'tag', flags: ['--tag'], help: 'Filter by tag' },
          { name: 'author', flags: ['--author'], help: 'Filter by author' },
        ],
      },
      (p) =>
        workflowSearch(
          (p.args.query as string | undefined) ?? null,
          (p.options.tag as string | undefined) ?? null,
          (p.options.author as string | undefined) ?? null,
        ),
    ),
    defineCommand(
      {
        name: 'info',
        help: 'Show workflow details and step graph.',
        arguments: [{ name: 'workflow_id', required: true, help: 'Workflow ID' }],
      },
      (p) => workflowInfo(p.args.workflow_id as string),
    ),
    defineCommand(
      {
        name: 'resolve',
        help: 'Show layer attribution for a resolved workflow.',
        arguments: [{ name: 'workflow_id', required: true, help: 'Workflow ID to resolve' }],
      },
      (p) => workflowResolveCmd(p.args.workflow_id as string),
    ),
    { name: 'catalog', help: 'Manage workflow catalogs', run: (args: string[]) => runWorkflowCatalogCommand(args) },
    { name: 'step', help: 'Manage workflow step types', run: (args: string[]) => runWorkflowStepCommand(args) },
    { name: 'overlay', help: 'Manage workflow overlays', run: (args: string[]) => runWorkflowOverlayCommand(args) },
  ],
};

/**
 * Run ``specify workflow <args>``; returns the exit code.
 *
 * @param args argv after ``workflow`` (e.g. ``['run', 'speckit', '-i', 'spec=x']``).
 */
export async function runWorkflowCommand(args: string[]): Promise<number> {
  try {
    return await dispatchGroup(WORKFLOW_GROUP, args, 'specify workflow');
  } catch (exc) {
    if (exc instanceof CliExit) return exc.code;
    throw exc;
  }
}
