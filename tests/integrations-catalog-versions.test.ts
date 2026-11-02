/**
 * Versioned integration catalog metadata and exact-release lookup
 * (port of upstream tests/specify_cli/integrations/test_catalog_versions.py,
 * spec-kit v1.2.5).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IntegrationCatalog, catalogShapeError } from '../src/integrations/index.js';

const CURRENT: Record<string, unknown> = {
  id: 'sample',
  name: 'Sample Agent',
  author: 'example',
  version: '2.0.0',
  description: 'Current release',
  repository: 'https://example.com/current',
  tags: ['current'],
  requires: { speckit_version: '>=1.0' },
  download_url: 'https://example.com/current.zip',
  releases: {
    '1.0.0': {
      description: 'Historical release',
      repository: 'https://example.com/old',
      tags: ['historical'],
      requires: { speckit_version: '>=0.7' },
    },
    '1.5.0': { description: 'Intermediate release' },
  },
};

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'speckit-catver-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function catalogWith(items: Array<Record<string, unknown>>): IntegrationCatalog {
  const catalog = new IntegrationCatalog(tmp);
  catalog.getMergedIntegrations = async () => items;
  return catalog;
}

describe('exact-release lookup', () => {
  test('legacy entry keeps current fields and exact lookup', async () => {
    const legacy = Object.fromEntries(Object.entries(CURRENT).filter(([k]) => k !== 'releases'));
    const catalog = catalogWith([legacy]);
    expect(await catalog.getIntegrationInfo('sample')).toBe(legacy);
    expect(await catalog.getIntegrationInfo('sample', '2.0.0')).toBe(legacy);
    expect(await catalog.getIntegrationInfo('sample', '1.0.0')).toBeNull();
    expect(await catalog.getIntegrationVersions('sample')).toEqual(['2.0.0']);
  });

  test('missing legacy version cannot be selected as empty string', async () => {
    const catalog = catalogWith([{ id: 'sample', name: 'Sample Agent', version: '' }]);
    expect((await catalog.getIntegrationInfo('sample'))!.name).toBe('Sample Agent');
    expect(await catalog.getIntegrationInfo('sample', '')).toBeNull();
    expect(await catalog.getIntegrationVersions('sample')).toEqual([]);
  });

  test('exact release returns selected metadata, not current', async () => {
    const entry = { ...CURRENT, _catalog_name: 'primary', _install_allowed: false };
    const catalog = catalogWith([entry]);
    expect(await catalog.getIntegrationInfo('sample')).toBe(entry);
    const selected = await catalog.getIntegrationInfo('sample', 'v1.0');
    expect(selected).toEqual({
      id: 'sample',
      name: 'Sample Agent',
      author: 'example',
      version: '1.0.0',
      description: 'Historical release',
      repository: 'https://example.com/old',
      tags: ['historical'],
      requires: { speckit_version: '>=0.7' },
      _catalog_name: 'primary',
      _install_allowed: false,
    });
    expect(await catalog.getIntegrationInfo('sample', 'v2.0')).toBe(entry);
    expect(await catalog.getIntegrationVersions('sample')).toEqual(['2.0.0', '1.5.0', '1.0.0']);
    expect('download_url' in selected!).toBe(false);
  });

  test('missing version does not fall back to lower priority', async () => {
    const winning = { ...CURRENT, _catalog_name: 'primary', _install_allowed: false };
    const lower = { ...CURRENT, _catalog_name: 'secondary', _install_allowed: true, releases: { '0.9.0': { description: 'x' } } };
    const catalog = catalogWith([winning, lower]);
    expect(await catalog.getIntegrationInfo('sample', '0.9.0')).toBeNull();
    expect(await catalog.getIntegrationInfo('sample', 'bad version')).toBeNull();
    expect(await catalog.getIntegrationInfo('missing', '2.0.0')).toBeNull();
    expect(await catalog.getIntegrationVersions('missing')).toEqual([]);
  });
});

describe('malformed release history is rejected', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ releases: [] }, 'releases'],
    [{ releases: { '1.0.0': [] } }, 'object'],
    [{ releases: { 'not-a-version': {} } }, 'version'],
    [{ version: 'not-a-version' }, 'current version'],
    [{ version: null }, 'current version'],
    [{ releases: { '2.0.0': {} } }, 'repeats'],
    [{ releases: { 'v2.0': {} } }, 'repeats'],
    [{ releases: { '1.0.0': {}, 'v1.0': {} } }, 'repeats'],
    [{ releases: { '1.0.0': { version: '0.9' } } }, 'reserved'],
    [{ releases: { '1.0.0': { id: 'different' } } }, 'reserved'],
    [{ releases: { '1.0.0': { _install_allowed: true } } }, 'reserved'],
    [{ releases: { '1.0.0': { releases: {} } } }, 'reserved'],
    [{ releases: { '1.0.0': { tags: 'cli' } } }, 'tags'],
    [{ releases: { '1.0.0': { tags: [42] } } }, 'tags'],
    [{ releases: { '1.0.0': { requires: [] } } }, 'requires'],
    [{ releases: { '1.0.0': { description: 42 } } }, 'description'],
    [{ releases: { '1.0.0': { download_url: 'https://example.com/a.zip' } } }, 'unsupported'],
    [{ id: 'different' }, 'inconsistent id'],
    [{ releases: { '': {} } }, 'version key'],
    [{ releases: { '1.0.0': { repository: null } } }, 'repository'],
    [{ releases: { '1.0.0': { _catalog_name: 'other' } } }, 'reserved'],
  ];
  for (const [change, reason] of cases) {
    test(`${JSON.stringify(change)} -> ${reason}`, () => {
      const entry = { ...structuredClone(CURRENT), ...change };
      const err = catalogShapeError({ schema_version: '1.0', integrations: { sample: entry } });
      expect(err).toContain(reason);
    });
  }
});
