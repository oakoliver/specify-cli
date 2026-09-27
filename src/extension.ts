/**
 * @oakoliver/specify-cli - Extension Management (legacy compatibility layer)
 *
 * The extension system is now a 1:1 port of upstream
 * ``specify_cli/extensions`` and lives in ``src/extensions/``. This module
 * re-exports it under the historical ``./extension.js`` path and keeps the
 * older convenience names (``parseSimpleYaml``, ``toYaml``,
 * ``EXTENSION_ID_PATTERN``, ``ExtensionManager#enable`` ...) working.
 *
 * @module extension
 */

import { dumpYaml, parseYaml } from './yaml.js';
import {
  ExtensionManager as BaseExtensionManager,
  type InstallFromDirectoryOptions,
  EXTENSION_COMMAND_NAME_PATTERN,
  HookExecutor,
  KeyError,
  normalizePriority,
  type ExtensionManifest,
} from './extensions/index.js';

export * from './extensions/index.js';

// ============================================================================
// Legacy constants
// ============================================================================

/** Current extension manifest schema version */
export const EXTENSION_SCHEMA_VERSION = '1.0';

/** Extension ID pattern: lowercase alphanumeric + hyphens */
export const EXTENSION_ID_PATTERN = /^[a-z0-9-]+$/;

/** Command name pattern: speckit.{ext-id}.{command} */
export const COMMAND_NAME_PATTERN = EXTENSION_COMMAND_NAME_PATTERN;

/** Semantic version pattern (legacy helper; manifests are validated as PEP 440). */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** Default extension priority */
export const DEFAULT_PRIORITY = 10;

// ============================================================================
// Legacy types (manifest / registry shapes)
// ============================================================================

/** Tool requirement for an extension. */
export interface ToolRequirement {
  name: string;
  version?: string;
  required?: boolean;
}

/** Command definition in extension manifest. */
export interface ExtensionCommand {
  name: string;
  file: string;
  description?: string;
  aliases?: string[];
}

/** Config file definition in extension manifest. */
export interface ExtensionConfig {
  name: string;
  template: string;
  description?: string;
  required?: boolean;
}

/** Hook definition in extension manifest. */
export interface ExtensionHook {
  command: string;
  optional?: boolean;
  prompt?: string;
  description?: string;
  priority?: number;
  condition?: string;
}

/** Extension manifest (extension.yml), schema version 1.0. */
export interface ExtensionManifestData {
  schema_version: string;
  extension: {
    id: string;
    name: string;
    version: string;
    description: string;
    author?: string;
    repository?: string;
    license?: string;
    homepage?: string;
    category?: string;
    effect?: string;
  };
  requires: {
    speckit_version: string;
    tools?: ToolRequirement[];
    commands?: string[];
    scripts?: string[];
  };
  provides: {
    commands?: ExtensionCommand[];
    config?: ExtensionConfig[];
    templates?: Array<{ name: string; file: string; description?: string }>;
    scripts?: Array<{ name: string; file: string; description?: string; runtimes?: string[] }>;
  };
  hooks?: Record<string, ExtensionHook | ExtensionHook[]>;
  events?: Record<string, unknown>;
  tags?: string[];
  defaults?: Record<string, unknown>;
  config_schema?: Record<string, unknown>;
}

/** Registry metadata for installed extension. */
export interface ExtensionMetadata {
  version: string;
  source: 'local' | { kind: 'catalog'; catalog: string } | string;
  manifest_hash: string;
  enabled: boolean;
  priority: number;
  registered_commands: Record<string, string[]>;
  registered_skills: string[];
  installed_at: string;
}

/** Extension info for listing. */
export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  priority: number;
  installed_at: string;
  command_count: number;
  hook_count: number;
}

// ============================================================================
// Legacy YAML helpers (now backed by the PyYAML-compatible src/yaml.ts)
// ============================================================================

/** Parse YAML text into a mapping (non-mapping documents yield ``{}``). */
export function parseSimpleYaml(content: string): Record<string, unknown> {
  const data = parseYaml(content);
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

/** Serialize a mapping to block-style YAML (key order preserved). */
export function toYaml(obj: Record<string, unknown>, _indent = 0): string {
  return dumpYaml(obj, { sortKeys: false, defaultFlowStyle: false, allowUnicode: true }).replace(/\n$/, '');
}

// ============================================================================
// Legacy ExtensionManager conveniences
// ============================================================================

/**
 * ``ExtensionManager`` with the legacy convenience methods
 * (``enable``/``disable``/``setPriority`` and the positional
 * ``installFromDirectory(path, version, registerCommands, priority)`` form).
 */
export class ExtensionManager extends BaseExtensionManager {
  /** Legacy alias of the module-level {@link normalizePriority}. */
  static normalizePriority(value: unknown, defaultValue = DEFAULT_PRIORITY): number {
    return normalizePriority(value, defaultValue);
  }

  override installFromDirectory(
    sourceDir: string,
    speckitVersion: string,
    registerCommandsOrOptions: boolean | InstallFromDirectoryOptions = {},
    priority?: number,
  ): ExtensionManifest {
    const options: InstallFromDirectoryOptions =
      typeof registerCommandsOrOptions === 'boolean'
        ? { registerCommands: registerCommandsOrOptions, ...(priority !== undefined ? { priority } : {}) }
        : registerCommandsOrOptions;
    return super.installFromDirectory(sourceDir, speckitVersion, options);
  }

  private setEnabled(extensionId: string, enabled: boolean): void {
    if (!this.registry.isInstalled(extensionId)) {
      throw new KeyError(`Extension '${extensionId}' is not installed`);
    }
    this.registry.update(extensionId, { enabled });
    const executor = new HookExecutor(this.projectRoot);
    if (enabled) executor.enableHooks(extensionId);
    else executor.disableHooks(extensionId);
  }

  /** Enable an installed extension (registry + hooks). */
  enable(extensionId: string): void {
    this.setEnabled(extensionId, true);
  }

  /** Disable an installed extension (registry + hooks). */
  disable(extensionId: string): void {
    this.setEnabled(extensionId, false);
  }

  /** Set the resolution priority of an installed extension (invalid values normalize to the default). */
  setPriority(extensionId: string, priority: number): void {
    this.registry.update(extensionId, { priority: normalizePriority(priority) });
  }
}
