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
import { parseVersion } from './versioning.js';
import { isMapping, pyTruthy } from './pycompat.js';
import { readTextUtf8 } from './yamlio.js';

export const DEFAULT_PRIORITY = 10;

// ============================================================================
// Dependency seams
// ============================================================================

type MaybePromise<T> = T | Promise<T>;
type Info = Record<string, unknown> | null | undefined;

/** Shape of the preset manager the bundler relies on. */
export interface PresetManagerLike {
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
    opts?: { force?: boolean; catalogName?: string | null },
  ): MaybePromise<unknown>;
  remove(packId: string): MaybePromise<unknown>;
}

export interface PresetCatalogLike {
  getPackInfo(packId: string): MaybePromise<Info>;
  downloadPack(packId: string): MaybePromise<string>;
}

/** Shape of the extension manager the bundler relies on. */
export interface ExtensionManagerLike {
  registry: { isInstalled(extensionId: string): MaybePromise<boolean> };
  installFromDirectory(
    sourceDir: string,
    speckitVersion: string,
    opts?: { priority?: number; force?: boolean },
  ): MaybePromise<{ id: string }>;
  installFromZip(
    zipPath: string,
    speckitVersion: string,
    opts?: { priority?: number; force?: boolean; catalogName?: string | null },
  ): MaybePromise<{ id: string }>;
  scaffoldConfig(extensionId: string): MaybePromise<unknown>;
  remove(extensionId: string): MaybePromise<unknown>;
}

