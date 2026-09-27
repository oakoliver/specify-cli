/**
 * Tests for the workflow catalog stack, the workflow registry, and the
 * ``specify workflow catalog`` CLI (ports of upstream TestWorkflowRegistry /
 * TestWorkflowCatalog and tests/specify_cli/workflows/catalog/test_command_*.py).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpResponse } from '../src/authentication/http.js';
import { console as stdoutConsole, errConsole } from '../src/console.js';
import { dumpYaml, parseYaml } from '../src/yaml.js';
import { runWorkflowCatalogCommand } from '../src/workflows/catalog/commands.js';
import {
  catalogLimits,
  httpDeps,
  WorkflowCatalog,
  WorkflowCatalogError,
  WorkflowRegistry,
  WorkflowValidationError,
  type WorkflowCatalogEntry,
} from '../src/workflows/catalog/domain.js';

type Dict = Record<string, unknown>;

let tmp: string;
let projectDir: string;
let prevCwd: string;
let prevHome: string | undefined;
let output: string;
let prevOut: unknown;
let prevErr: unknown;
const realOpenUrl = httpDeps.openUrl;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wf-catalog-'));
  projectDir = join(tmp, 'proj');
  mkdirSync(join(projectDir, '.specify', 'workflows'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectDir);
  prevHome = process.env.HOME;
  process.env.HOME = join(tmp, 'home');
  delete process.env.SPECKIT_WORKFLOW_CATALOG_URL;
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
  rmSync(tmp, { recursive: true, force: true });
});

const configPath = (): string => join(projectDir, '.specify', 'workflow-catalogs.yml');

function entry(url = 'https://example.com/catalog.json'): WorkflowCatalogEntry {
  return { url, name: 'test', priority: 1, install_allowed: true, description: '' };
}

/** Minimal fake HTTP response for the injected ``openUrl``. */
function fakeResponse(body: string | Uint8Array, finalUrl: string): HttpResponse {
  const resp = new Response(typeof body === 'string' ? body : Buffer.from(body));
  return new HttpResponse(resp, finalUrl);
}

// ============================================================================
// WorkflowRegistry
// ============================================================================

describe('WorkflowRegistry', () => {
  test('add/get/list/remove/persistence', () => {
    const registry = new WorkflowRegistry(projectDir);
    registry.add('test-wf', { name: 'Test', version: '1.0.0' });
    const got = registry.get('test-wf') as Dict;
    expect(got.name).toBe('Test');
    expect(typeof got.installed_at).toBe('string');
    expect(got.installed_at as string).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}\+00:00$/);
    registry.add('wf-b', { name: 'B' });
    expect(Object.keys(registry.list())).toEqual(['test-wf', 'wf-b']);
    expect(new WorkflowRegistry(projectDir).isInstalled('test-wf')).toBe(true);
    expect(registry.remove('test-wf')).toBe(true);
    expect(registry.isInstalled('test-wf')).toBe(false);
    expect(registry.remove('missing')).toBe(false);
  });

  test('keeps installed_at on update and survives non-dict entries', () => {
    const registry = new WorkflowRegistry(projectDir);
    registry.add('wf', { name: 'A' });
    const first = (registry.get('wf') as Dict).installed_at;
    registry.add('wf', { name: 'A2' });
    expect((registry.get('wf') as Dict).installed_at).toBe(first);
    registry.data.workflows.bad = 'corrupt';
    registry.add('bad', { name: 'fixed' });
    expect((registry.get('bad') as Dict).name).toBe('fixed');
  });

  test('corrupt contents fail closed', () => {
    const p = join(projectDir, '.specify/workflows/workflow-registry.json');
    for (const [body, fragment] of [
      ['{not json', 'is corrupted'],
      ['[]', 'top-level value must be an object'],
      ['{"workflows": []}', "'workflows' must be an object"],
    ]) {
      writeFileSync(p, body);
      expect(() => new WorkflowRegistry(projectDir)).toThrow(fragment);
    }
  });

  test('symlinked workflows dir fails closed', () => {
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'workflow-registry.json'), JSON.stringify({ schema_version: '1.0', workflows: { evil: {} } }));
    rmSync(join(projectDir, '.specify/workflows'), { recursive: true });
    symlinkSync(outside, join(projectDir, '.specify/workflows'));
    expect(() => new WorkflowRegistry(projectDir)).toThrow(/symlink/);
  });

  test('save preserves existing mode and uses 0600 for new registries', () => {
    const registry = new WorkflowRegistry(projectDir);
    registry.add('a', { name: 'A' });
    expect(statSync(registry.registryPath).mode & 0o777).toBe(0o600);
    chmodSync(registry.registryPath, 0o644);
    registry.add('b', { name: 'B' });
    expect(statSync(registry.registryPath).mode & 0o777).toBe(0o644);
  });

  test('remove rolls back in memory when save fails', () => {
    const registry = new WorkflowRegistry(projectDir);
    registry.add('test-wf', { name: 'Test' });
    const original = registry.save.bind(registry);
    registry.save = () => {
      throw new Error('save failed');
    };
    expect(() => registry.remove('test-wf')).toThrow('save failed');
    expect(registry.isInstalled('test-wf')).toBe(true);
    expect(() => registry.add('other', { name: 'x' })).toThrow('save failed');
    expect(registry.isInstalled('other')).toBe(false);
    registry.save = original;
    expect(new WorkflowRegistry(projectDir).isInstalled('test-wf')).toBe(true);
  });
});

