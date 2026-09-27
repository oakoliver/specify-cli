/**
 * Tests for src/download-security.ts (port of upstream tests/test_download_security.py).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
  MAX_ZIP_CENTRAL_DIRECTORY_BYTES,
  archiveFormatFromContentType,
  archiveFormatFromName,
  buildSafeDownloadPath,
  crc32,
  detectArchiveFormat,
  isHttpsOrLocalhostHttp,
  isLoopbackUrl,
  isSafeDownloadRedirect,
  normalizeZipMemberName,
  openZipBounded,
  readResponseLimited,
  readZipMemberLimited,
  safeExtractArchive,
  safeExtractTar,
  safeExtractZip,
} from '../src/download-security.js';

// ============================================================================
// Fixture builders
// ============================================================================

interface ZipEntry {
  name: string;
  data?: Buffer | string;
  method?: 0 | 8 | 12 | 14;
  externalAttr?: number;
  extractVersion?: number;
  localExtractVersion?: number;
  centralExtra?: Buffer;
  localExtra?: Buffer;
  flags?: number;
  /** Override the declared uncompressed size. */
  declaredSize?: number;
}

function buildZip(entries: ZipEntry[], opts: { prefix?: Buffer; comment?: Buffer } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const method = e.method ?? 8;
    const comp = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8');
    const flags = (e.flags ?? 0) | 0x800;
    const crc = crc32(raw);
    const size = e.declaredSize ?? raw.length;
    const localExtra = e.localExtra ?? Buffer.alloc(0);
    const centralExtra = e.centralExtra ?? Buffer.alloc(0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(e.localExtractVersion ?? e.extractVersion ?? 20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(localExtra.length, 28);
    const local = Buffer.concat([lh, name, localExtra, comp]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031e, 4);
    ch.writeUInt16LE(e.extractVersion ?? 20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(centralExtra.length, 30);
    ch.writeUInt32LE((e.externalAttr ?? (0o100644 << 16)) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, name, centralExtra]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const comment = opts.comment ?? Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([opts.prefix ?? Buffer.alloc(0), ...locals, cd, eocd, comment]);
}

function legacyEocd(entries: number, cdSize: number, cdOffset = 0, commentSize = 0): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(entries, 8);
  b.writeUInt16LE(entries, 10);
  b.writeUInt32LE(cdSize, 12);
  b.writeUInt32LE(cdOffset, 16);
  b.writeUInt16LE(commentSize, 20);
  return b;
}

interface TarEntry {
  name: string;
  data?: Buffer | string;
  type?: string;
  linkname?: string;
}

function tarHeader(name: string, size: number, type: string, linkname = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(type, 156, 'latin1');
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\x0000', 257, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}

function buildTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    const type = e.type ?? '0';
    const hasData = type === '0';
    parts.push(tarHeader(e.name, hasData ? data.length : 0, type, e.linkname));
    if (hasData) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function buildTarGz(entries: TarEntry[]): Buffer {
  return zlib.gzipSync(buildTar(entries));
}

function truncatedTarGz(keep: number): Buffer {
  const content = Buffer.alloc(256 * 400);
  for (let i = 0; i < content.length; i++) content[i] = i % 256;
  const entries = Array.from({ length: 5 }, (_, i) => ({ name: `file${i}.txt`, data: content }));
  return buildTarGz(entries).subarray(0, keep);
}

function corruptDeflateTarGz(): Buffer {
  const memberBytes = 512 * 1024;
  const entries = [0, 1].map((index) => {
    const content = Buffer.alloc(memberBytes);
    for (let i = 0; i < memberBytes; i++) content[i] = ((i % 1024) * 7 + index) % 256;
    return { name: `file${index}.txt`, data: content };
  });
  const plain = buildTar(entries);
  const clean = plain.subarray(0, 256 * 1024);
  const deflate = zlib.deflateRawSync(clean, { level: 1, finishFlush: zlib.constants.Z_SYNC_FLUSH });
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(clean), 0);
  trailer.writeUInt32LE(clean.length, 4);
  return Buffer.concat([header, deflate, Buffer.from([0x06]), trailer]);
}

class PyResponse {
  pos = 0;
  requested: number[] = [];
  constructor(private data: Buffer, private chunk?: number) {}
  read(size: number): Buffer {
    this.requested.push(size);
    if (size < 0) size = this.data.length - this.pos;
    if (this.chunk !== undefined) size = Math.min(size, this.chunk);
    const out = this.data.subarray(this.pos, this.pos + size);
    this.pos += out.length;
    return out;
  }
}

class CustomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomError';
  }
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dlsec-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, data: Buffer): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, data);
  return p;
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }) as string[];
}

