/**
 * @oakoliver/specify-cli - Bundle conflict detection
 *
 * Conflict detection across the installed-bundle stack. The single
 * cross-bundle conflict point is the active integration (FR-019).
 * Component-level overlaps are resolved by the existing primitive machinery's
 * own precedence rules, so the bundler only guards the integration invariant
 * and surfaces informational overlaps.
 *
 * Port of ``specify_cli/bundles/conflict.py``.
 *
 * @module bundles/conflict
 */

import type { BundleManifest } from './manifest.js';
import type { InstalledBundleRecord } from './records.js';

export class ConflictReport {
  /** Message when a hard clash exists. */
  integration_clash: string | null = null;
  /** Components already provided. */
  overlaps: string[] = [];

  get hasBlockingConflict(): boolean {
    return this.integration_clash !== null;
  }
}

export function detectConflicts(
  manifest: BundleManifest,
  activeIntegration: string | null,
  installed: InstalledBundleRecord[],
): ConflictReport {
  const report = new ConflictReport();

  if (manifest.integration !== null && activeIntegration) {
    if (manifest.integration.id !== activeIntegration) {
      report.integration_clash =
        `Bundle targets integration '${manifest.integration.id}' but the ` +
        `project's active integration is '${activeIntegration}'.`;
    }
  }

  const already = new Map<string, string>();
  for (const record of installed) {
    for (const component of record.contributed_components) {
      already.set(JSON.stringify([component.kind, component.id]), record.bundle_id);
    }
  }

  for (const component of manifest.components) {
    const owner = already.get(JSON.stringify([component.kind, component.id]));
    if (owner && owner !== manifest.bundle.id) {
      report.overlaps.push(
        `${component.kind.slice(0, -1)} '${component.id}' is already provided by ` + `bundle '${owner}'.`,
      );
    }
  }

  return report;
}
