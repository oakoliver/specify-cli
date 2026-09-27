/**
 * @oakoliver/specify-cli - Mistral Vibe CLI integration — skills-based agent.
 *
 * Port of `integrations/vibe/__init__.py`.
 *
 * @module integrations/vibe
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig, injectFrontmatterFlag, skillStemFromContent, buildSkillFrontmatter, pyStrip, secho, type ParsedOptions, type SetupOptions } from './base.js';
import { dumpFrontmatter } from '../utils.js';
import type { IntegrationManifest } from './manifest.js';

/**
 * Per-command frontmatter overrides for skills that should run in a forked
 * subagent context. Intentionally empty (see upstream #3185).
 */
export const FORK_CONTEXT_COMMANDS: Record<string, Record<string, string>> = {};

export class VibeIntegration extends SkillsIntegration {
  key = 'vibe';
  config: IntegrationConfig | null = {
    name: 'Mistral Vibe',
    folder: '.vibe/',
    commands_subdir: 'skills',
    install_url: 'https://github.com/mistralai/mistral-vibe',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.vibe/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;
  CANONICAL_TO_NATIVE: Record<string, string> | null = {
    pre_tool_use: 'pre_tool',
    post_tool_use: 'post_tool',
    stop: 'post_agent',
  };
  eventsConfigFile: string | null = '.vibe/hooks.toml';
  eventsFormat: string | null = 'toml-vibe';
  eventsContextEnvelope: Record<string, string> = {
    '*': 'hook_specific_output',
  };

  options(): IntegrationOption[] {
    const opts = super.options();
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills' }));
    return opts;
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

  /** Inject Vibe-specific frontmatter flags. */
  postProcessSkillContent(content: string): string {
    let updated = super.postProcessSkillContent(content);
    updated = injectFrontmatterFlag(updated, 'user-invocable');
    updated = injectFrontmatterFlag(updated, 'disable-model-invocation', 'false');
    const stem = skillStemFromContent(updated);
    if (stem) {
      const forkConfig = FORK_CONTEXT_COMMANDS[stem];
      if (forkConfig) {
        for (const [key, value] of Object.entries(forkConfig)) {
          updated = injectFrontmatterFlag(updated, key, value);
        }
      }
    }
    return updated;
  }

  /** Install Vibe skills (warns about the v2.0.0 layout requirement). */
  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    secho(
      'Warning: The .vibe/skills layout requires Mistral Vibe v2.0.0 or newer. ' +
        'Please ensure your installation is up to date.',
      'yellow',
    );
    return super.setup(projectRoot, manifest, parsedOptions, opts);
  }
}
