/**
 * Tests for src/presets/manager.ts (port of upstream
 * tests/specify_cli/presets/test_manager.py, key cases).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { dumpYaml } from '../src/yaml.js';
import { PresetManager } from '../src/presets/manager.js';
import {
  PresetCompatibilityError,
  PresetError,
  PresetManifest,
  PresetValidationError,
  setPresetWarningHandler,
} from '../src/presets/manifest.js';
import { PresetResolver } from '../src/presets/resolver.js';

let tempDir: string;
let projectDir: string;
let warnings: string[];

function write(p: string, content: string | Buffer): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'presets-manager-'));
  projectDir = join(tempDir, 'project');
  write(join(projectDir, '.specify', 'templates', 'spec-template.md'), '# Core Spec Template\n');
  write(join(projectDir, '.specify', 'templates', 'plan-template.md'), '# Core Plan Template\n');
  mkdirSync(join(projectDir, '.specify', 'templates', 'commands'), { recursive: true });
  warnings = [];
  setPresetWarningHandler((m) => warnings.push(m));
});

afterEach(() => {
  setPresetWarningHandler(null);
  rmSync(tempDir, { recursive: true, force: true });
});

function validPackData(): Record<string, any> {
  return {
    schema_version: '1.0',
    preset: {
      id: 'test-pack',
      name: 'Test Preset',
      version: '1.0.0',
      description: 'A test preset',
      author: 'Test Author',
      repository: 'https://github.com/test/test-pack',
      license: 'MIT',
    },
    requires: { speckit_version: '>=0.1.0' },
    provides: {
      templates: [
        {
          type: 'template',
          name: 'spec-template',
          file: 'templates/spec-template.md',
          description: 'Custom spec template',
          replaces: 'spec-template',
        },
      ],
    },
    tags: ['testing', 'example'],
  };
}

function makePackDir(data = validPackData(), name = 'test-pack'): string {
  const dir = join(tempDir, name);
  write(join(dir, 'preset.yml'), dumpYaml(data));
  write(join(dir, 'templates', 'spec-template.md'), '# Custom Spec Template\n\nThis is a custom template.\n');
  return dir;
}

// ---------------------------------------------------------------------------
// Minimal stored ZIP writer (deflate) for archive install tests
// ---------------------------------------------------------------------------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function makeZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf-8');
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf-8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ============================================================================

describe('PresetManager install/remove/list', () => {
  test('install from directory', () => {
    const manager = new PresetManager(projectDir);
    const manifest = manager.installFromDirectory(makePackDir(), '0.1.5');
    expect(manifest.id).toBe('test-pack');
    expect(manager.registry.isInstalled('test-pack')).toBe(true);
    const installed = join(projectDir, '.specify', 'presets', 'test-pack');
    expect(existsSync(join(installed, 'preset.yml'))).toBe(true);
    expect(existsSync(join(installed, 'templates', 'spec-template.md'))).toBe(true);
    const meta = manager.registry.get('test-pack')!;
    expect(meta.source).toBe('local');
    expect(meta.priority).toBe(10);
    expect(meta.enabled).toBe(true);
    expect(meta.registered_commands).toEqual({});
    expect(meta.registered_skills).toEqual({});
    expect(String(meta.manifest_hash)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('catalog_name recorded as source', () => {
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(makePackDir(), '0.1.5', 10, { catalogName: '  community  ' });
    expect(manager.registry.get('test-pack')!.source).toEqual({ kind: 'catalog', catalog: 'community' });
  });

  test('install already installed', () => {
    const manager = new PresetManager(projectDir);
    const dir = makePackDir();
    manager.installFromDirectory(dir, '0.1.5');
    expect(() => manager.installFromDirectory(dir, '0.1.5')).toThrow(
      "Preset 'test-pack' is already installed. Use 'specify preset remove test-pack' first.",
    );
    // force replaces
    manager.installFromDirectory(dir, '0.1.5', 3, { force: true });
    expect(manager.registry.get('test-pack')!.priority).toBe(3);
  });

  test('install incompatible', () => {
    const data = validPackData();
    data.requires.speckit_version = '>=99.0.0';
    const manager = new PresetManager(projectDir);
    let err: unknown;
    try {
      manager.installFromDirectory(makePackDir(data), '0.1.5');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PresetCompatibilityError);
    expect((err as Error).message).toContain('Preset requires spec-kit >=99.0.0, but 0.1.5 is installed.');
    expect((err as Error).message).toContain('Upgrade spec-kit with: uv tool install specify-cli --force');
  });

  test('invalid priority rejected', () => {
    expect(() => new PresetManager(projectDir).installFromDirectory(makePackDir(), '0.1.5', 0)).toThrow(
      'Priority must be a positive integer (1 or higher)',
    );
  });

  test('install from zip (flat and nested) / no manifest', () => {
    const manifestYaml = dumpYaml(validPackData());
    const flat = join(tempDir, 'flat.zip');
    writeFileSync(flat, makeZip({ 'preset.yml': manifestYaml, 'templates/spec-template.md': '# Zipped\n' }));
    const manager = new PresetManager(projectDir);
    expect(manager.installFromZip(flat, '0.1.5').id).toBe('test-pack');
    manager.remove('test-pack');

    const nested = join(tempDir, 'nested.zip');
    writeFileSync(
      nested,
      makeZip({ 'test-pack-v1/preset.yml': manifestYaml, 'test-pack-v1/templates/spec-template.md': '# N\n' }),
    );
    expect(manager.installFromArchive(nested, '0.1.5').id).toBe('test-pack');

    const empty = join(tempDir, 'empty.zip');
    writeFileSync(empty, makeZip({ 'readme.txt': 'hi' }));
    expect(() => manager.installFromZip(empty, '0.1.5')).toThrow('No preset.yml found in archive');
  });

  test('remove / remove nonexistent', () => {
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(makePackDir(), '0.1.5');
    expect(manager.remove('test-pack')).toBe(true);
    expect(manager.registry.isInstalled('test-pack')).toBe(false);
    expect(existsSync(join(projectDir, '.specify', 'presets', 'test-pack'))).toBe(false);
    expect(manager.remove('nonexistent')).toBe(false);
  });

  test('list installed / get pack', () => {
    const manager = new PresetManager(projectDir);
    expect(manager.listInstalled()).toEqual([]);
    manager.installFromDirectory(makePackDir(), '0.1.5', 4);
    const installed = manager.listInstalled();
    expect(installed.length).toBe(1);
    expect(installed[0].id).toBe('test-pack');
    expect(installed[0].name).toBe('Test Preset');
    expect(installed[0].template_count).toBe(1);
    expect(installed[0].priority).toBe(4);
    expect(installed[0].tags).toEqual(['testing', 'example']);
    expect(installed[0]._json_author).toBe('Test Author');
    expect(installed[0]._json_provides).toEqual({ commands: 0, templates: 1, scripts: 0, hooks: 0 });
    expect(manager.getPack('test-pack')!.name).toBe('Test Preset');
    expect(manager.getPack('nope')).toBeNull();
  });

  test('one bad manifest does not hide healthy presets', () => {
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(makePackDir(), '0.1.5');
    const other = validPackData();
    other.preset.id = 'other-pack';
    manager.installFromDirectory(makePackDir(other, 'other-pack'), '0.1.5');
    writeFileSync(
      join(projectDir, '.specify', 'presets', 'other-pack', 'preset.yml'),
      'schema_version: "1.0"\npreset:\n  id: other-pack\n  name: x\n  version: 1.0\n  description: d\nrequires:\n  speckit_version: ">=0.1"\nprovides:\n  templates: []\n',
    );
    const list = manager.listInstalled();
    const bad = list.find((p) => p.id === 'other-pack')!;
    expect(bad.description).toBe('⚠️ Corrupted preset');
    expect(bad.enabled).toBe(false);
    expect(list.find((p) => p.id === 'test-pack')!.name).toBe('Test Preset');
  });

  test('legacy preset without priority field', () => {
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(makePackDir(), '0.1.5');
    const data = manager.registry.data;
    delete data.presets['test-pack'].priority;
    expect(manager.listInstalled()[0].priority).toBe(10);
  });
});

describe('checkCompatibility', () => {
  test('valid / prerelease / invalid / non-string', () => {
    const manager = new PresetManager(projectDir);
    const manifest = new PresetManifest(join(makePackDir(), 'preset.yml'));
    expect(manager.checkCompatibility(manifest, '0.1.5')).toBe(true);
    expect(manager.checkCompatibility(manifest, '0.2.0.dev0')).toBe(true);

    manifest.data.requires.speckit_version = 'not a spec';
    expect(() => manager.checkCompatibility(manifest, '0.1.5')).toThrow('Invalid version specifier: not a spec');
    for (const bad of [1.5, ['>=1'], null]) {
      manifest.data.requires.speckit_version = bad;
      expect(() => manager.checkCompatibility(manifest, '0.1.5')).toThrow(
        /Invalid version specifier: expected a string, got/,
      );
    }
    manifest.data.requires.speckit_version = 1.5;
    expect(() => manager.checkCompatibility(manifest, '0.1.5')).toThrow(
      'Invalid version specifier: expected a string, got float (1.5)',
    );
  });
});

describe('findUnmetExtensionDependencies', () => {
  function installExtension(id: string, version: unknown, enabled = true, withFiles = true): void {
    const extensionsDir = join(projectDir, '.specify', 'extensions');
    mkdirSync(extensionsDir, { recursive: true });
    if (withFiles) mkdirSync(join(extensionsDir, id), { recursive: true });
    const regPath = join(extensionsDir, '.registry');
    let data: Record<string, any> = { schema_version: '1.0', extensions: {} };
    if (existsSync(regPath)) data = JSON.parse(readFileSync(regPath, 'utf-8'));
    data.extensions[id] = { version, enabled };
    writeFileSync(regPath, JSON.stringify(data));
  }

  function manifestWith(declared: unknown): PresetManifest {
    const data = validPackData();
    data.requires.extensions = declared;
    const p = join(tempDir, 'dep-preset.yml');
    writeFileSync(p, dumpYaml(data));
    return new PresetManifest(p);
  }

  test('no declared dependencies', () => {
    expect(new PresetManager(projectDir).findUnmetExtensionDependencies(manifestWith([]))).toEqual([]);
  });

  test('missing / installed / version / optional', () => {
    const manager = new PresetManager(projectDir);
    let unmet = manager.findUnmetExtensionDependencies(manifestWith(['speckit-inventory']));
    expect(unmet).toEqual([{ id: 'speckit-inventory', version: null, required: true, installed: null, reason: 'missing' }]);

    installExtension('speckit-inventory', '0.1.0');
    expect(manager.findUnmetExtensionDependencies(manifestWith(['speckit-inventory']))).toEqual([]);
    expect(
      manager.findUnmetExtensionDependencies(manifestWith([{ id: 'speckit-inventory', version: '>=0.1.0' }])),
    ).toEqual([]);
    unmet = manager.findUnmetExtensionDependencies(manifestWith([{ id: 'speckit-inventory', version: '>=2.0' }]));
    expect(unmet.length).toBe(1);
    expect(unmet[0].reason).toBe('version');
    expect(unmet[0].installed).toBe('0.1.0');
    expect(unmet[0].version).toBe('>=2.0');
    expect(
      manager.findUnmetExtensionDependencies(manifestWith([{ id: 'absent-ext', required: false }])),
    ).toEqual([]);
  });

  test('uncomparable registry version is not a mismatch', () => {
    installExtension('ext-a', 'unknown');
    expect(
      new PresetManager(projectDir).findUnmetExtensionDependencies(manifestWith([{ id: 'ext-a', version: '>=1' }])),
    ).toEqual([]);
  });

  test('unregistered extension on disk is satisfied; with corrupt registry is missing', () => {
    mkdirSync(join(projectDir, '.specify', 'extensions', 'ext-b'), { recursive: true });
    const manager = new PresetManager(projectDir);
    expect(manager.findUnmetExtensionDependencies(manifestWith(['ext-b']))).toEqual([]);
    writeFileSync(join(projectDir, '.specify', 'extensions', '.registry'), '{broken');
    expect(manager.findUnmetExtensionDependencies(manifestWith(['ext-b']))[0].reason).toBe('missing');
  });

  test('corrupted registry entry', () => {
    installExtension('ext-c', '1.0.0');
    const regPath = join(projectDir, '.specify', 'extensions', '.registry');
    const data = JSON.parse(readFileSync(regPath, 'utf-8'));
    data.extensions['ext-c'] = 'garbage';
    writeFileSync(regPath, JSON.stringify(data));
    expect(new PresetManager(projectDir).findUnmetExtensionDependencies(manifestWith(['ext-c']))[0].reason).toBe(
      'corrupt',
    );
  });

  test('stale ahead of disabled ahead of version', () => {
    installExtension('ext-d', '1.0.0', false, false);
    const manager = new PresetManager(projectDir);
    expect(manager.findUnmetExtensionDependencies(manifestWith([{ id: 'ext-d', version: '>=2' }]))[0].reason).toBe(
      'stale',
    );
    mkdirSync(join(projectDir, '.specify', 'extensions', 'ext-d'), { recursive: true });
    expect(manager.findUnmetExtensionDependencies(manifestWith([{ id: 'ext-d', version: '>=2' }]))[0].reason).toBe(
      'disabled',
    );
  });

  test('exact duplicates warn once; different constraints checked twice', () => {
    installExtension('ext-e', '1.0.0');
    const manager = new PresetManager(projectDir);
    expect(
      manager.findUnmetExtensionDependencies(
        manifestWith([
          { id: 'ext-e', version: '>=2' },
          { id: 'ext-e', version: '>=2' },
        ]),
      ).length,
    ).toBe(1);
    expect(
      manager.findUnmetExtensionDependencies(
        manifestWith([
          { id: 'ext-e', version: '>=2' },
          { id: 'ext-e', version: '>=3' },
        ]),
      ).length,
    ).toBe(2);
  });
});

// ============================================================================
// Constitution sync
// ============================================================================

const CONSTITUTION_SYNC_DIR = resolve(import.meta.dir, '..', 'core_pack', 'presets', 'constitution-sync');

function selfTestLikePreset(): string {
  const dir = join(tempDir, 'self-test');
  const names = ['spec-template', 'plan-template', 'tasks-template', 'checklist-template', 'constitution-template'];
  write(
    join(dir, 'preset.yml'),
    dumpYaml({
      schema_version: '1.0',
      preset: { id: 'self-test', name: 'Self-Test Preset', version: '1.0.0', description: 'self test' },
      requires: { speckit_version: '>=0.1.0' },
      provides: {
        templates: names.map((n) => ({ type: 'template', name: n, file: `templates/${n}.md` })),
      },
    }),
  );
  for (const n of names) write(join(dir, 'templates', `${n}.md`), `# ${n} (Self-Test Preset)\n\n<!-- preset:self-test -->\n`);
  return dir;
}

describe('constitution-sync', () => {
  const memory = () => join(projectDir, '.specify', 'memory', 'constitution.md');

  test('does not seed without sync', () => {
    new PresetManager(projectDir).installFromDirectory(selfTestLikePreset(), '0.1.5');
    expect(existsSync(memory())).toBe(false);
  });

  test('seeds with sync and restores core on removal', () => {
    write(join(projectDir, '.specify', 'templates', 'constitution-template.md'), '# Core constitution-template\n');
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(CONSTITUTION_SYNC_DIR, '0.15.0');
    expect(readFileSync(memory(), 'utf-8')).toBe('# Core constitution-template\n');
    manager.installFromDirectory(selfTestLikePreset(), '0.1.5');
    expect(readFileSync(memory(), 'utf-8')).toContain('preset:self-test');
    const provenance = JSON.parse(
      readFileSync(join(projectDir, '.specify', 'memory', '.constitution-template.json'), 'utf-8'),
    );
    expect(provenance.source).toBe('self-test v1.0.0');
    manager.remove('self-test');
    expect(readFileSync(memory(), 'utf-8')).toBe('# Core constitution-template\n');
  });

  test('removal preserves edited constitution', () => {
    write(join(projectDir, '.specify', 'templates', 'constitution-template.md'), '# Core Constitution\n');
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(CONSTITUTION_SYNC_DIR, '0.15.0');
    manager.installFromDirectory(selfTestLikePreset(), '0.1.5');
    const edited = readFileSync(memory(), 'utf-8') + '\n## Authored amendment\n';
    writeFileSync(memory(), edited);
    manager.remove('self-test');
    expect(readFileSync(memory(), 'utf-8')).toBe(edited);
  });

  test('preserves authored constitution on install', () => {
    const manager = new PresetManager(projectDir);
    write(memory(), '# My authored constitution\n');
    manager.installFromDirectory(CONSTITUTION_SYNC_DIR, '0.15.0');
    manager.installFromDirectory(selfTestLikePreset(), '0.1.5');
    expect(readFileSync(memory(), 'utf-8')).toBe('# My authored constitution\n');
  });

  test('seed rejects symlinked memory directory (non-fatal warning)', () => {
    const outside = join(tempDir, 'outside-memory');
    mkdirSync(outside);
    symlinkSync(outside, join(projectDir, '.specify', 'memory'));
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(CONSTITUTION_SYNC_DIR, '0.15.0');
    expect(readdirSync(outside)).toEqual([]);
    expect(warnings.some((w) => w.startsWith('Failed to seed constitution from preset constitution-sync:'))).toBe(true);
  });
});

describe('command registration and reconciliation', () => {
  function commandPreset(id: string, body: string): string {
    const dir = join(tempDir, id);
    write(
      join(dir, 'preset.yml'),
      dumpYaml({
        schema_version: '1.0',
        preset: { id, name: id, version: '1.0.0', description: 'Test' },
        requires: { speckit_version: '>=0.1.0' },
        provides: { templates: [{ type: 'command', name: 'speckit.specify', file: 'commands/speckit.specify.md' }] },
      }),
    );
    write(join(dir, 'commands', 'speckit.specify.md'), `---\ndescription: ${id}\n---\n${body}\n`);
    return dir;
  }

  test('remove restores lower-priority command (legacy all-agent project)', () => {
    const geminiDir = join(projectDir, '.gemini', 'commands');
    mkdirSync(geminiDir, { recursive: true });
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(commandPreset('lo-preset', 'Lo content'), '0.1.5', 10);
    manager.installFromDirectory(commandPreset('hi-preset', 'Hi content'), '0.1.5', 1);
    let files = readdirSync(geminiDir).filter((f) => f.includes('specify'));
    expect(files.length).toBeGreaterThan(0);
    expect(readFileSync(join(geminiDir, files[0]), 'utf-8')).toContain('Hi content');

    manager.remove('hi-preset');
    const layers = new PresetResolver(projectDir).collectAllLayers('speckit.specify', 'command');
    expect(layers[0].source).toContain('lo-preset');
    files = readdirSync(geminiDir).filter((f) => f.includes('specify'));
    expect(files.length).toBeGreaterThan(0);
    expect(readFileSync(join(geminiDir, files[0]), 'utf-8')).toContain('Lo content');
  });

  test('wrap command with no base layer warns and is skipped', () => {
    const dir = join(tempDir, 'wrapper');
    write(
      join(dir, 'preset.yml'),
      dumpYaml({
        schema_version: '1.0',
        preset: { id: 'wrapper', name: 'w', version: '1.0.0', description: 'Test' },
        requires: { speckit_version: '>=0.1.0' },
        provides: {
          templates: [{ type: 'command', name: 'speckit.nonexistent-cmd', file: 'commands/w.md', strategy: 'wrap' }],
        },
      }),
    );
    write(join(dir, 'commands', 'w.md'), '---\ndescription: w\n---\n{CORE_TEMPLATE}\n');
    mkdirSync(join(projectDir, '.gemini', 'commands'), { recursive: true });
    new PresetManager(projectDir).installFromDirectory(dir, '0.1.5');
    expect(
      warnings.some((w) =>
        w.includes("Command 'speckit.nonexistent-cmd' uses 'wrap' strategy but no base command layer exists"),
      ),
    ).toBe(true);
  });
});

void PresetError;
void PresetValidationError;
