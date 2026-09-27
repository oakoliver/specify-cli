/**
 * @oakoliver/specify-cli - Bundle manifest
 *
 * Bundle manifest model (``bundle.yml``) — parsing and structural normalization.
 * Structural validation (shape, required fields, enum/semver checks) lives
 * here; *reference* resolution against a catalog stack lives in the
 * validator/resolver services.
 *
 * Port of ``specify_cli/bundles/manifest.py``.
 *
 * @module bundles/manifest
 */

import { BundlerError } from './index.js';
import { isSemver } from './versioning.js';
import { loadYaml } from './yamlio.js';
import { dget, isMapping, pyRepr, pyStr, pyTruthy } from './pycompat.js';

// ============================================================================
// Constants
// ============================================================================

export const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<string> = new Set(['1.0']);
export const PRESET_STRATEGIES: ReadonlySet<string> = new Set(['replace', 'prepend', 'append', 'wrap']);

export const COMPONENT_KINDS = ['extensions', 'presets', 'steps', 'workflows'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

// A bundle id must be a filesystem-safe slug: it is interpolated into artifact
// filenames (e.g. ``<id>-<version>.zip``), so path separators or traversal
// segments must never appear.
const SAFE_BUNDLE_ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** ``sorted(set)`` rendered like Python's list repr. */
export function sortedRepr(values: Iterable<string>): string {
  return pyRepr([...values].sort());
}

// ============================================================================
// Models
// ============================================================================

/** A pointer to an existing Spec Kit primitive a bundle installs. */
export class ComponentRef {
  readonly kind: string;
  readonly id: string;
  readonly version: string | null;
  readonly source: string | null;
  readonly priority: number | null;
  readonly strategy: string | null;

  constructor(init: {
    kind: string;
    id: string;
    version?: string | null;
    source?: string | null;
    priority?: number | null;
    strategy?: string | null;
  }) {
    this.kind = init.kind;
    this.id = init.id;
    this.version = init.version ?? null;
    this.source = init.source ?? null;
    this.priority = init.priority ?? null;
    this.strategy = init.strategy ?? null;
    Object.freeze(this);
  }

  label(): string {
    return `${this.kind.slice(0, -1)}:${this.id}@${this.version || 'unpinned'}`;
  }

  /** Value-equality key (frozen dataclass ``__eq__``/``__hash__``). */
  identity(): string {
    return JSON.stringify([this.kind, this.id, this.version, this.source, this.priority, this.strategy]);
  }

  equals(other: ComponentRef): boolean {
    return this.identity() === other.identity();
  }
}

export interface IntegrationRef {
  readonly id: string;
}

export interface Requires {
  readonly speckit_version: string;
  readonly tools: readonly string[];
  readonly mcp: readonly string[];
}

export interface BundleMeta {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly role: string;
  readonly description: string;
  readonly author: string;
  readonly license: string;
}

export class BundleManifest {
  schema_version: string;
  bundle: BundleMeta;
  requires: Requires;
  integration: IntegrationRef | null;
  extensions: ComponentRef[];
  presets: ComponentRef[];
  steps: ComponentRef[];
  workflows: ComponentRef[];
  tags: readonly string[];
  source_path: string | null;

  constructor(init: {
    schema_version: string;
    bundle: BundleMeta;
    requires: Requires;
    integration?: IntegrationRef | null;
    extensions?: ComponentRef[];
    presets?: ComponentRef[];
    steps?: ComponentRef[];
    workflows?: ComponentRef[];
    tags?: readonly string[];
    source_path?: string | null;
  }) {
    this.schema_version = init.schema_version;
    this.bundle = init.bundle;
    this.requires = init.requires;
    this.integration = init.integration ?? null;
    this.extensions = init.extensions ?? [];
    this.presets = init.presets ?? [];
    this.steps = init.steps ?? [];
    this.workflows = init.workflows ?? [];
    this.tags = init.tags ?? [];
    this.source_path = init.source_path ?? null;
  }

  /** All installable component references in deterministic order. */
  get components(): ComponentRef[] {
    return [...this.extensions, ...this.presets, ...this.steps, ...this.workflows];
  }

  // -- construction ---------------------------------------------------------

  static fromFile(p: string): BundleManifest {
    const data = loadYaml(p);
    const manifest = BundleManifest.fromDict(data);
    manifest.source_path = p;
    return manifest;
  }

  static fromDict(data: unknown): BundleManifest {
    if (!isMapping(data)) {
      throw new BundlerError('Manifest must be a YAML mapping at the top level.');
    }

    const schemaVersion = text(dget(data, 'schema_version'));

    const bundleRaw = dget(data, 'bundle');
    if (!isMapping(bundleRaw)) {
      throw new BundlerError("Manifest is missing the required 'bundle' mapping.");
    }
    const meta: BundleMeta = Object.freeze({
      id: text(dget(bundleRaw, 'id')),
      name: text(dget(bundleRaw, 'name')),
      version: text(dget(bundleRaw, 'version')),
      role: text(dget(bundleRaw, 'role')),
      description: text(dget(bundleRaw, 'description')),
      author: text(dget(bundleRaw, 'author')),
      license: text(dget(bundleRaw, 'license')),
    });

    let requiresRaw = dget(data, 'requires');
    if (requiresRaw === undefined || requiresRaw === null) {
      requiresRaw = {};
    } else if (!isMapping(requiresRaw)) {
      throw new BundlerError("'requires' must be a mapping when present.");
    }
    const req = requiresRaw as Record<string, unknown>;
    const requires: Requires = Object.freeze({
      speckit_version: text(dget(req, 'speckit_version')),
      tools: parseStrList(dget(req, 'tools'), 'requires.tools'),
      mcp: parseStrList(dget(req, 'mcp'), 'requires.mcp'),
    });

    let integration: IntegrationRef | null = null;
    const integrationRaw = dget(data, 'integration');
    // A present-but-non-mapping 'integration' (e.g. a bare string "copilot")
    // would be silently dropped; reject it instead.
    if (integrationRaw !== undefined && integrationRaw !== null && !isMapping(integrationRaw)) {
      throw new BundlerError("'integration' must be a mapping when present.");
    }
    if (isMapping(integrationRaw) && pyTruthy(dget(integrationRaw, 'id'))) {
      integration = Object.freeze({ id: pyStr(dget(integrationRaw, 'id')).trim() });
    }

    let provides = dget(data, 'provides');
    if (provides === undefined || provides === null) {
      provides = {};
    } else if (!isMapping(provides)) {
      throw new BundlerError("'provides' must be a mapping when present.");
    }
    const prov = provides as Record<string, unknown>;

    const tagsRawValue = dget(data, 'tags');
    const tagsRaw: readonly string[] =
      tagsRawValue === undefined || tagsRawValue === null ? [] : parseStrList(tagsRawValue, 'tags');

    return new BundleManifest({
      schema_version: schemaVersion,
      bundle: meta,
      requires,
      integration,
      extensions: parseRefs('extensions', dget(prov, 'extensions')),
      presets: parseRefs('presets', dget(prov, 'presets')),
      steps: parseRefs('steps', dget(prov, 'steps')),
      workflows: parseRefs('workflows', dget(prov, 'workflows')),
      tags: tagsRaw.map((t) => String(t)),
    });
  }

  // -- structural validation ------------------------------------------------

  /** Return a list of human-readable structural problems (empty == valid). */
  structuralErrors(): string[] {
    const errors: string[] = [];

    if (!SUPPORTED_SCHEMA_VERSIONS.has(this.schema_version)) {
      errors.push(
        `schema_version '${this.schema_version || '<missing>'}' is not supported ` +
          `(supported: ${sortedRepr(SUPPORTED_SCHEMA_VERSIONS)}).`,
      );
    }

    const required: Array<[string, string]> = [
      ['bundle.id', this.bundle.id],
      ['bundle.name', this.bundle.name],
      ['bundle.version', this.bundle.version],
      ['bundle.role', this.bundle.role],
      ['bundle.description', this.bundle.description],
      ['bundle.author', this.bundle.author],
      ['bundle.license', this.bundle.license],
      ['requires.speckit_version', this.requires.speckit_version],
    ];
    for (const [fieldPath, value] of required) {
      if (!value) errors.push(`Missing required field: ${fieldPath}.`);
    }

    if (this.bundle.version && !isSemver(this.bundle.version)) {
      errors.push(`bundle.version '${this.bundle.version}' is not valid semver.`);
    }

    if (this.bundle.id && !SAFE_BUNDLE_ID.test(this.bundle.id)) {
      errors.push(
        `bundle.id '${this.bundle.id}' must be a slug ` +
          "(lowercase letters, digits, '.', '_', '-'; no path separators).",
      );
    }

    for (const ref of this.components) {
      const singular = ref.kind.slice(0, -1);
      if (!ref.id) errors.push(`A ${singular} entry is missing its 'id'.`);
      if (ref.kind !== 'steps' && !ref.version) {
        errors.push(`${singular} '${ref.id || '<unknown>'}' must be pinned to a 'version'.`);
      }
      if (ref.version && !isSemver(ref.version)) {
        errors.push(`${singular} '${ref.id}' has invalid version '${ref.version}'.`);
      }
    }

    for (const ref of this.presets) {
      if (ref.priority === null) {
        errors.push(`preset '${ref.id}' must declare an integer 'priority'.`);
      }
      if (ref.strategy === null || !PRESET_STRATEGIES.has(ref.strategy)) {
        errors.push(
          `preset '${ref.id}' has invalid strategy '${ref.strategy ?? 'None'}' ` +
            `(must be one of ${sortedRepr(PRESET_STRATEGIES)}).`,
        );
      }
    }

    return errors;
  }

  /** True when the bundle declares no integration (inherits the active one). */
  isAgnostic(): boolean {
    return this.integration === null;
  }
}

// ============================================================================
// Parsing helpers
// ============================================================================

/**
 * Coerce a manifest scalar into stripped text, mapping an explicit null to
 * ``""`` (so an empty ``author:`` is not accepted as the literal ``"None"``).
 */
export function text(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return pyStr(raw).trim();
}

/**
 * Parse a manifest list-of-strings field. Rejects a bare string, any
 * non-list, and any non-string member.
 */
function parseStrList(raw: unknown, fieldName: string): readonly string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new BundlerError(`'${fieldName}' must be a list of strings when present.`);
  }
  if (raw.some((item) => typeof item !== 'string')) {
    throw new BundlerError(`'${fieldName}' must be a list of strings when present.`);
  }
  return Object.freeze([...(raw as string[])]);
}

