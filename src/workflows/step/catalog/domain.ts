/**
 * @oakoliver/specify-cli - Step Catalog
 *
 * Step catalog discovery, installation, and registry domain API
 * (port of ``workflows/step/catalog/_domain.py``).
 *
 * @module workflows/step/catalog/domain
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fchownSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

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
import { availableVersions, selectRelease } from './versions.js';

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

/** An ambiguous JSON object in a step catalog (``_DuplicateCatalogField``). */
export class DuplicateCatalogField extends StepCatalogError {}

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
    let fd = -1;
    let tmp: string | null = null;
    try {
      mkdirSync(this.stepsDir, { recursive: true });
      tmp = join(dirname(this.registryPath), `.${basename(this.registryPath)}.${randomBytes(6).toString('hex')}.tmp`);
      fd = openSync(tmp, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      // Keep the exclusive descriptor open while writing and checking the
      // path so a replaced temporary file can never be committed.
      const payload = Buffer.from(pyJsonDump(this.data, 2), 'utf-8');
      let off = 0;
      while (off < payload.length) off += writeSync(fd, payload, off);
      fsyncSync(fd);
      try {
        if (pathExists(this.registryPath)) {
          const existing = lstatSync(this.registryPath);
          if (existing.isFile()) {
            fchmodSync(fd, existing.mode & 0o7777);
            try {
              fchownSync(fd, existing.uid, existing.gid);
            } catch {
              // PermissionError: keep default ownership.
            }
          }
        }
      } catch {
        // Persisting valid data is more important than preserving mode or
        // ownership metadata when that best-effort operation fails.
      }
      const staged = lstatSync(tmp);
      const opened = fstatSync(fd);
      if (!staged.isFile() || staged.dev !== opened.dev || staged.ino !== opened.ino) {
        throw new Error('Staged step registry changed before commit');
      }
      closeSync(fd);
      fd = -1;
      renameSync(tmp, this.registryPath);
      tmp = null;
    } catch (exc) {
      throw new StepValidationError(`Failed to write step registry at ${this.registryPath}: ${osErrorMessage(exc)}`);
    } finally {
      if (fd >= 0) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
      if (tmp !== null) {
        try {
          unlinkSync(tmp);
        } catch {
          // ignore
        }
      }
    }
  }

  /** Add or update an installed step entry. */
  add(stepId: string, metadata: Record<string, unknown>): void {
    const rawExisting = this.data.steps[stepId];
    const hadEntry = Object.prototype.hasOwnProperty.call(this.data.steps, stepId);
    const existing = isMapping(rawExisting) ? rawExisting : {};
    const metadataToStore = deepCopy(metadata);
    metadataToStore.installed_at = 'installed_at' in existing ? existing.installed_at : utcIsoNow();
    metadataToStore.updated_at = utcIsoNow();
    this.data.steps[stepId] = metadataToStore;
    try {
      this.save();
    } catch (exc) {
      if (hadEntry) this.data.steps[stepId] = rawExisting;
      else delete this.data.steps[stepId];
      throw exc;
    }
  }

  /** Remove an installed step entry. Returns true if found. */
  remove(stepId: string): boolean {
    if (Object.prototype.hasOwnProperty.call(this.data.steps, stepId)) {
      const removedEntry = this.data.steps[stepId];
      delete this.data.steps[stepId];
      try {
        this.save();
      } catch (exc) {
        this.data.steps[stepId] = removedEntry;
        throw exc;
      }
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
    duplicateFieldError: DuplicateCatalogField,
    rejectDuplicateListIds: true,
    cacheWarningLabel: 'step catalog',
  };

  constructor(projectRoot: string) {
    const stepsDir = join(projectRoot, '.specify', 'workflows', 'steps');
    super(projectRoot, join(stepsDir, '.cache'));
    this.stepsDir = stepsDir;
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
      availableVersions(stepData, stepId);
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

  /** Get the current or an exact release from the winning catalog. */
  async getStepInfo(stepId: string, version: string | null = null): Promise<Record<string, unknown> | null> {
    const merged = await this.getMergedSteps();
    const step = merged.get(stepId);
    if (step && Object.keys(step).length > 0) {
      if (!('id' in step)) step.id = stepId;
      return selectRelease(step, stepId, version);
    }
    return null;
  }
}
