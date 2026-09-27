/**
 * Tests for the workflow engine: registry, definitions, validation, run state
 * persistence, execution, control flow, fan-out/fan-in and resume (ports of
 * the key cases from upstream ``tests/test_workflows.py``).
 *
 * Integration dispatch is replaced with a fake through the
 * ``CommandStep.tryDispatch`` / ``PromptStep.tryDispatch`` seams, and the gate
 * TTY check through ``GateStep.stdinIsTTY``.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUILTIN_STEP_TYPES,
  CommandStep,
  GateStep,
  KeyError,
  PromptStep,
  RunState,
  RunStatus,
  STEP_REGISTRY,
  StepBase,
  StepContext,
  StepResult,
  StepStatus,
  ValueError,
  WorkflowDefinition,
  WorkflowEngine,
  getStepType,
  registerStep,
  validateWorkflow,
  type Dict,
} from '../src/workflows/index.js';

let projectDir: string;
const origTryDispatch = CommandStep.tryDispatch;
const origPromptDispatch = PromptStep.tryDispatch;
const origIsTTY = GateStep.stdinIsTTY;
const origPrompt = GateStep.prompt;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'speckit-wf-engine-'));
  mkdirSync(join(projectDir, '.specify', 'workflows'), { recursive: true });
  GateStep.stdinIsTTY = () => false;
  delete process.env.SPECKIT_WORKFLOW_RUN_ID;
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  CommandStep.tryDispatch = origTryDispatch;
  PromptStep.tryDispatch = origPromptDispatch;
  GateStep.stdinIsTTY = origIsTTY;
  GateStep.prompt = origPrompt;
});

const def = (yaml: string): WorkflowDefinition => WorkflowDefinition.fromString(yaml);

const HEADER = (id: string): string => `
schema_version: "1.0"
workflow:
  id: "${id}"
  name: "${id}"
  version: "1.0.0"
`;

// ============================================================================
// Registry & base classes
// ============================================================================

describe('step registry', () => {
  test('all built-in step types are registered', () => {
    const expected = ['command', 'shell', 'prompt', 'gate', 'if', 'switch', 'while', 'do-while', 'fan-out', 'fan-in', 'init', 'slot'];
    for (const key of expected) expect(STEP_REGISTRY.has(key)).toBe(true);
    expect(BUILTIN_STEP_TYPES.size).toBe(12);
    expect(getStepType('command')?.typeKey).toBe('command');
    expect(getStepType('nonexistent')).toBeNull();
  });

  test('duplicate and empty registrations raise', () => {
    expect(() => registerStep(new CommandStep())).toThrow(KeyError);
    expect(() => registerStep(new CommandStep())).toThrow('already registered');
    class EmptyStep extends StepBase {
      execute(): StepResult {
        return new StepResult();
      }
    }
    expect(() => registerStep(new EmptyStep())).toThrow('empty type_key');
  });

  test('base class defaults', () => {
    const ctx = new StepContext();
    expect(ctx.inputs).toEqual({});
    expect(ctx.steps).toEqual({});
    expect(ctx.item).toBeNull();
    expect(ctx.fanIn).toEqual({});
    expect(ctx.defaultIntegration).toBeNull();
    const r = new StepResult();
    expect(r.status).toBe(StepStatus.COMPLETED);
    expect(r.output).toEqual({});
    expect(r.nextSteps).toEqual([]);
    expect(r.error).toBeNull();
    expect(StepStatus.PAUSED).toBe('paused');
    expect(RunStatus.ABORTED).toBe('aborted');
  });
});

// ============================================================================
// Definitions & validation
// ============================================================================

describe('WorkflowDefinition', () => {
  test('parses header fields and defaults', () => {
    const d = def(`${HEADER('x')}  integration: claude\n  model: m\nsteps: []\n`);
    expect(d.id).toBe('x');
    expect(d.version).toBe('1.0.0');
    expect(d.defaultIntegration).toBe('claude');
    expect(d.defaultModel).toBe('m');
    expect(d.defaultOptions).toEqual({});
    expect(d.schemaVersion).toBe('1.0');
  });

  test('non-mapping YAML and bad YAML raise ValueError', () => {
    expect(() => def('- a\n- b\n')).toThrow('Workflow YAML must be a mapping, got list.');
    expect(() => def('a: [1, 2\n')).toThrow(ValueError);
    expect(() => def('a: [1, 2\n')).toThrow(/^Invalid YAML: /);
  });

  test('non-mapping workflow block falls back to defaults', () => {
    const d = def('workflow: foo\nsteps: []\n');
    expect(d.id).toBe('');
    expect(validateWorkflow(d)).toContain("Workflow is missing 'workflow.id'.");
  });

  test('fromYaml loads a file', () => {
    const p = join(projectDir, 'wf.yml');
    writeFileSync(p, `${HEADER('file-wf')}steps:\n  - id: a\n    type: shell\n    run: echo\n`);
    const d = WorkflowDefinition.fromYaml(p);
    expect(d.id).toBe('file-wf');
    expect(d.sourcePath).toBe(p);
  });
});

describe('validateWorkflow', () => {
  test('valid workflow has no errors', () => {
    const d = def(`${HEADER('ok')}inputs:\n  spec:\n    type: string\n    required: true\nsteps:\n  - id: a\n    command: speckit.specify\n`);
    expect(validateWorkflow(d)).toEqual([]);
  });

  test('header errors', () => {
    const d = def('schema_version: "2.0"\nworkflow:\n  id: Bad_ID\n  name: 5\n  version: 1.0\nsteps: []\n');
    const errors = validateWorkflow(d);
    expect(errors).toContain("Unsupported schema_version '2.0'. Expected '1.0'.");
    expect(errors).toContain("Workflow ID 'Bad_ID' must be lowercase alphanumeric with hyphens.");
    expect(errors).toContain("'workflow.name' must be a string, got int (5).");
    expect(errors.some((e) => e.startsWith("'workflow.version' must be a string, got"))).toBe(true);
    expect(errors).toContain('Workflow has no steps defined.');
  });

  test('bad semver and dispatch defaults', () => {
    const d = def('workflow:\n  id: a\n  name: A\n  version: "1.0"\n  integration: [x]\n  options: 5\nsteps:\n  - id: s\n    type: shell\n    run: x\n');
    const errors = validateWorkflow(d);
    expect(errors).toContain("Workflow version '1.0' is not valid semantic versioning (expected X.Y.Z).");
    expect(errors).toContain("'workflow.integration' must be a string or null, got list (['x']).");
    expect(errors).toContain("'workflow.options' must be a mapping or null, got int (5).");
  });

  test('step-level errors', () => {
    const d = def(`${HEADER('steps')}steps:
  - id: a
    type: shell
    run: echo
  - id: a
    type: shell
    run: echo
  - id: "b:c"
    type: shell
    run: echo
  - id: d
    type: nope
  - id: e
    type: [shell]
  - type: shell
  - id: f
    type: shell
    run: echo
    continue_on_error: "yes"
  - id: fi
    type: fan-in
    wait_for: [a, fi, later, 123]
  - id: later
    type: shell
    run: echo
`);
    const errors = validateWorkflow(d);
    expect(errors).toContain("Duplicate step ID 'a'.");
    expect(errors).toContain(
      "Step ID 'b:c' contains ':' which is reserved for engine-generated nested IDs (parentId:childId).",
    );
    expect(errors).toContain("Step 'd' has invalid type 'nope'.");
    expect(errors).toContain("Step 'e': 'type' must be a string, got list (['shell']).");
    expect(errors).toContain("Step is missing 'id' field.");
    expect(errors).toContain("Step 'f': 'continue_on_error' must be a boolean, got str.");
    expect(errors).toContain("Fan-in step 'fi': 'wait_for' references itself; a fan-in cannot wait for its own results.");
    expect(errors).toContain("Fan-in step 'fi': 'wait_for' references unknown or not-yet-declared step id 'later'.");
    expect(errors).toContain("Fan-in step 'fi': 'wait_for' entries must be step-id strings, got int (123).");
  });

  test('inputs and requires validation', () => {
    const d = def(`${HEADER('inp')}requires:
  speckit_version: ">=1"
  permissions: [shell]
  tools: []
inputs:
  a:
    type: list
  b:
    type: string
    enum: 5
  c:
    type: string
    enum: [x, y]
    default: z
  d:
    type: number
    default: true
  integration:
    type: string
    enum: [claude]
    default: auto
steps:
  - id: s
    type: shell
    run: echo
`);
    const errors = validateWorkflow(d);
    expect(errors).toContain("Input 'a' has invalid type 'list'. Must be 'string', 'number', or 'boolean'.");
    expect(errors).toContain("Input 'b' has invalid 'enum': must be a list, got int.");
    expect(errors).toContain("Input 'c' has invalid default: Input 'c' value 'z' not in allowed values: ['x', 'y'].");
    expect(errors).toContain("Input 'd' has invalid default: Input 'd' expected a number, got True.");
    expect(errors.some((e) => e.startsWith("'requires.permissions' is not a recognized"))).toBe(true);
    expect(errors).toContain("Unknown 'requires' key 'tools'. Recognized keys: integrations, speckit_version.");
    expect(errors.some((e) => e.includes("Input 'integration'"))).toBe(false);
  });

  test('gate verdict_input cross checks and fan-out slot rejection', () => {
    const d = def(`${HEADER('gates')}inputs:
  verdict:
    type: string
    enum: [approve, reject]
steps:
  - id: g1
    type: gate
    message: m
    verdict_input: missing
  - id: g2
    type: gate
    message: m
    on_reject: retry
    verdict_input: verdict
  - id: fo
    type: fan-out
    items: "{{ [1] }}"
    step:
      id: inner
      type: slot
      name: s
`);
    const errors = validateWorkflow(d);
    expect(errors).toContain("Gate step 'g1': 'verdict_input' references undeclared input 'missing'.");
    expect(errors.some((e) => e.startsWith("Gate step 'g2': on_reject='retry' resets verdict input 'verdict'"))).toBe(true);
    expect(errors.some((e) => e.startsWith("Slot step 'inner' is not supported inside fan-out templates"))).toBe(true);
  });
});

// ============================================================================
// RunState
// ============================================================================

describe('RunState', () => {
  test('save/load round-trip preserves on-disk snake_case keys', () => {
    const s = new RunState({ runId: 'abc123', workflowId: 'wf', projectRoot: projectDir });
    s.status = RunStatus.PAUSED;
    s.currentStepIndex = 2;
    s.currentStepId = 'gate';
    s.inputs = { a: 'é' };
    s.stepResults = { gate: { status: 'paused', output: {} } };
    s.save();
    const raw = JSON.parse(readFileSync(join(projectDir, '.specify/workflows/runs/abc123/state.json'), 'utf8'));
    expect(raw.run_id).toBe('abc123');
    expect(raw.current_step_index).toBe(2);
    expect(raw.installed_workflow_id).toBeNull();
    expect(readFileSync(join(projectDir, '.specify/workflows/runs/abc123/inputs.json'), 'utf8')).toContain('\\u00e9');
    const loaded = RunState.load('abc123', projectDir);
    expect(loaded.status).toBe(RunStatus.PAUSED);
    expect(loaded.currentStepId).toBe('gate');
    expect(loaded.inputs).toEqual({ a: 'é' });
    expect(loaded.installedOriginTracked).toBe(true);
  });

  test('auto-generated run ids are 8 characters', () => {
    expect(new RunState().runId).toHaveLength(8);
  });

  test('invalid run ids are rejected before touching the filesystem', () => {
    expect(() => new RunState({ runId: '../escape' })).toThrow("Invalid run_id '../escape'");
    expect(() => new RunState({ runId: '' })).toThrow('Invalid run_id');
    expect(() => RunState.load('../x', projectDir)).toThrow('must be alphanumeric with hyphens/underscores only');
  });

  test('load errors', () => {
    expect(() => RunState.load('nope', projectDir)).toThrow('Run state not found: ');
    const dir = join(projectDir, '.specify/workflows/runs/r1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ run_id: 'r1', workflow_id: 'wf' }));
    expect(() => RunState.load('r1', projectDir)).toThrow('Invalid run state: missing required field(s): status');
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ run_id: 'r2', workflow_id: 'wf', status: 'paused' }));
    expect(() => RunState.load('r1', projectDir)).toThrow(
      "Invalid run state: stored run_id 'r2' does not match requested run_id 'r1'",
    );
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ run_id: 'r1', workflow_id: 'wf', status: 'paused', current_step_index: true }),
    );
    expect(() => RunState.load('r1', projectDir)).toThrow(
      "Invalid run state: 'current_step_index' must be a non-negative integer, got True",
    );
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ run_id: 'r1', workflow_id: 'wf', status: 'paused', installed_workflow_id: 'wf' }),
    );
    expect(() => RunState.load('r1', projectDir)).toThrow('installed workflow origin fields must either both be present');
  });

  test('installed origin validation', () => {
    expect(
      () => new RunState({ runId: 'x', installedWorkflowId: 'wf', installedRegistryRoot: 'relative' }),
    ).toThrow("'installed_registry_root' must be an absolute path or null");
    expect(() => new RunState({ runId: 'x', installedRegistryRoot: '/abs' })).toThrow(
      "'installed_registry_root' requires 'installed_workflow_id'",
    );
  });
});

// ============================================================================
// Execution
// ============================================================================

describe('WorkflowEngine.execute', () => {
  test('command step without a dispatchable integration fails with the upstream message', async () => {
    const d = def(`${HEADER('simple')}  integration: claude
inputs:
  name:
    type: string
    default: "test"
steps:
  - id: step-one
    command: speckit.specify
    input:
      args: "{{ inputs.name }}"
`);
    CommandStep.tryDispatch = async () => null;
    const state = await new WorkflowEngine(projectDir).execute(d, { name: 'login' });
    expect(state.status).toBe(RunStatus.FAILED);
    const rec = state.stepResults['step-one'] as Dict;
    expect((rec.output as Dict).command).toBe('speckit.specify');
    expect(((rec.output as Dict).input as Dict).args).toBe('login');
    expect(state.error).toBe(
      "Cannot dispatch command 'speckit.specify': integration 'claude' CLI not found or not installed. Install the CLI tool or check 'specify integration list'.",
    );
    expect(rec.integration).toBe('claude');
  });

  test('command step dispatches through the integration seam', async () => {
    const calls: unknown[][] = [];
    CommandStep.tryDispatch = async (...args) => {
      calls.push(args);
      return { exit_code: 0, stdout: 'ok', stderr: '' };
    };
    const d = def(`${HEADER('dispatch')}  integration: claude
  model: sonnet
  options:
    a: 1
steps:
  - id: s
    command: speckit.plan
    model: opus
    options:
      b: 2
    integration_args: ["--x", "{{ inputs.flag | default('y') }}"]
    input:
      args: "hello"
`);
    const state = await new WorkflowEngine(projectDir).execute(d);
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 4)).toEqual(['speckit.plan', 'claude', 'opus', 'hello']);
    expect(calls[0]?.[5]).toEqual(['--x', 'y']);
    const rec = state.stepResults.s as Dict;
    expect(rec.options).toEqual({ a: 1, b: 2 });
    expect(rec.integration_args).toEqual(['--x', 'y']);
    expect(rec.integration_options).toEqual({});
    expect((rec.output as Dict).dispatched).toBe(true);
  });

  test('dispatch ValueError fails the step with the step id prefix', async () => {
    CommandStep.tryDispatch = async () => {
      throw new ValueError("Integration 'claude' does not support per-step 'integration_args'.");
    };
    const d = def(`${HEADER('bad-args')}steps:
  - id: s
    command: speckit.plan
    integration: claude
`);
    const state = await new WorkflowEngine(projectDir).execute(d);
    expect(state.status).toBe(RunStatus.FAILED);
    expect(state.error).toBe("Command step 's': Integration 'claude' does not support per-step 'integration_args'.");
  });

  test('gate pauses when stdin is not a TTY', async () => {
    const d = def(`${HEADER('gated')}steps:
  - id: step-one
    type: shell
    run: "echo test"
  - id: gate
    type: gate
    message: "Review?"
    options: [approve, reject]
    on_reject: abort
  - id: step-two
    type: shell
    run: "echo done"
`);
    const state = await new WorkflowEngine(projectDir).execute(d);
    expect(state.status).toBe(RunStatus.PAUSED);
    expect((state.stepResults.gate as Dict).status).toBe('paused');
    expect(state.currentStepIndex).toBe(1);
    expect(state.stepResults['step-two']).toBeUndefined();
  });

  test('shell step output and workflow copy/log are persisted', async () => {
    const d = def(`${HEADER('shell-test')}steps:
  - id: echo
    type: shell
    run: "echo workflow-output"
`);
    const state = await new WorkflowEngine(projectDir).execute(d);
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect(((state.stepResults.echo as Dict).output as Dict).stdout).toContain('workflow-output');
    const runDir = join(projectDir, '.specify/workflows/runs', state.runId);
    expect(existsSync(join(runDir, 'workflow.yml'))).toBe(true);
    const events = readFileSync(join(runDir, 'log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).event);
    expect(events).toEqual(['step_started', 'step_completed', 'workflow_finished']);
  });

  test('if/then branches', async () => {
    const d = def(`${HEADER('branching')}inputs:
  scope:
    type: string
    default: "full"
steps:
  - id: check
    type: if
    condition: "{{ inputs.scope == 'full' }}"
    then:
      - id: full-tasks
        type: shell
        run: "echo full"
    else:
      - id: partial-tasks
        type: shell
        run: "echo partial"
`);
    const state = await new WorkflowEngine(projectDir).execute(d, { scope: 'full' });
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect(state.stepResults['full-tasks']).toBeDefined();
    expect(state.stepResults['partial-tasks']).toBeUndefined();
  });

  test('switch dispatches on stripped stdout', async () => {
    const d = def(`${HEADER('sw')}steps:
  - id: decide
    type: shell
    run: "echo approve"
  - id: route
    type: switch
    expression: "{{ steps.decide.output.stdout }}"
    cases:
      approve:
        - id: approved
          type: shell
          run: "echo yes"
    default:
      - id: fallback
        type: shell
        run: "echo no"
`);
    const state = await new WorkflowEngine(projectDir).execute(d);
    expect(((state.stepResults.route as Dict).output as Dict).matched_case).toBe('approve');
    expect(state.stepResults.approved).toBeDefined();
    expect(state.stepResults.fallback).toBeUndefined();
  });

  test('missing required input raises', async () => {
    const d = def(`${HEADER('needs-input')}inputs:
  name:
    type: string
    required: true
steps:
  - id: step-one
    type: shell
    run: echo
`);
    await expect(new WorkflowEngine(projectDir).execute(d)).rejects.toThrow("Required input 'name' not provided.");
  });

  test('input coercion', async () => {
    const d = def(`${HEADER('coerce')}inputs:
  n:
    type: number
  b:
    type: boolean
  s:
    type: string
    enum: [a, b]
steps:
  - id: x
    type: shell
    run: echo
`);
    const engine = new WorkflowEngine(projectDir);
    expect(engine.resolveInputs(d, { n: '3.0', b: 'yes', s: 'a' })).toEqual({ n: 3, b: true, s: 'a' });
    expect(() => engine.resolveInputs(d, { n: 'abc' })).toThrow("Input 'n' expected a number, got 'abc'.");
    expect(() => engine.resolveInputs(d, { b: 'maybe' })).toThrow("Input 'b' expected a boolean, got 'maybe'.");
    expect(() => engine.resolveInputs(d, { s: 'c' })).toThrow("Input 's' value 'c' not in allowed values: ['a', 'b'].");
    expect(() => WorkflowEngine.coerceInput('n', Infinity, { type: 'number' })).toThrow("expected a number, got inf.");
  });

  test('integration: auto resolves from .specify/integration.json', async () => {
    const d = def(`${HEADER('auto')}inputs:
  integration:
    type: string
    default: auto
    enum: [claude, copilot]
steps:
  - id: x
    type: shell
    run: echo
`);
    const engine = new WorkflowEngine(projectDir);
    expect(engine.resolveInputs(d, {})).toEqual({ integration: 'auto' });
    writeFileSync(join(projectDir, '.specify', 'integration.json'), JSON.stringify({ integration: 'claude' }));
    expect(engine.resolveInputs(d, {})).toEqual({ integration: 'claude' });
    expect(engine.resolveInputs(d, { integration: 'auto' })).toEqual({ integration: 'claude' });
    expect(engine.resolveInputs(d, { integration: 'copilot' })).toEqual({ integration: 'copilot' });
    writeFileSync(join(projectDir, '.specify', 'integration.json'), '{not json');
    expect(engine.resolveInputs(d, {})).toEqual({ integration: 'auto' });
  });

  test('invalid origin is rejected before creating run state', async () => {
    const d = def(`${HEADER('simple')}steps: []\n`);
    await expect(
      new WorkflowEngine(projectDir).execute(d, null, {
        runId: 'invalid-origin',
        installedWorkflowId: 'simple',
        installedRegistryRoot: 'relative-owner',
      }),
    ).rejects.toThrow('installed_registry_root');
    expect(existsSync(join(projectDir, '.specify/workflows/runs/invalid-origin'))).toBe(false);
  });

  test('SPECKIT_WORKFLOW_RUN_ID and context.run_id', async () => {
    process.env.SPECKIT_WORKFLOW_RUN_ID = 'env-run-1';
    try {
      const d = def(`${HEADER('rid')}steps:
  - id: s
    type: shell
    run: "echo {{ context.run_id }}"
`);
      const state = await new WorkflowEngine(projectDir).execute(d);
      expect(state.runId).toBe('env-run-1');
      expect(((state.stepResults.s as Dict).output as Dict).stdout).toBe('env-run-1\n');
    } finally {
      delete process.env.SPECKIT_WORKFLOW_RUN_ID;
    }
  });

  test('shell steps see SPECKIT_WORKFLOW_DIR and context.workflow_dir', async () => {
    const wfDir = join(projectDir, 'wfsrc');
    mkdirSync(wfDir);
    const p = join(wfDir, 'workflow.yml');
    writeFileSync(p, `${HEADER('wfdir')}steps:\n  - id: s\n    type: shell\n    run: 'printf "%s|{{ context.workflow_dir }}" "$SPECKIT_WORKFLOW_DIR"'\n`);
    const state = await new WorkflowEngine(projectDir).execute(WorkflowDefinition.fromYaml(p));
    const out = ((state.stepResults.s as Dict).output as Dict).stdout as string;
    const [envDir, ctxDir] = out.split('|');
    expect(envDir).toBe(ctxDir as string);
    expect(envDir?.endsWith('wfsrc')).toBe(true);
  });
});

describe('continue_on_error and gate verdicts', () => {
  test('continue_on_error routes around a failure', async () => {
    const d = def(`${HEADER('coe')}steps:
  - id: flaky
    type: shell
    run: "exit 3"
    continue_on_error: true
  - id: after
    type: if
    condition: "{{ steps.flaky.output.exit_code != 0 }}"
    then:
      - id: recover
        type: shell
        run: echo recovered
`);
    const state = await new WorkflowEngine(projectDir).execute(d);
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect((state.stepResults.flaky as Dict).status).toBe('failed');
    expect((state.stepResults.flaky as Dict).error).toBe('Shell command exited with code 3.');
    expect(state.stepResults.recover).toBeDefined();
  });

  test('a failure without continue_on_error halts the run', async () => {
    const d = def(`${HEADER('halt')}steps:
  - id: bad
    type: shell
    run: "exit 1"
  - id: never
    type: shell
    run: echo
`);
    const state = await new WorkflowEngine(projectDir).execute(d);
    expect(state.status).toBe(RunStatus.FAILED);
    expect(state.error).toBe('Shell command exited with code 1.');
    expect(state.stepResults.never).toBeUndefined();
  });

  test('gate reject via verdict_input aborts and cannot be overridden by continue_on_error', async () => {
    const d = def(`${HEADER('abort')}inputs:
  verdict:
    type: string
    default: ""
steps:
  - id: review
    type: gate
    message: "Review {{ inputs.verdict }}"
    verdict_input: verdict
    continue_on_error: true
  - id: never
    type: shell
    run: echo
`);
    const state = await new WorkflowEngine(projectDir).execute(d, { verdict: 'REJECT' });
    expect(state.status).toBe(RunStatus.ABORTED);
    expect(state.error).toBe("Gate rejected by user at step 'review'");
    expect(((state.stepResults.review as Dict).output as Dict).choice).toBe('reject');
  });

  test('gate retry resets the bound verdict input and resume re-runs the gate', async () => {
    const d = def(`${HEADER('retry')}inputs:
  verdict:
    type: string
    default: ""
steps:
  - id: review
    type: gate
    message: "Review"
    on_reject: retry
    verdict_input: verdict
  - id: after
    type: shell
    run: echo after
`);
    const engine = new WorkflowEngine(projectDir);
    const state = await engine.execute(d, { verdict: 'reject' });
    expect(state.status).toBe(RunStatus.PAUSED);
    expect(state.inputs.verdict).toBe('');
    expect(RunState.load(state.runId, projectDir).inputs.verdict).toBe('');

    const resumed = await engine.resume(state.runId, { verdict: 'approve' });
    expect(resumed.status).toBe(RunStatus.COMPLETED);
    expect(((resumed.stepResults.review as Dict).output as Dict).choice).toBe('approve');
    expect(resumed.stepResults.after).toBeDefined();
  });

  test('interactive gate prompt seam', async () => {
    GateStep.stdinIsTTY = () => true;
    const seen: string[] = [];
    GateStep.prompt = async (message, options) => {
      seen.push(message, options.join(','));
      return 'approve';
    };
    const d = def(`${HEADER('interactive')}steps:
  - id: g
    type: gate
    message: "Ship it?"
`);
    const state = await new WorkflowEngine(projectDir).execute(d);
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect(seen).toEqual(['Ship it?', 'approve,reject']);
  });
});

describe('loops', () => {
  const counterScript = (file: string): string =>
    `n=$(cat '${file}'); n=$((n+1)); echo $n > '${file}'; if [ $n -ge 2 ]; then printf done; else printf $n; fi`;

  test('while loop condition reads the latest iteration', async () => {
    const counter = join(projectDir, '.counter');
    writeFileSync(counter, '0');
    const d = def(`${HEADER('while-latest')}steps:
  - id: retry-loop
    type: while
    condition: "{{ 'done' not in steps.attempt.output.stdout }}"
    max_iterations: 5
    steps:
      - id: attempt
        type: shell
        run: ${JSON.stringify(counterScript(counter))}
`);
    const state = await new WorkflowEngine(projectDir).execute(d);
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect(((state.stepResults.attempt as Dict).output as Dict).stdout).toBe('done');
    expect(state.stepResults['retry-loop:attempt:1']).toBeDefined();
    expect(readFileSync(counter, 'utf8').trim()).toBe('2');
  });

  test('do-while runs to max_iterations when the condition stays true', async () => {
    const counter = join(projectDir, '.counter');
    writeFileSync(counter, '0');
    const d = def(`${HEADER('dowhile-max')}steps:
  - id: loop
    type: do-while
    condition: "{{ true }}"
    max_iterations: 3
    steps:
      - id: tick
        type: shell
        run: "n=$(cat '${counter}'); echo $((n+1)) > '${counter}'"
`);
    const state = await new WorkflowEngine(projectDir).execute(d);
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect(readFileSync(counter, 'utf8').trim()).toBe('3');
    expect(state.stepResults['loop:tick:2']).toBeDefined();
  });

  test('a bool max_iterations falls back to the default cap of 10', async () => {
    const counter = join(projectDir, '.counter');
    writeFileSync(counter, '0');
    const d = def(`${HEADER('bool-max')}steps:
  - id: loop
    type: do-while
    condition: "true"
    max_iterations: true
    steps:
      - id: tick
        type: shell
        run: "n=$(cat '${counter}'); echo $((n+1)) > '${counter}'"
`);
    await new WorkflowEngine(projectDir).execute(d);
    expect(readFileSync(counter, 'utf8').trim()).toBe('10');
  });
});

describe('fan-out / fan-in', () => {
  test('sequential fan-out collects per-item outputs and fan-in aggregates them', async () => {
    const d = def(`${HEADER('fan')}steps:
  - id: list
    type: shell
    run: 'echo ''["a","b","c"]'''
    output_format: json
  - id: each
    type: fan-out
    items: "{{ steps.list.output.data }}"
    step:
      id: echo
      type: shell
      run: "printf {{ item }}"
  - id: join
    type: fan-in
    wait_for: [each]
    output:
      count: "{{ fan_in.results[0].item_count }}"
`);
    const state = await new WorkflowEngine(projectDir).execute(d);
    expect(state.status).toBe(RunStatus.COMPLETED);
    const out = (state.stepResults.each as Dict).output as Dict;
    expect((out.results as Dict[]).map((r) => r.stdout)).toEqual(['a', 'b', 'c']);
    expect(state.stepResults['each:echo:2']).toBeDefined();
    expect(((state.stepResults.join as Dict).output as Dict).count).toBe(3);
  });

  test('concurrent fan-out runs items in parallel but returns them in item order', async () => {
    const d = def(`${HEADER('fan-conc')}steps:
  - id: each
    type: fan-out
    max_concurrency: 3
    items: "{{ [3, 1, 2] }}"
    step:
      id: sleepy
      type: shell
      run: "sleep 0.{{ item }}; printf {{ item }}"
`);
    const started = Date.now();
    const state = await new WorkflowEngine(projectDir).execute(d);
    const elapsed = Date.now() - started;
    expect(state.status).toBe(RunStatus.COMPLETED);
    const out = (state.stepResults.each as Dict).output as Dict;
    expect((out.results as Dict[]).map((r) => r.stdout)).toEqual(['3', '1', '2']);
    expect(elapsed).toBeLessThan(550);
  });

  test('a failing fan-out item halts the run and truncates results at the halting item', async () => {
    for (const conc of [1, 4]) {
      const d = def(`${HEADER('fan-halt')}steps:
  - id: each
    type: fan-out
    max_concurrency: ${conc}
    items: "{{ [0, 1, 0, 0] }}"
    step:
      id: run
      type: shell
      run: "exit {{ item }}"
  - id: never
    type: shell
    run: echo
`);
      const state = await new WorkflowEngine(projectDir).execute(d);
      expect(state.status).toBe(RunStatus.FAILED);
      expect(state.error).toBe('Shell command exited with code 1.');
      const out = (state.stepResults.each as Dict).output as Dict;
      expect((out.results as unknown[]).length).toBe(2);
      expect(state.stepResults.never).toBeUndefined();
    }
  });

  test('empty items normalize results to []', async () => {
    const d = def(`${HEADER('fan-empty')}steps:
  - id: each
    type: fan-out
    items: "{{ [] }}"
    step:
      id: x
      type: shell
      run: echo
`);
    const state = await new WorkflowEngine(projectDir).execute(d);
    expect(((state.stepResults.each as Dict).output as Dict).results).toEqual([]);
  });
});

describe('resume', () => {
  test('resume merges inputs and continues after a paused gate', async () => {
    const d = def(`${HEADER('resume-wf')}inputs:
  verdict:
    type: string
    default: ""
  name:
    type: string
    default: first
steps:
  - id: g
    type: gate
    message: m
    verdict_input: verdict
  - id: echo
    type: shell
    run: "printf {{ inputs.name }}"
`);
    const engine = new WorkflowEngine(projectDir);
    const state = await engine.execute(d);
    expect(state.status).toBe(RunStatus.PAUSED);
    const resumed = await engine.resume(state.runId, { verdict: 'approve', name: 'second' });
    expect(resumed.status).toBe(RunStatus.COMPLETED);
    expect(((resumed.stepResults.echo as Dict).output as Dict).stdout).toBe('second');
    expect(resumed.inputs).toEqual({ verdict: 'approve', name: 'second' });
  });

  test('resume of a completed run is refused', async () => {
    const d = def(`${HEADER('done-wf')}steps:\n  - id: a\n    type: shell\n    run: echo\n`);
    const engine = new WorkflowEngine(projectDir);
    const state = await engine.execute(d);
    await expect(engine.resume(state.runId)).rejects.toThrow(
      `Cannot resume run '${state.runId}' with status 'completed'.`,
    );
  });

  test('an out-of-range current_step_index is rejected', async () => {
    const d = def(`${HEADER('range-wf')}steps:\n  - id: g\n    type: gate\n    message: m\n`);
    const engine = new WorkflowEngine(projectDir);
    const state = await engine.execute(d);
    const statePath = join(projectDir, '.specify/workflows/runs', state.runId, 'state.json');
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    raw.current_step_index = 5;
    writeFileSync(statePath, JSON.stringify(raw));
    await expect(engine.resume(state.runId)).rejects.toThrow(
      "Invalid run state: 'current_step_index' (5) is out of range for workflow 'range-wf' with 1 step(s).",
    );
  });

  test('listRuns returns persisted runs sorted by run id', async () => {
    const d = def(`${HEADER('lr')}steps:\n  - id: a\n    type: shell\n    run: echo\n`);
    const engine = new WorkflowEngine(projectDir);
    await engine.execute(d, null, { runId: 'bbb' });
    await engine.execute(d, null, { runId: 'aaa' });
    mkdirSync(join(projectDir, '.specify/workflows/runs/broken'), { recursive: true });
    writeFileSync(join(projectDir, '.specify/workflows/runs/broken/state.json'), 'nope');
    expect(engine.listRuns().map((r) => r.run_id)).toEqual(['aaa', 'bbb']);
  });
});
