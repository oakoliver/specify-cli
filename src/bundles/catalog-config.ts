/**
 * @oakoliver/specify-cli - Bundle catalog config persistence
 *
 * Persistence for the project-scoped catalog config
 * (``.specify/bundle-catalogs.yml``). Only project scope is writable; built-in
 * defaults are never deleted (they can be overridden by adding a same-id
 * source).
 *
 * Port of ``specify_cli/bundles/catalog_config.py``.
 *
 * @module bundles/catalog-config
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { BundlerError } from './index.js';
import { dumpYaml, ensureWithin, loadYaml } from './yamlio.js';
import {
  BUILTIN_DEFAULT_STACK,
  CONFIG_FILENAME,
  CONFIG_SCHEMA_VERSION,
  CatalogSource,
  InstallPolicy,
  Scope,
  parseInstallPolicy,
} from './catalogs.js';
import {
  dget,
  expandUser,
  isMapping,
  pathStem,
  pyStr,
  pyTypeName,
  resolvePath,
  urlHostname,
  urlparse,
  urlPort,
} from './pycompat.js';

const BUILTIN_IDS = new Set(BUILTIN_DEFAULT_STACK.map((raw) => String(raw.id)));

// Windows absolute paths like ``C:\catalog.json`` parse with a single-letter
// ``scheme`` under urlparse; treat them as local files rather than URLs.
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

/** @internal */
export function configPath(projectRoot: string): string {
  return path.join(projectRoot, '.specify', CONFIG_FILENAME);
}

/** @internal */
export function read(projectRoot: string): Array<Record<string, unknown>> {
  // Confine the read (parity with the write path's within= guard).
  const p = ensureWithin(projectRoot, configPath(projectRoot));
  if (!existsSync(p)) return [];
  const data = loadYaml(p);
  if (!isMapping(data)) {
    throw new BundlerError(
      `Malformed catalog config at ${p}: expected a mapping at the top level, got ${pyTypeName(data)}.`,
    );
  }
  const schemaVersion = dget(data, 'schema_version');
  if (
    schemaVersion !== undefined &&
    schemaVersion !== null &&
    pyStr(schemaVersion).trim().split('.')[0] !== CONFIG_SCHEMA_VERSION.split('.')[0]
  ) {
    throw new BundlerError(
      `Unsupported catalog config schema version ` +
        `'${pyStr(schemaVersion).trim()}' at ${p}; this Spec Kit ` +
        `understands version ${CONFIG_SCHEMA_VERSION}. The file may have been ` +
        'written by a newer version or is corrupt.',
    );
  }
  const catalogs = dget(data, 'catalogs');
  if (catalogs === undefined || catalogs === null) return [];
  if (!Array.isArray(catalogs)) {
    throw new BundlerError(
      `Malformed catalog config at ${p}: 'catalogs' must be a list, got ${pyTypeName(catalogs)}.`,
    );
  }
  for (const entry of catalogs) {
    if (!isMapping(entry)) {
      throw new BundlerError(
        `Malformed catalog config at ${p}: each catalog entry must be a mapping, got ${pyTypeName(entry)}.`,
      );
    }
  }
  return [...(catalogs as Array<Record<string, unknown>>)];
}

/** @internal */
export function write(projectRoot: string, catalogs: Array<Record<string, unknown>>): void {
  const payload = { schema_version: CONFIG_SCHEMA_VERSION, catalogs };
  dumpYaml(configPath(projectRoot), payload, { within: projectRoot });
}

/** @internal */
export function slug(value: string): string {
  // Lowercase so derived ids are deterministic and case-insensitive.
  let out = '';
  for (const ch of value.toLowerCase()) out += /[\p{L}\p{N}]/u.test(ch) ? ch : '-';
  return out.replace(/^-+|-+$/g, '');
}

const REMOTE_SCHEMES = new Set(['http', 'https', 'file', 'builtin']);

/** True when *url* denotes a local filesystem path rather than a URL. */
function isLocalPath(url: string): boolean {
  if (WINDOWS_DRIVE_RE.test(url)) return true;
  let scheme: string;
  try {
    scheme = urlparse(url).scheme.toLowerCase();
  } catch {
    // Malformed URLs (e.g. an unclosed IPv6 bracket) are not local paths.
    return false;
  }
  return !REMOTE_SCHEMES.has(scheme);
}

/** Make local file paths absolute so config is independent of the caller's cwd. */
/** @internal */
export function canonicalizeUrl(url: string): string {
  if (isLocalPath(url)) return resolvePath(expandUser(url, homedir()));
  return url;
}

