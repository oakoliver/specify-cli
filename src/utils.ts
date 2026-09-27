/**
 * @oakoliver/specify-cli - Utilities
 *
 * Port of upstream `_utils.py` (subprocess, tool detection, file operations,
 * JSON merging, version specifiers) plus small Python-compat helpers used
 * across the port:
 *
 * - `which()` (== `shutil.which`), `pyTypeName()` (== `type(x).__name__`),
 *   `pyRepr()` (== `repr(str)`), `pyJsonDumps()` (== `json.dumps`).
 * - `parseJson5()` (== `json5.loads`, JSONC with comments/trailing commas).
 * - PEP 440 `Version` / `SpecifierSet` (== `packaging.version` /
 *   `packaging.specifiers`), `versionSatisfies()`.
 *
 * @module utils
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { console, StepTracker } from './console.js';
import { normalizeZipMemberName, pyRepr, resolvePathLoose } from './download-security.js';
import { dumpYaml } from './yaml.js';

export { pyRepr, resolvePathLoose };

// ============================================================================
// Python-compat helpers
// ============================================================================

/** Python `type(value).__name__` for JSON/YAML-shaped values. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  if (value instanceof Uint8Array) return 'bytes';
  if (value instanceof Date) return 'datetime';
  if (typeof value === 'function') return 'function';
  return 'dict';
}

/** Python `str(value)` for JSON/YAML-shaped values. */
export function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pyRepr(value);
  return pyRepr(value);
}

/** Python truthiness (`bool(value)`). */
export function pyBool(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (typeof value === 'number' && Number.isNaN(value)) return true;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python `int(value)`; throws TypeError/ValueError-like errors like Python. */
export function pyInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new RangeError('cannot convert float NaN to integer');
    if (!Number.isFinite(value)) throw new RangeError('cannot convert float infinity to integer');
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (/^[+-]?\d+(?:_\d+)*$/.test(s)) return parseInt(s.replace(/_/g, ''), 10);
    throw new RangeError(`invalid literal for int() with base 10: ${pyRepr(value)}`);
  }
  throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(value)}'`);
}

/** True for a plain JSON/YAML mapping (Python `isinstance(x, dict)`). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Uint8Array) && !(value instanceof Date);
}

/** Options for {@link pyJsonDumps}. */
export interface PyJsonDumpsOptions {
  indent?: number | null;
  sortKeys?: boolean;
  /** Escape non-ASCII as `\uXXXX` (Python default true). */
  ensureAscii?: boolean;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}

/**
 * Python `json.dumps` formatting: `indent=None` gives `", "`/`": "` separators,
 * an indent gives newline-separated output; `ensure_ascii` escapes non-ASCII.
 */
export function pyJsonDumps(value: unknown, opts: PyJsonDumpsOptions = {}): string {
  const v = opts.sortKeys ? sortKeysDeep(value) : value;
  let out: string;
  if (opts.indent === undefined || opts.indent === null) {
    out = compactPyJson(v);
  } else {
    out = JSON.stringify(v, null, opts.indent) ?? 'null';
  }
  if (opts.ensureAscii ?? true) {
    out = out.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  }
  return out;
}

function compactPyJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(compactPyJson).join(', ') + ']';
  if (isPlainObject(v)) {
    return '{' + Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${JSON.stringify(k)}: ${compactPyJson(x)}`).join(', ') + '}';
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
  return JSON.stringify(v) ?? 'null';
}

// ============================================================================
// which (shutil.which)
// ============================================================================

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Port of `shutil.which`: locate an executable on PATH (honours PATHEXT on Windows). */
export function which(cmd: string, envPath: string | undefined = process.env.PATH): string | null {
  if (cmd.includes('/') || (process.platform === 'win32' && cmd.includes('\\'))) {
    return isExecutableFile(cmd) ? cmd : null;
  }
  const dirs = (envPath ?? '').split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  if (process.platform === 'win32') dirs.unshift(process.cwd());
  for (const dir of dirs) {
    for (const ext of process.platform === 'win32' && exts.some((e) => cmd.toLowerCase().endsWith(e.toLowerCase())) ? [''] : exts) {
      const candidate = path.join(dir, cmd + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Indirection used by {@link checkTool} / {@link dockerAgentCommand} so tests can
 * stub tool lookup (Python tests patch `shutil.which`).
 */
export const toolLookup: {
  which: (cmd: string) => string | null;
  run: (cmd: string[], timeoutMs: number) => { status: number | null; error?: Error };
} = {
  which: (cmd) => which(cmd),
  run: (cmd, timeoutMs) => {
    const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'pipe', timeout: timeoutMs });
    return { status: r.status, error: r.error };
  },
};

// ============================================================================
// Constants
// ============================================================================

/** Claude Code local install locations (mutable for tests, like module attributes). */
export const CLAUDE_PATHS = {
  local: path.join(os.homedir(), '.claude', 'local', 'claude'),
  npmLocal: path.join(os.homedir(), '.claude', 'local', 'node_modules', '.bin', 'claude'),
};
export const CLAUDE_LOCAL_PATH = CLAUDE_PATHS.local;
export const CLAUDE_NPM_LOCAL_PATH = CLAUDE_PATHS.npmLocal;
export const DOCKER_AGENT_CHECK_TIMEOUT = 5;

// ============================================================================
// Tool detection
// ============================================================================

/**
 * Return a runnable Docker Agent command, or null if unavailable.
 * Standalone `docker-agent` or the `docker agent` CLI plugin (verified with a
 * bounded `docker agent version` probe).
 */
export function dockerAgentCommand(executable: string | null = null): string[] | null {
  const resolvedFromPath = executable === null;
  if (executable === null) {
    if (toolLookup.which('docker-agent')) return ['docker-agent', 'run'];
    executable = toolLookup.which('docker');
    if (executable === null) return null;
  }
  const executableName = path.basename(executable).toLowerCase();
  let command: string[];
  let runCommand: string[];
  if (executableName === 'docker' || executableName === 'docker.exe') {
    command = [executable, 'agent', 'version'];
    runCommand = [executable, 'agent', 'run'];
  } else {
    return [executable, 'run'];
  }
  const result = toolLookup.run(command, DOCKER_AGENT_CHECK_TIMEOUT * 1000);
  if (result.error || result.status !== 0) return null;
  return resolvedFromPath ? ['docker', 'agent', 'run'] : runCommand;
}

/**
 * Return why `value` is unsafe as an extension-relative `file` path, or null.
 * Shared by manifest validation and command registration.
 */
export function relativeExtensionPathViolation(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return 'must be a non-empty string';
  if (value.trim() !== value) return 'must not have leading or trailing whitespace';
  if (value.includes('\\')) return 'must use forward slashes as path separators';
  const posixAnchor = value.startsWith('/');
  const winAnchor = value.startsWith('/') || value[1] === ':';
  const parts = value.split('/');
  if (posixAnchor || winAnchor || parts.includes('..')) {
    return "must be a relative path within the extension directory (no absolute paths, drive letters, or '..' segments)";
  }
  if (value.endsWith('/') || value.endsWith('\\')) return 'must name a file or command, not a directory';
  try {
    normalizeZipMemberName(value);
  } catch {
    return 'must use portable path components (no reserved names or platform-invalid characters)';
  }
  return null;
}

/**
 * Serialize skill/command frontmatter to YAML
 * (`yaml.safe_dump(data, sort_keys=False, allow_unicode=True).strip()`).
 */
export function dumpFrontmatter(data: Record<string, unknown>): string {
  return dumpYaml(data, { sortKeys: false, allowUnicode: true }).trim();
}

/** Error raised by {@link runCommand} (Python `subprocess.CalledProcessError`). */
export class CalledProcessError extends Error {
  constructor(public returncode: number, public cmd: string[], public stdout = '', public stderr = '') {
    super(`Command '${JSON.stringify(cmd)}' returned non-zero exit status ${returncode}.`);
    this.name = 'CalledProcessError';
  }
}

/**
 * Run a command without a shell. With `capture`, returns trimmed stdout.
 * On failure with `checkReturn` prints the upstream error lines and throws
 * {@link CalledProcessError}; otherwise returns null.
 */
export function runCommand(cmd: string[], checkReturn = true, capture = false): string | null {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    if (checkReturn) {
      console.print(`[red]Error running command:[/red] ${cmd.join(' ')}`);
      console.print(`[red]Exit code:[/red] ${r.status}`);
      if (r.stderr) console.print(`[red]Error output:[/red] ${r.stderr}`);
      throw new CalledProcessError(r.status ?? 1, cmd, r.stdout ?? '', r.stderr ?? '');
    }
    return null;
  }
  return capture ? (r.stdout ?? '').trim() : null;
}

/** Check if a tool is installed. Optionally update a {@link StepTracker}. */
export function checkTool(tool: string, tracker: Pick<StepTracker, 'complete' | 'error'> | null = null): boolean {
  if (tool === 'claude') {
    if (isFile(CLAUDE_PATHS.local) || isFile(CLAUDE_PATHS.npmLocal)) {
      tracker?.complete(tool, 'available');
      return true;
    }
  }
  let found: boolean;
  if (tool === 'kiro-cli') found = toolLookup.which('kiro-cli') !== null || toolLookup.which('kiro') !== null;
  else if (tool === 'rovodev') found = toolLookup.which('acli') !== null;
  else if (tool === 'docker-agent') found = dockerAgentCommand() !== null;
  else found = toolLookup.which(tool) !== null;
  if (tracker) {
    if (found) tracker.complete(tool, 'available');
    else tracker.error(tool, 'not found');
  }
  return found;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// ============================================================================
// JSON5 (json5.loads)
// ============================================================================

/** Error raised by {@link parseJson5} (Python json5 raises ValueError). */
export class Json5Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/** Parse JSON5/JSONC text (comments, trailing commas, single quotes, unquoted keys, hex, Infinity/NaN). */
export function parseJson5(text: string): unknown {
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const n = text.length;
  const fail = (msg: string): never => {
    const before = text.slice(0, i);
    const line = before.split('\n').length;
    const col = i - before.lastIndexOf('\n');
    throw new Json5Error(`<string>:${line} ${msg} at column ${col}`);
  };
  const ws = (): void => {
    while (i < n) {
      const c = text[i];
      if (' \t\n\r\v\f ﻿  '.includes(c)) i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else if (c === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('Unexpected end of input in comment');
        i = end + 2;
      } else break;
    }
  };
  const parseString = (): string => {
    const q = text[i++];
    let out = '';
    while (i < n) {
      const c = text[i++];
      if (c === q) return out;
      if (c === '\\') {
        const e = text[i++];
        const map: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0', "'": "'", '"': '"', '\\': '\\', '/': '/' };
        if (e in map) out += map[e];
        else if (e === 'x') {
          out += String.fromCharCode(parseInt(text.slice(i, i + 2), 16));
          i += 2;
        } else if (e === 'u') {
          out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
          i += 4;
        } else if (e === '\n' || e === ' ' || e === ' ') {
          // line continuation
        } else if (e === '\r') {
          if (text[i] === '\n') i++;
        } else out += e;
      } else if (c === '\n') {
        fail('Unexpected newline in string');
      } else out += c;
    }
    return fail('Unterminated string');
  };
  const parseNumber = (): number => {
    const m = /^[+-]?(?:Infinity|NaN|0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!m) fail(`Unexpected "${text[i]}"`);
    i += m![0].length;
    const s = m![0];
    const sign = s.startsWith('-') ? -1 : 1;
    const body = s.replace(/^[+-]/, '');
    if (body === 'Infinity') return sign * Infinity;
    if (body === 'NaN') return NaN;
    if (/^0[xX]/.test(body)) return sign * parseInt(body.slice(2), 16);
    return sign * Number(body);
  };
  const parseValue = (): unknown => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        let key: string;
        if (text[i] === '"' || text[i] === "'") key = parseString();
        else {
          const m = /^[A-Za-z_$\u0080-￿][\w$\u0080-￿]*/.exec(text.slice(i));
          if (!m) return fail(`Unexpected "${text[i] ?? 'EOF'}"`);
          key = m[0];
          i += key.length;
        }
        ws();
        if (text[i] !== ':') fail(`Expected ":"`);
        i++;
        const v = parseValue();
        if (key === '__proto__') Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        else obj[key] = v;
        ws();
        if (text[i] === ',') {
          i++;
          ws();
          if (text[i] === '}') {
            i++;
            return obj;
          }
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        return fail(`Expected "," or "}"`);
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue());
        ws();
        if (text[i] === ',') {
          i++;
          ws();
          if (text[i] === ']') {
            i++;
            return arr;
          }
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        return fail(`Expected "," or "]"`);
      }
    }
    if (c === '"' || c === "'") return parseString();
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return false;
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    if (c === undefined) return fail('Unexpected end of input');
    return parseNumber();
  };
  const value = parseValue();
  ws();
  if (i < n) fail(`Unexpected "${text[i]}"`);
  return value;
}

// ============================================================================
// JSON merge / VS Code settings
// ============================================================================

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b as number);
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Merge new JSON content into an existing JSON(C) file (polite deep merge:
 * new keys added, existing values preserved, nested dicts merged).
 * Returns the merged object, or null when the existing file should be left
 * untouched (unparseable, non-object, or no changes).
 */
export function mergeJsonFiles(existingPath: string, newContent: unknown, verbose = false): Record<string, unknown> | null {
  let existingContent: unknown = null;
  let exists = fs.existsSync(existingPath);
  const name = path.basename(existingPath);
  if (exists) {
    try {
      existingContent = parseJson5(fs.readFileSync(existingPath, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        exists = false;
      } else if (e instanceof Json5Error || (e as NodeJS.ErrnoException).code !== undefined) {
        if (verbose) {
          console.print(`[yellow]Warning: Could not read or parse existing JSON in ${name} (${(e as Error).message}).[/yellow]`);
        }
        return null;
      } else {
        throw e;
      }
    }
  }
  if (!isPlainObject(newContent)) {
    if (verbose) console.print(`[yellow]Warning: Template content for ${name} is not a dictionary. Preserving existing settings.[/yellow]`);
    return null;
  }
  if (!exists) return newContent;
  if (!isPlainObject(existingContent)) {
    if (verbose) console.print(`[yellow]Warning: Existing JSON in ${name} is not an object. Skipping merge to avoid data loss.[/yellow]`);
    return null;
  }
  const deepMergePolite = (base: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(update)) {
      if (!(key in result)) result[key] = value;
      else if (isPlainObject(result[key]) && isPlainObject(value)) {
        result[key] = deepMergePolite(result[key] as Record<string, unknown>, value);
      }
    }
    return result;
  };
  const merged = deepMergePolite(existingContent, newContent);
  if (deepEqual(merged, existingContent)) return null;
  if (verbose) console.print(`[cyan]Merged JSON file:[/cyan] ${name}`);
  return merged;
}

/** Atomically write JSON (indent 4, ensure_ascii) preserving existing mode bits. */
function atomicWriteJson(targetFile: string, payload: unknown): void {
  const dir = path.dirname(targetFile);
  const tmp = path.join(dir, `${path.basename(targetFile)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    fs.writeFileSync(tmp, pyJsonDumps(payload, { indent: 4 }) + '\n', 'utf8');
    if (fs.existsSync(targetFile)) {
      try {
        const st = fs.statSync(targetFile);
        fs.chmodSync(tmp, st.mode & 0o7777);
        try {
          fs.chownSync(tmp, st.uid, st.gid);
        } catch {
          // Best-effort owner/group preservation.
        }
      } catch {
        // Best-effort metadata preservation.
      }
    }
    fs.renameSync(tmp, targetFile);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw e;
  }
}

