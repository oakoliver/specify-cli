/**
 * @oakoliver/specify-cli - Workflow / Step Catalog Cache I/O
 *
 * Confined filesystem I/O shared by workflow and step catalog caches
 * (port of ``workflows/_catalog_cache.py``).
 *
 * ADAPTATION: upstream walks the cache directory with ``dir_fd``-relative
 * ``O_NOFOLLOW | O_DIRECTORY`` opens (POSIX) or pinned Windows handles, so a
 * swapped ancestor can never redirect a read or write. Node exposes no
 * ``openat``/``dir_fd`` API, so the port walks each component with
 * ``lstat`` (refusing symlinks and non-directories, creating missing ones on
 * write), re-checks the leaf, opens it with ``O_NOFOLLOW`` and verifies the
 * opened descriptor is a regular file. Writes go to an exclusive
 * ``O_EXCL | O_NOFOLLOW`` temporary in the same directory and are published
 * with ``rename`` (which replaces the directory entry, never the referent).
 * Errors are raised as Node ``OSError``-like errors with an errno ``code``.
 *
 * @module workflows/catalog-cache
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const O_NOFOLLOW = (fsConstants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const O_NONBLOCK = (fsConstants as unknown as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;

function cacheOsError(message: string, code: string, path?: string): NodeJS.ErrnoException {
  const e = new Error(path === undefined ? message : `[Errno] ${message}: '${path}'`) as NodeJS.ErrnoException;
  e.code = code;
  e.name = 'OSError';
  if (path !== undefined) e.path = path;
  return e;
}

/**
 * Walk ``directory`` (relative to ``root``) component by component, refusing
 * symlinked or non-directory components. Missing components are created when
 * ``create`` is true, otherwise ``ENOENT`` is raised. Returns the resolved
 * directory path.
 */
function cacheDirectory(root: string, directory: string, create: boolean): string {
  const rel = relative(root, directory);
  if (isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw cacheOsError('Catalog cache escapes project root', 'EINVAL');
  }
  let current = realpathSync(resolve(root));
  for (const part of rel === '' ? [] : rel.split(sep)) {
    if (!part) continue;
    current = join(current, part);
    let st;
    try {
      st = lstatSync(current);
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw exc;
      try {
        mkdirSync(current);
      } catch (mkExc) {
        if ((mkExc as NodeJS.ErrnoException).code !== 'EEXIST') throw mkExc;
      }
      st = lstatSync(current);
    }
    if (st.isSymbolicLink()) throw cacheOsError('Too many levels of symbolic links', 'ELOOP', current);
    if (!st.isDirectory()) throw cacheOsError('Not a directory', 'ENOTDIR', current);
  }
  return current;
}

/**
 * Read a regular cache leaf without following links or swapped ancestors
 * (``read_cache_json``). ``parse`` receives the decoded UTF-8 text and
 * defaults to ``JSON.parse`` (callers pass a duplicate-rejecting parser
 * where upstream passes ``object_pairs_hook``).
 */
export function readCacheJson(
  root: string,
  path: string,
  opts: { parse?: (text: string) => unknown } = {},
): unknown {
  const directory = cacheDirectory(root, dirname(path), false);
  const leaf = join(directory, basename(path));
  const fd = openSync(leaf, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  let bytes: Buffer;
  try {
    if (!fstatSync(fd).isFile()) {
      throw cacheOsError('Catalog cache leaf is not a regular file', 'EINVAL', leaf);
    }
    bytes = readFileSync(fd);
  } finally {
    closeSync(fd);
  }
  // UnicodeDecodeError -> TypeError (fatal decoder), JSONDecodeError -> SyntaxError.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return (opts.parse ?? JSON.parse)(text);
}

/**
 * Atomically replace a cache leaf, never truncating its previous inode
 * (``write_cache_json``). ``content`` is the already-serialized payload.
 */
export function writeCacheJson(root: string, path: string, content: string): void {
  const directory = cacheDirectory(root, dirname(path), true);
  const name = basename(path);
  const staged = join(directory, `.${name}.${randomBytes(16).toString('hex')}.tmp`);
  const destination = join(directory, name);
  const fd = openSync(
    staged,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      const payload = Buffer.from(content, 'utf-8');
      let off = 0;
      while (off < payload.length) off += writeSync(fd, payload, off);
    } finally {
      closeSync(fd);
    }
    renameSync(staged, destination);
  } finally {
    try {
      unlinkSync(staged);
    } catch {
      // Already renamed into place (FileNotFoundError) or best-effort cleanup.
    }
  }
}
