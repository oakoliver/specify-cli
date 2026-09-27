/**
 * @oakoliver/specify-cli - Workflow Step Base Classes
 *
 * Port of ``specify_cli/workflows/base.py``:
 * - ``StepBase`` — abstract base every step type must implement.
 * - ``StepContext`` — execution context passed to each step.
 * - ``StepResult`` — return value from step execution.
 *
 * Also hosts the small Python-semantics helpers (``pyRepr``, ``pyTypeName``,
 * ``pyStr``, ``pyTruthy``, ``pyEquals``...) that the workflow engine uses to
 * keep user-facing messages and expression semantics identical to upstream.
 *
 * @module workflows/base
 */

import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter as pathDelimiter, join as pathJoin } from 'node:path';

// ============================================================================
// Status enums
// ============================================================================

/** Status of a step execution. */
export const StepStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  PAUSED: 'paused',
} as const;
export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

/** Status of a workflow run. */
export const RunStatus = {
  CREATED: 'created',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

const RUN_STATUS_VALUES = new Set<string>(Object.values(RunStatus));

/** Equivalent of ``RunStatus(value)`` — raises for unknown values. */
export function toRunStatus(value: unknown): RunStatus {
  if (typeof value === 'string' && RUN_STATUS_VALUES.has(value)) return value as RunStatus;
  throw new ValueError(`${pyRepr(value)} is not a valid RunStatus`);
}

// ============================================================================
// Python-compatible errors
// ============================================================================

/** Mirrors Python's ``ValueError``. */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/** Mirrors Python's ``KeyError`` (message is the plain text, not repr'd). */
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}

/** Mirrors Python's ``FileNotFoundError``. */
export class FileNotFoundError extends Error {
  code = 'ENOENT';
  constructor(message: string) {
    super(message);
    this.name = 'FileNotFoundError';
  }
}

/** Mirrors Python's ``KeyboardInterrupt`` (used for Ctrl-C at prompts). */
export class KeyboardInterrupt extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'KeyboardInterrupt';
  }
}

// ============================================================================
// Python value semantics helpers
// ============================================================================

/** Generic mapping type used for YAML/JSON-shaped data. */
export type Dict = Record<string, unknown>;

/** ``isinstance(value, dict)`` for YAML/JSON-shaped data. */
export function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** ``isinstance(value, int) and not isinstance(value, bool)``. */
export function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** ``isinstance(value, (int, float)) and not isinstance(value, bool)``. */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

/** Python ``type(value).__name__`` for YAML/JSON-shaped values. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'bigint') return 'int';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'function') return 'function';
  return 'dict';
}

function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  if (Number.isInteger(value)) {
    // JS numbers cannot tell 1.0 from 1; ints render as ints.
    if (Math.abs(value) >= 1e16) {
      return value.toExponential().replace(/e\+?/, 'e+').replace('e+-', 'e-');
    }
    return String(value);
  }
  const s = String(value);
  if (s.includes('e')) {
    // JS: 1e-7 / 1.5e+21 ; Python: 1e-07 / 1.5e+21
    return s.replace(/e([+-])(\d)$/, 'e$10$2');
  }
  return s;
}

function pyStrRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + quote;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || (code >= 0x7f && code <= 0xa0) || code === 0xad) {
      out += '\\x' + code.toString(16).padStart(2, '0');
    } else if (code === 0x2028 || code === 0x2029) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else out += ch;
  }
  return out + quote;
}

/** Python ``repr(value)`` for YAML/JSON-shaped values. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pyFloatRepr(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return pyStrRepr(value);
  if (Array.isArray(value)) return '[' + value.map((v) => pyRepr(v)).join(', ') + ']';
  if (isDict(value)) {
    return (
      '{' +
      Object.entries(value)
        .map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`)
        .join(', ') +
      '}'
    );
  }
  return String(value);
}

/** Python ``str(value)``. */
export function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  return pyRepr(value);
}

/** Python ``bool(value)``. */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function asNumeric(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

/** Python ``a == b`` for YAML/JSON-shaped values. */
export function pyEquals(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  const na = asNumeric(a);
  const nb = asNumeric(b);
  if (na !== null && nb !== null) return na === nb;
  if (a === null || b === null) return a === b;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => pyEquals(v, b[i]));
  }
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && pyEquals(a[k], b[k]));
  }
  return a === b;
}

/** Python ``left in right`` — throws ``TypeError`` where Python would. */
export function pyContains(right: unknown, left: unknown): boolean {
  if (typeof right === 'string') {
    if (typeof left !== 'string') {
      throw new TypeError(`'in <string>' requires string as left operand, not ${pyTypeName(left)}`);
    }
    return right.includes(left);
  }
  if (Array.isArray(right)) return right.some((v) => pyEquals(v, left));
  if (isDict(right)) {
    if (Array.isArray(left) || isDict(left)) {
      throw new TypeError(`unhashable type: '${pyTypeName(left)}'`);
    }
    if (typeof left === 'string') return Object.prototype.hasOwnProperty.call(right, left);
    if (typeof left === 'number') return Object.prototype.hasOwnProperty.call(right, String(left));
    return false;
  }
  throw new TypeError(`argument of type '${pyTypeName(right)}' is not iterable`);
}

