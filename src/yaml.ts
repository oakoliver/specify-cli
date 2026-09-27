/**
 * @oakoliver/specify-cli - YAML
 *
 * Zero-dependency YAML loader/dumper with PyYAML `safe_load` / `safe_dump`
 * semantics. This is a structural port of PyYAML 6 (reader, scanner, parser,
 * composer, safe constructor, safe representer, serializer and emitter) so
 * that parsing results, error messages and emitted text match upstream
 * spec-kit (which uses PyYAML) as closely as possible.
 *
 * Deviations from PyYAML (JavaScript data model):
 * - Mapping keys are always strings (non-string keys are stringified the way
 *   `json.dumps` would: `null`, `true`, `false`, numbers via `String`).
 * - Timestamps (`2024-01-01`) are returned as their original string by
 *   default (`{ timestamps: 'date' }` returns `Date` objects instead).
 * - Integers beyond 2^53 lose precision (JS numbers). `!!binary` yields a
 *   `Uint8Array`; `!!set` yields a mapping of `null` values.
 * - When dumping, JS numbers that are integers are emitted as ints.
 *
 * @module yaml
 */

// ============================================================================
// Errors
// ============================================================================

/** Base class for all YAML errors (mirrors `yaml.YAMLError`). */
export class YAMLError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YAMLError';
  }
}

/** A position in the input (mirrors `yaml.Mark`). */
export class Mark {
  constructor(
    public name: string,
    public index: number,
    public line: number,
    public column: number,
    private buffer: string[] | null,
    public pointer: number,
  ) {}

  getSnippet(indent = 4, maxLength = 75): string | null {
    const buf = this.buffer;
    if (buf === null) return null;
    const breaks = '\0\r\n\x85  ';
    let head = '';
    let start = this.pointer;
    while (start > 0 && !breaks.includes(buf[start - 1] ?? '\0')) {
      start -= 1;
      if (this.pointer - start > maxLength / 2 - 1) {
        head = ' ... ';
        start += 5;
        break;
      }
    }
    let tail = '';
    let end = this.pointer;
    while (end < buf.length && !breaks.includes(buf[end])) {
      end += 1;
      if (end - this.pointer > maxLength / 2 - 1) {
        tail = ' ... ';
        end -= 5;
        break;
      }
    }
    const snippet = buf.slice(start, end).join('');
    return (
      ' '.repeat(indent) + head + snippet + tail + '\n' +
      ' '.repeat(indent + this.pointer - start + head.length) + '^'
    );
  }

  toString(): string {
    const snippet = this.getSnippet();
    let where = `  in "${this.name}", line ${this.line + 1}, column ${this.column + 1}`;
    if (snippet !== null) where += ':\n' + snippet;
    return where;
  }
}

/** Error carrying context/problem marks (mirrors `MarkedYAMLError`). */
export class MarkedYAMLError extends YAMLError {
  constructor(
    public context: string | null = null,
    public contextMark: Mark | null = null,
    public problem: string | null = null,
    public problemMark: Mark | null = null,
    public note: string | null = null,
  ) {
    super('');
    this.name = 'MarkedYAMLError';
    this.message = this.format();
  }

  private format(): string {
    const lines: string[] = [];
    if (this.context !== null) lines.push(this.context);
    if (
      this.contextMark !== null &&
      (this.problem === null ||
        this.problemMark === null ||
        this.contextMark.name !== this.problemMark.name ||
        this.contextMark.line !== this.problemMark.line ||
        this.contextMark.column !== this.problemMark.column)
    ) {
      lines.push(this.contextMark.toString());
    }
    if (this.problem !== null) lines.push(this.problem);
    if (this.problemMark !== null) lines.push(this.problemMark.toString());
    if (this.note !== null) lines.push(this.note);
    return lines.join('\n');
  }

  override toString(): string {
    return this.message;
  }
}

export class ReaderError extends YAMLError {
  constructor(name: string, position: number, character: number, reason: string) {
    super(
      `unacceptable character #x${character.toString(16).padStart(4, '0')}: ${reason}\n  in "${name}", position ${position}`,
    );
    this.name = 'ReaderError';
  }
}
export class ScannerError extends MarkedYAMLError {
  constructor(context: string | null, contextMark: Mark | null, problem: string | null, problemMark: Mark | null) {
    super(context, contextMark, problem, problemMark);
    this.name = 'ScannerError';
  }
}
export class ParserError extends MarkedYAMLError {
  constructor(context: string | null, contextMark: Mark | null, problem: string | null, problemMark: Mark | null) {
    super(context, contextMark, problem, problemMark);
    this.name = 'ParserError';
  }
}
export class ComposerError extends MarkedYAMLError {
  constructor(context: string | null, contextMark: Mark | null, problem: string | null, problemMark: Mark | null) {
    super(context, contextMark, problem, problemMark);
    this.name = 'ComposerError';
  }
}
export class ConstructorError extends MarkedYAMLError {
  constructor(context: string | null, contextMark: Mark | null, problem: string | null, problemMark: Mark | null) {
    super(context, contextMark, problem, problemMark);
    this.name = 'ConstructorError';
  }
}
export class EmitterError extends YAMLError {
  constructor(message: string) {
    super(message);
    this.name = 'EmitterError';
  }
}
export class RepresenterError extends YAMLError {
  constructor(message: string) {
    super(message);
    this.name = 'RepresenterError';
  }
}

/** Python-style `repr()` of a short string (used in error messages). */
function pyRepr(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp >= 0x80 && cp < 0xa0) out += '\\x' + cp.toString(16).padStart(2, '0');
    else out += ch;
  }
  if (out.includes("'") && !out.includes('"')) return `"${out}"`;
  return `'${out.replace(/'/g, "\\'")}'`;
}

// ============================================================================
// Reader
// ============================================================================

const BREAKS = '\r\n\x85  ';
const NUL_BREAKS = '\0' + BREAKS;
const WS_BREAKS = '\0 \t' + BREAKS;

function isNonPrintable(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  if (cp >= 0x20 && cp <= 0x7e) return false;
  if (cp === 0x85) return false;
  if (cp >= 0xa0 && cp <= 0xd7ff) return false;
  if (cp >= 0xe000 && cp <= 0xfffd) return false;
  if (cp >= 0x10000 && cp <= 0x10ffff) return false;
  return true;
}

class Reader {
  buffer: string[];
  pointer = 0;
  index = 0;
  line = 0;
  column = 0;

  constructor(text: string, public name: string) {
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i++) {
      const cp = chars[i].codePointAt(0)!;
      if (isNonPrintable(cp)) {
        throw new ReaderError(name, i, cp, 'special characters are not allowed');
      }
    }
    chars.push('\0');
    this.buffer = chars;
  }

  peek(index = 0): string {
    return this.buffer[this.pointer + index] ?? '\0';
  }

  prefix(length = 1): string {
    return this.buffer.slice(this.pointer, this.pointer + length).join('');
  }

  forward(length = 1): void {
    for (let i = 0; i < length; i++) {
      const ch = this.buffer[this.pointer];
      this.pointer += 1;
      this.index += 1;
      if ('\n\x85  '.includes(ch) || (ch === '\r' && this.buffer[this.pointer] !== '\n')) {
        this.line += 1;
        this.column = 0;
      } else if (ch !== '﻿') {
        this.column += 1;
      }
    }
  }

  getMark(): Mark {
    return new Mark(this.name, this.index, this.line, this.column, this.buffer, this.pointer);
  }
}

// ============================================================================
// Tokens
// ============================================================================

type TokenId =
  | '<stream start>' | '<stream end>' | '<directive>' | '<document start>' | '<document end>'
  | '<block sequence start>' | '<block mapping start>' | '<block end>'
  | '[' | '{' | ']' | '}' | '-' | '?' | ':' | ','
  | '<alias>' | '<anchor>' | '<tag>' | '<scalar>';

interface Token {
  id: TokenId;
  startMark: Mark;
  endMark: Mark;
  value?: string;
  tag?: [string | null, string];
  plain?: boolean;
  style?: string | null;
}

class SimpleKey {
  constructor(
    public tokenNumber: number,
    public required: boolean,
    public index: number,
    public line: number,
    public column: number,
    public mark: Mark,
  ) {}
}

// ============================================================================
// Scanner
// ============================================================================

const ESCAPE_REPLACEMENTS: Record<string, string> = {
  '0': '\0', a: '\x07', b: '\x08', t: '\x09', '\t': '\x09', n: '\x0A', v: '\x0B',
  f: '\x0C', r: '\x0D', e: '\x1B', ' ': '\x20', '"': '"', '/': '/', '\\': '\\',
  N: '\x85', _: '\xA0', L: ' ', P: ' ',
};
const ESCAPE_CODES: Record<string, number> = { x: 2, u: 4, U: 8 };

