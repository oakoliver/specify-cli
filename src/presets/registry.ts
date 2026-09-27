/**
 * @oakoliver/specify-cli - Installed preset registry
 *
 * Port of ``specify_cli/presets/_registry.py``: the ``.specify/presets/.registry``
 * JSON store of installed presets.
 *
 * @module presets/registry
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizePriority } from '../extensions/index.js';
import {
  UnicodeDecodeError,
  deepCopy,
  isMapping,
  pyJsonDumps,
  pyTruthy,
  readTextStrict,
  utcNowIso,
} from './manifest.js';

/** Registry metadata for an installed preset (keys persisted verbatim). */
export type PresetRegistryEntry = Record<string, any>;

/** Error raised by {@link PresetRegistry.update} for unknown presets (Python ``KeyError``). */
export class PresetRegistryKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}

/** Manages the registry of installed presets. */
export class PresetRegistry {
  static readonly REGISTRY_FILE = '.registry';
  static readonly SCHEMA_VERSION = '1.0';

  readonly packsDir: string;
  readonly registryPath: string;
  data: Record<string, any>;

  /**
   * @param packsDir Path to .specify/presets/ directory
   */
  constructor(packsDir: string) {
    this.packsDir = packsDir;
    this.registryPath = join(packsDir, PresetRegistry.REGISTRY_FILE);
    this.data = this.load();
  }

  /** Load registry from disk. */
  private load(): Record<string, any> {
    const fresh = () => ({ schema_version: PresetRegistry.SCHEMA_VERSION, presets: {} });
    if (!existsSync(this.registryPath)) return fresh();
    let text: string;
    try {
      text = readTextStrict(this.registryPath);
    } catch (e) {
      // A registry whose bytes cannot be decoded as UTF-8 is the same
      // corruption class as malformed JSON. OSError is deliberately not
      // caught (FileNotFoundError excepted): the data may be intact on disk.
      if (e instanceof UnicodeDecodeError) return fresh();
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return fresh();
      throw e;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return fresh();
    }
    if (!isMapping(data)) return fresh();
    if (!isMapping(data.presets)) data.presets = {};
    return data as Record<string, any>;
  }

  /** Save registry to disk. */
  private save(): void {
    mkdirSync(this.packsDir, { recursive: true });
    writeFileSync(this.registryPath, pyJsonDumps(this.data, 2), 'utf-8');
  }

  /** Add preset to registry (stamps ``installed_at``). */
  add(packId: string, metadata: PresetRegistryEntry): void {
    this.data.presets[packId] = {
      ...deepCopy(metadata),
      installed_at: utcNowIso(),
    };
    this.save();
  }

  /** Remove preset from registry. */
  remove(packId: string): void {
    const packs = this.data.presets;
    if (!isMapping(packs)) return;
    if (Object.prototype.hasOwnProperty.call(packs, packId)) {
      delete packs[packId];
      this.save();
    }
  }

  /**
   * Update preset metadata in registry, merging with the existing entry.
   * The ``installed_at`` timestamp is always preserved from the original entry.
   *
   * @throws PresetRegistryKeyError If preset is not installed
   */
  update(packId: string, updates: PresetRegistryEntry): void {
    const packs = this.data.presets;
    if (!isMapping(packs) || !Object.prototype.hasOwnProperty.call(packs, packId)) {
      throw new PresetRegistryKeyError(`Preset '${packId}' not found in registry`);
    }
    let existing = packs[packId];
    if (!isMapping(existing)) existing = {};
    const merged: Record<string, unknown> = { ...(existing as object), ...deepCopy(updates) };
    if (Object.prototype.hasOwnProperty.call(existing, 'installed_at')) {
      merged.installed_at = (existing as Record<string, unknown>).installed_at;
    } else {
      delete merged.installed_at;
    }
    packs[packId] = merged;
    this.save();
  }

  /**
   * Restore preset metadata to registry without modifying timestamps.
   *
   * @throws Error (Python ``ValueError``) If metadata is not a mapping
   */
  restore(packId: string, metadata: PresetRegistryEntry | null | undefined): void {
    if (metadata === null || metadata === undefined || !isMapping(metadata)) {
      throw new Error(`Cannot restore '${packId}': metadata must be a dict`);
    }
    if (!isMapping(this.data.presets)) this.data.presets = {};
    this.data.presets[packId] = deepCopy(metadata);
    this.save();
  }

  /** Get a deep copy of preset metadata, or null if not found or corrupted. */
  get(packId: string): PresetRegistryEntry | null {
    const packs = this.data.presets;
    if (!isMapping(packs)) return null;
    if (!Object.prototype.hasOwnProperty.call(packs, packId)) return null;
    const entry = packs[packId];
    if (entry === null || entry === undefined || !isMapping(entry)) return null;
    return deepCopy(entry);
  }

  /** Get all installed presets with valid (mapping) metadata, deep-copied. */
  list(): Record<string, PresetRegistryEntry> {
    const packs = this.data.presets || {};
    if (!isMapping(packs)) return {};
    const out: Record<string, PresetRegistryEntry> = {};
    for (const [packId, meta] of Object.entries(packs)) {
      if (isMapping(meta)) out[packId] = deepCopy(meta);
    }
    return out;
  }

  /** Get all preset IDs including corrupted entries. */
  keys(): Set<string> {
    const packs = this.data.presets || {};
    if (!isMapping(packs)) return new Set();
    return new Set(Object.keys(packs));
  }

  /**
   * Get all installed presets sorted by priority (lower number = higher
   * precedence; ties broken by id).
   */
  listByPriority(includeDisabled = false): Array<[string, PresetRegistryEntry]> {
    let packs = this.data.presets || {};
    if (!isMapping(packs)) packs = {};
    const sortable: Array<[string, PresetRegistryEntry]> = [];
    for (const [packId, meta] of Object.entries(packs as Record<string, unknown>)) {
      if (!isMapping(meta)) continue;
      const enabled = 'enabled' in meta ? meta.enabled : true;
      if (!includeDisabled && !pyTruthy(enabled)) continue;
      const copy = deepCopy(meta) as PresetRegistryEntry;
      copy.priority = normalizePriority('priority' in copy ? copy.priority : 10);
      sortable.push([packId, copy]);
    }
    return sortable.sort((a, b) => {
      if (a[1].priority !== b[1].priority) return a[1].priority - b[1].priority;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
  }

  /** Check if preset is installed. */
  isInstalled(packId: string): boolean {
    const packs = this.data.presets;
    if (!isMapping(packs)) return false;
    return Object.prototype.hasOwnProperty.call(packs, packId);
  }
}
