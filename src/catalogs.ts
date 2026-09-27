/**
 * @oakoliver/specify-cli - Catalog stacks
 *
 * Port of upstream `catalogs.py`: shared catalog stack config primitives
 * (`CatalogEntry`, `CatalogStackBase`). Catalog-specific fetching and schema
 * validation stay in each concrete catalog.
 *
 * @module catalogs
 */

import * as fs from 'node:fs';
import { urlPort, urlsplit } from './download-security.js';
import { parseYaml } from './yaml.js';
import { isPlainObject, pyBool, pyInt, pyRepr, pyStr, pyTypeName } from './utils.js';

// ============================================================================
// CatalogEntry
// ============================================================================

/** A single catalog source in a catalog stack (dataclass `CatalogEntry`). */
export class CatalogEntry {
  url: string;
  name: string;
  priority: number;
  install_allowed: boolean;
  description: string;

  constructor(init: { url: string; name: string; priority: number; install_allowed: boolean; description?: string }) {
    this.url = init.url;
    this.name = init.name;
    this.priority = init.priority;
    this.install_allowed = init.install_allowed;
    this.description = init.description ?? '';
  }
}

/** Constructor type for catalog entries. */
export type CatalogEntryClass<E extends CatalogEntry = CatalogEntry> = new (init: {
  url: string;
  name: string;
  priority: number;
  install_allowed: boolean;
  description?: string;
}) => E;

/** Constructor type for errors raised by catalog stacks. */
export type CatalogErrorClass = new (message: string) => Error;

/** Default error type (Python `ValueError`). */
export class CatalogValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

// ============================================================================
// CatalogStackBase
// ============================================================================

/**
 * Base class for ordered catalog-source resolution. Subclasses override the
 * static `ENTRY_CLASS`, `ERROR_TYPE`, `VALIDATION_ERROR_TYPE` and
 * `CONFIG_FILENAME` members.
 */
export class CatalogStackBase {
  static ENTRY_CLASS: CatalogEntryClass = CatalogEntry;
  static ERROR_TYPE: CatalogErrorClass = CatalogValueError;
  static VALIDATION_ERROR_TYPE: CatalogErrorClass = CatalogValueError;
  static CONFIG_FILENAME: string;

  /** Build an error of the class's `ERROR_TYPE`. */
  static error(message: string): Error {
    return new this.ERROR_TYPE(message);
  }

  /** Build an error of the class's `VALIDATION_ERROR_TYPE`. */
  static validationError(message: string): Error {
    return new this.VALIDATION_ERROR_TYPE(message);
  }

  /** Construct an entry of the class's `ENTRY_CLASS`. */
  static entry(init: { url: string; name: string; priority: number; install_allowed: boolean; description?: string }): CatalogEntry {
    return new this.ENTRY_CLASS({ ...init, description: init.description ?? '' });
  }

  /** Validate that a catalog URL uses HTTPS, except localhost HTTP. Throws `ERROR_TYPE`. */
  static validateCatalogUrl(url: string): void {
    let parsed: ReturnType<typeof urlsplit>;
    try {
      parsed = urlsplit(url);
      urlPort(parsed);
    } catch {
      throw this.error(`Catalog URL is malformed: ${url}`);
    }
    const hostname = parsed.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (parsed.scheme !== 'https' && !(parsed.scheme === 'http' && isLocalhost)) {
      throw this.error(`Catalog URL must use HTTPS (got ${parsed.scheme}://). HTTP is only allowed for localhost.`);
    }
    if (!hostname) throw this.error('Catalog URL must be a valid URL with a host.');
  }

  /** Access the concrete class's statics from an instance. */
  protected get cls(): typeof CatalogStackBase {
    return this.constructor as typeof CatalogStackBase;
  }

  /**
   * Load catalog stack configuration from a YAML file. Returns null when the
   * file does not exist; existing files fail closed (VALIDATION_ERROR_TYPE)
   * when malformed, empty, or without usable URLs. Entries sorted by priority.
   */
  loadCatalogConfig(configPath: string): CatalogEntry[] | null {
    const cls = this.cls;
    if (!fs.existsSync(configPath)) return null;
    let data: unknown;
    try {
      data = parseYaml(fs.readFileSync(configPath, 'utf8'));
    } catch (exc) {
      const e = cls.validationError(`Failed to read catalog config ${configPath}: ${(exc as Error).message}`);
      (e as Error & { cause?: unknown }).cause = exc;
      throw e;
    }
    if (data === null || data === undefined) data = {};
    if (!isPlainObject(data)) {
      throw cls.validationError(`Invalid catalog config ${configPath}: expected a YAML mapping at the root`);
    }
    const catalogsData = 'catalogs' in data ? data.catalogs : [];
    if (!Array.isArray(catalogsData)) {
      throw cls.validationError(
        `Invalid catalog config ${configPath}: 'catalogs' must be a list, got ${pyTypeName(catalogsData)}`,
      );
    }
    if (!catalogsData.length) {
      throw cls.validationError(
        `Catalog config ${configPath} exists but contains no 'catalogs' entries. ` +
          'Remove the file to use built-in defaults, or add valid catalog entries.',
      );
    }
    const entries: CatalogEntry[] = [];
    const skipped: number[] = [];
    catalogsData.forEach((item: unknown, idx: number) => {
      if (!isPlainObject(item)) {
        throw cls.validationError(
          `Invalid catalog config ${configPath}: catalog entry at index ${idx}: expected a mapping, got ${pyTypeName(item)}`,
        );
      }
      const url = pyStr('url' in item ? item.url : '').trim();
      if (!url) {
        skipped.push(idx);
        return;
      }
      try {
        cls.validateCatalogUrl(url);
      } catch (exc) {
        if (exc instanceof cls.ERROR_TYPE) {
          throw cls.validationError(`Invalid catalog URL in ${configPath} at index ${idx}: ${(exc as Error).message}`);
        }
        throw exc;
      }
      const rawPriority = 'priority' in item ? item.priority : idx + 1;
      const nameForError = 'name' in item ? pyStr(item.name) : String(idx + 1);
      if (typeof rawPriority === 'boolean') {
        throw cls.validationError(
          `Invalid catalog config ${configPath}: Invalid priority for catalog '${nameForError}': expected integer, got ${pyRepr(rawPriority)}`,
        );
      }
      let priority: number;
      try {
        priority = pyInt(rawPriority);
      } catch {
        throw cls.validationError(
          `Invalid catalog config ${configPath}: Invalid priority for catalog '${nameForError}': expected integer, got ${pyRepr(rawPriority)}`,
        );
      }
      const rawInstall = 'install_allowed' in item ? item.install_allowed : false;
      const installAllowed =
        typeof rawInstall === 'string' ? ['true', 'yes', '1'].includes(rawInstall.trim().toLowerCase()) : pyBool(rawInstall);
      const rawName = item.name;
      let name = rawName !== null && rawName !== undefined ? pyStr(rawName).trim() : '';
      if (!name) name = `catalog-${entries.length + 1}`;
      entries.push(
        cls.entry({
          url,
          name,
          priority,
          install_allowed: installAllowed,
          description: pyStr('description' in item ? item.description : ''),
        }),
      );
    });
    // Python's list.sort is stable.
    entries.sort((a, b) => a.priority - b.priority);
    if (!entries.length) {
      throw cls.validationError(
        `Catalog config ${configPath} contains ${catalogsData.length} entries but none have valid URLs ` +
          `(entries at indices ${pyRepr(skipped)} were skipped). Each catalog entry must have a 'url' field.`,
      );
    }
    return entries;
  }
}
