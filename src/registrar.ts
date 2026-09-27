/**
 * @oakoliver/specify-cli - Command Registrar (legacy compatibility layer)
 *
 * Thin wrappers over the upstream-parity {@link CommandRegistrar}
 * (`src/agents.ts`) and the integration base renderers
 * (`src/integrations/base.ts`). New code should use `CommandRegistrar`
 * directly; these helpers keep the pre-1.0 public API compiling.
 *
 * @module registrar
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { CommandRegistrar } from './agents.js';
import { TomlIntegration, YamlIntegration } from './integrations/base.js';
import { AGENT_CONFIGS, getCommandFilePath, type CommandDefinition } from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Record of registered command file paths by agent.
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
  /** Document body after frontmatter (stripped, as upstream) */
  body: string;
}

// ============================================================================
// Frontmatter
// ============================================================================

/**
 * Parse YAML frontmatter from markdown content
 * (``CommandRegistrar.parse_frontmatter``: full YAML, line-anchored ``---``).
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const [frontmatter, body] = CommandRegistrar.parseFrontmatter(content);
  return { frontmatter, body };
}

/**
 * Render frontmatter and body back to markdown. Empty frontmatter returns the
 * body unchanged; otherwise ``---\n<yaml>---\n\n<body>``.
 */
export function renderFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(frontmatter)) {
    if (v !== null && v !== undefined) cleaned[k] = v;
  }
  if (Object.keys(cleaned).length === 0) return body;
  return `${CommandRegistrar.renderFrontmatter(cleaned)}\n${body}`;
}

// ============================================================================
// Format generation
// ============================================================================

/** Convert a command to TOML format (``TomlIntegration._render_toml``). */
export function toToml(description: string, prompt: string): string {
  return TomlIntegration.renderToml(description, prompt);
}

/** Convert a command to a Goose YAML recipe (``YamlIntegration._render_yaml``). */
export function toYamlRecipe(commandName: string, description: string, prompt: string): string {
  return YamlIntegration.renderYaml(YamlIntegration.humanTitle(commandName), description, prompt, commandName);
}

// ============================================================================
// Command registration
// ============================================================================

/** Write in-memory command definitions to a temp source dir as ``<name>.md``. */
function materializeCommands(commands: CommandDefinition[]): { dir: string; infos: Array<{ name: string; file: string }> } {
  const dir = mkdtempSync(join(tmpdir(), 'speckit-cmds-'));
  const infos: Array<{ name: string; file: string }> = [];
  for (const command of commands) {
    const fm: Record<string, unknown> = { description: command.description };
    if (command.handoffs !== undefined) fm.handoffs = command.handoffs;
    const file = `${command.name}.md`;
    writeFileSync(join(dir, file), renderFrontmatter(fm, command.content), 'utf-8');
    infos.push({ name: command.name, file });
  }
  return { dir, infos };
}

/**
 * Register in-memory command definitions for a specific agent via
 * {@link CommandRegistrar.registerCommands}. Returns the written file paths.
 */
export async function registerCommands(
  agent: string,
  commands: CommandDefinition[],
  projectRoot: string,
  sourceId: string
): Promise<RegisteredCommands> {
  if (!Object.prototype.hasOwnProperty.call(AGENT_CONFIGS, agent)) {
    throw new Error(`Unknown agent: ${agent}`);
  }
  const { dir, infos } = materializeCommands(commands);
  try {
    const registrar = new CommandRegistrar();
    const names = registrar.registerCommands(agent, infos, sourceId, dir, projectRoot);
    const paths: string[] = [];
    for (const name of names) {
      paths.push(getCommandFilePath(projectRoot, agent, name));
      if (agent === 'copilot') paths.push(join(projectRoot, '.github', 'prompts', `${name}.prompt.md`));
    }
    return { [agent]: paths };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Register commands for all agents (or only *targetAgent*).
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
    Object.assign(result, await registerCommands(agent, commands, projectRoot, sourceId));
  }
  return result;
}

// ============================================================================
// Command unregistration
// ============================================================================

function removeEmptyDirs(dir: string, projectRoot: string): void {
  try {
    let current = dir;
    while (current !== projectRoot && current.startsWith(projectRoot)) {
      if (readdirSync(current).length !== 0) break;
      rmdirSync(current);
      current = dirname(current);
    }
  } catch {
    // ignore
  }
}

/**
 * Unregister previously registered command files (paths as returned by
 * {@link registerCommands}); empty parent directories are pruned.
 */
export async function unregisterCommands(
  registered: RegisteredCommands,
  projectRoot: string
): Promise<void> {
  for (const paths of Object.values(registered)) {
    for (const filePath of paths) {
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch {
        // already gone
      }
      removeEmptyDirs(dirname(filePath), projectRoot);
    }
  }
}

/** Ensure a directory exists (kept for backward compatibility). */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
