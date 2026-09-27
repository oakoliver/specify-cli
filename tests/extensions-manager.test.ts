/**
 * Port of upstream ``TestExtensionManager``, ``TestExtensionIgnore``,
 * ``TestExtensionConfigScaffolding`` and ``TestIntegration`` cases
 * (tests/test_extensions.py, tests/test_extension_skills.py).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  CompatibilityError,
  ExtensionError,
  ExtensionManager,
  ExtensionManifest,
  HookExecutor,
  ValidationError,
} from '../src/extensions/index.js';
import { parseYaml } from '../src/yaml.js';
import {
  type AnyDict,
  cleanupTempDirs,
  makeExtensionDir,
  makeProjectDir,
  makeSimpleExtension,
  makeTempDir,
  simpleManifest,
  validManifestData,
  writeManifest,
} from './extensions-helpers.js';

afterEach(cleanupTempDirs);

function setup(data: AnyDict = validManifestData()): { temp: string; ext: string; proj: string; manager: ExtensionManager } {
  const temp = makeTempDir();
  const ext = makeExtensionDir(temp, data);
  const proj = makeProjectDir(temp);
  return { temp, ext, proj, manager: new ExtensionManager(proj) };
}

function installed(proj: string, id = 'test-ext'): string {
  return join(proj, '.specify', 'extensions', id);
}

function catchErr(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected an error');
}

describe('ExtensionManager.checkCompatibility', () => {
  test('valid', () => {
    const { ext, manager } = setup();
    const manifest = new ExtensionManifest(join(ext, 'extension.yml'));
    expect(manager.checkCompatibility(manifest, '0.1.0')).toBe(true);
  });

  test('invalid', () => {
    const data = validManifestData();
    data.requires.speckit_version = '>=99.0.0';
    const { ext, manager } = setup(data);
    const manifest = new ExtensionManifest(join(ext, 'extension.yml'));
    const err = catchErr(() => manager.checkCompatibility(manifest, '0.1.0'));
    expect(err).toBeInstanceOf(CompatibilityError);
    expect(err.message).toBe(
      'Extension requires spec-kit >=99.0.0, but 0.1.0 is installed.\n' +
        'Upgrade spec-kit with: uv tool install specify-cli --force --from git+https://github.com/github/spec-kit.git',
    );
  });

  test('allows prerelease builds', () => {
    const { ext, manager } = setup();
    const manifest = new ExtensionManifest(join(ext, 'extension.yml'));
    expect(manager.checkCompatibility(manifest, '0.2.0.dev5')).toBe(true);
  });

  test('invalid specifier', () => {
    const data = validManifestData();
    data.requires.speckit_version = 'not a spec';
    const { ext, manager } = setup(data);
    const manifest = new ExtensionManifest(join(ext, 'extension.yml'));
    expect(catchErr(() => manager.checkCompatibility(manifest, '0.1.0')).message).toBe(
      'Invalid version specifier: not a spec',
    );
  });
});

describe('ExtensionManager install/remove', () => {
  test('install from directory', () => {
    const { ext, proj, manager } = setup();
    const manifest = manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    expect(manifest.id).toBe('test-ext');
    expect(manager.registry.isInstalled('test-ext')).toBe(true);
    expect(existsSync(join(installed(proj), 'extension.yml'))).toBe(true);
    const meta = manager.registry.get('test-ext')!;
    expect(meta.source).toBe('local');
    expect(meta.priority).toBe(10);
    expect(meta.enabled).toBe(true);
    expect(meta.registered_commands).toEqual({});
    expect(meta.registered_skills).toEqual([]);
    expect(meta.manifest_hash).toMatch(/^sha256:/);
    // hooks registered in extensions.yml
    const cfg = parseYaml(readFileSync(join(proj, '.specify', 'extensions.yml'), 'utf-8')) as AnyDict;
    expect(cfg.installed).toEqual(['test-ext']);
    expect(cfg.hooks.after_tasks[0]).toEqual({
      extension: 'test-ext',
      command: 'speckit.test-ext.hello',
      enabled: true,
      optional: true,
      priority: 10,
      prompt: 'Run test?',
      description: '',
      condition: null,
    });
  });

  test('catalog source recorded', () => {
    const { ext, manager } = setup();
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false, catalogName: ' default ' });
    expect(manager.registry.get('test-ext')!.source).toEqual({ kind: 'catalog', catalog: 'default' });
  });

  test('install restores execute bit on shipped scripts', () => {
    if (process.platform === 'win32') return;
    const { ext, proj, manager } = setup();
    mkdirSync(join(ext, 'scripts'), { recursive: true });
    writeFileSync(join(ext, 'scripts', 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(ext, 'scripts', 'run.sh'), 0o644);
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    expect(statSync(join(installed(proj), 'scripts', 'run.sh')).mode & 0o111).not.toBe(0);
  });

  test('duplicate install error mentions --force', () => {
    const { ext, manager } = setup();
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    const err = catchErr(() => manager.installFromDirectory(ext, '0.1.0', { registerCommands: false }));
    expect(err).toBeInstanceOf(ExtensionError);
    expect(err.message).toBe(
      "Extension 'test-ext' is already installed. Use 'specify extension remove test-ext' first, or retry with --force to overwrite.",
    );
  });

  test('force reinstall preserves config', () => {
    const { ext, proj, manager } = setup();
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    writeFileSync(join(installed(proj), 'test-ext-config.yml'), 'test: config');
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false, force: true });
    expect(readFileSync(join(installed(proj), 'test-ext-config.yml'), 'utf-8')).toBe('test: config');
    expect(existsSync(join(proj, '.specify', 'extensions', '.backup', 'test-ext'))).toBe(false);
  });

  test('force install without existing is fine', () => {
    const { ext, manager } = setup();
    expect(manager.installFromDirectory(ext, '0.1.0', { registerCommands: false, force: true }).id).toBe('test-ext');
  });

  test('reinstall after keep-config preserves config (and local config)', () => {
    const { ext, proj, manager } = setup();
    writeFileSync(join(ext, 'test-ext-config.yml'), 'model: default-model\nmax_iterations: 1\n');
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    const configFile = join(installed(proj), 'test-ext-config.yml');
    writeFileSync(configFile, 'model: custom-model\nmax_iterations: 99\n');
    writeFileSync(join(installed(proj), 'test-ext-config.local.yml'), 'secret: 1\n');
    manager.remove('test-ext', true);
    expect(manager.registry.isInstalled('test-ext')).toBe(false);
    expect(existsSync(join(installed(proj), '.keep-config'))).toBe(true);
    expect(readFileSync(configFile, 'utf-8')).toContain('custom-model');
    expect(existsSync(join(installed(proj), 'extension.yml'))).toBe(false);

    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    expect(readFileSync(configFile, 'utf-8')).toContain('custom-model');
    expect(readFileSync(join(installed(proj), 'test-ext-config.local.yml'), 'utf-8')).toBe('secret: 1\n');
    expect(existsSync(join(installed(proj), '.keep-config'))).toBe(false);
    // staging dir cleaned up after commit
    const leftovers = readdirSync(join(proj, '.specify', 'extensions')).filter((n) => n.startsWith('.rescue-staging-'));
    expect(leftovers).toEqual([]);
  });

  test('reinstall after legacy keep-config (no marker) preserves config', () => {
    const { ext, proj, manager } = setup();
    writeFileSync(join(ext, 'test-ext-config.yml'), 'v: default\n');
    const dest = installed(proj);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'test-ext-config.yml'), 'v: custom\n');
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    expect(readFileSync(join(dest, 'test-ext-config.yml'), 'utf-8')).toBe('v: custom\n');
  });

  test('failed install without keep-config does not rescue defaults', () => {
    const { ext, proj, manager } = setup();
    writeFileSync(join(ext, 'test-ext-config.yml'), 'v: new-default\n');
    const dest = installed(proj);
    mkdirSync(dest, { recursive: true });
    // Leftover of a partial install: payload present, no marker.
    writeFileSync(join(dest, 'extension.yml'), 'partial');
    writeFileSync(join(dest, 'test-ext-config.yml'), 'v: stale\n');
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    expect(readFileSync(join(dest, 'test-ext-config.yml'), 'utf-8')).toBe('v: new-default\n');
  });

  test('reinstall with symlinked kept config is rejected', () => {
    if (process.platform === 'win32') return;
    const { temp, ext, proj, manager } = setup();
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    const target = join(temp, 'outside.yml');
    writeFileSync(target, 'x: 1');
    symlinkSync(target, join(installed(proj), 'test-ext-config.yml'));
    manager.remove('test-ext', true);
    const err = catchErr(() => manager.installFromDirectory(ext, '0.1.0', { registerCommands: false }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("Preserved extension config for 'test-ext' is a symlink (test-ext-config.yml)");
  });

  test('rescue staging dir is fixed length for long ids', () => {
    const { manager } = setup();
    const staging = manager.rescueStagingDir('x'.repeat(400));
    expect(staging.split('/').pop()).toMatch(/^\.rescue-staging-[0-9a-f]{16}$/);
  });

  test('install from its own destination is rejected without data loss', () => {
    const { ext, proj, manager } = setup();
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    const err = catchErr(() =>
      manager.installFromDirectory(installed(proj), '0.1.0', { registerCommands: false, force: true }),
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("Source path is the install destination for 'test-ext'");
    expect(existsSync(join(installed(proj), 'extension.yml'))).toBe(true);
  });

  test('invalid priority rejected', () => {
    const { ext, manager } = setup();
    expect(catchErr(() => manager.installFromDirectory(ext, '0.1.0', { priority: 0 })).message).toBe(
      'Priority must be a positive integer (1 or higher)',
    );
  });

  test('install with custom priority', () => {
    const { ext, manager } = setup();
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false, priority: 5 });
    expect(manager.registry.get('test-ext')!.priority).toBe(5);
    expect(manager.listInstalled()[0].priority).toBe(5);
  });

  test('remove extension backs up config', () => {
    const { ext, proj, manager } = setup();
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    writeFileSync(join(installed(proj), 'test-ext-config.yml'), 'a: 1');
    expect(manager.remove('test-ext')).toBe(true);
    expect(existsSync(installed(proj))).toBe(false);
    expect(readFileSync(join(proj, '.specify', 'extensions', '.backup', 'test-ext', 'test-ext-config.yml'), 'utf-8')).toBe(
      'a: 1',
    );
    const cfg = parseYaml(readFileSync(join(proj, '.specify', 'extensions.yml'), 'utf-8')) as AnyDict;
    expect(cfg.installed).toEqual([]);
    expect(cfg.hooks).toEqual({});
  });

  test('remove nonexistent returns false', () => {
    const { manager } = setup();
    expect(manager.remove('nope')).toBe(false);
  });

  test('list installed + corrupted extension fallback', () => {
    const { ext, proj, manager } = setup();
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    const list = manager.listInstalled();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'test-ext',
      name: 'Test Extension',
      version: '1.0.0',
      enabled: true,
      priority: 10,
      command_count: 1,
      hook_count: 1,
      _json_author: 'Test Author',
      _json_source: 'local',
      _json_provides: { commands: 1, templates: 0, scripts: 0, hooks: 1 },
    });
    writeFileSync(join(installed(proj), 'extension.yml'), 'provides: nope\n');
    const corrupted = new ExtensionManager(proj).listInstalled()[0];
    expect(corrupted.description).toBe('⚠️ Corrupted extension');
    expect(corrupted.enabled).toBe(false);
    expect(corrupted.name).toBe('test-ext');
  });
});

describe('ExtensionManager install-time conflicts', () => {
  test('rejects extension id in core namespace', () => {
    const temp = makeTempDir();
    const src = makeSimpleExtension(temp, 'plan');
    const manager = new ExtensionManager(makeProjectDir(temp));
    expect(catchErr(() => manager.installFromDirectory(src, '0.1.0', { registerCommands: false })).message).toBe(
      "Extension ID 'plan' conflicts with core command namespace 'plan'",
    );
  });

  test('accepts free-form alias', () => {
    const temp = makeTempDir();
    const src = makeSimpleExtension(temp, 'probe', { cmd: { aliases: ['speckit.verify'] } });
    const manager = new ExtensionManager(makeProjectDir(temp));
    expect(manager.installFromDirectory(src, '0.1.0', { registerCommands: false }).id).toBe('probe');
  });

  test('rejects namespace squatting', () => {
    const temp = makeTempDir();
    const dir = join(temp, 'squat');
    const data = simpleManifest('squat');
    data.provides.commands[0].name = 'speckit.other.cmd';
    writeManifest(dir, data);
    const manager = new ExtensionManager(makeProjectDir(temp));
    expect(catchErr(() => manager.installFromDirectory(dir, '0.1.0', { registerCommands: false })).message).toBe(
      "Command 'speckit.other.cmd' must use extension namespace 'squat'",
    );
  });

  test('rejects collision with installed extension', () => {
    const temp = makeTempDir();
    const proj = makeProjectDir(temp);
    const manager = new ExtensionManager(proj);
    manager.installFromDirectory(makeSimpleExtension(temp, 'one', { cmd: { aliases: ['shared-alias'] } }), '0.1.0', {
      registerCommands: false,
    });
    const err = catchErr(() =>
      manager.installFromDirectory(makeSimpleExtension(temp, 'two', { cmd: { aliases: ['shared-alias'] } }), '0.1.0', {
        registerCommands: false,
      }),
    );
    expect(err.message).toBe(
      "Extension commands conflict with core or installed extension commands:\n- shared-alias (already provided by extension 'one')",
    );
  });

  for (const alias of ['speckit.taskstoissues', 'taskstoissues', 'speckit-taskstoissues']) {
    test(`rejects alias shadowing core command: ${alias}`, () => {
      const temp = makeTempDir();
      const src = makeSimpleExtension(temp, 'probe', { cmd: { aliases: [alias] } });
      const manager = new ExtensionManager(makeProjectDir(temp));
      const err = catchErr(() => manager.installFromDirectory(src, '0.1.0', { registerCommands: false }));
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toContain(`${alias} (conflicts with core command)`);
    });
  }

  test('duplicate command/alias in manifest rejected', () => {
    const temp = makeTempDir();
    const src = makeSimpleExtension(temp, 'dup', { cmd: { aliases: ['speckit.dup.cmd'] } });
    const manager = new ExtensionManager(makeProjectDir(temp));
    expect(catchErr(() => manager.installFromDirectory(src, '0.1.0', { registerCommands: false })).message).toBe(
      "Duplicate command or alias 'speckit.dup.cmd' in extension manifest",
    );
  });
});

describe('.extensionignore', () => {
  function makeIgnored(files: Record<string, string>, ignore: string | Buffer | null): { proj: string; manager: ExtensionManager; ext: string } {
    const { ext, proj, manager } = setup();
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(ext, rel, '..'), { recursive: true });
      writeFileSync(join(ext, rel), content);
    }
    if (ignore !== null) writeFileSync(join(ext, '.extensionignore'), ignore);
    return { proj, manager, ext };
  }

  test('no .extensionignore copies everything', () => {
    const { proj, manager, ext } = makeIgnored({ 'tests/test_a.py': 'x', 'README.md': 'r' }, null);
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    expect(existsSync(join(installed(proj), 'tests', 'test_a.py'))).toBe(true);
  });

  test('excludes files/dirs, globs, comments; ignore file itself excluded', () => {
    const { proj, manager, ext } = makeIgnored(
      { 'tests/test_a.py': 'x', 'notes.log': 'l', 'keep.md': 'k', 'docs/a/b.log': 'n' },
      '# comment\n\ntests/\n*.log\n',
    );
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    const dest = installed(proj);
    expect(existsSync(join(dest, 'tests'))).toBe(false);
    expect(existsSync(join(dest, 'notes.log'))).toBe(false);
    expect(existsSync(join(dest, 'docs', 'a', 'b.log'))).toBe(false);
    expect(existsSync(join(dest, 'keep.md'))).toBe(true);
    expect(existsSync(join(dest, '.extensionignore'))).toBe(false);
  });

  test('star does not cross directories; doublestar does', () => {
    const { proj, manager, ext } = makeIgnored(
      { 'docs/a.md': '1', 'docs/sub/b.md': '2', 'assets/x/y/z.png': '3', 'assets/top.png': '4' },
      'docs/*.md\nassets/**/*.png\n',
    );
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    const dest = installed(proj);
    expect(existsSync(join(dest, 'docs', 'a.md'))).toBe(false);
    expect(existsSync(join(dest, 'docs', 'sub', 'b.md'))).toBe(true);
    expect(existsSync(join(dest, 'assets', 'x', 'y', 'z.png'))).toBe(false);
    expect(existsSync(join(dest, 'assets', 'top.png'))).toBe(false);
  });

  test('negation re-includes a file', () => {
    const { proj, manager, ext } = makeIgnored(
      { 'docs/guide.md': '# Guide', 'docs/internal.md': 'internal', 'docs/api.md': 'api' },
      'docs/*.md\n!docs/api.md\n',
    );
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    const dest = installed(proj);
    expect(existsSync(join(dest, 'docs', 'guide.md'))).toBe(false);
    expect(existsSync(join(dest, 'docs', 'internal.md'))).toBe(false);
    expect(existsSync(join(dest, 'docs', 'api.md'))).toBe(true);
  });

  test('windows backslash patterns normalized', () => {
    const { proj, manager, ext } = makeIgnored({ 'docs/internal/x.md': 'x', 'docs/pub.md': 'p' }, 'docs\\internal\\\n');
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    expect(existsSync(join(installed(proj), 'docs', 'internal'))).toBe(false);
    expect(existsSync(join(installed(proj), 'docs', 'pub.md'))).toBe(true);
  });

  test('invalid UTF-8 raises ValidationError', () => {
    const { manager, ext } = makeIgnored({}, Buffer.from([0x2a, 0x0a, 0xc3, 0x28]));
    const err = catchErr(() => manager.installFromDirectory(ext, '0.1.0', { registerCommands: false }));
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe(
      `.extensionignore is not valid UTF-8: ${join(ext, '.extensionignore')} (invalid continuation byte at byte 2)`,
    );
  });
});

