/**
 * Tests for foundation modules: toml-string, invocation-style, init-options,
 * project, installed-list-json, assets, agent-config, catalogs, utils,
 * console, cli-args.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { escapeTomlBasic, hasIllegalTomlControl, parseToml } from '../src/toml-string.js';
import { getInvocationPrefix, isDollarSkillsAgent, isSlashSkillsAgent } from '../src/invocation-style.js';
import {
  INIT_OPTIONS_FILE,
  MISSING_INIT_OPTIONS_FILE,
  isAiSkillsEnabled,
  loadInitOptions,
  resolveActiveAgentForRegistration,
  saveInitOptions,
} from '../src/init-options.js';
import {
  ProjectResolutionError,
  requireSpecifyProject,
  resolveInitDirOverride,
  resolveInitDirOverrideUnrendered,
  resolveSpecifyProjectRoot,
} from '../src/project.js';
import { emitJson, emitJsonError, installedListItem, normalizedSource, parseInstalledListArgs } from '../src/installed-list-json.js';
import {
  getSpeckitVersion,
  locateBundledExtension,
  locateBundledPreset,
  locateBundledWorkflow,
  locateCorePack,
  packageRoot,
} from '../src/assets.js';
import { CatalogEntry, CatalogStackBase } from '../src/catalogs.js';
import {
  CLAUDE_PATHS,
  SpecifierSet,
  Version,
  checkTool,
  dumpFrontmatter,
  handleVscodeSettings,
  mergeJsonFiles,
  parseJson5,
  pyJsonDumps,
  pyTypeName,
  relativeExtensionPathViolation,
  toolLookup,
  versionSatisfies,
} from '../src/utils.js';
import {
  CliAbort,
  CliExit,
  Console,
  Panel,
  StepTracker,
  Table,
  Tree,
  confirm,
  escapeMarkup,
  parseMarkup,
  prompt,
  renderMarkup,
  setPromptInput,
  stripMarkup,
} from '../src/console.js';
import { UsageError, dispatchGroup, defineCommand, formatHelp, parseArgs, runCommand, type CommandSpec } from '../src/cli-args.js';

const PEP440_VERSIONS = ["0.1.5", "1.0.0", "1.0.0rc1", "1.0.0.dev1", "1.0.0.post1", "1.0", "2.0.0", "0.7.0", "1.0.12", "1.0.0+local", "0.0.1a1", "1.1.0b2", "1!0.1"];
const PEP440_MATRIX: Array<[string, boolean[]]> = [[">=0.1.0,<2.0.0", [true, true, true, true, true, true, false, true, true, true, false, true, false]], [">=1.0.0", [false, true, false, false, true, true, true, false, true, true, false, true, true]], ["<1.0.0", [true, false, false, false, false, false, false, true, false, false, true, false, false]], ["==1.0.*", [false, true, true, true, true, true, false, false, true, true, false, false, false]], ["~=1.0", [false, true, false, false, true, true, false, false, true, true, false, true, false]], ["~=1.0.0", [false, true, false, false, true, true, false, false, true, true, false, false, false]], ["!=1.0.0", [true, false, true, true, true, false, true, true, true, false, true, true, true]], [">1.0.0", [false, false, false, false, false, false, true, false, true, false, false, true, true]], ["<=1.0", [true, true, true, true, false, true, false, true, false, true, true, false, false]], ["==1.0", [false, true, false, false, false, true, false, false, false, true, false, false, false]], ["", [true, true, true, true, true, true, true, true, true, true, true, true, true]], [">=0.7.0", [false, true, true, true, true, true, true, true, true, true, false, true, true]], ["==1.0.0+local", [false, false, false, false, false, false, false, false, false, true, false, false, false]], ["bogus", [false, false, false, false, false, false, false, false, false, false, false, false, false]], [">=1.0.0,<1.0.0", [false, false, false, false, false, false, false, false, false, false, false, false, false]]];
const PEP440_SORTED = ["0.0.1a1", "0.1.5", "0.7.0", "1.0.0.dev1", "1.0.0rc1", "1.0.0", "1.0", "1.0.0+local", "1.0.0.post1", "1.0.12", "1.1.0b2", "2.0.0", "1!0.1"];

let tmp: string;
const savedEnv = { ...process.env };
const savedCwd = process.cwd();

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'foundation-')));
});
afterEach(() => {
  process.chdir(savedCwd);
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Capture process.stdout/stderr writes during `fn`. */
async function capture(fn: () => unknown): Promise<{ out: string; err: string; value: unknown; error: unknown }> {
  let out = '';
  let err = '';
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    out += s;
    return true;
  };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    err += s;
    return true;
  };
  let value: unknown;
  let error: unknown;
  try {
    value = await fn();
  } catch (e) {
    error = e;
  } finally {
    (process.stdout as unknown as { write: typeof ow }).write = ow;
    (process.stderr as unknown as { write: typeof ew }).write = ew;
  }
  return { out, err, value, error };
}

