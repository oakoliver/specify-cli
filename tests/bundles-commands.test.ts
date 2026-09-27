/**
 * `specify bundle ...` command surface. Ports of
 * tests/specify_cli/bundles/test_command_*.py, test_commands.py and catalog/*.
 * Primitive installs, init and manifest downloads go through `commandDeps` /
 * `primitiveDeps` fakes; no network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { dumpYaml } from '../src/yaml.js';
import { commandDeps, runBundleCommand } from '../src/bundles/commands.js';
import { BundleManifest } from '../src/bundles/manifest.js';
import { loadRecords } from '../src/bundles/records.js';
import { adapterDeps } from '../src/bundles/adapters.js';
import { localManifestSource } from '../src/bundles/sources.js';
import { buildBundle } from '../src/bundles/packager.js';
import { FakeInstaller, catalogEntryDict, validManifestDict, writeCatalogFile, writeManifest } from './bundles-helpers.js';

let tmp: string;
let project: string;
let cwd: string;
const savedCommand = { ...commandDeps };
const savedAdapter = { ...adapterDeps };
const savedEnv = { NO_COLOR: process.env.NO_COLOR, SPECIFY_INIT_DIR: process.env.SPECIFY_INIT_DIR, COLUMNS: process.env.COLUMNS };
let installer: FakeInstaller;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'bundles-cmd-')));
  project = path.join(tmp, 'proj');
  mkdirSync(path.join(project, '.specify'), { recursive: true });
  cwd = process.cwd();
  process.chdir(project);
  process.env.NO_COLOR = '1';
  process.env.COLUMNS = '400';
  delete process.env.SPECIFY_INIT_DIR;
  installer = new FakeInstaller();
  commandDeps.userConfigDir = () => path.join(tmp, 'home', '.specify');
  commandDeps.speckitVersion = async () => '1.0.12';
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
  rmSync(tmp, { recursive: true, force: true });
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

function configureCatalog(entries: Record<string, unknown>, policy = 'install-allowed', id = 'c'): string {
  const catalog = path.join(project, `${id}.json`);
  writeCatalogFile(catalog, entries);
  writeFileSync(
    path.join(project, '.specify', 'bundle-catalogs.yml'),
    dumpYaml({ schema_version: '1.0', catalogs: [{ id, url: catalog, priority: 1, install_policy: policy }] }),
  );
  return catalog;
}

function flat(text: string): string {
  return text.split(/\s+/).join(' ');
}

// ============================================================================
// Group / help / errors
// ============================================================================

describe('bundle group', () => {
  test('help lists all commands', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(0);
    for (const cmd of ['search', 'info', 'list', 'install', 'add', 'update', 'remove', 'validate', 'build', 'init', 'catalog']) {
      expect(out).toContain(cmd);
    }
  });

  test('errors go to stderr, escaped', async () => {
    const cases: Array<[string[], string]> = [
      [['catalog', 'add', 'ssh://ex[/red]ample.com/c.json'], 'ssh://ex[/red]ample.com/c.json'],
      [['catalog', 'remove', 'no[/red]such'], 'no[/red]such'],
      [['update', 'no[/red]such'], 'no[/red]such'],
      [['remove', 'no[/red]such'], 'no[/red]such'],
    ];
    for (const [argv, expected] of cases) {
      const { code, out, err } = await run(argv);
      expect(code).toBe(1);
      expect(err).toContain('Error:');
      expect(err).toContain(expected);
      expect(out).not.toContain(expected);
    }
  });
});

// ============================================================================
// list / catalog
// ============================================================================

describe('list and catalog', () => {
  test('list empty project', async () => {
    const { code, out } = await run(['list']);
    expect(code).toBe(0);
    expect(out).toContain('No bundles installed.');
    expect(out).toContain('specify bundle install <id>');
  });

  test('commands outside a project fail with guidance', async () => {
    const bare = path.join(tmp, 'bare');
    mkdirSync(bare);
    process.chdir(bare);
    const { code, err } = await run(['list']);
    expect(code).toBe(1);
    expect(flat(err)).toContain("Not a Spec Kit project (no .specify/ directory). Run 'specify bundle init' or 'specify init' first.");
  });

  test('list shows records (json and text, markup escaped)', async () => {
    writeFileSync(
      path.join(project, '.specify', 'bundle-records.json'),
      JSON.stringify({
        schema_version: '1.0',
        bundles: [{ bundle_id: '[red]b[/red]', version: '1.0.0', installed_at: '2026-01-01T00:00:00Z', contributed_components: [] }],
      }),
    );
    const text = await run(['list']);
    expect(text.out).toContain('[red]b[/red] v1.0.0 (0 components, installed 2026-01-01T00:00:00Z)');
    const json = await run(['list', '--json']);
    expect(JSON.parse(json.out)).toEqual([
      { bundle_id: '[red]b[/red]', version: '1.0.0', installed_at: '2026-01-01T00:00:00Z', contributed_components: [] },
    ]);
  });

  test('catalog list shows built-in defaults', async () => {
    const { code, out } = await run(['catalog', 'list']);
    expect(code).toBe(0);
    expect(out).toContain('Catalog stack (highest precedence first):');
    expect(out).toContain('default  priority=1  policy=install-allowed  scope=built-in');
    expect(out).toContain('community  priority=20  policy=discovery-only  scope=built-in');
    expect(out).toContain('Using the built-in default stack.');
  });

  test('catalog add / idempotent add / remove; builtin removal refused', async () => {
    let r = await run(['catalog', 'add', 'https://example.com/team.json', '--priority', '5']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Added catalog 'example-com-team' (priority 5, install-allowed).");
    r = await run(['catalog', 'add', 'https://example.com/team.json', '--priority', '5']);
    expect(r.out).toContain("Catalog 'example-com-team' already configured (priority 5, install-allowed).");
    r = await run(['catalog', 'list']);
    expect(r.out).toContain('scope=project');
    expect(r.out).not.toContain('Using the built-in default stack.');
    r = await run(['catalog', 'remove', 'example-com-team']);
    expect(r.out).toContain("Removed catalog source 'example-com-team'.");
    r = await run(['catalog', 'remove', 'default']);
    expect(r.code).toBe(1);
    expect(flat(r.err)).toContain("'default' is a built-in default source and cannot be deleted");
  });
});

// ============================================================================
// search / info
// ============================================================================

describe('search and info', () => {
  test('search works without a project (packaged snapshot offline)', async () => {
    const bare = path.join(tmp, 'bare');
    mkdirSync(bare);
    process.chdir(bare);
    const { code, out } = await run(['search', '--offline', '--json']);
    expect(code).toBe(0);
    expect(out.trim().startsWith('[')).toBe(true);
    const ids = (JSON.parse(out) as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain('bugfix');
  });

  test('search json exposes trust', async () => {
    configureCatalog({ demo: catalogEntryDict('demo') });
    const { code, out } = await run(['search', '--offline', '--json']);
    expect(code).toBe(0);
    const demo = (JSON.parse(out) as Array<Record<string, unknown>>).find((e) => e.id === 'demo')!;
    expect(demo).toEqual({
      id: 'demo',
      name: 'Demo Bundle',
      role: 'developer',
      version: '1.2.0',
      description: 'A demo bundle.',
      source: 'c',
      install_policy: 'install-allowed',
      verified: true,
      trust: 'verified',
    });
  });

  test('search text shows trust badges and escapes markup', async () => {
    configureCatalog({
      'verified-one': catalogEntryDict('verified-one', { verified: true }),
      'community-one': catalogEntryDict('community-one', { verified: false, name: '[green]Markup Name[/green]' }),
    });
    const { code, out } = await run(['search', '--offline']);
    expect(code).toBe(0);
    expect(out).toContain('✔ verified');
    expect(out).toContain('community');
    expect(out).toContain('[green]Markup Name[/green]');
    expect(out).toContain('source: c');
  });

  test('search with no results', async () => {
    configureCatalog({ demo: catalogEntryDict('demo') });
    const { out } = await run(['search', 'zzz-nothing', '--offline']);
    expect(out).toContain('No matching bundles found.');
  });

  test('info expands the full component set (json + text)', async () => {
    configureCatalog({ 'demo-bundle': catalogEntryDict('demo-bundle', { download_url: 'https://example.com/demo.yml' }) });
    const src = path.join(tmp, 'src-bundle');
    writeManifest(src);
    commandDeps.downloadManifest = async () => (await localManifestSource(src))!;
    const json = await run(['info', 'demo-bundle', '--offline', '--json']);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.out);
    expect(payload.components).toEqual([
      { kind: 'extensions', id: 'ext-a', version: '1.0.0' },
      { kind: 'presets', id: 'preset-a', version: '2.0.0', priority: 10, strategy: 'append' },
      { kind: 'steps', id: 'step-a', version: null },
      { kind: 'workflows', id: 'wf-a', version: '0.3.0' },
    ]);
    expect(payload.trust).toBe('verified');
    expect(payload.integration).toBeNull();
    const text = await run(['info', 'demo-bundle', '--offline']);
    expect(text.out).toContain('Components (added on install):');
    expect(text.out).toContain('- preset-a v2.0.0 (priority=10, strategy=append)');
    expect(text.out).toContain('- step-a');
    expect(text.out).toContain('Trust: ✔ verified');
  });

  test('info of discovery-only bundle is inspectable but flagged', async () => {
    configureCatalog({ 'demo-bundle': catalogEntryDict('demo-bundle', { download_url: 'https://example.com/demo.yml' }) }, 'discovery-only');
    const src = path.join(tmp, 'src-bundle');
    writeManifest(src);
    commandDeps.downloadManifest = async () => (await localManifestSource(src))!;
    const { code, out } = await run(['info', 'demo-bundle', '--offline']);
    expect(code).toBe(0);
    expect(flat(out)).toContain('This source is discovery-only; the bundle cannot be installed from here.');
  });

  test('info fails loudly when the manifest is unresolvable offline', async () => {
    configureCatalog({ 'demo-bundle': catalogEntryDict('demo-bundle', { download_url: 'https://example.com/demo.yml' }) });
    const { code, err } = await run(['info', 'demo-bundle', '--offline']);
    expect(code).toBe(1);
    expect(flat(err)).toContain("Network access disabled; cannot download bundle 'demo-bundle'");
  });

  test('info unknown bundle reports not found', async () => {
    configureCatalog({});
    const { code, err } = await run(['info', 'nope', '--offline']);
    expect(code).toBe(1);
    expect(flat(err)).toContain("Bundle 'nope' was not found in any configured catalog.");
  });
});

// ============================================================================
// install / add / update / remove
// ============================================================================

describe('install lifecycle', () => {
  function localBundle(overrides: Record<string, unknown> = {}): string {
    const dir = path.join(tmp, 'local-bundle');
    writeManifest(dir, validManifestDict(overrides));
    writeFileSync(path.join(dir, 'README.md'), '# b\n');
    return dir;
  }

  test('local bundle installs, lists and removes', async () => {
    const dir = localBundle();
    let r = await run(['install', dir, '--offline']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Installed 'demo-bundle' (4 added, 0 already present).");
    expect(loadRecords(project).map((x) => x.bundle_id)).toEqual(['demo-bundle']);
    r = await run(['add', dir, '--offline']);
    expect(r.out).toContain("Installed 'demo-bundle' (0 added, 4 already present).");
    r = await run(['remove', 'demo-bundle']);
    expect(r.out).toContain("Removed 'demo-bundle' (4 uninstalled, 0 kept for other bundles).");
    expect(loadRecords(project)).toEqual([]);
  });

  test('refresh summary reports refreshed/removed', async () => {
    const dir = localBundle();
    await run(['install', dir, '--offline']);
    const data = validManifestDict();
    (data.provides as Record<string, unknown>).steps = [];
    writeManifest(dir, data);
    let r = await run(['install', dir, '--offline']);
    expect(r.code).toBe(1);
    expect(flat(r.err)).toContain('--refresh');
    r = await run(['install', dir, '--offline', '--refresh']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Installed 'demo-bundle' (0 added, 0 already present, 3 refreshed, 1 removed).");
  });

  test('zip artifact installs offline', async () => {
    const dir = localBundle();
    const artifact = buildBundle(dir, path.join(tmp, 'dist')).artifact_path;
    const r = await run(['install', artifact, '--offline']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Installed 'demo-bundle'");
  });

  test('invalid local manifest is rejected', async () => {
    const dir = localBundle({ schema_version: '9' });
    const r = await run(['install', dir, '--offline']);
    expect(r.code).toBe(1);
    expect(flat(r.err)).toContain(`Local bundle source '${dir}' contains an invalid bundle manifest:`);
    expect(installer.installCalls).toEqual([]);
  });

  test('discovery-only source refuses install', async () => {
    configureCatalog({ demo: catalogEntryDict('demo') }, 'discovery-only', 'disc');
    const r = await run(['install', 'demo', '--offline']);
    expect(r.code).toBe(1);
    expect(flat(r.err)).toContain("resolves only from a discovery-only source ('disc'); it cannot be installed from there.");
  });

  test('--integration cannot bypass the clash guard', async () => {
    writeFileSync(path.join(project, '.specify', 'integration.json'), JSON.stringify({ integration: 'copilot' }));
    const dir = localBundle({ integration: { id: 'claude' } });
    const r = await run(['install', dir, '--integration', 'claude', '--offline']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('claude');
    expect(r.err).toContain('copilot');
  });

  test('pinned integration with indeterminate project needs --integration', async () => {
    const dir = localBundle({ integration: { id: 'claude' } });
    let r = await run(['install', dir, '--offline']);
    expect(r.code).toBe(1);
    expect(flat(r.err)).toContain('could not be determined');
    r = await run(['install', dir, '--offline', '--integration', 'claude']);
    expect(r.code).toBe(0);
  });

  test('uninitialized directory: compatibility gates run before init; init uses bundle integration', async () => {
    const empty = path.join(tmp, 'empty');
    mkdirSync(empty);
    process.chdir(empty);
    const initCalls: string[][] = [];
    commandDeps.runInitCommand = async (args) => {
      initCalls.push(args);
      mkdirSync(path.join(empty, '.specify'), { recursive: true });
      writeFileSync(path.join(empty, '.specify', 'integration.json'), JSON.stringify({ integration: 'claude' }));
      return 0;
    };
    const incompatible = localBundle({ requires: { speckit_version: '>=99.0.0' }, integration: { id: 'claude' } });
    let r = await run(['install', incompatible, '--offline']);
    expect(r.code).toBe(1);
    expect(flat(r.err)).toContain('requires Spec Kit >=99.0.0');
    expect(initCalls).toEqual([]);

    const ok = localBundle({ integration: { id: 'claude' } });
    r = await run(['install', ok, '--offline']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No Spec Kit project here; initializing with integration 'claude'…");
    expect(initCalls[0]).toEqual([
      '--here',
      '--force',
      '--ignore-agent-tools',
      '--non-interactive',
      '--script',
      process.platform === 'win32' ? 'ps' : 'sh',
      '--integration',
      'claude',
      '--offline',
    ]);
  });

  test('failed init is reported', async () => {
    const empty = path.join(tmp, 'empty2');
    mkdirSync(empty);
    process.chdir(empty);
    commandDeps.runInitCommand = async () => 1;
    commandDeps.resolveDefaultInitIntegration = async () => 'copilot';
    const r = await run(['init', '--offline']);
    expect(r.code).toBe(1);
    expect(flat(r.err)).toContain("Failed to initialize a Spec Kit project (integration 'copilot').");
  });

  test('bundle init on an existing project is a no-op', async () => {
    const r = await run(['init']);
    expect(r.code).toBe(0);
    expect(flat(r.out)).toContain(`Spec Kit project ready at ${project}.`);
  });

  test('update: requires id or --all; refuses discovery-only; refreshes', async () => {
    let r = await run(['update']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('Specify a bundle id or use --all.');
    r = await run(['update', '--all']);
    expect(r.out).toContain('No installed bundles to update.');

    const dir = localBundle();
    await run(['install', dir, '--offline']);
    configureCatalog({ 'demo-bundle': catalogEntryDict('demo-bundle', { download_url: 'https://example.com/demo.yml' }) }, 'discovery-only');
    r = await run(['update', 'demo-bundle', '--offline']);
    expect(r.code).toBe(1);
    expect(flat(r.err)).toContain('Update requires an install-allowed source (FR-025).');

    configureCatalog({ 'demo-bundle': catalogEntryDict('demo-bundle', { download_url: 'https://example.com/demo.yml' }) });
    commandDeps.downloadManifest = async () => BundleManifest.fromDict(validManifestDict());
    r = await run(['update', '--all', '--offline', '--integration', 'copilot']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Updated 'demo-bundle' to v1.2.0.");
    expect(installer.refreshCalls).toHaveLength(4);
  });

  test('remove reports a clean error when the primitive raises', async () => {
    const dir = localBundle();
    await run(['install', dir, '--offline']);
    installer.remove = () => {
      throw new TypeError('raw boom');
    };
    const r = await run(['remove', 'demo-bundle']);
    expect(r.code).toBe(1);
    expect(flat(r.err)).toContain("Failed to remove bundle 'demo-bundle': raw boom.");
  });
});

// ============================================================================
// validate / build
// ============================================================================

describe('validate and build', () => {
  test('validate reports invalid manifest', async () => {
    writeManifest(path.join(project, 'b'), validManifestDict({ schema_version: '9' }));
    const r = await run(['validate', '--path', path.join(project, 'b'), '--offline']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Manifest is invalid:');
    expect(r.out).toContain("schema_version '9' is not supported");
  });

  test('validate accepts a valid manifest offline with warnings for unverifiable refs', async () => {
    const { primitiveDeps } = await import('../src/bundles/primitives.js');
    const saved = { ...primitiveDeps };
    try {
      primitiveDeps.locateBundledExtension = async () => null;
      primitiveDeps.locateBundledPreset = async () => null;
      primitiveDeps.locateBundledWorkflow = async () => null;
      primitiveDeps.builtinStepTypes = async () => new Set<string>();
      for (const k of ['presetManager', 'extensionManager', 'workflowRegistry', 'stepRegistry'] as const) {
        (primitiveDeps as Record<string, unknown>)[k] = async () => {
          throw new Error('not installed');
        };
      }
      writeManifest(path.join(project, 'b'));
      const r = await run(['validate', '--path', path.join(project, 'b', 'bundle.yml'), '--offline']);
      expect(r.code).toBe(0);
      expect(r.out).toContain("! Could not verify extension 'ext-a' offline");
      expect(r.out).toContain('demo-bundle is well-formed and valid.');
    } finally {
      Object.assign(primitiveDeps, saved);
    }
  });

  test('validate missing manifest', async () => {
    const r = await run(['validate', '--path', path.join(tmp, 'nowhere')]);
    expect(r.code).toBe(1);
    expect(flat(r.err)).toContain('No bundle.yml found at');
  });

  test('build produces an artifact and escapes markup in paths', async () => {
    const dir = path.join(project, '[red]b[/red]');
    writeManifest(dir);
    writeFileSync(path.join(dir, 'README.md'), '# b\n');
    const r = await run(['build', '--path', dir]);
    expect(r.code).toBe(0);
    expect(flat(r.out)).toContain('Built demo-bundle-1.2.0.zip (2 files) →');
    expect(r.out).toContain('[red]b[/red]');
    expect(readFileSync(path.join(dir, 'demo-bundle-1.2.0.zip')).length).toBeGreaterThan(0);
  });
});
