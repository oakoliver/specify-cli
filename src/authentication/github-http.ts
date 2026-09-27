/**
 * @oakoliver/specify-cli - GitHub HTTP helpers
 *
 * Port of upstream `authentication/github_http.py`: `buildGithubRequest()`
 * (GITHUB_TOKEN / GH_TOKEN for GitHub-owned hosts) and
 * `resolveGithubReleaseAssetApiUrl()` (browser release-download URL -> REST
 * API asset URL, for github.com and allow-listed GHES hosts).
 *
 * @module authentication/github-http
 */

import { ValueError, ipAddressCompressed, pyRepr, readResponseLimited, urlPort, urlsplit } from '../download-security.js';
import type { HttpRequest, RedirectValidator } from './http.js';
import { URLError } from './http.js';

/** GitHub-owned hostnames that may receive the Authorization header. */
export const GITHUB_HOSTS: ReadonlySet<string> = new Set([
  'raw.githubusercontent.com',
  'github.com',
  'api.github.com',
  'codeload.github.com',
]);

export const MAX_RELEASE_METADATA_BYTES = 5 * 1024 * 1024;

function hasValidPercentEscapes(value: string): boolean {
  const hex = '0123456789abcdefABCDEF';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '%' && (i + 2 >= value.length || !hex.includes(value[i + 1]) || !hex.includes(value[i + 2]))) {
      return false;
    }
  }
  return true;
}

/** Python `urllib.parse.unquote` (UTF-8, errors='replace'). */
export function pyUnquote(s: string): string {
  if (!s.includes('%')) return s;
  const bytes: number[] = [];
  let out = '';
  const flush = (): void => {
    if (bytes.length) {
      out += Buffer.from(bytes).toString('utf8');
      bytes.length = 0;
    }
  };
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      flush();
      out += s[i];
    }
  }
  flush();
  return out;
}

/** Python `urllib.parse.quote(s, safe='')`. */
export function pyQuote(s: string, safe = ''): string {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9_.\-~]/.test(c) || safe.includes(c)) out += c;
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Python `fnmatch.fnmatch` (POSIX: case-sensitive). */
export function fnmatch(name: string, pattern: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const j = pattern.indexOf(']', i + 2);
      if (j < 0) re += '\\[';
      else {
        let stuff = pattern.slice(i + 1, j).replace(/\\/g, '\\\\');
        if (stuff.startsWith('!')) stuff = '^' + stuff.slice(1);
        else if (stuff.startsWith('^')) stuff = '\\' + stuff;
        re += `[${stuff}]`;
        i = j;
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`^(?:${re})$`, 's').test(name);
}

/**
 * Build a request adding `Authorization: Bearer <GITHUB_TOKEN|GH_TOKEN>` when
 * the host is GitHub-owned. Throws ValueError for empty/non-http(s)/hostless
 * URLs or malformed ports.
 */
export function buildGithubRequest(url: string): HttpRequest {
  const headers: Record<string, string> = {};
  url = url.trim();
  if (!url) throw new ValueError('url must not be empty');
  const parsed = urlsplit(url);
  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
    throw new ValueError(`url must start with http:// or https://, got: ${pyRepr(url)}`);
  }
  if (!parsed.hostname) throw new ValueError(`url must include a hostname, got: ${pyRepr(url)}`);
  urlPort(parsed);
  const githubToken = (process.env.GITHUB_TOKEN ?? '').trim();
  const ghToken = (process.env.GH_TOKEN ?? '').trim();
  const token = githubToken || ghToken || null;
  if (token && GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) headers.Authorization = `Bearer ${token}`;
  return { url, headers };
}

function hostMatches(hostname: string, patterns: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return patterns.some((p) => p === h || fnmatch(h, p));
}

/** `urlparse` = `urlsplit` + `params` split from the last path segment. */
function urlparse(url: string): ReturnType<typeof urlsplit> & { params: string; username: string | null; password: string | null } {
  const s = urlsplit(url);
  let p = s.path;
  let params = '';
  const lastSlash = p.lastIndexOf('/');
  const semi = p.indexOf(';', lastSlash < 0 ? 0 : lastSlash);
  if (semi >= 0) {
    params = p.slice(semi + 1);
    p = p.slice(0, semi);
  }
  let username: string | null = null;
  let password: string | null = null;
  if (s.netloc.includes('@')) {
    const userinfo = s.netloc.slice(0, s.netloc.lastIndexOf('@'));
    const c = userinfo.indexOf(':');
    username = c >= 0 ? userinfo.slice(0, c) : userinfo;
    password = c >= 0 ? userinfo.slice(c + 1) : null;
  }
  return { ...s, path: p, params, username, password };
}

/** A callable compatible with `openUrl` used for the release-metadata lookup. */
export type OpenUrlFn = (
  url: string,
  opts: { timeout?: number; redirectValidator?: RedirectValidator | null },
) => Promise<{ body: ReadableStream<Uint8Array> | null } | { read(size: number): unknown }>;

/** Options for {@link resolveGithubReleaseAssetApiUrl}. */
export interface ResolveReleaseAssetOptions {
  timeout?: number;
  githubHosts?: readonly string[];
  redirectValidator?: RedirectValidator | null;
  maxMetadataBytes?: number;
}

/**
 * Resolve a GitHub release browser-download URL to its REST API asset URL
 * (github.com or allow-listed GHES hosts). Returns the API asset URL, the
 * input when already an API asset URL, or null.
 */
