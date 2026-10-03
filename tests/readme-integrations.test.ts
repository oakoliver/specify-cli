/**
 * The README's integration table must describe what `specify init` really
 * installs: for every integration, init a project with its default options and
 * check the files land in the documented directory, in the documented format.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { INTEGRATION_REGISTRY } from '../src/integrations/index.js';

const root = join(import.meta.dir, '..');
const cli = join(root, 'src', 'cli.ts');
const work = mkdtempSync(join(tmpdir(), 'specify-readme-integrations-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Row { key: string; dir: string; format: string }

const rows: Row[] = [];
for (const m of readFileSync(join(root, 'README.md'), 'utf8').matchAll(/^\| ([a-z0-9-]+) \| [^|]+ \| `([^`]+)` \| ([^|]+) \|$/gm)) {
  rows.push({ key: m[1], dir: m[2], format: m[3].trim() });
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const formats: Record<string, (f: string) => boolean> = {
  'SKILL.md': (f) => f.endsWith('/SKILL.md'),
  Markdown: (f) => /\.mdc?$/.test(f) && !f.endsWith('/SKILL.md'), // .mdc: Markdown with rule frontmatter
  TOML: (f) => f.endsWith('.toml'),
  YAML: (f) => /\.ya?ml$/.test(f),
};

describe('README integration table', () => {
  test('lists every registered integration once', () => {
    expect(rows.map((r) => r.key).sort()).toEqual(Object.keys(INTEGRATION_REGISTRY).sort());
  });

  // generic needs --commands-dir, which the table documents instead of a directory.
  for (const row of rows.filter((r) => r.key !== 'generic')) {
    test(`${row.key} installs ${row.format} into ${row.dir}`, () => {
      const home = join(work, `home-${row.key}`);
      const proc = Bun.spawnSync(
        ['bun', cli, 'init', row.key, '--integration', row.key, '--non-interactive', '--ignore-agent-tools'],
        { cwd: work, env: { ...process.env, HOME: home, NO_COLOR: '1' } },
      );
      expect(proc.exitCode).toBe(0);

      const dir = row.dir.startsWith('~/') ? join(home, row.dir.slice(2)) : join(work, row.key, row.dir);
      const installed = files(dir).filter((f) => /speckit/.test(f));
      expect(installed.length).toBeGreaterThan(0);
      expect(formats[row.format]).toBeDefined();
      expect(installed.filter((f) => !formats[row.format](f))).toEqual([]);
    }, 60_000);
  }
});
