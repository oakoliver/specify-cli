/**
 * @oakoliver/specify-cli - Hermes Agent integration — skills-based agent.
 *
 * Port of `integrations/hermes/__init__.py`.
 *
 * @module integrations/hermes
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig, type ExecArgsOptions, type ParsedOptions, type SetupOptions, partition, scriptTypeOf, ValueError } from './base.js';
import { mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homeDir, isDir, resolvePath, type IntegrationManifest } from './manifest.js';

export class HermesIntegration extends SkillsIntegration {
  key = 'hermes';
  config: IntegrationConfig | null = {
    name: 'Hermes Agent',
    folder: '.hermes/',
    commands_subdir: 'skills',
    install_url: 'https://github.com/NousResearch/hermes-agent',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '~/.hermes/skills',
    detect_dir: '.hermes/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };

  options(): IntegrationOption[] {
    const opts: IntegrationOption[] = [];
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills (default for Hermes Agent)' }));
    return opts;
  }

  /** ``~/.hermes/skills/`` — the global skills directory. */
  static hermesHomeSkillsDir(): string {
    return join(homeDir(), '.hermes', 'skills');
  }

  /**
   * Install command templates as global Hermes skills under
   * ``~/.hermes/skills/speckit-<name>/SKILL.md`` and create the project-local
   * ``.hermes/skills/`` marker directory.
   */
  setup(projectRoot: string, manifest: IntegrationManifest, _parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    const templates = this.listCommandTemplates();
    if (templates.length === 0) return [];
    const rootResolved = resolvePath(projectRoot);
    if (manifest.projectRoot !== rootResolved) {
      throw new ValueError(`manifest.project_root (${manifest.projectRoot}) does not match project_root (${rootResolved})`);
    }
    const scriptType = scriptTypeOf(opts);
    const argPlaceholder = this.registrarConfig?.args ?? '$ARGUMENTS';
    const globalSkillsDir = HermesIntegration.hermesHomeSkillsDir();
    mkdirSync(globalSkillsDir, { recursive: true });
    const created: string[] = [];
    for (const src of templates) {
      const [skillName, rawContent] = this.buildSkillFile(src, scriptType, argPlaceholder, projectRoot);
      const skillContent = this.postProcessSkillContent(rawContent);
      const skillDir = join(globalSkillsDir, skillName);
      mkdirSync(skillDir, { recursive: true });
      const skillFile = join(skillDir, 'SKILL.md');
      writeFileSync(skillFile, Buffer.from(skillContent.split('\r\n').join('\n'), 'utf-8'));
      created.push(skillFile);
    }
    mkdirSync(join(projectRoot, '.hermes', 'skills'), { recursive: true });
    return created;
  }

  /** Uninstall tracked files, the empty marker dir and all global ``speckit-*`` skills. */
  teardown(projectRoot: string, manifest: IntegrationManifest, opts: { force?: boolean } = {}): [string[], string[]] {
    const [removed, skipped] = manifest.uninstall(projectRoot, { force: opts.force ?? false });
    const localSkillsDir = join(projectRoot, '.hermes', 'skills');
    if (isDir(localSkillsDir) && readdirSync(localSkillsDir).length === 0) {
      rmdirSync(localSkillsDir);
      const hermesDir = join(projectRoot, '.hermes');
      if (isDir(hermesDir) && readdirSync(hermesDir).length === 0) rmdirSync(hermesDir);
    }
    const globalSkillsDir = HermesIntegration.hermesHomeSkillsDir();
    if (isDir(globalSkillsDir)) {
      for (const name of readdirSync(globalSkillsDir).sort()) {
        const skillDir = join(globalSkillsDir, name);
        if (isDir(skillDir) && name.startsWith('speckit-')) {
          try {
            rmSync(skillDir, { recursive: true });
            removed.push(skillDir);
          } catch {
            skipped.push(skillDir);
          }
        }
      }
    }
    return [removed, skipped];
  }

  /** ``hermes chat -Q [-m model] [--json] (-s <skill> [-q rest] | -q prompt)``. */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [this.resolveExecutable(), 'chat', '-Q'];
    this.applyExtraArgsEnvVar(args);
    if (opts.model) args.push('-m', opts.model);
    if (opts.outputJson ?? true) args.push('--json');
    if (prompt.startsWith('/')) {
      const [command, remainder] = partition(prompt.slice(1), ' ');
      if (command) {
        args.push('-s', command);
        if (remainder) args.push('-q', remainder);
      } else {
        args.push('-q', prompt);
      }
    } else {
      args.push('-q', prompt);
    }
    return args;
  }
}
