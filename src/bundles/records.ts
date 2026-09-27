/**
 * @oakoliver/specify-cli - Installed-bundle records
 *
 * Provenance for precise list/remove/update. Records are stored as JSON at
 * ``.specify/bundle-records.json``. Each record captures exactly which
 * components a bundle contributed so removal touches only that bundle's
 * components and never collateral (FR-022, SC-004).
 *
 * Port of ``specify_cli/bundles/records.py``.
 *
 * @module bundles/records
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { BundlerError } from './index.js';
import { dumpJson, ensureWithin, loadJson } from './yamlio.js';
import { COMPONENT_KINDS, ComponentRef, pyInt, text } from './manifest.js';
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
}

export class InstalledBundleRecord {
  readonly bundle_id: string;
  readonly version: string;
  readonly contributed_components: readonly ComponentRef[];
  readonly installed_at: string;

  constructor(init: {
    bundle_id: string;
    version: string;
    contributed_components: readonly ComponentRef[];
    installed_at: string;
  }) {
    this.bundle_id = init.bundle_id;
    this.version = init.version;
    this.contributed_components = Object.freeze([...init.contributed_components]);
    this.installed_at = init.installed_at;
    Object.freeze(this);
  }

  static create(
    bundleId: string,
    version: string,
    components: ComponentRef[],
    installedAt: string | null = null,
  ): InstalledBundleRecord {
    return new InstalledBundleRecord({
      bundle_id: bundleId,
      version,
      contributed_components: components,
      installed_at: installedAt || utcNow(),
    });
  }

  toDict(): InstalledBundleRecordDict {
    return {
      bundle_id: this.bundle_id,
      version: this.version,
      installed_at: this.installed_at,
      contributed_components: this.contributed_components.map(componentToDict),
    };
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
    return new InstalledBundleRecord({
      bundle_id: bundleId,
      version,
      installed_at: text(dget(data, 'installed_at')),
      contributed_components: (componentsRaw as unknown[]).map(componentFromDict),
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

/** ``(kind, id)`` key used by the set helpers below. */
export function componentKey(kind: string, id: string): string {
  return JSON.stringify([kind, id]);
}

/** Set of ``(kind, id)`` component keys required by bundles other than the excluded one. */
export function componentsStillNeeded(records: InstalledBundleRecord[], excludeBundleId: string): Set<string> {
  const needed = new Set<string>();
  for (const record of records) {
    if (record.bundle_id === excludeBundleId) continue;
    for (const component of record.contributed_components) {
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

function componentFromDict(data: unknown): ComponentRef {
  if (!isMapping(data)) {
    throw new BundlerError('Each contributed component must be a mapping.');
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
    throw new BundlerError("Corrupt records file: a contributed component is missing its 'id'.");
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
