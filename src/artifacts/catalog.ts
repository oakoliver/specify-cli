/**
 * @oakoliver/specify-cli - Artifact inventory and catalog
 *
 * Port of spec-kit v1.0.12 ``specify_cli/artifacts/catalog.py``. Public entry
 * points:
 *
 * - ``ArtifactCatalog.listArtifacts`` — flat inventory (id, name, kind, description).
 * - ``ArtifactCatalog.listArtifactsWithStack`` — inventory rows plus stacks.
 * - ``ArtifactCatalog.getArtifactInfo`` — one row plus its full ordered stack.
 * - ``ArtifactCatalog.getContributionInfo`` — resolve a stack ``lookupId``.
 *
 * @module artifacts/catalog
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import { CommandRegistrar } from '../agents.js';
import { locateCorePack } from '../assets.js';
import { loadInitOptions } from '../init-options.js';
import { IntegrationBase } from '../integrations/base.js';
import { HookExecutor } from '../extensions/hooks.js';
import { ExtensionManager } from '../extensions/manager.js';
import {
  CORE_COMMAND_NAMES,
  DEFAULT_HOOK_PRIORITY,
  ExtensionManifest,
  coerceHookEntries,
  normalizePriority,
} from '../extensions/manifest.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { PresetManager } from '../presets/manager.js';
import { PresetError } from '../presets/manifest.js';
import { PresetResolver } from '../presets/resolver.js';
import { parseYaml } from '../yaml.js';
import { compareCodePoints, isPlainObject, shlexSplit } from '../events/py-compat.js';

import {
  IdentifierComponentError,
  deriveHookLookupId,
  deriveHookPublicId,
  derivePublicId,
  parseHookArtifactName,
  parseLookupId,
  validateComponent,
} from './identifiers.js';
import {
  AmbiguousArtifactError,
  Artifact,
  ArtifactNotFoundError,
  ArtifactResolutionError,
  ContributionNotFoundError,
  HookArtifact,
  HookStackEntry,
  NotASpecKitProjectError,
  type ArtifactKind,
} from './models.js';
import {
  buildStack,
  isDir,
  isFile,
  isOSError,
  layerProvenance,
  relativePosix,
  repoRelativeExistingFile,
  resolvePathLoose,
  type ArtifactManifestLike,
  type ManifestCache,
  type RawLayer,
} from './resolution.js';

// ============================================================================
// Constants & helpers
// ============================================================================

const TEMPLATE_SUFFIX = '.md';
const SCRIPT_SUFFIX = '.sh';

type NamedKind = Exclude<ArtifactKind, 'hook'>;
type LayersCache = Map<string, RawLayer[]>;

function cacheKey(kind: string, name: string): string {
  return `${kind}\u0000${name}`;
}

/** Python ``Path.suffix``. */
function suffixOf(fileName: string): string {
  const ext = extname(fileName);
  return ext === fileName ? '' : ext;
}

/** Python ``Path.stem``. */
function stemOf(fileName: string): string {
  const suffix = suffixOf(fileName);
  return suffix ? fileName.slice(0, -suffix.length) : fileName;
}

function sortedDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort(compareCodePoints);
  } catch (e) {
    if (isOSError(e)) throw e;
    return [];
  }
}

function rethrowResolution(e: unknown): never {
  if (e instanceof PresetError || isOSError(e)) throw new ArtifactResolutionError();
  throw e;
}

/** Resolve a command script reference that remains inside *scriptRoot*. */
export function resolveScriptReference(scriptRoot: string, token: string): string | null {
  if (token.startsWith('/') || token.startsWith('\\') || /^[A-Za-z]:/.test(token)) return null;
  const posixParts = token.split('/');
  const windowsParts = token.split(/[\\/]/);
  if (posixParts.includes('..') || windowsParts.includes('..')) return null;

  let parts = token.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length && parts[0] === 'scripts') parts = parts.slice(1);
  if (!parts.length) return null;

  const resolvedRoot = resolvePathLoose(scriptRoot);
  const candidate = resolvePathLoose(join(resolvedRoot, ...parts));
  if (relativePosix(candidate, resolvedRoot) === null) return null;
  return isFile(candidate) ? candidate : null;
}

/**
 * Patch points mirroring upstream monkeypatching of
 * ``specify_cli.artifacts.catalog._locate_shared_asset_dir`` in tests.
 */
export const artifactCatalogHooks: { locateSharedAssetDir: (subdir: string) => string | null } = {
  locateSharedAssetDir: (subdir) => defaultLocateSharedAssetDir(subdir),
};

function locateSharedAssetDir(subdir: string): string | null {
  return artifactCatalogHooks.locateSharedAssetDir(subdir);
}

