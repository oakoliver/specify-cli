/**
 * Tests for the legacy registrar compatibility layer (src/registrar.ts).
 *
 * The layer now delegates to the upstream-parity CommandRegistrar
 * (src/agents.ts); behavior intentionally follows upstream v1.0.12:
 * full YAML frontmatter, skills-first agents (claude/codex/kimi → SKILL.md
 * with speckit-<name> directories), Copilot prompt files contain only the
 * `agent:` key, Goose recipes use the upstream header + `prompt: |2`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseFrontmatter,
  renderFrontmatter,
  toToml,
  toYamlRecipe,
  registerCommands,
  registerCommandsForAllAgents,
  unregisterCommands,
} from '../src/registrar.js';
import { SUPPORTED_AGENTS, type CommandDefinition } from '../src/types.js';
import { parseYaml } from '../src/yaml.js';

// ============================================================================
// Frontmatter
// ============================================================================

describe('parseFrontmatter', () => {
  test('parses valid frontmatter (full YAML)', () => {
    const { frontmatter, body } = parseFrontmatter(`---
description: My command description
enabled: true
count: 3
nothing:
handoffs:
  - label: Plan
    agent: speckit.plan
---

Command body here
`);
    expect(frontmatter).toEqual({
      description: 'My command description',
      enabled: true,
      count: 3,
      nothing: null,
      handoffs: [{ label: 'Plan', agent: 'speckit.plan' }],
    });
    expect(body).toBe('Command body here');
  });

  test('no frontmatter / unterminated frontmatter returns content unchanged', () => {
    expect(parseFrontmatter('Just a body')).toEqual({ frontmatter: {}, body: 'Just a body' });
    expect(parseFrontmatter('---\ndescription: x\nbody')).toEqual({ frontmatter: {}, body: '---\ndescription: x\nbody' });
  });

  test('closing delimiter is line-anchored', () => {
    const { frontmatter, body } = parseFrontmatter('---\ndescription: Separate sections with ---\nb: 1\n---\nbody');
    expect(frontmatter).toEqual({ description: 'Separate sections with ---', b: 1 });
    expect(body).toBe('body');
  });

  test('non-mapping / malformed YAML gives empty dict', () => {
    expect(parseFrontmatter('---\n- a\n- b\n---\nbody').frontmatter).toEqual({});
    expect(parseFrontmatter('---\na: [\n---\nbody').frontmatter).toEqual({});
  });
});

describe('renderFrontmatter', () => {
  test('renders YAML frontmatter followed by body', () => {
    expect(renderFrontmatter({ description: 'Test', handoffs: ['a', 'b'] }, 'Body')).toBe(
      '---\ndescription: Test\nhandoffs:\n- a\n- b\n---\n\nBody',
    );
  });

  test('empty frontmatter renders body only', () => {
    expect(renderFrontmatter({}, 'Body')).toBe('Body');
    expect(renderFrontmatter({ x: null }, 'Body')).toBe('Body');
  });

  test('round-trip preserves unicode and special characters', () => {
    const fm = { description: 'Ünïcödé: with # and "quotes"', n: 1 };
    const { frontmatter, body } = parseFrontmatter(renderFrontmatter(fm, 'Body'));
    expect(frontmatter).toEqual(fm);
    expect(body).toBe('Body');
  });
});

// ============================================================================
// Format generation
// ============================================================================

describe('toToml', () => {
  test('description + multiline prompt', () => {
    expect(toToml('Test description', 'Line 1\nLine 2\n')).toBe('description = "Test description"\n\nprompt = """\nLine 1\nLine 2"""\n');
  });
  test('escapes description and omits it when empty', () => {
    expect(toToml('Say "hi" \\ bye', 'x')).toBe('description = "Say \\"hi\\" \\\\ bye"\n\nprompt = "x"\n');
    expect(toToml('', 'x')).toBe('prompt = "x"\n');
  });
});

describe('toYamlRecipe', () => {
  test('produces a Goose recipe', () => {
    const out = toYamlRecipe('speckit.git.commit', 'Commit "things"', 'Line 1\n  indented\n');
    const parsed = parseYaml(out) as Record<string, unknown>;
    expect(parsed.title).toBe('Git Commit');
    expect(parsed.description).toBe('Commit "things"');
    expect(parsed.prompt).toBe('Line 1\n  indented\n');
    expect(out).toContain('prompt: |2\n');
    expect(out.endsWith('# Source: speckit.git.commit\n')).toBe(true);
  });
});

// ============================================================================
// Registration
// ============================================================================

const CMD: CommandDefinition = {
  name: 'speckit.test.cmd',
  description: 'Test command',
  content: 'Do things with $ARGUMENTS',
};

describe('registerCommands / unregisterCommands', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-legacy-reg-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('markdown agent (opencode)', async () => {
    const res = await registerCommands('opencode', [CMD], root, 'ext');
    const path = join(root, '.opencode/commands/speckit.test.cmd.md');
    expect(res).toEqual({ opencode: [path] });
    expect(readFileSync(path, 'utf-8')).toBe(
      '---\ndescription: Test command\n---\n\n\n<!-- Source: ext -->\nDo things with $ARGUMENTS',
    );
  });

  test('skills agent (claude) uses speckit-<name>/SKILL.md', async () => {
    const res = await registerCommands('claude', [CMD], root, 'ext');
    const path = join(root, '.claude/skills/speckit-test-cmd/SKILL.md');
    expect(res.claude).toEqual([path]);
    const content = readFileSync(path, 'utf-8');
    expect(content.startsWith('---\nname: speckit-test-cmd\ndescription: Test command\n')).toBe(true);
    expect(content).toContain('  source: ext:speckit.test.cmd.md\n');
  });

  test('copilot writes .agent.md and companion prompt', async () => {
    const res = await registerCommands('copilot', [CMD], root, 'ext');
    expect(res.copilot).toEqual([
      join(root, '.github/agents/speckit.test.cmd.agent.md'),
      join(root, '.github/prompts/speckit.test.cmd.prompt.md'),
    ]);
    expect(readFileSync(res.copilot[1], 'utf-8')).toBe('---\nagent: speckit.test.cmd\n---\n');
  });

  test('toml agent (gemini) converts $ARGUMENTS', async () => {
    const res = await registerCommands('gemini', [CMD], root, 'ext');
    expect(readFileSync(res.gemini[0], 'utf-8')).toBe(
      'description = "Test command"\n\n# Source: ext\n\nprompt = """\nDo things with {{args}}\n"""',
    );
  });

  test('yaml agent (goose)', async () => {
    const res = await registerCommands('goose', [CMD], root, 'ext');
    const parsed = parseYaml(readFileSync(res.goose[0], 'utf-8')) as Record<string, unknown>;
    expect(parsed.title).toBe('Test Cmd');
    expect(parsed.prompt).toBe('Do things with {{args}}\n');
  });

  test('handoffs preserved', async () => {
    const res = await registerCommands('qwen', [{ ...CMD, handoffs: ['speckit.plan'] }], root, 'ext');
    expect(readFileSync(res.qwen[0], 'utf-8')).toContain('handoffs:\n- speckit.plan\n');
  });

  test('unknown agent throws', async () => {
    await expect(registerCommands('nope', [CMD], root, 'ext')).rejects.toThrow('Unknown agent: nope');
  });

  test('unregister removes files, prunes empty dirs, is idempotent, preserves others', async () => {
    const res = await registerCommands('codex', [CMD], root, 'ext');
    const copilot = await registerCommands('copilot', [CMD], root, 'ext');
    mkdirSync(join(root, '.github/agents'), { recursive: true });
    writeFileSync(join(root, '.github/agents/other.md'), 'keep');
    await unregisterCommands({ ...res, ...copilot }, root);
    expect(existsSync(join(root, '.agents/skills/speckit-test-cmd'))).toBe(false);
    expect(existsSync(copilot.copilot[0])).toBe(false);
    expect(existsSync(copilot.copilot[1])).toBe(false);
    expect(existsSync(join(root, '.github/agents/other.md'))).toBe(true);
    await unregisterCommands(res, root);
  });

  test('registerCommandsForAllAgents with and without a target', async () => {
    expect(Object.keys(await registerCommandsForAllAgents([CMD], root, 'ext', 'gemini'))).toEqual(['gemini']);
    const all = await registerCommandsForAllAgents([CMD], root, 'ext');
    expect(Object.keys(all).sort()).toEqual([...SUPPORTED_AGENTS].sort());
  });
});
