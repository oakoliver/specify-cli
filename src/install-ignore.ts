/**
 * @oakoliver/specify-cli - Shared source-directory installation filtering
 *
 * Port of upstream ``_install_ignore.py`` (spec-kit v1.2.5), used by
 * ``.extensionignore`` (extensions) and ``.presetignore`` (presets).
 *
 * @module install-ignore
 */

import { type Stats, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { UnicodeDecodeError, decodeUtf8Strict } from './extensions/compat.js';
import { GitIgnorePatternError, GitIgnoreSpec } from './extensions/gitignore-spec.js';

/** ``shutil.copytree`` ``ignore=`` callback: names in ``entries`` to skip. */
export type InstallIgnoreFn = (directory: string, entries: string[]) => Set<string>;

type ValidationErrorClass = new (message: string) => Error;

/** Python ``str.splitlines()`` (no keepends). */
export function pySplitlines(text: string): string[] {
  const lines = text.split(new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]'));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Python ``repr()`` of a string. */
function pyRepr(value: string): string {
  if (value.includes("'") && !value.includes('"')) return `"${value}"`;
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * Load a UTF-8 ignore file as a copytree callback, or return ``null`` if absent.
 *
 * Git-style patterns, with whitespace trimming and backslash normalization.
 * Only the named root ignore file is read; there are no default exclusions
 * except the ignore filename itself. A non-file path, invalid encoding, or
 * invalid patterns throw the caller's domain validation error before copying.
 * Excluded directories are pruned by copytree, so child negations cannot
 * restore files inside them unless the parent directory is also re-included.
 */
export function loadInstallIgnore(
  sourceDir: string,
  ignoreFilename: string,
  validationError: ValidationErrorClass,
): InstallIgnoreFn | null {
  const ignoreFile = join(sourceDir, ignoreFilename);
  const st = statOrNull(ignoreFile);
  if (st === null) return null;
  if (!st.isFile()) throw new validationError(`${ignoreFilename} is not a regular file: ${ignoreFile}`);

  // Accept UTF-8 with or without the BOM emitted by Windows PowerShell 5.1.
  // Strip it after decoding so error offsets remain relative to the file.
  let raw: string;
  try {
    raw = decodeUtf8Strict(readFileSync(ignoreFile));
  } catch (e) {
    if (e instanceof UnicodeDecodeError) {
      throw new validationError(`${ignoreFilename} is not valid UTF-8: ${ignoreFile} (${e.reason} at byte ${e.start})`);
    }
    throw e;
  }
  if (raw.startsWith('﻿')) raw = raw.slice(1);
  const lines = pySplitlines(raw);

  // Normalise backslashes in patterns so Windows-authored files work.
  const normalised: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped && !stripped.startsWith('#')) normalised.push(stripped.replace(/\\/g, '/'));
    else normalised.push(line); // keep blanks/comments so line numbers stay stable
  }
  // Always ignore the ignore file itself, even after a negation pattern.
  normalised.push(ignoreFilename);

  let spec: GitIgnoreSpec;
  try {
    spec = GitIgnoreSpec.fromLines(normalised);
  } catch (e) {
    if (!(e instanceof GitIgnorePatternError)) throw e;
    // Locate the first malformed source rule only on failure.
    let location = '';
    for (let i = 0; i < lines.length; i++) {
      try {
        GitIgnoreSpec.fromLines([normalised[i]]);
      } catch (inner) {
        if (!(inner instanceof GitIgnorePatternError)) throw inner;
        location = ` at line ${i + 1}: ${pyRepr(normalised[i])}`;
        break;
      }
    }
    const err = new validationError(`Invalid patterns in ${ignoreFilename}: ${ignoreFile}${location} (${e.message})`);
    (err as Error & { cause?: unknown }).cause = e;
    throw err;
  }

  return (directory: string, entries: string[]): Set<string> => {
    const ignored = new Set<string>();
    const relDir = relative(sourceDir, directory);
    for (const entry of entries) {
      const relPath = relDir && relDir !== '.' ? join(relDir, entry) : entry;
      const relFwd = relPath.split(sep).join('/').replace(/\\/g, '/');
      const entrySt = statOrNull(join(directory, entry));
      if (entrySt?.isDirectory()) {
        // Append '/' so directory-only patterns (e.g. tests/) match.
        if (spec.matchFile(relFwd + '/')) ignored.add(entry);
      } else if (spec.matchFile(relFwd)) {
        ignored.add(entry);
      }
    }
    return ignored;
  };
}
