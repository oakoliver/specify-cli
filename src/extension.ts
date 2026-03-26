/**
 * @oakoliver/specify-cli - Extension Management
 *
 * Implements the extension system for spec-kit, matching Python behavior.
 * Extensions provide custom commands, hooks, and configurations.
 *
 * @module extension
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { parseFrontmatter } from './registrar.js';

// ============================================================================
// Constants
// ============================================================================

/** Current extension manifest schema version */
export const EXTENSION_SCHEMA_VERSION = '1.0';

/** Extension ID pattern: lowercase alphanumeric + hyphens */
export const EXTENSION_ID_PATTERN = /^[a-z0-9-]+$/;

/** Command name pattern: speckit.{ext-id}.{command} */
export const COMMAND_NAME_PATTERN = /^speckit\.[a-z0-9-]+\.[a-z0-9-]+$/;

/** Semantic version pattern */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

/** Default extension priority */
export const DEFAULT_PRIORITY = 10;

// ============================================================================
// Errors
// ============================================================================

/** Base error for extension operations */
export class ExtensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtensionError';
  }
}

/** Validation error for manifest issues */
export class ValidationError extends ExtensionError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Compatibility error for version mismatches */
export class CompatibilityError extends ExtensionError {
  constructor(message: string) {
    super(message);
    this.name = 'CompatibilityError';
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Tool requirement for an extension.
 */
export interface ToolRequirement {
  name: string;
  version?: string;
  required?: boolean;
}

/**
 * Command definition in extension manifest.
 */
export interface ExtensionCommand {
  /** Command name (e.g., "speckit.ext-id.command") */
  name: string;
  /** Relative path to command file */
  file: string;
  /** Command description */
  description?: string;
  /** Alternative command names */
  aliases?: string[];
}

/**
 * Config file definition in extension manifest.
 */
export interface ExtensionConfig {
  /** Config file name */
  name: string;
  /** Template file path */
  template: string;
  /** Description */
  description?: string;
  /** Whether config is required */
  required?: boolean;
}

/**
 * Hook definition in extension manifest.
 */
export interface ExtensionHook {
  /** Command to execute */
  command: string;
  /** Whether hook is optional (prompts user) */
  optional?: boolean;
  /** Prompt text for optional hooks */
  prompt?: string;
  /** Hook description */
  description?: string;
}

/**
 * Extension manifest (extension.yml).
 * Matches Python spec-kit schema version 1.0.
 */
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
  };
  requires: {
    speckit_version: string;
    tools?: ToolRequirement[];
    commands?: string[];
    scripts?: string[];
  };
  provides: {
    commands: ExtensionCommand[];
    config?: ExtensionConfig[];
  };
  hooks?: Record<string, ExtensionHook>;
  tags?: string[];
  defaults?: Record<string, unknown>;
  config_schema?: Record<string, unknown>;
}

/**
 * Registry metadata for installed extension.
 */
export interface ExtensionMetadata {
  version: string;
  source: 'local' | 'catalog' | 'url';
  source_url?: string;
  source_catalog?: string;
  manifest_hash: string;
  enabled: boolean;
  priority: number;
  registered_commands: Record<string, string[]>;
  registered_skills: string[];
  installed_at: string;
}

/**
 * Extension info for listing.
 */
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
// YAML Parser (zero-dependency)
// ============================================================================

/**
 * Parse simple YAML (key: value format with nested objects).
 * Handles the extension.yml format without external dependencies.
 */
