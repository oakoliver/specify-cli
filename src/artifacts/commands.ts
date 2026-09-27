/**
 * @oakoliver/specify-cli - ``specify artifact`` CLI adapter
 *
 * Port of spec-kit v1.0.12 ``specify_cli/artifacts/_commands.py``,
 * ``command_list.py``, ``command_info.py`` and ``command_lookup.py``.
 *
 * Every subcommand requires ``--json`` for now (exit 2 otherwise). Failures are
 * reported as a ``{"error": "..."}`` JSON envelope on stderr with exit code 1
 * and an untouched stdout.
 *
 * @module artifacts/commands
 */

import { existsSync, statSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';

import { PresetError } from '../presets/manifest.js';
import { pyJsonDumps, pyRepr } from '../events/py-compat.js';

import { ArtifactCatalog } from './catalog.js';
import { ArtifactError, ArtifactResolutionError, NotASpecKitProjectError, type ArtifactKind } from './models.js';
import { isOSError } from './resolution.js';

// ============================================================================
// Registration metadata
// ============================================================================

/** Registered subcommands, in stable order (mirrors ``artifact_app.registered_commands``). */
export const ARTIFACT_COMMANDS = ['list', 'info', 'lookup'] as const;

const GROUP_HELP = `                                                                                
 Usage: specify artifact [OPTIONS] COMMAND [ARGS]...                            
                                                                                
 Introspect commands, templates, scripts, and hooks Spec Kit exposes.           
                                                                                
╭─ Options ────────────────────────────────────────────────────────────────────╮
│ --help          Show this message and exit.                                  │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ Commands ───────────────────────────────────────────────────────────────────╮
│ list    List every command, template, script, and hook Spec Kit exposes.     │
│ info    Show one artifact and its full composition stack.                    │
│ lookup  Resolve a stack lookupId to its effective preset or extension        │
│         contribution.                                                        │
╰──────────────────────────────────────────────────────────────────────────────╯

`;

const LIST_HELP = `                                                                                
 Usage: specify artifact list [OPTIONS]                                         
                                                                                
 List every command, template, script, and hook Spec Kit exposes.               
                                                                                
╭─ Options ────────────────────────────────────────────────────────────────────╮
│ --json          Emit the inventory as a JSON array on stdout.                │
│ --help          Show this message and exit.                                  │
╰──────────────────────────────────────────────────────────────────────────────╯

`;

const INFO_HELP = `                                                                                
 Usage: specify artifact info [OPTIONS] {name}                                  
                                                                                
 Show one artifact and its full composition stack.                              
                                                                                
╭─ Arguments ──────────────────────────────────────────────────────────────────╮
│ *    name      <str>  Artifact name, optionally 'kind:name'. [required]      │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ Options ────────────────────────────────────────────────────────────────────╮
│ --json               Emit the composition stack as a JSON object on stdout.  │
│ --kind        <str>  Narrow the lookup to one artifact family                │
│                      (command/template/script/hook).                         │
│ --help               Show this message and exit.                             │
╰──────────────────────────────────────────────────────────────────────────────╯

`;

const LOOKUP_HELP = `                                                                                
 Usage: specify artifact lookup [OPTIONS] {lookup_id}                           
                                                                                
 Resolve a stack lookupId to its effective preset or extension contribution.    
                                                                                
╭─ Arguments ──────────────────────────────────────────────────────────────────╮
│ *    lookup_id      <str>  Contribution lookupId from an artifact stack.     │
│                            [required]                                        │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ Options ────────────────────────────────────────────────────────────────────╮
│ --json          Emit the validated manifest contribution used by Spec Kit as │
│                 JSON.                                                        │
│ --help          Show this message and exit.                                  │
╰──────────────────────────────────────────────────────────────────────────────╯

`;

// ============================================================================
// Shared infrastructure
// ============================================================================

export interface ArtifactCommandIO {
  writeOut(text: string): void;
  writeErr(text: string): void;
  cwd(): string;
  env(name: string): string | undefined;
}

export const defaultArtifactIO: ArtifactCommandIO = {
  writeOut: (text) => {
    process.stdout.write(text);
  },
  writeErr: (text) => {
    process.stderr.write(text);
  },
  cwd: () => process.cwd(),
  env: (name) => process.env[name],
};

class ExitCode extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Return the project root without emitting Rich output on failure
 * (``_require_specify_project`` with its output suppressed). Honors the
 * ``SPECIFY_INIT_DIR`` override; any failure becomes ``NotASpecKitProjectError``.
 */
export function resolveProjectRoot(io: ArtifactCommandIO = defaultArtifactIO): string {
  const raw = io.env('SPECIFY_INIT_DIR') ?? '';
  if (raw) {
    const initRoot = resolvePath(io.cwd(), raw);
    if (!isDirectory(initRoot) || !isDirectory(join(initRoot, '.specify'))) throw new NotASpecKitProjectError();
    return initRoot;
  }
  const projectRoot = io.cwd();
  if (existsSync(join(projectRoot, '.specify')) && isDirectory(join(projectRoot, '.specify'))) return projectRoot;
  throw new NotASpecKitProjectError();
}

/** Write ``{"error": "..."}`` to stderr and exit with code 1. */
function emitErrorAndExit(io: ArtifactCommandIO, exc: ArtifactError): never {
  io.writeErr(pyJsonDumps({ error: exc.message }, { ensureAscii: false }) + '\n');
  throw new ExitCode(1);
}

/** Enforce the opt-in ``--json`` contract shared by artifact commands. */
function requireJsonFlag(io: ArtifactCommandIO, jsonFlag: boolean): void {
  if (jsonFlag) return;
  io.writeErr('specify artifact requires --json for now; text output is not yet implemented.\n');
  throw new ExitCode(2);
}

function handleDomainError(io: ArtifactCommandIO, e: unknown): never {
  if (e instanceof ArtifactError) emitErrorAndExit(io, e);
  if (e instanceof PresetError || isOSError(e)) emitErrorAndExit(io, new ArtifactResolutionError());
  throw e;
}

function renderJson(payload: unknown): string {
  return pyJsonDumps(payload, { indent: 2, sortKeys: true, ensureAscii: false });
}

function usageError(io: ArtifactCommandIO, usage: string, helpCmd: string, message: string): never {
  io.writeErr(
    `Usage: ${usage}\n` +
      `Try '${helpCmd} --help' for help.\n` +
      '╭─ Error ──────────────────────────────────────────────────────────────────────╮\n' +
      `│ ${message.padEnd(76)} │\n` +
      '╰──────────────────────────────────────────────────────────────────────────────╯\n',
  );
  throw new ExitCode(2);
}

interface ParsedArgs {
  json: boolean;
  kind: string | null;
  positionals: string[];
  help: boolean;
}

function parseArgs(
  io: ArtifactCommandIO,
  args: string[],
  opts: { allowKind: boolean; usage: string; helpCmd: string },
): ParsedArgs {
  const parsed: ParsedArgs = { json: false, kind: null, positionals: [], help: false };
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith('-') && arg.length > 1) {
      if (arg === '--help' || arg === '-h') {
        parsed.help = true;
        continue;
      }
      if (arg === '--json') {
        parsed.json = true;
        continue;
      }
      if (opts.allowKind && (arg === '--kind' || arg.startsWith('--kind='))) {
        if (arg === '--kind') {
          if (i + 1 >= args.length) usageError(io, opts.usage, opts.helpCmd, "Option '--kind' requires an argument.");
          parsed.kind = args[++i]!;
        } else {
          parsed.kind = arg.slice('--kind='.length);
        }
        continue;
      }
      usageError(io, opts.usage, opts.helpCmd, `No such option: ${arg}`);
    }
    parsed.positionals.push(arg);
  }
  return parsed;
}

