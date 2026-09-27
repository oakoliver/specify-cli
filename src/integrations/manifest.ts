/**
 * @oakoliver/specify-cli - Integration Manifest
 *
 * Hash-tracked installation manifest for integrations (port of
 * `integrations/manifest.py`).
 *
 * Each installed integration records the files it created together with
 * their SHA-256 hashes.  On uninstall only files whose hash still matches
 * the recorded value are removed — modified files are left in place and
 * reported to the caller.
 *
 * Also exports small path helpers that emulate Python's ``pathlib``
 * semantics (``Path.resolve()``, ``relative_to``) used across the
 * integration modules.
 *
 * @module integrations/manifest
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir as osHomedir } from 'node:os';

import { ValueError } from '../download-security.js';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

// ============================================================================
// Python-compatible error classes
// ============================================================================

/** Python ``ValueError`` equivalent (shared with ``download-security``). */
export { ValueError };

/** True for any error modelling Python ``ValueError`` (matched by name). */
export function isValueError(err: unknown): boolean {
  return err instanceof Error && (err instanceof ValueError || err.name === 'ValueError' || err.name === 'SymlinkedSharedPathError');
}

/** Python ``KeyError`` equivalent. */
export class KeyError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "KeyError";
  }
}

/** Python ``NotImplementedError`` equivalent. */
export class NotImplementedError extends Error {
  constructor(message = "") {
    super(message);
    this.name = "NotImplementedError";
  }
}

/** True for Node system errors (Python ``OSError`` family). */
export function isOSError(err: unknown): boolean {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
}

// ============================================================================
// pathlib-like helpers
// ============================================================================

/**
 * Emulate Python ``Path.resolve()`` (non-strict): make *p* absolute, follow
 * symlinks for the longest existing prefix, and lexically normalise the
 * remainder.
 */
export function resolvePath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    // fall through: resolve the longest existing prefix
  }
  const parts: string[] = [];
  let current = abs;
  // Walk up until an existing ancestor is found.
  for (;;) {
    const parent = dirname(current);
    parts.unshift(basename(current));
    if (parent === current) {
      return abs;
    }
    current = parent;
    try {
      const real = realpathSync.native(current);
      return resolve(real, ...parts);
    } catch {
      continue;
    }
  }
}

/** Return true when *child* is *base* or lies inside it (lexical, both absolute). */
export function isRelativeTo(child: string, base: string): boolean {
  const rel = relative(base, child);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + sep);
}

/**
 * Emulate ``Path.relative_to``: return the POSIX-style relative path of
 * *child* under *base* or throw an Error (Python ``ValueError``).
 */
export function relativeTo(child: string, base: string): string {
  if (!isRelativeTo(child, base)) {
    throw new ValueError(`'${child}' is not in the subpath of '${base}'`);
  }
  return relative(base, child).split(sep).join('/');
}

/**
 * Python ``Path.home()``: honours ``HOME`` (``USERPROFILE`` on Windows) at
 * call time, falling back to ``os.homedir()``.
 */
export function homeDir(): string {
  const env = process.platform === 'win32' ? process.env.USERPROFILE || process.env.HOME : process.env.HOME;
  return env || osHomedir();
}

/** ``Path.is_symlink()`` */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** ``Path.is_file()`` (follows symlinks) */
export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** ``Path.is_dir()`` (follows symlinks) */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** ``Path.exists()`` (follows symlinks) */
export function pathExists(p: string): boolean {
  return existsSync(p);
}

/** Split a relative path into its components (``Path.parts``), POSIX + native separators. */
export function pathParts(p: string): string[] {
  return p.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
}

/**
 * Serialise *data* like Python ``json.dumps(data, indent=N)`` (with the
 * default ``ensure_ascii=True``).
 */
