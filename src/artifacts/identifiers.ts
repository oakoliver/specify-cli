/**
 * @oakoliver/specify-cli - Artifact identifier helpers
 *
 * Port of spec-kit v1.0.12 ``specify_cli/artifacts/_identifiers.py``:
 * identifier helpers private to the artifact JSON surface.
 *
 * @module artifacts/identifiers
 */

import { pyTypeName, unquoteToBytes, urlQuote } from '../events/py-compat.js';

// ============================================================================
// Constants
// ============================================================================

export const PROJECT_OVERRIDE_LAYER = 'project';
const ARTIFACT_KINDS: ReadonlySet<string> = new Set(['command', 'template', 'script']);
const LAYER_KINDS: ReadonlySet<string> = new Set([PROJECT_OVERRIDE_LAYER, 'preset', 'extension']);
const HOOK_LAYERS: ReadonlySet<string> = new Set(['preset', 'extension']);
const INVALID_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** Raised when a value cannot be represented in an artifact identifier. */
export class IdentifierComponentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentifierComponentError';
  }
}

// ============================================================================
// Builders
// ============================================================================

/** Return a non-empty string that does not contain the ID delimiter. */
export function validateComponent(value: unknown, fieldLabel: string): string {
  if (typeof value !== 'string') {
    throw new IdentifierComponentError(`Invalid ${fieldLabel}: expected a string, got ${pyTypeName(value)}`);
  }
  if (!value) throw new IdentifierComponentError(`Invalid ${fieldLabel}: value must not be empty`);
  if (value.includes(':')) {
    throw new IdentifierComponentError(
      `Invalid ${fieldLabel} '${value}': ':' is reserved as an identifier delimiter`,
    );
  }
  return value;
}

/** Build the source-agnostic identifier exposed by ``specify artifact``. */
export function derivePublicId(kind: string, name: string): string {
  validateComponent(kind, 'kind');
  if (!ARTIFACT_KINDS.has(kind)) throw new IdentifierComponentError(`Invalid public artifact kind '${kind}'`);
  validateComponent(name, 'name');
  return `${kind}:${name}`;
}

/** Build an artifact-stack lookup identifier. */
export function deriveLookupId(layer: string, sourceId: string, kind: string, name: string): string {
  validateComponent(layer, 'layer');
  validateComponent(sourceId, 'sourceId');
  validateComponent(kind, 'kind');
  validateComponent(name, 'name');
  if (!LAYER_KINDS.has(layer)) throw new IdentifierComponentError(`Invalid layer '${layer}'`);
  if (!ARTIFACT_KINDS.has(kind)) throw new IdentifierComponentError(`Invalid artifact kind '${kind}'`);
  if (layer === PROJECT_OVERRIDE_LAYER && sourceId !== '_') {
    throw new IdentifierComponentError(`Invalid sourceId '${sourceId}': project layer requires '_'`);
  }
  if (layer !== PROJECT_OVERRIDE_LAYER && sourceId === '_') {
    throw new IdentifierComponentError("Invalid sourceId '_': reserved for project layer");
  }
  return `${layer}:${sourceId}:${kind}:${name}`;
}

/** Build the source-agnostic identifier for a hook artifact. */
export function deriveHookPublicId(eventName: unknown, command: unknown): string {
  const encodedEvent = encodeHookComponent(eventName, 'eventName');
  const encodedCommand = encodeHookComponent(command, 'command');
  return `hook:${encodedEvent}:${encodedCommand}`;
}

/** Build the artifact-private lookup identifier for a hook declaration. */
export function deriveHookLookupId(layer: string, sourceId: string, eventName: unknown, command: unknown): string {
  validateComponent(layer, 'layer');
  validateComponent(sourceId, 'sourceId');
  const encodedEvent = encodeHookComponent(eventName, 'eventName');
  const encodedCommand = encodeHookComponent(command, 'command');
  if (!HOOK_LAYERS.has(layer)) throw new IdentifierComponentError(`Invalid hook layer '${layer}'`);
  if (sourceId === '_') {
    throw new IdentifierComponentError("Invalid sourceId '_': hooks require a preset or extension source");
  }
  return `${layer}:${sourceId}:hook:${encodedEvent}:${encodedCommand}`;
}

/** Decode the ``{eventName}:{targetCommand}`` portion of a hook artifact ID. */
export function parseHookArtifactName(name: string): [string, string] {
  const idx = name.indexOf(':');
  if (idx === -1) throw new IdentifierComponentError('Invalid hook artifact name');
  const encodedEvent = name.slice(0, idx);
  const encodedCommand = name.slice(idx + 1);
  if (encodedCommand.includes(':')) throw new IdentifierComponentError('Invalid hook artifact name');
  return [decodeHookComponent(encodedEvent, 'eventName'), decodeHookComponent(encodedCommand, 'command')];
}

/** Parse a contribution lookup ID into layer, source, kind, and name. */
export function parseLookupId(value: unknown): [string, string, string, string] {
  if (typeof value !== 'string') throw new IdentifierComponentError('Invalid lookupId');
  const parts = value.split(':');
  if (parts.length === 4) {
    const [layer, sourceId, kind, name] = parts as [string, string, string, string];
    deriveLookupId(layer, sourceId, kind, name);
    return [layer, sourceId, kind, name];
  }
  if (parts.length === 5 && parts[2] === 'hook') {
    const [layer, sourceId, kind, encodedEvent, encodedCommand] = parts as [string, string, string, string, string];
    if (!HOOK_LAYERS.has(layer) || sourceId === '_') throw new IdentifierComponentError('Invalid hook lookupId');
    const [eventName, command] = parseHookArtifactName(`${encodedEvent}:${encodedCommand}`);
    if (deriveHookLookupId(layer, sourceId, eventName, command) !== value) {
      throw new IdentifierComponentError('Invalid hook lookupId');
    }
    return [layer, sourceId, kind, `${encodedEvent}:${encodedCommand}`];
  }
  throw new IdentifierComponentError('Invalid lookupId');
}

// ============================================================================
// Hook component encoding
// ============================================================================

function encodeHookComponent(value: unknown, fieldLabel: string): string {
  if (typeof value !== 'string') {
    throw new IdentifierComponentError(`Invalid ${fieldLabel}: expected a string, got ${pyTypeName(value)}`);
  }
  if (!value) throw new IdentifierComponentError(`Invalid ${fieldLabel}: value must not be empty`);
  if (LONE_SURROGATE.test(value)) {
    throw new IdentifierComponentError(`Invalid ${fieldLabel}: value cannot be UTF-8 encoded`);
  }
  return urlQuote(value);
}

function decodeHookComponent(value: string, fieldLabel: string): string {
  validateComponent(value, fieldLabel);
  if (INVALID_PERCENT_ESCAPE.test(value)) {
    throw new IdentifierComponentError(`Invalid ${fieldLabel}: malformed percent escape`);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(unquoteToBytes(value));
  } catch {
    throw new IdentifierComponentError(`Invalid ${fieldLabel}: value is not valid UTF-8`);
  }
  if (!decoded) throw new IdentifierComponentError(`Invalid ${fieldLabel}: value must not be empty`);
  return decoded;
}
