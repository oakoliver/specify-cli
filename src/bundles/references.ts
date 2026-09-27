/**
 * @oakoliver/specify-cli - Bundle reference resolution
 *
 * Resolve bundle component references against real, available components.
 * Used by ``specify bundle validate`` to confirm that every declared component
 * points at something installable. Resolution is offline-first: a reference
 * resolves when the component is bundled with Spec Kit or already installed;
 * catalogs are consulted only when network access is permitted. Offline runs
 * that cannot confirm a reference downgrade to a warning.
 *
 * Port of ``specify_cli/bundles/references.py``.
 *
 * @module bundles/references
 */

import type { ComponentRef } from './manifest.js';
import { primitiveDeps } from './primitives.js';
import type { ReferenceChecker } from './validator.js';

async function resolvedLocally(root: string, component: ComponentRef): Promise<boolean> {
  const kind = component.kind;
  try {
    if (kind === 'presets') {
      if ((await primitiveDeps.locateBundledPreset(component.id)) !== null) return true;
      const pack = await (await primitiveDeps.presetManager(root)).getPack(component.id);
      return pack !== null && pack !== undefined;
    }
    if (kind === 'extensions') {
      if ((await primitiveDeps.locateBundledExtension(component.id)) !== null) return true;
      return Boolean(await (await primitiveDeps.extensionManager(root)).registry.isInstalled(component.id));
    }
    if (kind === 'workflows') {
      if ((await primitiveDeps.locateBundledWorkflow(component.id)) !== null) return true;
      return (await primitiveDeps.workflowRegistry(root)).isInstalled(component.id);
    }
    if (kind === 'steps') {
      // Built-in step types (shell, gate, if, ...) ship with Spec Kit rather
      // than as on-disk assets; BUILTIN_STEP_TYPES is the bundled check
      // (deliberately not the process-global STEP_REGISTRY, which also holds
      // project-installed custom steps).
      if ((await primitiveDeps.builtinStepTypes()).has(component.id)) return true;
      return (await primitiveDeps.stepRegistry(root)).isInstalled(component.id);
    }
  } catch {
    return false; // resolution is best-effort
  }
  return false;
}

/** Return true/false if a catalog could be consulted, or null on failure. */
async function resolvedInCatalog(root: string, component: ComponentRef): Promise<boolean | null> {
  const kind = component.kind;
  try {
    if (kind === 'presets') {
      const info = await (await primitiveDeps.presetCatalog(root)).getPackInfo(component.id);
      return info !== null && info !== undefined;
    }
    if (kind === 'extensions') {
      const info = await (await primitiveDeps.extensionCatalog(root)).getExtensionInfo(component.id);
      return info !== null && info !== undefined;
    }
    if (kind === 'workflows') {
      const info = await primitiveDeps.workflowCatalogInfo(root, component.id);
      return info !== null && info !== undefined;
    }
    if (kind === 'steps') {
      const info = await primitiveDeps.stepCatalogInfo(root, component.id);
      return info !== null && info !== undefined;
    }
  } catch {
    return null; // catalog may be unreachable/misconfigured
  }
  return null;
}

/**
 * Build a {@link ReferenceChecker} for ``validateManifest``. Returns an error
 * string for a definitively unresolvable reference, null otherwise.
 * Unverifiable references (offline, or an unreachable catalog) append a note
 * to *warnings* and pass.
 */
export function makeReferenceChecker(
  projectRoot: string,
  opts: { allowNetwork: boolean; warnings: string[] },
): ReferenceChecker {
  const { allowNetwork, warnings } = opts;
  return async (component: ComponentRef): Promise<string | null> => {
    if (await resolvedLocally(projectRoot, component)) return null;
    const singular = component.kind.slice(0, -1);

    if (allowNetwork) {
      const inCatalog = await resolvedInCatalog(projectRoot, component);
      if (inCatalog === true) return null;
      if (inCatalog === false) {
        return `${singular} '${component.id}' is not bundled, installed, or present in any active catalog.`;
      }
      warnings.push(`Could not verify ${singular} '${component.id}' (catalog unreachable); reference left unchecked.`);
      return null;
    }

    warnings.push(
      `Could not verify ${singular} '${component.id}' offline ` +
        '(not bundled or installed); re-run validate online to check catalogs.',
    );
    return null;
  };
}
