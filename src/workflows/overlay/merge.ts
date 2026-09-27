/**
 * @oakoliver/specify-cli - Workflow Overlay Merge Engine
 *
 * Pure-function merge engine for workflow step lists
 * (port of ``workflows/overlay/merge.py``).
 *
 * @module workflows/overlay/merge
 */

import { ValueError } from '../base.js';
import { deepCopy, isMapping, pyRepr } from './py-compat.js';
import { VALID_OPERATIONS, type Overlay, type OverlayEdit } from './schema.js';

// ============================================================================
// Types
// ============================================================================

export type StepDict = Record<string, unknown>;

/** Attribution tracking for a single composed step. */
export interface ComposedStep {
  readonly step_id: string;
  readonly source: string;
}

/** An overlay together with its layer source for attribution. */
export class OverlayLayer {
  constructor(
    readonly overlay: Overlay,
    readonly source: string,
  ) {}
}

type LayerEdit = [OverlayLayer, OverlayEdit];

/** Nested step keys that may contain a list of steps. */
const NESTED_LIST_KEYS = ['then', 'else', 'steps', 'default'] as const;

// ============================================================================
// Tree helpers
// ============================================================================

function* nestedLists(step: StepDict): Generator<unknown[]> {
  for (const key of NESTED_LIST_KEYS) {
    const nested = step[key];
    if (Array.isArray(nested)) yield nested;
  }
  const cases = step.cases;
  if (isMapping(cases)) {
    for (const caseSteps of Object.values(cases)) {
      if (Array.isArray(caseSteps)) yield caseSteps;
    }
  }
}

/**
 * Recursively locate a step by ID and return its ``[parentList, index]``.
 *
 * Searches flat lists and nested lists inside ``then``, ``else``, ``steps``,
 * ``default``, and ``cases.*``. Does *not* descend into ``fan-out`` template
 * steps because those are runtime-multiplied stamps.
 */
export function findStep(steps: unknown[], stepId: string): [unknown[], number] | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!isMapping(step)) continue;
    if (step.id === stepId) return [steps, i];
    for (const nested of nestedLists(step)) {
      const result = findStep(nested, stepId);
      if (result !== null) return result;
    }
  }
  return null;
}

/** Collect all step IDs reachable in a step tree (excluding fan-out templates). */
export function allBaseStepIds(steps: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const step of steps) {
    if (!isMapping(step)) continue;
    if (typeof step.id === 'string') ids.add(step.id);
    for (const nested of nestedLists(step)) {
      for (const id of allBaseStepIds(nested)) ids.add(id);
    }
  }
  return ids;
}

/** Return all step IDs nested inside *step* (not including *step* itself). */
function descendantIds(step: StepDict): Set<string> {
  const ids = new Set<string>();
  for (const nested of nestedLists(step)) {
    for (const id of allBaseStepIds(nested)) ids.add(id);
  }
  return ids;
}

/** Python ``sorted()`` over strings (code-point order). */
function pySorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Return error messages for anchor pairs where one is an ancestor of the other.
 *
 * Only flags conflicts where the ancestor's winning edit is ``replace`` or
 * ``remove``.
 */
function checkAnchorConflicts(anchorOperations: Map<string, string>, baseSteps: unknown[]): string[] {
  const errors: string[] = [];
  for (const anchor of pySorted(anchorOperations.keys())) {
    const operation = anchorOperations.get(anchor);
    if (operation === 'insert_after' || operation === 'insert_before') continue;
    const location = findStep(baseSteps, anchor);
    if (location === null) continue;
    const [parentList, idx] = location;
    const step = parentList[idx] as StepDict;
    const desc = descendantIds(step);
    const conflicting = [...anchorOperations.keys()].filter((k) => desc.has(k));
    for (const childAnchor of pySorted(conflicting)) {
      errors.push(
        `Anchor conflict: '${anchor}' is an ancestor of '${childAnchor}'. ` +
          'Targeting both anchors in the same overlay set produces ' +
          'order-dependent results; restructure edits to avoid nesting.',
      );
    }
  }
  return errors;
}

