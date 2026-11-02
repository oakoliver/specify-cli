/**
 * Bundle-reference expansion (port of
 * tests/specify_cli/bundles/test_expansion.py, spec-kit v1.2.5).
 */

import { describe, expect, test } from 'bun:test';

import { BundlerError } from '../src/bundles/index.js';
import { componentDifferences } from '../src/bundles/conflict.js';
import {
  ExpandedManifest,
  LoadedBundle,
  MAX_REFERENCED_BUNDLES,
  componentOriginKey,
  discoveryOnlyMessages,
  expandManifest,
  formatChain,
  requireInstallable,
  type BundleLoader,
} from '../src/bundles/expansion.js';
import { BundleManifest, ComponentRef } from '../src/bundles/manifest.js';
import { FakeBundleLoader, referenceManifestDict } from './bundles-helpers.js';

type Refs = Array<Record<string, unknown>>;

function manifest(
  bundleId: string,
  opts: { version?: string; bundles?: Refs } & Record<string, unknown> = {},
): BundleManifest {
  const { version, bundles, ...components } = opts;
  const data = referenceManifestDict(bundles ?? [], { bundleId, provides: components });
  (data.bundle as Record<string, unknown>).version = version ?? '1.0.0';
  return BundleManifest.fromDict(data);
}

function loaded(
  manifests: BundleManifest[],
  opts: { source?: string; installAllowed?: boolean } = {},
): Map<string, LoadedBundle> {
  const out = new Map<string, LoadedBundle>();
  for (const item of manifests) {
    out.set(
      FakeBundleLoader.key(item.bundle.id, item.bundle.version),
      new LoadedBundle(item, opts.source ?? 'default', opts.installAllowed ?? true),
    );
  }
  return out;
}

const ref = (id: string, extra: Record<string, unknown> = {}) => ({ id, version: '1.0.0', ...extra });
const origin = (expanded: ExpandedManifest, kind: string, id: string) => expanded.origins.get(componentOriginKey(kind, id))!;

async function rejects(p: Promise<unknown>, match: string | RegExp): Promise<string> {
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
  return msg;
}