// ============================================================================
// WorkflowCatalog config resolution
// ============================================================================

describe('WorkflowCatalog config', () => {
  test('defaults, env override, project config', () => {
    const catalog = new WorkflowCatalog(projectDir);
    const defaults = catalog.getActiveCatalogs();
    expect(defaults.map((e) => e.name)).toEqual(['default', 'community']);
    expect(defaults[0].url).toBe('https://raw.githubusercontent.com/github/spec-kit/main/workflows/catalog.json');
    expect(defaults[1].install_allowed).toBe(false);

    process.env.SPECKIT_WORKFLOW_CATALOG_URL = 'https://example.com/catalog.json';
    const env = catalog.getActiveCatalogs();
    expect(env).toEqual([
      {
        url: 'https://example.com/catalog.json',
        name: 'env-override',
        priority: 1,
        install_allowed: true,
        description: 'From SPECKIT_WORKFLOW_CATALOG_URL',
      },
    ]);
    delete process.env.SPECKIT_WORKFLOW_CATALOG_URL;

    writeFileSync(
      configPath(),
      dumpYaml({ catalogs: [{ name: 'custom', url: 'https://example.com/wf.json', priority: 1, install_allowed: true }] }),
    );
    expect(catalog.getActiveCatalogs().map((e) => e.name)).toEqual(['custom']);
  });

  test('user-level config is used when no project config', () => {
    mkdirSync(join(tmp, 'home', '.specify'), { recursive: true });
    writeFileSync(
      join(tmp, 'home', '.specify', 'workflow-catalogs.yml'),
      dumpYaml({ catalogs: [{ name: 'user', url: 'https://u.example.com/c.json', install_allowed: 'yes' }] }),
    );
    const [e] = new WorkflowCatalog(projectDir).getActiveCatalogs();
    expect(e.name).toBe('user');
    expect(e.install_allowed).toBe(true);
    expect(e.priority).toBe(1);
  });

  test('shape errors vs no-ops', () => {
    const catalog = new WorkflowCatalog(projectDir);
    for (const body of ['[]\n', 'false\n', '0\n', "''\n"]) {
      writeFileSync(configPath(), body);
      expect(() => catalog.loadCatalogConfig(configPath())).toThrow(/expected a mapping/);
    }
    for (const body of ['catalogs: {}\n', "catalogs: ''\n", 'catalogs: 0\n', 'catalogs: false\n']) {
      writeFileSync(configPath(), body);
      expect(() => catalog.loadCatalogConfig(configPath())).toThrow(/'catalogs' must be a list/);
    }
    for (const body of ['catalogs:\n', 'catalogs: []\n', '', '# only a comment\n', 'null\n', '~\n']) {
      writeFileSync(configPath(), body);
      expect(catalog.loadCatalogConfig(configPath())).toBeNull();
    }
    writeFileSync(configPath(), '[1, 2]\n');
    expect(() => catalog.loadCatalogConfig(configPath())).toThrow('Invalid catalog config: expected a mapping, got list');
    writeFileSync(configPath(), 'catalogs: [5]\n');
    expect(() => catalog.loadCatalogConfig(configPath())).toThrow('Invalid catalog entry at index 0: expected a mapping, got int');
    writeFileSync(configPath(), dumpYaml({ catalogs: [{ name: 'x', url: '' }] }));
    expect(() => catalog.loadCatalogConfig(configPath())).toThrow('entries but none have valid URLs.');
  });

  test('bool / inf priorities rejected', () => {
    for (const bad of ['true', 'false', '.inf']) {
      writeFileSync(configPath(), `catalogs:\n- name: bad\n  url: https://example.com/c.json\n  priority: ${bad}\n`);
      expect(() => new WorkflowCatalog(projectDir).getActiveCatalogs()).toThrow(WorkflowValidationError);
    }
    writeFileSync(configPath(), 'catalogs:\n- name: bad\n  url: https://example.com/c.json\n  priority: true\n');
    expect(() => new WorkflowCatalog(projectDir).getActiveCatalogs()).toThrow(
      "Invalid priority for catalog 'bad': expected integer, got True",
    );
  });

  test('entries sorted by priority', () => {
    writeFileSync(
      configPath(),
      dumpYaml({
        catalogs: [
          { name: 'b', url: 'https://b.example.com/c.json', priority: 5 },
          { name: 'a', url: 'https://a.example.com/c.json', priority: '2' },
        ],
      }),
    );
    expect(new WorkflowCatalog(projectDir).getActiveCatalogs().map((e) => [e.name, e.priority])).toEqual([
      ['a', 2],
      ['b', 5],
    ]);
  });

  test('url validation', () => {
    const catalog = new WorkflowCatalog(projectDir);
    expect(() => catalog.validateCatalogUrl('http://evil.com/catalog.json')).toThrow(
      'Catalog URL must use HTTPS (got http://). HTTP is only allowed for localhost.',
    );
    catalog.validateCatalogUrl('http://localhost:8080/catalog.json');
    catalog.validateCatalogUrl('http://[::1]:8080/catalog.json');
    for (const url of ['https://[::1', 'https://[not-an-ip]/x', 'https://example.com:notaport/catalog.json']) {
      expect(() => catalog.validateCatalogUrl(url)).toThrow(`Catalog URL is malformed: ${url}`);
    }
    expect(() => catalog.validateCatalogUrl('https:///path')).toThrow('Catalog URL must be a valid URL with a host.');
    expect(() => catalog.validateCatalogUrl('not a url')).toThrow('(got ://)');
  });
});

