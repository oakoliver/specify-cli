/**
 * @oakoliver/specify-cli - Artifact stack projection
 *
 * Port of spec-kit v1.0.12 ``specify_cli/artifacts/resolution.py``: artifact
 * stack projection over the existing preset resolver.
 *
 * @module artifacts/resolution
 */

import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { CommandRegistrar } from '../agents.js';
import { AGENT_CONFIG } from '../agent-config.js';
import { ExtensionManager } from '../extensions/manager.js';
import { ExtensionManifest } from '../extensions/manifest.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { PresetManager } from '../presets/manager.js';
import { PresetError, PresetManifest, PresetValidationError } from '../presets/manifest.js';
import { PresetRegistry } from '../presets/registry.js';
import { PresetResolver } from '../presets/resolver.js';
import { compareCodePoints, isPlainObject } from '../events/py-compat.js';

import { IdentifierComponentError, PROJECT_OVERRIDE_LAYER, deriveLookupId, derivePublicId } from './identifiers.js';
import { ArtifactResolutionError, StackLayer, type ArtifactKind, type LayerName, type Strategy } from './models.js';

// ============================================================================
// Types
// ============================================================================

/** A raw layer as produced by ``PresetResolver.collectAllLayers``. */
export type RawLayer = Record<string, unknown>;

/** Structural manifest view shared by preset and extension manifests. */
export interface ArtifactManifestLike {
  readonly path: string;
  readonly templates: unknown[];
  readonly commands?: unknown[];
  readonly scripts?: unknown[];
}

export type ManifestCache = Map<string, ArtifactManifestLike | null>;

// ============================================================================
// Path helpers (pathlib semantics)
// ============================================================================

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** ``Path.relative_to(base).as_posix()`` (lexical), or ``null`` when not relative. */
export function relativePosix(path: string, base: string): string | null {
  const rel = relative(normalize(base), normalize(path));
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** ``Path.resolve()`` (non-strict). */
export function resolvePathLoose(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const tail: string[] = [];
    let current = abs;
    for (;;) {
      const parent = dirname(current);
      if (parent === current) return abs;
      tail.unshift(basename(current));
      current = parent;
      try {
        return join(realpathSync(current), ...tail);
      } catch {
        // keep walking up
      }
    }
  }
}

// ============================================================================
// Layer provenance
// ============================================================================

/** Artifact-only metadata derived from an unchanged resolver layer. */
export class LayerProvenance {
  constructor(
    readonly layer: LayerName | null,
    readonly sourceId: string | null,
    readonly diskId: string | null,
    readonly packDir: string | null,
    readonly manifest: ArtifactManifestLike | null,
    readonly manifestEntry: Record<string, unknown> | null,
  ) {}

  lookupId(kind: ArtifactKind, name: string): string | null {
    if (this.layer === null || this.sourceId === null) return null;
    try {
      return deriveLookupId(this.layer, this.sourceId, kind, name);
    } catch (e) {
      if (e instanceof IdentifierComponentError) return null;
      throw e;
    }
  }
}

function sameFile(left: string | null, right: unknown): boolean {
  return typeof right === 'string' && left !== null && resolvePathLoose(left) === resolvePathLoose(right);
}

function manifestEntryForPath(
  manifest: ArtifactManifestLike | null,
  layer: 'preset' | 'extension',
  packDir: string,
  kind: ArtifactKind,
  name: string,
  path: string,
): Record<string, unknown> | null {
  if (manifest === null) return null;
  let entries: unknown[];
  if (layer === 'preset') {
    entries = manifest.templates.filter((entry) => isPlainObject(entry) && entry.type === kind);
  } else {
    const table: Record<string, unknown[] | undefined> = {
      command: manifest.commands,
      template: manifest.templates,
      script: manifest.scripts,
    };
    const selected = table[kind];
    if (selected === undefined) throw new Error(`KeyError: '${kind}'`);
    entries = selected;
  }
  for (const entry of entries) {
    if (!isPlainObject(entry) || entry.name !== name) continue;
    const relativeFile = entry.file;
    if (typeof relativeFile === 'string' && sameFile(join(packDir, relativeFile), path)) return entry;
  }
  return null;
}

