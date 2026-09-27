/**
 * @oakoliver/specify-cli - ZCode integration — skills-based agent (Z.AI).
 *
 * Port of `integrations/zcode/__init__.py`.
 *
 * @module integrations/zcode
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class ZcodeIntegration extends SkillsIntegration {
  key = 'zcode';
  config: IntegrationConfig | null = {
    name: 'ZCode',
    folder: '.zcode/',
    commands_subdir: 'skills',
    install_url: 'https://zcode.z.ai/',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.zcode/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;

  options(): IntegrationOption[] {
    const opts: IntegrationOption[] = [];
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills (default for ZCode)' }));
    return opts;
  }
}
