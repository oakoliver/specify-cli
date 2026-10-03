/**
 * @oakoliver/specify-cli - Console
 *
 * Port of upstream `_console.py`: the single source of console instances and
 * terminal UI helpers. Implements a subset of Rich:
 *
 * - Rich markup (`[red]..[/red]`, `[bold cyan]`, `[/]`, `[link=URL]`, `\[` escapes)
 *   rendered to ANSI SGR sequences, or plain text when colour is disabled
 *   (stream is not a TTY, `NO_COLOR`, `TERM=dumb`; `FORCE_COLOR` forces colour).
 * - `escapeMarkup()` == `rich.markup.escape`.
 * - Minimal `Table`, `Panel`, `Tree`, `Text` renderables.
 * - `CliExit` (== `typer.Exit`), `CliAbort` (== `typer.Abort`).
 * - `confirm()` / `prompt()` (== `typer.confirm` / `typer.prompt`),
 *   `selectWithArrows()`, `isInteractive()`, `StepTracker`, `showBanner()`.
 *
 * Deviation: Rich hard-wraps long lines at the console width when not
 * soft-wrapping; this port never wraps free text (equivalent to
 * `soft_wrap=True`), only tables/panels are fitted to the width.
 *
 * @module console
 */

import { emitKeypressEvents } from 'node:readline';

// ============================================================================
// Exit / abort
// ============================================================================

/** Equivalent of `typer.Exit(code)`: terminate the command with an exit code. */
export class CliExit extends Error {
  readonly code: number;
  constructor(code = 0) {
    super(`Exit(${code})`);
    this.name = 'CliExit';
    this.code = code;
  }
}

/** Equivalent of `typer.Abort()` / `click.Abort`: prints "Aborted!" and exits 1. */
export class CliAbort extends CliExit {
  constructor() {
    super(1);
    this.name = 'CliAbort';
    this.message = 'Aborted!';
  }
}

// ============================================================================
// Markup
// ============================================================================

const RE_ESCAPE = /(\\*)(\[[a-z#/@][^[]*?])/g;

/** Port of `rich.markup.escape`: escape text so it is not parsed as markup. */
export function escapeMarkup(markup: string): string {
  let out = markup.replace(RE_ESCAPE, (_m, backslashes: string, text: string) => `${backslashes}${backslashes}\\${text}`);
  if (out.endsWith('\\') && !out.endsWith('\\\\')) out += '\\';
  return out;
}

/** A styled run of text. */
export interface Segment {
  text: string;
  style: string;
}

const RE_TAGS = /(\\*)\[([a-z#/@][^[]*?)]/g;

/**
 * Parse Rich markup into styled segments (port of `rich.markup.render`).
 * Unknown/mismatched closing tags are ignored instead of raising.
 */
export function parseMarkup(markup: string, baseStyle = ''): Segment[] {
  const segments: Segment[] = [];
  const stack: string[] = [];
  const current = (): string => [baseStyle, ...stack].filter(Boolean).join(' ');
  let pos = 0;
  const push = (text: string): void => {
    if (!text) return;
    const style = current();
    const last = segments[segments.length - 1];
    if (last && last.style === style) last.text += text;
    else segments.push({ text, style });
  };
  RE_TAGS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_TAGS.exec(markup)) !== null) {
    const [full, backslashes, tag] = m;
    const start = m.index;
    push(markup.slice(pos, start));
    pos = start + full.length;
    if (backslashes) {
      const [lit, escaped] = [Math.floor(backslashes.length / 2), backslashes.length % 2 === 1];
      push('\\'.repeat(lit));
      if (escaped) {
        push(`[${tag}]`);
        continue;
      }
    }
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      if (!name) {
        stack.pop();
      } else {
        const idx = stack.lastIndexOf(name);
        if (idx >= 0) stack.splice(idx, 1);
        else if (name === 'link') {
          const li = findLastIndex(stack, (s) => s.startsWith('link '));
          if (li >= 0) stack.splice(li, 1);
        }
      }
    } else if (tag.startsWith('link=')) {
      stack.push(`link ${tag.slice(5)}`);
    } else if (tag.startsWith('@')) {
      // Event handlers are meaningless for a terminal; treat as a no-op style.
      stack.push('');
    } else {
      stack.push(tag);
    }
  }
  push(markup.slice(pos));
  return segments;
}

function findLastIndex<T>(arr: T[], fn: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i])) return i;
  return -1;
}

/** Remove markup, returning the plain text that would be displayed. */
export function stripMarkup(markup: string): string {
  return parseMarkup(markup).map((s) => s.text).join('');
}

// ============================================================================
// Styles -> ANSI
// ============================================================================

const STANDARD_COLORS: Record<string, number> = {
  black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7,
  bright_black: 8, bright_red: 9, bright_green: 10, bright_yellow: 11, bright_blue: 12,
  bright_magenta: 13, bright_cyan: 14, bright_white: 15,
};

const EXTRA_256: Record<string, number> = {
  orange1: 214, orange3: 172, dark_orange: 208, gold1: 220, purple: 129, violet: 177,
  deep_sky_blue1: 39, dodger_blue1: 33, spring_green1: 48, light_green: 119,
  hot_pink: 205, pink1: 218, turquoise2: 45, dark_green: 22, navy_blue: 17, sky_blue1: 117,
};

function greyIndex(n: number): number | null {
  // Rich's grey names map to 256-colour palette entries.
  const table: Record<number, number> = {
    0: 16, 3: 232, 7: 233, 11: 234, 15: 235, 19: 236, 23: 237, 27: 238, 30: 239, 35: 240,
    37: 59, 39: 241, 42: 242, 46: 243, 50: 244, 53: 102, 54: 245, 58: 246, 62: 247, 63: 139,
    66: 248, 69: 145, 70: 249, 74: 250, 78: 251, 82: 252, 84: 188, 85: 253, 89: 254, 93: 255, 100: 231,
  };
  return table[n] ?? null;
}

function colorCode(name: string, background: boolean): string | null {
  const n = name.toLowerCase();
  if (n === 'default') return background ? '49' : '39';
  if (n in STANDARD_COLORS) {
    const idx = STANDARD_COLORS[n];
    if (idx < 8) return String((background ? 40 : 30) + idx);
    return String((background ? 100 : 90) + idx - 8);
  }
  const grey = /^gr[ae]y(\d+)$/.exec(n);
  if (grey) {
    const idx = greyIndex(parseInt(grey[1], 10));
    if (idx !== null) return `${background ? 48 : 38};5;${idx}`;
    return null;
  }
  if (n in EXTRA_256) return `${background ? 48 : 38};5;${EXTRA_256[n]}`;
  const c = /^color\((\d{1,3})\)$/.exec(n);
  if (c) return `${background ? 48 : 38};5;${parseInt(c[1], 10)}`;
  const hex = /^#([0-9a-f]{6})$/.exec(n);
  if (hex) {
    const v = parseInt(hex[1], 16);
    return `${background ? 48 : 38};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`;
  }
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(n);
  if (rgb) return `${background ? 48 : 38};2;${rgb[1]};${rgb[2]};${rgb[3]}`;
  return null;
}

