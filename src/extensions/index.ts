/**
 * @oakoliver/specify-cli - Extension Manager for Spec Kit
 *
 * Port of ``specify_cli/extensions/__init__.py``. Handles installation,
 * removal, and management of Spec Kit extensions. Extensions are modular
 * packages that add commands and functionality to spec-kit without bloating
 * the core framework.
 *
 * CLI handlers live in ``./commands.ts`` (``runExtensionCommand``).
 *
 * @module extensions
 */

export { ExtensionError, ValidationError, CompatibilityError, KeyError } from './errors.js';
export {
  CORE_COMMAND_NAMES,
  DEFAULT_HOOK_PRIORITY,
  EXTENSION_COMMAND_NAME_PATTERN,
  REINSTALL_COMMAND,
  VALID_EFFECTS,
  VALID_EXTENSION_ARTIFACT_NAME_PATTERN,
  VALID_SCRIPT_RUNTIMES,
  ExtensionManifest,
  coerceHookEntries,
  loadCoreCommandNames,
  normalizePriority,
  type CatalogEntry,
  type Dict,
} from './manifest.js';
export { ExtensionRegistry } from './registry.js';
export {
  ExtensionManager,
  type InstallFromArchiveOptions,
  type InstallFromDirectoryOptions,
  type InstalledExtensionRecord,
} from './manager.js';
export { CommandRegistrar } from './command-registrar.js';
export {
  ExtensionCatalog,
  type CatalogSearchOptions,
  type OpenUrlOptions,
  type RedirectValidator,
} from './extension-catalog.js';
export { ConfigManager } from './config-manager.js';
export { HookExecutor, type HookCheckResult, type HookExecutionInfo } from './hooks.js';
export { CANONICAL_EVENTS, validateEvents, hasEvents } from './events-validation.js';
export { fsyncFd, fsyncDirectory } from './fs-utils.js';
export { GitIgnoreSpec } from './gitignore-spec.js';
export { DEFAULT_SKILLS_DIR, printCliWarning, requireSpecifyProject } from './root-helpers.js';
export {
  commandSafeId,
  installExtensionFromUrl,
  resolveCatalogExtension,
  resolveInstalledExtension,
  refreshEventsAndWarn,
  validateSafeCacheDir,
} from './command-shared.js';
