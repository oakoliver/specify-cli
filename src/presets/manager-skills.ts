/**
 * @oakoliver/specify-cli - Preset agent skill registration and reconciliation
 *
 * Port of ``specify_cli/presets/_manager_skills.py``: the SKILL.md half of
 * ``PresetManager`` (rendering preset command overrides as agent skills,
 * restoring core/extension skills on removal, provenance tracking, and
 * symlink-safe skill directory handling).
 *
 * @module presets/manager-skills
 */

import { rmSync } from 'node:fs';
import * as nodePath from 'node:path';

import { CommandRegistrar } from '../agents.js';
import { locateCorePack, repoRoot } from '../assets.js';
import { ExtensionManifest } from '../extensions/index.js';
import { isAiSkillsEnabled, loadInitOptions } from '../init-options.js';
import { IntegrationBase } from '../integrations/base.js';
import { getIntegration } from '../integrations/index.js';
import { getInvocationPrefix } from '../invocation-style.js';
import {
  ensureSafeSharedDirectory,
  getSkillsDir as projectSkillsDir,
  resolveActiveSkillsDir,
  resolveLoose,
  validateSafeSharedDirectory,
  writeSharedText,
} from '../shared-infra.js';
import { dumpFrontmatter } from '../utils.js';
import {
  PresetCommandMethods,
  isNativeSkillAgentConfig,
  normalizeRegisteredSkills,
  parseFrontmatterWith,
  printCliWarning,
  registrarAgentConfigs,
  resolveAgentDirWith,
  skillNamesForCommand,
  substituteCoreTemplate,
  type AgentNameMap,
  type SkillDirProvenance,
} from './manager-commands.js';
import {
  PresetManifest,
  PresetValidationError,
  UnicodeDecodeError,
  deepCopy,
  isDir,
  isFile,
  isMapping,
  isRelativeTo,
  isSymlink,
  pathExists,
  presetWarn,
  pyTruthy,
  readTextStrict,
  userHome,
  type PresetTemplateEntry,
} from './manifest.js';
import { PresetResolver, isOsError } from './resolver.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

/** Constants kept for backward compatibility with presets and extensions (upstream ``SKILL_DESCRIPTIONS``). */
export const SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  specify: 'Create or update feature specifications from natural language descriptions.',
  plan: 'Generate technical implementation plans from feature specifications.',
  tasks: 'Break down implementation plans into actionable task lists.',
  implement: 'Execute all tasks from the task breakdown to build the feature.',
  converge:
    'Assess the codebase against spec.md, plan.md, and tasks.md and append remaining work as new tasks.',
  analyze: 'Perform cross-artifact consistency analysis across spec.md, plan.md, and tasks.md.',
  clarify: 'Structured clarification workflow for underspecified requirements.',
  constitution: 'Create or update project governing principles and development guidelines.',
  checklist: 'Generate custom quality checklists for validating requirements completeness and clarity.',
  taskstoissues: 'Convert tasks from tasks.md into GitHub issues.',
};

/** A manifest-like object exposing ``id`` and ``templates`` (see ``_FilteredManifest``). */
export interface ManifestLike {
  id: string;
  templates: PresetTemplateEntry[];
}

/** Wrapper that exposes only selected command templates from a manifest. */
export function filteredManifest(manifest: PresetManifest, cmdNames: Set<string>): ManifestLike {
  return {
    id: manifest.id,
    get templates() {
      return manifest.templates.filter((t) => cmdNames.has(t.name));
    },
  };
}

/** Python ``str.title()``. */
function pyTitle(value: string): string {
  let out = '';
  let prevCased = false;
  for (const ch of value) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    const isCased = lower !== upper;
    if (isCased) {
      out += prevCased ? lower : upper;
      prevCased = true;
    } else {
      out += ch;
      prevCased = false;
    }
  }
  return out;
}

function postProcessSkill(integration: unknown, content: string): string {
  const i = integration as { postProcessSkillContent?: (c: string) => string } | null;
  if (i && typeof i.postProcessSkillContent === 'function') return i.postProcessSkillContent(content);
  return content;
}

/** Skill artifact methods shared through PresetManager's lifecycle state. */
export abstract class PresetSkillMethods extends PresetCommandMethods {
  /** Merge actually-written agent skill registrations into a preset's metadata. */
  mergePackRegisteredSkills(packId: string, written: AgentNameMap | null | undefined): void {
    if (!written || !Object.keys(written).length) return;
    const metadata = this.registry.get(packId);
    if (metadata === null) return;
    const rawExistingSkills = metadata.registered_skills;
    let existingSkills: AgentNameMap;
    if (Array.isArray(rawExistingSkills) && rawExistingSkills.length) {
      const fallbackAgent = Object.keys(written)[0] ?? null;
      existingSkills = this.inferLegacySkillProvenance(
        rawExistingSkills.filter((n): n is string => typeof n === 'string'),
        packId,
        fallbackAgent as string,
      );
    } else {
      existingSkills = normalizeRegisteredSkills(rawExistingSkills);
    }
    const mergedSkills = deepCopy(existingSkills);
    let changed = Array.isArray(rawExistingSkills) && rawExistingSkills.length > 0;
    for (const [agentName, skillNames] of Object.entries(written)) {
      if (!skillNames || !skillNames.length) continue;
      const existingNames = mergedSkills[agentName] ?? [];
      const newNames = skillNames.filter((n) => !existingNames.includes(n));
      if (newNames.length) {
        mergedSkills[agentName] = [...existingNames, ...newNames];
        changed = true;
      }
    }
    if (changed) this.registry.update(packId, { registered_skills: mergedSkills });
  }

