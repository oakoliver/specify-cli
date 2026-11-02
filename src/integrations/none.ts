/**
 * @oakoliver/specify-cli - An artifact-free integration for teams using
 * shared scaffolding only.
 *
 * Port of `integrations/none/__init__.py` (spec-kit v1.2.5).
 *
 * @module integrations/none
 */

import { IntegrationBase, type IntegrationConfig } from './base.js';
import type { IntegrationManifest } from './manifest.js';

export class NoneIntegration extends IntegrationBase {
  key = 'none';
  multiInstallSafe = true;
  // Upstream's config has no ``commands_subdir`` key.
  config: IntegrationConfig | null = {
    name: 'None (shared scaffolding only)',
    folder: null,
    install_url: null,
    requires_cli: false,
  } as unknown as IntegrationConfig;

  listCommandTemplates(): string[] {
    return [];
  }

  /** Remove only this integration's own manifest entries (no event cleanup). */
  teardown(projectRoot: string, manifest: IntegrationManifest, opts: { force?: boolean } = {}): [string[], string[]] {
    return manifest.uninstall(projectRoot, { force: opts.force ?? false });
  }
}
