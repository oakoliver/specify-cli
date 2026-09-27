/**
 * @oakoliver/specify-cli - Preset manifest validation and domain errors
 *
 * Port of ``specify_cli/presets/_manifest.py``: ``PresetManifest`` (preset.yml
 * loader/validator), the preset error hierarchy and the valid template
 * type/strategy sets. Also hosts a few small Python-parity helpers shared by
 * the other ``src/presets/*`` modules (type names, reprs, strict UTF-8 reads,
 * ``warnings.warn`` emulation).
 *
 * @module presets/manifest
 */

import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as nodePath from 'node:path';

import { parseYaml, YAMLError } from '../yaml.js';
import { InvalidSpecifier, InvalidVersion, SpecifierSet, Version } from '../bundles/versioning.js';

// ============================================================================
// Errors
// ============================================================================

/** Base exception for preset-related errors. */
export class PresetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresetError';
  }
}

/** Raised when preset manifest validation fails. */
export class PresetValidationError extends PresetError {
  constructor(message: string) {
    super(message);
    this.name = 'PresetValidationError';
  }
}

/** Raised when preset is incompatible with current environment. */
export class PresetCompatibilityError extends PresetError {
  constructor(message: string) {
    super(message);
    this.name = 'PresetCompatibilityError';
  }
}

// ============================================================================
// Constants
// ============================================================================

export const VALID_PRESET_TEMPLATE_TYPES: ReadonlySet<string> = new Set(['template', 'command', 'script']);
export const VALID_PRESET_STRATEGIES: ReadonlySet<string> = new Set(['replace', 'prepend', 'append', 'wrap']);
/** Scripts only support replace and wrap (prepend/append don't make semantic sense for executable code). */
export const VALID_SCRIPT_STRATEGIES: ReadonlySet<string> = new Set(['replace', 'wrap']);

// ============================================================================
// Python-parity helpers (internal to the presets package)
// ============================================================================

/** Python ``type(value).__name__`` for JSON/YAML-shaped values. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Date) return 'datetime';
  if (value instanceof Uint8Array) return 'bytes';
  if (typeof value === 'object') return 'dict';
  return typeof value;
}

/** Python ``repr()`` of a ``str``. */
export function pyStrRepr(value: string): string {
  const useDouble = value.includes("'") && !value.includes('"');
  const quote = useDouble ? '"' : "'";
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + quote;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += ch;
  }
  return quote + out + quote;
}

/** Python ``repr()`` for JSON/YAML-shaped values. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (value === Infinity) return 'inf';
    if (value === -Infinity) return '-inf';
    if (Number.isInteger(value) && !Object.is(value, -0)) return String(value);
    const s = String(value);
    return /[.e]/.test(s) ? s : `${s}.0`;
  }
  if (typeof value === 'string') return pyStrRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${pyStrRepr(k)}: ${pyRepr(v)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return String(value);
}

/** Python ``str()`` for JSON/YAML-shaped values. */
export function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  return pyRepr(value);
}

/** Python ``sorted(set_of_str)`` rendered via ``repr`` (e.g. ``['a', 'b']``). */
export function pySortedSetRepr(values: Iterable<string>): string {
  return pyRepr([...values].sort());
}

/** ``isinstance(value, dict)`` for parsed JSON/YAML values. */
export function isMapping(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array)
  );
}

/** Python truthiness for JSON/YAML-shaped values. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value) ? true : false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isMapping(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python ``dict.get(key, default)`` that only considers own keys. */
export function dget<T = unknown>(obj: Record<string, unknown>, key: string, fallback?: T): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

/** Deep copy for JSON-shaped data (``copy.deepcopy``). */
export function deepCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => deepCopy(v)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepCopy(v);
  return out as T;
}

/** Deep structural equality for JSON-shaped data (Python ``==``). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    if (Array.isArray(b)) return false;
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(b, k) &&
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** Error raised by {@link readTextStrict} for undecodable bytes (``UnicodeDecodeError``). */
export class UnicodeDecodeError extends Error {
  readonly reason: string;
  readonly start: number;
  constructor(reason: string, start: number) {
    super(`'utf-8' codec can't decode byte at position ${start}: ${reason}`);
    this.name = 'UnicodeDecodeError';
    this.reason = reason;
    this.start = start;
  }
}

