/**
 * @oakoliver/specify-cli - Copilot integration — GitHub Copilot in VS Code.
 *
 * Port of `integrations/copilot/__init__.py`. Copilot supports two layouts:
 * - Skills (default): `speckit-<name>/SKILL.md` under `.github/skills/`
 * - `--commands`: `.agent.md` files, companion `.prompt.md` files and a
 *   VS Code settings merge.
 *
 * @module integrations/copilot
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, parse as parsePath } from 'node:path';

import { CliExit, console as cliConsole } from '../console.js';
import { PresetResolver } from '../presets/resolver.js';
import {
  IntegrationBase,
  IntegrationOption,
  SkillsIntegration,
  ValueError,
  normalizeDispatchArgs,
  runSubprocess,
  scriptTypeOf,
  warn,
  type DispatchOptions,
  type DispatchResult,
  type ExecArgsOptions,
  type IntegrationConfig,
  type ParsedOptions,
  type RegistrarConfig,
  type SetupOptions,
} from './base.js';
import { IntegrationManifest, isFile, isRelativeTo, resolvePath } from './manifest.js';

const COPILOT_CORE_COMMANDS = new Set([
  'analyze',
  'checklist',
  'clarify',
  'constitution',
  'converge',
  'implement',
  'plan',
  'specify',
  'tasks',
  'taskstoissues',
]);

/** Executable name for Copilot CLI on this platform. */
export function copilotExecutable(): string {
  return process.platform === 'win32' ? 'copilot.cmd' : 'copilot';
}

/**
 * True if the Copilot CLI should run with full permissions
 * (``SPECKIT_COPILOT_ALLOW_ALL_TOOLS``; deprecated ``SPECKIT_ALLOW_ALL_TOOLS``).
 */
export function allowAll(): boolean {
  const newVar = process.env.SPECKIT_COPILOT_ALLOW_ALL_TOOLS;
  if (newVar !== undefined) return newVar !== '0';
  const oldVar = process.env.SPECKIT_ALLOW_ALL_TOOLS;
  if (oldVar !== undefined) {
    warn('SPECKIT_ALLOW_ALL_TOOLS is deprecated; use SPECKIT_COPILOT_ALLOW_ALL_TOOLS instead.', 'UserWarning');
    return oldVar !== '0';
  }
  return true;
}

function validateModeOptions(parsedOptions: ParsedOptions | null | undefined): void {
  const opts = parsedOptions ?? {};
  if (opts.skills && opts.commands) {
    cliConsole.print('[red]Error:[/red] --skills and --commands are mutually exclusive; pass only one.');
    throw new CliExit(1);
  }
}

/** Internal helper used when Copilot is scaffolded in skills mode. Not registered. */
export class CopilotSkillsHelper extends SkillsIntegration {
  key = 'copilot';
  config: IntegrationConfig | null = {
    name: 'GitHub Copilot',
    folder: '.github/',
    commands_subdir: 'skills',
    install_url: 'https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli',
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.github/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
}

/** Integration for GitHub Copilot (VS Code IDE + CLI). */
export class CopilotIntegration extends IntegrationBase {
  key = 'copilot';
  config: IntegrationConfig | null = {
    name: 'GitHub Copilot',
    folder: '.github/',
    commands_subdir: 'agents',
    install_url: 'https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-copilot-cli',
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.github/agents',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.agent.md',
  };
  invokeSeparator = '-';

  CANONICAL_TO_NATIVE: Record<string, string> | null = {
    session_start: 'sessionStart',
    pre_tool_use: 'preToolUse',
    post_tool_use: 'postToolUse',
    session_end: 'sessionEnd',
    user_prompt_submit: 'userPromptSubmitted',
    stop: 'agentStop',
  };
  eventsConfigFile: string | null = '.github/hooks/speckit.json';
  eventsFormat: string | null = 'copilot-json';
  eventsContextEnvelope: Record<string, string> = {
    session_start: 'additionalContext',
    user_prompt_submit: 'additionalContext',
  };

