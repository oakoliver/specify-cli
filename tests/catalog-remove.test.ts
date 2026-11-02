/**
 * `extension catalog remove` / `preset catalog remove` (port of upstream
 * #4909 and #5033 in tests/specify_cli/extensions/catalog/test_command_remove.py
 * and #4992 in tests/specify_cli/presets/catalog/test_command_remove.py).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { console as richConsole, errConsole } from '../src/console.js';
import { runExtensionCommand } from '../src/extensions/commands.js';
import { runPresetCommand } from '../src/presets/commands.js';
import { dumpYaml, parseYaml } from '../src/yaml.js';
import { cleanupTempDirs, makeTempDir } from './extensions-helpers.js';

let out: string[] = [];
let origCwd: string;
const saved = { HOME: process.env.HOME, SPECKIT_CATALOG_URL: process.env.SPECKIT_CATALOG_URL };
let origStdout: typeof process.stdout.write;

beforeEach(() => {
  out = [];
  origCwd = process.cwd();
  richConsole.file = { write: (s: string) => out.push(s), isTTY: false, columns: 300 };
  errConsole.file = { write: (s: string) => out.push(s), isTTY: false, columns: 300 };
  origStdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  delete process.env.SPECKIT_CATALOG_URL;
});

afterEach(() => {
  process.chdir(origCwd);
  process.stdout.write = origStdout;
  richConsole.file = process.stdout;
  errConsole.file = process.stderr;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  cleanupTempDirs();
});

const output = (): string => out.join('').split(/\s+/).join(' ');

function project(): string {
  const p = join(makeTempDir(), 'project');
  mkdirSync(join(p, '.specify'), { recursive: true });
  process.chdir(p);
  return p;
}

describe('extension catalog remove: final entry', () => {
  test('restores the defaults and deletes the config', async () => {
    const p = project();
    process.env.HOME = makeTempDir();
    expect(await runExtensionCommand(['catalog', 'add', 'https://only.example.com/catalog.json', '--name', 'only'])).toBe(0);
    out = [];
    expect(await runExtensionCommand(['catalog', 'remove', 'only'])).toBe(0);
    expect(output()).toContain('Project catalog override removed; user configuration or built-in defaults will be used.');
    out = [];
    expect(await runExtensionCommand(['catalog', 'list'])).toBe(0);
    expect(output()).toContain('default (priority 1)');
    expect(output()).toContain('community (priority 2)');
    expect(existsSync(join(p, '.specify', 'extension-catalogs.yml'))).toBe(false);
  });

  // Upstream's user-config fallback case needs ``os.homedir()`` to follow HOME,
  // which Bun caches at startup, so it is not ported.

  test('notes SPECKIT_CATALOG_URL precedence', async () => {
    project();
    process.env.HOME = makeTempDir();
    process.env.SPECKIT_CATALOG_URL = 'https://env.example.com/catalog.json';
    expect(await runExtensionCommand(['catalog', 'add', 'https://only.example.com/catalog.json', '--name', 'only'])).toBe(0);
    out = [];
    expect(await runExtensionCommand(['catalog', 'remove', 'only'])).toBe(0);
    expect(output()).toContain(
      'Project catalog override removed; the SPECKIT_CATALOG_URL environment variable still takes precedence.',
    );
    expect(output()).not.toContain('built-in defaults will be used');
  });

  test('keeps the config with remaining entries', async () => {
    const p = project();
    const keep = { name: 'keep', url: 'https://keep.example.com/catalog.json', priority: 20, install_allowed: false, description: '' };
    const cfg = join(p, '.specify', 'extension-catalogs.yml');
    writeFileSync(
      cfg,
      dumpYaml(
        { catalogs: [{ name: 'drop', url: 'https://drop.example.com/catalog.json', priority: 10, install_allowed: false, description: '' }, keep] },
        { sortKeys: false },
      ),
    );
    expect(await runExtensionCommand(['catalog', 'remove', 'drop'])).toBe(0);
    expect(output()).not.toContain('Project catalog override removed');
    expect(parseYaml(readFileSync(cfg, 'utf-8'))).toEqual({ catalogs: [keep] });
  });
});

const INVALID: Array<[unknown, string]> = [
  ['unfinished-entry', 'str'],
  [0, 'int'],
  [false, 'bool'],
  [null, 'NoneType'],
  [[], 'list'],
];

for (const kind of ['extension', 'preset'] as const) {
  describe(`${kind} catalog remove rejects malformed entries before writing`, () => {
    for (const [invalidEntry, typeName] of INVALID) {
      for (const invalidIndex of [0, 1]) {
        for (const target of ['keep', 'does-not-exist']) {
          test(`${typeName} at ${invalidIndex}, removing ${target}`, async () => {
            const p = project();
            const file = kind === 'extension' ? 'extension-catalogs.yml' : 'preset-catalogs.yml';
            const cfg = join(p, '.specify', file);
            const entries: unknown[] = [{ name: 'keep', url: 'https://example.com/team.json' }];
            entries.splice(invalidIndex, 0, invalidEntry);
            const original = Buffer.from(
              ('# Local settings: café\n' + dumpYaml({ catalogs: entries, metadata: 'keep me' })).replace(/\n/g, '\r\n'),
              'utf-8',
            );
            writeFileSync(cfg, original);
            const run = kind === 'extension' ? runExtensionCommand : runPresetCommand;
            expect(await run(['catalog', 'remove', target])).toBe(1);
            expect(readFileSync(cfg).equals(original)).toBe(true);
            expect(output()).toContain(`Invalid catalog entry at index ${invalidIndex}`);
            expect(output()).toContain(`expected a mapping, got ${typeName}`);
            expect(output()).not.toContain('Removed catalog');
          });
        }
      }
    }
  });
}
