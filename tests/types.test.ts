/**
 * Tests for core types and configuration
 *
 * This test suite matches the coverage from Python's spec-kit tests:
 * - test_agent_config_consistency.py
 * - test_branch_numbering.py
 * - test_merge.py (partial - JSON handling)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  // Types and constants
  AGENT_CONFIGS,
  SUPPORTED_AGENTS,
  DEFAULT_INIT_OPTIONS,
  type AgentConfig,
  type InitOptions,

  // Utility functions
  isAgentSupported,
  getAgentCommandsDir,
  getCommandFilePath,
  isSkillBasedAgent,
  isTomlAgent,
  getAgentArgsPlaceholder,

  // Config functions
  loadInitOptions,
  saveInitOptions,
  loadExtensionRegistry,
  saveExtensionRegistry,
  loadPresetRegistry,
  savePresetRegistry,
  isSpeckitProject,
  findProjectRoot,
  SPECKIT_DIR,
  INIT_OPTIONS_PATH,
  EXTENSION_REGISTRY_PATH,
  PRESET_REGISTRY_PATH,
} from '../src/index.js';

// ============================================================================
// Agent Configuration Tests (matches test_agent_config_consistency.py)
// ============================================================================

describe('AGENT_CONFIGS', () => {
  test('contains all 28 supported agents', () => {
    expect(SUPPORTED_AGENTS.length).toBe(28);
  });

  // Test each agent individually (matches Python's parametrized tests)
  const expectedAgents = [
    'claude',
    'gemini',
    'copilot',
    'cursor',
    'qwen',
    'opencode',
    'codex',
    'windsurf',
    'junie',
    'kilocode',
    'auggie',
    'roo',
    'codebuddy',
    'qodercli',
    'kiro-cli',
    'pi',
    'amp',
    'shai',
    'tabnine',
    'bob',
    'kimi',
    'trae',
    'iflow',
    // New agents added in v1.1.0
    'goose',
    'forge',
    'jules',
    'agy',
    'kiro', // alias for kiro-cli
  ];

  test('contains all expected agents', () => {
    for (const agent of expectedAgents) {
      expect(AGENT_CONFIGS[agent]).toBeDefined();
    }
  });

  test('does not contain removed legacy agents (q/amazonq)', () => {
    expect(AGENT_CONFIGS['q']).toBeUndefined();
    expect(AGENT_CONFIGS['amazonq']).toBeUndefined();
  });

  // Individual agent tests (matches test_*_in_agent_config tests)
  describe('claude', () => {
    test('has correct configuration', () => {
      const config = AGENT_CONFIGS['claude'];
      expect(config).toEqual({
        dir: '.claude/commands',
        format: 'markdown',
        args: '$ARGUMENTS',
        extension: '.md',
      });
    });
  });

  describe('gemini', () => {
    test('has TOML format', () => {
      const config = AGENT_CONFIGS['gemini'];
      expect(config.format).toBe('toml');
      expect(config.extension).toBe('.toml');
      expect(config.args).toBe('{{args}}');
      expect(config.dir).toBe('.gemini/commands');
    });
  });

  describe('copilot', () => {
    test('has .agent.md extension', () => {
      const config = AGENT_CONFIGS['copilot'];
      expect(config.dir).toBe('.github/agents');
      expect(config.format).toBe('markdown');
      expect(config.extension).toBe('.agent.md');
    });
  });

  describe('cursor', () => {
    test('has correct configuration', () => {
      const config = AGENT_CONFIGS['cursor'];
      expect(config.dir).toBe('.cursor/commands');
      expect(config.format).toBe('markdown');
    });
  });

  describe('qwen', () => {
    test('uses markdown format', () => {
      const config = AGENT_CONFIGS['qwen'];
      expect(config.format).toBe('markdown');
      expect(config.dir).toBe('.qwen/commands');
    });
  });

  describe('opencode', () => {
    test('has singular command directory', () => {
      const config = AGENT_CONFIGS['opencode'];
      expect(config.dir).toBe('.opencode/command');
      expect(config.format).toBe('markdown');
    });
  });

  describe('codex', () => {
    test('uses native skills directory', () => {
      const config = AGENT_CONFIGS['codex'];
      expect(config.dir).toBe('.agents/skills');
      expect(config.extension).toBe('/SKILL.md');
      expect(config.format).toBe('markdown');
    });
  });

  describe('windsurf', () => {
    test('uses workflows directory', () => {
      const config = AGENT_CONFIGS['windsurf'];
      expect(config.dir).toBe('.windsurf/workflows');
    });
  });

  describe('kilocode', () => {
    test('uses workflows directory', () => {
      const config = AGENT_CONFIGS['kilocode'];
      expect(config.dir).toBe('.kilocode/workflows');
    });
  });

  describe('kiro-cli', () => {
    test('uses prompts directory', () => {
      const config = AGENT_CONFIGS['kiro-cli'];
      expect(config.dir).toBe('.kiro/prompts');
      expect(config.format).toBe('markdown');
    });
  });

  describe('pi', () => {
    test('uses prompts directory', () => {
      const config = AGENT_CONFIGS['pi'];
      expect(config.dir).toBe('.pi/prompts');
      expect(config.format).toBe('markdown');
    });
  });

  describe('amp', () => {
    test('uses commands directory under .agents', () => {
      const config = AGENT_CONFIGS['amp'];
      expect(config.dir).toBe('.agents/commands');
      expect(config.format).toBe('markdown');
    });
  });

  describe('tabnine', () => {
    test('has TOML format', () => {
      const config = AGENT_CONFIGS['tabnine'];
      expect(config.format).toBe('toml');
      expect(config.extension).toBe('.toml');
      expect(config.args).toBe('{{args}}');
      expect(config.dir).toBe('.tabnine/agent/commands');
    });
  });

  describe('kimi', () => {
    test('uses skills directory', () => {
      const config = AGENT_CONFIGS['kimi'];
      expect(config.dir).toBe('.kimi/skills');
      expect(config.extension).toBe('/SKILL.md');
    });
  });

  describe('trae', () => {
    test('uses rules directory', () => {
      const config = AGENT_CONFIGS['trae'];
      expect(config.dir).toBe('.trae/rules');
      expect(config.format).toBe('markdown');
    });
  });

  describe('iflow', () => {
    test('uses commands directory', () => {
      const config = AGENT_CONFIGS['iflow'];
      expect(config.dir).toBe('.iflow/commands');
      expect(config.format).toBe('markdown');
    });
  });

  describe('roo', () => {
    test('has correct configuration', () => {
      const config = AGENT_CONFIGS['roo'];
      expect(config.dir).toBe('.roo/commands');
    });
  });

  describe('shai', () => {
    test('has correct configuration', () => {
      const config = AGENT_CONFIGS['shai'];
      expect(config.dir).toBe('.shai/commands');
    });
  });

  // Structural validation (matches test_all_agents_have_required_fields)
  test('all agents have required fields', () => {
    for (const [name, config] of Object.entries(AGENT_CONFIGS)) {
      expect(config.dir, `${name} missing dir`).toBeDefined();
      expect(config.format, `${name} missing format`).toBeDefined();
      expect(config.args, `${name} missing args`).toBeDefined();
      expect(config.extension, `${name} missing extension`).toBeDefined();
      expect(['markdown', 'toml', 'yaml']).toContain(config.format);
    }
  });

  test('all agent directories start with dot', () => {
    for (const [name, config] of Object.entries(AGENT_CONFIGS)) {
      expect(config.dir.startsWith('.'), `${name} dir should start with dot`).toBe(true);
    }
  });

  test('TOML agents use {{args}} placeholder', () => {
    const tomlAgents = Object.entries(AGENT_CONFIGS).filter(
      ([_, config]) => config.format === 'toml'
    );
    expect(tomlAgents.length).toBeGreaterThan(0);
    for (const [name, config] of tomlAgents) {
      expect(config.args, `${name} should use {{args}}`).toBe('{{args}}');
    }
  });

  test('markdown agents use $ARGUMENTS placeholder (except forge)', () => {
    const markdownAgents = Object.entries(AGENT_CONFIGS).filter(
      ([name, config]) => config.format === 'markdown' && name !== 'forge'
    );
    expect(markdownAgents.length).toBeGreaterThan(0);
    for (const [name, config] of markdownAgents) {
      expect(config.args, `${name} should use $ARGUMENTS`).toBe('$ARGUMENTS');
    }
  });

  test('forge uses {{parameters}} placeholder', () => {
    expect(AGENT_CONFIGS['forge'].args).toBe('{{parameters}}');
  });

  test('goose uses yaml format', () => {
    expect(AGENT_CONFIGS['goose'].format).toBe('yaml');
  });

  test('skill-based agents use /SKILL.md extension', () => {
    const skillAgents = ['codex', 'kimi', 'agy'];
    for (const agent of skillAgents) {
      expect(AGENT_CONFIGS[agent].extension).toBe('/SKILL.md');
    }
  });
});

// ============================================================================
// Utility Function Tests
// ============================================================================

describe('isAgentSupported', () => {
  test('returns true for valid agents', () => {
    expect(isAgentSupported('copilot')).toBe(true);
    expect(isAgentSupported('claude')).toBe(true);
    expect(isAgentSupported('opencode')).toBe(true);
    expect(isAgentSupported('gemini')).toBe(true);
    expect(isAgentSupported('kiro-cli')).toBe(true);
  });

  test('returns false for invalid agents', () => {
    expect(isAgentSupported('invalid')).toBe(false);
    expect(isAgentSupported('')).toBe(false);
    expect(isAgentSupported('COPILOT')).toBe(false); // case-sensitive
  });

  test('returns false for removed legacy agents', () => {
    expect(isAgentSupported('q')).toBe(false);
    expect(isAgentSupported('amazonq')).toBe(false);
  });
});

describe('getAgentCommandsDir', () => {
  test('returns correct path for each agent type', () => {
    expect(getAgentCommandsDir('/project', 'copilot')).toBe('/project/.github/agents');
    expect(getAgentCommandsDir('/project', 'claude')).toBe('/project/.claude/commands');
    expect(getAgentCommandsDir('/project', 'gemini')).toBe('/project/.gemini/commands');
    expect(getAgentCommandsDir('/project', 'codex')).toBe('/project/.agents/skills');
    expect(getAgentCommandsDir('/project', 'kiro-cli')).toBe('/project/.kiro/prompts');
    expect(getAgentCommandsDir('/project', 'trae')).toBe('/project/.trae/rules');
    expect(getAgentCommandsDir('/project', 'windsurf')).toBe('/project/.windsurf/workflows');
  });

  test('throws for unknown agent', () => {
    expect(() => getAgentCommandsDir('/project', 'unknown')).toThrow('Unknown agent: unknown');
  });

  test('handles paths with trailing slash', () => {
    const path = getAgentCommandsDir('/project/', 'claude');
    expect(path).toBe('/project//.claude/commands');
  });
});

describe('getCommandFilePath', () => {
  describe('markdown agents', () => {
    test('returns correct path for claude', () => {
      const path = getCommandFilePath('/project', 'claude', 'speckit.specify');
      expect(path).toBe('/project/.claude/commands/speckit.specify.md');
    });

    test('returns correct path for cursor', () => {
      const path = getCommandFilePath('/project', 'cursor', 'speckit.plan');
      expect(path).toBe('/project/.cursor/commands/speckit.plan.md');
    });
  });

  describe('copilot with .agent.md', () => {
    test('returns correct path', () => {
      const path = getCommandFilePath('/project', 'copilot', 'speckit.specify');
      expect(path).toBe('/project/.github/agents/speckit.specify.agent.md');
    });
  });

  describe('skill-based agents', () => {
    test('returns correct path for codex', () => {
      const path = getCommandFilePath('/project', 'codex', 'speckit.specify');
      expect(path).toBe('/project/.agents/skills/speckit.specify/SKILL.md');
    });

    test('returns correct path for kimi', () => {
      const path = getCommandFilePath('/project', 'kimi', 'speckit.specify');
      expect(path).toBe('/project/.kimi/skills/speckit.specify/SKILL.md');
    });
  });

  describe('TOML agents', () => {
    test('returns correct path for gemini', () => {
      const path = getCommandFilePath('/project', 'gemini', 'speckit.specify');
      expect(path).toBe('/project/.gemini/commands/speckit.specify.toml');
    });

    test('returns correct path for tabnine', () => {
      const path = getCommandFilePath('/project', 'tabnine', 'speckit.specify');
      expect(path).toBe('/project/.tabnine/agent/commands/speckit.specify.toml');
    });
  });

  test('throws for unknown agent', () => {
    expect(() => getCommandFilePath('/project', 'unknown', 'cmd')).toThrow();
  });
});

describe('isSkillBasedAgent', () => {
  test('returns true for codex and kimi', () => {
    expect(isSkillBasedAgent('codex')).toBe(true);
    expect(isSkillBasedAgent('kimi')).toBe(true);
  });

  test('returns false for other agents', () => {
    expect(isSkillBasedAgent('claude')).toBe(false);
    expect(isSkillBasedAgent('copilot')).toBe(false);
    expect(isSkillBasedAgent('gemini')).toBe(false);
    expect(isSkillBasedAgent('opencode')).toBe(false);
    expect(isSkillBasedAgent('amp')).toBe(false);
  });

  test('returns false for unknown agent', () => {
    expect(isSkillBasedAgent('unknown')).toBe(false);
  });
});

describe('isTomlAgent', () => {
  test('returns true for gemini and tabnine', () => {
    expect(isTomlAgent('gemini')).toBe(true);
    expect(isTomlAgent('tabnine')).toBe(true);
  });

  test('returns false for markdown agents', () => {
    expect(isTomlAgent('claude')).toBe(false);
    expect(isTomlAgent('copilot')).toBe(false);
    expect(isTomlAgent('codex')).toBe(false);
    expect(isTomlAgent('kiro-cli')).toBe(false);
  });

  test('returns false for unknown agent', () => {
    expect(isTomlAgent('unknown')).toBe(false);
  });
});

describe('getAgentArgsPlaceholder', () => {
  test('returns $ARGUMENTS for markdown agents', () => {
    expect(getAgentArgsPlaceholder('claude')).toBe('$ARGUMENTS');
    expect(getAgentArgsPlaceholder('copilot')).toBe('$ARGUMENTS');
    expect(getAgentArgsPlaceholder('codex')).toBe('$ARGUMENTS');
    expect(getAgentArgsPlaceholder('opencode')).toBe('$ARGUMENTS');
  });

  test('returns {{args}} for TOML agents', () => {
    expect(getAgentArgsPlaceholder('gemini')).toBe('{{args}}');
    expect(getAgentArgsPlaceholder('tabnine')).toBe('{{args}}');
  });

  test('returns $ARGUMENTS for unknown agent (fallback)', () => {
    expect(getAgentArgsPlaceholder('unknown')).toBe('$ARGUMENTS');
  });
});

// ============================================================================
// Init Options Tests (matches test_branch_numbering.py)
// ============================================================================

describe('Init Options', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `speckit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('DEFAULT_INIT_OPTIONS', () => {
    test('has correct defaults', () => {
      expect(DEFAULT_INIT_OPTIONS.ai).toBe('copilot');
      expect(DEFAULT_INIT_OPTIONS.script).toBe('sh');
      expect(DEFAULT_INIT_OPTIONS.branch_numbering).toBe('sequential');
      expect(DEFAULT_INIT_OPTIONS.ai_skills).toBe(false);
    });
  });

  describe('loadInitOptions', () => {
    test('returns defaults when file does not exist', () => {
      const options = loadInitOptions(testDir);
      expect(options).toEqual(DEFAULT_INIT_OPTIONS);
    });

    test('returns defaults on invalid JSON', () => {
      const specifyDir = join(testDir, '.specify');
      mkdirSync(specifyDir, { recursive: true });
      writeFileSync(join(specifyDir, 'init-options.json'), 'not valid json');

      const loaded = loadInitOptions(testDir);
      expect(loaded).toEqual(DEFAULT_INIT_OPTIONS);
    });

    test('returns defaults on empty file', () => {
      const specifyDir = join(testDir, '.specify');
      mkdirSync(specifyDir, { recursive: true });
      writeFileSync(join(specifyDir, 'init-options.json'), '');

      const loaded = loadInitOptions(testDir);
      expect(loaded).toEqual(DEFAULT_INIT_OPTIONS);
    });

    test('merges with defaults for partial data', () => {
      const specifyDir = join(testDir, '.specify');
      mkdirSync(specifyDir, { recursive: true });
      writeFileSync(join(specifyDir, 'init-options.json'), JSON.stringify({ ai: 'gemini' }));

      const loaded = loadInitOptions(testDir);

      expect(loaded.ai).toBe('gemini');
      expect(loaded.script).toBe('sh');
      expect(loaded.branch_numbering).toBe('sequential');
      expect(loaded.ai_skills).toBe(false);
    });
  });

  describe('saveInitOptions', () => {
    test('creates file and directories', () => {
      const options: InitOptions = {
        ai: 'claude',
        script: 'sh',
        branch_numbering: 'timestamp',
        ai_skills: true,
      };

      saveInitOptions(testDir, options);

      const filePath = join(testDir, '.specify/init-options.json');
      expect(existsSync(filePath)).toBe(true);
    });

    test('writes valid JSON', () => {
      const options: InitOptions = {
        ai: 'opencode',
        script: 'ps',
        branch_numbering: 'sequential',
        ai_skills: false,
      };

      saveInitOptions(testDir, options);

      const filePath = join(testDir, '.specify/init-options.json');
      const content = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed).toEqual(options);
    });
  });

  describe('round-trip', () => {
    test('preserves all fields', () => {
      const options: InitOptions = {
        ai: 'opencode',
        script: 'ps',
        branch_numbering: 'sequential',
        ai_skills: false,
      };

      saveInitOptions(testDir, options);
      const loaded = loadInitOptions(testDir);

      expect(loaded).toEqual(expect.objectContaining(options));
    });

    test('preserves timestamp branch numbering', () => {
      const options: InitOptions = {
        ai: 'claude',
        script: 'sh',
        branch_numbering: 'timestamp',
        ai_skills: true,
      };

      saveInitOptions(testDir, options);
      const loaded = loadInitOptions(testDir);

      expect(loaded.branch_numbering).toBe('timestamp');
    });

    test('preserves ai_skills flag', () => {
      const options: InitOptions = {
        ai: 'codex',
        script: 'sh',
        branch_numbering: 'sequential',
        ai_skills: true,
      };

      saveInitOptions(testDir, options);
      const loaded = loadInitOptions(testDir);

      expect(loaded.ai_skills).toBe(true);
    });

    test('preserves custom ai_commands_dir', () => {
      const options: InitOptions = {
        ai: 'generic',
        script: 'sh',
        branch_numbering: 'sequential',
        ai_skills: false,
        ai_commands_dir: '.custom/commands',
      };

      saveInitOptions(testDir, options);
      const loaded = loadInitOptions(testDir);

      expect(loaded.ai_commands_dir).toBe('.custom/commands');
    });
  });
});

// ============================================================================
// Extension Registry Tests
// ============================================================================

describe('Extension Registry', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `speckit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('loadExtensionRegistry', () => {
    test('returns empty registry when file does not exist', () => {
      const registry = loadExtensionRegistry(testDir);
      expect(registry.version).toBe(1);
      expect(registry.extensions).toEqual({});
    });

    test('returns empty registry on corrupted file', () => {
      const dir = join(testDir, '.specify/extensions');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.registry'), 'not valid json');

      const registry = loadExtensionRegistry(testDir);
      expect(registry.version).toBe(1);
      expect(registry.extensions).toEqual({});
    });
  });

  describe('saveExtensionRegistry', () => {
    test('creates file and directories', () => {
      const registry = {
        version: 1,
        extensions: {
          'test-ext': {
            manifest: {
              id: 'test-ext',
              name: 'Test Extension',
              version: '1.0.0',
            },
            installedAt: new Date().toISOString(),
            source: '/path/to/ext',
            registeredCommands: {},
          },
        },
      };

      saveExtensionRegistry(testDir, registry);

      const filePath = join(testDir, '.specify/extensions/.registry');
      expect(existsSync(filePath)).toBe(true);
    });

    test('round-trips correctly', () => {
      const registry = {
        version: 1,
        extensions: {
          'my-ext': {
            manifest: {
              id: 'my-ext',
              name: 'My Extension',
              version: '2.0.0',
              description: 'A test extension',
            },
            installedAt: '2026-03-25T12:00:00Z',
            source: 'https://example.com/ext.zip',
            registeredCommands: {
              claude: ['.claude/commands/speckit.custom.md'],
            },
          },
        },
      };

      saveExtensionRegistry(testDir, registry);
      const loaded = loadExtensionRegistry(testDir);

      expect(loaded).toEqual(registry);
    });
  });
});

// ============================================================================
// Preset Registry Tests
// ============================================================================

describe('Preset Registry', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `speckit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('loadPresetRegistry', () => {
    test('returns empty registry when file does not exist', () => {
      const registry = loadPresetRegistry(testDir);
      expect(registry.version).toBe(1);
      expect(registry.presets).toEqual({});
    });

    test('returns empty registry on corrupted file', () => {
      const dir = join(testDir, '.specify/presets');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.registry'), '{corrupted');

      const registry = loadPresetRegistry(testDir);
      expect(registry.version).toBe(1);
      expect(registry.presets).toEqual({});
    });
  });

  describe('savePresetRegistry', () => {
    test('creates file and directories', () => {
      const registry = {
        version: 1,
        presets: {},
      };

      savePresetRegistry(testDir, registry);

      const filePath = join(testDir, '.specify/presets/.registry');
      expect(existsSync(filePath)).toBe(true);
    });

    test('round-trips correctly', () => {
      const registry = {
        version: 1,
        presets: {
          'company-preset': {
            manifest: {
              id: 'company-preset',
              name: 'Company Preset',
              version: '1.0.0',
              priority: 5,
            },
            installedAt: '2026-03-25T12:00:00Z',
            source: '/path/to/preset',
          },
        },
      };

      savePresetRegistry(testDir, registry);
      const loaded = loadPresetRegistry(testDir);

      expect(loaded).toEqual(registry);
    });
  });
});

// ============================================================================
// Project Detection Tests
// ============================================================================

describe('Project Detection', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `speckit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('isSpeckitProject', () => {
    test('returns false for non-project', () => {
      expect(isSpeckitProject(testDir)).toBe(false);
    });

    test('returns true when .specify exists', () => {
      mkdirSync(join(testDir, SPECKIT_DIR));
      expect(isSpeckitProject(testDir)).toBe(true);
    });

    test('returns false for non-existent directory', () => {
      expect(isSpeckitProject('/nonexistent/path')).toBe(false);
    });
  });

  describe('findProjectRoot', () => {
    test('returns null when not in project', () => {
      expect(findProjectRoot(testDir)).toBe(null);
    });

    test('finds project in current dir', () => {
      mkdirSync(join(testDir, SPECKIT_DIR));
      expect(findProjectRoot(testDir)).toBe(testDir);
    });

    test('finds project in parent dir', () => {
      mkdirSync(join(testDir, SPECKIT_DIR));
      const subdir = join(testDir, 'src', 'components');
      mkdirSync(subdir, { recursive: true });

      expect(findProjectRoot(subdir)).toBe(testDir);
    });

    test('finds project multiple levels up', () => {
      mkdirSync(join(testDir, SPECKIT_DIR));
      const deepDir = join(testDir, 'src', 'lib', 'utils', 'helpers');
      mkdirSync(deepDir, { recursive: true });

      expect(findProjectRoot(deepDir)).toBe(testDir);
    });

    test('returns nearest project root when nested', () => {
      // Create outer project
      mkdirSync(join(testDir, SPECKIT_DIR));

      // Create nested project
      const nestedProject = join(testDir, 'packages', 'inner');
      mkdirSync(join(nestedProject, SPECKIT_DIR), { recursive: true });

      // Should find the nearest (inner) project
      expect(findProjectRoot(nestedProject)).toBe(nestedProject);
    });
  });
});

// ============================================================================
// Path Constants Tests
// ============================================================================

describe('Path Constants', () => {
  test('SPECKIT_DIR is .specify', () => {
    expect(SPECKIT_DIR).toBe('.specify');
  });

  test('INIT_OPTIONS_PATH is correct', () => {
    expect(INIT_OPTIONS_PATH).toBe('.specify/init-options.json');
  });

  test('EXTENSION_REGISTRY_PATH is correct', () => {
    expect(EXTENSION_REGISTRY_PATH).toBe('.specify/extensions/.registry');
  });

  test('PRESET_REGISTRY_PATH is correct', () => {
    expect(PRESET_REGISTRY_PATH).toBe('.specify/presets/.registry');
  });
});
