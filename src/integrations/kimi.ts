/**
 * @oakoliver/specify-cli - Kimi Code integration — skills-based agent (Moonshot AI).
 *
 * Port of `integrations/kimi/__init__.py`.
 *
 * @module integrations/kimi
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig, type ParsedOptions, type SetupOptions, ValueError, splitlines, pyRstrip } from './base.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, cpSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseYaml } from '../yaml.js';
import { isDir, isFile, isRelativeTo, isSymlink, pathParts, resolvePath, type IntegrationManifest } from './manifest.js';

export class KimiIntegration extends SkillsIntegration {
  key = 'kimi';
  config: IntegrationConfig | null = {
    name: 'Kimi Code',
    folder: '.kimi-code/',
    commands_subdir: 'skills',
    install_url: 'https://code.kimi.com/',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.kimi-code/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = false;

  options(): IntegrationOption[] {
    const opts: IntegrationOption[] = [];
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills (default for Kimi)' }));
    opts.push(new IntegrationOption('--migrate-legacy', { isFlag: true, required: false, default: false, help: 'Migrate legacy Kimi installations: .kimi/skills/ → .kimi-code/skills/ and speckit.xxx → speckit-xxx' }));
    return opts;
  }

  /** Kimi's native skill invocation: ``/skill:speckit-<stem>``. */
  buildCommandInvocation(commandName: string, args = ''): string {
    let stem = commandName;
    if (stem.startsWith('speckit.')) stem = stem.slice('speckit.'.length);
    let invocation = '/skill:speckit-' + stem.replace(/\./g, '-');
    if (args) invocation = `${invocation} ${args}`;
    return invocation;
  }

  /** Install skills with optional legacy migration (``--migrate-legacy``). */
  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    const parsed = parsedOptions ?? {};
    const newSkillsDir = this.skillsDest(projectRoot);
    if (hasSymlinkedComponent(newSkillsDir, projectRoot)) {
      throw new ValueError(
        `Skills destination ${newSkillsDir} contains a symlinked path component; refusing to install into it.`,
      );
    }
    const created = super.setup(projectRoot, manifest, parsed, opts);
    if (parsed.migrate_legacy) {
      const oldSkillsDir = join(projectRoot, '.kimi', 'skills');
      if (isSafeLegacyDir(oldSkillsDir, projectRoot) && isSafeLegacyDir(newSkillsDir, projectRoot)) {
        migrateLegacyKimiSkillsDir(oldSkillsDir, newSkillsDir);
      }
    }
    return created;
  }

  /** Uninstall Kimi skills and remove leftover legacy directories. */
  teardown(projectRoot: string, manifest: IntegrationManifest, opts: { force?: boolean } = {}): [string[], string[]] {
    const [removed, skipped] = super.teardown(projectRoot, manifest, opts);
    const oldSkillsDir = join(projectRoot, '.kimi', 'skills');
    if (isSafeLegacyDir(oldSkillsDir, projectRoot)) {
      const legacyDirs = [...globPrefix(oldSkillsDir, 'speckit-'), ...globPrefix(oldSkillsDir, 'speckit.')].sort();
      for (const legacyDir of legacyDirs) {
        if (isSymlink(legacyDir) || !isDir(legacyDir)) continue;
        if (isSpeckitGeneratedSkill(legacyDir)) {
          try {
            rmSync(legacyDir, { recursive: true });
            removed.push(legacyDir);
          } catch {
            skipped.push(legacyDir);
          }
        }
      }
      try {
        rmdirSync(oldSkillsDir);
      } catch {
        // not empty
      }
    }
    return [removed, skipped];
  }
}

// ============================================================================
// Legacy migration helpers
// ============================================================================

