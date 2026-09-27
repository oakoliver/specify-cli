/**
 * @oakoliver/specify-cli - Agent runtime events
 *
 * Port of spec-kit v1.0.12 ``specify_cli/events/__init__.py``:
 *
 * - ``resolveEvents`` — layered event resolution (CLI flag → YAML override →
 *   extension-declared → built-in).
 * - ``collectExtensionEvents`` — scan installed extension.yml files for ``events:``.
 * - ``installIntegrationEvents`` / ``removeIntegrationEvents`` — entry points
 *   called from ``IntegrationBase.setup()`` / ``teardown()``.
 * - ``resolveAndRunEventCommand`` — core of ``specify event run`` and of the
 *   generated ``.specify/events.py`` dispatcher's preferred path.
 *
 * The CLI adapter (``specify event run``) lives in ``./commands.ts``.
 *
 * @module events
 */

import { spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from 'node:path';

import { parseYaml } from '../yaml.js';
import { escapeTomlBasic } from '../toml-string.js';
import { loadInitOptions } from '../init-options.js';
import { locateCorePack } from '../assets.js';
import { installedIntegrationKeys } from '../integration-state.js';
import { CommandRegistrar } from '../agents.js';
import { IntegrationBase } from '../integrations/base.js';
import { IntegrationManifest, ValueError } from '../integrations/manifest.js';
import { getIntegration } from '../integrations/index.js';
import { readIntegrationJson, resolveIntegrationOptions } from '../integrations/helpers.js';
import { ValidationError } from '../extensions/errors.js';
import { ExtensionManager } from '../extensions/manager.js';
import { ExtensionRegistry } from '../extensions/registry.js';

import {
  compareCodePoints,
  isPlainObject,
  isPyInt,
  pyJsonDumps,
  pyRepr,
  pyTypeName,
  shlexQuote,
  shlexSplit,
} from './py-compat.js';
import { EVENTS_DISPATCHER_TEMPLATE, TS_PLUGIN_PLACEHOLDERS, TS_PLUGIN_TEMPLATE } from './templates.js';

export { EVENTS_DISPATCHER_TEMPLATE, TS_PLUGIN_TEMPLATE } from './templates.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Generated hook dispatchers refuse to delegate unless this name is True.
 * An older installed events module would otherwise run unconfined script tokens.
 */
export const EVENT_SCRIPT_PATH_CONFINEMENT = true;

export const EVENTS_DISPATCHER_DIR = '.specify';
export const EVENTS_DISPATCHER_FILENAME = 'events.py';
/** POSIX-form (forward-slash) relative path so it matches manifest keys. */
export const EVENTS_DISPATCHER_REL = `${EVENTS_DISPATCHER_DIR}/${EVENTS_DISPATCHER_FILENAME}`;

export const YAML_OVERRIDE_FILENAME = '.specify/integration-events.yml';

export const SPECKIT_MARKER = '__speckit_event__';

/**
 * Buffer (seconds) added to the native hook timeout so the agent's outer cap
 * fires after the dispatcher's inner subprocess timeout.
 */
export const EVENT_TIMEOUT_BUFFER = 5;

/** Canonical event names (snake_case). */
export const CANONICAL_EVENTS: ReadonlySet<string> = new Set([
  'session_start',
  'pre_tool_use',
  'post_tool_use',
  'session_end',
  'user_prompt_submit',
  'stop',
]);

const OPENCODE_PLUGIN_REL = '.opencode/plugin/speckit-events.ts';

// ============================================================================
// Types
// ============================================================================

/** A single event handler config (``{command, matcher?, timeout?}``). */
export type EventHandler = Record<string, unknown>;

/** Canonical event name → ordered list of handler configs. */
export type ResolvedEvents = Record<string, EventHandler[]>;

/**
 * Structural view of an integration as used by the events subsystem. The
 * event attributes (``CANONICAL_TO_NATIVE``, ``events_format`` …) are read
 * dynamically, mirroring upstream ``getattr(integration, ...)``.
 */
export interface EventIntegration {
  readonly key: string;
}

/** Structural view of ``IntegrationManifest`` used by the events subsystem. */
export interface EventManifest {
  readonly files: unknown;
  recordFile(relPath: string, content: Uint8Array | string): unknown;
  recordExisting(relPath: string): unknown;
  remove(relPath: string): unknown;
}

// ============================================================================
// Small helpers
// ============================================================================

/** Emit a ``logger.warning`` line (Python's last-resort handler → stderr). */
function logWarning(message: string): void {
  process.stderr.write(message + '\n');
}

function camelCase(name: string): string {
  return name.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** ``getattr(obj, name, default)`` accepting snake_case or camelCase members. */
function getAttr<T>(obj: unknown, name: string, fallback: T): T {
  if (obj === null || obj === undefined) return fallback;
  const record = obj as Record<string, unknown>;
  const camel = camelCase(name);
  // TS integrations declare unset event attributes as ``null`` where the
  // Python classes simply lack the attribute, so treat null as "absent".
  if (camel !== name && record[camel] !== undefined && record[camel] !== null) return record[camel] as T;
  if (record[name] !== undefined && record[name] !== null) return record[name] as T;
  return fallback;
}

function canonicalToNative(integration: EventIntegration): Record<string, string> {
  const mapping = getAttr<unknown>(integration, 'CANONICAL_TO_NATIVE', {});
  return isPlainObject(mapping) ? (mapping as Record<string, string>) : {};
}

function manifestFiles(manifest: EventManifest): Record<string, unknown> {
  const files = manifest.files;
  if (files instanceof Map) return Object.fromEntries(files as Map<string, unknown>);
  if (isPlainObject(files)) return files;
  return {};
}

function manifestHas(manifest: EventManifest, rel: string): boolean {
  return Object.prototype.hasOwnProperty.call(manifestFiles(manifest), rel);
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function sortedEntries(dir: string): string[] {
  try {
    return readdirSync(dir).sort(compareCodePoints);
  } catch {
    return [];
  }
}

/** Python ``str.splitlines()`` (without keepends). */
function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Port of ``shutil.which``. */
export function which(cmd: string): string | null {
  const pathEnv = process.env.PATH ?? '';
  const exts = isWindows()
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const candidates = (cmd.includes('/') || (isWindows() && cmd.includes('\\'))) ? [''] : pathEnv.split(delimiter);
  for (const dir of candidates) {
    if (dir === undefined) continue;
    for (const ext of exts) {
      const full = dir ? join(dir, cmd + ext) : cmd + ext;
      try {
        if (!statSync(full).isFile()) continue;
        accessSync(full, fsConstants.X_OK);
        return full;
      } catch {
        // continue
      }
    }
  }
  return null;
}

/**
 * Patch points mirroring upstream monkeypatching of ``shutil.which`` in the
 * events module's tests.
 */
export const eventRuntimeHooks: { which: (cmd: string) => string | null } = {
  which: (cmd) => which(cmd),
};

/** Python ``int(value)`` for YAML/JSON-shaped data; throws on failure. */
function pyInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`cannot convert float ${value} to integer`);
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^[+-]?\d+(?:_\d+)*$/.test(s)) return parseInt(s.replace(/_/g, ''), 10);
    throw new TypeError(`invalid literal for int() with base 10: ${pyRepr(value)}`);
  }
  throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(value)}'`);
}

/** Python ``timeout + EVENT_TIMEOUT_BUFFER`` (raising like Python on a bad type). */
function addTimeoutBuffer(timeout: unknown): number {
  if (typeof timeout === 'boolean') return (timeout ? 1 : 0) + EVENT_TIMEOUT_BUFFER;
  if (typeof timeout === 'number') return timeout + EVENT_TIMEOUT_BUFFER;
  if (typeof timeout === 'string') throw new TypeError('can only concatenate str (not "int") to str');
  throw new TypeError(`unsupported operand type(s) for +: '${pyTypeName(timeout)}' and 'int'`);
}

function handlerGet(cfg: EventHandler, key: string, fallback: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(cfg, key) ? cfg[key] : fallback;
}

// ============================================================================
// Command runner logic (core)
// ============================================================================

/**
 * Locate an event command's ``.md`` template. Returns ``[path, extId]``.
 */
