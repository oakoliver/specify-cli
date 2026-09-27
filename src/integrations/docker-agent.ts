/**
 * @oakoliver/specify-cli - Docker Agent integration — skills-based Docker CLI agent.
 *
 * Port of `integrations/docker_agent/__init__.py`.
 *
 * @module integrations/docker-agent
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions, ValueError, shlexSplit, pyRepr } from './base.js';
import { dockerAgentCommand } from '../utils.js';

export class DockerAgentIntegration extends SkillsIntegration {
  key = 'docker-agent';
  config: IntegrationConfig | null = {
    name: 'Docker Agent',
    folder: '.agents/',
    commands_subdir: 'skills',
    install_url: 'https://docs.docker.com/ai/docker-agent/getting-started/installation/',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.agents/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = false;

  options(): IntegrationOption[] {
    const opts = super.options();
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills (default for Docker Agent)' }));
    return opts;
  }

  static readonly RUNTIME_OPTION_FLAGS: Record<string, string> = {
    agent: '--agent',
    safety: '--safety',
  };
  static readonly SAFETY_MODES = new Set(['strict', 'balanced', 'restricted', 'autonomous']);

  /** The available Docker Agent command form (``docker-agent run`` / ``docker agent run``). */
  agentCommand(): string[] {
    const executable = this.resolveExecutable();
    const command = dockerAgentCommand(executable === this.key ? null : executable);
    if (command === null || command === undefined) return [executable, 'run'];
    return command;
  }

  /** Headless Docker Agent invocation with an agent config reference. */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const runtimeArgs = [...(opts.integrationArgs ?? [])];
    const extraEnvName = 'SPECKIT_INTEGRATION_DOCKER_AGENT_EXTRA_ARGS';
    const extraArgs = (process.env[extraEnvName] ?? '').trim();
    if (runtimeArgs.length === 0 && !extraArgs) {
      throw new ValueError(
        'Docker Agent requires an agent configuration reference. ' +
          "Set per-step 'integration_args', for example " +
          "integration_args: ['./agent.yaml'], or use the legacy " +
          `${extraEnvName}=./agent.yaml environment variable.`,
      );
    }
    let legacyArgs: string[] = [];
    if (runtimeArgs.length === 0) {
      try {
        legacyArgs = shlexSplit(extraArgs);
      } catch {
        throw new ValueError(
          `${extraEnvName} is not parseable as a POSIX-quoted command line (value: ${pyRepr(extraArgs)}).`,
        );
      }
      if (legacyArgs.length === 0 || !legacyArgs[0] || legacyArgs[0].startsWith('-')) {
        throw new ValueError(
          `${extraEnvName} must start with an agent configuration reference, for example ./agent.yaml`,
        );
      }
    }
    const args = [...this.agentCommand(), '--exec'];
    args.push(...(runtimeArgs.length > 0 ? runtimeArgs : legacyArgs));
    for (const [option, value] of Object.entries(opts.integrationOptions ?? {})) {
      args.push(DockerAgentIntegration.RUNTIME_OPTION_FLAGS[option], String(value));
    }
    if (opts.outputJson ?? true) args.push('--json');
    if (opts.model) args.push('--model', opts.model);
    args.push('--', prompt);
    return args;
  }

  /** Validate Docker Agent's per-step agent reference and CLI options. */
  validateRuntimeConfig(integrationArgs?: readonly string[] | null, integrationOptions?: Record<string, unknown> | null): void {
    const runtimeArgs = [...(integrationArgs ?? [])] as unknown[];
    if (!runtimeArgs.every((v) => typeof v === 'string' && v.trim())) {
      throw new ValueError("Docker Agent 'integration_args' values must be non-empty strings.");
    }
    if (runtimeArgs.length > 1) {
      throw new ValueError(
        "Docker Agent accepts at most one per-step 'integration_args' value: the agent configuration reference.",
      );
    }
    if (runtimeArgs.length > 0 && (runtimeArgs[0] as string).startsWith('-')) {
      throw new ValueError(
        "Docker Agent 'integration_args' must start with an agent configuration reference, for example ./agent.yaml.",
      );
    }
    const options = integrationOptions ?? {};
    if ('model' in options) {
      throw new ValueError(
        "Docker Agent model selection must use the command-step 'model' field, not 'integration_options.model'.",
      );
    }
    const known = DockerAgentIntegration.RUNTIME_OPTION_FLAGS;
    const unknown = Object.keys(options).filter((k) => !(k in known)).sort();
    if (unknown.length > 0) {
      const names = unknown.map((n) => pyRepr(n)).join(', ');
      const allowed = Object.keys(known).sort().join(', ');
      throw new ValueError(`Docker Agent received unknown integration option(s): ${names}. Supported options: ${allowed}.`);
    }
    for (const [name, value] of Object.entries(options)) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new ValueError(`Docker Agent integration option ${pyRepr(name)} must be a non-empty string.`);
      }
    }
    const safety = options.safety;
    if (safety !== undefined && safety !== null && !DockerAgentIntegration.SAFETY_MODES.has(safety as string)) {
      const allowed = [...DockerAgentIntegration.SAFETY_MODES].sort().join(', ');
      throw new ValueError(`Docker Agent integration option 'safety' must be one of: ${allowed}.`);
    }
  }
}
