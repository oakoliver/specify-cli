#!/usr/bin/env node
/**
 * @oakoliver/specify-cli - CLI Entry Point
 *
 * Main CLI executable for spec-kit.
 * Usage: specify <command> [options]
 *
 * @module cli
 */

import { init, parseInitArgs } from './init.js';
import { check } from './check.js';
import { printError, printSuccess, printInfo, titleStyle, dimStyle, successStyle, printBanner, warningStyle, accentStyle } from './ui.js';
import { SUPPORTED_AGENTS, AGENT_CONFIGS } from './types.js';
import { ExtensionManager } from './extension.js';
import { PresetManager } from './preset.js';
import { listIntegrations, addIntegration, removeIntegration, getIntegrationInfo } from './integration.js';
import { findProjectRoot, loadInitOptions, isSpeckitProject } from './config.js';
import { fetchCatalog, searchCatalog, DEFAULT_EXTENSION_CATALOG, DEFAULT_PRESET_CATALOG, type CatalogEntry } from './catalog.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================================
// Version and Help
// ============================================================================

const VERSION = '1.1.0';

const HELP = `
${titleStyle.render('specify')} - Spec-Driven Development CLI

${dimStyle.render('USAGE')}
  specify <command> [options]

${dimStyle.render('COMMANDS')}
  init [project]    Initialize a new spec-kit project
  check             Check project setup and fix issues
  doctor            Diagnose issues with project setup
  status            Show project status
  integration       Manage AI agent integrations
  extension         Manage extensions
  preset            Manage presets
  version           Show version

${dimStyle.render('EXAMPLES')}
  ${successStyle.render('$')} specify init my-project --ai copilot
  ${successStyle.render('$')} specify init . --ai claude --force
  ${successStyle.render('$')} specify init --here --ai opencode

${dimStyle.render('DOCUMENTATION')}
  https://github.com/github/spec-kit
`;

const INIT_HELP = `
${titleStyle.render('specify init')} - Initialize a new spec-kit project

${dimStyle.render('USAGE')}
  specify init [project-name] [options]

${dimStyle.render('OPTIONS')}
  --ai <agent>              AI assistant to configure for (default: copilot)
  --here                    Initialize in current directory
  -f, --force               Force init in non-empty directory
  --script <sh|ps>          Shell script type (default: sh)
  --branch-numbering <mode> Branch numbering: sequential|timestamp (default: sequential)
  --no-git                  Skip git initialization
  --offline                 Use bundled templates only
  --ai-skills               Generate SKILL.md files for skill-based agents
  -v, --verbose             Show verbose output

${dimStyle.render('SUPPORTED AGENTS')}
  ${SUPPORTED_AGENTS.join(', ')}

${dimStyle.render('EXAMPLES')}
  ${successStyle.render('$')} specify init my-project --ai copilot
  ${successStyle.render('$')} specify init . --ai claude --force
  ${successStyle.render('$')} specify init --here --ai opencode --script ps
`;

const EXTENSION_HELP = `
${titleStyle.render('specify extension')} - Manage extensions

${dimStyle.render('USAGE')}
  specify extension <subcommand> [options]

${dimStyle.render('SUBCOMMANDS')}
  list                List installed extensions
  search <query>      Search catalog for extensions
  add <path>          Install extension from local directory
  remove <id>         Remove an installed extension
  info <id>           Show extension details
  enable <id>         Enable a disabled extension
  disable <id>        Disable an extension
  priority <id> <n>   Set extension priority

${dimStyle.render('OPTIONS')}
  --priority <n>      Set priority when adding (default: 10)
  --tags <tags>       Filter search by tags (comma-separated)

${dimStyle.render('EXAMPLES')}
  ${successStyle.render('$')} specify extension list
  ${successStyle.render('$')} specify extension search "code review"
  ${successStyle.render('$')} specify extension search --tags testing,automation
  ${successStyle.render('$')} specify extension add ./my-extension --priority 5
  ${successStyle.render('$')} specify extension info my-extension
  ${successStyle.render('$')} specify extension disable my-extension
`;

