/**
 * @oakoliver/specify-cli - Version checking and self-update domain
 *
 * Port of spec-kit `_version.py` (v1.0.12): PEP 440 version comparison,
 * latest-release lookup, install-method detection, installer invocation,
 * post-upgrade verification and user-facing failure/guidance rendering for
 * `specify self check` / `specify self upgrade`.
 *
 * Package identity is adapted: upstream self-upgrades the PyPI-less
 * `specify-cli` distribution from `git+https://github.com/github/spec-kit.git`
 * via `uv tool` / `pipx`. This port self-upgrades the npm package
 * `@oakoliver/specify-cli` (https://registry.npmjs.org/@oakoliver/specify-cli)
 * via the detected global package manager (npm / pnpm / bun / yarn).
 * Every such deviation is marked with an `// ADAPTATION:` comment.
 *
 * Mocking surface: Python tests monkeypatch module attributes. ESM exports
 * cannot be reassigned, so every side-effecting primitive (PATH lookup,
 * subprocess, fetch, installed-version lookup, editable detection, argv0) is
 * routed through the mutable `versionDeps` object, which tests override.
 *
 * @module version
 */

import { spawnSync } from 'node:child_process';
import type { SpawnSyncOptions } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { console } from './console.js';
import { MAX_JSON_METADATA_BYTES, readResponseLimited } from './download-security.js';

// ============================================================================
// Constants
// ============================================================================

/** Upstream github/spec-kit release this port is at behavioral parity with. */
export const UPSTREAM_SPEC_KIT_VERSION = '1.0.12';

/** npm package name of this CLI. */
export const NPM_PACKAGE_NAME = '@oakoliver/specify-cli';

/** npm registry document for this package. */
export const NPM_REGISTRY_PACKAGE_URL = 'https://registry.npmjs.org/@oakoliver/specify-cli';

// ADAPTATION: upstream `GITHUB_API_LATEST` points at
// https://api.github.com/repos/github/spec-kit/releases/latest and reads
// `tag_name`. We read the npm registry dist-tags document and use
// `dist-tags.latest`, rendered as a `v`-prefixed tag so the rest of the
// (tag-oriented) upstream logic is unchanged.
export const NPM_DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@oakoliver/specify-cli/dist-tags';
/** Name kept for import-surface parity with upstream (`GITHUB_API_LATEST`). */
export const GITHUB_API_LATEST = NPM_DIST_TAGS_URL;

/** npm package page (used in rollback hints instead of GitHub releases page). */
export const NPM_VERSIONS_PAGE = 'https://www.npmjs.com/package/@oakoliver/specify-cli?activeTab=versions';

export const RESOLUTION_FAILURE_OFFLINE = 'offline or timeout';
// ADAPTATION: upstream says "rate limited (configure ~/.specify/auth.json with a
// GitHub token)". The npm registry is unauthenticated for public packages, so
// the actionable hint is simply to retry later.
export const RESOLUTION_FAILURE_RATE_LIMITED = 'rate limited (try again later)';
export const RESOLUTION_FAILURE_HTTP_PREFIX = 'HTTP ';
export const FAILURE_INSTALLER_MISSING = 'installer-missing';
export const FAILURE_INSTALLER_INVALID = 'installer-invalid';
export const FAILURE_TARGET_TAG_UNPARSEABLE = 'target-tag-unparseable';
export const FAILURE_INSTALLER_TIMEOUT = 'installer-timeout';
export const FAILURE_INSTALLER_FAILED = 'installer-failed';
export const FAILURE_VERIFICATION_MISMATCH = 'verification-mismatch';

const PRERELEASE_TAG_PATTERN = /^([0-9]+\.[0-9]+\.[0-9]+)[-.]?(alpha|beta|a|b|rc)[-.]?([0-9]+)(.*)$/is;
export const TIER3_REGISTRY_TIMEOUT_SECS = 5;
export const VERIFY_TIMEOUT_SECS = 10;
export const FETCH_TIMEOUT_SECS = 5;

const RESOLUTION_FAILURE_CATEGORIES: ReadonlySet<string> = new Set([
  RESOLUTION_FAILURE_OFFLINE,
  RESOLUTION_FAILURE_RATE_LIMITED,
]);

// ============================================================================
// PEP 440 version (port of the subset of `packaging.version.Version` used)
// ============================================================================

/** Raised when a string is not a valid PEP 440 version (packaging.InvalidVersion). */
export class InvalidVersion extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidVersion';
  }
}

const PEP440_PATTERN = new RegExp(
  '^\\s*v?' +
    '(?:(?<epoch>[0-9]+)!)?' +
    '(?<release>[0-9]+(?:\\.[0-9]+)*)' +
    '(?<pre>[-_.]?(?<pre_l>alpha|beta|preview|pre|a|b|c|rc)[-_.]?(?<pre_n>[0-9]+)?)?' +
    '(?<post>(?:-(?<post_n1>[0-9]+))|(?:[-_.]?(?<post_l>post|rev|r)[-_.]?(?<post_n2>[0-9]+)?))?' +
    '(?<dev>[-_.]?(?<dev_l>dev)[-_.]?(?<dev_n>[0-9]+)?)?' +
    '(?:\\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?' +
    '\\s*$',
  'i',
);

type LocalPart = number | string;

function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** PEP 440 version with packaging-compatible ordering and canonical `toString()`. */
export class Version {
  readonly epoch: number;
  readonly release: readonly number[];
  readonly pre: readonly [string, number] | null;
  readonly post: number | null;
  readonly dev: number | null;
  readonly local: readonly LocalPart[] | null;

  constructor(text: string) {
    const m = PEP440_PATTERN.exec(text);
    if (!m || !m.groups) throw new InvalidVersion(`Invalid version: '${text}'`);
    const g = m.groups;
    this.epoch = g.epoch ? parseInt(g.epoch, 10) : 0;
    this.release = g.release.split('.').map((p) => parseInt(p, 10));
    if (g.pre_l) {
      const l = g.pre_l.toLowerCase();
      const label = l === 'alpha' ? 'a' : l === 'beta' ? 'b' : l === 'c' || l === 'pre' || l === 'preview' ? 'rc' : l;
      this.pre = [label, g.pre_n ? parseInt(g.pre_n, 10) : 0];
    } else {
      this.pre = null;
    }
    if (g.post_n1) this.post = parseInt(g.post_n1, 10);
    else if (g.post_l) this.post = g.post_n2 ? parseInt(g.post_n2, 10) : 0;
    else this.post = null;
    this.dev = g.dev_l ? (g.dev_n ? parseInt(g.dev_n, 10) : 0) : null;
    this.local = g.local
      ? g.local
          .toLowerCase()
          .split(/[-_.]/)
          .map((p) => (/^[0-9]+$/.test(p) ? parseInt(p, 10) : p))
      : null;
  }

