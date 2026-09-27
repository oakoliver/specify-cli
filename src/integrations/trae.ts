/**
 * @oakoliver/specify-cli - Trae IDE integration. — skills-based agent.
 *
 * Port of `integrations/trae/__init__.py`.
 *
 * @module integrations/trae
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class TraeIntegration extends SkillsIntegration {
  key = 'trae';
  config: IntegrationConfig | null = {
    name: 'Trae',
    folder: '.trae/',
    commands_subdir: 'skills',
    install_url: null,
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.trae/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;

  options(): IntegrationOption[] {
    const opts: IntegrationOption[] = [];
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills (default for trae since v0.5.1)' }));
    return opts;
  }
}