/**
 * Handle merging or copying of `.vscode/settings.json` files.
 * When merge produces changes, output is normalized JSON (comments dropped).
 */
export function handleVscodeSettings(
  subItem: string,
  destFile: string,
  relPath: string,
  verbose = false,
  tracker: unknown = null,
): void {
  const log = (message: string, color = 'green'): void => {
    if (verbose && !tracker) console.print(`[${color}]${message}[/] ${relPath}`);
  };
  try {
    const newSettings = parseJson5(fs.readFileSync(subItem, 'utf8'));
    if (fs.existsSync(destFile)) {
      const merged = mergeJsonFiles(destFile, newSettings, verbose && !tracker);
      if (merged !== null) {
        atomicWriteJson(destFile, merged);
        log('Merged:', 'green');
        log('Note: comments/trailing commas are normalized when rewritten', 'yellow');
      } else {
        log('Skipped merge (preserved existing settings)', 'yellow');
      }
    } else {
      fs.copyFileSync(subItem, destFile);
      log('Copied (no existing settings.json):', 'blue');
    }
  } catch (e) {
    const isExpected = e instanceof Json5Error || (e as NodeJS.ErrnoException).code !== undefined;
    if (!isExpected) throw e;
    log(`Warning: Could not merge settings: ${(e as Error).message}`, 'yellow');
    if (!fs.existsSync(destFile)) fs.copyFileSync(subItem, destFile);
  }
}