export function findCommandTemplate(commandName: string, projectRoot: string): [string | null, string | null] {
  // 1. Resolve via installed extension manifests (authoritative, S8).
  const extsDir = join(projectRoot, '.specify', 'extensions');
  // S1: skip explicitly-disabled extensions.
  const disabledIds = disabledExtensionIds(projectRoot);
  try {
    const manager = new ExtensionManager(projectRoot);
    const ids = [...(manager.registry.keys() as Iterable<string>)].sort(compareCodePoints);
    for (const extId of ids) {
      if (disabledIds.has(extId)) continue;
      const manifest = manager.getExtension(extId);
      if (manifest === null || manifest === undefined) continue;
      for (const cmd of manifest.commands as unknown[]) {
        if (!isPlainObject(cmd)) continue;
        if (cmd.name === commandName && cmd.file) {
          const candidate = join(extsDir, extId, String(cmd.file));
          if (pathExists(candidate)) return [candidate, extId];
        }
      }
    }
  } catch {
    // Fall through to the on-disk scan; event dispatch degrades gracefully.
  }

  // 2. Scan extension directories by file stem.
  if (isDir(extsDir)) {
    for (const name of sortedEntries(extsDir)) {
      if (disabledIds.has(name)) continue;
      const cmdsDir = join(extsDir, name, 'commands');
      if (!isDir(cmdsDir)) continue;
      for (const f of sortedEntries(cmdsDir)) {
        if (!f.endsWith('.md') || f === '.md') continue;
        if (f.slice(0, -3) === commandName) return [join(cmdsDir, f), name];
      }
    }
  }

  const stem = commandName.replace(/speckit\./g, '').replace(/spec\./g, '');

  // 3. Core templates in the project.
  const core = join(projectRoot, '.specify', 'templates', 'commands');
  if (isDir(core)) {
    const candidate = join(core, `${stem}.md`);
    if (pathExists(candidate)) return [candidate, null];
  }

  // 4. Package-bundled templates (core_pack/commands).
  const corePack = locateCorePack();
  if (corePack) {
    const candidateDir = join(corePack, 'commands');
    if (isDir(candidateDir)) {
      const candidate = join(candidateDir, `${stem}.md`);
      if (pathExists(candidate)) return [candidate, null];
    }
  }

  return [null, null];
}

function hasAnchor(token: string): boolean {
  // PurePosixPath(token).anchor or PureWindowsPath(token).anchor
  if (token.startsWith('/')) return true;
  if (/^[A-Za-z]:/.test(token)) return true;
  if (token.startsWith('\\')) return true;
  return false;
}

function isRelativeTo(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/** Python ``Path.resolve()`` (non-strict): resolve symlinks of the existing prefix. */
function resolvePath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // Resolve the deepest existing ancestor, then append the rest.
    const parts: string[] = [];
    let current = abs;
    for (;;) {
      const parent = dirname(current);
      parts.unshift(current.slice(parent.length).replace(/^[\\/]/, ''));
      current = parent;
      try {
        const real = realpathSync(current);
        return join(real, ...parts);
      } catch {
        if (parent === dirname(parent)) return abs;
      }
    }
  }
}

/**
 * Resolve *token* under *base*, or ``null`` if it leaves the project.
 *
 * Rejects anchored tokens (absolute, drive, UNC). ``..`` is allowed when the
 * resolved path stays inside *projectRoot*.
 */
export function confineEventScriptPath(projectRoot: string, base: string, token: string): string | null {
  if (hasAnchor(token)) return null;
  try {
    const root = resolvePath(projectRoot);
    const candidate = resolvePath(join(base, token));
    if (!isRelativeTo(candidate, root)) return null;
    return candidate;
  } catch {
    return null;
  }
}

function matchFrontmatter(content: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(content);
  return m ? m[1]! : null;
}

/**
 * Resolve a command template's ``scripts:`` entry to a runnable argv.
 */
export function resolveEventCommandArgv(
  templatePath: string,
  projectRoot: string,
  extId: string | null,
): string[] | null {
  let content: string;
  try {
    const raw = readFileSync(templatePath);
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return null;
  }
  const fm = matchFrontmatter(content);
  if (fm === null) return null;
  let fmData: unknown;
  try {
    fmData = parseYaml(fm) || {};
  } catch {
    return null;
  }
  if (!isPlainObject(fmData)) return null;
  const scripts = Object.prototype.hasOwnProperty.call(fmData, 'scripts') ? fmData.scripts : {};
  if (!isPlainObject(scripts)) return null;
  const requested = loadProjectScriptType(projectRoot);
  let variant: string;
  try {
    variant = IntegrationBase.selectScriptVariant(requested, scripts as Record<string, string>);
  } catch {
    return null;
  }
  const scriptCmd = scripts[variant];
  if (typeof scriptCmd !== 'string' || !scriptCmd.trim()) return null;

  const base = extId
    ? join(projectRoot, '.specify', 'extensions', extId)
    : join(projectRoot, '.specify');

  let tokens: string[];
  try {
    tokens = shlexSplit(scriptCmd, !isWindows());
  } catch {
    return null;
  }
  if (!tokens.length) return null;
  const scriptAbs = confineEventScriptPath(projectRoot, base, tokens[0]!);
  if (scriptAbs === null || !pathExists(scriptAbs)) return null;
  const restArgs = tokens.slice(1);

  if (variant === 'py') {
    const interpreter = IntegrationBase.resolvePythonInterpreter(projectRoot);
    return [interpreter, scriptAbs, ...restArgs];
  }

  if (variant === 'ps') {
    // No fake "pwsh" fallback: degrade to "no argv" when neither launcher exists.
    const launcher = eventRuntimeHooks.which('pwsh') || eventRuntimeHooks.which('powershell');
    if (!launcher) return null;
    return [launcher, '-File', scriptAbs, ...restArgs];
  }

  if (isWindows()) {
    const launcher = eventRuntimeHooks.which('bash') || eventRuntimeHooks.which('sh');
    if (launcher) return [launcher, scriptAbs, ...restArgs];
  }
  return [scriptAbs, ...restArgs];
}

/** Return the project's persisted script type ('sh'|'ps'|'py'). */
export function loadProjectScriptType(projectRoot: string): string {
  const fallback = isWindows() ? 'ps' : 'sh';
  try {
    const opts = loadInitOptions(projectRoot) as unknown;
    if (isPlainObject(opts)) {
      const script = opts.script;
      if (typeof script === 'string' && ['sh', 'ps', 'py'].includes(script)) return script;
    }
  } catch {
    // fall through
  }
  return fallback;
}

export interface RunEventCommandOptions {
  timeout?: number;
  envelope?: string;
  nativeEvent?: string;
}

function errnoMessage(err: NodeJS.ErrnoException, argv0: string): string {
  switch (err.code) {
    case 'ENOENT':
      return `[Errno 2] No such file or directory: ${pyRepr(argv0)}`;
    case 'EACCES':
      return `[Errno 13] Permission denied: ${pyRepr(argv0)}`;
    case 'ENOEXEC':
      return `[Errno 8] Exec format error: ${pyRepr(argv0)}`;
    default:
      return err.message;
  }
}

/**
 * Core entry point to resolve and execute an event-driven command.
 *
 * *timeout* is the per-handler timeout in seconds; *envelope* selects how the
 * handler's stdout is emitted for the agent's context-injection protocol;
 * *nativeEvent* is the agent's native hookEventName for ``hookSpecificOutput``.
 */