// ============================================================================
// URL policy
// ============================================================================

describe('isHttpsOrLocalhostHttp', () => {
  const cases: Array<[string, boolean]> = [
    ['https://example.com/preset.zip', true],
    ['http://localhost:8000/preset.zip', true],
    ['http://127.0.0.1/preset.zip', true],
    ['http://127.0.0.2/preset.zip', true],
    ['http://127.255.255.254/preset.zip', true],
    ['http://[::1]/preset.zip', true],
    ['http://[0:0:0:0:0:0:0:1]/preset.zip', true],
    ['http://[::ffff:127.0.0.2]/preset.zip', true],
    ['http://[::1%25lo0]/preset.zip', true],
    ['http://example.com/preset.zip', false],
    ['http://192.0.2.1/preset.zip', false],
    ['http://[fe80::1]/preset.zip', false],
    ['http://[fe80::1%25lo0]/preset.zip', false],
    ['http://0.0.0.0/preset.zip', false],
    ['http://0/preset.zip', false],
    ['http://[::]/preset.zip', false],
    ['http://[::ffff:0.0.0.0]/preset.zip', false],
    ['http://127.1/preset.zip', false],
    ['http://2130706433/preset.zip', false],
    ['http://0x7f000001/preset.zip', false],
    ['http://017700000001/preset.zip', false],
    ['http://0177.0.0.1/preset.zip', false],
    ['http://00177.0.0.1/preset.zip', false],
    ['http://localhost./preset.zip', false],
    ['http://ℓocalhost/preset.zip', false],
    ['http://127。0。0。1/preset.zip', false],
    ['https:///preset.zip', false],
    ['https://', false],
    ['https://example.com:notaport/preset.zip', false],
    ['https://example.com:+443/preset.zip', false],
    ['https://example.com:65536/preset.zip', false],
    ['https://127%2e0%2e0%2e1/preset.zip', false],
    ['https://%31%32%37.0.0.1/preset.zip', false],
    ['https://local%68ost/preset.zip', false],
    ['https://example.com%3a443/preset.zip', false],
    ['https://[::1%lo0]/preset.zip', false],
    ['https://[::ffff:127%2e0.0.1]/preset.zip', false],
    ['https://[::ffff:7f00%3a1]/preset.zip', false],
    ['https://[::ffff%3a127.0.0.1]/preset.zip', false],
  ];
  for (const [url, allowed] of cases) {
    test(`${url} -> ${allowed}`, () => {
      expect(isHttpsOrLocalhostHttp(url)).toBe(allowed);
    });
  }
});

describe('isLoopbackUrl', () => {
  for (const url of [
    'https://localhost/internal',
    'https://127.0.0.2/internal',
    'https://[::1]/internal',
    'https://[::1%25lo0]/internal',
    'https://[::ffff:127.0.0.2]/internal',
  ]) {
    test(`recognizes ${url}`, () => expect(isLoopbackUrl(url)).toBe(true));
  }
  for (const url of [
    'https://localhost./internal',
    'https://service.localhost/internal',
    'https://service.localhost./internal',
    'https://127.1/internal',
    'https://2130706433/internal',
    'https://0x7f000001/internal',
    'https://017700000001/internal',
    'https://0177.0.0.1/internal',
    'https://ℓocalhost/internal',
    'https://127。0。0。1/internal',
    'https://127%2e0%2e0%2e1/internal',
    'https://0.0.0.0/internal',
    'https://0/internal',
    'https://00.00.00.00/internal',
    'https://[::]/internal',
    'https://[::ffff:0.0.0.0]/internal',
  ]) {
    test(`rejects ${url}`, () => expect(isLoopbackUrl(url)).toBe(false));
  }
});