  /**
   * Re-register skills for commands whose winning layer changed.
   *
   * @param extraSkillsDirs Additional ``{skills_dir: [renderer_agent, names]}`` restored by unregisterSkills
   * @param targetAgent Report only command names written for this agent
   * @returns Command names whose skill output was successfully written
   */
  reconcileSkills(
    commandNames: string[],
    extraSkillsDirs: SkillDirProvenance | null = null,
    targetAgent: string | null = null,
  ): Set<string> {
    if (!commandNames.length) return new Set();

    const resolver = new PresetResolver(this.projectRoot);
    const activeSkillsDir = this.getSkillsDir();

    const initOpts = loadInitOptions(this.projectRoot);
    let activeAi: string | null = isMapping(initOpts) ? (initOpts.ai as string) : null;
    if (typeof activeAi !== 'string' || !activeAi) activeAi = null;

    const presetsByPriority = this.registry.listByPriority();

    const presetCmds = new Map<string, string[]>();
    const nonPresetSkills: Array<[string, string, { path: string; source: string }]> = [];
    const managedSkillNames = new Set<string>();
    const reconciledSkillCommands = new Set<string>();

    for (const cmdName of commandNames) {
      const layers = resolver.collectAllLayers(cmdName, 'command');
      if (!layers.length) continue;

      const [skillName, legacySkillName] = skillNamesForCommand(cmdName);
      const candidateSkillNames = new Set([skillName, legacySkillName]);
      for (const [, meta] of presetsByPriority) {
        if (!isMapping(meta)) continue;
        const recorded = 'registered_skills' in meta ? meta.registered_skills : [];
        const recordedNames = new Set<string>();
        if (isMapping(recorded)) {
          for (const names of Object.values(recorded)) {
            if (Array.isArray(names)) for (const n of names) recordedNames.add(n as string);
          }
        } else if (Array.isArray(recorded)) {
          for (const n of recorded) recordedNames.add(n as string);
        }
        for (const c of candidateSkillNames) if (recordedNames.has(c)) managedSkillNames.add(c);
      }

      const topPath = layers[0].path;
      let foundPreset = false;
      for (const [packId] of presetsByPriority) {
        const packDir = nodePath.join(this.presetsDir, packId);
        if (isRelativeTo(topPath, packDir)) {
          if (!presetCmds.has(packId)) presetCmds.set(packId, []);
          presetCmds.get(packId)!.push(cmdName);
          foundPreset = true;
          break;
        }
      }
      if (!foundPreset) nonPresetSkills.push([skillName, cmdName, layers[0]]);
    }

    const coreExtSkills = nonPresetSkills.filter((s) => s[2].source !== 'project override');
    const overrideSkills = nonPresetSkills.filter((s) => s[2].source === 'project override');

    const applyToDir = (
      skillsDir: string,
      dirAgent: string | null,
      isActive: boolean,
      managedNames: Set<string> | null = null,
    ): void => {
      const dirManagedNames = managedNames === null ? managedSkillNames : managedNames;
      const dirCoreExtNames: string[] = [];
      for (const [, cmdName] of coreExtSkills) {
        for (const candidate of skillNamesForCommand(cmdName)) {
          if (dirManagedNames.has(candidate)) dirCoreExtNames.push(candidate);
        }
      }
      if (dirCoreExtNames.length) {
        this.unregisterSkillsInDir(dirCoreExtNames, skillsDir, dirAgent, { restoreFromBundledCore: true });
      }

      for (const [, cmdName, topLayer] of overrideSkills) {
        const targetSkillNames = skillNamesForCommand(cmdName).filter((n) => dirManagedNames.has(n));
        if (!targetSkillNames.length) continue;
        try {
          const registrar = new CommandRegistrar();
          const content = readTextStrict(topLayer.path);
          const [fm, parsedBody] = parseFrontmatterWith(registrar, content);
          let body = parsedBody;
          let shortName = cmdName;
          if (shortName.startsWith('speckit.')) shortName = shortName.slice('speckit.'.length);
          const desc =
            (pyTruthy(fm.description) ? fm.description : '') ||
            SKILL_DESCRIPTIONS[shortName.replace(/\./g, '-')] ||
            `Command: ${shortName}`;
          const selectedAi = typeof dirAgent === 'string' ? dirAgent : '';
          if (selectedAi) {
            body = CommandRegistrar.resolveSkillPlaceholders(selectedAi, fm, body, this.projectRoot);
            body = PresetSkillMethods.resolveSkillCommandRefs(body, registrar, selectedAi, this.projectRoot);
          }
          const integration = selectedAi ? getIntegration(selectedAi) : null;
          const skillTitle = PresetSkillMethods.skillTitleFromCommand(cmdName);
          let wroteOverride = false;
          for (const targetSkillName of targetSkillNames) {
            const skillSubdir = nodePath.join(skillsDir, targetSkillName);
            if (!this.validateSkillSubdir(skillSubdir, { create: true, skillsRoot: skillsDir })) continue;
            const fmData = CommandRegistrar.buildSkillFrontmatter(selectedAi,
              targetSkillName,
              desc,
              `override:${cmdName}`,
            );
            CommandRegistrar.applyArgumentHint(fm, fmData, integration);
            const fmText = dumpFrontmatter(fmData);
            let skillContent = `---\n${fmText}\n---\n\n# Speckit ${skillTitle} Skill\n\n${body}\n`;
            if (integration !== null && integration !== undefined) {
              skillContent = postProcessSkill(integration, skillContent);
            }
            writeSharedText(skillsDir, nodePath.join(skillSubdir, 'SKILL.md'), skillContent);
            wroteOverride = true;
          }
          if (wroteOverride && (targetAgent === null || dirAgent === targetAgent)) {
            reconciledSkillCommands.add(cmdName);
          }
        } catch {
          // best-effort override skill restoration
        }
      }

      for (const [packId, cmds] of presetCmds) {
        const dirCmds = cmds.filter((cmd) => skillNamesForCommand(cmd).some((n) => dirManagedNames.has(n)));
        if (!dirCmds.length) continue;
        const packDir = nodePath.join(this.presetsDir, packId);
        const manifestPath = nodePath.join(packDir, 'preset.yml');
        if (!pathExists(manifestPath)) continue;
        let manifest: PresetManifest;
        try {
          manifest = new PresetManifest(manifestPath);
        } catch (e) {
          if (e instanceof PresetValidationError) continue;
          throw e;
        }
        const filtered = filteredManifest(manifest, new Set(dirCmds));
        for (const cmdName of dirCmds) {
          for (const skillName of skillNamesForCommand(cmdName)) {
            if (!dirManagedNames.has(skillName)) continue;
            const skillSubdir = nodePath.join(skillsDir, skillName);
            if (!this.validateSkillSubdir(skillSubdir, { create: true, skillsRoot: skillsDir })) continue;
          }
        }
        const written = isActive
          ? this.registerSkills(filtered, packDir)
          : this.registerSkills(filtered, packDir, { targetDir: skillsDir, targetAgent: dirAgent || '' });
        const writtenNames = new Set<string>();
        if (targetAgent === null) {
          for (const names of Object.values(written)) for (const n of names) writtenNames.add(n);
        } else {
          for (const n of written[targetAgent] ?? []) writtenNames.add(n);
        }
        for (const cmdName of dirCmds) {
          if (skillNamesForCommand(cmdName).some((n) => writtenNames.has(n))) reconciledSkillCommands.add(cmdName);
        }
        this.mergePackRegisteredSkills(packId, written);
      }
    };

    const extraDirs: SkillDirProvenance = extraSkillsDirs ?? new Map();
    if (activeSkillsDir) {
      const activeProvenance = extraDirs.get(activeSkillsDir);
      if (extraSkillsDirs === null || activeProvenance !== undefined) {
        applyToDir(activeSkillsDir, activeAi, true, activeProvenance ? new Set(activeProvenance[1]) : null);
      }
    }

    for (const [extraDir, [extraAgent, extraNames]] of extraDirs) {
      if (extraDir === activeSkillsDir) continue;
      applyToDir(extraDir, extraAgent, false, new Set(extraNames));
    }

    return reconciledSkillCommands;
  }