const PRESET_HELP = `
${titleStyle.render('specify preset')} - Manage presets

${dimStyle.render('USAGE')}
  specify preset <subcommand> [options]

${dimStyle.render('SUBCOMMANDS')}
  list                List installed presets
  search <query>      Search catalog for presets
  add <path>          Install preset from local directory
  remove <id>         Remove an installed preset
  info <id>           Show preset details
  enable <id>         Enable a disabled preset
  disable <id>        Disable a preset
  priority <id> <n>   Set preset priority

${dimStyle.render('OPTIONS')}
  --priority <n>      Set priority when adding (default: 10)
  --tags <tags>       Filter search by tags (comma-separated)

${dimStyle.render('EXAMPLES')}
  ${successStyle.render('$')} specify preset list
  ${successStyle.render('$')} specify preset search "typescript"
  ${successStyle.render('$')} specify preset search --tags frontend,react
  ${successStyle.render('$')} specify preset add ./my-preset --priority 5
  ${successStyle.render('$')} specify preset info my-preset
  ${successStyle.render('$')} specify preset disable my-preset
`;

const INTEGRATION_HELP = `
${titleStyle.render('specify integration')} - Manage AI agent integrations

${dimStyle.render('USAGE')}
  specify integration <subcommand> [options]

${dimStyle.render('SUBCOMMANDS')}
  list                List all integrations and their status
  add <key>           Add a new agent integration
  remove <key>        Remove an agent integration

${dimStyle.render('SUPPORTED AGENTS')}
  ${SUPPORTED_AGENTS.join(', ')}

${dimStyle.render('EXAMPLES')}
  ${successStyle.render('$')} specify integration list
  ${successStyle.render('$')} specify integration add claude
  ${successStyle.render('$')} specify integration remove gemini
`;

// ============================================================================
// Project Root Helper
// ============================================================================

function requireProjectRoot(): string {
  const root = findProjectRoot(process.cwd());
  if (!root) {
    printError("Not a spec-kit project. Run 'specify init' first.");
    process.exit(1);
  }
  return root;
}

// ============================================================================
// Extension Command Handler
// ============================================================================

