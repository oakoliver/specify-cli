/**
 * Step and CLI behaviour added upstream between spec-kit v1.0.12 and v1.2.5:
 * ports of ``tests/workflows/test_step_capture.py`` (#4957),
 * ``tests/workflows/test_github_step.py`` (#4905), and the gate (#4529),
 * init (#4530), shell (#5064), number-input (#5027), JSON failure-report
 * (#5015) and run-artifact (#4877) cases of ``tests/test_workflows.py`` and
 * ``tests/specify_cli/workflows/test_command_{run,resume}.py``.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunStatus, StepContext, StepResult, StepStatus, type Dict } from '../src/workflows/base.js';
import { RunState, WorkflowDefinition, WorkflowEngine, validateWorkflow } from '../src/workflows/engine.js';
import { runWorkflowCommand } from '../src/workflows/commands.js';
import { CommandStep } from '../src/workflows/step/command.js';
import { PromptStep } from '../src/workflows/step/prompt.js';
import { GateStep } from '../src/workflows/step/gate.js';
import { GitHubStep, type GhRunResult } from '../src/workflows/step/github.js';
import { InitStep } from '../src/workflows/step/init.js';
import { ShellStep, decodeUtf8Strict } from '../src/workflows/step/shell.js';
import { setPromptInput } from '../src/console.js';

const posix = process.platform !== 'win32';
let root: string;
const savedPath = process.env.PATH;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-steps12-')));
  mkdirSync(join(root, '.specify'), { recursive: true });
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

/** Put a fake ``claude`` CLI on PATH that echoes its argv and some stderr. */
function fakeClaude(body = 'printf "%s|" "$@"; printf "warn" >&2'): void {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const exe = join(bin, 'claude');
  writeFileSync(exe, `#!/bin/sh\n${body}\n`);
  chmodSync(exe, 0o755);
  process.env.PATH = `${bin}:${savedPath}`;
}

const ctx = (init: ConstructorParameters<typeof StepContext>[0] = {}): StepContext =>
  new StepContext({ projectRoot: root, ...init });

// ============================================================================
// capture: true (#4957)
// ============================================================================

