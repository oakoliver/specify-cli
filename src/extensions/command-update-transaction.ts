/**
 * @oakoliver/specify-cli - Transactional ``specify extension update``
 *
 * Port of ``specify_cli/extensions/_command_update_transaction.py``: discovery,
 * confirmation, and per-extension update with full backup/rollback of the
 * extension directory, generated command/skill artifacts, hooks and registry.
 *
 * @module extensions/command-update-transaction
 */

import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { CommandRegistrar as AgentRegistrar } from '../agents.js';
import { CliExit, confirm, console, escapeMarkup } from '../console.js';
import { isAiSkillsEnabled, loadInitOptions } from '../init-options.js';
import { getSkillsDir as resolveConfiguredSkillsDir } from '../shared-infra.js';
import { getSpeckitVersion } from '../assets.js';
import { refreshEventsAndWarn } from './command-shared.js';
import { archiveExtensionDirectory, preflightUpdateArchive } from './command-update-artifacts.js';
import { type UpdateCandidate, bundledUpdateSource, discoverUpdates } from './command-update-discovery.js';
import { CommandRegistrar } from './command-registrar.js';
import { exists, isDir, isFile, isSymlink, pyEquals } from './compat.js';
import { ExtensionError, ValidationError } from './errors.js';
import { ExtensionCatalog } from './extension-catalog.js';
import { copy2, copytree, globSuffix, isRelativeTo, resolveStrictFalse, rmtree, unlink } from './fs-utils.js';
import { HookExecutor } from './hooks.js';
import { ExtensionManager } from './manager.js';
import { type Dict, isMapping, normalizePriority } from './manifest.js';
import { requireSpecifyProject } from './root-helpers.js';

/** Overridable collaborators (tests). */
export interface UpdateCommandDeps {
  archiveExtensionDirectory?: (sourceDir: string) => string;
  bundledUpdateSource?: typeof bundledUpdateSource;
}

function pathDepth(p: string): number {
  return p.split(/[\\/]/).filter((x) => x).length;
}

