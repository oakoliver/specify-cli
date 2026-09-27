/**
 * @oakoliver/specify-cli - Preset agent command registration and reconciliation
 *
 * Port of ``specify_cli/presets/_manager_commands.py``: the command-artifact
 * half of ``PresetManager`` (registration of preset command overrides with the
 * active agent, rescaffold on ``integration use``/``switch``, agent-scoped
 * cleanup, and priority-stack reconciliation of composed commands).
 *
 * In Python these methods live on the ``_PresetCommandMethods`` mixin. In the
 * TypeScript port the mixins form a linear chain:
 * ``PresetCommandMethods`` ← ``PresetSkillMethods`` ← ``PresetManager``.
 *
 * @module presets/manager-commands
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import { CommandRegistrar, type CommandInfo } from '../agents.js';
import { console } from '../console.js';
import { ExtensionManifest, ExtensionRegistry } from '../extensions/index.js';
import {
  MISSING_INIT_OPTIONS_FILE,
  isAiSkillsEnabled,
  loadInitOptions,
  resolveActiveAgentForRegistration,
} from '../init-options.js';
import {
  PresetManifest,
  UnicodeDecodeError,
  deepCopy,
  deepEqual,
  isDir,
  isFile,
  isMapping,
  isRelativeTo,
  pathExists,
  presetWarn,
  readTextStrict,
  type PresetTemplateEntry,
} from './manifest.js';
import type { PresetRegistry } from './registry.js';
import { PresetResolver, isOsError } from './resolver.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dict = Record<string, any>;

/** ``{agent_name: [name, ...]}`` */
export type AgentNameMap = Record<string, string[]>;

/** ``{skills_dir: [renderer_agent, managed_skill_names]}`` */
export type SkillDirProvenance = Map<string, [string | null, string[]]>;

// ============================================================================
// Registrar adapter
// ============================================================================

/** Agent configs of the shared ``CommandRegistrar`` (``AGENT_CONFIGS``). */
export function registrarAgentConfigs(): Record<string, Dict> {
  const R = CommandRegistrar as unknown as { AGENT_CONFIGS: Record<string, Dict>; ensureConfigs?: () => void };
  if (typeof R.ensureConfigs === 'function') R.ensureConfigs();
  return R.AGENT_CONFIGS ?? {};
}

/** Whether an agent's config renders native ``SKILL.md`` output. */
export function isNativeSkillAgentConfig(config: Dict | null | undefined): boolean {
  return !!config && config.extension === '/SKILL.md';
}

// ============================================================================
// CLI warning helpers (upstream ``specify_cli._print_cli_warning``)
// ============================================================================

/** Return a compact one-line exception detail for CLI output. */
export function cliErrorDetail(exc: unknown): string {
  const raw = exc instanceof Error ? exc.message : String(exc);
  const detail = raw.replace(/\n/g, ' ').trim();
  if (detail) return detail;
  return exc instanceof Error ? exc.name : 'Error';
}

/** Format a stable operation label for user-visible diagnostics. */
export function cliPhaseLabel(phase: string, targetKind: string, target: string | null = null): string {
  let label = `${phase} ${targetKind}`.trim();
  if (target) label = `${label} '${target}'`;
  return label;
}

/** Print a warning that names the failed CLI phase and target. */
export function printCliWarning(
  phase: string,
  targetKind: string,
  target: string | null,
  exc: unknown,
  opts: { continuing?: string | null } = {},
): void {
  const label = cliPhaseLabel(phase, targetKind, target);
  console.print(`[yellow]Warning:[/yellow] Failed to ${label}: ${cliErrorDetail(exc)}`);
  if (opts.continuing) console.print(`[dim]${opts.continuing}[/dim]`);
}

// ============================================================================
// Skill-name helpers shared by the command and skill halves
// ============================================================================

/** Return the modern and legacy skill directory names for a command. */
export function skillNamesForCommand(cmdName: string): [string, string] {
  let rawShortName = cmdName;
  if (rawShortName.startsWith('speckit.')) rawShortName = rawShortName.slice('speckit.'.length);
  const modern = `speckit-${rawShortName.replace(/\./g, '-')}`;
  const legacy = `speckit.${rawShortName}`;
  return [modern, legacy];
}

/** Normalize a ``registered_skills`` registry value to per-agent form. */
export function normalizeRegisteredSkills(value: unknown, fallbackAgent: string | null = null): AgentNameMap {
  if (isMapping(value)) {
    const out: AgentNameMap = {};
    for (const [agent, names] of Object.entries(value)) {
      if (Array.isArray(names)) out[agent] = [...names];
    }
    return out;
  }
  if (Array.isArray(value) && value.length && fallbackAgent) {
    return { [fallbackAgent]: value.filter((n): n is string => typeof n === 'string') };
  }
  return {};
}

// ============================================================================
// {CORE_TEMPLATE} substitution
// ============================================================================

