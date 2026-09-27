/**
 * @oakoliver/specify-cli - Invocation style
 *
 * Port of upstream `_invocation_style.py`: agent invocation-style constants
 * and helpers (`$speckit-<name>`, `/speckit-<name>`, `/skill:<name>`).
 *
 * @module invocation-style
 */

/** Agents that render $speckit-<name> (chat invocation) when in skills mode. */
export const DOLLAR_SKILLS_AGENTS: ReadonlySet<string> = new Set(['codex', 'zcode', 'command-code']);

/** Agents that always render /speckit-<name>, regardless of ai_skills. */
export const ALWAYS_SLASH_AGENTS: ReadonlySet<string> = new Set([
  'devin', 'droid', 'dsh', 'grok', 'muse', 'qodercli', 'trae', 'zed',
]);

/** Agents that render /speckit-<name> only when ai_skills is enabled. */
export const CONDITIONAL_SLASH_AGENTS: ReadonlySet<string> = new Set([
  'agy', 'alquimia', 'bob', 'claude', 'copilot', 'cursor-agent', 'generic', 'hermes', 'lingma', 'rovodev', 'vibe',
]);

/** Agents that render /skill:<name> (skill-colon invocation) when in skills mode. */
export const SKILL_COLON_AGENTS: ReadonlySet<string> = new Set(['kimi']);

/** True if `selectedAi` uses `$speckit-<name>` invocations. */
export function isDollarSkillsAgent(selectedAi: unknown, aiSkillsEnabled: boolean): boolean {
  if (typeof selectedAi !== 'string') return false;
  return DOLLAR_SKILLS_AGENTS.has(selectedAi) && !!aiSkillsEnabled;
}

/** Native invocation prefix: `$` (dollar agents), `/skill:` (kimi), `/` otherwise. */
export function getInvocationPrefix(selectedAi: unknown, aiSkillsEnabled: boolean): string {
  if (typeof selectedAi !== 'string') return '/';
  if (DOLLAR_SKILLS_AGENTS.has(selectedAi) && aiSkillsEnabled) return '$';
  if (SKILL_COLON_AGENTS.has(selectedAi) && aiSkillsEnabled) return '/skill:';
  return '/';
}

/** True if `selectedAi` uses `/speckit-<name>` invocations. */
export function isSlashSkillsAgent(selectedAi: unknown, aiSkillsEnabled: boolean): boolean {
  if (selectedAi === null || selectedAi === undefined) return false;
  if (typeof selectedAi !== 'string') return false;
  return ALWAYS_SLASH_AGENTS.has(selectedAi) || (CONDITIONAL_SLASH_AGENTS.has(selectedAi) && !!aiSkillsEnabled);
}
