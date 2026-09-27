/**
 * @oakoliver/specify-cli - Workflow Engine
 *
 * Port of ``specify_cli/workflows/engine.py``. The engine is the orchestrator
 * that:
 * - Parses workflow YAML definitions
 * - Validates step configurations and requirements
 * - Executes steps sequentially, dispatching to the correct step type
 * - Manages state persistence for resume capability
 * - Handles control flow (branching, loops, fan-out/fan-in)
 *
 * @module workflows/engine
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as pathResolve } from 'node:path';

import {
  FileNotFoundError,
  KeyboardInterrupt,
  RunStatus,
  StepBase,
  StepContext,
  StepResult,
  StepStatus,
  ValueError,
  dget,
  dhas,
  errorMessage,
  isDict,
  isInt,
  pyContains,
  pyEquals,
  pyJsonDumps,
  pyParseFloat,
  pyParseInt,
  pyRepr,
  pyStr,
  pyTruthy,
  pyTypeName,
  toRunStatus,
  utcIsoNow,
  type Dict,
} from './base.js';
import { evaluateCondition } from './expressions.js';
import { STEP_REGISTRY } from './index.js';
import { WorkflowResolver } from './overlay/resolver.js';
import { dumpYaml, parseYaml, YAMLError } from '../yaml.js';
import { defaultIntegrationKey, tryReadIntegrationJson } from '../integration-state.js';

// ============================================================================
// Workflow Definition
// ============================================================================

/** Python ``Path(p).expanduser()``. */
function expandUser(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function yamlErrorText(exc: unknown): string {
  return errorMessage(exc);
}

/** Parsed and validated workflow YAML definition. */
export class WorkflowDefinition {
  data: Dict;
  sourcePath: string | null;
  id: unknown;
  name: unknown;
  version: unknown;
  author: unknown;
  description: unknown;
  schemaVersion: unknown;
  defaultIntegration: unknown;
  defaultModel: unknown;
  defaultOptions: unknown;
  /**
   * Advisory pre-conditions (spec-kit version / integrations). Holds the raw
   * parsed value (may be a non-mapping before ``validateWorkflow`` runs).
   */
  requires: unknown;
  inputs: unknown;
  steps: unknown;

  constructor(data: Dict, sourcePath: string | null = null) {
    this.data = data;
    this.sourcePath = sourcePath;

    let workflow = dget(data, 'workflow', {});
    if (!isDict(workflow)) workflow = {};
    const wf = workflow as Dict;
    this.id = dget(wf, 'id', '');
    this.name = dget(wf, 'name', '');
    this.version = dget(wf, 'version', '0.0.0');
    this.author = dget(wf, 'author', '');
    this.description = dget(wf, 'description', '');
    this.schemaVersion = dget(data, 'schema_version', '1.0');

    this.defaultIntegration = dget(wf, 'integration', null);
    this.defaultModel = dget(wf, 'model', null);
    const rawDefaultOptions = dget(wf, 'options', null);
    this.defaultOptions = rawDefaultOptions === null || rawDefaultOptions === undefined ? {} : rawDefaultOptions;

    this.requires = dget(data, 'requires', {});
    this.inputs = dget(data, 'inputs', {});
    this.steps = dget(data, 'steps', []);
  }

  /** Load a workflow definition from a YAML file. */
  static fromYaml(path: string): WorkflowDefinition {
    const text = readFileSync(path, 'utf8');
    let data: unknown;
    try {
      data = parseYaml(text);
    } catch (exc) {
      if (exc instanceof YAMLError) throw new ValueError(`Invalid YAML in ${path}: ${yamlErrorText(exc)}`);
      throw exc;
    }
    if (!isDict(data)) {
      throw new ValueError(`Workflow YAML must be a mapping, got ${pyTypeName(data)}.`);
    }
    return new WorkflowDefinition(data, path);
  }

  /** Load a workflow definition from a YAML string. */
  static fromString(content: string): WorkflowDefinition {
    let data: unknown;
    try {
      data = parseYaml(content);
    } catch (exc) {
      if (exc instanceof YAMLError) throw new ValueError(`Invalid YAML: ${yamlErrorText(exc)}`);
      throw exc;
    }
    if (!isDict(data)) {
      throw new ValueError(`Workflow YAML must be a mapping, got ${pyTypeName(data)}.`);
    }
    return new WorkflowDefinition(data);
  }
}

// ============================================================================
// Workflow Validation
// ============================================================================

/** ID format: lowercase alphanumeric with hyphens. */
export const ID_PATTERN = /^(?:[a-z0-9][a-z0-9-]*[a-z0-9]|[a-z0-9])$/;

/**
 * Keys accepted under a workflow's ``requires`` block (advisory
 * pre-conditions). Any other key — notably ``permissions`` — is rejected.
 */
const RECOGNIZED_REQUIRES_KEYS = ['integrations', 'speckit_version'] as const;

/** Valid step types from the registry, with a built-in fallback. */
function getValidStepTypes(): Set<string> {
  if (STEP_REGISTRY.size) return new Set(STEP_REGISTRY.keys());
  return new Set([
    'command', 'shell', 'prompt', 'gate', 'if', 'init', 'slot',
    'switch', 'while', 'do-while', 'fan-out', 'fan-in',
  ]);
}

/** Return validation errors for workflow defaults inherited by dispatch steps. */
export function dispatchDefaultErrors(definition: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const di = definition.defaultIntegration;
  if (di !== null && di !== undefined && typeof di !== 'string') {
    errors.push(`'workflow.integration' must be a string or null, got ${pyTypeName(di)} (${pyRepr(di)}).`);
  }
  const dm = definition.defaultModel;
  if (dm !== null && dm !== undefined && typeof dm !== 'string') {
    errors.push(`'workflow.model' must be a string or null, got ${pyTypeName(dm)} (${pyRepr(dm)}).`);
  }
  if (!isDict(definition.defaultOptions)) {
    errors.push(
      `'workflow.options' must be a mapping or null, got ${pyTypeName(definition.defaultOptions)} ` +
        `(${pyRepr(definition.defaultOptions)}).`,
    );
  }
  return errors;
}

/**
 * Validate a workflow definition and return a list of error messages.
 * An empty list means the workflow is valid.
 */
export function validateWorkflow(definition: WorkflowDefinition): string[] {
  const errors: string[] = [];

  if (pyStr(definition.schemaVersion) !== '1.0') {
    errors.push(`Unsupported schema_version ${pyRepr(definition.schemaVersion)}. Expected '1.0'.`);
  }

  const id = definition.id;
  if (id === null || id === undefined || id === '') {
    errors.push("Workflow is missing 'workflow.id'.");
  } else if (typeof id !== 'string') {
    errors.push(`'workflow.id' must be a string, got ${pyTypeName(id)} (${pyRepr(id)}).`);
  } else if (!ID_PATTERN.test(id)) {
    errors.push(`Workflow ID ${pyRepr(id)} must be lowercase alphanumeric with hyphens.`);
  }

  const name = definition.name;
  if (name === null || name === undefined || name === '') {
    errors.push("Workflow is missing 'workflow.name'.");
  } else if (typeof name !== 'string') {
    errors.push(`'workflow.name' must be a string, got ${pyTypeName(name)} (${pyRepr(name)}).`);
  }

  const version = definition.version;
  if (version === null || version === undefined || version === '') {
    errors.push("Workflow is missing 'workflow.version'.");
  } else if (typeof version !== 'string') {
    errors.push(
      `'workflow.version' must be a string, got ${pyTypeName(version)} (${pyRepr(version)}) — ` +
        'quote it in YAML (version: "1.0.0").',
    );
  } else if (!/^\d+\.\d+\.\d+$/.test(version)) {
    errors.push(`Workflow version ${pyRepr(version)} is not valid semantic versioning (expected X.Y.Z).`);
  }

  errors.push(...dispatchDefaultErrors(definition));

  // -- Inputs -----------------------------------------------------------
  if (!isDict(definition.inputs)) {
    errors.push("'inputs' must be a mapping (or omitted).");
  } else {
    for (const [inputName, inputDef] of Object.entries(definition.inputs)) {
      if (!isDict(inputDef)) {
        errors.push(`Input ${pyRepr(inputName)} must be a mapping.`);
        continue;
      }
      const inputType = dget(inputDef, 'type', null);
      if (pyTruthy(inputType) && !['string', 'number', 'boolean'].includes(inputType as string)) {
        errors.push(
          `Input ${pyRepr(inputName)} has invalid type ${pyRepr(inputType)}. ` +
            "Must be 'string', 'number', or 'boolean'.",
        );
      }

      const enumValues = dget(inputDef, 'enum', null);
      if (enumValues !== null && enumValues !== undefined && !Array.isArray(enumValues)) {
        errors.push(`Input ${pyRepr(inputName)} has invalid 'enum': must be a list, got ${pyTypeName(enumValues)}.`);
      }

      const enumIsValid = enumValues === null || enumValues === undefined || Array.isArray(enumValues);
      if (dhas(inputDef, 'default')) {
        const defaultValue = inputDef.default;
        const isAutoIntegration = inputName === 'integration' && defaultValue === 'auto';
        const stripEnum = isAutoIntegration || !enumIsValid;
        let validationInputDef: Dict = inputDef;
        if (stripEnum && dhas(inputDef, 'enum')) {
          validationInputDef = Object.fromEntries(Object.entries(inputDef).filter(([k]) => k !== 'enum'));
        }
        try {
          WorkflowEngine.coerceInput(inputName, defaultValue, validationInputDef);
        } catch (exc) {
          if (!(exc instanceof ValueError)) throw exc;
          errors.push(`Input ${pyRepr(inputName)} has invalid default: ${exc.message}`);
        }
      }
    }
  }

  // -- Requires ---------------------------------------------------------
  if (!isDict(definition.requires)) {
    errors.push("'requires' must be a mapping (or omitted).");
  } else {
    for (const key of Object.keys(definition.requires)) {
      if (key === 'permissions') {
        errors.push(
          "'requires.permissions' is not a recognized or " +
            'enforced capability gate — shell steps always run ' +
            "with the user's privileges. Remove it and gate " +
            "sensitive steps with a 'gate' step instead.",
        );
      } else if (!(RECOGNIZED_REQUIRES_KEYS as readonly string[]).includes(key)) {
        errors.push(
          `Unknown 'requires' key ${pyRepr(key)}. Recognized keys: ` +
            `${[...RECOGNIZED_REQUIRES_KEYS].sort().join(', ')}.`,
        );
      }
    }
  }

  // -- Steps ------------------------------------------------------------
  if (!Array.isArray(definition.steps)) {
    errors.push("'steps' must be a list.");
    return errors;
  }
  if (!definition.steps.length) errors.push('Workflow has no steps defined.');

  const seenIds = new Set<string>();
  const inputDefs: Dict | null = isDict(definition.inputs) ? { ...definition.inputs } : null;
  validateSteps(definition.steps, seenIds, errors, inputDefs);
  return errors;
}

/** Recursively validate a list of steps. */
function validateSteps(
  steps: unknown[],
  seenIds: Set<string>,
  errors: string[],
  inputDefs: Dict | null = null,
  insideFanOut = false,
): void {
  for (const stepConfig of steps) {
    if (!isDict(stepConfig)) {
      errors.push(`Step must be a mapping, got ${pyTypeName(stepConfig)}.`);
      continue;
    }

    const stepId = dget(stepConfig, 'id', null);
    if (stepId === null || stepId === undefined || stepId === '') {
      errors.push("Step is missing 'id' field.");
      continue;
    }
    if (typeof stepId !== 'string') {
      errors.push(`Step ID must be a string, got ${pyTypeName(stepId)} (${pyRepr(stepId)}).`);
      continue;
    }

    if (stepId.includes(':')) {
      errors.push(
        `Step ID ${pyRepr(stepId)} contains ':' which is reserved ` +
          'for engine-generated nested IDs (parentId:childId).',
      );
    }

    if (seenIds.has(stepId)) errors.push(`Duplicate step ID ${pyRepr(stepId)}.`);
    seenIds.add(stepId);

    const stepType = dget(stepConfig, 'type', 'command');
    if (typeof stepType !== 'string') {
      errors.push(`Step ${pyRepr(stepId)}: 'type' must be a string, got ${pyTypeName(stepType)} (${pyRepr(stepType)}).`);
      continue;
    }
    if (!getValidStepTypes().has(stepType)) {
      errors.push(`Step ${pyRepr(stepId)} has invalid type ${pyRepr(stepType)}.`);
      continue;
    }

    const stepImpl = STEP_REGISTRY.get(stepType);
    if (stepImpl) errors.push(...stepImpl.validate(stepConfig));

    if (stepType === 'slot' && insideFanOut) {
      errors.push(
        `Slot step ${pyRepr(stepId)} is not supported inside fan-out ` +
          'templates because overlays cannot address runtime-multiplied ' +
          'templates.',
      );
    }

    if (dhas(stepConfig, 'continue_on_error')) {
      const coe = stepConfig.continue_on_error;
      if (typeof coe !== 'boolean') {
        errors.push(`Step ${pyRepr(stepId)}: 'continue_on_error' must be a boolean, got ${pyTypeName(coe)}.`);
      }
    }

    if (stepType === 'fan-in') {
      const waitFor = dget(stepConfig, 'wait_for', null);
      if (Array.isArray(waitFor)) {
        for (const wid of waitFor) {
          if (typeof wid !== 'string') {
            errors.push(
              `Fan-in step ${pyRepr(stepId)}: 'wait_for' entries must ` +
                `be step-id strings, got ${pyTypeName(wid)} (${pyRepr(wid)}).`,
            );
          } else if (wid === stepId) {
            errors.push(
              `Fan-in step ${pyRepr(stepId)}: 'wait_for' references ` +
                'itself; a fan-in cannot wait for its own results.',
            );
          } else if (!seenIds.has(wid)) {
            errors.push(
              `Fan-in step ${pyRepr(stepId)}: 'wait_for' references ` +
                `unknown or not-yet-declared step id ${pyRepr(wid)}.`,
            );
          }
        }
      }
    }

    if (stepType === 'gate') {
      const verdictInput = dget(stepConfig, 'verdict_input', null);
      if (typeof verdictInput === 'string' && verdictInput) {
        if (insideFanOut) {
          errors.push(`Gate step ${pyRepr(stepId)}: 'verdict_input' is not supported inside fan-out templates.`);
        } else if (inputDefs !== null && !dhas(inputDefs, verdictInput)) {
          errors.push(
            `Gate step ${pyRepr(stepId)}: 'verdict_input' references undeclared input ${pyRepr(verdictInput)}.`,
          );
        } else if (inputDefs !== null) {
          const verdictDef = inputDefs[verdictInput];
          const enumValues = isDict(verdictDef) ? dget(verdictDef, 'enum', null) : null;
          if (
            dget(stepConfig, 'on_reject', null) === 'retry' &&
            Array.isArray(enumValues) &&
            !enumValues.some((v) => pyEquals(v, ''))
          ) {
            errors.push(
              `Gate step ${pyRepr(stepId)}: on_reject='retry' resets ` +
                `verdict input ${pyRepr(verdictInput)} to '' when the ` +
                "gate is rejected, but that input's 'enum' does " +
                "not allow ''. Add '' to the enum or use " +
                "on_reject='abort'/'skip'.",
            );
          }
        }
      }
    }

    for (const nestedKey of ['then', 'else', 'steps']) {
      const nested = dget(stepConfig, nestedKey, null);
      if (Array.isArray(nested)) validateSteps(nested, seenIds, errors, inputDefs, insideFanOut);
    }

    const cases = dget(stepConfig, 'cases', null);
    if (isDict(cases)) {
      for (const caseSteps of Object.values(cases)) {
        if (Array.isArray(caseSteps)) validateSteps(caseSteps, seenIds, errors, inputDefs, insideFanOut);
      }
    }

    const def = dget(stepConfig, 'default', null);
    if (Array.isArray(def)) validateSteps(def, seenIds, errors, inputDefs, insideFanOut);

    const fanStep = dget(stepConfig, 'step', null);
    if (isDict(fanStep)) {
      const fanErrors: string[] = [];
      validateSteps([fanStep], new Set(), fanErrors, inputDefs, true);
      errors.push(...fanErrors);
    }
  }
}

// ============================================================================
// Run State Persistence
// ============================================================================

/** Write *data* as indented JSON to *path* atomically (temp + rename). */
function atomicWriteJson(path: string, data: Dict): void {
  const dir = dirname(path);
  const base = path.slice(dir.length + 1);
  const tmp = join(dir, `.${base}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, pyJsonDumps(data, 2), { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, path);
  } catch (exc) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw exc;
  }
}

/** ``json.load`` with a ValueError on malformed content (JSONDecodeError). */
function loadJsonFile(path: string): unknown {
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch (exc) {
    throw new ValueError(errorMessage(exc));
  }
}

/** Constructor options for {@link RunState}. */
export interface RunStateInit {
  runId?: string | null;
  workflowId?: string;
  projectRoot?: string | null;
  installedWorkflowId?: string | null;
  installedRegistryRoot?: string | null;
  installedOriginTracked?: boolean;
}

/** Manages workflow run state for persistence and resume. */
export class RunState {
  /**
   * ``run_id`` is interpolated into a filesystem path (``runs/<run_id>``);
   * constrain it to a charset that cannot contain path separators.
   */
  static RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

  runId: string;
  workflowId: string;
  projectRoot: string;
  installedWorkflowId: string | null;
  installedRegistryRoot: string | null;
  installedOriginTracked: boolean;
  status: RunStatus;
  currentStepIndex: number;
  currentStepId: string | null;
  stepResults: Record<string, Dict>;
  inputs: Dict;
  workflowDir: string | null;
  createdAt: string;
  updatedAt: string;
  logEntries: Dict[];
  error: string | null;

  /** Raise ``ValueError`` if ``runId`` is not a safe path component. */
  static validateRunId(runId: unknown): void {
    if (typeof runId !== 'string' || !RunState.RUN_ID_PATTERN.test(runId)) {
      throw new ValueError(
        `Invalid run_id ${pyRepr(runId)}: must be alphanumeric with ` +
          'hyphens/underscores only (and must start with an ' +
          'alphanumeric character).',
      );
    }
  }

  /** Validate persisted installed-workflow ownership metadata. */
  static validateInstalledOrigin(installedWorkflowId: unknown, installedRegistryRoot: unknown): void {
    if (installedWorkflowId !== null && installedWorkflowId !== undefined) {
      if (typeof installedWorkflowId !== 'string') {
        throw new ValueError(
          "Invalid run state: 'installed_workflow_id' must be a " +
            `string or null, got ${pyTypeName(installedWorkflowId)}`,
        );
      }
      if (!ID_PATTERN.test(installedWorkflowId)) {
        throw new ValueError(
          "Invalid run state: 'installed_workflow_id' must be a " +
            'lowercase alphanumeric workflow ID with hyphens',
        );
      }
    }
    if (installedRegistryRoot !== null && installedRegistryRoot !== undefined) {
      if (typeof installedRegistryRoot !== 'string') {
        throw new ValueError(
          "Invalid run state: 'installed_registry_root' must be a " +
            `string or null, got ${pyTypeName(installedRegistryRoot)}`,
        );
      }
      if (!installedRegistryRoot || !isAbsolute(installedRegistryRoot)) {
        throw new ValueError("Invalid run state: 'installed_registry_root' must be an absolute path or null");
      }
      if (installedWorkflowId === null || installedWorkflowId === undefined) {
        throw new ValueError("Invalid run state: 'installed_registry_root' requires 'installed_workflow_id'");
      }
    }
  }

  constructor(init: RunStateInit = {}) {
    // ``runId`` omitted → auto-generate. An explicit empty string is
    // validated like any other caller-provided value.
    this.runId = init.runId === null || init.runId === undefined ? randomUUID().slice(0, 8) : init.runId;
    RunState.validateRunId(this.runId);
    RunState.validateInstalledOrigin(init.installedWorkflowId ?? null, init.installedRegistryRoot ?? null);
    this.workflowId = init.workflowId ?? '';
    this.projectRoot = init.projectRoot || '.';
    this.installedWorkflowId = init.installedWorkflowId ?? null;
    this.installedRegistryRoot = init.installedRegistryRoot ?? null;
    this.installedOriginTracked = init.installedOriginTracked ?? true;
    this.status = RunStatus.CREATED;
    this.currentStepIndex = 0;
    this.currentStepId = null;
    this.stepResults = {};
    this.inputs = {};
    this.workflowDir = null;
    this.createdAt = utcIsoNow();
    this.updatedAt = this.createdAt;
    this.logEntries = [];
    this.error = null;
  }

  get runsDir(): string {
    return join(this.projectRoot, '.specify', 'workflows', 'runs', this.runId);
  }

  /** Record one step's result. */
  recordStepResult(stepId: string, data: Dict): void {
    this.stepResults[stepId] = data;
  }

  /** Replace an already-recorded step's ``output``. */
  setStepOutput(stepId: string, output: unknown): void {
    const rec = this.stepResults[stepId];
    if (rec !== undefined) rec.output = output;
  }

  /** Persist current state to disk (atomically). */
  save(): void {
    const runsDir = this.runsDir;
    mkdirSync(runsDir, { recursive: true });
    this.updatedAt = utcIsoNow();
    const stateData: Dict = {
      run_id: this.runId,
      workflow_id: this.workflowId,
      installed_workflow_id: this.installedWorkflowId,
      installed_registry_root: this.installedRegistryRoot,
      status: this.status,
      current_step_index: this.currentStepIndex,
      current_step_id: this.currentStepId,
      step_results: this.stepResults,
      workflow_dir: this.workflowDir,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
      error: this.error,
    };
    atomicWriteJson(join(runsDir, 'state.json'), stateData);
    atomicWriteJson(join(runsDir, 'inputs.json'), { inputs: this.inputs });
  }

  /** Load a run state from disk. */
  static load(runId: string, projectRoot: string): RunState {
    RunState.validateRunId(runId);
    const runsDir = join(projectRoot, '.specify', 'workflows', 'runs', runId);
    const statePath = join(runsDir, 'state.json');

    let stateData: unknown;
    try {
      stateData = loadJsonFile(statePath);
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileNotFoundError(`Run state not found: ${statePath}`);
      }
      throw exc;
    }
    if (!isDict(stateData)) throw new ValueError('Invalid run state: expected a JSON object');
    const missing = ['run_id', 'workflow_id', 'status'].filter((f) => !dhas(stateData as Dict, f));
    if (missing.length) {
      throw new ValueError('Invalid run state: missing required field(s): ' + missing.join(', '));
    }
    if (!pyEquals(stateData.run_id, runId)) {
      throw new ValueError(
        `Invalid run state: stored run_id ${pyRepr(stateData.run_id)} ` +
          `does not match requested run_id ${pyRepr(runId)}`,
      );
    }

    const workflowId = stateData.workflow_id;
    if (typeof workflowId !== 'string' || !ID_PATTERN.test(workflowId)) {
      throw new ValueError(
        "Invalid run state: 'workflow_id' must be a lowercase " + 'alphanumeric workflow ID with hyphens',
      );
    }

    const hasInstalledWorkflowId = dhas(stateData, 'installed_workflow_id');
    const hasInstalledRegistryRoot = dhas(stateData, 'installed_registry_root');
    if (hasInstalledWorkflowId !== hasInstalledRegistryRoot) {
      throw new ValueError(
        'Invalid run state: installed workflow origin fields must ' + 'either both be present or both be absent',
      );
    }

    const installedWorkflowId = dget(stateData, 'installed_workflow_id', null);
    const installedRegistryRoot = dget(stateData, 'installed_registry_root', null);

    const stepResults = dget(stateData, 'step_results', {});
    if (!isDict(stepResults)) {
      throw new ValueError("Invalid run state: 'step_results' must be a JSON object");
    }
    for (const [stepId, result] of Object.entries(stepResults)) {
      if (!isDict(result)) {
        throw new ValueError(`Invalid run state: step_results record ${pyRepr(stepId)} must be a JSON object`);
      }
    }

    const state = new RunState({
      runId: stateData.run_id as string,
      workflowId,
      projectRoot,
      installedWorkflowId: installedWorkflowId as string | null,
      installedRegistryRoot: installedRegistryRoot as string | null,
      installedOriginTracked: hasInstalledWorkflowId,
    });
    state.status = toRunStatus(stateData.status);

    const currentStepIndex = dget(stateData, 'current_step_index', 0);
    if (!isInt(currentStepIndex) || currentStepIndex < 0) {
      throw new ValueError(
        "Invalid run state: 'current_step_index' must be a " +
          `non-negative integer, got ${pyRepr(currentStepIndex)}`,
      );
    }
    state.currentStepIndex = currentStepIndex;
    state.currentStepId = (dget(stateData, 'current_step_id', null) as string | null) ?? null;
    state.stepResults = stepResults as Record<string, Dict>;
    state.workflowDir = (dget(stateData, 'workflow_dir', null) as string | null) ?? null;
    state.createdAt = dget(stateData, 'created_at', '') as string;
    state.updatedAt = dget(stateData, 'updated_at', '') as string;
    state.error = (dget(stateData, 'error', null) as string | null) ?? null;

    const inputsPath = join(runsDir, 'inputs.json');
    if (existsSync(inputsPath)) {
      const inputsData = loadJsonFile(inputsPath);
      if (!isDict(inputsData)) throw new ValueError('Invalid run inputs: expected a JSON object');
      const inputs = dget(inputsData, 'inputs', {});
      if (!isDict(inputs)) throw new ValueError("Invalid run inputs: 'inputs' must be a JSON object");
      state.inputs = inputs;
    }

    return state;
  }

  /** Append a log entry to the run log (``log.jsonl``). */
  appendLog(entry: Dict): void {
    entry.timestamp = utcIsoNow();
    const runsDir = this.runsDir;
    mkdirSync(runsDir, { recursive: true });
    this.logEntries.push(entry);
    appendFileSync(join(runsDir, 'log.jsonl'), pyJsonDumps(entry) + '\n', 'utf8');
  }
}

// ============================================================================
// Workflow Engine
// ============================================================================

/** Python ``a or b`` (``b`` evaluated lazily). */
function pyOr(a: unknown, b: () => unknown): unknown {
  return pyTruthy(a) ? a : b();
}

const HALTING: ReadonlySet<RunStatus> = new Set([RunStatus.PAUSED, RunStatus.FAILED, RunStatus.ABORTED]);

/** Options for {@link WorkflowEngine.execute}. */
export interface ExecuteOptions {
  runId?: string | null;
  installedWorkflowId?: string | null;
  installedRegistryRoot?: string | null;
}

/** Python ``int(x)`` for ``max_concurrency`` coercion (``null`` on failure). */
function pyIntCoerce(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
  }
  if (typeof value === 'string') return pyParseInt(value);
  return null;
}

/** Orchestrator that loads, validates, and executes workflow definitions. */
export class WorkflowEngine {
  projectRoot: string;
  /** Callback invoked when a step starts: ``(stepId, label)``. */
  onStepStart: ((stepId: string, label: string) => void) | null = null;

  constructor(projectRoot: string | null = null) {
    this.projectRoot = projectRoot || '.';
  }

  /**
   * Load a workflow from an installed ID or a local YAML path.
   *
   * Returns a parsed (not yet validated) ``WorkflowDefinition``. Throws
   * ``FileNotFoundError`` if the workflow cannot be found and
   * ``ValueError`` if the workflow YAML is invalid.
   */
  loadWorkflow(source: string): WorkflowDefinition {
    const path = expandUser(source);
    const lower = path.toLowerCase();
    if ((lower.endsWith('.yml') || lower.endsWith('.yaml')) && isFile(path)) {
      return WorkflowDefinition.fromYaml(path);
    }

    const resolver = new WorkflowResolver(this.projectRoot);
    try {
      return resolver.resolve(String(source));
    } catch (exc) {
      if (!(exc instanceof FileNotFoundError || (exc as NodeJS.ErrnoException)?.code === 'ENOENT')) throw exc;
    }

    const installedPath = join(this.projectRoot, '.specify', 'workflows', String(source), 'workflow.yml');
    if (existsSync(installedPath)) return WorkflowDefinition.fromYaml(installedPath);

    throw new FileNotFoundError(`Workflow not found: ${source}`);
  }

  /** Validate a workflow definition. */
  validate(definition: WorkflowDefinition): string[] {
    return validateWorkflow(definition);
  }

  /** Execute a workflow definition; returns the final ``RunState``. */
  async execute(definition: WorkflowDefinition, inputs: Dict | null = null, opts: ExecuteOptions = {}): Promise<RunState> {
    const defaultErrors = dispatchDefaultErrors(definition);
    if (defaultErrors.length) throw new ValueError(defaultErrors.join(' '));

    let effectiveRunId = opts.runId ?? null;
    if (effectiveRunId === null) {
      const envRunId = (process.env.SPECKIT_WORKFLOW_RUN_ID ?? '').trim();
      if (envRunId) effectiveRunId = envRunId;
    }

    const state = new RunState({
      runId: effectiveRunId,
      workflowId: definition.id as string,
      projectRoot: this.projectRoot,
      installedWorkflowId: opts.installedWorkflowId ?? null,
      installedRegistryRoot: opts.installedRegistryRoot ?? null,
    });

    const runDir = join(this.projectRoot, '.specify', 'workflows', 'runs', state.runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'workflow.yml'), dumpYaml(definition.data, { sortKeys: false }), 'utf8');

    const resolvedInputs = this.resolveInputs(definition, inputs ?? {});
    state.inputs = resolvedInputs;
    let workflowDir: string | null = null;
    if (definition.sourcePath !== null) {
      let resolved: string;
      try {
        resolved = realpathSync(definition.sourcePath);
      } catch {
        resolved = pathResolve(definition.sourcePath);
      }
      workflowDir = dirname(resolved);
    }
    state.workflowDir = workflowDir;
    state.status = RunStatus.RUNNING;
    state.save();

    const context = new StepContext({
      inputs: resolvedInputs,
      defaultIntegration: definition.defaultIntegration,
      defaultModel: definition.defaultModel,
      defaultOptions: definition.defaultOptions,
      projectRoot: this.projectRoot,
      runId: state.runId,
      workflowDir,
    });

    try {
      await this.executeSteps(definition.steps as Dict[], context, state, STEP_REGISTRY);
    } catch (exc) {
      if (exc instanceof KeyboardInterrupt) {
        state.status = RunStatus.PAUSED;
        state.appendLog({ event: 'workflow_interrupted' });
        state.save();
        return state;
      }
      state.status = RunStatus.FAILED;
      state.error = errorMessage(exc);
      state.appendLog({ event: 'workflow_failed', error: errorMessage(exc) });
      state.save();
      throw exc;
    }

    if (state.status === RunStatus.RUNNING) state.status = RunStatus.COMPLETED;
    state.appendLog({ event: 'workflow_finished', status: state.status });
    state.save();
    return state;
  }

  /**
   * Resume a paused or failed workflow run.
   *
   * When ``inputs`` is provided, the values are merged over the run's
   * persisted inputs and re-resolved through the same typed validation path
   * used by ``execute``.
   */
  async resume(runId: string, inputs: Dict | null = null): Promise<RunState> {
    const state = RunState.load(runId, this.projectRoot);
    if (state.status !== RunStatus.PAUSED && state.status !== RunStatus.FAILED) {
      throw new ValueError(`Cannot resume run ${pyRepr(runId)} with status ${pyRepr(state.status)}.`);
    }

    const runCopy = join(this.projectRoot, '.specify', 'workflows', 'runs', runId, 'workflow.yml');
    const definition = existsSync(runCopy)
      ? WorkflowDefinition.fromYaml(runCopy)
      : this.loadWorkflow(state.workflowId);

    const steps = Array.isArray(definition.steps) ? (definition.steps as Dict[]) : [];
    if (state.currentStepIndex >= steps.length) {
      throw new ValueError(
        "Invalid run state: 'current_step_index' " +
          `(${state.currentStepIndex}) is out of range for ` +
          `workflow ${pyRepr(state.workflowId)} with ${steps.length} ` +
          'step(s).',
      );
    }

    const defaultErrors = dispatchDefaultErrors(definition);
    if (defaultErrors.length) throw new ValueError(defaultErrors.join(' '));

    if (inputs && Object.keys(inputs).length) {
      const merged = { ...state.inputs, ...inputs };
      state.inputs = this.resolveInputs(definition, merged);
    }

    const context = new StepContext({
      inputs: state.inputs,
      steps: state.stepResults,
      defaultIntegration: definition.defaultIntegration,
      defaultModel: definition.defaultModel,
      defaultOptions: definition.defaultOptions,
      projectRoot: this.projectRoot,
      runId: state.runId,
      isResume: true,
      workflowDir: state.workflowDir,
    });

    state.error = null;
    state.status = RunStatus.RUNNING;
    state.save();

    const remainingSteps = steps.slice(state.currentStepIndex);
    const stepOffset = state.currentStepIndex;

    try {
      await this.executeSteps(remainingSteps, context, state, STEP_REGISTRY, stepOffset);
    } catch (exc) {
      if (exc instanceof KeyboardInterrupt) {
        state.status = RunStatus.PAUSED;
        state.appendLog({ event: 'workflow_interrupted' });
        state.save();
        return state;
      }
      state.status = RunStatus.FAILED;
      state.error = errorMessage(exc);
      state.appendLog({ event: 'resume_failed', error: errorMessage(exc) });
      state.save();
      throw exc;
    }

    if (state.status === RunStatus.RUNNING) state.status = RunStatus.COMPLETED;
    state.appendLog({ event: 'workflow_finished', status: state.status });
    state.save();
    return state;
  }

  /** Record a step result into both the live context and persistent state. */
  private static recordResult(context: StepContext, state: RunState, stepId: string, data: Dict): void {
    if (context.steps !== state.stepResults) context.steps[stepId] = data;
    state.recordStepResult(stepId, data);
  }

  /** Execute a list of steps sequentially. */
  async executeSteps(
    steps: Dict[],
    context: StepContext,
    state: RunState,
    registry: Map<string, StepBase>,
    stepOffset = 0,
  ): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const stepConfig = steps[i] as Dict;
      const stepId = dget(stepConfig, 'id', `step-${i}`) as string;
      const stepType = dget(stepConfig, 'type', 'command') as string;

      state.currentStepId = stepId;
      if (stepOffset >= 0) state.currentStepIndex = stepOffset + i;
      state.save();

      state.appendLog({ event: 'step_started', step_id: stepId, type: stepType });

      const command = dget(stepConfig, 'command', '');
      const label = pyTruthy(command) ? pyStr(command) : stepType;
      if (this.onStepStart !== null) this.onStepStart(stepId, label as string);

      const stepImpl = registry.get(stepType);
      if (!stepImpl) {
        state.status = RunStatus.FAILED;
        state.error = `Unknown step type: ${pyRepr(stepType)}`;
        state.appendLog({ event: 'step_failed', step_id: stepId, error: `Unknown step type: ${pyRepr(stepType)}` });
        state.save();
        return;
      }

      const result: StepResult = await stepImpl.execute(stepConfig, context);

      const out = result.output;
      const pick = (outKey: string, cfgKey: string, fallback: unknown): unknown => {
        const a = dget(out, outKey, null);
        if (pyTruthy(a)) return a;
        const b = dget(stepConfig, cfgKey, null);
        if (pyTruthy(b)) return b;
        return fallback;
      };
      const stepData: Dict = {
        type: stepType,
        integration: pick('integration', 'integration', context.defaultIntegration) ?? null,
        model: pick('model', 'model', context.defaultModel) ?? null,
        options: pyOr(dget(out, 'options', null), () => dget(stepConfig, 'options', {})),
        input: pyOr(dget(out, 'input', null), () => dget(stepConfig, 'input', {})),
        output: out,
        status: result.status,
        error: result.error,
      };
      if (stepType === 'command' && dhas(out, 'integration_args')) {
        stepData.integration_args = out.integration_args;
        stepData.integration_options = out.integration_options;
      }
      WorkflowEngine.recordResult(context, state, stepId, stepData);

      state.appendLog({ event: 'step_completed', step_id: stepId, status: result.status });

      if (result.status === StepStatus.PAUSED) {
        state.status = RunStatus.PAUSED;
        state.save();
        return;
      }

      if (result.status === StepStatus.FAILED) {
        if (pyTruthy(dget(out, 'aborted', null))) {
          state.status = RunStatus.ABORTED;
          state.error = result.error;
          state.appendLog({ event: 'workflow_aborted', step_id: stepId });
          state.save();
          return;
        }
        if (dget(stepConfig, 'continue_on_error', null) === true) {
          state.appendLog({ event: 'step_continue_on_error', step_id: stepId, error: result.error });
          state.save();
          continue;
        }
        state.status = RunStatus.FAILED;
        state.error = result.error;
        state.appendLog({ event: 'step_failed', step_id: stepId, error: result.error });
        state.save();
        return;
      }

      // Execute nested steps (from control flow). Nested steps run with
      // stepOffset=-1 so they don't update currentStepIndex.
      if (result.nextSteps.length) {
        await this.executeSteps(result.nextSteps, context, state, registry, -1);
        if (HALTING.has(state.status)) return;

        if (stepType === 'while' || stepType === 'do-while') {
          let maxIters = dget(stepConfig, 'max_iterations', null);
          if (!isInt(maxIters) || maxIters < 1) maxIters = 10;
          const condition = dget(stepConfig, 'condition', false);
          for (let loopIter = 0; loopIter < (maxIters as number) - 1; loopIter++) {
            if (!evaluateCondition(condition, context)) break;
            for (let nsIdx = 0; nsIdx < result.nextSteps.length; nsIdx++) {
              const nsCopy: Dict = { ...(result.nextSteps[nsIdx] as Dict) };
              const orig = dget(nsCopy, 'id', null) as string | null;
              const baseId = orig || `step-${nsIdx}`;
              nsCopy.id = `${stepId}:${baseId}:${loopIter + 1}`;
              await this.executeSteps([nsCopy], context, state, registry, -1);
              if (HALTING.has(state.status)) return;
              const nsId = nsCopy.id as string;
              if (orig && Object.prototype.hasOwnProperty.call(context.steps, nsId)) {
                WorkflowEngine.recordResult(context, state, orig, context.steps[nsId] as Dict);
              }
            }
          }
        }
      }

      if (stepType === 'fan-out') {
        const items = dget(out, 'items', []);
        const template = dget(out, 'step_template', {});
        if (pyTruthy(template) && pyTruthy(items)) {
          const fanOutResults = await this.runFanOut(
            items as unknown[],
            template as Dict,
            stepId,
            context,
            state,
            registry,
            dget(out, 'max_concurrency', 1),
          );
          context.item = null;
          const fanOutOutput: Dict = { ...out, results: fanOutResults };
          state.setStepOutput(stepId, fanOutOutput);
          if (HALTING.has(state.status)) return;
        } else {
          out.results = [];
          state.setStepOutput(stepId, out);
        }
      }
    }
  }

  /**
   * Run a fan-out template once per item; return per-item outputs in item
   * order. ``maxConcurrency <= 1`` runs sequentially; ``> 1`` runs up to that
   * many items concurrently with a sliding submission window.
   */
  async runFanOut(
    items: unknown[],
    template: Dict,
    stepId: string,
    context: StepContext,
    state: RunState,
    registry: Map<string, StepBase>,
    maxConcurrency: unknown,
  ): Promise<unknown[]> {
    if (!items.length) return [];

    const coerced = pyIntCoerce(maxConcurrency);
    let workers = coerced === null ? 1 : Math.max(1, coerced);
    workers = Math.min(workers, items.length);

    const baseId = dget(template, 'id', 'item');
    const itemId = (idx: number): string => `${stepId}:${pyStr(baseId)}:${idx}`;

    const runItem = async (idx: number, itemCtx: StepContext): Promise<unknown> => {
      const itemStep: Dict = { ...template, id: itemId(idx) };
      await this.executeSteps([itemStep], itemCtx, state, registry, -1);
      const rec = itemCtx.steps[itemStep.id as string];
      return isDict(rec) ? dget(rec, 'output', {}) : {};
    };

    if (workers <= 1) {
      const results: unknown[] = [];
      const previousItem = context.item;
      const previousInside = context.insideFanOut;
      context.insideFanOut = true;
      try {
        for (let idx = 0; idx < items.length; idx++) {
          context.item = items[idx];
          results.push(await runItem(idx, context));
          if (HALTING.has(state.status)) break;
        }
      } finally {
        context.item = previousItem;
        context.insideFanOut = previousInside;
      }
      return results;
    }

    // Concurrent path — bounded sliding window; results assembled in item order.
    const n = items.length;
    const slots: unknown[] = new Array(n).fill(null);

    const runIsolated = (idx: number): Promise<unknown> =>
      runItem(idx, context.replace({ item: items[idx], insideFanOut: true }));

    const itemHaltStatus = (idx: number): RunStatus | null => {
      const rec = context.steps[itemId(idx)];
      if (rec === undefined) return HALTING.has(state.status) ? state.status : null;
      const status = dget(rec, 'status', null);
      if (status === StepStatus.PAUSED) return RunStatus.PAUSED;
      if (status === StepStatus.FAILED) {
        const o = dget(rec, 'output', null);
        if (isDict(o) && pyTruthy(dget(o, 'aborted', null))) return RunStatus.ABORTED;
        if (dget(template, 'continue_on_error', null) !== true) return RunStatus.FAILED;
      }
      return null;
    };

    let halt: [number, RunStatus] | null = null;
    let collected = 0;
    const inFlight = new Map<number, Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>>();
    let nextSubmit = 0;
    for (let idx = 0; idx < n; idx++) {
      while (nextSubmit < n && inFlight.size < workers && !HALTING.has(state.status)) {
        const i = nextSubmit;
        inFlight.set(
          i,
          runIsolated(i).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        );
        nextSubmit += 1;
      }
      const fut = inFlight.get(idx);
      if (fut === undefined) break;
      inFlight.delete(idx);
      const settled = await fut;
      if (!settled.ok) {
        // Let already-running items finish before propagating (pool join).
        await Promise.all(inFlight.values());
        throw settled.error;
      }
      slots[idx] = settled.value;
      collected = idx + 1;
      const haltStatus = itemHaltStatus(idx);
      if (haltStatus !== null) {
        halt = [idx, haltStatus];
        break;
      }
    }
    // Join any still-running workers (their outputs are ignored).
    await Promise.all(inFlight.values());

    if (halt !== null) {
      const [haltedAt, haltedStatus] = halt;
      state.status = haltedStatus;
      const haltRec = context.steps[itemId(haltedAt)];
      if (isDict(haltRec)) state.error = (dget(haltRec, 'error', null) as string | null) ?? null;
      return slots.slice(0, haltedAt + 1);
    }
    return slots.slice(0, collected);
  }

  /** Resolve workflow inputs against definitions and provided values. */
  resolveInputs(definition: WorkflowDefinition, provided: Dict): Dict {
    const resolved: Dict = {};
    if (!isDict(definition.inputs)) return {};
    for (const [name, inputDef] of Object.entries(definition.inputs)) {
      if (!isDict(inputDef)) continue;
      let value: unknown;
      if (dhas(provided, name)) {
        value = this.resolveDefault(name, provided[name]);
      } else if (dhas(inputDef, 'default')) {
        value = this.resolveDefault(name, inputDef.default);
      } else if (dget(inputDef, 'required', false)) {
        throw new ValueError(`Required input ${pyRepr(name)} not provided.`);
      } else {
        continue;
      }

      let coerceInputDef: Dict = inputDef;
      if (name === 'integration' && value === 'auto' && Array.isArray(dget(inputDef, 'enum', null))) {
        coerceInputDef = Object.fromEntries(Object.entries(inputDef).filter(([k]) => k !== 'enum'));
      }
      resolved[name] = WorkflowEngine.coerceInput(name, value, coerceInputDef);
    }
    return resolved;
  }

  /**
   * Resolve special default sentinels against project state (``integration:
   * auto`` → the project's default integration from ``.specify/integration.json``).
   */
  resolveDefault(name: string, def: unknown): unknown {
    if (name === 'integration' && def === 'auto') {
      const resolved = this.loadProjectIntegration();
      if (resolved !== null) return resolved;
    }
    return def;
  }

  /** Read the default integration key from ``.specify/integration.json``. */
  loadProjectIntegration(): string | null {
    const [state, error] = tryReadIntegrationJson(this.projectRoot);
    if (state === null || error !== null) return null;
    return defaultIntegrationKey(state);
  }

  /** Coerce a provided input value to the declared type. */
  static coerceInput(name: string, value: unknown, inputDef: Dict): unknown {
    const inputType = dget(inputDef, 'type', 'string');
    const enumValues = dget(inputDef, 'enum', null);

    if (enumValues !== null && enumValues !== undefined && !Array.isArray(enumValues)) {
      throw new ValueError(`Input ${pyRepr(name)} has invalid 'enum': must be a list, got ${pyTypeName(enumValues)}.`);
    }

    if (inputType === 'number') {
      if (typeof value === 'boolean') {
        throw new ValueError(`Input ${pyRepr(name)} expected a number, got ${pyRepr(value)}.`);
      }
      let num: number | null = null;
      if (typeof value === 'number') num = value;
      else if (typeof value === 'string') num = pyParseFloat(value);
      if (num === null || !Number.isFinite(num)) {
        throw new ValueError(`Input ${pyRepr(name)} expected a number, got ${pyRepr(value)}.`);
      }
      value = num;
    } else if (inputType === 'boolean') {
      if (typeof value === 'string') {
        const lower = value.toLowerCase();
        if (['true', '1', 'yes'].includes(lower)) value = true;
        else if (['false', '0', 'no'].includes(lower)) value = false;
        else throw new ValueError(`Input ${pyRepr(name)} expected a boolean, got ${pyRepr(value)}.`);
      } else if (typeof value !== 'boolean') {
        throw new ValueError(`Input ${pyRepr(name)} expected a boolean, got ${pyRepr(value)}.`);
      }
    } else if (inputType === 'string') {
      if (typeof value !== 'string') {
        throw new ValueError(`Input ${pyRepr(name)} expected a string, got ${pyRepr(value)}.`);
      }
    }

    if (enumValues !== null && enumValues !== undefined) {
      let contained: boolean;
      try {
        contained = pyContains(enumValues, value);
      } catch {
        contained = false;
      }
      if (!contained) {
        throw new ValueError(
          `Input ${pyRepr(name)} value ${pyRepr(value)} not in allowed values: ${pyRepr(enumValues)}.`,
        );
      }
    }
    return value;
  }

  /** List all workflow runs in the project. */
  listRuns(): Dict[] {
    const runsDir = join(this.projectRoot, '.specify', 'workflows', 'runs');
    if (!existsSync(runsDir)) return [];
    const runs: Dict[] = [];
    let names: string[];
    try {
      names = readdirSorted(runsDir);
    } catch {
      return [];
    }
    for (const name of names) {
      const runDir = join(runsDir, name);
      try {
        if (!statSync(runDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const statePath = join(runDir, 'state.json');
      if (!existsSync(statePath)) continue;
      let stateData: unknown;
      try {
        stateData = JSON.parse(readFileSync(statePath, 'utf8')) as unknown;
      } catch {
        continue;
      }
      if (!isDict(stateData) || !dhas(stateData, 'run_id')) continue;
      runs.push(stateData);
    }
    return runs;
  }
}

/** Sorted directory listing (Python ``sorted(Path.iterdir())`` by name). */
function readdirSorted(dir: string): string[] {
  return readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Raised when a workflow is aborted (e.g., gate rejection). */
export class WorkflowAbortError extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'WorkflowAbortError';
  }
}
