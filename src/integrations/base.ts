/**
 * @oakoliver/specify-cli - Integration Base Classes
 *
 * Port of `integrations/base.py`. Provides:
 * - `IntegrationOption` — declares a CLI option an integration accepts.
 * - `IntegrationBase` — abstract base every integration must implement.
 * - `MarkdownIntegration` — concrete base for standard Markdown-format
 *   integrations (the common case — subclass, set three attrs, done).
 * - `TomlIntegration` — concrete base for TOML-format integrations
 *   (Gemini, Tabnine).
 * - `YamlIntegration` — concrete base for YAML recipe integrations (Goose).
 * - `SkillsIntegration` — concrete base for integrations that install
 *   commands as agent skills (`speckit-<name>/SKILL.md` layout).
 *
 * All filesystem work is synchronous (mirrors Python). Paths are plain
 * strings (absolute or relative to the process cwd).
 *
 * @module integrations/base
 */

import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseYaml, dumpYaml } from '../yaml.js';
import { escapeTomlBasic, hasIllegalTomlControl } from '../toml-string.js';
import { getInvocationPrefix, isDollarSkillsAgent } from '../invocation-style.js';
import { runtimeIO } from '../workflows/base.js';
import {
  IntegrationManifest,
  NotImplementedError,
  ValueError,
  isDir,
  isFile,
  isRelativeTo,
  relativeTo,
  resolvePath,
} from './manifest.js';

export { ValueError, KeyError, NotImplementedError, isOSError, isValueError } from './manifest.js';

// ============================================================================
// Constants
// ============================================================================

const HOOK_COMMAND_NOTE =
  '- When constructing command invocations from hook command names, ' +
  'replace dots (`.`) with hyphens (`-`). ' +
  'For example, `speckit.git.commit` → `/speckit-git-commit`.\n';

const CORE_COMMAND_TEMPLATE_ORDER = [
  'analyze',
  'clarify',
  'constitution',
  'implement',
  'converge',
  'plan',
  'checklist',
  'specify',
  'tasks',
  'taskstoissues',
] as const;

const CORE_COMMAND_TEMPLATE_RANK: Record<string, number> = Object.fromEntries(
  CORE_COMMAND_TEMPLATE_ORDER.map((c, i) => [c, i]),
);

// ============================================================================
// Late-bound events bridge
// ============================================================================

/**
 * The runtime-events subsystem (``src/events``) imports the integration
 * registry, so importing it statically here would let an integration module
 * be evaluated before this base module (ESM cycle → TDZ error on
 * ``extends``). ``integrations/index.ts`` wires the real implementation via
 * {@link setIntegrationEventsBridge} when the registry loads.
 */
export interface IntegrationEventsBridge {
  installIntegrationEvents(
    integration: IntegrationBase,
    projectRoot: string,
    manifest: IntegrationManifest,
    events: IntegrationEvents,
  ): string[];
  removeIntegrationEvents(integration: IntegrationBase, projectRoot: string, manifest: IntegrationManifest): void;
  eventsStaleExclusions(key: string): Iterable<string>;
}

/**
 * Resolved canonical events map forwarded to the events subsystem (the value
 * returned by ``events.resolveEvents``; opaque to the integration classes).
 */
export type IntegrationEvents = Record<string, unknown>;

let eventsBridge: IntegrationEventsBridge | null = null;

/** Install the events implementation used by ``emitEvents``/``removeEvents``. */
export function setIntegrationEventsBridge(bridge: IntegrationEventsBridge | null): void {
  eventsBridge = bridge;
}

/** Currently installed events bridge (``null`` before the registry loads). */
export function getIntegrationEventsBridge(): IntegrationEventsBridge | null {
  return eventsBridge;
}

// ============================================================================
// Python ``warnings.warn`` equivalent
// ============================================================================

/** A captured warning record. */
export interface WarningRecord {
  message: string;
  category: string;
}

const warningCaptureStack: WarningRecord[][] = [];

/**
 * Emit a warning (Python ``warnings.warn``). Written to stderr as
 * ``<Category>: <message>`` unless captured via {@link captureWarnings}.
 */
export function warn(message: string, category = 'UserWarning'): void {
  const top = warningCaptureStack[warningCaptureStack.length - 1];
  if (top) {
    top.push({ message, category });
    return;
  }
  process.stderr.write(`${category}: ${message}\n`);
}

/** Run *fn* collecting warnings (``pytest.warns`` / ``warnings.catch_warnings``). */
export function captureWarnings<T>(fn: () => T): [T, WarningRecord[]] {
  const records: WarningRecord[] = [];
  warningCaptureStack.push(records);
  try {
    return [fn(), records];
  } finally {
    warningCaptureStack.pop();
  }
}

// ============================================================================
// Python-compat string helpers
// ============================================================================

const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;

/**
 * Python ``str.splitlines(keepends)``: splits on every Unicode line boundary
 * Python recognises (``\n``, ``\r``, ``\r\n``, ``\v``, ``\f``, ``\x1c``-``\x1e``,
 * ``\x85``, ``\u2028``, ``\u2029``).
 */
export function splitlines(text: string, keepends = false): string[] {
  const out: string[] = [];
  let last = 0;
  PY_LINE_BREAK.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PY_LINE_BREAK.exec(text)) !== null) {
    const end = m.index + m[0].length;
    out.push(keepends ? text.slice(last, end) : text.slice(last, m.index));
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Python ``str.isspace()`` for a single character (empty → false). */
export function pyIsSpace(ch: string): boolean {
  return ch.length > 0 && /^[\s\x1c-\x1f\x85]+$/.test(ch) && !/\ufeff/.test(ch);
}

/** Python ``str.rstrip()`` (no-arg: strips Unicode whitespace). */
export function pyRstrip(s: string): string {
  let end = s.length;
  while (end > 0 && pyIsSpace(s[end - 1])) end--;
  return s.slice(0, end);
}

/** Python ``str.strip()`` (no-arg). */
export function pyStrip(s: string): string {
  let start = 0;
  while (start < s.length && pyIsSpace(s[start])) start++;
  return pyRstrip(s.slice(start));
}

/** Replace every occurrence of *search* with *replacement* literally (Python ``str.replace``). */
export function replaceAllLiteral(text: string, search: string, replacement: string): string {
  if (search === '') return text;
  return text.split(search).join(replacement);
}

/** Python ``str.partition(sep)`` → ``[head, tail]`` (separator dropped). */
export function partition(text: string, sepStr: string): [string, string] {
  const idx = text.indexOf(sepStr);
  if (idx === -1) return [text, ''];
  return [text.slice(0, idx), text.slice(idx + sepStr.length)];
}

const SECHO_COLORS: Record<string, number> = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
};

/**
 * ``click.secho(message, fg=..., err=True)``: styled line on stderr (ANSI
 * only when the stream is a TTY and ``NO_COLOR`` is unset).
 */
export function secho(message: string, fg: string | null = null, err = true): void {
  const stream = err ? process.stderr : process.stdout;
  const color = fg && stream.isTTY && !process.env.NO_COLOR ? SECHO_COLORS[fg] : undefined;
  stream.write(color ? `\x1b[${color}m${message}\x1b[0m\n` : `${message}\n`);
}

/** Python ``str.title()`` */
export function pyTitle(text: string): string {
  let out = '';
  let prevCased = false;
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    const cased = lower !== upper;
    if (cased) {
      out += prevCased ? lower : upper;
    } else {
      out += ch;
    }
    prevCased = cased;
  }
  return out;
}

/**
 * POSIX ``shlex.split`` port. Throws {@link ValueError} with the same
 * messages Python raises (``No closing quotation`` / ``No escaped character``).
 */