/**
 * Python three-way ordering comparison. Returns negative/zero/positive, or
 * throws ``TypeError`` for incomparable operand types (as Python does).
 */
export function pyCompare(a: unknown, b: unknown): number {
  const na = asNumeric(a);
  const nb = asNumeric(b);
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (!pyEquals(a[i], b[i])) return pyCompare(a[i], b[i]);
    }
    return a.length - b.length;
  }
  throw new TypeError(
    `'<' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`,
  );
}

/** ``int(text)`` semantics for a string (returns ``null`` on ValueError). */
export function pyParseInt(text: string): number | null {
  const s = text.trim();
  if (!/^[+-]?\d+(?:_\d+)*$/.test(s)) return null;
  return parseInt(s.replace(/_/g, ''), 10);
}

/** ``float(text)`` semantics for a string (returns ``null`` on ValueError). */
export function pyParseFloat(text: string): number | null {
  const s = text.trim();
  if (/^[+-]?(inf|infinity)$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(s)) return NaN;
  if (!/^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/.test(s)) {
    return null;
  }
  return parseFloat(s.replace(/_/g, ''));
}

/** Shallow ``dict.get(key, default)`` helper for ``Dict`` values. */
export function dget(obj: Dict, key: string, fallback: unknown = undefined): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

/** ``key in obj`` for ``Dict`` values. */
export function dhas(obj: Dict, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Error message text for any thrown value (``str(exc)``). */
export function errorMessage(exc: unknown): string {
  if (exc instanceof Error) return exc.message;
  return String(exc);
}

// ============================================================================
// StepContext / StepResult
// ============================================================================

/** Constructor fields accepted by {@link StepContext}. */
export interface StepContextInit {
  inputs?: Dict;
  steps?: Record<string, Dict>;
  item?: unknown;
  insideFanOut?: boolean;
  fanIn?: Dict;
  defaultIntegration?: unknown;
  defaultModel?: unknown;
  defaultOptions?: unknown;
  projectRoot?: string | null;
  runId?: string | null;
  isResume?: boolean;
  workflowDir?: string | null;
}

/**
 * Execution context passed to each step.
 *
 * Contains everything the step needs to resolve expressions, dispatch
 * commands, and record results.
 */
export class StepContext {
  /** Resolved workflow inputs (from user prompts / defaults). */
  inputs: Dict;
  /**
   * Accumulated step results keyed by step ID. Each entry is the dict the
   * engine persists per step: ``{type, integration, model, options, input,
   * output, status}``.
   */
  steps: Record<string, Dict>;
  /** Current fan-out item (set only inside fan-out iterations). */
  item: unknown;
  /** Whether the current step is executing inside a fan-out template. */
  insideFanOut: boolean;
  /** Fan-in aggregated results (set only for fan-in steps). */
  fanIn: Dict | null;
  /** Workflow-level default integration key. */
  defaultIntegration: unknown;
  /** Workflow-level default model. */
  defaultModel: unknown;
  /** Workflow-level default options. */
  defaultOptions: unknown;
  /** Project root path. */
  projectRoot: string | null;
  /** Current run ID. */
  runId: string | null;
  /** Whether the engine is re-executing the current step during resume. */
  isResume: boolean;
  /** Source directory of the workflow definition file. */
  workflowDir: string | null;

  constructor(init: StepContextInit = {}) {
    this.inputs = init.inputs ?? {};
    this.steps = init.steps ?? {};
    this.item = init.item ?? null;
    this.insideFanOut = init.insideFanOut ?? false;
    this.fanIn = init.fanIn ?? {};
    this.defaultIntegration = init.defaultIntegration ?? null;
    this.defaultModel = init.defaultModel ?? null;
    this.defaultOptions = init.defaultOptions ?? {};
    this.projectRoot = init.projectRoot ?? null;
    this.runId = init.runId ?? null;
    this.isResume = init.isResume ?? false;
    this.workflowDir = init.workflowDir ?? null;
  }

  /** ``dataclasses.replace(context, **changes)`` — shallow copy (shares ``steps``). */
  replace(changes: StepContextInit): StepContext {
    return new StepContext({
      inputs: this.inputs,
      steps: this.steps,
      item: this.item,
      insideFanOut: this.insideFanOut,
      fanIn: this.fanIn ?? undefined,
      defaultIntegration: this.defaultIntegration,
      defaultModel: this.defaultModel,
      defaultOptions: this.defaultOptions,
      projectRoot: this.projectRoot,
      runId: this.runId,
      isResume: this.isResume,
      workflowDir: this.workflowDir,
      ...changes,
    });
  }
}

/** Constructor fields accepted by {@link StepResult}. */
export interface StepResultInit {
  status?: StepStatus;
  output?: Dict;
  nextSteps?: Dict[];
  error?: string | null;
}

/** Return value from a step execution. */
export class StepResult {
  /** Step status. */
  status: StepStatus;
  /** Output data (stored as ``steps.<id>.output``). */
  output: Dict;
  /** Nested steps to execute (for control-flow steps like if/then). */
  nextSteps: Dict[];
  /** Error message if step failed. */
  error: string | null;

  constructor(init: StepResultInit = {}) {
    this.status = init.status ?? StepStatus.COMPLETED;
    this.output = init.output ?? {};
    this.nextSteps = init.nextSteps ?? [];
    this.error = init.error ?? null;
  }
}

// ============================================================================
// StepBase
// ============================================================================

/**
 * Abstract base class for workflow step types.
 *
 * Every step type — built-in or extension-provided — implements this
 * interface and registers in ``STEP_REGISTRY``.
 *
 * ``STEP_REGISTRY`` holds a single shared instance per type, so a concurrent
 * ``fan-out`` (``max_concurrency > 1``) can invoke ``execute`` on the same
 * instance several times at once. Implementations must be stateless — derive
 * all per-run state from the ``config`` and ``context`` arguments.
 */
export abstract class StepBase {
  /** Matches the ``type:`` value in workflow YAML. */
  static typeKey = '';

  /** Instance accessor for the class-level ``typeKey``. */
  get typeKey(): string {
    return (this.constructor as typeof StepBase).typeKey;
  }

  /**
   * Execute the step with the given config and context.
   *
   * Returns a StepResult with status, output data, and optional nested steps.
   */
  abstract execute(config: Dict, context: StepContext): StepResult | Promise<StepResult>;

  /**
   * Validate step configuration and return a list of error messages.
   *
   * An empty list means the configuration is valid.
   */
  validate(config: Dict): string[] {
    const errors: string[] = [];
    if (!dhas(config, 'id')) errors.push("Step is missing required 'id' field.");
    return errors;
  }

  /** Return whether this step can be resumed from the given state. */
  canResume(_state: Dict): boolean {
    return true;
  }
}

/** ``config.get('id', '?')`` rendered with ``!r`` — used by nearly every step message. */
export function stepIdRepr(config: Dict): string {
  return pyRepr(dget(config, 'id', '?'));
}

// ============================================================================
// Executable lookup (shutil.which)
// ============================================================================

/** Port of ``shutil.which`` — returns the absolute path of *cmd* or ``null``. */
export function which(cmd: string): string | null {
  if (!cmd) return null;
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const isExecutable = (p: string): boolean => {
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
  const candidatesFor = (base: string): string[] => {
    if (!isWin) return [base];
    const lower = base.toLowerCase();
    if (exts.some((e) => lower.endsWith(e.toLowerCase()))) return [base];
    return exts.map((e) => base + e);
  };
  if (cmd.includes('/') || (isWin && cmd.includes('\\'))) {
    for (const c of candidatesFor(cmd)) if (isExecutable(c)) return c;
    return null;
  }
  const dirs = (process.env.PATH || '').split(pathDelimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const c of candidatesFor(pathJoin(dir, cmd))) if (isExecutable(c)) return c;
  }
  return null;
}

// ============================================================================
// Process I/O routing
// ============================================================================

/**
 * Process-wide I/O routing flags. ``stdoutToStderr`` is set while
 * ``specify workflow run/resume --json`` executes a run, so steps that spawn
 * subprocesses inheriting stdout (the prompt step) route them onto stderr —
 * the TypeScript equivalent of upstream's fd-level ``dup2(2, 1)`` redirect.
 */
export const runtimeIO = { stdoutToStderr: false };

/** Normalize subprocess text output the way Python's ``text=True`` does. */
export function universalNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// ============================================================================
// JSON / time helpers (Python-compatible serialization)
// ============================================================================

function pyJsonScalar(value: unknown): string {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
  }
  const text = JSON.stringify(value === undefined ? null : value);
  return text === undefined ? 'null' : text;
}