const ATTRS: Record<string, string> = {
  bold: '1', b: '1', dim: '2', d: '2', italic: '3', i: '3', underline: '4', u: '4',
  blink: '5', reverse: '7', r: '7', conceal: '8', strike: '9', s: '9',
};

/** Convert a Rich style string into `{ sgr, link }`. Unknown words are ignored. */
export function styleToAnsi(style: string): { sgr: string[]; link: string | null } {
  const sgr: string[] = [];
  let link: string | null = null;
  const words = style.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const lw = w.toLowerCase();
    if (lw === 'link') {
      link = words[i + 1] ?? null;
      i++;
      continue;
    }
    if (lw === 'not') {
      i++;
      continue;
    }
    if (lw === 'on') {
      const bg = words[i + 1] ? colorCode(words[i + 1], true) : null;
      if (bg) sgr.push(bg);
      i++;
      continue;
    }
    if (lw in ATTRS) {
      sgr.push(ATTRS[lw]);
      continue;
    }
    const fg = colorCode(lw, false);
    if (fg) sgr.push(fg);
  }
  return { sgr, link };
}

/** Render segments as a string (ANSI when `color`). */
export function renderSegments(segments: Segment[], color: boolean): string {
  if (!color) return segments.map((s) => s.text).join('');
  let out = '';
  for (const seg of segments) {
    if (!seg.style) {
      out += seg.text;
      continue;
    }
    const { sgr, link } = styleToAnsi(seg.style);
    let text = seg.text;
    if (sgr.length) {
      // Re-apply style per line so that wrapping/borders don't bleed.
      text = text
        .split('\n')
        .map((line) => (line ? `\x1b[${sgr.join(';')}m${line}\x1b[0m` : line))
        .join('\n');
    }
    if (link) text = `\x1b]8;;${link}\x1b\\${text}\x1b]8;;\x1b\\`;
    out += text;
  }
  return out;
}

/** Render markup straight to a string. */
export function renderMarkup(markup: string, color: boolean, baseStyle = ''): string {
  return renderSegments(parseMarkup(markup, baseStyle), color);
}

// ============================================================================
// Cell width
// ============================================================================

/** Approximate terminal cell width of a code point (wide CJK/emoji = 2). */
function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0; // combining
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Terminal cell width of plain text (no markup, no ANSI). */
export function cellLen(text: string): number {
  let n = 0;
  for (const ch of text) n += charWidth(ch.codePointAt(0)!);
  return n;
}

// ============================================================================
// Lines of segments (used by renderables)
// ============================================================================

type Line = Segment[];

function lineLen(line: Line): number {
  return line.reduce((n, s) => n + cellLen(s.text), 0);
}

function splitLines(segments: Segment[]): Line[] {
  const lines: Line[] = [[]];
  for (const seg of segments) {
    const parts = seg.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, style: seg.style });
    });
  }
  return lines;
}

/** Word-wrap one line of segments to `width` cells. */
function wrapLine(line: Line, width: number): Line[] {
  if (width <= 0 || lineLen(line) <= width) return [line];
  // Flatten into characters with style.
  const chars: Array<{ ch: string; style: string }> = [];
  for (const seg of line) for (const ch of seg.text) chars.push({ ch, style: seg.style });
  const out: Line[] = [];
  let start = 0;
  while (start < chars.length) {
    let w = 0;
    let end = start;
    let lastSpace = -1;
    while (end < chars.length) {
      const cw = charWidth(chars[end].ch.codePointAt(0)!);
      if (w + cw > width) break;
      if (chars[end].ch === ' ') lastSpace = end;
      w += cw;
      end++;
    }
    if (end < chars.length && lastSpace > start) end = lastSpace + 1;
    const slice = chars.slice(start, end);
    // Trim trailing spaces of wrapped lines.
    while (end < chars.length && slice.length && slice[slice.length - 1].ch === ' ') slice.pop();
    out.push(mergeChars(slice));
    start = end;
    while (start < chars.length && chars[start].ch === ' ' && out.length) start++;
  }
  return out.length ? out : [[]];
}

function mergeChars(chars: Array<{ ch: string; style: string }>): Line {
  const line: Line = [];
  for (const c of chars) {
    const last = line[line.length - 1];
    if (last && last.style === c.style) last.text += c.ch;
    else line.push({ text: c.ch, style: c.style });
  }
  return line;
}

function padLine(line: Line, width: number, justify: 'left' | 'right' | 'center' = 'left', style = ''): Line {
  const len = lineLen(line);
  const gap = Math.max(0, width - len);
  if (!gap) return line;
  if (justify === 'right') return [{ text: ' '.repeat(gap), style }, ...line];
  if (justify === 'center') {
    const left = Math.floor(gap / 2);
    return [{ text: ' '.repeat(left), style }, ...line, { text: ' '.repeat(gap - left), style }];
  }
  return [...line, { text: ' '.repeat(gap), style }];
}

function styleLine(line: Line, style: string): Line {
  if (!style) return line;
  return line.map((s) => ({ text: s.text, style: s.style ? `${style} ${s.style}` : style }));
}

// ============================================================================
// Renderables
// ============================================================================

/** Something that can render itself into lines for a given width. */
export interface Renderable {
  renderLines(width: number): Line[];
  /** Minimum/natural width measurement. */
  measure?(maxWidth: number): number;
}

export type RenderableLike = string | number | Renderable | Text | null | undefined;

function isRenderable(x: unknown): x is Renderable {
  return typeof x === 'object' && x !== null && typeof (x as Renderable).renderLines === 'function';
}

function toLines(obj: RenderableLike, width: number, markup = true, baseStyle = ''): Line[] {
  if (obj === null || obj === undefined) return [[]];
  if (isRenderable(obj)) return obj.renderLines(width);
  const text = String(obj);
  const segs = markup ? parseMarkup(text, baseStyle) : [{ text, style: baseStyle }];
  return splitLines(segs);
}

