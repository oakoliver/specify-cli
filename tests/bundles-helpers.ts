/**
 * Shared helpers and fakes for bundler tests (port of
 * tests/specify_cli/bundles/helpers.py).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { dumpYaml } from '../src/yaml.js';
import { BundlerError } from '../src/bundles/index.js';
import type { ComponentRef } from '../src/bundles/manifest.js';

export function validManifestDict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1.0',
    bundle: {
      id: 'demo-bundle',
      name: 'Demo Bundle',
      version: '1.2.0',
      role: 'developer',
      description: 'A demo bundle for tests.',
      author: 'Spec Kit',
      license: 'MIT',
    },
    requires: { speckit_version: '>=0.1.0' },
    provides: {
      extensions: [{ id: 'ext-a', version: '1.0.0' }],
      presets: [{ id: 'preset-a', version: '2.0.0', priority: 10, strategy: 'append' }],
      steps: [{ id: 'step-a' }],
      workflows: [{ id: 'wf-a', version: '0.3.0' }],
    },
    tags: ['demo', 'test'],
    ...overrides,
  };
}

export function writeManifest(directory: string, data?: Record<string, unknown>): string {
  mkdirSync(directory, { recursive: true });
  const manifestPath = path.join(directory, 'bundle.yml');
  writeFileSync(manifestPath, dumpYaml(data ?? validManifestDict()), 'utf-8');
  return manifestPath;
}

export function makeProject(root: string): string {
  mkdirSync(path.join(root, '.specify'), { recursive: true });
  return root;
}

export function catalogPayload(bundles: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1.0',
    updated_at: '2026-06-19T00:00:00Z',
    catalog_url: 'file://test',
    bundles,
  };
}

export function catalogEntryDict(bundleId = 'demo-bundle', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: bundleId,
    name: 'Demo Bundle',
    version: '1.2.0',
    role: 'developer',
    description: 'A demo bundle.',
    author: 'Spec Kit',
    license: 'MIT',
    download_url: '',
    requires: { speckit_version: '>=0.1.0' },
    provides: { extensions: 1, presets: 1, steps: 1, workflows: 1 },
    verified: true,
    ...overrides,
  };
}

export function writeCatalogFile(p: string, bundles: Record<string, unknown>): string {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(catalogPayload(bundles)), 'utf-8');
  return p;
}

/** Deterministic in-memory PrimitiveInstaller for offline integration tests. */
export class FakeInstaller {
  installed = new Set<string>();
  installCalls: Array<[string, string]> = [];
  removeCalls: Array<[string, string]> = [];
  refreshCalls: Array<[string, string]> = [];

  constructor(private readonly opts: { failOn?: string | null } = {}) {}

  static key(component: { kind: string; id: string }): string {
    return `${component.kind}:${component.id}`;
  }

  isInstalled(_root: string, component: ComponentRef): boolean {
    return this.installed.has(FakeInstaller.key(component));
  }

  install(_root: string, component: ComponentRef): void {
    this.installCalls.push([component.kind, component.id]);
    if (this.opts.failOn && component.id === this.opts.failOn) {
      throw new BundlerError(`Simulated failure installing ${component.id}`);
    }
    this.installed.add(FakeInstaller.key(component));
  }

  remove(_root: string, component: ComponentRef): void {
    this.removeCalls.push([component.kind, component.id]);
    this.installed.delete(FakeInstaller.key(component));
  }

  refresh(_root: string, component: ComponentRef): void {
    this.refreshCalls.push([component.kind, component.id]);
    this.installed.add(FakeInstaller.key(component));
  }
}
