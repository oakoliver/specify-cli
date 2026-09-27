/**
 * @oakoliver/specify-cli - Authenticated HTTP
 *
 * Port of upstream `authentication/http.py`: config-driven authenticated HTTP
 * built on global `fetch` (redirects followed manually so every hop passes
 * the redirect policy):
 *
 * - Credentials attach only for hosts configured in `~/.specify/auth.json`.
 * - `Authorization` is stripped when a redirect leaves the entry's hosts or
 *   downgrades from HTTPS.
 * - Every redirect must satisfy `isSafeDownloadRedirect` (HTTPS with host;
 *   HTTP only between loopback hosts; never remote -> local).
 * - On 401/403 the next matching entry is tried, then unauthenticated.
 * - Non-2xx responses throw {@link HTTPError} (like `urllib`), network
 *   failures {@link URLError}.
 *
 * @module authentication/http
 */

import { STATUS_CODES } from 'node:http';
import { isSafeDownloadRedirect, urlPort, urlsplit } from '../download-security.js';
import { getProvider } from './index.js';
import {
  type AuthConfigEntry,
  authWarnings,
  defaultConfigPath,
  findEntriesForUrl,
  hostMatchesPattern,
  loadAuthConfig,
} from './config.js';

// ============================================================================
// Errors
// ============================================================================

/** Equivalent of `urllib.error.URLError`. */
export class URLError extends Error {
  reason: unknown;
  constructor(reason: unknown) {
    super(typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : String(reason));
    this.name = 'URLError';
    this.reason = reason;
    this.message = `<urlopen error ${typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : String(reason)}>`;
  }
}

/** A redirect rejected because it violates the client's security policy. */
export class RedirectPolicyError extends URLError {
  constructor(reason: string) {
    super(reason);
    this.name = 'RedirectPolicyError';
  }
}

/** Equivalent of `urllib.error.HTTPError` (a non-2xx response). */
export class HTTPError extends URLError {
  code: number;
  url: string;
  headers: Headers;
  response: Response | null;
  constructor(url: string, code: number, msg: string, headers: Headers, response: Response | null = null) {
    super(msg);
    this.name = 'HTTPError';
    this.code = code;
    this.url = url;
    this.headers = headers;
    this.response = response;
    this.message = `HTTP Error ${code}: ${msg}`;
  }

  /** Alias of `code` (Python `HTTPError.status`). */
  get status(): number {
    return this.code;
  }

  /** Response body stream (for bounded reads of error bodies). */
  get body(): ReadableStream<Uint8Array> | null {
    return this.response?.body ?? null;
  }