describe('isSafeDownloadRedirect', () => {
  test('remote to remote https is allowed', () => {
    expect(isSafeDownloadRedirect('https://a.example/x', 'https://b.example/y')).toBe(true);
  });
  test('remote to loopback is rejected', () => {
    expect(isSafeDownloadRedirect('https://a.example/x', 'https://127.0.0.1/y')).toBe(false);
    expect(isSafeDownloadRedirect('https://a.example/x', 'https://2130706433/y')).toBe(false);
    expect(isSafeDownloadRedirect('https://a.example/x', 'https://service.localhost/y')).toBe(false);
  });
  test('loopback to loopback is allowed', () => {
    expect(isSafeDownloadRedirect('http://localhost/x', 'http://127.0.0.1/y')).toBe(true);
  });
  test('downgrade to http is rejected', () => {
    expect(isSafeDownloadRedirect('https://a.example/x', 'http://b.example/y')).toBe(false);
  });
});

// ============================================================================
// Bounded reads
// ============================================================================

describe('readResponseLimited', () => {
  test('rejects oversized download', async () => {
    await expect(readResponseLimited(new PyResponse(Buffer.from('abcde')), { maxBytes: 4 })).rejects.toThrow(
      'exceeds maximum size',
    );
  });
  test('returns full body within limit', async () => {
    expect((await readResponseLimited(new PyResponse(Buffer.from('abcde')), { maxBytes: 10 })).toString()).toBe('abcde');
  });
  test('enforces bound under short reads', async () => {
    await expect(readResponseLimited(new PyResponse(Buffer.alloc(100, 'x'), 8), { maxBytes: 16 })).rejects.toThrow(
      'exceeds maximum size',
    );
  });
  test('caps underlying reads at 64 KiB', async () => {
    const r = new PyResponse(Buffer.alloc(64 * 1024 + 1, 'x'));
    await expect(readResponseLimited(r, { maxBytes: 64 * 1024 })).rejects.toThrow('exceeds maximum size');
    expect(Math.max(...r.requested)).toBeLessThanOrEqual(64 * 1024);
  });
  for (const value of [null, '1', 1.5, true]) {
    test(`rejects non-integer limit ${String(value)}`, async () => {
      await expect(
        readResponseLimited(new PyResponse(Buffer.alloc(0)), { maxBytes: value as unknown as number }),
      ).rejects.toThrow(/integer/);
    });
  }
  test('rejects negative limit without reading', async () => {
    const r = new PyResponse(Buffer.alloc(0));
    await expect(readResponseLimited(r, { maxBytes: -1 })).rejects.toThrow('non-negative');
    expect(r.requested).toEqual([]);
  });
  test('allows empty response at zero limit', async () => {
    expect((await readResponseLimited(new PyResponse(Buffer.alloc(0)), { maxBytes: 0 })).length).toBe(0);
  });
  test('rejects first byte at zero limit with custom error', async () => {
    await expect(
      readResponseLimited(new PyResponse(Buffer.from('x')), { maxBytes: 0, errorType: CustomError }),
    ).rejects.toBeInstanceOf(CustomError);
  });
  test('escapes control characters in label', async () => {
    try {
      await readResponseLimited(new PyResponse(Buffer.from('x')), { maxBytes: 0, label: 'bad\x1b[2J download' });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('\x1b');
      expect(msg).toContain('\\x1b');
      expect(msg).toBe("'bad\\x1b[2J download' exceeds maximum size of 0 bytes");
    }
  });
  test('reads a fetch Response body', async () => {
    const res = new Response('hello world');
    expect((await readResponseLimited(res, { maxBytes: 100 })).toString()).toBe('hello world');
    await expect(readResponseLimited(new Response('hello world'), { maxBytes: 5 })).rejects.toThrow(
      "'download' exceeds maximum size of 5 bytes",
    );
  });
});

// ============================================================================
// Download path / format detection
// ============================================================================

describe('buildSafeDownloadPath', () => {
  for (const identifier of ['../outside', '..\\outside', 'a'.repeat(256), 'delete\x7f', 'csi\x9b[2J', '\ud800']) {
    test(`rejects ${JSON.stringify(identifier).slice(0, 30)}`, () => {
      expect(() => buildSafeDownloadPath(tmp, identifier, '1.0.0')).toThrow('Unsafe archive download filename');
    });
  }
  test('uses archive suffix', () => {
    expect(path.basename(buildSafeDownloadPath(tmp, 'package', '1.0.0', { suffix: '.tar.gz' }))).toBe(
      'package-1.0.0.tar.gz',
    );
  });
  test('rejects non-string identifiers', () => {
    expect(() => buildSafeDownloadPath(tmp, 5, '1.0.0')).toThrow("Unsafe archive download filename derived from 5 and '1.0.0'");
  });
});

