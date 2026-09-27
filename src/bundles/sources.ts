/**
 * @oakoliver/specify-cli - Bundle sources
 *
 * Resolve local and remote bundle manifests for bundle consumers.
 *
 * Port of ``specify_cli/bundles/sources.py``.
 *
 * @module bundles/sources
 */

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';

import { parseYaml, YAMLError } from '../yaml.js';
import { BundlerError } from './index.js';
import { BundleManifest } from './manifest.js';
import type { CatalogEntry } from './catalogs.js';
import type { ResolvedBundle } from './catalog-stack.js';
import { validateManifestSync } from './validator.js';
import { decodeUtf8 } from './yamlio.js';
import { expandUser, pathSuffix, pyRepr, urlHostname, urlparse, urlPort, type ParsedUrl } from './pycompat.js';

// ZIP magic-byte signatures cover local headers, empty archives, and spanning markers.
const ZIP_SIGNATURES = ['504b0304', '504b0506', '504b0708'];

type RedirectValidator = (oldUrl: string, newUrl: string) => void;

// ============================================================================
// Injectable seams
// ============================================================================

export const sourceDeps = {
  /**
   * Read ``bundle.yml`` from a local ``.zip`` through the bounded archive
   * helpers. Returns null when the archive has no ``bundle.yml``.
   */
  async readZipManifest(zipPath: string): Promise<Uint8Array | null> {
    const mod = await import('../download-security.js');
    const archive = mod.openZipBounded(zipPath, { errorType: BundlerError });
    try {
      archive.getinfo('bundle.yml');
    } catch {
      return null;
    }
    return mod.readZipMemberLimited(archive, 'bundle.yml', { errorType: BundlerError, label: 'bundle manifest' });
  },
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
  async resolveGithubReleaseAssetApiUrl(url: string, timeout: number): Promise<string | null> {
    const http = await import('../authentication/http.js');
    const gh = await import('../authentication/github-http.js');
    const resolved = await gh.resolveGithubReleaseAssetApiUrl(url, (u, o) => http.openUrl(u, o), {
      timeout,
      githubHosts: http.githubProviderHosts(),
    });
    return (resolved as string | null | undefined) ?? null;
  },
  async readResponseLimited(resp: unknown, opts: { label: string }): Promise<Uint8Array> {
    const mod = await import('../download-security.js');
    return mod.readResponseLimited(resp as never, {
      maxBytes: mod.MAX_DOWNLOAD_BYTES,
      errorType: BundlerError,
      label: opts.label,
    });
  },
  async verifyArchiveSha256(data: Uint8Array, expected: string | null, name: string): Promise<void> {
    const mod = await import('../shared-infra.js');
    mod.verifyArchiveSha256(data, expected, name, BundlerError);
  },
};

// ============================================================================
// Local sources
// ============================================================================

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Return a {@link BundleManifest} if *arg* points at a local bundle (a built
 * ``.zip`` artifact, a bundle directory, or a ``bundle.yml`` file). Returns
 * null when *arg* is not an existing path, so callers fall back to
 * catalog-stack resolution by bundle id.
 */
export async function localManifestSource(arg: string): Promise<BundleManifest | null> {
  const candidate = expandUser(arg, homedir());
  if (!existsSync(candidate)) return null;

  if (isDir(candidate)) {
    const manifestPath = path.join(candidate, 'bundle.yml');
    if (!existsSync(manifestPath)) throw new BundlerError(`No bundle.yml found in '${candidate}'.`);
    return BundleManifest.fromFile(manifestPath);
  }

  if (pathSuffix(candidate) === '.zip') {
    const raw = await sourceDeps.readZipManifest(candidate);
    if (raw === null) throw new BundlerError(`Artifact '${candidate}' does not contain a bundle.yml.`);
    // Decode as UTF-8 explicitly (a UTF-16 BOM must be rejected exactly like
    // the directory and bundle.yml sources reject it).
    let text: string;
    try {
      text = decodeUtf8(raw);
    } catch (exc) {
      throw new BundlerError(`Could not read bundle.yml inside '${candidate}': ${(exc as Error).message}`, {
        cause: exc,
      });
    }
    let data: unknown;
    try {
      data = parseYaml(text);
    } catch (exc) {
      if (exc instanceof YAMLError) {
        throw new BundlerError(`Invalid YAML in bundle.yml inside '${candidate}': ${exc.message}`, { cause: exc });
      }
      throw exc;
    }
    return BundleManifest.fromDict(data);
  }

  const suffix = pathSuffix(candidate);
  if (path.basename(candidate) === 'bundle.yml' || suffix === '.yml' || suffix === '.yaml') {
    return BundleManifest.fromFile(candidate);
  }

  throw new BundlerError(
    `'${candidate}' is not a recognised bundle source (.zip artifact, bundle directory, or bundle.yml).`,
  );
}

