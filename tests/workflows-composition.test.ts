/**
 * Scoped workflow calls and the persisted execution tree (port of upstream
 * ``tests/workflows/test_composition_execution.py`` from #4764, plus the
 * command_status/command_resume additions of the same PR).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { STEP_REGISTRY } from '../src/workflows/index.js';
import { RunStatus, StepBase, StepContext, StepResult, StepStatus, type Dict } from '../src/workflows/base.js';
import { RunState, WorkflowDefinition, WorkflowEngine, validateWorkflow } from '../src/workflows/engine.js';
import { WorkflowRegistry } from '../src/workflows/catalog/domain.js';
import { requireJson, validateOutputs } from '../src/workflows/composition.js';
import { evaluateExpression } from '../src/workflows/expressions.js';
import { FanInStep } from '../src/workflows/step/fan-in.js';
import { workflowRunPayload } from '../src/workflows/commands.js';
import { dumpYaml, parseYaml } from '../src/yaml.js';

let root: string;
let counts: Record<string, number>;

function definition(name: string, steps: Dict[], fields: Dict = {}): WorkflowDefinition {
  return new WorkflowDefinition({ workflow: { id: name, name }, steps, ...fields });
}

function install(child: WorkflowDefinition, enabled = true): string {
  const directory = join(root, '.specify', 'workflows', child.id as string);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'workflow.yml'), dumpYaml(child.data), 'utf8');
  new WorkflowRegistry(root).add(child.id as string, { version: '1.0.0', enabled });
  return directory;
}

function call(target: unknown = 'child', extra: Dict = {}): Dict {
  return { id: 'call', type: 'workflow', workflow: target, ...extra };
}

class Probe extends StepBase {
  static override typeKey = 'probe';
  execute(config: Dict, context: StepContext): StepResult {
    const id = config.id as string;
    counts[id] = (counts[id] ?? 0) + 1;
    const value = evaluateExpression(config.value ?? null, context);
    let status = (config.status as string) ?? 'completed';
    if (config.await && !context.inputs.approve) status = 'paused';
    return new StepResult({
      status: status as StepStatus,
      output: { value, ...((config.output as Dict) ?? {}) },
    });
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-compose-')));
  mkdirSync(join(root, '.specify'), { recursive: true });
  counts = {};
  STEP_REGISTRY.set('probe', new Probe());
});

afterEach(() => {
  STEP_REGISTRY.delete('probe');
  STEP_REGISTRY.delete('temporarily-installed');
  rmSync(root, { recursive: true, force: true });
});

const engine = (): WorkflowEngine => new WorkflowEngine(root);

describe('scoped calls', () => {
  test('test_declared_output_and_scope_isolation', async () => {
    install(
      definition(
        'child',
        [
          { id: 'inspect', type: 'probe', value: '{{ inputs.value }}' },
          { id: 'private', type: 'probe', value: '{{ steps.parent.output.value }}' },
        ],
        {
          inputs: { value: { type: 'string' } },
          outputs: {
            value: { value: '{{ steps.inspect.output.value }}' },
            hidden: { value: '{{ steps.private.output.value }}' },
          },
        },
      ),
    );
    const state = await engine().execute(
      definition('parent', [
        { id: 'parent', type: 'probe', value: 'secret' },
        call('child', { input: { value: 'mapped' } }),
        { id: 'consume', type: 'probe', value: '{{ steps.call.output.value }}' },
      ]),
    );
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect(state.stepResults.call?.output).toEqual({ workflow: 'child', status: 'completed', value: 'mapped', hidden: null });
    expect((state.stepResults.consume?.output as Dict).value).toBe('mapped');
    expect('inspect' in state.stepResults).toBe(false);
    expect(readdirSync(join(root, '.specify/workflows/runs')).length).toBe(1);
  });

  test('test_nested_resume_freezes_branch_binding_and_completed_prefix', async () => {
    const directory = install(
      definition(
        'child',
        [
          { id: 'prepare', type: 'probe' },
          { id: 'wait', type: 'probe', await: true },
        ],
        { inputs: { approve: { type: 'boolean', default: false } } },
      ),
    );
    const parent = definition(
      'parent',
      [
        {
          id: 'route',
          type: 'if',
          condition: '{{ inputs.choose }}',
          then: [call('child', { input: { approve: '{{ inputs.approve }}' } })],
          else: [{ id: 'wrong', type: 'probe' }],
        },
      ],
      { inputs: { choose: { type: 'boolean', default: true }, approve: { type: 'boolean', default: false } } },
    );
    let state = await engine().execute(parent);
    expect(state.status).toBe(RunStatus.PAUSED);
    writeFileSync(join(directory, 'workflow.yml'), 'invalid', 'utf8');
    state = await engine().resume(state.runId, { choose: false });
    expect(state.status).toBe(RunStatus.PAUSED);
    state = await engine().resume(state.runId, { approve: true });
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect(counts).toEqual({ prepare: 1, wait: 3 });
  });

  for (const [status, aborted, handled, expected] of [
    ['failed', false, false, 'failed'],
    ['failed', false, true, 'completed'],
    ['failed', true, true, 'aborted'],
    ['paused', false, true, 'paused'],
  ] as const) {
    test(`test_call_outcomes ${status} aborted=${aborted} handled=${handled}`, async () => {
      install(definition('child', [{ id: 'work', type: 'probe', status, output: { aborted } }]));
      const state = await engine().execute(
        definition('parent', [call('child', { continue_on_error: handled }), { id: 'after', type: 'probe' }]),
      );
      expect(state.status).toBe(expected);
      expect(Boolean(counts.after)).toBe(expected === 'completed');
      expect((state.stepResults.call?.output as Dict).status).toBe(aborted ? 'aborted' : status);
    });
  }

  for (const target of [' child', 'child\n', 'CHILD', '../child', 'runs', 123]) {
    test(`test_invalid_targets_are_handled_failures ${JSON.stringify(target)}`, async () => {
      const state = await engine().execute(definition('parent', [call(target, { continue_on_error: true })]));
      expect(state.status).toBe(RunStatus.COMPLETED);
      expect(state.stepResults.call?.status).toBe('failed');
      RunState.load(state.runId, root);
    });
  }

  for (const mapping of [{ unknown: 'x' }, { value: [] }, [1], null]) {
    test(`test_invalid_inputs_do_not_execute_child ${JSON.stringify(mapping)}`, async () => {
      install(
        definition('child', [{ id: 'work', type: 'probe' }], {
          inputs: { value: { type: 'string', required: true } },
        }),
      );
      const state = await engine().execute(definition('parent', [call('child', { input: mapping })]));
      expect(state.status).toBe(RunStatus.FAILED);
      expect(counts).toEqual({});
      RunState.load(state.runId, root);
    });
  }

  test('test_diamond_and_depth_limit', async () => {
    install(definition('leaf', [{ id: 'work', type: 'probe' }]));
    for (const name of ['left', 'right']) install(definition(name, [call('leaf')]));
    let state = await engine().execute(
      definition('parent', [
        { ...call('left'), id: 'left' },
        { ...call('right'), id: 'right' },
      ]),
    );
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect(counts.work).toBe(2);
    for (let index = 1; index < 18; index++) {
      install(
        definition(
          `level-${index}`,
          index < 17 ? [call(`level-${index + 1}`)] : [{ id: 'too-deep', type: 'probe' }],
        ),
      );
    }
    state = await engine().execute(definition('parent', [call('level-1')]));
    expect(state.status).toBe(RunStatus.FAILED);
    expect(state.error).toContain('depth 16');
    expect(counts['too-deep'] ?? 0).toBe(0);
  });

  test('a composition cycle is a handled call failure', async () => {
    install(definition('loop-a', [call('loop-b')]));
    install(definition('loop-b', [call('loop-a')]));
    const state = await engine().execute(definition('parent', [call('loop-a')]));
    expect(state.status).toBe(RunStatus.FAILED);
    expect(state.error).toContain('Workflow composition cycle: parent -> loop-a -> loop-b -> loop-a');
  });

  test('disabled and missing targets are call failures', async () => {
    install(definition('child', [{ id: 'work', type: 'probe' }]), false);
    let state = await engine().execute(definition('parent', [call('child')]));
    expect(state.error).toBe("Workflow 'child' is disabled");
    state = await engine().execute(definition('parent', [call('ghost')]));
    expect(state.error).toBe("Workflow 'ghost' is not installed");
  });

  test('test_output_validation_rejects_reserved_and_yaml_native_values', () => {
    const circular: unknown[] = [];
    circular.push(circular);
    for (const value of [circular, NaN, Infinity]) {
      expect(() => requireJson(value)).toThrow('JSON-safe');
    }
    for (const outputs of [{ status: { value: 'oops' } }, { value: { wrong: 1 } }, 'not a mapping']) {
      expect(validateOutputs(outputs).length).toBeGreaterThan(0);
    }
    expect(validateOutputs({ ok: { value: '{{ inputs.x }}' } })).toEqual([]);
  });

  test('outputs are validated with the workflow', () => {
    expect(validateWorkflow(definition('parent', [], { outputs: { status: { value: 1 } } }))).toContain(
      "Output 'status' is reserved",
    );
  });

  test('a call step validates its target and input shape', () => {
    const errors = validateWorkflow(definition('parent', [call('UPPER', { input: [1] })]));
    expect(errors.some((e) => e.includes("'workflow' must be an exact, safe, non-reserved workflow ID"))).toBe(true);
    expect(errors.some((e) => e.includes("'input' must be a mapping with string keys"))).toBe(true);
  });
});

describe('execution tree persistence', () => {
  test('test_legacy_resume_adapts_once', async () => {
    const parent = definition(
      'parent',
      [
        { id: 'before', type: 'probe' },
        { id: 'wait', type: 'probe', await: true },
      ],
      { inputs: { approve: { type: 'boolean', default: false } } },
    );
    let state = await engine().execute(parent);
    const path = join(state.runsDir, 'state.json');
    const data = JSON.parse(readFileSync(path, 'utf8')) as Dict;
    delete data.execution;
    writeFileSync(path, JSON.stringify(data));
    state = await engine().resume(state.runId);
    expect(state.status).toBe(RunStatus.PAUSED);
    state = await engine().resume(state.runId, { approve: true });
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect(counts).toEqual({ before: 1, wait: 3 });
  });

  test('test_version_one_tree_rejected_without_writes', async () => {
    const state = await engine().execute(definition('parent', [{ id: 'wait', type: 'probe', await: true }]));
    const path = join(state.runsDir, 'state.json');
    const data = JSON.parse(readFileSync(path, 'utf8')) as Dict;
    (data.execution as Dict).version = 1;
    writeFileSync(path, JSON.stringify(data));
    const snapshot = (): Record<string, string> =>
      Object.fromEntries(readdirSync(state.runsDir).map((n) => [n, readFileSync(join(state.runsDir, n), 'utf8')]));
    const before = snapshot();
    await expect(engine().resume(state.runId)).rejects.toThrow('Unsupported execution version');
    expect(snapshot()).toEqual(before);
  });

  test('test_bad_checkpoint_rejected_without_writes', async () => {
    const state = await engine().execute(definition('parent', [{ id: 'wait', type: 'probe', await: true }]));
    const path = join(state.runsDir, 'state.json');
    const data = JSON.parse(readFileSync(path, 'utf8')) as Dict;
    (((data.execution as Dict).sequence as Dict).nodes as Dict[])[0]!.phase = 'nonsense';
    writeFileSync(path, JSON.stringify(data));
    expect(() => RunState.load(state.runId, root)).toThrow('Invalid execution phase');
  });

  test('test_unknown_step_type_resumes_after_reinstall', async () => {
    let state = await engine().execute(
      definition('parent', [{ id: 'missing', type: 'temporarily-installed' }]),
      null,
      { runId: 'reinstall' },
    );
    expect(state.status).toBe(RunStatus.FAILED);
    expect(state.error).toBe("Unknown step type: 'temporarily-installed'");
    class Reinstalled extends StepBase {
      static override typeKey = 'temporarily-installed';
      execute(): StepResult {
        return new StepResult({ status: StepStatus.COMPLETED });
      }
    }
    STEP_REGISTRY.set('temporarily-installed', new Reinstalled());
    state = await engine().resume('reinstall');
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect(state.stepResults.missing?.status).toBe('completed');
  });

  test('test_resume_rejects_changed_workflow_snapshot', async () => {
    const state = await engine().execute(
      definition(
        'parent',
        [{ id: 'fan', type: 'fan-out', items: [1, 2], step: { id: 'wait', type: 'probe', await: true } }],
        { inputs: { approve: { type: 'boolean', default: false } } },
      ),
      null,
      { runId: 'changed' },
    );
    expect(state.status).toBe(RunStatus.PAUSED);
    const copy = join(root, '.specify/workflows/runs/changed/workflow.yml');
    const data = parseYaml(readFileSync(copy, 'utf8')) as Dict;
    ((data.steps as Dict[])[0] as Dict).items = [1, 2, 3];
    writeFileSync(copy, dumpYaml(data, { sortKeys: false }), 'utf8');
    await expect(engine().resume('changed', { approve: true })).rejects.toThrow('root sequence differs');
  });

  test('state.json carries inputs and the execution tree', async () => {
    const state = await engine().execute(definition('parent', [{ id: 'a', type: 'probe' }], { inputs: { x: { type: 'string', default: 'é' } } }));
    const raw = JSON.parse(readFileSync(join(state.runsDir, 'state.json'), 'utf8')) as Dict;
    expect(raw.inputs).toEqual({ x: 'é' });
    expect((raw.execution as Dict).version).toBe(2);
    expect(readFileSync(join(state.runsDir, 'state.json'), 'utf8')).toContain('"x": "é"');
  });
});

describe('events, aliases and reporting', () => {
  test('test_loop_events_and_callbacks_use_qualified_iteration_ids', async () => {
    const callbacks: string[] = [];
    const eng = engine();
    eng.onStepStart = (stepId) => callbacks.push(stepId);
    const state = await eng.execute(
      definition('parent', [
        { id: 'loop', type: 'do-while', condition: true, max_iterations: 2, steps: [{ id: 'body', type: 'probe' }] },
      ]),
    );
    const events = state.logEntries
      .filter((e) => e.event === 'step_started' || e.event === 'step_completed')
      .map((e) => [e.event, e.step_id]);
    expect(callbacks).toEqual(['loop', 'body', 'loop:body:1']);
    expect(events).toEqual([
      ['step_started', 'loop'],
      ['step_completed', 'loop'],
      ['step_started', 'body'],
      ['step_completed', 'body'],
      ['step_started', 'loop:body:1'],
      ['step_completed', 'loop:body:1'],
    ]);
  });

  test('test_fan_out_events_and_callbacks_use_qualified_item_ids', async () => {
    const callbacks: string[] = [];
    const eng = engine();
    eng.onStepStart = (stepId) => callbacks.push(stepId);
    const state = await eng.execute(
      definition('parent', [{ id: 'fan', type: 'fan-out', items: [1, 2], step: { id: 'template', type: 'probe' } }]),
    );
    const events = state.logEntries
      .filter((e) => e.event === 'step_started' || e.event === 'step_completed')
      .map((e) => [e.event, e.step_id]);
    expect(callbacks).toEqual(['fan', 'fan:template:0', 'fan:template:1']);
    expect(events).toEqual([
      ['step_started', 'fan'],
      ['step_completed', 'fan'],
      ['step_started', 'fan:template:0'],
      ['step_completed', 'fan:template:0'],
      ['step_started', 'fan:template:1'],
      ['step_completed', 'fan:template:1'],
    ]);
    expect((state.stepResults.fan?.output as Dict).results).toEqual([{ value: null }, { value: null }]);
    expect(state.stepResults['fan:template:1']?.status).toBe('completed');
  });

  test('concurrent fan-out keeps item order and isolates item contexts', async () => {
    const state = await engine().execute(
      definition('parent', [
        {
          id: 'fan',
          type: 'fan-out',
          items: ['a', 'b', 'c'],
          max_concurrency: 2,
          step: { id: 'work', type: 'probe', value: '{{ item }}' },
        },
      ]),
    );
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect((state.stepResults.fan?.output as Dict).results).toEqual([{ value: 'a' }, { value: 'b' }, { value: 'c' }]);
  });

  test('test_fan_in_rejects_item_alias_at_runtime', () => {
    const result = new FanInStep().execute(
      { id: 'join', type: 'fan-in', wait_for: ['fan:template:0'] },
      new StepContext(),
    ) as StepResult;
    expect(result.status).toBe(StepStatus.FAILED);
    expect(result.error ?? '').toContain('fan-out item alias');
  });

  test('test_nested_gate_reporting_uses_active_occurrence', async () => {
    install(definition('child', [{ id: 'review', type: 'gate', message: 'Approve' }]));
    const state = await engine().execute(
      definition('parent', [{ id: 'route', type: 'if', condition: true, then: [call()] }]),
    );
    expect(state.status).toBe(RunStatus.PAUSED);
    const payload = workflowRunPayload(RunState.load(state.runId, root));
    expect(payload.current_step_id).toBe('review');
    expect((payload.gate as Dict).step_id).toBe('review');
    expect((payload.gate as Dict).scope_path).toEqual(['route', 'call']);
    expect(((payload.workflow_scopes as Dict[])[0] as Dict).status).toBe('paused');
  });

  test('test_gate_message_keeps_typed_template_result', async () => {
    const wf = definition('parent', [{ id: 'gate', type: 'gate', message: '{{ inputs.notice }}' }], {
      inputs: { notice: { type: 'number' } },
    });
    expect(validateWorkflow(wf)).toEqual([]);
    const state = await engine().execute(wf, { notice: 42 });
    expect(state.status).toBe(RunStatus.PAUSED);
    const loaded = RunState.load(state.runId, root);
    expect((loaded.stepResults.gate?.output as Dict).message).toBe(42);
    expect((workflowRunPayload(loaded).gate as Dict).message).toBe('42');
  });

  test('private scope events include execution_path and workflow_id', async () => {
    install(definition('child', [{ id: 'work', type: 'probe' }]));
    const state = await engine().execute(definition('parent', [call()]));
    const inner = state.logEntries.find((e) => e.event === 'step_started' && e.step_id === 'work') as Dict;
    expect(inner.workflow_id).toBe('child');
    expect(inner.execution_path).toEqual([0, 'workflow', 0]);
  });
});