function isAlnumDash(ch: string): boolean {
  return (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '-' || ch === '_';
}

class Scanner extends Reader {
  done = false;
  flowLevel = 0;
  tokens: Token[] = [];
  tokensTaken = 0;
  indent = -1;
  indents: number[] = [];
  allowSimpleKey = true;
  possibleSimpleKeys = new Map<number, SimpleKey>();

  constructor(text: string, name: string) {
    super(text, name);
    const mark = this.getMark();
    this.tokens.push({ id: '<stream start>', startMark: mark, endMark: mark });
  }

  checkToken(...ids: TokenId[]): boolean {
    while (this.needMoreTokens()) this.fetchMoreTokens();
    if (this.tokens.length) {
      if (!ids.length) return true;
      return ids.includes(this.tokens[0].id);
    }
    return false;
  }

  peekToken(): Token | null {
    while (this.needMoreTokens()) this.fetchMoreTokens();
    return this.tokens[0] ?? null;
  }

  getToken(): Token | null {
    while (this.needMoreTokens()) this.fetchMoreTokens();
    if (this.tokens.length) {
      this.tokensTaken += 1;
      return this.tokens.shift()!;
    }
    return null;
  }

  private needMoreTokens(): boolean {
    if (this.done) return false;
    if (!this.tokens.length) return true;
    this.stalePossibleSimpleKeys();
    return this.nextPossibleSimpleKey() === this.tokensTaken;
  }

  private fetchMoreTokens(): void {
    this.scanToNextToken();
    this.stalePossibleSimpleKeys();
    this.unwindIndent(this.column);
    const ch = this.peek();
    if (ch === '\0') return this.fetchStreamEnd();
    if (ch === '%' && this.column === 0) return this.fetchDirective();
    if (ch === '-' && this.checkDocumentIndicator('---')) return this.fetchDocumentIndicator('<document start>');
    if (ch === '.' && this.checkDocumentIndicator('...')) return this.fetchDocumentIndicator('<document end>');
    if (ch === '[') return this.fetchFlowCollectionStart('[');
    if (ch === '{') return this.fetchFlowCollectionStart('{');
    if (ch === ']') return this.fetchFlowCollectionEnd(']');
    if (ch === '}') return this.fetchFlowCollectionEnd('}');
    if (ch === ',') return this.fetchFlowEntry();
    if (ch === '-' && WS_BREAKS.includes(this.peek(1))) return this.fetchBlockEntry();
    if (ch === '?' && (this.flowLevel || WS_BREAKS.includes(this.peek(1)))) return this.fetchKey();
    if (ch === ':' && (this.flowLevel || WS_BREAKS.includes(this.peek(1)))) return this.fetchValue();
    if (ch === '*') return this.fetchAnchorLike('<alias>');
    if (ch === '&') return this.fetchAnchorLike('<anchor>');
    if (ch === '!') return this.fetchTag();
    if (ch === '|' && !this.flowLevel) return this.fetchBlockScalar('|');
    if (ch === '>' && !this.flowLevel) return this.fetchBlockScalar('>');
    if (ch === "'") return this.fetchFlowScalar("'");
    if (ch === '"') return this.fetchFlowScalar('"');
    if (this.checkPlain()) return this.fetchPlain();
    throw new ScannerError(
      'while scanning for the next token', null,
      `found character ${pyRepr(ch)} that cannot start any token`, this.getMark(),
    );
  }

  private nextPossibleSimpleKey(): number | null {
    let min: number | null = null;
    for (const key of this.possibleSimpleKeys.values()) {
      if (min === null || key.tokenNumber < min) min = key.tokenNumber;
    }
    return min;
  }

  private stalePossibleSimpleKeys(): void {
    for (const [level, key] of [...this.possibleSimpleKeys]) {
      if (key.line !== this.line || this.index - key.index > 1024) {
        if (key.required) {
          throw new ScannerError('while scanning a simple key', key.mark, "could not find expected ':'", this.getMark());
        }
        this.possibleSimpleKeys.delete(level);
      }
    }
  }

  private savePossibleSimpleKey(): void {
    const required = !this.flowLevel && this.indent === this.column;
    if (this.allowSimpleKey) {
      this.removePossibleSimpleKey();
      const tokenNumber = this.tokensTaken + this.tokens.length;
      this.possibleSimpleKeys.set(
        this.flowLevel,
        new SimpleKey(tokenNumber, required, this.index, this.line, this.column, this.getMark()),
      );
    }
  }

  private removePossibleSimpleKey(): void {
    const key = this.possibleSimpleKeys.get(this.flowLevel);
    if (key) {
      if (key.required) {
        throw new ScannerError('while scanning a simple key', key.mark, "could not find expected ':'", this.getMark());
      }
      this.possibleSimpleKeys.delete(this.flowLevel);
    }
  }

  private unwindIndent(column: number): void {
    if (this.flowLevel) return;
    while (this.indent > column) {
      const mark = this.getMark();
      this.indent = this.indents.pop()!;
      this.tokens.push({ id: '<block end>', startMark: mark, endMark: mark });
    }
  }

  private addIndent(column: number): boolean {
    if (this.indent < column) {
      this.indents.push(this.indent);
      this.indent = column;
      return true;
    }
    return false;
  }

  private fetchStreamEnd(): void {
    this.unwindIndent(-1);
    this.removePossibleSimpleKey();
    this.allowSimpleKey = false;
    this.possibleSimpleKeys.clear();
    const mark = this.getMark();
    this.tokens.push({ id: '<stream end>', startMark: mark, endMark: mark });
    this.done = true;
  }

  private fetchDirective(): void {
    this.unwindIndent(-1);
    this.removePossibleSimpleKey();
    this.allowSimpleKey = false;
    const start = this.getMark();
    this.forward();
    let name = '';
    while (isAlnumDash(this.peek())) {
      name += this.peek();
      this.forward();
    }
    if (!name) {
      throw new ScannerError('while scanning a directive', start,
        `expected alphabetic or numeric character, but found ${pyRepr(this.peek())}`, this.getMark());
    }
    // Directive values are not needed by the safe loader; skip the rest of the line.
    while (!NUL_BREAKS.includes(this.peek())) this.forward();
    this.scanLineBreak();
    this.tokens.push({ id: '<directive>', startMark: start, endMark: this.getMark(), value: name });
  }

  private checkDocumentIndicator(indicator: string): boolean {
    return this.column === 0 && this.prefix(3) === indicator && WS_BREAKS.includes(this.peek(3));
  }

  private fetchDocumentIndicator(id: TokenId): void {
    this.unwindIndent(-1);
    this.removePossibleSimpleKey();
    this.allowSimpleKey = false;
    const start = this.getMark();
    this.forward(3);
    this.tokens.push({ id, startMark: start, endMark: this.getMark() });
  }

  private fetchFlowCollectionStart(id: '[' | '{'): void {
    this.savePossibleSimpleKey();
    this.flowLevel += 1;
    this.allowSimpleKey = true;
    const start = this.getMark();
    this.forward();
    this.tokens.push({ id, startMark: start, endMark: this.getMark() });
  }

  private fetchFlowCollectionEnd(id: ']' | '}'): void {
    this.removePossibleSimpleKey();
    this.flowLevel -= 1;
    this.allowSimpleKey = false;
    const start = this.getMark();
    this.forward();
    this.tokens.push({ id, startMark: start, endMark: this.getMark() });
  }

  private fetchFlowEntry(): void {
    this.allowSimpleKey = true;
    this.removePossibleSimpleKey();
    const start = this.getMark();
    this.forward();
    this.tokens.push({ id: ',', startMark: start, endMark: this.getMark() });
  }

  private fetchBlockEntry(): void {
    if (!this.flowLevel) {
      if (!this.allowSimpleKey) {
        throw new ScannerError(null, null, 'sequence entries are not allowed here', this.getMark());
      }
      if (this.addIndent(this.column)) {
        const mark = this.getMark();
        this.tokens.push({ id: '<block sequence start>', startMark: mark, endMark: mark });
      }
    }
    this.allowSimpleKey = true;
    this.removePossibleSimpleKey();
    const start = this.getMark();
    this.forward();
    this.tokens.push({ id: '-', startMark: start, endMark: this.getMark() });
  }

  private fetchKey(): void {
    if (!this.flowLevel) {
      if (!this.allowSimpleKey) {
        throw new ScannerError(null, null, 'mapping keys are not allowed here', this.getMark());
      }
      if (this.addIndent(this.column)) {
        const mark = this.getMark();
        this.tokens.push({ id: '<block mapping start>', startMark: mark, endMark: mark });
      }
    }
    this.allowSimpleKey = !this.flowLevel;
    this.removePossibleSimpleKey();
    const start = this.getMark();
    this.forward();
    this.tokens.push({ id: '?', startMark: start, endMark: this.getMark() });
  }

  private fetchValue(): void {
    const key = this.possibleSimpleKeys.get(this.flowLevel);
    if (key) {
      this.possibleSimpleKeys.delete(this.flowLevel);
      this.tokens.splice(key.tokenNumber - this.tokensTaken, 0, { id: '?', startMark: key.mark, endMark: key.mark });
      if (!this.flowLevel) {
        if (this.addIndent(key.column)) {
          this.tokens.splice(key.tokenNumber - this.tokensTaken, 0, {
            id: '<block mapping start>', startMark: key.mark, endMark: key.mark,
          });
        }
      }
      this.allowSimpleKey = false;
    } else {
      if (!this.flowLevel) {
        if (!this.allowSimpleKey) {
          throw new ScannerError(null, null, 'mapping values are not allowed here', this.getMark());
        }
        if (this.addIndent(this.column)) {
          const mark = this.getMark();
          this.tokens.push({ id: '<block mapping start>', startMark: mark, endMark: mark });
        }
      }
      this.allowSimpleKey = !this.flowLevel;
      this.removePossibleSimpleKey();
    }
    const start = this.getMark();
    this.forward();
    this.tokens.push({ id: ':', startMark: start, endMark: this.getMark() });
  }

  private fetchAnchorLike(id: '<alias>' | '<anchor>'): void {
    this.savePossibleSimpleKey();
    this.allowSimpleKey = false;
    const start = this.getMark();
    const name = id === '<alias>' ? 'alias' : 'anchor';
    this.forward();
    let length = 0;
    while (isAlnumDash(this.peek(length))) length += 1;
    if (!length) {
      throw new ScannerError(`while scanning an ${name}`, start,
        `expected alphabetic or numeric character, but found ${pyRepr(this.peek(length))}`, this.getMark());
    }
    const value = this.prefix(length);
    this.forward(length);
    const ch = this.peek();
    if (!(WS_BREAKS + '?:,]}%@`').includes(ch)) {
      throw new ScannerError(`while scanning an ${name}`, start,
        `expected alphabetic or numeric character, but found ${pyRepr(ch)}`, this.getMark());
    }
    this.tokens.push({ id, startMark: start, endMark: this.getMark(), value });
  }

  private fetchTag(): void {
    this.savePossibleSimpleKey();
    this.allowSimpleKey = false;
    const start = this.getMark();
    let ch = this.peek(1);
    let handle: string | null;
    let suffix: string;
    if (ch === '<') {
      handle = null;
      this.forward(2);
      suffix = this.scanTagUri(start);
      if (this.peek() !== '>') {
        throw new ScannerError('while parsing a tag', start, `expected '>', but found ${pyRepr(this.peek())}`, this.getMark());
      }
      this.forward();
    } else if (WS_BREAKS.includes(ch)) {
      handle = null;
      suffix = '!';
      this.forward();
    } else {
      let length = 1;
      let useHandle = false;
      while (!('\0 ' + BREAKS).includes(ch)) {
        if (ch === '!') {
          useHandle = true;
          break;
        }
        length += 1;
        ch = this.peek(length);
      }
      if (useHandle) {
        handle = this.scanTagHandle(start);
      } else {
        handle = '!';
        this.forward();
      }
      suffix = this.scanTagUri(start);
    }
    ch = this.peek();
    if (!('\0 ' + BREAKS).includes(ch)) {
      throw new ScannerError('while scanning a tag', start, `expected ' ', but found ${pyRepr(ch)}`, this.getMark());
    }
    this.tokens.push({ id: '<tag>', startMark: start, endMark: this.getMark(), tag: [handle, suffix] });
  }

  private scanTagHandle(start: Mark): string {
    let ch = this.peek();
    if (ch !== '!') {
      throw new ScannerError('while scanning a tag', start, `expected '!', but found ${pyRepr(ch)}`, this.getMark());
    }
    let length = 1;
    ch = this.peek(length);
    if (ch !== ' ') {
      while (isAlnumDash(ch)) {
        length += 1;
        ch = this.peek(length);
      }
      if (ch !== '!') {
        this.forward(length);
        throw new ScannerError('while scanning a tag', start, `expected '!', but found ${pyRepr(ch)}`, this.getMark());
      }
      length += 1;
    }
    const value = this.prefix(length);
    this.forward(length);
    return value;
  }

  private scanTagUri(start: Mark): string {
    const chunks: string[] = [];
    let length = 0;
    let ch = this.peek(length);
    while (isAlnumDash(ch) || "-;/?:@&=+$,_.!~*'()[]%".includes(ch)) {
      if (ch === '%') {
        chunks.push(this.prefix(length));
        this.forward(length);
        length = 0;
        const bytes: number[] = [];
        while (this.peek() === '%') {
          this.forward();
          const hex = this.prefix(2);
          if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
            throw new ScannerError('while scanning a tag', start,
              `expected URI escape sequence of 2 hexadecimal numbers, but found ${pyRepr(hex)}`, this.getMark());
          }
          bytes.push(parseInt(hex, 16));
          this.forward(2);
        }
        chunks.push(Buffer.from(bytes).toString('utf-8'));
      } else {
        length += 1;
      }
      ch = this.peek(length);
    }
    if (length) {
      chunks.push(this.prefix(length));
      this.forward(length);
    }
    if (!chunks.length) {
      throw new ScannerError('while parsing a tag', start,
        `expected URI, but found ${pyRepr(ch)}`, this.getMark());
    }
    return chunks.join('');
  }

  private checkPlain(): boolean {
    const ch = this.peek();
    return (
      !(WS_BREAKS + "-?:,[]{}#&*!|>'\"%@`").includes(ch) ||
      (!WS_BREAKS.includes(this.peek(1)) && (ch === '-' || (!this.flowLevel && '?:'.includes(ch))))
    );
  }

  private scanToNextToken(): void {
    if (this.index === 0 && this.peek() === '﻿') this.forward();
    let found = false;
    while (!found) {
      while (this.peek() === ' ') this.forward();
      if (this.peek() === '#') {
        while (!NUL_BREAKS.includes(this.peek())) this.forward();
      }
      if (this.scanLineBreak()) {
        if (!this.flowLevel) this.allowSimpleKey = true;
      } else {
        found = true;
      }
    }
  }

  private scanLineBreak(): string {
    const ch = this.peek();
    if ('\r\n\x85'.includes(ch) && ch !== '\0') {
      if (this.prefix(2) === '\r\n') this.forward(2);
      else this.forward();
      return '\n';
    } else if (ch === ' ' || ch === ' ') {
      this.forward();
      return ch;
    }
    return '';
  }

  // -- Block scalars --------------------------------------------------------

  private fetchBlockScalar(style: '|' | '>'): void {
    this.allowSimpleKey = true;
    this.removePossibleSimpleKey();
    this.tokens.push(this.scanBlockScalar(style));
  }

  private scanBlockScalar(style: '|' | '>'): Token {
    const folded = style === '>';
    const chunks: string[] = [];
    const start = this.getMark();
    this.forward();
    const [chomping, increment] = this.scanBlockScalarIndicators(start);
    this.scanBlockScalarIgnoredLine(start);
    let minIndent = this.indent + 1;
    if (minIndent < 1) minIndent = 1;
    let breaks: string[];
    let indent: number;
    let end: Mark;
    if (increment === null) {
      const [b, maxIndent, e] = this.scanBlockScalarIndentation();
      breaks = b;
      end = e;
      indent = Math.max(minIndent, maxIndent);
    } else {
      indent = minIndent + increment - 1;
      [breaks, end] = this.scanBlockScalarBreaks(indent);
    }
    let lineBreak = '';
    while (this.column === indent && this.peek() !== '\0') {
      chunks.push(...breaks);
      const leadingNonSpace = !' \t'.includes(this.peek());
      let length = 0;
      while (!NUL_BREAKS.includes(this.peek(length))) length += 1;
      chunks.push(this.prefix(length));
      this.forward(length);
      lineBreak = this.scanLineBreak();
      [breaks, end] = this.scanBlockScalarBreaks(indent);
      if (this.column === indent && this.peek() !== '\0') {
        if (folded && lineBreak === '\n' && leadingNonSpace && !' \t'.includes(this.peek())) {
          if (!breaks.length) chunks.push(' ');
        } else {
          chunks.push(lineBreak);
        }
      } else {
        break;
      }
    }
    if (chomping !== false) chunks.push(lineBreak);
    if (chomping === true) chunks.push(...breaks);
    return { id: '<scalar>', startMark: start, endMark: end, value: chunks.join(''), plain: false, style };
  }

  private scanBlockScalarIndicators(start: Mark): [boolean | null, number | null] {
    let chomping: boolean | null = null;
    let increment: number | null = null;
    let ch = this.peek();
    if (ch === '+' || ch === '-') {
      chomping = ch === '+';
      this.forward();
      ch = this.peek();
      if (ch >= '0' && ch <= '9' && ch.length === 1) {
        increment = parseInt(ch, 10);
        if (increment === 0) {
          throw new ScannerError('while scanning a block scalar', start,
            'expected indentation indicator in the range 1-9, but found 0', this.getMark());
        }
        this.forward();
      }
    } else if (ch >= '0' && ch <= '9' && ch.length === 1) {
      increment = parseInt(ch, 10);
      if (increment === 0) {
        throw new ScannerError('while scanning a block scalar', start,
          'expected indentation indicator in the range 1-9, but found 0', this.getMark());
      }
      this.forward();
      ch = this.peek();
      if (ch === '+' || ch === '-') {
        chomping = ch === '+';
        this.forward();
      }
    }
    ch = this.peek();
    if (!('\0 ' + BREAKS).includes(ch)) {
      throw new ScannerError('while scanning a block scalar', start,
        `expected chomping or indentation indicators, but found ${pyRepr(ch)}`, this.getMark());
    }
    return [chomping, increment];
  }

  private scanBlockScalarIgnoredLine(start: Mark): void {
    while (this.peek() === ' ') this.forward();
    if (this.peek() === '#') {
      while (!NUL_BREAKS.includes(this.peek())) this.forward();
    }
    const ch = this.peek();
    if (!NUL_BREAKS.includes(ch)) {
      throw new ScannerError('while scanning a block scalar', start,
        `expected a comment or a line break, but found ${pyRepr(ch)}`, this.getMark());
    }
    this.scanLineBreak();
  }

  private scanBlockScalarIndentation(): [string[], number, Mark] {
    const chunks: string[] = [];
    let maxIndent = 0;
    let end = this.getMark();
    while ((' ' + BREAKS).includes(this.peek()) && this.peek() !== '\0') {
      if (this.peek() !== ' ') {
        chunks.push(this.scanLineBreak());
        end = this.getMark();
      } else {
        this.forward();
        if (this.column > maxIndent) maxIndent = this.column;
      }
    }
    return [chunks, maxIndent, end];
  }

  private scanBlockScalarBreaks(indent: number): [string[], Mark] {
    const chunks: string[] = [];
    let end = this.getMark();
    while (this.column < indent && this.peek() === ' ') this.forward();
    while (BREAKS.includes(this.peek()) && this.peek() !== '\0') {
      chunks.push(this.scanLineBreak());
      end = this.getMark();
      while (this.column < indent && this.peek() === ' ') this.forward();
    }
    return [chunks, end];
  }

  // -- Flow scalars ---------------------------------------------------------

  private fetchFlowScalar(style: "'" | '"'): void {
    this.savePossibleSimpleKey();
    this.allowSimpleKey = false;
    this.tokens.push(this.scanFlowScalar(style));
  }

  private scanFlowScalar(style: "'" | '"'): Token {
    const double = style === '"';
    const chunks: string[] = [];
    const start = this.getMark();
    const quote = this.peek();
    this.forward();
    chunks.push(...this.scanFlowScalarNonSpaces(double, start));
    while (this.peek() !== quote) {
      chunks.push(...this.scanFlowScalarSpaces(double, start));
      chunks.push(...this.scanFlowScalarNonSpaces(double, start));
    }
    this.forward();
    return { id: '<scalar>', startMark: start, endMark: this.getMark(), value: chunks.join(''), plain: false, style };
  }

  private scanFlowScalarNonSpaces(double: boolean, start: Mark): string[] {
    const chunks: string[] = [];
    for (;;) {
      let length = 0;
      while (!("'\"\\" + WS_BREAKS).includes(this.peek(length))) length += 1;
      if (length) {
        chunks.push(this.prefix(length));
        this.forward(length);
      }
      let ch = this.peek();
      if (!double && ch === "'" && this.peek(1) === "'") {
        chunks.push("'");
        this.forward(2);
      } else if ((double && ch === "'") || (!double && (ch === '"' || ch === '\\'))) {
        chunks.push(ch);
        this.forward();
      } else if (double && ch === '\\') {
        this.forward();
        ch = this.peek();
        if (ch in ESCAPE_REPLACEMENTS && ch !== '\0') {
          chunks.push(ESCAPE_REPLACEMENTS[ch]);
          this.forward();
        } else if (ch in ESCAPE_CODES) {
          const len = ESCAPE_CODES[ch];
          this.forward();
          for (let k = 0; k < len; k++) {
            if (!'0123456789ABCDEFabcdef'.includes(this.peek(k)) || this.peek(k) === '\0') {
              throw new ScannerError('while scanning a double-quoted scalar', start,
                `expected escape sequence of ${len} hexadecimal numbers, but found ${pyRepr(this.peek(k))}`,
                this.getMark());
            }
          }
          const code = parseInt(this.prefix(len), 16);
          if (code > 0x10ffff) {
            throw new ScannerError('while scanning a double-quoted scalar', start,
              `found invalid escape code ${code}`, this.getMark());
          }
          chunks.push(String.fromCodePoint(code));
          this.forward(len);
        } else if (BREAKS.includes(ch) && ch !== '\0') {
          this.scanLineBreak();
          chunks.push(...this.scanFlowScalarBreaks(double, start));
        } else {
          throw new ScannerError('while scanning a double-quoted scalar', start,
            `found unknown escape character ${pyRepr(ch)}`, this.getMark());
        }
      } else {
        return chunks;
      }
    }
  }

  private scanFlowScalarSpaces(double: boolean, start: Mark): string[] {
    const chunks: string[] = [];
    let length = 0;
    while (' \t'.includes(this.peek(length))) length += 1;
    const whitespaces = this.prefix(length);
    this.forward(length);
    const ch = this.peek();
    if (ch === '\0') {
      throw new ScannerError('while scanning a quoted scalar', start, 'found unexpected end of stream', this.getMark());
    } else if (BREAKS.includes(ch)) {
      const lineBreak = this.scanLineBreak();
      const breaks = this.scanFlowScalarBreaks(double, start);
      if (lineBreak !== '\n') chunks.push(lineBreak);
      else if (!breaks.length) chunks.push(' ');
      chunks.push(...breaks);
    } else {
      chunks.push(whitespaces);
    }
    return chunks;
  }

  private scanFlowScalarBreaks(_double: boolean, start: Mark): string[] {
    const chunks: string[] = [];
    for (;;) {
      const prefix = this.prefix(3);
      if ((prefix === '---' || prefix === '...') && WS_BREAKS.includes(this.peek(3))) {
        throw new ScannerError('while scanning a quoted scalar', start, 'found unexpected document separator', this.getMark());
      }
      while (' \t'.includes(this.peek())) this.forward();
      if (BREAKS.includes(this.peek()) && this.peek() !== '\0') {
        chunks.push(this.scanLineBreak());
      } else {
        return chunks;
      }
    }
  }

  // -- Plain scalars --------------------------------------------------------

  private fetchPlain(): void {
    this.savePossibleSimpleKey();
    this.allowSimpleKey = false;
    this.tokens.push(this.scanPlain());
  }

  private scanPlain(): Token {
    const chunks: string[] = [];
    const start = this.getMark();
    let end = start;
    const indent = this.indent + 1;
    let spaces: string[] | null = [];
    for (;;) {
      let length = 0;
      if (this.peek() === '#') break;
      for (;;) {
        const ch = this.peek(length);
        if (
          WS_BREAKS.includes(ch) ||
          (ch === ':' && (WS_BREAKS + (this.flowLevel ? ',[]{}' : '')).includes(this.peek(length + 1))) ||
          (this.flowLevel && ',?[]{}'.includes(ch))
        ) {
          break;
        }
        length += 1;
      }
      if (length === 0) break;
      this.allowSimpleKey = false;
      chunks.push(...(spaces ?? []));
      chunks.push(this.prefix(length));
      this.forward(length);
      end = this.getMark();
      spaces = this.scanPlainSpaces();
      if (!spaces || !spaces.length || this.peek() === '#' || (!this.flowLevel && this.column < indent)) break;
    }
    return { id: '<scalar>', startMark: start, endMark: end, value: chunks.join(''), plain: true, style: null };
  }

  private scanPlainSpaces(): string[] | null {
    const chunks: string[] = [];
    let length = 0;
    while (this.peek(length) === ' ') length += 1;
    const whitespaces = this.prefix(length);
    this.forward(length);
    const ch = this.peek();
    if (BREAKS.includes(ch) && ch !== '\0') {
      const lineBreak = this.scanLineBreak();
      this.allowSimpleKey = true;
      let prefix = this.prefix(3);
      if ((prefix === '---' || prefix === '...') && WS_BREAKS.includes(this.peek(3))) return null;
      const breaks: string[] = [];
      while ((' ' + BREAKS).includes(this.peek()) && this.peek() !== '\0') {
        if (this.peek() === ' ') {
          this.forward();
        } else {
          breaks.push(this.scanLineBreak());
          prefix = this.prefix(3);
          if ((prefix === '---' || prefix === '...') && WS_BREAKS.includes(this.peek(3))) return null;
        }
      }
      if (lineBreak !== '\n') chunks.push(lineBreak);
      else if (!breaks.length) chunks.push(' ');
      chunks.push(...breaks);
    } else if (whitespaces) {
      chunks.push(whitespaces);
    }
    return chunks;
  }
}