/** Locate a core asset directory (bundled ``core_pack``). */
function defaultLocateSharedAssetDir(subdir: string): string | null {
  if (!['commands', 'scripts', 'templates'].includes(subdir)) return null;
  const corePack = locateCorePack();
  const bundled = corePack !== null && corePack !== undefined ? join(corePack, subdir) : null;
  if (bundled !== null && isDir(bundled)) return bundled;
  return null;
}

/** Return the project-local built-in-tier directory for an asset family, if present. */
function projectCoreAssetRoot(projectRoot: string | null, subdir: string): string | null {
  if (projectRoot === null) return null;
  if (!['commands', 'scripts', 'templates'].includes(subdir)) return null;
  let candidate = new PresetResolver(projectRoot).templatesDir;
  if (subdir !== 'templates') candidate = join(candidate, subdir);
  return isDir(candidate) ? candidate : null;
}

function coreCommandLogicalName(stem: string): string {
  return stem.startsWith('speckit.') ? stem : `speckit.${stem}`;
}

/** Return the ``description`` value from YAML frontmatter, else ``""``. */
export function extractFrontmatterDescription(text: string): string {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (!lines.length || lines[0]!.replace(/[\r\n]+$/, '') !== '---') return '';
  let fenceEnd = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.replace(/[\r\n]+$/, '') === '---') {
      fenceEnd = i;
      break;
    }
  }
  if (fenceEnd === -1) return '';
  let data: unknown;
  try {
    data = parseYaml(lines.slice(1, fenceEnd).join(''));
  } catch {
    return '';
  }
  if (!isPlainObject(data)) return '';
  const value = Object.prototype.hasOwnProperty.call(data, 'description') ? data.description : '';
  return typeof value === 'string' ? value : '';
}

/** Python ``str.strip()`` then ``splitlines()`` first element. */
function firstLine(text: string): string | null {
  const stripped = text.trim();
  if (!stripped) return null;
  return stripped.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)[0]!;
}

/** Return the first docstring/comment line of a script, else ``""``. */
export function extractScriptDescription(text: string): string {
  const py = /^(?:#![^\n]*\n)?\s*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(text);
  if (py) {
    const first = firstLine(py[1]!);
    if (first !== null) return first.trim();
  }
  const ps = /^(?:<#\s*([\s\S]*?)#>)/.exec(text);
  if (ps) {
    const first = firstLine(ps[1]!);
    if (first !== null) return first.trim().replace(/^\.+/, '').trim();
  }
  for (const raw of text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)) {
    const stripped = raw.trim();
    if (!stripped || stripped.startsWith('#!')) continue;
    if (stripped.startsWith('#')) return stripped.replace(/^#+/, '').trim();
    break;
  }
  return '';
}

function describeArtifactFile(path: string, kind: ArtifactKind): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
  } catch {
    return '';
  }
  return kind === 'script' ? extractScriptDescription(text) : extractFrontmatterDescription(text);
}

function validateProject(projectRoot: string): void {
  if (!isDir(join(projectRoot, '.specify'))) throw new NotASpecKitProjectError();
}

function validateExtensionRegistry(projectRoot: string): void {
  const extensionsDir = join(projectRoot, '.specify', 'extensions');
  let exists = false;
  try {
    readdirSync(extensionsDir);
    exists = true;
  } catch {
    exists = isFile(extensionsDir);
  }
  if (!exists) return;
  if (new ExtensionRegistry(extensionsDir).isCorrupt()) throw new ArtifactResolutionError();
}

/** Parse ``kind:name`` shorthand and reconcile it with an explicit ``--kind`` flag. */
export function resolveKindHint(name: string, kind: ArtifactKind | null): [string, ArtifactKind | null] {
  if (kind === 'hook') {
    if (name.startsWith('hook:')) {
      const candidate = name.slice('hook:'.length);
      try {
        parseHookArtifactName(candidate);
        return [candidate, 'hook'];
      } catch (e) {
        if (!(e instanceof IdentifierComponentError)) throw e;
      }
    }
    return [name, 'hook'];
  }
  const idx = name.indexOf(':');
  if (idx !== -1) {
    const prefix = name.slice(0, idx);
    const bare = name.slice(idx + 1);
    if (prefix === 'command' || prefix === 'template' || prefix === 'script') {
      if (kind !== null && kind !== prefix) throw new ArtifactNotFoundError(name);
      return [bare, prefix];
    }
    if (prefix === 'hook') {
      if (kind !== null) throw new ArtifactNotFoundError(name); // kind is never 'hook' here
      return [bare, 'hook'];
    }
  }
  return [name, kind];
}