/** Derive artifact provenance from the resolver's established layer shape. */
export function layerProvenance(
  resolver: PresetResolver,
  resolverLayer: RawLayer,
  kind: ArtifactKind,
  name: string,
  manifestCache: ManifestCache,
): LayerProvenance {
  const source = resolverLayer.source;
  const path = resolverLayer.path;

  if (source === 'project override') return new LayerProvenance('project', '_', null, null, null, null);
  if (source === 'core' || source === 'core (bundled)') {
    return new LayerProvenance(null, null, null, null, null, null);
  }
  if (typeof path !== 'string' || typeof source !== 'string') throw new ArtifactResolutionError();

  if (source.startsWith('extension:')) {
    const extensionId = resolverLayer.extension_id;
    const extensionDir = resolverLayer.extension_dir;
    if (typeof extensionId !== 'string' || typeof extensionDir !== 'string') throw new ArtifactResolutionError();
    const manifestPath = join(extensionDir, 'extension.yml');
    if (!manifestCache.has(manifestPath)) {
      try {
        manifestCache.set(
          manifestPath,
          isFile(manifestPath) ? (new ExtensionManifest(manifestPath) as unknown as ArtifactManifestLike) : null,
        );
      } catch {
        manifestCache.set(manifestPath, null);
      }
    }
    const manifest = manifestCache.get(manifestPath) ?? null;
    const declared = manifestEntryForPath(manifest, 'extension', extensionDir, kind, name, path);
    return new LayerProvenance('extension', extensionId, extensionId, extensionDir, manifest, declared);
  }

  const rel = relativePosix(path, resolver.presetsDir);
  if (rel === null || rel === '.') throw new ArtifactResolutionError();
  const packId = rel.split('/')[0]!;
  const packDir = join(resolver.presetsDir, packId);
  const manifest = resolver.getManifest(packDir) as unknown as ArtifactManifestLike | null;
  const declared = manifestEntryForPath(manifest, 'preset', packDir, kind, name, path);
  return new LayerProvenance('preset', packId, packId, packDir, manifest, declared);
}

function deriveManifestPath(provenance: LayerProvenance, projectRoot: string): string | null {
  if (provenance.manifestEntry === null || provenance.packDir === null) return null;
  const manifestName = provenance.layer === 'preset' ? 'preset.yml' : 'extension.yml';
  const manifestPath = join(provenance.packDir, manifestName);
  if (!isFile(manifestPath)) return null;
  return relativePosix(manifestPath, projectRoot);
}

/** Return *path* relative to the project root when it is an existing file. */
export function repoRelativeExistingFile(projectRoot: string, path: string): string | null {
  if (!isFile(path)) return null;
  return relativePosix(path, projectRoot);
}

function isSafePathComponent(value: string): boolean {
  if (!value || value === '.' || value === '..') return false;
  if (isAbsolute(value) || value.startsWith('/')) return false;
  const parts = value.split('/').filter((p) => p !== '' && p !== '.');
  return parts.length === 1 && parts[0] === value;
}

/** ``specify_cli._get_skills_dir``: the agent-specific skills directory. */
function projectSkillsDir(projectRoot: string, selectedAi: string): string {
  const agentConfig = (AGENT_CONFIG as Record<string, Record<string, unknown>>)[selectedAi] ?? {};
  const folder = typeof agentConfig.folder === 'string' ? agentConfig.folder : '';
  if (folder) return join(projectRoot, folder.replace(/\/+$/, ''), 'skills');
  return join(projectRoot, '.agents', 'skills');
}

