/**
 * @oakoliver/specify-cli - SHAI CLI integration.
 *
 * Port of `integrations/shai/__init__.py`.
 *
 * @module integrations/shai
 */

import { MarkdownIntegration, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class ShaiIntegration extends MarkdownIntegration {
  key = 'shai';
  config: IntegrationConfig | null = {
    name: 'SHAI',
    folder: '.shai/',
    commands_subdir: 'commands',
    install_url: 'https://github.com/ovh/shai',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.shai/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  };
  multiInstallSafe = true;
}
