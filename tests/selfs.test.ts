/**
 * Tests for `specify self check` / `specify self upgrade`
 * (ports of upstream tests/specify_cli/selfs/*, test_version_guidance.py,
 * test_version_execution.py, test_version_verification.py and the
 * end-to-end parts of test_version_detection.py, adapted to npm).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSelfCommand } from '../src/selfs/commands.js';
import { resetVersionDeps, versionDeps } from '../src/version.js';
import type { SpawnOptions, SpawnResult } from '../src/version.js';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function captureOutput(): { text: () => string; restore: () => void } {
  let buf = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origLog = globalThis.console.log;
  const origErrLog = globalThis.console.error;
  const sink = (chunk: unknown): boolean => {
    buf += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  globalThis.console.log = (...a: unknown[]) => {
    buf += a.map(String).join(' ') + '\n';
  };
  globalThis.console.error = globalThis.console.log;
  return {
    text: () => buf.replace(ANSI, ''),
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      globalThis.console.log = origLog;
      globalThis.console.error = origErrLog;
    },
  };
}

const NPM_ARGV0 = '/usr/local/lib/node_modules/@oakoliver/specify-cli/dist/cli.js';
const BUN_ARGV0 = '/home/u/.bun/install/global/node_modules/@oakoliver/specify-cli/dist/cli.js';
const NPX_ARGV0 = '/home/u/.npm/_npx/abc/node_modules/@oakoliver/specify-cli/dist/cli.js';
const UNSUPPORTED_ARGV0 = '/opt/custom/specify-cli/dist/cli.js';

const SENTINEL_GH_TOKEN = 'SENTINEL-GH-TOKEN-VALUE';
const SENTINEL_GITHUB_TOKEN = 'SENTINEL-GITHUB-TOKEN-VALUE';

let out: ReturnType<typeof captureOutput>;
let spawnCalls: Array<{ argv: string[]; opts: SpawnOptions }>;
let tmp: string;

function setSpawn(fn: (argv: string[], opts: SpawnOptions) => SpawnResult): void {
  versionDeps.spawn = (argv, opts) => {
    spawnCalls.push({ argv, opts });
    return fn(argv, opts);
  };
}

function useArgv0(p: string): void {
  versionDeps.argv0 = () => p;
}

function latest(tag: string | null, reason: string | null = null): void {
  versionDeps.fetchLatestReleaseTag = async () => [tag, reason];
}

function noNetwork(): void {
  versionDeps.fetchLatestReleaseTag = async () => {
    throw new Error('network must not be used');
  };
  versionDeps.fetch = async () => {
    throw new Error('network must not be used');
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'specify-selfs-'));
  spawnCalls = [];
  versionDeps.editableMarkerSeen = () => false;
  versionDeps.sourceCheckoutPath = () => null;
  versionDeps.platform = () => 'linux';
  versionDeps.env = () => ({ PATH: '/usr/bin' });
  versionDeps.which = (n) => (n === 'npm' || n === 'bun' ? n : null);
  setSpawn(() => {
    throw new Error('unexpected spawn');
  });
  out = captureOutput();
});

afterEach(() => {
  out.restore();
  resetVersionDeps();
  rmSync(tmp, { recursive: true, force: true });
});

// ============================================================================
// specify self check
// ============================================================================

describe('self check', () => {
  test('newer available prints update and install command', async () => {
    versionDeps.getInstalledVersion = () => '0.7.4';
    latest('v0.9.0');
    expect(await runSelfCommand(['check'])).toBe(0);
    const t = out.text();
    expect(t).toContain('Update available');
    expect(t).toContain('0.7.4');
    expect(t).toContain('0.9.0');
    expect(t).toContain('npm install --global @oakoliver/specify-cli@0.9.0');
    expect(t).toContain('specify self upgrade');
  });

  test('up to date prints current only', async () => {
    versionDeps.getInstalledVersion = () => '0.9.0';
    latest('v0.9.0');
    expect(await runSelfCommand(['check'])).toBe(0);
    const t = out.text();
    expect(t).toContain('Up to date: 0.9.0');
    expect(t).not.toContain('Update available');
    expect(t).not.toContain('npm install');
  });

  test('dev build ahead of release is up to date', async () => {
    versionDeps.getInstalledVersion = () => '0.7.5.dev0';
    latest('v0.7.4');
    await runSelfCommand(['check']);
    expect(out.text()).toContain('Up to date');
    expect(out.text()).not.toContain('Update available');
  });

  test('unknown installed still prints latest and reinstall', async () => {
    versionDeps.getInstalledVersion = () => 'unknown';
    latest('v0.7.4');
    expect(await runSelfCommand(['check'])).toBe(0);
    const t = out.text();
    expect(t).toContain('Current version could not be determined');
    expect(t).toContain('Latest release: v0.7.4');
    expect(t).toContain('npm install --global @oakoliver/specify-cli@0.7.4');
    expect(t).toContain('bun add --global @oakoliver/specify-cli@0.7.4');
    expect(t).toContain('specify self upgrade');
  });

  test('invalid latest tag uses placeholder and never echoes raw tag', async () => {
    versionDeps.getInstalledVersion = () => 'unknown';
    latest('v0.9.0;echo unsafe');
    expect(await runSelfCommand(['check'])).toBe(0);
    const t = out.text();
    expect(t).toContain('Latest release: vX.Y.Z');
    expect(t).toContain('Could not validate latest release tag');
    expect(t).toContain('@oakoliver/specify-cli@latest');
    expect(t).not.toContain('v0.9.0;echo unsafe');
  });

  test('unparseable tag reports validation failure without raw tag', async () => {
    versionDeps.getInstalledVersion = () => '0.7.4';
    latest('not-a-version');
    expect(await runSelfCommand(['check'])).toBe(0);
    const t = out.text();
    expect(t).not.toContain('Update available');
    expect(t).not.toContain('Up to date');
    expect(t).toContain('Latest release: vX.Y.Z');
    expect(t).toContain('Installed: 0.7.4');
    expect(t).not.toContain('not-a-version');
  });

  test.each([
    ['offline or timeout', async () => Promise.reject(new TypeError('fetch failed'))],
    ['rate limited', async () => new Response('', { status: 403 })],
    ['HTTP 500', async () => new Response('', { status: 500 })],
  ] as const)('failure %s prints installed plus one-line reason, exit 0, no url/token', async (reason, impl) => {
    versionDeps.env = () => ({ GH_TOKEN: SENTINEL_GH_TOKEN, GITHUB_TOKEN: SENTINEL_GITHUB_TOKEN });
    versionDeps.getInstalledVersion = () => '0.7.4';
    versionDeps.fetch = impl as () => Promise<Response>;
    expect(await runSelfCommand(['check'])).toBe(0);
    const t = out.text();
    expect(t).toContain('Installed: 0.7.4');
    expect(t).toContain(`Could not check latest release: ${reason}`);
    expect(t).not.toContain('registry.npmjs.org');
    expect(t).not.toContain('Traceback');
    expect(t).not.toContain(SENTINEL_GH_TOKEN);
    expect(t).not.toContain(SENTINEL_GITHUB_TOKEN);
  });
});

// ============================================================================
// specify self upgrade — tag validation / dry run
// ============================================================================

describe('self upgrade --tag / --dry-run', () => {
  beforeEach(() => {
    useArgv0(NPM_ARGV0);
    versionDeps.getInstalledVersion = () => '0.7.5';
    noNetwork();
  });

  test.each([
    ['v0.7.6', 'v0.7.6'],
    ['v0.8.0.dev0', 'v0.8.0.dev0'],
    ['v1.0.0-rc1', 'v1.0.0-rc1'],
    ['v0.8.0+build.42', 'v0.8.0+build.42'],
    ['V0.7.6', 'v0.7.6'],
    ['v1.0.0-rc1+build.42', 'v1.0.0-rc1+build.42'],
  ])('valid tag %s', async (tag, shown) => {
    expect(await runSelfCommand(['upgrade', '--dry-run', '--tag', tag])).toBe(0);
    const t = out.text();
    expect(t).toContain('Dry run — no changes will be made.');
    expect(t).toContain(`Target version: ${shown}`);
    expect(t).toContain('Detected install method: npm (global)');
    expect(spawnCalls).toHaveLength(0);
  });

  test('--tag=VALUE form', async () => {
    expect(await runSelfCommand(['upgrade', '--dry-run', '--tag=v0.7.6'])).toBe(0);
    expect(out.text()).toContain('npm install --global @oakoliver/specify-cli@0.7.6');
  });

  test('beta dot tag uses PEP 440 equivalent for no-op', async () => {
    versionDeps.getInstalledVersion = () => '1.0.0b1';
    expect(await runSelfCommand(['upgrade', '--tag', 'v1.0.0-beta.1'])).toBe(0);
    expect(out.text()).toContain('Already on requested release: v1.0.0-beta.1');
  });

  test.each(['latest', '0.7.5', 'main', 'v7', '', 'v1.2.3abc', 'v1.2.3...', 'v1.2.3++', 'v１.2.3', 'v1.٢.3'])(
    'invalid tag %p rejected with exit 1',
    async (bad) => {
      expect(await runSelfCommand(['upgrade', '--tag', bad])).toBe(1);
      expect(out.text()).toContain('expected vMAJOR.MINOR.PATCH[suffix]');
    },
  );

  test('help keeps the [suffix] token', async () => {
    expect(await runSelfCommand(['upgrade', '--help'])).toBe(0);
    expect(out.text()).toContain('[suffix]');
  });

  test('dry run without tag resolves network but no subprocess', async () => {
    latest('v0.7.6');
    expect(await runSelfCommand(['upgrade', '--dry-run'])).toBe(0);
    const t = out.text();
    expect(t).toContain('Target version: v0.7.6');
    expect(t).toContain('Command that would be executed: npm install --global @oakoliver/specify-cli@0.7.6');
    expect(spawnCalls).toHaveLength(0);
  });

  test('dry run rejects unparseable network tag before preview', async () => {
    latest('garbage');
    expect(await runSelfCommand(['upgrade', '--dry-run'])).toBe(1);
    const t = out.text();
    expect(t).toContain('Upgrade aborted: resolved release tag is not a comparable version.');
    expect(t).not.toContain('Dry run');
  });

  test('dry run with missing installer flags unresolved installer', async () => {
    versionDeps.which = () => null;
    expect(await runSelfCommand(['upgrade', '--dry-run', '--tag', 'v0.7.6'])).toBe(0);
    expect(out.text()).toContain('(installer npm not found on PATH)');
  });

  test('unknown option is a usage error', async () => {
    expect(await runSelfCommand(['upgrade', '--bogus'])).toBe(2);
    expect(out.text()).toContain('No such option: --bogus');
  });
});

// ============================================================================
// Guidance for non-upgradable paths (test_version_guidance.py)
// ============================================================================

describe('non-upgradable guidance', () => {
  test('npx ephemeral prints one-liner, no network, no subprocess', async () => {
    useArgv0(NPX_ARGV0);
    noNetwork();
    expect(await runSelfCommand(['upgrade'])).toBe(0);
    expect(out.text()).toContain('Running via npx (ephemeral)');
    expect(out.text()).toContain('no upgrade action needed.');
    expect(spawnCalls).toHaveLength(0);
  });

  test('dry run on npx emits guidance not preview', async () => {
    useArgv0(NPX_ARGV0);
    noNetwork();
    expect(await runSelfCommand(['upgrade', '--dry-run'])).toBe(0);
    expect(out.text()).not.toContain('Dry run — no changes will be made.');
    expect(out.text()).toContain('npx (ephemeral)');
  });

  test('source checkout prints git pull guidance', async () => {
    useArgv0(UNSUPPORTED_ARGV0);
    noNetwork();
    versionDeps.editableMarkerSeen = () => true;
    versionDeps.sourceCheckoutPath = () => tmp;
    expect(await runSelfCommand(['upgrade'])).toBe(0);
    const t = out.text();
    expect(t).toContain(`Running from a source checkout at ${tmp}`);
    expect(t).toContain('git pull');
    expect(t).toContain('npm install');
    expect(spawnCalls).toHaveLength(0);
  });

  test('source checkout without path mentions checkout directory', async () => {
    useArgv0(UNSUPPORTED_ARGV0);
    noNetwork();
    versionDeps.editableMarkerSeen = () => true;
    expect(await runSelfCommand(['upgrade'])).toBe(0);
    expect(out.text()).toContain('checkout path could not be detected');
    expect(out.text()).toContain('from your checkout directory');
  });

  test('unsupported prints manual commands without network', async () => {
    useArgv0(UNSUPPORTED_ARGV0);
    noNetwork();
    versionDeps.which = () => null;
    expect(await runSelfCommand(['upgrade'])).toBe(0);
    const t = out.text();
    expect(t).toContain('Could not identify your install method automatically');
    expect(t).toContain('npm install --global @oakoliver/specify-cli@latest');
    expect(t).toContain('bun add --global @oakoliver/specify-cli@latest');
    expect(spawnCalls).toHaveLength(0);
  });
});

// ============================================================================
// Execution (test_version_execution.py / test_version_detection.py e2e)
// ============================================================================

describe('self upgrade execution', () => {
  beforeEach(() => {
    useArgv0(NPM_ARGV0);
    versionDeps.getInstalledVersion = () => '0.7.5';
    latest('v0.7.6');
  });

  const ok = (stdout = ''): SpawnResult => ({ status: 0, stdout, errorCode: null });

  test('happy path runs installer then verifies', async () => {
    versionDeps.which = (n) => (n === 'npm' ? 'npm' : n === 'specify' ? '/usr/local/bin/specify' : null);
    setSpawn((argv) => (argv[1] === '--version' ? ok('specify 0.7.6\n') : ok()));
    expect(await runSelfCommand(['upgrade'])).toBe(0);
    const t = out.text();
    expect(t).toContain(
      'Upgrading @oakoliver/specify-cli 0.7.5 → v0.7.6 via npm (global): npm install --global @oakoliver/specify-cli@0.7.6',
    );
    expect(t).toContain('Upgraded @oakoliver/specify-cli: 0.7.5 → 0.7.6');
    expect(spawnCalls[0].argv).toEqual(['npm', 'install', '--global', '@oakoliver/specify-cli@0.7.6']);
    expect(spawnCalls[0].opts.capture).toBe(false);
    expect(spawnCalls[1].argv).toEqual(['/usr/local/bin/specify', '--version']);
  });

  test('bun global uses bun add --global', async () => {
    useArgv0(BUN_ARGV0);
    versionDeps.which = (n) => (n === 'bun' ? 'bun' : n === 'specify' ? '/usr/bin/specify' : null);
    setSpawn((argv) => (argv[1] === '--version' ? ok('specify v0.7.6') : ok()));
    expect(await runSelfCommand(['upgrade'])).toBe(0);
    expect(spawnCalls[0].argv).toEqual(['bun', 'add', '--global', '@oakoliver/specify-cli@0.7.6']);
  });

  test('already latest exits zero with no subprocess', async () => {
    versionDeps.getInstalledVersion = () => '0.7.6';
    expect(await runSelfCommand(['upgrade'])).toBe(0);
    expect(out.text()).toContain('Already on latest release: v0.7.6');
    expect(spawnCalls).toHaveLength(0);
  });

  test('trailing-zero equivalent reports latest', async () => {
    versionDeps.getInstalledVersion = () => '0.7.6.0';
    expect(await runSelfCommand(['upgrade'])).toBe(0);
    expect(out.text()).toContain('Already on latest release: v0.7.6');
  });

  test('dev build ahead reports newer no-op', async () => {
    versionDeps.getInstalledVersion = () => '0.7.7.dev0';
    expect(await runSelfCommand(['upgrade'])).toBe(0);
    expect(out.text()).toContain('Already on latest release or newer: 0.7.7.dev0');
  });

  test('pinned older tag still runs installer (downgrade)', async () => {
    versionDeps.getInstalledVersion = () => '0.7.6';
    versionDeps.which = (n) => (n === 'npm' ? 'npm' : n === 'specify' ? '/usr/bin/specify' : null);
    setSpawn((argv) => (argv[1] === '--version' ? ok('specify 0.7.4') : ok()));
    expect(await runSelfCommand(['upgrade', '--tag', 'v0.7.4'])).toBe(0);
    expect(out.text()).toContain('Downgrading @oakoliver/specify-cli 0.7.6 → v0.7.4');
  });

  test('offline exits 1', async () => {
    latest(null, 'offline or timeout');
    expect(await runSelfCommand(['upgrade'])).toBe(1);
    expect(out.text()).toContain('Upgrade aborted: offline or timeout');
  });

  test('installer missing on PATH exits 3', async () => {
    versionDeps.which = () => null;
    expect(await runSelfCommand(['upgrade'])).toBe(3);
    expect(out.text()).toContain('Installer npm not found on PATH; reinstall it and retry.');
  });

  test('absolute installer path missing gets path-specific message', async () => {
    const gone = join(tmp, 'npm');
    versionDeps.which = (n) => (n === 'npm' ? gone : null);
    expect(await runSelfCommand(['upgrade'])).toBe(3);
    expect(out.text()).toContain(`Installer path ${gone} no longer exists`);
  });

  test('absolute installer path not executable', async () => {
    const npm = join(tmp, 'npm');
    writeFileSync(npm, '#!/bin/sh\n');
    chmodSync(npm, 0o644);
    versionDeps.which = (n) => (n === 'npm' ? npm : null);
    expect(await runSelfCommand(['upgrade'])).toBe(3);
    expect(out.text()).toContain(`Installer path ${npm} is not an executable file`);
  });

  test('exec EACCES on bare installer is invalid, not a path', async () => {
    setSpawn(() => ({ status: null, stdout: '', errorCode: 'EACCES' }));
    expect(await runSelfCommand(['upgrade'])).toBe(3);
    expect(out.text()).toContain('Installer npm is not executable; fix the command');
  });

  test.each([2, 127, 124, 126])('installer exit %d propagates with rollback hint', async (code) => {
    setSpawn(() => ({ status: code, stdout: '', errorCode: null }));
    expect(await runSelfCommand(['upgrade'])).toBe(code);
    const t = out.text();
    expect(t).toContain(`Upgrade failed. Installer exit code: ${code}.`);
    expect(t).toContain('To pin back to the previous version: npm install --global @oakoliver/specify-cli@0.7.5');
  });

  test('timeout prints timeout message and exits 124', async () => {
    versionDeps.env = () => ({ SPECIFY_UPGRADE_TIMEOUT_SECS: '1' });
    setSpawn((_argv, opts) => {
      expect(opts.timeoutMs).toBe(1000);
      return { status: null, stdout: '', errorCode: 'ETIMEDOUT' };
    });
    expect(await runSelfCommand(['upgrade'])).toBe(124);
    const t = out.text();
    expect(t).toContain('Upgrade timed out while waiting for the installer subprocess.');
    expect(t).toContain('Configured timeout: SPECIFY_UPGRADE_TIMEOUT_SECS=1');
  });

  test('non-finite timeout warns and runs without timeout', async () => {
    versionDeps.env = () => ({ SPECIFY_UPGRADE_TIMEOUT_SECS: 'inf' });
    setSpawn((_argv, opts) => {
      expect(opts.timeoutMs).toBeUndefined();
      return { status: 5, stdout: '', errorCode: null };
    });
    expect(await runSelfCommand(['upgrade'])).toBe(5);
    expect(out.text()).toContain("Ignoring invalid SPECIFY_UPGRADE_TIMEOUT_SECS='inf'; running without a timeout.");
  });

  test('prerelease snapshot degrades rollback hint to versions page', async () => {
    versionDeps.getInstalledVersion = () => '0.7.5rc1';
    setSpawn(() => ({ status: 1, stdout: '', errorCode: null }));
    expect(await runSelfCommand(['upgrade'])).toBe(1);
    expect(out.text()).toContain('Previous version was not an exact stable release tag');
  });

  test('unknown current renders literal and degrades rollback hint', async () => {
    versionDeps.getInstalledVersion = () => 'unknown';
    setSpawn(() => ({ status: 1, stdout: '', errorCode: null }));
    expect(await runSelfCommand(['upgrade'])).toBe(1);
    const t = out.text();
    expect(t).toContain('Upgrading @oakoliver/specify-cli unknown → v0.7.6');
    expect(t).toContain('Could not determine the previous version');
  });

  test('env passed to subprocesses has no GitHub tokens', async () => {
    versionDeps.env = () => ({ PATH: '/bin', GH_TOKEN: SENTINEL_GH_TOKEN, github_token: SENTINEL_GITHUB_TOKEN, NPM_TOKEN: 'n' });
    versionDeps.which = (n) => (n === 'npm' ? 'npm' : n === 'specify' ? '/usr/bin/specify' : null);
    setSpawn((argv) => (argv[1] === '--version' ? ok('specify 0.7.6') : ok()));
    expect(await runSelfCommand(['upgrade'])).toBe(0);
    for (const call of spawnCalls) {
      expect(call.opts.env.GH_TOKEN).toBeUndefined();
      expect(call.opts.env.github_token).toBeUndefined();
      expect(call.opts.env.NPM_TOKEN).toBe('n');
    }
  });
});

// ============================================================================
// Verification (test_version_verification.py)
// ============================================================================

describe('self upgrade verification', () => {
  beforeEach(() => {
    useArgv0(NPM_ARGV0);
    versionDeps.getInstalledVersion = () => '0.7.5';
    versionDeps.which = (n) => (n === 'npm' ? 'npm' : n === 'specify' ? '/usr/bin/specify' : null);
  });

  test('installer ok but verify returns old version -> exit 2', async () => {
    latest('v0.7.6');
    setSpawn((argv) => ({ status: 0, stdout: argv[1] === '--version' ? 'specify 0.7.5' : '', errorCode: null }));
    expect(await runSelfCommand(['upgrade'])).toBe(2);
    const t = out.text();
    expect(t).toContain("resolves to 0.7.5 (expected v0.7.6)");
    expect(t).toContain('The new version may take effect on your next invocation.');
  });

  test('verify non-zero exit is not success', async () => {
    latest('v0.7.6');
    setSpawn((argv) => ({ status: argv[1] === '--version' ? 1 : 0, stdout: 'specify 0.7.6', errorCode: null }));
    expect(await runSelfCommand(['upgrade'])).toBe(2);
    expect(out.text()).toContain('(unknown)');
  });

  test('verify accepts PEP 440 equivalent rc version', async () => {
    latest('v1.0.0-rc.1');
    setSpawn((argv) => ({ status: 0, stdout: argv[1] === '--version' ? 'specify 1.0.0rc1' : '', errorCode: null }));
    expect(await runSelfCommand(['upgrade'])).toBe(0);
  });

  test('verify accepts Specify-CLI capitalized binary name', async () => {
    latest('v0.7.6');
    setSpawn((argv) => ({ status: 0, stdout: argv[1] === '--version' ? 'Specify-CLI 0.7.6' : '', errorCode: null }));
    expect(await runSelfCommand(['upgrade'])).toBe(0);
  });

  test('verify rejects output without parseable version', async () => {
    latest('v0.7.6');
    setSpawn((argv) => ({ status: 0, stdout: argv[1] === '--version' ? 'hello world' : '', errorCode: null }));
    expect(await runSelfCommand(['upgrade'])).toBe(2);
  });
});

describe('self group', () => {
  test('help and unknown command', async () => {
    expect(await runSelfCommand(['--help'])).toBe(0);
    expect(out.text()).toContain('Manage the specify CLI itself');
    expect(await runSelfCommand(['nope'])).toBe(2);
    expect(await runSelfCommand([])).toBe(2);
  });
});
