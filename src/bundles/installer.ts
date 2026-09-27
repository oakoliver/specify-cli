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
 * Port of ``specify_cli/bundles/installer.py``.
 *
 * @module bundles/installer
 */

import { BundlerError } from './index.js';
import type { BundleManifest, ComponentRef } from './manifest.js';
import {
  InstalledBundleRecord,
  componentKey,
  componentsStillNeeded,
  findRecord,
  loadRecords,
  removeRecord,
  saveRecords,
  upsertRecord,
} from './records.js';
import { detectConflicts } from './conflict.js';
import type { InstallPlan } from './resolver.js';

// ============================================================================
// Types
// ============================================================================

type MaybePromise<T> = T | Promise<T>;

/** Adapter over the existing Spec Kit primitive install/remove machinery. */
export interface PrimitiveInstaller {
  isInstalled(projectRoot: string, component: ComponentRef): MaybePromise<boolean>;
  install(projectRoot: string, component: ComponentRef): MaybePromise<void>;
  remove(projectRoot: string, component: ComponentRef): MaybePromise<void>;
  /** Optional refresh hook (falls back to ``install``). */
  refresh?(projectRoot: string, component: ComponentRef): MaybePromise<void>;
}

export class InstallResult {
  installed: ComponentRef[] = [];
  skipped: ComponentRef[] = [];
  refreshed: ComponentRef[] = [];
  uninstalled: ComponentRef[] = [];

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

// ============================================================================
// Install / remove
// ============================================================================

/**
 * Execute *plan*, recording provenance. Idempotent, with bounded rollback.
 *
 * On failure only the components newly installed during *this* call are
 * rolled back, and the provenance record is written solely on full success.
 * When *refresh* is true (``specify bundle update``), already-installed owned
 * components are re-applied, and components the bundle used to own that the
 * new manifest drops are uninstalled (unless another bundle still needs them).
 * Changes to a recorded bundle's version or owned components are rejected
 * unless *refresh* is true.
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
    const report = detectConflicts(manifest, plan.effective_integration, records);
    if (report.hasBlockingConflict) throw new BundlerError(report.integration_clash!);
  }

  const result = new InstallResult(plan.bundle_id);
  const existing = findRecord(records, plan.bundle_id);
  if (existing !== null && !refresh) {
    const planned = new Set(plan.components.map((c) => c.identity()));
    const subset = existing.contributed_components.every((c) => planned.has(c.identity()));
    if (existing.version !== plan.version || !subset) {
      throw new BundlerError(
        `Bundle '${plan.bundle_id}' is already installed at version ` +
          `${existing.version}, but the requested manifest changes the bundle ` +
          'version or changes/removes owned components. ' +
          "Use 'specify bundle update <id>' for a catalog bundle, or " +
          "'specify bundle install <path> --refresh' for a local source, " +
          'to refresh owned components before advancing the installed record.',
      );
    }
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

  const contributed: ComponentRef[] = [];
  const done: ComponentRef[] = [];
  try {
    for (const component of plan.components) {
      const key = componentKey(component.kind, component.id);
      if (await installer.isInstalled(projectRoot, component)) {
        const owned = priorOurs.has(key) || otherTracked.has(key);
        if (refresh && owned) {
          await refreshComponent(projectRoot, installer, component);
          result.refreshed.push(component);
        } else {
          result.skipped.push(component);
        }
        if (owned) contributed.push(component);
        continue;
      }
      await installer.install(projectRoot, component);
      done.push(component);
      result.installed.push(component);
      contributed.push(component);
    }

    // On update (refresh), uninstall components this bundle used to own that
    // the new version no longer ships (otherwise they would be orphaned).
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
  );
  saveRecords(projectRoot, upsertRecord(records, record));
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
    saveRecords(projectRoot, removeRecord(records, bundleId));
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

/**
 * Re-apply an already-installed component to bring it up to its pinned
 * version. Prefers a primitive-provided ``refresh`` hook when available.
 */
async function refreshComponent(
  projectRoot: string,
  installer: PrimitiveInstaller,
  component: ComponentRef,
): Promise<void> {
  if (typeof installer.refresh === 'function') {
    await installer.refresh(projectRoot, component);
  } else {
    await installer.install(projectRoot, component);
  }
}

async function rollback(projectRoot: string, installer: PrimitiveInstaller, done: ComponentRef[]): Promise<void> {
  for (const component of [...done].reverse()) {
    try {
      await installer.remove(projectRoot, component);
    } catch {
      // best-effort rollback
    }
  }
}
