/**
 * @oakoliver/specify-cli - Bundle reference resolution
 *
 * Resolve bundle component references against real, available components.
 * Used by ``specify bundle validate`` to confirm that every declared component
 * points at something installable. Resolution is offline-first: a reference
 * resolves when the component is bundled with Spec Kit or already installed
 * (at the pinned version); catalogs are consulted only when network access is
 * permitted. Offline runs that cannot confirm a reference downgrade to a
 * warning, while definitively-unknown references always error.
 *
 * Port of ``specify_cli/bundles/references.py`` (spec-kit v1.2.5).
 *
 * @module bundles/references
 */

import * as path from 'node:path';

import { isHttpsOrLocalhostHttp } from '../download-security.js';
import { BundlerError } from './index.js';
import type { ComponentRef } from './manifest.js';
import {
  CatalogUnavailable,
  selectCatalogRelease,
  winningCatalogEntry,
  type ComponentCatalogLike,
} from './component-catalog.js';
import {
  bundledComponentVersion,
  bundledManifestVersion,
  bundledPinWarning,
  primitiveDeps,
  primitiveManager,
} from './primitives.js';
import { isNewerPatch, sameVersion } from './versioning.js';
import { isMapping } from './pycompat.js';
import type { ReferenceChecker } from './validator.js';
import { validateChecksums as validateStepCatalogChecksums } from '../workflows/step/catalog/versions.js';

type Dict = Record<string, unknown>;

function matchesPin(component: ComponentRef, actual: string | null | undefined): boolean {
  return component.version === null || (Boolean(actual) && sameVersion(actual as string, component.version));
}

async function resolvedLocally(root: string, component: ComponentRef): Promise<boolean> {
  const kind = component.kind;
  try {
    if (component.source) return false;
    if (kind === 'presets') {
      const bundled = await primitiveDeps.locateBundledPreset(component.id);
      if (bundled !== null && matchesPin(component, bundledManifestVersion(path.join(bundled, 'preset.yml'), 'preset'))) {
        return true;
      }
    }
    if (kind === 'extensions') {
      const bundled = await primitiveDeps.locateBundledExtension(component.id);
      if (
        bundled !== null &&
        matchesPin(component, bundledManifestVersion(path.join(bundled, 'extension.yml'), 'extension'))
      ) {
        return true;
      }
    }
    if (kind === 'workflows') {
      const bundled = await primitiveDeps.locateBundledWorkflow(component.id);
      if (
        bundled !== null &&
        matchesPin(component, bundledManifestVersion(path.join(bundled, 'workflow.yml'), 'workflow'))
      ) {
        return true;
      }
    }
    if (kind === 'steps') {
      // Built-in step types (shell, gate, if, ...) ship with Spec Kit rather
      // than as on-disk assets; BUILTIN_STEP_TYPES is the bundled check
      // (deliberately not the process-global STEP_REGISTRY, which also holds
      // project-installed custom steps).
      if ((await primitiveDeps.builtinStepTypes()).has(component.id) && component.version === null) return true;
    }
    const manager = primitiveManager(kind, root, { allowNetwork: false });
    return (await manager.isInstalled(component)) && matchesPin(component, await manager.installedVersion(component));
  } catch {
    return false; // resolution is best-effort
  }
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const WORKFLOW_SHA256 = /^(?:sha256:)?[0-9a-fA-F]{64}$/i;
const STEP_DIGEST = /^[0-9a-fA-F]{64}$/;

/** Reject a selected pinned release whose install metadata is unusable. */
export function validatePinnedInstallMetadata(component: ComponentRef, selected: Dict): void {
  const requireUrl = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || !isHttpsOrLocalhostHttp(value)) {
      throw new BundlerError(
        `${component.kind.slice(0, -1)} '${component.id}' has an invalid ${label} ` +
          `for pinned version ${component.version}.`,
      );
    }
    return value;
  };

  if (component.kind === 'extensions' || component.kind === 'presets') {
    requireUrl(selected.download_url, 'download URL');
    const digest = selected.sha256;
    if (digest !== null && digest !== undefined) {
      let value = String(digest).trim();
      if (value.slice(0, 7).toLowerCase() === 'sha256:') value = value.slice(7).trim();
      if (!SHA256_HEX_RE.test(value.toLowerCase())) {
        throw new BundlerError(
          `${component.kind.slice(0, -1)} '${component.id}' has an invalid SHA-256 ` +
            `digest for pinned version ${component.version}.`,
        );
      }
    }
    return;
  }

  if (component.kind === 'workflows') {
    requireUrl(selected.url, 'install URL');
    const digest = selected.sha256;
    if (digest !== null && digest !== undefined && (typeof digest !== 'string' || !WORKFLOW_SHA256.test(digest))) {
      throw new BundlerError(
        `workflow '${component.id}' has an invalid SHA-256 digest ` + `for pinned version ${component.version}.`,
      );
    }
    if ('requires' in selected && !isMapping(selected.requires)) {
      throw new BundlerError(
        `workflow '${component.id}' has invalid requirements ` + `for pinned version ${component.version}.`,
      );
    }
    return;
  }

  referenceDeps.validateStepChecksums(selected, component.id);
  const stepUrl = requireUrl(selected.step_yml_url || selected.url, 'step.yml URL');
  const initUrl = selected.init_url;
  if (initUrl === null || initUrl === undefined) {
    if (!stepUrl.endsWith('step.yml')) {
      throw new BundlerError(
        `step '${component.id}' has no __init__.py URL ` + `for pinned version ${component.version}.`,
      );
    }
  } else {
    requireUrl(initUrl, '__init__.py URL');
  }
  const extra = isMapping(selected.extra_files) ? selected.extra_files : {};
  for (const url of Object.values(extra)) requireUrl(url, 'extra file URL');
}

