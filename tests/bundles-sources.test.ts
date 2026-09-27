/**
 * Bundle catalog fetching (adapters) and manifest sources. Ports of
 * tests/specify_cli/bundles/{test_adapters,test_offline,test_sources}.py.
 * Network is never touched: HTTP goes through injected fakes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { dumpYaml } from '../src/yaml.js';
import { BundlerError } from '../src/bundles/index.js';
import { CatalogEntry, CatalogSource, InstallPolicy, Scope } from '../src/bundles/catalogs.js';
import { CatalogStack, ResolvedBundle } from '../src/bundles/catalog-stack.js';
import {
  CatalogUnavailable,
  adapterDeps,
  httpGetJson,
  makeCatalogFetcher,
  validateRemoteUrl,
} from '../src/bundles/adapters.js';
import {
  downloadManifest,
  localManifestSource,
  requireHttps,
  sourceDeps,
  validateManifestStructure,
} from '../src/bundles/sources.js';
import { BundleManifest } from '../src/bundles/manifest.js';
import { buildZip } from '../src/bundles/packager.js';
import { catalogEntryDict, validManifestDict, writeCatalogFile, writeManifest } from './bundles-helpers.js';

let tmp: string;
const savedAdapter = { ...adapterDeps };
const savedSource = { ...sourceDeps };
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'bundles-src-')));
  sourceDeps.resolveGithubReleaseAssetApiUrl = async () => null;
});
afterEach(() => {
  Object.assign(adapterDeps, savedAdapter);
  Object.assign(sourceDeps, savedSource);
  rmSync(tmp, { recursive: true, force: true });
});

async function rejects(p: Promise<unknown>, match: string | RegExp, cls: Function = BundlerError): Promise<Error> {
  let caught: unknown;
  try {
    await p;
  } catch (exc) {
    caught = exc;
  }
  expect(caught).toBeInstanceOf(cls);
  const msg = (caught as Error).message;
  if (typeof match === 'string') expect(msg).toContain(match);
  else expect(msg).toMatch(match);
  return caught as Error;
}

/** urllib-like response with ``geturl()`` and bounded ``read(n)``. */
class FakeResponse {
  private offset = 0;
  constructor(
    private readonly body: Uint8Array,
    private readonly finalUrl: string,
  ) {}
  geturl(): string {
    return this.finalUrl;
  }
  read(size: number): Uint8Array {
    const start = this.offset;
    this.offset = Math.min(this.body.length, this.offset + size);
    return this.body.subarray(start, this.offset);
  }
}

function source(url: string, id = 'team'): CatalogSource {
  return new CatalogSource({ id, url, priority: 10, install_policy: InstallPolicy.INSTALL_ALLOWED, scope: Scope.PROJECT });
}

// ============================================================================
// adapters: HTTP
// ============================================================================

