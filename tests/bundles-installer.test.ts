/**
 * Bundle installer lifecycle and packager. Ports of
 * tests/specify_cli/bundles/{test_installer,test_packager}.py.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { BundlerError } from '../src/bundles/index.js';
import { BundleManifest, ComponentRef } from '../src/bundles/manifest.js';
import { InstalledBundleRecord, loadRecords, recordsPath, saveRecords } from '../src/bundles/records.js';
import { InstallResult, installBundle, removeBundle, type PrimitiveInstaller } from '../src/bundles/installer.js';
import { resolveInstallPlan, type InstallPlan } from '../src/bundles/resolver.js';
import { buildBundle } from '../src/bundles/packager.js';
import { FakeInstaller, makeProject, validManifestDict, writeManifest } from './bundles-helpers.js';

let tmp: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'bundles-inst-')));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function plan(manifest: BundleManifest): InstallPlan {
  return resolveInstallPlan(manifest, { speckitVersion: '0.11.2', activeIntegration: 'copilot' });
}

function bundle(id: string, extIds: string[], version = '1.0.0'): BundleManifest {
  return BundleManifest.fromDict(
    validManifestDict({
      bundle: { id, name: id, version, role: 'developer', description: 'd', author: 'a', license: 'MIT' },
      provides: { extensions: extIds.map((e) => ({ id: e, version: '1.0.0' })) },
    }),
  );
}

async function rejects(p: Promise<unknown>, match: string): Promise<Error> {
  let caught: unknown;
  try {
    await p;
  } catch (exc) {
    caught = exc;
  }
  expect(caught).toBeInstanceOf(BundlerError);
  expect((caught as Error).message).toContain(match);
  return caught as Error;
}

// ============================================================================
// Installer
// ============================================================================

describe('installer', () => {
  test('install records and invokes primitives; idempotent', async () => {
    makeProject(tmp);
    const m = BundleManifest.fromDict(validManifestDict());
    const installer = new FakeInstaller();
    const result = await installBundle(tmp, plan(m), installer, m);
    expect(result.installed).toHaveLength(4);
    expect(installer.installCalls).toHaveLength(4);
    expect(loadRecords(tmp).map((r) => r.bundle_id)).toEqual(['demo-bundle']);

    const second = await installBundle(tmp, plan(m), installer, m);
    expect(second.installed).toEqual([]);
    expect(second.skipped).toHaveLength(4);
    expect(loadRecords(tmp)).toHaveLength(1);
  });

  test('version change without refresh rejected', async () => {
    makeProject(tmp);
    const installer = new FakeInstaller();
    const v1 = bundle('demo', ['ext-a'], '1.0.0');
    await installBundle(tmp, plan(v1), installer, v1);
    const v2 = bundle('demo', ['ext-a'], '2.0.0');
    await rejects(installBundle(tmp, plan(v2), installer, v2), "Use 'specify bundle update <id>' for a catalog bundle");
    expect(loadRecords(tmp)[0].version).toBe('1.0.0');
    expect(installer.installCalls).toHaveLength(1);
  });

  const changes: Array<[string, Record<string, unknown> | null]> = [
    ['extensions', { version: '2.0.0' }],
    ['presets', { version: '3.0.0' }],
    ['steps', { version: '1.0.0' }],
    ['workflows', { version: '0.4.0' }],
    ['extensions', { source: 'https://example.com/catalog.json' }],
    ['presets', { priority: 20 }],
    ['presets', { strategy: 'prepend' }],
    ['extensions', null],
    ['presets', null],
    ['steps', null],
    ['workflows', null],
  ];
  test.each(changes)('owned component change (%s, %p) requires refresh', async (kind, updates) => {
    makeProject(tmp);
    const data = validManifestDict() as { provides: Record<string, Array<Record<string, unknown>>> };
    const original = BundleManifest.fromDict(data);
    const installer = new FakeInstaller();
    await installBundle(tmp, plan(original), installer, original);
    const originalRecord = readFileSync(recordsPath(tmp));
    const originalInstalled = new Set(installer.installed);
    installer.installCalls.length = 0;

    const changedData = JSON.parse(JSON.stringify(data)) as typeof data;
    const componentId = String(changedData.provides[kind][0].id);
    if (updates === null) changedData.provides[kind] = [];
    else Object.assign(changedData.provides[kind][0], updates);
    changedData.provides.extensions.unshift({ id: 'ext-new', version: '1.0.0' });
    const changed = BundleManifest.fromDict(changedData);
    const p = plan(changed);

    await rejects(installBundle(tmp, p, installer, changed), '--refresh');
    expect(readFileSync(recordsPath(tmp)).equals(originalRecord)).toBe(true);
    expect(installer.installed).toEqual(originalInstalled);
    expect(installer.installCalls).toEqual([]);
    expect(installer.refreshCalls).toEqual([]);
    expect(installer.removeCalls).toEqual([]);

    const result = await installBundle(tmp, p, installer, changed, true);
    const record = loadRecords(tmp)[0];
    expect(record.version).toBe(original.bundle.version);
    expect(record.contributed_components.map((c) => c.identity())).toEqual(p.components.map((c) => c.identity()));
    expect(result.installed.map((c) => [c.kind, c.id])).toEqual([['extensions', 'ext-new']]);
    if (updates === null) {
      expect(installer.removeCalls).toEqual([[kind, componentId]]);
      expect(installer.installed.has(`${kind}:${componentId}`)).toBe(false);
    } else {
      expect(installer.refreshCalls).toContainEqual([kind, componentId]);
      expect(installer.removeCalls).toEqual([]);
    }
  });

  test('reordered components and additions are allowed', async () => {
    makeProject(tmp);
    const data = validManifestDict() as { provides: Record<string, Array<Record<string, unknown>>> };
    data.provides.extensions.push({ id: 'ext-b', version: '1.0.0' });
    const original = BundleManifest.fromDict(data);
    const installer = new FakeInstaller();
    await installBundle(tmp, plan(original), installer, original);

    data.provides.extensions.reverse();
    data.provides.steps.push({ id: 'ext-a' });
    const changed = BundleManifest.fromDict(data);
    const p = plan(changed);
    const result = await installBundle(tmp, p, installer, changed);
    expect(result.installed.map((c) => [c.kind, c.id])).toEqual([['steps', 'ext-a']]);
    expect(result.skipped).toHaveLength(5);
    expect(installer.refreshCalls).toEqual([]);
  });

  test('partial failure rolls back and records nothing', async () => {
    makeProject(tmp);
    const m = BundleManifest.fromDict(validManifestDict());
    const installer = new FakeInstaller({ failOn: 'preset-a' });
    await rejects(installBundle(tmp, plan(m), installer, m), 'Simulated failure installing preset-a');
    expect(installer.installed.size).toBe(0);
    expect(installer.removeCalls).toEqual([['extensions', 'ext-a']]);
    expect(existsSync(recordsPath(tmp))).toBe(false);
  });

  test('raw installer exception is wrapped', async () => {
    makeProject(tmp);
    const m = bundle('demo', ['ext-a']);
    const installer: PrimitiveInstaller = {
      isInstalled: () => false,
      install: () => {
        throw new TypeError('kaboom');
      },
      remove: () => undefined,
    };
    await rejects(installBundle(tmp, plan(m), installer, m), "Failed to install bundle 'demo': kaboom. No changes were recorded.");
  });

  test('integration clash from manifest blocks install', async () => {
    makeProject(tmp);
    const m = BundleManifest.fromDict(validManifestDict({ integration: { id: 'claude' } }));
    const p = resolveInstallPlan(m, { speckitVersion: '0.11.2', activeIntegration: 'claude' });
    p.effective_integration = 'copilot';
    await rejects(installBundle(tmp, p, new FakeInstaller(), m), "Bundle targets integration 'claude'");
  });

  test('remove is non-collateral', async () => {
    makeProject(tmp);
    const installer = new FakeInstaller();
    const a = bundle('a', ['shared', 'only-a']);
    const b = bundle('b', ['shared']);
    await installBundle(tmp, plan(a), installer, a);
    await installBundle(tmp, plan(b), installer, b);
    const result = await removeBundle(tmp, 'a', installer);
    expect(result.uninstalled.map((c) => c.id)).toEqual(['only-a']);
    expect(result.skipped.map((c) => c.id)).toEqual(['shared']);
    expect(installer.installed.has('extensions:shared')).toBe(true);
    expect(loadRecords(tmp).map((r) => r.bundle_id)).toEqual(['b']);
  });

  test('remove unknown bundle errors', async () => {
    makeProject(tmp);
    await rejects(removeBundle(tmp, 'nope', new FakeInstaller()), "Bundle 'nope' is not installed.");
  });

  test('remove partial-failure messages', async () => {
    makeProject(tmp);
    const comps = [new ComponentRef({ kind: 'extensions', id: 'x' }), new ComponentRef({ kind: 'extensions', id: 'y' })];
    saveRecords(tmp, [InstalledBundleRecord.create('b', '1.0.0', comps)]);
    const failing = (failId: string, installed = true): PrimitiveInstaller => ({
      isInstalled: () => installed,
      install: () => undefined,
      remove: (_r, c) => {
        if (c.id === failId) throw new Error('disk full');
      },
    });
    await rejects(
      removeBundle(tmp, 'b', failing('y')),
      "Failed to remove bundle 'b': disk full. 1 component(s) were already removed before this failure",
    );
    await rejects(removeBundle(tmp, 'b', failing('x')), 'No components were removed, but the failing component may have made partial changes');
    expect(loadRecords(tmp)).toHaveLength(1);
  });

  test('remove record save failure without a remove attempt is not partial', async () => {
    makeProject(tmp);
    saveRecords(tmp, [InstalledBundleRecord.create('b', '1.0.0', [new ComponentRef({ kind: 'extensions', id: 'x' })])]);
    const installer: PrimitiveInstaller = { isInstalled: () => false, install: () => undefined, remove: () => undefined };
    chmodSync(path.join(tmp, '.specify'), 0o500);
    try {
      await rejects(removeBundle(tmp, 'b', installer), 'No components were removed and no removal was attempted');
    } finally {
      chmodSync(path.join(tmp, '.specify'), 0o755);
    }
  });

  test('refresh falls back to install without hook; installed_at preserved', async () => {
    makeProject(tmp);
    const installed = new Set<string>();
    const installs: string[] = [];
    const installer: PrimitiveInstaller = {
      isInstalled: (_r, c) => installed.has(c.id),
      install: (_r, c) => {
        installs.push(c.id);
        installed.add(c.id);
      },
      remove: (_r, c) => {
        installed.delete(c.id);
      },
    };
    const m = bundle('demo', ['ext-a']);
    await installBundle(tmp, plan(m), installer, m);
    const firstAt = '2020-01-01T00:00:00Z';
    const rec = loadRecords(tmp)[0];
    saveRecords(tmp, [new InstalledBundleRecord({ ...rec, installed_at: firstAt })]);
    const result = await installBundle(tmp, plan(m), installer, m, true);
    expect(result.refreshed.map((c) => c.id)).toEqual(['ext-a']);
    expect(installs).toEqual(['ext-a', 'ext-a']);
    expect(loadRecords(tmp)[0].installed_at).toBe(firstAt);
  });

  test('independently installed component is neither refreshed, attributed nor removed', async () => {
    makeProject(tmp);
    const installer = new FakeInstaller();
    installer.installed.add('extensions:ext-a');
    const m = bundle('demo', ['ext-a', 'ext-b']);
    const result = await installBundle(tmp, plan(m), installer, m, true);
    expect(result.skipped.map((c) => c.id)).toEqual(['ext-a']);
    expect(installer.refreshCalls).toEqual([]);
    expect(loadRecords(tmp)[0].contributed_components.map((c) => c.id)).toEqual(['ext-b']);
    await removeBundle(tmp, 'demo', installer);
    expect(installer.installed.has('extensions:ext-a')).toBe(true);
  });

  test('update uninstalls dropped components but keeps sibling-owned ones', async () => {
    makeProject(tmp);
    const installer = new FakeInstaller();
    const v1 = bundle('demo', ['keep', 'drop', 'shared']);
    const sib = bundle('sib', ['shared']);
    await installBundle(tmp, plan(v1), installer, v1);
    await installBundle(tmp, plan(sib), installer, sib);
    const v2 = bundle('demo', ['keep'], '2.0.0');
    const result = await installBundle(tmp, plan(v2), installer, v2, true);
    expect(result.uninstalled.map((c) => c.id)).toEqual(['drop']);
    expect(result.changed).toBe(true);
    expect(installer.installed.has('extensions:shared')).toBe(true);
    const rec = loadRecords(tmp).find((r) => r.bundle_id === 'demo')!;
    expect(rec.version).toBe('2.0.0');
    expect(rec.contributed_components.map((c) => c.id)).toEqual(['keep']);
  });

  test('InstallResult.changed reports uninstalled', () => {
    const r = new InstallResult('x');
    expect(r.changed).toBe(false);
    r.uninstalled.push(new ComponentRef({ kind: 'extensions', id: 'a' }));
    expect(r.changed).toBe(true);
  });
});

// ============================================================================
// Packager
// ============================================================================

interface ZipEntry {
  name: string;
  data: Buffer;
  externalAttr: number;
}

function readZip(file: string): ZipEntry[] {
  const buf = readFileSync(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const externalAttr = buf.readUInt32LE(off + 38);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf-8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtra = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtra;
    out.push({ name, data: inflateRawSync(buf.subarray(start, start + compSize)), externalAttr });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function makeBundle(dir: string, overrides: Record<string, unknown> = {}): string {
  writeManifest(dir, validManifestDict(overrides));
  writeFileSync(path.join(dir, 'README.md'), '# Demo\n');
  return dir;
}

describe('packager', () => {
  test('artifact named by id and version and contains manifest and assets', () => {
    const dir = makeBundle(path.join(tmp, 'b'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'assets', 'x.txt'), 'hello');
    const result = buildBundle(dir);
    expect(path.basename(result.artifact_path)).toBe('demo-bundle-1.2.0.zip');
    expect(result.file_count).toBe(3);
    const entries = readZip(result.artifact_path);
    expect(entries.map((e) => e.name)).toEqual(['README.md', 'assets/x.txt', 'bundle.yml']);
    expect(entries[1].data.toString()).toBe('hello');
  });

  test('refuses invalid manifest, missing manifest, missing README, unsafe id', () => {
    const bad = makeBundle(path.join(tmp, 'bad'), { schema_version: '9' });
    expect(() => buildBundle(bad)).toThrow("Refusing to build an invalid manifest. Run 'specify bundle validate' and fix:\n  - ");
    const empty = path.join(tmp, 'empty');
    mkdirSync(empty);
    expect(() => buildBundle(empty)).toThrow('No bundle.yml found in');
    const noReadme = path.join(tmp, 'noreadme');
    writeManifest(noReadme);
    expect(() => buildBundle(noReadme)).toThrow('Every bundle must ship a README.md describing it.');
    const unsafe = makeBundle(path.join(tmp, 'unsafe'), {
      bundle: { id: '../evil', name: 'n', version: '1.0.0', role: 'r', description: 'd', author: 'a', license: 'MIT' },
    });
    expect(() => buildBundle(unsafe)).toThrow('must be a slug');
  });

  test('build is deterministic', () => {
    const dir = makeBundle(path.join(tmp, 'b'));
    const out1 = path.join(tmp, 'o1');
    const out2 = path.join(tmp, 'o2');
    const a = readFileSync(buildBundle(dir, out1).artifact_path);
    const b = readFileSync(buildBundle(dir, out2).artifact_path);
    expect(a.equals(b)).toBe(true);
  });

  test('prior artifacts and output dir inside bundle are excluded; asset zips kept', () => {
    const dir = makeBundle(path.join(tmp, 'b'));
    writeFileSync(path.join(dir, 'demo-bundle-0.9.0.zip'), 'old');
    writeFileSync(path.join(dir, 'demo-bundle-1.0.0-rc.1+build.5.zip'), 'old');
    writeFileSync(path.join(dir, 'demo-bundle-assets.zip'), 'asset');
    const first = buildBundle(dir, path.join(dir, 'dist'));
    const second = buildBundle(dir, path.join(dir, 'dist'));
    const names = readZip(second.artifact_path).map((e) => e.name);
    expect(names).toEqual(['README.md', 'bundle.yml', 'demo-bundle-assets.zip']);
    expect(first.file_count).toBe(second.file_count);
    buildBundle(dir);
    expect(readZip(buildBundle(dir).artifact_path).map((e) => e.name)).not.toContain('demo-bundle-1.2.0.zip');
  });

  test('symlinks are not followed or packaged; excluded names skipped', () => {
    const dir = makeBundle(path.join(tmp, 'b'));
    const outside = path.join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, path.join(dir, 'linked-dir'));
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'linked-file.txt'));
    mkdirSync(path.join(dir, '.git'));
    writeFileSync(path.join(dir, '.git', 'HEAD'), 'x');
    writeFileSync(path.join(dir, '.DS_Store'), 'x');
    const names = readZip(buildBundle(dir).artifact_path).map((e) => e.name);
    expect(names).toEqual(['README.md', 'bundle.yml']);
  });

  test('executable bit preserved as normalized mode', () => {
    const dir = makeBundle(path.join(tmp, 'b'));
    writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n');
    chmodSync(path.join(dir, 'run.sh'), 0o700);
    const entries = readZip(buildBundle(dir).artifact_path);
    const mode = (name: string) => (entries.find((e) => e.name === name)!.externalAttr >>> 16) & 0o777;
    expect(mode('run.sh')).toBe(0o755);
    expect(mode('README.md')).toBe(0o644);
  });
});
