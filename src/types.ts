/**
 * @oakoliver/specify-cli - Core Types
 *
 * This module defines all TypeScript types and configurations for the spec-kit CLI.
 * It includes agent configurations, init options, extension/preset manifests, and utilities.
 *
 * @module types
 */

import { CommandRegistrar } from './agents.js';

// ============================================================================
// Agent Configuration Types
// ============================================================================

/**
 * Command format supported by an AI agent.
 * - markdown: Markdown files with YAML frontmatter (also SKILL.md skills)
 * - toml: TOML command files (Gemini, Tabnine)
 * - yaml: YAML recipe format (Goose)
 */
export type CommandFormat = 'markdown' | 'toml' | 'yaml';

/**
 * Registration config for a single AI coding agent — a read-only view of
 * ``CommandRegistrar.AGENT_CONFIGS`` (derived from the integration registry,
 * upstream spec-kit v1.0.12).
 */
export interface AgentConfig {
  /** Directory path relative to project root (e.g. ".claude/skills"), or ``~/``-relative */
  dir: string;
  /** Command file format */
  format: CommandFormat;
  /** Arguments placeholder (e.g. "$ARGUMENTS", "{{args}}", "{{parameters}}") */
  args: string;
  /** File extension including dot (".md", ".agent.md", ".toml", ".yaml") or "/SKILL.md" */
  extension: string;
  /** Command-reference separator (``.`` or ``-``) */
  invoke_separator?: string;
  /** Legacy directory still honoured when the canonical one is missing */
  legacy_dir?: string;
  /** Project-local marker directory used for detection (Hermes) */
  detect_dir?: string;
  /** Frontmatter keys stripped on registration (Forge: handoffs) */
  strip_frontmatter_keys?: string[];
  /** Inject a ``name`` frontmatter field (Forge/Junie/Cline) */
  inject_name?: boolean;
  /** Custom output-name formatter */
  format_name?: (cmdName: string) => string;
  /** Write files instead of dev-mode symlinks */
  dev_no_symlink?: boolean;
}

/**
 * Registry of all agents that accept extension/preset command registration,
 * derived from the upstream v1.0.12 integration registry (``generic`` is
 * excluded, exactly like ``CommandRegistrar.AGENT_CONFIGS``). Retired agents
 * (roo, windsurf, iflow, jules, cursor, kiro alias) are gone.
 */
export const AGENT_CONFIGS: Readonly<Record<string, AgentConfig>> = buildLegacyAgentConfigs();

function buildLegacyAgentConfigs(): Record<string, AgentConfig> {
  const out: Record<string, AgentConfig> = {};
  for (const [key, cfg] of Object.entries(CommandRegistrar.AGENT_CONFIGS)) {
    out[key] = { ...(cfg as AgentConfig) };
  }
  return out;
}

/** List of all supported agent names (registrar agents, upstream order) */
export const SUPPORTED_AGENTS: AgentName[] = Object.keys(AGENT_CONFIGS);

/** Type for valid agent names */
export type AgentName = string;

// ============================================================================
// Init Options Types
// ============================================================================

/** Script variant for generated scripts (``py`` added upstream in v1.x) */
export type ScriptType = 'sh' | 'ps' | 'py';

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
  return Object.prototype.hasOwnProperty.call(AGENT_CONFIGS, agent);
}

function agentConfigOf(agent: string): AgentConfig | undefined {
  return Object.prototype.hasOwnProperty.call(AGENT_CONFIGS, agent) ? AGENT_CONFIGS[agent] : undefined;
}

/**
 * Get the commands directory for an agent (``CommandRegistrar._resolve_agent_dir``:
 * ``~/``-relative and absolute dirs honoured, legacy dir fallback).
 * @param projectRoot - Project root directory
 * @param agent - Agent name
 * @returns Path to the commands directory
 */
export function getAgentCommandsDir(projectRoot: string, agent: string): string {
  const config = agentConfigOf(agent);
  if (!config) {
    throw new Error(`Unknown agent: ${agent}`);
  }
  return CommandRegistrar.resolveAgentDir(agent, config as never, projectRoot);
}

/**
 * Get the full file path for a registered command.
 * Skill-based agents use ``<dir>/speckit-<name>/SKILL.md``; other agents use
 * ``<dir>/<output-name><extension>`` (Forge/Junie/Cline hyphenate names).
 * @param projectRoot - Project root directory
 * @param agent - Agent name
 * @param commandName - Command name (e.g., "speckit.specify")
 */
export function getCommandFilePath(
  projectRoot: string,
  agent: string,
  commandName: string
): string {
  const config = agentConfigOf(agent);
  if (!config) {
    throw new Error(`Unknown agent: ${agent}`);
  }
  const dir = getAgentCommandsDir(projectRoot, agent);
  const outputName = CommandRegistrar.computeOutputName(agent, commandName, config as never);
  return `${dir}/${outputName}${config.extension}`;
}

/**
 * Check if an agent uses skill-based commands (directory per command).
 */
export function isSkillBasedAgent(agent: string): boolean {
  return agentConfigOf(agent)?.extension === '/SKILL.md';
}

/**
 * Check if an agent uses TOML format.
 */
export function isTomlAgent(agent: string): boolean {
  return agentConfigOf(agent)?.format === 'toml';
}

/**
 * Check if an agent uses YAML format.
 */
export function isYamlAgent(agent: string): boolean {
  return agentConfigOf(agent)?.format === 'yaml';
}

/**
 * Get the arguments placeholder for an agent.
 */
export function getAgentArgsPlaceholder(agent: string): string {
  return agentConfigOf(agent)?.args ?? '$ARGUMENTS';
}