// ============================================================================
// Subcommands
// ============================================================================

function artifactList(io: ArtifactCommandIO, args: string[]): void {
  const usage = 'specify artifact list [OPTIONS]';
  const parsed = parseArgs(io, args, { allowKind: false, usage, helpCmd: 'specify artifact list' });
  if (parsed.help) {
    io.writeOut(LIST_HELP);
    return;
  }
  if (parsed.positionals.length) {
    usageError(io, usage, 'specify artifact list', `Got unexpected extra argument(s) (${parsed.positionals.join(' ')})`);
  }
  requireJsonFlag(io, parsed.json);
  let rows: Array<Record<string, unknown>>;
  try {
    const root = resolveProjectRoot(io);
    rows = new ArtifactCatalog(root).listArtifactsWithStack();
  } catch (e) {
    handleDomainError(io, e);
  }
  io.writeOut(renderJson(rows));
  io.writeOut('\n');
}

function artifactInfo(io: ArtifactCommandIO, args: string[]): void {
  const usage = 'specify artifact info [OPTIONS] {name}';
  const parsed = parseArgs(io, args, { allowKind: true, usage, helpCmd: 'specify artifact info' });
  if (parsed.help) {
    io.writeOut(INFO_HELP);
    return;
  }
  if (!parsed.positionals.length) usageError(io, usage, 'specify artifact info', "Missing argument 'name'.");
  if (parsed.positionals.length > 1) {
    usageError(io, usage, 'specify artifact info', `Got unexpected extra argument(s) (${parsed.positionals.slice(1).join(' ')})`);
  }
  requireJsonFlag(io, parsed.json);

  let resolvedKind: ArtifactKind | null = null;
  if (parsed.kind !== null) {
    if (!['command', 'template', 'script', 'hook'].includes(parsed.kind)) {
      io.writeErr(`invalid --kind ${pyRepr(parsed.kind)}: expected one of command, template, script, hook\n`);
      throw new ExitCode(2);
    }
    resolvedKind = parsed.kind as ArtifactKind;
  }

  let payload: Record<string, unknown>;
  try {
    const root = resolveProjectRoot(io);
    payload = new ArtifactCatalog(root).getArtifactInfo(parsed.positionals[0]!, resolvedKind);
  } catch (e) {
    handleDomainError(io, e);
  }
  io.writeOut(renderJson(payload));
  io.writeOut('\n');
}

