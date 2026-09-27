/**
 * @oakoliver/specify-cli - Tabnine CLI integration.
 *
 * Port of `integrations/tabnine/__init__.py`.
 *
 * @module integrations/tabnine
 */

import { TomlIntegration, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class TabnineIntegration extends TomlIntegration {
  key = 'tabnine';
  config: IntegrationConfig | null = {
    name: 'Tabnine CLI',
    folder: '.tabnine/agent/',
    commands_subdir: 'commands',
    install_url: 'https://docs.tabnine.com/main/getting-started/tabnine-cli',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.tabnine/agent/commands',
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
  eventsConfigFile: string | null = '.tabnine/agent/settings.json';
  eventsFormat: string | null = 'json-nested';
  eventsTimeoutUnit: string | null = 'ms';
  eventsContextEnvelope: Record<string, string> = {
    '*': 'suppress',
    session_start: 'hookSpecificOutput',
    user_prompt_submit: 'hookSpecificOutput',
  };
}
