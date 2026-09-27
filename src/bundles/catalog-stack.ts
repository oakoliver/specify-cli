/**
 * @oakoliver/specify-cli - Bundle catalog stack
 *
 * Aggregate bundle entries across sources with precedence + policy. Loads
 * each source's catalog payload (via an injectable fetcher so tests stay
 * offline), then resolves a bundle id to the highest-precedence entry while
 * recording whether installation is permitted by that source's policy.
 *
 * Port of ``specify_cli/bundles/catalog_stack.py``.
 *
 * @module bundles/catalog-stack
 */

import { BundlerError } from './index.js';
import { CatalogEntry, CatalogSource, loadCatalogPayload, loadSourceStack, sortSources } from './catalogs.js';

/** A fetcher returns the raw JSON payload for a given source. */
export type CatalogFetcher = (source: CatalogSource) => unknown | Promise<unknown>;

export class ResolvedBundle {
  constructor(
    readonly entry: CatalogEntry,
    readonly source: CatalogSource,
  ) {}

  get installAllowed(): boolean {
    return this.source.installAllowed;
  }
}

export class CatalogStack {
  private readonly _sources: CatalogSource[];
  private readonly _fetcher: CatalogFetcher;
  private readonly _payloads = new Map<string, Map<string, CatalogEntry>>();

  constructor(sources: CatalogSource[], fetcher: CatalogFetcher) {
    // Highest precedence (lowest priority number) first.
    this._sources = sortSources(sources);
    this._fetcher = fetcher;
  }

  static load(projectRoot: string, fetcher: CatalogFetcher, userConfigDir: string | null = null): CatalogStack {
    const sources = loadSourceStack(projectRoot, userConfigDir);
    return new CatalogStack(sources, fetcher);
  }

  get sources(): CatalogSource[] {
    return [...this._sources];
  }

  private async entriesFor(source: CatalogSource): Promise<Map<string, CatalogEntry>> {
    let entries = this._payloads.get(source.id);
    if (entries === undefined) {
      let raw: unknown;
      try {
        raw = await this._fetcher(source);
      } catch (exc) {
        if (exc instanceof BundlerError) throw exc;
        const detail = exc instanceof Error ? exc.message : String(exc);
        throw new BundlerError(`Failed to load catalog '${source.id}' (${source.url}): ${detail}`, {
          cause: exc,
        });
      }
      entries = loadCatalogPayload(raw);
      this._payloads.set(source.id, entries);
    }
    return entries;
  }

  /** Return the highest-precedence entry for *bundleId* or throw. */
  async resolve(bundleId: string): Promise<ResolvedBundle> {
    for (const source of this._sources) {
      const entries = await this.entriesFor(source);
      const entry = entries.get(bundleId);
      if (entry !== undefined) {
        return new ResolvedBundle(entry.withProvenance(source), source);
      }
    }
    throw new BundlerError(`Bundle '${bundleId}' was not found in any configured catalog.`);
  }

  /**
   * Return entries matching *query* (substring over id/name/role/tags/description).
   * Each bundle id appears once, resolved at its highest-precedence source
   * (resolution happens before filtering so a shadowed entry never surfaces).
   * Results are sorted by bundle id.
   */
  async search(query = ''): Promise<ResolvedBundle[]> {
    const needle = query.trim().toLowerCase();
    const resolved = new Map<string, ResolvedBundle>();
    for (const source of this._sources) {
      for (const [bundleId, entry] of await this.entriesFor(source)) {
        if (resolved.has(bundleId)) continue;
        resolved.set(bundleId, new ResolvedBundle(entry.withProvenance(source), source));
      }
    }
    return [...resolved.keys()]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((k) => resolved.get(k)!)
      .filter((r) => !needle || matches(r.entry, needle));
  }
}

function matches(entry: CatalogEntry, needle: string): boolean {
  const haystack = [entry.id, entry.name, entry.role, entry.description, entry.tags.join(' ')]
    .join(' ')
    .toLowerCase();
  return haystack.includes(needle);
}
