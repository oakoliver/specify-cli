/**
 * @oakoliver/specify-cli - Discovery helpers for ``specify extension update``
 *
 * Port of ``specify_cli/extensions/_command_update_discovery.py``.
 *
 * @module extensions/command-update-discovery
 */

import { join } from 'node:path';

import { console, escapeMarkup } from '../console.js';
import { locateBundledExtension } from '../assets.js';
import { Version } from '../bundles/versioning.js';
import { pyStr } from '../bundles/pycompat.js';
import { resolveInstalledExtension } from './command-shared.js';
import type { ExtensionCatalog } from './extension-catalog.js';
import type { ExtensionManager } from './manager.js';
import { ExtensionManifest, isMapping } from './manifest.js';

/** A validated catalog update ready for user confirmation. */
export interface UpdateCandidate {
  extension_id: string;
  name: string;
  installed: string;
  available: string;
  download_url: string | null;
  bundled_dir: string | null;
  catalog_name: string | null;
}

function tryVersion(value: unknown): Version | null {
  if (typeof value !== 'string') return null;
  try {
    return new Version(value);
  } catch {
    return null;
  }
}

/** Locate the local bundled copy of an extension and its parsed version. */
export function bundledUpdateSource(extId: string): [string | null, Version | null] {
  const bundledDir = locateBundledExtension(extId);
  if (bundledDir === null || bundledDir === undefined) return [null, null];
  try {
    const manifest = new ExtensionManifest(join(bundledDir, 'extension.yml'));
    return [bundledDir, new Version(manifest.version)];
  } catch {
    return [null, null];
  }
}

/** Find installable updates and report skipped or blocked entries. */
export async function discoverUpdates(
  manager: ExtensionManager,
  catalog: ExtensionCatalog,
  extension: string | null,
  bundledSource: (extId: string) => [string | null, Version | null] = bundledUpdateSource,
): Promise<[UpdateCandidate[], string[], boolean]> {
  const installed = manager.listInstalled();
  let extensionIds: string[];
  if (extension) {
    const [extensionId] = resolveInstalledExtension(extension, installed, 'update');
    extensionIds = [extensionId as string];
  } else {
    extensionIds = installed.map((ext) => ext.id);
  }
  if (!extensionIds.length) return [[], [], false];

  console.print('🔄 Checking for updates...\n');

  const updatesAvailable: UpdateCandidate[] = [];
  const blockedUpdates: string[] = [];

  for (const extId of extensionIds) {
    const safeExtId = escapeMarkup(String(extId));
    const metadata = manager.registry.get(extId);
    if (metadata === null || !isMapping(metadata) || !('version' in metadata)) {
      console.print(`⚠  ${safeExtId}: Registry entry corrupted or missing (skipping)`);
      continue;
    }
    const installedVersion = tryVersion(metadata.version);
    if (installedVersion === null) {
      console.print(
        `⚠  ${safeExtId}: Invalid installed version ` +
          `'${escapeMarkup(pyStr(metadata.version))}' in registry ` +
          '(skipping)',
      );
      continue;
    }

    const extInfo = await catalog.getExtensionInfo(extId);
    if (!extInfo) {
      console.print(`⚠  ${safeExtId}: Not found in catalog (skipping)`);
      continue;
    }

    const installAllowed = Object.prototype.hasOwnProperty.call(extInfo, '_install_allowed')
      ? extInfo._install_allowed
      : true;
    if (!installAllowed) {
      console.print(
        `⚠  ${safeExtId}: Updates not allowed from ` +
          `'${escapeMarkup(pyStr(extInfo._catalog_name ?? 'catalog'))}' ` +
          '(skipping)',
      );
      continue;
    }

    const catalogVersion = tryVersion(extInfo.version);
    if (catalogVersion === null) {
      console.print(
        `⚠  ${safeExtId}: Invalid catalog version ` + `'${escapeMarkup(pyStr(extInfo.version ?? null))}' (skipping)`,
      );
      continue;
    }

    if (catalogVersion.compare(installedVersion) <= 0) {
      console.print(`✓ ${safeExtId}: Up to date (v${installedVersion.toString()})`);
      continue;
    }

    const downloadUrl = (extInfo.download_url ?? null) as string | null;
    let bundledDir: string | null = null;
    let availableVersion = catalogVersion;
    if (extInfo.bundled && !downloadUrl) {
      const [dir, bundledVersion] = bundledSource(extId);
      bundledDir = dir;
      if (bundledDir === null || bundledVersion === null || bundledVersion.compare(catalogVersion) < 0) {
        const localDesc =
          bundledDir !== null ? `only ships v${bundledVersion?.toString()}` : 'does not ship a local copy';
        console.print(
          `⚠  ${safeExtId}: v${catalogVersion.toString()} is available, but this ` +
            `spec-kit release ${localDesc} — upgrade spec-kit, then rerun ` +
            "'specify extension update'",
        );
        blockedUpdates.push(extId);
        continue;
      }
      availableVersion = bundledVersion;
    }

    updatesAvailable.push({
      extension_id: extId,
      name: (extInfo.name ?? extId) as string,
      installed: installedVersion.toString(),
      available: availableVersion.toString(),
      download_url: downloadUrl,
      bundled_dir: bundledDir,
      catalog_name: (extInfo._catalog_name ?? null) as string | null,
    });
  }

  return [updatesAvailable, blockedUpdates, true];
}