export function shlexSplit(s: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = s.length;
  const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  while (i < n) {
    while (i < n && isWs(s[i])) i++;
    if (i >= n) break;
    let token = '';
    let inToken = false;
    while (i < n && !isWs(s[i])) {
      const c = s[i];
      inToken = true;
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end === -1) throw new ValueError('No closing quotation');
        token += s.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        i++;
        let closed = false;
        while (i < n) {
          const d = s[i];
          if (d === '"') {
            closed = true;
            i++;
            break;
          }
          if (d === '\\' && i + 1 < n && ['\\', '"', '$', '`', '\n'].includes(s[i + 1])) {
            token += s[i + 1];
            i += 2;
            continue;
          }
          if (d === '\\' && i + 1 >= n) {
            throw new ValueError('No closing quotation');
          }
          token += d;
          i++;
        }
        if (!closed) throw new ValueError('No closing quotation');
      } else if (c === '\\') {
        if (i + 1 >= n) throw new ValueError('No escaped character');
        token += s[i + 1];
        i += 2;
      } else {
        token += c;
        i++;
      }
    }
    if (inToken) tokens.push(token);
  }
  return tokens;
}

/** POSIX ``shlex.quote`` */
export function shlexQuote(s: string): string {
  if (s === '') return "''";
  if (!/[^\w@%+=:,./-]/.test(s)) return s;
  return "'" + s.replace(/'/g, `'"'"'`) + "'";
}

/**
 * ``shutil.which``: resolve *cmd* on ``PATH`` (honours ``PATHEXT`` on
 * Windows). Returns the absolute path, or ``null``.
 */
export function shutilWhich(cmd: string): string | null {
  const isWin = process.platform === 'win32';
  const exts = isWin ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const candidatesFor = (base: string): string[] => {
    if (!isWin) return [base];
    const hasExt = exts.some((e) => base.toLowerCase().endsWith(e.toLowerCase()));
    return hasExt ? [base, ...exts.map((e) => base + e)] : exts.map((e) => base + e);
  };
  const executable = (p: string): boolean => {
    try {
      const st = statSync(p);
      if (!st.isFile()) return false;
      if (isWin) return true;
      accessSync(p, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (cmd.includes('/') || (isWin && cmd.includes('\\'))) {
    for (const c of candidatesFor(cmd)) if (executable(c)) return c;
    return null;
  }
  const pathDirs = (process.env.PATH ?? '').split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const c of candidatesFor(join(dir, cmd))) {
      if (executable(c)) return c;
    }
  }
  return null;
}

// ============================================================================
// yaml_quote
// ============================================================================

const YAML_ESCAPE_REPLACEMENTS: Record<string, string> = {
  '\0': '0',
  '\x07': 'a',
  '\x08': 'b',
  '\x09': 't',
  '\x0A': 'n',
  '\x0B': 'v',
  '\x0C': 'f',
  '\x0D': 'r',
  '\x1B': 'e',
  '"': '"',
  '\\': '\\',
  '\x85': 'N',
  '\xA0': '_',
  '\u2028': 'L',
  '\u2029': 'P',
};

/**
 * Emit *value* as a double-quoted YAML scalar on a single line — the exact
 * output of ``yaml.safe_dump(str(value), default_style='"',
 * allow_unicode=True, width=sys.maxsize).strip()``.
 */
export function yamlQuote(value: unknown): string {
  const text = String(value);
  let out = '"';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const printable =
      (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd);
    if (ch === '"' || ch === '\\' || ch === '\x85' || ch === '\u2028' || ch === '\u2029' || ch === '\ufeff' || !printable) {
      if (ch in YAML_ESCAPE_REPLACEMENTS) {
        out += '\\' + YAML_ESCAPE_REPLACEMENTS[ch];
      } else if (cp <= 0xff) {
        out += '\\x' + cp.toString(16).toUpperCase().padStart(2, '0');
      } else if (cp <= 0xffff) {
        out += '\\u' + cp.toString(16).toUpperCase().padStart(4, '0');
      } else {
        out += '\\U' + cp.toString(16).toUpperCase().padStart(8, '0');
      }
    } else {
      out += ch;
    }
  }
  return out + '"';
}

// ============================================================================
// Bundled asset location
// ============================================================================

/**
 * Locate the bundled ``core_pack`` directory. Works from ``src/integrations``
 * (source checkout), ``src/`` and ``dist/`` (bundled build).
 */
export function corePackDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', '..', 'core_pack'), join(here, '..', 'core_pack'), join(here, 'core_pack')]) {
    if (isDir(candidate)) return candidate;
  }
  return null;
}

// ============================================================================
// Types
// ============================================================================

/** Metadata dict matching the ``AGENT_CONFIG`` shape. */
export interface IntegrationConfig {
  name: string;
  folder: string | null;
  commands_subdir: string;
  install_url: string | null;
  requires_cli: boolean;
  [key: string]: unknown;
}

/** Command output format written by the registrar. */
export type CommandFormat = 'markdown' | 'toml' | 'yaml';

/** Registration dict matching ``CommandRegistrar.AGENT_CONFIGS`` shape. */
export interface RegistrarConfig {
  dir: string;
  format: CommandFormat;
  args: string;
  extension: string;
  legacy_dir?: string;
  detect_dir?: string;
  strip_frontmatter_keys?: string[];
  inject_name?: boolean;
  format_name?: (cmdName: string) => string;
  invoke_separator?: string;
  dev_no_symlink?: boolean;
  [key: string]: unknown;
}

/** Parsed ``--integration-options`` (keys use underscores, e.g. ``commands_dir``). */
export type ParsedOptions = Record<string, unknown>;

/** Extra keyword options for ``setup()`` / ``install()`` (Python ``**opts``). */
export interface SetupOptions {
  /** Script variant (``sh`` | ``ps`` | ``py``). Default ``sh``. */
  scriptType?: string;
  /** Raw ``--integration-options`` string (used by ``generic``). */
  rawOptions?: string | null;
  /** Canonical events configuration forwarded to ``emitEvents``. */
  events?: IntegrationEvents | null;
  /** snake_case aliases accepted for convenience. */
  script_type?: string;
  raw_options?: string | null;
  [key: string]: unknown;
}

/** Options for ``buildExecArgs()`` (Python keyword-only args). */
export interface ExecArgsOptions {
  model?: string | null;
  /** Default ``true``. */
  outputJson?: boolean;
  integrationArgs?: readonly string[] | null;
  integrationOptions?: Record<string, unknown> | null;
  projectRoot?: string | null;
}

/** Options for ``dispatchCommand()``. */
export interface DispatchOptions {
  /** Command arguments (alternative to the positional ``args``). */
  args?: string;
  projectRoot?: string | null;
  model?: string | null;
  /** Seconds (captured mode only). Default 600. */
  timeout?: number;
  /** Default ``true``: inherit stdio; ``false``: capture output. */
  stream?: boolean;
  integrationArgs?: readonly string[] | null;
  integrationOptions?: Record<string, unknown> | null;
}

/** Result of ``dispatchCommand()`` (Python dict). */
export interface DispatchResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

/** Raised when a captured dispatch exceeds its timeout (``subprocess.TimeoutExpired``). */
export class TimeoutExpired extends Error {
  cmd: string[];
  timeout: number;
  constructor(cmd: string[], timeout: number) {
    super(`Command '${JSON.stringify(cmd)}' timed out after ${timeout} seconds`);
    this.name = 'TimeoutExpired';
    this.cmd = cmd;
    this.timeout = timeout;
  }
}

// ============================================================================
// IntegrationOption
// ============================================================================

/** Declares an option that an integration accepts via ``--integration-options``. */
export class IntegrationOption {
  /** The flag name (e.g. ``"--commands-dir"``). */
  readonly name: string;
  /** ``true`` for boolean flags (``--skills``). */
  readonly isFlag: boolean;
  /** ``true`` if the option must be supplied. */
  readonly required: boolean;
  /** Default value when not supplied (``null`` → no default). */
  readonly default: unknown;
  /** One-line description. */
  readonly help: string;

  constructor(
    name: string,
    opts: { isFlag?: boolean; required?: boolean; default?: unknown; help?: string } = {},
  ) {
    this.name = name;
    this.isFlag = opts.isFlag ?? false;
    this.required = opts.required ?? false;
    this.default = opts.default ?? null;
    this.help = opts.help ?? '';
    Object.freeze(this);
  }