  /** Release the underlying body. */
  close(): void {
    try {
      void this.response?.body?.cancel();
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// Request / response wrappers
// ============================================================================

/** A prepared request (`urllib.request.Request` subset). */
export interface HttpRequest {
  url: string;
  headers: Record<string, string>;
  method?: string;
  body?: string | Uint8Array | null;
}

/** A successful response (`http.client.HTTPResponse` subset) with its final URL. */
export class HttpResponse {
  constructor(public readonly response: Response, public readonly url: string) {}

  get status(): number {
    return this.response.status;
  }

  get headers(): Headers {
    return this.response.headers;
  }

  /** Body stream (accepted by `readResponseLimited`). */
  get body(): ReadableStream<Uint8Array> | null {
    return this.response.body;
  }

  /** `geturl()`. */
  geturl(): string {
    return this.url;
  }

  getHeader(name: string): string | null {
    return this.response.headers.get(name);
  }

  text(): Promise<string> {
    return this.response.text();
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.response.arrayBuffer();
  }

  json(): Promise<unknown> {
    return this.response.json();
  }

  close(): void {
    try {
      void this.response.body?.cancel();
    } catch {
      // ignore
    }
  }
}

/** `(oldUrl, newUrl) => void`; may throw to reject a redirect. */
export type RedirectValidator = (oldUrl: string, newUrl: string) => void;

// ============================================================================
// Config cache
// ============================================================================

let configOverride: AuthConfigEntry[] | null = null;
let configCache: AuthConfigEntry[] | null = null;

/** Override the loaded auth config (tests); `null` restores normal loading. */
export function setAuthConfigOverride(entries: AuthConfigEntry[] | null): void {
  configOverride = entries;
}

/** Forget the cached `auth.json` contents. */
export function resetAuthConfigCache(): void {
  configCache = null;
}

/** Load auth config once per process (override wins). Invalid files warn once and yield `[]`. */
export function loadConfig(): AuthConfigEntry[] {
  if (configOverride !== null) return configOverride;
  if (configCache !== null) return configCache;
  try {
    configCache = loadAuthConfig();
  } catch (exc) {
    authWarnings.emit(`Failed to load ${defaultConfigPath()}: ${(exc as Error).message}. All requests will be unauthenticated.`);
    configCache = [];
  }
  return configCache;
}

function hostnameInHosts(hostname: string, hosts: readonly string[]): boolean {
  return hosts.some((p) => hostMatchesPattern(hostname, p));
}

function validateStrictRedirect(oldUrl: string, newUrl: string): void {
  if (!isSafeDownloadRedirect(oldUrl, newUrl)) {
    throw new RedirectPolicyError(
      `unsafe redirect to ${newUrl}: target must use HTTPS with a hostname, ` +
        'must not enter a local target from a remote host, and may use HTTP only ' +
        'within loopback (for example localhost, 127.0.0.1, ::1)',
    );
  }
}

// ============================================================================
// Core request loop
// ============================================================================

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTIONS = 10;

function reasonPhrase(res: Response): string {
  return res.statusText || STATUS_CODES[res.status] || '';
}

/**
 * Perform `req` following redirects under the auth-stripping + strict
 * redirect policy (`_StripAuthOnRedirect`). `hosts` are the trusted hosts for
 * the attached `Authorization` header.
 */
export async function openRequest(
  req: HttpRequest,
  opts: { timeout?: number; hosts?: readonly string[]; redirectValidator?: RedirectValidator | null } = {},
): Promise<HttpResponse> {
  const timeout = opts.timeout ?? 10;
  const hosts = opts.hosts ?? [];
  let url = req.url;
  let method = (req.method ?? (req.body !== undefined && req.body !== null ? 'POST' : 'GET')).toUpperCase();
  let body = req.body ?? null;
  let headers: Record<string, string> = { ...req.headers };
  const visited: string[] = [];
  for (;;) {
    let res: Response;
    try {
      res = await globalThis.fetch(url, {
        method,
        headers,
        body: body === null ? undefined : body,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, Math.round(timeout * 1000))),
      });
    } catch (e) {
      if (e instanceof URLError) throw e;
      const name = (e as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        const err = new URLError('timed out');
        err.name = 'TimeoutError';
        throw err;
      }
      throw new URLError(e);
    }
    const code = res.status;
    if (REDIRECT_CODES.has(code) && res.headers.get('location')) {
      const location = res.headers.get('location')!;
      let newUrl: string;
      try {
        newUrl = new URL(location, url).toString();
        // Keep the raw spelling when absolute so policy checks see what the server sent.
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(location)) newUrl = location;
      } catch {
        newUrl = location;
      }
      let newParsed: ReturnType<typeof urlsplit>;
      try {
        newParsed = urlsplit(newUrl);
        urlPort(newParsed);
      } catch (exc) {
        void res.body?.cancel();
        throw new RedirectPolicyError(`malformed redirect URL: ${(exc as Error).message}`);
      }
      if (opts.redirectValidator) opts.redirectValidator(url, newUrl);
      validateStrictRedirect(url, newUrl);
      // urllib's HTTPRedirectHandler.redirect_request semantics.
      if (!((method === 'GET' || method === 'HEAD') || ([301, 302, 303].includes(code) && method === 'POST'))) {
        throw new HTTPError(url, code, reasonPhrase(res), res.headers, res);
      }
      visited.push(newUrl);
      if (visited.length >= MAX_REDIRECTIONS || visited.slice(0, -1).includes(newUrl)) {
        throw new HTTPError(
          url,
          code,
          'The HTTP server returned a redirect error that would lead to an infinite loop.\n' +
            `The last 30x error message was:\n${reasonPhrase(res)}`,
          res.headers,
          res,
        );
      }
      void res.body?.cancel();
      const originalAuth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
      const newHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        const lk = k.toLowerCase();
        if (lk === 'content-length' || lk === 'content-type') continue;
        newHeaders[k] = v;
      }
      if (method === 'POST') {
        method = 'GET';
        body = null;
      }
      const oldScheme = urlsplit(url).scheme;
      const hostname = (newParsed.hostname ?? '').toLowerCase();
      const isHttpsDowngrade = oldScheme === 'https' && newParsed.scheme !== 'https';
      for (const k of Object.keys(newHeaders)) if (k.toLowerCase() === 'authorization') delete newHeaders[k];
      if (hostnameInHosts(hostname, hosts) && !isHttpsDowngrade && originalAuth) {
        newHeaders.Authorization = originalAuth;
      }
      headers = newHeaders;
      url = newUrl;
      continue;
    }
    if (!(code >= 200 && code < 300)) {
      throw new HTTPError(url, code, reasonPhrase(res), res.headers, res);
    }
    return new HttpResponse(res, url);
  }
}