describe('adapters http', () => {
  test('uses the shared client and validates redirects', async () => {
    const captured: { url?: string; validator?: (a: string, b: string) => void } = {};
    adapterDeps.openUrl = async (url, opts) => {
      captured.url = url;
      captured.validator = opts.redirectValidator;
      return new FakeResponse(Buffer.from('{"schema_version": "1.0"}'), url);
    };
    const result = await makeCatalogFetcher({ allowNetwork: true })(source('https://example.com/c.json'));
    expect(result).toEqual({ schema_version: '1.0' });
    expect(captured.url).toBe('https://example.com/c.json');
    expect(() => captured.validator!('https://example.com/c.json', 'http://evil.example/c.json')).toThrow('must use HTTPS');
    expect(() => captured.validator!('https://example.com/c.json', 'https://cdn.example/c.json')).not.toThrow();
  });

  test('rejects non-https final url', async () => {
    adapterDeps.openUrl = async () => new FakeResponse(Buffer.from('{}'), 'http://evil.example/c.json');
    await rejects(makeCatalogFetcher()(source('https://example.com/c.json')), 'must use HTTPS');
  });

  test('bounds catalog response size (not downgraded to unavailable)', async () => {
    const body = Buffer.from('{"schema_version":"1.0","bundles":{}}');
    adapterDeps.openUrl = async (url) => new FakeResponse(body, url);
    adapterDeps.maxJsonCatalogBytes = async () => body.length - 1;
    const err = await rejects(httpGetJson('team', 'https://example.com/c.json'), 'exceeds maximum size');
    expect(err).not.toBeInstanceOf(CatalogUnavailable);
  });

  test('connection errors and 5xx/408/429 are unavailable; other 4xx are hard errors', async () => {
    adapterDeps.openUrl = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    };
    await rejects(httpGetJson('team', 'https://example.com/c.json'), 'fetch failed', CatalogUnavailable);

    for (const status of [503, 408, 429]) {
      adapterDeps.openUrl = async () => {
        throw Object.assign(new Error('HTTP Error'), { status, reason: 'Service Unavailable' });
      };
      await rejects(httpGetJson('team', 'https://example.com/c.json'), String(status), CatalogUnavailable);
    }

    adapterDeps.openUrl = async () => {
      throw Object.assign(new Error('HTTP Error'), { code: 404, reason: 'Not Found' });
    };
    const err = await rejects(httpGetJson('team', 'https://example.com/c.json'), 'Failed to fetch catalog from https://example.com/c.json: HTTP 404 Not Found');
    expect(err).not.toBeInstanceOf(CatalogUnavailable);
  });

  test('fetch Response with error status is classified', async () => {
    adapterDeps.openUrl = async () => new Response('nope', { status: 500, statusText: 'Internal Server Error' });
    await rejects(httpGetJson('team', 'https://example.com/c.json'), 'HTTP 500 Internal Server Error', CatalogUnavailable);
  });

  test('redirect-policy and TLS certificate errors are never unavailable', async () => {
    adapterDeps.openUrl = async () => {
      throw Object.assign(new Error('redirect to http refused'), { name: 'RedirectPolicyError' });
    };
    let err = await rejects(httpGetJson('team', 'https://example.com/c.json'), 'redirect to http refused');
    expect(err).not.toBeInstanceOf(CatalogUnavailable);
    adapterDeps.openUrl = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } });
    };
    err = await rejects(httpGetJson('team', 'https://example.com/c.json'), 'Failed to fetch catalog');
    expect(err).not.toBeInstanceOf(CatalogUnavailable);
  });

  test('malformed JSON and invalid UTF-8 are content errors', async () => {
    adapterDeps.openUrl = async (url) => new FakeResponse(Buffer.from('not json'), url);
    let err = await rejects(httpGetJson('team', 'https://example.com/c.json'), 'Invalid JSON from https://example.com/c.json');
    expect(err).not.toBeInstanceOf(CatalogUnavailable);
    adapterDeps.openUrl = async (url) => new FakeResponse(Buffer.from([0xff, 0xfe]), url);
    err = await rejects(httpGetJson('team', 'https://example.com/c.json'), 'not valid UTF-8');
    expect(err).not.toBeInstanceOf(CatalogUnavailable);
  });

  test.each([['https://[::1'], ['https://example.com:notaport/catalog.json'], ['https://example.com:70000/catalog.json']])(
    'malformed source url rejected cleanly (%p)',
    async (url) => {
      await rejects(makeCatalogFetcher()(source(url)), 'URL is malformed');
    },
  );

  test('validateRemoteUrl', () => {
    for (const url of ['https://:8080/c.json', 'https://user@/c.json', 'https:///c.json']) {
      expect(() => validateRemoteUrl('team', url)).toThrow("Catalog 'team' URL must be a valid URL with a host");
    }
    expect(() => validateRemoteUrl('team', 'https://example.com/c.json')).not.toThrow();
    expect(() => validateRemoteUrl('team', 'http://localhost:8000/c.json')).not.toThrow();
    expect(() => validateRemoteUrl('team', 'https://[::1')).toThrow("Catalog 'team' URL is malformed: https://[::1");
  });
});

