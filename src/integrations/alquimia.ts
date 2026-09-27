/**
 * @oakoliver/specify-cli - Alquimia AI integration.
 *
 * Port of `integrations/alquimia/__init__.py`.
 *
 * @module integrations/alquimia
 */

import { SkillsIntegration, type IntegrationConfig, type RegistrarConfig, injectArgumentHint, injectFrontmatterFlag, buildSkillFrontmatter, pyStrip, splitlines } from './base.js';
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

export class AlquimiaAIIntegration extends SkillsIntegration {
  key = 'alquimia';
  config: IntegrationConfig | null = {
    name: 'Alquimia AI',
    folder: '.alquimia/',
    commands_subdir: 'skills',
    install_url: 'https://docs.alquimia.ai',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.alquimia/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;

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

  /** Inject Alquimia-specific frontmatter flags, hints and hook notes. */
  postProcessSkillContent(content: string): string {
    let updated = super.postProcessSkillContent(content);
    updated = injectFrontmatterFlag(updated, 'user-invocable');
    updated = injectFrontmatterFlag(updated, 'disable-model-invocation', 'false');
    for (const line of splitlines(updated)) {
      if (line.startsWith('name:')) {
        const name = pyStrip(line.slice('name:'.length)).replace(/^["']+|["']+$/g, '');
        const stem = name.startsWith('speckit-') ? name.slice('speckit-'.length) : name;
        const hint = ARGUMENT_HINTS[stem];
        if (hint) updated = injectArgumentHint(updated, hint);
        break;
      }
    }
    return updated;
  }
}
