/**
 * @oakoliver/specify-cli - IBM Bob integration.
 *
 * Port of `integrations/bob/__init__.py`. Bob 2.0 uses the
 * `.bob/skills/speckit-<name>/SKILL.md` layout by default; the legacy
 * `.bob/commands/*.md` layout (Bob 1.x) remains available via
 * `--integration-options "--legacy-commands"`. Bob is dual-mode: the mode is
 * resolved through `isSkillsMode()`, delegating scaffolding to a helper.
 *
 * @module integrations/bob
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { CliExit, console as cliConsole } from '../console.js';
import {
  IntegrationBase,
  IntegrationOption,
  MarkdownIntegration,
  SkillsIntegration,
  warn,
  type ExecArgsOptions,
  type IntegrationConfig,
  type ParsedOptions,
  type RegistrarConfig,
  type SetupOptions,
} from './base.js';
import type { IntegrationManifest } from './manifest.js';

/** Reject ``--skills`` and ``--legacy-commands`` used together. */
function validateModeOptions(parsedOptions: ParsedOptions | null | undefined): void {
  const opts = parsedOptions ?? {};
  if (opts.skills && opts.legacy_commands) {
    cliConsole.print('[red]Error:[/red] --skills and --legacy-commands are mutually exclusive; pass only one.');
    throw new CliExit(1);
  }
}

function warnLegacyCommandsDeprecated(): void {
  warn(
    'Bob legacy commands mode (.bob/commands/) is deprecated and will be ' +
      'removed in a future Spec Kit release. Omit --legacy-commands to use ' +
      'the default skills layout (.bob/skills/).',
    'UserWarning',
  );
}

function anyEntry(dir: string, predicate: (name: string) => boolean): boolean {
  try {
    return readdirSync(dir).some(predicate);
  } catch {
    return false;
  }
}

/** Default-mode helper: ``.bob/skills/speckit-<name>/SKILL.md``. Not registered. */
export class BobSkillsHelper extends SkillsIntegration {
  key = 'bob';
  config: IntegrationConfig | null = {
    name: 'IBM Bob',
    folder: '.bob/',
    commands_subdir: 'skills',
    install_url: null,
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.bob/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };

  /** Bob skills are intent-activated; no slash-command note is needed. */
  postProcessSkillContent(content: string): string {
    return content;
  }
}

/** Legacy-mode helper: ``.bob/commands/speckit.<name>.md`` (Bob 1.x). Not registered. */
export class BobMarkdownHelper extends MarkdownIntegration {
  key = 'bob';
  invokeSeparator = '.';
  config: IntegrationConfig | null = {
    name: 'IBM Bob',
    folder: '.bob/',
    commands_subdir: 'commands',
    install_url: null,
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.bob/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
    invoke_separator: '.',
  };
}

/** Integration for IBM Bob IDE (dual-mode; skills by default). */
export class BobIntegration extends IntegrationBase {
  key = 'bob';
  invokeSeparator = '-';
  config: IntegrationConfig | null = {
    name: 'IBM Bob',
    folder: '.bob/',
    commands_subdir: 'commands',
    install_url: null,
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.bob/commands',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  };

  options(): IntegrationOption[] {
    return [
      new IntegrationOption('--skills', {
        isFlag: true,
        default: false,
        help:
          'Force the default skills layout (.bob/skills/), overriding ' +
          'on-disk auto-detection. Use this to migrate a legacy ' +
          'commands install to skills, e.g. ' +
          '`integration upgrade bob --integration-options "--skills"`',
      }),
      new IntegrationOption('--legacy-commands', {
        isFlag: true,
        default: false,
        help:
          'Scaffold commands as legacy .bob/commands/*.md files ' +
          '(Bob 1.x layout, deprecated) instead of the default ' +
          'skills layout',
      }),
    ];
  }

  /**
   * Skills-first; ``--legacy-commands`` opts out; otherwise infer from managed
   * artifacts on disk (legacy only when ``speckit.*.md`` commands exist and no
   * ``speckit-*`` skills do).
   */
  isSkillsMode(parsedOptions?: ParsedOptions | null, projectRoot?: string | null): boolean {
    const opts = parsedOptions ?? {};
    validateModeOptions(opts);
    if (opts.skills) return true;
    if (opts.legacy_commands) return false;
    if (projectRoot !== null && projectRoot !== undefined) {
      const bobDir = join(projectRoot, '.bob');
      const hasSkills = anyEntry(join(bobDir, 'skills'), (n) => n.startsWith('speckit-'));
      const hasCommands = anyEntry(
        join(bobDir, 'commands'),
        (n) => n.startsWith('speckit.') && n.endsWith('.md') && n.length >= 'speckit..md'.length,
      );
      if (hasCommands && !hasSkills) return false;
    }
    return true;
  }

  effectiveInvokeSeparator(parsedOptions?: ParsedOptions | null, projectRoot?: string | null): string {
    return this.isSkillsMode(parsedOptions, projectRoot) ? '-' : '.';
  }

  invokeSeparatorForMode(skillsEnabled: boolean): string {
    return skillsEnabled ? '-' : '.';
  }

  /** ``/speckit-<cmd>`` in skills mode, ``/speckit.<cmd>`` in legacy mode. */
  buildCommandInvocation(commandName: string, args = '', opts: { projectRoot?: string | null } = {}): string {
    if (!this.isSkillsMode(null, opts.projectRoot ?? null)) {
      return super.buildCommandInvocation(commandName, args);
    }
    let stem = commandName;
    if (stem.startsWith('speckit.')) stem = stem.slice('speckit.'.length);
    const invocation = '/speckit-' + stem.replace(/\./g, '-');
    return args ? `${invocation} ${args}` : invocation;
  }

  /** Resolve the layout from *projectRoot* (cwd when ``null``) at dispatch time. */
  buildDispatchPrompt(commandName: string, args: string, projectRoot: string | null): string {
    const root = projectRoot !== null && projectRoot !== undefined ? projectRoot : process.cwd();
    return this.buildCommandInvocation(commandName, args, { projectRoot: root });
  }

  /** ``bob run --trust --accept-license -f json|pretty <extra> <prompt>``. */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [
      this.resolveExecutable(),
      'run',
      '--trust',
      '--accept-license',
      '-f',
      (opts.outputJson ?? true) ? 'json' : 'pretty',
    ];
    this.applyExtraArgsEnvVar(args);
    args.push(prompt);
    return args;
  }

  /** No slash-command note for Bob skills (delegates to the skills helper). */
  postProcessSkillContent(content: string): string {
    return new BobSkillsHelper().postProcessSkillContent(content);
  }

  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    const parsed = parsedOptions ?? {};
    if (this.isSkillsMode(parsed, projectRoot)) {
      return new BobSkillsHelper().setup(projectRoot, manifest, parsed, opts);
    }
    warnLegacyCommandsDeprecated();
    return new BobMarkdownHelper().setup(projectRoot, manifest, parsed, opts);
  }
}
