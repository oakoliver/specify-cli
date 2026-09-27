/**
 * @oakoliver/specify-cli - Bundle resolver
 *
 * Expand a bundle manifest into a concrete, ordered install plan. The plan is
 * the single source of truth shared by ``info`` (preview) and ``install``
 * (execution). Resolution also enforces the SpecKit version gate (FR-016) and
 * the integration-compatibility check (FR-019).
 *
 * Port of ``specify_cli/bundles/resolver.py``.
 *
 * @module bundles/resolver
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { BundlerError } from './index.js';
import { satisfies } from './versioning.js';
import { BundleManifest, ComponentRef } from './manifest.js';

export class InstallPlan {
  bundle_id: string;
  version: string;
  role: string;
  effective_integration: string | null;
  components: ComponentRef[];
  warnings: string[];

  constructor(init: {
    bundle_id: string;
    version: string;
    role: string;
    effective_integration: string | null;
    components?: ComponentRef[];
    warnings?: string[];
  }) {
    this.bundle_id = init.bundle_id;
    this.version = init.version;
    this.role = init.role;
    this.effective_integration = init.effective_integration;
    this.components = init.components ?? [];
    this.warnings = init.warnings ?? [];
  }

  get componentCount(): number {
    return this.components.length;
  }

  grouped(): Record<string, ComponentRef[]> {
    const groups: Record<string, ComponentRef[]> = {
      extensions: [],
      presets: [],
      steps: [],
      workflows: [],
    };
    for (const component of this.components) {
      (groups[component.kind] ??= []).push(component);
    }
    return groups;
  }
}

export interface ResolveInstallPlanOptions {
  speckitVersion: string;
  activeIntegration: string | null;
  integrationExplicit?: boolean;
  enforceVersion?: boolean;
}

/**
 * Expand *manifest* into an {@link InstallPlan}, enforcing gates. Throws
 * {@link BundlerError} when a hard gate fails (version gate, integration
 * clash). Soft issues are collected in ``plan.warnings``.
 *
 * *integrationExplicit* signals that ``activeIntegration`` came from an
 * explicit ``--integration`` override rather than project auto-detection.
 */
export function resolveInstallPlan(manifest: BundleManifest, opts: ResolveInstallPlanOptions): InstallPlan {
  const { speckitVersion, integrationExplicit = false, enforceVersion = true } = opts;
  let activeIntegration = opts.activeIntegration;

  const structural = manifest.structuralErrors();
  if (structural.length) {
    throw new BundlerError('Cannot resolve an invalid manifest:\n  - ' + structural.join('\n  - '));
  }

  // FR-016: SpecKit version gate — refuse incompatible installs.
  if (enforceVersion && manifest.requires.speckit_version) {
    if (!satisfies(speckitVersion, manifest.requires.speckit_version)) {
      throw new BundlerError(
        `Bundle '${manifest.bundle.id}' requires Spec Kit ` +
          `${manifest.requires.speckit_version}, but this project uses ` +
          `${speckitVersion}. Update Spec Kit or choose a compatible bundle.`,
      );
    }
  }

  // FR-019: a blank integration is indeterminate, not a usable id; strip first
  // so a padded value is not reported as clashing with itself.
  if (activeIntegration !== null && activeIntegration !== undefined) {
    activeIntegration = activeIntegration.trim() || null;
  } else {
    activeIntegration = null;
  }
  let effectiveIntegration = activeIntegration;
  if (manifest.integration !== null) {
    const required = manifest.integration.id;
    if (activeIntegration && required !== activeIntegration) {
      throw new BundlerError(
        `Bundle '${manifest.bundle.id}' targets integration '${required}', ` +
          `but this project's active integration is '${activeIntegration}'. ` +
          'Installing it would conflict; aborting with no changes.',
      );
    }
    if (activeIntegration === null && !integrationExplicit) {
      throw new BundlerError(
        `Bundle '${manifest.bundle.id}' targets integration '${required}', ` +
          "but this project's active integration could not be determined " +
          '(missing or unreadable .specify/integration.json). Re-run with ' +
          "'--integration' to confirm the target, or repair the project " +
          'before installing.',
      );
    }
    effectiveIntegration = required;
  }

  const warnings: string[] = [];
  if (manifest.requires.tools.length) {
    warnings.push('Requires external tools: ' + manifest.requires.tools.join(', '));
  }
  if (manifest.requires.mcp.length) {
    warnings.push('Requires MCP servers: ' + manifest.requires.mcp.join(', '));
  }

  return new InstallPlan({
    bundle_id: manifest.bundle.id,
    version: manifest.bundle.version,
    role: manifest.bundle.role,
    effective_integration: effectiveIntegration,
    components: [...manifest.components],
    warnings,
  });
}

/** Load ``bundle.yml`` from a bundle directory. */
export function loadManifestFromDir(bundleDir: string): BundleManifest {
  const manifestPath = path.join(bundleDir, 'bundle.yml');
  if (!existsSync(manifestPath)) {
    throw new BundlerError(`No bundle.yml found in '${bundleDir}'.`);
  }
  return BundleManifest.fromFile(manifestPath);
}