/** Run discovery, confirmation, and transactional extension updates. */
export async function runUpdateCommand(extension: string | null, deps: UpdateCommandDeps = {}): Promise<void> {
  const archiveDir = deps.archiveExtensionDirectory ?? archiveExtensionDirectory;
  const projectRoot = requireSpecifyProject();
  const manager = new ExtensionManager(projectRoot);
  const catalog = new ExtensionCatalog(projectRoot);
  const speckitVersion = getSpeckitVersion();

  try {
    const [updatesAvailable, blockedUpdates, hasInstalled] = await discoverUpdates(
      manager,
      catalog,
      extension,
      deps.bundledUpdateSource ?? bundledUpdateSource,
    );
    if (!hasInstalled) {
      console.print('[yellow]No extensions installed[/yellow]');
      throw new CliExit(0);
    }
    if (!updatesAvailable.length) {
      if (blockedUpdates.length) {
        console.print(
          '\n[yellow]Update(s) exist but require a newer spec-kit ' +
            'release — upgrade spec-kit, then rerun ' +
            "'specify extension update'.[/yellow]",
        );
      } else {
        console.print('\n[green]All extensions are up to date![/green]');
      }
      throw new CliExit(0);
    }

    console.print('\n[bold]Updates available:[/bold]\n');
    for (const update of updatesAvailable) {
      console.print(`  • ${escapeMarkup(update.extension_id)}: ${update.installed} → ${update.available}`);
    }
    console.print();
    if (!(await confirm('Update these extensions?'))) {
      console.print('Cancelled');
      throw new CliExit(0);
    }

    console.print();
    const updatedExtensions: string[] = [];
    const failedUpdates: Array<[string, string]> = [];
    const registrar = new CommandRegistrar();
    const hookExecutor = new HookExecutor(projectRoot);

    for (const update of updatesAvailable) {
      await updateOne(update);
    }

    // eslint-disable-next-line no-inner-declarations
    async function updateOne(update: UpdateCandidate): Promise<void> {
      const extensionId = update.extension_id;
      const extName = update.name;
      const safeExtName = escapeMarkup(String(extName));
      console.print(`📦 Updating ${safeExtName}...`);

      const backupRoot = join(manager.extensionsDir, '.backup');
      const backupKey = createHash('sha256').update(extensionId, 'utf-8').digest('hex').slice(0, 16);
      const backupBase = join(backupRoot, `update-${backupKey}-${randomBytes(16).toString('hex')}`);
      const backupExtDir = join(backupBase, 'extension');
      const backupCommandsDir = join(backupBase, 'commands');
      const backupSkillsDir = join(backupBase, 'skills');
      const backupConfigDir = join(backupBase, 'config');

      let backupRegistryEntry: Dict | null = null;
      let backupInstalled: unknown[] | undefined; // undefined == UNSET
      let backupHooks: Dict | null = null;
      const backedUpCommandFiles = new Map<string, string>();
      const backedUpCommandSymlinks = new Map<string, string>();
      const backedUpSkillDirs = new Map<string, string>();
      let newCommandDirsAbsentBeforeUpdate: string[] = [];
      let newCommandPathsAbsentBeforeUpdate: string[] = [];
      let newSkillNames: string[] = [];
      const newSkillPathsAbsentBeforeUpdate: string[] = [];
      let installationModified = false;
      let zipCleanupError: Error | null = null;
      let backupCreatedByAttempt = false;

      const backupCommandArtifact = (originalFile: string, backupFile: string): void => {
        if (backedUpCommandFiles.has(originalFile)) return;
        if (isSymlink(originalFile)) {
          backedUpCommandSymlinks.set(originalFile, readlinkSync(originalFile));
        } else {
          if (statSync(originalFile).nlink > 1) {
            throw new Error(`Cannot safely update hard-linked generated artifact '${originalFile}'`);
          }
          backupCreatedByAttempt = true;
          mkdirSync(dirname(backupFile), { recursive: true });
          copy2(originalFile, backupFile);
        }
        backedUpCommandFiles.set(originalFile, backupFile);
      };

      const restoreCommandArtifact = (originalFile: string, backupFile: string): void => {
        const symlinkState = backedUpCommandSymlinks.get(originalFile);
        if (symlinkState !== undefined) {
          if (isSymlink(originalFile) || isFile(originalFile)) unlink(originalFile);
          else if (exists(originalFile)) {
            throw new Error(`Command rollback found an unexpected directory at '${originalFile}'`);
          }
          mkdirSync(dirname(originalFile), { recursive: true });
          symlinkSync(symlinkState, originalFile);
          return;
        }
        if (!isFile(backupFile) || isSymlink(backupFile)) {
          throw new Error(`Command rollback backup is missing for '${originalFile}'`);
        }
        if (isSymlink(originalFile) || isFile(originalFile)) unlink(originalFile);
        else if (exists(originalFile)) {
          throw new Error(`Command rollback found an unexpected directory at '${originalFile}'`);
        }
        mkdirSync(dirname(originalFile), { recursive: true });
        copy2(backupFile, originalFile);
      };

      const rememberAbsentParentDirs = (artifactPath: string, rootDir: string): void => {
        let boundary = dirname(rootDir);
        if (isRelativeTo(rootDir, projectRoot)) boundary = projectRoot;
        let parent = dirname(artifactPath);
        while (parent !== boundary && parent !== dirname(parent)) {
          if (exists(parent) || isSymlink(parent)) break;
          newCommandDirsAbsentBeforeUpdate.push(parent);
          parent = dirname(parent);
        }
      };

      const backupExtensionSkills = (skillNames: string[], skillsDir?: string | null): void => {
        for (const skillDir of manager.findExtensionSkillDirs(skillNames, extensionId, skillsDir, {
          createSkillsDir: false,
        })) {
          if (backedUpSkillDirs.has(skillDir)) continue;
          backupCreatedByAttempt = true;
          mkdirSync(backupSkillsDir, { recursive: true });
          const backupSkillDir = join(backupSkillsDir, String(backedUpSkillDirs.size));
          copytree(skillDir, backupSkillDir, { symlinks: true });
          backedUpSkillDirs.set(skillDir, backupSkillDir);
        }
      };

      try {
        if (isSymlink(backupRoot)) {
          throw new Error(`Cannot safely create update backup under symlinked directory '${backupRoot}'`);
        }
        if (exists(backupBase) || isSymlink(backupBase)) {
          throw new Error(`Cannot safely reuse an existing update backup directory '${backupBase}'`);
        }

        // 1. Backup registry entry
        backupRegistryEntry = manager.registry.get(extensionId);

        // 2. Backup extension directory
        const extensionDir = join(manager.extensionsDir, extensionId);
        if (exists(extensionDir)) {
          backupCreatedByAttempt = true;
          mkdirSync(backupBase, { recursive: true });
          if (exists(backupExtDir)) rmtree(backupExtDir);
          copytree(extensionDir, backupExtDir);
          const configFiles = [
            ...globSuffix(extensionDir, '-config.yml'),
            ...globSuffix(extensionDir, '-config.local.yml'),
          ];
          for (const cfgFile of configFiles) {
            mkdirSync(backupConfigDir, { recursive: true });
            copy2(cfgFile, join(backupConfigDir, cfgFile.slice(extensionDir.length + 1)));
          }
        }

        // 3. Backup command files for all agents
        const registeredCommands: Dict = isMapping(backupRegistryEntry)
          ? ((backupRegistryEntry.registered_commands ?? {}) as Dict)
          : {};
        for (const [agentName, cmdNames] of Object.entries(isMapping(registeredCommands) ? registeredCommands : {})) {
          if (!(agentName in registrar.AGENT_CONFIGS)) continue;
          const agentConfig = registrar.AGENT_CONFIGS[agentName];
          const commandsDir = AgentRegistrar.resolveAgentDir(agentName, agentConfig as never, projectRoot);
          const dirsToBackup = [commandsDir];
          const legacy = agentConfig.legacy_dir;
          if (legacy) {
            const legacyDir = join(projectRoot, legacy);
            if (exists(legacyDir) && legacyDir !== commandsDir) dirsToBackup.push(legacyDir);
          }
          for (const cmdName of Array.isArray(cmdNames) ? (cmdNames as string[]) : []) {
            const outputName = AgentRegistrar.computeOutputName(agentName, cmdName, agentConfig as never);
            const namesToBackup = [outputName];
            if (outputName !== cmdName && AgentRegistrar.isSafeCommandName(cmdName)) namesToBackup.push(cmdName);
            dirsToBackup.forEach((targetDir, dirIndex) => {
              for (const name of namesToBackup) {
                const cmdFile = join(targetDir, `${name}${agentConfig.extension}`);
                try {
                  AgentRegistrar.ensureInside(cmdFile, targetDir);
                } catch {
                  continue;
                }
                if (exists(cmdFile) || isSymlink(cmdFile)) {
                  const backupCmdPath = join(
                    backupCommandsDir,
                    agentName,
                    `location-${dirIndex}`,
                    relative(targetDir, cmdFile),
                  );
                  backupCommandArtifact(cmdFile, backupCmdPath);
                }
              }
            });
            if (agentName === 'copilot') {
              const promptsDir = join(projectRoot, '.github', 'prompts');
              const promptFile = join(promptsDir, `${cmdName}.prompt.md`);
              try {
                AgentRegistrar.ensureInside(promptFile, promptsDir);
              } catch {
                continue;
              }
              if (exists(promptFile) || isSymlink(promptFile)) {
                backupCommandArtifact(
                  promptFile,
                  join(backupCommandsDir, 'copilot-prompts', relative(promptsDir, promptFile)),
                );
              }
            }
          }
        }

        const rawRegisteredSkills = isMapping(backupRegistryEntry)
          ? backupRegistryEntry.registered_skills ?? []
          : [];
        const registeredSkills = ExtensionManager.validNameList(rawRegisteredSkills);
        backupExtensionSkills(registeredSkills);

        // 4. Backup hooks and installed list from extensions.yml
        const config = hookExecutor.getProjectConfig();
        if (isMapping(config)) {
          backupInstalled = structuredClone(config.installed ?? []) as unknown[];
          backupHooks = {};
          for (const [hookName, hookList] of Object.entries((config.hooks ?? {}) as Dict)) {
            if (!Array.isArray(hookList)) continue;
            const extHooks = hookList.filter((h) => isMapping(h) && h.extension === extensionId);
            if (extHooks.length) backupHooks[hookName] = extHooks;
          }
        }

        // 5. Acquire the new version
        const archivePath =
          update.bundled_dir !== null
            ? archiveDir(update.bundled_dir)
            : await catalog.downloadExtension(extensionId);
        try {
          const preflight = preflightUpdateArchive(
            manager,
            archivePath,
            extensionId,
            update.available,
            speckitVersion,
          );
          const newCommandNames = preflight.command_names;
          newSkillNames = preflight.skill_names;

          for (const [agentName, commandsDir] of manager.commandRegistrationTargets()) {
            const agentConfig = registrar.AGENT_CONFIGS[agentName];
            for (const commandName of newCommandNames) {
              const outputName = AgentRegistrar.computeOutputName(agentName, commandName, agentConfig as never);
              const commandFile = join(commandsDir, `${outputName}${agentConfig.extension}`);
              AgentRegistrar.ensureInside(commandFile, commandsDir);
              const backupCommandPath = join(backupCommandsDir, agentName, relative(commandsDir, commandFile));
              if (exists(commandFile) || isSymlink(commandFile)) {
                backupCommandArtifact(commandFile, backupCommandPath);
              } else {
                newCommandPathsAbsentBeforeUpdate.push(commandFile);
                rememberAbsentParentDirs(commandFile, commandsDir);
              }
              if (agentName === 'copilot') {
                const promptsDir = join(projectRoot, '.github', 'prompts');
                const promptFile = join(promptsDir, `${commandName}.prompt.md`);
                AgentRegistrar.ensureInside(promptFile, promptsDir);
                if (isSymlink(promptFile)) {
                  throw new Error(`Cannot safely update symlinked Copilot prompt artifact '${promptFile}'`);
                }
                const backupPromptPath = join(backupCommandsDir, 'copilot-prompts', relative(promptsDir, promptFile));
                if (exists(promptFile) || isSymlink(promptFile)) {
                  backupCommandArtifact(promptFile, backupPromptPath);
                } else {
                  newCommandPathsAbsentBeforeUpdate.push(promptFile);
                  rememberAbsentParentDirs(promptFile, promptsDir);
                }
              }
            }
          }
          newCommandPathsAbsentBeforeUpdate = [...new Set(newCommandPathsAbsentBeforeUpdate)];
          newCommandDirsAbsentBeforeUpdate = [...new Set(newCommandDirsAbsentBeforeUpdate)];

          backupExtensionSkills(newSkillNames);
          const newSkillsDir = manager.getSkillsDir({ create: false });
          if (newSkillsDir !== null) {
            backupExtensionSkills([...new Set([...registeredSkills, ...newSkillNames])], newSkillsDir);
            const initOptions = loadInitOptions(projectRoot);
            if (
              isMapping(initOptions) &&
              isAiSkillsEnabled(initOptions) &&
              typeof initOptions.ai === 'string' &&
              initOptions.ai
            ) {
              const configuredSkillsDir = resolveConfiguredSkillsDir(projectRoot, initOptions.ai);
              rememberAbsentParentDirs(join(configuredSkillsDir, '.update-marker'), configuredSkillsDir);
            }
            const newSkillsRoot = resolveStrictFalse(newSkillsDir);
            for (const skillName of newSkillNames) {
              const skillPath = join(newSkillsDir, skillName);
              const resolvedSkillPath = resolveStrictFalse(skillPath);
              if (!isRelativeTo(resolvedSkillPath, newSkillsRoot)) {
                throw new Error(`'${resolvedSkillPath}' is not in the subpath of '${newSkillsRoot}'`);
              }
              if (!(exists(skillPath) || isSymlink(skillPath))) {
                newSkillPathsAbsentBeforeUpdate.push(skillPath);
                rememberAbsentParentDirs(join(skillPath, 'SKILL.md'), newSkillsDir);
              }
            }
          }
          newCommandDirsAbsentBeforeUpdate = [...new Set(newCommandDirsAbsentBeforeUpdate)];

          // 7. Remove old extension
          installationModified = true;
          manager.remove(extensionId, true);

          // 8. Install new version
          manager.installFromZip(archivePath, speckitVersion, { catalogName: update.catalog_name });

          const newExtensionDir = join(manager.extensionsDir, extensionId);
          if (exists(backupConfigDir) && exists(newExtensionDir)) {
            for (const name of readdirSync(backupConfigDir)) {
              const cfgFile = join(backupConfigDir, name);
              if (isFile(cfgFile)) copy2(cfgFile, join(newExtensionDir, name));
            }
          }

          // 9. Restore metadata from backup (installed_at, enabled state)
          if (backupRegistryEntry && isMapping(backupRegistryEntry)) {
            const currentMetadata = manager.registry.get(extensionId);
            if (currentMetadata === null || !isMapping(currentMetadata)) {
              throw new Error(
                `Registry entry for '${extensionId}' missing or corrupted after install — update incomplete`,
              );
            }
            const newMetadata: Dict = { ...currentMetadata };
            if ('installed_at' in backupRegistryEntry) newMetadata.installed_at = backupRegistryEntry.installed_at;
            if ('priority' in backupRegistryEntry) {
              newMetadata.priority = normalizePriority(backupRegistryEntry.priority);
            }
            const wasEnabled = 'enabled' in backupRegistryEntry ? backupRegistryEntry.enabled : true;
            if (!wasEnabled) newMetadata.enabled = false;
            manager.registry.restore(extensionId, newMetadata);
            if (!wasEnabled) {
              const cfg = hookExecutor.getProjectConfig();
              if ('hooks' in cfg) {
                for (const hookName of Object.keys(cfg.hooks)) {
                  for (const hook of cfg.hooks[hookName]) {
                    if (hook.extension === extensionId) hook.enabled = false;
                  }
                }
                hookExecutor.saveProjectConfig(cfg);
              }
            }
          }
        } finally {
          try {
            unlink(archivePath, true);
          } catch (error) {
            zipCleanupError = error as Error;
          }
        }

        // 10. Clean up backup on success
        let cleanupError: Error | null = null;
        if (backupCreatedByAttempt && exists(backupBase)) {
          try {
            rmtree(backupBase);
          } catch (error) {
            cleanupError = error as Error;
          }
        }
        console.print(`   [green]✓[/green] Updated to v${update.available}`);
        if (cleanupError !== null) {
          console.print(
            '   [yellow]Warning:[/yellow] Could not fully remove update backup: ' +
              escapeMarkup(cleanupError.message),
          );
          console.print(`   [dim]Backup may remain at: ${escapeMarkup(backupBase)}[/dim]`);
        }
        if (zipCleanupError !== null) {
          console.print(
            '   [yellow]Warning:[/yellow] Could not remove downloaded update archive: ' +
              escapeMarkup((zipCleanupError as Error).message),
          );
        }
        updatedExtensions.push(extName);
      } catch (e) {
        if (e instanceof CliExit) throw e;
        const message = (e as Error)?.message ?? String(e);
        console.print(`   [red]✗[/red] Failed: ${escapeMarkup(message)}`);
        failedUpdates.push([extName, message]);
        if (zipCleanupError !== null) {
          console.print(
            '   [yellow]Warning:[/yellow] Could not remove downloaded update archive: ' +
              escapeMarkup((zipCleanupError as Error).message),
          );
        }

        if (!installationModified) {
          if (backupCreatedByAttempt && exists(backupBase)) {
            try {
              rmtree(backupBase);
            } catch (cleanupError) {
              console.print(
                '   [yellow]Warning:[/yellow] Could not remove untouched-update backup: ' +
                  escapeMarkup((cleanupError as Error).message),
              );
            }
          }
          return;
        }

        console.print(`   [yellow]↩[/yellow] Rolling back ${safeExtName}...`);
        try {
          const extensionDir = join(manager.extensionsDir, extensionId);
          if (exists(backupExtDir)) {
            if (exists(extensionDir)) rmtree(extensionDir);
            copytree(backupExtDir, extensionDir);
          }

          for (const commandPath of newCommandPathsAbsentBeforeUpdate) {
            if (isSymlink(commandPath) || isFile(commandPath)) unlink(commandPath);
            else if (exists(commandPath)) {
              throw new Error(`Command rollback found an unexpected directory at '${commandPath}'`);
            }
          }
          let newRegisteredSkills: string[] = [];
          const newRegistryEntry = manager.registry.get(extensionId);
          let newRegisteredCommands: Dict = {};
          if (newRegistryEntry !== null && isMapping(newRegistryEntry)) {
            newRegisteredCommands = (newRegistryEntry.registered_commands ?? {}) as Dict;
            newRegisteredSkills = ExtensionManager.validNameList(newRegistryEntry.registered_skills ?? []);
          }
          for (const [agentName, cmdNames] of Object.entries(isMapping(newRegisteredCommands) ? newRegisteredCommands : {})) {
            if (!(agentName in registrar.AGENT_CONFIGS)) continue;
            const agentConfig = registrar.AGENT_CONFIGS[agentName];
            const commandsDir = AgentRegistrar.resolveAgentDir(agentName, agentConfig as never, projectRoot);
            for (const cmdName of Array.isArray(cmdNames) ? (cmdNames as string[]) : []) {
              const outputName = AgentRegistrar.computeOutputName(agentName, cmdName, agentConfig as never);
              const cmdFile = join(commandsDir, `${outputName}${agentConfig.extension}`);
              if (exists(cmdFile) && !backedUpCommandFiles.has(cmdFile)) unlink(cmdFile);
              if (agentName === 'copilot') {
                const promptFile = join(projectRoot, '.github', 'prompts', `${cmdName}.prompt.md`);
                if (exists(promptFile) && !backedUpCommandFiles.has(promptFile)) unlink(promptFile);
              }
            }
          }

          for (const [originalPath, backupPath] of backedUpCommandFiles) {
            restoreCommandArtifact(originalPath, backupPath);
          }

          const skillsToRemove = [...new Set([...newSkillNames, ...newRegisteredSkills])];
          for (const skillPath of newSkillPathsAbsentBeforeUpdate) {
            if (isSymlink(skillPath) || isFile(skillPath)) unlink(skillPath);
            else if (exists(skillPath)) rmtree(skillPath);
          }
          manager.unregisterExtensionSkills(skillsToRemove, extensionId);

          for (const [originalPath, backupPath] of backedUpSkillDirs) {
            if (!isDir(backupPath)) throw new Error(`Skill rollback backup is missing for '${originalPath}'`);
            if (isSymlink(originalPath) || isFile(originalPath)) unlink(originalPath);
            else if (exists(originalPath)) rmtree(originalPath);
            mkdirSync(dirname(originalPath), { recursive: true });
            copytree(backupPath, originalPath, { symlinks: true });
          }

          for (const commandDir of [...newCommandDirsAbsentBeforeUpdate].sort((a, b) => pathDepth(b) - pathDepth(a))) {
            let isRealDir = false;
            try {
              isRealDir = lstatSync(commandDir).isDirectory();
            } catch {
              isRealDir = false;
            }
            if (isRealDir) {
              try {
                rmdirSync(commandDir);
              } catch {
                // Preserve any non-empty directory.
              }
            }
          }

          if (backupHooks !== null) {
            let cfg: Dict = hookExecutor.getProjectConfig();
            if (!isMapping(cfg)) cfg = {};
            let modified = false;
            if (!isMapping(cfg.hooks)) {
              cfg.hooks = {};
              modified = true;
            }
            for (const hookName of Object.keys(cfg.hooks)) {
              const hooksList = cfg.hooks[hookName];
              if (!Array.isArray(hooksList)) {
                cfg.hooks[hookName] = [];
                modified = true;
                continue;
              }
              const filtered = hooksList.filter((h) => isMapping(h) && h.extension !== extensionId);
              if (filtered.length !== hooksList.length) modified = true;
              cfg.hooks[hookName] = filtered;
            }
            if (Object.keys(backupHooks).length) {
              for (const [hookName, hooks] of Object.entries(backupHooks)) {
                if (!Array.isArray(cfg.hooks[hookName])) cfg.hooks[hookName] = [];
                cfg.hooks[hookName].push(...(hooks as unknown[]));
                modified = true;
              }
            }
            if (backupInstalled !== undefined) {
              if (!pyEquals(cfg.installed ?? null, backupInstalled)) {
                cfg.installed = backupInstalled;
                modified = true;
              }
            }
            if (modified) hookExecutor.saveProjectConfig(cfg);
          }

          if (backupRegistryEntry && Object.keys(backupRegistryEntry).length) {
            manager.registry.restore(extensionId, backupRegistryEntry);
          }

          let cleanupError: Error | null = null;
          if (backupCreatedByAttempt && exists(backupBase)) {
            try {
              rmtree(backupBase);
            } catch (error) {
              cleanupError = error as Error;
            }
          }
          console.print('   [green]✓[/green] Rollback successful');
          if (cleanupError !== null) {
            console.print(
              '   [yellow]Warning:[/yellow] Could not fully remove rollback backup: ' +
                escapeMarkup(cleanupError.message),
            );
            console.print(`   [dim]Backup may remain at: ${escapeMarkup(backupBase)}[/dim]`);
          }
        } catch (rollbackError) {
          console.print(`   [red]✗[/red] Rollback failed: ${escapeMarkup((rollbackError as Error).message)}`);
          console.print(`   [dim]Backup preserved at: ${escapeMarkup(backupBase)}[/dim]`);
        }
      }
    }

    console.print();
    if (updatedExtensions.length) {
      console.print(`[green]✓[/green] Successfully updated ${updatedExtensions.length} extension(s)`);
    }
    if (failedUpdates.length) {
      console.print(`[red]✗[/red] Failed to update ${failedUpdates.length} extension(s):`);
      for (const [extName, error] of failedUpdates) {
        console.print(`   • ${escapeMarkup(String(extName))}: ${escapeMarkup(String(error))}`);
      }
      throw new CliExit(1);
    }
    if (updatedExtensions.length) await refreshEventsAndWarn(projectRoot);
  } catch (e) {
    if (e instanceof ValidationError) {
      console.print(`\n[red]Validation Error:[/red] ${escapeMarkup(e.message)}`);
      throw new CliExit(1);
    }
    if (e instanceof ExtensionError) {
      console.print(`\n[red]Error:[/red] ${escapeMarkup(e.message)}`);
      throw new CliExit(1);
    }
    throw e;
  }
}
