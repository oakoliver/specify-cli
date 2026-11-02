/**
 * @oakoliver/specify-cli - Shared ``capture`` contract for command/prompt steps
 *
 * Port of ``specify_cli/workflows/step/_capture.py`` (upstream #4957). Both
 * steps stream the integration CLI's output by default; ``capture: true``
 * retains stdout and stderr in the step output instead, capped per stream by
 * ``capture_max_bytes``.
 *
 * @module workflows/step/capture
 */

import { DEFAULT_CAPTURE_MAX_BYTES, captureMaxBytesIsValid } from '../../integrations/capture.js';
import { dget, dhas, pyRepr, pyStr, type Dict } from '../base.js';

/** Errors for the ``capture``/``capture_max_bytes`` fields (shared by execute and validate). */
export function captureErrors(config: Dict, label: string): string[] {
  const stepId = pyRepr(dget(config, 'id', '?'));
  const errors: string[] = [];
  const capture = dget(config, 'capture', false);
  if (dhas(config, 'capture') && typeof capture !== 'boolean') {
    errors.push(`${label} step ${stepId}: 'capture' must be true or false, got ${pyRepr(capture)}.`);
  }
  if (dhas(config, 'capture_max_bytes')) {
    const maxBytes = config.capture_max_bytes;
    if (!captureMaxBytesIsValid(maxBytes)) {
      errors.push(
        `${label} step ${stepId}: 'capture_max_bytes' must be a positive integer or -1 (no limit), got ${pyRepr(maxBytes)}.`,
      );
    } else if (capture !== true) {
      // A limit on a step that streams would silently do nothing.
      errors.push(`${label} step ${stepId}: 'capture_max_bytes' requires 'capture: true'.`);
    }
  }
  return errors;
}

/** The per-stream byte limit, or ``null`` when the step streams. */
export function captureLimit(config: Dict): number | null {
  if (dget(config, 'capture', false) !== true) return null;
  return dget(config, 'capture_max_bytes', DEFAULT_CAPTURE_MAX_BYTES) as number;
}

/** An error message if ``config.timeout`` is invalid, else ``null``. */
export function timeoutError(config: Dict, label: string): string | null {
  if (!dhas(config, 'timeout')) return null;
  const timeout = config.timeout;
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) return null;
  return (
    `${label} step ${pyRepr(dget(config, 'id', '?'))}: 'timeout' must be a ` +
    `positive number of seconds, got ${pyRepr(timeout)}.`
  );
}

/** Add the capture-only completeness fields to a step's *output*. */
export function recordCapture(output: Dict, dispatchResult: Dict): void {
  for (const field of ['stdout_truncated', 'stderr_truncated', 'timed_out', 'interrupted']) {
    output[field] = Boolean(dget(dispatchResult, field, false));
  }
}

/** The error summary for a failed captured dispatch (never the captured stderr). */
export function captureFailure(dispatchResult: Dict, subject: string, timeout: number): string {
  if (dget(dispatchResult, 'interrupted', false)) return 'Interrupted by user';
  if (dget(dispatchResult, 'timed_out', false)) return `${subject} timed out after ${pyStr(timeout)} seconds.`;
  return `${subject} exited with code ${pyStr(dispatchResult.exit_code)}`;
}