describe('command/prompt capture', () => {
  test('test_valid_configs_pass and invalid capture configs are rejected', () => {
    const step = new CommandStep();
    expect(step.validate({ id: 'a', command: 'speckit.plan', capture: true, capture_max_bytes: 10 })).toEqual([]);
    expect(step.validate({ id: 'a', command: 'speckit.plan', capture: 'yes' })).toEqual([
      "Command step 'a': 'capture' must be true or false, got 'yes'.",
    ]);
    expect(step.validate({ id: 'a', command: 'speckit.plan', capture: true, capture_max_bytes: 0 })).toEqual([
      "Command step 'a': 'capture_max_bytes' must be a positive integer or -1 (no limit), got 0.",
    ]);
    expect(step.validate({ id: 'a', command: 'speckit.plan', capture_max_bytes: 5 })).toEqual([
      "Command step 'a': 'capture_max_bytes' requires 'capture: true'.",
    ]);
    expect(step.validate({ id: 'a', command: 'speckit.plan', capture: true, timeout: -1 })).toEqual([
      "Command step 'a': 'timeout' must be a positive number of seconds, got -1.",
    ]);
    // test_streaming_command_timeout_stays_unchecked
    expect(step.validate({ id: 'a', command: 'speckit.plan', timeout: -1 })).toEqual([]);
    expect(new PromptStep().validate({ id: 'p', prompt: 'x', capture: 1 })).toEqual([
      "Prompt step 'p': 'capture' must be true or false, got 1.",
    ]);
  });

  test('test_unvalidated_execute_fails_the_step_without_dispatching', async () => {
    let dispatched = false;
    const orig = CommandStep.tryDispatch;
    CommandStep.tryDispatch = async () => {
      dispatched = true;
      return null;
    };
    try {
      const r = await new CommandStep().execute(
        { id: 'a', command: 'speckit.plan', integration: 'claude', capture: 'yes' },
        ctx(),
      );
      expect(r.status).toBe(StepStatus.FAILED);
      expect(r.error).toBe("Command step 'a': 'capture' must be true or false, got 'yes'.");
      expect(dispatched).toBe(false);
    } finally {
      CommandStep.tryDispatch = orig;
    }
  });

  test('test_default_timeout_is_600_seconds', async () => {
    let seen: unknown;
    const orig = CommandStep.tryDispatch;
    CommandStep.tryDispatch = async (_c, _i, _m, _a, _ctx, _ia, _io, capture) => {
      seen = capture;
      return { exit_code: 0, stdout: '', stderr: '' };
    };
    try {
      await new CommandStep().execute({ id: 'a', command: 'speckit.plan', integration: 'claude', capture: true }, ctx());
      expect(seen).toEqual({ captureMaxBytes: 1024 * 1024, timeout: 600 });
    } finally {
      CommandStep.tryDispatch = orig;
    }
  });

  test.skipIf(!posix)('test_captures_text_output_without_printing_it', async () => {
    fakeClaude();
    const r = await new CommandStep().execute(
      { id: 'a', command: 'speckit.plan', integration: 'claude', capture: true, input: { args: 'go' } },
      ctx(),
    );
    expect(r.status).toBe(StepStatus.COMPLETED);
    expect(r.output.stdout).toContain('/speckit-plan go|');
    expect(r.output.stdout).not.toContain('--output-format');
    expect(r.output.stderr).toBe('warn');
    expect(r.output).toMatchObject({ stdout_truncated: false, stderr_truncated: false, timed_out: false, interrupted: false });
  });

  test.skipIf(!posix)('test_non_zero_exit_keeps_output_and_summarises_the_error', async () => {
    fakeClaude('printf partial; printf secret >&2; exit 4');
    const r = await new CommandStep().execute({ id: 'a', command: 'speckit.plan', integration: 'claude', capture: true }, ctx());
    expect(r.status).toBe(StepStatus.FAILED);
    expect(r.error).toBe('Command exited with code 4');
    expect(r.output.stderr).toBe('secret');
  });

  test.skipIf(!posix)('test_finite_limit_truncates_and_flags', async () => {
    fakeClaude('printf 0123456789');
    const r = await new CommandStep().execute(
      { id: 'a', command: 'speckit.plan', integration: 'claude', capture: true, capture_max_bytes: 4 },
      ctx(),
    );
    expect([r.output.stdout, r.output.stdout_truncated]).toEqual(['0123', true]);
  });

  test.skipIf(!posix)('test_timeout_fails_the_step_with_partial_output', async () => {
    fakeClaude('printf partial; sleep 10');
    const r = await new CommandStep().execute(
      { id: 'a', command: 'speckit.plan', integration: 'claude', capture: true, timeout: 0.5 },
      ctx(),
    );
    expect(r.status).toBe(StepStatus.FAILED);
    expect(r.error).toBe('Command timed out after 0.5 seconds.');
    expect([r.output.stdout, r.output.timed_out, r.output.exit_code]).toEqual(['partial', true, -1]);
  });

  test.skipIf(!posix)('prompt step captures text output', async () => {
    fakeClaude('printf "%s|" "$@"');
    const r = await new PromptStep().execute({ id: 'p', prompt: 'hello', integration: 'claude', capture: true }, ctx());
    expect(r.status).toBe(StepStatus.COMPLETED);
    expect(r.output.stdout).toBe('-p|hello|');
    expect(r.output.interrupted).toBe(false);
  });

  test.skipIf(!posix)('test_with_capture_downstream_consumes_the_output and stderr stays out of the log', async () => {
    fakeClaude('printf "result"; printf "token-secret" >&2; exit 1');
    const def = new WorkflowDefinition({
      workflow: { id: 'cap', name: 'Cap', integration: 'claude' },
      steps: [
        { id: 'a', command: 'speckit.plan', capture: true, continue_on_error: true },
        { id: 'b', type: 'shell', run: 'echo "got {{ steps.a.output.stdout }}"' },
      ],
    });
    const state = await new WorkflowEngine(root).execute(def);
    expect(state.status).toBe(RunStatus.COMPLETED);
    expect((state.stepResults.b?.output as Dict).stdout).toBe('got result\n');
    expect((state.stepResults.a?.output as Dict).stderr).toBe('token-secret');
    expect(readFileSync(join(state.runsDir, 'log.jsonl'), 'utf8')).not.toContain('token-secret');
  });
});

// ============================================================================
// github step (#4905)
// ============================================================================

