/**
 * @oakoliver/specify-cli - Workflow composition boundary
 *
 * Port of ``specify_cli/workflows/composition.py`` (upstream #4764): the typed
 * workflow-call boundary. Execution and persistence belong to the engine
 * (``execution.ts``).
 *
 * @module workflows/composition
 */

import { ValueError, isDict, pyRepr, pyTypeName, type Dict } from './base.js';
import { evaluateExpression } from './expressions.js';
import { RESERVED_WORKFLOW_IDS } from './overlay/schema.js';
import type { StepContext } from './base.js';

/** Output names a called workflow may not declare (they belong to the call result). */
export const RESERVED_OUTPUT_NAMES: ReadonlySet<string> = new Set([
  'workflow',
  'status',
  'error',
  'aborted',
  'integration',
  'model',
  'options',
  'input',
]);
export const MAX_COMPOSITION_DEPTH = 16;

/** ID format: lowercase alphanumeric with hyphens (mirrors ``engine.ID_PATTERN``). */
const ID_PATTERN = /^(?:[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9])$/;

/** A treatable violation of the workflow-call boundary. */
export class CallError extends ValueError {
  constructor(message = '') {
    super(message);
    this.name = 'CallError';
  }
}

function jsonViolation(value: unknown, seen: Set<unknown>): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return null;
    const name = Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf';
    return `Out of range float values are not JSON compliant: ${name}`;
  }
  if (value === undefined) return 'JSON encoding changes the value';
  if (typeof value !== 'object') return `Object of type ${typeof value} is not JSON serializable`;
  if (seen.has(value)) return 'Circular reference detected';
  if (!Array.isArray(value) && !isDict(value)) {
    return `Object of type ${pyTypeName(value)} is not JSON serializable`;
  }
  seen.add(value);
  try {
    for (const v of Array.isArray(value) ? value : Object.values(value)) {
      const why = jsonViolation(v, seen);
      if (why !== null) return why;
    }
    return null;
  } finally {
    seen.delete(value);
  }
}

/** Reject lossy/non-JSON values, including cycles, before checkpointing. */
export function requireJson(value: unknown): void {
  const why = jsonViolation(value, new Set());
  if (why !== null) throw new ValueError(`Value is not JSON-safe: ${why}`);
}

/** Validation errors for an authored ``type: workflow`` call. */
export function validateCall(config: Dict): string[] {
  const errors: string[] = [];
  const target = config.workflow;
  if (typeof target !== 'string') {
    errors.push("'workflow' must be a string");
  } else if (!target.includes('{{') && (!ID_PATTERN.test(target) || RESERVED_WORKFLOW_IDS.has(target))) {
    errors.push("'workflow' must be an exact, safe, non-reserved workflow ID");
  }
  const mapping = Object.prototype.hasOwnProperty.call(config, 'input') ? config.input : {};
  if (!isDict(mapping)) {
    errors.push("'input' must be a mapping with string keys");
  } else {
    try {
      requireJson(mapping);
    } catch (exc) {
      errors.push((exc as Error).message);
    }
  }
  return errors;
}

/** Raise a call-boundary error for an invalid authored call shape. */
export function validateRuntimeCall(config: Dict): void {
  const errors = validateCall(config);
  if (errors.length) throw new CallError(errors.join('; '));
}

/** Validation errors for a workflow's ``outputs`` block. */
export function validateOutputs(outputs: unknown): string[] {
  if (!isDict(outputs)) return ["'outputs' must be a mapping"];
  const errors: string[] = [];
  for (const [name, entry] of Object.entries(outputs)) {
    if (!ID_PATTERN.test(name)) errors.push(`Output ${pyRepr(name)} must be a safe identifier`);
    else if (RESERVED_OUTPUT_NAMES.has(name)) errors.push(`Output ${pyRepr(name)} is reserved`);
    if (!isDict(entry) || Object.keys(entry).length !== 1 || !Object.prototype.hasOwnProperty.call(entry, 'value')) {
      errors.push(`Output ${pyRepr(name)} must contain exactly 'value'`);
    } else {
      try {
        requireJson(entry.value);
      } catch (exc) {
        errors.push(`Output ${pyRepr(name)}: ${(exc as Error).message}`);
      }
    }
  }
  return errors;
}

/** Minimal shape of the definition the boundary works with. */
export interface CallableDefinition {
  id: unknown;
  inputs: unknown;
  outputs: unknown;
}

