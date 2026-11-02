/**
 * @oakoliver/specify-cli - Mistral Vibe CLI integration — skills-based agent.
 *
 * Port of `integrations/vibe/__init__.py`.
 *
 * @module integrations/vibe
 */

import { SkillsIntegration, IntegrationOption, type IntegrationConfig, type RegistrarConfig, injectFrontmatterFlag, pyRstrip, pyStrip as pyStripStr, splitlines, skillNameFromContent, skillStemFromContent, type ExecArgsOptions, buildSkillFrontmatter, pyStrip, secho, type ParsedOptions, type SetupOptions } from './base.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { dumpFrontmatter } from '../utils.js';
import { escapeTomlBasic, parseToml } from '../toml-string.js';
import { unlink as unlinkFile, writeBytes } from './file-changes.js';
import type { IntegrationManifest } from './manifest.js';
import { CORE_COMMAND_NAMES } from '../extensions/manifest.js';

/**
 * Per-command frontmatter overrides for skills that should run in a forked
 * subagent context. Intentionally empty (see upstream #3185).
 */
export const FORK_CONTEXT_COMMANDS: Record<string, Record<string, string>> = {};

/**
 * Keep the native Vibe timeout slightly longer than the dispatcher's inner
 * timeout so Vibe does not terminate the dispatcher before it can reap its
 * child process.
 */
export const VIBE_EVENT_TIMEOUT_BUFFER = 5;

type EventHandlerConfig = Record<string, unknown>;

/** Callbacks the shared events module supplies to ``mergeVibeEventHooks``. */
export interface VibeHookHelpers {
  buildDispatcherCommand: (command: string, event: string, targetOs: string, timeout: unknown) => string;
  nativeTimeout: (seconds: unknown) => number;
  ensureSafeDestination: (path: string) => void;
}

/**
 * Yield TOML physical lines, preserving their original terminators. TOML
 * recognizes LF and CRLF only (bare CR and Unicode line separators are not
 * line boundaries).
 */
function tomlPhysicalLines(source: string): string[] {
  const out: string[] = [];
  let start = 0;
  let newline: number;
  while ((newline = source.indexOf('\n', start)) >= 0) {
    out.push(source.slice(start, newline + 1));
    start = newline + 1;
  }
  if (start < source.length) out.push(source.slice(start));
  return out;
}

function logWarning(message: string): void {
  process.stderr.write(message + '\n');
}

/** Python ``timeout + VIBE_EVENT_TIMEOUT_BUFFER`` (bool counts as int). */
function addBuffer(timeout: unknown): unknown {
  if (typeof timeout === 'boolean') return (timeout ? 1 : 0) + VIBE_EVENT_TIMEOUT_BUFFER;
  if (typeof timeout === 'number') return timeout + VIBE_EVENT_TIMEOUT_BUFFER;
  throw new TypeError(`unsupported operand type(s) for +: '${typeof timeout}' and 'int'`);
}

function readUtf8Raw(path: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
}

export class VibeIntegration extends SkillsIntegration {
  key = 'vibe';
  config: IntegrationConfig | null = {
    name: 'Mistral Vibe',
    folder: '.vibe/',
    commands_subdir: 'skills',
    install_url: 'https://github.com/mistralai/mistral-vibe',
    requires_cli: true,
  };
  registrarConfig: RegistrarConfig | null = {
    dir: '.vibe/skills',
    format: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  };
  multiInstallSafe = true;
  CANONICAL_TO_NATIVE: Record<string, string> | null = {
    pre_tool_use: 'pre_tool',
    post_tool_use: 'post_tool',
    stop: 'post_agent',
  };
  eventsConfigFile: string | null = '.vibe/hooks.toml';
  eventsFormat: string | null = 'toml-vibe';
  eventsContextEnvelope: Record<string, string> = {
    '*': 'hook_specific_output',
  };

