/**
 * @oakoliver/specify-cli - Custom Step Package Installer
 *
 * Domain install/validation for custom workflow step packages
 * (port of ``workflows/step/installer.py``).
 *
 * Owns the source-independent behaviour shared by every
 * ``specify workflow step add`` source mode (catalog, ``--dev`` local
 * directory and ``--from`` archive URL): step-id and base-directory
 * validation, package shape/symlink/limit validation, staging, atomic commit
 * and registry provenance. It is CLI-independent: it never prints and never
 * exits. Callers receive {@link StepInstallError} and decide how to surface it.
 *
 * ADAPTATION: upstream requires ``step.yml`` and ``__init__.py`` at the
 * package root. The TypeScript runtime loads a JavaScript entry point
 * (``index.mjs`` / ``index.js``, see ``CUSTOM_STEP_ENTRY_POINTS``) instead of
 * ``__init__.py``, so a package may provide either ``__init__.py`` or one of
 * those entry points next to ``step.yml``. Like upstream, the code is never
 * imported or executed during installation.
 *
 * @module workflows/step/installer
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  type Stats,
} from 'node:fs';
import { join, relative, sep } from 'node:path';

import { exclusiveProjectLock } from '../../shared-infra.js';
import { isEmptyYamlDocument, parseYaml } from '../../yaml.js';
import { BUILTIN_STEP_TYPES, CUSTOM_STEP_ENTRY_POINTS } from '../index.js';
import {
  isDir,
  isFile,
  isMapping,
  isRelativeTo,
  isSymlink,
  osErrorMessage,
  pathExists,
  pyRepr,
  pyTruthy,
  resolvePath,
} from '../overlay/py-compat.js';
import { StepRegistry, StepValidationError } from './catalog/domain.js';

type Dict = Record<string, unknown>;

// ============================================================================
// Limits & names
// ============================================================================

/**
 * Custom step packages contain executable code, metadata and optional helper
 * files. These ceilings apply uniformly to catalog, local and archive sources.
 */
export const MAX_STEP_PACKAGE_FILES = 512;
export const MAX_STEP_PACKAGE_BYTES = 50 * 1024 * 1024; // 50 MiB
export const MAX_STEP_PACKAGE_DEPTH = 32;
const COPY_CHUNK_BYTES = 64 * 1024;

/** Limits read at call time (tests may lower them, like the upstream monkeypatch points). */
export const stepPackageLimits: { maxFiles: number; maxBytes: number; maxDepth: number } = {
  maxFiles: MAX_STEP_PACKAGE_FILES,
  maxBytes: MAX_STEP_PACKAGE_BYTES,
  maxDepth: MAX_STEP_PACKAGE_DEPTH,
};

/**
 * Files/dirs never inspected, copied into, or counted as part of an installed
 * step package; excluded directories are pruned without being entered.
 * Mirrors ``bundles/packager.py`` ``EXCLUDE_NAMES``.
 */
export const EXCLUDE_NAMES: ReadonlySet<string> = new Set(['.git', '__pycache__', '.DS_Store']);

/**
 * Prefix for the private same-filesystem working directory created beneath
 * the steps base directory. It only ever holds a ``staged/`` child, so the
 * runtime loader never mistakes it for an installable package.
 */
export const WORK_DIR_PREFIX = '.speckit-step-install-';

export const RESERVED_STEP_IDS: ReadonlySet<string> = new Set(['.cache', 'step-registry.json']);

export const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export const WINDOWS_INVALID_CHARS: ReadonlySet<string> = new Set('<>:"|?*'.split(''));
const SOURCES: ReadonlySet<string> = new Set(['catalog', 'local', 'url']);

/** Python-style install source kinds recorded in the registry. */
export type StepInstallSource = 'catalog' | 'local' | 'url';

// ============================================================================
// Errors & transaction
// ============================================================================

/** User-facing step package install/validation failure. */
export class StepInstallError extends Error {
  /** Python ``BaseException.__notes__``. */
  notes: string[] = [];
  /** Python ``__cause__``. */
  override cause?: unknown;

  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message);
    this.name = 'StepInstallError';
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  /** Python ``add_note``. */
  addNote(note: string): void {
    this.notes.push(note);
  }
}

