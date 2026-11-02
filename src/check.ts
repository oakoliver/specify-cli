/**
 * @oakoliver/specify-cli - Check Command
 *
 * Port of spec-kit `command_check.py` (v1.2.5): `specify check` detects which
 * integration CLIs (those whose config sets `requires_cli`) and VS Code
 * variants are installed, rendered as a StepTracker tree.
 *
 * @module check
 */

import { CliExit, StepTracker, console, escapeMarkup } from './console.js';
import {
  ProjectResolutionError,
  preflightProjectPolicy,
  renderProjectError,
  resolveInitDirOverride,
} from './project.js';
import { printBanner } from './ui.js';
import { checkTool, which } from './utils.js';

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
  /**
   * Installed external-integration records keyed by integration
   * (upstream: `integrations.installer.load_installed_integrations` +
   * `read_records`). Catalog-installed adapters plug in here; with none
   * installed the map is empty and every integration uses `check_tool`.
   */
  installedRecords: async (_projectRoot: string): Promise<Record<string, InstalledIntegrationRecord>> => ({}),
  /** Resolve an integration instance by key (upstream: `get_integration`). */
  getIntegration: async (key: string): Promise<ExternalToolIntegration | null> => {
    const { getIntegration } = await import('./integrations/index.js');
    return (getIntegration(key) as unknown as ExternalToolIntegration | null) ?? null;
  },
  which: (tool: string): string | null => which(tool),
};

/** Minimal installed-integration record consumed by `specify check`. */
export interface InstalledIntegrationRecord {
  requires: { tools?: Array<{ name: string; required?: boolean }> };
  [key: string]: unknown;
}

/** Integration surface used for external tool checks. */
export interface ExternalToolIntegration {
  buildExecArgs(prompt: string, opts?: { projectRoot?: string | null }): string[] | null;
  resolveExecutable(): string;
}

/** Port of `_check_external_tools`: check the CLI tools an installed integration declares. */
export async function checkExternalTools(
  projectRoot: string,
  key: string,
  record: InstalledIntegrationRecord,
  requiresCli: boolean,
  tracker: StepTracker,
): Promise<boolean> {
  const integration = await checkDeps.getIntegration(key);
  if (integration === null) throw new Error(`Installed integration '${key}' is not registered`);
  let tools = (record.requires.tools ?? []).filter((t) => t.required ?? true).map((t) => t.name);
  if (!tools.length && requiresCli) {
    const args = integration.buildExecArgs('test', { projectRoot });
    tools = [args && args.length ? args[0] : integration.resolveExecutable()];
  }
  if (!tools.length) {
    tracker.skip(key, 'no CLI required');
    return false;
  }
  tools = [...new Set(tools)];
  const missing = tools.filter((t) => checkDeps.which(t) === null);
  if (missing.length) {
    tracker.error(key, 'not found: ' + escapeMarkup(missing.join(', ')));
    return false;
  }
  tracker.complete(key, 'available: ' + escapeMarkup(tools.join(', ')));
  return true;
}

// ============================================================================
// Check
// ============================================================================

/** Run the tool checks without printing (used by `specify check`). */
export async function checkAvailableTools(
  projectRoot: string = process.cwd(),
  records: Record<string, InstalledIntegrationRecord> = {},
): Promise<CheckSummary> {
  const tracker = new StepTracker('Check Available Tools');
  const agentResults: Record<string, boolean> = {};

  for (const [agentKey, agentConfig] of Object.entries(await checkDeps.agentConfig())) {
    if (agentKey === 'generic') continue;
    const requiresCli = Boolean(agentConfig.requires_cli);
    tracker.add(agentKey, escapeMarkup(String(agentConfig.name)));
    if (Object.prototype.hasOwnProperty.call(records, agentKey)) {
      try {
        agentResults[agentKey] = await checkExternalTools(projectRoot, agentKey, records[agentKey]!, requiresCli, tracker);
      } catch (e) {
        console.print(
          `[red]Error:[/red] Cannot check integration '${escapeMarkup(agentKey)}': ${escapeMarkup((e as Error).message)}`,
        );
        throw new CliExit(1);
      }
    } else if (requiresCli) {
      agentResults[agentKey] = checkDeps.checkTool(agentKey, tracker);
    } else {
      tracker.skip(agentKey, 'no CLI required');
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
  let projectRoot: string;
  let records: Record<string, InstalledIntegrationRecord>;
  try {
    const override = resolveInitDirOverride();
    if (override === null) {
      projectRoot = process.cwd();
      preflightProjectPolicy(projectRoot);
    } else {
      projectRoot = override;
    }
    records = await checkDeps.installedRecords(projectRoot);
  } catch (e) {
    if (e instanceof ProjectResolutionError) renderProjectError(e);
    if (e instanceof CliExit) throw e;
    console.print(`[red]Error:[/red] ${escapeMarkup((e as Error).message)}`);
    throw new CliExit(1);
  }

  await checkDeps.showBanner();
  console.print('[bold]Checking for installed tools...[/bold]\n');

  const { agentResults, tracker } = await checkAvailableTools(projectRoot, records);

  console.print(tracker.render());

  console.print('\n[bold green]Specify CLI is ready to use![/bold green]');

  if (!Object.values(agentResults).some(Boolean)) {
    console.print('[dim]Tip: Install a coding agent for the best experience[/dim]');
  }

  console.print("[dim]Tip: Run 'specify self check' to verify you have the latest CLI version[/dim]");
  return true;
}
