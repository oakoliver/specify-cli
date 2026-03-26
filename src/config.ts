/**
 * @oakoliver/specify-cli - Configuration
 *
 * This module handles loading and saving spec-kit configuration files,
 * including init-options.json and extension/preset registries.
 *
 * @module config
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  InitOptions,
  DEFAULT_INIT_OPTIONS,
  ExtensionRegistryEntry,
  PresetRegistryEntry,
} from './types.js';

// ============================================================================
// Path Constants
// ============================================================================

/** Spec-kit directory name */
export const SPECKIT_DIR = '.specify';

/** Init options file path relative to project root */
export const INIT_OPTIONS_PATH = `${SPECKIT_DIR}/init-options.json`;

/** Extension registry file path */
export const EXTENSION_REGISTRY_PATH = `${SPECKIT_DIR}/extensions/.registry`;

/** Preset registry file path */
export const PRESET_REGISTRY_PATH = `${SPECKIT_DIR}/presets/.registry`;

/** Templates directory */
export const TEMPLATES_DIR = `${SPECKIT_DIR}/templates`;

/** Scripts directory */
export const SCRIPTS_DIR = `${SPECKIT_DIR}/scripts`;

/** Memory directory (constitution, etc.) */
export const MEMORY_DIR = `${SPECKIT_DIR}/memory`;

// ============================================================================
// Init Options
// ============================================================================

/**
 * Load init options from a project.
 * Returns default options if file doesn't exist or is invalid.
 *
 * @param projectRoot - Absolute path to project root
 * @returns Loaded or default init options
 */
export function loadInitOptions(projectRoot: string): InitOptions {
  const filePath = join(projectRoot, INIT_OPTIONS_PATH);

  if (!existsSync(filePath)) {
    return { ...DEFAULT_INIT_OPTIONS };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Partial<InitOptions>;

    // Merge with defaults to ensure all fields exist
    return {
      ...DEFAULT_INIT_OPTIONS,
      ...parsed,
    };
  } catch (error) {
    // Return defaults on parse error
    return { ...DEFAULT_INIT_OPTIONS };
  }
}

/**
 * Save init options to a project.
 *
 * @param projectRoot - Absolute path to project root
 * @param options - Init options to save
 */
export function saveInitOptions(projectRoot: string, options: InitOptions): void {
  const filePath = join(projectRoot, INIT_OPTIONS_PATH);
  const dir = dirname(filePath);

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = JSON.stringify(options, null, 2) + '\n';
  writeFileSync(filePath, content, 'utf-8');
}

// ============================================================================
// Extension Registry
// ============================================================================

/**
 * Extension registry structure.
 */
export interface ExtensionRegistry {
  version: number;
  extensions: Record<string, ExtensionRegistryEntry>;
}

/**
 * Load extension registry from a project.
 * Returns empty registry if file doesn't exist or is invalid.
 *
 * @param projectRoot - Absolute path to project root
 * @returns Loaded or empty extension registry
 */
export function loadExtensionRegistry(projectRoot: string): ExtensionRegistry {
  const filePath = join(projectRoot, EXTENSION_REGISTRY_PATH);

  if (!existsSync(filePath)) {
    return { version: 1, extensions: {} };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as ExtensionRegistry;
    return parsed;
  } catch {
    return { version: 1, extensions: {} };
  }
}

/**
 * Save extension registry to a project.
 *
 * @param projectRoot - Absolute path to project root
 * @param registry - Extension registry to save
 */
export function saveExtensionRegistry(
  projectRoot: string,
  registry: ExtensionRegistry
): void {
  const filePath = join(projectRoot, EXTENSION_REGISTRY_PATH);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = JSON.stringify(registry, null, 2) + '\n';
  writeFileSync(filePath, content, 'utf-8');
}

// ============================================================================
// Preset Registry
// ============================================================================

/**
 * Preset registry structure.
 */
export interface PresetRegistry {
  version: number;
  presets: Record<string, PresetRegistryEntry>;
}

/**
 * Load preset registry from a project.
 * Returns empty registry if file doesn't exist or is invalid.
 *
 * @param projectRoot - Absolute path to project root
 * @returns Loaded or empty preset registry
 */
export function loadPresetRegistry(projectRoot: string): PresetRegistry {
  const filePath = join(projectRoot, PRESET_REGISTRY_PATH);

  if (!existsSync(filePath)) {
    return { version: 1, presets: {} };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as PresetRegistry;
    return parsed;
  } catch {
    return { version: 1, presets: {} };
  }
}

/**
 * Save preset registry to a project.
 *
 * @param projectRoot - Absolute path to project root
 * @param registry - Preset registry to save
 */
export function savePresetRegistry(projectRoot: string, registry: PresetRegistry): void {
  const filePath = join(projectRoot, PRESET_REGISTRY_PATH);
  const dir = dirname(filePath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = JSON.stringify(registry, null, 2) + '\n';
  writeFileSync(filePath, content, 'utf-8');
}

// ============================================================================
// Project Detection
// ============================================================================

/**
 * Check if a directory is a spec-kit project.
 *
 * @param dir - Directory path to check
 * @returns True if directory contains .specify folder
 */
export function isSpeckitProject(dir: string): boolean {
  return existsSync(join(dir, SPECKIT_DIR));
}

/**
 * Find the spec-kit project root by walking up the directory tree.
 *
 * @param startDir - Starting directory
 * @returns Project root path, or null if not found
 */
export function findProjectRoot(startDir: string): string | null {
  let current = startDir;

  while (current !== '/') {
    if (isSpeckitProject(current)) {
      return current;
    }
    current = dirname(current);
  }

  return null;
}
