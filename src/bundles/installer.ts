/**
 * @oakoliver/specify-cli - Bundle installer
 *
 * Apply an {@link InstallPlan} via existing primitive machinery. The actual
 * component installation is delegated to a {@link PrimitiveInstaller} so the
 * bundler never re-implements primitive logic and tests can inject a
 * deterministic, offline fake.
 *
 * Installation is idempotent and stops on first failure with no partial
 * record write (FR-018).
 *
 * Port of ``specify_cli/bundles/installer.py`` (spec-kit v1.2.5).
 *
 * @module bundles/installer
 */

import { BundlerError } from './index.js';
import { BundleRef, type BundleManifest, type ComponentRef } from './manifest.js';
import {
  InstalledBundleRecord,
  componentKey,
  componentsStillNeeded,
  findRecord,
  loadRecords,
  removeRecord,
  saveRecords,
  transferContributions,
  upsertRecord,
} from './records.js';
import { componentSettingDifferences, detectConflicts, sameRequirement } from './conflict.js';
import type { BundledPatchWarning } from './primitives.js';
import type { InstallPlan } from './resolver.js';
import { sameVersion } from './versioning.js';

// ============================================================================
// Types
// ============================================================================

type MaybePromise<T> = T | Promise<T>;

/** Adapter over the existing Spec Kit primitive install/remove machinery. */
export interface PrimitiveInstaller {
  isInstalled(projectRoot: string, component: ComponentRef): MaybePromise<boolean>;
  /**
   * Installed version recorded by the primitive registry (null = unknown).
   * ADAPTATION: optional so minimal fakes stay valid; absent means unknown.
   */
  installedVersion?(projectRoot: string, component: ComponentRef): MaybePromise<string | null>;
  /** Verify a ``source``-pinned component against its winning catalog. */
  validateSource?(projectRoot: string, component: ComponentRef): MaybePromise<void>;
  install(projectRoot: string, component: ComponentRef): MaybePromise<BundledPatchWarning | null | void>;
  remove(projectRoot: string, component: ComponentRef): MaybePromise<void>;
  /** Optional refresh hook (falls back to ``install``). */
  refresh?(projectRoot: string, component: ComponentRef): MaybePromise<BundledPatchWarning | null | void>;
  /** Optional: accept a newer packaged patch with a warning. */
  bundledPatchWarning?(component: ComponentRef, actual: string): MaybePromise<BundledPatchWarning | null>;
}

/** Bundle changes and structured warnings for presentation by the caller. */
export class InstallResult {
  installed: ComponentRef[] = [];
  skipped: ComponentRef[] = [];
  refreshed: ComponentRef[] = [];
  uninstalled: ComponentRef[] = [];
  warnings: BundledPatchWarning[] = [];

  constructor(readonly bundle_id: string) {}

  /**
   * ``uninstalled`` is a mutating outcome too: a ``bundle update`` whose new
   * manifest drops components must still report changed=true.
   */
  get changed(): boolean {
    return this.installed.length > 0 || this.refreshed.length > 0 || this.uninstalled.length > 0;
  }
}

function errMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

async function installedVersionOf(
  installer: PrimitiveInstaller,
  projectRoot: string,
  component: ComponentRef,
): Promise<string | null> {
  if (typeof installer.installedVersion !== 'function') return null;
  return (await installer.installedVersion(projectRoot, component)) ?? null;
}

// ============================================================================
// Install / remove
// ============================================================================

/**
 * Execute *plan*, recording provenance. Idempotent, with bounded rollback.
 *
 * On failure only the components newly installed during *this* call are
 * rolled back, and the provenance record is written solely on full success.
 * When *refresh* is true (``specify bundle update``), already-installed owned
 * components are re-applied to the plan's pinned versions (or compatible newer
 * packaged patches, with a warning), and components the bundle used to own
 * that the new manifest drops are uninstalled unless another bundle still
 * needs them.
 *
 * Already-installed components must match their pins before they can be
 * skipped. A refresh may repair drift in components owned exclusively by this
 * bundle, but cannot change a version required by another bundle or an
 * independently installed component.
 */