async function handleExtensionCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'list': {
      const root = requireProjectRoot();
      const manager = new ExtensionManager(root);
      const extensions = manager.listInstalled();

      if (extensions.length === 0) {
        console.log('No extensions installed.');
        return;
      }

      console.log('Installed extensions:\n');
      console.log(`  ${'ID'.padEnd(18)} ${'VERSION'.padEnd(10)} ${'PRIORITY'.padEnd(10)} STATUS`);
      for (const ext of extensions) {
        console.log(
          `  ${ext.id.padEnd(18)} ${ext.version.padEnd(10)} ${String(ext.priority).padEnd(10)} ${ext.enabled ? 'enabled' : 'disabled'}`,
        );
      }
      console.log(`\n${extensions.length} extension${extensions.length !== 1 ? 's' : ''} installed.`);
      return;
    }

    case 'search': {
      let query = args[1];
      let tags: string[] | undefined;

      // Parse --tags option
      const tagsIdx = args.indexOf('--tags');
      if (tagsIdx !== -1 && args[tagsIdx + 1]) {
        tags = args[tagsIdx + 1].split(',').map(t => t.trim());
        // If query was the tags value, clear it
        if (query === args[tagsIdx + 1]) {
          query = '';
        }
      }

      // If query is a flag, treat as empty
      if (query?.startsWith('--')) {
        query = '';
      }

      try {
        printInfo('Searching extension catalog...');
        const catalog = await fetchCatalog(DEFAULT_EXTENSION_CATALOG);
        const results = searchCatalog(catalog, query || undefined, tags);

        if (results.length === 0) {
          console.log('No extensions found matching your criteria.');
          return;
        }

        console.log(`\nFound ${results.length} extension${results.length !== 1 ? 's' : ''}:\n`);
        console.log(`  ${'NAME'.padEnd(22)} ${'VERSION'.padEnd(10)} ${'AUTHOR'.padEnd(15)} DESCRIPTION`);
        for (const entry of results.slice(0, 20)) {
          const verified = entry.verified ? successStyle.render('✓') : ' ';
          const desc = entry.description.length > 40 ? entry.description.slice(0, 37) + '...' : entry.description;
          console.log(
            `${verified} ${entry.name.padEnd(22)} ${entry.version.padEnd(10)} ${(entry.author || 'unknown').padEnd(15)} ${desc}`,
          );
        }

        if (results.length > 20) {
          console.log(`\n  ... and ${results.length - 20} more. Refine your search to see more.`);
        }

        console.log(`\nInstall with: ${dimStyle.render('specify extension add <url>')}`);
      } catch (err) {
        printError(`Failed to search catalog: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }

    case 'add': {
      const path = args[1];
      if (!path) {
        printError('Usage: specify extension add <path> [--priority <n>]');
        process.exit(1);
      }

      if (!existsSync(path)) {
        printError(`Extension directory not found: ${path}`);
        process.exit(1);
      }

      let priority: number | undefined;
      const priorityIdx = args.indexOf('--priority');
      if (priorityIdx !== -1 && args[priorityIdx + 1]) {
        priority = parseInt(args[priorityIdx + 1], 10);
        if (isNaN(priority)) {
          printError(`Invalid priority value: ${args[priorityIdx + 1]}`);
          process.exit(1);
        }
      }

      const root = requireProjectRoot();
      const manager = new ExtensionManager(root);

      try {
        const manifest = await manager.installFromDirectory(path, VERSION, true, priority);
        printSuccess(`Extension '${manifest.id}' installed successfully.`);
      } catch (err: unknown) {
        printError((err as Error).message);
        process.exit(1);
      }
      return;
    }

    case 'remove': {
      const id = args[1];
      if (!id) {
        printError('Usage: specify extension remove <id>');
        process.exit(1);
      }

      const root = requireProjectRoot();
      const manager = new ExtensionManager(root);

      try {
        await manager.remove(id);
        printSuccess(`Extension '${id}' removed successfully.`);
      } catch (err: unknown) {
        printError(`Extension not found: ${id}`);
        process.exit(1);
      }
      return;
    }

    case 'info': {
      const id = args[1];
      if (!id) {
        printError('Usage: specify extension info <id>');
        process.exit(1);
      }

      const root = requireProjectRoot();
      const manager = new ExtensionManager(root);
      const manifest = manager.getExtension(id);

      if (!manifest) {
        printError(`Extension not found: ${id}`);
        process.exit(1);
      }

      const metadata = manager.registry.get(id);
      const commands = manifest.commands.map(c => c.name.replace(`speckit.${id}.`, '')).join(', ');

      console.log(`Extension: ${manifest.name}`);
      console.log(`  Version:     ${manifest.version}`);
      console.log(`  Description: ${manifest.description}`);
      console.log(`  Priority:    ${metadata?.priority ?? 10}`);
      console.log(`  Status:      ${metadata?.enabled !== false ? 'enabled' : 'disabled'}`);
      console.log(`  Commands:    ${commands || 'none'}`);
      console.log(`  Installed:   ${metadata?.installed_at || 'unknown'}`);
      return;
    }

    case 'enable': {
      const id = args[1];
      if (!id) {
        printError('Usage: specify extension enable <id>');
        process.exit(1);
      }

      const root = requireProjectRoot();
      const manager = new ExtensionManager(root);

      try {
        manager.enable(id);
        printSuccess(`Extension '${id}' enabled.`);
      } catch (err: unknown) {
        printError(`Extension not found: ${id}`);
        process.exit(1);
      }
      return;
    }

    case 'disable': {
      const id = args[1];
      if (!id) {
        printError('Usage: specify extension disable <id>');
        process.exit(1);
      }

      const root = requireProjectRoot();
      const manager = new ExtensionManager(root);

      try {
        manager.disable(id);
        printSuccess(`Extension '${id}' disabled.`);
      } catch (err: unknown) {
        printError(`Extension not found: ${id}`);
        process.exit(1);
      }
      return;
    }

    case 'priority': {
      const id = args[1];
      const value = args[2];
      if (!id || !value) {
        printError('Usage: specify extension priority <id> <number>');
        process.exit(1);
      }

      const priority = parseInt(value, 10);
      if (isNaN(priority)) {
        printError(`Invalid priority value: ${value}`);
        process.exit(1);
      }

      const root = requireProjectRoot();
      const manager = new ExtensionManager(root);

      try {
        manager.setPriority(id, priority);
        printSuccess(`Extension '${id}' priority set to ${priority}.`);
      } catch (err: unknown) {
        printError(`Extension not found: ${id}`);
        process.exit(1);
      }
      return;
    }

    default: {
      printError(`Unknown extension subcommand: '${subcommand}'. Run 'specify extension --help' for usage.`);
      process.exit(1);
    }
  }
}

// ============================================================================
// Preset Command Handler
// ============================================================================

async function handlePresetCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'list': {
      const root = requireProjectRoot();
      const manager = new PresetManager(root);
      const presets = manager.listInstalled();

      if (presets.length === 0) {
        console.log('No presets installed.');
        return;
      }

      console.log('Installed presets:\n');
      console.log(`  ${'ID'.padEnd(18)} ${'VERSION'.padEnd(10)} ${'PRIORITY'.padEnd(10)} STATUS`);
      for (const preset of presets) {
        console.log(
          `  ${preset.id.padEnd(18)} ${preset.version.padEnd(10)} ${String(preset.priority).padEnd(10)} ${preset.enabled ? 'enabled' : 'disabled'}`,
        );
      }
      console.log(`\n${presets.length} preset${presets.length !== 1 ? 's' : ''} installed.`);
      return;
    }

    case 'search': {
      let query = args[1];
      let tags: string[] | undefined;

      // Parse --tags option
      const tagsIdx = args.indexOf('--tags');
      if (tagsIdx !== -1 && args[tagsIdx + 1]) {
        tags = args[tagsIdx + 1].split(',').map(t => t.trim());
        if (query === args[tagsIdx + 1]) {
          query = '';
        }
      }

      if (query?.startsWith('--')) {
        query = '';
      }

      try {
        printInfo('Searching preset catalog...');
        const catalog = await fetchCatalog(DEFAULT_PRESET_CATALOG);
        const results = searchCatalog(catalog, query || undefined, tags);

        if (results.length === 0) {
          console.log('No presets found matching your criteria.');
          return;
        }

        console.log(`\nFound ${results.length} preset${results.length !== 1 ? 's' : ''}:\n`);
        console.log(`  ${'NAME'.padEnd(22)} ${'VERSION'.padEnd(10)} ${'AUTHOR'.padEnd(15)} DESCRIPTION`);
        for (const entry of results.slice(0, 20)) {
          const verified = entry.verified ? successStyle.render('✓') : ' ';
          const desc = entry.description.length > 40 ? entry.description.slice(0, 37) + '...' : entry.description;
          console.log(
            `${verified} ${entry.name.padEnd(22)} ${entry.version.padEnd(10)} ${(entry.author || 'unknown').padEnd(15)} ${desc}`,
          );
        }

        if (results.length > 20) {
          console.log(`\n  ... and ${results.length - 20} more. Refine your search to see more.`);
        }

        console.log(`\nInstall with: ${dimStyle.render('specify preset add <url>')}`);
      } catch (err) {
        printError(`Failed to search catalog: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }

    case 'add': {
      const path = args[1];
      if (!path) {
        printError('Usage: specify preset add <path> [--priority <n>]');
        process.exit(1);
      }

      if (!existsSync(path)) {
        printError(`Preset directory not found: ${path}`);
        process.exit(1);
      }

      let priority: number | undefined;
      const priorityIdx = args.indexOf('--priority');
      if (priorityIdx !== -1 && args[priorityIdx + 1]) {
        priority = parseInt(args[priorityIdx + 1], 10);
        if (isNaN(priority)) {
          printError(`Invalid priority value: ${args[priorityIdx + 1]}`);
          process.exit(1);
        }
      }

      const root = requireProjectRoot();
      const manager = new PresetManager(root);

      try {
        const manifest = manager.installFromDirectory(path, VERSION, priority);
        printSuccess(`Preset '${manifest.id}' installed successfully.`);
      } catch (err: unknown) {
        printError((err as Error).message);
        process.exit(1);
      }
      return;
    }

    case 'remove': {
      const id = args[1];
      if (!id) {
        printError('Usage: specify preset remove <id>');
        process.exit(1);
      }

      const root = requireProjectRoot();
      const manager = new PresetManager(root);

      try {
        manager.remove(id);
        printSuccess(`Preset '${id}' removed successfully.`);
      } catch (err: unknown) {
        printError(`Preset not found: ${id}`);
        process.exit(1);
      }
      return;
    }

    case 'info': {
      const id = args[1];
      if (!id) {
        printError('Usage: specify preset info <id>');
        process.exit(1);
      }

      const root = requireProjectRoot();
      const manager = new PresetManager(root);
      const manifest = manager.getPreset(id);

      if (!manifest) {
        printError(`Preset not found: ${id}`);
        process.exit(1);
      }

      const metadata = manager.registry.get(id);
      const templates = manifest.templates.map(t => t.name).join(', ');

      console.log(`Preset: ${manifest.name}`);
      console.log(`  Version:     ${manifest.version}`);
      console.log(`  Description: ${manifest.description}`);
      console.log(`  Priority:    ${metadata?.priority ?? 10}`);
      console.log(`  Status:      ${metadata?.enabled !== false ? 'enabled' : 'disabled'}`);
      console.log(`  Templates:   ${templates || 'none'}`);
      console.log(`  Installed:   ${metadata?.installed_at || 'unknown'}`);
      return;
    }

    case 'enable': {
      const id = args[1];
      if (!id) {
        printError('Usage: specify preset enable <id>');
        process.exit(1);
      }

      const root = requireProjectRoot();
      const manager = new PresetManager(root);

      try {
        manager.enable(id);
        printSuccess(`Preset '${id}' enabled.`);
      } catch (err: unknown) {
        printError(`Preset not found: ${id}`);
        process.exit(1);
      }
      return;
    }

    case 'disable': {
      const id = args[1];
      if (!id) {
        printError('Usage: specify preset disable <id>');
        process.exit(1);
      }

      const root = requireProjectRoot();
      const manager = new PresetManager(root);

      try {
        manager.disable(id);
        printSuccess(`Preset '${id}' disabled.`);
      } catch (err: unknown) {
        printError(`Preset not found: ${id}`);
        process.exit(1);
      }
      return;
    }

    case 'priority': {
      const id = args[1];
      const value = args[2];
      if (!id || !value) {
        printError('Usage: specify preset priority <id> <number>');
        process.exit(1);
      }

      const priority = parseInt(value, 10);
      if (isNaN(priority)) {
        printError(`Invalid priority value: ${value}`);
        process.exit(1);
      }

      const root = requireProjectRoot();
      const manager = new PresetManager(root);

      try {
        manager.setPriority(id, priority);
        printSuccess(`Preset '${id}' priority set to ${priority}.`);
      } catch (err: unknown) {
        printError(`Preset not found: ${id}`);
        process.exit(1);
      }
      return;
    }

    default: {
      printError(`Unknown preset subcommand: '${subcommand}'. Run 'specify preset --help' for usage.`);
      process.exit(1);
    }
  }
}