  /** Python-compatible alias. */
  get is_flag(): boolean {
    return this.isFlag;
  }
}

// ============================================================================
// Frontmatter helpers shared by the concrete bases
// ============================================================================

/** Split YAML frontmatter from the remaining body (``_split_frontmatter``). */
export function splitFrontmatter(content: string): [string, string] {
  if (!content.startsWith('---')) return ['', content];
  const lines = splitlines(content, true);
  if (lines.length === 0 || lines[0].replace(/[\r\n]+$/, '') !== '---') return ['', content];
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/[\r\n]+$/, '') === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return ['', content];
  return [lines.slice(1, end).join(''), lines.slice(end + 1).join('')];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** ``yaml.safe_load`` that returns ``undefined`` on any YAML error. */
function safeLoad(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: parseYaml(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Parse the frontmatter block of a skills-source template (line-anchored
 * closing ``---``; block parsed unstripped). Returns ``{}`` on failure.
 */
export function parseTemplateFrontmatter(raw: string): Record<string, unknown> {
  if (!raw.startsWith('---')) return {};
  const lines = splitlines(raw, true);
  let close: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    if (pyRstrip(lines[i]) === '---') {
      close = i;
      break;
    }
  }
  if (close === null) return {};
  const res = safeLoad(lines.slice(1, close).join(''));
  if (res.ok && isPlainObject(res.value)) return res.value;
  return {};
}

/**
 * Strip the (processed) frontmatter from a template, keeping whatever trails
 * the closing ``---`` marker (identical to ``split("---", 2)[2]``).
 */
export function stripTemplateFrontmatter(processed: string): string {
  if (!processed.startsWith('---')) return processed;
  const lines = splitlines(processed, true);
  for (let i = 1; i < lines.length; i++) {
    if (pyRstrip(lines[i]) === '---') {
      return lines[i].slice(3) + lines.slice(i + 1).join('');
    }
  }
  return processed;
}

/** Python truthiness for YAML-loaded values. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object' && !(value instanceof Date)) return Object.keys(value as object).length > 0;
  return Boolean(value);
}

/** Python ``str(value)`` for YAML scalars. */
export function pyStr(value: unknown): string {
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null || value === undefined) return 'None';
  return String(value);
}

// ============================================================================
// Shared rendering helpers (also exposed via CommandRegistrar)
// ============================================================================

