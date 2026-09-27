/**
 * @oakoliver/specify-cli - Kiro CLI integration.
 *
 * Port of `integrations/kiro_cli/__init__.py`.
 *
 * @module integrations/kiro-cli
 */

import { MarkdownIntegration, type IntegrationConfig, type RegistrarConfig } from './base.js';

/**
 * Kiro CLI file-based prompts do not support argument substitution, so a
 * prose fallback replaces ``$ARGUMENTS`` (issue #1926).
 */
export const KIRO_ARG_FALLBACK = '(the user will provide the argument in this conversation)';

export class KiroCliIntegration extends MarkdownIntegration {
  key = 'kiro-cli';
  config: IntegrationConfig | null = {
    name: 'Kiro CLI',
    folder: '.kiro/',
    commands_subdir: 'prompts',
    install_url: 'https://kiro.dev/docs/cli/',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.kiro/prompts',
    format: 'markdown',
    args: KIRO_ARG_FALLBACK,
    extension: '.md',
  };
  multiInstallSafe = true;
}
