/**
 * @oakoliver/specify-cli - Extension errors
 *
 * @module extensions/errors
 */

/** Base exception for extension-related errors. */
export class ExtensionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExtensionError';
  }
}

/** Raised when extension manifest validation fails. */
export class ValidationError extends ExtensionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ValidationError';
  }
}

/** Raised when extension is incompatible with current environment. */
export class CompatibilityError extends ExtensionError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CompatibilityError';
  }
}

/** Python ``KeyError`` analogue raised by ``ExtensionRegistry.update``. */
export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyError';
  }
}
