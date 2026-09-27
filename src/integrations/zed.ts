/**
 * @oakoliver/specify-cli - Zed editor integration — skills-based agent.
 *
 * Port of `integrations/zed/__init__.py`.
 *
 * @module integrations/zed
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class ZedIntegration extends SkillsIntegration {
  key = 'zed';
  config: IntegrationConfig | null = {
    name: 'Zed',
    folder: '.agents/',
    commands_subdir: 'skills',
    install_url: null,
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.agents/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };

  options(): IntegrationOption[] {
    const opts: IntegrationOption[] = [];
    return opts;
  }
}
