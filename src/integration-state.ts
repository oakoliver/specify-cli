/**
 * @oakoliver/specify-cli - Integration State
 *
 * State helpers for installed AI agent integrations
 * (port of `integration_state.py`). Reads/writes `.specify/integration.json`.
 *
 * @module integration-state
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ============================================================================
// Constants
// ============================================================================

export const INTEGRATION_JSON = '.specify/integration.json';
export const INTEGRATION_STATE_SCHEMA = 1;

/** Per-integration runtime settings stored in `integration_settings`. */
export interface IntegrationSettingEntry {
  script?: string;
  raw_options?: string;
  parsed_options?: Record<string, unknown>;
  invoke_separator?: string;
  [key: string]: unknown;
}

export type IntegrationSettings = Record<string, IntegrationSettingEntry>;

/** Normalized (or raw) integration state object. */
export type IntegrationState = Record<string, unknown>;

// ============================================================================
// Read errors
// ============================================================================

export type IntegrationReadErrorKind = 'decode' | 'os' | 'not_object' | 'schema_too_new';

/**
 * Structured failure from {@link tryReadIntegrationJson}.
 *
 * Callers map `kind` to whatever surface they need (loud CLI error, silent
 * fallback, etc.) without re-implementing the parse/validation logic.
 */
export class IntegrationReadError {
  readonly kind: IntegrationReadErrorKind;
  readonly detail: string;
  readonly schema: number | null;

  constructor(kind: IntegrationReadErrorKind, detail = '', schema: number | null = null) {
    this.kind = kind;
    this.detail = detail;
    this.schema = schema;
    Object.freeze(this);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Python `isinstance(x, int) and not isinstance(x, bool)` for parsed JSON. */
function isJsonInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** Python `type(x).__name__` for JSON values. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  switch (typeof value) {
    case 'string': return 'str';
    case 'boolean': return 'bool';
    case 'number': return Number.isInteger(value) ? 'int' : 'float';
    case 'object': return 'dict';
    default: return typeof value;
  }
}

function decodeUtf8Strict(buf: Buffer): string {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(buf);
}

/**
 * Read raw integration state without normalizing or raising.
 *
 * Returns `[data, null]` when the JSON object is readable and supported,
 * `[null, null]` when the file is absent, and `[null, error]` for parse,
 * schema, encoding, or filesystem failures.
 */
function readIntegrationJsonData(
  projectRoot: string,
): [Record<string, unknown> | null, IntegrationReadError | null] {
  const path = join(projectRoot, INTEGRATION_JSON);
  let raw: string;
  try {
    const buf = readFileSync(path);
    try {
      raw = decodeUtf8Strict(buf);
    } catch (exc) {
      return [null, new IntegrationReadError('decode', `'utf-8' codec can't decode bytes: ${(exc as Error).message}`)];
    }
  } catch (exc) {
    const err = exc as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return [null, null];
    if (err.code === 'EISDIR') {
      return [null, new IntegrationReadError('os', `${path} exists but is not a regular file: ${err.message}`)];
    }
    return [null, new IntegrationReadError('os', err.message)];
  }
  // Python's read_text strips a UTF-8 BOM only with utf-8-sig; json.loads
  // rejects a BOM, so keep it and let JSON.parse fail the same way.
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (exc) {
    return [null, new IntegrationReadError('decode', (exc as Error).message)];
  }
  if (!isPlainObject(data)) {
    return [null, new IntegrationReadError('not_object', pyTypeName(data))];
  }
  const schema = data['integration_state_schema'];
  if (isJsonInt(schema) && schema > INTEGRATION_STATE_SCHEMA) {
    return [null, new IntegrationReadError('schema_too_new', '', schema)];
  }
  return [data, null];
}

/**
 * Parse `.specify/integration.json` without raising.
 *
 * Returns `[normalizedState, null]` on success, `[null, null]` when the file
 * does not exist, or `[null, error]` for any parse / validation failure.
 */
export function tryReadIntegrationJson(
  projectRoot: string,
): [IntegrationState | null, IntegrationReadError | null] {
  const [data, error] = readIntegrationJsonData(projectRoot);
  if (data === null) return [null, error];
  return [normalizeIntegrationState(data), null];
}

/**
 * Parse `integration.json` and return normalized plus raw state.
 */
export function tryReadIntegrationJsonWithRaw(
  projectRoot: string,
): [IntegrationState | null, IntegrationState | null, IntegrationReadError | null] {
  const [data, error] = readIntegrationJsonData(projectRoot);
  if (data === null) return [null, null, error];
  return [normalizeIntegrationState(data), data, null];
}

/** Return a stripped integration key, or null for empty/non-string values. */
export function cleanIntegrationKey(key: unknown): string | null {
  if (typeof key !== 'string' || !key.trim()) return null;
  return key.trim();
}

/** Return a de-duplicated list of non-empty integration keys. */
export function dedupeIntegrationKeys(keys: unknown): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  if (!Array.isArray(keys)) return deduped;
  for (const key of keys) {
    const clean = cleanIntegrationKey(key);
    if (clean === null) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    deduped.push(clean);
  }
  return deduped;
}

