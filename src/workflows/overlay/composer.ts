/**
 * @oakoliver/specify-cli - Workflow Overlay Composer
 *
 * Builds a WorkflowDefinition from a base layer plus overlay layers
 * (port of ``workflows/overlay/composer.py``).
 *
 * @module workflows/overlay/composer
 */

import { ValueError } from '../base.js';
import { WorkflowDefinition } from '../engine.js';
import type { Layer } from './layer-sources.js';
import { allBaseStepIds, mergeSteps, OverlayLayer, validateEdits, type ComposedStep } from './merge.js';

// ============================================================================
// StepListComposer
// ============================================================================

/**
 * Compose a workflow from a base layer and overlay layers.
 *
 * - The base layer (tier="base") provides the full step list.
 * - Overlay layers provide edit operations.
 * - Overlays are applied in merge order: highest priority number first,
 *   lowest last, so lower priority numbers win. Ties are applied by overlay
 *   ID, with the alphabetically last ID winning.
 * - Returns a parsed WorkflowDefinition; callers must validate separately.
 */
export class StepListComposer {
  /**
   * Compose a ``WorkflowDefinition`` from the given layers.
   *
   * Returns ``[null, []]`` when no base layer is present.
   */
  compose(layers: Layer[]): [WorkflowDefinition | null, ComposedStep[]] {
    let baseLayer: Layer | null = null;
    const overlayLayers: Layer[] = [];
    for (const layer of layers) {
      if (layer.tier === 'base') baseLayer = layer;
      else overlayLayers.push(layer);
    }

    if (baseLayer === null || baseLayer.path === null) return [null, []];

    const baseDefinition = WorkflowDefinition.fromYaml(baseLayer.path);
    const baseData = baseDefinition.data as Record<string, unknown>;
    const baseSteps = Object.prototype.hasOwnProperty.call(baseData, 'steps') ? baseData.steps : [];
    if (!Array.isArray(baseSteps)) {
      // Preserve the invalid definition intact so validateWorkflow can report
      // "'steps' must be a list." to the caller.
      return [baseDefinition, []];
    }

    // Last applied wins, so apply lower priority numbers last.
    const mergeOrder = [...overlayLayers].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      const ai = a.content.id;
      const bi = b.content.id;
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });

    // Validate edits against base anchors before mutation.
    const baseStepIds = this.collectBaseStepIds(baseSteps);
    for (const layer of mergeOrder) {
      const editErrors = validateEdits(layer.content.edits, baseStepIds);
      if (editErrors.length > 0) {
        throw new ValueError(`Overlay '${layer.content.id}' has invalid edits:\n  - ` + editErrors.join('\n  - '));
      }
    }

    const [composedSteps, attribution] = mergeSteps(
      baseSteps,
      mergeOrder.map((layer) => new OverlayLayer(layer.content, layer.source)),
    );

    // Build composed data while preserving all non-step fields from base.
    const composedData: Record<string, unknown> = { ...baseData };
    composedData.steps = composedSteps;

    const composedDefinition = new WorkflowDefinition(composedData, baseLayer.path);
    return [composedDefinition, attribution];
  }

  /** Collect all base step IDs reachable in the step tree. */
  collectBaseStepIds(steps: unknown[]): Set<string> {
    return allBaseStepIds(steps);
  }
}
