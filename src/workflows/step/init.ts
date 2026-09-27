/**
 * @oakoliver/specify-cli - Init Step
 *
 * Port of ``specify_cli/workflows/step/init/__init__.py``: bootstrap a Spec
 * Kit project from within a workflow.
 *
 * Runs the same scaffolding as ``specify init`` so a workflow can create (or
 * merge into) a project before driving the rest of the spec-driven process.
 * The step invokes the ``init`` command in-process and captures its exit code
 * and output.
 *
 * @module workflows/step/init
 */

import { readdirSync } from 'node:fs';

import {
  StepBase,
  StepContext,
  StepResult,
  StepStatus,
  dget,
  pyRepr,
  pyStr,
  pyTruthy,
  stepIdRepr,
  type Dict,
} from '../base.js';
import { evaluateExpression } from '../expressions.js';
import { SCRIPT_TYPE_CHOICES, resolveDefaultInitIntegration } from '../../agent-config.js';

/** Valid ``script`` values, derived from the canonical source in agent-config. */
export const VALID_SCRIPT_TYPES: readonly string[] = Object.keys(SCRIPT_TYPE_CHOICES);

/**
 * Directories the workflow engine may create before steps run. These are
 * excluded from the "non-empty directory" fast-fail check.
 */
const ENGINE_OWNED_DIRS = new Set(['.specify']);

