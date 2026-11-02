/**
 * @oakoliver/specify-cli - Project filesystem policy
 *
 * Port of spec-kit `_file_policy.py` (v1.2.5, #4934): strict project
 * configuration bootstrap and explicit FileHelper handoff. The persisted
 * `allow_symlinks` flag in `.specify/init-options.json` is read afresh at
 * every command boundary; reading never follows configuration links and only
 * absence defaults to `{}` / deny.
 *
 * @module file-policy
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolvePathLoose } from './download-security.js';
import { FileHelper, FileHelperError, errnoError, isErrno, isOsError } from './file-helper.js';
import { INIT_OPTIONS_FILE } from './init-options.js';
import { isPlainObject, pyJsonDumps } from './utils.js';

/** The project configuration cannot safely supply a filesystem policy (upstream: ValueError). */
export class ProjectPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectPolicyError';
  }
}

/** Python-style `str(exc)` for native/contract errors. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function validateOptions(options: unknown): Record<string, unknown> {
  if (!isPlainObject(options)) throw new ProjectPolicyError(`${INIT_OPTIONS_FILE} must contain a JSON object`);
  if ('allow_symlinks' in options && typeof options.allow_symlinks !== 'boolean') {
    throw new ProjectPolicyError(`${INIT_OPTIONS_FILE}: allow_symlinks must be a JSON boolean (true or false)`);
  }
  return options;
}

/**
 * Hooks around the init-options write (upstream: integrations `_file_changes`
 * `before_file_change` / `after_file_change`). The integration lifecycle
 * journal installs real callbacks; the default is a no-op.
 */
export const filePolicyHooks = {
  beforeFileChange: (_p: string): void => {},
  afterFileChange: (_p: string): void => {},
};

/** Read without following configuration links; only absence defaults. */
export function readProjectOptions(projectRoot: string): Record<string, unknown> {
  let files: FileHelper;
  try {
    files = new FileHelper(projectRoot);
  } catch (e) {
    if (isOsError(e)) {
      throw new ProjectPolicyError(`Cannot establish project root for ${INIT_OPTIONS_FILE}: ${errText(e)}`);
    }
    throw e;
  }
  let text: string;
  try {
    text = files.readText(INIT_OPTIONS_FILE);
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return {};
    if (isOsError(e) || e instanceof FileHelperError || e instanceof TypeError) {
      throw new ProjectPolicyError(
        `Cannot read ${INIT_OPTIONS_FILE}: ${errText(e)}. ` +
          'Ensure the configuration hierarchy is non-symlinked and readable.',
      );
    }
    throw e;
  }
  let options: unknown;
  try {
    options = parseStrictJson(text);
  } catch (e) {
    throw new ProjectPolicyError(`Invalid JSON in ${INIT_OPTIONS_FILE}: ${errText(e)}. Repair the configuration.`);
  }
  return validateOptions(options);
}

/**
 * JSON.parse that, like Python's `json.loads(parse_constant=reject)`, rejects
 * the non-standard `NaN` / `Infinity` constants (JSON.parse already rejects
 * them) and strips nothing else.
 */
function parseStrictJson(text: string): unknown {
  const stripped = text.replace(/^﻿/, '');
  if (stripped !== text) throw new Error('Unexpected UTF-8 BOM (decode using utf-8-sig)');
  return JSON.parse(text);
}

/** Resolve current policy afresh and return an immutable operation owner. */
export function projectFiles(projectRoot: string): FileHelper {
  const options = readProjectOptions(projectRoot);
  try {
    return new FileHelper(projectRoot, { allowSymlinks: (options.allow_symlinks as boolean | undefined) ?? false });
  } catch (e) {
    if (isOsError(e)) throw new ProjectPolicyError(`Cannot establish project filesystem boundary: ${errText(e)}`);
    throw e;
  }
}

