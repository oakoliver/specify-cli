/**
 * @oakoliver/specify-cli - Extension manifest
 *
 * Port of the constants, helpers and ``ExtensionManifest`` class from
 * ``specify_cli/extensions/__init__.py``.
 *
 * @module extensions/manifest
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

import { parseYaml } from '../yaml.js';
import { relativeExtensionPathViolation } from '../utils.js';
import { locateCorePack, repoRoot } from '../assets.js';
import { Version } from '../bundles/versioning.js';
import { pyRepr, pyStrRepr, pyTypeName } from '../bundles/pycompat.js';
import { ValidationError } from './errors.js';
import { validateEvents } from './events-validation.js';
import { UnicodeDecodeError, decodeUtf8Strict, isPyInt, pyCapitalize, pyInt } from './compat.js';

// ============================================================================
// Types
// ============================================================================

/** Loosely-typed mapping parsed from YAML/JSON (mirrors a Python ``dict``). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Dict = Record<string, any>;

// ============================================================================
// Constants
// ============================================================================

const FALLBACK_CORE_COMMAND_NAMES: ReadonlySet<string> = new Set([
  'analyze',
  'checklist',
  'clarify',
  'constitution',
  'converge',
  'implement',
  'plan',
  'specify',
  'tasks',
  'taskstoissues',
]);

/** ``speckit.{extension}.{command}`` */
export const EXTENSION_COMMAND_NAME_PATTERN = /^speckit\.([a-z0-9-]+)\.([a-z0-9-]+)$/;

/** Naming pattern for provides.templates / provides.scripts entries. */
export const VALID_EXTENSION_ARTIFACT_NAME_PATTERN = /^[a-z0-9-]+$/;

export const VALID_SCRIPT_RUNTIMES: ReadonlySet<string> = new Set(['bash', 'powershell', 'python']);

export const VALID_EFFECTS: ReadonlySet<string> = new Set(['read-only', 'read-write']);

export const DEFAULT_HOOK_PRIORITY = 10;

export const REINSTALL_COMMAND =
  'uv tool install specify-cli --force --from git+https://github.com/github/spec-kit.git';

function isDirSafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFileSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Discover bundled core command names from the packaged templates. */
export function loadCoreCommandNames(): ReadonlySet<string> {
  let corePack: string | null = null;
  try {
    corePack = locateCorePack();
  } catch {
    corePack = null;
  }
  let root: string | null = null;
  try {
    root = repoRoot();
  } catch {
    root = null;
  }
  const candidates = [
    corePack !== null ? join(corePack, 'commands') : null,
    root !== null ? join(root, 'templates', 'commands') : null,
  ];
  for (const commandsDir of candidates) {
    if (commandsDir === null || !isDirSafe(commandsDir)) continue;
    const names = new Set<string>();
    for (const entry of readdirSync(commandsDir)) {
      const full = join(commandsDir, entry);
      if (isFileSafe(full) && extname(entry) === '.md') {
        names.add(basename(entry, '.md'));
      }
    }
    if (names.size) return names;
  }
  return FALLBACK_CORE_COMMAND_NAMES;
}

/** Bundled core command names (``analyze``, ``plan``, ...). */
export const CORE_COMMAND_NAMES: ReadonlySet<string> = loadCoreCommandNames();

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalize a stored priority value for sorting and display.
 *
 * Corrupted registry data may contain missing, non-numeric, non-positive, or
 * boolean values. In those cases, fall back to the default priority.
 */
export function normalizePriority(value: unknown, defaultValue: number = DEFAULT_HOOK_PRIORITY): number {
  if (typeof value === 'boolean') return defaultValue;
  const priority = pyInt(value);
  if (priority === null) return defaultValue;
  return priority >= 1 ? priority : defaultValue;
}

/** Return a hook event's config as a list of entries. */
export function coerceHookEntries(hookConfig: unknown): unknown[] {
  return Array.isArray(hookConfig) ? hookConfig : [hookConfig];
}

export function isMapping(value: unknown): value is Dict {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  );
}

function hasKey(obj: Dict, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isMapping(value)) return Object.keys(value).length > 0;
  return true;
}

