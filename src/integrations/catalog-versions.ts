/**
 * @oakoliver/specify-cli - Validate and select display-only integration
 * catalog release metadata.
 *
 * Port of `integrations/_catalog_versions.py` (spec-kit v1.2.5).
 *
 * @module integrations/catalog-versions
 */

import { InvalidVersion, Version } from '../version.js';
import { IntegrationCatalogError } from './index.js';

const RELEASE_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'author',
  'repository',
  'license',
  'tags',
  'requires',
]);
const CURRENT_ONLY: ReadonlySet<string> = new Set([
  'version',
  'description',
  'repository',
  'license',
  'tags',
  'requires',
  'provides',
  'download_url',
  'sha256',
  'bundled',
  'verified',
  'releases',
]);
const RESERVED: ReadonlySet<string> = new Set(['id', 'version', 'releases', '_catalog_name', '_install_allowed']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryVersion(text: string): Version | null {
  try {
    return new Version(text);
  } catch (e) {
    if (e instanceof InvalidVersion) return null;
    throw e;
  }
}

/** ``_validated_releases``: validate the optional ``releases`` mapping. */
export function validatedReleases(entry: Record<string, unknown>): Record<string, Record<string, unknown>> {
  if (!('releases' in entry)) return {};
  const integrationId = 'id' in entry ? entry.id : '<unknown>';
  const releases = entry.releases;
  if (!isPlainObject(releases)) {
    throw new IntegrationCatalogError(`Integration '${integrationId}' has an invalid releases mapping.`);
  }
  const current = entry.version;
  if (typeof current !== 'string' || !current.trim()) {
    throw new IntegrationCatalogError(`Integration '${integrationId}' has releases but no current version.`);
  }
  const currentVersion = tryVersion(current);
  if (currentVersion === null) {
    throw new IntegrationCatalogError(`Integration '${integrationId}' has an invalid current version '${current}'.`);
  }
  const seen: Version[] = [currentVersion];
  for (const [advertised, metadata] of Object.entries(releases)) {
    if (!advertised.trim()) {
      throw new IntegrationCatalogError(`Integration '${integrationId}' has an invalid release version key.`);
    }
    const normalized = tryVersion(advertised);
    if (normalized === null) {
      throw new IntegrationCatalogError(`Integration '${integrationId}' has invalid release version '${advertised}'.`);
    }
    if (seen.some((v) => v.equals(normalized))) {
      throw new IntegrationCatalogError(`Integration '${integrationId}' repeats release version '${advertised}'.`);
    }
    seen.push(normalized);
    if (!isPlainObject(metadata)) {
      throw new IntegrationCatalogError(`Integration '${integrationId}' release '${advertised}' must be an object.`);
    }
    for (const [field, value] of Object.entries(metadata)) {
      if (!RELEASE_FIELDS.has(field)) {
        const label = RESERVED.has(field) ? 'reserved' : 'unsupported';
        throw new IntegrationCatalogError(
          `Integration '${integrationId}' release '${advertised}' has ${label} field '${field}'.`,
        );
      }
      let valid: boolean;
      if (field === 'tags') {
        valid = Array.isArray(value) && value.every((tag) => typeof tag === 'string' && tag.trim() !== '');
      } else if (field === 'requires') {
        valid = isPlainObject(value);
      } else {
        valid = typeof value === 'string' && (value.trim() !== '' || field === 'description');
      }
      if (!valid) {
        throw new IntegrationCatalogError(`Integration '${integrationId}' release '${advertised}' has invalid ${field}.`);
      }
    }
  }
  return releases as Record<string, Record<string, unknown>>;
}

/** Select from the winning source without inheriting current-only metadata. */
export function selectRelease(
  entry: Record<string, unknown>,
  version: string | null | undefined,
): Record<string, unknown> | null {
  const releases = validatedReleases(entry);
  const current = entry.version;
  if (version === null || version === undefined || (typeof current === 'string' && current.trim() && version === current)) {
    return entry;
  }
  const requested = typeof version === 'string' ? tryVersion(version) : null;
  if (requested === null) return null;
  if (typeof current === 'string') {
    // Legacy single-release catalogs may use non-PEP 440 versions.
    const cur = tryVersion(current);
    if (cur !== null && requested.equals(cur)) return entry;
  }
  for (const [advertised, metadata] of Object.entries(releases)) {
    if (requested.equals(new Version(advertised))) {
      const shared: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry)) if (!CURRENT_ONLY.has(k)) shared[k] = v;
      return { ...shared, ...metadata, version: advertised };
    }
  }
  return null;
}

/** Return current first, then older release spellings in descending order. */
export function availableVersions(entry: Record<string, unknown>): string[] {
  const releases = validatedReleases(entry);
  const current = entry.version;
  if (typeof current !== 'string' || !current) return [];
  const older = Object.keys(releases)
    .map((k, i) => ({ k, v: new Version(k), i }))
    .sort((a, b) => b.v.compare(a.v) || a.i - b.i)
    .map((x) => x.k);
  return [current, ...older];
}