// ============================================================================
// Integration Command Handler
// ============================================================================

async function handleIntegrationCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'list': {
      const root = requireProjectRoot();
      const integrations = listIntegrations(root);

      console.log('AI Agent Integrations:\n');
      console.log(`  ${'AGENT'.padEnd(15)} ${'DIRECTORY'.padEnd(25)} ${'FORMAT'.padEnd(10)} STATUS`);
      for (const intg of integrations) {
        const status = intg.installed 
          ? `installed${intg.files_count ? ` (${intg.files_count} files)` : ''}`
          : 'not installed';
        console.log(
          `  ${intg.key.padEnd(15)} ${intg.directory.padEnd(25)} ${intg.format.padEnd(10)} ${status}`,
        );
      }
      console.log(`\n${integrations.filter(i => i.installed).length}/${integrations.length} integrations installed.`);
      return;
    }

    case 'add': {
      const key = args[1];
      if (!key) {
        printError('Usage: specify integration add <key>');
        printInfo(`Supported: ${SUPPORTED_AGENTS.join(', ')}`);
        process.exit(1);
      }

      const root = requireProjectRoot();

      try {
        const manifest = await addIntegration(root, key);
        printSuccess(`Integration '${key}' added successfully (${manifest.files.length} files).`);
      } catch (err: unknown) {
        printError((err as Error).message);
        process.exit(1);
      }
      return;
    }

    case 'remove':
    case 'uninstall': {
      const key = args[1];
      if (!key) {
        printError('Usage: specify integration remove <key>');
        process.exit(1);
      }

      const root = requireProjectRoot();

      try {
        await removeIntegration(root, key);
        printSuccess(`Integration '${key}' removed successfully.`);
      } catch (err: unknown) {
        printError((err as Error).message);
        process.exit(1);
      }
      return;
    }

    case 'info': {
      const key = args[1];
      if (!key) {
        printError('Usage: specify integration info <key>');
        process.exit(1);
      }

      const root = requireProjectRoot();
      const info = getIntegrationInfo(root, key);

      if (!info) {
        printError(`Unknown integration: ${key}`);
        printInfo(`Supported: ${SUPPORTED_AGENTS.join(', ')}`);
        process.exit(1);
      }

      console.log(`Integration: ${info.name}`);
      console.log(`  Key:        ${info.key}`);
      console.log(`  Directory:  ${info.directory}`);
      console.log(`  Format:     ${info.format}`);
      console.log(`  Status:     ${info.installed ? 'installed' : 'not installed'}`);
      if (info.files_count) {
        console.log(`  Files:      ${info.files_count}`);
      }
      return;
    }

    default: {
      printError(`Unknown integration subcommand: '${subcommand}'. Run 'specify integration --help' for usage.`);
      process.exit(1);
    }
  }
}

