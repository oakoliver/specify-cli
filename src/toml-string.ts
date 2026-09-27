/**
 * @oakoliver/specify-cli - TOML string helpers
 *
 * Port of upstream `_toml_string.py` (shared TOML string-escaping rules used by
 * the TOML command renderers), plus a minimal `parseToml()` able to read the
 * TOML this port writes (tables, dotted/quoted keys, basic/literal/multiline
 * strings, numbers, booleans, arrays, inline tables) and `dumpTomlString()`.
 *
 * @module toml-string
 */

// ============================================================================
// Escaping (port of _toml_string.py)
// ============================================================================

/**
 * True when `value` contains a character TOML forbids literally: control chars
 * other than tab/newline (U+0000-U+001F, U+007F) and any bare CR not part of CRLF.
 */
export function hasIllegalTomlControl(value: string): boolean {
  const length = value.length;
  for (let i = 0; i < length; i++) {
    const ch = value[i];
    const code = ch.charCodeAt(0);
    if (ch === '\r') {
      if (i + 1 < length && value[i + 1] === '\n') continue;
      return true;
    }
    if ((code < 0x20 && ch !== '\t' && ch !== '\n') || code === 0x7f) return true;
  }
  return false;
}

/** Render `value` as a single-line TOML basic string, escaping everything. */
export function escapeTomlBasic(value: string): string {
  const out: string[] = [];
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out.push('\\\\');
    else if (ch === '"') out.push('\\"');
    else if (ch === '\n') out.push('\\n');
    else if (ch === '\r') out.push('\\r');
    else if (ch === '\t') out.push('\\t');
    else if (code < 0x20 || code === 0x7f) out.push(`\\u${code.toString(16).padStart(4, '0')}`);
    else out.push(ch);
  }
  return '"' + out.join('') + '"';
}

// ============================================================================
// Minimal TOML parser
// ============================================================================

/** Error raised by {@link parseToml} (Python `tomllib.TOMLDecodeError`). */
export class TOMLDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TOMLDecodeError';
  }
}

type TomlTable = Record<string, unknown>;

