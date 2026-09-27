/**
 * @oakoliver/specify-cli - Artifact preparation helpers for ``specify extension update``
 *
 * Port of ``specify_cli/extensions/_command_update_artifacts.py``.
 *
 * @module extensions/command-update-artifacts
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { safeExtractArchive } from '../download-security.js';
import { parseYaml } from '../yaml.js';
import { Version } from '../bundles/versioning.js';
import { decodeUtf8Strict, isDir, isFile } from './compat.js';
import { ExtensionManager } from './manager.js';
import { ExtensionManifest, isMapping } from './manifest.js';
import { withTempDir } from './fs-utils.js';

/** Validated manifest-derived outputs needed by the update transaction. */
export interface PreflightResult {
  command_names: string[];
  skill_names: string[];
}

/** Python ``ValueError`` analogue raised by the preflight. */
export class UpdateValueError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ValueError';
  }
}

// ============================================================================
// Minimal ZIP writer (zipfile.ZIP_DEFLATED)
// ============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): [number, number] {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return [time & 0xffff, day & 0xffff];
}

interface ZipInput {
  name: string;
  data: Buffer;
  mtime: Date;
  mode: number;
}

function buildZip(files: ZipInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const compressed = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const [time, date] = dosDateTime(f.mtime);
    const flags = /[^\x00-\x7f]/.test(f.name) ? 0x0800 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(((0o100000 | (f.mode & 0o7777)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function sortedRglob(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      out.push(full);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort();
}

/** Package an extension directory as a ZIP archive for the update flow. */
export function archiveExtensionDirectory(sourceDir: string): string {
  const target = join(tmpdir(), `speckit-bundled-update-${randomBytes(8).toString('hex')}.zip`);
  try {
    const files: ZipInput[] = [];
    for (const path of sortedRglob(sourceDir)) {
      const lst = lstatSync(path);
      if (lst.isSymbolicLink()) continue;
      if (!lst.isFile()) continue;
      files.push({
        name: relative(sourceDir, path).split(sep).join('/'),
        data: readFileSync(path),
        mtime: lst.mtime,
        mode: lst.mode,
      });
    }
    writeFileSync(target, buildZip(files), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    rmSync(target, { force: true });
    throw err;
  }
  return target;
}

// ============================================================================
// Preflight
// ============================================================================

/** Validate an update archive before the installed extension is modified. */
export function preflightUpdateArchive(
  manager: ExtensionManager,
  archivePath: string,
  extensionId: string,
  availableVersion: string,
  speckitVersion: string,
): PreflightResult {
  const manifestBytes: Buffer = withTempDir('speckit-update-archive-', (extractedRoot) => {
    try {
      safeExtractArchive(archivePath, extractedRoot);
    } catch (exc) {
      const msg = (exc as Error).message ?? '';
      if (msg.includes('Conflicting path') && msg.toLowerCase().includes('extension.yml')) {
        throw new UpdateValueError('Downloaded extension archive contains multiple extension.yml manifests', {
          cause: exc,
        });
      }
      throw exc;
    }

    const topLevel = readdirSync(extractedRoot).map((n) => join(extractedRoot, n));
    const nameOf = (p: string): string => p.slice(p.lastIndexOf(sep) + 1);
    const rootManifestEntries = topLevel.filter((e) => nameOf(e).toLowerCase() === 'extension.yml');
    if (rootManifestEntries.some((e) => nameOf(e) !== 'extension.yml')) {
      throw new UpdateValueError("Archive must use canonical 'extension.yml' casing");
    }
    const canonicalRoot = rootManifestEntries.find((e) => nameOf(e) === 'extension.yml');
    let manifestPath: string;
    if (canonicalRoot !== undefined) {
      manifestPath = canonicalRoot;
    } else {
      const topLevelDirs = topLevel.filter((e) => isDir(e));
      if (topLevelDirs.length !== 1) {
        throw new UpdateValueError('Downloaded extension archive must contain exactly one top-level directory');
      }
      const manifestRoot = topLevelDirs[0];
      const nested = readdirSync(manifestRoot)
        .map((n) => join(manifestRoot, n))
        .filter((e) => nameOf(e).toLowerCase() === 'extension.yml');
      if (nested.some((e) => nameOf(e) !== 'extension.yml')) {
        throw new UpdateValueError("Archive must use canonical 'extension.yml' casing");
      }
      manifestPath = nested.find((e) => nameOf(e) === 'extension.yml') ?? join(manifestRoot, 'extension.yml');
    }

    if (!isFile(manifestPath)) {
      throw new UpdateValueError("Downloaded extension archive is missing 'extension.yml'");
    }
    const bytes = readFileSync(manifestPath);
    const parsed = parseYaml(decodeUtf8Strict(bytes));
    const manifestData = parsed !== null && parsed !== undefined ? parsed : {};
    if (!isMapping(manifestData)) {
      throw new UpdateValueError('Invalid extension manifest in downloaded archive: expected YAML mapping');
    }
    const extensionData = Object.prototype.hasOwnProperty.call(manifestData, 'extension')
      ? manifestData.extension
      : {};
    if (!isMapping(extensionData)) {
      throw new UpdateValueError("Invalid extension manifest in downloaded archive: expected 'extension' mapping");
    }
    return bytes;
  });

  const preflightManifest = withTempDir('speckit-update-manifest-', (manifestTmpdir) => {
    const manifestFile = join(manifestTmpdir, 'extension.yml');
    writeFileSync(manifestFile, manifestBytes);
    const m = new ExtensionManifest(manifestFile);
    manager.checkCompatibility(m, speckitVersion);
    return m;
  });

  if (preflightManifest.id !== extensionId) {
    throw new UpdateValueError(
      `Extension ID mismatch: expected '${extensionId}', got '${preflightManifest.id}'`,
    );
  }

  const expectedVersion = new Version(availableVersion);
  const archiveVersion = new Version(preflightManifest.version);
  if (archiveVersion.compare(expectedVersion) !== 0) {
    throw new UpdateValueError(
      `Extension version mismatch: expected '${availableVersion}', got '${preflightManifest.version}'`,
    );
  }

  manager.validateInstallConflicts(preflightManifest);
  const commandNames = [...ExtensionManager.collectManifestCommandNames(preflightManifest).keys()];
  const skillNames = [...new Set(commandNames.map((n) => ExtensionManager.skillNameForCommand(n)))];
  return { command_names: commandNames, skill_names: skillNames };
}