export async function resolveGithubReleaseAssetApiUrl(
  downloadUrl: string,
  openUrlFn: OpenUrlFn,
  opts: ResolveReleaseAssetOptions = {},
): Promise<string | null> {
  const timeout = opts.timeout ?? 60;
  const githubHosts = opts.githubHosts ?? [];
  const maxMetadataBytes = opts.maxMetadataBytes ?? MAX_RELEASE_METADATA_BYTES;
  let parsed: ReturnType<typeof urlparse>;
  let hostname: string;
  try {
    parsed = urlparse(downloadUrl);
    hostname = (parsed.hostname ?? '').toLowerCase();
  } catch {
    return null;
  }
  const parts = parsed.path.replace(/^\/+|\/+$/g, '').split('/').map(pyUnquote);
  const isGhes = !!hostname && !GITHUB_HOSTS.has(hostname) && hostMatches(hostname, githubHosts);
  const isAssetPath = (seg: string[]): boolean =>
    seg.length >= 6 && seg[0] === 'repos' && seg[3] === 'releases' && seg[4] === 'assets';

  if (hostname === 'api.github.com' && isAssetPath(parts)) return downloadUrl;
  if (hostname && parts[0] === 'api' && parts[1] === 'v3' && isAssetPath(parts.slice(2))) return downloadUrl;

  if (parsed.scheme !== 'http' && parsed.scheme !== 'https') return null;
  let port: number | null;
  try {
    port = urlPort(parsed);
  } catch {
    return null;
  }
  let apiBase: string;
  if (hostname === 'github.com') apiBase = 'https://api.github.com';
  else if (isGhes) {
    const authorityHost = hostname.includes(':') ? `[${hostname}]` : hostname;
    const authority = port === null ? authorityHost : `${authorityHost}:${port}`;
    apiBase = `${parsed.scheme}://${authority}/api/v3`;
  } else return null;

  if (parts.length < 6 || parts[2] !== 'releases' || parts[3] !== 'download') return null;
  const owner = parts[0];
  const repo = parts[1];
  const tag = parts.slice(4, -1).join('/');
  const assetName = parts[parts.length - 1];
  const releaseUrl = `${apiBase}/repos/${owner}/${repo}/releases/tags/${pyQuote(tag)}`;

  const isExpectedAssetUrl = (assetUrl: unknown): assetUrl is string => {
    if (typeof assetUrl !== 'string') return false;
    if (
      [...assetUrl].some((c) => c.codePointAt(0)! <= 0x20 || c.codePointAt(0) === 0x7f) ||
      ['?', '#', ';'].some((d) => assetUrl.includes(d)) ||
      !hasValidPercentEscapes(assetUrl)
    ) {
      return false;
    }
    let assetParsed: ReturnType<typeof urlparse>;
    let assetPort: number | null;
    let apiParsed: ReturnType<typeof urlparse>;
    let apiPort: number | null;
    try {
      assetParsed = urlparse(assetUrl);
      assetPort = urlPort(assetParsed);
      apiParsed = urlparse(apiBase);
      apiPort = urlPort(apiParsed);
    } catch {
      return false;
    }
    const assetHost = assetParsed.hostname;
    if (
      (assetParsed.scheme !== 'http' && assetParsed.scheme !== 'https') ||
      !assetHost ||
      assetParsed.username !== null ||
      assetParsed.password !== null ||
      assetParsed.query ||
      assetParsed.fragment ||
      assetParsed.params
    ) {
      return false;
    }
    const origin = (p: ReturnType<typeof urlparse>, host: string, prt: number | null): string => {
      const defaultPort = p.scheme === 'https' ? 443 : 80;
      const normalizedHost = ipAddressCompressed(host) ?? host.toLowerCase();
      return JSON.stringify([p.scheme, normalizedHost, prt === null ? defaultPort : prt]);
    };
    if (origin(assetParsed, assetHost, assetPort) !== origin(apiParsed, apiParsed.hostname ?? '', apiPort)) return false;
    const assetParts = assetParsed.path.split('/');
    const isPublic = apiBase === 'https://api.github.com';
    const ownerIndex = isPublic ? 2 : 4;
    const expectedPrefix = isPublic ? ['', 'repos'] : ['', 'api', 'v3', 'repos'];
    const last = assetParts[assetParts.length - 1];
    return (
      assetParts.length === ownerIndex + 5 &&
      expectedPrefix.every((p, i) => assetParts[i] === p) &&
      pyUnquote(assetParts[ownerIndex]).toLowerCase() === owner.toLowerCase() &&
      pyUnquote(assetParts[ownerIndex + 1]).toLowerCase() === repo.toLowerCase() &&
      assetParts[ownerIndex + 2] === 'releases' &&
      assetParts[ownerIndex + 3] === 'assets' &&
      /^[0-9]+$/.test(last)
    );
  };

  let releaseData: unknown;
  try {
    const openOpts: { timeout?: number; redirectValidator?: RedirectValidator | null } = { timeout };
    if (opts.redirectValidator) openOpts.redirectValidator = opts.redirectValidator;
    const response = await openUrlFn(releaseUrl, openOpts);
    const data = await readResponseLimited(response as never, {
      maxBytes: maxMetadataBytes,
      label: `GitHub release metadata ${releaseUrl}`,
    });
    releaseData = JSON.parse(data.toString('utf8'));
  } catch (e) {
    if (e instanceof URLError || e instanceof SyntaxError || e instanceof TypeError || e instanceof ValueError) return null;
    throw e;
  }
  if (typeof releaseData !== 'object' || releaseData === null || Array.isArray(releaseData)) return null;
  const assets = (releaseData as Record<string, unknown>).assets ?? [];
  if (!Array.isArray(assets)) return null;
  for (const asset of assets) {
    if (typeof asset === 'object' && asset !== null && !Array.isArray(asset) && (asset as Record<string, unknown>).name === assetName) {
      const assetUrl = (asset as Record<string, unknown>).url;
      if (isExpectedAssetUrl(assetUrl)) return assetUrl;
    }
  }
  return null;
}
