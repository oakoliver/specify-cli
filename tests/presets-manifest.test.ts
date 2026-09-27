/**
 * Tests for src/presets/manifest.ts and src/presets/registry.ts
 * (ports of upstream tests/specify_cli/presets/test_manifest.py and test_registry.py).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dumpYaml } from '../src/yaml.js';
import {
  PresetManifest,
  PresetValidationError,
  VALID_PRESET_STRATEGIES,
  VALID_PRESET_TEMPLATE_TYPES,
  VALID_SCRIPT_STRATEGIES,
} from '../src/presets/manifest.js';
import { PresetRegistry } from '../src/presets/registry.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'presets-manifest-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function validPackData(): Record<string, any> {
  return {
    schema_version: '1.0',
    preset: {
      id: 'test-pack',
      name: 'Test Preset',
      version: '1.0.0',
      description: 'A test preset',
      author: 'Test Author',
      repository: 'https://github.com/test/test-pack',
      license: 'MIT',
    },
    requires: { speckit_version: '>=0.1.0' },
    provides: {
      templates: [
        {
          type: 'template',
          name: 'spec-template',
          file: 'templates/spec-template.md',
          description: 'Custom spec template',
          replaces: 'spec-template',
        },
      ],
    },
    tags: ['testing', 'example'],
  };
}

function writeManifest(data: unknown): string {
  const p = join(tempDir, 'preset.yml');
  writeFileSync(p, dumpYaml(data), 'utf-8');
  return p;
}

function expectInvalid(data: unknown, pattern: RegExp): void {
  const p = writeManifest(data);
  let err: unknown;
  try {
    new PresetManifest(p);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(PresetValidationError);
  expect((err as Error).message).toMatch(pattern);
}

// ============================================================================
// PresetManifest
// ============================================================================

describe('PresetManifest', () => {
  test('valid manifest', () => {
    const m = new PresetManifest(writeManifest(validPackData()));
    expect(m.id).toBe('test-pack');
    expect(m.name).toBe('Test Preset');
    expect(m.version).toBe('1.0.0');
    expect(m.description).toBe('A test preset');
    expect(m.author).toBe('Test Author');
    expect(m.requiresSpeckitVersion).toBe('>=0.1.0');
    expect(m.templates.length).toBe(1);
    expect(m.tags).toEqual(['testing', 'example']);
  });

  test('missing manifest', () => {
    expect(() => new PresetManifest(join(tempDir, 'nonexistent.yml'))).toThrow(/Manifest not found/);
  });

  test('invalid yaml', () => {
    const p = join(tempDir, 'preset.yml');
    writeFileSync(p, 'invalid: yaml: content: [');
    expect(() => new PresetManifest(p)).toThrow(/Invalid YAML/);
  });

  test('utf-8 non-ascii description loads', () => {
    const data = validPackData();
    data.preset.description = 'Préréglage avec des caractères accentués — 日本語';
    const m = new PresetManifest(writeManifest(data));
    expect(m.description).toBe('Préréglage avec des caractères accentués — 日本語');
  });

  test('invalid utf-8 bytes raise validation error', () => {
    const p = join(tempDir, 'preset.yml');
    writeFileSync(p, Buffer.from([0x73, 0x63, 0x68, 0xff, 0xfe, 0x0a]));
    expect(() => new PresetManifest(p)).toThrow(/not valid UTF-8/);
  });

  test('non-mapping yaml raises validation error', () => {
    for (const content of ['- a\n- b\n', '"just a string"\n', '42\n']) {
      const p = join(tempDir, 'preset.yml');
      writeFileSync(p, content);
      expect(() => new PresetManifest(p)).toThrow(/YAML mapping/);
    }
  });

  test('empty document behaves as empty mapping', () => {
    const p = join(tempDir, 'preset.yml');
    writeFileSync(p, '');
    expect(() => new PresetManifest(p)).toThrow('Missing required field: schema_version');
  });

  for (const section of ['preset', 'requires', 'provides']) {
    test(`required section ${section} not a mapping`, () => {
      const data = validPackData();
      data[section] = 'not-a-mapping';
      expectInvalid(data, new RegExp(`Invalid ${section}: expected a mapping`));
    });
  }

  for (const field of ['id', 'name', 'version', 'description']) {
    test(`preset.${field} not a string`, () => {
      const data = validPackData();
      data.preset[field] = 2;
      expectInvalid(data, new RegExp(`Invalid preset\\.${field}: expected a string, got int`));
    });
  }

  test('unquoted float version reports float type (1.0 parses as JS int: known limitation)', () => {
    const p = join(tempDir, 'preset.yml');
    writeFileSync(
      p,
      [
        'schema_version: "1.0"',
        'preset:',
        '  id: x',
        '  name: X',
        '  version: 1.5',
        '  description: d',
        'requires:',
        '  speckit_version: ">=0.1.0"',
        'provides:',
        '  templates:',
        '    - {type: template, name: spec-template, file: t.md}',
        '',
      ].join('\n'),
    );
    expect(() => new PresetManifest(p)).toThrow('Invalid preset.version: expected a string, got float');
  });

  for (const field of ['type', 'name', 'file']) {
    test(`template ${field} not a string`, () => {
      const data = validPackData();
      data.provides.templates[0][field] = 5;
      expectInvalid(data, new RegExp(`Invalid template ${field}: expected a string`));
    });
  }

  test('non-list templates', () => {
    for (const bad of [5, 0, false, null, '', {}]) {
      const data = validPackData();
      data.provides.templates = bad;
      expectInvalid(data, /templates.*expected a list/);
    }
  });

  test('non-mapping template entry', () => {
    const data = validPackData();
    data.provides.templates = [null];
    expectInvalid(data, /must be a mapping/);
  });

  test('missing / wrong schema version', () => {
    const d1 = validPackData();
    delete d1.schema_version;
    expectInvalid(d1, /Missing required field: schema_version/);
    const d2 = validPackData();
    d2.schema_version = '2.0';
    expectInvalid(d2, /Unsupported schema version: 2\.0 \(expected 1\.0\)/);
  });

  test('missing pack id / invalid id / invalid version', () => {
    const d1 = validPackData();
    delete d1.preset.id;
    expectInvalid(d1, /Missing preset\.id/);
    const d2 = validPackData();
    d2.preset.id = 'Invalid_ID';
    expectInvalid(d2, /Invalid preset ID 'Invalid_ID'/);
    const d3 = validPackData();
    d3.preset.version = 'not-a-version';
    expectInvalid(d3, /Invalid version: not-a-version/);
  });

  test('missing / non-string speckit_version', () => {
    const d1 = validPackData();
    delete d1.requires.speckit_version;
    expectInvalid(d1, /Missing requires\.speckit_version/);
    for (const bad of [1.0, 1, true, null, ['>=0.1'], { a: 1 }, '  ']) {
      const d = validPackData();
      d.requires.speckit_version = bad;
      expectInvalid(d, /Invalid requires\.speckit_version/);
    }
  });

  test('no templates provided', () => {
    const d = validPackData();
    d.provides.templates = [];
    expectInvalid(d, /must provide at least one template/);
    const d2 = validPackData();
    d2.provides = {};
    expectInvalid(d2, /must provide at least one template/);
  });

  test('invalid template type', () => {
    const d = validPackData();
    d.provides.templates[0].type = 'invalid-type';
    expectInvalid(d, /Invalid template type 'invalid-type': must be one of \['command', 'script', 'template'\]/);
  });

  test('valid template types', () => {
    expect([...VALID_PRESET_TEMPLATE_TYPES].sort()).toEqual(['command', 'script', 'template']);
  });

  test('template missing required fields', () => {
    const d = validPackData();
    d.provides.templates = [{ type: 'template' }];
    expectInvalid(d, /missing 'type', 'name', or 'file'/);
  });

  test('invalid template name format', () => {
    const d = validPackData();
    d.provides.templates[0].name = 'Invalid Name';
    expectInvalid(d, /Invalid template name/);
    const d2 = validPackData();
    d2.provides.templates[0] = { type: 'command', name: 'speckit.Bad', file: 'c.md' };
    expectInvalid(d2, /Invalid command name/);
  });

  test('template file path traversal rejected', () => {
    for (const bad of ['../escape.md', '/abs/path.md', 'a/../../b.md']) {
      const d = validPackData();
      d.provides.templates[0].file = bad;
      expectInvalid(d, /must be a relative path within the preset directory/);
    }
  });

  test('get_hash', () => {
    const p = writeManifest(validPackData());
    const h = new PresetManifest(p).getHash();
    expect(h.startsWith('sha256:')).toBe(true);
    expect(h.length).toBe(7 + 64);
  });

  test('multiple templates', () => {
    const d = validPackData();
    d.provides.templates.push(
      { type: 'template', name: 'plan-template', file: 'templates/plan-template.md' },
      { type: 'command', name: 'speckit.specify', file: 'commands/speckit.specify.md' },
    );
    expect(new PresetManifest(writeManifest(d)).templates.length).toBe(3);
  });

  test('duplicate (name, type) rejected; same name different type allowed', () => {
    const d = validPackData();
    d.provides.templates.push({ type: 'template', name: 'spec-template', file: 'other.md' });
    expectInvalid(d, /Duplicate template name 'spec-template' of type 'template' in 'provides\.templates'/);

    const ok = validPackData();
    ok.provides.templates.push({ type: 'script', name: 'spec-template', file: 'scripts/x.sh' });
    expect(new PresetManifest(writeManifest(ok)).templates.length).toBe(2);
  });

  test('requires.extensions absent is valid', () => {
    expect(new PresetManifest(writeManifest(validPackData())).requiresExtensions).toEqual([]);
  });

  test('requires.extensions accepts both forms', () => {
    const d = validPackData();
    d.requires.extensions = ['speckit-inventory', { id: 'other-ext', version: '>=1.2.0', required: false }];
    expect(new PresetManifest(writeManifest(d)).requiresExtensions).toEqual([
      { id: 'speckit-inventory', version: null, required: true },
      { id: 'other-ext', version: '>=1.2.0', required: false },
    ]);
  });

  const malformed: Array<[unknown, RegExp]> = [
    ['speckit-inventory', /Invalid requires\.extensions/],
    [{ id: 'x' }, /Invalid requires\.extensions/],
    [[123], /Invalid requires\.extensions\[0\]/],
    [[null], /Invalid requires\.extensions\[0\]/],
    [[{ version: '>=1' }], /Missing requires\.extensions\[0\]\.id/],
    [[{ id: 5 }], /Invalid requires\.extensions\[0\]\.id/],
    [[{ id: 'Bad_ID' }], /Invalid requires\.extensions\[0\]\.id/],
    [['Bad_ID'], /Invalid requires\.extensions\[0\]\.id/],
    [[{ id: 'x', version: 1.5 }], /Invalid requires\.extensions\[0\]\.version/],
    [[{ id: 'x', version: '  ' }], /Invalid requires\.extensions\[0\]\.version/],
    [[{ id: 'x', version: 'nonsense' }], /Invalid requires\.extensions\[0\]\.version/],
    [[{ id: 'x', required: 'yes' }], /Invalid requires\.extensions\[0\]\.required/],
    [['demo-ext\n'], /Invalid requires\.extensions\[0\]\.id/],
    [[{ id: 'demo-ext\n' }], /Invalid requires\.extensions\[0\]\.id/],
    [['demo\next'], /Invalid requires\.extensions\[0\]\.id/],
  ];
  malformed.forEach(([bad, expected], i) => {
    test(`requires.extensions rejects malformed #${i}`, () => {
      const d = validPackData();
      d.requires.extensions = bad;
      expectInvalid(d, expected);
    });
  });

  test('extension id repr in error message', () => {
    const d = validPackData();
    d.requires.extensions = ['Bad_ID'];
    expectInvalid(d, /Invalid requires\.extensions\[0\]\.id 'Bad_ID': must be lowercase/);
  });
});

describe('composition strategy validation', () => {
  for (const strategy of ['replace', 'prepend', 'append', 'wrap']) {
    test(`valid ${strategy} strategy`, () => {
      const d = validPackData();
      d.provides.templates[0].strategy = strategy;
      expect(new PresetManifest(writeManifest(d)).templates[0].strategy).toBe(strategy);
    });
  }

  test('default strategy is replace (absent key)', () => {
    const m = new PresetManifest(writeManifest(validPackData()));
    expect(m.templates[0].strategy ?? 'replace').toBe('replace');
    expect('strategy' in m.templates[0]).toBe(false);
  });

  test('strategy normalized to lowercase', () => {
    const d = validPackData();
    d.provides.templates[0].strategy = 'WRAP';
    expect(new PresetManifest(writeManifest(d)).templates[0].strategy).toBe('wrap');
  });

  test('invalid strategy rejected', () => {
    const d = validPackData();
    d.provides.templates[0].strategy = 'merge';
    expectInvalid(d, /Invalid strategy 'merge': must be one of \['append', 'prepend', 'replace', 'wrap'\]/);
  });

  test('non-string strategy rejected', () => {
    const d = validPackData();
    d.provides.templates[0].strategy = null;
    expectInvalid(d, /Invalid strategy value: must be a string, got NoneType/);
  });

  for (const strategy of ['prepend', 'append']) {
    test(`${strategy} rejected for scripts`, () => {
      const d = validPackData();
      d.provides.templates = [{ type: 'script', name: 'create-new-feature', file: 'scripts/x.sh', strategy }];
      expectInvalid(d, /Invalid strategy.*for script: scripts only support \['replace', 'wrap'\]/);
    });
  }

  for (const strategy of ['wrap', 'replace']) {
    test(`${strategy} accepted for scripts`, () => {
      const d = validPackData();
      d.provides.templates = [{ type: 'script', name: 'create-new-feature', file: 'scripts/x.sh', strategy }];
      expect(new PresetManifest(writeManifest(d)).templates[0].strategy).toBe(strategy);
    });
  }

  test('strategy sets', () => {
    expect([...VALID_PRESET_STRATEGIES].sort()).toEqual(['append', 'prepend', 'replace', 'wrap']);
    expect([...VALID_SCRIPT_STRATEGIES].sort()).toEqual(['replace', 'wrap']);
  });
});

// ============================================================================
// PresetRegistry
// ============================================================================

describe('PresetRegistry', () => {
  let packsDir: string;
  beforeEach(() => {
    packsDir = join(tempDir, 'packs');
    mkdirSync(packsDir, { recursive: true });
  });

  test('empty registry', () => {
    const r = new PresetRegistry(packsDir);
    expect(r.list()).toEqual({});
    expect(r.keys().size).toBe(0);
  });

  test('starts fresh for non-utf8 registry', () => {
    writeFileSync(join(packsDir, '.registry'), Buffer.from([0xff, 0xfe, 0x7b]));
    const r = new PresetRegistry(packsDir);
    expect(r.list()).toEqual({});
  });

  test('add and get stamps installed_at', () => {
    const r = new PresetRegistry(packsDir);
    r.add('test-pack', { version: '1.0.0', source: 'local' });
    const m = r.get('test-pack')!;
    expect(m.version).toBe('1.0.0');
    expect(m.source).toBe('local');
    expect(typeof m.installed_at).toBe('string');
    expect(m.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
    expect(r.isInstalled('test-pack')).toBe(true);
  });

  test('remove / remove nonexistent', () => {
    const r = new PresetRegistry(packsDir);
    r.add('test-pack', { version: '1.0.0' });
    r.remove('test-pack');
    expect(r.isInstalled('test-pack')).toBe(false);
    r.remove('nonexistent');
  });

  test('persistence', () => {
    const r1 = new PresetRegistry(packsDir);
    r1.add('test-pack', { version: '1.0.0' });
    const r2 = new PresetRegistry(packsDir);
    expect(r2.isInstalled('test-pack')).toBe(true);
    const text = readFileSync(join(packsDir, '.registry'), 'utf-8');
    expect(JSON.parse(text).schema_version).toBe('1.0');
  });

  test('corrupted registry starts fresh', () => {
    writeFileSync(join(packsDir, '.registry'), 'not json{{{');
    expect(new PresetRegistry(packsDir).list()).toEqual({});
    writeFileSync(join(packsDir, '.registry'), '[1,2]');
    expect(new PresetRegistry(packsDir).list()).toEqual({});
    writeFileSync(join(packsDir, '.registry'), '{"presets": []}');
    expect(new PresetRegistry(packsDir).list()).toEqual({});
  });

  test('update preserves installed_at and merges', () => {
    const r = new PresetRegistry(packsDir);
    r.add('p', { version: '1.0.0', enabled: true });
    const installedAt = r.get('p')!.installed_at;
    r.update('p', { enabled: false, installed_at: 'bogus' });
    const m = r.get('p')!;
    expect(m.enabled).toBe(false);
    expect(m.version).toBe('1.0.0');
    expect(m.installed_at).toBe(installedAt);
  });

  test('update missing raises KeyError', () => {
    const r = new PresetRegistry(packsDir);
    expect(() => r.update('nope', { enabled: false })).toThrow("Preset 'nope' not found in registry");
  });

  test('restore', () => {
    const r = new PresetRegistry(packsDir);
    const meta = { version: '1.0.0', installed_at: '2025-01-01T00:00:00+00:00', nested: { a: [1] } };
    r.restore('p', meta);
    expect(r.get('p')).toEqual(meta);
    meta.nested.a.push(2);
    expect(r.get('p')!.nested.a).toEqual([1]);
    expect(() => r.restore('p', null)).toThrow("Cannot restore 'p': metadata must be a dict");
    expect(() => r.restore('p', 'x' as unknown as Record<string, unknown>)).toThrow(/metadata must be a dict/);
  });

  test('get/list return deep copies; corrupted entries filtered', () => {
    const r = new PresetRegistry(packsDir);
    r.add('p', { version: '1.0.0', registered_commands: { claude: ['a'] } });
    const got = r.get('p')!;
    got.registered_commands.claude.push('b');
    expect(r.get('p')!.registered_commands.claude).toEqual(['a']);
    r.data.presets.broken = 'corrupted';
    expect(r.get('broken')).toBeNull();
    expect(Object.keys(r.list())).toEqual(['p']);
    expect(r.keys().has('broken')).toBe(true);
    expect(r.isInstalled('broken')).toBe(true);
  });

  test('list_by_priority ordering, disabled filtering, invalid priorities', () => {
    const r = new PresetRegistry(packsDir);
    r.add('pack-b', { version: '1.0.0', priority: 5 });
    r.add('pack-a', { version: '1.0.0', priority: 5 });
    r.add('pack-c', { version: '1.0.0', priority: 1 });
    r.add('pack-d', { version: '1.0.0', priority: 'high' });
    r.add('pack-e', { version: '1.0.0', priority: true });
    r.add('pack-f', { version: '1.0.0', priority: 20, enabled: false });
    r.add('pack-legacy', { version: '1.0.0' });
    const ids = r.listByPriority().map(([id]) => id);
    expect(ids).toEqual(['pack-c', 'pack-a', 'pack-b', 'pack-d', 'pack-e', 'pack-legacy']);
    const withDisabled = r.listByPriority(true).map(([id]) => id);
    expect(withDisabled[withDisabled.length - 1]).toBe('pack-f');
    const d = r.listByPriority().find(([id]) => id === 'pack-d')!;
    expect(d[1].priority).toBe(10);
  });
});
