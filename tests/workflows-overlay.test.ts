/**
 * Tests for workflow overlays: schema validation, the merge engine, layer
 * sources, the resolver, and the ``specify workflow overlay`` CLI
 * (ports of upstream tests/workflows/test_overlay_*.py and
 * tests/specify_cli/workflows/overlay/test_command_*.py).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { console as stdoutConsole, errConsole } from '../src/console.js';
import { dumpYaml, parseYaml } from '../src/yaml.js';
import { runWorkflowOverlayCommand } from '../src/workflows/overlay/commands.js';
import { mergeSteps, findStep, OverlayLayer, validateEdits, type ComposedStep } from '../src/workflows/overlay/merge.js';
import { Overlay, validateOverlayYaml, type OverlayEdit } from '../src/workflows/overlay/schema.js';
import { BaseWorkflowSource, OverlayLoadError, ProjectOverlaySource } from '../src/workflows/overlay/layer-sources.js';
import { WorkflowResolver } from '../src/workflows/overlay/resolver.js';
import { findOverlayFile, workflowResolve } from '../src/workflows/overlay/operations.js';

// ============================================================================
// Helpers
// ============================================================================

type Dict = Record<string, unknown>;

function step(id: string, extra: Dict = {}): Dict {
  return { id, type: 'command', command: 'speckit.specify', ...extra };
}

function edit(operation: OverlayEdit['operation'], anchor: string, s: Dict | null = null): OverlayEdit {
  return { operation, anchor, step: s };
}

function ov(id: string, priority: number, edits: OverlayEdit[]): Overlay {
  return new Overlay({ id, extends: 'wf', priority, edits });
}

function ids(steps: unknown[]): string[] {
  return (steps as Dict[]).map((s) => s.id as string);
}

let tmp: string;
let projectDir: string;
let prevCwd: string;
let output: string;
let prevOut: unknown;
let prevErr: unknown;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wf-overlay-'));
  projectDir = join(tmp, 'proj');
  mkdirSync(join(projectDir, '.specify'), { recursive: true });
  prevCwd = process.cwd();
  process.chdir(projectDir);
  output = '';
  prevOut = (stdoutConsole as unknown as { opts: Dict }).opts.file;
  prevErr = (errConsole as unknown as { opts: Dict }).opts.file;
  stdoutConsole.file = { write: (c: string) => (output += c) };
  errConsole.file = { write: (c: string) => (output += c) };
  delete process.env.SPECIFY_INIT_DIR;
});

afterEach(() => {
  process.chdir(prevCwd);
  (stdoutConsole as unknown as { opts: Dict }).opts.file = prevOut;
  (errConsole as unknown as { opts: Dict }).opts.file = prevErr;
  rmSync(tmp, { recursive: true, force: true });
});

function writeWorkflow(workflowId: string, data: Dict): string {
  const dir = join(projectDir, '.specify', 'workflows', workflowId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'workflow.yml');
  writeFileSync(p, dumpYaml(data), 'utf-8');
  return p;
}

function writeOverlay(workflowId: string, fileStem: string, data: Dict | string): string {
  const dir = join(projectDir, '.specify', 'workflows', 'overlays', workflowId);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${fileStem}.yml`);
  writeFileSync(p, typeof data === 'string' ? data : dumpYaml(data), 'utf-8');
  return p;
}

const BASE_WF = {
  schema_version: '1.0',
  workflow: { id: 'wf', name: 'WF', version: '1.0.0' },
  steps: [{ id: 'a', type: 'command', command: 'echo' }],
};

function readYaml(p: string): Dict {
  return parseYaml(readFileSync(p, 'utf-8')) as Dict;
}

function bakFiles(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.includes('bak'));
}

// ============================================================================
// Schema
// ============================================================================

describe('validateOverlayYaml', () => {
  test('shorthand insert_after', () => {
    const [overlay, errors] = validateOverlayYaml({
      id: 'ov',
      extends: 'wf',
      priority: 10,
      edits: [{ insert_after: 'a', step: { id: 'b', type: 'command', command: 'echo' } }],
    });
    expect(errors).toEqual([]);
    expect(overlay!.edits).toEqual([edit('insert_after', 'a', { id: 'b', type: 'command', command: 'echo' })]);
  });

  test('shorthand and explicit mixed list', () => {
    const [overlay, errors] = validateOverlayYaml({
      id: 'ov',
      extends: 'wf',
      edits: [
        { insert_after: 'a', step: { id: 'b', type: 'command', command: 'echo' } },
        { operation: 'remove', anchor: 'c' },
      ],
    });
    expect(errors).toEqual([]);
    expect(overlay!.edits[1]).toEqual(edit('remove', 'c'));
  });

  for (const [first, second] of [
    ['remove', 'insert_after'],
    ['insert_after', 'remove'],
  ]) {
    test(`multiple operation keys reported in declaration order (${first} first)`, () => {
      const [overlay, errors] = validateOverlayYaml({ id: 'ov', extends: 'wf', edits: [{ [first]: 'a', [second]: 'a' }] });
      expect(overlay).toBeNull();
      expect(errors).toEqual([`Edit at index 0 has multiple operation keys: '${first}', '${second}'.`]);
    });

    test(`mixed shorthand names first declared key (${first} first)`, () => {
      const [, errors] = validateOverlayYaml({
        id: 'ov',
        extends: 'wf',
        edits: [{ [first]: 'a', [second]: 'a', operation: 'replace' }],
      });
      expect(errors).toEqual([
        `Edit at index 0 mixes shorthand operation key ('${first}') with explicit 'operation' field.`,
      ]);
    });
  }

  test('no operation lists sorted operations', () => {
    const [, errors] = validateOverlayYaml({ id: 'ov', extends: 'wf', edits: [{ destroy: 'a' }] });
    expect(errors).toEqual([
      "Edit at index 0 has no operation; expected one of ['insert_after', 'insert_before', 'remove', 'replace'].",
    ]);
  });

  test('non-string operation rejected without throwing', () => {
    for (const operation of [{ insert_after: 'a' }, ['insert_after']]) {
      const [overlay, errors] = validateOverlayYaml({
        id: 'ov',
        extends: 'wf',
        edits: [{ operation, anchor: 'a', step: { id: 'b' } }],
      });
      expect(overlay).toBeNull();
      expect(errors.some((e) => e.includes('invalid operation'))).toBe(true);
    }
    const [, errors] = validateOverlayYaml({ id: 'ov', extends: 'wf', edits: [{ operation: { insert_after: 'a' } }] });
    expect(errors).toEqual(["Edit at index 0 has invalid operation {'insert_after': 'a'}."]);
  });

  test('remove must not include step', () => {
    const [, errors] = validateOverlayYaml({ id: 'ov', extends: 'wf', edits: [{ remove: 'a', step: { id: 'b' } }] });
    expect(errors).toEqual(["Edit at index 0 ('remove') must not include 'step'."]);
  });

  test('step id with colon rejected', () => {
    const [, errors] = validateOverlayYaml({ id: 'ov', extends: 'wf', edits: [{ replace: 'a', step: { id: 'x:y' } }] });
    expect(errors).toEqual([
      "Edit at index 0 step id 'x:y' contains ':' which is reserved for engine-generated nested IDs.",
    ]);
  });

  test('invalid ids and extends rejected', () => {
    for (const bad of ['../ov', 'a/b', 'a\\b', '.', '..', '', 'overlay\n', 'ov\nerlay']) {
      const [o1, e1] = validateOverlayYaml({ id: bad, extends: 'wf', edits: [{ remove: 'a' }] });
      expect(o1).toBeNull();
      expect(e1.some((e) => e.toLowerCase().includes('id'))).toBe(true);
      const [o2, e2] = validateOverlayYaml({ id: 'ov', extends: bad, edits: [{ remove: 'a' }] });
      expect(o2).toBeNull();
      expect(e2.some((e) => e.toLowerCase().includes('extends'))).toBe(true);
    }
    const [, e3] = validateOverlayYaml({ id: '../ov', extends: 'wf', edits: [{ remove: 'a' }] });
    expect(e3[0]).toBe(
      "Overlay 'id' '../ov' contains invalid characters; only lowercase letters, digits, and hyphens are allowed.",
    );
  });

  test('reserved workflow ids rejected', () => {
    for (const ext of ['overlays', 'runs', 'steps']) {
      const [, errors] = validateOverlayYaml({ id: 'ov', extends: ext, edits: [{ remove: 'a' }] });
      expect(errors).toEqual([`Overlay 'extends' '${ext}' is reserved.`]);
    }
  });

  test('invalid or missing priority defaults to ten', () => {
    for (const priority of [undefined, true, 'invalid', 0]) {
      const data: Dict = { id: 'ov', extends: 'wf', edits: [{ remove: 'a' }] };
      if (priority !== undefined) data.priority = priority;
      const [overlay, errors] = validateOverlayYaml(data);
      expect(errors).toEqual([]);
      expect(overlay!.priority).toBe(10);
    }
  });

  test('non-mapping manifest and edits shape errors', () => {
    expect(validateOverlayYaml([])[1]).toEqual(['Overlay manifest must be a mapping.']);
    expect(validateOverlayYaml({ id: 'ov', extends: 'wf' })[1]).toEqual(["Overlay 'edits' is required and must be a list."]);
    expect(validateOverlayYaml({ id: 'ov', extends: 'wf', edits: [] })[1]).toEqual(["Overlay 'edits' must be a non-empty list."]);
    expect(validateOverlayYaml({ id: 'ov', extends: 'wf', edits: [{ remove: 'a' }], enabled: 'no' })[1]).toEqual([
      "Overlay 'enabled' must be a boolean.",
    ]);
  });
});

// ============================================================================
// Merge engine
// ============================================================================

describe('findStep', () => {
  test('flat, nested, cases, and not fan-out templates', () => {
    const steps = [step('a'), step('b')];
    expect(findStep(steps, 'b')).toEqual([steps, 1]);
    expect(findStep(steps, 'missing')).toBeNull();
    const nested: Dict[] = [
      { id: 'if-1', type: 'if', then: [step('then-a')], else: [step('else-b')] },
      { id: 'sw', type: 'switch', cases: { one: [step('case-a')] }, default: [step('default-c')] },
      { id: 'fan', type: 'fan-out', step: { id: 'template-x' } },
    ];
    expect(findStep(nested, 'then-a')![0]).toBe(nested[0].then as unknown[]);
    expect(findStep(nested, 'else-b')![0]).toBe(nested[0].else as unknown[]);
    expect(findStep(nested, 'case-a')![1]).toBe(0);
    expect(findStep(nested, 'default-c')![1]).toBe(0);
    expect(findStep(nested, 'template-x')).toBeNull();
  });
});

describe('mergeSteps', () => {
  test('single overlay insert_after with attribution', () => {
    const [steps, attribution] = mergeSteps(
      [step('a'), step('b')],
      [new OverlayLayer(ov('ov1', 10, [edit('insert_after', 'a', step('new'))]), 'project:ov1')],
    );
    expect(ids(steps)).toEqual(['a', 'new', 'b']);
    expect(attribution).toEqual<ComposedStep[]>([
      { step_id: 'a', source: 'base' },
      { step_id: 'new', source: 'project:ov1' },
      { step_id: 'b', source: 'base' },
    ]);
  });

  test('higher priority insert lands closer to the anchor', () => {
    const low = ov('low', 5, [edit('insert_after', 'a', step('low-step'))]);
    const high = ov('high', 10, [edit('insert_after', 'a', step('high-step'))]);
    const [steps] = mergeSteps([step('a')], [new OverlayLayer(low, 'project:low'), new OverlayLayer(high, 'project:high')]);
    expect(ids(steps)).toEqual(['a', 'high-step', 'low-step']);
  });

  test('multiple insert_after from one overlay preserve declared order', () => {
    const o = ov('ov1', 10, [edit('insert_after', 'a', step('x')), edit('insert_after', 'a', step('y'))]);
    const [steps] = mergeSteps([step('a'), step('b')], [new OverlayLayer(o, 'project:ov1')]);
    expect(ids(steps)).toEqual(['a', 'x', 'y', 'b']);
  });

  test('targeting an overlay-introduced step raises', () => {
    const insert = ov('insert', 5, [edit('insert_after', 'a', step('inserted'))]);
    const replace = ov('replace', 10, [edit('replace', 'inserted', step('replaced'))]);
    expect(() =>
      mergeSteps([step('a')], [new OverlayLayer(insert, 'i'), new OverlayLayer(replace, 'r')]),
    ).toThrow("Anchor 'inserted' not found in workflow steps.");
  });

  test('does not mutate base', () => {
    const base = [step('a'), { id: 'w', type: 'while', steps: [step('inner')] }];
    const snapshot = JSON.stringify(base);
    mergeSteps(base, [new OverlayLayer(ov('o', 10, [edit('insert_after', 'inner', step('x'))]), 'p')]);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  test('inserts apply around a replaced anchor', () => {
    const low = ov('low', 5, [edit('insert_after', 'build', step('test'))]);
    const high = ov('high', 10, [edit('replace', 'build', step('compile'))]);
    const [steps, attribution] = mergeSteps([step('build')], [new OverlayLayer(low, 'project:low'), new OverlayLayer(high, 'project:high')]);
    expect(ids(steps)).toEqual(['compile', 'test']);
    expect(attribution).toEqual([
      { step_id: 'compile', source: 'project:high' },
      { step_id: 'test', source: 'project:low' },
    ]);
  });

  test('higher replace wins after lower remove', () => {
    const low = ov('low', 5, [edit('remove', 'a')]);
    const high = ov('high', 10, [edit('replace', 'a', step('a2'))]);
    const [steps] = mergeSteps([step('a')], [new OverlayLayer(low, 'l'), new OverlayLayer(high, 'h')]);
    expect(ids(steps)).toEqual(['a2']);
  });

  test('replace of composite records nested sources', () => {
    const replacement = { id: 'if-new', type: 'if', then: [step('t1')], else: [step('e1')] };
    const [, attribution] = mergeSteps([step('a')], [new OverlayLayer(ov('o', 10, [edit('replace', 'a', replacement)]), 'project:o')]);
    expect(attribution).toEqual([
      { step_id: 'if-new', source: 'project:o' },
      { step_id: 't1', source: 'project:o' },
      { step_id: 'e1', source: 'project:o' },
    ]);
  });

  test('ancestor conflicts raise', () => {
    const base = [{ id: 'parent', type: 'while', steps: [step('child')] }];
    expect(() =>
      mergeSteps(base, [new OverlayLayer(ov('o', 10, [edit('remove', 'parent'), edit('insert_after', 'child', step('x'))]), 'p')]),
    ).toThrow(
      "Overlay anchor conflict(s) detected:\n  - Anchor conflict: 'parent' is an ancestor of 'child'. Targeting both anchors in the same overlay set produces order-dependent results; restructure edits to avoid nesting.",
    );
    // Insert-only on an ancestor is safe.
    const [steps] = mergeSteps(base, [
      new OverlayLayer(ov('o', 10, [edit('insert_after', 'parent', step('x')), edit('insert_after', 'child', step('y'))]), 'p'),
    ]);
    expect(ids(steps)).toEqual(['parent', 'x']);
    expect(ids((steps[0] as Dict).steps as unknown[])).toEqual(['child', 'y']);
  });

  for (const [op, expected] of [
    ['insert_after', ['implement', 'lint', 'tail']],
    ['insert_before', ['lint', 'implement', 'tail']],
  ] as const) {
    test(`same overlay replace survives its own trailing ${op}`, () => {
      const o = ov('ov', 10, [
        edit('replace', 'implement', step('implement', { command: 'custom.impl' })),
        edit(op, 'implement', step('lint')),
      ]);
      const [steps] = mergeSteps([step('implement'), step('tail')], [new OverlayLayer(o, 'project:ov')]);
      expect(ids(steps)).toEqual([...expected]);
      expect((steps as Dict[]).find((s) => s.id === 'implement')!.command).toBe('custom.impl');
    });
  }

  test('remove then insert_after in same overlay keeps base step', () => {
    const o = ov('ov', 10, [edit('remove', 'implement'), edit('insert_after', 'implement', step('lint'))]);
    const [steps] = mergeSteps([step('implement'), step('tail')], [new OverlayLayer(o, 'p')]);
    expect(ids(steps)).toEqual(['implement', 'lint', 'tail']);
  });

  test('replace + remove + trailing insert is unchanged (ambiguous layer)', () => {
    for (const fate of [
      [edit('replace', 'implement', step('implement', { command: 'custom.impl' })), edit('remove', 'implement')],
      [edit('remove', 'implement'), edit('replace', 'implement', step('implement', { command: 'custom.impl' }))],
    ]) {
      const o = ov('ov', 10, [...fate, edit('insert_after', 'implement', step('lint'))]);
      const [steps] = mergeSteps([step('implement'), step('tail')], [new OverlayLayer(o, 'p')]);
      expect(ids(steps)).toEqual(['implement', 'lint', 'tail']);
      expect((steps as Dict[])[0].command).not.toBe('custom.impl');
    }
  });

  test('higher-priority insert-only overlay keeps base step', () => {
    const replacer = ov('low', 5, [edit('replace', 'implement', step('implement', { command: 'low.impl' }))]);
    const inserter = ov('high', 10, [edit('insert_after', 'implement', step('lint'))]);
    const [steps] = mergeSteps([step('implement')], [new OverlayLayer(replacer, 'l'), new OverlayLayer(inserter, 'h')]);
    expect((steps as Dict[])[0].command).toBe('speckit.specify');
    expect(ids(steps)).toContain('lint');
  });
});

describe('validateEdits', () => {
  test('reports unknown anchors and colon ids', () => {
    expect(validateEdits([edit('insert_after', 'a', step('b'))], new Set(['a']))).toEqual([]);
    expect(validateEdits([edit('remove', 'zz')], new Set(['a']))).toEqual([
      "Edit 0: anchor 'zz' does not match any base step id.",
    ]);
    expect(validateEdits([edit('replace', 'a', step('x:y'))], new Set(['a']))).toEqual([
      "Edit 0: step id 'x:y' contains ':' which is reserved for engine-generated nested IDs.",
    ]);
  });
});

// ============================================================================
// Layer sources
// ============================================================================

describe('ProjectOverlaySource', () => {
  test('falsy non-mapping manifest reports shape error; empty document reports missing fields', () => {
    for (const raw of ['[]\n', 'false\n', '0\n', "''\n", 'null\n', '~\n']) {
      const p = writeOverlay('wf', 'bad', raw);
      try {
        new ProjectOverlaySource(projectDir).collect('wf');
        throw new Error('expected OverlayLoadError');
      } catch (exc) {
        expect(exc).toBeInstanceOf(OverlayLoadError);
        expect((exc as OverlayLoadError).errors).toEqual(['Overlay manifest must be a mapping.']);
      }
      rmSync(p);
    }
    writeOverlay('wf', 'empty', '# just a comment\n');
    try {
      new ProjectOverlaySource(projectDir).collect('wf');
      throw new Error('expected OverlayLoadError');
    } catch (exc) {
      expect((exc as OverlayLoadError).errors.some((e) => e.includes("'id'"))).toBe(true);
    }
  });

  test('disabled overlays skipped by default and listed on request; duplicates rejected', () => {
    writeOverlay('wf', 'ov1', { id: 'ov1', extends: 'wf', enabled: false, edits: [{ remove: 'a' }] });
    expect(new ProjectOverlaySource(projectDir).collect('wf')).toEqual([]);
    const all = new ProjectOverlaySource(projectDir).collect('wf', { includeDisabled: true });
    expect(all.map((l) => l.source)).toEqual(['project:ov1']);
    // Invalid-but-disabled overlays are skipped during resolution.
    writeOverlay('wf', 'broken', { id: 'broken', extends: 'wf', enabled: false });
    expect(new ProjectOverlaySource(projectDir).collect('wf')).toEqual([]);
    rmSync(join(projectDir, '.specify/workflows/overlays/wf/broken.yml'));
    writeOverlay('wf', 'dup', { id: 'ov1', extends: 'wf', enabled: false, edits: [{ remove: 'a' }] });
    expect(() => new ProjectOverlaySource(projectDir).collect('wf', { includeDisabled: true })).toThrow(
      /Duplicate overlay id 'ov1'; also declared in/,
    );
  });

  test('rejects unsafe ids and symlinked directories', () => {
    for (const bad of ['../wf', 'overlays', 'runs', 'steps', 'A']) {
      expect(() => new ProjectOverlaySource(projectDir).collect(bad)).toThrow(OverlayLoadError);
      expect(() => new BaseWorkflowSource(projectDir).collect(bad)).toThrow(OverlayLoadError);
    }
    const outside = join(tmp, 'outside');
    mkdirSync(outside);
    mkdirSync(join(projectDir, '.specify/workflows/overlays'), { recursive: true });
    symlinkSync(outside, join(projectDir, '.specify/workflows/overlays/wf'));
    expect(() => new ProjectOverlaySource(projectDir).collect('wf')).toThrow(/Symlinked overlay directories are not allowed/);
  });

  test('base workflow source', () => {
    expect(new BaseWorkflowSource(projectDir).collect('wf')).toEqual([]);
    writeWorkflow('wf', BASE_WF);
    const [layer] = new BaseWorkflowSource(projectDir).collect('wf');
    expect(layer.source).toBe('base');
    expect(layer.tier).toBe('base');
    expect(layer.priority).toBe(0);
  });
});

// ============================================================================
// Resolver
// ============================================================================

describe('WorkflowResolver', () => {
  test('composes overlays lower-wins and reports attribution', () => {
    writeWorkflow('wf', {
      ...BASE_WF,
      steps: [step('a'), step('b')],
    });
    writeOverlay('wf', 'first', { id: 'first', extends: 'wf', priority: 20, edits: [{ replace: 'a', step: step('a', { command: 'first' }) }] });
    writeOverlay('wf', 'second', { id: 'second', extends: 'wf', priority: 5, edits: [{ replace: 'a', step: step('a', { command: 'second' }) }] });
    const resolver = new WorkflowResolver(projectDir);
    const layers = resolver.collectAllLayers('wf');
    expect(layers.map((l) => l.source)).toEqual(['project:second', 'project:first', 'base']);
    const [definition, , attribution] = resolver.resolveWithLayers('wf');
    const steps = (definition.data as Dict).steps as Dict[];
    expect(steps[0].command).toBe('second');
    expect(attribution).toEqual([
      { step_id: 'a', source: 'project:second' },
      { step_id: 'b', source: 'base' },
    ]);
  });

  test('missing workflow raises FileNotFoundError; invalid edits raise', () => {
    const resolver = new WorkflowResolver(projectDir);
    expect(() => resolver.resolve('nope')).toThrow('Workflow not found: nope');
    writeWorkflow('wf', BASE_WF);
    writeOverlay('wf', 'bad', { id: 'bad', extends: 'wf', edits: [{ remove: 'zz' }] });
    expect(() => resolver.resolve('wf')).toThrow("Overlay 'bad' has invalid edits:\n  - Edit 0: anchor 'zz' does not match any base step id.");
  });

  test('workflowResolve prints tier labels literally', () => {
    writeWorkflow('wf', BASE_WF);
    writeOverlay('wf', 'ov1', { id: 'ov1', extends: 'wf', edits: [{ insert_after: 'a', step: step('[x]') }] });
    const payload = workflowResolve(projectDir, 'wf');
    expect(payload).toEqual({
      workflow_id: 'wf',
      layers: [
        { source: 'project:ov1', tier: 'project-overlay', priority: 10 },
        { source: 'base', tier: 'base', priority: null },
      ],
      attribution: [
        { step_id: 'a', source: 'base' },
        { step_id: '[x]', source: 'project:ov1' },
      ],
    });
    expect(output).toContain('[project-overlay] project:ov1 (priority=10)');
    expect(output).toContain('[base] base (priority=n/a)');
    expect(output).toContain('[x]: project:ov1');
  });
});

// ============================================================================
// CLI: specify workflow overlay ...
// ============================================================================

function overlayFile(name: string, data: Dict, allowUnicode = false): string {
  const p = join(projectDir, name);
  writeFileSync(p, dumpYaml(data, { allowUnicode }), 'utf-8');
  return p;
}

const INSERT_EDIT = { operation: 'insert_after', anchor: 'a', step: { id: 'new', type: 'command', command: 'echo' } };
const OVERLAY_DIR = () => join(projectDir, '.specify', 'workflows', 'overlays', 'wf');

describe('specify workflow overlay add', () => {
  test('adds with --priority override', async () => {
    writeWorkflow('wf', BASE_WF);
    const src = overlayFile('overlay.yml', { id: 'ov1', extends: 'wf', priority: 10, edits: [INSERT_EDIT] });
    const code = await runWorkflowOverlayCommand(['add', src, '--priority', '5']);
    expect(code).toBe(0);
    expect(output).toContain("Overlay 'ov1' added");
    expect(readYaml(join(OVERLAY_DIR(), 'ov1.yml')).priority).toBe(5);
  });

  test('defaults priority to 10 and rejects non-positive', async () => {
    const src = overlayFile('overlay.yml', { id: 'ov1', extends: 'wf', edits: [{ remove: 'a' }] });
    expect(await runWorkflowOverlayCommand(['add', src, '--priority', '0'])).toBe(1);
    expect(output).toContain('must be >= 1');
    expect(await runWorkflowOverlayCommand(['add', src])).toBe(0);
    expect(readYaml(join(OVERLAY_DIR(), 'ov1.yml')).priority).toBe(10);
  });

  test('reuses an existing .yaml file', async () => {
    writeWorkflow('wf', BASE_WF);
    mkdirSync(OVERLAY_DIR(), { recursive: true });
    const existing = join(OVERLAY_DIR(), 'ov1.yaml');
    writeFileSync(existing, dumpYaml({ id: 'ov1', extends: 'wf', priority: 1, edits: [{ remove: 'a' }] }));
    const src = overlayFile('overlay.yml', { id: 'ov1', extends: 'wf', priority: 20, edits: [{ remove: 'a' }] });
    expect(await runWorkflowOverlayCommand(['add', src])).toBe(0);
    expect(readYaml(existing).priority).toBe(10);
    expect(existsSync(join(OVERLAY_DIR(), 'ov1.yml'))).toBe(false);
    expect(bakFiles(OVERLAY_DIR())).toEqual([]);
  });

  test('keeps non-ASCII text readable', async () => {
    writeWorkflow('wf', BASE_WF);
    const message = 'Revisar el plan — ¿aprobar? 日本語';
    const src = overlayFile(
      'overlay.yml',
      {
        id: 'ov1',
        extends: 'wf',
        priority: 10,
        edits: [{ operation: 'replace', anchor: 'a', step: { id: 'a', type: 'gate', message, options: ['approve'] } }],
      },
      true,
    );
    expect(await runWorkflowOverlayCommand(['add', src])).toBe(0);
    const text = readFileSync(join(OVERLAY_DIR(), 'ov1.yml'), 'utf-8');
    expect(text).toContain(message);
    expect(text).not.toContain('\\u');
    expect(text).not.toContain('\\x');
    const edits = readYaml(join(OVERLAY_DIR(), 'ov1.yml')).edits as Dict[];
    expect((edits[0].step as Dict).message).toBe(message);
  });

  test('rejects traversal in ids and symlinked target file', async () => {
    const src1 = overlayFile('o1.yml', { id: 'ov1', extends: '../wf', priority: 10, edits: [INSERT_EDIT] });
    expect(await runWorkflowOverlayCommand(['add', src1])).not.toBe(0);
    expect(output.toLowerCase()).toContain('invalid');

    writeWorkflow('wf', BASE_WF);
    mkdirSync(OVERLAY_DIR(), { recursive: true });
    const real = join(OVERLAY_DIR(), 'other.yml');
    writeFileSync(real, 'sentinel\n');
    symlinkSync(real, join(OVERLAY_DIR(), 'ov1.yml'));
    output = '';
    const src2 = overlayFile('o2.yml', { id: 'ov1', extends: 'wf', priority: 10, edits: [INSERT_EDIT] });
    expect(await runWorkflowOverlayCommand(['add', src2])).not.toBe(0);
    expect(output.toLowerCase()).toContain('symlinked path');
    expect(readFileSync(real, 'utf-8')).toBe('sentinel\n');
  });

  describe('does not clobber a different overlay', () => {
    const setup = (occupantId: string | null): string => {
      writeWorkflow('wf', BASE_WF);
      mkdirSync(OVERLAY_DIR(), { recursive: true });
      if (occupantId !== null) {
        writeFileSync(
          join(OVERLAY_DIR(), 'lint.yml'),
          dumpYaml({ id: occupantId, extends: 'wf', priority: 3, edits: [{ remove: 'a' }] }),
        );
      }
      return overlayFile('incoming.yml', { id: 'lint', extends: 'wf', priority: 10, edits: [{ remove: 'a' }] });
    };

    test('different overlay id is refused', async () => {
      const incoming = setup('format');
      expect(await runWorkflowOverlayCommand(['add', incoming])).toBe(1);
      const survivor = readYaml(join(OVERLAY_DIR(), 'lint.yml'));
      expect(survivor.id).toBe('format');
      expect(survivor.priority).toBe(3);
      expect(bakFiles(OVERLAY_DIR())).toEqual([]);
      expect(output.replace(/\s+/g, ' ')).toContain("already holds overlay 'format'");
    });

    test('same overlay is updated in place', async () => {
      const incoming = setup('lint');
      expect(await runWorkflowOverlayCommand(['add', incoming])).toBe(0);
      expect(readYaml(join(OVERLAY_DIR(), 'lint.yml')).priority).toBe(10);
    });

    test('directory occupant is refused', async () => {
      const incoming = setup(null);
      mkdirSync(join(OVERLAY_DIR(), 'lint.yml'));
      writeFileSync(join(OVERLAY_DIR(), 'lint.yml', 'precious.txt'), 'user data');
      expect(await runWorkflowOverlayCommand(['add', incoming])).toBe(1);
      expect(output.replace(/\s+/g, ' ')).toContain('not a regular file');
      expect(readFileSync(join(OVERLAY_DIR(), 'lint.yml', 'precious.txt'), 'utf-8')).toBe('user data');
    });

    test('FIFO occupant is refused', async () => {
      const incoming = setup(null);
      execFileSync('mkfifo', [join(OVERLAY_DIR(), 'lint.yml')]);
      expect(await runWorkflowOverlayCommand(['add', incoming])).toBe(1);
      expect(output.replace(/\s+/g, ' ')).toContain('not a regular file');
    });

    for (const raw of [
      'id: [1, 2\n  bad: yaml:\n',
      '- just\n- a\n- sequence\n',
      'just a scalar\n',
      'extends: wf\npriority: 3\n',
      'id: 5\nextends: wf\npriority: 3\n',
    ]) {
      test(`unidentifiable occupant fails closed: ${JSON.stringify(raw)}`, async () => {
        const incoming = setup(null);
        writeFileSync(join(OVERLAY_DIR(), 'lint.yml'), raw);
        expect(await runWorkflowOverlayCommand(['add', incoming])).toBe(1);
        expect(readFileSync(join(OVERLAY_DIR(), 'lint.yml'), 'utf-8')).toBe(raw);
        expect(bakFiles(OVERLAY_DIR())).toEqual([]);
      });
    }

    test('creates the file when absent', async () => {
      const incoming = setup(null);
      expect(await runWorkflowOverlayCommand(['add', incoming])).toBe(0);
      expect(readYaml(join(OVERLAY_DIR(), 'lint.yml')).id).toBe('lint');
    });
  });
});

describe('specify workflow overlay enable/disable/set-priority/remove/list', () => {
  test('disable, list, enable round-trip', async () => {
    writeWorkflow('wf', BASE_WF);
    writeOverlay('wf', 'ov1', { id: 'ov1', extends: 'wf', priority: 10, edits: [INSERT_EDIT] });
    expect(await runWorkflowOverlayCommand(['disable', 'wf', 'ov1'])).toBe(0);
    expect(readYaml(join(OVERLAY_DIR(), 'ov1.yml')).enabled).toBe(false);
    expect(output).toContain("Overlay 'ov1' disabled");
    output = '';
    expect(await runWorkflowOverlayCommand(['list', 'wf'])).toBe(0);
    expect(output).toContain('ov1 (priority=10, source=project:ov1, disabled)');
    expect(await runWorkflowOverlayCommand(['enable', 'wf', 'ov1'])).toBe(0);
    expect(readYaml(join(OVERLAY_DIR(), 'ov1.yml')).enabled).toBe(true);
  });

  test('operations find overlays by manifest id, not filename', async () => {
    writeWorkflow('wf', BASE_WF);
    writeOverlay('wf', 'custom', { id: 'lint', extends: 'wf', priority: 10, edits: [INSERT_EDIT] });
    expect(findOverlayFile(projectDir, 'wf', 'lint')).toBe(join(OVERLAY_DIR(), 'custom.yml'));
    expect(findOverlayFile(projectDir, 'wf', 'custom')).toBeNull();
    expect(await runWorkflowOverlayCommand(['set-priority', 'wf', 'lint', '25'])).toBe(0);
    expect(output).toContain("Priority of overlay 'lint' set to 25");
    expect(readYaml(join(OVERLAY_DIR(), 'custom.yml')).priority).toBe(25);
    expect(await runWorkflowOverlayCommand(['remove', 'wf', 'lint'])).toBe(0);
    expect(existsSync(join(OVERLAY_DIR(), 'custom.yml'))).toBe(false);
  });

  test('set-priority keeps non-ASCII readable and rejects < 1', async () => {
    const message = 'Revisar — 日本語';
    writeOverlay('wf', 'ov1', dumpYaml({ id: 'ov1', extends: 'wf', edits: [{ replace: 'a', step: { id: 'a', message } }] }, { allowUnicode: true }));
    expect(await runWorkflowOverlayCommand(['set-priority', 'wf', 'ov1', '20'])).toBe(0);
    const text = readFileSync(join(OVERLAY_DIR(), 'ov1.yml'), 'utf-8');
    expect(text).toContain(message);
    expect(readYaml(join(OVERLAY_DIR(), 'ov1.yml')).priority).toBe(20);
    expect(await runWorkflowOverlayCommand(['set-priority', 'wf', 'ov1', '0'])).toBe(1);
    expect(output).toContain('must be >= 1');
  });

  test('invalid ids are rejected', async () => {
    expect(await runWorkflowOverlayCommand(['set-priority', 'wf', '../x', '3'])).toBe(1);
    expect(output).toContain('Invalid overlay ID');
    expect(await runWorkflowOverlayCommand(['set-priority', '../x', 'ov', '3'])).toBe(1);
    expect(output).toContain('Invalid workflow ID');
    output = '';
    expect(await runWorkflowOverlayCommand(['list', 'runs'])).not.toBe(0);
    expect(output).toContain('reserved name');
    expect(await runWorkflowOverlayCommand(['enable', 'wf', '../other'])).not.toBe(0);
  });

  test('not found and invalid YAML', async () => {
    writeWorkflow('wf', BASE_WF);
    expect(await runWorkflowOverlayCommand(['remove', 'wf', 'ghost'])).toBe(1);
    expect(output).toContain("Overlay 'ghost' not found for workflow 'wf'");
    writeOverlay('wf', 'broken', 'id: [1, 2\n  bad: yaml:\n');
    output = '';
    expect(await runWorkflowOverlayCommand(['list', 'wf'])).toBe(1);
    expect(output).toContain('Invalid YAML');
  });

  test('list with no overlays and usage errors', async () => {
    expect(await runWorkflowOverlayCommand(['list', 'wf'])).toBe(0);
    expect(output).toContain("No overlays found for workflow 'wf'.");
    expect(await runWorkflowOverlayCommand(['add'])).toBe(2);
    expect(output.toLowerCase()).toContain("missing argument 'source'.");
    expect(await runWorkflowOverlayCommand(['set-priority', 'wf', 'ov', 'x'])).toBe(2);
  });

  test('outside a spec-kit project', async () => {
    rmSync(join(projectDir, '.specify'), { recursive: true });
    expect(await runWorkflowOverlayCommand(['list', 'wf'])).toBe(1);
    expect(output).toContain('Not a Spec Kit project');
  });
});
