/**
 * @oakoliver/specify-cli - Authentication provider base
 *
 * Port of upstream `authentication/base.py`.
 *
 * @module authentication/base
 */

import type { AuthConfigEntry } from './config.js';

/**
 * Abstract base class every authentication provider must implement.
 * Subclasses set `key` and `supportedAuthSchemes` and implement `authHeaders`.
 */
export abstract class AuthProvider {
  /** Unique provider identifier. */
  key = '';

  /** Auth schemes this provider supports (e.g. `['bearer']`). */
  supportedAuthSchemes: readonly string[] = [];

  /** Build authentication headers for `token` using `authScheme`. */
  abstract authHeaders(token: string, authScheme: string): Record<string, string>;

  /**
   * Resolve the token for `entry`: `entry.token` (stripped) or the env var
   * named by `entry.token_env`. Providers acquiring tokens dynamically may
   * return a Promise.
   */
  resolveToken(entry: AuthConfigEntry): string | null | Promise<string | null> {
    if (entry.token) return entry.token.trim() || null;
    if (entry.token_env) {
      const val = process.env[entry.token_env];
      if (val !== undefined) {
        const v = val.trim();
        if (v) return v;
      }
    }
    return null;
  }
}
