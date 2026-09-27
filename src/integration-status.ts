/**
 * @oakoliver/specify-cli - Integration Status
 *
 * Read-only status reporting for project integration state
 * (port of `integration_status.py`).
 *
 * @module integration-status
 */

import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

import {
  INTEGRATION_JSON,
  INTEGRATION_STATE_SCHEMA,
  IntegrationReadError,
  defaultIntegrationKey,
  installedIntegrationKeys,
  pyTypeName,
  tryReadIntegrationJsonWithRaw,
  type IntegrationState,
} from './integration-state.js';
import { INTEGRATION_REGISTRY } from './integrations/index.js';
import { IntegrationManifest } from './integrations/manifest.js';

// ============================================================================
// Types
// ============================================================================

export type Severity = 'error' | 'warning';

export interface IntegrationStatusFinding {
  severity: Severity | string;
  code: string;
  message: string;
  integration?: string;
  path?: string;
  suggestion?: string;
}

export interface ManifestSummary {
  manifest: string;
  readable: boolean;
  tracked_files: number;
  missing_files: string[];
  modified_files: string[];
  invalid_files: string[];
}

export interface IntegrationStatusReport {
  status: 'ok' | 'warning' | 'error';
  default_integration: string | null;
  installed_integrations: string[];
  recorded_installed_integrations: string[];
  manifest_checked_integrations: string[];
  multi_install_safe: boolean | null;
  shared_templates_target_alignment: string | null;
  missing_managed_files: number;
  modified_managed_files: number;
  invalid_manifest_paths: number;
  unchecked_manifests: number;
  manifests: Record<string, ManifestSummary>;
  findings: IntegrationStatusFinding[];
}

// ============================================================================
// Constants
// ============================================================================