// ============================================================================
// Doctor Command Handler
// ============================================================================

async function handleDoctorCommand(): Promise<void> {
  console.log(titleStyle.render('Spec-Kit Doctor') + '\n');

  const cwd = process.cwd();
  let issues = 0;
  let warnings = 0;

  // Check if we're in a spec-kit project
  const projectRoot = findProjectRoot(cwd);

  if (!projectRoot) {
    printError('Not a spec-kit project. Run "specify init" first.');
    console.log('\nDiagnosis: No .specify directory found in current or parent directories.\n');
    process.exit(1);
  }

  console.log(successStyle.render('✓') + ' Found spec-kit project at: ' + dimStyle.render(projectRoot));

  // Check .specify directory structure
  const requiredDirs = [
    '.specify',
    '.specify/templates',
    '.specify/scripts',
    '.specify/memory',
  ];

  for (const dir of requiredDirs) {
    const fullPath = join(projectRoot, dir);
    if (existsSync(fullPath)) {
      console.log(successStyle.render('✓') + ` Directory exists: ${dimStyle.render(dir)}`);
    } else {
      printError(`Missing directory: ${dir}`);
      issues++;
    }
  }

  // Check init options
  const initOptions = loadInitOptions(projectRoot);
  if (initOptions) {
    console.log(successStyle.render('✓') + ` Configuration found: agent=${initOptions.agent}, scripts=${initOptions.scriptType}`);
  } else {
    console.log(warningStyle.render('⚠') + ' No init-options.json found (project may need re-init)');
    warnings++;
  }

  // Check agent integration directories
  if (initOptions?.agent) {
    const agentConfig = AGENT_CONFIGS[initOptions.agent];
    if (agentConfig) {
      const agentDir = join(projectRoot, agentConfig.dir);
      if (existsSync(agentDir)) {
        const commands = readdirSync(agentDir).filter(f => f.endsWith('.md') || f.endsWith('.toml') || f.endsWith('.yaml'));
        console.log(successStyle.render('✓') + ` Agent ${initOptions.agent}: ${commands.length} command(s) registered`);
      } else {
        printError(`Agent directory missing: ${agentConfig.dir}`);
        issues++;
      }
    }
  }

  // Check for extensions
  const extensionDir = join(projectRoot, '.specify', 'extensions');
  if (existsSync(extensionDir)) {
    const extDirs = readdirSync(extensionDir, { withFileTypes: true }).filter(d => d.isDirectory());
    console.log(successStyle.render('✓') + ` Extensions directory: ${extDirs.length} extension(s) found`);
  }

  // Check for presets
  const presetDir = join(projectRoot, '.specify', 'presets');
  if (existsSync(presetDir)) {
    const presetDirs = readdirSync(presetDir, { withFileTypes: true }).filter(d => d.isDirectory());
    console.log(successStyle.render('✓') + ` Presets directory: ${presetDirs.length} preset(s) found`);
  }

  // Check git
  const gitDir = join(projectRoot, '.git');
  if (existsSync(gitDir)) {
    console.log(successStyle.render('✓') + ' Git repository initialized');
  } else {
    console.log(warningStyle.render('⚠') + ' No git repository (consider running "git init")');
    warnings++;
  }

  // Summary
  console.log('\n' + dimStyle.render('─'.repeat(50)));
  if (issues === 0 && warnings === 0) {
    printSuccess('No issues found! Your spec-kit project is healthy.');
  } else if (issues === 0) {
    console.log(warningStyle.render(`${warnings} warning(s), 0 issues. Project is functional.`));
  } else {
    printError(`${issues} issue(s), ${warnings} warning(s). Run "specify check" to attempt fixes.`);
    process.exit(1);
  }
}

