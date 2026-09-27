/**
 * @oakoliver/specify-cli - Authentication configuration
 *
 * Port of upstream `authentication/config.py`: reads `~/.specify/auth.json`
 * to determine which hosts receive credentials and which provider/scheme to
 * use. No credentials are sent without an explicit opt-in via this file.
 *
 * @module authentication/config
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ValueError, pyRepr, urlPort, urlsplit } from '../download-security.js';
import { isPlainObject, pyTypeName } from '../utils.js';
import { AUTH_REGISTRY, getProvider } from './index.js';

/** A single provider entry from `auth.json` (frozen dataclass `AuthConfigEntry`). */
export interface AuthConfigEntry {
  readonly hosts: readonly string[];
  readonly provider: string;
  readonly auth: string;
  readonly token?: string | null;
  readonly token_env?: string | null;
  readonly tenant_id?: string | null;
  readonly client_id?: string | null;
  readonly client_secret_env?: string | null;
  readonly username?: string | null;
}

/** Build an {@link AuthConfigEntry} with Python defaults (`None`) filled in. */
export function makeAuthConfigEntry(init: {
  hosts: readonly string[];
  provider: string;
  auth: string;
  token?: string | null;
  token_env?: string | null;
  tenant_id?: string | null;
  client_id?: string | null;
  client_secret_env?: string | null;
  username?: string | null;
}): AuthConfigEntry {
  return Object.freeze({
    hosts: Object.freeze([...init.hosts]),
    provider: init.provider,
    auth: init.auth,
    token: init.token ?? null,
    token_env: init.token_env ?? null,
    tenant_id: init.tenant_id ?? null,
    client_id: init.client_id ?? null,
    client_secret_env: init.client_secret_env ?? null,
    username: init.username ?? null,
  });
}

/** Warning sink (Python `warnings.warn(..., UserWarning)`); replaceable in tests. */
export const authWarnings = {
  emit(message: string): void {
    process.stderr.write(`UserWarning: ${message}\n`);
  },
};

/** Return `~/.specify/auth.json`. */
export function defaultConfigPath(): string {
  const home = (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) || os.homedir();
  return path.join(home, '.specify', 'auth.json');
}

/** True for safe host patterns: exact hostnames or `*.suffix` only. */
export function isValidHostPattern(pattern: string): boolean {
  if ([...'?[]'].some((c) => pattern.includes(c))) return false;
  if (!pattern.includes('*')) return true;
  return pattern.startsWith('*.') && pattern.length > 2 && !pattern.slice(2).includes('*');
}

/** Match a hostname against an exact host or leading `*.` wildcard. */
export function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.') && isValidHostPattern(p)) return h.endsWith(p.slice(1));
  return h === p;
}

