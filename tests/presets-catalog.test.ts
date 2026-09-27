/**
 * Tests for src/presets/catalog.ts (port of upstream
 * tests/specify_cli/presets/test_catalog.py, key cases). No network: the
 * catalog's ``openUrl`` is replaced with an in-memory responder.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PresetCatalog, PresetCatalogEntry, parsePyIsoformat } from '../src/presets/catalog.js';
import { PresetError, PresetValidationError } from '../src/presets/manifest.js';

let tempDir: string;
let projectDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'presets-catalog-'));
  projectDir = join(tempDir, 'project');
  mkdirSync(join(projectDir, '.specify'), { recursive: true });
  savedEnv = { SPECKIT_PRESET_CATALOG_URL: process.env.SPECKIT_PRESET_CATALOG_URL, HOME: process.env.HOME };
  delete process.env.SPECKIT_PRESET_CATALOG_URL;
  process.env.HOME = join(tempDir, 'home');
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

type Responder = (url: string, timeout?: number, headers?: Record<string, string> | null, rv?: unknown) => Promise<unknown>;

function mockCatalog(responder: Responder): PresetCatalog {
  const catalog = new PresetCatalog(projectDir);
  (catalog as unknown as { openUrl: Responder }).openUrl = responder;
  (catalog as unknown as { resolveGithubReleaseAssetApiUrl: () => Promise<null> }).resolveGithubReleaseAssetApiUrl =
    async () => null;
  return catalog;
}

function jsonResponse(payload: unknown, url?: string): Response {
  const resp = new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
  if (url) Object.defineProperty(resp, 'url', { value: url });
  return resp;
}

function writeCache(catalog: PresetCatalog, data: unknown, cachedAt = new Date().toISOString(), url?: string): void {
  mkdirSync(catalog.cacheDir, { recursive: true });
  writeFileSync(catalog.cacheFile, JSON.stringify(data));
  const meta: Record<string, unknown> = { cached_at: cachedAt };
  if (url) meta.catalog_url = url;
  writeFileSync(catalog.cacheMetadataFile, JSON.stringify(meta));
}

function writeConfig(content: string, dir = join(projectDir, '.specify')): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'preset-catalogs.yml');
  writeFileSync(p, content);
  return p;
}

const SAMPLE = {
  schema_version: '1.0',
  presets: {
    'safe-agile': {
      name: 'Safe Agile',
      description: 'Agile templates',
      author: 'agile-community',
      version: '1.0.0',
      tags: ['agile', 'scrum'],
    },
    'healthcare-compliance': {
      name: 'Healthcare Compliance',
      description: 'HIPAA-compliant templates',
      author: 'healthcare-org',
      version: '1.0.0',
      tags: ['healthcare', 'hipaa'],
    },
  },
};

// ============================================================================

describe('PresetCatalog basics', () => {
  test('default and community URLs', () => {
    const c = new PresetCatalog(projectDir);
    expect(c.getCatalogUrl()).toBe(PresetCatalog.DEFAULT_CATALOG_URL);
    expect(PresetCatalog.DEFAULT_CATALOG_URL).toBe(
      'https://raw.githubusercontent.com/github/spec-kit/main/presets/catalog.json',
    );
    expect(PresetCatalog.COMMUNITY_CATALOG_URL).toContain('catalog.community.json');
  });

  test('cache validation: none / valid / expired / corrupted / non-mapping', () => {
    const c = new PresetCatalog(projectDir);
    expect(c.isCacheValid()).toBe(false);
    writeCache(c, SAMPLE);
    expect(c.isCacheValid()).toBe(true);
    writeCache(c, SAMPLE, new Date(Date.now() - 2 * 3600 * 1000).toISOString());
    expect(c.isCacheValid()).toBe(false);
    writeFileSync(c.cacheMetadataFile, 'not json');
    expect(c.isCacheValid()).toBe(false);
    for (const bad of ['[]', '"oops"', '42']) {
      writeFileSync(c.cacheMetadataFile, bad);
      expect(c.isCacheValid()).toBe(false);
    }
  });

  test('clear cache removes catalog* files only', () => {
    const c = new PresetCatalog(projectDir);
    writeCache(c, SAMPLE);
    writeFileSync(join(c.cacheDir, 'catalog-abc.json'), '{}');
    writeFileSync(join(c.cacheDir, 'other.txt'), 'keep');
    c.clearCache();
    expect(existsSync(c.cacheFile)).toBe(false);
    expect(existsSync(join(c.cacheDir, 'catalog-abc.json'))).toBe(false);
    expect(existsSync(join(c.cacheDir, 'other.txt'))).toBe(true);
  });

  test('search with cached data', async () => {
    const c = mockCatalog(async () => {
      throw new Error('network disabled');
    });
    // Only the default catalog is active and cached.
    writeConfig(`catalogs:\n  - name: default\n    url: ${PresetCatalog.DEFAULT_CATALOG_URL}\n    priority: 1\n    install_allowed: true\n`);
    writeCache(c, SAMPLE);
    expect((await c.search()).length).toBe(2);
    const agile = await c.search({ query: 'agile' });
    expect(agile.map((p) => p.id)).toEqual(['safe-agile']);
    expect((await c.search({ tag: 'HIPAA' })).map((p) => p.id)).toEqual(['healthcare-compliance']);
    expect((await c.search({ author: 'agile-community' })).length).toBe(1);
    expect((await c.search({ query: 'nothing-matches' })).length).toBe(0);
  });

  test('get pack info', async () => {
    const c = mockCatalog(async () => {
      throw new Error('network disabled');
    });
    writeConfig(`catalogs:\n  - name: default\n    url: ${PresetCatalog.DEFAULT_CATALOG_URL}\n`);
    writeCache(c, SAMPLE);
    const info = await c.getPackInfo('safe-agile');
    expect(info!.name).toBe('Safe Agile');
    expect(info!.id).toBe('safe-agile');
    expect(info!._catalog_name).toBe('default');
    expect(await c.getPackInfo('nonexistent')).toBeNull();
  });
});

describe('validateCatalogUrl', () => {
  test('https ok, http rejected, localhost http allowed', () => {
    const c = new PresetCatalog(projectDir);
    c.validateCatalogUrl('https://example.com/catalog.json');
    expect(() => c.validateCatalogUrl('http://example.com/catalog.json')).toThrow(
      'Catalog URL must use HTTPS (got http://). HTTP is only allowed for localhost.',
    );
    c.validateCatalogUrl('http://localhost:8080/catalog.json');
    c.validateCatalogUrl('http://127.0.0.1/catalog.json');
    c.validateCatalogUrl('http://[::1]:8000/catalog.json');
  });

  for (const url of ['https://:8080', 'https://:8080/catalog.json', 'https://:0', 'https://user@', 'https://user:pass@']) {
    test(`hostless rejected: ${url}`, () => {
      expect(() => new PresetCatalog(projectDir).validateCatalogUrl(url)).toThrow(/valid URL with a host/);
    });
  }

  test('malformed and out-of-range port rejected', () => {
    const c = new PresetCatalog(projectDir);
    expect(() => c.validateCatalogUrl('https://[::1')).toThrow(/malformed/);
    expect(() => c.validateCatalogUrl('https://example.com:99999/catalog.json')).toThrow(/malformed/);
    expect(() => c.validateCatalogUrl('https://example.com:abc/catalog.json')).toThrow(PresetValidationError);
  });
});

describe('fetching', () => {
  test('fetch single catalog writes cache and validates redirected URL', async () => {
    const url = 'https://example.com/catalog.json';
    const c = mockCatalog(async () => jsonResponse(SAMPLE, 'http://evil.example.com/catalog.json'));
    const entry = new PresetCatalogEntry({ url, name: 'x', priority: 1, install_allowed: true });
    await expect(c.fetchSingleCatalog(entry)).rejects.toThrow(/must use HTTPS/);

    const ok = mockCatalog(async () => jsonResponse(SAMPLE));
    const data = await ok.fetchSingleCatalog(entry);
    expect(Object.keys(data.presets)).toContain('safe-agile');
    const [cacheFile, metaFile] = ok.getCachePaths(url);
    expect(existsSync(cacheFile)).toBe(true);
    const meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
    expect(meta.catalog_url).toBe(url);
    expect(parsePyIsoformat(meta.cached_at)).not.toBeNull();
  });

  test('redirect validator rejects insecure hop', async () => {
    const url = 'https://example.com/catalog.json';
    const c = mockCatalog(async (_u, _t, _h, rv) => {
      (rv as (o: string, n: string) => void)(url, 'http://attacker.example.com/c.json');
      return jsonResponse(SAMPLE);
    });
    const entry = new PresetCatalogEntry({ url, name: 'x', priority: 1, install_allowed: true });
    await expect(c.fetchSingleCatalog(entry)).rejects.toThrow(PresetValidationError);
  });

  for (const [label, payload, pattern] of [
    ['list root', [], /expected a JSON object/],
    ['missing keys', { schema_version: '1.0' }, /Invalid preset catalog format from/],
    ['presets list', { schema_version: '1.0', presets: [] }, /'presets' must be a JSON object/],
    ['presets null', { schema_version: '1.0', presets: null }, /'presets' must be a JSON object/],
  ] as Array<[string, unknown, RegExp]>) {
    test(`rejects malformed payload: ${label}`, async () => {
      const c = mockCatalog(async () => jsonResponse(payload));
      const entry = new PresetCatalogEntry({ url: 'https://example.com/c.json', name: 'x', priority: 1, install_allowed: true });
      await expect(c.fetchSingleCatalog(entry)).rejects.toThrow(pattern);
      await expect(c.fetchCatalog(true)).rejects.toThrow(PresetError);
    });
  }

  test('malformed cached payload falls through to network', async () => {
    const c = mockCatalog(async () => jsonResponse(SAMPLE));
    writeCache(c, { schema_version: '1.0', presets: [] }, new Date().toISOString(), PresetCatalog.DEFAULT_CATALOG_URL);
    const data = await c.fetchCatalog();
    expect(Object.keys(data.presets)).toContain('safe-agile');
  });

  test('network failure wraps as PresetError', async () => {
    const c = mockCatalog(async () => {
      throw new Error('boom');
    });
    await expect(c.fetchCatalog()).rejects.toThrow(
      `Failed to fetch preset catalog from ${PresetCatalog.DEFAULT_CATALOG_URL}: boom`,
    );
  });

  test('merged packs skip non-mapping entries and higher priority wins', async () => {
    writeConfig(
      'catalogs:\n  - name: first\n    url: https://a.example.com/c.json\n    priority: 1\n    install_allowed: true\n  - name: second\n    url: https://b.example.com/c.json\n    priority: 2\n',
    );
    const c = mockCatalog(async (url) => {
      if (url.includes('a.example.com')) {
        return jsonResponse({ schema_version: '1.0', presets: { shared: { name: 'From A' }, bad: [] } });
      }
      return jsonResponse({ schema_version: '1.0', presets: { shared: { name: 'From B' }, onlyb: { name: 'B' } } });
    });
    const merged = await c.getMergedPacks();
    expect(merged.shared.name).toBe('From A');
    expect(merged.shared._catalog_name).toBe('first');
    expect(merged.shared._install_allowed).toBe(true);
    expect(merged.onlyb._install_allowed).toBe(false);
    expect('bad' in merged).toBe(false);
  });
});

describe('downloadPack', () => {
  const zipBytes = Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'latin1');

  function withPack(c: PresetCatalog, info: Record<string, unknown>): void {
    (c as unknown as { getPackInfo: () => Promise<unknown> }).getPackInfo = async () => info;
  }

  test('accepts matching sha256 and rejects mismatch', async () => {
    const c = mockCatalog(async () => new Response(zipBytes));
    withPack(c, {
      id: 'test-pack',
      version: '1.0.0',
      download_url: 'https://example.com/test-pack.zip',
      sha256: createHash('sha256').update(zipBytes).digest('hex'),
      _install_allowed: true,
    });
    const p = await c.downloadPack('test-pack', projectDir);
    expect(readFileSync(p).equals(zipBytes)).toBe(true);
    expect(p.endsWith('test-pack-1.0.0.zip')).toBe(true);

    const bad = mockCatalog(async () => new Response(zipBytes));
    withPack(bad, {
      id: 'test-pack',
      version: '1.0.0',
      download_url: 'https://example.com/test-pack.zip',
      sha256: '0'.repeat(64),
      _install_allowed: true,
    });
    await expect(bad.downloadPack('test-pack', join(tempDir, 'dl'))).rejects.toThrow(/[Ii]ntegrity/);
  });

  test('rejects unsafe output filename before fetching', async () => {
    let called = false;
    const c = mockCatalog(async () => {
      called = true;
      return new Response(zipBytes);
    });
    const packId = join(tempDir, 'outside-preset');
    withPack(c, { id: packId, version: '1.0.0', download_url: 'https://example.com/x.zip', _install_allowed: true });
    await expect(c.downloadPack(packId, projectDir)).rejects.toThrow(/filename/);
    expect(called).toBe(false);
  });

  test('malformed / non-https / missing URL, discovery-only and bundled', async () => {
    const c = mockCatalog(async () => new Response(zipBytes));
    withPack(c, { id: 'p', version: '1', download_url: 'https://[::1', _install_allowed: true });
    await expect(c.downloadPack('p')).rejects.toThrow('Preset download URL is malformed: https://[::1');
    withPack(c, { id: 'p', version: '1', download_url: 'http://example.com/p.zip', _install_allowed: true });
    await expect(c.downloadPack('p')).rejects.toThrow('Preset download URL must use HTTPS: http://example.com/p.zip');
    withPack(c, { id: 'p', version: '1', _install_allowed: true });
    await expect(c.downloadPack('p')).rejects.toThrow("Preset 'p' has no download URL");
    withPack(c, { id: 'p', version: '1', download_url: 'https://e.com/p.zip', _install_allowed: false, _catalog_name: 'community' });
    await expect(c.downloadPack('p')).rejects.toThrow(
      "Preset 'p' is from the 'community' catalog which does not allow installation.",
    );
    withPack(c, { id: 'p', version: '1', bundled: true });
    await expect(c.downloadPack('p')).rejects.toThrow(/is bundled with spec-kit and has no download URL/);
    (c as unknown as { getPackInfo: () => Promise<null> }).getPackInfo = async () => null;
    await expect(c.downloadPack('p')).rejects.toThrow("Preset 'p' not found in catalog");
  });
});

describe('multi-catalog configuration', () => {
  test('default active catalogs', () => {
    const active = new PresetCatalog(projectDir).getActiveCatalogs();
    expect(active.map((e) => [e.name, e.priority, e.install_allowed])).toEqual([
      ['default', 1, true],
      ['community', 2, false],
    ]);
    expect(active[1].description).toBe('Community-contributed presets (discovery only)');
  });

  test('env var overrides catalogs', () => {
    process.env.SPECKIT_PRESET_CATALOG_URL = 'https://custom.example.com/catalog.json';
    const active = new PresetCatalog(projectDir).getActiveCatalogs();
    expect(active.length).toBe(1);
    expect(active[0].name).toBe('custom');
    expect(active[0].url).toBe('https://custom.example.com/catalog.json');
  });

  test('project config overrides defaults; user config used when no project config', () => {
    writeConfig('catalogs:\n  - name: user-cat\n    url: https://user.example.com/c.json\n', join(tempDir, 'home', '.specify'));
    expect(new PresetCatalog(projectDir).getActiveCatalogs()[0].name).toBe('user-cat');
    writeConfig('catalogs:\n  - name: proj\n    url: https://proj.example.com/c.json\n');
    expect(new PresetCatalog(projectDir).getActiveCatalogs()[0].name).toBe('proj');
  });

  test('load config: nonexistent / empty / blank names / priority sorting', () => {
    const c = new PresetCatalog(projectDir);
    expect(c.loadCatalogConfig(join(projectDir, 'nope.yml'))).toBeNull();
    expect(c.loadCatalogConfig(writeConfig(''))).toBeNull();
    expect(c.loadCatalogConfig(writeConfig('catalogs: []\n'))).toBeNull();
    expect(c.loadCatalogConfig(writeConfig('catalogs: null\n'))).toBeNull();
    const entries = c.loadCatalogConfig(
      writeConfig(
        'catalogs:\n  - url: https://b.example.com/c.json\n    priority: 5\n    name: "  "\n  - url: https://a.example.com/c.json\n    priority: 2\n  - url: ""\n',
      ),
    )!;
    expect(entries.map((e) => [e.name, e.priority])).toEqual([
      ['catalog-2', 2],
      ['catalog-1', 5],
    ]);
  });

  test('load config rejects bad shapes', () => {
    const c = new PresetCatalog(projectDir);
    for (const body of ['[]\n', 'false\n', '0\n', "''\n", '5\n']) {
      expect(() => c.loadCatalogConfig(writeConfig(body))).toThrow(/expected a mapping at root/);
    }
    for (const body of ['catalogs: {}\n', "catalogs: ''\n", 'catalogs: 0\n', 'catalogs: false\n', 'catalogs: not-a-list\n']) {
      expect(() => c.loadCatalogConfig(writeConfig(body))).toThrow(/'catalogs' must be a list/);
    }
    expect(() => c.loadCatalogConfig(writeConfig('catalogs:\n  - just-a-string\n'))).toThrow(
      'Invalid catalog entry at index 0: expected a mapping, got str',
    );
    expect(() => c.loadCatalogConfig(writeConfig('catalogs: [\n'))).toThrow(/Failed to read catalog config/);
    expect(() =>
      c.loadCatalogConfig(writeConfig('catalogs:\n  - url: http://insecure.example.com/c.json\n')),
    ).toThrow(/must use HTTPS/);
  });

  test('priority validation', () => {
    const c = new PresetCatalog(projectDir);
    expect(() =>
      c.loadCatalogConfig(writeConfig('catalogs:\n  - name: x\n    url: https://e.com/c.json\n    priority: high\n')),
    ).toThrow("Invalid priority for catalog 'x': expected integer, got 'high'");
    expect(() =>
      c.loadCatalogConfig(writeConfig('catalogs:\n  - name: x\n    url: https://e.com/c.json\n    priority: true\n')),
    ).toThrow("Invalid priority for catalog 'x': expected integer, got True");
    expect(() =>
      c.loadCatalogConfig(writeConfig('catalogs:\n  - name: x\n    url: https://e.com/c.json\n    priority: .inf\n')),
    ).toThrow("Invalid priority for catalog 'x': expected integer, got inf");
  });

  test('install_allowed string coercion', () => {
    const c = new PresetCatalog(projectDir);
    const entries = c.loadCatalogConfig(
      writeConfig(
        'catalogs:\n  - url: https://a.example.com/c.json\n    install_allowed: "yes"\n  - url: https://b.example.com/c.json\n    install_allowed: "no"\n',
      ),
    )!;
    expect(entries.map((e) => e.install_allowed)).toEqual([true, false]);
  });

  test('cache paths: default uses legacy files; custom uses hash', () => {
    const c = new PresetCatalog(projectDir);
    expect(c.getCachePaths(PresetCatalog.DEFAULT_CATALOG_URL)).toEqual([c.cacheFile, c.cacheMetadataFile]);
    const url = 'https://custom.example.com/c.json';
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
    expect(c.getCachePaths(url)).toEqual([
      join(c.cacheDir, `catalog-${hash}.json`),
      join(c.cacheDir, `catalog-${hash}-metadata.json`),
    ]);
  });

  test('entry defaults', () => {
    const e = new PresetCatalogEntry({ url: 'https://e.com', name: 'n', priority: 1, install_allowed: true });
    expect(e.description).toBe('');
  });
});