export function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split('\n');
  
  // Stack tracks: object context, its base indentation, and whether it's in an array
  const stack: { obj: Record<string, unknown>; indent: number }[] = [{ obj: result, indent: -2 }];
  let currentArray: unknown[] | null = null;
  let currentArrayIndent = -1;
  let arrayItemObj: Record<string, unknown> | null = null;
  let arrayItemIndent = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;
    
    // Calculate indentation
    const indent = line.search(/\S/);
    const trimmed = line.trim();
    
    // If we're in an array item object and indent decreases, exit array item context
    if (arrayItemObj !== null && indent <= arrayItemIndent && !trimmed.startsWith('-')) {
      arrayItemObj = null;
      arrayItemIndent = -1;
    }
    
    // If indent decreases below array, exit array context
    if (currentArray !== null && indent <= currentArrayIndent && !trimmed.startsWith('-')) {
      currentArray = null;
      currentArrayIndent = -1;
    }
    
    // Pop stack for non-array items
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent && !trimmed.startsWith('-') && arrayItemObj === null) {
      stack.pop();
    }
    
    // Handle array items (- item)
    if (trimmed.startsWith('- ')) {
      const value = trimmed.slice(2).trim();
      
      if (currentArray === null) {
        continue;
      }
      
      // Check if it's an object key (- key: value)
      if (value.includes(':')) {
        const colonIdx = value.indexOf(':');
        const key = value.slice(0, colonIdx).trim();
        const val = value.slice(colonIdx + 1).trim();
        arrayItemObj = { [key]: parseYamlValue(val) };
        arrayItemIndent = indent;
        currentArray.push(arrayItemObj);
      } else if (value === '') {
        // Empty array item that will be an object
        arrayItemObj = {};
        arrayItemIndent = indent;
        currentArray.push(arrayItemObj);
      } else {
        currentArray.push(parseYamlValue(value));
      }
      continue;
    }
    
    // Choose target: array item object or stack top
    const target = arrayItemObj !== null && indent > arrayItemIndent
      ? arrayItemObj
      : stack[stack.length - 1].obj;
    
    // Handle key: value
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    
    if (value === '' || value === '|' || value === '>') {
      // Check if next line starts with '-' (array) or is a nested object
      const nextLineIdx = i + 1;
      if (nextLineIdx < lines.length) {
        const nextLine = lines[nextLineIdx];
        const nextTrimmed = nextLine.trim();
        if (nextTrimmed.startsWith('-')) {
          // This is an array
          target[key] = [];
          currentArray = target[key] as unknown[];
          currentArrayIndent = indent;
          arrayItemObj = null;
          arrayItemIndent = -1;
        } else if (nextTrimmed !== '' && !nextTrimmed.startsWith('#')) {
          // Nested object
          target[key] = {};
          if (arrayItemObj === null) {
            stack.push({ obj: target[key] as Record<string, unknown>, indent });
          }
        } else {
          target[key] = {};
        }
      } else {
        target[key] = {};
      }
    } else {
      target[key] = parseYamlValue(value);
    }
  }
  
  return result;
}

/**
 * Parse a YAML value into appropriate type.
 */
function parseYamlValue(value: string): unknown {
  // Remove quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  
  // Boolean
  if (value === 'true') return true;
  if (value === 'false') return false;
  
  // Null
  if (value === 'null' || value === '~') return null;
  
  // Number
  const num = Number(value);
  if (!isNaN(num) && value !== '') return num;
  
  return value;
}

/**
 * Serialize object to YAML format.
 */
export function toYaml(obj: Record<string, unknown>, indent = 0): string {
  const lines: string[] = [];
  const spaces = '  '.repeat(indent);
  
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      lines.push(`${spaces}${key}: null`);
    } else if (Array.isArray(value)) {
      lines.push(`${spaces}${key}:`);
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          lines.push(`${spaces}  - ${toYaml(item as Record<string, unknown>, indent + 2).trim().replace(/\n/g, '\n' + spaces + '    ')}`);
        } else {
          lines.push(`${spaces}  - ${formatYamlValue(item)}`);
        }
      }
    } else if (typeof value === 'object') {
      lines.push(`${spaces}${key}:`);
      lines.push(toYaml(value as Record<string, unknown>, indent + 1));
    } else {
      lines.push(`${spaces}${key}: ${formatYamlValue(value)}`);
    }
  }
  
  return lines.join('\n');
}

