/**
 * @oakoliver/specify-cli - Oh My Pi (omp) coding agent integration.
 *
 * Port of `integrations/omp/__init__.py`.
 *
 * @module integrations/omp
 */

import { MarkdownIntegration, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions } from './base.js';

export class OmpIntegration extends MarkdownIntegration {
  key = 'omp';
  config: IntegrationConfig | null = {
    name: 'Oh My Pi',
    folder: '.omp/',
    commands_subdir: 'commands',
    install_url: 'https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.omp/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  };
  multiInstallSafe = true;

  /** ``omp --print [--model m] [--mode json] <prompt>`` (prompt positional). */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    if (!this.config || !this.config.requires_cli) return null;
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [this.resolveExecutable(), '--print'];
    this.applyExtraArgsEnvVar(args);
    if (opts.model) args.push('--model', opts.model);
    if (opts.outputJson ?? true) args.push('--mode', 'json');
    args.push(prompt);
    return args;
  }
}