const MANIFEST_KEY_RE = /^[A-Za-z0-9._-]+$/;
const WINDOWS_RESERVED_MANIFEST_BASENAMES = new Set<string>([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);
const SHARED_MANIFEST_KEY = 'speckit';

// ============================================================================
// Registry access (tolerates object or Map registries)
// ============================================================================

function registryHas(key: string): boolean {
  const reg = INTEGRATION_REGISTRY as unknown;
  if (reg instanceof Map) return reg.has(key);
  return Object.prototype.hasOwnProperty.call(reg as object, key);
}

function registryGet(key: string): unknown {
  const reg = INTEGRATION_REGISTRY as unknown;
  if (reg instanceof Map) return reg.get(key);
  return (reg as Record<string, unknown>)[key];
}

function isMultiInstallSafe(integration: unknown): boolean {
  if (!integration || typeof integration !== 'object') return false;
  const rec = integration as Record<string, unknown>;
  return Boolean(rec['multiInstallSafe'] ?? rec['multi_install_safe'] ?? false);
}

// ============================================================================
// Helpers
// ============================================================================

function finding(
  severity: Severity,
  code: string,
  message: string,
  extra: { integration?: string | null; path?: string | null; suggestion?: string | null } = {},
): IntegrationStatusFinding {
  const item: IntegrationStatusFinding = { severity, code, message };
  if (extra.integration) item.integration = extra.integration;
  if (extra.path) item.path = extra.path;
  if (extra.suggestion) item.suggestion = extra.suggestion;
  return item;
}

function statusOf(findings: IntegrationStatusFinding[]): 'ok' | 'warning' | 'error' {
  if (findings.some((item) => item.severity === 'error')) return 'error';
  if (findings.length > 0) return 'warning';
  return 'ok';
}

function withErrorDetail(message: string, error: IntegrationReadError): string {
  if (error.detail) return `${message} Detail: ${error.detail}`;
  return message;
}

function integrationStateErrorMessage(error: IntegrationReadError): string {
  if (error.kind === 'decode') {
    return withErrorDetail(`${INTEGRATION_JSON} contains invalid JSON or is not valid UTF-8.`, error);
  }
  if (error.kind === 'os') {
    return withErrorDetail(`Could not read ${INTEGRATION_JSON}.`, error);
  }
  if (error.kind === 'not_object') {
    return `${INTEGRATION_JSON} must contain a JSON object, got ${error.detail}.`;
  }
  if (error.kind === 'schema_too_new') {
    return (
      `${INTEGRATION_JSON} uses integration state schema ${error.schema}, ` +
      `which is newer than this CLI supports; supported schema: ${INTEGRATION_STATE_SCHEMA}.`
    );
  }
  return `Could not inspect ${INTEGRATION_JSON}.`;
}

/** Chunked SHA-256 of a file. */
function sha256File(path: string): string {
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

/** Drop the Windows `\\?\` extended-length prefix for path comparison. */
function stripExtendedLengthPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice('\\\\?\\UNC\\'.length);
  if (p.startsWith('\\\\?\\')) return p.slice('\\\\?\\'.length);
  return p;
}

function isWithinProject(projectRootResolved: string, candidate: string): boolean {
  const root = stripExtendedLengthPrefix(projectRootResolved);
  const cand = stripExtendedLengthPrefix(candidate);
  if (cand === root) return true;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return cand.startsWith(rootWithSep);
}

/** `Path.resolve(strict=False)` */
function resolveLoose(p: string): string {
  const abs = resolvePath(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(resolveLoose(parent), basename(abs));
  }
}

function isSymlinkSafe(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function relParts(rel: string): string[] {
  return rel.split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
}

function safeManifestFile(
  projectRoot: string,
  projectRootResolved: string,
  rel: string,
  projectRootIsResolved = true,
): string | null {
  const parts = relParts(rel);
  if (isAbsolute(rel) || parts.includes('..')) return null;
  const candidate = join(projectRoot, ...parts);
  if (!projectRootIsResolved) {
    let walk = projectRoot;
    for (const part of parts.slice(0, -1)) {
      walk = join(walk, part);
      if (isSymlinkSafe(walk)) return null;
    }
  }
  let candidateParent: string;
  try {
    candidateParent = projectRootIsResolved ? resolveLoose(dirname(candidate)) : resolvePath(dirname(candidate));
  } catch {
    return null;
  }
  if (!isWithinProject(projectRootResolved, candidateParent)) return null;
  return candidate;
}

/**
 * Classify a tracked symlink without following it outside the project.
 * Returns "modified", "invalid", or "missing".
 */
function trackedSymlinkManifestStatus(
  path: string,
  projectRootResolved: string,
  projectRootIsResolved = true,
): 'modified' | 'invalid' | 'missing' {
  let target: string;
  try {
    target = readlinkSync(path);
  } catch {
    return 'modified';
  }
  const targetPath = isAbsolute(target) ? target : join(dirname(path), target);
  let containedParent: string;
  try {
    containedParent = projectRootIsResolved ? resolveLoose(dirname(targetPath)) : resolvePath(dirname(targetPath));
  } catch {
    return 'invalid';
  }
  if (!isWithinProject(projectRootResolved, containedParent)) return 'invalid';
  try {
    lstatSync(targetPath);
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'modified';
  }
  return 'modified';
}

function resolveProjectRootForStatus(
  projectRoot: string,
  findings: IntegrationStatusFinding[],
): [string, boolean] {
  try {
    return [realpathSync.native(resolvePath(projectRoot)), true];
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Python's non-strict resolve() tolerates missing paths.
      return [resolveLoose(projectRoot), true];
    }
    findings.push(
      finding('warning', 'project-root-unresolved', `Could not fully resolve project root: ${(exc as Error).message}`, {
        suggestion: 'Check project path permissions and symlinks before relying on manifest path checks.',
      }),
    );
    return [resolvePath(projectRoot), false];
  }
}

/** Return true when `key` can safely be used as a manifest filename. */
export function isSafeManifestKey(key: string): boolean {
  if (key === '' || key === '.' || key === '..') return false;
  if (key.endsWith('.')) return false;
  if (!MANIFEST_KEY_RE.test(key)) return false;
  if (WINDOWS_RESERVED_MANIFEST_BASENAMES.has(key.split('.', 1)[0].toUpperCase())) return false;
  if (key.includes('/') || key.includes('\\')) return false;
  return !isAbsolute(key) && basename(key) === key;
}

function manifestFileStatus(
  manifest: IntegrationManifest,
  projectRootResolved: string,
  projectRootIsResolved = true,
): [string[], string[], string[], string[]] {
  const missing: string[] = [];
  const modified: string[] = [];
  const invalid: string[] = [];
  const valid: string[] = [];

  const manifestRoot = (manifest as unknown as { projectRoot: string }).projectRoot;
  for (const [rel, expectedHash] of Object.entries(manifest.files as Record<string, string>)) {
    const path = safeManifestFile(manifestRoot, projectRootResolved, rel, projectRootIsResolved);
    if (path === null) {
      invalid.push(rel);
      continue;
    }
    let st: Stats;
    try {
      st = lstatSync(path);
    } catch (exc) {
      valid.push(rel);
      if ((exc as NodeJS.ErrnoException).code === 'ENOENT' || (exc as NodeJS.ErrnoException).code === 'ENOTDIR') {
        missing.push(rel);
      } else {
        modified.push(rel);
      }
      continue;
    }
    if (st.isSymbolicLink()) {
      const symlinkStatus = trackedSymlinkManifestStatus(path, projectRootResolved, projectRootIsResolved);
      if (symlinkStatus === 'invalid') {
        invalid.push(rel);
        continue;
      }
      valid.push(rel);
      if (symlinkStatus === 'missing') {
        missing.push(rel);
        continue;
      }
      modified.push(rel);
      continue;
    }
    valid.push(rel);
    if (!st.isFile()) {
      modified.push(rel);
      continue;
    }
    try {
      if (sha256File(path) !== expectedHash) modified.push(rel);
    } catch {
      modified.push(rel);
    }
  }

  return [missing, modified, invalid, valid];
}

function defaultNotInstalledFromRawState(rawState: IntegrationState): string | null {
  if (!Array.isArray(rawState['installed_integrations'])) return null;
  const rawDefault = defaultIntegrationKey(rawState);
  const rawInstalled = installedIntegrationKeys(rawState);
  if (rawDefault && !rawInstalled.includes(rawDefault)) return rawDefault;
  return null;
}

function toPosixRel(projectRoot: string, p: string): string {
  return relative(resolvePath(projectRoot), resolvePath(p)).split(sep).join('/');
}

function manifestSummary(
  manifestPath: string,
  projectRoot: string,
  opts: {
    readable: boolean;
    trackedFiles?: number;
    missingFiles?: string[];
    modifiedFiles?: string[];
    invalidFiles?: string[];
  },
): ManifestSummary {
  return {
    manifest: toPosixRel(projectRoot, manifestPath),
    readable: opts.readable,
    tracked_files: opts.trackedFiles ?? 0,
    missing_files: opts.missingFiles ?? [],
    modified_files: opts.modifiedFiles ?? [],
    invalid_files: opts.invalidFiles ?? [],
  };
}

function manifestOwner(key: string): string {
  if (key === SHARED_MANIFEST_KEY) return 'shared Spec Kit infrastructure';
  return `integration '${key}'`;
}

function manifestSuggestion(key: string, defaultKey: string | null): string {
  if (key === SHARED_MANIFEST_KEY) {
    if (defaultKey && registryHas(defaultKey)) {
      return `Run \`specify integration upgrade ${defaultKey}\` to regenerate shared managed files.`;
    }
    return 'Run `specify init --here --force --integration <key>` to regenerate shared managed files.';
  }
  if (!registryHas(key)) {
    return (
      'Upgrade Spec Kit, reinstall with a supported CLI version, ' +
      `or remove the stale integration entry from ${INTEGRATION_JSON}.`
    );
  }
  return `Run \`specify integration upgrade ${key}\` or reinstall the integration.`;
}

/** Python `repr()` of a str. */
function pyReprStr(value: string): string {
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

function errorMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// ============================================================================
// Report
// ============================================================================

/** Return a machine-readable integration status report for `projectRoot`. */
export function buildIntegrationStatusReport(projectRoot: string): IntegrationStatusReport {
  const findings: IntegrationStatusFinding[] = [];
  const [projectRootResolved, projectRootIsResolved] = resolveProjectRootForStatus(projectRoot, findings);
  const [state, rawState, error] = tryReadIntegrationJsonWithRaw(projectRoot);
  if (error !== null) {
    findings.push(
      finding('error', 'integration-state-unreadable', integrationStateErrorMessage(error), {
        path: INTEGRATION_JSON,
        suggestion: `Fix or delete ${INTEGRATION_JSON}, then retry.`,
      }),
    );
    return buildReport(null, [], findings, {}, null);
  }

  if (state === null || rawState === null) {
    findings.push(
      finding('error', 'integration-state-missing', `${INTEGRATION_JSON} is missing.`, {
        path: INTEGRATION_JSON,
        suggestion: 'Run `specify integration install <key>` to install an integration.',
      }),
    );
    return buildReport(null, [], findings, {}, null);
  }

  const rawDefaultKey = defaultIntegrationKey(rawState);
  const rawInstalledValue = rawState['installed_integrations'];
  const rawInstalledIsList = Array.isArray(rawInstalledValue);
  const rawInstalledKeys = rawInstalledIsList ? installedIntegrationKeys(rawState) : [];
  let defaultKey: string | null = rawDefaultKey || defaultIntegrationKey(state);
  const installedKeys = installedIntegrationKeys(state);
  const rawDefaultNotInstalled = defaultNotInstalledFromRawState(rawState);
  const checkInstalledKeys =
    rawInstalledIsList && rawDefaultNotInstalled && rawInstalledKeys.length > 0 ? rawInstalledKeys : installedKeys;
  const recordedInstalledKeys = rawInstalledKeys;

  if ('installed_integrations' in rawState && !rawInstalledIsList) {
    findings.push(
      finding(
        'warning',
        'installed-integrations-invalid',
        `installed_integrations must be a list, got ${pyTypeName(rawInstalledValue)}.`,
        { path: INTEGRATION_JSON, suggestion: `Fix ${INTEGRATION_JSON}, then retry.` },
      ),
    );
  }
  if (installedKeys.length === 0) {
    findings.push(
      finding('warning', 'no-installed-integrations', 'No installed integrations are recorded.', {
        suggestion: 'Run `specify integration install <key>` to install one.',
      }),
    );
  }

  if (rawInstalledKeys.length > 0 && rawDefaultKey === null) {
    defaultKey = null;
    findings.push(
      finding('error', 'default-integration-missing', 'No default integration is recorded.', {
        suggestion: 'Run `specify integration use <key>` after choosing an installed integration.',
      }),
    );
  }

  if (rawDefaultNotInstalled) {
    findings.push(
      finding(
        'error',
        'default-integration-not-installed',
        `Default integration '${rawDefaultNotInstalled}' is not listed in installed_integrations.`,
        {
          integration: rawDefaultNotInstalled,
          suggestion:
            'Run `specify integration use <key>` for an installed integration, or reinstall the default integration.',
        },
      ),
    );
  }

  const knownInstalled = checkInstalledKeys.filter((key) => registryHas(key));
  const unknownInstalled: string[] = [];
  for (const key of checkInstalledKeys) {
    if (!registryHas(key)) {
      unknownInstalled.push(key);
      findings.push(
        finding('error', 'unknown-integration', `Integration '${key}' is installed but is not known to this CLI.`, {
          integration: key,
          suggestion:
            'Upgrade Spec Kit, reinstall with a supported CLI version, ' +
            `or remove the stale integration entry from ${INTEGRATION_JSON}.`,
        }),
      );
    }
  }

  const unsafe = knownInstalled.filter((key) => !isMultiInstallSafe(registryGet(key)));
  if (checkInstalledKeys.length > 1) unsafe.push(...unknownInstalled);

  if (checkInstalledKeys.length > 1 && unsafe.length > 0) {
    findings.push(
      finding(
        'error',
        'unsafe-multi-install',
        'Installed integrations are not all declared multi-install safe: ' + [...unsafe].sort().join(', '),
        {
          suggestion:
            'Use `specify integration use <key>` to change defaults, ' +
            'or `specify integration switch <key>` only when replacing integrations.',
        },
      ),
    );
  }

  const manifestFilesByPath = new Map<string, string[]>();
  const manifestSummaries: Record<string, ManifestSummary> = {};
  const attemptedManifestKeys: string[] = [];
  const manifestKeys = [...checkInstalledKeys];
  if (!manifestKeys.includes(SHARED_MANIFEST_KEY)) manifestKeys.push(SHARED_MANIFEST_KEY);

  for (const key of manifestKeys) {
    const owner = manifestOwner(key);
    if (!isSafeManifestKey(key)) {
      findings.push(
        finding('error', 'integration-key-invalid', `Integration key ${pyReprStr(key)} cannot be used as a manifest filename.`, {
          integration: key,
          path: INTEGRATION_JSON,
          suggestion: `Fix ${INTEGRATION_JSON}, then reinstall the integration.`,
        }),
      );
      continue;
    }

    attemptedManifestKeys.push(key);
    const manifestPath = join(projectRoot, '.specify', 'integrations', `${key}.manifest.json`);
    const manifestRel = toPosixRel(projectRoot, manifestPath);
    let manifest: IntegrationManifest;
    try {
      manifest = IntegrationManifest.load(key, projectRootResolved, { resolveProjectRoot: false });
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || (exc as Error).name === 'FileNotFoundError') {
        findings.push(
          finding('error', 'manifest-missing', `Manifest for ${owner} is missing.`, {
            integration: key,
            path: manifestRel,
            suggestion: manifestSuggestion(key, defaultKey),
          }),
        );
        manifestSummaries[key] = manifestSummary(manifestPath, projectRoot, { readable: false });
        continue;
      }
      manifestSummaries[key] = manifestSummary(manifestPath, projectRoot, { readable: false });
      findings.push(
        finding('error', 'manifest-unreadable', `Manifest for ${owner} is unreadable: ${errorMessage(exc)}`, {
          integration: key,
          path: manifestRel,
          suggestion: manifestSuggestion(key, defaultKey),
        }),
      );
      continue;
    }

    const [missing, modified, invalid, validFiles] = manifestFileStatus(
      manifest,
      projectRootResolved,
      projectRootIsResolved,
    );
    manifestSummaries[key] = manifestSummary(manifestPath, projectRoot, {
      readable: true,
      trackedFiles: Object.keys(manifest.files).length,
      missingFiles: missing,
      modifiedFiles: modified,
      invalidFiles: invalid,
    });

    for (const rel of validFiles) {
      const list = manifestFilesByPath.get(rel) ?? [];
      list.push(key);
      manifestFilesByPath.set(rel, list);
    }
    if (invalid.length > 0) {
      findings.push(
        finding('error', 'manifest-paths-invalid', `${invalid.length} unsafe manifest path(s) are recorded for ${owner}.`, {
          integration: key,
          path: manifestRel,
          suggestion: manifestSuggestion(key, defaultKey),
        }),
      );
    }
    if (missing.length > 0) {
      findings.push(
        finding('error', 'managed-files-missing', `${missing.length} managed file(s) are missing for ${owner}.`, {
          integration: key,
          suggestion: manifestSuggestion(key, defaultKey),
        }),
      );
    }
    if (modified.length > 0) {
      findings.push(
        finding('warning', 'managed-files-modified', `${modified.length} managed file(s) were modified for ${owner}.`, {
          integration: key,
          suggestion: 'Review the changes before running `specify integration upgrade --force`.',
        }),
      );
    }
  }

  const sortedPaths = [...manifestFilesByPath.keys()].sort(pyStrCompare);
  for (const rel of sortedPaths) {
    const keys = manifestFilesByPath.get(rel) ?? [];
    if (keys.length > 1) {
      findings.push(
        finding(
          'warning',
          'managed-file-collision',
          `Managed file '${rel}' is tracked by multiple integrations: ${[...keys].sort(pyStrCompare).join(', ')}.`,
          {
            path: rel,
            suggestion: 'Review the manifests before uninstalling or upgrading these integrations.',
          },
        ),
      );
    }
  }

  let multiInstallSafe: boolean | null;
  if (!rawInstalledIsList || rawInstalledKeys.length === 0) {
    multiInstallSafe = null;
  } else {
    multiInstallSafe = !(checkInstalledKeys.length > 1 && unsafe.length > 0);
  }
  return buildReport(defaultKey, installedKeys, findings, manifestSummaries, multiInstallSafe, {
    manifestCheckedKeys: attemptedManifestKeys,
    recordedInstalledKeys,
  });
}

/** Python default string ordering (code point). */
function pyStrCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildReport(
  defaultKey: string | null,
  installedKeys: string[],
  findings: IntegrationStatusFinding[],
  manifests: Record<string, ManifestSummary>,
  multiInstallSafe: boolean | null,
  opts: { manifestCheckedKeys?: string[]; recordedInstalledKeys?: string[] } = {},
): IntegrationStatusReport {
  const items = Object.values(manifests);
  const missingCount = items.reduce((n, item) => n + (item.missing_files?.length ?? 0), 0);
  const modifiedCount = items.reduce((n, item) => n + (item.modified_files?.length ?? 0), 0);
  const invalidCount = items.reduce((n, item) => n + (item.invalid_files?.length ?? 0), 0);
  const uncheckedCount = items.filter((item) => !(item.readable ?? true)).length;
  return {
    status: statusOf(findings),
    default_integration: defaultKey,
    installed_integrations: installedKeys,
    recorded_installed_integrations:
      opts.recordedInstalledKeys === undefined ? installedKeys : opts.recordedInstalledKeys,
    manifest_checked_integrations: opts.manifestCheckedKeys === undefined ? installedKeys : opts.manifestCheckedKeys,
    multi_install_safe: multiInstallSafe,
    shared_templates_target_alignment: defaultKey,
    missing_managed_files: missingCount,
    modified_managed_files: modifiedCount,
    invalid_manifest_paths: invalidCount,
    unchecked_manifests: uncheckedCount,
    manifests,
    findings,
  };
}
