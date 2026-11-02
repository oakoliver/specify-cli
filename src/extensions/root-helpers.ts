/**
 * @oakoliver/specify-cli - Root CLI helpers used by the extensions package
 *
 * Ports of the small helpers upstream keeps in ``specify_cli/__init__.py``
 * (``_require_specify_project``, ``_print_cli_warning``,
 * ``DEFAULT_SKILLS_DIR``) that the extension commands depend on.
 *
 * @module extensions/root-helpers
 */


import { console } from '../console.js';
import { requireSpecifyProject as requireSpecifyProjectRoot } from '../project.js';

/** Constants kept for backward compatibility with presets and extensions. */
export const DEFAULT_SKILLS_DIR = '.agents/skills';

function cliErrorDetail(exc: unknown): string {
  const raw = exc instanceof Error ? exc.message : String(exc);
  const detail = raw.replace(/\n/g, ' ').trim();
  if (detail) return detail;
  return exc instanceof Error ? exc.name || exc.constructor.name : 'Error';
}

function cliPhaseLabel(phase: string, targetKind: string, target: string | null): string {
  let label = `${phase} ${targetKind}`.trim();
  if (target) label = `${label} '${target}'`;
  return label;
}

/** Print a warning that names the failed CLI phase and target. */
export function printCliWarning(
  phase: string,
  targetKind: string,
  target: string | null,
  exc: unknown,
  opts: { continuing?: string | null } = {},
): void {
  const label = cliPhaseLabel(phase, targetKind, target);
  console.print(`[yellow]Warning:[/yellow] Failed to ${label}: ${cliErrorDetail(exc)}`);
  if (opts.continuing) console.print(`[dim]${opts.continuing}[/dim]`);
}

/**
 * Return the project root if it is a spec-kit project, else exit (1).
 * Honors the ``SPECIFY_INIT_DIR`` override.
 */
export function requireSpecifyProject(): string {
  // #4934: delegate to the root helper, which preflights the persisted symlink policy.
  return requireSpecifyProjectRoot();
}