function validateArtifactName(name: string, kind: ArtifactKind): string {
  if (kind === 'hook') {
    try {
      parseHookArtifactName(name);
    } catch (e) {
      if (e instanceof IdentifierComponentError) throw new ArtifactNotFoundError(name);
      throw e;
    }
    return name;
  }
  try {
    return validateComponent(name, `${kind} name`);
  } catch (e) {
    if (e instanceof IdentifierComponentError) throw new ArtifactNotFoundError(name);
    throw e;
  }
}

function isValidArtifactNameComponent(name: unknown, kind: ArtifactKind): boolean {
  try {
    validateComponent(name, `${kind} name`);
    return true;
  } catch {
    return false;
  }
}

/** Python truthiness. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

const CONVENTION_SUBDIRS: ReadonlyArray<[string, NamedKind, string]> = [
  ['commands', 'command', TEMPLATE_SUFFIX],
  ['templates', 'template', TEMPLATE_SUFFIX],
  ['scripts', 'script', SCRIPT_SUFFIX],
];

/** Yield ``[kind, name, path]`` for files exposed by convention. */
export function* iterConventionContributions(packDir: string): Generator<[NamedKind, string, string]> {
  for (const [subdir, kind, suffix] of CONVENTION_SUBDIRS) {
    const candidateDir = join(packDir, subdir);
    if (!isDir(candidateDir)) continue;
    for (const entry of sortedDir(candidateDir)) {
      const full = join(candidateDir, entry);
      if (isFile(full) && suffixOf(entry) === suffix && !stemOf(entry).includes(':')) {
        yield [kind, stemOf(entry), full];
      }
    }
  }
  if (!isDir(packDir)) return;
  for (const entry of sortedDir(packDir)) {
    const full = join(packDir, entry);
    if (isFile(full) && suffixOf(entry) === TEMPLATE_SUFFIX && !stemOf(entry).includes(':')) {
      yield ['template', stemOf(entry), full];
    }
  }
}

interface HookDeclaration {
  id: string;
  sourceId: string;
  runtimeExtensionId: string;
  manifestPath: string;
  lookupId: string;
  eventName: string;
  command: string;
  description: unknown;
  priority: number;
  optional: boolean;
}

type ExtensionManifestView = ArtifactManifestLike & {
  readonly id: string;
  readonly hooks: Record<string, unknown> | null;
  readonly commands: unknown[];
  readonly scripts: unknown[];
};

function loadExtensionManifestSafe(manifestPath: string): ExtensionManifestView | null {
  if (!isFile(manifestPath)) return null;
  try {
    return new ExtensionManifest(manifestPath) as unknown as ExtensionManifestView;
  } catch {
    return null;
  }
}

// ============================================================================
// ArtifactCatalog — public façade
// ============================================================================

/** Read-only view over one Spec Kit project's artifact inventory. */
export class ArtifactCatalog {
  constructor(readonly projectRoot: string) {}

  // ------------------------------------------------------------------ list

  /** Return every artifact Spec Kit exposes for this project, deduped. */
  listArtifacts(): Array<Artifact | HookArtifact> {
    const { artifacts, resolver } = this.collectInventory();
    const { rows } = this.collectHookInventory(resolver);
    return [...artifacts, ...rows];
  }

  /** Return list rows enriched with each artifact's full composition stack. */
  listArtifactsWithStack(): Array<Record<string, unknown>> {
    const { artifacts, layersCache, resolver, manifestCache } = this.collectInventory();
    const rows: Array<Record<string, unknown>> = [];
    for (const artifact of artifacts) {
      const stack = buildStack(
        this.projectRoot,
        artifact.kind,
        artifact.name,
        layersCache.get(cacheKey(artifact.kind, artifact.name)) ?? null,
        resolver,
        manifestCache,
      );
      const row = artifact.toJsonDict();
      row.stack = stack.map((layer) => layer.toJsonDict());
      rows.push(row);
    }
    const hooks = this.collectHookInventory(resolver);
    for (const hook of hooks.rows) {
      const row = hook.toJsonDict();
      row.stack = hooks.stackCache.get(cacheKey(hook.eventName, hook.targetCommand))!.map((e) => e.toJsonDict());
      rows.push(row);
    }
    return rows;
  }

  // ------------------------------------------------------------------ info

