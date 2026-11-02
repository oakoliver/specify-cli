/**
 * @oakoliver/specify-cli - Validate and select releases from a preset catalog entry
 *
 * Port of ``specify_cli/presets/_catalog_versions.py`` (spec-kit v1.2.5).
 *
 * @module presets/catalog-versions
 */

import { InvalidSpecifier, InvalidVersion, SpecifierSet, Version } from '../bundles/versioning.js';
import { isHttpsOrLocalhostHttp } from '../download-security.js';
import { PresetError, PresetManifest, PresetValidationError, isMapping, pyStr } from './manifest.js';

type Dict = Record<string, any>;

const SHA256 = /^[0-9a-fA-F]{64}$/;
const CURRENT_FIELDS = new Set(['version', 'download_url', 'sha256', 'requires', 'provides', 'bundled', 'releases']);
const RESERVED = ['id', 'version', 'releases', '_catalog_name', '_install_allowed'];

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function tryVersion(text: unknown): Version | null {
  if (typeof text !== 'string') return null;
  try {
    return new Version(text);
  } catch (e) {
    if (e instanceof InvalidVersion) return null;
    throw e;
  }
}

/** Return a checked release history, or reject an ambiguous catalog entry. */
export function validatedReleases(entry: Dict): Record<string, Dict> {
  if (!has(entry, 'releases')) return {};
  const packId = pyStr(has(entry, 'id') ? entry.id : '<unknown>');
  const releases = entry.releases;
  if (!isMapping(releases)) throw new PresetError(`Preset '${packId}' has an invalid releases mapping.`);
  const current = entry.version;
  if (typeof current !== 'string' || !current.trim()) {
    throw new PresetError(`Preset '${packId}' has releases but no current version.`);
  }
  const currentVersion = tryVersion(current);
  if (currentVersion === null) throw new PresetError(`Preset '${packId}' has invalid current version '${current}'.`);

  const seen: Version[] = [currentVersion];
  for (const [releaseVersion, record] of Object.entries(releases)) {
    if (!releaseVersion.trim()) throw new PresetError(`Preset '${packId}' has an invalid release version key.`);
    const parsed = tryVersion(releaseVersion);
    if (parsed === null) {
      throw new PresetError(`Preset '${packId}' has invalid release version '${releaseVersion}'.`);
    }
    if (seen.some((v) => v.equals(parsed))) {
      throw new PresetError(`Preset '${packId}' repeats release version '${releaseVersion}'.`);
    }
    seen.push(parsed);
    if (!isMapping(record)) {
      throw new PresetError(`Preset '${packId}' release '${releaseVersion}' must be an object.`);
    }
    const rec = record as Dict;
    if (RESERVED.some((field) => has(rec, field))) {
      throw new PresetError(`Preset '${packId}' release '${releaseVersion}' contains reserved fields.`);
    }
    if (typeof rec.download_url !== 'string' || !rec.download_url.trim()) {
      throw new PresetError(`Preset '${packId}' release '${releaseVersion}' needs a download_url.`);
    }
    if (!isHttpsOrLocalhostHttp(rec.download_url)) {
      throw new PresetError(`Preset '${packId}' release '${releaseVersion}' has an invalid download_url.`);
    }
    let digest: unknown = rec.sha256;
    if (typeof digest === 'string') {
      digest = digest.trim();
      if ((digest as string).slice(0, 7).toLowerCase() === 'sha256:') digest = (digest as string).slice(7).trim();
    }
    if (typeof digest !== 'string' || !SHA256.test(digest)) {
      throw new PresetError(`Preset '${packId}' release '${releaseVersion}' needs a SHA-256 digest.`);
    }
    for (const field of ['requires', 'provides']) {
      if (has(rec, field) && !isMapping(rec[field])) {
        throw new PresetError(`Preset '${packId}' release '${releaseVersion}' has invalid ${field}.`);
      }
    }
    const requires: Dict = has(rec, 'requires') ? rec.requires : {};
    if (has(requires, 'speckit_version')) {
      const specifier = requires.speckit_version;
      const invalid = (): PresetError =>
        new PresetError(`Preset '${packId}' release '${releaseVersion}' has invalid requires.speckit_version.`);
      if (typeof specifier !== 'string' || !specifier.trim()) throw invalid();
      try {
        new SpecifierSet(specifier);
      } catch (e) {
        if (e instanceof InvalidSpecifier) throw invalid();
        throw e;
      }
    }
    if (has(requires, 'extensions')) {
      try {
        PresetManifest.validateRequiresExtensions(requires.extensions);
      } catch (exc) {
        if (exc instanceof PresetValidationError) {
          throw new PresetError(`Preset '${packId}' release '${releaseVersion}' has ${exc.message}`);
        }
        throw exc;
      }
    }
    if (has(rec, 'bundled') && typeof rec.bundled !== 'boolean') {
      throw new PresetError(`Preset '${packId}' release '${releaseVersion}' has invalid bundled.`);
    }
  }
  return releases as Record<string, Dict>;
}

/** Return current or exact historical metadata from the winning entry. */
export function selectRelease(entry: Dict, version: string | null | undefined): Dict | null {
  const releases = validatedReleases(entry);
  const current = entry.version;
  if (version === null || version === undefined || version === current) return entry;
  const requested = tryVersion(version);
  if (requested === null) return null;
  if (typeof current === 'string') {
    // Legacy entries may use a non-PEP-440 current version.
    const cur = tryVersion(current);
    if (cur !== null && requested.equals(cur)) return entry;
  }
  for (const [advertised, record] of Object.entries(releases)) {
    if (requested.equals(new Version(advertised))) {
      const common: Dict = {};
      for (const [key, value] of Object.entries(entry)) if (!CURRENT_FIELDS.has(key)) common[key] = value;
      return { ...common, ...record, version: advertised };
    }
  }
  return null;
}

/** Return advertised current first, then historical versions descending. */
export function availableVersions(entry: Dict): string[] {
  const releases = validatedReleases(entry);
  const current = entry.version;
  if (typeof current !== 'string' || !current) return [];
  return [current, ...Object.keys(releases).sort((a, b) => new Version(b).compare(new Version(a)))];
}