  toString(): string {
    let out = '';
    if (this.epoch !== 0) out += `${this.epoch}!`;
    out += this.release.join('.');
    if (this.pre) out += `${this.pre[0]}${this.pre[1]}`;
    if (this.post !== null) out += `.post${this.post}`;
    if (this.dev !== null) out += `.dev${this.dev}`;
    if (this.local) out += `+${this.local.join('.')}`;
    return out;
  }

  /** Three-way comparison following packaging's `_cmpkey`. */
  compare(other: Version): number {
    let c = cmpNum(this.epoch, other.epoch);
    if (c) return c;

    const strip = (r: readonly number[]): number[] => {
      const out = [...r];
      while (out.length > 0 && out[out.length - 1] === 0) out.pop();
      return out;
    };
    const ra = strip(this.release);
    const rb = strip(other.release);
    for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
      if (i >= ra.length) return -1;
      if (i >= rb.length) return 1;
      c = cmpNum(ra[i], rb[i]);
      if (c) return c;
    }

    // pre: no pre+no post+dev => -inf ; no pre => +inf
    const preKey = (v: Version): [number, string, number] => {
      if (v.pre === null && v.post === null && v.dev !== null) return [-1, '', 0];
      if (v.pre === null) return [1, '', 0];
      return [0, v.pre[0], v.pre[1]];
    };
    const pa = preKey(this);
    const pb = preKey(other);
    c = cmpNum(pa[0], pb[0]);
    if (c) return c;
    if (pa[0] === 0) {
      c = pa[1] < pb[1] ? -1 : pa[1] > pb[1] ? 1 : 0;
      if (c) return c;
      c = cmpNum(pa[2], pb[2]);
      if (c) return c;
    }

    const postA = this.post === null ? -Infinity : this.post;
    const postB = other.post === null ? -Infinity : other.post;
    c = cmpNum(postA, postB);
    if (c) return c;

    const devA = this.dev === null ? Infinity : this.dev;
    const devB = other.dev === null ? Infinity : other.dev;
    c = cmpNum(devA, devB);
    if (c) return c;

    if (this.local === null && other.local === null) return 0;
    if (this.local === null) return -1;
    if (other.local === null) return 1;
    for (let i = 0; i < Math.max(this.local.length, other.local.length); i++) {
      if (i >= this.local.length) return -1;
      if (i >= other.local.length) return 1;
      const a = this.local[i];
      const b = other.local[i];
      // Numeric segments sort after alphanumeric ones.
      if (typeof a === 'number' && typeof b === 'number') c = cmpNum(a, b);
      else if (typeof a === 'number') c = 1;
      else if (typeof b === 'number') c = -1;
      else c = a < b ? -1 : a > b ? 1 : 0;
      if (c) return c;
    }
    return 0;
  }

  equals(other: Version): boolean {
    return this.compare(other) === 0;
  }
  gt(other: Version): boolean {
    return this.compare(other) > 0;
  }
  lt(other: Version): boolean {
    return this.compare(other) < 0;
  }
}

// ============================================================================
// Errors
// ============================================================================

/** Port of `typer.BadParameter` as raised by `_validate_tag`. */
export class BadParameter extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadParameter';
  }
}

// ============================================================================
// Types
// ============================================================================

// ADAPTATION: upstream `_InstallMethod` values are uv-tool / pipx /
// uvx-ephemeral / source-checkout / unsupported. The npm ecosystem equivalents
// are one "global install" per package manager (upgradable, like uv-tool and
// pipx), npx/bunx/pnpm dlx caches (ephemeral, like uvx), a git checkout (incl.
// `npm link`), and unsupported.
export enum InstallMethod {
  NPM_GLOBAL = 'npm-global',
  PNPM_GLOBAL = 'pnpm-global',
  BUN_GLOBAL = 'bun-global',
  YARN_GLOBAL = 'yarn-global',
  NPX_EPHEMERAL = 'npx-ephemeral',
  SOURCE_CHECKOUT = 'source-checkout',
  UNSUPPORTED = 'unsupported',
}

export const UPGRADABLE_METHODS: ReadonlySet<InstallMethod> = new Set([
  InstallMethod.NPM_GLOBAL,
  InstallMethod.PNPM_GLOBAL,
  InstallMethod.BUN_GLOBAL,
  InstallMethod.YARN_GLOBAL,
]);

export function isUpgradableMethod(method: InstallMethod): boolean {
  return UPGRADABLE_METHODS.has(method);
}

export enum InstallerResultKind {
  EXITED = 'exited',
  MISSING = 'missing',
  INVALID = 'invalid',
  TIMEOUT = 'timeout',
}

export interface InstallerResult {
  readonly kind: InstallerResultKind;
  readonly returncode: number | null;
}

export interface UpgradePlan {
  readonly method: InstallMethod;
  readonly current_version: string;
  readonly target_tag: string | null;
  readonly installer_argv: string[] | null;
  readonly preview_summary: string;
  readonly pre_upgrade_snapshot: string;
}

export interface DetectionSignals {
  readonly sys_argv0: string;
  readonly matched_tier: number | null;
  readonly matched_prefix: string | null;
  readonly editable_marker_seen: boolean;
  readonly installer_registries_consulted: readonly string[];
  readonly resolved_method: InstallMethod;
}

/** Normalized result of a synchronous child process. */
export interface SpawnResult {
  status: number | null;
  stdout: string;
  /** errno-style code when the process could not be run (ENOENT, EACCES, ETIMEDOUT, ...). */
  errorCode: string | null;
}

export interface SpawnOptions {
  capture: boolean;
  timeoutMs?: number;
  env: NodeJS.ProcessEnv;
}

// ============================================================================
// Dependency-injection surface (monkeypatch equivalent)
// ============================================================================