  /** Resolve the real skill output directory for an integration. */
  resolveAgentSkillsDir(agentName: string): string {
    const registrar = new CommandRegistrar();
    const agentConfig = registrarAgentConfigs()[agentName];
    if (agentConfig && agentConfig.extension === '/SKILL.md') {
      return resolveAgentDirWith(registrar, agentName, agentConfig, this.projectRoot);
    }
    return projectSkillsDir(this.projectRoot, agentName);
  }

  /** Return the trusted root containing a project or user skill dir. */
  skillsValidationRoot(skillsDir: string): string | null {
    for (const root of [this.projectRoot, userHome()]) {
      if (isRelativeTo(skillsDir, root)) return root;
    }
    return null;
  }

  /**
   * Return the active skills directory for preset skill overrides, or null
   * (instead of raising) when it cannot be resolved safely.
   */
  getSkillsDir(): string | null {
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

    const opts = loadInitOptions(this.projectRoot);
    const selectedAi = isMapping(opts) ? opts.ai : null;
    if (typeof selectedAi !== 'string' || !selectedAi) return skillsDir;

    const agentSkillsDir = this.resolveAgentSkillsDir(selectedAi);
    if (nodePath.resolve(agentSkillsDir) === nodePath.resolve(skillsDir)) return skillsDir;

    const validationRoot = this.skillsValidationRoot(agentSkillsDir);
    if (validationRoot === null) {
      printCliWarning(
        'resolve',
        'skills directory',
        agentSkillsDir,
        new Error('skills directory is outside trusted roots'),
        { continuing: 'Continuing without skill registration.' },
      );
      return null;
    }
    try {
      ensureSafeSharedDirectory(validationRoot, agentSkillsDir, { context: 'preset skills directory' });
    } catch (exc) {
      printCliWarning('resolve', 'skills directory', agentSkillsDir, exc, {
        continuing: 'Continuing without skill registration.',
      });
      return null;
    }
    return agentSkillsDir;
  }

  /** Return the modern and legacy skill directory names for a command. */
  static skillNamesForCommand(cmdName: string): [string, string] {
    return skillNamesForCommand(cmdName);
  }

  /** Upstream-name alias of {@link skillNamesForCommand}. */
  static _skillNamesForCommand(cmdName: string): [string, string] {
    return skillNamesForCommand(cmdName);
  }