/** Injectable seams (tests and integrator wiring). */
export const referenceDeps = {
  validateStepChecksums(entry: Dict, stepId: string): void {
    validateStepCatalogChecksums(entry, stepId, { required: true });
  },
  async catalogFor(kind: string, root: string): Promise<ComponentCatalogLike | null> {
    if (kind === 'presets') return (await primitiveDeps.presetCatalog(root)) as unknown as ComponentCatalogLike;
    if (kind === 'extensions') return (await primitiveDeps.extensionCatalog(root)) as unknown as ComponentCatalogLike;
    if (kind === 'workflows') return primitiveDeps.workflowCatalog(root);
    if (kind === 'steps') return primitiveDeps.stepCatalog(root);
    return null;
  },
};

async function catalogHasRelease(component: ComponentRef, catalog: ComponentCatalogLike): Promise<boolean> {
  const current = await winningCatalogEntry(catalog, component);
  if (current === null || !(current._install_allowed ?? true)) return false;
  if (component.source && current._catalog_name !== component.source) return false;
  if (component.version === null) return true;
  if ((component.kind === 'extensions' || component.kind === 'presets') && !current.version) {
    // These legacy catalogs cannot attest a version; the primitive installer
    // likewise accepts their unversioned current entry.
    return true;
  }
  const selected = selectCatalogRelease(component, current);
  if (
    selected === null ||
    selected._catalog_name !== current._catalog_name ||
    !(selected._install_allowed ?? true) ||
    !matchesPin(component, selected.version as string | null | undefined)
  ) {
    return false;
  }
  validatePinnedInstallMetadata(component, selected);
  return true;
}

const CATALOG_ERROR_NAMES = new Set([
  'ExtensionError',
  'PresetError',
  'WorkflowCatalogError',
  'StepCatalogError',
  'ValidationError',
  'PresetValidationError',
  'WorkflowValidationError',
]);

function isTransport(exc: unknown): boolean {
  const name = (exc as { name?: string } | null)?.name ?? '';
  const code = (exc as { code?: unknown } | null)?.code;
  return (
    name === 'TimeoutError' ||
    name === 'ConnectionError' ||
    (typeof code === 'string' && /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)/.test(code))
  );
}

/** Return the lookup result, a validation error, or null if unreachable. */
export async function resolvedInCatalog(root: string, component: ComponentRef): Promise<boolean | string | null> {
  try {
    const catalog = await referenceDeps.catalogFor(component.kind, root);
    if (catalog === null) return null;
    return await catalogHasRelease(component, catalog);
  } catch (exc) {
    if (exc instanceof CatalogUnavailable) return null;
    if (isTransport(exc)) return null;
    const name = (exc as { name?: string } | null)?.name ?? '';
    if (exc instanceof BundlerError || CATALOG_ERROR_NAMES.has(name)) {
      return `Catalog lookup failed: ${(exc as Error).message}`;
    }
    throw exc;
  }
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

    if (
      (component.kind === 'presets' || component.kind === 'extensions' || component.kind === 'workflows') &&
      component.source === null
    ) {
      const actual = await bundledComponentVersion(component);
      if (
        actual !== null &&
        (component.kind !== 'workflows' || (component.version && isNewerPatch(actual, component.version)))
      ) {
        let warning;
        try {
          warning = bundledPinWarning(singular.charAt(0).toUpperCase() + singular.slice(1), component, actual);
        } catch (exc) {
          if (exc instanceof BundlerError) return exc.message;
          throw exc;
        }
        if (warning) {
          warnings.push(warning.message);
          return null;
        }
      }
    }

    if (allowNetwork) {
      const inCatalog = await resolvedInCatalog(projectRoot, component);
      if (inCatalog === true) return null;
      if (inCatalog === false) {
        return (
          `${singular} '${component.id}' at ` +
          `${component.version || 'current'} is not available ` +
          'locally or from the selected install-allowed catalog.'
        );
      }
      if (typeof inCatalog === 'string') return inCatalog;
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
