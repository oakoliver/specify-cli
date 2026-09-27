/**
 * @oakoliver/specify-cli - Qoder CLI integration.
 *
 * Port of `integrations/qodercli/__init__.py`.
 *
 * @module integrations/qodercli
 */

import { SkillsIntegration, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class QodercliIntegration extends SkillsIntegration {
  key = 'qodercli';
  config: IntegrationConfig | null = {
    name: 'Qoder CLI',
    folder: '.qoder/',
    commands_subdir: 'skills',
    install_url: 'https://qoder.com/cli',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.qoder/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;
  legacyFlatCommandDir: string | null = '.qoder/commands';
  legacyFlatCommandExtension: string | null = '.md';
}