/** Entries of *dir* whose name starts with *prefix* (``Path.glob(prefix + "*")``). */
function globPrefix(dir: string, prefix: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** True when *path* escapes *projectRoot* or any component below it is a symlink. */
export function hasSymlinkedComponent(path: string, projectRoot: string): boolean {
  if (!isRelativeTo(path, projectRoot)) return true;
  let current = projectRoot;
  for (const part of pathParts(relative(projectRoot, path))) {
    current = join(current, part);
    if (isSymlink(current)) return true;
  }
  return false;
}

/** True when *path* is a real directory safely inside *projectRoot*. */
export function isSafeLegacyDir(path: string, projectRoot: string): boolean {
  if (!isDir(path)) return false;
  if (hasSymlinkedComponent(path, projectRoot)) return false;
  let resolved: string;
  let root: string;
  try {
    resolved = resolvePath(path);
    root = resolvePath(projectRoot);
  } catch {
    return false;
  }
  return isRelativeTo(resolved, root);
}

/** Convert a legacy skill directory name to the modern hyphenated form. */
export function legacyToTargetName(legacyName: string): string {
  if (legacyName.startsWith('speckit-')) return legacyName;
  if (legacyName.startsWith('speckit.')) {
    const suffix = legacyName.slice('speckit.'.length);
    if (suffix) return `speckit-${suffix.replace(/\./g, '-')}`;
  }
  return '';
}

function moveDir(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch {
    cpSync(src, dst, { recursive: true });
    rmSync(src, { recursive: true });
  }
}

/**
 * Migrate skills from ``.kimi/skills/`` to ``.kimi-code/skills/`` (dotted
 * names hyphenated). Returns ``[migratedCount, removedCount]``.
 */
export function migrateLegacyKimiSkillsDir(oldSkillsDir: string, newSkillsDir: string): [number, number] {
  if (!isDir(oldSkillsDir)) return [0, 0];
  let migrated = 0;
  let removedCount = 0;
  const legacyDirs = [...globPrefix(oldSkillsDir, 'speckit-'), ...globPrefix(oldSkillsDir, 'speckit.')];
  for (const legacyDir of legacyDirs) {
    if (isSymlink(legacyDir) || !isDir(legacyDir)) continue;
    const legacySkill = join(legacyDir, 'SKILL.md');
    if (isSymlink(legacySkill) || !isFile(legacySkill)) continue;
    const targetName = legacyToTargetName(legacyDir.slice(oldSkillsDir.length + 1));
    if (!targetName) continue;
    const targetDir = join(newSkillsDir, targetName);
    if (resolvePath(legacyDir) === resolvePath(targetDir)) continue;
    if (!existsSync(targetDir)) {
      mkdirSync(dirname(targetDir), { recursive: true });
      moveDir(legacyDir, targetDir);
      migrated += 1;
      continue;
    }
    if (isSymlink(targetDir) || !isDir(targetDir)) continue;
    const targetSkill = join(targetDir, 'SKILL.md');
    if (isSymlink(targetSkill) || !isFile(targetSkill)) continue;
    try {
      if (readFileSync(targetSkill).equals(readFileSync(legacySkill))) {
        const hasExtra = readdirSync(legacyDir).some((child) => child !== 'SKILL.md');
        if (!hasExtra) {
          rmSync(legacyDir, { recursive: true });
          removedCount += 1;
        }
      }
    } catch {
      // best effort
    }
  }
  try {
    rmdirSync(oldSkillsDir);
  } catch {
    // not empty
  }
  return [migrated, removedCount];
}

/** True when *skillDir* contains a Speckit-generated SKILL.md (metadata check). */
export function isSpeckitGeneratedSkill(skillDir: string): boolean {
  const skillFile = join(skillDir, 'SKILL.md');
  if (isSymlink(skillFile) || !isFile(skillFile)) return false;
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(skillFile));
  } catch {
    return false;
  }
  if (!content.startsWith('---')) return false;
  const lines = splitlines(content, true);
  let close: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (pyRstrip(lines[i]) === '---') {
      close = i;
      break;
    }
  }
  if (close === null) return false;
  let fm: unknown;
  try {
    fm = parseYaml(lines.slice(1, close).join(''));
  } catch {
    return false;
  }
  if (typeof fm !== 'object' || fm === null || Array.isArray(fm)) return false;
  const metadata = (fm as Record<string, unknown>).metadata ?? {};
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return false;
  const author = (metadata as Record<string, unknown>).author ?? '';
  const source = (metadata as Record<string, unknown>).source ?? '';
  return author === 'github-spec-kit' && typeof source === 'string' && source.startsWith('templates/commands/');
}

/** Compatibility shim — migrate legacy dotted skill dirs in place. */
export function migrateLegacyKimiDottedSkills(skillsDir: string): [number, number] {
  return migrateLegacyKimiSkillsDir(skillsDir, skillsDir);
}
