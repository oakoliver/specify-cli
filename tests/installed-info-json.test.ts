/**
 * Public JSON contracts for installed preset and extension info (port of
 * upstream tests/test_installed_info_json.py, spec-kit v1.2.5).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { console as richConsole, errConsole } from '../src/console.js';
import { runExtensionCommand } from '../src/extensions/commands.js';
import { ExtensionManager } from '../src/extensions/index.js';
import { presetInfo, runPresetCommand } from '../src/presets/commands.js';
import { PresetManager } from '../src/presets/manager.js';
import { setPresetWarningHandler } from '../src/presets/manifest.js';

const SOURCE = { kind: 'catalog', catalog: 'speckit-official' };
const PRESET_SOURCE = { layer: 'preset', presetId: 'info-preset' };
const EXTENSION_SOURCE = { layer: 'extension', extensionId: 'info-ext' };

let tmp: string;
let origCwd: string;
let out: string[];
let err: string[];
let origOut: typeof process.stdout.write;
let origErr: typeof process.stderr.write;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'info-json-'));
  origCwd = process.cwd();
  out = [];
  err = [];
  origOut = process.stdout.write.bind(process.stdout);
  origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    err.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  richConsole.file = { write: (s: string) => out.push(s), isTTY: false, columns: 200 };
  errConsole.file = { write: (s: string) => err.push(s), isTTY: false, columns: 200 };
  setPresetWarningHandler(() => undefined);
});

afterEach(() => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  richConsole.file = process.stdout;
  errConsole.file = process.stderr;
  setPresetWarningHandler(null);
  process.chdir(origCwd);
  rmSync(tmp, { recursive: true, force: true });
});

function project(): string {
  const p = join(tmp, 'project');
  mkdirSync(join(p, '.specify'), { recursive: true });
  return p;
}

function preset(p: string, presetId = 'info-preset'): void {
  const dir = join(p, '.specify', 'presets', presetId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'preset.yml'),
    'schema_version: "1.0"\n' +
      'preset:\n' +
      `  id: ${presetId}\n` +
      '  name: Info Preset\n' +
      '  version: "1.0.0"\n' +
      '  description: preset description\n' +
      '  author: Preset Author\n' +
      'requires:\n' +
      '  speckit_version: ">=0.1.0"\n' +
      'provides:\n' +
      '  templates:\n' +
      '    - type: command\n' +
      '      name: speckit.plan\n' +
      '      file: commands/plan.md\n' +
      '      description: Wrapped plan\n' +
      '      strategy: WRAP\n' +
      '    - type: template\n' +
      '      name: spec-template\n' +
      '      file: templates/spec.md\n' +
      '    - type: script\n' +
      '      name: setup-plan\n' +
      '      file: scripts/setup-plan.sh\n' +
      '      strategy: wrap\n',
  );
  new PresetManager(p).registry.add(presetId, { version: '1.0.0', source: SOURCE, priority: 3 });
}

function extension(p: string, extensionId = 'info-ext'): void {
  const dir = join(p, '.specify', 'extensions', extensionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'extension.yml'),
    'schema_version: "1.0"\n' +
      'extension:\n' +
      `  id: ${extensionId}\n` +
      '  name: Info Extension\n' +
      '  version: "1.0.0"\n' +
      '  description: extension description\n' +
      'requires:\n' +
      '  speckit_version: ">=0.1.0"\n' +
      'provides:\n' +
      '  commands:\n' +
      `    - name: speckit.${extensionId}.check\n` +
      '      file: commands/check.md\n' +
      '      description: Run the check\n' +
      '  templates:\n' +
      '    - name: report\n' +
      '      file: templates/report.md\n' +
      '  scripts:\n' +
      '    - name: collect\n' +
      '      file: scripts/collect.sh\n' +
      '      runtimes: [bash, python]\n' +
      '    - name: notify\n' +
      '      file: scripts/notify.sh\n' +
      'hooks:\n' +
      '  before_plan:\n' +
      `    command: speckit.${extensionId}.check\n` +
      '  after_tasks:\n' +
      `    - command: speckit.${extensionId}.check\n` +
      '      priority: 5\n' +
      '      optional: false\n' +
      `    - command: speckit.${extensionId}.check\n` +
      '      priority: 20\n' +
      '    - command: speckit.tasks\n' +
      '      optional: false\n',
  );
  new ExtensionManager(p).registry.add(extensionId, { version: '1.0.0', source: SOURCE, priority: 4 });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonResult(run: () => Promise<number>): Promise<any> {
  out = [];
  err = [];
  const code = await run();
  expect(code).toBe(0);
  expect(err.join('')).toBe('');
  return JSON.parse(out.join(''));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withoutProvides = (item: Record<string, any>): Record<string, any> => {
  const { provides: _p, ...rest } = item;
  return rest;
};

describe('preset info --json', () => {
  test('expands the list item', async () => {
    const p = project();
    preset(p);
    process.chdir(p);
    const listed = (await jsonResult(() => runPresetCommand(['list', '--json'])))[0];
    const info = await jsonResult(() => runPresetCommand(['info', 'info-preset', '--json']));
    expect(new Set(Object.keys(info))).toEqual(
      new Set([...Object.keys(withoutProvides(listed)), 'commands', 'templates', 'scripts']),
    );
    for (const [k, v] of Object.entries(withoutProvides(listed))) expect(info[k]).toEqual(v);
    expect(info.source).toEqual(SOURCE);
    expect(info.commands).toEqual([
      { name: 'speckit.plan', description: 'Wrapped plan', source: PRESET_SOURCE, sourcePath: 'commands/plan.md', strategy: 'wrap' },
    ]);
    expect(info.templates).toEqual([
      { name: 'spec-template', description: '', source: PRESET_SOURCE, sourcePath: 'templates/spec.md', strategy: 'replace' },
    ]);
    expect(info.scripts).toEqual([
      { name: 'setup-plan', description: '', source: PRESET_SOURCE, sourcePath: 'scripts/setup-plan.sh', strategy: 'wrap' },
    ]);
  });

  test('gives an empty description as a string', async () => {
    const p = project();
    preset(p);
    const manifest = join(p, '.specify', 'presets', 'info-preset', 'preset.yml');
    writeFileSync(
      manifest,
      readFileSync(manifest, 'utf-8').replace('      description: Wrapped plan\n', '      description:\n'),
    );
    process.chdir(p);
    const info = await jsonResult(() => runPresetCommand(['info', 'info-preset', '--json']));
    expect(info.commands[0].description).toBe('');
  });

  test('a direct call keeps the human-readable view', async () => {
    const p = project();
    preset(p);
    process.chdir(p);
    await presetInfo('info-preset');
    const text = out.join('');
    expect(text).toContain('Preset: Info Preset');
    expect(() => JSON.parse(text)).toThrow();
  });

  test('cannot be combined with --versions', async () => {
    const p = project();
    preset(p);
    process.chdir(p);
    expect(await runPresetCommand(['info', 'info-preset', '--json', '--versions'])).toBe(2);
    expect(out.join('')).toBe('');
    expect(err.join('')).toBe('{"error": "--json cannot be combined with --versions"}\n');
  });
});

describe('extension info --json', () => {
  test('expands the list item', async () => {
    const p = project();
    extension(p);
    process.chdir(p);
    const listed = (await jsonResult(() => runExtensionCommand(['list', '--json'])))[0];
    const info = await jsonResult(() => runExtensionCommand(['info', 'info-ext', '--json']));
    expect(new Set(Object.keys(info))).toEqual(
      new Set([...Object.keys(withoutProvides(listed)), 'commands', 'templates', 'scripts', 'hooks']),
    );
    for (const [k, v] of Object.entries(withoutProvides(listed))) expect(info[k]).toEqual(v);
    expect(info.commands).toEqual([
      { name: 'speckit.info-ext.check', description: 'Run the check', source: EXTENSION_SOURCE, sourcePath: 'commands/check.md' },
    ]);
    expect(info.templates).toEqual([
      { name: 'report', description: '', source: EXTENSION_SOURCE, sourcePath: 'templates/report.md' },
    ]);
    expect(info.scripts).toEqual([
      {
        name: 'collect',
        description: '',
        source: EXTENSION_SOURCE,
        sourcePath: 'scripts/collect.sh',
        runtimes: ['bash', 'python'],
      },
      { name: 'notify', description: '', source: EXTENSION_SOURCE, sourcePath: 'scripts/notify.sh' },
    ]);
  });

  test('hooks use registration defaults and the last declaration', async () => {
    const p = project();
    extension(p);
    process.chdir(p);
    const info = await jsonResult(() => runExtensionCommand(['info', 'info-ext', '--json']));
    expect(info.hooks).toEqual([
      { trigger: 'before_plan', targetCommand: 'speckit.info-ext.check', optional: true, priority: 10 },
      { trigger: 'after_tasks', targetCommand: 'speckit.info-ext.check', optional: true, priority: 20 },
      { trigger: 'after_tasks', targetCommand: 'speckit.tasks', optional: false, priority: 10 },
    ]);
  });

  test('resolves a unique display name', async () => {
    const p = project();
    extension(p);
    process.chdir(p);
    const info = await jsonResult(() => runExtensionCommand(['info', 'info extension', '--json']));
    expect(info.id).toBe('info-ext');
  });

  test('rejects an ambiguous display name', async () => {
    const p = project();
    extension(p, 'info-ext');
    extension(p, 'other-ext');
    process.chdir(p);
    expect(await runExtensionCommand(['info', 'Info Extension', '--json'])).toBe(1);
    expect(out.join('')).toBe('');
    expect(JSON.parse(err.join(''))).toEqual({
      error: "Extension name 'Info Extension' is ambiguous; use one of the IDs: info-ext, other-ext",
    });
  });

  test('cannot be combined with --versions', async () => {
    const p = project();
    extension(p);
    process.chdir(p);
    expect(await runExtensionCommand(['info', 'info-ext', '--json', '--versions'])).toBe(2);
    expect(out.join('')).toBe('');
    expect(err.join('')).toBe('{"error": "--json cannot be combined with --versions"}\n');
  });
});

describe('info --json error contract', () => {
  const run = (command: string, args: string[]): Promise<number> =>
    command === 'preset' ? runPresetCommand(args) : runExtensionCommand(args);

  for (const [command, kind] of [
    ['preset', 'Preset'],
    ['extension', 'Extension'],
  ]) {
    test(`${command}: a pack that is not installed is stderr only`, async () => {
      process.chdir(project());
      expect(await run(command, ['info', 'missing', '--json'])).toBe(1);
      expect(out.join('')).toBe('');
      expect(JSON.parse(err.join(''))).toEqual({ error: `${kind} 'missing' is not installed` });
    });

    test(`${command}: outside a project is stderr only`, async () => {
      process.chdir(tmp);
      expect(await run(command, ['info', 'anything', '--json'])).toBe(1);
      expect(out.join('')).toBe('');
      expect(JSON.parse(err.join('')).error.startsWith('Not a Spec Kit project')).toBe(true);
    });
  }

  for (const [command, parameter] of [
    ['preset', 'preset_id'],
    ['extension', 'extension'],
  ]) {
    test(`${command}: usage errors are stderr only`, async () => {
      process.chdir(project());
      expect(await run(command, ['info', '--json'])).toBe(2);
      expect(out.join('')).toBe('');
      expect(JSON.parse(err.join(''))).toEqual({ error: `Missing parameter: ${parameter}` });
    });
  }
});
