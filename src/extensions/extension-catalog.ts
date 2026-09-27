/**
 * @oakoliver/specify-cli - Extension catalog stack
 *
 * Port of ``ExtensionCatalog`` (and the ``CatalogStackBase`` primitives it
 * inherits) from ``specify_cli/extensions/__init__.py`` /
 * ``specify_cli/catalogs.py``: multi-catalog resolution (env var → project
 * config → user config → built-in defaults), per-URL caching, merged search
 * and archive downloads.
 *
 * Network-touching methods are ``async`` (global ``fetch`` is asynchronous);
 * behavior otherwise mirrors upstream.
 *
 * @module extensions/extension-catalog
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { githubProviderHosts, openUrl } from '../authentication/http.js';
import { resolveGithubReleaseAssetApiUrl } from '../authentication/github-http.js';
import {
  MAX_JSON_CATALOG_BYTES,
  archiveFormatFromName,
  archiveSuffix,
  buildSafeDownloadPath,
  detectArchiveFormat,
  isHttpsOrLocalhostHttp,
  readResponseLimited,
} from '../download-security.js';
import { verifyArchiveSha256 } from '../shared-infra.js';
import { parseYaml } from '../yaml.js';
import { pyJsonDumps, pyRepr, pyTypeName, urlHostname, urlparse, urlPort } from '../bundles/pycompat.js';
import { decodeUtf8Strict, exists, parseIsoformat, pyInt, readTextUtf8, utcNowIsoformat } from './compat.js';
import { ExtensionError, ValidationError } from './errors.js';
import { unlink } from './fs-utils.js';
import { type CatalogEntry, type Dict, REINSTALL_COMMAND, isMapping } from './manifest.js';

/** Redirect validator invoked before each redirect hop. */
export type RedirectValidator = (oldUrl: string, newUrl: string) => void;

/** Options accepted by {@link ExtensionCatalog.openUrl}. */
export interface OpenUrlOptions {
  timeout?: number;
  extraHeaders?: Record<string, string> | null;
  redirectValidator?: RedirectValidator | null;
}

interface ResponseLike {
  geturl?: () => string;
  url?: string;
  getheader?: (name: string) => string | null | undefined;
  headers?: { get?: (name: string) => string | null };
}

/** Search filters for {@link ExtensionCatalog.search}. */
export interface CatalogSearchOptions {
  query?: string | null;
  tag?: string | null;
  author?: string | null;
  verifiedOnly?: boolean;
}

/** Manages extension catalog fetching, caching, and searching. */
export class ExtensionCatalog {
  static readonly DEFAULT_CATALOG_URL =
    'https://raw.githubusercontent.com/github/spec-kit/main/extensions/catalog.json';
  static readonly COMMUNITY_CATALOG_URL =
    'https://raw.githubusercontent.com/github/spec-kit/main/extensions/catalog.community.json';
  static readonly CACHE_DURATION = 3600; // 1 hour in seconds
  static readonly CONFIG_FILENAME = 'extension-catalogs.yml';

