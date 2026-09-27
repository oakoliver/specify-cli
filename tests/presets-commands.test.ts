/**
 * Tests for the ``specify preset`` CLI (src/presets/commands.ts and
 * src/presets/catalog/commands.ts). Ports key cases of upstream
 * tests/specify_cli/presets/test_command_*.py and catalog/test_command_*.py.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { dumpYaml, parseYaml } from '../src/yaml.js';
import {
  commandSafeId,
  presetCommandHooks,
  renderPowershellArgv,
  runPresetCommand,
  shlexJoin,
  warnUnmetExtensionDependencies,
} from '../src/presets/commands.js';
import { PresetCatalog } from '../src/presets/catalog.js';
import { PresetManager } from '../src/presets/manager.js';
import { setPresetWarningHandler, type PresetManifest } from '../src/presets/manifest.js';

let tempDir: string;
let projectDir: string;
let origCwd: string;
let out: string[];
let err: string[];
let origOut: typeof process.stdout.write;
let origErr: typeof process.stderr.write;
let savedEnv: Record<string, string | undefined>;

function write(p: string, content: string | Buffer): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'presets-cli-'));
  projectDir = join(tempDir, 'project');
  write(join(projectDir, '.specify', 'templates', 'spec-template.md'), '# Core Spec Template\n');
  mkdirSync(join(projectDir, '.specify', 'templates', 'commands'), { recursive: true });
  origCwd = process.cwd();
  process.chdir(projectDir);
  savedEnv = {
    COLUMNS: process.env.COLUMNS,
    SPECIFY_INIT_DIR: process.env.SPECIFY_INIT_DIR,
    SPECKIT_PRESET_CATALOG_URL: process.env.SPECKIT_PRESET_CATALOG_URL,
    HOME: process.env.HOME,
  };
  process.env.COLUMNS = '400';
  delete process.env.SPECIFY_INIT_DIR;
  delete process.env.SPECKIT_PRESET_CATALOG_URL;
  process.env.HOME = join(tempDir, 'home');
  out = [];
  err = [];
  origOut = process.stdout.write.bind(process.stdout);
  origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  setPresetWarningHandler(() => undefined);
});

afterEach(() => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  setPresetWarningHandler(null);
  process.chdir(origCwd);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

const stdout = () => out.join('');
const stderr = () => err.join('');
const flat = (s: string) => s.split(/\s+/).join(' ');

function makePack(id: string, opts: { name?: string; description?: string; tags?: unknown; templateDescription?: string } = {}): string {
  const dir = join(tempDir, `src-${id}`);
  write(
    join(dir, 'preset.yml'),
    dumpYaml({
      schema_version: '1.0',
      preset: {
        id,
        name: opts.name ?? id,
        version: '1.0.0',
        description: opts.description ?? 'plain description',
      },
      requires: { speckit_version: '>=0.0.1' },
      provides: {
        templates: [
          {
            type: 'template',
            name: 'spec-template',
            file: 'templates/spec-template.md',
            ...(opts.templateDescription ? { description: opts.templateDescription } : {}),
          },
        ],
      },
      ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
    }),
  );
  write(join(dir, 'templates', 'spec-template.md'), `# ${id} template\n`);
  return dir;
}

function install(id: string, priority = 10, opts: Parameters<typeof makePack>[1] = {}): void {
  new PresetManager(projectDir).installFromDirectory(makePack(id, opts), '9.9.9', priority);
}

// ============================================================================

describe('preset list', () => {
  test('empty', async () => {
    expect(await runPresetCommand(['list'])).toBe(0);
    expect(stdout()).toContain('No presets installed.');
    expect(stdout()).toContain('specify preset add <pack-name>');
  });

  test('sorted by priority and ties by id', async () => {
    install('copilot-sub-agents', 100);
    install('zebra', 10);
    install('alpha', 10);
    expect(await runPresetCommand(['list'])).toBe(0);
    const o = stdout();
    expect(o.indexOf('(alpha)')).toBeLessThan(o.indexOf('(zebra)'));
    expect(o.indexOf('(zebra)')).toBeLessThan(o.indexOf('(copilot-sub-agents)'));
    expect(o).toContain('Installed Presets (in resolution order — highest precedence first)');
    expect(o).toContain('Ties are broken by preset id');
    expect(o).toContain('alpha (alpha) v1.0.0 — enabled — priority 10');
    expect(o).toContain('Templates: 1');
  });

  test('--json output contract', async () => {
    install('beta', 5);
    install('alpha', 5);
    expect(await runPresetCommand(['list', '--json'])).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.map((p: { id: string }) => p.id)).toEqual(['alpha', 'beta']);
    expect(parsed[0]).toEqual({
      id: 'alpha',
      name: 'alpha',
      description: 'plain description',
      version: '1.0.0',
      author: null,
      priority: 5,
      enabled: true,
      source: { kind: 'local' },
      provides: { commands: 0, templates: 1, scripts: 0 },
    });
  });

  test('--json error contract outside a project and on parse errors', async () => {
    process.chdir(tempDir);
    expect(await runPresetCommand(['list', '--json'])).toBe(1);
    expect(JSON.parse(stderr().trim())).toEqual({ error: 'Not a Spec Kit project (no .specify/ directory)' });
    err.length = 0;
    expect(await runPresetCommand(['list', '--json', '--bogus'])).toBe(2);
    expect(JSON.parse(stderr().trim()).error).toContain('--bogus');
  });

  test('escapes installed markup', async () => {
    install('markup-pack', 10, { name: '[red]Evil[/red]', description: 'desc [bold]x[/bold]', tags: ['[t]'] });
    expect(await runPresetCommand(['list'])).toBe(0);
    expect(stdout()).toContain('[red]Evil[/red]');
    expect(stdout()).toContain('desc [bold]x[/bold]');
  });
});

describe('preset add / remove / update', () => {
  test('add --dev and remove', async () => {
    const dir = makePack('dev-pack');
    expect(await runPresetCommand(['add', '--dev', dir, '--priority', '3'])).toBe(0);
    expect(flat(stdout())).toContain("✓ Preset 'dev-pack' v1.0.0 installed (priority 3)");
    expect(new PresetManager(projectDir).registry.get('dev-pack')!.priority).toBe(3);
    out.length = 0;
    expect(await runPresetCommand(['remove', 'dev-pack'])).toBe(0);
    expect(stdout()).toContain("✓ Preset 'dev-pack' removed successfully");
    expect(await runPresetCommand(['remove', 'dev-pack'])).toBe(1);
    expect(stdout()).toContain("Error: Preset 'dev-pack' is not installed");
  });

  test('add without source / missing dir / bad priority', async () => {
    expect(await runPresetCommand(['add'])).toBe(1);
    expect(stdout()).toContain('Error: Specify a preset ID, --from URL, or --dev path');
    expect(await runPresetCommand(['add', '--dev', join(tempDir, 'nope')])).toBe(1);
    expect(stdout()).toContain('Error: Directory not found:');
    expect(await runPresetCommand(['add', 'x', '--priority', '0'])).toBe(1);
    expect(stdout()).toContain('Error: Priority must be a positive integer (1 or higher)');
  });

  test('add bundled preset', async () => {
    expect(await runPresetCommand(['add', 'lean'])).toBe(0);
    expect(stdout()).toContain('Installing bundled preset lean...');
    expect(new PresetManager(projectDir).registry.isInstalled('lean')).toBe(true);
  });

  test('add --from URL validation', async () => {
    expect(await runPresetCommand(['add', '--from', 'http://example.com/p.zip'])).toBe(1);
    expect(flat(stdout())).toContain('Error: URL must use HTTPS with a hostname');
    out.length = 0;
    expect(await runPresetCommand(['add', '--from', 'https://example.com:99999/p.zip'])).toBe(1);
    expect(stdout()).toContain('Error: Invalid URL: https://example.com:99999/p.zip');
    out.length = 0;
    expect(await runPresetCommand(['add', '--from', 'https://[::1'])).toBe(1);
    expect(stdout()).toContain('Error: Invalid URL:');
    out.length = 0;
    expect(await runPresetCommand(['add', '--from', 'https://:8080/p.zip'])).toBe(1);
    expect(flat(stdout())).toContain('URL must use HTTPS with a hostname');
  });

  test('add from catalog: not found / discovery-only / validation errors are escaped', async () => {
    const origGet = PresetCatalog.prototype.getPackInfo;
    try {
      PresetCatalog.prototype.getPackInfo = async () => null;
      expect(await runPresetCommand(['add', 'unknown-pack'])).toBe(1);
      expect(stdout()).toContain("Error: Preset 'unknown-pack' not found in catalog");

      out.length = 0;
      PresetCatalog.prototype.getPackInfo = async () => ({
        id: 'community-pack',
        _install_allowed: false,
        _catalog_name: 'community',
      });
      expect(await runPresetCommand(['add', 'community-pack'])).toBe(1);
      expect(stdout()).toContain(
        "Error: Preset 'community-pack' is from the 'community' catalog which is discovery-only (install not allowed).",
      );
      expect(stdout()).toContain('Add the catalog with --install-allowed');

      out.length = 0;
      PresetCatalog.prototype.getPackInfo = async () => ({ id: 'b', bundled: true });
      expect(await runPresetCommand(['add', 'b-pack'])).toBe(1);
      expect(stdout()).toContain('is bundled with spec-kit but could not be found in the installed package.');
    } finally {
      PresetCatalog.prototype.getPackInfo = origGet;
    }
  });

  test('add surfaces dependency warnings', async () => {
    const dir = makePack('dep-pack');
    const manifestPath = join(dir, 'preset.yml');
    const data = parseYaml(readFileSync(manifestPath, 'utf-8')) as Record<string, any>;
    data.requires.extensions = ['speckit-inventory'];
    writeFileSync(manifestPath, dumpYaml(data));
    expect(await runPresetCommand(['add', '--dev', dir])).toBe(0);
    const o = flat(stdout());
    expect(o).toContain('This preset depends on extensions that are not satisfied:');
    expect(o).toContain('speckit-inventory is not installed');
    expect(o).toContain('Install with: specify extension add speckit-inventory');
    expect(o).toContain('The preset is installed.');
    expect(o).toContain('--from <archive-url>');
  });

  test('update: unknown preset, exclusive sources, empty sources', async () => {
    const calls: string[] = [];
    const origAdd = presetCommandHooks.presetAdd;
    const origRemove = presetCommandHooks.presetRemove;
    presetCommandHooks.presetAdd = async () => {
      calls.push('add');
    };
    presetCommandHooks.presetRemove = () => {
      calls.push('remove');
    };
    try {
      expect(await runPresetCommand(['update', 'missing'])).toBe(1);
      expect(stdout()).toContain("Error: Preset 'missing' is not installed");
      expect(await runPresetCommand(['update', 'x', '--from', 'https://e.com/p.zip', '--dev', './p'])).toBe(1);
      expect(stdout()).toContain('Error: --from and --dev are mutually exclusive');
      expect(await runPresetCommand(['update', 'x', '--from', ''])).toBe(1);
      expect(stdout()).toContain('--from must not be empty');
      expect(await runPresetCommand(['update', 'x', '--dev', ''])).toBe(1);
      expect(stdout()).toContain('--dev must not be empty');
      expect(calls).toEqual([]);

      install('up-pack');
      expect(await runPresetCommand(['update', 'up-pack', '--dev', './somewhere', '--priority', '4'])).toBe(0);
      expect(calls).toEqual(['remove', 'add']);
    } finally {
      presetCommandHooks.presetAdd = origAdd;
      presetCommandHooks.presetRemove = origRemove;
    }
  });

  test('update: add failure prints retry command', async () => {
    install('up-pack');
    const origAdd = presetCommandHooks.presetAdd;
    presetCommandHooks.presetAdd = async () => {
      throw new Error("boom [red]x[/red]");
    };
    try {
      expect(await runPresetCommand(['update', 'up-pack', '--from', "https://e.com/it's.zip"])).toBe(1);
      const o = stdout();
      expect(o).toContain('Error: boom [red]x[/red]');
      expect(o).toContain('Error: Preset update failed; the previous preset was removed.');
      expect(o).toContain(
        `Retry with: specify preset add up-pack --from 'https://e.com/it'"'"'s.zip' --priority 10`,
      );
      expect(new PresetManager(projectDir).registry.isInstalled('up-pack')).toBe(false);
    } finally {
      presetCommandHooks.presetAdd = origAdd;
    }
  });

  test('retry rendering helpers', () => {
    expect(shlexJoin(['specify', 'preset', 'add', '--', '-weird id'])).toBe("specify preset add -- '-weird id'");
    expect(renderPowershellArgv(['specify', "it's"])).toBe("& 'specify' 'it''s'");
    expect(commandSafeId('--force')).toBe('<extension-id>');
    expect(commandSafeId('foo; rm -rf ~')).toBe('<extension-id>');
    expect(commandSafeId('good-id')).toBe('good-id');
  });
});

describe('dependency warning rendering', () => {
  function render(unmet: Array<Record<string, unknown>>): string {
    const manager = { findUnmetExtensionDependencies: () => unmet } as unknown as PresetManager;
    warnUnmetExtensionDependencies(manager, {} as PresetManifest);
    return flat(stdout());
  }

  test('version warning does not promise update', () => {
    const o = render([{ id: 'speckit-inventory', reason: 'version', installed: '3.0.0', version: '<2' }]);
    expect(o).toContain('speckit-inventory 3.0.0 does not satisfy <2');
    expect(o).toContain('Needs: a release of speckit-inventory satisfying <2');
    expect(o).not.toContain('specify extension update');
    expect(o).not.toContain('discovery-only');
    expect(o).toContain('Where only a version constraint is unmet');
    expect(o).not.toContain('Anything relying on an unavailable extension');
  });

  test('corrupt/stale suggest forced reinstall; disabled suggests enable', () => {
    let o = render([{ id: 'ext-a', reason: 'corrupt', installed: null, version: null }]);
    expect(o).toContain('ext-a has an unreadable registry entry');
    expect(o).toContain('Reinstall with: specify extension add ext-a --force');
    out.length = 0;
    o = render([{ id: 'ext-b', reason: 'stale', installed: '1.0.0', version: null }]);
    expect(o).toContain('ext-b is registered but its files are missing');
    out.length = 0;
    o = render([{ id: 'ext-c', reason: 'disabled', installed: '1.0.0', version: null }]);
    expect(o).toContain('Enable with: specify extension enable ext-c');
    expect(o).toContain('Anything relying on an unavailable extension does nothing until that is resolved.');
  });

  for (const reason of ['missing', 'stale', 'disabled', 'version']) {
    test(`leading hyphen id not emitted into command (${reason})`, () => {
      const o = render([{ id: '--not-a-real-flag', reason, installed: '0.1.0', version: '>=9.0.0' }]);
      const label = ['Install with:', 'Reinstall with:', 'Enable with:', 'Needs:'].find((l) => o.includes(l))!;
      const remedy = o.split(label)[1].split('The preset is installed.')[0];
      expect(remedy).not.toContain('--not-a-real-flag');
      expect(remedy).toContain('<extension-id>');
    });
  }
});

describe('preset resolve', () => {
  test('rejects invalid names', async () => {
    for (const bad of ['no[/red]such', '../../../README', 'speckit..constitution']) {
      err.length = 0;
      expect(await runPresetCommand(['resolve', bad])).toBe(1);
      expect(stderr()).toContain('invalid template name');
    }
  });

  test('dotted command name resolves via bundled core', async () => {
    expect(await runPresetCommand(['resolve', 'speckit.constitution'])).toBe(0);
    expect(stdout().replace(/\s+/g, '')).toContain('constitution.md');
    expect(stdout()).toContain('(top layer from: core (bundled))');
  });

  test('composition chain labels are rendered', async () => {
    install('base-pack', 20);
    const dir = makePack('app-pack');
    const manifestPath = join(dir, 'preset.yml');
    const data = parseYaml(readFileSync(manifestPath, 'utf-8')) as Record<string, any>;
    data.provides.templates[0].strategy = 'append';
    writeFileSync(manifestPath, dumpYaml(data));
    new PresetManager(projectDir).installFromDirectory(dir, '9.9.9', 5);
    expect(await runPresetCommand(['resolve', 'spec-template'])).toBe(0);
    const o = stdout();
    expect(o).toContain('Composition chain');
    expect(o).toContain('1. [base] base-pack v1.0.0');
    expect(o).toContain('2. [append] app-pack v1.0.0');
    expect(o).toContain('Final output is composed from multiple preset layers');
  });

  test('not found', async () => {
    expect(await runPresetCommand(['resolve', 'nothing-here'])).toBe(0);
    expect(stdout()).toContain('nothing-here: not found');
  });
});

describe('preset info / search', () => {
  function seedCatalog(pack: Record<string, unknown>): void {
    write(
      join(projectDir, '.specify', 'preset-catalogs.yml'),
      `catalogs:\n  - name: default\n    url: ${PresetCatalog.DEFAULT_CATALOG_URL}\n    install_allowed: true\n`,
    );
    const catalog = new PresetCatalog(projectDir);
    write(catalog.cacheFile, JSON.stringify({ schema_version: '1.0', presets: { 'numeric-tags': pack } }));
    write(catalog.cacheMetadataFile, JSON.stringify({ cached_at: new Date().toISOString() }));
  }

  test('info for installed preset', async () => {
    install('info-pack', 7, { templateDescription: 'Custom [spec]' });
    expect(await runPresetCommand(['info', 'info-pack'])).toBe(0);
    const o = stdout();
    expect(o).toContain('Preset: info-pack');
    expect(o).toContain('ID:          info-pack');
    expect(o).toContain('Templates:   1');
    expect(o).toContain('- spec-template (template): Custom [spec]');
    expect(o).toContain('Status: installed');
    expect(o).toContain('Priority: 7');
  });

  test('info from catalog renders non-string tags and escapes markup', async () => {
    seedCatalog({ name: '[red]Numeric[/red]', description: 'd', version: '1.0.0', tags: [1, 2.5, true] });
    expect(await runPresetCommand(['info', 'numeric-tags'])).toBe(0);
    const o = stdout();
    expect(o).toContain('Preset: [red]Numeric[/red]');
    expect(o).toContain('Tags:        1, 2.5, True');
    expect(o).toContain('Status: not installed');
    expect(o).toContain('Install with: specify preset add numeric-tags');
  });

  test('info not found', async () => {
    seedCatalog({ name: 'x' });
    expect(await runPresetCommand(['info', 'nope'])).toBe(1);
    expect(stdout()).toContain("Error: Preset 'nope' not found (not installed and not in catalog)");
  });

  test('search renders results and tolerates non-list tags', async () => {
    seedCatalog({ name: 'Numeric Tags', description: 'Preset with non-string tags', version: '1.0.0', tags: 'oops' });
    expect(await runPresetCommand(['search'])).toBe(0);
    const o = stdout();
    expect(o).toContain('Presets (1 found):');
    expect(o).toContain('Numeric Tags (numeric-tags) v1.0.0');
    expect(o).not.toContain('Tags:');
    out.length = 0;
    expect(await runPresetCommand(['search', 'zzz-no-match'])).toBe(0);
    expect(stdout()).toContain('No presets found matching your criteria.');
  });
});

describe('set-priority / enable / disable', () => {
  test('set-priority changes, same value no-op, repairs corrupted bool, invalid value', async () => {
    install('p1');
    expect(await runPresetCommand(['set-priority', 'p1', '5'])).toBe(0);
    expect(stdout()).toContain("✓ Preset 'p1' priority changed: 10 → 5");
    expect(new PresetManager(projectDir).registry.get('p1')!.priority).toBe(5);

    out.length = 0;
    expect(await runPresetCommand(['set-priority', 'p1', '5'])).toBe(0);
    expect(stdout()).toContain("Preset 'p1' already has priority 5");

    new PresetManager(projectDir).registry.update('p1', { priority: true });
    out.length = 0;
    expect(await runPresetCommand(['set-priority', 'p1', '1'])).toBe(0);
    expect(stdout()).toContain('priority changed: 10 → 1');

    out.length = 0;
    expect(await runPresetCommand(['set-priority', 'p1', '0'])).toBe(1);
    expect(stdout()).toContain('Priority must be a positive integer (1 or higher)');
    expect(await runPresetCommand(['set-priority', 'nope', '3'])).toBe(1);
    expect(stdout()).toContain("Error: Preset 'nope' is not installed");
  });

  test('enable / disable', async () => {
    install('p2');
    expect(await runPresetCommand(['enable', 'p2'])).toBe(0);
    expect(stdout()).toContain("Preset 'p2' is already enabled");
    out.length = 0;
    expect(await runPresetCommand(['disable', 'p2'])).toBe(0);
    expect(stdout()).toContain("✓ Preset 'p2' disabled");
    expect(stdout()).toContain('To re-enable: specify preset enable p2');
    expect(new PresetManager(projectDir).registry.get('p2')!.enabled).toBe(false);
    out.length = 0;
    expect(await runPresetCommand(['disable', 'p2'])).toBe(0);
    expect(stdout()).toContain("Preset 'p2' is already disabled");
    out.length = 0;
    expect(await runPresetCommand(['enable', 'p2'])).toBe(0);
    expect(stdout()).toContain("✓ Preset 'p2' enabled");
    expect(await runPresetCommand(['enable', 'ghost'])).toBe(1);
  });

  test('corrupted registry entry', async () => {
    install('p3');
    const m = new PresetManager(projectDir);
    m.registry.data.presets.p3 = 'garbage';
    (m.registry as unknown as { save: () => void }).save();
    expect(await runPresetCommand(['enable', 'p3'])).toBe(1);
    expect(stdout()).toContain("Error: Preset 'p3' not found in registry (corrupted state)");
  });
});

describe('preset catalog', () => {
  test('list default stack', async () => {
    expect(await runPresetCommand(['catalog', 'list'])).toBe(0);
    const o = stdout();
    expect(o).toContain('Active Preset Catalogs:');
    expect(o).toContain('default (priority 1)');
    expect(o).toContain('community (priority 2)');
    expect(o).toContain('Install: discovery only');
    expect(o).toContain('Using built-in default catalog stack.');
  });

  test('add is idempotent, rejects duplicates, escapes markup; remove', async () => {
    const args = ['catalog', 'add', 'https://example.com/c.json', '--name', '[b]mine[/b]', '--install-allowed'];
    expect(await runPresetCommand(args)).toBe(0);
    let o = stdout();
    expect(o).toContain("✓ Added catalog '[b]mine[/b]' (install allowed)");
    expect(o).toContain('URL: https://example.com/c.json');
    expect(o).toContain('Config saved to .specify/preset-catalogs.yml');
    const config = parseYaml(readFileSync(join(projectDir, '.specify', 'preset-catalogs.yml'), 'utf-8')) as any;
    expect(config.catalogs[0]).toEqual({
      name: '[b]mine[/b]',
      url: 'https://example.com/c.json',
      priority: 10,
      install_allowed: true,
      description: '',
    });

    out.length = 0;
    expect(await runPresetCommand(args)).toBe(0);
    expect(stdout()).toBe('');

    expect(await runPresetCommand(['catalog', 'add', 'https://other.example.com/c.json', '--name', '[b]mine[/b]'])).toBe(1);
    expect(stdout()).toContain("Warning: A catalog named '[b]mine[/b]' already exists.");

    out.length = 0;
    expect(await runPresetCommand(['catalog', 'list'])).toBe(0);
    expect(stdout()).toContain('Config: .specify/preset-catalogs.yml');

    out.length = 0;
    expect(await runPresetCommand(['catalog', 'remove', '[b]mine[/b]'])).toBe(0);
    expect(stdout()).toContain("✓ Removed catalog '[b]mine[/b]'");
    expect(stdout()).toContain('No catalogs remain in config. Built-in defaults will be used.');
    expect(await runPresetCommand(['catalog', 'remove', '[x]'])).toBe(1);
    expect(stdout()).toContain("Error: Catalog '[x]' not found.");
  });

  test('add rejects insecure URL and non-mapping config roots', async () => {
    expect(await runPresetCommand(['catalog', 'add', 'http://example.com/c.json', '--name', 'x'])).toBe(1);
    expect(stdout()).toContain('Catalog URL must use HTTPS');
    for (const body of ['- a\n', 'catalogs: nope\n']) {
      write(join(projectDir, '.specify', 'preset-catalogs.yml'), body);
      out.length = 0;
      expect(await runPresetCommand(['catalog', 'add', 'https://example.com/c.json', '--name', 'x'])).toBe(1);
      out.length = 0;
      expect(await runPresetCommand(['catalog', 'remove', 'x'])).toBe(1);
      expect(stdout()).toMatch(/Invalid catalog config: (expected a mapping\.|'catalogs' must be a list\.)/);
    }
  });

  test('remove without config', async () => {
    expect(await runPresetCommand(['catalog', 'remove', 'x'])).toBe(1);
    expect(stdout()).toContain('Error: No preset catalog config found. Nothing to remove.');
  });

  test('add requires --name', async () => {
    expect(await runPresetCommand(['catalog', 'add', 'https://example.com/c.json'])).toBe(2);
    expect(existsSync(join(projectDir, '.specify', 'preset-catalogs.yml'))).toBe(false);
  });
});

describe('outside a project', () => {
  test('commands require a project', async () => {
    process.chdir(tempDir);
    expect(await runPresetCommand(['list'])).toBe(1);
    expect(stderr()).toContain('Error: Not a Spec Kit project (no .specify/ directory)');
  });
});
