/**
 * @oakoliver/specify-cli - Bundle primitive bridge
 *
 * Bridge from bundler component kinds to existing primitive managers. The
 * bundler does not own install logic; it routes each component to the existing
 * Spec Kit primitive machinery so a bundle install behaves exactly as a
 * sequence of ``specify <primitive> add`` calls would.
 *
 * Routing strategy per kind:
 *
 * - **presets** / **extensions** — wired through their reusable managers
 *   (``installFromDirectory`` / ``installFromZip``). Bundled assets shipped
 *   with Spec Kit install fully offline; catalog assets are fetched only when
 *   network access is permitted.
 * - **workflows** / **steps** — their install/remove orchestration lives in the
 *   CLI command layer, so the bundler delegates to those existing commands
 *   in-process (with the project root as the working directory).
 *
 * Every dependency on another domain is reached through {@link primitiveDeps}
 * so tests can inject fakes (mirrors upstream's monkeypatch seams).
 *
 * Port of ``specify_cli/bundles/primitives.py``.
 *
 * @module bundles/primitives
 */

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { parseYaml } from '../yaml.js';
import { BundlerError } from './index.js';
import type { ComponentRef } from './manifest.js';
import { isNewerPatch, sameVersion } from './versioning.js';
import { isMapping, pyTruthy } from './pycompat.js';
import { readTextUtf8 } from './yamlio.js';
import { validateStepId as validateInstallerStepId } from '../workflows/step/installer.js';
import { selectCatalogRelease, winningCatalogEntry, type ComponentCatalogLike } from './component-catalog.js';

export const DEFAULT_PRIORITY = 10;

// ============================================================================
// Bundled patch warnings
// ============================================================================

export interface BundledPatchDetails {
  readonly kind: string;
  readonly component_id: string;
  readonly requested_version: string;
  readonly installed_version: string;
}

/** A newer packaged patch was used in place of a bundle pin. */
export class BundledPatchWarning {
  readonly code = 'bundled_patch_upgrade' as const;
  constructor(
    readonly message: string,
    readonly details: BundledPatchDetails,
  ) {
    Object.freeze(this);
  }
}

// ============================================================================
// Dependency seams
// ============================================================================

type MaybePromise<T> = T | Promise<T>;
type Info = Record<string, unknown> | null | undefined;

/** Shape of the preset manager the bundler relies on. */
export interface PresetManagerLike {
  registry?: { get(packId: string): unknown };
  getPack(packId: string): MaybePromise<unknown>;
  installFromDirectory(
    sourceDir: string,
    speckitVersion: string,
    priority: number,
    opts?: { force?: boolean; catalogName?: string | null },
  ): MaybePromise<unknown>;
  installFromZip(
    zipPath: string,
    speckitVersion: string,
    priority: number,
    opts?: {
      force?: boolean;
      catalogName?: string | null;
      expectedId?: string;
      expectedVersion?: string;
    },
  ): MaybePromise<unknown>;
  remove(packId: string): MaybePromise<unknown>;
}

export interface PresetCatalogLike extends Partial<ComponentCatalogLike> {
  getPackInfo(packId: string): MaybePromise<Info>;
  downloadPack(packId: string): MaybePromise<string>;
  /** Download the exact (already selected) catalog release. */
  downloadPackInfo?(info: Record<string, unknown>): MaybePromise<string>;
}

/** Shape of the extension manager the bundler relies on. */
export interface ExtensionManagerLike {
  registry: { isInstalled(extensionId: string): MaybePromise<boolean>; get?(extensionId: string): unknown };
  installFromDirectory(
    sourceDir: string,
    speckitVersion: string,
    opts?: { priority?: number; force?: boolean },
  ): MaybePromise<{ id: string }>;
  installFromZip(
    zipPath: string,
    speckitVersion: string,
    opts?: {
      priority?: number;
      force?: boolean;
      catalogName?: string | null;
      expectedId?: string;
      expectedVersion?: string;
    },
  ): MaybePromise<{ id: string }>;
  scaffoldConfig(extensionId: string): MaybePromise<unknown>;
  remove(extensionId: string): MaybePromise<unknown>;
}

