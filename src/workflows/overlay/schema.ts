/**
 * @oakoliver/specify-cli - Workflow Overlay Schema
 *
 * Dataclasses and validation for overlay manifests
 * (port of ``workflows/overlay/schema.py``).
 *
 * @module workflows/overlay/schema
 */

import { normalizePriority } from '../../extensions/index.js';
import { isMapping, pyRepr } from './py-compat.js';

// ============================================================================
// Constants
// ============================================================================

/** Safe single-segment identifiers: no path separators, no traversal, no dots. */
export const SAFE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const RESERVED_OVERLAY_WORKFLOW_IDS: ReadonlySet<string> = new Set(['overlays']);
export const RESERVED_WORKFLOW_IDS: ReadonlySet<string> = new Set(['overlays', 'runs', 'steps']);

export type OverlayOperation = 'insert_after' | 'insert_before' | 'replace' | 'remove';

export const VALID_OPERATIONS: ReadonlySet<string> = new Set([
  'insert_after',
  'insert_before',
  'replace',
  'remove',
]);

/** Shorthand keys map 1:1 onto operation names. */
const SHORTHAND_OPERATION_KEYS: ReadonlySet<string> = VALID_OPERATIONS;

/** ``sorted(VALID_OPERATIONS)`` as rendered by Python. */
const SORTED_OPERATIONS_REPR = pyRepr([...VALID_OPERATIONS].sort());

// ============================================================================
// Types
// ============================================================================

/** A single edit operation on a workflow step list. */
export interface OverlayEdit {
  readonly operation: OverlayOperation;
  readonly anchor: string;
  readonly step: Record<string, unknown> | null;
}

/** A declared overlay (one YAML file). */
export class Overlay {
  id: string;
  extends: string;
  edits: OverlayEdit[];
  priority: number;
  enabled: boolean;

  constructor(init: { id: string; extends: string; edits: OverlayEdit[]; priority?: number; enabled?: boolean }) {
    this.id = init.id;
    this.extends = init.extends;
    this.edits = init.edits;
    this.priority = init.priority ?? 10;
    this.enabled = init.enabled ?? true;
  }
}

// ============================================================================
// Validation
// ============================================================================

/** Return an error message if *value* is not a safe path segment ID. */
export function validateSafeId(
  value: unknown,
  fieldName: string,
  allowReserved = false,
  reservedIds: ReadonlySet<string> = RESERVED_OVERLAY_WORKFLOW_IDS,
): string | null {
  if (typeof value !== 'string' || !value) {
    return `Overlay '${fieldName}' is required and must be a non-empty string.`;
  }
  if (!SAFE_ID_PATTERN.test(value)) {
    return (
      `Overlay '${fieldName}' ${pyRepr(value)} contains invalid characters; ` +
      'only lowercase letters, digits, and hyphens are allowed.'
    );
  }
  if (!allowReserved && reservedIds.has(value)) {
    return `Overlay '${fieldName}' ${pyRepr(value)} is reserved.`;
  }
  return null;
}

