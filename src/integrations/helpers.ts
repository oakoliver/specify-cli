/**
 * @oakoliver/specify-cli - Integration Helpers
 *
 * Port of `integrations/_helpers.py`: internal utilities shared across the
 * `specify integration` command modules (integration.json / init-options
 * persistence, script-type and option resolution, default-integration
 * switching, best-effort extension/preset (un)registration).
 *
 * @module integrations/helpers
 */

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { SCRIPT_TYPE_CHOICES } from '../agent-config.js';
import { getSpeckitVersion as assetsGetSpeckitVersion } from '../assets.js';
import { CliExit, console, escapeMarkup } from '../console.js';
import { ExtensionManager } from '../extensions/index.js';
import { loadInitOptions, saveInitOptions } from '../init-options.js';
import {
  invokePrefixForIntegration,
  invokeSeparatorForIntegration,
  resolveIntegrationOptions as resolveIntegrationOptionsImpl,
  withIntegrationSetting,
  type ParsedOptions,
} from '../integration-runtime.js';
import {
  INTEGRATION_JSON,
  INTEGRATION_STATE_SCHEMA,
  integrationSetting,
  tryReadIntegrationJson,
  writeIntegrationJson as writeIntegrationJsonFile,
  type IntegrationSettings,
  type IntegrationState,
} from '../integration-state.js';
import { PresetManager } from '../presets/index.js';
import { installSharedInfra } from '../shared-infra.js';
import { isOSError, isValueError, pyRepr, shlexSplit, type IntegrationBase, type IntegrationOption } from './base.js';
import { isFile, isSymlink, type IntegrationManifest } from './manifest.js';

// ============================================================================
// Version
// ============================================================================

/** Overridable version provider (tests may replace it, like upstream monkeypatching). */
export const versionProvider: { getSpeckitVersion: () => string } = {
  getSpeckitVersion: () => assetsGetSpeckitVersion(),
};

/** Current Spec Kit version. */
export function getSpeckitVersion(): string {
  return versionProvider.getSpeckitVersion();
}

// ============================================================================
// CLI formatting helpers
// ============================================================================

/** Compact one-line exception detail for CLI output. */
export function cliErrorDetail(exc: unknown): string {
  const message = exc instanceof Error ? exc.message : String(exc);
  const detail = message.replace(/\n/g, ' ').trim();
  if (detail) return detail;
  return exc instanceof Error ? exc.name || exc.constructor.name : 'Error';
}

/** Stable operation label for user-visible diagnostics. */
export function cliPhaseLabel(phase: string, targetKind: string, target: string | null = null): string {
  let label = `${phase} ${targetKind}`.trim();
  if (target) label = `${label} '${target}'`;
  return label;
}

/** Print a warning naming the failed CLI phase and target (``_print_cli_warning``). */
export function printCliWarning(
  phase: string,
  targetKind: string,
  target: string | null,
  exc: unknown,
  opts: { continuing?: string | null } = {},
): void {
  const label = cliPhaseLabel(phase, targetKind, target);
  console.print(`[yellow]Warning:[/yellow] Failed to ${label}: ${cliErrorDetail(exc)}`);
  if (opts.continuing) console.print(`[dim]${opts.continuing}[/dim]`);
}

// ============================================================================
// JSON read / write helpers
// ============================================================================

/**
 * Load ``.specify/integration.json`` (normalized). Prints the upstream error
 * UX and throws ``CliExit(1)`` on unreadable / invalid / too-new state.
 */
