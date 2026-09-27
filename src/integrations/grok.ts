/**
 * @oakoliver/specify-cli - Grok Build integration — skills-based agent.
 *
 * Port of `integrations/grok/__init__.py`.
 *
 * @module integrations/grok
 */

import { SkillsIntegration, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions } from './base.js';

export class GrokIntegration extends SkillsIntegration {
  key = 'grok';
  config: IntegrationConfig | null = {
    name: 'Grok Build',
    folder: '.grok/',
    commands_subdir: 'skills',
    install_url: 'https://docs.x.ai/build/overview',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.grok/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;

  /** ``grok -p <prompt> --always-approve`` headless dispatch. */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    if (!this.config || !this.config.requires_cli) return null;
    const args = [this.resolveExecutable(), '-p', prompt, '--always-approve'];
    this.applyExtraArgsEnvVar(args);
    if (opts.model) args.push('--model', opts.model);
    if (opts.outputJson ?? true) args.push('--output-format', 'json');
    return args;
  }
}
