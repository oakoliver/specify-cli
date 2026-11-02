/**
 * @oakoliver/specify-cli - GitHub authentication provider
 *
 * Port of upstream `authentication/github.py` (v1.2.5): the `bearer` scheme
 * (PATs, fine-grained PATs, OAuth and App installation tokens) and the
 * `github-cli` scheme (#4960), which acquires a token with
 * `gh auth token --hostname <first configured host>`, caches it (or the
 * sanitized failure) in memory per credential host, and never falls back to
 * another credential or an anonymous request when acquisition fails.
 *
 * @module authentication/github
 */

import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

import { ValueError, pyRepr } from '../download-security.js';
import { which } from '../utils.js';
import { AuthProvider } from './base.js';
import type { AuthConfigEntry } from './config.js';
import { URLError } from './errors.js';

const GITHUB_CLI_TIMEOUT_SECONDS = 10;

/** Return whether `hostname` is a shell-safe DNS hostname. */
export function isSafeCliHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253 || !/^[\x00-\x7f]*$/.test(hostname)) return false;
  const alnum = (c: string): boolean => /^[A-Za-z0-9]$/.test(c);
  return hostname
    .split('.')
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        alnum(label[0]) &&
        alnum(label[label.length - 1]) &&
        [...label].every((c) => alnum(c) || c === '-'),
    );
}

/** Raised when GitHub CLI cannot provide a configured credential. */
export class GitHubCliAuthError extends URLError {
  constructor(reason: string) {
    super(reason);
    this.name = 'GitHubCliAuthError';
  }
}

/** Process seam for tests (upstream tests patch `shutil.which` / `subprocess.run`). */
export const githubCliDeps = {
  which: (cmd: string): string | null => which(cmd),
  run: (
    argv: string[],
    timeoutMs: number,
  ): { status: number | null; stdout: string; timedOut: boolean; error?: Error } => {
    const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: timeoutMs, shell: false });
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return { status: r.status, stdout: r.stdout ?? '', timedOut, error: timedOut ? undefined : r.error };
  },
};

const PREFIX = "GitHub authentication failed for provider 'github': ";

/** GitHub provider: `bearer` and `github-cli` schemes. */
export class GitHubAuth extends AuthProvider {
  override key = 'github';
  override supportedAuthSchemes: readonly string[] = ['bearer', 'github-cli'];
  private readonly githubCliCache = new Map<string, [boolean, string]>();

  authHeaders(token: string, authScheme: string): Record<string, string> {
    if (!this.supportedAuthSchemes.includes(authScheme)) {
      throw new ValueError(`GitHubAuth does not support auth scheme ${pyRepr(authScheme)}`);
    }
    return { Authorization: 'Bearer ' + token };
  }

  /** Resolve a configured token or acquire one from GitHub CLI. */
  override resolveToken(entry: AuthConfigEntry): string | null | Promise<string | null> {
    if (entry.auth !== 'github-cli') return super.resolveToken(entry);
    const credentialHost = GitHubAuth.credentialHostname(entry);
    const cached = this.githubCliCache.get(credentialHost);
    if (cached !== undefined) {
      const [succeeded, value] = cached;
      if (succeeded) return value;
      throw new GitHubCliAuthError(value);
    }
    let token: string;
    try {
      token = GitHubAuth.acquireViaGhCli(credentialHost);
    } catch (e) {
      if (e instanceof GitHubCliAuthError) {
        const message = String(e.reason);
        this.githubCliCache.set(credentialHost, [false, message]);
        throw new GitHubCliAuthError(message);
      }
      throw e;
    }
    this.githubCliCache.set(credentialHost, [true, token]);
    return token;
  }

  /** Use the first configured host for GitHub CLI credential acquisition. */
  static credentialHostname(entry: AuthConfigEntry): string {
    const hostname = entry.hosts[0];
    if (hostname.includes('*')) {
      throw new GitHubCliAuthError(
        PREFIX + 'the first hostname in a github-cli entry must be an exact hostname, not a wildcard.',
      );
    }
    return hostname;
  }

  /** Run the fixed GitHub CLI token command for `hostname`. */
  static acquireViaGhCli(hostname: string): string {
    if (!isSafeCliHostname(hostname)) {
      throw new GitHubCliAuthError(PREFIX + 'the configured hostname is not valid for GitHub CLI authentication.');
    }
    const resolved = githubCliDeps.which('gh');
    if (!resolved || !isAbsolute(resolved)) {
      throw new GitHubCliAuthError(PREFIX + "GitHub CLI ('gh') was not found.");
    }
    const result = githubCliDeps.run([resolved, 'auth', 'token', '--hostname', hostname], GITHUB_CLI_TIMEOUT_SECONDS * 1000);
    if (result.timedOut) {
      throw new GitHubCliAuthError(PREFIX + `GitHub CLI timed out while requesting a token for ${pyRepr(hostname)}.`);
    }
    if (result.error) {
      throw new GitHubCliAuthError(PREFIX + `GitHub CLI could not provide a token for ${pyRepr(hostname)}.`);
    }
    if (result.status !== 0) {
      throw new GitHubCliAuthError(
        PREFIX +
          `GitHub CLI could not provide a token for ${pyRepr(hostname)}. ` +
          `Run 'gh auth login --hostname ${hostname}'.`,
      );
    }
    const token = result.stdout.trim();
    if (!token) {
      throw new GitHubCliAuthError(
        PREFIX + `GitHub CLI returned an empty token for ${pyRepr(hostname)}. Run 'gh auth login --hostname ${hostname}'.`,
      );
    }
    if (!/^[\x00-\x7f]*$/.test(token) || token.includes('\r') || token.includes('\n')) {
      throw new GitHubCliAuthError(PREFIX + `GitHub CLI returned a malformed token for ${pyRepr(hostname)}.`);
    }
    return token;
  }
}