/** Return JSON-safe per-integration runtime settings. */
export function normalizeIntegrationSettings(settings: unknown): IntegrationSettings {
  if (!isPlainObject(settings)) return {};

  const normalized: IntegrationSettings = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!key.trim() || !isPlainObject(value)) continue;

    const clean: IntegrationSettingEntry = {};
    const script = value['script'];
    if (typeof script === 'string' && script.trim()) clean.script = script.trim();

    const rawOptions = value['raw_options'];
    if (typeof rawOptions === 'string') clean.raw_options = rawOptions;

    const parsedOptions = value['parsed_options'];
    if (isPlainObject(parsedOptions)) clean.parsed_options = parsedOptions;

    const invokeSeparator = value['invoke_separator'];
    if (typeof invokeSeparator === 'string' && invokeSeparator.trim()) {
      clean.invoke_separator = invokeSeparator.trim();
    }

    if (Object.keys(clean).length > 0) normalized[key.trim()] = clean;
  }
  return normalized;
}

function normalizedIntegrationStateSchema(value: unknown): number {
  if (isJsonInt(value) && value > INTEGRATION_STATE_SCHEMA) return value;
  return INTEGRATION_STATE_SCHEMA;
}

/** Normalize legacy and multi-install integration metadata. */
export function normalizeIntegrationState(data: Record<string, unknown>): IntegrationState {
  const legacyKey = cleanIntegrationKey(data['integration']);
  let defaultKey = cleanIntegrationKey(data['default_integration']) ?? legacyKey;

  const installed = data['installed_integrations'];
  const installedKeys = dedupeIntegrationKeys(Array.isArray(installed) ? installed : []);
  if (!defaultKey && installedKeys.length > 0) defaultKey = installedKeys[0];
  if (defaultKey && !installedKeys.includes(defaultKey)) installedKeys.unshift(defaultKey);

  const settings = normalizeIntegrationSettings(data['integration_settings']);

  const normalized: IntegrationState = { ...data };
  normalized['integration_state_schema'] = normalizedIntegrationStateSchema(
    data['integration_state_schema'],
  );
  if (defaultKey) {
    normalized['integration'] = defaultKey;
    normalized['default_integration'] = defaultKey;
  } else {
    delete normalized['integration'];
    delete normalized['default_integration'];
  }
  normalized['installed_integrations'] = installedKeys;
  const filtered: IntegrationSettings = {};
  for (const key of installedKeys) {
    if (key in settings) filtered[key] = settings[key];
  }
  normalized['integration_settings'] = filtered;
  return normalized;
}

/** Return the default integration key from normalized state. */
export function defaultIntegrationKey(state: IntegrationState | null | undefined): string | null {
  if (!state) return null;
  const key = state['default_integration'] || state['integration'];
  return cleanIntegrationKey(key);
}

/** Return installed integration keys from normalized state. */
export function installedIntegrationKeys(state: IntegrationState | null | undefined): string[] {
  if (!state) return [];
  const value = state['installed_integrations'];
  return dedupeIntegrationKeys(value === undefined ? [] : value);
}

/** Return normalized per-integration settings from state. */
export function integrationSettings(state: IntegrationState | null | undefined): IntegrationSettings {
  if (!state) return {};
  return normalizeIntegrationSettings(state['integration_settings']);
}

/** Return stored runtime settings for `key`. */
export function integrationSetting(
  state: IntegrationState | null | undefined,
  key: string,
): IntegrationSettingEntry {
  return { ...(integrationSettings(state)[key] ?? {}) };
}

export interface WriteIntegrationJsonOptions {
  version: string;
  integrationKey: string | null | undefined;
  installedIntegrations?: string[] | null;
  settings?: IntegrationSettings | null;
}

/**
 * Serialize like Python `json.dumps(data, indent=2)` (ensure_ascii=True).
 */
export function pythonJsonDumps(data: unknown, indent = 2): string {
  const text = JSON.stringify(data, null, indent);
  // ensure_ascii: escape non-ASCII characters as \uXXXX.
  return text.replace(/[\u007f-￿]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code === 0x7f) return ch;
    return '\\u' + code.toString(16).padStart(4, '0');
  });
}

/** Write `.specify/integration.json` with legacy-compatible state. */
export function writeIntegrationJson(projectRoot: string, opts: WriteIntegrationJsonOptions): void {
  const dest = join(projectRoot, INTEGRATION_JSON);
  mkdirSync(dirname(dest), { recursive: true });

  let integrationKey = cleanIntegrationKey(opts.integrationKey);
  const installed = dedupeIntegrationKeys(opts.installedIntegrations ?? []);
  if (integrationKey && !installed.includes(integrationKey)) installed.unshift(integrationKey);
  if (!integrationKey && installed.length > 0) integrationKey = installed[0];

  const normalizedAll = normalizeIntegrationSettings(opts.settings ?? {});
  const normalizedSettings: IntegrationSettings = {};
  for (const key of installed) {
    if (key in normalizedAll) normalizedSettings[key] = normalizedAll[key];
  }

  const data: Record<string, unknown> = {
    version: opts.version,
    integration_state_schema: INTEGRATION_STATE_SCHEMA,
    installed_integrations: installed,
    integration_settings: normalizedSettings,
  };
  if (integrationKey) {
    data['integration'] = integrationKey;
    data['default_integration'] = integrationKey;
  }

  writeFileSync(dest, pythonJsonDumps(data, 2) + '\n', 'utf-8');
}