  /** Mutable flag set by ``setup()`` — the active scaffolding mode. */
  skillsModeActive = true;

  effectiveInvokeSeparator(parsedOptions?: ParsedOptions | null, projectRoot?: string | null): string {
    return this.isSkillsMode(parsedOptions, projectRoot) ? '-' : '.';
  }

  /**
   * Copilot defaults to skills; ``--commands`` opts into commands mode.
   * Without a flag, existing projects keep their managed layout.
   */
  isSkillsMode(parsedOptions?: ParsedOptions | null, projectRoot?: string | null): boolean {
    const opts = parsedOptions ?? {};
    validateModeOptions(opts);
    if (opts.skills) return true;
    if (opts.commands) return false;
    if (projectRoot !== null && projectRoot !== undefined) {
      const manifestPath = join(projectRoot, '.specify', 'integrations', 'copilot.manifest.json');
      if (isFile(manifestPath)) {
        let files: Record<string, string> | null;
        try {
          files = IntegrationManifest.load(this.key, projectRoot).files;
        } catch {
          files = null;
        }
        if (files !== null) {
          const paths = Object.keys(files);
          if (paths.some((p) => p.startsWith('.github/skills/speckit-') && p.endsWith('/SKILL.md'))) return true;
          if (paths.some((p) => p.startsWith('.github/agents/speckit.') && p.endsWith('.agent.md'))) return false;
        }
      }
      const githubDir = join(projectRoot, '.github');
      const hasSkills = [...COPILOT_CORE_COMMANDS].some((c) => isFile(join(githubDir, 'skills', `speckit-${c}`, 'SKILL.md')));
      const hasCommands = [...COPILOT_CORE_COMMANDS].some(
        (c) =>
          isFile(join(githubDir, 'agents', `speckit.${c}.agent.md`)) ||
          isFile(join(githubDir, 'prompts', `speckit.${c}.prompt.md`)),
      );
      if (hasCommands && !hasSkills) return false;
    }
    return true;
  }

  invokeSeparatorForMode(skillsEnabled: boolean): string {
    return skillsEnabled ? '-' : '.';
  }

  options(): IntegrationOption[] {
    const opts = super.options();
    opts.push(
      new IntegrationOption('--skills', {
        isFlag: true,
        default: false,
        help: 'Force the default skills layout (.github/skills/), overriding on-disk auto-detection',
      }),
    );
    opts.push(
      new IntegrationOption('--commands', {
        isFlag: true,
        default: false,
        help:
          'Scaffold .github/agents/*.agent.md commands with companion ' +
          '.github/prompts/*.prompt.md files instead of the default ' +
          'skills layout',
      }),
    );
    return opts;
  }

  /** ``SPECKIT_INTEGRATION_COPILOT_EXECUTABLE`` or the platform default. */
  resolveExecutable(): string {
    const override = (process.env.SPECKIT_INTEGRATION_COPILOT_EXECUTABLE ?? '').trim();
    return override ? override : copilotExecutable();
  }

  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [this.resolveExecutable(), '-p', prompt];
    this.applyExtraArgsEnvVar(args);
    if (allowAll()) args.push('--yolo');
    if (opts.model) args.push('--model', opts.model);
    if (opts.outputJson ?? true) args.push('--output-format', 'json');
    return args;
  }

  /** Skills mode: ``/speckit-<stem>``; commands mode: args as prompt. */
  buildCommandInvocation(commandName: string, args = ''): string {
    if (this.skillsModeActive) {
      let stem = commandName;
      if (stem.startsWith('speckit.')) stem = stem.slice('speckit.'.length);
      let invocation = '/speckit-' + stem.replace(/\./g, '-');
      if (args) invocation = `${invocation} ${args}`;
      return invocation;
    }
    return args || '';
  }

