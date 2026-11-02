/**
 * Contract tests for shared installation filtering (port of upstream
 * tests/specify_cli/test_install_ignore.py, spec-kit v1.2.5, plus the
 * .presetignore lifecycle cases of #5020).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ValidationError } from '../src/extensions/errors.js';
import { copytree } from '../src/extensions/fs-utils.js';
import { GitIgnorePatternError } from '../src/extensions/gitignore-spec.js';
import { loadInstallIgnore } from '../src/install-ignore.js';
import { PresetManager } from '../src/presets/manager.js';
import { PresetValidationError, setPresetWarningHandler } from '../src/presets/manifest.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'install-ignore-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function write(p: string, content: string | Uint8Array): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

const CONTRACTS: Array<[string, new (m: string) => Error]> = [
  ['.extensionignore', ValidationError],
  ['.presetignore', PresetValidationError],
];

const PATTERN_CASES: Array<[string, string[], string[]]> = [
  ['.git/\n.idea/\ntests/\n', ['.git/config', '.idea/x', 'tests/a.py'], ['README.md']],
  ['*.pyc\n', ['cache.pyc', 'nested/cache.pyc'], ['nested/code.py']],
  ['# comment\n\n  notes.txt  \n\n', ['notes.txt'], ['README.md']],
  ['docs/internal/draft.md\n', ['docs/internal/draft.md'], ['docs/guide.md']],
  ['docs\\internal\\draft.md\n', ['docs/internal/draft.md'], ['docs/guide.md']],
  ['ドキュメント/\ncafé/\n', ['ドキュメント/private.md', 'café/résumé.txt'], ['docs/guide.md']],
  ['docs/*.draft.md\n', ['docs/api.draft.md'], ['docs/sub/api.draft.md']],
  ['docs/**/*.draft.md\n', ['docs/api.draft.md', 'docs/sub/api.draft.md'], ['docs/guide.md']],
  ['docs/*.md\n!docs/api.md\n', ['docs/guide.md'], ['docs/api.md']],
  ['/notes.txt\n', ['notes.txt'], ['nested/notes.txt']],
  ['docs/draft.md\n', ['docs/draft.md'], ['nested/docs/draft.md']],
  ['cache/\n', ['cache/data', 'nested/cache/data'], ['other/cache']],
  ['file?.txt\n', ['file1.txt'], ['file12.txt']],
  ['../sibling/\n/etc/passwd\n', [], ['sibling/data', 'passwd']],
  // copytree never visits an excluded parent; child negation cannot restore it.
  ['docs/\n!docs/api.md\n', ['docs/api.md'], ['README.md']],
  ['docs/\n!docs/\n', [], ['docs/api.md']],
];