function defaultSpawn(argv: string[], opts: SpawnOptions): SpawnResult {
  const [cmd, ...rest] = argv;
  // ADAPTATION: Python's subprocess.run executes `npm.cmd`-style shims on
  // Windows directly; Node >= 18.20.2 refuses to spawn .cmd/.bat without a
  // shell (CVE-2024-27980), so route those through cmd.exe with quoted argv.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  const spawnOpts: SpawnSyncOptions = {
    env: opts.env,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell: needsShell,
    windowsHide: true,
  };
  if (opts.timeoutMs !== undefined) spawnOpts.timeout = opts.timeoutMs;
  const r = needsShell
    ? spawnSync(renderArgv(argv, 'win32'), [], spawnOpts)
    : spawnSync(cmd, rest, spawnOpts);
  const err = r.error as NodeJS.ErrnoException | undefined;
  return {
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : r.stdout ? String(r.stdout) : '',
    errorCode: err ? (err.code ?? 'EUNKNOWN') : null,
  };
}

/** Mutable hooks; tests override members and restore them afterwards. */
export const versionDeps = {
  /** Entry-point path (Python `sys.argv[0]`; Node `process.argv[1]`). */
  argv0: (): string => process.argv[1] ?? '',
  which: (name: string): string | null => which(name),
  spawn: defaultSpawn,
  fetch: (url: string, init?: RequestInit): Promise<Response> => globalThis.fetch(url, init),
  getInstalledVersion: (): string => readInstalledPackageVersion(),
  fetchLatestReleaseTag: (): Promise<[string | null, string | null]> => fetchLatestReleaseTagImpl(),
  editableMarkerSeen: (): boolean => editableMarkerSeenImpl(),
  sourceCheckoutPath: (): string | null => sourceCheckoutPathImpl(),
  env: (): NodeJS.ProcessEnv => process.env,
  platform: (): NodeJS.Platform => process.platform,
};

/** Snapshot of the default hooks, for tests to restore. */
export const DEFAULT_VERSION_DEPS = Object.freeze({ ...versionDeps });

export function resetVersionDeps(): void {
  Object.assign(versionDeps, DEFAULT_VERSION_DEPS);
}

// ============================================================================
// PATH lookup (shutil.which)
// ============================================================================

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform === 'win32') return true;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Port of `shutil.which` (PATH + PATHEXT aware). */
export function which(name: string): string | null {
  if (!name) return null;
  const env = process.env;
  const exts =
    process.platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
  if (name.includes('/') || (process.platform === 'win32' && name.includes('\\'))) {
    for (const ext of exts) if (isExecutableFile(name + ext)) return name + ext;
    return null;
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

// ============================================================================
// Installed version
// ============================================================================

function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/** Locate this package's root (dir with package.json named @oakoliver/specify-cli). */
export function findPackageRoot(start: string = moduleDir()): string | null {
  let dir = resolvePath(start);
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const data = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown };
        if (data.name === NPM_PACKAGE_NAME) return dir;
      } catch {
        // keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ADAPTATION: upstream reads `importlib.metadata.version("specify-cli")`; we read
// the `version` field of the installed package.json of @oakoliver/specify-cli.
function readInstalledPackageVersion(): string {
  const root = findPackageRoot();
  if (!root) return 'unknown';
  try {
    const data = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof data.version === 'string' && data.version ? data.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Return the installed @oakoliver/specify-cli version or 'unknown'. */
export function getInstalledVersion(): string {
  return versionDeps.getInstalledVersion();
}

// ============================================================================
// Version helpers
// ============================================================================

/** Normalize common git release-tag spellings into PEP 440 text. */
export function normalizeTag(tag: string): string {
  const normalized = tag.startsWith('v') ? tag.slice(1) : tag;
  const m = PRERELEASE_TAG_PATTERN.exec(normalized);
  if (!m) return normalized;
  const [, base, label, number, rest] = m;
  const lower = label.toLowerCase();
  const pep440Label = lower === 'alpha' ? 'a' : lower === 'beta' ? 'b' : lower;
  return `${base}${pep440Label}${number}${rest}`;
}

function tryVersion(text: string): Version | null {
  try {
    return new Version(text);
  } catch {
    return null;
  }
}

/** True iff `latest` is strictly greater than `current` (PEP 440). */
export function isNewer(latest: string, current: string): boolean {
  if (latest === 'unknown' || current === 'unknown') return false;
  const a = tryVersion(latest);
  const b = tryVersion(current);
  if (!a || !b) return false;
  return a.gt(b);
}

/** Parse version-like text after tag normalization, or return null. */
export function parseVersionText(value: string): Version | null {
  return tryVersion(normalizeTag(value));
}

/** Normalize version-like text for equality checks when parseable. */
export function canonicalizeVersionText(value: string): string {
  const parsed = parseVersionText(value);
  return parsed !== null ? parsed.toString() : normalizeTag(value);
}

/** Return `vX.Y.Z` only for exact stable release versions. */
export function stableReleaseTagForVersion(versionText: string): string | null {
  const parsed = parseVersionText(versionText);
  if (parsed === null) return null;
  if (parsed.pre || parsed.post !== null || parsed.dev !== null || parsed.local) return null;
  if (parsed.release.length !== 3) return null;
  return `v${parsed.release[0]}.${parsed.release[1]}.${parsed.release[2]}`;
}

// ============================================================================
// Latest release lookup
// ============================================================================

/**
 * Return [tag, failureCategory]. Exactly one outbound call, 5 s timeout.
 * Network / HTTP failures map to a category; anything else (e.g. a malformed
 * body) propagates, like upstream (no catch-all).
 */
export function fetchLatestReleaseTag(): Promise<[string | null, string | null]> {
  return versionDeps.fetchLatestReleaseTag();
}

async function fetchLatestReleaseTagImpl(): Promise<[string | null, string | null]> {
  let resp: Response;
  try {
    resp = await versionDeps.fetch(NPM_DIST_TAGS_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_SECS * 1000),
      redirect: 'follow',
    });
  } catch {
    // fetch rejects on DNS / connection / abort (timeout) failures: URLError/OSError.
    return [null, RESOLUTION_FAILURE_OFFLINE];
  }
  if (!resp.ok) {
    const code = resp.status;
    if (code === 403 || code === 429) return [null, RESOLUTION_FAILURE_RATE_LIMITED];
    return [null, `${RESOLUTION_FAILURE_HTTP_PREFIX}${code}`];
  }
  let body: Uint8Array;
  try {
    body = await readResponseLimited(resp, {
      maxBytes: MAX_JSON_METADATA_BYTES,
      label: 'npm registry latest release',
    });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'AbortError' || name === 'TimeoutError' || name === 'TypeError') {
      return [null, RESOLUTION_FAILURE_OFFLINE];
    }
    throw e;
  }
  const payload = JSON.parse(new TextDecoder('utf-8').decode(body)) as unknown;
  // ADAPTATION: upstream reads `tag_name` from the GitHub release payload; we
  // read `latest` from npm dist-tags and prefix `v` to form an equivalent tag.
  const latest =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).latest
      : undefined;
  if (typeof latest !== 'string' || !latest) {
    throw new Error('npm registry response missing valid dist-tags.latest');
  }
  return [latest.startsWith('v') ? latest : `v${latest}`, null];
}