  /** Return a human-friendly title for a skill command name. */
  static skillTitleFromCommand(cmdName: string): string {
    let titleName = cmdName;
    if (titleName.startsWith('speckit.')) titleName = titleName.slice('speckit.'.length);
    return pyTitle(titleName.replace(/\./g, ' ').replace(/-/g, ' '));
  }

  /**
   * Render ``__SPECKIT_COMMAND_*__`` tokens in a skill body as agent-native
   * invocations (``/speckit-<cmd>``, ``$speckit-<cmd>``, ``/speckit.<cmd>`` …).
   */
  static resolveSkillCommandRefs(
    body: string,
    registrar: unknown,
    selectedAi: string,
    projectRoot: string | null = null,
  ): string {
    let separator: string | null = null;
    if (projectRoot !== null && typeof selectedAi === 'string') {
      try {
        const integration = getIntegration(selectedAi) as { invokeSeparatorForMode?: (b: boolean) => string } | null;
        if (integration !== null && integration !== undefined && typeof integration.invokeSeparatorForMode === 'function') {
          separator = integration.invokeSeparatorForMode(isAiSkillsEnabled(loadInitOptions(projectRoot)));
        }
      } catch {
        separator = null;
      }
    }
    if (separator === null || separator === undefined) {
      const cfg = registrarAgentConfigs()[selectedAi] ?? {};
      separator = ('invoke_separator' in cfg ? cfg.invoke_separator : '.') as string;
    }
    void registrar;
    const prefix = getInvocationPrefix(selectedAi, separator === '-');
    return IntegrationBase.resolveCommandRefs(body, separator, prefix);
  }

  /** Index extension-backed skill restore data by skill directory name. */
  buildExtensionSkillRestoreIndex(): Map<string, Dict> {
    const resolver = new PresetResolver(this.projectRoot);
    const extensionsDir = nodePath.join(this.projectRoot, '.specify', 'extensions');
    const restoreIndex = new Map<string, Dict>();

    for (const [, extId] of resolver.getAllExtensionsByPriority()) {
      const extDir = nodePath.join(extensionsDir, extId);
      const manifestPath = nodePath.join(extDir, 'extension.yml');
      if (!isFile(manifestPath)) continue;
      let manifest: ExtensionManifest;
      try {
        manifest = new ExtensionManifest(manifestPath);
      } catch (e) {
        if (isOsError(e)) throw e;
        continue;
      }
      const extRoot = resolveLoose(extDir);
      for (const cmdInfo of manifest.commands as Dict[]) {
        const cmdName = cmdInfo.name;
        const cmdFileRel = cmdInfo.file;
        if (typeof cmdName !== 'string' || typeof cmdFileRel !== 'string') continue;
        if (nodePath.isAbsolute(cmdFileRel)) continue;
        let sourceFile: string;
        try {
          sourceFile = resolveLoose(nodePath.join(extRoot, cmdFileRel));
          const rel = nodePath.relative(extRoot, sourceFile);
          if (rel.startsWith('..') || nodePath.isAbsolute(rel)) continue;
        } catch {
          continue;
        }
        if (!isFile(sourceFile)) continue;
        const extData = (manifest.data as Dict).extension as Dict;
        const restoreInfo: Dict = {
          command_name: cmdName,
          source_file: sourceFile,
          source: `extension:${manifest.id}`,
          author: isMapping(extData) ? extData.author : undefined,
          extension_id: manifest.id,
          extension_dir: extRoot,
        };
        if (restoreInfo.author === undefined) restoreInfo.author = null;
        const [modern, legacy] = skillNamesForCommand(cmdName);
        if (!restoreIndex.has(modern)) restoreIndex.set(modern, restoreInfo);
        if (legacy !== modern && !restoreIndex.has(legacy)) restoreIndex.set(legacy, restoreInfo);
      }
    }
    return restoreIndex;
  }