// ============================================================================
// Events & Parser
// ============================================================================

type EventKind =
  | 'StreamStart' | 'StreamEnd' | 'DocumentStart' | 'DocumentEnd' | 'Alias' | 'Scalar'
  | 'SequenceStart' | 'SequenceEnd' | 'MappingStart' | 'MappingEnd';

interface YamlEvent {
  kind: EventKind;
  startMark: Mark | null;
  endMark: Mark | null;
  anchor?: string | null;
  tag?: string | null;
  implicit?: [boolean, boolean] | boolean;
  value?: string;
  style?: string | null;
  flowStyle?: boolean | null;
  explicit?: boolean;
}

const DEFAULT_TAGS: Record<string, string> = { '!': '!', '!!': 'tag:yaml.org,2002:' };

class Parser {
  private scanner: Scanner;
  private currentEvent: YamlEvent | null = null;
  private states: Array<() => YamlEvent> = [];
  private marks: Mark[] = [];
  private state: (() => YamlEvent) | null;
  private tagHandles: Record<string, string> = {};

  constructor(scanner: Scanner) {
    this.scanner = scanner;
    this.state = () => this.parseStreamStart();
  }

  checkEvent(...kinds: EventKind[]): boolean {
    if (this.currentEvent === null && this.state) this.currentEvent = this.state();
    if (this.currentEvent !== null) {
      if (!kinds.length) return true;
      return kinds.includes(this.currentEvent.kind);
    }
    return false;
  }

  peekEvent(): YamlEvent | null {
    if (this.currentEvent === null && this.state) this.currentEvent = this.state();
    return this.currentEvent;
  }

  getEvent(): YamlEvent {
    if (this.currentEvent === null && this.state) this.currentEvent = this.state();
    const value = this.currentEvent!;
    this.currentEvent = null;
    return value;
  }

  private tok(): Token {
    return this.scanner.peekToken()!;
  }

  private parseStreamStart(): YamlEvent {
    const token = this.scanner.getToken()!;
    this.state = () => this.parseImplicitDocumentStart();
    return { kind: 'StreamStart', startMark: token.startMark, endMark: token.endMark };
  }

  private parseImplicitDocumentStart(): YamlEvent {
    if (!this.scanner.checkToken('<directive>', '<document start>', '<stream end>')) {
      this.tagHandles = DEFAULT_TAGS;
      const token = this.tok();
      this.states.push(() => this.parseDocumentEnd());
      this.state = () => this.parseBlockNode();
      return { kind: 'DocumentStart', startMark: token.startMark, endMark: token.startMark, explicit: false };
    }
    return this.parseDocumentStart();
  }

  private parseDocumentStart(): YamlEvent {
    while (this.scanner.checkToken('<document end>')) this.scanner.getToken();
    if (!this.scanner.checkToken('<stream end>')) {
      const start = this.tok().startMark;
      while (this.scanner.checkToken('<directive>')) this.scanner.getToken();
      this.tagHandles = { ...DEFAULT_TAGS };
      if (!this.scanner.checkToken('<document start>')) {
        throw new ParserError(null, null,
          `expected '<document start>', but found ${pyRepr(this.tok().id)}`, this.tok().startMark);
      }
      const token = this.scanner.getToken()!;
      this.states.push(() => this.parseDocumentEnd());
      this.state = () => this.parseDocumentContent();
      return { kind: 'DocumentStart', startMark: start, endMark: token.endMark, explicit: true };
    }
    const token = this.scanner.getToken()!;
    this.state = null;
    return { kind: 'StreamEnd', startMark: token.startMark, endMark: token.endMark };
  }

