/**
 * @oakoliver/specify-cli - Lingma IDE integration. — skills-based agent.
 *
 * Port of `integrations/lingma/__init__.py`.
 *
 * @module integrations/lingma
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class LingmaIntegration extends SkillsIntegration {
  key = 'lingma';
  config: IntegrationConfig | null = {
    name: 'Lingma',
    folder: '.lingma/',
    commands_subdir: 'skills',
    install_url: null,
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.lingma/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;

  options(): IntegrationOption[] {
    const opts: IntegrationOption[] = [];
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills' }));
    return opts;
  }
}
