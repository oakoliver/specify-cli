/**
 * @oakoliver/specify-cli - Shared Infrastructure
 *
 * Shared Spec Kit infrastructure installation helpers (port of
 * `shared_infra.py`, plus the `_install_shared_infra`,
 * `_install_shared_infra_or_exit`, `_refresh_shared_templates`,
 * `ensure_executable_scripts` and `resolve_active_skills_dir` wrappers that
 * live in upstream's `specify_cli/__init__.py`).
 *
 * Installs `.specify/scripts/<variant>/`, `.specify/templates/` and the
 * managed `.specify/.gitignore` from the bundled `core_pack/`, tracking every
 * file in `.specify/integrations/speckit.manifest.json`.
 *
 * @module shared-infra
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

import { IntegrationManifest } from './integrations/manifest.js';
import { console as defaultConsole, CliExit } from './console.js';
import { getSpeckitVersion, locateCorePack, repoRoot as defaultRepoRoot } from './assets.js';
import { loadInitOptions, isAiSkillsEnabled } from './init-options.js';
import { AGENT_CONFIG } from './agent-config.js';

// ============================================================================
// Types
// ============================================================================

/** Minimal console surface used by shared-infra (matches `src/console.ts`). */
export interface SharedInfraConsole {
  print(message?: string): void;
}

/** Minimal StepTracker surface (matches upstream `StepTracker`). */
export interface SharedInfraTracker {
  add(key: string, label: string): void;
  complete(key: string, detail?: string): void;
  error(key: string, detail?: string): void;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Managed `.specify/.gitignore`. Keeps machine-local Spec Kit state out of
 * version control while leaving shareable project files tracked. Patterns are
 * relative to the `.specify/` directory the file lives in.
 */
export const SPECIFY_GITIGNORE_CONTENT = `# Machine-local Spec Kit state — not meant to be shared.
# Managed by the Specify CLI; safe to edit (your changes are preserved on refresh).

# Local pointer to the current feature directory. Rewritten every time you
# switch features, so it is per-checkout state rather than something to share.
feature.json

# Per-machine extension config overrides.
extensions/*/local-config.yml
`;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const IS_WINDOWS = process.platform === 'win32';

// ============================================================================
// Python-style helpers
// ============================================================================

/** Python `repr()` for a string / None (used in error messages). */
function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value !== 'string') return String(value);
  const useDouble = value.includes("'") && !value.includes('"');
  const quote = useDouble ? '"' : "'";
  let out = '';
  for (const ch of value) {
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + quote;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  return quote + out + quote;
}

function errMessage(exc: unknown): string {
  if (exc instanceof Error) {
    const e = exc as NodeJS.ErrnoException;
    // Mimic Python OSError str(): "[Errno N] Strerror: 'path'"
    if (typeof e.errno === 'number' && e.code && e.syscall) {
      return e.message;
    }
    return e.message;
  }
  return String(exc);
}

/** `Path.is_symlink()` */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `Path.exists()` (follows symlinks). */
function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** `Path.is_dir()` (follows symlinks). */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `Path.is_file()` (follows symlinks). */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * `Path.resolve()` (non-strict): resolve symlinks of the longest existing
 * prefix, then append the remaining components lexically.
 */
export function resolveLoose(p: string): string {
  const abs = resolvePath(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(resolveLoose(parent), basename(abs));
  }
}