// ============================================================================
// adapters: built-in catalogs & offline
// ============================================================================

describe('adapters builtin/offline', () => {
  function writeSnapshot(name: string): void {
    mkdirSync(path.join(tmp, 'bundles'), { recursive: true });
    writeFileSync(
      path.join(tmp, 'bundles', name),
      JSON.stringify({ schema_version: '1.0', bundles: { packaged: catalogEntryDict('packaged') } }),
    );
  }

  test.each([
    ['builtin://default', 'https://raw.githubusercontent.com/github/spec-kit/main/bundles/catalog.json'],
    ['builtin://community', 'https://raw.githubusercontent.com/github/spec-kit/main/bundles/catalog.community.json'],
  ])('%s fetches the repository catalog online', async (builtin, expected) => {
    const captured: string[] = [];
    adapterDeps.httpGetJson = async (sourceId, url) => {
      captured.push(sourceId, url);
      return { schema_version: '1.0', bundles: {} };
    };
    const result = (await makeCatalogFetcher({ allowNetwork: true })(source(builtin))) as { bundles: unknown };
    expect(result.bundles).toEqual({});
    expect(captured).toEqual(['team', expected]);
  });

  test.each([['builtin://default', 'catalog.json'], ['builtin://community', 'catalog.community.json']])(
    '%s falls back to the snapshot on availability errors (with warning)',
    async (builtin, snapshot) => {
      writeSnapshot(snapshot);
      adapterDeps.locateCorePack = async () => tmp;
      adapterDeps.httpGetJson = async () => {
        throw new CatalogUnavailable('repository unavailable');
      };
      const warnings: string[] = [];
      adapterDeps.warn = (m) => warnings.push(m);
      const result = (await makeCatalogFetcher({ allowNetwork: true })(source(builtin))) as { bundles: object };
      expect(Object.keys(result.bundles)).toEqual(['packaged']);
      expect(warnings).toEqual([`Built-in catalog '${builtin}' is unavailable (repository unavailable); using the packaged snapshot.`]);
    },
  );

  test('validation errors are not masked by the snapshot', async () => {
    writeSnapshot('catalog.json');
    adapterDeps.locateCorePack = async () => tmp;
    adapterDeps.httpGetJson = async () => {
      throw new BundlerError('Invalid catalog payload');
    };
    await rejects(makeCatalogFetcher()(source('builtin://default')), 'Invalid catalog payload');
  });

  test('offline uses the snapshot quietly', async () => {
    writeSnapshot('catalog.community.json');
    adapterDeps.locateCorePack = async () => tmp;
    const warnings: string[] = [];
    adapterDeps.warn = (m) => warnings.push(m);
    const result = (await makeCatalogFetcher({ allowNetwork: false })(source('builtin://community'))) as { bundles: object };
    expect(Object.keys(result.bundles)).toEqual(['packaged']);
    expect(warnings).toEqual([]);
  });

  test('packaged first-party catalog resolves offline', async () => {
    const stack = new CatalogStack([source('builtin://default', 'default')], makeCatalogFetcher({ allowNetwork: false }));
    const results = await stack.search();
    expect(results.map((r) => r.entry.id).sort()).toEqual(['assess', 'bugfix']);
    expect(results.every((r) => r.installAllowed)).toBe(true);
    expect((await stack.resolve('bugfix')).entry.id).toBe('bugfix');
  });

  test('builtin failure does not block a lower-priority source', async () => {
    adapterDeps.httpGetJson = async () => {
      throw new CatalogUnavailable('repository unavailable');
    };
    adapterDeps.locateCorePack = async () => path.join(tmp, 'nowhere');
    adapterDeps.warn = () => undefined;
    const cat = writeCatalogFile(path.join(tmp, 'team.json'), { mine: catalogEntryDict('mine') });
    const stack = new CatalogStack(
      [source('builtin://default', 'default'), new CatalogSource({ id: 'team', url: cat, priority: 10, install_policy: 'install-allowed' })],
      makeCatalogFetcher({ allowNetwork: true }),
    );
    await rejects(stack.resolve('mine'), 'Bundled catalog not found');
  });

  test('unknown builtin and unsupported scheme', async () => {
    await rejects(makeCatalogFetcher()(source('builtin://nope')), "Unknown built-in catalog 'builtin://nope'.");
    await rejects(makeCatalogFetcher()(source('ftp://example.com/c.json')), 'Unsupported catalog URL scheme: ftp://example.com/c.json');
  });

  test('file paths and file:// URLs resolve offline; missing file errors', async () => {
    const cat = writeCatalogFile(path.join(tmp, 'c.json'), { x: catalogEntryDict('x') });
    const fetcher = makeCatalogFetcher({ allowNetwork: false });
    expect(((await fetcher(source(cat))) as { bundles: object }).bundles).toHaveProperty('x');
    expect(((await fetcher(source(pathToFileURL(cat).href))) as { bundles: object }).bundles).toHaveProperty('x');
    await rejects(fetcher(source(path.join(tmp, 'missing.json'))), 'Catalog file not found:');
  });

  test('local catalog decode errors are wrapped', async () => {
    const p = path.join(tmp, 'bad.json');
    writeFileSync(p, Buffer.from([0xff, 0xfe, 0x7b, 0x00]));
    await rejects(makeCatalogFetcher()(source(p)), `Could not read ${p}`);
    await rejects(makeCatalogFetcher()(source(pathToFileURL(p).href)), 'Could not read');
  });

  test('http refused offline; plain http and host-less rejected before network', async () => {
    let called = false;
    adapterDeps.openUrl = async () => {
      called = true;
      return new FakeResponse(Buffer.from('{}'), '');
    };
    await rejects(
      makeCatalogFetcher({ allowNetwork: false })(source('https://example.com/c.json')),
      "Network access disabled; cannot fetch catalog 'team' from https://example.com/c.json.",
    );
    await rejects(makeCatalogFetcher()(source('http://example.com/c.json')), 'must use HTTPS (got http://)');
    await rejects(makeCatalogFetcher()(source('https:///c.json')), 'must be a valid URL with a host');
    expect(called).toBe(false);
  });
});

