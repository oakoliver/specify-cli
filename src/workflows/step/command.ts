/**
 * @oakoliver/specify-cli - Command Step
 *
 * Port of ``specify_cli/workflows/step/command/__init__.py``: dispatches a
 * Spec Kit command to an integration CLI.
 *
 * @module workflows/step/command
 */

import {
  StepBase,
  StepContext,
  StepResult,
  StepStatus,
  ValueError,
  dget,
  dhas,
  isDict,
  pyRepr,
  pyStr,
  pyTypeName,
  stepIdRepr,
  which,
  type Dict,
} from '../base.js';
import { evaluateExpression } from '../expressions.js';

// ============================================================================
// Integration dispatch seam
// ============================================================================

/** Result of an integration dispatch (``{"exit_code", "stdout", "stderr"}``). */
export interface DispatchResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

/**
 * The subset of ``IntegrationBase`` the workflow steps use. Declared locally
 * (structurally) so the workflow engine does not depend on the concrete
 * integration class shape.
 */
export interface DispatchableIntegration {
  key: string;
  validateRuntimeConfig?(integrationArgs?: string[] | null, integrationOptions?: Dict | null): void;
  buildExecArgs(
    prompt: string,
    options?: {
      model?: string | null;
      outputJson?: boolean;
      integrationArgs?: string[] | null;
      integrationOptions?: Dict | null;
      projectRoot?: string | null;
    },
  ): string[] | null | undefined | Promise<string[] | null | undefined>;
  dispatchCommand(
    commandName: string,
    options?: {
      args?: string;
      projectRoot?: string | null;
      model?: string | null;
      timeout?: number;
      stream?: boolean;
      integrationArgs?: string[] | null;
      integrationOptions?: Dict | null;
    },
  ): unknown;
}

/** Normalize a dispatch result that may use snake_case or camelCase keys. */
export function normalizeDispatchResult(raw: unknown): DispatchResult {
  const r = (isDict(raw) ? raw : {}) as Dict;
  const exitCode = dhas(r, 'exit_code') ? r.exit_code : r.exitCode;
  return {
    exit_code: typeof exitCode === 'number' ? exitCode : Number(exitCode ?? 1),
    stdout: typeof r.stdout === 'string' ? r.stdout : pyStr(r.stdout ?? ''),
    stderr: typeof r.stderr === 'string' ? r.stderr : pyStr(r.stderr ?? ''),
  };
}

/**
 * Look up an integration by key (``specify_cli.integrations.get_integration``).
 * Returns ``null`` when the integrations module cannot be loaded (mirrors the
 * upstream ``except ImportError: return None``).
 */
export async function loadIntegration(key: string): Promise<DispatchableIntegration | null> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import('../../integrations/index.js')) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
  const getIntegration = mod.getIntegration as ((k: string) => unknown) | undefined;
  if (typeof getIntegration !== 'function') return null;
  const impl = getIntegration(key);
  return (impl ?? null) as DispatchableIntegration | null;
}

/** Whether an error is Python's ``NotImplementedError`` or an ``OSError`` equivalent. */
export function isNotImplementedOrOSError(exc: unknown): boolean {
  if (!(exc instanceof Error)) return false;
  if (exc.name === 'NotImplementedError' || exc.name === 'OSError') return true;
  const code = (exc as NodeJS.ErrnoException).code;
  return typeof code === 'string' && code.length > 0 && /^E[A-Z]+$/.test(code);
}

// ============================================================================
// CommandStep
// ============================================================================

/**
 * Default step type — invokes a Spec Kit command via the integration CLI.
 *
 * ``output.exit_code`` is always captured and can be referenced by later
 * steps (e.g. ``{{ steps.specify.output.exit_code }}``).
 */
export class CommandStep extends StepBase {
  static override typeKey = 'command';

