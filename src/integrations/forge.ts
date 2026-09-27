/**
 * @oakoliver/specify-cli - Forge integration — forgecode.dev AI coding agent.
 *
 * Port of `integrations/forge/__init__.py`. Forge:
 * - uses `{{parameters}}` instead of `$ARGUMENTS`
 * - strips the `handoffs` frontmatter key
 * - injects a hyphenated `name` field into frontmatter when missing
 *
 * @module integrations/forge
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join, parse as parsePath } from 'node:path';

import {
  MarkdownIntegration,
  replaceAllLiteral,
  scriptTypeOf,
  type ExecArgsOptions,
  type IntegrationConfig,
  type ParsedOptions,
  type RegistrarConfig,
  type SetupOptions,
} from './base.js';
import type { IntegrationManifest } from './manifest.js';

/**
 * Convert a command name to Forge-compatible hyphenated format
 * (idempotent): ``plan`` → ``speckit-plan``, ``speckit.git.commit`` →
 * ``speckit-git-commit``.
 */
export function formatForgeCommandName(cmdName: string): string {
  if (cmdName.startsWith('speckit-')) return cmdName;
  let shortName = cmdName;
  if (shortName.startsWith('speckit.')) shortName = shortName.slice('speckit.'.length);
  shortName = replaceAllLiteral(shortName, '.', '-');
  return `speckit-${shortName}`;
}

/** Python ``str.strip()`` for ASCII whitespace used by the forge line scan. */
function strip(s: string): string {
  return s.replace(/^\s+|\s+$/g, '');
}

export class ForgeIntegration extends MarkdownIntegration {
  key = 'forge';
  config: IntegrationConfig | null = {
    name: 'Forge',
    folder: '.forge/',
    commands_subdir: 'commands',
    install_url: 'https://forgecode.dev/docs/',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.forge/commands',
    format: 'markdown',
    args: '{{parameters}}',
    extension: '.md',
    strip_frontmatter_keys: ['handoffs'],
    inject_name: true,
    format_name: formatForgeCommandName,
    invoke_separator: '-',
  };
  invokeSeparator = '-';

  /** ``forge <extra> -p <prompt>`` (no ``--model`` / ``--output-format``). */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args = [this.resolveExecutable()];
    this.applyExtraArgsEnvVar(args);
    args.push('-p', prompt);
    return args;
  }

  buildCommandInvocation(commandName: string, args = ''): string {
    let invocation = '/' + formatForgeCommandName(commandName);
    if (args) invocation = `${invocation} ${args}`;
    return invocation;
  }

  setup(projectRoot: string, manifest: IntegrationManifest, _parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    const templates = this.listCommandTemplates();
    if (templates.length === 0) return [];
    const dest = this.checkedDest(projectRoot, manifest, this.commandsDest(projectRoot));
    mkdirSync(dest, { recursive: true });
    const scriptType = scriptTypeOf(opts);
    const argPlaceholder = this.registrarConfig?.args ?? '{{parameters}}';
    const created: string[] = [];
    for (const src of templates) {
      const raw = readFileSync(src, 'utf-8');
      let processed = this.processTemplate(raw, this.key, scriptType, argPlaceholder, this.invokeSeparator, projectRoot);
      processed = replaceAllLiteral(processed, '$ARGUMENTS', argPlaceholder);
      const stem = parsePath(src).name;
      processed = this.applyForgeTransformations(processed, stem);
      created.push(this.writeFileAndRecord(processed, join(dest, this.commandFilename(stem)), projectRoot, manifest));
    }
    return created;
  }

  /** Strip ``handoffs`` and inject a hyphenated ``name`` when missing. */
  applyForgeTransformations(content: string, templateName: string): string {
    const lines = content.split('\n');
    if (lines.length === 0 || strip(lines[0]) !== '---') return content;
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
      if (strip(lines[i]) === '---') {
        end = i;
        break;
      }
    }
    if (end === -1) return content;
    const fmLines = lines.slice(1, end);
    const bodyLines = lines.slice(end + 1);
    const filtered: string[] = [];
    let skip = false;
    for (const line of fmLines) {
      if (skip) {
        if (line && (line[0] === ' ' || line[0] === '\t')) continue;
        skip = false;
      }
      if (strip(line).startsWith('handoffs:')) {
        skip = true;
        continue;
      }
      filtered.push(line);
    }
    if (!filtered.some((line) => strip(line).startsWith('name:'))) {
      filtered.unshift(`name: ${formatForgeCommandName(templateName)}`);
    }
    return ['---', ...filtered, '---', ...bodyLines].join('\n');
  }
}
