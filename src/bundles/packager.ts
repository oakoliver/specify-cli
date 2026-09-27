/**
 * @oakoliver/specify-cli - Bundle packager
 *
 * Produce a single versioned distributable artifact from a bundle dir.
 * ``specify bundle build`` zips the manifest, README, and any local assets
 * into ``<id>-<version>.zip``. Build refuses on an invalid manifest, pointing
 * the author to ``validate``. All file reads are confined within the bundle
 * source directory.
 *
 * Port of ``specify_cli/bundles/packager.py`` (the zip writer is implemented
 * with ``node:zlib`` so there are no dependencies).
 *
 * @module bundles/packager
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { BundlerError } from './index.js';
import { ensureWithin } from './yamlio.js';
import { BundleManifest } from './manifest.js';
import { validateManifestSync } from './validator.js';
import { resolvePath } from './pycompat.js';

/** Files/dirs never included in an artifact. */
export const EXCLUDE_NAMES: ReadonlySet<string> = new Set(['.git', '__pycache__', '.DS_Store']);

export interface BuildResult {
  artifact_path: string;
  file_count: number;
}

// ============================================================================
// Build
// ============================================================================

export function buildBundle(bundleDir: string, outputDir: string | null = null): BuildResult {
  bundleDir = resolvePath(bundleDir);
  const manifestPath = path.join(bundleDir, 'bundle.yml');
  if (!existsSync(manifestPath)) {
    throw new BundlerError(`No bundle.yml found in '${bundleDir}'.`);
  }

  // The artifact contract requires a human-facing README.md.
  if (!existsSync(path.join(bundleDir, 'README.md'))) {
    throw new BundlerError(
      `No README.md found in '${bundleDir}'. Every bundle must ship a README.md describing it.`,
    );
  }

  const manifest = BundleManifest.fromFile(manifestPath);
  const report = validateManifestSync(manifest);
  if (!report.ok) {
    throw new BundlerError(
      "Refusing to build an invalid manifest. Run 'specify bundle validate' and fix:\n  - " +
        report.errors.join('\n  - '),
    );
  }

  const outDir = outputDir ? resolvePath(outputDir) : bundleDir;
  mkdirSync(outDir, { recursive: true });
  const artifactName = `${manifest.bundle.id}-${manifest.bundle.version}.zip`;
  const artifactPath = path.join(outDir, artifactName);
  // Defense in depth: a crafted id cannot push the artifact outside outDir.
  ensureWithin(outDir, artifactPath);

  // If the output dir lives inside the bundle, skip its whole subtree.
  const skipDir = outDir !== bundleDir && isWithin(bundleDir, outDir) ? outDir : null;
  // Also skip any prior build artifact for this bundle (semver-looking only).
  const artifactRe = new RegExp(
    `^${escapeRegExp(manifest.bundle.id)}-` +
      '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?\\.zip$',
  );
  const files = collectFiles(bundleDir, artifactPath, skipDir, artifactRe);

  const members: ZipMember[] = [];
  for (const filePath of files) {
    // Confinement: every packaged file must live under bundleDir.
    ensureWithin(bundleDir, filePath);
    const arcname = toPosix(path.relative(bundleDir, filePath));
    // Normalized permissions: 0755 when any execute bit is set, else 0644.
    const fd = openSync(filePath, 'r');
    let data: Buffer;
    let mode: number;
    try {
      const st = fstatSync(fd);
      mode = st.mode & 0o111 ? 0o755 : 0o644;
      data = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    members.push({ name: arcname, data, mode });
  }
  writeFileSync(artifactPath, buildZip(members));

  return { artifact_path: artifactPath, file_count: files.length };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

function collectFiles(bundleDir: string, skip: string, skipDir: string | null, artifactRe: RegExp | null): string[] {
  const collected: string[] = [];
  const walk = (root: string): void => {
    if (skipDir !== null && isWithin(skipDir, root)) return;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      // Symlinked files and directories are never followed or packaged.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDE_NAMES.has(entry.name)) dirs.push(full);
        continue;
      }
      if (full === skip) continue;
      if (EXCLUDE_NAMES.has(entry.name)) continue;
      if (artifactRe !== null && artifactRe.test(entry.name)) continue;
      collected.push(full);
    }
    for (const d of dirs) walk(d);
  };
  walk(bundleDir);
  // Order by the canonical POSIX arcname for byte-reproducible artifacts.
  const key = (p: string) => toPosix(path.relative(bundleDir, p));
  return collected.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// ============================================================================
// Minimal reproducible ZIP writer (deflate, fixed 1980-01-01 timestamps)
// ============================================================================

export interface ZipMember {
  name: string;
  data: Buffer;
  mode: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// DOS date/time for 1980-01-01 00:00:00.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** @internal Reproducible ZIP writer (exported for tests). */
export function buildZip(members: ZipMember[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const nameBytes = Buffer.from(member.name, 'utf-8');
    const flags = /^[\x00-\x7f]*$/.test(member.name) ? 0 : 0x800;
    const compressed = deflateRawSync(member.data);
    const crc = crc32(member.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(member.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, compressed);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4); // made by: UNIX, v2.0
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(member.data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attrs
    header.writeUInt32LE((member.mode << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}