export async function installBundle(
  projectRoot: string,
  plan: InstallPlan,
  installer: PrimitiveInstaller,
  manifest: BundleManifest | null = null,
  refresh = false,
): Promise<InstallResult> {
  const records = loadRecords(projectRoot);

  if (manifest !== null) {
    const report = detectConflicts(manifest, plan.effective_integration, records, plan.components);
    if (report.hasBlockingConflict) {
      throw new BundlerError(
        [...(report.integration_clash ? [report.integration_clash] : []), ...report.version_clashes].join('; '),
      );
    }
  }

  const result = new InstallResult(plan.bundle_id);
  const existing = findRecord(records, plan.bundle_id);
  const plannedByKey = new Map<string, ComponentRef[]>();
  for (const planned of plan.components) {
    const key = componentKey(planned.kind, planned.id);
    if (!plannedByKey.has(key)) plannedByKey.set(key, []);
    plannedByKey.get(key)!.push(planned);
  }
  if (
    existing !== null &&
    !refresh &&
    (existing.version !== plan.version ||
      !existing.contributed_components.every((component) =>
        (plannedByKey.get(componentKey(component.kind, component.id)) ?? []).some((candidate) =>
          sameRequirement(component, candidate),
        ),
      ))
  ) {
    throw new BundlerError(
      `Bundle '${plan.bundle_id}' is already installed at version ` +
        `${existing.version}, but the requested manifest changes the bundle ` +
        'version or changes/removes owned components. ' +
        "Use 'specify bundle update <id>' for a catalog bundle, or " +
        "'specify bundle install <path> --refresh' for a local source, " +
        'to refresh owned components before advancing the installed record.',
    );
  }

  const priorOurs = new Set<string>(
    existing !== null ? existing.contributed_components.map((c) => componentKey(c.kind, c.id)) : [],
  );
  // Components already attributed to a *different* installed bundle are
  // shareable (refcounted on removal). Components installed on disk but
  // tracked by no bundle were installed independently and must NOT be
  // attributed here (FR-022).
  const otherTracked = new Set<string>();
  for (const r of records) {
    if (r.bundle_id === plan.bundle_id) continue;
    for (const c of r.contributed_components) otherTracked.add(componentKey(c.kind, c.id));
  }
  const otherPins = new Map<string, Set<string>>();
  const otherRequirements = new Map<string, Array<[string, ComponentRef]>>();
  for (const record of records) {
    if (record.bundle_id === plan.bundle_id) continue;
    for (const component of record.required_components) {
      const key = componentKey(component.kind, component.id);
      if (!otherRequirements.has(key)) otherRequirements.set(key, []);
      otherRequirements.get(key)!.push([record.bundle_id, component]);
      if (component.version) {
        if (!otherPins.has(key)) otherPins.set(key, new Set());
        otherPins.get(key)!.add(component.version);
      }
    }
  }

  const contributed: ComponentRef[] = [];
  const done: ComponentRef[] = [];
  const installedVersions: Record<string, string> = {};
  try {
    result.warnings.push(
      ...(await checkInstalledPins(projectRoot, plan, installer, priorOurs, otherTracked, otherPins, otherRequirements, {
        refresh,
      })),
    );
    for (const component of plan.components) {
      const key = componentKey(component.kind, component.id);
      if (await installer.isInstalled(projectRoot, component)) {
        // Independently-installed components are never attributed and never
        // refreshed, so ``bundle update`` cannot make collateral changes.
        const owned = priorOurs.has(key) || otherTracked.has(key);
        if (refresh && owned) {
          const warning = await refreshComponent(projectRoot, installer, component);
          if (warning) result.warnings.push(warning);
          result.refreshed.push(component);
        } else {
          result.skipped.push(component);
        }
        if (owned) contributed.push(component);
        continue;
      }
      const warning = await installer.install(projectRoot, component);
      if (warning) result.warnings.push(warning);
      done.push(component);
      result.installed.push(component);
      contributed.push(component);
    }

    // On update (refresh), uninstall components this bundle used to own that
    // the new version no longer ships (otherwise they would be orphaned). A
    // stale component still owned by another bundle is kept installed.
    if (refresh && existing !== null) {
      const planned = new Set(plan.components.map((c) => componentKey(c.kind, c.id)));
      const stillNeeded = componentsStillNeeded(records, plan.bundle_id);
      for (const component of existing.contributed_components) {
        const key = componentKey(component.kind, component.id);
        if (planned.has(key)) continue;
        if (stillNeeded.has(key)) continue;
        if (await installer.isInstalled(projectRoot, component)) {
          await installer.remove(projectRoot, component);
          result.uninstalled.push(component);
        }
      }
    }
    if (typeof installer.installedVersion === 'function') {
      for (const component of plan.components) {
        const actual = await installer.installedVersion(projectRoot, component);
        if (actual !== null && actual !== undefined) installedVersions[`${component.kind}:${component.id}`] = actual;
      }
    }
  } catch (exc) {
    await rollback(projectRoot, installer, done);
    if (exc instanceof BundlerError) throw exc;
    throw new BundlerError(
      `Failed to install bundle '${plan.bundle_id}': ${errMessage(exc)}. No changes were recorded.`,
      { cause: exc },
    );
  }

  const record = InstalledBundleRecord.create(
    plan.bundle_id,
    plan.version,
    contributed,
    // Preserve the original install time across refresh/update.
    existing !== null ? existing.installed_at : null,
    {
      requiredComponents: plan.components,
      installedVersions,
      bundleReferences: plan.references.map(
        (reference) => new BundleRef({ id: reference.id, version: reference.version, source: reference.source_id }),
      ),
    },
  );
  let updated = upsertRecord(records, record);
  if (refresh && existing !== null) {
    const planned = new Set(plan.components.map((c) => componentKey(c.kind, c.id)));
    updated = transferContributions(
      updated,
      existing.contributed_components.filter((c) => !planned.has(componentKey(c.kind, c.id))),
    );
  }
  saveRecords(projectRoot, updated);
  return result;
}