describe('archive format helpers', () => {
  test.each([
    ['package.zip', 'zip'],
    ['PACKAGE.TAR.GZ', 'tar.gz'],
    ['https://example.com/package.tgz?download=1', 'tar.gz'],
    ['package.tar', null],
  ])('archiveFormatFromName(%s)', (name, expected) => {
    expect(archiveFormatFromName(name)).toBe(expected as never);
  });
  test.each([
    ['application/zip', 'zip'],
    ['application/x-zip-compressed; charset=binary', 'zip'],
    ['application/gzip', 'tar.gz'],
    ['application/x-gzip', 'tar.gz'],
    ['application/octet-stream', null],
  ])('archiveFormatFromContentType(%s)', (ct, expected) => {
    expect(archiveFormatFromContentType(ct)).toBe(expected as never);
  });
  for (const suffix of ['.tar.gz', '.tgz']) {
    test(`detect accepts ${suffix}`, () => {
      const p = write(`package${suffix}`, buildTarGz([{ name: 'file.txt', data: 'contents' }]));
      expect(detectArchiveFormat(p)).toBe('tar.gz');
    });
  }
  test('detect allows content-type fallback', () => {
    const p = write('download', buildTarGz([{ name: 'file.txt', data: 'contents' }]));
    expect(detectArchiveFormat(p, { sourceName: 'https://example.com/download', contentType: 'application/gzip' })).toBe(
      'tar.gz',
    );
  });
  test('detect rejects suffix/content mismatch', () => {
    const p = write('package.zip', buildTarGz([{ name: 'file.txt', data: 'contents' }]));
    expect(() => detectArchiveFormat(p)).toThrow('format mismatch');
  });
  test('detect rejects suffix/header mismatch', () => {
    const p = write('package.zip', buildZip([{ name: 'file.txt', data: 'contents' }]));
    expect(() => detectArchiveFormat(p, { contentType: 'application/gzip' })).toThrow('Content-Type');
  });
  test('detect rejects truncated tar.gz', () => {
    const p = write('truncated.tar.gz', truncatedTarGz(64));
    expect(() => detectArchiveFormat(p)).toThrow('format mismatch');
  });
  test('detect accepts corrupt-deflate tar.gz (only first header probed)', () => {
    const p = write('corrupt.tar.gz', corruptDeflateTarGz());
    expect(detectArchiveFormat(p)).toBe('tar.gz');
  });
  test('detect rejects unknown data without declaration', () => {
    const p = write('download', Buffer.from('not an archive'));
    expect(() => detectArchiveFormat(p)).toThrow('Unsupported archive format; expected .zip, .tar.gz, or .tgz');
  });
});

// ============================================================================
// tar.gz
// ============================================================================

