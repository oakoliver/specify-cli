/**
 * @oakoliver/specify-cli - Workflow expression namespace
 *
 * Port of ``specify_cli/workflows/expressions/namespace.py``: the namespace a
 * template is evaluated against and the dot-path walk over it.
 *
 * @module workflows/expressions/namespace
 */

import { isDict, type Dict } from '../base.js';

/**
 * The one definition of an indexed path segment, including the negative form
 * Python and Jinja2 both accept (``task_list[-1]``). ``resolveDotPath`` matches
 * against it, and the condition gate reuses it.
 */
export const INDEXED_SEGMENT = /^([\p{L}\p{N}\p{M}_-]+)\[(-?\d+)\]$/u;
export const PLAIN_SEGMENT = /^[\p{L}\p{N}\p{M}_-]+$/u;

/** The roots ``buildNamespace`` supplies. */
export const NAMESPACE_ROOTS = ['inputs', 'steps', 'item', 'fan_in', 'context'] as const;

function dictGet(obj: Dict, key: string): unknown {
  const v = Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : null;
  return v === undefined ? null : v;
}

/**
 * Resolve a dotted path like ``steps.specify.output.file`` against *obj*.
 * Supports dict key access and list indexing, including the negative form
 * (e.g., ``task_list[0]``, ``task_list[-1]``).
 */
export function resolveDotPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    const idxMatch = INDEXED_SEGMENT.exec(part);
    if (idxMatch) {
      const key = idxMatch[1] as string;
      const idx = parseInt(idxMatch[2] as string, 10);
      if (isDict(current)) current = dictGet(current, key);
      else return null;
      if (Array.isArray(current) && -current.length <= idx && idx < current.length) {
        current = current[idx < 0 ? current.length + idx : idx];
      } else return null;
    } else if (isDict(current)) {
      current = dictGet(current, part);
    } else {
      return null;
    }
    if (current === null || current === undefined) return null;
  }
  return current;
}

/** Minimal shape of a context accepted by the evaluator (a ``StepContext``). */
export interface ExpressionContext {
  inputs?: Dict | null;
  steps?: Record<string, unknown> | null;
  item?: unknown;
  fanIn?: Dict | null;
  runId?: string | null;
  workflowDir?: string | null;
}

/** Build the variable namespace from a StepContext. */
export function buildNamespace(context: unknown): Dict {
  const ns: Dict = {};
  const ctx = (isDict(context) ? context : {}) as ExpressionContext & Dict;
  if ('inputs' in ctx) ns.inputs = ctx.inputs || {};
  if ('steps' in ctx) ns.steps = ctx.steps || {};
  if ('item' in ctx) ns.item = ctx.item === undefined ? null : ctx.item;
  if ('fanIn' in ctx) ns.fan_in = ctx.fanIn || {};
  // Engine-managed runtime metadata. Always present (even outside a run) so
  // templates referencing it never error.
  const runId = ctx.runId || '';
  const workflowDir = ctx.workflowDir || '';
  ns.context = { run_id: runId, workflow_dir: workflowDir };
  return ns;
}
