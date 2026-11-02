/**
 * @oakoliver/specify-cli - Shared `version` operation
 *
 * Port of spec-kit v1.2.5 `_operation_version.py` (#4863): transport-neutral
 * version information collection shared by `specify version` (CLI) and the
 * `specify_version` MCP tool.
 *
 * ADAPTATION: upstream reports the Python interpreter (`runtime.python`); this
 * port runs on Node or Bun, so the runtime is reported as `runtime.name` +
 * `runtime.version`. The port also reports the upstream spec-kit release it
 * is at parity with (`upstream_spec_kit_version`), as the human `specify
 * version` panel already does with its "Upstream Parity" row.
 *
 * @module operation-version
 */

import { getSpeckitVersion } from './assets.js';
import { UPSTREAM_SPEC_KIT_VERSION, getRuntimeInfo } from './version.js';

/** Runtime versions reported by the version operation. */
export interface VersionRuntime {
  /** "Node" or "Bun" (upstream: the `python` field). */
  name: string;
  version: string;
  /** TLS library as loaded by the runtime, or null when unavailable. */
  openssl: string | null;
}

/** Host system information reported by the version operation. */
export interface VersionSystem {
  platform: string;
  architecture: string;
  os_version: string;
}

/** Transport-neutral result of the version operation. */
export interface VersionResult {
  cliVersion: string;
  upstreamSpecKitVersion: string;
  runtime: VersionRuntime | null;
  system: VersionSystem | null;
  features: Record<string, boolean>;
}

/** Stable metadata shared by delivery adapters for `version`. */
export const VERSION_OPERATION = Object.freeze({
  operationId: 'version' as const,
  contractVersion: '1' as const,
  capabilities: new Set(['local-read'] as const),
  networkAccess: 'none' as const,
});

/** Stable local CLI capability flags for humans and agents. */
export function featureCapabilities(): Record<string, boolean> {
  return {
    controlled_multi_install_integrations: true,
    integration_use_command: true,
    multi_install_safe_registry_metadata: true,
    integration_upgrade_command: true,
    self_check_command: true,
    workflow_catalog: true,
    bundled_templates: true,
  };
}

/** Injection surface (Python tests patch `platform.*` / `_openssl_version`). */
export const versionOperationDeps = {
  getCliVersion: (): string => getSpeckitVersion(),
  getRuntimeInfo,
  getFeatureCapabilities: featureCapabilities,
};

/** Collect semantic version information for any delivery adapter. */
export async function collectVersionResult(
  opts: {
    includeEnvironment?: boolean;
    cliVersionGetter?: () => string;
    runtimeInfoGetter?: typeof getRuntimeInfo;
    featureCapabilitiesGetter?: () => Record<string, boolean>;
  } = {},
): Promise<VersionResult> {
  const cliVersion = (opts.cliVersionGetter ?? versionOperationDeps.getCliVersion)();
  const features = (opts.featureCapabilitiesGetter ?? versionOperationDeps.getFeatureCapabilities)();
  if (opts.includeEnvironment === false) {
    return { cliVersion, upstreamSpecKitVersion: UPSTREAM_SPEC_KIT_VERSION, runtime: null, system: null, features };
  }
  const info = await (opts.runtimeInfoGetter ?? versionOperationDeps.getRuntimeInfo)();
  return {
    cliVersion,
    upstreamSpecKitVersion: UPSTREAM_SPEC_KIT_VERSION,
    runtime: { name: info.runtimeName, version: info.runtimeVersion, openssl: info.openssl || null },
    system: { platform: info.platform, architecture: info.architecture, os_version: info.osVersion },
    features,
  };
}

/** Map a complete operation result to the CLI/MCP JSON contract. Throws when incomplete. */
export function versionResultPayload(result: VersionResult): Record<string, unknown> {
  if (result.runtime === null || result.system === null) throw new Error('Complete version information is required.');
  return {
    cli_version: result.cliVersion,
    upstream_spec_kit_version: result.upstreamSpecKitVersion,
    runtime: { name: result.runtime.name, version: result.runtime.version, openssl: result.runtime.openssl },
    system: {
      platform: result.system.platform,
      architecture: result.system.architecture,
      os_version: result.system.os_version,
    },
    features: result.features,
  };
}