describe('GitHubStep', () => {
  const calls: Array<{ args: string[]; input: string | null }> = [];
  const origRunner = GitHubStep.runner;
  let replies: GhRunResult[] = [];

  beforeEach(() => {
    calls.length = 0;
    replies = [];
    GitHubStep.runner = async (args, _cwd, input) => {
      calls.push({ args, input });
      return replies.shift() ?? { returncode: 1, stdout: '' };
    };
  });
  afterEach(() => {
    GitHubStep.runner = origRunner;
  });

  const cfg = (extra: Dict = {}): Dict => ({
    id: 'label',
    type: 'github',
    operation: 'add-label',
    target: 'issue',
    repository: 'octo/repo',
    number: 7,
    label: 'triage',
    ...extra,
  });
  const json = (v: unknown): GhRunResult => ({ returncode: 0, stdout: JSON.stringify(v) });

  test('test_issue_label_added_once_and_retry_skips_write', async () => {
    replies = [json({ number: 7, labels: [] }), json([{ name: 'triage' }])];
    let r = await new GitHubStep().execute(cfg(), ctx());
    expect(r.status).toBe(StepStatus.COMPLETED);
    expect(r.output).toEqual({ repository: 'octo/repo', target: 'issue', number: 7, label: 'triage', added: true });
    expect(calls[0]!.args).toEqual(['gh', 'api', '--method', 'GET', 'https://api.github.com/repos/octo/repo/issues/7']);
    expect(calls[1]!.args).toEqual([
      'gh', 'api', '--method', 'POST', 'https://api.github.com/repos/octo/repo/issues/7/labels',
      '--header', 'Content-Type: application/json', '--input', '-',
    ]);
    expect(calls[1]!.input).toBe('{"labels": ["triage"]}');
    replies = [json({ number: 7, labels: [{ name: 'Triage' }] })];
    r = await new GitHubStep().execute(cfg(), ctx());
    expect(r.output.added).toBe(false);
    expect(calls.length).toBe(3);
  });

  test('test_pull_request_uses_issue_labels_endpoint', async () => {
    replies = [json({ number: 7, labels: [] }), json([{ name: 'triage' }])];
    await new GitHubStep().execute(cfg({ target: 'pull_request' }), ctx());
    expect(calls[0]!.args[4]).toBe('https://api.github.com/repos/octo/repo/pulls/7');
    expect(calls[1]!.args[4]).toBe('https://api.github.com/repos/octo/repo/issues/7/labels');
  });

  test('test_invalid_inputs_fail_before_any_api_call', async () => {
    for (const bad of [{ repository: 'not a repo' }, { repository: 'o/..' }, { number: 0 }, { number: true }, { label: '' }, { label: 'x'.repeat(51) }]) {
      const r = await new GitHubStep().execute(cfg(bad), ctx());
      expect(r.status).toBe(StepStatus.FAILED);
      expect(r.error).toStartWith('GitHub step: ');
    }
    const r = await new GitHubStep().execute(cfg({ repository: '{{ inputs.repo }}' }), ctx({ inputs: { repo: 'bad' } }));
    expect(r.error).toBe("GitHub step: 'repository' must be a GitHub owner/repo name");
    expect(calls.length).toBe(0);
  });

  test('test_missing_fields_and_unsupported_operations_fail', () => {
    expect(new GitHubStep().validate({ id: 'g', type: 'github', operation: 'remove-label', target: 'x', extra: 1 })).toEqual([
      "GitHub step 'operation' must be add-label.",
      "GitHub step 'target' must be issue or pull_request.",
      "GitHub step has unsupported field 'extra'.",
      "GitHub step requires 'number'.",
      "GitHub step requires 'repository'.",
      "GitHub step requires 'label'.",
    ]);
  });

  test('test_wrong_issue_target_and_malformed_labels_fail', async () => {
    replies = [json({ number: 7, labels: [], pull_request: {} })];
    let r = await new GitHubStep().execute(cfg(), ctx());
    expect(r.error).toBe('GitHub step: GitHub issue #7 does not match the requested target');
    replies = [json({ number: 7, labels: 'nope' })];
    r = await new GitHubStep().execute(cfg(), ctx());
    expect(r.error).toBe('GitHub step: GitHub returned an invalid label list');
  });

  test('test_subprocess_failures_fail_step_without_exposing_stderr', async () => {
    replies = [{ returncode: 4, stdout: '' }];
    const r = await new GitHubStep().execute(cfg(), ctx());
    expect(r.error).toBe('GitHub step: gh request failed (exit code 4)');
    GitHubStep.runner = async () => {
      const e = new Error('spawn gh ENOENT') as NodeJS.ErrnoException;
      e.code = 'ENOENT';
      throw e;
    };
    const r2 = await new GitHubStep().execute(cfg(), ctx());
    expect(r2.error).toBe("GitHub step: gh request failed: [Errno 2] No such file or directory: 'gh'");
  });

  test('test_malformed_api_json_fails_step', async () => {
    replies = [{ returncode: 0, stdout: 'not json' }];
    const r = await new GitHubStep().execute(cfg(), ctx());
    expect(r.error).toBe('GitHub step: GitHub returned invalid JSON for https://api.github.com/repos/octo/repo/issues/7');
  });

  test('github is a registered step type that validates in a workflow', () => {
    const def = new WorkflowDefinition({
      schema_version: '1.0',
      workflow: { id: 'gh', name: 'GH', version: '1.0.0' },
      steps: [cfg()],
    });
    expect(validateWorkflow(def)).toEqual([]);
  });
});

