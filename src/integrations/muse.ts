/**
 * @oakoliver/specify-cli - Muse Code integration — skills-based agent (Meta).
 *
 * Port of `integrations/muse/__init__.py`.
 *
 * @module integrations/muse
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions } from './base.js';

export class MuseIntegration extends SkillsIntegration {
  key = 'muse';
  config: IntegrationConfig | null = {
    name: 'Muse Code',
    folder: '.agents/',
    commands_subdir: 'skills',
    install_url: 'https://dev.meta.ai/docs/muse-code',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.agents/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = false;

  options(): IntegrationOption[] {
    const opts: IntegrationOption[] = [];
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills (default for Muse Code)' }));
    return opts;
  }

  /** ``muse exec "<prompt>"`` non-interactive mode. */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args: string[] = [this.resolveExecutable(), 'exec', prompt];
    this.applyExtraArgsEnvVar(args);
    if (opts.model) args.push('--model', opts.model);
    if (opts.outputJson ?? true) args.push('--json');
    return args;
  }
}
