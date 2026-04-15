/**
 * @oakoliver/specify-cli - Command Registrar
 *
 * This module handles registering, unregistering, and formatting commands
 * for different AI coding agents. Each agent has unique folder structures,
 * file formats (Markdown/TOML/SKILL.md), and naming conventions.
 *
 * @module registrar
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_CONFIGS, type CommandDefinition } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Record of registered commands by agent.
 * Used for tracking what was registered so it can be unregistered later.
 */
export interface RegisteredCommands {
  [agentName: string]: string[];
}

/**
 * Parsed frontmatter result.
 */
export interface ParsedFrontmatter {
  /** Parsed YAML frontmatter as key-value pairs */
  frontmatter: Record<string, unknown>;
  /** Document body after frontmatter */
  body: string;
}

// ============================================================================
// YAML Frontmatter Parsing (Zero Dependencies)
// ============================================================================

/**
 * Parse a YAML value from a string.
 * Handles strings (quoted and unquoted), booleans, numbers, and null.
 */
function parseYamlValue(value: string): unknown {
  const trimmed = value.trim();

  // Empty value
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') {
    return null;
  }

  // Boolean
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Quoted string (single or double)
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return parseFloat(trimmed);
  }

  // Unquoted string
  return trimmed;
}

/**
 * Parse simple YAML content (key-value pairs and arrays).
 * This is a minimal parser that handles the subset of YAML used in command frontmatter.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;
  let currentIndent = 0;

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // Array item (starts with -)
    if (trimmed.startsWith('- ') && currentArray !== null) {
      const itemContent = trimmed.slice(2).trim();

      // Check if it's an object in the array (has a colon)
      if (itemContent.includes(':')) {
        const colonIndex = itemContent.indexOf(':');
        const key = itemContent.slice(0, colonIndex).trim();
        const value = itemContent.slice(colonIndex + 1).trim();
        currentArray.push({ [key]: parseYamlValue(value) });
      } else {
        currentArray.push(parseYamlValue(itemContent));
      }
      continue;
    }

    // Key-value pair
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();

      if (value === '') {
        // Start of array or nested object - treat as array for simplicity
        currentKey = key;
        currentArray = [];
        currentIndent = indent;
        result[key] = currentArray;
      } else {
        result[key] = parseYamlValue(value);
        currentArray = null;
        currentKey = null;
      }
    }
  }

  return result;
}

/**
 * Parse YAML frontmatter from markdown content.
 *
 * @param content - Markdown content with optional frontmatter
 * @returns Parsed frontmatter and body
 *
 * @example
 * ```typescript
 * const { frontmatter, body } = parseFrontmatter(`---
 * description: My command
 * ---
 * Command body here`);
 * // frontmatter = { description: "My command" }
 * // body = "Command body here"
 * ```
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  // No frontmatter
  if (!content.startsWith('---')) {
    return { frontmatter: {}, body: content };
  }

  // Find end of frontmatter
  const endIndex = content.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  // Extract YAML block
  const yamlBlock = content.slice(4, endIndex);
  let frontmatter: Record<string, unknown>;

  try {
    frontmatter = parseSimpleYaml(yamlBlock);
  } catch {
    // Invalid YAML - return empty frontmatter
    frontmatter = {};
  }

  // Ensure frontmatter is an object (not array or primitive)
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    frontmatter = {};
  }

  // Extract body (skip the closing ---)
  const body = content.slice(endIndex + 4).trim();

  return { frontmatter, body };
}

/**
 * Render frontmatter and body back to markdown.
 *
 * @param frontmatter - Key-value pairs to render as YAML
 * @param body - Document body
 * @returns Complete markdown string with frontmatter
 */
