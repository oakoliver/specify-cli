/**
 * @oakoliver/specify-cli - Extension filesystem helpers
 *
 * ``shutil`` / ``pathlib`` / ``os`` equivalents used by the extension manager
 * (``copytree`` with an ignore callback, ``copy2``, ``rmtree``, lexical and
 * symlink-resolving path containment, fsync helpers).
 *
 * @module extensions/fs-utils
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** ``shutil.copytree`` ignore callback: ``(directory, entries) => ignored names``. */
export type IgnoreFn = (directory: string, entries: string[]) => Set<string>;

/** ``shutil.copy2``: copy file data and preserve mode + timestamps. */
export function copy2(src: string, dst: string): void {
  let target = dst;
  try {
    if (statSync(dst).isDirectory()) target = join(dst, basename(src));
  } catch {
    // dst does not exist
  }
  copyFileSync(src, target);
  try {
    const st = statSync(src);
    chmodSync(target, st.mode & 0o7777);
    utimesSync(target, st.atime, st.mtime);
  } catch {
    // best effort, like shutil.copystat
  }
}

/**
 * ``shutil.copytree(src, dst, ignore=..., symlinks=...)``. ``dst`` must not
 * exist (``dirs_exist_ok=False``).
 */
export function copytree(
  src: string,
  dst: string,
  opts: { ignore?: IgnoreFn | null; symlinks?: boolean } = {},
): void {
  const entries = readdirSync(src);
  const ignored = opts.ignore ? opts.ignore(src, entries) : new Set<string>();
  mkdirSync(dst, { recursive: true });
  const errors: string[] = [];
  for (const name of entries) {
    if (ignored.has(name)) continue;
    const s = join(src, name);
    const d = join(dst, name);
    try {
      const lst = lstatSync(s);
      if (lst.isSymbolicLink()) {
        if (opts.symlinks) {
          symlinkSync(readlinkSync(s), d);
          continue;
        }
        // Follow the link (shutil default).
        if (statSync(s).isDirectory()) {
          copytree(s, d, opts);
        } else {
          copy2(s, d);
        }
      } else if (lst.isDirectory()) {
        copytree(s, d, opts);
      } else {
        copy2(s, d);
      }
    } catch (err) {
      errors.push(`${s}: ${(err as Error).message}`);
    }
  }
  try {
    const st = statSync(src);
    chmodSync(dst, st.mode & 0o7777);
  } catch {
    // best effort
  }
  if (errors.length) throw new Error(errors.join('; '));
}

/** ``shutil.rmtree`` (raises on a symlink root, like CPython). */
export function rmtree(path: string, opts: { ignoreErrors?: boolean } = {}): void {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new Error(`Cannot call rmtree on a symbolic link: ${path}`);
    rmSync(path, { recursive: true, force: false });
  } catch (err) {
    if (!opts.ignoreErrors) throw err;
  }
}

/** ``Path.unlink(missing_ok=...)``. */
export function unlink(path: string, missingOk = false): void {
  try {
    rmSync(path, { force: false });
  } catch (err) {
    if (missingOk && (err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

/** Lexical containment check (``PurePath.is_relative_to``). */
export function isRelativeTo(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..');
}

/**
 * ``Path.resolve(strict=False)``: resolve symlinks in the longest existing
 * prefix, then append the remaining components lexically.
 */
export function resolveStrictFalse(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(resolveStrictFalse(parent), basename(abs));
  }
}

/** ``Path.resolve()`` equality used for same-location checks. */
export function samePath(a: string, b: string): boolean {
  return resolveStrictFalse(a) === resolveStrictFalse(b);
}

/** Top-level entries of ``dir`` whose names end with ``suffix`` (``Path.glob('*suffix')``). */
export function globSuffix(dir: string, suffix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.') && n.endsWith(suffix) && n.length > suffix.length - 1)
    .sort()
    .map((n) => join(dir, n));
}

/** Recursively list files under ``root`` (``Path.rglob('*')``). */
export function rglob(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      out.push(full);
      try {
        const st = lstatSync(full);
        if (st.isDirectory()) walk(full);
      } catch {
        // ignore
      }
    }
  };
  walk(root);
  return out;
}

const FSYNC_IGNORED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EINVAL', 'EBADF', 'EISDIR', 'EPERM']);

/** Sync a file descriptor, ignoring "unsupported" errors. */
export function fsyncFd(fd: number): void {
  try {
    fsyncSync(fd);
  } catch (err) {
    if (FSYNC_IGNORED.has((err as NodeJS.ErrnoException).code ?? '')) return;
    throw err;
  }
}

/** Sync a directory when the platform supports it. */
export function fsyncDirectory(path: string): void {
  try {
    statSync(path);
  } catch {
    return;
  }
  if (process.platform === 'win32') return;
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    if (FSYNC_IGNORED.has((err as NodeJS.ErrnoException).code ?? '')) return;
    throw err;
  }
  try {
    fsyncFd(fd);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
  }
}

/** ``tempfile.TemporaryDirectory`` helper: run ``fn`` with a temp dir, then remove it. */
export function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Async variant of {@link withTempDir}. */
export async function withTempDirAsync<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
