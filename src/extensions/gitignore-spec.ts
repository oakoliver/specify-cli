/**
 * @oakoliver/specify-cli - .gitignore-style pattern matching
 *
 * Minimal port of ``pathspec.GitIgnoreSpec`` (``gitwildmatch`` patterns), used
 * by ``ExtensionManager`` to honour ``.extensionignore`` files.
 *
 * Semantics mirror .gitignore:
 * - ``*`` matches anything except ``/``; ``?`` any single char except ``/``
 * - ``**`` matches zero or more directories
 * - trailing ``/`` restricts a pattern to directories
 * - patterns containing ``/`` (other than trailing) are anchored to the root
 * - ``!`` negates a previously excluded pattern (last match wins)
 *
 * @module extensions/gitignore-spec
 */

interface CompiledPattern {
  regex: RegExp;
  include: boolean;
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

/** Translate a single path segment glob into a regex fragment. */
function translateSegmentGlob(pattern: string): string {
  let out = '';
  let escape = false;
  let i = 0;
  const end = pattern.length;
  while (i < end) {
    const ch = pattern[i];
    i += 1;
    if (escape) {
      escape = false;
      out += escapeRegex(ch);
    } else if (ch === '\\') {
      escape = true;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      let j = i;
      if (j < end && (pattern[j] === '!' || pattern[j] === '^')) j += 1;
      if (j < end && pattern[j] === ']') j += 1;
      while (j < end && pattern[j] !== ']') j += 1;
      if (j < end) {
        j += 1;
        let expr = '[';
        if (pattern[i] === '!' || pattern[i] === '^') {
          expr += '^';
          i += 1;
        }
        expr += pattern.slice(i, j).replace(/\\/g, '\\\\');
        out += expr;
        i = j;
      } else {
        out += '\\[';
      }
    } else {
      out += escapeRegex(ch);
    }
  }
  return out;
}

/** Compile one gitwildmatch line. Returns ``null`` for blank/comment lines. */
function compilePattern(line: string): CompiledPattern | null {
  let pattern = line;
  // Strip trailing whitespace unless escaped.
  if (pattern.endsWith('\\ ')) {
    pattern = pattern.replace(/\s+$/, '') + ' ';
  } else {
    pattern = pattern.replace(/\s+$/, '');
  }
  if (!pattern || pattern.startsWith('#') || pattern === '/') return null;

  let include = true;
  if (pattern.startsWith('!')) {
    include = false;
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith('\\')) pattern = pattern.slice(1);
  if (!pattern) return null;

  let segs = pattern.split('/');
  if (!segs[0]) {
    // Leading slash: anchored to the root.
    segs = segs.slice(1);
  } else if (segs.length === 1 || (segs.length === 2 && !segs[1])) {
    // Single segment (optionally dir-only): match at any depth.
    if (segs[0] !== '**') segs.unshift('**');
  }
  if (!segs.length) return null;
  if (!segs[segs.length - 1] && segs.length > 1) {
    // Trailing slash: directory contents.
    segs[segs.length - 1] = '**';
  }
  // Collapse consecutive '**' segments.
  segs = segs.filter((s, idx) => !(s === '**' && idx > 0 && segs[idx - 1] === '**'));

  let out = '^';
  let needSlash = false;
  const last = segs.length - 1;
  segs.forEach((seg, i) => {
    if (seg === '**') {
      if (i === 0 && i === last) {
        out += '[^/]+(?:/.*)?';
      } else if (i === 0) {
        out += '(?:.+/)?';
        needSlash = false;
      } else if (i === last) {
        out += '/.*';
      } else {
        out += '(?:/.+)?';
        needSlash = true;
      }
    } else if (seg === '*') {
      if (needSlash) out += '/';
      out += '[^/]+';
      if (i === last) out += '(?:/.*)?';
      needSlash = true;
    } else {
      if (needSlash) out += '/';
      out += translateSegmentGlob(seg);
      if (i === last) out += '(?:/.*)?';
      needSlash = true;
    }
  });
  out += '$';
  return { regex: new RegExp(out, 's'), include };
}

/** Port of ``pathspec.GitIgnoreSpec``. */
export class GitIgnoreSpec {
  private readonly patterns: CompiledPattern[];

  private constructor(patterns: CompiledPattern[]) {
    this.patterns = patterns;
  }

  /** ``GitIgnoreSpec.from_lines(lines)``. */
  static fromLines(lines: string[]): GitIgnoreSpec {
    const compiled: CompiledPattern[] = [];
    for (const line of lines) {
      const p = compilePattern(line);
      if (p) compiled.push(p);
    }
    return new GitIgnoreSpec(compiled);
  }

  /** ``GitIgnoreSpec.match_file(path)`` — last matching pattern wins. */
  matchFile(path: string): boolean {
    let matched = false;
    for (const p of this.patterns) {
      if (p.regex.test(path)) matched = p.include;
    }
    return matched;
  }
}