/**
 * Substitute ``{CORE_TEMPLATE}`` with the body of the installed core command
 * template. Returns ``[body, coreFrontmatter]``; both are unchanged/empty when
 * the placeholder is absent or the core template is missing or unreadable.
 */
export function substituteCoreTemplate(
  body: string,
  cmdName: string,
  projectRoot: string,
  registrar: { parseFrontmatter(content: string): [Dict, string] } | typeof CommandRegistrar,
): [string, Dict] {
  if (!body.includes('{CORE_TEMPLATE}')) return [body, {}];

  let shortName = cmdName;
  if (shortName.startsWith('speckit.')) shortName = shortName.slice('speckit.'.length);

  const resolver = new PresetResolver(projectRoot);
  const coreFile =
    resolver.resolveCore(cmdName, 'command') ||
    resolver.resolveExtensionCommandViaManifest(cmdName) ||
    resolver.resolveCore(shortName, 'command');
  if (coreFile === null) return [body, {}];

  let coreContent: string;
  try {
    coreContent = readTextStrict(coreFile);
  } catch (exc) {
    if (exc instanceof UnicodeDecodeError || isOsError(exc)) {
      const e = exc as Error;
      presetWarn(
        `Ignoring core template for command '${cmdName}': could not read ` +
          `'${nodePath.basename(coreFile)}' (${pyExcName(e)}: ${e.message}).`,
      );
      return [body, {}];
    }
    throw exc;
  }

  const [coreFrontmatter, coreBody] = parseFrontmatterWith(registrar, coreContent);
  return [body.split('{CORE_TEMPLATE}').join(coreBody), coreFrontmatter];
}

/** Upstream-name alias of {@link substituteCoreTemplate}. */
export const _substituteCoreTemplate = substituteCoreTemplate;

function pyExcName(e: unknown): string {
  if (e instanceof UnicodeDecodeError) return 'UnicodeDecodeError';
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return 'FileNotFoundError';
  if (code === 'EACCES' || code === 'EPERM') return 'PermissionError';
  if (code === 'EISDIR') return 'IsADirectoryError';
  if (code) return 'OSError';
  return e instanceof Error ? e.name : 'Exception';
}

/** Call ``parse_frontmatter`` on a registrar instance or class. */
export function parseFrontmatterWith(registrar: unknown, content: string): [Dict, string] {
  const r = registrar as { parseFrontmatter?: (c: string) => [Dict, string] };
  if (r && typeof r.parseFrontmatter === 'function') return r.parseFrontmatter(content);
  return (CommandRegistrar as unknown as { parseFrontmatter(c: string): [Dict, string] }).parseFrontmatter(content);
}

// ============================================================================
// Command artifact methods
// ============================================================================

/** Command artifact methods shared through PresetManager's lifecycle state. */
export abstract class PresetCommandMethods {
  abstract readonly projectRoot: string;
  abstract readonly presetsDir: string;
  abstract readonly registry: PresetRegistry;

  // ---- Provided by PresetSkillMethods -------------------------------------
  abstract registerSkills(
    manifest: PresetManifest | { id: string; templates: PresetTemplateEntry[] },
    presetDir: string,
    opts?: { targetDir?: string | null; targetAgent?: string | null },
  ): AgentNameMap;
  abstract inferLegacySkillProvenance(skillNames: string[], packId: string, fallbackAgent: string): AgentNameMap;
  abstract unregisterSkills(
    registeredSkills: AgentNameMap | string[],
    presetDir: string,
    opts?: { additionalOwnedSources?: Record<string, string> | null; restoreFromBundledCore?: boolean },
  ): SkillDirProvenance;
  abstract reconcileSkills(
    commandNames: string[],
    extraSkillsDirs?: SkillDirProvenance | null,
    targetAgent?: string | null,
  ): Set<string>;
  abstract deleteAgentPresetSkills(agentName: string, skillNames: string[], packId: string): void;

