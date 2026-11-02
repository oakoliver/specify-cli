/**
 * @oakoliver/specify-cli - Bundle reference expansion
 *
 * Expansion of bundle references into a flat, provenance-aware component plan.
 *
 * Port of ``specify_cli/bundles/expansion.py`` (spec-kit v1.2.5). Python
 * tuples become ``readonly string[]`` chains, ``(kind, id)`` dictionary keys
 * become ``kind\u0000id`` strings, and the loader is async because the port's
 * catalog stack fetches asynchronously.
 *
 * @module bundles/expansion
 */

import { BundlerError } from './index.js';
import { componentDifferences } from './conflict.js';
import { COMPONENT_KINDS, type BundleManifest, type BundleRef, type ComponentRef } from './manifest.js';
import { sameVersion } from './versioning.js';

export const MAX_REFERENCE_DEPTH = 10;
export const MAX_REFERENCED_BUNDLES = 50;

type Chain = readonly string[];

export class LoadedBundle {
  constructor(
    readonly manifest: BundleManifest,
    readonly source_id: string,
    readonly install_allowed: boolean,
    readonly verified = false,
  ) {
    Object.freeze(this);
  }
}

export interface BundleLoader {
  load(ref: BundleRef, chain: Chain): LoadedBundle | Promise<LoadedBundle>;
}

export class ResolvedReference {
  readonly id: string;
  readonly version: string;
  readonly source_id: string;
  readonly install_allowed: boolean;
  readonly via: Chain;
  readonly manifest: BundleManifest;
  readonly verified: boolean;

  constructor(init: {
    id: string;
    version: string;
    source_id: string;
    install_allowed: boolean;
    via: Chain;
    manifest: BundleManifest;
    verified?: boolean;
  }) {
    this.id = init.id;
    this.version = init.version;
    this.source_id = init.source_id;
    this.install_allowed = init.install_allowed;
    this.via = Object.freeze([...init.via]);
    this.manifest = init.manifest;
    this.verified = init.verified ?? false;
    Object.freeze(this);
  }
}

/** A bundle reference does not match the winning catalog source. */
export class SourceMismatchError extends BundlerError {
  override name = 'SourceMismatchError';
  readonly reference: BundleRef;
  readonly actual_source: string;
  readonly chain: Chain;

  constructor(ref: BundleRef, actualSource: string, chain: Chain) {
    super(
      `Bundle reference ${ref.id} (${formatChain(chain)}) requires source ` +
        `'${ref.source}', but the winning catalog is '${actualSource}'.`,
    );
    this.reference = ref;
    this.actual_source = actualSource;
    this.chain = chain;
  }
}

export class ComponentOverride {
  constructor(
    readonly component: ComponentRef,
    readonly origin: Chain,
  ) {
    Object.freeze(this);
  }
}

export class ComponentOrigin {
  constructor(
    readonly origin: Chain,
    readonly overrides: readonly ComponentOverride[] = [],
  ) {
    Object.freeze(this);
  }
}

/** ``(kind, id)`` key for the ``origins`` map. */
export function componentOriginKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

export class ExpandedManifest {
  constructor(
    public root: BundleManifest,
    public components: ComponentRef[],
    public origins: Map<string, ComponentOrigin>,
    public references: ResolvedReference[],
    public warnings: string[],
  ) {}

  static flat(manifest: BundleManifest): ExpandedManifest {
    const origins = new Map<string, ComponentOrigin>();
    for (const component of manifest.components) {
      origins.set(componentOriginKey(component.kind, component.id), new ComponentOrigin([]));
    }
    return new ExpandedManifest(manifest, [...manifest.components], origins, [], []);
  }

  get hasReferences(): boolean {
    return this.references.length > 0;
  }

  /** ``{(kind, id): origin_chain}`` view used by the validator. */
  originChains(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [key, value] of this.origins) out.set(key, [...value.origin]);
    return out;
  }
}

// ============================================================================
// Tuple helpers
// ============================================================================

function compareChains(a: Chain, b: Chain): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/** Python ``(len(a), a) < (len(b), b)``. */
function shorterChain(a: Chain, b: Chain): boolean {
  if (a.length !== b.length) return a.length < b.length;
  return compareChains(a, b) < 0;
}

function chainsEqual(a: Chain, b: Chain): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ============================================================================
// Internal plan model
// ============================================================================

