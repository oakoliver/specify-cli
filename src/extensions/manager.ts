/**
 * @oakoliver/specify-cli - Extension manager
 *
 * Port of ``ExtensionManager`` from ``specify_cli/extensions/__init__.py``:
 * installation (directory / archive), removal, config scaffolding, agent
 * command + skill registration, and listing of installed extensions.
 *
 * @module extensions/manager
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
  constants as fsConstants,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { CommandRegistrar as AgentRegistrar } from '../agents.js';
import { AGENT_CONFIG } from '../agent-config.js';
import { safeExtractArchive } from '../download-security.js';
import {
  MISSING_INIT_OPTIONS_FILE,
  isAiSkillsEnabled,
  loadInitOptions,
  resolveActiveAgentForRegistration,
} from '../init-options.js';
import { isDollarSkillsAgent, isSlashSkillsAgent } from '../invocation-style.js';
import { getIntegration } from '../integrations/index.js';
import { IntegrationBase, type RegistrarConfig } from '../integrations/base.js';
import {
  ensureExecutableScripts,
  getSkillsDir as resolveConfiguredSkillsDir,
  resolveActiveSkillsDir,
  validateSafeSharedDirectory,
} from '../shared-infra.js';
import { dumpFrontmatter, relativeExtensionPathViolation, versionSatisfies } from '../utils.js';
import { SpecifierSet } from '../bundles/versioning.js';
import { pyRepr, pyTruthy, pyTypeName } from '../bundles/pycompat.js';
import { CommandRegistrar } from './command-registrar.js';
import {
  UnicodeDecodeError,
  decodeUtf8Strict,
  exists,
  isDir,
  isFile,
  isSymlink,
  pyCapitalize,
  pyEquals,
  pyTitle,
  readTextUtf8,
} from './compat.js';
import { CompatibilityError, ExtensionError, ValidationError } from './errors.js';
import {
  type IgnoreFn,
  copy2,
  copytree,
  fsyncDirectory,
  fsyncFd,
  globSuffix,
  isRelativeTo,
  resolveStrictFalse,
  rmtree,
  unlink,
  withTempDir,
} from './fs-utils.js';
import { GitIgnoreSpec } from './gitignore-spec.js';
import { HookExecutor } from './hooks.js';
import {
  CORE_COMMAND_NAMES,
  EXTENSION_COMMAND_NAME_PATTERN,
  REINSTALL_COMMAND,
  type Dict,
  ExtensionManifest,
  isMapping,
  normalizePriority,
} from './manifest.js';
import { ExtensionRegistry } from './registry.js';
import { DEFAULT_SKILLS_DIR, printCliWarning } from './root-helpers.js';

// ============================================================================
// Types
// ============================================================================

/** Options for {@link ExtensionManager.installFromDirectory}. */
export interface InstallFromDirectoryOptions {
  registerCommands?: boolean;
  priority?: number;
  linkCommands?: boolean;
  force?: boolean;
  catalogName?: string | null;
}

/** Options for {@link ExtensionManager.installFromArchive}. */
export interface InstallFromArchiveOptions {
  priority?: number;
  force?: boolean;
  /** Already-read archive bytes to consume instead of reopening ``archivePath``. */
  archiveFile?: Uint8Array | null;
  sourceName?: string | null;
  contentType?: string | null;
  catalogName?: string | null;
}

/** One record returned by {@link ExtensionManager.listInstalled}. */
export interface InstalledExtensionRecord {
  id: string;
  name: string;
  /** Registry version (raw registry value; normally a string). */
  version: string;
  description: string;
  /** Registry ``enabled`` flag (raw registry value; normally a boolean). */
  enabled: boolean;
  priority: number;
  installed_at: unknown;
  command_count: number;
  hook_count: number;
  _json_author: string | null;
  _json_source: unknown;
  _json_provides: { commands: number; templates: number; scripts: number; hooks: number };
}

const CONFIG_SUFFIXES = ['-config.yml', '-config.local.yml'];

function isConfigName(name: string): boolean {
  return CONFIG_SUFFIXES.some((s) => name.endsWith(s));
}

