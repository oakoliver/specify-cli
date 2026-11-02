/**
 * @oakoliver/specify-cli - ZCode integration — skills-based agent (Z.AI).
 *
 * Port of `integrations/zcode/__init__.py`.
 *
 * @module integrations/zcode
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions } from './base.js';

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

  /**
   * ``zcode -p <prompt>``. ``model`` is deliberately dropped: ZCode has no
   * per-invocation model flag (it rejects ``--model``) and switches models
   * in-session with ``/model``.
   */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args: string[] = [this.resolveExecutable(), '-p', prompt];
    this.applyExtraArgsEnvVar(args);
    if (opts.outputJson ?? true) args.push('--output-format', 'json');
    return args;
  }
}