/** Return a stable POSIX-style display path for paths under a project. */
export function displayProjectPath(projectRoot: string, p: string): string {
  const toPosix = (s: string): string => s.split(path.sep).join('/');
  if (!path.isAbsolute(p)) return toPosix(path.normalize(p)).replace(/\/$/, '') || '.';
  const rel = path.relative(projectRoot, p);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel) || '.';
  try {
    const rel2 = path.relative(resolvePathLoose(projectRoot), resolvePathLoose(p));
    if (!rel2.startsWith('..') && !path.isAbsolute(rel2)) return toPosix(rel2) || '.';
  } catch {
    // fall through
  }
  return toPosix(p);
}

// ============================================================================
// PEP 440 versions (packaging.version)
// ============================================================================

/** Raised for an unparseable version (`packaging.version.InvalidVersion`). */
export class InvalidVersion extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidVersion';
  }
}

/** Raised for an unparseable specifier (`packaging.specifiers.InvalidSpecifier`). */
export class InvalidSpecifier extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSpecifier';
  }
}

const VERSION_RE =
  /^\s*v?(?:(?:(\d+)!)?(\d+(?:\.\d+)*)((?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\d+)?)?)((?:-(\d+))|(?:[-_.]?(post|rev|r)[-_.]?(\d+)?))?((?:[-_.]?(dev)[-_.]?(\d+)?))?)(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

type LocalPart = number | string;

/** A PEP 440 version (subset of `packaging.version.Version`). */
export class Version {
  readonly epoch: number;
  readonly release: number[];
  readonly pre: [string, number] | null;
  readonly post: number | null;
  readonly dev: number | null;
  readonly local: string | null;
  private readonly localParts: LocalPart[] | null;

  constructor(version: string) {
    const m = VERSION_RE.exec(version);
    if (!m) throw new InvalidVersion(`Invalid version: ${pyRepr(version)}`);
    this.epoch = m[1] ? parseInt(m[1], 10) : 0;
    this.release = m[2].split('.').map((x) => parseInt(x, 10));
    if (m[4]) {
      let l = m[4].toLowerCase();
      if (l === 'alpha') l = 'a';
      else if (l === 'beta') l = 'b';
      else if (l === 'c' || l === 'pre' || l === 'preview') l = 'rc';
      this.pre = [l, m[5] ? parseInt(m[5], 10) : 0];
    } else this.pre = null;
    if (m[6]) {
      this.post = m[7] !== undefined ? parseInt(m[7], 10) : m[9] !== undefined ? parseInt(m[9], 10) : 0;
    } else this.post = null;
    this.dev = m[11] ? (m[12] !== undefined ? parseInt(m[12], 10) : 0) : null;
    if (m[13]) {
      this.localParts = m[13].toLowerCase().split(/[-_.]/).map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p));
      this.local = this.localParts.join('.');
    } else {
      this.localParts = null;
      this.local = null;
    }
  }

  get isPrerelease(): boolean {
    return this.dev !== null || this.pre !== null;
  }

  get isPostrelease(): boolean {
    return this.post !== null;
  }

  get isDevrelease(): boolean {
    return this.dev !== null;
  }

  get major(): number {
    return this.release[0] ?? 0;
  }

  get minor(): number {
    return this.release[1] ?? 0;
  }

  get micro(): number {
    return this.release[2] ?? 0;
  }

  /** `base_version`: epoch + release. */
  get baseVersion(): string {
    return (this.epoch ? `${this.epoch}!` : '') + this.release.join('.');
  }

  /** `public`: normalized version without local segment. */
  get public(): string {
    return this.toString().split('+')[0];
  }

  toString(): string {
    let s = this.baseVersion;
    if (this.pre) s += `${this.pre[0]}${this.pre[1]}`;
    if (this.post !== null) s += `.post${this.post}`;
    if (this.dev !== null) s += `.dev${this.dev}`;
    if (this.local) s += `+${this.local}`;
    return s;
  }

  /** Compare with another version: negative, zero or positive. */
  compare(other: Version | string): number {
    const o = typeof other === 'string' ? new Version(other) : other;
    return compareKey(this.key(), o.key());
  }

  equals(other: Version | string): boolean {
    return this.compare(other) === 0;
  }

  /** @internal comparison key (packaging `_cmpkey`). */
  key(): unknown[] {
    const release = [...this.release];
    while (release.length > 1 && release[release.length - 1] === 0) release.pop();
    const NEG = -Infinity;
    const POS = Infinity;
    let pre: unknown;
    if (this.pre === null && this.post === null && this.dev !== null) pre = NEG;
    else if (this.pre === null) pre = POS;
    else pre = [preOrder(this.pre[0]), this.pre[1]];
    const post = this.post === null ? NEG : this.post;
    const dev = this.dev === null ? POS : this.dev;
    const local =
      this.localParts === null
        ? NEG
        : this.localParts.map((p) => (typeof p === 'number' ? [p, ''] : [NEG, p]));
    return [this.epoch, release, pre, post, dev, local];
  }
}

