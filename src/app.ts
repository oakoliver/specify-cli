/**
 * @oakoliver/specify-cli - App Helpers
 *
 * Port of the non-CLI-wiring helpers defined in upstream
 * `specify_cli/__init__.py` (spec-kit v1.0.12): shared-infra install wrappers,
 * script permission fix-ups, init-options persistence, CLI warning
 * formatting, the root banner callback and backward-compatible constants.
 *
 * The heavy lifting lives in the domain modules (`shared-infra.ts`,
 * `init-options.ts`, `console.ts`); this module is the stable import surface
 * that `init.ts` (and the root CLI) use, mirroring the Python package root.
 *
 * @module app
 */

import { Align, BANNER, TAGLINE, console, showBanner } from './console.js';
import { getSpeckitVersion } from './assets.js';

// ============================================================================
// Re-exports (Python package-root import surface)
// ============================================================================

export { BANNER, TAGLINE, showBanner };

export {
  installSharedInfra,
  installSharedInfraOrExit,
  refreshSharedTemplates,
  ensureExecutableScripts,
  getSkillsDir,
  resolveActiveSkillsDir,
  type InstallSharedInfraOptions,
} from './shared-infra.js';

export { INIT_OPTIONS_FILE, loadInitOptions, saveInitOptions } from './init-options.js';

// ============================================================================
// Root callback
// ============================================================================

/**
 * `specify --version` / `-V` eager callback: prints `specify <version>`.
 */
export function printVersion(): void {
  console.print(`specify ${getSpeckitVersion()}`);
}

/**
 * Root callback when no sub-command is given (upstream `callback`): show the
 * banner plus a centered usage hint. `argv` is the full argument list; the
 * banner is suppressed when `--help`/`-h` is present (help renders its own).
 */
export function showRootBanner(argv: string[] = process.argv.slice(2)): void {
  if (argv.includes('--help') || argv.includes('-h')) return;
  showBanner();
  console.print(Align.center("[dim]Run 'specify --help' for usage information[/dim]"));
  console.print();
}

// ============================================================================
// CLI diagnostics
// ============================================================================

// Implemented in integrations/helpers.ts (upstream defines them in both the
// package root and integrations/_helpers.py with identical behaviour).
export { cliErrorDetail, cliPhaseLabel, printCliWarning } from './integrations/helpers.js';

// ============================================================================
// Backward-compatible constants
// ============================================================================

/** Constants kept for backward compatibility with presets and extensions. */
export const DEFAULT_SKILLS_DIR = '.agents/skills';

export const SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  specify: 'Create or update feature specifications from natural language descriptions.',
  plan: 'Generate technical implementation plans from feature specifications.',
  tasks: 'Break down implementation plans into actionable task lists.',
  implement: 'Execute all tasks from the task breakdown to build the feature.',
  converge: 'Assess the codebase against spec.md, plan.md, and tasks.md and append remaining work as new tasks.',
  analyze: 'Perform cross-artifact consistency analysis across spec.md, plan.md, and tasks.md.',
  clarify: 'Structured clarification workflow for underspecified requirements.',
  constitution: 'Create or update project governing principles and development guidelines.',
  checklist: 'Generate custom quality checklists for validating requirements completeness and clarity.',
  taskstoissues: 'Convert tasks from tasks.md into GitHub issues.',
};
