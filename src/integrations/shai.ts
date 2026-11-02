/**
 * @oakoliver/specify-cli - SHAI CLI integration.
 *
 * Port of `integrations/shai/__init__.py`.
 *
 * @module integrations/shai
 */

import { MarkdownIntegration, type ExecArgsOptions, type IntegrationConfig, type RegistrarConfig } from './base.js';

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

  /**
   * SHAI's headless routes all go to its auto-fix agent and never load
   * ``.shai/commands``, so ``shai -p <prompt>`` reported success without
   * running the Spec Kit command (upstream #4791). Opt out of CLI dispatch so
   * workflow steps fail instead.
   */
  buildExecArgs(_prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    return null;
  }
}
