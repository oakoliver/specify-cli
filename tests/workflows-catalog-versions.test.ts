/**
 * Exact-release lookup and installation for workflow catalogs (port of
 * upstream tests/specify_cli/workflows/test_catalog_versions.py, #4788).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpResponse } from '../src/authentication/http.js';
import { CliExit, console as stdoutConsole, errConsole } from '../src/console.js';
import { dumpYaml } from '../src/yaml.js';
import {
  WorkflowCatalog,
  WorkflowRegistry,
  WorkflowValidationError,
  httpDeps,
  type WorkflowCatalogEntry,
} from '../src/workflows/catalog/domain.js';
import { availableVersions, isValidWorkflowVersion, selectRelease } from '../src/workflows/catalog/versions.js';
import { installPreselectedWorkflow } from '../src/workflows/command-add.js';
import { runWorkflowCommand } from '../src/workflows/commands.js';
import { makeZip } from './archive-helpers.js';

type Dict = Record<string, unknown>;

const CURRENT_URL = 'https://example.com/current.zip';
const OLD_URL = 'https://example.com/old.zip';
const OLD_YAML_URL = 'https://example.com/old.yml';
const OLD_WORKFLOW_YAML = `schema_version: "1.0"
workflow:
  id: history-wf
  name: History Workflow
  version: 1.0.0
steps:
  - id: first
    type: gate
    message: Continue?
`;

let tmp: string;
let projectDir: string;
let prevCwd: string;
let output: string;
let prevOut: unknown;
let prevErr: unknown;
const realOpenUrl = httpDeps.openUrl;
const proto = WorkflowCatalog.prototype as unknown as Dict;
const realActive = proto.getActiveCatalogs;
const realFetch = proto.fetchSingleCatalog;
const realInfo = proto.getWorkflowInfo;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wf-versions-'));
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
  proto.getActiveCatalogs = realActive;
  proto.fetchSingleCatalog = realFetch;
  proto.getWorkflowInfo = realInfo;
  rmSync(tmp, { recursive: true, force: true });
});

function archive(version: string, workflowId = 'history-wf', requires: Dict | null = null): Buffer {
  const document: Dict = {
    schema_version: '1.0',
    workflow: { id: workflowId, name: 'History Workflow', version },
    steps: [{ id: 'first', type: 'gate', message: 'Continue?' }],
  };
  if (requires !== null) document.requires = requires;
  return makeZip({ 'workflow.yml': dumpYaml(document) });
}

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');

function entry(): Dict {
  const old = archive('1.0.0', 'history-wf', { integrations: ['copilot'] });
  const current = archive('2.0.0');
  return {
    id: 'history-wf',
    name: 'History Workflow',
    version: '2.0.0',
    url: CURRENT_URL,
    sha256: sha(current),
    bundled: true,
    releases: {
      '1.0.0': { url: OLD_URL, sha256: sha(old), requires: { integrations: ['copilot'] } },
    },
  };
}

function catalog(high: Dict, low: Dict | null = null, installAllowed = true): WorkflowCatalog {
  const sources: WorkflowCatalogEntry[] = [
    { url: 'https://example.com/high.json', name: 'high', priority: 1, install_allowed: installAllowed, description: '' },
  ];
  if (low !== null) {
    sources.push({ url: 'https://example.com/low.json', name: 'low', priority: 2, install_allowed: true, description: '' });
  }
  proto.getActiveCatalogs = () => sources;
  proto.fetchSingleCatalog = async (source: WorkflowCatalogEntry) => ({
    workflows: { 'history-wf': source.name === 'high' ? high : low },
  });
  return new WorkflowCatalog(projectDir);
}

function serve(body: Uint8Array | string, requested: string[] = []): void {
  httpDeps.openUrl = (async (url: string) => {
    requested.push(url);
    return new HttpResponse(new Response(typeof body === 'string' ? body : Buffer.from(body)), url);
  }) as typeof httpDeps.openUrl;
}

const flat = (s: string): string => s.split(/\s+/).join(' ');
const registryEntry = (): Dict | null => new WorkflowRegistry(projectDir).get('history-wf') as Dict | null;

describe('workflow catalog release selection', () => {
  test('current and historical metadata', async () => {
    const e = entry();
    const cat = catalog(e);
    expect((await cat.getWorkflowInfo('history-wf'))!.url).toBe(CURRENT_URL);
    expect((await cat.getWorkflowInfo('history-wf', 'v2.0'))!.url).toBe(CURRENT_URL);
    const old = (await cat.getWorkflowInfo('history-wf', '1.0.0.0'))!;
    expect(old.url).toBe(OLD_URL);
    expect(old.version).toBe('1.0.0');
    expect(old.sha256).toBe(((e.releases as Dict)['1.0.0'] as Dict).sha256);
    expect(old.requires).toEqual({ integrations: ['copilot'] });
    expect('releases' in old || 'bundled' in old).toBe(false);
    expect(old._catalog_name).toBe('high');
    expect(await cat.getWorkflowVersions('history-wf')).toEqual(['2.0.0', '1.0.0']);
    expect(await cat.getWorkflowInfo('history-wf', 'invalid')).toBeNull();
    expect(await cat.getWorkflowInfo('history-wf', '0.0.1')).toBeNull();
  });

  test('legacy entry and winning source', async () => {
    const cat = catalog({ id: 'history-wf', version: '2.0.0', url: CURRENT_URL }, entry());
    expect((await cat.getWorkflowInfo('history-wf', '2.0.0'))!.url).toBe(CURRENT_URL);
    expect(await cat.getWorkflowInfo('history-wf', '1.0.0')).toBeNull();
    expect(await cat.getWorkflowVersions('history-wf')).toEqual(['2.0.0']);
    expect((await cat.search({ query: 'history-wf' }))[0]!.version).toBe('2.0.0');
  });

  const A = 'a'.repeat(64);
  const malformed: Array<[string, unknown]> = [
    ['None', null],
    ['list', []],
    ['bad key', { bad: { url: OLD_URL, sha256: A } }],
    ['non-ascii digits', { '١.٠.٠': { url: OLD_URL, sha256: A } }],
    ['two-part', { '1.0': { url: OLD_URL, sha256: A } }],
    ['v-prefix', { 'v1.0.0': { url: OLD_URL, sha256: A } }],
    ['repeats current', { '2.0.0': { url: OLD_URL, sha256: A } }],
    ['four-part', { '2.0.0.0': { url: OLD_URL, sha256: A } }],
    ['equivalent spellings', { '1.0.0': { url: OLD_URL, sha256: A }, '01.0.0': { url: OLD_URL, sha256: 'b'.repeat(64) } }],
    ['no url', { '1.0.0': { sha256: A } }],
    ['http url', { '1.0.0': { url: 'http://example.com/old.zip', sha256: A } }],
    ['malformed url', { '1.0.0': { url: 'https://[::1', sha256: A } }],
    ['no digest', { '1.0.0': { url: OLD_URL } }],
    ['bad digest', { '1.0.0': { url: OLD_URL, sha256: 'wrong' } }],
    ['reserved field', { '1.0.0': { url: OLD_URL, sha256: A, id: 'other' } }],
    ['requires list', { '1.0.0': { url: OLD_URL, sha256: A, requires: [] } }],
    ['null record', { '1.0.0': null }],
  ];
  for (const [label, history] of malformed) {
    test(`malformed history rejected: ${label}`, async () => {
      const e = entry();
      e.releases = history;
      const cat = catalog(e);
      await expect(cat.getWorkflowInfo('history-wf', '1.0.0')).rejects.toBeInstanceOf(WorkflowValidationError);
      await expect(cat.getWorkflowVersions('history-wf')).rejects.toBeInstanceOf(WorkflowValidationError);
    });
  }

  test('history without current version rejected', async () => {
    const e = entry();
    delete e.version;
    await expect(catalog(e).getWorkflowInfo('history-wf')).rejects.toThrow('no current version');
  });

  for (const version of ['2.0', 'v2.0.0', '2.0.0.0', '٢.٠.٠']) {
    test(`history with non-workflow current version rejected: ${version}`, async () => {
      const e = entry();
      e.version = version;
      await expect(catalog(e).getWorkflowInfo('history-wf')).rejects.toThrow('invalid current version');
    });
  }

  test('selectRelease / availableVersions / isValidWorkflowVersion units', () => {
    expect(isValidWorkflowVersion('1.2.3')).toBe(true);
    expect(isValidWorkflowVersion('1.2')).toBe(false);
    expect(isValidWorkflowVersion(1)).toBe(false);
    const e = entry();
    expect(selectRelease(e, null)).toBe(e);
    expect(selectRelease(e, '2.0.0')).toBe(e);
    expect(availableVersions({ version: '' })).toEqual([]);
    expect(availableVersions({ version: '3.0.0' })).toEqual(['3.0.0']);
    // Legacy entries without history may keep a non-PEP-440 version.
    expect(selectRelease({ version: 'nightly' }, 'nightly')).toEqual({ version: 'nightly' });
    expect(selectRelease({ version: 'nightly' }, '1.0.0')).toBeNull();
  });
});

describe('workflow info --versions', () => {
  test('malformed history is reported by the CLI', async () => {
    const e = entry();
    e.releases = { '1.0.0': { url: OLD_URL } };
    catalog(e);
    for (const args of [
      ['info', 'history-wf'],
      ['info', 'history-wf', '--versions'],
      ['add', 'history-wf', '--version', '1.0.0'],
    ]) {
      output = '';
      expect(await runWorkflowCommand(args)).toBe(1);
      expect(output).toContain('needs a SHA-256 digest');
      expect(output).not.toContain('not found');
    }
  });

  test('uses the catalog even when installed', async () => {
    catalog(entry());
    new WorkflowRegistry(projectDir).add('history-wf', { version: '0.5.0', source: 'catalog' });
    expect(await runWorkflowCommand(['info', 'history-wf', '--versions'])).toBe(0);
    expect(output).toContain('Catalog versions for history-wf: 2.0.0, 1.0.0');
    expect(output).toContain('Install policy: installable');
    output = '';
    expect(await runWorkflowCommand(['info', 'history-wf'])).toBe(0);
    expect(output).toContain('Version:     2.0.0');
  });

  test('labels a discovery-only catalog', async () => {
    catalog(entry(), entry(), false);
    expect(await runWorkflowCommand(['info', 'history-wf', '--versions'])).toBe(0);
    expect(output).toContain('2.0.0, 1.0.0');
    expect(output).toContain('Install policy: discovery-only (not installable)');
  });

  test('unknown workflow', async () => {
    proto.getActiveCatalogs = () => [];
    expect(await runWorkflowCommand(['info', 'nope', '--versions'])).toBe(1);
    expect(output).toContain("Workflow 'nope' not found in catalog");
  });
});

describe('workflow add --version', () => {
  test('uses the historical URL, digest and requirements', async () => {
    catalog(entry());
    const requested: string[] = [];
    serve(archive('1.0.0', 'history-wf', { integrations: ['copilot'] }), requested);
    expect(await runWorkflowCommand(['add', 'history-wf', '--version', 'v1.0'])).toBe(0);
    expect(requested).toEqual([OLD_URL]);
    expect(registryEntry()!.version).toBe('1.0.0');
  });

  test('preselected workflow installs without reloading the catalog', async () => {
    const cat = catalog(entry());
    const selected = (await cat.getWorkflowInfo('history-wf', '1.0.0'))!;
    expect(selected.url).toBe(OLD_URL);
    proto.getWorkflowInfo = async () => {
      throw new Error('catalog was re-resolved');
    };
    const requested: string[] = [];
    serve(archive('1.0.0', 'history-wf', { integrations: ['copilot'] }), requested);
    await installPreselectedWorkflow('history-wf', { version: '1.0.0', selectedInfo: selected });
    expect(requested).toEqual([OLD_URL]);
    expect(registryEntry()!.version).toBe('1.0.0');
  });

  test('preselected workflow ignores a same-named local path', async () => {
    const cat = catalog(entry());
    const selected = (await cat.getWorkflowInfo('history-wf', '1.0.0'))!;
    const shadow = join(projectDir, 'history-wf');
    writeFileSync(shadow, 'not a workflow');
    proto.getWorkflowInfo = async () => {
      throw new Error('catalog was re-resolved');
    };
    serve(archive('1.0.0', 'history-wf', { integrations: ['copilot'] }));
    await installPreselectedWorkflow('history-wf', { version: '1.0.0', selectedInfo: selected });
    expect(registryEntry()!.version).toBe('1.0.0');
    expect(readFileSync(shadow, 'utf-8')).toBe('not a workflow');
  });

  test('preselected workflow rejects a bad digest without reloading the catalog', async () => {
    const cat = catalog(entry());
    const selected = (await cat.getWorkflowInfo('history-wf', '1.0.0'))!;
    selected.sha256 = '0'.repeat(64);
    proto.getWorkflowInfo = async () => {
      throw new Error('catalog was re-resolved');
    };
    serve(archive('1.0.0'));
    await expect(
      installPreselectedWorkflow('history-wf', { version: '1.0.0', selectedInfo: selected }),
    ).rejects.toBeInstanceOf(CliExit);
    expect(registryEntry()).toBeNull();
  });

  test('exact YAML release verifies digest and version', async () => {
    const e = entry();
    (e.releases as Dict)['1.0.0'] = { url: OLD_YAML_URL, sha256: sha(OLD_WORKFLOW_YAML) };
    catalog(e);
    serve(OLD_WORKFLOW_YAML);
    expect(await runWorkflowCommand(['add', 'history-wf', '--version', '1.0'])).toBe(0);
    expect(registryEntry()!.version).toBe('1.0.0');
  });

  test('exact YAML release rejects mismatched requirements', async () => {
    const e = entry();
    (e.releases as Dict)['1.0.0'] = {
      url: OLD_YAML_URL,
      sha256: sha(OLD_WORKFLOW_YAML),
      requires: { integrations: ['copilot'] },
    };
    catalog(e);
    const requested: string[] = [];
    serve(OLD_WORKFLOW_YAML, requested);
    expect(await runWorkflowCommand(['add', 'history-wf', '--version', '1.0.0'])).toBe(1);
    expect(flat(output)).toContain('requirements do not match');
    expect(requested).toEqual([OLD_YAML_URL]);
    expect(registryEntry()).toBeNull();
    expect(existsSync(join(projectDir, '.specify', 'workflows', 'history-wf', 'workflow.yml'))).toBe(false);
  });

  for (const sourceType of ['archive', 'yaml']) {
    test(`exact release rejects a differently spelled artifact version (${sourceType})`, async () => {
      const download =
        sourceType === 'archive'
          ? archive('01.0.0')
          : Buffer.from(OLD_WORKFLOW_YAML.replace('version: 1.0.0', 'version: "01.0.0"'));
      const e = entry();
      (e.releases as Dict)['1.0.0'] = {
        url: sourceType === 'archive' ? OLD_URL : OLD_YAML_URL,
        sha256: sha(download),
      };
      catalog(e);
      serve(download);
      expect(await runWorkflowCommand(['add', 'history-wf', '--version', 'v1.0'])).toBe(1);
      expect(output).toContain('does not match the catalog version');
      expect(registryEntry()).toBeNull();
    });
  }

  const inconsistent: Array<[string, Buffer, boolean, string]> = [
    ['version', archive('3.0.0'), false, 'does not match the catalog version'],
    ['id', archive('1.0.0', 'wrong-wf'), false, 'does not match the requested workflow ID'],
    ['requirements', archive('1.0.0'), false, 'requirements do not match'],
    ['digest', archive('1.0.0', 'history-wf', { integrations: ['copilot'] }), true, 'Integrity check failed'],
  ];
  for (const [label, download, badDigest, error] of inconsistent) {
    test(`exact add rejects an inconsistent archive (${label})`, async () => {
      const e = entry();
      ((e.releases as Dict)['1.0.0'] as Dict).sha256 = badDigest ? '0'.repeat(64) : sha(download);
      catalog(e);
      serve(download);
      expect(await runWorkflowCommand(['add', 'history-wf', '--version', '1.0.0'])).toBe(1);
      expect(flat(output)).toContain(error);
      expect(registryEntry()).toBeNull();
      expect(existsSync(join(projectDir, '.specify', 'workflows', 'history-wf', 'workflow.yml'))).toBe(false);
    });
  }

  test('no fallthrough for a missing or discovery-only release', async () => {
    const high = entry();
    high.releases = {};
    catalog(high, entry());
    expect(await runWorkflowCommand(['add', 'history-wf', '--version', '1.0.0'])).toBe(1);
    expect(output).toContain('not found in the winning catalog');
    catalog(entry(), entry(), false);
    output = '';
    expect(await runWorkflowCommand(['add', 'history-wf', '--version', '1.0.0'])).toBe(1);
    expect(output).toContain('discovery-only');
  });

  test('unqualified add still uses the current release; --from rejects --version', async () => {
    catalog(entry());
    const requested: string[] = [];
    serve(archive('2.0.0'), requested);
    expect(await runWorkflowCommand(['add', 'history-wf'])).toBe(0);
    expect(requested).toEqual([CURRENT_URL]);
    expect(registryEntry()!.version).toBe('2.0.0');
    output = '';
    expect(await runWorkflowCommand(['add', 'history-wf', '--from', OLD_URL, '--version', '1.0.0'])).toBe(1);
    expect(output).toContain('--version requires a workflow ID');
    expect(requested).toEqual([CURRENT_URL]);
  });

  for (const sourceType of ['direct-url', 'local-file', 'local-dir', 'dev']) {
    test(`exact add rejects non-catalog sources (${sourceType})`, async () => {
      let source = 'history-wf';
      const options: string[] = [];
      if (sourceType === 'direct-url') source = OLD_YAML_URL;
      else if (sourceType === 'local-dir') {
        source = join(projectDir, 'local-workflow');
        mkdirSync(source);
        writeFileSync(join(source, 'workflow.yml'), OLD_WORKFLOW_YAML);
      } else if (sourceType === 'local-file') {
        source = join(projectDir, 'local-workflow.yml');
        writeFileSync(source, OLD_WORKFLOW_YAML);
      } else options.push('--dev');
      const requested: string[] = [];
      serve('', requested);
      expect(await runWorkflowCommand(['add', source, ...options, '--version', '1.0.0'])).toBe(1);
      expect(output).toContain('--version requires a workflow ID from a catalog');
      expect(requested).toEqual([]);
      expect(registryEntry()).toBeNull();
    });
  }
});
