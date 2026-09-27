/**
 * @oakoliver/specify-cli - Cline IDE integration.
 *
 * Port of `integrations/cline/__init__.py`.
 *
 * @module integrations/cline
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';

import {
  MarkdownIntegration,
  injectNoteBeforeHookInstructions,
  replaceAllLiteral,
  type IntegrationConfig,
  type ParsedOptions,
  type RegistrarConfig,
  type SetupOptions,
} from './base.js';
import { isRelativeTo, resolvePath, type IntegrationManifest } from './manifest.js';

/** Note injected into hook sections so Cline maps dotted names to hyphenated commands. */
const HOOK_COMMAND_NOTE =
  '- When constructing slash commands from hook command names, ' +
  'replace dots (`.`) with hyphens (`-`). ' +
  'For example, `speckit.git.commit` → `/speckit-git-commit`.\n';

/** Convert a command name to Cline's hyphenated format (idempotent). */
export function formatClineCommandName(cmdName: string): string {
  let name = replaceAllLiteral(cmdName, '.', '-');
  if (!name.startsWith('speckit-')) name = `speckit-${name}`;
  return name;
}

export class ClineIntegration extends MarkdownIntegration {
  key = 'cline';
  config: IntegrationConfig | null = {
    name: 'Cline',
    folder: '.clinerules/',
    commands_subdir: 'workflows',
    install_url: 'https://github.com/cline/cline',
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.clinerules/workflows',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
    inject_name: true,
    format_name: formatClineCommandName,
    invoke_separator: '-',
  };
  invokeSeparator = '-';
  multiInstallSafe = true;

  commandFilename(templateName: string): string {
    return formatClineCommandName(templateName) + '.md';
  }

  buildCommandInvocation(commandName: string, args = ''): string {
    let invocation = '/' + formatClineCommandName(commandName);
    if (args) invocation = `${invocation} ${args}`;
    return invocation;
  }

  /** Render shared templates with hyphenated command references by default. */
  processTemplate(
    content: string,
    agentName: string,
    scriptType: string,
    argPlaceholder = '$ARGUMENTS',
    invokeSeparator?: string,
    projectRoot: string | null = null,
  ): string {
    return super.processTemplate(content, agentName, scriptType, argPlaceholder, invokeSeparator ?? this.invokeSeparator, projectRoot);
  }

  /**
   * Insert the dot-to-hyphen note before each hook instruction, skipping
   * instructions whose preceding line already is the note.
   */
  static injectHookCommandNote(content: string): string {
    return injectNoteBeforeHookInstructions(content, HOOK_COMMAND_NOTE.replace(/\n+$/, ''), true);
  }

  /** Replace dot-notation agent references in handoffs with hyphens. */
  static rewriteHandoffReferences(content: string): string {
    return content.replace(
      /^(\s*agent:\s*)(speckit\.[A-Za-z0-9\-_]+(?:\.[A-Za-z0-9\-_]+)*)/gm,
      (_m, pre: string, name: string) => `${pre}${formatClineCommandName(name)}`,
    );
  }

  postProcessCommandContent(content: string): string {
    let updated = ClineIntegration.injectHookCommandNote(content);
    updated = ClineIntegration.rewriteHandoffReferences(updated);
    return updated;
  }

  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    const created = super.setup(projectRoot, manifest, parsedOptions, opts);
    const destDir = resolvePath(this.commandsDest(projectRoot));
    for (const path of created) {
      if (!isRelativeTo(resolvePath(path), destDir)) continue;
      if (extname(path) !== '.md') continue;
      const content = readFileSync(path).toString('utf-8');
      const updated = this.postProcessCommandContent(content);
      if (updated !== content) {
        writeFileSync(path, Buffer.from(updated, 'utf-8'));
        this.recordFileInManifest(path, projectRoot, manifest);
      }
    }
    return created;
  }
}
