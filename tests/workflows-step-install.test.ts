/**
 * Custom step installation from the catalog (exact releases), local
 * directories and archive URLs, plus the shared installer, locking and
 * removal. Ports of upstream (spec-kit 1.2.5)
 * tests/specify_cli/workflows/step/test_catalog_versions.py,
 * test_command_add.py (TestWorkflowStepAddSources, TestVersionedStepAdd),
 * test_command_info.py, test_command_remove.py, test_installer.py and
 * tests/specify_cli/workflows/test_custom_steps.py (#4769, #4840).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { HttpResponse } from '../src/authentication/http.js';
import { console as stdoutConsole, errConsole, setPromptInput } from '../src/console.js';
import { STEP_REGISTRY, BUILTIN_STEP_TYPES, loadCustomSteps } from '../src/workflows/index.js';
import { httpDeps } from '../src/workflows/catalog/domain.js';
import {
  DuplicateCatalogField,
  StepCatalog,
  StepCatalogError,
  StepRegistry,
  StepValidationError,
  type StepCatalogEntry,
} from '../src/workflows/step/catalog/domain.js';
import { availableVersions } from '../src/workflows/step/catalog/versions.js';
import { installPreselectedStep, runWorkflowStepCommand } from '../src/workflows/step/commands.js';
import {
  StepInstallError,
  checkInstallable,
  installStepPackage,
  installerDeps,
  resolvePackageRoot,
  stepInstallTransaction,
  stepPackageLimits,
  validateStepId,
  validateStepPackage,
} from '../src/workflows/step/installer.js';
import { makeTarGz, makeZip } from './archive-helpers.js';

type Dict = Record<string, unknown>;

const BASE_TS = pathToFileURL(resolve(import.meta.dir, '..', 'src', 'workflows', 'base.ts')).href;

let tmp: string;
let projectDir: string;
let prevCwd: string;
let prevHome: string | undefined;
let output: string;
let prevOut: unknown;
let prevErr: unknown;
const realOpenUrl = httpDeps.openUrl;
const proto = StepCatalog.prototype as unknown as Dict;
const realMerged = proto.getMergedSteps;
const realActive = proto.getActiveCatalogs;
const realFetch = proto.fetchSingleCatalog;
const realInfo = proto.getStepInfo;
const realValid = proto.isUrlCacheValid;
const realLimits = { ...stepPackageLimits };
const realDeps = { ...installerDeps };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wf-step-install-'));
  projectDir = join(tmp, 'proj');
  mkdirSync(join(projectDir, '.specify', 'workflows'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectDir);
  prevHome = process.env.HOME;
  process.env.HOME = join(tmp, 'home');
  delete process.env.SPECKIT_STEP_CATALOG_URL;
  delete process.env.SPECIFY_INIT_DIR;
  output = '';
  prevOut = (stdoutConsole as unknown as { opts: Dict }).opts.file;
  prevErr = (errConsole as unknown as { opts: Dict }).opts.file;
  stdoutConsole.file = { write: (c: string) => (output += c) };
  errConsole.file = { write: (c: string) => (output += c) };
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  (stdoutConsole as unknown as { opts: Dict }).opts.file = prevOut;
  (errConsole as unknown as { opts: Dict }).opts.file = prevErr;
  httpDeps.openUrl = realOpenUrl;
  proto.getMergedSteps = realMerged;
  proto.getActiveCatalogs = realActive;
  proto.fetchSingleCatalog = realFetch;
  proto.getStepInfo = realInfo;
  proto.isUrlCacheValid = realValid;
  Object.assign(stepPackageLimits, realLimits);
  Object.assign(installerDeps, realDeps);
  setPromptInput(null);
  for (const key of [...STEP_REGISTRY.keys()]) if (!BUILTIN_STEP_TYPES.has(key)) STEP_REGISTRY.delete(key);
  rmSync(tmp, { recursive: true, force: true });
});

const sha = (b: string | Uint8Array): string => createHash('sha256').update(b).digest('hex');
const stepsDir = (): string => join(projectDir, '.specify', 'workflows', 'steps');
const flat = (s: string): string => s.split(/\s+/).join(' ');

function writePackage(typeKey = 'my-step', opts: { init?: string | null; js?: string } = {}): string {
  const dir = join(tmp, `${typeKey}-pkg`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'step.yml'), `step:\n  type_key: ${typeKey}\n  name: My Step\n  version: 0.1.0\n`);
  const init = opts.init === undefined ? '# init\n' : opts.init;
  if (init !== null) writeFileSync(join(dir, '__init__.py'), init);
  if (opts.js !== undefined) writeFileSync(join(dir, 'index.mjs'), opts.js);
  return dir;
}

function jsStep(typeKey: string, className = 'DevStep'): string {
  return (
    `import { StepBase, StepResult } from '${BASE_TS}';\n` +
    `export class ${className} extends StepBase {\n` +
    `  static typeKey = '${typeKey}';\n` +
    `  execute() { return new StepResult({ output: { ok: true } }); }\n` +
    '}\n'
  );
}

function serveBodies(bodies: Record<string, string | Uint8Array>, requested: string[] = [], contentType?: string): void {
  httpDeps.openUrl = (async (url: string) => {
    requested.push(url);
    if (!(url in bodies)) throw new Error(`unexpected url ${url}`);
    const body = bodies[url] as string | Uint8Array;
    const headers: Record<string, string> = contentType ? { 'Content-Type': contentType } : {};
    return new HttpResponse(new Response(typeof body === 'string' ? body : Buffer.from(body), { headers }), url);
  }) as typeof httpDeps.openUrl;
}

function forbidNetwork(): void {
  httpDeps.openUrl = (async () => {
    throw new Error('network request must not be issued');
  }) as typeof httpDeps.openUrl;
}

// ============================================================================
// Step catalog release selection (test_catalog_versions.py)
// ============================================================================

function digests(...extra: string[]): Dict {
  const out: Dict = {};
  for (const name of ['step.yml', '__init__.py', ...extra]) out[name] = sha(name);
  return out;
}

function stepEntry(): Dict {
  return {
    id: 'deploy',
    name: 'Deploy',
    version: '2.0',
    url: 'https://example.com/current/step.yml',
    init_url: 'https://example.com/current/__init__.py',
    sha256: digests(),
    requires: { current: true },
    releases: {
      '1.0': {
        step_yml_url: 'https://example.com/old/step.yml',
        init_url: 'https://example.com/old/__init__.py',
        extra_files: { 'helper.py': 'https://example.com/old/helper.py' },
        sha256: digests('helper.py'),
        requires: { old: true },
      },
    },
  };
}

function mergedSteps(steps: Record<string, Dict>): void {
  proto.getMergedSteps = async () => new Map(Object.entries(steps));
}

describe('step catalog release selection', () => {
  test('current and exact release keep separate metadata', async () => {
    mergedSteps({ deploy: stepEntry() });
    const catalog = new StepCatalog(projectDir);
    const current = (await catalog.getStepInfo('deploy'))!;
    const old = (await catalog.getStepInfo('deploy', 'v1.0'))!;
    expect(current.url).toBe('https://example.com/current/step.yml');
    expect(current.version).toBe('2.0');
    expect(((current.releases as Dict)['1.0'] as Dict).extra_files).toBeTruthy();
    expect(old.version).toBe('1.0');
    expect(old.step_yml_url).toBe('https://example.com/old/step.yml');
    expect(old.sha256).toEqual(digests('helper.py'));
    expect(old.requires).toEqual({ old: true });
    expect('url' in old || 'releases' in old).toBe(false);
    expect((await catalog.getStepInfo('deploy', '2.0'))!.url).toBe(current.url);
    expect(await catalog.getStepInfo('deploy', '9.0')).toBeNull();
    expect(availableVersions(current, 'deploy')).toEqual(['2.0', '1.0']);
  });

  test('legacy current and exact spelling', async () => {
    const legacy = { id: 'deploy', version: 'release-1', url: 'https://example.com/step.yml' };
    mergedSteps({ deploy: legacy });
    const catalog = new StepCatalog(projectDir);
    expect(await catalog.getStepInfo('deploy')).toBe(legacy);
    expect(await catalog.getStepInfo('deploy', 'release-1')).toBe(legacy);
    expect(await catalog.getStepInfo('deploy', 'release-2')).toBeNull();
  });

  test('winning source never falls back for a missing release', async () => {
    const sources: StepCatalogEntry[] = [
      { url: 'https://example.com/high', name: 'discovery', priority: 1, install_allowed: false, description: '' },
      { url: 'https://example.com/low', name: 'installable', priority: 2, install_allowed: true, description: '' },
    ];
    const high = { ...stepEntry() };
    delete high.releases;
    proto.getActiveCatalogs = () => sources;
    proto.fetchSingleCatalog = async (source: StepCatalogEntry) => ({
      steps: { deploy: source.name === 'discovery' ? { ...high } : stepEntry() },
    });
    const catalog = new StepCatalog(projectDir);
    expect((await catalog.getStepInfo('deploy'))!._install_allowed).toBe(false);
    expect(await catalog.getStepInfo('deploy', '1.0')).toBeNull();
  });

  test('a list catalog rejects duplicate step IDs', async () => {
    proto.getActiveCatalogs = () => [
      { url: 'https://example.com/steps.json', name: 'test', priority: 1, install_allowed: true, description: '' },
    ];
    proto.fetchSingleCatalog = async () => ({ steps: [{ id: 'deploy', version: '1.0' }, { id: 'deploy', version: '2.0' }] });
    await expect(new StepCatalog(projectDir).getStepInfo('deploy')).rejects.toThrow(
      "Duplicate step ID 'deploy' in catalog 'test'.",
    );
  });

  for (const cached of [true, false]) {
    test(`a duplicate JSON release key is not silently overwritten (cached=${cached})`, async () => {
      const source = { url: 'https://example.com/steps.json', name: 'test', priority: 1, install_allowed: true, description: '' };
      proto.getActiveCatalogs = () => [source];
      const payload = '{"steps":{"deploy":{"version":"2.0","releases":{"1.0":{},"1.0":{}}}}}';
      const catalog = new StepCatalog(projectDir);
      if (cached) {
        const [cacheFile] = catalog.getCachePaths(source.url);
        mkdirSync(join(cacheFile, '..'), { recursive: true });
        writeFileSync(cacheFile, payload);
        proto.isUrlCacheValid = () => true;
      } else {
        serveBodies({ [source.url]: payload });
      }
      const err = await catalog.getStepInfo('deploy', '1.0').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DuplicateCatalogField);
      expect((err as Error).message).toBe("Duplicate field '1.0' in step catalog.");
    });
  }

  const releaseOld = (): Dict => (stepEntry().releases as Dict)['1.0'] as Dict;
  const bad: Array<[string, Dict, string]> = [
    ['releases list', { releases: [] }, 'releases mapping'],
    ['null version', { version: null }, 'current version'],
    ['invalid version', { version: 'not valid' }, 'current version'],
    ['mismatched id', { id: 'another' }, 'mismatched catalog ID'],
    ['repeats current', { releases: { 'v2.0': releaseOld() } }, 'repeats release'],
    ['repeats history', { releases: { '1.0': releaseOld(), 'v1.0': releaseOld() } }, 'repeats release'],
    ['bogus key', { releases: { bogus: {} } }, 'invalid release version'],
    ['list record', { releases: { '1.0': [] } }, 'must be an object'],
    ['reserved', { releases: { '1.0': { id: 'deploy' } } }, 'reserved fields'],
    ['no digests', { releases: { '1.0': { url: 'https://example.com/step.yml' } } }, 'SHA-256'],
    [
      'aliased extra file',
      { releases: { '1.0': { ...releaseOld(), extra_files: { './step.yml': 'https://example.com/alias' } } } },
      'invalid extra_files',
    ],
    ['bad digest', { releases: { '1.0': { ...releaseOld(), sha256: { 'step.yml': 'bad' } } } }, 'SHA-256'],
    ['requires list', { releases: { '1.0': { ...releaseOld(), requires: [] } } }, 'invalid requires'],
    ['numeric url', { releases: { '1.0': { ...releaseOld(), step_yml_url: 12 } } }, 'step.yml URL'],
    [
      'underivable init url',
      { releases: { '1.0': { ...releaseOld(), init_url: null, step_yml_url: 'https://example.com/old/manifest' } } },
      '__init__.py URL',
    ],
  ];
  for (const [label, change, error] of bad) {
    test(`bad history is rejected, not ignored: ${label}`, async () => {
      mergedSteps({ deploy: { ...stepEntry(), ...change } });
      await expect(new StepCatalog(projectDir).getStepInfo('deploy')).rejects.toThrow(error);
    });
  }

  test('digest error lists the expected file set like Python', async () => {
    mergedSteps({ deploy: { ...stepEntry(), releases: { '1.0': { ...releaseOld(), sha256: {} } } } });
    await expect(new StepCatalog(projectDir).getStepInfo('deploy')).rejects.toThrow(
      "Step 'deploy' needs SHA-256 digests for exactly ['__init__.py', 'helper.py', 'step.yml'].",
    );
  });
});

// ============================================================================
// step add --version (TestVersionedStepAdd)
// ============================================================================

const OLD = 'https://example.com/old/';

function versionedSetup(opts: { discovery?: boolean; corrupt?: string } = {}): string[] {
  const bodies: Record<string, string> = {
    [OLD + 'step.yml']: "step:\n  type_key: deploy\n  version: '1.0'\n",
    [OLD + '__init__.py']: '# example\n',
    [OLD + 'helper.py']: '# helper\n',
  };
  const hashes: Dict = {};
  for (const name of ['step.yml', '__init__.py', 'helper.py']) hashes[name] = sha(bodies[OLD + name] as string);
  const release: Dict = {
    step_yml_url: OLD + 'step.yml',
    init_url: OLD + '__init__.py',
    extra_files: { 'helper.py': OLD + 'helper.py' },
    sha256: hashes,
  };
  const entry: Dict = {
    id: 'deploy',
    name: 'Deploy',
    version: '2.0',
    step_yml_url: 'https://example.com/current/step.yml',
    _install_allowed: !opts.discovery,
    releases: { '1.0': release },
  };
  if (opts.corrupt === 'checksum') bodies[OLD + 'helper.py'] = 'changed';
  else if (opts.corrupt === 'version') {
    bodies[OLD + 'step.yml'] = "step:\n  type_key: deploy\n  version: '2.0'\n";
    hashes['step.yml'] = sha(bodies[OLD + 'step.yml'] as string);
  } else if (opts.corrupt === 'id') {
    bodies[OLD + 'step.yml'] = "step:\n  type_key: other\n  version: '1.0'\n";
    hashes['step.yml'] = sha(bodies[OLD + 'step.yml'] as string);
  } else if (opts.corrupt === 'url') release.init_url = 'http://evil.example/__init__.py';
  mergedSteps({ deploy: entry });
  const requested: string[] = [];
  serveBodies(bodies, requested);
  return requested;
}

describe('specify workflow step add --version', () => {
  test('installs the exact selected files', async () => {
    const requested = versionedSetup();
    expect(await runWorkflowStepCommand(['add', 'deploy', '--version', 'v1.0'])).toBe(0);
    expect(requested).toEqual(['step.yml', '__init__.py', 'helper.py'].map((n) => OLD + n));
    expect((new StepRegistry(projectDir).get('deploy') as Dict).version).toBe('1.0');
    expect(readFileSync(join(stepsDir(), 'deploy', 'helper.py'), 'utf-8')).toBe('# helper\n');
  });

  test('preselected step installs without reloading the catalog', async () => {
    const requested = versionedSetup();
    const selected = (await new StepCatalog(projectDir).getStepInfo('deploy', '1.0'))!;
    proto.getStepInfo = async () => {
      throw new Error('catalog was re-resolved');
    };
    await installPreselectedStep('deploy', { version: '1.0', selectedInfo: selected });
    expect(requested).toEqual(['step.yml', '__init__.py', 'helper.py'].map((n) => OLD + n));
    expect((new StepRegistry(projectDir).get('deploy') as Dict).version).toBe('1.0');
  });

  test('preselected step rejects a bad digest without reloading the catalog', async () => {
    versionedSetup({ corrupt: 'checksum' });
    const selected = (await new StepCatalog(projectDir).getStepInfo('deploy', '1.0'))!;
    proto.getStepInfo = async () => {
      throw new Error('catalog was re-resolved');
    };
    const err = await installPreselectedStep('deploy', { version: '1.0', selectedInfo: selected }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepInstallError);
    expect((err as Error).message).toContain('checksum mismatch');
    expect(new StepRegistry(projectDir).isInstalled('deploy')).toBe(false);
  });

  for (const [corrupt, error] of [
    ['checksum', 'checksum mismatch'],
    ['version', 'does not match catalog version'],
    ['id', 'does not match step ID'],
    ['url', 'non-HTTPS'],
  ] as const) {
    test(`rejects a bad selected release (${corrupt})`, async () => {
      versionedSetup({ corrupt });
      expect(await runWorkflowStepCommand(['add', 'deploy', '--version', '1.0'])).toBe(1);
      expect(output).toContain(error);
      expect(new StepRegistry(projectDir).isInstalled('deploy')).toBe(false);
      expect(existsSync(join(stepsDir(), 'deploy'))).toBe(false);
    });
  }

  for (const [discovery, version, error] of [
    [false, '0.9', 'not found in the winning catalog'],
    [true, '1.0', 'discovery-only catalog'],
  ] as const) {
    test(`no fallback or discovery install (${version})`, async () => {
      const requested = versionedSetup({ discovery });
      expect(await runWorkflowStepCommand(['add', 'deploy', '--version', version])).toBe(1);
      expect(output).toContain(error);
      expect(requested).toEqual([]);
    });
  }

  test('an explicit current selection requires digests', async () => {
    const requested = versionedSetup();
    expect(await runWorkflowStepCommand(['add', 'deploy', '--version', '2.0'])).toBe(1);
    expect(output).toContain('SHA-256 digests');
    expect(requested).toEqual([]);
  });

  test('rejects an insecure redirect before following it', async () => {
    versionedSetup();
    httpDeps.openUrl = (async (url: string, opts: { redirectValidator?: (a: string, b: string) => void }) => {
      opts.redirectValidator!(url, 'http://evil.example/step.yml');
      throw new Error('redirect should have been refused');
    }) as unknown as typeof httpDeps.openUrl;
    expect(await runWorkflowStepCommand(['add', 'deploy', '--version', '1.0'])).toBe(1);
    expect(flat(output)).toContain('redirect target must use HTTPS');
    expect(existsSync(join(stepsDir(), 'deploy'))).toBe(false);
  });

  for (const option of ['--dev', '--from']) {
    test(`--version is rejected with ${option} before any network use`, async () => {
      forbidNetwork();
      expect(
        await runWorkflowStepCommand(['add', 'deploy', option, 'https://example.com/deploy.zip', '--version', '1.0']),
      ).toBe(1);
      expect(output).toContain('--version requires a catalog step ID');
    });
  }

  test('empty --version value is rejected', async () => {
    expect(await runWorkflowStepCommand(['add', 'deploy', '--version', '  '])).toBe(1);
    expect(output).toContain('--version value must not be empty');
  });
});

// ============================================================================
// step add --dev / --from (TestWorkflowStepAddSources)
// ============================================================================

describe('specify workflow step add --dev / --from', () => {
  test('--dev installs a JavaScript step that loads and runs (ADAPTATION)', async () => {
    const pkg = writePackage('dev-load-step', { init: null, js: jsStep('dev-load-step') });
    expect(await runWorkflowStepCommand(['add', 'dev-load-step', '--dev', pkg])).toBe(0);
    expect(output).toContain("Step type 'My Step' (dev-load-step) installed");
    expect(existsSync(join(stepsDir(), 'dev-load-step', 'step.yml'))).toBe(true);
    const meta = new StepRegistry(projectDir).get('dev-load-step') as Dict;
    expect(meta).toMatchObject({ name: 'My Step', version: '0.1.0', type_key: 'dev-load-step', source: 'local' });
    expect('catalog_name' in meta).toBe(false);
    expect(await loadCustomSteps(projectDir)).toEqual(['dev-load-step']);
    expect(STEP_REGISTRY.has('dev-load-step')).toBe(true);
  });

  test('--dev install, list and remove', async () => {
    const pkg = writePackage('dev-step');
    expect(await runWorkflowStepCommand(['add', 'dev-step', '--dev', pkg])).toBe(0);
    output = '';
    expect(await runWorkflowStepCommand(['list'])).toBe(0);
    expect(output).toContain('dev-step');
    expect(await runWorkflowStepCommand(['remove', 'dev-step'])).toBe(0);
    expect(existsSync(join(stepsDir(), 'dev-step'))).toBe(false);
  });

  test('--dev rejects a package without __init__.py or a JavaScript entry point', async () => {
    const pkg = writePackage('dev-step', { init: null });
    expect(await runWorkflowStepCommand(['add', 'dev-step', '--dev', pkg])).toBe(1);
    expect(output).toContain("missing required file '__init__.py'");
  });

  test('--dev lock failure is reported once without installing', async () => {
    const pkg = writePackage('dev-step');
    mkdirSync(join(projectDir, '.specify', '.step-install.lock'));
    expect(await runWorkflowStepCommand(['add', 'dev-step', '--dev', pkg])).toBe(1);
    const out = output.replace(/\n/g, '');
    expect(out).toContain('Failed to acquire the step lock');
    expect(out.split('Failed to').length - 1).toBe(1);
    expect(existsSync(join(stepsDir(), 'dev-step'))).toBe(false);
  });

  test('--dev rejects a symlinked source root', async () => {
    const pkg = writePackage('dev-step');
    const link = join(tmp, 'linked');
    symlinkSync(pkg, link);
    expect(await runWorkflowStepCommand(['add', 'dev-step', '--dev', link])).toBe(1);
    expect(output.toLowerCase()).toContain('symlink');
  });

  test('--dev and --from are mutually exclusive; empty values rejected', async () => {
    expect(
      await runWorkflowStepCommand(['add', 'dev-step', '--dev', 'somewhere', '--from', 'https://example.com/pkg.zip']),
    ).toBe(1);
    expect(output).toContain('mutually exclusive');
    for (const option of ['--dev', '--from']) {
      output = '';
      expect(await runWorkflowStepCommand(['add', 'dev-step', option, '   '])).toBe(1);
      expect(output).toContain('value must not be empty');
    }
  });

  test('--force replaces an installed package', async () => {
    const pkg = writePackage('dev-step', { init: '# old\n' });
    expect(await runWorkflowStepCommand(['add', 'dev-step', '--dev', pkg])).toBe(0);
    output = '';
    expect(await runWorkflowStepCommand(['add', 'dev-step', '--dev', pkg])).toBe(1);
    expect(output).toContain('already installed');
    writeFileSync(join(pkg, '__init__.py'), '# new\n');
    expect(await runWorkflowStepCommand(['add', 'dev-step', '--dev', pkg, '--force'])).toBe(0);
    expect(readFileSync(join(stepsDir(), 'dev-step', '__init__.py'), 'utf-8')).toBe('# new\n');
  });

  test('--force replaces an orphaned directory', async () => {
    const orphan = join(stepsDir(), 'dev-step');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, 'step.yml'), 'step:\n  type_key: dev-step\n');
    writeFileSync(join(orphan, '__init__.py'), '# old\n');
    const pkg = writePackage('dev-step', { init: '# new\n' });
    expect(await runWorkflowStepCommand(['add', 'dev-step', '--dev', pkg, '--force'])).toBe(0);
    expect(readFileSync(join(orphan, '__init__.py'), 'utf-8')).toBe('# new\n');
  });

  test('--from: a declined confirmation issues no request', async () => {
    setPromptInput(['n']);
    forbidNetwork();
    expect(await runWorkflowStepCommand(['add', 'dev-step', '--from', 'https://example.com/pkg.zip'])).toBe(0);
    expect(output).toContain('Untrusted Source');
    expect(output).toContain('Cancelled');
    expect(existsSync(join(stepsDir(), 'dev-step'))).toBe(false);
  });

  const archiveFiles = { 'step.yml': 'step:\n  type_key: my-step\n  name: My Step\n', '__init__.py': '# init\n' };
  for (const [url, body, contentType] of [
    ['https://example.com/pkg.zip', makeZip(archiveFiles), 'application/zip'],
    ['https://example.com/pkg.tar.gz', makeTarGz(archiveFiles), 'application/gzip'],
  ] as const) {
    test(`--from installs an archive (${url.split('.').slice(-1)[0]})`, async () => {
      setPromptInput(['y']);
      serveBodies({ [url]: body }, [], contentType);
      expect(await runWorkflowStepCommand(['add', 'my-step', '--from', url])).toBe(0);
      expect(existsSync(join(stepsDir(), 'my-step', 'step.yml'))).toBe(true);
      expect((new StepRegistry(projectDir).get('my-step') as Dict).source).toBe('url');
    });
  }

  test('--from detects a GitHub API asset archive from its bytes', async () => {
    setPromptInput(['y']);
    const url = 'https://api.github.com/repos/example/project/releases/assets/123';
    serveBodies({ [url]: makeZip(archiveFiles) }, [], 'application/octet-stream');
    expect(await runWorkflowStepCommand(['add', 'my-step', '--from', url])).toBe(0);
    expect(existsSync(join(stepsDir(), 'my-step', 'step.yml'))).toBe(true);
  });

  test('--from accepts a single nested package directory', async () => {
    setPromptInput(['y']);
    const url = 'https://example.com/nested.zip';
    serveBodies({ [url]: makeZip({ 'pkg/step.yml': archiveFiles['step.yml'], 'pkg/__init__.py': '# init\n' }) });
    expect(await runWorkflowStepCommand(['add', 'my-step', '--from', url])).toBe(0);
    expect(existsSync(join(stepsDir(), 'my-step', '__init__.py'))).toBe(true);
  });

  test('--from rejects non-HTTPS and malformed URLs before prompting', async () => {
    forbidNetwork();
    expect(await runWorkflowStepCommand(['add', 'my-step', '--from', 'http://example.com/pkg.zip'])).toBe(1);
    expect(output).toContain('URL must use HTTPS for security');
    output = '';
    expect(await runWorkflowStepCommand(['add', 'my-step', '--from', 'https://[::1/pkg.zip'])).toBe(1);
    expect(output).toContain('Invalid URL');
    expect(output).not.toContain('Untrusted Source');
  });

  test('--from rejects a redirect to non-HTTPS', async () => {
    setPromptInput(['y']);
    httpDeps.openUrl = (async () =>
      new HttpResponse(new Response(makeZip(archiveFiles)), 'http://evil.example/pkg.zip')) as unknown as typeof httpDeps.openUrl;
    expect(await runWorkflowStepCommand(['add', 'my-step', '--from', 'https://example.com/pkg.zip'])).toBe(1);
    expect(output).toContain('URL redirected to non-HTTPS: http://evil.example/pkg.zip');
  });

  test('--from rejects a non-archive body and archive format mismatches', async () => {
    setPromptInput(['y', 'y']);
    serveBodies({ 'https://example.com/pkg': 'not an archive' });
    expect(await runWorkflowStepCommand(['add', 'my-step', '--from', 'https://example.com/pkg'])).toBe(1);
    expect(output).toContain('Failed to install step from URL');
    expect(existsSync(join(stepsDir(), 'my-step'))).toBe(false);
    output = '';
    serveBodies({ 'https://example.com/pkg.zip': makeTarGz(archiveFiles) }, [], 'application/gzip');
    expect(await runWorkflowStepCommand(['add', 'my-step', '--from', 'https://example.com/pkg.zip'])).toBe(1);
    expect(output).toContain('Archive format mismatch: requested URL declares zip, final URL declares zip, Content-Type declares tar.gz');
  });

  test('--from rejects an archive with unrelated siblings', async () => {
    setPromptInput(['y']);
    const url = 'https://example.com/pkg.zip';
    serveBodies({ [url]: makeZip({ 'a/step.yml': archiveFiles['step.yml'], 'b/readme.md': 'x' }) });
    expect(await runWorkflowStepCommand(['add', 'my-step', '--from', url])).toBe(1);
    expect(output).toContain('archive must contain step.yml at its root or in exactly one top-level directory');
  });

  test('--from on an installed step errors before the prompt', async () => {
    const pkg = writePackage('my-step');
    expect(await runWorkflowStepCommand(['add', 'my-step', '--dev', pkg])).toBe(0);
    output = '';
    forbidNetwork();
    expect(await runWorkflowStepCommand(['add', 'my-step', '--from', 'https://example.com/pkg.zip'])).toBe(1);
    expect(output).toContain('already installed');
    expect(output).not.toContain('Untrusted Source');
  });

  test('install errors escape Rich markup from step metadata', async () => {
    const pkg = writePackage('my-step');
    writeFileSync(join(pkg, 'step.yml'), "step:\n  type_key: '[/]'\n");
    expect(await runWorkflowStepCommand(['add', 'my-step', '--dev', pkg])).toBe(1);
    expect(output).toContain("step.yml type_key ('[/]') does not match step ID ('my-step')");
  });

  test('the discovery-only warning prints the step ID literally', async () => {
    mergedSteps({ '[red]step': { id: '[red]step', version: '1.0', _install_allowed: false } });
    expect(await runWorkflowStepCommand(['add', '[red]step'])).toBe(1);
    expect(output).toContain("Step type '[red]step' is from a discovery-only catalog");
  });
});

// ============================================================================
// step info (test_command_info.py)
// ============================================================================

describe('specify workflow step info', () => {
  test('prints the local source of an installed step', async () => {
    const pkg = writePackage('dev-step');
    expect(await runWorkflowStepCommand(['add', 'dev-step', '--dev', pkg])).toBe(0);
    output = '';
    expect(await runWorkflowStepCommand(['info', 'dev-step'])).toBe(0);
    expect(output).toContain('Source:      local');
    expect(output).toContain('Installed');
  });

  test('prints the catalog source with its name', async () => {
    new StepRegistry(projectDir).add('cat-step', { name: 'Cat', version: '1.0', source: 'catalog', catalog_name: '[b]official' });
    expect(await runWorkflowStepCommand(['info', 'cat-step'])).toBe(0);
    expect(output).toContain('Source:      catalog ([b]official)');
  });

  test('--versions shows current and history from a discovery catalog', async () => {
    mergedSteps({ deploy: { ...stepEntry(), _install_allowed: false } });
    expect(await runWorkflowStepCommand(['info', 'deploy', '--versions'])).toBe(0);
    expect(output).toContain('Deploy (deploy) (discovery only; not installable)');
    expect(output).toContain('  2.0 (current)\n  1.0\n');
  });

  test('--versions rejects built-in step types and unknown steps', async () => {
    expect(await runWorkflowStepCommand(['info', 'shell', '--versions'])).toBe(1);
    expect(output).toContain("Built-in step type 'shell' has no catalog releases");
    output = '';
    mergedSteps({});
    expect(await runWorkflowStepCommand(['info', 'nope', '--versions'])).toBe(1);
    expect(output).toContain("Step type 'nope' not found");
  });

  test('a malformed catalog is an error, not "not found"', async () => {
    mergedSteps({ deploy: { ...stepEntry(), releases: [] } });
    expect(await runWorkflowStepCommand(['info', 'deploy'])).toBe(1);
    expect(output).toContain('invalid releases mapping');
    expect(output).not.toContain('not found');
  });
});

// ============================================================================
// step remove (test_command_remove.py)
// ============================================================================

describe('specify workflow step remove', () => {
  test('removes an orphaned directory with a warning', async () => {
    mkdirSync(join(stepsDir(), 'orphan'), { recursive: true });
    expect(await runWorkflowStepCommand(['remove', 'orphan'])).toBe(0);
    expect(output).toContain("'orphan' has no registry entry");
    expect(output).toContain("Step type 'orphan' uninstalled");
    expect(existsSync(join(stepsDir(), 'orphan'))).toBe(false);
  });

  test('not installed (escaped literally)', async () => {
    expect(await runWorkflowStepCommand(['remove', '[red]x'])).toBe(1);
    expect(output).toContain("Step type '[red]x' is not installed");
  });

  test('lock failure reports the acquisition error once', async () => {
    mkdirSync(join(stepsDir(), 'deploy'), { recursive: true });
    mkdirSync(join(projectDir, '.specify', '.step-install.lock'));
    expect(await runWorkflowStepCommand(['remove', 'deploy'])).toBe(1);
    const out = output.replace(/\n/g, '');
    expect(out).toContain("Failed to lock step removal 'deploy': ");
    expect(out).not.toContain('Failed to acquire the step lock');
    expect(existsSync(join(stepsDir(), 'deploy'))).toBe(true);
  });

  test('a symlinked lock uses neutral wording', async () => {
    symlinkSync(join(tmp, 'elsewhere'), join(projectDir, '.specify', '.step-install.lock'));
    expect(await runWorkflowStepCommand(['remove', 'deploy'])).toBe(1);
    expect(flat(output)).toContain('Refusing to use symlinked step lock');
  });

  test('restores the registry entry when the directory delete fails', async () => {
    const pkg = writePackage('dev-step');
    expect(await runWorkflowStepCommand(['add', 'dev-step', '--dev', pkg])).toBe(0);
    if (process.getuid && process.getuid() === 0) return;
    const { chmodSync } = await import('node:fs');
    const stepDir = join(stepsDir(), 'dev-step');
    chmodSync(stepDir, 0o555);
    try {
      output = '';
      expect(await runWorkflowStepCommand(['remove', 'dev-step'])).toBe(1);
    } finally {
      chmodSync(stepDir, 0o755);
    }
    expect(output).toContain('Failed to remove step directory');
    expect(new StepRegistry(projectDir).isInstalled('dev-step')).toBe(true);
  });

  test('a remove waiting on an install cannot resurrect or lose entries', () => {
    // The step lock is held for the whole critical section; a nested
    // acquisition would deadlock, so verify the transaction serialises by
    // observing the mutex directory while the body runs.
    stepInstallTransaction(projectDir, () => {
      expect(existsSync(join(projectDir, '.specify', '.step-install.lock.d'))).toBe(true);
    });
    expect(existsSync(join(projectDir, '.specify', '.step-install.lock.d'))).toBe(false);
  });
});

// ============================================================================
// Installer domain (test_installer.py)
// ============================================================================

describe('step installer', () => {
  test('validateStepId mirrors the CLI rules', () => {
    for (const bad of ['', ' ', ' x', 'a/b', 'a\\b', '.', '..', '.hidden', 'x.', 'x ', '.cache', 'step-registry.json', 'con', 'COM1.txt', 'a:b', 'a\u0001']) {
      expect(() => validateStepId(bad)).toThrow(StepInstallError);
    }
    expect(() => validateStepId('ok-step')).not.toThrow();
  });

  test('validateStepPackage shape errors', () => {
    const pkg = writePackage('my-step');
    expect(validateStepPackage(pkg, 'my-step')).toMatchObject({ type_key: 'my-step', version: '0.1.0' });
    expect(() => validateStepPackage(join(tmp, 'missing'), 'my-step')).toThrow('Step package directory not found');
    writeFileSync(join(pkg, 'step.yml'), '[]\n');
    expect(() => validateStepPackage(pkg, 'my-step')).toThrow('step.yml must be a YAML mapping');
    writeFileSync(join(pkg, 'step.yml'), 'step: []\n');
    expect(() => validateStepPackage(pkg, 'my-step')).toThrow("step.yml 'step' field must be a mapping");
    writeFileSync(join(pkg, 'step.yml'), '');
    expect(() => validateStepPackage(pkg, 'my-step')).toThrow("step.yml missing 'step.type_key' field");
    writeFileSync(join(pkg, 'step.yml'), 'step: {type_key: [\n');
    expect(() => validateStepPackage(pkg, 'my-step')).toThrow('Invalid step.yml:');
    rmSync(join(pkg, 'step.yml'));
    expect(() => validateStepPackage(pkg, 'my-step')).toThrow("missing required file 'step.yml'");
  });

  test('rejects symlinks, special files and the depth / entry / byte limits', () => {
    const pkg = writePackage('my-step');
    symlinkSync(join(pkg, 'step.yml'), join(pkg, 'alias.yml'));
    expect(() => validateStepPackage(pkg, 'my-step')).toThrow('Step package contains symlink');
    rmSync(join(pkg, 'alias.yml'));

    let deep = pkg;
    for (let i = 0; i < 3; i++) {
      deep = join(deep, `d${i}`);
      mkdirSync(deep);
    }
    stepPackageLimits.maxDepth = 2;
    expect(() => validateStepPackage(pkg, 'my-step')).toThrow('exceeds the 2-level directory depth limit');
    stepPackageLimits.maxDepth = 32;

    stepPackageLimits.maxFiles = 3;
    expect(() => validateStepPackage(pkg, 'my-step')).toThrow('too many entries, exceeding the 3-entry limit');
    stepPackageLimits.maxFiles = 512;

    stepPackageLimits.maxBytes = 10;
    expect(() => validateStepPackage(pkg, 'my-step')).toThrow('Step package exceeds the 10-byte total size limit');
  });

  test('excluded names are pruned, not inspected or copied', () => {
    const pkg = writePackage('my-step');
    mkdirSync(join(pkg, '.git', 'objects'), { recursive: true });
    symlinkSync('/etc/passwd', join(pkg, '.git', 'link'));
    mkdirSync(join(pkg, '__pycache__'));
    writeFileSync(join(pkg, '.DS_Store'), 'x');
    stepPackageLimits.maxFiles = 2;
    expect(validateStepPackage(pkg, 'my-step').type_key).toBe('my-step');
    stepPackageLimits.maxFiles = 512;
    installStepPackage(projectDir, 'my-step', pkg, { source: 'local' });
    expect(readdirSync(join(stepsDir(), 'my-step')).sort()).toEqual(['__init__.py', 'step.yml']);
  });

  test('resolvePackageRoot', () => {
    const root = join(tmp, 'x');
    mkdirSync(join(root, 'only'), { recursive: true });
    writeFileSync(join(root, 'only', 'step.yml'), '');
    expect(resolvePackageRoot(root)).toBe(join(root, 'only'));
    writeFileSync(join(root, 'step.yml'), '');
    expect(resolvePackageRoot(root)).toBe(root);
  });

  test('registry entries record provenance and catalog metadata', () => {
    const pkg = writePackage('my-step');
    const entry = installStepPackage(projectDir, 'my-step', pkg, {
      source: 'catalog',
      catalogName: 'official',
      catalogMetadata: { name: 'Catalog Name', description: '', author: null },
    });
    expect(entry).toEqual({
      name: 'Catalog Name',
      version: '0.1.0',
      description: '',
      author: '',
      type_key: 'my-step',
      source: 'catalog',
      catalog_name: 'official',
    });
    const pkg2 = writePackage('other-step');
    expect(() => installStepPackage(projectDir, 'other-step', pkg2, { source: 'git' })).toThrow(
      'Step install source must be one of: catalog, local, url',
    );
    expect(() =>
      installStepPackage(projectDir, 'other-step', pkg2, { source: 'catalog', catalogName: 'x', catalogMetadata: { version: 2 } }),
    ).toThrow("step metadata 'version' must be a string when present");
    expect(existsSync(join(stepsDir(), 'other-step'))).toBe(false);
  });

  test('built-in collisions, case-insensitive duplicates and source == destination', () => {
    const shell = writePackage('shell');
    expect(() => installStepPackage(projectDir, 'shell', shell, { source: 'local' })).toThrow(
      "Step type 'shell' conflicts with a built-in step type",
    );
    const pkg = writePackage('my-step');
    installStepPackage(projectDir, 'my-step', pkg, { source: 'local' });
    const upper = writePackage('My-Step');
    expect(() => installStepPackage(projectDir, 'My-Step', upper, { source: 'local', force: true })).toThrow(
      "collides case-insensitively with registered step ID 'my-step'",
    );
    expect(() =>
      installStepPackage(projectDir, 'my-step', join(stepsDir(), 'my-step'), { source: 'local', force: true }),
    ).toThrow('Step package source resolves to the install destination');
    expect(() => checkInstallable(projectDir, 'my-step')).toThrow("Step type 'my-step' is already installed");
    expect(checkInstallable(projectDir, 'my-step', { force: true })).toBe(join(realpathSync(stepsDir()), 'my-step'));
  });

  test('a registry failure rolls back a fresh install', () => {
    const pkg = writePackage('my-step');
    const realAdd = StepRegistry.prototype.add;
    StepRegistry.prototype.add = function () {
      throw new StepValidationError('boom');
    };
    try {
      expect(() => installStepPackage(projectDir, 'my-step', pkg, { source: 'local' })).toThrow();
    } finally {
      StepRegistry.prototype.add = realAdd;
    }
    expect(existsSync(join(stepsDir(), 'my-step'))).toBe(false);
  });

  test('a --force replace failure explains how to recover', () => {
    const pkg = writePackage('my-step');
    installStepPackage(projectDir, 'my-step', pkg, { source: 'local' });
    installerDeps.replace = () => {
      throw Object.assign(new Error('replace blocked'), { code: 'EACCES' });
    };
    expect(() => installStepPackage(projectDir, 'my-step', pkg, { source: 'local', force: true })).toThrow(
      'The previous installation was removed; reinstall from the original source with --force.',
    );
  });

  test('a staging cleanup failure after commit warns; before commit it is a note', () => {
    const warnings: string[] = [];
    installerDeps.warn = (m) => warnings.push(m);
    const realRm = realDeps.rmtree;
    installerDeps.rmtree = (p) => {
      if (p.includes('.speckit-step-install-')) throw new Error('cleanup blocked');
      realRm(p);
    };
    const pkg = writePackage('my-step');
    installStepPackage(projectDir, 'my-step', pkg, { source: 'local' });
    expect(warnings.some((w) => w.includes('Could not remove step staging directory'))).toBe(true);
    const bad = writePackage('bad-step');
    writeFileSync(join(bad, 'step.yml'), 'step:\n  type_key: other\n');
    // Validation fails before staging, so nothing to clean up.
    expect(() => installStepPackage(projectDir, 'bad-step', bad, { source: 'local' })).toThrow('does not match step ID');
    for (const name of readdirSync(stepsDir())) {
      if (name.startsWith('.speckit-step-install-')) rmSync(join(stepsDir(), name), { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Custom step loading (test_custom_steps.py)
// ============================================================================

describe('loadCustomSteps', () => {
  test('custom steps from a previous project are unloaded', async () => {
    const pkg = writePackage('proj-a-step', { init: null, js: jsStep('proj-a-step') });
    installStepPackage(projectDir, 'proj-a-step', pkg, { source: 'local' });
    expect(await loadCustomSteps(projectDir)).toEqual(['proj-a-step']);
    expect(STEP_REGISTRY.has('proj-a-step')).toBe(true);

    const other = join(tmp, 'other');
    mkdirSync(join(other, '.specify'), { recursive: true });
    expect(await loadCustomSteps(other)).toEqual([]);
    expect(STEP_REGISTRY.has('proj-a-step')).toBe(false);
    for (const builtin of BUILTIN_STEP_TYPES) expect(STEP_REGISTRY.has(builtin)).toBe(true);
  });

  test('a reinstalled package is re-imported, not served from the module cache', async () => {
    const pkg = writePackage('swap-step', { init: null, js: jsStep('swap-step', 'First') });
    installStepPackage(projectDir, 'swap-step', pkg, { source: 'local' });
    await loadCustomSteps(projectDir);
    expect(STEP_REGISTRY.get('swap-step')!.constructor.name).toBe('First');
    writeFileSync(join(pkg, 'index.mjs'), jsStep('swap-step', 'Second'));
    installStepPackage(projectDir, 'swap-step', pkg, { source: 'local', force: true });
    await loadCustomSteps(projectDir);
    expect(STEP_REGISTRY.get('swap-step')!.constructor.name).toBe('Second');
  });

  test('Python-only packages install but do not load (ADAPTATION)', async () => {
    const pkg = writePackage('py-step');
    installStepPackage(projectDir, 'py-step', pkg, { source: 'local' });
    expect(await loadCustomSteps(projectDir)).toEqual([]);
  });
});

// Keep the unused-import checker quiet for helpers only some platforms use.
void StepCatalogError;
