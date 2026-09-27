/**
 * @oakoliver/specify-cli - Preset installation, removal, and lifecycle
 *
 * Port of ``specify_cli/presets/_manager.py``: ``PresetManager`` (install from
 * directory/archive, remove with command/skill restoration and priority-stack
 * reconciliation, listing) plus the constitution-sync helpers.
 *
 * @module presets/manager
 */

import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

// Import order matters: the mixin chain (manager-commands <- manager-skills <-
// manager) must be evaluated before modules that cycle back through
// agents.ts -> presets/index.ts.
import { PresetSkillMethods } from './manager-skills.js';
import { safeExtractArchive } from '../download-security.js';
import { ExtensionRegistry, REINSTALL_COMMAND, normalizePriority } from '../extensions/index.js';
import {
  isAiSkillsEnabled,
  loadInitOptions,
  resolveActiveAgentForRegistration,
} from '../init-options.js';
import {
  ensureSafeSharedDestination,
  ensureSafeSharedDirectory,
  writeSharedBytes,
  writeSharedText,
} from '../shared-infra.js';
import { versionSatisfies } from '../utils.js';
import { registrarAgentConfigs, skillNamesForCommand, type AgentNameMap } from './manager-commands.js';
import {
  PresetCompatibilityError,
  PresetError,
  PresetManifest,
  PresetValidationError,
  UnicodeDecodeError,
  isDir,
  isMapping,
  isValidPep440Version,
  isValidSpecifierSet,
  pathExists,
  presetWarn,
  pyJsonDumps,
  pyRepr,
  pyTruthy,
  pyTypeName,
  readTextStrict,
  isFile,
  type PresetExtensionDependency,
} from './manifest.js';
import { PresetRegistry } from './registry.js';
import { PresetResolver, isOsError, readBytes } from './resolver.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

export const CONSTITUTION_PROVENANCE_FILE = '.constitution-template.json';
export const CONSTITUTION_SYNC_PRESET_ID = 'constitution-sync';
/** Upstream-name aliases. */
export const _CONSTITUTION_PROVENANCE_FILE = CONSTITUTION_PROVENANCE_FILE;
export const _CONSTITUTION_SYNC_PRESET_ID = CONSTITUTION_SYNC_PRESET_ID;