  options(): IntegrationOption[] {
    const opts = super.options();
    opts.push(new IntegrationOption('--skills', { isFlag: true, required: false, default: true, help: 'Install as agent skills' }));
    opts.push(
      new IntegrationOption('--no-model-invocation', {
        isFlag: true,
        default: false,
        help: 'Install core command skills as user-invocable only (disable-model-invocation: true)',
      }),
    );
    return opts;
  }

  /**
   * Set by ``setup()`` from ``--no-model-invocation``; applies to core command
   * skills only (see {@link ClaudeIntegration}).
   */
  disableModelInvocation = false;

  /**
   * ``vibe -p <prompt>``. Vibe has neither ``--model`` nor ``--output-format``:
   * structured output is ``--output json`` and ``model`` is deliberately
   * dropped (Vibe selects its model out of band via ``active_model``).
   */
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const args: string[] = [this.resolveExecutable(), '-p', prompt];
    this.applyExtraArgsEnvVar(args);
    if (opts.outputJson ?? true) args.push('--output', 'json');
    return args;
  }

  /** Render a processed command template as a skill (``_render_skill``). */
  renderSkill(templateName: string, frontmatter: Record<string, unknown>, body: string): string {
    const skillName = `speckit-${templateName.replace(/\./g, '-')}`;
    const description = 'description' in frontmatter ? frontmatter.description : `Spec-kit workflow command: ${templateName}`;
    const skillFm = this.buildSkillFm(skillName, description, `templates/commands/${templateName}.md`);
    const text = dumpFrontmatter(skillFm);
    return `---\n${text}\n---\n\n${pyStrip(body)}\n`;
  }

  buildSkillFm(name: string, description: unknown, source: string): Record<string, unknown> {
    return buildSkillFrontmatter(this.key, name, description, source);
  }

  static injectFrontmatterFlag(content: string, key: string, value = 'true'): string {
    return injectFrontmatterFlag(content, key, value);
  }

  static skillStemFromContent(content: string): string | null {
    return skillStemFromContent(content);
  }

  static skillNameFromContent(content: string): string | null {
    return skillNameFromContent(content);
  }

  static isCoreCommandSkill(content: string): boolean {
    const name = skillNameFromContent(content);
    return !!name && name.startsWith('speckit-') && CORE_COMMAND_NAMES.has(name.slice('speckit-'.length));
  }

  /** Inject Vibe-specific frontmatter flags. */
  postProcessSkillContent(content: string): string {
    let updated = super.postProcessSkillContent(content);
    updated = injectFrontmatterFlag(updated, 'user-invocable');
    const disable = this.disableModelInvocation && VibeIntegration.isCoreCommandSkill(updated);
    updated = injectFrontmatterFlag(updated, 'disable-model-invocation', disable ? 'true' : 'false');
    const stem = skillStemFromContent(updated);
    if (stem) {
      const forkConfig = FORK_CONTEXT_COMMANDS[stem];
      if (forkConfig) {
        for (const [key, value] of Object.entries(forkConfig)) {
          updated = injectFrontmatterFlag(updated, key, value);
        }
      }
    }
    return updated;
  }

  /** Install Vibe skills (warns about the v2.0.0 layout requirement). */
  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    secho(
      'Warning: The .vibe/skills layout requires Mistral Vibe v2.0.0 or newer. ' +
        'Please ensure your installation is up to date.',
      'yellow',
    );
    this.disableModelInvocation = (parsedOptions ?? {}).no_model_invocation === true;
    try {
      return super.setup(projectRoot, manifest, parsedOptions, opts);
    } catch (err) {
      this.disableModelInvocation = false;
      throw err;
    }
  }

  // -- Native hooks (.vibe/hooks.toml) ------------------------------------

  /** The shell Vibe uses for hook commands on this host. */
  static hookTargetOs(): string {
    return process.platform === 'win32' ? 'cmd' : 'host';
  }

  /** Render a TOML basic string. */
  static tomlQuote(value: string): string {
    return escapeTomlBasic(value);
  }

  /**
   * Return a TOML header's kind and key path, or ``null`` when the line is
   * not one. Only header syntax is recognized; a ``null`` key component is a
   * quoted key with an escape (a real header that cannot be ``hooks``).
   */
  static parseTomlHeader(code: string): [boolean, Array<string | null> | null] {
    const text = code.replace(/^[ \t]+|[ \t]+$/g, '');
    const isArray = text.startsWith('[[');
    let body: string;
    if (isArray) {
      if (!text.endsWith(']]') || text.length < 5) return [false, null];
      body = text.slice(2, -2);
    } else {
      if (!text.startsWith('[') || !text.endsWith(']') || text.length < 3) return [false, null];
      body = text.slice(1, -1);
    }
    const parts: Array<string | null> = [];
    let index = 0;
    const length = body.length;
    for (;;) {
      while (index < length && (body[index] === ' ' || body[index] === '\t')) index++;
      if (index === length) return [false, null];
      if (body[index] === '"' || body[index] === "'") {
        const quote = body[index];
        index++;
        const start = index;
        let escaped = false;
        let closed = false;
        while (index < length) {
          const ch = body[index];
          if (quote === '"' && escaped) escaped = false;
          else if (quote === '"' && ch === '\\') escaped = true;
          else if (ch === quote) {
            const rawPart = body.slice(start, index);
            parts.push(rawPart.includes('\\\\') ? null : rawPart);
            index++;
            closed = true;
            break;
          }
          index++;
        }
        if (!closed) return [false, null];
      } else {
        const start = index;
        while (index < length) {
          const ch = body[index];
          // TOML bare keys are ASCII-only; non-ASCII makes the header ambiguous.
          if (ch.charCodeAt(0) > 0x7f) return [false, null];
          if (!/[A-Za-z0-9_-]/.test(ch)) break;
          index++;
        }
        if (start === index) return [false, null];
        parts.push(body.slice(start, index));
      }
      while (index < length && (body[index] === ' ' || body[index] === '\t')) index++;
      if (index === length) return [isArray, parts];
      if (body[index] !== '.') return [false, null];
      index++;
    }
  }

  /**
   * Find Specify-owned hook blocks in valid TOML without interpreting values.
   * Returns ``null`` for malformed or ambiguous input so callers leave the
   * source untouched. A block ends after its last line of TOML and the blank
   * lines right after it; a following standalone comment stays with the
   * content after it (upstream #5079).
   *
   * ADAPTATION: upstream gates on ``tomllib.loads``; this port uses its
   * zero-dependency ``parseToml`` (a TOML 1.0 subset), so input it cannot
   * parse is treated as malformed and left untouched (fails closed).
   */
  static managedHookSpans(source: string): Array<[number, number]> | null {
    try {
      parseToml(source);
    } catch {
      return null;
    }
    const spans: Array<[number, number]> = [];
    let currentStart: number | null = null;
    let currentEnd = 0;
    let currentAfterComment = false;
    let currentIsHooks = false;
    let currentHasMarker = false;
    let multiline: string | null = null;
    let arrayDepth = 0;
    let offset = 0;

    for (const line of tomlPhysicalLines(source)) {
      const content = line.replace(/[\r\n]+$/, '');
      let index = 0;
      let codeEnd = content.length;
      const lineStartsInMultilineString = multiline !== null;
      let lineHasMultilineString = lineStartsInMultilineString;
      const lineStartsInArray = arrayDepth > 0;
      const structural = content.split('');
      const blank = (from: number, to: number): void => {
        for (let k = from; k < Math.min(to, structural.length); k++) structural[k] = ' ';
      };
      while (index < content.length) {
        const ch = content[index];
        if (multiline !== null) {
          if (multiline === '\"\"\"' && ch === '\\') {
            // A basic multiline string may escape its next character.
            blank(index, index + 2);
            index += 2;
            continue;
          }
          if (content.startsWith(multiline, index)) {
            let runEnd = index;
            while (runEnd < content.length && content[runEnd] === multiline[0]) runEnd++;
            if (runEnd - index > 5) return null;
            if (runEnd - index >= 3) {
              blank(index, runEnd);
              multiline = null;
              index = runEnd;
              continue;
            }
          }
          structural[index] = ' ';
          index++;
          continue;
        }
        if (ch === '#') {
          codeEnd = index;
          break;
        }
        if (content.startsWith('\"\"\"', index) || content.startsWith("'''", index)) {
          multiline = content.slice(index, index + 3);
          lineHasMultilineString = true;
          blank(index, index + 3);
          index += 3;
          continue;
        }
        if (ch === '"' || ch === "'") {
          const quote = ch;
          const start = index;
          index++;
          let closed = false;
          while (index < content.length) {
            if (quote === '"' && content[index] === '\\') {
              if (index + 1 === content.length) return null;
              index += 2;
              continue;
            }
            if (content[index] === quote) {
              index++;
              blank(start, index);
              closed = true;
              break;
            }
            index++;
          }
          if (!closed) return null;
          continue;
        }
        index++;
      }

      if (multiline !== null && !(line.endsWith('\n') || line.endsWith('\r'))) return null;

      // A multiline string can contain text that resembles a header or marker;
      // a header/assignment cannot share its physical line, so ignore it.
      const code = lineHasMultilineString ? '' : content.slice(0, codeEnd);
      const [isArray, headerPath] =
        !lineStartsInArray && !lineHasMultilineString ? VibeIntegration.parseTomlHeader(code) : [false, null];
      if (headerPath !== null) {
        if (currentStart !== null && currentHasMarker) spans.push([currentStart, currentEnd]);
        currentStart = offset;
        currentIsHooks = isArray && headerPath.length === 1 && headerPath[0] === 'hooks';
        currentHasMarker = false;
      } else if (!lineStartsInArray && !lineStartsInMultilineString && content.replace(/^[ \t]+/, '').startsWith('[')) {
        // A line that starts like a header but cannot be classified is
        // ambiguous; never remove content from such a file.
        return null;
      } else if (currentIsHooks && /^[ \t]*speckit_marker[ \t]*=[ \t]*true[ \t]*$/.test(code)) {
        currentHasMarker = true;
      }

      if (headerPath === null) {
        for (const ch of structural.slice(0, codeEnd)) {
          if (ch === '[') arrayDepth++;
          else if (ch === ']') {
            arrayDepth--;
            if (arrayDepth < 0) return null;
          }
        }
      }

      // Lines inside a multiline string or array are part of the value,
      // even when they look like comments.
      if (lineStartsInArray || lineHasMultilineString || code.replace(/^[ \t]+|[ \t]+$/g, '')) {
        currentEnd = offset + line.length;
        currentAfterComment = false;
      } else if (content.replace(/^[ \t]+|[ \t]+$/g, '')) {
        currentAfterComment = true;
      } else if (!currentAfterComment) {
        currentEnd = offset + line.length;
      }
      offset += line.length;
    }

    if (multiline !== null || arrayDepth) return null;
    if (currentStart !== null && currentHasMarker) spans.push([currentStart, currentEnd]);
    return spans;
  }

  /** Remove managed spans, preserving every other source slice verbatim. */
  static withoutManagedHooks(source: string): string | null {
    const spans = VibeIntegration.managedHookSpans(source);
    if (spans === null) return null;
    if (spans.length === 0) return source;
    const slices: string[] = [];
    let previousEnd = 0;
    for (const [start, end] of spans) {
      slices.push(source.slice(previousEnd, start));
      previousEnd = end;
    }
    slices.push(source.slice(previousEnd));
    return slices.join('');
  }

  /** Render and merge managed Vibe hooks without disturbing user content. */
  mergeVibeEventHooks(projectRoot: string, events: Record<string, unknown>, helpers: VibeHookHelpers): boolean {
    const lines: string[] = [];
    const usedNames = new Set<string>();
    for (const [event, handlers] of Object.entries(events)) {
      const nativeName = (this.CANONICAL_TO_NATIVE ?? {})[event];
      for (const config of handlers as EventHandlerConfig[]) {
        const command = String(config.command ?? '');
        const timeout = 'timeout' in config ? config.timeout : 60;
        const dispatcherCmd = helpers.buildDispatcherCommand(command, event, VibeIntegration.hookTargetOs(), timeout);
        let commandStem = command ? command.split('.').pop()! : 'unknown';
        commandStem = commandStem.replace(/[^A-Za-z0-9_-]+/g, '-') || 'unknown';
        const baseName = `speckit-${nativeName}-${commandStem}`;
        let hookName = baseName;
        let suffix = 2;
        while (usedNames.has(hookName)) {
          hookName = `${baseName}-${suffix}`;
          suffix += 1;
        }
        usedNames.add(hookName);
        lines.push('[[hooks]]', `name = ${VibeIntegration.tomlQuote(hookName)}`, `type = ${VibeIntegration.tomlQuote(nativeName)}`);
        const matcher = 'matcher' in config ? config.matcher : '*';
        if (matcher && matcher !== '*' && (nativeName === 'pre_tool' || nativeName === 'post_tool')) {
          lines.push(`match = ${VibeIntegration.tomlQuote('re:' + String(matcher))}`);
        }
        lines.push(
          `command = ${VibeIntegration.tomlQuote(dispatcherCmd)}`,
          `timeout = ${helpers.nativeTimeout(addBuffer(timeout))}`,
          'speckit_marker = true',
          '',
        );
      }
    }
    return this.mergeManagedHooks(join(projectRoot, this.eventsConfigFile!), lines.join('\n'), helpers);
  }

  /** Remove only Specify-owned Vibe hooks and delete an owned-only file. */
  removeVibeEventHooks(projectRoot: string, helpers: Pick<VibeHookHelpers, 'ensureSafeDestination'>): boolean {
    const path = join(projectRoot, this.eventsConfigFile!);
    let exists = false;
    try {
      readFileSync(path);
      exists = true;
    } catch (e) {
      exists = (e as NodeJS.ErrnoException).code !== 'ENOENT';
    }
    if (!exists) return false;
    helpers.ensureSafeDestination(path);
    let existing: string;
    try {
      existing = readUtf8Raw(path);
    } catch {
      logWarning(
        `Could not read ${path} (it may be unreadable or not UTF-8); ` +
          'skipping event-config cleanup to preserve user content.',
      );
      return false;
    }
    const cleaned = VibeIntegration.withoutManagedHooks(existing);
    if (cleaned === null || cleaned === existing) return false;
    const nonComment = splitlines(cleaned)
      .filter((line) => pyStripStr(line) && !pyStripStr(line).startsWith('#'))
      .join('\n');
    if (!nonComment) {
      unlinkFile(path, { missingOk: true });
      return true;
    }
    writeBytes(path, Buffer.from(cleaned, 'utf-8'));
    return false;
  }

  /**
   * Replace managed entries while retaining unowned content. Active merges
   * normalize trailing separators before appending generated hooks.
   */
  private mergeManagedHooks(path: string, fragment: string, helpers: Pick<VibeHookHelpers, 'ensureSafeDestination'>): boolean {
    helpers.ensureSafeDestination(path);
    let existing = '';
    let present = true;
    try {
      readFileSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') present = false;
    }
    if (present) {
      try {
        existing = readUtf8Raw(path);
      } catch {
        logWarning(
          `Could not read ${path} (it may be unreadable or not UTF-8); ` +
            'skipping event-config merge to preserve user content.',
        );
        return false;
      }
    }
    const cleaned = VibeIntegration.withoutManagedHooks(existing);
    if (cleaned === null) return false;
    mkdirSync(dirname(path), { recursive: true });
    writeBytes(path, Buffer.from(pyRstrip(cleaned) + '\n\n' + fragment + '\n', 'utf-8'));
    return true;
  }
}