// ============================================================================
// sources: local
// ============================================================================

describe('local manifest sources', () => {
  test('non-path returns null', async () => {
    expect(await localManifestSource('definitely-not-a-path-xyz')).toBeNull();
  });

  test('directory and bundle.yml', async () => {
    const dir = path.join(tmp, 'b');
    const manifestPath = writeManifest(dir);
    expect((await localManifestSource(dir))!.bundle.id).toBe('demo-bundle');
    expect((await localManifestSource(manifestPath))!.bundle.id).toBe('demo-bundle');
    mkdirSync(path.join(tmp, 'empty'));
    await rejects(localManifestSource(path.join(tmp, 'empty')), 'No bundle.yml found in');
  });

  test('zip artifact', async () => {
    const artifact = path.join(tmp, 'demo.zip');
    writeFileSync(
      artifact,
      buildZip([
        { name: 'bundle.yml', data: Buffer.from(dumpYaml(validManifestDict())), mode: 0o644 },
        { name: 'README.md', data: Buffer.from('# x'), mode: 0o644 },
      ]),
    );
    expect((await localManifestSource(artifact))!.bundle.version).toBe('1.2.0');
    const noManifest = path.join(tmp, 'none.zip');
    writeFileSync(noManifest, buildZip([{ name: 'README.md', data: Buffer.from('x'), mode: 0o644 }]));
    await rejects(localManifestSource(noManifest), `Artifact '${noManifest}' does not contain a bundle.yml.`);
  });

  test('unknown file type rejected', async () => {
    const p = path.join(tmp, 'thing.txt');
    writeFileSync(p, 'x');
    await rejects(localManifestSource(p), 'is not a recognised bundle source');
  });

  test('zip manifest must be UTF-8 (UTF-16 rejected like the directory source)', async () => {
    const artifact = path.join(tmp, 'u16.zip');
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(dumpYaml(validManifestDict()), 'utf16le')]);
    writeFileSync(artifact, buildZip([{ name: 'bundle.yml', data: body, mode: 0o644 }]));
    await rejects(localManifestSource(artifact), "Could not read bundle.yml inside '");
  });

  test('zip with malformed YAML is wrapped', async () => {
    const artifact = path.join(tmp, 'bad.zip');
    writeFileSync(artifact, buildZip([{ name: 'bundle.yml', data: Buffer.from('bundle: [unclosed\n  id: demo\n'), mode: 0o644 }]));
    await rejects(localManifestSource(artifact), 'Invalid YAML in bundle.yml inside');
  });

  test('zip uses the bounded archive open', async () => {
    const artifact = path.join(tmp, 'many.zip');
    const members = [{ name: 'bundle.yml', data: Buffer.from(dumpYaml(validManifestDict())), mode: 0o644 }];
    for (let i = 0; i < 512; i++) members.push({ name: `assets/${i}.txt`, data: Buffer.alloc(0), mode: 0o644 });
    writeFileSync(artifact, buildZip(members));
    await rejects(localManifestSource(artifact), 'too many entries');
  });

  test('validateManifestStructure', () => {
    const data = validManifestDict();
    (data.bundle as Record<string, unknown>).author = '';
    expect(() => validateManifestStructure(BundleManifest.fromDict(data), { source: "Local bundle source 'x'" })).toThrow(
      "Local bundle source 'x' contains an invalid bundle manifest:\n  - Missing required field: bundle.author.",
    );
  });
});

