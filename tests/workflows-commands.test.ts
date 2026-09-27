/**
 * CLI adapter tests for ``specify workflow`` (ports of key cases from
 * upstream ``tests/specify_cli/workflows/test_command_*.py``), exercised
 * through ``runWorkflowCommand`` on a temporary project.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowRegistry } from '../src/workflows/catalog/domain.js';
import { runWorkflowCommand } from '../src/workflows/commands.js';
import { GateStep } from '../src/workflows/index.js';

let projectDir: string;
let prevCwd: string;
let out = '';
let err = '';
const origOut = process.stdout.write;
const origErr = process.stderr.write;
const origTTY = GateStep.stdinIsTTY;

function capture(): void {
  out = '';
  err = '';
  (process.stdout as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  };
  (process.stderr as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    err += String(chunk);
    return true;
  };
}

function restore(): void {
  (process.stdout as unknown as { write: unknown }).write = origOut;
  (process.stderr as unknown as { write: unknown }).write = origErr;
}

async function run(...args: string[]): Promise<number> {
  capture();
  try {
    return await runWorkflowCommand(args);
  } finally {
    restore();
  }
}

const WF = (id: string, extra = ''): string => `schema_version: "1.0"
workflow:
  id: "${id}"
  name: "Test ${id}"
  version: "1.0.0"
  description: "desc"
inputs:
  verdict:
    type: string
    default: ""
${extra}steps:
  - id: hello
    type: shell
    run: "echo hi"
  - id: review
    type: gate
    message: "Approve?"
    verdict_input: verdict
  - id: bye
    type: shell
    run: "echo bye"
`;

function install(id: string, enabled = true): void {
  const dir = join(projectDir, '.specify', 'workflows', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflow.yml'), WF(id));
  const reg = new WorkflowRegistry(projectDir);
  reg.add(id, { name: `Test ${id}`, version: '1.0.0', description: 'desc', source: 'local', ...(enabled ? {} : { enabled: false }) });
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-wf-cmd-')));
  mkdirSync(join(projectDir, '.specify', 'workflows'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectDir);
  delete process.env.SPECIFY_INIT_DIR;
  GateStep.stdinIsTTY = () => false;
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(projectDir, { recursive: true, force: true });
  GateStep.stdinIsTTY = origTTY;
});

describe('workflow run / resume / status', () => {
  test('run a YAML file with --json pauses at the gate and reports gate detail', async () => {
    const file = join(projectDir, 'wf.yml');
    writeFileSync(file, WF('file-wf'));
    const code = await run('run', file, '--json');
    expect(code).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.status).toBe('paused');
    expect(payload.workflow_id).toBe('file-wf');
    expect(payload.current_step_id).toBe('review');
    expect(payload.current_step_index).toBe(1);
    expect(payload.gate).toEqual({ step_id: 'review', message: 'Approve?', options: ['approve', 'reject'], choice: null });
    // Step stdout was routed away from the JSON stream.
    expect(out).not.toContain('hi\n');

    const resumeCode = await run('resume', payload.run_id, '-i', 'verdict=approve', '--json');
    expect(resumeCode).toBe(0);
    const resumed = JSON.parse(out);
    expect(resumed.status).toBe('completed');
    expect(resumed.gate).toBeUndefined();

    expect(await run('status', payload.run_id, '--json')).toBe(0);
    const status = JSON.parse(out);
    expect(status.steps).toEqual({ hello: 'completed', review: 'completed', bye: 'completed' });
    expect(status.created_at).toMatch(/\+00:00$/);

    expect(await run('status', '--json')).toBe(0);
    expect(JSON.parse(out).runs.map((r: { run_id: string }) => r.run_id)).toEqual([payload.run_id]);
  });

  test('human-readable run output and failure exit code', async () => {
    const file = join(projectDir, 'fail.yml');
    writeFileSync(
      file,
      `schema_version: "1.0"\nworkflow:\n  id: fail\n  name: Fail\n  version: "1.0.0"\nsteps:\n  - id: boom\n    type: shell\n    run: "exit 4"\n`,
    );
    const code = await run('run', file);
    expect(code).toBe(1);
    expect(out).toContain('Running workflow: Fail (fail)');
    expect(out).toContain('▸ [boom] shell …');
    expect(out).toContain('Status: failed');
    expect(out).toContain('Error: Shell command exited with code 4.');
  });

  test('invalid input format and validation failures', async () => {
    const file = join(projectDir, 'wf.yml');
    writeFileSync(file, WF('file-wf'));
    expect(await run('run', file, '-i', 'noequals')).toBe(1);
    expect(out).toContain("Error: Invalid input format: 'noequals' (expected key=value)");

    writeFileSync(file, 'schema_version: "1.0"\nworkflow:\n  id: Bad\n  name: x\n  version: "1"\nsteps: []\n');
    expect(await run('run', file)).toBe(1);
    expect(out).toContain('Workflow validation failed:');
    expect(out).toContain("Workflow ID 'Bad' must be lowercase alphanumeric with hyphens.");
  });

  test('installed workflows: invalid id, not found, disabled', async () => {
    expect(await run('run', 'Bad/../id')).toBe(1);
    expect(out).toContain("Error: Invalid workflow ID: 'Bad/../id'");
    expect(await run('run', 'missing-wf')).toBe(1);
    expect(out).toContain('Error: Workflow not found: missing-wf');
    install('off-wf', false);
    expect(await run('run', 'off-wf')).toBe(1);
    expect(out).toContain("Workflow 'off-wf' is disabled. Enable with: specify workflow enable off-wf");
    // A direct path into installed storage is subject to the same check.
    expect(await run('run', join(projectDir, '.specify/workflows/off-wf/workflow.yml'))).toBe(1);
    expect(out).toContain("Workflow 'off-wf' is disabled.");
  });

  test('run an installed workflow by id records its origin; resume re-checks disabled state', async () => {
    install('on-wf');
    expect(await run('run', 'on-wf', '--json')).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.status).toBe('paused');
    expect(await run('disable', 'on-wf')).toBe(0);
    expect(await run('resume', payload.run_id)).toBe(1);
    expect(out).toContain("Workflow 'on-wf' is disabled.");
  });

  test('status errors', async () => {
    expect(await run('status', 'nope')).toBe(1);
    expect(out).toContain('Error: Run not found: nope');
    expect(await run('status')).toBe(0);
    expect(out).toContain('No workflow runs found.');
    expect(await run('resume', 'nope')).toBe(1);
    expect(out).toContain('Error: Run not found: nope');
  });

  test('not a spec kit project', async () => {
    rmSync(join(projectDir, '.specify'), { recursive: true });
    expect(await run('list')).toBe(1);
    expect(err).toContain('Not a Spec Kit project (no .specify/ directory)');
  });
});

describe('registry commands', () => {
  test('list / info / enable / disable / remove', async () => {
    expect(await run('list')).toBe(0);
    expect(out).toContain('No workflows installed.');

    install('alpha');
    expect(await run('list')).toBe(0);
    expect(out).toContain('Test alpha (alpha) v1.0.0');
    expect(out).toContain('    desc');

    expect(await run('info', 'alpha')).toBe(0);
    expect(out).toContain('Test alpha (alpha)');
    expect(out).toContain('Installed');
    expect(out).toContain('verdict (string) — optional');
    expect(out).toContain('→ review [gate]');

    expect(await run('enable', 'alpha')).toBe(0);
    expect(out).toContain("Workflow 'alpha' is already enabled");
    expect(await run('disable', 'alpha')).toBe(0);
    expect(out).toContain("Workflow 'alpha' disabled");
    expect(out).toContain('To re-enable: specify workflow enable alpha');
    expect(await run('list')).toBe(0);
    expect(out).toContain('[disabled]');

    expect(await run('remove', 'alpha')).toBe(0);
    expect(out).toContain("Workflow 'alpha' removed");
    expect(existsSync(join(projectDir, '.specify/workflows/alpha'))).toBe(false);
    expect(new WorkflowRegistry(projectDir).isInstalled('alpha')).toBe(false);

    expect(await run('remove', 'alpha')).toBe(1);
    expect(out).toContain("Error: Workflow 'alpha' is not installed");
    expect(await run('enable', 'ghost')).toBe(1);
    expect(out).toContain("Error: Workflow 'ghost' is not installed");
    expect(await run('remove', 'runs')).toBe(1);
    expect(out).toContain("Error: Invalid workflow ID: 'runs'");
  });

  test('help and unknown commands', async () => {
    expect(await run('--help')).toBe(0);
    expect(out).toContain('Manage and run automation workflows');
    expect(await run('bogus')).toBe(2);
  });
});