/** `child.relative_to(root)` succeeds (both already normalized). */
function isWithin(child: string, root: string): boolean {
  if (child === root) return true;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(rootWithSep);
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Lexical relative path split into parts, or null when `dest` is not under `projectPath`. */
function lexicalRelParts(projectPath: string, dest: string): string[] | null {
  const root = resolvePath(projectPath);
  const target = resolvePath(dest);
  if (!isWithin(target, root)) return null;
  const rel = relative(root, target);
  if (!rel) return [];
  return rel.split(sep);
}

// ============================================================================
// Hashing
// ============================================================================

/** Return the hex SHA-256 digest of a file, reading it in 8 KiB chunks. */
export function sha256File(path: string): string {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(8192);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * Resolve `rel` against `root` and verify it stays within `root`
 * (port of `integrations.manifest._validate_rel_path`).
 */
function validateRelPath(rel: string, root: string): string {
  if (isAbsolute(rel)) {
    throw new Error(`Absolute paths are not allowed in manifests: ${rel}`);
  }
  const resolved = resolveLoose(join(root, rel));
  const rootResolved = resolveLoose(root);
  if (!isWithin(resolved, rootResolved)) {
    throw new Error(
      `Path ${rel} resolves to ${resolved} which is outside the project root ${rootResolved}`,
    );
  }
  return resolved;
}

// ============================================================================
// Archive integrity
// ============================================================================

/**
 * Verify downloaded archive bytes against a catalog-declared SHA-256.
 *
 * `expected` may be prefixed with `"sha256:"` (case-insensitive). `null` /
 * `undefined` skips verification; a declared-but-blank value is rejected.
 */
export function verifyArchiveSha256(
  data: Uint8Array,
  expected: string | null | undefined,
  name: string,
  errorCls: new (message: string) => Error,
): void {
  if (expected === null || expected === undefined) {
    if (process.env.SPECIFY_DEBUG) {
      process.stderr.write(`No sha256 declared for ${pyRepr(name)}; archive integrity was not verified.\n`);
    }
    return;
  }
  let raw = String(expected).trim();
  if (raw.slice(0, 7).toLowerCase() === 'sha256:') raw = raw.slice(7).trim();
  const expectedHex = raw.toLowerCase();
  if (!SHA256_HEX_RE.test(expectedHex)) {
    throw new errorCls(
      `Invalid sha256 declared for ${pyRepr(name)}: expected 64 hexadecimal ` +
        `characters (optionally prefixed with 'sha256:'), got ` +
        `${pyRepr(expected)}.`,
    );
  }
  const actualHex = createHash('sha256').update(data).digest('hex');
  const a = Buffer.from(actualHex, 'utf-8');
  const b = Buffer.from(expectedHex, 'utf-8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new errorCls(
      `Integrity check failed for ${pyRepr(name)}: the catalog declares ` +
        `sha256 ${expectedHex}, but the downloaded archive is ` +
        `${actualHex}. The archive may be corrupted or tampered with.`,
    );
  }
}

// ============================================================================
// Safe path helpers
// ============================================================================

/**
 * Raised when a shared infrastructure path or ancestor is a symlink.
 *
 * Distinct from other unsafe-path errors (plain `Error`, Python `ValueError`)
 * so callers can preserve symlinked destinations as customizations while
 * still letting genuine safety errors propagate.
 */
export class SymlinkedSharedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SymlinkedSharedPathError';
  }
}

/** Load the shared infrastructure manifest, preserving existing entries. */
export function loadSpeckitManifest(
  projectPath: string,
  opts: { version: string; console?: SharedInfraConsole | null },
): IntegrationManifest {
  const manifestPath = join(projectPath, '.specify', 'integrations', 'speckit.manifest.json');
  if (pathExists(manifestPath)) {
    try {
      const manifest = IntegrationManifest.load('speckit', projectPath);
      manifest.version = opts.version;
      return manifest;
    } catch (exc) {
      if (opts.console) {
        opts.console.print(
          `[yellow]Warning:[/yellow] Could not read shared infrastructure ` +
            `manifest at ${manifestPath}: ${errMessage(exc)}`,
        );
        opts.console.print(
          'A new shared manifest will be created; previously tracked ' +
            'shared files may be treated as untracked.',
        );
      }
    }
  }
  return new IntegrationManifest('speckit', projectPath, opts.version);
}

/** Return the bundled/source shared templates directory. */
export function sharedTemplatesSource(opts: { corePack: string | null; repoRoot: string }): string {
  if (opts.corePack && isDir(join(opts.corePack, 'templates'))) return join(opts.corePack, 'templates');
  return join(opts.repoRoot, 'templates');
}

/** Return the bundled/source shared scripts directory. */
export function sharedScriptsSource(opts: { corePack: string | null; repoRoot: string }): string {
  if (opts.corePack && isDir(join(opts.corePack, 'scripts'))) return join(opts.corePack, 'scripts');
  return join(opts.repoRoot, 'scripts');
}

function sharedDestinationLabel(projectPath: string, dest: string): string {
  const parts = lexicalRelParts(projectPath, dest);
  if (parts === null) return dest;
  return parts.length ? parts.join('/') : '.';
}

function sharedRelativeParts(projectPath: string, dest: string): string[] {
  const parts = lexicalRelParts(projectPath, dest);
  if (parts === null || parts.includes('..')) {
    const label = sharedDestinationLabel(projectPath, dest);
    throw new Error(`Shared infrastructure path escapes project root: ${label}`);
  }
  return parts;
}