// ============================================================================
// toml-string
// ============================================================================

describe('toml-string', () => {
  test('hasIllegalTomlControl', () => {
    expect(hasIllegalTomlControl('plain\ttext\nmore')).toBe(false);
    expect(hasIllegalTomlControl('crlf\r\nok')).toBe(false);
    expect(hasIllegalTomlControl('bare\rcr')).toBe(true);
    expect(hasIllegalTomlControl('nul\x00')).toBe(true);
    expect(hasIllegalTomlControl('del\x7f')).toBe(true);
    expect(hasIllegalTomlControl('trailing\r')).toBe(true);
  });
  test('escapeTomlBasic', () => {
    expect(escapeTomlBasic('a"b\\c\nd\re\tf\x01g\x7f')).toBe('"a\\"b\\\\c\\nd\\re\\tf\\u0001g\\u007f"');
  });
  test('parseToml reads basic documents', () => {
    const doc = parseToml(`
# comment
description = "Hello \\"world\\""
prompt = """
line1
line2"""
lit = 'C:\\path'
num = 42
flt = 1.5
yes = true
arr = [1, "two", [3]]
inline = { a = 1, "b c" = "x" }

[table.sub]
key = "v"

[[items]]
name = "one"
[[items]]
name = "two"
`);
    expect(doc).toEqual({
      description: 'Hello "world"',
      prompt: 'line1\nline2',
      lit: 'C:\\path',
      num: 42,
      flt: 1.5,
      yes: true,
      arr: [1, 'two', [3]],
      inline: { a: 1, 'b c': 'x' },
      table: { sub: { key: 'v' } },
      items: [{ name: 'one' }, { name: 'two' }],
    });
  });
  test('parseToml round-trips escapeTomlBasic output', () => {
    const value = 'tricky "quotes" \\ back \n new \x01 ctl';
    expect(parseToml(`k = ${escapeTomlBasic(value)}`).k).toBe(value);
  });
  test('parseToml rejects duplicate keys and garbage', () => {
    expect(() => parseToml('a = 1\na = 2')).toThrow();
    expect(() => parseToml('a = ')).toThrow();
  });
});

// ============================================================================
// invocation-style
// ============================================================================

describe('invocation-style', () => {
  test('dollar agents', () => {
    expect(isDollarSkillsAgent('codex', true)).toBe(true);
    expect(isDollarSkillsAgent('codex', false)).toBe(false);
    expect(isDollarSkillsAgent('claude', true)).toBe(false);
    expect(isDollarSkillsAgent(null, true)).toBe(false);
  });
  test('prefixes', () => {
    expect(getInvocationPrefix('codex', true)).toBe('$');
    expect(getInvocationPrefix('kimi', true)).toBe('/skill:');
    expect(getInvocationPrefix('kimi', false)).toBe('/');
    expect(getInvocationPrefix(undefined, true)).toBe('/');
  });
  test('slash agents', () => {
    expect(isSlashSkillsAgent('zed', false)).toBe(true);
    expect(isSlashSkillsAgent('claude', false)).toBe(false);
    expect(isSlashSkillsAgent('claude', true)).toBe(true);
    expect(isSlashSkillsAgent('gemini', true)).toBe(false);
    expect(isSlashSkillsAgent(null, true)).toBe(false);
  });
});

// ============================================================================
// init-options
// ============================================================================

describe('init-options', () => {
  test('save/load round trip with sorted keys and unicode', () => {
    saveInitOptions(tmp, { z: 1, ai: 'claude', note: 'café' });
    const text = fs.readFileSync(path.join(tmp, INIT_OPTIONS_FILE), 'utf8');
    expect(text).toBe('{\n  "ai": "claude",\n  "note": "café",\n  "z": 1\n}\n');
    expect(loadInitOptions(tmp)).toEqual({ ai: 'claude', note: 'café', z: 1 });
  });
  test('load returns {} for missing, malformed, or non-object files', () => {
    expect(loadInitOptions(tmp)).toEqual({});
    fs.mkdirSync(path.join(tmp, '.specify'));
    fs.writeFileSync(path.join(tmp, INIT_OPTIONS_FILE), '{bad');
    expect(loadInitOptions(tmp)).toEqual({});
    fs.writeFileSync(path.join(tmp, INIT_OPTIONS_FILE), '[1]');
    expect(loadInitOptions(tmp)).toEqual({});
  });
  test('isAiSkillsEnabled requires literal true', () => {
    expect(isAiSkillsEnabled({ ai_skills: true })).toBe(true);
    expect(isAiSkillsEnabled({ ai_skills: 'true' })).toBe(false);
    expect(isAiSkillsEnabled(null)).toBe(false);
  });
  test('resolveActiveAgentForRegistration', () => {
    expect(resolveActiveAgentForRegistration(tmp)).toBe(MISSING_INIT_OPTIONS_FILE);
    fs.mkdirSync(path.join(tmp, '.specify'));
    fs.writeFileSync(path.join(tmp, INIT_OPTIONS_FILE), '{"ai": ""}');
    expect(resolveActiveAgentForRegistration(tmp)).toBeNull();
    fs.writeFileSync(path.join(tmp, INIT_OPTIONS_FILE), '{"ai": "codex"}');
    expect(resolveActiveAgentForRegistration(tmp)).toBe('codex');
    fs.rmSync(path.join(tmp, INIT_OPTIONS_FILE));
    fs.symlinkSync(path.join(tmp, 'missing-target'), path.join(tmp, INIT_OPTIONS_FILE));
    expect(resolveActiveAgentForRegistration(tmp)).toBeNull();
  });
});

