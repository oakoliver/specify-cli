/**
 * @oakoliver/specify-cli - Prompt Step
 *
 * Port of ``specify_cli/workflows/step/prompt/__init__.py``: sends an
 * arbitrary prompt to an integration CLI.
 *
 * @module workflows/step/prompt
 */

import { spawn } from 'node:child_process';

import {
  KeyboardInterrupt,
  StepBase,
  StepContext,
  StepResult,
  StepStatus,
  dget,
  dhas,
  pyRepr,
  pyStr,
  pyTypeName,
  runtimeIO,
  stepIdRepr,
  which,
  type Dict,
} from '../base.js';
import { evaluateExpression } from '../expressions.js';
import { loadIntegration, type DispatchResult } from './command.js';

/**
 * Send a free-form prompt to an integration CLI.
 *
 * Unlike ``CommandStep`` which invokes an installed Spec Kit command by name,
 * ``PromptStep`` sends an arbitrary inline ``prompt:`` string directly to the
 * CLI.
 */
export class PromptStep extends StepBase {
  static override typeKey = 'prompt';

  async execute(config: Dict, context: StepContext): Promise<StepResult> {
    const id = stepIdRepr(config);
    const promptTemplate = dget(config, 'prompt', '');
    let prompt: unknown = evaluateExpression(promptTemplate, context);
    if (typeof prompt !== 'string') prompt = pyStr(prompt);
    const promptText = prompt as string;

    let integration: unknown = dget(config, 'integration', null);
    if (integration === null || integration === undefined || integration === '') {
      integration = context.defaultIntegration;
    }
    if (integration && typeof integration === 'string' && integration.includes('{{')) {
      integration = evaluateExpression(integration, context);
    }

    let model: unknown = dget(config, 'model', null);
    if (model === null || model === undefined || model === '') model = context.defaultModel;
    if (model && typeof model === 'string' && model.includes('{{')) {
      model = evaluateExpression(model, context);
    }

    if (integration !== null && integration !== undefined && typeof integration !== 'string') {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Prompt step ${id}: 'integration' must be a string, got ${pyTypeName(integration)}.`,
      });
    }
    if (model !== null && model !== undefined && typeof model !== 'string') {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Prompt step ${id}: 'model' must be a string, got ${pyTypeName(model)}.`,
      });
    }

    const timeoutError = PromptStep.timeoutError(config);
    if (timeoutError !== null) return new StepResult({ status: StepStatus.FAILED, error: timeoutError });

    const timeout = dget(config, 'timeout', 300) as number;
    const dispatchResult = await PromptStep.tryDispatch(
      promptText,
      (integration as string | null) ?? null,
      (model as string | null) ?? null,
      context,
      timeout,
    );

    const output: Dict = { prompt: promptText, integration: integration ?? null, model: model ?? null };

    if (dispatchResult !== null) {
      output.exit_code = dispatchResult.exit_code;
      output.stdout = dispatchResult.stdout;
      output.stderr = dispatchResult.stderr;
      output.dispatched = true;
      if (dispatchResult.exit_code !== 0) {
        return new StepResult({
          status: StepStatus.FAILED,
          output,
          error: dispatchResult.stderr || `Prompt exited with code ${dispatchResult.exit_code}`,
        });
      }
      return new StepResult({ status: StepStatus.COMPLETED, output });
    }
    output.exit_code = 1;
    output.dispatched = false;
    return new StepResult({
      status: StepStatus.FAILED,
      output,
      error:
        'Cannot dispatch prompt: ' +
        `integration ${pyRepr(integration ?? null)} ` +
        'CLI not found or not installed.',
    });
  }

  /** Return an error message if ``config.timeout`` is invalid, else ``null``. */
  static timeoutError(config: Dict): string | null {
    if (!dhas(config, 'timeout')) return null;
    const timeout = config.timeout;
    const valid = typeof timeout === 'number' && timeout > 0 && Number.isFinite(timeout);
    if (!valid) {
      return (
        `Prompt step ${stepIdRepr(config)}: 'timeout' must be a ` +
        `positive number of seconds, got ${pyRepr(timeout)}.`
      );
    }
    return null;
  }

  /**
   * Dispatch *prompt* directly through the integration CLI. Replaceable seam
   * (tests monkeypatch it, as upstream tests patch ``PromptStep._try_dispatch``).
   */
  static tryDispatch = async (
    prompt: string,
    integrationKey: string | null,
    model: string | null,
    context: StepContext,
    timeout = 300,
  ): Promise<DispatchResult | null> => {
    if (!integrationKey || typeof integrationKey !== 'string' || !prompt) return null;

    const impl = await loadIntegration(integrationKey);
    if (impl === null) return null;

    const projectRoot = context.projectRoot ? context.projectRoot : process.cwd();

    let execArgs = await impl.buildExecArgs(prompt, { model, outputJson: false, projectRoot });

    const cliPath = which(impl.key);
    const fallbackCliPath = execArgs && execArgs.length ? which(execArgs[0] as string) : null;
    if (cliPath === null && fallbackCliPath === null) return null;

    if (!execArgs || !execArgs.length) return null;

    if (fallbackCliPath) execArgs = [fallbackCliPath, ...execArgs.slice(1)];

    try {
      const exitCode = await PromptStep.runInherited(execArgs, projectRoot, timeout);
      if (exitCode === 'timeout') {
        return { exit_code: -1, stdout: '', stderr: `Prompt timed out after ${pyStr(timeout)} seconds.` };
      }
      return { exit_code: exitCode, stdout: '', stderr: '' };
    } catch (exc) {
      if (exc instanceof KeyboardInterrupt) {
        return { exit_code: 130, stdout: '', stderr: 'Interrupted by user' };
      }
      return null;
    }
  };

  /** Run *argv* with inherited stdio (stdout onto stderr under ``--json``). */
  static runInherited(argv: string[], cwd: string, timeoutSeconds: number): Promise<number | 'timeout'> {
    return new Promise((resolve, reject) => {
      let timedOut = false;
      const child = spawn(argv[0] as string, argv.slice(1), {
        cwd,
        stdio: ['inherit', runtimeIO.stdoutToStderr ? process.stderr : 'inherit', 'inherit'],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, Math.min(timeoutSeconds * 1000, 2 ** 31 - 1));
      child.on('error', (exc) => {
        clearTimeout(timer);
        reject(exc);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) return resolve('timeout');
        if (signal === 'SIGINT') return reject(new KeyboardInterrupt());
        resolve(code ?? -1);
      });
    });
  }

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    const id = stepIdRepr(config);
    if (!dhas(config, 'prompt')) {
      errors.push(`Prompt step ${id} is missing 'prompt' field.`);
    } else if (typeof config.prompt !== 'string') {
      errors.push(`Prompt step ${id}: 'prompt' must be a string, got ${pyTypeName(config.prompt)}.`);
    }
    const integration = dget(config, 'integration', null);
    if (integration !== null && integration !== undefined && typeof integration !== 'string') {
      errors.push(`Prompt step ${id}: 'integration' must be a string, got ${pyTypeName(integration)}.`);
    }
    const model = dget(config, 'model', null);
    if (model !== null && model !== undefined && typeof model !== 'string') {
      errors.push(`Prompt step ${id}: 'model' must be a string, got ${pyTypeName(model)}.`);
    }
    const timeoutError = PromptStep.timeoutError(config);
    if (timeoutError !== null) errors.push(timeoutError);
    return errors;
  }
}
