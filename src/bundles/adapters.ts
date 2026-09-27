/**
 * @oakoliver/specify-cli - Bundle adapters
 *
 * Concrete adapters: catalog fetching and primitive installation.
 *
 * - {@link makeCatalogFetcher} returns an offline-first fetcher that reads
 *   built-in catalogs and local/pinned file URLs without network, and falls
 *   back to a timeout-bounded HTTP GET only for ``http(s)://`` sources.
 * - {@link DefaultPrimitiveInstaller} dispatches component install/remove to
 *   the existing Spec Kit primitive machinery in-process.
 *
 * Port of ``specify_cli/bundles/adapters.py``.
 *
 * @module bundles/adapters
 */

import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BundlerError } from './index.js';
import { loadsJson, decodeUtf8, UnicodeDecodeError } from './yamlio.js';
import type { CatalogSource } from './catalogs.js';
import type { ComponentRef } from './manifest.js';
import { primitiveManager, type KindManager } from './primitives.js';
import type { PrimitiveInstaller } from './installer.js';
import { pyRepr, urlHostname, urlparse, urlPort, type ParsedUrl } from './pycompat.js';

export const COMMUNITY_CATALOG_URL =
  'https://raw.githubusercontent.com/github/spec-kit/main/bundles/catalog.community.json';
export const FIRSTPARTY_CATALOG_URL = 'https://raw.githubusercontent.com/github/spec-kit/main/bundles/catalog.json';

// Built-in catalogs are fetched from the repository online and fall back to
// the packaged snapshot offline so discovery works without network.
const BUILTIN_REPOSITORY_URLS: Readonly<Record<string, string>> = {
  'builtin://default': FIRSTPARTY_CATALOG_URL,
  'builtin://community': COMMUNITY_CATALOG_URL,
};
const BUILTIN_PACKAGED_SNAPSHOTS: Readonly<Record<string, string>> = {
  'builtin://default': 'catalog.json',
  'builtin://community': 'catalog.community.json',
};

export const HTTP_TIMEOUT_SECONDS = 10;
const TRANSIENT_HTTP_STATUS_CODES = new Set([408, 429]);

/**
 * A built-in catalog could not be reached (transport/availability failure).
 * Marks only transient fetch failures so the built-in fallback never swallows
 * content or security validation failures.
 */
export class CatalogUnavailable extends BundlerError {
  override name = 'CatalogUnavailable';
}

// ============================================================================
// Injectable seams
// ============================================================================

type RedirectValidator = (oldUrl: string, newUrl: string) => void;

/** Loose response shape: a fetch ``Response`` or a urllib-like object. */
export interface ResponseLike {
  url?: string;
  status?: number;
  geturl?: () => string;
}

const TLS_CERT_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
]);

function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export const adapterDeps = {
  /** ``specify_cli.authentication.http.open_url``. */
  async openUrl(
    url: string,
    opts: { timeout?: number; redirectValidator?: RedirectValidator; extraHeaders?: Record<string, string> | null },
  ): Promise<unknown> {
    const mod = await import('../authentication/http.js');
    return mod.openUrl(url, {
      timeout: opts.timeout,
      redirectValidator: opts.redirectValidator,
      extraHeaders: opts.extraHeaders ?? undefined,
    });
  },
  /** ``read_response_limited``. */
  async readResponseLimited(resp: unknown, opts: { maxBytes: number; label: string }): Promise<Uint8Array> {
    const mod = await import('../download-security.js');
    return mod.readResponseLimited(resp as never, {
      maxBytes: opts.maxBytes,
      errorType: BundlerError,
      label: opts.label,
    });
  },
  async maxJsonCatalogBytes(): Promise<number> {
    const mod = await import('../download-security.js');
    return mod.MAX_JSON_CATALOG_BYTES;
  },
  /** ``_locate_core_pack`` (null when no packaged core_pack is present). */
  async locateCorePack(): Promise<string | null> {
    try {
      const mod = await import('../assets.js');
      const found = mod.locateCorePack() as string | null;
      if (found) return found;
    } catch {
      // fall through to local candidates
    }
    for (const candidate of [
      path.resolve(moduleDir(), '..', '..', 'core_pack'),
      path.resolve(moduleDir(), '..', 'core_pack'),
    ]) {
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        // continue
      }
    }
    return null;
  },
  /** ``_repo_root`` fallback. */
  repoRoot(): string {
    return path.resolve(moduleDir(), '..', '..');
  },
  /** ``_http_get_json`` (tests replace this). */
  httpGetJson: (sourceId: string, url: string): Promise<unknown> => httpGetJson(sourceId, url),
  /** ``warnings.warn(..., UserWarning)``. */
  warn(message: string): void {
    process.stderr.write(`UserWarning: ${message}\n`);
  },
};

