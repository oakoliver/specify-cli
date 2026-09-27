/**
 * @oakoliver/specify-cli - Step Catalog
 *
 * Step catalog discovery, installation, and registry domain API
 * (port of ``workflows/step/catalog/_domain.py``).
 *
 * @module workflows/step/catalog/domain
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CatalogStackCore,
  catalogLimits,
  MAX_JSON_CATALOG_BYTES,
  pyJsonDump,
  type CatalogConfigRow,
  type CatalogStackSpec,
  type WorkflowCatalogEntry,
} from '../../catalog/domain.js';
import { deepCopy, isMapping, isSymlink, osErrorMessage, pathExists, pyStr, pyTruthy, utcIsoNow } from '../../overlay/py-compat.js';

export { MAX_JSON_CATALOG_BYTES, catalogLimits, type CatalogConfigRow };

// ============================================================================
// Step catalog errors
// ============================================================================

/** Base error for step catalog operations. */
export class StepCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Validation error for step catalog config or step data. */
export class StepValidationError extends StepCatalogError {}

// ============================================================================
// StepCatalogEntry
// ============================================================================

/** Represents a single step catalog source in the catalog stack. */
export type StepCatalogEntry = WorkflowCatalogEntry;

// ============================================================================
// StepRegistry
// ============================================================================

/** Persisted step registry document. */
export interface StepRegistryData {
  schema_version: string;
  steps: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Manages the registry of installed custom step types.
 *
 * Tracks installed step types and their metadata in
 * ``.specify/workflows/steps/step-registry.json``.
 */
export class StepRegistry {
  static readonly REGISTRY_FILE = 'step-registry.json';
  static readonly SCHEMA_VERSION = '1.0';

  readonly projectRoot: string;
  readonly stepsDir: string;
  readonly registryPath: string;
  data: StepRegistryData;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.stepsDir = join(projectRoot, '.specify', 'workflows', 'steps');
    this.registryPath = join(this.stepsDir, StepRegistry.REGISTRY_FILE);
    this.data = this.load();
  }

  /** Return true if any directory under .specify/workflows/steps is a symlink. */
  private hasSymlinkedParent(): boolean {
    let current = this.projectRoot;
    for (const part of ['.specify', 'workflows', 'steps']) {
      current = join(current, part);
      if (isSymlink(current)) return true;
    }
    return false;
  }

  private load(): StepRegistryData {
    const defaultRegistry: StepRegistryData = { schema_version: StepRegistry.SCHEMA_VERSION, steps: {} };
    // Defense-in-depth: refuse to read through symlinked parents / file.
    if (this.hasSymlinkedParent()) return defaultRegistry;
    if (isSymlink(this.registryPath)) return defaultRegistry;
    if (pathExists(this.registryPath)) {
      try {
        const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(this.registryPath))) as unknown;
        if (!isMapping(data)) return defaultRegistry;
        if (!isMapping(data.steps)) data.steps = {};
        return data as StepRegistryData;
      } catch {
        return defaultRegistry;
      }
    }
    return defaultRegistry;
  }

  /**
   * Persist registry to disk.
   *
   * @throws StepValidationError on filesystem errors.
   */
  save(): void {
    if (this.hasSymlinkedParent() || isSymlink(this.registryPath)) {
      throw new StepValidationError('Refusing to write step registry through a symlinked path.');
    }
    try {
      mkdirSync(this.stepsDir, { recursive: true });
      writeFileSync(this.registryPath, pyJsonDump(this.data, 2), 'utf-8');
    } catch (exc) {
      throw new StepValidationError(`Failed to write step registry at ${this.registryPath}: ${osErrorMessage(exc)}`);
    }
  }

  /** Add or update an installed step entry. */
  add(stepId: string, metadata: Record<string, unknown>): void {
    const rawExisting = this.data.steps[stepId];
    const existing = isMapping(rawExisting) ? rawExisting : {};
    const metadataToStore = deepCopy(metadata);
    metadataToStore.installed_at = 'installed_at' in existing ? existing.installed_at : utcIsoNow();
    metadataToStore.updated_at = utcIsoNow();
    this.data.steps[stepId] = metadataToStore;
    this.save();
  }

  /** Remove an installed step entry. Returns true if found. */
  remove(stepId: string): boolean {
    if (Object.prototype.hasOwnProperty.call(this.data.steps, stepId)) {
      delete this.data.steps[stepId];
      this.save();
      return true;
    }
    return false;
  }

  /** Get metadata for an installed step. */
  get(stepId: string): unknown {
    return Object.prototype.hasOwnProperty.call(this.data.steps, stepId) ? this.data.steps[stepId] : null;
  }

  /** Return all installed steps. */
  list(): Record<string, unknown> {
    return { ...this.data.steps };
  }

  /** Check if a step is installed. */
  isInstalled(stepId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.steps, stepId);
  }
}

