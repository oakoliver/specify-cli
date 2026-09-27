/**
 * @oakoliver/specify-cli - Template Management (legacy)
 *
 * Backward-compatible helpers over the bundled `core_pack/` assets (the
 * mirror of upstream's wheel `specify_cli/core_pack/`). The obsolete repo
 * `templates/` directory is no longer read. New code should use
 * `shared-infra.ts` (`installSharedInfra`) and the integrations, which
 * implement the upstream v1.0.12 scaffolding; these helpers remain for
 * library consumers of the previous API.
 *
 * @module templates
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateCorePack } from './assets.js';

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Directory holding the bundled assets (`core_pack/`: `templates/`,
 * `commands/`, `scripts/{bash,powershell,python}`, ...).
 */
export function getTemplatesDir(): string {
  const located = locateCorePack();
  if (located) return located;
  // Fallback: <package root>/core_pack relative to this module (src/ or dist/).
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'core_pack');
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Copy a directory recursively, optionally replacing placeholders in text files.
 */
export function copyDirectory(src: string, dest: string, replacements?: Record<string, string>): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) copyDirectory(srcPath, destPath, replacements);
    else copyFile(srcPath, destPath, replacements);
  }
}

/**
 * Copy a single file, optionally replacing placeholders.
 */
export function copyFile(src: string, dest: string, replacements?: Record<string, string>): void {
  mkdirSync(dirname(dest), { recursive: true });
  if (replacements && isTextFile(src)) {
    let content = readFileSync(src, 'utf-8');
    for (const [placeholder, value] of Object.entries(replacements)) {
      content = content.split(placeholder).join(value);
    }
    writeFileSync(dest, content, 'utf-8');
  } else {
    copyFileSync(src, dest);
  }

  if (src.endsWith('.sh') || src.endsWith('.ps1')) {
    try {
      chmodSync(dest, statSync(src).mode);
    } catch {
      if (src.endsWith('.sh')) {
        try {
          chmodSync(dest, 0o755);
        } catch {
          // Ignore permission errors on Windows
        }
      }
    }
  }
}

function isTextFile(filePath: string): boolean {
  const textExtensions = ['.md', '.txt', '.sh', '.ps1', '.py', '.json', '.yml', '.yaml', '.toml', '.ts', '.js'];
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 && textExtensions.includes(filePath.substring(dot));
}

// ============================================================================
// Template Copying (legacy API)
// ============================================================================

const SCRIPT_DIRS: Record<string, string> = { sh: 'bash', ps: 'powershell', py: 'python' };

/**
 * Copy page templates (`.specify/templates/`) and the script variant
 * (`.specify/scripts/<variant>/`) from core_pack into a project.
 *
 * Legacy: does not record a manifest or resolve command references; use
 * `installSharedInfra()` for upstream-parity scaffolding.
 */
export function copyTemplatesToProject(
  projectRoot: string,
  options: { scriptType: 'sh' | 'ps' | 'py'; agent: string; agentArgs: string },
): void {
  const corePack = getTemplatesDir();
  const specifyDir = join(projectRoot, '.specify');
  const replacements: Record<string, string> = {
    '{SCRIPT}': options.scriptType,
    __AGENT__: options.agent,
    '{ARGS}': options.agentArgs,
    $ARGUMENTS: options.agentArgs,
  };

  const templatesSrc = join(corePack, 'templates');
  if (existsSync(templatesSrc)) {
    for (const name of readdirSync(templatesSrc)) {
      if (!name.endsWith('.md')) continue;
      copyFile(join(templatesSrc, name), join(specifyDir, 'templates', name), replacements);
    }
  }

  const variant = SCRIPT_DIRS[options.scriptType] ?? 'bash';
  const scriptsSrc = join(corePack, 'scripts', variant);
  if (existsSync(scriptsSrc)) {
    copyDirectory(scriptsSrc, join(specifyDir, 'scripts', variant), replacements);
  }
}

function commandStem(commandName: string): string {
  return commandName.startsWith('speckit.') ? commandName.slice('speckit.'.length) : commandName;
}

/**
 * Get a core command template's content with `$ARGUMENTS` replaced.
 *
 * @param commandName - `speckit.<name>` (legacy) or bare `<name>`
 */
export function getCommandTemplate(commandName: string, agentArgs: string): string | null {
  const commandPath = join(getTemplatesDir(), 'commands', `${commandStem(commandName)}.md`);
  if (!existsSync(commandPath)) return null;
  return readFileSync(commandPath, 'utf-8').split('$ARGUMENTS').join(agentArgs);
}

/**
 * Names of the bundled core commands, in the legacy `speckit.<name>` form.
 */
export function getAvailableCommands(): string[] {
  const commandsDir = join(getTemplatesDir(), 'commands');
  if (!existsSync(commandsDir)) return [];
  return readdirSync(commandsDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => `speckit.${f.slice(0, -'.md'.length)}`);
}
