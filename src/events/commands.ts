/**
 * @oakoliver/specify-cli - ``specify event`` CLI adapter
 *
 * Port of spec-kit v1.0.12 ``specify_cli/events/command_run.py`` and the
 * ``event_app`` Typer group in ``specify_cli/events/__init__.py``.
 *
 * @module events/commands
 */

import { resolveAndRunEventCommand, type RunEventCommandOptions } from './index.js';

// ============================================================================
// Constants
// ============================================================================

/** Cap piped stdin at 1 MiB to prevent a DoS. */
export const MAX_STDIN_BYTES = 1 * 1024 * 1024;

const EVENT_HELP = `                                                                                
 Usage: specify event [OPTIONS] COMMAND [ARGS]...                               
                                                                                
 Manage and execute event-driven commands                                       
                                                                                
╭─ Options ────────────────────────────────────────────────────────────────────╮
│ --help          Show this message and exit.                                  │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ Commands ───────────────────────────────────────────────────────────────────╮
│ run  Resolve and run an event-driven command script with stdin payload.      │
╰──────────────────────────────────────────────────────────────────────────────╯

`;

const EVENT_RUN_HELP = `                                                                                
 Usage: specify event run [OPTIONS] {command_name} {event_name} [timeout]       
                                                                                
 Resolve and run an event-driven command script with stdin payload.             
                                                                                
╭─ Arguments ──────────────────────────────────────────────────────────────────╮
│ *    command_name      <str>  Name of the command to execute [required]      │
│ *    event_name        <str>  Canonical event name (e.g., session_start)     │
│                               [required]                                     │
│      timeout           <int>  Per-handler timeout in seconds (passed through │
│                               from the native hook config)                   │
│                               [default: 120]                                 │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ Options ────────────────────────────────────────────────────────────────────╮
│ --help          Show this message and exit.                                  │
╰──────────────────────────────────────────────────────────────────────────────╯

`;

// ============================================================================
// Dependencies (injectable for tests)
// ============================================================================

export interface EventRunDeps {
  /** ``sys.stdin.isatty()`` */
  stdinIsTTY(): boolean;
  /** Read up to *limit* bytes from stdin (until EOF or the limit). */
  readStdin(limit: number): Promise<Uint8Array>;
  /** ``Path.cwd()`` */
  cwd(): string;
  /** Core runner (patch point mirroring ``specify_cli.events.resolve_and_run_event_command``). */
  resolveAndRun(
    commandName: string,
    eventName: string,
    payload: string,
    projectRoot: string,
    opts: RunEventCommandOptions,
  ): number;
  writeOut(text: string): void;
  writeErr(text: string): void;
}

async function readProcessStdin(limit: number): Promise<Uint8Array> {
  const stdin = process.stdin;
  return new Promise<Uint8Array>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onData);
      stdin.removeListener('end', finish);
      stdin.removeListener('error', onError);
      stdin.pause();
      const buf = Buffer.concat(chunks);
      resolvePromise(buf.subarray(0, Math.min(buf.length, limit)));
    };
    const onData = (chunk: Buffer | string): void => {
      const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      chunks.push(b);
      total += b.length;
      if (total >= limit) finish();
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    stdin.on('data', onData);
    stdin.once('end', finish);
    stdin.once('error', onError);
    stdin.resume();
  });
}

export const defaultEventRunDeps: EventRunDeps = {
  stdinIsTTY: () => Boolean(process.stdin.isTTY),
  readStdin: readProcessStdin,
  cwd: () => process.cwd(),
  resolveAndRun: resolveAndRunEventCommand,
  writeOut: (text) => {
    process.stdout.write(text);
  },
  writeErr: (text) => {
    process.stderr.write(text);
  },
};

// ============================================================================
// specify event run
// ============================================================================

/**
 * ``specify event run COMMAND_NAME EVENT_NAME [TIMEOUT]`` — resolve and run an
 * event-driven command script with the stdin payload. Returns the exit code.
 */
