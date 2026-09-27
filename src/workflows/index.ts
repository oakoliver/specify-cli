/**
 * @oakoliver/specify-cli - Workflow Engine
 *
 * Port of ``specify_cli/workflows/__init__.py``. Workflow engine for
 * multi-step, resumable automation workflows. Provides:
 *
 * - ``StepBase`` — abstract base every step type must implement.
 * - ``StepContext`` — execution context passed to each step.
 * - ``StepResult`` — return value from step execution.
 * - ``STEP_REGISTRY`` — maps ``typeKey`` to ``StepBase`` instances.
 * - ``WorkflowEngine`` — orchestrator that loads, validates, and executes
 *   workflow YAML definitions.
 * - ``loadCustomSteps`` — loads community-installed step types into STEP_REGISTRY.
 *
 * @module workflows
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { StepBase, KeyError, ValueError, isDict, pyRepr } from './base.js';
import { CommandStep } from './step/command.js';
import { DoWhileStep } from './step/do-while.js';
import { FanInStep } from './step/fan-in.js';
import { FanOutStep } from './step/fan-out.js';
import { GateStep } from './step/gate.js';
import { IfThenStep } from './step/if-then.js';
import { InitStep } from './step/init.js';
import { PromptStep } from './step/prompt.js';
import { ShellStep } from './step/shell.js';
import { SlotStep } from './step/slot.js';
import { SwitchStep } from './step/switch.js';
import { WhileStep } from './step/while-loop.js';
import { parseYaml } from '../yaml.js';

export * from './base.js';
export {
  evaluateExpression,
  evaluateCondition,
  conditionIsNeverEvaluated,
  conditionIsInterpolatedToText,
  conditionHasMalformedExpressionBlock,
  formatConditionCorrection,
  formatConditionRemediation,
} from './expressions.js';
export {
  CommandStep,
  DoWhileStep,
  FanInStep,
  FanOutStep,
  GateStep,
  IfThenStep,
  InitStep,
  PromptStep,
  ShellStep,
  SlotStep,
  SwitchStep,
  WhileStep,
};

// ============================================================================
// Registry
// ============================================================================

/** Maps step typeKey → StepBase instance. */
export const STEP_REGISTRY: Map<string, StepBase> = new Map();

/**
 * Register a step type instance in the global registry.
 *
 * Throws ``ValueError`` for falsy keys and ``KeyError`` for duplicates.
 */
export function registerStep(step: StepBase): void {
  const key = step.typeKey;
  if (!key) throw new ValueError('Cannot register step type with an empty type_key.');
  if (STEP_REGISTRY.has(key)) {
    throw new KeyError(`Step type with key ${pyRepr(key)} is already registered.`);
  }
  STEP_REGISTRY.set(key, step);
}

/** Return the step type for *typeKey*, or ``null`` if not registered. */
export function getStepType(typeKey: string): StepBase | null {
  return STEP_REGISTRY.get(typeKey) ?? null;
}

/** Register all built-in step types. */
function registerBuiltinSteps(): void {
  registerStep(new CommandStep());
  registerStep(new DoWhileStep());
  registerStep(new FanInStep());
  registerStep(new FanOutStep());
  registerStep(new GateStep());
  registerStep(new IfThenStep());
  registerStep(new InitStep());
  registerStep(new PromptStep());
  registerStep(new ShellStep());
  registerStep(new SlotStep());
  registerStep(new SwitchStep());
  registerStep(new WhileStep());
}

registerBuiltinSteps();

/**
 * The step types Spec Kit ships, snapshotted before any community step can be
 * loaded. ``loadCustomSteps`` adds project-installed ids to the process-global
 * ``STEP_REGISTRY`` and never removes them, so callers that need the
 * immutable built-in set must use this instead.
 */
export const BUILTIN_STEP_TYPES: ReadonlySet<string> = new Set(STEP_REGISTRY.keys());

// ============================================================================
// Custom steps
// ============================================================================

