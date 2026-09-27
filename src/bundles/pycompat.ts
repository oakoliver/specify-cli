/**
 * @oakoliver/specify-cli - Bundler Python-compat helpers
 *
 * Small helpers that reproduce the Python semantics the upstream bundler relies
 * on for user-facing text (``str()``, ``repr()``, ``type().__name__``,
 * ``json.dumps(indent=2)``), ``urllib.parse.urlparse`` field extraction, and
 * ``pathlib.Path.resolve()`` (non-strict) so error messages and path handling
 * stay 1:1 with ``specify_cli.bundles``.
 *
 * @module bundles/pycompat
 */

import { existsSync, realpathSync } from 'node:fs';
import { isIPv6 } from 'node:net';
import * as path from 'node:path';

// ============================================================================
// str() / repr() / type name
// ============================================================================

function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (Number.isInteger(value)) {
    // JS cannot tell 1 from 1.0 once parsed; integers render as Python ints.
    return Math.abs(value) >= 1e16 ? String(value).replace('e+', 'e+') : String(value);
  }
  const text = String(value);
  return text;
}

/** Python ``repr()`` of a string. */
export function pyStrRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + quote;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + quote;
}

/** Python ``repr()`` for JSON/YAML-shaped values. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pyFloatRepr(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return pyStrRepr(value);
  if (value instanceof Date) return `datetime.datetime(${value.toISOString()})`;
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${pyStrRepr(k)}: ${pyRepr(v)}`,
    );
    return `{${parts.join(', ')}}`;
  }
  return String(value);
}

/** Python ``str()`` for JSON/YAML-shaped values. */
export function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) {
    // PyYAML resolves timestamps to datetime/date; str() uses ISO-ish text.
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace('.000Z', '+00:00');
  }
  return pyRepr(value);
}

/** Python ``type(value).__name__``. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'string') return 'str';
  if (value instanceof Date) return 'datetime';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Uint8Array) return 'bytes';
  if (typeof value === 'object') return 'dict';
  return typeof value;
}

/** Python truthiness. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value as object).length > 0;
  }
  return true;
}

/** True for a plain mapping (Python ``isinstance(x, dict)``). */
export function isMapping(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  );
}

/** ``dict.get`` that ignores inherited properties. */
export function dget(data: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : undefined;
}

/**
 * ``json.dumps(value, indent=2)`` — including the default ``ensure_ascii=True``
 * escaping of non-ASCII characters.
 */
export function pyJsonDumps(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return text.replace(/[\u0080-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

// ============================================================================
// urllib.parse.urlparse (subset)
// ============================================================================

export interface ParsedUrl {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;

/** ``urllib.parse.urlparse`` (scheme/netloc/path/query/fragment). Throws on invalid IPv6. */
export function urlparse(url: string): ParsedUrl {
  let rest = url;
  let scheme = '';
  const colon = rest.indexOf(':');
  if (colon > 0 && /^[A-Za-z]/.test(rest[0]) && SCHEME_CHARS.test(rest.slice(0, colon))) {
    scheme = rest.slice(0, colon).toLowerCase();
    rest = rest.slice(colon + 1);
  }
  let netloc = '';
  if (rest.startsWith('//')) {
    const after = rest.slice(2);
    let end = after.length;
    for (const delim of ['/', '?', '#']) {
      const idx = after.indexOf(delim);
      if (idx >= 0 && idx < end) end = idx;
    }
    netloc = after.slice(0, end);
    rest = after.slice(end);
    if ((netloc.includes('[') && !netloc.includes(']')) || (netloc.includes(']') && !netloc.includes('['))) {
      throw new TypeError('Invalid IPv6 URL');
    }
    if (netloc.includes('[')) {
      const bracketed = netloc.slice(netloc.indexOf('[') + 1, netloc.indexOf(']'));
      if (!(bracketed.startsWith('v') || bracketed.startsWith('V')) && !isIPv6(bracketed.split('%')[0])) {
        throw new TypeError(`'${bracketed}' does not appear to be an IPv4 or IPv6 address`);
      }
    }
  }
  let fragment = '';
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  let query = '';
  const q = rest.indexOf('?');
  if (q >= 0) {
    query = rest.slice(q + 1);
    rest = rest.slice(0, q);
  }
  return { scheme, netloc, path: rest, query, fragment };
}

function hostinfo(netloc: string): [string, string | null] {
  const at = netloc.lastIndexOf('@');
  const hostport = at >= 0 ? netloc.slice(at + 1) : netloc;
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']');
    const host = hostport.slice(1, close);
    const after = hostport.slice(close + 1);
    return [host, after.startsWith(':') ? after.slice(1) : null];
  }
  const idx = hostport.indexOf(':');
  if (idx >= 0) return [hostport.slice(0, idx), hostport.slice(idx + 1)];
  return [hostport, null];
}

/** ``ParseResult.hostname`` (lowercased; ``null`` when empty). */
export function urlHostname(parsed: ParsedUrl): string | null {
  const [host] = hostinfo(parsed.netloc);
  if (!host) return null;
  return host.toLowerCase();
}

/** ``ParseResult.port`` — throws ``TypeError`` (Python ``ValueError``) when invalid. */
export function urlPort(parsed: ParsedUrl): number | null {
  const [, port] = hostinfo(parsed.netloc);
  if (port === null || port === '') return null;
  if (!/^[0-9]+$/.test(port)) {
    throw new TypeError(`Port could not be cast to integer value as ${pyStrRepr(port)}`);
  }
  const value = Number.parseInt(port, 10);
  if (!(value >= 0 && value <= 65535)) throw new TypeError('Port out of range 0-65535');
  return value;
}

// ============================================================================
// pathlib helpers
// ============================================================================

/** ``Path(p).resolve()`` (non-strict): follow symlinks of the existing prefix. */
export function resolvePath(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let current = abs;
  for (;;) {
    if (existsSync(current)) {
      let real: string;
      try {
        real = realpathSync(current);
      } catch {
        real = current;
      }
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    }
    const parent = path.dirname(current);
    if (parent === current) return abs;
    tail.push(path.basename(current));
    current = parent;
  }
}

/** ``PurePath.suffix``. */
export function pathSuffix(p: string): string {
  const name = path.basename(p);
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return '';
  return name.slice(idx);
}

/** ``PurePath.stem``. */
export function pathStem(p: string): string {
  const name = path.basename(p);
  const suffix = pathSuffix(name);
  return suffix ? name.slice(0, -suffix.length) : name;
}

/** ``Path.expanduser()``. */
export function expandUser(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}
