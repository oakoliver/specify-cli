/**
 * @oakoliver/specify-cli - Integration Management (legacy compatibility layer)
 *
 * Programmatic helpers kept from the v1.1.0 port (`loadManifest`,
 * `listIntegrations`, `addIntegration`, `removeIntegration`,
 * `getIntegrationInfo`). They are now thin wrappers over the upstream-parity
 * modules: the integration registry (`src/integrations/index.ts`), hash
 * tracked manifests (`src/integrations/manifest.ts`) and multi-install state
 * in `.specify/integration.json` (`src/integration-state.ts`).
 *
 * The CLI surface is `specify integration install/uninstall/...`
 * (`src/integrations/commands.ts`); `add`/`remove` remain as aliases.
 *
 * @module integration
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { INTEGRATION_REGISTRY, getIntegration } from './integrations/index.js';
import type { IntegrationBase } from './integrations/base.js';
import { IntegrationManifest as HashManifest } from './integrations/manifest.js';
import {
  dedupeIntegrationKeys,
  defaultIntegrationKey,
  installedIntegrationKeys,
  integrationSettings,
  tryReadIntegrationJson,
  writeIntegrationJson,
} from './integration-state.js';
import { withIntegrationSetting } from './integration-runtime.js';
import { getSpeckitVersion } from './assets.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Integration manifest summary (legacy shape): tracked files are listed as
 * project-relative POSIX paths.
 */
export interface IntegrationManifest {
  integration: string;
  version: string;
  installed_at: string;
  files: string[];
}

/** Integration info for listing. */
export interface IntegrationInfo {
  key: string;
  name: string;
  directory: string;
  format: string;
  installed: boolean;
  files_count?: number;
}

// ============================================================================
// Helpers
// ============================================================================

function registryEntries(): Array<[string, IntegrationBase]> {
  const reg = INTEGRATION_REGISTRY as unknown;
  if (reg instanceof Map) return [...(reg as Map<string, IntegrationBase>).entries()];
  return Object.entries(reg as Record<string, IntegrationBase>);
}

function manifestPath(projectRoot: string, integration: string): string {
  return join(projectRoot, '.specify', 'integrations', `${integration}.manifest.json`);
}

function readState(projectRoot: string): Record<string, unknown> {
  const [state] = tryReadIntegrationJson(projectRoot);
  return state ?? {};
}

function infoFor(projectRoot: string, key: string, integration: IntegrationBase): IntegrationInfo {
  const manifest = loadManifest(projectRoot, key);
  const state = readState(projectRoot);
  const dir = integration.registrarConfig?.dir ?? '';
  const installed =
    manifest !== null ||
    installedIntegrationKeys(state).includes(key) ||
    (dir !== '' && existsSync(join(projectRoot, dir)));
  const name = integration.config?.name ?? key;
  return {
    key,
    name,
    directory: dir,
    format: integration.registrarConfig?.format ?? 'markdown',
    installed,
    files_count: manifest?.files.length,
  };
}

// ============================================================================
// Manifest
// ============================================================================

/** Load an integration manifest summary, or null when absent/unreadable. */
export function loadManifest(projectRoot: string, integration: string): IntegrationManifest | null {
  const path = manifestPath(projectRoot, integration);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const files = data['files'];
    const list = Array.isArray(files)
      ? files.map(String)
      : typeof files === 'object' && files !== null
        ? Object.keys(files)
        : [];
    return {
      integration: String(data['integration'] ?? integration),
      version: String(data['version'] ?? ''),
      installed_at: String(data['installed_at'] ?? ''),
      files: list,
    };
  } catch {
    return null;
  }
}

// ============================================================================
// Operations
// ============================================================================

/** List all registered integrations with their install status. */
export function listIntegrations(projectRoot: string): IntegrationInfo[] {
  return registryEntries()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, integration]) => infoFor(projectRoot, key, integration));
}

