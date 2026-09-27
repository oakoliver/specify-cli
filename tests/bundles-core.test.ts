/**
 * Bundler core: versioning, yamlio, manifest, validator, resolver, conflict, records.
 * Ports of tests/specify_cli/bundles/{test_versioning,test_yamlio,test_validator,
 * test_resolver,test_conflict,test_records}.py and tests/contract/test_manifest_schema.py.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { BundlerError } from '../src/bundles/index.js';
import { BundlerError as CompatBundlerError } from '../src/bundler.js';
import { isSemver, parseConstraint, parseVersion, satisfies } from '../src/bundles/versioning.js';
import { dumpYaml, loadJson, loadYaml, dumpJson, ensureWithin, isSafeRelpath } from '../src/bundles/yamlio.js';
import { BundleManifest, ComponentRef } from '../src/bundles/manifest.js';
import { validateManifest } from '../src/bundles/validator.js';
import { resolveInstallPlan } from '../src/bundles/resolver.js';
import { detectConflicts } from '../src/bundles/conflict.js';
import {
  InstalledBundleRecord,
  componentKey,
  componentsStillNeeded,
  loadRecords,
  recordsPath,
  removeRecord,
  saveRecords,
  upsertRecord,
} from '../src/bundles/records.js';
import { validManifestDict } from './bundles-helpers.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'bundles-core-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function manifest(overrides: Record<string, unknown> = {}): BundleManifest {
  return BundleManifest.fromDict(validManifestDict(overrides));
}

function expectBundlerError(fn: () => unknown, match: string | RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (exc) {
    caught = exc;
  }
  expect(caught).toBeInstanceOf(BundlerError);
  const msg = (caught as Error).message;
  if (typeof match === 'string') expect(msg).toContain(match);
  else expect(msg).toMatch(match);
}

// ============================================================================
// versioning
// ============================================================================

describe('versioning', () => {
  test.each([
    ['1.0.0', true],
    ['0.11.2', true],
    ['1.2.3-rc1', true],
    ['1.2.3-alpha1', true],
    ['1.2.3-beta2', true],
    ['v1.2.3', true],
    ['V1.2.3', true],
    ['not-a-version', false],
    ['', false],
    ['1', false],
    ['1.0', false],
    ['1.2.3.4', false],
  ])('isSemver(%p) -> %p', (value, expected) => {
    expect(isSemver(value as string)).toBe(expected as boolean);
  });

  test.each([
    ['0.11.2', '>=0.1.0', true],
    ['0.11.2', '>=1.0.0', false],
    ['1.0.0', '>=1.0.0,<2.0.0', true],
    ['2.0.0', '>=1.0.0,<2.0.0', false],
    ['1.5.0', '', true],
    ['1.2.3-rc1', '>=1.2.0', true],
    ['1.2.3-alpha1', '>=2.0.0', false],
    ['V1.2.3', '>=1.2.0', true],
    ['1.2.3-rc2', '>=1.2.3-rc1', true],
    ['1.2.2', '>=1.2.3-rc1', false],
    ['1.5.0', '>=1.2.3-rc1,<2.0.0', true],
    ['1.2.3-beta.1', '>=1.2.3-alpha1', true],
    ['1.4.2', '~=1.4', true],
    ['2.0.0', '~=1.4', false],
    ['1.4.9', '==1.4.*', true],
    ['1.5.0', '!=1.5.0', false],
    ['1.0.0.dev1', '<1.0.0', false],
    ['0.9.0.dev1', '<1.0.0', true],
  ])('satisfies(%p, %p) -> %p', (installed, constraint, ok) => {
    expect(satisfies(installed as string, constraint as string)).toBe(ok as boolean);
  });

  test('invalid constraint raises BundlerError', () => {
    expectBundlerError(() => satisfies('1.0.0', '>>bad'), "Invalid version constraint '>>bad'");
  });

  test('invalid version raises BundlerError with packaging text', () => {
    expectBundlerError(() => parseVersion('nope'), "Invalid version 'nope': Invalid version: 'nope'");
  });

  test('empty constraint is permissive', () => {
    expect(parseConstraint('').contains(parseVersion('0.0.1'))).toBe(true);
  });

  test('version equality normalizes', () => {
    expect(parseVersion('v2.0.0').equals(parseVersion('2.0.0'))).toBe(true);
    expect(parseVersion('1.0').equals(parseVersion('1.0.0'))).toBe(true);
    expect(parseVersion('1.0.0rc1').compare(parseVersion('1.0.0')) < 0).toBe(true);
  });

  test('bundler compat module re-exports BundlerError', () => {
    expect(CompatBundlerError).toBe(BundlerError);
  });
});

// ============================================================================
// yamlio
// ============================================================================

describe('yamlio', () => {
  test('dumpYaml preserves unicode and round trips', () => {
    const p = path.join(tmp, 'f.yml');
    const data = { note: 'café-münchen', url: 'https://例え.example' };
    dumpYaml(p, data);
    const raw = readFileSync(p, 'utf-8');
    expect(raw).toContain('café-münchen');
    expect(raw).toContain('例え');
    expect(raw).not.toContain('\\x');
    expect(raw).not.toContain('\\u');
    expect(loadYaml(p)).toEqual(data);
  });

  test('dumpYaml keeps insertion order (sort_keys=False)', () => {
    const p = path.join(tmp, 'o.yml');
    dumpYaml(p, { schema_version: '1.0', catalogs: [] });
    expect(readFileSync(p, 'utf-8').indexOf('schema_version')).toBe(0);
  });

  test('loadYaml non-utf8 raises BundlerError', () => {
    const p = path.join(tmp, 'bundle-catalogs.yml');
    writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('catalogs: []\n', 'utf16le')]));
    expectBundlerError(() => loadYaml(p), 'Could not read');
  });

  test('loadJson non-utf8 raises BundlerError', () => {
    const p = path.join(tmp, 'records.json');
    writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"bundles": []}', 'utf16le')]));
    expectBundlerError(() => loadJson(p), 'Could not read');
  });

  test('loadJson malformed reports Invalid JSON', () => {
    const p = path.join(tmp, 'records.json');
    writeFileSync(p, '{"bundles": [', 'utf-8');
    expectBundlerError(() => loadJson(p), 'Invalid JSON');
  });

  test('loadYaml: empty document -> {}, explicit null stays null, list preserved', () => {
    const p = path.join(tmp, 'x.yml');
    writeFileSync(p, '# only a comment\n');
    expect(loadYaml(p)).toEqual({});
    writeFileSync(p, 'null\n');
    expect(loadYaml(p)).toBeNull();
    writeFileSync(p, '[]\n');
    expect(loadYaml(p)).toEqual([]);
  });

  test('loadYaml missing file', () => {
    expectBundlerError(() => loadYaml(path.join(tmp, 'nope.yml')), 'File not found');
  });

  test('ensureWithin refuses traversal and symlink escape', () => {
    expectBundlerError(() => ensureWithin(tmp, path.join(tmp, '..', 'x')), 'escapes the allowed root');
    const outside = mkdtempSync(path.join(tmpdir(), 'bundles-outside-'));
    try {
      symlinkSync(outside, path.join(tmp, 'link'));
      expectBundlerError(() => ensureWithin(tmp, path.join(tmp, 'link', 'f')), 'escapes the allowed root');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(ensureWithin(tmp, path.join(tmp, 'a', 'b'))).toContain(path.join('a', 'b'));
  });

  test('dumpJson writes pretty JSON with trailing newline and ASCII escapes', () => {
    const p = path.join(tmp, 'd', 'x.json');
    dumpJson(p, { a: 1, s: 'é' });
    expect(readFileSync(p, 'utf-8')).toBe('{\n  "a": 1,\n  "s": "\\u00e9"\n}\n');
  });

  test('isSafeRelpath', () => {
    expect(isSafeRelpath('a/b.md')).toBe(true);
    expect(isSafeRelpath('')).toBe(false);
    expect(isSafeRelpath('/abs')).toBe(false);
    expect(isSafeRelpath('C:\\x')).toBe(false);
    expect(isSafeRelpath('a/../../b')).toBe(false);
  });
});

// ============================================================================
// manifest (contract)
// ============================================================================

describe('manifest schema', () => {
  test('valid manifest has no structural errors', () => {
    const m = manifest();
    expect(m.structuralErrors()).toEqual([]);
    expect(m.components.map((c) => c.kind)).toEqual(['extensions', 'presets', 'steps', 'workflows']);
    expect(m.isAgnostic()).toBe(true);
    expect(m.tags).toEqual(['demo', 'test']);
  });

  test('missing required field is reported by name', () => {
    const data = validManifestDict();
    delete (data.bundle as Record<string, unknown>).author;
    const errors = BundleManifest.fromDict(data).structuralErrors();
    expect(errors).toContain('Missing required field: bundle.author.');
  });

  test.each(['author', 'license', 'description', 'name'])('explicit null bundle.%s is missing', (field) => {
    const data = validManifestDict();
    (data.bundle as Record<string, unknown>)[field] = null;
    const m = BundleManifest.fromDict(data);
    expect(m.structuralErrors()).toContain(`Missing required field: bundle.${field}.`);
    expect((m.bundle as unknown as Record<string, string>)[field]).toBe('');
  });

  test('explicit null speckit_version is missing', () => {
    const m = manifest({ requires: { speckit_version: null } });
    expect(m.structuralErrors()).toContain('Missing required field: requires.speckit_version.');
  });

  test('explicit null component id is not named None', () => {
    const m = manifest({ provides: { extensions: [{ id: null, version: '1.0.0' }] } });
    const errors = m.structuralErrors();
    expect(errors).toContain("A extension entry is missing its 'id'.");
    expect(errors.join('\n')).not.toContain('None');
  });

  test('unsupported schema version', () => {
    const errors = manifest({ schema_version: '2.0' }).structuralErrors();
    expect(errors[0]).toBe("schema_version '2.0' is not supported (supported: ['1.0']).");
  });

  test('non-semver bundle version', () => {
    const data = validManifestDict();
    (data.bundle as Record<string, unknown>).version = '1.0';
    expect(BundleManifest.fromDict(data).structuralErrors()).toContain("bundle.version '1.0' is not valid semver.");
  });

  test('preset requires priority and strategy', () => {
    const m = manifest({ provides: { presets: [{ id: 'p', version: '1.0.0' }] } });
    const errors = m.structuralErrors();
    expect(errors).toContain("preset 'p' must declare an integer 'priority'.");
    expect(errors).toContain(
      "preset 'p' has invalid strategy 'None' (must be one of ['append', 'prepend', 'replace', 'wrap']).",
    );
  });

  test('non-integer priority raises', () => {
    expect(() => manifest({ provides: { presets: [{ id: 'p', version: '1.0.0', priority: 'high' }] } })).toThrow(
      "provides.presets priority must be an integer, got 'high'.",
    );
    expect(() => manifest({ provides: { presets: [{ id: 'p', version: '1.0.0', priority: true }] } })).toThrow(
      'priority must be an integer, got True.',
    );
    expect(manifest({ provides: { presets: [{ id: 'p', version: '1.0.0', priority: '5' }] } }).presets[0].priority).toBe(5);
  });

  test('non-step components must be pinned; steps may be unpinned', () => {
    const m = manifest({ provides: { workflows: [{ id: 'wf' }], steps: [{ id: 's' }] } });
    expect(m.structuralErrors()).toEqual(["workflow 'wf' must be pinned to a 'version'."]);
  });

  test('integration makes bundle non-agnostic; string integration rejected', () => {
    expect(manifest({ integration: { id: 'claude' } }).isAgnostic()).toBe(false);
    expect(() => manifest({ integration: 'copilot' })).toThrow("'integration' must be a mapping when present.");
  });

  test('string / non-string-member lists rejected', () => {
    expect(() => manifest({ tags: 'demo' })).toThrow("'tags' must be a list of strings when present.");
    expect(() => manifest({ requires: { speckit_version: '>=1', tools: 'git' } })).toThrow(
      "'requires.tools' must be a list of strings",
    );
    expect(() => manifest({ requires: { speckit_version: '>=1', mcp: 'x' } })).toThrow(
      "'requires.mcp' must be a list of strings",
    );
    expect(() => manifest({ tags: ['ok', 1] })).toThrow('must be a list of strings');
    expect(() => manifest({ requires: { speckit_version: '>=1', tools: [null] } })).toThrow('must be a list of strings');
  });

  test.each([[[]], [''], [0], [false]])('non-mapping provides/requires rejected (%p)', (bad) => {
    expect(() => manifest({ provides: bad })).toThrow("'provides' must be a mapping when present.");
    expect(() => manifest({ requires: bad })).toThrow("'requires' must be a mapping when present.");
  });

  test('absent provides and requires are fine', () => {
    const data = validManifestDict();
    delete data.provides;
    delete data.requires;
    const m = BundleManifest.fromDict(data);
    expect(m.components).toEqual([]);
  });

  test('unsafe bundle id flagged', () => {
    const data = validManifestDict();
    (data.bundle as Record<string, unknown>).id = '../evil';
    expect(BundleManifest.fromDict(data).structuralErrors().join('\n')).toContain("bundle.id '../evil' must be a slug");
  });

  test('top-level must be a mapping; bundle required', () => {
    expect(() => BundleManifest.fromDict([])).toThrow('Manifest must be a YAML mapping at the top level.');
    expect(() => BundleManifest.fromDict({})).toThrow("Manifest is missing the required 'bundle' mapping.");
    expect(() => manifest({ provides: { extensions: 'x' } })).toThrow('provides.extensions must be a list when present.');
    expect(() => manifest({ provides: { extensions: ['x'] } })).toThrow('Each provides.extensions entry must be a mapping.');
  });

  test('label', () => {
    expect(new ComponentRef({ kind: 'steps', id: 's' }).label()).toBe('step:s@unpinned');
    expect(new ComponentRef({ kind: 'presets', id: 'p', version: '1.0.0' }).label()).toBe('preset:p@1.0.0');
  });
});

// ============================================================================
// validator
// ============================================================================

describe('validator', () => {
  test('invalid speckit constraint reported', async () => {
    const report = await validateManifest(manifest({ requires: { speckit_version: '>>bad' } }));
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.includes('speckit_version'))).toBe(true);
  });

  test('reference checker errors are labelled', async () => {
    const report = await validateManifest(manifest(), (c) => (c.kind === 'steps' ? 'nope' : null));
    expect(report.errors).toEqual(['Unresolved reference step:step-a@unpinned: nope']);
  });
});

// ============================================================================
// resolver
// ============================================================================

describe('resolver', () => {
  const opts = { speckitVersion: '0.11.2', activeIntegration: 'copilot' as string | null };

  test('plan expands all components', () => {
    const plan = resolveInstallPlan(manifest(), opts);
    expect(plan.componentCount).toBe(4);
    expect(plan.bundle_id).toBe('demo-bundle');
    expect(plan.effective_integration).toBe('copilot');
    expect(Object.keys(plan.grouped())).toEqual(['extensions', 'presets', 'steps', 'workflows']);
  });

  test('version gate refuses incompatible', () => {
    expectBundlerError(
      () => resolveInstallPlan(manifest({ requires: { speckit_version: '>=99.0.0' } }), opts),
      "Bundle 'demo-bundle' requires Spec Kit >=99.0.0, but this project uses 0.11.2.",
    );
  });

  test('integration clash halts', () => {
    expectBundlerError(
      () => resolveInstallPlan(manifest({ integration: { id: 'claude' } }), opts),
      "but this project's active integration is 'copilot'. Installing it would conflict; aborting with no changes.",
    );
  });

  test('matching integration allowed', () => {
    expect(resolveInstallPlan(manifest({ integration: { id: 'copilot' } }), opts).effective_integration).toBe('copilot');
  });

  test.each([[null], [''], ['   '], ['\t']])('pinned integration with indeterminate active (%p) fails', (active) => {
    expectBundlerError(
      () => resolveInstallPlan(manifest({ integration: { id: 'claude' } }), { speckitVersion: '0.11.2', activeIntegration: active }),
      'could not be determined',
    );
  });

  test('padded active integration is not a clash with itself', () => {
    const plan = resolveInstallPlan(manifest({ integration: { id: 'claude' } }), {
      speckitVersion: '0.11.2',
      activeIntegration: '  claude  ',
    });
    expect(plan.effective_integration).toBe('claude');
  });

  test('explicit override confirms target', () => {
    const plan = resolveInstallPlan(manifest({ integration: { id: 'claude' } }), {
      speckitVersion: '0.11.2',
      activeIntegration: 'claude',
      integrationExplicit: true,
    });
    expect(plan.effective_integration).toBe('claude');
  });

  test('tool requirements become warnings', () => {
    const plan = resolveInstallPlan(manifest({ requires: { speckit_version: '>=0.1.0', tools: ['docker'], mcp: ['gh'] } }), opts);
    expect(plan.warnings).toEqual(['Requires external tools: docker', 'Requires MCP servers: gh']);
  });

  test('invalid manifest cannot be resolved', () => {
    expectBundlerError(() => resolveInstallPlan(manifest({ schema_version: '9' }), opts), 'Cannot resolve an invalid manifest:\n  - ');
  });
});

// ============================================================================
// conflict
// ============================================================================

describe('conflict', () => {
  const record = (id: string, comps: ComponentRef[]) => InstalledBundleRecord.create(id, '1.0.0', comps);

  test('integration clash is blocking', () => {
    const report = detectConflicts(manifest({ integration: { id: 'claude' } }), 'copilot', []);
    expect(report.hasBlockingConflict).toBe(true);
    expect(report.integration_clash).toBe(
      "Bundle targets integration 'claude' but the project's active integration is 'copilot'.",
    );
  });

  test('agnostic bundle never clashes', () => {
    expect(detectConflicts(manifest(), 'copilot', []).hasBlockingConflict).toBe(false);
  });

  test('overlap with other bundle is reported; same bundle is not', () => {
    const other = record('other', [new ComponentRef({ kind: 'extensions', id: 'ext-a' })]);
    expect(detectConflicts(manifest(), null, [other]).overlaps).toEqual([
      "extension 'ext-a' is already provided by bundle 'other'.",
    ]);
    const same = record('demo-bundle', [new ComponentRef({ kind: 'extensions', id: 'ext-a' })]);
    expect(detectConflicts(manifest(), null, [same]).overlaps).toEqual([]);
  });
});

// ============================================================================
// records
// ============================================================================

describe('records', () => {
  function writeRecords(data: unknown): void {
    mkdirSync(path.join(tmp, '.specify'), { recursive: true });
    writeFileSync(recordsPath(tmp), JSON.stringify(data), 'utf-8');
  }

  test('save and load roundtrip', () => {
    mkdirSync(path.join(tmp, '.specify'));
    const rec = InstalledBundleRecord.create('b', '1.0.0', [
      new ComponentRef({ kind: 'presets', id: 'p', version: '1.0.0', priority: 0, strategy: 'append' }),
    ]);
    saveRecords(tmp, [rec]);
    const loaded = loadRecords(tmp);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].toDict()).toEqual(rec.toDict());
    expect(loaded[0].contributed_components[0].priority).toBe(0);
    const raw = JSON.parse(readFileSync(recordsPath(tmp), 'utf-8'));
    expect(raw.schema_version).toBe('1.0');
    expect(rec.installed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  test('missing file returns empty', () => {
    expect(loadRecords(tmp)).toEqual([]);
  });

  test.each([[0], [''], [false], [{}], ['x']])('non-list bundles rejected (%p)', (bad) => {
    writeRecords({ schema_version: '1.0', bundles: bad });
    expectBundlerError(() => loadRecords(tmp), "'bundles' must be a list");
  });

  test.each([[0], [''], [false], [{}]])('non-list contributed_components rejected (%p)', (bad) => {
    expectBundlerError(
      () => InstalledBundleRecord.fromDict({ bundle_id: 'b', version: '1', contributed_components: bad }),
      "'contributed_components' must be a list",
    );
  });

  test('corrupt priority raises', () => {
    writeRecords({
      schema_version: '1.0',
      bundles: [{ bundle_id: 'b', version: '1.0.0', contributed_components: [{ kind: 'presets', id: 'p', priority: 'x' }] }],
    });
    expectBundlerError(() => loadRecords(tmp), "Component priority must be an integer, got 'x'.");
  });

  test('unknown kind / missing id', () => {
    writeRecords({ schema_version: '1.0', bundles: [{ bundle_id: 'b', version: '1', contributed_components: [{ kind: 'bogus', id: 'x' }] }] });
    expectBundlerError(
      () => loadRecords(tmp),
      "component 'kind' must be one of ['extensions', 'presets', 'steps', 'workflows'], got 'bogus'.",
    );
    writeRecords({ schema_version: '1.0', bundles: [{ bundle_id: 'b', version: '1', contributed_components: [{ kind: 'presets', id: null }] }] });
    expectBundlerError(() => loadRecords(tmp), "missing its 'id'");
  });

  test('schema version checks', () => {
    writeRecords({ bundles: [] });
    expectBundlerError(() => loadRecords(tmp), "missing 'schema_version'");
    writeRecords({ schema_version: '2.0', bundles: [] });
    expectBundlerError(() => loadRecords(tmp), "Unsupported records schema version '2.0'");
    writeRecords({ schema_version: '1.7', bundles: [] });
    expect(loadRecords(tmp)).toEqual([]);
  });

  test.each([
    ['bundle_id', "missing its 'bundle_id'"],
    ['version', "missing its 'version'"],
  ])('explicit null %s treated as missing', (field, message) => {
    const rec: Record<string, unknown> = { bundle_id: 'b', version: '1.0.0', contributed_components: [] };
    rec[field] = null;
    writeRecords({ schema_version: '1.0', bundles: [rec] });
    expectBundlerError(() => loadRecords(tmp), message);
  });

  test('explicit null installed_at accepted as empty', () => {
    writeRecords({ schema_version: '1.0', bundles: [{ bundle_id: 'b', version: '1.0.0', installed_at: null }] });
    expect(loadRecords(tmp)[0].installed_at).toBe('');
  });

  test('upsert / remove / still-needed', () => {
    const a = InstalledBundleRecord.create('a', '1', [new ComponentRef({ kind: 'extensions', id: 'x' })]);
    const b = InstalledBundleRecord.create('b', '1', [new ComponentRef({ kind: 'extensions', id: 'y' })]);
    const a2 = InstalledBundleRecord.create('a', '2', []);
    expect(upsertRecord([a, b], a2).map((r) => [r.bundle_id, r.version])).toEqual([
      ['b', '1'],
      ['a', '2'],
    ]);
    expect(removeRecord([a, b], 'a').map((r) => r.bundle_id)).toEqual(['b']);
    expect([...componentsStillNeeded([a, b], 'a')]).toEqual([componentKey('extensions', 'y')]);
  });

  test('save refuses symlinked .specify escape', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'bundles-out-'));
    try {
      symlinkSync(outside, path.join(tmp, '.specify'));
      expectBundlerError(() => saveRecords(tmp, []), 'escapes the allowed root');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