  /**
   * Register preset command overrides with the active AI agent (all detected
   * agents for legacy projects without init-options).
   *
   * @returns Agent names → registered command names
   */
  registerCommands(manifest: PresetManifest, presetDir: string): AgentNameMap {
    const commandTemplates = manifest.templates.filter((t) => t.type === 'command');
    if (!commandTemplates.length) return {};

    const resolver = new PresetResolver(this.projectRoot);
    let composedDir: string | null = null;
    const commandsToRegister: Dict[] = [];
    for (const cmd of commandTemplates) {
      const strategy = ('strategy' in cmd ? cmd.strategy : 'replace') as string;
      if (strategy !== 'replace') {
        const layers = resolver.collectAllLayers(cmd.name, 'command');
        const topLayerIsOurs = layers.length > 0 && isRelativeTo(layers[0].path, presetDir);
        if (topLayerIsOurs) {
          const composed = resolver.resolveContent(cmd.name, 'command');
          if (composed !== null) {
            if (composedDir === null) {
              composedDir = nodePath.join(presetDir, '.composed');
              mkdirSync(composedDir, { recursive: true });
            }
            writeFileSync(nodePath.join(composedDir, `${cmd.name}.md`), composed, 'utf-8');
            commandsToRegister.push({ ...cmd, file: `.composed/${cmd.name}.md` });
          } else {
            presetWarn(
              `Command '${cmd.name}' uses '${strategy}' ` +
                `strategy but no base command layer exists to ` +
                `compose onto; skipping. Provide a lower-priority ` +
                `preset, extension, or core command for it before ` +
                `using composition strategies.`,
            );
            continue;
          }
        } else {
          commandsToRegister.push(cmd);
        }
      } else {
        commandsToRegister.push(cmd);
      }
    }

    const registrar = new CommandRegistrar();

    const resolvedAgent = resolveActiveAgentForRegistration(this.projectRoot);
    let activeAgent: string | null;
    if (resolvedAgent === MISSING_INIT_OPTIONS_FILE) {
      activeAgent = null;
    } else if (resolvedAgent === null || resolvedAgent === undefined) {
      return {};
    } else {
      activeAgent = resolvedAgent as string;
      const initOptions = loadInitOptions(this.projectRoot);
      const agentConfig = registrarAgentConfigs()[activeAgent];
      if (agentConfig && isAiSkillsEnabled(initOptions) && agentConfig.extension !== '/SKILL.md') {
        return {};
      }
    }

    return registrar.registerCommandsForAllAgents(commandsToRegister as CommandInfo[], manifest.id, presetDir, this.projectRoot, {
      createMissingActiveSkillsDir: true,
      onlyAgent: activeAgent,
    }) as AgentNameMap;
  }

