/**
 * Expression evaluator behaviour added upstream between spec-kit v1.0.12 and
 * v1.2.5 (ports of the ``TestExpressions`` additions in upstream
 * ``tests/test_workflows.py`` from #4416, #4417, #4801, #4766, #4923 and
 * #5130, plus ``tests/unit/test_expression_package_boundary.py`` from #5114).
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { StepContext, StepStatus } from '../src/workflows/base.js';
import {
  REGISTERED_FILTERS,
  collectLeaves,
  evaluateCondition,
  evaluateExpression,
} from '../src/workflows/expressions.js';
import { parseYaml } from '../src/yaml.js';
import { GateStep } from '../src/workflows/step/gate.js';

type Init = ConstructorParameters<typeof StepContext>[0];
const ev = (t: string, init: Init = {}): unknown => evaluateExpression(t, new StepContext(init));

describe('negative indices and grouping (#4416, #4417)', () => {
  test('test_negative_list_indexing', () => {
    const c = { steps: { tasks: { output: { task_list: [{ file: 'a.md' }, { file: 'b.md' }] } } } };
    expect(ev('{{ steps.tasks.output.task_list[-1].file }}', c)).toBe('b.md');
    expect(ev('{{ steps.tasks.output.task_list[-2].file }}', c)).toBe('a.md');
    expect(ev('{{ steps.tasks.output.task_list[-3] }}', c)).toBeNull();
    expect(ev('{{ steps.tasks.output.task_list[2] }}', c)).toBeNull();
  });

  test('test_parenthesised_grouping', () => {
    const c = { inputs: { a: true, b: false, c: true, n: 5 } };
    expect(ev('{{ (inputs.a or inputs.b) and inputs.c }}', c)).toBe(true);
    expect(ev('{{ (inputs.b or inputs.b) and inputs.c }}', c)).toBe(false);
    expect(ev('{{ (inputs.n) }}', c)).toBe(5);
    expect(ev('{{ (inputs.n > 1) }}', c)).toBe(true);
    expect(ev('{{ ((inputs.n)) }}', c)).toBe(5);
    expect(ev('{{ (inputs.a) and (inputs.b) }}', c)).toBe(false);
    expect(ev('{{ (inputs.n) | default(9) }}', c)).toBe(5);
    expect(ev("{{ 'a(b' }}", c)).toBe('a(b');
    expect(ev("{{ ('(') }}", c)).toBe('(');
  });
});

describe('whitespace between tokens (#4801)', () => {
  const c = { inputs: { a: true, b: false, c: true, mode: 'fast', tags: ['x', 'y'] } };
  for (const expr of [
    '{{ inputs.b or\n  inputs.a }}',
    '{{ inputs.a and\n  inputs.c }}',
    '{{ inputs.b\nor inputs.a }}',
    '{{ inputs.a\tand inputs.c }}',
    '{{ not\n  inputs.b }}',
    "{{ 'x' in\n  inputs.tags }}",
    "{{ 'z' not\n  in inputs.tags }}",
    "{{ 'z' not in\n  inputs.tags }}",
    '{{ (inputs.b or\r\n  inputs.a) and inputs.c }}',
  ]) {
    test(`test_operators_separated_by_any_whitespace ${JSON.stringify(expr)}`, () => {
      expect(ev(expr, c)).toBe(true);
    });
  }

  test('test_condition_wrapped_across_lines_in_yaml', () => {
    const step = parseYaml("condition: >-\n  {{ inputs.skip_review or\n     inputs.scope == 'docs' }}\n") as {
      condition: string;
    };
    expect(step.condition).toContain('\n');
    expect(evaluateCondition(step.condition, new StepContext({ inputs: { skip_review: false, scope: 'docs' } }))).toBe(
      true,
    );
  });

  test('test_whitespace_inside_quoted_operand_is_kept', () => {
    const c2 = { inputs: { title: 'two  spaces', text: 'tab\there' } };
    expect(ev("{{ inputs.title == 'two  spaces' }}", c2)).toBe(true);
    expect(ev("{{ inputs.title == 'two spaces' }}", c2)).toBe(false);
    expect(ev("{{ inputs.text\n  == 'tab\there' }}", c2)).toBe(true);
    expect(ev("{{ 'a  or  b' }}", c2)).toBe('a  or  b');
  });
});

describe('new filters (#4766)', () => {
  test('test_filter_upper_and_lower', () => {
    const c = { inputs: { s: 'Hello World', empty: '', mixed: 'aBc' } };
    expect(ev('{{ inputs.s | upper }}', c)).toBe('HELLO WORLD');
    expect(ev('{{ inputs.s | lower }}', c)).toBe('hello world');
    expect(ev('{{ inputs.empty | upper }}', c)).toBe('');
    expect(ev('{{ inputs.empty | lower }}', c)).toBe('');
    expect(ev('{{ inputs.mixed | upper }}', c)).toBe('ABC');
    expect(ev('{{ inputs.uni | upper }}', { inputs: { uni: 'café' } })).toBe('CAFÉ');
    expect(ev('{{ inputs.s | upper | lower }}', c)).toBe('hello world');
  });

  for (const fname of ['upper', 'lower']) {
    test(`test_filter_${fname}_rejects_non_string`, () => {
      const c = { inputs: { items: ['a'], n: 3, flag: true, none: null } };
      for (const name of ['items', 'n', 'flag', 'none']) {
        expect(() => ev(`{{ inputs.${name} | ${fname} }}`, c)).toThrow(`${fname}: expected a string value`);
      }
    });
  }

  test('test_filter_split', () => {
    const c = { inputs: { csv: 'a,b,c', multi: 'x::y::z', empty: '', nodelim: 'abc', trailing: 'a,b,' } };
    expect(ev("{{ inputs.csv | split(',') }}", c)).toEqual(['a', 'b', 'c']);
    expect(ev("{{ inputs.multi | split('::') }}", c)).toEqual(['x', 'y', 'z']);
    expect(ev("{{ inputs.empty | split(',') }}", c)).toEqual(['']);
    expect(ev("{{ inputs.nodelim | split(',') }}", c)).toEqual(['abc']);
    expect(ev("{{ inputs.trailing | split(',') }}", c)).toEqual(['a', 'b', '']);
    expect(ev("{{ inputs.csv | split(',') | join('-') }}", c)).toBe('a-b-c');
  });

  test('test_filter_split_rejects_non_string_inputs and empty separator', () => {
    const c = { inputs: { items: ['a', 'b'], csv: 'a,b', n: 3 } };
    expect(() => ev("{{ inputs.items | split(',') }}", c)).toThrow('split: expected a string value');
    expect(() => ev('{{ inputs.csv | split(5) }}', c)).toThrow('split: expected a string separator');
    expect(() => ev("{{ inputs.csv | split('') }}", c)).toThrow('split: separator must not be empty');
  });

  test('test_filter_length', () => {
    const c = { inputs: { items: ['a', 'b', 'c'], empty_list: [], s: 'hello', empty_str: '' } };
    expect(ev('{{ inputs.items | length }}', c)).toBe(3);
    expect(ev('{{ inputs.empty_list | length }}', c)).toBe(0);
    expect(ev('{{ inputs.s | length }}', c)).toBe(5);
    expect(ev('{{ inputs.empty_str | length }}', c)).toBe(0);
    expect(ev("{{ inputs.s | split('l') | length }}", c)).toBe(3);
  });

  test('test_filter_length_drives_conditions', () => {
    const c = new StepContext({ inputs: { items: ['a'], empty: [] } });
    expect(evaluateCondition('{{ inputs.items | length }}', c)).toBe(true);
    expect(evaluateCondition('{{ inputs.empty | length }}', c)).toBe(false);
  });

  test('test_filter_length_rejects_unsupported_types', () => {
    const c = { inputs: { obj: { a: 1 }, n: 3, flag: true, none: null, ratio: 1.5 } };
    for (const name of ['obj', 'n', 'flag', 'none', 'ratio']) {
      expect(() => ev(`{{ inputs.${name} | length }}`, c)).toThrow('length: expected a list or string');
    }
  });

  test('test_filter_to_json', () => {
    const c = { inputs: { obj: { b: 2, a: 1 }, items: [1, 2, 3], s: 'hi', n: 3, flag: false, none: null, uni: 'café' } };
    expect(ev('{{ inputs.obj | to_json }}', c)).toBe('{"a": 1, "b": 2}');
    expect(ev('{{ inputs.items | to_json }}', c)).toBe('[1, 2, 3]');
    expect(ev('{{ inputs.s | to_json }}', c)).toBe('"hi"');
    expect(ev('{{ inputs.n | to_json }}', c)).toBe('3');
    expect(ev('{{ inputs.flag | to_json }}', c)).toBe('false');
    expect(ev('{{ inputs.none | to_json }}', c)).toBe('null');
    expect(ev('{{ inputs.uni | to_json }}', c)).toBe('"café"');
  });

  test('test_filter_to_json_round_trips_from_json', () => {
    const c = { inputs: { obj: { items: [1, 2, 3] } }, steps: { emit: { output: { stdout: '{"items": [1, 2, 3]}' } } } };
    expect(ev('{{ steps.emit.output.stdout | from_json | to_json }}', c)).toBe('{"items": [1, 2, 3]}');
    expect(ev('{{ inputs.obj | to_json | from_json }}', c)).toEqual({ items: [1, 2, 3] });
  });

  test('test_filter_to_json_rejects_non_finite_floats and cycles', () => {
    const cyc: unknown[] = [];
    cyc.push(cyc);
    const c = { inputs: { nan: NaN, inf: Infinity, ninf: -Infinity, nested: [NaN], cyc } };
    for (const name of ['nan', 'inf', 'ninf', 'nested', 'cyc']) {
      expect(() => ev(`{{ inputs.${name} | to_json }}`, c)).toThrow('to_json: value is not JSON-serializable');
    }
    expect(ev('{{ inputs.strkey | to_json }}', { inputs: { strkey: { '1': 'a', '2': 'b' } } })).toBe(
      '{"1": "a", "2": "b"}',
    );
  });

  test('test_split_with_extra_argument_reports_unsupported_form', () => {
    const c = { inputs: { s: 'a,b,c' } };
    expect(() => ev("{{ inputs.s | split(',', 1) }}", c)).toThrow("filter 'split' used in an unsupported form");
    expect(ev("{{ inputs.s | split(',') }}", c)).toEqual(['a', 'b', 'c']);
  });

  test('test_zero_arg_filters_reject_miswired_forms', () => {
    const c = { inputs: { s: 'hi', items: ['a'] } };
    for (const fname of ['from_json', 'upper', 'lower', 'length', 'to_json']) {
      for (const bad of [`${fname}()`, `${fname}('x')`, `${fname})`, `${fname} extra`]) {
        expect(() => ev(`{{ inputs.s | ${bad} }}`, c)).toThrow(`${fname}: expected`);
      }
    }
  });

  test('test_registered_filter_list_covers_every_implemented_filter', () => {
    expect(new Set(REGISTERED_FILTERS)).toEqual(
      new Set(['default', 'join', 'map', 'contains', 'from_json', 'upper', 'lower', 'split', 'length', 'to_json']),
    );
    const c = { inputs: { tags: ['a'] } };
    expect(() => ev('{{ inputs.tags | split }}', c)).toThrow("filter 'split' used in an unsupported form");
    expect(() => ev('{{ inputs.tags | contains }}', c)).toThrow("filter 'contains' used in an unsupported form");
    expect(() => ev('{{ inputs.tags | truncate }}', c)).toThrow("unknown filter 'truncate'");
  });
});

describe('and/or short-circuit (#4923)', () => {
  for (const [expr, expected] of [
    ["inputs.payload != '' and (inputs.payload | from_json | length)", false],
    ["inputs.payload == '' or (inputs.payload | from_json | length)", true],
    ['false and true or true', true],
    ['true or (false and (inputs.payload | from_json))', true],
  ] as const) {
    test(`test_boolean_short_circuits ${expr}`, () => {
      expect(ev(`{{ ${expr} }}`, { inputs: { payload: '' } })).toBe(expected);
    });
  }

  for (const expr of [
    'true and (inputs.payload | from_json)',
    'false or (inputs.payload | from_json)',
    '(inputs.payload | from_json) and false',
    '(inputs.payload | from_json) or true',
  ]) {
    test(`test_boolean_required_operand_still_raises ${expr}`, () => {
      expect(() => ev(`{{ ${expr} }}`, { inputs: { payload: '' } })).toThrow('from_json: invalid JSON');
    });
  }

  test('validation probes still visit skipped operands', () => {
    expect(collectLeaves('inputs.a or inputs.b')).toEqual(['inputs.a', 'inputs.b']);
    expect(collectLeaves('inputs.a and inputs.b')).toEqual(['inputs.a', 'inputs.b']);
  });
});

describe('pinned evaluator behaviour (#5130)', () => {
  test('test_comparison_greater_equal_and_less_equal', () => {
    const c = { inputs: { n: 5, s10: '10', s9: '9', lo: 'alpha', hi: 'beta' } };
    expect(ev('{{ inputs.n >= 5 }}', c)).toBe(true);
    expect(ev('{{ inputs.n <= 5 }}', c)).toBe(true);
    expect(ev('{{ inputs.n >= 6 }}', c)).toBe(false);
    expect(ev('{{ inputs.n <= 4 }}', c)).toBe(false);
    expect(ev('{{ inputs.s10 >= inputs.s9 }}', c)).toBe(true);
    expect(ev('{{ inputs.s9 <= inputs.s10 }}', c)).toBe(true);
    expect(ev('{{ inputs.hi >= inputs.lo }}', c)).toBe(true);
    expect(ev('{{ inputs.lo <= inputs.hi }}', c)).toBe(true);
    expect(ev("{{ inputs.n >= 'abc' }}", c)).toBe(false);
    expect(ev("{{ inputs.n <= 'abc' }}", c)).toBe(false);
  });

  test('test_boolean_literals_are_case_insensitive', () => {
    for (const lit of ['True', 'TRUE']) expect(ev(`{{ ${lit} }}`)).toBe(true);
    for (const lit of ['False', 'FALSE']) expect(ev(`{{ ${lit} }}`)).toBe(false);
  });

  test('test_null_literals', () => {
    for (const lit of ['none', 'null', 'None', 'NULL', 'nUlL']) {
      expect(ev(`{{ ${lit} }}`)).toBeNull();
      expect(collectLeaves(lit)).toEqual([]);
    }
  });

  test('test_filter_map_dot_path_attribute', () => {
    expect(
      ev("{{ inputs.rows | map('result.status') }}", {
        inputs: { rows: [{ result: { status: 'ok' } }, { result: { status: 'bad' } }] },
      }),
    ).toEqual(['ok', 'bad']);
    expect(ev("{{ inputs.rows | map('result.status') }}", { inputs: { rows: [{ result: { status: 'ok' } }, {}] } })).toEqual(
      ['ok', null],
    );
  });

  test('test_filter_default_on_empty_string', () => {
    const c = {
      inputs: { empty: '', value: 'kept', missing: null, zero: 0, boolean: false, empty_list: [], empty_dict: {} },
    };
    expect(ev("{{ inputs.empty | default('fb') }}", c)).toBe('fb');
    expect(ev("{{ inputs.missing | default('fb') }}", c)).toBe('fb');
    expect(ev("{{ inputs.value | default('fb') }}", c)).toBe('kept');
    expect(ev("{{ inputs.zero | default('fb') }}", c)).toBe(0);
    expect(ev("{{ inputs.boolean | default('fb') }}", c)).toBe(false);
    expect(ev("{{ inputs.empty_list | default('fb') }}", c)).toEqual([]);
    expect(ev("{{ inputs.empty_dict | default('fb') }}", c)).toEqual({});
  });

  test('test_filter_from_json_returns_non_object_types', () => {
    const c = { inputs: { arr: '[1, 2, 3]', num: '42', fnum: '1.5', t: 'true', nl: 'null' } };
    expect(ev('{{ inputs.arr | from_json }}', c)).toEqual([1, 2, 3]);
    expect(ev('{{ inputs.num | from_json }}', c)).toBe(42);
    expect(ev('{{ inputs.fnum | from_json }}', c)).toBe(1.5);
    expect(ev('{{ inputs.t | from_json }}', c)).toBe(true);
    expect(ev('{{ inputs.nl | from_json }}', c)).toBeNull();
  });

  test('test_filter_argument_resolved_from_namespace', () => {
    const c = { inputs: { tags: ['a', 'b'], sep: '-', missing: null } };
    expect(ev('{{ inputs.tags | join(inputs.sep) }}', c)).toBe('a-b');
    expect(ev('{{ inputs.missing | default(inputs.sep) }}', c)).toBe('-');
  });

  test('test_boolean_precedence_without_parentheses', () => {
    const c = { inputs: { a: true, b: false, c: false } };
    expect(ev('{{ inputs.a or inputs.b and inputs.c }}', c)).toBe(true);
    expect(ev('{{ (inputs.a or inputs.b) and inputs.c }}', c)).toBe(false);
  });

  test('test_item_and_fan_in_namespace', () => {
    const c = { inputs: { x: 'y' }, item: { name: 'n1' }, fanIn: { results: [1, 2] } };
    expect(ev('{{ item.name }}', c)).toBe('n1');
    expect(ev('{{ item }}', c)).toEqual({ name: 'n1' });
    expect(ev('{{ fan_in.results }}', c)).toEqual([1, 2]);
    expect(ev("{{ fan_in.results | join(', ') }}", c)).toBe('1, 2');
  });

  test('test_interpolation_with_steps_and_item', () => {
    const c = { steps: { emit: { output: { file: 'a.md' } } }, item: 'row-1' };
    expect(ev('file={{ steps.emit.output.file }}', c)).toBe('file=a.md');
    expect(ev('item={{ item }}', c)).toBe('item=row-1');
  });

  test('test_empty_expression_block_is_empty_string', () => {
    expect(ev('{{ }}')).toBe('');
    expect(evaluateCondition('{{ }}', new StepContext())).toBe(false);
  });

  test('test_missing_intermediate_path_resolves_to_none', () => {
    expect(ev('{{ inputs.a.b }}', { inputs: { a: {} } })).toBeNull();
    expect(ev('{{ inputs.zzz.deep }}', { inputs: { a: {} } })).toBeNull();
  });

  test('test_whitespace_inside_and_around_block', () => {
    const c = { inputs: { n: 5, missing: null } };
    expect(ev('{{inputs.n}}', c)).toBe(5);
    expect(ev('{{   inputs.n   }}', c)).toBe(5);
    expect(ev("{{ inputs.missing | default( 'y' ) }}", c)).toBe('y');
    expect(ev("{{ inputs.missing|default('y') }}", c)).toBe('y');
  });

  test('test_message_expression_is_interpolated', async () => {
    const result = await new GateStep().execute(
      { id: 'review', message: 'Approve {{ inputs.feature }}?', options: ['approve', 'reject'] },
      new StepContext({ inputs: { feature: 'login' } }),
    );
    expect(result.status).toBe(StepStatus.PAUSED);
    expect((result.output as Record<string, unknown>).message).toBe('Approve login?');
  });
});

describe('expression package boundary (#5114)', () => {
  // Port of tests/unit/test_expression_package_boundary.py: only engine.ts and
  // the facade may import an engine implementation (engine-*).
  test('only the selection point imports an engine implementation', () => {
    const dir = join(import.meta.dir, '..', 'src', 'workflows', 'expressions');
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name === 'engine.ts' || name.startsWith('engine-')) continue;
      const text = readFileSync(join(dir, name), 'utf-8');
      if (/from '\.\/engine-[\w-]+\.js'/.test(text)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });
});