function pyJsonInner(value: unknown, indent: number | null, level: number): string {
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (indent === null) return '[' + value.map((v) => pyJsonInner(v, indent, level + 1)).join(', ') + ']';
    const pad = ' '.repeat(indent * (level + 1));
    const end = ' '.repeat(indent * level);
    return '[\n' + value.map((v) => pad + pyJsonInner(v, indent, level + 1)).join(',\n') + '\n' + end + ']';
  }
  if (isDict(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const render = ([k, v]: [string, unknown]): string =>
      `${JSON.stringify(k)}: ${pyJsonInner(v, indent, level + 1)}`;
    if (indent === null) return '{' + entries.map(render).join(', ') + '}';
    const pad = ' '.repeat(indent * (level + 1));
    const end = ' '.repeat(indent * level);
    return '{\n' + entries.map((e) => pad + render(e)).join(',\n') + '\n' + end + '}';
  }
  return pyJsonScalar(value);
}

/**
 * Serialize like Python ``json.dumps(data, indent=indent)`` (default
 * separators, ``ensure_ascii=True``).
 */
export function pyJsonDumps(data: unknown, indent: number | null = null): string {
  return pyJsonInner(data, indent, 0).replace(
    /[\u0080-￿]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
}

/** Python ``datetime.now(timezone.utc).isoformat()``. */
export function utcIsoNow(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `.${pad(d.getUTCMilliseconds() * 1000, 6)}+00:00`
  );
}