  private parseDocumentEnd(): YamlEvent {
    const token = this.tok();
    const start = token.startMark;
    let end = start;
    let explicit = false;
    if (this.scanner.checkToken('<document end>')) {
      end = this.scanner.getToken()!.endMark;
      explicit = true;
    }
    this.state = () => this.parseDocumentStart();
    return { kind: 'DocumentEnd', startMark: start, endMark: end, explicit };
  }

  private parseDocumentContent(): YamlEvent {
    if (this.scanner.checkToken('<directive>', '<document start>', '<document end>', '<stream end>')) {
      const event = this.processEmptyScalar(this.tok().startMark);
      this.state = this.states.pop()!;
      return event;
    }
    return this.parseBlockNode();
  }

  private parseBlockNode(): YamlEvent {
    return this.parseNode(true);
  }

  private parseFlowNode(): YamlEvent {
    return this.parseNode(false);
  }

  private parseNode(block: boolean, indentlessSequence = false): YamlEvent {
    if (this.scanner.checkToken('<alias>')) {
      const token = this.scanner.getToken()!;
      this.state = this.states.pop()!;
      return { kind: 'Alias', anchor: token.value, startMark: token.startMark, endMark: token.endMark };
    }
    let anchor: string | null = null;
    let tagPair: [string | null, string] | null = null;
    let start: Mark | null = null;
    let end: Mark | null = null;
    let tagMark: Mark | null = null;
    if (this.scanner.checkToken('<anchor>')) {
      const token = this.scanner.getToken()!;
      start = token.startMark;
      end = token.endMark;
      anchor = token.value!;
      if (this.scanner.checkToken('<tag>')) {
        const t = this.scanner.getToken()!;
        tagMark = t.startMark;
        end = t.endMark;
        tagPair = t.tag!;
      }
    } else if (this.scanner.checkToken('<tag>')) {
      const token = this.scanner.getToken()!;
      start = tagMark = token.startMark;
      end = token.endMark;
      tagPair = token.tag!;
      if (this.scanner.checkToken('<anchor>')) {
        const a = this.scanner.getToken()!;
        end = a.endMark;
        anchor = a.value!;
      }
    }
    let tag: string | null = null;
    if (tagPair !== null) {
      const [handle, suffix] = tagPair;
      if (handle !== null) {
        if (!(handle in this.tagHandles)) {
          throw new ParserError('while parsing a node', start, `found undefined tag handle ${pyRepr(handle)}`, tagMark);
        }
        tag = this.tagHandles[handle] + suffix;
      } else {
        tag = suffix;
      }
    }
    if (start === null) {
      start = end = this.tok().startMark;
    }
    const implicit = tag === null || tag === '!';
    if (indentlessSequence && this.scanner.checkToken('-')) {
      end = this.tok().endMark;
      this.state = () => this.parseIndentlessSequenceEntry();
      return { kind: 'SequenceStart', anchor, tag, implicit, startMark: start, endMark: end, flowStyle: false };
    }
    if (this.scanner.checkToken('<scalar>')) {
      const token = this.scanner.getToken()!;
      end = token.endMark;
      let imp: [boolean, boolean];
      if ((token.plain && tag === null) || tag === '!') imp = [true, false];
      else if (tag === null) imp = [false, true];
      else imp = [false, false];
      this.state = this.states.pop()!;
      return {
        kind: 'Scalar', anchor, tag, implicit: imp, value: token.value, startMark: start, endMark: end,
        style: token.style ?? null,
      };
    }
    if (this.scanner.checkToken('[')) {
      end = this.tok().endMark;
      this.state = () => this.parseFlowSequenceFirstEntry();
      return { kind: 'SequenceStart', anchor, tag, implicit, startMark: start, endMark: end, flowStyle: true };
    }
    if (this.scanner.checkToken('{')) {
      end = this.tok().endMark;
      this.state = () => this.parseFlowMappingFirstKey();
      return { kind: 'MappingStart', anchor, tag, implicit, startMark: start, endMark: end, flowStyle: true };
    }
    if (block && this.scanner.checkToken('<block sequence start>')) {
      end = this.tok().startMark;
      this.state = () => this.parseBlockSequenceFirstEntry();
      return { kind: 'SequenceStart', anchor, tag, implicit, startMark: start, endMark: end, flowStyle: false };
    }
    if (block && this.scanner.checkToken('<block mapping start>')) {
      end = this.tok().startMark;
      this.state = () => this.parseBlockMappingFirstKey();
      return { kind: 'MappingStart', anchor, tag, implicit, startMark: start, endMark: end, flowStyle: false };
    }
    if (anchor !== null || tag !== null) {
      this.state = this.states.pop()!;
      return {
        kind: 'Scalar', anchor, tag, implicit: [implicit, false], value: '', startMark: start, endMark: end, style: null,
      };
    }
    const token = this.tok();
    throw new ParserError(`while parsing a ${block ? 'block' : 'flow'} node`, start,
      `expected the node content, but found ${pyRepr(token.id)}`, token.startMark);
  }

  private parseBlockSequenceFirstEntry(): YamlEvent {
    const token = this.scanner.getToken()!;
    this.marks.push(token.startMark);
    return this.parseBlockSequenceEntry();
  }

  private parseBlockSequenceEntry(): YamlEvent {
    if (this.scanner.checkToken('-')) {
      const token = this.scanner.getToken()!;
      if (!this.scanner.checkToken('-', '<block end>')) {
        this.states.push(() => this.parseBlockSequenceEntry());
        return this.parseBlockNode();
      }
      this.state = () => this.parseBlockSequenceEntry();
      return this.processEmptyScalar(token.endMark);
    }
    if (!this.scanner.checkToken('<block end>')) {
      const token = this.tok();
      throw new ParserError('while parsing a block collection', this.marks[this.marks.length - 1],
        `expected <block end>, but found ${pyRepr(token.id)}`, token.startMark);
    }
    const token = this.scanner.getToken()!;
    this.state = this.states.pop()!;
    this.marks.pop();
    return { kind: 'SequenceEnd', startMark: token.startMark, endMark: token.endMark };
  }

  private parseIndentlessSequenceEntry(): YamlEvent {
    if (this.scanner.checkToken('-')) {
      const token = this.scanner.getToken()!;
      if (!this.scanner.checkToken('-', '?', ':', '<block end>')) {
        this.states.push(() => this.parseIndentlessSequenceEntry());
        return this.parseBlockNode();
      }
      this.state = () => this.parseIndentlessSequenceEntry();
      return this.processEmptyScalar(token.endMark);
    }
    const token = this.tok();
    this.state = this.states.pop()!;
    return { kind: 'SequenceEnd', startMark: token.startMark, endMark: token.startMark };
  }

  private parseBlockMappingFirstKey(): YamlEvent {
    const token = this.scanner.getToken()!;
    this.marks.push(token.startMark);
    return this.parseBlockMappingKey();
  }

  private parseBlockMappingKey(): YamlEvent {
    if (this.scanner.checkToken('?')) {
      const token = this.scanner.getToken()!;
      if (!this.scanner.checkToken('?', ':', '<block end>')) {
        this.states.push(() => this.parseBlockMappingValue());
        return this.parseNode(true, true);
      }
      this.state = () => this.parseBlockMappingValue();
      return this.processEmptyScalar(token.endMark);
    }
    if (!this.scanner.checkToken('<block end>')) {
      const token = this.tok();
      throw new ParserError('while parsing a block mapping', this.marks[this.marks.length - 1],
        `expected <block end>, but found ${pyRepr(token.id)}`, token.startMark);
    }
    const token = this.scanner.getToken()!;
    this.state = this.states.pop()!;
    this.marks.pop();
    return { kind: 'MappingEnd', startMark: token.startMark, endMark: token.endMark };
  }

  private parseBlockMappingValue(): YamlEvent {
    if (this.scanner.checkToken(':')) {
      const token = this.scanner.getToken()!;
      if (!this.scanner.checkToken('?', ':', '<block end>')) {
        this.states.push(() => this.parseBlockMappingKey());
        return this.parseNode(true, true);
      }
      this.state = () => this.parseBlockMappingKey();
      return this.processEmptyScalar(token.endMark);
    }
    this.state = () => this.parseBlockMappingKey();
    return this.processEmptyScalar(this.tok().startMark);
  }

  private parseFlowSequenceFirstEntry(): YamlEvent {
    const token = this.scanner.getToken()!;
    this.marks.push(token.startMark);
    return this.parseFlowSequenceEntry(true);
  }

  private parseFlowSequenceEntry(first = false): YamlEvent {
    if (!this.scanner.checkToken(']')) {
      if (!first) {
        if (this.scanner.checkToken(',')) {
          this.scanner.getToken();
        } else {
          const token = this.tok();
          throw new ParserError('while parsing a flow sequence', this.marks[this.marks.length - 1],
            `expected ',' or ']', but got ${pyRepr(token.id)}`, token.startMark);
        }
      }
      if (this.scanner.checkToken('?')) {
        const token = this.tok();
        this.state = () => this.parseFlowSequenceEntryMappingKey();
        return {
          kind: 'MappingStart', anchor: null, tag: null, implicit: true,
          startMark: token.startMark, endMark: token.endMark, flowStyle: true,
        };
      } else if (!this.scanner.checkToken(']')) {
        this.states.push(() => this.parseFlowSequenceEntry());
        return this.parseFlowNode();
      }
    }
    const token = this.scanner.getToken()!;
    this.state = this.states.pop()!;
    this.marks.pop();
    return { kind: 'SequenceEnd', startMark: token.startMark, endMark: token.endMark };
  }

  private parseFlowSequenceEntryMappingKey(): YamlEvent {
    const token = this.scanner.getToken()!;
    if (!this.scanner.checkToken(':', ',', ']')) {
      this.states.push(() => this.parseFlowSequenceEntryMappingValue());
      return this.parseFlowNode();
    }
    this.state = () => this.parseFlowSequenceEntryMappingValue();
    return this.processEmptyScalar(token.endMark);
  }

  private parseFlowSequenceEntryMappingValue(): YamlEvent {
    if (this.scanner.checkToken(':')) {
      const token = this.scanner.getToken()!;
      if (!this.scanner.checkToken(',', ']')) {
        this.states.push(() => this.parseFlowSequenceEntryMappingEnd());
        return this.parseFlowNode();
      }
      this.state = () => this.parseFlowSequenceEntryMappingEnd();
      return this.processEmptyScalar(token.endMark);
    }
    this.state = () => this.parseFlowSequenceEntryMappingEnd();
    return this.processEmptyScalar(this.tok().startMark);
  }

  private parseFlowSequenceEntryMappingEnd(): YamlEvent {
    this.state = () => this.parseFlowSequenceEntry();
    const token = this.tok();
    return { kind: 'MappingEnd', startMark: token.startMark, endMark: token.startMark };
  }

  private parseFlowMappingFirstKey(): YamlEvent {
    const token = this.scanner.getToken()!;
    this.marks.push(token.startMark);
    return this.parseFlowMappingKey(true);
  }

  private parseFlowMappingKey(first = false): YamlEvent {
    if (!this.scanner.checkToken('}')) {
      if (!first) {
        if (this.scanner.checkToken(',')) {
          this.scanner.getToken();
        } else {
          const token = this.tok();
          throw new ParserError('while parsing a flow mapping', this.marks[this.marks.length - 1],
            `expected ',' or '}', but got ${pyRepr(token.id)}`, token.startMark);
        }
      }
      if (this.scanner.checkToken('?')) {
        const token = this.scanner.getToken()!;
        if (!this.scanner.checkToken(':', ',', '}')) {
          this.states.push(() => this.parseFlowMappingValue());
          return this.parseFlowNode();
        }
        this.state = () => this.parseFlowMappingValue();
        return this.processEmptyScalar(token.endMark);
      } else if (!this.scanner.checkToken('}')) {
        this.states.push(() => this.parseFlowMappingEmptyValue());
        return this.parseFlowNode();
      }
    }
    const token = this.scanner.getToken()!;
    this.state = this.states.pop()!;
    this.marks.pop();
    return { kind: 'MappingEnd', startMark: token.startMark, endMark: token.endMark };
  }

  private parseFlowMappingValue(): YamlEvent {
    if (this.scanner.checkToken(':')) {
      const token = this.scanner.getToken()!;
      if (!this.scanner.checkToken(',', '}')) {
        this.states.push(() => this.parseFlowMappingKey());
        return this.parseFlowNode();
      }
      this.state = () => this.parseFlowMappingKey();
      return this.processEmptyScalar(token.endMark);
    }
    this.state = () => this.parseFlowMappingKey();
    return this.processEmptyScalar(this.tok().startMark);
  }

  private parseFlowMappingEmptyValue(): YamlEvent {
    this.state = () => this.parseFlowMappingKey();
    return this.processEmptyScalar(this.tok().startMark);
  }

