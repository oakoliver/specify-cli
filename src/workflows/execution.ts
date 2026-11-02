/**
 * @oakoliver/specify-cli - Persisted workflow execution tree
 *
 * Port of ``specify_cli/workflows/_execution.py`` (upstream #4764): a
 * persisted execution tree, traversed identically on first execution and on
 * resume. An occurrence owns its result and descendants; authored names are
 * only aliases in an expression context, and tree positions distinguish
 * repeated executions.
 *
 * ADAPTATION: upstream runs concurrent fan-out items on a thread pool guarded
 * by the run lock. Steps here are asynchronous and the event loop is single
 * threaded, so items interleave at ``await`` points and no lock is needed;
 * the sliding submission window and in-order collection are kept.
 *
 * @module workflows/execution
 */

import {
  RunStatus,
  StepContext,
  StepResult,
  StepStatus,
  ValueError,
  isDict,
  pyEquals,
  pyRepr,
  pyStr,
  pyTruthy,
  toRunStatus,
  type Dict,
  type StepBase,
} from './base.js';
import { CallError, bindInputs, evaluateOutputs, resolveTarget, validateRuntimeCall } from './composition.js';
import { evaluateCondition, evaluateExpression } from './expressions.js';
import { dumpYaml, parseYaml } from '../yaml.js';
import { cancelCaptures } from '../integrations/capture.js';

export const HALTING: ReadonlySet<string> = new Set(['paused', 'failed', 'aborted']);
export const EXECUTION_VERSION = 2;

/** The error recorded for a step type that has no registered implementation. */
export function unknownStepError(kind: unknown): string {
  return `Unknown step type: ${pyRepr(kind)}`;
}

/** Persistence failed; reload the authoritative disk checkpoint before retrying. */
export class CheckpointError extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'CheckpointError';
  }
}

type Seq = Dict & { nodes: Dict[]; source?: string };

const STEP_STATUS_VALUES: ReadonlySet<string> = new Set(Object.values(StepStatus) as string[]);

function deepcopy<T>(value: T): T {
  return value === undefined ? value : (structuredClone(value) as T);
}

