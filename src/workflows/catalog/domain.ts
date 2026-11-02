/**
 * @oakoliver/specify-cli - Workflow Catalog
 *
 * Workflow catalog discovery, installation, and registry domain API
 * (port of ``workflows/catalog/_domain.py``).
 *
 * Mirrors the extension/preset catalog pattern with:
 * - Multi-catalog stack (env var -> project -> user -> built-in)
 * - SHA256-hashed per-URL caching with 1-hour TTL
 * - Workflow registry for installed workflow tracking
 * - Search across all configured catalog sources
 *
 * @module workflows/catalog/domain
 */

import type { FileHelper } from '../../file-helper.js';
import { FileHelperError, isErrno } from '../../file-helper.js';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fchownSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { openUrl } from '../../authentication/http.js';
import { MAX_JSON_CATALOG_BYTES, readResponseLimited } from '../../download-security.js';
import { loadsUniqueJson } from '../../json-unique.js';
import { dumpYaml, parseYaml } from '../../yaml.js';
import { readCacheJson, writeCacheJson } from '../catalog-cache.js';
import { availableVersions, selectRelease } from './versions.js';
import {
  isMapping,
  isSymlink,
  osErrorMessage,
  pathExists,
  pyHome,
  pyInt,
  pyRepr,
  pyStr,
  pyTruthy,
  pyTypeName,
  pyUrlParse,
  utcIsoNow,
} from '../overlay/py-compat.js';

export { MAX_JSON_CATALOG_BYTES };

/**
 * Size limit read at call time (tests may lower it, mirroring the Python
 * compatibility-exposed ``MAX_JSON_CATALOG_BYTES`` monkeypatch point).
 */
export const catalogLimits: { maxJsonCatalogBytes: number } = { maxJsonCatalogBytes: MAX_JSON_CATALOG_BYTES };

/**
 * HTTP seam (Python tests monkeypatch ``specify_cli.authentication.http.open_url``);
 * tests replace ``httpDeps.openUrl`` with a fake.
 */
export const httpDeps: { openUrl: typeof openUrl } = { openUrl };

// ============================================================================
// Errors
// ============================================================================

/** Base error for workflow catalog operations. */
export class WorkflowCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Validation error for catalog config or workflow data. */
export class WorkflowValidationError extends WorkflowCatalogError {}

/** Filesystem error raised by ``WorkflowRegistry`` (Python ``OSError``). */
export class WorkflowRegistryError extends Error {
  readonly code = 'EREGISTRY';
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRegistryError';
  }
}

// ============================================================================
// CatalogEntry
// ============================================================================

/** Represents a single catalog source in the catalog stack. */
export interface WorkflowCatalogEntry {
  url: string;
  name: string;
  priority: number;
  install_allowed: boolean;
  description: string;
}

/** ``get_catalog_configs()`` row. */
export interface CatalogConfigRow {
  name: string;
  url: string;
  priority: number;
  install_allowed: boolean;
  description: string;
}

type ErrorCtor = new (message: string) => Error;

// ============================================================================
// Shared HTTP / JSON helpers
// ============================================================================

interface UrlResponseLike {
  url?: string;
  geturl?: () => string;
}

/** Final (post-redirect) URL of an ``openUrl`` response. */
export function responseUrl(resp: unknown, fallback: string): string {
  const r = resp as UrlResponseLike;
  if (typeof r.geturl === 'function') return r.geturl();
  if (typeof r.url === 'string' && r.url) return r.url;
  return fallback;
}

