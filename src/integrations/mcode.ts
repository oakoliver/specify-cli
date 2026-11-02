/**
 * @oakoliver/specify-cli - MiniMax Code integration — skills-based agent.
 *
 * Port of `integrations/mcode/__init__.py` (spec-kit v1.2.5).
 *
 * MiniMax Code discovers project skills from
 * ``.minimax/skills/speckit-<name>/SKILL.md`` and invokes them via their
 * slash shortcut (``/speckit-<command>``).
 *
 * @module integrations/mcode
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions } from './base.js';

export class McodeIntegration extends SkillsIntegration {
  key = 'mcode';
  config: IntegrationConfig | null = {
    name: 'MiniMax Code',
    folder: '.minimax/',
    commands_subdir: 'skills',
    install_url: 'https://github.com/MiniMax-AI/minimax-code',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.minimax/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;

  options(): IntegrationOption[] {
    const opts = super.options();
    opts.push(new IntegrationOption('--skills', { isFlag: true, default: true, help: 'Install as agent skills (default for MiniMax Code)' }));
    return opts;
  }

  /**
   * ``mcode exec "<prompt>" --permission full``. Spec Kit dispatch is
   * non-interactive: a permission request cannot be answered by the caller.
   * Extra args come afterward so operators can select a stricter mode.
   */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args: string[] = [this.resolveExecutable(), 'exec', prompt, '--permission', 'full'];
    this.applyExtraArgsEnvVar(args);
    if (opts.model) args.push('--model', opts.model);
    if (opts.outputJson ?? true) args.push('--output-format', 'json');
    return args;
  }
}