class Entry {
  constructor(
    readonly component: ComponentRef,
    // One record per distinct declaring bundle whose copy agrees with
    // ``component``; the route to each is relative to the current bundle.
    readonly declarations: readonly ComponentOverride[],
    readonly overrides: readonly ComponentOverride[] = [],
  ) {}

  /** Shortest route to a declaring bundle, for display. */
  get origin(): Chain {
    let best: Chain | null = null;
    for (const declaration of this.declarations) {
      if (best === null || shorterChain(declaration.origin, best)) best = declaration.origin;
    }
    if (best === null) throw new Error('min() arg is an empty sequence');
    return best;
  }
}

class OverrideNotice {
  constructor(
    readonly component: ComponentRef,
    readonly declaring: Chain,
    readonly replaced: readonly ComponentOverride[],
  ) {}
}

interface Subplan {
  entries: readonly Entry[];
  reference_paths: Map<string, Chain>;
  longest_path: Chain;
  notices: readonly OverrideNotice[];
}

class ExpansionState {
  readonly loaded = new Map<string, LoadedBundle>();
  readonly subplans = new Map<string, Subplan>();
  readonly versions = new Map<string, [string, Chain]>();
  readonly references: ResolvedReference[] = [];
  private readonly referenceIndexes = new Map<string, number>();
  readonly distinctIds = new Set<string>();

  constructor(readonly loader: BundleLoader) {}

  registerReference(ref: BundleRef, loaded: LoadedBundle, chain: Chain): void {
    const via = chain.slice(1);
    const reference = new ResolvedReference({
      id: ref.id,
      version: ref.version || '',
      source_id: loaded.source_id,
      install_allowed: loaded.install_allowed,
      via,
      manifest: loaded.manifest,
      verified: loaded.verified,
    });
    const index = this.referenceIndexes.get(ref.id);
    if (index === undefined) {
      this.referenceIndexes.set(ref.id, this.references.length);
      this.references.push(reference);
    } else {
      const previous = this.references[index];
      if (via.length < previous.via.length) this.references[index] = reference;
    }
  }

  /** Apply a newly discovered shorter route to cached reference metadata. */
  shortenCachedReferences(subplan: Subplan, chain: Chain): void {
    for (const [referenceId, p] of subplan.reference_paths) {
      const index = this.referenceIndexes.get(referenceId);
      if (index === undefined) continue;
      const previous = this.references[index];
      const via = [...chain.slice(1), ...p.slice(0, -1)];
      if (via.length < previous.via.length) {
        this.references[index] = new ResolvedReference({
          id: previous.id,
          version: previous.version,
          source_id: previous.source_id,
          install_allowed: previous.install_allowed,
          via,
          manifest: previous.manifest,
          verified: previous.verified,
        });
      }
    }
  }
}

export function formatChain(chain: Chain): string {
  return chain.join(' → ');
}

/** Expand *root* using *loader*, without performing any I/O itself. */
export async function expandManifest(root: BundleManifest, loader: BundleLoader): Promise<ExpandedManifest> {
  if (!root.bundles.length) return ExpandedManifest.flat(root);

  const state = new ExpansionState(loader);
  const subplan = await expand(root, [root.bundle.id], state);
  const components = subplan.entries.map((entry) => entry.component);
  const origins = new Map<string, ComponentOrigin>();
  for (const entry of subplan.entries) {
    origins.set(
      componentOriginKey(entry.component.kind, entry.component.id),
      new ComponentOrigin(entry.origin, entry.overrides),
    );
  }
  const warnings = formatWarnings(root, subplan.notices);
  return new ExpandedManifest(root, components, origins, state.references, warnings);
}