  /** Return the full JSON-ready dict for ``specify artifact info``. */
  getArtifactInfo(name: string, kind: ArtifactKind | null = null): Record<string, unknown> {
    const [bare, hinted] = resolveKindHint(name, kind);
    let resolvedKind = hinted;

    if (resolvedKind === 'hook') return this.getHookInfo(bare, name);

    const { artifacts: inventory, layersCache, resolver, manifestCache } = this.collectInventory();
    if (resolvedKind === null) {
      const matches: Array<[ArtifactKind, string]> = inventory
        .filter((artifact) => artifact.name === bare)
        .map((artifact) => [artifact.kind, artifact.name]);
      const hookRows = this.collectHookInventory(resolver).rows;
      if (hookRows.some((row) => row.name === bare)) matches.push(['hook', bare]);
      if (!matches.length) throw new ArtifactNotFoundError(name);
      if (matches.length > 1) throw new AmbiguousArtifactError(bare, matches.map(([k]) => k));
      resolvedKind = matches[0]![0];
      if (resolvedKind === 'hook') return this.getHookInfo(bare, name, resolver);
    }

    const validatedName = validateArtifactName(bare, resolvedKind);
    const artifact = inventory.find((item) => item.kind === resolvedKind && item.name === validatedName);
    if (!artifact) throw new ArtifactNotFoundError(name);
    const stack = buildStack(
      this.projectRoot,
      resolvedKind,
      validatedName,
      layersCache.get(cacheKey(resolvedKind, validatedName)) ?? null,
      resolver,
      manifestCache,
    );
    if (!stack.length) throw new ArtifactNotFoundError(name);

    return {
      id: derivePublicId(resolvedKind, validatedName),
      name: validatedName,
      kind: resolvedKind,
      description: artifact.description,
      stack: stack.map((layer) => layer.toJsonDict()),
    };
  }

  /** Resolve a stack ``lookupId`` to its validated manifest entry. */
  getContributionInfo(lookupId: string): Record<string, unknown> {
    validateProject(this.projectRoot);
    validateExtensionRegistry(this.projectRoot);
    let parsed: [string, string, string, string];
    try {
      parsed = parseLookupId(lookupId);
    } catch (e) {
      if (e instanceof IdentifierComponentError) throw new ContributionNotFoundError(lookupId);
      throw e;
    }
    const [layer, sourceId, kind, name] = parsed;
    if (layer === 'project') throw new ContributionNotFoundError(lookupId);

    const resolver = new PresetResolver(this.projectRoot);
    let resolved: [Record<string, unknown>, string, string | null] | null;
    try {
      resolved =
        layer === 'preset'
          ? this.findPresetContribution(resolver, sourceId, kind, name)
          : this.findExtensionContribution(resolver, sourceId, kind, name);
    } catch (e) {
      rethrowResolution(e);
    }
    if (resolved === null) throw new ContributionNotFoundError(lookupId);

    const [contribution, manifestPath, sourcePath] = resolved;
    return {
      id: lookupId,
      layer,
      sourceId,
      kind,
      name,
      manifestPath,
      sourcePath,
      contribution,
    };
  }

  private findPresetContribution(
    resolver: PresetResolver,
    sourceId: string,
    kind: string,
    name: string,
  ): [Record<string, unknown>, string, string | null] | null {
    for (const [packId] of resolver.getAllPresetsByPriority()) {
      if (packId !== sourceId) continue;
      const packDir = join(resolver.presetsDir, packId);
      const manifest = resolver.getManifest(packDir) as unknown as ArtifactManifestLike | null;
      if (manifest === null) return null;
      for (const entry of manifest.templates) {
        if (isPlainObject(entry) && entry.type === kind && entry.name === name) {
          return this.contributionResult(entry, packDir, manifest.path);
        }
      }
    }
    return null;
  }

  private findExtensionContribution(
    resolver: PresetResolver,
    sourceId: string,
    kind: string,
    name: string,
  ): [Record<string, unknown>, string, string | null] | null {
    for (const [, extensionId] of resolver.getAllExtensionsByPriority()) {
      if (extensionId !== sourceId) continue;
      const extensionDir = join(resolver.extensionsDir, extensionId);
      const manifestPath = join(extensionDir, 'extension.yml');
      let manifest: ExtensionManifestView;
      try {
        manifest = new ExtensionManifest(manifestPath) as unknown as ExtensionManifestView;
      } catch {
        return null;
      }
      if (kind === 'hook') {
        const [eventName, command] = parseHookArtifactName(name);
        let matching: Record<string, unknown> | null = null;
        const hookConfig = (manifest.hooks ?? {})[eventName];
        for (const entry of coerceHookEntries(hookConfig)) {
          if (isPlainObject(entry) && entry.command === command) matching = entry;
        }
        if (matching === null) return null;
        const relativeManifest = repoRelativeExistingFile(this.projectRoot, manifest.path);
        if (relativeManifest === null) throw new ArtifactResolutionError();
        return [{ ...matching, eventName }, relativeManifest, null];
      }
      const table: Record<string, unknown[]> = {
        command: manifest.commands,
        template: manifest.templates,
        script: manifest.scripts,
      };
      for (const entry of table[kind] ?? []) {
        if (isPlainObject(entry) && entry.name === name) {
          return this.contributionResult(entry, extensionDir, manifest.path);
        }
      }
    }
    return null;
  }