export async function eventRun(
  commandName: string,
  eventName: string,
  timeout = 120,
  deps: EventRunDeps = defaultEventRunDeps,
): Promise<number> {
  let payload: string;
  if (!deps.stdinIsTTY()) {
    // Read from the binary stream so the cap counts encoded bytes; one byte
    // past the cap tells us whether more data was waiting beyond it.
    const raw = await deps.readStdin(MAX_STDIN_BYTES + 1);
    if (raw.length > MAX_STDIN_BYTES) {
      deps.writeErr('stdin payload exceeds 1 MiB limit; truncate or pipe a smaller payload\n');
      return 1;
    }
    try {
      payload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    } catch {
      deps.writeErr('stdin payload must be valid UTF-8\n');
      return 1;
    }
  } else {
    payload = '{}';
  }

  const projectRoot = deps.cwd();
  return deps.resolveAndRun(commandName, eventName, payload, projectRoot, { timeout });
}

function usageError(deps: EventRunDeps, usage: string, message: string, helpCmd: string): number {
  deps.writeErr(
    `Usage: ${usage}\n` +
      `Try '${helpCmd} --help' for help.\n` +
      '╭─ Error ──────────────────────────────────────────────────────────────────────╮\n' +
      `│ ${message.padEnd(76)} │\n` +
      '╰──────────────────────────────────────────────────────────────────────────────╯\n',
  );
  return 2;
}

/**
 * Dispatch ``specify event <args>``. ``args`` excludes the ``event`` word.
 */
export async function runEventCommand(args: string[], deps: EventRunDeps = defaultEventRunDeps): Promise<number> {
  if (args.length === 0) {
    return usageError(deps, 'specify event [OPTIONS] COMMAND [ARGS]...', 'Missing command.', 'specify event');
  }
  const [sub, ...rest] = args;
  if (sub === '--help' || sub === '-h') {
    deps.writeOut(EVENT_HELP);
    return 0;
  }
  if (sub !== 'run') {
    if (sub!.startsWith('-')) {
      return usageError(
        deps,
        'specify event [OPTIONS] COMMAND [ARGS]...',
        `No such option: ${sub}`,
        'specify event',
      );
    }
    return usageError(deps, 'specify event [OPTIONS] COMMAND [ARGS]...', `No such command '${sub}'.`, 'specify event');
  }

  const runUsage = 'specify event run [OPTIONS] {command_name} {event_name} [timeout]';
  const positionals: string[] = [];
  let endOfOptions = false;
  for (const arg of rest) {
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && (arg === '--help' || arg === '-h')) {
      deps.writeOut(EVENT_RUN_HELP);
      return 0;
    }
    if (!endOfOptions && arg.startsWith('-') && arg.length > 1 && !/^-\d+$/.test(arg)) {
      return usageError(deps, runUsage, `No such option: ${arg}`, 'specify event run');
    }
    positionals.push(arg);
  }
  if (positionals.length < 1) {
    return usageError(deps, runUsage, "Missing argument 'command_name'.", 'specify event run');
  }
  if (positionals.length < 2) {
    return usageError(deps, runUsage, "Missing argument 'event_name'.", 'specify event run');
  }
  if (positionals.length > 3) {
    return usageError(deps, runUsage, `Got unexpected extra argument(s) (${positionals.slice(3).join(' ')})`, 'specify event run');
  }
  let timeout = 120;
  if (positionals.length === 3) {
    const raw = positionals[2]!.trim();
    if (!/^[+-]?\d+(?:_\d+)*$/.test(raw)) {
      return usageError(
        deps,
        runUsage,
        `Invalid value for 'timeout': '${positionals[2]}' is not a valid int.`,
        'specify event run',
      );
    }
    timeout = parseInt(raw.replace(/_/g, ''), 10);
  }
  return eventRun(positionals[0]!, positionals[1]!, timeout, deps);
}