/** Remove a bundle, uninstalling only components no other bundle still needs. */
export async function removeBundle(
  projectRoot: string,
  bundleId: string,
  installer: PrimitiveInstaller,
): Promise<InstallResult> {
  const records = loadRecords(projectRoot);
  const target = records.find((r) => r.bundle_id === bundleId);
  if (target === undefined) throw new BundlerError(`Bundle '${bundleId}' is not installed.`);

  const stillNeeded = componentsStillNeeded(records, bundleId);
  const result = new InstallResult(bundleId);
  let removeAttempted = false;

  try {
    for (const component of target.contributed_components) {
      const key = componentKey(component.kind, component.id);
      if (stillNeeded.has(key)) {
        result.skipped.push(component);
        continue;
      }
      if (await installer.isInstalled(projectRoot, component)) {
        removeAttempted = true;
        await installer.remove(projectRoot, component);
        result.uninstalled.push(component);
      }
    }
    const remaining = transferContributions(removeRecord(records, bundleId), target.contributed_components);
    saveRecords(projectRoot, remaining);
  } catch (exc) {
    let detail: string;
    if (result.uninstalled.length) {
      detail =
        `${result.uninstalled.length} component(s) were already removed ` +
        'before this failure; the bundle record was left unchanged, ' +
        'so the project may be partially uninstalled.';
    } else if (removeAttempted) {
      detail =
        'No components were removed, but the failing component may ' +
        'have made partial changes before raising, so the project ' +
        'may be partially uninstalled.';
    } else {
      detail = 'No components were removed and no removal was attempted; the bundle record was left unchanged.';
    }
    throw new BundlerError(`Failed to remove bundle '${bundleId}': ${errMessage(exc)}. ${detail}`, {
      cause: exc,
    });
  }

  return result;
}

