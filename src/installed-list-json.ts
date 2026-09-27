/**
 * @oakoliver/specify-cli - Installed-list JSON helpers
 *
 * Port of upstream `_installed_list_json.py`: the public machine-readable
 * wire contract for `specify extension list --json` / `specify preset list --json`.
 *
 * @module installed-list-json
 */

import { CliExit } from './console.js';
import { UsageError } from './cli-args.js';
import { isPlainObject, pyJsonDumps } from './utils.js';

/** Return the stable public source shape for an installed record. */
export function normalizedSource(source: unknown): { kind: string; catalog?: string } {
  if (!isPlainObject(source)) return { kind: 'local' };
  const kind = source.kind;
  if (kind === 'local') return { kind: 'local' };
  if (kind === 'catalog') {
    const catalog = source.catalog;
    if (typeof catalog === 'string' && catalog.trim()) return { kind: 'catalog', catalog };
  }
  return { kind: 'local' };
}

/** Return the canonical public JSON object for one installed record. */
export function installedListItem(record: Record<string, unknown>, opts: { includeHooks: boolean }): Record<string, unknown> {
  let provides = record._json_provides as Record<string, unknown>;
  if (!opts.includeHooks) {
    provides = { commands: provides.commands, templates: provides.templates, scripts: provides.scripts };
  }
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    version: record.version,
    author: record._json_author,
    priority: record.priority,
    enabled: record.enabled,
    source: normalizedSource(record._json_source),
    provides,
  };
}

/** Write one JSON value to stdout without Rich rendering (`ensure_ascii=False`). */
export function emitJson(value: unknown): void {
  process.stdout.write(pyJsonDumps(value, { ensureAscii: false }) + '\n');
}

/** Write the list-command error contract to stderr and throw `CliExit(exitCode)`. */
export function emitJsonError(error: unknown, exitCode = 1): never {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.trim() || (error instanceof Error ? error.name : 'Error');
  process.stderr.write(pyJsonDumps({ error: message }, { ensureAscii: false }) + '\n');
  throw new CliExit(exitCode);
}

/**
 * Equivalent of `InstalledListJSONCommand.make_context`: when `--json` is in
 * `args` and parsing fails with a usage error, emit the JSON error contract
 * (exit code 2) instead of Typer's usage panel. Returns the parse result.
 */
export function parseInstalledListArgs<T>(args: string[], parse: () => T): T {
  const jsonOutput = args.includes('--json');
  try {
    return parse();
  } catch (e) {
    if (jsonOutput && e instanceof UsageError) emitJsonError(e, e.exitCode);
    throw e;
  }
}