function measureObj(obj: RenderableLike, maxWidth: number): number {
  if (obj === null || obj === undefined) return 0;
  if (isRenderable(obj)) return obj.measure ? obj.measure(maxWidth) : maxWidth;
  return Math.max(0, ...splitLines(parseMarkup(String(obj))).map(lineLen));
}

/** Styled text builder (subset of `rich.text.Text`). */
export class Text implements Renderable {
  private segments: Segment[] = [];
  justify: 'left' | 'right' | 'center' = 'left';

  constructor(text = '', public style = '') {
    if (text) this.segments.push({ text, style });
  }

  /** Build from markup (`Text.from_markup`). */
  static fromMarkup(markup: string, style = ''): Text {
    const t = new Text('', style);
    t.segments = parseMarkup(markup, style);
    return t;
  }

  append(text: string, style = ''): this {
    this.segments.push({ text, style: [this.style, style].filter(Boolean).join(' ') });
    return this;
  }

  get plain(): string {
    return this.segments.map((s) => s.text).join('');
  }

  renderLines(width: number): Line[] {
    const lines = splitLines(this.segments.length ? this.segments : [{ text: '', style: this.style }]);
    if (this.justify === 'left') return lines;
    return lines.map((l) => padLine(l, width, this.justify));
  }

  measure(): number {
    return Math.max(0, ...splitLines(this.segments).map(lineLen));
  }
}

/** Center a renderable horizontally (`rich.align.Align.center`). */
export class Align implements Renderable {
  constructor(private renderable: RenderableLike, private align: 'left' | 'center' | 'right' = 'center') {}

  static center(renderable: RenderableLike): Align {
    return new Align(renderable, 'center');
  }

  renderLines(width: number): Line[] {
    const lines = toLines(this.renderable, width);
    const w = Math.max(0, ...lines.map(lineLen));
    // Like Rich: align the block by its widest line, then pad to the full width.
    return lines.map((l) => {
      const padded = padLine(l, w, 'left');
      const gap = Math.max(0, width - w);
      const left = this.align === 'left' ? 0 : this.align === 'right' ? gap : Math.floor(gap / 2);
      return [{ text: ' '.repeat(left), style: '' }, ...padded, { text: ' '.repeat(gap - left), style: '' }];
    });
  }
}

function trimRight(line: Line): Line {
  const out = line.map((s) => ({ ...s }));
  while (out.length) {
    const last = out[out.length - 1];
    const trimmed = last.text.replace(/ +$/, '');
    if (trimmed.length === last.text.length) break;
    if (trimmed) {
      last.text = trimmed;
      break;
    }
    out.pop();
  }
  return out;
}

// -- Boxes -------------------------------------------------------------------

interface BoxChars {
  topLeft: string; top: string; topDivider: string; topRight: string;
  headLeft: string; headVertical: string; headRight: string;
  headRowLeft: string; headRowHorizontal: string; headRowCross: string; headRowRight: string;
  midLeft: string; vertical: string; midRight: string;
  rowLeft: string; rowHorizontal: string; rowCross: string; rowRight: string;
  bottomLeft: string; bottom: string; bottomDivider: string; bottomRight: string;
}

const HEAVY_HEAD: BoxChars = {
  topLeft: '┏', top: '━', topDivider: '┳', topRight: '┓',
  headLeft: '┃', headVertical: '┃', headRight: '┃',
  headRowLeft: '┡', headRowHorizontal: '━', headRowCross: '╇', headRowRight: '┩',
  midLeft: '│', vertical: '│', midRight: '│',
  rowLeft: '├', rowHorizontal: '─', rowCross: '┼', rowRight: '┤',
  bottomLeft: '└', bottom: '─', bottomDivider: '┴', bottomRight: '┘',
};

const ROUNDED: BoxChars = {
  topLeft: '╭', top: '─', topDivider: '┬', topRight: '╮',
  headLeft: '│', headVertical: '│', headRight: '│',
  headRowLeft: '├', headRowHorizontal: '─', headRowCross: '┼', headRowRight: '┤',
  midLeft: '│', vertical: '│', midRight: '│',
  rowLeft: '├', rowHorizontal: '─', rowCross: '┼', rowRight: '┤',
  bottomLeft: '╰', bottom: '─', bottomDivider: '┴', bottomRight: '╯',
};

const SQUARE: BoxChars = {
  topLeft: '┌', top: '─', topDivider: '┬', topRight: '┐',
  headLeft: '│', headVertical: '│', headRight: '│',
  headRowLeft: '├', headRowHorizontal: '─', headRowCross: '┼', headRowRight: '┤',
  midLeft: '│', vertical: '│', midRight: '│',
  rowLeft: '├', rowHorizontal: '─', rowCross: '┼', rowRight: '┤',
  bottomLeft: '└', bottom: '─', bottomDivider: '┴', bottomRight: '┘',
};

/** Box styles available to `Table` / `Panel`. */
export const BOX = { HEAVY_HEAD, ROUNDED, SQUARE } as const;

type Padding = number | [number, number] | [number, number, number, number];

function normalizePadding(p: Padding): [number, number, number, number] {
  if (typeof p === 'number') return [p, p, p, p];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  return p;
}

// -- Panel -------------------------------------------------------------------

export interface PanelOptions {
  title?: string | null;
  subtitle?: string | null;
  borderStyle?: string;
  padding?: Padding;
  expand?: boolean;
  box?: BoxChars;
  width?: number;
  titleAlign?: 'left' | 'center' | 'right';
  style?: string;
}

/** Bordered box around content (subset of `rich.panel.Panel`). */
export class Panel implements Renderable {
  constructor(public renderable: RenderableLike, public opts: PanelOptions = {}) {}

  /** `Panel.fit(...)`: shrink to content width. */
  static fit(renderable: RenderableLike, opts: PanelOptions = {}): Panel {
    return new Panel(renderable, { ...opts, expand: false });
  }

  measure(maxWidth: number): number {
    const [, r, , l] = normalizePadding(this.opts.padding ?? [0, 1]);
    const inner = measureObj(this.renderable, maxWidth - 2 - l - r);
    const title = this.opts.title ? cellLen(stripMarkup(this.opts.title)) + 4 : 0;
    return Math.min(maxWidth, Math.max(inner + 2 + l + r, title + 2));
  }