export interface ExtensionCatalogLike {
  getExtensionInfo(extensionId: string): MaybePromise<Info>;
  downloadExtension(extensionId: string): MaybePromise<string>;
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
  async workflowCatalogInfo(root: string, id: string): Promise<Info> {
    const mod = await import('../workflows/catalog/domain.js');
    return (await new mod.WorkflowCatalog(root).getWorkflowInfo(id)) as Info;
  },
  async stepRegistry(root: string): Promise<RegistryLike> {
    const mod = await import('../workflows/step/catalog/domain.js');
    return new mod.StepRegistry(root);
  },
  async stepCatalogInfo(root: string, id: string): Promise<Info> {
    const mod = await import('../workflows/step/catalog/domain.js');
    return (await new mod.StepCatalog(root).getStepInfo(id)) as Info;
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
  let matches: boolean;
  try {
    matches = parseVersion(actual).equals(parseVersion(pinned));
  } catch (exc) {
    if (!(exc instanceof BundlerError)) throw exc;
    matches = actual === String(pinned).trim();
  }
  if (!matches) {
    throw new BundlerError(
      `${kind} '${componentId}' is pinned to version ${pinned} in the bundle ` +
        `manifest, but the resolved version is ${actual}. Update the bundle's ` +
        'pinned version or the source before installing.',
    );
  }
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
  install(component: ComponentRef): Promise<void>;
  refresh(component: ComponentRef): Promise<void>;
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

  install(component: ComponentRef): Promise<void> {
    return this.doInstall(component, false);
  }

  refresh(component: ComponentRef): Promise<void> {
    return this.doInstall(component, true);
  }

  private async doInstall(component: ComponentRef, force: boolean): Promise<void> {
    const speckitVersion = await primitiveDeps.getSpeckitVersion();
    const priority = component.priority === null ? DEFAULT_PRIORITY : component.priority;

    const bundled = await primitiveDeps.locateBundledPreset(component.id);
    if (bundled !== null) {
      // Enforce the manifest pin against the bundled asset's own version.
      assertPinnedVersion(
        'Preset',
        component.id,
        component.version,
        bundledManifestVersion(path.join(bundled, 'preset.yml'), 'preset'),
      );
      const manager = await this.manager();
      await manager.installFromDirectory(bundled, speckitVersion, priority, ...(force ? [{ force: true }] : []));
      return;
    }

    if (!this.allowNetwork) {
      throw new BundlerError(
        `Preset '${component.id}' is not bundled and network access is ` +
          'disabled. Installing or refreshing this component requires ' +
          'network access; re-run without --offline.',
      );
    }

    const catalog = await primitiveDeps.presetCatalog(this.root);
    const info = await catalog.getPackInfo(component.id);
    if (!info) throw new BundlerError(`Preset '${component.id}' not found in any catalog.`);
    if (!pyTruthy(info._install_allowed ?? true)) {
      throw new BundlerError(
        `Preset '${component.id}' is from a discovery-only catalog; installation is not allowed.`,
      );
    }
    assertPinnedVersion('Preset', component.id, component.version, info.version);
    const zipPath = await catalog.downloadPack(component.id);
    try {
      const manager = await this.manager();
      await manager.installFromZip(zipPath, speckitVersion, priority, {
        catalogName: (info._catalog_name as string | undefined) ?? null,
        ...(force ? { force: true } : {}),
      });
    } finally {
      safeUnlink(zipPath);
    }
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

  install(component: ComponentRef): Promise<void> {
    return this.doInstall(component, false);
  }

  refresh(component: ComponentRef): Promise<void> {
    return this.doInstall(component, true);
  }

  private async doInstall(component: ComponentRef, force: boolean): Promise<void> {
    const speckitVersion = await primitiveDeps.getSpeckitVersion();
    const priority = component.priority === null ? DEFAULT_PRIORITY : component.priority;

    const bundled = await primitiveDeps.locateBundledExtension(component.id);
    if (bundled !== null) {
      assertPinnedVersion(
        'Extension',
        component.id,
        component.version,
        bundledManifestVersion(path.join(bundled, 'extension.yml'), 'extension'),
      );
      const manager = await this.manager();
      const manifest = await manager.installFromDirectory(bundled, speckitVersion, { priority, force });
      // Scaffold extension config exactly like `specify extension add` does.
      await manager.scaffoldConfig(manifest.id);
      return;
    }

    if (!this.allowNetwork) {
      throw new BundlerError(
        `Extension '${component.id}' is not bundled and network access is ` +
          'disabled. Installing or refreshing this component requires ' +
          'network access; re-run without --offline.',
      );
    }

    const catalog = await primitiveDeps.extensionCatalog(this.root);
    const info = await catalog.getExtensionInfo(component.id);
    if (!info) throw new BundlerError(`Extension '${component.id}' not found in any catalog.`);
    if (!pyTruthy(info._install_allowed ?? true)) {
      throw new BundlerError(
        `Extension '${component.id}' is from a discovery-only catalog; installation is not allowed.`,
      );
    }
    assertPinnedVersion('Extension', component.id, component.version, info.version);
    const zipPath = await catalog.downloadExtension(component.id);
    try {
      const manager = await this.manager();
      const manifest = await manager.installFromZip(zipPath, speckitVersion, {
        priority,
        force,
        catalogName: (info._catalog_name as string | undefined) ?? null,
      });
      await manager.scaffoldConfig(manifest.id);
    } finally {
      safeUnlink(zipPath);
    }
  }

  async remove(component: ComponentRef): Promise<void> {
    try {
      await (await this.manager()).remove(component.id);
    } catch (exc) {
      throw new BundlerError(`Failed to remove extension '${component.id}': ${errText(exc)}`, { cause: exc });
    }
  }
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

  async install(component: ComponentRef): Promise<void> {
    const bundled = await primitiveDeps.locateBundledWorkflow(component.id);
    if (bundled !== null) {
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
      assertPinnedVersion('Workflow', component.id, component.version, definition.version);
      await withChdir(this.root, () =>
        delegateCommand('install', `workflow '${component.id}'`, () =>
          primitiveDeps.workflowAdd(workflowFile, { dev: true, fromUrl: null }),
        ),
      );
      return;
    }

    if (!this.allowNetwork) {
      throw new BundlerError(
        `Workflow '${component.id}' installs from a catalog and network ` +
          'access is disabled. Installing or refreshing this component ' +
          'requires network access; re-run without --offline.',
      );
    }
    await this.assertCatalogPinnedVersion(component);
    await withChdir(this.root, () =>
      delegateCommand('install', `workflow '${component.id}'`, () =>
        primitiveDeps.workflowAdd(component.id, { dev: false, fromUrl: null }),
      ),
    );
  }

  refresh(component: ComponentRef): Promise<void> {
    // workflow add is idempotent for already-installed workflows.
    return this.install(component);
  }

  private async assertCatalogPinnedVersion(component: ComponentRef): Promise<void> {
    if (!component.version) return;
    let info: Info;
    try {
      info = await primitiveDeps.workflowCatalogInfo(this.root, component.id);
    } catch {
      return; // catalog unreachable: cannot enforce
    }
    if (info) assertPinnedVersion('Workflow', component.id, component.version, info.version);
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

  async install(component: ComponentRef): Promise<void> {
    if (!this.allowNetwork) {
      throw new BundlerError(
        `Step '${component.id}' installs from a catalog and network access ` +
          'is disabled. Installing or refreshing this component requires ' +
          'network access; re-run without --offline.',
      );
    }
    await withChdir(this.root, () =>
      delegateCommand('install', `step '${component.id}'`, () => primitiveDeps.workflowStepAdd(component.id)),
    );
  }

  async refresh(component: ComponentRef): Promise<void> {
    // Preserve an existing step until the refresh is known to succeed: keep a
    // backup and restore it if the remove+reinstall path fails.
    if (!(this.allowNetwork && (await this.isInstalled(component)))) {
      await this.install(component);
      return;
    }

    const registry = await primitiveDeps.stepRegistry(this.root);
    const stepsDir = registry.stepsDir ?? path.join(this.root, '.specify', 'workflows', 'steps');
    const stepDir = path.join(stepsDir, component.id);
    const metadata = registry.get(component.id);
    const backupParent = mkdtempSync(path.join(tmpdir(), 'speckit-step-refresh-'));
    const backupDir = path.join(backupParent, component.id);
    try {
      if (existsSync(stepDir)) cpSync(stepDir, backupDir, { recursive: true, verbatimSymlinks: true });
      await this.remove(component);
      try {
        await this.install(component);
      } catch (exc) {
        if (exc instanceof BundlerError) {
          if (existsSync(backupDir)) {
            cpSync(backupDir, stepDir, { recursive: true, force: true, verbatimSymlinks: true });
          }
          // Re-read the registry: the snapshot taken above still contains the
          // entry that remove() deleted on disk, so consult a fresh instance.
          const current = await primitiveDeps.stepRegistry(this.root);
          if (metadata !== null && metadata !== undefined && !current.isInstalled(component.id)) {
            // Restore the saved entry verbatim (not via add(), which would
            // re-stamp installed_at/updated_at).
            const steps = (current.data.steps ??= {});
            steps[component.id] = metadata;
            current.save();
          }
        }
        throw exc;
      }
    } finally {
      rmSync(backupParent, { recursive: true, force: true });
    }
  }

  async remove(component: ComponentRef): Promise<void> {
    await withChdir(this.root, () =>
      delegateCommand('remove', `step '${component.id}'`, () => primitiveDeps.workflowStepRemove(component.id)),
    );
  }
}