export function readIntegrationJson(projectRoot: string): IntegrationState {
  const path = join(projectRoot, INTEGRATION_JSON);
  const [state, error] = tryReadIntegrationJson(projectRoot) as [IntegrationState | null, { kind: string; detail: string; schema: number | null } | null];
  if (error === null || error === undefined) return state ?? {};
  if (error.kind === 'decode') {
    console.print(`[red]Error:[/red] ${path} contains invalid JSON or is not valid UTF-8.`);
    console.print(`Please fix or delete ${INTEGRATION_JSON} and retry.`);
    console.print(`[dim]Details:[/dim] ${error.detail}`);
  } else if (error.kind === 'os') {
    console.print(`[red]Error:[/red] Could not read ${path}.`);
    console.print(`Please fix file permissions or delete ${INTEGRATION_JSON} and retry.`);
    console.print(`[dim]Details:[/dim] ${error.detail}`);
  } else if (error.kind === 'not_object') {
    console.print(`[red]Error:[/red] ${path} must contain a JSON object, got ${error.detail}.`);
    console.print(`Please fix or delete ${INTEGRATION_JSON} and retry.`);
  } else if (error.kind === 'schema_too_new') {
    console.print(
      `[red]Error:[/red] ${path} uses integration state schema ${error.schema}, ` +
        `but this CLI only supports schema ${INTEGRATION_STATE_SCHEMA}.`,
    );
    console.print('Please upgrade Spec Kit before modifying integrations.');
  }
  throw new CliExit(1);
}

/** Write ``.specify/integration.json`` with legacy-compatible state. */
export function writeIntegrationJson(
  projectRoot: string,
  integrationKey: string | null,
  installedIntegrations: string[] | null = null,
  integrationSettings: IntegrationSettings | null = null,
): void {
  writeIntegrationJsonFile(projectRoot, {
    version: getSpeckitVersion(),
    integrationKey,
    installedIntegrations,
    settings: integrationSettings,
  });
}

// ============================================================================
// init-options.json helpers
// ============================================================================

/** Refresh only the Spec Kit version recorded in init-options.json. */
export function refreshInitOptionsSpeckitVersion(projectRoot: string): void {
  const opts = loadInitOptions(projectRoot) as Record<string, unknown>;
  if (!opts || typeof opts !== 'object' || Object.keys(opts).length === 0) return;
  opts.speckit_version = getSpeckitVersion();
  saveInitOptions(projectRoot, opts);
}

/** Clear active integration keys from init-options.json when they match. */
export function clearInitOptionsForIntegration(projectRoot: string, integrationKey: string): void {
  const opts = loadInitOptions(projectRoot) as Record<string, unknown>;
  if (opts.integration === integrationKey || opts.ai === integrationKey) {
    delete opts.integration;
    delete opts.ai;
    delete opts.ai_skills;
    saveInitOptions(projectRoot, opts);
  }
}

/** Remove ``.specify/integration.json`` if it exists. */
export function removeIntegrationJson(projectRoot: string): void {
  const path = join(projectRoot, INTEGRATION_JSON);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code !== 'ENOENT') throw exc;
    }
  }
}

// ============================================================================
// Error sentinels
// ============================================================================

/**
 * Python ``_MANIFEST_READ_ERRORS`` (ValueError, FileNotFoundError, OSError,
 * UnicodeDecodeError): true for errors raised while loading a manifest.
 */
export function isManifestReadError(exc: unknown): boolean {
  return isValueError(exc) || isOSError(exc) || exc instanceof TypeError || exc instanceof SyntaxError;
}

/** Names of the Python exception types in ``_MANIFEST_READ_ERRORS``. */
export const MANIFEST_READ_ERRORS = ['ValueError', 'FileNotFoundError', 'OSError', 'UnicodeDecodeError'] as const;

/** Raised when default integration metadata should not be persisted. */
export class SharedTemplateRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharedTemplateRefreshError';
  }
}

// ============================================================================
// Script type resolution
// ============================================================================

/** Normalize and validate a script type from CLI/config sources. */
export function normalizeScriptType(scriptType: string, source: string): string {
  const normalized = scriptType.trim().toLowerCase();
  if (normalized in SCRIPT_TYPE_CHOICES) return normalized;
  console.print(
    `[red]Error:[/red] Invalid script type ${pyRepr(scriptType)} from ${source}. ` +
      `Expected one of: ${Object.keys(SCRIPT_TYPE_CHOICES).sort().join(', ')}.`,
  );
  throw new CliExit(1);
}