function errMsg(exc: unknown): string {
  return exc instanceof Error ? osErrorMessage(exc) : String(exc);
}

function isNodeOsError(exc: unknown): boolean {
  if (!(exc instanceof Error)) return false;
  const code = (exc as NodeJS.ErrnoException).code;
  return exc.name === 'OSError' || (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code));
}

/**
 * Serialize step directory and registry mutations (install and remove) on
 * ``.specify/.step-install.lock``. Only acquisition failures are reported as
 * lock errors; exceptions raised by ``fn`` propagate unchanged. The message
 * is operation-neutral because install and remove share this lock; callers
 * that add their own context should report ``exc.cause`` instead.
 */
export function stepInstallTransaction<T>(projectRoot: string, fn: () => T): T {
  let entered = false;
  try {
    return exclusiveProjectLock(projectRoot, '.step-install.lock', { context: 'step' }, () => {
      entered = true;
      return fn();
    });
  } catch (exc) {
    if (!entered && isNodeOsError(exc)) {
      throw new StepInstallError(`Failed to acquire the step lock: ${errMsg(exc)}`, { cause: exc });
    }
    throw exc;
  }
}

// ============================================================================
// Step id + base directory validation
// ============================================================================

/**
 * Validate that ``stepId`` is a single safe path component.
 *
 * Rejects empty strings, whitespace-only strings, leading/trailing
 * whitespace, path separators, ``.``/``..`` components, dotfile prefixes,
 * reserved names, Windows-invalid filename characters, trailing dots/spaces,
 * and Windows reserved device names.
 */
export function validateStepId(stepId: string): void {
  const stem = stepId ? (stepId.split('.')[0] as string).toLowerCase() : '';
  const chars = [...stepId];
  if (
    !stepId ||
    !stepId.trim() ||
    stepId !== stepId.trim() ||
    stepId.includes('/') ||
    stepId.includes('\\') ||
    stepId === '.' ||
    stepId === '..' ||
    stepId.startsWith('.') ||
    stepId.endsWith('.') ||
    stepId.endsWith(' ') ||
    RESERVED_STEP_IDS.has(stepId.toLowerCase()) ||
    WINDOWS_RESERVED_NAMES.has(stem) ||
    chars.some((c) => WINDOWS_INVALID_CHARS.has(c)) ||
    chars.some((c) => (c.codePointAt(0) ?? 0) < 32)
  ) {
    throw new StepInstallError(
      `Invalid step id '${stepId}': must be a single safe ` +
        'path component (no separators, no leading dot, not a reserved name, ' +
        'no invalid filename characters)',
    );
  }
}

/** Resolve ``.specify/workflows/steps`` refusing symlinked parent dirs. */
export function resolveStepsBaseDir(projectRoot: string): string {
  const projectRootResolved = resolvePath(projectRoot);
  const stepsBaseDirUnresolved = join(projectRoot, '.specify', 'workflows', 'steps');

  let current = projectRoot;
  for (const part of ['.specify', 'workflows', 'steps']) {
    current = join(current, part);
    if (isSymlink(current)) {
      throw new StepInstallError(`Refusing to use symlinked step directory '${current}'`);
    }
    if (pathExists(current) && !isDir(current)) {
      throw new StepInstallError(`Step directory path is not a directory: '${current}'`);
    }
  }

  const stepsBaseDir = resolvePath(stepsBaseDirUnresolved);
  if (!isRelativeTo(stepsBaseDir, projectRootResolved)) {
    throw new StepInstallError(`Step directory escapes project root: '${stepsBaseDir}'`);
  }
  return stepsBaseDir;
}

/** Return the canonical destination directory for ``stepId``. */
function resolveStepDir(stepsBaseDir: string, stepId: string): string {
  const stepDir = join(stepsBaseDir, stepId);
  const rel = relative(stepsBaseDir, stepDir);
  if (rel.startsWith('..') || rel.split(sep).length !== 1 || rel !== stepId) {
    throw new StepInstallError(`Invalid step id '${stepId}'`);
  }
  return stepDir;
}