describe('expansion', () => {
  test('flat manifest does not call the loader', async () => {
    const root = BundleManifest.fromDict(referenceManifestDict());
    const loader = new FakeBundleLoader(new Map());
    const expanded = await expandManifest(root, loader);
    expect(expanded).toEqual(ExpandedManifest.flat(root));
    expect(loader.loadCalls).toEqual([]);
  });

  test('direct and transitive references are depth-first and provenanced', async () => {
    const leaf = manifest('leaf', { extensions: [{ id: 'leaf-ext', version: '1.0.0' }] });
    const child = manifest('child', { bundles: [ref('leaf')], extensions: [{ id: 'child-ext', version: '1.0.0' }] });
    const root = manifest('root', { bundles: [ref('child')], extensions: [{ id: 'root-ext', version: '1.0.0' }] });
    const expanded = await expandManifest(root, new FakeBundleLoader(loaded([leaf, child])));
    expect(expanded.components.map((c) => c.id)).toEqual(['leaf-ext', 'child-ext', 'root-ext']);
    expect(origin(expanded, 'extensions', 'leaf-ext').origin).toEqual(['child', 'leaf']);
    expect(expanded.references[1].via).toEqual(['child']);
  });

  test('reference-only root and same component overlap', async () => {
    const first = manifest('first', { extensions: [{ id: 'shared', version: 'v1.0.0' }] });
    const second = manifest('second', { extensions: [{ id: 'shared', version: '1.0.0' }] });
    const root = manifest('root', { bundles: [ref('first'), ref('second')] });
    const expanded = await expandManifest(root, new FakeBundleLoader(loaded([first, second])));
    expect(expanded.components.map((c) => c.id)).toEqual(['shared']);
    expect(origin(expanded, 'extensions', 'shared').origin).toEqual(['first']);
  });

  test('a shared bundle is loaded once', async () => {
    const shared = manifest('shared', { extensions: [{ id: 'shared-ext', version: '1.0.0' }] });
    const left = manifest('left', { bundles: [ref('shared')] });
    const right = manifest('right', { bundles: [ref('shared')] });
    const root = manifest('root', { bundles: [ref('left'), ref('right')] });
    const loader = new FakeBundleLoader(loaded([shared, left, right]));
    const expanded = await expandManifest(root, loader);
    expect(loader.loadCalls.filter(([id]) => id === 'shared').length).toBe(1);
    expect(expanded.components.map((c) => c.id)).toEqual(['shared-ext']);
  });

  test('a shorter route updates the override and reference metadata', async () => {
    const leaf = manifest('leaf', { extensions: [{ id: 'e', version: '1.0.0' }] });
    const long = manifest('long', { bundles: [ref('leaf')] });
    const root = manifest('root', {
      bundles: [ref('long'), ref('leaf')],
      extensions: [{ id: 'e', version: '2.0.0' }],
    });
    const loader = new FakeBundleLoader(loaded([leaf, long]));
    const expanded = await expandManifest(root, loader);
    expect(loader.loadCalls.filter(([id]) => id === 'leaf').length).toBe(1);
    expect(origin(expanded, 'extensions', 'e').origin).toEqual([]);
    expect(expanded.references.find((r) => r.id === 'leaf')!.via).toEqual([]);
    expect(expanded.warnings.length).toBe(1);
    expect(expanded.warnings[0]).toContain('root → leaf');
    expect(expanded.warnings[0]).not.toContain('root → long → leaf');
  });

  test('a shared dependency override is merged once', async () => {
    const dependency = manifest('dependency', { extensions: [{ id: 'e', version: '1.0.0' }] });
    const first = manifest('first', { bundles: [ref('dependency')] });
    const second = manifest('second', { bundles: [ref('dependency')] });
    const root = manifest('root', {
      bundles: [ref('first'), ref('second')],
      extensions: [{ id: 'e', version: '2.0.0' }],
    });
    const expanded = await expandManifest(root, new FakeBundleLoader(loaded([dependency, first, second])));
    const o = origin(expanded, 'extensions', 'e');
    expect(expanded.warnings.length).toBe(1);
    expect(o.overrides.length).toBe(1);
    expect(o.overrides[0].origin).toEqual(['first', 'dependency']);
    expect(expanded.warnings[0]).toContain('root → first → dependency');
    expect(expanded.warnings[0]).not.toContain('root → second → dependency');
  });

  test('agreeing copies merge override histories regardless of order', async () => {
    const leaf = manifest('leaf', { extensions: [{ id: 'shared', version: '1.0.0' }] });
    const plain = manifest('plain', { extensions: [{ id: 'shared', version: '2.0.0' }] });
    const overriding = manifest('overriding', {
      bundles: [ref('leaf')],
      extensions: [{ id: 'shared', version: '2.0.0' }],
    });
    for (const ids of [
      ['plain', 'overriding'],
      ['overriding', 'plain'],
    ]) {
      const root = manifest('root', { bundles: ids.map((id) => ref(id)) });
      const expanded = await expandManifest(root, new FakeBundleLoader(loaded([leaf, plain, overriding])));
      const overrides = origin(expanded, 'extensions', 'shared').overrides;
      expect(overrides.map((o) => [o.component.version, [...o.origin]])).toEqual([['1.0.0', ['overriding', 'leaf']]]);
    }
  });

  test('an agreeing copy keeps the first spelling and the shorter origin', async () => {
    const dependency = manifest('dependency', { extensions: [{ id: 'e', version: 'v1.0.0' }] });
    const first = manifest('first', { bundles: [ref('dependency')] });
    const root = manifest('root', { bundles: [ref('first'), ref('dependency')] });
    const expanded = await expandManifest(root, new FakeBundleLoader(loaded([dependency, first])));
    expect(expanded.components[0].version).toBe('v1.0.0');
    expect(origin(expanded, 'extensions', 'e').origin).toEqual(['dependency']);
  });

  test('an own override records all fields at its own position', async () => {
    const child = manifest('child', {
      presets: [{ id: 'style', version: '1.0.0', source: 'a', priority: 10, strategy: 'append' }],
    });
    const root = manifest('root', {
      bundles: [ref('child')],
      presets: [{ id: 'style', version: '2.0.0', source: 'b', priority: 20, strategy: 'replace' }],
    });
    const expanded = await expandManifest(root, new FakeBundleLoader(loaded([child])));
    const o = origin(expanded, 'presets', 'style');
    expect(o.origin).toEqual([]);
    expect(o.overrides[0].origin).toEqual(['child']);
    const warning = expanded.warnings[0];
    expect(warning).toContain('version 2.0.0 and source b and priority 20 and strategy replace (root) overrides');
    for (const part of ['version 1.0.0', 'source a', 'priority 10', 'strategy append']) {
      expect(warning).toContain(`${part} from root → child`);
    }
    expect(expanded.warnings.filter((w) => w === warning).length).toBe(1);
  });

  test('an extension priority-only override is reported', async () => {
    const child = manifest('child', { extensions: [{ id: 'style', version: '1.0.0', priority: 10 }] });
    const root = manifest('root', { bundles: [ref('child')], extensions: [{ id: 'style', version: '1.0.0', priority: 20 }] });
    const expanded = await expandManifest(root, new FakeBundleLoader(loaded([child])));
    expect(expanded.components[0].priority).toBe(20);
    expect(origin(expanded, 'extensions', 'style').overrides[0].origin).toEqual(['child']);
    expect(expanded.warnings[0]).toContain('priority 20 (root) overrides priority 10 from root → child');
  });

  test('own overrides and agreeing copies keep their own positions', async () => {
    const child = manifest('child', {
      extensions: [
        { id: 'a', version: '1.0.0' },
        { id: 'b', version: '1.0.0' },
      ],
    });
    const root = manifest('root', {
      bundles: [ref('child')],
      extensions: [
        { id: 'c', version: '1.0.0' },
        { id: 'a', version: '2.0.0' },
      ],
    });
    let expanded = await expandManifest(root, new FakeBundleLoader(loaded([child])));
    expect(expanded.components.map((c) => c.id)).toEqual(['b', 'c', 'a']);

    const agreeingRoot = manifest('agreeing-root', {
      bundles: [ref('child')],
      extensions: [
        { id: 'c', version: '1.0.0' },
        { id: 'a', version: '1.0.0' },
      ],
    });
    expanded = await expandManifest(agreeingRoot, new FakeBundleLoader(loaded([child])));
    expect(expanded.components.map((c) => c.id)).toEqual(['b', 'c', 'a']);
    expect(expanded.warnings).toEqual([]);
  });

  test('a nested override is resolved before the parent merge', async () => {
    const leaf = manifest('leaf', { extensions: [{ id: 'e', version: '1.0.0' }] });
    const child = manifest('child', { bundles: [ref('leaf')], extensions: [{ id: 'e', version: '2.0.0' }] });
    const root = manifest('root', { bundles: [ref('child')] });
    const expanded = await expandManifest(root, new FakeBundleLoader(loaded([leaf, child])));
    expect(expanded.components[0].version).toBe('2.0.0');
    expect(origin(expanded, 'extensions', 'e').origin).toEqual(['child']);
    expect(expanded.warnings[0]).toContain('root → child → leaf');
  });

  const siblingCases: Array<[string, Record<string, unknown>, Record<string, unknown>, string, string, string]> = [
    ['extensions', { version: '1.0.0' }, { version: '2.0.0' }, 'version', '1.0.0', '2.0.0'],
    ['extensions', { version: '1.0.0' }, { version: null }, 'version', '1.0.0', '<unpinned>'],
    ['extensions', { source: 'a' }, { source: 'b' }, 'source', 'a', 'b'],
    ['extensions', { source: null }, { source: 'a' }, 'source', '<unset>', 'a'],
    ['extensions', { priority: 10 }, { priority: 20 }, 'priority', '10', '20'],
    ['presets', { priority: 1 }, { priority: 2 }, 'priority', '1', '2'],
    ['presets', { strategy: 'append' }, { strategy: 'replace' }, 'strategy', 'append', 'replace'],
  ];
  test.each(siblingCases)('sibling %s conflict on %p reports values and chains', async (kind, a, b, field, va, vb) => {
    const first = manifest('first', { [kind]: [{ id: 'e', ...a }] });
    const second = manifest('second', { [kind]: [{ id: 'e', ...b }] });
    const root = manifest('root', { bundles: [ref('first'), ref('second')] });
    const message = await rejects(expandManifest(root, new FakeBundleLoader(loaded([first, second]))), field);
    expect(message).toContain(`${field} ${va} (root → first)`);
    expect(message).toContain(`${field} ${vb} (root → second)`);
    expect(message).toContain("declare 'e' in 'root'");
  });

  test('a multi-field preset conflict reports an unset source', async () => {
    const first = manifest('first', { presets: [{ id: 'p', version: '1.0.0', source: 'a', priority: 1, strategy: 'append' }] });
    const second = manifest('second', { presets: [{ id: 'p', version: '1.0.0', priority: 2, strategy: 'replace' }] });
    const root = manifest('root', { bundles: [ref('first'), ref('second')] });
    const message = await rejects(expandManifest(root, new FakeBundleLoader(loaded([first, second]))), 'conflicts');
    expect(message).toContain('source a; priority 1; strategy append (root → first)');
    expect(message).toContain('source <unset>; priority 2; strategy replace (root → second)');
  });

  test.each([
    [[manifest('a', { bundles: [ref('a')] })], 'root → a → a'],
    [[manifest('a', { bundles: [ref('b')] }), manifest('b', { bundles: [ref('a')] })], 'root → a → b → a'],
    [[manifest('a', { bundles: [ref('root')] }), manifest('root')], 'root → a → root'],
  ] as Array<[BundleManifest[], string]>)('cycles are rejected with the full chain (%#)', async (definitions, chain) => {
    const root = manifest('root', { bundles: [ref('a')] });
    const message = await rejects(expandManifest(root, new FakeBundleLoader(loaded(definitions))), 'cycle');
    expect(message).toContain(chain);
  });

  test('a version conflict names both chains; matching spellings are accepted', async () => {
    const first = manifest('first', { bundles: [ref('leaf')] });
    const second = manifest('second', { bundles: [{ id: 'leaf', version: '2.0.0' }] });
    const leaf = manifest('leaf');
    const root = manifest('root', { bundles: [ref('first'), ref('second')] });
    const message = await rejects(expandManifest(root, new FakeBundleLoader(loaded([first, second, leaf]))), 'versions');
    expect(message).toContain('1.0.0 (root → first)');
    expect(message).toContain('2.0.0 (root → second)');
    expect(message).toContain('choose referencing releases that pin the same version');

    const acceptedFirst = manifest('accepted-first', { bundles: [{ id: 'leaf', version: 'v1.0.0' }] });
    const acceptedSecond = manifest('accepted-second', { bundles: [ref('leaf')] });
    const acceptedRoot = manifest('accepted-root', { bundles: [ref('accepted-first'), ref('accepted-second')] });
    const bundles = loaded([acceptedFirst, acceptedSecond, leaf]);
    bundles.set(FakeBundleLoader.key('leaf', 'v1.0.0'), new LoadedBundle(leaf, 'default', true));
    const loader = new FakeBundleLoader(bundles);
    const accepted = await expandManifest(acceptedRoot, loader);
    expect(accepted.references.map((r) => r.id)).toEqual(['accepted-first', 'leaf', 'accepted-second']);
    const leafRef = accepted.references.find((r) => r.id === 'leaf')!;
    expect(leafRef.version).toBe('v1.0.0');
    expect(leafRef.via).toEqual(['accepted-first']);
    expect(loader.loadCalls.filter(([id, v]) => id === 'leaf' && v === 'v1.0.0').length).toBe(1);
  });

  test('the depth limit accepts ten levels and rejects eleven', async () => {
    const bundles: BundleManifest[] = [];
    for (let index = 0; index < 10; index++) {
      bundles.push(manifest(`b${index}`, { bundles: index === 9 ? [] : [ref(`b${index + 1}`)] }));
    }
    const root = manifest('root', { bundles: [ref('b0')] });
    const expanded = await expandManifest(root, new FakeBundleLoader(loaded(bundles)));
    expect(expanded.references.map((r) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `b${i}`));

    bundles.push(manifest('b10'));
    bundles[9] = manifest('b9', { bundles: [ref('b10')] });
    const message = await rejects(expandManifest(root, new FakeBundleLoader(loaded(bundles))), 'depth exceeds 10');
    expect(message).toContain('root → b0 → b1 → b2 → b3 → b4 → b5 → b6 → b7 → b8 → b9 → b10');
  });

  test('a cached subtree rechecks depth for a deeper route', async () => {
    const build = (levels: number) => {
      const leaf = manifest('leaf');
      const cached = manifest('cached', { bundles: [ref('leaf')] });
      const parent = manifest('parent', { bundles: [ref('cached')] });
      let current = parent;
      const definitions = [leaf, cached, parent];
      for (let index = 0; index < levels; index++) {
        current = manifest(`deep${index}`, { bundles: [ref(current.bundle.id)] });
        definitions.push(current);
      }
      return { root: manifest('root', { bundles: [ref('cached'), ref(current.bundle.id)] }), definitions };
    };
    let { root, definitions } = build(8);
    const message = await rejects(expandManifest(root, new FakeBundleLoader(loaded(definitions))), 'depth exceeds 10');
    expect(message).toContain(
      'root → deep7 → deep6 → deep5 → deep4 → deep3 → deep2 → deep1 → deep0 → parent → cached → leaf',
    );
    ({ root, definitions } = build(7));
    const expanded = await expandManifest(root, new FakeBundleLoader(loaded(definitions)));
    expect(expanded.references.map((r) => r.id)).toEqual([
      'cached',
      'leaf',
      'deep6',
      'deep5',
      'deep4',
      'deep3',
      'deep2',
      'deep1',
      'deep0',
      'parent',
    ]);
  });

  test('the reference limit is checked before loading', async () => {
    const refs = Array.from({ length: MAX_REFERENCED_BUNDLES + 1 }, (_, i) => ref(`b${i}`));
    const root = manifest('root', { bundles: refs });
    const children = Array.from({ length: MAX_REFERENCED_BUNDLES }, (_, i) => manifest(`b${i}`));
    const loader = new FakeBundleLoader(loaded(children));
    await rejects(expandManifest(root, loader), '50');
    expect(loader.loadCalls).toEqual(Array.from({ length: MAX_REFERENCED_BUNDLES }, (_, i) => [`b${i}`, '1.0.0']));
  });

  test.each([false, true])('an explicit source mismatch is rejected (explicit first: %p)', async (explicitFirst) => {
    const child = manifest('child');
    const left = manifest('left', { bundles: [ref('child')] });
    const right = manifest('right', { bundles: [ref('child', { source: 'other' })] });
    const refs = explicitFirst ? [ref('right'), ref('left')] : [ref('left'), ref('right')];
    const root = manifest('root', { bundles: refs });
    const loader = new FakeBundleLoader(loaded([child, left, right]));
    await rejects(expandManifest(root, loader), 'requires source');
    if (explicitFirst) {
      expect(loader.loadCalls.slice(0, 2)).toEqual([
        ['right', '1.0.0'],
        ['child', '1.0.0'],
      ]);
    }
  });

  test.each([false, true])('omitted and matching explicit sources reuse the cache (%p)', async (leftExplicit) => {
    const child = manifest('child');
    const left = manifest('left', { bundles: [ref('child', leftExplicit ? { source: 'default' } : {})] });
    const right = manifest('right', { bundles: [ref('child', leftExplicit ? {} : { source: 'default' })] });
    const root = manifest('root', { bundles: [ref('left'), ref('right')] });
    const loader = new FakeBundleLoader(loaded([child, left, right]));
    const expanded = await expandManifest(root, loader);
    expect(expanded.references.filter((r) => r.id === 'child').length).toBe(1);
    expect(loader.loadCalls.filter(([id]) => id === 'child').length).toBe(1);
  });

  test('the loaded manifest identity and version are verified', async () => {
    const root = manifest('root', { bundles: [ref('child')] });
    await rejects(
      expandManifest(
        root,
        new FakeBundleLoader(new Map([[FakeBundleLoader.key('child', '1.0.0'), new LoadedBundle(manifest('other'), 'default', true)]])),
      ),
      'loaded manifest',
    );
    await rejects(
      expandManifest(
        root,
        new FakeBundleLoader(
          new Map([[FakeBundleLoader.key('child', '1.0.0'), new LoadedBundle(manifest('child', { version: '2.0.0' }), 'default', true)]]),
        ),
      ),
      'loaded manifest version',
    );
  });

  test('kind order is stable after expansion', async () => {
    const child = manifest('child', {
      workflows: [{ id: 'w', version: '1.0.0' }],
      extensions: [{ id: 'e', version: '1.0.0' }],
    });
    const root = manifest('root', {
      bundles: [ref('child')],
      steps: [{ id: 's' }],
      presets: [{ id: 'p', version: '1.0.0', priority: 1, strategy: 'append' }],
    });
    const expanded = await expandManifest(root, new FakeBundleLoader(loaded([child])));
    expect(expanded.components.map((c) => c.kind)).toEqual(['extensions', 'presets', 'steps', 'workflows']);
  });

  test('source mismatch on a cache hit, and loader error context', async () => {
    const child = manifest('child');
    const left = manifest('left', { bundles: [ref('child')] });
    const right = manifest('right', { bundles: [ref('child', { source: 'other' })] });
    let root = manifest('root', { bundles: [ref('left'), ref('right')] });
    const message = await rejects(expandManifest(root, new FakeBundleLoader(loaded([child, left, right]))), "winning catalog is 'default'");
    expect(message.split('Bundle reference').length - 1).toBe(1);

    const missing = manifest('root', { bundles: [ref('missing')] });
    await rejects(expandManifest(missing, new FakeBundleLoader(new Map())), 'Cannot resolve bundle reference missing@1.0.0 (root)');
    const nested = manifest('nested', { bundles: [ref('missing')] });
    root = manifest('root', { bundles: [ref('nested')] });
    await rejects(
      expandManifest(root, new FakeBundleLoader(loaded([nested]))),
      'Cannot resolve bundle reference missing@1.0.0 (root → nested)',
    );
  });

  test('loader programming errors are not rewritten as resolution errors', async () => {
    const root = manifest('root', { bundles: [ref('child')] });
    const broken: BundleLoader = {
      load() {
        throw new TypeError('loader contract violated');
      },
    };
    let caught: unknown;
    try {
      await expandManifest(root, broken);
    } catch (exc) {
      caught = exc;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as Error).message).toBe('loader contract violated');
  });

  test('requireInstallable and formatting', async () => {
    const child = manifest('community');
    const root = manifest('root', { bundles: [ref('community')] });
    const expanded = await expandManifest(root, new FakeBundleLoader(loaded([child], { installAllowed: false })));
    expect(() => requireInstallable(expanded)).toThrow('discovery-only');
    expect(discoveryOnlyMessages(expanded)).toEqual([
      "Bundle 'community' (root → community) resolves only from discovery-only source 'default'; it cannot be installed from there.",
    ]);
    expect(formatChain(['root', 'community'])).toBe('root → community');
  });

  test('component differences use strict pinned rules', () => {
    expect(
      componentDifferences(new ComponentRef({ kind: 'steps', id: 'lint' }), new ComponentRef({ kind: 'steps', id: 'lint', version: '1.0.0' })),
    ).toEqual(['version']);
    expect(
      componentDifferences(
        new ComponentRef({ kind: 'extensions', id: 'e', version: 'v1.0.0' }),
        new ComponentRef({ kind: 'extensions', id: 'e', version: '1.0.0' }),
      ),
    ).toEqual([]);
    // An omitted extension priority installs as the default (10).
    expect(
      componentDifferences(
        new ComponentRef({ kind: 'extensions', id: 'e', version: '1.0.0' }),
        new ComponentRef({ kind: 'extensions', id: 'e', version: '1.0.0', priority: 10 }),
      ),
    ).toEqual([]);
  });

  test.each([false, true])('sibling omitted and default extension priority agree (omitted first: %p)', async (omittedFirst) => {
    const a = manifest('a', { extensions: [{ id: 'e', version: '1.0.0' }] });
    const b = manifest('b', { extensions: [{ id: 'e', version: '1.0.0', priority: 10 }] });
    const root = manifest('root', { bundles: omittedFirst ? [ref('a'), ref('b')] : [ref('b'), ref('a')] });
    const expanded = await expandManifest(root, new FakeBundleLoader(loaded([a, b])));
    expect(expanded.components.length).toBe(1);
    expect(expanded.warnings).toEqual([]);
  });

  test('a non-default sibling extension priority still conflicts with an omitted one', async () => {
    const a = manifest('a', { extensions: [{ id: 'e', version: '1.0.0' }] });
    const b = manifest('b', { extensions: [{ id: 'e', version: '1.0.0', priority: 5 }] });
    const root = manifest('root', { bundles: [ref('a'), ref('b')] });
    await rejects(expandManifest(root, new FakeBundleLoader(loaded([a, b]))), 'priority <unset> (root → a) vs priority 5 (root → b)');
  });
});