  /**
   * Re-register enabled presets' command overrides and skills for
   * ``agentName`` (used by ``integration use`` / ``switch``). Presets are
   * processed lowest-precedence first so the highest-precedence one wins.
   */
  registerEnabledPresetsForAgent(agentName: string): void {
    if (!agentName) return;

    const agentConfig = registrarAgentConfigs()[agentName] ?? null;
    const isCommandBacked = !!agentConfig && agentConfig.extension !== '/SKILL.md';
    const aiSkillsNow = isCommandBacked && isAiSkillsEnabled(loadInitOptions(this.projectRoot));

    const resolver = new PresetResolver(this.projectRoot);
    const affectedCmdNames = new Set<string>();
    const presetsByPriority = this.registry.listByPriority();
    const winningPackByCommand = new Map<string, string>();
    const winningSourceByCommand = new Map<string, string>();
    const projectOverrideCommands = new Set<string>();
    for (const [candidatePackId] of presetsByPriority) {
      const candidateManifest = resolver.getManifest(nodePath.join(this.presetsDir, candidatePackId));
      if (candidateManifest === null) continue;
      for (const template of candidateManifest.templates) {
        const commandName = template.name;
        if (template.type === 'command' && typeof commandName === 'string') {
          if (isFile(nodePath.join(resolver.overridesDir, `${commandName}.md`))) {
            projectOverrideCommands.add(commandName);
          }
          if (!winningPackByCommand.has(commandName)) winningPackByCommand.set(commandName, candidatePackId);
          const sourceFile = template.file;
          if (typeof sourceFile === 'string' && !winningSourceByCommand.has(commandName)) {
            winningSourceByCommand.set(commandName, nodePath.join(this.presetsDir, candidatePackId, sourceFile));
          }
        }
      }
    }

    const pendingCommandCleanups: Array<[string, AgentNameMap, string[], Record<string, string>]> = [];
    const successfulSkillReplacements = new Set<string>();
    const pendingSkillCleanups: Array<[string, string, AgentNameMap, string[], Record<string, string>]> = [];
    const successfulCommandReplacements = new Set<string>();
    const pairKey = (a: string, b: string) => JSON.stringify([a, b]);

    for (const [packId, metadata] of [...presetsByPriority].reverse()) {
      const packDir = nodePath.join(this.presetsDir, packId);
      const manifest = resolver.getManifest(packDir);
      if (manifest === null) continue;

      for (const tmpl of manifest.templates) {
        if (tmpl.type === 'command' && typeof tmpl.name === 'string') affectedCmdNames.add(tmpl.name);
      }

      try {
        const registeredCommands = this.registerCommands(manifest, packDir);
        const registeredCommandNames = new Set(registeredCommands[agentName] ?? []);
        for (const tmpl of manifest.templates) {
          if (tmpl.type !== 'command') continue;
          const primaryName = tmpl.name;
          if (typeof primaryName === 'string' && registeredCommandNames.has(primaryName)) {
            successfulCommandReplacements.add(pairKey(packId, primaryName));
          }
        }
        let existingCommands: unknown = 'registered_commands' in metadata ? metadata.registered_commands : {};
        if (!isMapping(existingCommands)) existingCommands = {};
        const mergedCommands = deepCopy(existingCommands) as AgentNameMap;
        let staleCommandNames: string[] | null = null;
        if (registeredCommands[agentName]?.length) {
          const existingNames = mergedCommands[agentName] ?? [];
          mergedCommands[agentName] = [
            ...existingNames,
            ...registeredCommands[agentName].filter((name) => !existingNames.includes(name)),
          ];
        } else if (aiSkillsNow && mergedCommands[agentName]?.length) {
          staleCommandNames = mergedCommands[agentName];
        }
        if (!deepEqual(mergedCommands, existingCommands)) {
          this.registry.update(packId, { registered_commands: mergedCommands });
        }

        const registeredSkills = this.registerSkills(manifest, packDir);
        const replacedSkillNames = new Set(registeredSkills[agentName] ?? []);
        for (const tmpl of manifest.templates) {
          if (tmpl.type !== 'command') continue;
          const primaryName = tmpl.name;
          if (typeof primaryName !== 'string') continue;
          const [modernName, legacyName] = skillNamesForCommand(primaryName);
          if (replacedSkillNames.has(modernName) || replacedSkillNames.has(legacyName)) {
            successfulSkillReplacements.add(pairKey(packId, primaryName));
          }
        }
        const rawExistingSkills = metadata.registered_skills;
        let existingSkills: AgentNameMap;
        if (Array.isArray(rawExistingSkills) && rawExistingSkills.length) {
          existingSkills = this.inferLegacySkillProvenance(
            rawExistingSkills.filter((n): n is string => typeof n === 'string'),
            packId,
            agentName,
          );
        } else {
          existingSkills = normalizeRegisteredSkills(rawExistingSkills, agentName);
        }
        const mergedSkills = deepCopy(existingSkills);
        if (registeredSkills[agentName]?.length) {
          const existingNames = mergedSkills[agentName] ?? [];
          mergedSkills[agentName] = [
            ...existingNames,
            ...registeredSkills[agentName].filter((name) => !existingNames.includes(name)),
          ];
        } else if (isCommandBacked && !aiSkillsNow && mergedSkills[agentName]?.length) {
          const staleSkillNames = mergedSkills[agentName];
          const skillToPrimary: Record<string, string> = {};
          for (const tmpl of manifest.templates) {
            if (tmpl.type !== 'command') continue;
            const primaryName = tmpl.name;
            if (typeof primaryName !== 'string') continue;
            const [modernName, legacyName] = skillNamesForCommand(primaryName);
            skillToPrimary[modernName] = primaryName;
            skillToPrimary[legacyName] = primaryName;
          }
          pendingSkillCleanups.push([packId, packDir, mergedSkills, staleSkillNames, skillToPrimary]);
        }
        const needsMigration = Array.isArray(rawExistingSkills) && rawExistingSkills.length > 0;
        if (!deepEqual(mergedSkills, existingSkills) || needsMigration) {
          this.registry.update(packId, { registered_skills: mergedSkills });
        }

        if (staleCommandNames && staleCommandNames.length) {
          const aliasToPrimary: Record<string, string> = {};
          for (const tmpl of manifest.templates) {
            if (tmpl.type !== 'command') continue;
            const primaryName = tmpl.name;
            if (typeof primaryName !== 'string') continue;
            const aliases = 'aliases' in tmpl ? tmpl.aliases : [];
            for (const alias of Array.isArray(aliases) ? aliases : []) {
              if (typeof alias === 'string') aliasToPrimary[alias] = primaryName;
            }
          }
          pendingCommandCleanups.push([packId, mergedCommands, staleCommandNames, aliasToPrimary]);
        }
      } catch (packErr) {
        printCliWarning('register preset artifacts for', 'preset', packId, packErr, {
          continuing: 'Continuing with the remaining presets.',
        });
        continue;
      }
    }

    let reconciledCommands = new Set<string>();
    let reconciledSkills = new Set<string>();
    if (affectedCmdNames.size) {
      try {
        reconciledCommands = this.reconcileComposedCommands([...affectedCmdNames], null, agentName);
        reconciledSkills = this.reconcileSkills([...affectedCmdNames], null, agentName);
      } catch (exc) {
        presetWarn(
          `Post-rescaffold reconciliation failed for '${agentName}': ` +
            `${exc instanceof Error ? exc.message : String(exc)}. Agent command files may be stale; re-run ` +
            `'specify integration use ${agentName}' or reinstall ` +
            `affected presets to refresh.`,
        );
      }
    }

    const successfullyReplacedWinners = new Set<string>();
    for (const [commandName, winningPackId] of winningPackByCommand) {
      if (projectOverrideCommands.has(commandName)) continue;
      if (
        successfulSkillReplacements.has(pairKey(winningPackId, commandName)) ||
        (reconciledSkills.has(commandName) &&
          winningSourceByCommand.has(commandName) &&
          isFile(winningSourceByCommand.get(commandName)!))
      ) {
        successfullyReplacedWinners.add(commandName);
      }
    }
    for (const name of projectOverrideCommands) {
      if (reconciledSkills.has(name)) successfullyReplacedWinners.add(name);
    }

    for (const [packId, mergedCommands, staleCommandNames, aliasToPrimary] of pendingCommandCleanups) {
      const fullyReplaced = staleCommandNames.filter((commandName) =>
        successfullyReplacedWinners.has(aliasToPrimary[commandName] ?? commandName),
      );
      if (!fullyReplaced.length) continue;
      const remainingStale = staleCommandNames.filter((n) => !fullyReplaced.includes(n));
      this.unregisterCommands({ [agentName]: fullyReplaced });
      if (remainingStale.length) mergedCommands[agentName] = remainingStale;
      else delete mergedCommands[agentName];
      this.registry.update(packId, { registered_commands: mergedCommands });
    }

    const successfullyReplacedCommandWinners = new Set<string>();
    for (const [commandName, winningPackId] of winningPackByCommand) {
      if (projectOverrideCommands.has(commandName)) continue;
      if (
        successfulCommandReplacements.has(pairKey(winningPackId, commandName)) ||
        (reconciledCommands.has(commandName) &&
          winningSourceByCommand.has(commandName) &&
          isFile(winningSourceByCommand.get(commandName)!))
      ) {
        successfullyReplacedCommandWinners.add(commandName);
      }
    }
    for (const name of projectOverrideCommands) {
      if (reconciledCommands.has(name)) successfullyReplacedCommandWinners.add(name);
    }

    for (const [packId, packDir, mergedSkills, staleSkillNames, skillToPrimary] of [
      ...pendingSkillCleanups,
    ].reverse()) {
      const fullyReplaced = staleSkillNames.filter((skillName) => {
        const primary = skillToPrimary[skillName];
        return primary !== undefined && successfullyReplacedCommandWinners.has(primary);
      });
      if (!fullyReplaced.length) continue;
      const remainingStale = staleSkillNames.filter((n) => !fullyReplaced.includes(n));
      const overrideSources: Record<string, string> = {};
      for (const skillName of fullyReplaced) {
        if (skillName in skillToPrimary) overrideSources[skillName] = `override:${skillToPrimary[skillName]}`;
      }
      this.unregisterSkills({ [agentName]: fullyReplaced }, packDir, {
        additionalOwnedSources: overrideSources,
      });
      if (remainingStale.length) mergedSkills[agentName] = remainingStale;
      else delete mergedSkills[agentName];
      this.registry.update(packId, { registered_skills: mergedSkills });
    }
  }