/** Resolve the script type from the CLI flag or init-options.json. */
export function resolveScriptType(projectRoot: string, scriptType: string | null): string {
  if (scriptType) return normalizeScriptType(scriptType, '--script');
  const opts = loadInitOptions(projectRoot) as Record<string, unknown>;
  const saved = opts.script;
  if (typeof saved === 'string' && saved.trim()) return normalizeScriptType(saved, '.specify/init-options.json');
  return process.platform === 'win32' ? 'ps' : 'sh';
}

/** Resolve script type for an integration, preferring stored settings. */
export function resolveIntegrationScriptType(
  projectRoot: string,
  state: IntegrationState,
  key: string,
  scriptType: string | null = null,
): string {
  if (scriptType) return normalizeScriptType(scriptType, '--script');
  const stored = (integrationSetting(state, key) as Record<string, unknown>).script;
  if (typeof stored === 'string' && stored.trim()) {
    return normalizeScriptType(stored, `${INTEGRATION_JSON} integration_settings.${key}.script`);
  }
  return resolveScriptType(projectRoot, null);
}

// ============================================================================
// Integration options
// ============================================================================

/**
 * Parse an ``--integration-options`` string into a dict matching the
 * integration's declared options (keys with ``-`` → ``_``). Returns ``null``
 * when no options are provided; prints an error and throws ``CliExit(1)`` on
 * bad input.
 */
export function parseIntegrationOptions(integration: Pick<IntegrationBase, 'options'>, rawOptions: string): ParsedOptions | null {
  const parsed: ParsedOptions = {};
  let tokens: string[];
  try {
    tokens = shlexSplit(rawOptions);
  } catch (exc) {
    console.print(`[red]Error:[/red] Could not parse integration options: ${(exc as Error).message}.`);
    throw new CliExit(1);
  }
  const declaredOptions: IntegrationOption[] = [...integration.options()];
  const declared = new Map(declaredOptions.map((opt) => [opt.name.replace(/^-+/, ''), opt]));
  const allowed = declaredOptions.map((opt) => opt.name).sort().join(', ');
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token.startsWith('-')) {
      console.print(`[red]Error:[/red] Unexpected integration option value '${escapeMarkup(token)}'.`);
      if (allowed) console.print(`Allowed options: ${allowed}`);
      throw new CliExit(1);
    }
    let name = token.replace(/^-+/, '');
    let value: string | null = null;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    const opt = declared.get(name);
    if (!opt) {
      console.print(`[red]Error:[/red] Unknown integration option '${escapeMarkup(token)}'.`);
      if (allowed) console.print(`Allowed options: ${allowed}`);
      throw new CliExit(1);
    }
    const key = name.replace(/-/g, '_');
    if (opt.isFlag) {
      if (value !== null) {
        console.print(`[red]Error:[/red] Option '${opt.name}' is a flag and does not accept a value.`);
        throw new CliExit(1);
      }
      parsed[key] = true;
      i += 1;
    } else if (value !== null) {
      parsed[key] = value;
      i += 1;
    } else if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
      parsed[key] = tokens[i + 1];
      i += 2;
    } else {
      console.print(`[red]Error:[/red] Option '${opt.name}' requires a value.`);
      throw new CliExit(1);
    }
  }
  return Object.keys(parsed).length > 0 ? parsed : null;
}

/** Resolve raw and parsed options for an integration operation. */
export function resolveIntegrationOptions(
  integration: Pick<IntegrationBase, 'options'>,
  state: IntegrationState,
  key: string,
  rawOptions: string | null,
): [string | null, ParsedOptions | null] {
  return resolveIntegrationOptionsImpl(integration, state, key, rawOptions, {
    parseOptions: parseIntegrationOptions,
  });
}

