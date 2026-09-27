/**
 * @oakoliver/specify-cli - Cursor IDE integration.
 *
 * Port of `integrations/cursor_agent/__init__.py`.
 *
 * @module integrations/cursor-agent
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions } from './base.js';

export class CursorAgentIntegration extends SkillsIntegration {
  key = 'cursor-agent';
  config: IntegrationConfig | null = {
    name: 'Cursor',
    folder: '.cursor/',
    commands_subdir: 'skills',
    install_url: 'https://docs.cursor.com/en/cli/overview',
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.cursor/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;
  CANONICAL_TO_NATIVE: Record<string, string> | null = {
    session_start: 'sessionStart',
    pre_tool_use: 'preToolUse',
    post_tool_use: 'postToolUse',
    session_end: 'sessionEnd',
    user_prompt_submit: 'beforeSubmitPrompt',
    stop: 'stop',
  };
  eventsConfigFile: string | null = '.cursor/hooks.json';
  eventsFormat: string | null = 'json-flat';
  eventsContextEnvelope: Record<string, string> = {
    '*': 'suppress',
    session_start: 'additional_context',
  };

  options(): IntegrationOption[] {
    const opts = super.options();
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills (recommended for Cursor)' }));
    return opts;
  }

  /**
   * ``cursor-agent -p --trust --approve-mcps --force <prompt>`` (always
   * returns argv; dispatch is opt-in even though ``requires_cli`` is false).
   */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [this.resolveExecutable(), '-p', '--trust', '--approve-mcps', '--force', prompt];
    this.applyExtraArgsEnvVar(args);
    if (opts.model) args.push('--model', opts.model);
    if (opts.outputJson ?? true) args.push('--output-format', 'json');
    return args;
  }
}
