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
    let stdout = '';
    let stderr = '';
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
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr?.on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', (exc: NodeJS.ErrnoException) => {
      finish({ kind: 'oserror', exitCode: -1, stdout: '', stderr: osErrorText(exc, opts.cwd), error: exc });
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) return;
      // Python reports a signal-terminated child as a negative return code.
      const exitCode = code !== null ? code : signal ? -(osSignalNumber(signal)) : -1;
      finish({
        kind: 'exited',
        exitCode,
        stdout: universalNewlines(stdout),
        stderr: universalNewlines(stderr),
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
