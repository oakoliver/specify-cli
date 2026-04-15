/**
 * @oakoliver/specify-cli - Integration Management
 *
 * Manages AI agent integrations post-initialization.
 * Allows adding, removing, and listing agent configurations.
 *
 * @module integration
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import {
  AGENT_CONFIGS,
  SUPPORTED_AGENTS,
  type AgentName,
  type InitOptions,
} from './types.js';
import { loadInitOptions, saveInitOptions } from './config.js';
import { registerCommands, parseFrontmatter, unregisterCommands, type RegisteredCommands } from './registrar.js';
import { getCommandTemplate, getAvailableCommands } from './templates.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Integration manifest - tracks installed files per integration.
 */
export interface IntegrationManifest {
  integration: string;
  version: string;
  installed_at: string;
  files: string[];
}

/**
 * Integration info for listing.
 */
export interface IntegrationInfo {
  key: string;
  name: string;
  directory: string;
  format: string;
  installed: boolean;
  files_count?: number;
}

// ============================================================================
// Manifest Management
// ============================================================================

/**
 * Get path to integration manifest file.
 */
function getManifestPath(projectRoot: string, integration: string): string {
  return join(projectRoot, '.specify', 'integrations', `${integration}.manifest.json`);
}

/**
 * Load integration manifest.
 */
export function loadManifest(projectRoot: string, integration: string): IntegrationManifest | null {
  const path = getManifestPath(projectRoot, integration);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Save integration manifest.
 */
function saveManifest(projectRoot: string, manifest: IntegrationManifest): void {
  const path = getManifestPath(projectRoot, manifest.integration);
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

/**
 * Remove integration manifest.
 */
function removeManifest(projectRoot: string, integration: string): void {
  const path = getManifestPath(projectRoot, integration);
  if (existsSync(path)) {
    rmSync(path);
  }
}

// ============================================================================
// Integration Operations
// ============================================================================

/**
 * List all integrations with their status.
 */
export function listIntegrations(projectRoot: string): IntegrationInfo[] {
  const integrations: IntegrationInfo[] = [];

  for (const key of SUPPORTED_AGENTS) {
    const config = AGENT_CONFIGS[key];
    const manifest = loadManifest(projectRoot, key);
    const installed = manifest !== null || existsSync(join(projectRoot, config.dir));

    integrations.push({
      key,
      name: key.charAt(0).toUpperCase() + key.slice(1),
      directory: config.dir,
      format: config.format,
      installed,
      files_count: manifest?.files.length,
    });
  }

  return integrations;
}

/**
 * Add an integration (install commands for an agent).
 */
export async function addIntegration(
  projectRoot: string,
  integration: string,
  version: string = '1.1.0'
): Promise<IntegrationManifest> {
  // Validate integration
  if (!SUPPORTED_AGENTS.includes(integration as AgentName)) {
    throw new Error(`Unknown integration: "${integration}". Supported: ${SUPPORTED_AGENTS.join(', ')}`);
  }

  // Check if already installed
  const existingManifest = loadManifest(projectRoot, integration);
  if (existingManifest) {
    throw new Error(`Integration "${integration}" is already installed. Use 'specify integration remove ${integration}' first.`);
  }

  // Get agent config
  const config = AGENT_CONFIGS[integration];
  const agentArgs = config.args;

  // Build command definitions
  const commandNames = getAvailableCommands();
  const commands = commandNames.map(name => {
    const content = getCommandTemplate(name, agentArgs);
    if (!content) return null;

    const { frontmatter, body } = parseFrontmatter(content);
    return {
      name,
      description: (frontmatter.description as string) || '',
      content: body,
      handoffs: frontmatter.handoffs as string[] | undefined,
    };
  }).filter((c): c is NonNullable<typeof c> => c !== null);

  // Register commands
  const registered = await registerCommands(integration, commands, projectRoot, 'core');

  // Create manifest
  const manifest: IntegrationManifest = {
    integration,
    version,
    installed_at: new Date().toISOString(),
    files: registered[integration] || [],
  };

  // Save manifest
  saveManifest(projectRoot, manifest);

  // Update init-options if it exists
  const initOptions = loadInitOptions(projectRoot);
  if (initOptions) {
    // Keep the primary agent, just track that this integration was added
    saveInitOptions(projectRoot, initOptions);
  }

  return manifest;
}

/**
 * Remove empty parent directories up to a certain root.
 */
function removeEmptyParents(dir: string, stopAt: string): void {
  let current = dir;
  while (current !== stopAt && current.startsWith(stopAt)) {
    try {
      const entries = readdirSync(current);
      if (entries.length === 0) {
        rmdirSync(current);
        current = dirname(current);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/**
 * Remove an integration (uninstall commands for an agent).
 */
export async function removeIntegration(projectRoot: string, integration: string): Promise<boolean> {
  // Validate integration exists
  const manifest = loadManifest(projectRoot, integration);
  
  if (!manifest) {
    // Check if files exist anyway
    const config = AGENT_CONFIGS[integration];
    if (!config) {
      throw new Error(`Unknown integration: "${integration}"`);
    }

    const dir = join(projectRoot, config.dir);
    if (!existsSync(dir)) {
      throw new Error(`Integration "${integration}" is not installed.`);
    }

    // Remove the directory (no manifest to track files)
    rmSync(dir, { recursive: true });
    
    // Clean up empty parent directories (e.g., .cursor after removing .cursor/commands)
    removeEmptyParents(dirname(dir), projectRoot);
    return true;
  }

  // Unregister tracked files
  const registered: RegisteredCommands = { [integration]: manifest.files };
  await unregisterCommands(registered, projectRoot);

  // Clean up empty parent directories
  const config = AGENT_CONFIGS[integration];
  if (config) {
    const dir = join(projectRoot, config.dir);
    removeEmptyParents(dirname(dir), projectRoot);
  }

  // Remove manifest
  removeManifest(projectRoot, integration);

  return true;
}

/**
 * Get integration info.
 */
export function getIntegrationInfo(projectRoot: string, integration: string): IntegrationInfo | null {
  if (!SUPPORTED_AGENTS.includes(integration as AgentName)) {
    return null;
  }

  const config = AGENT_CONFIGS[integration];
  const manifest = loadManifest(projectRoot, integration);
  const installed = manifest !== null || existsSync(join(projectRoot, config.dir));

  return {
    key: integration,
    name: integration.charAt(0).toUpperCase() + integration.slice(1),
    directory: config.dir,
    format: config.format,
    installed,
    files_count: manifest?.files.length,
  };
}
