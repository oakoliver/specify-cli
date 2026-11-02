/**
 * spec-kit 1.1/1.2 bundle behaviors: exact catalog releases, versioning,
 * records with requirements and installed versions, conflict reconciliation,
 * reference-aware resolution/validation and the matching command surface.
 * Ports of the v1.2.5 additions to tests/specify_cli/bundles/test_{versioning,
 * catalog_versions,catalog_stack,catalog_config,catalogs,manifest,records,
 * conflict,resolver,validator,installer,sources,command_*}.py.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { dumpYaml } from '../src/yaml.js';
import { BundlerError } from '../src/bundles/index.js';
import {
  isNewerPatch,
  isSemver,
  parseConstraint,
  sameVersion,
  stripVersionPrefix,
} from '../src/bundles/versioning.js';
import { loadsJson } from '../src/bundles/yamlio.js';
import { CatalogEntry, CatalogSource, Scope, loadCatalogPayload } from '../src/bundles/catalogs.js';
import { availableVersions, selectRelease, validatedReleases } from '../src/bundles/catalog-versions.js';
import { BundleNotFoundError, CatalogStack, ReleaseNotFoundError } from '../src/bundles/catalog-stack.js';
import { addSource, removeSource } from '../src/bundles/catalog-config.js';
import { BundleManifest, BundleRef, ComponentRef } from '../src/bundles/manifest.js';
import { InstalledBundleRecord, componentsStillNeeded, loadRecords, transferContributions } from '../src/bundles/records.js';
import { detectConflicts } from '../src/bundles/conflict.js';
import { ExpandedManifest, LoadedBundle, expandManifest } from '../src/bundles/expansion.js';
import { InstallPlan, resolveInstallPlan } from '../src/bundles/resolver.js';
import { validateManifest } from '../src/bundles/validator.js';
import { installBundle, removeBundle } from '../src/bundles/installer.js';
import { BundledPatchWarning } from '../src/bundles/primitives.js';
import { CatalogBundleLoader, localManifestSource, validateCatalogManifest } from '../src/bundles/sources.js';
import { activeIntegration, findProjectRoot } from '../src/bundles/project.js';
import { commandDeps, runBundleCommand } from '../src/bundles/commands.js';
import { adapterDeps } from '../src/bundles/adapters.js';
import {
  FakeBundleLoader,
  FakeInstaller,
  catalogEntryDict,
  catalogPayload,
  makeProject,
  referenceManifestDict,
  validManifestDict,
  writeCatalogFile,
  writeManifest,
} from './bundles-helpers.js';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'bundles-rel-')));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function throwsBundler(fn: () => unknown, match: string | RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (exc) {
    caught = exc;
  }
  expect(caught).toBeInstanceOf(BundlerError);
  if (typeof match === 'string') expect((caught as Error).message).toContain(match);
  else expect((caught as Error).message).toMatch(match);
}

async function rejects(p: Promise<unknown>, match: string | RegExp): Promise<Error> {
  let caught: unknown;
  try {
    await p;
  } catch (exc) {
    caught = exc;
  }
  expect(caught).toBeInstanceOf(BundlerError);
  if (typeof match === 'string') expect((caught as Error).message).toContain(match);
  else expect((caught as Error).message).toMatch(match);
  return caught as Error;
}

const SHA = 'a'.repeat(64);

// ============================================================================
// versioning / yamlio
// ============================================================================

describe('versioning', () => {
  test('stripVersionPrefix keeps prerelease spellings', () => {
    expect(stripVersionPrefix('v1.0.0-rc1')).toBe('1.0.0-rc1');
    expect(stripVersionPrefix('V2.0.0')).toBe('2.0.0');
    expect(stripVersionPrefix('1.0.0')).toBe('1.0.0');
  });

  test('sameVersion compares parsed versions with a string fallback', () => {
    expect(sameVersion('v1.0.0', '1.0.0')).toBe(true);
    expect(sameVersion('1.0', '1.0.0')).toBe(true);
    expect(sameVersion('1.0.1', '1.0.0')).toBe(false);
    expect(sameVersion(' not-a-version ', 'not-a-version')).toBe(true);
  });

  test('isSemver rejects non-ASCII digits and a trailing newline', () => {
    expect(isSemver('1.0.0')).toBe(true);
    expect(isSemver('v1.0.0+build.1')).toBe(true);
    expect(isSemver('1.0.٣')).toBe(false);
    expect(isSemver('١.0.0')).toBe(false);
    expect(isSemver('1.0.0\n')).toBe(false);
  });

  test('isNewerPatch accepts only stable same-minor patch upgrades', () => {
    expect(isNewerPatch('1.0.2', '1.0.0')).toBe(true);
    expect(isNewerPatch('v1.0.2', '1.0.0')).toBe(true);
    expect(isNewerPatch('1.0.0', '1.0.0')).toBe(false);
    expect(isNewerPatch('1.1.0', '1.0.0')).toBe(false);
    expect(isNewerPatch('1.0.2-rc1', '1.0.0')).toBe(false);
    expect(isNewerPatch('1.0.2', '1.0.0-rc1')).toBe(false);
    expect(isNewerPatch('1.0', '1.0.0')).toBe(false);
  });

  test('a newline-containing constraint is a BundlerError', () => {
    throwsBundler(() => parseConstraint('>=1.0.0\n<2.0.0\n'), "Invalid version constraint '>=1.0.0\n<2.0.0\n'");
    expect(parseConstraint('>=1.0.0\n').contains).toBeDefined();
  });

  test('loadsJson rejects duplicate keys', () => {
    throwsBundler(() => loadsJson('{"a": 1, "a": 2}', { origin: 'x.json' }), "Invalid JSON from x.json: duplicate key 'a'.");
    throwsBundler(() => loadsJson('{"b": {"c": 1, "c": 2}}', { origin: 'y' }), "duplicate key 'c'");
    expect(loadsJson('{"a": {"b": 1}, "c": [{"b": 2}]}')).toEqual({ a: { b: 1 }, c: [{ b: 2 }] });
  });
});

// ============================================================================
// catalogs / exact releases
// ============================================================================

function entryWithReleases(releases: unknown, extra: Record<string, unknown> = {}): CatalogEntry {
  return CatalogEntry.fromDict(
    catalogEntryDict('demo-bundle', {
      version: '2.0.0',
      download_url: 'https://example.com/2.0.0.zip',
      sha256: SHA,
      releases,
      ...extra,
    }),
  );
}

describe('catalog entries and sources', () => {
  test('explicit null fields read as empty, not "None"', () => {
    throwsBundler(() => CatalogSource.fromDict({ id: null, url: 'x', priority: 1, install_policy: 'install-allowed' }, Scope.PROJECT), "missing its 'id'");
    throwsBundler(() => loadCatalogPayload(catalogPayload({ x: { ...catalogEntryDict('x'), id: null } })), "Catalog entry for 'x' is missing its 'id' field.");
    const entry = CatalogEntry.fromDict({ ...catalogEntryDict('x'), name: null, author: null });
    expect(entry.name).toBe('');
    expect(entry.author).toBe('');
  });

  test('isBuiltin follows the URL scheme, not the id', () => {
    expect(CatalogSource.fromDict({ id: 'default', url: 'builtin://default', priority: 1, install_policy: 'install-allowed' }, Scope.BUILTIN).isBuiltin).toBe(true);
    expect(CatalogSource.fromDict({ id: 'default', url: 'https://x/c.json', priority: 1, install_policy: 'install-allowed' }, Scope.PROJECT).isBuiltin).toBe(false);
  });

  test('catalog remove deletes a project source overriding a built-in', () => {
    const root = makeProject(tmp);
    throwsBundler(() => removeSource(root, 'default'), "'default' is a built-in default source and cannot be deleted");
    addSource(root, path.join(tmp, 'cat.json'), { policy: 'install-allowed', priority: 1, sourceId: 'default' });
    expect(removeSource(root, 'default')).toBe('default');
    throwsBundler(() => removeSource(root, 'default'), 'built-in default source');
  });
});

describe('catalog versions', () => {
  test('selects current and historical releases from the winning entry', () => {
    const entry = entryWithReleases({ '1.0.0': { download_url: 'https://example.com/1.0.0.zip', sha256: `sha256:${SHA}`, name: 'Old' } });
    expect(selectRelease(entry, null)).toBe(entry);
    expect(selectRelease(entry, '2.0.0')).toBe(entry);
    expect(selectRelease(entry, 'v2.0.0')).toBe(entry);
    const old = selectRelease(entry, '1.0.0')!;
    expect(old.version).toBe('1.0.0');
    expect(old.download_url).toBe('https://example.com/1.0.0.zip');
    expect(old.name).toBe('Old');
    expect(old.role).toBe('developer');
    expect(selectRelease(entry, '3.0.0')).toBeNull();
    expect(selectRelease(entry, 'not a version')).toBeNull();
    expect(availableVersions(entry)).toEqual(['2.0.0', '1.0.0']);
  });

  test('history is ordered newest first', () => {
    const rec = (v: string) => ({ download_url: `https://example.com/${v}.zip`, sha256: SHA });
    const entry = entryWithReleases({ '1.0.0': rec('1.0.0'), '1.10.0': rec('1.10.0'), '1.2.0': rec('1.2.0') });
    expect(availableVersions(entry)).toEqual(['2.0.0', '1.10.0', '1.2.0', '1.0.0']);
    expect(availableVersions(CatalogEntry.fromDict(catalogEntryDict()))).toEqual(['1.2.0']);
  });

  const invalid: Array<[string, unknown, Record<string, unknown>, string]> = [
    ['non-mapping releases', ['1.0.0'], {}, "Bundle 'demo-bundle' has an invalid releases mapping."],
    ['no current version', {}, { version: null }, "Bundle 'demo-bundle' has releases but no current version."],
    ['invalid current', {}, { version: '2.0' }, "Bundle 'demo-bundle' has an invalid current version '2.0'."],
    ['invalid key', { '1.0': {} }, {}, "Bundle 'demo-bundle' has invalid release version '1.0'."],
    ['repeat', { 'v2.0.0': {} }, {}, "Bundle 'demo-bundle' repeats release version 'v2.0.0'."],
    ['non-object', { '1.0.0': 'x' }, {}, "Bundle 'demo-bundle' release '1.0.0' must be an object."],
    ['reserved', { '1.0.0': { id: 'x' } }, {}, "Bundle 'demo-bundle' release '1.0.0' contains reserved fields."],
    ['no url', { '1.0.0': { sha256: SHA } }, {}, "Bundle 'demo-bundle' release '1.0.0' needs a download_url."],
    ['http url', { '1.0.0': { download_url: 'http://example.com/x.zip', sha256: SHA } }, {}, "Bundle 'demo-bundle' release '1.0.0' has an invalid download_url."],
    ['no digest', { '1.0.0': { download_url: 'https://example.com/x.zip' } }, {}, "Bundle 'demo-bundle' release '1.0.0' needs a SHA-256 digest."],
    ['bad requires', { '1.0.0': { download_url: 'https://example.com/x.zip', sha256: SHA, requires: 'x' } }, {}, "Bundle 'demo-bundle' release '1.0.0' has invalid requires."],
    ['bad nested field', { '1.0.0': { download_url: 'https://example.com/x.zip', sha256: SHA, tags: 'x' } }, {}, "Bundle 'demo-bundle' release '1.0.0' has Catalog entry 'demo-bundle': 'tags' must be a list of strings."],
  ];
  test.each(invalid)('rejects %s', (_name, releases, extra, message) => {
    throwsBundler(() => validatedReleases(entryWithReleases(releases, extra)), message);
    // The catalog payload loader validates history up front.
    throwsBundler(
      () => loadCatalogPayload(catalogPayload({ 'demo-bundle': { ...catalogEntryDict('demo-bundle', { version: '2.0.0', releases, ...extra }) } })),
      message,
    );
  });
});

describe('catalog stack exact releases', () => {
  function stack(): CatalogStack {
    const source = (id: string, priority: number) =>
      CatalogSource.fromDict({ id, url: `https://${id}.example/c.json`, priority, install_policy: 'install-allowed' }, Scope.PROJECT);
    const payloads: Record<string, unknown> = {
      high: catalogPayload({
        'demo-bundle': catalogEntryDict('demo-bundle', {
          version: '2.0.0',
          releases: { '1.0.0': { download_url: 'https://example.com/1.zip', sha256: SHA } },
        }),
      }),
      low: catalogPayload({ 'demo-bundle': catalogEntryDict('demo-bundle', { version: '0.9.0' }) }),
    };
    return new CatalogStack([source('high', 1), source('low', 2)], (s) => payloads[s.id]);
  }

  test('resolves an exact release from the winning source only', async () => {
    const resolved = await stack().resolve('demo-bundle', '1.0.0');
    expect(resolved.entry.version).toBe('1.0.0');
    expect(resolved.entry.download_url).toBe('https://example.com/1.zip');
    expect(resolved.entry.source_id).toBe('high');
    const err = await rejects(stack().resolve('demo-bundle', '0.9.0'), 'Only the highest-precedence source that lists a bundle is consulted.');
    expect(err).toBeInstanceOf(ReleaseNotFoundError);
    expect(err.message).toBe(
      "Bundle 'demo-bundle' has no release 0.9.0 in catalog source 'high' (advertised: 2.0.0, 1.0.0). " +
        'Only the highest-precedence source that lists a bundle is consulted.',
    );
    expect((err as ReleaseNotFoundError).advertised).toEqual(['2.0.0', '1.0.0']);
    expect(await rejects(stack().resolve('nope'), "Bundle 'nope' was not found in any configured catalog.")).toBeInstanceOf(
      BundleNotFoundError,
    );
  });

  test('CatalogBundleLoader formats missing releases and source pins', async () => {
    const downloads: string[] = [];
    const loader = new CatalogBundleLoader(stack(), {
      offline: false,
      download: async (resolved) => {
        downloads.push(resolved.entry.version);
        const data = validManifestDict();
        (data.bundle as Record<string, unknown>).version = resolved.entry.version;
        return BundleManifest.fromDict(data);
      },
    });
    const loaded = await loader.load(new BundleRef({ id: 'demo-bundle', version: '1.0.0' }), ['root']);
    expect(loaded.manifest.bundle.version).toBe('1.0.0');
    expect(loaded.source_id).toBe('high');
    await rejects(
      loader.load(new BundleRef({ id: 'demo-bundle', version: '0.9.0' }), ['root']),
      "'root' pins demo-bundle 0.9.0, but catalog 'high' offers 2.0.0, 1.0.0. Update the reference to an advertised version.",
    );
    await rejects(
      loader.load(new BundleRef({ id: 'demo-bundle', version: '2.0.0', source: 'low' }), ['root', 'mid']),
      "Bundle reference demo-bundle (root → mid) requires source 'low', but the winning catalog is 'high'.",
    );
    expect(downloads).toEqual(['1.0.0']);
  });

  test('offline misses against a built-in snapshot suggest going online', async () => {
    const builtin = CatalogSource.fromDict({ id: 'default', url: 'builtin://default', priority: 1, install_policy: 'install-allowed' }, Scope.BUILTIN);
    const offline = new CatalogBundleLoader(new CatalogStack([builtin], () => catalogPayload({})), { offline: true });
    await rejects(
      offline.load(new BundleRef({ id: 'gone', version: '1.0.0' }), ['root']),
      "Bundle 'gone' was not found in any configured catalog. Network access disabled; a built-in catalog may be outdated, so gone@1.0.0 may resolve online. Re-run without --offline.",
    );
  });
});

// ============================================================================
// manifest / records / conflict
// ============================================================================

describe('manifest 1.1', () => {
  const errorsOf = (data: Record<string, unknown>) => BundleManifest.fromDict(data).structuralErrors();

  test('bundle references require schema 1.1 and pinned slugs', () => {
    expect(errorsOf(referenceManifestDict([{ id: 'child', version: '1.0.0' }]))).toEqual([]);
    expect(errorsOf(referenceManifestDict([{ id: 'child', version: '1.0.0' }], { schemaVersion: '1.0' }))).toContain(
      'Bundle references require schema_version "1.1".',
    );
    const errors = errorsOf(
      referenceManifestDict([
        { id: 'Bad/Id', version: '1.0.0' },
        { id: 'demo-bundle', version: '1.0.0' },
        { id: 'dup', version: '1.0.0' },
        { id: 'dup', version: '1.0.0' },
        { id: 'unpinned' },
        { id: 'loose', version: '1.0' },
        { version: '1.0.0' },
      ]),
    );
    expect(errors).toEqual([
      "Bundle reference id 'Bad/Id' must be a slug (lowercase letters, digits, '.', '_', '-'; no path separators).",
      "Bundle reference 'demo-bundle' is invalid: a bundle cannot reference itself.",
      "Duplicate bundle reference 'dup' in provides; declare each bundle reference only once.",
      "bundle reference 'unpinned' must be pinned to a 'version'.",
      "bundle reference 'loose' has invalid version '1.0'.",
      "A bundle reference is missing its 'id'.",
    ]);
    throwsBundler(() => BundleManifest.fromDict(referenceManifestDict('x' as never)), 'provides.bundles must be a list when present.');
    throwsBundler(() => BundleManifest.fromDict(referenceManifestDict(['x'] as never)), 'Each provides.bundles entry must be a mapping.');
  });

  test('duplicate components, non-positive priorities and integration ids', () => {
    const data = validManifestDict();
    (data.provides as Record<string, unknown>).extensions = [
      { id: 'ext-a', version: '1.0.0', priority: 0 },
      { id: 'ext-a', version: '1.0.0' },
    ];
    (data.provides as Record<string, unknown>).presets = [{ id: 'p', version: '1.0.0', priority: -1, strategy: 'append' }];
    expect(errorsOf(data)).toEqual([
      "extension 'ext-a' priority must be 1 or higher, got 0.",
      "Duplicate extension 'ext-a' in provides; declare each component ID only once per kind.",
      "preset 'p' priority must be 1 or higher, got -1.",
    ]);
    for (const integration of [{}, { id: '' }, { id: '   ' }, { id: null }]) {
      throwsBundler(() => BundleManifest.fromDict(validManifestDict({ integration })), "'integration' mapping must include a non-empty 'id'.");
    }
    expect(BundleManifest.fromDict(validManifestDict({ integration: { id: ' claude ' } })).integration).toEqual({ id: 'claude' });
  });

  test('components excludes bundle references', () => {
    const m = BundleManifest.fromDict(referenceManifestDict([{ id: 'child', version: '1.0.0', source: ' ' }], { provides: { extensions: [{ id: 'e', version: '1.0.0' }] } }));
    expect(m.components.map((c) => c.id)).toEqual(['e']);
    expect(m.bundles).toEqual([new BundleRef({ id: 'child', version: '1.0.0', source: null })]);
    expect(m.bundles[0].label()).toBe('bundle:child@1.0.0');
  });
});

describe('records with requirements', () => {
  const comp = (id: string, version: string | null = '1.0.0') => new ComponentRef({ kind: 'extensions', id, version });

  test('round-trips required components, installed versions and references', () => {
    const record = InstalledBundleRecord.create('b', '1.0.0', [comp('a')], '2026-01-01T00:00:00Z', {
      requiredComponents: [comp('a'), comp('shared')],
      installedVersions: { 'extensions:a': '1.0.1' },
      bundleReferences: [new BundleRef({ id: 'child', version: '1.0.0', source: 'default' })],
    });
    const data = record.toDict();
    expect(data).toEqual({
      bundle_id: 'b',
      version: '1.0.0',
      installed_at: '2026-01-01T00:00:00Z',
      contributed_components: [{ kind: 'extensions', id: 'a', version: '1.0.0' }],
      required_components: [
        { kind: 'extensions', id: 'a', version: '1.0.0' },
        { kind: 'extensions', id: 'shared', version: '1.0.0' },
      ],
      installed_versions: { 'extensions:a': '1.0.1' },
      bundle_references: [{ id: 'child', version: '1.0.0', source: 'default' }],
    });
    expect(InstalledBundleRecord.fromDict(data).toDict()).toEqual(data);
  });

  test('legacy records default required components to contributed ones', () => {
    const record = InstalledBundleRecord.fromDict({ bundle_id: 'b', version: '1', contributed_components: [{ kind: 'extensions', id: 'a' }] });
    expect(record.required_components.map((c) => c.id)).toEqual(['a']);
    expect(record.toDict().installed_versions).toBeUndefined();
  });

  const corrupt: Array<[string, Record<string, unknown>, string]> = [
    ['required not a list', { required_components: 'x' }, "Corrupt record: 'required_components' must be a list."],
    ['required missing contributed', { contributed_components: [{ kind: 'extensions', id: 'a' }], required_components: [] }, "'required_components' must include all 'contributed_components'."],
    ['installed versions not a mapping', { installed_versions: [] }, "Corrupt record: 'installed_versions' must be a mapping."],
    ['installed version key unknown', { required_components: [{ kind: 'extensions', id: 'a' }], installed_versions: { 'extensions:b': '1' } }, "'installed_versions' must map required component keys (kind:id)"],
    ['installed version blank', { required_components: [{ kind: 'extensions', id: 'a' }], installed_versions: { 'extensions:a': ' ' } }, "'installed_versions' must map required component keys (kind:id)"],
    ['references not a list', { bundle_references: {} }, "Corrupt record: 'bundle_references' must be a list."],
    ['reference not a mapping', { bundle_references: ['x'] }, "Corrupt record: 'bundle_references' entries must be mappings."],
    ['reference without version', { bundle_references: [{ id: 'x' }] }, "entries must have non-empty string 'id' and 'version'."],
    ['reference source type', { bundle_references: [{ id: 'x', version: '1', source: 3 }] }, "Corrupt record: 'bundle_references' entry 'source' must be a string."],
    ['required component id', { required_components: [{ kind: 'extensions' }] }, "Corrupt records file: a required component is missing its 'id'."],
  ];
  test.each(corrupt)('rejects %s', (_name, extra, message) => {
    throwsBundler(() => InstalledBundleRecord.fromDict({ bundle_id: 'b', version: '1', ...extra }), message);
  });

  test('an empty reference source is normalized to null', () => {
    const record = InstalledBundleRecord.fromDict({ bundle_id: 'b', version: '1', bundle_references: [{ id: 'x', version: '1', source: '' }] });
    expect(record.bundle_references[0].source).toBeNull();
  });

  test('componentsStillNeeded uses requirements; transferContributions keeps ownership', () => {
    const a = InstalledBundleRecord.create('a', '1', [comp('x')], null, { requiredComponents: [comp('x')] });
    const b = InstalledBundleRecord.create('b', '1', [], null, { requiredComponents: [comp('x')] });
    expect([...componentsStillNeeded([a, b], 'a')]).toEqual([JSON.stringify(['extensions', 'x'])]);
    const transferred = transferContributions([b], [comp('x')]);
    expect(transferred[0].contributed_components.map((c) => c.id)).toEqual(['x']);
    expect(transferContributions(transferred, [comp('x')])).toEqual(transferred);
  });
});

describe('conflict reconciliation', () => {
  test('requirements of other bundles are compared through sameVersion', () => {
    const manifest = BundleManifest.fromDict(validManifestDict());
    const other = InstalledBundleRecord.create('other', '1', [], null, {
      requiredComponents: [new ComponentRef({ kind: 'extensions', id: 'ext-a', version: 'v1.0.0' })],
    });
    const report = detectConflicts(manifest, null, [other]);
    expect(report.hasBlockingConflict).toBe(false);
    expect(report.overlaps).toEqual(["extension 'ext-a' is already required by bundle 'other'."]);
    const clash = InstalledBundleRecord.create('other', '1', [], null, {
      requiredComponents: [new ComponentRef({ kind: 'extensions', id: 'ext-a', version: '2.0.0' })],
    });
    expect(detectConflicts(manifest, null, [clash]).version_clashes).toEqual([
      "extension 'ext-a' requires version 1.0.0, but bundle 'other' already requires version 2.0.0. Only one version can be installed per ID.",
    ]);
    // An explicit component list (the expanded plan) replaces the manifest's own.
    expect(detectConflicts(manifest, null, [clash], []).hasBlockingConflict).toBe(false);
  });
});

// ============================================================================
// resolver / validator with references
// ============================================================================

function refManifest(id: string, extra: Record<string, unknown> = {}, bundles: Array<Record<string, unknown>> = []): BundleManifest {
  const data = referenceManifestDict(bundles, { bundleId: id, provides: extra.provides as Record<string, unknown> | undefined });
  for (const [k, v] of Object.entries(extra)) if (k !== 'provides') (data as Record<string, unknown>)[k] = v;
  return BundleManifest.fromDict(data);
}

describe('resolver with references', () => {
  test('an unexpanded manifest with references is refused', () => {
    throwsBundler(
      () => resolveInstallPlan(refManifest('root', {}, [{ id: 'child', version: '1.2.0' }]), { speckitVersion: '1.2.5', activeIntegration: null }),
      'Cannot resolve a bundle manifest with references before expansion.',
    );
  });

  test('merges requirements and checks every reference gate', async () => {
    const child = refManifest('child', {
      requires: { speckit_version: '>=1.0.0', tools: ['git', 'gh'], mcp: ['github'] },
      integration: { id: 'claude' },
      provides: { extensions: [{ id: 'child-ext', version: '1.0.0' }] },
    });
    const root = refManifest('root', { requires: { speckit_version: '>=0.1.0', tools: ['git'] } }, [{ id: 'child', version: '1.2.0' }]);
    const loader = new FakeBundleLoader(new Map([[FakeBundleLoader.key('child', '1.2.0'), new LoadedBundle(child, 'default', true)]]));
    const expanded = await expandManifest(root, loader);
    const plan = resolveInstallPlan(expanded, { speckitVersion: '1.2.5', activeIntegration: 'copilot' });
    expect(plan.components.map((c) => c.id)).toEqual(['child-ext']);
    expect(plan.references.map((r) => r.id)).toEqual(['child']);
    expect(plan.warnings).toEqual([
      'Requires external tools: git, gh',
      'Requires MCP servers: github',
      "Bundle 'child' (root → child) targets 'claude'; this install uses 'copilot'.",
    ]);
    expect(resolveInstallPlan(expanded, { speckitVersion: '1.2.5', activeIntegration: null, integrationExplicit: true }).warnings).toContain(
      "Bundle 'child' (root → child) targets integration 'claude'; the project's integration could not be determined.",
    );
    const strict = refManifest('child', { requires: { speckit_version: '>=9.0.0' } });
    const gated = await expandManifest(
      root,
      new FakeBundleLoader(new Map([[FakeBundleLoader.key('child', '1.2.0'), new LoadedBundle(strict, 'default', true)]])),
    );
    throwsBundler(
      () => resolveInstallPlan(gated, { speckitVersion: '1.2.5', activeIntegration: null }),
      "Bundle 'child' (root → child) requires Spec Kit >=9.0.0, but this project uses 1.2.5.",
    );
  });

  test('a flat bundle keeps duplicate requirement declarations', () => {
    const m = BundleManifest.fromDict(validManifestDict({ requires: { speckit_version: '>=0.1.0', tools: ['git', 'git'] } }));
    expect(resolveInstallPlan(m, { speckitVersion: '1.2.5', activeIntegration: null }).warnings).toEqual(['Requires external tools: git, git']);
  });
});

describe('validator origins', () => {
  test('unresolved expanded components name their reference chain', async () => {
    const m = BundleManifest.fromDict(referenceManifestDict([{ id: 'child', version: '1.0.0' }]));
    const component = new ComponentRef({ kind: 'extensions', id: 'deep', version: '1.0.0' });
    const report = await validateManifest(m, () => 'missing', [component], new Map([[`extensions\u0000deep`, ['child', 'leaf']]]));
    expect(report.errors).toEqual(['Unresolved reference extension:deep@1.0.0 (from demo-bundle → child → leaf): missing']);
  });
});

// ============================================================================
// installer: pins, shared settings and records
// ============================================================================

describe('installer reconciliation', () => {
  const ext = (id: string, version: string | null = '1.0.0', extra: Record<string, unknown> = {}) =>
    new ComponentRef({ kind: 'extensions', id, version, ...extra });
  const plan = (id: string, components: ComponentRef[], version = '1.0.0') =>
    new InstallPlan({ bundle_id: id, version, role: 'developer', effective_integration: null, components });

  test('an independently installed component at a different version blocks install', async () => {
    const root = makeProject(tmp);
    const installer = new FakeInstaller();
    installer.installed.add('extensions:a');
    installer.versions.set('extensions:a', '2.0.0');
    await rejects(
      installBundle(root, plan('b', [ext('a')]), installer),
      "Bundle 'b' pins extension 'a' to 1.0.0, but 2.0.0 is installed. Only one version can be installed per ID; " +
        "independently installed and other bundles' components cannot be replaced by this bundle.",
    );
    expect(loadRecords(root)).toEqual([]);
  });

  test('records requirements and installed versions; shared components stay owned', async () => {
    const root = makeProject(tmp);
    const installer = new FakeInstaller();
    await installBundle(root, plan('first', [ext('shared'), ext('own')]), installer);
    await installBundle(root, plan('second', [ext('shared', 'v1.0.0')]), installer);
    const records = loadRecords(root);
    expect(records[0].installed_versions).toEqual({ 'extensions:shared': '1.0.0', 'extensions:own': '1.0.0' });
    expect(records[1].required_components.map((c) => c.id)).toEqual(['shared']);
    expect(records[1].contributed_components.map((c) => c.id)).toEqual(['shared']);
    await removeBundle(root, 'first', installer);
    expect(installer.installed.has('extensions:shared')).toBe(true);
    expect(installer.installed.has('extensions:own')).toBe(false);
    expect(loadRecords(root)[0].contributed_components.map((c) => c.id)).toEqual(['shared']);
  });

  test('another bundle pinning a different version is a blocking conflict', async () => {
    const root = makeProject(tmp);
    const installer = new FakeInstaller();
    const manifest = (id: string, version: string) =>
      BundleManifest.fromDict(validManifestDict({ bundle: { ...(validManifestDict().bundle as object), id }, provides: { extensions: [{ id: 'shared', version }] } }));
    const first = manifest('first', '1.0.0');
    await installBundle(root, plan('first', first.components), installer, first);
    const second = manifest('second', '2.0.0');
    await rejects(
      installBundle(root, plan('second', second.components), installer, second),
      "extension 'shared' requires version 2.0.0, but bundle 'first' already requires version 1.0.0.",
    );
  });

  test('shared components must agree on install-affecting settings', async () => {
    const root = makeProject(tmp);
    const installer = new FakeInstaller();
    const preset = (priority: number) => new ComponentRef({ kind: 'presets', id: 'p', version: '1.0.0', priority, strategy: 'append' });
    await installBundle(root, plan('first', [preset(5)]), installer);
    await rejects(
      installBundle(root, plan('second', [preset(6)]), installer),
      "Cannot install or refresh shared preset 'p': bundle 'first' requires different priority. Shared components must agree on install-affecting requirements.",
    );
    // Extension priority is never compared across installed bundles.
    await installBundle(root, plan('third', [ext('e', '1.0.0', { priority: 5 })]), installer);
    await installBundle(root, plan('fourth', [ext('e', '1.0.0', { priority: 7 })]), installer);
  });

  test('unpinned components must match other bundles pins', async () => {
    const root = makeProject(tmp);
    const installer = new FakeInstaller();
    await installBundle(root, plan('first', [ext('shared')]), installer);
    await installBundle(root, plan('second', [ext('shared', null)]), installer);
    installer.versions.set('extensions:shared', '1.5.0');
    await rejects(
      installBundle(root, plan('third', [ext('shared', null)]), installer),
      "Cannot install or refresh unpinned extension 'shared': another bundle requires version 1.0.0.",
    );
    await rejects(
      installBundle(root, plan('second', [ext('shared', null)]), installer, null, true),
      "Cannot refresh unpinned shared extension 'shared'",
    );
  });

  test('a newer packaged patch on an owned component warns instead of failing', async () => {
    const root = makeProject(tmp);
    const installer = new FakeInstaller();
    await installBundle(root, plan('b', [ext('git')]), installer);
    installer.versions.set('extensions:git', '1.0.2');
    const warning = new BundledPatchWarning('patched', {
      kind: 'extensions',
      component_id: 'git',
      requested_version: '1.0.0',
      installed_version: '1.0.2',
    });
    (installer as unknown as { bundledPatchWarning: () => BundledPatchWarning }).bundledPatchWarning = () => warning;
    const result = await installBundle(root, plan('b', [ext('git')]), installer);
    expect(result.warnings).toEqual([warning]);
    expect(warning.code).toBe('bundled_patch_upgrade');
    expect(loadRecords(root)[0].installed_versions).toEqual({ 'extensions:git': '1.0.2' });
  });

  test('references are recorded with their resolved source', async () => {
    const root = makeProject(tmp);
    const child = refManifest('child', { provides: { extensions: [{ id: 'e', version: '1.0.0' }] } });
    const parent = refManifest('parent', {}, [{ id: 'child', version: '1.2.0' }]);
    const expanded = await expandManifest(
      parent,
      new FakeBundleLoader(new Map([[FakeBundleLoader.key('child', '1.2.0'), new LoadedBundle(child, 'team', true)]])),
    );
    const p = resolveInstallPlan(expanded, { speckitVersion: '1.2.5', activeIntegration: null });
    await installBundle(root, p, new FakeInstaller(), parent);
    expect(loadRecords(root)[0].toDict().bundle_references).toEqual([{ id: 'child', version: '1.2.0', source: 'team' }]);
  });
});

// ============================================================================
// sources / project
// ============================================================================

describe('sources and project', () => {
  test('a catalog manifest whose version differs only in spelling is accepted', () => {
    const entry = CatalogEntry.fromDict(catalogEntryDict('demo-bundle', { version: 'v1.2.0' }));
    validateCatalogManifest(entry, BundleManifest.fromDict(validManifestDict()));
  });

  test('an uppercase .ZIP artifact is read as an archive', async () => {
    const zipPath = path.join(tmp, 'BUNDLE.ZIP');
    writeFileSync(zipPath, 'not a zip');
    let caught: unknown;
    try {
      await localManifestSource(zipPath);
    } catch (exc) {
      caught = exc;
    }
    expect(caught).toBeInstanceOf(BundlerError);
    expect((caught as Error).message).toContain('Invalid ZIP archive');
  });

  test('activeIntegration cleans candidates and promotes installed integrations', () => {
    const root = makeProject(tmp);
    const marker = path.join(root, '.specify', 'integration.json');
    writeFileSync(marker, JSON.stringify({ default_integration: '   ', integration: ' copilot ' }));
    expect(activeIntegration(root)).toBe('copilot');
    writeFileSync(marker, JSON.stringify({ installed_integrations: ['', ' claude ', 'claude', 'gemini'] }));
    expect(activeIntegration(root)).toBe('claude');
    writeFileSync(marker, JSON.stringify({ id: 7, active: 'gemini' }));
    expect(activeIntegration(root)).toBe('gemini');
  });

  test('a symlinked or non-directory .specify fails at its boundary', () => {
    const real = path.join(tmp, 'real');
    mkdirSync(path.join(real, '.specify'), { recursive: true });
    const linked = path.join(tmp, 'linked');
    mkdirSync(linked);
    symlinkSync(path.join(real, '.specify'), path.join(linked, '.specify'));
    mkdirSync(path.join(linked, 'sub'));
    throwsBundler(() => findProjectRoot(path.join(linked, 'sub')), /Refusing symlink .*\.specify/);
    const fileMarker = path.join(tmp, 'file-marker');
    mkdirSync(fileMarker);
    writeFileSync(path.join(fileMarker, '.specify'), 'x');
    throwsBundler(() => findProjectRoot(fileMarker), 'Cannot read .specify/init-options.json');
    const bad = makeProject(path.join(tmp, 'bad-options'));
    writeFileSync(path.join(bad, '.specify', 'init-options.json'), JSON.stringify({ allow_symlinks: 'yes' }));
    throwsBundler(() => findProjectRoot(bad), '.specify/init-options.json: allow_symlinks must be a JSON boolean (true or false)');
    const good = makeProject(path.join(tmp, 'good'));
    writeFileSync(path.join(good, '.specify', 'init-options.json'), JSON.stringify({ allow_symlinks: false }));
    expect(findProjectRoot(good)).toBe(good);
  });
});

// ============================================================================
// commands
// ============================================================================

describe('bundle commands (1.2)', () => {
  let project: string;
  let cwd: string;
  let installer: FakeInstaller;
  const savedCommand = { ...commandDeps };
  const savedAdapter = { ...adapterDeps };
  const savedEnv = { NO_COLOR: process.env.NO_COLOR, COLUMNS: process.env.COLUMNS, SPECIFY_INIT_DIR: process.env.SPECIFY_INIT_DIR };

  beforeEach(() => {
    project = path.join(tmp, 'proj');
    mkdirSync(path.join(project, '.specify'), { recursive: true });
    cwd = process.cwd();
    process.chdir(project);
    process.env.NO_COLOR = '1';
    process.env.COLUMNS = '400';
    delete process.env.SPECIFY_INIT_DIR;
    installer = new FakeInstaller();
    commandDeps.userConfigDir = () => path.join(tmp, 'home', '.specify');
    commandDeps.speckitVersion = async () => '1.2.5';
    commandDeps.makeInstaller = () => installer;
    adapterDeps.httpGetJson = async () => {
      throw new Error('network disabled in tests');
    };
  });
  afterEach(() => {
    process.chdir(cwd);
    Object.assign(commandDeps, savedCommand);
    Object.assign(adapterDeps, savedAdapter);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runBundleCommand(args);
      return { code, out: out.join(''), err: err.join('') };
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  }

  function configureCatalog(entries: Record<string, unknown>): void {
    const catalog = path.join(project, 'c.json');
    writeCatalogFile(catalog, entries);
    writeFileSync(
      path.join(project, '.specify', 'bundle-catalogs.yml'),
      dumpYaml({ schema_version: '1.0', catalogs: [{ id: 'c', url: catalog, priority: 1, install_policy: 'install-allowed' }] }),
    );
  }

  const releaseEntry = () =>
    catalogEntryDict('demo-bundle', {
      version: '2.0.0',
      download_url: 'https://example.com/2.yml',
      releases: { '1.2.0': { download_url: 'https://example.com/1.2.0.yml', sha256: SHA } },
    });

  test('install --version validation', async () => {
    let r = await run(['install', 'demo-bundle', '--version', ' ']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('--version must not be blank.');
    const local = path.join(tmp, 'local');
    writeManifest(local);
    r = await run(['install', local, '--version', '1.0.0']);
    expect(r.err).toContain('--version requires a catalog bundle ID, not a local path.');
    r = await run(['install', 'demo-bundle', '--version', '1.0.0', '--refresh']);
    expect(r.err).toContain('--version cannot be used with --refresh.');
  });

  test('install --version selects the exact catalog release', async () => {
    configureCatalog({ 'demo-bundle': releaseEntry() });
    const seen: string[] = [];
    commandDeps.downloadManifest = async (resolved) => {
      seen.push(resolved.entry.download_url);
      return BundleManifest.fromDict(validManifestDict());
    };
    const r = await run(['install', 'demo-bundle', '--version', '1.2.0']);
    expect(r.code).toBe(0);
    expect(seen).toEqual(['https://example.com/1.2.0.yml']);
    expect(loadRecords(project)[0].version).toBe('1.2.0');
    const missing = await run(['add', 'demo-bundle', '--version', '9.9.9']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Bundle 'demo-bundle' has no release 9.9.9 in catalog source 'c' (advertised: 2.0.0, 1.2.0).");
  });

  test('info --versions lists catalog history (text and JSON)', async () => {
    configureCatalog({ 'demo-bundle': releaseEntry() });
    let r = await run(['info', 'demo-bundle', '--versions']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Catalog versions for demo-bundle:');
    expect(r.out).toContain('2.0.0 (current)');
    expect(r.out).toContain('1.2.0');
    expect(r.out).toContain('Source: c (install-allowed)');
    r = await run(['info', 'demo-bundle', '--versions', '--json']);
    expect(JSON.parse(r.out)).toEqual({
      id: 'demo-bundle',
      versions: ['2.0.0', '1.2.0'],
      current: '2.0.0',
      source: 'c',
      install_policy: 'install-allowed',
    });
  });

  test('info expands references and shows provenance', async () => {
    const child = referenceManifestDict([], {
      bundleId: 'child',
      provides: { extensions: [{ id: 'child-ext', version: '1.0.0' }] },
    });
    (child.bundle as Record<string, unknown>).version = '1.0.0';
    const parent = referenceManifestDict([{ id: 'child', version: '1.0.0' }], {
      provides: { extensions: [{ id: 'child-ext', version: '2.0.0' }] },
    });
    configureCatalog({
      'demo-bundle': catalogEntryDict('demo-bundle', { download_url: 'https://example.com/p.yml' }),
      child: catalogEntryDict('child', { version: '1.0.0', download_url: 'https://example.com/c.yml', verified: false }),
    });
    commandDeps.downloadManifest = async (resolved) => BundleManifest.fromDict(resolved.entry.id === 'child' ? child : parent);
    const r = await run(['info', 'demo-bundle', '--json']);
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.out);
    expect(payload.references).toEqual([
      { id: 'child', version: '1.0.0', source: 'c', install_policy: 'install-allowed', via: [], verified: false, trust: 'community' },
    ]);
    expect(payload.components).toEqual([
      { kind: 'extensions', id: 'child-ext', version: '2.0.0', overrides: [{ version: '1.0.0', origin: ['child'] }] },
    ]);
    const text = await run(['info', 'demo-bundle']);
    expect(text.out).toContain('References:');
    expect(text.out).toContain('child v1.0.0 (c; community)');
    expect(text.out).toContain('child-ext v2.0.0 (overrides 1.0.0 from child)');
  });

  test('validate reports unexpanded references offline and expansion errors online', async () => {
    const dir = path.join(tmp, 'parent');
    writeManifest(dir, referenceManifestDict([{ id: 'child', version: '1.0.0' }]));
    let r = await run(['validate', '--path', dir, '--offline']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Offline: bundle reference 'child@1.0.0' (demo-bundle → child) was not expanded.");
    configureCatalog({});
    r = await run(['validate', '--path', dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Cannot resolve bundle reference child@1.0.0 (demo-bundle)');
    writeManifest(dir, referenceManifestDict([{ id: 'child', version: '1.0.0' }], { schemaVersion: '1.0' }));
    r = await run(['validate', '--path', dir]);
    expect(r.out).toContain('Bundle references require schema_version "1.1".');
    expect(r.out).not.toContain('Cannot resolve');
  });

  test('list counts required components; policy errors honor --json', async () => {
    writeFileSync(
      path.join(project, '.specify', 'bundle-records.json'),
      JSON.stringify({
        schema_version: '1.0',
        bundles: [
          {
            bundle_id: 'b',
            version: '1.0.0',
            installed_at: 'now',
            contributed_components: [],
            required_components: [{ kind: 'extensions', id: 'x' }],
          },
        ],
      }),
    );
    let r = await run(['list']);
    expect(r.out).toContain('b v1.0.0 (1 components, installed now)');
    writeFileSync(path.join(project, '.specify', 'init-options.json'), '{"allow_symlinks": 1}');
    r = await run(['list', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err)).toEqual({ error: '.specify/init-options.json: allow_symlinks must be a JSON boolean (true or false)' });
  });

  test('install failures print recovery notes after the error', async () => {
    const dir = path.join(tmp, 'local');
    writeManifest(dir);
    commandDeps.makeInstaller = () => ({
      isInstalled: () => false,
      install: () => {
        throw Object.assign(new BundlerError('boom'), { notes: ["Could not restore step 's' from backup '/tmp/x': denied"] });
      },
      remove: () => undefined,
    });
    const r = await run(['install', dir]);
    expect(r.code).toBe(1);
    expect(r.err.replace(/\s+/g, ' ')).toContain("Error: boom Could not restore step 's' from backup '/tmp/x': denied");
  });
});