// ============================================================================
// project
// ============================================================================

describe('project', () => {
  test('override unset -> null', () => {
    delete process.env.SPECIFY_INIT_DIR;
    expect(resolveInitDirOverrideUnrendered()).toBeNull();
  });
  test('override to missing directory', () => {
    process.env.SPECIFY_INIT_DIR = path.join(tmp, 'nope');
    expect(() => resolveInitDirOverrideUnrendered()).toThrow(
      `SPECIFY_INIT_DIR does not point to an existing directory: ${path.join(tmp, 'nope')}`,
    );
  });
  test('override to non-project directory', () => {
    process.env.SPECIFY_INIT_DIR = tmp;
    expect(() => resolveInitDirOverrideUnrendered()).toThrow(
      `SPECIFY_INIT_DIR is not a Spec Kit project (no .specify/ directory): ${tmp}`,
    );
  });
  test('relative override resolves against cwd', () => {
    fs.mkdirSync(path.join(tmp, 'proj', '.specify'), { recursive: true });
    process.chdir(tmp);
    process.env.SPECIFY_INIT_DIR = 'proj';
    expect(resolveInitDirOverrideUnrendered()).toBe(path.join(tmp, 'proj'));
    expect(resolveSpecifyProjectRoot()).toBe(path.join(tmp, 'proj'));
  });
  test('rendered override error exits 1 on stderr', async () => {
    process.env.SPECIFY_INIT_DIR = path.join(tmp, 'nope');
    const r = await capture(() => resolveInitDirOverride());
    expect(r.error).toBeInstanceOf(CliExit);
    expect((r.error as CliExit).code).toBe(1);
    expect(r.err).toContain('Error: SPECIFY_INIT_DIR does not point to an existing directory');
  });
  test('resolveSpecifyProjectRoot / requireSpecifyProject without .specify', async () => {
    delete process.env.SPECIFY_INIT_DIR;
    process.chdir(tmp);
    expect(() => resolveSpecifyProjectRoot()).toThrow(ProjectResolutionError);
    const r = await capture(() => requireSpecifyProject());
    expect((r.error as CliExit).code).toBe(1);
    expect(r.err).toContain('Error: Not a Spec Kit project (no .specify/ directory)');
    expect(r.err).toContain('Run this command from a Spec Kit project root or set SPECIFY_INIT_DIR to one.');
    fs.mkdirSync(path.join(tmp, '.specify'));
    expect(requireSpecifyProject()).toBe(tmp);
  });
});

// ============================================================================
// installed-list-json
// ============================================================================

describe('installed-list-json', () => {
  const record = {
    id: 'x', name: 'X', description: 'd', version: '1.0.0', priority: 10, enabled: true,
    _json_author: 'me', _json_source: { kind: 'catalog', catalog: 'default' },
    _json_provides: { commands: ['a'], templates: [], scripts: [], hooks: ['h'] },
  };
  test('normalizedSource', () => {
    expect(normalizedSource(null)).toEqual({ kind: 'local' });
    expect(normalizedSource({ kind: 'catalog', catalog: ' ' })).toEqual({ kind: 'local' });
    expect(normalizedSource({ kind: 'catalog', catalog: 'c' })).toEqual({ kind: 'catalog', catalog: 'c' });
    expect(normalizedSource({ kind: 'weird' })).toEqual({ kind: 'local' });
  });
  test('installedListItem includes/excludes hooks', () => {
    expect(installedListItem(record, { includeHooks: true }).provides).toEqual(record._json_provides);
    expect(installedListItem(record, { includeHooks: false })).toEqual({
      id: 'x', name: 'X', description: 'd', version: '1.0.0', author: 'me', priority: 10, enabled: true,
      source: { kind: 'catalog', catalog: 'default' }, provides: { commands: ['a'], templates: [], scripts: [] },
    });
  });
  test('emitJson / emitJsonError', async () => {
    const a = await capture(() => emitJson({ a: 'é' }));
    expect(a.out).toBe('{"a": "é"}\n');
    const b = await capture(() => emitJsonError(new Error('  boom  ')));
    expect(b.err).toBe('{"error": "boom"}\n');
    expect((b.error as CliExit).code).toBe(1);
  });
  test('parseInstalledListArgs routes usage errors to JSON when --json', async () => {
    const r = await capture(() =>
      parseInstalledListArgs(['--json', '--bogus'], () => parseArgs({ name: 'list', options: [{ name: 'json', flags: ['--json'], type: 'boolean' }] }, ['--json', '--bogus'])),
    );
    expect(r.err).toBe('{"error": "No such option: --bogus"}\n');
    expect((r.error as CliExit).code).toBe(2);
  });
});