describe('safeExtractTar', () => {
  for (const name of ['../evil.txt', 'nested/../../evil.txt', 'C:/Windows/evil.txt']) {
    test(`rejects traversal ${name}`, () => {
      const p = write('bad.tar.gz', buildTarGz([{ name, data: 'nope' }]));
      expect(() => safeExtractTar(p, path.join(tmp, 'out'))).toThrow('Unsafe path');
    });
  }
  for (const [type, message] of [['2', 'symlink'], ['1', 'hard link']]) {
    test(`rejects ${message} without partial extraction`, () => {
      const p = write('bad.tar.gz', buildTarGz([{ name: 'safe.txt', data: 'safe' }, { name: 'escape', type, linkname: '../../outside' }]));
      const out = path.join(tmp, 'out');
      expect(() => safeExtractTar(p, out)).toThrow(message);
      expect(listFiles(out)).toEqual([]);
    });
  }
  test('rejects special file', () => {
    const p = write('bad.tar.gz', buildTarGz([{ name: 'pipe', type: '6' }]));
    expect(() => safeExtractTar(p, path.join(tmp, 'out'))).toThrow('Unsafe member type');
  });
  test('rejects conflicting paths', () => {
    const p = write('bad.tar.gz', buildTarGz([{ name: 'Folder/file.txt', data: 'one' }, { name: 'folder/FILE.txt', data: 'two' }]));
    expect(() => safeExtractTar(p, path.join(tmp, 'out'))).toThrow('Conflicting path');
  });
  test('enforces entry and size limits', () => {
    const p = write('bad.tar.gz', buildTarGz([{ name: 'one.txt', data: '1234' }, { name: 'two.txt', data: '5678' }]));
    expect(() => safeExtractTar(p, path.join(tmp, 'entries'), { maxEntries: 1 })).toThrow('too many entries');
    expect(() => safeExtractTar(p, path.join(tmp, 'member'), { maxMemberBytes: 3 })).toThrow(/member.*maximum size/);
    expect(() => safeExtractTar(p, path.join(tmp, 'total'), { maxTotalBytes: 7 })).toThrow('uncompressed size');
  });
  for (const keep of [64, 512, 2048]) {
    test(`rejects truncated archive (${keep} bytes)`, () => {
      const p = write(`truncated-${keep}.tar.gz`, truncatedTarGz(keep));
      expect(() => safeExtractTar(p, path.join(tmp, `out-${keep}`))).toThrow('Invalid tar.gz archive');
    });
  }
  test('wraps truncation in caller error type', () => {
    const p = write('truncated.tar.gz', truncatedTarGz(2048));
    expect(() => safeExtractTar(p, path.join(tmp, 'out'), { errorType: CustomError })).toThrow(CustomError);
  });
  test('safeExtractArchive rejects truncated tar.gz', () => {
    const p = write('truncated.tar.gz', truncatedTarGz(2048));
    expect(() => safeExtractArchive(p, path.join(tmp, 'out'))).toThrow();
  });
  test('rejects corrupt deflate with caller error type', () => {
    const p = write('corrupt.tar.gz', corruptDeflateTarGz());
    expect(() => safeExtractTar(p, path.join(tmp, 'out'))).toThrow('Invalid tar.gz archive');
    expect(() => safeExtractTar(p, path.join(tmp, 'out2'), { errorType: CustomError })).toThrow(CustomError);
    expect(() => safeExtractArchive(p, path.join(tmp, 'out3'), { errorType: CustomError })).toThrow(
      /Invalid tar.gz archive/,
    );
  });
  test('extracts directories and nested files', () => {
    const p = write('ok.tar.gz', buildTarGz([{ name: 'pkg/', type: '5' }, { name: 'pkg/a/b.txt', data: 'hi' }]));
    const out = path.join(tmp, 'out');
    safeExtractTar(p, out);
    expect(fs.readFileSync(path.join(out, 'pkg', 'a', 'b.txt'), 'utf8')).toBe('hi');
  });
});

describe('safeExtractArchive format parity', () => {
  for (const suffix of ['.zip', '.tar.gz', '.tgz']) {
    test(suffix, () => {
      const data =
        suffix === '.zip'
          ? buildZip([{ name: 'nested/file.txt', data: 'contents' }])
          : buildTarGz([{ name: 'nested/file.txt', data: 'contents' }]);
      const p = write(`package${suffix}`, data);
      const out = path.join(tmp, `out-${suffix.replace(/\./g, '-')}`);
      expect(safeExtractArchive(p, out)).toBe(suffix === '.zip' ? 'zip' : 'tar.gz');
      expect(fs.readFileSync(path.join(out, 'nested', 'file.txt'), 'utf8')).toBe('contents');
    });
  }
});

// ============================================================================
// ZIP
// ============================================================================