// ============================================================================
// Status Command Handler
// ============================================================================

async function handleStatusCommand(): Promise<void> {
  const cwd = process.cwd();
  const projectRoot = findProjectRoot(cwd);

  if (!projectRoot) {
    printError('Not a spec-kit project. Run "specify init" first.');
    process.exit(1);
  }

  await printBanner();
  console.log(titleStyle.render('Project Status') + '\n');

  // Load init options
  const initOptions = loadInitOptions(projectRoot);

  // Basic info
  console.log(dimStyle.render('Project Root:') + ' ' + projectRoot);
  console.log(dimStyle.render('Agent:       ') + ' ' + (initOptions?.agent || 'unknown'));
  console.log(dimStyle.render('Scripts:     ') + ' ' + (initOptions?.scriptType || 'sh'));
  console.log(dimStyle.render('Version:     ') + ' ' + VERSION);

  // Integrations
  console.log('\n' + titleStyle.render('Integrations'));
  const integrations = listIntegrations(projectRoot);
  const installed = integrations.filter(i => i.installed);
  const notInstalled = integrations.filter(i => !i.installed);

  if (installed.length > 0) {
    console.log(dimStyle.render('Installed:'));
    for (const intg of installed) {
      const filesInfo = intg.files_count ? ` (${intg.files_count} files)` : '';
      console.log(`  ${successStyle.render('●')} ${intg.key.padEnd(12)} ${dimStyle.render(intg.directory)}${filesInfo}`);
    }
  }

  console.log(dimStyle.render(`Available:   `) + `${notInstalled.length} agent(s) not configured`);

  // Extensions
  console.log('\n' + titleStyle.render('Extensions'));
  const manager = new ExtensionManager(projectRoot);
  const extensions = manager.listInstalled();

  if (extensions.length === 0) {
    console.log(dimStyle.render('  No extensions installed.'));
  } else {
    for (const ext of extensions) {
      const status = ext.enabled ? successStyle.render('●') : dimStyle.render('○');
      console.log(`  ${status} ${ext.id} v${ext.version}`);
    }
  }

  // Presets
  console.log('\n' + titleStyle.render('Presets'));
  const presetManager = new PresetManager(projectRoot);
  const presets = presetManager.listInstalled();

  if (presets.length === 0) {
    console.log(dimStyle.render('  No presets installed.'));
  } else {
    for (const preset of presets) {
      const status = preset.enabled ? successStyle.render('●') : dimStyle.render('○');
      console.log(`  ${status} ${preset.id} v${preset.version}`);
    }
  }

  // Memory stats
  const memoryDir = join(projectRoot, '.specify', 'memory');
  if (existsSync(memoryDir)) {
    const memoryFiles = readdirSync(memoryDir);
    console.log('\n' + titleStyle.render('Memory'));
    console.log(dimStyle.render('  Files:') + ` ${memoryFiles.length}`);
  }

  console.log('');
}