function preOrder(l: string): number {
  return l === 'a' ? 0 : l === 'b' ? 1 : 2;
}

function compareKey(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === -Infinity) return -1;
  if (b === -Infinity) return 1;
  if (a === Infinity) return 1;
  if (b === Infinity) return -1;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = compareKey(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Parse a version, returning null when invalid. */
export function parseVersion(v: string): Version | null {
  try {
    return new Version(v);
  } catch {
    return null;
  }
}

const SPEC_RE = /^\s*(~=|===|==|!=|<=|>=|<|>)\s*(\S+?)\s*$/;

/** One PEP 440 specifier clause (subset of `packaging.specifiers.Specifier`). */
export class Specifier {
  readonly operator: string;
  readonly version: string;

  constructor(spec: string) {
    const m = SPEC_RE.exec(spec);
    if (!m) throw new InvalidSpecifier(`Invalid specifier: ${pyRepr(spec)}`);
    this.operator = m[1];
    this.version = m[2];
    const op = this.operator;
    const v = this.version;
    if (op === '===') return;
    if (op === '==' || op === '!=') {
      const base = v.endsWith('.*') ? v.slice(0, -2) : v;
      if (v.endsWith('.*') && base.includes('+')) throw new InvalidSpecifier(`Invalid specifier: ${pyRepr(spec)}`);
      if (!parseVersion(base)) throw new InvalidSpecifier(`Invalid specifier: ${pyRepr(spec)}`);
      return;
    }
    const parsed = parseVersion(v);
    if (!parsed || v.endsWith('.*') || parsed.local !== null) throw new InvalidSpecifier(`Invalid specifier: ${pyRepr(spec)}`);
    if (op === '~=' && parsed.release.length < 2) throw new InvalidSpecifier(`Invalid specifier: ${pyRepr(spec)}`);
  }

  toString(): string {
    return `${this.operator}${this.version}`;
  }

  contains(item: Version | string): boolean {
    const v = typeof item === 'string' ? parseVersion(item) : item;
    if (!v) return false;
    const op = this.operator;
    if (op === '===') return String(item).toLowerCase() === this.version.toLowerCase();
    if (op === '==' || op === '!=') {
      const eq = this.equal(v);
      return op === '==' ? eq : !eq;
    }
    const spec = new Version(this.version);
    const pub = new Version(v.public);
    if (op === '>=') return pub.compare(spec) >= 0;
    if (op === '<=') return pub.compare(spec) <= 0;
    if (op === '<') {
      if (!(v.compare(spec) < 0)) return false;
      if (!spec.isPrerelease && v.isPrerelease && new Version(v.baseVersion).equals(new Version(spec.baseVersion))) return false;
      return true;
    }
    if (op === '>') {
      if (!(v.compare(spec) > 0)) return false;
      if (!spec.isPostrelease && v.isPostrelease && new Version(v.baseVersion).equals(new Version(spec.baseVersion))) return false;
      if (v.local !== null && new Version(v.baseVersion).equals(new Version(spec.baseVersion))) return false;
      return true;
    }
    if (op === '~=') {
      const prefix = spec.release.slice(0, -1).join('.');
      const epoch = spec.epoch ? `${spec.epoch}!` : '';
      return pub.compare(spec) >= 0 && new Specifier(`==${epoch}${prefix}.*`).contains(v);
    }
    return false;
  }

  private equal(v: Version): boolean {
    if (this.version.endsWith('.*')) {
      const spec = new Version(this.version.slice(0, -2));
      const normalizedProspective = new Version(v.public);
      if (spec.epoch !== normalizedProspective.epoch) return false;
      const specParts = versionSegments(spec);
      const prospectiveParts = versionSegments(normalizedProspective);
      const padded = [...prospectiveParts];
      while (padded.length < specParts.length) padded.push('0');
      return specParts.every((p, i) => padded[i] === p);
    }
    const spec = new Version(this.version);
    const prospective = spec.local === null ? new Version(v.public) : v;
    return prospective.equals(spec);
  }
}

function versionSegments(v: Version): string[] {
  const parts = v.release.map(String);
  if (v.pre) parts.push(`${v.pre[0]}${v.pre[1]}`);
  if (v.post !== null) parts.push(`post${v.post}`);
  if (v.dev !== null) parts.push(`dev${v.dev}`);
  return parts;
}

/** Comma-separated set of specifiers (`packaging.specifiers.SpecifierSet`). */
export class SpecifierSet {
  readonly specs: Specifier[];

  constructor(specifiers = '') {
    this.specs = specifiers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => new Specifier(s));
  }

  /** `contains(version, prereleases=True)` (the project's prerelease policy). */
  contains(item: Version | string, opts: { prereleases?: boolean } = {}): boolean {
    const v = typeof item === 'string' ? parseVersion(item) : item;
    if (!v) return false;
    const pre = opts.prereleases ?? true;
    if (!pre && v.isPrerelease) return false;
    return this.specs.every((s) => s.contains(v));
  }

  toString(): string {
    return this.specs.map(String).sort().join(',');
  }
}

/**
 * Check if `current` satisfies `required` (e.g. `">=0.1.0,<2.0.0"`),
 * allowing prereleases. Invalid version/specifier -> false.
 */
export function versionSatisfies(current: string, required: string): boolean {
  try {
    const v = new Version(current);
    return new SpecifierSet(required).contains(v, { prereleases: true });
  } catch (e) {
    if (e instanceof InvalidVersion || e instanceof InvalidSpecifier) return false;
    throw e;
  }
}
