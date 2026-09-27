/**
 * @oakoliver/specify-cli - Python compatibility helpers
 *
 * Tiny helpers that reproduce Python's ``repr()`` and ``type(x).__name__``
 * for values parsed from YAML/JSON, so user-facing error messages match the
 * upstream Python CLI byte-for-byte (e.g. ``'foo'``, ``None``, ``True``,
 * ``{'a': 1}``).
 *
 * @module workflows/overlay/py-compat
 */

import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isIPv6 } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve as pathResolve, sep } from 'node:path';

// ============================================================================
// repr
// ============================================================================

/** Python ``repr()`` of a string (quote selection + escapes like CPython). */
export function pyStrRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === quote || ch === '\\') {
      out += '\\' + ch;
    } else if (ch === '\n') {
      out += '\\n';
    } else if (ch === '\r') {
      out += '\\r';
    } else if (ch === '\t') {
      out += '\\t';
    } else if (code < 0x20 || code === 0x7f) {
      out += '\\x' + code.toString(16).padStart(2, '0');
    } else if (code >= 0x80 && code < 0xa0) {
      out += '\\x' + code.toString(16).padStart(2, '0');
    } else {
      out += ch;
    }
  }
  return out + quote;
}

/** Python ``repr()`` for JSON/YAML-shaped values. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (value === Infinity) return 'inf';
    if (value === -Infinity) return '-inf';
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return pyStrRepr(value);
  if (value instanceof Date) return `datetime.date(${value.getUTCFullYear()}, ${value.getUTCMonth() + 1}, ${value.getUTCDate()})`;
  if (Array.isArray(value)) return '[' + value.map((v) => pyRepr(v)).join(', ') + ']';
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return '{' + entries.map(([k, v]) => `${pyStrRepr(k)}: ${pyRepr(v)}`).join(', ') + '}';
  }
  return String(value);
}

/** Python ``type(value).__name__`` for JSON/YAML-shaped values. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Date) return 'date';
  if (typeof value === 'object') return 'dict';
  return typeof value;
}

/** True when *value* is a plain mapping (Python ``isinstance(x, dict)``). */
export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Python ``int(value)`` for YAML/JSON-shaped values. Returns ``null`` where
 * Python would raise ``TypeError``/``ValueError``/``OverflowError``.
 */
export function pyInt(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
  }
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const s = value.trim().replace(/_/g, (m, off: number, str: string) =>
      off > 0 && off < str.length - 1 && /\d/.test(str[off - 1]) && /\d/.test(str[off + 1]) ? '' : m,
    );
    if (!/^[+-]?\d+$/.test(s)) return null;
    return parseInt(s, 10);
  }
  return null;
}

/** Python ``bool(value)`` truthiness for YAML/JSON-shaped values. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Date) return true;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return Boolean(value);
}

/** Python ``str(value)`` for YAML/JSON-shaped values. */
export function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pyRepr(value);
  if (Array.isArray(value) || (typeof value === 'object' && !(value instanceof Date))) return pyRepr(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/** Deep-copy a JSON/YAML-shaped value (``copy.deepcopy``). */
export function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepCopy(v)) as unknown as T;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepCopy(v);
    return out as T;
  }
  return value;
}

// ============================================================================
// Filesystem helpers (pathlib semantics)
// ============================================================================

/** ``Path.is_symlink()`` */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** ``Path.exists()`` (follows symlinks). */
export function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** ``os.path.lexists()`` */
export function pathLexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** ``Path.is_dir()`` (follows symlinks). */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** ``Path.is_file()`` (follows symlinks). */
export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * ``Path.resolve()`` (non-strict): canonicalize the longest existing prefix
 * through ``realpath`` and append the remaining, not-yet-existing segments.
 */