  /** Dispatch via ``--agent speckit.<stem>`` (commands mode) or ``/speckit-<stem>`` (skills). */
  dispatchCommand(commandName: string, argsOrOpts: string | DispatchOptions = '', maybeOpts: DispatchOptions = {}): DispatchResult {
    const [args, opts] = normalizeDispatchArgs(argsOrOpts, maybeOpts);
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const stream = opts.stream ?? true;
    let stem = commandName;
    if (stem.startsWith('speckit.')) stem = stem.slice('speckit.'.length);
    const projectRoot = opts.projectRoot ?? null;
    const skillsMode = projectRoot ? this.isSkillsMode(null, projectRoot) : this.skillsModeActive;
    let prompt: string;
    let agentName = '';
    if (skillsMode) {
      prompt = '/speckit-' + stem.replace(/\./g, '-');
      if (args) prompt = `${prompt} ${args}`;
    } else {
      agentName = `speckit.${stem}`;
      prompt = args || '';
    }
    const cliArgs = [this.resolveExecutable(), '-p', prompt];
    this.applyExtraArgsEnvVar(cliArgs);
    if (!skillsMode) cliArgs.push('--agent', agentName);
    if (allowAll()) cliArgs.push('--yolo');
    if (opts.model) cliArgs.push('--model', opts.model);
    if (!stream) cliArgs.push('--output-format', 'json');
    return runSubprocess(cliArgs, projectRoot, stream, opts.timeout ?? 600);
  }

  commandFilename(templateName: string): string {
    return `speckit.${templateName}.agent.md`;
  }

  /** Protect ``.vscode/settings.json`` from upgrade stale-deletion. */
  staleCleanupExclusions(): Set<string> {
    const exclusions = super.staleCleanupExclusions();
    exclusions.add('.vscode/settings.json');
    return exclusions;
  }