export function resolveAndRunEventCommand(
  commandName: string,
  eventName: string,
  payload: string,
  projectRoot: string,
  opts: RunEventCommandOptions = {},
): number {
  void eventName;
  const timeout = opts.timeout ?? 120;
  const envelope = opts.envelope ?? 'plain';
  const nativeEvent = opts.nativeEvent ?? '';
  const [templatePath, extId] = findCommandTemplate(commandName, projectRoot);
  if (!templatePath) {
    logWarning(`Event command '${commandName}' not found`);
    return 0;
  }
  const argv = resolveEventCommandArgv(templatePath, projectRoot, extId);
  if (!argv || !argv.length) {
    logWarning(`No script found for event command '${commandName}'`);
    return 0;
  }
  try {
    const result = spawnSync(argv[0]!, argv.slice(1), {
      input: Buffer.from(payload, 'utf8'),
      cwd: projectRoot,
      timeout: timeout * 1000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024 * 1024,
      encoding: 'buffer',
    });
    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      if (err.code === 'ETIMEDOUT') {
        process.stderr.write(`Event command ${commandName} timed out\n`);
        return 2;
      }
      process.stderr.write(`Event command ${commandName} error: ${errnoMessage(err, argv[0]!)}\n`);
      return 2;
    }
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const stdout = result.stdout && result.stdout.length ? decoder.decode(result.stdout) : '';
    const stderr = result.stderr && result.stderr.length ? decoder.decode(result.stderr) : '';
    if (stdout) emitEventStdout(stdout, envelope, nativeEvent);
    const code = result.status ?? (result.signal ? -(signalNumber(result.signal)) : 1);
    if (code !== 0) {
      if (stderr) process.stderr.write(stderr);
      return code;
    }
    return 0;
  } catch (e) {
    process.stderr.write(`Event command ${commandName} error: ${(e as Error).message}\n`);
    return 2;
  }
}

function signalNumber(signal: NodeJS.Signals): number {
  const table: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGSEGV: 11, SIGPIPE: 13, SIGTERM: 15 };
  return table[signal] ?? 1;
}

/**
 * Write handler stdout in the agent's context-injection shape (C13).
 * Mirrors the ``_emit`` helper inside the generated dispatcher template.
 */
export function emitEventStdout(output: string, envelope: string, nativeEvent = ''): void {
  if (!output) return;
  if (envelope === 'suppress') return;
  if (envelope === 'hookSpecificOutput') {
    const payload: Record<string, string> = { additionalContext: output };
    if (nativeEvent) payload.hookEventName = nativeEvent;
    process.stdout.write(pyJsonDumps({ hookSpecificOutput: payload }) + '\n');
    return;
  }
  if (envelope === 'additionalContext') {
    process.stdout.write(pyJsonDumps({ additionalContext: output }) + '\n');
    return;
  }
  if (envelope === 'additional_context') {
    process.stdout.write(pyJsonDumps({ additional_context: output }) + '\n');
    return;
  }
  if (envelope === 'hook_specific_output') {
    process.stdout.write(
      pyJsonDumps({ decision: 'allow', hook_specific_output: { additional_context: output } }) + '\n',
    );
    return;
  }
  process.stdout.write(output);
}

// ============================================================================
// Sourcing events map
// ============================================================================

/** Coerce a single handler config or a list of them into a validated list. */
export function normalizeHandlers(value: unknown): EventHandler[] {
  let list: unknown = value;
  if (isPlainObject(list)) list = [list];
  if (!Array.isArray(list)) return [];
  const handlers: EventHandler[] = [];
  for (const entry of list) {
    if (!isPlainObject(entry)) {
      logWarning(`Skipping malformed event handler (expected a mapping): ${pyRepr(entry)}`);
      continue;
    }
    handlers.push(entry);
  }
  return handlers;
}

function sortedCanonicalEventsRepr(): string {
  return pyRepr([...CANONICAL_EVENTS].sort(compareCodePoints));
}

/** Validate a resolved event's handlers, raising a user-facing error. */
export function validateResolvedEvent(eventName: string, handlers: EventHandler[]): void {
  if (!CANONICAL_EVENTS.has(eventName)) {
    throw new ValidationError(`Unknown event '${eventName}': must be one of ${sortedCanonicalEventsRepr()}`);
  }
  for (const handler of handlers) {
    const command = handler.command;
    if (typeof command !== 'string' || !command.trim()) {
      throw new ValidationError(`Event '${eventName}' handler missing required non-empty 'command' string`);
    }
    const matcher = handler.matcher;
    if (matcher !== null && matcher !== undefined && typeof matcher !== 'string') {
      throw new ValidationError(`Event '${eventName}' handler has invalid 'matcher': must be a string`);
    }
    const timeout = handler.timeout;
    if (timeout !== null && timeout !== undefined) {
      if (!isPyInt(timeout) || timeout <= 0) {
        throw new ValidationError(`Event '${eventName}' handler has invalid 'timeout': must be a positive integer`);
      }
    }
  }
}

function appendHandlers(events: ResolvedEvents, ev: string, handlers: EventHandler[]): void {
  if (!Object.prototype.hasOwnProperty.call(events, ev)) events[ev] = [];
  events[ev]!.push(...handlers);
}

/**
 * Resolve the final event set for an integration.
 *
 * Layers (lowest → highest precedence): CLI gate, built-in defaults,
 * extension-declared events (accumulated), user YAML override.
 */
export function resolveEvents(
  integrationKey: string,
  integrationConfig: Record<string, unknown> | null | undefined,
  projectRoot: string,
  parsedOptions: Record<string, unknown> | null | undefined,
): ResolvedEvents {
  // Layer 1: CLI flag gate
  if (parsedOptions && Object.keys(parsedOptions).length) {
    const raw = Object.prototype.hasOwnProperty.call(parsedOptions, 'events') ? parsedOptions.events : 'true';
    const flag = pyStr(raw).toLowerCase();
    if (['false', '0', 'no', 'off'].includes(flag)) return {};
  }

  let events: ResolvedEvents = {};

  // Layer 2: built-in defaults
  if (integrationConfig && isPlainObject(integrationConfig.events)) {
    for (const [ev, cfg] of Object.entries(integrationConfig.events)) {
      const handlers = normalizeHandlers(cfg);
      if (handlers.length) appendHandlers(events, ev, handlers);
    }
  }

  // Layer 3: extension-declared events
  for (const [ev, handlers] of Object.entries(collectExtensionEvents(projectRoot))) {
    appendHandlers(events, ev, handlers);
  }

  // Layer 4: user YAML override
  const overrideFile = join(projectRoot, YAML_OVERRIDE_FILENAME);
  if (pathExists(overrideFile)) {
    let override: unknown;
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(overrideFile));
      override = parseYaml(text) || {};
    } catch {
      logWarning(`Could not read or parse ${overrideFile}; ignoring override`);
      override = {};
    }
    const integrations = isPlainObject(override)
      ? (Object.prototype.hasOwnProperty.call(override, 'integrations') ? override.integrations : {})
      : {};
    if (isPlainObject(integrations) && Object.prototype.hasOwnProperty.call(integrations, integrationKey)) {
      const keyData = integrations[integrationKey];
      if (!isPlainObject(keyData)) {
        logWarning(`Override ${overrideFile}: entry for '${integrationKey}' is not a mapping; ignoring override`);
      } else {
        const keyEvents = Object.prototype.hasOwnProperty.call(keyData, 'events') ? keyData.events : {};
        if (!isPlainObject(keyEvents)) {
          logWarning(`Override ${overrideFile}: 'events' for '${integrationKey}' is not a mapping; ignoring override`);
        } else {
          const resolvedOverride: ResolvedEvents = {};
          let overrideValid = true;
          for (const [ev, raw] of Object.entries(keyEvents)) {
            const handlers = normalizeHandlers(raw);
            if (!handlers.length) {
              logWarning(`Override ${overrideFile}: event '${ev}' has no valid handler; ignoring entire override`);
              overrideValid = false;
              break;
            }
            try {
              validateResolvedEvent(ev, handlers);
            } catch (exc) {
              logWarning(
                `Override ${overrideFile}: invalid event '${ev}': ${(exc as Error).message}; ignoring entire override`,
              );
              overrideValid = false;
              break;
            }
            resolvedOverride[ev] = handlers;
          }
          if (overrideValid) events = resolvedOverride;
        }
      }
    }
  }

  return events;
}

/** Python ``str(value)`` for YAML/JSON-shaped data. */
function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  return pyRepr(value);
}

/** Return the set of explicitly-disabled extension IDs. */
export function disabledExtensionIds(projectRoot: string): Set<string> {
  const extsDir = join(projectRoot, '.specify', 'extensions');
  const disabled = new Set<string>();
  if (!isDir(extsDir)) return disabled;
  try {
    const registry = new ExtensionRegistry(extsDir);
    for (const [extId, meta] of registry.listByPriority(true) as Iterable<[string, unknown]>) {
      if (!isPlainObject(meta) || !(Object.prototype.hasOwnProperty.call(meta, 'enabled') ? meta.enabled : true)) {
        disabled.add(extId);
      }
    }
  } catch {
    // ignore
  }
  return disabled;
}