export interface ExtensionCatalogLike extends Partial<ComponentCatalogLike> {
  getExtensionInfo(extensionId: string): MaybePromise<Info>;
  downloadExtension(extensionId: string): MaybePromise<string>;
  /** Download the exact (already selected) catalog release. */
  downloadExtensionInfo?(info: Record<string, unknown>): MaybePromise<string>;
}

export interface RegistryLike {
  isInstalled(id: string): boolean;
  get(id: string): unknown;
  save(): void;
  data: { steps?: Record<string, unknown> } & Record<string, unknown>;
  stepsDir?: string;
}

/** Injectable dependencies (tests replace entries). */
export const primitiveDeps = {
  async getSpeckitVersion(): Promise<string> {
    const mod = await import('../assets.js');
    return mod.getSpeckitVersion();
  },
  async locateBundledPreset(id: string): Promise<string | null> {
    const mod = await import('../assets.js');
    return (mod.locateBundledPreset(id) as string | null) ?? null;
  },
  async locateBundledExtension(id: string): Promise<string | null> {
    const mod = await import('../assets.js');
    return (mod.locateBundledExtension(id) as string | null) ?? null;
  },
  async locateBundledWorkflow(id: string): Promise<string | null> {
    const mod = await import('../assets.js');
    return (mod.locateBundledWorkflow(id) as string | null) ?? null;
  },
  async presetManager(root: string): Promise<PresetManagerLike> {
    const mod = await import('../presets/index.js');
    return new mod.PresetManager(root);
  },
  async presetCatalog(root: string): Promise<PresetCatalogLike> {
    const mod = await import('../presets/index.js');
    return new mod.PresetCatalog(root);
  },
  async extensionManager(root: string): Promise<ExtensionManagerLike> {
    const mod = await import('../extensions/index.js');
    return new mod.ExtensionManager(root);
  },
  async extensionCatalog(root: string): Promise<ExtensionCatalogLike> {
    const mod = await import('../extensions/index.js');
    return new mod.ExtensionCatalog(root);
  },
  async workflowRegistry(root: string): Promise<RegistryLike> {
    const mod = await import('../workflows/catalog/domain.js');
    return new mod.WorkflowRegistry(root);
  },
  async stepRegistry(root: string): Promise<RegistryLike> {
    const mod = await import('../workflows/step/catalog/domain.js');
    return new mod.StepRegistry(root);
  },
  async builtinStepTypes(): Promise<ReadonlySet<string>> {
    const mod = await import('../workflows/index.js');
    return new Set(mod.BUILTIN_STEP_TYPES as Iterable<string>);
  },
  /** ``WorkflowDefinition.from_yaml(path)`` -> ``{id, version}``. */
  async loadWorkflowDefinition(file: string): Promise<{ id: unknown; version: unknown }> {
    const mod = await import('../workflows/engine.js');
    return mod.WorkflowDefinition.fromYaml(file) as unknown as { id: unknown; version: unknown };
  },
  /**
   * ``workflow_add(source, dev=..., from_url=None)`` — every option passed
   * explicitly. Throws ``CliExit`` on failure.
   */
  async workflowAdd(source: string, opts: { dev: boolean; fromUrl: string | null }): Promise<number | void> {
    const mod = await import('../workflows/command-add.js');
    return mod.workflowAdd({ source, dev: opts.dev, fromUrl: opts.fromUrl });
  },
  async workflowRemove(id: string): Promise<number | void> {
    const mod = await import('../workflows/commands.js');
    return mod.workflowRemove(id);
  },
  async workflowStepAdd(id: string): Promise<number | void> {
    const mod = await import('../workflows/step/commands.js');
    return mod.workflowStepAdd(id);
  },
  async workflowStepRemove(id: string): Promise<number | void> {
    const mod = await import('../workflows/step/commands.js');
    return mod.workflowStepRemove(id);
  },
  async workflowCatalog(root: string): Promise<ComponentCatalogLike> {
    const mod = await import('../workflows/catalog/domain.js');
    return new mod.WorkflowCatalog(root) as unknown as ComponentCatalogLike;
  },
  async stepCatalog(root: string): Promise<ComponentCatalogLike> {
    const mod = await import('../workflows/step/catalog/domain.js');
    return new mod.StepCatalog(root) as unknown as ComponentCatalogLike;
  },
  /**
   * ``workflows.command_add._install_preselected_workflow``. ADAPTATION: until
   * the workflows domain exports it, fall back to ``workflow add <id>`` (which
   * installs the winning entry's current release).
   */
  async installPreselectedWorkflow(
    id: string,
    opts: { version: string | null; selectedInfo: Record<string, unknown> },
  ): Promise<number | void> {
    const mod = (await import('../workflows/command-add.js')) as Record<string, unknown>;
    const fn = mod.installPreselectedWorkflow as
      | ((id: string, o: { version: string | null; selectedInfo: Record<string, unknown> }) => Promise<number | void>)
      | undefined;
    if (typeof fn === 'function') return fn(id, opts);
    return primitiveDeps.workflowAdd(id, { dev: false, fromUrl: null });
  },
  /**
   * ``workflows.step.command_add._install_preselected_step``. ADAPTATION: falls
   * back to ``workflow step add <id>`` until the step domain exports it.
   */
  async installPreselectedStep(
    id: string,
    opts: { version: string | null; selectedInfo: Record<string, unknown> },
  ): Promise<number | void> {
    const mod = (await import('../workflows/step/commands.js')) as Record<string, unknown>;
    const fn = mod.installPreselectedStep as
      | ((id: string, o: { version: string | null; selectedInfo: Record<string, unknown> }) => Promise<number | void>)
      | undefined;
    if (typeof fn === 'function') return fn(id, opts);
    return primitiveDeps.workflowStepAdd(id);
  },
  /** ``workflows.step.installer.validate_step_id`` (throws ``StepInstallError`` on an unsafe id). */
  validateStepId(stepId: string): void {
    validateInstallerStepId(stepId);
  },
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Refuse to install when the resolved version differs from the manifest pin.
 * When the source advertises no version the pin cannot be enforced, so
 * installation proceeds.
 */
export function assertPinnedVersion(
  kind: string,
  componentId: string,
  pinned: string | null | undefined,
  advertised: unknown,
): void {
  if (!pinned || advertised === null || advertised === undefined) return;
  const actual = String(advertised).trim();
  if (!actual) return;
  if (!sameVersion(actual, pinned)) {
    throw new BundlerError(
      `${kind} '${componentId}' is pinned to version ${pinned} in the bundle ` +
        `manifest, but the resolved version is ${actual}. Update the bundle's ` +
        'pinned version or the source before installing.',
    );
  }
}

type ReleaseSelector = (info: Record<string, unknown>, pinned: string) => Record<string, unknown> | null;

/**
 * Select the catalog release a bundle pin names. Returns the selected release
 * record and the version the archive must declare (null when the pin cannot
 * be enforced). Selection stays within the winning catalog entry.
 */
export function selectPinnedRelease(
  kind: string,
  component: ComponentRef,
  info: Record<string, unknown>,
  selectRelease: ReleaseSelector,
): [Record<string, unknown>, string | null] {
  assertCatalogSource(kind, component, info);
  const pinned = component.version;
  const advertised = info.version;
  if (!pinned || advertised === null || advertised === undefined || !String(advertised).trim()) return [info, null];
  const selected = selectRelease(info, pinned);
  if (selected === null) {
    throw new BundlerError(
      `${kind} '${component.id}' is pinned to version ${pinned} in the bundle ` +
        `manifest, but its catalog has no release for that version (it ` +
        `advertises ${String(advertised).trim()}). Update the bundle's pinned ` +
        'version or the catalog before installing.',
    );
  }
  return [selected, selected.version as string];
}

/** A source identifies the winning catalog; it cannot select another one. */
export function assertCatalogSource(kind: string, component: ComponentRef, info: Record<string, unknown>): void {
  if (component.source && component.source !== info._catalog_name) {
    throw new BundlerError(
      `${kind} '${component.id}' requests catalog '${component.source}', ` +
        `but its highest-priority source is ` +
        `'${info._catalog_name ?? '<unknown>'}'. ` +
        'A bundle source cannot bypass catalog precedence.',
    );
  }
  if (!pyTruthy(info._install_allowed ?? true)) {
    throw new BundlerError(`${kind} '${component.id}' is from a discovery-only catalog; installation is not allowed.`);
  }
}

/** Resolve an exact workflow/step release within the winning catalog. */
export async function selectedCatalogInfo(
  kind: string,
  component: ComponentRef,
  catalog: ComponentCatalogLike,
): Promise<Record<string, unknown>> {
  const current = await winningCatalogEntry(catalog, component);
  if (current === null) throw new BundlerError(`${kind} '${component.id}' not found in any catalog.`);
  assertCatalogSource(kind, component, current);
  if (component.version === null) return current;
  const selected = selectCatalogRelease(component, current);
  if (selected === null) {
    throw new BundlerError(
      `${kind} '${component.id}' has no catalog release for pinned version ` +
        `${component.version} in the highest-priority source.`,
    );
  }
  if (selected._catalog_name !== current._catalog_name) {
    throw new BundlerError(`${kind} '${component.id}' changed catalog sources during version lookup.`);
  }
  assertCatalogSource(kind, component, selected);
  if (!selected.version || !sameVersion(String(selected.version), component.version)) {
    throw new BundlerError(
      `${kind} '${component.id}' has no verifiable catalog release for ` + `pinned version ${component.version}.`,
    );
  }
  return selected;
}

/** Allow packaged stable patch upgrades without weakening catalog pins. */
export function bundledPinWarning(
  kind: string,
  component: ComponentRef,
  advertised: unknown,
): BundledPatchWarning | null {
  if (
    component.source === null &&
    component.version &&
    typeof advertised === 'string' &&
    isNewerPatch(advertised.trim(), component.version)
  ) {
    return new BundledPatchWarning(
      `${kind} '${component.id}' is pinned to version ${component.version}, ` +
        `but Spec Kit ships ${advertised.trim()}; using the newer packaged patch. ` +
        'Bundle installation records the actual installed version ' +
        'alongside the requested pin.',
      {
        kind: component.kind,
        component_id: component.id,
        requested_version: component.version,
        installed_version: advertised.trim(),
      },
    );
  }
  assertPinnedVersion(kind, component.id, component.version, advertised);
  return null;
}

/**
 * Best-effort read of a bundled asset's declared version from its manifest.
 * Returns null when missing/unreadable/invalid ("cannot enforce").
 */
export function bundledManifestVersion(manifestPath: string, rootKey: string): string | null {
  try {
    const data = parseYaml(readTextUtf8(manifestPath));
    if (isMapping(data)) {
      const section = data[rootKey];
      if (isMapping(section)) {
        const version = section.version;
        if (typeof version === 'string' && version.trim()) return version;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Version of the asset Spec Kit packages for *component* (null if none). */
export async function bundledComponentVersion(component: ComponentRef): Promise<string | null> {
  if (component.source !== null) return null;
  const locate: Record<string, (id: string) => Promise<string | null>> = {
    extensions: (id) => primitiveDeps.locateBundledExtension(id),
    presets: (id) => primitiveDeps.locateBundledPreset(id),
    workflows: (id) => primitiveDeps.locateBundledWorkflow(id),
  };
  const fn = locate[component.kind];
  if (fn === undefined) return null;
  const bundled = await fn(component.id);
  if (bundled === null) return null;
  const kind = component.kind.slice(0, -1);
  return bundledManifestVersion(path.join(bundled, `${kind}.yml`), kind);
}

/**
 * Version a primitive registry recorded for an installed component, or null
 * when there is no entry, the registry is unreadable, or the entry has no
 * usable version.
 */
export async function registryVersion(
  registry: { get?(id: string): unknown } | null | undefined,
  componentId: string,
): Promise<string | null> {
  let entry: unknown;
  try {
    if (!registry || typeof registry.get !== 'function') return null;
    entry = await registry.get(componentId);
  } catch {
    return null;
  }
  const version = isMapping(entry) ? entry.version : null;
  return typeof version === 'string' && version.trim() ? version : null;
}

/** Temporarily switch the working directory while running *fn*. */
async function withChdir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

function exitCodeOf(exc: unknown): number | null {
  if (exc && typeof exc === 'object') {
    const e = exc as { name?: string; code?: unknown; exitCode?: unknown };
    if (e.name === 'CliExit' || e.constructor?.name === 'CliExit') {
      const code = typeof e.code === 'number' ? e.code : typeof e.exitCode === 'number' ? e.exitCode : 1;
      return code;
    }
  }
  return null;
}

/** Run a delegated CLI command, translating its exit into errors. */
async function delegateCommand(action: string, label: string, call: () => Promise<number | void>): Promise<void> {
  let code: number | void;
  try {
    code = await call();
  } catch (exc) {
    const exitCode = exitCodeOf(exc);
    if (exitCode === null) throw exc;
    code = exitCode;
  }
  if (typeof code === 'number' && code !== 0) {
    throw new BundlerError(`Failed to ${action} ${label}.`);
  }
}

// ============================================================================
// Kind managers
// ============================================================================

export interface KindManager {
  isInstalled(component: ComponentRef): Promise<boolean>;
  installedVersion(component: ComponentRef): Promise<string | null>;
  install(component: ComponentRef): Promise<BundledPatchWarning | null>;
  refresh(component: ComponentRef): Promise<BundledPatchWarning | null>;
  remove(component: ComponentRef): Promise<void>;
}

export function primitiveManager(
  kind: string,
  projectRoot: string,
  opts: { allowNetwork?: boolean } = {},
): KindManager {
  const allowNetwork = opts.allowNetwork ?? true;
  if (kind === 'presets') return new PresetKindManager(projectRoot, allowNetwork);
  if (kind === 'extensions') return new ExtensionKindManager(projectRoot, allowNetwork);
  if (kind === 'workflows') return new WorkflowKindManager(projectRoot, allowNetwork);
  if (kind === 'steps') return new StepKindManager(projectRoot, allowNetwork);
  throw new BundlerError(`Unknown component kind '${kind}'.`);
}

function errText(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

function safeUnlink(p: unknown): void {
  try {
    if (typeof p === 'string' && existsSync(p)) rmSync(p, { force: true });
  } catch {
    // suppress
  }
}

function expectedOpts(componentId: string, expectedVersion: string | null): { expectedId?: string; expectedVersion?: string } {
  return expectedVersion !== null ? { expectedId: componentId, expectedVersion } : {};
}

export class PresetKindManager implements KindManager {
  /** Injected manager (tests may set this directly). */
  _manager: PresetManagerLike | null = null;

  constructor(
    readonly root: string,
    readonly allowNetwork: boolean,
  ) {}

  private async manager(): Promise<PresetManagerLike> {
    if (this._manager === null) this._manager = await primitiveDeps.presetManager(this.root);
    return this._manager;
  }

  async isInstalled(component: ComponentRef): Promise<boolean> {
    try {
      const pack = await (await this.manager()).getPack(component.id);
      return pack !== null && pack !== undefined;
    } catch {
      return false;
    }
  }

  async installedVersion(component: ComponentRef): Promise<string | null> {
    return registryVersion((await this.manager()).registry, component.id);
  }

  install(component: ComponentRef): Promise<BundledPatchWarning | null> {
    return this.doInstall(component, false);
  }

  refresh(component: ComponentRef): Promise<BundledPatchWarning | null> {
    return this.doInstall(component, true);
  }

  private async doInstall(component: ComponentRef, force: boolean): Promise<BundledPatchWarning | null> {
    const speckitVersion = await primitiveDeps.getSpeckitVersion();
    const priority = component.priority === null ? DEFAULT_PRIORITY : component.priority;

    const bundled = await primitiveDeps.locateBundledPreset(component.id);
    if (bundled !== null && component.source === null) {
      const warning = bundledPinWarning(
        'Preset',
        component,
        bundledManifestVersion(path.join(bundled, 'preset.yml'), 'preset'),
      );
      const manager = await this.manager();
      await manager.installFromDirectory(bundled, speckitVersion, priority, ...(force ? [{ force: true }] : []));
      return warning;
    }

    if (!this.allowNetwork) {
      throw new BundlerError(
        `Preset '${component.id}' is not bundled and network access is ` +
          'disabled. Installing or refreshing this component requires ' +
          'network access; re-run without --offline.',
      );
    }

    const catalog = await primitiveDeps.presetCatalog(this.root);
    const winning = await resolveWinning(catalog, component, () => catalog.getPackInfo(component.id));
    if (!winning) throw new BundlerError(`Preset '${component.id}' not found in any catalog.`);
    const [info, expectedVersion] = selectPinnedRelease('Preset', component, winning, (entry, pinned) =>
      selectCatalogRelease(withVersion(component, pinned), entry),
    );
    const zipPath =
      typeof catalog.downloadPackInfo === 'function'
        ? await catalog.downloadPackInfo(info)
        : await catalog.downloadPack(component.id);
    try {
      const manager = await this.manager();
      await manager.installFromZip(zipPath, speckitVersion, priority, {
        catalogName: (info._catalog_name as string | undefined) ?? null,
        ...(force ? { force: true } : {}),
        ...expectedOpts(component.id, expectedVersion),
      });
    } finally {
      safeUnlink(zipPath);
    }
    return null;
  }

  async remove(component: ComponentRef): Promise<void> {
    try {
      await (await this.manager()).remove(component.id);
    } catch (exc) {
      throw new BundlerError(`Failed to remove preset '${component.id}': ${errText(exc)}`, { cause: exc });
    }
  }
}

export class ExtensionKindManager implements KindManager {
  _manager: ExtensionManagerLike | null = null;

  constructor(
    readonly root: string,
    readonly allowNetwork: boolean,
  ) {}

  private async manager(): Promise<ExtensionManagerLike> {
    if (this._manager === null) this._manager = await primitiveDeps.extensionManager(this.root);
    return this._manager;
  }

  async isInstalled(component: ComponentRef): Promise<boolean> {
    try {
      return Boolean(await (await this.manager()).registry.isInstalled(component.id));
    } catch {
      return false;
    }
  }

  async installedVersion(component: ComponentRef): Promise<string | null> {
    return registryVersion((await this.manager()).registry, component.id);
  }

  install(component: ComponentRef): Promise<BundledPatchWarning | null> {
    return this.doInstall(component, false);
  }

  refresh(component: ComponentRef): Promise<BundledPatchWarning | null> {
    return this.doInstall(component, true);
  }

  private async doInstall(component: ComponentRef, force: boolean): Promise<BundledPatchWarning | null> {
    const speckitVersion = await primitiveDeps.getSpeckitVersion();
    const priority = component.priority === null ? DEFAULT_PRIORITY : component.priority;

    const bundled = await primitiveDeps.locateBundledExtension(component.id);
    if (bundled !== null && component.source === null) {
      const warning = bundledPinWarning(
        'Extension',
        component,
        bundledManifestVersion(path.join(bundled, 'extension.yml'), 'extension'),
      );
      const manager = await this.manager();
      const manifest = await manager.installFromDirectory(bundled, speckitVersion, { priority, force });
      // Scaffold extension config exactly like `specify extension add` does.
      await manager.scaffoldConfig(manifest.id);
      return warning;
    }

    if (!this.allowNetwork) {
      throw new BundlerError(
        `Extension '${component.id}' is not bundled and network access is ` +
          'disabled. Installing or refreshing this component requires ' +
          'network access; re-run without --offline.',
      );
    }

    const catalog = await primitiveDeps.extensionCatalog(this.root);
    const winning = await resolveWinning(catalog, component, () => catalog.getExtensionInfo(component.id));
    if (!winning) throw new BundlerError(`Extension '${component.id}' not found in any catalog.`);
    const [info, expectedVersion] = selectPinnedRelease('Extension', component, winning, (entry, pinned) =>
      selectCatalogRelease(withVersion(component, pinned), entry),
    );
    const zipPath =
      typeof catalog.downloadExtensionInfo === 'function'
        ? await catalog.downloadExtensionInfo(info)
        : await catalog.downloadExtension(component.id);
    try {
      const manager = await this.manager();
      const manifest = await manager.installFromZip(zipPath, speckitVersion, {
        priority,
        force,
        catalogName: (info._catalog_name as string | undefined) ?? null,
        ...expectedOpts(component.id, expectedVersion),
      });
      await manager.scaffoldConfig(manifest.id);
    } finally {
      safeUnlink(zipPath);
    }
    return null;
  }

  async remove(component: ComponentRef): Promise<void> {
    try {
      await (await this.manager()).remove(component.id);
    } catch (exc) {
      throw new BundlerError(`Failed to remove extension '${component.id}': ${errText(exc)}`, { cause: exc });
    }
  }
}

/** A copy of *component* with ``version`` replaced (selection helper). */
function withVersion(component: ComponentRef, version: string): ComponentRef {
  return Object.assign(Object.create(Object.getPrototypeOf(component)), component, { version }) as ComponentRef;
}

/**
 * ``winning_catalog_entry(catalog, component)``. ADAPTATION: a catalog fake
 * without the source-ordered fetch API falls back to its public ID lookup.
 */
async function resolveWinning(
  catalog: Partial<ComponentCatalogLike>,
  component: ComponentRef,
  fallback: () => MaybePromise<Info>,
): Promise<Record<string, unknown> | null> {
  if (typeof catalog.getActiveCatalogs === 'function' && typeof catalog.fetchSingleCatalog === 'function') {
    return winningCatalogEntry(catalog as ComponentCatalogLike, component);
  }
  return ((await fallback()) as Record<string, unknown> | null | undefined) ?? null;
}

export class WorkflowKindManager implements KindManager {
  constructor(
    readonly root: string,
    readonly allowNetwork: boolean,
  ) {}

  async isInstalled(component: ComponentRef): Promise<boolean> {
    try {
      return (await primitiveDeps.workflowRegistry(this.root)).isInstalled(component.id);
    } catch {
      return false;
    }
  }

  async installedVersion(component: ComponentRef): Promise<string | null> {
    let registry: RegistryLike;
    try {
      registry = await primitiveDeps.workflowRegistry(this.root);
    } catch {
      return null;
    }
    return registryVersion(registry, component.id);
  }

  async install(component: ComponentRef): Promise<BundledPatchWarning | null> {
    const bundled = await primitiveDeps.locateBundledWorkflow(component.id);
    if (bundled !== null && component.source === null) {
      const workflowFile = path.join(bundled, 'workflow.yml');
      let definition: { id: unknown; version: unknown };
      try {
        definition = await primitiveDeps.loadWorkflowDefinition(workflowFile);
      } catch (exc) {
        if (exc instanceof BundlerError) throw exc;
        throw new BundlerError(`Failed to load bundled workflow '${component.id}': ${errText(exc)}`, {
          cause: exc,
        });
      }
      if (definition.id !== component.id) {
        throw new BundlerError(
          `Bundled workflow at ${workflowFile} declares ID ` + `'${String(definition.id)}', expected '${component.id}'.`,
        );
      }
      const defVersion = typeof definition.version === 'string' ? definition.version : definition.version == null ? '' : String(definition.version);
      if (
        component.version === null ||
        (defVersion && (sameVersion(defVersion, component.version) || isNewerPatch(defVersion, component.version)))
      ) {
        const warning = bundledPinWarning('Workflow', component, definition.version);
        await withChdir(this.root, () =>
          delegateCommand('install', `workflow '${component.id}'`, () =>
            primitiveDeps.workflowAdd(workflowFile, { dev: true, fromUrl: null }),
          ),
        );
        return warning;
      }
      if (!this.allowNetwork) {
        assertPinnedVersion('Workflow', component.id, component.version, definition.version);
      }
    }

    if (!this.allowNetwork) {
      throw new BundlerError(
        `Workflow '${component.id}' installs from a catalog and network ` +
          'access is disabled. Installing or refreshing this component ' +
          'requires network access; re-run without --offline.',
      );
    }
    const catalog = await primitiveDeps.workflowCatalog(this.root);
    const selected = await selectedCatalogInfo('Workflow', component, catalog);
    await withChdir(this.root, () =>
      delegateCommand('install', `workflow '${component.id}'`, () =>
        primitiveDeps.installPreselectedWorkflow(component.id, { version: component.version, selectedInfo: selected }),
      ),
    );
    return null;
  }

  refresh(component: ComponentRef): Promise<BundledPatchWarning | null> {
    // workflow add is idempotent for already-installed workflows.
    return this.install(component);
  }

  async remove(component: ComponentRef): Promise<void> {
    await withChdir(this.root, () =>
      delegateCommand('remove', `workflow '${component.id}'`, () => primitiveDeps.workflowRemove(component.id)),
    );
  }
}

export class StepKindManager implements KindManager {
  constructor(
    readonly root: string,
    readonly allowNetwork: boolean,
  ) {}

  async isInstalled(component: ComponentRef): Promise<boolean> {
    try {
      return (await primitiveDeps.stepRegistry(this.root)).isInstalled(component.id);
    } catch {
      return false;
    }
  }

  async installedVersion(component: ComponentRef): Promise<string | null> {
    let registry: RegistryLike;
    try {
      registry = await primitiveDeps.stepRegistry(this.root);
    } catch {
      return null;
    }
    return registryVersion(registry, component.id);
  }

  async install(component: ComponentRef): Promise<BundledPatchWarning | null> {
    if (!this.allowNetwork) {
      throw new BundlerError(
        `Step '${component.id}' installs from a catalog and network access ` +
          'is disabled. Installing or refreshing this component requires ' +
          'network access; re-run without --offline.',
      );
    }
    try {
      primitiveDeps.validateStepId(component.id);
    } catch (exc) {
      const detail = errText(exc);
      throw new BundlerError(`Invalid step '${component.id}': ${detail}`, { cause: exc });
    }
    let selected: Record<string, unknown>;
    try {
      const catalog = await primitiveDeps.stepCatalog(this.root);
      selected = await selectedCatalogInfo('Step', component, catalog);
    } catch (exc) {
      if (exc instanceof BundlerError) throw exc;
      if ((exc as { name?: string } | null)?.name === 'StepCatalogError') {
        throw new BundlerError(`Failed to resolve step '${component.id}': ${errText(exc)}`, { cause: exc });
      }
      throw exc;
    }
    await withChdir(this.root, async () => {
      try {
        await delegateCommand('install', `step '${component.id}'`, () =>
          primitiveDeps.installPreselectedStep(component.id, { version: component.version, selectedInfo: selected }),
        );
      } catch (exc) {
        if ((exc as { name?: string } | null)?.name === 'StepInstallError') {
          throw new BundlerError(`Failed to install step '${component.id}': ${errText(exc)}`, { cause: exc });
        }
        throw exc;
      }
    });
    return null;
  }

  /**
   * Refresh with rollback: only offline refresh skips the snapshot; online, a
   * step missing from the registry delegates to ``install``. A failed
   * reinstall restores the previous package and registry entry verbatim
   * (including a JSON null entry); a failed restore keeps the temporary backup
   * and records a note on the original error.
   *
   * ADAPTATION: upstream serializes the snapshot/removal and the restore under
   * the step install lock (``_step_install_transaction``) owned by the step
   * installer; this port performs the same sequence without that lock.
   */
  async refresh(component: ComponentRef): Promise<BundledPatchWarning | null> {
    if (!this.allowNetwork) return this.install(component);

    const registry = await primitiveDeps.stepRegistry(this.root);
    if (!registry.isInstalled(component.id)) return this.install(component);

    const stepsDir = registry.stepsDir ?? path.join(this.root, '.specify', 'workflows', 'steps');
    const stepDir = path.join(stepsDir, component.id);
    const metadata = structuredClone(registry.get(component.id) ?? null);
    const backupParent = mkdtempSync(path.join(tmpdir(), 'speckit-step-refresh-'));
    const backupDir = path.join(backupParent, component.id);
    let keepBackup = false;
    try {
      if (existsSync(stepDir)) cpSync(stepDir, backupDir, { recursive: true, verbatimSymlinks: true });
      try {
        await this.remove(component);
        await this.install(component);
      } catch (original) {
        if (original instanceof BundlerError) {
          try {
            // Re-read the registry: the snapshot above still contains the
            // entry that remove() deleted on disk.
            const current = await primitiveDeps.stepRegistry(this.root);
            if (!current.isInstalled(component.id)) {
              if (existsSync(stepDir)) rmSync(stepDir, { recursive: true, force: true });
              if (existsSync(backupDir)) cpSync(backupDir, stepDir, { recursive: true, verbatimSymlinks: true });
              // Insert the snapshot verbatim (not via add(), which would
              // re-stamp installed_at/updated_at).
              const steps = (current.data.steps ??= {});
              steps[component.id] = metadata;
              current.save();
            }
          } catch (restoreExc) {
            keepBackup = true;
            addNote(
              original,
              `Could not restore step '${component.id}' from backup '${backupParent}': ${errText(restoreExc)}`,
            );
          }
        }
        throw original;
      }
    } finally {
      if (!keepBackup) rmSync(backupParent, { recursive: true, force: true });
    }
    return null;
  }

  async remove(component: ComponentRef): Promise<void> {
    await withChdir(this.root, () =>
      delegateCommand('remove', `step '${component.id}'`, () => primitiveDeps.workflowStepRemove(component.id)),
    );
  }
}

/** Python ``BaseException.add_note`` (kept on a ``notes`` array). */
export function addNote(exc: unknown, note: string): void {
  if (exc && typeof exc === 'object') {
    const target = exc as { notes?: string[] };
    (target.notes ??= []).push(note);
  }
}