function mergeHeaders(extra: Record<string, string> | null | undefined, auth: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  if (extra) {
    for (const [k, v] of Object.entries(extra)) if (k.toLowerCase() !== 'authorization') merged[k] = v;
  }
  Object.assign(merged, auth);
  return merged;
}

/**
 * Build a request, attaching auth from the first matching `auth.json` entry
 * whose token resolves. (Async because some providers acquire tokens remotely.)
 */
export async function buildRequest(url: string, extraHeaders: Record<string, string> | null = null): Promise<HttpRequest> {
  let auth: Record<string, string> = {};
  for (const entry of findEntriesForUrl(url, loadConfig())) {
    const provider = getProvider(entry.provider);
    if (provider === null) continue;
    const token = await provider.resolveToken(entry);
    if (token) {
      auth = provider.authHeaders(token, entry.auth);
      break;
    }
  }
  return { url, headers: mergeHeaders(extraHeaders, auth) };
}

/** Host patterns from every `github` provider entry in `auth.json`. */
export function githubProviderHosts(): string[] {
  const hosts: string[] = [];
  for (const entry of loadConfig()) {
    if (entry.provider === 'github') hosts.push(...entry.hosts);
  }
  return hosts;
}

/** Options for {@link openUrl}. */
export interface OpenUrlOptions {
  timeout?: number;
  extraHeaders?: Record<string, string> | null;
  redirectValidator?: RedirectValidator | null;
}

/**
 * Open `url` with config-driven auth, redirect stripping, and fallthrough:
 * each matching entry is tried (401/403 -> next), then unauthenticated.
 * Other HTTP errors and network failures throw immediately.
 */
export async function openUrl(url: string, opts: OpenUrlOptions = {}): Promise<HttpResponse> {
  const timeout = opts.timeout ?? 10;
  const entries = findEntriesForUrl(url, loadConfig());
  for (const entry of entries) {
    const provider = getProvider(entry.provider);
    if (provider === null) continue;
    const token = await provider.resolveToken(entry);
    if (!token) continue;
    const req: HttpRequest = { url, headers: mergeHeaders(opts.extraHeaders, provider.authHeaders(token, entry.auth)) };
    try {
      return await openRequest(req, { timeout, hosts: entry.hosts, redirectValidator: opts.redirectValidator });
    } catch (exc) {
      if (exc instanceof HTTPError && (exc.code === 401 || exc.code === 403)) {
        exc.close();
        continue;
      }
      throw exc;
    }
  }
  const req: HttpRequest = { url, headers: mergeHeaders(opts.extraHeaders, {}) };
  return openRequest(req, { timeout, hosts: [], redirectValidator: opts.redirectValidator });
}
