/**
 * @oakoliver/specify-cli - Goose integration — open source AI agent (Agentic AI Foundation).
 *
 * Port of `integrations/goose/__init__.py`.
 *
 * @module integrations/goose
 */

import { YamlIntegration, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions, partition } from './base.js';

function stripSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, '');
}

export class GooseIntegration extends YamlIntegration {
  key = 'goose';
  config: IntegrationConfig | null = {
    name: 'Goose',
    folder: '.goose/',
    commands_subdir: 'recipes',
    install_url: 'https://goose-docs.ai/docs/getting-started/installation',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.goose/recipes',
    format: 'yaml',
    args: '{{args}}',
    extension: '.yaml',
  };

  /**
   * ``goose run`` dispatch: ``/speckit.<name> <rest>`` maps to
   * ``--recipe .goose/recipes/speckit.<name>.yaml --params args=<rest>``;
   * anything else goes to ``-t``.
   */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [this.resolveExecutable(), 'run'];
    this.applyExtraArgsEnvVar(args);
    if (opts.model) args.push('--model', opts.model);
    if (opts.outputJson ?? true) args.push('--output-format', 'json');
    if (prompt.startsWith('/speckit.')) {
      const [command, remainder] = partition(prompt.slice(1), ' ');
      const stem = command.slice('speckit.'.length);
      if (stem) {
        const folder = stripSlashes(this.config?.folder ?? '');
        const subdir = stripSlashes(this.config?.commands_subdir ?? '');
        const parts = [folder, subdir, this.commandFilename(stem)].filter((p) => p);
        args.push('--recipe', parts.join('/'));
        if (remainder.trim()) args.push('--params', `args=${remainder}`);
        return args;
      }
    }
    args.push('-t', prompt);
    return args;
  }
}
