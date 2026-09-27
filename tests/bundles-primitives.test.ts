/**
 * Primitive dispatch bridge and reference checker. Ports of
 * tests/specify_cli/bundles/{test_primitives,test_references}.py using the
 * injectable `primitiveDeps` seams (the Python tests monkeypatch the same seams).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { CliExit } from '../src/console.js';
import { BundlerError } from '../src/bundles/index.js';
import { BundleManifest, ComponentRef } from '../src/bundles/manifest.js';
import {
  ExtensionKindManager,
  PresetKindManager,
  StepKindManager,
  WorkflowKindManager,
  assertPinnedVersion,
  primitiveDeps,
  primitiveManager,
  type ExtensionManagerLike,
  type PresetManagerLike,
} from '../src/bundles/primitives.js';
import { DefaultPrimitiveInstaller } from '../src/bundles/adapters.js';
import { installBundle } from '../src/bundles/installer.js';
import { InstallPlan } from '../src/bundles/resolver.js';
import { makeReferenceChecker } from '../src/bundles/references.js';
import { StepRegistry } from '../src/workflows/step/catalog/domain.js';
import { makeProject, validManifestDict } from './bundles-helpers.js';

let tmp: string;
const saved = { ...primitiveDeps };
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'bundles-prim-')));
  // Default fakes: nothing bundled, nothing installed, fixed version.
  primitiveDeps.getSpeckitVersion = async () => '1.0.12';
  primitiveDeps.locateBundledPreset = async () => null;
  primitiveDeps.locateBundledExtension = async () => null;
  primitiveDeps.locateBundledWorkflow = async () => null;
});
afterEach(() => {
  Object.assign(primitiveDeps, saved);
  rmSync(tmp, { recursive: true, force: true });
});

const comp = (kind: string, id = 'x', extra: Partial<ConstructorParameters<typeof ComponentRef>[0]> = {}) =>
  new ComponentRef({ kind, id, ...extra });

async function rejects(p: Promise<unknown>, match: string | RegExp): Promise<Error> {
  let caught: unknown;
  try {
    await p;
  } catch (exc) {
    caught = exc;
  }
  expect(caught).toBeInstanceOf(BundlerError);
  const msg = (caught as Error).message;
  if (typeof match === 'string') expect(msg).toContain(match);
  else expect(msg).toMatch(match);
  return caught as Error;
}

function writeAssetManifest(dir: string, rootKey: string, version: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${rootKey}.yml`), `${rootKey}:\n  id: x\n  version: ${version}\n`);
  return dir;
}

// ============================================================================
// Routing & offline gating
// ============================================================================

describe('primitive routing', () => {
  test('routes each kind; rejects unknown', () => {
    expect(primitiveManager('presets', tmp)).toBeInstanceOf(PresetKindManager);
    expect(primitiveManager('extensions', tmp)).toBeInstanceOf(ExtensionKindManager);
    expect(primitiveManager('workflows', tmp)).toBeInstanceOf(WorkflowKindManager);
    expect(primitiveManager('steps', tmp)).toBeInstanceOf(StepKindManager);
    expect(() => primitiveManager('bogus', tmp)).toThrow("Unknown component kind 'bogus'.");
  });

  test.each(['presets', 'extensions', 'workflows', 'steps'])('offline %s not bundled refuses', async (kind) => {
    const manager = primitiveManager(kind, tmp, { allowNetwork: false });
    await rejects(manager.install(comp(kind, 'definitely-not-bundled')), 'network access is disabled');
  });

  test.each(['presets', 'extensions', 'workflows', 'steps'])('offline refresh (%s) explains network need', async (kind) => {
    const installer = new DefaultPrimitiveInstaller({ allowNetwork: false });
    const err = await rejects(installer.refresh(tmp, comp(kind, 'definitely-not-bundled')), 'refreshing this component requires network access');
    expect(err.message).toContain('definitely-not-bundled');
  });

  test('default installer threads allowNetwork', async () => {
    await rejects(new DefaultPrimitiveInstaller({ allowNetwork: false }).install(tmp, comp('workflows')), 'network access is disabled');
  });
});

// ============================================================================
// Pin enforcement
// ============================================================================

describe('pinned versions', () => {
  test('assertPinnedVersion', () => {
    expect(() => assertPinnedVersion('Preset', 'p', '2.0.0', '2.0.0')).not.toThrow();
    expect(() => assertPinnedVersion('Preset', 'p', '2.0.0', 'v2.0.0')).not.toThrow();
    expect(() => assertPinnedVersion('Preset', 'p', null, '9.9.9')).not.toThrow();
    expect(() => assertPinnedVersion('Preset', 'p', '2.0.0', null)).not.toThrow();
    expect(() => assertPinnedVersion('Preset', 'preset-a', '2.0.0', '3.1.0')).toThrow(
      "Preset 'preset-a' is pinned to version 2.0.0 in the bundle manifest, but the resolved version is 3.1.0. " +
        "Update the bundle's pinned version or the source before installing.",
    );
  });

  test('catalog workflow version mismatch refuses', async () => {
    primitiveDeps.workflowCatalogInfo = async () => ({ version: '9.9.9' });
    let added = false;
    primitiveDeps.workflowAdd = async () => {
      added = true;
    };
    await rejects(primitiveManager('workflows', tmp).install(comp('workflows', 'wf-a', { version: '0.3.0' })), 'pinned to version 0.3.0');
    expect(added).toBe(false);
  });

  test('bundled extension pin mismatch refuses; match installs and scaffolds config', async () => {
    const bundled = writeAssetManifest(path.join(tmp, 'ext'), 'extension', '1.0.0');
    primitiveDeps.locateBundledExtension = async () => bundled;
    const installs: Array<{ dir: string; opts: unknown }> = [];
    const scaffolded: string[] = [];
    const fake: ExtensionManagerLike = {
      registry: { isInstalled: () => false },
      installFromDirectory: (dir, _v, opts) => {
        installs.push({ dir, opts });
        return { id: 'my-ext' };
      },
      installFromZip: () => ({ id: 'my-ext' }),
      scaffoldConfig: (id) => {
        scaffolded.push(id);
      },
      remove: () => true,
    };
    const manager = primitiveManager('extensions', tmp) as ExtensionKindManager;
    manager._manager = fake;
    await rejects(manager.install(comp('extensions', 'my-ext', { version: '2.0.0' })), 'pinned to version 2.0.0');
    expect(installs).toEqual([]);
    await manager.install(comp('extensions', 'my-ext', { version: '1.0.0', priority: 3 }));
    expect(installs).toEqual([{ dir: bundled, opts: { priority: 3, force: false } }]);
    expect(scaffolded).toEqual(['my-ext']);
    await manager.refresh(comp('extensions', 'my-ext', { version: '1.0.0' }));
    expect(installs[1].opts).toEqual({ priority: 10, force: true });
  });

  test('bundled preset pin mismatch refuses; explicit zero priority preserved; refresh forces', async () => {
    const bundled = writeAssetManifest(path.join(tmp, 'preset'), 'preset', '1.0.0');
    primitiveDeps.locateBundledPreset = async () => bundled;
    const calls: unknown[][] = [];
    const fake: PresetManagerLike = {
      getPack: () => null,
      installFromDirectory: (...args) => {
        calls.push(args);
      },
      installFromZip: () => undefined,
      remove: () => true,
    };
    const manager = primitiveManager('presets', tmp, { allowNetwork: false }) as PresetKindManager;
    manager._manager = fake;
    await rejects(manager.install(comp('presets', 'p', { version: '2.0.0' })), 'pinned to version 2.0.0');
    await manager.install(comp('presets', 'p', { priority: 0 }));
    expect(calls[0]).toEqual([bundled, '1.0.12', 0]);
    await manager.refresh(comp('presets', 'p'));
    expect(calls[1]).toEqual([bundled, '1.0.12', 10, { force: true }]);
  });

  test('catalog preset forwards catalog name and removes the archive', async () => {
    const archive = path.join(tmp, 'preset.zip');
    primitiveDeps.presetCatalog = async () => ({
      getPackInfo: () => ({ version: '1.0.0', _install_allowed: true, _catalog_name: 'bundle-preset-catalog' }),
      downloadPack: () => {
        writeFileSync(archive, 'placeholder');
        return archive;
      },
    });
    const calls: Array<Record<string, unknown>> = [];
    const manager = primitiveManager('presets', tmp) as PresetKindManager;
    manager._manager = {
      getPack: () => null,
      installFromDirectory: () => undefined,
      installFromZip: (_z, _v, _p, opts) => {
        calls.push(opts ?? {});
      },
      remove: () => true,
    };
    const c = comp('presets', 'catalog-preset', { version: '1.0.0' });
    await manager.install(c);
    await manager.refresh(c);
    expect(calls.map((o) => o.catalogName)).toEqual(['bundle-preset-catalog', 'bundle-preset-catalog']);
    expect(calls[1].force).toBe(true);
    expect(existsSync(archive)).toBe(false);
  });

  test('catalog extension forwards catalog name, force and scaffolds config', async () => {
    const archive = path.join(tmp, 'ext.zip');
    primitiveDeps.extensionCatalog = async () => ({
      getExtensionInfo: () => ({ version: '1.0.0', _install_allowed: true, _catalog_name: 'bundle-extension-catalog' }),
      downloadExtension: () => {
        writeFileSync(archive, 'x');
        return archive;
      },
    });
    const installs: Array<Record<string, unknown>> = [];
    const scaffolded: string[] = [];
    const manager = primitiveManager('extensions', tmp) as ExtensionKindManager;
    manager._manager = {
      registry: { isInstalled: () => false },
      installFromDirectory: () => ({ id: 'x' }),
      installFromZip: (_z, _v, opts) => {
        installs.push(opts ?? {});
        return { id: 'catalog-extension' };
      },
      scaffoldConfig: (id) => {
        scaffolded.push(id);
      },
      remove: () => true,
    };
    const c = comp('extensions', 'catalog-extension', { version: '1.0.0' });
    await manager.install(c);
    await manager.refresh(c);
    expect(installs.map((o) => o.catalogName)).toEqual(['bundle-extension-catalog', 'bundle-extension-catalog']);
    expect(installs[1].force).toBe(true);
    expect(scaffolded).toEqual(['catalog-extension', 'catalog-extension']);
  });

  test('discovery-only and missing catalog entries refuse', async () => {
    primitiveDeps.presetCatalog = async () => ({ getPackInfo: () => ({ _install_allowed: false }), downloadPack: () => '' });
    await rejects(primitiveManager('presets', tmp).install(comp('presets', 'p')), "Preset 'p' is from a discovery-only catalog; installation is not allowed.");
    primitiveDeps.extensionCatalog = async () => ({ getExtensionInfo: () => null, downloadExtension: () => '' });
    await rejects(primitiveManager('extensions', tmp).install(comp('extensions', 'e')), "Extension 'e' not found in any catalog.");
  });

  test('remove failures are wrapped', async () => {
    const manager = primitiveManager('presets', tmp) as PresetKindManager;
    manager._manager = {
      getPack: () => null,
      installFromDirectory: () => undefined,
      installFromZip: () => undefined,
      remove: () => {
        throw new Error('locked');
      },
    };
    await rejects(manager.remove(comp('presets', 'p')), "Failed to remove preset 'p': locked");
  });
});

// ============================================================================
// Workflows & steps (delegated commands)
// ============================================================================

describe('workflow/step delegation', () => {
  test('offline bundled workflow installs via workflow add --dev with explicit options', async () => {
    const bundled = path.join(tmp, 'wf');
    mkdirSync(bundled);
    writeFileSync(path.join(bundled, 'workflow.yml'), 'workflow:\n  id: bundled-wf\n  version: 1.0.0\n');
    primitiveDeps.locateBundledWorkflow = async () => bundled;
    primitiveDeps.loadWorkflowDefinition = async () => ({ id: 'bundled-wf', version: '1.0.0' });
    const calls: Array<[string, unknown, string]> = [];
    primitiveDeps.workflowAdd = async (source, opts) => {
      calls.push([source, opts, process.cwd()]);
    };
    const project = makeProject(path.join(tmp, 'proj'));
    const before = process.cwd();
    await primitiveManager('workflows', project, { allowNetwork: false }).install(comp('workflows', 'bundled-wf', { version: '1.0.0' }));
    expect(calls).toEqual([[path.join(bundled, 'workflow.yml'), { dev: true, fromUrl: null }, project]]);
    expect(process.cwd()).toBe(before);
  });

  test('bundled workflow id mismatch and load failure', async () => {
    primitiveDeps.locateBundledWorkflow = async () => tmp;
    primitiveDeps.loadWorkflowDefinition = async () => ({ id: 'other', version: '1.0.0' });
    await rejects(primitiveManager('workflows', tmp).install(comp('workflows', 'wf')), "declares ID 'other', expected 'wf'.");
    primitiveDeps.loadWorkflowDefinition = async () => {
      throw new Error('bad yaml');
    };
    await rejects(primitiveManager('workflows', tmp).install(comp('workflows', 'wf')), "Failed to load bundled workflow 'wf': bad yaml");
  });

  test('delegated non-zero exit becomes BundlerError', async () => {
    primitiveDeps.workflowCatalogInfo = async () => null;
    primitiveDeps.workflowAdd = async () => {
      throw new CliExit(1);
    };
    await rejects(primitiveManager('workflows', tmp).install(comp('workflows', 'wf', { version: '1.0.0' })), "Failed to install workflow 'wf'.");
    primitiveDeps.workflowRemove = async () => 2;
    await rejects(primitiveManager('workflows', tmp).remove(comp('workflows', 'wf')), "Failed to remove workflow 'wf'.");
    primitiveDeps.workflowStepAdd = async () => {
      throw new CliExit(0);
    };
    await primitiveManager('steps', tmp).install(comp('steps', 's'));
  });

  test('step refresh restores the registry entry verbatim when reinstall fails', async () => {
    const stepsDir = path.join(tmp, '.specify', 'workflows', 'steps');
    mkdirSync(path.join(stepsDir, 'my-step'), { recursive: true });
    writeFileSync(path.join(stepsDir, 'my-step', 'step.yml'), 'step:\n  type_key: my-step\n');
    writeFileSync(
      path.join(stepsDir, StepRegistry.REGISTRY_FILE),
      JSON.stringify({
        schema_version: '1.0',
        steps: {
          'my-step': {
            name: 'My Step',
            version: '1.0.0',
            type_key: 'my-step',
            installed_at: '2020-01-01T00:00:00+00:00',
            updated_at: '2020-02-02T00:00:00+00:00',
          },
        },
      }),
    );
    const seeded = new StepRegistry(tmp).get('my-step');
    expect(new StepRegistry(tmp).isInstalled('my-step')).toBe(true);

    primitiveDeps.workflowStepRemove = async (id) => {
      const reg = new StepRegistry(process.cwd());
      reg.remove(id);
      rmSync(path.join(stepsDir, id), { recursive: true, force: true });
    };
    primitiveDeps.workflowStepAdd = async (id) => {
      throw new BundlerError(`Failed to install step '${id}'.`);
    };

    await rejects(primitiveManager('steps', tmp, { allowNetwork: true }).refresh(comp('steps', 'my-step')), "Failed to install step 'my-step'.");
    const restored = new StepRegistry(tmp);
    expect(restored.isInstalled('my-step')).toBe(true);
    expect(restored.get('my-step')).toEqual(seeded);
    expect(readFileSync(path.join(stepsDir, 'my-step', 'step.yml'), 'utf-8')).toContain('my-step');
  });
});

// ============================================================================
// Refresh through installBundle
// ============================================================================

test('bundle update refresh passes force=true to installFromDirectory', async () => {
  const bundled = writeAssetManifest(path.join(tmp, 'ext'), 'extension', '1.0.0');
  primitiveDeps.locateBundledExtension = async () => bundled;
  const registry = new Set<string>();
  const forceSeen: boolean[] = [];
  primitiveDeps.extensionManager = async () => ({
    registry: { isInstalled: (id: string) => registry.has(id) },
    installFromDirectory: (_d, _v, opts) => {
      forceSeen.push(Boolean(opts?.force));
      registry.add('my-ext');
      return { id: 'my-ext' };
    },
    installFromZip: () => ({ id: 'my-ext' }),
    scaffoldConfig: () => undefined,
    remove: () => true,
  });
  makeProject(tmp);
  const manifest = BundleManifest.fromDict(
    validManifestDict({
      bundle: { id: 'test-bundle', name: 'Test', version: '1.0.0', role: 'developer', description: 'Test bundle', author: 'Spec Kit', license: 'MIT' },
      provides: { extensions: [{ id: 'my-ext', version: '1.0.0' }] },
    }),
  );
  const plan = new InstallPlan({
    bundle_id: 'test-bundle',
    version: '1.0.0',
    role: 'developer',
    effective_integration: null,
    components: manifest.components.map((c) => new ComponentRef({ kind: c.kind, id: c.id })),
  });
  const installer = new DefaultPrimitiveInstaller({ allowNetwork: false });
  await installBundle(tmp, plan, installer, manifest);
  await installBundle(tmp, plan, installer, manifest, true);
  expect(forceSeen).toEqual([false, true]);
});

// ============================================================================
// Reference checker
// ============================================================================

describe('reference checker', () => {
  const ref = (kind: string, id: string) => new ComponentRef({ kind, id, version: '1.0.0' });

  beforeEach(() => {
    primitiveDeps.presetManager = async () => ({
      getPack: () => null,
      installFromDirectory: () => undefined,
      installFromZip: () => undefined,
      remove: () => true,
    });
    primitiveDeps.presetCatalog = async () => ({ getPackInfo: () => null, downloadPack: () => '' });
    primitiveDeps.stepCatalogInfo = async () => null;
  });

  test('bundled extension resolves without warnings', async () => {
    primitiveDeps.locateBundledExtension = async (id) => (id === 'agent-context' ? '/bundled/agent-context' : null);
    const warnings: string[] = [];
    const check = makeReferenceChecker(makeProject(tmp), { allowNetwork: true, warnings });
    expect(await check(ref('extensions', 'agent-context'))).toBeNull();
    expect(warnings).toEqual([]);
  });

  test('built-in step types resolve; community/unknown do not', async () => {
    primitiveDeps.builtinStepTypes = async () => new Set(['shell', 'gate', 'command', 'if', 'slot']);
    const warnings: string[] = [];
    const check = makeReferenceChecker(makeProject(tmp), { allowNetwork: true, warnings });
    for (const id of ['shell', 'gate', 'command', 'if', 'slot']) expect(await check(ref('steps', id))).toBeNull();
    expect(await check(ref('steps', 'no-such-step-type'))).toBe(
      "step 'no-such-step-type' is not bundled, installed, or present in any active catalog.",
    );
    expect(warnings).toEqual([]);
  });

  test('unknown reference errors online, warns offline, warns when catalog unreachable', async () => {
    const root = makeProject(tmp);
    const warnings: string[] = [];
    expect(await makeReferenceChecker(root, { allowNetwork: true, warnings })(ref('presets', 'does-not-exist'))).toContain('does-not-exist');
    expect(await makeReferenceChecker(root, { allowNetwork: false, warnings })(ref('presets', 'does-not-exist'))).toBeNull();
    expect(warnings).toEqual([
      "Could not verify preset 'does-not-exist' offline (not bundled or installed); re-run validate online to check catalogs.",
    ]);
    primitiveDeps.presetCatalog = async () => {
      throw new Error('unreachable');
    };
    warnings.length = 0;
    expect(await makeReferenceChecker(root, { allowNetwork: true, warnings })(ref('presets', 'p'))).toBeNull();
    expect(warnings).toEqual(["Could not verify preset 'p' (catalog unreachable); reference left unchecked."]);
  });
});
