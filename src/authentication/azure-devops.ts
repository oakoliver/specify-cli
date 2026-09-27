/**
 * @oakoliver/specify-cli - Azure DevOps authentication provider
 *
 * Port of upstream `authentication/azure_devops.py`.
 *
 * @module authentication/azure-devops
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { MAX_JSON_METADATA_BYTES, ValueError, pyRepr, readResponseLimited } from '../download-security.js';
import { which } from '../utils.js';
import { AuthProvider } from './base.js';
import type { AuthConfigEntry } from './config.js';
import { URLError, openRequest } from './http.js';

/** Azure DevOps resource ID for OAuth / Azure AD token acquisition. */
export const ADO_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798';

class TokenResponseTooLarge extends Error {}

/** Return a normalized token from a JSON object, or null for other shapes. */
export function extractToken(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const token = (payload as Record<string, unknown>)[key];
  if (typeof token !== 'string') return null;
  return token.trim() || null;
}

/** Hooks for tests (Python tests patch `subprocess.run` / `shutil.which`). */
export const azureHooks = {
  which: (cmd: string): string | null => which(cmd),
  run: (cmd: string[]): { status: number | null; stdout: string | Buffer; error?: Error } => {
    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'buffer', timeout: 30_000 });
    return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), error: r.error };
  },
};

/**
 * Azure DevOps provider: `basic-pat` (`:<PAT>` Base64), `bearer`,
 * `azure-cli` (`az account get-access-token`), `azure-ad` (client credentials).
 */
export class AzureDevOpsAuth extends AuthProvider {
  override key = 'azure-devops';
  override supportedAuthSchemes: readonly string[] = ['basic-pat', 'bearer', 'azure-cli', 'azure-ad'];

  authHeaders(token: string, authScheme: string): Record<string, string> {
    if (authScheme === 'basic-pat') {
      // eslint-disable-next-line no-control-regex
      if (/[^\x00-\x7f]/.test(token)) {
        throw new ValueError("'ascii' codec can't encode characters in PAT");
      }
      return { Authorization: `Basic ${Buffer.from(`:${token}`, 'ascii').toString('base64')}` };
    }
    if (authScheme === 'bearer' || authScheme === 'azure-cli' || authScheme === 'azure-ad') {
      return { Authorization: `Bearer ${token}` };
    }
    throw new ValueError(`AzureDevOpsAuth does not support auth scheme ${pyRepr(authScheme)}`);
  }

  override resolveToken(entry: AuthConfigEntry): string | null | Promise<string | null> {
    if (entry.auth === 'azure-cli') return AzureDevOpsAuth.acquireViaAzCli();
    if (entry.auth === 'azure-ad') return AzureDevOpsAuth.acquireViaClientCredentials(entry);
    return super.resolveToken(entry);
  }

  /** Run `az account get-access-token` and return the access token. */
  static acquireViaAzCli(): string | null {
    try {
      const resolved = azureHooks.which('az');
      const az = resolved && path.isAbsolute(resolved) ? resolved : 'az';
      const result = azureHooks.run([az, 'account', 'get-access-token', '--resource', ADO_RESOURCE_ID, '--output', 'json']);
      if (result.error || result.status !== 0) return null;
      const raw = result.stdout;
      const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: true }).decode(raw);
      return extractToken(JSON.parse(text), 'accessToken');
    } catch {
      return null;
    }
  }

  /** Acquire a token via the OAuth2 client credentials flow (redirects refused). */
  static async acquireViaClientCredentials(entry: AuthConfigEntry): Promise<string | null> {
    if (!entry.tenant_id || !entry.client_id || !entry.client_secret_env) return null;
    const clientSecret = (process.env[entry.client_secret_env] ?? '').trim();
    if (!clientSecret) return null;
    const url = `https://login.microsoftonline.com/${entry.tenant_id}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: entry.client_id,
      client_secret: clientSecret,
      scope: `${ADO_RESOURCE_ID}/.default`,
    }).toString();
    try {
      const resp = await openRequest(
        { url, method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        {
          timeout: 30,
          hosts: [],
          redirectValidator: (_old, newUrl) => {
            throw new URLError(`Azure AD token request must not be redirected to ${newUrl}`);
          },
        },
      );
      const data = await readResponseLimited(resp, {
        maxBytes: MAX_JSON_METADATA_BYTES,
        errorType: TokenResponseTooLarge,
        label: 'Azure DevOps token response',
      });
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      return extractToken(JSON.parse(text), 'access_token');
    } catch (e) {
      if (e instanceof URLError || e instanceof SyntaxError || e instanceof TypeError || e instanceof TokenResponseTooLarge) {
        return null;
      }
      throw e;
    }
  }
}