/**
 * Update init-options.json to reflect *integration* as the active one
 * (``ai_skills`` set via the integration's ``isSkillsMode`` hook).
 */
export function updateInitOptionsForIntegration(
  projectRoot: string,
  integration: IntegrationBase,
  scriptType: string | null = null,
  parsedOptions: ParsedOptions | null = null,
): void {
  const opts = loadInitOptions(projectRoot) as Record<string, unknown>;
  opts.integration = integration.key;
  opts.ai = integration.key;
  opts.speckit_version = getSpeckitVersion();
  if (scriptType) opts.script = scriptType;
  if (integration.isSkillsMode(parsedOptions, projectRoot)) {
    opts.ai_skills = true;
  } else {
    delete opts.ai_skills;
  }
  saveInitOptions(projectRoot, opts);
}

// ============================================================================
// Default integration persistence
// ============================================================================

export interface SetDefaultIntegrationOptions {
  scriptType?: string | null;
  rawOptions?: string | null;
  parsedOptions?: ParsedOptions | null;
  refreshTemplates?: boolean;
  refreshTemplatesForce?: boolean;
  refreshHint?: string | null;
}

/** Persist *key* as default and align active runtime metadata. */
export function setDefaultIntegration(
  projectRoot: string,
  state: IntegrationState,
  key: string,
  integration: IntegrationBase,
  installedKeys: string[],
  opts: SetDefaultIntegrationOptions = {},
): void {
  const parsedOptions = opts.parsedOptions ?? null;
  const resolvedScript = resolveIntegrationScriptType(projectRoot, state, key, opts.scriptType ?? null);
  const settings = withIntegrationSetting(state, key, integration, {
    scriptType: resolvedScript,
    rawOptions: opts.rawOptions ?? null,
    parsedOptions,
    projectRoot,
  });

  if (opts.refreshTemplates ?? true) {
    try {
      installSharedInfra(projectRoot, resolvedScript, {
        invokeSeparator: invokeSeparatorForIntegration(
          integration,
          { integration_settings: settings },
          key,
          parsedOptions,
          projectRoot,
        ),
        invokePrefix: invokePrefixForIntegration(integration, key, parsedOptions, projectRoot),
        force: opts.refreshTemplatesForce ?? false,
        refreshManaged: true,
        refreshHint: opts.refreshHint ?? null,
      });
    } catch (exc) {
      if (isValueError(exc) || isOSError(exc)) {
        throw new SharedTemplateRefreshError(
          `Failed to refresh shared infrastructure for '${key}': ${(exc as Error).message}`,
        );
      }
      throw exc;
    }
  }

  writeIntegrationJson(projectRoot, key, installedKeys, settings);
  updateInitOptionsForIntegration(projectRoot, integration, resolvedScript, parsedOptions);
}

/** Like {@link setDefaultIntegration} but prints the error and throws ``CliExit(1)``. */
export function setDefaultIntegrationOrExit(
  projectRoot: string,
  state: IntegrationState,
  key: string,
  integration: IntegrationBase,
  installedKeys: string[],
  opts: SetDefaultIntegrationOptions = {},
): void {
  try {
    setDefaultIntegration(projectRoot, state, key, integration, installedKeys, opts);
  } catch (exc) {
    if (exc instanceof SharedTemplateRefreshError) {
      console.print(`[red]Error:[/red] ${exc.message}`);
      throw new CliExit(1);
    }
    throw exc;
  }
}

// ============================================================================
// Extension / preset (un)registration helpers (best-effort)
// ============================================================================

function bestEffort(
  run: () => unknown,
  onError: (exc: unknown) => void,
): void | Promise<void> {
  try {
    const result = run();
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<unknown>).then(
        () => undefined,
        (exc: unknown) => onError(exc),
      );
    }
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    onError(exc);
  }
  return undefined;
}