// ============================================================================
// sources: remote
// ============================================================================

function resolvedEntry(overrides: Record<string, unknown> = {}): ResolvedBundle {
  const entry = CatalogEntry.fromDict(
    catalogEntryDict('demo-bundle', { download_url: 'https://example.com/demo-bundle.yml', ...overrides }),
  );
  return new ResolvedBundle(entry, source('https://example.com/c.json'));
}

function patchDownload(body: Uint8Array): void {
  sourceDeps.openUrl = async (url) => new FakeResponse(body, url);
}

describe('remote manifest download', () => {
  test('file URLs, bare paths and scheme-less values rejected', async () => {
    for (const url of ['file:///tmp/bundle.yml', '/tmp/bundle.yml', 'example.com/bundle.zip', 'C:\\bundle.yml']) {
      await rejects(downloadManifest(resolvedEntry({ download_url: url }), { offline: false }), 'has a non-HTTP(S) download_url');
    }
  });

  test('empty download_url', async () => {
    await rejects(
      downloadManifest(resolvedEntry({ download_url: '' }), { offline: false }),
      "Catalog entry 'demo-bundle' has no download_url; cannot resolve its manifest.",
    );
  });

  test('non-https rejected even offline; https offline refused', async () => {
    await rejects(downloadManifest(resolvedEntry({ download_url: 'http://example.com/bundle.zip' }), { offline: true }), 'over non-HTTPS URL');
    await rejects(
      downloadManifest(resolvedEntry(), { offline: true }),
      "Network access disabled; cannot download bundle 'demo-bundle' from https://example.com/demo-bundle.yml.",
    );
  });

  test.each([['https://[::1'], ['https://[not-an-ip]/bundle.yml'], ['https://example.com:notaport/bundle.yml'], ['https://example.com:70000/bundle.yml']])(
    'malformed url (%p) rejected cleanly',
    async (url) => {
      await rejects(downloadManifest(resolvedEntry({ download_url: url }), { offline: true }), /malformed/);
      expect(() => requireHttps("bundle 'x'", url)).toThrow(BundlerError);
    },
  );

  test('bounds remote artifact size', async () => {
    const body = Buffer.from(dumpYaml(validManifestDict()));
    patchDownload(body);
    sourceDeps.readResponseLimited = async (resp, opts) => {
      const mod = await import('../src/download-security.js');
      return mod.readResponseLimited(resp as never, { maxBytes: body.length - 1, errorType: BundlerError, label: opts.label });
    };
    await rejects(downloadManifest(resolvedEntry(), { offline: false }), 'exceeds maximum size');
  });

  test('matching sha256 accepted; legacy entry without sha256 accepted', async () => {
    const body = Buffer.from(dumpYaml(validManifestDict()));
    patchDownload(body);
    const digest = createHash('sha256').update(body).digest('hex');
    expect((await downloadManifest(resolvedEntry({ sha256: `sha256:${digest}` }), { offline: false })).bundle.id).toBe('demo-bundle');
    expect((await downloadManifest(resolvedEntry(), { offline: false })).bundle.version).toBe('1.2.0');
  });

  test.each([['0'.repeat(64)], ['not-a-sha256']])('bad sha256 (%p) rejected', async (declared) => {
    patchDownload(Buffer.from(dumpYaml(validManifestDict())));
    await rejects(downloadManifest(resolvedEntry({ sha256: declared }), { offline: false }), /sha256|Integrity check/);
  });

  test.each([
    ['id', 'other-bundle', "Downloaded bundle id mismatch: catalog entry 'demo-bundle' points to a manifest for 'other-bundle'."],
    ['version', '9.9.9', "Downloaded bundle version mismatch for 'demo-bundle': catalog declares '1.2.0', but the manifest declares '9.9.9'."],
  ])('catalog identity mismatch on %s', async (field, value, message) => {
    const data = validManifestDict();
    (data.bundle as Record<string, unknown>)[field] = value;
    patchDownload(Buffer.from(dumpYaml(data)));
    await rejects(downloadManifest(resolvedEntry(), { offline: false }), message);
  });

  test('invalid structure rejected', async () => {
    const data = validManifestDict();
    (data.bundle as Record<string, unknown>).author = '';
    patchDownload(Buffer.from(dumpYaml(data)));
    await rejects(downloadManifest(resolvedEntry(), { offline: false }), "Downloaded bundle 'demo-bundle' contains an invalid bundle manifest");
  });

  test('zip payload detected by magic bytes; download failures name the url', async () => {
    const zip = buildZip([{ name: 'bundle.yml', data: Buffer.from(dumpYaml(validManifestDict())), mode: 0o644 }]);
    patchDownload(zip);
    expect((await downloadManifest(resolvedEntry({ download_url: 'https://api.example.com/assets/1' }), { offline: false })).bundle.id).toBe(
      'demo-bundle',
    );
    sourceDeps.openUrl = async () => {
      throw new Error('connection reset');
    };
    await rejects(
      downloadManifest(resolvedEntry(), { offline: false }),
      "Failed to download bundle 'demo-bundle' from https://example.com/demo-bundle.yml: connection reset",
    );
  });

  test('invalid YAML payload', async () => {
    patchDownload(Buffer.from('bundle: [unclosed\n'));
    await rejects(downloadManifest(resolvedEntry(), { offline: false }), 'is not valid YAML');
  });

  test('redirect validator enforces HTTPS', async () => {
    let validator: ((a: string, b: string) => void) | undefined;
    sourceDeps.openUrl = async (url, opts) => {
      validator = opts.redirectValidator;
      return new FakeResponse(Buffer.from(dumpYaml(validManifestDict())), url);
    };
    await downloadManifest(resolvedEntry(), { offline: false });
    expect(() => validator!('https://example.com/a', 'http://evil.example/b')).toThrow('over non-HTTPS URL');
  });
});