const PROJECT_REL_PATH_RE =
  /(?:(?<![.\p{L}\p{N}_])(?<parent>(?:\.\.\/){2,})|(?<boundary>^|[\s`"'(\[{<=])(?<rel>\.specify\/|(?:\.?\/))?)(?<target>scripts|memory|templates)\//gu;

/**
 * Rewrite repo-relative paths (``scripts/``, ``memory/``, ``templates/``,
 * ``../../scripts/``) to their generated ``.specify/...`` locations
 * (``CommandRegistrar.rewrite_project_relative_paths``).
 */
export function rewriteProjectRelativePaths(text: string, extensionId: string | null = null): string {
  if (typeof text !== 'string' || !text) return text;
  const scriptsReplacement = extensionId ? `.specify/extensions/${extensionId}/scripts/` : '.specify/scripts/';
  return text.replace(PROJECT_REL_PATH_RE, (...args: unknown[]) => {
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    const whole = args[0] as string;
    const target = groups.target as string;
    if (groups.parent) return `.specify/${target}/`;
    const prefix = groups.boundary ?? '';
    const rel = groups.rel;
    if (rel === '.specify/') return whole;
    if (target === 'scripts') return `${prefix}${scriptsReplacement}`;
    return `${prefix}.specify/${target}/`;
  });
}

/** Consistent SKILL.md frontmatter across all skill generators. */
export function buildSkillFrontmatter(
  _agentName: string,
  skillName: string,
  description: unknown,
  source: string,
  author: unknown = 'github-spec-kit',
): Record<string, unknown> {
  const normalizedAuthor = author === null || author === undefined || author === '' ? 'github-spec-kit' : pyStr(author);
  return {
    name: skillName,
    description,
    compatibility: 'Requires spec-kit project structure with .specify/ directory',
    metadata: {
      author: normalizedAuthor,
      source,
    },
  };
}

// ============================================================================
// IntegrationBase — abstract base class
// ============================================================================

/**
 * Abstract base class every integration must implement.
 *
 * Subclasses must set ``key``, ``config`` and ``registrarConfig`` and may set
 * ``invokeSeparator`` (default ``"."``) and ``multiInstallSafe``.
 */
export abstract class IntegrationBase {
  // -- Must be set by every subclass ------------------------------------

  /** Unique integration key — should match the actual CLI tool name. */
  key = '';

  /** Metadata dict matching the ``AGENT_CONFIG`` shape. */
  config: IntegrationConfig | null = null;

  /** Registration dict matching ``CommandRegistrar.AGENT_CONFIGS`` shape. */
  registrarConfig: RegistrarConfig | null = null;

  // -- Optional ---------------------------------------------------------

  /** Separator used in slash-command invocations (``"."`` → ``/speckit.plan``). */
  invokeSeparator = '.';

  /** Whether dev-mode registration should write files instead of symlinks. */
  devNoSymlink = false;

  /** Whether this integration is declared safe to install alongside others. */
  multiInstallSafe = false;

  /** Previous flat command directory retired after skill replacements exist. */
  legacyFlatCommandDir: string | null = null;

  /** File extension used by commands in ``legacyFlatCommandDir``. */
  legacyFlatCommandExtension: string | null = null;

  // -- Runtime events (optional; consumed by src/events) ------------------

  /** Canonical event name → native event name. */
  CANONICAL_TO_NATIVE: Record<string, string> | null = null;
  /** Project-relative native events config file. */
  eventsConfigFile: string | null = null;
  /** Native events file format (``json-nested``, ``toml``, ``ts-plugin``, ...). */
  eventsFormat: string | null = null;
  /** Hook-stdout context envelope keyed by canonical event (``*`` fallback). */
  eventsContextEnvelope: Record<string, string> = {};
  /** Native timeout unit (``ms`` for Gemini-style agents). */
  eventsTimeoutUnit: string | null = null;

  /** Python-compatible alias of {@link registrarConfig}. */
  get registrar_config(): RegistrarConfig | null {
    return this.registrarConfig;
  }

  /** Python-compatible alias of {@link invokeSeparator}. */
  get invoke_separator(): string {
    return this.invokeSeparator;
  }

  /** Python-compatible alias of {@link multiInstallSafe}. */
  get multi_install_safe(): boolean {
    return this.multiInstallSafe;
  }

  /**
   * Transform command content after format rendering (non-skills formats).
   * Default: unchanged.
   */
  postProcessCommandContent(content: string): string {
    return content;
  }

  // -- Public API -------------------------------------------------------

  /** Return options this integration accepts. Default: ``--events`` when events are supported. */
  options(): IntegrationOption[] {
    const opts: IntegrationOption[] = [];
    if (this.CANONICAL_TO_NATIVE && Object.keys(this.CANONICAL_TO_NATIVE).length > 0 && this.eventsConfigFile) {
      opts.push(
        new IntegrationOption('--events', {
          isFlag: false,
          default: 'true',
          help: 'Enable/disable runtime events (true|false, default: true)',
        }),
      );
    }
    return opts;
  }

  /** Return the invoke separator for the given options. */
  effectiveInvokeSeparator(_parsedOptions?: ParsedOptions | null, _projectRoot?: string | null): string {
    return this.invokeSeparator;
  }

  /** Command-ref separator given the project's *resolved* skills state. */
  invokeSeparatorForMode(_skillsEnabled: boolean): string {
    const cfg = this.registrarConfig ?? ({} as Partial<RegistrarConfig>);
    return typeof cfg.invoke_separator === 'string' ? cfg.invoke_separator : this.invokeSeparator;
  }

  /** Whether this integration scaffolds skills for these options. */
  isSkillsMode(parsedOptions?: ParsedOptions | null, _projectRoot?: string | null): boolean {
    return Boolean((parsedOptions ?? {}).skills);
  }

  /**
   * Build CLI arguments for non-interactive execution, or ``null`` if the
   * integration does not support CLI dispatch.
   */
  buildExecArgs(_prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    return null;
  }

  /** Validate per-step CLI configuration for this integration. */
  validateRuntimeConfig(
    integrationArgs?: readonly string[] | null,
    integrationOptions?: Record<string, unknown> | null,
  ): void {
    if (integrationArgs && integrationArgs.length > 0) {
      throw new ValueError(`Integration '${this.key}' does not support per-step 'integration_args'.`);
    }
    if (integrationOptions && Object.keys(integrationOptions).length > 0) {
      const names = Object.keys(integrationOptions).map(String).sort().join(', ');
      throw new ValueError(
        `Integration '${this.key}' does not support per-step 'integration_options' (${names}).`,
      );
    }
  }

  /** Env-var name prefix ``SPECKIT_INTEGRATION_<KEY>_``. */
  protected envPrefix(): string {
    return `SPECKIT_INTEGRATION_${this.key.toUpperCase().replace(/-/g, '_')}_`;
  }

  /**
   * Return the executable for this integration's CLI tool
   * (``SPECKIT_INTEGRATION_<KEY>_EXECUTABLE`` override, else ``key``).
   */
  resolveExecutable(): string {
    const override = (process.env[`${this.envPrefix()}EXECUTABLE`] ?? '').trim();
    return override ? override : this.key;
  }

  /** Append ``SPECKIT_INTEGRATION_<KEY>_EXTRA_ARGS`` tokens to *args*. */
  applyExtraArgsEnvVar(args: string[]): void {
    const envName = `${this.envPrefix()}EXTRA_ARGS`;
    const extra = (process.env[envName] ?? '').trim();
    if (!extra) return;
    let tokens: string[];
    try {
      tokens = shlexSplit(extra);
    } catch (exc) {
      throw new ValueError(
        `${envName} is not parseable as a POSIX-quoted command line ` +
          `(value: ${pyRepr(extra)}). shlex reported: ${(exc as Error).message}. ` +
          `Use single or double quotes to group multi-word values, e.g. ` +
          `${envName}='--flag "value with spaces"'.`,
      );
    }
    args.push(...tokens);
  }

  /** Build the native slash-command invocation for a Spec Kit command. */
  buildCommandInvocation(commandName: string, args = ''): string {
    let stem = commandName;
    if (stem.startsWith('speckit.')) stem = stem.slice('speckit.'.length);
    let invocation = `/speckit.${stem}`;
    if (args) invocation = `${invocation} ${args}`;
    return invocation;
  }

  /** Return the dispatch prompt, given the target *projectRoot*. */
  buildDispatchPrompt(commandName: string, args: string, _projectRoot: string | null): string {
    return this.buildCommandInvocation(commandName, args);
  }

  /**
   * Dispatch a Spec Kit command through this integration's CLI.
   * Returns ``{exit_code, stdout, stderr}``. Throws
   * {@link NotImplementedError} if dispatch is unsupported.
   */
  dispatchCommand(commandName: string, argsOrOpts: string | DispatchOptions = '', maybeOpts: DispatchOptions = {}): DispatchResult {
    const [args, opts] = normalizeDispatchArgs(argsOrOpts, maybeOpts);
    const stream = opts.stream ?? true;
    this.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
    const prompt = this.buildDispatchPrompt(commandName, args, opts.projectRoot ?? null);
    let execArgs = this.buildExecArgs(prompt, {
      model: opts.model ?? null,
      outputJson: !stream,
      integrationArgs: opts.integrationArgs,
      integrationOptions: opts.integrationOptions,
      projectRoot: opts.projectRoot ?? null,
    });
    if (execArgs === null) {
      throw new NotImplementedError(
        `Integration '${this.key}' does not support CLI dispatch. Override build_exec_args() to enable it.`,
      );
    }
    const resolved = shutilWhich(execArgs[0]);
    if (resolved) execArgs = [resolved, ...execArgs.slice(1)];
    return runSubprocess(execArgs, opts.projectRoot ?? null, stream, opts.timeout ?? 600);
  }

  // -- Primitives — building blocks for setup() -------------------------

  /** Path to the shared command templates directory (``core_pack/commands``). */
  sharedCommandsDir(): string | null {
    const pack = corePackDir();
    if (pack && isDir(join(pack, 'commands'))) return join(pack, 'commands');
    return null;
  }

  /** Path to the shared page templates directory (``core_pack/templates``). */
  sharedTemplatesDir(): string | null {
    const pack = corePackDir();
    if (pack && isDir(join(pack, 'templates'))) return join(pack, 'templates');
    return null;
  }

  /** Ordered list of command template files (absolute paths). */
  listCommandTemplates(): string[] {
    const cmdDir = this.sharedCommandsDir();
    if (!cmdDir || !isDir(cmdDir)) return [];
    const files = readdirSync(cmdDir)
      .filter((name) => extname(name) === '.md' && isFile(join(cmdDir, name)));
    const rank = (name: string) => {
      const stem = parsePath(name).name;
      return stem in CORE_COMMAND_TEMPLATE_RANK ? CORE_COMMAND_TEMPLATE_RANK[stem] : CORE_COMMAND_TEMPLATE_ORDER.length;
    };
    files.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
    return files.map((name) => join(cmdDir, name));
  }

  /** Destination filename for a command template stem. */
  commandFilename(templateName: string): string {
    return `speckit.${templateName}.md`;
  }

  /** Project-relative paths that upgrade must never stale-delete. */
  staleCleanupExclusions(): Set<string> {
    const exclusions = new Set<string>();
    if (this.supportsEvents()) {
      for (const p of eventsBridge?.eventsStaleExclusions(this.key) ?? []) exclusions.add(p);
    }
    return exclusions;
  }

  /** Absolute path to the commands output directory. */
  commandsDest(projectRoot: string): string {
    if (!this.config) {
      throw new ValueError(
        `${this.constructor.name}.config is not set; integration subclasses must define a non-empty 'config' mapping.`,
      );
    }
    const folder = this.config.folder;
    if (!folder) {
      throw new ValueError(`${this.constructor.name}.config is missing required 'folder' entry.`);
    }
    const subdir = this.config.commands_subdir ?? 'commands';
    return join(projectRoot, folder, subdir);
  }

  // -- File operations — granular primitives for setup() ----------------

  /** Copy a command template to *destDir* with *filename*. */
  static copyCommandToDirectory(src: string, destDir: string, filename: string): string {
    mkdirSync(destDir, { recursive: true });
    const dst = join(destDir, filename);
    copyFileSync(src, dst);
    return dst;
  }

  /** Hash *filePath* and record it in *manifest* (must be inside *projectRoot*). */
  static recordFileInManifest(filePath: string, projectRoot: string, manifest: IntegrationManifest): void {
    const rel = relativeTo(resolvePath(filePath), resolvePath(projectRoot));
    manifest.recordExisting(rel);
  }

  /** Write *content* (CRLF → LF) to *dest*, hash it and record it. Returns *dest*. */
  static writeFileAndRecord(content: string, dest: string, projectRoot: string, manifest: IntegrationManifest): string {
    mkdirSync(dirname(dest), { recursive: true });
    const normalized = replaceAllLiteral(content, '\r\n', '\n');
    writeFileSync(dest, Buffer.from(normalized, 'utf-8'));
    const rel = relativeTo(resolvePath(dest), resolvePath(projectRoot));
    manifest.recordExisting(rel);
    return dest;
  }

  // Instance aliases so subclasses can call ``this.writeFileAndRecord`` like Python's ``self.``
  copyCommandToDirectory(src: string, destDir: string, filename: string): string {
    return IntegrationBase.copyCommandToDirectory(src, destDir, filename);
  }
  recordFileInManifest(filePath: string, projectRoot: string, manifest: IntegrationManifest): void {
    IntegrationBase.recordFileInManifest(filePath, projectRoot, manifest);
  }
  writeFileAndRecord(content: string, dest: string, projectRoot: string, manifest: IntegrationManifest): string {
    return IntegrationBase.writeFileAndRecord(content, dest, projectRoot, manifest);
  }

  /**
   * Path to this integration's bundled ``scripts/`` directory, or ``null``.
   * No built-in integration ships one; subclasses may override.
   */
  integrationScriptsDir(): string | null {
    return null;
  }

  /** Copy integration-specific scripts into ``.specify/integrations/<key>/scripts/``. */
  installScripts(projectRoot: string, manifest: IntegrationManifest): string[] {
    const scriptsSrc = this.integrationScriptsDir();
    if (!scriptsSrc) return [];
    const created: string[] = [];
    const scriptsDest = join(projectRoot, '.specify', 'integrations', this.key, 'scripts');
    mkdirSync(scriptsDest, { recursive: true });
    for (const name of readdirSync(scriptsSrc).sort()) {
      const src = join(scriptsSrc, name);
      if (!isFile(src)) continue;
      const dst = join(scriptsDest, name);
      copyFileSync(src, dst);
      if (dst.endsWith('.sh') || dst.endsWith('.py')) {
        chmodSync(dst, statSync(dst).mode | 0o111);
      }
      this.recordFileInManifest(dst, projectRoot, manifest);
      created.push(dst);
    }
    return created;
  }

  /**
   * Replace ``__SPECKIT_COMMAND_<NAME>__`` placeholders with invocations
   * joined by *separator* and prefixed by *prefix*.
   */
  static resolveCommandRefs(content: string, separator = '.', prefix = '/'): string {
    return content.replace(
      /__SPECKIT_COMMAND_([A-Z][A-Z0-9_-]*)__/g,
      (_m, name: string) => prefix + 'speckit' + separator + replaceAllLiteral(name.toLowerCase(), '_', separator),
    );
  }

  /**
   * Resolve a portable Python interpreter command for ``{SCRIPT}``
   * (project ``.venv`` → ``python3`` → ``python`` → running interpreter).
   */
  static resolvePythonInterpreter(projectRoot: string | null = null): string {
    if (projectRoot !== null && projectRoot !== undefined) {
      const candidates: Array<[string, string]> = [
        [join(projectRoot, '.venv', 'bin', 'python'), '.venv/bin/python'],
        [join(projectRoot, '.venv', 'Scripts', 'python.exe'), '.venv/Scripts/python.exe'],
      ];
      for (const [candidate, rel] of candidates) {
        if (existsSync(candidate)) return rel;
      }
    }
    for (const name of ['python3', 'python']) {
      const found = shutilWhich(name);
      if (!found) continue;
      if (process.platform === 'win32' && !IntegrationBase.interpreterRuns(found)) continue;
      return name;
    }
    // No ``sys.executable`` in Node; Python falls back to "python3".
    return 'python3';
  }

  /** Build a Python script command for the current platform shell. */
  static buildPythonInvocation(scriptCommand: string, projectRoot: string | null = null): string {
    let interpreter = IntegrationBase.resolvePythonInterpreter(projectRoot);
    if (process.platform === 'win32') {
      if (!/^[A-Za-z0-9_./:\\-]+$/.test(interpreter)) {
        interpreter = `& '${interpreter.replace(/'/g, "''")}'`;
      }
    } else {
      interpreter = shlexQuote(interpreter);
    }
    return `${interpreter} ${scriptCommand}`;
  }

  /** Select the requested variant or a runnable platform fallback. */
  static selectScriptVariant(requested: unknown, scriptCommands: Record<string, unknown>): string {
    if (typeof requested === 'string' && requested in scriptCommands) return requested;
    const platformVariant = process.platform === 'win32' ? 'ps' : 'sh';
    const secondary = platformVariant === 'ps' ? 'sh' : 'ps';
    const fallbacks = requested === 'py' ? [platformVariant, 'py'] : [platformVariant, secondary, 'py'];
    for (const candidate of fallbacks) {
      if (candidate in scriptCommands) return candidate;
    }
    const available = Object.keys(scriptCommands).sort().join(', ') || 'none';
    throw new ValueError(
      `No runnable script variant for this platform: requested ${pyRepr(requested)}; available: ${available}`,
    );
  }

  /** True when *path* executes as a Python interpreter. */
  static interpreterRuns(path: string): boolean {
    try {
      const r = spawnSync(path, ['-I', '-S', '-c', ''], { stdio: 'ignore', timeout: 15000 });
      return r.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Process a raw command template into agent-ready content:
   * select ``scripts.<scriptType>``, replace ``{SCRIPT}``, strip ``scripts:``
   * from frontmatter, replace ``{ARGS}``/``$ARGUMENTS``, ``__AGENT__``,
   * rewrite project-relative paths, and resolve ``__SPECKIT_COMMAND_*__``.
   */
  static processTemplate(
    content: string,
    agentName: string,
    scriptType: string,
    argPlaceholder = '$ARGUMENTS',
    invokeSeparator = '.',
    projectRoot: string | null = null,
  ): string {
    // 1. Extract script command from frontmatter
    const scriptCommands: Record<string, string> = {};
    const scriptPattern = /^\s*([A-Za-z0-9_-]+):\s*(.+)$/;
    let inFrontmatter = false;
    let inScripts = false;
    for (const line of splitlines(content)) {
      if (line === '---') {
        if (inFrontmatter) break;
        inFrontmatter = true;
        continue;
      }
      if (!inFrontmatter) continue;
      if (line === 'scripts:') {
        inScripts = true;
        continue;
      }
      if (inScripts && line && !pyIsSpace(line[0])) break;
      if (inScripts) {
        const m = scriptPattern.exec(line);
        if (m) scriptCommands[m[1]] = pyStrip(m[2]);
      }
    }

    const selected = Object.keys(scriptCommands).length > 0
      ? IntegrationBase.selectScriptVariant(scriptType, scriptCommands)
      : '';
    let scriptCommand = scriptCommands[selected] ?? '';

    // 2. Replace {SCRIPT}
    if (scriptCommand) {
      if (selected === 'py') {
        scriptCommand = IntegrationBase.buildPythonInvocation(scriptCommand, projectRoot);
      }
      content = replaceAllLiteral(content, '{SCRIPT}', scriptCommand);
    }

    // 3. Strip scripts: section from frontmatter
    const lines = splitlines(content, true);
    const output: string[] = [];
    inFrontmatter = false;
    let skip = false;
    let dashCount = 0;
    for (const line of lines) {
      const stripped = line.replace(/[\n\r]+$/, '');
      if (stripped === '---') {
        dashCount += 1;
        inFrontmatter = dashCount === 1;
        skip = false;
        output.push(line);
        continue;
      }
      if (inFrontmatter) {
        if (stripped === 'scripts:') {
          skip = true;
          continue;
        }
        if (skip) {
          if (pyIsSpace(line.slice(0, 1))) continue;
          skip = false;
        }
      }
      output.push(line);
    }
    content = output.join('');

    // 4. Replace {ARGS} and $ARGUMENTS
    content = replaceAllLiteral(content, '{ARGS}', argPlaceholder);
    content = replaceAllLiteral(content, '$ARGUMENTS', argPlaceholder);

    // 5. Replace __AGENT__
    content = replaceAllLiteral(content, '__AGENT__', agentName);

    // 6. Rewrite paths
    content = rewriteProjectRelativePaths(content);

    // 7. Replace __SPECKIT_COMMAND_<NAME>__
    const prefix = getInvocationPrefix(agentName, invokeSeparator === '-');
    return IntegrationBase.resolveCommandRefs(content, invokeSeparator, prefix);
  }

  /**
   * Instance entry point used by ``setup()`` implementations (Python
   * ``self.process_template``). ``invokeSeparator`` left ``undefined`` uses
   * the static default (``"."``); integrations such as Junie/Cline override
   * this to default to their own separator.
   */
  processTemplate(
    content: string,
    agentName: string,
    scriptType: string,
    argPlaceholder = '$ARGUMENTS',
    invokeSeparator?: string,
    projectRoot: string | null = null,
  ): string {
    return IntegrationBase.processTemplate(content, agentName, scriptType, argPlaceholder, invokeSeparator ?? '.', projectRoot);
  }

  /** Validate the manifest/project root pair and the destination containment. */
  protected checkedDest(projectRoot: string, manifest: IntegrationManifest, dest: string, label = 'Integration destination'): string {
    const rootResolved = resolvePath(projectRoot);
    if (manifest.projectRoot !== rootResolved) {
      throw new ValueError(
        `manifest.project_root (${manifest.projectRoot}) does not match project_root (${rootResolved})`,
      );
    }
    const resolved = resolvePath(dest);
    if (!isRelativeTo(resolved, rootResolved)) {
      throw new ValueError(`${label} ${resolved} escapes project root ${rootResolved}`);
    }
    return resolved;
  }

  /**
   * Install integration command files into *projectRoot*. Base copies raw
   * templates without processing. Returns created (absolute) paths.
   */
  setup(projectRoot: string, manifest: IntegrationManifest, _parsedOptions?: ParsedOptions | null, _opts: SetupOptions = {}): string[] {
    const templates = this.listCommandTemplates();
    if (templates.length === 0) return [];
    const dest = this.checkedDest(projectRoot, manifest, this.commandsDest(projectRoot));
    const created: string[] = [];
    for (const src of templates) {
      const dstName = this.commandFilename(parsePath(src).name);
      const dst = this.copyCommandToDirectory(src, dest, dstName);
      this.recordFileInManifest(dst, projectRoot, manifest);
      created.push(dst);
    }
    return created;
  }

  /** Uninstall integration files. Returns ``[removed, skipped]``. */
  teardown(projectRoot: string, manifest: IntegrationManifest, opts: { force?: boolean } = {}): [string[], string[]] {
    this.removeEvents(projectRoot, manifest);
    return manifest.uninstall(projectRoot, { force: opts.force ?? false });
  }

  /** Emit native event configuration for this integration. */
  emitEvents(
    projectRoot: string,
    manifest: IntegrationManifest,
    events?: IntegrationEvents | null,
    _parsedOptions?: ParsedOptions | null,
  ): string[] {
    if (!eventsBridge) return [];
    return eventsBridge.installIntegrationEvents(this, projectRoot, manifest, events ?? {});
  }

  /** Remove Specify-authored event entries from native config. */
  removeEvents(projectRoot: string, manifest: IntegrationManifest): void {
    eventsBridge?.removeIntegrationEvents(this, projectRoot, manifest);
  }

  /** True if this integration supports agent-native events. */
  supportsEvents(): boolean {
    return Boolean(this.CANONICAL_TO_NATIVE && Object.keys(this.CANONICAL_TO_NATIVE).length > 0 && this.eventsConfigFile);
  }

  // -- Convenience helpers ----------------------------------------------

  /** High-level install — calls ``setup()``. */
  install(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    return this.setup(projectRoot, manifest, parsedOptions, opts);
  }

  /** High-level uninstall — calls ``teardown()``. */
  uninstall(projectRoot: string, manifest: IntegrationManifest, opts: { force?: boolean } = {}): [string[], string[]] {
    return this.teardown(projectRoot, manifest, opts);
  }
}

/** Read ``scriptType`` from setup options (camelCase or snake_case), default ``sh``. */
export function scriptTypeOf(opts: SetupOptions | undefined): string {
  const v = opts?.scriptType ?? opts?.script_type;
  return typeof v === 'string' && v ? v : 'sh';
}

/** Python ``repr()`` for simple values (strings use single quotes). */
export function pyRepr(value: unknown): string {
  if (typeof value === 'string') {
    const hasSingle = value.includes("'");
    const hasDouble = value.includes('"');
    const quote = hasSingle && !hasDouble ? '"' : "'";
    let body = value
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    if (quote === "'") body = body.replace(/'/g, "\\'");
    return quote + body + quote;
  }
  return pyStr(value);
}

/**
 * Normalise ``dispatchCommand(name, args, opts)`` and
 * ``dispatchCommand(name, {args, ...opts})`` call styles.
 */
export function normalizeDispatchArgs(argsOrOpts: string | DispatchOptions | undefined, maybeOpts: DispatchOptions = {}): [string, DispatchOptions] {
  if (typeof argsOrOpts === 'string') return [argsOrOpts, maybeOpts];
  const opts = { ...(argsOrOpts ?? {}), ...maybeOpts };
  return [opts.args ?? '', opts];
}

/** Run a subprocess the way ``dispatch_command`` does. */
export function runSubprocess(args: string[], cwd: string | null, stream: boolean, timeoutSeconds = 600): DispatchResult {
  // ``specify workflow run --json`` redirects child stdout to stderr so the
  // JSON document on stdout stays clean (upstream fd-level dup2).
  const redirect = runtimeIO.stdoutToStderr;
  if (stream) {
    const r = spawnSync(args[0], args.slice(1), {
      cwd: cwd ?? undefined,
      stdio: redirect ? ['inherit', 2, 'inherit'] : 'inherit',
    });
    if (r.signal === 'SIGINT') {
      return { exit_code: 130, stdout: '', stderr: 'Interrupted by user' };
    }
    if (r.error) throw r.error;
    return { exit_code: r.status ?? 1, stdout: '', stderr: '' };
  }
  const r = spawnSync(args[0], args.slice(1), {
    cwd: cwd ?? undefined,
    encoding: 'utf-8',
    timeout: timeoutSeconds * 1000,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw new TimeoutExpired(args, timeoutSeconds);
    throw r.error;
  }
  return { exit_code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ============================================================================
// Shared setup loop for the Markdown/TOML/YAML bases
// ============================================================================

function argPlaceholderOf(integration: IntegrationBase, fallback: string): string {
  const cfg = integration.registrarConfig;
  return cfg && typeof cfg.args === 'string' ? cfg.args : fallback;
}

/** Default ``-p`` style exec args shared by Markdown/Skills integrations. */
function defaultExecArgs(integration: IntegrationBase, prompt: string, opts: ExecArgsOptions, modelFlag: string): string[] | null {
  integration.validateRuntimeConfig(opts.integrationArgs, opts.integrationOptions);
  if (!integration.config || !integration.config.requires_cli) return null;
  const args = [integration.resolveExecutable(), '-p', prompt];
  integration.applyExtraArgsEnvVar(args);
  if (opts.model) args.push(modelFlag, opts.model);
  if (opts.outputJson ?? true) args.push('--output-format', 'json');
  return args;
}

// ============================================================================
// MarkdownIntegration
// ============================================================================

/** Concrete base for integrations that use standard Markdown commands. */
export class MarkdownIntegration extends IntegrationBase {
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    return defaultExecArgs(this, prompt, opts, '--model');
  }

  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    const templates = this.listCommandTemplates();
    if (templates.length === 0) return [];
    const dest = this.checkedDest(projectRoot, manifest, this.commandsDest(projectRoot));
    mkdirSync(dest, { recursive: true });
    const scriptType = scriptTypeOf(opts);
    const argPlaceholder = argPlaceholderOf(this, '$ARGUMENTS');
    const created: string[] = [];
    for (const src of templates) {
      const raw = readFileSync(src, 'utf-8');
      const processed = this.processTemplate(raw, this.key, scriptType, argPlaceholder, undefined, projectRoot);
      const dstName = this.commandFilename(parsePath(src).name);
      created.push(this.writeFileAndRecord(processed, join(dest, dstName), projectRoot, manifest));
    }
    created.push(...this.emitEvents(projectRoot, manifest, opts.events, parsedOptions));
    return created;
  }
}

// ============================================================================
// TomlIntegration
// ============================================================================

/** Concrete base for integrations that use TOML command format. */
export class TomlIntegration extends IntegrationBase {
  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    return defaultExecArgs(this, prompt, opts, '-m');
  }

  commandFilename(templateName: string): string {
    return `speckit.${templateName}.toml`;
  }

  /** Extract the ``description`` value from YAML frontmatter. */
  static extractDescription(content: string): string {
    const [fmText] = splitFrontmatter(content);
    if (!fmText) return '';
    const res = safeLoad(fmText);
    if (!res.ok) return '';
    const fm = res.value ?? {};
    if (!isPlainObject(fm)) return '';
    const description = 'description' in fm ? fm.description : '';
    return typeof description === 'string' ? description : '';
  }

  static splitFrontmatter(content: string): [string, string] {
    return splitFrontmatter(content);
  }

  static hasIllegalTomlControl(value: string): boolean {
    return hasIllegalTomlControl(value);
  }

  static escapeTomlBasic(value: string): string {
    return escapeTomlBasic(value);
  }

  /** Render *value* as a TOML string literal. */
  static renderTomlString(value: string): string {
    if (hasIllegalTomlControl(value)) return escapeTomlBasic(value);
    if (!value.includes('\n') && !value.includes('\r')) {
      const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `"${escaped}"`;
    }
    const escaped = value.replace(/\\/g, '\\\\');
    if (!escaped.includes('"""')) {
      if (escaped.endsWith('"')) return '"""\n' + escaped + '\\\n"""';
      return '"""\n' + escaped + '"""';
    }
    if (!value.includes("'''") && !value.endsWith("'")) {
      return "'''\n" + value + "'''";
    }
    return escapeTomlBasic(value);
  }

  /** Render a TOML command file from description and body. */
  static renderToml(description: string, body: string): string {
    const lines: string[] = [];
    if (description) {
      lines.push(`description = ${TomlIntegration.renderTomlString(description)}`);
      lines.push('');
    }
    body = body.replace(/\n+$/, '');
    lines.push(`prompt = ${TomlIntegration.renderTomlString(body)}`);
    return lines.join('\n') + '\n';
  }

  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    const templates = this.listCommandTemplates();
    if (templates.length === 0) return [];
    const dest = this.checkedDest(projectRoot, manifest, this.commandsDest(projectRoot));
    mkdirSync(dest, { recursive: true });
    const scriptType = scriptTypeOf(opts);
    const argPlaceholder = argPlaceholderOf(this, '{{args}}');
    const created: string[] = [];
    for (const src of templates) {
      const raw = readFileSync(src, 'utf-8');
      const description = TomlIntegration.extractDescription(raw);
      const processed = this.processTemplate(raw, this.key, scriptType, argPlaceholder, undefined, projectRoot);
      const [, body] = splitFrontmatter(processed);
      const toml = TomlIntegration.renderToml(description, body);
      created.push(this.writeFileAndRecord(toml, join(dest, this.commandFilename(parsePath(src).name)), projectRoot, manifest));
    }
    created.push(...this.emitEvents(projectRoot, manifest, opts.events, parsedOptions));
    return created;
  }
}

// ============================================================================
// YamlIntegration
// ============================================================================

/**
 * Characters a YAML literal block scalar cannot carry (C0 controls other than
 * tab/LF, DEL, C1, LS/PS, lone surrogates, U+FFFE/U+FFFF).
 */
const YAML_BLOCK_SCALAR_UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\ud800-\udfff\ufffe\uffff]/u;