  private processEmptyScalar(mark: Mark): YamlEvent {
    return {
      kind: 'Scalar', anchor: null, tag: null, implicit: [true, false], value: '',
      startMark: mark, endMark: mark, style: null,
    };
  }
}

// ============================================================================
// Resolver
// ============================================================================

const TAG_PREFIX = 'tag:yaml.org,2002:';
const STR_TAG = TAG_PREFIX + 'str';
const SEQ_TAG = TAG_PREFIX + 'seq';
const MAP_TAG = TAG_PREFIX + 'map';

const RE_BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const RE_FLOAT =
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const RE_INT =
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;
const RE_MERGE = /^(?:<<)$/;
const RE_NULL = /^(?:~|null|Null|NULL|)$/;
const RE_TIMESTAMP =
  /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/;
const RE_VALUE = /^(?:=)$/;

const IMPLICIT_RESOLVERS: Array<[string, RegExp, string[]]> = [
  [TAG_PREFIX + 'bool', RE_BOOL, Array.from('yYnNtTfFoO')],
  [TAG_PREFIX + 'float', RE_FLOAT, Array.from('-+0123456789.')],
  [TAG_PREFIX + 'int', RE_INT, Array.from('-+0123456789')],
  [TAG_PREFIX + 'merge', RE_MERGE, ['<']],
  [TAG_PREFIX + 'null', RE_NULL, ['~', 'n', 'N', '']],
  [TAG_PREFIX + 'timestamp', RE_TIMESTAMP, Array.from('0123456789')],
  [TAG_PREFIX + 'value', RE_VALUE, ['=']],
];

/** Resolve the implicit tag of a plain scalar (PyYAML `Resolver.resolve`). */
function resolveScalar(value: string, implicit: [boolean, boolean]): string {
  if (implicit[0]) {
    const first = value === '' ? '' : Array.from(value)[0];
    for (const [tag, re, firsts] of IMPLICIT_RESOLVERS) {
      if (firsts.includes(first) && re.test(value)) return tag;
    }
  }
  return STR_TAG;
}

// ============================================================================
// Composer (nodes)
// ============================================================================

interface ScalarNode {
  kind: 'scalar';
  tag: string;
  value: string;
  startMark: Mark | null;
  endMark: Mark | null;
  style: string | null;
}
interface SequenceNode {
  kind: 'sequence';
  tag: string;
  value: YamlNode[];
  startMark: Mark | null;
  endMark: Mark | null;
  flowStyle: boolean | null;
}
interface MappingNode {
  kind: 'mapping';
  tag: string;
  value: Array<[YamlNode, YamlNode]>;
  startMark: Mark | null;
  endMark: Mark | null;
  flowStyle: boolean | null;
}
type YamlNode = ScalarNode | SequenceNode | MappingNode;

class Composer {
  private anchors = new Map<string, YamlNode>();
  constructor(private parser: Parser) {}

  getSingleNode(): YamlNode | null {
    this.parser.getEvent(); // stream start
    let document: YamlNode | null = null;
    let docStart: Mark | null = null;
    if (!this.parser.checkEvent('StreamEnd')) {
      docStart = this.parser.peekEvent()!.startMark;
      document = this.composeDocument();
    }
    if (!this.parser.checkEvent('StreamEnd')) {
      const event = this.parser.getEvent();
      throw new ComposerError('expected a single document in the stream', document?.startMark ?? docStart,
        'but found another document', event.startMark);
    }
    this.parser.getEvent();
    return document;
  }

  private composeDocument(): YamlNode {
    this.parser.getEvent();
    const node = this.composeNode();
    this.parser.getEvent();
    this.anchors = new Map();
    return node;
  }

  private composeNode(): YamlNode {
    if (this.parser.checkEvent('Alias')) {
      const event = this.parser.getEvent();
      const anchor = event.anchor!;
      const node = this.anchors.get(anchor);
      if (!node) {
        throw new ComposerError(null, null, `found undefined alias ${pyRepr(anchor)}`, event.startMark);
      }
      return node;
    }
    const event = this.parser.peekEvent()!;
    const anchor = event.anchor ?? null;
    if (anchor !== null && this.anchors.has(anchor)) {
      throw new ComposerError(`found duplicate anchor ${pyRepr(anchor)}; first occurrence`,
        this.anchors.get(anchor)!.startMark, 'second occurrence', event.startMark);
    }
    if (this.parser.checkEvent('Scalar')) {
      const ev = this.parser.getEvent();
      let tag = ev.tag ?? null;
      if (tag === null || tag === '!') tag = resolveScalar(ev.value!, ev.implicit as [boolean, boolean]);
      const node: ScalarNode = {
        kind: 'scalar', tag, value: ev.value!, startMark: ev.startMark, endMark: ev.endMark, style: ev.style ?? null,
      };
      if (anchor !== null) this.anchors.set(anchor, node);
      return node;
    }
    if (this.parser.checkEvent('SequenceStart')) {
      const start = this.parser.getEvent();
      let tag = start.tag ?? null;
      if (tag === null || tag === '!') tag = SEQ_TAG;
      const node: SequenceNode = {
        kind: 'sequence', tag, value: [], startMark: start.startMark, endMark: null, flowStyle: start.flowStyle ?? null,
      };
      if (anchor !== null) this.anchors.set(anchor, node);
      while (!this.parser.checkEvent('SequenceEnd')) node.value.push(this.composeNode());
      node.endMark = this.parser.getEvent().endMark;
      return node;
    }
    const start = this.parser.getEvent();
    let tag = start.tag ?? null;
    if (tag === null || tag === '!') tag = MAP_TAG;
    const node: MappingNode = {
      kind: 'mapping', tag, value: [], startMark: start.startMark, endMark: null, flowStyle: start.flowStyle ?? null,
    };
    if (anchor !== null) this.anchors.set(anchor, node);
    while (!this.parser.checkEvent('MappingEnd')) {
      const k = this.composeNode();
      const v = this.composeNode();
      node.value.push([k, v]);
    }
    node.endMark = this.parser.getEvent().endMark;
    return node;
  }
}

// ============================================================================
// Safe constructor
// ============================================================================

/** Options for {@link parseYaml}. */
export interface ParseYamlOptions {
  /** Source name used in error marks (default `<unicode string>`). */
  name?: string;
  /** How to return `!!timestamp` values: original string (default) or `Date`. */
  timestamps?: 'string' | 'date';
}

type YamlMap = Record<string, unknown>;

function keyToString(key: unknown): string {
  if (key === null || key === undefined) return 'null';
  if (typeof key === 'boolean') return key ? 'true' : 'false';
  if (key instanceof Date) return key.toISOString();
  return String(key);
}

function setKey(obj: YamlMap, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    obj[key] = value;
  }
}

class SafeConstructor {
  private constructed = new Map<YamlNode, unknown>();
  constructor(private opts: ParseYamlOptions) {}

  constructDocument(node: YamlNode): unknown {
    return this.constructObject(node);
  }

  private constructObject(node: YamlNode): unknown {
    if (this.constructed.has(node)) return this.constructed.get(node);
    const tag = node.tag;
    const name = tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : null;
    switch (name) {
      case 'null':
        this.expectScalar(node);
        return this.memo(node, null);
      case 'bool': {
        const v = this.expectScalar(node).toLowerCase();
        return this.memo(node, v === 'yes' || v === 'true' || v === 'on');
      }
      case 'int':
        return this.memo(node, constructYamlInt(this.expectScalar(node), node));
      case 'float':
        return this.memo(node, constructYamlFloat(this.expectScalar(node), node));
      case 'str':
        return this.memo(node, this.expectScalar(node));
      case 'binary': {
        const v = this.expectScalar(node);
        return this.memo(node, new Uint8Array(Buffer.from(v.replace(/\s+/g, ''), 'base64')));
      }
      case 'timestamp': {
        const v = this.expectScalar(node);
        if (this.opts.timestamps === 'date') {
          const d = parseTimestamp(v);
          return this.memo(node, d);
        }
        return this.memo(node, v);
      }
      case 'seq': {
        if (node.kind !== 'sequence') {
          throw new ConstructorError(null, null, `expected a sequence node, but found ${node.kind}`, node.startMark);
        }
        const out: unknown[] = [];
        this.constructed.set(node, out);
        for (const child of node.value) out.push(this.constructObject(child));
        return out;
      }
      case 'omap':
      case 'pairs': {
        if (node.kind !== 'sequence') {
          throw new ConstructorError(`while constructing an ordered map`, node.startMark,
            `expected a sequence, but found ${node.kind}`, node.startMark);
        }
        const out: unknown[] = [];
        this.constructed.set(node, out);
        for (const sub of node.value) {
          if (sub.kind !== 'mapping' || sub.value.length !== 1) {
            throw new ConstructorError('while constructing an ordered map', node.startMark,
              `expected a single mapping item, but found ${sub.kind === 'mapping' ? `${sub.value.length} items` : sub.kind}`,
              sub.startMark);
          }
          const [k, v] = sub.value[0];
          out.push([this.constructObject(k), this.constructObject(v)]);
        }
        return out;
      }
      case 'map':
      case 'set': {
        if (node.kind !== 'mapping') {
          throw new ConstructorError(null, null, `expected a mapping node, but found ${node.kind}`, node.startMark);
        }
        const out: YamlMap = {};
        this.constructed.set(node, out);
        for (const [k, v] of this.flattenMapping(node)) {
          const key = this.constructObject(k);
          if (typeof key === 'object' && key !== null && !(key instanceof Date)) {
            throw new ConstructorError('while constructing a mapping', node.startMark, 'found unhashable key', k.startMark);
          }
          setKey(out, keyToString(key), name === 'set' ? null : this.constructObject(v));
        }
        return out;
      }
      default:
        throw new ConstructorError(null, null, `could not determine a constructor for the tag ${pyRepr(tag)}`,
          node.startMark);
    }
  }

  private memo<T>(node: YamlNode, value: T): T {
    this.constructed.set(node, value);
    return value;
  }

  private expectScalar(node: YamlNode): string {
    if (node.kind !== 'scalar') {
      throw new ConstructorError(null, null, `expected a scalar node, but found ${node.kind}`, node.startMark);
    }
    return node.value;
  }

  /** PyYAML `flatten_mapping`: expand `<<` merge keys (non-mutating). */
  private flattenMapping(node: MappingNode): Array<[YamlNode, YamlNode]> {
    const merge: Array<[YamlNode, YamlNode]> = [];
    const own: Array<[YamlNode, YamlNode]> = [];
    for (const [keyNode, valueNode] of node.value) {
      if (keyNode.tag === TAG_PREFIX + 'merge') {
        if (valueNode.kind === 'mapping') {
          merge.push(...this.flattenMapping(valueNode));
        } else if (valueNode.kind === 'sequence') {
          const submerge: Array<Array<[YamlNode, YamlNode]>> = [];
          for (const sub of valueNode.value) {
            if (sub.kind !== 'mapping') {
              throw new ConstructorError('while constructing a mapping', node.startMark,
                `expected a mapping for merging, but found ${sub.kind}`, sub.startMark);
            }
            submerge.push(this.flattenMapping(sub));
          }
          submerge.reverse();
          for (const v of submerge) merge.push(...v);
        } else {
          throw new ConstructorError('while constructing a mapping', node.startMark,
            `expected a mapping or list of mappings for merging, but found ${valueNode.kind}`, valueNode.startMark);
        }
      } else if (keyNode.tag === TAG_PREFIX + 'value') {
        own.push([{ ...(keyNode as ScalarNode), tag: STR_TAG }, valueNode]);
      } else {
        own.push([keyNode, valueNode]);
      }
    }
    return merge.length ? [...merge, ...own] : own;
  }
}

function constructYamlInt(raw: string, node: YamlNode): number {
  let value = raw.replace(/_/g, '');
  let sign = 1;
  if (value[0] === '-') sign = -1;
  if (value[0] === '+' || value[0] === '-') value = value.slice(1);
  let result: number;
  if (value === '0') return 0;
  else if (value.startsWith('0b')) result = parseInt(value.slice(2), 2);
  else if (value.startsWith('0x')) result = parseInt(value.slice(2), 16);
  else if (value[0] === '0') result = parseInt(value, 8);
  else if (value.includes(':')) {
    const digits = value.split(':').map((p) => parseInt(p, 10)).reverse();
    let base = 1;
    result = 0;
    for (const d of digits) {
      result += d * base;
      base *= 60;
    }
  } else if (/^[0-9]+$/.test(value)) result = parseInt(value, 10);
  else result = NaN;
  if (Number.isNaN(result)) {
    throw new ConstructorError(null, null, `invalid literal for int() with base 10: ${pyRepr(raw)}`, node.startMark);
  }
  return sign * result;
}