/**
 * Scan all installed extensions for ``events:`` declarations.
 *
 * Honors the registry ``enabled`` flag and reads events from the validated
 * ``ExtensionManifest`` (canonicalized command refs), falling back to the raw
 * YAML for on-disk extensions not yet registered.
 */
export function collectExtensionEvents(projectRoot: string): ResolvedEvents {
  const events: ResolvedEvents = {};
  const extsDir = join(projectRoot, '.specify', 'extensions');
  if (!isDir(extsDir)) return events;

  const manager = new ExtensionManager(projectRoot);
  const disabledIds = disabledExtensionIds(projectRoot);

  let registryIds = new Set<string>();
  try {
    registryIds = new Set([...(manager.registry.keys() as Iterable<string>)]);
  } catch {
    // ignore
  }
  const onDiskIds = new Set<string>();
  for (const name of sortedEntries(extsDir)) {
    const d = join(extsDir, name);
    if (isDir(d) && pathExists(join(d, 'extension.yml'))) onDiskIds.add(name);
  }
  const allIds = [...new Set([...registryIds, ...onDiskIds])].sort(compareCodePoints);
  for (const extId of allIds) {
    if (disabledIds.has(extId)) continue;
    let runtime: unknown = {};
    if (registryIds.has(extId)) {
      let manifest: { data: Record<string, unknown> } | null | undefined = null;
      try {
        manifest = manager.getExtension(extId) as { data: Record<string, unknown> } | null;
      } catch {
        manifest = null;
      }
      if (manifest) runtime = manifest.data?.events || {};
    }
    if (!truthy(runtime)) {
      const extYml = join(extsDir, extId, 'extension.yml');
      if (!pathExists(extYml)) continue;
      let data: unknown;
      try {
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(extYml));
        data = parseYaml(text) || {};
      } catch {
        continue;
      }
      if (!isPlainObject(data)) continue;
      runtime = data.events || {};
    }
    if (!isPlainObject(runtime)) continue;
    for (const [event, config] of Object.entries(runtime)) {
      const handlers = normalizeHandlers(config);
      if (handlers.length) appendHandlers(events, event, handlers);
    }
  }
  return events;
}

/** Python truthiness for YAML/JSON-shaped data. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

// ============================================================================
// Writing / merging native config
// ============================================================================

function resolveInterpreter(projectRoot: string): string {
  return IntegrationBase.resolvePythonInterpreter(projectRoot);
}

/** Resolve a Python interpreter for a target OS, independent of the host (#S4). */
export function resolveInterpreterForTarget(targetOs: string): string {
  if (targetOs === 'windows') return 'python';
  return 'python3';
}

/** Return the timeout in the unit the integration's native config expects. */
export function nativeTimeout(integration: EventIntegration, timeoutSeconds: unknown): number {
  let seconds: number;
  try {
    seconds = pyInt(timeoutSeconds);
  } catch {
    seconds = 60;
  }
  if (getAttr<string>(integration, 'events_timeout_unit', 's') === 'ms') return seconds * 1000;
  return seconds;
}

