/**
 * @oakoliver/specify-cli - Bundle YAML/JSON IO
 *
 * YAML/JSON read-write helpers with path confinement. All reads/writes go
 * through these functions so that IO failures degrade into actionable
 * {@link BundlerError}s rather than raw stack traces, and every path can be
 * confined to an allowed root via {@link ensureWithin}.
 *
 * Port of ``specify_cli/bundles/yamlio.py``.
 *
 * @module bundles/yamlio
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  fchmodSync,
  fchownSync,
} from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import { parseYaml, dumpYaml as yamlDump, yamlHasNode, YAMLError } from '../yaml.js';
import { BundlerError } from './index.js';
import { pyJsonDumps, resolvePath } from './pycompat.js';

// ============================================================================
// Helpers
// ============================================================================

function errText(exc: unknown): string {
  if (exc instanceof Error) {
    const code = (exc as NodeJS.ErrnoException).code;
    const errno = (exc as NodeJS.ErrnoException).errno;
    if (code && typeof errno === 'number') {
      const detail = exc.message.replace(/^[A-Z]+:\s*/, '').split(',')[0];
      return `[Errno ${Math.abs(errno)}] ${detail}`;
    }
    return exc.message;
  }
  return String(exc);
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Read *p* and decode strictly as UTF-8 (throws on invalid bytes, like Python). */
export function readTextUtf8(p: string): string {
  const raw = readFileSync(p);
  try {
    return utf8Strict.decode(raw);
  } catch {
    const idx = findInvalidUtf8(raw);
    throw new UnicodeDecodeError(
      `'utf-8' codec can't decode byte 0x${raw[idx].toString(16).padStart(2, '0')} in position ${idx}: invalid start byte`,
    );
  }
}

/** Decode *raw* strictly as UTF-8. */
export function decodeUtf8(raw: Uint8Array): string {
  try {
    return utf8Strict.decode(raw);
  } catch {
    const idx = findInvalidUtf8(raw);
    throw new UnicodeDecodeError(
      `'utf-8' codec can't decode byte 0x${raw[idx].toString(16).padStart(2, '0')} in position ${idx}: invalid start byte`,
    );
  }
}

function findInvalidUtf8(raw: Uint8Array): number {
  for (let i = 0; i < raw.length; i++) {
    try {
      utf8Strict.decode(raw.subarray(0, i + 1));
    } catch {
      // A truncated multibyte prefix also throws; keep scanning until a
      // lead byte proves invalid.
      const b = raw[i];
      if (b >= 0x80 && (b < 0xc2 || b > 0xf4)) return i;
    }
  }
  return 0;
}

/** Python ``UnicodeDecodeError`` stand-in. */
export class UnicodeDecodeError extends Error {
  override name = 'UnicodeDecodeError';
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve *candidate* and guarantee it stays within *root*.
 *
 * Refuses path-traversal payloads and symlink escapes. Returns the resolved,
 * confined path. Throws {@link BundlerError} if the path escapes *root*.
 */
export function ensureWithin(root: string, candidate: string): string {
  const rootResolved = resolvePath(root);
  const candidateResolved = resolvePath(candidate);
  const rel = path.relative(rootResolved, candidateResolved);
  if (rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel))) {
    return candidateResolved;
  }
  throw new BundlerError(`Refusing path '${candidate}' — it escapes the allowed root '${root}'.`);
}

/**
 * Parse a YAML file, returning ``{}`` only for an *empty* document. A non-empty
 * document is returned exactly as parsed — including a non-mapping or an
 * explicit null — so callers can validate the top-level shape.
 */
export function loadYaml(p: string): unknown {
  if (!existsSync(p)) throw new BundlerError(`File not found: ${p}`);
  let text: string;
  try {
    text = readTextUtf8(p);
  } catch (exc) {
    throw new BundlerError(`Could not read ${p}: ${errText(exc)}`, { cause: exc });
  }
  let data: unknown;
  let hasNode: boolean;
  try {
    hasNode = yamlHasNode(text);
    data = parseYaml(text);
  } catch (exc) {
    if (exc instanceof YAMLError) {
      throw new BundlerError(`Invalid YAML in ${p}: ${exc.message}`, { cause: exc });
    }
    throw exc;
  }
  if ((data === null || data === undefined) && !hasNode) return {};
  return data ?? null;
}

