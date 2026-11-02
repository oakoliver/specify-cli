/**
 * @oakoliver/specify-cli - Bundle component catalog resolution
 *
 * Resolve bundle components from the first trustworthy catalog source.
 *
 * Port of ``specify_cli/bundles/component_catalog.py`` (spec-kit v1.2.5).
 *
 * The per-domain exact-release selectors (``extensions._catalog_versions``,
 * ``presets._catalog_versions``, ``workflows.catalog._versions`` and
 * ``workflows.step.catalog._versions``) are reached through
 * {@link componentCatalogDeps.selectRelease} so tests can replace them.
 * {@link genericSelectRelease} remains as the fallback for unknown kinds.
 *
 * @module bundles/component-catalog
 */

import { BundlerError } from './index.js';
import type { ComponentRef } from './manifest.js';
import { InvalidVersion, Version } from './versioning.js';
import { isMapping, pyRepr } from './pycompat.js';
import { selectRelease as selectExtensionRelease } from '../extensions/catalog-versions.js';
import { selectRelease as selectPresetRelease } from '../presets/catalog-versions.js';
import { selectRelease as selectWorkflowRelease } from '../workflows/catalog/versions.js';
import { selectRelease as selectStepRelease } from '../workflows/step/catalog/versions.js';

type Dict = Record<string, unknown>;

/** The winning component source cannot be determined right now. */
export class CatalogUnavailable extends BundlerError {
  override name = 'CatalogUnavailable';
}

/** Error names that are definitive (never "unavailable"). */
const DEFINITIVE_ERRORS = new Set(['GitHubCliAuthError', 'RedirectPolicyError']);
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ConnectionRefused',
  'ConnectionClosed',
]);

/** ``_is_unavailable``: walk the cause chain looking for a transient failure. */
export function isUnavailable(exc: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = exc;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    if (typeof current !== 'object') return false;
    const e = current as { name?: string; code?: unknown; reason?: unknown; cause?: unknown };
    const name = e.name ?? '';
    if (DEFINITIVE_ERRORS.has(name)) return false;
    if (name === 'HTTPError' && typeof e.code === 'number') {
      return e.code === 408 || e.code === 429 || (e.code >= 500 && e.code <= 599);
    }
    if (name === 'URLError') {
      const reason = e.reason as { name?: string } | undefined;
      // TLS failures and malformed URLs are definitive.
      return !(reason && typeof reason === 'object' && /SSL|TLS|Cert|ValueError|TypeError/i.test(reason.name ?? ''));
    }
    if (name === 'TimeoutError' || name === 'AbortError' || name === 'ConnectionError') return true;
    if (typeof e.code === 'string' && TRANSPORT_CODES.has(e.code)) return true;
    current = e.cause;
  }
  return false;
}

function sourceEntries(data: unknown, component: ComponentRef, url: string): Dict | unknown[] {
  const entries = isMapping(data) ? data[component.kind] : undefined;
  if (!(isMapping(entries) || Array.isArray(entries))) {
    throw new BundlerError(
      `Invalid ${component.kind.slice(0, -1)} catalog from ${url}: ` +
        `missing or malformed ${component.kind} metadata.`,
    );
  }
  return entries;
}

function matchingEntry(entries: Dict | unknown[], component: ComponentRef, url: string): Dict | null {
  const singular = component.kind.slice(0, -1);
  if (!Array.isArray(entries)) {
    if (!Object.prototype.hasOwnProperty.call(entries, component.id)) return null;
    const found = entries[component.id];
    if (!isMapping(found)) {
      throw new BundlerError(
        `Invalid ${singular} catalog entry for '${component.id}' from ${url}: expected an object.`,
      );
    }
    if ('id' in found && found.id !== component.id) {
      throw new BundlerError(
        `Invalid ${singular} catalog entry for '${component.id}' ` +
          `from ${url}: declared ID ${pyRepr(found.id)} does not match the catalog key.`,
      );
    }
    return { ...found, id: component.id };
  }

  const seen = new Set<string>();
  let found: Dict | null = null;
  for (const item of entries) {
    if (!isMapping(item)) {
      throw new BundlerError(`Invalid ${singular} catalog entry from ${url}: expected an object.`);
    }
    let itemId = item.id;
    if (typeof itemId !== 'string') {
      throw new BundlerError(`Invalid ${singular} ID in catalog ${url}: expected a string.`);
    }
    itemId = component.kind === 'steps' ? (itemId as string).trim() : itemId;
    if (!itemId) throw new BundlerError(`Invalid ${singular} ID in catalog ${url}: empty ID.`);
    if (seen.has(itemId as string)) {
      throw new BundlerError(`Duplicate ${singular} ID '${itemId}' in catalog ${url}.`);
    }
    seen.add(itemId as string);
    if (itemId === component.id) found = { ...item, id: itemId };
  }
  return found;
}

