/**
 * @oakoliver/specify-cli - Root CLI wiring tests (spec-kit v1.0.12 parity)
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_APP } from '../src/cli.ts';
import { UPSTREAM_SPEC_KIT_VERSION } from '../src/version.ts';
import pkg from '../package.json';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
function run(args: string[], cwd?: string) {
  const r = spawnSync('bun', [CLI, ...args], { cwd, encoding: 'utf-8', env: { ...process.env, NO_COLOR: '1', COLUMNS: '120' } });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('root app', () => {
  test('registers every upstream v1.0.12 command in upstream order', () => {
    const names = ROOT_APP.commands.map((c) => c.name);
    expect(names.slice(0, 11)).toEqual([
      'init', 'check', 'version', 'self', 'extension', 'integration', 'event', 'preset', 'artifact', 'bundle', 'workflow',
    ]);
    expect(names).toContain('doctor');
    expect(names).toContain('status');
  });

  test('parity constant is 1.0.12', () => {
    expect(UPSTREAM_SPEC_KIT_VERSION).toBe('1.0.12');
  });

  test('--version prints package version', () => {
    const r = run(['--version']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`specify ${pkg.version}`);
  });

  test('--help lists commands', () => {
    const r = run(['--help']);
    expect(r.code).toBe(0);
    for (const c of ['init', 'workflow', 'bundle', 'artifact', 'event', 'self']) expect(r.out).toContain(c);
  });

  test('unknown command exits 2 with Typer wording', () => {
    const r = run(['nope']);
    expect(r.code).toBe(2);
    expect(r.err).toContain("No such command 'nope'.");
  });

  test('removed legacy --ai flag is rejected', () => {
    const r = run(['init', 'x', '--ai', 'claude']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('No such option');
  });

  test('init + status + doctor end to end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'specify-cli-'));
    try {
      const i = run(['init', '--here', '--force', '--non-interactive', '--integration', 'claude', '--script', 'sh', '--ignore-agent-tools'], dir);
      expect(i.code).toBe(0);
      expect(existsSync(join(dir, '.specify', 'integration.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, '.specify', 'integration.json'), 'utf-8')).integration).toBe('claude');
      const s = run(['status'], dir);
      expect(s.code).toBe(0);
      expect(s.out).toContain('claude');
      const d = run(['doctor'], dir);
      expect(d.out).toContain('Spec Kit Doctor');
      const il = run(['integration', 'list'], dir);
      expect(il.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