describe('safeExtractZip', () => {
  for (const name of ['../evil.txt', 'nested/../../evil.txt', 'nested\\..\\evil.txt', 'C:\\Windows\\evil.txt', 'C:drive-relative.txt']) {
    test(`rejects traversal ${name}`, () => {
      const p = write('bad.zip', buildZip([{ name, data: 'nope' }]));
      expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('Unsafe path');
    });
  }
  for (const name of ['.', './file.txt', 'nested/./file.txt', 'nested//file.txt']) {
    test(`rejects dot segment ${name}`, () => {
      const p = write('bad.zip', buildZip([{ name, data: 'nope' }]));
      expect(() => safeExtractZip(p, path.join(tmp, 'out'), { errorType: CustomError })).toThrow(CustomError);
    });
  }
  test('rejects symlinks', () => {
    const p = write('bad.zip', buildZip([{ name: 'link', data: 'target', externalAttr: (0o120777 << 16) >>> 0 }]));
    expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('Unsafe symlink');
  });
  test('rejects symlink without partial extraction', () => {
    const p = write(
      'mixed.zip',
      buildZip([
        { name: 'safe/first.txt', data: 'hello' },
        { name: 'evil-link', data: 'target', externalAttr: (0o120777 << 16) >>> 0 },
        { name: 'safe/second.txt', data: 'world' },
      ]),
    );
    const out = path.join(tmp, 'out');
    expect(() => safeExtractZip(p, out)).toThrow('Unsafe symlink');
    expect(listFiles(out)).toEqual([]);
  });
  test('rejects oversized member', () => {
    const p = write('bad.zip', buildZip([{ name: 'big.txt', data: 'abcde' }]));
    expect(() => safeExtractZip(p, path.join(tmp, 'out'), { maxMemberBytes: 4 })).toThrow('exceeds maximum size');
  });
  test('rejects too many entries', () => {
    const p = write('bad.zip', buildZip([{ name: 'one.txt', data: '1' }, { name: 'two.txt', data: '2' }]));
    expect(() => safeExtractZip(p, path.join(tmp, 'out'), { maxEntries: 1 })).toThrow('too many entries');
  });
  test('preflights declared entry count', () => {
    const p = write('too-many.zip', legacyEocd(513, 0));
    expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('too many entries');
  });
  test('preflights actual entry count when EOCD lies', () => {
    const central = Buffer.concat([Buffer.from('PK\x01\x02', 'latin1'), Buffer.alloc(42)]);
    const cd = Buffer.concat(Array(513).fill(central));
    const p = write('lying.zip', Buffer.concat([cd, legacyEocd(1, cd.length)]));
    expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('too many entries (513 > 512)');
  });
  test('rejects truncated EOCD comment', () => {
    const good = buildZip([{ name: 'a.txt', data: 'a' }]);
    good.writeUInt16LE(10, good.length - 2);
    const p = write('trunc-comment.zip', good);
    expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('Invalid ZIP archive');
  });
  test('rejects ZIP64 locator', () => {
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    const p = write('zip64.zip', Buffer.concat([locator, legacyEocd(0, 0)]));
    expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('ZIP64 archives are not supported');
  });
  test('rejects ZIP64 sentinel sizes', () => {
    const p = write('zip64.zip', buildZip([{ name: 'a.txt', data: 'a', declaredSize: 0xffffffff }]));
    expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('ZIP64');
  });
  for (const where of ['central', 'local'] as const) {
    test(`rejects ZIP64 extra field in ${where} header`, () => {
      const extra = Buffer.alloc(4 + 16);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      const entry: ZipEntry = { name: 'a.txt', data: 'a' };
      if (where === 'central') entry.centralExtra = extra;
      else entry.localExtra = extra;
      const p = write('zip64extra.zip', buildZip([entry]));
      expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('ZIP64 archives are not supported');
    });
  }
  for (const v of [45, 46]) {
    for (const where of ['central', 'local'] as const) {
      test(`rejects extract version ${v} in ${where}`, () => {
        const entry: ZipEntry = { name: 'a.txt', data: 'a' };
        if (where === 'central') entry.extractVersion = v;
        else {
          entry.extractVersion = 20;
          entry.localExtractVersion = v;
        }
        const p = write('v45.zip', buildZip([entry]));
        expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('extractor version 4.5');
      });
    }
  }
  for (const method of [12, 14] as const) {
    test(`rejects unbounded compression method ${method}`, () => {
      const p = write('bz.zip', buildZip([{ name: 'a.txt', data: 'a', method }]));
      expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow(
        `Unsupported ZIP compression method ${method}; the bounded extractor supports only STORED and DEFLATED`,
      );
    });
  }
  for (const method of [0, 8] as const) {
    test(`accepts compression method ${method}`, () => {
      const p = write('ok.zip', buildZip([{ name: 'a.txt', data: 'payload', method }]));
      const out = path.join(tmp, 'out');
      safeExtractZip(p, out);
      expect(fs.readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('payload');
    });
  }
  test('accepts archive with prepended data', () => {
    const p = write('prefixed.zip', buildZip([{ name: 'a.txt', data: 'x' }], { prefix: Buffer.from('#!/bin/sh\nexit 0\n') }));
    const out = path.join(tmp, 'out');
    safeExtractZip(p, out);
    expect(fs.readFileSync(path.join(out, 'a.txt'), 'utf8')).toBe('x');
  });
  test('rejects central entry from another disk', () => {
    const z = buildZip([{ name: 'a.txt', data: 'x' }]);
    const cdStart = z.readUInt32LE(z.length - 22 + 16);
    z.writeUInt16LE(1, cdStart + 34);
    const p = write('disk.zip', z);
    expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('Multi-disk ZIP archives are not supported');
  });
  test('caps central directory before parsing', () => {
    const p = write('bigcd.zip', legacyEocd(1, MAX_ZIP_CENTRAL_DIRECTORY_BYTES + 1));
    expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('ZIP central directory exceeds maximum size');
  });
  test('rejects total uncompressed size', () => {
    const p = write('big.zip', buildZip([{ name: 'a.txt', data: 'abc' }, { name: 'b.txt', data: 'def' }]));
    expect(() => safeExtractZip(p, path.join(tmp, 'out'), { maxTotalBytes: 5 })).toThrow('uncompressed size');
  });
  test('wraps bad zip file', () => {
    const p = write('bad.zip', Buffer.from('not a zip'));
    expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('Invalid ZIP archive');
  });
  test('enforces actual member size when headers lie', () => {
    const p = write('lie.zip', buildZip([{ name: 'a.txt', data: 'x'.repeat(100), declaredSize: 1 }]));
    expect(() => safeExtractZip(p, path.join(tmp, 'out'), { maxMemberBytes: 10 })).toThrow('exceeds maximum size');
  });
  test('detects CRC mismatch', () => {
    const z = buildZip([{ name: 'a.txt', data: 'hello', method: 0 }]);
    const idx = z.indexOf(Buffer.from('hello'));
    z[idx] = 'j'.charCodeAt(0);
    const p = write('crc.zip', z);
    expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow(/Failed to extract ZIP member a.txt: Bad CRC-32/);
  });
  for (const [a, b] of [['Folder/file.txt', 'folder/FILE.txt'], ['file', 'file/child.txt']]) {
    test(`rejects conflicting paths ${a} / ${b}`, () => {
      const p = write('conf.zip', buildZip([{ name: a, data: '1' }, { name: b, data: '2' }]));
      const out = path.join(tmp, 'out');
      expect(() => safeExtractZip(p, out)).toThrow('Conflicting path in ZIP archive');
      expect(listFiles(out)).toEqual([]);
    });
  }
  for (const name of ['CON', 'aux.txt', 'dir/nul', 'bad:name', 'trailing.', 'trailing ', ' leading', 'a|b', 'COM¹']) {
    test(`rejects non-portable name ${JSON.stringify(name)}`, () => {
      const p = write('np.zip', buildZip([{ name, data: 'x' }]));
      expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('not portable across supported filesystems');
    });
  }
  test('rejects excessively long paths', () => {
    const p = write('long.zip', buildZip([{ name: 'a'.repeat(256), data: 'x' }]));
    expect(() => safeExtractZip(p, path.join(tmp, 'out'))).toThrow('not portable');
  });
  test('escapes unicode control characters in errors', () => {
    const p = write('ctl.zip', buildZip([{ name: 'bad\u0085name', data: 'x' }]));
    try {
      safeExtractZip(p, path.join(tmp, 'out'));
      throw new Error('should throw');
    } catch (e) {
      expect((e as Error).message).toContain('\\x85');
      expect((e as Error).message).not.toContain('\u0085');
    }
  });
  test('accepts single decomposed unicode name', () => {
    const p = write('nfd.zip', buildZip([{ name: 'cafe\u0301.txt', data: 'x' }]));
    const out = path.join(tmp, 'out');
    safeExtractZip(p, out);
    expect(fs.readFileSync(path.join(out, 'cafe\u0301.txt'), 'utf8')).toBe('x');
  });
  test('extracts safe archive', () => {
    const p = write('good.zip', buildZip([{ name: 'dir/', data: '' }, { name: 'dir/file.txt', data: 'hello' }]));
    const out = path.join(tmp, 'out');
    safeExtractZip(p, out);
    expect(fs.readFileSync(path.join(out, 'dir', 'file.txt'), 'utf8')).toBe('hello');
  });
  test('treats normalized trailing backslash as directory', () => {
    const p = write('bs.zip', buildZip([{ name: 'dir\\', data: '' }]));
    const out = path.join(tmp, 'out');
    safeExtractZip(p, out);
    expect(fs.statSync(path.join(out, 'dir')).isDirectory()).toBe(true);
  });
});

describe('readZipMemberLimited', () => {
  test('returns member within limit', () => {
    const p = write('m.zip', buildZip([{ name: 'extension.yml', data: 'id: x\n' }]));
    const zf = openZipBounded(p);
    expect(zf.namelist()).toEqual(['extension.yml']);
    expect(readZipMemberLimited(zf, 'extension.yml', { maxBytes: 100 }).toString()).toBe('id: x\n');
  });
  for (const value of [null, '1', 1.5, true]) {
    test(`rejects non-integer limit ${String(value)}`, () => {
      const p = write('m.zip', buildZip([{ name: 'a', data: 'x' }]));
      expect(() => readZipMemberLimited(openZipBounded(p), 'a', { maxBytes: value as unknown as number })).toThrow(/integer/);
    });
  }
  test('rejects negative limit', () => {
    const p = write('m.zip', buildZip([{ name: 'a', data: 'x' }]));
    expect(() => readZipMemberLimited(openZipBounded(p), 'a', { maxBytes: -1 })).toThrow('non-negative');
  });
  test('rejects oversized member (declared)', () => {
    const p = write('m.zip', buildZip([{ name: 'extension.yml', data: 'abcdef' }]));
    expect(() => readZipMemberLimited(openZipBounded(p), 'extension.yml', { maxBytes: 3 })).toThrow(
      "ZIP member 'extension.yml' exceeds maximum size of 3 bytes",
    );
  });
  test('rejects when declared size is too small', () => {
    const p = write('m.zip', buildZip([{ name: 'extension.yml', data: 'abcdef', declaredSize: 1 }]));
    expect(() => readZipMemberLimited(openZipBounded(p), 'extension.yml', { maxBytes: 3 })).toThrow(
      'exceeds maximum size of 3 bytes',
    );
  });
  test('escapes control characters in errors', () => {
    const fake = { getinfo: () => ({ fileSize: 10 }), read: () => new Uint8Array() };
    try {
      readZipMemberLimited(fake, 'x', { maxBytes: 1, label: 'bad\x1bname' });
      throw new Error('should throw');
    } catch (e) {
      expect((e as Error).message).toContain('\\x1b');
    }
  });
  test('wraps missing member', () => {
    const p = write('m.zip', buildZip([{ name: 'a', data: 'x' }]));
    expect(() => readZipMemberLimited(openZipBounded(p), 'missing.yml', { errorType: CustomError })).toThrow(
      "ZIP member not found: 'missing.yml'",
    );
  });
  test('wraps decompression errors', () => {
    const fake = {
      getinfo: () => ({ fileSize: 1 }),
      read: () => {
        throw new Error('corrupt compressed data');
      },
    };
    expect(() => readZipMemberLimited(fake, 'extension.yml', { errorType: CustomError })).toThrow(
      /Failed to read ZIP member 'extension.yml'/,
    );
  });
});

describe('normalizeZipMemberName', () => {
  test('normalizes backslashes', () => {
    expect(normalizeZipMemberName('a\\b.txt')).toBe('a/b.txt');
  });
  test('keeps single trailing slash for directories', () => {
    expect(normalizeZipMemberName('dir/')).toBe('dir/');
  });
  test('rejects NUL', () => {
    expect(() => normalizeZipMemberName('a\x00b')).toThrow("Unsafe path in ZIP archive: 'a\\x00b'");
  });
});