  /**
   * Remove ``agentName``'s tracked preset command/skill artifacts (used by
   * ``integration switch`` when deactivating the previous integration).
   * Scoped strictly to ``agentName``; no priority-stack reconciliation runs.
   */
  unregisterAgentArtifacts(agentName: string): void {
    if (!agentName) return;

    const registrar = new CommandRegistrar();
    const agentConfig = registrarAgentConfigs()[agentName];
    if (agentConfig === undefined || agentConfig === null) return;

    for (const [packId, metadata] of Object.entries(this.registry.list())) {
      const updates: Dict = {};

      const rawSkills = 'registered_skills' in metadata ? metadata.registered_skills : [];
      let registeredSkillsAll: AgentNameMap;
      let skillsMigrated: boolean;
      if (Array.isArray(rawSkills) && rawSkills.length) {
        registeredSkillsAll = this.inferLegacySkillProvenance(
          rawSkills.filter((n): n is string => typeof n === 'string'),
          packId,
          agentName,
        );
        skillsMigrated = true;
      } else if (isMapping(rawSkills)) {
        registeredSkillsAll = deepCopy(rawSkills) as AgentNameMap;
        skillsMigrated = false;
      } else {
        registeredSkillsAll = {};
        skillsMigrated = false;
      }

      let registeredCommands: unknown = 'registered_commands' in metadata ? metadata.registered_commands : {};
      if (!isMapping(registeredCommands)) registeredCommands = {};
      const regCommands = registeredCommands as Record<string, unknown>;

      const rawAgentNames = regCommands[agentName];
      const agentCommandNames = (Array.isArray(rawAgentNames) ? rawAgentNames : []).filter(
        (n): n is string => typeof n === 'string',
      );

      let nativeSkillsEntryRemoved = false;
      if (agentCommandNames.length && agentConfig.extension === '/SKILL.md') {
        nativeSkillsEntryRemoved = agentName in registeredSkillsAll;
        delete registeredSkillsAll[agentName];
      }

      if (agentCommandNames.length) {
        let commandNamesToUnregister = agentCommandNames;
        if (agentConfig.extension === '/SKILL.md') {
          const agentOutput = resolveAgentDirWith(registrar, agentName, agentConfig, this.projectRoot);
          const sharedNames = new Set<string>();
          for (const [otherAgent, otherNames] of Object.entries(regCommands)) {
            if (otherAgent === agentName || !Array.isArray(otherNames)) continue;
            const otherConfig = registrarAgentConfigs()[otherAgent];
            if (!otherConfig || otherConfig.extension !== '/SKILL.md') continue;
            const otherOutput = resolveAgentDirWith(registrar, otherAgent, otherConfig, this.projectRoot);
            if (otherOutput === agentOutput) {
              for (const name of otherNames) if (typeof name === 'string') sharedNames.add(name);
            }
          }
          commandNamesToUnregister = agentCommandNames.filter((n) => !sharedNames.has(n));
        }
        if (commandNamesToUnregister.length) {
          this.unregisterCommands({ [agentName]: commandNamesToUnregister });
        }
        const newRegisteredCommands = deepCopy(regCommands);
        delete newRegisteredCommands[agentName];
        updates.registered_commands = newRegisteredCommands;
      }

      const agentSkillNames = registeredSkillsAll[agentName] ?? [];
      if (agentSkillNames.length || skillsMigrated || nativeSkillsEntryRemoved) {
        if (agentSkillNames.length) this.deleteAgentPresetSkills(agentName, agentSkillNames, packId);
        const remaining: AgentNameMap = {};
        for (const [otherAgent, names] of Object.entries(registeredSkillsAll)) {
          if (otherAgent !== agentName) remaining[otherAgent] = names;
        }
        updates.registered_skills = remaining;
      }

      if (Object.keys(updates).length) this.registry.update(packId, updates);
    }
  }