  /**
   * Generate SKILL.md files for preset command overrides (overwrites existing
   * skills; creates new ones for the active ai_skills agent).
   *
   * @returns ``{agent: [skill_name, ...]}`` for the agent skills were written for
   */
  registerSkills(
    manifest: ManifestLike,
    presetDir: string,
    opts: { targetDir?: string | null; targetAgent?: string | null } = {},
  ): AgentNameMap {
    const targetDir = opts.targetDir ?? null;
    const targetAgent = opts.targetAgent === undefined ? null : opts.targetAgent;
    const commandTemplates = manifest.templates.filter((t) => t.type === 'command');
    if (!commandTemplates.length) return {};

    const skillsDir = targetDir !== null ? targetDir : this.getSkillsDir();
    if (!skillsDir) return {};

    const resolver = new PresetResolver(this.projectRoot);

    let initOpts: unknown = loadInitOptions(this.projectRoot);
    if (!isMapping(initOpts)) initOpts = {};
    const selectedAi = targetAgent !== null ? targetAgent : (initOpts as Dict).ai;
    if (typeof selectedAi !== 'string' || !selectedAi) return {};
    const aiSkillsEnabled = targetAgent === null && isAiSkillsEnabled(initOpts as Dict);
    const registrar = new CommandRegistrar();
    const integration = getIntegration(selectedAi);
    const agentConfig = registrarAgentConfigs()[selectedAi] ?? {};
    const createMissingSkills = aiSkillsEnabled && agentConfig.extension !== '/SKILL.md';

    const written: string[] = [];

    for (const cmdTmpl of commandTemplates) {
      const cmdName = cmdTmpl.name;
      const cmdFileRel = cmdTmpl.file;
      let sourceFile = nodePath.join(presetDir, cmdFileRel);
      if (!pathExists(sourceFile)) continue;

      const composedFile = nodePath.join(presetDir, '.composed', `${cmdName}.md`);
      if (pathExists(composedFile)) sourceFile = composedFile;

      let rawShortName = cmdName;
      if (rawShortName.startsWith('speckit.')) rawShortName = rawShortName.slice('speckit.'.length);
      const shortName = rawShortName.replace(/\./g, '-');
      const [skillName, legacySkillName] = skillNamesForCommand(cmdName);
      const skillTitle = PresetSkillMethods.skillTitleFromCommand(cmdName);

      const targetSkillNames: string[] = [];
      if (isDir(nodePath.join(skillsDir, skillName))) targetSkillNames.push(skillName);
      if (legacySkillName !== skillName && isDir(nodePath.join(skillsDir, legacySkillName))) {
        targetSkillNames.push(legacySkillName);
      }
      if (!targetSkillNames.length && createMissingSkills) {
        if (!pathExists(nodePath.join(skillsDir, skillName))) targetSkillNames.push(skillName);
      }
      if (!targetSkillNames.length) continue;

      const content = readTextStrict(sourceFile);
      let [frontmatter, body] = parseFrontmatterWith(registrar, content);

      const effectiveStrategy =
        (pyTruthy(cmdTmpl.strategy) ? cmdTmpl.strategy : null) ||
        (pyTruthy(frontmatter.strategy) ? frontmatter.strategy : null) ||
        'replace';
      if (
        effectiveStrategy !== 'replace' &&
        !pathExists(composedFile) &&
        resolver.resolveContent(cmdName, 'command') === null
      ) {
        continue;
      }

      if (frontmatter.strategy === 'wrap') {
        let coreFrontmatter: Dict;
        [body, coreFrontmatter] = substituteCoreTemplate(body, cmdName, this.projectRoot, registrar);
        frontmatter = { ...frontmatter };
        for (const key of ['scripts', 'agent_scripts', 'argument-hint']) {
          if (!(key in frontmatter) && key in coreFrontmatter) frontmatter[key] = coreFrontmatter[key];
        }
      }

      const originalDesc = 'description' in frontmatter ? frontmatter.description : '';
      const enhancedDesc =
        (pyTruthy(originalDesc) ? originalDesc : '') ||
        SKILL_DESCRIPTIONS[shortName] ||
        `Spec-kit workflow command: ${shortName}`;
      frontmatter = { ...frontmatter, description: enhancedDesc };
      body = CommandRegistrar.resolveSkillPlaceholders(selectedAi, frontmatter, body, this.projectRoot);
      body = PresetSkillMethods.resolveSkillCommandRefs(body, registrar, selectedAi, this.projectRoot);

      for (const targetSkillName of targetSkillNames) {
        const skillSubdir = nodePath.join(skillsDir, targetSkillName);
        if (pathExists(skillSubdir) && !isDir(skillSubdir)) continue;
        if (!this.validateSkillSubdir(skillSubdir, { create: true, skillsRoot: skillsDir })) continue;
        const frontmatterData = CommandRegistrar.buildSkillFrontmatter(selectedAi,
          targetSkillName,
          enhancedDesc,
          `preset:${manifest.id}`,
        );
        CommandRegistrar.applyArgumentHint(frontmatter, frontmatterData, integration);
        const frontmatterText = dumpFrontmatter(frontmatterData);
        let skillContent = `---\n${frontmatterText}\n---\n\n# Speckit ${skillTitle} Skill\n\n${body}\n`;
        if (integration !== null && integration !== undefined) {
          skillContent = postProcessSkill(integration, skillContent);
        }
        writeSharedText(skillsDir, nodePath.join(skillSubdir, 'SKILL.md'), skillContent);
        written.push(targetSkillName);
        this.mergePackRegisteredSkills(manifest.id, { [selectedAi]: [targetSkillName] });
      }
    }

    return written.length ? { [selectedAi]: written } : {};
  }