/** Refuse a symlink (including dangling) or non-directory destination. */
function rejectUnsafeDestination(stepDir: string): void {
  if (isSymlink(stepDir)) {
    throw new StepInstallError(`Refusing to install step through a symlinked path: '${stepDir}'`);
  }
  if (pathExists(stepDir) && !isDir(stepDir)) {
    throw new StepInstallError(`Step install path exists but is not a directory: '${stepDir}'`);
  }
}

// ============================================================================
// Package shape + safety validation
// ============================================================================

function entryLimitError(): StepInstallError {
  return new StepInstallError(
    'Step package contains too many entries, exceeding the ' +
      `${stepPackageLimits.maxFiles}-entry limit (files and directories combined)`,
  );
}

interface RetainedEntry {
  name: string;
  path: string;
}

/**
 * Return ``directory``'s retained children, sorted by name. Streams the
 * listing and drops ``EXCLUDE_NAMES`` without inspecting them; raises the
 * entry-limit error as soon as more than ``budget`` retained entries are
 * seen. Filesystem errors propagate to the caller.
 */
function scanRetainedEntries(directory: string, budget: number): RetainedEntry[] {
  const entries: RetainedEntry[] = [];
  const dir = opendirSync(directory);
  try {
    for (;;) {
      const dirent = dir.readSync();
      if (dirent === null) break;
      if (EXCLUDE_NAMES.has(dirent.name)) continue;
      if (entries.length >= budget) throw entryLimitError();
      entries.push({ name: dirent.name, path: join(directory, dirent.name) });
    }
  } finally {
    dir.closeSync();
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/**
 * Yield ``[path, isDir]`` for every retained descendant of ``packageDir``.
 * Excluded names are pruned without being entered; every retained entry
 * counts against the entry budget before its listing is sorted. Never
 * follows a symlink. Iterative, so deep trees cannot exhaust the stack.
 */
function* walkPackageTree(packageDir: string): Generator<[string, boolean]> {
  let discovered = 0;
  const children = (current: string, depth: number): Array<[RetainedEntry, number]> => {
    let entries: RetainedEntry[];
    try {
      entries = scanRetainedEntries(current, stepPackageLimits.maxFiles - discovered);
    } catch (exc) {
      if (exc instanceof StepInstallError) throw exc;
      throw new StepInstallError(`Failed to read step package directory '${current}': ${errMsg(exc)}`, { cause: exc });
    }
    discovered += entries.length;
    return entries.reverse().map((entry) => [entry, depth]);
  };

  const stack = children(packageDir, 1);
  while (stack.length) {
    const [entry, depth] = stack.pop() as [RetainedEntry, number];
    let st: Stats;
    try {
      st = lstatSync(entry.path);
    } catch (exc) {
      throw new StepInstallError(`Failed to inspect step package entry '${entry.path}': ${errMsg(exc)}`, { cause: exc });
    }
    if (st.isSymbolicLink()) throw new StepInstallError(`Step package contains symlink: ${entry.path}`);
    if (st.isDirectory()) {
      if (depth > stepPackageLimits.maxDepth) {
        throw new StepInstallError(
          `Step package exceeds the ${stepPackageLimits.maxDepth}-level directory depth limit`,
        );
      }
      yield [entry.path, true];
      stack.push(...children(entry.path, depth + 1));
    } else if (st.isFile()) {
      yield [entry.path, false];
    } else {
      throw new StepInstallError(`Step package contains unsupported file: ${entry.path}`);
    }
  }
}

/** Parse and validate ``step.yml``, returning the ``step`` mapping. */
function parseStepMetadata(stepYmlText: string, stepId: string): Dict {
  let meta: unknown;
  let isEmptyDocument: boolean;
  try {
    // ``safe_load`` returns None for an empty document and an explicit null;
    // only a genuinely empty document defaults to ``{}``.
    isEmptyDocument = isEmptyYamlDocument(stepYmlText);
    meta = parseYaml(stepYmlText);
  } catch (exc) {
    throw new StepInstallError(`Invalid step.yml: ${errMsg(exc)}`, { cause: exc });
  }
  if ((meta === null || meta === undefined) && isEmptyDocument) meta = {};
  else if (!isMapping(meta)) throw new StepInstallError('step.yml must be a YAML mapping');

  const stepMeta = 'step' in (meta as Dict) ? (meta as Dict).step : {};
  if (!isMapping(stepMeta)) throw new StepInstallError("step.yml 'step' field must be a mapping");
  const typeKey = 'type_key' in stepMeta ? stepMeta.type_key : '';
  if (!pyTruthy(typeKey)) {
    throw new StepInstallError("step.yml missing 'step.type_key' field");
  }
  if (typeKey !== stepId) {
    throw new StepInstallError(`step.yml type_key (${pyRepr(typeKey)}) does not match step ID (${pyRepr(stepId)})`);
  }
  return stepMeta;
}

/** Whether ``packageDir`` has a usable code entry point (see module ADAPTATION note). */
function requireCodeEntryPoint(packageDir: string): void {
  const candidates = ['__init__.py', ...CUSTOM_STEP_ENTRY_POINTS];
  for (const name of candidates) {
    const p = join(packageDir, name);
    if (isSymlink(p)) {
      throw new StepInstallError(`Step package '${name}' must be a regular file, not a symlink`);
    }
  }
  if (candidates.some((name) => isFile(join(packageDir, name)))) return;
  throw new StepInstallError(
    "Step package is missing required file '__init__.py' at its root " +
      `(or a JavaScript entry point: ${CUSTOM_STEP_ENTRY_POINTS.join(', ')})`,
  );
}

/**
 * Validate a materialized step package directory.
 *
 * Returns the validated ``step.yml`` ``step`` mapping. Throws
 * {@link StepInstallError} on any shape, symlink, limit, path or identity
 * violation. Never imports or executes the package code.
 */
export function validateStepPackage(packageDir: string, stepId: string): Dict {
  if (isSymlink(packageDir)) {
    throw new StepInstallError(`Refusing to install from a symlinked package directory: '${packageDir}'`);
  }
  if (!isDir(packageDir)) throw new StepInstallError(`Step package directory not found: '${packageDir}'`);

  const stepYml = join(packageDir, 'step.yml');
  if (isSymlink(stepYml)) {
    throw new StepInstallError("Step package 'step.yml' must be a regular file, not a symlink");
  }
  if (!isFile(stepYml)) {
    throw new StepInstallError("Step package is missing required file 'step.yml' at its root");
  }
  requireCodeEntryPoint(packageDir);

  // The walk enforces the entry ceiling itself; only bytes are summed here.
  let retainedBytes = 0;
  for (const [path, dir] of walkPackageTree(packageDir)) {
    if (dir) continue;
    try {
      retainedBytes += lstatSync(path).size;
    } catch (exc) {
      throw new StepInstallError(`Failed to inspect step package file '${path}': ${errMsg(exc)}`, { cause: exc });
    }
    if (retainedBytes > stepPackageLimits.maxBytes) {
      throw new StepInstallError(`Step package exceeds the ${stepPackageLimits.maxBytes}-byte total size limit`);
    }
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(stepYml));
  } catch (exc) {
    throw new StepInstallError(`Invalid step.yml: ${errMsg(exc)}`, { cause: exc });
  }
  return parseStepMetadata(text, stepId);
}

/** Resolve a root-level or single-nested step package directory. */
export function resolvePackageRoot(extractedRoot: string): string {
  const rootManifest = join(extractedRoot, 'step.yml');
  if (isFile(rootManifest) && !isSymlink(rootManifest)) return extractedRoot;
  let entries: string[];
  try {
    entries = readdirSync(extractedRoot);
  } catch (exc) {
    throw new StepInstallError(`Failed to inspect archive contents: ${errMsg(exc)}`, { cause: exc });
  }
  if (entries.length === 1) {
    const candidate = join(extractedRoot, entries[0] as string);
    const candidateManifest = join(candidate, 'step.yml');
    if (isDir(candidate) && !isSymlink(candidate) && isFile(candidateManifest) && !isSymlink(candidateManifest)) {
      return candidate;
    }
  }
  throw new StepInstallError('archive must contain step.yml at its root or in exactly one top-level directory');
}

// ============================================================================
// Collision / duplicate preflight
// ============================================================================

function rejectBuiltinCollision(stepId: string): void {
  if (BUILTIN_STEP_TYPES.has(stepId)) {
    throw new StepInstallError(`Step type '${stepId}' conflicts with a built-in step type`);
  }
}

function sameFile(a: string, b: string): boolean {
  const sa = statSync(a);
  const sb = statSync(b);
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

function checkDuplicate(registry: StepRegistry, stepId: string, stepDir: string, opts: { force: boolean }): void {
  const foldedId = stepId.toLowerCase();
  let registeredIds: string[] = [];
  try {
    registeredIds = Object.keys(registry.list());
  } catch {
    registeredIds = [];
  }
  for (const registeredId of registeredIds) {
    if (registeredId !== stepId && registeredId.toLowerCase() === foldedId) {
      throw new StepInstallError(
        `Step ID '${stepId}' collides case-insensitively with registered ` +
          `step ID '${registeredId}'; use the exact registered ID with --force`,
      );
    }
  }

  try {
    const destinationExists = pathExists(stepDir);
    const parent = join(stepDir, '..');
    for (const existingName of readdirSync(parent)) {
      if (existingName === stepId) continue;
      const existingPath = join(parent, existingName);
      const aliasesDestination = destinationExists && sameFile(existingPath, stepDir);
      if (existingName.toLowerCase() !== foldedId && !aliasesDestination) continue;
      throw new StepInstallError(
        `Step ID '${stepId}' collides case-insensitively or resolves to ` +
          'the same filesystem path as existing step directory ' +
          `'${existingName}'`,
      );
    }
  } catch (exc) {
    if (exc instanceof StepInstallError) throw exc;
    if ((exc as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw new StepInstallError(`Failed to inspect existing step directories: ${errMsg(exc)}`, { cause: exc });
    }
  }

  if (opts.force) return;
  if (registry.isInstalled(stepId)) {
    throw new StepInstallError(
      `Step type '${stepId}' is already installed. Remove it first with: ` + `specify workflow step remove ${stepId}`,
    );
  }
  if (pathExists(stepDir)) {
    throw new StepInstallError(
      `Step directory already exists at '${stepDir}'. Remove it manually ` +
        `or use: specify workflow step remove ${stepId}`,
    );
  }
}

/**
 * Advisory preflight shared by all sources (``check_installable``).
 *
 * Validates the id, base directory, built-in collision, and
 * duplicate/orphan-destination state without touching the package. The CLI
 * uses this to reject before a download; {@link installStepPackage} re-runs
 * the same checks as defense-in-depth.
 */
export function checkInstallable(projectRoot: string, stepId: string, opts: { force?: boolean } = {}): string {
  validateStepId(stepId);
  const stepsBaseDir = resolveStepsBaseDir(projectRoot);
  const stepDir = resolveStepDir(stepsBaseDir, stepId);
  rejectUnsafeDestination(stepDir);
  rejectBuiltinCollision(stepId);
  const registry = new StepRegistry(projectRoot);
  checkDuplicate(registry, stepId, stepDir, { force: opts.force ?? false });
  return stepDir;
}

// ============================================================================
// Staging + commit
// ============================================================================

function buildEntry(
  stepId: string,
  stepMeta: Dict,
  opts: { source: string; catalogName: unknown; catalogMetadata: unknown },
): Dict {
  const { source } = opts;
  if (!SOURCES.has(source)) throw new StepInstallError('Step install source must be one of: catalog, local, url');
  if (source === 'catalog' && typeof opts.catalogName !== 'string') {
    throw new StepInstallError('Catalog step install requires a string catalog name');
  }
  if (opts.catalogMetadata !== null && opts.catalogMetadata !== undefined && !isMapping(opts.catalogMetadata)) {
    throw new StepInstallError('Catalog step metadata must be a mapping');
  }
  const catalogMetadata = (opts.catalogMetadata as Dict | null | undefined) ?? {};

  const stringValue = (metadata: Dict, field: string): string | null => {
    const value = metadata[field];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') throw new StepInstallError(`step metadata '${field}' must be a string when present`);
    return value;
  };

  const typeKey = stringValue(stepMeta, 'type_key');
  if (!typeKey) throw new StepInstallError("step.yml missing 'step.type_key' field");
  const fields = ['name', 'version', 'description', 'author'];
  const pkg: Record<string, string | null> = {};
  const cat: Record<string, string | null> = {};
  for (const f of fields) pkg[f] = stringValue(stepMeta, f);
  for (const f of fields) cat[f] = stringValue(catalogMetadata, f);
  const entry: Dict = {
    name: cat.name || pkg.name || stepId,
    version: cat.version || pkg.version || '0.0.0',
    description: cat.description !== null ? cat.description : pkg.description || '',
    author: cat.author !== null ? cat.author : pkg.author || '',
    type_key: typeKey,
    source,
  };
  if (source === 'catalog') entry.catalog_name = opts.catalogName;
  return entry;
}

const O_NOFOLLOW = (fsConstants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/** Copy an inspected regular file within the remaining package byte budget. */
function copyRegularFile(source: string, target: string, expected: Stats, remainingBytes: number): number {
  let fd: number;
  try {
    fd = openSync(source, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (exc) {
    throw new StepInstallError(`Failed to stage step package: ${errMsg(exc)}`, { cause: exc });
  }
  try {
    const opened = fstatSync(fd);
    const sourceState = lstatSync(source);
    if (
      !opened.isFile() ||
      !sourceState.isFile() ||
      opened.dev !== sourceState.dev ||
      opened.ino !== sourceState.ino ||
      sourceState.isFile() !== expected.isFile()
    ) {
      throw new StepInstallError(`Step package file changed while staging: ${source}`);
    }
    let copiedBytes = 0;
    const out = openSync(target, 'wx');
    try {
      const buf = Buffer.alloc(COPY_CHUNK_BYTES);
      for (;;) {
        const want = Math.min(COPY_CHUNK_BYTES, remainingBytes - copiedBytes + 1);
        const n = readSync(fd, buf, 0, want, null);
        if (n === 0) break;
        if (copiedBytes + n > remainingBytes) {
          throw new StepInstallError(
            `Step package exceeds the ${stepPackageLimits.maxBytes}-byte total size limit while staging`,
          );
        }
        let off = 0;
        while (off < n) off += writeSync(out, buf, off, n - off);
        copiedBytes += n;
      }
    } finally {
      closeSync(out);
    }
    return copiedBytes;
  } catch (exc) {
    if (exc instanceof StepInstallError) throw exc;
    throw new StepInstallError(`Failed to stage step package: ${errMsg(exc)}`, { cause: exc });
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}

/**
 * Copy ``sourceDir`` into ``targetDir``, skipping excludes. Refuses to follow
 * a symlink encountered mid-copy and re-enforces the depth, entry and byte
 * budgets.
 */
function copyPackageTree(sourceDir: string, targetDir: string): void {
  let remainingBytes = stepPackageLimits.maxBytes;
  let discoveredEntries = 0;
  const pending: Array<[string, string, number]> = [[sourceDir, targetDir, 0]];
  while (pending.length) {
    const [current, destination, depth] = pending.pop() as [string, string, number];
    if (depth > stepPackageLimits.maxDepth) {
      throw new StepInstallError(`Step package exceeds the ${stepPackageLimits.maxDepth}-level directory depth limit`);
    }
    try {
      mkdirSync(destination, { recursive: true });
    } catch (exc) {
      throw new StepInstallError(`Failed to stage step package: ${errMsg(exc)}`, { cause: exc });
    }
    let entries: RetainedEntry[];
    try {
      entries = scanRetainedEntries(current, stepPackageLimits.maxFiles - discoveredEntries);
    } catch (exc) {
      if (exc instanceof StepInstallError) throw exc;
      throw new StepInstallError(`Failed to stage step package: ${errMsg(exc)}`, { cause: exc });
    }
    discoveredEntries += entries.length;
    for (const entry of entries) {
      let st: Stats;
      try {
        st = lstatSync(entry.path);
      } catch (exc) {
        throw new StepInstallError(`Failed to stage step package: ${errMsg(exc)}`, { cause: exc });
      }
      const target = join(destination, entry.name);
      if (st.isSymbolicLink()) throw new StepInstallError(`Step package contains symlink: ${entry.path}`);
      if (!(st.isDirectory() || st.isFile())) {
        throw new StepInstallError(`Step package contains unsupported file: ${entry.path}`);
      }
      if (st.isDirectory()) pending.push([entry.path, target, depth + 1]);
      else remainingBytes -= copyRegularFile(entry.path, target, st, remainingBytes);
    }
  }
}

/** Publish the staged package and record its registry entry. */
function replaceInstall(
  stepDir: string,
  stagedDir: string,
  registry: StepRegistry,
  stepId: string,
  entry: Dict,
  opts: { force: boolean },
): void {
  const registryFailure = (exc: unknown): boolean =>
    exc instanceof StepValidationError || isNodeOsError(exc) || exc instanceof TypeError || exc instanceof RangeError;

  if (pathExists(stepDir)) {
    if (!opts.force) {
      throw new StepInstallError(
        `Step directory already exists at '${stepDir}'. Remove it manually ` +
          `or use: specify workflow step remove ${stepId}`,
      );
    }
    // --force replacement: the replacement is fully staged and validated, so
    // it is safe to remove the previous installation now.
    try {
      installerDeps.rmtree(stepDir);
    } catch (exc) {
      throw new StepInstallError(
        `Failed to remove the existing step installation at '${stepDir}': ${errMsg(exc)}. ` +
          'Reinstall from the original source with --force.',
        { cause: exc },
      );
    }
    try {
      installerDeps.replace(stagedDir, stepDir);
    } catch (exc) {
      throw new StepInstallError(
        `Failed to publish the replacement for step type '${stepId}': ${errMsg(exc)}. ` +
          'The previous installation was removed; reinstall from the original source with --force.',
        { cause: exc },
      );
    }
    try {
      registry.add(stepId, entry);
    } catch (exc) {
      if (!registryFailure(exc)) throw exc;
      throw new StepInstallError(
        `Failed to update the step registry for '${stepId}': ${errMsg(exc)}. The ` +
          'package was replaced but the registry metadata was not updated; ' +
          'reinstall from the original source with --force.',
        { cause: exc },
      );
    }
    return;
  }

  try {
    installerDeps.replace(stagedDir, stepDir);
  } catch (exc) {
    throw new StepInstallError(`Failed to install step '${stepId}': ${errMsg(exc)}`, { cause: exc });
  }

  try {
    registry.add(stepId, entry);
  } catch (exc) {
    if (!registryFailure(exc)) throw exc;
    // Fresh install: roll back the just-published directory so the system is
    // not left with an unregistered step package on disk.
    try {
      installerDeps.rmtree(stepDir);
    } catch (cleanupExc) {
      throw new StepInstallError(
        `Failed to update the step registry for '${stepId}': ${errMsg(exc)}. ` +
          `The unregistered package remains at '${stepDir}' because rollback ` +
          `failed: ${errMsg(cleanupExc)}. Remove it manually before reinstalling.`,
        { cause: exc },
      );
    }
    throw new StepInstallError(errMsg(exc), { cause: exc });
  }
}

/**
 * Filesystem seams (Python tests monkeypatch ``shutil.rmtree`` /
 * ``os.replace``); tests may replace them.
 */
export const installerDeps: {
  rmtree: (path: string) => void;
  replace: (src: string, dst: string) => void;
  warn: (message: string) => void;
} = {
  rmtree: (path) => rmSync(path, { recursive: true }),
  replace: (src, dst) => renameSync(src, dst),
  warn: (message) => {
    process.stderr.write(`UserWarning: ${message}\n`);
  },
};

/** Options for {@link installStepPackage}. */
export interface InstallStepPackageOptions {
  source: StepInstallSource | string;
  catalogName?: unknown;
  catalogMetadata?: unknown;
  force?: boolean;
}

/**
 * Validate, stage and commit a step package from any source
 * (``install_step_package``). ``source`` is exactly ``"catalog"``,
 * ``"local"`` or ``"url"``. Returns the registry entry that was persisted.
 */
export function installStepPackage(
  projectRoot: string,
  stepId: string,
  packageDir: string,
  opts: InstallStepPackageOptions,
): Dict {
  const source = opts.source;
  const catalogName = opts.catalogName ?? '';
  const catalogMetadata = opts.catalogMetadata ?? null;
  const force = opts.force ?? false;

  if (isSymlink(packageDir)) {
    throw new StepInstallError(`Refusing to install from a symlinked package directory: '${packageDir}'`);
  }
  if (!isDir(packageDir)) throw new StepInstallError(`Step package directory not found: '${packageDir}'`);

  validateStepId(stepId);
  const stepsBaseDir = resolveStepsBaseDir(projectRoot);
  let stepDir = resolveStepDir(stepsBaseDir, stepId);
  rejectUnsafeDestination(stepDir);

  // Reject a source that resolves to (or contains) the install destination: a
  // --force replacement would otherwise delete the source before it is copied.
  let sourceResolved: string;
  let destResolved: string;
  try {
    sourceResolved = resolvePath(packageDir);
    destResolved = resolvePath(stepDir);
  } catch (exc) {
    throw new StepInstallError(`Failed to resolve step package path: ${errMsg(exc)}`, { cause: exc });
  }
  if (sourceResolved === destResolved || isRelativeTo(destResolved, sourceResolved)) {
    throw new StepInstallError(`Step package source resolves to the install destination: '${packageDir}'`);
  }

  rejectBuiltinCollision(stepId);
  let registry = new StepRegistry(projectRoot);
  checkDuplicate(registry, stepId, stepDir, { force });

  // Validate source and all caller-controlled metadata before creating any
  // project directories. The staged metadata is used for the final entry.
  buildEntry(stepId, validateStepPackage(packageDir, stepId), { source, catalogName, catalogMetadata });

  let workDir: string;
  try {
    mkdirSync(stepsBaseDir, { recursive: true });
    workDir = mkdtempSync(join(stepsBaseDir, WORK_DIR_PREFIX));
  } catch (exc) {
    throw new StepInstallError(`Failed to create staging directory: ${errMsg(exc)}`, { cause: exc });
  }

  const stagedDir = join(workDir, 'staged');
  let committed = false;
  let primaryError: unknown = null;
  let entry: Dict;
  try {
    copyPackageTree(packageDir, stagedDir);
    // Re-validate the complete staged copy: the source may have changed while
    // it was copied.
    const stagedMeta = validateStepPackage(stagedDir, stepId);
    entry = buildEntry(stepId, stagedMeta, { source, catalogName, catalogMetadata });
    // Serialize destination and registry changes. Source copying stays outside
    // the lock, but all conflicting state is reloaded and checked again
    // immediately before publication.
    stepInstallTransaction(projectRoot, () => {
      const lockedBaseDir = resolveStepsBaseDir(projectRoot);
      if (lockedBaseDir !== stepsBaseDir) {
        throw new StepInstallError('Step directory changed while staging; reinstall from the original source');
      }
      stepDir = resolveStepDir(lockedBaseDir, stepId);
      rejectUnsafeDestination(stepDir);
      rejectBuiltinCollision(stepId);
      registry = new StepRegistry(projectRoot);
      checkDuplicate(registry, stepId, stepDir, { force });
      replaceInstall(stepDir, stagedDir, registry, stepId, entry, { force });
      committed = true;
    });
  } catch (exc) {
    primaryError = exc;
    throw exc;
  } finally {
    try {
      installerDeps.rmtree(workDir);
    } catch (cleanupExc) {
      if (pathExists(workDir)) {
        const message = `Could not remove step staging directory '${workDir}': ${errMsg(cleanupExc)}`;
        if (primaryError !== null) {
          if (primaryError instanceof StepInstallError) primaryError.addNote(message);
        } else if (committed) {
          installerDeps.warn(message);
        } else {
          // eslint-disable-next-line no-unsafe-finally
          throw new StepInstallError(message, { cause: cleanupExc });
        }
      }
    }
  }
  return entry!;
}
