/**
 * @oakoliver/specify-cli - CLI argument parsing
 *
 * A tiny Typer/Click-like argument parser used by every command adapter.
 *
 * - Options: `--flag`, `--opt VALUE`, `--opt=VALUE`, short aliases (`-f`,
 *   `-fVALUE`, `-f VALUE`, combined boolean shorts `-abc`), repeatable options,
 *   boolean pairs (`--flag/--no-flag`), typed values (string/int/float/choice).
 * - Positional arguments (required/optional/variadic), interspersed with options
 *   like Click; `--` ends option parsing.
 * - `--help` output generated from declared help strings.
 * - Usage errors carry Click's wording and exit code 2.
 * - `dispatchGroup()` handles nested sub-command groups (`catalog list` etc.).
 *
 * @module cli-args
 */

import { CliExit, Console, Panel, console as stdoutConsole, errConsole, escapeMarkup, Table } from './console.js';

// ============================================================================
// Specs
// ============================================================================

export type OptionType = 'boolean' | 'string' | 'int' | 'float' | 'path';

/** Declares an option. */
export interface OptionSpec {
  /** Destination key in the parsed `options` object (e.g. `json`, `dryRun`). */
  name: string;
  /** Flags, e.g. `['--force', '-f']`. The first long flag is the display name. */
  flags: string[];
  /** Negative flags for booleans, e.g. `['--no-color']` (`--color/--no-color`). */
  negFlags?: string[];
  /** Value type (default `'string'`; `'boolean'` flags take no value). */
  type?: OptionType;
  /** Collect every occurrence into an array. */
  multiple?: boolean;
  /** Default value (booleans default to false, multiples to []). */
  default?: unknown;
  /** Help text. */
  help?: string;
  /** Metavar in help (default derived from type: TEXT, INTEGER, FLOAT, PATH). */
  metavar?: string;
  /** Require this option. */
  required?: boolean;
  /** Hide from help. */
  hidden?: boolean;
  /** Allowed values (Click `Choice`). */
  choices?: string[];
  /** Case-insensitive choices. */
  caseSensitive?: boolean;
  /** Show the default in help. */
  showDefault?: boolean;
  /** For `int`/`float`: min/max bounds (Click IntRange). */
  min?: number;
  max?: number;
  /** Eager flag: when present the handler is called before validation (e.g. `--version`). */
  isEager?: boolean;
}

/** Declares a positional argument. */
export interface ArgumentSpec {
  name: string;
  required?: boolean;
  /** Consume all remaining positionals (`nargs=-1`). */
  variadic?: boolean;
  type?: Exclude<OptionType, 'boolean'>;
  default?: unknown;
  help?: string;
  metavar?: string;
  choices?: string[];
  hidden?: boolean;
}

/** A leaf command. */
export interface CommandSpec {
  /** Command name (used in usage lines). */
  name: string;
  help?: string;
  /** Short help used in a group's command list (default: first line of `help`). */
  shortHelp?: string;
  epilog?: string;
  options?: OptionSpec[];
  arguments?: ArgumentSpec[];
  /** Allow unknown options/extra args to pass through into `extra`. */
  allowExtra?: boolean;
  /** Print help when invoked with no args. */
  noArgsIsHelp?: boolean;
  hidden?: boolean;
  deprecated?: boolean;
}

/** Parsed result. */
export interface ParsedArgs {
  options: Record<string, unknown>;
  args: Record<string, unknown>;
  /** Unconsumed tokens when `allowExtra`. */
  extra: string[];
  /** True when `--help` was requested. */
  help: boolean;
  /** Options explicitly provided on the command line (by `name`). */
  provided: Set<string>;
}

// ============================================================================
// Errors
// ============================================================================

