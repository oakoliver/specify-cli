/**
 * Scoped FileHelper (#4908) and persisted project symlink policy (#4934).
 *
 * Ports of upstream tests/test_file_helper.py and
 * tests/specify_cli/test_file_policy.py (spec-kit v1.2.5). Windows-only
 * cases (reparse points, junctions, extended-length spellings) are skipped
 * like upstream does on POSIX hosts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  FileHelper,
  FileHelperError,
  PathEscapeError,
  SymlinkDeniedError,
  UnsupportedPathError,
} from '../src/file-helper.js';
import {
  ProjectPolicyError,
  prepareInitRoot,
  preflightInitRoot,
  projectFiles,
  readProjectOptions,
  saveProjectOptions,
} from '../src/file-policy.js';
import { main } from '../src/cli.js';
import { projectErrorContext, resolveSpecifyProjectFiles } from '../src/project.js';
import { console as appConsole, errConsole, setPromptInput } from '../src/console.js';

let tmp: string;
let root: string;
const prevCwd = process.cwd();
const savedEnv = { ...process.env };

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-filehelper-')));
  root = join(tmp, 'project');
  mkdirSync(root);
});

afterEach(() => {
  process.chdir(prevCwd);
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  projectErrorContext.json = false;
  rmSync(tmp, { recursive: true, force: true });
});

function link(path: string, target: string): string {
  let isDir = false;
  try {
    isDir = statSync(target.startsWith('/') ? target : join(dirname(path), target)).isDirectory();
  } catch {
    isDir = false;
  }
  symlinkSync(target, path, isDir ? 'dir' : 'file');
  return path;
}

const lexists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

// ============================================================================
// FileHelper (tests/test_file_helper.py)
// ============================================================================

describe('FileHelper', () => {
  for (const allow of [false, true]) {
    test(`plain operations (allow=${allow})`, () => {
      const files = new FileHelper(root, { allowSymlinks: allow });
      files.mkdir('nested/child', { parents: true });
      files.mkdir('nested/child', { existOk: true });
      files.createText('nested/child/text', 'café\n');
      expect(files.readText('nested/child/text')).toBe('café\n');
      files.writeText('nested/child/text', 'updated');
      expect(files.readBytes(join(root, 'nested/child/text')).toString()).toBe('updated');
      files.writeBytes('nested/child/new', Buffer.from([0x00, 0xff]));
      expect([...files.readBytes('nested/child/new')]).toEqual([0x00, 0xff]);
      files.createBytes('binary', Buffer.from([0xff]), 0o600);
      files.delete('binary');
      expect(existsSync(join(root, 'binary'))).toBe(false);
      files.delete('nested', { recursive: true });
      expect(readdirSync(root)).toEqual([]);
    });

    test(`overwriteText preserves inode and mode (allow=${allow})`, () => {
      const files = new FileHelper(root, { allowSymlinks: allow });
      files.overwriteText('config', 'café\n');
      const p = join(root, 'config');
      const inode = statSync(p).ino;
      chmodSync(p, 0o600);
      files.overwriteText('config', 'updated\n');
      expect(statSync(p).ino).toBe(inode);
      expect(readFileSync(p, 'utf8')).toBe('updated\n');
      expect(statSync(p).mode & 0o777).toBe(0o600);
    });
  }

  for (const kind of ['leaf', 'parent', 'dangling']) {
    test(`overwriteText deny preflights links (${kind})`, () => {
      const target = join(root, 'target');
      mkdirSync(target);
      writeFileSync(join(target, 'file'), 'old');
      const p =
        kind === 'parent'
          ? join(link(join(root, 'alias'), target), 'file')
          : link(join(root, 'alias'), join(target, kind === 'dangling' ? 'missing' : 'file'));
      expect(() => new FileHelper(root).overwriteText(p, 'new')).toThrow(SymlinkDeniedError);
      expect(readFileSync(join(target, 'file'), 'utf8')).toBe('old');
      expect(existsSync(join(target, 'missing'))).toBe(false);
    });
  }

  test('overwriteText with allow updates the target, not the link chain', () => {
    const target = join(root, 'target');
    writeFileSync(target, 'old');
    const alias = link(join(root, 'alias'), target);
    const chain = link(join(root, 'chain'), 'alias');
    new FileHelper(root, { allowSymlinks: true }).overwriteText(chain, 'new');
    expect(lstatSync(alias).isSymbolicLink() && lstatSync(chain).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('new');
  });

  for (const allow of [false, true]) {
    for (const kind of ['dangling', 'external', 'cycle']) {
      test(`overwriteText rejects unsafe link targets (${kind}, allow=${allow})`, () => {
        const outside = join(tmp, 'outside');
        writeFileSync(outside, 'unchanged');
        const target = kind === 'external' ? outside : kind === 'cycle' ? join(root, 'alias') : join(root, 'missing');
        const alias = link(join(root, 'alias'), target);
        let thrown: unknown = null;
        try {
          new FileHelper(root, { allowSymlinks: allow }).overwriteText(alias, 'new');
        } catch (e) {
          thrown = e;
        }
        expect(thrown instanceof FileHelperError || (thrown as { code?: string })?.code === 'ENOENT').toBe(true);
        expect(readFileSync(outside, 'utf8')).toBe('unchanged');
        expect(existsSync(join(root, 'missing'))).toBe(false);
        expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      });
    }

    test(`write through a contained linked parent (allow=${allow})`, () => {
      mkdirSync(join(root, 'directory'));
      const alias = link(join(root, 'alias'), join(root, 'directory'));
      const files = new FileHelper(root, { allowSymlinks: allow });
      if (allow) {
        files.overwriteText(join(alias, 'new'), 'content');
        expect(readFileSync(join(root, 'directory/new'), 'utf8')).toBe('content');
      } else {
        expect(() => files.overwriteText(join(alias, 'new'), 'content')).toThrow(SymlinkDeniedError);
        expect(existsSync(join(root, 'directory/new'))).toBe(false);
      }
    });
  }

  for (const op of ['mkdir', 'createBytes', 'writeBytes', 'delete'] as const) {
    test(`dangling parent cannot be used for mutation (${op})`, () => {
      const alias = link(join(root, 'alias'), join(root, 'missing'));
      const files = new FileHelper(root, { allowSymlinks: true });
      const p = join(alias, 'child');
      const run = (): unknown =>
        op === 'createBytes' || op === 'writeBytes' ? files[op](p, Buffer.from('bad')) : op === 'mkdir' ? files.mkdir(p) : files.delete(p);
      expect(code(run)).toBe('ENOENT');
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(existsSync(join(root, 'missing'))).toBe(false);
    });
  }

  test('multi-link cycle and excessive chain fail explicitly', () => {
    link(join(root, 'first'), 'second');
    link(join(root, 'second'), 'first');
    const files = new FileHelper(root, { allowSymlinks: true });
    expect(() => files.readBytes('first')).toThrow(/cycle/);
    writeFileSync(join(root, 'target'), 'ok');
    for (let i = 40; i >= 0; i--) link(join(root, `chain-${i}`), i === 40 ? 'target' : `chain-${i + 1}`);
    expect(() => files.readBytes('chain-0')).toThrow(UnsupportedPathError);
    expect(() => files.readBytes('chain-0')).toThrow(/excessive chain/);
  });

  for (const op of ['readBytes', 'writeBytes', 'mkdir', 'createBytes', 'delete'] as const) {
    test(`external parent is never traversed (${op})`, () => {
      const outside = join(tmp, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'file'), 'old');
      const alias = link(join(root, 'alias'), outside);
      const files = new FileHelper(root, { allowSymlinks: true });
      const p = join(alias, 'file');
      const run = (): unknown =>
        op === 'writeBytes' || op === 'createBytes'
          ? files[op](p, Buffer.from('new'))
          : op === 'mkdir'
            ? files.mkdir(p)
            : op === 'delete'
              ? files.delete(p)
              : files.readBytes(p);
      expect(run).toThrow(PathEscapeError);
      expect(readFileSync(join(outside, 'file'), 'utf8')).toBe('old');
    });
  }

  for (const kind of ['file', 'directory', 'external', 'dangling', 'cycle']) {
    test(`allow: leaf delete unlinks only the link (${kind})`, () => {
      let target = join(root, 'target');
      if (kind === 'file') writeFileSync(target, 'keep');
      else if (kind === 'directory') {
        mkdirSync(target);
        writeFileSync(join(target, 'keep'), 'keep');
      } else if (kind === 'external') {
        target = join(tmp, 'outside');
        writeFileSync(target, 'keep');
      } else if (kind === 'cycle') target = join(root, 'alias');
      const alias = link(join(root, 'alias'), target);
      new FileHelper(root, { allowSymlinks: true }).delete(alias, { recursive: true });
      expect(lexists(alias)).toBe(false);
      if (kind === 'file' || kind === 'external') expect(readFileSync(target, 'utf8')).toBe('keep');
      if (kind === 'directory') expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('keep');
    });
  }

  test('recursive deny preflight leaves the entire tree untouched', () => {
    const tree = join(root, 'tree');
    mkdirSync(join(tree, 'b-dir'), { recursive: true });
    writeFileSync(join(tree, 'a-file'), 'keep');
    writeFileSync(join(tree, 'b-dir/keep'), 'keep');
    link(join(tree, 'z-link'), join(root, 'missing'));
    expect(() => new FileHelper(root).delete(tree, { recursive: true })).toThrow(SymlinkDeniedError);
    expect(readFileSync(join(tree, 'a-file'), 'utf8')).toBe('keep');
    expect(readFileSync(join(tree, 'b-dir/keep'), 'utf8')).toBe('keep');
  });

  test('recursive allow does not descend through links', () => {
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep'), 'keep');
    const tree = join(root, 'tree');
    mkdirSync(tree);
    link(join(tree, 'external'), outside);
    new FileHelper(root, { allowSymlinks: true }).delete(tree, { recursive: true });
    expect(existsSync(tree)).toBe(false);
    expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('keep');
  });

  test('operation parent traversal, absolute escapes and root deletion are rejected', () => {
    const files = new FileHelper(root);
    for (const p of ['../x', 'a/../b', '..']) expect(() => files.readBytes(p)).toThrow(PathEscapeError);
    expect(() => files.readBytes(join(tmp, 'elsewhere'))).toThrow(PathEscapeError);
    expect(() => files.delete(root)).toThrow(/Refusing to delete the established root/);
  });

  test('trusted root alias is accepted', () => {
    const alias = link(join(tmp, 'alias'), root);
    for (const allow of [false, true]) {
      const files = new FileHelper(alias, { allowSymlinks: allow });
      files.writeText('file', 'x');
      expect(files.readText(join(alias, 'file'))).toBe('x');
      expect(files.readText(join(root, 'file'))).toBe('x');
    }
  });

  test('exclusive create never overwrites a file or link', () => {
    writeFileSync(join(root, 'file'), 'keep');
    link(join(root, 'alias'), join(root, 'file'));
    link(join(root, 'dangling'), join(root, 'missing'));
    for (const allow of [false, true]) {
      const files = new FileHelper(root, { allowSymlinks: allow });
      expect(code(() => files.createText('file', 'x'))).toBe('EEXIST');
      for (const entry of ['alias', 'dangling']) {
        if (allow) expect(code(() => files.createText(entry, 'x'))).toBe('EEXIST');
        else expect(() => files.createText(entry, 'x')).toThrow(SymlinkDeniedError);
      }
    }
    expect(existsSync(join(root, 'missing'))).toBe(false);
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('keep');
  });

  test('symlink creation requires permission and a contained target', () => {
    writeFileSync(join(root, 'target'), 'x');
    expect(() => new FileHelper(root).symlink('target', 'alias')).toThrow(SymlinkDeniedError);
    const files = new FileHelper(root, { allowSymlinks: true });
    files.symlink('target', 'alias');
    expect(readFileSync(join(root, 'alias'), 'utf8')).toBe('x');
    expect(() => files.symlink(join(tmp, 'outside'), 'bad')).toThrow(PathEscapeError);
    expect(code(() => files.symlink('missing', 'dangling'))).toBe('ENOENT');
  });

  test('missing, wrong-type and non-empty failures', () => {
    const files = new FileHelper(root);
    expect(code(() => files.readBytes('missing'))).toBe('ENOENT');
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir/child'), 'x');
    expect(() => files.readBytes('dir')).toThrow(UnsupportedPathError);
    expect(code(() => files.delete('dir'))).toBe('ENOTEMPTY');
    expect(code(() => files.mkdir('dir'))).toBe('EEXIST');
  });

  test('atomic write uses the requested mode and leaves no temp files', () => {
    const files = new FileHelper(root);
    files.writeText('file', 'x', 0o640);
    expect(statSync(join(root, 'file')).mode & 0o777).toBe(0o640);
    expect(readdirSync(root)).toEqual(['file']);
  });

  test('policy is immutable and the root must be an existing directory', () => {
    const files = new FileHelper(root);
    expect(() => {
      (files as unknown as { allowSymlinks: boolean }).allowSymlinks = true;
    }).toThrow();
    expect(code(() => new FileHelper(join(tmp, 'missing')))).toBe('ENOENT');
    writeFileSync(join(tmp, 'file'), 'x');
    expect(code(() => new FileHelper(join(tmp, 'file')))).toBe('ENOTDIR');
  });
});

// ============================================================================
// Project policy (tests/specify_cli/test_file_policy.py)
// ============================================================================

describe('project policy', () => {
  for (const [options, allowed] of [
    [{}, false],
    [{ allow_symlinks: false }, false],
    [{ allow_symlinks: true }, true],
  ] as const) {
    test(`policy is literal and fresh ${JSON.stringify(options)}`, () => {
      expect(projectFiles(tmp).allowSymlinks).toBe(false);
      saveProjectOptions(tmp, { ...options });
      const files = projectFiles(tmp);
      expect(files.allowSymlinks).toBe(allowed);
      saveProjectOptions(tmp, { allow_symlinks: !allowed });
      expect(projectFiles(tmp).allowSymlinks).toBe(!allowed);
      expect(files.allowSymlinks).toBe(allowed);
    });
  }

  for (const value of ['true', 'false', 0, 1, null, [], {}]) {
    test(`invalid policy value ${JSON.stringify(value)}`, () => {
      mkdirSync(join(tmp, '.specify'));
      writeFileSync(join(tmp, '.specify/init-options.json'), JSON.stringify({ allow_symlinks: value }));
      expect(() => projectFiles(tmp)).toThrow(ProjectPolicyError);
      expect(() => projectFiles(tmp)).toThrow(/boolean/);
    });
  }

  for (const document of ['{', '[]', 'null', '"text"', 'true', '1', '\xff', '{"custom": NaN}', '{"custom": Infinity}']) {
    test(`invalid document ${JSON.stringify(document)}`, () => {
      mkdirSync(join(tmp, '.specify'));
      writeFileSync(join(tmp, '.specify/init-options.json'), Buffer.from(document, 'latin1'));
      expect(() => projectFiles(tmp)).toThrow(/init-options\.json/);
    });
  }

  for (const [leaf, dangling] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const) {
    test(`bootstrap links are always denied (leaf=${leaf}, dangling=${dangling})`, () => {
      const target = join(tmp, 'target');
      if (leaf) {
        mkdirSync(join(tmp, '.specify'));
        if (!dangling) writeFileSync(target, '{"allow_symlinks": true}');
        symlinkSync(target, join(tmp, '.specify/init-options.json'), 'file');
      } else {
        if (!dangling) {
          mkdirSync(target);
          writeFileSync(join(target, 'init-options.json'), '{"allow_symlinks": true}');
        }
        symlinkSync(target, join(tmp, '.specify'), 'dir');
      }
      expect(() => projectFiles(tmp)).toThrow(/symlink/);
      expect(() => saveProjectOptions(tmp, { allow_symlinks: true })).toThrow(/symlink/);
    });
  }

  test('a configuration directory is not a document', () => {
    mkdirSync(join(tmp, '.specify/init-options.json'), { recursive: true });
    expect(() => projectFiles(tmp)).toThrow(ProjectPolicyError);
  });

  test('policy root alias is trusted', () => {
    const alias = link(join(tmp, 'alias'), root);
    saveProjectOptions(alias, { allow_symlinks: true });
    expect(projectFiles(alias).allowSymlinks).toBe(true);
  });

  test('configuration write preserves permissions and inode', () => {
    saveProjectOptions(tmp, { a: 1 });
    const p = join(tmp, '.specify/init-options.json');
    chmodSync(p, 0o600);
    const inode = statSync(p).ino;
    saveProjectOptions(tmp, { a: 2 });
    expect(statSync(p).ino).toBe(inode);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(p, 'utf8')).toBe('{\n  "a": 2\n}\n');
  });

  for (const value of ['false', 1, null]) {
    test(`invalid write policy fails before creation (${JSON.stringify(value)})`, () => {
      expect(() => saveProjectOptions(tmp, { allow_symlinks: value })).toThrow(ProjectPolicyError);
      expect(existsSync(join(tmp, '.specify'))).toBe(false);
    });
  }

  test('readProjectOptions: absence defaults to {}', () => {
    expect(readProjectOptions(tmp)).toEqual({});
  });

  test('override checks the selected project only', () => {
    const member = join(tmp, 'member');
    mkdirSync(member);
    saveProjectOptions(member, { allow_symlinks: true });
    saveProjectOptions(tmp, {});
    writeFileSync(join(tmp, '.specify/init-options.json'), '{');
    process.chdir(tmp);
    process.env.SPECIFY_INIT_DIR = 'member';
    expect(resolveSpecifyProjectFiles().allowSymlinks).toBe(true);
  });
});

// ============================================================================
// Init root preparation
// ============================================================================

describe('init root', () => {
  for (const prefixKind of ['missing', 'file']) {
    test(`normalized traversal is rejected (${prefixKind} prefix)`, () => {
      if (prefixKind === 'file') writeFileSync(join(tmp, 'prefix'), 'x');
      const target = `${tmp}/prefix/../new-project`;
      expect(() => prepareInitRoot(target)).toThrow(/Parent traversal requires an existing directory/);
      expect(() => preflightInitRoot(target)).toThrow(ProjectPolicyError);
      expect(existsSync(join(tmp, 'new-project'))).toBe(false);
    });
  }

  test('an existing parent traversal root remains trusted', () => {
    mkdirSync(join(tmp, 'parent'));
    const target = `${tmp}/parent/../created`;
    expect(preflightInitRoot(target)).toBe(join(tmp, 'created'));
    expect(existsSync(join(tmp, 'created'))).toBe(false);
    expect(prepareInitRoot(target)).toBe(target);
    expect(statSync(join(tmp, 'created')).isDirectory()).toBe(true);
    saveProjectOptions(join(tmp, 'created'), { allow_symlinks: true });
    expect(projectFiles(target).allowSymlinks).toBe(true);
  });

  test('a new root is not created through a dangling parent link', () => {
    symlinkSync(join(tmp, 'missing'), join(tmp, 'dangling'), 'dir');
    expect(() => prepareInitRoot(join(tmp, 'dangling', 'proj'))).toThrow();
    expect(existsSync(join(tmp, 'missing'))).toBe(false);
  });
});

// ============================================================================
// Command boundaries
// ============================================================================

async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => ((out += String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => ((err += String(c)), true)) as typeof process.stderr.write;
  appConsole.beginCapture();
  errConsole.beginCapture();
  setPromptInput([]);
  let code: number;
  try {
    code = await main(args);
  } finally {
    out += appConsole.endCapture();
    err += errConsole.endCapture();
    setPromptInput(null);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { code, out, err };
}

describe('command boundaries', () => {
  test('project commands recheck edits and render JSON errors', async () => {
    process.chdir(tmp);
    mkdirSync(join(tmp, '.specify'));
    const config = join(tmp, '.specify/init-options.json');
    writeFileSync(config, '{"allow_symlinks": false}');
    expect((await cli(['extension', 'list', '--json'])).code).toBe(0);
    writeFileSync(config, '{"allow_symlinks": "true"}');
    const r = await cli(['extension', 'list', '--json']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(JSON.parse(r.err).error).toContain('boolean');
    writeFileSync(config, '{"allow_symlinks": true}');
    expect((await cli(['extension', 'list', '--json'])).code).toBe(0);
  });

  for (const args of [
    ['extension', 'list', '--json'],
    ['preset', 'list', '--json'],
    ['artifact', 'list', '--json'],
    ['artifact', 'info', 'speckit.plan', '--json'],
    ['integration', 'status', '--json'],
    ['workflow', 'status', '--json'],
    ['workflow', 'resume', 'missing', '--json'],
    ['workflow', 'run', 'missing', '--json'],
  ]) {
    test(`policy failures use JSON error surfaces: ${args.join(' ')}`, async () => {
      process.chdir(tmp);
      mkdirSync(join(tmp, '.specify'));
      writeFileSync(join(tmp, '.specify/init-options.json'), '{');
      const r = await cli(args);
      expect(r.code).toBe(1);
      expect(r.out).toBe('');
      expect(JSON.parse(r.err).error).toContain('init-options.json');
    });
  }

  for (const args of [['--help'], ['--version'], ['version', '--json'], ['init', '--help']]) {
    test(`projectless commands ignore an unrelated invalid policy: ${args.join(' ')}`, async () => {
      process.chdir(tmp);
      mkdirSync(join(tmp, '.specify'));
      writeFileSync(join(tmp, '.specify/init-options.json'), '{');
      const r = await cli(args);
      expect(r.code).toBe(0);
      expect(r.out + r.err).not.toContain('init-options.json');
    });
  }

  for (const args of [['--allow-symlinks'], ['extension', 'list', '--allow-symlinks']]) {
    test(`--allow-symlinks is init-only: ${args.join(' ')}`, async () => {
      const r = await cli(args);
      expect(r.code).toBe(2);
      expect(r.out + r.err).toContain('No such option');
    });
  }

  for (const allowed of [false, true]) {
    test(`init persists the policy and preserves unrelated options (allow=${allowed})`, async () => {
      process.chdir(tmp);
      mkdirSync(join(tmp, '.specify'));
      const config = join(tmp, '.specify/init-options.json');
      writeFileSync(config, '{"custom": "retained", "allow_symlinks": true, "feature_numbering": "timestamp"}');
      const args = [
        'init',
        '--here',
        '--force',
        '--non-interactive',
        '--integration',
        'generic',
        '--integration-options=--commands-dir .agent/commands',
        '--ignore-agent-tools',
      ];
      if (allowed) args.push('--allow-symlinks');
      const r = await cli(args);
      expect(r.code).toBe(0);
      const options = JSON.parse(readFileSync(config, 'utf8'));
      expect(options.allow_symlinks).toBe(allowed);
      expect(options.custom).toBe('retained');
      // #5101: re-initialization keeps the feature numbering scheme.
      expect(options.feature_numbering).toBe('timestamp');
    });
  }

  test('init rejects an invalid policy before scaffolding', async () => {
    process.chdir(tmp);
    mkdirSync(join(tmp, '.specify'));
    writeFileSync(join(tmp, '.specify/init-options.json'), '{');
    const before = readdirSync(tmp).sort();
    const r = await cli(['init', '--here', '--force', '--allow-symlinks', '--non-interactive']);
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain('init-options.json');
    expect(readdirSync(tmp).sort()).toEqual(before);
  });

  for (const override of [false, true]) {
    test(`check validates the selected project policy (override=${override})`, async () => {
      const project = override ? join(tmp, 'member') : tmp;
      mkdirSync(join(project, '.specify'), { recursive: true });
      writeFileSync(join(project, '.specify/init-options.json'), '{"allow_symlinks": null}');
      process.chdir(tmp);
      if (override) process.env.SPECIFY_INIT_DIR = 'member';
      const r = await cli(['check']);
      expect(r.code).toBe(1);
      expect(r.out + r.err).toContain('allow_symlinks must be a JSON boolean');
      expect(r.out + r.err).not.toContain('Checking for installed tools');
    });
  }
});