// ============================================================================
// assets
// ============================================================================

describe('assets', () => {
  test('getSpeckitVersion returns our package.json version', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@oakoliver/specify-cli');
    expect(getSpeckitVersion()).toBe(pkg.version);
  });
  test('locates core_pack and bundled assets', () => {
    expect(locateCorePack()).toBe(path.join(packageRoot(), 'core_pack'));
    expect(locateBundledExtension('git')).toBe(path.join(packageRoot(), 'core_pack', 'extensions', 'git'));
    expect(locateBundledWorkflow('speckit')).toBe(path.join(packageRoot(), 'core_pack', 'workflows', 'speckit'));
    expect(locateBundledPreset('lean')).toBe(path.join(packageRoot(), 'core_pack', 'presets', 'lean'));
  });
  test('rejects invalid ids and missing assets', () => {
    expect(locateBundledExtension('../git')).toBeNull();
    expect(locateBundledExtension('Git')).toBeNull();
    expect(locateBundledWorkflow('-bad')).toBeNull();
    expect(locateBundledPreset('does-not-exist')).toBeNull();
  });
});

// ============================================================================
// catalogs
// ============================================================================

class TestCatalogError extends Error {}
class TestValidationError extends Error {}
class TestStack extends CatalogStackBase {
  static override ERROR_TYPE = TestCatalogError;
  static override VALIDATION_ERROR_TYPE = TestValidationError;
  static override CONFIG_FILENAME = 'test-catalogs.yml';
}

describe('catalogs', () => {
  const write = (text: string): string => {
    const p = path.join(tmp, 'catalogs.yml');
    fs.writeFileSync(p, text);
    return p;
  };
  test('missing file returns null', () => {
    expect(new TestStack().loadCatalogConfig(path.join(tmp, 'none.yml'))).toBeNull();
  });
  test('valid config sorted by priority with defaults', () => {
    const entries = new TestStack().loadCatalogConfig(
      write(`catalogs:
  - url: https://b.example/c.json
    name: second
    priority: 5
    install_allowed: "yes"
  - url: http://localhost:8000/c.json
    priority: 1
    install_allowed: true
    description: local
  - url: ""
`),
    )!;
    expect(entries.map((e) => [e.name, e.priority, e.install_allowed, e.description])).toEqual([
      ['catalog-2', 1, true, 'local'],
      ['second', 5, true, ''],
    ]);
    expect(entries[0]).toBeInstanceOf(CatalogEntry);
  });
  test.each([
    ['[1, 2]', 'expected a YAML mapping at the root'],
    ['catalogs: {}', "'catalogs' must be a list, got dict"],
    ['catalogs: []', "exists but contains no 'catalogs' entries"],
    ['catalogs: [1]', 'catalog entry at index 0: expected a mapping, got int'],
    ['catalogs:\n  - url: http://example.com/x', 'Invalid catalog URL in'],
    ['catalogs:\n  - url: https://x.example/a\n    priority: high', "Invalid priority for catalog '1': expected integer, got 'high'"],
    ['catalogs:\n  - url: https://x.example/a\n    name: n\n    priority: true', "Invalid priority for catalog 'n': expected integer, got True"],
    ['catalogs:\n  - url: https://x.example/a\n    priority: .inf', 'expected integer, got inf'],
    ['catalogs:\n  - name: nourl', 'contains 1 entries but none have valid URLs (entries at indices [0] were skipped)'],
    ['a: [1', 'Failed to read catalog config'],
  ])('%j fails with %s', (yamlText, message) => {
    const p = write(yamlText);
    expect(() => new TestStack().loadCatalogConfig(p)).toThrow(TestValidationError);
    expect(() => new TestStack().loadCatalogConfig(p)).toThrow(message);
  });
  test('validateCatalogUrl', () => {
    expect(() => TestStack.validateCatalogUrl('https://example.com/c.json')).not.toThrow();
    expect(() => TestStack.validateCatalogUrl('http://127.0.0.1:9/c.json')).not.toThrow();
    expect(() => TestStack.validateCatalogUrl('http://example.com/c.json')).toThrow(
      'Catalog URL must use HTTPS (got http://). HTTP is only allowed for localhost.',
    );
    expect(() => TestStack.validateCatalogUrl('https://:8080/x')).toThrow('Catalog URL must be a valid URL with a host.');
    expect(() => TestStack.validateCatalogUrl('https://example.com:bad/x')).toThrow('Catalog URL is malformed: https://example.com:bad/x');
    expect(() => TestStack.validateCatalogUrl('https://example.com:99999/x')).toThrow(TestCatalogError);
  });
});