/** Write *data* as YAML to *p* (optionally confined to *within*). */
export function dumpYaml(p: string, data: unknown, opts: { within?: string } = {}): string {
  let target = p;
  if (opts.within !== undefined) target = ensureWithin(opts.within, target);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const text = yamlDump(data, { sortKeys: false, defaultFlowStyle: false, allowUnicode: true });
    const fd = openSync(target, 'w');
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  } catch (exc) {
    if (exc instanceof BundlerError) throw exc;
    throw new BundlerError(`Could not write ${target}: ${errText(exc)}`, { cause: exc });
  }
  return target;
}

/** Parse a JSON file. */
export function loadJson(p: string): unknown {
  if (!existsSync(p)) throw new BundlerError(`File not found: ${p}`);
  let text: string;
  try {
    text = readTextUtf8(p);
  } catch (exc) {
    throw new BundlerError(`Could not read ${p}: ${errText(exc)}`, { cause: exc });
  }
  try {
    return JSON.parse(text);
  } catch (exc) {
    throw new BundlerError(`Invalid JSON in ${p}: ${errText(exc)}`, { cause: exc });
  }
}

/** Parse JSON from a string (used for catalog payloads fetched as text). */
export function loadsJson(text: string, opts: { origin?: string } = {}): unknown {
  try {
    return JSON.parse(text);
  } catch (exc) {
    throw new BundlerError(`Invalid JSON from ${opts.origin ?? '<string>'}: ${errText(exc)}`, {
      cause: exc,
    });
  }
}

/** Atomically write pretty JSON to *p* (optionally confined to *within*). */
export function dumpJson(p: string, data: unknown, opts: { within?: string } = {}): string {
  let target = p;
  if (opts.within !== undefined) target = ensureWithin(opts.within, target);
  let fd = -1;
  let tempPath: string | null = null;
  try {
    const dir = path.dirname(target);
    mkdirSync(dir, { recursive: true });
    tempPath = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
    fd = openSync(tempPath, 'wx', 0o600);
    writeSync(fd, pyJsonDumps(data) + '\n');
    try {
      if (existsSync(target)) {
        const existing = lstatSync(target);
        if (existing.isFile()) {
          fchmodSync(fd, existing.mode & 0o7777);
          try {
            fchownSync(fd, existing.uid, existing.gid);
          } catch {
            // PermissionError: keep default ownership.
          }
        }
      }
    } catch {
      // best effort
    }
    const staged = lstatSync(tempPath);
    const opened = fstatSync(fd);
    if (!staged.isFile() || staged.dev !== opened.dev || staged.ino !== opened.ino) {
      throw new Error('staged JSON file changed before commit');
    }
    try {
      fsyncSync(fd);
    } catch {
      // not fatal
    }
    closeSync(fd);
    fd = -1;
    renameSync(tempPath, target);
    tempPath = null;
  } catch (exc) {
    if (exc instanceof BundlerError) throw exc;
    throw new BundlerError(`Could not write ${target}: ${errText(exc)}`, { cause: exc });
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    if (tempPath !== null) {
      try {
        unlinkSync(tempPath);
      } catch {
        // ignore
      }
    }
  }
  return target;
}

/**
 * Return true if *rel* is a project-relative path with no traversal/absolute
 * parts. Platform-independent: POSIX-absolute and Windows drive-absolute paths
 * are rejected on every OS.
 */
export function isSafeRelpath(rel: string): boolean {
  if (!rel) return false;
  const normalized = rel.replace(/\\/g, '/');
  if (path.isAbsolute(rel) || normalized.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  const parts = normalized.split('/').filter((p) => p !== '' && p !== '.');
  return !parts.includes('..');
}
