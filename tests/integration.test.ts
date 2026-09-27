/**
 * Integration Module Tests (legacy compatibility layer in src/integration.ts).
 *
 * The v1.1.0 helpers now delegate to the upstream-parity integration registry,
 * hash-tracked manifests and `.specify/integration.json` multi-install state.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadManifest,
  listIntegrations,
  addIntegration,
  removeIntegration,
  getIntegrationInfo,
} from '../src/integration.js';
import { INTEGRATION_REGISTRY } from '../src/integrations/index.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'integration-test-'));
  mkdirSync(join(testDir, '.specify', 'integrations'), { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function state(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(testDir, '.specify', 'integration.json'), 'utf-8'));
}

describe('loadManifest', () => {
  test('returns null when manifest does not exist', () => {
    expect(loadManifest(testDir, 'claude')).toBeNull();
  });

  test('loads hash manifests as a file list', () => {
    writeFileSync(
      join(testDir, '.specify', 'integrations', 'claude.manifest.json'),
      JSON.stringify({ integration: 'claude', version: '1.0.0', installed_at: 't', files: { 'a.md': 'h1', 'b.md': 'h2' } }),
    );
    expect(loadManifest(testDir, 'claude')).toEqual({
      integration: 'claude',
      version: '1.0.0',
      installed_at: 't',
      files: ['a.md', 'b.md'],
    });
  });

  test('returns null for corrupted JSON', () => {
    writeFileSync(join(testDir, '.specify', 'integrations', 'claude.manifest.json'), '{bad');
    expect(loadManifest(testDir, 'claude')).toBeNull();
  });
});

describe('listIntegrations / getIntegrationInfo', () => {
  test('lists every registered integration, sorted', () => {
    const list = listIntegrations(testDir);
    expect(list.map((i) => i.key)).toEqual(Object.keys(INTEGRATION_REGISTRY).sort());
    for (const info of list) {
      expect(typeof info.name).toBe('string');
      expect(info.installed).toBe(false);
    }
  });

  test('returns null for unknown integration', () => {
    expect(getIntegrationInfo(testDir, 'nope')).toBeNull();
  });

  test('reports registrar metadata', () => {
    const gemini = getIntegrationInfo(testDir, 'gemini');
    expect(gemini?.format).toBe('toml');
    expect(gemini?.name).toBe('Gemini CLI');
    const claude = getIntegrationInfo(testDir, 'claude');
    expect(claude?.name).toBe('Claude Code');
  });

  test('marks integration installed when recorded in integration.json', () => {
    writeFileSync(join(testDir, '.specify', 'integration.json'), JSON.stringify({ integration: 'gemini' }));
    expect(getIntegrationInfo(testDir, 'gemini')?.installed).toBe(true);
  });
});

describe('addIntegration / removeIntegration', () => {
  test('throws for unknown integration', async () => {
    await expect(addIntegration(testDir, 'nope')).rejects.toThrow('Unknown integration');
  });

  test('installs files, manifest and state', async () => {
    const manifest = await addIntegration(testDir, 'gemini', '9.9.9');
    expect(manifest.integration).toBe('gemini');
    expect(manifest.version).toBe('9.9.9');
    expect(manifest.files.length).toBeGreaterThan(0);
    for (const rel of manifest.files) expect(existsSync(join(testDir, rel))).toBe(true);
    expect(state()['default_integration']).toBe('gemini');
    expect(getIntegrationInfo(testDir, 'gemini')?.files_count).toBe(manifest.files.length);
    await expect(addIntegration(testDir, 'gemini')).rejects.toThrow('already installed');
  });

  test('second integration keeps the first as default', async () => {
    await addIntegration(testDir, 'claude');
    await addIntegration(testDir, 'gemini');
    expect(state()['default_integration']).toBe('claude');
    expect(state()['installed_integrations']).toEqual(['claude', 'gemini']);
  });

  test('removes files and state', async () => {
    const manifest = await addIntegration(testDir, 'gemini');
    await removeIntegration(testDir, 'gemini');
    for (const rel of manifest.files) expect(existsSync(join(testDir, rel))).toBe(false);
    expect(loadManifest(testDir, 'gemini')).toBeNull();
    expect(existsSync(join(testDir, '.specify', 'integration.json'))).toBe(false);
  });

  test('remove falls back to the next default', async () => {
    await addIntegration(testDir, 'claude');
    await addIntegration(testDir, 'gemini');
    await removeIntegration(testDir, 'claude');
    expect(state()['default_integration']).toBe('gemini');
  });

  test('throws when not installed / unknown', async () => {
    await expect(removeIntegration(testDir, 'gemini')).rejects.toThrow('is not installed');
    await expect(removeIntegration(testDir, 'nope')).rejects.toThrow('Unknown integration');
  });
});