// ============================================================================
// utils
// ============================================================================

describe('utils: PEP 440 (parity with packaging)', () => {
  test('sort order', () => {
    const sorted = [...PEP440_VERSIONS].sort((a, b) => new Version(a).compare(b));
    expect(sorted).toEqual(PEP440_SORTED);
  });
  for (const [spec, expected] of PEP440_MATRIX) {
    test(`SpecifierSet(${JSON.stringify(spec)})`, () => {
      expect(PEP440_VERSIONS.map((v) => versionSatisfies(v, spec))).toEqual(expected);
    });
  }
  test('normalized string form', () => {
    expect(['1.0.0-RC1', 'v1.0', '1.0.0.POST', '1.0-dev', '1.0.0alpha2'].map((v) => String(new Version(v)))).toEqual([
      '1.0.0rc1', '1.0', '1.0.0.post0', '1.0.dev0', '1.0.0a2',
    ]);
  });
  test('invalid inputs', () => {
    expect(versionSatisfies('not-a-version', '>=1')).toBe(false);
    expect(() => new SpecifierSet('>>1')).toThrow();
  });
});

describe('utils: JSON helpers', () => {
  test('parseJson5 handles JSONC', () => {
    expect(parseJson5(`\ufeff{
      // comment
      "a": 1, /* block */ b: 'two',
      c: [1, 2,], d: 0x10, e: +Infinity, f: .5,
    }`)).toEqual({ a: 1, b: 'two', c: [1, 2], d: 16, e: Infinity, f: 0.5 });
    expect(() => parseJson5('{a: }')).toThrow();
  });
  test('pyJsonDumps mirrors json.dumps', () => {
    expect(pyJsonDumps({ b: [1, 2], a: 'é' })).toBe('{"b": [1, 2], "a": "\\u00e9"}');
    expect(pyJsonDumps({ b: 1, a: { d: 1, c: 2 } }, { sortKeys: true, indent: 2, ensureAscii: false })).toBe(
      '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}',
    );
  });
  test('pyTypeName', () => {
    expect([null, true, 1, 1.5, 's', [], {}].map(pyTypeName)).toEqual(['NoneType', 'bool', 'int', 'float', 'str', 'list', 'dict']);
  });
});

describe('utils: mergeJsonFiles (port of test_merge.py)', () => {
  const file = (content: string): string => {
    const p = path.join(tmp, 'settings.json');
    fs.writeFileSync(p, content);
    return p;
  };
  test('type mismatch preserved -> null', () => {
    expect(mergeJsonFiles(file('{"chat.editor.fontFamily": "CustomFont"}'), { 'chat.editor.fontFamily': { font: 'T' } })).toBeNull();
  });
  test('deep nesting merge', () => {
    const merged = mergeJsonFiles(file('{"a": {"b": {"c": 1}}}'), { a: { b: { d: 2 }, e: 3 } })!;
    expect(merged).toEqual({ a: { b: { c: 1, d: 2 }, e: 3 } });
  });
  test('empty existing', () => {
    expect(mergeJsonFiles(file('{}'), { a: 1 })).toEqual({ a: 1 });
  });
  test('realistic vscode JSONC', () => {
    const merged = mergeJsonFiles(
      file('{\n  // user settings\n  "editor.fontSize": 14,\n  "chat.promptFilesRecommendations": {"x": true},\n}'),
      { 'chat.promptFilesRecommendations': { 'speckit.plan': true }, 'chat.tools.terminal.autoApprove': { '.specify/scripts/bash/': true } },
    )!;
    expect(merged['editor.fontSize']).toBe(14);
    expect(merged['chat.promptFilesRecommendations']).toEqual({ x: true, 'speckit.plan': true });
    expect(merged['chat.tools.terminal.autoApprove']).toEqual({ '.specify/scripts/bash/': true });
  });
  test('BOM', () => {
    expect(mergeJsonFiles(file('\ufeff{"a": 1}'), { b: 2 })).toEqual({ a: 1, b: 2 });
  });
  test('template not a dict / unparseable existing / non-object existing', () => {
    expect(mergeJsonFiles(file('{"a": 1}'), [1, 2])).toBeNull();
    expect(mergeJsonFiles(file('{not json'), { a: 1 })).toBeNull();
    expect(mergeJsonFiles(file('[1]'), { a: 1 })).toBeNull();
  });
  test('lists preserved, no-op returns null', () => {
    expect(mergeJsonFiles(file('{"l": [1]}'), { l: [2, 3] })).toBeNull();
    expect(mergeJsonFiles(file('{"a": 1}'), { a: 1 })).toBeNull();
  });
  test('missing file returns template', () => {
    expect(mergeJsonFiles(path.join(tmp, 'none.json'), { a: 1 })).toEqual({ a: 1 });
  });
  test('handleVscodeSettings copies, merges, and preserves mode', () => {
    const src = path.join(tmp, 'template.json');
    fs.writeFileSync(src, '{"a": {"b": 1}, // c\n}');
    const dest = path.join(tmp, 'dest.json');
    handleVscodeSettings(src, dest, '.vscode/settings.json');
    expect(fs.readFileSync(dest, 'utf8')).toBe(fs.readFileSync(src, 'utf8'));
    fs.writeFileSync(dest, '{"z": "é"}');
    fs.chmodSync(dest, 0o640);
    handleVscodeSettings(src, dest, '.vscode/settings.json');
    expect(fs.readFileSync(dest, 'utf8')).toBe('{\n    "z": "\\u00e9",\n    "a": {\n        "b": 1\n    }\n}\n');
    expect(fs.statSync(dest).mode & 0o777).toBe(0o640);
  });
});