export function pyJsonDumps(data: unknown, indent = 2, ensureAscii = true): string {
  const text = JSON.stringify(data, null, indent) ?? 'null';
  if (!ensureAscii) return text;
  return text.replace(/[\u0080-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Python ``datetime.now(timezone.utc).isoformat()`` */
export function utcIsoNow(): string {
  const d = new Date();
  const iso = d.toISOString(); // 2026-01-01T00:00:00.123Z
  return iso.replace(/\.(\d{3})Z$/, (_m, ms: string) => `.${ms}000+00:00`);
}

// ============================================================================
// Internal helpers
// ============================================================================

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function validateRelPath(rel: string, root: string): string {
  if (isAbsolute(rel)) {
    throw new ValueError(`Absolute paths are not allowed in manifests: ${rel}`);
  }
  const resolved = resolvePath(join(root, rel));
  const rootResolved = resolvePath(root);
  if (!isRelativeTo(resolved, rootResolved)) {
    throw new ValueError(
      `Path ${rel} resolves to ${resolved} which is outside the project root ${rootResolved}`,
    );
  }
  return resolved;
}

function manifestPathLabel(root: string, path: string): string {
  if (isRelativeTo(path, root)) return relativeTo(path, root);
  return path.split(sep).join('/');
}

function ensureSafeManifestDirectory(root: string, directory: string): void {
  const rootResolved = resolvePath(root);
  if (!isRelativeTo(directory, root)) {
    const label = manifestPathLabel(root, directory);
    throw new ValueError(`Integration manifest directory escapes project root: ${label}`);
  }
  const rel = relative(root, directory);
  let current = root;
  for (const part of pathParts(rel)) {
    current = join(current, part);
    const label = manifestPathLabel(root, current);
    if (isSymlink(current)) {
      throw new ValueError(`Refusing to use symlinked integration manifest directory: ${label}`);
    }
    if (existsSync(current)) {
      if (!isDir(current)) {
        throw new ValueError(`Integration manifest directory path is not a directory: ${label}`);
      }
      if (!isRelativeTo(resolvePath(current), rootResolved)) {
        throw new ValueError(`Integration manifest directory escapes project root: ${label}`);
      }
      continue;
    }
    mkdirSync(current);
    if (!isRelativeTo(resolvePath(current), rootResolved)) {
      throw new ValueError(`Integration manifest directory escapes project root: ${label}`);
    }
  }
}

function ensureSafeManifestDestination(root: string, path: string): void {
  const rootResolved = resolvePath(root);
  ensureSafeManifestDirectory(root, dirname(path));
  const label = manifestPathLabel(root, path);
  if (isSymlink(path)) {
    throw new ValueError(`Refusing to overwrite symlinked integration manifest path: ${label}`);
  }
  if (existsSync(path)) {
    if (!isFile(path)) {
      throw new ValueError(`Integration manifest path is not a file: ${label}`);
    }
    if (!isRelativeTo(resolvePath(path), rootResolved)) {
      throw new ValueError(`Integration manifest path escapes project root: ${label}`);
    }
  }
}

function hasDotDot(rel: string): boolean {
  return pathParts(rel).includes('..');
}

// ============================================================================
// IntegrationManifest
// ============================================================================

export interface IntegrationManifestOptions {
  /** Resolve ``projectRoot`` (follow symlinks) before using it. Default true. */
  resolveProjectRoot?: boolean;
}

/**
 * Tracks files installed by a single integration.
 */
export class IntegrationManifest {
  key: string;
  projectRoot: string;
  version: string;
  /** rel_path → sha256 hex */
  private _files: Record<string, string> = {};
  private _recoveredFiles = new Set<string>();
  private _installedAt = '';

  constructor(key: string, projectRoot: string, version = '', opts: IntegrationManifestOptions = {}) {
    this.key = key;
    this.projectRoot = opts.resolveProjectRoot === false ? resolve(projectRoot) : resolvePath(projectRoot);
    this.version = version;
  }

  /** Python-compatible alias of {@link projectRoot}. */
  get project_root(): string {
    return this.projectRoot;
  }

  // -- Manifest file location -------------------------------------------

  /** Path to the on-disk manifest JSON. */
  get manifestPath(): string {
    return join(this.projectRoot, '.specify', 'integrations', `${this.key}.manifest.json`);
  }

  // -- Recording files --------------------------------------------------

  /**
   * Write *content* to *relPath* (relative to project root) and record its hash.
   * Returns the absolute path of the written file.
   */
  recordFile(relPath: string, content: string | Uint8Array): string {
    const absPath = validateRelPath(relPath, this.projectRoot);
    mkdirSync(dirname(absPath), { recursive: true });
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
    writeFileSync(absPath, bytes);
    const normalized = relativeTo(absPath, this.projectRoot);
    this._files[normalized] = createHash('sha256').update(bytes).digest('hex');
    this._recoveredFiles.delete(normalized);
    return absPath;
  }

  /**
   * Record the hash of an already-existing regular file at *relPath*.
   * With ``recovered: true`` the path is also marked in ``recovered_files``.
   */
  recordExisting(relPath: string, opts: { recovered?: boolean } = {}): void {
    if (isAbsolute(relPath) || hasDotDot(relPath)) {
      validateRelPath(relPath, this.projectRoot);
      throw new ValueError(
        `Manifest paths must be canonical; '..' segments are not allowed (got ${relPath})`,
      );
    }
    let walk = this.projectRoot;
    for (const part of pathParts(relPath)) {
      walk = join(walk, part);
      if (isSymlink(walk)) {
        throw new ValueError(
          `Refusing to record symlinked manifest path: ${pathParts(relPath).join('/')} ` +
            `(symlinked at ${relativeTo(walk, this.projectRoot)})`,
        );
      }
    }
    const absPath = validateRelPath(relPath, this.projectRoot);
    if (!isFile(absPath)) {
      throw new ValueError(`Manifest path is not a regular file: ${pathParts(relPath).join('/')}`);
    }
    const normalized = relativeTo(absPath, this.projectRoot);
    this._files[normalized] = sha256File(absPath);
    if (opts.recovered) {
      this._recoveredFiles.add(normalized);
    } else {
      this._recoveredFiles.delete(normalized);
    }
  }

  /** Drop *relPath* from the tracked set (does not touch disk). */
  remove(relPath: string): boolean {
    if (isAbsolute(relPath) || hasDotDot(relPath)) return false;
    let normalized: string;
    try {
      const absPath = validateRelPath(relPath, this.projectRoot);
      normalized = relativeTo(absPath, this.projectRoot);
    } catch {
      return false;
    }
    this._recoveredFiles.delete(normalized);
    if (normalized in this._files) {
      delete this._files[normalized];
      return true;
    }
    return false;
  }

  // -- Querying ---------------------------------------------------------

  /** Copy of the ``{rel_path: sha256}`` mapping. */
  get files(): Record<string, string> {
    return { ...this._files };
  }

  /** Copy of the set of paths recorded with ``recovered: true``. */
  get recoveredFiles(): Set<string> {
    return new Set(this._recoveredFiles);
  }

  /** Python-compatible alias. */
  get recovered_files(): Set<string> {
    return this.recoveredFiles;
  }

  /** Installed-at timestamp (ISO string) — empty until saved or loaded. */
  get installedAt(): string {
    return this._installedAt;
  }

  isRecovered(relPath: string): boolean {
    if (isAbsolute(relPath) || hasDotDot(relPath)) return false;
    try {
      const absPath = validateRelPath(relPath, this.projectRoot);
      return this._recoveredFiles.has(relativeTo(absPath, this.projectRoot));
    } catch {
      return false;
    }
  }

  /** Relative paths of tracked files whose content changed on disk. */
  checkModified(): string[] {
    const modified: string[] = [];
    for (const [rel, expected] of Object.entries(this._files)) {
      if (isAbsolute(rel) || hasDotDot(rel)) continue;
      const absPath = join(this.projectRoot, rel);
      if (!existsSync(absPath) && !isSymlink(absPath)) continue;
      if (isSymlink(absPath) || !isFile(absPath)) {
        modified.push(rel);
        continue;
      }
      let changed: boolean;
      try {
        changed = sha256File(absPath) !== expected;
      } catch {
        changed = true;
      }
      if (changed) modified.push(rel);
    }
    return modified;
  }

  // -- Uninstall --------------------------------------------------------

  /**
   * Remove tracked files whose hash still matches.
   * Returns ``[removed, skipped]`` absolute paths.
   */
  uninstall(
    projectRoot?: string | null,
    opts: { force?: boolean; removeManifest?: boolean } = {},
  ): [string[], string[]] {
    const force = opts.force ?? false;
    const removeManifest = opts.removeManifest ?? true;
    const root = resolvePath(projectRoot ?? this.projectRoot);
    const removed: string[] = [];
    const skipped: string[] = [];

    for (const [rel, expected] of Object.entries(this._files)) {
      const path = join(root, rel);
      const normed = normalize(isAbsolute(rel) ? rel : path);
      if (isAbsolute(rel) || !isRelativeTo(normed, root)) continue;
      if (!existsSync(path) && !isSymlink(path)) continue;
      if (!isFile(path) && !isSymlink(path)) {
        skipped.push(path);
        continue;
      }
      if (isSymlink(path)) {
        if (!force) {
          skipped.push(path);
          continue;
        }
      } else if (!force) {
        let matches: boolean;
        try {
          matches = sha256File(path) === expected;
        } catch {
          skipped.push(path);
          continue;
        }
        if (!matches) {
          skipped.push(path);
          continue;
        }
      }
      try {
        unlinkSync(path);
      } catch {
        skipped.push(path);
        continue;
      }
      removed.push(path);
      let parent = dirname(path);
      while (parent !== root && isRelativeTo(parent, root)) {
        try {
          rmdirSync(parent);
        } catch {
          break;
        }
        parent = dirname(parent);
      }
    }

    const manifest = join(root, '.specify', 'integrations', `${this.key}.manifest.json`);
    if (removeManifest && existsSync(manifest)) {
      try {
        unlinkSync(manifest);
      } catch {
        skipped.push(manifest);
      }
      let parent = dirname(manifest);
      while (parent !== root && isRelativeTo(parent, root)) {
        try {
          rmdirSync(parent);
        } catch {
          break;
        }
        parent = dirname(parent);
      }
    }

    return [removed, skipped];
  }

  // -- Persistence ------------------------------------------------------

  /** Write the manifest to disk.  Returns the manifest path. */
  save(): string {
    this._installedAt = this._installedAt || utcIsoNow();
    const data: Record<string, unknown> = {
      integration: this.key,
      version: this.version,
      installed_at: this._installedAt,
      files: this._files,
    };
    if (this._recoveredFiles.size > 0) {
      data.recovered_files = [...this._recoveredFiles].sort();
    }
    const path = this.manifestPath;
    const content = pyJsonDumps(data, 2) + '\n';
    ensureSafeManifestDestination(this.projectRoot, path);
    const tempPath = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}`);
    try {
      const fd = openSync(tempPath, 'wx', 0o600);
      try {
        writeSync(fd, content, null, 'utf-8');
      } finally {
        closeSync(fd);
      }
      chmodSync(tempPath, 0o644);
      ensureSafeManifestDestination(this.projectRoot, path);
      renameSync(tempPath, path);
    } finally {
      try {
        unlinkSync(tempPath);
      } catch {
        // already renamed
      }
    }
    return path;
  }

  /**
   * Load an existing manifest from disk.  Throws an ``ENOENT`` error
   * (Python ``FileNotFoundError``) if the manifest does not exist, or an
   * ``Error`` (Python ``ValueError``) for malformed content.
   */
  static load(key: string, projectRoot: string, opts: IntegrationManifestOptions = {}): IntegrationManifest {
    const inst = new IntegrationManifest(key, projectRoot, '', opts);
    const path = inst.manifestPath;
    const raw = readFileSync(path);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      throw new ValueError(`Integration manifest at ${path} is not valid UTF-8`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ValueError(`Integration manifest at ${path} contains invalid JSON`);
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new ValueError(
        `Integration manifest at ${path} must be a JSON object, got ${pyTypeName(data)}`,
      );
    }
    const obj = data as Record<string, unknown>;
    const files = 'files' in obj ? obj.files : {};
    if (
      typeof files !== 'object' ||
      files === null ||
      Array.isArray(files) ||
      !Object.values(files as Record<string, unknown>).every((v) => typeof v === 'string')
    ) {
      throw new ValueError(
        `Integration manifest 'files' at ${path} must be a mapping of string paths to string hashes`,
      );
    }
    inst.version = (obj.version as string) ?? '';
    inst._installedAt = (obj.installed_at as string) ?? '';
    inst._files = { ...(files as Record<string, string>) };

    const recovered = 'recovered_files' in obj ? obj.recovered_files : [];
    if (!Array.isArray(recovered) || !recovered.every((p) => typeof p === 'string')) {
      throw new ValueError(
        `Integration manifest 'recovered_files' at ${path} must be a list of string paths`,
      );
    }
    inst._recoveredFiles = new Set((recovered as string[]).filter((p) => p in inst._files));

    const storedKey = obj.integration;
    if (storedKey && storedKey !== key) {
      throw new ValueError(
        `Manifest at ${path} belongs to integration '${String(storedKey)}', not '${key}'`,
      );
    }
    return inst;
  }
}

/** Python ``type(x).__name__`` for JSON-ish values. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  switch (typeof value) {
    case 'string':
      return 'str';
    case 'boolean':
      return 'bool';
    case 'number':
      return Number.isInteger(value) ? 'int' : 'float';
    case 'object':
      return 'dict';
    default:
      return typeof value;
  }
}