function initSourcesRecursively(steps: unknown[], sources: Map<string, string>): void {
  for (const step of steps) {
    if (!isMapping(step)) continue;
    if (typeof step.id === 'string') sources.set(step.id, 'base');
    for (const nested of nestedLists(step)) initSourcesRecursively(nested, sources);
  }
}

/** Record *source* for a step and all its nested child steps. */
function recordSourcesRecursively(step: StepDict, source: string, sources: Map<string, string>): void {
  if (typeof step.id === 'string') sources.set(step.id, source);
  for (const nested of nestedLists(step)) {
    for (const child of nested) {
      if (isMapping(child)) recordSourcesRecursively(child, source, sources);
    }
  }
}

/** Remove base source entries for a step and all its nested child steps. */
function removeSourcesRecursively(step: StepDict, sources: Map<string, string>): void {
  if (typeof step.id === 'string' && sources.get(step.id) === 'base') sources.delete(step.id);
  for (const nested of nestedLists(step)) {
    for (const child of nested) {
      if (isMapping(child)) removeSourcesRecursively(child, sources);
    }
  }
}

/** Build an ordered attribution list from the composed step tree. */
function buildAttribution(steps: unknown[], sources: Map<string, string>): ComposedStep[] {
  const result: ComposedStep[] = [];
  for (const step of steps) {
    if (!isMapping(step)) continue;
    if (typeof step.id === 'string') {
      result.push({ step_id: step.id, source: sources.get(step.id) ?? 'unknown' });
    }
    for (const nested of nestedLists(step)) result.push(...buildAttribution(nested, sources));
  }
  return result;
}

/**
 * Return the edit that decides an anchor's fate.
 *
 * Normally the last edit in merge order; when the last edit is an
 * ``insert_*``, a ``replace`` declared by that same overlay is honoured
 * (unless that layer also declared a ``remove`` on the anchor).
 */
function winningFateEdit(edits: LayerEdit[]): LayerEdit | null {
  if (edits.length === 0) return null;
  const last = edits[edits.length - 1];
  const [winningLayer, lastEdit] = last;
  if (lastEdit.operation !== 'insert_after' && lastEdit.operation !== 'insert_before') return last;
  let replacement: LayerEdit | null = null;
  for (const [layer, edit] of edits) {
    if (layer !== winningLayer) continue;
    if (edit.operation === 'remove') return last;
    if (edit.operation === 'replace') replacement = [layer, edit];
  }
  return replacement ?? last;
}