  renderLines(width: number): Line[] {
    const box = this.opts.box ?? ROUNDED;
    const border = this.opts.borderStyle ?? '';
    const [pt, pr, pb, pl] = normalizePadding(this.opts.padding ?? [0, 1]);
    const expand = this.opts.expand ?? true;
    let total = this.opts.width ?? (expand ? width : this.measure(width));
    total = Math.max(4, Math.min(total, width));
    const innerWidth = Math.max(1, total - 2 - pl - pr);
    const content: Line[] = [];
    for (const l of toLines(this.renderable, innerWidth)) content.push(...wrapLine(l, innerWidth));
    const out: Line[] = [];
    const edge = (left: string, fill: string, right: string, title: string | null | undefined): Line => {
      const avail = total - 2;
      if (!title) return [{ text: left + fill.repeat(avail) + right, style: border }];
      let titleLine = parseMarkup(title);
      let tl = lineLen(titleLine);
      if (tl + 2 > avail) {
        titleLine = wrapLine(titleLine, Math.max(1, avail - 2))[0];
        tl = lineLen(titleLine);
      }
      const rest = avail - tl - 2;
      const align = this.opts.titleAlign ?? 'center';
      const leftN = align === 'left' ? 1 : align === 'right' ? rest - 1 : Math.floor(rest / 2);
      const rightN = rest - leftN;
      return [
        { text: left + fill.repeat(leftN) + ' ', style: border },
        ...titleLine,
        { text: ' ' + fill.repeat(rightN) + right, style: border },
      ];
    };
    out.push(edge(box.topLeft, box.top, box.topRight, this.opts.title));
    const blank = (): Line => [
      { text: box.midLeft, style: border },
      { text: ' '.repeat(total - 2), style: '' },
      { text: box.midRight, style: border },
    ];
    for (let i = 0; i < pt; i++) out.push(blank());
    for (const line of content) {
      out.push([
        { text: box.midLeft, style: border },
        { text: ' '.repeat(pl), style: '' },
        ...padLine(line, innerWidth),
        { text: ' '.repeat(pr), style: '' },
        { text: box.midRight, style: border },
      ]);
    }
    for (let i = 0; i < pb; i++) out.push(blank());
    out.push(edge(box.bottomLeft, box.bottom, box.bottomRight, this.opts.subtitle));
    return out;
  }
}

// -- Table -------------------------------------------------------------------

export interface ColumnOptions {
  style?: string;
  headerStyle?: string;
  justify?: 'left' | 'right' | 'center';
  noWrap?: boolean;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  ratio?: number;
  overflow?: 'fold' | 'crop' | 'ellipsis';
}

interface Column extends ColumnOptions {
  header: string;
}

export interface TableOptions {
  title?: string | null;
  showHeader?: boolean;
  headerStyle?: string;
  box?: BoxChars | null;
  padding?: Padding;
  showLines?: boolean;
  expand?: boolean;
  borderStyle?: string;
  titleStyle?: string;
  showEdge?: boolean;
  width?: number;
  /** Pad the outer edges of the first/last column (default true; grids use false). */
  padEdge?: boolean;
  /** Collapse adjacent column padding (default false; grids use true). */
  collapsePadding?: boolean;
}

/** Tabular renderable (subset of `rich.table.Table`). */
export class Table implements Renderable {
  columns: Column[] = [];
  rows: RenderableLike[][] = [];
  opts: TableOptions;

  constructor(opts: TableOptions = {}) {
    this.opts = opts;
  }

  /** `Table.grid(padding=...)`: no box, no header. */
  static grid(opts: { padding?: Padding; expand?: boolean } = {}): Table {
    return new Table({
      box: null, showHeader: false, padding: opts.padding ?? 0, expand: opts.expand, showEdge: false,
      padEdge: false, collapsePadding: true,
    });
  }

  addColumn(header = '', opts: ColumnOptions = {}): this {
    this.columns.push({ header, ...opts });
    return this;
  }

  addRow(...cells: RenderableLike[]): this {
    while (this.columns.length < cells.length) this.columns.push({ header: '' });
    this.rows.push(cells);
    return this;
  }

  private padding(): [number, number, number, number] {
    return normalizePadding(this.opts.padding ?? [0, 1]);
  }

  /** Per-column [left, right] padding following Rich's pad_edge/collapse_padding rules. */
  private columnPadding(): Array<[number, number]> {
    const [, right0, , left0] = this.padding();
    const n = this.columns.length;
    const padEdge = this.opts.padEdge ?? true;
    const collapse = this.opts.collapsePadding ?? false;
    return this.columns.map((_, ci) => {
      let left = left0;
      let right = right0;
      if (collapse && ci > 0) left = Math.max(0, left - right0);
      if (!padEdge) {
        if (ci === 0) left = 0;
        if (ci === n - 1) right = 0;
      }
      return [left, right];
    });
  }

  private naturalWidths(maxWidth: number): number[] {
    const showHeader = this.opts.showHeader ?? true;
    return this.columns.map((col, ci) => {
      if (col.width) return col.width;
      let w = showHeader ? cellLen(stripMarkup(col.header)) : 0;
      for (const row of this.rows) w = Math.max(w, measureObj(row[ci], maxWidth));
      if (col.minWidth) w = Math.max(w, col.minWidth);
      if (col.maxWidth) w = Math.min(w, col.maxWidth);
      return w;
    });
  }

  measure(maxWidth: number): number {
    const pads = this.columnPadding();
    const widths = this.naturalWidths(maxWidth);
    const boxed = this.opts.box !== null;
    const extra = boxed ? this.columns.length + 1 : 0;
    const total = widths.reduce((a, b, i) => a + b + pads[i][0] + pads[i][1], 0) + extra;
    return Math.min(maxWidth, total);
  }

