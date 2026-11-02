/**
 * @oakoliver/specify-cli - Shell Step
 *
 * Port of ``specify_cli/workflows/step/shell/__init__.py``: run a local shell
 * command.
 *
 * @module workflows/step/shell
 */

import { spawn } from 'node:child_process';

import {
  StepBase,
  StepContext,
  StepResult,
  StepStatus,
  dget,
  dhas,
  pyRepr,
  pyStr,
  pyTypeName,
  stepIdRepr,
  universalNewlines,
  type Dict,
} from '../base.js';
import { evaluateExpression } from '../expressions.js';

/** Outcome of {@link runShell}. */
export interface ShellOutcome {
  kind: 'exited' | 'timeout' | 'oserror';
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: Error;
  /** Per-stream decode failures (upstream #5064), in stdout/stderr order. */
  decodeErrors?: string[];
}

/**
 * Strict UTF-8 decode with Python's ``UnicodeDecodeError`` text, or ``[null,
 * message]`` when the bytes are malformed. ADAPTATION: upstream decodes with
 * ``locale.getpreferredencoding(False)``; this port always uses UTF-8.
 */
export function decodeUtf8Strict(buf: Uint8Array): [string, null] | [null, string] {
  try {
    return [new TextDecoder('utf-8', { fatal: true }).decode(buf), null];
  } catch {
    // Locate the first malformed sequence to word the error like CPython.
  }
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const b = buf[i] as number;
    let need = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (b < 0x80) {
      i++;
      continue;
    } else if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      if (b === 0xe0) lo = 0xa0;
      if (b === 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      if (b === 0xf0) lo = 0x90;
      if (b === 0xf4) hi = 0x8f;
    } else {
      return [null, `'utf-8' codec can't decode byte 0x${b.toString(16).padStart(2, '0')} in position ${i}: invalid start byte`];
    }
    let k = 0;
    for (; k < need; k++) {
      const j = i + 1 + k;
      if (j >= n) {
        const where = k === 0 ? `byte 0x${b.toString(16).padStart(2, '0')} in position ${i}` : `bytes in position ${i}-${i + k}`;
        return [null, `'utf-8' codec can't decode ${where}: unexpected end of data`];
      }
      const c = buf[j] as number;
      const min = k === 0 ? lo : 0x80;
      const max = k === 0 ? hi : 0xbf;
      if (c < min || c > max) {
        const where = k === 0 ? `byte 0x${b.toString(16).padStart(2, '0')} in position ${i}` : `bytes in position ${i}-${i + k}`;
        return [null, `'utf-8' codec can't decode ${where}: invalid continuation byte`];
      }
    }
    i += need + 1;
  }
  return [null, "'utf-8' codec can't decode bytes: invalid data"];
}

/** Python ``OSError`` text for a Node spawn error (best effort). */
function osErrorText(exc: NodeJS.ErrnoException, cwd: string): string {
  if (exc.code === 'ENOENT') return `[Errno 2] No such file or directory: ${pyRepr(cwd)}`;
  if (exc.code === 'EACCES') return `[Errno 13] Permission denied: ${pyRepr(cwd)}`;
  if (exc.code === 'ENOTDIR') return `[Errno 20] Not a directory: ${pyRepr(cwd)}`;
  return exc.message;
}

/**
 * ``subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=...,
 * env=..., timeout=...)`` equivalent (asynchronous, so a concurrent fan-out
 * really runs shell items in parallel).
 */
export function runShell(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutSeconds: number },
): Promise<ShellOutcome> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const finish = (outcome: ShellOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        shell: true,
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (exc) {
      const e = exc as NodeJS.ErrnoException;
      resolve({ kind: 'oserror', exitCode: -1, stdout: '', stderr: osErrorText(e, opts.cwd), error: e });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({ kind: 'timeout', exitCode: -1, stdout: '', stderr: 'timeout' });
    }, Math.min(opts.timeoutSeconds * 1000, 2 ** 31 - 1));
    child.stdout?.on('data', (d: Buffer) => {
      stdoutChunks.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrChunks.push(d);
    });
    child.on('error', (exc: NodeJS.ErrnoException) => {
      finish({ kind: 'oserror', exitCode: -1, stdout: '', stderr: osErrorText(exc, opts.cwd), error: exc });
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) return;
      // Python reports a signal-terminated child as a negative return code.
      const exitCode = code !== null ? code : signal ? -(osSignalNumber(signal)) : -1;
      const decoded: Record<string, string> = { stdout: '', stderr: '' };
      const decodeErrors: string[] = [];
      for (const [name, chunks] of [
        ['stdout', stdoutChunks],
        ['stderr', stderrChunks],
      ] as const) {
        const [text, error] = decodeUtf8Strict(Buffer.concat(chunks));
        if (text !== null) decoded[name] = universalNewlines(text);
        else decodeErrors.push(`Shell command ${name} could not be decoded: ${error}`);
      }
      finish({
        kind: 'exited',
        exitCode,
        stdout: decoded.stdout as string,
        stderr: decoded.stderr as string,
        ...(decodeErrors.length ? { decodeErrors } : {}),
      });
    });
  });
}

