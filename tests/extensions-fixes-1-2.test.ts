/**
 * Extension fixes from spec-kit 1.1-1.2: config templates scaffolded on update
 * (#5011), hook commands must be strings (#5146) and top-level manifest
 * defaults (#5164). Ports of the matching upstream tests in
 * tests/specify_cli/extensions/test_command_update.py, test_command_add.py and
 * tests/test_extensions.py.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { buildZip } from '../src/bundles/packager.js';
import { console as richConsole, errConsole, setPromptInput } from '../src/console.js';
import { runExtensionCommand } from '../src/extensions/commands.js';
import { runUpdateCommand } from '../src/extensions/command-update-transaction.js';
import {
  ConfigManager,
  ExtensionCatalog,
  ExtensionManager,
  ExtensionManifest,
  ExtensionRegistry,
  HookExecutor,
  ValidationError,
} from '../src/extensions/index.js';
import { dumpYaml, parseYaml } from '../src/yaml.js';
import {
  type AnyDict,
  cleanupTempDirs,
  makeExtensionDir,
  makeProjectDir,
  makeTempDir,
  validManifestData,
  writeManifest,
} from './extensions-helpers.js';

let out: string[] = [];
let origCwd: string;
const proto = ExtensionCatalog.prototype as AnyDict;
const saved = { getExtensionInfo: proto.getExtensionInfo, downloadExtension: proto.downloadExtension };

beforeEach(() => {
  out = [];
  origCwd = process.cwd();
  richConsole.file = { write: (s: string) => out.push(s), isTTY: false, columns: 200 };
  errConsole.file = { write: (s: string) => out.push(s), isTTY: false, columns: 200 };
});

afterEach(() => {
  process.chdir(origCwd);
  richConsole.file = process.stdout;
  errConsole.file = process.stderr;
  Object.assign(proto, saved);
  setPromptInput(null);
  cleanupTempDirs();
});

const flat = (): string => out.join('').split(/\s+/).join(' ');

function source(tmp: string, version: string): string {
  const data = validManifestData();
  data.extension.version = version;
  return makeExtensionDir(tmp, data, `test-ext-${version}`);
}

function declareConfig(extDir: string, templateText: string): void {
  const manifestPath = join(extDir, 'extension.yml');
  const manifest = parseYaml(readFileSync(manifestPath, 'utf-8')) as AnyDict;
  manifest.provides.config = [{ name: 'test-ext-config.yml', template: 'config-template.yml' }];
  writeFileSync(manifestPath, dumpYaml(manifest, { sortKeys: false }));
  writeFileSync(join(extDir, 'config-template.yml'), templateText);
}

function zipDir(dir: string): string {
  const members: Array<{ name: string; data: Buffer; mode: number }> = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else members.push({ name: relative(dir, p), data: readFileSync(p), mode: 0o644 });
    }
  };
  walk(dir);
  const archive = `${dir}.zip`;
  writeFileSync(archive, buildZip(members));
  return archive;
}

async function updateFromArchive(projectDir: string, sourceDir: string, version: string): Promise<number> {
  const archive = zipDir(sourceDir);
  proto.getExtensionInfo = async () => ({ id: 'test-ext', name: 'Test Extension', version, _install_allowed: true });
  proto.downloadExtension = async () => archive;
  setPromptInput(['y']);
  process.chdir(projectDir);
  try {
    await runUpdateCommand('test-ext');
    return 0;
  } catch (e) {
    return (e as { code?: number }).code ?? -1;
  }
}

describe('extension update scaffolds config templates (#5011)', () => {
  test('a template declared by the new version is scaffolded', async () => {
    const tmp = makeTempDir();
    const proj = makeProjectDir(tmp);
    new ExtensionManager(proj).installFromDirectory(source(tmp, '1.0.0'), '0.1.0');
    const v2 = source(tmp, '2.0.0');
    declareConfig(v2, 'setting: default\n');
    expect(await updateFromArchive(proj, v2, '2.0.0')).toBe(0);
    expect(flat()).toContain('Updated to v2.0.0');
    const config = join(proj, '.specify', 'extensions', 'test-ext', 'test-ext-config.yml');
    expect(readFileSync(config, 'utf-8')).toBe('setting: default\n');
    expect(flat()).toContain('Config scaffolded: .specify/extensions/test-ext/test-ext-config.yml');
  });

  test('an existing config is kept over the new template', async () => {
    const tmp = makeTempDir();
    const proj = makeProjectDir(tmp);
    const v1 = source(tmp, '1.0.0');
    declareConfig(v1, 'setting: default\n');
    const manager = new ExtensionManager(proj);
    manager.installFromDirectory(v1, '0.1.0');
    expect(manager.scaffoldConfig('test-ext')[0]).toEqual(['test-ext-config.yml']);
    const config = join(proj, '.specify', 'extensions', 'test-ext', 'test-ext-config.yml');
    writeFileSync(config, 'setting: customized\n');
    const v2 = source(tmp, '2.0.0');
    declareConfig(v2, 'setting: new-default\n');
    expect(await updateFromArchive(proj, v2, '2.0.0')).toBe(0);
    expect(flat()).toContain('Updated to v2.0.0');
    expect(readFileSync(config, 'utf-8')).toBe('setting: customized\n');
    expect(flat()).not.toContain('Config scaffolded');
  });

  test('a declared template that cannot be scaffolded is reported, not fatal', async () => {
    const tmp = makeTempDir();
    const proj = makeProjectDir(tmp);
    new ExtensionManager(proj).installFromDirectory(source(tmp, '1.0.0'), '0.1.0');
    const v2 = source(tmp, '2.0.0');
    declareConfig(v2, 'setting: default\n');
    // Keep the declaration but drop the template from the package.
    rmSync(join(v2, 'config-template.yml'));
    expect(await updateFromArchive(proj, v2, '2.0.0')).toBe(0);
    expect(flat()).toContain('Updated to v2.0.0');
    expect(flat()).toContain('Config templates not scaffolded: test-ext-config.yml');
    expect(existsSync(join(proj, '.specify', 'extensions', 'test-ext', 'test-ext-config.yml'))).toBe(false);
  });
});

describe('hook commands must be strings (#5146)', () => {
  const commands: Array<[string, unknown]> = [
    ['list', ['speckit.test-ext.hello']],
    ['mapping', { name: 'speckit.test-ext.hello' }],
    ['integer', 123],
    ['boolean', true],
    ['blank', '  '],
  ];
  for (const asList of [false, true]) {
    for (const [id, command] of commands) {
      test(`manifest rejects a ${id} command${asList ? ' in a list' : ''}`, () => {
        const data = validManifestData();
        const entry = { command };
        data.hooks.after_tasks = asList ? [entry] : entry;
        const path = writeManifest(makeTempDir(), data);
        expect(() => new ExtensionManifest(path)).toThrow(ValidationError);
        expect(() => new ExtensionManifest(path)).toThrow("Hook 'after_tasks' missing required 'command' string");
      });
    }
  }

  for (const [id, command] of commands.slice(0, 2)) {
    test(`extension add --dev rejects a ${id} command before writing files`, async () => {
      const tmp = makeTempDir();
      const extDir = makeExtensionDir(tmp);
      const proj = makeProjectDir(tmp);
      const manifestPath = join(extDir, 'extension.yml');
      const data = parseYaml(readFileSync(manifestPath, 'utf-8')) as AnyDict;
      data.hooks.after_tasks.command = command;
      writeFileSync(manifestPath, dumpYaml(data));
      const agentDir = join(proj, '.claude');
      mkdirSync(join(agentDir, 'skills'), { recursive: true });
      const before = readdirSync(agentDir, { recursive: true });
      process.chdir(proj);
      expect(await runExtensionCommand(['add', '--dev', extDir])).toBe(1);
      const text = out.join('');
      expect(text).toContain('after_tasks');
      expect(text).toContain("'command'");
      expect(existsSync(join(proj, '.specify', 'extensions', 'test-ext'))).toBe(false);
      expect(readdirSync(agentDir, { recursive: true })).toEqual(before);
      expect(new ExtensionRegistry(join(proj, '.specify', 'extensions')).get('test-ext')).toBeNull();
    });
  }
});

describe('top-level manifest defaults (#5164)', () => {
  function make(manifestBody: string): ConfigManager {
    const root = makeTempDir();
    const extDir = join(root, '.specify', 'extensions', 'myext');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'extension.yml'), manifestBody);
    return new ConfigManager(root, 'myext');
  }

  test('top-level defaults load', () => {
    expect(make('defaults:\n  feature:\n    enabled: true\n').getConfig()).toEqual({ feature: { enabled: true } });
  });

  test('config.defaults wins on conflict', () => {
    const cm = make(
      'defaults:\n  feature:\n    enabled: true\n    auto_sync: true\n' +
        'config:\n  defaults:\n    feature:\n      auto_sync: false\n',
    );
    expect(cm.getConfig()).toEqual({ feature: { enabled: true, auto_sync: false } });
  });

  test('project config merges over top-level defaults', () => {
    const cm = make('defaults:\n  feature:\n    enabled: true\n    auto_sync: true\n');
    writeFileSync(join(cm.extensionDir, 'myext-config.yml'), 'feature:\n  enabled: false\n');
    expect(cm.getConfig()).toEqual({ feature: { enabled: false, auto_sync: true } });
  });

  test('non-mapping top-level defaults are ignored', () => {
    const cm = make('defaults:\n  - foo\nconfig:\n  defaults:\n    feature:\n      enabled: true\n');
    expect(cm.getConfig()).toEqual({ feature: { enabled: true } });
  });

  for (const section of [
    'config:\n  - foo\n',
    'config: just-a-string\n',
    'config:\n  defaults:\n    - foo\n',
    'config:\n  defaults: just-a-string\n',
  ]) {
    test(`top-level defaults survive a non-mapping config (${JSON.stringify(section)})`, () => {
      expect(make('defaults:\n  feature:\n    enabled: true\n' + section).getConfig()).toEqual({ feature: { enabled: true } });
    });
  }

  test('hook conditions see a top-level default', () => {
    const root = makeTempDir();
    const extDir = join(root, '.specify', 'extensions', 'myext');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'extension.yml'), 'defaults:\n  feature:\n    enabled: true\n');
    expect(new HookExecutor(root).evaluateCondition('config.feature.enabled is set', 'myext')).toBe(true);
  });
});