// ============================================================================
// URL helpers
// ============================================================================

// Windows absolute paths like ``C:\catalog.json`` parse with a single-letter
// ``scheme`` under urlparse; treat them as local files rather than URLs.
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

function isWindowsDrivePath(url: string): boolean {
  return WINDOWS_DRIVE_RE.test(url);
}

/** Convert a ``file://`` URL to a local path (UNC hosts preserved). */
function fileUrlToPath(parsed: ParsedUrl): string {
  const decoded = decodeURIComponent(parsed.path);
  const netloc = parsed.netloc;
  if (netloc && netloc.toLowerCase() !== 'localhost') return `//${netloc}${decoded}`;
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(decoded)) return decoded.slice(1);
  return decoded;
}

/**
 * Restrict remote catalogs to HTTPS (HTTP only for localhost) with a host.
 */
export function validateRemoteUrl(sourceId: string, url: string): void {
  let parsed: ParsedUrl;
  let hostname: string | null;
  try {
    parsed = urlparse(url);
    hostname = urlHostname(parsed);
    urlPort(parsed);
  } catch {
    throw new BundlerError(`Catalog '${sourceId}' URL is malformed: ${url}`);
  }
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (parsed.scheme !== 'https' && !(parsed.scheme === 'http' && isLocalhost)) {
    throw new BundlerError(
      `Catalog '${sourceId}' URL must use HTTPS (got ${parsed.scheme}://). HTTP is only allowed for localhost.`,
    );
  }
  // Check hostname, not netloc: netloc is truthy for host-less URLs.
  if (!hostname) {
    throw new BundlerError(`Catalog '${sourceId}' URL must be a valid URL with a host: ${url}`);
  }
}

/** Load a packaged bundle catalog snapshot from core_pack (or the repo root). */
export async function loadPackagedCatalog(filename: string): Promise<unknown> {
  const corePack = await adapterDeps.locateCorePack();
  const p =
    corePack !== null
      ? path.join(corePack, 'bundles', filename)
      : path.join(adapterDeps.repoRoot(), 'bundles', filename);
  let isFile = false;
  try {
    isFile = statSync(p).isFile();
  } catch {
    isFile = false;
  }
  if (!isFile) throw new BundlerError(`Bundled catalog not found: ${p}`);
  return loadsJson(decodeUtf8(readFileSync(p)), { origin: p });
}

function readLocalCatalog(p: string): unknown {
  let raw: Buffer;
  try {
    raw = readFileSync(p);
  } catch (exc) {
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new BundlerError(`Catalog file not found: ${p}`);
    throw new BundlerError(`Could not read ${p}: ${(exc as Error).message}`, { cause: exc });
  }
  let text: string;
  try {
    text = decodeUtf8(raw);
  } catch (exc) {
    throw new BundlerError(`Could not read ${p}: ${(exc as Error).message}`, { cause: exc });
  }
  return loadsJson(text, { origin: p });
}

// ============================================================================
// Catalog fetcher
// ============================================================================