function constructYamlFloat(raw: string, node: YamlNode): number {
  let value = raw.replace(/_/g, '').toLowerCase();
  let sign = 1;
  if (value[0] === '-') sign = -1;
  if (value[0] === '+' || value[0] === '-') value = value.slice(1);
  if (value === '.inf') return sign * Infinity;
  if (value === '.nan') return NaN;
  if (value.includes(':')) {
    const digits = value.split(':').map((p) => parseFloat(p)).reverse();
    let base = 1;
    let result = 0;
    for (const d of digits) {
      result += d * base;
      base *= 60;
    }
    return sign * result;
  }
  const n = Number(value.endsWith('.') ? value + '0' : value.startsWith('.') ? '0' + value : value);
  if (Number.isNaN(n) || value === '') {
    throw new ConstructorError(null, null, `could not convert string to float: ${pyRepr(raw)}`, node.startMark);
  }
  return sign * n;
}

function parseTimestamp(v: string): Date {
  const m = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:[Tt]|[ \t]+)([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])([0-9]{1,2})(?::([0-9]{2}))?))?)?$/.exec(v);
  if (!m) return new Date(NaN);
  const [, y, mo, d, h, mi, s, frac, tz, tzSign, tzH, tzM] = m;
  if (h === undefined) return new Date(Date.UTC(+y, +mo - 1, +d));
  const ms = frac ? Math.round(parseFloat('0.' + frac) * 1000) : 0;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms);
  if (tz && tz !== 'Z') {
    const off = (+tzH * 60 + (tzM ? +tzM : 0)) * 60000;
    t -= tzSign === '-' ? -off : off;
  }
  return new Date(t);
}

// ============================================================================
// Public loading API
// ============================================================================

function composeText(text: string, name: string): YamlNode | null {
  const scanner = new Scanner(text, name);
  const parser = new Parser(scanner);
  return new Composer(parser).getSingleNode();
}

/**
 * Parse a single YAML document with PyYAML `yaml.safe_load` semantics.
 * Returns `null` for an empty stream. Throws {@link YAMLError} on invalid input.
 */
export function parseYaml(text: string, opts: ParseYamlOptions = {}): unknown {
  const node = composeText(text, opts.name ?? '<unicode string>');
  if (node === null) return null;
  return new SafeConstructor(opts).constructDocument(node);
}

/** Alias of {@link parseYaml} named after PyYAML. */
export const safeLoad = parseYaml;

/**
 * Mirror of the upstream idiom
 * `node = yaml.compose(text); is_empty = node is None or (data is None and node is an
 * empty plain scalar with zero-length span)`. True only for a genuinely empty
 * document (whitespace/comments only, or a bare `---`), false for explicit
 * `null` / `~`. Throws {@link YAMLError} on invalid YAML.
 */
export function isEmptyYamlDocument(text: string, opts: ParseYamlOptions = {}): boolean {
  const node = composeText(text, opts.name ?? '<unicode string>');
  if (node === null) return true;
  return (
    node.kind === 'scalar' &&
    node.tag === TAG_PREFIX + 'null' &&
    node.value === '' &&
    node.startMark !== null &&
    node.endMark !== null &&
    node.startMark.index === node.endMark.index
  );
}

/** Returns true when the YAML stream contains a node (`yaml.compose(text) is not None`). */
export function yamlHasNode(text: string, opts: ParseYamlOptions = {}): boolean {
  return composeText(text, opts.name ?? '<unicode string>') !== null;
}

// ============================================================================
// Representer + Serializer (value -> events)
// ============================================================================

/** Options for {@link dumpYaml} (PyYAML `safe_dump` keyword arguments). */
export interface DumpYamlOptions {
  /** Sort mapping keys (default true, like PyYAML). */
  sortKeys?: boolean;
  /** false (default): block style; true: flow everywhere; null: flow for leaf collections. */
  defaultFlowStyle?: boolean | null;
  /** Emit non-ASCII characters verbatim (default false => escaped, double-quoted). */
  allowUnicode?: boolean;
  /** Indentation width (2..9, default 2). */
  indent?: number;
  /** Preferred line width (default 80). `Infinity` disables folding. */
  width?: number;
  /** Force a scalar style for every scalar (e.g. `'"'`). */
  defaultStyle?: '"' | "'" | '|' | '>' | null;
  /** Emit `---` before the document. */
  explicitStart?: boolean;
  /** Emit `...` after the document. */
  explicitEnd?: boolean;
}

interface EmitScalarEvent {
  kind: 'Scalar';
  anchor: string | null;
  tag: string;
  implicit: [boolean, boolean];
  value: string;
  style: string | null;
}
interface EmitCollectionStart {
  kind: 'SequenceStart' | 'MappingStart';
  anchor: string | null;
  tag: string;
  implicit: boolean;
  flowStyle: boolean;
}
type EmitEvent =
  | { kind: 'StreamStart' | 'StreamEnd' | 'SequenceEnd' | 'MappingEnd' }
  | { kind: 'DocumentStart' | 'DocumentEnd'; explicit: boolean }
  | { kind: 'Alias'; anchor: string }
  | EmitScalarEvent
  | EmitCollectionStart;

type RepNode =
  | { kind: 'scalar'; tag: string; value: string; style: string | null }
  | { kind: 'sequence'; tag: string; value: RepNode[]; flowStyle: boolean }
  | { kind: 'mapping'; tag: string; value: Array<[RepNode, RepNode]>; flowStyle: boolean };

function comparePy(a: string, b: string): number {
  // Python compares strings by code point.
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const d = ai[i].codePointAt(0)! - bi[i].codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ai.length - bi.length;
}

/** Python `repr(float)` (shortest round-trip, Python exponent rules). */
function pyFloatRepr(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return n.toFixed(1);
  const exp = n.toExponential(); // shortest digits
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exp)!;
  const [, sign, d0, rest = '', e] = m;
  const e10 = parseInt(e, 10);
  const digits = d0 + rest;
  if (e10 < -4 || e10 >= 16) {
    const mant = rest ? `${d0}.${rest}` : d0;
    const ee = Math.abs(e10) < 10 ? `${e10 < 0 ? '-' : '+'}0${Math.abs(e10)}` : `${e10 < 0 ? '-' : '+'}${Math.abs(e10)}`;
    return `${sign}${mant}e${ee}`;
  }
  if (e10 < 0) return `${sign}0.${'0'.repeat(-e10 - 1)}${digits}`;
  if (digits.length <= e10 + 1) return `${sign}${digits}${'0'.repeat(e10 + 1 - digits.length)}.0`;
  return `${sign}${digits.slice(0, e10 + 1)}.${digits.slice(e10 + 1)}`;
}

class Representer {
  private represented = new Map<object, RepNode>();
  constructor(private opts: Required<Pick<DumpYamlOptions, 'sortKeys' | 'defaultStyle'>> & { defaultFlowStyle: boolean | null }) {}

  represent(data: unknown): RepNode {
    if (data !== null && typeof data === 'object' && !(data instanceof Date)) {
      const existing = this.represented.get(data as object);
      if (existing) return existing;
    }
    return this.representData(data);
  }

  private scalar(tag: string, value: string): RepNode {
    return { kind: 'scalar', tag, value, style: this.opts.defaultStyle };
  }

  private representData(data: unknown): RepNode {
    if (data === null || data === undefined) return this.scalar(TAG_PREFIX + 'null', 'null');
    if (typeof data === 'string') return this.scalar(STR_TAG, data);
    if (typeof data === 'boolean') return this.scalar(TAG_PREFIX + 'bool', data ? 'true' : 'false');
    if (typeof data === 'bigint') return this.scalar(TAG_PREFIX + 'int', data.toString());
    if (typeof data === 'number') {
      if (Number.isInteger(data) && !Object.is(data, -0)) return this.scalar(TAG_PREFIX + 'int', String(data));
      let value: string;
      if (Number.isNaN(data)) value = '.nan';
      else if (data === Infinity) value = '.inf';
      else if (data === -Infinity) value = '-.inf';
      else {
        value = pyFloatRepr(data).toLowerCase();
        if (!value.includes('.') && value.includes('e')) value = value.replace('e', '.0e');
      }
      return this.scalar(TAG_PREFIX + 'float', value);
    }
    if (data instanceof Date) {
      return this.scalar(TAG_PREFIX + 'timestamp', data.toISOString().replace('T', ' ').replace('Z', '+00:00'));
    }
    if (data instanceof Uint8Array) {
      const b64 = Buffer.from(data).toString('base64').replace(/(.{76})/g, '$1\n');
      const node: RepNode = { kind: 'scalar', tag: TAG_PREFIX + 'binary', value: b64 + '\n', style: '|' };
      return node;
    }
    if (Array.isArray(data)) {
      const node: RepNode & { kind: 'sequence' } = { kind: 'sequence', tag: SEQ_TAG, value: [], flowStyle: false };
      this.represented.set(data, node);
      let bestStyle = true;
      for (const item of data) {
        const n = this.represent(item);
        if (!(n.kind === 'scalar' && !n.style)) bestStyle = false;
        node.value.push(n);
      }
      node.flowStyle = this.opts.defaultFlowStyle !== null ? this.opts.defaultFlowStyle : bestStyle;
      return node;
    }
    if (typeof data === 'object') {
      const node: RepNode & { kind: 'mapping' } = { kind: 'mapping', tag: MAP_TAG, value: [], flowStyle: false };
      this.represented.set(data as object, node);
      let entries: Array<[string, unknown]> =
        data instanceof Map
          ? [...data.entries()].map(([k, v]) => [keyToString(k), v])
          : Object.entries(data as Record<string, unknown>).filter(([, v]) => v !== undefined);
      if (this.opts.sortKeys) entries = [...entries].sort((a, b) => comparePy(a[0], b[0]));
      let bestStyle = true;
      for (const [k, v] of entries) {
        const kn = this.represent(k);
        const vn = this.represent(v);
        if (!(kn.kind === 'scalar' && !kn.style)) bestStyle = false;
        if (!(vn.kind === 'scalar' && !vn.style)) bestStyle = false;
        node.value.push([kn, vn]);
      }
      node.flowStyle = this.opts.defaultFlowStyle !== null ? this.opts.defaultFlowStyle : bestStyle;
      return node;
    }
    throw new RepresenterError(`cannot represent an object: ${String(data)}`);
  }
}

function serialize(root: RepNode, explicitStart: boolean, explicitEnd: boolean): EmitEvent[] {
  const anchors = new Map<RepNode, string | null>();
  let lastId = 0;
  const anchorNode = (node: RepNode): void => {
    if (anchors.has(node)) {
      if (anchors.get(node) === null) {
        lastId += 1;
        anchors.set(node, `id${String(lastId).padStart(3, '0')}`);
      }
      return;
    }
    if (node.kind === 'scalar') return; // scalars are never aliased (ignore_aliases)
    anchors.set(node, null);
    if (node.kind === 'sequence') for (const item of node.value) anchorNode(item);
    else for (const [k, v] of node.value) {
      anchorNode(k);
      anchorNode(v);
    }
  };
  anchorNode(root);
  const events: EmitEvent[] = [{ kind: 'StreamStart' }, { kind: 'DocumentStart', explicit: explicitStart }];
  const serialized = new Set<RepNode>();
  const serializeNode = (node: RepNode): void => {
    const alias = anchors.get(node) ?? null;
    if (serialized.has(node)) {
      events.push({ kind: 'Alias', anchor: alias! });
      return;
    }
    serialized.add(node);
    if (node.kind === 'scalar') {
      const detected = resolveScalar(node.value, [true, false]);
      const def = resolveScalar(node.value, [false, true]);
      events.push({
        kind: 'Scalar', anchor: alias, tag: node.tag,
        implicit: [node.tag === detected, node.tag === def], value: node.value, style: node.style,
      });
    } else if (node.kind === 'sequence') {
      events.push({ kind: 'SequenceStart', anchor: alias, tag: node.tag, implicit: node.tag === SEQ_TAG, flowStyle: node.flowStyle });
      for (const item of node.value) serializeNode(item);
      events.push({ kind: 'SequenceEnd' });
    } else {
      events.push({ kind: 'MappingStart', anchor: alias, tag: node.tag, implicit: node.tag === MAP_TAG, flowStyle: node.flowStyle });
      for (const [k, v] of node.value) {
        serializeNode(k);
        serializeNode(v);
      }
      events.push({ kind: 'MappingEnd' });
    }
  };
  serializeNode(root);
  events.push({ kind: 'DocumentEnd', explicit: explicitEnd }, { kind: 'StreamEnd' });
  return events;
}

// ============================================================================
// Emitter
// ============================================================================

interface ScalarAnalysis {
  scalar: string;
  empty: boolean;
  multiline: boolean;
  allowFlowPlain: boolean;
  allowBlockPlain: boolean;
  allowSingleQuoted: boolean;
  allowDoubleQuoted: boolean;
  allowBlock: boolean;
}

const EMIT_ESCAPES: Record<string, string> = {
  '\0': '0', '\x07': 'a', '\x08': 'b', '\x09': 't', '\x0A': 'n', '\x0B': 'v', '\x0C': 'f', '\x0D': 'r',
  '\x1B': 'e', '"': '"', '\\': '\\', '\x85': 'N', '\xA0': '_', ' ': 'L', ' ': 'P',
};
const LINE_BREAKS = '\n\x85  ';
const WS_ALL = '\0 \t\r\n\x85  ';