// ============================================================================
// gate (#4529), init (#4530), shell (#5064)
// ============================================================================

describe('gate prompt interruption and EOF', () => {
  afterEach(() => setPromptInput(null));

  test('EOF picks the declared reject option, not merely the last one', async () => {
    setPromptInput(async () => null);
    const origWrite = process.stdout.write;
    (process.stdout as unknown as { write: unknown }).write = () => true;
    try {
      expect(await GateStep.prompt('Review', ['approve', 'reject', 'request-changes'])).toBe('reject');
      expect(await GateStep.prompt('Review', ['approve', 'later'])).toBe('later');
    } finally {
      (process.stdout as unknown as { write: unknown }).write = origWrite;
    }
  });

  test('Ctrl+C at the prompt raises KeyboardInterrupt instead of choosing', async () => {
    setPromptInput(() => new Promise(() => {}));
    const origWrite = process.stdout.write;
    (process.stdout as unknown as { write: unknown }).write = () => true;
    try {
      const pending = GateStep.prompt('Review', ['approve', 'reject']);
      await new Promise((r) => setTimeout(r, 10));
      process.emit('SIGINT');
      await expect(pending).rejects.toMatchObject({ name: 'KeyboardInterrupt' });
    } finally {
      (process.stdout as unknown as { write: unknown }).write = origWrite;
    }
  });
});

describe('init and shell step failures', () => {
  test('init step carries stdout across when init fails without stderr', async () => {
    const orig = InitStep.runInit;
    InitStep.runInit = async () => [1, 'Invalid integration: nope\n', ''];
    try {
      const r = await new InitStep().execute({ id: 'i', type: 'init', integration: 'claude' }, ctx());
      expect(r.status).toBe(StepStatus.FAILED);
      expect(r.error).toBe('Invalid integration: nope');
    } finally {
      InitStep.runInit = orig;
    }
  });

  test.skipIf(!posix)('test_undecodable_shell_output_is_a_step_failure', async () => {
    const r = await new ShellStep().execute({ id: 's', run: "printf 'ok\\377'" }, ctx());
    expect(r.status).toBe(StepStatus.FAILED);
    expect(r.error).toBe(
      "Shell command stdout could not be decoded: 'utf-8' codec can't decode byte 0xff in position 2: invalid start byte",
    );
    expect(r.output.exit_code).toBe(0);
  });

  test('decodeUtf8Strict mirrors CPython UnicodeDecodeError text', () => {
    expect(decodeUtf8Strict(Buffer.from('é', 'utf8'))).toEqual(['é', null]);
    expect(decodeUtf8Strict(Buffer.from([0x61, 0xe2, 0x82]))[1]).toBe(
      "'utf-8' codec can't decode bytes in position 1-2: unexpected end of data",
    );
    expect(decodeUtf8Strict(Buffer.from([0xe2, 0x41]))[1]).toBe(
      "'utf-8' codec can't decode byte 0xe2 in position 0: invalid continuation byte",
    );
  });
});

// ============================================================================
// Inputs (#5027) and run artifacts (#4877)
// ============================================================================

describe('engine inputs and artifacts', () => {
  test('integer number inputs stay integers; decimals stay floats', () => {
    expect(WorkflowEngine.coerceInput('n', '42', { type: 'number' })).toBe(42);
    expect(WorkflowEngine.coerceInput('n', '1_000', { type: 'number' })).toBe(1000);
    expect(WorkflowEngine.coerceInput('n', '2.5', { type: 'number' })).toBe(2.5);
    expect(() => WorkflowEngine.coerceInput('n', 'x', { type: 'number' })).toThrow("Input 'n' expected a number, got 'x'.");
  });

  test('non-ASCII stays readable in state.json, log.jsonl and workflow.yml', async () => {
    const def = new WorkflowDefinition({
      schema_version: '1.0',
      workflow: { id: 'uni', name: 'Ünï', version: '1.0.0' },
      steps: [{ id: 's', type: 'shell', run: 'printf café' }],
    });
    const state = await new WorkflowEngine(root).execute(def);
    expect(readFileSync(join(state.runsDir, 'state.json'), 'utf8')).toContain('"stdout": "café"');
    expect(readFileSync(join(state.runsDir, 'workflow.yml'), 'utf8')).toContain('Ünï');
    RunState.load(state.runId, root);
  });
});