/** Duck type of the four component catalogs' source-ordered fetch API. */
export interface ComponentCatalogLike {
  getActiveCatalogs(): unknown;
  fetchSingleCatalog(source: never, forceRefresh?: boolean): unknown;
}

interface ActiveSource {
  name: string;
  url: string;
  install_allowed: boolean;
}

/**
 * Read sources in priority order rather than accepting a lower match on error.
 *
 * The component catalogs' public ID lookup skips failed catalogs. Bundles
 * cannot do that: an unreadable higher source may own the requested ID.
 */
export async function winningCatalogEntry(catalog: ComponentCatalogLike, component: ComponentRef): Promise<Dict | null> {
  const sources = (await catalog.getActiveCatalogs()) as ActiveSource[];
  if (component.source && sources.filter((source) => source.name === component.source).length > 1) {
    throw new BundlerError(
      `${component.kind.slice(0, -1)} '${component.id}' requests ambiguous catalog ` +
        `source '${component.source}': multiple active catalogs share this name. ` +
        'Give each catalog a unique name before installing.',
    );
  }

  for (const source of sources) {
    let data: unknown;
    try {
      data = await catalog.fetchSingleCatalog(source as never);
    } catch (exc) {
      if (isUnavailable(exc)) {
        throw new CatalogUnavailable(`Catalog '${source.name}' is unreachable: ${errText(exc)}`, { cause: exc });
      }
      throw new BundlerError(
        `Invalid ${component.kind.slice(0, -1)} catalog from ${source.url}: ${errText(exc)}`,
        { cause: exc },
      );
    }
    const entries = sourceEntries(data, component, source.url);
    const found = matchingEntry(entries, component, source.url);
    if (found !== null) {
      return { ...found, _catalog_name: source.name, _install_allowed: source.install_allowed };
    }
  }
  return null;
}

function errText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// ============================================================================
// Release selection
// ============================================================================

/** Fields that describe only the current release, per component kind. */
export const CURRENT_ONLY_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  extensions: new Set(['version', 'download_url', 'sha256', 'requires', 'provides', 'bundled', 'verified', 'releases']),
  presets: new Set(['version', 'download_url', 'sha256', 'requires', 'provides', 'bundled', 'releases']),
  workflows: new Set(['version', 'url', 'sha256', 'requires', 'bundled', 'releases']),
  steps: new Set([
    'version',
    'url',
    'step_yml_url',
    'init_url',
    'extra_files',
    'sha256',
    'requires',
    'provides',
    'releases',
  ]),
};

function tryVersion(value: unknown): Version | null {
  if (typeof value !== 'string') return null;
  try {
    return new Version(value);
  } catch (exc) {
    if (exc instanceof InvalidVersion) return null;
    throw exc;
  }
}

/**
 * The selection algorithm shared by every domain's ``select_release``:
 * ``None`` is returned when the requested version is absent from the winning
 * entry, never falling through to another catalog.
 */
export function genericSelectRelease(kind: string, entry: Dict, version: string | null): Dict | null {
  const releasesRaw = entry.releases;
  const releases = isMapping(releasesRaw) ? releasesRaw : {};
  const current = entry.version;
  if (version === null || version === undefined || version === current) return entry;
  const requested = tryVersion(version);
  if (requested === null) return null;
  const currentVersion = tryVersion(current);
  if (currentVersion !== null && requested.equals(currentVersion)) return entry;
  const currentOnly = CURRENT_ONLY_FIELDS[kind] ?? CURRENT_ONLY_FIELDS.extensions;
  for (const [advertised, record] of Object.entries(releases)) {
    const advertisedVersion = tryVersion(advertised);
    if (advertisedVersion !== null && requested.equals(advertisedVersion) && isMapping(record)) {
      const common: Dict = {};
      for (const [key, value] of Object.entries(entry)) if (!currentOnly.has(key)) common[key] = value;
      return { ...common, ...record, version: advertised };
    }
  }
  return null;
}

/** Injectable domain selectors (the integrator wires the domain modules). */
export const componentCatalogDeps = {
  selectRelease(kind: string, entry: Dict, componentId: string, version: string | null): Dict | null {
    if (kind === 'extensions') return selectExtensionRelease(entry, version);
    if (kind === 'presets') return selectPresetRelease(entry, version);
    if (kind === 'workflows') return selectWorkflowRelease(entry, version);
    if (kind === 'steps') return selectStepRelease(entry, componentId, version);
    return genericSelectRelease(kind, entry, version);
  },
};

/** Select from the already-fetched winning entry without a second lookup. */
export function selectCatalogRelease(component: ComponentRef, entry: Dict): Dict | null {
  return componentCatalogDeps.selectRelease(component.kind, entry, component.id, component.version);
}