function firstInvalidUtf8Offset(buf: Uint8Array): number {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    let need = 0;
    if (b < 0x80) {
      i++;
      continue;
    } else if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else return i;
    for (let j = 1; j <= need; j++) {
      const c = buf[i + j];
      if (c === undefined || (c & 0xc0) !== 0x80) return i;
    }
    i += need + 1;
  }
  return -1;
}

/**
 * Read a file as UTF-8, raising {@link UnicodeDecodeError} for undecodable
 * bytes (``Path.read_text(encoding="utf-8")`` semantics). A leading BOM is kept
 * (Python keeps it too with plain ``utf-8``).
 */
export function readTextStrict(filePath: string): string {
  const buf = readFileSync(filePath);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    const start = Math.max(0, firstInvalidUtf8Offset(buf));
    throw new UnicodeDecodeError('invalid start byte', start);
  }
}

/** ``Path.exists()`` (follows symlinks; false on errors). */
export function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** ``Path.is_file()``. */
export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** ``Path.is_dir()``. */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** ``Path.is_symlink()``. */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * ``Path.home()``: honours ``HOME`` (``USERPROFILE`` on Windows) at call time,
 * falling back to ``os.homedir()``.
 */
export function userHome(): string {
  const env = process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  return env && env.length ? env : homedir();
}

/** Lexical ``PurePath.is_relative_to(parent)``. */
export function isRelativeTo(child: string, parent: string): boolean {
  const c = nodePath.resolve(child);
  const p = nodePath.resolve(parent);
  if (c === p) return true;
  const rel = nodePath.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !nodePath.isAbsolute(rel);
}

/** ``datetime.now(timezone.utc).isoformat()`` (microsecond precision, ``+00:00``). */
export function utcNowIso(): string {
  const now = new Date();
  const iso = now.toISOString(); // 2026-01-01T00:00:00.000Z
  return `${iso.slice(0, 23)}000+00:00`;
}

/**
 * ``json.dumps(value, indent=indent)`` with Python's default ``ensure_ascii``
 * escaping of non-ASCII characters.
 */