/** Quote *value* as one argument for the target shell (R2). */
export function shellQuote(value: string, targetOs: string): string {
  if (targetOs === 'windows') return "'" + value.replace(/'/g, "''") + "'";
  if (targetOs === 'cmd') {
    if (/^[A-Za-z0-9_.\-\\/:]+$/.test(value)) return value;
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return shlexQuote(value);
}

function vibeTargetOs(): string {
  return isWindows() ? 'cmd' : 'host';
}

export interface DispatcherCommandOptions {
  targetOs?: string;
  timeoutSeconds?: unknown;
}

/** Build the single shell command string that invokes the dispatcher (#6). */
export function dispatcherCommand(
  integration: EventIntegration,
  projectRoot: string,
  commandName: string,
  eventName: string,
  opts: DispatcherCommandOptions = {},
): string {
  const targetOs = opts.targetOs ?? 'host';
  const interpreter =
    targetOs === 'host' || targetOs === 'cmd' ? resolveInterpreter(projectRoot) : resolveInterpreterForTarget(targetOs);
  const qInterp = shellQuote(interpreter, targetOs);
  const qCommand = shellQuote(commandName, targetOs);
  const qEvent = shellQuote(eventName, targetOs);
  const dispatcher =
    integration.key === 'claude'
      ? '"${CLAUDE_PROJECT_DIR}/' + EVENTS_DISPATCHER_REL + '"'
      : shellQuote(EVENTS_DISPATCHER_REL, targetOs);
  const prefix = targetOs === 'windows' ? '& ' : '';
  let base = `${prefix}${qInterp} ${dispatcher} ${qCommand} ${qEvent}`;
  const resolvedTimeout =
    opts.timeoutSeconds === undefined || opts.timeoutSeconds === null ? 60 : pyInt(opts.timeoutSeconds);
  base += ` ${shellQuote(String(resolvedTimeout), targetOs)}`;
  const envelope = contextEnvelopeFor(integration, eventName);
  if (envelope) {
    base += ` ${shellQuote(envelope, targetOs)}`;
    if (envelope === 'hookSpecificOutput') {
      const nativeEvent = canonicalToNative(integration)[eventName] ?? '';
      if (nativeEvent) base += ` ${shellQuote(nativeEvent, targetOs)}`;
    }
  }
  return base;
}

/** Resolve the context-injection envelope for an integration + event (C13). */
export function contextEnvelopeFor(integration: EventIntegration, canonicalEvent: string): string | null {
  const mapping = getAttr<unknown>(integration, 'events_context_envelope', null);
  if (!isPlainObject(mapping)) return null;
  if (Object.prototype.hasOwnProperty.call(mapping, canonicalEvent)) return mapping[canonicalEvent] as string;
  return (mapping['*'] as string | undefined) ?? null;
}

function relPosix(projectRoot: string, p: string): string {
  return relative(projectRoot, p).split(sep).join('/');
}

function trackConfig(manifest: EventManifest, projectRoot: string, configPath: string, created: string[]): void {
  const rel = relPosix(projectRoot, configPath);
  if (!manifestHas(manifest, rel)) manifest.recordExisting(rel);
  created.push(configPath);
}

/**
 * Generate the dispatcher, merge native config, and return created files.
 *
 * ``events`` maps each canonical event to an ordered list of handler configs;
 * every handler is emitted as a separate native hook entry.
 */
export function installIntegrationEvents(
  integration: EventIntegration,
  projectRoot: string,
  manifest: EventManifest,
  events: ResolvedEvents,
): string[] {
  const c2n = canonicalToNative(integration);
  if (!Object.keys(c2n).length) return [];

  const filtered: ResolvedEvents = {};
  for (const [ev, handlers] of Object.entries(events)) {
    if (!Array.isArray(handlers)) continue;
    if (Object.prototype.hasOwnProperty.call(c2n, ev)) {
      filtered[ev] = handlers;
    } else {
      process.stderr.write(`⚠️  ${integration.key} does not support '${ev}' events; skipping\n`);
    }
  }

  if (!Object.keys(filtered).length) {
    removeNativeEventHooks(integration, projectRoot, manifest);
    cleanupSharedDispatcher(integration, projectRoot, manifest);
    return [];
  }

  const created: string[] = [];

  // 1. Generate the events.py dispatcher (#12: validate destination first)
  const dispatcherDir = join(projectRoot, EVENTS_DISPATCHER_DIR);
  const dispatcherPath = join(dispatcherDir, EVENTS_DISPATCHER_FILENAME);
  ensureSafeDestination(dispatcherPath);
  mkdirSync(dispatcherDir, { recursive: true });
  writeFileSync(dispatcherPath, EVENTS_DISPATCHER_TEMPLATE, 'utf8');
  chmodSync(dispatcherPath, 0o755);
  manifest.recordFile(relPosix(projectRoot, dispatcherPath), readFileSync(dispatcherPath));
  created.push(dispatcherPath);

  // 2. Format-specific merge/write
  const fmt = getAttr<string>(integration, 'events_format', 'json-nested');
  const configFile = getAttr<string | null>(integration, 'events_config_file', null);
  if (!configFile) return created;

  const configPath = join(projectRoot, configFile);
  const timeoutOf = (cfg: EventHandler): unknown => handlerGet(cfg, 'timeout', 60);

  if (fmt === 'ts-plugin') {
    const pluginPath = join(projectRoot, OPENCODE_PLUGIN_REL);
    ensureSafeDestination(pluginPath);
    mkdirSync(dirname(pluginPath), { recursive: true });
    writeFileSync(pluginPath, buildOpencodePlugin(filtered, c2n), 'utf8');
    manifest.recordFile(OPENCODE_PLUGIN_REL, readFileSync(pluginPath));
    created.push(pluginPath);
    if (mergeOpencodePluginRef(configPath, `./${OPENCODE_PLUGIN_REL}`)) {
      trackConfig(manifest, projectRoot, configPath, created);
    }
  } else if (fmt === 'copilot-json') {
    const copilotHooks: Record<string, Record<string, unknown>[]> = {};
    for (const [ev, handlers] of Object.entries(filtered)) {
      const nativeName = c2n[ev]!;
      const entries: Record<string, unknown>[] = [];
      for (const cfg of handlers) {
        const command = String(handlerGet(cfg, 'command', ''));
        const bashCmd = dispatcherCommand(integration, projectRoot, command, ev, {
          targetOs: 'posix',
          timeoutSeconds: timeoutOf(cfg),
        });
        const psCmd = dispatcherCommand(integration, projectRoot, command, ev, {
          targetOs: 'windows',
          timeoutSeconds: timeoutOf(cfg),
        });
        entries.push({
          type: 'command',
          bash: bashCmd,
          powershell: psCmd,
          timeoutSec: nativeTimeout(integration, addTimeoutBuffer(timeoutOf(cfg))),
          [SPECKIT_MARKER]: true,
        });
      }
      copilotHooks[nativeName] = entries;
    }
    if (mergeCopilotJson(configPath, copilotHooks)) trackConfig(manifest, projectRoot, configPath, created);
  } else if (fmt === 'toml') {
    const lines: string[] = [];
    for (const [ev, handlers] of Object.entries(filtered)) {
      const nativeName = c2n[ev]!;
      for (const cfg of handlers) {
        const command = String(handlerGet(cfg, 'command', ''));
        const cmd = dispatcherCommand(integration, projectRoot, command, ev, { timeoutSeconds: timeoutOf(cfg) });
        lines.push(`[[hooks.${nativeName}]]`);
        lines.push(`matcher = ${tomlQuote(pyStr(handlerGet(cfg, 'matcher', '*')))}`);
        lines.push('');
        lines.push(`[[hooks.${nativeName}.hooks]]`);
        lines.push('type = "command"');
        lines.push(`command = ${tomlQuote(cmd)}`);
        lines.push(`timeout = ${nativeTimeout(integration, addTimeoutBuffer(timeoutOf(cfg)))}`);
        lines.push('speckit_marker = true');
        lines.push('');
      }
    }
    if (mergeTomlFragment(configPath, lines.join('\n'))) trackConfig(manifest, projectRoot, configPath, created);
  } else if (fmt === 'toml-vibe') {
    const lines: string[] = [];
    const usedNames = new Set<string>();
    for (const [ev, handlers] of Object.entries(filtered)) {
      const nativeName = c2n[ev]!;
      for (const cfg of handlers) {
        const command = String(handlerGet(cfg, 'command', ''));
        const cmd = dispatcherCommand(integration, projectRoot, command, ev, {
          targetOs: vibeTargetOs(),
          timeoutSeconds: timeoutOf(cfg),
        });
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
        lines.push('[[hooks]]');
        lines.push(`name = ${tomlQuote(hookName)}`);
        lines.push(`type = ${tomlQuote(nativeName)}`);
        const matcher = handlerGet(cfg, 'matcher', '*');
        if (truthy(matcher) && matcher !== '*' && (nativeName === 'pre_tool' || nativeName === 'post_tool')) {
          lines.push(`match = ${tomlQuote('re:' + String(matcher))}`);
        }
        lines.push(`command = ${tomlQuote(cmd)}`);
        lines.push(`timeout = ${nativeTimeout(integration, addTimeoutBuffer(timeoutOf(cfg)))}`);
        lines.push('speckit_marker = true');
        lines.push('');
      }
    }
    if (mergeVibeTomlFragment(configPath, lines.join('\n'))) trackConfig(manifest, projectRoot, configPath, created);
  } else if (fmt === 'json-flat') {
    const cursorHooks: Record<string, Record<string, unknown>[]> = {};
    for (const [ev, handlers] of Object.entries(filtered)) {
      const nativeName = c2n[ev]!;
      const entries: Record<string, unknown>[] = [];
      for (const cfg of handlers) {
        const command = String(handlerGet(cfg, 'command', ''));
        const cmd = dispatcherCommand(integration, projectRoot, command, ev, { timeoutSeconds: timeoutOf(cfg) });
        entries.push({
          command: cmd,
          type: 'command',
          timeout: nativeTimeout(integration, addTimeoutBuffer(timeoutOf(cfg))),
          matcher: handlerGet(cfg, 'matcher', '*'),
          [SPECKIT_MARKER]: true,
        });
      }
      cursorHooks[nativeName] = entries;
    }
    if (mergeJsonFragment(configPath, cursorHooks, { version: 1 })) {
      trackConfig(manifest, projectRoot, configPath, created);
    }
  } else if (fmt === 'json-nested' || fmt === 'json-root-nested') {
    const nestedHooks: Record<string, Record<string, unknown>[]> = {};
    for (const [ev, handlers] of Object.entries(filtered)) {
      const nativeName = c2n[ev]!;
      const byMatcher = new Map<unknown, Record<string, unknown>[]>();
      for (const cfg of handlers) {
        const matcher = handlerGet(cfg, 'matcher', '*');
        const command = String(handlerGet(cfg, 'command', ''));
        const cmd = dispatcherCommand(integration, projectRoot, command, ev, { timeoutSeconds: timeoutOf(cfg) });
        if (!byMatcher.has(matcher)) byMatcher.set(matcher, []);
        byMatcher.get(matcher)!.push({
          type: 'command',
          command: cmd,
          timeout: nativeTimeout(integration, addTimeoutBuffer(timeoutOf(cfg))),
          [SPECKIT_MARKER]: true,
        });
      }
      nestedHooks[nativeName] = [...byMatcher.entries()].map(([matcher, inner]) => ({ matcher, hooks: inner }));
    }
    const wrote = fmt === 'json-nested' ? mergeJsonFragment(configPath, nestedHooks) : mergeJsonRoot(configPath, nestedHooks);
    if (wrote) trackConfig(manifest, projectRoot, configPath, created);
  }

  return created;
}

/** Remove Specify-authored hooks from *this* integration's native config. */
export function removeNativeEventHooks(
  integration: EventIntegration,
  projectRoot: string,
  manifest: EventManifest,
): void {
  const fmt = getAttr<string | null>(integration, 'events_format', null);
  const configFile = getAttr<string | null>(integration, 'events_config_file', null);
  if (!configFile) return;
  const configPath = join(projectRoot, configFile);
  if (!pathExists(configPath)) return;
  ensureSafeDestination(configPath);
  if (fmt === 'copilot-json') removeCopilotEntries(configPath);
  else if (fmt === 'toml') removeTomlEntries(configPath);
  else if (fmt === 'toml-vibe') removeVibeTomlEntries(configPath);
  else if (fmt === 'json-nested' || fmt === 'json-flat') removeJsonEntries(configPath);
  else if (fmt === 'json-root-nested') removeJsonRootEntries(configPath);
  else if (fmt === 'ts-plugin') removeOpencodeEntries(configPath);
  // Always drop this integration's manifest claim on the native config (S9).
  manifest.remove(configFile);
}

/**
 * Return true if another installed event-capable integration still
 * references the shared ``.specify/events.py`` dispatcher (#10).
 */
export function otherEventIntegrationsReferenceDispatcher(projectRoot: string, excludingKey: string): boolean {
  const state = readIntegrationJson(projectRoot);
  for (const key of installedIntegrationKeys(state)) {
    if (key === excludingKey) continue;
    let other: EventManifest;
    try {
      other = IntegrationManifest.load(key, projectRoot) as unknown as EventManifest;
    } catch {
      continue;
    }
    if (manifestHas(other, EVENTS_DISPATCHER_REL)) return true;
  }
  return false;
}

/**
 * Drop this integration's manifest claim on the shared dispatcher and delete
 * the file only when no other installed event-capable integration still
 * references it (#10, S3).
 */
export function cleanupSharedDispatcher(
  integration: EventIntegration,
  projectRoot: string,
  manifest: EventManifest,
): void {
  if (manifestHas(manifest, EVENTS_DISPATCHER_REL)) manifest.remove(EVENTS_DISPATCHER_REL);
  if (!otherEventIntegrationsReferenceDispatcher(projectRoot, integration.key)) {
    const dispatcherPath = join(projectRoot, EVENTS_DISPATCHER_REL);
    if (pathExists(dispatcherPath)) {
      ensureSafeDestination(dispatcherPath);
      unlinkMissingOk(dispatcherPath);
    }
  }
}

function unlinkMissingOk(p: string): void {
  try {
    unlinkSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** Remove Specify-authored event entries from native config. */
export function removeIntegrationEvents(
  integration: EventIntegration,
  projectRoot: string,
  manifest: EventManifest,
): void {
  removeNativeEventHooks(integration, projectRoot, manifest);
  cleanupSharedDispatcher(integration, projectRoot, manifest);

  if (integration.key === 'opencode') {
    if (manifestHas(manifest, OPENCODE_PLUGIN_REL)) {
      const pluginPath = join(projectRoot, OPENCODE_PLUGIN_REL);
      if (pathExists(pluginPath)) {
        ensureSafeDestination(pluginPath);
        unlinkMissingOk(pluginPath);
      }
      manifest.remove(OPENCODE_PLUGIN_REL);
    }
  }
}

/** Return project-relative paths to protect from stale cleanup. */
export function eventsStaleExclusions(integrationKey: string): Set<string> {
  const integration = getIntegration(integrationKey) as EventIntegration | null | undefined;
  if (!integration) return new Set();
  const exclusions = new Set<string>();
  const configFile = getAttr<string | null>(integration, 'events_config_file', null);
  if (configFile) exclusions.add(configFile);
  if (integrationKey === 'opencode') exclusions.add(OPENCODE_PLUGIN_REL);
  exclusions.add(EVENTS_DISPATCHER_REL);
  return exclusions;
}

/** Raised when refreshing one or more integrations' event config failed. */
export class EventRefreshError extends Error {
  readonly failures: Array<[string, string]>;

  constructor(failures: Array<[string, string]>) {
    const details = failures.map(([key, detail]) => `${key}: ${detail}`).join('; ');
    super(`event refresh failed for ${failures.length} integration(s): ${details}`);
    this.name = 'EventRefreshError';
    this.failures = failures;
  }
}

function supportsEvents(integration: EventIntegration): boolean {
  const fn = (integration as unknown as { supportsEvents?: () => boolean }).supportsEvents;
  if (typeof fn === 'function') return Boolean(fn.call(integration));
  return Boolean(
    Object.keys(canonicalToNative(integration)).length && getAttr(integration, 'events_config_file', null),
  );
}

/**
 * Re-resolve and re-emit native event config for every installed
 * event-capable integration (#1). Raises ``EventRefreshError`` when any
 * integration failed.
 */
export function refreshIntegrationEvents(projectRoot: string): void {
  const state = readIntegrationJson(projectRoot);
  const failures: Array<[string, string]> = [];
  for (const key of installedIntegrationKeys(state)) {
    const integration = getIntegration(key) as EventIntegration | null | undefined;
    if (!integration || !supportsEvents(integration)) continue;
    let manifest: EventManifest & { save(): unknown };
    try {
      manifest = IntegrationManifest.load(key, projectRoot) as unknown as EventManifest & { save(): unknown };
    } catch (exc) {
      logWarning(`Could not load manifest for '${key}'; skipping event refresh: ${(exc as Error).message}`);
      failures.push([key, `manifest load: ${(exc as Error).message}`]);
      continue;
    }
    try {
      const [, parsedOptions] = resolveIntegrationOptions(integration as never, state, key, null) as [
        unknown,
        Record<string, unknown> | null,
      ];
      const eventsMap = resolveEvents(
        key,
        getAttr<Record<string, unknown> | null>(integration, 'config', null),
        projectRoot,
        parsedOptions,
      );
      installIntegrationEvents(integration, projectRoot, manifest, eventsMap);
      manifest.save();
    } catch (exc) {
      logWarning(`Failed to refresh events for '${key}': ${(exc as Error).message}`);
      failures.push([key, (exc as Error).message]);
    }
  }
  if (failures.length) throw new EventRefreshError(failures);
}

// ============================================================================
// Manifest validation
// ============================================================================

/** Validate the ``events`` field in extension manifest data. */
export function validateEvents(data: Record<string, unknown>): void {
  const hasKey = Object.prototype.hasOwnProperty.call(data, 'events');
  const events = data.events;
  if (hasKey && !isPlainObject(events)) throw new ValidationError('Invalid events: expected a mapping');
  if (isPlainObject(events) && Object.keys(events).length) {
    for (const [eventName, eventConfig] of Object.entries(events)) {
      if (!isPlainObject(eventConfig)) {
        throw new ValidationError(`Invalid event '${eventName}': expected a mapping`);
      }
      const command = eventConfig.command;
      if (typeof command !== 'string' || !command.trim()) {
        throw new ValidationError(`Event '${eventName}' missing required 'command' string`);
      }
      if (!CANONICAL_EVENTS.has(eventName)) {
        throw new ValidationError(`Unknown event '${eventName}': must be one of ${sortedCanonicalEventsRepr()}`);
      }
      const matcher = eventConfig.matcher;
      if (matcher !== null && matcher !== undefined && typeof matcher !== 'string') {
        throw new ValidationError(`Event '${eventName}' has invalid 'matcher': must be a string`);
      }
      const timeout = eventConfig.timeout;
      if (timeout !== null && timeout !== undefined) {
        if (!isPyInt(timeout) || timeout <= 0) {
          throw new ValidationError(`Event '${eventName}' has invalid 'timeout': must be a positive integer`);
        }
      }
    }
  }
}

/** Return true if ``events`` is present and non-empty. */
export function hasEvents(data: Record<string, unknown>): boolean {
  return truthy(data.events);
}

// ============================================================================
// Helper merging functions
// ============================================================================

function tomlQuote(value: string): string {
  return escapeTomlBasic(value);
}

/** Render the opencode TS plugin for the resolved event set. */
export function buildOpencodePlugin(filteredEvents: ResolvedEvents, c2n: Record<string, string>): string {
  const eventEntries: string[] = [];
  const pluginReturns: string[] = [];
  const eventHandlers: string[] = [];
  const dumps = (v: unknown): string => pyJsonDumps(v);

  for (const [ev, handlers] of Object.entries(filteredEvents)) {
    const nativeName = c2n[ev]!;
    const evLit = dumps(ev);
    const nativeLit = dumps(nativeName);
    const isInjection = nativeName === 'experimental.chat.system.transform' || nativeName === 'chat.message';

    const bodyLines: string[] = ['    const errors: string[] = [];'];
    if (isInjection) bodyLines.push('    const contexts: string[] = [];');
    for (const cfg of handlers) {
      const command = pyStr(handlerGet(cfg, 'command', ''));
      const commandLit = dumps(command);
      const matcher = handlerGet(cfg, 'matcher', '*');
      let timeoutSec: number;
      try {
        timeoutSec = pyInt(handlerGet(cfg, 'timeout', 60));
      } catch {
        timeoutSec = 60;
      }
      if (nativeName.startsWith('tool.execute.')) {
        if (truthy(matcher) && matcher !== '*') {
          const tools = String(matcher)
            .split('|')
            .map((t) => pyStrip(pyStrip(t), '"'));
          const checks = tools.map((t) => `input.tool === ${dumps(t.toLowerCase())}`).join(' || ');
          bodyLines.push(
            `    try { if (${checks}) { runEvent(${commandLit}, ${evLit}, input, output, ${timeoutSec}); } } catch (e) { errors.push((e as Error).message); }`,
          );
        } else {
          bodyLines.push(
            `    try { runEvent(${commandLit}, ${evLit}, input, output, ${timeoutSec}); } catch (e) { errors.push((e as Error).message); }`,
          );
        }
      } else if (isInjection) {
        bodyLines.push(
          `    try { const ctx = runEvent(${commandLit}, ${evLit}, input, output, ${timeoutSec}); if (ctx) contexts.push(ctx); } catch (e) { errors.push((e as Error).message); }`,
        );
      } else {
        bodyLines.push(
          `    try { runEvent(${commandLit}, ${evLit}, input, output, ${timeoutSec}); } catch (e) { errors.push((e as Error).message); }`,
        );
      }
    }
    bodyLines.push("    if (errors.length > 0) { throw new Error(errors.join('; ')); }");

    if (nativeName.startsWith('tool.execute.')) {
      eventEntries.push(`function _${ev}(input: any, output: any) {\n` + bodyLines.join('\n') + '\n  }');
      pluginReturns.push(
        `    ${dumps(nativeName)}: async (input: any, output: any) => {\n` + `      _${ev}(input, output);\n` + '    },',
      );
    } else if (nativeName === 'experimental.chat.system.transform') {
      bodyLines.push('    return contexts.join("\\n\\n");');
      eventEntries.push(`function _${ev}(input: any, output: any): string {\n` + bodyLines.join('\n') + '\n  }');
      pluginReturns.push(
        `    ${nativeLit}: async (input: any, output: any) => {\n` +
          '      if (!input.sessionID) return;\n' +
          '      let ctx = sessionStartCache.get(input.sessionID);\n' +
          '      if (ctx === undefined) {\n' +
          `        ctx = _${ev}(input, output);\n` +
          '        sessionStartCache.set(input.sessionID, ctx ?? "");\n' +
          '      }\n' +
          '      if (ctx) output.system.push(ctx);\n' +
          '    },',
      );
    } else if (nativeName === 'chat.message') {
      bodyLines.push('    return contexts.join("\\n\\n");');
      eventEntries.push(`function _${ev}(input: any, output: any): string {\n` + bodyLines.join('\n') + '\n  }');
      pluginReturns.push(
        `    ${nativeLit}: async (input: any, output: any) => {\n` +
          `      const ctx = _${ev}(input, output);\n` +
          '      if (!ctx) return;\n' +
          '      const base = output.parts[output.parts.length - 1]?.id ?? "prt_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);\n' +
          '      output.parts.push({ id: base + ".speckit" + Math.random().toString(36).slice(2, 8), sessionID: input.sessionID, messageID: output.message.id, type: "text", text: ctx, synthetic: true });\n' +
          '    },',
      );
    } else {
      eventEntries.push(`function _${ev}(input: any, output: any) {\n` + bodyLines.join('\n') + '\n  }');
      let eviction = '';
      if (nativeName === 'session.deleted') {
        eviction = 'if (event.sessionID) sessionStartCache.delete(event.sessionID); ';
      }
      eventHandlers.push(`      if (event.type === ${nativeLit}) { ${eviction}_${ev}(event, event); }`);
    }
  }

  if (eventHandlers.length) {
    pluginReturns.push('    event: async ({ event }) => {\n' + eventHandlers.join('\n') + '\n    },');
  }

  return TS_PLUGIN_TEMPLATE.split(TS_PLUGIN_PLACEHOLDERS.buffer)
    .join(String(EVENT_TIMEOUT_BUFFER))
    .split(TS_PLUGIN_PLACEHOLDERS.eventEntries)
    .join(eventEntries.join('\n\n'))
    .split(TS_PLUGIN_PLACEHOLDERS.pluginReturns)
    .join(pluginReturns.join('\n'));
}

/** Python ``str.strip(chars)``. */
function pyStrip(value: string, chars?: string): string {
  if (chars === undefined) return value.trim();
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start]!)) start++;
  while (end > start && chars.includes(value[end - 1]!)) end--;
  return value.slice(start, end);
}

/** Merge the speckit-events plugin ref into opencode.json. */
export function mergeOpencodePluginRef(configPath: string, ref: string): boolean {
  const existing = loadUserJson(configPath);
  if (existing === null) return false;
  let plugins = Object.prototype.hasOwnProperty.call(existing, 'plugin') ? existing.plugin : [];
  if (!Array.isArray(plugins)) plugins = [];
  const list = plugins as unknown[];
  if (!list.includes(ref)) list.push(ref);
  existing.plugin = list;
  safeWriteJson(configPath, existing);
  return true;
}

/** Remove the speckit-events plugin ref from opencode.json (#23). */
export function removeOpencodeEntries(configPath: string): boolean {
  ensureSafeDestination(configPath);
  const existing = loadUserJson(configPath);
  if (existing === null) return false;
  const plugins = Object.prototype.hasOwnProperty.call(existing, 'plugin') ? existing.plugin : [];
  if (Array.isArray(plugins)) {
    const ref = `./${OPENCODE_PLUGIN_REL}`;
    const kept = plugins.filter((p) => p !== ref);
    if (kept.length) existing.plugin = kept;
    else delete existing.plugin;
  }
  if (!Object.keys(existing).length) {
    unlinkMissingOk(configPath);
    return true;
  }
  safeWriteJson(configPath, existing);
  return false;
}

const TOML_OWNED_BLOCK = /\[\[hooks\.[\p{L}\p{N}_]+\]\]\n(?:(?!\[\[hooks\.[\p{L}\p{N}_]+\]\])[\s\S])*?speckit_marker = true\n*/gu;
const VIBE_OWNED_BLOCK = /\[\[hooks\]\]\n(?:(?!\[\[hooks\]\])[\s\S])*?speckit_marker = true\n*/g;

function readUtf8(p: string): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(p));
}

