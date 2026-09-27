/**
 * @oakoliver/specify-cli - Factory Droid CLI integration — skills-based agent.
 *
 * Port of `integrations/droid/__init__.py`.
 *
 * @module integrations/droid
 */

import { SkillsIntegration, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions, splitlines } from './base.js';

export class DroidIntegration extends SkillsIntegration {
  key = 'droid';
  config: IntegrationConfig | null = {
    name: 'Factory Droid',
    folder: '.factory/',
    commands_subdir: 'skills',
    install_url: 'https://docs.factory.ai/cli/getting-started/overview',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.factory/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;

  /**
   * Insert ``key: value`` before the closing ``---`` if not already present
   * (always emits ``\n`` after the injected key).
   */
  static injectFrontmatterFlag(content: string, key: string, value = 'true'): string {
    const lines = splitlines(content, true);
    let dashCount = 0;
    for (const line of lines) {
      const stripped = line.replace(/[\n\r]+$/, '');
      if (stripped === '---') {
        dashCount += 1;
        if (dashCount === 2) break;
        continue;
      }
      if (dashCount === 1 && stripped.startsWith(`${key}:`)) return content;
    }
    const out: string[] = [];
    dashCount = 0;
    let injected = false;
    for (const line of lines) {
      const stripped = line.replace(/[\n\r]+$/, '');
      if (stripped === '---') {
        dashCount += 1;
        if (dashCount === 2 && !injected) {
          out.push(`${key}: ${value}\n`);
          injected = true;
        }
      }
      out.push(line);
    }
    return out.join('');
  }

  /** Hook note + ``user-invocable`` / ``disable-model-invocation`` flags. */
  postProcessSkillContent(content: string): string {
    let updated = super.postProcessSkillContent(content);
    updated = DroidIntegration.injectFrontmatterFlag(updated, 'user-invocable');
    updated = DroidIntegration.injectFrontmatterFlag(updated, 'disable-model-invocation', 'false');
    return updated;
  }

  /** ``droid exec "<prompt>" [--model m] [--output-format json] <extra args>``. */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    if (!this.config || !this.config.requires_cli) return null;
    const args = [this.resolveExecutable(), 'exec', prompt];
    if (opts.model) args.push('--model', opts.model);
    if (opts.outputJson ?? true) args.push('--output-format', 'json');
    this.applyExtraArgsEnvVar(args);
    return args;
  }
}
