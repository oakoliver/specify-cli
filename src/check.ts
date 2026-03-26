/**
 * @oakoliver/specify-cli - Check Command
 *
 * Verifies project setup and required tools.
 *
 * @module check
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

import { loadInitOptions, isSpeckitProject, findProjectRoot, SPECKIT_DIR } from './config.js';
import { AGENT_CONFIGS } from './types.js';
import {
  printBanner,
  printStep,
  printSuccess,
  printError,
  printWarning,
  titleStyle,
} from './ui.js';

// ============================================================================
// Types
// ============================================================================

export interface CheckResult {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message?: string;
}

// ============================================================================
// Tool Checking
// ============================================================================

/**
 * Check if a command-line tool is available.
 */
function checkTool(name: string): boolean {
  try {
    execSync(`${name} --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if git is installed and available.
 */
function checkGit(): CheckResult {
  if (checkTool('git')) {
    return { name: 'git', status: 'ok' };
  }
  return {
    name: 'git',
    status: 'warning',
    message: 'Git not found. Some features may not work.',
  };
}

/**
 * Check if GitHub CLI is installed.
 */
function checkGitHubCli(): CheckResult {
  if (checkTool('gh')) {
    return { name: 'gh (GitHub CLI)', status: 'ok' };
  }
  return {
    name: 'gh (GitHub CLI)',
    status: 'warning',
    message: 'GitHub CLI not found. /speckit.taskstoissues will not work.',
  };
}

// ============================================================================
// Project Checking
// ============================================================================

/**
 * Check project structure.
 */
function checkProjectStructure(projectRoot: string): CheckResult[] {
  const results: CheckResult[] = [];

  // Check .specify directory
  if (existsSync(join(projectRoot, SPECKIT_DIR))) {
    results.push({ name: '.specify directory', status: 'ok' });
  } else {
    results.push({
      name: '.specify directory',
      status: 'error',
      message: 'Not found. Run `specify init` to initialize.',
    });
    return results; // Stop checking if not initialized
  }

  // Check init-options.json
  const initOptions = loadInitOptions(projectRoot);
  if (initOptions.ai) {
    results.push({ name: 'init-options.json', status: 'ok' });
  } else {
    results.push({
      name: 'init-options.json',
      status: 'warning',
      message: 'Missing or invalid. Run `specify init --force` to reinitialize.',
    });
  }

  // Check templates directory
  if (existsSync(join(projectRoot, SPECKIT_DIR, 'templates'))) {
    results.push({ name: 'templates directory', status: 'ok' });
  } else {
    results.push({
      name: 'templates directory',
      status: 'warning',
      message: 'Templates not found.',
    });
  }

  // Check scripts directory
  if (existsSync(join(projectRoot, SPECKIT_DIR, 'scripts'))) {
    results.push({ name: 'scripts directory', status: 'ok' });
  } else {
    results.push({
      name: 'scripts directory',
      status: 'warning',
      message: 'Scripts not found.',
    });
  }

  // Check agent commands
  const agentConfig = AGENT_CONFIGS[initOptions.ai];
  if (agentConfig) {
    const commandsDir = join(projectRoot, agentConfig.dir);
    if (existsSync(commandsDir)) {
      results.push({ name: `${initOptions.ai} commands`, status: 'ok' });
    } else {
      results.push({
        name: `${initOptions.ai} commands`,
        status: 'warning',
        message: `Commands directory not found at ${agentConfig.dir}`,
      });
    }
  }

  // Check specs directory
  if (existsSync(join(projectRoot, 'specs'))) {
    results.push({ name: 'specs directory', status: 'ok' });
  } else {
    results.push({
      name: 'specs directory',
      status: 'warning',
      message: 'Specs directory not found.',
    });
  }

  return results;
}

// ============================================================================
// Main Check Function
// ============================================================================

/**
 * Run all checks and report results.
 */
export async function check(): Promise<boolean> {
  await printBanner();
  console.log();
  console.log(titleStyle.render('Checking project setup...'));
  console.log();

  const results: CheckResult[] = [];

  // Tool checks
  console.log(titleStyle.render('Tools'));
  console.log();

  const gitResult = checkGit();
  results.push(gitResult);
  printStep(gitResult.name, gitResult.status === 'ok' ? 'done' : 'skip');
  if (gitResult.message) {
    printWarning(gitResult.message);
  }

  const ghResult = checkGitHubCli();
  results.push(ghResult);
  printStep(ghResult.name, ghResult.status === 'ok' ? 'done' : 'skip');
  if (ghResult.message) {
    printWarning(ghResult.message);
  }

  console.log();

  // Project structure checks
  const projectRoot = findProjectRoot(process.cwd());
  
  if (!projectRoot) {
    console.log(titleStyle.render('Project'));
    console.log();
    printError('Not in a spec-kit project. Run `specify init` first.');
    return false;
  }

  console.log(titleStyle.render('Project Structure'));
  console.log();

  const projectResults = checkProjectStructure(projectRoot);
  results.push(...projectResults);

  for (const result of projectResults) {
    printStep(
      result.name,
      result.status === 'ok' ? 'done' : result.status === 'warning' ? 'skip' : 'error'
    );
    if (result.message) {
      if (result.status === 'error') {
        printError(result.message);
      } else {
        printWarning(result.message);
      }
    }
  }

  console.log();

  // Summary
  const errors = results.filter(r => r.status === 'error');
  const warnings = results.filter(r => r.status === 'warning');

  if (errors.length > 0) {
    printError(`${errors.length} error(s) found. Please fix before proceeding.`);
    return false;
  } else if (warnings.length > 0) {
    printWarning(`${warnings.length} warning(s) found. Some features may not work.`);
    printSuccess('Project check completed with warnings.');
    return true;
  } else {
    printSuccess('All checks passed!');
    return true;
  }
}
