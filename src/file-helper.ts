/**
 * @oakoliver/specify-cli - Scoped filesystem operations
 *
 * Port of spec-kit `file_helper.py` (v1.2.5, #4908 / #4934): a FileHelper
 * owns operations beneath one trusted root with an immutable symlink policy.
 * Relative operation paths are relative to `root` (not the process cwd);
 * the root itself is a trusted alias boundary, resolved once on
 * construction. Accessed symlinks are refused unless `allowSymlinks` is set,
 * and even then only contained targets are followed.
 *
 * Errors mirror Python: contract violations raise {@link FileHelperError}
 * subclasses; native failures surface as Node `SystemError`s carrying the
 * errno `code` (`ENOENT`, `ENOTDIR`, `EEXIST`, ...), which is what Python's
 * `FileNotFoundError` / `NotADirectoryError` / `FileExistsError` map to.
 *
 * @module file-helper
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/** An operation violates the scoped filesystem contract (upstream: ValueError subclass). */
export class FileHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileHelperError';
  }
}

/** An accessed symlink requires explicit traversal permission. */
export class SymlinkDeniedError extends FileHelperError {
  constructor(message: string) {
    super(message);
    this.name = 'SymlinkDeniedError';
  }
}

/** An accessed path is outside the established root. */
export class PathEscapeError extends FileHelperError {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

/** An accessed object cannot be used by the requested operation. */
export class UnsupportedPathError extends FileHelperError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPathError';
  }
}

/** Node-style errno error (the analogue of Python's OSError subclasses). */
export interface ErrnoError extends Error {
  code: string;
  errno?: number;
  path?: string;
}

const ERRNO_TEXT: Record<string, [number, string]> = {
  ENOENT: [2, 'No such file or directory'],
  EEXIST: [17, 'File exists'],
  ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
};

/** Build an errno error equivalent to Python's `FileNotFoundError(...)` etc. */
export function errnoError(code: string, target: string): ErrnoError {
  const [errno, text] = ERRNO_TEXT[code] ?? [0, code];
  const err = new Error(`[Errno ${errno}] ${text}: '${target}'`) as ErrnoError;
  err.code = code;
  err.errno = errno;
  err.path = target;
  return err;
}

/**
 * Errno error raised with a single argument (Python `NotADirectoryError(path)`),
 * whose `str()` is just the path.
 */
export function bareErrnoError(code: string, target: string): ErrnoError {
  const err = new Error(target) as ErrnoError;
  err.code = code;
  err.errno = ERRNO_TEXT[code]?.[0];
  err.path = target;
  return err;
}

/** True when `err` is an errno error with `code` (Python: isinstance(err, FileNotFoundError) ...). */
export function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

/** True for native OS errors (Python: isinstance(err, OSError)). */
export function isOsError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code);
}

const IS_WINDOWS = process.platform === 'win32';

/** Normalize Windows extended drive/UNC spellings for comparison only. */
export function stripExtendedLengthPrefix(raw: string): string {
  if (raw.toLowerCase().startsWith('\\\\?\\unc\\')) return '\\\\' + raw.slice('\\\\?\\UNC\\'.length);
  if (raw.startsWith('\\\\?\\')) return raw.slice('\\\\?\\'.length);
  return raw;
}

/**
 * Split a path like `pathlib.PurePath.parts` (lexical: '.' and repeated
 * separators vanish, '..' is preserved) without the anchor.
 */
function lexicalParts(p: string): string[] {
  const seps = IS_WINDOWS ? /[\\/]+/ : /\/+/;
  return p.split(seps).filter((x) => x !== '' && x !== '.');
}

function anchorOf(p: string): string {
  return IS_WINDOWS ? path.win32.parse(p).root : p.startsWith('/') ? '/' : '';
}

function sameParts(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (IS_WINDOWS ? a[i].toLowerCase() !== b[i].toLowerCase() : a[i] !== b[i]) return false;
  }
  return true;
}