/**
 * Return a fetcher suitable for {@link CatalogStack}. When *allowNetwork* is
 * false, ``http(s)://`` sources throw instead of touching the network.
 */
export function makeCatalogFetcher(opts: { allowNetwork?: boolean } = {}): (source: CatalogSource) => Promise<unknown> {
  const allowNetwork = opts.allowNetwork ?? true;

  return async (source: CatalogSource): Promise<unknown> => {
    const url = source.url;
    let parsed: ParsedUrl;
    try {
      parsed = urlparse(url);
      urlPort(parsed);
    } catch {
      throw new BundlerError(`Catalog ${pyRepr(source.id)} URL is malformed: ${pyRepr(url)}`);
    }
    const scheme = parsed.scheme.toLowerCase();

    if (scheme === 'builtin') {
      const repositoryUrl = BUILTIN_REPOSITORY_URLS[url];
      if (repositoryUrl === undefined) throw new BundlerError(`Unknown built-in catalog '${url}'.`);
      const snapshotName = BUILTIN_PACKAGED_SNAPSHOTS[url];
      if (allowNetwork) {
        try {
          return await adapterDeps.httpGetJson(source.id, repositoryUrl);
        } catch (exc) {
          if (!(exc instanceof CatalogUnavailable)) throw exc;
          // Only transient fetch failures fall back to the packaged snapshot.
          adapterDeps.warn(`Built-in catalog '${url}' is unavailable (${exc.message}); using the packaged snapshot.`);
          return loadPackagedCatalog(snapshotName);
        }
      }
      return loadPackagedCatalog(snapshotName);
    }

    if (scheme === 'file') return readLocalCatalog(fileUrlToPath(parsed));

    if (scheme === '' || isWindowsDrivePath(url)) return readLocalCatalog(url);

    if (scheme === 'http' || scheme === 'https') {
      if (!allowNetwork) {
        throw new BundlerError(`Network access disabled; cannot fetch catalog '${source.id}' from ${url}.`);
      }
      validateRemoteUrl(source.id, url);
      return adapterDeps.httpGetJson(source.id, url);
    }

    throw new BundlerError(`Unsupported catalog URL scheme: ${url}`);
  };
}

function responseUrl(resp: unknown, fallback: string): string {
  const r = resp as ResponseLike | null;
  if (r && typeof r.geturl === 'function') return r.geturl();
  if (r && typeof r.url === 'string' && r.url) return r.url;
  return fallback;
}

function httpStatusOf(exc: unknown): { code: number; reason: string } | null {
  if (!exc || typeof exc !== 'object') return null;
  const e = exc as { code?: unknown; status?: unknown; reason?: unknown; statusText?: unknown; name?: string };
  const code = typeof e.status === 'number' ? e.status : typeof e.code === 'number' ? e.code : null;
  if (code === null || code < 100 || code > 599) return null;
  const reason = typeof e.reason === 'string' ? e.reason : typeof e.statusText === 'string' ? e.statusText : '';
  return { code, reason };
}

function errorCodes(exc: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = exc;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    const c = (current as { code?: unknown }).code;
    if (typeof c === 'string') codes.push(c);
    current = (current as { cause?: unknown; reason?: unknown }).cause ?? (current as { reason?: unknown }).reason;
  }
  return codes;
}

function errMessage(exc: unknown): string {
  // urllib's URLError renders as its ``reason`` in upstream messages.
  if (exc && typeof exc === 'object' && (exc as { name?: string }).name === 'URLError') {
    const reason = (exc as { reason?: unknown }).reason;
    if (reason !== undefined) return reason instanceof Error ? reason.message : String(reason);
  }
  return exc instanceof Error ? exc.message : String(exc);
}

/**
 * Fetch catalog JSON over HTTP(S) via the shared authenticated client. Every
 * redirect hop and the final URL are re-validated (HTTPS/host), response size
 * is bounded, and failures are classified: only transport/availability
 * failures (connection errors, timeouts, truncated responses, 408/429/5xx)
 * become {@link CatalogUnavailable}.
 */