function capitalize(text: string): string {
  // Python str.capitalize(): first char upper, rest lower.
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

/** Create a shared infra directory without following symlinked parents. */
export function ensureSafeSharedDirectory(
  projectPath: string,
  directory: string,
  opts: { create?: boolean; context?: string } = {},
): void {
  const create = opts.create ?? true;
  const context = opts.context ?? 'shared infrastructure directory';
  const root = resolveLoose(projectPath);
  const rel = sharedRelativeParts(projectPath, directory);
  let current = resolvePath(projectPath);

  for (const part of rel) {
    current = join(current, part);
    const label = sharedDestinationLabel(projectPath, current);
    if (isSymlink(current)) {
      throw new SymlinkedSharedPathError(`Refusing to use symlinked ${context}: ${label}`);
    }
    if (pathExists(current)) {
      if (!isDir(current)) {
        throw new Error(`${capitalize(context)} path is not a directory: ${label}`);
      }
      if (!isWithin(resolveLoose(current), root)) {
        throw new Error(`${capitalize(context)} escapes project root: ${label}`);
      }
      continue;
    }
    if (!create) {
      throw new Error(`${capitalize(context)} does not exist: ${label}`);
    }
    mkdirSync(current);
    if (isSymlink(current)) {
      throw new SymlinkedSharedPathError(`Refusing to use symlinked ${context}: ${label}`);
    }
    if (!isWithin(resolveLoose(current), root)) {
      throw new Error(`${capitalize(context)} escapes project root: ${label}`);
    }
  }
}

/** Validate existing directory parents while allowing missing directories. */
export function validateSafeSharedDirectory(projectPath: string, directory: string): void {
  const root = resolveLoose(projectPath);
  const rel = sharedRelativeParts(projectPath, directory);
  let current = resolvePath(projectPath);

  for (const part of rel) {
    current = join(current, part);
    const label = sharedDestinationLabel(projectPath, current);
    if (isSymlink(current)) {
      throw new SymlinkedSharedPathError(
        `Refusing to use symlinked shared infrastructure directory: ${label}`,
      );
    }
    if (!pathExists(current)) continue;
    if (!isDir(current)) {
      throw new Error(`Shared infrastructure directory path is not a directory: ${label}`);
    }
    if (!isWithin(resolveLoose(current), root)) {
      throw new Error(`Shared infrastructure directory escapes project root: ${label}`);
    }
  }
}

/** Refuse shared infra writes that would escape or follow symlinks. */
export function ensureSafeSharedDestination(
  projectPath: string,
  dest: string,
  opts: { parentMustExist?: boolean } = {},
): void {
  const parentMustExist = opts.parentMustExist ?? true;
  const root = resolveLoose(projectPath);
  sharedRelativeParts(projectPath, dest);
  if (parentMustExist) {
    ensureSafeSharedDirectory(projectPath, dirname(resolvePath(dest)), { create: false });
  } else {
    validateSafeSharedDirectory(projectPath, dirname(resolvePath(dest)));
  }
  const label = sharedDestinationLabel(projectPath, dest);
  if (isSymlink(dest)) {
    throw new SymlinkedSharedPathError(
      `Refusing to overwrite symlinked shared infrastructure path: ${label}`,
    );
  }
  if (pathExists(dest)) {
    if (!isWithin(resolveLoose(dest), root)) {
      throw new Error(`Shared infrastructure destination escapes project root: ${label}`);
    }
  }
}

/** Atomically write UTF-8 text to a shared infra destination. */
export function writeSharedText(projectPath: string, dest: string, content: string): void {
  writeSharedBytes(projectPath, dest, Buffer.from(content, 'utf-8'));
}

/** Atomically write bytes to a shared infra destination (temp file + rename). */
export function writeSharedBytes(
  projectPath: string,
  dest: string,
  content: Uint8Array,
  opts: { mode?: number } = {},
): void {
  const mode = opts.mode ?? 0o644;
  ensureSafeSharedDestination(projectPath, dest);
  const tempPath = join(
    dirname(dest),
    `.${basename(dest)}.${randomBytes(6).toString('hex')}`,
  );
  try {
    writeFileSync(tempPath, content, { flag: 'wx', mode: 0o600 });
    chmodSync(tempPath, mode);
    ensureSafeSharedDestination(projectPath, dest);
    renameSync(tempPath, dest);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // already renamed / missing
    }
  }
}

// ============================================================================
// Dynamic command reference rendering
// ============================================================================