/** Click `UsageError` (exit code 2). */
export class UsageError extends Error {
  exitCode = 2;
  /** Suppress the "Usage:/Try" header (Click BadOptionUsage-style errors). */
  noUsage = false;
  constructor(message: string, public command?: CommandSpec, public progName?: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Click `BadParameter` (exit code 2). */
export class BadParameter extends UsageError {
  constructor(message: string, command?: CommandSpec, progName?: string) {
    super(message, command, progName);
    this.name = 'BadParameter';
  }
}

// ============================================================================
// Helpers
// ============================================================================

function displayName(opt: OptionSpec): string {
  return opt.flags.find((f) => f.startsWith('--')) ?? opt.flags[0];
}

function allFlagNames(opt: OptionSpec): string {
  const flags = [...opt.flags];
  if (opt.negFlags?.length) return `${flags.join(' / ')} / ${opt.negFlags.join(' / ')}`;
  return flags.join(' / ');
}

function argName(a: ArgumentSpec): string {
  return a.metavar ?? a.name;
}

function argDisplay(a: ArgumentSpec): string {
  const n = argName(a);
  return (a.required ? `{${n}}` : `[${n}]`) + (a.variadic ? '...' : '');
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** difflib.get_close_matches-ish suggestions (Click uses cutoff 0.6 ratio). */
function closeMatches(word: string, candidates: string[]): string[] {
  const scored = candidates
    .map((c) => ({ c, r: 1 - levenshtein(word, c) / Math.max(word.length, c.length, 1) }))
    .filter((x) => x.r >= 0.6)
    .sort((x, y) => y.r - x.r);
  return scored.map((x) => x.c);
}

function convertValue(
  raw: string,
  type: OptionType | undefined,
  label: string,
  choices: string[] | undefined,
  caseSensitive: boolean,
  bounds: { min?: number; max?: number } = {},
): unknown {
  if (choices?.length) {
    const match = choices.find((c) => (caseSensitive ? c === raw : c.toLowerCase() === raw.toLowerCase()));
    if (match === undefined) {
      const list = choices.map((c) => `'${c}'`).join(', ');
      throw new BadParameter(`Invalid value for ${label}: '${raw}' is not one of ${list}.`);
    }
    return match;
  }
  if (type === 'int') {
    if (!/^[+-]?\d+$/.test(raw.trim())) {
      throw new BadParameter(`Invalid value for ${label}: '${raw}' is not a valid int.`);
    }
    const n = parseInt(raw.trim(), 10);
    checkBounds(n, label, bounds);
    return n;
  }
  if (type === 'float') {
    const n = Number(raw.trim());
    if (raw.trim() === '' || Number.isNaN(n)) {
      throw new BadParameter(`Invalid value for ${label}: '${raw}' is not a valid float.`);
    }
    checkBounds(n, label, bounds);
    return n;
  }
  return raw;
}

function checkBounds(n: number, label: string, { min, max }: { min?: number; max?: number }): void {
  if (min !== undefined && max !== undefined && (n < min || n > max)) {
    throw new BadParameter(`Invalid value for ${label}: ${n} is not in the range ${min}<=x<=${max}.`);
  }
  if (min !== undefined && max === undefined && n < min) {
    throw new BadParameter(`Invalid value for ${label}: ${n} is not in the range x>=${min}.`);
  }
  if (max !== undefined && min === undefined && n > max) {
    throw new BadParameter(`Invalid value for ${label}: ${n} is not in the range x<=${max}.`);
  }
}

const HELP_OPTION: OptionSpec = {
  name: '__help',
  flags: ['--help'],
  type: 'boolean',
  help: 'Show this message and exit.',
};

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse `argv` against `spec`. Throws {@link UsageError} on invalid input.
 * `--help` anywhere (before `--`) sets `help: true` and skips validation.
 */
export function parseArgs(spec: CommandSpec, argv: string[], progName?: string): ParsedArgs {
  const options = spec.options ?? [];
  const byFlag = new Map<string, { opt: OptionSpec; negative: boolean }>();
  for (const opt of [...options, HELP_OPTION]) {
    for (const f of opt.flags) byFlag.set(f, { opt, negative: false });
    for (const f of opt.negFlags ?? []) byFlag.set(f, { opt, negative: true });
  }
  const result: ParsedArgs = { options: {}, args: {}, extra: [], help: false, provided: new Set() };
  for (const opt of options) {
    if (opt.multiple) result.options[opt.name] = Array.isArray(opt.default) ? [...opt.default] : [];
    else if (opt.default !== undefined) result.options[opt.name] = opt.default;
    else result.options[opt.name] = opt.type === 'boolean' ? false : null;
  }
  const positionals: string[] = [];
  const err = (msg: string, noUsage = false): UsageError => {
    const e = new UsageError(msg, spec, progName);
    e.noUsage = noUsage;
    return e;
  };

  const setValue = (opt: OptionSpec, raw: string, label: string): void => {
    let value: unknown;
    try {
      value = convertValue(raw, opt.type, `'${label}'`, opt.choices, opt.caseSensitive ?? true, opt);
    } catch (e) {
      if (e instanceof UsageError) {
        e.command = spec;
        e.progName = progName;
      }
      throw e;
    }
    if (opt.multiple) (result.options[opt.name] as unknown[]).push(value);
    else result.options[opt.name] = value;
    result.provided.add(opt.name);
  };

  let i = 0;
  let endOfOptions = false;
  while (i < argv.length) {
    const token = argv[i];
    i++;
    if (endOfOptions) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      endOfOptions = true;
      continue;
    }
    if (token.startsWith('--') && token.length > 2) {
      const eq = token.indexOf('=');
      const flag = eq >= 0 ? token.slice(0, eq) : token;
      const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
      const hit = byFlag.get(flag);
      if (!hit) {
        if (spec.allowExtra) {
          result.extra.push(token);
          continue;
        }
        const known = [...byFlag.keys()].filter((k) => k.startsWith('--'));
        const sugg = closeMatches(flag, known);
        let msg = `No such option: ${flag}`;
        if (sugg.length === 1) msg += ` Did you mean ${sugg[0]}?`;
        else if (sugg.length > 1) msg += ` (Possible options: ${sugg.slice(0, 3).join(', ')})`;
        throw err(msg);
      }
      const { opt, negative } = hit;
      if (opt === HELP_OPTION) {
        result.help = true;
        continue;
      }
      if (opt.type === 'boolean') {
        if (inline !== undefined) throw err(`Option '${flag}' does not take a value.`, true);
        if (opt.multiple) (result.options[opt.name] as unknown[]).push(!negative);
        else result.options[opt.name] = !negative;
        result.provided.add(opt.name);
        continue;
      }
      let value = inline;
      if (value === undefined) {
        if (i >= argv.length) throw err(`Option '${flag}' requires an argument.`, true);
        value = argv[i];
        i++;
      }
      setValue(opt, value, flag);
      continue;
    }
    if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      // Short option(s)
      let j = 1;
      while (j < token.length) {
        const flag = '-' + token[j];
        const hit = byFlag.get(flag);
        if (!hit) {
          if (spec.allowExtra) {
            result.extra.push(token);
            break;
          }
          throw err(`No such option: ${flag}`);
        }
        const { opt, negative } = hit;
        if (opt.type === 'boolean') {
          if (opt.multiple) (result.options[opt.name] as unknown[]).push(!negative);
          else result.options[opt.name] = !negative;
          result.provided.add(opt.name);
          j++;
          continue;
        }
        let value = token.slice(j + 1);
        if (!value) {
          if (i >= argv.length) throw err(`Option '${flag}' requires an argument.`, true);
          value = argv[i];
          i++;
        }
        setValue(opt, value, flag);
        break;
      }
      continue;
    }
    positionals.push(token);
  }

  if (result.help) return result;

  // Assign positionals
  const argSpecs = spec.arguments ?? [];
  let p = 0;
  for (let ai = 0; ai < argSpecs.length; ai++) {
    const a = argSpecs[ai];
    const label = `'${argName(a)}'`;
    if (a.variadic) {
      const remainingFixed = argSpecs.slice(ai + 1).filter((x) => !x.variadic).length;
      const take = Math.max(0, positionals.length - p - remainingFixed);
      const vals = positionals.slice(p, p + take).map((v) =>
        convertValue(v, a.type, label, a.choices, true),
      );
      p += take;
      if (!vals.length && a.required) throw err(`Missing argument ${label}.`);
      result.args[a.name] = vals.length ? vals : Array.isArray(a.default) ? a.default : [];
      continue;
    }
    if (p < positionals.length) {
      try {
        result.args[a.name] = convertValue(positionals[p], a.type, label, a.choices, true);
      } catch (e) {
        if (e instanceof UsageError) {
          e.command = spec;
          e.progName = progName;
        }
        throw e;
      }
      p++;
    } else if (a.required) {
      throw err(`Missing argument ${label}.`);
    } else {
      result.args[a.name] = a.default ?? null;
    }
  }
  if (p < positionals.length) {
    const rest = positionals.slice(p);
    if (spec.allowExtra) {
      result.extra.push(...rest);
    } else {
      throw err(`Got unexpected extra argument(s) (${rest.join(' ')})`);
    }
  }
  for (const opt of options) {
    if (opt.required && !result.provided.has(opt.name)) {
      throw err(`Missing option '${displayName(opt)}'.`);
    }
  }
  return result;
}

// ============================================================================
// Help / usage rendering
// ============================================================================

function usageLine(spec: CommandSpec, progName: string, isGroup = false): string {
  const parts = [progName, '[OPTIONS]'];
  if (isGroup) {
    parts.push('COMMAND [ARGS]...');
  } else {
    for (const a of spec.arguments ?? []) {
      if (a.hidden) continue;
      parts.push(argDisplay(a));
    }
  }
  return parts.join(' ');
}

/** `inspect.cleandoc`-style dedent: keeps relative indentation (e.g. Examples blocks). */
function dedentHelp(text: string): string[] {
  const lines = text.replace(/\s+$/, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  const rest = lines.slice(1).filter((l) => l.trim());
  const indent = rest.length ? Math.min(...rest.map((l) => l.length - l.trimStart().length)) : 0;
  return lines.map((l, i) => (i === 0 ? l.trim() : l.slice(Math.min(indent, l.length - l.trimStart().length)).replace(/\s+$/, '')));
}

function metavarFor(opt: OptionSpec): string {
  if (opt.type === 'boolean') return '';
  if (opt.metavar) return opt.metavar;
  if (opt.choices?.length) return `[${opt.choices.join('|')}]`;
  if (opt.type === 'int') return '<int>';
  if (opt.type === 'float') return '<float>';
  if (opt.type === 'path') return '<path>';
  return '<str>';
}

function panel(title: string, table: Table): Panel {
  return new Panel(table, { title, titleAlign: 'left', borderStyle: 'dim', padding: [0, 1] });
}

/** Render Typer-style `--help` output for a command. */
export function formatHelp(spec: CommandSpec, progName: string, con: Console = stdoutConsole): string {
  const parts: string[] = [];
  const out = (...objs: Parameters<Console['renderToString']>[0]): void => {
    parts.push(con.renderToString(objs));
  };
  out('');
  out(` [yellow]Usage:[/yellow] [bold]${escapeMarkup(usageLine(spec, progName))}[/bold]`);
  out('');
  if (spec.help) {
    for (const line of dedentHelp(spec.help)) out(` ${escapeMarkup(line)}`);
    out('');
  }
  const args = (spec.arguments ?? []).filter((a) => !a.hidden);
  if (args.length) {
    const t = Table.grid({ padding: [0, 1] });
    t.addColumn('', { style: 'red', noWrap: true, width: 1 });
    t.addColumn('', { style: 'bold cyan', noWrap: true });
    t.addColumn('', { style: 'bold yellow', noWrap: true });
    t.addColumn('');
    for (const a of args) {
      const mv = a.type === 'int' ? '<int>' : a.type === 'float' ? '<float>' : a.type === 'path' ? '<path>' : '<str>';
      let help = escapeMarkup(a.help ?? '');
      if (a.default !== undefined && a.default !== null && !a.required) help += ` [dim]\\[default: ${escapeMarkup(String(a.default))}][/dim]`;
      if (a.required) help += ' [red]\\[required][/red]';
      t.addRow(a.required ? '*' : '', argName(a), mv + (a.variadic ? '...' : ''), help.trim());
    }
    out(panel('Arguments', t));
  }
  const opts = [...(spec.options ?? []).filter((o) => !o.hidden), HELP_OPTION];
  const anyRequired = opts.some((o) => o.required);
  const t = Table.grid({ padding: [0, 1] });
  if (anyRequired) t.addColumn('', { style: 'red', noWrap: true, width: 1 });
  t.addColumn('', { style: 'bold cyan', noWrap: true });
  t.addColumn('', { style: 'bold green', noWrap: true });
  t.addColumn('', { style: 'bold yellow', noWrap: true });
  t.addColumn('');
  for (const o of opts) {
    const longs = o.flags.filter((f) => f.startsWith('--'));
    const shorts = o.flags.filter((f) => !f.startsWith('--'));
    let long = longs.join(',');
    if (o.negFlags?.length) long += `/${o.negFlags.join(',')}`;
    let help = escapeMarkup(o.help ?? '');
    const showDefault = o.showDefault ?? (o.default !== undefined && o.default !== null && o.default !== false);
    if (showDefault && o.default !== undefined && !(Array.isArray(o.default) && !o.default.length)) {
      const d = Array.isArray(o.default) ? o.default.join(', ') : String(o.default);
      help += ` [dim]\\[default: ${escapeMarkup(d)}][/dim]`;
    }
    if (o.required) help += ' [red]\\[required][/red]';
    const cells = [long, shorts.join(','), escapeMarkup(metavarFor(o)), help.trim()];
    if (anyRequired) cells.unshift(o.required ? '*' : '');
    t.addRow(...cells);
  }
  out(panel('Options', t));
  if (spec.epilog) out(` ${spec.epilog}`);
  return parts.join('');
}

function formatUsageError(e: UsageError, progName: string, con: Console): string {
  const cmd = e.command;
  let s = '';
  if (cmd && !e.noUsage) {
    s += con.renderToString([`Usage: ${escapeMarkup(usageLine(cmd, progName, !!(cmd as GroupSpec).commands))}`]);
    s += con.renderToString([`Try [blue]'${escapeMarkup(progName)} --help'[/blue] for help.`]);
  }
  s += con.renderToString([
    new Panel(escapeMarkup(e.message), { title: 'Error', titleAlign: 'left', borderStyle: 'red' }),
  ]);
  return s;
}

/** Print a usage error the way Typer does (to stderr) and return exit code 2. */
export function reportUsageError(e: UsageError, progName: string): number {
  errConsole.write(formatUsageError(e, e.progName ?? progName, errConsole));
  return e.exitCode;
}

// ============================================================================
// Command runner
// ============================================================================

/**
 * Parse args, handle `--help` and usage errors, run `handler`, and convert
 * thrown {@link CliExit} into an exit code (like Typer's main loop).
 *
 * @param progName Full program path shown in usage, e.g. `specify workflow run`.
 */
export async function runCommand(
  spec: CommandSpec,
  argv: string[],
  progName: string,
  handler: (parsed: ParsedArgs) => Promise<number | void> | number | void,
): Promise<number> {
  if (spec.noArgsIsHelp && argv.length === 0) {
    stdoutConsole.write(formatHelp(spec, progName));
    return 0;
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(spec, argv, progName);
  } catch (e) {
    if (e instanceof UsageError) return reportUsageError(e, progName);
    throw e;
  }
  if (parsed.help) {
    stdoutConsole.write(formatHelp(spec, progName));
    return 0;
  }
  return runHandled(() => handler(parsed), progName);
}

/** Run a function converting CliExit / CliAbort / UsageError into exit codes. */
export async function runHandled(fn: () => Promise<number | void> | number | void, progName = 'specify'): Promise<number> {
  try {
    const code = await fn();
    return typeof code === 'number' ? code : 0;
  } catch (e) {
    if (e instanceof CliExit) {
      if (e.name === 'CliAbort') errConsole.write('Aborted!\n');
      return e.code;
    }
    if (e instanceof UsageError) return reportUsageError(e, progName);
    throw e;
  }
}

// ============================================================================
// Groups
// ============================================================================

/** A sub-command entry of a group. */
export interface SubcommandDef {
  name: string;
  help?: string;
  hidden?: boolean;
  aliases?: string[];
  /** Runs with the remaining args (after the sub-command name). */
  run: (args: string[], progName: string) => Promise<number>;
}

/** A group of sub-commands (Typer app). */
export interface GroupSpec extends CommandSpec {
  commands: SubcommandDef[];
}

/** Render help for a group. */
export function formatGroupHelp(group: GroupSpec, progName: string, con: Console = stdoutConsole): string {
  const parts: string[] = [];
  const out = (...objs: Parameters<Console['renderToString']>[0]): void => {
    parts.push(con.renderToString(objs));
  };
  out('');
  out(` [yellow]Usage:[/yellow] [bold]${escapeMarkup(usageLine(group, progName, true))}[/bold]`);
  out('');
  if (group.help) {
    for (const line of dedentHelp(group.help)) out(` ${escapeMarkup(line)}`);
    out('');
  }
  const ot = Table.grid({ padding: [0, 1] });
  ot.addColumn('', { style: 'bold cyan', noWrap: true });
  ot.addColumn('');
  for (const o of [...(group.options ?? []).filter((x) => !x.hidden), HELP_OPTION]) {
    ot.addRow(allFlagNames(o), escapeMarkup(o.help ?? ''));
  }
  out(panel('Options', ot));
  const ct = Table.grid({ padding: [0, 1] });
  ct.addColumn('', { style: 'bold cyan', noWrap: true });
  ct.addColumn('');
  for (const c of group.commands.filter((x) => !x.hidden)) {
    ct.addRow(c.name, escapeMarkup((c.help ?? '').split('\n')[0]));
  }
  out(panel('Commands', ct));
  return parts.join('');
}

/**
 * Dispatch `args` to a sub-command of `group`. Handles `--help`, missing and
 * unknown commands (Click wording, exit 2). Group-level options are not
 * supported beyond `--help` (none exist upstream on sub-apps).
 */
export async function dispatchGroup(group: GroupSpec, args: string[], progName: string): Promise<number> {
  if (!args.length) {
    if (group.noArgsIsHelp) {
      stdoutConsole.write(formatGroupHelp(group, progName));
      return 0;
    }
    return reportUsageError(new UsageError('Missing command.', group, progName), progName);
  }
  const [first, ...rest] = args;
  if (first === '--help') {
    stdoutConsole.write(formatGroupHelp(group, progName));
    return 0;
  }
  if (first.startsWith('-')) {
    return reportUsageError(new UsageError(`No such option: ${first}`, group, progName), progName);
  }
  const cmd = group.commands.find((c) => c.name === first || c.aliases?.includes(first));
  if (!cmd) {
    const msg = `No such command '${first}'.`;
    return reportUsageError(new UsageError(msg, group, progName), progName);
  }
  return runHandled(() => cmd.run(rest, `${progName} ${cmd.name}`), `${progName} ${cmd.name}`);
}

/** Convenience: make a {@link SubcommandDef} from a spec + handler. */
export function defineCommand(
  spec: CommandSpec,
  handler: (parsed: ParsedArgs) => Promise<number | void> | number | void,
): SubcommandDef {
  return {
    name: spec.name,
    help: spec.shortHelp ?? spec.help,
    hidden: spec.hidden,
    run: (args, progName) => runCommand(spec, args, progName, handler),
  };
}

