/**
 * @oakoliver/specify-cli - Bundle validator
 *
 * Structural + reference validation for a bundle manifest. ``specify bundle
 * validate`` reports whether a manifest is well-formed and all component
 * references are resolvable. Reference resolution is optional (requires a
 * checker callback) so the command can run fully offline.
 *
 * Port of ``specify_cli/bundles/validator.py``.
 *
 * @module bundles/validator
 */

import { BundlerError } from './index.js';
import { parseConstraint } from './versioning.js';
import type { BundleManifest, ComponentRef } from './manifest.js';

// ============================================================================
// Types
// ============================================================================

/** A reference checker returns null when resolvable, or an error string. */
export type ReferenceChecker = (component: ComponentRef) => string | null | undefined | Promise<string | null | undefined>;

export class ValidationReport {
  errors: string[] = [];
  warnings: string[] = [];

  get ok(): boolean {
    return this.errors.length === 0;
  }

  merge(other: ValidationReport): void {
    this.errors.push(...other.errors);
    this.warnings.push(...other.warnings);
  }
}

// ============================================================================
// Validation
// ============================================================================

function structuralReport(manifest: BundleManifest): ValidationReport {
  const report = new ValidationReport();
  report.errors.push(...manifest.structuralErrors());
  if (manifest.requires.speckit_version) {
    try {
      parseConstraint(manifest.requires.speckit_version);
    } catch (exc) {
      if (!(exc instanceof BundlerError)) throw exc;
      report.errors.push(
        `requires.speckit_version '${manifest.requires.speckit_version}' ` +
          `is not a valid constraint: ${exc.message}`,
      );
    }
  }
  return report;
}

/** Structural-only validation (synchronous). */
export function validateManifestSync(manifest: BundleManifest): ValidationReport {
  return structuralReport(manifest);
}

/** Validate *manifest*, optionally resolving references via *referenceChecker*. */
export async function validateManifest(
  manifest: BundleManifest,
  referenceChecker: ReferenceChecker | null = null,
): Promise<ValidationReport> {
  const report = structuralReport(manifest);
  if (referenceChecker !== null) {
    for (const component of manifest.components) {
      const problem = await referenceChecker(component);
      if (problem) {
        report.errors.push(`Unresolved reference ${component.label()}: ${problem}`);
      }
    }
  }
  return report;
}
