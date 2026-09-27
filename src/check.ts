/**
 * @oakoliver/specify-cli - Check Command
 *
 * Port of spec-kit `command_check.py` (v1.0.12): `specify check` detects which
 * integration CLIs (those whose config sets `requires_cli`) and VS Code
 * variants are installed, rendered as a StepTracker tree.
 *
 * @module check
 */

import { StepTracker, console } from './console.js';
import { printBanner } from './ui.js';
import { checkTool } from './utils.js';

// ============================================================================
// Types
// ============================================================================

/** Result of a single tool check (kept for API compatibility with earlier releases). */
export interface CheckResult {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message?: string;
}

/** Minimal shape of an AGENT_CONFIG entry used by `specify check`. */
export interface CheckAgentConfig {
  name: string;
  requires_cli: boolean;
  [key: string]: unknown;
}

/** Summary returned by {@link checkAvailableTools}. */
export interface CheckSummary {
  /** agent key -> whether its CLI was found (IDE-based agents are false). */
  agentResults: Record<string, boolean>;
  tracker: StepTracker;
}

// ============================================================================
// Injection surface (tests)
// ============================================================================

type RegistryLike =
  | Map<string, { config?: Record<string, unknown> | null }>
  | Record<string, { config?: Record<string, unknown> | null }>;

/** Port of `_agent_config._build_agent_config()` over the integration registry. */
export function buildAgentConfig(registry: RegistryLike): Record<string, CheckAgentConfig> {
  const entries = registry instanceof Map ? [...registry.entries()] : Object.entries(registry);
  const config: Record<string, CheckAgentConfig> = {};
  for (const [key, integration] of entries) {
    const cfg = integration?.config;
    if (cfg && Object.keys(cfg).length > 0) config[key] = { ...cfg } as CheckAgentConfig;
  }
  return config;
}

export const checkDeps = {
  // Lazy import: the registry pulls in every integration module (upstream builds
  // AGENT_CONFIG at import time of _agent_config.py).
  agentConfig: async (): Promise<Record<string, CheckAgentConfig>> => {
    const { INTEGRATION_REGISTRY } = await import('./integrations/index.js');
    return buildAgentConfig(INTEGRATION_REGISTRY as unknown as RegistryLike);
  },
  checkTool: (tool: string, tracker?: StepTracker | null): boolean => checkTool(tool, tracker ?? undefined),
  // Keep this port's animated gradient banner (upstream: show_banner()).
  showBanner: (): Promise<void> => printBanner(),
};

// ============================================================================
// Check
// ============================================================================

/** Run the tool checks without printing (used by `specify check`). */
export async function checkAvailableTools(): Promise<CheckSummary> {
  const tracker = new StepTracker('Check Available Tools');
  const agentResults: Record<string, boolean> = {};

  for (const [agentKey, agentConfig] of Object.entries(await checkDeps.agentConfig())) {
    if (agentKey === 'generic') continue;
    tracker.add(agentKey, String(agentConfig.name));
    if (agentConfig.requires_cli) {
      agentResults[agentKey] = checkDeps.checkTool(agentKey, tracker);
    } else {
      tracker.skip(agentKey, 'IDE-based, no CLI check');
      agentResults[agentKey] = false;
    }
  }

  tracker.add('code', 'Visual Studio Code');
  checkDeps.checkTool('code', tracker);

  tracker.add('code-insiders', 'Visual Studio Code Insiders');
  checkDeps.checkTool('code-insiders', tracker);

  return { agentResults, tracker };
}

/**
 * Check that all required tools are installed (`specify check`).
 * Always succeeds (upstream exits 0); returns true for backward compatibility.
 */
export async function check(): Promise<boolean> {
  await checkDeps.showBanner();
  console.print('[bold]Checking for installed tools...[/bold]\n');

  const { agentResults, tracker } = await checkAvailableTools();

  console.print(tracker.render());

  console.print('\n[bold green]Specify CLI is ready to use![/bold green]');

  if (!Object.values(agentResults).some(Boolean)) {
    console.print('[dim]Tip: Install a coding agent for the best experience[/dim]');
  }

  console.print("[dim]Tip: Run 'specify self check' to verify you have the latest CLI version[/dim]");
  return true;
}
