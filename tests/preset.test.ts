/**
 * Tests for the legacy preset entry point (src/preset.ts).
 *
 * ``src/preset.ts`` is now a compatibility re-export layer over the faithful
 * port in ``src/presets/``. These tests exercise the historical import names
 * with the upstream (spec-kit v1.0.12) semantics:
 * - ``provides.templates[].type`` is one of ``template`` / ``command`` / ``script``
 *   and template names carry no extension (``spec-template``).
 * - ``PresetRegistry`` takes the ``.specify/presets`` directory.
 * - ``PresetResolver.resolve()`` returns a path; ``resolveWithSource()`` returns
 *   ``{path, source}``; ``resolveContent()`` returns composed content.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Manager,
  Manifest,
  PRESET_ID_PATTERN,
  PRESET_SCHEMA_VERSION,
  PresetCompatibilityError,
  PresetError,
  PresetManager,
  PresetManifest,
  PresetRegistry,
  PresetResolver,
  PresetValidationError,
  Registry,
  Resolver,
  VALID_TEMPLATE_TYPES,
} from '../src/preset.js';
import { dumpYaml } from '../src/yaml.js';

// ============================================================================
// Test Helpers
// ============================================================================

let testDir: string;

function setupTestProject(): string {
  const projectRoot = join(testDir, 'project');
  mkdirSync(join(projectRoot, '.specify', 'presets'), { recursive: true });
  mkdirSync(join(projectRoot, '.specify', 'templates'), { recursive: true });
  return projectRoot;
}

function validManifest(id = 'test-preset'): Record<string, any> {
  return {
    schema_version: '1.0',
    preset: {
      id,
      name: 'Test Preset',
      version: '1.0.0',
      description: 'A test preset',
    },
    requires: { speckit_version: '>=0.1.0' },
    provides: {
      templates: [
        {
          type: 'template',
          name: 'spec-template',
          file: 'templates/spec-template.md',
          description: 'Custom spec template',
        },
      ],
    },
  };
}

function createPresetDir(presetId: string, manifest: Record<string, any>): string {
  const presetDir = join(testDir, 'src-presets', presetId);
  mkdirSync(join(presetDir, 'templates'), { recursive: true });
  writeFileSync(join(presetDir, 'preset.yml'), dumpYaml(manifest));
  writeFileSync(join(presetDir, 'templates', 'spec-template.md'), '# Feature: {{name}}\n\nThis is a custom spec template.');
  return presetDir;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'spec-kit-preset-legacy-'));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Constants
// ============================================================================

describe('constants', () => {
  test('PRESET_ID_PATTERN', () => {
    expect(PRESET_ID_PATTERN.test('my-preset')).toBe(true);
    expect(PRESET_ID_PATTERN.test('preset1')).toBe(true);
    expect(PRESET_ID_PATTERN.test('My-Preset')).toBe(false);
    expect(PRESET_ID_PATTERN.test('preset_name')).toBe(false);
    expect(PRESET_ID_PATTERN.test('preset.name')).toBe(false);
    expect(PRESET_ID_PATTERN.test('')).toBe(false);
  });

  test('VALID_TEMPLATE_TYPES are the upstream template types', () => {
    expect([...VALID_TEMPLATE_TYPES]).toEqual(['command', 'script', 'template']);
    expect(PRESET_SCHEMA_VERSION).toBe('1.0');
  });

  test('legacy aliases', () => {
    expect(Manifest).toBe(PresetManifest);
    expect(Registry).toBe(PresetRegistry);
    expect(Manager).toBe(PresetManager);
    expect(Resolver).toBe(PresetResolver);
  });
});

// ============================================================================
// PresetManifest
// ============================================================================

describe('PresetManifest', () => {
  test('loads valid manifest', () => {
    const dir = createPresetDir('test-preset', validManifest());
    const manifest = new PresetManifest(join(dir, 'preset.yml'));
    expect(manifest.id).toBe('test-preset');
    expect(manifest.name).toBe('Test Preset');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.requiresSpeckitVersion).toBe('>=0.1.0');
    expect(manifest.templates.length).toBe(1);
    expect(manifest.getHash()).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('errors are PresetValidationError (subclass of PresetError)', () => {
    let err: unknown;
    try {
      new PresetManifest(join(testDir, 'missing.yml'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PresetValidationError);
    expect(err).toBeInstanceOf(PresetError);
  });

  test('rejects missing fields / invalid id / no templates / bad type', () => {
    const cases: Array<[(m: Record<string, any>) => void, RegExp]> = [
      [(m) => delete m.requires, /Missing required field: requires/],
      [(m) => (m.preset.id = 'Invalid_ID'), /Invalid preset ID/],
      [(m) => (m.provides.templates = []), /must provide at least one template/],
      [(m) => (m.provides.templates[0].type = 'spec-template'), /Invalid template type/],
    ];
    cases.forEach(([mutate, pattern], i) => {
      const m = validManifest(`p${i}`);
      mutate(m);
      const dir = createPresetDir(`p${i}`, m);
      expect(() => new PresetManifest(join(dir, 'preset.yml'))).toThrow(pattern);
    });
  });
});

// ============================================================================
// PresetRegistry
// ============================================================================

describe('PresetRegistry', () => {
  test('add / get / update / remove / persistence', () => {
    const projectRoot = setupTestProject();
    const presetsDir = join(projectRoot, '.specify', 'presets');
    const registry = new PresetRegistry(presetsDir);
    expect(registry.list()).toEqual({});
    registry.add('test-preset', { version: '1.0.0', source: 'local', enabled: true, priority: 10 });
    const installedAt = registry.get('test-preset')!.installed_at;
    registry.update('test-preset', { enabled: false });
    expect(registry.get('test-preset')!.enabled).toBe(false);
    expect(registry.get('test-preset')!.installed_at).toBe(installedAt);
    expect(new PresetRegistry(presetsDir).isInstalled('test-preset')).toBe(true);
    expect(existsSync(join(presetsDir, '.registry'))).toBe(true);
    registry.remove('test-preset');
    expect(registry.isInstalled('test-preset')).toBe(false);
    expect(() => registry.update('missing', {})).toThrow(/not found in registry/);
  });

  test('listByPriority sorts and filters disabled', () => {
    const registry = new PresetRegistry(join(setupTestProject(), '.specify', 'presets'));
    registry.add('c', { priority: 20, enabled: true });
    registry.add('a', { priority: 5, enabled: true });
    registry.add('b', { priority: 5, enabled: false });
    expect(registry.listByPriority().map(([id]) => id)).toEqual(['a', 'c']);
    expect(registry.listByPriority(true).map(([id]) => id)).toEqual(['a', 'b', 'c']);
  });
});

// ============================================================================
// PresetManager
// ============================================================================

describe('PresetManager', () => {
  test('installFromDirectory / listInstalled / getPack / remove', () => {
    const projectRoot = setupTestProject();
    const manager = new PresetManager(projectRoot);
    expect(manager.listInstalled()).toEqual([]);
    const manifest = manager.installFromDirectory(createPresetDir('test-preset', validManifest()), '1.0.0', 5);
    expect(manifest.id).toBe('test-preset');
    expect(existsSync(join(projectRoot, '.specify', 'presets', 'test-preset', 'preset.yml'))).toBe(true);
    const listed = manager.listInstalled();
    expect(listed.length).toBe(1);
    expect(listed[0].priority).toBe(5);
    expect(listed[0].template_count).toBe(1);
    expect(manager.getPack('test-preset')!.name).toBe('Test Preset');
    expect(manager.remove('test-preset')).toBe(true);
    expect(manager.remove('test-preset')).toBe(false);
    expect(manager.getPack('test-preset')).toBeNull();
  });

  test('already installed and incompatible versions', () => {
    const projectRoot = setupTestProject();
    const manager = new PresetManager(projectRoot);
    const dir = createPresetDir('test-preset', validManifest());
    manager.installFromDirectory(dir, '1.0.0');
    expect(() => manager.installFromDirectory(dir, '1.0.0')).toThrow(PresetError);
    const m = validManifest('future');
    m.requires.speckit_version = '>=99.0.0';
    expect(() => manager.installFromDirectory(createPresetDir('future', m), '1.0.0')).toThrow(PresetCompatibilityError);
  });
});

// ============================================================================
// PresetResolver
// ============================================================================

describe('PresetResolver', () => {
  test('returns null for nonexistent template', () => {
    expect(new PresetResolver(setupTestProject()).resolve('nonexistent')).toBeNull();
  });

  test('resolves template from preset with attribution', () => {
    const projectRoot = setupTestProject();
    new PresetManager(projectRoot).installFromDirectory(createPresetDir('test-preset', validManifest()), '1.0.0');
    const resolver = new PresetResolver(projectRoot);
    const resolved = resolver.resolveWithSource('spec-template');
    expect(resolved!.source).toBe('test-preset v1.0.0');
    expect(readFileSync(resolved!.path, 'utf-8')).toContain('custom spec template');
    expect(resolver.resolveContent('spec-template')).toContain('custom spec template');
  });

  test('project override takes precedence over preset', () => {
    const projectRoot = setupTestProject();
    new PresetManager(projectRoot).installFromDirectory(createPresetDir('test-preset', validManifest()), '1.0.0');
    mkdirSync(join(projectRoot, '.specify', 'templates', 'overrides'), { recursive: true });
    writeFileSync(join(projectRoot, '.specify', 'templates', 'overrides', 'spec-template.md'), '# Project Override');
    const resolved = new PresetResolver(projectRoot).resolveWithSource('spec-template');
    expect(resolved!.source).toBe('project override');
  });

  test('higher priority preset wins; disabled preset skipped', () => {
    const projectRoot = setupTestProject();
    const manager = new PresetManager(projectRoot);
    const low = createPresetDir('preset-low', validManifest('preset-low'));
    const high = createPresetDir('preset-high', validManifest('preset-high'));
    writeFileSync(join(high, 'templates', 'spec-template.md'), '# High Priority Preset');
    manager.installFromDirectory(low, '1.0.0', 20);
    manager.installFromDirectory(high, '1.0.0', 5);
    expect(new PresetResolver(projectRoot).resolveWithSource('spec-template')!.source).toBe('preset-high v1.0.0');
    manager.registry.update('preset-high', { enabled: false });
    expect(new PresetResolver(projectRoot).resolveWithSource('spec-template')!.source).toBe('preset-low v1.0.0');
  });
});