// ============================================================================
// Remote sources
// ============================================================================

/**
 * Resolve a bundle's manifest from its catalog ``download_url``. Catalog
 * download URLs are HTTPS-only (``http`` allowed for localhost); ``file://``
 * URLs and bare paths are rejected (install from disk by passing the path
 * positionally instead).
 */
export async function downloadManifest(resolved: ResolvedBundle, opts: { offline: boolean }): Promise<BundleManifest> {
  const url = resolved.entry.download_url;
  if (!url) {
    throw new BundlerError(`Catalog entry '${resolved.entry.id}' has no download_url; cannot resolve its manifest.`);
  }
  let parsed: ParsedUrl;
  try {
    parsed = urlparse(url);
  } catch {
    throw new BundlerError(`Catalog entry '${resolved.entry.id}' has a malformed download_url: ${url}`);
  }
  const scheme = parsed.scheme.toLowerCase();

  if (scheme === '' || scheme === 'file' || /^[A-Za-z]:[\\/]/.test(url)) {
    throw new BundlerError(
      `Catalog entry '${resolved.entry.id}' has a non-HTTP(S) download_url ` +
        `(${url}); catalog download URLs must be HTTPS (http for localhost) — ` +
        'a file:// URL, a local filesystem path, or a scheme-less value ' +
        "(e.g. 'example.com/bundle.zip') is not accepted. " +
        'To install a bundle from disk, pass the path directly: ' +
        "'specify bundle install <path-to-bundle.yml | bundle-dir | .zip>'.",
    );
  }

  // Validate scheme/host *before* the offline gate so the real problem is
  // reported in every mode.
  requireHttps(`bundle '${resolved.entry.id}'`, url);

  if (opts.offline) {
    throw new BundlerError(`Network access disabled; cannot download bundle '${resolved.entry.id}' from ${url}.`);
  }
  const manifest = await downloadRemoteManifest(resolved.entry.id, url, { expectedSha256: resolved.entry.sha256 });
  validateCatalogManifest(resolved.entry, manifest);
  return manifest;
}

/** Refuse non-HTTPS (except localhost http), host-less, or malformed URLs. */
export function requireHttps(label: string, url: string): void {
  let parsed: ParsedUrl;
  let hostname: string | null;
  try {
    parsed = urlparse(url);
    hostname = urlHostname(parsed);
    urlPort(parsed);
  } catch {
    throw new BundlerError(`Refusing to download ${label}: URL is malformed: ${url}`);
  }
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (parsed.scheme !== 'https' && !(parsed.scheme === 'http' && isLocalhost)) {
    throw new BundlerError(`Refusing to download ${label} over non-HTTPS URL: ${url}`);
  }
  if (!hostname) throw new BundlerError(`Refusing to download ${label} from URL with no host: ${url}`);
}

function responseUrl(resp: unknown, fallback: string): string {
  const r = resp as { geturl?: () => string; url?: string } | null;
  if (r && typeof r.geturl === 'function') return r.geturl();
  if (r && typeof r.url === 'string' && r.url) return r.url;
  return fallback;
}

