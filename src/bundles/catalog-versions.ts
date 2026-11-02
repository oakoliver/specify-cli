/**
 * @oakoliver/specify-cli - Exact-release validation and selection for bundle
 * catalog entries.
 *
 * Port of ``specify_cli/bundles/catalog_versions.py`` (spec-kit v1.2.5).
 *
 * @module bundles/catalog-versions
 */

import { isHttpsOrLocalhostHttp } from '../download-security.js';
import { BundlerError } from './index.js';
import { CatalogEntry } from './catalogs.js';
import { InvalidVersion, Version, isSemver } from './versioning.js';
import { isMapping } from './pycompat.js';

const SHA256 = /^[0-9a-fA-F]{64}$/;
const CURRENT_ONLY = new Set(['version', 'download_url', 'sha256', 'requires', 'provides', 'verified', 'releases']);
const RESERVED = new Set(['id', 'version', 'releases']);

function raw(entry: CatalogEntry): Record<string, unknown> {
  return entry.raw ?? {};
}

function tryVersion(value: string): Version | null {
  try {
    return new Version(value);
  } catch (exc) {
    if (exc instanceof InvalidVersion) return null;
    throw exc;
  }
}

function common(entry: CatalogEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw(entry))) {
    if (!CURRENT_ONLY.has(key)) out[key] = value;
  }
  return out;
}

/** Return checked historical releases or reject an ambiguous entry. */
export function validatedReleases(entry: CatalogEntry): Record<string, Record<string, unknown>> {
  const data = raw(entry);
  if (!Object.prototype.hasOwnProperty.call(data, 'releases')) return {};
  const releases = data.releases;
  if (!isMapping(releases)) {
    throw new BundlerError(`Bundle '${entry.id}' has an invalid releases mapping.`);
  }

  const current = data.version;
  if (typeof current !== 'string' || !current.trim()) {
    throw new BundlerError(`Bundle '${entry.id}' has releases but no current version.`);
  }
  if (!isSemver(current)) {
    throw new BundlerError(`Bundle '${entry.id}' has an invalid current version '${current}'.`);
  }
  const currentVersion = tryVersion(current);
  if (currentVersion === null) {
    throw new BundlerError(`Bundle '${entry.id}' has an invalid current version '${current}'.`);
  }
  const seen: Version[] = [currentVersion];

  for (const [advertised, record] of Object.entries(releases)) {
    if (!advertised.trim()) {
      throw new BundlerError(`Bundle '${entry.id}' has an invalid release version key.`);
    }
    if (!isSemver(advertised)) {
      throw new BundlerError(`Bundle '${entry.id}' has invalid release version '${advertised}'.`);
    }
    const normalized = tryVersion(advertised);
    if (normalized === null) {
      throw new BundlerError(`Bundle '${entry.id}' has invalid release version '${advertised}'.`);
    }
    if (seen.some((v) => v.equals(normalized))) {
      throw new BundlerError(`Bundle '${entry.id}' repeats release version '${advertised}'.`);
    }
    seen.push(normalized);
    if (!isMapping(record)) {
      throw new BundlerError(`Bundle '${entry.id}' release '${advertised}' must be an object.`);
    }
    if (Object.keys(record).some((key) => RESERVED.has(key))) {
      throw new BundlerError(`Bundle '${entry.id}' release '${advertised}' contains reserved fields.`);
    }
    const downloadUrl = record.download_url;
    if (typeof downloadUrl !== 'string' || !downloadUrl.trim()) {
      throw new BundlerError(`Bundle '${entry.id}' release '${advertised}' needs a download_url.`);
    }
    if (!isHttpsOrLocalhostHttp(downloadUrl)) {
      throw new BundlerError(`Bundle '${entry.id}' release '${advertised}' has an invalid download_url.`);
    }
    let digest = record.sha256;
    if (typeof digest === 'string') {
      digest = digest.trim();
      if ((digest as string).slice(0, 7).toLowerCase() === 'sha256:') digest = (digest as string).slice(7).trim();
    }
    if (typeof digest !== 'string' || !SHA256.test(digest)) {
      throw new BundlerError(`Bundle '${entry.id}' release '${advertised}' needs a SHA-256 digest.`);
    }
    for (const field of ['requires', 'provides']) {
      if (Object.prototype.hasOwnProperty.call(record, field) && !isMapping(record[field])) {
        throw new BundlerError(`Bundle '${entry.id}' release '${advertised}' has invalid ${field}.`);
      }
    }
    try {
      CatalogEntry.fromDict({ ...common(entry), ...record, version: advertised });
    } catch (exc) {
      if (exc instanceof BundlerError) {
        throw new BundlerError(`Bundle '${entry.id}' release '${advertised}' has ${exc.message}`, { cause: exc });
      }
      throw exc;
    }
  }
  return releases as Record<string, Record<string, unknown>>;
}

/** Select an exact release from one winning catalog entry. */
export function selectRelease(entry: CatalogEntry, version: string | null | undefined): CatalogEntry | null {
  const releases = validatedReleases(entry);
  const current = entry.version;
  if (version === null || version === undefined || version === current) return entry;
  const requested = tryVersion(version);
  if (requested === null) return null;
  // Legacy entries without history may retain older non-PEP-440 spellings.
  const currentVersion = tryVersion(current);
  if (currentVersion !== null && requested.equals(currentVersion)) return entry;
  for (const [advertised, record] of Object.entries(releases)) {
    if (requested.equals(new Version(advertised))) {
      return CatalogEntry.fromDict({ ...common(entry), ...record, version: advertised });
    }
  }
  return null;
}

/** Return the current version, then historical releases newest first. */
export function availableVersions(entry: CatalogEntry): string[] {
  const releases = validatedReleases(entry);
  if (!entry.version) return [];
  const history = Object.keys(releases).sort((a, b) => new Version(b).compare(new Version(a)));
  return [entry.version, ...history];
}
