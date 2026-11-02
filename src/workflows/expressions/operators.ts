/**
 * @oakoliver/specify-cli - Workflow expression operators
 *
 * Port of ``specify_cli/workflows/expressions/operators.py``: comparison and
 * membership that never crash on mismatched operand types.
 *
 * @module workflows/expressions/operators
 */

import { pyCompare, pyContains, pyParseFloat, pyParseInt } from '../base.js';

/** Return *value* as a number if it is a numeric string, else unchanged. */
export function coerceNumber(value: unknown): unknown {
  if (typeof value === 'string') {
    const n = value.includes('.') ? pyParseFloat(value) : pyParseInt(value);
    return n === null ? value : n;
  }
  return value;
}

/** Safely evaluate ``left in right`` (or ``not in``) without crashing. */
export function safeMembership(left: unknown, right: unknown, negate: boolean): boolean {
  let contained: boolean;
  try {
    contained = pyContains(right, left);
  } catch (exc) {
    if (!(exc instanceof TypeError)) throw exc;
    contained = false;
  }
  return negate ? !contained : contained;
}

function isNumeric(v: unknown): boolean {
  return typeof v === 'number' || typeof v === 'boolean';
}

/** Compare two values for ordering, coercing numeric strings when possible. */
export function safeCompare(left: unknown, right: unknown, op: '>' | '<' | '>=' | '<='): boolean {
  const cl = coerceNumber(left);
  const cr = coerceNumber(right);
  if (isNumeric(cl) && isNumeric(cr)) {
    left = cl;
    right = cr;
  }
  let cmp: number;
  try {
    cmp = pyCompare(left, right);
  } catch (exc) {
    if (exc instanceof TypeError) return false;
    throw exc;
  }
  if (Number.isNaN(cmp)) return false;
  if (op === '>') return cmp > 0;
  if (op === '<') return cmp < 0;
  if (op === '>=') return cmp >= 0;
  return cmp <= 0;
}
