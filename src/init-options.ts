/**
 * @oakoliver/specify-cli - Init options
 *
 * Port of upstream `_init_options.py`: helpers for interpreting persisted
 * init options (`.specify/init-options.json`).
 *
 * @module init-options
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPlainObject, pyJsonDumps } from './utils.js';

export const INIT_OPTIONS_FILE = '.specify/init-options.json';

/** Sentinel: init-options.json does not exist at all (legacy layout). */
export const MISSING_INIT_OPTIONS_FILE: unique symbol = Symbol('MISSING_INIT_OPTIONS_FILE');
export type MissingInitOptionsFile = typeof MISSING_INIT_OPTIONS_FILE;

/** Persist the CLI options used during `specify init` (indent 2, sorted keys, UTF-8). */
export function saveInitOptions(projectPath: string, options: Record<string, unknown>): void {
  const dest = path.join(projectPath, INIT_OPTIONS_FILE);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, pyJsonDumps(options, { indent: 2, sortKeys: true, ensureAscii: false }) + '\n', 'utf8');
}

/** Load persisted init options, returning `{}` when unavailable or invalid. */
export function loadInitOptions(projectPath: string): Record<string, unknown> {
  const p = path.join(projectPath, INIT_OPTIONS_FILE);
  if (!fs.existsSync(p)) return {};
  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
  return isPlainObject(payload) ? payload : {};
}

/** True only when init options explicitly enable AI skills (`ai_skills === true`). */
export function isAiSkillsEnabled(opts: unknown): boolean {
  return isPlainObject(opts) && opts.ai_skills === true;
}

/**
 * Resolve the active integration key for active-only registration.
 * - {@link MISSING_INIT_OPTIONS_FILE} when the file does not exist at all;
 * - `null` when present but without a valid non-empty string `ai`;
 * - the agent key otherwise.
 */
export function resolveActiveAgentForRegistration(projectPath: string): string | null | MissingInitOptionsFile {
  const p = path.join(projectPath, INIT_OPTIONS_FILE);
  let isSymlink = false;
  try {
    isSymlink = fs.lstatSync(p).isSymbolicLink();
  } catch {
    isSymlink = false;
  }
  if (!isSymlink && !fs.existsSync(p)) return MISSING_INIT_OPTIONS_FILE;
  const active = loadInitOptions(projectPath).ai;
  if (typeof active === 'string' && active) return active;
  return null;
}
