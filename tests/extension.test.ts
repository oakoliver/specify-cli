/**
 * Tests for extension management system.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSimpleYaml,
  toYaml,
  ExtensionManifest,
  ExtensionRegistry,
  ExtensionManager,
  ValidationError,
  CompatibilityError,
  ExtensionError,
  EXTENSION_ID_PATTERN,
  COMMAND_NAME_PATTERN,
  DEFAULT_PRIORITY,
} from '../src/extension.js';

// ============================================================================
// Test Helpers
// ============================================================================

const TEST_DIR = '/tmp/spec-kit-extension-tests';

function setupTestProject(): string {
  const projectRoot = join(TEST_DIR, `project-${Date.now()}`);
  mkdirSync(join(projectRoot, '.specify', 'extensions'), { recursive: true });
  mkdirSync(join(projectRoot, '.specify', 'memory'), { recursive: true });
  
  // Create init-options.json
  writeFileSync(
    join(projectRoot, '.specify', 'init-options.json'),
    JSON.stringify({ ai: 'copilot', script: 'sh', branch_numbering: 'sequential', ai_skills: false })
  );
  
  return projectRoot;
}

function createExtensionDir(projectRoot: string, extId: string, manifest: object): string {
  const extDir = join(projectRoot, 'test-extensions', extId);
  mkdirSync(join(extDir, 'commands'), { recursive: true });
  
  writeFileSync(join(extDir, 'extension.yml'), toYaml(manifest as Record<string, unknown>));
  
  // Create a sample command file
  writeFileSync(
    join(extDir, 'commands', 'hello.md'),
    '---\ndescription: Test command\n---\n\nHello from extension!'
  );
  
  return extDir;
}

function validManifest(id = 'test-ext'): object {
  return {
    schema_version: '1.0',
    extension: {
      id,
      name: 'Test Extension',
      version: '1.0.0',
      description: 'A test extension',
    },
    requires: {
      speckit_version: '>=0.1.0',
    },
    provides: {
      commands: [
        {
          name: `speckit.${id}.hello`,
          file: 'commands/hello.md',
          description: 'Says hello',
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
// YAML Parser Tests
// ============================================================================

describe('parseSimpleYaml', () => {
  test('parses simple key-value pairs', () => {
    const yaml = `
name: test
version: 1.0.0
enabled: true
count: 42
`;
    const result = parseSimpleYaml(yaml);
    expect(result.name).toBe('test');
    expect(result.version).toBe('1.0.0');
    expect(result.enabled).toBe(true);
    expect(result.count).toBe(42);
  });

  test('parses nested objects', () => {
    const yaml = `
extension:
  id: test-ext
  name: Test
`;
    const result = parseSimpleYaml(yaml);
    expect((result.extension as any).id).toBe('test-ext');
    expect((result.extension as any).name).toBe('Test');
  });

  test('parses arrays', () => {
    const yaml = `
tags:
  - one
  - two
  - three
`;
    const result = parseSimpleYaml(yaml);
    expect(result.tags).toEqual(['one', 'two', 'three']);
  });

  test('parses arrays of objects', () => {
    const yaml = `
commands:
  - name: cmd1
    file: file1.md
  - name: cmd2
    file: file2.md
`;
    const result = parseSimpleYaml(yaml);
    expect((result.commands as any[])[0].name).toBe('cmd1');
    expect((result.commands as any[])[1].file).toBe('file2.md');
  });

  test('handles quoted strings', () => {
    const yaml = `
title: "Hello: World"
desc: 'Single quoted'
`;
    const result = parseSimpleYaml(yaml);
    expect(result.title).toBe('Hello: World');
    expect(result.desc).toBe('Single quoted');
  });

  test('handles null values', () => {
    const yaml = `
empty: null
tilde: ~
`;
    const result = parseSimpleYaml(yaml);
    expect(result.empty).toBeNull();
    expect(result.tilde).toBeNull();
  });

  test('ignores comments', () => {
    const yaml = `
# This is a comment
name: test # inline comment
`;
    const result = parseSimpleYaml(yaml);
    expect(result.name).toBe('test # inline comment'); // Note: inline comments not stripped
  });
});

describe('toYaml', () => {
  test('serializes simple object', () => {
    const obj = { name: 'test', version: '1.0.0' };
    const yaml = toYaml(obj);
    expect(yaml).toContain('name: test');
    expect(yaml).toContain('version: 1.0.0');
  });

  test('serializes nested objects', () => {
    const obj = { extension: { id: 'test', name: 'Test' } };
    const yaml = toYaml(obj);
    expect(yaml).toContain('extension:');
    expect(yaml).toContain('id: test');
  });

  test('serializes arrays', () => {
    const obj = { tags: ['one', 'two'] };
    const yaml = toYaml(obj);
    expect(yaml).toContain('tags:');
    expect(yaml).toContain('- one');
    expect(yaml).toContain('- two');
  });
});

// ============================================================================
// Pattern Tests
// ============================================================================

describe('EXTENSION_ID_PATTERN', () => {
  test('accepts valid IDs', () => {
    expect(EXTENSION_ID_PATTERN.test('my-extension')).toBe(true);
    expect(EXTENSION_ID_PATTERN.test('ext1')).toBe(true);
    expect(EXTENSION_ID_PATTERN.test('hello-world-123')).toBe(true);
  });

  test('rejects invalid IDs', () => {
    expect(EXTENSION_ID_PATTERN.test('My-Extension')).toBe(false);
    expect(EXTENSION_ID_PATTERN.test('ext_name')).toBe(false);
    expect(EXTENSION_ID_PATTERN.test('ext.name')).toBe(false);
    expect(EXTENSION_ID_PATTERN.test('')).toBe(false);
  });
});

describe('COMMAND_NAME_PATTERN', () => {
  test('accepts valid command names', () => {
    expect(COMMAND_NAME_PATTERN.test('speckit.my-ext.hello')).toBe(true);
    expect(COMMAND_NAME_PATTERN.test('speckit.ext1.cmd2')).toBe(true);
  });

  test('rejects invalid command names', () => {
    expect(COMMAND_NAME_PATTERN.test('my-ext.hello')).toBe(false);
    expect(COMMAND_NAME_PATTERN.test('speckit.hello')).toBe(false);
    expect(COMMAND_NAME_PATTERN.test('speckit.MyExt.Hello')).toBe(false);
  });
});

// ============================================================================
// ExtensionManifest Tests
// ============================================================================

describe('ExtensionManifest', () => {
  test('loads valid manifest', () => {
    const projectRoot = setupTestProject();
    const extDir = createExtensionDir(projectRoot, 'test-ext', validManifest());
    
    const manifest = new ExtensionManifest(join(extDir, 'extension.yml'));
    
    expect(manifest.id).toBe('test-ext');
    expect(manifest.name).toBe('Test Extension');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.description).toBe('A test extension');
    expect(manifest.commands).toHaveLength(1);
  });

  test('throws ValidationError for missing file', () => {
    expect(() => {
      new ExtensionManifest('/nonexistent/extension.yml');
    }).toThrow(ValidationError);
  });

  test('throws ValidationError for missing required fields', () => {
    const projectRoot = setupTestProject();
    const extDir = join(projectRoot, 'bad-ext');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'extension.yml'), 'schema_version: "1.0"');
    
    expect(() => {
      new ExtensionManifest(join(extDir, 'extension.yml'));
    }).toThrow(ValidationError);
  });

  test('throws ValidationError for invalid extension ID', () => {
    const projectRoot = setupTestProject();
    const manifest = { ...validManifest() } as any;
    manifest.extension.id = 'Invalid_ID';
    
    const extDir = join(projectRoot, 'bad-ext');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'extension.yml'), toYaml(manifest));
    
    expect(() => {
      new ExtensionManifest(join(extDir, 'extension.yml'));
    }).toThrow(ValidationError);
  });

  test('throws ValidationError for invalid version', () => {
    const projectRoot = setupTestProject();
    const manifest = { ...validManifest() } as any;
    manifest.extension.version = 'not-semver';
    
    const extDir = join(projectRoot, 'bad-ext');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'extension.yml'), toYaml(manifest));
    
    expect(() => {
      new ExtensionManifest(join(extDir, 'extension.yml'));
    }).toThrow(ValidationError);
  });

  test('throws ValidationError for no commands', () => {
    const projectRoot = setupTestProject();
    const manifest = { ...validManifest() } as any;
    manifest.provides.commands = [];
    
    const extDir = join(projectRoot, 'bad-ext');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'extension.yml'), toYaml(manifest));
    
    expect(() => {
      new ExtensionManifest(join(extDir, 'extension.yml'));
    }).toThrow(ValidationError);
  });

  test('throws ValidationError for command name not matching extension ID', () => {
    const projectRoot = setupTestProject();
    const manifest = { ...validManifest('my-ext') } as any;
    manifest.provides.commands[0].name = 'speckit.other-ext.hello';
    
    const extDir = join(projectRoot, 'bad-ext');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, 'extension.yml'), toYaml(manifest));
    
    expect(() => {
      new ExtensionManifest(join(extDir, 'extension.yml'));
    }).toThrow(ValidationError);
  });

  test('computes manifest hash', () => {
    const projectRoot = setupTestProject();
    const extDir = createExtensionDir(projectRoot, 'test-ext', validManifest());
    
    const manifest = new ExtensionManifest(join(extDir, 'extension.yml'));
    const hash = manifest.getHash();
    
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// ============================================================================
// ExtensionRegistry Tests
// ============================================================================

describe('ExtensionRegistry', () => {
  test('creates empty registry', () => {
    const projectRoot = setupTestProject();
    const registry = new ExtensionRegistry(projectRoot);
    
    expect(registry.list()).toEqual({});
    expect(registry.keys().size).toBe(0);
  });

  test('adds extension', () => {
    const projectRoot = setupTestProject();
    const registry = new ExtensionRegistry(projectRoot);
    
    registry.add('test-ext', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc123',
      enabled: true,
      priority: 10,
      registered_commands: {},
      registered_skills: [],
      installed_at: new Date().toISOString(),
    });
    
    expect(registry.isInstalled('test-ext')).toBe(true);
    expect(registry.get('test-ext')?.version).toBe('1.0.0');
  });

  test('removes extension', () => {
    const projectRoot = setupTestProject();
    const registry = new ExtensionRegistry(projectRoot);
    
    registry.add('test-ext', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc123',
      enabled: true,
      priority: 10,
      registered_commands: {},
      registered_skills: [],
      installed_at: new Date().toISOString(),
    });
    
    registry.remove('test-ext');
    
    expect(registry.isInstalled('test-ext')).toBe(false);
    expect(registry.get('test-ext')).toBeNull();
  });

  test('persists registry to disk', () => {
    const projectRoot = setupTestProject();
    const registry = new ExtensionRegistry(projectRoot);
    
    registry.add('test-ext', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc123',
      enabled: true,
      priority: 10,
      registered_commands: {},
      registered_skills: [],
      installed_at: new Date().toISOString(),
    });
    
    // Create new registry instance to test persistence
    const registry2 = new ExtensionRegistry(projectRoot);
    expect(registry2.isInstalled('test-ext')).toBe(true);
  });

  test('updates extension preserving installed_at', () => {
    const projectRoot = setupTestProject();
    const registry = new ExtensionRegistry(projectRoot);
    const originalTimestamp = '2024-01-01T00:00:00.000Z';
    
    registry.add('test-ext', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc123',
      enabled: true,
      priority: 10,
      registered_commands: {},
      registered_skills: [],
      installed_at: originalTimestamp,
    });
    
    registry.update('test-ext', { version: '2.0.0', enabled: false });
    
    const updated = registry.get('test-ext')!;
    expect(updated.version).toBe('2.0.0');
    expect(updated.enabled).toBe(false);
    expect(updated.installed_at).toBe(originalTimestamp);
  });

  test('update throws for missing extension', () => {
    const projectRoot = setupTestProject();
    const registry = new ExtensionRegistry(projectRoot);
    
    expect(() => {
      registry.update('nonexistent', { enabled: false });
    }).toThrow(ExtensionError);
  });

  test('restore overwrites completely', () => {
    const projectRoot = setupTestProject();
    const registry = new ExtensionRegistry(projectRoot);
    
    registry.add('test-ext', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc123',
      enabled: true,
      priority: 10,
      registered_commands: {},
      registered_skills: [],
      installed_at: new Date().toISOString(),
    });
    
    const newMetadata = {
      version: '2.0.0',
      source: 'catalog' as const,
      manifest_hash: 'sha256:xyz789',
      enabled: false,
      priority: 5,
      registered_commands: { copilot: ['speckit.test-ext.cmd'] },
      registered_skills: ['skill1'],
      installed_at: '2023-01-01T00:00:00.000Z',
    };
    
    registry.restore('test-ext', newMetadata);
    
    const restored = registry.get('test-ext')!;
    expect(restored.version).toBe('2.0.0');
    expect(restored.source).toBe('catalog');
    expect(restored.installed_at).toBe('2023-01-01T00:00:00.000Z');
  });

  test('restore rejects null metadata', () => {
    const projectRoot = setupTestProject();
    const registry = new ExtensionRegistry(projectRoot);
    
    expect(() => {
      registry.restore('test-ext', null as any);
    }).toThrow(ExtensionError);
  });

  test('get returns deep copy', () => {
    const projectRoot = setupTestProject();
    const registry = new ExtensionRegistry(projectRoot);
    
    registry.add('test-ext', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc123',
      enabled: true,
      priority: 10,
      registered_commands: { copilot: ['cmd1'] },
      registered_skills: [],
      installed_at: new Date().toISOString(),
    });
    
    const ext = registry.get('test-ext')!;
    ext.registered_commands.copilot.push('cmd2');
    
    const ext2 = registry.get('test-ext')!;
    expect(ext2.registered_commands.copilot).toEqual(['cmd1']);
  });

  test('listByPriority sorts by priority', () => {
    const projectRoot = setupTestProject();
    const registry = new ExtensionRegistry(projectRoot);
    
    registry.add('ext-low', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc',
      enabled: true,
      priority: 5,
      registered_commands: {},
      registered_skills: [],
      installed_at: new Date().toISOString(),
    });
    
    registry.add('ext-high', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:def',
      enabled: true,
      priority: 20,
      registered_commands: {},
      registered_skills: [],
      installed_at: new Date().toISOString(),
    });
    
    registry.add('ext-default', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:ghi',
      enabled: true,
      priority: 10,
      registered_commands: {},
      registered_skills: [],
      installed_at: new Date().toISOString(),
    });
    
    const sorted = registry.listByPriority();
    expect(sorted.map(([id]) => id)).toEqual(['ext-low', 'ext-default', 'ext-high']);
  });

  test('listByPriority excludes disabled by default', () => {
    const projectRoot = setupTestProject();
    const registry = new ExtensionRegistry(projectRoot);
    
    registry.add('ext-enabled', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:abc',
      enabled: true,
      priority: 10,
      registered_commands: {},
      registered_skills: [],
      installed_at: new Date().toISOString(),
    });
    
    registry.add('ext-disabled', {
      version: '1.0.0',
      source: 'local',
      manifest_hash: 'sha256:def',
      enabled: false,
      priority: 5,
      registered_commands: {},
      registered_skills: [],
      installed_at: new Date().toISOString(),
    });
    
    const sorted = registry.listByPriority();
    expect(sorted.map(([id]) => id)).toEqual(['ext-enabled']);
    
    const sortedWithDisabled = registry.listByPriority(true);
    expect(sortedWithDisabled.map(([id]) => id)).toEqual(['ext-disabled', 'ext-enabled']);
  });
});

// ============================================================================
// ExtensionManager Tests
// ============================================================================

describe('ExtensionManager', () => {
  describe('normalizePriority', () => {
    test('returns valid integer', () => {
      expect(ExtensionManager.normalizePriority(5)).toBe(5);
      expect(ExtensionManager.normalizePriority(100)).toBe(100);
    });

    test('returns default for invalid values', () => {
      expect(ExtensionManager.normalizePriority(null)).toBe(DEFAULT_PRIORITY);
      expect(ExtensionManager.normalizePriority(undefined)).toBe(DEFAULT_PRIORITY);
      expect(ExtensionManager.normalizePriority('')).toBe(DEFAULT_PRIORITY);
      expect(ExtensionManager.normalizePriority(-5)).toBe(DEFAULT_PRIORITY);
      expect(ExtensionManager.normalizePriority(0)).toBe(DEFAULT_PRIORITY);
      expect(ExtensionManager.normalizePriority('invalid')).toBe(DEFAULT_PRIORITY);
    });

    test('truncates floats', () => {
      expect(ExtensionManager.normalizePriority(5.9)).toBe(5);
    });

    test('accepts custom default', () => {
      expect(ExtensionManager.normalizePriority(null, 20)).toBe(20);
    });
  });

  describe('checkCompatibility', () => {
    test('returns true for compatible versions', () => {
      const projectRoot = setupTestProject();
      const extDir = createExtensionDir(projectRoot, 'test-ext', validManifest());
      const manifest = new ExtensionManifest(join(extDir, 'extension.yml'));
      const manager = new ExtensionManager(projectRoot);
      
      expect(manager.checkCompatibility(manifest, '1.0.0')).toBe(true);
      expect(manager.checkCompatibility(manifest, '0.1.0')).toBe(true);
      expect(manager.checkCompatibility(manifest, '2.0.0')).toBe(true);
    });

    test('returns false for incompatible versions', () => {
      const projectRoot = setupTestProject();
      const manifest = { ...validManifest() } as any;
      manifest.requires.speckit_version = '>=1.0.0';
      const extDir = createExtensionDir(projectRoot, 'test-ext', manifest);
      
      const manifestObj = new ExtensionManifest(join(extDir, 'extension.yml'));
      const manager = new ExtensionManager(projectRoot);
      
      expect(manager.checkCompatibility(manifestObj, '0.9.0')).toBe(false);
    });
  });

  describe('installFromDirectory', () => {
    test('installs valid extension', () => {
      const projectRoot = setupTestProject();
      const extDir = createExtensionDir(projectRoot, 'test-ext', validManifest());
      const manager = new ExtensionManager(projectRoot);
      
      // Create agent commands directory
      mkdirSync(join(projectRoot, '.github', 'agents'), { recursive: true });
      
      const manifest = manager.installFromDirectory(extDir, '1.0.0', false);
      
      expect(manifest.id).toBe('test-ext');
      expect(manager.registry.isInstalled('test-ext')).toBe(true);
      
      // Check extension files were copied
      expect(existsSync(join(projectRoot, '.specify', 'extensions', 'test-ext', 'extension.yml'))).toBe(true);
    });

    test('throws for already installed extension', () => {
      const projectRoot = setupTestProject();
      const extDir = createExtensionDir(projectRoot, 'test-ext', validManifest());
      const manager = new ExtensionManager(projectRoot);
      
      manager.installFromDirectory(extDir, '1.0.0', false);
      
      expect(() => {
        manager.installFromDirectory(extDir, '1.0.0', false);
      }).toThrow(ExtensionError);
    });

    test('throws for incompatible version', () => {
      const projectRoot = setupTestProject();
      const manifest = { ...validManifest() } as any;
      manifest.requires.speckit_version = '>=2.0.0';
      const extDir = createExtensionDir(projectRoot, 'test-ext', manifest);
      const manager = new ExtensionManager(projectRoot);
      
      expect(() => {
        manager.installFromDirectory(extDir, '1.0.0', false);
      }).toThrow(CompatibilityError);
    });

    test('sets custom priority', () => {
      const projectRoot = setupTestProject();
      const extDir = createExtensionDir(projectRoot, 'test-ext', validManifest());
      const manager = new ExtensionManager(projectRoot);
      
      manager.installFromDirectory(extDir, '1.0.0', false, 5);
      
      const metadata = manager.registry.get('test-ext')!;
      expect(metadata.priority).toBe(5);
    });
  });

  describe('remove', () => {
    test('removes installed extension', () => {
      const projectRoot = setupTestProject();
      const extDir = createExtensionDir(projectRoot, 'test-ext', validManifest());
      const manager = new ExtensionManager(projectRoot);
      
      manager.installFromDirectory(extDir, '1.0.0', false);
      const result = manager.remove('test-ext');
      
      expect(result).toBe(true);
      expect(manager.registry.isInstalled('test-ext')).toBe(false);
      expect(existsSync(join(projectRoot, '.specify', 'extensions', 'test-ext'))).toBe(false);
    });

    test('throws for nonexistent extension', () => {
      const projectRoot = setupTestProject();
      const manager = new ExtensionManager(projectRoot);
      
      expect(() => {
        manager.remove('nonexistent');
      }).toThrow(ExtensionError);
    });

    test('backs up config files with keepConfig', () => {
      const projectRoot = setupTestProject();
      const extDir = createExtensionDir(projectRoot, 'test-ext', validManifest());
      const manager = new ExtensionManager(projectRoot);
      
      manager.installFromDirectory(extDir, '1.0.0', false);
      
      // Add a config file
      const installedDir = join(projectRoot, '.specify', 'extensions', 'test-ext');
      writeFileSync(join(installedDir, 'test-ext-config.yml'), 'key: value');
      
      manager.remove('test-ext', true);
      
      // Check config was backed up
      expect(existsSync(join(projectRoot, '.specify', 'extensions', '.backup', 'test-ext', 'test-ext-config.yml'))).toBe(true);
    });
  });

  describe('listInstalled', () => {
    test('returns empty array when no extensions', () => {
      const projectRoot = setupTestProject();
      const manager = new ExtensionManager(projectRoot);
      
      expect(manager.listInstalled()).toEqual([]);
    });

    test('returns installed extensions sorted by priority', () => {
      const projectRoot = setupTestProject();
      const manager = new ExtensionManager(projectRoot);
      
      const ext1Dir = createExtensionDir(projectRoot, 'ext-one', validManifest('ext-one'));
      const ext2Dir = createExtensionDir(projectRoot, 'ext-two', validManifest('ext-two'));
      
      manager.installFromDirectory(ext1Dir, '1.0.0', false, 20);
      manager.installFromDirectory(ext2Dir, '1.0.0', false, 5);
      
      const list = manager.listInstalled();
      
      expect(list).toHaveLength(2);
      expect(list[0].id).toBe('ext-two');
      expect(list[1].id).toBe('ext-one');
    });
  });

  describe('getExtension', () => {
    test('returns manifest for installed extension', () => {
      const projectRoot = setupTestProject();
      const extDir = createExtensionDir(projectRoot, 'test-ext', validManifest());
      const manager = new ExtensionManager(projectRoot);
      
      manager.installFromDirectory(extDir, '1.0.0', false);
      
      const manifest = manager.getExtension('test-ext');
      expect(manifest?.id).toBe('test-ext');
    });

    test('returns null for nonexistent extension', () => {
      const projectRoot = setupTestProject();
      const manager = new ExtensionManager(projectRoot);
      
      expect(manager.getExtension('nonexistent')).toBeNull();
    });
  });

  describe('enable/disable', () => {
    test('enables and disables extension', () => {
      const projectRoot = setupTestProject();
      const extDir = createExtensionDir(projectRoot, 'test-ext', validManifest());
      const manager = new ExtensionManager(projectRoot);
      
      manager.installFromDirectory(extDir, '1.0.0', false);
      
      manager.disable('test-ext');
      expect(manager.registry.get('test-ext')?.enabled).toBe(false);
      
      manager.enable('test-ext');
      expect(manager.registry.get('test-ext')?.enabled).toBe(true);
    });
  });

  describe('setPriority', () => {
    test('sets extension priority', () => {
      const projectRoot = setupTestProject();
      const extDir = createExtensionDir(projectRoot, 'test-ext', validManifest());
      const manager = new ExtensionManager(projectRoot);
      
      manager.installFromDirectory(extDir, '1.0.0', false);
      
      manager.setPriority('test-ext', 3);
      expect(manager.registry.get('test-ext')?.priority).toBe(3);
    });

    test('normalizes invalid priority', () => {
      const projectRoot = setupTestProject();
      const extDir = createExtensionDir(projectRoot, 'test-ext', validManifest());
      const manager = new ExtensionManager(projectRoot);
      
      manager.installFromDirectory(extDir, '1.0.0', false);
      
      manager.setPriority('test-ext', -5);
      expect(manager.registry.get('test-ext')?.priority).toBe(DEFAULT_PRIORITY);
    });
  });
});
