/**
 * @oakoliver/specify-cli - Artifact inventory and resolution
 *
 * Port of spec-kit v1.0.12 ``specify_cli/artifacts/__init__.py``: public API
 * for artifact inventory and resolution (``specify artifact list|info|lookup``).
 *
 * @module artifacts
 */

export { ArtifactCatalog } from './catalog.js';
export {
  AmbiguousArtifactError,
  Artifact,
  ArtifactError,
  ArtifactNotFoundError,
  ArtifactResolutionError,
  ContributionNotFoundError,
  HookArtifact,
  HookStackEntry,
  NotASpecKitProjectError,
  StackLayer,
  type ArtifactKind,
  type HookLayerName,
  type LayerName,
  type Strategy,
} from './models.js';
export { runArtifactCommand, ARTIFACT_COMMANDS } from './commands.js';
