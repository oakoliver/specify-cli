/**
 * @oakoliver/specify-cli - Core Types
 *
 * This module defines all TypeScript types and configurations for the spec-kit CLI.
 * It includes agent configurations, init options, extension/preset manifests, and utilities.
 *
 * @module types
 */

// ============================================================================
// Agent Configuration Types
// ============================================================================

/**
 * Command format supported by an AI agent.
 * - markdown: Standard markdown files with YAML frontmatter
 * - toml: TOML configuration files (Gemini, Tabnine)
 */
export type CommandFormat = 'markdown' | 'toml';

/**
 * Configuration for a single AI coding agent.
 * Defines where commands are stored and how they're formatted.
 */
export interface AgentConfig {
  /** Directory path relative to project root (e.g., ".claude/commands") */
  dir: string;
  /** Command file format */
  format: CommandFormat;
  /** Arguments placeholder used in templates (e.g., "$ARGUMENTS" or "{{args}}") */
  args: string;
  /** File extension including dot (e.g., ".md", ".agent.md", "/SKILL.md") */
  extension: string;
}

/**
 * Complete registry of all supported AI coding agents.
 * Each agent has its own folder structure and command format.
 */
export const AGENT_CONFIGS: Record<string, AgentConfig> = {
  claude: {
    dir: '.claude/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  gemini: {
    dir: '.gemini/commands',
    format: 'toml',
    args: '{{args}}',
    extension: '.toml',
  },
  copilot: {
    dir: '.github/agents',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.agent.md',
  },
  cursor: {
    dir: '.cursor/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  qwen: {
    dir: '.qwen/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  opencode: {
    dir: '.opencode/command',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  codex: {
    dir: '.agents/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  },
  windsurf: {
    dir: '.windsurf/workflows',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  junie: {
    dir: '.junie/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  kilocode: {
    dir: '.kilocode/workflows',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  auggie: {
    dir: '.augment/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  roo: {
    dir: '.roo/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  codebuddy: {
    dir: '.codebuddy/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  qodercli: {
    dir: '.qoder/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  'kiro-cli': {
    dir: '.kiro/prompts',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  pi: {
    dir: '.pi/prompts',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  amp: {
    dir: '.agents/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  shai: {
    dir: '.shai/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  tabnine: {
    dir: '.tabnine/agent/commands',
    format: 'toml',
    args: '{{args}}',
    extension: '.toml',
  },
  bob: {
    dir: '.bob/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  kimi: {
    dir: '.kimi/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  },
  trae: {
    dir: '.trae/rules',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  iflow: {
    dir: '.iflow/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
} as const;

/** List of all supported agent names */
export const SUPPORTED_AGENTS = Object.keys(AGENT_CONFIGS) as AgentName[];

/** Type for valid agent names */
export type AgentName = keyof typeof AGENT_CONFIGS;

// ============================================================================
// Init Options Types
// ============================================================================

/** Shell script type for generated scripts */
export type ScriptType = 'sh' | 'ps';

/** Branch numbering mode for feature branches */
export type BranchNumbering = 'sequential' | 'timestamp';

/**
 * Options saved during project initialization.
 * Stored in .specify/init-options.json
 * 
 * Note: JSON keys use snake_case to match Python spec-kit format.
 */
export interface InitOptions {
  /** Selected AI agent (e.g., "copilot", "claude") */
  ai: string;
  /** Shell script type */
  script: ScriptType;
  /** Branch numbering mode */
  branch_numbering: BranchNumbering;
  /** Whether to generate SKILL.md files for skill-based agents */
  ai_skills: boolean;
  /** Custom commands directory (for generic agent support) */
  ai_commands_dir?: string | null;
  /** Whether initialized in current directory */
  here?: boolean;
  /** Whether offline mode was used */
  offline?: boolean;
  /** Active preset */
  preset?: string | null;
  /** spec-kit version used for initialization */
  speckit_version?: string;
}

/** Default init options */
export const DEFAULT_INIT_OPTIONS: InitOptions = {
  ai: 'copilot',
  script: 'sh',
  branch_numbering: 'sequential',
  ai_skills: false,
  ai_commands_dir: null,
  here: false,
  offline: false,
  preset: null,
};

// ============================================================================
// Extension Types
// ============================================================================

/**
 * Command definition within an extension or preset.
 */
export interface CommandDefinition {
  /** Command name without prefix (e.g., "analyze") */
  name: string;
  /** Command description for help text */
  description: string;
  /** Command content/body */
  content: string;
  /** Optional handoffs to other commands */
  handoffs?: string[];
}

/**
 * Template override within an extension or preset.
 */
export interface TemplateOverride {
  /** Template name (e.g., "spec-template.md") */
  name: string;
  /** Template content */
  content: string;
}

/**
 * Hook definition for extension lifecycle events.
 */
export interface HookDefinition {
  /** Hook event (e.g., "post-init", "pre-command") */
  event: string;
  /** Script to execute */
  script: string;
}

/**
 * Extension manifest (manifest.json).
 * Defines an extension's metadata and contents.
 */
export interface ExtensionManifest {
  /** Unique extension identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version */
  version: string;
  /** Extension description */
  description?: string;
  /** Minimum spec-kit version required */
  specKitVersion?: string;
  /** Commands provided by this extension */
  commands?: CommandDefinition[];
  /** Template overrides */
  templates?: TemplateOverride[];
  /** Lifecycle hooks */
  hooks?: HookDefinition[];
  /** Whether extension is enabled */
  enabled?: boolean;
  /** Priority for conflict resolution (higher wins) */
  priority?: number;
}

/**
 * Registry entry for an installed extension.
 */
export interface ExtensionRegistryEntry {
  /** Extension manifest */
  manifest: ExtensionManifest;
  /** Installation timestamp */
  installedAt: string;
  /** Source (local path, URL, or catalog) */
  source: string;
  /** Registered command paths by agent */
  registeredCommands: Record<string, string[]>;
}

// ============================================================================
// Preset Types
// ============================================================================

/**
 * Preset manifest (manifest.json).
 * Defines a preset's metadata and template overrides.
 */
export interface PresetManifest {
  /** Unique preset identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version */
  version: string;
  /** Preset description */
  description?: string;
  /** Template overrides */
  templates?: TemplateOverride[];
  /** Command overrides */
  commands?: CommandDefinition[];
  /** Whether preset is enabled */
  enabled?: boolean;
  /** Priority for conflict resolution (higher wins) */
  priority?: number;
}

/**
 * Registry entry for an installed preset.
 */
export interface PresetRegistryEntry {
  /** Preset manifest */
  manifest: PresetManifest;
  /** Installation timestamp */
  installedAt: string;
  /** Source (local path, URL, or catalog) */
  source: string;
}

// ============================================================================
// Project Types
// ============================================================================

/**
 * Represents a spec-kit project.
 */
export interface Project {
  /** Absolute path to project root */
  root: string;
  /** Init options (loaded from init-options.json) */
  options: InitOptions;
  /** Installed extensions */
  extensions: ExtensionRegistryEntry[];
  /** Installed presets */
  presets: PresetRegistryEntry[];
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if an agent name is supported.
 */
export function isAgentSupported(agent: string): agent is AgentName {
  return agent in AGENT_CONFIGS;
}

/**
 * Get the commands directory for an agent.
 * @param projectRoot - Project root directory
 * @param agent - Agent name
 * @returns Absolute path to commands directory
 */
export function getAgentCommandsDir(projectRoot: string, agent: string): string {
  const config = AGENT_CONFIGS[agent];
  if (!config) {
    throw new Error(`Unknown agent: ${agent}`);
  }
  return `${projectRoot}/${config.dir}`;
}

/**
 * Get the full file path for a command.
 * @param projectRoot - Project root directory
 * @param agent - Agent name
 * @param commandName - Command name (e.g., "speckit.specify")
 * @returns Absolute path to command file
 */
export function getCommandFilePath(
  projectRoot: string,
  agent: string,
  commandName: string
): string {
  const config = AGENT_CONFIGS[agent];
  if (!config) {
    throw new Error(`Unknown agent: ${agent}`);
  }

  const dir = `${projectRoot}/${config.dir}`;

  // Skill-based agents use directory structure
  if (config.extension === '/SKILL.md') {
    return `${dir}/${commandName}/SKILL.md`;
  }

  return `${dir}/${commandName}${config.extension}`;
}

/**
 * Check if an agent uses skill-based commands (directory per command).
 */
export function isSkillBasedAgent(agent: string): boolean {
  const config = AGENT_CONFIGS[agent];
  return config?.extension === '/SKILL.md';
}

/**
 * Check if an agent uses TOML format.
 */
export function isTomlAgent(agent: string): boolean {
  const config = AGENT_CONFIGS[agent];
  return config?.format === 'toml';
}

/**
 * Get the arguments placeholder for an agent.
 */
export function getAgentArgsPlaceholder(agent: string): string {
  const config = AGENT_CONFIGS[agent];
  return config?.args ?? '$ARGUMENTS';
}
