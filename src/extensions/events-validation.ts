/**
 * @oakoliver/specify-cli - Extension manifest ``events`` validation
 *
 * Port of ``specify_cli.events.validate_events`` (plus ``CANONICAL_EVENTS``),
 * kept inside the extensions package so manifest validation stays synchronous
 * and does not depend on the (heavier) events runtime module being loaded.
 *
 * @module extensions/events-validation
 */

import { ValidationError } from './errors.js';
import { pyRepr } from '../bundles/pycompat.js';

/** Canonical native event names an extension may declare. */
export const CANONICAL_EVENTS: ReadonlySet<string> = new Set([
  'session_start',
  'pre_tool_use',
  'post_tool_use',
  'session_end',
  'user_prompt_submit',
  'stop',
]);

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the ``events`` field in extension manifest data. */
export function validateEvents(data: Record<string, unknown>): void {
  const events = data.events;
  if ('events' in data && !isMapping(events)) {
    throw new ValidationError('Invalid events: expected a mapping');
  }
  if (!isMapping(events)) return;
  for (const [eventName, eventConfig] of Object.entries(events)) {
    if (!isMapping(eventConfig)) {
      throw new ValidationError(`Invalid event '${eventName}': expected a mapping`);
    }
    const command = eventConfig.command;
    if (typeof command !== 'string' || !command.trim()) {
      throw new ValidationError(`Event '${eventName}' missing required 'command' string`);
    }
    if (!CANONICAL_EVENTS.has(eventName)) {
      throw new ValidationError(
        `Unknown event '${eventName}': must be one of ${pyRepr([...CANONICAL_EVENTS].sort())}`,
      );
    }
    const matcher = eventConfig.matcher;
    if (matcher !== null && matcher !== undefined && typeof matcher !== 'string') {
      throw new ValidationError(`Event '${eventName}' has invalid 'matcher': must be a string`);
    }
    const timeout = eventConfig.timeout;
    if (timeout !== null && timeout !== undefined) {
      if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) {
        throw new ValidationError(
          `Event '${eventName}' has invalid 'timeout': must be a positive integer`,
        );
      }
    }
  }
}

/** Return true if ``events`` is present and non-empty. */
export function hasEvents(data: Record<string, unknown>): boolean {
  const events = data.events;
  return isMapping(events) ? Object.keys(events).length > 0 : Boolean(events);
}
