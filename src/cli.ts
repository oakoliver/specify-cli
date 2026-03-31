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
import { printError, printSuccess, printInfo, titleStyle, dimStyle, successStyle, printBanner } from './ui.js';
import { SUPPORTED_AGENTS } from './types.js';
import { ExtensionManager } from './extension.js';
import { PresetManager } from './preset.js';
import { findProjectRoot } from './config.js';
import { existsSync } from 'node:fs';

// ============================================================================
// Version and Help
// ============================================================================

const VERSION = '1.0.4';

const HELP = `
${titleStyle.render('specify')} - Spec-Driven Development CLI

${dimStyle.render('USAGE')}
  specify <command> [options]

${dimStyle.render('COMMANDS')}
  init [project]    Initialize a new spec-kit project
  check             Check project setup and fix issues
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
  add <path>          Install extension from local directory
  remove <id>         Remove an installed extension
  info <id>           Show extension details
  enable <id>         Enable a disabled extension
  disable <id>        Disable an extension
  priority <id> <n>   Set extension priority

${dimStyle.render('OPTIONS')}
  --priority <n>      Set priority when adding (default: 10)

${dimStyle.render('EXAMPLES')}
  ${successStyle.render('$')} specify extension list
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
  add <path>          Install preset from local directory
  remove <id>         Remove an installed preset
  info <id>           Show preset details
  enable <id>         Enable a disabled preset
  disable <id>        Disable a preset
  priority <id> <n>   Set preset priority

${dimStyle.render('OPTIONS')}
  --priority <n>      Set priority when adding (default: 10)

${dimStyle.render('EXAMPLES')}
  ${successStyle.render('$')} specify preset list
  ${successStyle.render('$')} specify preset add ./my-preset --priority 5
  ${successStyle.render('$')} specify preset info my-preset
  ${successStyle.render('$')} specify preset disable my-preset
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