/** Parse TOML text into a plain object (TOML 1.0 subset; datetimes kept as strings). */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  let i = 0;
  const n = text.length;
  let line = 1;
  const fail = (msg: string): never => {
    throw new TOMLDecodeError(`${msg} (at line ${line})`);
  };
  const skipWs = (): void => {
    while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  };
  const skipComment = (): void => {
    if (text[i] === '#') while (i < n && text[i] !== '\n') i++;
  };
  const skipWsNl = (): void => {
    for (;;) {
      skipWs();
      skipComment();
      if (text[i] === '\n') {
        line++;
        i++;
      } else if (text[i] === '\r' && text[i + 1] === '\n') {
        line++;
        i += 2;
      } else break;
    }
  };
  const expectEol = (): void => {
    skipWs();
    skipComment();
    if (i < n && text[i] !== '\n' && !(text[i] === '\r' && text[i + 1] === '\n')) fail('Expected newline or end of document');
  };
  const parseEscape = (): string => {
    const e = text[i++];
    const map: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' };
    if (e in map) return map[e];
    if (e === 'u' || e === 'U') {
      const len = e === 'u' ? 4 : 8;
      const hex = text.slice(i, i + len);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) fail('Invalid unicode escape');
      i += len;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    return fail(`Invalid escape "\\${e}"`);
  };
  const parseString = (): string => {
    if (text.startsWith('"""', i)) {
      i += 3;
      if (text[i] === '\n') {
        i++;
        line++;
      } else if (text.startsWith('\r\n', i)) {
        i += 2;
        line++;
      }
      let out = '';
      for (;;) {
        if (i >= n) fail('Unterminated multiline string');
        if (text.startsWith('"""', i)) {
          let q = 3;
          while (text[i + q] === '"' && q < 5) q++;
          out += '"'.repeat(q - 3);
          i += q;
          return out;
        }
        const c = text[i++];
        if (c === '\\') {
          if (/^[ \t]*\r?\n/.test(text.slice(i))) {
            while (i < n && /[ \t\r\n]/.test(text[i])) {
              if (text[i] === '\n') line++;
              i++;
            }
          } else out += parseEscape();
        } else {
          if (c === '\n') line++;
          out += c;
        }
      }
    }
    if (text.startsWith("'''", i)) {
      i += 3;
      if (text[i] === '\n') {
        i++;
        line++;
      } else if (text.startsWith('\r\n', i)) {
        i += 2;
        line++;
      }
      const end = text.indexOf("'''", i);
      if (end < 0) fail('Unterminated multiline literal string');
      let stop = end + 3;
      while (text[stop] === "'" && stop - end < 5) stop++;
      const out = text.slice(i, stop - 3);
      line += (out.match(/\n/g) ?? []).length;
      i = stop;
      return out;
    }
    if (text[i] === '"') {
      i++;
      let out = '';
      for (;;) {
        if (i >= n || text[i] === '\n') fail('Unterminated string');
        const c = text[i++];
        if (c === '"') return out;
        if (c === '\\') out += parseEscape();
        else out += c;
      }
    }
    if (text[i] === "'") {
      i++;
      const end = text.indexOf("'", i);
      const nl = text.indexOf('\n', i);
      if (end < 0 || (nl >= 0 && nl < end)) fail('Unterminated literal string');
      const out = text.slice(i, end);
      i = end + 1;
      return out;
    }
    return fail('Expected string');
  };
  const parseKey = (): string[] => {
    const parts: string[] = [];
    for (;;) {
      skipWs();
      if (text[i] === '"' || text[i] === "'") parts.push(parseString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
        if (!m) fail('Invalid key');
        parts.push(m![0]);
        i += m![0].length;
      }
      skipWs();
      if (text[i] === '.') {
        i++;
        continue;
      }
      return parts;
    }
  };
  const parseValue = (): unknown => {
    skipWs();
    const c = text[i];
    if (c === '"' || c === "'") return parseString();
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        skipWsNl();
        if (text[i] === ']') {
          i++;
          return arr;
        }
        arr.push(parseValue());
        skipWsNl();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        fail('Expected "," or "]"');
      }
    }
    if (c === '{') {
      i++;
      const tbl: TomlTable = {};
      skipWs();
      if (text[i] === '}') {
        i++;
        return tbl;
      }
      for (;;) {
        const key = parseKey();
        if (text[i] !== '=') fail('Expected "="');
        i++;
        setPath(tbl, key, parseValue());
        skipWs();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return tbl;
        }
        fail('Expected "," or "}"');
      }
    }
    const rest = text.slice(i);
    let m = /^(true|false)(?![A-Za-z0-9_-])/.exec(rest);
    if (m) {
      i += m[1].length;
      return m[1] === 'true';
    }
    m = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?|^\d{2}:\d{2}:\d{2}(?:\.\d+)?/.exec(rest);
    if (m) {
      i += m[0].length;
      return m[0];
    }
    m = /^[+-]?(?:inf|nan)/.exec(rest);
    if (m) {
      i += m[0].length;
      return m[0].endsWith('nan') ? NaN : m[0].startsWith('-') ? -Infinity : Infinity;
    }
    m = /^0x[0-9A-Fa-f_]+|^0o[0-7_]+|^0b[01_]+/.exec(rest);
    if (m) {
      i += m[0].length;
      const body = m[0].slice(2).replace(/_/g, '');
      return parseInt(body, m[0][1] === 'x' ? 16 : m[0][1] === 'o' ? 8 : 2);
    }
    m = /^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?/.exec(rest);
    if (m) {
      i += m[0].length;
      return Number(m[0].replace(/_/g, ''));
    }
    return fail('Invalid value');
  };
  const setPath = (tbl: TomlTable, key: string[], value: unknown): void => {
    let t = tbl;
    for (const k of key.slice(0, -1)) {
      if (!(k in t)) t[k] = {};
      const next = t[k];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) fail(`Cannot overwrite a value`);
      t = next as TomlTable;
    }
    const last = key[key.length - 1];
    if (last in t) fail(`Cannot overwrite a value`);
    t[last] = value;
  };
  const tablePath = (key: string[], array: boolean): TomlTable => {
    let t = root;
    key.forEach((k, idx) => {
      const isLast = idx === key.length - 1;
      if (isLast && array) {
        if (!(k in t)) t[k] = [];
        const arr = t[k];
        if (!Array.isArray(arr)) fail('Cannot overwrite a value');
        const nt: TomlTable = {};
        (arr as unknown[]).push(nt);
        t = nt;
        return;
      }
      if (!(k in t)) t[k] = {};
      let next = t[k];
      if (Array.isArray(next)) next = next[next.length - 1];
      if (typeof next !== 'object' || next === null) fail('Cannot overwrite a value');
      t = next as TomlTable;
    });
    return t;
  };
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (;;) {
    skipWsNl();
    if (i >= n) break;
    if (text[i] === '[') {
      const array = text[i + 1] === '[';
      i += array ? 2 : 1;
      const key = parseKey();
      if (array) {
        if (!text.startsWith(']]', i)) fail('Expected "]]"');
        i += 2;
      } else {
        if (text[i] !== ']') fail('Expected "]"');
        i += 1;
      }
      current = tablePath(key, array);
      expectEol();
      continue;
    }
    const key = parseKey();
    if (text[i] !== '=') fail('Expected "=" after a key in a key/value pair');
    i++;
    setPath(current, key, parseValue());
    expectEol();
  }
  return root;
}

/** Serialize a key for TOML output (bare when possible, else basic string). */
export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : escapeTomlBasic(key);
}
