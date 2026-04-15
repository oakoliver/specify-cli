/**
 * @oakoliver/specify-cli - Init Command
 *
 * Initializes a new spec-driven development project.
 *
 * @module init
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execSync } from 'node:child_process';

import { NewSelect, NewOption, Run } from '@oakoliver/huh';

import {
  SUPPORTED_AGENTS,
  AGENT_CONFIGS,
  type InitOptions,
  type CommandDefinition,
} from './types.js';
import { saveInitOptions } from './config.js';
import { registerCommands, parseFrontmatter } from './registrar.js';
import { copyTemplatesToProject, getCommandTemplate, getAvailableCommands } from './templates.js';
import {
  printBanner,
  printStep,
  printSuccess,
  printError,
  printWarning,
  printNextSteps,
  printInfo,
} from './ui.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for the init command.
 */
export interface InitCommandOptions {
  /** Project name or path */
  projectName?: string;
  /** AI agent to configure */
  ai?: string;
  /** Initialize in current directory */
  here?: boolean;
  /** Force init in non-empty directory */
  force?: boolean;
  /** Shell script type */
  script?: 'sh' | 'ps';
  /** Branch numbering mode */
  branchNumbering?: 'sequential' | 'timestamp';
  /** Skip git initialization */
  noGit?: boolean;
  /** Use bundled templates only (no network) */
  offline?: boolean;
  /** Generate SKILL.md files for skill-based agents */
  aiSkills?: boolean;
  /** Show verbose output */
  verbose?: boolean;
}

// ============================================================================
// Argument Parsing
// ============================================================================

/**
 * Parse command line arguments for init command.
 */
export function parseInitArgs(args: string[]): InitCommandOptions {
  const opts: InitCommandOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--ai' && args[i + 1]) {
      opts.ai = args[++i];
    } else if (arg === '--here') {
      opts.here = true;
    } else if (arg === '--force' || arg === '-f') {
      opts.force = true;
    } else if (arg === '--script' && args[i + 1]) {
      opts.script = args[++i] as 'sh' | 'ps';
    } else if (arg === '--branch-numbering' && args[i + 1]) {
      opts.branchNumbering = args[++i] as 'sequential' | 'timestamp';
    } else if (arg === '--no-git') {
      opts.noGit = true;
    } else if (arg === '--offline') {
      opts.offline = true;
    } else if (arg === '--ai-skills') {
      opts.aiSkills = true;
    } else if (arg === '--verbose' || arg === '-v') {
      opts.verbose = true;
    } else if (!arg.startsWith('-') && !opts.projectName) {
      opts.projectName = arg;
    }
  }

  return opts;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate init options.
 */
function validateOptions(opts: InitCommandOptions): string | null {
  // Validate agent name
  if (opts.ai && !SUPPORTED_AGENTS.includes(opts.ai as any)) {
    const similar = SUPPORTED_AGENTS.filter(a =>
      a.toLowerCase().includes(opts.ai!.toLowerCase()) ||
      opts.ai!.toLowerCase().includes(a.toLowerCase())
    );
    if (similar.length > 0) {
      return `Unknown agent: "${opts.ai}". Did you mean: ${similar.join(', ')}?`;
    }
    return `Unknown agent: "${opts.ai}". Supported agents: ${SUPPORTED_AGENTS.join(', ')}`;
  }

  // Validate script type
  if (opts.script && !['sh', 'ps'].includes(opts.script)) {
    return `Invalid script type: "${opts.script}". Use "sh" or "ps".`;
  }

  // Validate branch numbering
  if (opts.branchNumbering && !['sequential', 'timestamp'].includes(opts.branchNumbering)) {
    return `Invalid branch numbering: "${opts.branchNumbering}". Use "sequential" or "timestamp".`;
  }

  return null;
}

// ============================================================================
// Interactive Selection
// ============================================================================

/**
 * Interactively select an AI agent using @oakoliver/huh.
 */
async function selectAgent(): Promise<string> {
  const options = SUPPORTED_AGENTS.map(agent => NewOption(agent, agent));

  const select = NewSelect('copilot')
    .title('AI Assistant')
    .description('Select the AI coding agent to configure')
    .options(options)
    .height(10);

  await Run(select);

  return select.getValue();
}

// ============================================================================
// Directory Operations
// ============================================================================

