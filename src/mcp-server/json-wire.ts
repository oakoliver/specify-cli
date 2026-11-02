/**
 * @oakoliver/specify-cli - JSON-RPC wire parsing
 *
 * A strict JSON parser that keeps Python's int/float distinction: number
 * literals with a fraction or exponent become {@link PyFloat} boxes, so
 * argument validation can reject `2.0` for an `int` field exactly like
 * pydantic strict mode does in the upstream MCP server.
 *
 * @module mcp-server/json-wire
 */

/** A JSON number literal that Python parses as `float`. */
export class PyFloat {
  constructor(readonly value: number) {}
}

/** Python `repr(float)`. */
export function pyFloatRepr(v: number): string {
  if (Number.isNaN(v)) return 'nan';
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : '-inf';
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return `${v}.0`;
  const s = String(v);
  return s.replace(/e([+-])(\d)$/, 'e$10$2');
}

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  fail(): never {
    throw new SyntaxError(`Invalid JSON at position ${this.i}`);
  }

  ws(): void {
    while (this.i < this.s.length && ' \t\n\r'.includes(this.s[this.i])) this.i++;
  }

  value(): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') return this.string();
    if (c === 't' && this.s.startsWith('true', this.i)) return (this.i += 4), true;
    if (c === 'f' && this.s.startsWith('false', this.i)) return (this.i += 5), false;
    if (c === 'n' && this.s.startsWith('null', this.i)) return (this.i += 4), null;
    return this.number();
  }

  object(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    this.i++;
    this.ws();
    if (this.s[this.i] === '}') return this.i++, out;
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail();
      const key = this.string();
      this.ws();
      if (this.s[this.i++] !== ':') this.fail();
      Object.defineProperty(out, key, { value: this.value(), enumerable: true, writable: true, configurable: true });
      this.ws();
      const c = this.s[this.i++];
      if (c === '}') return out;
      if (c !== ',') this.fail();
    }
  }

  array(): unknown[] {
    const out: unknown[] = [];
    this.i++;
    this.ws();
    if (this.s[this.i] === ']') return this.i++, out;
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.s[this.i++];
      if (c === ']') return out;
      if (c !== ',') this.fail();
    }
  }

  string(): string {
    const m = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(this.s.slice(this.i));
    if (!m) this.fail();
    this.i += m[0].length;
    return JSON.parse(m[0]) as string;
  }

  number(): number | PyFloat {
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(this.s.slice(this.i));
    if (!m) this.fail();
    this.i += m[0].length;
    const v = Number(m[0]);
    return m[1] !== undefined || m[2] !== undefined ? new PyFloat(v) : v;
  }
}

/** Parse one JSON document, boxing float literals as {@link PyFloat}. */
export function parseWireJson(text: string): unknown {
  const p = new Parser(text);
  const v = p.value();
  p.ws();
  if (p.i !== text.length) p.fail();
  return v;
}

/** Replace {@link PyFloat} boxes with plain numbers. */
export function unboxFloats(v: unknown): unknown {
  if (v instanceof PyFloat) return v.value;
  if (Array.isArray(v)) return v.map(unboxFloats);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      Object.defineProperty(out, k, { value: unboxFloats(x), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}