  renderLines(width: number): Line[] {
    const box = this.opts.box === null ? null : (this.opts.box ?? HEAVY_HEAD);
    const border = this.opts.borderStyle ?? '';
    const showHeader = this.opts.showHeader ?? true;
    const [pt, , pb] = this.padding();
    const pads = this.columnPadding();
    const ncol = this.columns.length;
    const edges = box ? ncol + 1 : 0;
    const widths = this.naturalWidths(width);
    const padTotal = pads.reduce((a, [l, r]) => a + l + r, 0);
    let total = widths.reduce((a, b) => a + b, 0) + padTotal + edges;
    // Shrink widest wrappable columns until fitting.
    while (total > width) {
      let idx = -1;
      for (let i = 0; i < ncol; i++) {
        if (this.columns[i].noWrap) continue;
        if (idx < 0 || widths[i] > widths[idx]) idx = i;
      }
      if (idx < 0 || widths[idx] <= 4) break;
      widths[idx] -= 1;
      total -= 1;
    }
    if (this.opts.expand && total < width) {
      const extra = width - total;
      widths[ncol - 1] += extra;
      total = width;
    }
    const out: Line[] = [];
    if (this.opts.title) {
      const titleLines = toLines(this.opts.title, total, true, this.opts.titleStyle ?? 'italic');
      for (const l of titleLines) out.push(padLine(l, total, 'center'));
    }
    const renderRow = (cells: RenderableLike[], isHeader: boolean): Line[] => {
      const cellLines = cells.map((cell, ci) => {
        const col = this.columns[ci] ?? { header: '' };
        const style = isHeader ? (col.headerStyle ?? this.opts.headerStyle ?? 'bold') : (col.style ?? '');
        const lines: Line[] = [];
        for (const l of toLines(cell, widths[ci])) {
          const wrapped = col.noWrap ? [l] : wrapLine(l, widths[ci]);
          for (const w of wrapped) lines.push(styleLine(w, style));
        }
        for (let i = 0; i < pt; i++) lines.unshift([]);
        for (let i = 0; i < pb; i++) lines.push([]);
        return lines;
      });
      while (cellLines.length < ncol) cellLines.push([[]]);
      const height = Math.max(1, ...cellLines.map((c) => c.length));
      const rowsOut: Line[] = [];
      const vert = box ? (isHeader ? box.headVertical : box.vertical) : '';
      const left = box ? (isHeader ? box.headLeft : box.midLeft) : '';
      const right = box ? (isHeader ? box.headRight : box.midRight) : '';
      for (let h = 0; h < height; h++) {
        const line: Line = [];
        if (box) line.push({ text: left, style: border });
        for (let ci = 0; ci < ncol; ci++) {
          const col = this.columns[ci];
          const cl = cellLines[ci][h] ?? [];
          line.push({ text: ' '.repeat(pads[ci][0]), style: '' });
          line.push(...padLine(cl, widths[ci], col.justify ?? 'left'));
          line.push({ text: ' '.repeat(pads[ci][1]), style: '' });
          if (box && ci < ncol - 1) line.push({ text: vert, style: border });
        }
        if (box) line.push({ text: right, style: border });
        rowsOut.push(box ? line : trimRight(line));
      }
      return rowsOut;
    };
    const hline = (l: string, fill: string, cross: string, r: string): Line => [
      { text: l + widths.map((w, i) => fill.repeat(w + pads[i][0] + pads[i][1])).join(cross) + r, style: border },
    ];
    if (box) out.push(hline(box.topLeft, box.top, box.topDivider, box.topRight));
    if (showHeader) {
      out.push(...renderRow(this.columns.map((c) => c.header), true));
      if (box) out.push(hline(box.headRowLeft, box.headRowHorizontal, box.headRowCross, box.headRowRight));
    }
    this.rows.forEach((row, ri) => {
      out.push(...renderRow(row, false));
      if (box && this.opts.showLines && ri < this.rows.length - 1) {
        out.push(hline(box.rowLeft, box.rowHorizontal, box.rowCross, box.rowRight));
      }
    });
    if (box) out.push(hline(box.bottomLeft, box.bottom, box.bottomDivider, box.bottomRight));
    return out;
  }
}

// -- Tree --------------------------------------------------------------------

/** Tree renderable (subset of `rich.tree.Tree`). */
export class Tree implements Renderable {
  children: Tree[] = [];
  constructor(public label: RenderableLike, public opts: { guideStyle?: string; hideRoot?: boolean } = {}) {}

  add(label: RenderableLike, opts: { guideStyle?: string } = {}): Tree {
    const child = new Tree(label, { guideStyle: opts.guideStyle ?? this.opts.guideStyle });
    this.children.push(child);
    return child;
  }

  renderLines(width: number): Line[] {
    const out: Line[] = [];
    const guide = this.opts.guideStyle ?? '';
    const walk = (node: Tree, prefix: Line, isRoot: boolean, isLast: boolean): void => {
      if (!(isRoot && this.opts.hideRoot)) {
        const branch: Line = isRoot ? [] : [{ text: isLast ? '└── ' : '├── ', style: guide }];
        const cont: Line = isRoot ? [] : [{ text: isLast ? '    ' : '│   ', style: guide }];
        const labelLines = toLines(node.label, Math.max(1, width - lineLen(prefix) - 4));
        labelLines.forEach((l, i) => out.push([...prefix, ...(i === 0 ? branch : cont), ...l]));
      }
      const childPrefix: Line = isRoot ? [] : [...prefix, { text: isLast ? '    ' : '│   ', style: guide }];
      node.children.forEach((c, i) => walk(c, childPrefix, false, i === node.children.length - 1));
    };
    walk(this, [], true, true);
    return out;
  }
}

// ============================================================================
// Console
// ============================================================================

/** Minimal writable sink. */
export interface ConsoleSink {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface ConsoleOptions {
  stderr?: boolean;
  highlight?: boolean;
  /** Custom output sink (default: process.stdout / process.stderr at call time). */
  file?: ConsoleSink;
  /** Force colour on/off (default: auto-detect). */
  color?: boolean;
  /** Fixed width (default: terminal columns, `COLUMNS`, else 80). */
  width?: number;
}

export interface PrintOptions {
  style?: string;
  end?: string;
  markup?: boolean;
  highlight?: boolean;
  softWrap?: boolean;
  justify?: 'left' | 'right' | 'center';
  sep?: string;
  noWrap?: boolean;
  overflow?: string;
  crop?: boolean;
  emoji?: boolean;
}

const PRINT_OPTION_KEYS = new Set([
  'style', 'end', 'markup', 'highlight', 'softWrap', 'justify', 'sep', 'noWrap', 'overflow', 'crop', 'emoji',
]);

function isPrintOptions(x: unknown): x is PrintOptions {
  if (typeof x !== 'object' || x === null || Array.isArray(x) || isRenderable(x)) return false;
  if (Object.getPrototypeOf(x) !== Object.prototype) return false;
  const keys = Object.keys(x);
  return keys.length > 0 && keys.every((k) => PRINT_OPTION_KEYS.has(k));
}

/** Rich-like console. `print()` accepts markup strings and renderables. */
export class Console {
  private opts: ConsoleOptions;
  private captureBuf: string[] | null = null;

  constructor(opts: ConsoleOptions = {}) {
    this.opts = opts;
  }

  /** The underlying stream (resolved at call time so tests can spy on it). */
  get file(): ConsoleSink {
    return this.opts.file ?? (this.opts.stderr ? process.stderr : process.stdout);
  }

  set file(sink: ConsoleSink) {
    this.opts.file = sink;
  }

  get isTerminal(): boolean {
    return !!this.file.isTTY;
  }

  /** Whether ANSI styling is emitted. */
  get colorEnabled(): boolean {
    if (this.captureBuf !== null) return false;
    if (this.opts.color !== undefined) return this.opts.color;
    const env = process.env;
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
    if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
    if (env.TERM === 'dumb') return false;
    return this.isTerminal;
  }