/**
 * Check if a directory is empty.
 */
function isDirectoryEmpty(dir: string): boolean {
  if (!existsSync(dir)) {
    return true;
  }
  const entries = readdirSync(dir);
  // Ignore common hidden files
  const significant = entries.filter(e => !e.startsWith('.') || e === '.git');
  return significant.length === 0;
}

/**
 * Create the project directory structure.
 */
function createDirectoryStructure(projectRoot: string): void {
  const dirs = [
    '.specify',
    '.specify/templates',
    '.specify/templates/commands',
    '.specify/scripts',
    '.specify/memory',
    '.specify/extensions',
    '.specify/presets',
    'specs',
  ];

  for (const dir of dirs) {
    const fullPath = join(projectRoot, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }
}

// ============================================================================
// Git Operations
// ============================================================================

/**
 * Initialize git repository.
 */
function initGit(projectRoot: string): boolean {
  try {
    // Check if git is available
    execSync('git --version', { stdio: 'ignore' });

    // Check if already a git repo
    if (existsSync(join(projectRoot, '.git'))) {
      return true; // Already initialized
    }

    // Initialize
    execSync('git init', { cwd: projectRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Add spec-kit entries to .gitignore.
 */
function updateGitignore(projectRoot: string): void {
  const gitignorePath = join(projectRoot, '.gitignore');
  const specKitEntries = `
# Spec-Kit
.specify/extensions/*/
.specify/presets/*/
`;

  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8');
    if (!content.includes('# Spec-Kit')) {
      writeFileSync(gitignorePath, content + specKitEntries, 'utf-8');
    }
  } else {
    writeFileSync(gitignorePath, specKitEntries.trim() + '\n', 'utf-8');
  }
}

// ============================================================================
// Command Registration
// ============================================================================

/**
 * Build command definitions from templates.
 */
function buildCommandDefinitions(agentArgs: string): CommandDefinition[] {
  const commandNames = getAvailableCommands();
  const commands: CommandDefinition[] = [];

  for (const name of commandNames) {
    const content = getCommandTemplate(name, agentArgs);
    if (!content) continue;

    const { frontmatter, body } = parseFrontmatter(content);

    commands.push({
      name,
      description: (frontmatter.description as string) || '',
      content: body,
      handoffs: frontmatter.handoffs as string[] | undefined,
    });
  }

  return commands;
}

// ============================================================================
// Constitution Template
// ============================================================================

const DEFAULT_CONSTITUTION = `# Project Constitution

## Mission

[Describe the project's mission and goals]

## Core Principles

### I. [First Principle]

[Description of the first guiding principle]

### II. [Second Principle]

[Description of the second guiding principle]

## Development Workflow

- Tests written using \`bun test\`
- All user stories MUST have corresponding acceptance tests

## Quality Gates

### Pre-Commit

- TypeScript compilation MUST pass
- All tests MUST pass

## Governance

This constitution supersedes all other practices. Amendments require documentation.

**Version**: 1.0.0 | **Ratified**: ${new Date().toISOString().split('T')[0]}
`;

// ============================================================================
// Main Init Function
// ============================================================================

/**
 * Initialize a new spec-driven development project.
 *
 * @param options - Init options
 * @returns True if successful
 */
export async function init(options: InitCommandOptions = {}): Promise<boolean> {
  // Print banner
  await printBanner();
  console.log();

  // Validate options
  const validationError = validateOptions(options);
  if (validationError) {
    printError(validationError);
    return false;
  }

  // Determine project root
  let projectRoot: string;
  const cwd = process.cwd();

  if (options.projectName === '.') {
    // Explicit "." means current directory
    projectRoot = cwd;
    options.here = true;
  } else if (options.projectName) {
    // Explicit path provided - use it (whether --here or not)
    projectRoot = resolve(cwd, options.projectName);
  } else if (options.here) {
    // --here without path means current directory
    projectRoot = cwd;
  } else {
    // Default to current directory
    projectRoot = cwd;
    options.here = true;
  }

  const projectName = basename(projectRoot);

  // Check if directory is empty (unless --force or --here in existing project)
  if (!options.here && existsSync(projectRoot) && !isDirectoryEmpty(projectRoot)) {
    if (!options.force) {
      printError(`Directory "${projectName}" is not empty. Use --force to override.`);
      return false;
    }
  }

  // Check if already initialized
  if (existsSync(join(projectRoot, '.specify'))) {
    if (!options.force) {
      printError('Project already initialized. Use --force to reinitialize.');
      return false;
    }
    printWarning('Reinitializing existing project...');
  }

  // Get agent (interactive selection if not provided)
  let agent: string;

  if (options.ai) {
    agent = options.ai;
  } else {
    // Interactive selection with @oakoliver/huh
    try {
      agent = await selectAgent();
    } catch (error) {
      // If interactive selection fails (e.g., non-TTY), default to copilot
      agent = 'copilot';
      printInfo(`Using default agent: ${agent}`);
    }
  }

  // Determine options
  const scriptType = options.script || 'sh';
  const branchNumbering = options.branchNumbering || 'sequential';
  const aiSkills = options.aiSkills || false;

  console.log();
  console.log(`Initializing ${projectName} with ${agent}...`);
  console.log();

  // Step 1: Create directory structure
  printStep('Creating directory structure', 'pending');
  try {
    if (!existsSync(projectRoot)) {
      mkdirSync(projectRoot, { recursive: true });
    }
    createDirectoryStructure(projectRoot);
    printStep('Creating directory structure', 'done');
  } catch (error) {
    printStep('Creating directory structure', 'error');
    printError(`Failed to create directories: ${error}`);
    return false;
  }

  // Step 2: Copy templates
  printStep('Copying templates', 'pending');
  try {
    const agentConfig = AGENT_CONFIGS[agent];
    const agentArgs = agentConfig ? agentConfig.args : '$ARGUMENTS';
    copyTemplatesToProject(projectRoot, {
      scriptType,
      agent,
      agentArgs,
    });
    printStep('Copying templates', 'done');
  } catch (error) {
    printStep('Copying templates', 'error');
    printError(`Failed to copy templates: ${error}`);
    return false;
  }

  // Step 3: Create constitution
  printStep('Creating constitution', 'pending');
  try {
    const constitutionPath = join(projectRoot, '.specify', 'memory', 'constitution.md');
    if (!existsSync(constitutionPath)) {
      writeFileSync(constitutionPath, DEFAULT_CONSTITUTION, 'utf-8');
    }
    printStep('Creating constitution', 'done');
  } catch (error) {
    printStep('Creating constitution', 'error');
    printError(`Failed to create constitution: ${error}`);
    return false;
  }

  // Step 4: Register commands for agent
  printStep(`Registering commands for ${agent}`, 'pending');
  try {
    const agentConfig = AGENT_CONFIGS[agent];
    const agentArgs = agentConfig ? agentConfig.args : '$ARGUMENTS';
    const commands = buildCommandDefinitions(agentArgs);

    if (commands.length > 0) {
      await registerCommands(agent, commands, projectRoot, 'core');
      printStep(`Registering commands for ${agent}`, 'done');
    } else {
      printStep(`Registering commands for ${agent}`, 'skip');
      printWarning('No command templates found');
    }
  } catch (error) {
    printStep(`Registering commands for ${agent}`, 'error');
    printError(`Failed to register commands: ${error}`);
    return false;
  }

  // Step 5: Save init options
  printStep('Saving configuration', 'pending');
  try {
    const initOpts: InitOptions = {
      ai: agent,
      script: scriptType,
      branch_numbering: branchNumbering,
      ai_skills: aiSkills,
      ai_commands_dir: null,
      here: options.here || false,
      offline: options.offline || false,
      preset: null,
      speckit_version: '1.1.0', // TypeScript port version
    };
    saveInitOptions(projectRoot, initOpts);
    printStep('Saving configuration', 'done');
  } catch (error) {
    printStep('Saving configuration', 'error');
    printError(`Failed to save configuration: ${error}`);
    return false;
  }

  // Step 6: Initialize git (unless --no-git)
  if (!options.noGit) {
    printStep('Initializing git', 'pending');
    const gitSuccess = initGit(projectRoot);
    if (gitSuccess) {
      updateGitignore(projectRoot);
      printStep('Initializing git', 'done');
    } else {
      printStep('Initializing git', 'skip');
      printWarning('Git not available or initialization failed');
    }
  } else {
    printStep('Initializing git', 'skip');
  }

  // Success!
  printSuccess('Project initialized!');
  printNextSteps(projectRoot, agent);

  return true;
}