/** Minimal engine surface the boundary needs to resolve typed inputs. */
export interface InputResolver {
  resolveInputs(definition: never, provided: Dict): Dict;
  mergeInputs(definition: never, previous: Dict, updates: Dict): Dict;
}

/**
 * Resolve an installed, enabled, valid workflow for a call, rejecting cycles
 * and over-deep composition.
 */
export async function resolveTarget<T extends CallableDefinition>(
  projectRoot: string,
  target: unknown,
  ancestry: readonly string[],
): Promise<T> {
  const { WorkflowRegistry } = await import('./catalog/domain.js');
  const { WorkflowResolver } = await import('./overlay/resolver.js');
  const { validateWorkflow } = await import('./engine.js');
  try {
    if (typeof target !== 'string' || !ID_PATTERN.test(target)) {
      throw new CallError('Workflow target must be an exact safe workflow ID');
    }
    if (RESERVED_WORKFLOW_IDS.has(target)) throw new CallError(`Workflow ${pyRepr(target)} is reserved`);
    if (ancestry.includes(target)) {
      throw new CallError(`Workflow composition cycle: ${[...ancestry, target].join(' -> ')}`);
    }
    if (ancestry.length > MAX_COMPOSITION_DEPTH) {
      throw new CallError(`Workflow composition exceeds maximum depth ${MAX_COMPOSITION_DEPTH}`);
    }
    const metadata = new WorkflowRegistry(projectRoot).get(target);
    if (!isDict(metadata)) throw new CallError(`Workflow ${pyRepr(target)} is not installed`);
    if (Object.prototype.hasOwnProperty.call(metadata, 'enabled') && !metadata.enabled) {
      throw new CallError(`Workflow ${pyRepr(target)} is disabled`);
    }
    const definition = new WorkflowResolver(projectRoot).resolve(target);
    if (definition.id !== target) {
      throw new CallError(`Workflow ${pyRepr(target)} resolves to mismatched ID ${pyRepr(definition.id)}`);
    }
    const errors = validateWorkflow(definition);
    if (errors.length) throw new CallError(`Invalid workflow ${pyRepr(target)}: ${errors.join('; ')}`);
    return definition as unknown as T;
  } catch (exc) {
    if (exc instanceof CallError) throw exc;
    // Python catches (OSError, ValueError): Node errno errors carry ``code``.
    if (exc instanceof ValueError || (exc instanceof Error && (exc.name === 'ValueError' || 'code' in exc))) {
      throw new CallError((exc as Error).message);
    }
    throw exc;
  }
}

/** Evaluate and type-check a call's ``input`` mapping against the callee. */
export function bindInputs(
  engine: InputResolver,
  definition: CallableDefinition,
  config: Dict,
  context: StepContext,
  previous: Dict | null = null,
): Dict {
  const mapping = Object.prototype.hasOwnProperty.call(config, 'input') ? config.input : {};
  if (!isDict(mapping)) throw new CallError("'input' must be a mapping with string keys");
  const provided: Dict = {};
  for (const [key, value] of Object.entries(mapping)) provided[key] = evaluateExpression(value, context);
  try {
    requireJson(provided);
    const declared = isDict(definition.inputs) ? definition.inputs : {};
    const unknown = Object.keys(provided)
      .filter((k) => !Object.prototype.hasOwnProperty.call(declared, k))
      .sort();
    if (unknown.length) {
      throw new CallError(`Undeclared inputs for workflow ${pyRepr(definition.id)}: ${pyRepr(unknown)}`);
    }
    const resolved =
      previous === null
        ? engine.resolveInputs(definition as never, provided)
        : engine.mergeInputs(definition as never, previous, provided);
    requireJson(resolved);
    return resolved;
  } catch (exc) {
    if (exc instanceof CallError) throw exc;
    if (exc instanceof ValueError || exc instanceof TypeError || exc instanceof RangeError) {
      throw new CallError((exc as Error).message);
    }
    throw exc;
  }
}

/** Evaluate a called workflow's declared ``outputs`` against its context. */
export function evaluateOutputs(definition: CallableDefinition, context: StepContext): Dict {
  const errors = validateOutputs(definition.outputs);
  if (errors.length) throw new CallError(errors.join('; '));
  const output: Dict = {};
  for (const [name, entry] of Object.entries(definition.outputs as Dict)) {
    output[name] = evaluateExpression((entry as Dict).value, context);
  }
  try {
    requireJson(output);
    return output;
  } catch (exc) {
    if (exc instanceof ValueError || exc instanceof TypeError || exc instanceof RangeError) {
      throw new CallError((exc as Error).message);
    }
    throw exc;
  }
}