  /** Remove previously registered command files from agent directories. */
  unregisterCommands(registeredCommands: AgentNameMap): void {
    const registrar = new CommandRegistrar();
    registrar.unregisterCommands(registeredCommands, this.projectRoot);
  }

  /** Merge actually-written agent command registrations into a preset's metadata. */
  mergePackRegisteredCommands(packId: string, written: AgentNameMap | null | undefined): void {
    if (!written || !Object.keys(written).length) return;
    const metadata = this.registry.get(packId);
    if (metadata === null) return;
    let existingCommands: unknown = 'registered_commands' in metadata ? metadata.registered_commands : {};
    if (!isMapping(existingCommands)) existingCommands = {};
    const mergedCommands = deepCopy(existingCommands) as AgentNameMap;
    let changed = false;
    for (const [agentName, cmdNames] of Object.entries(written)) {
      if (!cmdNames || !cmdNames.length) continue;
      const existingNames = mergedCommands[agentName] ?? [];
      const newNames = cmdNames.filter((n) => !existingNames.includes(n));
      if (newNames.length) {
        mergedCommands[agentName] = [...existingNames, ...newNames];
        changed = true;
      }
    }
    if (changed) this.registry.update(packId, { registered_commands: mergedCommands });
  }

  /** Merge reconciliation writes into an extension's registry entry. */
  mergeExtensionRegisteredCommands(extensionId: string, written: AgentNameMap | null | undefined): void {
    if (!written || !Object.keys(written).length) return;
    const registry = new ExtensionRegistry(nodePath.join(this.projectRoot, '.specify', 'extensions'));
    const metadata = registry.get(extensionId);
    if (metadata === null || metadata === undefined) return;
    let existingCommands: unknown = 'registered_commands' in metadata ? metadata.registered_commands : {};
    if (!isMapping(existingCommands)) existingCommands = {};
    const mergedCommands = deepCopy(existingCommands) as AgentNameMap;
    let changed = false;
    for (const [agentName, cmdNames] of Object.entries(written)) {
      const existingNames = mergedCommands[agentName] ?? [];
      const newNames = cmdNames.filter((n) => !existingNames.includes(n));
      if (newNames.length) {
        mergedCommands[agentName] = [...existingNames, ...newNames];
        changed = true;
      }
    }
    if (changed) registry.update(extensionId, { registered_commands: mergedCommands });
  }