function containsNonFinite(value: unknown): boolean {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonFinite);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(containsNonFinite);
  return false;
}

function isJsonSerializable(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonSerializable);
  if (typeof value === 'object' && !(value instanceof Date)) {
    return Object.values(value as Record<string, unknown>).every(isJsonSerializable);
  }
  return false;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function artifactLookup(io: ArtifactCommandIO, args: string[]): void {
  const usage = 'specify artifact lookup [OPTIONS] {lookup_id}';
  const parsed = parseArgs(io, args, { allowKind: false, usage, helpCmd: 'specify artifact lookup' });
  if (parsed.help) {
    io.writeOut(LOOKUP_HELP);
    return;
  }
  if (!parsed.positionals.length) usageError(io, usage, 'specify artifact lookup', "Missing argument 'lookup_id'.");
  if (parsed.positionals.length > 1) {
    usageError(io, usage, 'specify artifact lookup', `Got unexpected extra argument(s) (${parsed.positionals.slice(1).join(' ')})`);
  }
  requireJsonFlag(io, parsed.json);
  let payload: Record<string, unknown>;
  try {
    const root = resolveProjectRoot(io);
    payload = new ArtifactCatalog(root).getContributionInfo(parsed.positionals[0]!);
  } catch (e) {
    handleDomainError(io, e);
  }

  // json.dumps(..., allow_nan=False) + UTF-8 encodability guard.
  if (!isJsonSerializable(payload) || containsNonFinite(payload)) {
    emitErrorAndExit(io, new ArtifactResolutionError());
  }
  const rendered = renderJson(payload);
  if (LONE_SURROGATE.test(rendered)) emitErrorAndExit(io, new ArtifactResolutionError());
  io.writeOut(rendered);
  io.writeOut('\n');
}

// ============================================================================
// Dispatcher
// ============================================================================

/**
 * Dispatch ``specify artifact <args>`` (``args`` excludes the ``artifact``
 * word). Returns the process exit code.
 */
export async function runArtifactCommand(
  args: string[],
  io: ArtifactCommandIO = defaultArtifactIO,
): Promise<number> {
  try {
    if (args.length === 0) {
      // no_args_is_help=True (click >= 8.2 exits 2; help goes to stdout)
      io.writeOut(GROUP_HELP.replace(/\n$/, ''));
      return 2;
    }
    const [sub, ...rest] = args;
    if (sub === '--help' || sub === '-h') {
      io.writeOut(GROUP_HELP);
      return 0;
    }
    const groupUsage = 'specify artifact [OPTIONS] COMMAND [ARGS]...';
    switch (sub) {
      case 'list':
        artifactList(io, rest);
        return 0;
      case 'info':
        artifactInfo(io, rest);
        return 0;
      case 'lookup':
        artifactLookup(io, rest);
        return 0;
      default:
        if (sub!.startsWith('-')) usageError(io, groupUsage, 'specify artifact', `No such option: ${sub}`);
        usageError(io, groupUsage, 'specify artifact', `No such command '${sub}'.`);
    }
  } catch (e) {
    if (e instanceof ExitCode) return e.code;
    throw e;
  }
}
