/**
 * @oakoliver/specify-cli - Bitbucket authentication provider
 *
 * Port of upstream `authentication/bitbucket.py`.
 *
 * @module authentication/bitbucket
 */

import { ValueError, pyRepr } from '../download-security.js';
import { AuthProvider } from './base.js';
import type { AuthConfigEntry } from './config.js';

/**
 * Bitbucket provider (Cloud and Data Center): `bearer` access tokens and
 * `basic` (`<username>:<secret>`, e.g. Atlassian API tokens).
 */
export class BitbucketAuth extends AuthProvider {
  override key = 'bitbucket';
  override supportedAuthSchemes: readonly string[] = ['bearer', 'basic'];

  authHeaders(token: string, authScheme: string): Record<string, string> {
    if (authScheme === 'bearer') return { Authorization: `Bearer ${token}` };
    if (authScheme === 'basic') {
      const idx = token.indexOf(':');
      const username = idx >= 0 ? token.slice(0, idx) : token;
      const secret = idx >= 0 ? token.slice(idx + 1) : '';
      if (idx < 0 || !username || !secret) {
        throw new ValueError(
          "BitbucketAuth 'basic' expects a '<username>:<secret>' credential with both parts non-empty, as produced by resolve_token()",
        );
      }
      return { Authorization: `Basic ${Buffer.from(token, 'utf8').toString('base64')}` };
    }
    throw new ValueError(`BitbucketAuth does not support auth scheme ${pyRepr(authScheme)}`);
  }

  override resolveToken(entry: AuthConfigEntry): string | null {
    const secret = super.resolveToken(entry) as string | null;
    if (entry.auth !== 'basic') return secret;
    const username = (entry.username ?? '').trim();
    if (!secret || !username || username.includes(':')) return null;
    return `${username}:${secret}`;
  }
}
