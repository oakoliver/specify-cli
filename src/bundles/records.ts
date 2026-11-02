/**
 * @oakoliver/specify-cli - Installed-bundle records
 *
 * Requirements and ownership for list/remove/update. Records are stored as
 * JSON at ``.specify/bundle-records.json``. Each record stores every required
 * component for conflict detection and separately records which components
 * the bundle contributed, so removal never touches independently installed
 * components (FR-022, SC-004). Known installed versions are stored separately
 * from requested pins to make patch substitutions visible without changing
 * bundle ownership or manifest identity.
 *
 * Port of ``specify_cli/bundles/records.py``.
 *
 * @module bundles/records
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { BundlerError } from './index.js';
import { dumpJson, ensureWithin, loadJson } from './yamlio.js';
import { BundleRef, COMPONENT_KINDS, ComponentRef, pyInt, text } from './manifest.js';
import { dget, isMapping, pyRepr, pyStr, pyTruthy } from './pycompat.js';

export const RECORDS_FILENAME = 'bundle-records.json';
export const RECORDS_SCHEMA_VERSION = '1.0';

// ============================================================================
// InstalledBundleRecord
// ============================================================================

export interface InstalledBundleRecordDict {
  bundle_id: string;
  version: string;
  installed_at: string;
  contributed_components: Array<Record<string, unknown>>;
  required_components: Array<Record<string, unknown>>;
  installed_versions?: Record<string, string>;
  bundle_references?: Array<Record<string, unknown>>;
}

export class InstalledBundleRecord {
  readonly bundle_id: string;
  readonly version: string;
  readonly contributed_components: readonly ComponentRef[];
  readonly required_components: readonly ComponentRef[];
  readonly installed_at: string;
  readonly installed_versions: Readonly<Record<string, string>>;
  readonly bundle_references: readonly BundleRef[];

  constructor(init: {
    bundle_id: string;
    version: string;
    contributed_components: readonly ComponentRef[];
    required_components?: readonly ComponentRef[];
    installed_at: string;
    installed_versions?: Record<string, string>;
    bundle_references?: readonly BundleRef[];
  }) {
    this.bundle_id = init.bundle_id;
    this.version = init.version;
    this.contributed_components = Object.freeze([...init.contributed_components]);
    // ADAPTATION: Python's dataclass makes this field required; defaulting to
    // the contributed components keeps older direct constructions valid.
    this.required_components = Object.freeze([...(init.required_components ?? init.contributed_components)]);
    this.installed_at = init.installed_at;
    this.installed_versions = Object.freeze({ ...(init.installed_versions ?? {}) });
    this.bundle_references = Object.freeze([...(init.bundle_references ?? [])]);
    Object.freeze(this);
  }

  static create(
    bundleId: string,
    version: string,
    components: ComponentRef[],
    installedAt: string | null = null,
    opts: {
      requiredComponents?: ComponentRef[] | null;
      installedVersions?: Record<string, string> | null;
      bundleReferences?: BundleRef[] | null;
    } = {},
  ): InstalledBundleRecord {
    return new InstalledBundleRecord({
      bundle_id: bundleId,
      version,
      contributed_components: components,
      required_components: opts.requiredComponents ?? components,
      installed_at: installedAt || utcNow(),
      installed_versions: opts.installedVersions ?? {},
      bundle_references: opts.bundleReferences ?? [],
    });
  }

  /** ``dataclasses.replace``. */
  replace(changes: {
    contributed_components?: readonly ComponentRef[];
    required_components?: readonly ComponentRef[];
    installed_versions?: Record<string, string>;
    bundle_references?: readonly BundleRef[];
    version?: string;
    installed_at?: string;
  }): InstalledBundleRecord {
    return new InstalledBundleRecord({
      bundle_id: this.bundle_id,
      version: changes.version ?? this.version,
      contributed_components: changes.contributed_components ?? this.contributed_components,
      required_components: changes.required_components ?? this.required_components,
      installed_at: changes.installed_at ?? this.installed_at,
      installed_versions: changes.installed_versions ?? { ...this.installed_versions },
      bundle_references: changes.bundle_references ?? this.bundle_references,
    });
  }

  toDict(): InstalledBundleRecordDict {
    const data: InstalledBundleRecordDict = {
      bundle_id: this.bundle_id,
      version: this.version,
      installed_at: this.installed_at,
      contributed_components: this.contributed_components.map(componentToDict),
      required_components: this.required_components.map(componentToDict),
    };
    if (Object.keys(this.installed_versions).length) data.installed_versions = { ...this.installed_versions };
    if (this.bundle_references.length) data.bundle_references = this.bundle_references.map(bundleReferenceToDict);
    return data;
  }

  static fromDict(data: unknown): InstalledBundleRecord {
    if (!isMapping(data)) {
      throw new BundlerError('Each installed-bundle record must be a mapping.');
    }
    let componentsRaw = dget(data, 'contributed_components');
    if (componentsRaw === undefined || componentsRaw === null) {
      componentsRaw = [];
    } else if (!Array.isArray(componentsRaw)) {
      throw new BundlerError("Corrupt record: 'contributed_components' must be a list.");
    }
    // Older records contain only contributed components. Retain those known
    // pins until a successful reinstall writes the full requirements.
    const requiredRaw = Object.prototype.hasOwnProperty.call(data, 'required_components')
      ? dget(data, 'required_components')
      : componentsRaw;
    if (!Array.isArray(requiredRaw)) {
      throw new BundlerError("Corrupt record: 'required_components' must be a list.");
    }
    // An explicit null is treated as missing (not the literal "None").
    const bundleId = text(dget(data, 'bundle_id'));
    const version = text(dget(data, 'version'));
    if (!bundleId) {
      throw new BundlerError(
        "Corrupt records file: an installed-bundle record is missing its 'bundle_id'.",
      );
    }
    if (!version) {
      throw new BundlerError(
        `Corrupt records file: record for bundle '${bundleId}' is missing its 'version'.`,
      );
    }
    const contributed = (componentsRaw as unknown[]).map((c) => componentFromDict(c));
    const required = (requiredRaw as unknown[]).map((c) => componentFromDict(c, 'required'));
    const requiredIds = new Set(required.map((c) => c.identity()));
    if (!contributed.every((c) => requiredIds.has(c.identity()))) {
      throw new BundlerError(
        "Corrupt record: 'required_components' must include all 'contributed_components'.",
      );
    }
    const installedVersions = Object.prototype.hasOwnProperty.call(data, 'installed_versions')
      ? dget(data, 'installed_versions')
      : {};
    if (!isMapping(installedVersions)) {
      throw new BundlerError("Corrupt record: 'installed_versions' must be a mapping.");
    }
    const bundleReferencesRaw = dget(data, 'bundle_references');
    let bundleReferences: BundleRef[];
    if (bundleReferencesRaw === undefined || bundleReferencesRaw === null) {
      bundleReferences = [];
    } else if (!Array.isArray(bundleReferencesRaw)) {
      throw new BundlerError("Corrupt record: 'bundle_references' must be a list.");
    } else {
      bundleReferences = bundleReferencesRaw.map(bundleReferenceFromDict);
    }
    const keys = new Set(required.map((c) => `${c.kind}:${c.id}`));
    for (const [key, actual] of Object.entries(installedVersions)) {
      if (!keys.has(key) || typeof actual !== 'string' || !actual.trim()) {
        throw new BundlerError(
          "Corrupt record: 'installed_versions' must map required component keys (kind:id) to non-empty version strings.",
        );
      }
    }
    return new InstalledBundleRecord({
      bundle_id: bundleId,
      version,
      installed_at: text(dget(data, 'installed_at')),
      contributed_components: contributed,
      required_components: required,
      installed_versions: { ...(installedVersions as Record<string, string>) },
      bundle_references: bundleReferences,
    });
  }
}

