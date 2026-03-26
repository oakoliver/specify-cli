/**
 * @oakoliver/specify-cli - Preset Management
 *
 * Implements the preset system for spec-kit, matching Python behavior.
 * Presets provide template overrides and default configurations.
 *
 * @module preset
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { parseSimpleYaml, toYaml, DEFAULT_PRIORITY } from './extension.js';

// ============================================================================
// Constants
// ============================================================================

/** Current preset manifest schema version */
export const PRESET_SCHEMA_VERSION = '1.0';

/** Preset ID pattern: lowercase alphanumeric + hyphens */
export const PRESET_ID_PATTERN = /^[a-z0-9-]+$/;

/** Valid template types */
export const VALID_TEMPLATE_TYPES = [
  'spec-template',
  'plan-template',
  'tasks-template',
  'checklist-template',
  'agent-file-template',
  'constitution-template',
  'command-template',
] as const;

export type TemplateType = typeof VALID_TEMPLATE_TYPES[number];

// ============================================================================
// Errors
// ============================================================================

/** Base error for preset operations */
export class PresetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetError';
  }
}

/** Validation error for manifest issues */
export class PresetValidationError extends PresetError {
  constructor(message: string) {
    super(message);
    this.name = 'PresetValidationError';
  }
}

/** Compatibility error for version mismatches */
export class PresetCompatibilityError extends PresetError {
  constructor(message: string) {
    super(message);
    this.name = 'PresetCompatibilityError';
  }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Template definition in preset manifest.
 */
export interface PresetTemplate {
  /** Template type */
  type: TemplateType;
  /** Template name */
  name: string;
  /** Relative path to template file */
  file: string;
  /** Template description */
  description?: string;
}

/**
 * Preset manifest (preset.yml).
 * Matches Python spec-kit schema version 1.0.
 */
export interface PresetManifestData {
  schema_version: string;
  preset: {
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
  };
  provides: {
    templates: PresetTemplate[];
  };
  tags?: string[];
  defaults?: Record<string, unknown>;
}

/**
 * Registry metadata for installed preset.
 */
export interface PresetMetadata {
  version: string;
  source: 'local' | 'catalog' | 'url';
  source_url?: string;
  source_catalog?: string;
  manifest_hash: string;
  enabled: boolean;
  priority: number;
  installed_at: string;
}

/**
 * Preset info for listing.
 */
export interface PresetInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  priority: number;
  installed_at: string;
  template_count: number;
}

/**
 * Template resolution result.
 */
export interface ResolvedTemplate {
  content: string;
  source: 'core' | 'preset' | 'extension' | 'override';
  source_id?: string;
}

// ============================================================================
// Preset Manifest
// ============================================================================

/**
 * Validates and loads preset manifests.
 */
export class PresetManifest {
  static readonly SCHEMA_VERSION = '1.0';
  static readonly REQUIRED_FIELDS = ['schema_version', 'preset', 'requires', 'provides'];
  
  readonly path: string;
  readonly data: PresetManifestData;
  
  constructor(manifestPath: string) {
    this.path = manifestPath;
    this.data = this.loadAndValidate();
  }
  
  private loadAndValidate(): PresetManifestData {
    if (!existsSync(this.path)) {
      throw new PresetValidationError(`Manifest not found: ${this.path}`);
    }
    
    const content = readFileSync(this.path, 'utf-8');
    const data = parseSimpleYaml(content) as unknown as PresetManifestData;
    
    this.validate(data);
    return data;
  }
  
  private validate(data: PresetManifestData): void {
    // Check required top-level fields
    for (const field of PresetManifest.REQUIRED_FIELDS) {
      if (!(field in data)) {
        throw new PresetValidationError(`Missing required field: ${field}`);
      }
    }
    
    // Validate schema version
    const schemaVersion = String(data.schema_version);
    if (schemaVersion !== PresetManifest.SCHEMA_VERSION) {
      throw new PresetValidationError(`Unsupported schema version: ${schemaVersion}. Expected: ${PresetManifest.SCHEMA_VERSION}`);
    }
    
    // Validate preset block
    const preset = data.preset;
    if (!preset.id || !preset.name || !preset.version || !preset.description) {
      throw new PresetValidationError('Preset block missing required fields: id, name, version, description');
    }
    
    // Validate preset ID format
    if (!PRESET_ID_PATTERN.test(preset.id)) {
      throw new PresetValidationError(`Invalid preset ID: ${preset.id}. Must match pattern: ${PRESET_ID_PATTERN}`);
    }
    
    // Validate requires block
    if (!data.requires.speckit_version) {
      throw new PresetValidationError('Missing required field: requires.speckit_version');
    }
    
    // Validate provides block
    const templates = data.provides?.templates;
    if (!templates || !Array.isArray(templates) || templates.length === 0) {
      throw new PresetValidationError('Preset must provide at least one template');
    }
    
    // Validate each template
    for (const template of templates) {
      if (!template.type || !template.name || !template.file) {
        throw new PresetValidationError('Template missing required fields: type, name, file');
      }
      
      if (!VALID_TEMPLATE_TYPES.includes(template.type as TemplateType)) {
        throw new PresetValidationError(`Invalid template type: ${template.type}. Valid types: ${VALID_TEMPLATE_TYPES.join(', ')}`);
      }
    }
  }
  