function warnUnreadable(p: string, action: 'merge' | 'cleanup'): void {
  logWarning(
    `Could not read ${p} (it may be unreadable or not UTF-8); ` +
      `skipping event-config ${action} to preserve user content.`,
  );
}

/** Python ``str.rstrip()``. */
function rstrip(value: string): string {
  return value.replace(/[\s\x1c-\x1f\x85]+$/u, '');
}

/** Merge Specify-owned TOML entries into *dst*, regenerating the file. */
export function mergeTomlFragment(dst: string, fragment: string): boolean {
  ensureSafeDestination(dst);
  let existing = '';
  if (pathExists(dst)) {
    try {
      existing = readUtf8(dst);
    } catch {
      warnUnreadable(dst, 'merge');
      return false;
    }
  }
  const stripped = existing.replace(TOML_OWNED_BLOCK, '');
  if (!fragment && stripped === existing) return false;
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, rstrip(stripped) + '\n\n' + fragment + '\n', 'utf8');
  return true;
}

/** Merge Specify-owned Vibe TOML hook entries into *dst*. */
export function mergeVibeTomlFragment(dst: string, fragment: string): boolean {
  ensureSafeDestination(dst);
  let existing = '';
  if (pathExists(dst)) {
    try {
      existing = readUtf8(dst);
    } catch {
      warnUnreadable(dst, 'merge');
      return false;
    }
  }
  existing = existing.replace(VIBE_OWNED_BLOCK, '');
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, rstrip(existing) + '\n\n' + fragment + '\n', 'utf8');
  return true;
}