function has(obj: Dict, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function get(obj: Dict, key: string, fallback: unknown = undefined): unknown {
  return has(obj, key) ? obj[key] : fallback;
}

/** A sequence that owns its YAML source. */
export function sequence(steps: Dict[]): Seq {
  return { source: dumpYaml(steps, { sortKeys: false }), nodes: steps.map(() => ({ phase: 'ready' })) };
}

/** Occurrence storage that shares its parent's immutable source. */
export function occurrences(steps: unknown[]): Seq {
  return { nodes: steps.map(() => ({ phase: 'ready' })) };
}

/** Create the persisted root execution tree. */
export function newExecution(steps: Dict[], offset: number, initial: Dict): Dict {
  return {
    version: EXECUTION_VERSION,
    sequence: sequence(steps),
    offset: Math.max(0, offset),
    initial: deepcopy(initial),
  };
}

/** Read the persisted YAML source for one execution sequence. */
export function stepsOf(seq: Dict): unknown {
  return parseYaml(seq.source as string);
}

export const LOOP_TYPES: ReadonlySet<string> = new Set(['while', 'do-while']);

const TRANSITIONS: Record<string, [ReadonlySet<string>, ReadonlySet<string>]> = {
  begin: [new Set(['ready', 'blocked', 'children', 'outputs']), new Set()],
  expand: [new Set(['ready', 'blocked']), new Set(['result', 'children', 'template'])],
  bind: [new Set(['ready', 'blocked']), new Set(['binding', 'children'])],
  rebind: [new Set(['children', 'blocked', 'outputs']), new Set(['binding'])],
  iterate: [new Set(['children']), new Set(['children'])],
  outputs: [new Set(['children', 'blocked', 'outputs']), new Set()],
  finish: [new Set(['ready', 'blocked', 'children', 'outputs']), new Set(['result', 'outcome', 'error'])],
  settle: [new Set(['children']), new Set(['outcome', 'error', 'fan_results'])],
  leave: [new Set(['ready', 'blocked', 'children', 'outputs', 'done']), new Set()],
};

/** Whether child ``index`` reads its steps from the parent occurrence. */
export function sharesSource(kind: unknown, index: number): boolean {
  return kind === 'workflow' || kind === 'fan-out' || (LOOP_TYPES.has(kind as string) && index > 0);
}

/** Read a child sequence from its position in the parent occurrence. */
export function childSteps(config: Dict, node: Dict, index: number): unknown {
  const kind = config.type;
  const children = node.children as Dict[];
  if (!sharesSource(kind, index)) return stepsOf(children[index] as Dict);
  if (kind === 'workflow') return (parseYaml((node.binding as Dict).definition as string) as Dict).steps;
  if (kind === 'fan-out') {
    const template = parseYaml(node.template as string) as Dict;
    return [{ id: 'item', ...template }];
  }
  return stepsOf(children[0] as Dict);
}

/** Return a child's reporting path from its parent occurrence. */
export function childPath(config: Dict, path: string[], item: number): string[] {
  const kind = config.type as string;
  return kind === 'fan-out' || LOOP_TYPES.has(kind) ? [...path, String(item)] : path;
}

/** The public occurrence ID of a loop-iteration or fan-out-item step. */
export function qualifiedId(name: string, loopAlias: [string, number] | null = null): string {
  if (loopAlias === null) return name;
  return `${loopAlias[0]}:${name}:${loopAlias[1]}`;
}

/** Qualify direct body steps of later loop iterations. */
export function loopAliasFor(kind: unknown, qualified: string, iteration: number): [string, number] | null {
  return LOOP_TYPES.has(kind as string) && iteration ? [qualified, iteration] : null;
}

/**
 * Yield execution occurrences with one shared path and ID rule. Each item is
 * ``[config, node, path, stepId]``; ``stepId`` is the occurrence ID used by
 * events, relative to the enclosing workflow scope.
 */
export function* walkExecution(
  seq: Dict,
  path: string[] = [],
  opts: { childrenFirst?: boolean; skipDone?: boolean; steps?: unknown; loopAlias?: [string, number] | null } = {},
): Generator<[Dict, Dict, string[], string]> {
  const steps = (opts.steps === undefined ? stepsOf(seq) : opts.steps) as Dict[];
  const nodes = seq.nodes as Dict[];
  const n = Math.min(steps.length, nodes.length);
  for (let index = 0; index < n; index++) {
    const config = steps[index] as Dict;
    const node = nodes[index] as Dict;
    if (opts.skipDone && node.phase === 'done') continue;
    const name = pyStr(get(config, 'id', `step-${index}`));
    const here = [...path, name];
    const qualified = qualifiedId(name, opts.loopAlias ?? null);
    const kind = get(config, 'type', 'command');
    if (!opts.childrenFirst) yield [config, node, here, qualified];
    const children = (get(node, 'children', []) as Dict[]) ?? [];
    for (let item = 0; item < children.length; item++) {
      yield* walkExecution(children[item] as Dict, childPath(config, here, item), {
        childrenFirst: opts.childrenFirst,
        skipDone: opts.skipDone,
        steps: childSteps(config, node, item),
        loopAlias: kind === 'fan-out' ? [qualified, item] : loopAliasFor(kind, qualified, item),
      });
    }
    if (opts.childrenFirst) yield [config, node, here, qualified];
  }
}

function checkSteps(steps: unknown, nodes: unknown): void {
  if (
    !Array.isArray(steps) ||
    !steps.every((s) => isDict(s)) ||
    !Array.isArray(nodes) ||
    nodes.length !== steps.length
  ) {
    throw new ValueError('Invalid execution sequence length or steps');
  }
}

function seqSteps(seq: unknown, steps: unknown, shared: boolean): unknown {
  if (!isDict(seq) || (shared && has(seq, 'source'))) throw new ValueError('Invalid execution sequence');
  if (shared) {
    if (!Array.isArray(steps)) throw new ValueError('Invalid shared execution source');
    return steps;
  }
  if (typeof seq.source !== 'string') throw new ValueError('Invalid execution sequence');
  return stepsOf(seq);
}

/** Walk a stored sequence, checking every occurrence and its descendants. */
export function checkSequence(seq: unknown, steps: unknown = null, shared = false): void {
  const resolved = seqSteps(seq, steps, shared) as Dict[];
  const nodes = (seq as Dict).nodes;
  checkSteps(resolved, nodes);
  (resolved as Dict[]).forEach((step, i) => {
    const node = (nodes as Dict[])[i] as Dict;
    checkNode(step, node);
    const children = (get(node, 'children', []) as Dict[]) ?? [];
    children.forEach((child, index) => {
      if (sharesSource(step.type, index)) checkSequence(child, childSteps(step, node, index), true);
      else checkSequence(child);
    });
  });
}

/** Check a newly attached child sequence without visiting its nodes' descendants. */
export function checkSequenceShape(seq: unknown, steps: unknown = null, shared = false): void {
  const resolved = seqSteps(seq, steps, shared);
  checkSteps(resolved, (seq as Dict).nodes);
}

/**
 * Validate one occurrence and its direct children without walking
 * descendants. On a transition, unchanged YAML sources and existing child
 * shapes were checked when they were created or loaded; load checks everything.
 */
export function checkNode(
  step: Dict,
  node: unknown,
  changed: ReadonlySet<string> | null = null,
  newChildren: readonly unknown[] = [],
): void {
  if (!isDict(node) || !['ready', 'children', 'outputs', 'blocked', 'done'].includes(node.phase as string)) {
    throw new ValueError('Invalid execution phase');
  }
  const result = get(node, 'result', null) as Dict | null;
  if (
    result !== null &&
    result !== undefined &&
    (!isDict(result) || !STEP_STATUS_VALUES.has(result.status as string) || !isDict(result.output))
  ) {
    throw new ValueError('Invalid execution result');
  }
  if (node.phase === 'done' && (result === null || result === undefined)) {
    throw new ValueError('Completed execution lacks a result');
  }
  if (has(node, 'active') && typeof node.active !== 'boolean') throw new ValueError('Invalid execution activity');
  if (node.phase === 'done' && node.active) throw new ValueError('Completed execution is still active');
  const outcome = get(node, 'outcome', 'completed');
  if (!(outcome === 'completed' || HALTING.has(outcome as string))) throw new ValueError('Invalid execution outcome');
  if (node.phase === 'done' && outcome !== 'completed') {
    throw new ValueError('Completed execution has a blocking outcome');
  }
  if (
    node.phase === 'blocked' &&
    (result === null ||
      result === undefined ||
      !['failed', 'paused'].includes(result.status as string) ||
      !HALTING.has(get(node, 'outcome', null) as string))
  ) {
    throw new ValueError('Blocked execution lacks a blocking result');
  }
  const children = get(node, 'children', []);
  if (!Array.isArray(children)) throw new ValueError('Invalid execution children');
  const kind = step.type;
  if (has(node, 'fan_results') && (kind !== 'fan-out' || !Array.isArray(node.fan_results))) {
    throw new ValueError('Invalid fan-out aggregate results');
  }
  if (has(node, 'template') && (kind !== 'fan-out' || typeof node.template !== 'string')) {
    throw new ValueError('Invalid fan-out template');
  }
  const binding = get(node, 'binding', null);
  if (binding !== null && binding !== undefined) {
    if (kind !== 'workflow' || !isDict(binding)) throw new ValueError('Invalid workflow binding');
    if (changed === null || changed.has('binding')) {
      const source = binding.definition;
      if (typeof source !== 'string') throw new ValueError('Invalid bound workflow definition or inputs');
      const bound = parseYaml(source);
      if (
        !isDict(bound) ||
        !isDict(bound.workflow) ||
        !pyEquals(bound.workflow.id, get(binding, 'workflow', null)) ||
        !isDict(binding.inputs) ||
        !has(binding, 'workflow_dir') ||
        !(typeof binding.workflow_dir === 'string' || binding.workflow_dir === null) ||
        children.length !== 1 ||
        !Array.isArray(bound.steps)
      ) {
        throw new ValueError('Invalid bound workflow definition or inputs');
      }
    }
  } else if (kind === 'workflow' && children.length) {
    throw new ValueError('Workflow children require a binding');
  }
  if (kind === 'fan-out' && children.length && (changed === null || changed.has('template'))) {
    const source = node.template;
    const template = typeof source === 'string' ? parseYaml(source) : null;
    if (!isDict(template)) throw new ValueError('Invalid fan-out template');
  }
  if (changed === null || newChildren.length) {
    let shared: unknown = null;
    children.forEach((child, index) => {
      if (changed !== null && !newChildren.some((fresh) => child === fresh)) return;
      if (sharesSource(kind, index)) {
        if (shared === null) shared = childSteps(step, node, index);
        checkSequenceShape(child, shared, true);
      } else {
        checkSequenceShape(child);
      }
    });
  }
  const handledChildFailure =
    kind === 'workflow' &&
    get(step, 'continue_on_error', null) === true &&
    get(node, 'outcome', null) === 'completed' &&
    result !== null &&
    result !== undefined &&
    result.status === 'failed';
  if (node.phase === 'done' && !handledChildFailure) {
    for (const child of children as Dict[]) {
      if ((child.nodes as Dict[]).some((nested) => nested.phase !== 'done')) {
        throw new ValueError('Completed execution has unfinished children');
      }
    }
  }
  if (node.phase === 'outputs' && (binding === null || binding === undefined)) {
    throw new ValueError('Output finalization requires a workflow binding');
  }
  if (node.phase === 'children' && (!children.length || ((binding === null || binding === undefined) && (result === null || result === undefined)))) {
    throw new ValueError('Expanded execution lacks its children or result');
  }
  if (node.phase === 'ready' && ((result !== null && result !== undefined) || children.length || pyTruthy(binding))) {
    throw new ValueError('Unstarted execution already has progress');
  }
  if (kind === 'fan-out' && children.length) {
    const items = isDict(result) && isDict(result.output) ? result.output.items : undefined;
    if (!Array.isArray(items) || items.length !== children.length) {
      throw new ValueError('Fan-out items do not match execution children');
    }
  }
}

/** Validate stored structure without importing a project's custom steps. */
export function validateExecution(
  tree: unknown,
  opts: { workflowSteps?: unknown[] | null; currentStepIndex?: number | null } = {},
): void {
  try {
    if (!isDict(tree) || tree.version !== EXECUTION_VERSION) throw new ValueError('Unsupported execution version');
    const offset = get(tree, 'offset', 0);
    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || !isDict(get(tree, 'initial', {}))) {
      throw new ValueError('Invalid execution offset or initial aliases');
    }
    if (!has(tree, 'sequence')) throw new KeyErrorLike("'sequence'");
    checkSequence(tree.sequence);
    if (opts.workflowSteps !== undefined && opts.workflowSteps !== null) {
      if (offset >= opts.workflowSteps.length || offset > (opts.currentStepIndex ?? 0)) {
        throw new ValueError('Invalid execution offset for workflow position');
      }
      if (!pyEquals(stepsOf(tree.sequence as Dict), opts.workflowSteps.slice(offset))) {
        throw new ValueError('Invalid execution state: root sequence differs from workflow snapshot');
      }
    }
  } catch (exc) {
    if (exc instanceof ValueError) throw exc;
    if (exc instanceof KeyErrorLike || exc instanceof TypeError || (exc instanceof Error && exc.name === 'YAMLError') || exc instanceof RangeError) {
      throw new ValueError(`Invalid execution state: ${(exc as Error).message}`);
    }
    if (exc instanceof Error && /YAML|Scanner|Parser|Composer|Constructor/.test(exc.name)) {
      throw new ValueError(`Invalid execution state: ${exc.message}`);
    }
    throw exc;
  }
}

