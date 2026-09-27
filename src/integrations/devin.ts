/**
 * @oakoliver/specify-cli - Devin for Terminal integration — skills-based agent.
 *
 * Port of `integrations/devin/__init__.py`.
 *
 * @module integrations/devin
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions } from './base.js';

export class DevinIntegration extends SkillsIntegration {
  key = 'devin';
  config: IntegrationConfig | null = {
    name: 'Devin for Terminal',
    folder: '.devin/',
    commands_subdir: 'skills',
    install_url: 'https://cli.devin.ai/docs',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.devin/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  CANONICAL_TO_NATIVE: Record<string, string> | null = {
    session_start: 'SessionStart',
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    stop: 'Stop',
  };
  eventsConfigFile: string | null = '.devin/hooks.v1.json';
  eventsFormat: string | null = 'json-root-nested';
  eventsContextEnvelope: Record<string, string> = {
    '*': 'suppress',
    session_start: 'hookSpecificOutput',
    user_prompt_submit: 'hookSpecificOutput',
  };

  options(): IntegrationOption[] {
    const opts = super.options();
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills (default for Devin)' }));
    return opts;
  }

  /** ``devin -p <prompt> [--model m]`` (no structured JSON flag). */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [this.resolveExecutable(), '-p', prompt];
    this.applyExtraArgsEnvVar(args);
    if (opts.model) args.push('--model', opts.model);
    return args;
  }
}
