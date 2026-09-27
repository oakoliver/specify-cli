/**
 * @oakoliver/specify-cli - Authentication provider registry
 *
 * Port of upstream `authentication/__init__.py`. Credentials are opt-in only:
 * no authentication headers are sent unless `~/.specify/auth.json` maps hosts
 * to providers.
 *
 * @module authentication
 */

import { ValueError, pyRepr } from '../download-security.js';
import { AzureDevOpsAuth } from './azure-devops.js';
import type { AuthProvider } from './base.js';
import { BitbucketAuth } from './bitbucket.js';
import { GitHubAuth } from './github.js';

/** Maps provider key -> provider instance. */
export const AUTH_REGISTRY: Record<string, AuthProvider> = {};

/** Python-style KeyError. */
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}

/** Register a provider instance. Throws ValueError for empty keys, KeyError for duplicates. */
export function registerProvider(provider: AuthProvider): void {
  const key = provider.key;
  if (!key) throw new ValueError('Cannot register provider with an empty key.');
  if (key in AUTH_REGISTRY) throw new KeyError(`Provider with key ${pyRepr(key)} is already registered.`);
  AUTH_REGISTRY[key] = provider;
}

/** Return the provider for `key`, or null if not registered. */
export function getProvider(key: string): AuthProvider | null {
  return Object.prototype.hasOwnProperty.call(AUTH_REGISTRY, key) ? AUTH_REGISTRY[key] : null;
}

function registerBuiltins(): void {
  registerProvider(new AzureDevOpsAuth());
  registerProvider(new BitbucketAuth());
  registerProvider(new GitHubAuth());
}

registerBuiltins();

export { AuthProvider } from './base.js';
export { AzureDevOpsAuth, BitbucketAuth, GitHubAuth };
