/**
 * Tests for src/presets/resolver.ts (port of upstream
 * tests/specify_cli/presets/test_resolver.py, key cases).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { dumpYaml } from '../src/yaml.js';
import { PresetManager } from '../src/presets/manager.js';
import { PresetValidationError } from '../src/presets/manifest.js';
import { PresetResolver } from '../src/presets/resolver.js';

let tempDir: string;
let projectDir: string;

function write(p: string, content: string | Buffer): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'presets-resolver-'));
  projectDir = join(tempDir, 'project');
  write(join(projectDir, '.specify', 'templates', 'spec-template.md'), '# Core Spec Template\n');
  write(join(projectDir, '.specify', 'templates', 'plan-template.md'), '# Core Plan Template\n');
  mkdirSync(join(projectDir, '.specify', 'templates', 'commands'), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

interface PackOpts {
  id: string;
  templates: Array<Record<string, unknown>>;
  files: Record<string, string>;
}

function makePack(opts: PackOpts): string {
  const dir = join(tempDir, opts.id);
  write(
    join(dir, 'preset.yml'),
    dumpYaml({
      schema_version: '1.0',
      preset: { id: opts.id, name: opts.id, version: '1.0.0', description: 'Test preset' },
      requires: { speckit_version: '>=0.1.0' },
      provides: { templates: opts.templates },
    }),
  );
  for (const [rel, content] of Object.entries(opts.files)) write(join(dir, rel), content);
  return dir;
}

function specPack(id: string, content: string, extra: Record<string, unknown> = {}): string {
  return makePack({
    id,
    templates: [{ type: 'template', name: 'spec-template', file: 'templates/spec-template.md', ...extra }],
    files: { 'templates/spec-template.md': content },
  });
}

function install(dir: string, priority = 10): void {
  new PresetManager(projectDir).installFromDirectory(dir, '0.1.5', priority);
}

function writeExtension(
  extId: string,
  opts: { registry?: Record<string, unknown> | null; manifest?: Record<string, unknown>; files?: Record<string, string> } = {},
): string {
  const extDir = join(projectDir, '.specify', 'extensions', extId);
  mkdirSync(extDir, { recursive: true });
  if (opts.manifest) write(join(extDir, 'extension.yml'), dumpYaml(opts.manifest));
  for (const [rel, content] of Object.entries(opts.files ?? {})) write(join(extDir, rel), content);
  if (opts.registry !== undefined && opts.registry !== null) {
    const regPath = join(projectDir, '.specify', 'extensions', '.registry');
    let data: Record<string, any> = { schema_version: '1.0', extensions: {} };
    try {
      data = JSON.parse(readFileSync(regPath, 'utf-8'));
    } catch {
      // fresh
    }
    data.extensions[extId] = opts.registry;
    writeFileSync(regPath, JSON.stringify(data, null, 2));
  }
  return extDir;
}

function extManifest(extId: string, provides: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: '1.0',
    extension: { id: extId, name: extId, version: '1.0.0', description: 'Test extension' },
    requires: { speckit_version: '>=0.1.0' },
    provides,
  };
}

// ============================================================================

describe('PresetResolver priority stack', () => {
  test('resolves core template', () => {
    const result = new PresetResolver(projectDir).resolve('spec-template');
    expect(result).not.toBeNull();
    expect(basename(result!)).toBe('spec-template.md');
    expect(readFileSync(result!, 'utf-8')).toContain('Core Spec Template');
  });

  test('nonexistent returns null', () => {
    expect(new PresetResolver(projectDir).resolve('nonexistent-template')).toBeNull();
  });

  test('ignores traversing registry ids', () => {
    for (const [registryDir, key, outsideName] of [
      ['presets', 'presets', 'outside-preset'],
      ['extensions', 'extensions', 'outside-extension'],
    ]) {
      const outside = join(tempDir, outsideName);
      write(join(outside, 'templates', 'spec-template.md'), `# Sensitive ${key}\n`);
      write(
        join(projectDir, '.specify', registryDir, '.registry'),
        JSON.stringify({ [key]: { [`../../../${outsideName}`]: { enabled: true, priority: 1 } } }),
      );
    }
    const content = new PresetResolver(projectDir).resolveContent('spec-template');
    expect(content).toContain('Core Spec Template');
    expect(content).not.toContain('Sensitive');
  });

  test('higher priority pack wins', () => {
    install(specPack('pack-a', '# From Pack A\n'), 10);
    install(specPack('pack-b', '# From Pack B\n'), 1);
    const result = new PresetResolver(projectDir).resolve('spec-template');
    expect(readFileSync(result!, 'utf-8')).toContain('From Pack B');
  });

  test('project override wins over pack and core', () => {
    install(specPack('pack-a', '# From Pack A\n'));
    write(join(projectDir, '.specify', 'templates', 'overrides', 'spec-template.md'), '# Override\n');
    const result = new PresetResolver(projectDir).resolve('spec-template');
    expect(readFileSync(result!, 'utf-8')).toContain('Override');
  });

  test('pack wins over core', () => {
    install(specPack('pack-a', '# Custom Spec Template\n'));
    const result = new PresetResolver(projectDir).resolve('spec-template');
    expect(readFileSync(result!, 'utf-8')).toContain('Custom Spec Template');
  });

  test('uses manifest-declared file path', () => {
    const dir = makePack({
      id: 'custom-path',
      templates: [{ type: 'template', name: 'spec-template', file: 'custom/location/my-spec.md' }],
      files: { 'custom/location/my-spec.md': '# Declared\n' },
    });
    install(dir);
    const result = new PresetResolver(projectDir).resolve('spec-template');
    expect(readFileSync(result!, 'utf-8')).toContain('Declared');
    expect(new PresetResolver(projectDir).resolveWithSource('spec-template')!.source).toBe('custom-path v1.0.0');
  });

  test('manifest file wins over undeclared convention file', () => {
    const dir = makePack({
      id: 'both',
      templates: [{ type: 'template', name: 'spec-template', file: 'custom/spec.md' }],
      files: { 'custom/spec.md': '# Declared\n', 'templates/spec-template.md': '# Convention\n' },
    });
    install(dir);
    expect(readFileSync(new PresetResolver(projectDir).resolve('spec-template')!, 'utf-8')).toContain('Declared');
  });

  test('skips convention when manifest file missing or a directory', () => {
    const dir = makePack({
      id: 'missing-decl',
      templates: [{ type: 'template', name: 'spec-template', file: 'custom/missing.md' }],
      files: { 'templates/spec-template.md': '# Convention\n' },
    });
    install(dir);
    const resolver = new PresetResolver(projectDir);
    expect(readFileSync(resolver.resolve('spec-template')!, 'utf-8')).toContain('Core Spec Template');
    const layers = resolver.collectAllLayers('spec-template');
    expect(layers.map((l) => l.source)).toEqual(['core']);

    mkdirSync(join(projectDir, '.specify', 'presets', 'missing-decl', 'custom', 'missing.md'), { recursive: true });
    expect(readFileSync(new PresetResolver(projectDir).resolve('spec-template')!, 'utf-8')).toContain(
      'Core Spec Template',
    );
  });

  test('extension-provided templates, disabled skipped, unregistered picked up', () => {
    writeExtension('my-ext', { files: { 'templates/custom-template.md': '# Extension Custom\n' } });
    const resolver = new PresetResolver(projectDir);
    expect(readFileSync(resolver.resolve('custom-template')!, 'utf-8')).toContain('Extension Custom');
    expect(resolver.resolveWithSource('custom-template')!.source).toBe('extension:my-ext (unregistered)');

    writeExtension('my-ext', { registry: { version: '1.0.0', enabled: false, priority: 10 } });
    expect(new PresetResolver(projectDir).resolve('custom-template')).toBeNull();
  });

  test('fails closed on corrupt extension registry', () => {
    writeExtension('my-ext', { files: { 'templates/custom-template.md': '# Extension\n' } });
    writeFileSync(join(projectDir, '.specify', 'extensions', '.registry'), '{not json');
    expect(() => new PresetResolver(projectDir).resolve('custom-template')).toThrow(PresetValidationError);
    expect(() => new PresetResolver(projectDir).resolve('custom-template')).toThrow(
      /refusing to enumerate extensions/,
    );
  });

  test('fails closed when registry is a directory', () => {
    writeExtension('my-ext', { files: { 'templates/custom-template.md': '# Extension\n' } });
    mkdirSync(join(projectDir, '.specify', 'extensions', '.registry'));
    expect(() => new PresetResolver(projectDir).resolve('custom-template')).toThrow(PresetValidationError);
  });

  test('pack over extension', () => {
    writeExtension('my-ext', {
      registry: { version: '1.0.0', enabled: true, priority: 10 },
      files: { 'templates/spec-template.md': '# From Extension\n' },
    });
    install(specPack('pack-a', '# From Pack\n'));
    expect(readFileSync(new PresetResolver(projectDir).resolve('spec-template')!, 'utf-8')).toContain('From Pack');
  });

  test('resolve_with_source attribution', () => {
    const r = new PresetResolver(projectDir);
    expect(r.resolveWithSource('spec-template')!.source).toBe('core');
    expect(r.resolveWithSource('nonexistent')).toBeNull();
    write(join(projectDir, '.specify', 'templates', 'overrides', 'spec-template.md'), '# O\n');
    expect(new PresetResolver(projectDir).resolveWithSource('spec-template')!.source).toBe('project override');
    rmSync(join(projectDir, '.specify', 'templates', 'overrides'), { recursive: true });
    install(specPack('test-pack', '# P\n'));
    expect(new PresetResolver(projectDir).resolveWithSource('spec-template')!.source).toBe('test-pack v1.0.0');
    writeExtension('my-ext', {
      registry: { version: '2.0.0', enabled: true, priority: 10 },
      files: { 'templates/ext-template.md': '# E\n' },
    });
    expect(new PresetResolver(projectDir).resolveWithSource('ext-template')!.source).toBe('extension:my-ext v2.0.0');
  });

  test('skips hidden extension dirs', () => {
    write(join(projectDir, '.specify', 'extensions', '.cache', 'templates', 'hidden.md'), '# hidden\n');
    expect(new PresetResolver(projectDir).resolve('hidden')).toBeNull();
  });

  test('command falls back to bundled core', () => {
    const r = new PresetResolver(projectDir);
    const result = r.resolve('speckit.specify', 'command');
    expect(result).not.toBeNull();
    expect(result!).toContain(join('core_pack', 'commands', 'specify.md'));
    const layers = r.collectAllLayers('speckit.specify', 'command');
    expect(layers.length).toBe(1);
    expect(layers[0].source).toBe('core (bundled)');
  });
});

describe('resolveCore / extension manifests', () => {
  test('resolve_core does not return preset files', () => {
    install(specPack('pack-a', '# Pack\n'));
    const r = new PresetResolver(projectDir);
    expect(readFileSync(r.resolveCore('spec-template')!, 'utf-8')).toContain('Core Spec Template');
    expect(new PresetResolver(join(tempDir, 'empty')).resolveCore('nothing-here')).toBeNull();
  });

  test('extension command resolves via manifest when filename differs', () => {
    writeExtension('selftest', {
      registry: { version: '1.0.0', enabled: true, priority: 10 },
      manifest: extManifest('selftest', {
        commands: [{ name: 'speckit.selftest.extension', file: 'commands/selftest.md', description: 'd' }],
      }),
      files: { 'commands/selftest.md': '# Selftest command\n' },
    });
    const r = new PresetResolver(projectDir);
    const viaManifest = r.resolveExtensionCommandViaManifest('speckit.selftest.extension');
    expect(viaManifest).not.toBeNull();
    expect(readFileSync(viaManifest!, 'utf-8')).toContain('Selftest command');
    const resolved = r.resolve('speckit.selftest.extension', 'command');
    expect(readFileSync(resolved!, 'utf-8')).toContain('Selftest command');
  });

  test('extension manifest declared but missing file does not fall back to convention', () => {
    writeExtension('ext-a', {
      registry: { version: '1.0.0', enabled: true, priority: 10 },
      manifest: extManifest('ext-a', {
        commands: [{ name: 'speckit.ext-a.run', file: 'commands/missing.md', description: 'd' }],
      }),
      files: { 'commands/speckit.ext-a.run.md': '# stale convention\n' },
    });
    const r = new PresetResolver(projectDir);
    expect(r.resolve('speckit.ext-a.run', 'command')).toBeNull();
  });

  test('extension priority: lower number wins, ties alphabetical', () => {
    writeExtension('ext-b', {
      registry: { version: '1.0.0', enabled: true, priority: 5 },
      files: { 'templates/shared.md': '# B\n' },
    });
    writeExtension('ext-a', {
      registry: { version: '1.0.0', enabled: true, priority: 5 },
      files: { 'templates/shared.md': '# A\n' },
    });
    writeExtension('ext-c', { files: { 'templates/shared.md': '# C unregistered\n' } });
    const rows = new PresetResolver(projectDir).getAllExtensionsByPriority();
    expect(rows.map((r) => r[1])).toEqual(['ext-a', 'ext-b', 'ext-c']);
    expect(readFileSync(new PresetResolver(projectDir).resolve('shared')!, 'utf-8')).toContain('# A');
  });
});

describe('resolveContent composition', () => {
  test('core template content / nonexistent', () => {
    const r = new PresetResolver(projectDir);
    expect(r.resolveContent('spec-template')).toContain('Core Spec Template');
    expect(r.resolveContent('nonexistent')).toBeNull();
  });

  test('replace / append / prepend / wrap', () => {
    install(specPack('app', 'appended', { strategy: 'append' }));
    let content = new PresetResolver(projectDir).resolveContent('spec-template')!;
    expect(content).toBe('# Core Spec Template\n\n\nappended');

    new PresetManager(projectDir).remove('app');
    install(specPack('pre', '## Prepended Header\n', { strategy: 'prepend' }));
    content = new PresetResolver(projectDir).resolveContent('spec-template')!;
    expect(content.indexOf('Prepended Header')).toBeLessThan(content.indexOf('Core Spec Template'));

    new PresetManager(projectDir).remove('pre');
    install(specPack('wrap', '# Wrapper Start\n\n{CORE_TEMPLATE}\n\n# Wrapper End\n', { strategy: 'wrap' }));
    content = new PresetResolver(projectDir).resolveContent('spec-template')!;
    expect(content.indexOf('Wrapper Start')).toBeLessThan(content.indexOf('Core Spec Template'));
    expect(content.indexOf('Core Spec Template')).toBeLessThan(content.indexOf('Wrapper End'));
  });

  test('wrap strategy for scripts uses $CORE_SCRIPT', () => {
    write(join(projectDir, '.specify', 'templates', 'scripts', 'test-script.sh'), "echo 'core script'\n");
    install(
      makePack({
        id: 'script-wrap',
        templates: [{ type: 'script', name: 'test-script', file: 'scripts/test-script.sh', strategy: 'wrap' }],
        files: { 'scripts/test-script.sh': '#!/bin/bash\necho before\n$CORE_SCRIPT\necho after\n' },
      }),
    );
    const content = new PresetResolver(projectDir).resolveContent('test-script', 'script')!;
    expect(content).toContain("echo 'core script'");
    expect(content).not.toContain('$CORE_SCRIPT');
  });

  test('wrap without placeholder raises', () => {
    install(specPack('bad-wrap', '# no placeholder\n', { strategy: 'wrap' }));
    expect(() => new PresetResolver(projectDir).resolveContent('spec-template')).toThrow(
      /Wrap strategy in 'bad-wrap v1\.0\.0' is missing the \{CORE_TEMPLATE\} placeholder/,
    );
  });

  test('multi preset chain composes bottom-up', () => {
    install(specPack('lo', 'LOW APPEND', { strategy: 'append' }), 10);
    install(specPack('hi', 'HIGH PREPEND', { strategy: 'prepend' }), 1);
    const content = new PresetResolver(projectDir).resolveContent('spec-template')!;
    expect(content).toBe('HIGH PREPEND\n\n# Core Spec Template\n\n\nLOW APPEND');
  });

  test('override trumps composition; replace over wrap', () => {
    install(specPack('wrap-lo', 'no placeholder', { strategy: 'wrap' }), 10);
    install(specPack('replace-hi', '# Replace wins\n'), 1);
    expect(new PresetResolver(projectDir).resolveContent('spec-template')).toBe('# Replace wins\n');
    write(join(projectDir, '.specify', 'templates', 'overrides', 'spec-template.md'), '# Override\n');
    expect(new PresetResolver(projectDir).resolveContent('spec-template')).toBe('# Override\n');
  });

  test('command frontmatter stripping and reattachment', () => {
    write(
      join(projectDir, '.specify', 'templates', 'commands', 'check.md'),
      '---\ndescription: Core check command\nscripts:\n  sh: scripts/check.sh\nargument-hint: <thing>\n---\nCore body content\n',
    );
    install(
      makePack({
        id: 'fm-test',
        templates: [{ type: 'command', name: 'speckit.check', file: 'commands/speckit.check.md', strategy: 'append' }],
        files: {
          'commands/speckit.check.md': '---\ndescription: Preset check override\nstrategy: append\n---\nPreset body content\n',
        },
      }),
    );
    const content = new PresetResolver(projectDir).resolveContent('speckit.check', 'command')!;
    expect(content).toContain('Preset check override');
    expect(content).toContain('Core body content');
    expect(content).toContain('Preset body content');
    expect(content.split('---').length - 1).toBe(2);
    expect(content).toContain('scripts:');
    expect(content).toContain('argument-hint: <thing>');
    expect(content).not.toContain('strategy:');
  });

  test('unreadable winning / composing layer returns null', () => {
    write(join(projectDir, '.specify', 'templates', 'overrides', 'bin-template.md'), Buffer.from([0xff, 0xfe]));
    expect(new PresetResolver(projectDir).resolveContent('bin-template')).toBeNull();

    install(
      makePack({
        id: 'bad-bytes',
        templates: [{ type: 'template', name: 'plan-template', file: 'templates/plan-template.md', strategy: 'append' }],
        files: {},
      }),
    );
    write(join(projectDir, '.specify', 'presets', 'bad-bytes', 'templates', 'plan-template.md'), Buffer.from([0xff]));
    expect(new PresetResolver(projectDir).resolveContent('plan-template')).toBeNull();
  });

  test('extension base layer rewrites extension-relative subdir paths', () => {
    writeExtension('kb-ext', {
      registry: { version: '1.0.0', enabled: true, priority: 10 },
      files: {
        'templates/kb-template.md': 'See agents/helper.md for details.\n',
        'agents/helper.md': '# helper\n',
      },
    });
    const content = new PresetResolver(projectDir).resolveContent('kb-template')!;
    expect(content).toContain('.specify/extensions/kb-ext/agents/helper.md');
  });
});

describe('collectAllLayers', () => {
  test('single core layer', () => {
    const layers = new PresetResolver(projectDir).collectAllLayers('spec-template');
    expect(layers.length).toBe(1);
    expect(layers[0].source).toBe('core');
    expect(layers[0].strategy).toBe('replace');
  });

  test('layers order matches priority and read strategy from manifest', () => {
    install(specPack('pack-lo', 'lo', { strategy: 'append' }), 10);
    install(specPack('pack-hi', 'hi', { strategy: 'prepend' }), 2);
    const layers = new PresetResolver(projectDir).collectAllLayers('spec-template');
    expect(layers.map((l) => [l.source, l.strategy])).toEqual([
      ['pack-hi v1.0.0', 'prepend'],
      ['pack-lo v1.0.0', 'append'],
      ['core', 'replace'],
    ]);
  });

  test('legacy frontmatter strategy honored for commands without manifest strategy', () => {
    install(
      makePack({
        id: 'legacy-fm',
        templates: [{ type: 'command', name: 'speckit.plan', file: 'commands/speckit.plan.md' }],
        files: { 'commands/speckit.plan.md': '---\nstrategy: Wrap\n---\n{CORE_TEMPLATE}\n' },
      }),
    );
    const layers = new PresetResolver(projectDir).collectAllLayers('speckit.plan', 'command');
    expect(layers[0].strategy).toBe('wrap');
  });

  test('non-utf8 legacy command keeps replace strategy', () => {
    install(
      makePack({
        id: 'bin-cmd',
        templates: [{ type: 'command', name: 'speckit.plan', file: 'commands/speckit.plan.md' }],
        files: { 'commands/speckit.plan.md': 'x' },
      }),
    );
    writeFileSync(
      join(projectDir, '.specify', 'presets', 'bin-cmd', 'commands', 'speckit.plan.md'),
      Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]),
    );
    const layers = new PresetResolver(projectDir).collectAllLayers('speckit.plan', 'command');
    expect(layers[0].strategy).toBe('replace');
  });

  test('disabled preset excluded from resolution', () => {
    install(specPack('pack-a', '# Pack A\n'));
    const m = new PresetManager(projectDir);
    m.registry.update('pack-a', { enabled: false });
    expect(readFileSync(new PresetResolver(projectDir).resolve('spec-template')!, 'utf-8')).toContain('Core Spec');
  });
});

// Silence unused imports on platforms where chmod/symlink tests are skipped.
void chmodSync;
void symlinkSync;