  /**
   * Infer per-agent ownership of a legacy flat-list ``registered_skills``
   * value from on-disk ``metadata.source == "preset:<pack_id>"`` markers.
   */
  inferLegacySkillProvenance(skillNames: string[], packId: string, fallbackAgent: string): AgentNameMap {
    const registrar = new CommandRegistrar();
    const candidateAgents = Object.keys(registrarAgentConfigs()).sort();

    const dirToAgents = new Map<string, string[]>();
    for (const agentName of candidateAgents) {
      const skillsDir = this.safeSkillsDirForAgent(agentName);
      if (skillsDir === null) continue;
      if (!isRelativeTo(nodePath.resolve(skillsDir), nodePath.resolve(this.projectRoot))) continue;
      const key = nodePath.resolve(skillsDir);
      if (!dirToAgents.has(key)) dirToAgents.set(key, []);
      dirToAgents.get(key)!.push(agentName);
    }

    const marker = `preset:${packId}`;
    const safeSkillNames = skillNames.filter((n) => PresetSkillMethods.isSafeRegistrySkillName(n));
    const inferred: AgentNameMap = {};
    const matchedNames = new Set<string>();
    for (const [resolvedDir, agents] of dirToAgents) {
      const canonicalAgent = fallbackAgent && agents.includes(fallbackAgent) ? fallbackAgent : [...agents].sort()[0];
      for (const name of safeSkillNames) {
        const skillSubdir = nodePath.join(resolvedDir, name);
        if (!this.validateSkillSubdir(skillSubdir, { create: false, skillsRoot: resolvedDir })) continue;
        const skillFile = nodePath.join(skillSubdir, 'SKILL.md');
        if (!isFile(skillFile)) continue;
        let content: string;
        try {
          content = readTextStrict(skillFile);
        } catch {
          continue;
        }
        const [frontmatter] = parseFrontmatterWith(registrar, content);
        const skillMetadata = frontmatter.metadata;
        const source = isMapping(skillMetadata) ? skillMetadata.source : null;
        if (source === marker) {
          if (!inferred[canonicalAgent]) inferred[canonicalAgent] = [];
          inferred[canonicalAgent].push(name);
          matchedNames.add(name);
        }
      }
    }

    const unmatched = safeSkillNames.filter((n) => !matchedNames.has(n));
    if (unmatched.length && fallbackAgent) {
      if (!inferred[fallbackAgent]) inferred[fallbackAgent] = [];
      const fallbackNames = inferred[fallbackAgent];
      for (const name of unmatched) if (!fallbackNames.includes(name)) fallbackNames.push(name);
    }
    return inferred;
  }

  /** Normalize a ``registered_skills`` registry value to per-agent form. */
  static normalizeRegisteredSkills(value: unknown, fallbackAgent: string | null = null): AgentNameMap {
    return normalizeRegisteredSkills(value, fallbackAgent);
  }

  /** Resolve ``agentName``'s skills directory, validated for safety (null when unsafe/missing). */
  safeSkillsDirForAgent(agentName: string): string | null {
    if (!(agentName in registrarAgentConfigs())) return null;
    const skillsDir = this.resolveAgentSkillsDir(agentName);
    const validationRoot = this.skillsValidationRoot(skillsDir);
    if (validationRoot === null) return null;
    try {
      ensureSafeSharedDirectory(validationRoot, skillsDir, { create: false, context: 'preset skills directory' });
    } catch {
      return null;
    }
    return skillsDir;
  }

  /** Validate a registry-provided skill name is a single safe path component. */
  static isSafeRegistrySkillName(name: unknown): boolean {
    if (typeof name !== 'string' || !name) return false;
    if (name === '.' || name === '..') return false;
    if (nodePath.isAbsolute(name) || nodePath.posix.isAbsolute(name) || nodePath.win32.isAbsolute(name)) return false;
    if (name.includes('/') || (process.platform === 'win32' && name.includes('\\'))) return false;
    if (nodePath.basename(name) !== name) return false;
    return true;
  }

  /**
   * Validate a single skill's subdirectory is symlink-free (creating it when
   * ``create``). Returns false instead of raising.
   */
  validateSkillSubdir(skillSubdir: string, opts: { create: boolean; skillsRoot?: string | null }): boolean {
    const validationRoot = opts.skillsRoot || this.projectRoot;
    if (isSymlink(validationRoot)) return false;
    try {
      if (opts.create) {
        ensureSafeSharedDirectory(validationRoot, skillSubdir, { create: true, context: 'preset skill directory' });
      } else {
        validateSafeSharedDirectory(validationRoot, skillSubdir);
      }
    } catch {
      return false;
    }
    return true;
  }

  /**
   * Restore original SKILL.md files after a preset is removed (core template,
   * then extension command, else delete the skill).
   *
   * @returns ``{skills_dir: [renderer_agent, mutated_names]}``
   */
  unregisterSkills(
    registeredSkills: AgentNameMap | string[],
    presetDir: string,
    opts: { additionalOwnedSources?: Record<string, string> | null; restoreFromBundledCore?: boolean } = {},
  ): SkillDirProvenance {
    const restored: SkillDirProvenance = new Map();
    if (
      !registeredSkills ||
      (Array.isArray(registeredSkills) ? !registeredSkills.length : !Object.keys(registeredSkills).length)
    ) {
      return restored;
    }
    const packId = nodePath.basename(presetDir);
    const additionalOwnedSources = opts.additionalOwnedSources ?? null;
    const restoreFromBundledCore = opts.restoreFromBundledCore ?? false;

    if (!Array.isArray(registeredSkills)) {
      const initOpts = loadInitOptions(this.projectRoot);
      let activeAgent: string | null = isMapping(initOpts) ? (initOpts.ai as string) : null;
      if (typeof activeAgent !== 'string' || !activeAgent) activeAgent = null;

      const groups = new Map<string, { agents: string[]; names: string[] }>();
      for (const [agentName, skillNames] of Object.entries(registeredSkills)) {
        if (!skillNames || !(skillNames as unknown[]).length) continue;
        const skillsDir = this.safeSkillsDirForAgent(agentName);
        if (skillsDir === null) continue;
        const key = skillsDir;
        if (!groups.has(key)) groups.set(key, { agents: [], names: [] });
        const group = groups.get(key)!;
        group.agents.push(agentName);
        for (const name of skillNames) {
          if (PresetSkillMethods.isSafeRegistrySkillName(name) && !group.names.includes(name)) group.names.push(name);
        }
      }

      for (const [skillsDir, group] of groups) {
        const rendererAgent =
          activeAgent !== null && group.agents.includes(activeAgent) ? activeAgent : [...group.agents].sort()[0];
        const mutatedNames = this.unregisterSkillsInDir(group.names, skillsDir, rendererAgent, {
          packId,
          additionalOwnedSources,
          restoreFromBundledCore,
        });
        if (mutatedNames.length) restored.set(skillsDir, [rendererAgent, mutatedNames]);
      }
      return restored;
    }

    const skillsDir = this.getSkillsDir();
    if (!skillsDir) return restored;
    let initOpts: unknown = loadInitOptions(this.projectRoot);
    if (!isMapping(initOpts)) initOpts = {};
    const rawAi = (initOpts as Dict).ai;
    const selectedAi = typeof rawAi === 'string' ? rawAi : null;
    const safeNames = registeredSkills.filter((n) => PresetSkillMethods.isSafeRegistrySkillName(n));
    const mutatedNames = this.unregisterSkillsInDir(safeNames, skillsDir, selectedAi, {
      packId,
      additionalOwnedSources,
      restoreFromBundledCore,
    });
    if (mutatedNames.length) restored.set(skillsDir, [selectedAi, mutatedNames]);
    return restored;
  }

