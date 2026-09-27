/**
 * @oakoliver/specify-cli - Python compatibility helpers for events/artifacts
 *
 * Small, dependency-free ports of the Python stdlib behaviors the events and
 * artifacts subsystems rely on for byte-identical output: ``json.dumps``
 * (separators, ``ensure_ascii``, ``sort_keys``), ``shlex.split`` /
 * ``shlex.quote``, ``repr()`` of simple values, and ``urllib.parse.quote`` /
 * ``unquote_to_bytes``.
 *
 * @module events/py-compat
 */

// ============================================================================
// json.dumps
// ============================================================================

export interface PyJsonDumpsOptions {
  /** Pretty-print indent (Python ``indent=``). Omit for compact Python style. */
  indent?: number;
  /** Escape non-ASCII as ``\uXXXX`` (Python default ``True``). */
  ensureAscii?: boolean;
  /** Sort object keys recursively (Python ``sort_keys=True``). */
  sortKeys?: boolean;
}

function escapeNonAscii(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0080-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

function pyString(value: string, ensureAscii: boolean): string {
  const s = JSON.stringify(value);
  return ensureAscii ? escapeNonAscii(s) : s;
}

function pyNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return JSON.stringify(value);
}

/**
 * Serialize *value* like Python's ``json.dumps``.
 *
 * Without ``indent`` the separators are ``', '`` / ``': '`` (Python default);
 * with ``indent`` they are ``','`` / ``': '``.
 */
export function pyJsonDumps(value: unknown, opts: PyJsonDumpsOptions = {}): string {
  const ensureAscii = opts.ensureAscii ?? true;
  const sortKeys = opts.sortKeys ?? false;
  const indent = opts.indent;

  const render = (v: unknown, level: number): string => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return pyNumber(v);
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string') return pyString(v, ensureAscii);
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      const items = v.map((item) => render(item, level + 1));
      if (indent === undefined) return '[' + items.join(', ') + ']';
      const pad = ' '.repeat(indent * (level + 1));
      const closePad = ' '.repeat(indent * level);
      return '[\n' + items.map((i) => pad + i).join(',\n') + '\n' + closePad + ']';
    }
    if (typeof v === 'object') {
      let keys = Object.keys(v as Record<string, unknown>).filter(
        (k) => (v as Record<string, unknown>)[k] !== undefined,
      );
      if (sortKeys) keys = [...keys].sort(compareCodePoints);
      if (keys.length === 0) return '{}';
      const items = keys.map(
        (k) => pyString(k, ensureAscii) + ': ' + render((v as Record<string, unknown>)[k], level + 1),
      );
      if (indent === undefined) return '{' + items.join(', ') + '}';
      const pad = ' '.repeat(indent * (level + 1));
      const closePad = ' '.repeat(indent * level);
      return '{\n' + items.map((i) => pad + i).join(',\n') + '\n' + closePad + '}';
    }
    return 'null';
  };
  return render(value, 0);
}

/** Compare strings by Unicode code point (Python ``sorted`` on ``str``). */
export function compareCodePoints(a: string, b: string): number {
  const ai = [...a];
  const bi = [...b];
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const ca = ai[i]!.codePointAt(0)!;
    const cb = bi[i]!.codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return ai.length === bi.length ? 0 : ai.length < bi.length ? -1 : 1;
}

// ============================================================================
// repr()
// ============================================================================

