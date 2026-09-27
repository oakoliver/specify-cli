/**
 * @oakoliver/specify-cli - Integration Runtime
 *
 * Runtime helpers for integration commands (port of `integration_runtime.py`).
 *
 * @module integration-runtime
 */

import { getInvocationPrefix } from './invocation-style.js';
import {
  integrationSetting,
  integrationSettings,
  type IntegrationSettingEntry,
  type IntegrationSettings,
  type IntegrationState,
} from './integration-state.js';

// ============================================================================
// Types
// ============================================================================

export type ParsedOptions = Record<string, unknown>;

/**
 * Structural subset of `IntegrationBase` used by the runtime helpers.
 * Any `IntegrationBase` instance satisfies it.
 */
export interface RuntimeIntegration {
  effectiveInvokeSeparator(parsedOptions?: ParsedOptions | null, projectRoot?: string | null): string;
  isSkillsMode(parsedOptions?: ParsedOptions | null, projectRoot?: string | null): boolean;
}

export type ParseOptions<I = unknown> = (integration: I, rawOptions: string) => ParsedOptions | null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ============================================================================
// Helpers
// ============================================================================

/** Resolve raw and parsed options for an integration operation. */
export function resolveIntegrationOptions<I>(
  integration: I,
  state: IntegrationState,
  key: string,
  rawOptions: string | null | undefined,
  opts: { parseOptions: ParseOptions<I> },
): [string | null, ParsedOptions | null] {
  if (rawOptions !== null && rawOptions !== undefined) {
    return [rawOptions, opts.parseOptions(integration, rawOptions)];
  }

  const setting = integrationSetting(state, key);
  let storedRaw: string | null = setting.raw_options ?? null;
  if (typeof storedRaw !== 'string') storedRaw = null;

  const storedParsed = setting.parsed_options;
  if (isPlainObject(storedParsed)) {
    return [storedRaw, Object.keys(storedParsed).length > 0 ? storedParsed : null];
  }

  if (storedRaw) return [storedRaw, opts.parseOptions(integration, storedRaw)];

  return [null, null];
}

export interface WithIntegrationSettingOptions {
  scriptType?: string | null;
  rawOptions?: string | null;
  parsedOptions?: ParsedOptions | null;
  projectRoot?: string | null;
}

/** Return integration settings with `key` updated. */
export function withIntegrationSetting(
  state: IntegrationState,
  key: string,
  integration: RuntimeIntegration,
  opts: WithIntegrationSettingOptions = {},
): IntegrationSettings {
  const settings = integrationSettings(state);
  const current: IntegrationSettingEntry = { ...(settings[key] ?? {}) };
  const rawOptions = opts.rawOptions ?? null;
  const parsedOptions = opts.parsedOptions ?? null;

  if (opts.scriptType) current.script = opts.scriptType;
  if (rawOptions !== null) {
    current.raw_options = rawOptions;
  } else if ('raw_options' in current && !current.raw_options) {
    delete current.raw_options;
  }

  if (parsedOptions !== null) {
    current.parsed_options = parsedOptions;
  } else if (rawOptions !== null) {
    delete current.parsed_options;
  }

  // Recompute the separator from the options actually STORED on `current`
  // after the update, not the raw `parsedOptions` argument.
  current.invoke_separator = integration.effectiveInvokeSeparator(
    (current.parsed_options as ParsedOptions | undefined) ?? null,
    opts.projectRoot ?? null,
  );
  settings[key] = current;
  return settings;
}

/** Resolve the invocation separator for stored/default integration state. */
export function invokeSeparatorForIntegration(
  integration: RuntimeIntegration,
  state: IntegrationState,
  key: string,
  parsedOptions: ParsedOptions | null = null,
  projectRoot: string | null = null,
): string {
  if (parsedOptions !== null && parsedOptions !== undefined) {
    return integration.effectiveInvokeSeparator(parsedOptions, projectRoot);
  }

  const setting = integrationSetting(state, key);
  const storedSeparator = setting.invoke_separator;
  if (typeof storedSeparator === 'string' && storedSeparator) return storedSeparator;

  const storedParsed = setting.parsed_options;
  if (isPlainObject(storedParsed)) {
    return integration.effectiveInvokeSeparator(storedParsed, projectRoot);
  }

  return integration.effectiveInvokeSeparator(null, projectRoot);
}

/** Resolve the native invocation prefix for an integration's output mode. */
export function invokePrefixForIntegration(
  integration: RuntimeIntegration,
  key: string,
  parsedOptions: ParsedOptions | null = null,
  projectRoot: string | null = null,
): string {
  const skillsMode = integration.isSkillsMode(parsedOptions, projectRoot);
  return getInvocationPrefix(key, skillsMode);
}