// ============================================================================
// Persistence
// ============================================================================

export function recordsPath(projectRoot: string): string {
  return path.join(projectRoot, '.specify', RECORDS_FILENAME);
}

/**
 * Reject a records file whose schema version we cannot safely parse.
 * Forward-compatible minor bumps that keep the same major version are accepted.
 */
function checkSchemaVersion(value: unknown, opts: { path: string; required: boolean }): void {
  if (value === undefined || value === null) {
    if (opts.required) {
      throw new BundlerError(
        `Corrupt records file: ${opts.path} — missing 'schema_version'. ` +
          `Expected version ${RECORDS_SCHEMA_VERSION}.`,
      );
    }
    return;
  }
  const seen = pyStr(value).trim();
  if (seen.split('.')[0] !== RECORDS_SCHEMA_VERSION.split('.')[0]) {
    throw new BundlerError(
      `Unsupported records schema version '${seen}' at ${opts.path}; this ` +
        `Spec Kit understands version ${RECORDS_SCHEMA_VERSION}. The file may ` +
        'have been written by a newer version or is corrupt.',
    );
  }
}

export function loadRecords(projectRoot: string): InstalledBundleRecord[] {
  // Defense in depth: refuse to read through a symlinked or traversal-escaping
  // ``.specify`` that resolves outside project_root.
  const p = ensureWithin(projectRoot, recordsPath(projectRoot));
  if (!existsSync(p)) return [];
  const data = loadJson(p);
  if (!isMapping(data)) throw new BundlerError(`Corrupt records file: ${p}`);
  checkSchemaVersion(dget(data, 'schema_version'), { path: p, required: true });
  let bundles = dget(data, 'bundles');
  if (bundles === undefined || bundles === null) {
    bundles = [];
  } else if (!Array.isArray(bundles)) {
    throw new BundlerError(`Corrupt records file: ${p} — 'bundles' must be a list.`);
  }
  return (bundles as unknown[]).map((item) => InstalledBundleRecord.fromDict(item));
}

export function saveRecords(projectRoot: string, records: InstalledBundleRecord[]): void {
  const payload = {
    schema_version: RECORDS_SCHEMA_VERSION,
    updated_at: utcNow(),
    bundles: records.map((r) => r.toDict()),
  };
  dumpJson(recordsPath(projectRoot), payload, { within: projectRoot });
}

