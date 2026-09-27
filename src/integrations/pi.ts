/**
 * @oakoliver/specify-cli - Pi Coding Agent integration.
 *
 * Port of `integrations/pi/__init__.py`.
 *
 * @module integrations/pi
 */

import { MarkdownIntegration, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class PiIntegration extends MarkdownIntegration {
  key = 'pi';
  config: IntegrationConfig | null = {
    name: 'Pi Coding Agent',
    folder: '.pi/',
    commands_subdir: 'prompts',
    install_url: 'https://www.npmjs.com/package/@earendil-works/pi-coding-agent',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.pi/prompts',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  };
  multiInstallSafe = true;
}
