/**
 * Exact-release preset catalog lookup, downloads and CLI regressions (port of
 * upstream tests/specify_cli/presets/test_catalog_versions.py, spec-kit v1.2.5).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildZip } from '../src/bundles/packager.js';
import { MAX_JSON_CATALOG_BYTES } from '../src/download-security.js';
import { findDuplicateJsonKey } from '../src/json-unique.js';
import {
  PresetCatalog,
  PresetCatalogEntry,
  PresetCatalogValidationError,
  decodeCatalogJson,
} from '../src/presets/catalog.js';
import { runPresetCommand } from '../src/presets/commands.js';
import { PresetManager } from '../src/presets/manager.js';
import { PresetError, PresetValidationError, setPresetWarningHandler } from '../src/presets/manifest.js';
import { dumpYaml } from '../src/yaml.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDict = Record<string, any>;

const CURRENT_URL = 'https://example.com/preset-current.zip';
const OLD_URL = 'https://example.com/preset-old.zip';

const proto = PresetCatalog.prototype as AnyDict;
const saved: AnyDict = {};
for (const k of ['getMergedPacks', 'openUrl', 'getActiveCatalogs', 'fetchSingleCatalog', 'getPackInfo', 'resolveGithubReleaseAssetApiUrl']) {
  saved[k] = proto[k];
}

let tempDir: string;
let projectDir: string;
let origCwd: string;
let out: string[];
let origOut: typeof process.stdout.write;
let origErr: typeof process.stderr.write;
let savedHome: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'presets-versions-'));
  projectDir = join(tempDir, 'project');
  mkdirSync(join(projectDir, '.specify', 'templates'), { recursive: true });
  writeFileSync(join(projectDir, '.specify', 'templates', 'spec-template.md'), '# Core Spec Template\n');
  origCwd = process.cwd();
  process.chdir(projectDir);
  savedHome = process.env.HOME;
  process.env.HOME = join(tempDir, 'home');
  delete process.env.SPECKIT_PRESET_CATALOG_URL;
  out = [];
  origOut = process.stdout.write.bind(process.stdout);
  origErr = process.stderr.write.bind(process.stderr);
  const capture = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = capture;
  process.stderr.write = capture;
  setPresetWarningHandler(() => undefined);
  proto.resolveGithubReleaseAssetApiUrl = async () => null;
});

afterEach(() => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  setPresetWarningHandler(null);
  process.chdir(origCwd);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  for (const [k, v] of Object.entries(saved)) proto[k] = v;
  rmSync(tempDir, { recursive: true, force: true });
});

const output = (): string => out.join('').split(/\s+/).join(' ');

function archiveBytes(packId = 'sample', version = '1.0.0'): Buffer {
  const manifest = {
    schema_version: '1.0',
    preset: { id: packId, name: 'Sample', version, description: 'Sample preset' },
    requires: { speckit_version: '>=0.1.0' },
    provides: { templates: [{ type: 'template', name: 'spec-template', file: 'templates/spec-template.md' }] },
  };
  return buildZip([
    { name: 'preset.yml', data: Buffer.from(dumpYaml(manifest)), mode: 0o644 },
    { name: 'templates/spec-template.md', data: Buffer.from('# Sample\n'), mode: 0o644 },
  ]);
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function entry(oldBytes: Uint8Array = archiveBytes()): AnyDict {
  return {
    id: 'sample',
    name: 'Sample',
    version: '2.0.0',
    download_url: CURRENT_URL,
    sha256: 'a'.repeat(64),
    requires: { speckit_version: '>=2' },
    provides: { templates: 2 },
    releases: {
      '1.0.0': {
        download_url: OLD_URL,
        sha256: sha(oldBytes),
        requires: { speckit_version: '>=0.1.0' },
        provides: { templates: 0 },
      },
    },
  };
}

function response(data: Uint8Array | string, url: string): Response {
  const resp = new Response(data, { headers: { 'Content-Type': 'application/zip' } });
  Object.defineProperty(resp, 'url', { value: url });
  return resp;
}

function duplicateReleaseJson(): string {
  const e = entry();
  const payload = JSON.stringify({ schema_version: '1.0', presets: { sample: e } });
  const record = `"1.0.0":${JSON.stringify(e.releases['1.0.0'])}`;
  const conflicting = { ...e.releases['1.0.0'], download_url: CURRENT_URL };
  expect(payload.includes(record)).toBe(true);
  return payload.replace(record, `${record},"1.0.0":${JSON.stringify(conflicting)}`);
}

const merged = (packs: AnyDict): void => {
  proto.getMergedPacks = async () => packs;
};

const source = (url: string, name: string, priority: number, installAllowed: boolean): PresetCatalogEntry =>
  new PresetCatalogEntry({ url, name, priority, install_allowed: installAllowed });

describe('duplicate keys', () => {
  for (const legacy of [false, true]) {
    test(`duplicate release key rejected from network (${legacy ? 'single-catalog' : 'stack'})`, async () => {
      const catalog = new PresetCatalog(projectDir) as AnyDict;
      const url = PresetCatalog.DEFAULT_CATALOG_URL;
      catalog.getCatalogUrl = () => url;
      catalog.openUrl = async () => response(duplicateReleaseJson(), url);
      const run = legacy
        ? catalog.fetchCatalog(true)
        : catalog.fetchSingleCatalog(source(url, 'default', 1, true), true);
      await expect(run).rejects.toThrow(/duplicate.*1\.0\.0/);
      expect(existsSync(catalog.cacheFile)).toBe(false);
    });

    test(`duplicate release key in cache refetches (${legacy ? 'single-catalog' : 'stack'})`, async () => {
      const catalog = new PresetCatalog(projectDir) as AnyDict;
      const url = PresetCatalog.DEFAULT_CATALOG_URL;
      mkdirSync(catalog.cacheDir, { recursive: true });
      writeFileSync(catalog.cacheFile, duplicateReleaseJson());
      writeFileSync(catalog.cacheMetadataFile, JSON.stringify({ cached_at: new Date().toISOString(), catalog_url: url }));
      const valid = { schema_version: '1.0', presets: { sample: entry() } };
      let opened = 0;
      catalog.getCatalogUrl = () => url;
      catalog.openUrl = async () => {
        opened += 1;
        return response(JSON.stringify(valid), url);
      };
      const result = legacy ? await catalog.fetchCatalog() : await catalog.fetchSingleCatalog(source(url, 'default', 1, true));
      expect(result).toEqual(valid);
      expect(opened).toBe(1);
      expect(JSON.parse(readFileSync(catalog.cacheFile, 'utf-8'))).toEqual(valid);
    });
  }

  test('nested duplicates are reported before the enclosing object, as object_pairs_hook does', () => {
    expect(findDuplicateJsonKey('{"a":1,"a":2,"b":{"x":1,"x":2}}')).toBe('x');
    expect(findDuplicateJsonKey('{"a":[{"k":1},{"k":2}],"b":"a\\"a"}')).toBeNull();
  });

  test('decode errors are catalog validation errors', () => {
    expect(() => decodeCatalogJson('{"schema_version":', 'u')).toThrow(PresetCatalogValidationError);
    expect(() => decodeCatalogJson('{"schema_version":', 'u')).toThrow(/invalid JSON/);
    expect(() => decodeCatalogJson(new Uint8Array([0x7b, 0xff, 0x7d]), 'u')).toThrow(/invalid encoding/);
  });
});

describe('release selection', () => {
  test('current and exact selection keep current fields', async () => {
    const catalog = new PresetCatalog(projectDir);
    merged({ sample: entry() });
    const current = (await catalog.getPackInfo('sample'))!;
    const old = (await catalog.getPackInfo('sample', '1.0'))!;
    expect(await catalog.getPackInfo('sample', '0.4.12')).toBeNull();
    expect(await catalog.getPackVersions('sample')).toEqual(['2.0.0', '1.0.0']);
    expect(current.version).toBe('2.0.0');
    expect(current.download_url).toBe(CURRENT_URL);
    expect(old.version).toBe('1.0.0');
    expect(old.download_url).toBe(OLD_URL);
    expect(old.requires).toEqual({ speckit_version: '>=0.1.0' });
    expect(old.provides).toEqual({ templates: 0 });
    expect(old.sha256).not.toBe(current.sha256);
    expect('releases' in old).toBe(false);
  });

  test('single release entry remains compatible', async () => {
    const catalog = new PresetCatalog(projectDir);
    merged({ sample: { name: 'Legacy', version: '1.0.0', download_url: OLD_URL } });
    expect((await catalog.getPackInfo('sample'))!.version).toBe('1.0.0');
    expect((await catalog.getPackInfo('sample', '1.0'))!.version).toBe('1.0.0');
    expect(await catalog.getPackInfo('sample', '2.0')).toBeNull();
    expect(await catalog.getPackVersions('sample')).toEqual(['1.0.0']);
  });

  const f64 = 'f'.repeat(64);
  const malformed: Array<[AnyDict, string]> = [
    [{ releases: [] }, 'releases mapping'],
    [{ version: null }, 'current version'],
    [{ version: 'garbage' }, 'current version'],
    [{ releases: { '2.0': { download_url: OLD_URL, sha256: f64 } } }, 'repeats'],
    [{ releases: { '1.0': { download_url: OLD_URL, sha256: f64 }, '1.0.0': { download_url: OLD_URL, sha256: f64 } } }, 'repeats'],
    [{ releases: { oops: {} } }, 'release version'],
    [{ releases: { '1.0': [] } }, 'must be an object'],
    [{ releases: { '1.0': { sha256: f64 } } }, 'download_url'],
    [{ releases: { '1.0': { download_url: 'http://evil.test/a.zip', sha256: f64 } } }, 'download_url'],
    [{ releases: { '1.0': { download_url: OLD_URL, sha256: 'broken' } } }, 'SHA-256'],
    [{ releases: { '1.0': { download_url: OLD_URL, sha256: 'md5:' + f64 } } }, 'SHA-256'],
    [{ releases: { '1.0': { download_url: OLD_URL, sha256: f64, version: '1.0' } } }, 'reserved'],
    [{ releases: { '1.0': { download_url: OLD_URL, sha256: f64, requires: [] } } }, 'requires'],
    [{ releases: { '1.0': { download_url: OLD_URL, sha256: f64, requires: { speckit_version: 2 } } } }, 'requires.speckit_version'],
    [
      { releases: { '1.0': { download_url: OLD_URL, sha256: f64, requires: { speckit_version: 'not a specifier' } } } },
      'requires.speckit_version',
    ],
    [{ id: 'other' }, 'inconsistent'],
  ];
  for (const [i, [change, error]] of malformed.entries()) {
    test(`malformed history rejected even for current (${i}: ${error})`, async () => {
      merged({ sample: { ...entry(), ...change } });
      await expect(new PresetCatalog(projectDir).getPackInfo('sample')).rejects.toThrow(error);
    });
  }

  const badDeps: unknown[] = [[123], [{}], [{ id: 'dep', version: 2 }], [{ id: 'dep', required: 0 }], ['bad id']];
  for (const [i, deps] of badDeps.entries()) {
    test(`historical release rejects malformed extension dependencies (${i})`, async () => {
      const e = entry();
      e.releases['1.0.0'].requires.extensions = deps;
      merged({ sample: e });
      await expect(new PresetCatalog(projectDir).getPackInfo('sample')).rejects.toThrow('requires.extensions');
    });
  }

  test('historical release accepts manifest extension dependencies', async () => {
    const deps = ['plain-ext', { id: 'other-ext', version: '>=1.2', required: false }];
    const e = entry();
    e.releases['1.0.0'].requires.extensions = deps;
    merged({ sample: e });
    const selected = (await new PresetCatalog(projectDir).getPackInfo('sample', '1.0.0'))!;
    expect(selected.requires.extensions).toEqual(deps);
  });

  test('malformed history: info reports the validation error', async () => {
    merged({ sample: { ...entry(), releases: [] } });
    await expect(new PresetCatalog(projectDir).getPackInfo('sample')).rejects.toBeInstanceOf(PresetCatalogValidationError);
    expect(await runPresetCommand(['info', 'sample'])).toBe(1);
    expect(output()).toContain('invalid releases mapping');
    expect(output()).not.toContain('not found');
  });

  test('historical release does not inherit current requirements', async () => {
    const e = entry();
    delete e.releases['1.0.0'].requires;
    delete e.releases['1.0.0'].provides;
    merged({ sample: e });
    const selected = (await new PresetCatalog(projectDir).getPackInfo('sample', '1.0.0'))!;
    expect('requires' in selected).toBe(false);
    expect('provides' in selected).toBe(false);
  });
});

describe('catalog stack resolution', () => {
  test('winning source does not fall back to a lower release', async () => {
    const catalog = new PresetCatalog(projectDir) as AnyDict;
    const older = { ...entry(), version: '3.0.0' };
    const higher = { version: '2.0.0', download_url: CURRENT_URL };
    catalog.getActiveCatalogs = () => [
      source('https://example.com/high.json', 'high', 1, true),
      source('https://example.com/low.json', 'low', 2, true),
    ];
    catalog.fetchSingleCatalog = async (s: PresetCatalogEntry) => ({ presets: { sample: s.name === 'high' ? higher : older } });
    expect((await catalog.getPackInfo('sample'))._catalog_name).toBe('high');
    expect(await catalog.getPackInfo('sample', '1.0.0')).toBeNull();
  });

  const invalidPayloads: Array<[string, () => string | Uint8Array, string]> = [
    ['duplicate', duplicateReleaseJson, 'duplicate JSON key'],
    ['format', () => '{"schema_version": "1.0", "presets": []}', 'Invalid preset catalog format'],
    ['json', () => '{"schema_version":', 'invalid JSON'],
    ['encoding', () => Buffer.concat([Buffer.from('{"schema_version":"1.0","presets":'), Buffer.from([0xff]), Buffer.from('}')]), 'invalid encoding'],
  ];
  for (const [label, bad, error] of invalidPayloads) {
    test(`an invalid discovery catalog cannot delegate install (${label})`, async () => {
      const highUrl = 'https://example.com/discovery.json';
      const lowUrl = 'https://example.com/trusted.json';
      proto.getActiveCatalogs = () => [source(highUrl, 'discovery', 1, false), source(lowUrl, 'trusted', 2, true)];
      const oldBytes = archiveBytes();
      const lower = JSON.stringify({ schema_version: '1.0', presets: { sample: entry(oldBytes) } });
      const invalid = bad();
      const opened: string[] = [];
      proto.openUrl = async (url: string) => {
        opened.push(url);
        const data = { [highUrl]: invalid, [lowUrl]: lower, [OLD_URL]: oldBytes }[url]!;
        return response(data, url);
      };
      await expect(new PresetCatalog(projectDir).getPackInfo('sample', '1.0.0')).rejects.toThrow(error);
      expect(await runPresetCommand(['add', 'sample', '--version', '1.0.0'])).toBe(1);
      expect(output()).toContain(error);
      out.length = 0;
      expect(await runPresetCommand(['info', 'sample'])).toBe(1);
      expect(output()).toContain(error);
      out.length = 0;
      expect(await runPresetCommand(['search', 'sample'])).toBe(1);
      expect(output()).toContain(error);
      expect(opened).not.toContain(OLD_URL);
      expect(new PresetManager(projectDir).getPack('sample')).toBeNull();
    });
  }

  test('a malformed matching discovery entry prevents a lower install', async () => {
    const highUrl = 'https://example.com/discovery.json';
    const lowUrl = 'https://example.com/trusted.json';
    proto.getActiveCatalogs = () => [source(highUrl, 'discovery', 1, false), source(lowUrl, 'trusted', 2, true)];
    const oldBytes = archiveBytes();
    const upper = '{"schema_version":"1.0","presets":{"sample":[]}}';
    const lower = JSON.stringify({ schema_version: '1.0', presets: { sample: entry(oldBytes) } });
    const opened: string[] = [];
    proto.openUrl = async (url: string) => {
      opened.push(url);
      return response({ [highUrl]: upper, [lowUrl]: lower, [OLD_URL]: oldBytes }[url]!, url);
    };
    const catalog = new PresetCatalog(projectDir);
    await expect(catalog.getPackInfo('sample', '1.0.0')).rejects.toThrow('expected a JSON object');
    expect(await runPresetCommand(['add', 'sample', '--version', '1.0.0'])).toBe(1);
    expect(output()).toContain('expected a JSON object');
    out.length = 0;
    expect(await runPresetCommand(['info', 'sample'])).toBe(1);
    expect(output()).toContain('expected a JSON object');
    const results = await catalog.search({ query: 'sample' });
    expect(results[0]._catalog_name).toBe('trusted');
    expect(opened).not.toContain(OLD_URL);
    expect(new PresetManager(projectDir).getPack('sample')).toBeNull();
  });

  for (const malformedWinner of [true, false]) {
    test(`search validates only the winning release history (${malformedWinner ? 'winner' : 'shadowed'})`, async () => {
      const catalog = new PresetCatalog(projectDir);
      proto.getActiveCatalogs = () => [
        source('https://example.com/official.json', 'official', 1, true),
        source('https://example.com/community.json', 'community', 2, false),
      ];
      const invalid = { ...entry(), releases: [] };
      const valid = entry();
      proto.fetchSingleCatalog = async (s: PresetCatalogEntry) => ({
        presets: { sample: (s.name === 'official') === malformedWinner ? invalid : valid },
      });
      if (malformedWinner) {
        await expect(catalog.search({ query: 'sample' })).rejects.toThrow('releases mapping');
        expect(await runPresetCommand(['search', 'sample'])).toBe(1);
        expect(output()).toContain('releases mapping');
      } else {
        const matches = await catalog.search({ query: 'sample' });
        expect(matches.length).toBe(1);
        expect(matches[0]._catalog_name).toBe('official');
      }
    });
  }

  test('a valid higher-priority ID ignores an invalid lower catalog', async () => {
    const highUrl = 'https://example.com/official.json';
    const lowUrl = 'https://example.com/community.json';
    proto.getActiveCatalogs = () => [source(highUrl, 'official', 1, true), source(lowUrl, 'community', 2, false)];
    const arch = archiveBytes();
    const higher = JSON.stringify({ schema_version: '1.0', presets: { sample: entry(arch) } });
    const opened: string[] = [];
    proto.openUrl = async (url: string) => {
      opened.push(url);
      return response({ [highUrl]: higher, [lowUrl]: '{"schema_version":', [OLD_URL]: arch }[url]!, url);
    };
    const catalog = new PresetCatalog(projectDir);
    const selected = (await catalog.getPackInfo('sample', '1.0.0'))!;
    expect(await runPresetCommand(['info', 'sample', '--versions'])).toBe(0);
    expect(output()).toContain('1.0.0');
    expect(await runPresetCommand(['add', 'sample', '--version', '1.0.0'])).toBe(0);
    expect(opened).not.toContain(lowUrl);
    await expect(catalog.search({ query: 'sample' })).rejects.toThrow('invalid JSON');
    expect(selected.version).toBe('1.0.0');
    expect(selected._catalog_name).toBe('official');
    expect(opened).toContain(lowUrl);
    expect(opened.filter((u) => u === OLD_URL).length).toBe(1);
    expect(new PresetManager(projectDir).getPack('sample')!.version).toBe('1.0.0');
  });

  test('an oversized discovery catalog cannot delegate install', async () => {
    const highUrl = 'https://example.com/discovery.json';
    const lowUrl = 'https://example.com/trusted.json';
    proto.getActiveCatalogs = () => [source(highUrl, 'discovery', 1, false), source(lowUrl, 'trusted', 2, true)];
    const lower = JSON.stringify({ schema_version: '1.0', presets: { sample: entry() } });
    const oversized = JSON.stringify({ schema_version: '1.0', presets: { sample: entry() }, padding: 'x'.repeat(MAX_JSON_CATALOG_BYTES) });
    const opened: string[] = [];
    proto.openUrl = async (url: string) => {
      opened.push(url);
      return response({ [highUrl]: oversized, [lowUrl]: lower }[url]!, url);
    };
    await expect(new PresetCatalog(projectDir).getPackInfo('sample', '1.0.0')).rejects.toThrow('exceeds maximum size');
    expect(await runPresetCommand(['add', 'sample', '--version', '1.0.0'])).toBe(1);
    expect(output()).toContain('exceeds maximum size');
    expect(opened).not.toContain(OLD_URL);
    expect(new PresetManager(projectDir).getPack('sample')).toBeNull();
  });

  test('an unreachable high-priority catalog still uses the lower source', async () => {
    const catalog = new PresetCatalog(projectDir) as AnyDict;
    catalog.getActiveCatalogs = () => [
      source('https://example.com/unavailable.json', 'high', 1, false),
      source('https://example.com/trusted.json', 'low', 2, true),
    ];
    catalog.fetchSingleCatalog = async (s: PresetCatalogEntry) => {
      if (s.name === 'high') throw new PresetError('Failed to fetch preset catalog: offline');
      return { presets: { sample: entry() } };
    };
    const selected = await catalog.getPackInfo('sample', '1.0.0');
    expect(selected._catalog_name).toBe('low');
    expect(selected._install_allowed).toBe(true);
  });

  test('versions report an all-source outage instead of a missing preset', async () => {
    proto.getActiveCatalogs = () => [
      source('https://example.com/high.json', 'high', 1, true),
      source('https://example.com/low.json', 'low', 2, true),
    ];
    proto.fetchSingleCatalog = async (s: PresetCatalogEntry) => {
      throw new PresetError(`Failed to fetch preset catalog from ${s.url}: offline`);
    };
    await expect(new PresetCatalog(projectDir).getPackInfo('sample')).rejects.toThrow('high.json: offline');
    expect(await runPresetCommand(['info', 'sample', '--versions'])).toBe(1);
    expect(output()).toContain('high.json:');
    expect(output()).toContain('offline');
    expect(output()).not.toContain('No catalog versions found');
  });

  test('versions report a missing preset when the catalog is readable', async () => {
    proto.getActiveCatalogs = () => [
      source('https://example.com/high.json', 'high', 1, true),
      source('https://example.com/low.json', 'low', 2, true),
    ];
    proto.fetchSingleCatalog = async (s: PresetCatalogEntry) => {
      if (s.name === 'high') throw new PresetError(`Failed to fetch preset catalog from ${s.url}: offline`);
      return { presets: { 'another-preset': entry() } };
    };
    expect(await new PresetCatalog(projectDir).getPackInfo('sample')).toBeNull();
    expect(await runPresetCommand(['info', 'sample', '--versions'])).toBe(1);
    expect(output()).toContain('No catalog versions found for sample');
    expect(output()).not.toContain('offline');
  });

  test('a discovery-only winner does not delegate an exact release', async () => {
    const catalog = new PresetCatalog(projectDir) as AnyDict;
    catalog.getActiveCatalogs = () => [
      source('https://example.com/high.json', 'discovery', 1, false),
      source('https://example.com/low.json', 'trusted', 2, true),
    ];
    catalog.fetchSingleCatalog = async () => ({ presets: { sample: entry() } });
    let opened = 0;
    catalog.openUrl = async () => {
      opened += 1;
      throw new Error('unexpected');
    };
    const selected = await catalog.getPackInfo('sample', '1.0');
    expect(selected._catalog_name).toBe('discovery');
    await expect(catalog.downloadPackInfo(selected, projectDir)).rejects.toThrow('does not allow installation');
    expect(opened).toBe(0);
  });
});

describe('downloading a selected release', () => {
  for (const [label, fmt] of [
    ['plain', (d: string) => ` ${d} `],
    ['prefix', (d: string) => ` sha256:${d} `],
    ['uppercase-prefix', (d: string) => ` SHA256: ${d} `],
  ] as const) {
    test(`historical digest accepts download-supported forms (${label})`, async () => {
      const oldBytes = archiveBytes();
      const e = entry(oldBytes);
      e.releases['1.0.0'].sha256 = fmt(sha(oldBytes));
      const catalog = new PresetCatalog(projectDir) as AnyDict;
      catalog.getMergedPacks = async () => ({ sample: e });
      const selected = await catalog.getPackInfo('sample', '1.0.0');
      catalog.openUrl = async () => response(oldBytes, OLD_URL);
      const downloaded = await catalog.downloadPackInfo(selected, projectDir);
      expect(readFileSync(downloaded).equals(oldBytes)).toBe(true);
    });
  }

  test('uses the old url and digest without a second lookup', async () => {
    const oldBytes = archiveBytes();
    const catalog = new PresetCatalog(projectDir) as AnyDict;
    catalog.getMergedPacks = async () => ({ sample: { ...entry(oldBytes), _install_allowed: true, _catalog_name: 'trusted' } });
    const selected = await catalog.getPackInfo('sample', '1.0');
    catalog.getPackInfo = () => {
      throw new Error('re-lookup');
    };
    const urls: string[] = [];
    catalog.openUrl = async (url: string) => {
      urls.push(url);
      return response(oldBytes, OLD_URL);
    };
    const saved = await catalog.downloadPackInfo(selected, projectDir);
    expect(readFileSync(saved).equals(oldBytes)).toBe(true);
    expect(urls[0]).toBe(OLD_URL);
  });

  test('rejects a discovery-only source, a wrong digest and an unsafe redirect', async () => {
    const oldBytes = archiveBytes();
    const selected: AnyDict = {
      id: 'sample',
      version: '1.0.0',
      download_url: OLD_URL,
      sha256: sha(oldBytes),
      _install_allowed: false,
      _catalog_name: 'community',
    };
    const catalog = new PresetCatalog(projectDir) as AnyDict;
    let opened = 0;
    catalog.openUrl = async () => {
      opened += 1;
      return response(oldBytes, OLD_URL);
    };
    await expect(catalog.downloadPackInfo(selected, projectDir)).rejects.toThrow('does not allow installation');
    expect(opened).toBe(0);
    selected._install_allowed = true;
    catalog.openUrl = async () => response('wrong', OLD_URL);
    await expect(catalog.downloadPackInfo(selected, projectDir)).rejects.toThrow(/[Ii]ntegrity/);
    catalog.openUrl = async () => response(oldBytes, 'http://evil.test/a.zip');
    await expect(catalog.downloadPackInfo(selected, projectDir)).rejects.toThrow('disallowed URL');
    expect(readdirSync(projectDir).filter((n) => n.startsWith('sample-') && n.endsWith('.zip'))).toEqual([]);
  });

  test('rejects an unsafe intermediate redirect', async () => {
    const selected = { id: 'sample', version: '1.0.0', download_url: OLD_URL, sha256: 'f'.repeat(64), _install_allowed: true };
    const catalog = new PresetCatalog(projectDir) as AnyDict;
    catalog.openUrl = async (_url: string, _t: number, _h: unknown, validator: (a: string, b: string) => void) => {
      validator(OLD_URL, 'http://evil.test/transit');
      return response(archiveBytes(), OLD_URL);
    };
    await expect(catalog.downloadPackInfo(selected, projectDir)).rejects.toThrow('disallowed URL');
  });

  for (const historical of [false, true]) {
    test(`a direct localhost https download needs no redirect (${historical ? 'historical' : 'current'})`, async () => {
      const arch = archiveBytes();
      const url = 'https://dev.localhost/preset.zip';
      const selected = { id: 'sample', version: '1.0.0', download_url: url, sha256: sha(arch), _install_allowed: true };
      const catalog = new PresetCatalog(projectDir) as AnyDict;
      catalog.getPackInfo = async () => selected;
      catalog.openUrl = async () => response(arch, url);
      const savedPath = historical
        ? await catalog.downloadPackInfo(selected, projectDir)
        : await catalog.downloadPack('sample', projectDir);
      expect(readFileSync(savedPath).equals(arch)).toBe(true);
    });
  }

  test('rejects an actual redirect to localhost https', async () => {
    const selected = { id: 'sample', version: '1.0.0', download_url: OLD_URL, _install_allowed: true };
    const catalog = new PresetCatalog(projectDir) as AnyDict;
    catalog.openUrl = async () => response(archiveBytes(), 'https://dev.localhost/preset.zip');
    await expect(catalog.downloadPackInfo(selected, projectDir)).rejects.toThrow('disallowed URL');
  });
});

describe('archive identity', () => {
  for (const [badId, badVersion] of [
    ['other', '1.0.0'],
    ['sample', '2.0.0'],
  ]) {
    test(`checked before install (${badId} ${badVersion})`, () => {
      const archivePath = join(tempDir, 'sample.zip');
      writeFileSync(archivePath, archiveBytes(badId, badVersion));
      const manager = new PresetManager(projectDir);
      expect(() =>
        manager.installFromZip(archivePath, '1.0.0', 10, { expectedId: 'sample', expectedVersion: '1.0.0' }),
      ).toThrow(/does not match catalog/);
      expect(manager.registry.isInstalled(badId)).toBe(false);
    });
  }

  test('a mismatch does not replace an installed preset', () => {
    const good = join(tempDir, 'good.zip');
    const bad = join(tempDir, 'bad.zip');
    writeFileSync(good, archiveBytes('sample', '1.0.0'));
    writeFileSync(bad, archiveBytes('sample', '2.0.0'));
    const manager = new PresetManager(projectDir);
    manager.installFromZip(good, '1.0.0');
    let caught: unknown;
    try {
      manager.installFromZip(bad, '1.0.0', 10, { force: true, expectedId: 'sample', expectedVersion: '1.0.0' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PresetValidationError);
    expect(manager.getPack('sample')!.version).toBe('1.0.0');
  });
});

describe('specify preset add --version / info --versions', () => {
  test('installs the exact archive and lists versions', async () => {
    const oldBytes = archiveBytes();
    const urls: string[] = [];
    merged({ sample: { ...entry(oldBytes), _catalog_name: 'trusted', _install_allowed: true } });
    proto.openUrl = async (url: string) => {
      urls.push(url);
      return response(oldBytes, url);
    };
    expect(await runPresetCommand(['info', 'sample', '--versions'])).toBe(0);
    expect(output()).toContain('2.0.0 (current)');
    expect(output()).toContain('1.0.0');
    expect(await runPresetCommand(['add', 'sample', '--version', '1.0'])).toBe(0);
    expect(urls).toEqual([OLD_URL]);
    expect(new PresetManager(projectDir).getPack('sample')!.version).toBe('1.0.0');
  });

  test('versions use the winning entry snapshot', async () => {
    const first = { ...entry(), _install_allowed: false };
    const second = { id: 'sample', version: '3.0.0' };
    const calls: unknown[][] = [];
    proto.getPackInfo = async (...args: unknown[]) => {
      calls.push(args);
      return calls.length === 1 ? first : second;
    };
    expect(await runPresetCommand(['info', 'sample', '--versions'])).toBe(0);
    expect(output()).toContain('2.0.0 (current)');
    expect(output()).toContain('1.0.0');
    expect(output()).not.toContain('3.0.0');
    expect(output()).toContain('Discovery only');
    expect(calls).toEqual([['sample']]);
  });

  test('rejects a missing release and a discovery-only catalog without downloading', async () => {
    let opened = 0;
    proto.openUrl = async () => {
      opened += 1;
      throw new Error('unexpected');
    };
    merged({ sample: { ...entry(), _catalog_name: 'discovery', _install_allowed: false } });
    expect(await runPresetCommand(['info', 'sample', '--versions'])).toBe(0);
    expect(output()).toContain('Discovery only');
    expect(await runPresetCommand(['add', 'sample', '--version', '1.0.0'])).toBe(1);
    expect(output()).toContain('discovery-only');
    merged({ sample: { ...entry(), _catalog_name: 'trusted', _install_allowed: true } });
    out.length = 0;
    expect(await runPresetCommand(['add', 'sample', '--version', '9.0'])).toBe(1);
    expect(output()).toContain('no catalog release');
    expect(opened).toBe(0);
  });

  for (const args of [
    ['add', 'sample', '--from', OLD_URL, '--version', '1.0'],
    ['add', 'sample', '--from', '', '--version', '1.0'],
    ['add', 'sample', '--dev', '.', '--version', '1.0'],
    ['add', 'sample', '--dev', '', '--version', '1.0'],
    ['add', 'sample', '--version', ''],
  ]) {
    test(`rejects --version with a non-catalog source (${args.join(' ')})`, async () => {
      let looked = 0;
      proto.getPackInfo = async () => {
        looked += 1;
        return null;
      };
      expect(await runPresetCommand(args)).toBe(1);
      expect(output()).toContain('--version requires a catalog');
      expect(looked).toBe(0);
    });
  }
});