/** Return the tracked agent output path for an installed command layer. */
function materializedCommandSourcePath(
  projectRoot: string,
  metadata: unknown,
  name: string,
  source: 'preset' | 'extension',
): string | null {
  if (!isPlainObject(metadata)) return null;

  CommandRegistrar.ensureConfigs();
  const agentConfigs = CommandRegistrar.AGENT_CONFIGS as unknown as Record<string, Record<string, unknown>>;

  const registeredCommands = metadata.registered_commands;
  if (isPlainObject(registeredCommands)) {
    for (const agentName of Object.keys(registeredCommands).sort(compareCodePoints)) {
      const cmdNames = registeredCommands[agentName];
      if (!Array.isArray(cmdNames) || !cmdNames.includes(name)) continue;
      const agentConfig = agentConfigs[agentName];
      if (!agentConfig) continue;
      const outputName = CommandRegistrar.computeOutputName(agentName, name, agentConfig as never);
      const commandPath = join(
        CommandRegistrar.resolveAgentDir(agentName, agentConfig as never, projectRoot),
        `${outputName}${String(agentConfig.extension)}`,
      );
      const rel = repoRelativeExistingFile(projectRoot, commandPath);
      if (rel !== null) return rel;
    }
  }

  const registeredSkills = metadata.registered_skills;
  let skillNamesByAgent: Record<string, unknown> = {};
  if (source === 'preset') {
    skillNamesByAgent = isPlainObject(registeredSkills) ? registeredSkills : {};
  } else if (Array.isArray(registeredSkills)) {
    // Extension registries store skills as a flat list; probe every agent.
    for (const agentName of Object.keys(agentConfigs).sort(compareCodePoints)) {
      skillNamesByAgent[agentName] = registeredSkills;
    }
  }

  const expectedSkillNames: Set<string> =
    source === 'extension'
      ? new Set([ExtensionManager.skillNameForCommand(name)])
      : new Set(PresetManager.skillNamesForCommand(name));

  for (const agentName of Object.keys(skillNamesByAgent).sort(compareCodePoints)) {
    const skillNames = skillNamesByAgent[agentName];
    if (!Array.isArray(skillNames)) continue;
    const agentConfig = agentConfigs[agentName];
    if (!agentConfig) continue;
    const skillsDir =
      agentConfig.extension === '/SKILL.md'
        ? CommandRegistrar.resolveAgentDir(agentName, agentConfig as never, projectRoot)
        : projectSkillsDir(projectRoot, agentName);
    const candidates = skillNames
      .filter((n): n is string => typeof n === 'string' && isSafePathComponent(n))
      .sort(compareCodePoints);
    for (const skillName of candidates) {
      if (!expectedSkillNames.has(skillName)) continue;
      const rel = repoRelativeExistingFile(projectRoot, join(skillsDir, skillName, 'SKILL.md'));
      if (rel !== null) return rel;
    }
  }
  return null;
}

/**
 * Return the repo-relative concrete file backing a preset/extension layer.
 * Only the active command row reports the shared materialized agent output.
 */
function deriveSourcePath(
  provenance: LayerProvenance,
  layer: RawLayer,
  projectRoot: string,
  kind: ArtifactKind,
  name: string,
  active: boolean,
): string | null {
  if (provenance.layer === 'preset') {
    if (provenance.diskId === null) return null;
    const metadata = new PresetRegistry(join(projectRoot, '.specify', 'presets')).get(provenance.diskId);
    if (kind === 'command' && active) {
      const materialized = materializedCommandSourcePath(projectRoot, metadata, name, 'preset');
      if (materialized !== null) return materialized;
    }
  } else if (provenance.layer === 'extension') {
    if (provenance.diskId === null) return null;
    const metadata = new ExtensionRegistry(join(projectRoot, '.specify', 'extensions')).get(provenance.diskId);
    if (kind === 'command' && active) {
      const materialized = materializedCommandSourcePath(projectRoot, metadata, name, 'extension');
      if (materialized !== null) return materialized;
    }
  } else {
    return null;
  }
  const path = layer.path;
  if (typeof path === 'string') return repoRelativeExistingFile(projectRoot, path);
  return null;
}