function formatYamlValue(value: unknown): string {
  if (typeof value === 'string') {
    // Quote strings that look like numbers, contain special chars, or are empty
    const needsQuotes = 
      value === '' ||
      value.includes(':') || 
      value.includes('#') || 
      value.includes('\n') ||
      (!isNaN(Number(value)) && value !== '');
    
    if (needsQuotes) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  return String(value);
}

// ============================================================================
// Extension Manifest
// ============================================================================

/**
 * Validates and loads extension manifests.
 */
export class ExtensionManifest {
  static readonly SCHEMA_VERSION = '1.0';
  static readonly REQUIRED_FIELDS = ['schema_version', 'extension', 'requires', 'provides'];
  
  readonly path: string;
  readonly data: ExtensionManifestData;
  
  constructor(manifestPath: string) {
    this.path = manifestPath;
    this.data = this.loadAndValidate();
  }
  
  private loadAndValidate(): ExtensionManifestData {
    if (!existsSync(this.path)) {
      throw new ValidationError(`Manifest not found: ${this.path}`);
    }
    
    const content = readFileSync(this.path, 'utf-8');
    const data = parseSimpleYaml(content) as unknown as ExtensionManifestData;
    
    this.validate(data);
    return data;
  }
  
  private validate(data: ExtensionManifestData): void {
    // Check required top-level fields
    for (const field of ExtensionManifest.REQUIRED_FIELDS) {
      if (!(field in data)) {
        throw new ValidationError(`Missing required field: ${field}`);
      }
    }
    
    // Validate schema version
    const schemaVersion = String(data.schema_version);
    if (schemaVersion !== ExtensionManifest.SCHEMA_VERSION) {
      throw new ValidationError(`Unsupported schema version: ${schemaVersion}. Expected: ${ExtensionManifest.SCHEMA_VERSION}`);
    }
    
    // Validate extension block
    const ext = data.extension;
    if (!ext.id || !ext.name || !ext.version || !ext.description) {
      throw new ValidationError('Extension block missing required fields: id, name, version, description');
    }
    
    // Validate extension ID format
    if (!EXTENSION_ID_PATTERN.test(ext.id)) {
      throw new ValidationError(`Invalid extension ID: ${ext.id}. Must match pattern: ${EXTENSION_ID_PATTERN}`);
    }
    
    // Validate version format
    if (!SEMVER_PATTERN.test(ext.version)) {
      throw new ValidationError(`Invalid version: ${ext.version}. Must be semver format (X.Y.Z)`);
    }
    
    // Validate requires block
    if (!data.requires.speckit_version) {
      throw new ValidationError('Missing required field: requires.speckit_version');
    }
    
    // Validate provides block
    const commands = data.provides?.commands;
    if (!commands || !Array.isArray(commands) || commands.length === 0) {
      throw new ValidationError('Extension must provide at least one command');
    }
    
    // Validate each command
    for (const cmd of data.provides.commands) {
      if (!cmd.name || !cmd.file) {
        throw new ValidationError('Command missing required fields: name, file');
      }
      
      if (!COMMAND_NAME_PATTERN.test(cmd.name)) {
        throw new ValidationError(`Invalid command name: ${cmd.name}. Must match pattern: speckit.{ext-id}.{command}`);
      }
      
      // Validate command name matches extension ID
      const cmdExtId = cmd.name.split('.')[1];
      if (cmdExtId !== ext.id) {
        throw new ValidationError(`Command name ${cmd.name} does not match extension ID ${ext.id}`);
      }
    }
  }
  
  // -- Getters --
  
  get id(): string {
    return this.data.extension.id;
  }
  
  get name(): string {
    return this.data.extension.name;
  }
  
  get version(): string {
    return this.data.extension.version;
  }
  
  get description(): string {
    return this.data.extension.description;
  }
  
  get requiresSpeckitVersion(): string {
    return this.data.requires.speckit_version;
  }
  
  get commands(): ExtensionCommand[] {
    return this.data.provides.commands;
  }
  
  get hooks(): Record<string, ExtensionHook> {
    return this.data.hooks ?? {};
  }
  
  /**
   * Compute SHA256 hash of manifest file.
   */
  getHash(): string {
    const content = readFileSync(this.path, 'utf-8');
    const hash = createHash('sha256').update(content).digest('hex');
    return `sha256:${hash}`;
  }
}

// ============================================================================
// Extension Registry
// ============================================================================

/**
 * Registry data structure.
 */
interface RegistryData {
  schema_version: string;
  extensions: Record<string, ExtensionMetadata>;
}

/**
 * Manages installed extensions registry.
 */
export class ExtensionRegistry {
  private readonly registryPath: string;
  private data: RegistryData;
  
  constructor(projectRoot: string) {
    this.registryPath = join(projectRoot, '.specify', 'extensions', '.registry');
    this.data = this.load();
  }
  
  private load(): RegistryData {
    if (!existsSync(this.registryPath)) {
      return { schema_version: '1.0', extensions: {} };
    }
    
    try {
      const content = readFileSync(this.registryPath, 'utf-8');
      const data = JSON.parse(content);
      return data;
    } catch {
      // Handle corrupted registry
      return { schema_version: '1.0', extensions: {} };
    }
  }
  
  private save(): void {
    const dir = dirname(this.registryPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.registryPath, JSON.stringify(this.data, null, 2));
  }
  
  /**
   * Add new extension to registry.
   */
  add(extensionId: string, metadata: ExtensionMetadata): void {
    this.data.extensions[extensionId] = metadata;
    this.save();
  }
  
  /**
   * Update existing extension (merges with existing, preserves installed_at).
   */
  update(extensionId: string, metadata: Partial<ExtensionMetadata>): void {
    const existing = this.data.extensions[extensionId];
    if (!existing) {
      throw new ExtensionError(`Extension not found: ${extensionId}`);
    }
    
    this.data.extensions[extensionId] = {
      ...existing,
      ...metadata,
      installed_at: existing.installed_at, // Preserve original timestamp
    };
    this.save();
  }
  
  /**
   * Restore extension (for rollback - preserves all original metadata).
   */
  restore(extensionId: string, metadata: ExtensionMetadata): void {
    if (metadata === null || typeof metadata !== 'object') {
      throw new ExtensionError('Invalid metadata: must be an object');
    }
    this.data.extensions[extensionId] = { ...metadata };
    this.save();
  }
  
  /**
   * Remove extension from registry.
   */
  remove(extensionId: string): void {
    delete this.data.extensions[extensionId];
    this.save();
  }
  
  /**
   * Get extension metadata (returns deep copy).
   */
  get(extensionId: string): ExtensionMetadata | null {
    const entry = this.data.extensions[extensionId];
    if (!entry) return null;
    
    try {
      return JSON.parse(JSON.stringify(entry));
    } catch {
      return null;
    }
  }
  
  /**
   * List all installed extensions.
   */
  list(): Record<string, ExtensionMetadata> {
    try {
      return JSON.parse(JSON.stringify(this.data.extensions));
    } catch {
      return {};
    }
  }
  
  /**
   * Get extension IDs only.
   */
  keys(): Set<string> {
    return new Set(Object.keys(this.data.extensions));
  }
  
  /**
   * Check if extension is installed.
   */
  isInstalled(extensionId: string): boolean {
    return extensionId in this.data.extensions;
  }
  
  /**
   * List extensions sorted by priority (lower number = higher precedence).
   */
  listByPriority(includeDisabled = false): [string, ExtensionMetadata][] {
    const entries = Object.entries(this.data.extensions);
    const filtered = includeDisabled
      ? entries
      : entries.filter(([_, meta]) => meta.enabled);
    
    return filtered.sort((a, b) => (a[1].priority ?? DEFAULT_PRIORITY) - (b[1].priority ?? DEFAULT_PRIORITY));
  }
}

// ============================================================================
// Extension Manager
// ============================================================================

/**
 * Manages extension installation, removal, and lifecycle.
 */
export class ExtensionManager {
  readonly projectRoot: string;
  readonly extensionsDir: string;
  readonly registry: ExtensionRegistry;
  
  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.extensionsDir = join(projectRoot, '.specify', 'extensions');
    this.registry = new ExtensionRegistry(projectRoot);
  }
  
  /**
   * Normalize priority value.
   */
  static normalizePriority(value: unknown, defaultValue = DEFAULT_PRIORITY): number {
    if (value === null || value === undefined || value === '') {
      return defaultValue;
    }
    
    const num = Number(value);
    if (isNaN(num) || num <= 0) {
      return defaultValue;
    }
    
    return Math.floor(num);
  }
  
  /**
   * Check if extension is compatible with current spec-kit version.
   */
  checkCompatibility(manifest: ExtensionManifest, speckitVersion: string): boolean {
    const required = manifest.requiresSpeckitVersion;
    
    // Parse version specifier (e.g., ">=0.1.0")
    const match = required.match(/^([<>=!]+)?(\d+\.\d+\.\d+)/);
    if (!match) return true; // Invalid spec, assume compatible
    
    const op = match[1] || '>=';
    const ver = match[2];
    
    const cmp = this.compareVersions(speckitVersion, ver);
    
    switch (op) {
      case '>=': return cmp >= 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      case '<': return cmp < 0;
      case '==': return cmp === 0;
      case '!=': return cmp !== 0;
      default: return cmp >= 0;
    }
  }
  
  private compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    
    for (let i = 0; i < 3; i++) {
      const diff = (partsA[i] || 0) - (partsB[i] || 0);
      if (diff !== 0) return diff;
    }
    
    return 0;
  }
  
  /**
   * Install extension from local directory.
   */
  installFromDirectory(
    sourceDir: string,
    speckitVersion: string,
    registerCommands = true,
    priority = DEFAULT_PRIORITY
  ): ExtensionManifest {
    const manifestPath = join(sourceDir, 'extension.yml');
    const manifest = new ExtensionManifest(manifestPath);
    
    // Check if already installed
    if (this.registry.isInstalled(manifest.id)) {
      throw new ExtensionError(`Extension already installed: ${manifest.id}`);
    }
    
    // Check compatibility
    if (!this.checkCompatibility(manifest, speckitVersion)) {
      throw new CompatibilityError(
        `Extension ${manifest.id} requires spec-kit ${manifest.requiresSpeckitVersion}, but ${speckitVersion} is installed`
      );
    }
    
    // Create extension directory
    const extDir = join(this.extensionsDir, manifest.id);
    if (!existsSync(extDir)) {
      mkdirSync(extDir, { recursive: true });
    }
    
    // Copy extension files
    this.copyExtensionFiles(sourceDir, extDir);
    
    // Register commands if requested
    let registeredCommands: Record<string, string[]> = {};
    if (registerCommands) {
      registeredCommands = this.registerExtensionCommands(manifest, extDir);
    }
    
    // Add to registry
    const metadata: ExtensionMetadata = {
      version: manifest.version,
      source: 'local',
      manifest_hash: manifest.getHash(),
      enabled: true,
      priority: ExtensionManager.normalizePriority(priority),
      registered_commands: registeredCommands,
      registered_skills: [],
      installed_at: new Date().toISOString(),
    };
    
    this.registry.add(manifest.id, metadata);
    
    return manifest;
  }
  
  private copyExtensionFiles(source: string, dest: string): void {
    const entries = readdirSync(source, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = join(source, entry.name);
      const destPath = join(dest, entry.name);
      
      // Skip .extensionignore patterns (simplified - skip common ignored files)
      if (entry.name.startsWith('.') && entry.name !== '.extensionignore') continue;
      if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      
      if (entry.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        this.copyExtensionFiles(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }
  
  private registerExtensionCommands(manifest: ExtensionManifest, extensionDir: string): Record<string, string[]> {
    // Import registrar dynamically to avoid circular dependency
    const { registerCommands } = require('./registrar.js');
    
    const commands = manifest.commands.map(cmd => ({
      name: cmd.name.replace('speckit.', ''),
      description: cmd.description || '',
      content: this.loadCommandContent(extensionDir, cmd.file),
    }));
    
    // Get project's active agent
    const initOptions = this.loadInitOptions();
    const agent = initOptions?.ai || 'copilot';
    
    return registerCommands(agent, commands, this.projectRoot, manifest.id);
  }
  
  private loadCommandContent(extensionDir: string, file: string): string {
    const filePath = join(extensionDir, file);
    if (!existsSync(filePath)) {
      throw new ExtensionError(`Command file not found: ${file}`);
    }
    return readFileSync(filePath, 'utf-8');
  }
  
  private loadInitOptions(): { ai?: string } | null {
    const optionsPath = join(this.projectRoot, '.specify', 'init-options.json');
    if (!existsSync(optionsPath)) return null;
    
    try {
      return JSON.parse(readFileSync(optionsPath, 'utf-8'));
    } catch {
      return null;
    }
  }
  
  /**
   * Remove extension.
   */
  remove(extensionId: string, keepConfig = false): boolean {
    const metadata = this.registry.get(extensionId);
    if (!metadata) {
      throw new ExtensionError(`Extension not found: ${extensionId}`);
    }
    
    // Unregister commands
    if (metadata.registered_commands) {
      this.unregisterCommands(metadata.registered_commands);
    }
    
    // Backup config files if requested
    if (keepConfig) {
      this.backupConfigFiles(extensionId);
    }
    
    // Remove extension directory
    const extDir = join(this.extensionsDir, extensionId);
    if (existsSync(extDir)) {
      rmSync(extDir, { recursive: true });
    }
    
    // Remove from registry
    this.registry.remove(extensionId);
    
    return true;
  }
  
  private unregisterCommands(registeredCommands: Record<string, string[]>): void {
    const { unregisterCommands: unregister } = require('./registrar.js');
    unregister(registeredCommands, this.projectRoot);
  }
  
  private backupConfigFiles(extensionId: string): void {
    const extDir = join(this.extensionsDir, extensionId);
    const backupDir = join(this.extensionsDir, '.backup', extensionId);
    
    if (!existsSync(extDir)) return;
    
    mkdirSync(backupDir, { recursive: true });
    
    // Backup config files (ending in -config.yml or -config.local.yml)
    const files = readdirSync(extDir);
    for (const file of files) {
      if (file.includes('-config.') && file.endsWith('.yml')) {
        copyFileSync(join(extDir, file), join(backupDir, file));
      }
    }
  }
  
  /**
   * List installed extensions.
   */
  listInstalled(): ExtensionInfo[] {
    const extensions = this.registry.list();
    const result: ExtensionInfo[] = [];
    
    for (const [id, metadata] of Object.entries(extensions)) {
      const extDir = join(this.extensionsDir, id);
      const manifestPath = join(extDir, 'extension.yml');
      
      let manifest: ExtensionManifest | null = null;
      try {
        manifest = new ExtensionManifest(manifestPath);
      } catch {
        // Manifest missing or invalid, use metadata
      }
      
      result.push({
        id,
        name: manifest?.name || id,
        version: metadata.version,
        description: manifest?.description || '',
        enabled: metadata.enabled,
        priority: metadata.priority,
        installed_at: metadata.installed_at,
        command_count: manifest?.commands.length || 0,
        hook_count: Object.keys(manifest?.hooks || {}).length,
      });
    }
    
    return result.sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * Get extension by ID.
   */
  getExtension(extensionId: string): ExtensionManifest | null {
    if (!this.registry.isInstalled(extensionId)) {
      return null;
    }
    
    const manifestPath = join(this.extensionsDir, extensionId, 'extension.yml');
    try {
      return new ExtensionManifest(manifestPath);
    } catch {
      return null;
    }
  }
  
  /**
   * Enable extension.
   */
  enable(extensionId: string): void {
    this.registry.update(extensionId, { enabled: true });
  }
  
  /**
   * Disable extension.
   */
  disable(extensionId: string): void {
    this.registry.update(extensionId, { enabled: false });
  }
  
  /**
   * Set extension priority.
   */
  setPriority(extensionId: string, priority: number): void {
    this.registry.update(extensionId, {
      priority: ExtensionManager.normalizePriority(priority),
    });
  }
}

// ============================================================================
// Exports
// ============================================================================

export {
  ExtensionManifest as Manifest,
  ExtensionRegistry as Registry,
  ExtensionManager as Manager,
};
