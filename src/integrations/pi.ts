/**
 * @oakoliver/specify-cli - Pi Coding Agent integration.
 *
 * Port of `integrations/pi/__init__.py`.
 *
 * @module integrations/pi
 */

import { MarkdownIntegration, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions } from './base.js';

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

  /** ``pi -p <prompt>``; Pi selects JSONL events with ``--mode json`` (it rejects ``--output-format``). */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    if (!this.config || !this.config.requires_cli) return null;
    const args: string[] = [this.resolveExecutable(), '-p', prompt];
    this.applyExtraArgsEnvVar(args);
    if (opts.model) args.push('--model', opts.model);
    if (opts.outputJson ?? true) args.push('--mode', 'json');
    return args;
  }
}
