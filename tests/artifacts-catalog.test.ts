/**
 * Artifact inventory, stacks, hooks and contribution lookup. Ports of
 * tests/specify_cli/artifacts/test_catalog.py (contract, sorting, info,
 * errors, kind hints, contribution info, convention discovery, hook
 * inventory / registration / info).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  AmbiguousArtifactError,
  Artifact,
  ArtifactCatalog,
  ArtifactNotFoundError,
  ArtifactResolutionError,
  ContributionNotFoundError,
  HookArtifact,
  NotASpecKitProjectError,
} from '../src/artifacts/index.js';
import { artifactCatalogHooks } from '../src/artifacts/catalog.js';
import { deriveHookLookupId } from '../src/artifacts/identifiers.js';
import { CORE_COMMAND_NAMES } from '../src/extensions/manifest.js';
import { ExtensionRegistry } from '../src/extensions/registry.js';
import { PresetRegistry } from '../src/presets/registry.js';
import { dumpYaml } from '../src/yaml.js';

let tmp: string;
let project: string;
const originalLocate = artifactCatalogHooks.locateSharedAssetDir;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'artifacts-catalog-')));
  project = path.join(tmp, 'proj');
  for (const d of ['presets', 'extensions', 'templates']) mkdirSync(path.join(project, '.specify', d), { recursive: true });
});

afterEach(() => {
  artifactCatalogHooks.locateSharedAssetDir = originalLocate;
  rmSync(tmp, { recursive: true, force: true });
});

// ============================================================================
// Helpers (tests/conftest.py::install_preset, artifacts/helpers.py)
// ============================================================================

function write(p: string, content: string): string {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function installPreset(
  packId: string,
  provides: { templates?: Record<string, unknown>[]; commands?: Record<string, unknown>[]; scripts?: Record<string, unknown>[] },
  priority = 10,
): string {
  const packDir = path.join(project, '.specify', 'presets', packId);
  mkdirSync(packDir, { recursive: true });
  const defaultFile = (kind: string, name: string): string =>
    kind === 'command' ? `commands/${name}.md` : kind === 'script' ? `scripts/${name}.sh` : `templates/${name}.md`;
  const templates: Record<string, unknown>[] = [];
  for (const entry of provides.templates ?? []) {
    const type = (entry.type as string) ?? 'template';
    templates.push({ ...entry, type, file: entry.file ?? defaultFile(type, entry.name as string) });
  }
  for (const [key, type] of [['commands', 'command'], ['scripts', 'script']] as const) {
    for (const entry of provides[key] ?? []) {
      templates.push({ ...entry, type, file: entry.file ?? defaultFile(type, entry.name as string) });
    }
  }
  write(
    path.join(packDir, 'preset.yml'),
    dumpYaml({
      schema_version: '1.0',
      preset: { id: packId, name: `Test preset ${packId}`, version: '1.0.0', description: `Test preset ${packId}` },
      requires: { speckit_version: '>=1.0.0' },
      provides: { templates },
    }),
  );
  new PresetRegistry(path.join(project, '.specify', 'presets')).add(packId, { priority, version: '1.0.0' });
  return packDir;
}

function extensionManifest(id: string, extra: Record<string, unknown>): string {
  return dumpYaml({
    schema_version: '1.0',
    extension: {
      id,
      name: id,
      version: '1.0.0',
      description: 'Test extension',
      author: 'test',
      repository: 'https://example.com',
      license: 'MIT',
    },
    requires: { speckit_version: '>=0.2.0' },
    provides: {},
    ...extra,
  });
}

function installExtensionWithHooks(
  extensionId: string,
  hooks: Record<string, unknown>,
  opts: { manifestId?: string; priority?: number; enabled?: boolean } = {},
): string {
  const extDir = path.join(project, '.specify', 'extensions', extensionId);
  write(path.join(extDir, 'extension.yml'), extensionManifest(opts.manifestId ?? extensionId, { hooks }));
  new ExtensionRegistry(path.join(project, '.specify', 'extensions')).add(extensionId, {
    version: '1.0.0',
    enabled: opts.enabled ?? true,
    priority: opts.priority ?? 10,
  });
  return extDir;
}

function writeHookBinding(eventName: string, entries: Record<string, unknown>[]): void {
  write(
    path.join(project, '.specify', 'extensions.yml'),
    dumpYaml({ installed: [], settings: { auto_execute_hooks: true }, hooks: { [eventName]: entries } }),
  );
}

const ERROR_REGEX = /^(unknown artifact |unknown contribution |ambiguous artifact |artifact resolution failed|not a Spec Kit project)/;

// ============================================================================
// list contract
// ============================================================================

describe('listArtifacts contract', () => {
  test('rows are Artifact/HookArtifact with stable fields, grammar and uniqueness', () => {
    const rows = new ArtifactCatalog(project).listArtifacts();
    expect(rows.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const row of rows) {
      expect(row instanceof Artifact || row instanceof HookArtifact).toBe(true);
      const d = row.toJsonDict();
      expect(Object.keys(d).sort()).toEqual(['description', 'id', 'kind', 'name']);
      expect(typeof d.description).toBe('string');
      expect(row.id).toMatch(/^(?:(?:command|template|script):[^:]+|hook:[^:]+:[^:]+)$/);
      expect(['command', 'template', 'script', 'hook']).toContain(row.kind);
      expect(ids.has(row.id)).toBe(false);
      ids.add(row.id);
    }
  });

  test('every core command is listed and resolvable', () => {
    const catalog = new ArtifactCatalog(project);
    const listed = new Set(catalog.listArtifacts().filter((r) => r.kind === 'command').map((r) => r.name));
    for (const name of CORE_COMMAND_NAMES) {
      expect(listed.has(`speckit.${name}`)).toBe(true);
      const info = catalog.getArtifactInfo(`command:speckit.${name}`);
      expect(info.id).toBe(`command:speckit.${name}`);
      expect((info.stack as unknown[]).length).toBeGreaterThan(0);
    }
  });

  test('kind grouping and name sorting', () => {
    const rows = new ArtifactCatalog(project).listArtifacts().filter((r) => r.kind !== 'hook');
    const order = { command: 0, template: 1, script: 2 } as Record<string, number>;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!;
      const b = rows[i]!;
      expect(order[a.kind]! < order[b.kind]! || (a.kind === b.kind && a.name < b.name)).toBe(true);
    }
  });

  for (const [requested, runtimeDir] of [
    ['sh', 'bash'],
    ['ps', 'powershell'],
    ['py', 'python'],
  ] as const) {
    test(`core scripts follow project runtime selection (${requested})`, () => {
      write(path.join(project, '.specify', 'init-options.json'), JSON.stringify({ script: requested }));
      const catalog = new ArtifactCatalog(project);
      const scripts = catalog.listArtifacts().filter((r) => r.kind === 'script');
      expect(new Set(scripts.map((r) => r.name))).toEqual(
        new Set(['check-prerequisites', 'resolve-template', 'setup-plan', 'setup-tasks']),
      );
      const selected = catalog.selectedCoreScriptPaths();
      expect(new Set(selected.keys())).toEqual(new Set(scripts.map((r) => r.name)));
      for (const p of selected.values()) expect(path.basename(path.dirname(p))).toBe(runtimeDir);
      for (const script of scripts) {
        const stack = catalog.getArtifactInfo(script.id).stack as Array<Record<string, unknown>>;
        const last = stack[stack.length - 1]!;
        expect(last.layer).toBeNull();
        expect(last.sourceId).toBeNull();
        expect(last.lookupId).toBeNull();
        expect(last.sourcePath).toBeNull();
      }
    });
  }

  test('core scripts reuse runtime fallback and reject unsafe references', () => {
    const commandsDir = path.join(tmp, 'commands');
    const scriptsDir = path.join(tmp, 'scripts');
    mkdirSync(path.join(scriptsDir, 'bash'), { recursive: true });
    const script = write(path.join(scriptsDir, 'bash', 'demo.sh'), '#!/bin/sh\n');
    write(path.join(commandsDir, 'demo.md'), '---\nscripts:\n  sh: scripts/bash/demo.sh\n---\n');
    write(path.join(project, '.specify', 'init-options.json'), JSON.stringify({ script: 'ps' }));
    artifactCatalogHooks.locateSharedAssetDir = (subdir) =>
      subdir === 'commands' ? commandsDir : subdir === 'scripts' ? scriptsDir : null;
    expect([...new ArtifactCatalog(project).selectedCoreScriptPaths()]).toEqual([['demo', script]]);

    const outside = write(path.join(tmp, 'outside.sh'), '#!/bin/sh\n# Must not be read\n');
    for (const ref of [outside, 'C:/outside/demo.sh', '//server/share/demo.sh', 'scripts/bash/../../outside.sh']) {
      write(path.join(commandsDir, 'demo.md'), `---\nscripts:\n  sh: ${ref}\n---\n`);
      const catalog = new ArtifactCatalog(project);
      expect(catalog.selectedCoreScriptPaths().size).toBe(0);
      expect(catalog.listArtifacts().some((r) => r.id === 'script:outside')).toBe(false);
    }

    rmSync(script);
    symlinkSync(outside, script);
    write(path.join(commandsDir, 'demo.md'), '---\nscripts:\n  sh: scripts/bash/demo.sh\n---\n');
    expect(new ArtifactCatalog(project).selectedCoreScriptPaths().size).toBe(0);
  });

  test('excludes disabled and unusable manifest contributions', () => {
    const extensionsDir = path.join(project, '.specify', 'extensions');
    for (const [id, name, enabled] of [
      ['disabled-ext', 'disabled-template', false],
      ['missing-file-ext', 'missing-template', true],
    ] as const) {
      const file = `templates/${name}.md`;
      write(
        path.join(extensionsDir, id, 'extension.yml'),
        extensionManifest(id, { provides: { templates: [{ name, file, description: 'Should not be listed' }] } }),
      );
      if (!enabled) write(path.join(extensionsDir, id, file), '# Disabled\n');
      new ExtensionRegistry(extensionsDir).add(id, { version: '1.0.0', enabled });
    }
    const names = new Set(new ArtifactCatalog(project).listArtifacts().map((r) => r.name));
    expect(names.has('disabled-template')).toBe(false);
    expect(names.has('missing-template')).toBe(false);
  });

  test('unregistered extension uses installed dir identity for lookup', () => {
    const extDir = path.join(project, '.specify', 'extensions', 'renamed');
    write(path.join(extDir, 'commands', 'actual.md'), '---\ndescription: Manifest identity wins\n---\nbody\n');
    write(
      path.join(extDir, 'commands', 'speckit.renamed.convention.md'),
      '---\ndescription: Convention identity uses directory\n---\nbody\n',
    );
    write(
      path.join(extDir, 'extension.yml'),
      extensionManifest('original', {
        provides: {
          commands: [
            { name: 'speckit.original.hello', file: 'commands/actual.md', description: 'manifest declared command' },
          ],
        },
      }),
    );
    const catalog = new ArtifactCatalog(project);
    expect(catalog.listArtifacts().map((r) => r.id)).toContain('command:speckit.original.hello');
    const top = (catalog.getArtifactInfo('speckit.original.hello').stack as Array<Record<string, unknown>>)[0]!;
    expect(top.sourceId).toBe('renamed');
    expect(top.lookupId).toBe('extension:renamed:command:speckit.original.hello');
    expect(top.manifestPath).toBe('.specify/extensions/renamed/extension.yml');
    const contribution = catalog.getContributionInfo(top.lookupId as string);
    expect(contribution).toMatchObject({
      id: top.lookupId,
      layer: 'extension',
      sourceId: 'renamed',
      kind: 'command',
      name: 'speckit.original.hello',
    });
    expect((contribution.contribution as Record<string, unknown>).file).toBe('commands/actual.md');

    const convention = (catalog.getArtifactInfo('speckit.renamed.convention').stack as Array<Record<string, unknown>>)[0]!;
    expect(convention.lookupId).toBe('extension:renamed:command:speckit.renamed.convention');
    expect(convention.manifestPath).toBeNull();
    expect(() => catalog.getContributionInfo(convention.lookupId as string)).toThrow(ContributionNotFoundError);
  });

  test('project-local core assets are listed with their descriptions', () => {
    const templatesDir = path.join(project, '.specify', 'templates');
    write(path.join(templatesDir, 'legacy-template.md'), '---\ndescription: Local template\n---\n');
    write(path.join(templatesDir, 'commands', 'local-command.md'), '---\ndescription: Local command\n---\n');
    write(path.join(templatesDir, 'scripts', 'legacy-script.sh'), '# Local script\n');
    const catalog = new ArtifactCatalog(project);
    const byId = new Map(catalog.listArtifacts().map((a) => [a.id, a]));
    expect(byId.get('template:legacy-template')!.description).toBe('Local template');
    expect(byId.get('command:speckit.local-command')!.description).toBe('Local command');
    expect(byId.get('script:legacy-script')!.description).toBe('Local script');
    for (const name of ['speckit.local-command', 'legacy-template', 'legacy-script']) {
      const layer = (catalog.getArtifactInfo(name).stack as Array<Record<string, unknown>>)[0]!;
      expect(layer.layer).toBeNull();
      expect(layer.lookupId).toBeNull();
      expect(layer.sourcePath).toBeNull();
    }
  });

  test('root-level pack templates and colon names', () => {
    const extDir = path.join(project, '.specify', 'extensions', 'legacy');
    write(path.join(extDir, 'legacy-root.md'), '---\ndescription: Legacy root template\n---\n');
    write(path.join(extDir, 'README.md'), '# Packaging notes\n');
    write(path.join(project, '.specify', 'templates', 'bad:template.md'), '---\ndescription: bad\n---\n');
    const rows = new ArtifactCatalog(project).listArtifacts();
    const names = rows.map((r) => r.name);
    expect(names).toContain('legacy-root');
    expect(names).toContain('README');
    expect(rows.find((r) => r.name === 'legacy-root')!.description).toBe('Legacy root template');
    expect(rows.every((r) => r.kind === 'hook' || !r.name.includes(':'))).toBe(true);
  });

  test('active preset description overrides hidden core description', () => {
    const pack = installPreset('desc-pack', { commands: [{ name: 'speckit.plan', description: 'Preset plan' }] });
    write(path.join(pack, 'commands', 'speckit.plan.md'), '---\ndescription: From file\n---\nbody\n');
    const catalog = new ArtifactCatalog(project);
    expect(catalog.listArtifacts().find((r) => r.id === 'command:speckit.plan')!.description).toBe('Preset plan');
    const stack = catalog.getArtifactInfo('command:speckit.plan').stack as Array<Record<string, unknown>>;
    expect(stack[0]).toMatchObject({
      layer: 'preset',
      sourceId: 'desc-pack',
      presetId: 'desc-pack',
      presetName: 'Test preset desc-pack',
      strategy: 'replace',
      active: true,
      hidden: false,
      manifestPath: '.specify/presets/desc-pack/preset.yml',
      lookupId: 'preset:desc-pack:command:speckit.plan',
      sourcePath: '.specify/presets/desc-pack/commands/speckit.plan.md',
    });
    expect(stack[stack.length - 1]).toMatchObject({ layer: null, active: false, hidden: true });
  });
});

// ============================================================================
// info / errors / kind hints
// ============================================================================

describe('getArtifactInfo', () => {
  test('single active row at index zero; builtin and project override shapes', () => {
    write(path.join(project, '.specify', 'templates', 'overrides', 'speckit.constitution.md'), 'override');
    const info = new ArtifactCatalog(project).getArtifactInfo('command:speckit.constitution');
    const stack = info.stack as Array<Record<string, unknown>>;
    expect(stack.filter((l) => l.active)).toHaveLength(1);
    expect(stack[0]!.active).toBe(true);
    for (const layer of stack) expect(layer.id).toBe('command:speckit.constitution');
    expect(stack[0]).toEqual({
      id: 'command:speckit.constitution',
      layer: 'project',
      sourceId: '_',
      presetId: null,
      presetName: null,
      strategy: 'replace',
      active: true,
      hidden: false,
      manifestPath: null,
      lookupId: 'project:_:command:speckit.constitution',
      sourcePath: null,
    });
    const builtin = stack.find((l) => l.layer === null)!;
    expect(builtin).toMatchObject({ sourceId: null, manifestPath: null, strategy: 'replace', lookupId: null, sourcePath: null });
  });

  test('errors carry pinned messages', () => {
    const catalog = new ArtifactCatalog(project);
    expect(() => catalog.getArtifactInfo('no.such.thing')).toThrow(new ArtifactNotFoundError('no.such.thing'));
    const nonProject = path.join(tmp, 'not-proj');
    mkdirSync(nonProject);
    expect(() => new ArtifactCatalog(nonProject).listArtifacts()).toThrow(NotASpecKitProjectError);
    try {
      new ArtifactCatalog(nonProject).listArtifacts();
    } catch (e) {
      expect((e as Error).message).toMatch(ERROR_REGEX);
    }
  });

  test('ambiguous artifact across kinds', () => {
    const pack = installPreset('test-ambig', {
      templates: [
        { type: 'template', name: 'shared-name', description: 't' },
        { type: 'script', name: 'shared-name', description: 's' },
      ],
    });
    write(path.join(pack, 'templates', 'shared-name.md'), '# Template\n');
    write(path.join(pack, 'scripts', 'shared-name.sh'), '#!/usr/bin/env bash\n');
    expect(() => new ArtifactCatalog(project).getArtifactInfo('shared-name')).toThrow(
      "ambiguous artifact shared-name: matches kinds ['script', 'template']",
    );
    expect(() => new ArtifactCatalog(project).getArtifactInfo('shared-name')).toThrow(AmbiguousArtifactError);
    expect(new ArtifactCatalog(project).getArtifactInfo('shared-name', 'script').kind).toBe('script');
  });

  test('corrupt extension registry → resolution error', () => {
    write(path.join(project, '.specify', 'extensions', '.registry'), '{invalid');
    expect(() => new ArtifactCatalog(project).getArtifactInfo('command:speckit.constitution')).toThrow(
      ArtifactResolutionError,
    );
    expect(() => new ArtifactCatalog(project).listArtifacts()).toThrow(ArtifactResolutionError);
  });

  test('kind hints: shorthand, conflicts, invalid components, id round-trip', () => {
    const catalog = new ArtifactCatalog(project);
    expect(catalog.getArtifactInfo('command:speckit.constitution').kind).toBe('command');
    expect(() => catalog.getArtifactInfo('template:speckit.constitution', 'command')).toThrow(ArtifactNotFoundError);
    for (const [kind, name] of [
      ['template', '../../outside'],
      ['command', 'template:foo'],
      ['script', 'script:name'],
    ] as const) {
      expect(() => catalog.getArtifactInfo(name, kind)).toThrow(ArtifactNotFoundError);
    }
    expect(catalog.getArtifactInfo('command:speckit.plan')).toEqual(catalog.getArtifactInfo('speckit.plan'));
  });

  test('id form resolves template despite same-named command', () => {
    const pack = installPreset('collide-pack', { commands: [{ name: 'spec-template', description: 'cmd' }] });
    write(path.join(pack, 'commands', 'spec-template.md'), 'colliding command body');
    expect(() => new ArtifactCatalog(project).getArtifactInfo('spec-template')).toThrow(AmbiguousArtifactError);
    const info = new ArtifactCatalog(project).getArtifactInfo('template:spec-template');
    expect(info.kind).toBe('template');
    expect(info.id).toBe('template:spec-template');
  });

  test('skills are excluded from the inventory', () => {
    write(path.join(project, '.github', 'skills', 'speckit-my-skill', 'SKILL.md'), '---\nname: my-skill\n---\nbody');
    expect(new ArtifactCatalog(project).listArtifacts().some((r) => r.name.toLowerCase().includes('skill'))).toBe(false);
  });
});

// ============================================================================
// Contribution lookup & stack source paths
// ============================================================================

describe('getContributionInfo', () => {
  test('preset declaration with repo-relative paths', () => {
    const pack = installPreset('lookup-pack', {
      templates: [{ type: 'template', name: 'lookup-template', file: 'templates/lookup.md', description: 'Lookup target' }],
    });
    write(path.join(pack, 'templates', 'lookup.md'), 'body');
    const catalog = new ArtifactCatalog(project);
    const lookupId = (catalog.getArtifactInfo('template:lookup-template').stack as Array<Record<string, unknown>>)[0]!
      .lookupId as string;
    expect(lookupId).toBe('preset:lookup-pack:template:lookup-template');
    expect(catalog.getContributionInfo(lookupId)).toEqual({
      id: lookupId,
      layer: 'preset',
      sourceId: 'lookup-pack',
      kind: 'template',
      name: 'lookup-template',
      manifestPath: '.specify/presets/lookup-pack/preset.yml',
      sourcePath: '.specify/presets/lookup-pack/templates/lookup.md',
      contribution: {
        type: 'template',
        name: 'lookup-template',
        file: 'templates/lookup.md',
        description: 'Lookup target',
      },
    });
  });

  test('unknown / malformed / project lookups', () => {
    const catalog = new ArtifactCatalog(project);
    for (const id of [
      'extension:missing:command:speckit.missing.command',
      'invalid:source:command:name',
      'extension:source:hook:%FF:command',
      'project:_:command:local',
    ]) {
      expect(() => catalog.getContributionInfo(id)).toThrow(new ContributionNotFoundError(id));
    }
  });

  test('materialized skill and extension template source paths (active rows)', () => {
    const pack = installPreset('compliance', {
      commands: [
        { name: 'speckit.compliance.plan', file: 'commands/speckit.compliance.plan.md', description: 'Compliance plan' },
      ],
    });
    write(path.join(pack, 'commands', 'speckit.compliance.plan.md'), '---\ndescription: Compliance plan\n---\nbody\n');
    new PresetRegistry(path.join(project, '.specify', 'presets')).update('compliance', {
      registered_skills: { copilot: ['speckit-compliance-plan'] },
    });
    write(path.join(project, '.github', 'skills', 'speckit-compliance-plan', 'SKILL.md'), '---\nname: x\n---\n');
    const extDir = path.join(project, '.specify', 'extensions', 'quality');
    write(path.join(extDir, 'templates', 'checklist.md'), '---\ndescription: Extension checklist\n---\n');
    write(
      path.join(extDir, 'extension.yml'),
      extensionManifest('quality', {
        provides: { templates: [{ name: 'checklist', file: 'templates/checklist.md', description: 'Extension checklist' }] },
      }),
    );
    new ExtensionRegistry(path.join(project, '.specify', 'extensions')).add('quality', { version: '1.0.0', enabled: true });

    const rows = new ArtifactCatalog(project).listArtifactsWithStack();
    const sourcePaths = new Set<string>();
    for (const row of rows) {
      for (const layer of row.stack as Array<Record<string, unknown>>) {
        expect('sourcePath' in layer).toBe(true);
        if (layer.sourcePath !== null) sourcePaths.add(layer.sourcePath as string);
      }
    }
    expect(sourcePaths.has('.github/skills/speckit-compliance-plan/SKILL.md')).toBe(true);
    expect(sourcePaths.has('.specify/extensions/quality/templates/checklist.md')).toBe(true);
  });
});

// ============================================================================
// Hooks
// ============================================================================

describe('hook artifacts', () => {
  test('declared hook artifact and stack shape; lookup returns declaration', () => {
    installExtensionWithHooks('compliance', {
      before_specify: [
        {
          command: 'speckit.compliance.pre-check',
          eventName: 'after_plan',
          description: 'Compliance pre-check',
          priority: 5,
          optional: false,
        },
      ],
    });
    const catalog = new ArtifactCatalog(project);
    const row = catalog.listArtifactsWithStack().find((r) => r.kind === 'hook')!;
    const entry = (row.stack as Array<Record<string, unknown>>)[0]!;
    const lookupId = deriveHookLookupId('extension', 'compliance', 'before_specify', 'speckit.compliance.pre-check');
    expect(row).toEqual({
      id: 'hook:before_specify:speckit.compliance.pre-check',
      kind: 'hook',
      name: 'before_specify:speckit.compliance.pre-check',
      description: 'Compliance pre-check',
      eventName: 'before_specify',
      targetCommand: 'speckit.compliance.pre-check',
      registered: false,
      stack: [entry],
    });
    expect(entry).toEqual({
      id: 'hook:before_specify:speckit.compliance.pre-check',
      layer: 'extension',
      sourceId: 'compliance',
      presetId: null,
      presetName: null,
      strategy: 'additive',
      active: false,
      hidden: false,
      manifestPath: '.specify/extensions/compliance/extension.yml',
      lookupId,
      sourcePath: null,
      priority: 5,
      optional: false,
    });
    const contribution = catalog.getContributionInfo(lookupId);
    expect(contribution.kind).toBe('hook');
    expect(contribution.contribution).toEqual({
      eventName: 'before_specify',
      command: 'speckit.compliance.pre-check',
      description: 'Compliance pre-check',
      priority: 5,
      optional: false,
    });

    const flat = catalog.listArtifacts().find((r) => r.kind === 'hook')!;
    const { stack: _stack, ...rest } = row;
    expect(flat.toJsonDict()).toEqual(rest);
  });

  test('additive declarations sorted by priority; disabled extensions excluded', () => {
    installExtensionWithHooks('b-ext', { after_plan: [{ command: 'speckit.shared.cmd', priority: 20 }] });
    installExtensionWithHooks('a-ext', { after_plan: [{ command: 'speckit.shared.cmd', priority: 5 }] });
    installExtensionWithHooks('off-ext', { after_plan: [{ command: 'speckit.shared.cmd' }] }, { enabled: false });
    const row = new ArtifactCatalog(project).listArtifactsWithStack().find((r) => r.kind === 'hook')!;
    const stack = row.stack as Array<Record<string, unknown>>;
    expect(stack.map((e) => e.sourceId)).toEqual(['a-ext', 'b-ext']);
    expect(stack.map((e) => e.priority)).toEqual([5, 20]);
  });

  test('invalid unicode hooks omitted without hiding healthy hooks', () => {
    for (const hooks of [
      { before_specify: [{ command: 'speckit.healthy.cmd' }], '\ud800': [{ command: 'speckit.invalid.cmd' }] },
      { before_specify: [{ command: 'speckit.healthy.cmd' }, { command: '\ud800' }] },
    ]) {
      installExtensionWithHooks('unicode-hooks', hooks);
      const catalog = new ArtifactCatalog(project);
      const flat = catalog.listArtifacts().filter((r) => r.kind === 'hook') as HookArtifact[];
      expect(flat.map((h) => h.targetCommand)).toEqual(['speckit.healthy.cmd']);
      const enriched = catalog.listArtifactsWithStack().filter((r) => r.kind === 'hook');
      expect(enriched.map((r) => r.targetCommand)).toEqual(['speckit.healthy.cmd']);
    }
  });

  for (const [binding, expected] of [
    [{ extension: 'compliance', command: 'speckit.compliance.pre-check', enabled: true }, true],
    [{ extension: 'compliance', command: 'speckit.compliance.pre-check', enabled: false }, false],
    [{ extension: 'compliance', enabled: true }, false],
  ] as const) {
    test(`registration matches runtime binding (${JSON.stringify(binding)})`, () => {
      installExtensionWithHooks('compliance', { before_specify: [{ command: 'speckit.compliance.pre-check' }] });
      writeHookBinding('before_specify', [binding]);
      const row = new ArtifactCatalog(project).listArtifactsWithStack().find((r) => r.kind === 'hook')!;
      expect(row.registered).toBe(expected);
      expect((row.stack as Array<Record<string, unknown>>)[0]!.active).toBe(expected);
    });
  }

  test('hook info: shorthand, encoded colons, kind hint, unknown', () => {
    installExtensionWithHooks('compliance', {
      before_specify: [{ command: 'speckit.compliance.pre-check' }],
      'ev:x': [{ command: 'a:b' }],
    });
    const catalog = new ArtifactCatalog(project);
    expect(catalog.getArtifactInfo('hook:before_specify:speckit.compliance.pre-check').kind).toBe('hook');
    expect(catalog.getArtifactInfo('before_specify:speckit.compliance.pre-check', 'hook').kind).toBe('hook');
    const encoded = catalog.getArtifactInfo('hook:ev%3Ax:a%3Ab');
    expect(encoded.eventName).toBe('ev:x');
    expect(encoded.targetCommand).toBe('a:b');
    expect(() => catalog.getArtifactInfo('hook:nope:missing.cmd')).toThrow(
      new ArtifactNotFoundError('hook:nope:missing.cmd'),
    );
    expect(() => catalog.getArtifactInfo('hook:event:bad%escape')).toThrow(ArtifactNotFoundError);
  });
});