// ============================================================================
// --json failure reporting (#5015)
// ============================================================================

describe('workflow run/resume --json report a raised step error', () => {
  let out = '';
  let err = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    process.chdir(root);
    delete process.env.SPECIFY_INIT_DIR;
  });
  afterEach(() => {
    process.chdir(prevCwd);
  });

  async function run(...args: string[]): Promise<number> {
    out = '';
    err = '';
    (process.stdout as unknown as { write: unknown }).write = (c: unknown): boolean => ((out += String(c)), true);
    (process.stderr as unknown as { write: unknown }).write = (c: unknown): boolean => ((err += String(c)), true);
    try {
      return await runWorkflowCommand(args);
    } catch (exc) {
      return (exc as { code?: number }).code ?? 99;
    } finally {
      (process.stdout as unknown as { write: unknown }).write = origOut;
      (process.stderr as unknown as { write: unknown }).write = origErr;
    }
  }

  const WF = `schema_version: "1.0"
workflow:
  id: "boom"
  name: "Boom"
  version: "1.0.0"
inputs:
  payload:
    type: string
    default: "broken"
steps:
  - id: check
    type: if
    condition: "{{ inputs.payload | from_json }}"
    then:
      - id: never
        type: shell
        run: "echo never"
`;

  test('run --json prints the failed run payload with its run id', async () => {
    const file = join(root, 'boom.yml');
    writeFileSync(file, WF);
    const code = await run('run', file, '--json');
    expect(code).toBe(1);
    const payload = JSON.parse(out) as Dict;
    expect(payload.status).toBe('failed');
    expect(payload.workflow_id).toBe('boom');
    expect(String(payload.error)).toContain('from_json: invalid JSON');
    expect(RunState.load(payload.run_id as string, root).status).toBe('failed');
  });

  test('resume --json reports the run it failed again', async () => {
    const file = join(root, 'boom.yml');
    writeFileSync(file, WF);
    await run('run', file, '--json');
    const runId = (JSON.parse(out) as Dict).run_id as string;
    const code = await run('resume', runId, '--json', '-i', 'payload=still-broken');
    expect(code).toBe(1);
    const payload = JSON.parse(out) as Dict;
    expect(payload.run_id).toBe(runId);
    expect(payload.status).toBe('failed');
  });

  // test_run_short_circuits_optional_json (#4923)
  for (const [condition, emptyBranch] of [
    ["inputs.payload != '' and (inputs.payload | from_json | length)", 'absent'],
    ["inputs.payload == '' or (inputs.payload | from_json | length)", 'provided'],
  ] as const) {
    for (const payloadValue of ['', '[1]', 'broken']) {
      test(`run short-circuits optional JSON: ${condition} payload=${JSON.stringify(payloadValue)}`, async () => {
        const file = join(root, 'optional.yml');
        writeFileSync(
          file,
          JSON.stringify({
            schema_version: '1.0',
            workflow: { id: 'optional', name: 'Optional payload', version: '1.0.0' },
            inputs: { payload: { type: 'string', default: '' } },
            steps: [
              {
                id: 'check',
                type: 'if',
                condition: `{{ ${condition} }}`,
                then: [{ id: 'provided', type: 'shell', run: 'echo provided' }],
                else: [{ id: 'absent', type: 'shell', run: 'echo absent' }],
              },
            ],
          }),
        );
        const code = await run('run', file, '--json', '--input', `payload=${payloadValue}`);
        if (payloadValue === 'broken') {
          expect(code).toBe(1);
          expect(out + err).toContain('from_json: invalid JSON');
          return;
        }
        expect(code).toBe(0);
        const outcome = JSON.parse(out) as Dict;
        expect(outcome.status).toBe('completed');
        const state = RunState.load(outcome.run_id as string, root);
        const branch = payloadValue ? 'provided' : emptyBranch;
        expect(((state.stepResults[branch]?.output as Dict).stdout as string).trim()).toBe(branch);
        expect(new Set(Object.keys(state.stepResults))).toEqual(new Set(['check', branch]));
      });
    }
  }
});

void StepResult;
