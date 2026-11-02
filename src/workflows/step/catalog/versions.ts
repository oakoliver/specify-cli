/**
 * @oakoliver/specify-cli - Step Catalog Release Selection
 *
 * Release selection for step catalog entries
 * (port of ``workflows/step/catalog/_versions.py``).
 *
 * @module workflows/step/catalog/versions
 */

import { InvalidVersion, Version } from '../../../version.js';
import { isMapping, pyRepr } from '../../overlay/py-compat.js';
import { StepCatalogError } from './domain.js';

type Dict = Record<string, unknown>;

const DIGEST = /^[0-9a-fA-F]{64}$/;
const CURRENT_ONLY: ReadonlySet<string> = new Set([
  'version',
  'url',
  'step_yml_url',
  'init_url',
  'extra_files',
  'sha256',
  'requires',
  'provides',
  'releases',
]);
const RESERVED: readonly string[] = ['id', 'version', 'releases', '_catalog_name', '_install_allowed'];

function tryVersion(value: string): Version | null {
  try {
    return new Version(value);
  } catch (exc) {
    if (exc instanceof InvalidVersion) return null;
    throw exc;
  }
}

function pyEq(a: unknown, b: unknown): boolean {
  return a === b;
}

/** Check that a release pins exactly the files its installer downloads (``validate_checksums``). */
export function validateChecksums(entry: Dict, stepId: string, opts: { required: boolean }): void {
  const hashes = entry.sha256;
  if ((hashes === null || hashes === undefined) && !opts.required) return;
  const files = 'extra_files' in entry ? entry.extra_files : {};
  if (
    !isMapping(files) ||
    Object.entries(files).some(
      ([path, url]) =>
        !path.trim() ||
        path.includes('\\') ||
        path.split('/').some((part) => part === '' || part === '.' || part === '..') ||
        path.startsWith('/') ||
        ['step.yml', '__init__.py'].includes(path.toLowerCase()) ||
        typeof url !== 'string' ||
        !url.trim(),
    )
  ) {
    throw new StepCatalogError(`Step '${stepId}' has invalid extra_files.`);
  }
  const expected = new Set(['step.yml', '__init__.py', ...Object.keys(files)]);
  const hashKeys = isMapping(hashes) ? Object.keys(hashes) : [];
  if (
    !isMapping(hashes) ||
    hashKeys.length !== expected.size ||
    hashKeys.some((k) => !expected.has(k)) ||
    Object.values(hashes).some((value) => typeof value !== 'string' || !DIGEST.test(value))
  ) {
    const sorted = [...expected].sort();
    throw new StepCatalogError(`Step '${stepId}' needs SHA-256 digests for exactly ${pyRepr(sorted)}.`);
  }
}

function validatedReleases(entry: Dict, stepId: string): Record<string, Dict> {
  if (!('releases' in entry)) return {};
  const releases = entry.releases;
  if (!isMapping(releases)) throw new StepCatalogError(`Step '${stepId}' has an invalid releases mapping.`);
  if (!pyEq('id' in entry ? entry.id : stepId, stepId)) {
    throw new StepCatalogError(`Step '${stepId}' has a mismatched catalog ID.`);
  }
  const current = entry.version;
  if (typeof current !== 'string' || !current.trim()) {
    throw new StepCatalogError(`Step '${stepId}' has releases but no current version.`);
  }
  const currentVersion = tryVersion(current);
  if (currentVersion === null) {
    throw new StepCatalogError(`Step '${stepId}' has invalid current version '${current}'.`);
  }
  const seen: Version[] = [currentVersion];
  for (const [releaseVersion, record] of Object.entries(releases)) {
    if (!releaseVersion.trim()) throw new StepCatalogError(`Step '${stepId}' has an invalid release version key.`);
    const normalized = tryVersion(releaseVersion);
    if (normalized === null) {
      throw new StepCatalogError(`Step '${stepId}' has invalid release version '${releaseVersion}'.`);
    }
    if (seen.some((v) => v.equals(normalized))) {
      throw new StepCatalogError(`Step '${stepId}' repeats release version '${releaseVersion}'.`);
    }
    seen.push(normalized);
    if (!isMapping(record)) {
      throw new StepCatalogError(`Step '${stepId}' release '${releaseVersion}' must be an object.`);
    }
    if (RESERVED.some((key) => key in record)) {
      throw new StepCatalogError(`Step '${stepId}' release '${releaseVersion}' contains reserved fields.`);
    }
    const url = 'step_yml_url' in record ? record.step_yml_url : record.url;
    if (
      typeof url !== 'string' ||
      !url.trim() ||
      ('url' in record && 'step_yml_url' in record && !pyEq(record.url, record.step_yml_url))
    ) {
      throw new StepCatalogError(`Step '${stepId}' release '${releaseVersion}' needs a step.yml URL.`);
    }
    const initUrl = record.init_url ?? null;
    if (
      (initUrl !== null && (typeof initUrl !== 'string' || !initUrl.trim())) ||
      (initUrl === null && !url.endsWith('step.yml'))
    ) {
      throw new StepCatalogError(`Step '${stepId}' release '${releaseVersion}' needs an __init__.py URL.`);
    }
    for (const field of ['requires', 'provides']) {
      if (field in record && !isMapping(record[field])) {
        throw new StepCatalogError(`Step '${stepId}' release '${releaseVersion}' has invalid ${field}.`);
      }
    }
    validateChecksums(record, stepId, { required: true });
  }
  return releases as Record<string, Dict>;
}

/**
 * Select a release from the winning entry; never consult another source
 * (``select_release``).
 */
export function selectRelease(entry: Dict, stepId: string, version: string | null | undefined): Dict | null {
  const releases = validatedReleases(entry, stepId);
  const current = entry.version;
  if (version === null || version === undefined || version === current) return entry;
  const requested = tryVersion(version);
  if (requested === null) return null;
  if (typeof current === 'string') {
    // Legacy versions still support exact spelling above.
    const currentVersion = tryVersion(current);
    if (currentVersion !== null && requested.equals(currentVersion)) return entry;
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

/** List the advertised current version before historical versions (``available_versions``). */
export function availableVersions(entry: Dict, stepId: string): string[] {
  const releases = validatedReleases(entry, stepId);
  const current = entry.version;
  if (typeof current !== 'string' || !current) return [];
  const history = Object.keys(releases).sort((a, b) => new Version(b).compare(new Version(a)));
  return [current, ...history];
}
