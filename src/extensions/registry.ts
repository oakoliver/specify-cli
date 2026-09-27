/**
 * @oakoliver/specify-cli - Extension registry
 *
 * Port of ``ExtensionRegistry`` from ``specify_cli/extensions/__init__.py``.
 * Persists installed-extension metadata to ``.specify/extensions/.registry``.
 *
 * @module extensions/registry
 */

import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { pyJsonDumps } from '../bundles/pycompat.js';
import { KeyError } from './errors.js';
import { UnicodeDecodeError, decodeUtf8Strict, lexists, utcNowIsoformat } from './compat.js';
import { type Dict, isMapping, normalizePriority } from './manifest.js';

function deepCopy<T>(value: T): T {
  return structuredClone(value);
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Manages the registry of installed extensions. */
export class ExtensionRegistry {
  static readonly REGISTRY_FILE = '.registry';
  static readonly SCHEMA_VERSION = '1.0';

  readonly extensionsDir: string;
  readonly registryPath: string;
  data: Dict;

  /** @param extensionsDir Path to .specify/extensions/ directory */
  constructor(extensionsDir: string) {
    this.extensionsDir = extensionsDir;
    this.registryPath = join(extensionsDir, ExtensionRegistry.REGISTRY_FILE);
    this.data = this.load();
  }

  private fresh(): Dict {
    return { schema_version: ExtensionRegistry.SCHEMA_VERSION, extensions: {} };
  }

  /** Load registry from disk. */
  private load(): Dict {
    if (!pathExists(this.registryPath)) return this.fresh();
    if (!isRegularFile(this.registryPath)) return this.fresh();

    let raw: Buffer;
    try {
      raw = readFileSync(this.registryPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.fresh();
      // OSError is deliberately not swallowed: the data may be intact on
      // disk, and starting fresh would let a later save() wipe it.
      throw err;
    }
    let data: unknown;
    try {
      data = JSON.parse(decodeUtf8Strict(raw));
    } catch (err) {
      if (err instanceof SyntaxError || err instanceof UnicodeDecodeError) return this.fresh();
      throw err;
    }
    if (!isMapping(data)) return this.fresh();
    if (!isMapping(data.extensions)) data.extensions = {};
    return data;
  }

  /**
   * Report whether an existing registry file is present but unreadable.
   * An absent registry returns ``false``.
   */
  isCorrupt(): boolean {
    if (!lexists(this.registryPath)) return false;
    if (!isRegularFile(this.registryPath)) return true;
    let data: unknown;
    try {
      data = JSON.parse(decodeUtf8Strict(readFileSync(this.registryPath)));
    } catch {
      return true;
    }
    if (!isMapping(data)) return true;
    if ('extensions' in data && !isMapping(data.extensions)) return true;
    return false;
  }

  /** Save registry to disk. */
  save(): void {
    mkdirSync(this.extensionsDir, { recursive: true });
    writeFileSync(this.registryPath, pyJsonDumps(this.data), 'utf-8');
  }

  /** Add extension to registry. */
  add(extensionId: string, metadata: Dict): void {
    this.data.extensions[extensionId] = {
      ...deepCopy(metadata),
      installed_at: utcNowIsoformat(),
    };
    this.save();
  }

  /**
   * Update extension metadata in registry, merging with existing entry.
   * The installed_at timestamp is always preserved from the original entry.
   * @throws KeyError If extension is not installed
   */
  update(extensionId: string, metadata: Dict): void {
    const extensions = this.data.extensions;
    if (!isMapping(extensions) || !Object.prototype.hasOwnProperty.call(extensions, extensionId)) {
      throw new KeyError(`Extension '${extensionId}' is not installed`);
    }
    let existing = extensions[extensionId];
    if (!isMapping(existing)) existing = {};
    const merged: Dict = { ...existing, ...deepCopy(metadata) };
    if (Object.prototype.hasOwnProperty.call(existing, 'installed_at')) {
      merged.installed_at = existing.installed_at;
    } else {
      delete merged.installed_at;
    }
    extensions[extensionId] = merged;
    this.save();
  }

  /**
   * Restore extension metadata to registry without modifying timestamps.
   * @throws Error If metadata is not a dict
   */
  restore(extensionId: string, metadata: Dict | null | undefined): void {
    if (metadata === null || metadata === undefined || !isMapping(metadata)) {
      throw new Error(`Cannot restore '${extensionId}': metadata must be a dict`);
    }
    if (!isMapping(this.data.extensions)) this.data.extensions = {};
    this.data.extensions[extensionId] = deepCopy(metadata);
    this.save();
  }

  /** Remove extension from registry. */
  remove(extensionId: string): void {
    const extensions = this.data.extensions;
    if (!isMapping(extensions)) return;
    if (Object.prototype.hasOwnProperty.call(extensions, extensionId)) {
      delete extensions[extensionId];
      this.save();
    }
  }

  /** Get extension metadata (deep copy), or ``null`` if missing/corrupted. */
  get(extensionId: string): Dict | null {
    const extensions = this.data.extensions;
    if (!isMapping(extensions)) return null;
    if (!Object.prototype.hasOwnProperty.call(extensions, extensionId)) return null;
    const entry = extensions[extensionId];
    if (entry === null || entry === undefined || !isMapping(entry)) return null;
    return deepCopy(entry);
  }

  /** All installed extensions with valid (mapping) metadata, deep-copied. */
  list(): Record<string, Dict> {
    const extensions = this.data.extensions ?? {};
    if (!isMapping(extensions)) return {};
    const result: Record<string, Dict> = {};
    for (const [id, meta] of Object.entries(extensions)) {
      if (isMapping(meta)) result[id] = deepCopy(meta);
    }
    return result;
  }

  /** All extension IDs including corrupted entries. */
  keys(): Set<string> {
    const extensions = this.data.extensions ?? {};
    if (!isMapping(extensions)) return new Set();
    return new Set(Object.keys(extensions));
  }

  /** Check if extension is installed. */
  isInstalled(extensionId: string): boolean {
    const extensions = this.data.extensions;
    if (!isMapping(extensions)) return false;
    return Object.prototype.hasOwnProperty.call(extensions, extensionId);
  }

  /**
   * All installed extensions sorted by priority (lower = higher precedence),
   * ties broken alphabetically by ID.
   */
  listByPriority(includeDisabled = false): Array<[string, Dict]> {
    let extensions = this.data.extensions ?? {};
    if (!isMapping(extensions)) extensions = {};
    const sortable: Array<[string, Dict]> = [];
    for (const [id, meta] of Object.entries(extensions as Dict)) {
      if (!isMapping(meta)) continue;
      const enabled = Object.prototype.hasOwnProperty.call(meta, 'enabled') ? meta.enabled : true;
      if (!includeDisabled && !enabled) continue;
      const copy = deepCopy(meta);
      copy.priority = normalizePriority(
        Object.prototype.hasOwnProperty.call(copy, 'priority') ? copy.priority : 10,
      );
      sortable.push([id, copy]);
    }
    return sortable.sort((a, b) => {
      if (a[1].priority !== b[1].priority) return a[1].priority - b[1].priority;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
  }
}