// ============================================================================
// Argv rendering
// ============================================================================

function shlexQuote(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

/** Port of `subprocess.list2cmdline`. */
function list2cmdline(argv: string[]): string {
  const out: string[] = [];
  for (const arg of argv) {
    const needQuote = arg === '' || /[ \t]/.test(arg);
    let buf = needQuote ? '"' : '';
    let bs = 0;
    for (const ch of arg) {
      if (ch === '\\') {
        bs++;
      } else if (ch === '"') {
        buf += '\\'.repeat(bs * 2) + '\\"';
        bs = 0;
      } else {
        buf += '\\'.repeat(bs) + ch;
        bs = 0;
      }
    }
    buf += '\\'.repeat(needQuote ? bs * 2 : bs);
    if (needQuote) buf += '"';
    out.push(buf);
  }
  return out.join(' ');
}

/** Render argv as POSIX shell text, or cmd.exe-style text on Windows. */
export function renderArgv(argv: string[], platform: NodeJS.Platform = versionDeps.platform()): string {
  return platform === 'win32' ? list2cmdline(argv) : argv.map(shlexQuote).join(' ');
}

// ============================================================================
// Env scrubbing
// ============================================================================

const GITHUB_CREDENTIAL_SUFFIXES = ['_TOKEN', '_SECRET', '_KEY', '_PAT', '_PASSWORD', '_CREDENTIALS'];

/** Whether an env key should be scrubbed as a GitHub credential. */
export function isGithubCredentialEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (upper.startsWith('GH_') || upper.startsWith('GITHUB_')) return true;
  return upper.includes('_GITHUB_') && GITHUB_CREDENTIAL_SUFFIXES.some((s) => upper.endsWith(s));
}

/**
 * Copy of the environment without GitHub credential keys.
 * (npm auth such as NPM_TOKEN is deliberately preserved: the installer needs it.)
 */
export function scrubbedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(versionDeps.env())) {
    if (v !== undefined && !isGithubCredentialEnvKey(k)) out[k] = v;
  }
  return out;
}

// ============================================================================
// Tag validation
// ============================================================================

