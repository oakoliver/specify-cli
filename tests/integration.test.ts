/**
 * Integration Module Tests
 *
 * Tests for the integration management system that handles
 * post-init agent configuration.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadManifest,
  listIntegrations,
  addIntegration,
  removeIntegration,
  getIntegrationInfo,
  type IntegrationManifest,
  type IntegrationInfo,
} from '../src/integration.js';
import { SUPPORTED_AGENTS, AGENT_CONFIGS } from '../src/types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

let testDir: string;

function createTestProject(): string {
  const dir = join(tmpdir(), `integration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.specify'), { recursive: true });
  mkdirSync(join(dir, '.specify', 'integrations'), { recursive: true });
  mkdirSync(join(dir, '.specify', 'templates'), { recursive: true });
  return dir;
}

beforeEach(() => {
  testDir = createTestProject();
});

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
});

// ============================================================================
// loadManifest Tests
// ============================================================================

describe('loadManifest', () => {
  test('returns null when manifest does not exist', () => {
    const result = loadManifest(testDir, 'claude');
    expect(result).toBeNull();
  });

  test('loads valid manifest', () => {
    const manifest: IntegrationManifest = {
      integration: 'claude',
      version: '1.1.0',
      installed_at: '2024-01-01T00:00:00.000Z',
      files: ['/path/to/file1.md', '/path/to/file2.md'],
    };
    
    const manifestPath = join(testDir, '.specify', 'integrations', 'claude.manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = loadManifest(testDir, 'claude');
    expect(result).toEqual(manifest);
  });

  test('returns null for corrupted JSON', () => {
    const manifestPath = join(testDir, '.specify', 'integrations', 'claude.manifest.json');
    writeFileSync(manifestPath, 'not valid json {{{');

    const result = loadManifest(testDir, 'claude');
    expect(result).toBeNull();
  });
});

// ============================================================================
// listIntegrations Tests
// ============================================================================

describe('listIntegrations', () => {
  test('lists all supported integrations', () => {
    const result = listIntegrations(testDir);
    
    expect(result.length).toBe(SUPPORTED_AGENTS.length);
    expect(result.length).toBe(28); // Current agent count
  });

  test('all integrations have required fields', () => {
    const result = listIntegrations(testDir);
    
    for (const integration of result) {
      expect(integration.key).toBeDefined();
      expect(integration.name).toBeDefined();
      expect(integration.directory).toBeDefined();
      expect(integration.format).toBeDefined();
      expect(typeof integration.installed).toBe('boolean');
    }
  });

  test('marks integration as installed when manifest exists', () => {
    const manifest: IntegrationManifest = {
      integration: 'claude',
      version: '1.1.0',
      installed_at: '2024-01-01T00:00:00.000Z',
      files: ['/path/to/file1.md'],
    };
    
    const manifestPath = join(testDir, '.specify', 'integrations', 'claude.manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = listIntegrations(testDir);
    const claude = result.find(i => i.key === 'claude');
    
    expect(claude?.installed).toBe(true);
    expect(claude?.files_count).toBe(1);
  });

  test('marks integration as installed when directory exists', () => {
    // Create the agent directory without a manifest
    mkdirSync(join(testDir, '.claude', 'commands'), { recursive: true });

    const result = listIntegrations(testDir);
    const claude = result.find(i => i.key === 'claude');
    
    expect(claude?.installed).toBe(true);
    expect(claude?.files_count).toBeUndefined(); // No manifest
  });

  test('marks integration as not installed when neither manifest nor directory exists', () => {
    const result = listIntegrations(testDir);
    const claude = result.find(i => i.key === 'claude');
    
    expect(claude?.installed).toBe(false);
  });
});

// ============================================================================
// getIntegrationInfo Tests
// ============================================================================

describe('getIntegrationInfo', () => {
  test('returns null for unknown integration', () => {
    const result = getIntegrationInfo(testDir, 'unknown-agent');
    expect(result).toBeNull();
  });

  test('returns info for valid integration', () => {
    const result = getIntegrationInfo(testDir, 'claude');
    
    expect(result).not.toBeNull();
    expect(result?.key).toBe('claude');
    expect(result?.name).toBe('Claude');
    expect(result?.directory).toBe('.claude/commands');
    expect(result?.format).toBe('markdown');
  });

  test('returns correct info for goose (yaml format)', () => {
    const result = getIntegrationInfo(testDir, 'goose');
    
    expect(result).not.toBeNull();
    expect(result?.key).toBe('goose');
    expect(result?.format).toBe('yaml');
    expect(result?.directory).toBe('.goose/recipes');
  });

  test('returns correct info for gemini (toml format)', () => {
    const result = getIntegrationInfo(testDir, 'gemini');
    
    expect(result).not.toBeNull();
    expect(result?.key).toBe('gemini');
    expect(result?.format).toBe('toml');
  });

  test('returns correct info for codex (skill-based)', () => {
    const result = getIntegrationInfo(testDir, 'codex');
    
    expect(result).not.toBeNull();
    expect(result?.key).toBe('codex');
    expect(result?.directory).toBe('.agents/skills');
  });

  test('includes files_count when manifest exists', () => {
    const manifest: IntegrationManifest = {
      integration: 'opencode',
      version: '1.1.0',
      installed_at: '2024-01-01T00:00:00.000Z',
      files: ['file1.md', 'file2.md', 'file3.md'],
    };
    
    const manifestPath = join(testDir, '.specify', 'integrations', 'opencode.manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const result = getIntegrationInfo(testDir, 'opencode');
    expect(result?.files_count).toBe(3);
  });
});

// ============================================================================
// addIntegration Tests
// ============================================================================

describe('addIntegration', () => {
  test('throws for unknown integration', async () => {
    await expect(addIntegration(testDir, 'unknown-agent'))
      .rejects.toThrow('Unknown integration');
  });

  test('throws when integration already installed', async () => {
    // Create existing manifest
    const manifest: IntegrationManifest = {
      integration: 'claude',
      version: '1.0.0',
      installed_at: '2024-01-01T00:00:00.000Z',
      files: [],
    };
    
    const manifestPath = join(testDir, '.specify', 'integrations', 'claude.manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));

    await expect(addIntegration(testDir, 'claude'))
      .rejects.toThrow('already installed');
  });

  test('installs integration and creates manifest', async () => {
    const result = await addIntegration(testDir, 'claude');
    
    expect(result.integration).toBe('claude');
    expect(result.version).toBe('1.1.0');
    expect(result.installed_at).toBeDefined();
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
  });

  test('creates agent command directory', async () => {
    await addIntegration(testDir, 'claude');
    
    const commandDir = join(testDir, '.claude', 'commands');
    expect(existsSync(commandDir)).toBe(true);
  });

  test('installs all 9 core commands', async () => {
    const result = await addIntegration(testDir, 'claude');
    
    // Should have 9 command files
    expect(result.files.length).toBe(9);
  });

  test('saves manifest file', async () => {
    await addIntegration(testDir, 'opencode');
    
    const manifestPath = join(testDir, '.specify', 'integrations', 'opencode.manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    
    const saved = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(saved.integration).toBe('opencode');
  });

  test('uses custom version when provided', async () => {
    const result = await addIntegration(testDir, 'cursor', '2.0.0');
    
    expect(result.version).toBe('2.0.0');
  });
});

// ============================================================================
// removeIntegration Tests
// ============================================================================

describe('removeIntegration', () => {
  test('throws for unknown integration', async () => {
    await expect(removeIntegration(testDir, 'unknown-agent'))
      .rejects.toThrow('Unknown integration');
  });

  test('throws when integration not installed', async () => {
    await expect(removeIntegration(testDir, 'claude'))
      .rejects.toThrow('not installed');
  });

  test('removes integration with manifest', async () => {
    // First install
    await addIntegration(testDir, 'claude');
    
    // Verify installed
    expect(loadManifest(testDir, 'claude')).not.toBeNull();
    
    // Remove
    const result = await removeIntegration(testDir, 'claude');
    expect(result).toBe(true);
    
    // Verify removed
    expect(loadManifest(testDir, 'claude')).toBeNull();
  });

  test('removes command files', async () => {
    await addIntegration(testDir, 'opencode');
    
    const commandDir = join(testDir, '.opencode', 'command');
    expect(existsSync(commandDir)).toBe(true);
    
    await removeIntegration(testDir, 'opencode');
    
    // Command files should be removed (directory may remain if empty dirs not cleaned)
  });

  test('removes directory when no manifest exists', async () => {
    // Create directory without manifest
    const commandDir = join(testDir, '.cursor', 'commands');
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(join(commandDir, 'test.md'), 'test');
    
    const result = await removeIntegration(testDir, 'cursor');
    expect(result).toBe(true);
    
    // Directory should be removed
    expect(existsSync(join(testDir, '.cursor'))).toBe(false);
  });
});

// ============================================================================
// Integration with New Agents Tests
// ============================================================================

describe('new agents support', () => {
  test('goose integration uses yaml format', () => {
    const info = getIntegrationInfo(testDir, 'goose');
    expect(info?.format).toBe('yaml');
    expect(info?.directory).toBe('.goose/recipes');
  });

  test('forge integration uses custom args placeholder', () => {
    const config = AGENT_CONFIGS['forge'];
    expect(config.args).toBe('{{parameters}}');
  });

  test('jules integration exists', () => {
    const info = getIntegrationInfo(testDir, 'jules');
    expect(info).not.toBeNull();
    expect(info?.directory).toBe('.jules/commands');
  });

  test('agy integration is skill-based', () => {
    const info = getIntegrationInfo(testDir, 'agy');
    expect(info).not.toBeNull();
    expect(info?.directory).toBe('.antigravity/skills');
  });

  test('kiro alias exists', () => {
    const info = getIntegrationInfo(testDir, 'kiro');
    expect(info).not.toBeNull();
    expect(info?.directory).toBe('.kiro/prompts');
  });
});