/** Check installed pins and other bundles' requirements before mutation. */
async function checkInstalledPins(
  projectRoot: string,
  plan: InstallPlan,
  installer: PrimitiveInstaller,
  priorOurs: Set<string>,
  otherTracked: Set<string>,
  otherPins: Map<string, Set<string>>,
  otherRequirements: Map<string, Array<[string, ComponentRef]>>,
  opts: { refresh: boolean },
): Promise<BundledPatchWarning[]> {
  const { refresh } = opts;
  const mismatches: string[] = [];
  const warnings: BundledPatchWarning[] = [];
  for (const component of plan.components) {
    const key = componentKey(component.kind, component.id);
    const singular = component.kind.slice(0, -1);
    for (const [bundleId, required] of otherRequirements.get(key) ?? []) {
      // Installed bundles keep the flat-bundle rule: extension priority is
      // never compared; only preset priority is.
      const different = componentSettingDifferences(component, required, { extensionPriority: false });
      if (different.length) {
        throw new BundlerError(
          `Cannot install or refresh shared ${singular} ` +
            `'${component.id}': bundle '${bundleId}' requires different ` +
            `${different.join(', ')}. Shared components must agree on ` +
            'install-affecting requirements.',
        );
      }
    }
    if (component.source && typeof installer.validateSource === 'function') {
      await installer.validateSource(projectRoot, component);
    }
    if (refresh && !component.version && otherTracked.has(key)) {
      throw new BundlerError(
        `Cannot refresh unpinned shared ${singular} ` +
          `'${component.id}': another bundle may require its installed ` +
          'version. Pin this component before refreshing.',
      );
    }
    if (!component.version) {
      const pins = otherPins.get(key);
      if (pins && pins.size) {
        const installed = await installer.isInstalled(projectRoot, component);
        const actual = installed ? await installedVersionOf(installer, projectRoot, component) : null;
        if ((refresh && priorOurs.has(key)) || !actual || [...pins].some((pin) => !sameVersion(actual, pin))) {
          throw new BundlerError(
            `Cannot install or refresh unpinned ${singular} ` +
              `'${component.id}': another bundle requires version ` +
              `${[...pins].sort().join(', ')}. Pin this component to a ` +
              'compatible version before installing or refreshing.',
          );
        }
      }
      continue;
    }
    if (!(await installer.isInstalled(projectRoot, component))) continue;
    const actual = await installedVersionOf(installer, projectRoot, component);
    if (actual && sameVersion(actual, component.version)) continue;
    if (actual && (priorOurs.has(key) || otherTracked.has(key)) && typeof installer.bundledPatchWarning === 'function') {
      const warning = await installer.bundledPatchWarning(component, actual);
      if (warning) {
        if (!refresh) warnings.push(warning);
        continue;
      }
    }
    if (refresh && priorOurs.has(key) && !otherTracked.has(key)) continue;
    const pinned = `${singular} '${component.id}' to ${component.version}`;
    if (!actual) mismatches.push(`${pinned}, but its installed version is unknown`);
    else mismatches.push(`${pinned}, but ${actual} is installed`);
  }
  if (mismatches.length) {
    throw new BundlerError(
      `Bundle '${plan.bundle_id}' pins ${mismatches.join('; ')}. Only one ` +
        'version can be installed per ID; independently installed and ' +
        "other bundles' components cannot be replaced by this bundle.",
    );
  }
  return warnings;
}

/**
 * Re-apply an already-installed component to bring it up to its pinned
 * version. Prefers a primitive-provided ``refresh`` hook when available.
 */
async function refreshComponent(
  projectRoot: string,
  installer: PrimitiveInstaller,
  component: ComponentRef,
): Promise<BundledPatchWarning | null> {
  if (typeof installer.refresh === 'function') {
    return (await installer.refresh(projectRoot, component)) ?? null;
  }
  return (await installer.install(projectRoot, component)) ?? null;
}

async function rollback(projectRoot: string, installer: PrimitiveInstaller, done: ComponentRef[]): Promise<void> {
  for (const component of [...done].reverse()) {
    try {
      await installer.remove(projectRoot, component);
    } catch {
      // rollback cannot mask the original failure
    }
  }
}
