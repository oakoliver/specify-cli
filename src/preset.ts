/**
 * @oakoliver/specify-cli - Preset Management (legacy entry point)
 *
 * Compatibility re-export layer. The preset system is now a faithful port of
 * upstream ``specify_cli/presets`` and lives in ``src/presets/``; this module
 * keeps the historical names importable from ``./preset.js``.
 *
 * Intentional changes vs. the pre-1.0 loose port (matching upstream):
 * - ``VALID_TEMPLATE_TYPES`` are the upstream template *types*
 *   (``template``, ``command``, ``script``), not template names.
 * - ``PresetRegistry`` is constructed with the ``.specify/presets`` directory.
 * - ``PresetResolver.resolve()`` returns a file path (use ``resolveContent()``
 *   for composed content, ``resolveWithSource()`` for attribution).
 *
 * @module preset
 */

import {
  PresetCompatibilityError,
  PresetError,
  PresetManifest,
  PresetValidationError,
  VALID_PRESET_STRATEGIES,
  VALID_PRESET_TEMPLATE_TYPES,
  VALID_SCRIPT_STRATEGIES,
  type PresetTemplateEntry,
} from './presets/manifest.js';
import { PresetRegistry, type PresetRegistryEntry } from './presets/registry.js';
import { PresetManager as PresetManagerBase, type InstalledPresetRecord } from './presets/manager.js';
import { PresetResolver } from './presets/resolver.js';
import { PresetCatalog, PresetCatalogEntry } from './presets/catalog.js';

// ============================================================================
// Constants
// ============================================================================

/** Current preset manifest schema version. */
export const PRESET_SCHEMA_VERSION = PresetManifest.SCHEMA_VERSION;

/** Preset ID pattern: lowercase alphanumeric + hyphens. */
export const PRESET_ID_PATTERN = /^[a-z0-9-]+$/;

/** Valid ``provides.templates[].type`` values (upstream ``VALID_PRESET_TEMPLATE_TYPES``). */
export const VALID_TEMPLATE_TYPES = ['command', 'script', 'template'] as const;

export type TemplateType = (typeof VALID_TEMPLATE_TYPES)[number];

// ============================================================================
// Types (legacy names)
// ============================================================================

/** Template definition in a preset manifest. */
export type PresetTemplate = PresetTemplateEntry;

/** Parsed preset manifest (preset.yml) data. */
export type PresetManifestData = Record<string, any>;

/** Registry metadata for an installed preset. */
export type PresetMetadata = PresetRegistryEntry;

/** Preset info for listing (``PresetManager.listInstalled()`` record). */
export type PresetInfo = InstalledPresetRecord;

/** Template resolution result (legacy shape). */
export interface ResolvedTemplate {
  content: string;
  source: string;
  source_id?: string;
}

// ============================================================================
// Legacy PresetManager conveniences
// ============================================================================

/**
 * ``PresetManager`` with the pre-1.0 convenience methods kept for callers of
 * the legacy entry point. Behavior mirrors the upstream CLI handlers
 * (``specify preset enable|disable|set-priority``) without console output.
 */
export class PresetManager extends PresetManagerBase {
  /** Legacy alias of {@link PresetManagerBase.getPack}. */
  getPreset(presetId: string): PresetManifest | null {
    return this.getPack(presetId);
  }

  /** Enable a preset (registry update + constitution reconciliation). */
  enable(presetId: string): void {
    this.registry.update(presetId, { enabled: true });
    this.reconcileConstitution(`Failed to reconcile constitution after enabling preset ${presetId}`);
  }

  /** Disable a preset (registry update + constitution reconciliation). */
  disable(presetId: string): void {
    this.registry.update(presetId, { enabled: false });
    this.reconcileConstitution(`Failed to reconcile constitution after disabling preset ${presetId}`);
  }

  /** Set a preset's resolution priority. */
  setPriority(presetId: string, priority: number): void {
    if (priority < 1) throw new PresetValidationError('Priority must be a positive integer (1 or higher)');
    this.registry.update(presetId, { priority });
    this.reconcileConstitution(`Failed to reconcile constitution after changing priority for preset ${presetId}`);
  }
}

// ============================================================================
// Re-exports
// ============================================================================

export {
  PresetCatalog,
  PresetCatalogEntry,
  PresetCompatibilityError,
  PresetError,
  PresetManifest,
  PresetRegistry,
  PresetResolver,
  PresetValidationError,
  VALID_PRESET_STRATEGIES,
  VALID_PRESET_TEMPLATE_TYPES,
  VALID_SCRIPT_STRATEGIES,
};

export {
  PresetManifest as Manifest,
  PresetRegistry as Registry,
  PresetManager as Manager,
  PresetResolver as Resolver,
};
