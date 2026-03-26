/**
 * Tests for init command
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseInitArgs, init } from '../src/init.js';
import { loadInitOptions } from '../src/config.js';

// ============================================================================
// Test Setup
// ============================================================================

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `specify-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// parseInitArgs Tests
// ============================================================================

describe('parseInitArgs', () => {
  test('parses project name', () => {
    const opts = parseInitArgs(['my-project']);
    expect(opts.projectName).toBe('my-project');
  });

  test('parses --ai flag', () => {
    const opts = parseInitArgs(['--ai', 'claude']);
    expect(opts.ai).toBe('claude');
  });

  test('parses --here flag', () => {
    const opts = parseInitArgs(['--here']);
    expect(opts.here).toBe(true);
  });

  test('parses --force flag', () => {
    const opts = parseInitArgs(['--force']);
    expect(opts.force).toBe(true);
  });

  test('parses -f short flag', () => {
    const opts = parseInitArgs(['-f']);
    expect(opts.force).toBe(true);
  });

  test('parses --script flag', () => {
    const opts = parseInitArgs(['--script', 'ps']);
    expect(opts.script).toBe('ps');
  });

  test('parses --branch-numbering flag', () => {
    const opts = parseInitArgs(['--branch-numbering', 'timestamp']);
    expect(opts.branchNumbering).toBe('timestamp');
  });

  test('parses --no-git flag', () => {
    const opts = parseInitArgs(['--no-git']);
    expect(opts.noGit).toBe(true);
  });

  test('parses --offline flag', () => {
    const opts = parseInitArgs(['--offline']);
    expect(opts.offline).toBe(true);
  });

  test('parses --ai-skills flag', () => {
    const opts = parseInitArgs(['--ai-skills']);
    expect(opts.aiSkills).toBe(true);
  });

  test('parses --verbose flag', () => {
    const opts = parseInitArgs(['--verbose']);
    expect(opts.verbose).toBe(true);
  });

  test('parses -v short flag', () => {
    const opts = parseInitArgs(['-v']);
    expect(opts.verbose).toBe(true);
  });

  test('parses dot as project name (current directory)', () => {
    const opts = parseInitArgs(['.']);
    expect(opts.projectName).toBe('.');
  });

  test('parses multiple flags together', () => {
    const opts = parseInitArgs([
      'my-project',
      '--ai', 'copilot',
      '--script', 'sh',
      '--branch-numbering', 'sequential',
      '--force',
      '--no-git',
    ]);

    expect(opts.projectName).toBe('my-project');
    expect(opts.ai).toBe('copilot');
    expect(opts.script).toBe('sh');
    expect(opts.branchNumbering).toBe('sequential');
    expect(opts.force).toBe(true);
    expect(opts.noGit).toBe(true);
  });
});

// ============================================================================
// init() Tests
// ============================================================================

describe('init', () => {
  describe('creates project structure', () => {
    test('creates new project directory', async () => {
      const projectPath = join(testDir, 'new-project');

      const result = await init({
        projectName: projectPath,
        ai: 'claude',
        noGit: true,
      });

      expect(result).toBe(true);
      expect(existsSync(projectPath)).toBe(true);
    });

    test('creates .specify directory structure', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'claude',
        noGit: true,
      });

      expect(existsSync(join(projectPath, '.specify'))).toBe(true);
      expect(existsSync(join(projectPath, '.specify', 'templates'))).toBe(true);
      expect(existsSync(join(projectPath, '.specify', 'scripts'))).toBe(true);
      expect(existsSync(join(projectPath, '.specify', 'memory'))).toBe(true);
      expect(existsSync(join(projectPath, '.specify', 'extensions'))).toBe(true);
      expect(existsSync(join(projectPath, '.specify', 'presets'))).toBe(true);
      expect(existsSync(join(projectPath, 'specs'))).toBe(true);
    });

    test('creates init-options.json', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'opencode',
        noGit: true,
      });

      const optionsPath = join(projectPath, '.specify', 'init-options.json');
      expect(existsSync(optionsPath)).toBe(true);

      const options = loadInitOptions(projectPath);
      expect(options.ai).toBe('opencode');
    });

    test('creates constitution.md', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'claude',
        noGit: true,
      });

      const constitutionPath = join(projectPath, '.specify', 'memory', 'constitution.md');
      expect(existsSync(constitutionPath)).toBe(true);
    });
  });

  describe('copies templates', () => {
    test('copies template files', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'claude',
        noGit: true,
      });

      const templatesDir = join(projectPath, '.specify', 'templates');
      expect(existsSync(join(templatesDir, 'spec-template.md'))).toBe(true);
      expect(existsSync(join(templatesDir, 'plan-template.md'))).toBe(true);
      expect(existsSync(join(templatesDir, 'tasks-template.md'))).toBe(true);
    });

    test('copies bash scripts for sh script type', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'claude',
        script: 'sh',
        noGit: true,
      });

      const scriptsDir = join(projectPath, '.specify', 'scripts', 'bash');
      expect(existsSync(join(scriptsDir, 'create-new-feature.sh'))).toBe(true);
      expect(existsSync(join(scriptsDir, 'setup-plan.sh'))).toBe(true);
    });
  });

  describe('registers commands', () => {
    test('registers commands for claude agent', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'claude',
        noGit: true,
      });

      const commandsDir = join(projectPath, '.claude', 'commands');
      expect(existsSync(join(commandsDir, 'speckit.specify.md'))).toBe(true);
      expect(existsSync(join(commandsDir, 'speckit.plan.md'))).toBe(true);
      expect(existsSync(join(commandsDir, 'speckit.tasks.md'))).toBe(true);
      expect(existsSync(join(commandsDir, 'speckit.implement.md'))).toBe(true);
      expect(existsSync(join(commandsDir, 'speckit.analyze.md'))).toBe(true);
      expect(existsSync(join(commandsDir, 'speckit.clarify.md'))).toBe(true);
      expect(existsSync(join(commandsDir, 'speckit.checklist.md'))).toBe(true);
      expect(existsSync(join(commandsDir, 'speckit.constitution.md'))).toBe(true);
      expect(existsSync(join(commandsDir, 'speckit.taskstoissues.md'))).toBe(true);
    });

    test('registers commands for copilot agent', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'copilot',
        noGit: true,
      });

      const agentsDir = join(projectPath, '.github', 'agents');
      expect(existsSync(join(agentsDir, 'speckit.specify.agent.md'))).toBe(true);
      expect(existsSync(join(agentsDir, 'speckit.plan.agent.md'))).toBe(true);

      // Copilot also creates companion .prompt.md files
      const promptsDir = join(projectPath, '.github', 'prompts');
      expect(existsSync(join(promptsDir, 'speckit.specify.prompt.md'))).toBe(true);
    });

    test('registers commands for opencode agent', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'opencode',
        noGit: true,
      });

      const commandsDir = join(projectPath, '.opencode', 'command');
      expect(existsSync(join(commandsDir, 'speckit.specify.md'))).toBe(true);
    });

    test('registers TOML commands for gemini agent', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'gemini',
        noGit: true,
      });

      const commandsDir = join(projectPath, '.gemini', 'commands');
      expect(existsSync(join(commandsDir, 'speckit.specify.toml'))).toBe(true);
    });
  });

  describe('init options', () => {
    test('saves branch_numbering option', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'claude',
        branchNumbering: 'timestamp',
        noGit: true,
      });

      const options = loadInitOptions(projectPath);
      expect(options.branch_numbering).toBe('timestamp');
    });

    test('saves ai_skills option', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'claude',
        aiSkills: true,
        noGit: true,
      });

      const options = loadInitOptions(projectPath);
      expect(options.ai_skills).toBe(true);
    });

    test('saves script option', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'claude',
        script: 'ps',
        noGit: true,
      });

      const options = loadInitOptions(projectPath);
      expect(options.script).toBe('ps');
    });

    test('saves speckit_version', async () => {
      const projectPath = join(testDir, 'test-project');

      await init({
        projectName: projectPath,
        ai: 'claude',
        noGit: true,
      });

      const options = loadInitOptions(projectPath);
      expect(options.speckit_version).toBeDefined();
    });
  });

  describe('--here mode', () => {
    test('initializes in specified directory with --here', async () => {
      // --here flag with explicit path should init in that directory
      const result = await init({
        projectName: testDir,
        here: true,
        ai: 'claude',
        noGit: true,
        force: true, // testDir already exists
      });

      expect(result).toBe(true);
      expect(existsSync(join(testDir, '.specify'))).toBe(true);
      expect(existsSync(join(testDir, '.claude', 'commands'))).toBe(true);
    });

    test('initializes in current directory with dot', async () => {
      const projectPath = join(testDir, 'dot-test');
      mkdirSync(projectPath, { recursive: true });
      const originalCwd = process.cwd();
      process.chdir(projectPath);

      try {
        const result = await init({
          projectName: '.',
          ai: 'claude',
          noGit: true,
        });

        expect(result).toBe(true);
        expect(existsSync(join(projectPath, '.specify'))).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('--force mode', () => {
    test('fails in non-empty directory without --force', async () => {
      const projectPath = join(testDir, 'non-empty');
      mkdirSync(projectPath);
      writeFileSync(join(projectPath, 'existing-file.txt'), 'content');

      const result = await init({
        projectName: projectPath,
        ai: 'claude',
        noGit: true,
      });

      expect(result).toBe(false);
    });

    test('succeeds in non-empty directory with --force', async () => {
      const projectPath = join(testDir, 'non-empty');
      mkdirSync(projectPath);
      writeFileSync(join(projectPath, 'existing-file.txt'), 'content');

      const result = await init({
        projectName: projectPath,
        ai: 'claude',
        force: true,
        noGit: true,
      });

      expect(result).toBe(true);
      // Existing file should still be there
      expect(existsSync(join(projectPath, 'existing-file.txt'))).toBe(true);
    });

    test('reinitializes existing project with --force', async () => {
      const projectPath = join(testDir, 'existing-project');
      mkdirSync(join(projectPath, '.specify'), { recursive: true });

      const result = await init({
        projectName: projectPath,
        ai: 'opencode',
        force: true,
        noGit: true,
      });

      expect(result).toBe(true);
      const options = loadInitOptions(projectPath);
      expect(options.ai).toBe('opencode');
    });
  });

  describe('validation', () => {
    test('fails with invalid agent name', async () => {
      const projectPath = join(testDir, 'test-project');

      const result = await init({
        projectName: projectPath,
        ai: 'invalid-agent',
        noGit: true,
      });

      expect(result).toBe(false);
    });

    test('suggests similar agent names', async () => {
      const projectPath = join(testDir, 'test-project');

      // This should fail but suggest "claude"
      const result = await init({
        projectName: projectPath,
        ai: 'claud',
        noGit: true,
      });

      expect(result).toBe(false);
    });
  });
});