export async function httpGetJson(sourceId: string, url: string): Promise<unknown> {
  const validateRedirect: RedirectValidator = (_old, newUrl) => validateRemoteUrl(sourceId, newUrl);
  let raw: string;
  let finalUrl: string;
  try {
    const response = await adapterDeps.openUrl(url, { timeout: HTTP_TIMEOUT_SECONDS, redirectValidator: validateRedirect });
    finalUrl = responseUrl(response, url);
    validateRemoteUrl(sourceId, finalUrl);
    const status = (response as ResponseLike | null)?.status;
    if (typeof status === 'number' && (status < 200 || status > 299)) {
      const statusText = (response as { statusText?: string }).statusText ?? '';
      throw Object.assign(new Error(`HTTP Error ${status}: ${statusText}`), { status, reason: statusText });
    }
    const body = await adapterDeps.readResponseLimited(response, {
      maxBytes: await adapterDeps.maxJsonCatalogBytes(),
      label: `bundle catalog '${sourceId}'`,
    });
    raw = decodeUtf8(body);
  } catch (exc) {
    if (exc instanceof BundlerError) throw exc; // size limits, URL validation
    if (exc instanceof UnicodeDecodeError) {
      throw new BundlerError(`Failed to fetch catalog from ${url}: response was not valid UTF-8 (${exc.message})`, {
        cause: exc,
      });
    }
    const codes = errorCodes(exc);
    if (codes.some((c) => TLS_CERT_ERROR_CODES.has(c))) {
      // TLS verification is a security failure, never masked by the snapshot.
      throw new BundlerError(`Failed to fetch catalog from ${url}: ${errMessage(exc)}`, { cause: exc });
    }
    const name = exc && typeof exc === 'object' ? (exc as { name?: string }).name : undefined;
    if (name === 'RedirectPolicyError') {
      throw new BundlerError(`Failed to fetch catalog from ${url}: ${errMessage(exc)}`, { cause: exc });
    }
    const http = httpStatusOf(exc);
    if (http !== null) {
      const text = `Failed to fetch catalog from ${url}: HTTP ${http.code} ${http.reason}`;
      if (TRANSIENT_HTTP_STATUS_CODES.has(http.code) || http.code >= 500) {
        throw new CatalogUnavailable(text, { cause: exc });
      }
      throw new BundlerError(text, { cause: exc });
    }
    // Connection/DNS errors, timeouts, resets, truncated bodies.
    throw new CatalogUnavailable(`Failed to fetch catalog from ${url}: ${errMessage(exc)}`, { cause: exc });
  }
  return loadsJson(raw, { origin: finalUrl });
}

// ============================================================================
// DefaultPrimitiveInstaller
// ============================================================================

/**
 * Dispatch component install/remove to existing primitive machinery.
 * *allowNetwork* mirrors the bundle command's ``--offline`` flag.
 */
export class DefaultPrimitiveInstaller implements PrimitiveInstaller {
  private readonly allowNetwork: boolean;

  constructor(opts: { allowNetwork?: boolean } = {}) {
    this.allowNetwork = opts.allowNetwork ?? true;
  }

  isInstalled(projectRoot: string, component: ComponentRef): Promise<boolean> {
    return this.managerFor(component, projectRoot).isInstalled(component);
  }

  install(projectRoot: string, component: ComponentRef): Promise<void> {
    return this.managerFor(component, projectRoot).install(component);
  }

  refresh(projectRoot: string, component: ComponentRef): Promise<void> {
    return this.managerFor(component, projectRoot).refresh(component);
  }

  remove(projectRoot: string, component: ComponentRef): Promise<void> {
    return this.managerFor(component, projectRoot).remove(component);
  }

  private managerFor(component: ComponentRef, projectRoot: string): KindManager {
    return primitiveManager(component.kind, projectRoot, { allowNetwork: this.allowNetwork });
  }
}

