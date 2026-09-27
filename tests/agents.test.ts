/**
 * Tests for CommandRegistrar (port of agents.py).
 *
 * Covers upstream tests/test_extensions.py (CommandRegistrar parts),
 * tests/test_registrar_path_traversal.py, tests/test_extension_skills.py
 * (registrar parts) and golden parity against Python v1.0.12 output for
 * every registrar agent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { CommandRegistrar, buildAgentConfigs, pyNormpath } from '../src/agents.js';
import { INTEGRATION_REGISTRY } from '../src/integrations/index.js';
import { captureWarnings } from '../src/integrations/base.js';

const FIXTURES = join(import.meta.dir, 'fixtures', 'integrations');

let tmp: string;
let home: string;
const savedHome = process.env.HOME;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-agents-')));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-home-')));
  process.env.HOME = home;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  process.env.HOME = savedHome;
});

function listFiles(root: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      const rel = relative(root, p).split('\\').join('/');
      if (skip(rel)) continue;
      if (st.isDirectory()) walk(p);
      else out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

function writeExt(root: string, files: Record<string, string>): string {
  const ext = join(root, '.specify', 'extensions', 'git');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(ext, rel, '..'), { recursive: true });
    writeFileSync(join(ext, rel), content, 'utf-8');
  }
  return ext;
}

// ============================================================================
// AGENT_CONFIGS
// ============================================================================

describe('AGENT_CONFIGS', () => {
  test('derived from the registry, excluding generic (40 agents)', () => {
    const configs = CommandRegistrar.AGENT_CONFIGS;
    expect(Object.keys(configs).length).toBe(40);
    expect('generic' in configs).toBe(false);
    expect(Object.keys(configs)).toEqual(Object.keys(INTEGRATION_REGISTRY).filter((k) => k !== 'generic'));
  });

  test('propagates invoke_separator and dev_no_symlink', () => {
    const configs = buildAgentConfigs();
    expect(configs.claude.invoke_separator).toBe('-');
    expect(configs.gemini.invoke_separator).toBe('.');
    expect(configs.junie.invoke_separator).toBe('-');
    expect(configs.codex.dev_no_symlink).toBe(true);
    expect(configs.claude.dev_no_symlink).toBeUndefined();
  });

  test('retired agents are gone', () => {
    for (const retired of ['roo', 'windsurf', 'iflow', 'cursor', 'jules']) {
      expect(retired in CommandRegistrar.AGENT_CONFIGS).toBe(false);
    }
  });

  test('instance view mirrors static table', () => {
    expect(new CommandRegistrar().AGENT_CONFIGS).toBe(CommandRegistrar.AGENT_CONFIGS);
  });
});

// ============================================================================
// Golden parity for every agent
// ============================================================================

interface RegistrarFixture {
  registered: string[];
  files: Record<string, string>;
}

const EXT_CMD = `---
description: "Commit changes with a conventional message — über fast. This description is deliberately long so that YAML emitters would fold it across multiple lines if width were limited"
argument-hint: "Optional commit message"
handoffs:
  - label: Plan it
    agent: speckit.plan
    prompt: Continue with speckit.git.commit
scripts:
  sh: scripts/bash/commit.sh --json {ARGS}
  ps: scripts/powershell/commit.ps1 -Json {ARGS}
---

# Commit

User input: $ARGUMENTS

Run \`{SCRIPT}\` from the repo root, then read \`agents/helper.md\` and templates/commit-template.md.
Call __SPECKIT_COMMAND_GIT_COMMIT__ or __SPECKIT_COMMAND_PLAN__ when done (see ../../scripts/bash/common.sh).
Agent: __AGENT__

## Hooks

- For each executable hook, output the following
  - \`/speckit.git.commit\`
Windows path: C:\\Users\\dev\\file
`;

const SIMPLE = `---
description: Show status
---
Status for $ARGUMENTS
`;

describe('register_commands golden parity (extension commands)', () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'registrar-extension-commands.json'), 'utf-8')) as Record<
    string,
    RegistrarFixture
  >;
  for (const [agent, expected] of Object.entries(fixture)) {
    test(agent, () => {
      mkdirSync(join(tmp, '.specify'), { recursive: true });
      writeFileSync(join(tmp, '.specify', 'init-options.json'), JSON.stringify({ ai: agent, script: 'sh' }));
      const ext = writeExt(tmp, { 'commands/commit.md': EXT_CMD, 'commands/status.md': SIMPLE, 'agents/.keep': '' });
      const reg = new CommandRegistrar();
      const registered = reg.registerCommands(
        agent,
        [
          { name: 'speckit.git.commit', file: 'commands/commit.md', aliases: ['speckit.git.ci'] },
          { name: 'speckit.git.status', file: 'commands/status.md' },
        ],
        'git',
        ext,
        tmp,
        { extensionId: 'git' },
      );
      expect(registered).toEqual(expected.registered);
      const actual: Record<string, string> = {};
      for (const rel of listFiles(tmp, (r) => r.startsWith('.specify/extensions') || r.endsWith('init-options.json'))) {
        actual[rel] = readFileSync(join(tmp, rel), 'utf-8');
      }
      for (const rel of listFiles(home)) actual[`~/${rel}`] = readFileSync(join(home, rel), 'utf-8');
      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected.files).sort());
      for (const rel of Object.keys(actual)) {
        expect({ rel, content: actual[rel] }).toEqual({ rel, content: expected.files[rel] });
      }
    });
  }
});

describe('register_commands golden parity (preset source, custom context note)', () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'registrar-preset-commands.json'), 'utf-8')) as Record<
    string,
    RegistrarFixture
  >;
  for (const [agent, expected] of Object.entries(fixture)) {
    test(agent, () => {
      const src = join(tmp, 'src');
      mkdirSync(src);
      writeFileSync(join(src, 'x.md'), EXT_CMD, 'utf-8');
      const reg = new CommandRegistrar();
      const registered = reg.registerCommands(agent, [{ name: 'speckit.plan', file: 'x.md' }], 'my-preset', src, tmp, {
        contextNote: '\n<!-- Preset: my-preset -->\n',
      });
      expect(registered).toEqual(expected.registered);
      const actual: Record<string, string> = {};
      for (const rel of listFiles(tmp, (r) => r === 'src' || r.startsWith('src/'))) {
        actual[rel] = readFileSync(join(tmp, rel), 'utf-8');
      }
      for (const rel of listFiles(home)) actual[`~/${rel}`] = readFileSync(join(home, rel), 'utf-8');
      expect(actual).toEqual(expected.files);
    });
  }
});

// ============================================================================
// Path traversal (test_registrar_path_traversal.py)
// ============================================================================

describe('path traversal guards', () => {
  function setupSource(): string {
    const src = join(tmp, 'ext');
    mkdirSync(join(src, 'commands'), { recursive: true });
    writeFileSync(join(src, 'commands', 'ok.md'), SIMPLE);
    writeFileSync(join(tmp, 'secret.md'), '---\ndescription: secret\n---\nsecret');
    return src;
  }

  test('rejects traversal in command names', () => {
    const src = setupSource();
    const reg = new CommandRegistrar();
    for (const bad of ['../evil', 'speckit.x/../../evil', '/abs/evil', 'C:evil', 'a\\b', ' lead']) {
      expect(() => reg.registerCommands('claude', [{ name: bad, file: 'commands/ok.md' }], 'x', src, tmp)).toThrow(
        /Invalid command name/,
      );
    }
  });

  test('rejects traversal in aliases and non-list aliases', () => {
    const src = setupSource();
    const reg = new CommandRegistrar();
    expect(() =>
      reg.registerCommands('gemini', [{ name: 'speckit.ok', file: 'commands/ok.md', aliases: ['../../evil'] }], 'x', src, tmp),
    ).toThrow(/Invalid command alias/);
    expect(() =>
      reg.registerCommands(
        'gemini',
        [{ name: 'speckit.ok', file: 'commands/ok.md', aliases: 'speckit.alias' as unknown as string[] }],
        'x',
        src,
        tmp,
      ),
    ).toThrow(/must be a list/);
  });

  test('skips source files escaping the source dir', () => {
    const src = setupSource();
    const reg = new CommandRegistrar();
    const registered = reg.registerCommands(
      'claude',
      [
        { name: 'speckit.a', file: '../secret.md' },
        { name: 'speckit.b', file: '/etc/passwd' },
        { name: 'speckit.c', file: 'commands/missing.md' },
        { name: 'speckit.ok', file: 'commands/ok.md' },
      ],
      'x',
      src,
      tmp,
    );
    expect(registered).toEqual(['speckit.ok']);
  });

  test('ensureInside rejects escaping output paths', () => {
    expect(() => CommandRegistrar.ensureInside('/base/../other/x', '/base')).toThrow(/escapes directory/);
    expect(() => CommandRegistrar.ensureInside('/base/sub/x.md', '/base')).not.toThrow();
  });

  test('isSafeCommandName', () => {
    expect(CommandRegistrar.isSafeCommandName('speckit.plan')).toBe(true);
    expect(CommandRegistrar.isSafeCommandName('a/b')).toBe(false);
    expect(CommandRegistrar.isSafeCommandName('..')).toBe(true); // normpath('..') == '..'
    expect(CommandRegistrar.isSafeCommandName('a\\b')).toBe(false);
  });

  test('copilot prompt name validation', () => {
    expect(() => CommandRegistrar.writeCopilotPrompt(tmp, '../evil')).toThrow(/Invalid Copilot prompt name/);
    CommandRegistrar.writeCopilotPrompt(tmp, 'speckit.x');
    expect(readFileSync(join(tmp, '.github', 'prompts', 'speckit.x.prompt.md'), 'utf-8')).toBe('---\nagent: speckit.x\n---\n');
  });

  test('unsupported agent', () => {
    expect(() => new CommandRegistrar().registerCommands('nope', [], 'x', tmp, tmp)).toThrow('Unsupported agent: nope');
  });
});

// ============================================================================
// Rendering helpers
// ============================================================================

describe('rendering helpers', () => {
  test('output names', () => {
    const cfg = CommandRegistrar.AGENT_CONFIGS;
    expect(CommandRegistrar.computeOutputName('claude', 'speckit.git.commit', cfg.claude)).toBe('speckit-git-commit');
    expect(CommandRegistrar.computeOutputName('gemini', 'speckit.git.commit', cfg.gemini)).toBe('speckit.git.commit');
    expect(CommandRegistrar.computeOutputName('forge', 'speckit.git.commit', cfg.forge)).toBe('speckit-git-commit');
    expect(CommandRegistrar.computeOutputName('junie', 'plan', cfg.junie)).toBe('speckit-plan');
  });

  test('build_skill_frontmatter normalizes author', () => {
    expect(CommandRegistrar.buildSkillFrontmatter('claude', 'speckit-x', 'd', 's', '')).toEqual({
      name: 'speckit-x',
      description: 'd',
      compatibility: 'Requires spec-kit project structure with .specify/ directory',
      metadata: { author: 'github-spec-kit', source: 's' },
    });
    expect((CommandRegistrar.buildSkillFrontmatter('claude', 'n', 'd', 's', 'acme').metadata as Record<string, string>).author).toBe(
      'acme',
    );
  });

  test('apply_argument_hint only for hint-capable integrations', () => {
    const skillFm: Record<string, unknown> = {};
    CommandRegistrar.applyArgumentHint({ 'argument-hint': 'H' }, skillFm, INTEGRATION_REGISTRY.claude);
    expect(skillFm['argument-hint']).toBe('H');
    const other: Record<string, unknown> = {};
    CommandRegistrar.applyArgumentHint({ 'argument-hint': 'H' }, other, INTEGRATION_REGISTRY.codex);
    expect('argument-hint' in other).toBe(false);
  });

  test('hyphenate refs', () => {
    expect(CommandRegistrar.hyphenateBodyRefs('use speckit.git.commit and speckit.plan.')).toBe(
      'use speckit-git-commit and speckit-plan.',
    );
    expect(CommandRegistrar.hyphenateFrontmatterRefs({ a: ['speckit.x.y', 1], b: { c: 'speckit.z' } })).toEqual({
      a: ['speckit-x-y', 1],
      b: { c: 'speckit-z' },
    });
  });

  test('rewrite_extension_paths only rewrites existing subdirs', () => {
    const ext = join(tmp, 'ext');
    mkdirSync(join(ext, 'agents'), { recursive: true });
    mkdirSync(join(ext, 'commands'), { recursive: true });
    mkdirSync(join(ext, '.hidden'), { recursive: true });
    const out = CommandRegistrar.rewriteExtensionPaths(
      'see agents/a.md, ./agents/b.md, /agents/c.md, commands/x.md, docs/d.md',
      'git',
      ext,
    );
    expect(out).toBe(
      'see .specify/extensions/git/agents/a.md, .specify/extensions/git/agents/b.md, /agents/c.md, commands/x.md, docs/d.md',
    );
  });

  test('pyNormpath', () => {
    expect(pyNormpath('a/./b/../c')).toBe('a/c');
    expect(pyNormpath('../x')).toBe('../x');
    expect(pyNormpath('')).toBe('.');
    expect(pyNormpath('//a//b')).toBe('//a/b');
  });
});

// ============================================================================
// Aliases, symlinks, legacy dirs, unregister
// ============================================================================

describe('registration behaviors', () => {
  test('aliases for inject_name agents get alias-specific name', () => {
    const src = join(tmp, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'c.md'), SIMPLE);
    const reg = new CommandRegistrar();
    const names = reg.registerCommands('forge', [{ name: 'speckit.ext.run', file: 'c.md', aliases: ['speckit.ext.go'] }], 'ext', src, tmp);
    expect(names).toEqual(['speckit.ext.run', 'speckit.ext.go']);
    const alias = readFileSync(join(tmp, '.forge', 'commands', 'speckit-ext-go.md'), 'utf-8');
    expect(alias).toContain('name: speckit-ext-go');
    expect(alias).toContain('{{parameters}}');
  });

  test('dev-mode link_outputs symlinks to a source-local cache (and dev_no_symlink writes files)', () => {
    const src = join(tmp, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'c.md'), SIMPLE);
    const reg = new CommandRegistrar();
    reg.registerCommands('gemini', [{ name: 'speckit.ext.run', file: 'c.md' }], 'ext', src, tmp, { linkOutputs: true });
    const dest = join(tmp, '.gemini', 'commands', 'speckit.ext.run.toml');
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(existsSync(join(src, '.specify-dev', 'agent-commands', 'gemini', 'speckit.ext.run.toml'))).toBe(true);
    reg.registerCommands('codex', [{ name: 'speckit.ext.run', file: 'c.md' }], 'ext', src, tmp, { linkOutputs: true });
    const codexDest = join(tmp, '.agents', 'skills', 'speckit-ext-run', 'SKILL.md');
    expect(lstatSync(codexDest).isSymbolicLink()).toBe(false);
  });

  test('legacy_dir fallback warns and unregister cleans both dirs', () => {
    mkdirSync(join(tmp, '.kilocode', 'workflows'), { recursive: true });
    const src = join(tmp, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'c.md'), SIMPLE);
    const reg = new CommandRegistrar();
    const [, warnings] = captureWarnings(() =>
      reg.registerCommands('kilocode', [{ name: 'speckit.ext.run', file: 'c.md' }], 'ext', src, tmp),
    );
    expect(warnings.some((w) => w.message.includes("Found legacy '.kilocode/workflows' directory for kilocode"))).toBe(true);
    expect(existsSync(join(tmp, '.kilocode', 'workflows', 'speckit.ext.run.md'))).toBe(true);
    captureWarnings(() => reg.unregisterCommands({ kilocode: ['speckit.ext.run'] }, tmp));
    expect(existsSync(join(tmp, '.kilocode', 'workflows', 'speckit.ext.run.md'))).toBe(false);
  });

  test('unregister removes skill dirs and copilot prompts', () => {
    const src = join(tmp, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'c.md'), SIMPLE);
    const reg = new CommandRegistrar();
    reg.registerCommands('claude', [{ name: 'speckit.ext.run', file: 'c.md' }], 'ext', src, tmp);
    reg.registerCommands('copilot', [{ name: 'speckit.ext.run', file: 'c.md' }], 'ext', src, tmp);
    expect(existsSync(join(tmp, '.github', 'prompts', 'speckit.ext.run.prompt.md'))).toBe(true);
    reg.unregisterCommands({ claude: ['speckit.ext.run'], copilot: ['speckit.ext.run'], bogus: ['x'] }, tmp);
    expect(existsSync(join(tmp, '.claude', 'skills', 'speckit-ext-run'))).toBe(false);
    expect(existsSync(join(tmp, '.github', 'agents', 'speckit.ext.run.agent.md'))).toBe(false);
    expect(existsSync(join(tmp, '.github', 'prompts', 'speckit.ext.run.prompt.md'))).toBe(false);
  });

  test('unreadable (non UTF-8) source is skipped with a warning', () => {
    const src = join(tmp, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'bad.md'), Buffer.from([0xff, 0xfe, 0x00]));
    const reg = new CommandRegistrar();
    const [names, warnings] = captureWarnings(() =>
      reg.registerCommands('gemini', [{ name: 'speckit.bad', file: 'bad.md' }], 'x', src, tmp),
    );
    expect(names).toEqual([]);
    expect(warnings[0].message).toContain("Skipping command 'speckit.bad'");
  });
});

describe('register_commands_for_all_agents', () => {
  function src(): string {
    const s = join(tmp, 'src');
    mkdirSync(s, { recursive: true });
    writeFileSync(join(s, 'c.md'), SIMPLE);
    return s;
  }

  test('only registers for detected agent directories', () => {
    const s = src();
    mkdirSync(join(tmp, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(tmp, '.gemini', 'commands'), { recursive: true });
    const res = new CommandRegistrar().registerCommandsForAllAgents([{ name: 'speckit.ext.run', file: 'c.md' }], 'ext', s, tmp);
    expect(Object.keys(res).sort()).toEqual(['claude', 'gemini']);
  });

  test('only_agent restricts registration', () => {
    const s = src();
    mkdirSync(join(tmp, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(tmp, '.gemini', 'commands'), { recursive: true });
    const res = new CommandRegistrar().registerCommandsForAllAgents([{ name: 'speckit.ext.run', file: 'c.md' }], 'ext', s, tmp, {
      onlyAgent: 'gemini',
    });
    expect(Object.keys(res)).toEqual(['gemini']);
  });

  test('hermes requires project-local detect_dir', () => {
    const s = src();
    mkdirSync(join(home, '.hermes', 'skills'), { recursive: true });
    let res = new CommandRegistrar().registerCommandsForAllAgents([{ name: 'speckit.ext.run', file: 'c.md' }], 'ext', s, tmp);
    expect('hermes' in res).toBe(false);
    mkdirSync(join(tmp, '.hermes', 'skills'), { recursive: true });
    res = new CommandRegistrar().registerCommandsForAllAgents([{ name: 'speckit.ext.run', file: 'c.md' }], 'ext', s, tmp);
    expect(res.hermes).toEqual(['speckit.ext.run']);
    expect(existsSync(join(home, '.hermes', 'skills', 'speckit-ext-run', 'SKILL.md'))).toBe(true);
  });

  test('non-skill variant skips SKILL.md agents and honours extra_agents', () => {
    const s = src();
    mkdirSync(join(tmp, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(tmp, '.gemini', 'commands'), { recursive: true });
    mkdirSync(join(tmp, '.qwen', 'commands'), { recursive: true });
    const reg = new CommandRegistrar();
    expect(Object.keys(reg.registerCommandsForNonSkillAgents([{ name: 'speckit.e', file: 'c.md' }], 'ext', s, tmp)).sort()).toEqual([
      'gemini',
      'qwen',
    ]);
    expect(
      Object.keys(
        reg.registerCommandsForNonSkillAgents([{ name: 'speckit.e', file: 'c.md' }], 'ext', s, tmp, {
          onlyAgent: 'gemini',
          extraAgents: ['qwen'],
        }),
      ).sort(),
    ).toEqual(['gemini', 'qwen']);
    expect(
      Object.keys(reg.registerCommandsForNonSkillAgents([{ name: 'speckit.e', file: 'c.md' }], 'ext', s, tmp, { onlyAgent: '' })),
    ).toEqual([]);
  });

  test('active skills agent directory is recreated when missing', () => {
    const s = src();
    mkdirSync(join(tmp, '.specify'), { recursive: true });
    writeFileSync(join(tmp, '.specify', 'init-options.json'), JSON.stringify({ ai: 'claude', ai_skills: true }));
    const res = new CommandRegistrar().registerCommandsForAllAgents([{ name: 'speckit.ext.run', file: 'c.md' }], 'ext', s, tmp, {
      createMissingActiveSkillsDir: true,
    });
    expect(res.claude).toEqual(['speckit.ext.run']);
    expect(statSync(join(tmp, '.claude', 'skills', 'speckit-ext-run')).isDirectory()).toBe(true);
  });

  test('shared .agents/skills recreated by the active agent does not trigger other agents', () => {
    const s = src();
    mkdirSync(join(tmp, '.specify'), { recursive: true });
    writeFileSync(join(tmp, '.specify', 'init-options.json'), JSON.stringify({ ai: 'codex', ai_skills: true }));
    const res = new CommandRegistrar().registerCommandsForAllAgents([{ name: 'speckit.ext.run', file: 'c.md' }], 'ext', s, tmp, {
      createMissingActiveSkillsDir: true,
    });
    expect(Object.keys(res)).toEqual(['codex']);
  });
});