export function renderFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  if (Object.keys(frontmatter).length === 0) {
    return body;
  }

  const yamlLines: string[] = [];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'string') {
      // Check if string needs quoting
      if (value.includes('\n') || value.includes(':') || value.includes('#') ||
          value.startsWith(' ') || value.endsWith(' ')) {
        yamlLines.push(`${key}: "${value.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
      } else {
        yamlLines.push(`${key}: ${value}`);
      }
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      yamlLines.push(`${key}: ${value}`);
    } else if (Array.isArray(value)) {
      yamlLines.push(`${key}:`);
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          // Object in array
          const entries = Object.entries(item);
          if (entries.length > 0) {
            const [k, v] = entries[0];
            yamlLines.push(`  - ${k}: ${v}`);
          }
        } else {
          yamlLines.push(`  - ${item}`);
        }
      }
    }
  }

  const yaml = yamlLines.join('\n');
  return `---\n${yaml}\n---\n\n${body}`;
}

// ============================================================================
// TOML Generation (Zero Dependencies)
// ============================================================================

/**
 * Escape a string for TOML basic string format.
 */
function escapeTomlString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Convert a command to TOML format for Gemini/Tabnine.
 *
 * @param description - Command description
 * @param prompt - Command prompt/body
 * @returns Valid TOML string
 */
export function toToml(description: string, prompt: string): string {
  const escapedDesc = escapeTomlString(description);

  // Use multiline literal string for prompt to preserve formatting
  return `description = "${escapedDesc}"

prompt = """
${prompt}
"""`;
}

// ============================================================================
// YAML Recipe Generation (Goose Format)
// ============================================================================

/**
 * Convert a command to YAML recipe format for Goose.
 *
 * @param commandName - Command name (e.g., "speckit.specify")
 * @param description - Command description
 * @param prompt - Command prompt/body
 * @returns Valid YAML recipe string
 */
export function toYamlRecipe(commandName: string, description: string, prompt: string): string {
  // Escape special characters for YAML
  const escapedDesc = description.replace(/"/g, '\\"');
  
  // Format command name as title (e.g., "speckit.specify" -> "Spec Kit Specify")
  const title = commandName
    .replace(/^speckit\./, '')   // Remove speckit. prefix
    .split(/[.\s-]+/)
    .filter(w => w.length > 0)   // Remove empty strings
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  
  const fullTitle = commandName.startsWith('speckit.') ? `Spec Kit ${title}` : title;

  return `version: 1.0.0
title: "${fullTitle}"
description: "${escapedDesc}"
author:
  contact: spec-kit
extensions:
  - type: builtin
    name: developer
activities:
  - Spec-Driven Development
prompt: |
${prompt.split('\n').map(line => '  ' + line).join('\n')}
`;
}

// ============================================================================
// Command Registration
// ============================================================================

/**
 * Ensure a directory exists, creating it if necessary.
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Register a markdown command for standard agents (Claude, Cursor, OpenCode, etc.).
 */
async function registerMarkdownCommand(
  projectRoot: string,
  agent: string,
  commandName: string,
  content: string
): Promise<string> {
  const config = AGENT_CONFIGS[agent];
  if (!config) {
    throw new Error(`Unknown agent: ${agent}`);
  }

  const dir = join(projectRoot, config.dir);
  ensureDir(dir);

  const filePath = join(dir, `${commandName}${config.extension}`);
  writeFileSync(filePath, content, 'utf-8');

  return filePath;
}

/**
 * Register a command for Copilot with companion .prompt.md file.
 */
async function registerCopilotCommand(
  projectRoot: string,
  commandName: string,
  content: string
): Promise<string[]> {
  const config = AGENT_CONFIGS['copilot'];
  const agentDir = join(projectRoot, config.dir);
  const promptDir = join(projectRoot, '.github/prompts');

  ensureDir(agentDir);
  ensureDir(promptDir);

  // Write agent file
  const agentPath = join(agentDir, `${commandName}${config.extension}`);
  writeFileSync(agentPath, content, 'utf-8');

  // Write companion prompt file
  const promptPath = join(promptDir, `${commandName}.prompt.md`);
  const promptContent = `---
mode: agent
agent: ${commandName}
---

See @${commandName}.agent.md for full instructions.
`;
  writeFileSync(promptPath, promptContent, 'utf-8');

  return [agentPath, promptPath];
}

/**
 * Register a TOML command for Gemini/Tabnine.
 */
async function registerTomlCommand(
  projectRoot: string,
  agent: string,
  commandName: string,
  content: string
): Promise<string> {
  const config = AGENT_CONFIGS[agent];
  if (!config) {
    throw new Error(`Unknown agent: ${agent}`);
  }

  const dir = join(projectRoot, config.dir);
  ensureDir(dir);

  // Parse frontmatter to extract description
  const { frontmatter, body } = parseFrontmatter(content);
  const description = (frontmatter.description as string) || '';

  // Convert to TOML
  const tomlContent = toToml(description, body);

  const filePath = join(dir, `${commandName}${config.extension}`);
  writeFileSync(filePath, tomlContent, 'utf-8');

  return filePath;
}

/**
 * Register a YAML recipe command for Goose.
 */
async function registerYamlCommand(
  projectRoot: string,
  agent: string,
  commandName: string,
  content: string
): Promise<string> {
  const config = AGENT_CONFIGS[agent];
  if (!config) {
    throw new Error(`Unknown agent: ${agent}`);
  }

  const dir = join(projectRoot, config.dir);
  ensureDir(dir);

  // Parse frontmatter to extract description
  const { frontmatter, body } = parseFrontmatter(content);
  const description = (frontmatter.description as string) || '';

  // Convert to YAML recipe format
  const yamlContent = toYamlRecipe(commandName, description, body);

  const filePath = join(dir, `${commandName}${config.extension}`);
  writeFileSync(filePath, yamlContent, 'utf-8');

  return filePath;
}

/**
 * Register a skill-based command for Codex/Kimi.
 */
async function registerSkillCommand(
  projectRoot: string,
  agent: string,
  commandName: string,
  content: string
): Promise<string> {
  const config = AGENT_CONFIGS[agent];
  if (!config) {
    throw new Error(`Unknown agent: ${agent}`);
  }

  // Skill-based agents use directory per command
  const skillDir = join(projectRoot, config.dir, commandName);
  ensureDir(skillDir);

  // Parse original frontmatter
  const { frontmatter, body } = parseFrontmatter(content);

  // Create SKILL.md with agentskills.io format
  const skillFrontmatter = {
    name: commandName,
    description: (frontmatter.description as string) || '',
  };

  const skillContent = renderFrontmatter(skillFrontmatter, body);
  const filePath = join(skillDir, 'SKILL.md');
  writeFileSync(filePath, skillContent, 'utf-8');

  return filePath;
}

/**
 * Register commands for a specific agent.
 *
 * @param agent - Agent name (e.g., "copilot", "claude", "gemini")
 * @param commands - Array of command definitions to register
 * @param projectRoot - Absolute path to project root
 * @param sourceId - Source identifier ("core", extension ID, or preset ID)
 * @returns Record of registered command paths by agent
 *
 * @example
 * ```typescript
 * const registered = await registerCommands('claude', [
 *   { name: 'speckit.specify', description: 'Create spec', content: '...' }
 * ], '/my/project', 'core');
 * // registered = { claude: ['/my/project/.claude/commands/speckit.specify.md'] }
 * ```
 */
export async function registerCommands(
  agent: string,
  commands: CommandDefinition[],
  projectRoot: string,
  _sourceId: string
): Promise<RegisteredCommands> {
  const config = AGENT_CONFIGS[agent];
  if (!config) {
    throw new Error(`Unknown agent: ${agent}`);
  }

  const registeredPaths: string[] = [];

  for (const command of commands) {
    const commandName = command.name;
    const content = renderFrontmatter(
      { description: command.description, handoffs: command.handoffs },
      command.content
    );

    let paths: string[];

    // Route to correct handler based on agent type
    if (agent === 'copilot') {
      paths = await registerCopilotCommand(projectRoot, commandName, content);
    } else if (config.format === 'toml') {
      const path = await registerTomlCommand(projectRoot, agent, commandName, content);
      paths = [path];
    } else if (config.format === 'yaml') {
      const path = await registerYamlCommand(projectRoot, agent, commandName, content);
      paths = [path];
    } else if (config.extension === '/SKILL.md') {
      const path = await registerSkillCommand(projectRoot, agent, commandName, content);
      paths = [path];
    } else {
      const path = await registerMarkdownCommand(projectRoot, agent, commandName, content);
      paths = [path];
    }

    registeredPaths.push(...paths);
  }

  return { [agent]: registeredPaths };
}

/**
 * Register commands for all configured agents in a project.
 *
 * @param commands - Array of command definitions
 * @param projectRoot - Absolute path to project root
 * @param sourceId - Source identifier
 * @param targetAgent - If specified, only register for this agent
 * @returns Record of registered command paths by agent
 */
export async function registerCommandsForAllAgents(
  commands: CommandDefinition[],
  projectRoot: string,
  sourceId: string,
  targetAgent?: string
): Promise<RegisteredCommands> {
  const result: RegisteredCommands = {};

  const agents = targetAgent ? [targetAgent] : Object.keys(AGENT_CONFIGS);

  for (const agent of agents) {
    const registered = await registerCommands(agent, commands, projectRoot, sourceId);
    Object.assign(result, registered);
  }

  return result;
}

// ============================================================================
// Command Unregistration
// ============================================================================

/**
 * Safely delete a file, ignoring if it doesn't exist.
 */
function safeUnlink(filePath: string): void {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Ignore errors (file may have been deleted already)
  }
}

/**
 * Remove empty directory and its parents up to project root.
 */
function removeEmptyDirs(dir: string, projectRoot: string): void {
  try {
    let current = dir;
    while (current !== projectRoot && current.startsWith(projectRoot)) {
      const entries = readdirSync(current);
      if (entries.length === 0) {
        rmdirSync(current);
        current = dirname(current);
      } else {
        break;
      }
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Unregister previously registered commands.
 *
 * @param registered - Record of registered command paths by agent
 * @param projectRoot - Absolute path to project root
 *
 * @example
 * ```typescript
 * await unregisterCommands({
 *   claude: ['/my/project/.claude/commands/speckit.specify.md']
 * }, '/my/project');
 * ```
 */
export async function unregisterCommands(
  registered: RegisteredCommands,
  projectRoot: string
): Promise<void> {
  for (const [_agent, paths] of Object.entries(registered)) {
    for (const filePath of paths) {
      safeUnlink(filePath);

      // Clean up empty directories (important for skill-based agents)
      const dir = dirname(filePath);
      removeEmptyDirs(dir, projectRoot);
    }
  }
}
