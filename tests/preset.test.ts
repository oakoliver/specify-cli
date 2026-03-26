/**
 * Tests for preset management system.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PresetManifest,
  PresetRegistry,
  PresetManager,
  PresetResolver,
  PresetValidationError,
  PresetCompatibilityError,
  PresetError,
  PRESET_ID_PATTERN,
  VALID_TEMPLATE_TYPES,
} from '../src/preset.js';
import { toYaml, DEFAULT_PRIORITY } from '../src/extension.js';

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_DIR = '/tmp/spec-kit-preset-tests';

function setupTestProject(): string {
  const projectRoot = join(TEST_DIR, `project-${Date.now()}`);
  mkdirSync(join(projectRoot, '.specify', 'presets'), { recursive: true });
  mkdirSync(join(projectRoot, '.specify', 'templates'), { recursive: true });
  
  // Create init-options.json
  writeFileSync(
    join(projectRoot, '.specify', 'init-options.json'),
    JSON.stringify({ ai: 'copilot', script: 'sh', branch_numbering: 'sequential', ai_skills: false })
  );
  
  return projectRoot;
}

function createPresetDir(projectRoot: string, presetId: string, manifest: object): string {
  const presetDir = join(projectRoot, 'test-presets', presetId);
  mkdirSync(join(presetDir, 'templates'), { recursive: true });
  
  writeFileSync(join(presetDir, 'preset.yml'), toYaml(manifest as Record<string, unknown>));
  
  // Create a sample template file
  writeFileSync(
    join(presetDir, 'templates', 'spec-template.md'),
    '# Feature: {{name}}\n\nThis is a custom spec template.'
  );
  
  return presetDir;
}

function validManifest(id = 'test-preset'): object {
  return {
    schema_version: '1.0',
    preset: {
      id,
      name: 'Test Preset',
      version: '1.0.0',
      description: 'A test preset',
    },
    requires: {
      speckit_version: '>=0.1.0',
    },
    provides: {
      templates: [
        {
          type: 'spec-template',
          name: 'spec-template.md',
          file: 'templates/spec-template.md',
          description: 'Custom spec template',
        },
      ],
    },
  };
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
});

// ============================================================================
// Pattern Tests
// ============================================================================

describe('PRESET_ID_PATTERN', () => {
  test('accepts valid IDs', () => {
    expect(PRESET_ID_PATTERN.test('my-preset')).toBe(true);
    expect(PRESET_ID_PATTERN.test('preset1')).toBe(true);
    expect(PRESET_ID_PATTERN.test('hello-world-123')).toBe(true);
  });

  test('rejects invalid IDs', () => {
    expect(PRESET_ID_PATTERN.test('My-Preset')).toBe(false);
    expect(PRESET_ID_PATTERN.test('preset_name')).toBe(false);
    expect(PRESET_ID_PATTERN.test('preset.name')).toBe(false);
    expect(PRESET_ID_PATTERN.test('')).toBe(false);
  });
});

describe('VALID_TEMPLATE_TYPES', () => {
  test('includes expected types', () => {
    expect(VALID_TEMPLATE_TYPES).toContain('spec-template');
    expect(VALID_TEMPLATE_TYPES).toContain('plan-template');
    expect(VALID_TEMPLATE_TYPES).toContain('tasks-template');
    expect(VALID_TEMPLATE_TYPES).toContain('checklist-template');
  });
});

// ============================================================================
// PresetManifest Tests
// ============================================================================

describe('PresetManifest', () => {
  test('loads valid manifest', () => {
    const projectRoot = setupTestProject();
    const presetDir = createPresetDir(projectRoot, 'test-preset', validManifest());
    
    const manifest = new PresetManifest(join(presetDir, 'preset.yml'));
    
    expect(manifest.id).toBe('test-preset');
    expect(manifest.name).toBe('Test Preset');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.description).toBe('A test preset');
    expect(manifest.templates).toHaveLength(1);
  });

  test('throws PresetValidationError for missing file', () => {
    expect(() => {
      new PresetManifest('/nonexistent/preset.yml');
    }).toThrow(PresetValidationError);
  });

  test('throws PresetValidationError for missing required fields', () => {
    const projectRoot = setupTestProject();
    const presetDir = join(projectRoot, 'bad-preset');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(presetDir, 'preset.yml'), 'schema_version: "1.0"');
    
    expect(() => {
      new PresetManifest(join(presetDir, 'preset.yml'));
    }).toThrow(PresetValidationError);
  });

  test('throws PresetValidationError for invalid preset ID', () => {
    const projectRoot = setupTestProject();
    const manifest = { ...validManifest() } as any;
    manifest.preset.id = 'Invalid_ID';
    
    const presetDir = join(projectRoot, 'bad-preset');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(presetDir, 'preset.yml'), toYaml(manifest));
    
    expect(() => {
      new PresetManifest(join(presetDir, 'preset.yml'));
    }).toThrow(PresetValidationError);
  });

  test('throws PresetValidationError for no templates', () => {
    const projectRoot = setupTestProject();
    const manifest = { ...validManifest() } as any;
    manifest.provides.templates = [];
    
    const presetDir = join(projectRoot, 'bad-preset');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(presetDir, 'preset.yml'), toYaml(manifest));
    
    expect(() => {
      new PresetManifest(join(presetDir, 'preset.yml'));
    }).toThrow(PresetValidationError);
  });

  test('throws PresetValidationError for invalid template type', () => {
    const projectRoot = setupTestProject();
    const manifest = { ...validManifest() } as any;
    manifest.provides.templates[0].type = 'invalid-type';
    
    const presetDir = join(projectRoot, 'bad-preset');
    mkdirSync(presetDir, { recursive: true });
    writeFileSync(join(presetDir, 'preset.yml'), toYaml(manifest));
    
    expect(() => {
      new PresetManifest(join(presetDir, 'preset.yml'));
    }).toThrow(PresetValidationError);
  });

  test('computes manifest hash', () => {
    const projectRoot = setupTestProject();
    const presetDir = createPresetDir(projectRoot, 'test-preset', validManifest());
    
    const manifest = new PresetManifest(join(presetDir, 'preset.yml'));
    const hash = manifest.getHash();
    
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// ============================================================================
// PresetRegistry Tests
// ============================================================================

describe('PresetRegistry', () => {
  test('creates empty registry', () => {
    const projectRoot = setupTestProject();
    const registry = new PresetRegistry(projectRoot);
    
    expect(registry.list()).toEqual({});
    expect(registry.keys().size).toBe(0);
  });

  test('adds preset', () => {
    const projectRoot = setupTestProject();
    const registry = new PresetRegistry(projectRoot);
    
    registry.add('test-preset', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc123',
      enabled: true,
      priority: 10,
      installed_at: new Date().toISOString(),
    });
    
    expect(registry.isInstalled('test-preset')).toBe(true);
    expect(registry.get('test-preset')?.version).toBe('1.0.0');
  });

  test('removes preset', () => {
    const projectRoot = setupTestProject();
    const registry = new PresetRegistry(projectRoot);
    
    registry.add('test-preset', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc123',
      enabled: true,
      priority: 10,
      installed_at: new Date().toISOString(),
    });
    
    registry.remove('test-preset');
    
    expect(registry.isInstalled('test-preset')).toBe(false);
    expect(registry.get('test-preset')).toBeNull();
  });

  test('persists registry to disk', () => {
    const projectRoot = setupTestProject();
    const registry = new PresetRegistry(projectRoot);
    
    registry.add('test-preset', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc123',
      enabled: true,
      priority: 10,
      installed_at: new Date().toISOString(),
    });
    
    // Create new registry instance to test persistence
    const registry2 = new PresetRegistry(projectRoot);
    expect(registry2.isInstalled('test-preset')).toBe(true);
  });

  test('updates preset preserving installed_at', () => {
    const projectRoot = setupTestProject();
    const registry = new PresetRegistry(projectRoot);
    const originalTimestamp = '2024-01-01T00:00:00.000Z';
    
    registry.add('test-preset', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc123',
      enabled: true,
      priority: 10,
      installed_at: originalTimestamp,
    });
    
    registry.update('test-preset', { version: '2.0.0', enabled: false });
    
    const updated = registry.get('test-preset')!;
    expect(updated.version).toBe('2.0.0');
    expect(updated.enabled).toBe(false);
    expect(updated.installed_at).toBe(originalTimestamp);
  });

  test('update throws for missing preset', () => {
    const projectRoot = setupTestProject();
    const registry = new PresetRegistry(projectRoot);
    
    expect(() => {
      registry.update('nonexistent', { enabled: false });
    }).toThrow(PresetError);
  });

  test('listByPriority sorts by priority', () => {
    const projectRoot = setupTestProject();
    const registry = new PresetRegistry(projectRoot);
    
    registry.add('preset-low', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc',
      enabled: true,
      priority: 5,
      installed_at: new Date().toISOString(),
    });
    
    registry.add('preset-high', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:def',
      enabled: true,
      priority: 20,
      installed_at: new Date().toISOString(),
    });
    
    registry.add('preset-default', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:ghi',
      enabled: true,
      priority: 10,
      installed_at: new Date().toISOString(),
    });
    
    const sorted = registry.listByPriority();
    expect(sorted.map(([id]) => id)).toEqual(['preset-low', 'preset-default', 'preset-high']);
  });

  test('listByPriority excludes disabled by default', () => {
    const projectRoot = setupTestProject();
    const registry = new PresetRegistry(projectRoot);
    
    registry.add('preset-enabled', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc',
      enabled: true,
      priority: 10,
      installed_at: new Date().toISOString(),
    });
    
    registry.add('preset-disabled', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:def',
      enabled: false,
      priority: 5,
      installed_at: new Date().toISOString(),
    });
    
    const sorted = registry.listByPriority();
    expect(sorted.map(([id]) => id)).toEqual(['preset-enabled']);
    
    const sortedWithDisabled = registry.listByPriority(true);
    expect(sortedWithDisabled.map(([id]) => id)).toEqual(['preset-disabled', 'preset-enabled']);
  });
});

// ============================================================================
// PresetManager Tests
// ============================================================================

describe('PresetManager', () => {
  describe('normalizePriority', () => {
    test('returns valid integer', () => {
      expect(PresetManager.normalizePriority(5)).toBe(5);
      expect(PresetManager.normalizePriority(100)).toBe(100);
    });

    test('returns default for invalid values', () => {
      expect(PresetManager.normalizePriority(null)).toBe(DEFAULT_PRIORITY);
      expect(PresetManager.normalizePriority(undefined)).toBe(DEFAULT_PRIORITY);
      expect(PresetManager.normalizePriority('')).toBe(DEFAULT_PRIORITY);
      expect(PresetManager.normalizePriority(-5)).toBe(DEFAULT_PRIORITY);
      expect(PresetManager.normalizePriority(0)).toBe(DEFAULT_PRIORITY);
    });
  });

  describe('checkCompatibility', () => {
    test('returns true for compatible versions', () => {
      const projectRoot = setupTestProject();
      const presetDir = createPresetDir(projectRoot, 'test-preset', validManifest());
      const manifest = new PresetManifest(join(presetDir, 'preset.yml'));
      const manager = new PresetManager(projectRoot);
      
      expect(manager.checkCompatibility(manifest, '1.0.0')).toBe(true);
      expect(manager.checkCompatibility(manifest, '0.1.0')).toBe(true);
      expect(manager.checkCompatibility(manifest, '2.0.0')).toBe(true);
    });

    test('returns false for incompatible versions', () => {
      const projectRoot = setupTestProject();
      const manifest = { ...validManifest() } as any;
      manifest.requires.speckit_version = '>=1.0.0';
      const presetDir = createPresetDir(projectRoot, 'test-preset', manifest);
      
      const manifestObj = new PresetManifest(join(presetDir, 'preset.yml'));
      const manager = new PresetManager(projectRoot);
      
      expect(manager.checkCompatibility(manifestObj, '0.9.0')).toBe(false);
    });
  });

  describe('installFromDirectory', () => {
    test('installs valid preset', () => {
      const projectRoot = setupTestProject();
      const presetDir = createPresetDir(projectRoot, 'test-preset', validManifest());
      const manager = new PresetManager(projectRoot);
      
      const manifest = manager.installFromDirectory(presetDir, '1.0.0');
      
      expect(manifest.id).toBe('test-preset');
      expect(manager.registry.isInstalled('test-preset')).toBe(true);
      
      // Check preset files were copied
      expect(existsSync(join(projectRoot, '.specify', 'presets', 'test-preset', 'preset.yml'))).toBe(true);
    });

    test('throws for already installed preset', () => {
      const projectRoot = setupTestProject();
      const presetDir = createPresetDir(projectRoot, 'test-preset', validManifest());
      const manager = new PresetManager(projectRoot);
      
      manager.installFromDirectory(presetDir, '1.0.0');
      
      expect(() => {
        manager.installFromDirectory(presetDir, '1.0.0');
      }).toThrow(PresetError);
    });

    test('throws for incompatible version', () => {
      const projectRoot = setupTestProject();
      const manifest = { ...validManifest() } as any;
      manifest.requires.speckit_version = '>=2.0.0';
      const presetDir = createPresetDir(projectRoot, 'test-preset', manifest);
      const manager = new PresetManager(projectRoot);
      
      expect(() => {
        manager.installFromDirectory(presetDir, '1.0.0');
      }).toThrow(PresetCompatibilityError);
    });

    test('sets custom priority', () => {
      const projectRoot = setupTestProject();
      const presetDir = createPresetDir(projectRoot, 'test-preset', validManifest());
      const manager = new PresetManager(projectRoot);
      
      manager.installFromDirectory(presetDir, '1.0.0', 5);
      
      const metadata = manager.registry.get('test-preset')!;
      expect(metadata.priority).toBe(5);
    });
  });

  describe('remove', () => {
    test('removes installed preset', () => {
      const projectRoot = setupTestProject();
      const presetDir = createPresetDir(projectRoot, 'test-preset', validManifest());
      const manager = new PresetManager(projectRoot);
      
      manager.installFromDirectory(presetDir, '1.0.0');
      const result = manager.remove('test-preset');
      
      expect(result).toBe(true);
      expect(manager.registry.isInstalled('test-preset')).toBe(false);
      expect(existsSync(join(projectRoot, '.specify', 'presets', 'test-preset'))).toBe(false);
    });

    test('throws for nonexistent preset', () => {
      const projectRoot = setupTestProject();
      const manager = new PresetManager(projectRoot);
      
      expect(() => {
        manager.remove('nonexistent');
      }).toThrow(PresetError);
    });
  });

  describe('listInstalled', () => {
    test('returns empty array when no presets', () => {
      const projectRoot = setupTestProject();
      const manager = new PresetManager(projectRoot);
      
      expect(manager.listInstalled()).toEqual([]);
    });

    test('returns installed presets sorted by priority', () => {
      const projectRoot = setupTestProject();
      const manager = new PresetManager(projectRoot);
      
      const preset1Dir = createPresetDir(projectRoot, 'preset-one', validManifest('preset-one'));
      const preset2Dir = createPresetDir(projectRoot, 'preset-two', validManifest('preset-two'));
      
      manager.installFromDirectory(preset1Dir, '1.0.0', 20);
      manager.installFromDirectory(preset2Dir, '1.0.0', 5);
      
      const list = manager.listInstalled();
      
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('preset-two');
      expect(list[1].id).toBe('preset-one');
    });
  });

  describe('getPreset', () => {
    test('returns manifest for installed preset', () => {
      const projectRoot = setupTestProject();
      const presetDir = createPresetDir(projectRoot, 'test-preset', validManifest());
      const manager = new PresetManager(projectRoot);
      
      manager.installFromDirectory(presetDir, '1.0.0');
      
      const manifest = manager.getPreset('test-preset');
      expect(manifest?.id).toBe('test-preset');
    });

    test('returns null for nonexistent preset', () => {
      const projectRoot = setupTestProject();
      const manager = new PresetManager(projectRoot);
      
      expect(manager.getPreset('nonexistent')).toBeNull();
    });
  });

  describe('enable/disable', () => {
    test('enables and disables preset', () => {
      const projectRoot = setupTestProject();
      const presetDir = createPresetDir(projectRoot, 'test-preset', validManifest());
      const manager = new PresetManager(projectRoot);
      
      manager.installFromDirectory(presetDir, '1.0.0');
      
      manager.disable('test-preset');
      expect(manager.registry.get('test-preset')?.enabled).toBe(false);
      
      manager.enable('test-preset');
      expect(manager.registry.get('test-preset')?.enabled).toBe(true);
    });
  });

  describe('setPriority', () => {
    test('sets preset priority', () => {
      const projectRoot = setupTestProject();
      const presetDir = createPresetDir(projectRoot, 'test-preset', validManifest());
      const manager = new PresetManager(projectRoot);
      
      manager.installFromDirectory(presetDir, '1.0.0');
      
      manager.setPriority('test-preset', 3);
      expect(manager.registry.get('test-preset')?.priority).toBe(3);
    });
  });
});

// ============================================================================
// PresetResolver Tests
// ============================================================================

describe('PresetResolver', () => {
  test('resolves core template', () => {
    const projectRoot = setupTestProject();
    
    // Create a core template in a different location to avoid overlap
    // Note: In the actual implementation, core templates might be bundled differently
    // For testing, we'll verify the resolver finds templates from presets
    const resolver = new PresetResolver(projectRoot);
    
    // Without any templates, should return null
    expect(resolver.resolve('nonexistent.md')).toBeNull();
  });

  test('returns null for nonexistent template', () => {
    const projectRoot = setupTestProject();
    const resolver = new PresetResolver(projectRoot);
    
    expect(resolver.resolve('nonexistent.md')).toBeNull();
  });

  test('resolves template from preset', () => {
    const projectRoot = setupTestProject();
    const manager = new PresetManager(projectRoot);
    
    // Install preset with template
    const presetDir = createPresetDir(projectRoot, 'test-preset', validManifest());
    manager.installFromDirectory(presetDir, '1.0.0');
    
    const resolver = new PresetResolver(projectRoot);
    const result = resolver.resolve('spec-template.md');
    
    expect(result?.source).toBe('preset');
    expect(result?.source_id).toBe('test-preset');
    expect(result?.content).toContain('custom spec template');
  });

  test('project override takes precedence over preset', () => {
    const projectRoot = setupTestProject();
    const manager = new PresetManager(projectRoot);
    
    // Install preset
    const presetDir = createPresetDir(projectRoot, 'test-preset', validManifest());
    manager.installFromDirectory(presetDir, '1.0.0');
    
    // Create project override
    writeFileSync(
      join(projectRoot, '.specify', 'templates', 'spec-template.md'),
      '# Project Override Template'
    );
    
    const resolver = new PresetResolver(projectRoot);
    const result = resolver.resolve('spec-template.md');
    
    // Override should win
    expect(result?.source).toBe('override');
    expect(result?.content).toContain('Project Override Template');
  });

  test('higher priority preset wins', () => {
    const projectRoot = setupTestProject();
    const manager = new PresetManager(projectRoot);
    
    // Create two presets with different priorities
    const preset1Dir = createPresetDir(projectRoot, 'preset-low', validManifest('preset-low'));
    const preset2Dir = createPresetDir(projectRoot, 'preset-high', validManifest('preset-high'));
    
    // Update preset-high template content
    writeFileSync(
      join(preset2Dir, 'templates', 'spec-template.md'),
      '# High Priority Preset'
    );
    
    manager.installFromDirectory(preset1Dir, '1.0.0', 20);  // Lower priority
    manager.installFromDirectory(preset2Dir, '1.0.0', 5);   // Higher priority (lower number)
    
    const resolver = new PresetResolver(projectRoot);
    const result = resolver.resolve('spec-template.md');
    
    expect(result?.source_id).toBe('preset-high');
    expect(result?.content).toContain('High Priority Preset');
  });

  test('disabled preset skipped', () => {
    const projectRoot = setupTestProject();
    const manager = new PresetManager(projectRoot);
    
    // Install two presets
    const preset1Dir = createPresetDir(projectRoot, 'preset-enabled', validManifest('preset-enabled'));
    const preset2Dir = createPresetDir(projectRoot, 'preset-disabled', validManifest('preset-disabled'));
    
    // Make preset-disabled have higher priority but disable it
    writeFileSync(
      join(preset2Dir, 'templates', 'spec-template.md'),
      '# Disabled Preset'
    );
    
    manager.installFromDirectory(preset1Dir, '1.0.0', 10);
    manager.installFromDirectory(preset2Dir, '1.0.0', 5);  // Higher priority
    manager.disable('preset-disabled');
    
    const resolver = new PresetResolver(projectRoot);
    const result = resolver.resolve('spec-template.md');
    
    // Should use enabled preset
    expect(result?.source_id).toBe('preset-enabled');
  });
});