function isValidVersion(value: string): boolean {
  try {
    new Version(value);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// CatalogEntry
// ============================================================================

/** Represents a single catalog entry in the catalog stack. */
export interface CatalogEntry {
  url: string;
  name: string;
  priority: number;
  install_allowed: boolean;
  description: string;
}

// ============================================================================
// ExtensionManifest
// ============================================================================

/** Represents and validates an extension manifest (extension.yml). */
export class ExtensionManifest {
  static readonly SCHEMA_VERSION = '1.0';
  static readonly REQUIRED_FIELDS = ['schema_version', 'extension', 'requires', 'provides'];

  readonly path: string;
  readonly warnings: string[] = [];
  readonly data: Dict;

  /**
   * Load and validate extension manifest.
   * @throws ValidationError If manifest is invalid
   */
  constructor(manifestPath: string) {
    this.path = manifestPath;
    this.data = ExtensionManifest.loadYaml(manifestPath);
    this.validate();
  }

  /** Load YAML file safely. */
  private static loadYaml(path: string): Dict {
    let raw: Buffer;
    try {
      raw = readFileSync(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new ValidationError(`Manifest not found: ${path}`);
      throw new ValidationError(`Could not read manifest ${path}: ${(err as Error).message}`);
    }
    let data: unknown;
    try {
      const text = decodeUtf8Strict(raw);
      data = parseYaml(text, { name: path });
    } catch (err) {
      if (err instanceof UnicodeDecodeError) {
        throw new ValidationError(
          `Manifest is not valid UTF-8: ${path} (${err.reason} at byte ${err.start})`,
        );
      }
      throw new ValidationError(`Invalid YAML in ${path}: ${(err as Error).message}`);
    }
    if (!isMapping(data)) {
      throw new ValidationError(`Manifest must be a YAML mapping, got ${pyTypeName(data)}: ${path}`);
    }
    return data;
  }

  /** Validate manifest structure and required fields. */
  private validate(): void {
    const data = this.data;
    for (const field of ExtensionManifest.REQUIRED_FIELDS) {
      if (!hasKey(data, field)) throw new ValidationError(`Missing required field: ${field}`);
    }

    if (data.schema_version !== ExtensionManifest.SCHEMA_VERSION) {
      throw new ValidationError(
        `Unsupported schema version: ${pyStrOf(data.schema_version)} ` +
          `(expected ${ExtensionManifest.SCHEMA_VERSION})`,
      );
    }

    const ext = data.extension;
    if (!isMapping(ext)) {
      throw new ValidationError(`Invalid extension: expected a mapping, got ${pyTypeName(ext)}`);
    }
    for (const field of ['id', 'name', 'version', 'description']) {
      if (!hasKey(ext, field)) throw new ValidationError(`Missing extension.${field}`);
      if (typeof ext[field] !== 'string') {
        throw new ValidationError(
          `Invalid extension.${field}: expected a string, got ${pyTypeName(ext[field])}`,
        );
      }
    }

    if (!/^[a-z0-9-]+$/.test(ext.id)) {
      throw new ValidationError(
        `Invalid extension ID '${ext.id}': must be lowercase alphanumeric with hyphens only`,
      );
    }

    if (!isValidVersion(ext.version)) {
      throw new ValidationError(`Invalid version: ${ext.version}`);
    }

    if (hasKey(ext, 'category')) {
      if (typeof ext.category !== 'string' || !ext.category.trim()) {
        throw new ValidationError('Invalid extension.category: must be a non-empty string');
      }
    }

    if (hasKey(ext, 'effect')) {
      if (typeof ext.effect !== 'string' || !VALID_EFFECTS.has(ext.effect)) {
        throw new ValidationError(
          `Invalid extension.effect '${pyStrOf(ext.effect)}': ` +
            `must be one of ${pyRepr([...VALID_EFFECTS].sort())}`,
        );
      }
    }

    const requires = data.requires;
    if (!isMapping(requires)) {
      throw new ValidationError(`Invalid requires: expected a mapping, got ${pyTypeName(requires)}`);
    }
    if (!hasKey(requires, 'speckit_version')) {
      throw new ValidationError('Missing requires.speckit_version');
    }
    if (typeof requires.speckit_version !== 'string' || !requires.speckit_version.trim()) {
      throw new ValidationError(
        'Invalid requires.speckit_version: expected a non-empty string, ' +
          `got ${pyTypeName(requires.speckit_version)}`,
      );
    }

    const provides = data.provides;
    if (!isMapping(provides)) {
      throw new ValidationError(`Invalid provides: expected a mapping, got ${pyTypeName(provides)}`);
    }
    const commands = hasKey(provides, 'commands') ? provides.commands : [];
    const templates = hasKey(provides, 'templates') ? provides.templates : [];
    const scripts = hasKey(provides, 'scripts') ? provides.scripts : [];
    const hooks = data.hooks;
    const events = data.events;

    if (hasKey(provides, 'commands') && !Array.isArray(commands)) {
      throw new ValidationError('Invalid provides.commands: expected a list');
    }
    if (hasKey(provides, 'templates') && !Array.isArray(templates)) {
      throw new ValidationError('Invalid provides.templates: expected a list');
    }
    if (hasKey(provides, 'scripts') && !Array.isArray(scripts)) {
      throw new ValidationError('Invalid provides.scripts: expected a list');
    }
    if (hasKey(data, 'hooks') && !isMapping(hooks)) {
      throw new ValidationError('Invalid hooks: expected a mapping');
    }
    if (hasKey(data, 'events')) {
      validateEvents(data);
    }

    const hasCommands = truthy(commands);
    const hasHooks = truthy(hooks);
    const hasEvents = truthy(events);
    const hasTemplates = truthy(templates);
    const hasScripts = truthy(scripts);

    if (!hasCommands && !hasHooks && !hasEvents && !hasTemplates && !hasScripts) {
      throw new ValidationError(
        'Extension must provide at least one command, hook, or event ' +
          '(or a declared template/script)',
      );
    }

    ExtensionManifest.validateProvidedArtifacts(templates as unknown[], 'templates', 'template');
    ExtensionManifest.validateProvidedArtifacts(scripts as unknown[], 'scripts', 'script');

    if (hasHooks && isMapping(hooks)) {
      for (const [hookName, hookConfig] of Object.entries(hooks)) {
        if (Array.isArray(hookConfig) && hookConfig.length === 0) {
          throw new ValidationError(`Invalid hook '${hookName}': list must contain at least one entry`);
        }
        for (const entry of coerceHookEntries(hookConfig)) {
          if (!isMapping(entry)) {
            throw new ValidationError(
              `Invalid hook '${hookName}': expected a mapping or list of mappings`,
            );
          }
          if (!truthy(entry.command)) {
            throw new ValidationError(`Hook '${hookName}' missing required 'command' field`);
          }
          if (hasKey(entry, 'priority')) {
            const priority = entry.priority;
            if (!isPyInt(priority)) {
              throw new ValidationError(
                `Hook '${hookName}' has invalid 'priority': must be an integer`,
              );
            }
            if (priority < 1) {
              throw new ValidationError(`Hook '${hookName}' has invalid 'priority': must be >= 1`);
            }
          }
        }
      }
    }

    const renameMap = new Map<string, string>();
    for (const cmd of commands as unknown[]) {
      if (!isMapping(cmd)) {
        throw new ValidationError("Each command entry in 'provides.commands' must be a mapping");
      }
      if (!hasKey(cmd, 'name') || !hasKey(cmd, 'file')) {
        throw new ValidationError("Command missing 'name' or 'file'");
      }
      if (typeof cmd.name !== 'string') {
        throw new ValidationError(`Invalid command name: expected a string, got ${pyTypeName(cmd.name)}`);
      }

      const cmdFile = cmd.file;
      const reason = relativeExtensionPathViolation(cmdFile);
      if (reason) {
        const label =
          typeof cmdFile === 'string' ? pyStrRepr(cmdFile) : `for command '${pyStrOf(cmd.name)}'`;
        throw new ValidationError(`Invalid command 'file' ${label}: ${reason}`);
      }

      if (!EXTENSION_COMMAND_NAME_PATTERN.test(cmd.name)) {
        const corrected = ExtensionManifest.tryCorrectCommandName(cmd.name, ext.id);
        if (corrected) {
          this.warnings.push(
            `Command name '${cmd.name}' does not follow the required pattern ` +
              `'speckit.{extension}.{command}'. Registering as '${corrected}'. ` +
              'The extension author should update the manifest to use this name.',
          );
          renameMap.set(cmd.name, corrected);
          cmd.name = corrected;
        } else {
          throw new ValidationError(
            `Invalid command name '${cmd.name}': must follow pattern 'speckit.{extension}.{command}'`,
          );
        }
      }

      let aliases = cmd.aliases;
      if (aliases === null || aliases === undefined) {
        cmd.aliases = [];
        aliases = [];
      }
      if (!Array.isArray(aliases)) {
        throw new ValidationError(`Aliases for command '${cmd.name}' must be a list`);
      }
      for (const alias of aliases) {
        if (typeof alias !== 'string') {
          throw new ValidationError(`Aliases for command '${cmd.name}' must be strings`);
        }
        const aliasReason = relativeExtensionPathViolation(alias);
        if (aliasReason) {
          throw new ValidationError(
            `Invalid alias ${pyStrRepr(alias)} for command '${cmd.name}': ${aliasReason}`,
          );
        }
      }
    }

    const hooksData = isMapping(data.hooks) ? data.hooks : {};
    for (const [hookName, hookData] of Object.entries(hooksData)) {
      for (const entry of coerceHookEntries(hookData)) {
        if (!isMapping(entry)) {
          throw new ValidationError(
            `Hook '${hookName}' must be a mapping or list of mappings, got ${pyTypeName(entry)}`,
          );
        }
        const commandRef = entry.command;
        if (typeof commandRef !== 'string') continue;
        const finalRef = canonicalRef(commandRef, renameMap, ext.id);
        if (finalRef !== commandRef) {
          entry.command = finalRef;
          this.warnings.push(
            `Hook '${hookName}' referenced command '${commandRef}'; ` +
              `updated to canonical form '${finalRef}'. ` +
              'The extension author should update the manifest.',
          );
        }
      }
    }

    const eventsData = data.events;
    if (isMapping(eventsData)) {
      for (const [eventName, eventConfig] of Object.entries(eventsData)) {
        if (!isMapping(eventConfig)) continue;
        const commandRef = eventConfig.command;
        if (typeof commandRef !== 'string') continue;
        const finalRef = canonicalRef(commandRef, renameMap, ext.id);
        if (finalRef !== commandRef) {
          eventConfig.command = finalRef;
          this.warnings.push(
            `Event '${eventName}' referenced command '${commandRef}'; ` +
              `updated to canonical form '${finalRef}'. ` +
              'The extension author should update the manifest.',
          );
        }
      }
    }
  }

  /** Validate provides.templates / provides.scripts entries. */
  static validateProvidedArtifacts(entries: unknown[], section: string, singular: string): void {
    const seenNames = new Set<string>();
    for (const entry of entries) {
      if (!isMapping(entry)) {
        throw new ValidationError(`Each entry in 'provides.${section}' must be a mapping`);
      }
      if (!hasKey(entry, 'name') || !hasKey(entry, 'file')) {
        throw new ValidationError(`${pyCapitalize(singular)} missing 'name' or 'file'`);
      }
      const name = entry.name;
      if (typeof name !== 'string') {
        throw new ValidationError(`Invalid ${singular} name: expected a string, got ${pyTypeName(name)}`);
      }
      if (!VALID_EXTENSION_ARTIFACT_NAME_PATTERN.test(name)) {
        throw new ValidationError(
          `Invalid ${singular} name '${name}': must be lowercase alphanumeric with hyphens only`,
        );
      }
      if (seenNames.has(name)) {
        throw new ValidationError(`Duplicate ${singular} name '${name}' in 'provides.${section}'`);
      }
      seenNames.add(name);

      const fileValue = entry.file;
      const reason = relativeExtensionPathViolation(fileValue);
      if (reason) {
        const label = typeof fileValue === 'string' ? pyStrRepr(fileValue) : `for ${singular} '${name}'`;
        throw new ValidationError(`Invalid ${singular} 'file' ${label}: ${reason}`);
      }

      if (hasKey(entry, 'description') && typeof entry.description !== 'string') {
        throw new ValidationError(`Invalid ${singular} description for '${name}': expected a string`);
      }

      if (hasKey(entry, 'strategy')) {
        throw new ValidationError(
          `Invalid ${singular} entry '${name}': 'strategy' is not authorable for ` +
            "extension-provided artifacts, which always use 'replace' semantics",
        );
      }

      if (section === 'scripts' && hasKey(entry, 'runtimes')) {
        const runtimes = entry.runtimes;
        if (!Array.isArray(runtimes) || !runtimes.every((r) => typeof r === 'string')) {
          throw new ValidationError(`Invalid runtimes for script '${name}': expected a list of strings`);
        }
        const invalid = [...new Set(runtimes as string[])].filter((r) => !VALID_SCRIPT_RUNTIMES.has(r)).sort();
        if (invalid.length) {
          throw new ValidationError(
            `Invalid runtimes ${pyRepr(invalid)} for script '${name}': ` +
              `must be one of ${pyRepr([...VALID_SCRIPT_RUNTIMES].sort())}`,
          );
        }
      }
    }
  }

  /**
   * Try to auto-correct a non-conforming command name to the required pattern.
   * Returns the corrected name, or ``null`` if no safe correction is possible.
   */
  static tryCorrectCommandName(name: string, extId: string): string | null {
    const parts = name.split('.');
    if (parts.length === 2) {
      if (parts[0] === 'speckit' || parts[0] === extId) {
        const candidate = `speckit.${extId}.${parts[1]}`;
        if (EXTENSION_COMMAND_NAME_PATTERN.test(candidate)) return candidate;
      }
    }
    return null;
  }

  /** Extension ID. */
  get id(): string {
    return this.data.extension.id;
  }

  /** Extension name. */
  get name(): string {
    return this.data.extension.name;
  }

  /** Extension version. */
  get version(): string {
    return this.data.extension.version;
  }

  /** Extension description. */
  get description(): string {
    return this.data.extension.description;
  }

  /** Extension category (free-form). */
  get category(): string | null {
    return this.data.extension.category ?? null;
  }

  /** Extension effect (read-only, read-write). */
  get effect(): string | null {
    return this.data.extension.effect ?? null;
  }

  /** Required spec-kit version range. */
  get requiresSpeckitVersion(): string {
    return this.data.requires.speckit_version;
  }

  /** List of provided commands. */
  get commands(): Dict[] {
    const provides = isMapping(this.data.provides) ? this.data.provides : {};
    return hasKey(provides, 'commands') ? provides.commands : [];
  }

  /** List of provided config templates, normalized to dictionaries. */
  get config(): Dict[] {
    const provides = isMapping(this.data.provides) ? this.data.provides : {};
    const raw = hasKey(provides, 'config') ? provides.config : [];
    if (!Array.isArray(raw) || !raw.every((entry) => isMapping(entry))) return [];
    return raw;
  }

  /** Declared templates (provides.templates). */
  get templates(): Dict[] {
    const provides = isMapping(this.data.provides) ? this.data.provides : {};
    return hasKey(provides, 'templates') ? provides.templates : [];
  }

  /** Declared scripts (provides.scripts). */
  get scripts(): Dict[] {
    const provides = isMapping(this.data.provides) ? this.data.provides : {};
    return hasKey(provides, 'scripts') ? provides.scripts : [];
  }

  /** Hook definitions. */
  get hooks(): Dict {
    return hasKey(this.data, 'hooks') ? this.data.hooks : {};
  }

  /** Calculate SHA256 hash of manifest file. */
  getHash(): string {
    const h = createHash('sha256');
    h.update(readFileSync(this.path));
    return `sha256:${h.digest('hex')}`;
  }
}

function canonicalRef(commandRef: string, renameMap: Map<string, string>, extId: string): string {
  const afterRename = renameMap.get(commandRef) ?? commandRef;
  const parts = afterRename.split('.');
  if (parts.length === 2 && parts[0] === extId) return `speckit.${extId}.${parts[1]}`;
  return afterRename;
}

/** Python ``str()`` for the manifest's scalar values used in messages. */
function pyStrOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return pyRepr(value);
}
