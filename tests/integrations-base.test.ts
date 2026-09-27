/**
 * Tests for integration base classes, IntegrationManifest and
 * integration-specific behaviors (port of key upstream cases from
 * tests/integrations/test_manifest.py, test_base.py,
 * test_integration_{copilot,bob,kimi,rovodev,generic,hermes,junie,cline,forge}.py).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getIntegration } from '../src/integrations/index.js';
import { IntegrationManifest } from '../src/integrations/manifest.js';
import {
  IntegrationBase,
  IntegrationOption,
  captureWarnings,
  pyTitle,
  splitlines,
} from '../src/integrations/base.js';
import { CopilotIntegration } from '../src/integrations/copilot.js';
import { GenericIntegration } from '../src/integrations/generic.js';
import { RovodevIntegration } from '../src/integrations/rovodev.js';
import { formatForgeCommandName } from '../src/integrations/forge.js';
import { formatJunieCommandName, JunieIntegration } from '../src/integrations/junie.js';
import { ClineIntegration } from '../src/integrations/cline.js';
import { isSpeckitGeneratedSkill, legacyToTargetName, migrateLegacyKimiSkillsDir } from '../src/integrations/kimi.js';
import { parseIntegrationOptions } from '../src/integrations/helpers.js';
import { CliExit } from '../src/console.js';

let tmp: string;
let home: string;
const savedHome = process.env.HOME;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-base-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-home-')));
  process.env.HOME = home;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  process.env.HOME = savedHome;
});

// ============================================================================
// IntegrationManifest (test_manifest.py)
// ============================================================================

describe('IntegrationManifest', () => {
  test('record_file writes and hashes; record_existing', () => {
    const m = new IntegrationManifest('test', tmp);
    const abs = m.recordFile('a/b.txt', 'hello');
    expect(readFileSync(abs, 'utf-8')).toBe('hello');
    expect(m.files['a/b.txt']).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    writeFileSync(join(tmp, 'c.txt'), 'x');
    m.recordExisting('c.txt');
    expect(Object.keys(m.files).sort()).toEqual(['a/b.txt', 'c.txt']);
  });

  test('rejects traversal, absolute, symlinks, directories, missing', () => {
    const m = new IntegrationManifest('test', tmp);
    expect(() => m.recordFile('../escape.txt', 'x')).toThrow(/outside/);
    expect(() => m.recordFile('/abs.txt', 'x')).toThrow('Absolute paths are not allowed in manifests');
    mkdirSync(join(tmp, 'd'));
    writeFileSync(join(tmp, 'd', 'f.txt'), 'x');
    expect(() => m.recordExisting('d/../d/f.txt')).toThrow("Manifest paths must be canonical; '..' segments are not allowed");
    expect(() => m.recordExisting('d')).toThrow('Manifest path is not a regular file: d');
    expect(() => m.recordExisting('missing.txt')).toThrow('Manifest path is not a regular file');
    symlinkSync(join(tmp, 'd', 'f.txt'), join(tmp, 'link.txt'));
    expect(() => m.recordExisting('link.txt')).toThrow('Refusing to record symlinked manifest path');
    symlinkSync(join(tmp, 'd'), join(tmp, 'linkdir'));
    expect(() => m.recordExisting('linkdir/f.txt')).toThrow('(symlinked at linkdir)');
  });

  test('check_modified and uninstall (modified skipped, force, symlinks, empty dirs)', () => {
    const m = new IntegrationManifest('test', tmp);
    m.recordFile('x/keep.txt', 'a');
    m.recordFile('x/y/gone.txt', 'b');
    m.recordFile('mod.txt', 'c');
    writeFileSync(join(tmp, 'mod.txt'), 'changed');
    expect(m.checkModified()).toEqual(['mod.txt']);
    m.save();
    const [removed, skipped] = m.uninstall();
    expect(removed.map((p) => p.slice(tmp.length + 1)).sort()).toEqual(['x/keep.txt', 'x/y/gone.txt']);
    expect(skipped.map((p) => p.slice(tmp.length + 1))).toEqual(['mod.txt']);
    expect(existsSync(join(tmp, 'x'))).toBe(false);
    expect(existsSync(m.manifestPath)).toBe(false);
    const [removed2] = m.uninstall(null, { force: true });
    expect(removed2.map((p) => p.slice(tmp.length + 1))).toEqual(['mod.txt']);
  });

  test('uninstall with removeManifest=false preserves manifest file', () => {
    const m = new IntegrationManifest('test', tmp);
    m.recordFile('f.txt', 'x');
    m.save();
    m.uninstall(null, { removeManifest: false });
    expect(existsSync(m.manifestPath)).toBe(true);
  });

  test('save/load roundtrip, recovered files, installed_at preserved', () => {
    const m = new IntegrationManifest('test', tmp, '1.2.3');
    m.recordFile('f.txt', 'x');
    writeFileSync(join(tmp, 'r.txt'), 'r');
    m.recordExisting('r.txt', { recovered: true });
    const path = m.save();
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    expect(data.integration).toBe('test');
    expect(data.version).toBe('1.2.3');
    expect(data.recovered_files).toEqual(['r.txt']);
    expect(data.installed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
    const loaded = IntegrationManifest.load('test', tmp);
    expect(loaded.files).toEqual(m.files);
    expect(loaded.isRecovered('r.txt')).toBe(true);
    expect(loaded.isRecovered('/abs')).toBe(false);
    expect(loaded.isRecovered('../x')).toBe(false);
    loaded.save();
    expect(JSON.parse(readFileSync(path, 'utf-8')).installed_at).toBe(data.installed_at);
    m.recordExisting('r.txt');
    expect(m.isRecovered('r.txt')).toBe(false);
    expect(m.remove('r.txt')).toBe(true);
    expect(m.remove('r.txt')).toBe(false);
  });

  test('load errors', () => {
    const m = new IntegrationManifest('test', tmp);
    expect(() => IntegrationManifest.load('test', tmp)).toThrow(/ENOENT|no such file/);
    mkdirSync(join(tmp, '.specify', 'integrations'), { recursive: true });
    const write = (s: string | Buffer) => writeFileSync(m.manifestPath, s);
    write('[]');
    expect(() => IntegrationManifest.load('test', tmp)).toThrow('must be a JSON object, got list');
    write('{"files": {"a": 1}}');
    expect(() => IntegrationManifest.load('test', tmp)).toThrow("'files'");
    write('{bad');
    expect(() => IntegrationManifest.load('test', tmp)).toThrow('contains invalid JSON');
    write(Buffer.from([0xff, 0xfe]));
    expect(() => IntegrationManifest.load('test', tmp)).toThrow('is not valid UTF-8');
    write('{"integration": "other", "files": {}}');
    expect(() => IntegrationManifest.load('test', tmp)).toThrow("belongs to integration 'other', not 'test'");
    write('{"files": {"a": "h"}, "recovered_files": ["a", "b"]}');
    expect([...IntegrationManifest.load('test', tmp).recoveredFiles]).toEqual(['a']);
  });

  test('save refuses symlinked manifest directory', () => {
    mkdirSync(join(tmp, 'elsewhere'));
    mkdirSync(join(tmp, '.specify'));
    symlinkSync(join(tmp, 'elsewhere'), join(tmp, '.specify', 'integrations'));
    const m = new IntegrationManifest('test', tmp);
    expect(() => m.save()).toThrow('Refusing to use symlinked integration manifest directory: .specify/integrations');
  });
});

// ============================================================================
// Base helpers
// ============================================================================

describe('base helpers', () => {
  test('IntegrationOption defaults', () => {
    const o = new IntegrationOption('--x');
    expect([o.name, o.isFlag, o.required, o.default, o.help]).toEqual(['--x', false, false, null, '']);
  });

  test('events option only for event-capable integrations', () => {
    expect(getIntegration('claude')!.options().map((o) => o.name)).toEqual(['--events']);
    expect(getIntegration('codex')!.options().map((o) => o.name)).toEqual(['--events', '--skills']);
    expect(getIntegration('auggie')!.options()).toEqual([]);
  });

  test('select_script_variant fallbacks', () => {
    const shOnly = { sh: 'a' };
    expect(IntegrationBase.selectScriptVariant('ps', shOnly)).toBe('sh');
    expect(IntegrationBase.selectScriptVariant('py', { py: 'x', ps: 'y' })).toBe('py');
    expect(() => IntegrationBase.selectScriptVariant('sh', {})).toThrow(
      "No runnable script variant for this platform: requested 'sh'; available: none",
    );
  });

  test('python invocation prefers project venv', () => {
    mkdirSync(join(tmp, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(tmp, '.venv', 'bin', 'python'), '');
    expect(IntegrationBase.buildPythonInvocation('.specify/scripts/python/x.py', tmp)).toBe(
      '.venv/bin/python .specify/scripts/python/x.py',
    );
  });

  test('command templates in upstream order', () => {
    const names = getIntegration('claude')!.listCommandTemplates().map((p) => p.split(/[\\/]/).pop());
    expect(names).toEqual([
      'analyze.md', 'clarify.md', 'constitution.md', 'implement.md', 'converge.md',
      'plan.md', 'checklist.md', 'specify.md', 'tasks.md', 'taskstoissues.md',
    ]);
  });

  test('python splitlines and title', () => {
    expect(splitlines('a\r\nb\rc d\n')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitlines('a\nb', true)).toEqual(['a\n', 'b']);
    expect(pyTitle("git commit-x o'neil")).toBe("Git Commit-X O'Neil");
  });

  test('setup rejects mismatched manifest root and escaping destination', () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-other-')));
    try {
      const m = new IntegrationManifest('claude', other);
      expect(() => getIntegration('claude')!.setup(tmp, m, null, {})).toThrow(/does not match project_root/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    const g = getIntegration('generic')!;
    expect(() => g.setup(tmp, new IntegrationManifest('generic', tmp), { commands_dir: '../out' })).toThrow(/escapes project root/);
  });

  test('teardown removes installed files', () => {
    const claude = getIntegration('claude')!;
    const m = new IntegrationManifest('claude', tmp);
    claude.setup(tmp, m, null, { scriptType: 'sh', events: {} });
    m.save();
    const [removed, skipped] = claude.teardown(tmp, m);
    expect(removed.length).toBe(10);
    expect(skipped).toEqual([]);
    expect(existsSync(join(tmp, '.claude'))).toBe(false);
  });
});

// ============================================================================
// Integration specifics
// ============================================================================

describe('copilot', () => {
  test('mode detection: fresh → skills; managed commands → commands; flags win', () => {
    const c = getIntegration('copilot') as CopilotIntegration;
    expect(c.isSkillsMode(null, tmp)).toBe(true);
    mkdirSync(join(tmp, '.github', 'agents'), { recursive: true });
    writeFileSync(join(tmp, '.github', 'agents', 'speckit.plan.agent.md'), 'x');
    expect(c.isSkillsMode(null, tmp)).toBe(false);
    expect(c.isSkillsMode({ skills: true }, tmp)).toBe(true);
    expect(c.effectiveInvokeSeparator(null, tmp)).toBe('.');
    expect(() => captureWarnings(() => c.isSkillsMode({ skills: true, commands: true }))).toThrow(CliExit);
  });

  test('vscode settings merge preserves user values and skips JSONC', () => {
    const src = join(tmp, 'tpl.json');
    writeFileSync(src, JSON.stringify({ a: 1, nested: { x: 1, y: 2 } }));
    const dst = join(tmp, 'settings.json');
    writeFileSync(dst, JSON.stringify({ a: 0, nested: { x: 9 }, keep: true }));
    CopilotIntegration.mergeVscodeSettings(src, dst);
    expect(JSON.parse(readFileSync(dst, 'utf-8'))).toEqual({ a: 0, nested: { x: 9, y: 2 }, keep: true });
    expect(readFileSync(dst, 'utf-8')).toContain('\n    "a": 0');
    writeFileSync(dst, '{ // comment\n"a": 1 }');
    CopilotIntegration.mergeVscodeSettings(src, dst);
    expect(readFileSync(dst, 'utf-8')).toBe('{ // comment\n"a": 1 }');
  });

  test('stale cleanup protects .vscode/settings.json', () => {
    expect(getIntegration('copilot')!.staleCleanupExclusions().has('.vscode/settings.json')).toBe(true);
  });
});

describe('bob', () => {
  test('skills by default; legacy detected from managed commands; flags mutually exclusive', () => {
    const bob = getIntegration('bob')!;
    expect(bob.isSkillsMode(null, tmp)).toBe(true);
    mkdirSync(join(tmp, '.bob', 'commands'), { recursive: true });
    writeFileSync(join(tmp, '.bob', 'commands', 'speckit.plan.md'), 'x');
    expect(bob.isSkillsMode(null, tmp)).toBe(false);
    mkdirSync(join(tmp, '.bob', 'skills', 'speckit-plan'), { recursive: true });
    expect(bob.isSkillsMode(null, tmp)).toBe(true);
    expect(() => bob.isSkillsMode({ skills: true, legacy_commands: true })).toThrow(CliExit);
    const [, warnings] = captureWarnings(() =>
      bob.setup(tmp, new IntegrationManifest('bob', tmp), { legacy_commands: true }, { scriptType: 'sh' }),
    );
    expect(warnings[0].message).toContain('Bob legacy commands mode (.bob/commands/) is deprecated');
  });
});

describe('generic', () => {
  test('requires non-blank --commands-dir; raw options fallback', () => {
    const g = getIntegration('generic') as GenericIntegration;
    expect(() => GenericIntegration.resolveCommandsDir({ commands_dir: '  ' }, {})).toThrow(
      '--commands-dir is required for the generic integration',
    );
    expect(GenericIntegration.resolveCommandsDir(null, { rawOptions: '--commands-dir=".x y/c"' })).toBe('.x y/c');
    expect(GenericIntegration.resolveCommandsDir(null, { raw_options: '--commands-dir d' })).toBe('d');
    expect(() => g.commandsDest(tmp)).toThrow(/cannot be called directly/);
    expect(g.effectiveInvokeSeparator({ skills: true })).toBe('-');
  });
});

describe('rovodev prompts.yml merge', () => {
  test('preserves user entries and order, replaces generated ones', () => {
    mkdirSync(join(tmp, '.rovodev'), { recursive: true });
    writeFileSync(
      join(tmp, '.rovodev', 'prompts.yml'),
      'prompts:\n- name: mine\n  content_file: prompts/mine.md\n- name: speckit-plan\n  description: old\n- name: [weird]\n',
    );
    const m = new IntegrationManifest('rovodev', tmp);
    getIntegration('rovodev')!.setup(tmp, m, null, { scriptType: 'sh', events: {} });
    const text = readFileSync(join(tmp, '.rovodev', 'prompts.yml'), 'utf-8');
    expect(text.startsWith('prompts:\n- name: mine\n  content_file: prompts/mine.md\n- name: speckit-plan\n  description: Invoke speckit-plan skill\n')).toBe(true);
    expect(text).toContain('- name:\n  - weird\n');
    expect(readFileSync(join(tmp, '.rovodev', 'prompts', 'speckit-plan.prompt.md'), 'utf-8')).toBe('use skill speckit-plan $ARGUMENTS\n');
    expect(RovodevIntegration.mergePromptEntries([], [{ name: 'a' }])).toEqual([{ name: 'a' }]);
  });
});

describe('kimi legacy migration', () => {
  test('legacy names and generated-skill detection', () => {
    expect(legacyToTargetName('speckit.git.commit')).toBe('speckit-git-commit');
    expect(legacyToTargetName('speckit-plan')).toBe('speckit-plan');
    expect(legacyToTargetName('other')).toBe('');
    const dir = join(tmp, 'speckit-x');
    mkdirSync(dir);
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\nmetadata:\n  author: github-spec-kit\n  source: templates/commands/x.md\n---\nbody');
    expect(isSpeckitGeneratedSkill(dir)).toBe(true);
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\n---\nbody');
    expect(isSpeckitGeneratedSkill(dir)).toBe(false);
  });

  test('migrates dotted + hyphenated dirs, removes identical duplicates', () => {
    const oldDir = join(tmp, '.kimi', 'skills');
    const newDir = join(tmp, '.kimi-code', 'skills');
    for (const name of ['speckit.plan', 'speckit-tasks', 'speckit-dup']) {
      mkdirSync(join(oldDir, name), { recursive: true });
      writeFileSync(join(oldDir, name, 'SKILL.md'), name);
    }
    mkdirSync(join(newDir, 'speckit-dup'), { recursive: true });
    writeFileSync(join(newDir, 'speckit-dup', 'SKILL.md'), 'speckit-dup');
    expect(migrateLegacyKimiSkillsDir(oldDir, newDir)).toEqual([2, 1]);
    expect(readFileSync(join(newDir, 'speckit-plan', 'SKILL.md'), 'utf-8')).toBe('speckit.plan');
    expect(existsSync(oldDir)).toBe(false);
  });

  test('setup refuses symlinked destination', () => {
    mkdirSync(join(tmp, 'real'));
    symlinkSync(join(tmp, 'real'), join(tmp, '.kimi-code'));
    expect(() => getIntegration('kimi')!.setup(tmp, new IntegrationManifest('kimi', tmp), null, {})).toThrow(
      /contains a symlinked path component/,
    );
  });
});

describe('hermes', () => {
  test('installs global skills + project marker; teardown removes both', () => {
    const h = getIntegration('hermes')!;
    const m = new IntegrationManifest('hermes', tmp);
    const created = h.setup(tmp, m, null, { scriptType: 'sh' });
    expect(created.length).toBe(10);
    expect(existsSync(join(home, '.hermes', 'skills', 'speckit-plan', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(tmp, '.hermes', 'skills'))).toBe(true);
    h.teardown(tmp, m);
    expect(existsSync(join(home, '.hermes', 'skills', 'speckit-plan'))).toBe(false);
    expect(existsSync(join(tmp, '.hermes'))).toBe(false);
  });
});

describe('name formatters and command post-processing', () => {
  test('forge/junie formatters are idempotent', () => {
    for (const f of [formatForgeCommandName, formatJunieCommandName]) {
      expect(f('plan')).toBe('speckit-plan');
      expect(f('speckit.git.commit')).toBe('speckit-git-commit');
      expect(f(f('speckit.git.commit'))).toBe('speckit-git-commit');
    }
  });

  test('cline note is per-instruction; junie note is whole-document', () => {
    const doc = 'replace dots somewhere\n- For each executable hook, output the following\n';
    expect(ClineIntegration.injectHookCommandNote(doc)).toContain('- When constructing slash commands');
    expect(JunieIntegration.injectHookCommandNote(doc)).toBe(doc);
    const once = ClineIntegration.injectHookCommandNote('- For each executable hook, output the following\n');
    expect(ClineIntegration.injectHookCommandNote(once)).toBe(once);
  });

  test('handoff agent references are hyphenated', () => {
    expect(
      getIntegration('junie')!.postProcessCommandContent('---\nhandoffs:\n  - label: x\n    agent: speckit.git.commit\n---\n'),
    ).toBe('---\nhandoffs:\n  - label: x\n    agent: speckit-git-commit\n---\n');
    // A ``- agent:`` list-item line is not matched (upstream regex anchors on ``\s*agent:``).
    const dashed = '---\nhandoffs:\n  - agent: speckit.git.commit\n---\n';
    expect(getIntegration('junie')!.postProcessCommandContent(dashed)).toBe(dashed);
  });
});

describe('parseIntegrationOptions', () => {
  test('parses flags and values, rejects unknown / bad input', () => {
    const g = getIntegration('generic')!;
    expect(parseIntegrationOptions(g, '--commands-dir .x/c --skills')).toEqual({ commands_dir: '.x/c', skills: true });
    expect(parseIntegrationOptions(g, '--commands-dir=.y')).toEqual({ commands_dir: '.y' });
    expect(parseIntegrationOptions(g, '')).toBeNull();
    for (const bad of ['--nope', 'value', '--skills=true', '--commands-dir', '--commands-dir "x']) {
      expect(() => parseIntegrationOptions(g, bad)).toThrow(CliExit);
    }
  });
});