/** Return the preset's human-friendly name from ``preset.yml``, or ``packId``. */
function presetDisplayName(packDir: string, packId: string): string {
  const manifestPath = join(packDir, 'preset.yml');
  if (!isFile(manifestPath)) return packId;
  try {
    return new PresetManifest(manifestPath).name;
  } catch (e) {
    if (e instanceof PresetValidationError) return packId;
    throw e;
  }
}

/**
 * Build the ordered stack for a single artifact. Composition math is
 * delegated to ``PresetResolver.collectAllLayers``; this only reshapes each
 * raw layer into a ``StackLayer`` with ``active`` / ``hidden`` labels.
 */
export function buildStack(
  projectRoot: string,
  kind: ArtifactKind,
  name: string,
  rawLayers: RawLayer[] | null = null,
  resolver: PresetResolver | null = null,
  manifestCache: ManifestCache | null = null,
): StackLayer[] {
  const res = resolver ?? new PresetResolver(projectRoot);
  let raw: RawLayer[];
  if (rawLayers === null) {
    try {
      raw = res.collectAllLayers(name, kind) as unknown as RawLayer[];
    } catch (e) {
      if (e instanceof PresetError || isOSError(e)) throw new ArtifactResolutionError();
      throw e;
    }
  } else {
    raw = rawLayers;
  }
  if (!raw.length) return [];
  const cache = manifestCache ?? new Map();

  const firstReplaceIdx = raw.findIndex((layer) => layer.strategy === 'replace');

  const publicId = derivePublicId(kind, name);
  const rows: StackLayer[] = [];
  raw.forEach((layer, idx) => {
    const strategy = layer.strategy as Strategy;
    const active = idx === 0;
    const hidden = firstReplaceIdx === -1 ? false : idx > firstReplaceIdx;

    const provenance = layerProvenance(res, layer, kind, name, cache);
    const lookupId = provenance.lookupId(kind, name);
    const sourcePath = deriveSourcePath(provenance, layer, projectRoot, kind, name, active);

    if (provenance.layer === PROJECT_OVERRIDE_LAYER) {
      rows.push(
        new StackLayer({
          id: publicId,
          layer: 'project',
          sourceId: provenance.sourceId,
          presetId: null,
          presetName: null,
          strategy,
          active,
          hidden,
          manifestPath: null,
          lookupId,
          sourcePath,
        }),
      );
      return;
    }
    if (provenance.layer === 'extension') {
      rows.push(
        new StackLayer({
          id: publicId,
          layer: 'extension',
          sourceId: provenance.sourceId,
          presetId: null,
          presetName: null,
          strategy,
          active,
          hidden,
          manifestPath: deriveManifestPath(provenance, projectRoot),
          lookupId,
          sourcePath,
        }),
      );
      return;
    }
    if (provenance.layer === null) {
      rows.push(
        new StackLayer({
          id: publicId,
          layer: null,
          sourceId: null,
          presetId: null,
          presetName: null,
          strategy,
          active,
          hidden,
          manifestPath: null,
          lookupId: null,
          sourcePath,
        }),
      );
      return;
    }
    const packId = provenance.diskId ?? '';
    const packDir = provenance.packDir ?? join(projectRoot, '.specify', 'presets', packId);
    const display = packId ? presetDisplayName(packDir, packId) : packId;
    rows.push(
      new StackLayer({
        id: publicId,
        layer: 'preset',
        sourceId: provenance.sourceId,
        presetId: packId || null,
        presetName: display || null,
        strategy,
        active,
        hidden,
        manifestPath: deriveManifestPath(provenance, projectRoot),
        lookupId,
        sourcePath,
      }),
    );
  });
  return rows;
}

/** True for errors that correspond to Python ``OSError``. */
export function isOSError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as NodeJS.ErrnoException).code === 'string' &&
    typeof (e as NodeJS.ErrnoException).syscall === 'string'
  );
}
