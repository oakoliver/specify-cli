/**
 * @oakoliver/specify-cli - Workflow expression template scanning
 *
 * Port of ``specify_cli/workflows/expressions/template.py``: quote- and
 * bracket-aware scanning shared by the engine and the diagnostics.
 *
 * @module workflows/expressions/template
 */

/** True for a quote character that opens a string operand. */
export function isQuote(ch: string): boolean {
  return ch === "'" || ch === '"';
}

/** Python ``str.isspace()`` for one character. */
export function isPySpace(ch: string): boolean {
  return /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/.test(ch);
}

/** Python ``str.strip()`` (whitespace as ``str.isspace`` defines it). */
export function pyStrip(text: string): string {
  const chars = [...text];
  let start = 0;
  let end = chars.length;
  while (start < end && isPySpace(chars[start] as string)) start++;
  while (end > start && isPySpace(chars[end - 1] as string)) end--;
  return chars.slice(start, end).join('');
}

/** True when *stripped* is exactly one top-level ``{{ ... }}`` block. */
export function isSingleExpression(stripped: string): boolean {
  if (!(stripped.startsWith('{{') && stripped.endsWith('}}'))) return false;
  const inner = stripped.slice(2, -2);
  if (!inner.trim()) return false;
  let quote: string | null = null;
  const n = inner.length;
  for (let i = 0; i < n; i++) {
    const ch = inner[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (isQuote(ch)) {
      quote = ch;
    } else if (ch === '}' && i + 1 < n && inner[i + 1] === '}') {
      return false;
    }
  }
  return true;
}

/** Index of the ``}}`` closing the block opened by the ``{{`` at *start*, or -1. */
export function findBlockClose(text: string, start: number): number {
  let quote: string | null = null;
  const n = text.length;
  for (let i = start + 2; i < n; i++) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (isQuote(ch)) {
      quote = ch;
    } else if (ch === '}' && i + 1 < n && text[i + 1] === '}') {
      return i;
    }
  }
  return -1;
}

/**
 * How interpolation will fail on the first block it cannot close with the
 * quote-aware scan, or ``null`` when every block closes.
 */
export function firstUnclosableBlock(text: string): 'evaluated' | 'verbatim' | null {
  let i = 0;
  for (;;) {
    const start = text.indexOf('{{', i);
    if (start === -1) return null;
    const close = findBlockClose(text, start);
    if (close === -1) return text.indexOf('}}', start + 2) !== -1 ? 'evaluated' : 'verbatim';
    i = close + 2;
  }
}

/**
 * Return the index of the first occurrence of *token* in *text* that lies
 * outside any quoted string or nested bracket, or ``-1``.
 */
export function findTopLevel(text: string, token: string): number {
  let quote: string | null = null;
  let depth = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (isQuote(ch)) {
      quote = ch;
    } else if ('([{'.includes(ch)) {
      depth += 1;
    } else if (')]}'.includes(ch)) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && text.startsWith(token, i)) {
      return i;
    }
  }
  return -1;
}

/** Split *text* on each top-level occurrence of *sep*. */
export function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (;;) {
    const idx = findTopLevel(text.slice(start), sep);
    if (idx === -1) {
      parts.push(text.slice(start));
      return parts;
    }
    parts.push(text.slice(start, start + idx));
    start += idx + sep.length;
  }
}

/** Split *text* on commas that are not inside quotes or nested brackets. */
export function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let quote: string | null = null;
  let depth = 0;
  for (const ch of text) {
    if (quote !== null) {
      buf += ch;
      if (ch === quote) quote = null;
    } else if (isQuote(ch)) {
      quote = ch;
      buf += ch;
    } else if ('([{'.includes(ch)) {
      depth += 1;
      buf += ch;
    } else if (')]}'.includes(ch)) {
      depth = Math.max(0, depth - 1);
      buf += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  return parts;
}

/** ``True`` only when *expr* is exactly one bracketed list literal. */
export function isSingleListLiteral(expr: string): boolean {
  if (!(expr.startsWith('[') && expr.endsWith(']'))) return false;
  let quote: string | null = null;
  let depth = 0;
  const n = expr.length;
  for (let i = 0; i < n; i++) {
    const ch = expr[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (isQuote(ch)) quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) return i === n - 1;
    }
  }
  return false;
}

/**
 * True when *text* is one parenthesised group, brackets and all. ``(a or b)``
 * is; ``(a) and (b)`` is not. Quote-aware, so ``('(')`` does not count its own
 * literal.
 */
export function isWrappedInParens(text: string): boolean {
  if (!(text.startsWith('(') && text.endsWith(')'))) return false;
  let quote: string | null = null;
  let depth = 0;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (isQuote(ch)) {
      quote = ch;
    } else if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i === n - 1;
    }
  }
  return false;
}

/**
 * Strip *text* and turn each run of whitespace outside a quoted string into
 * one space, so word operators next to a newline or tab (a condition wrapped
 * across lines in YAML) are still found. Quoted operands keep their text.
 */
export function collapseWhitespace(text: string): string {
  const out: string[] = [];
  let quote: string | null = null;
  let pendingSpace = false;
  for (const ch of pyStrip(text)) {
    if (quote !== null) {
      out.push(ch);
      if (ch === quote) quote = null;
    } else if (isPySpace(ch)) {
      pendingSpace = true;
    } else {
      if (pendingSpace) {
        out.push(' ');
        pendingSpace = false;
      }
      if (isQuote(ch)) quote = ch;
      out.push(ch);
    }
  }
  return out.join('');
}

/** Remove every ``{{``/``}}`` that lies outside a quoted operand. */
export function stripStrayDelimiters(text: string): string {
  const out: string[] = [];
  let quote: string | null = null;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (quote !== null) {
      out.push(ch);
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (isQuote(ch)) {
      quote = ch;
      out.push(ch);
      i += 1;
      continue;
    }
    if (text.startsWith('{{', i) || text.startsWith('}}', i)) {
      i += 2;
      while (i < n && /\s/.test(text[i] as string)) i += 1;
      while (out.length && /^\s$/.test(out[out.length - 1] as string)) out.pop();
      out.push(' ');
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}