function has(obj: Dict | null | undefined, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function get(obj: Dict | null | undefined, key: string, fallback: unknown = null): unknown {
  return has(obj, key) ? (obj as Dict)[key] : fallback;
}

function sMode(mode: number): number {
  return mode & 0o7777;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function lexicalAbs(p: string): string {
  return resolve(p);
}

/** Write ``content`` fully to a freshly created (O_EXCL, 0600) file. */
function writeExclusive(path: string, content: Uint8Array): void {
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    let written = 0;
    while (written < content.length) {
      written += writeSync(fd, content, written, content.length - written);
    }
    fsyncFd(fd);
  } finally {
    closeSync(fd);
  }
}

// ============================================================================
// ExtensionManager
// ============================================================================

/** Manages extension lifecycle: installation, removal, updates. */
export class ExtensionManager {
  readonly projectRoot: string;
  readonly extensionsDir: string;
  registry: ExtensionRegistry;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.extensionsDir = join(projectRoot, '.specify', 'extensions');
    this.registry = new ExtensionRegistry(this.extensionsDir);
  }

  /** Fixed-length staging directory path for a preserved-config rescue. */
  rescueStagingDir(extensionId: string): string {
    const digest = createHash('sha256').update(extensionId, 'utf-8').digest('hex').slice(0, 16);
    return join(this.extensionsDir, `.rescue-staging-${digest}`);
  }

  /** True when ``directory`` contains a valid (non-symlink) ``.keep-config`` marker. */
  static hasKeepConfigMarker(directory: string): boolean {
    const marker = join(directory, '.keep-config');
    return isFile(marker) && !isSymlink(marker);
  }

  /** True for the pre-marker ``remove(..., keep_config=True)`` config-only layout. */
  static isLegacyKeepConfigLeftover(directory: string): boolean {
    if (!isDir(directory) || isSymlink(directory)) return false;
    let hasConfig = false;
    for (const name of listDir(directory)) {
      const entry = join(directory, name);
      if (isConfigName(name) && (isFile(entry) || isSymlink(entry))) {
        hasConfig = true;
        continue;
      }
      return false;
    }
    return hasConfig;
  }

  /**
   * Collect command and alias names declared by a manifest, performing
   * install-time validation of extension-specific constraints.
   */
  static collectManifestCommandNames(manifest: ExtensionManifest): Map<string, string> {
    if (CORE_COMMAND_NAMES.has(manifest.id)) {
      throw new ValidationError(
        `Extension ID '${manifest.id}' conflicts with core command namespace '${manifest.id}'`,
      );
    }

    const declared = new Map<string, string>();
    for (const cmd of manifest.commands) {
      const primaryName = cmd.name;
      let aliases = has(cmd, 'aliases') ? cmd.aliases : [];
      if (aliases === null || aliases === undefined) aliases = [];
      if (!Array.isArray(aliases)) {
        throw new ValidationError(`Aliases for command '${primaryName}' must be a list`);
      }

      const pairs: Array<[string, unknown]> = [['command', primaryName], ...aliases.map((a: unknown): [string, unknown] => ['alias', a])];
      for (const [kind, name] of pairs) {
        if (typeof name !== 'string') {
          throw new ValidationError(`${pyCapitalize(kind)} for command '${primaryName}' must be a string`);
        }
        const pathReason = relativeExtensionPathViolation(name);
        if (pathReason) {
          throw new ValidationError(`Invalid ${kind} ${pyRepr(name)}: ${pathReason}`);
        }
        if (kind === 'command') {
          const match = EXTENSION_COMMAND_NAME_PATTERN.exec(name);
          if (match === null) {
            throw new ValidationError(
              `Invalid ${kind} '${name}': must follow pattern 'speckit.{extension}.{command}'`,
            );
          }
          const namespace = match[1];
          if (namespace !== manifest.id) {
            throw new ValidationError(
              `${pyCapitalize(kind)} '${name}' must use extension namespace '${manifest.id}'`,
            );
          }
          if (CORE_COMMAND_NAMES.has(namespace)) {
            throw new ValidationError(
              `${pyCapitalize(kind)} '${name}' conflicts with core command namespace '${namespace}'`,
            );
          }
        }
        if (declared.has(name)) {
          throw new ValidationError(`Duplicate command or alias '${name}' in extension manifest`);
        }
        declared.set(name, kind);
      }
    }
    return declared;
  }

  /** Registered command and alias names for installed extensions. */
  getInstalledCommandNameMap(excludeExtensionId: string | null = null): Map<string, string> {
    const installed = new Map<string, string>();
    for (const extId of this.registry.keys()) {
      if (extId === excludeExtensionId) continue;
      const manifest = this.getExtension(extId);
      if (manifest === null) continue;
      for (const cmd of manifest.commands) {
        const cmdName = get(cmd, 'name');
        if (typeof cmdName === 'string' && !installed.has(cmdName)) installed.set(cmdName, extId);
        const aliases = get(cmd, 'aliases', []);
        if (!Array.isArray(aliases)) continue;
        for (const alias of aliases) {
          if (typeof alias === 'string' && !installed.has(alias)) installed.set(alias, extId);
        }
      }
    }
    return installed;
  }

  /** Normalize a command/alias name to its on-disk output form. */
  static normalizeShadowName(name: string): string {
    let hyphenated = name.replace(/\./g, '-');
    if (!hyphenated.startsWith('speckit-')) hyphenated = `speckit-${hyphenated}`;
    return hyphenated;
  }

  /** Reject installs that would shadow core or installed extension commands. */
  validateInstallConflicts(manifest: ExtensionManifest): void {
    const declared = ExtensionManager.collectManifestCommandNames(manifest);
    const installed = this.getInstalledCommandNameMap(manifest.id);
    const coreShadowNames = new Set(
      [...CORE_COMMAND_NAMES].map((n) => ExtensionManager.normalizeShadowName(`speckit.${n}`)),
    );
    const collisions: string[] = [];
    for (const name of [...declared.keys()].sort()) {
      if (installed.has(name)) {
        collisions.push(`${name} (already provided by extension '${installed.get(name)}')`);
      } else if (coreShadowNames.has(ExtensionManager.normalizeShadowName(name))) {
        collisions.push(`${name} (conflicts with core command)`);
      }
    }
    if (collisions.length) {
      throw new ValidationError(
        'Extension commands conflict with core or installed extension commands:\n- ' +
          collisions.join('\n- '),
      );
    }
  }

  /** Load ``.extensionignore`` and return a copytree ignore function, or null. */
  static loadExtensionignore(sourceDir: string): IgnoreFn | null {
    const ignoreFile = join(sourceDir, '.extensionignore');
    if (!exists(ignoreFile)) return null;
    let raw: string;
    try {
      raw = decodeUtf8Strict(readFileSync(ignoreFile));
    } catch (err) {
      if (err instanceof UnicodeDecodeError) {
        throw new ValidationError(
          `.extensionignore is not valid UTF-8: ${ignoreFile} (${err.reason} at byte ${err.start})`,
        );
      }
      throw err;
    }
    const lines = raw.split(/\r\n|\r|\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const normalised: string[] = [];
    for (const line of lines) {
      const stripped = line.trim();
      if (stripped && !stripped.startsWith('#')) normalised.push(stripped.replace(/\\/g, '/'));
      else normalised.push(line);
    }
    normalised.push('.extensionignore');
    const spec = GitIgnoreSpec.fromLines(normalised);

    return (directory: string, entries: string[]): Set<string> => {
      const ignored = new Set<string>();
      const relDir = relative(sourceDir, directory);
      for (const entry of entries) {
        const relPath = relDir && relDir !== '.' ? join(relDir, entry) : entry;
        const relFwd = relPath.split(sep).join('/').replace(/\\/g, '/');
        if (isDir(join(directory, entry))) {
          if (spec.matchFile(relFwd + '/')) ignored.add(entry);
        } else if (spec.matchFile(relFwd)) {
          ignored.add(entry);
        }
      }
      return ignored;
    };
  }

  /**
   * Return the active skills directory for extension skill registration, or
   * ``null`` when skills are inactive or the directory is unusable.
   */
  getSkillsDir(opts: { create?: boolean } = {}): string | null {
    const create = opts.create ?? true;
    const ensureUsable = (skillsDir: string): string | null => {
      try {
        mkdirSync(skillsDir, { recursive: true });
        if (!isDir(skillsDir)) throw new Error(`${skillsDir} is not a directory`);
      } catch (exc) {
        printCliWarning('resolve', 'skills directory', skillsDir, exc, {
          continuing: 'Continuing without skill registration.',
        });
        return null;
      }
      return skillsDir;
    };

    const opts2 = loadInitOptions(this.projectRoot);
    if (!isMapping(opts2)) return null;
    const selectedAi = opts2.ai;
    if (typeof selectedAi !== 'string' || !selectedAi) return null;

    const agentConfig = (AgentRegistrar.AGENT_CONFIGS as Record<string, Dict>)[selectedAi];
    const aiSkillsEnabled = isAiSkillsEnabled(opts2);
    if (!create) {
      if (!aiSkillsEnabled && selectedAi !== 'kimi') return null;
      const configured = resolveConfiguredSkillsDir(this.projectRoot, selectedAi);
      try {
        validateSafeSharedDirectory(this.projectRoot, configured);
      } catch {
        return null;
      }
      let skillsDir = configured;
      if (agentConfig && agentConfig.extension === '/SKILL.md') {
        skillsDir = AgentRegistrar.resolveAgentDir(selectedAi, agentConfig as RegistrarConfig, this.projectRoot);
      }
      if (aiSkillsEnabled) return skillsDir;
      return isDir(skillsDir) ? skillsDir : null;
    }
    let skillsDir: string | null;
    try {
      skillsDir = resolveActiveSkillsDir(this.projectRoot);
    } catch (exc) {
      printCliWarning('resolve', 'skills directory', null, exc, {
        continuing: 'Continuing without skill registration.',
      });
      return null;
    }
    if (skillsDir === null) return null;
    if (agentConfig && agentConfig.extension === '/SKILL.md') {
      skillsDir = AgentRegistrar.resolveAgentDir(selectedAi, agentConfig as RegistrarConfig, this.projectRoot);
    }
    return ensureUsable(skillsDir);
  }

  /** ``Path(name)`` is relative with exactly one component. */
  static isSingleComponentName(name: string): boolean {
    if (!name || isAbsolute(name) || name.includes('/')) return false;
    return name !== '.';
  }

  /** Generated skill directory name for an extension command. */
  static skillNameForCommand(commandName: string): string {
    let shortName = commandName;
    if (shortName.startsWith('speckit.')) shortName = shortName.slice('speckit.'.length);
    return `speckit-${shortName.replace(/\./g, '-')}`;
  }

  /**
   * Agents a new extension install may render commands for. ``null`` means
   * legacy detection-based registration; an empty set means fail closed.
   */
  activeCommandRegistrationScope(): Set<string> | null {
    const activeAgent = resolveActiveAgentForRegistration(this.projectRoot);
    if (activeAgent === MISSING_INIT_OPTIONS_FILE) return null;
    if (activeAgent === null || typeof activeAgent !== 'string') return new Set();

    const agentConfig = (AgentRegistrar.AGENT_CONFIGS as Record<string, Dict>)[activeAgent];
    if (
      agentConfig &&
      isAiSkillsEnabled(loadInitOptions(this.projectRoot)) &&
      agentConfig.extension !== '/SKILL.md'
    ) {
      return new Set();
    }
    return new Set([activeAgent]);
  }

  /** Current or recoverable command roots for a new install. */
  commandRegistrationTargets(): Map<string, string> {
    const agentScope = this.activeCommandRegistrationScope();
    const activeSkillsAgent = AgentRegistrar.activeSkillsAgent(this.projectRoot);
    const recoverableActiveSkillsDir =
      activeSkillsAgent !== null ? this.getSkillsDir({ create: false }) : null;
    const targets = new Map<string, string>();

    for (const [agentName, agentConfig] of Object.entries(AgentRegistrar.AGENT_CONFIGS as Record<string, Dict>)) {
      if (agentScope !== null && !agentScope.has(agentName)) continue;
      const activeSkillsOutput = agentName === activeSkillsAgent && agentConfig.extension === '/SKILL.md';
      const commandsDir = AgentRegistrar.resolveAgentDir(agentName, agentConfig as RegistrarConfig, this.projectRoot);
      const activeOutputIsRecoverable =
        activeSkillsOutput &&
        recoverableActiveSkillsDir !== null &&
        AgentRegistrar.sameLexicalPath(commandsDir, recoverableActiveSkillsDir);
      const detectDir = agentConfig.detect_dir;
      if (detectDir && !isDir(join(this.projectRoot, detectDir)) && !activeOutputIsRecoverable) continue;
      if (isDir(commandsDir) || activeOutputIsRecoverable) targets.set(agentName, commandsDir);
    }
    return targets;
  }

  /** Register extension commands for the active integration only (#2948). */
  registerCommandsForActiveAgent(
    manifest: ExtensionManifest,
    extensionDir: string,
    linkOutputs = false,
  ): Record<string, string[]> {
    const registrar = new CommandRegistrar();
    const agentScope = this.activeCommandRegistrationScope();
    if (agentScope === null) {
      return registrar.registerCommandsForAllAgents(manifest, extensionDir, this.projectRoot, {
        linkOutputs,
        createMissingActiveSkillsDir: true,
      });
    }
    if (agentScope.size === 0) return {};
    const activeAgent = [...agentScope][0];
    return registrar.registerCommandsForAllAgents(manifest, extensionDir, this.projectRoot, {
      linkOutputs,
      createMissingActiveSkillsDir: true,
      onlyAgent: activeAgent,
    });
  }

  /** Generate SKILL.md files for extension commands (skills mode only). */
  registerExtensionSkills(
    manifest: ExtensionManifest,
    extensionDir: string,
    linkOutputs = false,
    force = false,
  ): string[] {
    const skillsDir = this.getSkillsDir();
    if (!skillsDir) return [];

    const written: string[] = [];
    let opts: Dict = loadInitOptions(this.projectRoot);
    if (!isMapping(opts)) opts = {};
    const selectedAi = opts.ai;
    if (typeof selectedAi !== 'string' || !selectedAi) return [];
    const registrar = new AgentRegistrar();
    const agentConfig: Dict = (AgentRegistrar.AGENT_CONFIGS as Record<string, Dict>)[selectedAi] ?? {};
    const integration = getIntegration(selectedAi);
    const aiSkillsEnabled = isAiSkillsEnabled(opts);

    const resolveCommandRefTokens = (body: string): string =>
      body.replace(/__SPECKIT_COMMAND_([A-Z][A-Z0-9_-]*)__/g, (whole: string, group: string) => {
        const commandName = 'speckit.' + group.toLowerCase().replace(/_/g, '.');
        if (isDollarSkillsAgent(selectedAi, aiSkillsEnabled)) {
          return '$' + commandName.replace('speckit.', 'speckit-').replace(/\./g, '-');
        }
        if (isSlashSkillsAgent(selectedAi, aiSkillsEnabled)) {
          return '/' + commandName.replace('speckit.', 'speckit-').replace(/\./g, '-');
        }
        if (integration !== null && integration !== undefined) {
          return integration.buildCommandInvocation(commandName);
        }
        return IntegrationBase.resolveCommandRefs(whole, (agentConfig.invoke_separator as string) ?? '.');
      });

    for (const cmdInfo of manifest.commands) {
      const cmdName: string = cmdInfo.name;
      const cmdFileRel: string = cmdInfo.file;

      if (isAbsolute(cmdFileRel)) continue;
      let sourceFile: string;
      try {
        const extRoot = resolveStrictFalse(extensionDir);
        sourceFile = resolveStrictFalse(join(extRoot, cmdFileRel));
        if (!isRelativeTo(sourceFile, extRoot)) continue;
      } catch {
        continue;
      }
      if (!isFile(sourceFile)) continue;

      const skillName = ExtensionManager.skillNameForCommand(cmdName);
      const skillSubdir = join(skillsDir, skillName);
      const skillFile = join(skillSubdir, 'SKILL.md');
      const cacheRoot = join(extensionDir, '.specify-dev', 'extension-skills');
      const cacheFile = join(cacheRoot, skillName, 'SKILL.md');
      const useDevSymlink = linkOutputs && !agentConfig.dev_no_symlink;
      const skillDirPreexists = exists(skillSubdir) || isSymlink(skillSubdir);
      AgentRegistrar.ensureInside(cacheFile, cacheRoot);
      if (exists(skillFile) || isSymlink(skillFile)) {
        const isExpectedDevSymlink = ExtensionManager.isExpectedDevSymlink(skillFile, cacheFile);
        if (!isExpectedDevSymlink && !force) continue;
      } else if (skillDirPreexists && !force) {
        continue;
      }

      const createdNow = !exists(skillSubdir);
      mkdirSync(skillSubdir, { recursive: true });

      let content: string;
      try {
        content = readTextUtf8(sourceFile);
      } catch {
        if (createdNow) {
          try {
            rmdirSync(skillSubdir);
          } catch {
            // best-effort cleanup
          }
        }
        continue;
      }
      let [frontmatter, body] = AgentRegistrar.parseFrontmatter(content) as [Dict, string];
      frontmatter = registrar.adjustScriptPaths(frontmatter, manifest.id) as Dict;
      body = AgentRegistrar.rewriteExtensionPaths(body, manifest.id, extensionDir);
      body = AgentRegistrar.resolveSkillPlaceholders(selectedAi, frontmatter, body, this.projectRoot, manifest.id);
      body = resolveCommandRefTokens(body);

      const originalDesc = get(frontmatter, 'description', '');
      const description = pyTruthy(originalDesc) ? String(originalDesc) : `Extension command: ${cmdName}`;

      const frontmatterData = AgentRegistrar.buildSkillFrontmatter(
        selectedAi,
        skillName,
        description,
        `extension:${manifest.id}`,
        get(manifest.data.extension, 'author'),
      ) as Dict;
      AgentRegistrar.applyArgumentHint(frontmatter, frontmatterData, integration);
      const frontmatterText = dumpFrontmatter(frontmatterData);

      let shortName = cmdName;
      if (shortName.startsWith('speckit.')) shortName = shortName.slice('speckit.'.length);
      const titleName = pyTitle(shortName.replace(/\./g, ' ').replace(/-/g, ' '));

      let skillContent = `---\n${frontmatterText}\n---\n\n# ${titleName} Skill\n\n${body}\n`;
      if (integration && typeof (integration as { postProcessSkillContent?: unknown }).postProcessSkillContent === 'function') {
        skillContent = (integration as unknown as { postProcessSkillContent(c: string): string }).postProcessSkillContent(
          skillContent,
        );
      }

      if (useDevSymlink) {
        try {
          mkdirSync(dirname(cacheFile), { recursive: true });
          writeFileSync(cacheFile, skillContent, 'utf-8');
          if (exists(skillFile) || isSymlink(skillFile)) unlink(skillFile);
          symlinkSync(relative(dirname(skillFile), cacheFile), skillFile);
        } catch {
          if (isSymlink(skillFile)) unlink(skillFile);
          writeFileSync(skillFile, skillContent, 'utf-8');
        }
      } else {
        if (isSymlink(skillFile)) unlink(skillFile);
        writeFileSync(skillFile, skillContent, 'utf-8');
      }
      written.push(skillName);
    }
    return written;
  }

  /** True when an existing skill file links to its dev cache. */
  static isExpectedDevSymlink(skillFile: string, cacheFile: string): boolean {
    if (!isSymlink(skillFile)) return false;
    try {
      return resolveStrictFalse(skillFile) === resolveStrictFalse(cacheFile);
    } catch {
      return false;
    }
  }

  /** Owned skill directories that removal is allowed to delete. */
  findExtensionSkillDirs(
    skillNames: string[],
    extensionId: string,
    skillsDir: string | null | undefined = undefined,
    _opts: { createSkillsDir?: boolean } = {},
  ): string[] {
    if (!skillNames.length) return [];
    const projectRoot = lexicalAbs(this.projectRoot);
    const fallback = new Map<string, string>();
    for (const [candidate, trustedRoot] of this.extensionSkillCandidateDirs()) {
      if (trustedRoot === projectRoot) fallback.set(candidate, trustedRoot);
    }
    let candidateDirs: Map<string, string>;
    if (skillsDir === undefined || skillsDir === null) {
      candidateDirs = new Map(fallback);
    } else if (skillsDir) {
      const candidate = lexicalAbs(skillsDir);
      const trustedRoot = this.extensionSkillTrustedRoot(candidate);
      candidateDirs = trustedRoot !== null ? new Map([[candidate, trustedRoot]]) : new Map();
    } else {
      candidateDirs = new Map();
    }

    const owned: string[] = [];
    const seen = new Set<string>();
    for (const [skillsCandidate, trustedRoot] of candidateDirs) {
      try {
        validateSafeSharedDirectory(trustedRoot, skillsCandidate);
      } catch {
        continue;
      }
      if (!isDir(skillsCandidate)) continue;
      for (const skillName of skillNames) {
        if (!ExtensionManager.isSingleComponentName(skillName)) continue;
        const skillSubdir = join(skillsCandidate, skillName);
        let resolvedSkillDir: string;
        try {
          validateSafeSharedDirectory(trustedRoot, skillSubdir);
          resolvedSkillDir = resolveStrictFalse(skillSubdir);
        } catch {
          continue;
        }
        if (seen.has(resolvedSkillDir) || !isDir(skillSubdir)) continue;
        const skillMd = join(skillSubdir, 'SKILL.md');
        if (!isFile(skillMd)) continue;
        try {
          const [fm] = AgentRegistrar.parseFrontmatter(readTextUtf8(skillMd)) as [Dict, string];
          const metadata = isMapping(fm) ? get(fm, 'metadata', {}) : {};
          const source = isMapping(metadata) ? get(metadata, 'source', '') : '';
          if (source !== `extension:${extensionId}`) continue;
        } catch {
          continue;
        }
        seen.add(resolvedSkillDir);
        owned.push(resolvedSkillDir);
      }
    }
    return owned;
  }

  /** The project or home root allowed to contain ``candidate``. */
  extensionSkillTrustedRoot(candidateInput: string): string | null {
    const candidate = lexicalAbs(candidateInput);
    for (const root of [lexicalAbs(this.projectRoot), lexicalAbs(homedir())]) {
      if (isRelativeTo(candidate, root)) return root;
    }
    return null;
  }

  /** Every configured skill output and its trusted root. */
  extensionSkillCandidateDirs(): Map<string, string> {
    const candidates = new Map<string, string>();
    const addCandidate = (c: string): void => {
      const candidate = lexicalAbs(c);
      const trustedRoot = this.extensionSkillTrustedRoot(candidate);
      if (trustedRoot !== null) candidates.set(candidate, trustedRoot);
    };
    for (const cfg of Object.values(AGENT_CONFIG as Record<string, Dict>)) {
      const folder = get(cfg, 'folder', '');
      if (typeof folder === 'string' && folder) {
        addCandidate(join(this.projectRoot, folder.replace(/\/+$/, ''), 'skills'));
      }
    }
    addCandidate(join(this.projectRoot, DEFAULT_SKILLS_DIR));
    for (const [agentName, agentConfig] of Object.entries(AgentRegistrar.AGENT_CONFIGS as Record<string, Dict>)) {
      if (agentConfig.extension !== '/SKILL.md') continue;
      addCandidate(AgentRegistrar.resolveAgentDir(agentName, agentConfig as RegistrarConfig, this.projectRoot));
    }
    return candidates;
  }

  /** Remove SKILL.md directories for extension skills. */
  unregisterExtensionSkills(skillNames: string[], extensionId: string, skillsDir?: string | null): void {
    for (const dir of this.findExtensionSkillDirs(skillNames, extensionId, skillsDir)) {
      rmtree(dir);
    }
  }

  /** Subset of ``skillNames`` still marker-verified anywhere. */
  extensionOwnedSkillNames(skillNames: string[], extensionId: string): string[] {
    if (!skillNames.length) return [];
    const marker = `extension:${extensionId}`;
    const owned = new Set<string>();
    for (const [skillsCandidate, trustedRoot] of this.extensionSkillCandidateDirs()) {
      if (owned.size === skillNames.length) break;
      if (!isDir(skillsCandidate)) continue;
      try {
        validateSafeSharedDirectory(trustedRoot, skillsCandidate);
      } catch {
        continue;
      }
      for (const skillName of skillNames) {
        if (owned.has(skillName)) continue;
        if (!ExtensionManager.isSingleComponentName(skillName)) continue;
        const skillSubdir = join(skillsCandidate, skillName);
        try {
          validateSafeSharedDirectory(trustedRoot, skillSubdir);
        } catch {
          continue;
        }
        if (!isDir(skillSubdir)) continue;
        const skillMd = join(skillSubdir, 'SKILL.md');
        if (!isFile(skillMd)) continue;
        let source: unknown;
        try {
          const [fm] = AgentRegistrar.parseFrontmatter(readTextUtf8(skillMd)) as [Dict, string];
          const metadata = isMapping(fm) ? get(fm, 'metadata', {}) : {};
          source = isMapping(metadata) ? get(metadata, 'source', '') : '';
        } catch {
          continue;
        }
        if (source === marker) owned.add(skillName);
      }
    }
    return skillNames.filter((n) => owned.has(n));
  }

  /**
   * Check if extension is compatible with current spec-kit version.
   * @throws CompatibilityError If extension is incompatible
   */
  checkCompatibility(manifest: ExtensionManifest, speckitVersion: string): boolean {
    const required: unknown = manifest.requiresSpeckitVersion;
    if (typeof required !== 'string') {
      throw new CompatibilityError(
        `Invalid version specifier: expected a string, got ${pyTypeName(required)} (${pyRepr(required)})`,
      );
    }
    try {
      new SpecifierSet(required);
    } catch {
      throw new CompatibilityError(`Invalid version specifier: ${required}`);
    }
    if (!versionSatisfies(speckitVersion, required)) {
      throw new CompatibilityError(
        `Extension requires spec-kit ${required}, but ${speckitVersion} is installed.\n` +
          `Upgrade spec-kit with: ${REINSTALL_COMMAND}`,
      );
    }
    return true;
  }

  /**
   * Install extension from a local directory.
   * @throws ValidationError If manifest is invalid or priority is invalid
   * @throws CompatibilityError If extension is incompatible
   */
  installFromDirectory(
    sourceDir: string,
    speckitVersion: string,
    options: InstallFromDirectoryOptions = {},
  ): ExtensionManifest {
    const registerCommands = options.registerCommands ?? true;
    const priority = options.priority ?? 10;
    const linkCommands = options.linkCommands ?? false;
    const force = options.force ?? false;
    const catalogName = options.catalogName ?? null;

    if (priority < 1) throw new ValidationError('Priority must be a positive integer (1 or higher)');

    const manifest = new ExtensionManifest(join(sourceDir, 'extension.yml'));
    this.checkCompatibility(manifest, speckitVersion);

    if (this.registry.isInstalled(manifest.id) && !force) {
      throw new ExtensionError(
        `Extension '${manifest.id}' is already installed. ` +
          `Use 'specify extension remove ${manifest.id}' first, ` +
          'or retry with --force to overwrite.',
      );
    }

    this.validateInstallConflicts(manifest);

    const destDir = join(this.extensionsDir, manifest.id);
    let sameLocation: boolean;
    try {
      sameLocation = resolveStrictFalse(sourceDir) === resolveStrictFalse(destDir);
    } catch {
      sameLocation = resolve(sourceDir) === resolve(destDir);
    }
    if (sameLocation) {
      throw new ValidationError(
        `Source path is the install destination for '${manifest.id}' ` +
          `(${destDir}). Refusing to proceed to avoid deleting the ` +
          'extension. Install from a copy in a different location instead.',
      );
    }

    let didRemove = false;
    if (force && this.registry.isInstalled(manifest.id)) {
      const backupConfigDir = join(this.extensionsDir, '.backup', manifest.id);
      if (isSymlink(backupConfigDir)) unlink(backupConfigDir);
      else if (isDir(backupConfigDir)) rmtree(backupConfigDir);
      else if (exists(backupConfigDir)) unlink(backupConfigDir);
      didRemove = this.remove(manifest.id);
    }

    const ignoreFn = ExtensionManager.loadExtensionignore(sourceDir);

    const strandedConfigs = new Map<string, [Buffer, number]>();
    const rescueStagingDir = this.rescueStagingDir(manifest.id);
    const rescueCompleteMarker = join(rescueStagingDir, '.rescue-complete');
    const stagingIsComplete =
      isDir(rescueStagingDir) &&
      !isSymlink(rescueStagingDir) &&
      isFile(rescueCompleteMarker) &&
      !isSymlink(rescueCompleteMarker);

    if (stagingIsComplete && !this.registry.isInstalled(manifest.id)) {
      const recognizedConfigNames = (directory: string, followSymlinks = true): Set<string> => {
        const names = new Set<string>();
        if (!isDir(directory)) return names;
        for (const name of listDir(directory)) {
          if (!isConfigName(name)) continue;
          const entry = join(directory, name);
          if (followSymlinks) {
            if (isFile(entry) && !isSymlink(entry)) names.add(name);
          } else if (isFile(entry) || isSymlink(entry)) {
            names.add(name);
          }
        }
        return names;
      };

      const conflicting = new Set<string>();
      const stagedNames = recognizedConfigNames(rescueStagingDir);
      const liveNames = recognizedConfigNames(destDir, false);

      const matchesSourceConfigBaseline = (configName: string): boolean => {
        const sourceFile = join(sourceDir, configName);
        const liveFile = join(destDir, configName);
        if (isSymlink(sourceFile) || isSymlink(liveFile)) return false;
        if (!isFile(sourceFile) || !isFile(liveFile)) return false;
        try {
          const sourceStat = statSync(sourceFile);
          const sourceBytes = readFileSync(sourceFile);
          const liveStat = statSync(liveFile);
          const liveBytes = readFileSync(liveFile);
          return liveBytes.equals(sourceBytes) && sMode(liveStat.mode) === sMode(sourceStat.mode);
        } catch {
          return false;
        }
      };

      const liveOnly = new Set([...liveNames].filter((n) => !stagedNames.has(n)));
      for (const name of liveOnly) {
        if (!matchesSourceConfigBaseline(name)) conflicting.add(name);
      }

      const rescueModesFile = join(rescueStagingDir, '.rescue-modes.json');
      let stagedModes: Record<string, number> = {};
      if (isFile(rescueModesFile) && !isSymlink(rescueModesFile)) {
        try {
          const loaded: unknown = JSON.parse(readFileSync(rescueModesFile, 'utf-8'));
          if (
            isMapping(loaded) &&
            Object.values(loaded).every((m) => typeof m === 'number' && Number.isInteger(m))
          ) {
            stagedModes = loaded as Record<string, number>;
          }
        } catch {
          // Ignore unreadable/invalid sidecar metadata.
        }
      }
      for (const stagedName of [...stagedNames].sort()) {
        const stagedFile = join(rescueStagingDir, stagedName);
        let stagedStatMode: number;
        let stagedBytes: Buffer;
        try {
          stagedStatMode = statSync(stagedFile).mode;
          stagedBytes = readFileSync(stagedFile);
        } catch {
          conflicting.add(stagedName);
          continue;
        }
        const stagedMode = has(stagedModes, stagedName) ? stagedModes[stagedName] : sMode(stagedStatMode);
        const liveFile = join(destDir, stagedName);
        if (isSymlink(liveFile)) {
          conflicting.add(stagedName);
        } else if (isFile(liveFile)) {
          try {
            const liveStat = statSync(liveFile);
            const liveBytes = readFileSync(liveFile);
            if (!liveBytes.equals(stagedBytes) || sMode(liveStat.mode) !== stagedMode) {
              conflicting.add(stagedName);
            }
          } catch {
            conflicting.add(stagedName);
          }
        }
        strandedConfigs.set(stagedName, [stagedBytes, stagedMode]);
      }
      if (conflicting.size) {
        const bothDiverged = [...conflicting].filter((n) => !liveOnly.has(n));
        const liveOnlyConflict = [...conflicting].filter((n) => liveOnly.has(n));
        const msgParts: string[] = [`Preserved extension config conflict for '${manifest.id}':`];
        if (bothDiverged.length) {
          msgParts.push(
            `The current config(s) (${bothDiverged.sort().join(', ')}) in ${destDir} differ` +
              ` from their rescued backup in ${rescueStagingDir}.` +
              ' Both copies have been preserved.',
          );
        }
        if (liveOnlyConflict.length) {
          msgParts.push(
            `The config(s) (${liveOnlyConflict.sort().join(', ')}) exist only in ${destDir}` +
              ' with no counterpart in the rescued backup at' +
              ` ${rescueStagingDir}.`,
          );
        }
        msgParts.push(
          `Reconcile ${destDir} and ${rescueStagingDir} to the` +
            ` desired final state, delete ${rescueStagingDir},` +
            ' then reinstall.',
        );
        throw new ValidationError(msgParts.join(' '));
      }
    } else if (
      exists(destDir) &&
      !this.registry.isInstalled(manifest.id) &&
      (ExtensionManager.hasKeepConfigMarker(destDir) || ExtensionManager.isLegacyKeepConfigLeftover(destDir))
    ) {
      const cfgFiles = [...globSuffix(destDir, '-config.yml'), ...globSuffix(destDir, '-config.local.yml')];
      for (const cfgFile of cfgFiles) {
        const cfgName = basename(cfgFile);
        if (isSymlink(cfgFile)) {
          throw new ValidationError(
            'Preserved extension config for ' +
              `'${manifest.id}' is a symlink (${cfgName}) in ` +
              `${destDir}, which cannot be safely rescued during ` +
              'reinstall. Resolve manually — replace the symlink with ' +
              'a regular file or remove it — then reinstall.',
          );
        }
        if (isFile(cfgFile)) {
          try {
            strandedConfigs.set(cfgName, [readFileSync(cfgFile), statSync(cfgFile).mode]);
          } catch (exc) {
            throw new ValidationError(
              'Preserved extension config for ' +
                `'${manifest.id}' cannot be read ` +
                `(${cfgName}) in ${destDir}: ${(exc as Error).message}. ` +
                'Resolve manually — fix its permissions or ' +
                'remove it — then reinstall.',
              { cause: exc },
            );
          }
        }
      }
    }

    if (strandedConfigs.size && !stagingIsComplete) {
      if (isSymlink(rescueStagingDir)) unlink(rescueStagingDir);
      else if (isDir(rescueStagingDir)) rmtree(rescueStagingDir);
      else if (exists(rescueStagingDir)) unlink(rescueStagingDir);
      try {
        mkdirSync(rescueStagingDir, { recursive: true });
        for (const [filename, [content]] of strandedConfigs) {
          writeExclusive(join(rescueStagingDir, filename), content);
        }
        const modes: Record<string, number> = {};
        for (const filename of [...strandedConfigs.keys()].sort()) {
          modes[filename] = sMode(strandedConfigs.get(filename)![1]);
        }
        const modesPayload = Buffer.from(
          '{' +
            Object.entries(modes)
              .map(([k, v]) => `${JSON.stringify(k)}: ${v}`)
              .join(', ') +
            '}',
          'utf-8',
        );
        writeExclusive(join(rescueStagingDir, '.rescue-modes.json'), modesPayload);
        fsyncDirectory(rescueStagingDir);
        writeExclusive(rescueCompleteMarker, new Uint8Array());
        fsyncDirectory(rescueStagingDir);
        fsyncDirectory(dirname(rescueStagingDir));
      } catch (err) {
        rmtree(rescueStagingDir, { ignoreErrors: true });
        throw err;
      }
    }

    if (exists(destDir)) rmtree(destDir);

    const restoreStrandedConfigFile = (target: string, content: Buffer, preservedMode: number): void => {
      let tmpPath: string | null = null;
      try {
        tmpPath = join(dirname(target), `.cfg-restore.${randomBytes(6).toString('hex')}`);
        writeExclusive(tmpPath, content);
        try {
          chmodSync(tmpPath, sMode(preservedMode));
        } catch {
          // Best-effort.
        }
        renameSync(tmpPath, target);
        tmpPath = null;
        let targetFd: number | null = null;
        try {
          targetFd = openSync(target, 'r');
        } catch {
          targetFd = null;
        }
        try {
          if (targetFd !== null) fsyncFd(targetFd);
        } finally {
          if (targetFd !== null) {
            try {
              closeSync(targetFd);
            } catch {
              // ignore
            }
          }
        }
        fsyncDirectory(dirname(target));
      } catch (err) {
        if (tmpPath !== null && exists(tmpPath)) unlink(tmpPath);
        throw err;
      }
    };

    try {
      copytree(sourceDir, destDir, { ignore: ignoreFn });
    } catch (err) {
      if (strandedConfigs.size) {
        mkdirSync(destDir, { recursive: true });
        for (const [filename, [content, mode]] of strandedConfigs) {
          restoreStrandedConfigFile(join(destDir, filename), content, mode);
        }
      }
      throw err;
    }

    for (const [filename, [content, mode]] of strandedConfigs) {
      restoreStrandedConfigFile(join(destDir, filename), content, mode);
    }

    let registeredCommands: Record<string, string[]> = {};
    if (registerCommands) {
      registeredCommands = this.registerCommandsForActiveAgent(manifest, destDir, linkCommands);
    }

    const registeredSkills = this.registerExtensionSkills(manifest, destDir, linkCommands);

    new HookExecutor(this.projectRoot).registerHooks(manifest);

    if (didRemove) {
      const backupConfigDir = join(this.extensionsDir, '.backup', manifest.id);
      if (isSymlink(backupConfigDir)) {
        unlink(backupConfigDir);
      } else if (isDir(backupConfigDir)) {
        for (const name of listDir(backupConfigDir)) {
          const cfgFile = join(backupConfigDir, name);
          if (isFile(cfgFile) && !isSymlink(cfgFile) && isConfigName(name)) {
            copy2(cfgFile, join(destDir, name));
          }
        }
        rmtree(backupConfigDir);
      } else if (exists(backupConfigDir)) {
        unlink(backupConfigDir);
      }
    }

    const normalizedCatalogName = typeof catalogName === 'string' ? catalogName.trim() : '';
    const source: unknown = normalizedCatalogName
      ? { kind: 'catalog', catalog: normalizedCatalogName }
      : 'local';
    this.registry.add(manifest.id, {
      version: manifest.version,
      source,
      manifest_hash: manifest.getHash(),
      enabled: true,
      priority,
      registered_commands: registeredCommands,
      registered_skills: registeredSkills,
    });

    if (isDir(rescueStagingDir) && !isSymlink(rescueStagingDir)) {
      try {
        unlink(rescueCompleteMarker, true);
        fsyncDirectory(rescueStagingDir);
        rmtree(rescueStagingDir);
        fsyncDirectory(dirname(rescueStagingDir));
      } catch {
        // Best-effort; install already committed to the registry.
      }
    }

    ensureExecutableScripts(this.projectRoot);
    return manifest;
  }

  /**
   * Install an extension from a supported archive (.zip, .tar.gz, .tgz).
   * @throws ValidationError If manifest is invalid or priority is invalid
   * @throws CompatibilityError If extension is incompatible
   */
  installFromArchive(
    archivePath: string,
    speckitVersion: string,
    options: InstallFromArchiveOptions = {},
  ): ExtensionManifest {
    const priority = options.priority ?? 10;
    if (priority < 1) throw new ValidationError('Priority must be a positive integer (1 or higher)');

    return withTempDir('speckit-ext-', (tempPath) => {
      safeExtractArchive(archivePath, tempPath, {
        archiveFile: options.archiveFile ?? null,
        sourceName: options.sourceName ?? null,
        contentType: options.contentType ?? null,
        errorType: ValidationError,
      });

      let extensionDir = tempPath;
      let manifestPath = join(extensionDir, 'extension.yml');
      if (!exists(manifestPath)) {
        const subdirs = listDir(tempPath)
          .map((n) => join(tempPath, n))
          .filter((d) => isDir(d));
        if (subdirs.length === 1) {
          extensionDir = subdirs[0];
          manifestPath = join(extensionDir, 'extension.yml');
        }
      }
      if (!exists(manifestPath)) throw new ValidationError('No extension.yml found in archive');

      return this.installFromDirectory(extensionDir, speckitVersion, {
        priority,
        force: options.force ?? false,
        catalogName: options.catalogName ?? null,
      });
    });
  }

  /** Whether ``.specify`` is a real directory inside the project. */
  configRootIsContained(specifyDir: string): boolean {
    let root: string;
    try {
      root = resolveStrictFalse(this.projectRoot);
    } catch {
      return false;
    }
    let current = this.projectRoot;
    const parts = relative(this.projectRoot, specifyDir).split(sep).filter((p) => p);
    for (const part of parts) {
      current = join(current, part);
      if (isSymlink(current)) return false;
      if (!exists(current)) return true;
      try {
        if (!isRelativeTo(resolveStrictFalse(current), root)) return false;
      } catch {
        return false;
      }
    }
    return isDir(current);
  }

  /** True when a scaffold target survives remove/backup/restore. */
  static targetFollowsPreservedConvention(targetName: string): boolean {
    if (targetName.includes('/') || targetName.includes('\\')) return false;
    return isConfigName(targetName);
  }

  /**
   * Deploy config templates from an installed extension. Existing config
   * files are never overwritten. Returns ``[deployed, skippedExisting, failed]``.
   */
  scaffoldConfig(extensionId: string): [string[], string[], string[]] {
    const extDir = join(this.extensionsDir, extensionId);
    const manifestPath = join(extDir, 'extension.yml');
    if (!exists(manifestPath)) return [[], [], []];

    const manifest = new ExtensionManifest(manifestPath);
    const deployed: string[] = [];
    const skippedExisting: string[] = [];
    const failed: string[] = [];

    const provides: Dict = isMapping(manifest.data.provides) ? manifest.data.provides : {};
    const rawConfig = get(provides, 'config', []);
    const configIsMalformed =
      has(provides, 'config') && (!Array.isArray(rawConfig) || !rawConfig.every((e) => isMapping(e)));
    if (configIsMalformed) return [deployed, skippedExisting, ['provides.config']];

    const extDirResolved = resolveStrictFalse(extDir);
    const configDir = join(this.projectRoot, '.specify', 'extensions', extensionId);
    if (!this.configRootIsContained(configDir)) return [deployed, skippedExisting, ['provides.config']];
    const configDirResolved = resolveStrictFalse(configDir);

    for (const configEntry of manifest.config) {
      const templateName = get(configEntry, 'template', '');
      const targetName = has(configEntry, 'name') ? configEntry.name : templateName;
      const failureName = typeof targetName === 'string' && targetName ? targetName : 'provides.config';
      if (typeof templateName !== 'string' || !templateName) {
        failed.push(failureName);
        continue;
      }
      if (typeof targetName !== 'string' || !targetName) {
        failed.push(failureName);
        continue;
      }
      if (!ExtensionManager.targetFollowsPreservedConvention(targetName)) {
        failed.push(failureName);
        continue;
      }

      const templateCandidate = join(extDir, templateName);
      const templatePath = resolveStrictFalse(templateCandidate);
      const targetPath = resolveStrictFalse(join(configDir, targetName));
      if (!isRelativeTo(templatePath, extDirResolved) || !isRelativeTo(targetPath, configDirResolved)) {
        failed.push(failureName);
        continue;
      }
      if (isSymlink(templateCandidate) || !isFile(templatePath)) {
        failed.push(failureName);
        continue;
      }
      if (exists(targetPath)) {
        skippedExisting.push(targetName);
        continue;
      }
      try {
        mkdirSync(dirname(targetPath), { recursive: true });
        copy2(templatePath, targetPath);
      } catch {
        failed.push(targetName);
        continue;
      }
      deployed.push(targetName);
    }
    return [deployed, skippedExisting, failed];
  }

  /** Backward-compatible wrapper for archive installation. */
  installFromZip(zipPath: string, speckitVersion: string, options: InstallFromArchiveOptions = {}): ExtensionManifest {
    return this.installFromArchive(zipPath, speckitVersion, options);
  }

  /**
   * Remove an installed extension. With ``keepConfig`` the config files are
   * preserved in place (with a ``.keep-config`` marker); otherwise they are
   * backed up to ``.specify/extensions/.backup/<id>/``.
   */
  remove(extensionId: string, keepConfig = false): boolean {
    if (!this.registry.isInstalled(extensionId)) return false;

    const metadata = this.registry.get(extensionId);
    const registeredCommands = metadata ? get(metadata, 'registered_commands', {}) : {};
    const rawSkills = metadata ? get(metadata, 'registered_skills', []) : [];
    const registeredSkills = Array.isArray(rawSkills) ? rawSkills.filter((s): s is string => typeof s === 'string') : [];

    const extensionDir = join(this.extensionsDir, extensionId);

    if (pyTruthy(registeredCommands)) {
      new CommandRegistrar().unregisterCommands(registeredCommands as Record<string, string[]>, this.projectRoot);
    }

    this.unregisterExtensionSkills(registeredSkills, extensionId);

    if (keepConfig) {
      if (exists(extensionDir)) {
        for (const name of listDir(extensionDir)) {
          const child = join(extensionDir, name);
          if (isFile(child) && isConfigName(name)) continue;
          if (isDir(child) && !isSymlink(child)) rmtree(child);
          else unlink(child);
        }
        writeFileSync(join(extensionDir, '.keep-config'), '');
      }
    } else {
      if (exists(extensionDir)) {
        const backupDir = join(this.extensionsDir, '.backup', extensionId);
        mkdirSync(backupDir, { recursive: true });
        const configFiles = [
          ...globSuffix(extensionDir, '-config.yml'),
          ...globSuffix(extensionDir, '-config.local.yml'),
        ];
        for (const configFile of configFiles) copy2(configFile, join(backupDir, basename(configFile)));
      }
      if (exists(extensionDir)) rmtree(extensionDir);
    }

    new HookExecutor(this.projectRoot).unregisterHooks(extensionId);
    this.registry.remove(extensionId);
    return true;
  }

  /** String entries from a registry list, ignoring corrupt values. */
  static validNameList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
  }

  /** Remove extension files registered for a specific agent. */
  unregisterAgentArtifacts(
    agentName: string,
    opts: { enabledOnly?: boolean; commandsOnly?: boolean } = {},
  ): void {
    if (!agentName) return;
    const registrar = new CommandRegistrar();
    if (!has(registrar.AGENT_CONFIGS, agentName)) return;
    const agentSkillsDir = resolveConfiguredSkillsDir(this.projectRoot, agentName);

    for (const [extId, metadata] of Object.entries(this.registry.list())) {
      if (opts.enabledOnly && !pyTruthy(get(metadata, 'enabled', true))) continue;
      const updates: Dict = {};

      const registeredCommands = get(metadata, 'registered_commands', {});
      if (isMapping(registeredCommands) && has(registeredCommands, agentName)) {
        const commandNames = ExtensionManager.validNameList(registeredCommands[agentName]);
        if (commandNames.length) registrar.unregisterCommands({ [agentName]: commandNames }, this.projectRoot);
        const newRegistered = structuredClone(registeredCommands);
        delete newRegistered[agentName];
        updates.registered_commands = newRegistered;
      }

      const registeredSkills = ExtensionManager.validNameList(get(metadata, 'registered_skills', []));
      if (registeredSkills.length && !opts.commandsOnly) {
        this.unregisterExtensionSkills(registeredSkills, extId, agentSkillsDir);
        if (isDir(agentSkillsDir)) {
          const remaining = this.extensionOwnedSkillNames(registeredSkills, extId);
          if (!pyEquals(remaining, registeredSkills)) updates.registered_skills = remaining;
        }
      }

      if (Object.keys(updates).length) this.registry.update(extId, updates);
    }
  }

  /** Remove old flat commands whose replacement skills were written. */
  retireLegacyFlatExtensionCommands(agentName: string, commandNames: string[]): string[] {
    const integration = getIntegration(agentName) as
      | (IntegrationBase & { legacyFlatCommandDir?: unknown; legacyFlatCommandExtension?: unknown })
      | null
      | undefined;
    const legacyDir = integration ? integration.legacyFlatCommandDir : null;
    const legacyExtension = integration ? integration.legacyFlatCommandExtension : null;
    if (typeof legacyDir !== 'string' || !legacyDir || typeof legacyExtension !== 'string' || !legacyExtension) {
      return [];
    }
    const agentConfig = (AgentRegistrar.AGENT_CONFIGS as Record<string, Dict>)[agentName];
    if (!agentConfig || agentConfig.extension !== '/SKILL.md') return [];

    const safeProjectDir = (rel: string): string | null => {
      if (isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return null;
      let current = this.projectRoot;
      for (const part of rel.split(/[\\/]/).filter((p) => p)) {
        current = join(current, part);
        if (isSymlink(current)) return null;
      }
      try {
        if (!isRelativeTo(resolveStrictFalse(current), resolveStrictFalse(this.projectRoot))) return null;
      } catch {
        return null;
      }
      return current;
    };

    const legacyRoot = safeProjectDir(legacyDir);
    const skillsRoot = safeProjectDir(String(get(agentConfig, 'dir', '')));
    if (legacyRoot === null || skillsRoot === null || !isDir(legacyRoot)) return [];

    const removed: string[] = [];
    for (const commandName of commandNames) {
      if (typeof commandName !== 'string' || !commandName || !AgentRegistrar.isSafeCommandName(commandName)) continue;
      const skillName = AgentRegistrar.computeOutputName(agentName, commandName, agentConfig as RegistrarConfig);
      const replacement = join(skillsRoot, skillName, 'SKILL.md');
      if (isSymlink(replacement) || !isFile(replacement)) continue;
      const legacyFile = join(legacyRoot, `${commandName}${legacyExtension}`);
      if (isSymlink(legacyFile) || isFile(legacyFile)) {
        unlink(legacyFile);
        removed.push(legacyFile);
      }
    }
    return removed;
  }

  /** Register installed, enabled extensions for ``agentName``. */
  registerEnabledExtensionsForAgent(agentName: string, opts: { force?: boolean } = {}): void {
    if (!agentName) return;
    const force = opts.force ?? false;
    const registrar = new CommandRegistrar();
    const agentConfig = (registrar.AGENT_CONFIGS as Record<string, Dict>)[agentName];
    let initOptions: Dict = loadInitOptions(this.projectRoot);
    if (!isMapping(initOptions)) initOptions = {};

    const activeAgent = initOptions.ai;
    const aiSkillsEnabled = isAiSkillsEnabled(initOptions);
    const skillsModeActive =
      activeAgent === agentName && aiSkillsEnabled && !!agentConfig && agentConfig.extension !== '/SKILL.md';
    const commandModeActive =
      activeAgent === agentName && !aiSkillsEnabled && !!agentConfig && agentConfig.extension !== '/SKILL.md';
    let agentSkillsDir: string | null = null;
    if (agentConfig && agentConfig.extension !== '/SKILL.md') {
      agentSkillsDir = resolveConfiguredSkillsDir(this.projectRoot, agentName);
    }

    for (const [extId, metadata] of Object.entries(this.registry.list())) {
      if (!pyTruthy(get(metadata, 'enabled', true))) continue;
      const manifest = this.getExtension(extId);
      if (manifest === null) continue;
      const extDir = join(this.extensionsDir, extId);

      try {
        const updates: Dict = {};
        let registered: string[] = [];
        let deferredStaleCommands: string[] | null = null;

        if (agentConfig && !skillsModeActive) {
          registered = registrar.registerCommandsForAgent(agentName, manifest, extDir, this.projectRoot);
          let registeredCommands = get(metadata, 'registered_commands', {});
          if (!isMapping(registeredCommands)) registeredCommands = {};
          const newRegistered: Dict = structuredClone(registeredCommands as Dict);
          if (registered.length) newRegistered[agentName] = registered;
          else delete newRegistered[agentName];
          if (!pyEquals(newRegistered, registeredCommands)) updates.registered_commands = newRegistered;
        } else if (agentConfig && skillsModeActive) {
          const registeredCommands = get(metadata, 'registered_commands', {});
          if (isMapping(registeredCommands) && pyTruthy(registeredCommands[agentName])) {
            deferredStaleCommands = ExtensionManager.validNameList(registeredCommands[agentName]);
          }
        }

        if (agentName === activeAgent) {
          let registeredSkills: string[] | undefined;
          let skillsFailed = false;
          try {
            registeredSkills = this.registerExtensionSkills(manifest, extDir, false, force);
          } catch (skillsErr) {
            skillsFailed = true;
            printCliWarning('register extension skills for', 'extension', extId, skillsErr, {
              continuing:
                'Continuing with available registration results for this ' +
                'extension and the remaining extensions.',
            });
          }
          if (!skillsFailed) {
            if (registeredSkills && registeredSkills.length) {
              const existingSkills = ExtensionManager.validNameList(get(metadata, 'registered_skills', []));
              updates.registered_skills = [...new Set([...existingSkills, ...registeredSkills])];
            } else if (commandModeActive && agentSkillsDir !== null) {
              const existingSkills = ExtensionManager.validNameList(get(metadata, 'registered_skills', []));
              const ownedHere = existingSkills.filter((name) => isDir(join(agentSkillsDir as string, name)));
              const replacedSkillNames = new Set(
                (registered ?? []).map((cmdName) => HookExecutor.skillNameFromCommand(cmdName)),
              );
              const toRemove = ownedHere.filter((name) => replacedSkillNames.has(name));
              if (toRemove.length) {
                this.unregisterExtensionSkills(toRemove, extId, agentSkillsDir);
                const remaining = this.extensionOwnedSkillNames(existingSkills, extId);
                if (!pyEquals(remaining, existingSkills)) updates.registered_skills = remaining;
              }
            }

            if (deferredStaleCommands && deferredStaleCommands.length) {
              const replacedSkillNames = new Set(registeredSkills ?? []);
              const aliasToPrimary = new Map<string, string>();
              for (const cmdInfo of manifest.commands) {
                const primaryName = get(cmdInfo, 'name');
                if (typeof primaryName !== 'string') continue;
                const aliases = get(cmdInfo, 'aliases', []);
                for (const alias of Array.isArray(aliases) ? aliases : []) {
                  if (typeof alias === 'string') aliasToPrimary.set(alias, primaryName);
                }
              }
              const groupFullyReplaced = new Map<string, boolean>();
              for (const cmdName of deferredStaleCommands) {
                const primaryName = aliasToPrimary.get(cmdName) ?? cmdName;
                if (groupFullyReplaced.has(primaryName)) continue;
                groupFullyReplaced.set(
                  primaryName,
                  replacedSkillNames.has(HookExecutor.skillNameFromCommand(primaryName)),
                );
              }
              const fullyReplaced = deferredStaleCommands.filter(
                (cmdName) => groupFullyReplaced.get(aliasToPrimary.get(cmdName) ?? cmdName) ?? false,
              );
              if (fullyReplaced.length) {
                registrar.unregisterCommands({ [agentName]: fullyReplaced }, this.projectRoot);
                const registeredCommands = get(metadata, 'registered_commands', {});
                if (isMapping(registeredCommands) && pyTruthy(registeredCommands[agentName])) {
                  const newRegistered: Dict = structuredClone(registeredCommands);
                  const remainingCommands = (newRegistered[agentName] as string[]).filter(
                    (c) => !fullyReplaced.includes(c),
                  );
                  if (remainingCommands.length) newRegistered[agentName] = remainingCommands;
                  else delete newRegistered[agentName];
                  if (!pyEquals(newRegistered, registeredCommands)) updates.registered_commands = newRegistered;
                }
              }
            }
          }
        }

        if (registered.length) this.retireLegacyFlatExtensionCommands(agentName, registered);
        if (Object.keys(updates).length) this.registry.update(extId, updates);
      } catch (extErr) {
        printCliWarning('register extension artifacts for', 'extension', extId, extErr, {
          continuing: 'Continuing with the remaining extensions.',
        });
        continue;
      }
    }
  }

  /** List all installed extensions with metadata. */
  listInstalled(): InstalledExtensionRecord[] {
    const result: InstalledExtensionRecord[] = [];
    for (const [extId, rawMetadata] of Object.entries(this.registry.list())) {
      const metadata: Dict = isMapping(rawMetadata) ? rawMetadata : {};
      const manifestPath = join(this.extensionsDir, extId, 'extension.yml');
      try {
        const manifest = new ExtensionManifest(manifestPath);
        const author = get(manifest.data.extension, 'author');
        const hookCount = Object.keys(manifest.hooks ?? {}).length;
        result.push({
          id: extId,
          name: manifest.name,
          version: get(metadata, 'version', 'unknown') as string,
          description: manifest.description,
          enabled: get(metadata, 'enabled', true) as boolean,
          priority: normalizePriority(get(metadata, 'priority')),
          installed_at: get(metadata, 'installed_at'),
          command_count: manifest.commands.length,
          hook_count: hookCount,
          _json_author: typeof author === 'string' && author ? author : null,
          _json_source: get(metadata, 'source'),
          _json_provides: {
            commands: manifest.commands.length,
            templates: manifest.templates.length,
            scripts: manifest.scripts.length,
            hooks: hookCount,
          },
        });
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        result.push({
          id: extId,
          name: extId,
          version: get(metadata, 'version', 'unknown') as string,
          description: '⚠️ Corrupted extension',
          enabled: false,
          priority: normalizePriority(get(metadata, 'priority')),
          installed_at: get(metadata, 'installed_at'),
          command_count: 0,
          hook_count: 0,
          _json_author: null,
          _json_source: get(metadata, 'source'),
          _json_provides: { commands: 0, templates: 0, scripts: 0, hooks: 0 },
        });
      }
    }
    return result;
  }

  /** Manifest for an installed extension, or ``null``. */
  getExtension(extensionId: string): ExtensionManifest | null {
    if (!this.registry.isInstalled(extensionId)) return null;
    try {
      return new ExtensionManifest(join(this.extensionsDir, extensionId, 'extension.yml'));
    } catch (err) {
      if (err instanceof ValidationError) return null;
      throw err;
    }
  }
}

// Silence "declared but never used" for helpers kept for parity.
void lstatSync;