/** Walk the original step tree and apply overlay edits as each step is encountered. */
function traverseAndApply(
  steps: unknown[],
  editsByAnchor: Map<string, LayerEdit[]>,
  sources: Map<string, string>,
): unknown[] {
  const result: unknown[] = [];

  for (const step of steps) {
    if (!isMapping(step)) {
      result.push(step);
      continue;
    }

    const stepId = step.id;
    const edits = typeof stepId === 'string' ? (editsByAnchor.get(stepId) ?? []) : [];
    const fate = winningFateEdit(edits);
    const winningEdit = fate !== null ? fate[1] : null;

    if (winningEdit !== null && winningEdit.operation === 'remove') {
      continue;
    }

    // Insert before (in merge order).
    for (const [layer, edit] of edits) {
      if (edit.operation === 'insert_before') {
        const newStep = deepCopy(edit.step as StepDict);
        recordSourcesRecursively(newStep, layer.source, sources);
        result.push(newStep);
      }
    }

    if (winningEdit !== null && winningEdit.operation === 'replace' && fate !== null) {
      const winningLayer = fate[0];
      const newStep = deepCopy(winningEdit.step as StepDict);
      removeSourcesRecursively(step, sources);
      recordSourcesRecursively(newStep, winningLayer.source, sources);
      result.push(newStep);
    } else {
      for (const key of NESTED_LIST_KEYS) {
        const nested = step[key];
        if (Array.isArray(nested)) step[key] = traverseAndApply(nested, editsByAnchor, sources);
      }
      const cases = step.cases;
      if (isMapping(cases)) {
        for (const [caseKey, caseSteps] of Object.entries(cases)) {
          if (Array.isArray(caseSteps)) cases[caseKey] = traverseAndApply(caseSteps, editsByAnchor, sources);
        }
      }
      result.push(step);
    }

    // Insert after: higher-priority overlays land closer to the anchor, but
    // a single overlay's own inserts keep their declared order.
    const afterGroups: LayerEdit[][] = [];
    for (const [layer, edit] of edits) {
      if (edit.operation !== 'insert_after') continue;
      const lastGroup = afterGroups[afterGroups.length - 1];
      if (lastGroup && lastGroup[0][0] === layer) {
        lastGroup.push([layer, edit]);
      } else {
        afterGroups.push([[layer, edit]]);
      }
    }
    for (const group of [...afterGroups].reverse()) {
      for (const [layer, edit] of group) {
        const newStep = deepCopy(edit.step as StepDict);
        recordSourcesRecursively(newStep, layer.source, sources);
        result.push(newStep);
      }
    }
  }

  return result;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Apply overlays to base steps in merge order and return composed steps.
 *
 * *overlays* is expected to be sorted by merge order (lowest priority first,
 * highest priority last). *baseSteps* is never mutated.
 *
 * @throws Error (Python ``ValueError``) on missing anchors or anchor conflicts.
 */
export function mergeSteps(baseSteps: unknown[], overlays: OverlayLayer[]): [unknown[], ComposedStep[]] {
  const steps = deepCopy(baseSteps);
  const sources = new Map<string, string>();
  initSourcesRecursively(steps, sources);

  const editsByAnchor = new Map<string, LayerEdit[]>();
  for (const layer of overlays) {
    for (const edit of layer.overlay.edits) {
      const list = editsByAnchor.get(edit.anchor);
      if (list) list.push([layer, edit]);
      else editsByAnchor.set(edit.anchor, [[layer, edit]]);
    }
  }

  const baseIds = allBaseStepIds(baseSteps);
  for (const [anchor, anchorEdits] of editsByAnchor) {
    const winningOp = anchorEdits[anchorEdits.length - 1][1].operation;
    if (winningOp !== 'remove' && !baseIds.has(anchor)) {
      throw new ValueError(`Anchor '${anchor}' not found in workflow steps.`);
    }
  }

  const anchorWinningOps = new Map<string, string>();
  for (const [anchor, anchorEdits] of editsByAnchor) {
    const anchorFate = winningFateEdit(anchorEdits);
    anchorWinningOps.set(
      anchor,
      anchorFate !== null ? anchorFate[1].operation : anchorEdits[anchorEdits.length - 1][1].operation,
    );
  }
  const anchorConflicts = checkAnchorConflicts(anchorWinningOps, baseSteps);
  if (anchorConflicts.length > 0) {
    throw new ValueError('Overlay anchor conflict(s) detected:\n  - ' + anchorConflicts.join('\n  - '));
  }

  const result = traverseAndApply(steps, editsByAnchor, sources);
  const attribution = buildAttribution(result, sources);
  return [result, attribution];
}

/**
 * Validate overlay edits against a set of known base step IDs.
 *
 * Returns a list of human-readable error messages. Does not throw.
 */
export function validateEdits(edits: readonly OverlayEdit[], baseStepIds: Set<string>): string[] {
  const errors: string[] = [];
  edits.forEach((edit, idx) => {
    if (!VALID_OPERATIONS.has(edit.operation)) {
      errors.push(`Edit ${idx}: invalid operation ${pyRepr(edit.operation)}.`);
      return;
    }
    if (!baseStepIds.has(edit.anchor)) {
      errors.push(`Edit ${idx}: anchor '${edit.anchor}' does not match any base step id.`);
    }
    if (edit.operation === 'remove') {
      if (edit.step !== null && edit.step !== undefined) {
        errors.push(`Edit ${idx}: 'remove' must not include a step.`);
      }
      return;
    }
    if (!isMapping(edit.step)) {
      errors.push(`Edit ${idx}: '${edit.operation}' requires a step mapping.`);
      return;
    }
    const stepId = edit.step.id;
    if (typeof stepId !== 'string' || !stepId) {
      errors.push(`Edit ${idx}: step is missing required 'id'.`);
      return;
    }
    if (stepId.includes(':')) {
      errors.push(
        `Edit ${idx}: step id ${pyRepr(stepId)} contains ':' which is reserved ` +
          'for engine-generated nested IDs.',
      );
    }
  });
  return errors;
}