export function pyJsonDumps(value: unknown, indent?: number): string {
  const text = indent === undefined ? pyJsonCompact(value) : JSON.stringify(value, null, indent);
  return (text ?? 'null').replace(/[\u007f-￿]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code === 0x7f) return ch;
    return `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

function pyJsonCompact(value: unknown): string {
  // Python's default separators are (', ', ': ') when indent is None.
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(pyJsonCompact).join(', ')}]`;
  if (typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonCompact(v)}`);
    return `{${parts.join(', ')}}`;
  }
  return JSON.stringify(value);
}

/** ``packaging.version.Version(value)`` parses without ``InvalidVersion``. */
export function isValidPep440Version(value: string): boolean {
  try {
    new Version(value);
    return true;
  } catch (e) {
    if (e instanceof InvalidVersion) return false;
    throw e;
  }
}

/** ``packaging.specifiers.SpecifierSet(value)`` parses without ``InvalidSpecifier``. */
export function isValidSpecifierSet(value: string): boolean {
  try {
    new SpecifierSet(value);
    return true;
  } catch (e) {
    if (e instanceof InvalidSpecifier) return false;
    throw e;
  }
}

// ============================================================================
// warnings.warn emulation
// ============================================================================

/** Signature of a preset warning sink. */
export type PresetWarningHandler = (message: string) => void;

const defaultWarningHandler: PresetWarningHandler = (message) => {
  process.stderr.write(`UserWarning: ${message}\n`);
};

let warningHandler: PresetWarningHandler = defaultWarningHandler;

/**
 * Emit a Python ``warnings.warn(message)`` equivalent. Written to stderr as
 * ``UserWarning: <message>`` by default; tests (and embedders) can capture
 * warnings with {@link setPresetWarningHandler}.
 */
export function presetWarn(message: string): void {
  warningHandler(message);
}

/** Replace the preset warning sink; pass ``null`` to restore the default. Returns the previous handler. */
export function setPresetWarningHandler(handler: PresetWarningHandler | null): PresetWarningHandler {
  const previous = warningHandler;
  warningHandler = handler ?? defaultWarningHandler;
  return previous;
}

// ============================================================================
// Preset Manifest
// ============================================================================

/** A single ``provides.templates`` entry. */
export interface PresetTemplateEntry {
  type: string;
  name: string;
  file: string;
  strategy?: string;
  description?: string;
  aliases?: unknown;
  replaces?: string;
  [key: string]: unknown;
}

/** A normalized ``requires.extensions`` dependency. */
export interface PresetExtensionDependency {
  id: string;
  version: string | null;
  required: boolean;
  [key: string]: unknown;
}

/** ``re.match(r'^<cls>+$', value)`` including Python's ``$``-before-trailing-newline quirk. */
function pyMatchAnchored(pattern: RegExp, value: string): boolean {
  return pattern.test(value.endsWith('\n') ? value.slice(0, -1) : value);
}

/** Represents and validates a preset manifest (preset.yml). */
export class PresetManifest {
  static readonly SCHEMA_VERSION = '1.0';
  static readonly REQUIRED_FIELDS = ['schema_version', 'preset', 'requires', 'provides'];

  readonly path: string;
  data: Record<string, any>;

  /**
   * Load and validate preset manifest.
   *
   * @throws PresetValidationError If manifest is invalid
   */
  constructor(manifestPath: string) {
    this.path = manifestPath;
    this.data = PresetManifest.loadYaml(manifestPath);
    this.validate();
  }

  /** Load YAML file safely. */
  private static loadYaml(filePath: string): Record<string, any> {
    let data: unknown;
    let text: string;
    try {
      text = readTextStrict(filePath);
    } catch (e) {
      if (e instanceof UnicodeDecodeError) {
        throw new PresetValidationError(
          `Manifest is not valid UTF-8: ${filePath} (${e.reason} at byte ${e.start})`,
        );
      }
      const err = e as NodeJS.ErrnoException;
      if (err && err.code === 'ENOENT') {
        throw new PresetValidationError(`Manifest not found: ${filePath}`);
      }
      throw new PresetValidationError(`Could not read manifest ${filePath}: ${formatOsError(err)}`);
    }
    try {
      data = parseYaml(text);
    } catch (e) {
      if (e instanceof YAMLError) {
        throw new PresetValidationError(`Invalid YAML in ${filePath}: ${e.message}`);
      }
      throw e;
    }
    if (data === null || data === undefined) return {};
    if (!isMapping(data)) {
      throw new PresetValidationError(
        `Manifest must be a YAML mapping, got ${pyTypeName(data)}: ${filePath}`,
      );
    }
    return data as Record<string, any>;
  }

  /** Validate manifest structure and required fields. */
  private validate(): void {
    const data = this.data;
    for (const field of PresetManifest.REQUIRED_FIELDS) {
      if (!(field in data)) {
        throw new PresetValidationError(`Missing required field: ${field}`);
      }
    }

    if (data.schema_version !== PresetManifest.SCHEMA_VERSION) {
      throw new PresetValidationError(
        `Unsupported schema version: ${pyStr(data.schema_version)} ` +
          `(expected ${PresetManifest.SCHEMA_VERSION})`,
      );
    }

    for (const section of ['preset', 'requires', 'provides']) {
      if (!isMapping(data[section])) {
        throw new PresetValidationError(`Invalid ${section}: expected a mapping`);
      }
    }

    const pack = data.preset as Record<string, unknown>;
    for (const field of ['id', 'name', 'version', 'description']) {
      if (!(field in pack)) {
        throw new PresetValidationError(`Missing preset.${field}`);
      }
      if (typeof pack[field] !== 'string') {
        throw new PresetValidationError(
          `Invalid preset.${field}: expected a string, got ${pyTypeName(pack[field])}`,
        );
      }
    }

    const packId = pack.id as string;
    if (!pyMatchAnchored(/^[a-z0-9-]+$/, packId)) {
      throw new PresetValidationError(
        `Invalid preset ID '${packId}': must be lowercase alphanumeric with hyphens only`,
      );
    }

    if (!isValidPep440Version(pack.version as string)) {
      throw new PresetValidationError(`Invalid version: ${pack.version as string}`);
    }

    const requires = data.requires as Record<string, unknown>;
    if (!('speckit_version' in requires)) {
      throw new PresetValidationError('Missing requires.speckit_version');
    }
    const sv = requires.speckit_version;
    if (typeof sv !== 'string' || !sv.trim()) {
      throw new PresetValidationError(
        'Invalid requires.speckit_version: expected a non-empty string, ' + `got ${pyTypeName(sv)}`,
      );
    }

    if ('extensions' in requires) {
      PresetManifest.validateRequiresExtensions(requires.extensions);
    }

    const provides = data.provides as Record<string, unknown>;
    if (!('templates' in provides)) {
      throw new PresetValidationError('Preset must provide at least one template');
    }

    const templates = provides.templates;
    if (!Array.isArray(templates)) {
      throw new PresetValidationError('Invalid provides.templates: expected a list');
    }
    if (templates.length === 0) {
      throw new PresetValidationError('Preset must provide at least one template');
    }
    const seenNameTypes = new Set<string>();
    for (const tmpl of templates) {
      if (!isMapping(tmpl)) {
        throw new PresetValidationError(
          "Each template entry in 'provides.templates' must be a mapping",
        );
      }
      if (!('type' in tmpl) || !('name' in tmpl) || !('file' in tmpl)) {
        throw new PresetValidationError("Template missing 'type', 'name', or 'file'");
      }
      for (const field of ['type', 'name', 'file']) {
        if (typeof tmpl[field] !== 'string') {
          throw new PresetValidationError(
            `Invalid template ${field}: expected a string, got ${pyTypeName(tmpl[field])}`,
          );
        }
      }
      const tType = tmpl.type as string;
      const tName = tmpl.name as string;
      if (!VALID_PRESET_TEMPLATE_TYPES.has(tType)) {
        throw new PresetValidationError(
          `Invalid template type '${tType}': must be one of ${pySortedSetRepr(VALID_PRESET_TEMPLATE_TYPES)}`,
        );
      }

      const key = JSON.stringify([tName, tType]);
      if (seenNameTypes.has(key)) {
        throw new PresetValidationError(
          `Duplicate template name '${tName}' of type '${tType}' in 'provides.templates'`,
        );
      }
      seenNameTypes.add(key);

      const filePath = tmpl.file as string;
      const normalized = nodePath.normalize(filePath === '' ? '.' : filePath);
      if (nodePath.isAbsolute(normalized) || normalized.startsWith('..')) {
        throw new PresetValidationError(
          `Invalid template file path '${filePath}': ` +
            'must be a relative path within the preset directory',
        );
      }

      let strategy: unknown = 'strategy' in tmpl ? tmpl.strategy : 'replace';
      if (typeof strategy !== 'string') {
        throw new PresetValidationError(
          `Invalid strategy value: must be a string, got ${pyTypeName(strategy)}`,
        );
      }
      strategy = (strategy as string).toLowerCase();
      if ('strategy' in tmpl) tmpl.strategy = strategy;
      if (!VALID_PRESET_STRATEGIES.has(strategy as string)) {
        throw new PresetValidationError(
          `Invalid strategy '${strategy as string}': must be one of ${pySortedSetRepr(VALID_PRESET_STRATEGIES)}`,
        );
      }
      if (tType === 'script' && !VALID_SCRIPT_STRATEGIES.has(strategy as string)) {
        throw new PresetValidationError(
          `Invalid strategy '${strategy as string}' for script: ` +
            `scripts only support ${pySortedSetRepr(VALID_SCRIPT_STRATEGIES)}`,
        );
      }

      if (tType === 'command') {
        if (!pyMatchAnchored(/^[a-z0-9.-]+$/, tName)) {
          throw new PresetValidationError(
            `Invalid command name '${tName}': ` +
              'must be lowercase alphanumeric with hyphens and dots only',
          );
        }
      } else if (!pyMatchAnchored(/^[a-z0-9-]+$/, tName)) {
        throw new PresetValidationError(
          `Invalid template name '${tName}': must be lowercase alphanumeric with hyphens only`,
        );
      }
    }
  }

  /** Get preset ID. */
  get id(): string {
    return this.data.preset.id;
  }

  /** Get preset name. */
  get name(): string {
    return this.data.preset.name;
  }

  /** Get preset version. */
  get version(): string {
    return this.data.preset.version;
  }

  /** Get preset description. */
  get description(): string {
    return this.data.preset.description;
  }

  /** Get preset author. */
  get author(): string {
    const preset = this.data.preset as Record<string, unknown>;
    return ('author' in preset ? preset.author : '') as string;
  }

  /**
   * Validate the optional ``requires.extensions`` list.
   *
   * Accepts either a bare extension id or a mapping carrying an optional
   * version specifier and an optional ``required`` flag.
   */
  static validateRequiresExtensions(declared: unknown): void {
    if (!Array.isArray(declared)) {
      throw new PresetValidationError(
        `Invalid requires.extensions: expected a list, got ${pyTypeName(declared)}`,
      );
    }
    declared.forEach((raw, index) => {
      const label = `requires.extensions[${index}]`;
      let entry: Record<string, unknown>;
      if (typeof raw === 'string') {
        entry = { id: raw };
      } else if (isMapping(raw)) {
        entry = raw;
      } else {
        throw new PresetValidationError(
          `Invalid ${label}: expected a string or a mapping, got ${pyTypeName(raw)}`,
        );
      }

      if (!('id' in entry)) {
        throw new PresetValidationError(`Missing ${label}.id`);
      }
      const extensionId = entry.id;
      if (typeof extensionId !== 'string') {
        throw new PresetValidationError(
          `Invalid ${label}.id: expected a string, got ${pyTypeName(extensionId)}`,
        );
      }
      if (!/^[a-z0-9-]+$/.test(extensionId)) {
        throw new PresetValidationError(
          `Invalid ${label}.id ${pyStrRepr(extensionId)}: ` +
            'must be lowercase alphanumeric with hyphens only',
        );
      }

      if ('version' in entry) {
        const constraint = entry.version;
        if (typeof constraint !== 'string' || !constraint.trim()) {
          throw new PresetValidationError(
            `Invalid ${label}.version: expected a non-empty string, got ${pyTypeName(constraint)}`,
          );
        }
        if (!isValidSpecifierSet(constraint)) {
          throw new PresetValidationError(
            `Invalid ${label}.version '${constraint}': not a valid version specifier`,
          );
        }
      }

      if ('required' in entry && typeof entry.required !== 'boolean') {
        throw new PresetValidationError(
          `Invalid ${label}.required: expected a boolean, got ${pyTypeName(entry.required)}`,
        );
      }
    });
  }

  /** Get required spec-kit version range. */
  get requiresSpeckitVersion(): string {
    return this.data.requires.speckit_version;
  }

  /**
   * Get declared extension dependencies, normalized to mappings with ``id``,
   * ``version`` (``null`` when unconstrained) and ``required`` (default true).
   */
  get requiresExtensions(): PresetExtensionDependency[] {
    const requires = this.data.requires as Record<string, unknown>;
    const declared = requires.extensions;
    if (!Array.isArray(declared)) return [];
    const normalized: PresetExtensionDependency[] = [];
    for (const raw of declared) {
      const entry: unknown = typeof raw === 'string' ? { id: raw } : raw;
      if (!isMapping(entry) || typeof entry.id !== 'string') continue;
      normalized.push({
        id: entry.id,
        version: ('version' in entry ? entry.version : null) as string | null,
        required: ('required' in entry ? entry.required : true) as boolean,
      });
    }
    return normalized;
  }

  /** Get list of provided templates. */
  get templates(): PresetTemplateEntry[] {
    return this.data.provides.templates as PresetTemplateEntry[];
  }

  /** Get preset tags. */
  get tags(): unknown {
    return 'tags' in this.data ? this.data.tags : [];
  }

  /** Calculate SHA256 hash of manifest file. */
  getHash(): string {
    const h = createHash('sha256');
    h.update(readFileSync(this.path));
    return `sha256:${h.digest('hex')}`;
  }
}

/** Render a Node fs error roughly like Python's ``OSError.__str__``. */
export function formatOsError(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  if (e && typeof e === 'object' && typeof e.code === 'string') {
    const errnoNum = typeof e.errno === 'number' ? Math.abs(e.errno) : undefined;
    const desc = (e.message || '').replace(/^[A-Z]+: /, '').replace(/,.*$/, '');
    const pathPart = e.path ? `: '${e.path}'` : '';
    return errnoNum !== undefined ? `[Errno ${errnoNum}] ${desc}${pathPart}` : `${desc}${pathPart}`;
  }
  return e instanceof Error ? e.message : String(err);
}