  /**
   * Re-resolve and re-register composed commands from the full stack so
   * command files reflect the current priority stack.
   *
   * @param extraAgents Historical agents to also reconcile (post-removal only)
   * @param targetAgent Report only names written for this agent
   * @returns Command names successfully written by this pass
   */
  reconcileComposedCommands(
    commandNames: string[],
    extraAgents: Set<string> | null = null,
    targetAgent: string | null = null,
  ): Set<string> {
    if (!commandNames.length) return new Set();

    const resolver = new PresetResolver(this.projectRoot);
    const registrar = new CommandRegistrar();
    const reconciledCommands = new Set<string>();

    const recordWritten = (written: AgentNameMap): void => {
      if (targetAgent !== null) {
        for (const n of written[targetAgent] ?? []) reconciledCommands.add(n);
      } else {
        for (const names of Object.values(written)) for (const n of names) reconciledCommands.add(n);
      }
    };

    const resolvedAgent = resolveActiveAgentForRegistration(this.projectRoot);
    let onlyAgent: string | null;
    if (resolvedAgent === MISSING_INIT_OPTIONS_FILE) {
      onlyAgent = null;
    } else if (resolvedAgent === null || resolvedAgent === undefined) {
      onlyAgent = '';
    } else {
      onlyAgent = resolvedAgent as string;
      const agentConfig = registrarAgentConfigs()[onlyAgent];
      if (
        agentConfig &&
        isAiSkillsEnabled(loadInitOptions(this.projectRoot)) &&
        agentConfig.extension !== '/SKILL.md'
      ) {
        onlyAgent = '';
      }
    }

    if (extraAgents && extraAgents.size && typeof resolvedAgent === 'string') {
      extraAgents = new Set([...extraAgents].filter((a) => a !== resolvedAgent));
    }

    const presetsByPriority = this.registry.listByPriority();

    for (const cmdName of commandNames) {
      const layers = resolver.collectAllLayers(cmdName, 'command');
      if (!layers.length) continue;

      const topIsReplace = layers[0].strategy === 'replace';
      const hasComposition = !topIsReplace && layers.some((l) => l.strategy !== 'replace');
      if (!hasComposition) {
        const topLayer = layers[0];
        const topPath = topLayer.path;
        let registered = false;
        for (const [packId] of presetsByPriority) {
          const packDir = nodePath.join(this.presetsDir, packId);
          if (isRelativeTo(topPath, packDir)) {
            const manifest = resolver.getManifest(packDir);
            if (manifest) {
              for (const tmpl of manifest.templates) {
                if (tmpl.name === cmdName && tmpl.type === 'command') {
                  const written = this.registerForNonSkillAgents(registrar, [tmpl], manifest.id, packDir, {
                    onlyAgent,
                    extraAgents,
                  });
                  recordWritten(written);
                  this.mergePackRegisteredCommands(manifest.id, written);
                  registered = true;
                  break;
                }
              }
            }
            break;
          }
        }
        if (!registered) {
          const source = layers[0].source;
          let extensionId: string | null = null;
          let written: AgentNameMap = {};
          if (source.startsWith('extension:')) {
            extensionId = source.split(':').slice(1).join(':').split(' ')[0];
            const extDir = nodePath.join(this.projectRoot, '.specify', 'extensions', extensionId);
            const extManifestPath = nodePath.join(extDir, 'extension.yml');
            if (pathExists(extManifestPath)) {
              try {
                const extManifest = new ExtensionManifest(extManifestPath);
                const matchingCmds = (extManifest.commands as Dict[]).filter((c) => c.name === cmdName);
                if (matchingCmds.length) {
                  written = registrar.registerCommandsForNonSkillAgents(
                    matchingCmds as CommandInfo[],
                    extensionId,
                    extDir,
                    this.projectRoot,
                    {
                      contextNote: `\n<!-- Extension: ${extensionId} -->\n<!-- Config: .specify/extensions/${extensionId}/ -->\n`,
                      extensionId,
                      onlyAgent,
                      extraAgents: extraAgents ? [...extraAgents] : null,
                    },
                  ) as AgentNameMap;
                  recordWritten(written);
                  registered = true;
                }
              } catch (e) {
                if (!isOsError(e)) throw e;
                // Extension registration failed; fall back to generic path-based registration below.
              }
            }
          }
          if (!registered) {
            const sourceId = extensionId || source;
            written = this.registerCommandFromPath(registrar, cmdName, topPath, {
              sourceId,
              onlyAgent,
              extraAgents,
            });
            recordWritten(written);
          }
          if (extensionId) this.mergeExtensionRegisteredCommands(extensionId, written);
        }
      } else {
        const composed = resolver.resolveContent(cmdName, 'command');
        if (composed === null) {
          presetWarn(`Cannot compose command '${cmdName}': no base layer. Stale command files may remain.`);
          const configs = registrarAgentConfigs();
          const cmdNamesToUnregister = [cmdName];
          for (const [pid] of presetsByPriority) {
            const m = resolver.getManifest(nodePath.join(this.presetsDir, pid));
            if (m) {
              const t = m.templates.find((tt) => tt.name === cmdName && tt.type === 'command');
              if (t) {
                const aliases = 'aliases' in t ? t.aliases : [];
                for (const alias of Array.isArray(aliases) ? aliases : []) {
                  if (typeof alias === 'string') cmdNamesToUnregister.push(alias);
                }
              }
            }
          }
          const toUnregister: AgentNameMap = {};
          for (const agent of Object.keys(configs)) {
            if (configs[agent].extension === '/SKILL.md') continue;
            if (onlyAgent === null || agent === onlyAgent || (extraAgents !== null && extraAgents.has(agent))) {
              toUnregister[agent] = cmdNamesToUnregister;
            }
          }
          registrar.unregisterCommands(toUnregister, this.projectRoot);
          continue;
        }

        let registered = false;
        outer: for (const [packId] of presetsByPriority) {
          const packDir = nodePath.join(this.presetsDir, packId);
          const manifest = resolver.getManifest(packDir);
          if (!manifest) continue;
          for (const tmpl of manifest.templates) {
            if (tmpl.name === cmdName && tmpl.type === 'command') {
              const composedDir = nodePath.join(packDir, '.composed');
              mkdirSync(composedDir, { recursive: true });
              writeFileSync(nodePath.join(composedDir, `${cmdName}.md`), composed, 'utf-8');
              const written = this.registerForNonSkillAgents(
                registrar,
                [{ ...tmpl, file: `.composed/${cmdName}.md` }],
                manifest.id,
                packDir,
                { onlyAgent, extraAgents },
              );
              recordWritten(written);
              this.mergePackRegisteredCommands(manifest.id, written);
              registered = true;
              break outer;
            }
          }
        }
        if (!registered) {
          const sharedComposed = nodePath.join(this.presetsDir, '.composed');
          mkdirSync(sharedComposed, { recursive: true });
          const composedFile = nodePath.join(sharedComposed, `${cmdName}.md`);
          writeFileSync(composedFile, composed, 'utf-8');
          const source = layers[0].source;
          const sourceId = source.startsWith('extension:')
            ? source.split(':').slice(1).join(':').split(' ')[0]
            : source;
          const written = this.registerCommandFromPath(registrar, cmdName, composedFile, {
            sourceId,
            onlyAgent,
            extraAgents,
          });
          recordWritten(written);
          if (source.startsWith('extension:')) this.mergeExtensionRegisteredCommands(sourceId, written);
        }
      }
    }

    return reconciledCommands;
  }