class KeyErrorLike extends Error {}

/** First unfinished leaf in execution order, including nested workflow scopes. */
export function activeStep(tree: Dict): [string[], Dict, string] | null {
  for (const [, node, path, stepId] of walkExecution(tree.sequence as Dict, [], {
    childrenFirst: true,
    skipDone: true,
  })) {
    return [path, node, stepId];
  }
  return null;
}

/**
 * Report workflow boundaries without exposing private inputs or results. Only
 * an unfinished scope containing the active occurrence inherits a terminal run
 * status; completed scopes retain their recorded result.
 */
export function scopeSummaries(tree: Dict, runStatus = 'running'): Dict[] {
  const summaries: Dict[] = [];
  const active = activeStep(tree);
  const activePath = active !== null ? active[0] : [];
  for (const [, node, path] of walkExecution(tree.sequence as Dict)) {
    const binding = get(node, 'binding', null);
    if (isDict(binding) && pyTruthy(binding)) {
      const result = get(node, 'result', {});
      const output = isDict(result) ? (get(result, 'output', {}) as Dict) : {};
      let status = isDict(output) ? get(output, 'status', null) : null;
      if (status === null || status === undefined) {
        status =
          HALTING.has(runStatus) && pyEquals(activePath.slice(0, path.length), path) ? runStatus : 'running';
      }
      summaries.push({ scope_path: path, workflow_id: binding.workflow, status });
    }
  }
  return summaries;
}

