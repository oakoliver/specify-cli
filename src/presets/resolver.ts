/**
 * @oakoliver/specify-cli - Layered preset and extension resolution
 *
 * Port of ``specify_cli/presets/_resolver.py``: ``PresetResolver`` walks the
 * template priority stack (project overrides → installed presets → extensions
 * → core templates → bundled core_pack) and composes layered content
 * (replace / prepend / append / wrap strategies).
 *
 * @module presets/resolver
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import { locateCorePack, repoRoot } from '../assets.js';
import { ExtensionManifest, ExtensionRegistry, normalizePriority } from '../extensions/index.js';
import { CommandRegistrar } from '../agents.js';
import { dumpFrontmatter } from '../utils.js';
import { parseYaml, YAMLError } from '../yaml.js';
import { resolveLoose } from '../shared-infra.js';
import {
  PresetManifest,
  PresetValidationError,
  UnicodeDecodeError,
  VALID_PRESET_STRATEGIES,
  isDir,
  isFile,
  isMapping,
  pathExists,
  pyTruthy,
  readTextStrict,
  type PresetTemplateEntry,
} from './manifest.js';
import { PresetRegistry, type PresetRegistryEntry } from './registry.js';

// ============================================================================
// Types
// ============================================================================

/** One layer of the resolution stack (see {@link PresetResolver.collectAllLayers}). */
export interface PresetLayer {
  path: string;
  source: string;
  strategy: string;
  extension_id?: string;
  extension_dir?: string;
}

/** Result of {@link PresetResolver.resolveWithSource}. */
export interface ResolvedWithSource {
  path: string;
  source: string;
}

/** Registry-derived extension listing row: ``[priority, ext_id, metadata | null]``. */
export type ExtensionPriorityRow = [number, string, Record<string, any> | null];

// ============================================================================
// Asset hooks (patch points for tests, mirroring upstream monkeypatching of
// ``specify_cli._locate_core_pack`` / ``_repo_root``)
// ============================================================================

export const presetAssetHooks: {
  locateCorePack: () => string | null;
  repoRoot: () => string;
} = {
  locateCorePack: () => locateCorePack(),
  repoRoot: () => repoRoot(),
};

// ============================================================================
// Python str helpers
// ============================================================================

const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;

/** ``str.splitlines(keepends=True)``. */
export function splitlinesKeepends(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  LINE_BREAK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINE_BREAK.exec(text)) !== null) {
    out.push(text.slice(last, m.index + m[0].length));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** ``str.splitlines()``. */
export function splitlines(text: string): string[] {
  return splitlinesKeepends(text).map((l) => l.replace(/(\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029])$/, ''));
}

/** ``s.rstrip("\r\n")``. */
function rstripCrLf(s: string): string {
  return s.replace(/[\r\n]+$/, '');
}

/** Lexical ``PurePath.relative_to`` success check. */
function lexicallyUnder(child: string, parent: string): boolean {
  const rel = nodePath.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !nodePath.isAbsolute(rel));
}

// ============================================================================
// PresetResolver
// ============================================================================

/**
 * Resolves template names to file paths using a priority stack.
 *
 * Resolution order:
 * 1. .specify/templates/overrides/          - Project-local overrides
 * 2. .specify/presets/<preset-id>/          - Installed presets
 * 3. .specify/extensions/<ext-id>/templates/ - Extension-provided templates
 * 4. .specify/templates/                    - Core templates (shipped with Spec Kit)
 */