for (const [ignoreFilename, validationError] of CONTRACTS) {
  describe(`loadInstallIgnore (${ignoreFilename})`, () => {
    for (const [i, [patterns, excluded, included]] of PATTERN_CASES.entries()) {
      test(`pattern semantics ${i}: ${JSON.stringify(patterns)}`, () => {
        const root = tmp();
        const source = join(root, 'source');
        for (const rel of [...excluded, ...included, 'keep.txt']) write(join(source, rel), `contents of ${rel}\n`);
        write(join(source, ignoreFilename), patterns);
        const dest = join(root, 'installed');
        copytree(source, dest, { ignore: loadInstallIgnore(source, ignoreFilename, validationError) });
        for (const rel of excluded) expect(existsSync(join(dest, rel))).toBe(false);
        for (const rel of [...included, 'keep.txt']) {
          expect(readFileSync(join(dest, rel)).equals(readFileSync(join(source, rel)))).toBe(true);
        }
        expect(existsSync(join(dest, ignoreFilename))).toBe(false);
      });
    }

    test('an absent ignore file returns no filter', () => {
      const root = tmp();
      write(join(root, '.gitignore'), '*\n');
      expect(loadInstallIgnore(root, ignoreFilename, validationError)).toBeNull();
    });

    for (const directory of ['tests', 'café']) {
      test(`accepts a UTF-8 BOM and CRLF (${directory})`, () => {
        const root = tmp();
        const source = join(root, 'source');
        write(join(source, directory, 'private.txt'), 'development only');
        write(join(source, 'keep.txt'), 'shipped');
        write(join(source, ignoreFilename), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${directory}/\r\n`)]));
        const dest = join(root, 'installed');
        copytree(source, dest, { ignore: loadInstallIgnore(source, ignoreFilename, validationError) });
        expect(existsSync(join(dest, directory))).toBe(false);
        expect(readFileSync(join(dest, 'keep.txt'), 'utf-8')).toBe('shipped');
        expect(existsSync(join(dest, ignoreFilename))).toBe(false);
      });
    }

    for (const negateSelf of [false, true]) {
      test(`the ignore file is always excluded (negate=${negateSelf})`, () => {
        const root = tmp();
        const source = join(root, 'source');
        write(join(source, ignoreFilename), negateSelf ? `!${ignoreFilename}\n` : '');
        write(join(source, 'keep.txt'), 'keep\n');
        const dest = join(root, 'installed');
        copytree(source, dest, { ignore: loadInstallIgnore(source, ignoreFilename, validationError) });
        expect(readdirSync(dest).sort()).toEqual(['keep.txt']);
      });
    }

    for (const [label, content, offset] of [
      ['without-bom', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2f, 0x0a]), 3],
      ['with-bom', Buffer.from([0xef, 0xbb, 0xbf, 0x63, 0x61, 0x66, 0xe9, 0x2f, 0x0a]), 6],
    ] as const) {
      test(`invalid UTF-8 uses the caller's validation error (${label})`, () => {
        const root = tmp();
        const ignoreFile = join(root, ignoreFilename);
        write(ignoreFile, content);
        let caught: unknown;
        try {
          loadInstallIgnore(root, ignoreFilename, validationError);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(validationError);
        expect((caught as Error).message).toContain(`${ignoreFilename} is not valid UTF-8: ${ignoreFile}`);
        expect((caught as Error).message).toContain(`at byte ${offset})`);
      });
    }

    for (const [patterns, lineNumber, normalized] of [
      ['!\n', 1, '!'],
      ['# comment\n\ntests/\n  !  \n', 4, '!'],
      ['[z-a].txt\n', 1, '[z-a].txt'],
      ['# comment\n\ntests/\n  docs\\[z-a].txt  \n!\n', 4, 'docs/[z-a].txt'],
    ] as const) {
      test(`a malformed pattern uses the caller's validation error (${JSON.stringify(patterns)})`, () => {
        const root = tmp();
        const ignoreFile = join(root, ignoreFilename);
        write(ignoreFile, patterns);
        let caught: unknown;
        try {
          loadInstallIgnore(root, ignoreFilename, validationError);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(validationError);
        const message = (caught as Error).message;
        expect(message).toContain(`Invalid patterns in ${ignoreFilename}: ${ignoreFile}`);
        expect(message).toContain(`at line ${lineNumber}: '${normalized}'`);
        const cause = (caught as Error & { cause?: unknown }).cause;
        expect(cause).toBeInstanceOf(GitIgnorePatternError);
        expect(message).toContain((cause as Error).message);
      });
    }

    test('valid patterns filter a directory listing', () => {
      const root = tmp();
      write(join(root, ignoreFilename), '# comment\n\ndocs/*\n!docs/api.md\n');
      const ignore = loadInstallIgnore(root, ignoreFilename, validationError)!;
      expect(ignore(join(root, 'docs'), ['api.md', 'draft.md'])).toEqual(new Set(['draft.md']));
    });

    test("a directory named like the ignore file uses the caller's validation error", () => {
      const root = tmp();
      const ignoreDir = join(root, ignoreFilename);
      mkdirSync(ignoreDir);
      expect(() => loadInstallIgnore(root, ignoreFilename, validationError)).toThrow(
        `${ignoreFilename} is not a regular file: ${ignoreDir}`,
      );
      expect(() => loadInstallIgnore(root, ignoreFilename, validationError)).toThrow(validationError);
    });
  });
}

describe('.presetignore during preset installation', () => {
  function presetSource(root: string, ignore: string | null): string {
    const src = join(root, 'src-pack');
    write(
      join(src, 'preset.yml'),
      'schema_version: "1.0"\npreset:\n  id: ign\n  name: Ign\n  version: "1.0.0"\n  description: d\n' +
        'requires:\n  speckit_version: ">=0.1.0"\nprovides:\n  templates:\n' +
        '    - type: template\n      name: spec-template\n      file: templates/spec-template.md\n',
    );
    write(join(src, 'templates', 'spec-template.md'), '# Spec\n');
    write(join(src, 'tests', 'dev.txt'), 'dev only\n');
    write(join(src, 'notes.md'), 'notes\n');
    if (ignore !== null) write(join(src, '.presetignore'), ignore);
    return src;
  }

  function project(root: string): string {
    const p = join(root, 'project');
    write(join(p, '.specify', 'templates', 'spec-template.md'), '# Core\n');
    return p;
  }

  test('excluded files are not installed', () => {
    setPresetWarningHandler(() => undefined);
    try {
      const root = tmp();
      const p = project(root);
      new PresetManager(p).installFromDirectory(presetSource(root, 'tests/\nnotes.md\n'), '1.0.0');
      const dest = join(p, '.specify', 'presets', 'ign');
      expect(existsSync(join(dest, 'tests'))).toBe(false);
      expect(existsSync(join(dest, 'notes.md'))).toBe(false);
      expect(existsSync(join(dest, '.presetignore'))).toBe(false);
      expect(existsSync(join(dest, 'templates', 'spec-template.md'))).toBe(true);
    } finally {
      setPresetWarningHandler(null);
    }
  });

  test('an invalid .presetignore is rejected before an installed preset is removed', () => {
    setPresetWarningHandler(() => undefined);
    try {
      const root = tmp();
      const p = project(root);
      const manager = new PresetManager(p);
      manager.installFromDirectory(presetSource(root, null), '1.0.0');
      write(join(root, 'src-pack', '.presetignore'), '!\n');
      expect(() => manager.installFromDirectory(join(root, 'src-pack'), '1.0.0', 10, { force: true })).toThrow(
        PresetValidationError,
      );
      expect(manager.registry.isInstalled('ign')).toBe(true);
      expect(existsSync(join(p, '.specify', 'presets', 'ign', 'notes.md'))).toBe(true);
    } finally {
      setPresetWarningHandler(null);
    }
  });
});
