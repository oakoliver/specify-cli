/**
 * @oakoliver/specify-cli - Authentication error base
 *
 * `URLError` lives in its own module so providers (e.g. `GitHubCliAuthError`)
 * can subclass it without an import cycle through `http.ts`.
 *
 * @module authentication/errors
 */

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

