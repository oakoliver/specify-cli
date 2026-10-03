import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

// Runs printBanner with stdout piped, as `specify check | less` does.
function bannerOutput(env: Record<string, string | undefined>): string {
  const proc = Bun.spawnSync(
    ['bun', '-e', "import { printBanner } from './src/ui.ts'; await printBanner();"],
    { cwd: root, env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined, ...env } },
  );
  return proc.stdout.toString();
}

describe('banner colour', () => {
  test('is plain when stdout is not a terminal', () => {
    const out = bannerOutput({});
    expect(out).not.toContain('\x1b[');
    expect(out).toContain('/');
  });

  test('FORCE_COLOR keeps the gradient when piped', () => {
    expect(bannerOutput({ FORCE_COLOR: '1' })).toContain('\x1b[');
  });

  test('NO_COLOR wins over FORCE_COLOR', () => {
    expect(bannerOutput({ FORCE_COLOR: '1', NO_COLOR: '1' })).not.toContain('\x1b[');
  });
});
