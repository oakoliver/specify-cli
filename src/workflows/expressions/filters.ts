/**
 * @oakoliver/specify-cli - Workflow expression filters
 *
 * Port of ``specify_cli/workflows/expressions/filters.py``: the fixed set of
 * pipe filters templates may apply.
 *
 * @module workflows/expressions/filters
 */

import { ValueError, isDict, pyEquals, pyStr, pyTypeName } from '../base.js';

/**
 * The filters the expression evaluator recognizes. Used to tell a
 * *registered* filter used in an unsupported form (e.g. `| join` with no
 * argument) apart from a genuinely unknown filter name.
 */
export const REGISTERED_FILTERS: readonly string[] = [
  'default',
  'join',
  'map',
  'contains',
  'from_json',
  'upper',
  'lower',
  'split',
  'length',
  'to_json',
];

/** Return *defaultValue* when *value* is ``None`` or empty string. */
export function filterDefault(value: unknown, defaultValue: unknown = ''): unknown {
  if (value === null || value === undefined || value === '') return defaultValue;
  return value;
}

/** Join a list into a string with *separator*. */
export function filterJoin(value: unknown, separator: unknown = ', '): string {
  if (typeof separator !== 'string') {
    throw new ValueError(`join: expected a string separator, got ${pyTypeName(separator)}`);
  }
  if (Array.isArray(value)) return value.map((v) => pyStr(v)).join(separator);
  return pyStr(value);
}

/** Map a list of dicts to a specific attribute (dot notation supported). */
export function filterMap(value: unknown, attr: unknown): unknown[] {
  if (typeof attr !== 'string') {
    throw new ValueError(`map: expected a string attribute name, got ${pyTypeName(attr)}`);
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      if (isDict(item)) {
        const parts = attr.split('.');
        let v: unknown = item;
        for (const part of parts) {
          if (isDict(v)) {
            v = Object.prototype.hasOwnProperty.call(v, part) ? v[part] : null;
          } else {
            v = null;
            break;
          }
        }
        result.push(v === undefined ? null : v);
      } else {
        result.push(item);
      }
    }
    return result;
  }
  return [];
}

/** Check if a string or list contains *substring*. */
export function filterContains(value: unknown, substring: unknown): boolean {
  if (typeof value === 'string') {
    if (typeof substring !== 'string') {
      throw new ValueError(
        'contains: expected a string argument when the value is a ' +
          `string, got ${pyTypeName(substring)}`,
      );
    }
    return value.includes(substring);
  }
  if (Array.isArray(value)) return value.some((v) => pyEquals(v, substring));
  return false;
}

/** Parse a JSON string into a typed value (list/dict/scalar). */
export function filterFromJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new ValueError(`from_json: expected a JSON string, got ${pyTypeName(value)}`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (exc) {
    throw new ValueError(`from_json: invalid JSON: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
}

/** Return *value* uppercased; non-string input is an authoring mistake. */
export function filterUpper(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValueError(`upper: expected a string value, got ${pyTypeName(value)}`);
  }
  return value.toUpperCase();
}

/** Return *value* lowercased; non-string input is an authoring mistake. */
export function filterLower(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValueError(`lower: expected a string value, got ${pyTypeName(value)}`);
  }
  return value.toLowerCase();
}

/** Split *value* on *separator* (single-argument form only, no maxsplit). */
export function filterSplit(value: unknown, separator: unknown): string[] {
  if (typeof value !== 'string') {
    throw new ValueError(`split: expected a string value, got ${pyTypeName(value)}`);
  }
  if (typeof separator !== 'string') {
    throw new ValueError(`split: expected a string separator, got ${pyTypeName(separator)}`);
  }
  if (separator === '') throw new ValueError('split: separator must not be empty');
  return value.split(separator);
}

/** Length of a list or string (characters, as Jinja2); mappings are rejected. */
export function filterLength(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return [...value].length;
  throw new ValueError(
    'length: expected a list or string, got ' + `${pyTypeName(value)} (mappings are not supported)`,
  );
}

function jsonFloat(value: number): string {
  if (!Number.isFinite(value)) {
    const name = Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf';
    throw new ValueError(`Out of range float values are not JSON compliant: ${name}`);
  }
  return String(value).replace(/e([+-])(\d)$/, 'e$10$2');
}

function codepointCompare(a: string, b: string): number {
  const ca = [...a];
  const cb = [...b];
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const d = (ca[i] as string).codePointAt(0)! - (cb[i] as string).codePointAt(0)!;
    if (d !== 0) return d;
  }
  return ca.length - cb.length;
}

/**
 * ``json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False)``:
 * default ``', '`` / ``': '`` separators, byte-stable key order.
 */
function dumpsSorted(value: unknown, seen: Set<unknown>): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return jsonFloat(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value) || isDict(value)) {
    if (seen.has(value)) throw new ValueError('Circular reference detected');
    seen.add(value);
    try {
      if (Array.isArray(value)) return '[' + value.map((v) => dumpsSorted(v, seen)).join(', ') + ']';
      const keys = Object.keys(value).sort(codepointCompare);
      return '{' + keys.map((k) => `${JSON.stringify(k)}: ${dumpsSorted(value[k], seen)}`).join(', ') + '}';
    } finally {
      seen.delete(value);
    }
  }
  throw new TypeError(`Object of type ${pyTypeName(value)} is not JSON serializable`);
}

/**
 * Serialize *value* to a JSON string — the inverse of ``from_json``. Pinned
 * to sorted keys and literal non-ASCII so output is byte-stable; non-finite
 * floats and circular structures raise. (Mapping keys are always strings in
 * this port, so upstream's non-string-key check has nothing to reject.)
 */
export function filterToJson(value: unknown): string {
  try {
    return dumpsSorted(value, new Set());
  } catch (exc) {
    if (exc instanceof ValueError || exc instanceof TypeError) {
      throw new ValueError(`to_json: value is not JSON-serializable: ${exc.message}`);
    }
    throw exc;
  }
}

/**
 * Filters that take no arguments and tolerate no trailing tokens, keyed by
 * name. ``default`` is deliberately absent: it is valid both bare and with an
 * argument.
 */
export const ZERO_ARG_FILTERS: Readonly<Record<string, (value: unknown) => unknown>> = {
  from_json: filterFromJson,
  upper: filterUpper,
  lower: filterLower,
  length: filterLength,
  to_json: filterToJson,
};
