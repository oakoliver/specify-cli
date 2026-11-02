/**
 * ``specify event run``: piped stdin handling, 1 MiB byte cap, UTF-8
 * validation, TTY fallback, argument parsing. Port of
 * tests/specify_cli/events/test_command_run.py.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_STDIN_BYTES, runEventCommand, type EventRunDeps } from '../src/events/commands.js';

interface Harness {
  deps: EventRunDeps;
  calls: Array<{ command: string; event: string; payload: string; root: string; timeout: number | undefined }>;
  out: string[];
  err: string[];
}

const PROJECT = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-event-run-')));
afterAll(() => rmSync(PROJECT, { recursive: true, force: true }));

function harness(opts: { tty?: boolean; stdin?: Uint8Array | string; code?: number; cwd?: string } = {}): Harness {
  const calls: Harness['calls'] = [];
  const out: string[] = [];
  const err: string[] = [];
  const raw = typeof opts.stdin === 'string' ? Buffer.from(opts.stdin, 'utf8') : (opts.stdin ?? new Uint8Array());
  const deps: EventRunDeps = {
    stdinIsTTY: () => opts.tty ?? false,
    readStdin: async (limit) => raw.subarray(0, limit),
    cwd: () => opts.cwd ?? PROJECT,
    resolveAndRun: (command, event, payload, root, runOpts) => {
      calls.push({ command, event, payload, root, timeout: runOpts.timeout });
      return opts.code ?? 0;
    },
    writeOut: (t) => out.push(t),
    writeErr: (t) => err.push(t),
  };
  return { deps, calls, out, err };
}

describe('specify event run', () => {
  test('reads piped stdin payload intact', async () => {
    const h = harness({ stdin: '{"key": "value"}' });
    expect(await runEventCommand(['run', 'some-command', 'session_start'], h.deps)).toBe(0);
    expect(h.calls).toEqual([
      { command: 'some-command', event: 'session_start', payload: '{"key": "value"}', root: PROJECT, timeout: 120 },
    ]);
  });

  test('empty pipe forwards an empty payload', async () => {
    const h = harness({ stdin: '' });
    expect(await runEventCommand(['run', 'some-command', 'session_start'], h.deps)).toBe(0);
    expect(h.calls[0]!.payload).toBe('');
  });

  test('TTY falls back to "{}"', async () => {
    const h = harness({ tty: true });
    expect(await runEventCommand(['run', 'some-command', 'session_start'], h.deps)).toBe(0);
    expect(h.calls[0]!.payload).toBe('{}');
  });

  test('oversized stdin reports a clean error', async () => {
    const h = harness({ stdin: 'x'.repeat(MAX_STDIN_BYTES + 10) });
    expect(await runEventCommand(['run', 'some-command', 'session_start'], h.deps)).toBe(1);
    expect(h.err.join('')).toBe('stdin payload exceeds 1 MiB limit; truncate or pipe a smaller payload\n');
    expect(h.calls).toHaveLength(0);
  });

  test('exactly 1 MiB is accepted', async () => {
    const h = harness({ stdin: 'x'.repeat(MAX_STDIN_BYTES) });
    expect(await runEventCommand(['run', 'c', 'stop'], h.deps)).toBe(0);
    expect(h.calls[0]!.payload.length).toBe(MAX_STDIN_BYTES);
  });

  test('invalid UTF-8 reports a clean error', async () => {
    const h = harness({ stdin: new Uint8Array([0xff, 0xfe]) });
    expect(await runEventCommand(['run', 'some-command', 'session_start'], h.deps)).toBe(1);
    expect(h.err.join('')).toContain('must be valid UTF-8');
    expect(h.calls).toHaveLength(0);
  });

  test('multibyte payload enforces the byte limit', async () => {
    const oversized = '\u{1F600}'.repeat(300_000);
    expect([...oversized].length).toBeLessThan(MAX_STDIN_BYTES);
    const h = harness({ stdin: oversized });
    expect(await runEventCommand(['run', 'some-command', 'session_start'], h.deps)).toBe(1);
    expect(h.err.join('')).toContain('1 MiB limit');
  });

  test('timeout argument and exit code pass-through', async () => {
    const h = harness({ tty: true, code: 7 });
    expect(await runEventCommand(['run', 'cmd', 'stop', '300'], h.deps)).toBe(7);
    expect(h.calls[0]!.timeout).toBe(300);
  });

  test('usage errors exit 2', async () => {
    let h = harness({ tty: true });
    expect(await runEventCommand(['run', 'cmd', 'stop', 'abc'], h.deps)).toBe(2);
    expect(h.err.join('')).toContain("Invalid value for 'timeout': 'abc' is not a valid int.");
    h = harness({ tty: true });
    expect(await runEventCommand(['run', 'cmd'], h.deps)).toBe(2);
    expect(h.err.join('')).toContain("Missing argument 'event_name'.");
    h = harness();
    expect(await runEventCommand([], h.deps)).toBe(2);
    expect(h.err.join('')).toContain('Missing command.');
    h = harness();
    expect(await runEventCommand(['bogus'], h.deps)).toBe(2);
    expect(h.err.join('')).toContain("No such command 'bogus'.");
    expect(h.calls).toHaveLength(0);
  });

  test('--help prints usage', async () => {
    const h = harness();
    expect(await runEventCommand(['run', '--help'], h.deps)).toBe(0);
    expect(h.out.join('')).toContain('Usage: specify event run [OPTIONS] {command_name} {event_name} [timeout]');
    const g = harness();
    expect(await runEventCommand(['--help'], g.deps)).toBe(0);
    expect(g.out.join('')).toContain('Manage and execute event-driven commands');
  });
});

// v1.2.5 (#4934): persisted symlink policy is validated before the handler runs.
describe('event run project policy', () => {
  const fresh = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'speckit-event-policy-')));

  for (const options of [null, {}, { allow_symlinks: false }, { allow_symlinks: true }]) {
    test(`accepts missing or valid configuration ${JSON.stringify(options)}`, async () => {
      const root = fresh();
      if (options !== null) {
        mkdirSync(join(root, '.specify'));
        writeFileSync(join(root, '.specify/init-options.json'), JSON.stringify(options));
      }
      const h = harness({ stdin: '{}', cwd: root });
      expect(await runEventCommand(['run', 'test', 'session_start'], h.deps)).toBe(0);
      expect(h.calls[0]!.root).toBe(root);
      rmSync(root, { recursive: true, force: true });
    });
  }

  for (const document of ['{', '[]', 'null', '{"allow_symlinks": "true"}', '{"allow_symlinks": 1}', '{"allow_symlinks": null}']) {
    test(`rejects invalid configuration before handler: ${document}`, async () => {
      const root = fresh();
      mkdirSync(join(root, '.specify'));
      writeFileSync(join(root, '.specify/init-options.json'), document);
      const h = harness({ stdin: '{}', cwd: root });
      expect(await runEventCommand(['run', 'test', 'session_start'], h.deps)).toBe(1);
      expect(h.err.join('')).toContain('init-options.json');
      expect(h.calls).toHaveLength(0);
      rmSync(root, { recursive: true, force: true });
    });
  }

  for (const [leaf, dangling] of [[false, false], [false, true], [true, false], [true, true]] as const) {
    test(`denies bootstrap links before handler (leaf=${leaf}, dangling=${dangling})`, async () => {
      const root = fresh();
      const target = join(root, 'target');
      let marker: string;
      if (leaf) {
        mkdirSync(join(root, '.specify'));
        if (!dangling) writeFileSync(target, '{"allow_symlinks": true}');
        marker = join(root, '.specify/init-options.json');
      } else {
        if (!dangling) {
          mkdirSync(target);
          writeFileSync(join(target, 'init-options.json'), '{"allow_symlinks": true}');
        }
        marker = join(root, '.specify');
      }
      symlinkSync(target, marker, leaf ? 'file' : 'dir');
      const h = harness({ stdin: '{}', cwd: root });
      expect(await runEventCommand(['run', 'test', 'session_start'], h.deps)).toBe(1);
      expect(h.err.join('')).toContain('symlink');
      expect(h.calls).toHaveLength(0);
      rmSync(root, { recursive: true, force: true });
    });
  }
});
