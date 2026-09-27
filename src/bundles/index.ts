/**
 * @oakoliver/specify-cli - Bundler
 *
 * Spec Kit bundler — importable, CLI-free logic for the ``specify bundle`` group.
 *
 * This package holds the models, services, and helpers behind the ``specify bundle``
 * subcommand. It is intentionally free of any CLI imports so the orchestration
 * logic can be unit-tested independently of the command surface. The CLI wiring
 * lives in ``src/bundles/commands.ts``.
 *
 * Port of ``specify_cli/bundles/__init__.py``.
 *
 * @module bundles
 */

// ============================================================================
// BundlerError
// ============================================================================

/**
 * Base class for all actionable bundler errors.
 *
 * Carrying a clean message lets the CLI layer print a single, user-facing line
 * on stderr and exit non-zero without leaking a stack trace.
 */
export class BundlerError extends Error {
  override name = 'BundlerError';
  constructor(message = '', options?: { cause?: unknown }) {
    super(message, options);
  }
}
