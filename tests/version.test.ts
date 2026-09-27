/**
 * Tests for src/version.ts and src/command-version.ts
 * (ports of upstream tests/specify_cli/test_version_release.py,
 * test_command_version.py and the pure-helper parts of test_version_detection.py).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  BadParameter,
  InstallMethod,
  NPM_DIST_TAGS_URL,
  RESOLUTION_FAILURE_OFFLINE,
  RESOLUTION_FAILURE_RATE_LIMITED,
  UPSTREAM_SPEC_KIT_VERSION,
  Version,
  canonicalizeVersionText,
  getRuntimeInfo,
  detectInstallMethod,
  isGithubCredentialEnvKey,
  isNewer,
  listingContainsPackage,
  normalizeTag,
  parseVerifyVersionOutput,
  renderArgv,
  resetVersionDeps,
  scrubbedEnv,
  stableReleaseTagForVersion,
  validateTag,
  versionDeps,
} from '../src/version.js';
import {
  buildInfoRows,
  featureCapabilities,
  runVersionCommand,
  versionCommandDeps,
} from '../src/command-version.js';

// ============================================================================
// Output capture
// ============================================================================

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

const origFetch = globalThis.fetch;
afterEach(() => {
  resetVersionDeps();
  globalThis.fetch = origFetch;
});

// ============================================================================
// PEP 440 Version
// ============================================================================

describe('Version (PEP 440)', () => {
  test('orders pre/dev/post/local like packaging', () => {
    const order = ['1.0.0.dev0', '1.0.0a1', '1.0.0b1', '1.0.0rc1', '1.0.0', '1.0.0+local', '1.0.0.post1', '1.0.1'];
    for (let i = 0; i < order.length - 1; i++) {
      expect(new Version(order[i]).lt(new Version(order[i + 1]))).toBe(true);
    }
  });
  test('trailing zeros are equal and canonical form', () => {
    expect(new Version('1.0').equals(new Version('1.0.0'))).toBe(true);
    expect(new Version('1.0.0-beta.1').toString()).toBe('1.0.0b1');
    expect(new Version('1.0.0RC1').toString()).toBe('1.0.0rc1');
  });
  test('rejects garbage', () => {
    expect(() => new Version('not-a-version')).toThrow();
    expect(() => new Version('1.2.3abc')).toThrow();
  });
});

// ============================================================================
// test_version_release.py
// ============================================================================

describe('isNewer', () => {
  test('latest strictly greater', () => expect(isNewer('0.8.0', '0.7.4')).toBe(true));
  test('equal', () => expect(isNewer('0.7.4', '0.7.4')).toBe(false));
  test('current greater', () => expect(isNewer('0.7.0', '0.7.4')).toBe(false));
  test('dev build ahead of release', () => expect(isNewer('0.7.4', '0.7.5.dev0')).toBe(false));
  test('invalid version', () => expect(isNewer('not-a-version', '0.7.4')).toBe(false));
  test('local version containing unknown is not the sentinel', () =>
    expect(isNewer('1.2.4', '1.2.3+unknown')).toBe(true));
  test('unknown sentinel', () => expect(isNewer('1.0.0', 'unknown')).toBe(false));
});

describe('normalizeTag', () => {
  test('strips single leading v', () => expect(normalizeTag('v0.7.4')).toBe('0.7.4'));
  test('idempotent without v', () => expect(normalizeTag('0.7.4')).toBe('0.7.4'));
  test('strips exactly one v', () => expect(normalizeTag('vv0.7.4')).toBe('v0.7.4'));
  test('empty passthrough', () => expect(normalizeTag('')).toBe(''));
  test('prerelease spellings', () => {
    expect(normalizeTag('v1.0.0-beta.1')).toBe('1.0.0b1');
    expect(normalizeTag('v1.0.0-alpha2')).toBe('1.0.0a2');
    expect(normalizeTag('v1.0.0-rc.1')).toBe('1.0.0rc1');
  });
});

describe('fetchLatestReleaseTag (npm registry)', () => {
  const mockFetch = (impl: (url: string) => Promise<Response>) => {
    const calls: string[] = [];
    versionDeps.fetch = (url: string) => {
      calls.push(url);
      return impl(url);
    };
    return calls;
  };

  test('success returns v-prefixed dist-tags.latest', async () => {
    const calls = mockFetch(async () => new Response(JSON.stringify({ latest: '9.9.9', next: '10.0.0-rc.1' })));
    expect(await versionDeps.fetchLatestReleaseTag()).toEqual(['v9.9.9', null]);
    expect(calls).toEqual([NPM_DIST_TAGS_URL]);
  });
  test('network error maps to offline', async () => {
    mockFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await versionDeps.fetchLatestReleaseTag()).toEqual([null, RESOLUTION_FAILURE_OFFLINE]);
  });
  test('timeout maps to offline', async () => {
    mockFetch(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    expect(await versionDeps.fetchLatestReleaseTag()).toEqual([null, RESOLUTION_FAILURE_OFFLINE]);
  });
  test('403/429 map to rate limited', async () => {
    for (const status of [403, 429]) {
      mockFetch(async () => new Response('no', { status }));
      expect(await versionDeps.fetchLatestReleaseTag()).toEqual([null, RESOLUTION_FAILURE_RATE_LIMITED]);
    }
  });
  test('other HTTP codes use code string', async () => {
    for (const status of [404, 500, 502]) {
      mockFetch(async () => new Response('no', { status }));
      expect(await versionDeps.fetchLatestReleaseTag()).toEqual([null, `HTTP ${status}`]);
    }
  });
  test('malformed body propagates', async () => {
    mockFetch(async () => new Response('{not json'));
    await expect(versionDeps.fetchLatestReleaseTag()).rejects.toThrow();
    mockFetch(async () => new Response(JSON.stringify({ next: '1.0.0' })));
    await expect(versionDeps.fetchLatestReleaseTag()).rejects.toThrow(/dist-tags.latest/);
  });
});

// ============================================================================
// Tag validation / helpers
// ============================================================================

describe('validateTag', () => {
  test.each(['v0.7.6', 'v0.8.0.dev0', 'v1.0.0-rc1', 'v1.0.0-beta.1', 'v0.8.0+build.42', 'v1.0.0-rc1+build.42'])(
    'accepts %s',
    (tag) => expect(validateTag(tag)).toBe(tag),
  );
  test('folds uppercase V and trims whitespace', () => {
    expect(validateTag('V0.7.6')).toBe('v0.7.6');
    expect(validateTag('  v0.7.6 \n')).toBe('v0.7.6');
  });
  test.each(['latest', '0.7.5', 'main', 'v7', '', 'v1.2.3abc', 'v1.2.3...', 'v1.2.3++', 'v\uff11.2.3', 'v1.\u0662.3'])(
    'rejects %p',
    (tag) => {
      expect(() => validateTag(tag)).toThrow(BadParameter);
      expect(() => validateTag(tag)).toThrow('Invalid --tag: expected vMAJOR.MINOR.PATCH[suffix]');
    },
  );
});

describe('misc helpers', () => {
  test('stableReleaseTagForVersion', () => {
    expect(stableReleaseTagForVersion('1.2.3')).toBe('v1.2.3');
    expect(stableReleaseTagForVersion('v1.2.3')).toBe('v1.2.3');
    expect(stableReleaseTagForVersion('1.2.3rc1')).toBeNull();
    expect(stableReleaseTagForVersion('1.2')).toBeNull();
    expect(stableReleaseTagForVersion('garbage')).toBeNull();
  });
  test('canonicalizeVersionText', () => {
    expect(canonicalizeVersionText('v1.0.0-rc.1')).toBe('1.0.0rc1');
    expect(canonicalizeVersionText('vnope')).toBe('nope');
  });
  test('parseVerifyVersionOutput', () => {
    expect(parseVerifyVersionOutput('specify 1.2.3\n')).toBe('1.2.3');
    expect(parseVerifyVersionOutput('specify v1.2.3')).toBe('v1.2.3');
    expect(parseVerifyVersionOutput('Specify-CLI version 1.0.0rc1')).toBe('1.0.0rc1');
    expect(parseVerifyVersionOutput('banner\nno version here')).toBeNull();
  });
  test('renderArgv posix and windows', () => {
    expect(renderArgv(['npm', 'install', '--global', '@oakoliver/specify-cli@1.0.0'], 'linux')).toBe(
      'npm install --global @oakoliver/specify-cli@1.0.0',
    );
    expect(renderArgv(['/a b/npm', "it's"], 'linux')).toBe(`'/a b/npm' 'it'"'"'s'`);
    expect(renderArgv(['C:\\Program Files\\npm.cmd', 'x'], 'win32')).toBe('"C:\\Program Files\\npm.cmd" x');
  });
  test('github credential env scrubbing', () => {
    expect(isGithubCredentialEnvKey('GH_TOKEN')).toBe(true);
    expect(isGithubCredentialEnvKey('github_token')).toBe(true);
    expect(isGithubCredentialEnvKey('HOMEBREW_GITHUB_API_TOKEN')).toBe(true);
    expect(isGithubCredentialEnvKey('GITHUBTOKEN')).toBe(false);
    expect(isGithubCredentialEnvKey('NPM_TOKEN')).toBe(false);
    versionDeps.env = () => ({ GH_TOKEN: 'x', GITHUB_TOKEN: 'y', PATH: '/bin', NPM_TOKEN: 'z' });
    expect(scrubbedEnv()).toEqual({ PATH: '/bin', NPM_TOKEN: 'z' });
  });
  test('listingContainsPackage requires exact name', () => {
    expect(listingContainsPackage('/x/global node_modules (3)\n└── @oakoliver/specify-cli@1.1.0\n')).toBe(true);
    expect(listingContainsPackage('info "@oakoliver/specify-cli@1.1.0" has binaries:')).toBe(true);
    expect(listingContainsPackage('└── @oakoliver/specify-cli-extra@1.0.0')).toBe(false);
  });
});

// ============================================================================
// Install method detection (test_version_detection.py, adapted to npm layouts)
// ============================================================================

describe('detectInstallMethod', () => {
  beforeEach(() => {
    versionDeps.editableMarkerSeen = () => false;
    versionDeps.which = () => null;
    versionDeps.platform = () => 'linux';
  });

  const cases: Array<[string, InstallMethod]> = [
    ['/usr/local/lib/node_modules/@oakoliver/specify-cli/dist/cli.js', InstallMethod.NPM_GLOBAL],
    ['/home/u/.nvm/versions/node/v20.1.0/lib/node_modules/@oakoliver/specify-cli/dist/cli.js', InstallMethod.NPM_GLOBAL],
    ['/home/u/.bun/install/global/node_modules/@oakoliver/specify-cli/dist/cli.js', InstallMethod.BUN_GLOBAL],
    [
      '/home/u/.local/share/pnpm/global/5/.pnpm/@oakoliver+specify-cli@1.1.0/node_modules/@oakoliver/specify-cli/dist/cli.js',
      InstallMethod.PNPM_GLOBAL,
    ],
    ['/home/u/.config/yarn/global/node_modules/@oakoliver/specify-cli/dist/cli.js', InstallMethod.YARN_GLOBAL],
    ['/home/u/.npm/_npx/abc123/node_modules/@oakoliver/specify-cli/dist/cli.js', InstallMethod.NPX_EPHEMERAL],
    ['/tmp/bunx-501-@oakoliver/specify-cli@latest/node_modules/@oakoliver/specify-cli/dist/cli.js', InstallMethod.NPX_EPHEMERAL],
  ];
  test.each(cases)('%s -> %s', (argv0, method) => {
    expect(detectInstallMethod(argv0)).toBe(method);
    // deterministic
    expect(detectInstallMethod(argv0)).toBe(method);
  });

  test('windows npm prefix (case-insensitive)', () => {
    versionDeps.platform = () => 'win32';
    expect(
      detectInstallMethod('C:\\Users\\U\\AppData\\Roaming\\npm\\node_modules\\@oakoliver\\specify-cli\\dist\\cli.js'),
    ).toBe(InstallMethod.NPM_GLOBAL);
  });

  test('sibling directory is not a prefix match', () => {
    expect(detectInstallMethod('/usr/local/lib/node_modules/@oakoliver/specify-cli-evil/dist/cli.js')).toBe(
      InstallMethod.UNSUPPORTED,
    );
  });

  test('include signals', () => {
    const [method, signals] = detectInstallMethod(
      '/usr/local/lib/node_modules/@oakoliver/specify-cli/dist/cli.js',
      true,
    );
    expect(method).toBe(InstallMethod.NPM_GLOBAL);
    expect(signals.matched_tier).toBe(1);
    expect(signals.editable_marker_seen).toBe(false);
  });

  test('editable marker -> source checkout (tier 2)', () => {
    versionDeps.editableMarkerSeen = () => true;
    const [method, signals] = detectInstallMethod('/somewhere/else/cli.js', true);
    expect(method).toBe(InstallMethod.SOURCE_CHECKOUT);
    expect(signals.matched_tier).toBe(2);
  });

  test('tier 3 registry reconciliation for a missing absolute entrypoint', () => {
    versionDeps.which = (n) => (n === 'npm' ? '/usr/bin/npm' : null);
    const calls: string[][] = [];
    versionDeps.spawn = (argv) => {
      calls.push(argv);
      return {
        status: 0,
        stdout: JSON.stringify({ dependencies: { '@oakoliver/specify-cli': { version: '1.1.0' } } }),
        errorCode: null,
      };
    };
    const [method, signals] = detectInstallMethod('/nonexistent/bin/specify', true);
    expect(method).toBe(InstallMethod.NPM_GLOBAL);
    expect(signals.matched_tier).toBe(3);
    expect(signals.installer_registries_consulted).toEqual(['npm ls --global --json']);
    expect(calls[0]).toEqual(['/usr/bin/npm', 'ls', '--global', '--json', '--depth=0']);
  });

  test('tier 3 ignores substring false positives and malformed json', () => {
    versionDeps.which = (n) => (n === 'npm' || n === 'bun' ? `/usr/bin/${n}` : null);
    versionDeps.spawn = (argv) =>
      argv[0].endsWith('npm')
        ? { status: 0, stdout: '{bad json', errorCode: null }
        : { status: 0, stdout: '└── @oakoliver/specify-cli-fork@1.0.0', errorCode: null };
    expect(detectInstallMethod('/nonexistent/bin/specify')).toBe(InstallMethod.UNSUPPORTED);
  });

  test('tier 3 ambiguous matches are unsupported', () => {
    versionDeps.which = (n) => (n === 'npm' || n === 'bun' ? `/usr/bin/${n}` : null);
    versionDeps.spawn = (argv) =>
      argv[0].endsWith('npm')
        ? { status: 0, stdout: JSON.stringify({ dependencies: { '@oakoliver/specify-cli': {} } }), errorCode: null }
        : { status: 0, stdout: '└── @oakoliver/specify-cli@1.1.0', errorCode: null };
    expect(detectInstallMethod('/nonexistent/bin/specify')).toBe(InstallMethod.UNSUPPORTED);
  });

  test('tier 3 skipped when entrypoint exists', () => {
    versionDeps.which = () => '/usr/bin/npm';
    versionDeps.spawn = () => {
      throw new Error('registry must not be consulted');
    };
    expect(detectInstallMethod(import.meta.path)).toBe(InstallMethod.UNSUPPORTED);
  });
});

// ============================================================================
// specify version (test_command_version.py)
// ============================================================================

describe('specify version', () => {
  let out: ReturnType<typeof captureOutput>;
  const origDeps = { ...versionCommandDeps };
  beforeEach(() => {
    versionCommandDeps.getSpeckitVersion = () => '1.2.3';
    versionCommandDeps.showBanner = async () => {};
    out = captureOutput();
  });
  afterEach(() => {
    out.restore();
    Object.assign(versionCommandDeps, origDeps);
  });

  test('--features text', async () => {
    const code = await runVersionCommand(['--features']);
    expect(code).toBe(0);
    const t = out.text();
    expect(t).toContain('Spec Kit CLI: 1.2.3');
    expect(t).toContain('Features:');
    expect(t).toContain('- controlled multi install integrations: yes');
    expect(t).toContain('- integration use command: yes');
    expect(t).toContain('- self check command: yes');
  });

  test('--features --json', async () => {
    const code = await runVersionCommand(['--features', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toEqual({ version: '1.2.3', features: featureCapabilities() });
    expect(featureCapabilities()).toEqual({
      controlled_multi_install_integrations: true,
      integration_use_command: true,
      multi_install_safe_registry_metadata: true,
      integration_upgrade_command: true,
      self_check_command: true,
      workflow_catalog: true,
      bundled_templates: true,
    });
  });

  test('--json requires --features', async () => {
    const code = await runVersionCommand(['--json']);
    expect(code).not.toBe(0);
    expect(out.text()).toContain('--json requires --features');
  });

  test('reports runtime, openssl and upstream parity', async () => {
    const code = await runVersionCommand([]);
    expect(code).toBe(0);
    const t = out.text();
    expect(t).toContain('Specify CLI Information');
    expect(t).toContain('CLI Version');
    expect(t).toContain('1.2.3');
    expect(t).toContain(`spec-kit ${UPSTREAM_SPEC_KIT_VERSION}`);
    expect(UPSTREAM_SPEC_KIT_VERSION).toBe('1.0.12');
    const info = await getRuntimeInfo();
    if (info.openssl) {
      expect(t).toContain('OpenSSL');
      expect(t).toContain(info.openssl);
    }
    expect(t).toMatch(/Node|Bun/);
  });

  test('skips OpenSSL row when runtime exposes none', async () => {
    versionCommandDeps.getRuntimeInfo = async () => ({
      runtimeName: 'Node',
      runtimeVersion: '20.0.0',
      platform: 'Linux',
      architecture: 'x86_64',
      osVersion: '#1 SMP',
      openssl: '',
    });
    expect(await runVersionCommand([])).toBe(0);
    expect(out.text()).not.toContain('OpenSSL');
  });

  test('buildInfoRows order', () => {
    const rows = buildInfoRows('1.0.0', {
      runtimeName: 'Bun',
      runtimeVersion: '1.1.0',
      platform: 'Darwin',
      architecture: 'arm64',
      osVersion: 'v',
      openssl: 'BoringSSL x',
    });
    expect(rows.map(([k]) => k)).toEqual([
      'CLI Version',
      'Upstream Parity',
      '',
      'Bun',
      'Platform',
      'Architecture',
      'OS Version',
      'OpenSSL',
    ]);
  });
});
