/**
 * Port of upstream ``TestExtensionCatalog``, ``TestCatalogStack`` and
 * ``TestDownloadExtensionBundled`` (tests/test_extensions.py). Network access
 * is replaced by a stubbed ``ExtensionCatalog.prototype.openUrl``.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ExtensionCatalog, ExtensionError, ValidationError } from '../src/extensions/index.js';
import { dumpYaml } from '../src/yaml.js';
import { type AnyDict, cleanupTempDirs, makeProjectDir, makeTempDir } from './extensions-helpers.js';

type Route = { body: string | Uint8Array; status?: number; headers?: Record<string, string> } | Error;

const originalOpenUrl = ExtensionCatalog.prototype.openUrl;
const originalResolve = ExtensionCatalog.prototype.resolveGithubReleaseAssetApiUrl;
let routes: Record<string, Route> = {};
let requested: string[] = [];
let savedEnv: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
  routes = {};
  requested = [];
  savedEnv = process.env.SPECKIT_CATALOG_URL;
  delete process.env.SPECKIT_CATALOG_URL;
  savedHome = process.env.HOME;
  process.env.HOME = makeTempDir('speckit-home-');
  ExtensionCatalog.prototype.openUrl = async function (url: string) {
    requested.push(url);
    const route = routes[url];
    if (!route) throw new Error(`HTTP Error 404: Not Found (${url})`);
    if (route instanceof Error) throw route;
    return new Response(route.body, { status: route.status ?? 200, headers: route.headers });
  };
  ExtensionCatalog.prototype.resolveGithubReleaseAssetApiUrl = async () => null;
});

afterEach(() => {
  ExtensionCatalog.prototype.openUrl = originalOpenUrl;
  ExtensionCatalog.prototype.resolveGithubReleaseAssetApiUrl = originalResolve;
  if (savedEnv === undefined) delete process.env.SPECKIT_CATALOG_URL;
  else process.env.SPECKIT_CATALOG_URL = savedEnv;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  cleanupTempDirs();
});

function catalogPayload(extensions: AnyDict): string {
  return JSON.stringify({ schema_version: '1.0', updated_at: '2026-01-01T00:00:00Z', extensions });
}

const SAMPLE = {
  jira: {
    name: 'Jira Integration',
    id: 'jira',
    description: 'Jira issue tracking',
    version: '1.0.0',
    author: 'Stats Perform',
    tags: ['issue-tracking', 'jira'],
    verified: true,
    download_url: 'https://example.com/jira.zip',
  },
  linear: {
    name: 'Linear Integration',
    id: 'linear',
    description: 'Linear project management',
    version: '0.9.0',
    author: 'Community',
    tags: ['issue-tracking', 'linear'],
    verified: false,
  },
};

function projectCatalog(): { proj: string; catalog: ExtensionCatalog } {
  const proj = makeProjectDir(makeTempDir());
  return { proj, catalog: new ExtensionCatalog(proj) };
}

function useSingleCatalog(proj: string, extensions: AnyDict, name = 'mine', installAllowed = true): string {
  const url = `https://catalogs.example.com/${name}.json`;
  const cfg = { catalogs: [{ name, url, priority: 1, install_allowed: installAllowed }] };
  writeFileSync(join(proj, '.specify', 'extension-catalogs.yml'), dumpYaml(cfg));
  routes[url] = { body: catalogPayload(extensions) };
  return url;
}

describe('ExtensionCatalog basics', () => {
  test('initialization paths', () => {
    const { proj, catalog } = projectCatalog();
    expect(catalog.cacheDir).toBe(join(proj, '.specify', 'extensions', '.cache'));
    expect(catalog.cacheFile).toBe(join(catalog.cacheDir, 'catalog.json'));
    expect(catalog.cacheMetadataFile).toBe(join(catalog.cacheDir, 'catalog-metadata.json'));
  });

  test('cache expiration', () => {
    const { catalog } = projectCatalog();
    mkdirSync(catalog.cacheDir, { recursive: true });
    writeFileSync(catalog.cacheFile, catalogPayload({}));
    writeFileSync(catalog.cacheMetadataFile, JSON.stringify({ cached_at: new Date().toISOString() }));
    expect(catalog.isCacheValid()).toBe(true);
    writeFileSync(
      catalog.cacheMetadataFile,
      JSON.stringify({ cached_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString().replace('Z', '') }),
    );
    expect(catalog.isCacheValid()).toBe(false);
    writeFileSync(catalog.cacheMetadataFile, '[]');
    expect(catalog.isCacheValid()).toBe(false);
  });

  test('search all / by query / by tag / verified only / author', async () => {
    const { proj, catalog } = projectCatalog();
    useSingleCatalog(proj, SAMPLE);
    expect((await catalog.search()).map((e) => e.id)).toEqual(['jira', 'linear']);
    expect((await catalog.search({ query: 'linear' })).map((e) => e.id)).toEqual(['linear']);
    expect((await catalog.search({ tag: 'JIRA' })).map((e) => e.id)).toEqual(['jira']);
    expect((await catalog.search({ verifiedOnly: true })).map((e) => e.id)).toEqual(['jira']);
    expect((await catalog.search({ author: 'community' })).map((e) => e.id)).toEqual(['linear']);
    const [first] = await catalog.search({ query: 'jira' });
    expect(first._catalog_name).toBe('mine');
    expect(first._install_allowed).toBe(true);
  });

  test('search tolerates non-string tags, author and name', async () => {
    const { proj, catalog } = projectCatalog();
    useSingleCatalog(proj, { odd: { name: 42, author: null, tags: [1, 'Real'], description: null } });
    expect((await catalog.search({ tag: 'real' })).map((e) => e.id)).toEqual(['odd']);
    expect(await catalog.search({ author: 'x' })).toEqual([]);
    expect((await catalog.search({ query: '42' })).map((e) => e.id)).toEqual(['odd']);
  });

  test('get extension info and caching', async () => {
    const { proj, catalog } = projectCatalog();
    const url = useSingleCatalog(proj, SAMPLE);
    const info = await catalog.getExtensionInfo('jira');
    expect(info!.name).toBe('Jira Integration');
    expect(await catalog.getExtensionInfo('missing')).toBeNull();
    // Second lookup served from per-URL cache.
    const before = requested.length;
    await new ExtensionCatalog(proj).getExtensionInfo('jira');
    expect(requested.length).toBe(before);
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
    expect(existsSync(join(catalog.cacheDir, `catalog-${hash}.json`))).toBe(true);
    expect(existsSync(join(catalog.cacheDir, `catalog-${hash}-metadata.json`))).toBe(true);
  });

  test('clear cache', async () => {
    const { proj, catalog } = projectCatalog();
    useSingleCatalog(proj, SAMPLE);
    await catalog.search();
    catalog.clearCache();
    expect(readdirSync(catalog.cacheDir).filter((n) => n.startsWith('catalog'))).toEqual([]);
  });

  test('malformed payload rejected, merged fails when all catalogs fail', async () => {
    for (const payload of ['[]', '{"schema_version": "1.0"}', '{"schema_version":"1.0","extensions":[]}']) {
      const { proj, catalog } = projectCatalog();
      const url = useSingleCatalog(proj, {});
      routes[url] = { body: payload };
      const entry = catalog.getActiveCatalogs()[0];
      let err: unknown;
      try {
        await catalog.fetchSingleCatalog(entry);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ExtensionError);
      expect((err as Error).message).toContain(`Invalid catalog format from ${url}`);
      let err2: unknown;
      try {
        await catalog.search();
      } catch (e) {
        err2 = e;
      }
      expect((err2 as Error).message).toBe('Failed to fetch any extension catalog');
    }
  });

  test('poisoned cache is refetched', async () => {
    const { proj, catalog } = projectCatalog();
    const url = useSingleCatalog(proj, SAMPLE);
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
    mkdirSync(catalog.cacheDir, { recursive: true });
    writeFileSync(join(catalog.cacheDir, `catalog-${hash}.json`), '{"extensions": []}');
    writeFileSync(
      join(catalog.cacheDir, `catalog-${hash}-metadata.json`),
      JSON.stringify({ cached_at: new Date().toISOString() }),
    );
    expect((await catalog.search()).length).toBe(2);
    expect(requested).toContain(url);
  });

  test('merged skips non-mapping entries', async () => {
    const { proj, catalog } = projectCatalog();
    useSingleCatalog(proj, { foo: [], bar: { name: 'Bar', version: '1.0.0' } });
    expect((await catalog.search()).map((e) => e.id)).toEqual(['bar']);
  });

  test('network failure message', async () => {
    const { proj, catalog } = projectCatalog();
    const url = useSingleCatalog(proj, {});
    routes[url] = new Error('boom');
    let err: unknown;
    try {
      await catalog.fetchSingleCatalog(catalog.getActiveCatalogs()[0]);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe(`Failed to fetch catalog from ${url}: boom`);
  });
});

describe('ExtensionCatalog stack', () => {
  test('default stack', () => {
    const { catalog } = projectCatalog();
    const active = catalog.getActiveCatalogs();
    expect(active.map((e) => [e.name, e.priority, e.install_allowed])).toEqual([
      ['default', 1, true],
      ['community', 2, false],
    ]);
    expect(active[0].url).toBe(ExtensionCatalog.DEFAULT_CATALOG_URL);
    expect(active[1].description).toBe('Community-contributed extensions (discovery only)');
  });

  test('env var overrides default stack', () => {
    const { catalog } = projectCatalog();
    process.env.SPECKIT_CATALOG_URL = 'https://custom.example.com/catalog.json';
    const active = catalog.getActiveCatalogs();
    expect(active).toEqual([
      {
        url: 'https://custom.example.com/catalog.json',
        name: 'custom',
        priority: 1,
        install_allowed: true,
        description: 'Custom catalog via SPECKIT_CATALOG_URL',
      },
    ]);
  });

  test('env var invalid url raises', () => {
    const { catalog } = projectCatalog();
    process.env.SPECKIT_CATALOG_URL = 'http://evil.example.com/catalog.json';
    expect(() => catalog.getActiveCatalogs()).toThrow(
      'Catalog URL must use HTTPS (got http://). HTTP is only allowed for localhost.',
    );
  });

  test('project config sorted by priority, localhost allowed, blank names defaulted', () => {
    const { proj, catalog } = projectCatalog();
    writeFileSync(
      join(proj, '.specify', 'extension-catalogs.yml'),
      dumpYaml({
        catalogs: [
          { name: 'second', url: 'https://b.example.com/c.json', priority: 5, install_allowed: 'yes' },
          { url: 'http://localhost:8000/c.json', priority: 2 },
        ],
      }),
    );
    const active = catalog.getActiveCatalogs();
    expect(active.map((e) => [e.name, e.priority, e.install_allowed])).toEqual([
      ['catalog-2', 2, false],
      ['second', 5, true],
    ]);
  });

  test('config errors', () => {
    const { proj, catalog } = projectCatalog();
    const cfgPath = join(proj, '.specify', 'extension-catalogs.yml');
    writeFileSync(cfgPath, 'catalogs: []\n');
    expect(() => catalog.getActiveCatalogs()).toThrow(
      `Catalog config ${cfgPath} exists but contains no 'catalogs' entries.`,
    );
    writeFileSync(cfgPath, dumpYaml({ catalogs: [{ name: 'x' }] }));
    expect(() => catalog.getActiveCatalogs()).toThrow(
      `Catalog config ${cfgPath} contains 1 entries but none have valid URLs (entries at indices [0] were skipped).`,
    );
    writeFileSync(cfgPath, '- a\n');
    expect(() => catalog.getActiveCatalogs()).toThrow(
      `Invalid catalog config ${cfgPath}: expected a YAML mapping at the root`,
    );
    writeFileSync(cfgPath, dumpYaml({ catalogs: [{ name: 'x', url: 'https://a.example.com', priority: true }] }));
    expect(() => catalog.getActiveCatalogs()).toThrow(
      "Invalid priority for catalog 'x': expected integer, got True",
    );
    writeFileSync(cfgPath, dumpYaml({ catalogs: [{ name: 'x', url: 'ftp://a.example.com' }] }));
    let err: unknown;
    try {
      catalog.getActiveCatalogs();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toBe(
      `Invalid catalog URL in ${cfgPath} at index 0: Catalog URL must use HTTPS (got ftp://). HTTP is only allowed for localhost.`,
    );
  });

  test('load catalog config missing file returns null', () => {
    const { catalog } = projectCatalog();
    expect(catalog.loadCatalogConfig('/nonexistent/x.yml')).toBeNull();
  });

  test('merge conflict: higher priority wins, install_allowed annotated', async () => {
    const { proj, catalog } = projectCatalog();
    writeFileSync(
      join(proj, '.specify', 'extension-catalogs.yml'),
      dumpYaml({
        catalogs: [
          { name: 'low', url: 'https://low.example.com/c.json', priority: 2, install_allowed: true },
          { name: 'high', url: 'https://high.example.com/c.json', priority: 1, install_allowed: false },
        ],
      }),
    );
    routes['https://high.example.com/c.json'] = { body: catalogPayload({ jira: { name: 'High Jira', version: '2.0.0' } }) };
    routes['https://low.example.com/c.json'] = { body: catalogPayload({ jira: { name: 'Low Jira' }, other: { name: 'O' } }) };
    const info = await catalog.getExtensionInfo('jira');
    expect(info!.name).toBe('High Jira');
    expect(info!._catalog_name).toBe('high');
    expect(info!._install_allowed).toBe(false);
    expect((await catalog.getExtensionInfo('other'))!._catalog_name).toBe('low');
  });
});

describe('ExtensionCatalog.downloadExtension', () => {
  const ZIP_BYTES = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

  test('bundled without URL raises', async () => {
    const { proj, catalog } = projectCatalog();
    useSingleCatalog(proj, { git: { name: 'Git', version: '1.0.0', bundled: true } });
    let err: unknown;
    try {
      await catalog.downloadExtension('git');
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe(
      "Extension 'git' is bundled with spec-kit and has no download URL. It should be installed from the local package. " +
        'Try reinstalling: uv tool install specify-cli --force --from git+https://github.com/github/spec-kit.git',
    );
  });

  test('non-bundled without URL raises; http URL rejected; malformed rejected', async () => {
    const { proj, catalog } = projectCatalog();
    useSingleCatalog(proj, {
      a: { name: 'A', version: '1.0.0' },
      b: { name: 'B', version: '1.0.0', download_url: 'http://example.com/b.zip' },
      c: { name: 'C', version: '1.0.0', download_url: 'https://[::1/x.zip' },
    });
    const msg = async (id: string): Promise<string> => {
      try {
        await catalog.downloadExtension(id);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };
    expect(await msg('a')).toBe("Extension 'a' has no download URL");
    expect(await msg('b')).toBe('Extension download URL must use HTTPS: http://example.com/b.zip');
    expect(await msg('c')).toBe('Extension download URL is malformed: https://[::1/x.zip');
    expect(await msg('zzz')).toBe("Extension 'zzz' not found in catalog");
  });

  test('downloads, verifies sha256, names file by id-version', async () => {
    const { proj, catalog } = projectCatalog();
    const sha = createHash('sha256').update(ZIP_BYTES).digest('hex');
    useSingleCatalog(proj, {
      jira: { name: 'Jira', version: '1.2.3', download_url: 'https://example.com/jira.zip', sha256: `sha256:${sha}` },
      bad: { name: 'Bad', version: '1.0.0', download_url: 'https://example.com/bad.zip', sha256: '0'.repeat(64) },
    });
    routes['https://example.com/jira.zip'] = { body: ZIP_BYTES };
    routes['https://example.com/bad.zip'] = { body: ZIP_BYTES };
    const path = await catalog.downloadExtension('jira');
    expect(path).toBe(join(catalog.cacheDir, 'downloads', 'jira-1.2.3.zip'));
    expect(new Uint8Array(readFileSync(path))).toEqual(ZIP_BYTES);
    let err: unknown;
    try {
      await catalog.downloadExtension('bad');
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toContain("Integrity check failed for 'bad'");
    expect(existsSync(join(catalog.cacheDir, 'downloads', 'bad-1.0.0.zip'))).toBe(false);
  });
});
