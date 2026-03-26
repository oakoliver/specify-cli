/**
 * @oakoliver/specify-cli - Template Management
 *
 * Handles bundled templates: copying, placeholder replacement, and file operations.
 *
 * @module templates
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Get the directory containing bundled templates.
 * Templates are shipped with the npm package.
 */
export function getTemplatesDir(): string {
  // In ESM, we need to derive __dirname
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // Templates are at package root /templates
  // From dist/templates.js, go up one level
  const templatesDir = join(__dirname, '..', 'templates');

  // Fallback for development (when running from src/)
  if (!existsSync(templatesDir)) {
    const devTemplatesDir = join(__dirname, '..', '..', 'templates');
    if (existsSync(devTemplatesDir)) {
      return devTemplatesDir;
    }
  }

  return templatesDir;
}

// ============================================================================
// File Operations
// ============================================================================

/**
 * Copy a directory recursively.
 *
 * @param src - Source directory
 * @param dest - Destination directory
 * @param replacements - Optional placeholder replacements { placeholder: value }
 */
export function copyDirectory(
  src: string,
  dest: string,
  replacements?: Record<string, string>
): void {
  if (!existsSync(src)) {
    return;
  }

  mkdirSync(dest, { recursive: true });

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath, replacements);
    } else {
      copyFile(srcPath, destPath, replacements);
    }
  }
}

/**
 * Copy a single file, optionally replacing placeholders.
 */
export function copyFile(
  src: string,
  dest: string,
  replacements?: Record<string, string>
): void {
  const destDir = dirname(dest);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  if (replacements && isTextFile(src)) {
    let content = readFileSync(src, 'utf-8');

    for (const [placeholder, value] of Object.entries(replacements)) {
      content = content.replace(new RegExp(escapeRegex(placeholder), 'g'), value);
    }

    writeFileSync(dest, content, 'utf-8');
  } else {
    copyFileSync(src, dest);
  }

  // Preserve executable permissions for scripts
  if (src.endsWith('.sh') || src.endsWith('.ps1')) {
    try {
      const srcStat = statSync(src);
      chmodSync(dest, srcStat.mode);
    } catch {
      // Fallback: make shell scripts executable
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

/**
 * Check if a file is likely a text file (for placeholder replacement).
 */
function isTextFile(filePath: string): boolean {
  const textExtensions = ['.md', '.txt', '.sh', '.ps1', '.json', '.yml', '.yaml', '.toml', '.ts', '.js'];
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  return textExtensions.includes(ext);
}

/**
 * Escape special regex characters.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Template Copying
// ============================================================================

/**
 * Copy all templates to a project.
 *
 * @param projectRoot - Absolute path to project root
 * @param options - Copy options
 */
export function copyTemplatesToProject(
  projectRoot: string,
  options: {
    scriptType: 'sh' | 'ps';
    agent: string;
    agentArgs: string;
  }
): void {
  const templatesDir = getTemplatesDir();
  const specifyDir = join(projectRoot, '.specify');

  // Replacements for template placeholders
  const replacements: Record<string, string> = {
    '{SCRIPT}': options.scriptType,
    '__AGENT__': options.agent,
    '{ARGS}': options.agentArgs,
    '$ARGUMENTS': options.agentArgs,
  };

  // Copy template files (.specify/templates/)
  const templateFilesDir = join(templatesDir, 'files');
  if (existsSync(templateFilesDir)) {
    copyDirectory(templateFilesDir, join(specifyDir, 'templates'), replacements);
  }

  // NOTE: Command templates are NOT copied to .specify/templates/commands/
  // They are only used to register commands into the agent's commands folder.
  // This matches Python spec-kit behavior.

  // Copy scripts (.specify/scripts/)
  const scriptsDir = join(templatesDir, 'scripts');
  if (existsSync(scriptsDir)) {
    if (options.scriptType === 'sh') {
      const bashDir = join(scriptsDir, 'bash');
      if (existsSync(bashDir)) {
        copyDirectory(bashDir, join(specifyDir, 'scripts', 'bash'), replacements);
      }
    } else {
      const psDir = join(scriptsDir, 'powershell');
      if (existsSync(psDir)) {
        copyDirectory(psDir, join(specifyDir, 'scripts', 'powershell'), replacements);
      }
    }
  }
}

/**
 * Get command template content for an agent.
 *
 * @param commandName - Command name (e.g., "speckit.specify")
 * @param agentArgs - Arguments placeholder for the agent
 * @returns Command content with placeholders replaced
 */
export function getCommandTemplate(commandName: string, agentArgs: string): string | null {
  const templatesDir = getTemplatesDir();
  const commandPath = join(templatesDir, 'commands', `${commandName}.md`);

  if (!existsSync(commandPath)) {
    return null;
  }

  let content = readFileSync(commandPath, 'utf-8');

  // Replace arguments placeholder
  content = content.replace(/\$ARGUMENTS/g, agentArgs);

  return content;
}

/**
 * Get all available command names from templates.
 */
export function getAvailableCommands(): string[] {
  const templatesDir = getTemplatesDir();
  const commandsDir = join(templatesDir, 'commands');

  if (!existsSync(commandsDir)) {
    return [];
  }

  return readdirSync(commandsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''));
}