/** Parse a single edit dict into an OverlayEdit or an error string. */
function parseEdit(editRaw: Record<string, unknown>, idx: number): [OverlayEdit | null, string | null] {
  // Iterate the edit's own keys (declaration order) so error messages name
  // the offending keys deterministically.
  const shorthandKeys = Object.keys(editRaw).filter((key) => SHORTHAND_OPERATION_KEYS.has(key));
  const hasOperation = Object.prototype.hasOwnProperty.call(editRaw, 'operation');

  let operation: unknown = null;
  let anchor: unknown = null;

  if (shorthandKeys.length > 0 && hasOperation) {
    return [
      null,
      `Edit at index ${idx} mixes shorthand operation key ` +
        `(${pyRepr(shorthandKeys[0])}) with explicit 'operation' field.`,
    ];
  }

  if (shorthandKeys.length > 1) {
    return [
      null,
      `Edit at index ${idx} has multiple operation keys: ` + `${shorthandKeys.map((k) => pyRepr(k)).join(', ')}.`,
    ];
  }

  if (shorthandKeys.length > 0) {
    operation = shorthandKeys[0];
    anchor = editRaw[shorthandKeys[0]];
  } else if (hasOperation) {
    operation = editRaw.operation ?? null;
    anchor = editRaw.anchor ?? null;
  } else {
    return [null, `Edit at index ${idx} has no operation; expected one of ${SORTED_OPERATIONS_REPR}.`];
  }

  if (typeof operation !== 'string' || !VALID_OPERATIONS.has(operation)) {
    return [null, `Edit at index ${idx} has invalid operation ${pyRepr(operation)}.`];
  }

  if (typeof anchor !== 'string' || !anchor) {
    return [null, `Edit at index ${idx} has invalid 'anchor'.`];
  }

  const step = editRaw.step ?? null;
  if (operation === 'remove') {
    if (step !== null) {
      return [null, `Edit at index ${idx} ('remove') must not include 'step'.`];
    }
    return [{ operation: 'remove', anchor, step: null }, null];
  }

  if (!isMapping(step)) {
    return [null, `Edit at index ${idx} ('${operation}') requires 'step' mapping.`];
  }
  const stepId = step.id;
  if (typeof stepId !== 'string' || !stepId) {
    return [null, `Edit at index ${idx} step is missing required 'id'.`];
  }
  if (stepId.includes(':')) {
    return [
      null,
      `Edit at index ${idx} step id ${pyRepr(stepId)} contains ':' ` +
        'which is reserved for engine-generated nested IDs.',
    ];
  }
  return [{ operation: operation as OverlayOperation, anchor, step }, null];
}

/**
 * Validate an overlay manifest dict and return ``[Overlay, errors]``.
 *
 * Errors are returned as a list of strings; validation never throws.
 */
export function validateOverlayYaml(data: unknown): [Overlay | null, string[]] {
  const errors: string[] = [];

  if (!isMapping(data)) {
    return [null, ['Overlay manifest must be a mapping.']];
  }

  let overlayId: unknown = data.id ?? null;
  let err = validateSafeId(overlayId, 'id');
  if (err) {
    errors.push(err);
    overlayId = '';
  }

  let extendsId: unknown = data.extends ?? null;
  err = validateSafeId(extendsId, 'extends', false, RESERVED_WORKFLOW_IDS);
  if (err) {
    errors.push(err);
    extendsId = '';
  }

  const priority = normalizePriority(Object.prototype.hasOwnProperty.call(data, 'priority') ? data.priority : 10);

  const editsRaw = data.edits;
  const edits: OverlayEdit[] = [];
  if (!Array.isArray(editsRaw)) {
    errors.push("Overlay 'edits' is required and must be a list.");
  } else if (editsRaw.length === 0) {
    errors.push("Overlay 'edits' must be a non-empty list.");
  } else {
    editsRaw.forEach((editRaw, idx) => {
      if (!isMapping(editRaw)) {
        errors.push(`Edit at index ${idx} must be a mapping.`);
        return;
      }
      const [edit, editErr] = parseEdit(editRaw, idx);
      if (editErr) {
        errors.push(editErr);
        return;
      }
      if (edit !== null) edits.push(edit);
    });
  }

  let enabled: unknown = Object.prototype.hasOwnProperty.call(data, 'enabled') ? data.enabled : true;
  if (typeof enabled !== 'boolean') {
    errors.push("Overlay 'enabled' must be a boolean.");
    enabled = Boolean(enabled);
  }

  if (errors.length > 0) {
    return [null, errors];
  }

  return [
    new Overlay({
      id: overlayId as string,
      extends: extendsId as string,
      priority,
      edits,
      enabled: enabled as boolean,
    }),
    [],
  ];
}