export function findRecord(records: InstalledBundleRecord[], bundleId: string): InstalledBundleRecord | null {
  return records.find((r) => r.bundle_id === bundleId) ?? null;
}

/** Return a new list with *record* replacing any same-id record (append otherwise). */
export function upsertRecord(
  records: InstalledBundleRecord[],
  record: InstalledBundleRecord,
): InstalledBundleRecord[] {
  const updated = records.filter((r) => r.bundle_id !== record.bundle_id);
  updated.push(record);
  return updated;
}

export function removeRecord(records: InstalledBundleRecord[], bundleId: string): InstalledBundleRecord[] {
  return records.filter((r) => r.bundle_id !== bundleId);
}

/** Keep a bundle-installed component attributed while another bundle needs it. */
export function transferContributions(
  records: InstalledBundleRecord[],
  released: readonly ComponentRef[],
): InstalledBundleRecord[] {
  const updated = [...records];
  const owned = new Set<string>();
  for (const record of updated) {
    for (const component of record.contributed_components) owned.add(componentKey(component.kind, component.id));
  }
  for (const component of released) {
    const key = componentKey(component.kind, component.id);
    if (owned.has(key)) continue;
    for (let index = 0; index < updated.length; index++) {
      const record = updated[index];
      const required = record.required_components.find((ref) => componentKey(ref.kind, ref.id) === key);
      if (required !== undefined) {
        updated[index] = record.replace({
          contributed_components: [...record.contributed_components, required],
        });
        owned.add(key);
        break;
      }
    }
  }
  return updated;
}

/** ``(kind, id)`` key used by the set helpers below. */
export function componentKey(kind: string, id: string): string {
  return JSON.stringify([kind, id]);
}

/** Set of ``(kind, id)`` component keys required by bundles other than the excluded one. */
export function componentsStillNeeded(records: InstalledBundleRecord[], excludeBundleId: string): Set<string> {
  const needed = new Set<string>();
  for (const record of records) {
    if (record.bundle_id === excludeBundleId) continue;
    for (const component of record.required_components) {
      needed.add(componentKey(component.kind, component.id));
    }
  }
  return needed;
}

// ============================================================================
// Component (de)serialization
// ============================================================================

function componentToDict(ref: ComponentRef): Record<string, unknown> {
  const data: Record<string, unknown> = { kind: ref.kind, id: ref.id };
  if (ref.version !== null) data.version = ref.version;
  if (ref.source !== null) data.source = ref.source;
  if (ref.priority !== null) data.priority = ref.priority;
  if (ref.strategy !== null) data.strategy = ref.strategy;
  return data;
}

function bundleReferenceToDict(reference: BundleRef): Record<string, unknown> {
  return { id: reference.id, version: reference.version, source: reference.source };
}

function bundleReferenceFromDict(data: unknown): BundleRef {
  if (!isMapping(data)) {
    throw new BundlerError("Corrupt record: 'bundle_references' entries must be mappings.");
  }
  const bundleId = dget(data, 'id');
  const version = dget(data, 'version');
  if (typeof bundleId !== 'string' || !bundleId.trim() || typeof version !== 'string' || !version.trim()) {
    throw new BundlerError(
      "Corrupt record: 'bundle_references' entries must have non-empty string 'id' and 'version'.",
    );
  }
  let source = dget(data, 'source');
  if (source === '') {
    source = null;
  } else if (source !== undefined && source !== null && typeof source !== 'string') {
    throw new BundlerError("Corrupt record: 'bundle_references' entry 'source' must be a string.");
  }
  return new BundleRef({ id: bundleId, version, source: (source as string | null | undefined) ?? null });
}

function componentFromDict(data: unknown, label = 'contributed'): ComponentRef {
  if (!isMapping(data)) {
    throw new BundlerError(`Each ${label} component must be a mapping.`);
  }
  const kind = text(dget(data, 'kind'));
  const cid = text(dget(data, 'id'));
  if (!(COMPONENT_KINDS as readonly string[]).includes(kind)) {
    throw new BundlerError(
      `Corrupt records file: component 'kind' must be one of ` +
        `${pyRepr([...COMPONENT_KINDS])}, got ${pyRepr(kind || '<missing>')}.`,
    );
  }
  if (!cid) {
    throw new BundlerError(`Corrupt records file: a ${label} component is missing its 'id'.`);
  }
  const opt = (key: string): string | null => {
    const value = dget(data, key);
    return pyTruthy(value) ? pyStr(value) : null;
  };
  return new ComponentRef({
    kind,
    id: cid,
    version: opt('version'),
    source: opt('source'),
    priority: parsePriority(dget(data, 'priority')),
    strategy: opt('strategy'),
  });
}

function parsePriority(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'boolean' || (typeof raw !== 'number' && typeof raw !== 'string')) {
    throw new BundlerError(`Component priority must be an integer, got ${pyRepr(raw)}.`);
  }
  const value = pyInt(raw);
  if (value === null) {
    throw new BundlerError(`Component priority must be an integer, got ${pyRepr(raw)}.`);
  }
  return value;
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