function errMessage(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

/** Fetch a remote bundle artifact over HTTPS and extract its manifest. */
export async function downloadRemoteManifest(
  entryId: string,
  url: string,
  opts: { expectedSha256?: string | null } = {},
): Promise<BundleManifest> {
  const label = `bundle '${entryId}'`;
  const validateRedirect: RedirectValidator = (_old, newUrl) => requireHttps(label, newUrl);

  requireHttps(label, url);

  // Private/SSO GitHub release browser URLs are resolved to the REST API
  // asset URL so the authenticated client can download the actual file.
  let extraHeaders: Record<string, string> | null = null;
  let effectiveUrl = url;
  const resolved = await sourceDeps.resolveGithubReleaseAssetApiUrl(url, 30);
  if (resolved) {
    effectiveUrl = resolved;
    requireHttps(label, effectiveUrl);
    extraHeaders = { Accept: 'application/octet-stream' };
  }

  const sourceDesc = effectiveUrl !== url ? `${url} (resolved to ${effectiveUrl})` : url;

  let raw: Uint8Array;
  try {
    const resp = await sourceDeps.openUrl(effectiveUrl, { timeout: 30, redirectValidator: validateRedirect, extraHeaders });
    requireHttps(label, responseUrl(resp, effectiveUrl));
    const status = (resp as { status?: number } | null)?.status;
    if (typeof status === 'number' && (status < 200 || status > 299)) {
      throw new Error(`HTTP Error ${status}: ${(resp as { statusText?: string }).statusText ?? ''}`);
    }
    raw = await sourceDeps.readResponseLimited(resp, { label: `bundle '${entryId}' download` });
    await sourceDeps.verifyArchiveSha256(raw, opts.expectedSha256 ?? null, entryId);
  } catch (exc) {
    if (exc instanceof BundlerError) throw exc;
    throw new BundlerError(`Failed to download bundle '${entryId}' from ${sourceDesc}: ${errMessage(exc)}`, {
      cause: exc,
    });
  }

  // A .zip artifact is parsed via the local-source path; anything else is YAML.
  // Detection uses the catalog URL's path suffix, falling back to magic bytes
  // for REST API asset URLs that carry no extension.
  let urlExt = '';
  try {
    urlExt = pathSuffix(urlparse(url).path.split('/').pop() ?? '').toLowerCase();
  } catch {
    urlExt = '';
  }
  const magic = Buffer.from(raw.subarray(0, 4)).toString('hex');
  try {
    if (urlExt === '.zip' || ZIP_SIGNATURES.includes(magic)) {
      const tmp = mkdtempSync(path.join(tmpdir(), 'speckit-bundle-'));
      try {
        const artifact = path.join(tmp, 'bundle.zip');
        writeFileSync(artifact, raw);
        let manifest: BundleManifest | null;
        try {
          manifest = await localManifestSource(artifact);
        } catch (exc) {
          throw new BundlerError(
            `Downloaded artifact for bundle '${entryId}' from ${sourceDesc} is not a valid bundle: ${errMessage(exc)}`,
            { cause: exc },
          );
        }
        if (manifest === null) {
          throw new BundlerError(`Downloaded artifact for bundle '${entryId}' from ${sourceDesc} is not a valid bundle.`);
        }
        return manifest;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    let text: string;
    try {
      text = decodeUtf8(raw);
    } catch (exc) {
      throw new BundlerError(
        `Downloaded content for bundle '${entryId}' from ${sourceDesc} could not be read: ${errMessage(exc)}`,
        { cause: exc },
      );
    }
    const data = parseYaml(text);
    return BundleManifest.fromDict(data);
  } catch (exc) {
    if (exc instanceof BundlerError) throw exc;
    if (exc instanceof YAMLError) {
      throw new BundlerError(
        `Downloaded content for bundle '${entryId}' from ${sourceDesc} is not valid YAML: ${exc.message}`,
        { cause: exc },
      );
    }
    throw new BundlerError(`Failed to parse downloaded bundle '${entryId}' from ${sourceDesc}: ${errMessage(exc)}`, {
      cause: exc,
    });
  }
}

/** Reject a malformed manifest before any project mutation can occur. */
export function validateManifestStructure(manifest: BundleManifest, opts: { source: string }): void {
  const report = validateManifestSync(manifest);
  if (report.ok) return;
  throw new BundlerError(`${opts.source} contains an invalid bundle manifest:\n  - ` + report.errors.join('\n  - '));
}

/** Bind a downloaded manifest to the catalog identity that selected it. */
export function validateCatalogManifest(entry: CatalogEntry, manifest: BundleManifest): void {
  if (manifest.bundle.id !== entry.id) {
    throw new BundlerError(
      `Downloaded bundle id mismatch: catalog entry ${pyRepr(entry.id)} points to ` +
        `a manifest for ${pyRepr(manifest.bundle.id)}.`,
    );
  }
  if (manifest.bundle.version !== entry.version) {
    throw new BundlerError(
      `Downloaded bundle version mismatch for ${pyRepr(entry.id)}: catalog declares ` +
        `${pyRepr(entry.version)}, but the manifest declares ${pyRepr(manifest.bundle.version)}.`,
    );
  }
  validateManifestStructure(manifest, { source: `Downloaded bundle ${pyRepr(entry.id)}` });
}
