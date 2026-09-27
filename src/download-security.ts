/**
 * @oakoliver/specify-cli - Download security
 *
 * Port of upstream `_download_security.py`: helpers for bounded downloads and
 * safe archive extraction.
 *
 * - URL policy: `isHttpsOrLocalhostHttp`, `isLoopbackUrl`, `isSafeDownloadRedirect`
 *   (a faithful port of the `urllib.parse`/`ipaddress`/`inet_aton` checks).
 * - Bounded reads: `readResponseLimited` (fetch `Response`, web streams, or
 *   Python-style `read(n)` objects).
 * - ZIP: pure-TS central-directory preflight + reader (`openZipBounded`,
 *   `BoundedZipFile`, `readZipMemberLimited`, `safeExtractZip`) using
 *   `node:zlib` `inflateRawSync` with an output bound. STORED/DEFLATED only,
 *   ZIP64/multi-disk rejected, CRC-32 verified.
 * - tar.gz: `safeExtractTar` (ustar + pax + GNU long names), rejecting links and
 *   special files.
 * - `safeExtractArchive`, `detectArchiveFormat`, `buildSafeDownloadPath`,
 *   `normalizeArchiveMemberName`, `portableArchivePathKey`.
 *
 * Errors are raised through a caller-supplied `errorType` constructor
 * (default {@link ValueError}) exactly where upstream raises `error_type`.
 *
 * @module download-security
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { domainToASCII } from 'node:url';

// ============================================================================
// Constants
// ============================================================================

export type ArchiveFormat = 'zip' | 'tar.gz';

export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 512;
export const MAX_ZIP_MEMBER_BYTES = 10 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_ZIP_PATH_BYTES = 4096;
export const MAX_ZIP_COMPONENT_BYTES = 255;
export const MAX_ZIP_CENTRAL_DIRECTORY_BYTES = 4 * 1024 * 1024;
export const READ_CHUNK_SIZE = 64 * 1024;
export const MAX_JSON_METADATA_BYTES = 1 * 1024 * 1024;
export const MAX_JSON_CATALOG_BYTES = 8 * 1024 * 1024;

const WINDOWS_INVALID_FILENAME_CHARS = new Set('<>:"|?*');
const WINDOWS_RESERVED_FILENAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;

const ZIP_EOCD_SIZE = 22;
const ZIP_CENTRAL_HEADER_SIZE = 46;
const ZIP_LOCAL_HEADER_SIZE = 30;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const ZIP64_MIN_EXTRACT_VERSION = 45;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffffffff;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_STORED = 0;
const ZIP_DEFLATED = 8;

const ARCHIVE_CONTENT_TYPES: Record<string, ArchiveFormat> = {
  'application/gzip': 'tar.gz',
  'application/x-gzip': 'tar.gz',
  'application/x-tar+gzip': 'tar.gz',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
};

// ============================================================================
// Errors / small helpers
// ============================================================================

/** Default error type (Python `ValueError`). */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/** Constructor of an error type accepted by the `errorType` options. */
export type ErrorType = new (message: string) => Error;

function raise(errorType: ErrorType, message: string): never {
  throw new errorType(message);
}

function raiseFrom(errorType: ErrorType, message: string, cause: unknown): never {
  const e = new errorType(message);
  try {
    (e as Error & { cause?: unknown }).cause = cause;
  } catch {
    // ignore
  }
  throw e;
}

/** Python `repr()` for strings (single quotes preferred, control chars escaped). */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (value === Infinity) return 'inf';
    if (value === -Infinity) return '-inf';
    return String(value);
  }
  if (typeof value !== 'string') {
    if (value instanceof Uint8Array) return `b'${Buffer.from(value).toString('latin1')}'`;
    if (Array.isArray(value)) return `[${value.map(pyRepr).join(', ')}]`;
    if (typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`).join(', ')}}`;
    }
    return String(value);
  }
  const useDouble = value.includes("'") && !value.includes('"');
  const quote = useDouble ? '"' : "'";
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + quote;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (cp < 0x20 || (cp >= 0x7f && cp <= 0xa0) || cp === 0xad) out += '\\x' + cp.toString(16).padStart(2, '0');
    else if (cp >= 0xd800 && cp <= 0xdfff) out += '\\u' + cp.toString(16).padStart(4, '0');
    else if (isNonPrintableUnicode(cp)) {
      out += cp <= 0xffff ? '\\u' + cp.toString(16).padStart(4, '0') : '\\U' + cp.toString(16).padStart(8, '0');
    } else out += ch;
  }
  return quote + out + quote;
}

function isNonPrintableUnicode(cp: number): boolean {
  // Approximation of Python's str.isprintable() for common non-printables
  // (format/separator/control categories).
  return (
    (cp >= 0x2000 && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202f) ||
    (cp >= 0x205f && cp <= 0x206f) ||
    cp === 0x3000 ||
    cp === 0xfeff ||
    (cp >= 0xfff9 && cp <= 0xfffb) ||
    cp === 0x1680 ||
    cp === 0x180e
  );
}

/** Unicode category `Cc` (C0/C1 control characters). */
function isControlChar(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f);
}

function hasLoneSurrogate(s: string): boolean {
  return /[\ud800-\udbff](?![\udc00-\udfff])|(?:[^\ud800-\udbff]|^)[\udc00-\udfff]/.test(s);
}

