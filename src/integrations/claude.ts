/**
 * @oakoliver/specify-cli - Claude Code integration.
 *
 * Port of `integrations/claude/__init__.py`.
 *
 * @module integrations/claude
 */

import { SkillsIntegration, type IntegrationConfig, type RegistrarConfig, injectArgumentHint, injectFrontmatterFlag, skillStemFromContent, buildSkillFrontmatter, pyStrip } from './base.js';
import { dumpFrontmatter } from '../utils.js';

/**
 * Mapping of command template stem → argument-hint text shown inline when a
 * user invokes the slash command.
 */
export const ARGUMENT_HINTS: Record<string, string> = {
  specify: 'Describe the feature you want to specify',
  plan: 'Optional guidance for the planning phase',
  tasks: 'Optional task generation constraints',
  implement: 'Optional implementation guidance or task filter',
  analyze: 'Optional focus areas for analysis',
  clarify: 'Optional areas to clarify in the spec',
  constitution: 'Principles or values for the project constitution',
  checklist: 'Domain or focus area for the checklist',
  taskstoissues: 'Optional filter or label for GitHub issues',
};

/**
 * Per-command frontmatter overrides for skills that should run in a forked
 * subagent context. Intentionally empty (see upstream #3185).
 */
export const FORK_CONTEXT_COMMANDS: Record<string, Record<string, string>> = {};

export class ClaudeIntegration extends SkillsIntegration {
  key = 'claude';
  config: IntegrationConfig | null = {
    name: 'Claude Code',
    folder: '.claude/',
    commands_subdir: 'skills',
    install_url: 'https://docs.anthropic.com/en/docs/claude-code/setup',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.claude/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
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
  eventsConfigFile: string | null = '.claude/settings.json';
  eventsFormat: string | null = 'json-nested';

  /** Insert ``argument-hint`` after the ``description:`` scalar (no-op if present). */
  static injectArgumentHint(content: string, hint: string): string {
    return injectArgumentHint(content, hint);
  }

  /** Instance alias (marks the integration as argument-hint capable). */
  injectArgumentHint(content: string, hint: string): string {
    return injectArgumentHint(content, hint);
  }

  /** Render a processed command template as a skill (``_render_skill``). */
  renderSkill(templateName: string, frontmatter: Record<string, unknown>, body: string): string {
    const skillName = `speckit-${templateName.replace(/\./g, '-')}`;
    const description = 'description' in frontmatter ? frontmatter.description : `Spec-kit workflow command: ${templateName}`;
    const skillFm = this.buildSkillFm(skillName, description, `templates/commands/${templateName}.md`);
    const text = dumpFrontmatter(skillFm);
    return `---\n${text}\n---\n\n${pyStrip(body)}\n`;
  }

  buildSkillFm(name: string, description: unknown, source: string): Record<string, unknown> {
    return buildSkillFrontmatter(this.key, name, description, source);
  }

  static injectFrontmatterFlag(content: string, key: string, value = 'true'): string {
    return injectFrontmatterFlag(content, key, value);
  }

  static skillStemFromContent(content: string): string | null {
    return skillStemFromContent(content);
  }

  /** Inject Claude-specific frontmatter flags, hook notes, hints and fork context. */
  postProcessSkillContent(content: string): string {
    let updated = super.postProcessSkillContent(content);
    updated = injectFrontmatterFlag(updated, 'user-invocable');
    updated = injectFrontmatterFlag(updated, 'disable-model-invocation', 'false');
    const stem = skillStemFromContent(updated);
    if (stem) {
      const hint = ARGUMENT_HINTS[stem] ?? '';
      if (hint) updated = injectArgumentHint(updated, hint);
      const forkConfig = FORK_CONTEXT_COMMANDS[stem];
      if (forkConfig) {
        for (const [key, value] of Object.entries(forkConfig)) {
          updated = injectFrontmatterFlag(updated, key, value);
        }
      }
    }
    return updated;
  }
}
