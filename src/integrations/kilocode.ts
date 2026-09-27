/**
 * @oakoliver/specify-cli - Kilo Code integration.
 *
 * Port of `integrations/kilocode/__init__.py`.
 *
 * @module integrations/kilocode
 */

import { MarkdownIntegration, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class KilocodeIntegration extends MarkdownIntegration {
  key = 'kilocode';
  config: IntegrationConfig | null = {
    name: 'Kilo Code',
    folder: '.kilo/',
    commands_subdir: 'commands',
    install_url: null,
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.kilo/commands',
    legacy_dir: '.kilocode/workflows',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  };
  multiInstallSafe = true;
}