describe('utils: misc', () => {
  test.each([
    ['commands/run.md', null],
    ['', 'must be a non-empty string'],
    [' x', 'must not have leading or trailing whitespace'],
    ['a\\b', 'must use forward slashes as path separators'],
    ['/abs', "must be a relative path within the extension directory (no absolute paths, drive letters, or '..' segments)"],
    ['C:foo', "must be a relative path within the extension directory (no absolute paths, drive letters, or '..' segments)"],
    ['a/../b', "must be a relative path within the extension directory (no absolute paths, drive letters, or '..' segments)"],
    ['dir/', 'must name a file or command, not a directory'],
    ['con.md', 'must use portable path components (no reserved names or platform-invalid characters)'],
    ['a|b', 'must use portable path components (no reserved names or platform-invalid characters)'],
  ])('relativeExtensionPathViolation(%j)', (value, expected) => {
    expect(relativeExtensionPathViolation(value)).toBe(expected as string | null);
  });
  test('relativeExtensionPathViolation rejects non-strings', () => {
    expect(relativeExtensionPathViolation(5)).toBe('must be a non-empty string');
  });
  test('dumpFrontmatter keeps order and unicode', () => {
    expect(dumpFrontmatter({ name: 'speckit-plan', description: 'Plan — café' })).toBe('name: speckit-plan\ndescription: Plan — café');
  });
  test('checkTool honours Claude local installs, aliases and tracker', () => {
    const saved = { ...CLAUDE_PATHS };
    const savedWhich = toolLookup.which;
    try {
      const fake = path.join(tmp, 'claude');
      fs.writeFileSync(fake, '');
      CLAUDE_PATHS.local = path.join(tmp, 'missing');
      CLAUDE_PATHS.npmLocal = fake;
      toolLookup.which = () => null;
      const calls: string[] = [];
      const tracker = { complete: (k: string, d: string) => calls.push(`done:${k}:${d}`), error: (k: string, d: string) => calls.push(`err:${k}:${d}`) };
      expect(checkTool('claude', tracker)).toBe(true);
      CLAUDE_PATHS.npmLocal = path.join(tmp, 'missing2');
      expect(checkTool('claude', tracker)).toBe(false);
      expect(calls).toEqual(['done:claude:available', 'err:claude:not found']);
      toolLookup.which = (cmd) => (cmd === 'kiro' ? '/bin/kiro' : cmd === 'acli' ? '/bin/acli' : null);
      expect(checkTool('kiro-cli')).toBe(true);
      expect(checkTool('rovodev')).toBe(true);
      expect(checkTool('gemini')).toBe(false);
    } finally {
      Object.assign(CLAUDE_PATHS, saved);
      toolLookup.which = savedWhich;
    }
  });
});

// ============================================================================
// console
// ============================================================================

describe('console: markup', () => {
  test.each([
    ['[bold]x[/bold]', '\\[bold]x\\[/bold]'],
    ['foo[x]', 'foo\\[x]'],
    ['[1]', '[1]'],
    ['a\\', 'a\\\\'],
    ['\\[bold]', '\\\\\\[bold]'],
    ['path/[id]/z', 'path/\\[id]/z'],
  ])('escapeMarkup(%j) == rich.markup.escape', (input, expected) => {
    expect(escapeMarkup(input)).toBe(expected);
  });
  test.each([
    ['[bold]x[/bold]', 'x'],
    ['foo[x]', 'foo'],
    ['[1]', '[1]'],
    ['\\[bold]', '[bold]'],
    ['[link=https://x]y[/link]', 'y'],
    ['path/[id]/z', 'path//z'],
    ['[red]Error:[/red] [bold cyan]a[/] b', 'Error: a b'],
  ])('stripMarkup(%j) == rich render plain', (input, expected) => {
    expect(stripMarkup(input)).toBe(expected);
  });
  test('escaped text renders verbatim', () => {
    expect(stripMarkup(escapeMarkup('[project] [/weird]'))).toBe('[project] [/weird]');
  });
  test('styles map to ANSI', () => {
    expect(renderMarkup('[red]x[/red]', true)).toBe('\x1b[31mx\x1b[0m');
    expect(renderMarkup('[bold cyan]x[/]', true)).toBe('\x1b[1;36mx\x1b[0m');
    expect(renderMarkup('[red]x[/red]', false)).toBe('x');
    expect(parseMarkup('[green]a[dim]b[/dim][/green]')).toEqual([
      { text: 'a', style: 'green' },
      { text: 'b', style: 'green dim' },
    ]);
  });
});

