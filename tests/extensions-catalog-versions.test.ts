/**
 * Exact releases in an extension catalog (port of upstream
 * tests/specify_cli/extensions/test_catalog_versions.py, spec-kit v1.2.5).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { locateBundledExtension } from '../src/assets.js';
import { buildZip } from '../src/bundles/packager.js';
import { console as richConsole, errConsole } from '../src/console.js';
import { runExtensionCommand } from '../src/extensions/commands.js';
import { ExtensionCatalog, ExtensionError, ExtensionManifest } from '../src/extensions/index.js';
import { dumpYaml, parseYaml } from '../src/yaml.js';
import { type AnyDict, cleanupTempDirs, makeTempDir } from './extensions-helpers.js';

const proto = ExtensionCatalog.prototype as AnyDict;
const saved: AnyDict = {};
for (const k of ['getMergedExtensions', 'downloadExtensionInfo', 'openUrl', 'getActiveCatalogs', 'fetchSingleCatalog', 'resolveGithubReleaseAssetApiUrl']) {
  saved[k] = proto[k];
}
let out: string[] = [];
let origCwd: string;

beforeEach(() => {
  out = [];
  origCwd = process.cwd();
  richConsole.file = { write: (s: string) => out.push(s), isTTY: false, columns: 200 };
  errConsole.file = { write: (s: string) => out.push(s), isTTY: false, columns: 200 };
  proto.resolveGithubReleaseAssetApiUrl = async () => null;
});

afterEach(() => {
  process.chdir(origCwd);
  richConsole.file = process.stdout;
  errConsole.file = process.stderr;
  for (const [k, v] of Object.entries(saved)) proto[k] = v;
  cleanupTempDirs();
});

const output = (): string => out.join('').split(/\s+/).join(' ');

function archive(dir: string, version: string, extensionId = 'demo-history'): string {
  const path = join(dir, `${extensionId}-${version}.zip`);
  const manifest = {
    schema_version: '1.0',
    extension: { id: extensionId, name: 'Demo History', version, description: 'Historical release test' },
    requires: { speckit_version: '>=0.1.0' },
    provides: { commands: [{ name: 'speckit.demo-history.hello', file: 'commands/hello.md' }] },
  };
  writeFileSync(
    path,
    buildZip([
      { name: 'extension.yml', data: Buffer.from(dumpYaml(manifest)), mode: 0o644 },
      { name: 'commands/hello.md', data: Buffer.from('---\ndescription: hello\n---\n\nhi\n'), mode: 0o644 },
    ]),
  );
  return path;
}

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

function entry(oldArchive: string): AnyDict {
  return {
    id: 'demo-history',
    name: 'Demo History',
    description: 'Current description',
    version: '0.5.1',
    download_url: 'https://example.com/demo-0.5.1.zip',
    sha256: 'a'.repeat(64),
    requires: { speckit_version: '>=1.0.0' },
    provides: { commands: 3 },
    _catalog_name: 'trusted',
    _install_allowed: true,
    releases: {
      '0.4.12': {
        download_url: 'https://example.com/demo-0.4.12.zip',
        sha256: sha(oldArchive),
        requires: { speckit_version: '>=0.1.0' },
      },
    },
  };
}

function useEntry(e: AnyDict): void {
  proto.getMergedExtensions = async () => [e];
}

function project(tmp: string): string {
  const p = join(tmp, 'project');
  mkdirSync(join(p, '.specify'), { recursive: true });
  process.chdir(p);
  return p;
}

function archiveResponse(path: string, url: string): Response {
  const resp = new Response(readFileSync(path), { headers: { 'Content-Type': 'application/zip' } });
  Object.defineProperty(resp, 'url', { value: url });
  return resp;
}

const installedVersion = (p: string): unknown =>
  (parseYaml(readFileSync(join(p, '.specify', 'extensions', 'demo-history', 'extension.yml'), 'utf-8')) as AnyDict)
    .extension.version;

describe('catalog release selection', () => {
  test('legacy entry still selects its current release', async () => {
    const e = { id: 'legacy', version: '1.0.0', download_url: 'https://example.com/a.zip' };
    useEntry(e);
    const catalog = new ExtensionCatalog(makeTempDir());
    expect(await catalog.getExtensionInfo('legacy')).toEqual(e);
    expect(await catalog.getExtensionInfo('legacy', '1.0.0')).toEqual(e);
    expect(await catalog.getExtensionInfo('legacy', 'v1.0')).toEqual(e);
    expect(await catalog.getExtensionInfo('legacy', '0.9.0')).toBeNull();
    expect(await catalog.getExtensionVersions('legacy')).toEqual(['1.0.0']);
  });

  test('historical release selects its own url, digest and requirements', async () => {
    const tmp = makeTempDir();
    useEntry(entry(archive(tmp, '0.4.12')));
    const catalog = new ExtensionCatalog(tmp);
    const current = (await catalog.getExtensionInfo('demo-history'))!;
    const old = (await catalog.getExtensionInfo('demo-history', '0.4.12'))!;
    expect(current.download_url.endsWith('0.5.1.zip')).toBe(true);
    expect(old.download_url.endsWith('0.4.12.zip')).toBe(true);
    expect(old.version).toBe('0.4.12');
    expect(old.sha256).not.toBe(current.sha256);
    expect(old.requires).toEqual({ speckit_version: '>=0.1.0' });
    expect('provides' in old).toBe(false);
    expect(old._catalog_name).toBe('trusted');
    expect('releases' in old).toBe(false);
    expect(await catalog.getExtensionInfo('demo-history', '0.3.0')).toBeNull();
    expect(await catalog.getExtensionVersions('demo-history')).toEqual(['0.5.1', '0.4.12']);
  });

  test('equivalent version spelling preserves advertised release', async () => {
    const tmp = makeTempDir();
    const e = entry(archive(tmp, '0.4.12'));
    useEntry(e);
    const catalog = new ExtensionCatalog(tmp);
    expect(await catalog.getExtensionInfo('demo-history', 'v0.5.1')).toEqual(e);
    const historical = (await catalog.getExtensionInfo('demo-history', '0.4.12.0'))!;
    expect(historical.version).toBe('0.4.12');
    expect(historical.download_url).toBe(e.releases['0.4.12'].download_url);
    expect(await catalog.getExtensionInfo('demo-history', 'not-a-version')).toBeNull();
  });

  test('requested version does not fall through to a lower priority catalog', async () => {
    const tmp = makeTempDir();
    const oldArchive = archive(tmp, '0.4.12');
    const high = entry(oldArchive);
    high.releases = {};
    const low = entry(oldArchive);
    const catalog = new ExtensionCatalog(tmp) as AnyDict;
    catalog.getActiveCatalogs = () => [
      { url: 'https://example.com/high.json', name: 'high', priority: 1, install_allowed: true, description: '' },
      { url: 'https://example.com/low.json', name: 'low', priority: 2, install_allowed: true, description: '' },
    ];
    catalog.fetchSingleCatalog = async (source: AnyDict) => ({
      schema_version: '1.0',
      extensions: { 'demo-history': source.name === 'high' ? high : low },
    });
    expect(await catalog.getExtensionInfo('demo-history', '0.4.12')).toBeNull();
    expect(await catalog.getExtensionVersions('demo-history')).toEqual(['0.5.1']);
  });

  const badHistories: unknown[] = [
    [],
    null,
    { 'not-a-version': { download_url: 'https://example.com/a.zip', sha256: 'a'.repeat(64) } },
    { '0.5.1': { download_url: 'https://example.com/a.zip', sha256: 'a'.repeat(64) } },
    { '0.5.1.0': { download_url: 'https://example.com/a.zip', sha256: 'a'.repeat(64) } },
    { '0.4.12': { download_url: 'https://example.com/a.zip' } },
    { '0.4.12': { download_url: 'https://example.com/a.zip', sha256: 'md5:' + 'a'.repeat(64) } },
    { '0.4.12': { download_url: 'https://example.com/a.zip', sha256: 'a'.repeat(64), id: 'other' } },
  ];
  for (const [i, bad] of badHistories.entries()) {
    test(`malformed history is rejected (${i})`, async () => {
      useEntry({ id: 'demo-history', version: '0.5.1', releases: bad });
      const catalog = new ExtensionCatalog(makeTempDir());
      await expect(catalog.getExtensionInfo('demo-history', '0.4.12')).rejects.toBeInstanceOf(ExtensionError);
    });
  }
});

describe('downloading a selected release', () => {
  test('uses its url without a second lookup', async () => {
    const tmp = makeTempDir();
    const arch = archive(tmp, '0.4.12');
    useEntry(entry(arch));
    const catalog = new ExtensionCatalog(tmp) as AnyDict;
    const selected = await catalog.getExtensionInfo('demo-history', '0.4.12');
    const requested: string[] = [];
    catalog.openUrl = async (url: string) => {
      requested.push(url);
      return archiveResponse(arch, url);
    };
    catalog.getExtensionInfo = () => {
      throw new Error('unexpected second lookup');
    };
    const downloaded = await catalog.downloadExtensionInfo(selected, join(tmp, 'downloads'));
    expect(requested).toEqual(['https://example.com/demo-0.4.12.zip']);
    expect(readFileSync(downloaded).equals(readFileSync(arch))).toBe(true);
  });

  test('historical release accepts a prefixed digest', async () => {
    const tmp = makeTempDir();
    const arch = archive(tmp, '0.4.12');
    const e = entry(arch);
    const digest = e.releases['0.4.12'].sha256;
    e.releases['0.4.12'].sha256 = ` SHA256: ${digest.toUpperCase()} `;
    useEntry(e);
    const catalog = new ExtensionCatalog(tmp) as AnyDict;
    const selected = await catalog.getExtensionInfo('demo-history', '0.4.12');
    catalog.openUrl = async (url: string) => archiveResponse(arch, url);
    const downloaded = await catalog.downloadExtensionInfo(selected, join(tmp, 'downloads'));
    expect(selected.sha256).toBe(` SHA256: ${digest.toUpperCase()} `);
    expect(readFileSync(downloaded).equals(readFileSync(arch))).toBe(true);
  });

  test('a selected discovery-only release cannot be downloaded', async () => {
    const tmp = makeTempDir();
    const e = entry(archive(tmp, '0.4.12'));
    e._install_allowed = false;
    useEntry(e);
    const catalog = new ExtensionCatalog(tmp);
    const selected = (await catalog.getExtensionInfo('demo-history', '0.4.12'))!;
    await expect(catalog.downloadExtensionInfo(selected)).rejects.toThrow(/discovery-only/);
  });
});

describe('specify extension add --version', () => {
  for (const second of ['lower_priority', 'unavailable']) {
    test(`uses the first resolved catalog snapshot (${second})`, async () => {
      const tmp = makeTempDir();
      project(tmp);
      const oldArchive = archive(tmp, '0.4.12');
      const high = entry(oldArchive);
      const low = entry(oldArchive);
      low.releases['0.4.12'].download_url = 'https://example.com/low.zip';
      let fetches = 0;
      const selected: AnyDict[] = [];
      proto.getMergedExtensions = async () => {
        fetches += 1;
        if (fetches === 1) return [high];
        if (second === 'unavailable') throw new ExtensionError('winning catalog is unavailable');
        return [low];
      };
      proto.downloadExtensionInfo = async (info: AnyDict) => {
        selected.push(info);
        return oldArchive;
      };
      expect(await runExtensionCommand(['add', 'demo-history', '--version', '0.4.12'])).toBe(0);
      expect(fetches).toBe(1);
      expect(selected[0].download_url).toBe('https://example.com/demo-0.4.12.zip');
    });
  }

  test('rejects the wrong archive version before writing', async () => {
    const tmp = makeTempDir();
    const p = project(tmp);
    const oldArchive = archive(tmp, '0.4.12');
    const newArchive = archive(tmp, '0.5.1');
    useEntry(entry(oldArchive));
    proto.downloadExtensionInfo = async () => newArchive;
    expect(await runExtensionCommand(['add', 'demo-history', '--version', '0.4.12'])).toBe(1);
    expect(output()).toContain('declares version 0.5.1, expected 0.4.12');
    expect(existsSync(join(p, '.specify', 'extensions', 'demo-history', 'extension.yml'))).toBe(false);
  });

  test('reports an invalid legacy catalog version', async () => {
    const tmp = makeTempDir();
    const p = project(tmp);
    const arch = archive(tmp, '0.4.12');
    const e = entry(arch);
    e.version = 'legacy-current';
    delete e.releases;
    useEntry(e);
    proto.downloadExtensionInfo = async () => arch;
    expect(await runExtensionCommand(['add', 'demo-history', '--version', 'legacy-current'])).toBe(1);
    expect(output()).toContain('Validation Error');
    expect(output()).toContain('declares version 0.4.12, expected legacy-current');
    expect(existsSync(join(p, '.specify', 'extensions', 'demo-history'))).toBe(false);
  });

  test('rejects the wrong archive ID before writing', async () => {
    const tmp = makeTempDir();
    const p = project(tmp);
    const oldArchive = archive(tmp, '0.4.12');
    const wrongId = archive(tmp, '0.4.12', 'another-extension');
    useEntry(entry(oldArchive));
    proto.downloadExtensionInfo = async () => wrongId;
    expect(await runExtensionCommand(['add', 'demo-history', '--version', '0.4.12'])).toBe(1);
    expect(output()).toContain("declares ID 'another-extension', expected 'demo-history'");
    expect(existsSync(join(p, '.specify', 'extensions', 'another-extension'))).toBe(false);
    expect(existsSync(join(p, '.specify', 'extensions', 'demo-history'))).toBe(false);
  });

  test('rejects the wrong historical digest before writing', async () => {
    const tmp = makeTempDir();
    const p = project(tmp);
    const oldArchive = archive(tmp, '0.4.12');
    const e = entry(oldArchive);
    e.releases['0.4.12'].sha256 = '0'.repeat(64);
    useEntry(e);
    const requested: string[] = [];
    proto.openUrl = async (url: string) => {
      requested.push(url);
      return archiveResponse(oldArchive, url);
    };
    expect(await runExtensionCommand(['add', 'demo-history', '--version', '0.4.12'])).toBe(1);
    expect(requested).toEqual(['https://example.com/demo-0.4.12.zip']);
    expect(output()).toContain("Integrity check failed for 'demo-history'");
    expect(existsSync(join(p, '.specify', 'extensions', 'demo-history'))).toBe(false);
  });

  test('an unqualified install uses the current release of a versioned entry', async () => {
    const tmp = makeTempDir();
    const p = project(tmp);
    const oldArchive = archive(tmp, '0.4.12');
    const currentArchive = archive(tmp, '0.5.1');
    const e = entry(oldArchive);
    e.sha256 = sha(currentArchive);
    useEntry(e);
    const requested: string[] = [];
    proto.openUrl = async (url: string) => {
      requested.push(url);
      return archiveResponse(currentArchive, url);
    };
    expect(await runExtensionCommand(['add', 'demo-history'])).toBe(0);
    expect(requested).toEqual(['https://example.com/demo-0.5.1.zip']);
    expect(installedVersion(p)).toBe('0.5.1');
  });

  for (const requestedVersion of ['0.4.12', 'v0.4.12']) {
    test(`installs a historical release (${requestedVersion})`, async () => {
      const tmp = makeTempDir();
      const p = project(tmp);
      const oldArchive = archive(tmp, '0.4.12');
      useEntry(entry(oldArchive));
      proto.downloadExtensionInfo = async () => oldArchive;
      expect(await runExtensionCommand(['add', 'demo-history', '--version', requestedVersion])).toBe(0);
      expect(installedVersion(p)).toBe('0.4.12');
    });
  }

  test('rejects a version missing from the winning catalog', async () => {
    const tmp = makeTempDir();
    project(tmp);
    useEntry(entry(archive(tmp, '0.4.12')));
    proto.downloadExtensionInfo = async () => {
      throw new Error('must not download a different version');
    };
    expect(await runExtensionCommand(['add', 'demo-history', '--version', '0.3.0'])).toBe(1);
    expect(output()).toContain('no catalog release for version 0.3.0');
  });

  test('refuses a discovery-only catalog', async () => {
    const tmp = makeTempDir();
    project(tmp);
    const e = entry(archive(tmp, '0.4.12'));
    e._install_allowed = false;
    useEntry(e);
    proto.downloadExtensionInfo = async () => {
      throw new Error('discovery-only catalogs must not download');
    };
    expect(await runExtensionCommand(['add', 'demo-history', '--version', '0.4.12'])).toBe(1);
    expect(output()).toContain('discovery-only');
  });

  test('--version requires a catalog install', async () => {
    const tmp = makeTempDir();
    project(tmp);
    expect(await runExtensionCommand(['add', 'x', '--dev', '--version', '1.0.0'])).toBe(1);
    expect(output()).toContain('--version requires a catalog install (without --dev or --from).');
  });

  test('does not bypass the discovery policy via the bundled copy', async () => {
    const bundled = locateBundledExtension('agent-context')!;
    expect(bundled).not.toBeNull();
    const version = new ExtensionManifest(join(bundled, 'extension.yml')).version;
    const tmp = makeTempDir();
    const p = project(tmp);
    useEntry({
      id: 'agent-context',
      name: 'Agent Context',
      version,
      bundled: true,
      _catalog_name: 'discovery',
      _install_allowed: false,
    });
    expect(await runExtensionCommand(['add', 'agent-context', '--version', version])).toBe(1);
    expect(output()).toContain('discovery-only');
    expect(existsSync(join(p, '.specify', 'extensions', 'agent-context', 'extension.yml'))).toBe(false);
  });

  for (const versionCase of ['exact', 'equivalent', 'mismatch']) {
    test(`bundled version must match the packaged manifest (${versionCase})`, async () => {
      const bundled = locateBundledExtension('agent-context')!;
      const packaged = new ExtensionManifest(join(bundled, 'extension.yml')).version;
      const requested = { exact: packaged, equivalent: `v${packaged}`, mismatch: '9999.0.0' }[versionCase]!;
      const tmp = makeTempDir();
      const p = project(tmp);
      useEntry({
        id: 'agent-context',
        name: 'Agent Context',
        version: versionCase === 'mismatch' ? requested : packaged,
        bundled: true,
        _catalog_name: 'trusted',
        _install_allowed: true,
      });
      const code = await runExtensionCommand(['add', 'agent-context', '--version', requested]);
      const installed = join(p, '.specify', 'extensions', 'agent-context', 'extension.yml');
      if (versionCase !== 'mismatch') {
        expect(code).toBe(0);
        expect(new ExtensionManifest(installed).version).toBe(packaged);
      } else {
        expect(code).toBe(1);
        expect(output()).toContain(`version ${requested} is not shipped`);
        expect(existsSync(installed)).toBe(false);
      }
    });
  }
});

describe('specify extension info --versions', () => {
  test('lists versions and the discovery-only policy', async () => {
    const tmp = makeTempDir();
    project(tmp);
    const e = entry(archive(tmp, '0.4.12'));
    e._install_allowed = false;
    useEntry(e);
    expect(await runExtensionCommand(['info', 'demo-history', '--versions'])).toBe(0);
    expect(output()).toContain('0.5.1 (current)');
    expect(output()).toContain('0.4.12');
    expect(output()).toContain('Discovery only');
  });

  test('uses the first resolved catalog snapshot', async () => {
    const tmp = makeTempDir();
    project(tmp);
    const high = entry(archive(tmp, '0.4.12'));
    const low = entry(archive(tmp, '0.4.12'));
    low.version = '0.8.0';
    let fetches = 0;
    proto.getMergedExtensions = async () => {
      fetches += 1;
      return [fetches === 1 ? high : low];
    };
    expect(await runExtensionCommand(['info', 'demo-history', '--versions'])).toBe(0);
    expect(fetches).toBe(1);
    expect(output()).toContain('0.5.1 (current)');
    expect(output()).not.toContain('0.8.0');
  });

  test('preserves a catalog failure', async () => {
    const tmp = makeTempDir();
    project(tmp);
    proto.getMergedExtensions = async () => {
      throw new ExtensionError('catalog fetch failed');
    };
    expect(await runExtensionCommand(['info', 'demo-history', '--versions'])).toBe(1);
    expect(output()).toContain('Could not query extension catalog: catalog fetch failed');
    expect(output()).not.toContain('No catalog versions found');
  });
});
