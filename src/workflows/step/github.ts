/**
 * @oakoliver/specify-cli - GitHub Step
 *
 * Port of ``specify_cli/workflows/step/github/__init__.py`` (upstream #4905):
 * add an explicit label to an issue or pull request through the ``gh`` CLI.
 *
 * @module workflows/step/github
 */

import { spawn } from 'node:child_process';
import { resolve as pathResolve } from 'node:path';

import { StepBase, StepContext, StepResult, StepStatus, ValueError, dhas, isDict, pyJsonDumps, pyRepr, type Dict } from '../base.js';
import { evaluateExpression } from '../expressions.js';

const NUMBER = /^[1-9][0-9]*$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ALLOWED_FIELDS = new Set(['id', 'type', 'operation', 'target', 'repository', 'number', 'label', 'continue_on_error']);

/** Outcome of one ``gh`` invocation. */
export interface GhRunResult {
  returncode: number;
  stdout: string;
}

/**
 * Run ``args`` in ``cwd`` with ``inputText`` on stdin (60-second timeout).
 * Rejects with a Node errno error on spawn failure and with an error named
 * ``TimeoutExpired`` on timeout. Replaceable seam for tests.
 */
export function defaultGhRunner(args: string[], cwd: string, inputText: string | null): Promise<GhRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0] as string, args.slice(1), { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      const err = new Error(`Command ${pyRepr(args)} timed out after 60 seconds`);
      err.name = 'TimeoutExpired';
      reject(err);
    }, 60_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
    });
    child.stderr.resume();
    child.on('error', (exc: NodeJS.ErrnoException) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(exc);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ returncode: code ?? 1, stdout });
    });
    child.stdin.on('error', () => {
      // The CLI may exit before reading stdin.
    });
    child.stdin.end(inputText ?? '');
  });
}

function osErrorText(exc: NodeJS.ErrnoException, cmd: string): string {
  if (exc.code === 'ENOENT') return `[Errno 2] No such file or directory: ${pyRepr(cmd)}`;
  if (exc.code === 'EACCES') return `[Errno 13] Permission denied: ${pyRepr(cmd)}`;
  return exc.message;
}

function resolved(value: unknown, context: StepContext): unknown {
  if (typeof value === 'string' && value.includes('{{')) return evaluateExpression(value, context);
  return value;
}

function number(value: unknown): number {
  if (
    typeof value === 'boolean' ||
    !((typeof value === 'number' && Number.isInteger(value) && value > 0) || (typeof value === 'string' && NUMBER.test(value)))
  ) {
    throw new ValueError("'number' must be a positive integer");
  }
  return typeof value === 'number' ? value : parseInt(value as string, 10);
}

function repository(value: unknown): string {
  if (typeof value !== 'string' || !REPOSITORY.test(value) || value.split('/').some((p) => p === '.' || p === '..')) {
    throw new ValueError("'repository' must be a GitHub owner/repo name");
  }
  return value;
}

function label(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    [...value].length > 50 ||
    [...value].some((ch) => (ch.codePointAt(0) as number) < 32 || ch.codePointAt(0) === 127)
  ) {
    throw new ValueError(
      "'label' must be a non-empty label name of at most 50 characters without control characters",
    );
  }
  return value;
}

function labelNames(value: unknown): Set<string> {
  if (!Array.isArray(value) || !value.every((e) => isDict(e) && typeof e.name === 'string')) {
    throw new ValueError('GitHub returned an invalid label list');
  }
  return new Set(value.map((e) => ((e as Dict).name as string).toLowerCase()));
}

/** Add only the label explicitly specified by a workflow author. */
export class GitHubStep extends StepBase {
  static override typeKey = 'github';

  /** Replaceable ``gh`` runner (tests stub it, as upstream tests patch ``subprocess.run``). */
  static runner: (args: string[], cwd: string, inputText: string | null) => Promise<GhRunResult> = defaultGhRunner;

