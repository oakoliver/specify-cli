/**
 * @oakoliver/specify-cli - Bundle catalog models
 *
 * Catalog models: source stack (priority + install policy) and catalog
 * entries. The stack precedence is project > user > built-in; install is
 * permitted only from ``install-allowed`` sources.
 *
 * Port of ``specify_cli/bundles/catalogs.py``.
 *
 * @module bundles/catalogs
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { BundlerError } from './index.js';
import { ensureWithin, loadYaml } from './yamlio.js';
import { pyInt } from './manifest.js';
import { dget, isMapping, pyRepr, pyStr, pyTruthy, pyTypeName } from './pycompat.js';

export const CONFIG_FILENAME = 'bundle-catalogs.yml';
/** Supported bundle-catalogs.yml schema (major version). */
export const CONFIG_SCHEMA_VERSION = '1.0';
export const CATALOG_SCHEMA_VERSION = '1.0';

// ============================================================================
// Enums
// ============================================================================

export const InstallPolicy = {
  INSTALL_ALLOWED: 'install-allowed',
  DISCOVERY_ONLY: 'discovery-only',
} as const;
export type InstallPolicy = (typeof InstallPolicy)[keyof typeof InstallPolicy];

const INSTALL_POLICY_VALUES: InstallPolicy[] = [InstallPolicy.INSTALL_ALLOWED, InstallPolicy.DISCOVERY_ONLY];

/** ``InstallPolicy.parse``. */
export function parseInstallPolicy(value: unknown): InstallPolicy {
  const t = pyStr(pyTruthy(value) ? value : '').trim();
  for (const policy of INSTALL_POLICY_VALUES) {
    if (policy === t) return policy;
  }
  throw new BundlerError(
    `Invalid install_policy '${pyStr(value ?? null)}' (must be one of ${pyRepr(INSTALL_POLICY_VALUES)}).`,
  );
}

export const Scope = {
  PROJECT: 'project',
  USER: 'user',
  BUILTIN: 'built-in',
} as const;
export type Scope = (typeof Scope)[keyof typeof Scope];

/** Built-in default stack (used when no project/user config overrides it). */
export const BUILTIN_DEFAULT_STACK: ReadonlyArray<Readonly<Record<string, unknown>>> = Object.freeze([
  { id: 'default', url: 'builtin://default', priority: 1, install_policy: InstallPolicy.INSTALL_ALLOWED },
  { id: 'community', url: 'builtin://community', priority: 20, install_policy: InstallPolicy.DISCOVERY_ONLY },
]);

// ============================================================================
// CatalogSource
// ============================================================================

export class CatalogSource {
  readonly id: string;
  readonly url: string;
  readonly priority: number;
  readonly install_policy: InstallPolicy;
  readonly scope: Scope;

  constructor(init: { id: string; url: string; priority: number; install_policy: InstallPolicy; scope?: Scope }) {
    this.id = init.id;
    this.url = init.url;
    this.priority = init.priority;
    this.install_policy = init.install_policy;
    this.scope = init.scope ?? Scope.PROJECT;
    Object.freeze(this);
  }

  get installAllowed(): boolean {
    return this.install_policy === InstallPolicy.INSTALL_ALLOWED;
  }

  static fromDict(data: unknown, scope: Scope): CatalogSource {
    if (!isMapping(data)) throw new BundlerError('Each catalog source must be a mapping.');
    const sourceId = pyStr(dget(data, 'id') ?? '').trim();
    const url = pyStr(dget(data, 'url') ?? '').trim();
    if (!sourceId) throw new BundlerError("A catalog source is missing its 'id'.");
    if (!url) throw new BundlerError(`Catalog source '${sourceId}' is missing its 'url'.`);
    const priority = dget(data, 'priority');
    if (priority === undefined || priority === null) {
      throw new BundlerError(`Catalog source '${sourceId}' is missing its 'priority'.`);
    }
    if (typeof priority === 'boolean' || (typeof priority !== 'number' && typeof priority !== 'string')) {
      throw new BundlerError(`Catalog source '${sourceId}' has a non-integer priority: ${pyRepr(priority)}.`);
    }
    const priorityInt = pyInt(priority);
    if (priorityInt === null) {
      throw new BundlerError(`Catalog source '${sourceId}' has a non-integer priority: ${pyRepr(priority)}.`);
    }
    return new CatalogSource({
      id: sourceId,
      url,
      priority: priorityInt,
      install_policy: parseInstallPolicy(dget(data, 'install_policy')),
      scope,
    });
  }

