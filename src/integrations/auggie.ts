/**
 * @oakoliver/specify-cli - Auggie CLI integration.
 *
 * Port of `integrations/auggie/__init__.py`.
 *
 * @module integrations/auggie
 */

import { MarkdownIntegration, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class AuggieIntegration extends MarkdownIntegration {
  key = 'auggie';
  config: IntegrationConfig | null = {
    name: 'Auggie CLI',
    folder: '.augment/',
    commands_subdir: 'commands',
    install_url: 'https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.augment/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  };
  multiInstallSafe = true;
}
