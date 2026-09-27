/**
 * @oakoliver/specify-cli - Extension Python-compat helpers
 *
 * Small helpers that reproduce Python semantics the extensions package relies
 * on (strict UTF-8 decoding with byte offsets, ``int()`` coercion,
 * ``datetime.isoformat()``, ``str.title()``), so user-facing messages and
 * on-disk data stay byte-identical with upstream spec-kit.
 *
 * @module extensions/compat
 */

import { readFileSync, lstatSync, statSync } from 'node:fs';

// ============================================================================
// Strict UTF-8 decoding (Python ``bytes.decode('utf-8')``)
// ============================================================================

/** Python ``UnicodeDecodeError`` (``reason`` + ``start`` byte offset). */
export class UnicodeDecodeError extends Error {
  readonly reason: string;
  readonly start: number;

  constructor(reason: string, start: number) {
    super(`'utf-8' codec can't decode byte at position ${start}: ${reason}`);
    this.name = 'UnicodeDecodeError';
    this.reason = reason;
    this.start = start;
  }
}

/**
 * Locate the first invalid UTF-8 sequence the way CPython reports it.
 * Returns ``null`` when the buffer is valid UTF-8.
 */
export function findUtf8Error(buf: Uint8Array): { reason: string; start: number } | null {
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) {
      i += 1;
      continue;
    }
    let need = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b === 0xe0) { need = 2; lo = 0xa0; }
    else if (b >= 0xe1 && b <= 0xec) need = 2;
    else if (b === 0xed) { need = 2; hi = 0x9f; }
    else if (b >= 0xee && b <= 0xef) need = 2;
    else if (b === 0xf0) { need = 3; lo = 0x90; }
    else if (b >= 0xf1 && b <= 0xf3) need = 3;
    else if (b === 0xf4) { need = 3; hi = 0x8f; }
    else return { reason: 'invalid start byte', start: i };

    for (let k = 1; k <= need; k++) {
      if (i + k >= n) return { reason: 'unexpected end of data', start: i };
      const c = buf[i + k];
      const min = k === 1 ? lo : 0x80;
      const max = k === 1 ? hi : 0xbf;
      if (c < min || c > max) return { reason: 'invalid continuation byte', start: i };
    }
    i += need + 1;
  }
  return null;
}

/** Decode bytes as strict UTF-8, throwing {@link UnicodeDecodeError}. */
export function decodeUtf8Strict(buf: Uint8Array): string {
  const err = findUtf8Error(buf);
  if (err) throw new UnicodeDecodeError(err.reason, err.start);
  const text = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('utf-8');
  // Python's utf-8 codec keeps a BOM as U+FEFF; so does Buffer.toString.
  return text;
}

/** ``Path.read_text(encoding="utf-8")`` with Python's strict decoding. */
export function readTextUtf8(path: string): string {
  return decodeUtf8Strict(readFileSync(path));
}

// ============================================================================
// Python ``int()`` and friends
// ============================================================================

/**
 * Python ``int(value)`` for JSON/YAML-shaped values. Returns ``null`` where
 * Python would raise ``TypeError`` / ``ValueError`` / ``OverflowError``.
 */
export function pyInt(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const m = /^\s*([+-]?)(\d+(?:_\d+)*)\s*$/.exec(value);
    if (!m) return null;
    const n = Number.parseInt(m[2].replace(/_/g, ''), 10);
    return m[1] === '-' ? -n : n;
  }
  return null;
}

/** True for a Python ``int`` that is not a ``bool``. */
export function isPyInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** ``datetime.now(timezone.utc).isoformat()``. */
export function utcNowIsoformat(date: Date = new Date()): string {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  const base = iso.slice(0, 19);
  const ms = date.getUTCMilliseconds();
  const micros = String(ms * 1000).padStart(6, '0');
  return `${base}.${micros}+00:00`;
}

/**
 * Parse ``datetime.fromisoformat`` output. Returns ``null`` when invalid.
 * Naive timestamps are treated as UTC (mirrors upstream's ``replace(tzinfo=utc)``).
 */
export function parseIsoformat(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:?\d{2}(?::?\d{2})?)?$/.exec(
    value,
  );
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = '', tz] = m;
  const ms = frac ? Math.floor(Number.parseInt(frac.padEnd(6, '0'), 10) / 1000) : 0;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (Number.isNaN(t)) return null;
  if (tz && tz !== 'Z') {
    const tm = /^([+-])(\d{2}):?(\d{2})/.exec(tz);
    if (tm) {
      const off = (Number(tm[2]) * 60 + Number(tm[3])) * 60_000;
      t -= tm[1] === '+' ? off : -off;
    }
  }
  return new Date(t);
}

/** Python ``str.title()``. */
export function pyTitle(value: string): string {
  let out = '';
  let prevCased = false;
  for (const ch of value) {
    const isLetter = ch.toLowerCase() !== ch.toUpperCase();
    if (isLetter) {
      out += prevCased ? ch.toLowerCase() : ch.toUpperCase();
      prevCased = true;
    } else {
      out += ch;
      prevCased = false;
    }
  }
  return out;
}

/** Python ``str.capitalize()``. */
export function pyCapitalize(value: string): string {
  if (!value) return value;
  return value[0].toUpperCase() + value.slice(1).toLowerCase();
}

// ============================================================================
// Filesystem predicates (pathlib semantics)
// ============================================================================

/** ``Path.is_symlink()``. */
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** ``Path.is_file()`` (follows symlinks). */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** ``Path.is_dir()`` (follows symlinks). */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** ``Path.exists()`` (follows symlinks). */
export function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** ``os.path.lexists``. */
export function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Error message like Python's ``str(OSError)`` (``[Errno N] msg: 'path'``). */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ============================================================================
// Structural equality (Python ``==`` on JSON/YAML-shaped values)
// ============================================================================

/** Deep equality with Python semantics for dict/list/scalar values. */
export function pyEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    // Python: True == 1, False == 0.
    const na = typeof a === 'boolean' ? Number(a) : a;
    const nb = typeof b === 'boolean' ? Number(b) : b;
    return na === nb;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => pyEquals(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    if (a instanceof Date || b instanceof Date) {
      return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    }
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!pyEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
  }
  return false;
}