describe('console: renderables', () => {
  const con = new Console({ color: false, width: 40, file: { write: () => true } });
  test('Table with header and box', () => {
    const t = new Table({ title: 'T' });
    t.addColumn('Key', { style: 'cyan' });
    t.addColumn('Name');
    t.addRow('a', 'Alpha');
    expect(con.renderToString([t])).toBe(
      '       T       \n┏━━━━━┳━━━━━━━┓\n┃ Key ┃ Name  ┃\n┡━━━━━╇━━━━━━━┩\n│ a   │ Alpha │\n└─────┴───────┘\n',
    );
  });
  test('Table.grid', () => {
    const t = Table.grid({ padding: [0, 2] });
    t.addColumn('');
    t.addColumn('');
    t.addRow('k', 'v');
    expect(con.renderToString([t])).toBe('k  v\n');
  });
  test('Panel with title', () => {
    expect(con.renderToString([new Panel('hi', { title: 'Title' })])).toBe(
      '╭─────────────── Title ────────────────╮\n│ hi                                   │\n╰──────────────────────────────────────╯\n',
    );
  });
  test('Tree and StepTracker', () => {
    const tree = new Tree('root');
    tree.add('a').add('a1');
    tree.add('b');
    expect(con.renderToString([tree])).toBe('root\n├── a\n│   └── a1\n└── b\n');
    const tracker = new StepTracker('Init');
    tracker.add('x', 'Fetch');
    tracker.complete('x', 'ok');
    tracker.error('y', 'boom');
    expect(con.renderToString([tracker.render()])).toBe('Init\n├── ● Fetch (ok)\n└── ● y (boom)\n');
  });
  test('capture', () => {
    const c = new Console({ width: 80 });
    c.beginCapture();
    c.print('[red]a[/red]', 'b');
    c.print('x', { end: '' });
    expect(c.endCapture()).toBe('a b\nx');
  });
});

describe('console: prompts', () => {
  afterEach(() => setPromptInput(null));
  test('confirm parses y/n/default and aborts on EOF', async () => {
    setPromptInput(['y', '', 'maybe', 'no']);
    const r = await capture(async () => [await confirm('Continue?'), await confirm('Again?', { default: true }), await confirm('Third?')]);
    expect(r.value).toEqual([true, true, false]);
    expect(r.out).toContain('Continue? [y/N]: ');
    expect(r.out).toContain('Again? [Y/n]: ');
    expect(r.err).toContain('Error: invalid input');
    setPromptInput([]);
    const eof = await capture(() => confirm('Go?'));
    expect(eof.error).toBeInstanceOf(CliAbort);
  });
  test('prompt returns default on empty input', async () => {
    setPromptInput(['', 'value']);
    const r = await capture(async () => [await prompt('Name', { default: 'dflt' }), await prompt('Other')]);
    expect(r.value).toEqual(['dflt', 'value']);
    expect(r.out).toContain('Name [dflt]: ');
  });
});

// ============================================================================
// cli-args
// ============================================================================

const SPEC: CommandSpec = {
  name: 'add',
  help: 'Install an extension.',
  arguments: [{ name: 'extension', required: true, help: 'Extension name or path' }],
  options: [
    { name: 'dev', flags: ['--dev'], type: 'boolean', help: 'Install from local directory' },
    { name: 'from', flags: ['--from'], help: 'Install from custom URL' },
    { name: 'priority', flags: ['--priority'], type: 'int', default: 10, help: 'Resolution priority' },
    { name: 'input', flags: ['--input', '-i'], multiple: true },
    { name: 'color', flags: ['--color'], negFlags: ['--no-color'], type: 'boolean', default: true },
    { name: 'script', flags: ['--script'], choices: ['sh', 'ps'] },
  ],
};

