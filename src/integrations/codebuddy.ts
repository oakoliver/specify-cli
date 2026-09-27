/**
 * @oakoliver/specify-cli - CodeBuddy CLI integration.
 *
 * Port of `integrations/codebuddy/__init__.py`.
 *
 * @module integrations/codebuddy
 */

import { MarkdownIntegration, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class CodebuddyIntegration extends MarkdownIntegration {
  key = 'codebuddy';
  config: IntegrationConfig | null = {
    name: 'CodeBuddy',
    folder: '.codebuddy/',
    commands_subdir: 'commands',
    install_url: 'https://www.codebuddy.cn/docs/cli/installation',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.codebuddy/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  };
  multiInstallSafe = true;
}
