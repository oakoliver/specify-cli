/**
 * @oakoliver/specify-cli - Workflow Catalog Release Selection
 *
 * Version selection for workflow catalog entries
 * (port of ``workflows/catalog/_versions.py``).
 *
 * A catalog entry keeps its current release at the top level and may
 * advertise historical releases under ``releases: {version: record}``. Each
 * record needs a ``url`` and a ``sha256`` digest and may carry ``requires``.
 *
 * @module workflows/catalog/versions
 */

import { isHttpsOrLocalhostHttp } from '../../download-security.js';
import { InvalidVersion, Version } from '../../version.js';
import { isMapping, pyStr } from '../overlay/py-compat.js';
import { WorkflowValidationError } from './domain.js';

type Dict = Record<string, unknown>;

const SHA256 = /^(?:sha256:)?[0-9a-fA-F]{64}$/i;
const CURRENT_ONLY: ReadonlySet<string> = new Set(['version', 'url', 'sha256', 'requires', 'bundled', 'releases']);
const RESERVED: readonly string[] = ['id', 'version', 'releases', '_catalog_name', '_install_allowed'];
const WORKFLOW_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * ``engine._is_valid_workflow_version``: the ``X.Y.Z`` spelling a workflow
 * definition may declare.
 */
export function isValidWorkflowVersion(value: unknown): boolean {
  return typeof value === 'string' && WORKFLOW_VERSION_PATTERN.test(value);
}

function tryVersion(value: string): Version | null {
  try {
    return new Version(value);
  } catch (exc) {
    if (exc instanceof InvalidVersion) return null;
    throw exc;
  }
}

function validatedReleases(entry: Dict): Record<string, Dict> {
  if (!('releases' in entry)) return {};
  const releases = entry.releases;
  const workflowId = 'id' in entry ? pyStr(entry.id) : '<unknown>';
  if (!isMapping(releases)) {
    throw new WorkflowValidationError(`Workflow '${workflowId}' has an invalid releases mapping.`);
  }

  const current = entry.version;
  if (typeof current !== 'string' || !current.trim()) {
    throw new WorkflowValidationError(`Workflow '${workflowId}' has releases but no current version.`);
  }
  if (!isValidWorkflowVersion(current)) {
    throw new WorkflowValidationError(`Workflow '${workflowId}' has an invalid current version '${current}'.`);
  }
  const currentVersion = tryVersion(current);
  if (currentVersion === null) {
    throw new WorkflowValidationError(`Workflow '${workflowId}' has an invalid current version '${current}'.`);
  }
  const seen: Version[] = [currentVersion];

  for (const [releaseVersion, record] of Object.entries(releases)) {
    if (!releaseVersion.trim()) {
      throw new WorkflowValidationError(`Workflow '${workflowId}' has an invalid release version key.`);
    }
    if (!isValidWorkflowVersion(releaseVersion)) {
      throw new WorkflowValidationError(`Workflow '${workflowId}' has invalid release version '${releaseVersion}'.`);
    }
    const normalized = tryVersion(releaseVersion);
    if (normalized === null) {
      throw new WorkflowValidationError(`Workflow '${workflowId}' has invalid release version '${releaseVersion}'.`);
    }
    if (seen.some((v) => v.equals(normalized))) {
      throw new WorkflowValidationError(`Workflow '${workflowId}' repeats release version '${releaseVersion}'.`);
    }
    seen.push(normalized);
    if (!isMapping(record)) {
      throw new WorkflowValidationError(`Workflow '${workflowId}' release '${releaseVersion}' must be an object.`);
    }
    if (RESERVED.some((key) => key in record)) {
      throw new WorkflowValidationError(`Workflow '${workflowId}' release '${releaseVersion}' contains reserved fields.`);
    }
    if (typeof record.url !== 'string' || !record.url.trim()) {
      throw new WorkflowValidationError(`Workflow '${workflowId}' release '${releaseVersion}' needs a url.`);
    }
    if (!isHttpsOrLocalhostHttp(record.url)) {
      throw new WorkflowValidationError(`Workflow '${workflowId}' release '${releaseVersion}' has an invalid URL.`);
    }
    if (typeof record.sha256 !== 'string' || !SHA256.test(record.sha256)) {
      throw new WorkflowValidationError(
        `Workflow '${workflowId}' release '${releaseVersion}' needs a SHA-256 digest.`,
      );
    }
    if ('requires' in record && !isMapping(record.requires)) {
      throw new WorkflowValidationError(`Workflow '${workflowId}' release '${releaseVersion}' has invalid requires.`);
    }
  }
  return releases as Record<string, Dict>;
}

/**
 * Select from the winning source, preserving the advertised version
 * (``select_release``). Returns ``null`` when ``version`` is not advertised.
 */
export function selectRelease(entry: Dict, version: string | null | undefined): Dict | null {
  const releases = validatedReleases(entry);
  const current = entry.version;
  if (version === null || version === undefined || version === current) return entry;
  const requested = tryVersion(version);
  if (requested === null) return null;
  if (typeof current === 'string') {
    // Legacy entries without history can use non-PEP-440 versions.
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

/** Current first, followed by historical versions newest to oldest (``available_versions``). */
export function availableVersions(entry: Dict): string[] {
  const releases = validatedReleases(entry);
  const current = entry.version;
  if (typeof current !== 'string' || !current) return [];
  const history = Object.keys(releases).sort((a, b) => new Version(b).compare(new Version(a)));
  return [current, ...history];
}
