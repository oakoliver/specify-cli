/**
 * Tests for ``specify workflow add`` (port of the command_add.py-focused
 * cases in upstream tests/specify_cli/workflows/test_command_add.py).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpResponse } from '../src/authentication/http.js';
import { CliExit, console as stdoutConsole, errConsole, setPromptInput } from '../src/console.js';
import { httpDeps } from '../src/workflows/catalog/domain.js';
import { WorkflowRegistry } from '../src/workflows/catalog/domain.js';
import { workflowAdd, workflowPackageHasCompanions, type WorkflowAddOptions } from '../src/workflows/command-add.js';

type Dict = Record<string, unknown>;

let tmp: string;
let projectDir: string;
let prevCwd: string;
let output: string;
let prevOut: unknown;
let prevErr: unknown;
const realOpenUrl = httpDeps.openUrl;

const WORKFLOW_YAML = (id = 'align-wf', version = '1.0.0'): string =>
  'schema_version: "1.0"\n' +
  `workflow:\n  id: "${id}"\n  name: "Align WF"\n  version: "${version}"\n` +
  'steps:\n  - id: s1\n    type: shell\n    run: "echo hi"\n';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wf-add-'));
  projectDir = join(tmp, 'proj');
  mkdirSync(join(projectDir, '.specify', 'workflows'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectDir);
  delete process.env.SPECIFY_INIT_DIR;
  output = '';
  prevOut = (stdoutConsole as unknown as { opts: Dict }).opts.file;
  prevErr = (errConsole as unknown as { opts: Dict }).opts.file;
  stdoutConsole.file = { write: (c: string) => (output += c) };
  errConsole.file = { write: (c: string) => (output += c) };
});

afterEach(() => {
  process.chdir(prevCwd);
  (stdoutConsole as unknown as { opts: Dict }).opts.file = prevOut;
  (errConsole as unknown as { opts: Dict }).opts.file = prevErr;
  httpDeps.openUrl = realOpenUrl;
  setPromptInput(null);
  rmSync(tmp, { recursive: true, force: true });
});

async function runAdd(opts: WorkflowAddOptions): Promise<number> {
  try {
    await workflowAdd(opts);
    return 0;
  } catch (exc) {
    if (exc instanceof CliExit) return exc.code;
    throw exc;
  }
}

function fakeResponse(body: string, finalUrl: string, headers: Record<string, string> = {}): HttpResponse {
  const resp = new Response(body, { headers });
  return new HttpResponse(resp, finalUrl);
}

const installedYml = (id = 'align-wf'): string => join(projectDir, '.specify', 'workflows', id, 'workflow.yml');

describe('workflow add: local sources', () => {
  for (const name of ['Sample.YAML', 'sample.yml', 'sample.Yaml']) {
    test(`plain path accepts ${name}`, async () => {
      const src = join(projectDir, name);
      writeFileSync(src, WORKFLOW_YAML());
      expect(await runAdd({ source: src })).toBe(0);
      expect(output).toContain("Workflow 'Align WF' (align-wf) installed");
      expect(readFileSync(installedYml(), 'utf-8')).toBe(WORKFLOW_YAML());
      const entry = new WorkflowRegistry(projectDir).get('align-wf') as Dict;
      expect(entry).toMatchObject({ name: 'Align WF', version: '1.0.0', source: src });
    });
  }

  test('--dev accepts an uppercase extension and a directory', async () => {
    const src = join(projectDir, 'Sample.YAML');
    writeFileSync(src, WORKFLOW_YAML());
    expect(await runAdd({ source: src, dev: true })).toBe(0);
    const dir = join(tmp, 'wfdir');
    mkdirSync(dir);
    writeFileSync(join(dir, 'workflow.yml'), WORKFLOW_YAML('dir-wf'));
    expect(workflowPackageHasCompanions(dir)).toBe(false);
    expect(await runAdd({ source: dir, dev: true })).toBe(0);
    expect(existsSync(installedYml('dir-wf'))).toBe(true);
  });

  test('--dev errors', async () => {
    expect(await runAdd({ source: join(tmp, 'missing'), dev: true })).toBe(1);
    expect(output.replace(/\s+/g, ' ')).toContain('--dev source must be a workflow YAML file, supported archive, or directory containing workflow.yml');
    const dir = join(tmp, 'empty');
    mkdirSync(dir);
    output = '';
    expect(await runAdd({ source: dir, dev: true })).toBe(1);
    expect(output).toContain('No workflow.yml found in');
    output = '';
    expect(await runAdd({ source: dir })).toBe(1);
    expect(output).toContain('No workflow.yml found in');
  });

  test('validation errors are reported (escaped), not thrown', async () => {
    const src = join(projectDir, 'workflow.yml');
    writeFileSync(src, 'workflow:\n  id: "probe"\n  name: "Probe"\n  version: "1.0.0"\nsteps:\n  - id: 123\n    type: shell\n    run: "echo hi"\n');
    expect(await runAdd({ source: src })).toBe(1);
    expect(output).toContain('Workflow validation failed:');
    expect(output).toContain('Step ID');

    writeFileSync(src, 'workflow:\n  name: "No id"\nsteps: []\n');
    output = '';
    expect(await runAdd({ source: src })).toBe(1);
    expect(output).toContain("Workflow definition has an empty or missing 'id'");

    writeFileSync(src, 'workflow: [unclosed\n');
    output = '';
    expect(await runAdd({ source: src })).toBe(1);
    expect(output).toContain('Invalid workflow YAML:');
  });

  test('refuses a symlinked .specify/workflows', async () => {
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    rmSync(join(projectDir, '.specify', 'workflows'), { recursive: true });
    symlinkSync(outside, join(projectDir, '.specify', 'workflows'));
    const src = join(projectDir, 'wf.yml');
    writeFileSync(src, WORKFLOW_YAML());
    expect(await runAdd({ source: src })).toBe(1);
    expect(readdirSync(outside)).toEqual([]);
  });

  test('reserved overlay storage id is rejected', async () => {
    const src = join(projectDir, 'wf.yml');
    writeFileSync(src, WORKFLOW_YAML('overlays'));
    expect(await runAdd({ source: src })).toBe(1);
    expect(existsSync(join(projectDir, '.specify', 'workflows', 'overlays', 'workflow.yml'))).toBe(false);
  });

  test('reinstall preserves disabled state and leaves no backup file', async () => {
    const src = join(projectDir, 'wf.yml');
    writeFileSync(src, WORKFLOW_YAML());
    expect(await runAdd({ source: src, dev: true })).toBe(0);
    const registry = new WorkflowRegistry(projectDir);
    const entry = registry.get('align-wf') as Dict;
    registry.add('align-wf', { ...entry, enabled: false });
    writeFileSync(src, WORKFLOW_YAML('align-wf', '2.0.0'));
    expect(await runAdd({ source: src })).toBe(0);
    const updated = new WorkflowRegistry(projectDir).get('align-wf') as Dict;
    expect(updated.enabled).toBe(false);
    expect(updated.version).toBe('2.0.0');
    expect(readdirSync(join(projectDir, '.specify', 'workflows', 'align-wf'))).toEqual(['workflow.yml']);
  });

  test('outside a spec-kit project', async () => {
    rmSync(join(projectDir, '.specify'), { recursive: true });
    expect(await runAdd({ source: 'anything' })).toBe(1);
    expect(output).toContain('Not a Spec Kit project');
  });
});

describe('workflow add: URLs', () => {
  test('malformed IPv6 URL exits cleanly', async () => {
    expect(await runAdd({ source: 'https://[::1/wf.yaml' })).toBe(1);
    expect(output).toContain('Invalid URL');
  });

  test('non-HTTPS URL rejected', async () => {
    expect(await runAdd({ source: 'http://example.com/wf.yml' })).toBe(1);
    expect(output).toContain('Only HTTPS URLs are allowed, except HTTP for localhost.');
  });

  test('--from rejects an invalid source id without fetching', async () => {
    httpDeps.openUrl = (async () => {
      throw new Error('download should not start');
    }) as typeof httpDeps.openUrl;
    expect(await runAdd({ source: '../evil', fromUrl: 'https://example.com/workflow.yml' })).toBe(1);
    expect(output).toContain("Invalid workflow ID: '../evil'");
  });

  test('--from requires default-deny confirmation', async () => {
    httpDeps.openUrl = (async () => {
      throw new Error('download should not start');
    }) as typeof httpDeps.openUrl;
    setPromptInput(['n']);
    expect(await runAdd({ source: 'align-wf', fromUrl: 'https://example.com/workflow.yml' })).toBe(0);
    expect(output).toContain('Untrusted Source');
    expect(output).toContain('Cancelled');
  });

  test('--from installs after confirmation and checks the id', async () => {
    httpDeps.openUrl = (async (url: string) => fakeResponse(WORKFLOW_YAML(), url)) as typeof httpDeps.openUrl;
    setPromptInput(['y']);
    expect(await runAdd({ source: 'align-wf', fromUrl: 'https://example.com/workflow.yml' })).toBe(0);
    expect((new WorkflowRegistry(projectDir).get('align-wf') as Dict).source).toBe('https://example.com/workflow.yml');

    setPromptInput(['y']);
    output = '';
    expect(await runAdd({ source: 'other-wf', fromUrl: 'https://example.com/workflow.yml' })).toBe(1);
    expect(output.replace(/\s+/g, ' ')).toContain(
      "Workflow ID in YAML ('align-wf') does not match the requested workflow ID ('other-wf').",
    );
  });

  test('positional URL installs; temp file is removed', async () => {
    const before = new Set(readdirSync(tmpdir()));
    httpDeps.openUrl = (async (url: string) => fakeResponse(WORKFLOW_YAML(), url)) as typeof httpDeps.openUrl;
    expect(await runAdd({ source: 'https://example.com/workflow.yml' })).toBe(0);
    expect(existsSync(installedYml())).toBe(true);
    const leaked = readdirSync(tmpdir()).filter((n) => !before.has(n) && n.endsWith('.yml') && n.startsWith('tmp'));
    expect(leaked).toEqual([]);
  });

  test('redirect to non-HTTPS is rejected', async () => {
    httpDeps.openUrl = (async () => fakeResponse(WORKFLOW_YAML(), 'http://evil.example/[red]x[/red]')) as typeof httpDeps.openUrl;
    expect(await runAdd({ source: 'https://example.com/workflow.yml' })).toBe(1);
    expect(output).toContain('URL redirected to non-HTTPS: http://evil.example/[red]x[/red]');
  });

  test('download failures are reported', async () => {
    httpDeps.openUrl = (async () => {
      throw new Error('connection reset');
    }) as typeof httpDeps.openUrl;
    expect(await runAdd({ source: 'https://example.com/workflow.yml' })).toBe(1);
    expect(output).toContain('Failed to download workflow: connection reset');
  });

  test('oversized declared Content-Length is rejected', async () => {
    httpDeps.openUrl = (async (url: string) =>
      fakeResponse('id: x\n', url, { 'Content-Length': String(10 * 1024 * 1024) })) as typeof httpDeps.openUrl;
    expect(await runAdd({ source: 'https://example.com/workflow.yml' })).toBe(1);
    expect(output.replace(/\s+/g, '')).toContain('workflowsizelimit');
  });
});
