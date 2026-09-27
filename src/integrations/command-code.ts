/**
 * @oakoliver/specify-cli - Command Code integration — skills-based agent.
 *
 * Port of `integrations/command_code/__init__.py`.
 *
 * @module integrations/command-code
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class CommandCodeIntegration extends SkillsIntegration {
  key = 'command-code';
  config: IntegrationConfig | null = {
    name: 'Command Code',
    folder: '.commandcode/',
    commands_subdir: 'skills',
    install_url: 'https://commandcode.ai/docs',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.commandcode/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;

  options(): IntegrationOption[] {
    const opts: IntegrationOption[] = [];
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills (default for Command Code)' }));
    return opts;
  }
}