/** Persist with deny-mode bootstrap (indent 2, sorted keys, UTF-8). */
export function saveProjectOptions(projectRoot: string, options: Record<string, unknown>): void {
  validateOptions(options);
  let content: string;
  try {
    content = pyJsonDumps(options, { indent: 2, sortKeys: true, ensureAscii: false }) + '\n';
  } catch (e) {
    throw new ProjectPolicyError(`Cannot encode ${INIT_OPTIONS_FILE} as JSON: ${errText(e)}`);
  }
  try {
    const files = new FileHelper(projectRoot);
    // Validate the entire destination before creating even .specify.
    try {
      files.readText(INIT_OPTIONS_FILE);
    } catch (e) {
      if (!isErrno(e, 'ENOENT')) throw e;
    }
    const destination = path.join(projectRoot, INIT_OPTIONS_FILE);
    filePolicyHooks.beforeFileChange(destination);
    files.mkdir('.specify', { existOk: true });
    files.overwriteText(INIT_OPTIONS_FILE, content);
    filePolicyHooks.afterFileChange(destination);
  } catch (e) {
    if (isOsError(e) || e instanceof FileHelperError || e instanceof TypeError) {
      throw new ProjectPolicyError(
        `Cannot write ${INIT_OPTIONS_FILE}: ${errText(e)}. ` +
          'Ensure the configuration hierarchy is non-symlinked and writable.',
      );
    }
    throw e;
  }
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function existingInitParent(target: string): string {
  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor) && !lexists(ancestor)) {
    const next = path.dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  return ancestor;
}

/** Absolute spelling without collapsing `..` (Python `Path.absolute()`). */
export function absoluteLexical(p: string): string {
  if (path.isAbsolute(p)) return p;
  const cwd = process.cwd();
  const parts = p.split(/[\\/]+/).filter((x) => x !== '' && x !== '.');
  return parts.length ? `${cwd}${cwd.endsWith(path.sep) ? '' : path.sep}${parts.join(path.sep)}` : cwd;
}

function validateInitTraversal(target: string): void {
  // Windows presence probes can fold missing/../existing before filesystem access.
  const anchor = path.parse(target).root;
  const parts = target.slice(anchor.length).split(/[\\/]+/).filter((x) => x !== '');
  for (let index = 0; index < parts.length; index++) {
    if (parts[index] !== '..') continue;
    const prefix = anchor + parts.slice(0, index).join(path.sep);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(prefix).isDirectory();
    } catch (e) {
      if (isErrno(e, 'ENOENT')) {
        throw new FileHelperError(`Parent traversal requires an existing directory before '..': ${prefix}`);
      }
      throw e;
    }
    if (!isDirectory) {
      throw new FileHelperError(`Parent traversal requires an existing directory before '..': ${prefix}`);
    }
  }
}

/** Validate original init spelling and policy before project preparation; returns the resolved root. */
export function preflightInitRoot(target: string): string {
  target = absoluteLexical(target);
  try {
    validateInitTraversal(target);
    if (fs.existsSync(target) || lexists(target)) {
      readProjectOptions(target);
    } else {
      const files = new FileHelper(existingInitParent(target));
      try {
        files.readBytes(target);
      } catch (e) {
        if (!isErrno(e, 'ENOENT')) throw e;
      }
    }
    return resolvePathLoose(target);
  } catch (e) {
    if (isOsError(e) || e instanceof FileHelperError) {
      throw new ProjectPolicyError(`Cannot establish init project root ${target}: ${errText(e)}`);
    }
    throw e;
  }
}

/**
 * Create a missing init root beneath its nearest existing trusted parent.
 *
 * Existing explicit root aliases are trusted just like FileHelper roots.
 * For new roots, deny traversal below the nearest existing directory.
 */
export function prepareInitRoot(target: string): string {
  target = absoluteLexical(target);
  validateInitTraversal(target);
  if (fs.existsSync(target) || lexists(target)) {
    new FileHelper(target);
    return target;
  }
  new FileHelper(existingInitParent(target)).mkdir(target, { parents: true, existOk: true });
  return target;
}

export { errnoError };