// ============================================================================
// StepCatalog
// ============================================================================

/**
 * Manages step catalog fetching, caching, and searching.
 *
 * Resolution order for catalog sources:
 * 1. ``SPECKIT_STEP_CATALOG_URL`` env var (overrides all)
 * 2. Project-level ``.specify/step-catalogs.yml``
 * 3. User-level ``~/.specify/step-catalogs.yml``
 * 4. Built-in defaults (official + community)
 */
export class StepCatalog extends CatalogStackCore {
  static readonly DEFAULT_CATALOG_URL =
    'https://raw.githubusercontent.com/github/spec-kit/main/' + 'workflows/step-catalog.json';
  static readonly COMMUNITY_CATALOG_URL =
    'https://raw.githubusercontent.com/github/spec-kit/main/' + 'workflows/step-catalog.community.json';

  readonly stepsDir: string;

  protected readonly spec: CatalogStackSpec = {
    envVar: 'SPECKIT_STEP_CATALOG_URL',
    configFileName: 'step-catalogs.yml',
    cachePrefix: 'step-catalog',
    itemsKey: 'steps',
    label: 'step catalog',
    defaultUrl: StepCatalog.DEFAULT_CATALOG_URL,
    communityUrl: StepCatalog.COMMUNITY_CATALOG_URL,
    defaultDescription: 'Official step types',
    communityDescription: 'Community-contributed step types (discovery only)',
    allFailedMessage: 'All configured step catalogs failed to fetch.',
    noConfigMessage: 'No step catalog config file found.',
    catalogError: StepCatalogError,
    validationError: StepValidationError,
  };

  constructor(projectRoot: string) {
    const stepsDir = join(projectRoot, '.specify', 'workflows', 'steps');
    super(projectRoot, join(stepsDir, '.cache'));
    this.stepsDir = stepsDir;
  }

  /** Return false if any component of the cache path is a symlink. */
  protected override isCachePathSafe(): boolean {
    let current = this.projectRoot;
    for (const part of ['.specify', 'workflows', 'steps', '.cache']) {
      current = join(current, part);
      if (isSymlink(current)) return false;
    }
    return true;
  }

  protected listItemId(itemData: Record<string, unknown>): string | null {
    const raw = 'id' in itemData ? itemData.id : null;
    if (raw === null || raw === undefined) return null;
    const stepId = pyStr(raw).trim();
    if (!stepId) return null;
    itemData.id = stepId;
    return stepId;
  }

  /** Merge steps from all active catalogs (lower priority number wins). */
  getMergedSteps(forceRefresh = false): Promise<Map<string, Record<string, unknown>>> {
    return this.getMergedItems(forceRefresh);
  }

  /** Search step types across all configured catalogs. */
  async search(query: string | null = null): Promise<Record<string, unknown>[]> {
    const merged = await this.getMergedSteps();
    const results: Record<string, unknown>[] = [];
    for (const [stepId, stepData] of merged) {
      if (!('id' in stepData)) stepData.id = stepId;
      if (query) {
        const q = query.toLowerCase();
        const searchable = [stepData.name, stepData.description, stepData.id]
          .map((v) => (pyTruthy(v) ? pyStr(v) : ''))
          .join(' ')
          .toLowerCase();
        if (!searchable.includes(q)) continue;
      }
      results.push(stepData);
    }
    return results;
  }

  /** Get details for a specific step from the catalog. */
  async getStepInfo(stepId: string): Promise<Record<string, unknown> | null> {
    const merged = await this.getMergedSteps();
    const step = merged.get(stepId) ?? null;
    if (step && Object.keys(step).length > 0 && !('id' in step)) step.id = stepId;
    return step;
  }
}
