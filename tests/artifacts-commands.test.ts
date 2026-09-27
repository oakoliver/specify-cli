/**
 * ``specify artifact list|info|lookup`` CLI contract: ``--json`` opt-in,
 * error envelope on stderr, empty stdout on failure, pretty-printed sorted
 * JSON. Ports of tests/specify_cli/artifacts/test_command_{list,info,lookup}.py
 * and test_registration.py.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ARTIFACT_COMMANDS, runArtifactCommand, type ArtifactCommandIO } from '../src/artifacts/commands.js';
import { ExtensionRegistry } from '../src/extensions/registry.js';
import { PresetRegistry } from '../src/presets/registry.js';
import { dumpYaml } from '../src/yaml.js';

let tmp: string;
let project: string;
let nonProject: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'artifacts-cmd-')));
  project = path.join(tmp, 'proj');
  for (const d of ['presets', 'extensions', 'templates']) mkdirSync(path.join(project, '.specify', d), { recursive: true });
  nonProject = path.join(tmp, 'not-proj');
  mkdirSync(nonProject);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function invoke(args: string[], cwd = project, env: Record<string, string> = {}): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const io: ArtifactCommandIO = {
    writeOut: (t) => out.push(t),
    writeErr: (t) => err.push(t),
    cwd: () => cwd,
    env: (name) => env[name],
  };
  const code = await runArtifactCommand(args, io);
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function write(p: string, content: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function installHookExtension(): void {
  const extDir = path.join(project, '.specify', 'extensions', 'compliance');
  write(
    path.join(extDir, 'extension.yml'),
    dumpYaml({
      schema_version: '1.0',
      extension: {
        id: 'compliance',
        name: 'compliance',
        version: '1.0.0',
        description: 'Test extension',
        author: 'test',
        repository: 'https://example.com',
        license: 'MIT',
      },
      requires: { speckit_version: '>=0.2.0' },
      provides: {},
      hooks: { before_specify: [{ command: 'speckit.compliance.pre-check' }] },
    }),
  );
  new ExtensionRegistry(path.join(project, '.specify', 'extensions')).add('compliance', {
    version: '1.0.0',
    enabled: true,
    priority: 10,
  });
}

const ERROR_REGEX = /^(unknown artifact |unknown contribution |ambiguous artifact |artifact resolution failed|not a Spec Kit project)/;

describe('registration', () => {
  test('commands registered once in stable order', () => {
    expect([...ARTIFACT_COMMANDS]).toEqual(['list', 'info', 'lookup']);
  });

  test('no args shows help with exit 2', async () => {
    const r = await invoke([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('Introspect commands, templates, scripts, and hooks Spec Kit exposes.');
  });
});

describe('artifact list', () => {
  test('requires --json (exit 2, empty stdout)', async () => {
    const r = await invoke(['list']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('specify artifact requires --json for now; text output is not yet implemented.\n');
  });

  test('emits a pretty-printed, key-sorted JSON array with trailing newline', async () => {
    const r = await invoke(['list', '--json']);
    expect(r.code).toBe(0);
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout.startsWith('﻿')).toBe(false);
    expect(r.stdout).toContain('  "id"');
    const payload = JSON.parse(r.stdout);
    expect(Array.isArray(payload)).toBe(true);
    const row = payload[0];
    expect(Object.keys(row)).toEqual(['description', 'id', 'kind', 'name', 'stack']);
    const info = await invoke(['info', row.id, '--json']);
    expect(info.code).toBe(0);
    expect(JSON.parse(info.stdout).stack).toEqual(row.stack);
  });

  test('corrupt extension registry uses JSON error envelope', async () => {
    write(path.join(project, '.specify', 'extensions', '.registry'), '{invalid');
    const r = await invoke(['list', '--json']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr)).toEqual({ error: 'artifact resolution failed' });
  });

  test('not a project error envelope', async () => {
    const r = await invoke(['list', '--json'], nonProject);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('{"error": "not a Spec Kit project: no .specify/ directory found"}\n');
  });
});

describe('artifact info', () => {
  test('json shape and id form equivalence', async () => {
    const r = await invoke(['info', 'speckit.constitution', '--json']);
    expect(r.code).toBe(0);
    expect(Object.keys(JSON.parse(r.stdout)).sort()).toEqual(['description', 'id', 'kind', 'name', 'stack']);
    const bare = await invoke(['info', 'speckit.plan', '--json']);
    const byId = await invoke(['info', 'command:speckit.plan', '--json']);
    expect(byId.stdout).toBe(bare.stdout);
  });

  test('unknown artifact error envelope', async () => {
    const r = await invoke(['info', 'no.such.thing', '--json']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    const err = JSON.parse(r.stderr);
    expect(Object.keys(err)).toEqual(['error']);
    expect(err.error).toMatch(ERROR_REGEX);
  });

  test('invalid --kind is a usage error', async () => {
    const r = await invoke(['info', 'x', '--json', '--kind', 'bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toBe("invalid --kind 'bogus': expected one of command, template, script, hook\n");
  });

  test('invalid SPECIFY_INIT_DIR override uses the JSON envelope', async () => {
    for (const override of ['missing-project', '.']) {
      for (const argv of [
        ['list', '--json'],
        ['info', 'x', '--json'],
      ]) {
        const r = await invoke(argv, nonProject, { SPECIFY_INIT_DIR: override });
        expect(r.code).toBe(1);
        expect(r.stdout).toBe('');
        expect(JSON.parse(r.stderr)).toEqual({ error: 'not a Spec Kit project: no .specify/ directory found' });
      }
    }
    const ok = await invoke(['list', '--json'], nonProject, { SPECIFY_INIT_DIR: '../proj' });
    expect(ok.code).toBe(0);
  });

  test('hooks via list and info', async () => {
    installHookExtension();
    const list = await invoke(['list', '--json']);
    expect(JSON.parse(list.stdout).some((row: { kind: string }) => row.kind === 'hook')).toBe(true);
    const info = await invoke(['info', 'hook:before_specify:speckit.compliance.pre-check', '--json']);
    expect(info.code).toBe(0);
    expect(JSON.parse(info.stdout).kind).toBe('hook');
    for (const id of ['hook:nope:missing.cmd', 'hook:event:bad%escape', 'hook:event:%FF']) {
      const r = await invoke(['info', id, '--json']);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(JSON.parse(r.stderr).error).toMatch(ERROR_REGEX);
    }
  });
});

describe('artifact lookup', () => {
  test('cross-references the manifest contribution', async () => {
    const pack = path.join(project, '.specify', 'presets', 'lookup-pack');
    write(
      path.join(pack, 'preset.yml'),
      dumpYaml({
        schema_version: '1.0',
        preset: { id: 'lookup-pack', name: 'Lookup', version: '1.0.0', description: 'x' },
        requires: { speckit_version: '>=1.0.0' },
        provides: {
          templates: [
            { type: 'template', name: 'lookup-template', file: 'templates/lookup.md', description: 'Lookup target' },
          ],
        },
      }),
    );
    write(path.join(pack, 'templates', 'lookup.md'), 'body');
    new PresetRegistry(path.join(project, '.specify', 'presets')).add('lookup-pack', { priority: 10, version: '1.0.0' });
    const id = 'preset:lookup-pack:template:lookup-template';
    const r = await invoke(['lookup', id, '--json']);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout);
    expect(payload.id).toBe(id);
    expect(payload.contribution.description).toBe('Lookup target');
    expect(payload.sourcePath).toBe('.specify/presets/lookup-pack/templates/lookup.md');
  });

  test('unknown and malformed lookup ids', async () => {
    for (const id of [
      'extension:missing:command:speckit.missing.command',
      'invalid:source:command:name',
      'extension:source:invalid:name',
      'extension:source:hook:%FF:command',
      'extension:source:hook:event:%ZZ',
    ]) {
      const r = await invoke(['lookup', id, '--json']);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(JSON.parse(r.stderr)).toEqual({ error: `unknown contribution ${id}` });
    }
  });

  test('requires --json; validates project before lookup id', async () => {
    const r = await invoke(['lookup', 'extension:missing:command:speckit.missing.command']);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    const np = await invoke(['lookup', 'project:_:command:local', '--json'], nonProject);
    expect(np.code).toBe(1);
    expect(JSON.parse(np.stderr)).toEqual({ error: 'not a Spec Kit project: no .specify/ directory found' });
  });

  test('non-JSON manifest values (NaN / infinity) produce a resolution error', async () => {
    const pack = path.join(project, '.specify', 'presets', 'non-json-contribution');
    write(
      path.join(pack, 'preset.yml'),
      'schema_version: "1.0"\npreset:\n  id: non-json-contribution\n  name: X\n  version: 1.0.0\n  description: x\n' +
        'requires:\n  speckit_version: ">=1.0.0"\nprovides:\n  templates:\n  - type: template\n' +
        '    name: non-json-contribution\n    file: templates/non-json-contribution.md\n    extra: .nan\n',
    );
    new PresetRegistry(path.join(project, '.specify', 'presets')).add('non-json-contribution', {
      priority: 10,
      version: '1.0.0',
    });
    const r = await invoke(['lookup', 'preset:non-json-contribution:template:non-json-contribution', '--json']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr)).toEqual({ error: 'artifact resolution failed' });
  });
});