function optionalText(item: Record<string, unknown>, key: string): string | null {
  const value = dget(item, key);
  return pyTruthy(value) ? pyStr(value).trim() : null;
}

function parseRefs(kind: string, raw: unknown): ComponentRef[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new BundlerError(`provides.${kind} must be a list when present.`);
  }
  const refs: ComponentRef[] = [];
  for (const item of raw) {
    if (!isMapping(item)) {
      throw new BundlerError(`Each provides.${kind} entry must be a mapping.`);
    }
    const priority = parsePriority(kind, dget(item, 'priority'));
    refs.push(
      new ComponentRef({
        kind,
        id: text(dget(item, 'id')),
        version: optionalText(item, 'version'),
        source: optionalText(item, 'source'),
        priority,
        strategy: optionalText(item, 'strategy'),
      }),
    );
  }
  return refs;
}

/** Python ``int(raw)`` for an ``int | str`` value; ``null`` when not parseable. */
export function pyInt(raw: number | string): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  const t = raw.trim().replace(/_/g, (m, off: number, s: string) =>
    off > 0 && /\d/.test(s[off - 1]) && /\d/.test(s[off + 1] ?? '') ? '' : m,
  );
  if (!/^[+-]?\d+$/.test(t)) return null;
  return Number.parseInt(t, 10);
}

function parsePriority(kind: string, raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean' || (typeof raw !== 'number' && typeof raw !== 'string')) {
    throw new BundlerError(`provides.${kind} priority must be an integer, got ${pyRepr(raw)}.`);
  }
  const value = pyInt(raw);
  if (value === null) {
    throw new BundlerError(`provides.${kind} priority must be an integer, got ${pyRepr(raw)}.`);
  }
  return value;
}