describe('ExtensionManager.scaffoldConfig', () => {
  function withConfig(config: unknown, files: Record<string, string> = {}): { proj: string; manager: ExtensionManager } {
    const data = validManifestData();
    data.provides.config = config;
    const { ext, proj, manager } = setup(data);
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(ext, rel), content);
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    return { proj, manager };
  }

  test('deploys template beside the extension', () => {
    const { proj, manager } = withConfig(
      [{ name: 'test-ext-config.yml', template: 'config-template.yml' }],
      { 'config-template.yml': 'key: value\n' },
    );
    expect(manager.scaffoldConfig('test-ext')).toEqual([['test-ext-config.yml'], [], []]);
    expect(readFileSync(join(installed(proj), 'test-ext-config.yml'), 'utf-8')).toBe('key: value\n');
    // second call preserves existing
    expect(manager.scaffoldConfig('test-ext')).toEqual([[], ['test-ext-config.yml'], []]);
  });

  test('no config section', () => {
    const { manager } = withConfig(undefined);
    expect(manager.scaffoldConfig('test-ext')).toEqual([[], [], []]);
  });

  test('missing template file / traversal / non-preserved target fail', () => {
    const { manager } = withConfig([
      { name: 'a-config.yml', template: 'missing.yml' },
      { name: 'b-config.yml', template: '../../../etc/passwd' },
      { name: 'nested/c-config.yml', template: 'tpl.yml' },
      { name: 'settings.yml', template: 'tpl.yml' },
    ], { 'tpl.yml': 'x: 1' });
    expect(manager.scaffoldConfig('test-ext')).toEqual([
      [],
      [],
      ['a-config.yml', 'b-config.yml', 'nested/c-config.yml', 'settings.yml'],
    ]);
  });

  test('malformed config section', () => {
    const { manager } = withConfig('oops');
    expect(manager.scaffoldConfig('test-ext')).toEqual([[], [], ['provides.config']]);
  });

  test('missing manifest returns consistent result', () => {
    const { manager } = setup();
    expect(manager.scaffoldConfig('nope')).toEqual([[], [], []]);
  });

  test('accepts local override name', () => {
    const { manager } = withConfig([{ name: 'test-ext-config.local.yml', template: 'tpl.yml' }], { 'tpl.yml': 'x: 1' });
    expect(manager.scaffoldConfig('test-ext')[0]).toEqual(['test-ext-config.local.yml']);
  });
});