  readonly projectRoot: string;
  readonly extensionsDir: string;
  readonly cacheDir: string;
  readonly cacheFile: string;
  readonly cacheMetadataFile: string;
  private nonDefaultCatalogWarningShown = false;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.extensionsDir = join(projectRoot, '.specify', 'extensions');
    this.cacheDir = join(this.extensionsDir, '.cache');
    this.cacheFile = join(this.cacheDir, 'catalog.json');
    this.cacheMetadataFile = join(this.cacheDir, 'catalog-metadata.json');
  }

  // ==========================================================================
  // CatalogStackBase primitives
  // ==========================================================================

  /** Build a catalog entry. */
  static entry(opts: {
    url: string;
    name: string;
    priority: number;
    install_allowed: boolean;
    description?: string;
  }): CatalogEntry {
    return {
      url: opts.url,
      name: opts.name,
      priority: opts.priority,
      install_allowed: opts.install_allowed,
      description: opts.description ?? '',
    };
  }

  /** Validate that a catalog URL uses HTTPS, except localhost HTTP. */
  static validateCatalogUrl(url: string): void {
    let parsed;
    let hostname: string | null;
    try {
      parsed = urlparse(url);
      hostname = urlHostname(parsed);
      urlPort(parsed);
    } catch {
      throw new ValidationError(`Catalog URL is malformed: ${url}`);
    }
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (parsed.scheme !== 'https' && !(parsed.scheme === 'http' && isLocalhost)) {
      throw new ValidationError(
        `Catalog URL must use HTTPS (got ${parsed.scheme}://). HTTP is only allowed for localhost.`,
      );
    }
    if (!hostname) throw new ValidationError('Catalog URL must be a valid URL with a host.');
  }

  /** Instance alias of {@link ExtensionCatalog.validateCatalogUrl}. */
  validateCatalogUrl(url: string): void {
    ExtensionCatalog.validateCatalogUrl(url);
  }

  /**
   * Load catalog stack configuration from a YAML file. Returns ``null`` when
   * the file does not exist; existing files fail closed when malformed.
   */
  loadCatalogConfig(configPath: string): CatalogEntry[] | null {
    if (!exists(configPath)) return null;
    let data: unknown;
    try {
      data = parseYaml(readTextUtf8(configPath));
    } catch (exc) {
      throw new ValidationError(`Failed to read catalog config ${configPath}: ${(exc as Error).message}`, {
        cause: exc,
      });
    }
    if (data === null || data === undefined) data = {};
    if (!isMapping(data)) {
      throw new ValidationError(`Invalid catalog config ${configPath}: expected a YAML mapping at the root`);
    }
    const catalogsData = Object.prototype.hasOwnProperty.call(data, 'catalogs') ? data.catalogs : [];
    if (!Array.isArray(catalogsData)) {
      throw new ValidationError(
        `Invalid catalog config ${configPath}: 'catalogs' must be a list, got ${pyTypeName(catalogsData)}`,
      );
    }
    if (!catalogsData.length) {
      throw new ValidationError(
        `Catalog config ${configPath} exists but contains no 'catalogs' entries. ` +
          'Remove the file to use built-in defaults, or add valid catalog entries.',
      );
    }

    const entries: CatalogEntry[] = [];
    const skipped: number[] = [];
    catalogsData.forEach((item: unknown, idx: number) => {
      if (!isMapping(item)) {
        throw new ValidationError(
          `Invalid catalog config ${configPath}: catalog entry at index ${idx}: ` +
            `expected a mapping, got ${pyTypeName(item)}`,
        );
      }
      const rawUrl = Object.prototype.hasOwnProperty.call(item, 'url') ? item.url : '';
      const url = pyStrLoose(rawUrl).trim();
      if (!url) {
        skipped.push(idx);
        return;
      }
      try {
        ExtensionCatalog.validateCatalogUrl(url);
      } catch (exc) {
        throw new ValidationError(
          `Invalid catalog URL in ${configPath} at index ${idx}: ${(exc as Error).message}`,
          { cause: exc },
        );
      }

      const rawPriority = Object.prototype.hasOwnProperty.call(item, 'priority') ? item.priority : idx + 1;
      const nameForError = Object.prototype.hasOwnProperty.call(item, 'name') ? pyStrLoose(item.name) : String(idx + 1);
      const priority = typeof rawPriority === 'boolean' ? null : pyInt(rawPriority);
      if (priority === null) {
        throw new ValidationError(
          `Invalid catalog config ${configPath}: ` +
            `Invalid priority for catalog '${nameForError}': ` +
            `expected integer, got ${pyRepr(rawPriority)}`,
        );
      }

      const rawInstall = Object.prototype.hasOwnProperty.call(item, 'install_allowed') ? item.install_allowed : false;
      const installAllowed =
        typeof rawInstall === 'string'
          ? ['true', 'yes', '1'].includes(rawInstall.trim().toLowerCase())
          : truthyLoose(rawInstall);

      const rawName = item.name;
      let name = rawName !== null && rawName !== undefined ? pyStrLoose(rawName).trim() : '';
      if (!name) name = `catalog-${entries.length + 1}`;

      entries.push(
        ExtensionCatalog.entry({
          url,
          name,
          priority,
          install_allowed: installAllowed,
          description: pyStrLoose(Object.prototype.hasOwnProperty.call(item, 'description') ? item.description : ''),
        }),
      );
    });

    entries.sort((a, b) => a.priority - b.priority);
    if (!entries.length) {
      throw new ValidationError(
        `Catalog config ${configPath} contains ${catalogsData.length} ` +
          `entries but none have valid URLs (entries at indices ${pyRepr(skipped)} ` +
          "were skipped). Each catalog entry must have a 'url' field.",
      );
    }
    return entries;
  }

  // ==========================================================================
  // Network helpers
  // ==========================================================================

  /** Open a URL with provider-based auth (delegates to ``authentication/http``). */
  openUrl(url: string, opts: OpenUrlOptions = {}): Promise<unknown> {
    return openUrl(url, {
      timeout: opts.timeout ?? 10,
      extraHeaders: opts.extraHeaders ?? undefined,
      redirectValidator: opts.redirectValidator ?? undefined,
    });
  }

  /** Resolve a GitHub release asset URL to its REST API asset URL. */
  async resolveGithubReleaseAssetApiUrl(downloadUrl: string, timeout = 60): Promise<string | null> {
    const resolved = await resolveGithubReleaseAssetApiUrl(
      downloadUrl,
      (u, o) =>
        this.openUrl(u, { timeout: o.timeout ?? timeout, redirectValidator: o.redirectValidator ?? null }) as never,
      { timeout, githubHosts: githubProviderHosts() },
    );
    return (resolved as string | null | undefined) ?? null;
  }

  /** Final URL of a response (``response.geturl()``). */
  static responseUrl(resp: unknown, fallback: string): string {
    const r = resp as ResponseLike | null;
    if (r && typeof r.geturl === 'function') return r.geturl();
    if (r && typeof r.url === 'string' && r.url) return r.url;
    return fallback;
  }

  /** A response header (``response.getheader(name)``). */
  static responseHeader(resp: unknown, name: string): string | null {
    const r = resp as ResponseLike | null;
    if (r && typeof r.getheader === 'function') return r.getheader(name) ?? null;
    if (r && r.headers && typeof r.headers.get === 'function') return r.headers.get(name) ?? null;
    return null;
  }

  /** ``str(URLError)``-like text for a network failure. */
  static urlErrorText(exc: unknown): string {
    if (exc instanceof Error) return exc.message;
    return String(exc);
  }

  /** Validate a parsed catalog payload's shape. */
  validateCatalogPayload(catalogData: unknown, url: string): void {
    if (!isMapping(catalogData)) {
      throw new ExtensionError(`Invalid catalog format from ${url}: expected a JSON object`);
    }
    if (!('schema_version' in catalogData) || !('extensions' in catalogData)) {
      throw new ExtensionError(`Invalid catalog format from ${url}`);
    }
    if (!isMapping(catalogData.extensions)) {
      throw new ExtensionError(`Invalid catalog format from ${url}: 'extensions' must be a JSON object`);
    }
  }

  // ==========================================================================
  // Active catalogs
  // ==========================================================================

  /**
   * Ordered list of active catalogs:
   * 1. SPECKIT_CATALOG_URL env var — single catalog replacing all defaults
   * 2. Project-level .specify/extension-catalogs.yml
   * 3. User-level ~/.specify/extension-catalogs.yml
   * 4. Built-in default stack (default + community)
   */
  getActiveCatalogs(): CatalogEntry[] {
    const envValue = process.env.SPECKIT_CATALOG_URL;
    if (envValue) {
      const catalogUrl = envValue.trim();
      ExtensionCatalog.validateCatalogUrl(catalogUrl);
      if (catalogUrl !== ExtensionCatalog.DEFAULT_CATALOG_URL && !this.nonDefaultCatalogWarningShown) {
        process.stderr.write(
          'Warning: Using non-default extension catalog. Only use catalogs from sources you trust.\n',
        );
        this.nonDefaultCatalogWarningShown = true;
      }
      return [
        ExtensionCatalog.entry({
          url: catalogUrl,
          name: 'custom',
          priority: 1,
          install_allowed: true,
          description: 'Custom catalog via SPECKIT_CATALOG_URL',
        }),
      ];
    }

    const projectConfigPath = join(this.projectRoot, '.specify', ExtensionCatalog.CONFIG_FILENAME);
    let catalogs = this.loadCatalogConfig(projectConfigPath);
    if (catalogs !== null) return catalogs;

    const userConfigPath = join(homedir(), '.specify', ExtensionCatalog.CONFIG_FILENAME);
    catalogs = this.loadCatalogConfig(userConfigPath);
    if (catalogs !== null) return catalogs;

    return [
      ExtensionCatalog.entry({
        url: ExtensionCatalog.DEFAULT_CATALOG_URL,
        name: 'default',
        priority: 1,
        install_allowed: true,
        description: 'Built-in catalog of installable extensions',
      }),
      ExtensionCatalog.entry({
        url: ExtensionCatalog.COMMUNITY_CATALOG_URL,
        name: 'community',
        priority: 2,
        install_allowed: false,
        description: 'Community-contributed extensions (discovery only)',
      }),
    ];
  }

  /** URL of the highest-priority catalog (backward compatibility). */
  getCatalogUrl(): string {
    const active = this.getActiveCatalogs();
    return active.length ? active[0].url : ExtensionCatalog.DEFAULT_CATALOG_URL;
  }

  private static metadataFresh(metadataFile: string): boolean {
    try {
      const metadata: unknown = JSON.parse(readTextUtf8(metadataFile));
      if (!isMapping(metadata)) return false;
      const cachedAt = parseIsoformat(Object.prototype.hasOwnProperty.call(metadata, 'cached_at') ? metadata.cached_at : '');
      if (cachedAt === null) return false;
      const age = (Date.now() - cachedAt.getTime()) / 1000;
      return age < ExtensionCatalog.CACHE_DURATION;
    } catch {
      return false;
    }
  }

  private async fetchValidated(url: string): Promise<Dict> {
    const validateRedirect: RedirectValidator = (_oldUrl, newUrl) => {
      ExtensionCatalog.validateCatalogUrl(newUrl);
    };
    let body: Uint8Array;
    try {
      const response = await this.openUrl(url, { timeout: 10, redirectValidator: validateRedirect });
      const finalUrl = ExtensionCatalog.responseUrl(response, url);
      if (finalUrl !== url) ExtensionCatalog.validateCatalogUrl(finalUrl);
      body = await readResponseLimited(response as never, {
        maxBytes: MAX_JSON_CATALOG_BYTES,
        errorType: ExtensionError,
        label: `extension catalog ${url}`,
      });
    } catch (exc) {
      if (exc instanceof ExtensionError) throw exc;
      throw new ExtensionError(`Failed to fetch catalog from ${url}: ${ExtensionCatalog.urlErrorText(exc)}`, {
        cause: exc,
      });
    }
    let catalogData: unknown;
    try {
      catalogData = JSON.parse(decodeUtf8Strict(body));
    } catch (exc) {
      throw new ExtensionError(`Invalid JSON in catalog from ${url}: ${(exc as Error).message}`, { cause: exc });
    }
    this.validateCatalogPayload(catalogData, url);
    return catalogData as Dict;
  }

  private writeCache(cacheFile: string, metaFile: string, catalogData: Dict, url: string): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(cacheFile, pyJsonDumps(catalogData), 'utf-8');
      writeFileSync(metaFile, pyJsonDumps({ cached_at: utcNowIsoformat(), catalog_url: url }), 'utf-8');
    } catch {
      // Cache is best-effort; proceed with fetched data
    }
  }

  /** Fetch a single catalog with per-URL caching. */
  async fetchSingleCatalog(entry: CatalogEntry, forceRefresh = false): Promise<Dict> {
    let cacheFile: string;
    let cacheMetaFile: string;
    let isValid: boolean;
    if (entry.url === ExtensionCatalog.DEFAULT_CATALOG_URL) {
      cacheFile = this.cacheFile;
      cacheMetaFile = this.cacheMetadataFile;
      isValid = !forceRefresh && this.isCacheValid();
    } else {
      const urlHash = createHash('sha256').update(entry.url).digest('hex').slice(0, 16);
      cacheFile = join(this.cacheDir, `catalog-${urlHash}.json`);
      cacheMetaFile = join(this.cacheDir, `catalog-${urlHash}-metadata.json`);
      isValid = !forceRefresh && exists(cacheFile) && exists(cacheMetaFile) && ExtensionCatalog.metadataFresh(cacheMetaFile);
    }

    if (isValid) {
      try {
        const cachedData: unknown = JSON.parse(readTextUtf8(cacheFile));
        this.validateCatalogPayload(cachedData, entry.url);
        return cachedData as Dict;
      } catch {
        // Cache is best-effort; fall through to the network fetch path.
      }
    }

    const catalogData = await this.fetchValidated(entry.url);
    this.writeCache(cacheFile, cacheMetaFile, catalogData, entry.url);
    return catalogData;
  }

  /**
   * Fetch and merge extensions from all active catalogs. Higher-priority
   * catalogs win on conflicts. Throws only if ALL catalogs fail.
   */
  async getMergedExtensions(forceRefresh = false): Promise<Dict[]> {
    const activeCatalogs = this.getActiveCatalogs();
    const merged = new Map<string, Dict>();
    let anySuccess = false;

    for (const catalogEntry of activeCatalogs) {
      let catalogData: Dict;
      try {
        catalogData = await this.fetchSingleCatalog(catalogEntry, forceRefresh);
        anySuccess = true;
      } catch (exc) {
        if (!(exc instanceof ExtensionError)) throw exc;
        process.stderr.write(`Warning: Could not fetch catalog '${catalogEntry.name}': ${exc.message}\n`);
        continue;
      }
      const exts = isMapping(catalogData.extensions) ? catalogData.extensions : {};
      for (const [extId, extData] of Object.entries(exts)) {
        if (!isMapping(extData)) continue;
        if (!merged.has(extId)) {
          merged.set(extId, {
            ...extData,
            id: extId,
            _catalog_name: catalogEntry.name,
            _install_allowed: catalogEntry.install_allowed,
          });
        }
      }
    }

    if (!anySuccess && activeCatalogs.length) {
      throw new ExtensionError('Failed to fetch any extension catalog');
    }
    return [...merged.values()];
  }

  /** Check if the legacy cached catalog is still valid. */
  isCacheValid(): boolean {
    if (!exists(this.cacheFile) || !exists(this.cacheMetadataFile)) return false;
    return ExtensionCatalog.metadataFresh(this.cacheMetadataFile);
  }

  /** Fetch the primary extension catalog from URL or cache. */
  async fetchCatalog(forceRefresh = false): Promise<Dict> {
    const catalogUrl = this.getCatalogUrl();
    if (!forceRefresh && this.isCacheValid()) {
      try {
        const cachedData: unknown = JSON.parse(readTextUtf8(this.cacheFile));
        this.validateCatalogPayload(cachedData, catalogUrl);
        return cachedData as Dict;
      } catch {
        // Fall through to network fetch
      }
    }
    let catalogData: Dict;
    try {
      catalogData = await this.fetchValidated(catalogUrl);
    } catch (exc) {
      if (exc instanceof ExtensionError && exc.message.startsWith(`Invalid JSON in catalog from ${catalogUrl}: `)) {
        throw new ExtensionError(
          `Invalid JSON in catalog: ${exc.message.slice(`Invalid JSON in catalog from ${catalogUrl}: `.length)}`,
        );
      }
      throw exc;
    }
    this.writeCache(this.cacheFile, this.cacheMetadataFile, catalogData, catalogUrl);
    return catalogData;
  }

  /** Search catalogs for extensions. */
  async search(opts: CatalogSearchOptions = {}): Promise<Dict[]> {
    const allExtensions = await this.getMergedExtensions();
    const results: Dict[] = [];
    for (const extData of allExtensions) {
      const extId: string = extData.id;
      if (opts.verifiedOnly && !truthyLoose(extData.verified ?? false)) continue;

      if (opts.author) {
        let authorVal: unknown = extData.author ?? '';
        if (typeof authorVal !== 'string') authorVal = authorVal !== null && authorVal !== undefined ? pyStrLoose(authorVal) : '';
        if ((authorVal as string).toLowerCase() !== opts.author.toLowerCase()) continue;
      }

      if (opts.tag) {
        const rawTags = extData.tags ?? [];
        const tagsList: unknown[] = Array.isArray(rawTags) ? rawTags : [];
        const lowered = tagsList.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase());
        if (!lowered.includes(opts.tag.toLowerCase())) continue;
      }

      if (opts.query) {
        const queryLower = opts.query.toLowerCase();
        const rawTags = extData.tags ?? [];
        const tagsList: unknown[] = Array.isArray(rawTags) ? rawTags : [];
        const nameVal = extData.name ?? '';
        const descVal = extData.description ?? '';
        const searchable = [
          truthyLoose(nameVal) ? pyStrLoose(nameVal) : '',
          truthyLoose(descVal) ? pyStrLoose(descVal) : '',
          extId,
          ...tagsList.filter((t): t is string => typeof t === 'string'),
        ]
          .join(' ')
          .toLowerCase();
        if (!searchable.includes(queryLower)) continue;
      }
      results.push(extData);
    }
    return results;
  }

  /** Detailed information about a specific extension, or ``null``. */
  async getExtensionInfo(extensionId: string): Promise<Dict | null> {
    for (const extData of await this.getMergedExtensions()) {
      if (extData.id === extensionId) return extData;
    }
    return null;
  }

  /**
   * Download an extension archive from a catalog.
   * @returns Path to the downloaded archive
   */
  async downloadExtension(extensionId: string, targetDir: string | null = null): Promise<string> {
    const extInfo = await this.getExtensionInfo(extensionId);
    if (!extInfo) throw new ExtensionError(`Extension '${extensionId}' not found in catalog`);

    if (truthyLoose(extInfo.bundled) && !truthyLoose(extInfo.download_url)) {
      throw new ExtensionError(
        `Extension '${extensionId}' is bundled with spec-kit and has no download URL. ` +
          'It should be installed from the local package. ' +
          `Try reinstalling: ${REINSTALL_COMMAND}`,
      );
    }

    let downloadUrl: unknown = extInfo.download_url;
    if (!truthyLoose(downloadUrl)) throw new ExtensionError(`Extension '${extensionId}' has no download URL`);
    if (typeof downloadUrl !== 'string') {
      throw new ExtensionError(`Extension download URL is malformed: ${pyStrLoose(downloadUrl)}`);
    }
    let hostname: string | null;
    try {
      const parsed = urlparse(downloadUrl);
      hostname = urlHostname(parsed);
      urlPort(parsed);
    } catch {
      throw new ExtensionError(`Extension download URL is malformed: ${downloadUrl}`);
    }
    if (!hostname) throw new ExtensionError(`Extension download URL is malformed: ${downloadUrl}`);
    if (!isHttpsOrLocalhostHttp(downloadUrl)) {
      throw new ExtensionError(`Extension download URL must use HTTPS: ${downloadUrl}`);
    }

    const target = targetDir ?? join(this.cacheDir, 'downloads');
    const version = Object.prototype.hasOwnProperty.call(extInfo, 'version') ? extInfo.version : 'unknown';
    const declaredFormat = archiveFormatFromName(downloadUrl);
    buildSafeDownloadPath(target, extensionId, version, {
      errorType: ExtensionError,
      label: 'extension',
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
        const response = await this.openUrl(effectiveUrl, { timeout: 60, extraHeaders });
        archiveData = await readResponseLimited(response as never, {
          errorType: ExtensionError,
          label: `extension '${extensionId}' download`,
        });
        finalUrl = ExtensionCatalog.responseUrl(response, effectiveUrl);
        contentType = ExtensionCatalog.responseHeader(response, 'Content-Type');
      } catch (exc) {
        if (exc instanceof ExtensionError) throw exc;
        throw new ExtensionError(
          `Failed to download extension from ${effectiveUrl}: ${ExtensionCatalog.urlErrorText(exc)}`,
          { cause: exc },
        );
      }

      verifyArchiveSha256(
        archiveData,
        (Object.prototype.hasOwnProperty.call(extInfo, 'sha256') ? extInfo.sha256 : null) as string | null,
        extensionId,
        ExtensionError,
      );

      try {
        stagingPath = join(target, `extension-download-${randomBytes(6).toString('hex')}.archive`);
        writeFileSync(stagingPath, archiveData, { flag: 'wx' });
      } catch (exc) {
        throw new ExtensionError(`Failed to save extension archive: ${(exc as Error).message}`);
      }
      const archiveFormat = detectArchiveFormat(stagingPath, {
        sourceName: archiveFormatFromName(finalUrl) !== null ? finalUrl : originalDownloadUrl,
        contentType,
        errorType: ExtensionError,
      });
      const archivePath = buildSafeDownloadPath(target, extensionId, version, {
        errorType: ExtensionError,
        label: 'extension',
        suffix: archiveSuffix(archiveFormat),
      });
      try {
        renameSync(stagingPath, archivePath);
      } catch (exc) {
        throw new ExtensionError(`Failed to save extension archive: ${(exc as Error).message}`);
      }
      stagingPath = null;
      return archivePath;
    } finally {
      if (stagingPath !== null) unlink(stagingPath, true);
    }
  }

  /** Clear the catalog cache (both legacy and URL-hash-based files). */
  clearCache(): void {
    unlink(this.cacheFile, true);
    unlink(this.cacheMetadataFile, true);
    if (exists(this.cacheDir)) {
      let names: string[] = [];
      try {
        names = readdirSync(this.cacheDir);
      } catch {
        names = [];
      }
      for (const name of names) {
        const full = join(this.cacheDir, name);
        if (name.startsWith('catalog-') && name.endsWith('.json') && full !== this.cacheFile) {
          unlink(full, true);
        }
      }
    }
  }
}

function pyStrLoose(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return pyRepr(value);
}

function truthyLoose(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isMapping(value)) return Object.keys(value).length > 0;
  return true;
}