/** Get info for a single integration, or null when unknown. */
export function getIntegrationInfo(projectRoot: string, integration: string): IntegrationInfo | null {
  const impl = getIntegration(integration);
  if (!impl) return null;
  return infoFor(projectRoot, integration, impl);
}

/**
 * Install an integration's command files (without shared infrastructure) and
 * record it in the manifest and `.specify/integration.json`.
 */
export async function addIntegration(
  projectRoot: string,
  integration: string,
  version: string = getSpeckitVersion(),
  opts: { scriptType?: string; parsedOptions?: Record<string, unknown> | null; rawOptions?: string | null } = {},
): Promise<IntegrationManifest> {
  const impl = getIntegration(integration);
  if (!impl) {
    const available = registryEntries()
      .map(([k]) => k)
      .sort()
      .join(', ');
    throw new Error(`Unknown integration: "${integration}". Supported: ${available}`);
  }
  if (existsSync(manifestPath(projectRoot, integration))) {
    throw new Error(
      `Integration "${integration}" is already installed. Use 'specify integration uninstall ${integration}' first.`,
    );
  }

  const scriptType = opts.scriptType ?? (process.platform === 'win32' ? 'ps' : 'sh');
  const manifest = new HashManifest(impl.key, projectRoot, version);
  try {
    impl.setup(projectRoot, manifest, opts.parsedOptions ?? null, {
      scriptType,
      rawOptions: opts.rawOptions ?? null,
    });
    manifest.save();
  } catch (exc) {
    try {
      impl.teardown(projectRoot, manifest, { force: true });
    } catch {
      // keep original error
    }
    throw exc;
  }

  const state = readState(projectRoot);
  const installed = dedupeIntegrationKeys([...installedIntegrationKeys(state), impl.key]);
  const defaultKey = defaultIntegrationKey(state) ?? impl.key;
  const settings = withIntegrationSetting(state, impl.key, impl, {
    scriptType,
    rawOptions: opts.rawOptions ?? null,
    parsedOptions: opts.parsedOptions ?? null,
    projectRoot,
  });
  writeIntegrationJson(projectRoot, {
    version,
    integrationKey: defaultKey,
    installedIntegrations: installed,
    settings,
  });

  return (
    loadManifest(projectRoot, impl.key) ?? {
      integration: impl.key,
      version,
      installed_at: '',
      files: Object.keys(manifest.files),
    }
  );
}

/**
 * Remove an integration's tracked files (modified files are preserved unless
 * `force`) and drop it from `.specify/integration.json`.
 */
export async function removeIntegration(
  projectRoot: string,
  integration: string,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const impl = getIntegration(integration);
  const state = readState(projectRoot);
  const installed = installedIntegrationKeys(state);
  const hasManifest = existsSync(manifestPath(projectRoot, integration));

  if (!impl && !hasManifest) throw new Error(`Unknown integration: "${integration}"`);
  if (!hasManifest && !installed.includes(integration)) {
    throw new Error(`Integration "${integration}" is not installed.`);
  }

  if (hasManifest) {
    const manifest = HashManifest.load(integration, projectRoot);
    if (impl) impl.teardown(projectRoot, manifest, { force: opts.force ?? false });
    else manifest.uninstall(projectRoot, { force: opts.force ?? false });
  }

  if (installed.length > 0) {
    const remaining = installed.filter((k) => k !== integration);
    const currentDefault = defaultIntegrationKey(state);
    const newDefault = currentDefault !== integration ? currentDefault : (remaining[0] ?? null);
    if (remaining.length > 0) {
      writeIntegrationJson(projectRoot, {
        version: String(state['version'] ?? getSpeckitVersion()),
        integrationKey: newDefault,
        installedIntegrations: remaining,
        settings: integrationSettings(state),
      });
    } else {
      const { rmSync } = await import('node:fs');
      rmSync(join(projectRoot, '.specify', 'integration.json'), { force: true });
    }
  }
  return true;
}
