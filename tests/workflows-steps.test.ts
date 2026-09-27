/**
 * Unit tests for every built-in workflow step type (ports of the
 * ``TestCommandStep``/``TestPromptStep``/``TestShellStep``/``TestInitStep``/
 * ``TestGateStep``/``TestIfThenStep``/``TestSwitchStep``/``TestWhileStep``/
 * ``TestDoWhileStep``/``TestFanOutStep``/``TestFanInStep`` and slot-step
 * cases from upstream).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
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
  StepContext,
  StepStatus,
  SwitchStep,
  WhileStep,
  type Dict,
} from '../src/workflows/index.js';

let dir: string;
const origCmd = CommandStep.tryDispatch;
const origPrompt = PromptStep.tryDispatch;
const origTTY = GateStep.stdinIsTTY;
const origGatePrompt = GateStep.prompt;
const origRunInit = InitStep.runInit;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'speckit-wf-steps-'));
  GateStep.stdinIsTTY = () => false;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  CommandStep.tryDispatch = origCmd;
  PromptStep.tryDispatch = origPrompt;
  GateStep.stdinIsTTY = origTTY;
  GateStep.prompt = origGatePrompt;
  InitStep.runInit = origRunInit;
});

const ctx = (init: ConstructorParameters<typeof StepContext>[0] = {}): StepContext =>
  new StepContext({ projectRoot: dir, ...init });

// ============================================================================
// command
// ============================================================================

describe('CommandStep', () => {
  test('validate', () => {
    const s = new CommandStep();
    expect(s.validate({ id: 'a', command: 'speckit.plan' })).toEqual([]);
    expect(s.validate({ id: 'a' })).toEqual(["Command step 'a' is missing 'command' field."]);
    expect(s.validate({ command: 'x' })).toEqual([
      "Step is missing required 'id' field.",
    ]);
    expect(
      s.validate({
        id: 'a',
        command: 5,
        input: [],
        options: 'x',
        integration_args: ['ok', 3],
        integration_options: [],
        integration: ['x'],
        model: 3,
      }),
    ).toEqual([
      "Command step 'a': 'command' must be a string, got int.",
      "Command step 'a': 'input' must be a mapping.",
      "Command step 'a': 'options' must be a mapping.",
      "Command step 'a': 'integration_args[1]' must be a string.",
      "Command step 'a': 'integration_options' must be a mapping.",
      "Command step 'a': 'integration' must be a string, got list.",
      "Command step 'a': 'model' must be a string, got int.",
    ]);
  });

  test('execute guards malformed config on unvalidated runs', async () => {
    const s = new CommandStep();
    let r = await s.execute({ id: 'a', command: ['x'] }, ctx());
    expect(r.status).toBe(StepStatus.FAILED);
    expect(r.error).toBe("Command step 'a': 'command' must be a string, got list.");
    r = await s.execute({ id: 'a', command: 'x', input: 'nope' }, ctx());
    expect(r.error).toBe("Command step 'a': 'input' must be a mapping, got str.");
    r = await s.execute({ id: 'a', command: 'x', integration: '{{ inputs.list }}' }, ctx({ inputs: { list: [1] } }));
    expect(r.error).toBe("Command step 'a': 'integration' must be a string, got list.");
    r = await s.execute({ id: 'a', command: 'x', integration_args: ['{{ inputs.n }}'] }, ctx({ inputs: { n: 5 } }));
    expect(r.error).toBe("Command step 'a': 'integration_args[0]' must resolve to a string, got int.");
    r = await s.execute({ id: 'a', command: 'x', options: [] }, ctx());
    expect(r.error).toBe("Command step 'a': 'options' must be a mapping, got list.");
  });

  test('non-zero dispatch exit fails with stderr (or exit code) as the error', async () => {
    CommandStep.tryDispatch = async () => ({ exit_code: 2, stdout: '', stderr: '' });
    const r = await new CommandStep().execute({ id: 'a', command: 'x', integration: 'claude' }, ctx());
    expect(r.status).toBe(StepStatus.FAILED);
    expect(r.error).toBe('Command exited with code 2');
    expect(r.output.exit_code).toBe(2);
    expect(r.output.dispatched).toBe(true);
  });

  test('without an integration the real dispatcher reports not dispatchable', async () => {
    const r = await new CommandStep().execute({ id: 'a', command: 'speckit.x' }, ctx());
    expect(r.status).toBe(StepStatus.FAILED);
    expect(r.error).toBe(
      "Cannot dispatch command 'speckit.x': integration None CLI not found or not installed. Install the CLI tool or check 'specify integration list'.",
    );
    expect(r.output.dispatched).toBe(false);
  });
});

// ============================================================================
// prompt
// ============================================================================

describe('PromptStep', () => {
  test('validate', () => {
    const s = new PromptStep();
    expect(s.validate({ id: 'p', prompt: 'hi' })).toEqual([]);
    expect(s.validate({ id: 'p' })).toEqual(["Prompt step 'p' is missing 'prompt' field."]);
    expect(s.validate({ id: 'p', prompt: null, timeout: true })).toEqual([
      "Prompt step 'p': 'prompt' must be a string, got NoneType.",
      "Prompt step 'p': 'timeout' must be a positive number of seconds, got True.",
    ]);
    expect(s.validate({ id: 'p', prompt: 'x', timeout: 0 })).toEqual([
      "Prompt step 'p': 'timeout' must be a positive number of seconds, got 0.",
    ]);
  });

  test('execute resolves the prompt and dispatches', async () => {
    const seen: unknown[] = [];
    PromptStep.tryDispatch = async (prompt, integration, model, _c, timeout) => {
      seen.push(prompt, integration, model, timeout);
      return { exit_code: 0, stdout: '', stderr: '' };
    };
    const r = await new PromptStep().execute(
      { id: 'p', prompt: 'Review {{ inputs.file }}', timeout: 5 },
      ctx({ inputs: { file: 'a.py' }, defaultIntegration: 'claude', defaultModel: 'm' }),
    );
    expect(r.status).toBe(StepStatus.COMPLETED);
    expect(seen).toEqual(['Review a.py', 'claude', 'm', 5]);
    expect(r.output).toEqual({ prompt: 'Review a.py', integration: 'claude', model: 'm', exit_code: 0, stdout: '', stderr: '', dispatched: true });
  });

  test('undispatchable prompt fails', async () => {
    const r = await new PromptStep().execute({ id: 'p', prompt: 'x' }, ctx());
    expect(r.error).toBe('Cannot dispatch prompt: integration None CLI not found or not installed.');
  });
});

// ============================================================================
// shell
// ============================================================================

describe('ShellStep', () => {
  test('captures stdout/stderr/exit code', async () => {
    const r = await new ShellStep().execute({ id: 's', run: 'echo out; echo err 1>&2' }, ctx());
    expect(r.status).toBe(StepStatus.COMPLETED);
    expect(r.output).toEqual({ exit_code: 0, stdout: 'out\n', stderr: 'err\n' });
  });

  test('non-zero exit fails', async () => {
    const r = await new ShellStep().execute({ id: 's', run: 'exit 7' }, ctx());
    expect(r.status).toBe(StepStatus.FAILED);
    expect(r.error).toBe('Shell command exited with code 7.');
    expect(r.output.exit_code).toBe(7);
  });

  test('output_format json parses stdout, and fails on invalid JSON', async () => {
    let r = await new ShellStep().execute({ id: 's', run: `echo '{"a": [1]}'`, output_format: 'json' }, ctx());
    expect(r.output.data).toEqual({ a: [1] });
    r = await new ShellStep().execute({ id: 's', run: 'echo nope', output_format: 'json' }, ctx());
    expect(r.status).toBe(StepStatus.FAILED);
    expect(r.error).toStartWith("Shell step 's' declared output_format: json but stdout is not valid JSON: ");
  });

  test('timeout', async () => {
    const r = await new ShellStep().execute({ id: 's', run: 'sleep 5', timeout: 0.2 }, ctx());
    expect(r.status).toBe(StepStatus.FAILED);
    expect(r.error).toBe('Shell command timed out after 0.2 seconds.');
    expect(r.output).toEqual({ exit_code: -1, stdout: '', stderr: 'timeout' });
  });

  test('invalid timeout is rejected by execute and validate', async () => {
    const r = await new ShellStep().execute({ id: 's', run: 'echo', timeout: 'x' }, ctx());
    expect(r.error).toBe("Shell step 's': 'timeout' must be a positive number of seconds, got 'x'.");
    expect(r.output).toEqual({ exit_code: -1, stdout: '', stderr: 'invalid timeout' });
    expect(new ShellStep().validate({ id: 's', run: ['echo'], output_format: 'yaml', timeout: -1 })).toEqual([
      "Shell step 's': 'run' must be a string, got list.",
      "Shell step 's': 'output_format' must be 'json' when present, got 'yaml'.",
      "Shell step 's': 'timeout' must be a positive number of seconds, got -1.",
    ]);
  });

  test('runs in the project root with expressions resolved', async () => {
    writeFileSync(join(dir, 'marker.txt'), 'm');
    const r = await new ShellStep().execute({ id: 's', run: 'ls {{ inputs.f }}' }, ctx({ inputs: { f: 'marker.txt' } }));
    expect(r.output.stdout).toBe('marker.txt\n');
  });
});

// ============================================================================
// gate
// ============================================================================

describe('GateStep', () => {
  test('validate', () => {
    const s = new GateStep();
    expect(s.validate({ id: 'g', message: 'm' })).toEqual([]);
    expect(s.validate({ id: 'g' })).toEqual(["Gate step 'g' is missing 'message' field."]);
    expect(s.validate({ id: 'g', message: 'm', options: [] })).toEqual([
      "Gate step 'g': 'options' must be a non-empty list.",
      // Upstream quirk kept: all() over an empty list is true, so the
      // missing-reject check also fires.
      "Gate step 'g': on_reject='abort' but options has no 'reject' or 'abort' choice.",
    ]);
    expect(s.validate({ id: 'g', message: 'm', options: ['ok', 1] })).toEqual([
      "Gate step 'g': all options must be strings.",
    ]);
    expect(s.validate({ id: 'g', message: 'm', on_reject: 'stop' })).toEqual([
      "Gate step 'g': 'on_reject' must be 'abort', 'skip', or 'retry'.",
    ]);
    expect(s.validate({ id: 'g', message: 'm', options: ['approve', 'later'] })).toEqual([
      "Gate step 'g': on_reject='abort' but options has no 'reject' or 'abort' choice.",
    ]);
    expect(s.validate({ id: 'g', message: 'm', verdict_input: '' })).toEqual([
      "Gate step 'g': 'verdict_input' must be a non-empty string.",
    ]);
  });

  test('non-TTY pauses with the resolved message', async () => {
    const r = await new GateStep().execute({ id: 'g', message: 'Review {{ inputs.x }}' }, ctx({ inputs: { x: 'spec' } }));
    expect(r.status).toBe(StepStatus.PAUSED);
    expect(r.output).toEqual({
      message: 'Review spec',
      options: ['approve', 'reject'],
      on_reject: 'abort',
      show_file: null,
      choice: null,
    });
  });

  test('execute guards', async () => {
    const s = new GateStep();
    let r = await s.execute({ id: 'g', options: 'x' }, ctx());
    expect(r.error).toBe("Gate step 'g': 'options' must be a non-empty list of strings, got str.");
    r = await s.execute({ id: 'g', on_reject: null }, ctx());
    expect(r.error).toBe("Gate step 'g': 'on_reject' must be 'abort', 'skip', or 'retry', got None.");
    r = await s.execute({ id: 'g', verdict_input: 'v' }, ctx({ insideFanOut: true }));
    expect(r.error).toBe("Gate step 'g': 'verdict_input' is not supported inside fan-out templates.");
    r = await s.execute({ id: 'g', verdict_input: 'v' }, ctx({ inputs: { v: 'maybe' } }));
    expect(r.error).toBe("Gate step 'g': verdict input 'v' value 'maybe' does not match any configured option.");
    r = await s.execute({ id: 'g', verdict_input: 'v' }, ctx({ inputs: { v: 3 } }));
    expect(r.error).toBe("Gate step 'g': verdict input 'v' must be a string, got int.");
  });

  test('reject with on_reject skip completes; case-insensitive reject aborts', async () => {
    GateStep.stdinIsTTY = () => true;
    GateStep.prompt = async () => 'Reject';
    let r = await new GateStep().execute({ id: 'g', options: ['Approve', 'Reject'], on_reject: 'skip' }, ctx());
    expect(r.status).toBe(StepStatus.COMPLETED);
    expect(r.output.choice).toBe('Reject');
    r = await new GateStep().execute({ id: 'g', options: ['Approve', 'Reject'] }, ctx());
    expect(r.status).toBe(StepStatus.FAILED);
    expect(r.output.aborted).toBe(true);
  });

  test('show_file contents are folded into the prompt, sanitized and bounded', async () => {
    const f = join(dir, 'review.md');
    writeFileSync(f, 'line1\n\x1b[31mred\x1b[0m\n');
    expect(GateStep.composePrompt('Check', f)).toBe(`Check\n\n${f}:\n  line1\n  [31mred[0m`);
    writeFileSync(f, '');
    expect(GateStep.readShowFile(f)).toEqual(['(file is empty)']);
    writeFileSync(f, Array.from({ length: 205 }, (_, i) => `l${i}`).join('\n'));
    const lines = GateStep.readShowFile(f);
    expect(lines).toHaveLength(201);
    expect(lines[200]).toBe('… (output truncated at 200 lines)');
    expect(GateStep.readShowFile(join(dir, 'missing.md'))[0]).toStartWith('(could not read file: [Errno 2] No such file or directory');
  });
});

// ============================================================================
// control flow
// ============================================================================

describe('IfThenStep / SwitchStep / loops', () => {
  test('if picks the branch and guards non-list branches', () => {
    const s = new IfThenStep();
    let r = s.execute({ id: 'i', condition: '{{ inputs.x > 1 }}', then: [{ id: 't' }], else: [{ id: 'e' }] }, ctx({ inputs: { x: 2 } }));
    expect(r.nextSteps).toEqual([{ id: 't' }]);
    expect(r.output).toEqual({ condition_result: true });
    r = s.execute({ id: 'i', condition: false, then: [] }, ctx());
    expect(r.nextSteps).toEqual([]);
    r = s.execute({ id: 'i', condition: true, then: { id: 't' } }, ctx());
    expect(r.error).toBe("If step 'i': 'then' must be a list of steps, got dict.");
    expect(s.validate({ id: 'i', condition: [1], then: 'x', else: 'y' })).toEqual([
      "If step 'i': 'condition' must be a string or boolean, got list.",
      "If step 'i': 'then' must be a list of steps.",
      "If step 'i': 'else' must be a list of steps.",
    ]);
    expect(s.validate({ id: 'i' })).toEqual([
      "If step 'i' is missing 'condition' field.",
      "If step 'i' is missing 'then' field.",
    ]);
  });

  test('switch matching, default and guards', () => {
    const s = new SwitchStep();
    let r = s.execute({ id: 'w', expression: '{{ inputs.v }}', cases: { a: [{ id: 'x' }] }, default: [{ id: 'd' }] }, ctx({ inputs: { v: ' a\n' } }));
    expect(r.output).toEqual({ matched_case: 'a', expression_value: ' a\n' });
    r = s.execute({ id: 'w', expression: '{{ inputs.v }}', cases: { a: [] } }, ctx({ inputs: { v: 'z' } }));
    expect(r.output.matched_case).toBe('__default__');
    r = s.execute({ id: 'w', expression: 'x', cases: [] }, ctx());
    expect(r.error).toBe("Switch step 'w': 'cases' must be a mapping, got list.");
    r = s.execute({ id: 'w', expression: 'a', cases: { a: 'nope' } }, ctx());
    expect(r.error).toBe("Switch step 'w': case 'a' must be a list of steps, got str.");
    expect(s.validate({ id: 'w' })).toEqual([
      "Switch step 'w' is missing 'expression' field.",
      "Switch step 'w' is missing 'cases' field.",
    ]);
  });

  test('while / do-while', () => {
    const w = new WhileStep();
    expect(w.execute({ id: 'l', condition: 'false', steps: [{ id: 'b' }] }, ctx()).nextSteps).toEqual([]);
    expect(w.execute({ id: 'l', condition: 'true', steps: [{ id: 'b' }] }, ctx()).output).toEqual({
      condition_result: true,
      max_iterations: 10,
      loop_type: 'while',
    });
    expect(w.execute({ id: 'l', condition: 'true', steps: {} }, ctx()).error).toBe(
      "While step 'l': 'steps' must be a list of steps, got dict.",
    );
    expect(w.validate({ id: 'l', condition: '{{ true }}', max_iterations: true })).toEqual([
      "While step 'l': 'max_iterations' must be an integer >= 1.",
      "While step 'l' is missing 'steps' field.",
    ]);
    const d = new DoWhileStep();
    expect(d.execute({ id: 'l', condition: 'false', steps: [{ id: 'b' }] }, ctx()).nextSteps).toEqual([{ id: 'b' }]);
    expect(d.execute({ id: 'l', steps: 'x' }, ctx()).error).toBe("Do-while step 'l': 'steps' must be a list of steps, got str.");
    expect(d.validate({ id: 'l', condition: '{{ inputs.a }} and {{ inputs.b }}', steps: [], max_iterations: 0 })[0]).toContain(
      "holds more than one '{{ }}' block",
    );
  });

  test('fan-out / fan-in', () => {
    const fo = new FanOutStep();
    let r = fo.execute({ id: 'f', items: '{{ inputs.list }}', step: { id: 'x' } }, ctx({ inputs: { list: [1, 2] } }));
    expect(r.output).toEqual({ items: [1, 2], max_concurrency: 1, step_template: { id: 'x' }, item_count: 2 });
    r = fo.execute({ id: 'f', items: '{{ inputs.s }}', step: { id: 'x' } }, ctx({ inputs: { s: 'str' } }));
    expect(r.error).toBe("Fan-out step 'f': 'items' must resolve to a list, got str from '{{ inputs.s }}'.");
    r = fo.execute({ id: 'f', items: '{{ [] }}', step: [1] }, ctx());
    expect(r.error).toBe("Fan-out step 'f': 'step' must be a mapping (nested step template), got list.");
    expect(fo.validate({ id: 'f', step: null })).toEqual([
      "Fan-out step 'f' is missing 'items' field.",
      "Fan-out step 'f': 'step' must be a mapping.",
    ]);

    const fi = new FanInStep();
    const c = ctx({ steps: { a: { output: { v: 1 } }, b: { output: { v: 2 } } } });
    r = fi.execute({ id: 'j', wait_for: ['a', 'b', 'missing'], output: { vs: '{{ fan_in.results | map("v") }}', lit: 5 } }, c);
    expect(r.output).toEqual({ results: [{ v: 1 }, { v: 2 }, {}], vs: [1, 2, null], lit: 5 });
    expect(c.fanIn).toEqual({});
    expect(fi.execute({ id: 'j', wait_for: 'a' }, c).error).toBe("Fan-in step 'j': 'wait_for' must be a list of step IDs, got str.");
    expect(fi.execute({ id: 'j', wait_for: [[1]] }, c).error).toBe(
      "Fan-in step 'j': 'wait_for' entries must be step-id strings, got list ([1]).",
    );
    expect(fi.execute({ id: 'j', wait_for: ['a'], output: [] }, c).error).toBe(
      "Fan-in step 'j': 'output' must be a mapping of key -> expression, got list.",
    );
    expect(fi.validate({ id: 'j', wait_for: [] })).toEqual(["Fan-in step 'j': 'wait_for' must be a non-empty list of step IDs."]);
  });

  test('slot skips unless inside a fan-out', () => {
    const s = new SlotStep();
    const r = s.execute({ id: 'post', name: 'post-implement' }, ctx());
    expect(r.status).toBe(StepStatus.SKIPPED);
    expect(r.output).toEqual({ slot: 'post-implement' });
    expect(s.execute({ id: 'post', name: 'x' }, ctx({ insideFanOut: true })).status).toBe(StepStatus.FAILED);
    expect(s.validate({ id: 'post' })).toEqual(["Slot step 'post' requires a 'name' field (the slot label)."]);
    expect(s.validate({ id: 'post', name: '  ' })).toEqual(["Slot step 'post': 'name' must be a non-blank string."]);
  });
});

// ============================================================================
// init
// ============================================================================

describe('InitStep', () => {
  test('builds the specify init argv and captures the result', async () => {
    const calls: string[][] = [];
    InitStep.runInit = async (argv) => {
      calls.push(argv);
      return [0, 'ok', ''];
    };
    const r = await new InitStep().execute(
      { id: 'boot', project: 'my-proj', integration: '{{ inputs.ai }}', script: 'sh', preset: 'lean' },
      ctx({ inputs: { ai: 'claude' } }),
    );
    expect(r.status).toBe(StepStatus.COMPLETED);
    expect(calls[0]).toEqual([
      'init', 'my-proj', '--integration', 'claude', '--script', 'sh', '--preset', 'lean', '--ignore-agent-tools',
    ]);
    expect(r.output.exit_code).toBe(0);
  });

  test('refuses a non-empty current directory without force, auto-forces engine-only content', async () => {
    InitStep.runInit = async () => [0, '', ''];
    writeFileSync(join(dir, 'README.md'), 'x');
    let r = await new InitStep().execute({ id: 'b', here: true }, ctx({ defaultIntegration: 'copilot' }));
    expect(r.status).toBe(StepStatus.FAILED);
    expect(r.error).toBe(`Target directory '${dir}' is not empty. Set 'force: true' to merge into a non-empty directory.`);
    rmSync(join(dir, 'README.md'));
    mkdirSync(join(dir, '.specify'));
    r = await new InitStep().execute({ id: 'b', here: true, ignore_agent_tools: null }, ctx({ defaultIntegration: 'copilot' }));
    expect(r.status).toBe(StepStatus.COMPLETED);
    expect(r.output.force).toBe(true);
    expect(r.output.argv).toEqual(['init', '--here', '--integration', 'copilot', '--ignore-agent-tools', '--force']);
  });

  test('failure surfaces stderr, and script validation', async () => {
    InitStep.runInit = async () => [1, '', 'boom\n'];
    const r = await new InitStep().execute({ id: 'b', project: 'p' }, ctx({ defaultIntegration: 'x' }));
    expect(r.error).toBe('boom');
    expect(new InitStep().validate({ id: 'b', script: 'bash' })).toEqual([
      "Init step 'b': 'script' must be 'sh' or 'ps' or 'py'.",
    ]);
    expect(new InitStep().validate({ id: 'b', script: 1 })).toEqual([
      "Init step 'b': 'script' must be a string ('sh' or 'ps' or 'py').",
    ]);
  });
});

void ({} as Dict);
