/**
 * @oakoliver/specify-cli - RovoDev integration — Atlassian Rovo Dev via ``acli rovodev``.
 *
 * Port of `integrations/rovodev/__init__.py`.
 *
 * @module integrations/rovodev
 */

import { SkillsIntegration, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions, type ParsedOptions, type SetupOptions } from './base.js';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { dumpYaml, parseYaml } from '../yaml.js';
import type { IntegrationManifest } from './manifest.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

export class RovodevIntegration extends SkillsIntegration {
  key = 'rovodev';
  config: IntegrationConfig | null = {
    name: 'RovoDev ACLI',
    folder: '.rovodev/',
    commands_subdir: 'skills',
    install_url: 'https://www.atlassian.com/software/rovo-dev',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.rovodev/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };

  /** ``acli`` (``rovodev`` is a subcommand); honours the executable override. */
  resolveExecutable(): string {
    const override = (process.env[`${this.envPrefix()}EXECUTABLE`] ?? '').trim();
    return override ? override : 'acli';
  }

  /** ``acli rovodev run <prompt> [--output-schema ...]`` (model not applied). */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [this.resolveExecutable(), 'rovodev', 'run', prompt];
    this.applyExtraArgsEnvVar(args);
    if (opts.outputJson ?? true) {
      args.push('--output-schema', '{"type": "object", "properties": {"result": {"type": "string"}}}');
    }
    return args;
  }

  static renderPromptWrapper(skillName: string): string {
    return `use skill ${skillName} $ARGUMENTS\n`;
  }

  /** Create thin prompt wrappers for each SKILL.md → ``[createdFiles, promptEntries]``. */
  generatePromptFiles(projectRoot: string, manifest: IntegrationManifest, skillPaths: string[]): [string[], Array<Record<string, string>>] {
    const promptsDir = join(projectRoot, '.rovodev', 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    const created: string[] = [];
    const entries: Array<Record<string, string>> = [];
    for (const skillPath of skillPaths) {
      if (basename(skillPath) !== 'SKILL.md') continue;
      const skillName = basename(dirname(skillPath));
      if (!skillName) continue;
      const promptFilename = `${skillName}.prompt.md`;
      created.push(
        this.writeFileAndRecord(RovodevIntegration.renderPromptWrapper(skillName), join(promptsDir, promptFilename), projectRoot, manifest),
      );
      entries.push({
        name: skillName,
        description: `Invoke ${skillName} skill`,
        content_file: `prompts/${promptFilename}`,
      });
    }
    return [created, entries];
  }

  /** Read prompt entries from an existing ``prompts.yml`` (``[]`` when unusable). */
  static readPromptsYml(path: string): Array<Record<string, unknown>> {
    if (!existsSync(path)) return [];
    let data: unknown;
    try {
      data = parseYaml(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
    } catch {
      return [];
    }
    if (!isPlainObject(data)) return [];
    const prompts = data.prompts;
    if (!Array.isArray(prompts)) return [];
    return prompts.filter((item) => isPlainObject(item)).map((item) => ({ ...(item as Record<string, unknown>) }));
  }

  /** Merge generated entries into existing ones, preserving user additions/order. */
  static mergePromptEntries(existing: Array<Record<string, unknown>>, generated: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const generatedByName = new Map<string, Record<string, unknown>>();
    for (const e of generated) {
      if (e.name) generatedByName.set(e.name as string, e);
    }
    const merged: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const entry of existing) {
      const name = 'name' in entry ? entry.name : '';
      if (typeof name !== 'string') {
        merged.push(entry);
        continue;
      }
      if (generatedByName.has(name)) {
        merged.push(generatedByName.get(name)!);
        seen.add(name);
      } else {
        merged.push(entry);
      }
    }
    for (const entry of generated) {
      if (!seen.has(String(entry.name ?? ''))) merged.push(entry);
    }
    return merged;
  }

  /** Write ``prompts.yml``, merging with any existing user entries. */
  mergePromptsManifest(projectRoot: string, manifest: IntegrationManifest, entries: Array<Record<string, string>>): string | null {
    if (entries.length === 0) return null;
    const promptsYml = join(projectRoot, '.rovodev', 'prompts.yml');
    const existing = RovodevIntegration.readPromptsYml(promptsYml);
    const merged = RovodevIntegration.mergePromptEntries(existing, entries);
    const content = dumpYaml({ prompts: merged }, { defaultFlowStyle: false, sortKeys: false, allowUnicode: true, width: 10000 });
    return this.writeFileAndRecord(content, promptsYml, projectRoot, manifest);
  }

  /** Install skills, then prompt wrappers and ``prompts.yml``. */
  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    const created = super.setup(projectRoot, manifest, parsedOptions, opts);
    const [promptFiles, entries] = this.generatePromptFiles(projectRoot, manifest, created);
    created.push(...promptFiles);
    const manifestFile = this.mergePromptsManifest(projectRoot, manifest, entries);
    if (manifestFile) created.push(manifestFile);
    return created;
  }
}