  get width(): number {
    if (this.opts.width) return this.opts.width;
    const cols = this.file.columns;
    if (cols && cols > 0) return cols;
    const env = parseInt(process.env.COLUMNS ?? '', 10);
    if (env > 0) return env;
    return 80;
  }

  set width(w: number) {
    this.opts.width = w;
  }

  /** Render objects to a string without writing. */
  renderToString(objects: RenderableLike[], opts: PrintOptions = {}, color = this.colorEnabled): string {
    const markup = opts.markup ?? true;
    const width = this.width;
    const parts: string[] = [];
    const strings: string[] = [];
    const flushStrings = (): void => {
      if (!strings.length) return;
      const text = strings.join(opts.sep ?? ' ');
      strings.length = 0;
      let lines = toLines(text, width, markup, opts.style ?? '');
      // Rich wraps text at the console width unless soft-wrapping. We only wrap
      // for terminals so piped/captured output (scripts, tests) stays one line.
      if (!opts.softWrap && !opts.noWrap && this.isTerminal && this.captureBuf === null) {
        lines = lines.flatMap((l) => wrapLine(l, width));
      }
      if (opts.justify && opts.justify !== 'left') lines = lines.map((l) => padLine(l, width, opts.justify));
      parts.push(lines.map((l) => renderSegments(l, color)).join('\n'));
    };
    for (const obj of objects) {
      if (isRenderable(obj)) {
        flushStrings();
        const lines = obj.renderLines(width).map((l) => styleLine(l, opts.style ?? ''));
        parts.push(lines.map((l) => renderSegments(l, color)).join('\n'));
      } else if (obj !== undefined) {
        strings.push(obj === null ? 'None' : String(obj));
      }
    }
    flushStrings();
    return parts.join('\n') + (opts.end ?? '\n');
  }

  /**
   * Print markup strings / renderables. A trailing plain object with
   * print-option keys (`style`, `end`, `markup`, `softWrap`, ...) is treated
   * as options, mirroring Rich's keyword arguments.
   */
  print(...args: unknown[]): void {
    let opts: PrintOptions = {};
    if (args.length && isPrintOptions(args[args.length - 1])) opts = args.pop() as PrintOptions;
    const out = this.renderToString(args as RenderableLike[], opts);
    this.write(out);
  }

  /** Print text without markup processing (like `typer.echo`). */
  out(text: string, end = '\n'): void {
    this.write(text + end);
  }

  /** Write raw text to the sink. */
  write(text: string): void {
    if (this.captureBuf !== null) {
      this.captureBuf.push(text);
      return;
    }
    this.file.write(text);
  }

  /** Print a horizontal rule, optionally with a title. */
  rule(title = '', style = 'bright_green'): void {
    const w = this.width;
    if (!title) {
      this.write(renderSegments([{ text: '─'.repeat(w), style }], this.colorEnabled) + '\n');
      return;
    }
    const t = parseMarkup(title);
    const tl = lineLen(t);
    const side = Math.max(0, w - tl - 2);
    const left = Math.floor(side / 2);
    const line: Line = [
      { text: '─'.repeat(left) + ' ', style },
      ...t,
      { text: ' ' + '─'.repeat(side - left), style },
    ];
    this.write(renderSegments(line, this.colorEnabled) + '\n');
  }

  /** Start capturing output (`console.begin_capture`). */
  beginCapture(): void {
    this.captureBuf = [];
  }

  /** Stop capturing and return captured plain text (`console.end_capture`). */
  endCapture(): string {
    const out = (this.captureBuf ?? []).join('');
    this.captureBuf = null;
    return out;
  }

  /**
   * Show a transient status spinner while `fn` runs (`console.status`).
   * On non-terminals nothing is printed.
   */
  async status<T>(message: string, fn: () => Promise<T> | T): Promise<T> {
    if (!this.isTerminal || this.captureBuf !== null) return await fn();
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    const text = renderMarkup(message, this.colorEnabled);
    const draw = (): void => {
      this.file.write(`\r\x1b[2K${renderSegments([{ text: frames[i++ % frames.length], style: 'green' }], this.colorEnabled)} ${text}`);
    };
    draw();
    const timer = setInterval(draw, 80);
    try {
      return await fn();
    } finally {
      clearInterval(timer);
      this.file.write('\r\x1b[2K');
    }
  }
}

/** Primary stdout console (`console = Console(highlight=False)`). */
export const console = new Console({ highlight: false });

/** Stderr console for errors/diagnostics (keeps `--json` stdout clean). */
export const errConsole = new Console({ stderr: true, highlight: false });

/** `typer.echo`: write a plain line to stdout (or stderr when `err`). */
export function echo(message = '', opts: { err?: boolean; nl?: boolean } = {}): void {
  const stream = opts.err ? process.stderr : process.stdout;
  stream.write(message + (opts.nl === false ? '' : '\n'));
}

// ============================================================================
// Interactivity helpers
// ============================================================================

/** True when both stdin and stdout are TTYs. */
export function isInteractive(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

/** Shared buffered line reader over process.stdin (works with piped input). */
class StdinLineReader {
  private buffer = '';
  private ended = false;
  private waiters: Array<(line: string | null) => void> = [];
  private attached = false;

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string | Buffer) => {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.drain();
    });
    process.stdin.on('end', () => {
      this.ended = true;
      this.drain();
    });
  }

  private drain(): void {
    while (this.waiters.length) {
      const idx = this.buffer.indexOf('\n');
      if (idx >= 0) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, '');
        this.buffer = this.buffer.slice(idx + 1);
        this.waiters.shift()!(line);
      } else if (this.ended) {
        const rest = this.buffer;
        this.buffer = '';
        this.waiters.shift()!(rest ? rest : null);
      } else {
        break;
      }
    }
    if (!this.waiters.length) process.stdin.pause();
  }

  readLine(): Promise<string | null> {
    this.attach();
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      process.stdin.resume();
      this.drain();
    });
  }
}

let lineReader: StdinLineReader | null = null;

/** Override hook for tests: provide canned answers to prompts. */
let inputProvider: (() => Promise<string | null>) | null = null;

/**
 * Install a function that supplies prompt input (tests). Pass an array to
 * feed lines in order; `null` restores stdin.
 */
export function setPromptInput(input: string[] | (() => Promise<string | null>) | null): void {
  if (input === null) inputProvider = null;
  else if (Array.isArray(input)) {
    const queue = [...input];
    inputProvider = async () => (queue.length ? queue.shift()! : null);
  } else inputProvider = input;
}