/** Compute one completed subplan for a bundle (never cache partial results). */
async function expand(manifest: BundleManifest, chain: Chain, state: ExpansionState): Promise<Subplan> {
  const cached = state.subplans.get(manifest.bundle.id);
  if (cached !== undefined) return cached;

  const candidates = new Map<string, Entry[]>();
  const referenceKeys: string[] = [];
  const referencePaths = new Map<string, Chain>();
  const notices: OverrideNotice[] = [];
  const conflicts: string[] = [];
  let longestPath: Chain = [];

  const ownKeys = new Set(manifest.components.map((c) => componentOriginKey(c.kind, c.id)));

  for (const ref of manifest.bundles) {
    if (chain.length > MAX_REFERENCE_DEPTH) {
      throw new BundlerError(
        `Bundle reference depth exceeds ${MAX_REFERENCE_DEPTH}: ${formatChain([...chain, ref.id])}.`,
      );
    }
    if (chain.includes(ref.id)) {
      throw new BundlerError(`Bundle reference cycle: ${formatChain([...chain, ref.id])}`);
    }

    const oldVersion = state.versions.get(ref.id);
    if (oldVersion !== undefined && !sameVersion(oldVersion[0], ref.version || '')) {
      throw new BundlerError(
        `Bundle '${ref.id}' is referenced at versions ${oldVersion[0]} ` +
          `(${formatChain(oldVersion[1])}) and ${ref.version || '<unpinned>'} ` +
          `(${formatChain(chain)}); choose referencing releases that pin ` +
          'the same version on every route.',
      );
    }
    if (oldVersion === undefined) state.versions.set(ref.id, [ref.version || '', chain]);

    if (!state.distinctIds.has(ref.id)) {
      if (state.distinctIds.size >= MAX_REFERENCED_BUNDLES) {
        throw new BundlerError(
          `Bundle reference expansion exceeds the limit of ` +
            `${MAX_REFERENCED_BUNDLES} distinct bundles ` +
            `(${formatChain([...chain, ref.id])}).`,
        );
      }
      state.distinctIds.add(ref.id);
    }

    let loaded = state.loaded.get(ref.id);
    if (loaded === undefined) {
      try {
        loaded = await state.loader.load(ref, chain);
      } catch (exc) {
        // The loader has already included the reference chain and the winning
        // catalog in a source-mismatch diagnostic; do not wrap it again.
        if (exc instanceof SourceMismatchError) throw exc;
        if (exc instanceof BundlerError) {
          throw new BundlerError(
            `Cannot resolve bundle reference ` +
              `${ref.id}@${ref.version || '<unpinned>'} ` +
              `(${formatChain(chain)}): ${exc.message}`,
            { cause: exc },
          );
        }
        throw exc;
      }
      if (loaded.manifest.bundle.id !== ref.id) {
        throw new BundlerError(`Bundle reference ${ref.id} loaded manifest for '${loaded.manifest.bundle.id}'.`);
      }
      if (!sameVersion(loaded.manifest.bundle.version, ref.version || '')) {
        throw new BundlerError(
          `Bundle reference ${ref.id}@${ref.version || '<unpinned>'} ` +
            `loaded manifest version ${loaded.manifest.bundle.version}.`,
        );
      }
      state.loaded.set(ref.id, loaded);
    }

    if (ref.source !== null && ref.source !== loaded.source_id) {
      throw new SourceMismatchError(ref, loaded.source_id, chain);
    }

    state.registerReference(ref, loaded, chain);
    let child = state.subplans.get(ref.id);
    if (child === undefined) child = await expand(loaded.manifest, [...chain, ref.id], state);
    // longest_path excludes the child itself. This check is deliberately
    // repeated for cache hits: a shallow first route cannot evade a limit.
    if (chain.length + child.longest_path.length > MAX_REFERENCE_DEPTH) {
      throw new BundlerError(
        `Bundle reference depth exceeds ${MAX_REFERENCE_DEPTH}: ` +
          `${formatChain([...chain, ref.id, ...child.longest_path])}.`,
      );
    }
    state.shortenCachedReferences(child, [...chain, ref.id]);

    const childPrefix: Chain = [ref.id];
    if (childPrefix.length + child.longest_path.length > longestPath.length) {
      longestPath = [...childPrefix, ...child.longest_path];
    }
    shortestPath(referencePaths, ref.id, childPrefix);
    for (const [descendant, p] of child.reference_paths) {
      shortestPath(referencePaths, descendant, [...childPrefix, ...p]);
    }
    for (const childEntry of child.entries) {
      mergeCandidate(prefixEntry(childEntry, childPrefix), candidates, referenceKeys, ownKeys, conflicts, chain);
    }
    for (const notice of child.notices) appendNotice(notices, prefixNotice(notice, childPrefix));
  }

  // Apply the current bundle's own declarations after all referenced plans.
  const ownManifestKeys = manifest.components.map((c) => componentOriginKey(c.kind, c.id));
  for (const component of manifest.components) {
    const key = componentOriginKey(component.kind, component.id);
    const existing = candidates.get(key) ?? [];
    const [entry, notice] = declareOwn(component, existing);
    candidates.set(key, [entry]);
    if (notice !== null) appendNotice(notices, notice);
  }

  if (conflicts.length) throw new BundlerError('Bundle component conflicts:\n' + conflicts.join('\n'));

  const ordered = [...referenceKeys.filter((k) => !ownKeys.has(k)), ...ownManifestKeys];
  const entries = stableKeys(ordered).map((key) => candidates.get(key)![0]);
  const result: Subplan = {
    entries,
    reference_paths: new Map(referencePaths),
    longest_path: longestPath,
    notices: [...notices],
  };
  state.subplans.set(manifest.bundle.id, result);
  return result;
}

