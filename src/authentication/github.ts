/**
 * @oakoliver/specify-cli - GitHub authentication provider
 *
 * Port of upstream `authentication/github.py`.
 *
 * @module authentication/github
 */

import { ValueError, pyRepr } from '../download-security.js';
import { AuthProvider } from './base.js';

/** GitHub provider: `bearer` scheme (PATs, OAuth tokens, App installation tokens). */
export class GitHubAuth extends AuthProvider {
  override key = 'github';
  override supportedAuthSchemes: readonly string[] = ['bearer'];

  authHeaders(token: string, authScheme: string): Record<string, string> {
    if (authScheme !== 'bearer') {
      throw new ValueError(`GitHubAuth does not support auth scheme ${pyRepr(authScheme)}`);
    }
    return { Authorization: `Bearer ${token}` };
  }
}