/** Read one line from stdin (null on EOF). */
export async function readLine(): Promise<string | null> {
  if (inputProvider) return inputProvider();
  lineReader ??= new StdinLineReader();
  return lineReader.readLine();
}

/**
 * Port of `typer.confirm` (click.confirm): prints `text [y/N]: ` and reads a
 * y/n answer. Throws {@link CliAbort} on EOF (or when `abort` and answer is no).
 */
export async function confirm(text: string, opts: { default?: boolean | null; abort?: boolean } = {}): Promise<boolean> {
  const def = opts.default === undefined ? false : opts.default;
  const suffix = def === null ? ' [y/n]: ' : def ? ' [Y/n]: ' : ' [y/N]: ';
  for (;;) {
    process.stdout.write(text + suffix);
    const raw = await readLine();
    if (raw === null) throw new CliAbort();
    const value = raw.trim().toLowerCase();
    let rv: boolean | null;
    if (value === 'y' || value === 'yes') rv = true;
    else if (value === 'n' || value === 'no') rv = false;
    else if (value === '' && def !== null) rv = def;
    else {
      process.stderr.write('Error: invalid input\n');
      continue;
    }
    if (opts.abort && !rv) throw new CliAbort();
    return rv;
  }
}

/** Port of `typer.prompt` (click.prompt) for text values. */
export async function prompt(
  text: string,
  opts: { default?: string; showDefault?: boolean; hideInput?: boolean } = {},
): Promise<string> {
  const showDefault = opts.showDefault ?? true;
  const suffix = opts.default !== undefined && showDefault ? ` [${opts.default}]: ` : ': ';
  for (;;) {
    process.stdout.write(text + suffix);
    const raw = await readLine();
    if (raw === null) throw new CliAbort();
    if (raw !== '') return raw;
    if (opts.default !== undefined) return opts.default;
  }
}

// ============================================================================
// StepTracker
// ============================================================================

type StepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

interface Step {
  key: string;
  label: string;
  status: StepStatus | string;
  detail: string;
}

/**
 * Track and render hierarchical steps without emojis, similar to Claude Code
 * tree output. Supports live auto-refresh via an attached refresh callback.
 */
export class StepTracker {
  steps: Step[] = [];
  statusOrder: Record<string, number> = { pending: 0, running: 1, done: 2, error: 3, skipped: 4 };
  private refreshCb: (() => void) | null = null;

  constructor(public title: string) {}

  attachRefresh(cb: () => void): void {
    this.refreshCb = cb;
  }

  add(key: string, label: string): void {
    if (!this.steps.some((s) => s.key === key)) {
      this.steps.push({ key, label, status: 'pending', detail: '' });
      this.maybeRefresh();
    }
  }

  start(key: string, detail = ''): void {
    this.update(key, 'running', detail);
  }

  complete(key: string, detail = ''): void {
    this.update(key, 'done', detail);
  }

  error(key: string, detail = ''): void {
    this.update(key, 'error', detail);
  }

  skip(key: string, detail = ''): void {
    this.update(key, 'skipped', detail);
  }

  private update(key: string, status: StepStatus, detail: string): void {
    for (const s of this.steps) {
      if (s.key === key) {
        s.status = status;
        if (detail) s.detail = detail;
        this.maybeRefresh();
        return;
      }
    }
    this.steps.push({ key, label: key, status, detail });
    this.maybeRefresh();
  }

  private maybeRefresh(): void {
    if (this.refreshCb) {
      try {
        this.refreshCb();
      } catch {
        // Progress tracker refresh failed; ignore (upstream logs at debug level).
      }
    }
  }

  render(): Tree {
    const tree = new Tree(`[cyan]${this.title}[/cyan]`, { guideStyle: 'grey50' });
    for (const step of this.steps) {
      const label = step.label;
      const detailText = step.detail ? step.detail.trim() : '';
      const status = step.status;
      let symbol: string;
      if (status === 'done') symbol = '[green]●[/green]';
      else if (status === 'pending') symbol = '[green dim]○[/green dim]';
      else if (status === 'running') symbol = '[cyan]○[/cyan]';
      else if (status === 'error') symbol = '[red]●[/red]';
      else if (status === 'skipped') symbol = '[yellow]○[/yellow]';
      else symbol = ' ';
      let line: string;
      if (status === 'pending') {
        line = detailText
          ? `${symbol} [bright_black]${label} (${detailText})[/bright_black]`
          : `${symbol} [bright_black]${label}[/bright_black]`;
      } else {
        line = detailText
          ? `${symbol} [white]${label}[/white] [bright_black](${detailText})[/bright_black]`
          : `${symbol} [white]${label}[/white]`;
      }
      tree.add(line);
    }
    return tree;
  }
}

// ============================================================================
// Live display (minimal)
// ============================================================================

/** Minimal `rich.live.Live`: redraw a renderable in place on a TTY. */
export class Live {
  private lastHeight = 0;
  private started = false;

  constructor(
    private renderable: RenderableLike,
    private opts: { console?: Console; transient?: boolean } = {},
  ) {}

  private get con(): Console {
    return this.opts.console ?? console;
  }

  start(): void {
    this.started = true;
    this.draw();
  }

  update(renderable: RenderableLike): void {
    this.renderable = renderable;
    if (this.started) this.draw();
  }

  refresh(): void {
    if (this.started) this.draw();
  }

  private draw(): void {
    const con = this.con;
    const text = con.renderToString([this.renderable], { end: '' });
    if (!con.isTerminal) return;
    let prefix = '';
    if (this.lastHeight > 0) prefix = `\x1b[${this.lastHeight - 1}A\r\x1b[J`;
    con.write(prefix + text);
    this.lastHeight = text.split('\n').length;
  }

  stop(): void {
    const con = this.con;
    if (!this.started) return;
    this.started = false;
    if (con.isTerminal) {
      if (this.opts.transient && this.lastHeight > 0) {
        con.write(`\x1b[${Math.max(0, this.lastHeight - 1)}A\r\x1b[J`);
      } else {
        con.write('\n');
      }
    } else {
      con.write(con.renderToString([this.renderable]));
    }
  }
}

// ============================================================================
// Arrow-key selection
// ============================================================================

type Key = 'up' | 'down' | 'enter' | 'escape' | 'ctrl-c' | string;