  /**
   * Register a single command from a file path (non-preset source).
   *
   * @returns Agent names → names actually registered
   */
  registerCommandFromPath(
    registrar: CommandRegistrar,
    cmdName: string,
    cmdPath: string,
    opts: { sourceId?: string; onlyAgent?: string | null; extraAgents?: Set<string> | null } = {},
  ): AgentNameMap {
    const sourceId = opts.sourceId ?? 'reconciled';
    if (!pathExists(cmdPath)) return {};
    const cmdTmpl: Dict = { name: cmdName, type: 'command', file: nodePath.basename(cmdPath) };
    if (sourceId && !sourceId.startsWith('preset:')) {
      try {
        const extensionsDir = nodePath.join(this.projectRoot, '.specify', 'extensions');
        for (const name of readdirSync(extensionsDir)) {
          const extDir = nodePath.join(extensionsDir, name);
          if (!isDir(extDir)) continue;
          if (isRelativeTo(cmdPath, extDir)) {
            const manifestPath = nodePath.join(extDir, 'extension.yml');
            if (pathExists(manifestPath)) {
              const extManifest = new ExtensionManifest(manifestPath);
              for (const cmd of extManifest.commands as Dict[]) {
                if (cmd.name === cmdName) {
                  const aliases = 'aliases' in cmd ? cmd.aliases : [];
                  if (Array.isArray(aliases) && aliases.length) cmdTmpl.aliases = aliases;
                  break;
                }
              }
            }
            break;
          }
        }
      } catch {
        // best-effort alias loading
      }
    }
    return this.registerForNonSkillAgents(registrar, [cmdTmpl], sourceId, nodePath.dirname(cmdPath), {
      onlyAgent: opts.onlyAgent ?? null,
      extraAgents: opts.extraAgents ?? null,
    });
  }

  /**
   * Register commands for non-skill agents during reconciliation (skill-based
   * agents are handled by the skills reconciliation path).
   */
  registerForNonSkillAgents(
    registrar: CommandRegistrar,
    commands: Dict[],
    sourceId: string,
    sourceDir: string,
    opts: { onlyAgent?: string | null; extraAgents?: Set<string> | null } = {},
  ): AgentNameMap {
    return registrar.registerCommandsForNonSkillAgents(commands as CommandInfo[], sourceId, sourceDir, this.projectRoot, {
      onlyAgent: opts.onlyAgent ?? null,
      extraAgents: opts.extraAgents ? [...opts.extraAgents] : null,
    }) as AgentNameMap;
  }
}

/** Call the registrar's ``_resolve_agent_dir`` (static in upstream). */
export function resolveAgentDirWith(
  registrar: unknown,
  agentName: string,
  agentConfig: Dict,
  projectRoot: string,
): string {
  const R = CommandRegistrar as unknown as {
    resolveAgentDir?: (a: string, c: Dict, p: string) => string;
    _resolveAgentDir?: (a: string, c: Dict, p: string) => string;
  };
  const inst = registrar as typeof R;
  const fn = inst?.resolveAgentDir ?? inst?._resolveAgentDir ?? R.resolveAgentDir ?? R._resolveAgentDir;
  if (!fn) throw new Error('CommandRegistrar.resolveAgentDir is unavailable');
  return fn.call(CommandRegistrar, agentName, agentConfig, projectRoot);
}
