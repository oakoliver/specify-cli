/**
 * Workflow / step catalog maintenance in spec-kit 1.2.5: removing the source
 * shown at the listed index (#4870), confined catalog cache I/O (#4931),
 * ``workflow update`` loading custom steps and accepting equivalent version
 * spellings (#4768, #5155), the ``workflow resolve`` tie-break header
 * (#4542) and the shared exclusive project lock (#4769).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpResponse } from '../src/authentication/http.js';
import { console as stdoutConsole, errConsole, setPromptInput } from '../src/console.js';
import { exclusiveProjectLock } from '../src/shared-infra.js';
import { dumpYaml, parseYaml } from '../src/yaml.js';
import { readCacheJson, writeCacheJson } from '../src/workflows/catalog-cache.js';
import {
  WorkflowCatalog,
  WorkflowRegistry,
  WorkflowValidationError,
  catalogLogger,
  httpDeps,
} from '../src/workflows/catalog/domain.js';
import { runWorkflowCommand } from '../src/workflows/commands.js';
import { STEP_REGISTRY, BUILTIN_STEP_TYPES } from '../src/workflows/index.js';
import { StepCatalog, StepValidationError } from '../src/workflows/step/catalog/domain.js';
import { makeTarGz, makeZip } from './archive-helpers.js';

type Dict = Record<string, unknown>;

let tmp: string;
let projectDir: string;
let prevCwd: string;
let prevHome: string | undefined;
let output: string;
let prevOut: unknown;
let prevErr: unknown;
const realOpenUrl = httpDeps.openUrl;
const realWarning = catalogLogger.warning;
const wfProto = WorkflowCatalog.prototype as unknown as Dict;
const realWfInfo = wfProto.getWorkflowInfo;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wf-maint-'));
  projectDir = join(tmp, 'proj');
  mkdirSync(join(projectDir, '.specify', 'workflows'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectDir);
  prevHome = process.env.HOME;
  process.env.HOME = join(tmp, 'home');
  delete process.env.SPECKIT_WORKFLOW_CATALOG_URL;
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
  delete process.env.SPECKIT_WORKFLOW_CATALOG_URL;
  delete process.env.SPECKIT_STEP_CATALOG_URL;
  (stdoutConsole as unknown as { opts: Dict }).opts.file = prevOut;
  (errConsole as unknown as { opts: Dict }).opts.file = prevErr;
  httpDeps.openUrl = realOpenUrl;
  catalogLogger.warning = realWarning;
  wfProto.getWorkflowInfo = realWfInfo;
  setPromptInput(null);
  for (const key of [...STEP_REGISTRY.keys()]) if (!BUILTIN_STEP_TYPES.has(key)) STEP_REGISTRY.delete(key);
  rmSync(tmp, { recursive: true, force: true });
});

const flat = (s: string): string => s.split(/\s+/).join(' ');

// ============================================================================
// Catalog removal by listed index (#4870)
// ============================================================================

const KINDS = [
  { kind: 'workflow', make: () => new WorkflowCatalog(projectDir), error: WorkflowValidationError },
  { kind: 'step', make: () => new StepCatalog(projectDir), error: StepValidationError },
] as const;

for (const { kind, make, error } of KINDS) {
  describe(`${kind} catalog remove uses the listed position`, () => {
    const config = (): string => join(projectDir, '.specify', `${kind}-catalogs.yml`);
    const envKey = `SPECKIT_${kind.toUpperCase()}_CATALOG_URL`;

    for (const [index, originalIndex] of [
      [0, 2],
      [1, 4],
      [2, 3],
      [3, 1],
    ]) {
      test(`index ${index} removes source ${originalIndex}`, () => {
        const data = {
          notes: 'keep',
          catalogs: [
            { name: 'skipped', url: '  ' },
            { name: 'duplicate', url: 'https://example.com/low.json', priority: 10 },
            { name: 'duplicate', url: 'https://example.com/first.json', priority: '2' },
            { url: 'https://example.com/unnamed.json' },
            { name: 'duplicate', url: 'https://example.com/tied.json', priority: 2 },
          ],
        };
        writeFileSync(config(), dumpYaml(data, { sortKeys: false }));
        const catalog = make();
        const selected = catalog.getCatalogConfigs()[index as number]!;
        expect(selected.url).toBe(data.catalogs[originalIndex as number]!.url);
        expect(catalog.removeCatalog(index as number)).toBe(selected.name);
        data.catalogs.splice(originalIndex as number, 1);
        expect(parseYaml(readFileSync(config(), 'utf-8'))).toEqual(data);
      });
    }

    for (const index of [-1, 1]) {
      test(`bounds use visible entries (${index})`, () => {
        writeFileSync(config(), '# keep this comment\ncatalogs:\n  - name: skipped\n  - url: https://example.com/only.json\n');
        const before = readFileSync(config());
        expect(() => make().removeCatalog(index)).toThrow('out of range');
        expect(readFileSync(config())).toEqual(before);
      });
    }

    test('refuses an environment source and leaves the file untouched', () => {
      const catalog = make();
      catalog.addCatalog('https://example.com/project.json', 'project');
      const before = readFileSync(config());
      process.env[envKey] = ' https://example.com/override.json ';
      expect(catalog.getCatalogConfigs()[0]!.name).toBe('env-override');
      let caught: unknown;
      try {
        catalog.removeCatalog(0);
      } catch (exc) {
        caught = exc;
      }
      expect(caught).toBeInstanceOf(error);
      expect((caught as Error).message).toBe(
        `The active catalog comes from ${envKey}. Unset that variable to remove a project catalog source.`,
      );
      expect(readFileSync(config())).toEqual(before);
    });

    test('ignores a blank environment override', () => {
      const catalog = make();
      catalog.addCatalog('https://example.com/project.json', 'project');
      process.env[envKey] = '   ';
      expect(catalog.removeCatalog(0)).toBe('project');
    });
  });
}

describe('workflow catalog remove CLI', () => {
  test('removes the entry printed by catalog list', async () => {
    const config = join(projectDir, '.specify', 'workflow-catalogs.yml');
    const data = {
      notes: 'keep',
      catalogs: [
        { name: 'team', url: 'https://example.com/team.json', priority: 10 },
        { name: 'review', url: 'https://example.com/review.json', priority: 1 },
      ],
    };
    writeFileSync(config, dumpYaml(data, { sortKeys: false }));
    expect(await runWorkflowCommand(['catalog', 'list'])).toBe(0);
    expect(output).toContain('[0] review');
    output = '';
    expect(await runWorkflowCommand(['catalog', 'remove', '0'])).toBe(0);
    expect(output).toContain("'review' removed");
    data.catalogs.splice(1, 1);
    expect(parseYaml(readFileSync(config, 'utf-8'))).toEqual(data);
  });

  test('refuses an environment source', async () => {
    const config = join(projectDir, '.specify', 'workflow-catalogs.yml');
    writeFileSync(config, '# keep\ncatalogs:\n  - name: project\n    url: https://example.com/project.json\n');
    const before = readFileSync(config);
    process.env.SPECKIT_WORKFLOW_CATALOG_URL = 'https://example.com/override.json';
    expect(await runWorkflowCommand(['catalog', 'list'])).toBe(0);
    expect(output).toContain('[0] env-override');
    output = '';
    expect(await runWorkflowCommand(['catalog', 'remove', '0'])).toBe(1);
    expect(output).toContain('SPECKIT_WORKFLOW_CATALOG_URL');
    expect(output).toContain('Unset');
    expect(readFileSync(config)).toEqual(before);
  });
});

// ============================================================================
// Catalog cache confinement (#4931)
// ============================================================================

const URL = 'https://example.com/catalog.json';
const SENTINEL = 'isolated target must remain unchanged\n';

for (const { kind, make } of KINDS) {
  describe(`${kind} catalog cache confinement`, () => {
    const key = kind === 'workflow' ? 'workflows' : 'steps';
    const entry = { url: URL, name: 'test', priority: 1, install_allowed: true, description: '' };
    let calls: string[];

    beforeEach(() => {
      calls = [];
      httpDeps.openUrl = (async (url: string) => {
        calls.push(url);
        return new HttpResponse(new Response(JSON.stringify({ [key]: {} })), URL);
      }) as typeof httpDeps.openUrl;
    });

    for (const leaf of [0, 1]) {
      for (const dangling of [false, true]) {
        test(`a symlinked cache leaf cannot redirect the write (${leaf ? 'metadata' : 'data'}, dangling=${dangling})`, async () => {
          const catalog = make();
          const paths = catalog.getCachePaths(URL);
          mkdirSync(join(paths[0], '..'), { recursive: true });
          const target = join(tmp, 'target.txt');
          if (!dangling) writeFileSync(target, SENTINEL);
          symlinkSync(target, paths[leaf]!);
          await catalog.fetchSingleCatalog(entry, true);
          expect(lstatSync(paths[leaf]!).isSymbolicLink()).toBe(false);
          if (dangling) expect(existsSync(target)).toBe(false);
          else expect(readFileSync(target, 'utf-8')).toBe(SENTINEL);
        });
      }
    }

    const ancestors = kind === 'workflow' ? ['.specify', 'workflows', '.cache'] : ['.specify', 'workflows', 'steps', '.cache'];
    for (const ancestor of ancestors) {
      test(`a symlinked cache ancestor cannot redirect the write (${ancestor})`, async () => {
        const catalog = make();
        const outside = join(tmp, 'outside');
        mkdirSync(outside);
        const [cacheFile] = catalog.getCachePaths(URL);
        const parts = cacheFile.slice(projectDir.length + 1).split('/');
        const linkPath = join(projectDir, ...parts.slice(0, parts.indexOf(ancestor) + 1));
        if (ancestor !== '.cache') {
          // Move the real tree aside and point the ancestor at it.
          const moved = join(outside, ancestor);
          rmSync(linkPath, { recursive: true, force: true });
          mkdirSync(moved, { recursive: true });
          symlinkSync(moved, linkPath);
        } else {
          mkdirSync(join(linkPath, '..'), { recursive: true });
          symlinkSync(outside, linkPath);
        }
        const warnings: string[] = [];
        catalogLogger.warning = (m) => warnings.push(m);
        const data = await catalog.fetchSingleCatalog(entry, true).catch(() => null);
        if (data !== null) expect(data).toEqual({ [key]: {} });
        const { readdirSync } = await import('node:fs');
        const found: string[] = [];
        const walk = (dir: string): void => {
          for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (lstatSync(p).isDirectory()) walk(p);
            else found.push(name);
          }
        };
        walk(outside);
        expect(found.filter((n) => n.endsWith('.json'))).toEqual([]);
      });
    }

    test('a regular cache is fresh, refreshed and used as a stale fallback', async () => {
      const catalog = make();
      await catalog.fetchSingleCatalog(entry);
      expect(calls.length).toBe(1);
      await catalog.fetchSingleCatalog(entry);
      expect(calls.length).toBe(1);
      await catalog.fetchSingleCatalog(entry, true);
      expect(calls.length).toBe(2);
      httpDeps.openUrl = (async () => {
        throw new Error('offline');
      }) as typeof httpDeps.openUrl;
      expect(await catalog.fetchSingleCatalog(entry, true)).toEqual({ [key]: {} });
    });

    for (const leaf of [0, 1]) {
      test(`a symlinked cache leaf is not read (${leaf ? 'metadata' : 'data'})`, async () => {
        const catalog = make();
        const paths = catalog.getCachePaths(URL);
        mkdirSync(join(paths[0], '..'), { recursive: true });
        const outside = join(tmp, 'outside.json');
        writeFileSync(
          outside,
          leaf ? JSON.stringify({ url: URL, fetched_at: Date.now() / 1000 }) : JSON.stringify({ [key]: { planted: {} } }),
        );
        symlinkSync(outside, paths[leaf]!);
        if (leaf === 0) writeFileSync(paths[1]!, JSON.stringify({ url: URL, fetched_at: Date.now() / 1000 }));
        expect(catalog.isUrlCacheValid(URL)).toBe(leaf === 0);
        const data = await catalog.fetchSingleCatalog(entry);
        expect(data).toEqual({ [key]: {} });
        expect(calls.length).toBe(1);
      });
    }

    test('replacement preserves a hardlinked target', async () => {
      const catalog = make();
      await catalog.fetchSingleCatalog(entry);
      const [cacheFile] = catalog.getCachePaths(URL);
      const other = join(tmp, 'hardlink.json');
      linkSync(cacheFile, other);
      const before = readFileSync(other, 'utf-8');
      await catalog.fetchSingleCatalog(entry, true);
      expect(readFileSync(other, 'utf-8')).toBe(before);
    });

    test('a failed write keeps discovery going and logs a warning', async () => {
      const catalog = make();
      const [cacheFile] = catalog.getCachePaths(URL);
      mkdirSync(join(cacheFile, '..', '..'), { recursive: true });
      writeFileSync(join(cacheFile, '..'), 'not a directory');
      const warnings: string[] = [];
      catalogLogger.warning = (m) => warnings.push(m);
      expect(await catalog.fetchSingleCatalog(entry)).toEqual({ [key]: {} });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain(`Could not safely cache ${kind} catalog ${URL}:`);
    });

    test('the search CLI works with a confined cache', async () => {
      const config = join(projectDir, '.specify', `${kind}-catalogs.yml`);
      writeFileSync(config, `catalogs:\n  - name: test\n    url: ${URL}\n    install_allowed: true\n`);
      const args = kind === 'workflow' ? ['search'] : ['step', 'search'];
      expect(await runWorkflowCommand(args)).toBe(0);
      expect(calls).toEqual([URL]);
    });
  });
}

describe('catalog cache primitives', () => {
  test('writeCacheJson / readCacheJson round-trip and refuse escapes', () => {
    const p = join(projectDir, '.specify', 'workflows', '.cache', 'x.json');
    writeCacheJson(projectDir, p, '{"a": 1}');
    expect(readCacheJson(projectDir, p)).toEqual({ a: 1 });
    expect(() => readCacheJson(projectDir, join(tmp, 'elsewhere.json'))).toThrow('Catalog cache escapes project root');
    mkdirSync(join(projectDir, '.specify', 'workflows', '.cache', 'dir.json'));
    expect(() => readCacheJson(projectDir, join(projectDir, '.specify', 'workflows', '.cache', 'dir.json'))).toThrow(
      'not a regular file',
    );
    expect(() => readCacheJson(projectDir, join(projectDir, '.specify', 'missing', 'x.json'))).toThrow();
  });
});

// ============================================================================
// workflow update (#4768, #5155)
// ============================================================================

const WORKFLOW_YAML = (version: string): string =>
  'schema_version: "1.0"\n' +
  `workflow:\n  id: "align-wf"\n  name: "Align Workflow"\n  version: "${version}"\n` +
  '  description: "CLI alignment test workflow"\n' +
  'steps:\n  - id: s1\n    type: shell\n    run: "echo hi"\n';

function download(data: string, sourceType: string): [string, Uint8Array | string] {
  if (sourceType === 'yml') return ['https://example.com/workflow.yml', data];
  const files = { 'workflow.yml': data, 'README.md': 'Workflow companion file' };
  if (sourceType === 'zip') return ['https://example.com/workflow.zip', makeZip(files)];
  return ['https://example.com/workflow.tar.gz', makeTarGz(files)];
}

function canonical(v: string): string {
  return v
    .split('.')
    .map((p) => String(parseInt(p, 10)))
    .join('.');
}

describe('workflow update', () => {
  for (const sourceType of ['yml', 'zip', 'tar.gz']) {
    for (const [installed, available] of [
      ['1.0.0', '2.0.0'],
      ['2024.01.15', '2024.02.01'],
      ['2024.01.15', '2024.2.1'],
      ['2024.1.15', '2024.02.01'],
    ]) {
      test(`installs a newer catalog version (${sourceType}, ${installed} -> ${available})`, async () => {
        const [url, body] = download(WORKFLOW_YAML(available as string), sourceType);
        new WorkflowRegistry(projectDir).add('align-wf', {
          name: 'Align Workflow',
          version: installed,
          description: 'CLI alignment test workflow',
          source: 'catalog',
          catalog_name: 'test-catalog',
          url,
        });
        const wfDir = join(projectDir, '.specify', 'workflows', 'align-wf');
        mkdirSync(wfDir, { recursive: true });
        writeFileSync(join(wfDir, 'workflow.yml'), WORKFLOW_YAML(installed as string));
        wfProto.getWorkflowInfo = async (wid: string) => ({
          id: wid,
          name: 'Align Workflow',
          version: available,
          url,
          _install_allowed: true,
          _catalog_name: 'test-catalog',
        });
        httpDeps.openUrl = (async (u: string) =>
          new HttpResponse(new Response(typeof body === 'string' ? body : Buffer.from(body)), u)) as typeof httpDeps.openUrl;
        setPromptInput(['y']);
        expect(await runWorkflowCommand(['update'])).toBe(0);
        expect(output).toContain(`${canonical(installed as string)} → ${canonical(available as string)}`);
        expect((new WorkflowRegistry(projectDir).get('align-wf') as Dict).version).toBe(available);
        expect(readFileSync(join(wfDir, 'workflow.yml'), 'utf-8')).toBe(WORKFLOW_YAML(available as string));
      });
    }
  }

  test('loads custom steps before validating the updated workflow', async () => {
    const BASE_TS = new globalThis.URL('../src/workflows/base.ts', import.meta.url).href;
    const stepDir = join(projectDir, '.specify', 'workflows', 'steps', 'update-step');
    mkdirSync(stepDir, { recursive: true });
    writeFileSync(join(stepDir, 'step.yml'), 'step:\n  type_key: "update-step"\n  version: "1.0.0"\n');
    writeFileSync(
      join(stepDir, 'index.mjs'),
      `import { StepBase, StepResult } from '${BASE_TS}';\n` +
        "export class UpdateStep extends StepBase { static typeKey = 'update-step'; execute() { return new StepResult(); } }\n",
    );
    const yaml = WORKFLOW_YAML('2.0.0').replace('type: shell\n    run: "echo hi"', 'type: update-step');
    new WorkflowRegistry(projectDir).add('align-wf', {
      name: 'Align Workflow',
      version: '1.0.0',
      source: 'catalog',
      url: 'https://example.com/workflow.yml',
    });
    wfProto.getWorkflowInfo = async (wid: string) => ({
      id: wid,
      version: '2.0.0',
      url: 'https://example.com/workflow.yml',
      _install_allowed: true,
    });
    httpDeps.openUrl = (async (u: string) => new HttpResponse(new Response(yaml), u)) as typeof httpDeps.openUrl;
    setPromptInput(['y']);
    expect(await runWorkflowCommand(['update', 'align-wf'])).toBe(0);
    expect((new WorkflowRegistry(projectDir).get('align-wf') as Dict).version).toBe('2.0.0');
  });
});

// ============================================================================
// workflow resolve header (#4542)
// ============================================================================

describe('workflow resolve', () => {
  test('the header states the equal-priority tie-break', async () => {
    const wfDir = join(projectDir, '.specify', 'workflows', 'wf');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, 'workflow.yml'),
      dumpYaml({
        schema_version: '1.0',
        workflow: { id: 'wf', name: 'WF', version: '1.0.0' },
        steps: [{ id: 'build', type: 'command', command: 'echo BASE' }],
      }),
    );
    const ovDir = join(projectDir, '.specify', 'workflows', 'overlays', 'wf');
    mkdirSync(ovDir, { recursive: true });
    for (const id of ['alpha', 'beta']) {
      writeFileSync(
        join(ovDir, `${id}.yml`),
        dumpYaml({
          id,
          extends: 'wf',
          priority: 10,
          edits: [
            {
              operation: 'replace',
              anchor: 'build',
              step: { id: 'build', type: 'command', command: `echo FROM-${id.toUpperCase()}` },
            },
          ],
        }),
      );
    }
    expect(await runWorkflowCommand(['resolve', 'wf'])).toBe(0);
    expect(flat(output)).toContain('build: project:beta');
    expect(flat(output)).toContain('Layers (highest precedence first; on equal priority the last ID wins):');
  });
});

// ============================================================================
// Shared exclusive project lock (tests/test_shared_infra_lock.py)
// ============================================================================

describe('exclusiveProjectLock', () => {
  test('runs the body, creates the lock file and releases the mutex', () => {
    const value = exclusiveProjectLock(projectDir, '.x.lock', { context: 'x' }, () => 42);
    expect(value).toBe(42);
    expect(existsSync(join(projectDir, '.specify', '.x.lock'))).toBe(true);
    expect(existsSync(join(projectDir, '.specify', '.x.lock.d'))).toBe(false);
  });

  test('body errors propagate unchanged and release the lock', () => {
    const boom = new Error('boom');
    expect(() =>
      exclusiveProjectLock(projectDir, '.x.lock', { context: 'x' }, () => {
        throw boom;
      }),
    ).toThrow(boom);
    expect(existsSync(join(projectDir, '.specify', '.x.lock.d'))).toBe(false);
  });

  test('async bodies hold the lock until settled', async () => {
    let held = false;
    await exclusiveProjectLock(projectDir, '.x.lock', { context: 'x' }, async () => {
      await Promise.resolve();
      held = existsSync(join(projectDir, '.specify', '.x.lock.d'));
    });
    expect(held).toBe(true);
    expect(existsSync(join(projectDir, '.specify', '.x.lock.d'))).toBe(false);
  });

  test('refuses a symlinked lock file and a symlinked .specify', () => {
    symlinkSync(join(tmp, 'elsewhere'), join(projectDir, '.specify', '.x.lock'));
    expect(() => exclusiveProjectLock(projectDir, '.x.lock', { context: 'x' }, () => 1)).toThrow(
      'Refusing to use symlinked x lock:',
    );
    expect(readlinkSync(join(projectDir, '.specify', '.x.lock'))).toBe(join(tmp, 'elsewhere'));
    const other = join(tmp, 'other');
    mkdirSync(join(tmp, 'real-specify'));
    mkdirSync(other);
    symlinkSync(join(tmp, 'real-specify'), join(other, '.specify'));
    let caught: unknown;
    try {
      exclusiveProjectLock(other, '.x.lock', { context: 'x' }, () => 1);
    } catch (exc) {
      caught = exc;
    }
    expect((caught as NodeJS.ErrnoException).name).toBe('OSError');
    expect((caught as Error).message).toContain('x lock directory');
  });
});
