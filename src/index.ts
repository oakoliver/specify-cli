/**
 * @oakoliver/specify-cli
 *
 * Spec-Driven Development CLI for AI coding agents.
 * Zero dependencies, multi-runtime.
 *
 * @packageDocumentation
 */

// Types
export {
  // Agent types
  type AgentConfig,
  type AgentName,
  type CommandFormat,
  AGENT_CONFIGS,
  SUPPORTED_AGENTS,

  // Init options
  type InitOptions,
  type ScriptType,
  type BranchNumbering,
  DEFAULT_INIT_OPTIONS,

  // Extension types (legacy)
  type CommandDefinition,
  type TemplateOverride,
  type HookDefinition,
  type ExtensionManifest as ExtensionManifestLegacy,
  type ExtensionRegistryEntry,

  // Preset types (legacy)
  type PresetManifest as PresetManifestLegacy,
  type PresetRegistryEntry,

  // Project type
  type Project,

  // Utility functions
  isAgentSupported,
  getAgentCommandsDir,
  getCommandFilePath,
  isSkillBasedAgent,
  isTomlAgent,
  isYamlAgent,
  getAgentArgsPlaceholder,
} from './types.js';

// Configuration
export {
  // Path constants
  SPECKIT_DIR,
  INIT_OPTIONS_PATH,
  EXTENSION_REGISTRY_PATH,
  PRESET_REGISTRY_PATH,
  TEMPLATES_DIR,
  SCRIPTS_DIR,
  MEMORY_DIR,

  // Init options
  loadInitOptions,
  saveInitOptions,

  // Extension registry (legacy)
  type ExtensionRegistry as ExtensionRegistryLegacy,
  loadExtensionRegistry,
  saveExtensionRegistry,

  // Preset registry (legacy)
  type PresetRegistry as PresetRegistryLegacy,
  loadPresetRegistry,
  savePresetRegistry,

  // Project detection
  isSpeckitProject,
  findProjectRoot,
} from './config.js';

// Command Registrar
export {
  // Types
  type RegisteredCommands,
  type ParsedFrontmatter,

  // Frontmatter parsing
  parseFrontmatter,
  renderFrontmatter,

  // Format generation
  toToml,
  toYamlRecipe,

  // Command registration
  registerCommands,
  registerCommandsForAllAgents,
  unregisterCommands,
} from './registrar.js';

// Init Command
export {
  type InitCommandOptions,
  parseInitArgs,
  init,
} from './init.js';

// Templates
export {
  getTemplatesDir,
  copyDirectory,
  copyFile,
  copyTemplatesToProject,
  getCommandTemplate,
  getAvailableCommands,
} from './templates.js';

// UI Components
export {
  titleStyle,
  successStyle,
  errorStyle,
  warningStyle,
  dimStyle,
  accentStyle,
  printBanner,
  printStep,
  printSuccess,
  printError,
  printWarning,
  printInfo,
  printNextSteps,
} from './ui.js';

// Check Command
export {
  type CheckResult,
  check,
} from './check.js';

// Extension System
export {
  // Constants
  EXTENSION_SCHEMA_VERSION,
  EXTENSION_ID_PATTERN,
  COMMAND_NAME_PATTERN,
  SEMVER_PATTERN,
  DEFAULT_PRIORITY,

  // Errors
  ExtensionError,
  ValidationError,
  CompatibilityError,

  // Types
  type ToolRequirement,
  type ExtensionCommand,
  type ExtensionConfig,
  type ExtensionHook,
  type ExtensionManifestData,
  type ExtensionMetadata,
  type ExtensionInfo,

  // YAML utilities
  parseSimpleYaml,
  toYaml,

  // Classes
  ExtensionManifest,
  ExtensionRegistry,
  ExtensionManager,
} from './extension.js';

// Preset System
export {
  // Constants
  PRESET_SCHEMA_VERSION,
  PRESET_ID_PATTERN,
  VALID_TEMPLATE_TYPES,
  type TemplateType,

  // Errors
  PresetError,
  PresetValidationError,
  PresetCompatibilityError,

  // Types
  type PresetTemplate,
  type PresetManifestData,
  type PresetMetadata,
  type PresetInfo,
  type ResolvedTemplate,

  // Classes
  PresetManifest,
  PresetRegistry,
  PresetManager,
  PresetResolver,
} from './preset.js';

// Integration System
export {
  // Types
  type IntegrationManifest,
  type IntegrationInfo,

  // Functions
  loadManifest,
  listIntegrations,
  addIntegration,
  removeIntegration,
  getIntegrationInfo,
} from './integration.js';

// Catalog System
export {
  // Types
  type CatalogEntry,
  type Catalog,
  type SearchResult,

  // Constants
  DEFAULT_EXTENSION_CATALOG,
  DEFAULT_PRESET_CATALOG,
  CATALOG_CACHE_DIR,
  CACHE_EXPIRY_MS,

  // Functions
  fetchCatalog,
  searchCatalog,
  findEntryById,
  downloadAndExtract,
  cleanupDownloadTemp,
} from './catalog.js';
