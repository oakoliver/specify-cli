/**
 * @oakoliver/specify-cli - Antigravity (agy) integration — skills-based agent.
 *
 * Port of `integrations/agy/__init__.py`.
 *
 * @module integrations/agy
 */

import { SkillsIntegration, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions, type ParsedOptions, type SetupOptions, secho } from './base.js';
import { IntegrationManifest, resolvePath } from './manifest.js';

/**
 * True if agy should run with auto-approved permissions in headless mode
 * (``SPECKIT_INTEGRATION_AGY_ALLOW_ALL_TOOLS`` / ``SPECKIT_AGY_ALLOW_ALL_TOOLS``).
 */
export function allowAllTools(): boolean {
  for (const key of ['SPECKIT_INTEGRATION_AGY_ALLOW_ALL_TOOLS', 'SPECKIT_AGY_ALLOW_ALL_TOOLS']) {
    const val = process.env[key];
    if (val !== undefined && val.trim()) {
      return ['1', 'true', 'yes', 'on'].includes(val.trim().toLowerCase());
    }
  }
  return false;
}

export class AgyIntegration extends SkillsIntegration {
  key = 'agy';
  config: IntegrationConfig | null = {
    name: 'Antigravity',
    folder: '.agents/',
    commands_subdir: 'skills',
    install_url: 'https://antigravity.google/',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.agents/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };

  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [this.resolveExecutable()];
    if (allowAllTools()) args.push('--dangerously-skip-permissions');
    if (opts.model) args.push('--model', opts.model);
    if (opts.outputJson ?? true) args.push('--output-format', 'json');
    const root = opts.projectRoot;
    if (root !== null && root !== undefined && String(root).trim()) {
      args.push('--add-dir', resolvePath(String(root)));
    }
    this.applyExtraArgsEnvVar(args);
    args.push('--print', prompt);
    return args;
  }

  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    secho(
      'Warning: The .agents/ layout requires Antigravity CLI v1.0.0 or newer ' +
        '(or Antigravity IDE v2.0.0 or newer). ' +
        'Please ensure your installation is up to date.',
      'yellow',
    );
    return super.setup(projectRoot, manifest, parsedOptions, opts);
  }
}
