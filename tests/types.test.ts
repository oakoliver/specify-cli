/**
 * Tests for core types (legacy compatibility layer over the integration
 * registry) and configuration.
 *
 * Ports tests/test_agent_config_consistency.py (upstream v1.0.12): the agent
 * table now derives from the integration registry, so retired agents (roo,
 * windsurf, iflow, cursor, jules, kiro alias) are gone and skills-first agents
 * (claude, codex, kimi, qodercli, trae, cursor-agent, ...) use `/SKILL.md`.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  AGENT_CONFIGS,
  SUPPORTED_AGENTS,
  DEFAULT_INIT_OPTIONS,
  type InitOptions,
  isAgentSupported,
  getAgentCommandsDir,
  getCommandFilePath,
  isSkillBasedAgent,
  isTomlAgent,
  isYamlAgent,
  getAgentArgsPlaceholder,
} from '../src/types.js';
import {
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
} from '../src/config.js';
import { CommandRegistrar } from '../src/agents.js';
import { INTEGRATION_REGISTRY } from '../src/integrations/index.js';

// ============================================================================
// Agent Configuration Tests (test_agent_config_consistency.py)
// ============================================================================

const EXPECTED: Record<string, [string, string, string, string]> = {
  // key: [dir, format, args, extension]
  agy: ['.agents/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  alquimia: ['.alquimia/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  amp: ['.agents/commands', 'markdown', '$ARGUMENTS', '.md'],
  auggie: ['.augment/commands', 'markdown', '$ARGUMENTS', '.md'],
  bob: ['.bob/commands', 'markdown', '$ARGUMENTS', '.md'],
  claude: ['.claude/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  cline: ['.clinerules/workflows', 'markdown', '$ARGUMENTS', '.md'],
  codebuddy: ['.codebuddy/commands', 'markdown', '$ARGUMENTS', '.md'],
  codex: ['.agents/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  'command-code': ['.commandcode/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  copilot: ['.github/agents', 'markdown', '$ARGUMENTS', '.agent.md'],
  'cursor-agent': ['.cursor/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  devin: ['.devin/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  'docker-agent': ['.agents/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  droid: ['.factory/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  dsh: ['.dsh/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  firebender: ['.firebender/commands', 'markdown', '$ARGUMENTS', '.mdc'],
  forge: ['.forge/commands', 'markdown', '{{parameters}}', '.md'],
  gemini: ['.gemini/commands', 'toml', '{{args}}', '.toml'],
  goose: ['.goose/recipes', 'yaml', '{{args}}', '.yaml'],
  grok: ['.grok/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  hermes: ['~/.hermes/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  junie: ['.junie/commands', 'markdown', '$ARGUMENTS', '.md'],
  kilocode: ['.kilo/commands', 'markdown', '$ARGUMENTS', '.md'],
  kimi: ['.kimi-code/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  'kiro-cli': ['.kiro/prompts', 'markdown', '(the user will provide the argument in this conversation)', '.md'],
  lingma: ['.lingma/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  muse: ['.agents/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  omp: ['.omp/commands', 'markdown', '$ARGUMENTS', '.md'],
  opencode: ['.opencode/commands', 'markdown', '$ARGUMENTS', '.md'],
  pi: ['.pi/prompts', 'markdown', '$ARGUMENTS', '.md'],
  qodercli: ['.qoder/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  qwen: ['.qwen/commands', 'markdown', '$ARGUMENTS', '.md'],
  rovodev: ['.rovodev/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  shai: ['.shai/commands', 'markdown', '$ARGUMENTS', '.md'],
  tabnine: ['.tabnine/agent/commands', 'toml', '{{args}}', '.toml'],
  trae: ['.trae/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  vibe: ['.vibe/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  zcode: ['.zcode/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
  zed: ['.agents/skills', 'markdown', '$ARGUMENTS', '/SKILL.md'],
};

describe('AGENT_CONFIGS', () => {
  test('contains all 40 registrar agents (generic excluded)', () => {
    expect(SUPPORTED_AGENTS.length).toBe(40);
    expect([...SUPPORTED_AGENTS].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(SUPPORTED_AGENTS).toEqual(Object.keys(CommandRegistrar.AGENT_CONFIGS));
  });

  for (const [agent, [dir, format, args, extension]] of Object.entries(EXPECTED)) {
    test(`${agent} config`, () => {
      const cfg = AGENT_CONFIGS[agent];
      expect([cfg.dir, cfg.format, cfg.args, cfg.extension]).toEqual([dir, format, args, extension]);
    });
  }

  test('retired agents removed', () => {
    for (const agent of ['roo', 'windsurf', 'iflow', 'cursor', 'jules', 'kiro', 'q']) {
      expect(isAgentSupported(agent)).toBe(false);
    }
  });

  test('legacy dirs kept for migration', () => {
    expect(AGENT_CONFIGS.kilocode.legacy_dir).toBe('.kilocode/workflows');
    expect(AGENT_CONFIGS.opencode.legacy_dir).toBe('.opencode/command');
    expect(AGENT_CONFIGS.hermes.detect_dir).toBe('.hermes/skills');
  });

  test('skills agents have hyphen invoke separator', () => {
    for (const [agent, cfg] of Object.entries(AGENT_CONFIGS)) {
      if (cfg.extension === '/SKILL.md') expect({ agent, sep: cfg.invoke_separator }).toEqual({ agent, sep: '-' });
    }
    expect(AGENT_CONFIGS.gemini.invoke_separator).toBe('.');
    expect(AGENT_CONFIGS.forge.invoke_separator).toBe('-');
  });

  test('codex dev_no_symlink policy', () => {
    expect(AGENT_CONFIGS.codex.dev_no_symlink).toBe(true);
  });

  test('every registrar agent maps to a registered integration', () => {
    for (const agent of SUPPORTED_AGENTS) expect(agent in INTEGRATION_REGISTRY).toBe(true);
    expect('generic' in INTEGRATION_REGISTRY).toBe(true);
  });
});

describe('isAgentSupported', () => {
  test('known and unknown agents', () => {
    expect(isAgentSupported('claude')).toBe(true);
    expect(isAgentSupported('kiro-cli')).toBe(true);
    expect(isAgentSupported('generic')).toBe(false);
    expect(isAgentSupported('unknown-agent')).toBe(false);
    expect(isAgentSupported('constructor')).toBe(false);
  });
});

describe('getAgentCommandsDir / getCommandFilePath', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-types-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('project-relative dirs', () => {
    expect(getAgentCommandsDir(root, 'gemini')).toBe(join(root, '.gemini/commands'));
    expect(() => getAgentCommandsDir(root, 'unknown')).toThrow('Unknown agent: unknown');
  });

  test('home-relative dir for hermes', () => {
    const saved = process.env.HOME;
    process.env.HOME = root;
    try {
      expect(getAgentCommandsDir('/proj', 'hermes')).toBe(join(root, '.hermes/skills'));
    } finally {
      process.env.HOME = saved;
    }
  });

  test('file paths use registrar output names', () => {
    expect(getCommandFilePath(root, 'gemini', 'speckit.plan')).toBe(join(root, '.gemini/commands') + '/speckit.plan.toml');
    expect(getCommandFilePath(root, 'copilot', 'speckit.plan')).toBe(join(root, '.github/agents') + '/speckit.plan.agent.md');
    expect(getCommandFilePath(root, 'claude', 'speckit.git.commit')).toBe(
      join(root, '.claude/skills') + '/speckit-git-commit/SKILL.md',
    );
    expect(getCommandFilePath(root, 'forge', 'speckit.git.commit')).toBe(join(root, '.forge/commands') + '/speckit-git-commit.md');
  });
});

describe('format predicates', () => {
  test('skill / toml / yaml agents and args placeholders', () => {
    expect(isSkillBasedAgent('codex')).toBe(true);
    expect(isSkillBasedAgent('copilot')).toBe(false);
    expect(isTomlAgent('gemini')).toBe(true);
    expect(isTomlAgent('tabnine')).toBe(true);
    expect(isTomlAgent('claude')).toBe(false);
    expect(isYamlAgent('goose')).toBe(true);
    expect(getAgentArgsPlaceholder('forge')).toBe('{{parameters}}');
    expect(getAgentArgsPlaceholder('goose')).toBe('{{args}}');
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
