/**
 * @oakoliver/specify-cli - Workflow Overlay Resolver
 *
 * Resolves a workflow ID to its composed definition
 * (port of ``workflows/overlay/resolver.py``).
 *
 * @module workflows/overlay/resolver
 */

import { FileNotFoundError, ValueError } from '../base.js';
import type { WorkflowDefinition } from '../engine.js';
import { StepListComposer } from './composer.js';
import { BaseWorkflowSource, ProjectOverlaySource, type Layer } from './layer-sources.js';
import type { ComposedStep } from './merge.js';
import { pyRepr } from './py-compat.js';
import { RESERVED_WORKFLOW_IDS, SAFE_ID_PATTERN } from './schema.js';

function validateWorkflowId(workflowId: unknown): void {
  if (typeof workflowId !== 'string' || !SAFE_ID_PATTERN.test(workflowId) || RESERVED_WORKFLOW_IDS.has(workflowId)) {
    throw new ValueError(`Invalid workflow ID: ${pyRepr(workflowId)}`);
  }
}

// ============================================================================
// WorkflowResolver
// ============================================================================

/**
 * Resolves a workflow ID to its composed ``WorkflowDefinition``.
 *
 * Collects layers from two tiers:
 * - project-local overlays (``.specify/workflows/overlays/<id>/*.yml``)
 * - the base workflow itself (``.specify/workflows/<id>/workflow.yml``)
 *
 * Resolution is lower-wins: overlays with lower priority numbers are applied
 * later and override earlier edits on the same anchors.
 */
export class WorkflowResolver {
  readonly projectRoot: string;
  private readonly sources: Array<ProjectOverlaySource | BaseWorkflowSource>;
  private readonly composer: StepListComposer;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.sources = [new ProjectOverlaySource(projectRoot), new BaseWorkflowSource(projectRoot)];
    this.composer = new StepListComposer();
  }

  /**
   * Collect overlays sorted by precedence, followed by the base layer.
   *
   * Lower priority numbers win. Ties are sorted alphabetically by source.
   */
  collectAllLayers(workflowId: string, opts: { includeDisabled?: boolean } = {}): Layer[] {
    validateWorkflowId(workflowId);

    const allLayers: Layer[] = [];
    for (const source of this.sources) {
      allLayers.push(...source.collect(workflowId, { includeDisabled: opts.includeDisabled ?? false }));
    }

    const overlays = allLayers.filter((layer) => layer.tier !== 'base');
    const baseLayers = allLayers.filter((layer) => layer.tier === 'base');
    overlays.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
    });
    return [...overlays, ...baseLayers];
  }

  /**
   * Resolve a workflow ID to its composed definition (not validated).
   *
   * @throws FileNotFoundError if the workflow cannot be found.
   * @throws Error if layer collection/composition fails.
   */
  resolve(workflowId: string): WorkflowDefinition {
    const layers = this.collectAllLayers(workflowId);
    const [definition] = this.composer.compose(layers);
    if (definition === null) throw new FileNotFoundError(`Workflow not found: ${workflowId}`);
    return definition;
  }

  /** Resolve a workflow and return its definition plus layer attribution. */
  resolveWithLayers(workflowId: string): [WorkflowDefinition, Layer[], ComposedStep[]] {
    const layers = this.collectAllLayers(workflowId);
    const [definition, attribution] = this.composer.compose(layers);
    if (definition === null) throw new FileNotFoundError(`Workflow not found: ${workflowId}`);
    return [definition, layers, attribution];
  }
}
