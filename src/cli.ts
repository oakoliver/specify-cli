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
import { printError, titleStyle, dimStyle, successStyle } from './ui.js';
import { SUPPORTED_AGENTS } from './types.js';

// ============================================================================
// Version and Help
// ============================================================================

const VERSION = '1.0.0';

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
      // TODO: Implement extension command
      printError('extension command not yet implemented');
      process.exit(1);
    }

    case 'preset': {
      // TODO: Implement preset command
      printError('preset command not yet implemented');
      process.exit(1);
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