function osSignalNumber(signal: NodeJS.Signals): number {
  const table: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGABRT: 6, SIGSEGV: 11, SIGPIPE: 13 };
  return table[signal] ?? 1;
}

/**
 * Run a local shell command (non-agent). Captures exit code and
 * stdout/stderr.
 */
export class ShellStep extends StepBase {
  static override typeKey = 'shell';

  async execute(config: Dict, context: StepContext): Promise<StepResult> {
    let runCmd: unknown = dget(config, 'run', '');
    if (typeof runCmd === 'string' && runCmd.includes('{{')) runCmd = evaluateExpression(runCmd, context);
    const command = pyStr(runCmd);

    const cwd = context.projectRoot || '.';
    const timeout = dget(config, 'timeout', 300);
    const timeoutError = ShellStep.timeoutError(config);
    if (timeoutError !== null) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: timeoutError,
        output: { exit_code: -1, stdout: '', stderr: 'invalid timeout' },
      });
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (context.workflowDir) env.SPECKIT_WORKFLOW_DIR = context.workflowDir;
    else delete env.SPECKIT_WORKFLOW_DIR;

    // NOTE: shell mode is required to support pipes, redirects, and
    // multi-command expressions in workflow YAML. Workflow authors control
    // commands; catalog-installed workflows should be reviewed before use.
    const proc = await runShell(command, { cwd, env, timeoutSeconds: timeout as number });
    if (proc.kind === 'timeout') {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Shell command timed out after ${pyStr(timeout)} seconds.`,
        output: { exit_code: -1, stdout: '', stderr: 'timeout' },
      });
    }
    if (proc.kind === 'oserror') {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Shell command failed: ${proc.stderr}`,
        output: { exit_code: -1, stdout: '', stderr: proc.stderr },
      });
    }
    const output: Dict = { exit_code: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr };
    // Malformed output is a step failure, not mojibake (upstream #5064).
    if (proc.decodeErrors?.length) {
      return new StepResult({ status: StepStatus.FAILED, error: proc.decodeErrors.join('; '), output });
    }
    if (proc.exitCode !== 0) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Shell command exited with code ${proc.exitCode}.`,
        output,
      });
    }
    if (dget(config, 'output_format', null) === 'json') {
      try {
        output.data = JSON.parse(proc.stdout) as unknown;
      } catch (exc) {
        return new StepResult({
          status: StepStatus.FAILED,
          error:
            `Shell step ${stepIdRepr(config)} declared ` +
            'output_format: json but stdout is not valid ' +
            `JSON: ${exc instanceof Error ? exc.message : String(exc)}`,
          output,
        });
      }
    }
    return new StepResult({ status: StepStatus.COMPLETED, output });
  }

  /** Return an error message if ``config.timeout`` is invalid, else ``null``. */
  static timeoutError(config: Dict): string | null {
    if (!dhas(config, 'timeout')) return null;
    const timeout = config.timeout;
    const invalid = typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0;
    if (invalid) {
      return (
        `Shell step ${stepIdRepr(config)}: 'timeout' must be a ` +
        `positive number of seconds, got ${pyRepr(timeout)}.`
      );
    }
    return null;
  }

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    const id = stepIdRepr(config);
    if (!dhas(config, 'run')) {
      errors.push(`Shell step ${id} is missing 'run' field.`);
    } else if (typeof config.run !== 'string') {
      errors.push(`Shell step ${id}: 'run' must be a string, got ${pyTypeName(config.run)}.`);
    }
    const outputFormat = dget(config, 'output_format', null);
    if (outputFormat !== null && outputFormat !== undefined && outputFormat !== 'json') {
      errors.push(`Shell step ${id}: 'output_format' must be 'json' when present, got ${pyRepr(outputFormat)}.`);
    }
    const timeoutError = ShellStep.timeoutError(config);
    if (timeoutError !== null) errors.push(timeoutError);
    return errors;
  }
}
