/**
 * @oakoliver/specify-cli - Bounded capture of an integration CLI's output
 *
 * Port of ``specify_cli/integrations/_capture.py`` (upstream #4957). Captured
 * workflow dispatch needs a per-stream byte cap, a fixed UTF-8 decoding, and
 * whatever was read before a timeout or interruption.
 *
 * ADAPTATION: upstream reads the pipes on threads and isolates the CLI in a
 * new session (POSIX) or a suspended-then-resumed job object (Windows). Node
 * reads pipes asynchronously; the CLI is spawned ``detached`` (a new process
 * group on POSIX, so the group can be killed) and, on Windows, the tree is
 * killed with ``taskkill /T /F``. The kill boundary is the same: a helper
 * that leaves the group survives.
 *
 * @module integrations/capture
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export const DEFAULT_CAPTURE_MAX_BYTES = 1024 * 1024;
export const UNLIMITED_CAPTURE = -1;
const DRAIN_GRACE_MS = 2000;

/** Whether *value* is a positive int or ``-1`` (unlimited); booleans are rejected. */
export function captureMaxBytesIsValid(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  return value > 0 || value === UNLIMITED_CAPTURE;
}

/** Outcome of one captured process. */
export interface CapturedProcess {
  exit_code: number;
  stdout: string;
  stderr: string;
  /** Size-based truncation only; a stopped process is reported separately. */
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  timed_out: boolean;
  interrupted: boolean;
}

/** Retain at most *limit* bytes of a stream; count the rest as truncated. */
class Sink {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly limit: number) {}

  feed(chunk: Buffer): void {
    let data = chunk;
    if (this.limit !== UNLIMITED_CAPTURE) {
      const room = this.limit - this.size;
      if (data.length > room) {
        this.truncated = true;
        data = data.subarray(0, Math.max(0, room));
      }
    }
    if (data.length) {
      this.chunks.push(data);
      this.size += data.length;
    }
  }

  snapshot(): [Buffer, boolean] {
    return [Buffer.concat(this.chunks), this.truncated];
  }
}

/**
 * Decode captured bytes as UTF-8, replacing invalid sequences with U+FFFD.
 * When the capture is not *complete*, a trailing partial multibyte sequence
 * is dropped rather than replaced. Line endings are normalised to ``\n``.
 */
export function decodeCaptured(data: Buffer, complete: boolean): string {
  let bytes = data;
  if (!complete) bytes = data.subarray(0, data.length - incompleteTail(data));
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Length of a trailing, still-valid-so-far partial UTF-8 sequence. */
function incompleteTail(data: Buffer): number {
  const n = data.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = data[n - back] as number;
    if ((b & 0xc0) === 0x80) continue; // continuation byte, keep looking
    const need = b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xc2 && b <= 0xdf ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

/** A running capture that can be killed with its process group. */
class ProcessTree {
  interrupted = false;
  constructor(readonly proc: ChildProcess) {}

  sendKill(): void {
    const pid = this.proc.pid;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // group already gone
      }
    }
    try {
      this.proc.kill('SIGKILL');
    } catch {
      // already exited
    }
  }

  /** Kill the process group from elsewhere; the capture reports ``interrupted``. */
  interrupt(): void {
    this.interrupted = true;
    this.sendKill();
  }
}

const active = new Set<ProcessTree>();
let cancelling = 0;

/**
 * Kill every running capture, and any that starts, until the returned
 * release function is called (upstream's ``cancel_captures()`` context).
 */
export function cancelCaptures(): () => void {
  cancelling += 1;
  for (const tree of [...active]) tree.interrupt();
  let released = false;
  return () => {
    if (!released) {
      released = true;
      cancelling -= 1;
    }
  };
}

/** Raised when *maxBytes* is invalid. */
export class CaptureValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/**
 * Run *args* and capture stdout and stderr, each capped at *maxBytes* (raw
 * bytes before decoding; ``-1`` disables the cap). A timeout or Ctrl+C kills
 * the process group and is reported on the result (exit code ``-1`` or
 * ``130``) with the output read so far. A spawn ``OSError`` rejects.
 */
export function runCaptured(
  args: readonly string[],
  opts: { cwd?: string | null; timeout?: number | null; maxBytes?: number } = {},
): Promise<CapturedProcess> {
  const maxBytes = opts.maxBytes ?? DEFAULT_CAPTURE_MAX_BYTES;
  if (!captureMaxBytesIsValid(maxBytes)) {
    return Promise.reject(new CaptureValueError(`max_bytes must be a positive integer or -1, got ${String(maxBytes)}.`));
  }
  return new Promise((resolve, reject) => {
    const sinks = [new Sink(maxBytes), new Sink(maxBytes)] as const;
    let proc: ChildProcess;
    try {
      proc = spawn(args[0] as string, args.slice(1), {
        cwd: opts.cwd ?? undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (exc) {
      reject(exc);
      return;
    }
    const tree = new ProcessTree(proc);
    let timedOut = false;
    let exited: number | null = null;
    let streamsOpen = 2;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const onSigint = (): void => {
      tree.interrupt();
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      process.removeListener('SIGINT', onSigint);
      active.delete(tree);
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      const interrupted = tree.interrupted;
      const stopped = timedOut || interrupted;
      const [out, outTrunc] = sinks[0].snapshot();
      const [err, errTrunc] = sinks[1].snapshot();
      resolve({
        exit_code: interrupted ? 130 : timedOut ? -1 : (exited ?? -1),
        stdout: decodeCaptured(out, !(stopped || outTrunc)),
        stderr: decodeCaptured(err, !(stopped || errTrunc)),
        stdout_truncated: outTrunc,
        stderr_truncated: errTrunc,
        timed_out: interrupted ? false : timedOut,
        interrupted,
      });
    };

    const stop = (): void => {
      tree.sendKill();
      // Give the readers a short grace to drain what is already buffered.
      graceTimer = setTimeout(finish, DRAIN_GRACE_MS);
    };

    proc.on('error', (exc) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.removeListener('SIGINT', onSigint);
      active.delete(tree);
      reject(exc);
    });
    // Ctrl+C reaches only this process (the CLI leads its own group): kill the
    // group and report the capture as interrupted.
    process.on('SIGINT', onSigint);
    active.add(tree);
    if (cancelling > 0) tree.interrupt();

    const streamDone = (): void => {
      streamsOpen -= 1;
      if (streamsOpen === 0 && exited !== null) finish();
    };
    proc.stdout?.on('data', (d: Buffer) => sinks[0].feed(d));
    proc.stderr?.on('data', (d: Buffer) => sinks[1].feed(d));
    proc.stdout?.on('close', streamDone);
    proc.stderr?.on('close', streamDone);
    proc.on('exit', (code, signal) => {
      exited = code !== null ? code : signal ? -1 : -1;
      if (streamsOpen === 0) {
        finish();
        return;
      }
      // Stopped, but a descendant may still hold the pipes: kill the group
      // and allow the drain grace.
      if ((tree.interrupted || timedOut) && !graceTimer) stop();
    });
    if (opts.timeout !== null && opts.timeout !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, Math.min(opts.timeout * 1000, 2 ** 31 - 1));
    }
  });
}

/** The ``dispatch_command`` result dict for a captured process. */
export function asDispatchResult(captured: CapturedProcess): CapturedProcess {
  return { ...captured };
}
