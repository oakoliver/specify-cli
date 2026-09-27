/**
 * Bundler project detection (port of bundles/project.py behaviors).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { BundlerError } from '../src/bundles/index.js';
import { activeIntegration, findProjectRoot, requireProjectRoot } from '../src/bundles/project.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'bundles-project-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ============================================================================
// project
// ============================================================================

describe('project', () => {
  const savedEnv = process.env.SPECIFY_INIT_DIR;
  beforeEach(() => {
    delete process.env.SPECIFY_INIT_DIR;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SPECIFY_INIT_DIR;
    else process.env.SPECIFY_INIT_DIR = savedEnv;
  });

  test('findProjectRoot walks up; requireProjectRoot errors', () => {
    const root = path.join(tmp, 'proj');
    mkdirSync(path.join(root, '.specify'), { recursive: true });
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    expect(findProjectRoot(path.join(root, 'a', 'b'))).toBe(findProjectRoot(root)!);
    const bare = path.join(tmp, 'bare');
    mkdirSync(bare);
    expect(() => requireProjectRoot(bare)).toThrow('Not a Spec Kit project (no .specify/ directory).');
  });

  test('activeIntegration prefers default_integration', () => {
    mkdirSync(path.join(tmp, '.specify'));
    const marker = path.join(tmp, '.specify', 'integration.json');
    writeFileSync(marker, JSON.stringify({ integration: 'copilot', default_integration: 'claude' }));
    expect(activeIntegration(tmp)).toBe('claude');
    writeFileSync(marker, JSON.stringify({ default_integration: 'gemini' }));
    expect(activeIntegration(tmp)).toBe('gemini');
    writeFileSync(marker, JSON.stringify({ integration: 'copilot' }));
    expect(activeIntegration(tmp)).toBe('copilot');
    writeFileSync(marker, 'not json');
    expect(activeIntegration(tmp)).toBeNull();
  });

  test('activeIntegration absent -> null', () => {
    expect(activeIntegration(tmp)).toBeNull();
  });
});
