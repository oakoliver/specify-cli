/**
 * Tests for `specify integration ...` commands
 * (ports of key cases from tests/specify_cli/integrations/test_command_*.py and
 * tests/specify_cli/integrations/catalog/test_command_*.py).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runIntegrationCommand } from '../src/integrations/commands.js';
import { console as appConsole, errConsole } from '../src/console.js';
import { scaffoldIntegration, scaffoldFs } from '../src/integrations/command-scaffold-generation.js';
import {
  installedPresetsAffectingAgent,
  manifestPathUnder,
  manifestTracksSkillLayout,
  PresetRegistryUnreadableError,
} from '../src/integrations/command-upgrade-layout.js';

const IS_WINDOWS = process.platform === 'win32';

let tmp: string;
let project: string;
let origCwd: string;
const savedEnv: Record<string, string | undefined> = {};

interface RunResult {
  code: number;
  output: string;
}

async function run(args: string[], cwd = project): Promise<RunResult> {
  const prev = process.cwd();
  process.chdir(cwd);
  appConsole.beginCapture();
  errConsole.beginCapture();
  const origWrite = process.stdout.write.bind(process.stdout);
  let stdout = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    stdout += s;
    return true;
  };
  let code: number;
  try {
    code = await runIntegrationCommand(args);
  } finally {
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
    process.chdir(prev);
  }
  const output = appConsole.endCapture() + errConsole.endCapture() + stdout;
  return { code, output };
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function state(): Record<string, unknown> {
  return readJson(join(project, '.specify', 'integration.json'));
}

function manifestFiles(key: string): Record<string, string> {
  return readJson(join(project, '.specify', 'integrations', `${key}.manifest.json`))['files'] as Record<string, string>;
}

beforeEach(() => {
  origCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'integration-cmd-'));
  project = join(tmp, 'proj');
  mkdirSync(join(project, '.specify'), { recursive: true });
  for (const k of ['SPECIFY_INIT_DIR', 'SPECKIT_INTEGRATION_CATALOG_URL', 'HOME']) savedEnv[k] = process.env[k];
  delete process.env.SPECIFY_INIT_DIR;
  delete process.env.SPECKIT_INTEGRATION_CATALOG_URL;
  process.env.HOME = join(tmp, 'home');
});

afterEach(() => {
  process.chdir(origCwd);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

// ============================================================================
// install
// ============================================================================

describe('integration install', () => {
  test('requires a spec-kit project', async () => {
    const bare = join(tmp, 'bare');
    mkdirSync(bare);
    const r = await run(['install', 'claude'], bare);
    expect(r.code).toBe(1);
    expect(r.output).toContain('Not a Spec Kit project');
  });

  test('unknown integration', async () => {
    const r = await run(['install', 'nope']);
    expect(r.code).toBe(1);
    expect(r.output).toContain("Error: Unknown integration 'nope'");
    expect(r.output).toContain('Available integrations:');
  });

  test('installs into a bare project with shared infra', async () => {
    const r = await run(['install', 'claude', '--script', 'sh']);
    expect(r.code).toBe(0);
    expect(r.output).toContain("Integration 'Claude Code' installed successfully");
    const s = state();
    expect(s['integration']).toBe('claude');
    expect(s['default_integration']).toBe('claude');
    expect(s['installed_integrations']).toEqual(['claude']);
    expect(s['integration_state_schema']).toBe(1);
    expect((s['integration_settings'] as Record<string, Record<string, unknown>>)['claude']['script']).toBe('sh');
    expect(Object.keys(manifestFiles('claude')).length).toBeGreaterThan(0);
    expect(existsSync(join(project, '.specify', 'scripts', 'bash', 'common.sh'))).toBe(true);
    expect(existsSync(join(project, '.specify', 'templates', 'plan-template.md'))).toBe(true);
    expect(existsSync(join(project, '.specify', '.gitignore'))).toBe(true);
    expect(manifestFiles('speckit')['.specify/.gitignore']).toBeDefined();
    const opts = readJson(join(project, '.specify', 'init-options.json'));
    expect(opts['integration']).toBe('claude');
    expect(opts['ai']).toBe('claude');
    if (!IS_WINDOWS) {
      expect(statSync(join(project, '.specify', 'scripts', 'bash', 'common.sh')).mode & 0o111).not.toBe(0);
    }
  });

  test('already installed is a no-op', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const r = await run(['install', 'claude']);
    expect(r.code).toBe(0);
    expect(r.output).toContain("Integration 'claude' is already installed.");
    expect(r.output).toContain('It is already the default integration.');
    expect(r.output).toContain('No files were changed.');
  });

  test('multi-install safe integrations install alongside and keep the default', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const r = await run(['install', 'gemini']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('Default integration remains: claude');
    const s = state();
    expect(s['default_integration']).toBe('claude');
    expect(s['installed_integrations']).toEqual(['claude', 'gemini']);
    expect(readJson(join(project, '.specify', 'init-options.json'))['ai']).toBe('claude');

    const again = await run(['install', 'gemini']);
    expect(again.output).toContain('To make it the default integration, run specify integration use gemini.');
  });

  test('multi-install with an unsafe integration requires --force', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const r = await run(['install', 'copilot']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('Error: Installed integrations: claude.');
    expect(r.output).toContain('Default integration: claude.');
    expect(r.output).toContain('To replace the default integration, run specify integration switch copilot.');
    expect(existsSync(join(project, '.specify', 'integrations', 'copilot.manifest.json'))).toBe(false);

    const forced = await run(['install', 'copilot', '--force']);
    expect(forced.code).toBe(0);
    expect(state()['installed_integrations']).toEqual(['claude', 'copilot']);
  });

  test('invalid script type is rejected', async () => {
    const r = await run(['install', 'claude', '--script', 'bat']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('Invalid script type');
  });

  test('legacy `add` alias still works', async () => {
    const r = await run(['add', 'claude', '--script', 'sh']);
    expect(r.code).toBe(0);
    expect(state()['integration']).toBe('claude');
  });
});

// ============================================================================
// use / uninstall
// ============================================================================

describe('integration use / uninstall', () => {
  test('use sets the default among installed integrations', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    await run(['install', 'gemini']);
    const r = await run(['use', 'gemini']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('Default integration set to gemini.');
    expect(state()['default_integration']).toBe('gemini');
    expect(state()['installed_integrations']).toEqual(['claude', 'gemini']);
    expect(readJson(join(project, '.specify', 'init-options.json'))['ai']).toBe('gemini');
  });

  test('use requires an installed integration', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const r = await run(['use', 'gemini']);
    expect(r.code).toBe(1);
    expect(r.output).toContain("Error: Integration 'gemini' is not installed.");
    expect(r.output).toContain('Installed integrations: claude');
  });

  test('uninstall removes files and state, preserving shared infra', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const files = Object.keys(manifestFiles('claude'));
    const r = await run(['uninstall']);
    expect(r.code).toBe(0);
    expect(r.output).toContain("Integration 'Claude Code' uninstalled");
    expect(r.output).toMatch(/Removed \d+ file\(s\)/);
    for (const rel of files) expect(existsSync(join(project, rel))).toBe(false);
    expect(existsSync(join(project, '.specify', 'integration.json'))).toBe(false);
    expect(existsSync(join(project, '.specify', 'scripts', 'bash', 'common.sh'))).toBe(true);
    expect(existsSync(join(project, '.specify', '.gitignore'))).toBe(true);
    const opts = readJson(join(project, '.specify', 'init-options.json'));
    expect(opts['ai']).toBeUndefined();
  });

  test('uninstall preserves modified files', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const rel = Object.keys(manifestFiles('claude'))[0];
    writeFileSync(join(project, rel), 'user edit\n');
    const r = await run(['uninstall', 'claude']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('1 modified file(s) were preserved:');
    expect(r.output).toContain(`    ${rel}`);
    expect(readFileSync(join(project, rel), 'utf-8')).toBe('user edit\n');
  });

  test('uninstall wrong key / nothing installed', async () => {
    let r = await run(['uninstall']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('No integration is currently installed.');
    await run(['install', 'claude', '--script', 'sh']);
    r = await run(['uninstall', 'gemini']);
    expect(r.code).toBe(1);
    expect(r.output).toContain("Error: Integration 'gemini' is not installed.");
  });

  test('uninstall default falls back to the next installed integration', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    await run(['install', 'gemini']);
    const r = await run(['uninstall', 'claude']);
    expect(r.code).toBe(0);
    expect(state()['default_integration']).toBe('gemini');
    expect(state()['installed_integrations']).toEqual(['gemini']);
  });

  test('uninstall with unreadable manifest reports a CLI error', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    writeFileSync(join(project, '.specify', 'integrations', 'claude.manifest.json'), Buffer.from([0xff, 0xfe, 0]));
    const r = await run(['uninstall', 'claude']);
    expect(r.code).toBe(1);
    expect(r.output).toContain("Error: Integration manifest for 'claude' is unreadable.");
  });

  test('uninstall without manifest clears metadata', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    rmSync(join(project, '.specify', 'integrations', 'claude.manifest.json'));
    const r = await run(['uninstall', 'claude']);
    expect(r.code).toBe(0);
    expect(r.output).toContain("No manifest found for integration 'claude'. Nothing to uninstall.");
    expect(existsSync(join(project, '.specify', 'integration.json'))).toBe(false);
  });
});

// ============================================================================
// switch
// ============================================================================

describe('integration switch', () => {
  test('same target is a no-op', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const r = await run(['switch', 'claude']);
    expect(r.code).toBe(0);
    expect(r.output).toContain("Integration 'claude' is already the default integration. Nothing to switch.");
  });

  test('installed target rejects --integration-options', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const r = await run(['switch', 'claude', '--integration-options', '--skills']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('--integration-options cannot be used when switching');
  });

  test('switches between integrations', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const claudeFiles = Object.keys(manifestFiles('claude'));
    const r = await run(['switch', 'gemini']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('Uninstalling current integration: claude');
    expect(r.output).toContain('Installing integration: gemini');
    expect(r.output).toContain("Switched to integration 'Gemini CLI'");
    for (const rel of claudeFiles) expect(existsSync(join(project, rel))).toBe(false);
    expect(existsSync(join(project, '.specify', 'integrations', 'claude.manifest.json'))).toBe(false);
    expect(state()['installed_integrations']).toEqual(['gemini']);
    expect(state()['default_integration']).toBe('gemini');
  });

  test('switch to an already-installed target just changes the default', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    await run(['install', 'gemini']);
    const r = await run(['switch', 'gemini']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('Default integration set to gemini.');
    expect(state()['installed_integrations']).toEqual(['claude', 'gemini']);
  });

  test('switch preserves customized shared infra unless --refresh-shared-infra', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const common = join(project, '.specify', 'scripts', 'bash', 'common.sh');
    writeFileSync(common, '# customized\n');
    let r = await run(['switch', 'gemini']);
    expect(r.code).toBe(0);
    expect(readFileSync(common, 'utf-8')).toBe('# customized\n');
    expect(r.output).toContain('Preserved');
    expect(r.output).toContain('--refresh-shared-infra');
    r = await run(['switch', 'claude', '--refresh-shared-infra']);
    expect(r.code).toBe(0);
    expect(readFileSync(common, 'utf-8')).not.toBe('# customized\n');
  });

  test('switch from nothing installs the target', async () => {
    const r = await run(['switch', 'claude', '--script', 'sh']);
    expect(r.code).toBe(0);
    expect(state()['default_integration']).toBe('claude');
  });

  test('installed default without manifest refuses to switch', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    rmSync(join(project, '.specify', 'integrations', 'claude.manifest.json'));
    const r = await run(['switch', 'gemini']);
    expect(r.code).toBe(1);
    expect(r.output).toContain("Error: Integration 'claude' is installed but has no manifest.");
  });
});

// ============================================================================
// upgrade
// ============================================================================

describe('integration upgrade', () => {
  test('no integration installed', async () => {
    const r = await run(['upgrade']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('No integration is currently installed.');
  });

  test('succeeds and refreshes version', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const r = await run(['upgrade']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('Upgrading integration: claude');
    expect(r.output).toContain("Integration 'Claude Code' upgraded successfully");
  });

  test('blocks on modified files unless --force', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const rel = Object.keys(manifestFiles('claude'))[0];
    writeFileSync(join(project, rel), 'edited\n');
    let r = await run(['upgrade', 'claude']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('1 file(s) have been modified since installation:');
    expect(r.output).toContain('Use --force to overwrite modified files, or resolve manually.');
    r = await run(['upgrade', 'claude', '--force']);
    expect(r.code).toBe(0);
    expect(readFileSync(join(project, rel), 'utf-8')).not.toBe('edited\n');
  });

  test('removes stale files but keeps the new manifest', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const mpath = join(project, '.specify', 'integrations', 'claude.manifest.json');
    const data = readJson(mpath);
    const staleRel = '.claude/skills/speckit-obsolete/SKILL.md';
    mkdirSync(join(project, '.claude', 'skills', 'speckit-obsolete'), { recursive: true });
    writeFileSync(join(project, staleRel), 'old');
    // Real hash so the stale file counts as unmodified.
    const { createHash } = await import('node:crypto');
    (data['files'] as Record<string, string>)[staleRel] = createHash('sha256').update('old').digest('hex');
    writeFileSync(mpath, JSON.stringify(data));
    const r = await run(['upgrade']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('Removed 1 stale file(s) from previous install');
    expect(existsSync(join(project, staleRel))).toBe(false);
    expect(existsSync(mpath)).toBe(true);
    expect(staleRel in manifestFiles('claude')).toBe(false);
  });

  test('wrong key / unreadable manifest', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    let r = await run(['upgrade', 'gemini']);
    expect(r.code).toBe(1);
    expect(r.output).toContain("Error: Integration 'gemini' is not installed.");
    writeFileSync(join(project, '.specify', 'integrations', 'claude.manifest.json'), '{bad');
    r = await run(['upgrade']);
    expect(r.code).toBe(1);
    expect(r.output).toContain("Error: Integration manifest for 'claude' is unreadable:");
  });

  test.skipIf(IS_WINDOWS)('restores executable bit on shared scripts', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const { chmodSync } = await import('node:fs');
    const common = join(project, '.specify', 'scripts', 'bash', 'common.sh');
    chmodSync(common, 0o644);
    const r = await run(['upgrade']);
    expect(r.code).toBe(0);
    expect(statSync(common).mode & 0o100).not.toBe(0);
  });
});

// ============================================================================
// status
// ============================================================================

describe('integration status', () => {
  test('healthy project', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const r = await run(['status']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('Integration status: OK');
    expect(r.output).toContain('Default integration: claude');
    expect(r.output).toContain('Installed integrations: claude');
    expect(r.output).toContain('Multi-install safe: yes');
    expect(r.output).toContain('Shared templates target alignment: claude');
    expect(r.output).toContain('Modified managed files: 0');
  });

  test('json output', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const r = await run(['status', '--json']);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.output);
    expect(report.status).toBe('ok');
    expect(report.default_integration).toBe('claude');
    expect(report.manifest_checked_integrations).toEqual(['claude', 'speckit']);
    expect(report.manifests.speckit.readable).toBe(true);
    expect(report.findings).toEqual([]);
  });

  test('missing integration.json is an error', async () => {
    const r = await run(['status', '--json']);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.output);
    expect(report.status).toBe('error');
    expect(report.multi_install_safe).toBeNull();
    expect(report.findings[0].code).toBe('integration-state-missing');
  });

  test('invalid JSON and newer schema', async () => {
    writeFileSync(join(project, '.specify', 'integration.json'), '{bad');
    let r = await run(['status']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('Integration status: ERROR');
    expect(r.output).toContain('integration-state-unreadable');
    writeFileSync(join(project, '.specify', 'integration.json'), JSON.stringify({ integration_state_schema: 7 }));
    r = await run(['status', '--json']);
    const report = JSON.parse(r.output);
    expect(report.findings[0].message).toContain('uses integration state schema 7');
    expect(report.findings[0].message).toContain('supported schema: 1');
  });

  test('modified files warn; missing files and manifest error', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const rels = Object.keys(manifestFiles('claude'));
    writeFileSync(join(project, rels[0]), 'changed');
    let r = await run(['status', '--json']);
    let report = JSON.parse(r.output);
    expect(r.code).toBe(0);
    expect(report.status).toBe('warning');
    expect(report.modified_managed_files).toBe(1);
    expect(report.findings.map((f: { code: string }) => f.code)).toContain('managed-files-modified');

    rmSync(join(project, rels[1]));
    r = await run(['status', '--json']);
    report = JSON.parse(r.output);
    expect(r.code).toBe(1);
    expect(report.missing_managed_files).toBe(1);

    rmSync(join(project, '.specify', 'integrations', 'claude.manifest.json'));
    r = await run(['status', '--json']);
    report = JSON.parse(r.output);
    const missing = report.findings.find((f: { code: string }) => f.code === 'manifest-missing');
    expect(missing.message).toBe("Manifest for integration 'claude' is missing.");
    expect(missing.suggestion).toBe('Run `specify integration upgrade claude` or reinstall the integration.');
    expect(report.unchecked_manifests).toBe(1);
  });

  test('unsafe multi-install and unknown integrations', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    await run(['install', 'copilot', '--force']);
    let r = await run(['status', '--json']);
    let report = JSON.parse(r.output);
    expect(report.multi_install_safe).toBe(false);
    const unsafe = report.findings.find((f: { code: string }) => f.code === 'unsafe-multi-install');
    expect(unsafe.message).toBe('Installed integrations are not all declared multi-install safe: copilot');

    const s = state();
    s['installed_integrations'] = ['claude', 'mystery'];
    writeFileSync(join(project, '.specify', 'integration.json'), JSON.stringify(s));
    r = await run(['status', '--json']);
    report = JSON.parse(r.output);
    const codes = report.findings.map((f: { code: string }) => f.code);
    expect(codes).toContain('unknown-integration');
    expect(codes).toContain('unsafe-multi-install');
  });

  test('rejects unsafe integration keys before manifest lookup', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const s = state();
    s['installed_integrations'] = ['claude', '../evil', 'CON'];
    writeFileSync(join(project, '.specify', 'integration.json'), JSON.stringify(s));
    const r = await run(['status', '--json']);
    const report = JSON.parse(r.output);
    const invalid = report.findings.filter((f: { code: string }) => f.code === 'integration-key-invalid');
    expect(invalid.map((f: { message: string }) => f.message)).toEqual([
      "Integration key '../evil' cannot be used as a manifest filename.",
      "Integration key 'CON' cannot be used as a manifest filename.",
    ]);
    expect(report.manifest_checked_integrations).toEqual(['claude', 'speckit']);
  });

  test('default not installed / missing default', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const s = state();
    s['default_integration'] = 'gemini';
    s['integration'] = 'gemini';
    writeFileSync(join(project, '.specify', 'integration.json'), JSON.stringify(s));
    let r = await run(['status', '--json']);
    let report = JSON.parse(r.output);
    expect(report.findings.map((f: { code: string }) => f.code)).toContain('default-integration-not-installed');
    expect(report.manifest_checked_integrations).toEqual(['claude', 'speckit']);

    delete s['default_integration'];
    delete s['integration'];
    writeFileSync(join(project, '.specify', 'integration.json'), JSON.stringify(s));
    r = await run(['status', '--json']);
    report = JSON.parse(r.output);
    expect(report.default_integration).toBeNull();
    expect(report.findings.map((f: { code: string }) => f.code)).toContain('default-integration-missing');
  });

  test.skipIf(IS_WINDOWS)('dangling in-project symlink is missing; escaping symlink is invalid', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const rels = Object.keys(manifestFiles('claude'));
    rmSync(join(project, rels[0]));
    symlinkSync(join(project, 'does-not-exist'), join(project, rels[0]));
    rmSync(join(project, rels[1]));
    const outside = join(tmp, 'outside.txt');
    writeFileSync(outside, 'x');
    symlinkSync(outside, join(project, rels[1]));
    const r = await run(['status', '--json']);
    const report = JSON.parse(r.output);
    expect(report.manifests.claude.missing_files).toEqual([rels[0]]);
    expect(report.manifests.claude.invalid_files).toEqual([rels[1]]);
  });

  test('text output escapes rich markup from project state', async () => {
    writeFileSync(
      join(project, '.specify', 'integration.json'),
      JSON.stringify({ integration: '[red]x[/red]', installed_integrations: ['[red]x[/red]'] }),
    );
    const r = await run(['status']);
    expect(r.output).toContain('Default integration: [red]x[/red]');
  });
});

// ============================================================================
// list / search / info / catalog
// ============================================================================

const CATALOG_URL = 'https://example.com/integrations/catalog.json';
const CATALOG = {
  schema_version: '1.0',
  updated_at: '2026-01-01T00:00:00Z',
  integrations: {
    claude: { id: 'claude', name: 'Claude Code', version: '1.0.0', description: 'Anthropic', author: 'spec-kit', tags: ['cli'] },
    'my-agent': { id: 'my-agent', name: 'My Agent', version: '0.1.0', description: 'Community agent', author: 'someone', tags: ['community'] },
  },
};

function mockFetch(body: unknown, status = 200): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

describe('integration list / search / info', () => {
  test('list shows registry and installed status', async () => {
    await run(['install', 'claude', '--script', 'sh']);
    const r = await run(['list']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('Coding Agent Integrations');
    expect(r.output).toMatch(/claude\s+│\s+Claude Code\s+│\s+installed/);
    expect(r.output).toContain('(default)');
    expect(r.output).toContain('gemini');
    expect(r.output).toContain('Default integration: claude');
  });

  test('list with nothing installed', async () => {
    const r = await run(['list']);
    expect(r.output).toContain('No integration currently installed.');
    expect(r.output).toContain('Install one with: specify integration install <key>');
  });

  test('search uses the catalog and marks built-ins', async () => {
    process.env.SPECKIT_INTEGRATION_CATALOG_URL = CATALOG_URL;
    const restore = mockFetch(CATALOG);
    try {
      await run(['install', 'claude', '--script', 'sh']);
      const r = await run(['search']);
      expect(r.code).toBe(0);
      expect(r.output).toContain('Found 2 integration(s):');
      expect(r.output).toContain('Claude Code (claude) v1.0.0');
      expect(r.output).toContain('✓ Installed (currently active)');
      expect(r.output).toContain("Only built-in integration IDs can be installed with 'specify integration install'.");
      const none = await run(['search', 'zzz-nothing']);
      expect(none.output).toContain('No integrations found matching criteria');
      expect(none.output).toContain('Broader search terms');
    } finally {
      restore();
    }
  });

  test('search reports catalog failures with env tip', async () => {
    process.env.SPECKIT_INTEGRATION_CATALOG_URL = CATALOG_URL;
    const restore = mockFetch('nope', 500);
    try {
      const r = await run(['search']);
      expect(r.code).toBe(1);
      expect(r.output).toContain('Error:');
      expect(r.output).toContain('Tip: Check the SPECKIT_INTEGRATION_CATALOG_URL environment variable');
    } finally {
      restore();
    }
  });

  test('info from catalog, built-in fallback, and not found', async () => {
    process.env.SPECKIT_INTEGRATION_CATALOG_URL = CATALOG_URL;
    const restore = mockFetch(CATALOG);
    try {
      let r = await run(['info', 'my-agent']);
      expect(r.code).toBe(0);
      expect(r.output).toContain('My Agent (my-agent) v0.1.0');
      expect(r.output).toContain('Author: someone');
      r = await run(['info', 'gemini']);
      expect(r.code).toBe(0);
      expect(r.output).toContain('Built-in integration (not listed in catalog)');
      r = await run(['info', 'ghost']);
      expect(r.code).toBe(1);
      expect(r.output).toContain("Error: Integration 'ghost' not found");
      expect(r.output).toContain('Try: specify integration search');
    } finally {
      restore();
    }
  });

  test('info reports catalog errors for unknown ids', async () => {
    process.env.SPECKIT_INTEGRATION_CATALOG_URL = CATALOG_URL;
    const restore = mockFetch('nope', 500);
    try {
      const r = await run(['info', 'ghost']);
      expect(r.code).toBe(1);
      expect(r.output).toContain('Error: Could not query integration catalog:');
      expect(r.output).toContain('Check whether SPECKIT_INTEGRATION_CATALOG_URL is set correctly');
    } finally {
      restore();
    }
  });
});

describe('integration catalog', () => {
  test('list with no project config shows defaults', async () => {
    const r = await run(['catalog', 'list']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('Integration Catalog Sources:');
    expect(r.output).toContain('No project-level catalog sources configured.');
  });

  test('add is idempotent, list and remove by index', async () => {
    let r = await run(['catalog', 'add', ' https://example.com/c.json ', '--name', 'mine']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('✓ Catalog source added: https://example.com/c.json');
    r = await run(['catalog', 'add', 'https://example.com/c.json']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('✓ Catalog source already configured: https://example.com/c.json');
    r = await run(['catalog', 'list']);
    expect(r.output).toContain('Project catalog sources (removable):');
    expect(r.output).toContain('[0] mine');
    r = await run(['catalog', 'remove', '0']);
    expect(r.code).toBe(0);
    expect(r.output).toContain("✓ Catalog source 'mine' removed");
  });

  test('add rejects non-https URLs', async () => {
    const r = await run(['catalog', 'add', 'http://example.com/c.json']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('Error:');
  });

  test('env override supersedes project catalogs', async () => {
    process.env.SPECKIT_INTEGRATION_CATALOG_URL = CATALOG_URL;
    const r = await run(['catalog', 'list']);
    expect(r.output).toContain('SPECKIT_INTEGRATION_CATALOG_URL is set; it supersedes configured catalog files.');
    expect(r.output).toContain(CATALOG_URL);
  });

  test('remove invalid index', async () => {
    const r = await run(['catalog', 'remove', '5']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('Error:');
  });
});

// ============================================================================
// scaffold
// ============================================================================

function makeRepoRoot(): string {
  const root = join(tmp, 'spec-kit');
  mkdirSync(join(root, 'src', 'integrations'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"@oakoliver/specify-cli"}');
  writeFileSync(join(root, 'src', 'index.ts'), '');
  writeFileSync(join(root, 'src', 'integrations', 'index.ts'), '');
  return root;
}

describe('integration scaffold', () => {
  test('creates markdown files via CLI', async () => {
    const root = makeRepoRoot();
    const r = await run(['scaffold', 'my-agent', '--type', 'markdown'], root);
    expect(r.code).toBe(0);
    expect(r.output).toContain('Created integration scaffold: my-agent');
    expect(r.output).toContain('Register MyAgentIntegration');
    expect(r.output).toContain('  src/integrations/my-agent.ts');
    expect(r.output).toContain('  tests/integration-my-agent.test.ts');
    const content = readFileSync(join(root, 'src', 'integrations', 'my-agent.ts'), 'utf-8');
    expect(content).toContain('export class MyAgentIntegration extends MarkdownIntegration {');
    expect(content).toContain("key = 'my-agent';");
    expect(content).toContain("folder: '.my-agent/',");
    expect(content).toContain("extension: '.md',");
    expect(content).toContain('multiInstallSafe = false;');
    const testContent = readFileSync(join(root, 'tests', 'integration-my-agent.test.ts'), 'utf-8');
    expect(testContent).toContain("import { MyAgentIntegration } from '../src/integrations/my-agent.js';");
    expect(testContent).toContain("expect(integration.registrarConfig?.dir).toBe('.my-agent/commands');");
  });

  test('rejects unknown type with a usage error', async () => {
    const root = makeRepoRoot();
    const r = await run(['scaffold', 'my-agent', '--type', 'xml'], root);
    expect(r.code).toBe(2);
    expect(r.output).toContain("Invalid value for '--type'");
    expect(existsSync(join(root, 'src', 'integrations', 'my-agent.ts'))).toBe(false);
  });

  test('accepts uppercase type', async () => {
    const root = makeRepoRoot();
    const r = await run(['scaffold', 'my-agent', '--type', 'YAML'], root);
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, 'src', 'integrations', 'my-agent.ts'), 'utf-8')).toContain(
      'extends YamlIntegration',
    );
  });

  test.each([
    ['markdown', 'MarkdownIntegration', 'commands', '$ARGUMENTS', '.md'],
    ['toml', 'TomlIntegration', 'commands', '{{args}}', '.toml'],
    ['yaml', 'YamlIntegration', 'recipes', '{{args}}', '.yaml'],
    ['skills', 'SkillsIntegration', 'skills', '$ARGUMENTS', '/SKILL.md'],
  ])('type template %s', (type, base, subdir, args, ext) => {
    const root = makeRepoRoot();
    const result = scaffoldIntegration(root, `${type}-agent`, type);
    const content = readFileSync(result.integrationFile, 'utf-8');
    expect(content).toContain(`class ${result.className} extends ${base} {`);
    expect(content).toContain(`commands_subdir: '${subdir}',`);
    expect(content).toContain(`args: '${args}',`);
    expect(content).toContain(`extension: '${ext}',`);
  });

  test('validation errors', () => {
    const root = makeRepoRoot();
    expect(() => scaffoldIntegration(root, 'Bad_Key', 'markdown')).toThrow('lowercase kebab-case');
    expect(() => scaffoldIntegration(root, 'my-agent', ' XML ')).toThrow("Unsupported integration type 'xml'");
    scaffoldIntegration(root, 'my-agent', 'markdown');
    expect(() => scaffoldIntegration(root, 'my-agent', 'markdown')).toThrow('Refusing to overwrite');
    expect(() => scaffoldIntegration(tmp, 'other', 'markdown')).toThrow('Spec Kit repository root');
  });

  test('rolls back partial files on write failure', () => {
    const root = makeRepoRoot();
    const orig = scaffoldFs.writeFile;
    scaffoldFs.writeFile = (path: string, content: string): void => {
      if (path.endsWith('.test.ts')) throw new Error('simulated test file write failure');
      orig(path, content);
    };
    try {
      expect(() => scaffoldIntegration(root, 'my-agent', 'markdown')).toThrow('simulated test file write failure');
    } finally {
      scaffoldFs.writeFile = orig;
    }
    expect(existsSync(join(root, 'src', 'integrations', 'my-agent.ts'))).toBe(false);
  });

  test.skipIf(IS_WINDOWS)('refuses symlinked target directory', () => {
    const root = makeRepoRoot();
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'index.ts'), '');
    rmSync(join(root, 'src', 'integrations'), { recursive: true });
    symlinkSync(outside, join(root, 'src', 'integrations'));
    expect(() => scaffoldIntegration(root, 'my-agent', 'markdown')).toThrow('symlinked path');
    expect(existsSync(join(outside, 'my-agent.ts'))).toBe(false);
  });
});

// ============================================================================
// upgrade layout guards
// ============================================================================

describe('upgrade layout guards', () => {
  test('manifest helpers', () => {
    expect(manifestTracksSkillLayout({ files: { '.x/skills/speckit-a/SKILL.md': 'h' } })).toBe(true);
    expect(manifestTracksSkillLayout({ files: { '.x/commands/a.md': 'h' } })).toBe(false);
    expect(manifestPathUnder('.kilocode/workflows/a.md', '.kilocode/workflows/')).toBe(true);
    expect(manifestPathUnder('.kilocode/workflowsx/a.md', '.kilocode/workflows')).toBe(false);
    expect(manifestPathUnder('a', '')).toBe(false);
  });

  test('installed presets affecting agent fails closed', () => {
    expect(installedPresetsAffectingAgent(project, 'claude')).toEqual([]);
    const reg = join(project, '.specify', 'presets', '.registry');
    mkdirSync(join(project, '.specify', 'presets'), { recursive: true });
    writeFileSync(
      reg,
      JSON.stringify({
        presets: {
          a: { registered_commands: { claude: ['x'] } },
          b: { registered_commands: {}, registered_skills: { claude: ['s'] } },
          c: { registered_commands: {}, registered_skills: ['legacy'] },
          d: { registered_commands: { gemini: ['x'] } },
        },
      }),
    );
    expect(installedPresetsAffectingAgent(project, 'claude')).toEqual(['a', 'b', 'c']);
    expect(installedPresetsAffectingAgent(project, 'claude', { includeSkills: false })).toEqual(['a']);
    writeFileSync(reg, '{bad');
    expect(() => installedPresetsAffectingAgent(project, 'claude')).toThrow(PresetRegistryUnreadableError);
    writeFileSync(reg, JSON.stringify({ presets: { a: { registered_skills: null } } }));
    expect(() => installedPresetsAffectingAgent(project, 'claude')).toThrow("preset 'a' registered_skills is malformed");
  });
});