/** Engine surface the executor relies on (avoids an import cycle). */
export interface ExecutionEngine {
  onStepStart: ((stepId: string, label: string) => void) | null;
  resolveInputs(definition: never, provided: Dict): Dict;
  mergeInputs(definition: never, previous: Dict, updates: Dict): Dict;
}

/** Run-state surface the executor relies on. */
export interface ExecutionState {
  workflowId: string;
  projectRoot: string;
  execution: Dict | null;
  checkpointFailed: boolean;
  currentStepIndex: number;
  currentStepId: string | null;
  stepResults: Record<string, Dict>;
  save(): void;
  appendLog(entry: Dict): void;
}

/** Create the private context for one bound workflow call. */
export function childContextForCall(parent: StepContext, binding: Dict, definition: Dict & { defaultIntegration?: unknown; defaultModel?: unknown; defaultOptions?: unknown }): StepContext {
  return new StepContext({
    inputs: binding.inputs as Dict,
    projectRoot: parent.projectRoot,
    runId: parent.runId,
    isResume: parent.isResume,
    insideFanOut: parent.insideFanOut,
    workflowDir: binding.workflow_dir as string | null,
    defaultIntegration: definition.defaultIntegration,
    defaultModel: definition.defaultModel,
    defaultOptions: definition.defaultOptions,
  });
}

/** Public result, distinct from the frozen result used to execute children. */
export function resultView(node: Dict): Dict {
  const result = node.result as Dict;
  if (has(node, 'fan_results')) {
    return { ...result, output: { ...(result.output as Dict), results: node.fan_results } };
  }
  return result;
}

/** One invocation, never stored on a shared step implementation. */
interface Occurrence {
  config: Dict;
  node: Dict;
  context: StepContext;
  ancestry: string[];
  path: Array<string | number>;
  public: boolean;
  qualified: string;
}

class SubtreeResult {
  constructor(
    readonly outcome: string,
    readonly error: string | null,
    readonly outputs: unknown[] | null = null,
  ) {}
}

class MissingImplementation {
  constructor(readonly error: string) {}
}

type Outcome = [string, string | null];

/** Traverses (and persists) one run's execution tree. */
export class Execution {
  readonly engine: ExecutionEngine;
  readonly state: ExecutionState;
  readonly registry: Map<string, StepBase>;
  readonly rebind: boolean;

  constructor(engine: ExecutionEngine, state: ExecutionState, registry: Map<string, StepBase>, opts: { rebind?: boolean } = {}) {
    this.engine = engine;
    this.state = state;
    this.registry = registry;
    this.rebind = opts.rebind ?? false;
  }

  /** Apply an occurrence result to its local and public views. */
  project(context: StepContext, name: string, result: Dict, isPublic: boolean, qualified: string): void {
    context.steps[name] = result;
    if (isPublic) {
      this.state.stepResults[name] = result;
      if (qualified !== name) {
        context.steps[qualified] = result;
        this.state.stepResults[qualified] = result;
      }
    }
  }

  /** Project a fan-out item result into its enclosing workflow scope. */
  projectAlias(context: StepContext, name: string, result: Dict): void {
    context.steps[name] = result;
  }