// ============================================================================
// add / remove
// ============================================================================

describe('WorkflowCatalog add/remove', () => {
  test('add catalog and derive priority', () => {
    const catalog = new WorkflowCatalog(projectDir);
    expect(catalog.addCatalog('https://example.com/new-catalog.json', 'my-catalog')).toBe('added');
    const data = parseYaml(readFileSync(configPath(), 'utf-8')) as Dict;
    expect(data.catalogs).toEqual([
      { name: 'my-catalog', url: 'https://example.com/new-catalog.json', priority: 1, install_allowed: true, description: '' },
    ]);
    // Written in insertion order (sort_keys=False).
    expect(readFileSync(configPath(), 'utf-8')).toBe(
      'catalogs:\n- name: my-catalog\n  url: https://example.com/new-catalog.json\n  priority: 1\n  install_allowed: true\n  description: \'\'\n',
    );
    catalog.addCatalog('https://example.com/second.json');
    const second = ((parseYaml(readFileSync(configPath(), 'utf-8')) as Dict).catalogs as Dict[])[1];
    expect(second.name).toBe('catalog-2');
    expect(second.priority).toBe(2);
  });

  test('existing inf priority coerces to 0', () => {
    writeFileSync(configPath(), 'catalogs:\n- name: existing\n  url: https://a.example.com/c.json\n  priority: .inf\n');
    new WorkflowCatalog(projectDir).addCatalog('https://b.example.com/c.json', 'new');
    const cats = (parseYaml(readFileSync(configPath(), 'utf-8')) as Dict).catalogs as Dict[];
    expect(cats.find((c) => c.url === 'https://b.example.com/c.json')!.priority).toBe(1);
  });

  test('add is idempotent for the same url (and name)', () => {
    const catalog = new WorkflowCatalog(projectDir);
    expect(catalog.addCatalog('https://example.com/catalog.json', 'mine')).toBe('added');
    const data = parseYaml(readFileSync(configPath(), 'utf-8')) as Dict;
    (data.catalogs as Dict[])[0].url = '  https://example.com/catalog.json  ';
    writeFileSync(configPath(), dumpYaml(data));
    const original = readFileSync(configPath());
    expect(catalog.addCatalog('https://example.com/catalog.json', 'mine')).toBe('unchanged');
    expect(catalog.addCatalog('  https://example.com/catalog.json ')).toBe('unchanged');
    expect(readFileSync(configPath()).equals(original)).toBe(true);
    expect(() => catalog.addCatalog('https://example.com/catalog.json', 'different')).toThrow(
      'Catalog URL already configured: https://example.com/catalog.json',
    );
  });

  test('add rejects malformed / non-mapping configs', () => {
    const catalog = new WorkflowCatalog(projectDir);
    writeFileSync(configPath(), 'catalogs: [\n');
    expect(() => catalog.addCatalog('https://example.com/c.json')).toThrow(/unreadable or malformed/);
    writeFileSync(configPath(), '- a\n');
    expect(() => catalog.addCatalog('https://example.com/c.json')).toThrow('Catalog config file is corrupted (expected a mapping).');
    writeFileSync(configPath(), 'catalogs: 5\n');
    expect(() => catalog.addCatalog('https://example.com/c.json')).toThrow("Catalog config 'catalogs' must be a list.");
    writeFileSync(configPath(), '');
    expect(catalog.addCatalog('https://example.com/c.json')).toBe('added');
  });

  test('remove by index', () => {
    const catalog = new WorkflowCatalog(projectDir);
    expect(() => catalog.removeCatalog(0)).toThrow('No catalog config file found.');
    catalog.addCatalog('https://example.com/c1.json', 'first');
    catalog.addCatalog('https://example.com/c2.json', 'second');
    expect(catalog.removeCatalog(0)).toBe('first');
    expect(() => catalog.removeCatalog(5)).toThrow('Catalog index 5 out of range (0-0).');
    const cats = (parseYaml(readFileSync(configPath(), 'utf-8')) as Dict).catalogs as Dict[];
    expect(cats.map((c) => c.name)).toEqual(['second']);
    for (const body of ['[]\n', 'false\n', '0\n']) {
      writeFileSync(configPath(), body);
      expect(() => catalog.removeCatalog(0)).toThrow('Catalog config file is corrupted (expected a mapping).');
    }
  });

  test('getCatalogConfigs', () => {
    const configs = new WorkflowCatalog(projectDir).getCatalogConfigs();
    expect(configs[0]).toEqual({
      name: 'default',
      url: 'https://raw.githubusercontent.com/github/spec-kit/main/workflows/catalog.json',
      priority: 1,
      install_allowed: true,
      description: 'Official workflows',
    });
  });
});