/**
 * Entry-point file names probed for a custom step package. Upstream loads the
 * package's ``__init__.py``; the TypeScript port cannot execute Python, so a
 * step package must ship a JavaScript ES module entry point instead (checked
 * in this order). Packages that ship only ``__init__.py`` are skipped.
 */
export const CUSTOM_STEP_ENTRY_POINTS = ['index.mjs', 'index.js'] as const;

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

type StepClass = (new () => StepBase) & { typeKey?: string };

function isStepClass(value: unknown, typeKey: string): value is StepClass {
  if (typeof value !== 'function') return false;
  const proto = (value as { prototype?: unknown }).prototype as Record<string, unknown> | undefined;
  if (!proto || typeof proto.execute !== 'function') return false;
  if (value === StepBase) return false;
  const key = (value as { typeKey?: unknown; type_key?: unknown }).typeKey ??
    (value as { type_key?: unknown }).type_key;
  return key === typeKey;
}

/**
 * Load community-installed custom step types into STEP_REGISTRY.
 *
 * Scans ``.specify/workflows/steps/`` for installed step packages. Each valid
 * package must contain ``step.yml`` (with a ``step.type_key`` field) and an
 * ES module entry point (see {@link CUSTOM_STEP_ENTRY_POINTS}) exporting a
 * ``StepBase`` subclass whose static ``typeKey`` matches.
 *
 * Returns a list of type_keys that were successfully loaded. Silently skips
 * packages that fail to import or validate.
 */
export async function loadCustomSteps(projectRoot: string): Promise<string[]> {
  const stepsDir = join(projectRoot, '.specify', 'workflows', 'steps');

  // Defense-in-depth: refuse to execute step code from a symlinked parent
  // directory under .specify/workflows/steps.
  let current = projectRoot;
  for (const part of ['.specify', 'workflows', 'steps']) {
    current = join(current, part);
    if (isSymlink(current)) return [];
  }

  if (!isDir(stepsDir)) return [];

  const loaded: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(stepsDir);
  } catch {
    return [];
  }
  for (const name of entries) {
    const stepDir = join(stepsDir, name);
    if (isSymlink(stepDir)) continue;
    if (!isDir(stepDir)) continue;
    const stepYml = join(stepDir, 'step.yml');
    if (isSymlink(stepYml) || !isFile(stepYml)) continue;
    const entry = CUSTOM_STEP_ENTRY_POINTS.map((e) => join(stepDir, e)).find((p) => existsSync(p));
    if (!entry || isSymlink(entry) || !isFile(entry)) continue;

    try {
      const meta = parseYaml(readFileSync(stepYml, 'utf8')) ?? {};
      if (!isDict(meta)) continue;
      const stepMeta = isDict(meta.step) ? meta.step : {};
      const typeKey = stepMeta.type_key;
      if (!typeKey || typeof typeKey !== 'string') continue;
      if (STEP_REGISTRY.has(typeKey)) continue;

      // Cache-bust per type key so a re-install in a long-lived process is
      // not served a stale module (mirrors upstream's hashed module names).
      const keyHash = createHash('sha256').update(typeKey).digest('hex').slice(0, 8);
      const url = pathToFileURL(entry).href + `?speckit_custom_step=${keyHash}`;
      const mod = (await import(url)) as Record<string, unknown>;

      let stepClass: StepClass | null = null;
      for (const attr of Object.keys(mod).sort()) {
        const value = mod[attr];
        if (isStepClass(value, typeKey)) {
          stepClass = value;
          break;
        }
      }
      if (stepClass === null) continue;

      const instance = new stepClass();
      if (!instance.typeKey && (stepClass as { type_key?: string }).type_key) {
        Object.defineProperty(instance, 'typeKey', { value: typeKey });
      }
      registerStep(instance);
      loaded.push(typeKey);
    } catch {
      // Silently skip broken step packages at load time.
      continue;
    }
  }
  return loaded;
}

export {
  WorkflowDefinition,
  WorkflowEngine,
  RunState,
  WorkflowAbortError,
  validateWorkflow,
} from './engine.js';