  /**
   * The only writer of occurrence progress and its checkpointed views. Phase
   * is the continuation point; ``active`` marks entry into that continuation.
   * The candidate is validated before memory or disk changes.
   */
  transition(
    operation: string,
    occurrence: Occurrence,
    changes: Dict | null = null,
    opts: { publish?: boolean; announce?: boolean } = {},
  ): void {
    const publish = opts.publish ?? false;
    const announce = opts.announce ?? true;
    const node = occurrence.node;
    if (this.state.checkpointFailed) throw new CheckpointError('A previous checkpoint failed');
    const [phases, fields] = TRANSITIONS[operation] as [ReadonlySet<string>, ReadonlySet<string>];
    if (!phases.has(node.phase as string)) {
      throw new ValueError(`Invalid ${operation} transition from ${pyStr(node.phase)}`);
    }
    const changeKeys = Object.keys(changes ?? {});
    if (changeKeys.some((k) => !fields.has(k))) throw new ValueError(`Invalid fields for ${operation} transition`);
    const candidate: Dict = { ...node, ...(changes ?? {}) };
    if (operation === 'expand' || operation === 'bind') candidate.phase = 'children';
    else if (operation === 'outputs') candidate.phase = 'outputs';
    else if (operation === 'finish' || operation === 'settle') {
      candidate.phase =
        candidate.outcome === 'completed' ? 'done' : operation === 'finish' ? 'blocked' : 'children';
    }
    if (operation === 'begin') {
      candidate.active = true;
      if (node.phase === 'blocked' && occurrence.config.type === 'workflow') {
        // A call's recorded result summarizes its previous attempt and is stale
        // once the call is re-entered: a bound call continues at its children,
        // an unbound call binds again from ready.
        for (const key of ['result', 'outcome', 'error']) delete candidate[key];
        candidate.phase = candidate.binding ? 'children' : 'ready';
      }
    } else if (operation === 'finish' || operation === 'settle' || operation === 'leave') {
      candidate.active = false;
    }
    const previous = (get(node, 'children', []) as unknown[]) ?? [];
    let newChildren: unknown[] = [];
    if (changes && has(changes, 'children')) {
      newChildren = (candidate.children as unknown[]).filter((child) => !previous.includes(child));
    }
    // The same node rules are checked when a checkpoint is loaded.
    checkNode(occurrence.config, candidate, new Set(changeKeys), newChildren);
    for (const key of Object.keys(node)) delete node[key];
    Object.assign(node, candidate);
    if (operation === 'begin') this.state.currentStepId = occurrence.qualified;
    if (publish && has(node, 'result')) {
      this.project(
        occurrence.context,
        occurrence.config.id as string,
        resultView(node),
        occurrence.public,
        occurrence.qualified,
      );
    }
    // Leave is memory-only and best-effort; the run-level handler checkpoints
    // the unwound tree on an exception.
    if (operation !== 'leave') this.state.save();
    if (announce) this.notify(operation, occurrence, publish);
  }

  /** Post-checkpoint notifications; never responsible for persistence. */
  notify(operation: string, occurrence: Occurrence, publish: boolean): void {
    const { config, node } = occurrence;
    const kind = pyStr(get(config, 'type', 'command'));
    if (operation === 'begin') {
      const command = get(config, 'command', '');
      const label = kind === 'workflow' ? kind : command ? pyStr(command) : kind;
      this.emit('step_started', occurrence, { type: kind }, label);
    } else if (operation === 'expand' || operation === 'finish') {
      const result = node.result as Dict;
      if (publish) this.emit('step_completed', occurrence, { status: result.status });
      if (result.status === 'failed') {
        const outcome = get(node, 'outcome', null);
        const event =
          outcome === 'aborted' ? 'workflow_aborted' : outcome === 'completed' ? 'step_continue_on_error' : 'step_failed';
        this.emit(event, occurrence, { error: get(result, 'error', null) ?? null });
      }
    }
  }

  /** Emit one step event and its optional start callback. */
  emit(event: string, occurrence: Occurrence, fields: Dict, callbackLabel: string | null = null): void {
    const entry: Dict = { event, step_id: occurrence.qualified, ...fields };
    if (occurrence.ancestry.length > 1) {
      entry.execution_path = [...occurrence.path];
      entry.workflow_id = occurrence.ancestry[occurrence.ancestry.length - 1];
    }
    this.state.appendLog(entry);
    if (callbackLabel !== null && this.engine.onStepStart !== null) {
      this.engine.onStepStart(occurrence.qualified, callbackLabel);
    }
  }

  async run(
    seq: Dict,
    context: StepContext,
    ancestry: string[],
    opts: {
      path?: Array<string | number>;
      public?: boolean;
      root?: boolean;
      loopAlias?: [string, number] | null;
      steps?: unknown;
    } = {},
  ): Promise<Outcome> {
    const path = opts.path ?? [];
    const steps = (opts.steps === undefined ? stepsOf(seq) : opts.steps) as Dict[];
    const nodes = seq.nodes as Dict[];
    const n = Math.min(steps.length, nodes.length);
    for (let index = 0; index < n; index++) {
      const config: Dict = { id: `step-${index}`, ...(steps[index] as Dict) };
      const node = nodes[index] as Dict;
      const name = pyStr(config.id);
      const qualified = qualifiedId(name, opts.loopAlias ?? null);
      if (opts.root && node.phase !== 'done') {
        this.state.currentStepIndex = index + ((get(this.state.execution ?? {}, 'offset', 0) as number) ?? 0);
      }
      const outcome = await this.step(config, node, context, ancestry, [...path, index], opts.public ?? true, qualified);
      if (HALTING.has(outcome)) return [outcome, (get(node, 'error', null) as string | null) ?? null];
    }
    return ['completed', null];
  }