function norm<T>(value: T): T {
  return (typeof value === 'string' ? value.trim() : value) as T;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Load and validate `auth.json`. Returns `[]` when the file does not exist.
 * Throws {@link ValueError} on schema violations.
 */
export function loadAuthConfig(configPathArg: string | null = null): AuthConfigEntry[] {
  const configPath = configPathArg || defaultConfigPath();
  if (!isFile(configPath)) return [];
  if (process.platform !== 'win32') {
    try {
      const mode = fs.statSync(configPath).mode;
      if (mode & 0o044) {
        authWarnings.emit(
          `${configPath} is readable by group/others. Consider restricting with: chmod 600 ${configPath}`,
        );
      }
    } catch {
      // stat failed; skip permission check
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (exc) {
    if (exc instanceof SyntaxError) throw new ValueError(`${configPath} contains invalid JSON: ${exc.message}`);
    throw exc;
  }
  if (!isPlainObject(raw)) throw new ValueError(`auth.json must be a JSON object, got ${pyTypeName(raw)}`);
  const providersRaw = raw.providers;
  if (!Array.isArray(providersRaw)) throw new ValueError("auth.json must contain a 'providers' array");

  const entries: AuthConfigEntry[] = [];
  providersRaw.forEach((entryRaw: unknown, i: number) => {
    if (!isPlainObject(entryRaw)) throw new ValueError(`providers[${i}]: must be a JSON object`);
    let hosts = entryRaw.hosts;
    if (!Array.isArray(hosts) || !hosts.length) throw new ValueError(`providers[${i}]: 'hosts' must be a non-empty array`);
    if (!hosts.every((h) => typeof h === 'string' && h.trim())) {
      throw new ValueError(`providers[${i}]: each host must be a non-empty string`);
    }
    hosts = (hosts as string[]).map((h) => h.trim().toLowerCase());
    for (const h of hosts as string[]) {
      if (!isValidHostPattern(h)) {
        throw new ValueError(
          `providers[${i}]: invalid host pattern ${pyRepr(h)}. Only exact hostnames or '*.suffix' forms are allowed ` +
            "(e.g. 'github.com' or '*.visualstudio.com').",
        );
      }
    }
    const provider = 'provider' in entryRaw ? entryRaw.provider : '';
    if (typeof provider !== 'string' || !provider) throw new ValueError(`providers[${i}]: 'provider' must be a non-empty string`);
    const auth = 'auth' in entryRaw ? entryRaw.auth : '';
    if (typeof auth !== 'string' || !auth) throw new ValueError(`providers[${i}]: 'auth' must be a non-empty string`);
    const token = entryRaw.token ?? null;
    const tokenEnv = entryRaw.token_env ?? null;
    if (token !== null && (typeof token !== 'string' || !token.trim())) {
      throw new ValueError(`providers[${i}]: 'token' must be a non-empty string`);
    }
    if (tokenEnv !== null && (typeof tokenEnv !== 'string' || !tokenEnv.trim())) {
      throw new ValueError(`providers[${i}]: 'token_env' must be a non-empty string`);
    }
    const prov = getProvider(provider);
    if (prov === null) {
      throw new ValueError(
        `providers[${i}]: unknown provider ${pyRepr(provider)}; registered: ${pyRepr(Object.keys(AUTH_REGISTRY).sort())}`,
      );
    }
    if (!prov.supportedAuthSchemes.includes(auth)) {
      throw new ValueError(
        `providers[${i}]: provider ${pyRepr(provider)} does not support auth scheme ${pyRepr(auth)}; ` +
          `supported: ${pyRepr([...prov.supportedAuthSchemes])}`,
      );
    }
    const username = entryRaw.username ?? null;
    if (username !== null && (typeof username !== 'string' || !username.trim())) {
      throw new ValueError(`providers[${i}]: 'username' must be a non-empty string`);
    }
    if (typeof username === 'string' && username.includes(':')) {
      throw new ValueError(`providers[${i}]: 'username' must not contain ':'`);
    }
    if (['bearer', 'basic-pat', 'basic'].includes(auth) && !token && !tokenEnv) {
      throw new ValueError(`providers[${i}]: auth=${pyRepr(auth)} requires 'token' or 'token_env'`);
    }
    if (auth === 'basic' && !username) {
      throw new ValueError(
        `providers[${i}]: auth='basic' requires 'username' (e.g. the Atlassian account email for Bitbucket API tokens)`,
      );
    }
    if (auth === 'azure-ad') {
      const tenantId = entryRaw.tenant_id;
      const clientId = entryRaw.client_id;
      const clientSecretEnv = entryRaw.client_secret_env;
      if (![tenantId, clientId, clientSecretEnv].every((v) => v !== null && v !== undefined && v !== '' && v !== false && v !== 0)) {
        throw new ValueError(`providers[${i}]: auth='azure-ad' requires 'tenant_id', 'client_id', and 'client_secret_env'`);
      }
      for (const [fieldName, fieldVal] of [
        ['tenant_id', tenantId],
        ['client_id', clientId],
        ['client_secret_env', clientSecretEnv],
      ] as const) {
        if (typeof fieldVal !== 'string' || !fieldVal.trim()) {
          throw new ValueError(`providers[${i}]: '${fieldName}' must be a non-empty string`);
        }
      }
    }
    entries.push(
      makeAuthConfigEntry({
        hosts: hosts as string[],
        provider,
        auth,
        token: token as string | null,
        token_env: norm(tokenEnv as string | null),
        username: norm(username as string | null),
        tenant_id: norm((entryRaw.tenant_id ?? null) as string | null),
        client_id: norm((entryRaw.client_id ?? null) as string | null),
        client_secret_env: norm((entryRaw.client_secret_env ?? null) as string | null),
      }),
    );
  });
  return entries;
}

/** Return entries whose `hosts` match the hostname of `url` (malformed URLs match nothing). */
export function findEntriesForUrl(url: string, entries: readonly AuthConfigEntry[]): AuthConfigEntry[] {
  let hostname: string;
  try {
    const parsed = urlsplit(url);
    hostname = (parsed.hostname ?? '').toLowerCase();
    urlPort(parsed);
  } catch {
    return [];
  }
  if (!hostname) return [];
  return entries.filter((e) => e.hosts.some((p) => hostMatchesPattern(hostname, p)));
}