// ============================================================================
// Fetching / caching / search
// ============================================================================

describe('WorkflowCatalog fetch', () => {
  test('cache metadata must be a mapping', () => {
    const catalog = new WorkflowCatalog(projectDir);
    const [, meta] = catalog.getCachePaths('https://example.com/c.json');
    mkdirSync(catalog.cacheDir, { recursive: true });
    writeFileSync(meta, '[]');
    expect(catalog.isUrlCacheValid('https://example.com/c.json')).toBe(false);
    writeFileSync(meta, JSON.stringify({ fetched_at: Date.now() / 1000 }));
    expect(catalog.isUrlCacheValid('https://example.com/c.json')).toBe(true);
    writeFileSync(meta, JSON.stringify({ fetched_at: Date.now() / 1000 - 7200 }));
    expect(catalog.isUrlCacheValid('https://example.com/c.json')).toBe(false);
  });

  test('fetch writes cache, then serves fresh cache without network', async () => {
    let calls = 0;
    httpDeps.openUrl = (async (url: string) => {
      calls++;
      return fakeResponse(JSON.stringify({ workflows: { speckit: { name: 'SK' } } }), url);
    }) as typeof httpDeps.openUrl;
    const catalog = new WorkflowCatalog(projectDir);
    const data = await catalog.fetchSingleCatalog(entry());
    expect(data).toEqual({ workflows: { speckit: { name: 'SK' } } });
    const [cacheFile, metaFile] = catalog.getCachePaths(entry().url);
    expect(existsSync(cacheFile)).toBe(true);
    expect((JSON.parse(readFileSync(metaFile, 'utf-8')) as Dict).url).toBe(entry().url);
    await catalog.fetchSingleCatalog(entry());
    expect(calls).toBe(1);
    await catalog.fetchSingleCatalog(entry(), true);
    expect(calls).toBe(2);
  });

  test('non-mapping cached catalog is refetched; stale cache is a fallback', async () => {
    const catalog = new WorkflowCatalog(projectDir);
    const [cacheFile, metaFile] = catalog.getCachePaths(entry().url);
    mkdirSync(catalog.cacheDir, { recursive: true });
    writeFileSync(cacheFile, '[1, 2]');
    writeFileSync(metaFile, JSON.stringify({ url: entry().url, fetched_at: Date.now() / 1000 }));
    httpDeps.openUrl = (async (url: string) => fakeResponse('{"workflows": {}}', url)) as typeof httpDeps.openUrl;
    expect(await catalog.fetchSingleCatalog(entry())).toEqual({ workflows: {} });

    httpDeps.openUrl = (async () => {
      throw new Error('network down');
    }) as typeof httpDeps.openUrl;
    // Stale (but valid) cache is used as fallback.
    expect(await catalog.fetchSingleCatalog(entry(), true)).toEqual({ workflows: {} });
    writeFileSync(cacheFile, '[]');
    await expect(catalog.fetchSingleCatalog(entry(), true)).rejects.toThrow(
      'Failed to fetch catalog from https://example.com/catalog.json: network down',
    );
  });

  test('non-object catalog rejected', async () => {
    httpDeps.openUrl = (async (url: string) => fakeResponse('[1]', url)) as typeof httpDeps.openUrl;
    await expect(new WorkflowCatalog(projectDir).fetchSingleCatalog(entry(), true)).rejects.toThrow(
      'Catalog from https://example.com/catalog.json is not a valid JSON object.',
    );
  });

  test('malformed redirect target raises catalog error', async () => {
    httpDeps.openUrl = (async () => fakeResponse('{}', 'https://[::1')) as typeof httpDeps.openUrl;
    await expect(new WorkflowCatalog(projectDir).fetchSingleCatalog(entry(), true)).rejects.toThrow(/malformed/);
  });

  test('every redirect hop is validated', async () => {
    let validator: ((a: string, b: string) => void) | undefined;
    httpDeps.openUrl = (async (_url: string, opts?: { redirectValidator?: (a: string, b: string) => void }) => {
      validator = opts?.redirectValidator;
      validator!('https://good.example/catalog.json', 'http://evil.test/hop');
      throw new Error('redirect_validator should have raised');
    }) as typeof httpDeps.openUrl;
    await expect(
      new WorkflowCatalog(projectDir).fetchSingleCatalog(entry('https://good.example/catalog.json'), true),
    ).rejects.toThrow(/HTTPS/);
    expect(validator).toBeDefined();
  });

  test('oversized catalog response rejected and not cached', async () => {
    const prev = catalogLimits.maxJsonCatalogBytes;
    catalogLimits.maxJsonCatalogBytes = 32;
    try {
      httpDeps.openUrl = (async (url: string) => fakeResponse('x'.repeat(64), url)) as typeof httpDeps.openUrl;
      const catalog = new WorkflowCatalog(projectDir);
      await expect(catalog.fetchSingleCatalog(entry(), true)).rejects.toThrow(/exceeds maximum size/);
      expect(existsSync(catalog.cacheDir)).toBe(false);
    } finally {
      catalogLimits.maxJsonCatalogBytes = prev;
    }
  });

  test('merge: lower priority number wins; list + dict formats; search filters', async () => {
    writeFileSync(
      configPath(),
      dumpYaml({
        catalogs: [
          { name: 'primary', url: 'https://a.example.com/c.json', priority: 1, install_allowed: true },
          { name: 'secondary', url: 'https://b.example.com/c.json', priority: 2, install_allowed: false },
        ],
      }),
    );
    httpDeps.openUrl = (async (url: string) => {
      if (url.startsWith('https://a.')) {
        return fakeResponse(JSON.stringify({ workflows: { shared: { name: 'From A', tags: ['Docs'], author: 'Alice' } } }), url);
      }
      return fakeResponse(
        JSON.stringify({
          workflows: [
            { id: 'shared', name: 'From B' },
            { id: 'only-b', name: 'Only B', description: 'bugfix helper' },
            { name: 'no id' },
          ],
        }),
        url,
      );
    }) as typeof httpDeps.openUrl;
    const catalog = new WorkflowCatalog(projectDir);
    const all = await catalog.search();
    expect(all.map((w) => [w.id, w.name, w._catalog_name, w._install_allowed])).toEqual([
      ['shared', 'From A', 'primary', true],
      ['only-b', 'Only B', 'secondary', false],
    ]);
    expect((await catalog.search({ query: 'BUGFIX' })).map((w) => w.id)).toEqual(['only-b']);
    expect((await catalog.search({ tag: 'docs' })).map((w) => w.id)).toEqual(['shared']);
    expect((await catalog.search({ author: 'alice' })).map((w) => w.id)).toEqual(['shared']);
    expect((await catalog.getWorkflowInfo('only-b'))!.name).toBe('Only B');
    expect(await catalog.getWorkflowInfo('missing')).toBeNull();
  });

  test('all catalogs failing raises', async () => {
    httpDeps.openUrl = (async () => {
      throw new Error('boom');
    }) as typeof httpDeps.openUrl;
    await expect(new WorkflowCatalog(projectDir).search()).rejects.toThrow(
      new WorkflowCatalogError('All configured catalogs failed to fetch.'),
    );
  });
});