export class PresetResolver {
  readonly projectRoot: string;
  readonly templatesDir: string;
  readonly presetsDir: string;
  readonly overridesDir: string;
  readonly extensionsDir: string;
  private readonly manifestCache = new Map<string, PresetManifest | null>();

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.templatesDir = nodePath.join(projectRoot, '.specify', 'templates');
    this.presetsDir = nodePath.join(projectRoot, '.specify', 'presets');
    this.overridesDir = nodePath.join(this.templatesDir, 'overrides');
    this.extensionsDir = nodePath.join(projectRoot, '.specify', 'extensions');
  }

  /** Get a cached preset manifest, parsing it on first access. */
  getManifest(packDir: string): PresetManifest | null {
    const key = packDir;
    if (!this.manifestCache.has(key)) {
      const manifestPath = nodePath.join(packDir, 'preset.yml');
      if (pathExists(manifestPath)) {
        try {
          this.manifestCache.set(key, new PresetManifest(manifestPath));
        } catch (e) {
          if (!(e instanceof PresetValidationError)) throw e;
          this.manifestCache.set(key, null);
        }
      } else {
        this.manifestCache.set(key, null);
      }
    }
    return this.manifestCache.get(key) ?? null;
  }

  /** Upstream-name alias of {@link getManifest}. */
  _getManifest(packDir: string): PresetManifest | null {
    return this.getManifest(packDir);
  }

  static isSafeRegistryId(value: unknown): boolean {
    return typeof value === 'string' && /^[a-z0-9-]+$/.test(value);
  }

  /** Upstream-name alias of {@link isSafeRegistryId}. */
  static _isSafeRegistryId(value: unknown): boolean {
    return PresetResolver.isSafeRegistryId(value);
  }

  getAllPresetsByPriority(): Array<[string, PresetRegistryEntry]> {
    const registry = new PresetRegistry(this.presetsDir);
    return registry
      .listByPriority()
      .filter(([packId]) => PresetResolver.isSafeRegistryId(packId));
  }

  /**
   * Resolve a preset's manifest-declared template entry and usable file.
   *
   * Returns ``[entry, candidate]``: ``entry`` is the matching
   * ``provides.templates`` mapping (or null); ``candidate`` is the declared
   * file IFF it is a regular file. The manifest is authoritative: callers must
   * not fall back to convention lookup when ``entry`` is set but
   * ``candidate`` is null.
   */
  manifestDeclaredTemplate(
    packDir: string,
    templateName: string,
    templateType: string,
  ): [PresetTemplateEntry | null, string | null] {
    const manifest = this.getManifest(packDir);
    if (!manifest) return [null, null];
    for (const tmpl of manifest.templates) {
      if (tmpl.name === templateName && tmpl.type === templateType) {
        const filePath = tmpl.file;
        if (pyTruthy(filePath)) {
          const candidate = nodePath.join(packDir, filePath);
          return [tmpl, isFile(candidate) ? candidate : null];
        }
        return [tmpl, null];
      }
    }
    return [null, null];
  }

  /**
   * Resolve an extension's manifest-declared command/template/script entry and
   * usable file (containment-checked). Mirrors {@link manifestDeclaredTemplate}.
   */
  extensionManifestDeclaredTemplate(
    extDir: string,
    templateName: string,
    templateType: string,
  ): [Record<string, any> | null, string | null] {
    if (!['command', 'template', 'script'].includes(templateType)) return [null, null];
    const extManifestPath = nodePath.join(extDir, 'extension.yml');
    if (!pathExists(extManifestPath)) return [null, null];
    let extManifest: ExtensionManifest;
    try {
      extManifest = new ExtensionManifest(extManifestPath);
    } catch {
      return [null, null];
    }
    let entries: Array<Record<string, any>>;
    if (templateType === 'command') entries = extManifest.commands as Array<Record<string, any>>;
    else if (templateType === 'template') entries = extManifest.templates as Array<Record<string, any>>;
    else entries = extManifest.scripts as Array<Record<string, any>>;
    for (const entry of entries) {
      if (entry.name !== templateName) continue;
      const fileRel = entry.file;
      if (!pyTruthy(fileRel)) return [entry, null];
      const rel = String(fileRel);
      if (nodePath.isAbsolute(rel)) return [entry, null];
      const candidate = nodePath.join(extDir, rel);
      try {
        if (!lexicallyUnder(resolveLoose(candidate), resolveLoose(extDir))) return [entry, null];
      } catch {
        return [entry, null];
      }
      return [entry, isFile(candidate) ? candidate : null];
    }
    return [null, null];
  }

  /**
   * Build unified list of registered and unregistered extensions sorted by
   * priority. Unregistered directories get implicit priority=10.
   *
   * @throws PresetValidationError when the extension registry is corrupt (fail closed)
   */
  getAllExtensionsByPriority(): ExtensionPriorityRow[] {
    if (!pathExists(this.extensionsDir)) return [];

    const registry = new ExtensionRegistry(this.extensionsDir);
    if (registry.isCorrupt()) {
      throw new PresetValidationError(
        `Invalid extension registry ${registry.registryPath}: refusing to enumerate extensions`,
      );
    }
    const registeredExtensionIds: Set<string> = registry.keys();
    const allRegistered = registry.listByPriority(true) as Array<[string, Record<string, any>]>;

    const allExtensions: ExtensionPriorityRow[] = [];
    for (const [extId, metadata] of allRegistered) {
      if (!PresetResolver.isSafeRegistryId(extId)) continue;
      const enabled = metadata && 'enabled' in metadata ? metadata.enabled : true;
      if (!pyTruthy(enabled)) continue;
      const priority = normalizePriority(metadata ? metadata.priority : null);
      allExtensions.push([priority, extId, metadata]);
    }

    let names: string[] = [];
    try {
      names = readdirSync(this.extensionsDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      const extDir = nodePath.join(this.extensionsDir, name);
      if (!isDir(extDir) || !PresetResolver.isSafeRegistryId(name)) continue;
      if (!registeredExtensionIds.has(name)) allExtensions.push([10, name, null]);
    }

    allExtensions.sort((a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    return allExtensions;
  }

  /**
   * Extract the stem for core command lookup (``speckit.specify`` → ``specify``),
   * or null when the name does not follow ``speckit.<stem>``.
   */
  static coreStem(templateName: string): string | null {
    if (templateName.startsWith('speckit.')) return templateName.slice('speckit.'.length);
    return null;
  }

  /** Upstream-name alias of {@link coreStem}. */
  static _coreStem(templateName: string): string | null {
    return PresetResolver.coreStem(templateName);
  }

  private static subdirsFor(templateType: string): string[] {
    if (templateType === 'template') return ['templates', ''];
    if (templateType === 'command') return ['commands'];
    if (templateType === 'script') return ['scripts'];
    return [''];
  }

  /**
   * Resolve a template name to its file path (first match in the stack).
   *
   * @param skipPresets When true, skip tier 2 (installed presets). Prefer {@link resolveCore}.
   */
  resolve(templateName: string, templateType = 'template', skipPresets = false): string | null {
    const subdirs = PresetResolver.subdirsFor(templateType);
    const ext = templateType === 'script' ? '.sh' : '.md';

    // Priority 1: Project-local overrides
    const override =
      templateType === 'script'
        ? nodePath.join(this.overridesDir, 'scripts', `${templateName}${ext}`)
        : nodePath.join(this.overridesDir, `${templateName}${ext}`);
    if (pathExists(override)) return override;

    // Priority 2: Installed presets
    if (!skipPresets && pathExists(this.presetsDir)) {
      for (const [packId] of this.getAllPresetsByPriority()) {
        const packDir = nodePath.join(this.presetsDir, packId);
        const [entry, manifestCandidate] = this.manifestDeclaredTemplate(packDir, templateName, templateType);
        if (manifestCandidate !== null) return manifestCandidate;
        if (entry !== null) continue;
        for (const subdir of subdirs) {
          const candidate = subdir
            ? nodePath.join(packDir, subdir, `${templateName}${ext}`)
            : nodePath.join(packDir, `${templateName}${ext}`);
          if (pathExists(candidate)) return candidate;
        }
      }
    }

    // Priority 3: Extension-provided templates
    for (const [, extId] of this.getAllExtensionsByPriority()) {
      const extDir = nodePath.join(this.extensionsDir, extId);
      if (!isDir(extDir)) continue;
      const [entry, manifestCandidate] = this.extensionManifestDeclaredTemplate(extDir, templateName, templateType);
      if (manifestCandidate !== null) return manifestCandidate;
      if (entry !== null) continue;
      for (const subdir of subdirs) {
        const candidate = subdir
          ? nodePath.join(extDir, subdir, `${templateName}${ext}`)
          : nodePath.join(extDir, `${templateName}${ext}`);
        if (pathExists(candidate)) return candidate;
      }
    }

    // Priority 4: Core templates
    if (templateType === 'template') {
      const core = nodePath.join(this.templatesDir, `${templateName}.md`);
      if (pathExists(core)) return core;
    } else if (templateType === 'command') {
      let core = nodePath.join(this.templatesDir, 'commands', `${templateName}.md`);
      if (pathExists(core)) return core;
      const stem = PresetResolver.coreStem(templateName);
      if (stem) {
        core = nodePath.join(this.templatesDir, 'commands', `${stem}.md`);
        if (pathExists(core)) return core;
      }
    } else if (templateType === 'script') {
      const core = nodePath.join(this.templatesDir, 'scripts', `${templateName}${ext}`);
      if (pathExists(core)) return core;
    }

    // Priority 5: Bundled core_pack (or repo-root templates)
    const corePack = presetAssetHooks.locateCorePack();
    let candidate: string;
    if (corePack !== null) {
      if (templateType === 'template') {
        candidate = nodePath.join(corePack, 'templates', `${templateName}.md`);
      } else if (templateType === 'command') {
        candidate = nodePath.join(corePack, 'commands', `${templateName}.md`);
        if (!pathExists(candidate)) {
          const stem = PresetResolver.coreStem(templateName);
          if (stem) candidate = nodePath.join(corePack, 'commands', `${stem}.md`);
        }
      } else if (templateType === 'script') {
        candidate = nodePath.join(corePack, 'scripts', `${templateName}${ext}`);
      } else {
        candidate = nodePath.join(corePack, `${templateName}.md`);
      }
    } else {
      const root = presetAssetHooks.repoRoot();
      if (templateType === 'template') {
        candidate = nodePath.join(root, 'templates', `${templateName}.md`);
      } else if (templateType === 'command') {
        candidate = nodePath.join(root, 'templates', 'commands', `${templateName}.md`);
        if (!pathExists(candidate)) {
          const stem = PresetResolver.coreStem(templateName);
          if (stem) candidate = nodePath.join(root, 'templates', 'commands', `${stem}.md`);
        }
      } else if (templateType === 'script') {
        candidate = nodePath.join(root, 'scripts', `${templateName}${ext}`);
      } else {
        candidate = nodePath.join(root, `${templateName}.md`);
      }
    }
    if (pathExists(candidate)) return candidate;

    return null;
  }

  /**
   * Resolve while skipping installed presets (tier 2). Use when resolving
   * ``{CORE_TEMPLATE}`` to guarantee actual base content.
   */
  resolveCore(templateName: string, templateType = 'template'): string | null {
    return this.resolve(templateName, templateType, true);
  }

  /**
   * Resolve an extension command by consulting installed extension manifests
   * (``provides.commands[].file`` is authoritative and may differ from the
   * command name). Returns null when no manifest maps the command.
   */
  resolveExtensionCommandViaManifest(cmdName: string): string | null {
    if (!pathExists(this.extensionsDir)) return null;

    for (const [, extId] of this.getAllExtensionsByPriority()) {
      const extDir = nodePath.join(this.extensionsDir, extId);
      const manifestPath = nodePath.join(extDir, 'extension.yml');
      if (!isFile(manifestPath)) continue;
      let manifest: ExtensionManifest;
      try {
        manifest = new ExtensionManifest(manifestPath);
      } catch {
        continue;
      }
      for (const cmdInfo of manifest.commands as Array<Record<string, any>>) {
        if (cmdInfo.name !== cmdName) continue;
        const fileRel = cmdInfo.file;
        if (!pyTruthy(fileRel)) continue;
        const rel = String(fileRel);
        if (nodePath.isAbsolute(rel)) continue;
        let candidate: string;
        try {
          const extRoot = resolveLoose(extDir);
          candidate = resolveLoose(nodePath.join(extRoot, rel));
          if (!lexicallyUnder(candidate, extRoot)) continue;
        } catch {
          continue;
        }
        if (isFile(candidate)) return candidate;
      }
    }
    return null;
  }

  /** Resolve a template name and return ``{path, source}`` attribution, or null. */
  resolveWithSource(templateName: string, templateType = 'template'): ResolvedWithSource | null {
    const resolved = this.resolve(templateName, templateType);
    if (resolved === null) return null;
    const resolvedStr = resolved;

    if (resolvedStr.includes(this.overridesDir)) {
      return { path: resolvedStr, source: 'project override' };
    }

    if (resolvedStr.includes(this.presetsDir) && pathExists(this.presetsDir)) {
      for (const [packId, metadata] of this.getAllPresetsByPriority()) {
        const packDir = nodePath.join(this.presetsDir, packId);
        if (lexicallyUnder(resolved, packDir)) {
          const version = 'version' in metadata ? metadata.version : '?';
          return { path: resolvedStr, source: `${packId} v${version}` };
        }
      }
    }

    for (const [, extId, extMeta] of this.getAllExtensionsByPriority()) {
      const extDir = nodePath.join(this.extensionsDir, extId);
      if (!isDir(extDir)) continue;
      if (lexicallyUnder(resolved, extDir)) {
        if (extMeta && pyTruthy(extMeta)) {
          const version = 'version' in extMeta ? extMeta.version : '?';
          return { path: resolvedStr, source: `extension:${extId} v${version}` };
        }
        return { path: resolvedStr, source: `extension:${extId} (unregistered)` };
      }
    }

    return { path: resolvedStr, source: 'core' };
  }

  /**
   * Collect all layers in the priority stack for a template, highest priority
   * first. Each layer has ``path``, ``source`` and ``strategy``.
   */
  collectAllLayers(templateName: string, templateType = 'template'): PresetLayer[] {
    const subdirs = PresetResolver.subdirsFor(templateType);
    const ext = templateType === 'script' ? '.sh' : '.md';
    const layers: PresetLayer[] = [];

    const findInSubdirs = (baseDir: string): string | null => {
      for (const subdir of subdirs) {
        const candidate = subdir
          ? nodePath.join(baseDir, subdir, `${templateName}${ext}`)
          : nodePath.join(baseDir, `${templateName}${ext}`);
        if (pathExists(candidate)) return candidate;
      }
      return null;
    };

    // Priority 1: Project-local overrides (always "replace")
    const override =
      templateType === 'script'
        ? nodePath.join(this.overridesDir, 'scripts', `${templateName}${ext}`)
        : nodePath.join(this.overridesDir, `${templateName}${ext}`);
    if (pathExists(override)) {
      layers.push({ path: override, source: 'project override', strategy: 'replace' });
    }

    // Priority 2: Installed presets
    if (pathExists(this.presetsDir)) {
      for (const [packId, metadata] of this.getAllPresetsByPriority()) {
        const packDir = nodePath.join(this.presetsDir, packId);
        let strategy = 'replace';
        let manifestHasStrategy = false;
        const [entry, manifestCandidate] = this.manifestDeclaredTemplate(packDir, templateName, templateType);
        if (entry !== null) {
          strategy = ('strategy' in entry ? entry.strategy : 'replace') as string;
          manifestHasStrategy = 'strategy' in entry;
        }
        let candidate: string | null = null;
        if (manifestCandidate !== null) candidate = manifestCandidate;
        else if (entry === null) candidate = findInSubdirs(packDir);
        if (candidate) {
          if (!manifestHasStrategy && strategy === 'replace' && templateType === 'command') {
            try {
              const cmdContent = readTextStrict(candidate);
              const lines = splitlinesKeepends(cmdContent);
              if (lines.length && rstripCrLf(lines[0]) === '---') {
                let fenceEnd = -1;
                for (let fi = 1; fi < lines.length; fi++) {
                  if (rstripCrLf(lines[fi]) === '---') {
                    fenceEnd = fi;
                    break;
                  }
                }
                if (fenceEnd > 0) {
                  const fmText = lines.slice(1, fenceEnd).join('');
                  const fmData = parseYaml(fmText);
                  if (isMapping(fmData)) {
                    const fmStrategy = fmData.strategy;
                    if (typeof fmStrategy === 'string' && VALID_PRESET_STRATEGIES.has(fmStrategy.toLowerCase())) {
                      strategy = fmStrategy.toLowerCase();
                    }
                  }
                }
              }
            } catch (e) {
              if (!(e instanceof UnicodeDecodeError || e instanceof YAMLError || isOsError(e))) throw e;
              // Best-effort legacy frontmatter parsing: keep default strategy.
            }
          }
          const version = metadata && 'version' in metadata ? metadata.version : '?';
          layers.push({ path: candidate, source: `${packId} v${version}`, strategy });
        }
      }
    }

    // Priority 3: Extension-provided templates (always "replace")
    for (const [, extId, extMeta] of this.getAllExtensionsByPriority()) {
      const extDir = nodePath.join(this.extensionsDir, extId);
      if (!isDir(extDir)) continue;
      let [entry, candidate] = this.extensionManifestDeclaredTemplate(extDir, templateName, templateType);
      if (entry === null) candidate = findInSubdirs(extDir);
      if (candidate) {
        let source: string;
        if (extMeta && pyTruthy(extMeta)) {
          const version = 'version' in extMeta ? extMeta.version : '?';
          source = `extension:${extId} v${version}`;
        } else {
          source = `extension:${extId} (unregistered)`;
        }
        layers.push({
          path: candidate,
          source,
          strategy: 'replace',
          extension_id: extId,
          extension_dir: extDir,
        });
      }
    }

    // Priority 4: Core templates (always "replace")
    let core: string | null = null;
    if (templateType === 'template') {
      const c = nodePath.join(this.templatesDir, `${templateName}.md`);
      if (pathExists(c)) core = c;
    } else if (templateType === 'command') {
      const c = nodePath.join(this.templatesDir, 'commands', `${templateName}.md`);
      if (pathExists(c)) {
        core = c;
      } else {
        const stem = PresetResolver.coreStem(templateName);
        if (stem) {
          const c2 = nodePath.join(this.templatesDir, 'commands', `${stem}.md`);
          if (pathExists(c2)) core = c2;
        }
      }
    } else if (templateType === 'script') {
      const c = nodePath.join(this.templatesDir, 'scripts', `${templateName}${ext}`);
      if (pathExists(c)) core = c;
    }
    if (core) {
      layers.push({ path: core, source: 'core', strategy: 'replace' });
    } else {
      // Priority 5: Bundled core_pack, matching resolve()'s tier-5 fallback.
      const bundled = this.findBundledCore(templateName, templateType, ext);
      if (bundled) layers.push({ path: bundled, source: 'core (bundled)', strategy: 'replace' });
    }

    return layers;
  }

  /** Find a core template from the bundled pack (or repo-root fallback). */
  findBundledCore(templateName: string, templateType: string, ext: string): string | null {
    const stem = PresetResolver.coreStem(templateName);
    const names = [templateName];
    if (stem && stem !== templateName) names.push(stem);

    const corePack = presetAssetHooks.locateCorePack();
    if (corePack !== null) {
      for (const name of names) {
        let c: string;
        if (templateType === 'template') c = nodePath.join(corePack, 'templates', `${name}.md`);
        else if (templateType === 'command') c = nodePath.join(corePack, 'commands', `${name}.md`);
        else if (templateType === 'script') c = nodePath.join(corePack, 'scripts', `${name}${ext}`);
        else c = nodePath.join(corePack, `${name}.md`);
        if (pathExists(c)) return c;
      }
    } else {
      const root = presetAssetHooks.repoRoot();
      for (const name of names) {
        let c: string;
        if (templateType === 'template') c = nodePath.join(root, 'templates', `${name}.md`);
        else if (templateType === 'command') c = nodePath.join(root, 'templates', 'commands', `${name}.md`);
        else if (templateType === 'script') c = nodePath.join(root, 'scripts', `${name}${ext}`);
        else c = nodePath.join(root, `${name}.md`);
        if (pathExists(c)) return c;
      }
    }
    return null;
  }

  /** Upstream-name alias of {@link findBundledCore}. */
  _findBundledCore(templateName: string, templateType: string, ext: string): string | null {
    return this.findBundledCore(templateName, templateType, ext);
  }

  /**
   * Resolve a template name and return composed content (replace / prepend /
   * append / wrap strategies, composed recursively). Returns null when not
   * found or when composition cannot be produced.
   *
   * @throws PresetValidationError when a wrap layer lacks its placeholder
   */
  resolveContent(templateName: string, templateType = 'template'): string | null {
    const layers = this.collectAllLayers(templateName, templateType);
    if (!layers.length) return null;

    const readLayerContent = (layer: PresetLayer): string | null => {
      let text: string;
      try {
        text = readTextStrict(layer.path);
      } catch (e) {
        if (e instanceof UnicodeDecodeError || isOsError(e)) return null;
        throw e;
      }
      if (layer.extension_id && layer.extension_dir) {
        text = CommandRegistrar.rewriteExtensionPaths(text, layer.extension_id, layer.extension_dir);
      }
      return text;
    };

    if (layers[0].strategy === 'replace') return readLayerContent(layers[0]);

    const reversedLayers = [...layers].reverse();
    let baseLayerIdx: number | null = null;
    for (let idx = 0; idx < layers.length; idx++) {
      if (layers[idx].strategy === 'replace') {
        baseLayerIdx = idx;
        break;
      }
    }
    if (baseLayerIdx === null) return null;

    const baseReversedIdx = layers.length - 1 - baseLayerIdx;
    let content = readLayerContent(layers[baseLayerIdx]);
    if (content === null) return null;
    const startIdx = baseReversedIdx + 1;

    const isCommand = templateType === 'command';
    let topFrontmatterText: string | null = null;
    let baseFrontmatterText: string | null = null;

    const splitFrontmatter = (text: string): [string | null, string] => {
      const lines = splitlinesKeepends(text);
      if (!lines.length || rstripCrLf(lines[0]) !== '---') return [null, text];
      let fenceEnd = -1;
      for (let i = 1; i < lines.length; i++) {
        if (rstripCrLf(lines[i]) === '---') {
          fenceEnd = i;
          break;
        }
      }
      if (fenceEnd === -1) return [null, text];
      const fmBlock = rstripCrLf(lines.slice(0, fenceEnd + 1).join(''));
      const body = lines.slice(fenceEnd + 1).join('');
      return [fmBlock, body];
    };

    if (isCommand) {
      const [fm, body] = splitFrontmatter(content);
      if (fm) {
        topFrontmatterText = fm;
        baseFrontmatterText = fm;
        content = body;
      }
    }

    for (const layer of reversedLayers.slice(startIdx)) {
      let layerContent: string;
      try {
        layerContent = readTextStrict(layer.path);
      } catch (e) {
        if (e instanceof UnicodeDecodeError || isOsError(e)) return null;
        throw e;
      }
      const strategy = layer.strategy;

      if (isCommand) {
        const [fm, layerBody] = splitFrontmatter(layerContent);
        layerContent = layerBody;
        if (strategy === 'replace') {
          topFrontmatterText = fm;
          baseFrontmatterText = fm;
        } else if (fm) {
          topFrontmatterText = fm;
        }
      }

      if (strategy === 'replace') {
        content = layerContent;
      } else if (strategy === 'prepend') {
        content = layerContent + '\n\n' + content;
      } else if (strategy === 'append') {
        content = content + '\n\n' + layerContent;
      } else if (strategy === 'wrap') {
        const placeholder = templateType === 'script' ? '$CORE_SCRIPT' : '{CORE_TEMPLATE}';
        if (!layerContent.includes(placeholder)) {
          throw new PresetValidationError(
            `Wrap strategy in '${layer.source}' is missing ` +
              `the ${placeholder} placeholder. The wrapper must ` +
              `contain ${placeholder} to indicate where the ` +
              `lower-priority content should be inserted.`,
          );
        }
        const base: string = content as string;
        content = layerContent.split(placeholder).join(base);
      }
    }

    if (isCommand && topFrontmatterText) {
      const parseFmYaml = (fmBlock: string): Record<string, any> => {
        const lines = splitlines(fmBlock);
        const yamlLines = lines.length >= 2 ? lines.slice(1, -1) : [];
        try {
          const parsed = parseYaml(yamlLines.join('\n'));
          return isMapping(parsed) ? (parsed as Record<string, any>) : {};
        } catch (e) {
          if (e instanceof YAMLError) return {};
          throw e;
        }
      };

      const topFm = parseFmYaml(topFrontmatterText);
      if (baseFrontmatterText && baseFrontmatterText !== topFrontmatterText) {
        const baseFm = parseFmYaml(baseFrontmatterText);
        for (const key of ['scripts', 'agent_scripts', 'argument-hint']) {
          if (!(key in topFm) && key in baseFm) topFm[key] = baseFm[key];
        }
      }
      delete topFm.strategy;

      if (Object.keys(topFm).length) {
        topFrontmatterText = '---\n' + dumpFrontmatter(topFm) + '\n---';
      } else {
        topFrontmatterText = null;
      }
      if (topFrontmatterText) content = topFrontmatterText + '\n\n' + content;
    }

    return content;
  }
}

/** Whether an error is a Node filesystem error (Python ``OSError``). */
export function isOsError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as NodeJS.ErrnoException).code === 'string' &&
    /^E[A-Z0-9]+$/.test((e as NodeJS.ErrnoException).code as string)
  );
}

/** Read a file as raw bytes (``Path.read_bytes()``). */
export function readBytes(p: string): Buffer {
  return readFileSync(p);
}