/** Concrete base for integrations that use YAML recipe format. */
export class YamlIntegration extends IntegrationBase {
  commandFilename(templateName: string): string {
    return `speckit.${templateName}.yaml`;
  }

  /** Extract frontmatter as a dict. */
  static extractFrontmatter(content: string): Record<string, unknown> {
    const [fmText, ] = splitFrontmatter(content);
    if (!content.startsWith('---')) return {};
    // splitFrontmatter returns '' both for "no frontmatter" and "empty
    // frontmatter"; both yield {} here.
    const res = safeLoad(fmText);
    if (!res.ok) return {};
    const fm = res.value ?? {};
    return isPlainObject(fm) ? fm : {};
  }

  static splitFrontmatter(content: string): [string, string] {
    return splitFrontmatter(content);
  }

  /** Convert an identifier to a human-readable title. */
  static humanTitle(identifier: string): string {
    let text = identifier;
    if (text.startsWith('speckit.')) text = text.slice('speckit.'.length);
    return pyTitle(text.replace(/[.\-_]/g, ' '));
  }

  /** Build the base YAML header. */
  static buildYamlHeader(title: string, description: string): Record<string, unknown> {
    return {
      version: '1.0.0',
      title,
      description,
      author: { contact: 'spec-kit' },
      parameters: [
        {
          key: 'args',
          input_type: 'string',
          requirement: 'optional',
          default: '',
          description: 'User input passed to the command.',
        },
      ],
      extensions: [{ type: 'builtin', name: 'developer' }],
      activities: ['Spec-Driven Development'],
    };
  }

