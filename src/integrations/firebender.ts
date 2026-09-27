/**
 * @oakoliver/specify-cli - Firebender IDE integration.
 *
 * Port of `integrations/firebender/__init__.py`.
 *
 * @module integrations/firebender
 */

import { MarkdownIntegration, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class FirebenderIntegration extends MarkdownIntegration {
  key = 'firebender';
  config: IntegrationConfig | null = {
    name: 'Firebender',
    folder: '.firebender/',
    commands_subdir: 'commands',
    install_url: 'https://firebender.com/',
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.firebender/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.mdc',
  };
  multiInstallSafe = true;

  commandFilename(templateName: string): string {
    return `speckit.${templateName}.mdc`;
  }
}