  /** Run or replay persisted child sequences in order. */
  async runChildren(
    config: Dict,
    node: Dict,
    context: StepContext,
    ancestry: string[],
    path: Array<string | number>,
    isPublic: boolean,
    qualified: string,
  ): Promise<Outcome> {
    const kind = get(config, 'type', 'command');
    const children = (get(node, 'children', []) as Dict[]) ?? [];
    for (let iteration = 0; iteration < children.length; iteration++) {
      const [outcome, error] = await this.run(children[iteration] as Dict, context, ancestry, {
        path: [...path, iteration],
        public: isPublic,
        loopAlias: loopAliasFor(kind, qualified, iteration),
        steps: childSteps(config, node, iteration),
      });
      if (HALTING.has(outcome)) return [outcome, error];
    }
    return ['completed', null];
  }

  async step(
    config: Dict,
    node: Dict,
    context: StepContext,
    ancestry: string[],
    path: Array<string | number>,
    isPublic: boolean,
    qualified: string,
  ): Promise<string> {
    const name = pyStr(get(config, 'id', 'step-0'));
    const kind = get(config, 'type', 'command');
    if (node.phase === 'done') {
      this.project(context, name, resultView(node), isPublic, qualified);
      if (kind === 'fan-out' && (get(node, 'children', []) as unknown[]).length) {
        await this.fanOut(config, node, context, ancestry, path, isPublic, qualified, true);
      } else if (kind !== 'workflow' && kind !== 'fan-out') {
        await this.runChildren(config, node, context, ancestry, path, isPublic, qualified);
      }
      return 'completed';
    }
    if (get(node, 'outcome', null) === 'aborted') {
      // Replay the result the aborted occurrence projected when it ran.
      if (get(node, 'result', null) !== null && get(node, 'result', null) !== undefined) {
        this.project(context, name, resultView(node), isPublic, qualified);
      }
      return 'aborted';
    }

    const occurrence: Occurrence = { config, node, context, ancestry, path, public: isPublic, qualified };
    const calls = kind === 'workflow';
    try {
      // Workflow calls are announced on every entry, including resumed bound calls.
      this.transition('begin', occurrence, null, {
        announce: node.phase === 'ready' || node.phase === 'blocked' || calls,
      });
      const result = calls ? await this.workflow(occurrence) : await this.executeStep(occurrence);
      return this.finish(occurrence, result);
    } catch (exc) {
      if (node.active) {
        try {
          this.transition('leave', occurrence);
        } catch {
          // A crash-shaped active node is valid on resume.
        }
      }
      throw exc;
    }
  }

