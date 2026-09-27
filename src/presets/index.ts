/**
 * @oakoliver/specify-cli - Preset domain exports
 *
 * Port of ``specify_cli/presets/__init__.py``: package-level names for the
 * preset domain (manifest, registry, resolver, manager, catalog) plus the CLI
 * dispatcher ``runPresetCommand``.
 *
 * @module presets
 */

export { MAX_JSON_CATALOG_BYTES, readResponseLimited } from '../download-security.js';
export { ExtensionRegistry } from '../extensions/index.js';
export { verifyArchiveSha256 } from '../shared-infra.js';

export { PresetCatalog, PresetCatalogEntry, type PresetCatalogPack } from './catalog.js';
export {
  CONSTITUTION_PROVENANCE_FILE,
  CONSTITUTION_SYNC_PRESET_ID,
  PresetManager,
  _CONSTITUTION_PROVENANCE_FILE,
  _CONSTITUTION_SYNC_PRESET_ID,
  _constitutionIsGenerated,
  _constitutionProvenanceMatchesPreset,
  _contentSha256,
  _isComparableVersion,
  _materializeConstitutionTemplate,
  constitutionIsGenerated,
  constitutionProvenanceMatchesPreset,
  contentSha256,
  isComparableVersion,
  materializeConstitutionTemplate,
  presetManagerHooks,
  type InstalledPresetRecord,
  type PresetInstallOptions,
  type UnmetExtensionDependency,
} from './manager.js';
export {
  _substituteCoreTemplate,
  skillNamesForCommand,
  substituteCoreTemplate,
  type AgentNameMap,
  type SkillDirProvenance,
} from './manager-commands.js';
export { SKILL_DESCRIPTIONS } from './manager-skills.js';
export {
  PresetCompatibilityError,
  PresetError,
  PresetManifest,
  PresetValidationError,
  VALID_PRESET_STRATEGIES,
  VALID_PRESET_TEMPLATE_TYPES,
  VALID_SCRIPT_STRATEGIES,
  presetWarn,
  setPresetWarningHandler,
  type PresetExtensionDependency,
  type PresetTemplateEntry,
  type PresetWarningHandler,
} from './manifest.js';
export { PresetRegistry, type PresetRegistryEntry } from './registry.js';
export { PresetResolver, presetAssetHooks, type PresetLayer, type ResolvedWithSource } from './resolver.js';
export {
  MINIMUM_PRESET_PRIORITY,
  presetAdd,
  presetCommandHooks,
  presetRemove,
  presetUpdate,
  runPresetCommand,
  warnUnmetExtensionDependencies,
} from './commands.js';
