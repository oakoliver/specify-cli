/**
 * Port of upstream ``TestNormalizePriority``, ``TestExtensionManifest`` and
 * ``TestExtensionManifestTemplatesAndScripts`` (tests/test_extensions.py).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  CORE_COMMAND_NAMES,
  ExtensionManifest,
  ValidationError,
  normalizePriority,
} from '../src/extensions/index.js';
import { dumpYaml } from '../src/yaml.js';
import {
  type AnyDict,
  cleanupTempDirs,
  makeExtensionDir,
  makeTempDir,
  validManifestData,
  writeManifest,
} from './extensions-helpers.js';

afterEach(cleanupTempDirs);

function load(data: AnyDict): ExtensionManifest {
  const dir = makeTempDir();
  return new ExtensionManifest(writeManifest(dir, data));
}

function expectInvalid(data: AnyDict, match: string | RegExp): void {
  let err: unknown;
  try {
    load(data);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ValidationError);
  if (typeof match === 'string') expect((err as Error).message).toContain(match);
  else expect((err as Error).message).toMatch(match);
}

describe('normalizePriority', () => {
  test('valid integer', () => expect(normalizePriority(5)).toBe(5));
  test('valid string number', () => expect(normalizePriority('7')).toBe(7));
  test('zero returns default', () => expect(normalizePriority(0)).toBe(10));
  test('negative returns default', () => expect(normalizePriority(-3)).toBe(10));
  test('none returns default', () => expect(normalizePriority(null)).toBe(10));
  test('invalid string returns default', () => expect(normalizePriority('high')).toBe(10));
  test('float truncates', () => expect(normalizePriority(5.9)).toBe(5));
  test('empty string returns default', () => expect(normalizePriority('')).toBe(10));
  test('custom default', () => expect(normalizePriority(null, 20)).toBe(20));
  test('boolean returns default', () => {
    expect(normalizePriority(true)).toBe(10);
    expect(normalizePriority(false)).toBe(10);
  });
});

describe('ExtensionManifest', () => {
  test('valid manifest', () => {
    const extDir = makeExtensionDir(makeTempDir());
    const manifest = new ExtensionManifest(join(extDir, 'extension.yml'));
    expect(manifest.id).toBe('test-ext');
    expect(manifest.name).toBe('Test Extension');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.description).toBe('A test extension');
    expect(manifest.requiresSpeckitVersion).toBe('>=0.1.0');
    expect(manifest.commands).toHaveLength(1);
    expect(manifest.commands[0].name).toBe('speckit.test-ext.hello');
    expect(Object.keys(manifest.hooks)).toEqual(['after_tasks']);
    expect(manifest.warnings).toEqual([]);
  });

  test('core command names match bundled templates', () => {
    for (const name of ['analyze', 'plan', 'specify', 'tasks', 'taskstoissues', 'converge']) {
      expect(CORE_COMMAND_NAMES.has(name)).toBe(true);
    }
  });

  test('missing required field', () => {
    const data = validManifestData();
    delete data.provides;
    expectInvalid(data, 'Missing required field: provides');
  });

  test('missing manifest file', () => {
    expect(() => new ExtensionManifest('/nonexistent/extension.yml')).toThrow('Manifest not found: /nonexistent/extension.yml');
  });

  test('non-mapping yaml raises validation error', () => {
    const dir = makeTempDir();
    const path = join(dir, 'extension.yml');
    writeFileSync(path, '- a\n- b\n');
    expect(() => new ExtensionManifest(path)).toThrow(`Manifest must be a YAML mapping, got list: ${path}`);
  });

  test('utf8 non-ascii description loads', () => {
    const data = validManifestData();
    data.extension.description = 'Déscription — ünïcödé ✓';
    expect(load(data).description).toBe('Déscription — ünïcödé ✓');
  });

  test('invalid utf8 bytes raise validation error', () => {
    const dir = makeTempDir();
    const path = join(dir, 'extension.yml');
    writeFileSync(path, Buffer.from([0x61, 0x3a, 0x20, 0xff, 0xfe, 0x0a]));
    expect(() => new ExtensionManifest(path)).toThrow(
      `Manifest is not valid UTF-8: ${path} (invalid start byte at byte 3)`,
    );
  });

  test('invalid extension id', () => {
    const data = validManifestData();
    data.extension.id = 'Invalid_ID';
    expectInvalid(data, "Invalid extension ID 'Invalid_ID': must be lowercase alphanumeric with hyphens only");
  });

  test('invalid version', () => {
    const data = validManifestData();
    data.extension.version = 'not-a-version';
    expectInvalid(data, 'Invalid version: not-a-version');
  });

  test('non-string speckit_version', () => {
    for (const bad of [1, true, null, ['>=0.1'], { a: 1 }]) {
      const data = validManifestData();
      data.requires.speckit_version = bad;
      expectInvalid(data, 'Invalid requires.speckit_version: expected a non-empty string, got');
    }
  });

  test('empty speckit_version', () => {
    const data = validManifestData();
    data.requires.speckit_version = '   ';
    expectInvalid(data, 'Invalid requires.speckit_version: expected a non-empty string, got str');
  });

  test('valid category and effect', () => {
    const data = validManifestData();
    data.extension.category = 'docs';
    data.extension.effect = 'read-only';
    const m = load(data);
    expect(m.category).toBe('docs');
    expect(m.effect).toBe('read-only');
  });

  test('invalid category', () => {
    const data = validManifestData();
    data.extension.category = '';
    expectInvalid(data, 'Invalid extension.category: must be a non-empty string');
  });

  test('invalid effect', () => {
    const data = validManifestData();
    data.extension.effect = 'destructive';
    expectInvalid(data, "Invalid extension.effect 'destructive': must be one of ['read-only', 'read-write']");
  });

  test('category and effect optional', () => {
    const m = load(validManifestData());
    expect(m.category).toBeNull();
    expect(m.effect).toBeNull();
  });

  test('invalid command name', () => {
    const data = validManifestData();
    data.provides.commands[0].name = 'invalid-name';
    expectInvalid(data, "Invalid command name 'invalid-name': must follow pattern 'speckit.{extension}.{command}'");
  });

  test('command file traversal rejected', () => {
    for (const bad of ['../evil.md', '/abs/evil.md', 'C:evil.md', 'commands/../../x.md']) {
      const data = validManifestData();
      data.provides.commands[0].file = bad;
      expectInvalid(data, "Invalid command 'file'");
    }
  });

  test('command file whitespace rejected', () => {
    const data = validManifestData();
    data.provides.commands[0].file = ' commands/hello.md';
    expectInvalid(data, 'must not have leading or trailing whitespace');
  });

  test('command name autocorrect: speckit prefix', () => {
    const data = validManifestData();
    data.provides.commands[0].name = 'speckit.hello';
    const m = load(data);
    expect(m.commands[0].name).toBe('speckit.test-ext.hello');
    expect(m.warnings).toHaveLength(1);
    expect(m.warnings[0]).toContain("Command name 'speckit.hello' does not follow the required pattern");
    expect(m.warnings[0]).toContain("Registering as 'speckit.test-ext.hello'");
    // Hook referencing the old name is rewritten too (and warns).
  });

  test('command name autocorrect: matching ext id prefix + hook rewrite', () => {
    const data = validManifestData();
    data.provides.commands[0].name = 'test-ext.hello';
    data.hooks.after_tasks.command = 'test-ext.hello';
    const m = load(data);
    expect(m.commands[0].name).toBe('speckit.test-ext.hello');
    expect(m.hooks.after_tasks.command).toBe('speckit.test-ext.hello');
    expect(m.warnings.some((w) => w.startsWith("Hook 'after_tasks' referenced command 'test-ext.hello'"))).toBe(true);
  });

  test('mismatched namespace not corrected', () => {
    const data = validManifestData();
    data.provides.commands[0].name = 'other.hello';
    expectInvalid(data, "Invalid command name 'other.hello'");
  });

  test('alias free-form accepted', () => {
    const data = validManifestData();
    data.provides.commands[0].aliases = ['speckit.verify', 'hello'];
    expect(load(data).commands[0].aliases).toEqual(['speckit.verify', 'hello']);
  });

  test('null aliases normalized to empty list', () => {
    const data = validManifestData();
    data.provides.commands[0].aliases = null;
    expect(load(data).commands[0].aliases).toEqual([]);
  });

  test('no commands, no hooks rejected', () => {
    const data = validManifestData();
    data.provides.commands = [];
    delete data.hooks;
    expectInvalid(data, 'Extension must provide at least one command, hook, or event (or a declared template/script)');
  });

  test('hooks-only extension is valid', () => {
    const data = validManifestData();
    data.provides = {};
    expect(Object.keys(load(data).hooks)).toEqual(['after_tasks']);
  });

  test('commands null rejected', () => {
    const data = validManifestData();
    data.provides.commands = null;
    expectInvalid(data, 'Invalid provides.commands: expected a list');
  });

  test('required section not mapping rejected', () => {
    const data = validManifestData();
    data.provides = null;
    expectInvalid(data, 'Invalid provides: expected a mapping, got NoneType');
    const data2 = validManifestData();
    data2.extension = ['x'];
    expectInvalid(data2, 'Invalid extension: expected a mapping, got list');
  });

  test('extension metadata field not string rejected', () => {
    const data = validManifestData();
    data.extension.id = 2;
    expectInvalid(data, 'Invalid extension.id: expected a string, got int');
  });

  test('command name not string rejected', () => {
    const data = validManifestData();
    data.provides.commands[0].name = 2;
    expectInvalid(data, 'Invalid command name: expected a string, got int');
  });

  test('hooks not dict rejected', () => {
    const data = validManifestData();
    data.hooks = ['x'];
    expectInvalid(data, 'Invalid hooks: expected a mapping');
  });

  test('hook list of mappings accepted and normalized', () => {
    const data = validManifestData();
    data.hooks.after_tasks = [{ command: 'test-ext.hello' }, { command: 'speckit.test-ext.hello', priority: 3 }];
    const m = load(data);
    expect(m.hooks.after_tasks[0].command).toBe('speckit.test-ext.hello');
  });

  test('hook list with non-mapping entry rejected', () => {
    const data = validManifestData();
    data.hooks.after_tasks = [{ command: 'speckit.test-ext.hello' }, 'nope'];
    expectInvalid(data, "Invalid hook 'after_tasks': expected a mapping or list of mappings");
  });

  test('hook empty list rejected', () => {
    const data = validManifestData();
    data.hooks.after_tasks = [];
    expectInvalid(data, "Invalid hook 'after_tasks': list must contain at least one entry");
  });

  test('hook missing command rejected', () => {
    const data = validManifestData();
    data.hooks.after_tasks = { optional: true };
    expectInvalid(data, "Hook 'after_tasks' missing required 'command' field");
  });

  test('hook priority validation', () => {
    const data = validManifestData();
    data.hooks.after_tasks.priority = 'high';
    expectInvalid(data, "Hook 'after_tasks' has invalid 'priority': must be an integer");
    const data2 = validManifestData();
    data2.hooks.after_tasks.priority = 0;
    expectInvalid(data2, "Hook 'after_tasks' has invalid 'priority': must be >= 1");
    const data3 = validManifestData();
    data3.hooks.after_tasks.priority = true;
    expectInvalid(data3, 'must be an integer');
  });

  test('manifest hash', () => {
    const extDir = makeExtensionDir(makeTempDir());
    expect(new ExtensionManifest(join(extDir, 'extension.yml')).getHash()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('unknown event rejected', () => {
    const data = validManifestData();
    data.events = { bogus: { command: 'speckit.test-ext.hello' } };
    expectInvalid(data, "Unknown event 'bogus'");
  });

  test('event command refs are canonicalized', () => {
    const data = validManifestData();
    data.events = { session_start: { command: 'test-ext.hello' } };
    const m = load(data);
    expect(m.data.events.session_start.command).toBe('speckit.test-ext.hello');
    expect(m.warnings.some((w) => w.startsWith("Event 'session_start' referenced command"))).toBe(true);
  });

  test('invalid YAML reports file name', () => {
    const dir = makeTempDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'extension.yml');
    writeFileSync(path, 'a: [1, 2\n');
    expect(() => new ExtensionManifest(path)).toThrow(`Invalid YAML in ${path}:`);
  });
});

describe('ExtensionManifest templates and scripts', () => {
  function withSection(section: string, entries: unknown): AnyDict {
    const data = validManifestData();
    data.provides[section] = entries;
    return data;
  }

  test('templates and scripts declared', () => {
    const data = validManifestData();
    data.provides.templates = [{ name: 'spec-template', file: 'templates/spec.md', description: 'x' }];
    data.provides.scripts = [{ name: 'setup', file: 'scripts/setup.sh', runtimes: ['bash'] }];
    const m = load(data);
    expect(m.templates).toHaveLength(1);
    expect(m.scripts[0].runtimes).toEqual(['bash']);
  });

  test('templates-only extension is valid', () => {
    const data = validManifestData();
    data.provides = { templates: [{ name: 't', file: 't.md' }] };
    delete data.hooks;
    expect(load(data).templates).toHaveLength(1);
  });

  test('section must be a list', () => {
    expectInvalid(withSection('templates', { a: 1 }), 'Invalid provides.templates: expected a list');
    expectInvalid(withSection('scripts', 'x'), 'Invalid provides.scripts: expected a list');
  });

  test('entry must be a mapping', () => {
    expectInvalid(withSection('templates', ['x']), "Each entry in 'provides.templates' must be a mapping");
  });

  test('entry missing name or file', () => {
    expectInvalid(withSection('scripts', [{ name: 's' }]), "Script missing 'name' or 'file'");
    expectInvalid(withSection('templates', [{ file: 'x' }]), "Template missing 'name' or 'file'");
  });

  test('invalid name format', () => {
    expectInvalid(
      withSection('templates', [{ name: 'Bad_Name', file: 'x.md' }]),
      "Invalid template name 'Bad_Name': must be lowercase alphanumeric with hyphens only",
    );
  });

  test('duplicate names rejected', () => {
    expectInvalid(
      withSection('templates', [
        { name: 'dup', file: 'a.md' },
        { name: 'dup', file: 'b.md' },
      ]),
      "Duplicate template name 'dup' in 'provides.templates'",
    );
  });

  test('path traversal rejected', () => {
    expectInvalid(withSection('scripts', [{ name: 's', file: '../x.sh' }]), "Invalid script 'file' '../x.sh'");
  });

  test('strategy rejected', () => {
    expectInvalid(
      withSection('templates', [{ name: 't', file: 't.md', strategy: 'append' }]),
      "Invalid template entry 't': 'strategy' is not authorable for extension-provided artifacts",
    );
  });

  test('runtimes validation', () => {
    expectInvalid(
      withSection('scripts', [{ name: 's', file: 's.sh', runtimes: 'bash' }]),
      "Invalid runtimes for script 's': expected a list of strings",
    );
    expectInvalid(
      withSection('scripts', [{ name: 's', file: 's.sh', runtimes: ['bash', 'zsh', 'fish'] }]),
      "Invalid runtimes ['fish', 'zsh'] for script 's': must be one of ['bash', 'powershell', 'python']",
    );
  });

  test('description must be string', () => {
    expectInvalid(
      withSection('templates', [{ name: 't', file: 't.md', description: 5 }]),
      "Invalid template description for 't': expected a string",
    );
  });

  test('config property filters malformed entries', () => {
    const data = validManifestData();
    data.provides.config = 'nope';
    expect(load(data).config).toEqual([]);
  });

  test('yaml dump of manifest round trips', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'extension.yml'), dumpYaml(validManifestData()));
    expect(new ExtensionManifest(join(dir, 'extension.yml')).id).toBe('test-ext');
  });
});