export function resolvePath(p: string): string {
  const abs = pathResolve(p);
  const tail: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return abs;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** ``Path.relative_to()`` check: true when *child* is *root* or inside it. */
export function isRelativeTo(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Parts of *child* relative to *root* (``relative_to(...).parts``), or null. */
export function relativeParts(child: string, root: string): string[] | null {
  if (!isRelativeTo(child, root)) return null;
  const rel = relative(root, child);
  return rel === '' ? [] : rel.split(sep);
}

/** Python ``str(OSError)`` style message for a Node fs error. */
export function osErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const e = err as NodeJS.ErrnoException;
    const errnoNum = typeof e.errno === 'number' ? Math.abs(e.errno) : undefined;
    const desc = e.message.replace(/^[A-Z]+: /, '').replace(/, [a-z]+ '.*$/, '');
    if (errnoNum !== undefined && e.path) return `[Errno ${errnoNum}] ${desc}: '${e.path}'`;
    return e.message;
  }
  return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// urllib.parse.urlparse subset
// ============================================================================

/** Result of ``pyUrlParse`` (subset of ``urllib.parse.ParseResult``). */
export interface PyParsedUrl {
  scheme: string;
  netloc: string;
  path: string;
  hostname: string | null;
  port: number | null;
}

/**
 * Parse *url* like ``urllib.parse.urlparse`` and eagerly evaluate
 * ``.hostname`` / ``.port``. Throws (Python ``ValueError``) where accessing
 * those attributes would raise: unbalanced IPv6 brackets or a non-numeric /
 * out-of-range port.
 */
export function pyUrlParse(url: string): PyParsedUrl {
  let rest = url;
  let scheme = '';
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(rest);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }
  let netloc = '';
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
    const end = rest.search(/[/?#]/);
    netloc = end === -1 ? rest : rest.slice(0, end);
    rest = end === -1 ? '' : rest.slice(end);
    if ((netloc.includes('[') && !netloc.includes(']')) || (netloc.includes(']') && !netloc.includes('['))) {
      throw new Error('Invalid IPv6 URL');
    }
    if (netloc.includes('[')) {
      // urllib's _check_bracketed_netloc: the bracketed host must be IPv6 or IPvFuture.
      const bracketed = netloc.slice(netloc.indexOf('[') + 1, netloc.indexOf(']'));
      if (bracketed.startsWith('v')) {
        if (!/^v[a-fA-F0-9]+\..+$/.test(bracketed)) throw new Error('IPvFuture address is invalid');
      } else if (!isIPv6(bracketed.split('%')[0])) {
        throw new Error(`'${bracketed}' does not appear to be an IPv4 or IPv6 address`);
      }
    }
  }
  const pathEnd = rest.search(/[?#]/);
  const path = pathEnd === -1 ? rest : rest.slice(0, pathEnd);

  const hostPort = netloc.includes('@') ? netloc.slice(netloc.lastIndexOf('@') + 1) : netloc;
  let host: string;
  let portStr: string | null = null;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    host = hostPort.slice(1, close);
    const after = hostPort.slice(close + 1);
    if (after.startsWith(':')) portStr = after.slice(1);
  } else {
    const colon = hostPort.lastIndexOf(':');
    if (colon !== -1) {
      host = hostPort.slice(0, colon);
      portStr = hostPort.slice(colon + 1);
    } else {
      host = hostPort;
    }
  }
  let port: number | null = null;
  if (portStr !== null && portStr !== '') {
    if (!/^\d+$/.test(portStr)) throw new Error(`Port could not be cast to integer value as '${portStr}'`);
    port = parseInt(portStr, 10);
    if (port < 0 || port > 65535) throw new Error('Port out of range 0-65535');
  }
  return { scheme, netloc, path, hostname: host ? host.toLowerCase() : null, port };
}

// ============================================================================
// Misc
// ============================================================================

/** ``datetime.now(timezone.utc).isoformat()`` */
export function utcIsoNow(): string {
  const d = new Date();
  const base = d.toISOString().slice(0, 19);
  const micros = String(d.getUTCMilliseconds() * 1000).padStart(6, '0');
  return `${base}.${micros}+00:00`;
}

/** ``Path.home()``: ``$HOME`` (``%USERPROFILE%`` on Windows) when set, else the OS lookup. */
export function pyHome(): string {
  const env = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  return env && env.length > 0 ? env : homedir();
}