/** Hex SHA-256 of raw content bytes. */
export function contentSha256(content: Uint8Array | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Return whether a recorded version can be evaluated against a specifier
 * (``versionSatisfies`` answers "no" for unparseable versions).
 */
export function isComparableVersion(value: string): boolean {
  return isValidPep440Version(value);
}

/** Return whether the live constitution is an unchanged generated file. */
export function constitutionIsGenerated(
  projectRoot: string,
  memoryConstitution: string,
  resolver: PresetResolver,
): boolean {
  ensureSafeSharedDestination(projectRoot, memoryConstitution);
  const content = readBytes(memoryConstitution);
  const provenance = nodePath.join(nodePath.dirname(memoryConstitution), CONSTITUTION_PROVENANCE_FILE);
  ensureSafeSharedDestination(projectRoot, provenance);

  if (pathExists(provenance)) {
    let metadata: unknown;
    try {
      metadata = JSON.parse(readTextStrict(provenance));
    } catch (e) {
      if (e instanceof SyntaxError || e instanceof UnicodeDecodeError) return false;
      throw e;
    }
    return isMapping(metadata) && metadata.sha256 === contentSha256(content);
  }

  const core = resolver.findBundledCore('constitution-template', 'template', '.md');
  return core !== null && readBytes(core).equals(content);
}

/** Return whether provenance identifies a preset as the materialized source. */
export function constitutionProvenanceMatchesPreset(
  projectRoot: string,
  memoryConstitution: string,
  packId: string,
  packVersion: string,
): boolean {
  const provenance = nodePath.join(nodePath.dirname(memoryConstitution), CONSTITUTION_PROVENANCE_FILE);
  if (!pathExists(nodePath.dirname(provenance))) return false;
  ensureSafeSharedDestination(projectRoot, provenance);
  if (!pathExists(provenance)) return false;
  let metadata: unknown;
  try {
    metadata = JSON.parse(readTextStrict(provenance));
  } catch (e) {
    if (e instanceof SyntaxError || e instanceof UnicodeDecodeError || isOsError(e)) return false;
    throw e;
  }
  return isMapping(metadata) && metadata.source === `${packId} v${packVersion}`;
}

/**
 * Materialize constitution-template content into memory/constitution.md.
 *
 * @returns ``"copied"`` (replace layer copied verbatim), ``"composed"``
 *   (composing strategy materialized), or null when nothing resolves.
 */
export function materializeConstitutionTemplate(
  projectRoot: string,
  memoryConstitution: string,
): 'copied' | 'composed' | null {
  const resolver = new PresetResolver(projectRoot);
  const layers = resolver.collectAllLayers('constitution-template', 'template');
  if (!layers.length) return null;

  const topLayer = layers[0];
  let content: Buffer;
  let result: 'copied' | 'composed';
  if (topLayer.strategy === 'replace') {
    content = readBytes(topLayer.path);
    result = 'copied';
  } else {
    const composed = resolver.resolveContent('constitution-template', 'template');
    if (composed === null) return null;
    content = Buffer.from(composed, 'utf-8');
    result = 'composed';
  }

  ensureSafeSharedDirectory(projectRoot, nodePath.dirname(memoryConstitution));
  writeSharedBytes(projectRoot, memoryConstitution, content);
  const provenance = nodePath.join(nodePath.dirname(memoryConstitution), CONSTITUTION_PROVENANCE_FILE);
  writeSharedText(
    projectRoot,
    provenance,
    pyJsonDumps({ sha256: contentSha256(content), source: topLayer.source }, 2) + '\n',
  );
  return result;
}

/** Upstream-name aliases of the constitution helpers. */
export const _contentSha256 = contentSha256;
export const _isComparableVersion = isComparableVersion;
export const _constitutionIsGenerated = constitutionIsGenerated;
export const _constitutionProvenanceMatchesPreset = constitutionProvenanceMatchesPreset;
export const _materializeConstitutionTemplate = materializeConstitutionTemplate;

/** One unsatisfied ``requires.extensions`` dependency. */
export interface UnmetExtensionDependency extends PresetExtensionDependency {
  installed: string | null;
  reason: 'missing' | 'corrupt' | 'stale' | 'disabled' | 'version';
}

/** Record returned by {@link PresetManager.listInstalled}. */
export interface InstalledPresetRecord {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  installed_at: unknown;
  template_count: number;
  tags: unknown;
  priority: number;
  _json_author: string | null;
  _json_source: unknown;
  _json_provides: { commands: number; templates: number; scripts: number; hooks: number };
}

/** Options for the install entry points. */
export interface PresetInstallOptions {
  /** If true and the preset is already installed, remove it first. */
  force?: boolean;
  /** Catalog the preset came from (recorded as the registry ``source``). */
  catalogName?: string | null;
}

/** Hook for tests: the ``ExtensionRegistry`` class used by dependency checks. */
export const presetManagerHooks: { ExtensionRegistry: typeof ExtensionRegistry } = { ExtensionRegistry };

/** Manages preset lifecycle: installation, removal, updates. */
export class PresetManager extends PresetSkillMethods {
  readonly projectRoot: string;
  readonly presetsDir: string;
  readonly registry: PresetRegistry;

  constructor(projectRoot: string) {
    super();
    this.projectRoot = projectRoot;
    this.presetsDir = nodePath.join(projectRoot, '.specify', 'presets');
    this.registry = new PresetRegistry(this.presetsDir);
  }

  /**
   * Check if preset is compatible with current spec-kit version.
   *
   * @throws PresetCompatibilityError If pack is incompatible
   */
  checkCompatibility(manifest: PresetManifest, speckitVersion: string): boolean {
    const required: unknown = manifest.requiresSpeckitVersion;
    if (typeof required !== 'string') {
      throw new PresetCompatibilityError(
        `Invalid version specifier: expected a string, got ${pyTypeName(required)} (${pyRepr(required)})`,
      );
    }
    if (!isValidSpecifierSet(required)) {
      throw new PresetCompatibilityError(`Invalid version specifier: ${required}`);
    }
    if (!versionSatisfies(speckitVersion, required)) {
      throw new PresetCompatibilityError(
        `Preset requires spec-kit ${required}, but ${speckitVersion} is installed.\n` +
          `Upgrade spec-kit with: ${REINSTALL_COMMAND}`,
      );
    }
    return true;
  }

  /**
   * Find declared extension dependencies that are not satisfied (reports
   * rather than raises; optional dependencies are never reported).
   */
  findUnmetExtensionDependencies(manifest: PresetManifest): UnmetExtensionDependency[] {
    let candidates: unknown;
    try {
      candidates = (manifest as unknown as { requiresExtensions?: unknown }).requiresExtensions;
    } catch {
      candidates = undefined;
    }
    if (!Array.isArray(candidates)) return [];

    const declared: PresetExtensionDependency[] = [];
    const seen = new Set<string>();
    for (const dep of candidates) {
      if (!isMapping(dep) || !pyTruthy('required' in dep ? dep.required : true)) continue;
      const key = JSON.stringify([dep.id ?? null, dep.version ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      declared.push(dep as PresetExtensionDependency);
    }
    if (!declared.length) return [];

    const extensionsDir = nodePath.join(this.projectRoot, '.specify', 'extensions');
    let registry: ExtensionRegistry;
    let registeredIds: Set<string>;
    let registryCorrupt: boolean;
    try {
      registry = new presetManagerHooks.ExtensionRegistry(extensionsDir);
      registeredIds = registry.keys();
      registryCorrupt = registry.isCorrupt();
    } catch (e) {
      if (isOsError(e)) return [];
      throw e;
    }

    const unmet: UnmetExtensionDependency[] = [];
    for (const dep of declared) {
      const metadata = registry.get(dep.id);
      if (metadata === null || metadata === undefined) {
        if (registeredIds.has(dep.id)) {
          unmet.push({ ...dep, installed: null, reason: 'corrupt' });
          continue;
        }
        if (
          isDir(nodePath.join(extensionsDir, dep.id)) &&
          PresetResolver.isSafeRegistryId(dep.id) &&
          !registryCorrupt
        ) {
          continue;
        }
        unmet.push({ ...dep, installed: null, reason: 'missing' });
        continue;
      }

      const rawInstalled = (metadata as Dict).version;
      const installedVersion = typeof rawInstalled === 'string' ? rawInstalled : null;

      if (!isDir(nodePath.join(extensionsDir, dep.id))) {
        unmet.push({ ...dep, installed: installedVersion, reason: 'stale' });
        continue;
      }

      if (!pyTruthy('enabled' in metadata ? (metadata as Dict).enabled : true)) {
        unmet.push({ ...dep, installed: installedVersion, reason: 'disabled' });
        continue;
      }

      const constraint = dep.version;
      if (!pyTruthy(constraint)) continue;
      if (installedVersion === null || !isComparableVersion(installedVersion)) continue;
      if (!versionSatisfies(installedVersion, constraint as string)) {
        unmet.push({ ...dep, installed: installedVersion, reason: 'version' });
      }
    }
    return unmet;
  }

  /**
   * Install preset from a local directory.
   *
   * @param priority Resolution priority (lower = higher precedence, default 10)
   * @throws PresetValidationError If manifest is invalid or priority is invalid
   * @throws PresetCompatibilityError If pack is incompatible
   */
  installFromDirectory(
    sourceDir: string,
    speckitVersion: string,
    priority = 10,
    opts: PresetInstallOptions = {},
  ): PresetManifest {
    const force = opts.force ?? false;
    if (priority < 1) {
      throw new PresetValidationError('Priority must be a positive integer (1 or higher)');
    }

    const manifest = new PresetManifest(nodePath.join(sourceDir, 'preset.yml'));
    this.checkCompatibility(manifest, speckitVersion);

    if (this.registry.isInstalled(manifest.id)) {
      if (!force) {
        throw new PresetError(
          `Preset '${manifest.id}' is already installed. Use 'specify preset remove ${manifest.id}' first.`,
        );
      }
      this.remove(manifest.id);
    }

    const destDir = nodePath.join(this.presetsDir, manifest.id);
    if (pathExists(destDir)) rmSync(destDir, { recursive: true, force: true });
    cpSync(sourceDir, destDir, { recursive: true, dereference: true });

    const catalogName = opts.catalogName;
    const normalizedCatalogName = typeof catalogName === 'string' ? catalogName.trim() : '';
    const source = normalizedCatalogName ? { kind: 'catalog', catalog: normalizedCatalogName } : 'local';
    this.registry.add(manifest.id, {
      version: manifest.version,
      source,
      manifest_hash: manifest.getHash(),
      enabled: true,
      priority,
      registered_commands: {},
      registered_skills: {},
    });

    let registeredCommands: AgentNameMap = {};
    const registeredSkills: AgentNameMap = {};
    try {
      registeredCommands = this.registerCommands(manifest, destDir);
      this.registry.update(manifest.id, { registered_commands: registeredCommands });

      const skills = this.registerSkills(manifest, destDir);
      Object.assign(registeredSkills, skills);
      this.registry.update(manifest.id, { registered_skills: skills });
    } catch (err) {
      if (Object.keys(registeredCommands).length) this.unregisterCommands(registeredCommands);
      const persistedMetadata = this.registry.get(manifest.id) ?? {};
      const persistedSkills =
        'registered_skills' in persistedMetadata ? persistedMetadata.registered_skills : registeredSkills;
      if (pyTruthy(persistedSkills)) {
        this.unregisterSkills(persistedSkills, destDir, { restoreFromBundledCore: true });
      }
      try {
        if (pathExists(destDir)) rmSync(destDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; don't mask the original error
      }
      this.registry.remove(manifest.id);
      throw err;
    }

    const cmdNames = manifest.templates.filter((t) => t.type === 'command').map((t) => t.name);
    if (cmdNames.length) {
      try {
        this.reconcileComposedCommands(cmdNames);
        this.reconcileSkills(cmdNames);
      } catch (exc) {
        presetWarn(
          `Post-install reconciliation failed for ${manifest.id}: ${exc instanceof Error ? exc.message : String(exc)}. ` +
            `Agent command files may not reflect the current priority stack.`,
        );
      }
    }

    this.seedConstitutionFromPreset(manifest, destDir);
    return manifest;
  }

  /**
   * Seed memory/constitution.md when constitution-sync opts into snapshots.
   * Authored constitutions are never overwritten.
   */
  seedConstitutionFromPreset(manifest: PresetManifest, presetDir: string): void {
    const providesConstitution =
      manifest.id === CONSTITUTION_SYNC_PRESET_ID ||
      manifest.templates.some((t) => t.type === 'template' && t.name === 'constitution-template') ||
      ['templates/constitution-template.md', 'constitution-template.md'].some((rel) =>
        isFile(nodePath.join(presetDir, rel)),
      );
    if (!providesConstitution) return;
    this.reconcileConstitution(`Failed to seed constitution from preset ${manifest.id}`, { createIfMissing: true });
  }

  /** Reconcile an opted-in generated constitution without failing a change. */
  reconcileConstitution(failureContext: string, opts: { createIfMissing?: boolean } = {}): void {
    try {
      this._reconcileConstitution(opts);
    } catch (exc) {
      if (isConstitutionRecoverableError(exc)) {
        presetWarn(`${failureContext}: ${(exc as Error).message}.`);
        return;
      }
      throw exc;
    }
  }

  /** Materialize the winning layer when constitution-sync is enabled. */
  _reconcileConstitution(opts: { createIfMissing?: boolean } = {}): void {
    const createIfMissing = opts.createIfMissing ?? false;
    const syncMetadata = this.registry.get(CONSTITUTION_SYNC_PRESET_ID);
    if (syncMetadata === null || !pyTruthy('enabled' in syncMetadata ? syncMetadata.enabled : true)) return;

    const memoryConstitution = nodePath.join(this.projectRoot, '.specify', 'memory', 'constitution.md');
    if (!pathExists(memoryConstitution) && !createIfMissing) return;
    const resolver = new PresetResolver(this.projectRoot);
    if (
      pathExists(memoryConstitution) &&
      !constitutionIsGenerated(this.projectRoot, memoryConstitution, resolver)
    ) {
      return;
    }
    materializeConstitutionTemplate(this.projectRoot, memoryConstitution);
  }

  /**
   * Install a preset from a supported archive (.zip, .tar.gz, .tgz).
   *
   * @throws PresetValidationError If manifest is invalid or priority is invalid
   * @throws PresetCompatibilityError If pack is incompatible
   */
  installFromArchive(
    archivePath: string,
    speckitVersion: string,
    priority = 10,
    opts: PresetInstallOptions = {},
  ): PresetManifest {
    if (priority < 1) {
      throw new PresetValidationError('Priority must be a positive integer (1 or higher)');
    }
    const tmp = mkdtempSync(nodePath.join(tmpdir(), 'specify-preset-'));
    try {
      safeExtractArchive(archivePath, tmp, { errorType: PresetValidationError });

      let packDir = tmp;
      let manifestPath = nodePath.join(packDir, 'preset.yml');
      if (!pathExists(manifestPath)) {
        const subdirs = readdirSync(tmp)
          .map((n) => nodePath.join(tmp, n))
          .filter((p) => isDir(p));
        if (subdirs.length === 1) {
          packDir = subdirs[0];
          manifestPath = nodePath.join(packDir, 'preset.yml');
        }
      }
      if (!pathExists(manifestPath)) {
        throw new PresetValidationError('No preset.yml found in archive');
      }
      return this.installFromDirectory(packDir, speckitVersion, priority, opts);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Backward-compatible wrapper for archive installation. */
  installFromZip(
    zipPath: string,
    speckitVersion: string,
    priority = 10,
    opts: PresetInstallOptions = {},
  ): PresetManifest {
    return this.installFromArchive(zipPath, speckitVersion, priority, opts);
  }

  /**
   * Remove an installed preset, restoring skills/commands and reconciling the
   * remaining priority stack.
   *
   * @returns True if pack was removed
   */
  remove(packId: string): boolean {
    if (!this.registry.isInstalled(packId)) return false;

    const metadata = this.registry.get(packId);
    let registeredSkills: AgentNameMap | string[] | unknown =
      metadata && 'registered_skills' in metadata ? metadata.registered_skills : [];
    if (Array.isArray(registeredSkills) && registeredSkills.length) {
      const initOpts = loadInitOptions(this.projectRoot);
      let fallbackAgent: unknown = isMapping(initOpts) ? initOpts.ai : null;
      if (typeof fallbackAgent !== 'string') fallbackAgent = '';
      registeredSkills = this.inferLegacySkillProvenance(
        registeredSkills.filter((n): n is string => typeof n === 'string'),
        packId,
        fallbackAgent as string,
      );
    }
    let registeredCommands: AgentNameMap =
      metadata && 'registered_commands' in metadata ? (metadata.registered_commands as AgentNameMap) : {};
    if (!isMapping(registeredCommands)) registeredCommands = {};
    const packDir = nodePath.join(this.presetsDir, packId);

    const configs = registrarAgentConfigs();
    const affectedCommandAgents = new Set(
      Object.keys(registeredCommands).filter((agentName) => (configs[agentName] ?? {}).extension !== '/SKILL.md'),
    );

    const removedCmdNames = new Set<string>();
    let removedConstitution = [
      nodePath.join(packDir, 'templates', 'constitution-template.md'),
      nodePath.join(packDir, 'constitution-template.md'),
    ].some((p) => pathExists(p));
    if (metadata && typeof metadata.version === 'string') {
      const memoryConstitution = nodePath.join(this.projectRoot, '.specify', 'memory', 'constitution.md');
      removedConstitution =
        removedConstitution ||
        constitutionProvenanceMatchesPreset(this.projectRoot, memoryConstitution, packId, metadata.version);
    }
    for (const cmdNames of Object.values(registeredCommands)) {
      for (const n of Array.isArray(cmdNames) ? cmdNames : []) removedCmdNames.add(n);
    }
    const manifestPath = nodePath.join(packDir, 'preset.yml');
    if (pathExists(manifestPath)) {
      try {
        const manifest = new PresetManifest(manifestPath);
        for (const tmpl of manifest.templates) {
          if (tmpl.type === 'template' && tmpl.name === 'constitution-template') removedConstitution = true;
          if (tmpl.type === 'command') {
            if (typeof tmpl.name === 'string') removedCmdNames.add(tmpl.name);
            const aliases = 'aliases' in tmpl ? tmpl.aliases : [];
            for (const alias of Array.isArray(aliases) ? aliases : []) {
              if (typeof alias === 'string') removedCmdNames.add(alias);
            }
          }
        }
      } catch (e) {
        if (!(e instanceof PresetValidationError)) throw e;
        // Invalid manifest — skip alias extraction.
      }
    }

    let affectedSkillDirs = new Map<string, [string | null, string[]]>();
    if (pyTruthy(registeredSkills)) {
      let restorableSkills = registeredSkills as AgentNameMap | string[];
      const resolvedActive = resolveActiveAgentForRegistration(this.projectRoot);
      if (
        isMapping(registeredSkills) &&
        typeof resolvedActive === 'string' &&
        resolvedActive in registeredSkills &&
        (configs[resolvedActive] ?? {}).extension !== '/SKILL.md' &&
        !isAiSkillsEnabled(loadInitOptions(this.projectRoot))
      ) {
        const rawNames = (registeredSkills as Dict)[resolvedActive];
        const staleNames = (Array.isArray(rawNames) ? rawNames : []).filter(
          (n): n is string => typeof n === 'string',
        );
        const filtered: AgentNameMap = {};
        for (const [agentName, names] of Object.entries(registeredSkills as AgentNameMap)) {
          if (agentName !== resolvedActive) filtered[agentName] = names;
        }
        restorableSkills = filtered;
        if (staleNames.length) this.deleteAgentPresetSkills(resolvedActive, staleNames, packId);
      }
      const overrideSources: Record<string, string> = {};
      for (const commandName of removedCmdNames) {
        for (const skillName of skillNamesForCommand(commandName)) {
          overrideSources[skillName] = `override:${commandName}`;
        }
      }
      affectedSkillDirs = this.unregisterSkills(restorableSkills, packDir, {
        additionalOwnedSources: overrideSources,
        restoreFromBundledCore: true,
      });

      const skillCoverage: Dict = isMapping(registeredSkills) ? registeredSkills : {};
      const commandsToUnregister: AgentNameMap = {};
      for (const [agentName, cmdNames] of Object.entries(registeredCommands)) {
        const isNativeSkillAgent = (configs[agentName] ?? {}).extension === '/SKILL.md';
        if (!isNativeSkillAgent) {
          commandsToUnregister[agentName] = cmdNames;
          continue;
        }
        const rawSkillNames = agentName in skillCoverage ? skillCoverage[agentName] : [];
        const coveredSkillNames = new Set(
          (Array.isArray(rawSkillNames) ? rawSkillNames : []).filter((n): n is string => typeof n === 'string'),
        );
        const uncoveredCommands = (Array.isArray(cmdNames) ? cmdNames : []).filter(
          (cmdName) =>
            typeof cmdName !== 'string' || !skillNamesForCommand(cmdName).some((n) => coveredSkillNames.has(n)),
        );
        if (uncoveredCommands.length) commandsToUnregister[agentName] = uncoveredCommands;
      }
      registeredCommands = commandsToUnregister;
    }

    if (Object.keys(registeredCommands).length) this.unregisterCommands(registeredCommands);

    if (pathExists(packDir)) rmSync(packDir, { recursive: true, force: true });

    this.registry.remove(packId);

    if (removedCmdNames.size) {
      try {
        this.reconcileComposedCommands([...removedCmdNames], affectedCommandAgents);
        this.reconcileSkills([...removedCmdNames], affectedSkillDirs);
      } catch (exc) {
        presetWarn(
          `Post-removal reconciliation failed for ${packId}: ${exc instanceof Error ? exc.message : String(exc)}. ` +
            `Agent command files may be stale; reinstall affected presets ` +
            `or run 'specify preset add' to refresh.`,
        );
      }
    }

    if (removedConstitution) {
      try {
        this._reconcileConstitution();
      } catch (exc) {
        if (isConstitutionRecoverableError(exc)) {
          presetWarn(
            `Post-removal constitution reconciliation failed for ${packId}: ` +
              `${(exc as Error).message}. The live constitution may be stale.`,
          );
        } else {
          throw exc;
        }
      }
    }

    return true;
  }

  /** List all installed presets with metadata. */
  listInstalled(): InstalledPresetRecord[] {
    const result: InstalledPresetRecord[] = [];
    for (const [packId, rawMetadata] of Object.entries(this.registry.list())) {
      const metadata: Dict = isMapping(rawMetadata) ? rawMetadata : {};
      const manifestPath = nodePath.join(this.presetsDir, packId, 'preset.yml');
      try {
        const manifest = new PresetManifest(manifestPath);
        const providedCounts = { commands: 0, templates: 0, scripts: 0, hooks: 0 };
        for (const template of manifest.templates) {
          const key = `${template.type}s` as keyof typeof providedCounts;
          providedCounts[key] += 1;
        }
        const author = manifest.author;
        result.push({
          id: packId,
          name: manifest.name,
          version: ('version' in metadata ? metadata.version : manifest.version) as string,
          description: manifest.description,
          enabled: ('enabled' in metadata ? metadata.enabled : true) as boolean,
          installed_at: metadata.installed_at ?? null,
          template_count: manifest.templates.length,
          tags: manifest.tags,
          priority: normalizePriority(metadata.priority ?? null),
          _json_author: typeof author === 'string' && author ? author : null,
          _json_source: metadata.source ?? null,
          _json_provides: providedCounts,
        });
      } catch (e) {
        if (!(e instanceof PresetValidationError)) throw e;
        result.push({
          id: packId,
          name: packId,
          version: ('version' in metadata ? metadata.version : 'unknown') as string,
          description: '⚠️ Corrupted preset',
          enabled: false,
          installed_at: metadata.installed_at ?? null,
          template_count: 0,
          tags: [],
          priority: normalizePriority(metadata.priority ?? null),
          _json_author: null,
          _json_source: metadata.source ?? null,
          _json_provides: { commands: 0, templates: 0, scripts: 0, hooks: 0 },
        });
      }
    }
    return result;
  }

  /** Get manifest for an installed preset (null if not installed or invalid). */
  getPack(packId: string): PresetManifest | null {
    if (!this.registry.isInstalled(packId)) return null;
    try {
      return new PresetManifest(nodePath.join(this.presetsDir, packId, 'preset.yml'));
    } catch (e) {
      if (e instanceof PresetValidationError) return null;
      throw e;
    }
  }
}

/** ``(OSError, UnicodeDecodeError, PresetValidationError, ValueError)`` classification. */
function isConstitutionRecoverableError(exc: unknown): boolean {
  if (exc instanceof UnicodeDecodeError || exc instanceof PresetValidationError || isOsError(exc)) return true;
  // Python ValueError: raised by the shared-infra path guards as plain Error.
  return exc instanceof Error && (exc.constructor === Error || exc.name === 'SymlinkedSharedPathError');
}
