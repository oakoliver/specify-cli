/**
 * @oakoliver/specify-cli - Workflow expression public API
 *
 * Port of ``specify_cli/workflows/expressions/api.py``: namespace
 * construction plus the engine contract's template evaluation.
 *
 * @module workflows/expressions/api
 */

import { pyTruthy } from '../base.js';
import { evaluateTemplate } from './engine.js';
import { buildNamespace } from './namespace.js';

/**
 * Evaluate a template string with ``{{ ... }}`` expressions.
 *
 * If the entire string is a single expression, returns the raw value
 * (preserving type). Otherwise, substitutes each expression inline and
 * returns a string. Non-string templates are returned unchanged.
 */
export function evaluateExpression(template: unknown, context: unknown): unknown {
  if (typeof template !== 'string') return template === undefined ? null : template;
  return evaluateTemplate(template, buildNamespace(context));
}

/**
 * Evaluate a condition expression and return a boolean.
 *
 * Plain "false"/"true" strings (after stripping) are treated as booleans.
 */
export function evaluateCondition(condition: unknown, context: unknown): boolean {
  const result = evaluateExpression(condition, context);
  if (typeof result === 'string') {
    const lower = result.trim().toLowerCase();
    if (lower === 'false') return false;
    if (lower === 'true') return true;
  }
  return pyTruthy(result);
}
