/**
 * Tests for src/presets/manager-skills.ts and src/presets/manager-commands.ts
 * (ports of key cases from upstream test_manager_skills.py and
 * test_manager_commands.py).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { saveInitOptions } from '../src/init-options.js';
import { dumpYaml, parseYaml } from '../src/yaml.js';
import { PresetManager } from '../src/presets/manager.js';
import { skillNamesForCommand, substituteCoreTemplate } from '../src/presets/manager-commands.js';
import { PresetSkillMethods } from '../src/presets/manager-skills.js';
import { setPresetWarningHandler } from '../src/presets/manifest.js';
import { CommandRegistrar } from '../src/agents.js';

let tempDir: string;
let projectDir: string;
let warnings: string[];
let savedHome: string | undefined;

function write(p: string, content: string | Buffer): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'presets-skills-'));
  projectDir = join(tempDir, 'project');
  write(join(projectDir, '.specify', 'templates', 'spec-template.md'), '# Core Spec Template\n');
  mkdirSync(join(projectDir, '.specify', 'templates', 'commands'), { recursive: true });
  warnings = [];
  setPresetWarningHandler((m) => warnings.push(m));
  savedHome = process.env.HOME;
  process.env.HOME = join(tempDir, 'home');
});

afterEach(() => {
  setPresetWarningHandler(null);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function initOptions(ai = 'claude', aiSkills = true, script = 'sh'): void {
  saveInitOptions(projectDir, { ai, ai_skills: aiSkills, script });
}

function createSkill(skillsDir: string, name: string, body = 'original body'): string {
  const dir = join(skillsDir, name);
  write(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n\n${body}\n`);
  return dir;
}

function commandPreset(
  id: string,
  commands: Array<{ name: string; content: string; strategy?: string; aliases?: string[] }>,
): string {
  const dir = join(tempDir, id);
  write(
    join(dir, 'preset.yml'),
    dumpYaml({
      schema_version: '1.0',
      preset: { id, name: id, version: '1.0.0', description: 'Test' },
      requires: { speckit_version: '>=0.1.0' },
      provides: {
        templates: commands.map((c) => ({
          type: 'command',
          name: c.name,
          file: `commands/${c.name}.md`,
          ...(c.strategy ? { strategy: c.strategy } : {}),
          ...(c.aliases ? { aliases: c.aliases } : {}),
        })),
      },
    }),
  );
  for (const c of commands) write(join(dir, 'commands', `${c.name}.md`), c.content);
  return dir;
}

function skillFrontmatter(file: string): Record<string, any> {
  return parseYaml(readFileSync(file, 'utf-8').split('---')[1]) as Record<string, any>;
}

const SPECIFY_OVERRIDE = '---\ndescription: "Self-test override of the specify command"\n---\n\n<!-- preset:self-test -->\n\nSelf-test specify body for $ARGUMENTS\n';

// ============================================================================

describe('skill registration', () => {
  test('skill overridden on preset install (claude)', () => {
    initOptions('claude');
    const skillsDir = join(projectDir, '.claude', 'skills');
    createSkill(skillsDir, 'speckit-specify');
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(commandPreset('self-test', [{ name: 'speckit.specify', content: SPECIFY_OVERRIDE }]), '0.1.5');
    const skillFile = join(skillsDir, 'speckit-specify', 'SKILL.md');
    const content = readFileSync(skillFile, 'utf-8');
    expect(content).toContain('preset:self-test');
    expect(content).toContain('Self-test specify body');
    expect(content).toContain('# Speckit Specify Skill');
    const meta = manager.registry.get('self-test')!;
    expect(meta.registered_skills.claude ?? meta.registered_commands.claude).toBeDefined();
  });

  test('argument-hint preserved for claude, omitted for codex', () => {
    const cmd = '---\ndescription: "Build context"\nargument-hint: "<init | update> [area]"\n---\n\nPreset body.\n';
    initOptions('claude');
    mkdirSync(join(projectDir, '.specify', 'extensions', 'hinttest'), { recursive: true });
    createSkill(join(projectDir, '.claude', 'skills'), 'speckit-hinttest-cmd');
    new PresetManager(projectDir).installFromDirectory(
      commandPreset('hint-claude', [{ name: 'speckit.hinttest.cmd', content: cmd }]),
      '0.1.5',
    );
    const fm = skillFrontmatter(join(projectDir, '.claude', 'skills', 'speckit-hinttest-cmd', 'SKILL.md'));
    expect(fm['argument-hint']).toBe('<init | update> [area]');
    expect(fm.description).toBe('Build context');
  });

  test('wrap preset inherits argument-hint from core template', () => {
    initOptions('claude');
    const skillsDir = join(projectDir, '.claude', 'skills');
    createSkill(skillsDir, 'speckit-specify');
    write(
      join(projectDir, '.specify', 'templates', 'commands', 'specify.md'),
      '---\ndescription: Core specify description.\nargument-hint: "Describe the feature you want to specify"\n---\n\nCore specify body.\n',
    );
    new PresetManager(projectDir).installFromDirectory(
      commandPreset('wrap-hint', [
        {
          name: 'speckit.specify',
          strategy: 'wrap',
          content: '---\ndescription: "Wrapped specify"\nstrategy: wrap\n---\n\n{CORE_TEMPLATE}\n',
        },
      ]),
      '1.0.0',
    );
    const skillFile = join(skillsDir, 'speckit-specify', 'SKILL.md');
    const fm = skillFrontmatter(skillFile);
    expect(fm['argument-hint']).toBe('Describe the feature you want to specify');
    expect(fm.description).toBe('Wrapped specify');
    expect(readFileSync(skillFile, 'utf-8')).toContain('Core specify body.');
    expect(readFileSync(skillFile, 'utf-8')).not.toContain('{CORE_TEMPLATE}');
  });

  test('skills untouched when ai_skills disabled or without init-options', () => {
    initOptions('qwen', false);
    const skillsDir = join(projectDir, '.qwen', 'skills');
    createSkill(skillsDir, 'speckit-specify', 'untouched');
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(commandPreset('p1', [{ name: 'speckit.specify', content: SPECIFY_OVERRIDE }]), '0.1.5');
    expect(readFileSync(join(skillsDir, 'speckit-specify', 'SKILL.md'), 'utf-8')).toContain('untouched');
  });

  test('getSkillsDir returns null for corrupted init options', () => {
    write(join(projectDir, '.specify', 'init-options.json'), '{"ai":["codex"],"ai_skills":true,"script":"sh"}');
    expect(new PresetManager(projectDir).getSkillsDir()).toBeNull();
    write(join(projectDir, '.specify', 'init-options.json'), '[]');
    expect(new PresetManager(projectDir).getSkillsDir()).toBeNull();
  });

  test('skill restored from bundled core on remove without project core templates (#3928)', () => {
    initOptions('claude');
    const skillsDir = join(projectDir, '.claude', 'skills');
    createSkill(skillsDir, 'speckit-specify');
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(commandPreset('self-test', [{ name: 'speckit.specify', content: SPECIFY_OVERRIDE }]), '0.1.5');
    const skillFile = join(skillsDir, 'speckit-specify', 'SKILL.md');
    expect(readFileSync(skillFile, 'utf-8')).toContain('preset:self-test');
    manager.remove('self-test');
    expect(existsSync(skillFile)).toBe(true);
    const content = readFileSync(skillFile, 'utf-8');
    expect(content).not.toContain('preset:self-test');
    expect(content).toContain('templates/commands/specify.md');
    expect(content).toContain('Create or update the feature specification');
  });

  test('skill restored from project core template on remove', () => {
    initOptions('claude');
    const skillsDir = join(projectDir, '.claude', 'skills');
    createSkill(skillsDir, 'speckit-specify');
    write(
      join(projectDir, '.specify', 'templates', 'commands', 'specify.md'),
      '---\ndescription: Core specify command\n---\n\nCore specify body\n',
    );
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(commandPreset('self-test', [{ name: 'speckit.specify', content: SPECIFY_OVERRIDE }]), '0.1.5');
    manager.remove('self-test');
    const content = readFileSync(join(skillsDir, 'speckit-specify', 'SKILL.md'), 'utf-8');
    expect(content).toContain('Core specify body');
    expect(skillFrontmatter(join(skillsDir, 'speckit-specify', 'SKILL.md')).description).toBe('Core specify command');
  });

  test('remove restores lower-priority preset skill', () => {
    initOptions('claude');
    const skillsDir = join(projectDir, '.claude', 'skills');
    createSkill(skillsDir, 'speckit-specify');
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(
      commandPreset('lo', [{ name: 'speckit.specify', content: '---\ndescription: lo\n---\n\nLO BODY\n' }]),
      '0.1.5',
      10,
    );
    manager.installFromDirectory(
      commandPreset('hi', [{ name: 'speckit.specify', content: '---\ndescription: hi\n---\n\nHI BODY\n' }]),
      '0.1.5',
      1,
    );
    const skillFile = join(skillsDir, 'speckit-specify', 'SKILL.md');
    expect(readFileSync(skillFile, 'utf-8')).toContain('HI BODY');
    manager.remove('hi');
    expect(readFileSync(skillFile, 'utf-8')).toContain('LO BODY');
  });

  test('symlinked skill subdir rejected on write (copilot skills mode)', () => {
    initOptions('copilot', true);
    mkdirSync(join(projectDir, '.github', 'agents'), { recursive: true });
    const skillsDir = join(projectDir, '.github', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const outside = join(tempDir, 'outside-skill');
    mkdirSync(outside);
    symlinkSync(outside, join(skillsDir, 'speckit-specify'));
    new PresetManager(projectDir).installFromDirectory(
      commandPreset('p', [{ name: 'speckit.specify', content: SPECIFY_OVERRIDE }]),
      '0.1.5',
    );
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(false);
  });

  test('copilot skills mode creates new skill and no command file', () => {
    initOptions('copilot', true);
    mkdirSync(join(projectDir, '.github', 'agents'), { recursive: true });
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(
      commandPreset('cp', [{ name: 'speckit.specify', content: SPECIFY_OVERRIDE }]),
      '0.1.5',
    );
    const skillFile = join(projectDir, '.github', 'skills', 'speckit-specify', 'SKILL.md');
    expect(existsSync(skillFile)).toBe(true);
    expect(skillFrontmatter(skillFile).metadata.source).toBe('preset:cp');
    const meta = manager.registry.get('cp')!;
    expect(meta.registered_skills).toEqual({ copilot: ['speckit-specify'] });
    expect(meta.registered_commands).toEqual({});
    manager.remove('cp');
    expect(readFileSync(skillFile, 'utf-8')).toContain('templates/commands/specify.md');
  });
});

describe('skill helpers', () => {
  test('skill names and titles', () => {
    expect(skillNamesForCommand('speckit.specify')).toEqual(['speckit-specify', 'speckit.specify']);
    expect(skillNamesForCommand('speckit.git.feature')).toEqual(['speckit-git-feature', 'speckit.git.feature']);
    expect(PresetSkillMethods.skillTitleFromCommand('speckit.git.feature-branch')).toBe('Git Feature Branch');
  });

  test('isSafeRegistrySkillName rejects unsafe values', () => {
    for (const bad of ['', '.', '..', '/abs', 'a/b', '../x', null, 5]) {
      expect(PresetSkillMethods.isSafeRegistrySkillName(bad)).toBe(false);
    }
    expect(PresetSkillMethods.isSafeRegistrySkillName('speckit-specify')).toBe(true);
  });

  test('normalizeRegisteredSkills', () => {
    expect(PresetSkillMethods.normalizeRegisteredSkills({ claude: ['a'], bad: 'x' })).toEqual({ claude: ['a'] });
    expect(PresetSkillMethods.normalizeRegisteredSkills(['a', 1], 'claude')).toEqual({ claude: ['a'] });
    expect(PresetSkillMethods.normalizeRegisteredSkills(['a'])).toEqual({});
  });

  test('legacy flat-list provenance inferred from on-disk markers', () => {
    initOptions('claude');
    const manager = new PresetManager(projectDir);
    const claudeSkills = join(projectDir, '.claude', 'skills');
    write(
      join(claudeSkills, 'speckit-plan', 'SKILL.md'),
      '---\nname: speckit-plan\nmetadata:\n  source: preset:legacy\n---\n\nbody\n',
    );
    const inferred = manager.inferLegacySkillProvenance(['speckit-plan', 'speckit-orphan', '../evil'], 'legacy', 'copilot');
    expect(inferred.claude).toEqual(['speckit-plan']);
    expect(inferred.copilot).toEqual(['speckit-orphan']);
  });

  test('unreadable core template leaves skill in place with warning', () => {
    initOptions('claude');
    const skillsDir = join(projectDir, '.claude', 'skills');
    write(
      join(skillsDir, 'speckit-plan', 'SKILL.md'),
      '---\nname: speckit-plan\nmetadata:\n  source: preset:p\n---\n\npreset body\n',
    );
    write(join(projectDir, '.specify', 'templates', 'commands', 'plan.md'), Buffer.from([0xff, 0xfe, 0x00]));
    const manager = new PresetManager(projectDir);
    const mutated = manager.unregisterSkillsInDir(['speckit-plan'], skillsDir, 'claude', { packId: 'p' });
    expect(mutated).toEqual([]);
    expect(readFileSync(join(skillsDir, 'speckit-plan', 'SKILL.md'), 'utf-8')).toContain('preset body');
    expect(warnings.some((w) => w.includes("Skill 'speckit-plan' still contains the removed preset's content"))).toBe(true);
  });

  test('non-owned skill is not restored or deleted', () => {
    initOptions('claude');
    const skillsDir = join(projectDir, '.claude', 'skills');
    createSkill(skillsDir, 'speckit-plan', 'user authored');
    const manager = new PresetManager(projectDir);
    expect(manager.unregisterSkillsInDir(['speckit-plan'], skillsDir, 'claude', { packId: 'p' })).toEqual([]);
    expect(readFileSync(join(skillsDir, 'speckit-plan', 'SKILL.md'), 'utf-8')).toContain('user authored');
  });
});

describe('substituteCoreTemplate', () => {
  test('substitutes core body and returns core frontmatter', () => {
    write(
      join(projectDir, '.specify', 'templates', 'commands', 'plan.md'),
      '---\ndescription: core plan\nscripts:\n  sh: x.sh\n---\nCORE PLAN BODY\n',
    );
    const [body, fm] = substituteCoreTemplate('before\n{CORE_TEMPLATE}\nafter', 'speckit.plan', projectDir, new CommandRegistrar());
    expect(body).toContain('CORE PLAN BODY');
    expect(body.startsWith('before\n')).toBe(true);
    expect(fm.description).toBe('core plan');
  });

  test('no placeholder is a no-op; unreadable core is treated as missing', () => {
    expect(substituteCoreTemplate('plain', 'speckit.plan', projectDir, new CommandRegistrar())).toEqual(['plain', {}]);
    write(join(projectDir, '.specify', 'templates', 'overrides', 'speckit.bad.md'), Buffer.from([0xff, 0xfe]));
    const [body, fm] = substituteCoreTemplate('{CORE_TEMPLATE}', 'speckit.bad', projectDir, new CommandRegistrar());
    expect(body).toBe('{CORE_TEMPLATE}');
    expect(fm).toEqual({});
    expect(warnings.some((w) => w.startsWith("Ignoring core template for command 'speckit.bad': could not read 'speckit.bad.md'"))).toBe(true);
  });
});

describe('command registration (active agent)', () => {
  test('namespaced preset command scaffolds without the extension installed', () => {
    initOptions('gemini', false);
    mkdirSync(join(projectDir, '.gemini', 'commands'), { recursive: true });
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(
      commandPreset('ns', [{ name: 'speckit.myext.run', content: '---\ndescription: ns\n---\n\nNS BODY\n' }]),
      '0.1.5',
    );
    const meta = manager.registry.get('ns')!;
    expect(meta.registered_commands.gemini).toContain('speckit.myext.run');
  });

  test('corrupted init-options fails closed (no registration)', () => {
    write(join(projectDir, '.specify', 'init-options.json'), '{not json');
    mkdirSync(join(projectDir, '.gemini', 'commands'), { recursive: true });
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(
      commandPreset('closed', [{ name: 'speckit.specify', content: '---\ndescription: c\n---\n\nC\n' }]),
      '0.1.5',
    );
    expect(manager.registry.get('closed')!.registered_commands).toEqual({});
  });

  test('registerEnabledPresetsForAgent and unregisterAgentArtifacts', () => {
    initOptions('gemini', false);
    mkdirSync(join(projectDir, '.gemini', 'commands'), { recursive: true });
    const manager = new PresetManager(projectDir);
    manager.installFromDirectory(
      commandPreset('rescaffold', [{ name: 'speckit.specify', content: '---\ndescription: r\n---\n\nR BODY\n' }]),
      '0.1.5',
    );
    expect(manager.registry.get('rescaffold')!.registered_commands.gemini).toBeDefined();

    manager.unregisterAgentArtifacts('gemini');
    expect(manager.registry.get('rescaffold')!.registered_commands.gemini).toBeUndefined();

    manager.registerEnabledPresetsForAgent('gemini');
    expect(manager.registry.get('rescaffold')!.registered_commands.gemini).toContain('speckit.specify');
  });
});
