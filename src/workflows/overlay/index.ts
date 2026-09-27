/**
 * @oakoliver/specify-cli - Workflow Overlays
 *
 * Workflow overlay domain API (port of ``workflows/overlay/__init__.py``).
 * The nested ``specify workflow overlay`` CLI lives in ``./commands.ts``.
 *
 * @module workflows/overlay
 */

export { WorkflowResolver } from './resolver.js';
export { StepListComposer } from './composer.js';
export {
  BaseWorkflowSource,
  OverlayLoadError,
  ProjectOverlaySource,
  type Layer,
} from './layer-sources.js';
export { findStep, mergeSteps, OverlayLayer, validateEdits, type ComposedStep } from './merge.js';
export {
  Overlay,
  RESERVED_WORKFLOW_IDS,
  SAFE_ID_PATTERN,
  VALID_OPERATIONS,
  validateOverlayYaml,
  type OverlayEdit,
  type OverlayOperation,
} from './schema.js';