/** @internal */
export function deriveId(url: string): string {
  const parsed = urlparse(url);
  if (parsed.netloc) {
    // Full host (TLD included) so example.com vs example.net don't collide.
    const host = urlHostname(parsed) ?? '';
    const pathStemValue = parsed.path ? pathStem(parsed.path) : '';
    const parts = [slug(host), slug(pathStemValue)].filter((p) => p);
    return parts.join('-') || 'catalog';
  }
  const stem = pathStem(parsed.path || url);
  return slug(stem) || 'catalog';
}

/** Register a project-scoped catalog source. Returns ``[source, 'added' | 'unchanged']``. */
export function addSource(
  projectRoot: string,
  url: string,
  opts: { policy: string; priority: number; sourceId?: string | null },
): [CatalogSource, 'added' | 'unchanged'] {
  url = url.trim();
  if (!url) throw new BundlerError('A catalog url is required.');
  let parsed;
  let hostname: string | null;
  try {
    parsed = urlparse(url);
    hostname = urlHostname(parsed);
    urlPort(parsed);
  } catch (exc) {
    throw new BundlerError(`Invalid catalog url: '${url}'.`, { cause: exc });
  }
  if (!(parsed.scheme || parsed.path)) throw new BundlerError(`Invalid catalog url: '${url}'.`);
  // Reject unsupported URL schemes (e.g. ssh://, ftp://) up front.
  if (url.includes('://') && !REMOTE_SCHEMES.has(parsed.scheme.toLowerCase())) {
    throw new BundlerError(
      `Unsupported catalog url scheme '${parsed.scheme}://' in '${url}'. ` +
        'Use http(s)://, file://, builtin://, or a local path.',
    );
  }
  if (parsed.scheme.toLowerCase() === 'http' || parsed.scheme.toLowerCase() === 'https') {
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (parsed.scheme.toLowerCase() !== 'https' && !isLocalhost) {
      throw new BundlerError(
        `Catalog url must use HTTPS (got ${parsed.scheme}://). HTTP is only allowed for localhost.`,
      );
    }
    if (!hostname) throw new BundlerError(`Catalog url must be a valid URL with a host: ${url}`);
  }

  url = canonicalizeUrl(url);
  const installPolicy: InstallPolicy = parseInstallPolicy(opts.policy);
  const requestedId = opts.sourceId !== null && opts.sourceId !== undefined ? opts.sourceId.trim() : '';
  const resolvedId = requestedId || deriveId(url);

  const catalogs = read(projectRoot);
  const requestedSource = CatalogSource.fromDict(
    { id: resolvedId, url, priority: opts.priority, install_policy: installPolicy },
    Scope.PROJECT,
  );
  let idCollision = false;
  for (const existing of catalogs) {
    const existingSource = CatalogSource.fromDict(existing, Scope.PROJECT);
    if (existingSource.url === requestedSource.url) {
      if (
        (!requestedId || existingSource.id === requestedSource.id) &&
        existingSource.priority === requestedSource.priority &&
        existingSource.install_policy === requestedSource.install_policy
      ) {
        return [existingSource, 'unchanged'];
      }
      throw new BundlerError(`Catalog source '${resolvedId}' (or url) already exists in this project.`);
    }
    if (existingSource.id === requestedSource.id) idCollision = true;
  }

  if (idCollision) {
    throw new BundlerError(`Catalog source '${resolvedId}' (or url) already exists in this project.`);
  }

  catalogs.push(requestedSource.toDict());
  write(projectRoot, catalogs);
  return [requestedSource, 'added'];
}

/** Remove a project-scoped catalog source by id or url. */
export function removeSource(projectRoot: string, idOrUrl: string): string {
  const target = idOrUrl.trim();
  if (BUILTIN_IDS.has(target)) {
    throw new BundlerError(
      `'${target}' is a built-in default source and cannot be deleted ` +
        '(add a same-id source to override it instead).',
    );
  }

  const catalogs = read(projectRoot);
  let remaining = catalogs.filter((c) => dget(c, 'id') !== target && dget(c, 'url') !== target);
  if (remaining.length === catalogs.length) {
    // Fallback: canonicalized local-path match (so `remove ./cat.json` undoes
    // `add ./cat.json`, which stored an absolute url).
    const canonical = canonicalizeUrl(target);
    if (canonical !== target) remaining = catalogs.filter((c) => dget(c, 'url') !== canonical);
  }
  if (remaining.length === catalogs.length) {
    throw new BundlerError(`No project-scoped catalog source matching '${target}' was found.`);
  }
  write(projectRoot, remaining);
  return target;
}
