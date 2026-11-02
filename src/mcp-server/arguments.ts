/**
 * @oakoliver/specify-cli - MCP tool argument validation
 *
 * Zero-dependency replacement for the pydantic argument models the upstream
 * MCP SDK builds for each tool. Validation order, error types, messages and
 * the rendered `ValidationError` text match pydantic 2.14 so that tool-call
 * failures are byte-identical on the wire.
 *
 * @module mcp-server/arguments
 */

import { pyRepr } from '../events/py-compat.js';
import { PyFloat, pyFloatRepr } from './json-wire.js';

/** pydantic minor version used in error URLs (upstream resolves pydantic 2.14). */
export const PYDANTIC_DOCS_VERSION = '2.14';

export interface FieldSpec {
  name: string;
  type: 'str' | 'int' | 'literal';
  required?: boolean;
  nullable?: boolean;
  default?: unknown;
  ge?: number;
  le?: number;
  maxLength?: number;
  pattern?: string;
  literals?: readonly string[];
}

export interface ArgumentModel {
  /** Model title, e.g. `specify_versionArguments`. */
  title: string;
  fields: readonly FieldSpec[];
  /** `extra="forbid"` (closed schema). Open models ignore unknown keys. */
  closed: boolean;
}

interface ErrorLine {
  loc: string;
  type: string;
  msg: string;
  input: unknown;
}

/** Python `repr()` of a wire value (floats stay floats). */
export function wireRepr(v: unknown): string {
  if (v instanceof PyFloat) return pyFloatRepr(v.value);
  if (Array.isArray(v)) return '[' + v.map(wireRepr).join(', ') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${wireRepr(x)}`).join(', ') + '}';
  }
  return pyRepr(v);
}

/** Python `type(v).__name__` of a wire value. */
export function wireTypeName(v: unknown): string {
  if (v instanceof PyFloat) return 'float';
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'int';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

/** pydantic-core truncates input reprs longer than 50 characters. */
function truncateRepr(repr: string): string {
  const chars = [...repr];
  if (chars.length <= 50) return repr;
  return chars.slice(0, 25).join('') + '...' + chars.slice(chars.length - 24).join('');
}

function validateField(spec: FieldSpec, value: unknown): ErrorLine | null {
  if (value === null && spec.nullable) return null;
  const err = (type: string, msg: string): ErrorLine => ({ loc: spec.name, type, msg, input: value });
  if (spec.type === 'literal') {
    const lits = spec.literals ?? [];
    if (typeof value === 'string' && lits.includes(value)) return null;
    const quoted = lits.map((l) => `'${l}'`);
    const expected = quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}` : quoted[0];
    return err('literal_error', `Input should be ${expected}`);
  }
  if (spec.type === 'int') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return err('int_type', 'Input should be a valid integer');
    if (spec.ge !== undefined && value < spec.ge) {
      return err('greater_than_equal', `Input should be greater than or equal to ${spec.ge}`);
    }
    if (spec.le !== undefined && value > spec.le) return err('less_than_equal', `Input should be less than or equal to ${spec.le}`);
    return null;
  }
  if (typeof value !== 'string') return err('string_type', 'Input should be a valid string');
  if (spec.maxLength !== undefined && [...value].length > spec.maxLength) {
    return err(
      'string_too_long',
      `String should have at most ${spec.maxLength} character${spec.maxLength === 1 ? '' : 's'}`,
    );
  }
  if (spec.pattern !== undefined && !new RegExp(spec.pattern, 'u').test(value)) {
    return err('string_pattern_mismatch', `String should match pattern '${spec.pattern}'`);
  }
  return null;
}

/** Validation failure carrying pydantic's rendered message. */
export class ArgumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentValidationError';
  }
}

/**
 * Validate tool `arguments` against `model`. Returns the validated values
 * (defaults applied) or throws {@link ArgumentValidationError} whose message
 * is pydantic's `str(ValidationError)`.
 */
export function validateArguments(model: ArgumentModel, args: Record<string, unknown>): Record<string, unknown> {
  const errors: ErrorLine[] = [];
  const out: Record<string, unknown> = {};
  for (const field of model.fields) {
    if (!Object.prototype.hasOwnProperty.call(args, field.name)) {
      if (field.required) {
        errors.push({ loc: field.name, type: 'missing', msg: 'Field required', input: args });
      } else {
        out[field.name] = field.default ?? null;
      }
      continue;
    }
    const value = args[field.name];
    const e = validateField(field, value);
    if (e) errors.push(e);
    else out[field.name] = value;
  }
  if (model.closed) {
    const known = new Set(model.fields.map((f) => f.name));
    for (const [k, v] of Object.entries(args)) {
      if (!known.has(k)) errors.push({ loc: k, type: 'extra_forbidden', msg: 'Extra inputs are not permitted', input: v });
    }
  }
  if (errors.length) {
    const lines = [`${errors.length} validation error${errors.length === 1 ? '' : 's'} for ${model.title}`];
    for (const e of errors) {
      lines.push(e.loc);
      lines.push(
        `  ${e.msg} [type=${e.type}, input_value=${truncateRepr(wireRepr(e.input))}, input_type=${wireTypeName(e.input)}]`,
      );
      lines.push(`    For further information visit https://errors.pydantic.dev/${PYDANTIC_DOCS_VERSION}/v/${e.type}`);
    }
    throw new ArgumentValidationError(lines.join('\n'));
  }
  return out;
}
