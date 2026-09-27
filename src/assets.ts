/**
 * @oakoliver/specify-cli - Bundled assets
 *
 * Port of upstream `_assets.py`: bundle path resolution and version lookup.
 * The bundled `core_pack/` lives at the package root (sibling of `src/` and
 * `dist/`), so it resolves identically from sources and from the build.
 *
 * @module assets
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = '@oakoliver/specify-cli';

let cachedPackageRoot: string | null = null;

/**
 * Return the package root: the nearest ancestor of this module containing a
 * `package.json` named `@oakoliver/specify-cli` (falls back to `..`).
 */
export function packageRoot(): string {
  if (cachedPackageRoot) return cachedPackageRoot;
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (;;) {
    const pj = path.join(dir, 'package.json');
    try {
      const data = JSON.parse(fs.readFileSync(pj, 'utf8')) as { name?: string };
      if (data.name === PACKAGE_NAME) {
        cachedPackageRoot = dir;
        return dir;
      }
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedPackageRoot = path.resolve(here, '..');
  return cachedPackageRoot;
}

/** Return the bundled `core_pack` directory, or null if missing. */
export function locateCorePack(): string | null {
  const candidate = path.join(packageRoot(), 'core_pack');
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    // missing
  }
  return null;
}

/**
 * Source-checkout root used by upstream editable installs. In this port the
 * package root plays that role (upstream's repo-root fallbacks map to core_pack).
 */
export function repoRoot(): string {
  return packageRoot();
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function locateBundled(kind: string, id: string, manifest: string, pattern: RegExp): string | null {
  if (!pattern.test(id)) return null;
  const core = locateCorePack();
  if (core !== null) {
    const candidate = path.join(core, kind, id);
    if (isFile(path.join(candidate, manifest))) return candidate;
  }
  const candidate = path.join(repoRoot(), kind, id);
  if (isFile(path.join(candidate, manifest))) return candidate;
  return null;
}

/** Return the path to a bundled extension (`core_pack/extensions/<id>`), or null. */
export function locateBundledExtension(extensionId: string): string | null {
  return locateBundled('extensions', extensionId, 'extension.yml', /^[a-z0-9-]+$/);
}

/** Return the path to a bundled workflow directory, or null. */
export function locateBundledWorkflow(workflowId: string): string | null {
  return locateBundled('workflows', workflowId, 'workflow.yml', /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
}

/** Return the path to a bundled preset, or null. */
export function locateBundledPreset(presetId: string): string | null {
  return locateBundled('presets', presetId, 'preset.yml', /^[a-z0-9-]+$/);
}

/** Get the current CLI version (this package's `package.json` version), or `"unknown"`. */
export function getSpeckitVersion(): string {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version?: unknown };
    return typeof data.version === 'string' ? data.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
