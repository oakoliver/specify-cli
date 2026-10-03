/**
 * Tests for the CLI commands that read init-options.json (status, doctor).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const cli = join(import.meta.dir, '..', 'src', 'cli.ts');

function specify(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(['bun', cli, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1', COLUMNS: '100' },
  });
  // Strip ANSI so assertions don't depend on styling.
  return (proc.stdout.toString() + proc.stderr.toString()).replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, '');
}

function init(cwd: string, ...extra: string[]): string {
  specify(cwd, 'init', 'demo', '--integration', 'claude', '--non-interactive', '--ignore-agent-tools', ...extra);
  return join(cwd, 'demo');
}

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `specify-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe('status and doctor read init-options.json', () => {
  test('report the integration and script type chosen at init', () => {
    const project = init(testDir, '--script', 'ps');

    const status = specify(project, 'status');
    expect(status).toMatch(/Integration:\s+claude/);
    expect(status).toMatch(/Scripts:\s+ps/);

    expect(specify(project, 'doctor')).toContain('Init options: integration=claude, script=ps');
  }, 60_000);

  test('doctor warns when init-options.json is missing', () => {
    const project = init(testDir);
    rmSync(join(project, '.specify', 'init-options.json'));

    expect(specify(project, 'doctor')).toContain('No .specify/init-options.json found');
    expect(specify(project, 'status')).toMatch(/Initialized:\s+unknown/);
  }, 60_000);
});