function utf8Len(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function validateNonNegativeInt(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer`);
  }
  if (value < 0) throw new ValueError(`${name} must be non-negative`);
}

/**
 * Resolve a path like Python `Path.resolve(strict=False)`: symlinks in the
 * existing prefix are resolved, the non-existent remainder is appended.
 */
export function resolvePathLoose(p: string): string {
  const abs = path.resolve(p);
  let existing = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(existing);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return abs;
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

function isRelativeTo(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

// ============================================================================
// Archive format detection
// ============================================================================

/** Return the supported archive format declared by a path or URL. */
export function archiveFormatFromName(name: string): ArchiveFormat | null {
  let p: string;
  try {
    p = urlsplit(name).path.toLowerCase();
  } catch {
    return null;
  }
  if (p.endsWith('.tar.gz') || p.endsWith('.tgz')) return 'tar.gz';
  if (p.endsWith('.zip')) return 'zip';
  return null;
}

/** Return the supported archive format declared by an HTTP Content-Type. */
export function archiveFormatFromContentType(contentType: string | null | undefined): ArchiveFormat | null {
  if (typeof contentType !== 'string') return null;
  const media = contentType.split(';')[0].trim().toLowerCase();
  return ARCHIVE_CONTENT_TYPES[media] ?? null;
}

/** Return the canonical filename suffix for an archive format. */
export function archiveSuffix(format: ArchiveFormat): string {
  if (format === 'zip') return '.zip';
  if (format === 'tar.gz') return '.tar.gz';
  throw new ValueError(`Unsupported archive format: ${pyRepr(format)}`);
}

export interface ArchiveSourceOptions {
  /** In-memory archive bytes (replaces reading `archivePath`). */
  archiveFile?: Uint8Array | null;
  errorType?: ErrorType;
}

function loadArchiveBytes(archivePath: string, archiveFile: Uint8Array | null | undefined, onError: (e: unknown) => never): Buffer {
  if (archiveFile) return Buffer.from(archiveFile.buffer, archiveFile.byteOffset, archiveFile.byteLength);
  try {
    return fs.readFileSync(archivePath);
  } catch (e) {
    return onError(e);
  }
}

/** Python `zipfile.is_zipfile` equivalent: an EOCD record can be located. */
function isZipData(data: Buffer): boolean {
  if (data.length < ZIP_EOCD_SIZE) return false;
  // Fast path: no comment.
  if (data.readUInt32LE(data.length - ZIP_EOCD_SIZE) === 0x06054b50 && data.readUInt16LE(data.length - 2) === 0) {
    return true;
  }
  const start = Math.max(0, data.length - ZIP_EOCD_SIZE - ZIP_MAX_COMMENT_BYTES);
  const idx = data.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (idx < start || idx < 0) return false;
  if (idx + ZIP_EOCD_SIZE > data.length) return false;
  return true;
}

export interface DetectArchiveOptions extends ArchiveSourceOptions {
  sourceName?: string | null;
  contentType?: string | null;
}

/**
 * Validate the declared archive format against the file contents.
 * A recognized path/URL suffix is authoritative; Content-Type is a fallback.
 */
export function detectArchiveFormat(archivePath: string, opts: DetectArchiveOptions = {}): ArchiveFormat {
  const errorType = opts.errorType ?? ValueError;
  const nameFormat = archiveFormatFromName(opts.sourceName ?? archivePath);
  const contentFormat = archiveFormatFromContentType(opts.contentType);
  if (nameFormat !== null && contentFormat !== null && nameFormat !== contentFormat) {
    raise(errorType, `Archive format mismatch: filename declares ${nameFormat} but Content-Type declares ${contentFormat}`);
  }
  let declared = nameFormat ?? contentFormat;
  const data = loadArchiveBytes(archivePath, opts.archiveFile, (e) => raiseFrom(errorType, `Invalid archive: ${archivePath}`, e));
  let isZip = isZipData(data);
  const sig = data.subarray(0, 4).toString('latin1');
  isZip = isZip || sig === 'PK\x03\x04' || sig === 'PK\x05\x06' || sig === 'PK\x07\x08';
  const isGzip = data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
  let isTarGz = false;
  if (isGzip) {
    try {
      const firstBlock = gunzipPrefix(data, 512);
      isTarGz = firstBlock.length === 512 && tarChecksumOk(firstBlock);
    } catch {
      isTarGz = false;
    }
  }
  let actual: ArchiveFormat | null;
  if (isZip && !isTarGz) actual = 'zip';
  else if (isTarGz && !isZip) actual = 'tar.gz';
  else actual = null;
  if (declared === null) {
    if (actual === null) raise(errorType, 'Unsupported archive format; expected .zip, .tar.gz, or .tgz');
    declared = actual;
  }
  if (actual !== declared) {
    raise(errorType, `Archive format mismatch: expected ${declared}, got ${actual ?? 'invalid/unsupported data'}`);
  }
  return declared;
}

/**
 * Decompress the first `n` bytes of a gzip stream, tolerating truncation or
 * corruption *after* that prefix (like tarfile reading only the first header).
 */
function gunzipPrefix(data: Buffer, n: number): Buffer {
  let k = Math.min(data.length, 1024);
  for (;;) {
    const out = zlib.gunzipSync(data.subarray(0, k), {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
      maxOutputLength: 256 * 1024 * 1024,
    });
    if (out.length >= n || k >= data.length) return out.subarray(0, Math.min(n, out.length));
    k = Math.min(data.length, k * 2);
  }
}

/**
 * Strictly gunzip `data`; throws RangeError when output would exceed `limit`
 * and a zlib error for corrupt or truncated input.
 */
function gunzipBounded(data: Buffer, limit: number): Buffer {
  try {
    return zlib.gunzipSync(data, { maxOutputLength: Math.max(1, Math.min(limit + 1, 2 ** 31 - 1)) });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (e instanceof RangeError || code === 'ERR_BUFFER_TOO_LARGE') throw new RangeError('gzip output exceeds limit');
    throw e;
  }
}

// ============================================================================
// URL parsing (urllib.parse.urlsplit port)
// ============================================================================

export interface SplitResult {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
  /** Lower-cased host (brackets stripped), or null. */
  hostname: string | null;
  /** Parsed port (validated), or null. Throws ValueError when accessed-invalid via `urlsplitStrict`. */
  portText: string | null;
}

const SCHEME_CHARS = /^[A-Za-z][A-Za-z0-9+\-.]*$/;

/**
 * Port of `urllib.parse.urlsplit` (Python 3.11+ semantics). Throws
 * {@link ValueError} for invalid bracketed hosts like upstream.
 */
export function urlsplit(url: string): SplitResult {
  // Strip leading C0 control and space, remove tab/CR/LF.
  url = url.replace(/^[\x00-\x20]+/, '').replace(/[\t\r\n]/g, '');
  let scheme = '';
  let netloc = '';
  let query = '';
  let fragment = '';
  const colon = url.indexOf(':');
  if (colon > 0 && SCHEME_CHARS.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.startsWith('//')) {
    let delim = url.length;
    for (const c of '/?#') {
      const wdelim = url.indexOf(c, 2);
      if (wdelim >= 0) delim = Math.min(delim, wdelim);
    }
    netloc = url.slice(2, delim);
    url = url.slice(delim);
    if ((netloc.includes('[') && !netloc.includes(']')) || (netloc.includes(']') && !netloc.includes('['))) {
      throw new ValueError('Invalid IPv6 URL');
    }
    if (netloc.includes('[') && netloc.includes(']')) {
      const bracketed = netloc.split('[')[1].split(']')[0];
      checkBracketedHost(bracketed);
    }
  }
  const hash = url.indexOf('#');
  if (hash >= 0) {
    fragment = url.slice(hash + 1);
    url = url.slice(0, hash);
  }
  const q = url.indexOf('?');
  if (q >= 0) {
    query = url.slice(q + 1);
    url = url.slice(0, q);
  }
  // hostname / port
  let hostname: string | null = null;
  let portText: string | null = null;
  if (netloc) {
    const hostinfo = netloc.slice(netloc.lastIndexOf('@') + 1);
    if (hostinfo.includes('[')) {
      const afterOpen = hostinfo.slice(hostinfo.indexOf('[') + 1);
      const close = afterOpen.indexOf(']');
      hostname = afterOpen.slice(0, close);
      const rest = afterOpen.slice(close + 1);
      const pc = rest.indexOf(':');
      portText = pc >= 0 ? rest.slice(pc + 1) : null;
    } else {
      const pc = hostinfo.indexOf(':');
      hostname = pc >= 0 ? hostinfo.slice(0, pc) : hostinfo;
      portText = pc >= 0 ? hostinfo.slice(pc + 1) : null;
    }
    if (hostname === '') hostname = null;
    else if (hostname !== null) hostname = hostname.toLowerCase();
    if (portText === '') portText = null;
  }
  return { scheme, netloc, path: url, query, fragment, hostname, portText };
}

function checkBracketedHost(hostname: string): void {
  if (hostname.startsWith('v')) {
    if (!/^v[a-fA-F0-9]+\..+$/.test(hostname)) throw new ValueError('IPvFuture address is invalid');
    return;
  }
  const addr = ipAddress(hostname.split('%')[0]);
  if (addr === null || addr.version !== 6) {
    // Python 3.11.4+: ipaddress.ip_address(hostname) must be IPv6 (zone allowed).
    if (parseIPv6(hostname) === null) throw new ValueError(`'${hostname}' does not appear to be an IPv4 or IPv6 address`);
  }
}

/** `SplitResult.port` semantics: validate and return the port, or null. Throws ValueError. */
export function urlPort(parts: SplitResult): number | null {
  const p = parts.portText;
  if (p === null) return null;
  if (!/^[0-9]+$/.test(p)) throw new ValueError(`Port could not be cast to integer value as ${pyRepr(p)}`);
  const n = parseInt(p, 10);
  if (n < 0 || n > 65535) throw new ValueError('Port out of range 0-65535');
  return n;
}

// ============================================================================
// IP address parsing (ipaddress port)
// ============================================================================

interface IPAddr {
  version: 4 | 6;
  bytes: number[];
}

function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p)) return null;
    if (p.length > 1 && p[0] === '0') return null; // leading zeros ambiguous
    const n = parseInt(p, 10);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseIPv6(s: string): number[] | null {
  if (!s) return null;
  let parts = s.split(':');
  if (parts.length < 3) return null;
  let ipv4Tail: number[] | null = null;
  if (parts[parts.length - 1].includes('.')) {
    ipv4Tail = parseIPv4(parts[parts.length - 1]);
    if (!ipv4Tail) return null;
    parts = parts.slice(0, -1);
    parts.push(((ipv4Tail[0] << 8) | ipv4Tail[1]).toString(16), ((ipv4Tail[2] << 8) | ipv4Tail[3]).toString(16));
  }
  const maxParts = 9;
  if (parts.length > maxParts) return null;
  let skipIndex = -1;
  for (let i = 1; i < parts.length - 1; i++) {
    if (!parts[i]) {
      if (skipIndex >= 0) return null;
      skipIndex = i;
    }
  }
  let partsHi: number;
  let partsLo: number;
  let partsSkipped: number;
  if (skipIndex >= 0) {
    partsHi = skipIndex;
    partsLo = parts.length - skipIndex - 1;
    if (!parts[0]) {
      partsHi -= 1;
      if (partsHi) return null;
    }
    if (!parts[parts.length - 1]) {
      partsLo -= 1;
      if (partsLo) return null;
    }
    partsSkipped = 8 - (partsHi + partsLo);
    if (partsSkipped < 1) return null;
  } else {
    if (parts.length !== 8) return null;
    if (!parts[0] || !parts[parts.length - 1]) return null;
    partsHi = parts.length;
    partsLo = 0;
    partsSkipped = 0;
  }
  const hextets: number[] = [];
  const parseHextet = (h: string): number | null => (/^[0-9a-fA-F]{1,4}$/.test(h) ? parseInt(h, 16) : null);
  for (let i = 0; i < partsHi; i++) {
    const v = parseHextet(parts[i]);
    if (v === null) return null;
    hextets.push(v);
  }
  for (let i = 0; i < partsSkipped; i++) hextets.push(0);
  for (let i = partsLo; i > 0; i--) {
    const v = parseHextet(parts[parts.length - i]);
    if (v === null) return null;
    hextets.push(v);
  }
  if (hextets.length !== 8) return null;
  const bytes: number[] = [];
  for (const h of hextets) bytes.push(h >> 8, h & 255);
  return bytes;
}

function ipAddress(s: string): IPAddr | null {
  const v4 = parseIPv4(s);
  if (v4) return { version: 4, bytes: v4 };
  const v6 = parseIPv6(s);
  if (v6) return { version: 6, bytes: v6 };
  return null;
}

/**
 * Port of `ipaddress.ip_address(text).compressed`: returns the canonical
 * compressed spelling, or null when `text` is not a strict IPv4/IPv6 literal.
 */
export function ipAddressCompressed(text: string): string | null {
  const a = ipAddress(text);
  if (!a) return null;
  if (a.version === 4) return a.bytes.join('.');
  const hextets: number[] = [];
  for (let i = 0; i < 16; i += 2) hextets.push((a.bytes[i] << 8) | a.bytes[i + 1]);
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  hextets.forEach((h, idx) => {
    if (h === 0) {
      if (curStart < 0) curStart = idx;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  });
  const hex = hextets.map((h) => h.toString(16));
  if (bestLen > 1) {
    const left = hex.slice(0, bestStart);
    const right = hex.slice(bestStart + bestLen);
    return `${left.join(':')}::${right.join(':')}`;
  }
  return hex.join(':');
}

function ipv4Mapped(a: IPAddr): IPAddr | null {
  if (a.version !== 6) return null;
  const b = a.bytes;
  for (let i = 0; i < 10; i++) if (b[i] !== 0) return null;
  if (b[10] !== 0xff || b[11] !== 0xff) return null;
  return { version: 4, bytes: b.slice(12) };
}

function isLoopbackAddr(a: IPAddr): boolean {
  if (a.version === 4) return a.bytes[0] === 127;
  return a.bytes.slice(0, 15).every((x) => x === 0) && a.bytes[15] === 1;
}

function isUnspecifiedAddr(a: IPAddr): boolean {
  return a.bytes.every((x) => x === 0);
}

/** Port of `socket.inet_aton` (legacy IPv4 spellings). */
function inetAton(host: string): number[] | null {
  if (!host) return null;
  const parts = host.split('.');
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0[xX][0-9a-fA-F]*$/.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]*$/.test(p)) n = parseInt(p, 8);
    else if (/^[1-9][0-9]*$/.test(p)) n = parseInt(p, 10);
    else return null;
    nums.push(n);
  }
  const last = nums[nums.length - 1];
  const maxLast = [0xffffffff, 0xffffff, 0xffff, 0xff][nums.length - 1];
  if (last > maxLast) return null;
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null;
  let value = 0;
  for (let i = 0; i < nums.length - 1; i++) value = value * 256 + nums[i];
  value = value * 2 ** (8 * (4 - (nums.length - 1))) + last;
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function ipAddressWithoutScope(hostname: string): IPAddr | null {
  let addressText: string;
  if (hostname.includes('%')) {
    const sep = hostname.indexOf('%25');
    if (sep < 0) return null;
    addressText = hostname.slice(0, sep);
    const zone = hostname.slice(sep + 3);
    if (!addressText.includes(':') || addressText.includes('%') || zone.includes('%')) return null;
    if (!zone || [...zone].some((c) => !/^[A-Za-z0-9._~-]$/.test(c))) return null;
  } else {
    addressText = hostname;
  }
  const addr = ipAddress(addressText);
  if (!addr) return null;
  if (hostname.includes('%') && addr.version !== 6) return null;
  return addr;
}

function isIpLoopback(a: IPAddr | null): boolean {
  if (!a) return false;
  const mapped = ipv4Mapped(a);
  return isLoopbackAddr(a) || (!!mapped && isLoopbackAddr(mapped));
}

function isIpLocalRedirectTarget(a: IPAddr | null): boolean {
  if (!a) return false;
  const mapped = ipv4Mapped(a);
  return isIpLoopback(a) || isUnspecifiedAddr(a) || (!!mapped && isUnspecifiedAddr(mapped));
}

/** Python `str.encode('idna')` success check. */
function idnaEncode(hostname: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(hostname)) {
    const labels = hostname.split('.');
    if (labels.length && labels[labels.length - 1] === '') labels.pop();
    for (const l of labels) {
      if (l.length === 0 || l.length > 63) return null;
    }
    return hostname;
  }
  const ascii = domainToASCII(hostname);
  return ascii ? ascii : null;
}

function parseUrl(url: string): SplitResult | null {
  let parsed: SplitResult;
  try {
    parsed = urlsplit(url);
    urlPort(parsed);
  } catch {
    return null;
  }
  const hostname = parsed.hostname;
  if (!hostname) return null;
  if (hostname.includes('%')) {
    if (ipAddressWithoutScope(hostname) === null) return null;
  } else if (!hostname.includes(':')) {
    if (idnaEncode(hostname) === null) return null;
  }
  return parsed;
}

function isDefiniteLoopbackHost(hostname: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(hostname)) return false;
  if (hostname === 'localhost') return true;
  return isIpLoopback(ipAddressWithoutScope(hostname));
}

function isPotentialLocalTargetHost(hostname: string): boolean {
  if (hostname.includes(':')) return isIpLocalRedirectTarget(ipAddressWithoutScope(hostname));
  const encoded = idnaEncode(hostname);
  if (encoded === null) return false;
  let host = encoded.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  let address = ipAddressWithoutScope(host);
  if (address === null) {
    const legacy = inetAton(host);
    if (!legacy) return false;
    address = { version: 4, bytes: legacy };
  }
  return isIpLocalRedirectTarget(address);
}

/** Return whether `url` has an unambiguous loopback host. */
export function isLoopbackUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && isDefiniteLoopbackHost(parsed.hostname!);
}

function isPotentialLocalTargetUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return parsed !== null && isPotentialLocalTargetHost(parsed.hostname!);
}

/**
 * Return true if `url` is HTTPS, or HTTP limited to unambiguous loopback hosts.
 * A hostname is always required.
 */
export function isHttpsOrLocalhostHttp(url: string): boolean {
  const parsed = parseUrl(url);
  if (parsed === null) return false;
  return parsed.scheme === 'https' || (parsed.scheme === 'http' && isDefiniteLoopbackHost(parsed.hostname!));
}

/** Return whether a redirect preserves the shared download URL policy. */
export function isSafeDownloadRedirect(oldUrl: string, newUrl: string): boolean {
  if (!isHttpsOrLocalhostHttp(newUrl)) return false;
  return !isPotentialLocalTargetUrl(newUrl) || isLoopbackUrl(oldUrl);
}

// ============================================================================
// Bounded reads
// ============================================================================

/** Python-style readable: `read(n)` returning bytes (empty at EOF). */
export interface ReadableLike {
  read(size: number): Uint8Array | ArrayBuffer | string | null | Promise<Uint8Array | ArrayBuffer | string | null>;
}

type ResponseSource = Response | ReadableStream<Uint8Array> | ReadableLike | { body: ReadableStream<Uint8Array> | null };

class ReadLimitExceeded extends Error {}

function toBytes(chunk: Uint8Array | ArrayBuffer | string | null | undefined): Uint8Array {
  if (chunk === null || chunk === undefined) return new Uint8Array(0);
  if (typeof chunk === 'string') return Buffer.from(chunk, 'latin1');
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return chunk;
}

async function readLimited(source: ResponseSource, maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const limit = maxBytes + 1;
  const stream: ReadableStream<Uint8Array> | null =
    typeof (source as ReadableStream).getReader === 'function'
      ? (source as ReadableStream<Uint8Array>)
      : 'body' in (source as object) && typeof (source as ReadableLike).read !== 'function'
        ? ((source as { body: ReadableStream<Uint8Array> | null }).body ?? null)
        : null;
  if (stream || ('body' in (source as object) && typeof (source as ReadableLike).read !== 'function')) {
    if (!stream) return Buffer.alloc(0);
    const reader = stream.getReader();
    try {
      while (total < limit) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        total += value.length;
        if (total > maxBytes) throw new ReadLimitExceeded();
        chunks.push(value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
    return Buffer.concat(chunks);
  }
  const readable = source as ReadableLike;
  while (total < limit) {
    const chunk = toBytes(await readable.read(Math.min(READ_CHUNK_SIZE, limit - total)));
    if (!chunk.length) break;
    total += chunk.length;
    if (total > maxBytes) throw new ReadLimitExceeded();
    chunks.push(Uint8Array.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface ReadLimitedOptions {
  maxBytes?: number;
  errorType?: ErrorType;
  label?: string;
}

/**
 * Read at most `maxBytes` from a response (fetch `Response`, web stream, or a
 * Python-style `read(n)` object). Throws `errorType` with
 * `'<label>' exceeds maximum size of N bytes` when exceeded.
 */
export async function readResponseLimited(response: ResponseSource, opts: ReadLimitedOptions = {}): Promise<Buffer> {
  const maxBytes = opts.maxBytes === undefined ? MAX_DOWNLOAD_BYTES : opts.maxBytes;
  validateNonNegativeInt(maxBytes, 'max_bytes');
  const errorType = opts.errorType ?? ValueError;
  const label = opts.label ?? 'download';
  try {
    return await readLimited(response, maxBytes);
  } catch (e) {
    if (e instanceof ReadLimitExceeded) raise(errorType, `${pyRepr(label)} exceeds maximum size of ${maxBytes} bytes`);
    throw e;
  }
}

// ============================================================================
// Safe download path
// ============================================================================

export interface SafeDownloadPathOptions {
  errorType?: ErrorType;
  label?: string;
  suffix?: string;
}

/** Build a portable single-component archive path inside `targetDir`. */
export function buildSafeDownloadPath(
  targetDir: string,
  identifier: unknown,
  version: unknown,
  opts: SafeDownloadPathOptions = {},
): string {
  const errorType = opts.errorType ?? ValueError;
  const label = opts.label ?? 'archive';
  const suffix = opts.suffix ?? '.zip';
  const unsafe = (): never =>
    raise(errorType, `Unsafe ${label} download filename derived from ${pyRepr(identifier)} and ${pyRepr(version)}`);
  if (typeof identifier !== 'string' || typeof version !== 'string') unsafe();
  if (!['.zip', '.tar.gz', '.tgz'].includes(suffix)) raise(errorType, `Unsupported archive download suffix: ${pyRepr(suffix)}`);
  const filename = `${identifier as string}-${version as string}${suffix}`;
  const tooLong = hasLoneSurrogate(filename) || utf8Len(filename) > MAX_ZIP_COMPONENT_BYTES;
  if (
    tooLong ||
    filename.includes('/') ||
    filename.includes('\\') ||
    [...filename].some(isControlChar) ||
    [...filename].some((c) => WINDOWS_INVALID_FILENAME_CHARS.has(c)) ||
    filename.endsWith(' ') ||
    filename.endsWith('.')
  ) {
    unsafe();
  }
  return path.join(targetDir, filename);
}

// ============================================================================
// Member names
// ============================================================================

export interface NormalizeMemberOptions {
  archiveLabel?: string;
  errorType?: ErrorType;
}

/** Return a normalized, portable archive member name or raise if unsafe. */
export function normalizeArchiveMemberName(name: string, opts: NormalizeMemberOptions = {}): string {
  const archiveLabel = opts.archiveLabel ?? 'archive';
  const errorType = opts.errorType ?? ValueError;
  if (name.includes('\x00')) raise(errorType, `Unsafe path in ${archiveLabel} archive: ${pyRepr(name)}`);
  const normalized = name.replace(/\\/g, '/');
  if (hasLoneSurrogate(normalized)) raise(errorType, `Unsafe path in ${archiveLabel} archive: ${pyRepr(name)}`);
  if (utf8Len(normalized) > MAX_ZIP_PATH_BYTES) {
    raise(errorType, `Unsafe path in ${archiveLabel} archive: ${pyRepr(name)} (not portable across supported filesystems)`);
  }
  let rawParts = normalized.split('/');
  if (rawParts.length && rawParts[rawParts.length - 1] === '') rawParts = rawParts.slice(0, -1);
  const hasWindowsDrive = /^[A-Za-z]:/.test(normalized);
  if (
    !rawParts.length ||
    normalized.startsWith('/') ||
    hasWindowsDrive ||
    rawParts.some((p) => p === '' || p === '.' || p === '..')
  ) {
    raise(errorType, `Unsafe path in ${archiveLabel} archive: ${pyRepr(name)} (potential path traversal)`);
  }
  for (const part of rawParts) {
    const reservedStem = part.split('.')[0].split(':')[0].replace(/ +$/, '');
    if (
      utf8Len(part) > MAX_ZIP_COMPONENT_BYTES ||
      [...part].some(isControlChar) ||
      [...part].some((c) => WINDOWS_INVALID_FILENAME_CHARS.has(c)) ||
      part.startsWith(' ') ||
      part.endsWith(' ') ||
      part.endsWith('.') ||
      WINDOWS_RESERVED_FILENAME.test(reservedStem)
    ) {
      raise(errorType, `Unsafe path in ${archiveLabel} archive: ${pyRepr(name)} (not portable across supported filesystems)`);
    }
  }
  return normalized;
}

/** Return a normalized, portable ZIP member name or raise if unsafe. */
export function normalizeZipMemberName(name: string, opts: { errorType?: ErrorType } = {}): string {
  return normalizeArchiveMemberName(name, { archiveLabel: 'ZIP', errorType: opts.errorType });
}

/** Approximation of Python `str.casefold()`. */
function casefold(s: string): string {
  return s.toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl');
}

/** Comparison key for filesystems with case/Unicode folding. */
export function portableArchivePathKey(name: string): string[] {
  let n = name.replace(/\\/g, '/');
  if (n.endsWith('/')) n = n.slice(0, -1);
  return n.split('/').map((part) => casefold(part).normalize('NFC'));
}

/** Backward-compatible ZIP-specific alias for portable archive keys. */
export const portableZipPathKey = portableArchivePathKey;

function compareKeys(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return comparePyStr(a[i], b[i]);
  }
  return a.length - b.length;
}

function comparePyStr(a: string, b: string): number {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const d = ai[i].codePointAt(0)! - bi[i].codePointAt(0)!;
    if (d) return d;
  }
  return ai.length - bi.length;
}

function checkPrefixConflicts(
  validated: Map<string, { key: string[]; original: string; isDir: boolean }>,
  label: string,
  errorType: ErrorType,
): void {
  const sorted = [...validated.values()].sort((x, y) => compareKeys(x.key, y.key));
  for (let i = 0; i + 1 < sorted.length; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];
    if (
      !cur.isDir &&
      next.key.length > cur.key.length &&
      cur.key.every((p, j) => next.key[j] === p)
    ) {
      raise(errorType, `Conflicting path in ${label} archive: ${cur.original} conflicts with ${next.original}`);
    }
  }
}

// ============================================================================
// ZIP reading
// ============================================================================

const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeCp437(bytes: Buffer): string {
  let out = '';
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  return out;
}

/** Metadata of one ZIP entry (subset of `zipfile.ZipInfo`). */
export interface ZipInfo {
  filename: string;
  fileSize: number;
  compressSize: number;
  compressType: number;
  externalAttr: number;
  flagBits: number;
  crc: number;
  headerOffset: number;
  /** `ZipInfo.is_dir()`. */
  isDir(): boolean;
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (zlib polynomial). */
export function crc32(data: Uint8Array, crc = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Thrown by {@link BoundedZipFile} for structural problems (Python `BadZipFile`). */
export class BadZipFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadZipFile';
  }
}

/**
 * In-memory ZIP reader (the part of `zipfile.ZipFile` upstream relies on).
 * Construct via {@link openZipBounded} so the bounded preflight runs first.
 */
export class BoundedZipFile {
  private entries: ZipInfo[] = [];
  private byName = new Map<string, ZipInfo>();

  constructor(private data: Buffer, private prefixSize: number, cdStart: number, cdSize: number) {
    let off = cdStart;
    const end = cdStart + cdSize;
    while (off < end) {
      if (data.readUInt32LE(off) !== 0x02014b50) throw new BadZipFile('Bad magic number for central directory');
      const flagBits = data.readUInt16LE(off + 8);
      const compressType = data.readUInt16LE(off + 10);
      const crc = data.readUInt32LE(off + 16);
      const compressSize = data.readUInt32LE(off + 20);
      const fileSize = data.readUInt32LE(off + 24);
      const nameLen = data.readUInt16LE(off + 28);
      const extraLen = data.readUInt16LE(off + 30);
      const commentLen = data.readUInt16LE(off + 32);
      const externalAttr = data.readUInt32LE(off + 38);
      const headerOffset = data.readUInt32LE(off + 42);
      const nameBytes = data.subarray(off + 46, off + 46 + nameLen);
      const filename = flagBits & 0x800 ? nameBytes.toString('utf8') : decodeCp437(nameBytes);
      const info: ZipInfo = {
        filename, fileSize, compressSize, compressType, externalAttr, flagBits, crc, headerOffset,
        isDir() {
          return this.filename.endsWith('/');
        },
      };
      this.entries.push(info);
      this.byName.set(filename, info);
      off += 46 + nameLen + extraLen + commentLen;
    }
  }

  /** `ZipFile.infolist()`. */
  infolist(): ZipInfo[] {
    return [...this.entries];
  }

  /** `ZipFile.namelist()`. */
  namelist(): string[] {
    return this.entries.map((e) => e.filename);
  }

  /** `ZipFile.getinfo(name)`; throws a `KeyError`-like Error when missing. */
  getinfo(name: string): ZipInfo {
    const info = this.byName.get(name);
    if (!info) {
      const e = new Error(`There is no item named ${pyRepr(name)} in the archive`);
      e.name = 'KeyError';
      throw e;
    }
    return info;
  }

  /**
   * Read a member's bytes, decompressing at most `maxBytes + 1` bytes. Throws
   * {@link ReadLimitExceededError} when the output exceeds `maxBytes`, or
   * {@link BadZipFile} for corrupt data/CRC mismatch.
   */
  read(member: string | ZipInfo, maxBytes = Number.MAX_SAFE_INTEGER): Buffer {
    const info = typeof member === 'string' ? this.getinfo(member) : member;
    const data = this.data;
    const off = this.prefixSize + info.headerOffset;
    if (off + ZIP_LOCAL_HEADER_SIZE > data.length || data.readUInt32LE(off) !== 0x04034b50) {
      throw new BadZipFile('Bad magic number for file header');
    }
    const nameLen = data.readUInt16LE(off + 26);
    const extraLen = data.readUInt16LE(off + 28);
    const localNameBytes = data.subarray(off + 30, off + 30 + nameLen);
    const localName = info.flagBits & 0x800 ? localNameBytes.toString('utf8') : decodeCp437(localNameBytes);
    if (localName !== info.filename) {
      throw new BadZipFile(`File name in directory ${pyRepr(info.filename)} and header ${pyRepr(localName)} differ.`);
    }
    if (info.flagBits & 0x1) {
      throw new Error(`File ${pyRepr(info.filename)} is encrypted, password required for extraction`);
    }
    const start = off + 30 + nameLen + extraLen;
    const compressed = data.subarray(start, start + info.compressSize);
    if (compressed.length < info.compressSize) throw new BadZipFile('Truncated file header');
    let out: Buffer;
    if (info.compressType === ZIP_STORED) {
      out = compressed.subarray(0, Math.min(compressed.length, maxBytes + 1));
      if (out.length > maxBytes) throw new ReadLimitExceededError();
    } else if (info.compressType === ZIP_DEFLATED) {
      try {
        out = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, Math.min(maxBytes + 1, 2 ** 31 - 1)) });
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (e instanceof RangeError || code === 'ERR_BUFFER_TOO_LARGE') throw new ReadLimitExceededError();
        throw new Error(`Error -3 while decompressing data: ${(e as Error).message}`);
      }
      if (out.length > maxBytes) throw new ReadLimitExceededError();
    } else {
      throw new Error('compression type ' + info.compressType);
    }
    if (out.length === info.fileSize && crc32(out) !== info.crc) {
      throw new BadZipFile(`Bad CRC-32 for file ${pyRepr(info.filename)}`);
    }
    if (out.length !== info.fileSize && out.length <= maxBytes) {
      // Python's ZipExtFile stops at file_size; longer/shorter output means a lying header.
      if (out.length > info.fileSize) out = out.subarray(0, info.fileSize);
      else throw new BadZipFile(`Bad CRC-32 for file ${pyRepr(info.filename)}`);
    }
    return out;
  }
}

/** Signals that a member read exceeded its byte bound. */
export class ReadLimitExceededError extends Error {
  constructor() {
    super('read limit exceeded');
    this.name = 'ReadLimitExceededError';
  }
}

function rejectZip64ExtraFields(extra: Buffer, zipPath: string, errorType: ErrorType): void {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const fieldId = extra.readUInt16LE(offset);
    const fieldSize = extra.readUInt16LE(offset + 2);
    const fieldEnd = offset + 4 + fieldSize;
    if (fieldId === ZIP64_EXTRA_FIELD_ID) raiseZip64(errorType);
    if (fieldEnd > extra.length) raise(errorType, `Invalid ZIP archive: ${zipPath}`);
    offset = fieldEnd;
  }
}

function raiseZip64(errorType: ErrorType): never {
  raise(errorType, 'ZIP64 archives are not supported by the bounded extractor');
}

function preflightZipEntryFeatures(extractVersion: number, compressionMethod: number, errorType: ErrorType): void {
  if (compressionMethod !== ZIP_STORED && compressionMethod !== ZIP_DEFLATED) {
    raise(
      errorType,
      `Unsupported ZIP compression method ${compressionMethod}; the bounded extractor supports only STORED and DEFLATED`,
    );
  }
  if (extractVersion >= ZIP64_MIN_EXTRACT_VERSION) {
    raise(
      errorType,
      'ZIP64 or newer ZIP features requiring extractor version 4.5 or newer are not supported by the bounded extractor',
    );
  }
}

function preflightZipLocalHeader(
  data: Buffer,
  zipPath: string,
  errorType: ErrorType,
  archivePrefixSize: number,
  centralDirectoryStart: number,
  localHeaderOffset: number,
): void {
  const physical = archivePrefixSize + localHeaderOffset;
  if (physical < archivePrefixSize || physical + ZIP_LOCAL_HEADER_SIZE > centralDirectoryStart) {
    raise(errorType, `Invalid ZIP archive: ${zipPath}`);
  }
  const header = data.subarray(physical, physical + ZIP_LOCAL_HEADER_SIZE);
  if (header.length !== ZIP_LOCAL_HEADER_SIZE || header.readUInt32LE(0) !== 0x04034b50) {
    raise(errorType, `Invalid ZIP archive: ${zipPath}`);
  }
  preflightZipEntryFeatures(header.readUInt16LE(4), header.readUInt16LE(8), errorType);
  const compressedSize = header.readUInt32LE(18);
  const uncompressedSize = header.readUInt32LE(22);
  if (compressedSize === ZIP_UINT32_MAX || uncompressedSize === ZIP_UINT32_MAX) raiseZip64(errorType);
  const filenameSize = header.readUInt16LE(26);
  const extraSize = header.readUInt16LE(28);
  const extraOffset = physical + ZIP_LOCAL_HEADER_SIZE + filenameSize;
  if (extraOffset + extraSize > centralDirectoryStart) raise(errorType, `Invalid ZIP archive: ${zipPath}`);
  const extra = data.subarray(extraOffset, extraOffset + extraSize);
  if (extra.length !== extraSize) raise(errorType, `Invalid ZIP archive: ${zipPath}`);
  rejectZip64ExtraFields(extra, zipPath, errorType);
}

interface ZipLayout {
  archivePrefixSize: number;
  centralDirectoryStart: number;
  centralDirectorySize: number;
}

function preflightZipCentralDirectory(data: Buffer, zipPath: string, errorType: ErrorType, maxEntries: number): ZipLayout {
  const fileSize = data.length;
  const tailSize = Math.min(fileSize, ZIP_EOCD_SIZE + ZIP_MAX_COMMENT_BYTES);
  const tail = data.subarray(fileSize - tailSize);
  const eocdIndex = tail.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (eocdIndex < 0 || eocdIndex + ZIP_EOCD_SIZE > tail.length) raise(errorType, `Invalid ZIP archive: ${zipPath}`);
  const commentSize = tail.readUInt16LE(eocdIndex + 20);
  if (eocdIndex + ZIP_EOCD_SIZE + commentSize !== tail.length) raise(errorType, `Invalid ZIP archive: ${zipPath}`);
  const eocdOffset = fileSize - tail.length + eocdIndex;
  if (eocdOffset >= 20 && data.readUInt32LE(eocdOffset - 20) === 0x07064b50) raiseZip64(errorType);
  const diskNumber = tail.readUInt16LE(eocdIndex + 4);
  const cdDisk = tail.readUInt16LE(eocdIndex + 6);
  const entriesOnDisk = tail.readUInt16LE(eocdIndex + 8);
  const declaredEntries = tail.readUInt16LE(eocdIndex + 10);
  const cdSize = tail.readUInt32LE(eocdIndex + 12);
  const cdOffset = tail.readUInt32LE(eocdIndex + 16);
  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== declaredEntries) {
    raise(errorType, 'Multi-disk ZIP archives are not supported');
  }
  if (declaredEntries === ZIP_UINT16_MAX || cdSize === ZIP_UINT32_MAX || cdOffset === ZIP_UINT32_MAX) {
    raiseZip64(errorType);
  }
  if (declaredEntries > maxEntries) {
    raise(errorType, `ZIP archive contains too many entries (${declaredEntries} > ${maxEntries})`);
  }
  if (cdSize > MAX_ZIP_CENTRAL_DIRECTORY_BYTES) {
    raise(errorType, `ZIP central directory exceeds maximum size of ${MAX_ZIP_CENTRAL_DIRECTORY_BYTES} bytes`);
  }
  const cdStart = eocdOffset - cdSize;
  if (cdStart < 0 || cdOffset > cdStart) raise(errorType, `Invalid ZIP archive: ${zipPath}`);
  const archivePrefixSize = cdStart - cdOffset;

  let consumed = 0;
  let actualEntries = 0;
  const localHeaderOffsets: number[] = [];
  while (consumed < cdSize) {
    const pos = cdStart + consumed;
    const remaining = cdSize - consumed;
    if (remaining < ZIP_CENTRAL_HEADER_SIZE) raise(errorType, `Invalid ZIP archive: ${zipPath}`);
    const header = data.subarray(pos, pos + ZIP_CENTRAL_HEADER_SIZE);
    if (header.length !== ZIP_CENTRAL_HEADER_SIZE || header.readUInt32LE(0) !== 0x02014b50) {
      raise(errorType, `Invalid ZIP archive: ${zipPath}`);
    }
    preflightZipEntryFeatures(header.readUInt16LE(6), header.readUInt16LE(10), errorType);
    const compressedSize = header.readUInt32LE(20);
    const uncompressedSize = header.readUInt32LE(24);
    const diskNumberStart = header.readUInt16LE(34);
    const localHeaderOffset = header.readUInt32LE(42);
    if (
      compressedSize === ZIP_UINT32_MAX ||
      uncompressedSize === ZIP_UINT32_MAX ||
      localHeaderOffset === ZIP_UINT32_MAX ||
      diskNumberStart === ZIP_UINT16_MAX
    ) {
      raiseZip64(errorType);
    }
    if (diskNumberStart !== 0) raise(errorType, 'Multi-disk ZIP archives are not supported');
    const filenameSize = header.readUInt16LE(28);
    const extraSize = header.readUInt16LE(30);
    const commentLen = header.readUInt16LE(32);
    const variableSize = filenameSize + extraSize + commentLen;
    const recordSize = ZIP_CENTRAL_HEADER_SIZE + variableSize;
    if (recordSize > remaining) raise(errorType, `Invalid ZIP archive: ${zipPath}`);
    const variable = data.subarray(pos + ZIP_CENTRAL_HEADER_SIZE, pos + ZIP_CENTRAL_HEADER_SIZE + variableSize);
    if (variable.length !== variableSize) raise(errorType, `Invalid ZIP archive: ${zipPath}`);
    rejectZip64ExtraFields(variable.subarray(filenameSize, filenameSize + extraSize), zipPath, errorType);
    localHeaderOffsets.push(localHeaderOffset);
    consumed += recordSize;
    actualEntries += 1;
    if (actualEntries > maxEntries) {
      raise(errorType, `ZIP archive contains too many entries (${actualEntries} > ${maxEntries})`);
    }
  }
  if (actualEntries !== declaredEntries) raise(errorType, `Invalid ZIP archive: ${zipPath}`);
  for (const lho of localHeaderOffsets) {
    preflightZipLocalHeader(data, zipPath, errorType, archivePrefixSize, cdStart, lho);
  }
  return { archivePrefixSize, centralDirectoryStart: cdStart, centralDirectorySize: cdSize };
}

export interface OpenZipOptions extends ArchiveSourceOptions {
  maxEntries?: number;
}

/**
 * Open an untrusted ZIP after a bounded-memory header preflight.
 * (Python's context manager; the returned reader needs no closing.)
 */
export function openZipBounded(zipPath: string, opts: OpenZipOptions = {}): BoundedZipFile {
  const errorType = opts.errorType ?? ValueError;
  const maxEntries = opts.maxEntries ?? MAX_ZIP_ENTRIES;
  validateNonNegativeInt(maxEntries, 'max_entries');
  const data = loadArchiveBytes(zipPath, opts.archiveFile, (e) => raiseFrom(errorType, `Invalid ZIP archive: ${zipPath}`, e));
  const layout = preflightZipCentralDirectory(data, zipPath, errorType, maxEntries);
  try {
    return new BoundedZipFile(data, layout.archivePrefixSize, layout.centralDirectoryStart, layout.centralDirectorySize);
  } catch (e) {
    return raiseFrom(errorType, `Invalid ZIP archive: ${zipPath}`, e);
  }
}

/** Minimal interface accepted by {@link readZipMemberLimited}. */
export interface ZipLike {
  getinfo(name: string): { fileSize: number };
  read(name: string, maxBytes: number): Uint8Array;
}

export interface ReadZipMemberOptions {
  maxBytes?: number;
  errorType?: ErrorType;
  label?: string | null;
}

/** Read a single ZIP member into memory under a hard size cap. */
export function readZipMemberLimited(zf: ZipLike, name: string, opts: ReadZipMemberOptions = {}): Buffer {
  const maxBytes = opts.maxBytes === undefined ? MAX_ZIP_MEMBER_BYTES : opts.maxBytes;
  validateNonNegativeInt(maxBytes, 'max_bytes');
  const errorType = opts.errorType ?? ValueError;
  const memberLabel = opts.label || name;
  let info: { fileSize: number };
  try {
    info = zf.getinfo(name);
  } catch (e) {
    return raiseFrom(errorType, `ZIP member not found: ${pyRepr(name)}`, e);
  }
  if (info.fileSize > maxBytes) {
    raise(errorType, `ZIP member ${pyRepr(memberLabel)} exceeds maximum size of ${maxBytes} bytes`);
  }
  try {
    return Buffer.from(zf.read(name, maxBytes));
  } catch (e) {
    if (e instanceof ReadLimitExceededError) {
      raise(errorType, `ZIP member ${pyRepr(memberLabel)} exceeds maximum size of ${maxBytes} bytes`);
    }
    return raiseFrom(errorType, `Failed to read ZIP member ${pyRepr(memberLabel)}: ${(e as Error).name}(${pyRepr((e as Error).message)})`, e);
  }
}

// ============================================================================
// Extraction
// ============================================================================

export interface ExtractOptions extends ArchiveSourceOptions {
  maxEntries?: number;
  maxMemberBytes?: number;
  maxTotalBytes?: number;
}

function isSymlinkMode(mode: number): boolean {
  return (mode & 0o170000) === 0o120000;
}

/** Extract a ZIP archive after path, symlink, and size validation. */
export function safeExtractZip(zipPath: string, targetDir: string, opts: ExtractOptions = {}): void {
  const errorType = opts.errorType ?? ValueError;
  const maxEntries = opts.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxMemberBytes = opts.maxMemberBytes ?? MAX_ZIP_MEMBER_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;
  validateNonNegativeInt(maxMemberBytes, 'max_member_bytes');
  validateNonNegativeInt(maxTotalBytes, 'max_total_bytes');
  let targetRoot: string;
  try {
    targetRoot = resolvePathLoose(targetDir);
  } catch (e) {
    return raiseFrom(errorType, `Invalid ZIP extraction target: ${targetDir}`, e);
  }
  const zf = openZipBounded(zipPath, { archiveFile: opts.archiveFile, errorType, maxEntries });
  const members = zf.infolist();
  if (members.length > maxEntries) {
    raise(errorType, `ZIP archive contains too many entries (${members.length} > ${maxEntries})`);
  }
  const normalizedMembers: Array<{ member: ZipInfo; normalized: string; isDir: boolean }> = [];
  const validated = new Map<string, { key: string[]; original: string; isDir: boolean }>();
  let totalSize = 0;
  for (const member of members) {
    const normalized = normalizeZipMemberName(member.filename, { errorType });
    const isDir = member.isDir() || normalized.endsWith('/');
    const key = portableArchivePathKey(normalized);
    const keyStr = JSON.stringify(key);
    const existing = validated.get(keyStr);
    if (existing) {
      raise(errorType, `Conflicting path in ZIP archive: ${member.filename} conflicts with ${existing.original}`);
    }
    validated.set(keyStr, { key, original: member.filename, isDir });
    const mode = member.externalAttr >>> 16;
    if (isSymlinkMode(mode)) raise(errorType, `Unsafe symlink in ZIP archive: ${member.filename}`);
    const memberPath = resolvePathLoose(path.join(targetDir, normalized));
    if (!isRelativeTo(memberPath, targetRoot)) {
      raise(errorType, `Unsafe path in ZIP archive: ${member.filename} (potential path traversal)`);
    }
    if (!isDir) {
      if (member.fileSize > maxMemberBytes) {
        raise(errorType, `ZIP member ${member.filename} exceeds maximum size of ${maxMemberBytes} bytes`);
      }
      totalSize += member.fileSize;
      if (totalSize > maxTotalBytes) {
        raise(errorType, `ZIP archive exceeds maximum uncompressed size of ${maxTotalBytes} bytes`);
      }
    }
    normalizedMembers.push({ member, normalized, isDir });
  }
  checkPrefixConflicts(validated, 'ZIP', errorType);

  let totalWritten = 0;
  for (const { member, normalized, isDir } of normalizedMembers) {
    const memberPath = path.join(targetDir, normalized);
    if (isDir) {
      try {
        fs.mkdirSync(memberPath, { recursive: true });
      } catch (e) {
        raiseFrom(errorType, `Failed to create ZIP directory ${member.filename}: ${errText(e)}`, e);
      }
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(memberPath), { recursive: true });
    } catch (e) {
      raiseFrom(errorType, `Failed to create parent directory for ZIP member ${member.filename}: ${errText(e)}`, e);
    }
    let limitError: string | null = null;
    let content: Buffer | null = null;
    try {
      try {
        content = zf.read(member, maxMemberBytes);
      } catch (e) {
        if (e instanceof ReadLimitExceededError) {
          limitError = `ZIP member ${member.filename} exceeds maximum size of ${maxMemberBytes} bytes`;
        } else throw e;
      }
      if (content !== null) {
        if (totalWritten + content.length > maxTotalBytes) {
          const allowed = maxTotalBytes - totalWritten;
          fs.writeFileSync(memberPath, content.subarray(0, Math.max(0, allowed)));
          limitError = `ZIP archive exceeds maximum uncompressed size of ${maxTotalBytes} bytes`;
        } else {
          fs.writeFileSync(memberPath, content);
          totalWritten += content.length;
        }
      } else {
        fs.writeFileSync(memberPath, Buffer.alloc(0));
      }
    } catch (e) {
      raiseFrom(errorType, `Failed to extract ZIP member ${member.filename}: ${errText(e)}`, e);
    }
    if (limitError !== null) raise(errorType, limitError);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// -- tar ---------------------------------------------------------------------

interface TarMember {
  name: string;
  type: string;
  size: number;
  dataOffset: number;
  isDir(): boolean;
  isReg(): boolean;
  isSym(): boolean;
  isLnk(): boolean;
}

function tarChecksumOk(block: Buffer): boolean {
  const stored = parseTarNumber(block.subarray(148, 156));
  if (stored === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : block[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
}

function parseTarNumber(field: Buffer): number | null {
  if (field.length && (field[0] === 0x80 || field[0] === 0xff)) {
    let n = 0;
    for (let i = 1; i < field.length; i++) n = n * 256 + field[i];
    return field[0] === 0xff ? -n : n;
  }
  const s = field.toString('latin1').replace(/\0.*$/s, '').trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) return null;
  return parseInt(s, 8);
}

function tarString(field: Buffer): string {
  const nul = field.indexOf(0);
  return field.subarray(0, nul >= 0 ? nul : field.length).toString('utf8');
}

class TarReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadError';
  }
}

/** Iterate tar members (ustar/pax/GNU long names). */
function* iterTar(data: Buffer): Generator<TarMember> {
  let off = 0;
  let paxName: string | null = null;
  let paxSize: number | null = null;
  let longName: string | null = null;
  let first = true;
  while (off + 512 <= data.length) {
    const block = data.subarray(off, off + 512);
    if (block.every((b) => b === 0)) {
      if (first) throw new TarReadError('empty file');
      return;
    }
    if (!tarChecksumOk(block)) {
      if (first) throw new TarReadError('invalid header');
      throw new TarReadError('invalid header');
    }
    first = false;
    let size = parseTarNumber(block.subarray(124, 136)) ?? 0;
    const type = String.fromCharCode(block[156] || 0x30);
    const magic = block.subarray(257, 263).toString('latin1');
    let name = tarString(block.subarray(0, 100));
    if (magic.startsWith('ustar')) {
      const prefix = tarString(block.subarray(345, 500));
      if (prefix) name = prefix + '/' + name;
    }
    const dataOffset = off + 512;
    const padded = Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      const body = data.subarray(dataOffset, dataOffset + size);
      if (body.length < size) throw new TarReadError('unexpected end of data');
      off = dataOffset + padded;
      if (type === 'x') {
        let p = 0;
        const text = body;
        while (p < text.length) {
          const sp = text.indexOf(0x20, p);
          if (sp < 0) break;
          const len = parseInt(text.subarray(p, sp).toString('latin1'), 10);
          if (!len) break;
          const rec = text.subarray(sp + 1, p + len - 1).toString('utf8');
          const eq = rec.indexOf('=');
          const k = rec.slice(0, eq);
          const v = rec.slice(eq + 1);
          if (k === 'path') paxName = v;
          if (k === 'size') paxSize = parseInt(v, 10);
          p += len;
        }
      }
      continue;
    }
    if (type === 'L' || type === 'K') {
      const body = data.subarray(dataOffset, dataOffset + size);
      if (body.length < size) throw new TarReadError('unexpected end of data');
      if (type === 'L') longName = tarString(body);
      off = dataOffset + padded;
      continue;
    }
    if (longName !== null) name = longName;
    if (paxName !== null) name = paxName;
    if (paxSize !== null) size = paxSize;
    longName = null;
    paxName = null;
    paxSize = null;
    let t = type;
    if ((t === '0' || t === '\0') && name.endsWith('/')) t = '5';
    if (t === '5') name = name.replace(/\/+$/, '');
    const realPadded = Math.ceil(size / 512) * 512;
    const hasData = !['1', '2', '3', '4', '5', '6'].includes(t);
    if (hasData && dataOffset + size > data.length) throw new TarReadError('unexpected end of data');
    const member: TarMember = {
      name, type: t, size, dataOffset,
      isDir: () => t === '5',
      isReg: () => t === '0' || t === '\0' || t === '7',
      isSym: () => t === '2',
      isLnk: () => t === '1',
    };
    yield member;
    off = dataOffset + (hasData ? realPadded : 0);
  }
  if (off < data.length || first) {
    if (first) throw new TarReadError('empty file');
    throw new TarReadError('unexpected end of data');
  }
}

/** Extract a gzip-compressed tar after ZIP-equivalent safety validation. */
export function safeExtractTar(archivePath: string, targetDir: string, opts: ExtractOptions = {}): void {
  const errorType = opts.errorType ?? ValueError;
  const maxEntries = opts.maxEntries ?? MAX_ZIP_ENTRIES;
  const maxMemberBytes = opts.maxMemberBytes ?? MAX_ZIP_MEMBER_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_ZIP_TOTAL_BYTES;
  validateNonNegativeInt(maxEntries, 'max_entries');
  validateNonNegativeInt(maxMemberBytes, 'max_member_bytes');
  validateNonNegativeInt(maxTotalBytes, 'max_total_bytes');
  let targetRoot: string;
  try {
    targetRoot = resolvePathLoose(targetDir);
  } catch (e) {
    return raiseFrom(errorType, `Invalid tar extraction target: ${targetDir}`, e);
  }
  const gz = loadArchiveBytes(archivePath, opts.archiveFile, (e) => raiseFrom(errorType, `Invalid tar.gz archive: ${archivePath}`, e));
  // Bound decompression: declared data plus generous header overhead.
  const decompressLimit = maxTotalBytes + (maxEntries + 2) * 4096 + 1024 * 1024;
  let data: Buffer;
  try {
    data = gunzipBounded(gz, decompressLimit);
    if (data.length > decompressLimit) throw new RangeError('gzip output exceeds limit');
  } catch (e) {
    if (e instanceof RangeError) {
      raise(errorType, `tar.gz archive exceeds maximum uncompressed size of ${maxTotalBytes} bytes`);
    }
    return raiseFrom(errorType, `Invalid tar.gz archive: ${archivePath}`, e);
  }
  const validatedList: Array<{ member: TarMember; normalized: string; isDir: boolean }> = [];
  const validated = new Map<string, { key: string[]; original: string; isDir: boolean }>();
  let totalSize = 0;
  try {
    let index = 0;
    for (const member of iterTar(data)) {
      index += 1;
      if (index > maxEntries) {
        raise(errorType, `tar.gz archive contains too many entries (${index} > ${maxEntries})`);
      }
      const normalized = normalizeArchiveMemberName(member.name, { archiveLabel: 'tar.gz', errorType });
      const isDir = member.isDir();
      if (member.isSym()) raise(errorType, `Unsafe symlink in tar.gz archive: ${member.name}`);
      if (member.isLnk()) raise(errorType, `Unsafe hard link in tar.gz archive: ${member.name}`);
      if (!isDir && !member.isReg()) raise(errorType, `Unsafe member type in tar.gz archive: ${member.name}`);
      const key = portableArchivePathKey(normalized);
      const keyStr = JSON.stringify(key);
      const existing = validated.get(keyStr);
      if (existing) {
        raise(errorType, `Conflicting path in tar.gz archive: ${member.name} conflicts with ${existing.original}`);
      }
      validated.set(keyStr, { key, original: member.name, isDir });
      const memberPath = resolvePathLoose(path.join(targetDir, normalized));
      if (!isRelativeTo(memberPath, targetRoot)) {
        raise(errorType, `Unsafe path in tar.gz archive: ${member.name} (potential path traversal)`);
      }
      if (!isDir) {
        if (member.size > maxMemberBytes) {
          raise(errorType, `tar.gz member ${member.name} exceeds maximum size of ${maxMemberBytes} bytes`);
        }
        totalSize += member.size;
        if (totalSize > maxTotalBytes) {
          raise(errorType, `tar.gz archive exceeds maximum uncompressed size of ${maxTotalBytes} bytes`);
        }
      }
      validatedList.push({ member, normalized, isDir });
    }
  } catch (e) {
    if (e instanceof TarReadError) return raiseFrom(errorType, `Invalid tar.gz archive: ${archivePath}`, e);
    throw e;
  }
  checkPrefixConflicts(validated, 'tar.gz', errorType);

  let totalWritten = 0;
  for (const { member, normalized, isDir } of validatedList) {
    const memberPath = path.join(targetDir, normalized);
    if (isDir) {
      try {
        fs.mkdirSync(memberPath, { recursive: true });
      } catch (e) {
        raiseFrom(errorType, `Failed to create tar.gz directory ${member.name}: ${errText(e)}`, e);
      }
      continue;
    }
    let limitError: string | null = null;
    try {
      fs.mkdirSync(path.dirname(memberPath), { recursive: true });
      const content = data.subarray(member.dataOffset, member.dataOffset + member.size);
      if (content.length > maxMemberBytes) {
        fs.writeFileSync(memberPath, content.subarray(0, maxMemberBytes));
        limitError = `tar.gz member ${member.name} exceeds maximum size of ${maxMemberBytes} bytes`;
      } else if (totalWritten + content.length > maxTotalBytes) {
        fs.writeFileSync(memberPath, content.subarray(0, Math.max(0, maxTotalBytes - totalWritten)));
        limitError = `tar.gz archive exceeds maximum uncompressed size of ${maxTotalBytes} bytes`;
      } else {
        fs.writeFileSync(memberPath, content);
        totalWritten += content.length;
      }
    } catch (e) {
      raiseFrom(errorType, `Failed to extract tar.gz member ${member.name}: ${errText(e)}`, e);
    }
    if (limitError !== null) raise(errorType, limitError);
  }
}

/** Detect and securely extract a supported archive. Returns the detected format. */
export function safeExtractArchive(
  archivePath: string,
  targetDir: string,
  opts: ExtractOptions & { sourceName?: string | null; contentType?: string | null } = {},
): ArchiveFormat {
  const format = detectArchiveFormat(archivePath, {
    archiveFile: opts.archiveFile,
    sourceName: opts.sourceName,
    contentType: opts.contentType,
    errorType: opts.errorType,
  });
  const extractor = format === 'zip' ? safeExtractZip : safeExtractTar;
  extractor(archivePath, targetDir, opts);
  return format;
}