describe('ExtensionManager skills registration', () => {
  function skillsProject(ai: string, aiSkills = true): { temp: string; proj: string; ext: string; manager: ExtensionManager } {
    const temp = makeTempDir();
    const data = validManifestData();
    const ext = makeExtensionDir(temp, data);
    const proj = makeProjectDir(temp);
    writeFileSync(
      join(proj, '.specify', 'init-options.json'),
      JSON.stringify({ ai, ai_skills: aiSkills, script: 'sh' }),
    );
    return { temp, proj, ext, manager: new ExtensionManager(proj) };
  }

  test('skills are generated with extension author and ownership marker', () => {
    const { proj, ext, manager } = skillsProject('claude');
    mkdirSync(join(proj, '.claude', 'skills'), { recursive: true });
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    const meta = manager.registry.get('test-ext')!;
    expect(meta.registered_skills).toEqual(['speckit-test-ext-hello']);
    const skill = readFileSync(join(proj, '.claude', 'skills', 'speckit-test-ext-hello', 'SKILL.md'), 'utf-8');
    expect(skill).toContain('name: speckit-test-ext-hello');
    expect(skill).toContain('source: extension:test-ext');
    expect(skill).toContain('author: Test Author');
    expect(skill).toContain('# Test Ext Hello Skill');

    manager.remove('test-ext');
    expect(existsSync(join(proj, '.claude', 'skills', 'speckit-test-ext-hello'))).toBe(false);
  });

  test('user-owned skill directories are never overwritten or removed', () => {
    const { proj, ext, manager } = skillsProject('claude');
    const userDir = join(proj, '.claude', 'skills', 'speckit-test-ext-hello');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'SKILL.md'), '---\nname: mine\n---\n\nuser content\n');
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    expect(manager.registry.get('test-ext')!.registered_skills).toEqual([]);
    manager.remove('test-ext');
    expect(readFileSync(join(userDir, 'SKILL.md'), 'utf-8')).toContain('user content');
  });

  test('no skills when ai_skills disabled', () => {
    const { ext, manager } = skillsProject('claude', false);
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    expect(manager.registry.get('test-ext')!.registered_skills).toEqual([]);
  });
});

