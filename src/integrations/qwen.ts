/**
 * @oakoliver/specify-cli - Qwen Code integration.
 *
 * Port of `integrations/qwen/__init__.py`.
 *
 * @module integrations/qwen
 */

import { MarkdownIntegration, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class QwenIntegration extends MarkdownIntegration {
  key = 'qwen';
  config: IntegrationConfig | null = {
    name: 'Qwen Code',
    folder: '.qwen/',
    commands_subdir: 'commands',
    install_url: 'https://github.com/QwenLM/qwen-code',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.qwen/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  };
  multiInstallSafe = true;
  CANONICAL_TO_NATIVE: Record<string, string> | null = {
    session_start: 'SessionStart',
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    stop: 'Stop',
  };
  eventsConfigFile: string | null = '.qwen/settings.json';
  eventsFormat: string | null = 'json-nested';
  eventsTimeoutUnit: string | null = 'ms';
  eventsContextEnvelope: Record<string, string> = {
    '*': 'suppress',
    session_start: 'hookSpecificOutput',
    user_prompt_submit: 'hookSpecificOutput',
  };
}