  // -- Getters --
  
  get id(): string {
    return this.data.preset.id;
  }
  
  get name(): string {
    return this.data.preset.name;
  }
  
  get version(): string {
    return this.data.preset.version;
  }
  
  get description(): string {
    return this.data.preset.description;
  }
  
  get requiresSpeckitVersion(): string {
    return this.data.requires.speckit_version;
  }
  
  get templates(): PresetTemplate[] {
    return this.data.provides.templates;
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
// Preset Registry
// ============================================================================

/**
 * Registry data structure.
 */
interface PresetRegistryData {
  schema_version: string;
  presets: Record<string, PresetMetadata>;
}

/**
 * Manages installed presets registry.
 */
export class PresetRegistry {
  private readonly registryPath: string;
  private data: PresetRegistryData;
  
  constructor(projectRoot: string) {
    this.registryPath = join(projectRoot, '.specify', 'presets', '.registry');
    this.data = this.load();
  }
  
  private load(): PresetRegistryData {
    if (!existsSync(this.registryPath)) {
      return { schema_version: '1.0', presets: {} };
    }
    
    try {
      const content = readFileSync(this.registryPath, 'utf-8');
      const data = JSON.parse(content);
      return data;
    } catch {
      // Handle corrupted registry
      return { schema_version: '1.0', presets: {} };
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
   * Add new preset to registry.
   */
  add(presetId: string, metadata: PresetMetadata): void {
    this.data.presets[presetId] = metadata;
    this.save();
  }
  
  /**
   * Update existing preset (merges with existing, preserves installed_at).
   */
  update(presetId: string, metadata: Partial<PresetMetadata>): void {
    const existing = this.data.presets[presetId];
    if (!existing) {
      throw new PresetError(`Preset not found: ${presetId}`);
    }
    
    this.data.presets[presetId] = {
      ...existing,
      ...metadata,
      installed_at: existing.installed_at, // Preserve original timestamp
    };
    this.save();
  }
  
  /**
   * Restore preset (for rollback - preserves all original metadata).
   */
  restore(presetId: string, metadata: PresetMetadata): void {
    if (metadata === null || typeof metadata !== 'object') {
      throw new PresetError('Invalid metadata: must be an object');
    }
    this.data.presets[presetId] = { ...metadata };
    this.save();
  }
  
  /**
   * Remove preset from registry.
   */
  remove(presetId: string): void {
    delete this.data.presets[presetId];
    this.save();
  }
  
  /**
   * Get preset metadata (returns deep copy).
   */
  get(presetId: string): PresetMetadata | null {
    const entry = this.data.presets[presetId];
    if (!entry) return null;
    
    try {
      return JSON.parse(JSON.stringify(entry));
    } catch {
      return null;
    }
  }
  
  /**
   * List all installed presets.
   */
  list(): Record<string, PresetMetadata> {
    try {
      return JSON.parse(JSON.stringify(this.data.presets));
    } catch {
      return {};
    }
  }
  
  /**
   * Get preset IDs only.
   */
  keys(): Set<string> {
    return new Set(Object.keys(this.data.presets));
  }
  
  /**
   * Check if preset is installed.
   */
  isInstalled(presetId: string): boolean {
    return presetId in this.data.presets;
  }
  
  /**
   * List presets sorted by priority (lower number = higher precedence).
   */
  listByPriority(includeDisabled = false): [string, PresetMetadata][] {
    const entries = Object.entries(this.data.presets);
    const filtered = includeDisabled
      ? entries
      : entries.filter(([_, meta]) => meta.enabled);
    
    return filtered.sort((a, b) => (a[1].priority ?? DEFAULT_PRIORITY) - (b[1].priority ?? DEFAULT_PRIORITY));
  }
}

// ============================================================================
// Preset Manager
// ============================================================================

/**
 * Manages preset installation, removal, and lifecycle.
 */
export class PresetManager {
  readonly projectRoot: string;
  readonly presetsDir: string;
  readonly registry: PresetRegistry;
  
  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.presetsDir = join(projectRoot, '.specify', 'presets');
    this.registry = new PresetRegistry(projectRoot);
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
   * Check if preset is compatible with current spec-kit version.
   */
  checkCompatibility(manifest: PresetManifest, speckitVersion: string): boolean {
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
   * Install preset from local directory.
   */
  installFromDirectory(
    sourceDir: string,
    speckitVersion: string,
    priority = DEFAULT_PRIORITY
  ): PresetManifest {
    const manifestPath = join(sourceDir, 'preset.yml');
    const manifest = new PresetManifest(manifestPath);
    
    // Check if already installed
    if (this.registry.isInstalled(manifest.id)) {
      throw new PresetError(`Preset already installed: ${manifest.id}`);
    }
    
    // Check compatibility
    if (!this.checkCompatibility(manifest, speckitVersion)) {
      throw new PresetCompatibilityError(
        `Preset ${manifest.id} requires spec-kit ${manifest.requiresSpeckitVersion}, but ${speckitVersion} is installed`
      );
    }
    
    // Create preset directory
    const presetDir = join(this.presetsDir, manifest.id);
    if (!existsSync(presetDir)) {
      mkdirSync(presetDir, { recursive: true });
    }
    
    // Copy preset files
    this.copyPresetFiles(sourceDir, presetDir);
    
    // Add to registry
    const metadata: PresetMetadata = {
      version: manifest.version,
      source: 'local',
      manifest_hash: manifest.getHash(),
      enabled: true,
      priority: PresetManager.normalizePriority(priority),
      installed_at: new Date().toISOString(),
    };
    
    this.registry.add(manifest.id, metadata);
    
    return manifest;
  }
  
  private copyPresetFiles(source: string, dest: string): void {
    const entries = readdirSync(source, { withFileTypes: true });
    
    for (const entry of entries) {
      const srcPath = join(source, entry.name);
      const destPath = join(dest, entry.name);
      
      // Skip common ignored files
      if (entry.name.startsWith('.') && entry.name !== '.presetignore') continue;
      if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
      
      if (entry.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        this.copyPresetFiles(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }
  
  /**
   * Remove preset.
   */
  remove(presetId: string): boolean {
    const metadata = this.registry.get(presetId);
    if (!metadata) {
      throw new PresetError(`Preset not found: ${presetId}`);
    }
    
    // Remove preset directory
    const presetDir = join(this.presetsDir, presetId);
    if (existsSync(presetDir)) {
      rmSync(presetDir, { recursive: true });
    }
    
    // Remove from registry
    this.registry.remove(presetId);
    
    return true;
  }
  
  /**
   * List installed presets.
   */
  listInstalled(): PresetInfo[] {
    const presets = this.registry.list();
    const result: PresetInfo[] = [];
    
    for (const [id, metadata] of Object.entries(presets)) {
      const presetDir = join(this.presetsDir, id);
      const manifestPath = join(presetDir, 'preset.yml');
      
      let manifest: PresetManifest | null = null;
      try {
        manifest = new PresetManifest(manifestPath);
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
        template_count: manifest?.templates.length || 0,
      });
    }
    
    return result.sort((a, b) => a.priority - b.priority);
  }
  
  /**
   * Get preset by ID.
   */
  getPreset(presetId: string): PresetManifest | null {
    if (!this.registry.isInstalled(presetId)) {
      return null;
    }
    
    const manifestPath = join(this.presetsDir, presetId, 'preset.yml');
    try {
      return new PresetManifest(manifestPath);
    } catch {
      return null;
    }
  }
  
  /**
   * Enable preset.
   */
  enable(presetId: string): void {
    this.registry.update(presetId, { enabled: true });
  }
  
  /**
   * Disable preset.
   */
  disable(presetId: string): void {
    this.registry.update(presetId, { enabled: false });
  }
  
  /**
   * Set preset priority.
   */
  setPriority(presetId: string, priority: number): void {
    this.registry.update(presetId, {
      priority: PresetManager.normalizePriority(priority),
    });
  }
}

// ============================================================================
// Preset Resolver
// ============================================================================

/**
 * Resolves templates from presets, extensions, and overrides.
 * Priority order (highest to lowest):
 * 1. Project overrides (.specify/templates/)
 * 2. Presets (by priority)
 * 3. Extensions (by priority)
 * 4. Core templates
 */
export class PresetResolver {
  readonly projectRoot: string;
  readonly presetManager: PresetManager;
  
  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.presetManager = new PresetManager(projectRoot);
  }
  
  /**
   * Resolve a template by name.
   */
  resolve(templateName: string): ResolvedTemplate | null {
    // 1. Check project overrides
    const overridePath = join(this.projectRoot, '.specify', 'templates', templateName);
    if (existsSync(overridePath)) {
      return {
        content: readFileSync(overridePath, 'utf-8'),
        source: 'override',
      };
    }
    
    // 2. Check presets (by priority)
    const presets = this.presetManager.registry.listByPriority();
    for (const [presetId, _] of presets) {
      const manifest = this.presetManager.getPreset(presetId);
      if (!manifest) continue;
      
      const template = manifest.templates.find(t => t.name === templateName);
      if (template) {
        const templatePath = join(this.presetManager.presetsDir, presetId, template.file);
        if (existsSync(templatePath)) {
          return {
            content: readFileSync(templatePath, 'utf-8'),
            source: 'preset',
            source_id: presetId,
          };
        }
      }
    }
    
    // 3. Check core templates (bundled)
    const corePath = join(this.projectRoot, '.specify', 'templates', templateName);
    if (existsSync(corePath)) {
      return {
        content: readFileSync(corePath, 'utf-8'),
        source: 'core',
      };
    }
    
    return null;
  }
  
  /**
   * Resolve a template and return both content and source info.
   */
  resolveWithSource(templateName: string): ResolvedTemplate | null {
    return this.resolve(templateName);
  }
}

// ============================================================================
// Exports
// ============================================================================

export {
  PresetManifest as Manifest,
  PresetRegistry as Registry,
  PresetManager as Manager,
  PresetResolver as Resolver,
};