describe('ExtensionManager full workflow', () => {
  test('install and remove workflow with hooks toggling', () => {
    const { ext, proj, manager } = setup();
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    const hooks = new HookExecutor(proj);
    hooks.disableHooks('test-ext');
    expect(hooks.getHooksForEvent('after_tasks')).toEqual([]);
    hooks.enableHooks('test-ext');
    expect(hooks.getHooksForEvent('after_tasks')).toHaveLength(1);
    manager.remove('test-ext');
    expect(manager.listInstalled()).toEqual([]);
  });

  test('multiple extensions', () => {
    const temp = makeTempDir();
    const proj = makeProjectDir(temp);
    const manager = new ExtensionManager(proj);
    manager.installFromDirectory(makeSimpleExtension(temp, 'ext-a'), '0.1.0', { registerCommands: false });
    manager.installFromDirectory(makeSimpleExtension(temp, 'ext-b'), '0.1.0', { registerCommands: false, priority: 1 });
    expect(manager.listInstalled().map((e) => e.id).sort()).toEqual(['ext-a', 'ext-b']);
    expect(manager.registry.listByPriority().map(([id]) => id)).toEqual(['ext-b', 'ext-a']);
  });
});

describe('ExtensionManager command registration (active agent only, #2948)', () => {
  function proj(initOptions: AnyDict | null): { temp: string; proj: string; ext: string; manager: ExtensionManager } {
    const temp = makeTempDir();
    const data = validManifestData();
    const ext = makeExtensionDir(temp, data);
    writeFileSync(
      join(ext, 'commands', 'hello.md'),
      '---\ndescription: "Test hello command"\nscripts:\n  sh: scripts/bash/run.sh\n---\n\n# Hello\n\n$ARGUMENTS\n',
    );
    const p = makeProjectDir(temp);
    if (initOptions) writeFileSync(join(p, '.specify', 'init-options.json'), JSON.stringify(initOptions));
    return { temp, proj: p, ext, manager: new ExtensionManager(p) };
  }

  test('registers for the active command-mode agent only and strips scripts', () => {
    const { proj: p, ext, manager } = proj({ ai: 'gemini', ai_skills: false });
    mkdirSync(join(p, '.gemini', 'commands'), { recursive: true });
    mkdirSync(join(p, '.clinerules', 'workflows'), { recursive: true });
    manager.installFromDirectory(ext, '0.1.0');
    const meta = manager.registry.get('test-ext')!;
    expect(meta.registered_commands).toEqual({ gemini: ['speckit.test-ext.hello'] });
    const rendered = readFileSync(join(p, '.gemini', 'commands', 'speckit.test-ext.hello.toml'), 'utf-8');
    expect(rendered).toContain('# Source: test-ext');
    expect(rendered).not.toContain('scripts:');
    expect(readdirSync(join(p, '.clinerules', 'workflows'))).toEqual([]);

    manager.remove('test-ext');
    expect(existsSync(join(p, '.gemini', 'commands', 'speckit.test-ext.hello.toml'))).toBe(false);
  });

  test('corrupted init-options fails closed (no registration)', () => {
    const { proj: p, ext, manager } = proj(null);
    writeFileSync(join(p, '.specify', 'init-options.json'), '{not json');
    mkdirSync(join(p, '.gemini', 'commands'), { recursive: true });
    manager.installFromDirectory(ext, '0.1.0');
    expect(manager.registry.get('test-ext')!.registered_commands).toEqual({});
  });

  test('missing init-options falls back to detection across agents', () => {
    const { proj: p, ext, manager } = proj(null);
    mkdirSync(join(p, '.gemini', 'commands'), { recursive: true });
    manager.installFromDirectory(ext, '0.1.0');
    expect(Object.keys(manager.registry.get('test-ext')!.registered_commands)).toContain('gemini');
  });

  test('registerEnabledExtensionsForAgent skips disabled and isolates failures', () => {
    const { temp, proj: p, ext, manager } = proj({ ai: 'gemini', ai_skills: false });
    manager.installFromDirectory(ext, '0.1.0', { registerCommands: false });
    manager.installFromDirectory(makeSimpleExtension(temp, 'other'), '0.1.0', { registerCommands: false });
    manager.registry.update('other', { enabled: false });
    mkdirSync(join(p, '.gemini', 'commands'), { recursive: true });
    manager.registerEnabledExtensionsForAgent('gemini');
    expect(manager.registry.get('test-ext')!.registered_commands).toEqual({ gemini: ['speckit.test-ext.hello'] });
    expect(manager.registry.get('other')!.registered_commands).toEqual({});
    manager.unregisterAgentArtifacts('gemini');
    expect(manager.registry.get('test-ext')!.registered_commands).toEqual({});
    expect(existsSync(join(p, '.gemini', 'commands', 'speckit.test-ext.hello.toml'))).toBe(false);
  });
});