/** The only way to build an ``Entry``; applies I3 to both histories. */
function entryFor(
  component: ComponentRef,
  declarations: Iterable<ComponentOverride>,
  overrides: Iterable<ComponentOverride> = [],
): Entry {
  return new Entry(component, mergeDeclarations(declarations), mergeDeclarations(overrides));
}

/** Merge declaration records to one per component and declaring bundle. */
function mergeDeclarations(...groups: Array<Iterable<ComponentOverride>>): ComponentOverride[] {
  const best = new Map<string, ComponentOverride>();
  for (const group of groups) {
    for (const declaration of group) {
      const key = JSON.stringify([declaration.component.identity(), declaration.origin.slice(-1)]);
      const current = best.get(key);
      if (current === undefined || shorterChain(declaration.origin, current.origin)) {
        // Python dicts keep the original insertion position on reassignment.
        best.set(key, declaration);
      }
    }
  }
  return [...best.values()];
}

function mergeCandidate(
  entry: Entry,
  candidates: Map<string, Entry[]>,
  referenceKeys: string[],
  ownKeys: Set<string>,
  conflicts: string[],
  declaringChain: Chain,
): void {
  const key = componentOriginKey(entry.component.kind, entry.component.id);
  const existing = candidates.get(key);
  if (existing === undefined) {
    candidates.set(key, [entry]);
    referenceKeys.push(key);
    return;
  }

  const differences = existing.map((previous) => componentDifferences(previous.component, entry.component));
  if (differences.some((d) => d.length) && !ownKeys.has(key)) {
    // Compare each newly encountered spelling to the first spelling. This
    // reports every differing field while keeping one diagnostic per pair.
    const previous = existing[differences.findIndex((fields) => fields.length > 0)];
    conflicts.push(formatConflict(previous, entry, declaringChain));
    return;
  }

  // A shared dependency can arrive through multiple routes, and distinct
  // bundles can declare the same component. Merge an agreeing copy into the
  // existing candidate, keeping each distinct declaring bundle so a later
  // override can name all of them. Preserve the first component spelling.
  for (let index = 0; index < differences.length; index++) {
    if (!differences[index].length) {
      const previous = existing[index];
      existing[index] = entryFor(
        previous.component,
        [...previous.declarations, ...entry.declarations],
        [...previous.overrides, ...entry.overrides],
      );
      return;
    }
  }

  if (ownKeys.has(key)) existing.push(entry);
}

/**
 * Entry for a bundle's own declaration over any referenced copies. Every
 * declaration of a differing referenced copy is discarded and recorded, one
 * per declaring bundle. Agreeing copies are not overrides.
 */
function declareOwn(component: ComponentRef, existing: Entry[]): [Entry, OverrideNotice | null] {
  const inherited = existing.flatMap((entry) => [...entry.overrides]);
  const replaced = existing
    .filter((entry) => componentDifferences(entry.component, component).length > 0)
    .flatMap((entry) => [...entry.declarations]);
  const agreeing = existing
    .filter((entry) => componentDifferences(entry.component, component).length === 0)
    .flatMap((entry) => [...entry.declarations]);
  const entry = entryFor(component, [new ComponentOverride(component, []), ...agreeing], [...inherited, ...replaced]);
  const notice = replaced.length ? new OverrideNotice(component, [], replaced) : null;
  return [entry, notice];
}

function stableKeys(ordered: string[]): string[] {
  const kindOrder = new Map<string, number>(COMPONENT_KINDS.map((kind, index) => [kind, index]));
  const rank = (key: string): number => kindOrder.get(key.split('\u0000', 1)[0]) ?? kindOrder.size;
  // Array.prototype.sort is stable, like Python's sorted().
  return [...ordered].sort((a, b) => rank(a) - rank(b));
}

function prefixDeclarations(declarations: readonly ComponentOverride[], prefix: Chain): ComponentOverride[] {
  return declarations.map((d) => new ComponentOverride(d.component, [...prefix, ...d.origin]));
}

