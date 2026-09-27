/**
 * CLI-level tests for ``specify extension`` (port of upstream
 * tests/specify_cli/extensions/test_command_*.py, catalog/test_command_*.py
 * and tests/test_installed_list_json.py extension cases).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { console as richConsole, errConsole, setPromptInput } from '../src/console.js';
import { runExtensionCommand } from '../src/extensions/commands.js';
import { runUpdateCommand } from '../src/extensions/command-update-transaction.js';
import { ExtensionCatalog, ExtensionManager, HookExecutor } from '../src/extensions/index.js';
import { parseYaml } from '../src/yaml.js';
import { Version } from '../src/bundles/versioning.js';
import {
  type AnyDict,
  cleanupTempDirs,
  makeExtensionDir,
  makeProjectDir,
  makeSimpleExtension,
  makeTempDir,
  validManifestData,
  writeManifest,
} from './extensions-helpers.js';

let out: string[] = [];
let err: string[] = [];
let origCwd: string;
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;
const origOpenUrl = ExtensionCatalog.prototype.openUrl;
const origResolve = ExtensionCatalog.prototype.resolveGithubReleaseAssetApiUrl;
let catalogRoutes: Record<string, string | Uint8Array> = {};

beforeEach(() => {
  out = [];
  err = [];
  origCwd = process.cwd();
  richConsole.file = { write: (s: string) => out.push(s), isTTY: false, columns: 200 };
  errConsole.file = { write: (s: string) => err.push(s), isTTY: false, columns: 200 };
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => {
    out.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    err.push(String(s));
    return true;
  }) as typeof process.stderr.write;
  catalogRoutes = {};
  ExtensionCatalog.prototype.openUrl = async function (url: string) {
    const body = catalogRoutes[url];
    if (body === undefined) throw new Error(`HTTP Error 404: Not Found`);
    return new Response(body);
  };
  ExtensionCatalog.prototype.resolveGithubReleaseAssetApiUrl = async () => null;
  delete process.env.SPECKIT_CATALOG_URL;
  delete process.env.SPECIFY_INIT_DIR;
});

afterEach(() => {
  process.chdir(origCwd);
  richConsole.file = process.stdout;
  errConsole.file = process.stderr;
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  ExtensionCatalog.prototype.openUrl = origOpenUrl;
  ExtensionCatalog.prototype.resolveGithubReleaseAssetApiUrl = origResolve;
  setPromptInput(null);
  delete process.env.SPECKIT_CATALOG_URL;
  cleanupTempDirs();
});

function output(): string {
  return out.join('');
}

async function run(proj: string, ...args: string[]): Promise<number> {
  process.chdir(proj);
  return runExtensionCommand(args);
}

function withInstalled(data: AnyDict = validManifestData()): { temp: string; proj: string; ext: string } {
  const temp = makeTempDir();
  const ext = makeExtensionDir(temp, data);
  const proj = makeProjectDir(temp);
  new ExtensionManager(proj).installFromDirectory(ext, '0.1.0', { registerCommands: false });
  return { temp, proj, ext };
}

function useCatalog(proj: string, extensions: AnyDict, installAllowed = true): void {
  const url = 'https://catalog.example.com/c.json';
  writeFileSync(
    join(proj, '.specify', 'extension-catalogs.yml'),
    `catalogs:\n- name: team\n  url: ${url}\n  priority: 1\n  install_allowed: ${installAllowed}\n`,
  );
  catalogRoutes[url] = JSON.stringify({ schema_version: '1.0', extensions });
}

describe('specify extension list', () => {
  test('not a project', async () => {
    const dir = makeTempDir();
    expect(await run(dir, 'list')).toBe(1);
    expect(err.join('')).toContain('Error: Not a Spec Kit project (no .specify/ directory)');
  });

  test('empty project', async () => {
    const proj = makeProjectDir(makeTempDir());
    expect(await run(proj, 'list')).toBe(0);
    expect(output()).toContain('No extensions installed.');
    expect(output()).toContain('specify extension add <extension-name>');
  });

  test('lists installed extension', async () => {
    const { proj } = withInstalled();
    expect(await run(proj, 'list')).toBe(0);
    const text = output();
    expect(text).toContain('Installed Extensions:');
    expect(text).toContain('✓ Test Extension (v1.0.0)');
    expect(text).toContain('Commands: 1 | Hooks: 1 | Priority: 10 | Status: Enabled');
  });

  test('--json emits the public contract sorted by priority then id', async () => {
    const temp = makeTempDir();
    const proj = makeProjectDir(temp);
    const manager = new ExtensionManager(proj);
    manager.installFromDirectory(makeSimpleExtension(temp, 'zeta'), '0.1.0', { registerCommands: false, priority: 1 });
    manager.installFromDirectory(makeSimpleExtension(temp, 'alpha'), '0.1.0', { registerCommands: false, priority: 5 });
    manager.installFromDirectory(makeSimpleExtension(temp, 'beta'), '0.1.0', {
      registerCommands: false,
      priority: 5,
      catalogName: 'team',
    });
    expect(await run(proj, 'list', '--json')).toBe(0);
    const payload = JSON.parse(output());
    expect(payload.map((e: AnyDict) => e.id)).toEqual(['zeta', 'alpha', 'beta']);
    expect(payload[2]).toEqual({
      id: 'beta',
      name: 'Ext beta',
      description: 'Test',
      version: '1.0.0',
      author: null,
      priority: 5,
      enabled: true,
      source: { kind: 'catalog', catalog: 'team' },
      provides: { commands: 1, templates: 0, scripts: 0, hooks: 0 },
    });
  });

  test('--json outside a project reports JSON error on stderr', async () => {
    const dir = makeTempDir();
    expect(await run(dir, 'list', '--json')).toBe(1);
    expect(out.join('')).toBe('');
    expect(JSON.parse(err.join(''))).toEqual({ error: 'Not a Spec Kit project (no .specify/ directory)' });
  });

  test('--json usage errors stay on the JSON contract', async () => {
    const proj = makeProjectDir(makeTempDir());
    expect(await run(proj, 'list', '--json', '--bogus')).toBe(2);
    expect(JSON.parse(err.join(''))).toEqual({ error: 'No such option: --bogus' });
  });
});

describe('specify extension add', () => {
  test('--dev installs from a local directory', async () => {
    const temp = makeTempDir();
    const ext = makeExtensionDir(temp);
    const proj = makeProjectDir(temp);
    expect(await run(proj, 'add', ext, '--dev')).toBe(0);
    const text = output();
    expect(text).toContain('✓ Extension installed successfully!');
    expect(text).toContain('Test Extension (v1.0.0)');
    expect(text).toContain('Provided commands:');
    expect(text).toContain('• speckit.test-ext.hello - Test command');
    expect(text).toContain('⚠  Configuration may be required');
    expect(text).toContain('Check: .specify/extensions/test-ext/');
    expect(new ExtensionManager(proj).registry.isInstalled('test-ext')).toBe(true);
  });

  test('--dev missing directory', async () => {
    const proj = makeProjectDir(makeTempDir());
    expect(await run(proj, 'add', join(proj, 'nope'), '--dev')).toBe(1);
    expect(output()).toContain('Error: Directory not found:');
  });

  test('invalid priority', async () => {
    const proj = makeProjectDir(makeTempDir());
    expect(await run(proj, 'add', 'x', '--priority', '0')).toBe(1);
    expect(output()).toContain('Error: Priority must be a positive integer (1 or higher)');
  });

  test('--from rejects plain http and malformed URLs', async () => {
    const proj = makeProjectDir(makeTempDir());
    expect(await run(proj, 'add', 'x', '--from', 'http://example.com/x.zip')).toBe(1);
    expect(output()).toContain('Error: URL must use HTTPS for security.');
    out = [];
    expect(await run(proj, 'add', 'x', '--from', 'https://[not-an-ip]/x.zip')).toBe(1);
    expect(output()).toContain('Error: Invalid URL: https://');
  });

  test('--from shows the untrusted source panel and honours "no"', async () => {
    const proj = makeProjectDir(makeTempDir());
    setPromptInput(['n']);
    expect(await run(proj, 'add', 'x', '--from', 'https://example.com/x.zip')).toBe(0);
    const text = output();
    expect(text).toContain('⚠ Untrusted Source');
    expect(text).toContain('bypassing your trusted (install-allowed) extension catalogs.');
    expect(text).toContain('Cancelled');
  });

  test('installs a bundled extension from the local package', async () => {
    const proj = makeProjectDir(makeTempDir());
    expect(await run(proj, 'add', 'git')).toBe(0);
    expect(output()).toContain('✓ Extension installed successfully!');
    expect(existsSync(join(proj, '.specify', 'extensions', 'git', 'extension.yml'))).toBe(true);
  });

  test('not found in catalog', async () => {
    const proj = makeProjectDir(makeTempDir());
    useCatalog(proj, {});
    expect(await run(proj, 'add', 'missing-ext')).toBe(1);
    expect(output()).toContain("Error: Extension 'missing-ext' not found in catalog");
  });

  test('discovery-only catalog refuses install with vetting guidance', async () => {
    const proj = makeProjectDir(makeTempDir());
    useCatalog(proj, { shiny: { name: 'Shiny', version: '1.0.0', download_url: 'https://x.example.com/s.zip' } }, false);
    expect(await run(proj, 'add', 'shiny')).toBe(1);
    const text = output();
    expect(text).toContain("Error: 'shiny' was found in the 'team' catalog, which is discovery-only");
    expect(text).toContain('specify extension add shiny --from <archive-url>');
    expect(text).toContain("Don't flip");
  });

  test('install-time validation errors are reported', async () => {
    const temp = makeTempDir();
    const src = makeSimpleExtension(temp, 'probe', { cmd: { aliases: ['speckit.plan'] } });
    const proj = makeProjectDir(temp);
    expect(await run(proj, 'add', src, '--dev')).toBe(1);
    expect(output()).toContain('Validation Error: Extension commands conflict with core or installed extension commands:');
  });
});

describe('specify extension remove / enable / disable / set-priority', () => {
  test('remove --force backs up config', async () => {
    const { proj } = withInstalled();
    writeFileSync(join(proj, '.specify', 'extensions', 'test-ext', 'test-ext-config.yml'), 'a: 1');
    expect(await run(proj, 'remove', 'test-ext', '--force')).toBe(0);
    expect(output()).toContain("✓ Extension 'Test Extension' removed successfully");
    expect(output()).toContain('Config files backed up to .specify/extensions/.backup/test-ext/');
    expect(existsSync(join(proj, '.specify', 'extensions', '.backup', 'test-ext', 'test-ext-config.yml'))).toBe(true);
  });

  test('remove by display name with confirmation and --keep-config', async () => {
    const { proj } = withInstalled();
    setPromptInput(['y']);
    expect(await run(proj, 'remove', 'test extension', '--keep-config')).toBe(0);
    const text = output();
    expect(text).toContain('⚠  This will remove:');
    expect(text).toContain('• 0 commands per agent');
    expect(text).toContain('Config files preserved in .specify/extensions/test-ext/');
  });

  test('ambiguous display name', async () => {
    const temp = makeTempDir();
    const proj = makeProjectDir(temp);
    const manager = new ExtensionManager(proj);
    for (const id of ['one', 'two']) {
      const dir = join(temp, id);
      const data = validManifestData();
      data.extension.id = id;
      data.extension.name = 'Same Name';
      data.provides.commands[0].name = `speckit.${id}.hello`;
      data.hooks.after_tasks.command = `speckit.${id}.hello`;
      writeManifest(dir, data);
      mkdirSync(join(dir, 'commands'), { recursive: true });
      writeFileSync(join(dir, 'commands', 'hello.md'), 'x');
      manager.installFromDirectory(dir, '0.1.0', { registerCommands: false });
    }
    expect(await run(proj, 'disable', 'Same Name')).toBe(1);
    expect(output()).toContain("Error: Extension name 'Same Name' is ambiguous.");
    expect(output()).toContain('specify extension disable <extension-id>');
  });

  test('disable / enable toggle registry and hooks', async () => {
    const { proj } = withInstalled();
    expect(await run(proj, 'disable', 'test-ext')).toBe(0);
    expect(output()).toContain("✓ Extension 'Test Extension' disabled");
    expect(new ExtensionManager(proj).registry.get('test-ext')!.enabled).toBe(false);
    expect(new HookExecutor(proj).getHooksForEvent('after_tasks')).toEqual([]);
    out = [];
    expect(await run(proj, 'disable', 'test-ext')).toBe(0);
    expect(output()).toContain("Extension 'Test Extension' is already disabled");
    out = [];
    expect(await run(proj, 'enable', 'test-ext')).toBe(0);
    expect(output()).toContain("✓ Extension 'Test Extension' enabled");
    expect(new HookExecutor(proj).getHooksForEvent('after_tasks')).toHaveLength(1);
    const cfg = parseYaml(readFileSync(join(proj, '.specify', 'extensions.yml'), 'utf-8')) as AnyDict;
    expect(cfg.hooks.after_tasks[0].enabled).toBe(true);
  });

  test('set-priority changes and repairs priority', async () => {
    const { proj } = withInstalled();
    expect(await run(proj, 'set-priority', 'test-ext', '3')).toBe(0);
    expect(output()).toContain("✓ Extension 'Test Extension' priority changed: 10 → 3");
    out = [];
    expect(await run(proj, 'set-priority', 'test-ext', '3')).toBe(0);
    expect(output()).toContain("Extension 'Test Extension' already has priority 3");
    const manager = new ExtensionManager(proj);
    manager.registry.update('test-ext', { priority: 'high' });
    out = [];
    expect(await run(proj, 'set-priority', 'test-ext', '10')).toBe(0);
    expect(output()).toContain('priority changed: 10 → 10');
    expect(new ExtensionManager(proj).registry.get('test-ext')!.priority).toBe(10);
    out = [];
    expect(await run(proj, 'set-priority', 'test-ext', '0')).toBe(1);
  });
});

describe('specify extension search / info', () => {
  test('search renders catalog entries with safe install commands', async () => {
    const proj = makeProjectDir(makeTempDir());
    useCatalog(proj, {
      jira: { name: 'Jira', version: '1.0.0', description: 'Jira [bold]x[/bold]', author: 'A', tags: ['pm'], downloads: 1500, verified: true },
      'bad; rm -rf ~': { name: 'Evil', version: '1.0.0', description: 'd' },
    });
    expect(await run(proj, 'search')).toBe(0);
    const text = output();
    expect(text).toContain('Found 2 extension(s):');
    expect(text).toContain('Jira (v1.0.0) ✓ Verified');
    expect(text).toContain('Jira [bold]x[/bold]');
    expect(text).toContain('Downloads: 1,500');
    expect(text).toContain('Install: specify extension add jira');
    expect(text).toContain('Install: specify extension add <extension-id>');
  });

  test('search with no results and filters', async () => {
    const proj = makeProjectDir(makeTempDir());
    useCatalog(proj, {});
    expect(await run(proj, 'search', 'zzz')).toBe(0);
    expect(output()).toContain('No extensions found matching criteria');
    expect(output()).toContain('• Broader search terms');
  });

  test('search catalog failure', async () => {
    const proj = makeProjectDir(makeTempDir());
    writeFileSync(
      join(proj, '.specify', 'extension-catalogs.yml'),
      'catalogs:\n- name: dead\n  url: https://dead.example.com/c.json\n',
    );
    expect(await run(proj, 'search')).toBe(1);
    expect(output()).toContain('Error: Failed to fetch any extension catalog');
    expect(output()).toContain('Tip: The catalog may be temporarily unavailable. Try again later.');
  });

  test('info for installed-only extension', async () => {
    const { proj } = withInstalled();
    useCatalog(proj, {});
    expect(await run(proj, 'info', 'test-ext')).toBe(0);
    const text = output();
    expect(text).toContain('Test Extension (v1.0.0)');
    expect(text).toContain('Author: Test Author');
    expect(text).toContain('• speckit.test-ext.hello: Test command');
    expect(text).toContain('Note: Not found in catalog (custom/local extension)');
    expect(text).toContain('To remove: specify extension remove test-ext');
  });

  test('info for discovery-only catalog entry', async () => {
    const proj = makeProjectDir(makeTempDir());
    useCatalog(proj, { shiny: { name: 'Shiny', version: '2.0.0', description: 'd', download_url: 'https://x.example.com/s.zip' } }, false);
    expect(await run(proj, 'info', 'shiny')).toBe(0);
    const text = output();
    expect(text).toContain('Source catalog: team (discovery only)');
    expect(text).toContain("'shiny' is in the 'team' catalog, which is discovery-only");
    expect(text).toContain('Candidate archive (vet before installing): https://x.example.com/s.zip');
  });

  test('info not found anywhere', async () => {
    const proj = makeProjectDir(makeTempDir());
    useCatalog(proj, {});
    expect(await run(proj, 'info', 'nope')).toBe(1);
    expect(output()).toContain("Error: Extension 'nope' not found");
  });
});

describe('specify extension catalog', () => {
  test('add is idempotent, conflicting duplicate refused, remove works', async () => {
    const proj = makeProjectDir(makeTempDir());
    expect(await run(proj, 'catalog', 'add', 'https://example.com/c.json', '--name', 'team', '--install-allowed')).toBe(0);
    expect(output()).toContain("✓ Added catalog 'team' (install allowed)");
    const cfgPath = join(proj, '.specify', 'extension-catalogs.yml');
    expect(readFileSync(cfgPath, 'utf-8')).toBe(
      "catalogs:\n- name: team\n  url: https://example.com/c.json\n  priority: 10\n  install_allowed: true\n  description: ''\n",
    );
    out = [];
    expect(await run(proj, 'catalog', 'add', 'https://example.com/c.json', '--name', 'team', '--install-allowed')).toBe(0);
    expect(output()).toBe('');
    expect(await run(proj, 'catalog', 'add', 'https://other.example.com/c.json', '--name', 'team')).toBe(1);
    expect(output()).toContain("Warning: A catalog named 'team' already exists.");
    out = [];
    expect(await run(proj, 'catalog', 'list')).toBe(0);
    expect(output()).toContain('team (priority 10)');
    expect(output()).toContain('Config: .specify/extension-catalogs.yml');
    out = [];
    expect(await run(proj, 'catalog', 'remove', 'team')).toBe(0);
    expect(output()).toContain('No catalogs remain in config. Built-in defaults will be used.');
  });

  test('add rejects non-https and invalid config shapes', async () => {
    const proj = makeProjectDir(makeTempDir());
    expect(await run(proj, 'catalog', 'add', 'http://example.com/c.json', '--name', 'x')).toBe(1);
    expect(output()).toContain('Error: Catalog URL must use HTTPS (got http://). HTTP is only allowed for localhost.');
    writeFileSync(join(proj, '.specify', 'extension-catalogs.yml'), 'catalogs: nope\n');
    out = [];
    expect(await run(proj, 'catalog', 'add', 'https://example.com/c.json', '--name', 'x')).toBe(1);
    expect(output()).toContain("Error: Invalid catalog config: 'catalogs' must be a list.");
    writeFileSync(join(proj, '.specify', 'extension-catalogs.yml'), '- a\n');
    out = [];
    expect(await run(proj, 'catalog', 'remove', 'x')).toBe(1);
    expect(output()).toContain('expected a YAML mapping at the root.');
  });

  test('remove without config', async () => {
    const proj = makeProjectDir(makeTempDir());
    expect(await run(proj, 'catalog', 'remove', 'x')).toBe(1);
    expect(output()).toContain('Error: No catalog config found. Nothing to remove.');
  });

  test('list uses SPECKIT_CATALOG_URL', async () => {
    const proj = makeProjectDir(makeTempDir());
    process.env.SPECKIT_CATALOG_URL = 'https://custom.example.com/c.json';
    expect(await run(proj, 'catalog', 'list')).toBe(0);
    expect(output()).toContain('custom (priority 1)');
    expect(output()).toContain('Catalog configured via SPECKIT_CATALOG_URL environment variable.');
  });
});

describe('specify extension update', () => {
  test('no extensions installed', async () => {
    const proj = makeProjectDir(makeTempDir());
    expect(await run(proj, 'update')).toBe(0);
    expect(output()).toContain('No extensions installed');
  });

  test('up to date / not in catalog', async () => {
    const { proj } = withInstalled();
    useCatalog(proj, {});
    expect(await run(proj, 'update')).toBe(0);
    expect(output()).toContain('⚠  test-ext: Not found in catalog (skipping)');
    expect(output()).toContain('All extensions are up to date!');
    out = [];
    useCatalog(proj, { 'test-ext': { name: 'Test Extension', version: '1.0.0' } });
    new ExtensionCatalog(proj).clearCache();
    expect(await run(proj, 'update')).toBe(0);
    expect(output()).toContain('✓ test-ext: Up to date (v1.0.0)');
  });

  test('updates a bundled extension from the local package, preserving config and state', async () => {
    const { temp, proj } = withInstalled();
    const manager = new ExtensionManager(proj);
    manager.registry.update('test-ext', { priority: 4 });
    writeFileSync(join(proj, '.specify', 'extensions', 'test-ext', 'test-ext-config.yml'), 'user: custom\n');
    const originalInstalledAt = manager.registry.get('test-ext')!.installed_at;

    const newData = validManifestData();
    newData.extension.version = '1.1.0';
    const newSrc = makeExtensionDir(temp, newData, 'test-ext-v2');
    useCatalog(proj, { 'test-ext': { name: 'Test Extension', version: '1.1.0', bundled: true } });
    setPromptInput(['y']);
    process.chdir(proj);
    let code = 0;
    try {
      await runUpdateCommand(null, {
        bundledUpdateSource: () => [newSrc, new Version('1.1.0')],
      });
    } catch (e) {
      code = (e as { code?: number }).code ?? -1;
    }
    expect(code).toBe(0);
    const text = output();
    expect(text).toContain('• test-ext: 1.0.0 → 1.1.0');
    expect(text).toContain('✓ Updated to v1.1.0');
    expect(text).toContain('Successfully updated 1 extension(s)');
    const meta = new ExtensionManager(proj).registry.get('test-ext')!;
    expect(meta.version).toBe('1.1.0');
    expect(meta.priority).toBe(4);
    expect(meta.installed_at).toBe(originalInstalledAt);
    expect(meta.source).toEqual({ kind: 'catalog', catalog: 'team' });
    expect(readFileSync(join(proj, '.specify', 'extensions', 'test-ext', 'test-ext-config.yml'), 'utf-8')).toBe(
      'user: custom\n',
    );
    expect(existsSync(join(proj, '.specify', 'extensions', '.backup'))).toBe(true);
  });

  test('bundled update blocked when local copy is older', async () => {
    const { proj } = withInstalled();
    useCatalog(proj, { 'test-ext': { name: 'Test Extension', version: '2.0.0', bundled: true } });
    process.chdir(proj);
    let code = -1;
    try {
      await runUpdateCommand(null, { bundledUpdateSource: () => [null, null] });
    } catch (e) {
      code = (e as { code: number }).code;
    }
    expect(code).toBe(0);
    expect(output()).toContain(
      "⚠  test-ext: v2.0.0 is available, but this spec-kit release does not ship a local copy — upgrade spec-kit, then rerun 'specify extension update'",
    );
    expect(output()).toContain('Update(s) exist but require a newer spec-kit release');
  });

  test('failed preflight leaves installation untouched', async () => {
    const { temp, proj } = withInstalled();
    const newData = validManifestData();
    newData.extension.version = '1.5.0'; // catalog promises 1.1.0 → version mismatch
    const newSrc = makeExtensionDir(temp, newData, 'test-ext-bad');
    useCatalog(proj, { 'test-ext': { name: 'Test Extension', version: '1.1.0', bundled: true } });
    setPromptInput(['y']);
    process.chdir(proj);
    let code = -1;
    try {
      await runUpdateCommand(null, {
        bundledUpdateSource: () => [newSrc, new Version('1.1.0')],
      });
    } catch (e) {
      code = (e as { code: number }).code;
    }
    expect(code).toBe(1);
    expect(output()).toContain("✗ Failed: Extension version mismatch: expected '1.1.0', got '1.5.0'");
    expect(output()).not.toContain('Rolling back');
    const meta = new ExtensionManager(proj).registry.get('test-ext')!;
    expect(meta.version).toBe('1.0.0');
  });
});
