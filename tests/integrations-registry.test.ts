/**
 * Tests for the integration registry, IntegrationCatalog and
 * IntegrationDescriptor (port of integrations/__init__.py).
 *
 * Ports key cases from upstream tests/integrations/test_registry.py,
 * tests/test_integration_catalog.py and descriptor validation tests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  INTEGRATION_REGISTRY,
  IntegrationCatalog,
  IntegrationCatalogError,
  IntegrationDescriptor,
  IntegrationDescriptorError,
  IntegrationValidationError,
  MarkdownIntegration,
  catalogShapeError,
  getIntegration,
  register,
} from '../src/integrations/index.js';
import { CommandRegistrar } from '../src/agents.js';

let tmp: string;
let home: string;
const savedHome = process.env.HOME;
const savedCatalogEnv = process.env.SPECKIT_INTEGRATION_CATALOG_URL;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-reg-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-home-')));
  process.env.HOME = home;
  delete process.env.SPECKIT_INTEGRATION_CATALOG_URL;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  process.env.HOME = savedHome;
  if (savedCatalogEnv === undefined) delete process.env.SPECKIT_INTEGRATION_CATALOG_URL;
  else process.env.SPECKIT_INTEGRATION_CATALOG_URL = savedCatalogEnv;
});

// ============================================================================
// Registry mechanics
// ============================================================================

const ALL_KEYS = [
  'agy', 'alquimia', 'amp', 'auggie', 'bob', 'claude', 'cline', 'codebuddy', 'codex', 'command-code',
  'copilot', 'cursor-agent', 'devin', 'docker-agent', 'droid', 'dsh', 'firebender', 'forge', 'gemini',
  'generic', 'goose', 'grok', 'hermes', 'junie', 'kilocode', 'kimi', 'kiro-cli', 'lingma', 'muse', 'omp',
  'opencode', 'pi', 'qodercli', 'qwen', 'rovodev', 'shai', 'tabnine', 'trae', 'vibe', 'zcode', 'zed',
];

describe('INTEGRATION_REGISTRY', () => {
  test('all 41 upstream integrations registered in order', () => {
    expect(Object.keys(INTEGRATION_REGISTRY)).toEqual(ALL_KEYS);
  });

  test('retired integrations are gone', () => {
    for (const key of ['roo', 'windsurf', 'iflow', 'cursor', 'jules', 'kiro']) {
      expect(getIntegration(key)).toBeNull();
    }
  });

  test('get missing returns null', () => {
    expect(getIntegration('nonexistent')).toBeNull();
    expect(getIntegration('constructor')).toBeNull();
  });

  test('register rejects empty and duplicate keys', () => {
    class Stub extends MarkdownIntegration {
      key = '';
    }
    expect(() => register(new Stub())).toThrow('Cannot register integration with an empty key.');
    class Dup extends MarkdownIntegration {
      key = 'claude';
    }
    expect(() => register(new Dup())).toThrow("Integration with key 'claude' is already registered.");
  });

  test('every non-generic integration is in the registrar', () => {
    for (const key of ALL_KEYS.filter((k) => k !== 'generic')) {
      expect(key in CommandRegistrar.AGENT_CONFIGS).toBe(true);
    }
  });

  test('registrar_config dir matches config folder + commands_subdir', () => {
    for (const [key, integ] of Object.entries(INTEGRATION_REGISTRY)) {
      if (key === 'generic' || key === 'hermes' || key === 'bob' || key === 'copilot') continue;
      const folder = integ.config!.folder!.replace(/\/+$/, '');
      expect({ key, dir: integ.registrarConfig!.dir }).toEqual({ key, dir: `${folder}/${integ.config!.commands_subdir}` });
    }
  });
});

describe('multi_install_safe invariants', () => {
  const safe = Object.entries(INTEGRATION_REGISTRY).filter(([, i]) => i.multiInstallSafe);
  const rootOf = (k: string) => INTEGRATION_REGISTRY[k].config!.folder!.replace(/\/+$/, '');
  const cmdDirOf = (k: string) => INTEGRATION_REGISTRY[k].registrarConfig!.dir.replace(/\/+$/, '');

  test('safe integrations have static isolated paths', () => {
    expect(safe.length).toBeGreaterThan(20);
    for (const [key, integ] of safe) {
      expect(integ.config?.folder).toBeTruthy();
      expect(integ.registrarConfig?.dir.startsWith('~')).toBe(false);
      expect(cmdDirOf(key).startsWith(rootOf(key) + '/')).toBe(true);
    }
  });

  test('safe integrations have distinct agent roots and command dirs', () => {
    const roots = safe.map(([k]) => rootOf(k));
    const dirs = safe.map(([k]) => cmdDirOf(k));
    expect(new Set(roots).size).toBe(roots.length);
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  test('shared .agents/ integrations are not multi-install safe except codex', () => {
    for (const key of ['muse', 'docker-agent', 'zed', 'agy', 'amp']) {
      expect(INTEGRATION_REGISTRY[key].multiInstallSafe).toBe(false);
    }
    expect(INTEGRATION_REGISTRY['kiro-cli'].multiInstallSafe).toBe(true);
  });
});

// ============================================================================
// IntegrationCatalog
// ============================================================================

function catalogDoc(integrations: Record<string, unknown>): string {
  return JSON.stringify({ schema_version: '1.0', integrations });
}

function fakeFetcher(docs: Record<string, string | { status: number }>, calls: string[] = []) {
  return async (url: string): Promise<Response> => {
    calls.push(url);
    const doc = docs[url];
    if (doc === undefined) throw new TypeError('fetch failed');
    if (typeof doc !== 'string') return new Response('', { status: doc.status, statusText: 'Not Found' });
    return new Response(doc, { status: 200 });
  };
}

describe('IntegrationCatalog', () => {
  test('default active catalogs', () => {
    const cat = new IntegrationCatalog(tmp);
    expect(cat.getCatalogConfigs()).toEqual([
      {
        name: 'default',
        url: IntegrationCatalog.DEFAULT_CATALOG_URL,
        priority: 1,
        install_allowed: true,
        description: 'Built-in catalog of installable integrations',
      },
      {
        name: 'community',
        url: IntegrationCatalog.COMMUNITY_CATALOG_URL,
        priority: 2,
        install_allowed: false,
        description: 'Community-contributed integrations (discovery only)',
      },
    ]);
  });

  test('env var override and validation', () => {
    process.env.SPECKIT_INTEGRATION_CATALOG_URL = 'http://example.com/c.json';
    expect(() => new IntegrationCatalog(tmp).getActiveCatalogs()).toThrow(/must use HTTPS/);
    process.env.SPECKIT_INTEGRATION_CATALOG_URL = 'http://localhost:8080/c.json';
    const entries = new IntegrationCatalog(tmp).getActiveCatalogs();
    expect(entries.map((e) => [e.name, e.url])).toEqual([['custom', 'http://localhost:8080/c.json']]);
  });

  test('URL validation', () => {
    expect(() => IntegrationCatalog.validateCatalogUrl('https://:8080/x')).toThrow('Catalog URL must be a valid URL with a host.');
    expect(() => IntegrationCatalog.validateCatalogUrl('https://example.com:notaport/x')).toThrow(/malformed/);
    expect(() => IntegrationCatalog.validateCatalogUrl('ftp://example.com/x')).toThrow(/got ftp:\/\//);
    IntegrationCatalog.validateCatalogUrl('https://example.com/x');
  });

  test('add / list / remove catalogs (display order by priority)', () => {
    const cat = new IntegrationCatalog(tmp);
    expect(cat.addCatalog(' https://a.example.com/c.json ')).toBe('added');
    expect(cat.addCatalog('https://b.example.com/c.json', 'bee')).toBe('added');
    expect(cat.addCatalog('https://a.example.com/c.json')).toBe('unchanged');
    expect(() => cat.addCatalog('https://a.example.com/c.json', 'other')).toThrow('Catalog URL already configured');
    const cfgPath = join(tmp, '.specify', 'integration-catalogs.yml');
    expect(readFileSync(cfgPath, 'utf-8')).toBe(
      'catalogs:\n- name: catalog-1\n  url: https://a.example.com/c.json\n  priority: 1\n  install_allowed: true\n  description: \'\'\n' +
        '- name: bee\n  url: https://b.example.com/c.json\n  priority: 2\n  install_allowed: true\n  description: \'\'\n',
    );
    expect(cat.getProjectCatalogConfigs()!.map((c) => c.name)).toEqual(['catalog-1', 'bee']);
    expect(() => cat.removeCatalog(5)).toThrow('Catalog index 5 out of range (0-1).');
    expect(cat.removeCatalog(1)).toBe('bee');
    expect(cat.removeCatalog(0)).toBe('catalog-1');
    expect(existsSync(cfgPath)).toBe(false);
    expect(() => cat.removeCatalog(0)).toThrow('No catalog config file found.');
  });

  test('corrupt config fails closed', () => {
    mkdirSync(join(tmp, '.specify'), { recursive: true });
    const cfgPath = join(tmp, '.specify', 'integration-catalogs.yml');
    writeFileSync(cfgPath, 'catalogs: []\n');
    expect(() => new IntegrationCatalog(tmp).getActiveCatalogs()).toThrow(IntegrationValidationError);
    writeFileSync(cfgPath, 'catalogs:\n  - url: https://x.example.com/c.json\n    priority: true\n');
    expect(() => new IntegrationCatalog(tmp).getActiveCatalogs()).toThrow(/expected integer, got True/);
    writeFileSync(cfgPath, '- a\n');
    expect(() => new IntegrationCatalog(tmp).getActiveCatalogs()).toThrow(/expected a YAML mapping at the root/);
  });

  test('fetch, merge (first wins), cache, search and info', async () => {
    mkdirSync(join(tmp, '.specify'), { recursive: true });
    writeFileSync(
      join(tmp, '.specify', 'integration-catalogs.yml'),
      'catalogs:\n  - name: one\n    url: https://one.example.com/c.json\n    priority: 1\n    install_allowed: true\n' +
        '  - name: two\n    url: https://two.example.com/c.json\n    priority: 2\n',
    );
    const calls: string[] = [];
    const cat = new IntegrationCatalog(tmp);
    cat.fetcher = fakeFetcher(
      {
        'https://one.example.com/c.json': catalogDoc({ foo: { name: 'Foo Agent', tags: ['cli'], author: 'Acme' } }),
        'https://two.example.com/c.json': catalogDoc({ foo: { name: 'Shadowed' }, bar: { name: 'Bar', description: 'IDE thing' } }),
      },
      calls,
    );
    const merged = await cat.getMergedIntegrations();
    expect(merged).toEqual([
      { name: 'Foo Agent', tags: ['cli'], author: 'Acme', id: 'foo', _catalog_name: 'one', _install_allowed: true },
      { name: 'Bar', description: 'IDE thing', id: 'bar', _catalog_name: 'two', _install_allowed: false },
    ]);
    expect(calls.length).toBe(2);
    await cat.getMergedIntegrations();
    expect(calls.length).toBe(2); // served from cache
    expect((await cat.search('ide')).map((i) => i.id)).toEqual(['bar']);
    expect((await cat.search(null, 'CLI')).map((i) => i.id)).toEqual(['foo']);
    expect((await cat.search(null, null, 'acme')).map((i) => i.id)).toEqual(['foo']);
    expect((await cat.getIntegrationInfo('bar'))?.name).toBe('Bar');
    expect(await cat.getIntegrationInfo('nope')).toBeNull();
    cat.clearCache();
    await cat.getMergedIntegrations();
    expect(calls.length).toBe(4);
  });

  test('poisoned cache is dropped and refetched', async () => {
    const cat = new IntegrationCatalog(tmp);
    process.env.SPECKIT_INTEGRATION_CATALOG_URL = IntegrationCatalog.DEFAULT_CATALOG_URL;
    const calls: string[] = [];
    cat.fetcher = fakeFetcher({ [IntegrationCatalog.DEFAULT_CATALOG_URL]: catalogDoc({ a: {} }) }, calls);
    await cat.getMergedIntegrations();
    const cacheFile = join(cat.cacheDir, readdirJson(cat.cacheDir).find((f) => !f.includes('metadata'))!);
    writeFileSync(cacheFile, '[]');
    await cat.getMergedIntegrations();
    expect(calls.length).toBe(2);
  });

  test('errors: bad shape, HTTP error, all catalogs failing', async () => {
    const cat = new IntegrationCatalog(tmp);
    const entry = cat.getActiveCatalogs()[0];
    cat.fetcher = fakeFetcher({ [entry.url]: JSON.stringify({ integrations: [] }) });
    await expect(cat.fetchSingleCatalog(entry, true)).rejects.toThrow(
      `Invalid catalog format from ${entry.url}: missing required 'schema_version' or 'integrations' key`,
    );
    cat.fetcher = fakeFetcher({ [entry.url]: { status: 404 } });
    await expect(cat.fetchSingleCatalog(entry, true)).rejects.toThrow(`Failed to fetch catalog from ${entry.url}: HTTP Error 404`);
    cat.fetcher = fakeFetcher({});
    await expect(cat.getMergedIntegrations(true)).rejects.toThrow('Failed to fetch any integration catalog');
    cat.fetcher = fakeFetcher({ [entry.url]: 'not json' });
    await expect(cat.fetchSingleCatalog(entry, true)).rejects.toThrow(IntegrationCatalogError);
  });

  test('catalogShapeError', () => {
    expect(catalogShapeError([])).toBe('expected a JSON object');
    expect(catalogShapeError({ schema_version: '1', integrations: [] })).toBe("'integrations' must be a JSON object");
    expect(catalogShapeError({ schema_version: '1', integrations: {} })).toBeNull();
  });
});

function readdirJson(dir: string): string[] {
  return readdirSync(dir);
}

// ============================================================================
// IntegrationDescriptor
// ============================================================================

const VALID = `schema_version: "1.0"
integration:
  id: my-agent
  name: My Agent
  version: 1.0.0
  description: Integration for My Agent
requires:
  speckit_version: ">=0.6.0"
  tools:
    - name: my-agent
provides:
  commands:
    - name: speckit.my-agent.run
      file: commands/run.md
  scripts:
    - scripts/setup.sh
`;

describe('IntegrationDescriptor', () => {
  function write(text: string): string {
    const p = join(tmp, 'integration.yml');
    writeFileSync(p, text);
    return p;
  }

  test('valid descriptor accessors and hash', () => {
    const d = new IntegrationDescriptor(write(VALID));
    expect([d.id, d.name, d.version, d.description, d.requiresSpeckitVersion]).toEqual([
      'my-agent',
      'My Agent',
      '1.0.0',
      'Integration for My Agent',
      '>=0.6.0',
    ]);
    expect(d.commands).toEqual([{ name: 'speckit.my-agent.run', file: 'commands/run.md' }]);
    expect(d.scripts).toEqual(['scripts/setup.sh']);
    expect(d.tools).toEqual([{ name: 'my-agent' }]);
    expect(d.getHash()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  const cases: Array<[string, string, RegExp | string]> = [
    ['missing file', '', 'Descriptor not found'],
    ['empty document', ' \n', 'Missing required field: schema_version'],
    ['null document', 'null\n', 'Descriptor root must be a YAML mapping, got NoneType'],
    ['list root', '- a\n', 'Descriptor root must be a YAML mapping, got list'],
    ['bad yaml', 'a: [\n', /Invalid YAML in/],
    ['schema', VALID.replace('"1.0"', '"2.0"'), 'Unsupported schema version: 2.0 (expected 1.0)'],
    ['bad id', VALID.replace('id: my-agent', 'id: My_Agent'), "Invalid integration ID 'My_Agent'"],
    ['bad version', VALID.replace('version: 1.0.0', 'version: not-a-version'), "Invalid version 'not-a-version'"],
    ['int field', VALID.replace('name: My Agent', 'name: 5'), 'integration.name must be a string, got int'],
    ['empty speckit', VALID.replace('">=0.6.0"', '"  "'), 'requires.speckit_version must be a non-empty string'],
    ['tools not list', VALID.replace('  tools:\n    - name: my-agent\n', '  tools: x\n'), 'requires.tools must be a list'],
    ['traversal cmd', VALID.replace('file: commands/run.md', 'file: ../run.md'), "Command entry 'file' must be a relative path without '..': ../run.md"],
    ['abs script', VALID.replace('- scripts/setup.sh', '- /etc/x.sh'), "Script entry must be a relative path without '..': /etc/x.sh"],
    [
      'nothing provided',
      VALID.replace(/provides:[\s\S]*$/, 'provides:\n  commands: []\n'),
      'Integration must provide at least one command or script',
    ],
  ];
  for (const [name, text, err] of cases) {
    test(`rejects: ${name}`, () => {
      const p = name === 'missing file' ? join(tmp, 'missing.yml') : write(text);
      expect(() => new IntegrationDescriptor(p)).toThrow(IntegrationDescriptorError);
      expect(() => new IntegrationDescriptor(p)).toThrow(err);
    });
  }
});