function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

class Emitter {
  private out: string[] = [];
  private events: EmitEvent[];
  private i = 0;
  private event: EmitEvent | null = null;
  private states: Array<() => void> = [];
  private state: (() => void) | null;
  private indents: Array<number | null> = [];
  private indent: number | null = null;
  private flowLevel = 0;
  private rootContext = false;
  private sequenceContext = false;
  private mappingContext = false;
  private simpleKeyContext = false;
  private column = 0;
  private whitespace = true;
  private indention = true;
  private openEnded = false;
  private bestIndent = 2;
  private bestWidth = 80;
  private allowUnicode: boolean;
  private analysis: ScalarAnalysis | null = null;
  private style: string | null = null;
  private preparedAnchor: string | null = null;
  private preparedTag: string | null = null;

  constructor(events: EmitEvent[], opts: DumpYamlOptions) {
    this.events = events;
    this.allowUnicode = !!opts.allowUnicode;
    if (opts.indent && opts.indent > 1 && opts.indent < 10) this.bestIndent = opts.indent;
    if (opts.width && opts.width > this.bestIndent * 2) this.bestWidth = opts.width;
    this.state = () => this.expectStreamStart();
  }

  run(): string {
    while (this.i < this.events.length) {
      this.event = this.events[this.i++];
      this.state!();
      this.event = null;
    }
    return this.out.join('');
  }

  private next(): EmitEvent | undefined {
    return this.events[this.i];
  }

  private write(s: string): void {
    this.out.push(s);
  }

  private increaseIndent(flow = false, indentless = false): void {
    this.indents.push(this.indent);
    if (this.indent === null) {
      this.indent = flow ? this.bestIndent : 0;
    } else if (!indentless) {
      this.indent += this.bestIndent;
    }
  }

  // -- Stream / document handlers ------------------------------------------

  private expectStreamStart(): void {
    this.state = () => this.expectFirstDocumentStart();
  }

  private expectFirstDocumentStart(): void {
    this.expectDocumentStart(true);
  }

  private expectDocumentStart(first = false): void {
    const ev = this.event!;
    if (ev.kind === 'DocumentStart') {
      const implicit = first && !ev.explicit;
      if (!implicit) {
        this.writeIndent();
        this.writeIndicator('---', true);
      }
      this.state = () => this.expectDocumentRoot();
    } else if (ev.kind === 'StreamEnd') {
      if (this.openEnded) {
        this.writeIndicator('...', true);
        this.writeIndent();
      }
      this.state = () => undefined;
    } else {
      throw new EmitterError(`expected DocumentStartEvent, but got ${ev.kind}`);
    }
  }

  private expectDocumentEnd(): void {
    const ev = this.event!;
    if (ev.kind !== 'DocumentEnd') throw new EmitterError(`expected DocumentEndEvent, but got ${ev.kind}`);
    this.writeIndent();
    if (ev.explicit) {
      this.writeIndicator('...', true);
      this.writeIndent();
    }
    this.state = () => this.expectDocumentStart();
  }

  private expectDocumentRoot(): void {
    this.states.push(() => this.expectDocumentEnd());
    this.expectNode(true);
  }

  // -- Node handlers ----------------------------------------------------------

  private expectNode(root = false, sequence = false, mapping = false, simpleKey = false): void {
    this.rootContext = root;
    this.sequenceContext = sequence;
    this.mappingContext = mapping;
    this.simpleKeyContext = simpleKey;
    const ev = this.event!;
    if (ev.kind === 'Alias') {
      this.processAnchor('*');
      this.state = this.states.pop()!;
    } else if (ev.kind === 'Scalar' || ev.kind === 'SequenceStart' || ev.kind === 'MappingStart') {
      this.processAnchor('&');
      this.processTag();
      if (ev.kind === 'Scalar') {
        this.expectScalar();
      } else if (ev.kind === 'SequenceStart') {
        if (this.flowLevel || ev.flowStyle || this.checkEmptySequence()) this.expectFlowSequence();
        else this.expectBlockSequence();
      } else {
        if (this.flowLevel || ev.flowStyle || this.checkEmptyMapping()) this.expectFlowMapping();
        else this.expectBlockMapping();
      }
    } else {
      throw new EmitterError(`expected NodeEvent, but got ${ev.kind}`);
    }
  }

  private expectScalar(): void {
    this.increaseIndent(true);
    this.processScalar();
    this.indent = this.indents.pop()!;
    this.state = this.states.pop()!;
  }

  // Flow sequence
  private expectFlowSequence(): void {
    this.writeIndicator('[', true, true);
    this.flowLevel += 1;
    this.increaseIndent(true);
    this.state = () => this.expectFlowSequenceItem(true);
  }

  private expectFlowSequenceItem(first = false): void {
    if (this.event!.kind === 'SequenceEnd') {
      this.indent = this.indents.pop()!;
      this.flowLevel -= 1;
      this.writeIndicator(']', false);
      this.state = this.states.pop()!;
      return;
    }
    if (!first) this.writeIndicator(',', false);
    if (this.column > this.bestWidth) this.writeIndent();
    this.states.push(() => this.expectFlowSequenceItem());
    this.expectNode(false, true);
  }

  // Flow mapping
  private expectFlowMapping(): void {
    this.writeIndicator('{', true, true);
    this.flowLevel += 1;
    this.increaseIndent(true);
    this.state = () => this.expectFlowMappingKey(true);
  }

  private expectFlowMappingKey(first = false): void {
    if (this.event!.kind === 'MappingEnd') {
      this.indent = this.indents.pop()!;
      this.flowLevel -= 1;
      this.writeIndicator('}', false);
      this.state = this.states.pop()!;
      return;
    }
    if (!first) this.writeIndicator(',', false);
    if (this.column > this.bestWidth) this.writeIndent();
    if (this.checkSimpleKey()) {
      this.states.push(() => this.expectFlowMappingSimpleValue());
      this.expectNode(false, false, true, true);
    } else {
      this.writeIndicator('?', true);
      this.states.push(() => this.expectFlowMappingValue());
      this.expectNode(false, false, true);
    }
  }

  private expectFlowMappingSimpleValue(): void {
    this.writeIndicator(':', false);
    this.states.push(() => this.expectFlowMappingKey());
    this.expectNode(false, false, true);
  }

  private expectFlowMappingValue(): void {
    if (this.column > this.bestWidth) this.writeIndent();
    this.writeIndicator(':', true);
    this.states.push(() => this.expectFlowMappingKey());
    this.expectNode(false, false, true);
  }

  // Block sequence
  private expectBlockSequence(): void {
    const indentless = this.mappingContext && !this.indention;
    this.increaseIndent(false, indentless);
    this.state = () => this.expectBlockSequenceItem(true);
  }

  private expectBlockSequenceItem(first = false): void {
    if (!first && this.event!.kind === 'SequenceEnd') {
      this.indent = this.indents.pop()!;
      this.state = this.states.pop()!;
      return;
    }
    this.writeIndent();
    this.writeIndicator('-', true, false, true);
    this.states.push(() => this.expectBlockSequenceItem());
    this.expectNode(false, true);
  }

  // Block mapping
  private expectBlockMapping(): void {
    this.increaseIndent(false);
    this.state = () => this.expectBlockMappingKey(true);
  }

  private expectBlockMappingKey(first = false): void {
    if (!first && this.event!.kind === 'MappingEnd') {
      this.indent = this.indents.pop()!;
      this.state = this.states.pop()!;
      return;
    }
    this.writeIndent();
    if (this.checkSimpleKey()) {
      this.states.push(() => this.expectBlockMappingSimpleValue());
      this.expectNode(false, false, true, true);
    } else {
      this.writeIndicator('?', true, false, true);
      this.states.push(() => this.expectBlockMappingValue());
      this.expectNode(false, false, true);
    }
  }

  private expectBlockMappingSimpleValue(): void {
    this.writeIndicator(':', false);
    this.states.push(() => this.expectBlockMappingKey());
    this.expectNode(false, false, true);
  }

  private expectBlockMappingValue(): void {
    this.writeIndent();
    this.writeIndicator(':', true, false, true);
    this.states.push(() => this.expectBlockMappingKey());
    this.expectNode(false, false, true);
  }

  // -- Checkers -------------------------------------------------------------

  private checkEmptySequence(): boolean {
    return this.event!.kind === 'SequenceStart' && this.next()?.kind === 'SequenceEnd';
  }

  private checkEmptyMapping(): boolean {
    return this.event!.kind === 'MappingStart' && this.next()?.kind === 'MappingEnd';
  }

  private checkSimpleKey(): boolean {
    const ev = this.event!;
    let length = 0;
    if ((ev.kind === 'Scalar' || ev.kind === 'SequenceStart' || ev.kind === 'MappingStart') && ev.anchor !== null) {
      if (this.preparedAnchor === null) this.preparedAnchor = ev.anchor;
      length += this.preparedAnchor.length;
    }
    if (ev.kind === 'Scalar' || ev.kind === 'SequenceStart' || ev.kind === 'MappingStart') {
      if (this.preparedTag === null && ev.tag) this.preparedTag = this.prepareTag(ev.tag);
      length += this.preparedTag?.length ?? 0;
    }
    if (ev.kind === 'Scalar') {
      if (this.analysis === null) this.analysis = this.analyzeScalar(ev.value);
      length += cpLen(this.analysis.scalar);
    }
    return (
      length < 128 &&
      (ev.kind === 'Alias' ||
        (ev.kind === 'Scalar' && !this.analysis!.empty && !this.analysis!.multiline) ||
        this.checkEmptySequence() ||
        this.checkEmptyMapping())
    );
  }

  // -- Anchor, tag, scalar processors --------------------------------------

  private processAnchor(indicator: string): void {
    const ev = this.event as { anchor?: string | null };
    if (ev.anchor === null || ev.anchor === undefined) {
      this.preparedAnchor = null;
      return;
    }
    if (this.preparedAnchor === null) this.preparedAnchor = ev.anchor;
    if (this.preparedAnchor) this.writeIndicator(indicator + this.preparedAnchor, true);
    this.preparedAnchor = null;
  }

  private processTag(): void {
    const ev = this.event as EmitScalarEvent | EmitCollectionStart;
    let tag: string | null = ev.tag;
    if (ev.kind === 'Scalar') {
      if (this.style === null) this.style = this.chooseScalarStyle();
      if ((this.style === '' && ev.implicit[0]) || (this.style !== '' && ev.implicit[1])) {
        this.preparedTag = null;
        return;
      }
      if (ev.implicit[0] && tag === null) {
        tag = '!';
        this.preparedTag = null;
      }
    } else if (ev.implicit || tag === null) {
      this.preparedTag = null;
      return;
    }
    if (tag === null) throw new EmitterError('tag is not specified');
    if (this.preparedTag === null) this.preparedTag = this.prepareTag(tag);
    if (this.preparedTag) this.writeIndicator(this.preparedTag, true);
    this.preparedTag = null;
  }

  private prepareTag(tag: string): string {
    if (tag === '!') return tag;
    if (tag.startsWith(TAG_PREFIX) && tag.length > TAG_PREFIX.length) return '!!' + tag.slice(TAG_PREFIX.length);
    return `!<${tag}>`;
  }

  private chooseScalarStyle(): string {
    const ev = this.event as EmitScalarEvent;
    if (this.analysis === null) this.analysis = this.analyzeScalar(ev.value);
    const a = this.analysis;
    if (ev.style === '"') return '"';
    if (!ev.style && ev.implicit[0]) {
      if (
        !(this.simpleKeyContext && (a.empty || a.multiline)) &&
        ((this.flowLevel && a.allowFlowPlain) || (!this.flowLevel && a.allowBlockPlain))
      ) {
        return '';
      }
    }
    if (ev.style && (ev.style === '|' || ev.style === '>')) {
      if (!this.flowLevel && !this.simpleKeyContext && a.allowBlock) return ev.style;
    }
    if (!ev.style || ev.style === "'") {
      if (a.allowSingleQuoted && !(this.simpleKeyContext && a.multiline)) return "'";
    }
    return '"';
  }

  private processScalar(): void {
    const ev = this.event as EmitScalarEvent;
    if (this.analysis === null) this.analysis = this.analyzeScalar(ev.value);
    if (this.style === null) this.style = this.chooseScalarStyle();
    const split = !this.simpleKeyContext;
    const text = this.analysis.scalar;
    if (this.style === '"') this.writeDoubleQuoted(text, split);
    else if (this.style === "'") this.writeSingleQuoted(text, split);
    else if (this.style === '>') this.writeFolded(text);
    else if (this.style === '|') this.writeLiteral(text);
    else this.writePlain(text, split);
    this.analysis = null;
    this.style = null;
  }

