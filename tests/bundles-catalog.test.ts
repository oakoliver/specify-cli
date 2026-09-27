/**
 * Bundle catalogs: payload/entry parsing, source stack, project config, stack
 * precedence. Ports of tests/contract/test_catalog_schema.py,
 * tests/specify_cli/bundles/{test_catalog_config,test_catalog_stack}.py.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { BundlerError } from '../src/bundles/index.js';
import {
  BUILTIN_DEFAULT_STACK,
  CatalogEntry,
  CatalogSource,
  InstallPolicy,
  Scope,
  loadCatalogPayload,
  loadSourceStack,
} from '../src/bundles/catalogs.js';
import * as cc from '../src/bundles/catalog-config.js';
import { CatalogStack } from '../src/bundles/catalog-stack.js';
import { catalogEntryDict, catalogPayload } from './bundles-helpers.js';

let tmp: string;
let cwd: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'bundles-catalog-')));
  cwd = process.cwd();
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

async function rejects(p: Promise<unknown>, match: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (exc) {
    caught = exc;
  }
  expect(caught).toBeInstanceOf(BundlerError);
  expect((caught as Error).message).toContain(match);
}

function project(): string {
  const p = path.join(tmp, 'proj');
  mkdirSync(path.join(p, '.specify'), { recursive: true });
  return p;
}

function writeConfig(root: string, body: string): void {
  writeFileSync(path.join(root, '.specify', 'bundle-catalogs.yml'), body, 'utf-8');
}

// ============================================================================
// Catalog schema contract
// ============================================================================

describe('catalog schema', () => {
  test('non-integer source priority', () => {
    expect(() =>
      CatalogSource.fromDict({ id: 'x', url: 'https://e.com/c.json', priority: 'high', install_policy: 'install-allowed' }, Scope.PROJECT),
    ).toThrow("Catalog source 'x' has a non-integer priority: 'high'.");
    expect(() =>
      CatalogSource.fromDict({ id: 'x', url: 'u', priority: true, install_policy: 'install-allowed' }, Scope.PROJECT),
    ).toThrow('non-integer priority: True');
  });

  test('invalid install policy message', () => {
    expect(() => CatalogSource.fromDict({ id: 'x', url: 'u', priority: 1, install_policy: 'nope' }, Scope.PROJECT)).toThrow(
      "Invalid install_policy 'nope' (must be one of ['install-allowed', 'discovery-only']).",
    );
  });

  test('builtin default stack when no config', () => {
    const stack = loadSourceStack(project());
    expect(stack.map((s) => [s.id, s.priority, s.install_policy, s.scope])).toEqual([
      ['default', 1, 'install-allowed', 'built-in'],
      ['community', 20, 'discovery-only', 'built-in'],
    ]);
    expect(BUILTIN_DEFAULT_STACK.map((s) => s.url)).toEqual(['builtin://default', 'builtin://community']);
  });

  test.each([['catalogs: 5\n'], ['catalogs: false\n'], ['catalogs: 0\n'], ["catalogs: ''\n"], ['catalogs: {}\n']])(
    'non-list catalogs raises (%p)',
    (body) => {
      const root = project();
      writeConfig(root, body);
      expect(() => loadSourceStack(root)).toThrow("'catalogs' must be a list");
    },
  );

  test.each([['[]\n'], ['- a\n'], ['false\n'], ['0\n'], ["''\n"], ['null\n']])('top-level non-mapping raises (%p)', (body) => {
    const root = project();
    writeConfig(root, body);
    expect(() => loadSourceStack(root)).toThrow('expected a mapping at the top level');
  });

  test.each([[''], ['catalogs:\n'], ['catalogs: []\n'], ['# comment only\n']])('absent/empty catalogs is a no-op (%p)', (body) => {
    const root = project();
    writeConfig(root, body);
    expect(loadSourceStack(root).map((s) => s.id)).toEqual(['default', 'community']);
  });

  test('unsupported config schema version', () => {
    const root = project();
    writeConfig(root, 'schema_version: "2.0"\ncatalogs: []\n');
    expect(() => loadSourceStack(root)).toThrow("Unsupported catalog config schema version '2.0'");
    writeConfig(root, 'schema_version: "1.3"\ncatalogs: []\n');
    expect(loadSourceStack(root)).toHaveLength(2);
  });

  test('project config overrides same id; user scope sits between', () => {
    const root = project();
    const userDir = path.join(tmp, 'user');
    mkdirSync(userDir);
    writeFileSync(
      path.join(userDir, 'bundle-catalogs.yml'),
      'catalogs:\n  - id: team\n    url: https://user.example/c.json\n    priority: 5\n    install_policy: discovery-only\n' +
        '  - id: community\n    url: https://user.example/comm.json\n    priority: 20\n    install_policy: discovery-only\n',
    );
    writeConfig(
      root,
      'catalogs:\n  - id: team\n    url: https://proj.example/c.json\n    priority: 3\n    install_policy: install-allowed\n',
    );
    const stack = loadSourceStack(root, userDir);
    expect(stack.map((s) => [s.id, s.scope])).toEqual([
      ['default', 'built-in'],
      ['team', 'project'],
      ['community', 'user'],
    ]);
    expect(stack[1].url).toBe('https://proj.example/c.json');
  });

  test('load payload parses entries', () => {
    const entries = loadCatalogPayload(catalogPayload({ b: catalogEntryDict('b', { tags: ['x'] }) }));
    const entry = entries.get('b')!;
    expect(entry.name).toBe('Demo Bundle');
    expect(entry.requires_speckit_version).toBe('>=0.1.0');
    expect(entry.tags).toEqual(['x']);
    expect(entry.verified).toBe(true);
  });

  test('entry rejects bad tags / verified / requires / provides', () => {
    expect(() => CatalogEntry.fromDict(catalogEntryDict('b', { tags: 'x' }))).toThrow("Catalog entry 'b': 'tags' must be a list of strings.");
    expect(() => CatalogEntry.fromDict(catalogEntryDict('b', { tags: ['x', 1] }))).toThrow("'tags' must be a list of strings");
    expect(() => CatalogEntry.fromDict(catalogEntryDict('b', { verified: 'false' }))).toThrow(
      "Catalog entry 'b': 'verified' must be a boolean (true/false).",
    );
    for (const bad of [[], '', 0, false]) {
      expect(() => CatalogEntry.fromDict(catalogEntryDict('b', { requires: bad }))).toThrow("'requires' must be a mapping");
      expect(() => CatalogEntry.fromDict(catalogEntryDict('b', { provides: bad }))).toThrow("'provides' must be a mapping");
    }
  });

  test('sha256 preserved through provenance', () => {
    const entry = CatalogEntry.fromDict(catalogEntryDict('b', { sha256: ' abc ' }));
    const src = new CatalogSource({ id: 's', url: 'u', priority: 1, install_policy: InstallPolicy.INSTALL_ALLOWED });
    const withProv = entry.withProvenance(src);
    expect(withProv.sha256).toBe('abc');
    expect(withProv.source_id).toBe('s');
    expect(withProv.source_policy).toBe('install-allowed');
  });

  test('payload id checks and schema version', () => {
    expect(() => loadCatalogPayload(catalogPayload({ a: catalogEntryDict('b') }))).toThrow(
      "Catalog entry id mismatch: key 'a' != entry id 'b'.",
    );
    const noId = catalogEntryDict('a');
    delete noId.id;
    expect(() => loadCatalogPayload(catalogPayload({ a: noId }))).toThrow("Catalog entry for 'a' is missing its 'id' field.");
    expect(() => loadCatalogPayload({ schema_version: '2.0', bundles: {} })).toThrow(
      "Unsupported catalog schema version '2.0'; this Spec Kit understands version 1.0.",
    );
    expect(loadCatalogPayload({ bundles: {} }).size).toBe(0);
    expect(() => loadCatalogPayload({ schema_version: '1.0' })).toThrow("Catalog payload is missing a 'bundles' object.");
    expect(() => loadCatalogPayload([])).toThrow('Catalog payload must be a JSON object.');
  });

  test('packaged catalogs parse against the contract', () => {
    const corePack = path.join(__dirname, '..', 'core_pack', 'bundles');
    for (const name of ['catalog.json', 'catalog.community.json']) {
      const data = JSON.parse(readFileSync(path.join(corePack, name), 'utf-8'));
      expect(() => loadCatalogPayload(data)).not.toThrow();
    }
    const firstParty = loadCatalogPayload(JSON.parse(readFileSync(path.join(corePack, 'catalog.json'), 'utf-8')));
    expect([...firstParty.keys()].sort()).toEqual(['assess', 'bugfix']);
  });
});

// ============================================================================
// Project catalog config
// ============================================================================

describe('catalog config', () => {
  test('derive id', () => {
    expect(cc.deriveId('https://example.com/team-a.json')).toBe('example-com-team-a');
    expect(cc.deriveId('https://example.net/team-a.json')).toBe('example-net-team-a');
    expect(cc.deriveId('https://example.com/')).toBe('example-com');
    expect(cc.deriveId('./catalogs/my-catalog.json')).toBe('my-catalog');
    expect(cc.slug('Team-A')).toBe('team-a');
    expect(cc.deriveId('./catalogs/Team-A.json')).toBe('team-a');
    expect(cc.deriveId('https://Example.com/Team-A.json')).toBe('example-com-team-a');
    expect(cc.deriveId('https://[2001:db8::1]/catalog.json')).toBe('2001-db8--1-catalog');
    expect(cc.deriveId('https://user:pw@example.com:8443/c.json')).toBe('example-com-c');
  });

  test('canonicalize', () => {
    process.chdir(tmp);
    writeFileSync(path.join(tmp, 'local.json'), '{}');
    expect(cc.canonicalizeUrl('local.json')).toBe(path.join(tmp, 'local.json'));
    for (const url of ['https://example.com/c.json', 'http://localhost:8080/c.json', 'file:///tmp/c.json', 'builtin://default']) {
      expect(cc.canonicalizeUrl(url)).toBe(url);
    }
  });

  test('add persists absolute local path; remove accepts relative', () => {
    const root = project();
    process.chdir(tmp);
    writeFileSync(path.join(tmp, 'cat.json'), '{}');
    const [source, status] = cc.addSource(root, './cat.json', { policy: 'install-allowed', priority: 10 });
    expect(status).toBe('added');
    expect(source.url).toBe(path.join(tmp, 'cat.json'));
    expect(source.id).toBe('cat');
    const saved = readFileSync(cc.configPath(root), 'utf-8');
    expect(saved.startsWith('schema_version:')).toBe(true);
    expect(cc.read(root)[0]).toEqual({
      id: 'cat',
      url: path.join(tmp, 'cat.json'),
      priority: 10,
      install_policy: 'install-allowed',
    });
    expect(cc.removeSource(root, './cat.json')).toBe('./cat.json');
    expect(cc.read(root)).toEqual([]);
  });

  test('normalized existing entry is idempotent (unchanged, bytes untouched)', () => {
    const root = project();
    cc.write(root, [
      { id: ' example ', url: ' https://example.com/catalog.json ', priority: '50', install_policy: 'install-allowed', metadata: 'preserved' },
    ]);
    const original = readFileSync(cc.configPath(root));
    const [source, status] = cc.addSource(root, 'https://example.com/catalog.json', {
      policy: 'install-allowed',
      priority: 50,
      sourceId: 'example',
    });
    expect(status).toBe('unchanged');
    expect(source.id).toBe('example');
    expect(readFileSync(cc.configPath(root)).equals(original)).toBe(true);
  });

  test('partial identity matches rejected; id reused when omitted', () => {
    const root = project();
    const [first] = cc.addSource(root, 'https://example.com/catalog.json', { policy: 'install-allowed', priority: 50, sourceId: 'example' });
    expect(() =>
      cc.addSource(root, 'https://example.com/other.json', { policy: 'install-allowed', priority: 50, sourceId: 'example' }),
    ).toThrow("Catalog source 'example' (or url) already exists in this project.");
    expect(() =>
      cc.addSource(root, 'https://example.com/catalog.json', { policy: 'install-allowed', priority: 50, sourceId: 'different' }),
    ).toThrow('already exists');
    const [second, status] = cc.addSource(root, 'https://example.com/catalog.json', { policy: 'install-allowed', priority: 50 });
    expect(status).toBe('unchanged');
    expect(second.toDict()).toEqual(first.toDict());
  });

  test('url match preferred over derived-id collision', () => {
    const root = project();
    cc.write(root, [
      { id: 'example-com-target', url: 'https://other.example/catalog.json', priority: 50, install_policy: 'install-allowed' },
      { id: 'custom', url: 'https://example.com/target.json', priority: 50, install_policy: 'install-allowed' },
    ]);
    const [source, status] = cc.addSource(root, 'https://example.com/target.json', { policy: 'install-allowed', priority: 50 });
    expect(status).toBe('unchanged');
    expect(source.id).toBe('custom');
  });

  test('remove by id does not also delete canonical url match', () => {
    const root = project();
    process.chdir(tmp);
    cc.write(root, [
      { id: 'team', url: 'https://example.com/c.json', priority: 1, install_policy: 'install-allowed' },
      { id: 'other', url: path.join(tmp, 'team'), priority: 2, install_policy: 'install-allowed' },
    ]);
    cc.removeSource(root, 'team');
    expect(cc.read(root).map((c) => c.id)).toEqual(['other']);
  });

  test('builtin ids cannot be removed; unknown target errors', () => {
    const root = project();
    expect(() => cc.removeSource(root, 'default')).toThrow(
      "'default' is a built-in default source and cannot be deleted (add a same-id source to override it instead).",
    );
    expect(() => cc.removeSource(root, 'nope')).toThrow("No project-scoped catalog source matching 'nope' was found.");
    expect(() => cc.removeSource(root, 'https://[::1')).toThrow('No project-scoped catalog source');
  });

  test('url validation', () => {
    const root = project();
    const opts = { policy: 'install-allowed', priority: 10 };
    expect(() => cc.addSource(root, 'ssh://host/c.json', opts)).toThrow(
      "Unsupported catalog url scheme 'ssh://' in 'ssh://host/c.json'. Use http(s)://, file://, builtin://, or a local path.",
    );
    expect(() => cc.addSource(root, 'http://example.com/c.json', opts)).toThrow(
      'Catalog url must use HTTPS (got http://). HTTP is only allowed for localhost.',
    );
    expect(cc.addSource(root, 'http://localhost:8000/c.json', opts)[1]).toBe('added');
    expect(() => cc.addSource(root, 'https://:8080/c.json', opts)).toThrow('Catalog url must be a valid URL with a host: https://:8080/c.json');
    expect(() => cc.addSource(root, 'https://[::1/c.json', opts)).toThrow("Invalid catalog url: 'https://[::1/c.json'.");
    expect(() => cc.addSource(root, 'https://[not-an-ip]/c.json', opts)).toThrow('Invalid catalog url');
    expect(() => cc.addSource(root, 'https://example.com:99999/c.json', opts)).toThrow('Invalid catalog url');
    expect(() => cc.addSource(root, '   ', opts)).toThrow('A catalog url is required.');
    expect(() => cc.addSource(root, 'https://e.com/x.json', { policy: 'bogus', priority: 1 })).toThrow('Invalid install_policy');
  });

  test('local path with colon is allowed', () => {
    const root = project();
    process.chdir(tmp);
    const [source] = cc.addSource(root, 'dir:with/cat.json', { policy: 'install-allowed', priority: 10 });
    expect(path.isAbsolute(source.url)).toBe(true);
  });

  test('read rejects malformed config', () => {
    const root = project();
    writeConfig(root, 'catalogs: 5\n');
    expect(() => cc.read(root)).toThrow("'catalogs' must be a list, got int.");
    writeConfig(root, 'catalogs:\n  - just-a-string\n');
    expect(() => cc.read(root)).toThrow('each catalog entry must be a mapping, got str.');
    writeConfig(root, '- a\n');
    expect(() => cc.read(root)).toThrow('expected a mapping at the top level, got list.');
    writeConfig(root, 'null\n');
    expect(() => cc.read(root)).toThrow('got NoneType.');
    writeConfig(root, 'schema_version: "9"\n');
    expect(() => cc.read(root)).toThrow("Unsupported catalog config schema version '9'");
    writeConfig(root, '');
    expect(cc.read(root)).toEqual([]);
  });

  test('refuses symlinked .specify escape', () => {
    const root = path.join(tmp, 'proj2');
    mkdirSync(root);
    const outside = path.join(tmp, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(root, '.specify'));
    expect(() => cc.addSource(root, 'https://e.com/c.json', { policy: 'install-allowed', priority: 1 })).toThrow(
      'escapes the allowed root',
    );
    writeFileSync(path.join(outside, 'bundle-catalogs.yml'), 'catalogs: []\n');
    expect(() => loadSourceStack(root)).toThrow('escapes the allowed root');
  });
});

// ============================================================================
// Catalog stack
// ============================================================================

function src(id: string, priority: number, policy: InstallPolicy, url = 'builtin://x'): CatalogSource {
  return new CatalogSource({ id, url, priority, install_policy: policy, scope: Scope.PROJECT });
}

function stackOf(sources: CatalogSource[], payloads: Record<string, unknown>): CatalogStack {
  return new CatalogStack(sources, (s) => payloads[s.id]);
}

describe('catalog stack', () => {
  test('resolve prefers highest precedence', async () => {
    const stack = stackOf([src('low', 2, 'install-allowed'), src('high', 1, 'discovery-only')], {
      high: catalogPayload({ b: catalogEntryDict('b', { version: '9.0.0' }) }),
      low: catalogPayload({ b: catalogEntryDict('b', { version: '1.0.0' }) }),
    });
    const resolved = await stack.resolve('b');
    expect(resolved.source.id).toBe('high');
    expect(resolved.entry.version).toBe('9.0.0');
    expect(resolved.installAllowed).toBe(false);
    expect(resolved.entry.source_id).toBe('high');
  });

  test('unknown bundle errors', async () => {
    const stack = stackOf([src('only', 1, 'install-allowed')], { only: catalogPayload({}) });
    await rejects(stack.resolve('missing'), "Bundle 'missing' was not found in any configured catalog.");
  });

  test('search dedupes by precedence and filters', async () => {
    const stack = stackOf([src('a', 1, 'install-allowed'), src('b', 2, 'install-allowed')], {
      a: catalogPayload({ alpha: catalogEntryDict('alpha', { role: 'developer' }) }),
      b: catalogPayload({
        alpha: catalogEntryDict('alpha', { version: '0.0.1' }),
        beta: catalogEntryDict('beta', { role: 'qa' }),
      }),
    });
    const all = await stack.search();
    expect(all.map((r) => r.entry.id)).toEqual(['alpha', 'beta']);
    expect(all[0].source.id).toBe('a');
    expect((await stack.search('qa')).map((r) => r.entry.id)).toEqual(['beta']);
  });

  test('search does not surface a shadowed entry', async () => {
    const stack = stackOf([src('high', 1, 'install-allowed'), src('low', 2, 'install-allowed')], {
      high: catalogPayload({
        shared: catalogEntryDict('shared', { name: 'Alpha Tool', description: 'nothing relevant', version: '2.0.0' }),
      }),
      low: catalogPayload({ shared: catalogEntryDict('shared', { name: 'Searchable Widget', version: '1.0.0' }) }),
    });
    expect((await stack.resolve('shared')).source.id).toBe('high');
    expect(await stack.search('widget')).toEqual([]);
    const alpha = await stack.search('alpha tool');
    expect(alpha.map((r) => r.source.id)).toEqual(['high']);
  });

  test('unreachable source raises named error', async () => {
    const stack = new CatalogStack([src('bad', 1, 'install-allowed')], () => {
      throw new Error('boom');
    });
    await rejects(stack.resolve('anything'), "Failed to load catalog 'bad' (builtin://x): boom");
  });
});
