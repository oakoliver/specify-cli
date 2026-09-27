/**
 * @oakoliver/specify-cli - Codex CLI integration — skills-based agent.
 *
 * Port of `integrations/codex/__init__.py`.
 *
 * @module integrations/codex
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions } from './base.js';

export class CodexIntegration extends SkillsIntegration {
  key = 'codex';
  config: IntegrationConfig | null = {
    name: 'Codex CLI',
    folder: '.agents/',
    commands_subdir: 'skills',
    install_url: 'https://github.com/openai/codex',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.agents/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;
  devNoSymlink = true;
  CANONICAL_TO_NATIVE: Record<string, string> | null = {
    session_start: 'SessionStart',
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    stop: 'Stop',
  };
  eventsConfigFile: string | null = '.codex/config.toml';
  eventsFormat: string | null = 'toml';

  options(): IntegrationOption[] {
    const opts = super.options();
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills (default for Codex)' }));
    return opts;
  }

  /** ``codex exec "prompt"`` non-interactive mode. */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args: string[] = [this.resolveExecutable(), 'exec', prompt];
    this.applyExtraArgsEnvVar(args);
    if (opts.model) args.push('--model', opts.model);
    if (opts.outputJson ?? true) args.push('--json');
    return args;
  }
}