function hasUserTomlContent(cleaned: string): boolean {
  return splitLines(cleaned).some((line) => line.trim() && !line.trim().startsWith('#'));
}

/** Remove Specify-marked TOML entries; delete the file if now empty (#14). */
export function removeTomlEntries(dst: string): boolean {
  if (!pathExists(dst)) return false;
  ensureSafeDestination(dst);
  let existing: string;
  try {
    existing = readUtf8(dst);
  } catch {
    warnUnreadable(dst, 'cleanup');
    return false;
  }
  const cleaned = existing.replace(TOML_OWNED_BLOCK, '');
  if (cleaned === existing) return false;
  if (!hasUserTomlContent(cleaned)) {
    unlinkMissingOk(dst);
    return true;
  }
  writeFileSync(dst, cleaned, 'utf8');
  return false;
}

/** Remove Specify-marked Vibe TOML hook entries; delete the file if now empty. */
export function removeVibeTomlEntries(dst: string): boolean {
  if (!pathExists(dst)) return false;
  ensureSafeDestination(dst);
  let existing: string;
  try {
    existing = readUtf8(dst);
  } catch {
    warnUnreadable(dst, 'cleanup');
    return false;
  }
  const cleaned = existing.replace(VIBE_OWNED_BLOCK, '');
  if (!hasUserTomlContent(cleaned)) {
    unlinkMissingOk(dst);
    return true;
  }
  writeFileSync(dst, cleaned, 'utf8');
  return false;
}