  private contributionResult(
    entry: Record<string, unknown>,
    packDir: string,
    manifestPath: string,
  ): [Record<string, unknown>, string, string | null] {
    const relativeManifest = repoRelativeExistingFile(this.projectRoot, manifestPath);
    if (relativeManifest === null) throw new ArtifactResolutionError();
    const relativeFile = entry.file;
    let sourcePath: string | null = null;
    if (typeof relativeFile === 'string') {
      const resolvedPack = resolvePathLoose(packDir);
      const candidate = join(packDir, relativeFile);
      if (relativePosix(resolvePathLoose(candidate), resolvedPack) !== null) {
        sourcePath = repoRelativeExistingFile(this.projectRoot, candidate);
      }
    }
    return [{ ...entry }, relativeManifest, sourcePath];
  }

  private getHookInfo(
    bareName: string,
    originalArgument: string,
    resolver: PresetResolver | null = null,
  ): Record<string, unknown> {
    validateArtifactName(bareName, 'hook');
    const [eventName, command] = parseHookArtifactName(bareName);
    const { rows, stackCache } = this.collectHookInventory(resolver);
    for (const row of rows) {
      if (row.eventName !== eventName || row.targetCommand !== command) continue;
      const payload = row.toJsonDict();
      payload.stack = stackCache.get(cacheKey(eventName, command))!.map((e) => e.toJsonDict());
      return payload;
    }
    throw new ArtifactNotFoundError(originalArgument);
  }

  /** Project declared hooks and existing runtime bindings into artifact rows. */
  collectHookInventory(resolverArg: PresetResolver | null = null): {
    rows: HookArtifact[];
    stackCache: Map<string, HookStackEntry[]>;
  } {
    let resolver = resolverArg;
    if (resolver === null) {
      validateProject(this.projectRoot);
      validateExtensionRegistry(this.projectRoot);
      resolver = new PresetResolver(this.projectRoot);
    }

    const grouped = new Map<string, { eventName: string; command: string; decls: Array<[number, HookDeclaration]> }>();
    const extensionManager = new ExtensionManager(this.projectRoot);
    let insertionIndex = 0;

    try {
      for (const [, extensionId, metadata] of resolver.getAllExtensionsByPriority()) {
        const extensionDir = join(resolver.extensionsDir, extensionId);
        const manifest: ExtensionManifestView | null =
          metadata !== null && metadata !== undefined
            ? ((extensionManager.getExtension(extensionId) as unknown as ExtensionManifestView | null) ?? null)
            : loadExtensionManifestSafe(join(extensionDir, 'extension.yml'));
        if (manifest === null) continue;

        const manifestPath = repoRelativeExistingFile(this.projectRoot, manifest.path);
        if (manifestPath === null) throw new ArtifactResolutionError();
        const sourceId = extensionId;

        for (const [eventName, hookConfig] of Object.entries(manifest.hooks ?? {})) {
          const entriesByCommand = new Map<string, [Record<string, unknown>, string, string]>();
          for (const entry of coerceHookEntries(hookConfig)) {
            if (!isPlainObject(entry)) continue;
            const command = entry.command;
            let publicId: string;
            let lookupId: string;
            try {
              publicId = deriveHookPublicId(eventName, command);
              lookupId = deriveHookLookupId('extension', sourceId, eventName, command);
            } catch (e) {
              if (e instanceof IdentifierComponentError) continue;
              throw e;
            }
            const cmd = command as string;
            entriesByCommand.delete(cmd);
            entriesByCommand.set(cmd, [entry, publicId, lookupId]);
          }

          for (const [command, [entry, publicId, lookupId]] of entriesByCommand) {
            insertionIndex += 1;
            const declaration: HookDeclaration = {
              id: publicId,
              sourceId,
              runtimeExtensionId: manifest.id,
              manifestPath,
              lookupId,
              eventName,
              command,
              description: Object.prototype.hasOwnProperty.call(entry, 'description') ? entry.description : '',
              priority: normalizePriority(entry.priority, DEFAULT_HOOK_PRIORITY),
              optional: truthy(Object.prototype.hasOwnProperty.call(entry, 'optional') ? entry.optional : true),
            };
            const key = cacheKey(eventName, command);
            if (!grouped.has(key)) grouped.set(key, { eventName, command, decls: [] });
            grouped.get(key)!.decls.push([insertionIndex, declaration]);
          }
        }
      }
    } catch (e) {
      rethrowResolution(e);
    }

    const hookExecutor = new HookExecutor(this.projectRoot);
    const enabledByEvent = new Map<string, Array<Record<string, unknown>>>();
    const rows: HookArtifact[] = [];
    const stackCache = new Map<string, HookStackEntry[]>();

    for (const [key, { eventName, command, decls }] of grouped) {
      if (!enabledByEvent.has(eventName)) {
        enabledByEvent.set(
          eventName,
          hookExecutor.getHooksForEvent(eventName) as unknown as Array<Record<string, unknown>>,
        );
      }
      const enabledBindings = enabledByEvent.get(eventName)!;
      const ordered = [...decls].sort((a, b) => a[1].priority - b[1].priority || a[0] - b[0]);
      const stackEntries = ordered.map(
        ([, declaration]) =>
          new HookStackEntry({
            id: declaration.id,
            layer: 'extension',
            sourceId: declaration.sourceId,
            presetId: null,
            presetName: null,
            strategy: 'additive',
            active: enabledBindings.some(
              (binding) => binding.extension === declaration.runtimeExtensionId && binding.command === command,
            ),
            hidden: false,
            manifestPath: declaration.manifestPath,
            lookupId: declaration.lookupId,
            sourcePath: null,
            priority: declaration.priority,
            optional: declaration.optional,
          }),
      );
      stackCache.set(key, stackEntries);
      const described = ordered.find(
        ([, declaration]) => typeof declaration.description === 'string' && declaration.description,
      );
      const description = described ? (described[1].description as string) : '';
      const publicId = deriveHookPublicId(eventName, command);
      rows.push(
        new HookArtifact({
          id: publicId,
          name: publicId.slice('hook:'.length),
          kind: 'hook',
          description,
          eventName,
          targetCommand: command,
          registered: stackEntries.some((entry) => entry.active),
        }),
      );
    }

    rows.sort((a, b) => {
      const byEvent = compareCodePoints(a.eventName, b.eventName);
      if (byEvent !== 0) return byEvent;
      const pa = stackCache.get(cacheKey(a.eventName, a.targetCommand))![0]!.priority;
      const pb = stackCache.get(cacheKey(b.eventName, b.targetCommand))![0]!.priority;
      return pa - pb;
    });
    return { rows, stackCache };
  }