  /** Render a Goose-compatible YAML recipe. */
  static renderYaml(title: string, description: string, body: string, sourceId: string): string {
    const header = YamlIntegration.buildYamlHeader(title, description);
    const headerYaml = pyStrip(
      dumpYaml(header, { sortKeys: false, allowUnicode: true, defaultFlowStyle: false }),
    );
    if (YAML_BLOCK_SCALAR_UNSAFE.test(body)) {
      const promptYaml = `"prompt": ${yamlQuote(body)}`;
      return [headerYaml, promptYaml, '', `# Source: ${sourceId}`].join('\n') + '\n';
    }
    const indented = body.split('\n').map((line) => `  ${line}`).join('\n');
    return [headerYaml, 'prompt: |2', indented, '', `# Source: ${sourceId}`].join('\n') + '\n';
  }

  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    const templates = this.listCommandTemplates();
    if (templates.length === 0) return [];
    const dest = this.checkedDest(projectRoot, manifest, this.commandsDest(projectRoot));
    mkdirSync(dest, { recursive: true });
    const scriptType = scriptTypeOf(opts);
    const argPlaceholder = argPlaceholderOf(this, '{{args}}');
    const created: string[] = [];
    for (const src of templates) {
      const raw = readFileSync(src, 'utf-8');
      const fm = YamlIntegration.extractFrontmatter(raw);
      let description: unknown = 'description' in fm ? fm.description : '';
      if (typeof description !== 'string') description = description !== null && description !== undefined ? pyStr(description) : '';
      let title: unknown = pyTruthy(fm.title) ? fm.title : pyTruthy(fm.name) ? fm.name : (fm.name ?? '');
      if (typeof title !== 'string') title = title !== null && title !== undefined ? pyStr(title) : '';
      const stemName = parsePath(src).name;
      if (!pyTruthy(title)) title = YamlIntegration.humanTitle(stemName);
      const processed = this.processTemplate(raw, this.key, scriptType, argPlaceholder, undefined, projectRoot);
      const [, body] = splitFrontmatter(processed);
      const content = YamlIntegration.renderYaml(
        title as string,
        description as string,
        body,
        `templates/commands/${parsePath(src).base}`,
      );
      created.push(this.writeFileAndRecord(content, join(dest, this.commandFilename(stemName)), projectRoot, manifest));
    }
    created.push(...this.emitEvents(projectRoot, manifest, opts.events, parsedOptions));
    return created;
  }
}