  /** Delete still-preset-owned skills when an agent is deactivated. */
  deleteAgentPresetSkills(agentName: string, skillNames: string[], packId: string): void {
    const skillsDir = this.safeSkillsDirForAgent(agentName);
    if (skillsDir === null) return;

    const registrar = new CommandRegistrar();
    const marker = `preset:${packId}`;
    const overrideSources: Record<string, string> = {};
    const manifest = new PresetResolver(this.projectRoot).getManifest(nodePath.join(this.presetsDir, packId));
    if (manifest !== null) {
      for (const template of manifest.templates) {
        const commandName = template.name;
        if (template.type === 'command' && typeof commandName === 'string') {
          for (const skillName of skillNamesForCommand(commandName)) {
            overrideSources[skillName] = `override:${commandName}`;
          }
        }
      }
    }
    for (const skillName of skillNames) {
      if (!PresetSkillMethods.isSafeRegistrySkillName(skillName)) continue;
      const skillSubdir = nodePath.join(skillsDir, skillName);
      if (!this.validateSkillSubdir(skillSubdir, { create: false, skillsRoot: skillsDir })) continue;
      const skillFile = nodePath.join(skillSubdir, 'SKILL.md');
      if (!isFile(skillFile)) continue;
      let content: string;
      try {
        content = readTextStrict(skillFile);
      } catch {
        continue;
      }
      const [frontmatter] = parseFrontmatterWith(registrar, content);
      const metadata = frontmatter.metadata;
      const source = isMapping(metadata) ? metadata.source : null;
      const ownedSources = new Set([marker]);
      const overrideSource = overrideSources[skillName];
      if (overrideSource) ownedSources.add(overrideSource);
      if (typeof source === 'string' && ownedSources.has(source)) rmSync(skillSubdir, { recursive: true, force: true });
    }
  }

  /** Warn that a skill kept preset content because its restore source is unreadable. */
  static warnUnrestoredSkill(skillName: string, sourceFile: string, exc: unknown): void {
    const e = exc as Error;
    const excName = exc instanceof UnicodeDecodeError ? 'UnicodeDecodeError' : osExcName(exc);
    presetWarn(
      `Skill '${skillName}' still contains the removed preset's content: ` +
        `its restore source '${sourceFile}' could not be read ` +
        `(${excName}: ${e?.message ?? String(exc)}). The skill was left in place ` +
        `rather than deleted. Fix or remove that file and re-run ` +
        `'specify preset add'/'specify preset remove' to refresh it.`,
    );
  }