function bestEffortExtensionOp(
  projectRoot: string,
  agentKey: string,
  op: (mgr: ExtensionManager, key: string) => unknown,
  phase: string,
  continuing: string,
): void | Promise<void> {
  return bestEffort(
    () => op(new ExtensionManager(projectRoot), agentKey),
    (exc) => printCliWarning(phase, 'integration', agentKey, exc, { continuing }),
  );
}

/** Register all enabled extensions' commands/skills for *agentKey* (best-effort). */
export function registerExtensionsForAgent(
  projectRoot: string,
  agentKey: string,
  opts: { continuing: string; force?: boolean },
): void | Promise<void> {
  return bestEffortExtensionOp(
    projectRoot,
    agentKey,
    (mgr, key) => mgr.registerEnabledExtensionsForAgent(key, { force: opts.force ?? false }),
    'register extension artifacts for',
    opts.continuing,
  );
}

/** Best-effort removal of *agentKey*'s extension artifacts. */
export function unregisterExtensionsForAgent(
  projectRoot: string,
  agentKey: string,
  opts: { continuing: string },
): void | Promise<void> {
  return bestEffortExtensionOp(
    projectRoot,
    agentKey,
    (mgr, key) => mgr.unregisterAgentArtifacts(key),
    'clean up extension artifacts for',
    opts.continuing,
  );
}

/** Register all enabled presets' command overrides/skills for *agentKey* (best-effort). */
export function registerPresetsForAgent(
  projectRoot: string,
  agentKey: string,
  opts: { continuing: string },
): void | Promise<void> {
  return bestEffort(
    () => new PresetManager(projectRoot).registerEnabledPresetsForAgent(agentKey),
    (exc) =>
      printCliWarning('register preset artifacts for', 'integration', agentKey, exc, { continuing: opts.continuing }),
  );
}

/**
 * Refresh tracked-file hashes after extensions/presets re-registration so a
 * legitimate override is not later reported as tampering (best-effort).
 */
export function resyncManifestAfterRegistration(
  newManifest: IntegrationManifest,
  agentKey: string,
  opts: { continuing: string },
): void {
  try {
    let changed = false;
    for (const rel of Object.keys(newManifest.files)) {
      const absPath = join(newManifest.projectRoot, rel);
      try {
        if (isSymlink(absPath) || !isFile(absPath)) continue;
        newManifest.recordExisting(rel);
        changed = true;
      } catch (fileErr) {
        if (!(isValueError(fileErr) || isOSError(fileErr))) throw fileErr;
        printCliWarning('resync manifest hash for', 'file', rel, fileErr, {
          continuing: 'Continuing with the remaining files.',
        });
      }
    }
    if (changed) newManifest.save();
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    printCliWarning('resync manifest hashes for', 'integration', agentKey, exc, { continuing: opts.continuing });
  }
}

/** Best-effort removal of *agentKey*'s preset command/skill artifacts. */
export function unregisterPresetsForAgent(
  projectRoot: string,
  agentKey: string,
  opts: { continuing: string },
): void | Promise<void> {
  return bestEffort(
    () => new PresetManager(projectRoot).unregisterAgentArtifacts(agentKey),
    (exc) =>
      printCliWarning('clean up preset artifacts for', 'integration', agentKey, exc, { continuing: opts.continuing }),
  );
}

/** Best-effort removal of enabled extension command artifacts for *agentKey*. */
export function unregisterEnabledExtensionCommandsForAgent(
  projectRoot: string,
  agentKey: string,
  opts: { continuing: string },
): void | Promise<void> {
  return bestEffortExtensionOp(
    projectRoot,
    agentKey,
    (mgr, key) => mgr.unregisterAgentArtifacts(key, { enabledOnly: true, commandsOnly: true }),
    'clean up enabled extension command artifacts for',
    opts.continuing,
  );
}
