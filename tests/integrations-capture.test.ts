/**
 * Bounded capture of an integration CLI's output (port of upstream
 * ``tests/integrations/test_capture.py`` from #4957). POSIX-only cases use
 * ``/bin/sh``; the Windows job-object cases have no equivalent here.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CAPTURE_MAX_BYTES,
  cancelCaptures,
  captureMaxBytesIsValid,
  decodeCaptured,
  runCaptured,
} from '../src/integrations/capture.js';
import { getIntegration } from '../src/integrations/index.js';

const sh = (script: string): string[] => ['/bin/sh', '-c', script];
const posix = process.platform !== 'win32';

describe('runCaptured', () => {
  test('test_captures_both_streams_and_exit_code', async () => {
    const r = await runCaptured(sh('printf out; printf err >&2; exit 3'));
    expect(r).toEqual({
      exit_code: 3,
      stdout: 'out',
      stderr: 'err',
      stdout_truncated: false,
      stderr_truncated: false,
      timed_out: false,
      interrupted: false,
    });
  });

  test('test_default_limit_is_one_mebibyte', () => {
    expect(DEFAULT_CAPTURE_MAX_BYTES).toBe(1024 * 1024);
  });

  test('test_finite_limit_truncates_only_the_stream_that_exceeds_it', async () => {
    const r = await runCaptured(sh('printf 0123456789; printf ab >&2'), { maxBytes: 4 });
    expect([r.stdout, r.stdout_truncated, r.stderr, r.stderr_truncated]).toEqual(['0123', true, 'ab', false]);
  });

  test('test_output_exactly_at_the_limit_is_not_truncated', async () => {
    const r = await runCaptured(sh('printf abcd'), { maxBytes: 4 });
    expect([r.stdout, r.stdout_truncated]).toEqual(['abcd', false]);
  });

  test('test_unlimited_capture_retains_everything_without_flags', async () => {
    const r = await runCaptured(sh('head -c 300000 /dev/zero | tr "\\0" x'), { maxBytes: -1 });
    expect(r.stdout.length).toBe(300000);
    expect(r.stdout_truncated).toBe(false);
  });

  test('test_limit_counts_raw_bytes_and_drops_a_split_character', async () => {
    // "é" is two bytes; a 3-byte cap keeps "a" + "é" ... a 2-byte cap splits it.
    const r = await runCaptured(sh("printf 'aé'"), { maxBytes: 2 });
    expect([r.stdout, r.stdout_truncated]).toEqual(['a', true]);
  });

  test('test_invalid_utf8_is_replaced', async () => {
    const r = await runCaptured(sh("printf 'a\\377b'"));
    expect(r.stdout).toBe('a�b');
  });

  test('test_complete_output_ending_mid_character_is_replaced_not_dropped', () => {
    expect(decodeCaptured(Buffer.from([0x61, 0xc3]), true)).toBe('a�');
    expect(decodeCaptured(Buffer.from([0x61, 0xc3]), false)).toBe('a');
  });

  test('test_line_endings_are_normalised', async () => {
    const r = await runCaptured(sh("printf 'a\\r\\nb\\rc'"));
    expect(r.stdout).toBe('a\nb\nc');
  });

  test.skipIf(!posix)('test_timeout_keeps_partial_output_and_is_not_size_truncation', async () => {
    const r = await runCaptured(sh('printf partial; sleep 5'), { timeout: 0.5 });
    expect(r).toMatchObject({ exit_code: -1, stdout: 'partial', timed_out: true, stdout_truncated: false, interrupted: false });
  });

  test.skipIf(!posix)('test_timeout_kills_descendants_and_stops_readers', async () => {
    const start = Date.now();
    const r = await runCaptured(sh('(sleep 30; echo late) & printf early; wait'), { timeout: 0.5 });
    expect(r.timed_out).toBe(true);
    expect(r.stdout).toBe('early');
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test.skipIf(!posix)('test_descendant_holding_the_pipes_after_exit_is_killed', async () => {
    const start = Date.now();
    const r = await runCaptured(sh('(sleep 30) & printf done'), { timeout: 0.7 });
    expect(r.stdout).toBe('done');
    expect(r.timed_out).toBe(true);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  test.skipIf(!posix)('test_running_capture_is_killed_and_reports_interrupted', async () => {
    const pending = runCaptured(sh('printf before; sleep 30'));
    await new Promise((r) => setTimeout(r, 300));
    const release = cancelCaptures();
    let r;
    try {
      r = await pending;
    } finally {
      release();
    }
    expect(r).toMatchObject({ exit_code: 130, stdout: 'before', interrupted: true, timed_out: false });
  });

  test.skipIf(!posix)('test_capture_started_while_cancelling_is_killed', async () => {
    const release = cancelCaptures();
    let r;
    try {
      r = await runCaptured(sh('sleep 30'));
    } finally {
      release();
    }
    expect(r.interrupted).toBe(true);
  });

  test('test_captures_after_the_block_run_normally', async () => {
    cancelCaptures()();
    const r = await runCaptured(sh('printf ok'));
    expect([r.stdout, r.interrupted]).toEqual(['ok', false]);
  });

  test('test_completed_process_is_not_killed', async () => {
    const r = await runCaptured(sh('exit 0'), { timeout: 10 });
    expect([r.exit_code, r.timed_out]).toEqual([0, false]);
  });

  test('test_invalid_limit_is_rejected_before_starting_a_process', async () => {
    for (const bad of [0, -2, 1.5, true]) {
      expect(captureMaxBytesIsValid(bad)).toBe(false);
      await expect(runCaptured(sh('exit 0'), { maxBytes: bad as number })).rejects.toThrow('max_bytes must be a positive integer or -1');
    }
  });

  test('test_missing_executable_raises_oserror', async () => {
    await expect(runCaptured(['/nonexistent/speckit-cli'])).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('dispatchCommand capture keywords', () => {
  let dir: string;
  const savedPath = process.env.PATH;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'speckit-capture-'));
    const fake = join(dir, 'claude');
    writeFileSync(fake, '#!/bin/sh\nprintf "%s|" "$@"\nprintf warn >&2\n');
    chmodSync(fake, 0o755);
    process.env.PATH = `${dir}:${savedPath}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  test.skipIf(!posix)('test_bounded_capture_returns_text_and_completeness_fields', async () => {
    const r = await getIntegration('claude')!.dispatchCommand('speckit.plan', {
      args: 'go',
      projectRoot: dir,
      stream: false,
      outputJson: false,
      captureMaxBytes: 1024,
    });
    expect(r.stdout).not.toContain('--output-format');
    expect(r.stderr).toBe('warn');
    expect(r.stdout_truncated).toBe(false);
    expect(r.timed_out).toBe(false);
  });

  test.skipIf(!posix)('test_existing_captured_callers_keep_json_format', () => {
    const r = getIntegration('claude')!.dispatchCommand('speckit.plan', 'go', { projectRoot: dir, stream: false });
    expect(r.stdout).toContain('--output-format|json');
  });

  test('test_capture_limit_with_streaming_is_rejected', () => {
    expect(() =>
      getIntegration('claude')!.dispatchCommand('speckit.plan', { stream: true, captureMaxBytes: 10 }),
    ).toThrow('capture_max_bytes requires stream=False.');
    expect(() =>
      getIntegration('copilot')!.dispatchCommand('speckit.plan', { stream: true, captureMaxBytes: 10 }),
    ).toThrow('capture_max_bytes requires stream=False.');
  });
});