  // -------------------------------------------------------------- internals

  private collectInventory(): {
    artifacts: Artifact[];
    layersCache: LayersCache;
    resolver: PresetResolver;
    manifestCache: ManifestCache;
  } {
    validateProject(this.projectRoot);
    validateExtensionRegistry(this.projectRoot);

    const resolver = new PresetResolver(this.projectRoot);
    const layersCache: LayersCache = new Map();
    const coreScriptPaths = this.selectedCoreScriptPaths();

    const layersFor = (kind: NamedKind, name: string): RawLayer[] => {
      const key = cacheKey(kind, name);
      if (!layersCache.has(key)) {
        let layers: RawLayer[];
        try {
          layers = resolver.collectAllLayers(name, kind) as unknown as RawLayer[];
        } catch (e) {
          rethrowResolution(e);
        }
        const coreScript = kind === 'script' ? coreScriptPaths.get(name) : undefined;
        if (
          coreScript !== undefined &&
          !layers.some((layer) => layer.source === 'core' || layer.source === 'core (bundled)')
        ) {
          layers.push({ path: coreScript, source: 'core', strategy: 'replace' });
        }
        layersCache.set(key, layers);
      }
      return layersCache.get(key)!;
    };

    const names = new Map<string, [NamedKind, string]>();
    try {
      for (const [kind, name] of this.iterCandidateArtifacts(resolver, coreScriptPaths)) {
        if (!isValidArtifactNameComponent(name, kind)) continue;
        const layers = layersFor(kind, name);
        if (layers.length && layers.some((layer) => layer.strategy === 'replace')) {
          names.set(cacheKey(kind, name), [kind, name]);
        }
      }
    } catch (e) {
      rethrowResolution(e);
    }

    const artifacts: Artifact[] = [];
    const manifestCache: ManifestCache = new Map();
    for (const [kind, name] of names.values()) {
      let description = '';
      for (const layer of layersFor(kind, name)) {
        const candidate = this.describeLayer(resolver, layer, kind, name, manifestCache);
        if (candidate) {
          description = candidate;
          break;
        }
      }
      artifacts.push(new Artifact(derivePublicId(kind, name), name, kind, description));
    }

    const kindOrder: Record<string, number> = { command: 0, template: 1, script: 2 };
    artifacts.sort((a, b) => kindOrder[a.kind]! - kindOrder[b.kind]! || compareCodePoints(a.name, b.name));
    return { artifacts, layersCache, resolver, manifestCache };
  }

