/**
 * @oakoliver/specify-cli - Integration Upgrade Layout Guards
 *
 * Layout-migration guards for `specify integration upgrade`
 * (port of `integrations/_command_upgrade_layout.py`).
 *
 * @module integrations/command-upgrade-layout
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Preset registry file name (upstream `PresetRegistry.REGISTRY_FILE`). */
const PRESET_REGISTRY_FILE = '.registry';

/** Structural manifest surface used by these guards. */
export interface ManifestFilesLike {
  readonly files: Record<string, string>;
}

/** Structural integration surface used by these guards. */
export interface RegistrarConfigLike {
  readonly registrarConfig?: Record<string, unknown> | null;
}

function registrarConfigOf(integration: RegistrarConfigLike): Record<string, unknown> {
  const rec = integration as unknown as Record<string, unknown>;
  const cfg = (rec['registrarConfig'] ?? rec['registrar_config']) as Record<string, unknown> | null | undefined;
  return cfg ?? {};
}

function posix(p: string): string {
  // PurePath(p).as_posix() on POSIX: collapse duplicate slashes and "." parts.
  const absolute = p.startsWith('/');
  const parts = p.split('/').filter((part) => part !== '' && part !== '.');
  const joined = parts.join('/');
  if (absolute) return '/' + joined;
  return joined || '.';
}

function stripSlashes(p: string): string {
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Return true when `manifest` tracks any skills-layout artifact
 * (a `.../speckit-<name>/SKILL.md` key).
 */
export function manifestTracksSkillLayout(manifest: ManifestFilesLike): boolean {
  return Object.keys(manifest.files).some((rel) => String(rel).endsWith('/SKILL.md'));
}

/** Return true when manifest key `relPath` is inside project-relative `root`. */
export function manifestPathUnder(relPath: string, root: string): boolean {
  const normalizedRoot = stripSlashes(posix(root));
  const normalizedRel = stripSlashes(posix(relPath));
  if (!normalizedRoot || normalizedRoot === '.') return false;
  return normalizedRel === normalizedRoot || normalizedRel.startsWith(`${normalizedRoot}/`);
}

function legacyPair(integration: RegistrarConfigLike): [string, string] | null {
  const config = registrarConfigOf(integration);
  const canonical = config['dir'];
  const legacy = config['legacy_dir'];
  if (
    typeof canonical !== 'string' ||
    !canonical.trim() ||
    typeof legacy !== 'string' ||
    !legacy.trim() ||
    posix(canonical) === posix(legacy)
  ) {
    return null;
  }
  return [canonical, legacy];
}

/** Return true when command artifacts moved from legacy_dir to canonical dir. */
export function legacyCommandRootChanged(
  integration: RegistrarConfigLike,
  projectRoot: string,
  oldManifest: ManifestFilesLike,
  newManifest: ManifestFilesLike,
): boolean {
  const pair = legacyPair(integration);
  if (!pair) return false;
  const [canonical, legacy] = pair;

  if (!isDir(join(projectRoot, canonical)) || !isDir(join(projectRoot, legacy))) return false;

  const oldHadLegacy = Object.keys(oldManifest.files).some((rel) => manifestPathUnder(rel, legacy));
  const newHasCanonical = Object.keys(newManifest.files).some((rel) => manifestPathUnder(rel, canonical));
  return oldHadLegacy && newHasCanonical;
}

/** Return true when the old manifest tracks command files under legacy_dir. */
export function legacyCommandRootUpgradePending(
  integration: RegistrarConfigLike,
  oldManifest: ManifestFilesLike,
): boolean {
  const pair = legacyPair(integration);
  if (!pair) return false;
  const legacy = pair[1];
  return Object.keys(oldManifest.files).some((rel) => manifestPathUnder(rel, legacy));
}

/**
 * Raised when an existing preset registry cannot be read or parsed.
 * Distinct from a genuinely absent registry (no presets installed).
 */
export class PresetRegistryUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetRegistryUnreadableError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Return IDs of installed presets with artifacts registered for `agentKey`.
 *
 * Fails closed: an absent registry returns `[]`, but an unreadable or
 * malformed registry throws {@link PresetRegistryUnreadableError}.
 */
export function installedPresetsAffectingAgent(
  projectRoot: string,
  agentKey: string,
  opts: { includeSkills?: boolean } = {},
): string[] {
  const includeSkills = opts.includeSkills ?? true;
  const registryPath = join(projectRoot, '.specify', 'presets', PRESET_REGISTRY_FILE);
  if (!existsSync(registryPath)) return [];

  let data: unknown;
  try {
    const raw = readFileSync(registryPath);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    data = JSON.parse(text);
  } catch (exc) {
    throw new PresetRegistryUnreadableError(exc instanceof Error ? exc.message : String(exc));
  }
  const presets = isPlainObject(data) ? ('presets' in data ? data['presets'] : {}) : undefined;
  if (!isPlainObject(data) || !isPlainObject(presets)) {
    throw new PresetRegistryUnreadableError('preset registry structure is malformed');
  }

  const affected: string[] = [];
  for (const [presetId, meta] of Object.entries(presets)) {
    if (!isPlainObject(meta)) {
      throw new PresetRegistryUnreadableError(`preset '${presetId}' entry is malformed`);
    }
    const registeredCommands = 'registered_commands' in meta ? meta['registered_commands'] : {};
    if (
      !isPlainObject(registeredCommands) ||
      !Object.values(registeredCommands).every((names) => Array.isArray(names))
    ) {
      throw new PresetRegistryUnreadableError(`preset '${presetId}' registered_commands is malformed`);
    }
    const registeredSkills = 'registered_skills' in meta ? meta['registered_skills'] : [];
    let hasSkills: boolean;
    if (isPlainObject(registeredSkills)) {
      if (!Object.values(registeredSkills).every((names) => Array.isArray(names))) {
        throw new PresetRegistryUnreadableError(`preset '${presetId}' registered_skills is malformed`);
      }
      const forAgent = registeredSkills[agentKey];
      hasSkills = includeSkills && Array.isArray(forAgent) && forAgent.length > 0;
    } else if (Array.isArray(registeredSkills)) {
      hasSkills = includeSkills && registeredSkills.length > 0;
    } else {
      throw new PresetRegistryUnreadableError(`preset '${presetId}' registered_skills is malformed`);
    }
    const commandsForAgent = registeredCommands[agentKey];
    const hasCommands = Array.isArray(commandsForAgent) && commandsForAgent.length > 0;
    if (hasCommands || hasSkills) affected.push(presetId);
  }
  return affected;
}

/** Return installed presets with command artifacts registered for `agentKey`. */
export function installedCommandPresetsAffectingAgent(projectRoot: string, agentKey: string): string[] {
  return installedPresetsAffectingAgent(projectRoot, agentKey, { includeSkills: false });
}