  private analyzeScalar(scalar: string): ScalarAnalysis {
    if (!scalar) {
      return {
        scalar, empty: true, multiline: false, allowFlowPlain: false, allowBlockPlain: true,
        allowSingleQuoted: true, allowDoubleQuoted: true, allowBlock: false,
      };
    }
    const chars = Array.from(scalar);
    let blockIndicators = false;
    let flowIndicators = false;
    let lineBreaks = false;
    let specialCharacters = false;
    let leadingSpace = false;
    let leadingBreak = false;
    let trailingSpace = false;
    let trailingBreak = false;
    let breakSpace = false;
    let spaceBreak = false;
    if (scalar.startsWith('---') || scalar.startsWith('...')) {
      blockIndicators = true;
      flowIndicators = true;
    }
    let precededByWhitespace = true;
    let followedByWhitespace = chars.length === 1 || WS_ALL.includes(chars[1]);
    let previousSpace = false;
    let previousBreak = false;
    let index = 0;
    while (index < chars.length) {
      const ch = chars[index];
      if (index === 0) {
        if ("#,[]{}&*!|>'\"%@`".includes(ch)) {
          flowIndicators = true;
          blockIndicators = true;
        }
        if (ch === '?' || ch === ':') {
          flowIndicators = true;
          if (followedByWhitespace) blockIndicators = true;
        }
        if (ch === '-' && followedByWhitespace) {
          flowIndicators = true;
          blockIndicators = true;
        }
      } else {
        if (',?[]{}'.includes(ch)) flowIndicators = true;
        if (ch === ':') {
          flowIndicators = true;
          if (followedByWhitespace) blockIndicators = true;
        }
        if (ch === '#' && precededByWhitespace) {
          flowIndicators = true;
          blockIndicators = true;
        }
      }
      if (LINE_BREAKS.includes(ch)) lineBreaks = true;
      const cp = ch.codePointAt(0)!;
      if (!(ch === '\n' || (cp >= 0x20 && cp <= 0x7e))) {
        if (
          (cp === 0x85 || (cp >= 0xa0 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) ||
            (cp >= 0x10000 && cp < 0x10ffff)) &&
          cp !== 0xfeff
        ) {
          if (!this.allowUnicode) specialCharacters = true;
        } else {
          specialCharacters = true;
        }
      }
      if (ch === ' ') {
        if (index === 0) leadingSpace = true;
        if (index === chars.length - 1) trailingSpace = true;
        if (previousBreak) breakSpace = true;
        previousSpace = true;
        previousBreak = false;
      } else if (LINE_BREAKS.includes(ch)) {
        if (index === 0) leadingBreak = true;
        if (index === chars.length - 1) trailingBreak = true;
        if (previousSpace) spaceBreak = true;
        previousSpace = false;
        previousBreak = true;
      } else {
        previousSpace = false;
        previousBreak = false;
      }
      index += 1;
      precededByWhitespace = WS_ALL.includes(ch);
      followedByWhitespace = index + 1 >= chars.length || WS_ALL.includes(chars[index + 1]);
    }
    let allowFlowPlain = true;
    let allowBlockPlain = true;
    let allowSingleQuoted = true;
    const allowDoubleQuoted = true;
    let allowBlock = true;
    if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) {
      allowFlowPlain = allowBlockPlain = false;
    }
    if (trailingSpace) allowBlock = false;
    if (breakSpace) allowFlowPlain = allowBlockPlain = allowSingleQuoted = false;
    if (spaceBreak || specialCharacters) {
      allowFlowPlain = allowBlockPlain = allowSingleQuoted = allowBlock = false;
    }
    if (lineBreaks) allowFlowPlain = allowBlockPlain = false;
    if (flowIndicators) allowFlowPlain = false;
    if (blockIndicators) allowBlockPlain = false;
    return {
      scalar, empty: false, multiline: lineBreaks, allowFlowPlain, allowBlockPlain,
      allowSingleQuoted, allowDoubleQuoted, allowBlock,
    };
  }

  // -- Writers --------------------------------------------------------------

  private writeIndicator(indicator: string, needWhitespace: boolean, whitespace = false, indention = false): void {
    const data = this.whitespace || !needWhitespace ? indicator : ' ' + indicator;
    this.whitespace = whitespace;
    this.indention = this.indention && indention;
    this.column += cpLen(data);
    this.openEnded = false;
    this.write(data);
  }

  private writeIndent(): void {
    const indent = this.indent ?? 0;
    if (!this.indention || this.column > indent || (this.column === indent && !this.whitespace)) {
      this.writeLineBreak();
    }
    if (this.column < indent) {
      this.whitespace = true;
      this.write(' '.repeat(indent - this.column));
      this.column = indent;
    }
  }

  private writeLineBreak(data = '\n'): void {
    this.whitespace = true;
    this.indention = true;
    this.column = 0;
    this.write(data);
  }

  private writeSingleQuoted(textStr: string, split = true): void {
    this.writeIndicator("'", true);
    const text = Array.from(textStr);
    let spaces = false;
    let breaks = false;
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch: string | null = end < text.length ? text[end] : null;
      if (spaces) {
        if (ch === null || ch !== ' ') {
          if (start + 1 === end && this.column > this.bestWidth && split && start !== 0 && end !== text.length) {
            this.writeIndent();
          } else {
            const data = text.slice(start, end).join('');
            this.column += end - start;
            this.write(data);
          }
          start = end;
        }
      } else if (breaks) {
        if (ch === null || !LINE_BREAKS.includes(ch)) {
          if (text[start] === '\n') this.writeLineBreak();
          for (const br of text.slice(start, end)) {
            if (br === '\n') this.writeLineBreak();
            else this.writeLineBreak(br);
          }
          this.writeIndent();
          start = end;
        }
      } else {
        if (ch === null || (' ' + LINE_BREAKS).includes(ch) || ch === "'") {
          if (start < end) {
            this.column += end - start;
            this.write(text.slice(start, end).join(''));
            start = end;
          }
        }
      }
      if (ch === "'") {
        this.column += 2;
        this.write("''");
        start = end + 1;
      }
      if (ch !== null) {
        spaces = ch === ' ';
        breaks = LINE_BREAKS.includes(ch);
      }
      end += 1;
    }
    this.writeIndicator("'", false);
  }

  private writeDoubleQuoted(textStr: string, split = true): void {
    this.writeIndicator('"', true);
    const text = Array.from(textStr);
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch: string | null = end < text.length ? text[end] : null;
      const cp = ch === null ? -1 : ch.codePointAt(0)!;
      if (
        ch === null ||
        '"\\\x85  ﻿'.includes(ch) ||
        !(
          (cp >= 0x20 && cp <= 0x7e) ||
          (this.allowUnicode && ((cp >= 0xa0 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd)))
        )
      ) {
        if (start < end) {
          this.column += end - start;
          this.write(text.slice(start, end).join(''));
          start = end;
        }
        if (ch !== null) {
          let data: string;
          if (ch in EMIT_ESCAPES) data = '\\' + EMIT_ESCAPES[ch];
          else if (cp <= 0xff) data = '\\x' + cp.toString(16).toUpperCase().padStart(2, '0');
          else if (cp <= 0xffff) data = '\\u' + cp.toString(16).toUpperCase().padStart(4, '0');
          else data = '\\U' + cp.toString(16).toUpperCase().padStart(8, '0');
          this.column += data.length;
          this.write(data);
          start = end + 1;
        }
      }
      if (
        end > 0 && end < text.length - 1 &&
        (ch === ' ' || start >= end) &&
        this.column + (end - start) > this.bestWidth &&
        split
      ) {
        const data = text.slice(start, end).join('') + '\\';
        if (start < end) start = end;
        this.column += cpLen(data);
        this.write(data);
        this.writeIndent();
        this.whitespace = false;
        this.indention = false;
        if (text[start] === ' ') {
          this.column += 1;
          this.write('\\');
        }
      }
      end += 1;
    }
    this.writeIndicator('"', false);
  }

  private determineBlockHints(text: string[]): string {
    let hints = '';
    if (text.length) {
      if ((' ' + LINE_BREAKS).includes(text[0])) hints += String(this.bestIndent);
      if (!LINE_BREAKS.includes(text[text.length - 1])) hints += '-';
      else if (text.length === 1 || LINE_BREAKS.includes(text[text.length - 2])) hints += '+';
    }
    return hints;
  }

  private writeFolded(textStr: string): void {
    const text = Array.from(textStr);
    const hints = this.determineBlockHints(text);
    this.writeIndicator('>' + hints, true);
    if (hints.endsWith('+')) this.openEnded = true;
    this.writeLineBreak();
    let leadingSpace = true;
    let spaces = false;
    let breaks = true;
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch: string | null = end < text.length ? text[end] : null;
      if (breaks) {
        if (ch === null || !LINE_BREAKS.includes(ch)) {
          if (!leadingSpace && ch !== null && ch !== ' ' && text[start] === '\n') this.writeLineBreak();
          leadingSpace = ch === ' ';
          for (const br of text.slice(start, end)) {
            if (br === '\n') this.writeLineBreak();
            else this.writeLineBreak(br);
          }
          if (ch !== null) this.writeIndent();
          start = end;
        }
      } else if (spaces) {
        if (ch !== ' ') {
          if (start + 1 === end && this.column > this.bestWidth) {
            this.writeIndent();
          } else {
            this.column += end - start;
            this.write(text.slice(start, end).join(''));
          }
          start = end;
        }
      } else if (ch === null || (' ' + LINE_BREAKS).includes(ch)) {
        this.column += end - start;
        this.write(text.slice(start, end).join(''));
        if (ch === null) this.writeLineBreak();
        start = end;
      }
      if (ch !== null) {
        breaks = LINE_BREAKS.includes(ch);
        spaces = ch === ' ';
      }
      end += 1;
    }
  }

  private writeLiteral(textStr: string): void {
    const text = Array.from(textStr);
    const hints = this.determineBlockHints(text);
    this.writeIndicator('|' + hints, true);
    if (hints.endsWith('+')) this.openEnded = true;
    this.writeLineBreak();
    let breaks = true;
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch: string | null = end < text.length ? text[end] : null;
      if (breaks) {
        if (ch === null || !LINE_BREAKS.includes(ch)) {
          for (const br of text.slice(start, end)) {
            if (br === '\n') this.writeLineBreak();
            else this.writeLineBreak(br);
          }
          if (ch !== null) this.writeIndent();
          start = end;
        }
      } else if (ch === null || LINE_BREAKS.includes(ch)) {
        this.column += end - start;
        this.write(text.slice(start, end).join(''));
        if (ch === null) this.writeLineBreak();
        start = end;
      }
      if (ch !== null) breaks = LINE_BREAKS.includes(ch);
      end += 1;
    }
  }

  private writePlain(textStr: string, split = true): void {
    if (this.rootContext) this.openEnded = true;
    if (!textStr) return;
    if (!this.whitespace) {
      this.column += 1;
      this.write(' ');
    }
    this.whitespace = false;
    this.indention = false;
    const text = Array.from(textStr);
    let spaces = false;
    let breaks = false;
    let start = 0;
    let end = 0;
    while (end <= text.length) {
      const ch: string | null = end < text.length ? text[end] : null;
      if (spaces) {
        if (ch !== ' ') {
          if (start + 1 === end && this.column > this.bestWidth && split) {
            this.writeIndent();
            this.whitespace = false;
            this.indention = false;
          } else {
            this.column += end - start;
            this.write(text.slice(start, end).join(''));
          }
          start = end;
        }
      } else if (breaks) {
        if (ch === null || !LINE_BREAKS.includes(ch)) {
          if (text[start] === '\n') this.writeLineBreak();
          for (const br of text.slice(start, end)) {
            if (br === '\n') this.writeLineBreak();
            else this.writeLineBreak(br);
          }
          this.writeIndent();
          this.whitespace = false;
          this.indention = false;
          start = end;
        }
      } else if (ch === null || (' ' + LINE_BREAKS).includes(ch)) {
        this.column += end - start;
        this.write(text.slice(start, end).join(''));
        start = end;
      }
      if (ch !== null) {
        spaces = ch === ' ';
        breaks = LINE_BREAKS.includes(ch);
      }
      end += 1;
    }
  }
}

// ============================================================================
// Public dumping API
// ============================================================================

/**
 * Serialize a value to YAML with PyYAML `yaml.safe_dump` semantics
 * (sort_keys=True, default_flow_style=False, allow_unicode=False by default).
 */
export function dumpYaml(value: unknown, opts: DumpYamlOptions = {}): string {
  const rep = new Representer({
    sortKeys: opts.sortKeys ?? true,
    defaultFlowStyle: opts.defaultFlowStyle === undefined ? false : opts.defaultFlowStyle,
    defaultStyle: opts.defaultStyle ?? null,
  });
  const node = rep.represent(value);
  const events = serialize(node, !!opts.explicitStart, !!opts.explicitEnd);
  return new Emitter(events, opts).run();
}

/** Alias of {@link dumpYaml} named after PyYAML. */
export const safeDump = dumpYaml;