function stripMarkedHooks(hooks: unknown): Record<string, unknown[]> {
  const cleaned: Record<string, unknown[]> = {};
  if (!isPlainObject(hooks)) return cleaned;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = dropMarkedEntries(entries);
    if (kept.length) cleaned[event] = kept;
  }
  return cleaned;
}

function appendNewHooks(target: Record<string, unknown[]>, newHooks: Record<string, unknown[]>): void {
  for (const [event, entries] of Object.entries(newHooks)) {
    if (!Object.prototype.hasOwnProperty.call(target, event)) target[event] = [];
    target[event]!.push(...entries);
  }
}

function setdefault(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) obj[key] = value;
}

/** Merge Specify-owned hooks into Copilot's dedicated hooks JSON (#8). */
export function mergeCopilotJson(dst: string, newHooks: Record<string, unknown[]>): boolean {
  const existing = loadUserJson(dst);
  if (existing === null) return false;
  setdefault(existing, 'version', 1);
  const cleaned = stripMarkedHooks(existing.hooks ?? {});
  appendNewHooks(cleaned, newHooks);
  if (Object.keys(cleaned).length) existing.hooks = cleaned;
  else delete existing.hooks;
  safeWriteJson(dst, existing);
  return true;
}

/** Remove Specify-owned hooks from Copilot's hooks JSON (#8, #14). */
export function removeCopilotEntries(dst: string): boolean {
  ensureSafeDestination(dst);
  const existing = loadUserJson(dst);
  if (existing === null) return false;
  const cleaned = stripMarkedHooks(existing.hooks ?? {});
  if (Object.keys(cleaned).length) existing.hooks = cleaned;
  else delete existing.hooks;
  const userKeys = Object.keys(existing).filter((k) => k !== 'version');
  if (!userKeys.length) {
    unlinkMissingOk(dst);
    return true;
  }
  safeWriteJson(dst, existing);
  return false;
}

/** Merge Specify-authored hook entries into a native JSON config (idempotent). */
export function mergeJsonFragment(
  dst: string,
  newHooks: Record<string, unknown[]>,
  opts: { version?: number } = {},
): boolean {
  const existing = loadUserJson(dst);
  if (existing === null) return false;
  if (opts.version !== undefined) setdefault(existing, 'version', opts.version);
  const cleaned = stripMarkedHooks(existing.hooks ?? {});
  appendNewHooks(cleaned, newHooks);
  if (Object.keys(cleaned).length) existing.hooks = cleaned;
  else delete existing.hooks;
  safeWriteJson(dst, existing);
  return true;
}

/** Merge Specify-authored hooks into a root-nested JSON config (Devin U2). */
export function mergeJsonRoot(dst: string, newHooks: Record<string, unknown[]>): boolean {
  const existing = loadUserJson(dst);
  if (existing === null) return false;
  const cleaned: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(existing)) {
    if (!Array.isArray(entries)) {
      cleaned[event] = entries;
      continue;
    }
    const kept = dropMarkedEntries(entries);
    if (kept.length) cleaned[event] = kept;
  }
  for (const [event, entries] of Object.entries(newHooks)) {
    if (!Object.prototype.hasOwnProperty.call(cleaned, event)) cleaned[event] = [];
    const target = cleaned[event];
    if (Array.isArray(target)) target.push(...entries);
    else throw new TypeError(`'${pyTypeName(target)}' object has no attribute 'extend'`);
  }
  if (!Object.keys(cleaned).length) {
    unlinkMissingOk(dst);
    return true;
  }
  safeWriteJson(dst, cleaned);
  return true;
}

/** Remove Specify-authored entries from a root-nested JSON config (Devin U2). */
export function removeJsonRootEntries(dst: string): boolean {
  ensureSafeDestination(dst);
  const existing = loadUserJson(dst);
  if (existing === null) return false;
  const cleaned: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(existing)) {
    if (!Array.isArray(entries)) {
      cleaned[event] = entries;
      continue;
    }
    const kept = dropMarkedEntries(entries);
    if (kept.length) cleaned[event] = kept;
  }
  if (!Object.keys(cleaned).length) {
    unlinkMissingOk(dst);
    return true;
  }
  safeWriteJson(dst, cleaned);
  return false;
}

/** Return *entries* with Specify-marked hooks removed, preserving user hooks (#9). */
export function dropMarkedEntries(entries: unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      kept.push(entry);
      continue;
    }
    const inner = entry.hooks;
    if (Array.isArray(inner)) {
      const keptInner = inner.filter((h) => !hasMarker(h));
      if (keptInner.length) {
        entry.hooks = keptInner;
        kept.push(entry);
      }
    } else if (hasMarker(entry)) {
      // flat Specify-owned entry → drop
    } else {
      kept.push(entry);
    }
  }
  return kept;
}

/**
 * Load a user-owned JSON file, returning ``null`` on read/parse failure.
 * A missing file yields ``{}``.
 */
export function loadUserJson(path: string): Record<string, unknown> | null {
  if (!pathExists(path)) return {};
  let data: unknown;
  try {
    data = JSON.parse(readUtf8(path));
  } catch {
    logWarning(
      `Could not read or parse ${path} (it may be unreadable, contain JSONC ` +
        'comments, or be malformed); ' +
        'skipping event-config merge to preserve user content.',
    );
    return null;
  }
  if (!isPlainObject(data)) {
    logWarning(`${path} is not a JSON object; skipping event-config merge.`);
    return null;
  }
  return data;
}

function safeWriteJson(dst: string, data: Record<string, unknown>): void {
  ensureSafeDestination(dst);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, pyJsonDumps(data, { indent: 2 }) + '\n', 'utf8');
}

/**
 * Validate a write target is a regular path inside the project (#12).
 *
 * Walks each path component and rejects symlinks, then validates lexical
 * containment against the nearest existing ancestor directory.
 */
export function ensureSafeDestination(dst: string): void {
  const { root } = parsePath(dst);
  const anchor = root;
  let walked = anchor || '/';
  const rest = anchor ? dst.slice(anchor.length) : dst;
  for (const part of rest.split(/[\\/]+/).filter((x) => x && x !== '.')) {
    walked = join(walked, part);
    if (isSymlink(walked)) {
      throw new ValueError(`Refusing to write event config through a symlink: ${walked}`);
    }
  }
  let base = dirname(dst);
  while (!pathExists(base) && base !== dirname(base)) base = dirname(base);
  CommandRegistrar.ensureInside(dst, base);
}

/** Remove Specify-authored entries; delete the file if now empty (#14). */
export function removeJsonEntries(dst: string): boolean {
  ensureSafeDestination(dst);
  const existing = loadUserJson(dst);
  if (existing === null) return false;
  const hooks = Object.prototype.hasOwnProperty.call(existing, 'hooks') ? existing.hooks : {};
  if (!isPlainObject(hooks)) return false;
  const cleaned = stripMarkedHooks(hooks);
  if (Object.keys(cleaned).length) existing.hooks = cleaned;
  else delete existing.hooks;
  const userKeys = Object.keys(existing).filter((k) => k !== 'version');
  if (!userKeys.length) {
    unlinkMissingOk(dst);
    return true;
  }
  safeWriteJson(dst, existing);
  return false;
}

/** Return true if *entry* (or any nested inner hook) is Specify-marked (#9). */
export function hasMarker(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  if (entry[SPECKIT_MARKER] === true) return true;
  const inner = entry.hooks;
  if (Array.isArray(inner)) return inner.some((h) => hasMarker(h));
  return false;
}
