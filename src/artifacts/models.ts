/**
 * @oakoliver/specify-cli - Artifact data contracts and errors
 *
 * Port of spec-kit v1.0.12 ``specify_cli/artifacts/models.py``: public data
 * contracts and errors for artifact inspection (``specify artifact``).
 *
 * @module artifacts/models
 */

import { compareCodePoints, pyRepr } from '../events/py-compat.js';

// ============================================================================
// Types
// ============================================================================

export type ArtifactKind = 'command' | 'template' | 'script' | 'hook';
export type LayerName = 'project' | 'preset' | 'extension';
export type Strategy = 'replace' | 'wrap' | 'prepend' | 'append';
export type HookLayerName = 'preset' | 'extension';

// ============================================================================
// Records
// ============================================================================

/** One row in the flat artifact inventory. */
export class Artifact {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly kind: ArtifactKind,
    readonly description: string,
  ) {}

  toJsonDict(): Record<string, unknown> {
    return { id: this.id, name: this.name, kind: this.kind, description: this.description };
  }
}

export interface StackLayerFields {
  id: string;
  layer: LayerName | null;
  sourceId: string | null;
  presetId: string | null;
  presetName: string | null;
  strategy: Strategy;
  active: boolean;
  hidden: boolean;
  manifestPath: string | null;
  lookupId: string | null;
  sourcePath: string | null;
}

/**
 * One row in an artifact's ordered composition stack. ``id`` is the
 * source-agnostic round-trip key; ``lookupId`` identifies a specific non-core
 * contribution when one exists.
 */
export class StackLayer implements StackLayerFields {
  readonly id!: string;
  readonly layer!: LayerName | null;
  readonly sourceId!: string | null;
  readonly presetId!: string | null;
  readonly presetName!: string | null;
  readonly strategy!: Strategy;
  readonly active!: boolean;
  readonly hidden!: boolean;
  readonly manifestPath!: string | null;
  readonly lookupId!: string | null;
  readonly sourcePath!: string | null;

  constructor(fields: StackLayerFields) {
    Object.assign(this, fields);
    Object.freeze(this);
  }

  toJsonDict(): Record<string, unknown> {
    return {
      id: this.id,
      layer: this.layer,
      sourceId: this.sourceId,
      presetId: this.presetId,
      presetName: this.presetName,
      strategy: this.strategy,
      active: this.active,
      hidden: this.hidden,
      manifestPath: this.manifestPath,
      lookupId: this.lookupId,
      sourcePath: this.sourcePath,
    };
  }
}

export interface HookArtifactFields {
  id: string;
  name: string;
  kind: 'hook';
  description: string;
  eventName: string;
  targetCommand: string;
  registered: boolean;
}

/** One hook row keyed by its event and target command. */
export class HookArtifact implements HookArtifactFields {
  readonly id!: string;
  readonly name!: string;
  readonly kind!: 'hook';
  readonly description!: string;
  readonly eventName!: string;
  readonly targetCommand!: string;
  readonly registered!: boolean;

  constructor(fields: HookArtifactFields) {
    Object.assign(this, fields);
    Object.freeze(this);
  }

  toJsonDict(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      kind: this.kind,
      description: this.description,
      eventName: this.eventName,
      targetCommand: this.targetCommand,
      registered: this.registered,
    };
  }
}

export interface HookStackEntryFields {
  id: string;
  layer: HookLayerName;
  sourceId: string;
  presetId: string | null;
  presetName: string | null;
  strategy: 'additive';
  active: boolean;
  hidden: boolean;
  manifestPath: string;
  lookupId: string;
  sourcePath: null;
  priority: number;
  optional: boolean;
}

/** One additive hook declaration in a hook artifact stack. */
export class HookStackEntry implements HookStackEntryFields {
  readonly id!: string;
  readonly layer!: HookLayerName;
  readonly sourceId!: string;
  readonly presetId!: string | null;
  readonly presetName!: string | null;
  readonly strategy!: 'additive';
  readonly active!: boolean;
  readonly hidden!: boolean;
  readonly manifestPath!: string;
  readonly lookupId!: string;
  readonly sourcePath!: null;
  readonly priority!: number;
  readonly optional!: boolean;

  constructor(fields: HookStackEntryFields) {
    Object.assign(this, fields);
    Object.freeze(this);
  }

  toJsonDict(): Record<string, unknown> {
    return {
      id: this.id,
      layer: this.layer,
      sourceId: this.sourceId,
      presetId: this.presetId,
      presetName: this.presetName,
      strategy: this.strategy,
      active: this.active,
      hidden: this.hidden,
      manifestPath: this.manifestPath,
      lookupId: this.lookupId,
      sourcePath: this.sourcePath,
      priority: this.priority,
      optional: this.optional,
    };
  }
}

// ============================================================================
// Errors
// ============================================================================

/** Base class for artifact command errors with stable messages. */
export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ArtifactNotFoundError extends ArtifactError {
  constructor(name: string) {
    super(`unknown artifact ${name}`);
  }
}

export class ContributionNotFoundError extends ArtifactError {
  constructor(lookupId: string) {
    super(`unknown contribution ${lookupId}`);
  }
}

export class AmbiguousArtifactError extends ArtifactError {
  constructor(name: string, kinds: Iterable<string>) {
    const kindsList = [...kinds].sort(compareCodePoints);
    super(`ambiguous artifact ${name}: matches kinds ${pyRepr(kindsList)}`);
  }
}

export class NotASpecKitProjectError extends ArtifactError {
  constructor() {
    super('not a Spec Kit project: no .specify/ directory found');
  }
}

export class ArtifactResolutionError extends ArtifactError {
  constructor() {
    super('artifact resolution failed');
  }
}
