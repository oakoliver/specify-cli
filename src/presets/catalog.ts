/**
 * @oakoliver/specify-cli - Preset catalog retrieval and downloads
 *
 * Port of ``specify_cli/presets/_catalog.py``: multi-catalog stack resolution
 * (env var → project config → user config → built-in defaults), per-URL
 * caching, merged search, and archive downloads.
 *
 * Network-touching methods are ``async`` in the TypeScript port (global
 * ``fetch`` is asynchronous); their behavior otherwise mirrors upstream.
 *
 * @module presets/catalog
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import {
  MAX_JSON_CATALOG_BYTES,
  archiveFormatFromName,
  archiveSuffix,
  buildSafeDownloadPath,
  detectArchiveFormat,
  isHttpsOrLocalhostHttp,
  readResponseLimited,
} from '../download-security.js';
import { githubProviderHosts, openUrl } from '../authentication/http.js';
import { resolveGithubReleaseAssetApiUrl } from '../authentication/github-http.js';
import { REINSTALL_COMMAND } from '../extensions/index.js';
import { verifyArchiveSha256 } from '../shared-infra.js';
import { parseYaml } from '../yaml.js';
import {
  PresetError,
  PresetValidationError,
  isFile,
  isMapping,
  pathExists,
  pyJsonDumps,
  pyRepr,
  pyStr,
  pyTruthy,
  pyTypeName,
  readTextStrict,
  userHome,
  utcNowIso,
} from './manifest.js';

// ============================================================================
// URL helpers (urllib.parse parity)
// ============================================================================

interface ParsedUrlLite {
  scheme: string;
  hostname: string | null;
}

/**
 * ``urlparse(url)`` + ``.hostname`` + ``.port`` validation. Throws (Python
 * ``ValueError``) for malformed authorities or invalid ports.
 */