  async execute(config: Dict, context: StepContext): Promise<StepResult> {
    const id = stepIdRepr(config);
    const command = dget(config, 'command', '');
    if (typeof command !== 'string') {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Command step ${id}: 'command' must be a string, got ${pyTypeName(command)}.`,
      });
    }

    const inputData = dget(config, 'input', {});
    if (!isDict(inputData)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Command step ${id}: 'input' must be a mapping, got ${pyTypeName(inputData)}.`,
      });
    }

    const resolvedInput: Dict = {};
    for (const [key, value] of Object.entries(inputData)) {
      resolvedInput[key] = evaluateExpression(value, context);
    }

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
        error: `Command step ${id}: 'integration' must be a string, got ${pyTypeName(integration)}.`,
      });
    }
    if (model !== null && model !== undefined && typeof model !== 'string') {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Command step ${id}: 'model' must be a string, got ${pyTypeName(model)}.`,
      });
    }

    const options: Dict = { ...(isDict(context.defaultOptions) ? context.defaultOptions : {}) };
    const stepOptions = dget(config, 'options', {});
    if (!isDict(stepOptions)) {
      return new StepResult({
        status: StepStatus.FAILED,
        error: `Command step ${id}: 'options' must be a mapping, got ${pyTypeName(stepOptions)}.`,
      });
    }
    Object.assign(options, stepOptions);

    const runtimeConfig = CommandStep.resolveRuntimeConfig(config, context);
    if (typeof runtimeConfig === 'string') {
      return new StepResult({ status: StepStatus.FAILED, error: runtimeConfig });
    }
    const [integrationArgs, integrationOptions] = runtimeConfig;

    const argsStr = pyStr(dget(resolvedInput, 'args', ''));
    const output: Dict = {
      command,
      integration: integration ?? null,
      model: model ?? null,
      options,
      input: resolvedInput,
      integration_args: integrationArgs,
      integration_options: integrationOptions,
    };

    let dispatchResult: DispatchResult | null;
    try {
      dispatchResult = await CommandStep.tryDispatch(
        command,
        (integration as string | null) ?? null,
        (model as string | null) ?? null,
        argsStr,
        context,
        integrationArgs,
        integrationOptions,
      );
    } catch (exc) {
      if (exc instanceof ValueError || (exc instanceof Error && exc.name === 'ValueError')) {
        output.exit_code = 1;
        output.dispatched = false;
        return new StepResult({
          status: StepStatus.FAILED,
          output,
          error: `Command step ${id}: ${exc.message}`,
        });
      }
      throw exc;
    }

    if (dispatchResult !== null) {
      output.exit_code = dispatchResult.exit_code;
      output.stdout = dispatchResult.stdout;
      output.stderr = dispatchResult.stderr;
      output.dispatched = true;
      if (dispatchResult.exit_code !== 0) {
        return new StepResult({
          status: StepStatus.FAILED,
          output,
          error: dispatchResult.stderr || `Command exited with code ${dispatchResult.exit_code}`,
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
        `Cannot dispatch command ${pyRepr(command)}: ` +
        `integration ${pyRepr(integration ?? null)} CLI not found or not installed. ` +
        "Install the CLI tool or check 'specify integration list'.",
    });
  }

  /**
   * Invoke *command* by name through the integration CLI.
   *
   * Returns the dispatch result, or ``null`` if dispatch is not possible
   * (integration not found, CLI not installed, or dispatch not supported).
   * Replaceable seam (tests monkeypatch it, as upstream tests patch
   * ``CommandStep._try_dispatch``).
   */
  static tryDispatch = async (
    command: string,
    integrationKey: string | null,
    model: string | null,
    args: string,
    context: StepContext,
    integrationArgs: string[],
    integrationOptions: Dict,
  ): Promise<DispatchResult | null> => {
    if (!integrationKey || typeof integrationKey !== 'string') return null;

    const impl = await loadIntegration(integrationKey);
    if (impl === null) return null;

    impl.validateRuntimeConfig?.(integrationArgs, integrationOptions);

    const projectRoot = context.projectRoot ? context.projectRoot : null;

    const execArgs = await impl.buildExecArgs('test', {
      integrationArgs,
      integrationOptions,
      projectRoot,
    });

    const cliPath = which(impl.key);
    const fallbackCliPath = execArgs && execArgs.length ? which(execArgs[0] as string) : null;
    if (cliPath === null && fallbackCliPath === null) return null;

    try {
      const raw = await impl.dispatchCommand(command, {
        args,
        projectRoot,
        model,
        integrationArgs,
        integrationOptions,
      });
      return normalizeDispatchResult(raw);
    } catch (exc) {
      if (isNotImplementedOrOSError(exc)) return null;
      throw exc;
    }
  };

  /** Resolve and validate this step's per-integration runtime config. */
  static resolveRuntimeConfig(config: Dict, context: StepContext): [string[], Dict] | string {
    const stepId = stepIdRepr(config);

    const rawArgs = dget(config, 'integration_args', []);
    if (!Array.isArray(rawArgs)) {
      return `Command step ${stepId}: 'integration_args' must be a list.`;
    }

    const resolvedArgs: string[] = [];
    for (let index = 0; index < rawArgs.length; index++) {
      const resolved = evaluateExpression(rawArgs[index], context);
      if (typeof resolved !== 'string') {
        return (
          `Command step ${stepId}: 'integration_args[${index}]' ` +
          `must resolve to a string, got ${pyTypeName(resolved)}.`
        );
      }
      resolvedArgs.push(resolved);
    }

    const rawOptions = dget(config, 'integration_options', {});
    if (!isDict(rawOptions)) {
      return `Command step ${stepId}: 'integration_options' must be a mapping.`;
    }
    // (JSON/YAML mapping keys are always strings in this port.)
    const resolvedOptions: Dict = {};
    for (const [key, value] of Object.entries(rawOptions)) {
      resolvedOptions[key] = evaluateExpression(value, context);
    }
    return [resolvedArgs, resolvedOptions];
  }

  override validate(config: Dict): string[] {
    const errors = super.validate(config);
    const id = stepIdRepr(config);
    if (!dhas(config, 'command')) {
      errors.push(`Command step ${id} is missing 'command' field.`);
    } else if (typeof config.command !== 'string') {
      errors.push(`Command step ${id}: 'command' must be a string, got ${pyTypeName(config.command)}.`);
    }
    if (dhas(config, 'input') && !isDict(config.input)) {
      errors.push(`Command step ${id}: 'input' must be a mapping.`);
    }
    if (dhas(config, 'options') && !isDict(config.options)) {
      errors.push(`Command step ${id}: 'options' must be a mapping.`);
    }
    if (dhas(config, 'integration_args') && !Array.isArray(config.integration_args)) {
      errors.push(`Command step ${id}: 'integration_args' must be a list.`);
    } else if (Array.isArray(config.integration_args)) {
      config.integration_args.forEach((value: unknown, index: number) => {
        if (typeof value !== 'string') {
          errors.push(`Command step ${id}: 'integration_args[${index}]' must be a string.`);
        }
      });
    }
    if (dhas(config, 'integration_options') && !isDict(config.integration_options)) {
      errors.push(`Command step ${id}: 'integration_options' must be a mapping.`);
    }
    const integration = dget(config, 'integration', null);
    if (integration !== null && integration !== undefined && typeof integration !== 'string') {
      errors.push(`Command step ${id}: 'integration' must be a string, got ${pyTypeName(integration)}.`);
    }
    const model = dget(config, 'model', null);
    if (model !== null && model !== undefined && typeof model !== 'string') {
      errors.push(`Command step ${id}: 'model' must be a string, got ${pyTypeName(model)}.`);
    }
    return errors;
  }
}