const TAG_REGEX =
  /^v[0-9]+\.[0-9]+\.[0-9]+(?:(?:\.?dev[0-9]+)|(?:[-.]?(?:a|b|rc|alpha|beta)[-.]?[0-9]+))?(?:\+[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?$/;
export const INVALID_TAG_MESSAGE = 'Invalid --tag: expected vMAJOR.MINOR.PATCH[suffix]';

/** Validate a user-supplied --tag value (throws BadParameter). */
export function validateTag(tag: string): string {
  // Python str.strip() strips Unicode whitespace; String#trim() matches closely.
  tag = tag.trim();
  if (!tag) throw new BadParameter(INVALID_TAG_MESSAGE);
  if (tag.slice(0, 1) === 'V') tag = 'v' + tag.slice(1);
  if (!TAG_REGEX.test(tag)) throw new BadParameter(INVALID_TAG_MESSAGE);
  if (tryVersion(normalizeTag(tag)) === null) throw new BadParameter(INVALID_TAG_MESSAGE);
  return tag;
}

// ============================================================================
// Install method detection
// ============================================================================

// ADAPTATION: upstream matches `sys.argv[0]` against fixed per-installer
// directory prefixes (~/.local/share/uv/tools/specify-cli/, ~/.local/pipx/venvs/
// specify-cli/, ~/.cache/uv/archive-v0/ and %LOCALAPPDATA% equivalents). npm's
// global prefix is not a fixed directory (/usr/local, /opt/homebrew, nvm, fnm,
// %APPDATA%\npm, ...), so tier 1 matches the realpath of the running entrypoint
// against package-manager-specific path *segments* instead. Paths are compared
// with forward slashes (and case-insensitively on Windows). Order matters:
// ephemeral caches and manager-specific layouts are tested before the generic
// npm `node_modules` layouts.
const PKG_SEG = '/node_modules/@oakoliver/specify-cli/';
export const INSTALLER_PATH_PATTERNS: ReadonlyArray<readonly [InstallMethod, string, RegExp]> = [
  [InstallMethod.NPX_EPHEMERAL, '~/.npm/_npx/', /\/_npx\//],
  [InstallMethod.NPX_EPHEMERAL, '$TMPDIR/bunx-*/', /\/bunx-[^/]+\//],
  [InstallMethod.NPX_EPHEMERAL, 'pnpm dlx cache', /\/pnpm\/dlx\//],
  [InstallMethod.NPX_EPHEMERAL, 'yarn dlx cache', /\/dlx-[0-9]+\//],
  [InstallMethod.BUN_GLOBAL, '~/.bun/install/global' + PKG_SEG, /\/install\/global\/node_modules\/@oakoliver\/specify-cli\//],
  [InstallMethod.PNPM_GLOBAL, '$PNPM_HOME/global/<n>/...' + PKG_SEG, /\/global\/[0-9]+\/(?:.*\/)?node_modules\/@oakoliver\/specify-cli\//],
  [InstallMethod.YARN_GLOBAL, '~/.config/yarn/global' + PKG_SEG, /\/yarn\/(?:data\/)?global\/node_modules\/@oakoliver\/specify-cli\//],
  [InstallMethod.NPM_GLOBAL, '<prefix>/lib' + PKG_SEG, /\/lib\/node_modules\/@oakoliver\/specify-cli\//],
  [InstallMethod.NPM_GLOBAL, '%APPDATA%\\npm' + PKG_SEG, /\/npm\/node_modules\/@oakoliver\/specify-cli\//],
  [InstallMethod.NPM_GLOBAL, '<nodejs dir>' + PKG_SEG, /\/nodejs\/node_modules\/@oakoliver\/specify-cli\//],
];

function toMatchablePath(p: string, platform: NodeJS.Platform): string {
  let out = p.replace(/\\/g, '/');
  if (platform === 'win32') out = out.toLowerCase();
  return out;
}

function resolvePathOrOriginal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Resolve the running entrypoint path, consulting PATH for bare commands. */
export function resolvedArgv0Path(argv0?: string): string {
  const raw = argv0 || versionDeps.argv0();
  if (isAbsolute(raw)) return resolvePathOrOriginal(raw);
  if (raw && existsSync(raw)) return resolvePathOrOriginal(resolvePath(raw));

  const lookupNames = [raw];
  if (raw.includes('/') || raw.includes(sep)) lookupNames.push(basename(raw));
  if (!lookupNames.includes('specify')) lookupNames.push('specify');
  for (const name of lookupNames) {
    if (!name) continue;
    const found = versionDeps.which(name);
    if (found) return resolvePathOrOriginal(found);
  }
  return raw;
}

/** Whether a path looks like the `specify` CLI entrypoint. */
export function looksLikeSpecifyEntrypoint(p: string): boolean {
  return ['specify', 'specify.exe', 'specify.cmd', 'specify-cli', 'specify-cli.exe', 'specify-cli.cmd'].includes(
    basename(p).toLowerCase(),
  );
}

function tier3RegistryLookupAllowed(argv0Path: string): boolean {
  return isAbsolute(argv0Path) && !existsSync(argv0Path);
}

/** Closest ancestor containing `.git`. */
export function gitAncestor(p: string): string | null {
  let dir = resolvePath(p);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ADAPTATION: upstream reads PEP 610 `direct_url.json` (`dir_info.editable`).
// npm has no editable marker; the equivalent is "this package's root is not
// inside any node_modules directory and lives in a git worktree" (a clone run
// directly, or `npm link`, whose symlink realpath points into the clone).
function editableCheckoutRoot(): string | null {
  const root = findPackageRoot(resolvePathOrOriginal(moduleDir()));
  if (!root) return null;
  if (toMatchablePath(root, process.platform).split('/').includes('node_modules')) return null;
  return root;
}

function editableMarkerSeenImpl(): boolean {
  const root = editableCheckoutRoot();
  return root !== null && gitAncestor(root) !== null;
}

function sourceCheckoutPathImpl(): string | null {
  const root = editableCheckoutRoot();
  return root ? gitAncestor(root) : null;
}

export function editableMarkerSeen(): boolean {
  return versionDeps.editableMarkerSeen();
}

export function sourceCheckoutPath(): string | null {
  return versionDeps.sourceCheckoutPath();
}

// ADAPTATION: upstream tier 3 consults `uv tool list` and `pipx list --json`.
// We consult each package manager's global listing for an exact package name.
interface RegistryProbe {
  method: InstallMethod;
  binary: string;
  args: string[];
  label: string;
  matches: (stdout: string) => boolean;
}

function jsonDepsContain(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(jsonDepsContain);
  if (value && typeof value === 'object') {
    const deps = (value as Record<string, unknown>).dependencies;
    return !!deps && typeof deps === 'object' && !Array.isArray(deps) && NPM_PACKAGE_NAME in (deps as object);
  }
  return false;
}

/** Whether text listing output contains an exact `@oakoliver/specify-cli@<ver>` token. */
export function listingContainsPackage(stdout: string): boolean {
  for (const raw of stdout.split(/\r?\n/)) {
    for (const token of raw.split(/[\s"'`]+/)) {
      const t = token.replace(/^[├└│─┬\s]+/, '');
      if (t === NPM_PACKAGE_NAME || t.startsWith(`${NPM_PACKAGE_NAME}@`)) return true;
    }
  }
  return false;
}

const REGISTRY_PROBES: RegistryProbe[] = [
  {
    method: InstallMethod.NPM_GLOBAL,
    binary: 'npm',
    args: ['ls', '--global', '--json', '--depth=0'],
    label: 'npm ls --global --json',
    matches: (s) => jsonDepsContain(JSON.parse(s || 'null')),
  },
  {
    method: InstallMethod.PNPM_GLOBAL,
    binary: 'pnpm',
    args: ['ls', '--global', '--json', '--depth=0'],
    label: 'pnpm ls --global --json',
    matches: (s) => jsonDepsContain(JSON.parse(s || 'null')),
  },
  {
    method: InstallMethod.BUN_GLOBAL,
    binary: 'bun',
    args: ['pm', 'ls', '--global'],
    label: 'bun pm ls --global',
    matches: listingContainsPackage,
  },
  {
    method: InstallMethod.YARN_GLOBAL,
    binary: 'yarn',
    args: ['global', 'list'],
    label: 'yarn global list',
    matches: listingContainsPackage,
  },
];

/** Classify the current runtime into exactly one InstallMethod. */
export function detectInstallMethod(argv0?: string): InstallMethod;
export function detectInstallMethod(argv0: string | undefined, includeSignals: true): [InstallMethod, DetectionSignals];
export function detectInstallMethod(
  argv0?: string,
  includeSignals = false,
): InstallMethod | [InstallMethod, DetectionSignals] {
  const argv0Path = resolvedArgv0Path(argv0);
  const platform = versionDeps.platform();
  const matchable = toMatchablePath(argv0Path, platform);

  const result = (
    method: InstallMethod,
    tier: number | null,
    prefix: string | null,
    editable: boolean,
    consulted: string[],
  ): InstallMethod | [InstallMethod, DetectionSignals] =>
    includeSignals
      ? [
          method,
          {
            sys_argv0: argv0Path,
            matched_tier: tier,
            matched_prefix: prefix,
            editable_marker_seen: editable,
            installer_registries_consulted: consulted,
            resolved_method: method,
          },
        ]
      : method;

  // --- Tier 1: path pattern match ---
  if (isAbsolute(argv0Path) || /^[a-zA-Z]:[\\/]/.test(argv0Path)) {
    for (const [method, label, pattern] of INSTALLER_PATH_PATTERNS) {
      if (pattern.test(matchable)) return result(method, 1, label, false, []);
    }
  }

  // --- Tier 2: editable / checkout marker ---
  if (versionDeps.editableMarkerSeen()) {
    return result(InstallMethod.SOURCE_CHECKOUT, 2, null, true, []);
  }

  // --- Tier 3: PATH + registry reconciliation ---
  const consulted: string[] = [];
  if (tier3RegistryLookupAllowed(argv0Path)) {
    const matches: InstallMethod[] = [];
    for (const probe of REGISTRY_PROBES) {
      const bin = versionDeps.which(probe.binary);
      if (bin === null) continue;
      consulted.push(probe.label);
      try {
        const r = versionDeps.spawn([bin, ...probe.args], {
          capture: true,
          timeoutMs: TIER3_REGISTRY_TIMEOUT_SECS * 1000,
          env: scrubbedEnv(),
        });
        if (r.errorCode === null && r.status === 0 && probe.matches(r.stdout)) matches.push(probe.method);
      } catch {
        // malformed JSON / spawn errors are ignored, like upstream
      }
    }
    // Ambiguous when more than one registry claims ownership.
    if (matches.length === 1) return result(matches[0], 3, null, false, consulted);
  }

  return result(InstallMethod.UNSUPPORTED, null, null, false, consulted);
}

// ============================================================================
// Installer argv / labels
// ============================================================================

export const MANUAL_TAG_PLACEHOLDER = 'vX.Y.Z';

/** npm version spec for a tag (`v1.2.3` -> `1.2.3`). */
function npmVersionForTag(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

// ADAPTATION: upstream `_source_spec` builds `git+https://github.com/github/
// spec-kit.git@<tag>`; we build an npm package spec `@oakoliver/specify-cli@<ver>`
// (defaulting to the `latest` dist-tag).
export function sourceSpec(targetTag: string | null): string {
  return `${NPM_PACKAGE_NAME}@${targetTag ? npmVersionForTag(targetTag) : 'latest'}`;
}

// ADAPTATION: upstream uses the `vX.Y.Z` placeholder because a bare git spec
// would install unreleased `main`. The npm `latest` dist-tag always names a
// published release, so it is a safe copy/paste fallback.
export function manualSourceSpec(targetTag: string | null): string {
  return sourceSpec(targetTag);
}

/** Validated release tag for copy/paste guidance, or null. */
export function manualTagOrPlaceholder(tag: string | null): string | null {
  if (tag === null) return null;
  try {
    return validateTag(tag);
  } catch (e) {
    if (e instanceof BadParameter) return null;
    throw e;
  }
}

/** Manual reinstall command lines (upstream: uv tool install / pipx install). */
export function manualInstallCommands(targetTag: string | null): string[] {
  const spec = manualSourceSpec(targetTag);
  return [`npm install --global ${spec}`, `pnpm add --global ${spec}`, `bun add --global ${spec}`, `yarn global add ${spec}`];
}

function installerArgsFor(method: InstallMethod, spec: string): string[] | null {
  switch (method) {
    case InstallMethod.NPM_GLOBAL:
      return ['install', '--global', spec];
    case InstallMethod.PNPM_GLOBAL:
      return ['add', '--global', spec];
    case InstallMethod.BUN_GLOBAL:
      return ['add', '--global', spec];
    case InstallMethod.YARN_GLOBAL:
      return ['global', 'add', spec];
    default:
      return null;
  }
}

/** Installer executable name for upgradable methods. */
export function installerBinaryName(method: InstallMethod): string | null {
  switch (method) {
    case InstallMethod.NPM_GLOBAL:
      return 'npm';
    case InstallMethod.PNPM_GLOBAL:
      return 'pnpm';
    case InstallMethod.BUN_GLOBAL:
      return 'bun';
    case InstallMethod.YARN_GLOBAL:
      return 'yarn';
    default:
      return null;
  }
}

/** Build the installer argv for an upgradable install method. */
export function assembleInstallerArgv(method: InstallMethod, targetTag: string | null): string[] | null {
  const name = installerBinaryName(method);
  if (name === null) return null;
  const bin = versionDeps.which(name);
  if (bin === null) return null;
  const args = installerArgsFor(method, sourceSpec(targetTag));
  return args ? [bin, ...args] : null;
}

/** Whether an argv[0] names a path rather than a bare command. */
export function isPathLikeCommand(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

/** User-facing label for an install method. */
export function methodLabel(method: InstallMethod): string {
  switch (method) {
    case InstallMethod.NPM_GLOBAL:
      return 'npm (global)';
    case InstallMethod.PNPM_GLOBAL:
      return 'pnpm (global)';
    case InstallMethod.BUN_GLOBAL:
      return 'bun (global)';
    case InstallMethod.YARN_GLOBAL:
      return 'yarn (global)';
    case InstallMethod.NPX_EPHEMERAL:
      return 'npx (ephemeral)';
    case InstallMethod.SOURCE_CHECKOUT:
      return 'source checkout';
    case InstallMethod.UNSUPPORTED:
      return 'unsupported';
  }
}

// ============================================================================
// Upgrade plan
// ============================================================================

/** Return [plan, null] or [null|plan, failureReason]. */
export async function buildUpgradePlan(
  targetTagOverride: string | null,
): Promise<[UpgradePlan | null, string | null]> {
  const method = detectInstallMethod();

  let targetTag: string | null;
  if (targetTagOverride !== null) {
    targetTag = targetTagOverride;
  } else if (isUpgradableMethod(method)) {
    const [tag, failureReason] = await versionDeps.fetchLatestReleaseTag();
    if (tag === null) return [null, failureReason];
    try {
      targetTag = validateTag(tag);
    } catch (e) {
      if (!(e instanceof BadParameter)) throw e;
      const current = versionDeps.getInstalledVersion();
      return [
        {
          method,
          current_version: current,
          target_tag: tag,
          installer_argv: null,
          preview_summary: '',
          pre_upgrade_snapshot: current,
        },
        FAILURE_TARGET_TAG_UNPARSEABLE,
      ];
    }
  } else {
    targetTag = null;
  }

  const current = versionDeps.getInstalledVersion();
  const argv = assembleInstallerArgv(method, targetTag);
  let commandPreview: string;
  if (argv === null && isUpgradableMethod(method)) {
    commandPreview = `(installer ${installerBinaryName(method)} not found on PATH)`;
  } else {
    commandPreview = argv !== null ? renderArgv(argv) : '(none — non-upgradable path)';
  }

  const preview =
    `Detected install method: ${methodLabel(method)}\n` +
    `Current version: ${current}\n` +
    `Target version: ${targetTag || '(not resolved for this install method)'}\n` +
    `Command that would be executed: ${commandPreview}`;

  return [
    {
      method,
      current_version: current,
      target_tag: targetTag,
      installer_argv: argv,
      preview_summary: preview,
      pre_upgrade_snapshot: current,
    },
    null,
  ];
}

// ============================================================================
// Installer execution
// ============================================================================

function warnInvalidUpgradeTimeout(raw: string): void {
  console.print(
    `Ignoring invalid SPECIFY_UPGRADE_TIMEOUT_SECS=${pyRepr(raw)}; running without a timeout.`,
  );
}

/** Minimal Python `repr()` for a str. */
function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  const body = s.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`);
  return `${quote}${body}${quote}`;
}

function pathKind(p: string): 'missing' | 'invalid' | 'ok' {
  if (!existsSync(p)) return 'missing';
  return isExecutableFile(p) ? 'ok' : 'invalid';
}

/** Invoke the installer subprocess with inherited stdio and scrubbed env. */
export function runInstaller(plan: UpgradePlan): InstallerResult {
  if (plan.installer_argv === null) {
    throw new Error(
      'internal routing error: runInstaller received a plan without an installer_argv ' +
        '(non-upgradable methods must route to emitGuidance)',
    );
  }
  const installerName = plan.installer_argv[0];
  if (isAbsolute(installerName) || isPathLikeCommand(installerName)) {
    const kind = pathKind(installerName);
    if (kind === 'missing') return { kind: InstallerResultKind.MISSING, returncode: null };
    if (kind === 'invalid') return { kind: InstallerResultKind.INVALID, returncode: null };
  } else if (versionDeps.which(installerName) === null) {
    return { kind: InstallerResultKind.MISSING, returncode: null };
  }

  const timeoutRaw = versionDeps.env().SPECIFY_UPGRADE_TIMEOUT_SECS;
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    const trimmed = timeoutRaw.trim();
    // Python float() accepts "inf"/"nan"; Number() rejects them -> same warning path.
    const value = /^[+-]?(inf(inity)?|nan)$/i.test(trimmed) ? NaN : trimmed === '' ? NaN : Number(trimmed);
    if (Number.isNaN(value) || value <= 0 || !Number.isFinite(value)) {
      warnInvalidUpgradeTimeout(timeoutRaw);
    } else {
      timeoutMs = Math.ceil(value * 1000);
    }
  }

  const r = versionDeps.spawn(plan.installer_argv, { capture: false, timeoutMs, env: scrubbedEnv() });
  if (r.errorCode !== null) {
    if (r.errorCode === 'ETIMEDOUT') return { kind: InstallerResultKind.TIMEOUT, returncode: null };
    if (r.errorCode === 'ENOENT') return { kind: InstallerResultKind.MISSING, returncode: null };
    if (['EACCES', 'EPERM', 'ENOEXEC', 'EISDIR'].includes(r.errorCode)) {
      return { kind: InstallerResultKind.INVALID, returncode: null };
    }
    throw new Error(`Installer could not be started: ${r.errorCode}`);
  }
  // A signal-terminated child has status null; mirror Python's negative returncode.
  return { kind: InstallerResultKind.EXITED, returncode: r.status ?? 1 };
}

// ============================================================================
// Verification
// ============================================================================

const VERIFY_VERSION_LINE_RE = /^\s*(?:specify|specify-cli)\b(.*)$/i;

/** First parseable version token from `specify --version` output. */
export function parseVerifyVersionOutput(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = VERIFY_VERSION_LINE_RE.exec(line);
    if (!m) continue;
    for (const token of m[1].split(/\s+/).filter(Boolean)) {
      if (parseVersionText(token) !== null) return token;
    }
  }
  return null;
}

/** Spawn a child `specify --version` and parse its output. */
export function verifyUpgrade(_plan: UpgradePlan): string | null {
  const argv0 = resolvedArgv0Path();
  const specifyBin =
    existsSync(argv0) && isExecutableFile(argv0) && looksLikeSpecifyEntrypoint(argv0)
      ? argv0
      : versionDeps.which('specify');
  if (specifyBin === null) return null;
  let r: SpawnResult;
  try {
    r = versionDeps.spawn([specifyBin, '--version'], {
      capture: true,
      timeoutMs: VERIFY_TIMEOUT_SECS * 1000,
      env: scrubbedEnv(),
    });
  } catch {
    return null;
  }
  if (r.errorCode !== null || r.status !== 0) return null;
  // Strip ANSI in case the child renders a coloured banner.
  // eslint-disable-next-line no-control-regex
  return parseVerifyVersionOutput((r.stdout || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
}

// ============================================================================
// Guidance / failure rendering
// ============================================================================

/** Print path-specific guidance for non-upgradable install methods. */
export function emitGuidance(method: InstallMethod, targetTag: string | null): void {
  if (method === InstallMethod.NPX_EPHEMERAL) {
    // ADAPTATION: upstream "Running via uvx (ephemeral); the next uvx invocation
    // already resolves to latest — no upgrade action needed."
    console.print(
      'Running via npx (ephemeral); the next npx invocation already ' +
        `resolves to latest (use ${NPM_PACKAGE_NAME}@latest) — no upgrade action needed.`,
    );
    return;
  }

  if (method === InstallMethod.SOURCE_CHECKOUT) {
    const tree = versionDeps.sourceCheckoutPath();
    if (tree === null) {
      console.print(
        'Running from a source checkout, but the checkout path could not ' +
          'be detected; upgrade by running the following commands from your ' +
          'checkout directory:',
      );
    } else {
      console.print(
        `Running from a source checkout at ${tree}; ` +
          'upgrade by running the following commands from that directory:',
      );
    }
    console.print('  git pull');
    // ADAPTATION: upstream prints "pip install -e ."
    console.print('  npm install');
    console.print('  npm run build');
    return;
  }

  if (method === InstallMethod.UNSUPPORTED) {
    console.print('Could not identify your install method automatically; run one of the following manually:');
    for (const line of manualInstallCommands(targetTag)) console.print(`  ${line}`);
    return;
  }

  throw new Error(`internal routing error: emitGuidance called on upgradable method: ${method}`);
}

/** Manual rollback suggestion from the pre-upgrade version. */
export function rollbackHint(plan: UpgradePlan): string {
  if (plan.pre_upgrade_snapshot === 'unknown') {
    return `Could not determine the previous version; reinstall manually from: ${NPM_VERSIONS_PAGE}`;
  }
  const rollbackTag = stableReleaseTagForVersion(plan.pre_upgrade_snapshot);
  if (rollbackTag === null) {
    return (
      'Previous version was not an exact stable release tag; ' +
      `reinstall manually from: ${NPM_VERSIONS_PAGE}`
    );
  }
  const spec = sourceSpec(rollbackTag);
  const method = isUpgradableMethod(plan.method) ? plan.method : InstallMethod.NPM_GLOBAL;
  const name = installerBinaryName(method) ?? 'npm';
  const args = installerArgsFor(method, spec) ?? ['install', '--global', spec];
  return `To pin back to the previous version: ${[name, ...args].join(' ')}`;
}

export interface EmitFailureOptions {
  plan?: UpgradePlan | null;
  installerExit?: number | null;
  installerName?: string | null;
  verifiedVersion?: string | null;
}

/** Render user-facing output for resolver, installer, or verification failures. */
export function emitFailure(category: string, opts: EmitFailureOptions = {}): void {
  const { plan = null, installerExit = null, installerName = null, verifiedVersion = null } = opts;

  if (RESOLUTION_FAILURE_CATEGORIES.has(category) || category.startsWith(RESOLUTION_FAILURE_HTTP_PREFIX)) {
    console.print(`Upgrade aborted: ${category}`);
    return;
  }

  const pathLike = !!installerName && (isAbsolute(installerName) || isPathLikeCommand(installerName));

  if (category === FAILURE_INSTALLER_MISSING) {
    if (pathLike) {
      console.print(`Installer path ${installerName} no longer exists; reinstall it and retry.`);
    } else {
      console.print(`Installer ${installerName || '(unknown)'} not found on PATH; reinstall it and retry.`);
    }
    return;
  }

  if (category === FAILURE_INSTALLER_INVALID) {
    const name = installerName || '(unknown)';
    console.print(
      pathLike
        ? `Installer path ${name} is not an executable file; fix the path or reinstall it and retry.`
        : `Installer ${name} is not executable; fix the command or reinstall it and retry.`,
    );
    return;
  }

  if (category === FAILURE_TARGET_TAG_UNPARSEABLE) {
    if (plan === null) throw new Error('internal routing error: target-tag-unparseable requires plan to be set');
    console.print('Upgrade aborted: resolved release tag is not a comparable version.');
    console.print('Try again later or pin a stable release with --tag vX.Y.Z.');
    return;
  }

  if (category === FAILURE_INSTALLER_TIMEOUT) {
    if (plan === null) throw new Error('internal routing error: installer-timeout requires plan to be set');
    const argvStr = plan.installer_argv ? renderArgv(plan.installer_argv) : '';
    const timeoutValue = versionDeps.env().SPECIFY_UPGRADE_TIMEOUT_SECS ?? '(unknown)';
    console.print('Upgrade timed out while waiting for the installer subprocess.');
    console.print(`Configured timeout: SPECIFY_UPGRADE_TIMEOUT_SECS=${timeoutValue}`);
    console.print(`Try again or run the command manually: ${argvStr}`);
    console.print(rollbackHint(plan));
    return;
  }

  if (category === FAILURE_INSTALLER_FAILED) {
    if (plan === null || installerExit === null) {
      throw new Error('internal routing error: installer-failed requires both plan and installer_exit to be set');
    }
    const argvStr = plan.installer_argv ? renderArgv(plan.installer_argv) : '';
    console.print(`Upgrade failed. Installer exit code: ${installerExit}.`);
    console.print(`Try again or run the command manually: ${argvStr}`);
    console.print(rollbackHint(plan));
    return;
  }

  if (category === FAILURE_VERIFICATION_MISMATCH) {
    if (plan === null) throw new Error('internal routing error: verification-mismatch requires plan to be set');
    console.print(
      `Verification failed: installer reported success but 'specify --version' resolves to ` +
        `${verifiedVersion || '(unknown)'} (expected ${plan.target_tag}).`,
    );
    console.print('The new version may take effect on your next invocation.');
    return;
  }

  throw new Error(`Unknown failure category: ${pyRepr(category)}`);
}

// ============================================================================
// `specify version` runtime info helpers
// ============================================================================

export interface RuntimeInfo {
  /** Runtime name ("Node" or "Bun"); analogue of upstream's "Python" row. */
  runtimeName: string;
  runtimeVersion: string;
  platform: string;
  architecture: string;
  osVersion: string;
  /** TLS library as loaded by the runtime, or '' when unavailable. */
  openssl: string;
}

/** Collect runtime/platform info reported by `specify version`. */
export async function getRuntimeInfo(): Promise<RuntimeInfo> {
  const os = await import('node:os');
  const versions = process.versions as NodeJS.ProcessVersions & { bun?: string; boringssl?: string };
  const isBun = typeof versions.bun === 'string';
  const osType = os.type();
  const machine = typeof (os as { machine?: () => string }).machine === 'function' ? os.machine() : os.arch();
  // ADAPTATION: upstream reports `ssl.OPENSSL_VERSION` (e.g. "OpenSSL 3.0.2 15 Mar 2022");
  // Node exposes process.versions.openssl, Bun exposes process.versions.boringssl.
  let openssl = '';
  // Bun links BoringSSL but also reports a nominal `openssl` compat string; prefer the real one.
  if (isBun && versions.boringssl) openssl = `BoringSSL ${versions.boringssl}`;
  else if (versions.openssl) openssl = `OpenSSL ${versions.openssl}`;
  else if (versions.boringssl) openssl = `BoringSSL ${versions.boringssl}`;
  return {
    runtimeName: isBun ? 'Bun' : 'Node',
    runtimeVersion: isBun ? (versions.bun as string) : process.versions.node,
    platform: osType === 'Windows_NT' ? 'Windows' : osType,
    architecture: machine,
    osVersion: typeof os.version === 'function' ? os.version() : os.release(),
    openssl,
  };
}