  /**
   * Restore original SKILL.md files within a single skills directory.
   *
   * @returns Skill names whose files were restored or removed
   */
  unregisterSkillsInDir(
    skillNames: string[],
    skillsDir: string,
    selectedAi: string | null,
    opts: {
      packId?: string | null;
      additionalOwnedSources?: Record<string, string> | null;
      restoreFromBundledCore?: boolean;
    } = {},
  ): string[] {
    const packId = opts.packId ?? null;
    const additionalOwnedSources = opts.additionalOwnedSources ?? null;
    const restoreFromBundledCore = opts.restoreFromBundledCore ?? false;

    const coreTemplatesDir = nodePath.join(this.projectRoot, '.specify', 'templates', 'commands');
    const registrar = new CommandRegistrar();
    const integration = typeof selectedAi === 'string' ? getIntegration(selectedAi) : null;
    const extensionRestoreIndex = this.buildExtensionSkillRestoreIndex();
    const mutatedNames: string[] = [];

    for (const skillName of skillNames) {
      if (!PresetSkillMethods.isSafeRegistrySkillName(skillName)) continue;

      let shortName = skillName;
      if (shortName.startsWith('speckit-')) shortName = shortName.slice('speckit-'.length);
      else if (shortName.startsWith('speckit.')) shortName = shortName.slice('speckit.'.length);

      const skillSubdir = nodePath.join(skillsDir, skillName);
      const skillFile = nodePath.join(skillSubdir, 'SKILL.md');
      if (!isDir(skillSubdir)) continue;
      if (!this.validateSkillSubdir(skillSubdir, { create: false, skillsRoot: skillsDir })) continue;
      if (!isFile(skillFile)) continue;
      if (packId !== null) {
        let currentContent: string;
        try {
          currentContent = readTextStrict(skillFile);
        } catch {
          continue;
        }
        const [currentFrontmatter] = parseFrontmatterWith(registrar, currentContent);
        const currentMetadata = currentFrontmatter.metadata;
        const currentSource = isMapping(currentMetadata) ? currentMetadata.source : null;
        const ownedSources = new Set([`preset:${packId}`]);
        if (additionalOwnedSources) {
          const additional = additionalOwnedSources[skillName];
          if (additional) ownedSources.add(additional);
        }
        if (typeof currentSource !== 'string' || !ownedSources.has(currentSource)) continue;
      }

      const extensionRestore = extensionRestoreIndex.get(skillName) ?? null;

      let coreFile: string | null = nodePath.join(coreTemplatesDir, `${shortName}.md`);
      if (!pathExists(coreFile) && restoreFromBundledCore && extensionRestore === null) {
        const corePack = locateCorePack();
        coreFile =
          corePack !== null
            ? nodePath.join(corePack, 'commands', `${shortName}.md`)
            : nodePath.join(repoRoot(), 'templates', 'commands', `${shortName}.md`);
      }
      if (!pathExists(coreFile)) coreFile = null;

      if (coreFile) {
        let content: string;
        try {
          content = readTextStrict(coreFile);
        } catch (exc) {
          if (exc instanceof UnicodeDecodeError || isOsError(exc)) {
            PresetSkillMethods.warnUnrestoredSkill(skillName, coreFile, exc);
            continue;
          }
          throw exc;
        }
        let [frontmatter, body] = parseFrontmatterWith(registrar, content);
        if (typeof selectedAi === 'string') {
          body = CommandRegistrar.resolveSkillPlaceholders(selectedAi, frontmatter, body, this.projectRoot);
          body = PresetSkillMethods.resolveSkillCommandRefs(body, registrar, selectedAi, this.projectRoot);
        }
        const originalDesc = 'description' in frontmatter ? frontmatter.description : '';
        const enhancedDesc =
          (pyTruthy(originalDesc) ? originalDesc : '') ||
          SKILL_DESCRIPTIONS[shortName] ||
          `Spec-kit workflow command: ${shortName}`;
        const frontmatterData = CommandRegistrar.buildSkillFrontmatter(typeof selectedAi === 'string' ? selectedAi : '',
          skillName,
          enhancedDesc,
          `templates/commands/${shortName}.md`,
        );
        CommandRegistrar.applyArgumentHint(frontmatter, frontmatterData, integration);
        const frontmatterText = dumpFrontmatter(frontmatterData);
        const skillTitle = PresetSkillMethods.skillTitleFromCommand(shortName);
        let skillContent = `---\n${frontmatterText}\n---\n\n# Speckit ${skillTitle} Skill\n\n${body}\n`;
        if (integration !== null && integration !== undefined) skillContent = postProcessSkill(integration, skillContent);
        writeSharedText(skillsDir, skillFile, skillContent);
        mutatedNames.push(skillName);
        continue;
      }

      if (extensionRestore) {
        let content: string;
        try {
          content = readTextStrict(extensionRestore.source_file);
        } catch (exc) {
          if (exc instanceof UnicodeDecodeError || isOsError(exc)) {
            PresetSkillMethods.warnUnrestoredSkill(skillName, extensionRestore.source_file, exc);
            continue;
          }
          throw exc;
        }
        let [frontmatter, body] = parseFrontmatterWith(registrar, content);
        body = CommandRegistrar.rewriteExtensionPaths(body,
          extensionRestore.extension_id,
          extensionRestore.extension_dir,
        );
        if (typeof selectedAi === 'string') {
          body = CommandRegistrar.resolveSkillPlaceholders(selectedAi, frontmatter, body, this.projectRoot);
          body = PresetSkillMethods.resolveSkillCommandRefs(body, registrar, selectedAi, this.projectRoot);
        }
        const commandName = extensionRestore.command_name as string;
        const titleName = PresetSkillMethods.skillTitleFromCommand(commandName);
        const frontmatterData = CommandRegistrar.buildSkillFrontmatter(typeof selectedAi === 'string' ? selectedAi : '',
          skillName,
          'description' in frontmatter ? frontmatter.description : `Extension command: ${commandName}`,
          extensionRestore.source,
          'author' in extensionRestore ? extensionRestore.author : 'github-spec-kit',
        );
        CommandRegistrar.applyArgumentHint(frontmatter, frontmatterData, integration);
        const frontmatterText = dumpFrontmatter(frontmatterData);
        let skillContent = `---\n${frontmatterText}\n---\n\n# ${titleName} Skill\n\n${body}\n`;
        if (integration !== null && integration !== undefined) skillContent = postProcessSkill(integration, skillContent);
        writeSharedText(skillsDir, skillFile, skillContent);
        mutatedNames.push(skillName);
      } else {
        rmSync(skillSubdir, { recursive: true, force: true });
        mutatedNames.push(skillName);
      }
    }

    return mutatedNames;
  }
}

function osExcName(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return 'FileNotFoundError';
  if (code === 'EACCES' || code === 'EPERM') return 'PermissionError';
  if (code === 'EISDIR') return 'IsADirectoryError';
  if (code) return 'OSError';
  return e instanceof Error ? e.name : 'Exception';
}