// ============================================================================
// SkillsIntegration
// ============================================================================

/** Concrete base for integrations that install commands as agent skills. */
export class SkillsIntegration extends IntegrationBase {
  invokeSeparator = '-';

  /** Skills-native integrations scaffold skills unconditionally. */
  isSkillsMode(_parsedOptions?: ParsedOptions | null, _projectRoot?: string | null): boolean {
    return true;
  }

  buildExecArgs(prompt: string, opts: ExecArgsOptions = {}): string[] | null {
    return defaultExecArgs(this, prompt, opts, '--model');
  }

  /** Absolute path to the skills output directory. */
  skillsDest(projectRoot: string): string {
    if (!this.config) throw new ValueError(`${this.constructor.name}.config is not set.`);
    const folder = this.config.folder;
    if (!folder) {
      throw new ValueError(`${this.constructor.name}.config is missing required 'folder' entry.`);
    }
    const subdir = this.config.commands_subdir ?? 'skills';
    return join(projectRoot, folder, subdir);
  }

  buildCommandInvocation(commandName: string, args = ''): string {
    let stem = commandName;
    if (stem.startsWith('speckit.')) stem = stem.slice('speckit.'.length);
    const prefix = isDollarSkillsAgent(this.key, true) ? '$' : '/';
    let invocation = prefix + 'speckit-' + replaceAllLiteral(stem, '.', '-');
    if (args) invocation = `${invocation} ${args}`;
    return invocation;
  }