// ============================================================================
// Main CLI
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // No args - show help
  if (args.length === 0) {
    console.log(HELP);
    return;
  }

  const command = args[0];

  // Global flags
  if (command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  if (command === '--version' || command === 'version') {
    await printBanner();
    console.log(`specify v${VERSION}`);
    return;
  }

  // Commands
  switch (command) {
    case 'init': {
      const initArgs = args.slice(1);

      // Check for help flag
      if (initArgs.includes('--help') || initArgs.includes('-h')) {
        console.log(INIT_HELP);
        return;
      }

      const options = parseInitArgs(initArgs);
      const success = await init(options);
      process.exit(success ? 0 : 1);
    }

    case 'check': {
      const success = await check();
      process.exit(success ? 0 : 1);
    }

    case 'doctor': {
      await handleDoctorCommand();
      return;
    }

    case 'status': {
      await handleStatusCommand();
      return;
    }

    case 'extension': {
      const extArgs = args.slice(1);
      if (extArgs.length === 0 || extArgs.includes('--help') || extArgs.includes('-h')) {
        console.log(EXTENSION_HELP);
        return;
      }
      await handleExtensionCommand(extArgs);
      return;
    }

    case 'preset': {
      const presetArgs = args.slice(1);
      if (presetArgs.length === 0 || presetArgs.includes('--help') || presetArgs.includes('-h')) {
        console.log(PRESET_HELP);
        return;
      }
      await handlePresetCommand(presetArgs);
      return;
    }

    case 'integration': {
      const intgArgs = args.slice(1);
      if (intgArgs.length === 0 || intgArgs.includes('--help') || intgArgs.includes('-h')) {
        console.log(INTEGRATION_HELP);
        return;
      }
      await handleIntegrationCommand(intgArgs);
      return;
    }

    default: {
      printError(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
    }
  }
}

// Run
main().catch((error) => {
  printError(`Unexpected error: ${error.message}`);
  process.exit(1);
});
