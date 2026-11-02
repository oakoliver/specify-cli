/**
 * @oakoliver/specify-cli - Generic integration — bring your own agent.
 *
 * Port of `integrations/generic/__init__.py`. Requires `--commands-dir` to
 * specify the output directory for command files. `--skills` renders the
 * same templates as `speckit-<name>/SKILL.md` directories under that same
 * directory instead of flat `speckit.<name>.md` files.
 *
 * @module integrations/generic
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, parse as parsePath } from 'node:path';

import { INTEGRATION_STATE_SCHEMA, integrationSetting, tryReadIntegrationJson } from '../integration-state.js';

import {
  IntegrationOption,
  MarkdownIntegration,
  SkillsIntegration,
  ValueError,
  parseTemplateFrontmatter,
  pyTruthy,
  renderSkillFrontmatterBlock,
  replaceAllLiteral,
  scriptTypeOf,
  shlexSplit,
  stripTemplateFrontmatter,
  type IntegrationConfig,
  type ParsedOptions,
  type RegistrarConfig,
  type SetupOptions,
} from './base.js';
import { isRelativeTo, resolvePath, type IntegrationManifest } from './manifest.js';

/**
 * Resolve the installed generic output root (never the class-level
 * placeholder) from ``.specify/integration.json`` (``registration_directory``).
 */
export function registrationDirectory(projectRoot: string): string {
  const [state, error] = tryReadIntegrationJson(projectRoot);
  if (error !== null && error !== undefined) {
    const detail =
      error.kind === 'schema_too_new'
        ? `integration state schema ${error.schema} is newer than supported schema ${INTEGRATION_STATE_SCHEMA}; upgrade Spec Kit`
        : error.detail;
    throw new ValueError(`Cannot read generic integration settings: ${detail}`);
  }
  const settings = integrationSetting(state ?? {}, 'generic') as Record<string, unknown>;
  const commandsDir = GenericIntegration.resolveCommandsDir(settings.parsed_options as ParsedOptions | null, {
    rawOptions: (settings.raw_options as string | null | undefined) ?? null,
  });
  if (typeof commandsDir !== 'string') throw new ValueError('Invalid --commands-dir in generic integration settings');
  const root = resolvePath(projectRoot);
  const destination = resolvePath(isAbsolute(commandsDir) ? commandsDir : join(projectRoot, commandsDir));
  if (!isRelativeTo(destination, root)) {
    throw new ValueError(`Generic command directory ${destination} escapes project root ${root}`);
  }
  return destination;
}

/**
 * Internal helper supplying skills-mode post-processing for
 * {@link GenericIntegration}. Not registered.
 */
class GenericSkillsHelper extends SkillsIntegration {
  key = 'generic';
}

export class GenericIntegration extends MarkdownIntegration {
  key = 'generic';
  config: IntegrationConfig | null = {
    name: 'Generic (bring your own agent)',
    folder: null,
    commands_subdir: 'commands',
    install_url: null,
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  };

  /** Skills-mode post-processing (hook invocation note) for extension skills. */
  postProcessSkillContent(content: string): string {
    return new GenericSkillsHelper().postProcessSkillContent(content);
  }

  /** ``"-"`` for the ``--skills`` layout, ``"."`` for flat commands. */
  effectiveInvokeSeparator(parsedOptions?: ParsedOptions | null, projectRoot?: string | null): string {
    return this.isSkillsMode(parsedOptions, projectRoot) ? '-' : '.';
  }

  options(): IntegrationOption[] {
    return [
      new IntegrationOption('--commands-dir', {
        required: true,
        help: 'Directory for command files (e.g. .myagent/commands/)',
      }),
      new IntegrationOption('--skills', {
        isFlag: true,
        default: false,
        help:
          'Render commands as speckit-<name>/SKILL.md directories ' +
          'under --commands-dir instead of flat speckit.<name>.md ' +
          'files',
      }),
    ];
  }

  /** Extract ``--commands-dir`` from parsed options or raw options; throws when missing. */
  static resolveCommandsDir(parsedOptions: ParsedOptions | null | undefined, opts: SetupOptions): string {
    const parsed = parsedOptions ?? {};
    const commandsDir = parsed.commands_dir;
    if (pyTruthy(commandsDir) && (typeof commandsDir !== 'string' || commandsDir.trim())) {
      return commandsDir as string;
    }
    const raw = opts.rawOptions ?? opts.raw_options;
    if (raw) {
      const tokens = shlexSplit(raw);
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '--commands-dir' && i + 1 < tokens.length) {
          const candidate = tokens[i + 1];
          if (candidate.trim()) return candidate;
        }
        if (token.startsWith('--commands-dir=')) {
          const candidate = token.split('=').slice(1).join('=');
          if (candidate.trim()) return candidate;
        }
      }
    }
    throw new ValueError('--commands-dir is required for the generic integration');
  }

  /** Render *src* as a SKILL.md → ``[skillName, content]``. */
  buildSkillContent(src: string, scriptType: string, projectRoot: string): [string, string] {
    const raw = readFileSync(src, 'utf-8');
    const commandName = parsePath(src).name;
    const skillName = `speckit-${replaceAllLiteral(commandName, '.', '-')}`;
    const frontmatter = parseTemplateFrontmatter(raw);
    let body = this.processTemplate(raw, this.key, scriptType, '$ARGUMENTS', '-', projectRoot);
    body = stripTemplateFrontmatter(body);
    const description = pyTruthy(frontmatter.description) ? frontmatter.description : `Spec Kit: ${commandName} workflow`;
    let content = renderSkillFrontmatterBlock(skillName, description, parsePath(src).base) + body;
    content = new GenericSkillsHelper().postProcessSkillContent(content);
    return [skillName, content];
  }

  /** Not supported — the output directory is resolved from options in ``setup()``. */
  commandsDest(_projectRoot: string): string {
    throw new ValueError(
      'GenericIntegration.commands_dest() cannot be called directly; ' +
        'the output directory is resolved from parsed_options in setup()',
    );
  }

  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    const commandsDir = GenericIntegration.resolveCommandsDir(parsedOptions, opts);
    const templates = this.listCommandTemplates();
    if (templates.length === 0) return [];
    const dest = this.checkedDest(projectRoot, manifest, isAbsolute(commandsDir) ? commandsDir : join(projectRoot, commandsDir));
    mkdirSync(dest, { recursive: true });
    const scriptType = scriptTypeOf(opts);
    const skillsEnabled = Boolean((parsedOptions ?? {}).skills);
    const created: string[] = [];
    for (const src of templates) {
      if (skillsEnabled) {
        const [skillName, skillContent] = this.buildSkillContent(src, scriptType, projectRoot);
        created.push(this.writeFileAndRecord(skillContent, join(dest, skillName, 'SKILL.md'), projectRoot, manifest));
        continue;
      }
      const raw = readFileSync(src, 'utf-8');
      const processed = this.processTemplate(raw, this.key, scriptType, '$ARGUMENTS', undefined, projectRoot);
      created.push(this.writeFileAndRecord(processed, join(dest, this.commandFilename(parsePath(src).name)), projectRoot, manifest));
    }
    return created;
  }
}