  /** Insert the dot-to-hyphen note before each hook output instruction. */
  static injectHookCommandNote(content: string, invocationPrefix = '/'): string {
    let note = HOOK_COMMAND_NOTE.replace(/\n+$/, '');
    if (invocationPrefix !== '/') {
      note = replaceAllLiteral(note, '`/speckit-git-commit`', `\`${invocationPrefix}speckit-git-commit\``);
    }
    return injectNoteBeforeHookInstructions(content, note, true);
  }

  /** Post-process a SKILL.md after generation (default: inject hook note). */
  postProcessSkillContent(content: string): string {
    const prefix = getInvocationPrefix(this.key, true);
    return SkillsIntegration.injectHookCommandNote(content, prefix);
  }

  /** Build the standard SKILL.md content for one template. */
  protected buildSkillFile(src: string, scriptType: string, argPlaceholder: string, projectRoot: string): [string, string] {
    const raw = readFileSync(src, 'utf-8');
    const commandName = parsePath(src).name;
    const skillName = `speckit-${replaceAllLiteral(commandName, '.', '-')}`;
    const frontmatter = parseTemplateFrontmatter(raw);
    let processedBody = this.processTemplate(raw, this.key, scriptType, argPlaceholder, this.invokeSeparator, projectRoot);
    processedBody = stripTemplateFrontmatter(processedBody);
    let description: unknown = 'description' in frontmatter ? frontmatter.description : '';
    if (!pyTruthy(description)) description = `Spec Kit: ${commandName} workflow`;
    const content = renderSkillFrontmatterBlock(skillName, description, parsePath(src).base) + processedBody;
    return [skillName, content];
  }

  setup(projectRoot: string, manifest: IntegrationManifest, parsedOptions?: ParsedOptions | null, opts: SetupOptions = {}): string[] {
    const templates = this.listCommandTemplates();
    if (templates.length === 0) return [];
    const skillsDir = this.checkedDest(projectRoot, manifest, this.skillsDest(projectRoot), 'Skills destination');
    const scriptType = scriptTypeOf(opts);
    const argPlaceholder = argPlaceholderOf(this, '$ARGUMENTS');
    const created: string[] = [];
    for (const src of templates) {
      const [skillName, rawContent] = this.buildSkillFile(src, scriptType, argPlaceholder, projectRoot);
      const skillContent = this.postProcessSkillContent(rawContent);
      created.push(this.writeFileAndRecord(skillContent, join(skillsDir, skillName, 'SKILL.md'), projectRoot, manifest));
    }
    created.push(...this.emitEvents(projectRoot, manifest, opts.events, parsedOptions));
    return created;
  }
}

/**
 * Render the manually formatted SKILL.md frontmatter block (stable
 * double-quoted values) used by the skills setup paths.
 */
export function renderSkillFrontmatterBlock(skillName: string, description: unknown, templateFileName: string): string {
  return (
    '---\n' +
    `name: ${yamlQuote(skillName)}\n` +
    `description: ${yamlQuote(pyStr(description))}\n` +
    `compatibility: ${yamlQuote('Requires spec-kit project structure with .specify/ directory')}\n` +
    'metadata:\n' +
    `  author: ${yamlQuote('github-spec-kit')}\n` +
    `  source: ${yamlQuote('templates/commands/' + templateFileName)}\n` +
    '---\n'
  );
}

/**
 * Shared implementation of the ``_inject_hook_command_note`` regex
 * substitution. With *checkPrevious*, instructions whose preceding line is
 * already the note are left untouched.
 */
export function injectNoteBeforeHookInstructions(content: string, note: string, checkPrevious: boolean, indentPattern = '[ \\t]*'): string {
  const re = new RegExp(
    `^(${indentPattern})(- For each executable hook, output the following[^\\r\\n]*)(\\r\\n|\\n|$)`,
    'gm',
  );
  return content.replace(re, (whole: string, indent: string, instruction: string, eolRaw: string, offset: number) => {
    if (checkPrevious) {
      const previous = splitlines(content.slice(0, offset));
      if (previous.length > 0 && previous[previous.length - 1] === indent + note) return whole;
    }
    const eol = eolRaw || '\n';
    return indent + note + eol + indent + instruction + eol;
  });
}

/**
 * Insert ``key: value`` before the closing ``---`` of the frontmatter unless
 * already present (the Claude/Vibe/Alquimia variant: preserves CRLF, defaults
 * to ``\n``).
 */
export function injectFrontmatterFlag(content: string, key: string, value = 'true'): string {
  const lines = splitlines(content, true);
  let dashCount = 0;
  for (const line of lines) {
    const stripped = line.replace(/[\n\r]+$/, '');
    if (stripped === '---') {
      dashCount += 1;
      if (dashCount === 2) break;
      continue;
    }
    if (dashCount === 1 && stripped.startsWith(`${key}:`)) return content;
  }
  const out: string[] = [];
  dashCount = 0;
  let injected = false;
  for (const line of lines) {
    const stripped = line.replace(/[\n\r]+$/, '');
    if (stripped === '---') {
      dashCount += 1;
      if (dashCount === 2 && !injected) {
        const eol = line.endsWith('\r\n') ? '\r\n' : '\n';
        out.push(`${key}: ${value}${eol}`);
        injected = true;
      }
    }
    out.push(line);
  }
  return out.join('');
}

/**
 * Insert ``argument-hint`` after the (possibly folded) ``description:``
 * scalar in YAML frontmatter; no-op when already present.
 */
export function injectArgumentHint(content: string, hint: string): string {
  const lines = splitlines(content, true);
  let dashCount = 0;
  for (const line of lines) {
    const stripped = line.replace(/[\n\r]+$/, '');
    if (stripped === '---') {
      dashCount += 1;
      if (dashCount === 2) break;
      continue;
    }
    if (dashCount === 1 && stripped.startsWith('argument-hint:')) return content;
  }
  const out: string[] = [];
  let inFm = false;
  dashCount = 0;
  let injected = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const stripped = line.replace(/[\n\r]+$/, '');
    if (stripped === '---') {
      dashCount += 1;
      inFm = dashCount === 1;
      out.push(line);
      i++;
      continue;
    }
    if (inFm && !injected && stripped.startsWith('description:')) {
      out.push(line);
      i++;
      while (i < n && (lines[i].slice(0, 1) === ' ' || lines[i].slice(0, 1) === '\t' || lines[i].replace(/[\r\n]+$/, '') === '')) {
        out.push(lines[i]);
        i++;
      }
      const eol = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
      const escaped = hint.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      out.push(`argument-hint: "${escaped}"${eol}`);
      injected = true;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('');
}

/**
 * Derive the command stem (e.g. ``analyze``) from a skill's frontmatter
 * ``name:`` field (``speckit-`` prefix stripped).
 */
export function skillStemFromContent(content: string): string | null {
  let dashCount = 0;
  for (const line of splitlines(content)) {
    const stripped = line.replace(/[\r\n]+$/, '');
    if (stripped === '---') {
      dashCount += 1;
      if (dashCount === 2) break;
      continue;
    }
    if (dashCount === 1 && stripped.startsWith('name:')) {
      const name = pyStrip(stripped.slice('name:'.length)).replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
      if (name.startsWith('speckit-')) return name.slice('speckit-'.length);
      return name || null;
    }
  }
  return null;
}