function prefixEntry(entry: Entry, prefix: Chain): Entry {
  return entryFor(
    entry.component,
    prefixDeclarations(entry.declarations, prefix),
    prefixDeclarations(entry.overrides, prefix),
  );
}

function prefixNotice(notice: OverrideNotice, prefix: Chain): OverrideNotice {
  return new OverrideNotice(
    notice.component,
    [...prefix, ...notice.declaring],
    prefixDeclarations(notice.replaced, prefix),
  );
}

function noticeKey(notice: OverrideNotice): string {
  return JSON.stringify([
    notice.declaring.length ? notice.declaring[notice.declaring.length - 1] : null,
    notice.component.kind,
    notice.component.id,
  ]);
}

function appendNotice(notices: OverrideNotice[], notice: OverrideNotice): void {
  const key = noticeKey(notice);
  for (let index = 0; index < notices.length; index++) {
    const previous = notices[index];
    if (noticeKey(previous) === key) {
      if (notice.declaring.length < previous.declaring.length) notices[index] = notice;
      return;
    }
  }
  notices.push(notice);
}

function shortestPath(paths: Map<string, Chain>, key: string, p: Chain): void {
  const old = paths.get(key);
  if (old === undefined || p.length < old.length) paths.set(key, p);
}

function displayValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return field === 'version' ? '<unpinned>' : '<unset>';
  return String(value);
}

function fieldValue(component: ComponentRef, field: string): unknown {
  return (component as unknown as Record<string, unknown>)[field];
}

function fieldText(component: ComponentRef, field: string): string {
  return `${field} ${displayValue(field, fieldValue(component, field))}`;
}

function componentName(component: ComponentRef): string {
  return `${component.kind.slice(0, -1)} '${component.id}'`;
}

function formatConflict(a: Entry, b: Entry, declaringChain: Chain): string {
  const fields = componentDifferences(a.component, b.component);
  const left = fields.map((field) => fieldText(a.component, field)).join('; ');
  const right = fields.map((field) => fieldText(b.component, field)).join('; ');
  const leftChain = formatChain([...declaringChain, ...a.origin]);
  const rightChain = formatChain([...declaringChain, ...b.origin]);
  return (
    `${componentName(a.component)}: ${left} (${leftChain}) vs ${right} ` +
    `(${rightChain}); declare '${a.component.id}' in ` +
    `'${declaringChain[declaringChain.length - 1]}' to choose.`
  );
}

function formatWarnings(root: BundleManifest, notices: readonly OverrideNotice[]): string[] {
  const warnings: string[] = [];
  for (const notice of notices) {
    const ownChain = formatChain([root.bundle.id, ...notice.declaring]);
    const differencesByEntry = notice.replaced.map((replaced) => componentDifferences(replaced.component, notice.component));
    const fieldsByEntry = notice.replaced.map((replaced, i) => {
      const oldChain = formatChain([root.bundle.id, ...replaced.origin]);
      return differencesByEntry[i]
        .map((field) => `${field} ${displayValue(field, fieldValue(replaced.component, field))} from ${oldChain}`)
        .join(' and ');
    });
    const fields = [...new Set(differencesByEntry.flat())];
    const ownFields = fields
      .map((field) => `${field} ${displayValue(field, fieldValue(notice.component, field))}`)
      .join(' and ');
    warnings.push(
      `${componentName(notice.component)} ${ownFields} (${ownChain}) overrides ${fieldsByEntry.join(' and ')}.`,
    );
  }
  return warnings;
}

/** Return install-policy errors for references from discovery-only sources. */
export function discoveryOnlyMessages(expanded: ExpandedManifest): string[] {
  const messages: string[] = [];
  for (const reference of expanded.references) {
    if (reference.install_allowed) continue;
    const chain = [expanded.root.bundle.id, ...reference.via, reference.id];
    messages.push(
      `Bundle '${reference.id}' (${formatChain(chain)}) resolves only from ` +
        `discovery-only source '${reference.source_id}'; it cannot be ` +
        'installed from there.',
    );
  }
  return messages;
}

export function requireInstallable(expanded: ExpandedManifest): void {
  const messages = discoveryOnlyMessages(expanded);
  if (messages.length) throw new BundlerError(messages[0]);
}

// Exported for tests that mirror upstream's private-helper coverage.
export const _internals = { chainsEqual, compareChains };