describe('cli-args', () => {
  test('parses options, aliases, repeatables, negation, interspersed args', () => {
    const r = parseArgs(SPEC, ['--priority=3', 'ext', '-i', 'a=1', '-ib=2', '--no-color', '--dev', '--from', 'u']);
    expect(r.args).toEqual({ extension: 'ext' });
    expect(r.options).toEqual({ dev: true, from: 'u', priority: 3, input: ['a=1', 'b=2'], color: false, script: null });
    expect([...r.provided].sort()).toEqual(['color', 'dev', 'from', 'input', 'priority']);
  });
  test('defaults and -- terminator', () => {
    const r = parseArgs(SPEC, ['--', '--dev']);
    expect(r.args.extension).toBe('--dev');
    expect(r.options.priority).toBe(10);
    expect(r.options.dev).toBe(false);
  });
  test.each([
    [[], "Missing argument 'extension'."],
    [['x', '--priority', 'y'], "Invalid value for '--priority': 'y' is not a valid int."],
    [['x', '--from'], "Option '--from' requires an argument."],
    [['x', '--dev=1'], "Option '--dev' does not take a value."],
    [['x', 'y', 'z'], 'Got unexpected extra argument(s) (y z)'],
    [['x', '--bogus'], 'No such option: --bogus'],
    [['x', '--priorty', '1'], 'No such option: --priorty Did you mean --priority?'],
    [['x', '--script', 'zsh'], "Invalid value for '--script': 'zsh' is not one of 'sh', 'ps'."],
  ])('usage error for %j', (argv, message) => {
    expect(() => parseArgs(SPEC, argv as string[])).toThrow(UsageError);
    expect(() => parseArgs(SPEC, argv as string[])).toThrow(message);
  });
  test('--help anywhere', () => {
    expect(parseArgs(SPEC, ['x', '--help']).help).toBe(true);
    const help = formatHelp(SPEC, 'specify extension add', new Console({ color: false, width: 80, file: { write: () => true } }));
    expect(help).toContain('Usage: specify extension add [OPTIONS] {extension}');
    expect(help).toContain('Install an extension.');
    expect(help).toContain('--priority');
    expect(help).toContain('<int>');
    expect(help).toContain('[default: 10]');
    expect(help).toContain('[required]');
  });
  test('runCommand prints usage errors to stderr with exit 2 and handles CliExit', async () => {
    const r = await capture(() => runCommand(SPEC, [], 'specify extension add', () => 0));
    expect(r.value).toBe(2);
    expect(r.err).toContain('Usage: specify extension add [OPTIONS] {extension}');
    expect(r.err).toContain("Try 'specify extension add --help' for help.");
    expect(r.err).toContain("Missing argument 'extension'.");
    const r2 = await capture(() =>
      runCommand(SPEC, ['x'], 'specify extension add', () => {
        throw new CliExit(3);
      }),
    );
    expect(r2.value).toBe(3);
    const r3 = await capture(() => runCommand(SPEC, ['x', '--help'], 'specify extension add', () => 0));
    expect(r3.value).toBe(0);
    expect(r3.out).toContain('Usage: specify extension add');
  });
  test('dispatchGroup', async () => {
    let seen: unknown = null;
    const group = {
      name: 'extension',
      help: 'Manage extensions',
      commands: [defineCommand(SPEC, (p) => {
        seen = p.args.extension;
        return 0;
      })],
    };
    const ok = await capture(() => dispatchGroup(group, ['add', 'git'], 'specify extension'));
    expect(ok.value).toBe(0);
    expect(seen).toBe('git');
    const missing = await capture(() => dispatchGroup(group, [], 'specify extension'));
    expect(missing.value).toBe(2);
    expect(missing.err).toContain('Missing command.');
    const unknown = await capture(() => dispatchGroup(group, ['nope'], 'specify extension'));
    expect(unknown.value).toBe(2);
    expect(unknown.err).toContain("No such command 'nope'.");
    const help = await capture(() => dispatchGroup(group, ['--help'], 'specify extension'));
    expect(help.value).toBe(0);
    expect(help.out).toContain('Commands');
    expect(help.out).toContain('add');
  });
});

describe('cli-args/console: Typer/Rich layout details', () => {
  const con = new Console({ color: false, width: 80, file: { write: () => true } });
  test('optional positional renders once-bracketed; help keeps relative indentation', () => {
    const spec: CommandSpec = {
      name: 'init',
      help: 'Initialize.\n\n    Examples:\n        specify init x\n',
      arguments: [{ name: 'project_name', help: 'Name' }],
    };
    const help = formatHelp(spec, 'specify init', con);
    expect(help).toContain('Usage: specify init [OPTIONS] [project_name]');
    expect(help).not.toContain('[[project_name]]');
    expect(help).toContain(' Examples:\n');
    expect(help).toContain('     specify init x\n');
  });
  test('Align.center pads both sides to full width like Rich', async () => {
    const { Align, Text } = await import('../src/console.js');
    const out = new Console({ color: false, width: 10, file: { write: () => true } }).renderToString([Align.center(new Text('ab'))]);
    expect(out).toBe('    ab    \n');
  });
  test('confirm EOF prints no extra newline', async () => {
    setPromptInput([]);
    const r = await capture(() => confirm('Go?'));
    setPromptInput(null);
    expect(r.out).toBe('Go? [y/N]: ');
  });
});