  /** Yield candidate ``[kind, name]`` pairs from every resolver tier. */
  private *iterCandidateArtifacts(
    resolver: PresetResolver,
    coreScriptPaths: Map<string, string>,
  ): Generator<[NamedKind, string]> {
    // -- Presets: the registry is authoritative, no unregistered fallback.
    const presetManager = new PresetManager(this.projectRoot);
    for (const [packId] of resolver.getAllPresetsByPriority()) {
      const packDir = join(presetManager.presetsDir, packId);
      const manifest = presetManager.getPack(packId) as unknown as ArtifactManifestLike | null;
      yield* ArtifactCatalog.iterPackCandidates(manifest, packDir, 'preset');
    }

    // -- Extensions: use the resolver's own extension enumeration order.
    const extManager = new ExtensionManager(this.projectRoot);
    for (const [, extId, metadata] of resolver.getAllExtensionsByPriority()) {
      const extDir = join(resolver.extensionsDir, extId);
      const manifest: ArtifactManifestLike | null =
        metadata !== null && metadata !== undefined
          ? ((extManager.getExtension(extId) as unknown as ArtifactManifestLike | null) ?? null)
          : loadExtensionManifestSafe(join(extDir, 'extension.yml'));
      yield* ArtifactCatalog.iterPackCandidates(manifest, extDir, 'extension');
    }

    yield* this.iterProjectOverrideCandidates(resolver);
    yield* this.iterCoreCandidates(coreScriptPaths);
  }

  /** Yield manifest-declared and convention-based candidate names. */
  static *iterPackCandidates(
    manifest: ArtifactManifestLike | null,
    packDir: string,
    layer: 'preset' | 'extension',
  ): Generator<[NamedKind, string]> {
    if (manifest !== null) {
      const declarations: Array<[unknown, Record<string, unknown>]> = [];
      if (layer === 'preset') {
        for (const entry of manifest.templates) {
          if (isPlainObject(entry)) declarations.push([entry.type, entry]);
        }
      } else {
        const groups: Array<[NamedKind, unknown[]]> = [
          ['command', manifest.commands ?? []],
          ['template', manifest.templates],
          ['script', manifest.scripts ?? []],
        ];
        for (const [kind, entries] of groups) {
          for (const entry of entries) if (isPlainObject(entry)) declarations.push([kind, entry]);
        }
      }
      for (const [kind, contribution] of declarations) {
        const name = contribution.name;
        if (
          (kind === 'command' || kind === 'template' || kind === 'script') &&
          typeof name === 'string' &&
          name &&
          !name.includes(':')
        ) {
          yield [kind, name];
        }
      }
    }
    for (const [kind, name] of iterConventionContributions(packDir)) yield [kind, name];
  }

  /** Yield candidate ``[kind, name]`` pairs for project overrides. */
  private *iterProjectOverrideCandidates(resolver: PresetResolver): Generator<[NamedKind, string]> {
    const overridesDir = resolver.overridesDir;
    if (!isDir(overridesDir)) return;
    for (const entry of sortedDir(overridesDir)) {
      if (!isFile(join(overridesDir, entry)) || suffixOf(entry) !== TEMPLATE_SUFFIX) continue;
      const name = stemOf(entry);
      if (!isValidArtifactNameComponent(name, 'command')) continue;
      yield ['command', name];
      yield ['template', name];
    }
    const scriptsDir = join(overridesDir, 'scripts');
    if (!isDir(scriptsDir)) return;
    for (const entry of sortedDir(scriptsDir)) {
      if (isFile(join(scriptsDir, entry)) && suffixOf(entry) === SCRIPT_SUFFIX) {
        if (!isValidArtifactNameComponent(stemOf(entry), 'script')) continue;
        yield ['script', stemOf(entry)];
      }
    }
  }