/** Render a value like Python's ``repr()`` for JSON/YAML-shaped data. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    if (Number.isNaN(value)) return 'nan';
    if (value === Infinity) return 'inf';
    if (value === -Infinity) return '-inf';
    return String(value);
  }
  if (typeof value === 'string') {
    const useDouble = value.includes("'") && !value.includes('"');
    const quote = useDouble ? '"' : "'";
    let out = '';
    for (const ch of value) {
      const code = ch.codePointAt(0)!;
      if (ch === '\\') out += '\\\\';
      else if (ch === quote) out += '\\' + quote;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
      else out += ch;
    }
    return quote + out + quote;
  }
  if (Array.isArray(value)) return '[' + value.map(pyRepr).join(', ') + ']';
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return '{' + entries.map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(', ') + '}';
  }
  return String(value);
}

/** Python ``type(value).__name__`` for JSON/YAML-shaped data. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Date) return 'datetime';
  if (typeof value === 'object') return 'dict';
  return typeof value;
}

/** Python ``isinstance(value, int) and not isinstance(value, bool)``. */
export function isPyInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Python ``isinstance(value, dict)`` for parsed JSON/YAML data. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

// ============================================================================
// shlex
// ============================================================================

/** Error mirroring ``ValueError`` raised by ``shlex.split``. */
export class ShlexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShlexError';
  }
}

const SHLEX_WHITESPACE = ' \t\r\n';

/**
 * Port of ``shlex.split(s, posix=...)`` (``comments=False``).
 *
 * POSIX mode strips quotes and processes backslash escapes; non-POSIX mode
 * keeps quote characters in the token and treats backslash literally.
 */
export function shlexSplit(s: string, posix = true): string[] {
  const tokens: string[] = [];
  let token = '';
  let inToken = false;
  let i = 0;
  const n = s.length;
  if (!posix) {
    // Non-POSIX: quotes are kept; a quoted section is part of a word.
    while (i < n) {
      const ch = s[i]!;
      if (SHLEX_WHITESPACE.includes(ch)) {
        if (inToken) {
          tokens.push(token);
          token = '';
          inToken = false;
        }
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const end = s.indexOf(ch, i + 1);
        if (end === -1) throw new ShlexError('No closing quotation');
        token += s.slice(i, end + 1);
        inToken = true;
        i = end + 1;
        continue;
      }
      token += ch;
      inToken = true;
      i++;
    }
    if (inToken) tokens.push(token);
    return tokens;
  }
  while (i < n) {
    const ch = s[i]!;
    if (SHLEX_WHITESPACE.includes(ch)) {
      if (inToken) {
        tokens.push(token);
        token = '';
        inToken = false;
      }
      i++;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= n) throw new ShlexError('No escaped character');
      token += s[i + 1];
      inToken = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) throw new ShlexError('No closing quotation');
      token += s.slice(i + 1, end);
      inToken = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      inToken = true;
      let closed = false;
      while (i < n) {
        const c = s[i]!;
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === '\\') {
          if (i + 1 >= n) throw new ShlexError('No closing quotation');
          const next = s[i + 1]!;
          if (next === '"' || next === '\\') {
            token += next;
          } else {
            token += c + next;
          }
          i += 2;
          continue;
        }
        token += c;
        i++;
      }
      if (!closed) throw new ShlexError('No closing quotation');
      continue;
    }
    token += ch;
    inToken = true;
    i++;
  }
  if (inToken) tokens.push(token);
  return tokens;
}

/** Port of ``shlex.quote``. */
export function shlexQuote(s: string): string {
  if (!s) return "''";
  if (!/[^\w@%+=:,./-]/.test(s)) return s;
  return "'" + s.replace(/'/g, `'"'"'`) + "'";
}

// ============================================================================
// urllib.parse
// ============================================================================

/** Port of ``urllib.parse.quote(value, safe="")``. */
export function urlQuote(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  let out = '';
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (/[A-Za-z0-9_.\-~]/.test(ch)) out += ch;
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Port of ``urllib.parse.unquote_to_bytes``. */
export function unquoteToBytes(value: string): Buffer {
  const src = Buffer.from(value, 'utf8');
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const b = src[i]!;
    if (b === 0x25 && i + 2 < src.length) {
      const hex = String.fromCharCode(src[i + 1]!, src[i + 2]!);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(b);
  }
  return Buffer.from(out);
}
