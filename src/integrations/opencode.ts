/**
 * @oakoliver/specify-cli - opencode integration.
 *
 * Port of `integrations/opencode/__init__.py`.
 *
 * @module integrations/opencode
 */

import { MarkdownIntegration, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions, partition } from './base.js';

export class OpencodeIntegration extends MarkdownIntegration {
  key = 'opencode';
  config: IntegrationConfig | null = {
    name: 'opencode',
    folder: '.opencode/',
    commands_subdir: 'commands',
    install_url: 'https://opencode.ai',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.opencode/commands',
    legacy_dir: '.opencode/command',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  };
  multiInstallSafe = true;
  CANONICAL_TO_NATIVE: Record<string, string> | null = {
    pre_tool_use: 'tool.execute.before',
    post_tool_use: 'tool.execute.after',
    session_start: 'experimental.chat.system.transform',
    user_prompt_submit: 'chat.message',
    session_end: 'session.deleted',
  };
  eventsConfigFile: string | null = 'opencode.json';
  eventsFormat: string | null = 'ts-plugin';

  /** ``opencode run [--command <cmd>] [-m model] [--format json] [message]``. */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [this.resolveExecutable(), 'run'];
    this.applyExtraArgsEnvVar(args);
    let message = prompt;
    if (prompt.startsWith('/')) {
      const [command, remainder] = partition(prompt.slice(1), ' ');
      if (command) {
        args.push('--command', command);
        message = remainder;
      }
    }
    if (opts.model) args.push('-m', opts.model);
    if (opts.outputJson ?? true) args.push('--format', 'json');
    if (message) args.push(message);
    return args;
  }
}
