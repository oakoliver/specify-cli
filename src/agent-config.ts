/**
 * @oakoliver/specify-cli - Agent configuration
 *
 * Port of upstream `_agent_config.py`: agent configuration constants derived
 * from the integration registry. `AGENT_CONFIG` is built lazily on first
 * access so importing this module does not force the registry to load
 * (avoids ESM import cycles).
 *
 * @module agent-config
 */

import { INTEGRATION_REGISTRY } from './integrations/index.js';

export type AgentConfigEntry = Record<string, unknown>;

function buildAgentConfig(): Record<string, AgentConfigEntry> {
  const config: Record<string, AgentConfigEntry> = {};
  const registry = INTEGRATION_REGISTRY as unknown as Record<string, { config?: Record<string, unknown> | null }>;
  for (const [key, integration] of Object.entries(registry)) {
    if (integration && integration.config && Object.keys(integration.config).length) {
      config[key] = { ...integration.config };
    }
  }
  return config;
}

let built: Record<string, AgentConfigEntry> | null = null;

/** Return the (cached) agent config mapping. */
export function getAgentConfig(): Record<string, AgentConfigEntry> {
  built ??= buildAgentConfig();
  return built;
}

/** Agent key -> integration config (lazy view over the integration registry). */
export const AGENT_CONFIG: Record<string, AgentConfigEntry> = new Proxy({} as Record<string, AgentConfigEntry>, {
  get: (_t, prop) => (typeof prop === 'string' ? getAgentConfig()[prop] : undefined),
  has: (_t, prop) => typeof prop === 'string' && prop in getAgentConfig(),
  ownKeys: () => Reflect.ownKeys(getAgentConfig()),
  getOwnPropertyDescriptor: (_t, prop) => {
    const cfg = getAgentConfig();
    if (typeof prop === 'string' && prop in cfg) {
      return { value: cfg[prop], enumerable: true, configurable: true, writable: false };
    }
    return undefined;
  },
});

export const DEFAULT_INIT_INTEGRATION = 'copilot';

/** Env var overriding the fallback integration chosen by non-interactive `specify init`. */
export const DEFAULT_INIT_INTEGRATION_ENV_VAR = 'SPECKIT_INTEGRATION_DEFAULT';

/**
 * Return the default init integration, honoring `SPECKIT_INTEGRATION_DEFAULT`.
 * An unrecognized value prints a warning to stderr and falls back to copilot.
 */
export function resolveDefaultInitIntegration(): string {
  const override = (process.env[DEFAULT_INIT_INTEGRATION_ENV_VAR] ?? '').trim();
  if (!override) return DEFAULT_INIT_INTEGRATION;
  const cfg = getAgentConfig();
  if (override in cfg) return override;
  process.stderr.write(
    `Warning: ${DEFAULT_INIT_INTEGRATION_ENV_VAR}='${override}' is not a recognized integration; ` +
      `falling back to '${DEFAULT_INIT_INTEGRATION}'. Choose from: ${Object.keys(cfg).sort().join(', ')}.\n`,
  );
  return DEFAULT_INIT_INTEGRATION;
}

export const SCRIPT_TYPE_CHOICES: Record<string, string> = {
  sh: 'POSIX Shell (bash/zsh)',
  ps: 'PowerShell',
  py: 'Python',
};
