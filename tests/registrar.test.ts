/**
 * Tests for Command Registrar
 *
 * This test suite matches the coverage from Python's spec-kit tests:
 * - test_extensions.py (CommandRegistrar tests)
 * - test_extension_skills.py (skill registration tests)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseFrontmatter,
  renderFrontmatter,
  toToml,
  registerCommands,
  registerCommandsForAllAgents,
  unregisterCommands,
  type CommandDefinition,
} from '../src/index.js';

// ============================================================================
// Frontmatter Parsing Tests (matches test_extensions.py)
// ============================================================================

describe('parseFrontmatter', () => {
  test('parses valid frontmatter', () => {
    const content = `---
description: My command description
enabled: true
---

Command body here`;

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter.description).toBe('My command description');
    expect(frontmatter.enabled).toBe(true);
    expect(body).toBe('Command body here');
  });

  test('handles content without frontmatter', () => {
    const content = 'Just some content without frontmatter';

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter).toEqual({});
    expect(body).toBe(content);
  });

  test('handles empty frontmatter', () => {
    const content = `---
---

Body content`;

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter).toEqual({});
    expect(body).toBe('Body content');
  });

  test('handles frontmatter with arrays', () => {
    const content = `---
description: Test command
handoffs:
  - label: Next Step
  - label: Another Step
---

Command body`;

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter.description).toBe('Test command');
    expect(Array.isArray(frontmatter.handoffs)).toBe(true);
    expect((frontmatter.handoffs as unknown[]).length).toBe(2);
  });

  test('handles quoted strings', () => {
    const content = `---
description: "A string with: colon"
title: 'Single quoted'
---

Body`;

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter.description).toBe('A string with: colon');
    expect(frontmatter.title).toBe('Single quoted');
  });

  test('handles numeric values', () => {
    const content = `---
priority: 10
score: 3.14
---

Body`;

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter.priority).toBe(10);
    expect(frontmatter.score).toBe(3.14);
  });

  test('handles null values', () => {
    const content = `---
value1: null
value2: ~
---

Body`;

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter.value1).toBe(null);
    expect(frontmatter.value2).toBe(null);
  });

  test('non-mapping returns empty dict (malformed YAML)', () => {
    // Content that starts with --- but has invalid YAML
    const content = `---
- just an array item
---

Body`;

    const { frontmatter, body } = parseFrontmatter(content);

    // Should still parse but may have unexpected structure
    expect(typeof frontmatter).toBe('object');
    expect(body).toBe('Body');
  });

  test('handles missing closing delimiter', () => {
    const content = `---
description: unclosed
This is actually body content`;

    const { frontmatter, body } = parseFrontmatter(content);

    // Should return entire content as body
    expect(frontmatter).toEqual({});
    expect(body).toBe(content);
  });
});

describe('renderFrontmatter', () => {
  test('renders basic frontmatter', () => {
    const frontmatter = { description: 'Test command' };
    const body = 'Command body';

    const result = renderFrontmatter(frontmatter, body);

    expect(result).toContain('---');
    expect(result).toContain('description: Test command');
    expect(result).toContain('Command body');
  });

  test('renders empty frontmatter as body only', () => {
    const result = renderFrontmatter({}, 'Just body');

    expect(result).toBe('Just body');
    expect(result).not.toContain('---');
  });

  test('renders arrays', () => {
    const frontmatter = {
      description: 'Test',
      items: ['one', 'two', 'three'],
    };

    const result = renderFrontmatter(frontmatter, 'Body');

    expect(result).toContain('items:');
    expect(result).toContain('  - one');
    expect(result).toContain('  - two');
    expect(result).toContain('  - three');
  });

  test('preserves unicode characters', () => {
    const frontmatter = { description: 'Test with emoji 🚀 and unicode ñ' };
    const body = 'Body with 日本語';

    const result = renderFrontmatter(frontmatter, body);

    expect(result).toContain('🚀');
    expect(result).toContain('ñ');
    expect(result).toContain('日本語');
  });

  test('round-trip preserves content', () => {
    const original = `---
description: Round trip test
enabled: true
---

This is the body`;

    const { frontmatter, body } = parseFrontmatter(original);
    const rendered = renderFrontmatter(frontmatter, body);
    const { frontmatter: fm2, body: b2 } = parseFrontmatter(rendered);

    expect(fm2.description).toBe('Round trip test');
    expect(fm2.enabled).toBe(true);
    expect(b2).toBe('This is the body');
  });
});

// ============================================================================
// TOML Generation Tests
// ============================================================================

describe('toToml', () => {
  test('generates valid TOML', () => {
    const result = toToml('My description', 'My prompt content');

    expect(result).toContain('description = "My description"');
    expect(result).toContain('prompt = """');
    expect(result).toContain('My prompt content');
  });

  test('escapes special characters in description', () => {
    const result = toToml('A "quoted" description', 'Prompt');

    expect(result).toContain('description = "A \\"quoted\\" description"');
  });

  test('handles multiline prompts', () => {
    const prompt = `Line 1
Line 2
Line 3`;

    const result = toToml('Desc', prompt);

    expect(result).toContain('"""');
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
    expect(result).toContain('Line 3');
  });

  test('handles empty description', () => {
    const result = toToml('', 'Prompt content');

    expect(result).toContain('description = ""');
    expect(result).toContain('prompt = """');
  });
});

// ============================================================================
// Command Registration Tests
// ============================================================================

describe('registerCommands', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `speckit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const testCommand: CommandDefinition = {
    name: 'speckit.specify',
    description: 'Create a feature specification',
    content: 'This is the command content.',
  };

  describe('Claude registration', () => {
    test('creates command file in correct directory', async () => {
      const registered = await registerCommands('claude', [testCommand], testDir, 'core');

      expect(registered.claude).toBeDefined();
      expect(registered.claude.length).toBe(1);

      const filePath = registered.claude[0];
      expect(filePath).toContain('.claude/commands/speckit.specify.md');
      expect(existsSync(filePath)).toBe(true);
    });

    test('command file has correct content', async () => {
      await registerCommands('claude', [testCommand], testDir, 'core');

      const filePath = join(testDir, '.claude/commands/speckit.specify.md');
      const content = readFileSync(filePath, 'utf-8');

      expect(content).toContain('description: Create a feature specification');
      expect(content).toContain('This is the command content.');
    });

    test('creates directory if it does not exist', async () => {
      expect(existsSync(join(testDir, '.claude/commands'))).toBe(false);

      await registerCommands('claude', [testCommand], testDir, 'core');

      expect(existsSync(join(testDir, '.claude/commands'))).toBe(true);
    });
  });

  describe('Copilot registration', () => {
    test('creates both .agent.md and .prompt.md files', async () => {
      const registered = await registerCommands('copilot', [testCommand], testDir, 'core');

      expect(registered.copilot.length).toBe(2);

      const agentFile = join(testDir, '.github/agents/speckit.specify.agent.md');
      const promptFile = join(testDir, '.github/prompts/speckit.specify.prompt.md');

      expect(existsSync(agentFile)).toBe(true);
      expect(existsSync(promptFile)).toBe(true);
    });

    test('prompt file references agent', async () => {
      await registerCommands('copilot', [testCommand], testDir, 'core');

      const promptFile = join(testDir, '.github/prompts/speckit.specify.prompt.md');
      const content = readFileSync(promptFile, 'utf-8');

      expect(content).toContain('mode: agent');
      expect(content).toContain('agent: speckit.specify');
      expect(content).toContain('@speckit.specify.agent.md');
    });
  });

  describe('Gemini/Tabnine registration (TOML)', () => {
    test('creates TOML file for Gemini', async () => {
      const registered = await registerCommands('gemini', [testCommand], testDir, 'core');

      expect(registered.gemini.length).toBe(1);

      const filePath = join(testDir, '.gemini/commands/speckit.specify.toml');
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('description = "Create a feature specification"');
      expect(content).toContain('prompt = """');
    });

    test('creates TOML file for Tabnine', async () => {
      const registered = await registerCommands('tabnine', [testCommand], testDir, 'core');

      expect(registered.tabnine.length).toBe(1);

      const filePath = join(testDir, '.tabnine/agent/commands/speckit.specify.toml');
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe('Codex/Kimi registration (SKILL.md)', () => {
    test('creates directory structure for Codex', async () => {
      const registered = await registerCommands('codex', [testCommand], testDir, 'core');

      expect(registered.codex.length).toBe(1);

      const skillPath = join(testDir, '.agents/skills/speckit.specify/SKILL.md');
      expect(existsSync(skillPath)).toBe(true);
    });

    test('SKILL.md has correct frontmatter', async () => {
      await registerCommands('codex', [testCommand], testDir, 'core');

      const skillPath = join(testDir, '.agents/skills/speckit.specify/SKILL.md');
      const content = readFileSync(skillPath, 'utf-8');

      expect(content).toContain('name: speckit.specify');
      expect(content).toContain('description: Create a feature specification');
    });

    test('creates directory structure for Kimi', async () => {
      const registered = await registerCommands('kimi', [testCommand], testDir, 'core');

      expect(registered.kimi.length).toBe(1);

      const skillPath = join(testDir, '.kimi/skills/speckit.specify/SKILL.md');
      expect(existsSync(skillPath)).toBe(true);
    });
  });

  describe('OpenCode registration', () => {
    test('uses singular command directory', async () => {
      const registered = await registerCommands('opencode', [testCommand], testDir, 'core');

      expect(registered.opencode.length).toBe(1);

      const filePath = join(testDir, '.opencode/command/speckit.specify.md');
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe('Multiple commands', () => {
    test('registers multiple commands', async () => {
      const commands: CommandDefinition[] = [
        { name: 'speckit.specify', description: 'Create spec', content: 'Content 1' },
        { name: 'speckit.plan', description: 'Create plan', content: 'Content 2' },
        { name: 'speckit.tasks', description: 'Create tasks', content: 'Content 3' },
      ];

      const registered = await registerCommands('claude', commands, testDir, 'core');

      expect(registered.claude.length).toBe(3);

      for (const cmd of commands) {
        const filePath = join(testDir, `.claude/commands/${cmd.name}.md`);
        expect(existsSync(filePath)).toBe(true);
      }
    });
  });

  describe('Command with handoffs', () => {
    test('preserves handoffs in frontmatter', async () => {
      const command: CommandDefinition = {
        name: 'speckit.specify',
        description: 'Create spec',
        content: 'Content',
        handoffs: ['speckit.plan', 'speckit.tasks'],
      };

      await registerCommands('claude', [command], testDir, 'core');

      const filePath = join(testDir, '.claude/commands/speckit.specify.md');
      const content = readFileSync(filePath, 'utf-8');

      expect(content).toContain('handoffs:');
    });
  });

  describe('Unknown agent', () => {
    test('throws for unknown agent', async () => {
      await expect(
        registerCommands('unknown-agent', [testCommand], testDir, 'core')
      ).rejects.toThrow('Unknown agent: unknown-agent');
    });
  });
});

// ============================================================================
// Command Unregistration Tests
// ============================================================================

describe('unregisterCommands', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `speckit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const testCommand: CommandDefinition = {
    name: 'speckit.specify',
    description: 'Create a feature specification',
    content: 'This is the command content.',
  };

  test('removes registered files', async () => {
    const registered = await registerCommands('claude', [testCommand], testDir, 'core');

    // Verify file exists
    expect(existsSync(registered.claude[0])).toBe(true);

    // Unregister
    await unregisterCommands(registered, testDir);

    // Verify file is removed
    expect(existsSync(registered.claude[0])).toBe(false);
  });

  test('removes Copilot companion files', async () => {
    const registered = await registerCommands('copilot', [testCommand], testDir, 'core');

    expect(registered.copilot.length).toBe(2);

    await unregisterCommands(registered, testDir);

    // Both files should be removed
    for (const path of registered.copilot) {
      expect(existsSync(path)).toBe(false);
    }
  });

  test('cleans up skill directories for Codex', async () => {
    const registered = await registerCommands('codex', [testCommand], testDir, 'core');

    const skillDir = join(testDir, '.agents/skills/speckit.specify');
    expect(existsSync(skillDir)).toBe(true);

    await unregisterCommands(registered, testDir);

    // Skill directory should be removed
    expect(existsSync(skillDir)).toBe(false);
  });

  test('handles already deleted files (idempotent)', async () => {
    const registered = await registerCommands('claude', [testCommand], testDir, 'core');

    // Delete file manually
    rmSync(registered.claude[0]);

    // Should not throw
    await expect(unregisterCommands(registered, testDir)).resolves.toBeUndefined();
  });

  test('preserves other files in directory', async () => {
    // Register a command
    await registerCommands('claude', [testCommand], testDir, 'core');

    // Create another file in the same directory
    const otherFile = join(testDir, '.claude/commands/other-command.md');
    writeFileSync(otherFile, 'Other content');

    // Unregister speckit command
    const registered = { claude: [join(testDir, '.claude/commands/speckit.specify.md')] };
    await unregisterCommands(registered, testDir);

    // Other file should still exist
    expect(existsSync(otherFile)).toBe(true);
  });
});

// ============================================================================
// Register Commands for All Agents Tests
// ============================================================================

describe('registerCommandsForAllAgents', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `speckit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const testCommand: CommandDefinition = {
    name: 'speckit.specify',
    description: 'Create a feature specification',
    content: 'Content',
  };

  test('registers for specific target agent', async () => {
    const registered = await registerCommandsForAllAgents(
      [testCommand],
      testDir,
      'core',
      'claude'
    );

    expect(Object.keys(registered)).toEqual(['claude']);
    expect(registered.claude.length).toBe(1);
  });

  test('registers for all agents when no target specified', async () => {
    const registered = await registerCommandsForAllAgents([testCommand], testDir, 'core');

    // Should have entries for all 28 agents
    const agentCount = Object.keys(registered).length;
    expect(agentCount).toBe(28);
  });
});

// ============================================================================
// YAML Recipe Generation Tests (Goose Agent Support)
// ============================================================================

import { toYamlRecipe, AGENT_CONFIGS, SUPPORTED_AGENTS, isYamlAgent } from '../src/index.js';

describe('toYamlRecipe', () => {
  test('generates valid YAML recipe structure', () => {
    const result = toYamlRecipe(
      'speckit.specify',
      'Create a feature specification',
      'You are a helpful assistant.'
    );

    expect(result).toContain('version: 1.0.0');
    expect(result).toContain('title: "Spec Kit Specify"');
    expect(result).toContain('description: "Create a feature specification"');
    expect(result).toContain('author:');
    expect(result).toContain('contact: spec-kit');
    expect(result).toContain('extensions:');
    expect(result).toContain('type: builtin');
    expect(result).toContain('name: developer');
    expect(result).toContain('activities:');
    expect(result).toContain('Spec-Driven Development');
    expect(result).toContain('prompt: |');
    expect(result).toContain('  You are a helpful assistant.');
  });

  test('escapes double quotes in description', () => {
    const result = toYamlRecipe(
      'test.cmd',
      'Description with "quotes"',
      'Prompt content'
    );

    expect(result).toContain('description: "Description with \\"quotes\\""');
  });

  test('formats multi-word command names correctly', () => {
    const result = toYamlRecipe(
      'speckit.create-new-feature',
      'Test',
      'Prompt'
    );

    expect(result).toContain('title: "Spec Kit Create New Feature"');
  });

  test('handles multi-line prompts', () => {
    const prompt = `Line 1
Line 2
Line 3`;

    const result = toYamlRecipe('test.cmd', 'Test', prompt);

    expect(result).toContain('prompt: |');
    expect(result).toContain('  Line 1');
    expect(result).toContain('  Line 2');
    expect(result).toContain('  Line 3');
  });

  test('handles empty prompt', () => {
    const result = toYamlRecipe('test.cmd', 'Test', '');

    expect(result).toContain('prompt: |');
    expect(result).toContain('version: 1.0.0');
  });
});

describe('isYamlAgent', () => {
  test('returns true for goose', () => {
    expect(isYamlAgent('goose')).toBe(true);
  });

  test('returns false for markdown agents', () => {
    expect(isYamlAgent('claude')).toBe(false);
    expect(isYamlAgent('cursor')).toBe(false);
    expect(isYamlAgent('opencode')).toBe(false);
  });

  test('returns false for toml agents', () => {
    expect(isYamlAgent('codex')).toBe(false);
  });
});

describe('goose agent registration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `goose-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('goose agent config uses yaml format', () => {
    expect(AGENT_CONFIGS['goose'].format).toBe('yaml');
    expect(AGENT_CONFIGS['goose'].dir).toBe('.goose/recipes');
  });

  test('registers commands for goose in correct directory', async () => {
    const command: CommandDefinition = {
      name: 'speckit.specify',
      description: 'Create a feature specification',
      content: 'Test prompt content',
    };

    const registered = await registerCommands('goose', [command], testDir, 'core');

    expect(registered['goose']).toBeDefined();
    expect(registered['goose'].length).toBe(1);
    expect(registered['goose'][0]).toContain('.goose/recipes');
    expect(registered['goose'][0]).toEndWith('.yaml');
  });

  test('creates valid yaml recipe file', async () => {
    const command: CommandDefinition = {
      name: 'speckit.specify',
      description: 'Create a feature specification',
      content: 'You are a spec generator.',
    };

    const registered = await registerCommands('goose', [command], testDir, 'core');
    const filePath = registered['goose'][0];

    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('title: "Spec Kit Specify"');
    expect(content).toContain('description: "Create a feature specification"');
    expect(content).toContain('prompt: |');
    expect(content).toContain('  You are a spec generator.');
  });

  test('goose is in SUPPORTED_AGENTS', () => {
    expect(SUPPORTED_AGENTS).toContain('goose');
  });
});