  toDict(): { id: string; url: string; priority: number; install_policy: InstallPolicy } {
    return { id: this.id, url: this.url, priority: this.priority, install_policy: this.install_policy };
  }
}

// ============================================================================
// CatalogEntry
// ============================================================================

/**
 * Parse a catalog entry's ``tags``. Catalogs are untrusted input: reject
 * anything that is not a list, and reject any non-string member.
 */
function parseTags(value: unknown, entryId: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new BundlerError(`Catalog entry '${entryId}': 'tags' must be a list of strings.`);
  }
  return Object.freeze([...(value as string[])]);
}

/** Validate a catalog entry's ``verified`` flag is a real boolean. */
function parseVerified(value: unknown, entryId: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new BundlerError(`Catalog entry '${entryId}': 'verified' must be a boolean (true/false).`);
}

export interface CatalogEntryInit {
  id: string;
  name: string;
  version: string;
  role: string;
  description: string;
  author: string;
  license: string;
  download_url: string;
  requires_speckit_version: string;
  sha256?: string | null;
  provides?: Record<string, unknown>;
  repository?: string | null;
  tags?: readonly string[];
  verified?: boolean;
  source_id?: string | null;
  source_policy?: InstallPolicy | null;
}

export class CatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly role: string;
  readonly description: string;
  readonly author: string;
  readonly license: string;
  readonly download_url: string;
  readonly requires_speckit_version: string;
  readonly sha256: string | null;
  readonly provides: Record<string, unknown>;
  readonly repository: string | null;
  readonly tags: readonly string[];
  readonly verified: boolean;
  // Resolution provenance (filled in by the catalog stack at lookup time):
  readonly source_id: string | null;
  readonly source_policy: InstallPolicy | null;

  constructor(init: CatalogEntryInit) {
    this.id = init.id;
    this.name = init.name;
    this.version = init.version;
    this.role = init.role;
    this.description = init.description;
    this.author = init.author;
    this.license = init.license;
    this.download_url = init.download_url;
    this.requires_speckit_version = init.requires_speckit_version;
    this.sha256 = init.sha256 ?? null;
    this.provides = init.provides ?? {};
    this.repository = init.repository ?? null;
    this.tags = init.tags ?? [];
    this.verified = init.verified ?? false;
    this.source_id = init.source_id ?? null;
    this.source_policy = init.source_policy ?? null;
    Object.freeze(this);
  }

  static fromDict(data: unknown): CatalogEntry {
    if (!isMapping(data)) throw new BundlerError('Each catalog entry must be a mapping.');
    const s = (key: string): string => pyStr(dget(data, key) ?? '').trim();
    const entryId = s('id');
    let requires = dget(data, 'requires');
    if (requires === undefined || requires === null) {
      requires = {};
    } else if (!isMapping(requires)) {
      throw new BundlerError(
        `Catalog entry '${entryId || '<unknown>'}': 'requires' must be a mapping when present.`,
      );
    }
    let providesRaw = dget(data, 'provides');
    if (providesRaw === undefined || providesRaw === null) {
      providesRaw = {};
    } else if (!isMapping(providesRaw)) {
      throw new BundlerError(
        `Catalog entry '${entryId || '<unknown>'}': 'provides' must be a mapping when present.`,
      );
    }
    const sha = dget(data, 'sha256');
    const repo = dget(data, 'repository');
    const verified = dget(data, 'verified');
    return new CatalogEntry({
      id: entryId,
      name: s('name'),
      version: s('version'),
      role: s('role'),
      description: s('description'),
      author: s('author'),
      license: s('license'),
      download_url: s('download_url'),
      requires_speckit_version: pyStr(dget(requires as Record<string, unknown>, 'speckit_version') ?? '').trim(),
      sha256: sha === undefined || sha === null ? null : pyStr(sha).trim(),
      provides: { ...(providesRaw as Record<string, unknown>) },
      repository: pyTruthy(repo) ? pyStr(repo) : null,
      tags: parseTags(dget(data, 'tags'), entryId),
      verified: parseVerified(verified === undefined ? false : verified, entryId),
    });
  }

  withProvenance(source: CatalogSource): CatalogEntry {
    return new CatalogEntry({ ...this, source_id: source.id, source_policy: source.install_policy });
  }
}