  async executeStep(occurrence: Occurrence): Promise<StepResult | SubtreeResult | MissingImplementation> {
    const { config, node, context, ancestry, path, qualified } = occurrence;
    const isPublic = occurrence.public;
    const name = pyStr(config.id);
    const kind = pyStr(get(config, 'type', 'command'));

    if (node.phase === 'ready' || node.phase === 'blocked') {
      const impl = this.registry.get(kind);
      if (impl === undefined) {
        // Terminal: only step_failed, no projected result. The node keeps its
        // result so resume can retry after reinstalling.
        return new MissingImplementation(unknownStepError(kind));
      }
      let result = await impl.execute(config, context);
      const expansion: Dict = {};
      let template: unknown = {};
      if (kind === 'fan-out') {
        // Definitions belong to the tree, never to JSON result records.
        const output: Dict = { ...result.output };
        template = has(output, 'step_template') ? output.step_template : {};
        delete output.step_template;
        expansion.template = dumpYaml(template, { sortKeys: false });
        result = new StepResult({ status: result.status, output, nextSteps: result.nextSteps, error: result.error });
      }
      if (result.status === StepStatus.FAILED || result.status === StepStatus.PAUSED) return result;
      let children: Seq[] = result.nextSteps.length ? [sequence(result.nextSteps)] : [];
      if (kind === 'fan-out') {
        const items = get(result.output, 'items', []);
        children =
          isDict(template) && Object.keys(template).length && Array.isArray(items)
            ? items.map(() => occurrences([template]))
            : [];
      }
      const data = Execution.record(config, result, context);
      if (!children.length) {
        if (kind === 'fan-out') result.output = { ...result.output, results: [] };
        return result;
      }
      this.transition('expand', occurrence, { result: data, children, ...expansion }, { publish: true });
    } else {
      this.project(context, name, resultView(node), isPublic, qualified);
    }

    let outcome: string;
    let error: string | null;
    let outputs: unknown[] | null = null;
    if (kind === 'fan-out') {
      [outcome, error, outputs] = await this.fanOut(config, node, context, ancestry, path, isPublic, qualified);
    } else {
      [outcome, error] = await this.runChildren(config, node, context, ancestry, path, isPublic, qualified);
      if (outcome === 'completed' && LOOP_TYPES.has(kind)) {
        let limit = get(config, 'max_iterations', 10);
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) limit = 10;
        while (
          (node.children as Dict[]).length < (limit as number) &&
          evaluateCondition(get(config, 'condition', false), context)
        ) {
          const child = occurrences(stepsOf((node.children as Dict[])[0] as Dict) as unknown[]);
          this.transition('iterate', occurrence, { children: [...(node.children as Dict[]), child] });
          const iteration = (node.children as Dict[]).length - 1;
          [outcome, error] = await this.run(child, context, ancestry, {
            path: [...path, iteration],
            public: isPublic,
            loopAlias: loopAliasFor(kind, qualified, iteration),
            steps: childSteps(config, node, iteration),
          });
          if (HALTING.has(outcome)) break;
        }
      }
    }
    return new SubtreeResult(outcome, error, kind === 'fan-out' ? outputs : null);
  }

  /** The persisted per-step record (prefers resolved values from the output). */
  static record(config: Dict, result: StepResult, context: StepContext): Dict {
    const output = result.output;
    const truthy = pyTruthy;
    const pick = (outKey: string, fallback: unknown): unknown => {
      const a = get(output, outKey, null);
      if (truthy(a)) return a;
      const b = get(config, outKey, null);
      if (truthy(b)) return b;
      return fallback ?? null;
    };
    const data: Dict = {
      type: get(config, 'type', 'command'),
      integration: pick('integration', context.defaultIntegration),
      model: pick('model', context.defaultModel),
      options: truthy(get(output, 'options', null)) ? output.options : get(config, 'options', {}),
      input: truthy(get(output, 'input', null)) ? output.input : get(config, 'input', {}),
      output,
      status: result.status,
      error: result.error,
    };
    if (config.type === 'workflow') {
      // A call result exposes neither caller defaults nor private inputs.
      Object.assign(data, { integration: null, model: null, options: {}, input: {} });
    }
    if (data.type === 'command' && has(output, 'integration_args')) {
      data.integration_args = output.integration_args;
      data.integration_options = output.integration_options;
    }
    return data;
  }

  finish(occurrence: Occurrence, resultIn: StepResult | SubtreeResult | MissingImplementation): string {
    const { config, context } = occurrence;
    if (resultIn instanceof SubtreeResult) {
      this.transition(
        'settle',
        occurrence,
        {
          outcome: resultIn.outcome,
          error: resultIn.error,
          ...(resultIn.outputs !== null ? { fan_results: resultIn.outputs } : {}),
        },
        { publish: resultIn.outputs !== null },
      );
      return resultIn.outcome;
    }
    const missing = resultIn instanceof MissingImplementation;
    const result = missing
      ? new StepResult({ status: StepStatus.FAILED, error: (resultIn as MissingImplementation).error })
      : (resultIn as StepResult);
    let outcome = 'completed';
    if (result.status === StepStatus.PAUSED) outcome = 'paused';
    else if (result.status === StepStatus.FAILED) {
      outcome = pyTruthy(get(result.output, 'aborted', null)) ? 'aborted' : 'failed';
      if (!missing && outcome === 'failed' && get(config, 'continue_on_error', null) === true) outcome = 'completed';
    }
    this.transition(
      'finish',
      occurrence,
      { result: Execution.record(config, result, context), outcome, error: result.error },
      { publish: !missing },
    );
    return outcome;
  }

  async workflow(occurrence: Occurrence): Promise<StepResult> {
    const { WorkflowDefinition, workflowDirFor } = await import('./engine.js');
    const { config, node, context, ancestry, path } = occurrence;
    let binding = get(node, 'binding', null) as Dict | null;
    let target: unknown = binding ? binding.workflow : get(config, 'workflow', null);
    let definition: InstanceType<typeof WorkflowDefinition>;
    if (!binding) {
      try {
        validateRuntimeCall(config);
        target = evaluateExpression(target, context);
        definition = await resolveTarget(this.state.projectRoot, target, ancestry);
        binding = {
          workflow: target,
          definition: dumpYaml(definition.data, { sortKeys: false }),
          inputs: bindInputs(this.engine, definition, config, context),
          workflow_dir: workflowDirFor(definition),
        };
        this.transition('bind', occurrence, {
          binding,
          children: [occurrences(Array.isArray(definition.steps) ? definition.steps : [])],
        });
      } catch (exc) {
        if (!(exc instanceof CallError)) throw exc;
        const shown = typeof target === 'string' ? target : pyRepr(target);
        return new StepResult({
          status: StepStatus.FAILED,
          output: { workflow: shown, status: 'failed', error: exc.message },
          error: exc.message,
        });
      }
    } else {
      definition = new WorkflowDefinition(parseYaml(binding.definition as string) as Dict);
      if (this.rebind) {
        const inputs = bindInputs(this.engine, definition, config, context, binding.inputs as Dict);
        binding = { ...binding, inputs };
        this.transition('rebind', occurrence, { binding });
      }
    }
    const childContext = childContextForCall(context, binding, definition as unknown as Dict);
    const [outcome, error] = await this.run((node.children as Dict[])[0] as Dict, childContext, [...ancestry, pyStr(target)], {
      path: [...path, 'workflow'],
      public: false,
      steps: childSteps(config, node, 0),
    });
    const output: Dict = { workflow: target, status: outcome };
    if (outcome === 'completed') {
      this.transition('outputs', occurrence);
      try {
        Object.assign(output, evaluateOutputs(definition, childContext));
      } catch (exc) {
        if (!(exc instanceof CallError)) throw exc;
        Object.assign(output, { status: 'failed', error: exc.message });
        return new StepResult({ status: StepStatus.FAILED, output, error: exc.message });
      }
    } else if (outcome === 'aborted') {
      output.aborted = true;
    }
    if (error !== null) output.error = error;
    const status =
      outcome === 'completed' ? StepStatus.COMPLETED : outcome === 'paused' ? StepStatus.PAUSED : StepStatus.FAILED;
    return new StepResult({ status, output, error });
  }

  async fanOut(
    config: Dict,
    node: Dict,
    context: StepContext,
    ancestry: string[],
    path: Array<string | number>,
    isPublic: boolean,
    qualified: string,
    sequential = false,
  ): Promise<[string, string | null, unknown[]]> {
    const output = (node.result as Dict).output as Dict;
    const items = (get(output, 'items', []) as unknown[]) ?? [];
    let workers = pyIntOrNull(get(output, 'max_concurrency', 1));
    workers = workers === null ? 1 : Math.max(1, workers);
    if (sequential) workers = 1;
    workers = Math.min(workers, items.length);
    const initial = deepcopy(context.steps);
    // Children always consume the frozen expansion result. Aggregate outputs
    // belong to the reporting view, never to the item execution context.
    for (const key of new Set([pyStr(get(config, 'id', 'step-0')), qualified])) {
      if (has(initial, key)) initial[key] = deepcopy(node.result as Dict);
    }
    let halted = false;
    const templateName = pyStr(((childSteps(config, node, 0) as Dict[])[0] as Dict).id);

    const runItem = async (index: number): Promise<[string, string | null, unknown]> => {
      const local = context.replace({ steps: deepcopy(initial), item: items[index], insideFanOut: true });
      const inherited = local.steps[templateName];
      const child = (node.children as Dict[])[index] as Dict;
      const [outcome, error] = await this.run(child, local, ancestry, {
        path: [...path, 'item', index],
        public: false,
        loopAlias: [qualified, index],
        steps: childSteps(config, node, index),
      });
      if (HALTING.has(outcome)) halted = true;
      const first = (child.nodes as Dict[])[0] as Dict;
      let record: Dict | null = isDict(get(first, 'result', null)) ? resultView(first) : null;
      // Expose only results projected by the item traversal. Missing step
      // implementations keep an internal retry record but publish nothing.
      if (local.steps[templateName] === inherited) record = null;
      if (record !== null) {
        const alias = `${qualified}:${templateName}:${index}`;
        this.projectAlias(context, alias, record);
        if (isPublic) this.state.stepResults[alias] = record;
      }
      return [outcome, error, record !== null ? get(record, 'output', {}) : {}];
    };

    const results: unknown[] = [];
    if (workers <= 1) {
      for (let index = 0; index < items.length; index++) {
        const [outcome, error, value] = await runItem(index);
        results.push(value);
        if (HALTING.has(outcome)) return [outcome, error, results];
      }
      return ['completed', null, results];
    }

    let release: (() => void) | null = null;
    type Settled = { ok: true; value: [string, string | null, unknown] } | { ok: false; error: unknown };
    const inFlight = new Map<number, Promise<Settled>>();
    const submit = (index: number): void => {
      inFlight.set(
        index,
        runItem(index).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => {
            halted = true;
            return { ok: false as const, error };
          },
        ),
      );
    };
    try {
      for (let i = 0; i < workers; i++) submit(i);
      for (let index = 0; index < items.length; index++) {
        const fut = inFlight.get(index) as Promise<Settled>;
        inFlight.delete(index);
        const settled = await fut;
        if (!settled.ok) throw settled.error;
        const [outcome, error, value] = settled.value;
        results.push(value);
        if (HALTING.has(outcome)) return [outcome, error, results];
        const following = index + workers;
        if (following < items.length && !halted) submit(following);
      }
    } catch (exc) {
      // A worker's capture would run on while we wait for the others; stop
      // the captured processes before joining (upstream _shutdown_workers).
      if ((exc as Error)?.name === 'KeyboardInterrupt') release = cancelCaptures();
      throw exc;
    } finally {
      try {
        await Promise.all(inFlight.values());
      } finally {
        release?.();
      }
    }
    return ['completed', null, results];
  }
}

/** Python ``int(x)`` for ``max_concurrency`` coercion (``null`` on failure). */
function pyIntOrNull(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string') {
    const s = value.trim();
    return /^[+-]?\d+(?:_\d+)*$/.test(s) ? parseInt(s.replace(/_/g, ''), 10) : null;
  }
  return null;
}

/** ``RunStatus(outcome)`` for a traversal outcome. */
export function runStatusFor(outcome: string): RunStatus {
  return outcome === 'completed' ? RunStatus.RUNNING : toRunStatus(outcome);
}