/** Python ``OSError`` text for a Node fs error (best effort). */
function osErrorText(exc: unknown, path: string): string {
  const e = exc as NodeJS.ErrnoException;
  const known: Record<string, string> = {
    ENOENT: '[Errno 2] No such file or directory',
    EACCES: '[Errno 13] Permission denied',
    ENOTDIR: '[Errno 20] Not a directory',
  };
  if (e && typeof e.code === 'string' && known[e.code]) return `${known[e.code]}: ${pyRepr(path)}`;
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * Bootstrap a project, equivalent to running ``specify init``.
 *
 * Because workflows run unattended, the step defaults to
 * ``--ignore-agent-tools`` and resolves the integration from the step config,
 * falling back to the workflow-level default integration.
 */
export class InitStep extends StepBase {
  static override typeKey = 'init';

  async execute(config: Dict, context: StepContext): Promise<StepResult> {
    const project = InitStep.resolve(dget(config, 'project', null), context);
    const here = InitStep.resolveBool(dget(config, 'here', null), context);

    let integration = InitStep.resolve(dget(config, 'integration', null), context);
    if (!pyTruthy(integration)) integration = InitStep.resolve(context.defaultIntegration, context);
    if (!pyTruthy(integration)) integration = resolveDefaultInitIntegration();

    const integrationOptions = InitStep.resolve(dget(config, 'integration_options', null), context);
    const script = InitStep.resolve(dget(config, 'script', null), context);
    const preset = InitStep.resolve(dget(config, 'preset', null), context);

    let force = InitStep.resolveBool(dget(config, 'force', null), context);
    let rawIgnoreAgentTools = dget(config, 'ignore_agent_tools', null);
    if (rawIgnoreAgentTools === null || rawIgnoreAgentTools === undefined) rawIgnoreAgentTools = true;
    const ignoreAgentTools = InitStep.resolveBool(rawIgnoreAgentTools, context);

    const argv: string[] = ['init'];
    if (here) argv.push('--here');
    else if (pyTruthy(project)) argv.push(pyStr(project));
    else argv.push('.');

    if (pyTruthy(integration)) argv.push('--integration', pyStr(integration));
    if (pyTruthy(integrationOptions)) argv.push('--integration-options', pyStr(integrationOptions));
    if (pyTruthy(script)) argv.push('--script', pyStr(script));
    if (pyTruthy(preset)) argv.push('--preset', pyStr(preset));
    if (ignoreAgentTools) argv.push('--ignore-agent-tools');

    const baseOutput = (): Dict => ({
      argv,
      project: project ?? null,
      here,
      integration: integration ?? null,
      integration_options: integrationOptions ?? null,
      script: script ?? null,
      preset: preset ?? null,
      force,
      ignore_agent_tools: ignoreAgentTools,
    });

    const targetsCurrentDir = here || !pyTruthy(project) || pyStr(project) === '.';
    if (targetsCurrentDir && !force) {
      const base = context.projectRoot || process.cwd();
      let hasEngineDirs = false;
      let hasNonEngineContent = false;
      try {
        const entries = readdirSync(base, { withFileTypes: true });
        for (const entry of entries) {
          if (ENGINE_OWNED_DIRS.has(entry.name) && entry.isDirectory()) {
            hasEngineDirs = true;
          } else {
            hasNonEngineContent = true;
            break;
          }
        }
      } catch (exc) {
        const errorMessage = `Cannot inspect target directory ${pyRepr(base)}: ${osErrorText(exc, base)}`;
        return new StepResult({
          status: StepStatus.FAILED,
          output: { ...baseOutput(), exit_code: 1, stdout: '', stderr: errorMessage },
          error: errorMessage,
        });
      }
      if (hasNonEngineContent) {
        const errorMessage =
          `Target directory ${pyRepr(base)} is not empty. Set ` +
          "'force: true' to merge into a non-empty directory.";
        return new StepResult({
          status: StepStatus.FAILED,
          output: { ...baseOutput(), exit_code: 1, stdout: '', stderr: errorMessage },
          error: errorMessage,
        });
      } else if (hasEngineDirs) {
        force = true;
      }
    }

    if (force) argv.push('--force');

    const [exitCode, stdout, stderr] = await InitStep.runInit(argv, context);

    const output: Dict = { ...baseOutput(), exit_code: exitCode, stdout, stderr };

    if (exitCode !== 0) {
      return new StepResult({
        status: StepStatus.FAILED,
        output,
        error: stderr.trim() || stdout.trim() || `specify init exited with code ${exitCode}.`,
      });
    }
    return new StepResult({ status: StepStatus.COMPLETED, output });
  }

  /** Resolve ``{{ ... }}`` expressions in string config values. */
  static resolve(value: unknown, context: StepContext): unknown {
    if (typeof value === 'string' && value.includes('{{')) return evaluateExpression(value, context);
    return value === undefined ? null : value;
  }

  /** Coerce a config value (possibly an expression) to a boolean. */
  static resolveBool(value: unknown, context: StepContext): boolean {
    const resolved = InitStep.resolve(value, context);
    if (typeof resolved === 'string') {
      return ['true', '1', 'yes'].includes(resolved.trim().toLowerCase());
    }
    return pyTruthy(resolved);
  }

  /**
   * Invoke ``specify init`` in-process and capture exit code/output.
   *
   * Runs with the working directory set to ``context.projectRoot`` so that
   * ``--here`` and relative project paths target the right place.
   * Replaceable seam (tests monkeypatch it, as upstream tests patch
   * ``InitStep._run_init``).
   */
  static runInit = async (argv: string[], context: StepContext): Promise<[number, string, string]> => {
    const prevCwd = process.cwd();
    if (context.projectRoot) {
      try {
        process.chdir(context.projectRoot);
      } catch (exc) {
        return [1, '', `Cannot enter project root: ${osErrorText(exc, context.projectRoot)}`];
      }
    }
    let stdout = '';
    let stderr = '';
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const capture =
      (sink: 'out' | 'err') =>
      (chunk: unknown, ...rest: unknown[]): boolean => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
        if (sink === 'out') stdout += text;
        else stderr += text;
        const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
        if (cb) cb();
        return true;
      };
    let exitCode = 1;
    let exception: unknown = null;
    (process.stdout as unknown as { write: unknown }).write = capture('out');
    (process.stderr as unknown as { write: unknown }).write = capture('err');
    try {
      const mod = (await import('../../init.js')) as unknown as Record<string, unknown>;
      const runInitCommand = mod.runInitCommand as ((args: string[]) => Promise<number>) | undefined;
      if (typeof runInitCommand !== 'function') throw new Error('specify init is not available');
      exitCode = await runInitCommand(argv.slice(1));
    } catch (exc) {
      const code = (exc as { code?: unknown } | null)?.code;
      if (exc && typeof exc === 'object' && (exc as Error).name === 'CliExit' && typeof code === 'number') {
        exitCode = code;
      } else {
        exitCode = 1;
        exception = exc;
      }
    } finally {
      (process.stdout as unknown as { write: unknown }).write = origOut;
      (process.stderr as unknown as { write: unknown }).write = origErr;
      try {
        process.chdir(prevCwd);
      } catch {
        // Best-effort cleanup.
      }
    }
    if (exitCode !== 0 && exception !== null) {
      const name = exception instanceof Error ? exception.name : 'Exception';
      const msg = exception instanceof Error ? exception.message : String(exception);
      const detail = `${name}: ${msg}`;
      stderr = stderr ? `${stderr}\n${detail}`.trim() : detail;
    }
    return [exitCode, stdout, stderr];
  };

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    const script = dget(config, 'script', null);
    const choices = VALID_SCRIPT_TYPES.map((s) => pyRepr(s)).join(' or ');
    if (script !== null && script !== undefined && typeof script !== 'string') {
      errors.push(`Init step ${stepIdRepr(config)}: 'script' must be a string (${choices}).`);
    } else if (typeof script === 'string' && !script.includes('{{') && !VALID_SCRIPT_TYPES.includes(script)) {
      errors.push(`Init step ${stepIdRepr(config)}: 'script' must be ${choices}.`);
    }
    return errors;
  }
}
