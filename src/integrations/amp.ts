/**
 * @oakoliver/specify-cli - Amp CLI integration.
 *
 * Port of `integrations/amp/__init__.py`.
 *
 * @module integrations/amp
 */

import { MarkdownIntegration, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions } from './base.js';

export class AmpIntegration extends MarkdownIntegration {
  key = 'amp';
  config: IntegrationConfig | null = {
    name: 'Amp',
    folder: '.agents/',
    commands_subdir: 'commands',
    install_url: 'https://ampcode.com/manual#install',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.agents/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  };

  /** ``amp <extra> --execute <prompt> [--stream-json]`` (model dropped). */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [this.resolveExecutable()];
    this.applyExtraArgsEnvVar(args);
    args.push('--execute', prompt);
    if (opts.outputJson ?? true) args.push('--stream-json');
    return args;
  }
}