// ============================================================================
// CLI
// ============================================================================

describe('specify workflow catalog', () => {
  test('list shows defaults', async () => {
    expect(await runWorkflowCatalogCommand(['list'])).toBe(0);
    expect(output).toContain('Workflow Catalog Sources:');
    expect(output).toContain('[0] default — install allowed');
    expect(output).toContain('[1] community — discovery only');
    expect(output).toContain('Community-contributed workflows (discovery only)');
  });

  test('list reports config errors', async () => {
    writeFileSync(configPath(), '[]\n');
    expect(await runWorkflowCatalogCommand(['list'])).toBe(1);
    expect(output).toContain('Error: Invalid catalog config: expected a mapping, got list');
  });

  test('add, add again (idempotent), conflicting name, remove', async () => {
    expect(await runWorkflowCatalogCommand(['add', 'https://example.com/c.json', '--name', 'mine'])).toBe(0);
    expect(output).toContain('Catalog source added: https://example.com/c.json');
    output = '';
    expect(await runWorkflowCatalogCommand(['add', 'https://example.com/c.json'])).toBe(0);
    expect(output).toContain('Catalog source already configured: https://example.com/c.json');
    output = '';
    expect(await runWorkflowCatalogCommand(['add', 'https://example.com/c.json', '--name=other'])).toBe(1);
    expect(output).toContain('Error: Catalog URL already configured: https://example.com/c.json');
    output = '';
    expect(await runWorkflowCatalogCommand(['add', 'http://evil.com/c.json'])).toBe(1);
    expect(output).toContain('Catalog URL must use HTTPS');
    output = '';
    expect(await runWorkflowCatalogCommand(['remove', '0'])).toBe(0);
    expect(output).toContain("Catalog source 'mine' removed");
    output = '';
    expect(await runWorkflowCatalogCommand(['remove', '3'])).toBe(1);
    expect(output).toContain('Catalog index 3 out of range');
  });

  test('usage errors', async () => {
    expect(await runWorkflowCatalogCommand(['remove', 'abc'])).toBe(2);
    expect(output).toContain("'abc' is not a valid int");
    expect(await runWorkflowCatalogCommand(['nope'])).toBe(2);
    expect(await runWorkflowCatalogCommand(['--help'])).toBe(0);
    expect(output).toContain('Manage workflow catalogs');
  });
});
