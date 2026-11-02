/**
 * @oakoliver/specify-cli - Exact-version selection for extension catalog entries
 *
 * Port of ``specify_cli/extensions/_catalog_versions.py`` (spec-kit v1.2.5).
 *
 * Legacy entries advertise one release at the top level. A versioned entry
 * keeps that current release unchanged for older clients and adds historical
 * releases under ``releases``. Historical records must carry their own URL and
 * digest; a new current release must never supply either for an older version
 * by accident.
 *
 * @module extensions/catalog-versions
 */

import { InvalidVersion, Version } from '../version.js';
import { ExtensionError } from './errors.js';
import { type Dict, isMapping } from './manifest.js';

const SHA256 = /^[0-9a-fA-F]{64}$/;
const CURRENT_ONLY = new Set(['version', 'download_url', 'sha256', 'requires', 'provides', 'bundled', 'verified', 'releases']);
const RESERVED = ['id', 'version', 'releases', '_catalog_name', '_install_allowed'];

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function tryVersion(text: string): Version | null {
  try {
    return new Version(text);
  } catch (e) {
    if (e instanceof InvalidVersion) return null;
    throw e;
  }
}

/** Return a checked history, or reject an ambiguous catalog entry. */
export function validatedReleases(entry: Dict): Record<string, Dict> {
  if (!has(entry, 'releases')) return {};
  const releases = entry.releases;
  const extensionId = has(entry, 'id') ? entry.id : '<unknown>';
  if (!isMapping(releases)) {
    throw new ExtensionError(`Extension '${extensionId}' has an invalid releases mapping.`);
  }

  const current = entry.version;
  if (typeof current !== 'string' || !current.trim()) {
    throw new ExtensionError(`Extension '${extensionId}' has releases but no current version.`);
  }
  const normalizedCurrent = tryVersion(current);
  if (normalizedCurrent === null) {
    throw new ExtensionError(`Extension '${extensionId}' has an invalid current version '${current}'.`);
  }

  const seen: Version[] = [normalizedCurrent];
  for (const [releaseVersion, record] of Object.entries(releases)) {
    if (!releaseVersion.trim()) {
      throw new ExtensionError(`Extension '${extensionId}' has an invalid release version key.`);
    }
    const normalized = tryVersion(releaseVersion);
    if (normalized === null) {
      throw new ExtensionError(`Extension '${extensionId}' has invalid release version '${releaseVersion}'.`);
    }
    if (seen.some((v) => v.equals(normalized))) {
      throw new ExtensionError(`Extension '${extensionId}' repeats release version '${releaseVersion}'.`);
    }
    seen.push(normalized);
    if (!isMapping(record)) {
      throw new ExtensionError(`Extension '${extensionId}' release '${releaseVersion}' must be an object.`);
    }
    if (RESERVED.some((key) => has(record, key))) {
      throw new ExtensionError(`Extension '${extensionId}' release '${releaseVersion}' contains reserved fields.`);
    }
    if (typeof record.download_url !== 'string' || !record.download_url.trim()) {
      throw new ExtensionError(`Extension '${extensionId}' release '${releaseVersion}' needs a download_url.`);
    }
    let digest: unknown = record.sha256;
    if (typeof digest === 'string') {
      digest = digest.trim();
      if ((digest as string).slice(0, 7).toLowerCase() === 'sha256:') digest = (digest as string).slice(7).trim();
    }
    if (typeof digest !== 'string' || !SHA256.test(digest)) {
      throw new ExtensionError(`Extension '${extensionId}' release '${releaseVersion}' needs a SHA-256 digest.`);
    }
    for (const field of ['requires', 'provides']) {
      if (has(record, field) && !isMapping(record[field])) {
        throw new ExtensionError(`Extension '${extensionId}' release '${releaseVersion}' has invalid ${field}.`);
      }
    }
  }
  return releases as Record<string, Dict>;
}

/**
 * Select from the winning catalog entry without consulting lower sources.
 *
 * ``null`` is returned when the requested version is absent, so callers can
 * report a missing historical release without falling through to another
 * catalog or silently substituting the current release.
 */
export function selectRelease(entry: Dict, version: string | null | undefined): Dict | null {
  const releases = validatedReleases(entry);
  const current = entry.version;
  if (version === null || version === undefined || version === current) return entry;
  const requested = tryVersion(version);
  if (requested === null) return null;
  if (typeof current === 'string') {
    // Legacy entries without history are still selectable by exact spelling
    // above, even if their version is not PEP 440 compliant.
    const cur = tryVersion(current);
    if (cur !== null && requested.equals(cur)) return entry;
  }
  for (const [advertised, record] of Object.entries(releases)) {
    if (requested.equals(new Version(advertised))) {
      const common: Dict = {};
      for (const [key, value] of Object.entries(entry)) if (!CURRENT_ONLY.has(key)) common[key] = value;
      return { ...common, ...record, version: advertised };
    }
  }
  return null;
}

/** Current version first, then historical versions in descending order. */
export function availableVersions(entry: Dict): string[] {
  const releases = validatedReleases(entry);
  const current = entry.version;
  if (typeof current !== 'string' || !current) return [];
  const history = Object.keys(releases).sort((a, b) => new Version(b).compare(new Version(a)));
  return [current, ...history];
}
