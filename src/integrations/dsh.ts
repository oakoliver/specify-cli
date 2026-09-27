/**
 * @oakoliver/specify-cli - DeepSeek Harness (DSH) integration — skills-based agent.
 *
 * Port of `integrations/dsh/__init__.py`.
 *
 * @module integrations/dsh
 */

import { SkillsIntegration, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions } from './base.js';

export class DshIntegration extends SkillsIntegration {
  key = 'dsh';
  config: IntegrationConfig | null = {
    name: 'DeepSeek Harness',
    folder: '.dsh/',
    commands_subdir: 'skills',
    install_url: 'https://github.com/deepseek-ai/deepseek-harness',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.dsh/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;

  /** ``dsh --profile headless "<task>"`` (no JSON / model flags). */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [this.resolveExecutable(), '--profile', 'headless'];
    this.applyExtraArgsEnvVar(args);
    args.push(prompt);
    return args;
  }
}