/** Serialize like ``json.dump(data, f, indent=2)`` (ASCII-escaped). */
export function pyJsonDump(data: unknown, indent?: number): string {
  const text = indent === undefined ? pyJsonCompact(data) : JSON.stringify(data, null, indent);
  return text.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function pyJsonCompact(data: unknown): string {
  if (Array.isArray(data)) return '[' + data.map((v) => pyJsonCompact(v)).join(', ') + ']';
  if (isMapping(data)) {
    return (
      '{' +
      Object.entries(data)
        .map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonCompact(v)}`)
        .join(', ') +
      '}'
    );
  }
  return JSON.stringify(data) ?? 'null';
}

/** Python ``time.time()``. */
function nowSeconds(): number {
  return Date.now() / 1000;
}

/** ``yaml.dump(data, default_flow_style=False, sort_keys=False, allow_unicode=True)`` */
export function dumpCatalogConfig(data: unknown): string {
  return dumpYaml(data, { sortKeys: false, defaultFlowStyle: false, allowUnicode: true });
}

// ============================================================================
// Catalog stack core (shared by workflow + step catalogs)
// ============================================================================

/** Per-family knobs for the shared catalog stack implementation. */
export interface CatalogStackSpec {
  envVar: string;
  configFileName: string;
  cachePrefix: string;
  itemsKey: string;
  label: string;
  defaultUrl: string;
  communityUrl: string;
  defaultDescription: string;
  communityDescription: string;
  allFailedMessage: string;
  noConfigMessage: string;
  catalogError: ErrorCtor;
  validationError: ErrorCtor;
  /**
   * Step catalogs parse JSON with ``object_pairs_hook=_unique_json_fields``:
   * a repeated key raises this error, which is never treated as a fetch
   * failure (no stale-cache fallback, not counted as an unreachable source).
   */
  duplicateFieldError?: new (message: string) => Error;
  /** Step catalogs reject a list-form source that repeats an ID. */
  rejectDuplicateListIds?: boolean;
  /** Cache-write warning label (``Could not safely cache <label> ...``). */
  cacheWarningLabel: string;
}

/** Python ``logging.getLogger(...).warning`` with no handlers configured (lastResort → stderr). */
export const catalogLogger: { warning: (message: string) => void } = {
  warning: (message: string) => {
    process.stderr.write(`${message}\n`);
  },
};

function isNodeOsError(exc: unknown): boolean {
  if (!(exc instanceof Error)) return false;
  const code = (exc as NodeJS.ErrnoException).code;
  return exc.name === 'OSError' || (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code));
}

/**
 * Shared implementation behind ``WorkflowCatalog`` and ``StepCatalog`` (the
 * two upstream classes are line-for-line twins; only their knobs differ).
 */
export abstract class CatalogStackCore {
  static readonly CACHE_DURATION = 3600; // 1 hour

  readonly projectRoot: string;
  cacheDir: string;
  protected abstract readonly spec: CatalogStackSpec;

  constructor(projectRoot: string, cacheDir: string) {
    this.projectRoot = projectRoot;
    this.cacheDir = cacheDir;
  }

  // -- Catalog resolution ------------------------------------------------

  /** Validate that a catalog URL uses HTTPS (localhost HTTP allowed). */
  validateCatalogUrl(url: string): void {
    const V = this.spec.validationError;
    let parsed;
    try {
      parsed = pyUrlParse(url);
    } catch {
      throw new V(`Catalog URL is malformed: ${url}`);
    }
    const hostname = parsed.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (parsed.scheme !== 'https' && !(parsed.scheme === 'http' && isLocalhost)) {
      throw new V(`Catalog URL must use HTTPS (got ${parsed.scheme}://). ` + 'HTTP is only allowed for localhost.');
    }
    if (!hostname) {
      throw new V('Catalog URL must be a valid URL with a host.');
    }
  }

  /** Load catalog stack configuration from a YAML file. */
  loadCatalogConfig(configPath: string): WorkflowCatalogEntry[] | null {
    const V = this.spec.validationError;
    if (!pathExists(configPath)) return null;
    let data: unknown;
    try {
      data = parseYaml(readFileSync(configPath, 'utf-8'));
    } catch (exc) {
      throw new V(`Failed to read catalog config ${configPath}: ${osErrorMessage(exc)}`);
    }
    const indexed = this.parseCatalogConfig(data, configPath);
    if (indexed === null) return null;
    return indexed.map(([, entry]) => entry);
  }

  /** Validate and order sources, retaining their original YAML positions (``_parse_catalog_config``). */
  protected parseCatalogConfig(data: unknown, configPath: string): Array<[number, WorkflowCatalogEntry]> | null {
    const V = this.spec.validationError;
    // Only None means "no document"; falsy non-mappings are shape errors.
    if (data === null || data === undefined) return null;
    if (!isMapping(data)) {
      throw new V('Invalid catalog config: expected a mapping, ' + `got ${pyTypeName(data)}`);
    }
    const catalogsData = data.catalogs;
    if (catalogsData === null || catalogsData === undefined) return null;
    if (!Array.isArray(catalogsData)) {
      throw new V("Invalid catalog config: 'catalogs' must be a list, " + `got ${pyTypeName(catalogsData)}`);
    }
    if (catalogsData.length === 0) {
      // Empty catalogs list (e.g. after removing last entry) is valid —
      // fall back to built-in defaults.
      return null;
    }

    const entries: Array<[number, WorkflowCatalogEntry]> = [];
    catalogsData.forEach((item, idx) => {
      if (!isMapping(item)) {
        throw new V(`Invalid catalog entry at index ${idx}: ` + `expected a mapping, got ${pyTypeName(item)}`);
      }
      const url = pyStr('url' in item ? item.url : '').trim();
      if (!url) return;
      this.validateCatalogUrl(url);
      const rawPriority = 'priority' in item ? item.priority : idx + 1;
      const nameForError = pyStr('name' in item ? item.name : idx + 1);
      if (typeof rawPriority === 'boolean') {
        throw new V(`Invalid priority for catalog ` + `'${nameForError}': ` + `expected integer, got ${pyRepr(rawPriority)}`);
      }
      const priority = pyInt(rawPriority);
      if (priority === null) {
        throw new V(`Invalid priority for catalog ` + `'${nameForError}': ` + `expected integer, got ${pyRepr(rawPriority)}`);
      }
      const rawInstall = 'install_allowed' in item ? item.install_allowed : false;
      const installAllowed =
        typeof rawInstall === 'string'
          ? ['true', 'yes', '1'].includes(rawInstall.trim().toLowerCase())
          : pyTruthy(rawInstall);
      entries.push([
        idx,
        {
          url,
          name: pyStr('name' in item ? item.name : `catalog-${idx + 1}`),
          priority,
          install_allowed: installAllowed,
          description: pyStr('description' in item ? item.description : ''),
        },
      ]);
    });
    // Stable sort by priority (Python ``list.sort`` is stable).
    entries.sort((a, b) => a[1].priority - b[1].priority);
    if (entries.length === 0) {
      throw new V(`Catalog config ${configPath} contains ${catalogsData.length} ` + 'entries but none have valid URLs.');
    }
    return entries;
  }

  /** Get the ordered list of active catalogs. */
  getActiveCatalogs(): WorkflowCatalogEntry[] {
    const envUrl = (process.env[this.spec.envVar] ?? '').trim();
    if (envUrl) {
      this.validateCatalogUrl(envUrl);
      return [
        {
          url: envUrl,
          name: 'env-override',
          priority: 1,
          install_allowed: true,
          description: `From ${this.spec.envVar}`,
        },
      ];
    }

    const projectEntries = this.loadCatalogConfig(join(this.projectRoot, '.specify', this.spec.configFileName));
    if (projectEntries !== null) return projectEntries;

    const userEntries = this.loadCatalogConfig(join(pyHome(), '.specify', this.spec.configFileName));
    if (userEntries !== null) return userEntries;

    return [
      {
        url: this.spec.defaultUrl,
        name: 'default',
        priority: 1,
        install_allowed: true,
        description: this.spec.defaultDescription,
      },
      {
        url: this.spec.communityUrl,
        name: 'community',
        priority: 2,
        install_allowed: false,
        description: this.spec.communityDescription,
      },
    ];
  }

  // -- Caching -------------------------------------------------------------

  /** Get cache file paths for a URL (hash-based). */
  getCachePaths(url: string): [string, string] {
    const urlHash = createHash('sha256').update(url, 'utf-8').digest('hex').slice(0, 16);
    return [
      join(this.cacheDir, `${this.spec.cachePrefix}-${urlHash}.json`),
      join(this.cacheDir, `${this.spec.cachePrefix}-${urlHash}-meta.json`),
    ];
  }

  /** Check if cached data for a URL is still fresh. */
  isUrlCacheValid(url: string): boolean {
    const [, metaFile] = this.getCachePaths(url);
    try {
      const meta = readCacheJson(this.projectRoot, metaFile);
      if (!isMapping(meta)) return false;
      const raw = 'fetched_at' in meta ? meta.fetched_at : 0;
      const fetchedAt = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (Number.isNaN(fetchedAt)) return false;
      return nowSeconds() - fetchedAt < CatalogStackCore.CACHE_DURATION;
    } catch {
      return false;
    }
  }

  /** Parse catalog JSON text (duplicate keys rejected for step catalogs). */
  protected parseCatalogJson(text: string): unknown {
    const D = this.spec.duplicateFieldError;
    if (D === undefined) return JSON.parse(text);
    return loadsUniqueJson(text, (key) => new D(`Duplicate field '${key}' in ${this.spec.label}.`));
  }

  private isDuplicateFieldError(exc: unknown): boolean {
    const D = this.spec.duplicateFieldError;
    return D !== undefined && exc instanceof D;
  }

  /** Read a cached catalog through the confined cache reader; null when unusable. */
  private readCachedDict(cacheFile: string): Record<string, unknown> | null {
    try {
      const cached = readCacheJson(this.projectRoot, cacheFile, { parse: (t) => this.parseCatalogJson(t) });
      return isMapping(cached) ? cached : null;
    } catch (exc) {
      if (this.isDuplicateFieldError(exc)) throw exc;
      return null;
    }
  }

  /** Fetch a single catalog, using cache when possible. */
  async fetchSingleCatalog(entry: WorkflowCatalogEntry, forceRefresh = false): Promise<Record<string, unknown>> {
    const C = this.spec.catalogError;
    const [cacheFile, metaFile] = this.getCachePaths(entry.url);

    if (!forceRefresh && this.isUrlCacheValid(entry.url)) {
      const cached = this.readCachedDict(cacheFile);
      if (cached !== null) return cached;
    }

    const validateUrl = (url: string): void => {
      let parsed;
      try {
        parsed = pyUrlParse(url);
      } catch {
        throw new C(`Refusing to fetch catalog from malformed URL: ${url}`);
      }
      const hostname = parsed.hostname;
      const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
      if (parsed.scheme !== 'https' && !(parsed.scheme === 'http' && isLocalhost)) {
        throw new C(`Refusing to fetch catalog from non-HTTPS URL: ${url}`);
      }
      if (!hostname) {
        throw new C(`Refusing to fetch catalog from URL with no hostname: ${url}`);
      }
    };

    validateUrl(entry.url);

    // Validate EVERY redirect hop, not just the final URL.
    const validateRedirect = (_oldUrl: string, newUrl: string): void => validateUrl(newUrl);

    let data: unknown;
    try {
      const resp = await httpDeps.openUrl(entry.url, { timeout: 30, redirectValidator: validateRedirect });
      validateUrl(responseUrl(resp, entry.url));
      const body = await readResponseLimited(resp, {
        maxBytes: catalogLimits.maxJsonCatalogBytes,
        errorType: C,
        label: this.spec.label,
      });
      data = this.parseCatalogJson(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch (exc) {
      if (this.isDuplicateFieldError(exc)) throw exc;
      const cached = this.readCachedDict(cacheFile);
      if (cached !== null) return cached;
      const msg = exc instanceof Error ? exc.message : String(exc);
      throw new C(`Failed to fetch catalog from ${entry.url}: ${msg}`);
    }

    if (!isMapping(data)) {
      throw new C(`Catalog from ${entry.url} is not a valid JSON object.`);
    }

    try {
      writeCacheJson(this.projectRoot, cacheFile, pyJsonDump(data, 2));
      writeCacheJson(this.projectRoot, metaFile, pyJsonDump({ url: entry.url, fetched_at: nowSeconds() }));
    } catch (exc) {
      if (!isNodeOsError(exc)) throw exc;
      catalogLogger.warning(
        `Could not safely cache ${this.spec.cacheWarningLabel} ${entry.url}: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
    return data;
  }

  /** Normalize one list-format item's id; return null to skip it. */
  protected abstract listItemId(itemData: Record<string, unknown>): string | null;

  /** Merge items from all active catalogs (lower priority number wins). */
  protected async getMergedItems(forceRefresh = false): Promise<Map<string, Record<string, unknown>>> {
    const catalogs = this.getActiveCatalogs();
    const merged = new Map<string, Record<string, unknown>>();
    let fetchErrors = 0;

    // Process later/higher-numbered entries first so earlier/lower-numbered
    // entries overwrite them on ID conflicts.
    for (const entry of [...catalogs].reverse()) {
      let data: Record<string, unknown>;
      try {
        data = await this.fetchSingleCatalog(entry, forceRefresh);
      } catch (exc) {
        if (this.isDuplicateFieldError(exc)) throw exc;
        if (exc instanceof this.spec.catalogError) {
          fetchErrors += 1;
          continue;
        }
        throw exc;
      }
      const items = this.spec.itemsKey in data ? data[this.spec.itemsKey] : {};
      if (isMapping(items)) {
        for (const [itemId, itemData] of Object.entries(items)) {
          if (!isMapping(itemData)) continue;
          itemData._catalog_name = entry.name;
          itemData._install_allowed = entry.install_allowed;
          merged.set(itemId, itemData);
        }
      } else if (Array.isArray(items)) {
        const seenInSource = new Set<string>();
        for (const itemData of items) {
          if (!isMapping(itemData)) continue;
          const itemId = this.listItemId(itemData);
          if (itemId) {
            if (this.spec.rejectDuplicateListIds) {
              if (seenInSource.has(itemId)) {
                throw new this.spec.catalogError(`Duplicate step ID '${itemId}' in catalog '${entry.name}'.`);
              }
              seenInSource.add(itemId);
            }
            itemData._catalog_name = entry.name;
            itemData._install_allowed = entry.install_allowed;
            merged.set(itemId, itemData);
          }
        }
      }
    }
    if (fetchErrors === catalogs.length && catalogs.length > 0) {
      throw new this.spec.catalogError(this.spec.allFailedMessage);
    }
    return merged;
  }

  /** Return current catalog configuration as a list of dicts. */
  getCatalogConfigs(): CatalogConfigRow[] {
    return this.getActiveCatalogs().map((e) => ({
      name: e.name,
      url: e.url,
      priority: e.priority,
      install_allowed: e.install_allowed,
      description: e.description,
    }));
  }

  private configPath(): string {
    return join(this.projectRoot, '.specify', this.spec.configFileName);
  }

  /** Add a catalog source to the project-level config. Returns ``"added"`` or ``"unchanged"``. */
  addCatalog(url: string, name: string | null = null): 'added' | 'unchanged' {
    const V = this.spec.validationError;
    url = url.trim();
    this.validateCatalogUrl(url);
    const configPath = this.configPath();
    const normalizedName = name !== null && name !== undefined ? String(name).trim() : '';

    let data: Record<string, unknown> = { catalogs: [] };
    if (pathExists(configPath)) {
      let raw: unknown;
      try {
        raw = parseYaml(readFileSync(configPath, 'utf-8'));
      } catch (exc) {
        throw new V(`Catalog config file is unreadable or malformed: ${osErrorMessage(exc)}`);
      }
      if (raw === null || raw === undefined) raw = { catalogs: [] };
      if (!isMapping(raw)) {
        throw new V('Catalog config file is corrupted (expected a mapping).');
      }
      data = raw;
    }

    const catalogs = 'catalogs' in data ? data.catalogs : [];
    if (!Array.isArray(catalogs)) {
      throw new V("Catalog config 'catalogs' must be a list.");
    }
    for (let idx = 0; idx < catalogs.length; idx++) {
      const cat = catalogs[idx];
      if (isMapping(cat) && pyStr('url' in cat ? cat.url : '').trim() === url) {
        const generatedName = `catalog-${idx + 1}`;
        const existingName = (pyTruthy(cat.name) ? pyStr(cat.name) : generatedName).trim();
        if (!normalizedName || existingName === normalizedName) {
          this.loadCatalogConfig(configPath);
          return 'unchanged';
        }
        throw new V(`Catalog URL already configured: ${url}`);
      }
    }

    // Derive priority from the highest existing priority + 1 (uncoercible -> 0).
    const coercePriority = (value: unknown): number => pyInt(value) ?? 0;
    let maxPriority = 0;
    let seen = false;
    for (const cat of catalogs) {
      if (!isMapping(cat)) continue;
      const p = coercePriority('priority' in cat ? cat.priority : 0);
      maxPriority = seen ? Math.max(maxPriority, p) : p;
      seen = true;
    }
    catalogs.push({
      name: normalizedName || `catalog-${catalogs.length + 1}`,
      url,
      priority: maxPriority + 1,
      install_allowed: true,
      description: '',
    });
    data.catalogs = catalogs;

    try {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, dumpCatalogConfig(data), 'utf-8');
    } catch (exc) {
      throw new V(`Failed to write catalog config ${configPath}: ${osErrorMessage(exc)}`);
    }
    return 'added';
  }

  /** Remove a project source by its index in the active catalog list. Returns the removed name. */
  removeCatalog(index: number): string {
    const V = this.spec.validationError;
    if ((process.env[this.spec.envVar] ?? '').trim()) {
      throw new V(
        `The active catalog comes from ${this.spec.envVar}. ` +
          'Unset that variable to remove a project catalog source.',
      );
    }
    const configPath = this.configPath();
    if (!pathExists(configPath)) throw new V(this.spec.noConfigMessage);

    let data: unknown;
    try {
      data = parseYaml(readFileSync(configPath, 'utf-8'));
    } catch (exc) {
      throw new V(`Catalog config file is unreadable or malformed: ${osErrorMessage(exc)}`);
    }
    const entries = this.parseCatalogConfig(data, configPath) ?? [];

    if (index < 0 || index >= entries.length) {
      throw new V(`Catalog index ${index} out of range (0-${entries.length - 1}).`);
    }

    const [sourceIndex, entry] = entries[index] as [number, WorkflowCatalogEntry];
    const doc = data as Record<string, unknown>;
    (doc.catalogs as unknown[]).splice(sourceIndex, 1);

    try {
      writeFileSync(configPath, dumpCatalogConfig(doc), 'utf-8');
    } catch (exc) {
      throw new V(`Failed to write catalog config ${configPath}: ${osErrorMessage(exc)}`);
    }

    return entry.name;
  }
}

// ============================================================================
// WorkflowRegistry
// ============================================================================

/** Persisted registry document. */
export interface WorkflowRegistryData {
  schema_version: string;
  workflows: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Manages the registry of installed workflows.
 *
 * Tracks installed workflows and their metadata in
 * ``.specify/workflows/workflow-registry.json``. Fails closed (throws) when
 * the registry cannot be read.
 */
export class WorkflowRegistry {
  static readonly REGISTRY_FILE = 'workflow-registry.json';
  static readonly SCHEMA_VERSION = '1.0';

  readonly projectRoot: string;
  readonly workflowsDir: string;
  readonly registryPath: string;
  data: WorkflowRegistryData;
  /** Optional read-policy handoff for workflow.list (#5115); mutations keep their behavior. */
  private readonly readFiles: FileHelper | null;

  constructor(projectRoot: string, opts: { readFiles?: FileHelper | null } = {}) {
    this.projectRoot = projectRoot;
    this.workflowsDir = join(projectRoot, '.specify', 'workflows');
    this.registryPath = join(this.workflowsDir, WorkflowRegistry.REGISTRY_FILE);
    this.readFiles = opts.readFiles ?? null;
    this.data = this.load();
  }

  /** Return true if any directory under .specify/workflows is a symlink. */
  private hasSymlinkedParent(): boolean {
    let current = this.projectRoot;
    for (const part of ['.specify', 'workflows']) {
      current = join(current, part);
      if (isSymlink(current)) return true;
    }
    return false;
  }

  private load(): WorkflowRegistryData {
    const defaultRegistry: WorkflowRegistryData = { schema_version: WorkflowRegistry.SCHEMA_VERSION, workflows: {} };
    if (this.hasSymlinkedParent() || isSymlink(this.registryPath)) {
      throw new WorkflowRegistryError(
        `Refusing to read workflow registry at ${this.registryPath}: ` +
          'a parent directory or the registry file itself is a symlink',
      );
    }
    if (this.readFiles !== null || pathExists(this.registryPath)) {
      let text: string;
      try {
        if (this.readFiles === null) {
          text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(this.registryPath));
        } else {
          try {
            text = this.readFiles.readText(this.registryPath);
          } catch (exc) {
            if (isErrno(exc, 'ENOENT')) return defaultRegistry;
            if (exc instanceof FileHelperError) throw Object.assign(new Error(exc.message), { code: 'EPOLICY' });
            throw exc;
          }
          // Match the legacy text stream's universal-newline handling.
          text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        }
      } catch (exc) {
        if (exc instanceof TypeError) {
          throw new WorkflowRegistryError(`Workflow registry at ${this.registryPath} is corrupted: ` + `${exc.message}`);
        }
        throw new WorkflowRegistryError(`Failed to read workflow registry at ${this.registryPath}: ${osErrorMessage(exc)}`);
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (exc) {
        throw new WorkflowRegistryError(
          `Workflow registry at ${this.registryPath} is corrupted: ` + `${exc instanceof Error ? exc.message : String(exc)}`,
        );
      }
      if (!isMapping(data)) {
        throw new WorkflowRegistryError(
          `Workflow registry at ${this.registryPath} is corrupted: ` + 'top-level value must be an object',
        );
      }
      if (!isMapping(data.workflows)) {
        throw new WorkflowRegistryError(
          `Workflow registry at ${this.registryPath} is corrupted: ` + "'workflows' must be an object",
        );
      }
      return data as WorkflowRegistryData;
    }
    return defaultRegistry;
  }

  /** Persist registry to disk atomically. */
  save(): void {
    if (this.hasSymlinkedParent() || isSymlink(this.registryPath)) {
      throw new WorkflowRegistryError('Refusing to write workflow registry through a symlinked path.');
    }
    mkdirSync(this.workflowsDir, { recursive: true });
    // Unique, exclusive temp then replace.
    const tmp = join(dirname(this.registryPath), `.${basename(this.registryPath)}.${randomBytes(6).toString('hex')}.tmp`);
    let fd = openSync(tmp, 'wx', 0o600);
    try {
      const payload = Buffer.from(pyJsonDump(this.data, 2), 'utf-8');
      let off = 0;
      while (off < payload.length) off += writeSync(fd, payload, off);
      // Preserve an existing registry's mode/ownership (best-effort).
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
        // best-effort
      }
      const stagedStat = lstatSync(tmp);
      const openStat = fstatSync(fd);
      if (!stagedStat.isFile() || stagedStat.dev !== openStat.dev || stagedStat.ino !== openStat.ino) {
        throw new WorkflowRegistryError('Refusing to replace workflow registry: ' + 'staged file changed before commit');
      }
      closeSync(fd);
      fd = -1;
      renameSync(tmp, this.registryPath);
    } catch (exc) {
      if (fd >= 0) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        // ignore
      }
      throw exc;
    }
  }

  /** Add or update an installed workflow entry. */
  add(workflowId: string, metadata: Record<string, unknown>): void {
    const workflows = this.data.workflows;
    const rawExisting = workflows[workflowId];
    const hadEntry = Object.prototype.hasOwnProperty.call(workflows, workflowId);
    const existing = isMapping(rawExisting) ? rawExisting : {};
    metadata.installed_at = 'installed_at' in existing ? existing.installed_at : utcIsoNow();
    metadata.updated_at = utcIsoNow();
    workflows[workflowId] = metadata;
    try {
      this.save();
    } catch (exc) {
      // Roll back the in-memory mutation.
      if (hadEntry) workflows[workflowId] = rawExisting;
      else delete workflows[workflowId];
      throw exc;
    }
  }

  /** Remove an installed workflow entry. Returns true if found. */
  remove(workflowId: string): boolean {
    const workflows = this.data.workflows;
    if (Object.prototype.hasOwnProperty.call(workflows, workflowId)) {
      const removedEntry = workflows[workflowId];
      delete workflows[workflowId];
      try {
        this.save();
      } catch (exc) {
        workflows[workflowId] = removedEntry;
        throw exc;
      }
      return true;
    }
    return false;
  }

  /** Get metadata for an installed workflow. */
  get(workflowId: string): unknown {
    return Object.prototype.hasOwnProperty.call(this.data.workflows, workflowId) ? this.data.workflows[workflowId] : null;
  }

  /** Return all installed workflows. */
  list(): Record<string, unknown> {
    return { ...this.data.workflows };
  }

  /** Check if a workflow is installed. */
  isInstalled(workflowId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.data.workflows, workflowId);
  }
}

// ============================================================================
// WorkflowCatalog
// ============================================================================

/**
 * Manages workflow catalog fetching, caching, and searching.
 *
 * Resolution order for catalog sources:
 * 1. ``SPECKIT_WORKFLOW_CATALOG_URL`` env var (overrides all)
 * 2. Project-level ``.specify/workflow-catalogs.yml``
 * 3. User-level ``~/.specify/workflow-catalogs.yml``
 * 4. Built-in defaults (official + community)
 */
export class WorkflowCatalog extends CatalogStackCore {
  static readonly DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/github/spec-kit/main/' + 'workflows/catalog.json';
  static readonly COMMUNITY_CATALOG_URL =
    'https://raw.githubusercontent.com/github/spec-kit/main/' + 'workflows/catalog.community.json';

  readonly workflowsDir: string;

  protected readonly spec: CatalogStackSpec = {
    envVar: 'SPECKIT_WORKFLOW_CATALOG_URL',
    configFileName: 'workflow-catalogs.yml',
    cachePrefix: 'workflow-catalog',
    itemsKey: 'workflows',
    label: 'workflow catalog',
    defaultUrl: WorkflowCatalog.DEFAULT_CATALOG_URL,
    communityUrl: WorkflowCatalog.COMMUNITY_CATALOG_URL,
    defaultDescription: 'Official workflows',
    communityDescription: 'Community-contributed workflows (discovery only)',
    allFailedMessage: 'All configured catalogs failed to fetch.',
    noConfigMessage: 'No catalog config file found.',
    catalogError: WorkflowCatalogError,
    validationError: WorkflowValidationError,
    cacheWarningLabel: 'workflow catalog',
  };

  constructor(projectRoot: string) {
    const workflowsDir = join(projectRoot, '.specify', 'workflows');
    super(projectRoot, join(workflowsDir, '.cache'));
    this.workflowsDir = workflowsDir;
  }

  protected listItemId(itemData: Record<string, unknown>): string | null {
    const id = 'id' in itemData ? itemData.id : '';
    return pyTruthy(id) ? (id as string) : null;
  }

  /** Merge workflows from all active catalogs (lower priority number wins). */
  getMergedWorkflows(forceRefresh = false): Promise<Map<string, Record<string, unknown>>> {
    return this.getMergedItems(forceRefresh);
  }

  /** Search workflows across all configured catalogs. */
  async search(
    opts: { query?: string | null; tag?: string | null; author?: string | null } = {},
  ): Promise<Record<string, unknown>[]> {
    const { query, tag, author } = opts;
    const merged = await this.getMergedWorkflows();
    const results: Record<string, unknown>[] = [];

    for (const [wfId, wfData] of merged) {
      if (!('id' in wfData)) wfData.id = wfId;
      if (query) {
        const q = query.toLowerCase();
        const searchable = [wfData.name, wfData.description, wfData.id]
          .map((v) => (pyTruthy(v) ? pyStr(v) : ''))
          .join(' ')
          .toLowerCase();
        if (!searchable.includes(q)) continue;
      }
      if (tag) {
        const rawTags = 'tags' in wfData ? wfData.tags : [];
        const tags = Array.isArray(rawTags) ? rawTags : [];
        const normalizedTags = tags.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
        if (!normalizedTags.includes(tag.toLowerCase())) continue;
      }
      if (author) {
        const wfAuthor = 'author' in wfData ? wfData.author : '';
        if (typeof wfAuthor !== 'string' || wfAuthor.toLowerCase() !== author.toLowerCase()) continue;
      }
      results.push(wfData);
    }
    return results;
  }

  /** Get the current or an exact advertised release from the winning source. */
  async getWorkflowInfo(workflowId: string, version: string | null = null): Promise<Record<string, unknown> | null> {
    const merged = await this.getMergedWorkflows();
    const wf = merged.get(workflowId);
    if (wf === undefined) return null;
    if (!('id' in wf)) wf.id = workflowId;
    return selectRelease(wf, version);
  }

  /** List versions advertised by the winning catalog entry. */
  async getWorkflowVersions(workflowId: string): Promise<string[]> {
    const details = await this.getWorkflowVersionDetails(workflowId);
    return details !== null ? details[0] : [];
  }

  /** Return advertised versions and whether their source allows installation. */
  async getWorkflowVersionDetails(workflowId: string): Promise<[string[], boolean] | null> {
    const merged = await this.getMergedWorkflows();
    const wf = merged.get(workflowId);
    if (wf === undefined) return null;
    if (!('id' in wf)) wf.id = workflowId;
    return [availableVersions(wf), pyTruthy('_install_allowed' in wf ? wf._install_allowed : true)];
  }
}