export function parseUrlStrict(url: string): ParsedUrlLite {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(url);
  let scheme = '';
  let rest = url;
  if (m) {
    scheme = m[1].toLowerCase();
    rest = m[2];
  }
  let netloc = '';
  if (rest.startsWith('//')) {
    const after = rest.slice(2);
    const end = after.search(/[/?#]/);
    netloc = end === -1 ? after : after.slice(0, end);
  }
  if ((netloc.includes('[') && !netloc.includes(']')) || (netloc.includes(']') && !netloc.includes('['))) {
    throw new Error('Invalid IPv6 URL');
  }
  const hostPort = netloc.includes('@') ? netloc.slice(netloc.lastIndexOf('@') + 1) : netloc;
  let host = hostPort;
  let portText: string | null = null;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    host = hostPort.slice(1, close);
    const after = hostPort.slice(close + 1);
    if (after.startsWith(':')) portText = after.slice(1);
  } else if (hostPort.includes(':')) {
    const idx = hostPort.indexOf(':');
    host = hostPort.slice(0, idx);
    portText = hostPort.slice(idx + 1);
  }
  if (portText !== null && portText !== '') {
    if (!/^\d+$/.test(portText)) {
      throw new Error(`Port could not be cast to integer value as ${pyRepr(portText)}`);
    }
    const port = Number(portText);
    if (port < 0 || port > 65535) throw new Error('Port out of range 0-65535');
  }
  const hostname = host ? host.toLowerCase() : null;
  return { scheme, hostname };
}

// ============================================================================
// Response helpers
// ============================================================================

interface ResponseLike {
  geturl?: () => string;
  url?: string;
  getheader?: (name: string) => string | null | undefined;
  headers?: { get?: (name: string) => string | null };
  close?: () => void;
}

function responseFinalUrl(resp: unknown, fallback: string): string {
  const r = resp as ResponseLike;
  if (r && typeof r.geturl === 'function') return r.geturl();
  if (r && typeof r.url === 'string' && r.url) return r.url;
  return fallback;
}

function responseContentType(resp: unknown): string | null {
  const r = resp as ResponseLike;
  if (r && typeof r.getheader === 'function') return r.getheader('Content-Type') ?? null;
  if (r && r.headers && typeof r.headers.get === 'function') return r.headers.get('Content-Type');
  return null;
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Python ``int(value)`` for YAML scalars; null when it would raise. */
function pyIntOrNull(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const t = value.trim().replace(/_/g, '');
    if (/^[+-]?\d+$/.test(t)) return Number.parseInt(t, 10);
    return null;
  }
  return null;
}

// ============================================================================
// PresetCatalogEntry
// ============================================================================

/** Represents a single entry in the preset catalog stack. */
export class PresetCatalogEntry {
  url: string;
  name: string;
  priority: number;
  install_allowed: boolean;
  description: string;

  constructor(init: {
    url: string;
    name: string;
    priority: number;
    install_allowed: boolean;
    description?: string;
  }) {
    this.url = init.url;
    this.name = init.name;
    this.priority = init.priority;
    this.install_allowed = init.install_allowed;
    this.description = init.description ?? '';
  }

  /** camelCase accessor for {@link install_allowed}. */
  get installAllowed(): boolean {
    return this.install_allowed;
  }
}

/** Merged catalog pack record (catalog fields plus ``_catalog_name`` / ``_install_allowed``). */
export type PresetCatalogPack = Record<string, any>;

// ============================================================================
// PresetCatalog
// ============================================================================

/**
 * Manages preset catalog fetching, caching, and searching. Supports
 * multi-catalog stacks with priority-based resolution.
 */
export class PresetCatalog {
  static readonly DEFAULT_CATALOG_URL =
    'https://raw.githubusercontent.com/github/spec-kit/main/presets/catalog.json';
  static readonly COMMUNITY_CATALOG_URL =
    'https://raw.githubusercontent.com/github/spec-kit/main/presets/catalog.community.json';
  static readonly CACHE_DURATION = 3600; // 1 hour in seconds

  readonly projectRoot: string;
  readonly presetsDir: string;
  readonly cacheDir: string;
  readonly cacheFile: string;
  readonly cacheMetadataFile: string;
  private nonDefaultCatalogWarningShown = false;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.presetsDir = nodePath.join(projectRoot, '.specify', 'presets');
    this.cacheDir = nodePath.join(this.presetsDir, '.cache');
    this.cacheFile = nodePath.join(this.cacheDir, 'catalog.json');
    this.cacheMetadataFile = nodePath.join(this.cacheDir, 'catalog-metadata.json');
  }

  /**
   * Validate that a catalog URL uses HTTPS (localhost HTTP allowed).
   *
   * @throws PresetValidationError If URL is invalid or uses non-HTTPS scheme
   */
  validateCatalogUrl(url: string): void {
    let parsed: ParsedUrlLite;
    try {
      parsed = parseUrlStrict(url);
    } catch {
      throw new PresetValidationError(`Catalog URL is malformed: ${url}`);
    }
    const hostname = parsed.hostname;
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (parsed.scheme !== 'https' && !(parsed.scheme === 'http' && isLocalhost)) {
      throw new PresetValidationError(
        `Catalog URL must use HTTPS (got ${parsed.scheme}://). HTTP is only allowed for localhost.`,
      );
    }
    if (!hostname) {
      throw new PresetValidationError('Catalog URL must be a valid URL with a host.');
    }
  }

  /** Upstream-name alias of {@link validateCatalogUrl}. */
  _validateCatalogUrl(url: string): void {
    this.validateCatalogUrl(url);
  }

  /** Open a URL with provider-based auth (delegates to ``authentication/http``). */
  openUrl(
    url: string,
    timeout = 10,
    extraHeaders: Record<string, string> | null = null,
    redirectValidator: ((oldUrl: string, newUrl: string) => void) | null = null,
  ): Promise<unknown> {
    return openUrl(url, {
      timeout,
      extraHeaders: extraHeaders ?? undefined,
      redirectValidator: redirectValidator ?? undefined,
    });
  }

  /** Resolve a GitHub release asset URL to its REST API asset URL. */
  async resolveGithubReleaseAssetApiUrl(downloadUrl: string, timeout = 60): Promise<string | null> {
    const resolved = await resolveGithubReleaseAssetApiUrl(
      downloadUrl,
      (u, o) =>
        this.openUrl(u, o.timeout ?? timeout, null, o.redirectValidator ?? null) as ReturnType<
          Parameters<typeof resolveGithubReleaseAssetApiUrl>[1]
        >,
      { timeout, githubHosts: githubProviderHosts() },
    );
    return (resolved as string | null | undefined) ?? null;
  }

  /**
   * Validate a parsed preset-catalog payload's shape (applied to both network
   * and cache payloads).
   *
   * @throws PresetError If the payload's shape is invalid.
   */
  validateCatalogPayload(catalogData: unknown, url: string): void {
    if (!isMapping(catalogData)) {
      throw new PresetError(`Invalid preset catalog format from ${url}: expected a JSON object`);
    }
    if (!('schema_version' in catalogData) || !('presets' in catalogData)) {
      throw new PresetError(`Invalid preset catalog format from ${url}`);
    }
    if (!isMapping(catalogData.presets)) {
      throw new PresetError(`Invalid preset catalog format from ${url}: 'presets' must be a JSON object`);
    }
  }

  /**
   * Load catalog stack configuration from a YAML file. Returns null if the
   * file doesn't exist or contains no valid catalog entries.
   *
   * @throws PresetValidationError for unreadable files, invalid shapes, URLs or priorities
   */
  loadCatalogConfig(configPath: string): PresetCatalogEntry[] | null {
    if (!pathExists(configPath)) return null;
    let data: unknown;
    try {
      data = parseYaml(readTextStrict(configPath));
    } catch (e) {
      throw new PresetValidationError(`Failed to read catalog config ${configPath}: ${errorText(e)}`);
    }
    if (data === null || data === undefined) return null;
    if (!isMapping(data)) {
      throw new PresetValidationError(
        `Invalid catalog config ${configPath}: expected a mapping at root, got ${pyTypeName(data)}`,
      );
    }
    const catalogsData = 'catalogs' in data ? data.catalogs : null;
    if (catalogsData === null || catalogsData === undefined) return null;
    if (!Array.isArray(catalogsData)) {
      throw new PresetValidationError(
        `Invalid catalog config: 'catalogs' must be a list, got ${pyTypeName(catalogsData)}`,
      );
    }
    if (!catalogsData.length) return null;
    const entries: PresetCatalogEntry[] = [];
    catalogsData.forEach((item, idx) => {
      if (!isMapping(item)) {
        throw new PresetValidationError(
          `Invalid catalog entry at index ${idx}: expected a mapping, got ${pyTypeName(item)}`,
        );
      }
      const url = pyStr('url' in item ? item.url : '').trim();
      if (!url) return;
      this.validateCatalogUrl(url);
      const rawPriority = 'priority' in item ? item.priority : idx + 1;
      const label = () => pyStr('name' in item ? item.name : idx + 1);
      if (typeof rawPriority === 'boolean') {
        throw new PresetValidationError(
          `Invalid priority for catalog '${label()}': expected integer, got ${pyRepr(rawPriority)}`,
        );
      }
      const priority = pyIntOrNull(rawPriority);
      if (priority === null) {
        throw new PresetValidationError(
          `Invalid priority for catalog '${label()}': expected integer, got ${pyRepr(rawPriority)}`,
        );
      }
      const rawInstall = 'install_allowed' in item ? item.install_allowed : false;
      const installAllowed =
        typeof rawInstall === 'string'
          ? ['true', 'yes', '1'].includes(rawInstall.trim().toLowerCase())
          : pyTruthy(rawInstall);
      const rawName = item.name;
      let name = rawName !== null && rawName !== undefined ? pyStr(rawName).trim() : '';
      if (!name) name = `catalog-${entries.length + 1}`;
      entries.push(
        new PresetCatalogEntry({
          url,
          name,
          priority,
          install_allowed: installAllowed,
          description: pyStr('description' in item ? item.description : ''),
        }),
      );
    });
    entries.sort((a, b) => a.priority - b.priority);
    return entries.length ? entries : null;
  }

  /** Upstream-name alias of {@link loadCatalogConfig}. */
  _loadCatalogConfig(configPath: string): PresetCatalogEntry[] | null {
    return this.loadCatalogConfig(configPath);
  }

  /**
   * Get the ordered list of active preset catalogs:
   * 1. SPECKIT_PRESET_CATALOG_URL env var — single catalog replacing all defaults
   * 2. Project-level .specify/preset-catalogs.yml
   * 3. User-level ~/.specify/preset-catalogs.yml
   * 4. Built-in default stack (default + community)
   */
  getActiveCatalogs(): PresetCatalogEntry[] {
    const envValue = process.env.SPECKIT_PRESET_CATALOG_URL;
    if (envValue) {
      const catalogUrl = envValue.trim();
      this.validateCatalogUrl(catalogUrl);
      if (catalogUrl !== PresetCatalog.DEFAULT_CATALOG_URL) {
        if (!this.nonDefaultCatalogWarningShown) {
          process.stderr.write(
            'Warning: Using non-default preset catalog. Only use catalogs from sources you trust.\n',
          );
          this.nonDefaultCatalogWarningShown = true;
        }
      }
      return [
        new PresetCatalogEntry({
          url: catalogUrl,
          name: 'custom',
          priority: 1,
          install_allowed: true,
          description: 'Custom catalog via SPECKIT_PRESET_CATALOG_URL',
        }),
      ];
    }

    const projectConfigPath = nodePath.join(this.projectRoot, '.specify', 'preset-catalogs.yml');
    let catalogs = this.loadCatalogConfig(projectConfigPath);
    if (catalogs !== null) return catalogs;

    const userConfigPath = nodePath.join(userHome(), '.specify', 'preset-catalogs.yml');
    catalogs = this.loadCatalogConfig(userConfigPath);
    if (catalogs !== null) return catalogs;

    return [
      new PresetCatalogEntry({
        url: PresetCatalog.DEFAULT_CATALOG_URL,
        name: 'default',
        priority: 1,
        install_allowed: true,
        description: 'Built-in catalog of installable presets',
      }),
      new PresetCatalogEntry({
        url: PresetCatalog.COMMUNITY_CATALOG_URL,
        name: 'community',
        priority: 2,
        install_allowed: false,
        description: 'Community-contributed presets (discovery only)',
      }),
    ];
  }

  /** Get the primary (highest-priority) catalog URL. */
  getCatalogUrl(): string {
    const active = this.getActiveCatalogs();
    return active.length ? active[0].url : PresetCatalog.DEFAULT_CATALOG_URL;
  }

  /** Cache file paths for a catalog URL (legacy names for the default URL). */
  getCachePaths(url: string): [string, string] {
    if (url === PresetCatalog.DEFAULT_CATALOG_URL) return [this.cacheFile, this.cacheMetadataFile];
    const urlHash = createHash('sha256').update(url, 'utf-8').digest('hex').slice(0, 16);
    return [
      nodePath.join(this.cacheDir, `catalog-${urlHash}.json`),
      nodePath.join(this.cacheDir, `catalog-${urlHash}-metadata.json`),
    ];
  }

  private static cacheMetadataFresh(metadataFile: string): boolean {
    try {
      const metadata = JSON.parse(readTextStrict(metadataFile)) as unknown;
      if (!isMapping(metadata)) return false;
      const raw = 'cached_at' in metadata ? metadata.cached_at : '';
      if (typeof raw !== 'string') return false;
      const cachedAt = parsePyIsoformat(raw);
      if (cachedAt === null) return false;
      const ageSeconds = (Date.now() - cachedAt) / 1000;
      return ageSeconds < PresetCatalog.CACHE_DURATION;
    } catch {
      return false;
    }
  }

  /** Check if cached catalog for a specific URL is still valid. */
  isUrlCacheValid(url: string): boolean {
    const [cacheFile, metadataFile] = this.getCachePaths(url);
    if (!pathExists(cacheFile) || !pathExists(metadataFile)) return false;
    return PresetCatalog.cacheMetadataFresh(metadataFile);
  }

  private writeCache(cacheFile: string, metadataFile: string, catalogData: unknown, url: string): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(cacheFile, pyJsonDumps(catalogData, 2), 'utf-8');
      writeFileSync(metadataFile, pyJsonDumps({ cached_at: utcNowIso(), catalog_url: url }, 2), 'utf-8');
    } catch {
      // Cache is best-effort; proceed with fetched data
    }
  }

  private async fetchValidated(url: string): Promise<Record<string, any>> {
    const validateRedirect = (_oldUrl: string, newUrl: string): void => {
      this.validateCatalogUrl(newUrl);
    };
    const response = await this.openUrl(url, 10, null, validateRedirect);
    const finalUrl = responseFinalUrl(response, url);
    if (finalUrl !== url) this.validateCatalogUrl(finalUrl);
    const body = await readResponseLimited(response as Parameters<typeof readResponseLimited>[0], {
      maxBytes: MAX_JSON_CATALOG_BYTES,
      errorType: PresetError,
      label: `preset catalog ${url}`,
    });
    const catalogData = JSON.parse(Buffer.from(body).toString('utf-8')) as unknown;
    this.validateCatalogPayload(catalogData, url);
    return catalogData as Record<string, any>;
  }

  /**
   * Fetch a single catalog with per-URL caching.
   *
   * @throws PresetError If catalog cannot be fetched
   */
  async fetchSingleCatalog(entry: PresetCatalogEntry, forceRefresh = false): Promise<Record<string, any>> {
    const [cacheFile, metadataFile] = this.getCachePaths(entry.url);

    if (!forceRefresh && this.isUrlCacheValid(entry.url)) {
      try {
        const cachedData = JSON.parse(readTextStrict(cacheFile)) as unknown;
        this.validateCatalogPayload(cachedData, entry.url);
        return cachedData as Record<string, any>;
      } catch {
        // Cache is best-effort; fall through to the network fetch path.
      }
    }

    try {
      const catalogData = await this.fetchValidated(entry.url);
      this.writeCache(cacheFile, metadataFile, catalogData, entry.url);
      return catalogData;
    } catch (e) {
      if (e instanceof PresetError) throw e;
      throw new PresetError(`Failed to fetch preset catalog from ${entry.url}: ${errorText(e)}`);
    }
  }

  /**
   * Fetch and merge presets from all active catalogs. Higher-priority catalogs
   * (lower priority number) win on ID conflicts.
   */
  async getMergedPacks(forceRefresh = false): Promise<Record<string, PresetCatalogPack>> {
    const activeCatalogs = this.getActiveCatalogs();
    const merged: Record<string, PresetCatalogPack> = {};
    for (const entry of [...activeCatalogs].reverse()) {
      try {
        const data = await this.fetchSingleCatalog(entry, forceRefresh);
        const presets = (data.presets ?? {}) as Record<string, unknown>;
        for (const [packId, packData] of Object.entries(presets)) {
          if (!isMapping(packData)) continue;
          merged[packId] = {
            ...packData,
            _catalog_name: entry.name,
            _install_allowed: entry.install_allowed,
          };
        }
      } catch (e) {
        if (e instanceof PresetError) continue;
        throw e;
      }
    }
    return merged;
  }

  /** Check if the legacy single-URL cache is still valid. */
  isCacheValid(): boolean {
    if (!pathExists(this.cacheFile) || !pathExists(this.cacheMetadataFile)) return false;
    return PresetCatalog.cacheMetadataFresh(this.cacheMetadataFile);
  }

  /**
   * Fetch the primary preset catalog from URL or cache.
   *
   * @throws PresetError If catalog cannot be fetched
   */
  async fetchCatalog(forceRefresh = false): Promise<Record<string, any>> {
    const catalogUrl = this.getCatalogUrl();

    if (!forceRefresh && this.isCacheValid()) {
      try {
        const metadata = JSON.parse(readTextStrict(this.cacheMetadataFile)) as unknown;
        if (isMapping(metadata) && metadata.catalog_url === catalogUrl) {
          const cachedData = JSON.parse(readTextStrict(this.cacheFile)) as unknown;
          this.validateCatalogPayload(cachedData, catalogUrl);
          return cachedData as Record<string, any>;
        }
      } catch {
        // Cache is corrupt, unreadable, or fails the shape check.
      }
    }

    try {
      const catalogData = await this.fetchValidated(catalogUrl);
      this.writeCache(this.cacheFile, this.cacheMetadataFile, catalogData, catalogUrl);
      return catalogData;
    } catch (e) {
      if (e instanceof PresetError) throw e;
      throw new PresetError(`Failed to fetch preset catalog from ${catalogUrl}: ${errorText(e)}`);
    }
  }

  /**
   * Search all active catalogs (merged by priority) for presets.
   *
   * @param query Search query (searches name, description, id, tags)
   * @param tag Filter by specific tag
   * @param author Filter by author name
   */
  async search(
    opts: { query?: string | null; tag?: string | null; author?: string | null } = {},
  ): Promise<PresetCatalogPack[]> {
    const { query, tag, author } = opts;
    let packs: Record<string, PresetCatalogPack>;
    try {
      packs = await this.getMergedPacks();
    } catch (e) {
      if (e instanceof PresetError) return [];
      throw e;
    }

    const results: PresetCatalogPack[] = [];
    for (const [packId, packData] of Object.entries(packs)) {
      if (author) {
        let authorVal: unknown = 'author' in packData ? packData.author : '';
        if (typeof authorVal !== 'string') {
          authorVal = authorVal !== null && authorVal !== undefined ? pyStr(authorVal) : '';
        }
        if ((authorVal as string).toLowerCase() !== author.toLowerCase()) continue;
      }

      if (tag) {
        const rawTags = 'tags' in packData ? packData.tags : [];
        const tagsList: unknown[] = Array.isArray(rawTags) ? rawTags : [];
        if (!tagsList.map((t) => pyStr(t).toLowerCase()).includes(tag.toLowerCase())) continue;
      }

      if (query) {
        const queryLower = query.toLowerCase();
        const rawTags = 'tags' in packData ? packData.tags : [];
        const tagsList: unknown[] = Array.isArray(rawTags) ? rawTags : [];
        const nameVal = 'name' in packData ? packData.name : '';
        const descVal = 'description' in packData ? packData.description : '';
        const searchableText = [
          nameVal !== null && nameVal !== undefined ? pyStr(nameVal) : '',
          descVal !== null && descVal !== undefined ? pyStr(descVal) : '',
          packId,
          ...tagsList.map((t) => pyStr(t)),
        ]
          .join(' ')
          .toLowerCase();
        if (!searchableText.includes(queryLower)) continue;
      }

      results.push({ ...packData, id: packId });
    }
    return results;
  }

  /** Get detailed information about a specific preset across all active catalogs. */
  async getPackInfo(packId: string): Promise<PresetCatalogPack | null> {
    let packs: Record<string, PresetCatalogPack>;
    try {
      packs = await this.getMergedPacks();
    } catch (e) {
      if (e instanceof PresetError) return null;
      throw e;
    }
    if (Object.prototype.hasOwnProperty.call(packs, packId)) return { ...packs[packId], id: packId };
    return null;
  }

  /**
   * Download a preset archive from a catalog.
   *
   * @returns Path to the downloaded archive
   * @throws PresetError If pack not found or download fails
   */
  async downloadPack(packId: string, targetDir: string | null = null): Promise<string> {
    const packInfo = await this.getPackInfo(packId);
    if (!packInfo) {
      throw new PresetError(`Preset '${packId}' not found in catalog`);
    }

    if (pyTruthy(packInfo.bundled) && !pyTruthy(packInfo.download_url)) {
      throw new PresetError(
        `Preset '${packId}' is bundled with spec-kit and has no download URL. ` +
          `It should be installed from the local package. ` +
          `Use 'specify preset add ${packId}' to install from the bundled package, ` +
          `or reinstall spec-kit if the bundled files are missing: ${REINSTALL_COMMAND}`,
      );
    }

    if (!pyTruthy('_install_allowed' in packInfo ? packInfo._install_allowed : true)) {
      const catalogName = '_catalog_name' in packInfo ? packInfo._catalog_name : 'unknown';
      throw new PresetError(
        `Preset '${packId}' is from the '${pyStr(catalogName)}' catalog which does not allow installation. ` +
          `Use --from with the preset's repository URL instead.`,
      );
    }

    let downloadUrl: unknown = packInfo.download_url;
    if (!pyTruthy(downloadUrl)) {
      throw new PresetError(`Preset '${packId}' has no download URL`);
    }
    if (typeof downloadUrl !== 'string') {
      throw new PresetError(`Preset download URL is malformed: ${pyStr(downloadUrl)}`);
    }

    let parsed: ParsedUrlLite;
    try {
      parsed = parseUrlStrict(downloadUrl);
    } catch {
      throw new PresetError(`Preset download URL is malformed: ${downloadUrl}`);
    }
    if (!parsed.hostname) {
      throw new PresetError(`Preset download URL is malformed: ${downloadUrl}`);
    }
    if (!isHttpsOrLocalhostHttp(downloadUrl)) {
      throw new PresetError(`Preset download URL must use HTTPS: ${downloadUrl}`);
    }

    const target = targetDir ?? nodePath.join(this.cacheDir, 'downloads');
    const version = pyStr('version' in packInfo ? packInfo.version : 'unknown');
    const declaredFormat = archiveFormatFromName(downloadUrl);
    buildSafeDownloadPath(target, packId, version, {
      errorType: PresetError,
      label: 'preset',
      suffix: archiveSuffix(declaredFormat ?? 'tar.gz'),
    });
    mkdirSync(target, { recursive: true });

    const originalDownloadUrl = downloadUrl;
    let extraHeaders: Record<string, string> | null = null;
    const resolvedDownloadUrl = await this.resolveGithubReleaseAssetApiUrl(downloadUrl);
    if (resolvedDownloadUrl) {
      downloadUrl = resolvedDownloadUrl;
      extraHeaders = { Accept: 'application/octet-stream' };
    }
    const effectiveUrl = downloadUrl as string;

    let stagingPath: string | null = null;
    try {
      let archiveData: Uint8Array;
      let finalUrl: string;
      let contentType: string | null;
      try {
        const response = await this.openUrl(effectiveUrl, 60, extraHeaders);
        archiveData = await readResponseLimited(response as Parameters<typeof readResponseLimited>[0], {
          errorType: PresetError,
          label: `preset '${packId}' download`,
        });
        finalUrl = responseFinalUrl(response, effectiveUrl);
        contentType = responseContentType(response);
      } catch (e) {
        if (e instanceof PresetError) throw e;
        throw new PresetError(`Failed to download preset from ${effectiveUrl}: ${errorText(e)}`);
      }

      verifyArchiveSha256(
        archiveData,
        ('sha256' in packInfo ? packInfo.sha256 : null) as string | null,
        packId,
        PresetError,
      );

      try {
        stagingPath = nodePath.join(target, `preset-download-${randomBytes(6).toString('hex')}.archive`);
        writeFileSync(stagingPath, archiveData, { flag: 'wx' });
      } catch (e) {
        throw new PresetError(`Failed to save preset archive: ${errorText(e)}`);
      }
      const archiveFormat = detectArchiveFormat(stagingPath, {
        sourceName: archiveFormatFromName(finalUrl) !== null ? finalUrl : originalDownloadUrl,
        contentType,
        errorType: PresetError,
      });
      const archivePath = buildSafeDownloadPath(target, packId, version, {
        errorType: PresetError,
        label: 'preset',
        suffix: archiveSuffix(archiveFormat),
      });
      try {
        renameSync(stagingPath, archivePath);
      } catch (e) {
        throw new PresetError(`Failed to save preset archive: ${errorText(e)}`);
      }
      stagingPath = null;
      return archivePath;
    } finally {
      if (stagingPath !== null) {
        try {
          unlinkSync(stagingPath);
        } catch {
          // missing_ok
        }
      }
    }
  }

  /** Clear all catalog cache files, including per-URL hashed caches. */
  clearCache(): void {
    if (!pathExists(this.cacheDir)) return;
    for (const name of readdirSync(this.cacheDir)) {
      const f = nodePath.join(this.cacheDir, name);
      if (isFile(f) && name.startsWith('catalog')) {
        try {
          unlinkSync(f);
        } catch {
          // missing_ok
        }
      }
    }
  }
}

/**
 * Parse a Python ``datetime.isoformat()`` string to epoch millis (naive values
 * are treated as UTC). Returns null for unparseable input (``ValueError``).
 */
export function parsePyIsoformat(value: string): number | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?)?(Z|[+-]\d{2}:?\d{2}(?::?\d{2})?)?$/.exec(
      value,
    );
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = '0', tz] = m;
  const ms = Number((frac + '000000').slice(0, 6)) / 1000;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  if (Number.isNaN(t)) return null;
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(/:/g, '');
    const offMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
    t -= sign * offMin * 60 * 1000;
  }
  return t;
}