  /** Yield candidate names from resolver-compatible core asset paths. */
  private *iterCoreCandidates(coreScriptPaths: Map<string, string>): Generator<[NamedKind, string]> {
    const commandDirs = [projectCoreAssetRoot(this.projectRoot, 'commands'), locateSharedAssetDir('commands')].filter(
      (d): d is string => d !== null,
    );
    const commandNames = new Set<string>([...CORE_COMMAND_NAMES].map((n) => coreCommandLogicalName(n)));
    for (const directory of commandDirs) {
      for (const entry of sortedDir(directory)) {
        if (isFile(join(directory, entry)) && suffixOf(entry) === TEMPLATE_SUFFIX) {
          commandNames.add(coreCommandLogicalName(stemOf(entry)));
        }
      }
    }
    for (const name of [...commandNames].sort(compareCodePoints)) {
      const coreStem = PresetResolver.coreStem(name);
      const candidates = coreStem ? [name, coreStem] : [name];
      if (commandDirs.some((directory) => candidates.some((c) => isFile(join(directory, `${c}.md`))))) {
        yield ['command', name];
      }
    }

    const seenTemplates = new Set<string>();
    for (const directory of [projectCoreAssetRoot(this.projectRoot, 'templates'), locateSharedAssetDir('templates')]) {
      if (directory === null) continue;
      for (const entry of sortedDir(directory)) {
        if (isFile(join(directory, entry)) && suffixOf(entry) === TEMPLATE_SUFFIX && !seenTemplates.has(stemOf(entry))) {
          seenTemplates.add(stemOf(entry));
          yield ['template', stemOf(entry)];
        }
      }
    }

    for (const directory of [projectCoreAssetRoot(this.projectRoot, 'scripts'), locateSharedAssetDir('scripts')]) {
      if (directory === null) continue;
      for (const entry of sortedDir(directory)) {
        // Path.glob("*.sh")
        if (!entry.endsWith(SCRIPT_SUFFIX)) continue;
        yield ['script', stemOf(entry)];
      }
    }
    for (const name of [...coreScriptPaths.keys()].sort(compareCodePoints)) yield ['script', name];
  }

  /** Return built-in scripts selected by the project's existing runtime policy. */
  selectedCoreScriptPaths(): Map<string, string> {
    const commandDirs = [projectCoreAssetRoot(this.projectRoot, 'commands'), locateSharedAssetDir('commands')].filter(
      (d): d is string => d !== null,
    );
    const scriptDirs = [projectCoreAssetRoot(this.projectRoot, 'scripts'), locateSharedAssetDir('scripts')].filter(
      (d): d is string => d !== null,
    );
    const initOptions = loadInitOptions(this.projectRoot) as Record<string, unknown>;
    const requested = initOptions.script;
    const selected = new Map<string, string>();

    for (const commandDir of commandDirs) {
      for (const entry of sortedDir(commandDir)) {
        if (!entry.endsWith('.md')) continue;
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            readFileSync(join(commandDir, entry)),
          );
        } catch {
          continue;
        }
        const [frontmatter] = CommandRegistrar.parseFrontmatter(content) as [Record<string, unknown>, string];
        const scripts = Object.prototype.hasOwnProperty.call(frontmatter, 'scripts') ? frontmatter.scripts : {};
        if (!isPlainObject(scripts)) continue;
        const scriptCommands: Record<string, string> = {};
        for (const [key, value] of Object.entries(scripts)) {
          if (typeof value === 'string' && value.trim()) scriptCommands[key] = value;
        }
        if (!Object.keys(scriptCommands).length) continue;
        let variant: string;
        let tokens: string[];
        try {
          variant = IntegrationBase.selectScriptVariant(requested, scriptCommands);
          const command = scriptCommands[variant];
          if (command === undefined) continue;
          tokens = shlexSplit(command, true);
        } catch {
          continue;
        }
        if (!tokens.length) continue;

        let path: string | null = null;
        for (const scriptDir of scriptDirs) {
          path = resolveScriptReference(scriptDir, tokens[0]!);
          if (path !== null) break;
        }
        if (path === null) continue;
        const stem = stemOf(basename(path));
        const name = variant === 'py' ? stem.replace(/_/g, '-') : stem;
        if (!selected.has(name)) selected.set(name, path);
      }
    }
    return selected;
  }

  private describeLayer(
    resolver: PresetResolver,
    layer: RawLayer,
    kind: ArtifactKind,
    name: string,
    manifestCache: ManifestCache,
  ): string {
    const manifestDescription = this.manifestDescriptionForLayer(resolver, layer, kind, name, manifestCache);
    if (manifestDescription) return manifestDescription;
    const path = layer.path;
    if (typeof path === 'string') return describeArtifactFile(path, kind);
    return '';
  }

  private manifestDescriptionForLayer(
    resolver: PresetResolver,
    layer: RawLayer,
    kind: ArtifactKind,
    name: string,
    manifestCache: ManifestCache,
  ): string {
    const provenance = layerProvenance(resolver, layer, kind, name, manifestCache);
    const entry = provenance.manifestEntry;
    if (entry === null) return '';
    const description = Object.prototype.hasOwnProperty.call(entry, 'description') ? entry.description : '';
    return typeof description === 'string' ? description : '';
  }
}