  /** Shared hook guidance (no ``mode:`` frontmatter field). */
  postProcessSkillContent(content: string): string {
    return new CopilotSkillsHelper().postProcessSkillContent(content);
  }

  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    const parsed = parsedOptions ?? {};
    this.skillsModeActive = this.isSkillsMode(parsed, projectRoot);
    const created = this.skillsModeActive
      ? this.setupSkills(projectRoot, manifest, parsed, opts)
      : this.setupCommands(projectRoot, manifest, parsed, opts);
    created.push(...this.emitEvents(projectRoot, manifest, opts.events, parsed));
    return created;
  }

  /** Commands mode: ``.agent.md`` + ``.prompt.md`` + VS Code settings merge. */
  setupCommands(projectRoot: string, manifest: IntegrationManifest, _parsedOptions: ParsedOptions | null = null, opts: SetupOptions = {}): string[] {
    const rootResolved = resolvePath(projectRoot);
    if (manifest.projectRoot !== rootResolved) {
      throw new ValueError(`manifest.project_root (${manifest.projectRoot}) does not match project_root (${rootResolved})`);
    }
    const templates = this.listCommandTemplates();
    if (templates.length === 0) return [];
    const presetResolver = new PresetResolver(rootResolved);
    const dest = this.commandsDest(projectRoot);
    this.checkedDest(projectRoot, manifest, dest);
    mkdirSync(dest, { recursive: true });
    const created: string[] = [];
    const scriptType = scriptTypeOf(opts);
    const argPlaceholder = this.registrarConfig?.args ?? '$ARGUMENTS';

    for (const src of templates) {
      const stem = parsePath(src).name;
      const resolved = presetResolver.resolve(`speckit.${stem}`, 'command') as string | null | undefined;
      const sourcePath = resolved || src;
      const raw = readFileSync(sourcePath, 'utf-8');
      const processed = this.processTemplate(raw, this.key, scriptType, argPlaceholder, undefined, projectRoot);
      created.push(this.writeFileAndRecord(processed, join(dest, this.commandFilename(stem)), projectRoot, manifest));
    }

    const promptsDir = join(projectRoot, '.github', 'prompts');
    for (const src of templates) {
      const cmdName = `speckit.${parsePath(src).name}`;
      created.push(
        this.writeFileAndRecord(`---\nagent: ${cmdName}\n---\n`, join(promptsDir, `${cmdName}.prompt.md`), projectRoot, manifest),
      );
    }

    const settingsSrc = this.vscodeSettingsPath();
    if (settingsSrc && isFile(settingsSrc)) {
      const dstSettings = join(projectRoot, '.vscode', 'settings.json');
      mkdirSync(join(projectRoot, '.vscode'), { recursive: true });
      if (existsSync(dstSettings)) {
        CopilotIntegration.mergeVscodeSettings(settingsSrc, dstSettings);
      } else {
        copyFileSync(settingsSrc, dstSettings);
        this.recordFileInManifest(dstSettings, projectRoot, manifest);
        created.push(dstSettings);
      }
    }
    return created;
  }

  /** Skills mode: delegate to {@link CopilotSkillsHelper} then post-process. */
  setupSkills(projectRoot: string, manifest: IntegrationManifest, parsedOptions: ParsedOptions | null = null, opts: SetupOptions = {}): string[] {
    const helper = new CopilotSkillsHelper();
    const created = SkillsIntegration.prototype.setup.call(helper, projectRoot, manifest, parsedOptions, opts);
    const skillsDir = resolvePath(helper.skillsDest(projectRoot));
    for (const path of created) {
      if (!isRelativeTo(resolvePath(path), skillsDir)) continue;
      if (basename(path) !== 'SKILL.md') continue;
      const content = readFileSync(path, 'utf-8');
      const updated = this.postProcessSkillContent(content);
      if (updated !== content) {
        writeFileSync(path, Buffer.from(updated, 'utf-8'));
        this.recordFileInManifest(path, projectRoot, manifest);
      }
    }
    return created;
  }

  /** Path to the bundled ``vscode-settings.json`` template. */
  vscodeSettingsPath(): string | null {
    const tplDir = this.sharedTemplatesDir();
    if (tplDir) {
      const candidate = join(tplDir, 'vscode-settings.json');
      if (isFile(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Merge settings from *src* into existing *dst* (missing top-level keys and
   * missing sub-keys of dict values only). Skips unparseable (JSONC) files.
   */
  static mergeVscodeSettings(src: string, dst: string): void {
    let existing: unknown;
    try {
      existing = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(dst)));
    } catch {
      const template = readFileSync(src, 'utf-8');
      process.stderr.write(
        `Could not parse ${dst} (may contain JSONC comments). ` +
          'Skipping settings merge to preserve existing file.\n' +
          `Please add the following settings manually:\n${template}\n`,
      );
      return;
    }
    const newSettings: unknown = JSON.parse(readFileSync(src, 'utf-8'));
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!isObj(existing) || !isObj(newSettings)) {
      process.stderr.write(`Skipping settings merge: ${dst} or template is not a JSON object.\n`);
      return;
    }
    let changed = false;
    for (const [key, value] of Object.entries(newSettings)) {
      if (!(key in existing)) {
        existing[key] = value;
        changed = true;
      } else if (isObj(existing[key]) && isObj(value)) {
        const target = existing[key] as Record<string, unknown>;
        for (const [subKey, subValue] of Object.entries(value)) {
          if (!(subKey in target)) {
            target[subKey] = subValue;
            changed = true;
          }
        }
      }
    }
    if (!changed) return;
    writeFileSync(dst, pyJsonIndent4(existing) + '\n', 'utf-8');
  }
}

/** Python ``json.dumps(obj, indent=4)`` (ensure_ascii=True). */
function pyJsonIndent4(obj: unknown): string {
  return JSON.stringify(obj, null, 4).replace(/[\u0080-\uffff]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}