/** Return `parts` of `p` relative to `root` lexically, or null (pathlib `relative_to`). */
function relativeParts(p: string, root: string): string[] | null {
  if (anchorOf(p).toLowerCase() !== anchorOf(root).toLowerCase() && IS_WINDOWS) return null;
  if (!IS_WINDOWS && anchorOf(p) !== anchorOf(root)) return null;
  const pp = lexicalParts(p.slice(anchorOf(p).length));
  const rp = lexicalParts(root.slice(anchorOf(root).length));
  if (pp.length < rp.length || !sameParts(pp.slice(0, rp.length), rp)) return null;
  return pp.slice(rp.length);
}

function lstatMode(p: string): fs.Stats {
  return fs.lstatSync(p);
}

function existsNoFollow(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function existsFollow(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDirFollow(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const O_NOFOLLOW = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;

export interface FileHelperOptions {
  allowSymlinks?: boolean;
}

/**
 * Own operations beneath one trusted root with an immutable link policy.
 *
 * Relative operation paths are relative to `root`, not the process cwd.
 * The root itself is a trusted alias boundary, resolved once on construction.
 */
export class FileHelper {
  readonly root: string;
  readonly allowSymlinks: boolean;
  private readonly canonicalRoot: string;

  constructor(root: string, opts: FileHelperOptions | boolean = {}) {
    const allow = typeof opts === 'boolean' ? opts : Boolean(opts.allowSymlinks);
    // Python `Path.absolute()`: '.' and repeated separators vanish, '..' is kept lexically.
    const raw = path.isAbsolute(root) ? root : `${process.cwd()}${path.sep}${root}`;
    const anchor = anchorOf(raw);
    const absolute = anchor + lexicalParts(raw.slice(anchor.length)).join(path.sep);
    // Python: Path.absolute() keeps '..' lexically; resolve(strict=True) raises when missing.
    let canonical: string;
    try {
      canonical = fs.realpathSync.native(root);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw errnoError(code, absolute);
      throw e;
    }
    if (!fs.statSync(canonical).isDirectory()) throw bareErrnoError('ENOTDIR', absolute);
    this.root = absolute;
    this.allowSymlinks = allow;
    this.canonicalRoot = canonical;
    Object.freeze(this);
  }

  /** The canonical (symlink-resolved) root. */
  get canonical(): string {
    return this.canonicalRoot;
  }

  private parts(p: string): string[] {
    const original = p;
    let candidate = p;
    if (IS_WINDOWS) candidate = stripExtendedLengthPrefix(candidate);
    if (!path.isAbsolute(candidate) || (IS_WINDOWS && !/^([a-zA-Z]:[\\/]|[\\/]{2})/.test(candidate))) {
      if (anchorOf(original) || anchorOf(candidate)) {
        throw new PathEscapeError(
          `Rooted-relative, drive-relative, or device path is not permitted: ${original}`,
        );
      }
      return lexicalParts(candidate);
    }
    for (let root of [this.root, this.canonicalRoot]) {
      if (IS_WINDOWS) root = stripExtendedLengthPrefix(root);
      const rel = relativeParts(candidate, root);
      if (rel !== null) return rel;
    }
    throw new PathEscapeError(`Path is outside root ${this.root}: ${original}`);
  }

  /** lstat mode, rejecting Windows reparse points that are not symlinks. */
  private static entryMode(p: string): fs.Stats {
    return lstatMode(p);
  }

  private walk(
    parts: string[],
    opts: { allowMissing?: boolean; followLeaf?: boolean; links?: string[] } = {},
  ): string {
    const allowMissing = opts.allowMissing ?? false;
    const followLeaf = opts.followLeaf ?? true;
    const links = opts.links ?? [];
    let current = this.canonicalRoot;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (!isDirFollow(current)) {
        if (!(allowMissing && !existsFollow(current))) throw bareErrnoError('ENOTDIR', current);
      }
      if (part === '..') {
        if (current === this.canonicalRoot) throw new PathEscapeError(`Symlink target escapes root ${this.root}`);
        current = path.dirname(current);
        continue;
      }
      const candidate = path.join(current, part);
      let st: fs.Stats;
      try {
        st = FileHelper.entryMode(candidate);
      } catch (e) {
        if (!isErrno(e, 'ENOENT') || !allowMissing) throw e;
        current = candidate;
        continue;
      }
      if (st.isSymbolicLink()) {
        if (!this.allowSymlinks) {
          throw new SymlinkDeniedError(
            `Refusing symlink ${candidate}; explicitly allow symlinks ` +
              'on this FileHelper to use supported contained targets',
          );
        }
        if (!followLeaf && index === parts.length - 1) return candidate;
        if (links.includes(candidate) || links.length >= 40) {
          throw new UnsupportedPathError(`Symlink cycle or excessive chain: ${candidate}`);
        }
        const target = fs.readlinkSync(candidate);
        let targetParts = this.parts(target);
        if (!path.isAbsolute(target)) {
          targetParts = [...lexicalParts(path.relative(this.canonicalRoot, current)), ...targetParts];
        }
        // Resolve the link target strictly, even when creating a new child.
        current = this.walk(targetParts, { links: [...links, candidate] });
      } else if (st.isDirectory() || st.isFile()) {
        current = candidate;
      } else {
        throw new UnsupportedPathError(`Unsupported filesystem object: ${candidate}`);
      }
    }
    return current;
  }

  private resolveOp(p: string, opts: { allowMissing?: boolean; followLeaf?: boolean } = {}): string {
    const parts = this.parts(String(p));
    if (parts.includes('..')) throw new PathEscapeError(`Parent traversal is not an operation path: ${p}`);
    return this.walk(parts, opts);
  }

  private static requireFile(p: string): void {
    if (!fs.statSync(p).isFile()) throw new UnsupportedPathError(`Expected a regular file: ${p}`);
  }

  /** Create a directory, preflighting the entire requested hierarchy. */
  mkdir(p: string, opts: { parents?: boolean; existOk?: boolean } = {}): void {
    const destination = this.resolveOp(p, { allowMissing: true });
    const parents = opts.parents ?? false;
    const existOk = opts.existOk ?? false;
    if (existsFollow(destination)) {
      if (existOk && isDirFollow(destination)) return;
      throw errnoError('EEXIST', destination);
    }
    if (!parents && !existsFollow(path.dirname(destination))) throw errnoError('ENOENT', destination);
    fs.mkdirSync(destination, { recursive: parents });
  }

  readBytes(p: string): Buffer {
    const destination = this.resolveOp(p);
    FileHelper.requireFile(destination);
    return fs.readFileSync(destination);
  }

  /** Read a file as text (strict UTF-8 decoding; invalid bytes raise a TypeError like UnicodeDecodeError). */
  readText(p: string, encoding: BufferEncoding = 'utf8'): string {
    const raw = this.readBytes(p);
    if (encoding === 'utf8' || encoding === 'utf-8') {
      return new TextDecoder('utf-8', { fatal: true }).decode(raw);
    }
    return raw.toString(encoding);
  }

  /** Exclusively create a file; never overwrite an existing entry. */
  createBytes(p: string, content: Uint8Array, mode = 0o644): void {
    const destination = this.resolveOp(p, { allowMissing: true, followLeaf: false });
    if (existsNoFollow(destination)) throw errnoError('EEXIST', destination);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;
    const fd = fs.openSync(destination, flags, mode);
    try {
      fs.writeSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
  }

  createText(p: string, content: string, mode = 0o644): void {
    this.createBytes(p, Buffer.from(content, 'utf8'), mode);
  }

  /** Atomically create/replace a file, preserving any allowed leaf link. */
  writeBytes(p: string, content: Uint8Array, mode = 0o644): void {
    const destination = this.resolveOp(p, { allowMissing: true });
    if (existsFollow(destination)) FileHelper.requireFile(destination);
    const dir = path.dirname(destination);
    let temporary = '';
    let fd = -1;
    for (let i = 0; i < 100 && fd < 0; i++) {
      temporary = path.join(dir, `.${path.basename(destination)}.${randomBytes(6).toString('hex')}`);
      try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      } catch (e) {
        if (!isErrno(e, 'EEXIST')) throw e;
      }
    }
    try {
      try {
        fs.writeSync(fd, content);
      } finally {
        fs.closeSync(fd);
      }
      fs.chmodSync(temporary, mode);
      if (this.resolveOp(p, { allowMissing: true }) !== destination) {
        throw new FileHelperError(`Destination changed during write: ${p}`);
      }
      fs.renameSync(temporary, destination);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {
        /* missing_ok */
      }
    }
  }

  writeText(p: string, content: string, mode = 0o644): void {
    this.writeBytes(p, Buffer.from(content, 'utf8'), mode);
  }

  /** Non-atomic text upsert preserving the existing inode. */
  overwriteText(p: string, content: string): void {
    const destination = this.resolveOp(p, { allowMissing: true });
    if (existsFollow(destination)) FileHelper.requireFile(destination);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | O_NOFOLLOW;
    const fd = fs.openSync(destination, flags, 0o666);
    try {
      fs.writeSync(fd, Buffer.from(content, 'utf8'));
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Create a link to an existing contained regular file or directory.
   * Relative targets use the link's parent, matching `Path.symlink_to`.
   */
  symlink(target: string, p: string): void {
    if (!this.allowSymlinks) throw new SymlinkDeniedError('Symlink creation requires explicit allow_symlinks=True');
    const destination = this.resolveOp(p, { allowMissing: true, followLeaf: false });
    let targetParts = this.parts(target);
    if (!path.isAbsolute(target)) {
      targetParts = [...lexicalParts(path.relative(this.canonicalRoot, path.dirname(destination))), ...targetParts];
    }
    const resolved = this.walk(targetParts);
    fs.symlinkSync(target, destination, isDirFollow(resolved) ? 'dir' : 'file');
  }

  private deletionPlan(p: string, recursive: boolean): Array<[string, boolean]> {
    const st = FileHelper.entryMode(p);
    if (st.isSymbolicLink()) {
      if (!this.allowSymlinks) throw new SymlinkDeniedError(`Refusing to delete symlink: ${p}`);
      return [[p, false]];
    }
    if (st.isFile()) return [[p, false]];
    if (!st.isDirectory()) throw new UnsupportedPathError(`Unsupported filesystem object: ${p}`);
    const plan: Array<[string, boolean]> = [];
    if (recursive) {
      const children = fs
        .readdirSync(p)
        .map((n) => path.join(p, n))
        .sort();
      for (const child of children) plan.push(...this.deletionPlan(child, true));
    }
    plan.push([p, true]);
    return plan;
  }

  /** Delete an entry; recursive deletion never follows descendant links. */
  delete(p: string, opts: { recursive?: boolean } = {}): void {
    const destination = this.resolveOp(p, { followLeaf: false });
    if (destination === this.canonicalRoot) {
      throw new FileHelperError(`Refusing to delete the established root: ${this.root}`);
    }
    const plan = this.deletionPlan(destination, opts.recursive ?? false);
    for (const [entry, directory] of plan) {
      // Recheck accessed parents/leaf before each mutation, not just preflight.
      const checked = this.resolveOp(entry, { followLeaf: false });
      if (checked !== entry) throw new FileHelperError(`Destination changed during deletion: ${entry}`);
      if (directory) fs.rmdirSync(entry);
      else fs.unlinkSync(entry);
    }
  }
}