  private static async run(args: string[], root: string, inputText: string | null = null): Promise<string> {
    let result: GhRunResult;
    try {
      result = await GitHubStep.runner(args, root, inputText);
    } catch (exc) {
      const e = exc as NodeJS.ErrnoException;
      if (e?.name === 'TimeoutExpired') throw new ValueError(`${args[0]} request failed: ${e.message}`);
      if (typeof e?.code === 'string') throw new ValueError(`${args[0]} request failed: ${osErrorText(e, args[0] as string)}`);
      throw exc;
    }
    if (result.returncode) {
      // CLI stderr may contain authentication details; never include it in run state.
      throw new ValueError(`${args[0]} request failed (exit code ${result.returncode})`);
    }
    return result.stdout.trim();
  }

  private static async api(root: string, endpoint: string, labels: string[] | null = null): Promise<unknown> {
    const method = labels !== null ? 'POST' : 'GET';
    const args = ['gh', 'api', '--method', method, endpoint];
    if (labels !== null) args.push('--header', 'Content-Type: application/json', '--input', '-');
    const raw = await GitHubStep.run(args, root, labels !== null ? pyJsonDumps({ labels }) : null);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new ValueError(`GitHub returned invalid JSON for ${endpoint}`);
    }
  }

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    if (config.operation !== 'add-label') errors.push("GitHub step 'operation' must be add-label.");
    if (config.target !== 'issue' && config.target !== 'pull_request') {
      errors.push("GitHub step 'target' must be issue or pull_request.");
    }
    for (const key of Object.keys(config)) {
      if (!ALLOWED_FIELDS.has(key)) errors.push(`GitHub step has unsupported field ${pyRepr(key)}.`);
    }
    const check = (key: string, fn: (v: unknown) => unknown): void => {
      if (!dhas(config, key)) {
        errors.push(`GitHub step requires ${pyRepr(key)}.`);
        return;
      }
      const v = config[key];
      if (typeof v === 'string' && v.includes('{{')) return;
      try {
        fn(v);
      } catch (exc) {
        errors.push((exc as Error).message);
      }
    };
    check('number', number);
    check('repository', repository);
    check('label', label);
    return errors;
  }

  async execute(config: Dict, context: StepContext): Promise<StepResult> {
    try {
      const errors = this.validate(config);
      if (errors.length) throw new ValueError(errors.join('; '));
      const num = number(resolved(config.number, context));
      const lbl = label(resolved(config.label, context));
      const repo = repository(resolved(config.repository, context));
      const root = pathResolve(context.projectRoot || '.');
      const url = `https://api.github.com/repos/${repo}`;
      const target = config.target as string;
      const kind = target === 'pull_request' ? 'pulls' : 'issues';
      const resource = await GitHubStep.api(root, `${url}/${kind}/${num}`);
      if (!isDict(resource) || resource.number !== num || (target === 'issue' && dhas(resource, 'pull_request'))) {
        throw new ValueError(`GitHub ${target} #${num} does not match the requested target`);
      }
      const existing = labelNames(resource.labels);
      const output: Dict = { repository: repo, target, number: num, label: lbl, added: false };
      if (existing.has(lbl.toLowerCase())) return new StepResult({ output });
      const labels = await GitHubStep.api(root, `${url}/issues/${num}/labels`, [lbl]);
      if (!labelNames(labels).has(lbl.toLowerCase())) {
        throw new ValueError(`GitHub did not apply label ${pyRepr(lbl)} to ${target} #${num}`);
      }
      output.added = true;
      return new StepResult({ output });
    } catch (exc) {
      if (exc instanceof ValueError || (exc as NodeJS.ErrnoException)?.code !== undefined) {
        return new StepResult({ status: StepStatus.FAILED, error: `GitHub step: ${(exc as Error).message}` });
      }
      throw exc;
    }
  }
}