// ============================================================================
// Payload / stack loading
// ============================================================================

/** Parse a catalog JSON payload into ``{bundle_id: CatalogEntry}``. */
export function loadCatalogPayload(data: unknown): Map<string, CatalogEntry> {
  if (!isMapping(data)) throw new BundlerError('Catalog payload must be a JSON object.');
  const schemaVersion = dget(data, 'schema_version');
  if (
    schemaVersion !== undefined &&
    schemaVersion !== null &&
    pyStr(schemaVersion).trim().split('.')[0] !== CATALOG_SCHEMA_VERSION.split('.')[0]
  ) {
    throw new BundlerError(
      `Unsupported catalog schema version '${pyStr(schemaVersion).trim()}'; this Spec Kit understands ` +
        `version ${CATALOG_SCHEMA_VERSION}.`,
    );
  }
  const bundlesRaw = dget(data, 'bundles');
  if (!isMapping(bundlesRaw)) throw new BundlerError("Catalog payload is missing a 'bundles' object.");
  const entries = new Map<string, CatalogEntry>();
  for (const [bundleId, entryRaw] of Object.entries(bundlesRaw)) {
    const key = String(bundleId);
    const entry = CatalogEntry.fromDict(entryRaw);
    // The enclosing key is the authoritative bundle id.
    if (!entry.id) throw new BundlerError(`Catalog entry for '${key}' is missing its 'id' field.`);
    if (entry.id !== key) {
      throw new BundlerError(`Catalog entry id mismatch: key '${key}' != entry id '${entry.id}'.`);
    }
    entries.set(key, entry);
  }
  return entries;
}

/** Sort sources by ``(priority, id)``. */
export function sortSources(sources: Iterable<CatalogSource>): CatalogSource[] {
  return [...sources].sort((a, b) =>
    a.priority !== b.priority ? a.priority - b.priority : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/**
 * Build the effective, priority-sorted source stack (project > user >
 * built-in). A source id present at a higher-precedence scope overrides the
 * same id at a lower scope.
 */
export function loadSourceStack(projectRoot: string, userConfigDir: string | null = null): CatalogSource[] {
  const byId = new Map<string, CatalogSource>();

  for (const raw of BUILTIN_DEFAULT_STACK) {
    const src = CatalogSource.fromDict(raw, Scope.BUILTIN);
    byId.set(src.id, src);
  }

  if (userConfigDir !== null && userConfigDir !== undefined) {
    mergeConfig(byId, path.join(userConfigDir, CONFIG_FILENAME), Scope.USER);
  }

  // Confine the project-scoped read: refuse a symlinked .specify/ that
  // resolves outside the project root.
  const projectConfig = path.join(projectRoot, '.specify', CONFIG_FILENAME);
  if (existsSync(projectConfig)) ensureWithin(projectRoot, projectConfig);
  mergeConfig(byId, projectConfig, Scope.PROJECT);

  return sortSources(byId.values());
}

function mergeConfig(byId: Map<string, CatalogSource>, configPath: string, scope: Scope): void {
  if (!existsSync(configPath)) return;
  const data = loadYaml(configPath);
  if (!isMapping(data)) {
    throw new BundlerError(
      `Malformed catalog config at ${configPath}: expected a mapping at ` +
        `the top level, got ${pyTypeName(data)}.`,
    );
  }
  const schemaVersion = dget(data, 'schema_version');
  if (
    schemaVersion !== undefined &&
    schemaVersion !== null &&
    pyStr(schemaVersion).trim().split('.')[0] !== CONFIG_SCHEMA_VERSION.split('.')[0]
  ) {
    throw new BundlerError(
      `Unsupported catalog config schema version ` +
        `'${pyStr(schemaVersion).trim()}' at ${configPath}; this Spec Kit ` +
        `understands version ${CONFIG_SCHEMA_VERSION}. The file may have been ` +
        'written by a newer version or is corrupt.',
    );
  }
  const catalogs = dget(data, 'catalogs');
  if (catalogs === undefined || catalogs === null) return;
  if (!Array.isArray(catalogs)) {
    throw new BundlerError(
      `Malformed catalog config at ${configPath}: 'catalogs' must be a ` + `list, got ${pyTypeName(catalogs)}.`,
    );
  }
  for (const raw of catalogs) {
    const src = CatalogSource.fromDict(raw, scope);
    byId.set(src.id, src);
  }
}