const BASH_FORMAT_COMMAND_RE =
  /\$\(\s*format_speckit_command\s+(['"]?)([A-Za-z0-9_.-]+)\1(?:\s+[^)]*)?\)/g;
const POWERSHELL_FORMAT_COMMAND_RE =
  /Format-SpecKitCommand\s+-CommandName\s+(['"])([A-Za-z0-9_.-]+)\1(?:\s+-RepoRoot\s+[^\r\n]+)?/g;
const PYTHON_FORMAT_COMMAND_RETURN_RE = /return f"\/speckit\{separator\}\{name\}"/g;
const BASH_FORMATTER_RETURN_RE = /printf '\/speckit%s%s\\n' "\$separator" "\$command_name"/g;
const POWERSHELL_FORMATTER_RETURN_RE = /return "\/speckit\$separator\$name"/g;

function formatSpeckitCommand(commandName: string, separator: string, prefix = '/'): string {
  let name = commandName.trim().replace(/^\/+/, '');
  if (name.startsWith('speckit.')) name = name.slice('speckit.'.length);
  else if (name.startsWith('speckit-')) name = name.slice('speckit-'.length);
  name = name.split('.').join(separator);
  return `${prefix}speckit${separator}${name}`;
}

/** Render script runtime command helpers for managed shared infra copies. */
export function resolveDynamicCommandRefs(content: string, separator: string, prefix = '/'): string {
  const bashPrefix = prefix === '$' ? '\\$' : prefix;
  content = content.replace(BASH_FORMAT_COMMAND_RE, (_m, _q: string, name: string) =>
    formatSpeckitCommand(name, separator, bashPrefix),
  );
  content = content.replace(POWERSHELL_FORMAT_COMMAND_RE, (_m, _q: string, name: string) =>
    `'${formatSpeckitCommand(name, separator, prefix)}'`,
  );
  // Python re.sub replacement: '\\\\n' in the template collapses to '\\n'.
  content = content.replace(
    BASH_FORMATTER_RETURN_RE,
    () => `printf '${prefix}speckit%s%s\\n' "$separator" "$command_name"`,
  );
  const powershellPrefix = prefix === '$' ? '`$' : prefix;
  content = content.replace(
    POWERSHELL_FORMATTER_RETURN_RE,
    () => `return "${powershellPrefix}speckit$separator$name"`,
  );
  return content.replace(
    PYTHON_FORMAT_COMMAND_RETURN_RE,
    () => `return f"${prefix}speckit{separator}{name}"`,
  );
}

/**
 * Replace `__SPECKIT_COMMAND_<NAME>__` placeholders with invocations
 * (identical to `IntegrationBase.resolveCommandRefs`; inlined so this module
 * does not pull in the whole integration class graph).
 */
function resolveCommandRefs(content: string, separator: string, prefix: string): string {
  return content.replace(
    /__SPECKIT_COMMAND_([A-Z][A-Z0-9_-]*)__/g,
    (_m, name: string) => prefix + 'speckit' + separator + name.toLowerCase().split('_').join(separator),
  );
}

// ============================================================================
// Template refresh
// ============================================================================

export interface RefreshSharedTemplatesOptions {
  version: string;
  corePack: string | null;
  repoRoot: string;
  console: SharedInfraConsole;
  invokeSeparator: string;
  invokePrefix?: string;
  force?: boolean;
}

function listDirSorted(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Refresh default-sensitive shared templates without touching scripts. */
export function refreshSharedTemplatesImpl(projectPath: string, opts: RefreshSharedTemplatesOptions): void {
  const invokePrefix = opts.invokePrefix ?? '/';
  const force = opts.force ?? false;
  const templatesSrc = sharedTemplatesSource({ corePack: opts.corePack, repoRoot: opts.repoRoot });
  if (!isDir(templatesSrc)) return;

  const manifest = loadSpeckitManifest(projectPath, { version: opts.version, console: opts.console });
  const trackedFiles = manifest.files;
  const modified = new Set(manifest.checkModified());
  const skippedFiles: string[] = [];
  const plannedUpdates: Array<[string, string, string]> = [];

  const destTemplates = join(projectPath, '.specify', 'templates');
  ensureSafeSharedDirectory(projectPath, destTemplates);
  for (const name of listDirSorted(templatesSrc)) {
    const src = join(templatesSrc, name);
    if (!isFile(src) || name === 'vscode-settings.json' || name.startsWith('.')) continue;

    const dst = join(destTemplates, name);
    ensureSafeSharedDestination(projectPath, dst);
    const rel = `.specify/templates/${name}`;
    if (pathExists(dst) && !force) {
      if (!(rel in trackedFiles) || modified.has(rel) || manifest.isRecovered(rel)) {
        skippedFiles.push(rel);
        continue;
      }
    }

    let content = readFileSync(src, 'utf-8');
    content = resolveCommandRefs(content, opts.invokeSeparator, invokePrefix);
    plannedUpdates.push([dst, rel, content]);
  }

  for (const [dst, rel, content] of plannedUpdates) {
    writeSharedText(projectPath, dst, content);
    manifest.recordExisting(rel);
  }

  manifest.save();

  if (skippedFiles.length > 0) {
    opts.console.print(
      `[yellow]⚠[/yellow]  ${skippedFiles.length} modified, untracked, or preserved (recovered) shared template file(s) were not updated:`,
    );
    for (const rel of skippedFiles) opts.console.print(`    ${rel}`);
  }
}

// ============================================================================
// Shared infra install
// ============================================================================

export interface InstallSharedInfraImplOptions {
  version: string;
  corePack: string | null;
  repoRoot: string;
  console: SharedInfraConsole;
  force?: boolean;
  invokeSeparator?: string;
  invokePrefix?: string;
  refreshManaged?: boolean;
  refreshHint?: string | null;
}

/** Recursive file listing (`Path.rglob("*")` restricted to files), sorted. */
function rglobFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of listDirSorted(dir)) {
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (isFile(full)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Install shared scripts and templates into `projectPath`.
 *
 * When `refreshManaged` is true, files whose on-disk hash still matches the
 * previously recorded manifest hash are overwritten with the bundled version.
 * Files whose hash diverges are treated as user customizations and preserved
 * with a warning. `force` overwrites every regular file (symlinks and
 * symlinked-parent destinations are always preserved with a warning).
 * `refreshHint` is shown after the customization warning.
 */
export function installSharedInfraImpl(
  projectPath: string,
  scriptType: string,
  opts: InstallSharedInfraImplOptions,
): boolean {
  const force = opts.force ?? false;
  const invokeSeparator = opts.invokeSeparator ?? '.';
  const invokePrefix = opts.invokePrefix ?? '/';
  const refreshManaged = opts.refreshManaged ?? false;
  const refreshHint = opts.refreshHint ?? null;
  const out = opts.console;

  const manifest = loadSpeckitManifest(projectPath, { version: opts.version, console: out });
  const priorHashes: Record<string, string> = { ...manifest.files };
  const hasPrior = (rel: string): boolean => Object.prototype.hasOwnProperty.call(priorHashes, rel);

  const isManaged = (rel: string, dst: string): boolean => {
    const expected = priorHashes[rel];
    if (!expected || !isFile(dst) || isSymlink(dst)) return false;
    if (manifest.isRecovered(rel)) return false;
    try {
      return sha256File(dst) === expected;
    } catch {
      return false;
    }
  };

  const skippedFiles: string[] = [];
  const preservedUserFiles: string[] = [];
  const symlinkedFiles: string[] = [];
  const plannedCopies: Array<[string, string, Buffer, number]> = [];
  const plannedTemplates: Array<[string, string, string]> = [];
  const seenRels = new Set<string>();
  const scannedVariantDirs = new Set<string>();
  const shellVariant = IS_WINDOWS ? 'powershell' : 'bash';
  const variantDirs: string[] =
    scriptType === 'py'
      ? ['python', shellVariant]
      : [scriptType === 'sh' ? 'bash' : 'powershell'];

  const projectAbs = resolvePath(projectPath);
  const relOf = (p: string): string => toPosix(relative(projectAbs, resolvePath(p)));

  const decideOverwrite = (rel: string, dst: string): [boolean, 'skip' | 'preserved' | null] => {
    if (!pathExists(dst)) return [true, null];
    if (force) return [true, null];
    if (refreshManaged) {
      if (isManaged(rel, dst)) return [true, null];
      if (hasPrior(rel)) return [false, 'preserved'];
      return [false, 'skip'];
    }
    return [false, 'skip'];
  };

  const safeDestOrBucket = (dst: string, rel: string, parentMustExist = true): boolean => {
    try {
      ensureSafeSharedDestination(projectPath, dst, { parentMustExist });
    } catch (exc) {
      if (exc instanceof SymlinkedSharedPathError) {
        symlinkedFiles.push(rel);
        return false;
      }
      throw exc;
    }
    return true;
  };

  const ensureOrBucketDir = (directory: string): boolean => {
    try {
      ensureSafeSharedDirectory(projectPath, directory);
    } catch (exc) {
      if (exc instanceof SymlinkedSharedPathError) {
        symlinkedFiles.push(relOf(directory));
        return false;
      }
      throw exc;
    }
    return true;
  };

  const recordRecovered = (rel: string, dst: string): void => {
    if (isFile(dst) && !hasPrior(rel)) {
      try {
        manifest.recordExisting(rel, { recovered: true });
      } catch (exc) {
        out.print(`[yellow]⚠[/yellow]  could not record ${rel} in manifest: ${errMessage(exc)}`);
      }
    }
  };

  const scriptsSrc = sharedScriptsSource({ corePack: opts.corePack, repoRoot: opts.repoRoot });
  if (isDir(scriptsSrc)) {
    const destScripts = join(projectPath, '.specify', 'scripts');
    if (ensureOrBucketDir(destScripts)) {
      for (const variantDir of variantDirs) {
        const variantSrc = join(scriptsSrc, variantDir);
        if (!isDir(variantSrc)) continue;
        const destVariant = join(destScripts, variantDir);
        if (!ensureOrBucketDir(destVariant)) continue;
        for (const srcPath of rglobFiles(variantSrc)) {
          const relParts = relative(variantSrc, srcPath).split(sep);
          // Python bytecode caches are local artifacts — never install them.
          if (relParts.includes('__pycache__') || srcPath.split(sep).includes('__pycache__')) continue;
          scannedVariantDirs.add(variantDir);

          const dstPath = join(destVariant, ...relParts);
          const rel = relOf(dstPath);
          seenRels.add(rel);
          if (!safeDestOrBucket(dstPath, rel, false)) continue;
          const [write, bucket] = decideOverwrite(rel, dstPath);
          if (!write) {
            if (bucket === 'preserved') {
              preservedUserFiles.push(rel);
            } else {
              skippedFiles.push(rel);
              recordRecovered(rel, dstPath);
            }
            continue;
          }

          if (!ensureOrBucketDir(dirname(dstPath))) continue;
          let content = readFileSync(srcPath, 'utf-8');
          content = resolveCommandRefs(content, invokeSeparator, invokePrefix);
          content = resolveDynamicCommandRefs(content, invokeSeparator, invokePrefix);
          plannedCopies.push([
            dstPath,
            rel,
            Buffer.from(content, 'utf-8'),
            statSync(srcPath).mode & 0o777,
          ]);
        }
      }
    }
  }

  const templatesSrc = sharedTemplatesSource({ corePack: opts.corePack, repoRoot: opts.repoRoot });
  if (isDir(templatesSrc)) {
    const destTemplates = join(projectPath, '.specify', 'templates');
    if (ensureOrBucketDir(destTemplates)) {
      for (const name of listDirSorted(templatesSrc)) {
        const src = join(templatesSrc, name);
        if (!isFile(src) || name === 'vscode-settings.json' || name.startsWith('.')) continue;

        const dst = join(destTemplates, name);
        const rel = relOf(dst);
        seenRels.add(rel);
        if (!safeDestOrBucket(dst, rel)) continue;
        const [write, bucket] = decideOverwrite(rel, dst);
        if (!write) {
          if (bucket === 'preserved') {
            preservedUserFiles.push(rel);
          } else {
            skippedFiles.push(rel);
            recordRecovered(rel, dst);
          }
          continue;
        }

        let content = readFileSync(src, 'utf-8');
        content = resolveCommandRefs(content, invokeSeparator, invokePrefix);
        plannedTemplates.push([dst, rel, content]);
      }
    }
  }

  // Managed `.specify/.gitignore` — routed through the same
  // overwrite/skip/preserve policy as templates and tracked in the shared
  // manifest (so `integration uninstall` leaves it in place).
  const specifyDir = join(projectPath, '.specify');
  if (ensureOrBucketDir(specifyDir)) {
    const gitignoreDst = join(specifyDir, '.gitignore');
    const gitignoreRel = relOf(gitignoreDst);
    seenRels.add(gitignoreRel);
    if (safeDestOrBucket(gitignoreDst, gitignoreRel)) {
      const [write, bucket] = decideOverwrite(gitignoreRel, gitignoreDst);
      if (write) {
        plannedTemplates.push([gitignoreDst, gitignoreRel, SPECIFY_GITIGNORE_CONTENT]);
      } else if (bucket === 'preserved') {
        preservedUserFiles.push(gitignoreRel);
      } else {
        skippedFiles.push(gitignoreRel);
        recordRecovered(gitignoreRel, gitignoreDst);
      }
    }
  }

  for (const [dstPath, rel, content, mode] of plannedCopies) {
    if (!ensureOrBucketDir(dirname(dstPath))) continue;
    writeSharedBytes(projectPath, dstPath, content, { mode });
    manifest.recordExisting(rel);
  }

  for (const [dst, rel, content] of plannedTemplates) {
    writeSharedText(projectPath, dst, content);
    manifest.recordExisting(rel);
  }

  if (skippedFiles.length > 0) {
    out.print(
      `[yellow]⚠[/yellow]  ${skippedFiles.length} shared infrastructure path(s) already exist and were not updated:`,
    );
    for (const p of skippedFiles) out.print(`    ${p}`);
    if (refreshManaged && refreshHint) {
      out.print(refreshHint);
    } else {
      out.print(
        'To refresh shared infrastructure, run ' +
          '[cyan]specify init --here --force[/cyan] or ' +
          '[cyan]specify integration upgrade --force[/cyan].',
      );
    }
  }

  if (symlinkedFiles.length > 0) {
    out.print(
      `[yellow]⚠[/yellow]  Skipped ${symlinkedFiles.length} symlinked shared ` +
        'infrastructure path(s) — symlinks are never overwritten because they ' +
        'may resolve outside the project root:',
    );
    for (const p of symlinkedFiles) out.print(`    ${p}`);
    out.print(
      'To restore the bundled version, remove or replace the symlink manually, ' +
        'then re-run the command.',
    );
  }

  if (preservedUserFiles.length > 0) {
    out.print(
      `[yellow]⚠[/yellow]  Preserved ${preservedUserFiles.length} customized shared ` +
        'infrastructure file(s) (hash differs from previous install):',
    );
    for (const p of preservedUserFiles) out.print(`    ${p}`);
    if (refreshHint) out.print(refreshHint);
  }

  // Remove stale managed scripts: paths a previous install recorded that the
  // current core no longer ships (#3076). Scoped to scanned variants and only
  // for *managed* copies.
  if (scannedVariantDirs.size > 0) {
    const staleRemoved: string[] = [];
    const scriptPrefixes = [...scannedVariantDirs].map((v) => `.specify/scripts/${v}/`);
    for (const rel of Object.keys(priorHashes)) {
      if (seenRels.has(rel) || !scriptPrefixes.some((p) => rel.startsWith(p))) continue;
      // Guard corrupted/hand-edited manifest keys BEFORE any filesystem access.
      const relParts = rel.split(/[\\/]/);
      if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || relParts.includes('..')) continue;
      try {
        validateRelPath(rel, projectPath);
      } catch {
        continue;
      }
      const dst = join(projectPath, rel);
      if (!pathExists(dst) && !isSymlink(dst)) {
        manifest.remove(rel);
        continue;
      }
      if (!isManaged(rel, dst)) continue;
      if (!safeDestOrBucket(dst, rel)) continue;
      try {
        unlinkSync(dst);
      } catch (exc) {
        out.print(`[yellow]⚠[/yellow]  could not remove stale ${rel}: ${errMessage(exc)}`);
        continue;
      }
      manifest.remove(rel);
      staleRemoved.push(rel);
    }

    if (staleRemoved.length > 0) {
      out.print(
        `[yellow]⚠[/yellow]  Removed ${staleRemoved.length} obsolete shared ` +
          'script(s) left by a previous install:',
      );
      for (const p of staleRemoved) out.print(`    ${p}`);
    }
  }

  manifest.save();
  return true;
}

// ============================================================================
// Project-level wrappers (upstream specify_cli/__init__.py)
// ============================================================================

export interface InstallSharedInfraOptions {
  tracker?: SharedInfraTracker | null;
  force?: boolean;
  invokeSeparator?: string;
  invokePrefix?: string;
  refreshManaged?: boolean;
  refreshHint?: string | null;
  /** Overrides (tests): default to the bundled core_pack / CLI version / global console. */
  version?: string;
  corePack?: string | null;
  repoRoot?: string;
  console?: SharedInfraConsole;
}

function resolveCorePackDefault(value: string | null | undefined): string | null {
  if (value !== undefined) return value;
  return locateCorePack();
}

/**
 * Install shared infrastructure files into `projectPath`
 * (upstream `specify_cli._install_shared_infra`).
 *
 * Copies `.specify/scripts/<variant>/` and `.specify/templates/` from the
 * bundled core_pack. `sh` installs Bash, `ps` installs PowerShell, and `py`
 * installs Python plus the platform shell fallback. Tracks all installed
 * files in `speckit.manifest.json`. Throws on unsafe paths / IO errors.
 */
export function installSharedInfra(
  projectPath: string,
  scriptType: string,
  opts: InstallSharedInfraOptions = {},
): boolean {
  return installSharedInfraImpl(projectPath, scriptType, {
    version: opts.version ?? getSpeckitVersion(),
    corePack: resolveCorePackDefault(opts.corePack),
    repoRoot: opts.repoRoot ?? defaultRepoRoot(),
    console: opts.console ?? defaultConsole,
    force: opts.force ?? false,
    invokeSeparator: opts.invokeSeparator ?? '.',
    invokePrefix: opts.invokePrefix ?? '/',
    refreshManaged: opts.refreshManaged ?? false,
    refreshHint: opts.refreshHint ?? null,
  });
}

/**
 * Like {@link installSharedInfra} but prints
 * `Error: Failed to install shared infrastructure: ...` and throws
 * `CliExit(1)` on failure (upstream `_install_shared_infra_or_exit`).
 */
export function installSharedInfraOrExit(
  projectPath: string,
  scriptType: string,
  opts: InstallSharedInfraOptions = {},
): boolean {
  try {
    return installSharedInfra(projectPath, scriptType, opts);
  } catch (exc) {
    if (exc instanceof CliExit) throw exc;
    (opts.console ?? defaultConsole).print(
      `[red]Error:[/red] Failed to install shared infrastructure: ${errMessage(exc)}`,
    );
    throw new CliExit(1);
  }
}

/**
 * Refresh default-sensitive shared templates without touching scripts
 * (upstream `specify_cli._refresh_shared_templates`).
 */
export function refreshSharedTemplates(
  projectPath: string,
  opts: {
    invokeSeparator: string;
    invokePrefix?: string;
    force?: boolean;
    version?: string;
    corePack?: string | null;
    repoRoot?: string;
    console?: SharedInfraConsole;
  },
): void {
  refreshSharedTemplatesImpl(projectPath, {
    version: opts.version ?? getSpeckitVersion(),
    corePack: resolveCorePackDefault(opts.corePack),
    repoRoot: opts.repoRoot ?? defaultRepoRoot(),
    console: opts.console ?? defaultConsole,
    invokeSeparator: opts.invokeSeparator,
    invokePrefix: opts.invokePrefix ?? '/',
    force: opts.force ?? false,
  });
}

function displayProjectPath(projectRoot: string, path: string): string {
  const rel = relative(resolvePath(projectRoot), resolvePath(path));
  if (!rel.startsWith('..') && !isAbsolute(rel)) return toPosix(rel);
  return path;
}

function rglobShFiles(root: string): string[] {
  const outFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const name of listDirSorted(dir)) {
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.sh')) outFiles.push(full);
    }
  };
  walk(root);
  return outFiles;
}

/**
 * Ensure POSIX .sh scripts under .specify/scripts and .specify/extensions
 * (recursively) have execute bits (no-op on Windows).
 */
export function ensureExecutableScripts(
  projectPath: string,
  tracker: SharedInfraTracker | null = null,
  out: SharedInfraConsole = defaultConsole,
): void {
  if (IS_WINDOWS) return;
  const scanRoots = [
    join(projectPath, '.specify', 'scripts'),
    join(projectPath, '.specify', 'extensions'),
  ];
  const failures: string[] = [];
  let updated = 0;
  for (const scriptsRoot of scanRoots) {
    if (!isDir(scriptsRoot)) continue;
    for (const script of rglobShFiles(scriptsRoot)) {
      try {
        if (isSymlink(script) || !isFile(script)) continue;
        try {
          const fd = openSync(script, 'r');
          const head = Buffer.alloc(2);
          let n = 0;
          try {
            n = readSync(fd, head, 0, 2, 0);
          } finally {
            closeSync(fd);
          }
          if (n < 2 || head[0] !== 0x23 || head[1] !== 0x21) continue;
        } catch {
          continue;
        }
        const mode = statSync(script).mode;
        if (mode & 0o111) continue;
        let newMode = mode;
        if (mode & 0o400) newMode |= 0o100;
        if (mode & 0o040) newMode |= 0o010;
        if (mode & 0o004) newMode |= 0o001;
        if (!(newMode & 0o100)) newMode |= 0o100;
        chmodSync(script, newMode & 0o7777);
        updated += 1;
      } catch (exc) {
        failures.push(`${displayProjectPath(projectPath, script)}: ${errMessage(exc)}`);
      }
    }
  }
  if (tracker) {
    const detail = `${updated} updated` + (failures.length ? `, ${failures.length} failed` : '');
    tracker.add('chmod', 'Set script permissions recursively');
    if (failures.length) tracker.error('chmod', detail);
    else tracker.complete('chmod', detail);
  } else {
    if (updated) {
      out.print(`[cyan]Updated execute permissions on ${updated} script(s) recursively[/cyan]`);
    }
    if (failures.length) {
      out.print('[yellow]Some scripts could not be updated:[/yellow]');
      for (const f of failures) out.print(`  - ${f}`);
    }
  }
}

// ============================================================================
// Skills directory helpers (upstream specify_cli/__init__.py)
// ============================================================================

/**
 * Resolve the agent-specific skills directory: `<project>/<agent folder>/skills`,
 * falling back to `<project>/.agents/skills` for unknown agents.
 */
export function getSkillsDir(projectPath: string, selectedAi: string): string {
  const agentConfig = (AGENT_CONFIG as Record<string, Record<string, unknown> | undefined>)[selectedAi] ?? {};
  const folder = agentConfig['folder'];
  if (typeof folder === 'string' && folder) {
    return join(projectPath, folder.replace(/\/+$/, ''), 'skills');
  }
  return join(projectPath, '.agents', 'skills');
}

/**
 * Return the active skills directory, creating it on demand when enabled
 * (upstream `resolve_active_skills_dir`). Returns null when skills are not
 * active. Throws when the skills path is unsafe.
 */
export function resolveActiveSkillsDir(projectRoot: string): string | null {
  let opts: unknown = loadInitOptions(projectRoot);
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) opts = {};
  const record = opts as Record<string, unknown>;

  const agent = record['ai'];
  if (typeof agent !== 'string' || !agent) return null;
  if (agent === 'generic') return null;

  const aiSkillsEnabled = isAiSkillsEnabled(record);
  if (!aiSkillsEnabled && agent !== 'kimi') return null;

  const skillsDir = getSkillsDir(projectRoot, agent);

  if (!aiSkillsEnabled) {
    if (!isDir(skillsDir)) return null;
    ensureSafeSharedDirectory(projectRoot, skillsDir, {
      create: false,
      context: 'agent skills directory',
    });
    return skillsDir;
  }

  ensureSafeSharedDirectory(projectRoot, skillsDir, { context: 'agent skills directory' });
  return skillsDir;
}

