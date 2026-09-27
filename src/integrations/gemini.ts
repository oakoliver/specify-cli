/**
 * @oakoliver/specify-cli - Gemini CLI integration.
 *
 * Port of `integrations/gemini/__init__.py`.
 *
 * @module integrations/gemini
 */

import { TomlIntegration, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class GeminiIntegration extends TomlIntegration {
  key = 'gemini';
  config: IntegrationConfig | null = {
    name: 'Gemini CLI',
    folder: '.gemini/',
    commands_subdir: 'commands',
    install_url: 'https://github.com/google-gemini/gemini-cli',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.gemini/commands',
    format: 'toml',
    args: '{{args}}',
    extension: '.toml',
  };
  multiInstallSafe = true;
  CANONICAL_TO_NATIVE: Record<string, string> | null = {
    session_start: 'SessionStart',
    pre_tool_use: 'BeforeTool',
    post_tool_use: 'AfterTool',
    session_end: 'SessionEnd',
    user_prompt_submit: 'BeforeAgent',
    stop: 'AfterAgent',
  };
  eventsConfigFile: string | null = '.gemini/settings.json';
  eventsFormat: string | null = 'json-nested';
  eventsTimeoutUnit: string | null = 'ms';
  eventsContextEnvelope: Record<string, string> = {
    '*': 'suppress',
    session_start: 'hookSpecificOutput',
    user_prompt_submit: 'hookSpecificOutput',
  };
}
