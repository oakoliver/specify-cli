/**
 * Port of upstream ``TestExtensionRegistry`` and ``TestExtensionPriority``
 * registry cases (tests/test_extensions.py).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ExtensionRegistry, KeyError } from '../src/extensions/index.js';
import { cleanupTempDirs, makeTempDir } from './extensions-helpers.js';

afterEach(cleanupTempDirs);

function extDir(): string {
  const dir = join(makeTempDir(), 'extensions');
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('ExtensionRegistry', () => {
  test('empty registry', () => {
    const registry = new ExtensionRegistry(extDir());
    expect(registry.data.extensions).toEqual({});
    expect(registry.data.schema_version).toBe('1.0');
    expect(registry.list()).toEqual({});
    expect(registry.isInstalled('x')).toBe(false);
  });

  test('add extension', () => {
    const dir = extDir();
    const registry = new ExtensionRegistry(dir);
    registry.add('test-ext', { version: '1.0.0', source: 'local' });
    expect(registry.isInstalled('test-ext')).toBe(true);
    const meta = registry.get('test-ext')!;
    expect(meta.version).toBe('1.0.0');
    expect(meta.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
    expect(existsSync(join(dir, '.registry'))).toBe(true);
  });

  test('remove extension', () => {
    const registry = new ExtensionRegistry(extDir());
    registry.add('test-ext', { version: '1.0.0' });
    registry.remove('test-ext');
    expect(registry.isInstalled('test-ext')).toBe(false);
    expect(registry.get('test-ext')).toBeNull();
  });

  test('registry persistence (json indent=2)', () => {
    const dir = extDir();
    new ExtensionRegistry(dir).add('test-ext', { version: '1.0.0', name: 'Tést' });
    const reloaded = new ExtensionRegistry(dir);
    expect(reloaded.isInstalled('test-ext')).toBe(true);
    const raw = readFileSync(join(dir, '.registry'), 'utf-8');
    expect(raw).toContain('\n  "schema_version": "1.0"');
    expect(raw).toContain('T\\u00e9st'); // ensure_ascii
  });

  test('update preserves installed_at', () => {
    const registry = new ExtensionRegistry(extDir());
    registry.add('test-ext', { version: '1.0.0', enabled: true });
    const original = registry.get('test-ext')!.installed_at;
    registry.update('test-ext', { enabled: false, installed_at: 'bogus' });
    const updated = registry.get('test-ext')!;
    expect(updated.installed_at).toBe(original);
    expect(updated.enabled).toBe(false);
    expect(updated.version).toBe('1.0.0');
  });

  test('update raises for missing extension', () => {
    const registry = new ExtensionRegistry(extDir());
    expect(() => registry.update('missing', { enabled: false })).toThrow(KeyError);
  });

  test('restore overwrites completely and can recreate removed entry', () => {
    const registry = new ExtensionRegistry(extDir());
    registry.add('test-ext', { version: '1.0.0', extra: 1 });
    const backup = { version: '0.9.0', installed_at: '2020-01-01T00:00:00+00:00' };
    registry.restore('test-ext', backup);
    expect(registry.get('test-ext')).toEqual(backup);
    registry.remove('test-ext');
    registry.restore('test-ext', backup);
    expect(registry.get('test-ext')).toEqual(backup);
  });

  test('restore rejects null / non-dict metadata', () => {
    const registry = new ExtensionRegistry(extDir());
    expect(() => registry.restore('x', null)).toThrow("Cannot restore 'x': metadata must be a dict");
    expect(() => registry.restore('x', [] as never)).toThrow("Cannot restore 'x': metadata must be a dict");
  });

  test('restore / get / list use deep copies', () => {
    const registry = new ExtensionRegistry(extDir());
    const meta = { version: '1.0.0', registered_commands: { claude: ['a'] } };
    registry.restore('test-ext', meta);
    meta.registered_commands.claude.push('b');
    expect(registry.get('test-ext')!.registered_commands.claude).toEqual(['a']);
    const got = registry.get('test-ext')!;
    got.registered_commands.claude.push('c');
    expect(registry.get('test-ext')!.registered_commands.claude).toEqual(['a']);
    const listed = registry.list();
    listed['test-ext'].version = 'x';
    expect(registry.get('test-ext')!.version).toBe('1.0.0');
  });

  test('get returns null for corrupted entry; list filters; keys includes it', () => {
    const dir = extDir();
    writeFileSync(
      join(dir, '.registry'),
      JSON.stringify({ schema_version: '1.0', extensions: { bad: 'oops', good: { version: '1.0.0' } } }),
    );
    const registry = new ExtensionRegistry(dir);
    expect(registry.get('bad')).toBeNull();
    expect(Object.keys(registry.list())).toEqual(['good']);
    expect([...registry.keys()].sort()).toEqual(['bad', 'good']);
  });

  test('list returns empty dict for corrupted registry', () => {
    const dir = extDir();
    writeFileSync(join(dir, '.registry'), JSON.stringify({ schema_version: '1.0', extensions: [] }));
    const registry = new ExtensionRegistry(dir);
    expect(registry.list()).toEqual({});
    expect(registry.isCorrupt()).toBe(true);
  });

  test('load starts fresh for non-UTF-8 registry', () => {
    const dir = extDir();
    writeFileSync(join(dir, '.registry'), Buffer.from([0xff, 0xfe, 0x7b]));
    const registry = new ExtensionRegistry(dir);
    expect(registry.data).toEqual({ schema_version: '1.0', extensions: {} });
    expect(registry.isCorrupt()).toBe(true);
  });

  test('malformed json starts fresh; absent registry is not corrupt', () => {
    const dir = extDir();
    expect(new ExtensionRegistry(dir).isCorrupt()).toBe(false);
    writeFileSync(join(dir, '.registry'), '{not json');
    const registry = new ExtensionRegistry(dir);
    expect(registry.list()).toEqual({});
    expect(registry.isCorrupt()).toBe(true);
  });
});

describe('ExtensionRegistry.listByPriority', () => {
  test('empty', () => {
    expect(new ExtensionRegistry(extDir()).listByPriority()).toEqual([]);
  });

  test('ordering, ties alphabetical, default and invalid priorities', () => {
    const registry = new ExtensionRegistry(extDir());
    registry.add('zeta', { priority: 5 });
    registry.add('alpha', { priority: 5 });
    registry.add('mid', { priority: 'bogus' });
    registry.add('first', { priority: 1 });
    registry.add('legacy', {});
    const ids = registry.listByPriority().map(([id]) => id);
    expect(ids).toEqual(['first', 'alpha', 'zeta', 'legacy', 'mid']);
    const mid = registry.listByPriority().find(([id]) => id === 'mid')!;
    expect(mid[1].priority).toBe(10);
  });

  test('excludes disabled unless requested', () => {
    const registry = new ExtensionRegistry(extDir());
    registry.add('on', { priority: 1, enabled: true });
    registry.add('off', { priority: 2, enabled: false });
    expect(registry.listByPriority().map(([id]) => id)).toEqual(['on']);
    expect(registry.listByPriority(true).map(([id]) => id)).toEqual(['on', 'off']);
  });
});
