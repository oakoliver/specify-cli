/**
 * @oakoliver/specify-cli - Bundle conflict detection
 *
 * Conflict detection across the installed-bundle stack: the active
 * integration, exact-version clashes between bundles requiring the same
 * component ID, and informational overlaps.
 *
 * Port of ``specify_cli/bundles/conflict.py`` (spec-kit v1.2.5).
 *
 * @module bundles/conflict
 */

import type { BundleManifest, ComponentRef } from './manifest.js';
import { DEFAULT_PRIORITY } from './primitives.js';
import type { InstalledBundleRecord } from './records.js';
import { sameVersion } from './versioning.js';

export class ConflictReport {
  /** Message when a hard clash exists. */
  integration_clash: string | null = null;
  version_clashes: string[] = [];
  /** Components already required. */
  overlaps: string[] = [];

  get hasBlockingConflict(): boolean {
    return this.integration_clash !== null || this.version_clashes.length > 0;
  }
}

type SettingField = 'source' | 'priority' | 'strategy';

/**
 * Return *value* as it affects install for a component of *kind*.
 *
 * ``priority`` applies to presets and, when *extensionPriority* is true,
 * extensions, where an omitted value installs as ``DEFAULT_PRIORITY``.
 * ``strategy`` applies to presets only. Settings that do not apply return
 * ``null``; ``source`` always applies.
 */
export function effectiveSetting(
  kind: string,
  field: string,
  value: unknown,
  opts: { extensionPriority?: boolean } = {},
): unknown {
  const extensionPriority = opts.extensionPriority ?? true;
  if (field === 'priority') {
    if (kind === 'extensions' && extensionPriority) {
      return value === null || value === undefined ? DEFAULT_PRIORITY : value;
    }
    return kind === 'presets' ? value : null;
  }
  if (field === 'strategy') return kind === 'presets' ? value : null;
  return value;
}

/**
 * Return install-affecting setting fields that differ between two refs.
 * Versions are intentionally not compared.
 */
export function componentSettingDifferences(
  a: ComponentRef,
  b: ComponentRef,
  opts: { extensionPriority?: boolean } = {},
): string[] {
  const fields: SettingField[] = ['source', 'priority', 'strategy'];
  return fields.filter(
    (field) =>
      (effectiveSetting(a.kind, field, a[field], opts) ?? null) !==
      (effectiveSetting(b.kind, field, b[field], opts) ?? null),
  );
}

/**
 * Install-affecting differences between two refs of the same kind:id.
 *
 * Version is compared through ``sameVersion`` (``v1.0.0`` == ``1.0.0``);
 * ``source``, ``priority`` and ``strategy`` through ``effectiveSetting``.
 * An empty list means the two refs install identically.
 */
export function componentDifferences(
  a: ComponentRef,
  b: ComponentRef,
  opts: { extensionPriority?: boolean } = {},
): string[] {
  const different: string[] = [];
  if (a.version === null || b.version === null) {
    if (a.version !== b.version) different.push('version');
  } else if (!sameVersion(a.version, b.version)) {
    different.push('version');
  }
  different.push(...componentSettingDifferences(a, b, opts));
  return different;
}

/** True when *a* and *b* describe the same installable requirement. */
export function sameRequirement(
  a: ComponentRef,
  b: ComponentRef,
  opts: { extensionPriority?: boolean } = {},
): boolean {
  return a.kind === b.kind && a.id === b.id && componentDifferences(a, b, opts).length === 0;
}

export function detectConflicts(
  manifest: BundleManifest,
  activeIntegration: string | null,
  installed: InstalledBundleRecord[],
  components: ComponentRef[] | null = null,
): ConflictReport {
  const report = new ConflictReport();

  if (manifest.integration !== null && activeIntegration && manifest.integration.id !== activeIntegration) {
    report.integration_clash =
      `Bundle targets integration '${manifest.integration.id}' but the ` +
      `project's active integration is '${activeIntegration}'.`;
  }

  const already = new Map<string, Array<[string, string | null]>>();
  for (const record of installed) {
    for (const component of record.required_components) {
      const key = JSON.stringify([component.kind, component.id]);
      if (!already.has(key)) already.set(key, []);
      already.get(key)!.push([record.bundle_id, component.version]);
    }
  }

  const selected = components === null ? manifest.components : components;
  for (const component of selected) {
    for (const [owner, version] of already.get(JSON.stringify([component.kind, component.id])) ?? []) {
      if (owner === manifest.bundle.id) continue;
      if (component.version && (!version || !sameVersion(component.version, version))) {
        report.version_clashes.push(
          `${component.kind.slice(0, -1)} '${component.id}' requires version ` +
            `${component.version}, but bundle '${owner}' already requires ` +
            `version ${version || '<unknown>'}. Only one version can be ` +
            'installed per ID.',
        );
      } else {
        report.overlaps.push(
          `${component.kind.slice(0, -1)} '${component.id}' is already required by bundle '${owner}'.`,
        );
      }
    }
  }

  return report;
}