function readKey(): Promise<Key> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    const onKey = (str: string | undefined, key: { name?: string; ctrl?: boolean } | undefined): void => {
      stdin.off('keypress', onKey);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      const name = key?.name;
      if (key?.ctrl && name === 'c') return resolve('ctrl-c');
      if (name === 'up' || (key?.ctrl && name === 'p')) return resolve('up');
      if (name === 'down' || (key?.ctrl && name === 'n')) return resolve('down');
      if (name === 'return' || name === 'enter') return resolve('enter');
      if (name === 'escape') return resolve('escape');
      resolve(str ?? name ?? '');
    };
    stdin.on('keypress', onKey);
  });
}

/**
 * Rows the selection panel needs besides the options: the blank line printed
 * before it, the panel's border and padding (4), the "more" indicators (2),
 * and the blank line and key hint (2).
 */
export const SELECTION_CHROME_ROWS = 9;

/**
 * The slice of `total` options to show so that `selected` stays visible,
 * keeping the previous `start` while the selection is inside the window.
 */
export function selectionWindow(
  total: number,
  selected: number,
  maxVisible: number,
  start = 0,
): { start: number; end: number; hiddenAbove: number; hiddenBelow: number } {
  const size = Math.max(3, Math.min(total, maxVisible));
  if (total <= size) return { start: 0, end: total, hiddenAbove: 0, hiddenBelow: 0 };
  let from = Math.min(Math.max(0, start), total - size);
  if (selected < from) from = selected;
  else if (selected >= from + size) from = selected - size + 1;
  return { start: from, end: from + size, hiddenAbove: from, hiddenBelow: total - from - size };
}

/** The selection panel for a terminal `rows` tall, scrolled to keep `selectedIndex` visible. */
export function selectionPanel(
  options: Record<string, string>,
  promptText: string,
  selectedIndex: number,
  rows: number,
  windowStart = 0,
): { panel: Panel; start: number } {
  const optionKeys = Object.keys(options);
  const view = selectionWindow(optionKeys.length, selectedIndex, rows - SELECTION_CHROME_ROWS, windowStart);
  const table = Table.grid({ padding: [0, 2] });
  table.addColumn('', { style: 'cyan', justify: 'left', width: 3 });
  table.addColumn('', { style: 'white', justify: 'left' });
  if (view.hiddenAbove) table.addRow('', `[dim]↑ ${view.hiddenAbove} more[/dim]`);
  for (let i = view.start; i < view.end; i++) {
    const key = optionKeys[i];
    table.addRow(i === selectedIndex ? '▶' : ' ', `[cyan]${key}[/cyan] [dim](${options[key]})[/dim]`);
  }
  if (view.hiddenBelow) table.addRow('', `[dim]↓ ${view.hiddenBelow} more[/dim]`);
  table.addRow('', '');
  table.addRow('', '[dim]Use ↑/↓ to navigate, Enter to select, Esc to cancel[/dim]');
  const panel = new Panel(table, { title: `[bold]${promptText}[/bold]`, borderStyle: 'cyan', padding: [1, 2] });
  return { panel, start: view.start };
}

/**
 * Interactive selection using arrow keys (port of `select_with_arrows`).
 * @param options Map of option key -> description.
 * @returns The selected key. Throws {@link CliExit}(1) on cancel or non-TTY stdin.
 */
export async function selectWithArrows(
  options: Record<string, string>,
  promptText = 'Select an option',
  defaultKey: string | null = null,
  opts: { flagHint?: string | null } = {},
): Promise<string> {
  const optionKeys = Object.keys(options);
  if (!optionKeys.length) throw new Error('select_with_arrows() requires at least one option.');
  if (!process.stdin.isTTY) {
    console.print(
      '[red]Error:[/red] Interactive selection requires a terminal ' +
        '(stdin is not a TTY). Waiting for arrow keys would hang indefinitely.',
    );
    if (opts.flagHint) {
      console.print(`Re-run with [bold]${opts.flagHint}[/bold] to supply this choice non-interactively.`);
    }
    throw new CliExit(1);
  }
  let selectedIndex = defaultKey && optionKeys.includes(defaultKey) ? optionKeys.indexOf(defaultKey) : 0;
  // Upstream lists every option, and Rich crops a Live display taller than the
  // terminal, so with ~40 integrations the selection can scroll out of view.
  // Show a window of options that follows the selection instead.
  let windowStart = 0;
  const createSelectionPanel = (): Panel => {
    const view = selectionPanel(options, promptText, selectedIndex, process.stdout.rows || 24, windowStart);
    windowStart = view.start;
    return view.panel;
  };
  console.print();
  const live = new Live(createSelectionPanel(), { console, transient: process.platform !== 'win32' });
  live.start();
  let selectedKey: string | null = null;
  try {
    for (;;) {
      const key = await readKey();
      if (key === 'up') selectedIndex = (selectedIndex - 1 + optionKeys.length) % optionKeys.length;
      else if (key === 'down') selectedIndex = (selectedIndex + 1) % optionKeys.length;
      else if (key === 'enter') {
        selectedKey = optionKeys[selectedIndex];
        break;
      } else if (key === 'escape' || key === 'ctrl-c') {
        live.stop();
        console.print('\n[yellow]Selection cancelled[/yellow]');
        throw new CliExit(1);
      }
      live.update(createSelectionPanel());
    }
  } finally {
    live.stop();
  }
  if (selectedKey === null) {
    console.print('\n[red]Selection failed.[/red]');
    throw new CliExit(1);
  }
  return selectedKey;
}

/** Alias kept for the conventions' `select()` helper name. */
export const select = selectWithArrows;

// ============================================================================
// Banner
// ============================================================================

export const BANNER = `
███████╗██████╗ ███████╗ ██████╗██╗███████╗██╗   ██╗
██╔════╝██╔══██╗██╔════╝██╔════╝██║██╔════╝╚██╗ ██╔╝
███████╗██████╔╝█████╗  ██║     ██║█████╗   ╚████╔╝
╚════██║██╔═══╝ ██╔══╝  ██║     ██║██╔══╝    ╚██╔╝
███████║██║     ███████╗╚██████╗██║██║        ██║
╚══════╝╚═╝     ╚══════╝ ╚═════╝╚═╝╚═╝        ╚═╝
`;

export const TAGLINE = 'GitHub Spec Kit - Spec-Driven Development Toolkit';

/** Display the ASCII art banner (port of `show_banner`). */
export function showBanner(con: Console = console): void {
  const bannerLines = BANNER.trim().split('\n');
  const colors = ['bright_blue', 'blue', 'cyan', 'bright_cyan', 'white', 'bright_white'];
  const styled = new Text();
  bannerLines.forEach((line, i) => styled.append(line + '\n', colors[i % colors.length]));
  con.print(Align.center(styled));
  con.print(Align.center(new Text(TAGLINE, 'italic bright_yellow')));
  con.print();
}
