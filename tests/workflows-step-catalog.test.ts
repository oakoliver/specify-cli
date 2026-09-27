/**
 * Tests for the step catalog stack, StepRegistry, and the
 * ``specify workflow step`` / ``specify workflow step catalog`` CLI
 * (ports of upstream TestStepRegistryCustom / TestStepCatalog and
 * tests/specify_cli/workflows/step/**).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpResponse } from '../src/authentication/http.js';
import { console as stdoutConsole, errConsole } from '../src/console.js';
import { dumpYaml, parseYaml } from '../src/yaml.js';
import { httpDeps } from '../src/workflows/catalog/domain.js';
import { runWorkflowStepCatalogCommand } from '../src/workflows/step/catalog/commands.js';
import { StepCatalog, StepRegistry, StepValidationError } from '../src/workflows/step/catalog/domain.js';
import { runWorkflowStepCommand } from '../src/workflows/step/commands.js';
import { stepPackageLimits, validateStepIdOrExit } from '../src/workflows/step/helpers.js';

type Dict = Record<string, unknown>;

let tmp: string;
let projectDir: string;
let prevCwd: string;
let prevHome: string | undefined;
let output: string;
let prevOut: unknown;
let prevErr: unknown;
const realOpenUrl = httpDeps.openUrl;
const realGetStepInfo = StepCatalog.prototype.getStepInfo;
const realLimits = { ...stepPackageLimits };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wf-step-'));
  projectDir = join(tmp, 'proj');
  mkdirSync(join(projectDir, '.specify', 'workflows'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectDir);
  prevHome = process.env.HOME;
  process.env.HOME = join(tmp, 'home');
  delete process.env.SPECKIT_STEP_CATALOG_URL;
  delete process.env.SPECIFY_INIT_DIR;
  output = '';
  prevOut = (stdoutConsole as unknown as { opts: Dict }).opts.file;
  prevErr = (errConsole as unknown as { opts: Dict }).opts.file;
  stdoutConsole.file = { write: (c: string) => (output += c) };
  errConsole.file = { write: (c: string) => (output += c) };
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  (stdoutConsole as unknown as { opts: Dict }).opts.file = prevOut;
  (errConsole as unknown as { opts: Dict }).opts.file = prevErr;
  httpDeps.openUrl = realOpenUrl;
  StepCatalog.prototype.getStepInfo = realGetStepInfo;
  Object.assign(stepPackageLimits, realLimits);
  rmSync(tmp, { recursive: true, force: true });
});

const stepsDir = (): string => join(projectDir, '.specify', 'workflows', 'steps');
const configPath = (): string => join(projectDir, '.specify', 'step-catalogs.yml');

function fakeResponse(body: string | Uint8Array, finalUrl: string): HttpResponse {
  const resp = new Response(typeof body === 'string' ? body : Buffer.from(body));
  return new HttpResponse(resp, finalUrl);
}

function stubCatalogEntry(fields: Dict): void {
  StepCatalog.prototype.getStepInfo = async function (stepId: string) {
    return { id: stepId, name: 'Test Step', _install_allowed: true, ...fields };
  };
}

function stubDownloads(bodies: Record<string, string>, requested: string[] = []): void {
  httpDeps.openUrl = (async (url: string) => {
    requested.push(url);
    if (!(url in bodies)) throw new Error(`unexpected url ${url}`);
    return fakeResponse(bodies[url], url);
  }) as typeof httpDeps.openUrl;
}

function forbidNetwork(): void {
  httpDeps.openUrl = (async () => {
    throw new Error('download should not start');
  }) as typeof httpDeps.openUrl;
}

const BASIC = {
  url: 'https://example.com/step.yml',
  init_url: 'https://example.com/__init__.py',
};

const BASIC_BODIES = {
  'https://example.com/step.yml': 'step:\n  type_key: my-step\n  version: 2.0.0\n',
  'https://example.com/__init__.py': '# trusted init\n',
};

// ============================================================================
// StepRegistry
// ============================================================================

describe('StepRegistry', () => {
  test('add does not mutate input; persistence; remove', () => {
    const registry = new StepRegistry(projectDir);
    const metadata = { name: 'Deploy', type_key: 'deploy', nested: { key: 'original' } };
    registry.add('deploy', metadata);
    expect('installed_at' in metadata).toBe(false);
    metadata.nested.key = 'changed-after-add';
    expect(((registry.get('deploy') as Dict).nested as Dict).key).toBe('original');
    expect(new StepRegistry(projectDir).isInstalled('deploy')).toBe(true);
    expect(registry.remove('deploy')).toBe(true);
    expect(registry.remove('nonexistent')).toBe(false);
  });

  test('corrupted, shape-invalid, and unreadable registries reset', () => {
    mkdirSync(stepsDir(), { recursive: true });
    const p = join(stepsDir(), 'step-registry.json');
    writeFileSync(p, 'not json');
    expect(new StepRegistry(projectDir).list()).toEqual({});
    writeFileSync(p, JSON.stringify({ schema_version: '1.0', steps: 'bad' }));
    const r = new StepRegistry(projectDir);
    expect(r.list()).toEqual({});
    r.add('deploy', { name: 'Deploy' });
    expect(r.isInstalled('deploy')).toBe(true);
    if (process.getuid && process.getuid() !== 0) {
      chmodSync(p, 0o000);
      try {
        expect(new StepRegistry(projectDir).list()).toEqual({});
      } finally {
        chmodSync(p, 0o644);
      }
    }
  });

  test('symlinked steps dir: load ignores, save refuses', () => {
    const outside = join(tmp, 'outside-steps');
    mkdirSync(outside);
    writeFileSync(join(outside, 'step-registry.json'), JSON.stringify({ schema_version: '1.0', steps: { evil: {} } }));
    symlinkSync(outside, stepsDir());
    const registry = new StepRegistry(projectDir);
    expect(registry.list()).toEqual({});
    expect(() => registry.save()).toThrow(new StepValidationError('Refusing to write step registry through a symlinked path.'));
  });
});

// ============================================================================
// StepCatalog
// ============================================================================

describe('StepCatalog', () => {
  test('defaults and env override', () => {
    const catalog = new StepCatalog(projectDir);
    const entries = catalog.getActiveCatalogs();
    expect(entries.map((e) => [e.name, e.description])).toEqual([
      ['default', 'Official step types'],
      ['community', 'Community-contributed step types (discovery only)'],
    ]);
    expect(entries[0].url).toBe('https://raw.githubusercontent.com/github/spec-kit/main/workflows/step-catalog.json');
    process.env.SPECKIT_STEP_CATALOG_URL = 'https://example.com/steps.json';
    expect(catalog.getActiveCatalogs()[0].description).toBe('From SPECKIT_STEP_CATALOG_URL');
    delete process.env.SPECKIT_STEP_CATALOG_URL;
  });

  test('config shape guards', () => {
    const catalog = new StepCatalog(projectDir);
    for (const body of ['catalogs: {}\n', "catalogs: ''\n", 'catalogs: 0\n', 'catalogs: false\n']) {
      writeFileSync(configPath(), body);
      expect(() => catalog.loadCatalogConfig(configPath())).toThrow(/'catalogs' must be a list/);
    }
    for (const body of ['[]\n', 'false\n']) {
      writeFileSync(configPath(), body);
      expect(() => catalog.loadCatalogConfig(configPath())).toThrow(StepValidationError);
    }
  });

  test('add / remove catalog', () => {
    const catalog = new StepCatalog(projectDir);
    expect(() => catalog.removeCatalog(0)).toThrow('No step catalog config file found.');
    writeFileSync(configPath(), '');
    expect(catalog.addCatalog('https://example.com/steps.json', 'mine')).toBe('added');
    expect(catalog.addCatalog('https://example.com/steps.json')).toBe('unchanged');
    expect(() => catalog.addCatalog('https://example.com/steps.json', 'other')).toThrow('Catalog URL already configured');
    const cats = (parseYaml(readFileSync(configPath(), 'utf-8')) as Dict).catalogs as Dict[];
    expect(cats[0].name).toBe('mine');
    expect(catalog.removeCatalog(0)).toBe('mine');
  });

  test('cache is skipped when the cache path is symlinked', async () => {
    mkdirSync(stepsDir(), { recursive: true });
    const outside = join(tmp, 'outside-cache');
    mkdirSync(outside);
    symlinkSync(outside, join(stepsDir(), '.cache'));
    httpDeps.openUrl = (async (url: string) => fakeResponse('{"steps": {}}', url)) as typeof httpDeps.openUrl;
    const catalog = new StepCatalog(projectDir);
    await catalog.fetchSingleCatalog({ url: 'https://example.com/s.json', name: 't', priority: 1, install_allowed: true, description: '' });
    expect(readdirSync(outside)).toEqual([]);
  });

  test('list-format ids are stringified and stripped; search', async () => {
    httpDeps.openUrl = (async (url: string) =>
      fakeResponse(
        JSON.stringify({
          steps: [
            { id: ' deploy ', name: 'Deploy', description: 'Ship it' },
            { id: 42, name: 'Numeric' },
            { id: null, name: 'skip' },
            { id: '   ', name: 'blank' },
          ],
        }),
        url,
      )) as typeof httpDeps.openUrl;
    process.env.SPECKIT_STEP_CATALOG_URL = 'https://example.com/steps.json';
    try {
      const catalog = new StepCatalog(projectDir);
      const results = await catalog.search();
      expect(results.map((r) => r.id)).toEqual(['deploy', '42']);
      expect((await catalog.search('ship')).map((r) => r.id)).toEqual(['deploy']);
      expect((await catalog.getStepInfo('deploy'))!._catalog_name).toBe('env-override');
    } finally {
      delete process.env.SPECKIT_STEP_CATALOG_URL;
    }
  });
});

// ============================================================================
// helpers
// ============================================================================

describe('validateStepIdOrExit', () => {
  test('rejects unsafe ids', () => {
    for (const bad of ['', ' ', ' a', 'a/b', 'a\\b', '.', '..', '.hidden', 'x.', 'x ', '.cache', 'step-registry.json', 'CON', 'nul.txt', 'a:b', 'a\u0001']) {
      expect(() => validateStepIdOrExit(bad)).toThrow();
    }
    validateStepIdOrExit('my-step');
    validateStepIdOrExit('my.step');
  });
});

// ============================================================================
// CLI: step add
// ============================================================================

describe('specify workflow step add', () => {
  test('installs a step and registers it', async () => {
    stubCatalogEntry({ ...BASIC, description: 'desc', _catalog_name: 'default' });
    stubDownloads(BASIC_BODIES);
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(0);
    expect(output).toContain("Step type 'Test Step' (my-step) installed");
    expect(readFileSync(join(stepsDir(), 'my-step', 'step.yml'), 'utf-8')).toBe(BASIC_BODIES['https://example.com/step.yml']);
    const meta = new StepRegistry(projectDir).get('my-step') as Dict;
    expect(meta).toMatchObject({
      name: 'Test Step',
      version: '2.0.0',
      description: 'desc',
      author: '',
      source: 'catalog',
      catalog_name: 'default',
      type_key: 'my-step',
    });
    expect(readdirSync(stepsDir()).filter((n) => n.startsWith('speckit_step_tmp_'))).toEqual([]);

    output = '';
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
    expect(output).toContain("Step type 'my-step' is already installed.");
  });

  test('derives __init__.py URL from step.yml URL', async () => {
    stubCatalogEntry({ url: 'https://example.com/pkg/step.yml' });
    const requested: string[] = [];
    stubDownloads(
      {
        'https://example.com/pkg/step.yml': 'step:\n  type_key: my-step\n',
        'https://example.com/pkg/__init__.py': '',
      },
      requested,
    );
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(0);
    expect(requested).toEqual(['https://example.com/pkg/step.yml', 'https://example.com/pkg/__init__.py']);
    expect((new StepRegistry(projectDir).get('my-step') as Dict).version).toBe('0.0.0');
  });

  test('not found, discovery-only, built-in conflict', async () => {
    StepCatalog.prototype.getStepInfo = async () => null;
    expect(await runWorkflowStepCommand(['add', 'nope'])).toBe(1);
    expect(output).toContain("Step type 'nope' not found in catalog");
    stubCatalogEntry({ ...BASIC, _install_allowed: false });
    output = '';
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
    expect(output).toContain("Step type 'my-step' is from a discovery-only catalog");
    expect(output).toContain('Direct installation is not enabled for this catalog source.');
    stubCatalogEntry(BASIC);
    output = '';
    expect(await runWorkflowStepCommand(['add', 'shell'])).toBe(1);
    expect(output).toContain("Step type 'shell' conflicts with a built-in step type");
  });

  for (const [fields, expected] of [
    [{ url: 123 }, 'malformed step.yml URL'],
    [{ step_yml_url: [], url: 'https://example.com/step.yml' }, 'malformed step.yml URL'],
    [{ url: 'https://example.com/step.yml', init_url: 123 }, 'malformed __init__.py URL'],
    [{}, "Catalog entry for 'my-step' has no URL"],
    [{ url: 'https://example.com/pkg.yaml' }, 'Cannot derive __init__.py URL'],
  ] as Array<[Dict, string]>) {
    test(`rejects bad catalog URLs before network: ${expected}`, async () => {
      stubCatalogEntry(fields);
      forbidNetwork();
      expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
      expect(output.replace(/\s+/g, ' ')).toContain(expected);
      expect(existsSync(join(stepsDir(), 'my-step'))).toBe(false);
    });
  }

  for (const body of ['[]\n', 'false\n', '0\n', "''\n", 'null\n', '~\n', 'NULL\n', 'just a string\n']) {
    test(`rejects non-mapping step.yml ${JSON.stringify(body)}`, async () => {
      stubCatalogEntry(BASIC);
      stubDownloads({ 'https://example.com/step.yml': body, 'https://example.com/__init__.py': '' });
      expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
      expect(output).toContain('step.yml must be a YAML mapping');
      expect(existsSync(join(stepsDir(), 'my-step'))).toBe(false);
    });
  }

  test('empty step.yml reports missing type_key; mismatched type_key', async () => {
    stubCatalogEntry(BASIC);
    stubDownloads({ 'https://example.com/step.yml': '# empty\n', 'https://example.com/__init__.py': '' });
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
    expect(output).toContain("step.yml missing 'step.type_key' field");
    stubDownloads({ 'https://example.com/step.yml': 'step:\n  type_key: other\n', 'https://example.com/__init__.py': '' });
    output = '';
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
    expect(output).toContain("step.yml type_key ('other') does not match catalog ID ('my-step')");
    stubDownloads({ 'https://example.com/step.yml': 'step: 5\n', 'https://example.com/__init__.py': '' });
    output = '';
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
    expect(output).toContain("step.yml 'step' field must be a mapping");
  });

  for (const alias of ['./step.yml', 'step.yml/', 'STEP.YML', '.\\step.yml', './__init__.py', '__INIT__.PY']) {
    test(`does not overwrite required files through alias ${alias}`, async () => {
      stubCatalogEntry({ ...BASIC, extra_files: { [alias]: 'https://example.com/overwrite' } });
      const requested: string[] = [];
      stubDownloads(BASIC_BODIES, requested);
      expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(0);
      expect(requested).not.toContain('https://example.com/overwrite');
      expect(readFileSync(join(stepsDir(), 'my-step', '__init__.py'), 'utf-8')).toBe('# trusted init\n');
    });
  }

  test('downloads extra files into nested paths', async () => {
    stubCatalogEntry({ ...BASIC, extra_files: { 'lib/helpers.py': 'https://example.com/helpers.py' } });
    stubDownloads({ ...BASIC_BODIES, 'https://example.com/helpers.py': 'HELP = 1\n' });
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(0);
    expect(readFileSync(join(stepsDir(), 'my-step', 'lib', 'helpers.py'), 'utf-8')).toBe('HELP = 1\n');
  });

  for (const [relPath, expected] of [
    ['..', 'not a valid relative file path'],
    ['sub/../x', 'not a valid relative file path'],
    ['.', 'not a valid relative file path'],
    ['/etc/passwd', 'outside the step package directory'],
    ['   ', 'empty or non-string path key'],
  ]) {
    test(`rejects invalid extra_files path ${JSON.stringify(relPath)}`, async () => {
      stubCatalogEntry({ ...BASIC, extra_files: { [relPath]: 'https://example.com/x' } });
      stubDownloads(BASIC_BODIES);
      expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
      expect(output.replace(/\s+/g, ' ')).toContain(expected);
      expect(existsSync(join(stepsDir(), 'my-step'))).toBe(false);
    });
  }

  test('rejects non-string extra file URL and non-mapping extra_files warns', async () => {
    stubCatalogEntry({ ...BASIC, extra_files: { 'x.py': 5 } });
    stubDownloads(BASIC_BODIES);
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
    expect(output).toContain("extra_files entry 'x.py' has an empty or non-string URL");
    stubCatalogEntry({ ...BASIC, extra_files: ['x'] });
    output = '';
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(0);
    expect(output.replace(/\s+/g, ' ')).toContain("Catalog entry 'extra_files' is not a mapping");
  });

  test('file-count and cumulative-size limits', async () => {
    stepPackageLimits.maxFiles = 3;
    stubCatalogEntry({ ...BASIC, extra_files: { 'a.py': 'https://example.com/a', 'b.py': 'https://example.com/b' } });
    forbidNetwork();
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
    expect(output).toContain('exceeding the 3-file limit');
    expect(existsSync(stepsDir()) ? readdirSync(stepsDir()).filter((n) => n.startsWith('speckit_step_tmp_')) : []).toEqual([]);

    stepPackageLimits.maxFiles = 512;
    stepPackageLimits.maxBytes = 40;
    stubCatalogEntry({ ...BASIC, extra_files: { 'a.py': 'https://example.com/a' } });
    stubDownloads({ ...BASIC_BODIES, 'https://example.com/a': 'x'.repeat(30) });
    output = '';
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
    expect(output).toContain('40-byte total size limit');
    expect(existsSync(join(stepsDir(), 'my-step'))).toBe(false);
    expect(readdirSync(stepsDir()).filter((n) => n.startsWith('speckit_step_tmp_'))).toEqual([]);
  });

  test('rejects symlinked steps base dir and existing step dir', async () => {
    stubCatalogEntry(BASIC);
    stubDownloads(BASIC_BODIES);
    mkdirSync(join(stepsDir(), 'my-step'), { recursive: true });
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
    expect(output).toContain('Step directory already exists at');
    rmSync(stepsDir(), { recursive: true });
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, stepsDir());
    output = '';
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
    expect(output).toContain('Refusing to use symlinked step directory');
  });

  test('download failures are reported', async () => {
    stubCatalogEntry({ url: 'http://example.com/step.yml' });
    forbidNetwork();
    expect(await runWorkflowStepCommand(['add', 'my-step'])).toBe(1);
    expect(output).toContain('Failed to download step files: Refusing to fetch from non-HTTPS URL: http://example.com/step.yml');
  });
});

// ============================================================================
// CLI: step remove / list / info / search / catalog
// ============================================================================

describe('specify workflow step remove/list/info/search', () => {
  test('remove registered, orphaned, and missing steps', async () => {
    const dir = join(stepsDir(), 'my-step');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'step.yml'), 'step:\n  type_key: my-step\n');
    new StepRegistry(projectDir).add('my-step', { name: 'Mine', version: '1.0.0' });
    expect(await runWorkflowStepCommand(['remove', 'my-step'])).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(new StepRegistry(projectDir).isInstalled('my-step')).toBe(false);
    expect(output).toContain("Step type 'my-step' uninstalled");

    mkdirSync(dir, { recursive: true });
    output = '';
    expect(await runWorkflowStepCommand(['remove', 'my-step'])).toBe(0);
    expect(output).toContain('Warning:');
    expect(existsSync(dir)).toBe(false);

    output = '';
    expect(await runWorkflowStepCommand(['remove', 'my-step'])).toBe(1);
    expect(output).toContain("Step type 'my-step' is not installed");
  });

  test('list shows built-in and custom steps', async () => {
    new StepRegistry(projectDir).add('deploy', { name: 'Deploy [x]', version: '1.2.0' });
    expect(await runWorkflowStepCommand(['list'])).toBe(0);
    expect(output).toContain('Installed Step Types:');
    expect(output).toContain('Built-in:');
    expect(output).toContain('• shell');
    expect(output).toContain('Custom (installed):');
    expect(output).toContain('Deploy [x] (deploy) v1.2.0');
    expect(output).toContain('Install a new step type with: specify workflow step add <id>');
  });

  test('info for built-in, installed, catalog and missing', async () => {
    expect(await runWorkflowStepCommand(['info', 'shell'])).toBe(0);
    expect(output).toContain('shell (built-in)');
    expect(output).toContain('Built-in step type');
    new StepRegistry(projectDir).add('deploy', { name: 'Deploy', version: '1.0.0', author: 'Ann' });
    output = '';
    expect(await runWorkflowStepCommand(['info', 'deploy'])).toBe(0);
    expect(output).toContain('Author:      Ann');
    expect(output).toContain('Installed');
    stubCatalogEntry({ name: 'Remote', version: '3.0.0', description: 'From catalog' });
    output = '';
    expect(await runWorkflowStepCommand(['info', 'remote'])).toBe(0);
    expect(output).toContain('Not installed');
    expect(output).toContain('Install with: specify workflow step add remote');
    StepCatalog.prototype.getStepInfo = async () => null;
    output = '';
    expect(await runWorkflowStepCommand(['info', 'ghost'])).toBe(1);
    expect(output).toContain("Step type 'ghost' not found");
  });

  test('search results and empty results', async () => {
    process.env.SPECKIT_STEP_CATALOG_URL = 'https://example.com/steps.json';
    try {
      httpDeps.openUrl = (async (url: string) =>
        fakeResponse(JSON.stringify({ steps: { deploy: { name: 'Deploy', version: '1.0.0', description: 'Ship it' } } }), url)) as typeof httpDeps.openUrl;
      expect(await runWorkflowStepCommand(['search'])).toBe(0);
      expect(output).toContain('Step Types (1):');
      expect(output).toContain('Deploy (deploy) v1.0.0');
      expect(output).toContain('Ship it');
      output = '';
      expect(await runWorkflowStepCommand(['search', 'nomatch'])).toBe(0);
      expect(output).toContain("No step types found matching 'nomatch'.");
    } finally {
      delete process.env.SPECKIT_STEP_CATALOG_URL;
    }
  });

  test('step catalog list/add/remove', async () => {
    expect(await runWorkflowStepCatalogCommand(['list'])).toBe(0);
    expect(output).toContain('Step Catalog Sources:');
    output = '';
    expect(await runWorkflowStepCommand(['catalog', 'add', 'https://example.com/s.json', '--name', 'mine'])).toBe(0);
    expect(output).toContain('Step catalog source added: https://example.com/s.json');
    output = '';
    expect(await runWorkflowStepCommand(['catalog', 'add', 'https://example.com/s.json'])).toBe(0);
    expect(output).toContain('Step catalog source already configured: https://example.com/s.json');
    output = '';
    expect(await runWorkflowStepCommand(['catalog', 'remove', '0'])).toBe(0);
    expect(output).toContain("Step catalog source 'mine' removed");
    const cfg = parseYaml(readFileSync(configPath(), 'utf-8')) as Dict;
    expect(cfg.catalogs).toEqual([]);
    expect(dumpYaml(cfg)).toBe('catalogs: []\n');
  });
});
