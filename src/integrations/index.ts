/**
 * @oakoliver/specify-cli - Integration Registry
 *
 * Port of `integrations/__init__.py`: the integration registry
 * (`INTEGRATION_REGISTRY`, `getIntegration`), the integration catalog
 * (`IntegrationCatalog`), and the `integration.yml` descriptor loader
 * (`IntegrationDescriptor`).
 *
 * @module integrations
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { MAX_JSON_METADATA_BYTES, readResponseLimited, urlsplit, urlPort } from '../download-security.js';
import { eventsStaleExclusions, installIntegrationEvents, removeIntegrationEvents } from '../events/index.js';
import { Version } from '../version.js';
import { YAMLError, dumpYaml, isEmptyYamlDocument, parseYaml } from '../yaml.js';
import { IntegrationBase, KeyError, ValueError, pyRepr, setIntegrationEventsBridge, type IntegrationEventsBridge } from './base.js';
import { homeDir, pathParts, pyTypeName, utcIsoNow } from './manifest.js';

import { AgyIntegration } from './agy.js';
import { AlquimiaAIIntegration } from './alquimia.js';
import { AmpIntegration } from './amp.js';
import { AuggieIntegration } from './auggie.js';
import { BobIntegration } from './bob.js';
import { ClaudeIntegration } from './claude.js';
import { ClineIntegration } from './cline.js';
import { CodebuddyIntegration } from './codebuddy.js';
import { CodexIntegration } from './codex.js';
import { CommandCodeIntegration } from './command-code.js';
import { CopilotIntegration } from './copilot.js';
import { CursorAgentIntegration } from './cursor-agent.js';
import { DevinIntegration } from './devin.js';
import { DockerAgentIntegration } from './docker-agent.js';
import { DroidIntegration } from './droid.js';
import { DshIntegration } from './dsh.js';
import { FirebenderIntegration } from './firebender.js';
import { ForgeIntegration } from './forge.js';
import { GeminiIntegration } from './gemini.js';
import { GenericIntegration } from './generic.js';
import { GooseIntegration } from './goose.js';
import { GrokIntegration } from './grok.js';
import { HermesIntegration } from './hermes.js';
import { JunieIntegration } from './junie.js';
import { KilocodeIntegration } from './kilocode.js';
import { KimiIntegration } from './kimi.js';
import { KiroCliIntegration } from './kiro-cli.js';
import { LingmaIntegration } from './lingma.js';
import { MuseIntegration } from './muse.js';
import { OmpIntegration } from './omp.js';
import { OpencodeIntegration } from './opencode.js';
import { PiIntegration } from './pi.js';
import { QodercliIntegration } from './qodercli.js';
import { QwenIntegration } from './qwen.js';
import { RovodevIntegration } from './rovodev.js';
import { ShaiIntegration } from './shai.js';
import { TabnineIntegration } from './tabnine.js';
import { TraeIntegration } from './trae.js';
import { VibeIntegration } from './vibe.js';
import { ZcodeIntegration } from './zcode.js';
import { ZedIntegration } from './zed.js';

export {
  IntegrationBase,
  IntegrationOption,
  MarkdownIntegration,
  SkillsIntegration,
  TomlIntegration,
  YamlIntegration,
} from './base.js';
export { IntegrationManifest } from './manifest.js';
export { AgyIntegration } from './agy.js';
export { AlquimiaAIIntegration } from './alquimia.js';
export { AmpIntegration } from './amp.js';
export { AuggieIntegration } from './auggie.js';
export { BobIntegration } from './bob.js';
export { ClaudeIntegration } from './claude.js';
export { ClineIntegration } from './cline.js';
export { CodebuddyIntegration } from './codebuddy.js';
export { CodexIntegration } from './codex.js';
export { CommandCodeIntegration } from './command-code.js';
export { CopilotIntegration } from './copilot.js';
export { CursorAgentIntegration } from './cursor-agent.js';
export { DevinIntegration } from './devin.js';
export { DockerAgentIntegration } from './docker-agent.js';
export { DroidIntegration } from './droid.js';
export { DshIntegration } from './dsh.js';
export { FirebenderIntegration } from './firebender.js';
export { ForgeIntegration } from './forge.js';
export { GeminiIntegration } from './gemini.js';
export { GenericIntegration } from './generic.js';
export { GooseIntegration } from './goose.js';
export { GrokIntegration } from './grok.js';
export { HermesIntegration } from './hermes.js';
export { JunieIntegration } from './junie.js';
export { KilocodeIntegration } from './kilocode.js';
export { KimiIntegration } from './kimi.js';
export { KiroCliIntegration } from './kiro-cli.js';
export { LingmaIntegration } from './lingma.js';
export { MuseIntegration } from './muse.js';
export { OmpIntegration } from './omp.js';
export { OpencodeIntegration } from './opencode.js';
export { PiIntegration } from './pi.js';
export { QodercliIntegration } from './qodercli.js';
export { QwenIntegration } from './qwen.js';
export { RovodevIntegration } from './rovodev.js';
export { ShaiIntegration } from './shai.js';
export { TabnineIntegration } from './tabnine.js';
export { TraeIntegration } from './trae.js';
export { VibeIntegration } from './vibe.js';
export { ZcodeIntegration } from './zcode.js';
export { ZedIntegration } from './zed.js';

// ============================================================================
// Registry
// ============================================================================

/** Maps integration key → IntegrationBase instance (insertion order = upstream order). */
export const INTEGRATION_REGISTRY: Record<string, IntegrationBase> = {};

/**
 * Register an integration instance in the global registry.
 * Throws {@link ValueError} for empty keys and {@link KeyError} for duplicates.
 */
export function register(integration: IntegrationBase): void {
  const key = integration.key;
  if (!key) throw new ValueError('Cannot register integration with an empty key.');
  if (Object.prototype.hasOwnProperty.call(INTEGRATION_REGISTRY, key)) {
    throw new KeyError(`Integration with key '${key}' is already registered.`);
  }
  INTEGRATION_REGISTRY[key] = integration;
}

/** Return the integration for *key*, or ``null`` if not registered. */
export function getIntegration(key: string): IntegrationBase | null {
  return Object.prototype.hasOwnProperty.call(INTEGRATION_REGISTRY, key) ? INTEGRATION_REGISTRY[key] : null;
}

/** Register all built-in integrations (alphabetical, as upstream). */
function registerBuiltins(): void {
  register(new AgyIntegration());
  register(new AlquimiaAIIntegration());
  register(new AmpIntegration());
  register(new AuggieIntegration());
  register(new BobIntegration());
  register(new ClaudeIntegration());
  register(new ClineIntegration());
  register(new CodebuddyIntegration());
  register(new CodexIntegration());
  register(new CommandCodeIntegration());
  register(new CopilotIntegration());
  register(new CursorAgentIntegration());
  register(new DevinIntegration());
  register(new DockerAgentIntegration());
  register(new DroidIntegration());
  register(new DshIntegration());
  register(new FirebenderIntegration());
  register(new ForgeIntegration());
  register(new GeminiIntegration());
  register(new GenericIntegration());
  register(new GooseIntegration());
  register(new GrokIntegration());
  register(new HermesIntegration());
  register(new JunieIntegration());
  register(new KilocodeIntegration());
  register(new KimiIntegration());
  register(new KiroCliIntegration());
  register(new LingmaIntegration());
  register(new MuseIntegration());
  register(new OmpIntegration());
  register(new OpencodeIntegration());
  register(new PiIntegration());
  register(new QodercliIntegration());
  register(new QwenIntegration());
  register(new RovodevIntegration());
  register(new ShaiIntegration());
  register(new TabnineIntegration());
  register(new TraeIntegration());
  register(new VibeIntegration());
  register(new ZcodeIntegration());
  register(new ZedIntegration());
}

registerBuiltins();

// Wire the runtime-events subsystem into the integration base classes
// (see ``setIntegrationEventsBridge`` for why this is late-bound).
setIntegrationEventsBridge({
  installIntegrationEvents: (integration, projectRoot, manifest, events) =>
    installIntegrationEvents(integration, projectRoot, manifest, events as never),
  removeIntegrationEvents: (integration, projectRoot, manifest) => removeIntegrationEvents(integration, projectRoot, manifest),
  eventsStaleExclusions: (key) => eventsStaleExclusions(key),
} satisfies IntegrationEventsBridge);

// ============================================================================
// Errors
// ============================================================================

/** Raised when a catalog operation fails. */
export class IntegrationCatalogError extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'IntegrationCatalogError';
  }
}

/** Validation error for catalog config or catalog management operations. */
export class IntegrationValidationError extends IntegrationCatalogError {
  constructor(message = '') {
    super(message);
    this.name = 'IntegrationValidationError';
  }
}

/** Raised when an ``integration.yml`` descriptor is invalid. */
export class IntegrationDescriptorError extends Error {
  constructor(message = '') {
    super(message);
    this.name = 'IntegrationDescriptorError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Reason *payload* is not a valid integration catalog document, else ``null``. */
export function catalogShapeError(payload: unknown): string | null {
  if (!isPlainObject(payload)) return 'expected a JSON object';
  if (!('schema_version' in payload) || !('integrations' in payload)) {
    return "missing required 'schema_version' or 'integrations' key";
  }
  if (!isPlainObject(payload.integrations)) return "'integrations' must be a JSON object";
  return null;
}

// ============================================================================
// Catalog entries / stack primitives (port of catalogs.CatalogEntry usage)
// ============================================================================

/** A single catalog source in the catalog stack. */
export class IntegrationCatalogEntry {
  url: string;
  name: string;
  priority: number;
  install_allowed: boolean;
  description: string;

  constructor(opts: { url: string; name: string; priority: number; install_allowed: boolean; description?: string }) {
    this.url = opts.url;
    this.name = opts.name;
    this.priority = opts.priority;
    this.install_allowed = opts.install_allowed;
    this.description = opts.description ?? '';
  }
}

/** Python ``int()`` for YAML-loaded values; throws on invalid input. */
function pyInt(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('OverflowError');
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const t = value.trim().replace(/_/g, '');
    if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
  }
  throw new Error('invalid int');
}

/** Python ``datetime.fromisoformat`` → epoch ms (naive → UTC). Throws on invalid input. */
function parseIsoDatetime(text: unknown): number {
  if (typeof text !== 'string') throw new ValueError('Invalid isoformat string');
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?)?(Z|[+-]\d{2}:?\d{2}(?::?\d{2}(?:\.\d+)?)?)?$/.exec(text);
  if (!m) throw new ValueError(`Invalid isoformat string: ${pyRepr(text)}`);
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '0', tz] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, Math.floor(Number('0.' + frac) * 1000));
  if (tz && tz !== 'Z') {
    const sign = tz[0] === '-' ? -1 : 1;
    const digits = tz.slice(1).replace(/:/g, '');
    const offMin = parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2, 4), 10);
    ms -= sign * offMin * 60000;
  }
  if (Number.isNaN(ms)) throw new ValueError('Invalid isoformat string');
  return ms;
}

// ============================================================================
// IntegrationCatalog
// ============================================================================

/** Plain-dict view of a catalog source (``get_catalog_configs``). */
export interface IntegrationCatalogConfig {
  name: string;
  url: string;
  priority: number;
  install_allowed: boolean;
  description: string;
}

/** Optional fetcher override (tests); defaults to ``authentication/http`` ``openUrl`` or ``fetch``. */
export type CatalogFetcher = (url: string, timeoutSeconds: number) => Promise<unknown>;

/** Manages integration catalog fetching, caching, and searching. */
export class IntegrationCatalog {
  static DEFAULT_CATALOG_URL = 'https://raw.githubusercontent.com/github/spec-kit/main/integrations/catalog.json';
  static COMMUNITY_CATALOG_URL =
    'https://raw.githubusercontent.com/github/spec-kit/main/integrations/catalog.community.json';
  static CACHE_DURATION = 3600;
  static CONFIG_FILENAME = 'integration-catalogs.yml';
  static ENTRY_CLASS = IntegrationCatalogEntry;
  static ERROR_TYPE = IntegrationCatalogError;
  static VALIDATION_ERROR_TYPE = IntegrationValidationError;

  projectRoot: string;
  cacheDir: string;
  /** Test hook: replaces the network layer. */
  fetcher: CatalogFetcher | null = null;
  private nonDefaultCatalogWarningShown = false;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.cacheDir = join(projectRoot, '.specify', 'integrations', '.cache');
  }

  // -- Stack primitives (catalogs.CatalogStackBase) -----------------------

  /** Validate that a catalog URL uses HTTPS, except localhost HTTP. */
  static validateCatalogUrl(url: string): void {
    let hostname: string | null;
    let scheme: string;
    try {
      const parts = urlsplit(url);
      scheme = parts.scheme;
      hostname = parts.hostname ?? null;
      urlPort(parts);
    } catch {
      throw new IntegrationCatalogError(`Catalog URL is malformed: ${url}`);
    }
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (scheme !== 'https' && !(scheme === 'http' && isLocalhost)) {
      throw new IntegrationCatalogError(
        `Catalog URL must use HTTPS (got ${scheme}://). HTTP is only allowed for localhost.`,
      );
    }
    if (!hostname) throw new IntegrationCatalogError('Catalog URL must be a valid URL with a host.');
  }

  validateCatalogUrl(url: string): void {
    IntegrationCatalog.validateCatalogUrl(url);
  }

  /**
   * Load catalog stack configuration from a YAML file. Returns ``null`` when
   * the file does not exist; fails closed on malformed/empty files.
   */
  loadCatalogConfig(configPath: string): IntegrationCatalogEntry[] | null {
    if (!existsSync(configPath)) return null;
    let data: unknown;
    try {
      data = parseYaml(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(configPath)));
    } catch (exc) {
      throw new IntegrationValidationError(`Failed to read catalog config ${configPath}: ${(exc as Error).message}`);
    }
    if (data === null || data === undefined) data = {};
    if (!isPlainObject(data)) {
      throw new IntegrationValidationError(`Invalid catalog config ${configPath}: expected a YAML mapping at the root`);
    }
    const catalogsData = 'catalogs' in data ? data.catalogs : [];
    if (!Array.isArray(catalogsData)) {
      throw new IntegrationValidationError(
        `Invalid catalog config ${configPath}: 'catalogs' must be a list, got ${pyTypeName(catalogsData)}`,
      );
    }
    if (catalogsData.length === 0) {
      throw new IntegrationValidationError(
        `Catalog config ${configPath} exists but contains no 'catalogs' entries. ` +
          'Remove the file to use built-in defaults, or add valid catalog entries.',
      );
    }
    const entries: IntegrationCatalogEntry[] = [];
    const skipped: number[] = [];
    catalogsData.forEach((item: unknown, idx: number) => {
      if (!isPlainObject(item)) {
        throw new IntegrationValidationError(
          `Invalid catalog config ${configPath}: catalog entry at index ${idx}: expected a mapping, got ${pyTypeName(item)}`,
        );
      }
      const url = pyStrOf('url' in item ? item.url : '').trim();
      if (!url) {
        skipped.push(idx);
        return;
      }
      try {
        IntegrationCatalog.validateCatalogUrl(url);
      } catch (exc) {
        if (exc instanceof IntegrationCatalogError) {
          throw new IntegrationValidationError(`Invalid catalog URL in ${configPath} at index ${idx}: ${exc.message}`);
        }
        throw exc;
      }
      const rawPriority = 'priority' in item ? item.priority : idx + 1;
      const nameForError = 'name' in item ? pyStrOf(item.name) : String(idx + 1);
      if (typeof rawPriority === 'boolean') {
        throw new IntegrationValidationError(
          `Invalid catalog config ${configPath}: Invalid priority for catalog '${nameForError}': expected integer, got ${pyRepr(rawPriority)}`,
        );
      }
      let priority: number;
      try {
        priority = pyInt(rawPriority);
      } catch {
        throw new IntegrationValidationError(
          `Invalid catalog config ${configPath}: Invalid priority for catalog '${nameForError}': expected integer, got ${pyRepr(rawPriority)}`,
        );
      }
      const rawInstall = 'install_allowed' in item ? item.install_allowed : false;
      const installAllowed =
        typeof rawInstall === 'string' ? ['true', 'yes', '1'].includes(rawInstall.trim().toLowerCase()) : pyBool(rawInstall);
      const rawName = item.name;
      let name = rawName !== null && rawName !== undefined ? pyStrOf(rawName).trim() : '';
      if (!name) name = `catalog-${entries.length + 1}`;
      entries.push(
        new IntegrationCatalogEntry({
          url,
          name,
          priority,
          install_allowed: installAllowed,
          description: pyStrOf('description' in item ? item.description : ''),
        }),
      );
    });
    entries.sort((a, b) => a.priority - b.priority);
    if (entries.length === 0) {
      throw new IntegrationValidationError(
        `Catalog config ${configPath} contains ${catalogsData.length} entries but none have valid URLs ` +
          `(entries at indices [${skipped.join(', ')}] were skipped). Each catalog entry must have a 'url' field.`,
      );
    }
    return entries;
  }

  // -- Active catalogs ----------------------------------------------------

  /**
   * Ordered list of active integration catalogs: env var
   * ``SPECKIT_INTEGRATION_CATALOG_URL`` → project config → user config →
   * built-in defaults.
   */
  getActiveCatalogs(): IntegrationCatalogEntry[] {
    const envValue = (process.env.SPECKIT_INTEGRATION_CATALOG_URL ?? '').trim();
    if (envValue) {
      IntegrationCatalog.validateCatalogUrl(envValue);
      if (envValue !== IntegrationCatalog.DEFAULT_CATALOG_URL && !this.nonDefaultCatalogWarningShown) {
        process.stderr.write('Warning: Using non-default integration catalog. Only use catalogs from sources you trust.\n');
        this.nonDefaultCatalogWarningShown = true;
      }
      return [
        new IntegrationCatalogEntry({
          url: envValue,
          name: 'custom',
          priority: 1,
          install_allowed: true,
          description: 'Custom catalog via SPECKIT_INTEGRATION_CATALOG_URL',
        }),
      ];
    }
    const projectCfg = join(this.projectRoot, '.specify', IntegrationCatalog.CONFIG_FILENAME);
    const projectCatalogs = this.loadCatalogConfig(projectCfg);
    if (projectCatalogs !== null) return projectCatalogs;
    const userCfg = join(homeDir(), '.specify', IntegrationCatalog.CONFIG_FILENAME);
    const userCatalogs = this.loadCatalogConfig(userCfg);
    if (userCatalogs !== null) return userCatalogs;
    return [
      new IntegrationCatalogEntry({
        url: IntegrationCatalog.DEFAULT_CATALOG_URL,
        name: 'default',
        priority: 1,
        install_allowed: true,
        description: 'Built-in catalog of installable integrations',
      }),
      new IntegrationCatalogEntry({
        url: IntegrationCatalog.COMMUNITY_CATALOG_URL,
        name: 'community',
        priority: 2,
        install_allowed: false,
        description: 'Community-contributed integrations (discovery only)',
      }),
    ];
  }

  // -- Fetching -----------------------------------------------------------

  private async openCatalogUrl(url: string, timeoutSeconds: number): Promise<{ response: unknown; finalUrl: string }> {
    if (this.fetcher) {
      const response = await this.fetcher(url, timeoutSeconds);
      return { response, finalUrl: responseUrl(response) ?? url };
    }
    let openUrl: ((url: string, opts?: unknown) => Promise<unknown>) | null = null;
    try {
      const mod = (await import('../authentication/http.js')) as Record<string, unknown>;
      if (typeof mod.openUrl === 'function') openUrl = mod.openUrl as (url: string, opts?: unknown) => Promise<unknown>;
    } catch {
      openUrl = null;
    }
    let response: unknown;
    if (openUrl) {
      response = await openUrl(url, { timeout: timeoutSeconds });
    } else {
      response = await fetch(url, { signal: AbortSignal.timeout(timeoutSeconds * 1000) });
    }
    return { response, finalUrl: responseUrl(response) ?? url };
  }

  /** Fetch one catalog, with per-URL caching. */
  async fetchSingleCatalog(entry: IntegrationCatalogEntry, forceRefresh = false): Promise<Record<string, unknown>> {
    const urlHash = createHash('sha256').update(entry.url, 'utf-8').digest('hex').slice(0, 16);
    const cacheFile = join(this.cacheDir, `catalog-${urlHash}.json`);
    const cacheMeta = join(this.cacheDir, `catalog-${urlHash}-metadata.json`);

    if (!forceRefresh && existsSync(cacheFile) && existsSync(cacheMeta)) {
      try {
        const meta = JSON.parse(readFileSync(cacheMeta, 'utf-8')) as Record<string, unknown>;
        const cachedAt = parseIsoDatetime(meta.cached_at ?? '');
        const age = (Date.now() - cachedAt) / 1000;
        if (age < IntegrationCatalog.CACHE_DURATION) {
          const cached: unknown = JSON.parse(readFileSync(cacheFile, 'utf-8'));
          const shape = catalogShapeError(cached);
          if (shape !== null) throw new ValueError(`cached catalog has invalid shape: ${shape}`);
          return cached as Record<string, unknown>;
        }
      } catch {
        try {
          if (existsSync(cacheFile)) unlinkSync(cacheFile);
          if (existsSync(cacheMeta)) unlinkSync(cacheMeta);
        } catch {
          // best effort
        }
      }
    }

    let catalogData: unknown;
    try {
      const { response, finalUrl } = await this.openCatalogUrl(entry.url, 10);
      const status = (response as { status?: number; ok?: boolean }).status;
      if ((response as { ok?: boolean }).ok === false) {
        const statusText = (response as { statusText?: string }).statusText ?? '';
        throw new UrlError(`HTTP Error ${status}: ${statusText}`);
      }
      if (finalUrl !== entry.url) IntegrationCatalog.validateCatalogUrl(finalUrl);
      const bytes = await readResponseLimited(response as never, {
        maxBytes: MAX_JSON_METADATA_BYTES,
        errorType: IntegrationCatalogError,
        label: `catalog from ${entry.url}`,
      });
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (exc) {
        throw new IntegrationCatalogError(`Catalog from ${entry.url} is not valid UTF-8: ${(exc as Error).message}`);
      }
      try {
        catalogData = JSON.parse(text);
      } catch (exc) {
        throw new IntegrationCatalogError(`Invalid JSON in catalog from ${entry.url}: ${(exc as Error).message}`);
      }
    } catch (exc) {
      if (exc instanceof IntegrationCatalogError) throw exc;
      throw new IntegrationCatalogError(`Failed to fetch catalog from ${entry.url}: ${(exc as Error).message ?? String(exc)}`);
    }

    const shape = catalogShapeError(catalogData);
    if (shape !== null) throw new IntegrationCatalogError(`Invalid catalog format from ${entry.url}: ${shape}`);

    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(catalogData, null, 2), 'utf-8');
      writeFileSync(cacheMeta, JSON.stringify({ cached_at: utcIsoNow(), catalog_url: entry.url }, null, 2), 'utf-8');
    } catch {
      // best effort
    }
    return catalogData as Record<string, unknown>;
  }

  /**
   * Fetch and merge integrations from all active catalogs (first catalog wins
   * on conflicts). Each dict is annotated with ``_catalog_name`` and
   * ``_install_allowed``.
   */
  async getMergedIntegrations(forceRefresh = false): Promise<Array<Record<string, unknown>>> {
    const active = this.getActiveCatalogs();
    const merged = new Map<string, Record<string, unknown>>();
    let anySuccess = false;
    for (const entry of active) {
      let data: Record<string, unknown>;
      try {
        data = await this.fetchSingleCatalog(entry, forceRefresh);
        anySuccess = true;
      } catch (exc) {
        if (exc instanceof IntegrationCatalogError) {
          process.stderr.write(`Warning: Could not fetch catalog '${entry.name}': ${exc.message}\n`);
          continue;
        }
        throw exc;
      }
      const integrations = (isPlainObject(data.integrations) ? data.integrations : {}) as Record<string, unknown>;
      for (const [integId, integData] of Object.entries(integrations)) {
        if (!isPlainObject(integData)) continue;
        if (!merged.has(integId)) {
          merged.set(integId, {
            ...integData,
            id: integId,
            _catalog_name: entry.name,
            _install_allowed: entry.install_allowed,
          });
        }
      }
    }
    if (!anySuccess && active.length > 0) throw new IntegrationCatalogError('Failed to fetch any integration catalog');
    return [...merged.values()];
  }

  // -- Search / info --------------------------------------------------------

  /** Search catalogs for integrations matching the given filters. */
  async search(query: string | null = null, tag: string | null = null, author: string | null = null): Promise<Array<Record<string, unknown>>> {
    const results: Array<Record<string, unknown>> = [];
    for (const item of await this.getMergedIntegrations()) {
      let authorVal: unknown = 'author' in item ? item.author : '';
      if (typeof authorVal !== 'string') authorVal = authorVal !== null && authorVal !== undefined ? pyStrOf(authorVal) : '';
      if (author && (authorVal as string).toLowerCase() !== author.toLowerCase()) continue;
      const rawTags = 'tags' in item ? item.tags : [];
      const tagsList = Array.isArray(rawTags) ? rawTags : [];
      const strTags = tagsList.filter((t): t is string => typeof t === 'string');
      if (tag && !strTags.map((t) => t.toLowerCase()).includes(tag.toLowerCase())) continue;
      if (query) {
        const truthyStr = (v: unknown) => (v ? pyStrOf(v) : '');
        const haystack = [truthyStr(item.name), truthyStr(item.description), truthyStr(item.id), ...strTags]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query.toLowerCase())) continue;
      }
      results.push(item);
    }
    return results;
  }

  /** Catalog metadata for a single integration, or ``null``. */
  async getIntegrationInfo(integrationId: string): Promise<Record<string, unknown> | null> {
    for (const item of await this.getMergedIntegrations()) {
      if (item.id === integrationId) return item;
    }
    return null;
  }

  // -- Cache management -------------------------------------------------------

  /** Remove all cached catalog files. */
  clearCache(): void {
    if (!existsSync(this.cacheDir)) return;
    for (const name of readdirSync(this.cacheDir)) {
      if (/^catalog-.*\.json$/.test(name)) {
        try {
          unlinkSync(join(this.cacheDir, name));
        } catch {
          // missing_ok
        }
      }
    }
  }

  // -- Catalog-source management ---------------------------------------------

  /** Active catalog stack as plain dicts. */
  getCatalogConfigs(): IntegrationCatalogConfig[] {
    return this.getActiveCatalogs().map(entryToConfig);
  }

  /** Removable project-level catalog config entries, if configured. */
  getProjectCatalogConfigs(): IntegrationCatalogConfig[] | null {
    const entries = this.loadCatalogConfig(join(this.projectRoot, '.specify', IntegrationCatalog.CONFIG_FILENAME));
    if (entries === null) return null;
    return entries.map(entryToConfig);
  }

  private readConfigForEdit(configPath: string): Record<string, unknown> {
    let raw: unknown;
    try {
      raw = parseYaml(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(configPath)));
    } catch (exc) {
      throw new IntegrationValidationError(`Failed to read catalog config ${configPath}: ${(exc as Error).message}`);
    }
    if (raw === null || raw === undefined) raw = {};
    if (!isPlainObject(raw)) {
      throw new IntegrationValidationError(`Catalog config file ${configPath} is corrupted (expected a mapping).`);
    }
    return raw;
  }

  /**
   * Add a catalog source to the project-level config. Returns ``"added"`` or
   * ``"unchanged"``.
   */
  addCatalog(url: string, name: string | null = null): 'added' | 'unchanged' {
    url = url.trim();
    if (!url) throw new IntegrationValidationError('Catalog URL must be non-empty.');
    IntegrationCatalog.validateCatalogUrl(url);
    const configPath = join(this.projectRoot, '.specify', IntegrationCatalog.CONFIG_FILENAME);
    let data: Record<string, unknown> = { catalogs: [] };
    if (existsSync(configPath)) data = this.readConfigForEdit(configPath);
    const catalogs = 'catalogs' in data ? data.catalogs : [];
    if (!Array.isArray(catalogs)) {
      throw new IntegrationValidationError(`Catalog config ${configPath} has invalid 'catalogs' value: must be a list.`);
    }
    const normalizedName = name !== null && name !== undefined ? pyStrOf(name).trim() : '';
    const existingPriorities: number[] = [];
    let validCount = 0;
    for (let idx = 0; idx < catalogs.length; idx++) {
      const cat = catalogs[idx];
      if (!isPlainObject(cat)) {
        throw new IntegrationValidationError(
          `Invalid catalog entry at index ${idx} in ${configPath}: expected a mapping, got ${pyTypeName(cat)}.`,
        );
      }
      const existingUrl = pyStrOf('url' in cat ? cat.url : '').trim();
      if (!existingUrl) continue;
      try {
        IntegrationCatalog.validateCatalogUrl(existingUrl);
      } catch (exc) {
        if (exc instanceof IntegrationCatalogError) {
          throw new IntegrationValidationError(`Invalid catalog entry at index ${idx} in ${configPath}: ${exc.message}`);
        }
        throw exc;
      }
      if (existingUrl === url) {
        const generated = `catalog-${validCount + 1}`;
        const existingName = pyStrOf(cat.name ? cat.name : generated).trim();
        if (!normalizedName || existingName === normalizedName) {
          this.loadCatalogConfig(configPath);
          return 'unchanged';
        }
        throw new IntegrationValidationError(`Catalog URL already configured: ${url}`);
      }
      validCount += 1;
      if ('priority' in cat) {
        const rawPriority = cat.priority;
        if (typeof rawPriority === 'boolean') {
          throw new IntegrationValidationError(
            `Invalid catalog entry at index ${idx} in ${configPath}: 'priority' must be an integer, got bool.`,
          );
        }
        try {
          existingPriorities.push(pyInt(rawPriority));
        } catch {
          throw new IntegrationValidationError(
            `Invalid catalog entry at index ${idx} in ${configPath}: 'priority' must be an integer, got ${pyRepr(rawPriority)}.`,
          );
        }
      } else {
        existingPriorities.push(idx + 1);
      }
    }
    const maxPriority = existingPriorities.length > 0 ? Math.max(...existingPriorities) : 0;
    catalogs.push({
      name: normalizedName || `catalog-${validCount + 1}`,
      url,
      priority: maxPriority + 1,
      install_allowed: true,
      description: '',
    });
    data.catalogs = catalogs;
    mkdirSync(join(this.projectRoot, '.specify'), { recursive: true });
    writeFileSync(configPath, dumpYaml(data, { defaultFlowStyle: false, sortKeys: false, allowUnicode: true }), 'utf-8');
    return 'added';
  }

  /**
   * Remove a catalog source by 0-based index in ``catalog list`` display
   * order. Returns the removed catalog's name.
   */
  removeCatalog(index: number): string {
    const configPath = join(this.projectRoot, '.specify', IntegrationCatalog.CONFIG_FILENAME);
    if (!existsSync(configPath)) throw new IntegrationValidationError('No catalog config file found.');
    const data = this.readConfigForEdit(configPath);
    const catalogs = 'catalogs' in data ? data.catalogs : [];
    if (!Array.isArray(catalogs)) {
      throw new IntegrationValidationError(`Catalog config ${configPath} has invalid 'catalogs' value: must be a list.`);
    }
    if (catalogs.length === 0) throw new IntegrationValidationError('Catalog config contains no catalog entries.');
    const removable = (item: unknown): boolean => {
      if (!isPlainObject(item)) return false;
      const rawUrl = item.url;
      if (rawUrl === null || rawUrl === undefined) return false;
      return Boolean(pyStrOf(rawUrl).trim());
    };
    const pairs: Array<[number, number]> = [];
    catalogs.forEach((item: unknown, yamlIdx: number) => {
      if (!removable(item)) return;
      const rawPriority = 'priority' in (item as Record<string, unknown>) ? (item as Record<string, unknown>).priority : yamlIdx + 1;
      let priority: number;
      if (typeof rawPriority === 'boolean') {
        priority = yamlIdx + 1;
      } else {
        try {
          priority = pyInt(rawPriority);
        } catch {
          priority = yamlIdx + 1;
        }
      }
      pairs.push([priority, yamlIdx]);
    });
    if (pairs.length === 0) throw new IntegrationValidationError('Catalog config contains no removable catalog entries.');
    pairs.sort((a, b) => a[0] - b[0]);
    const displayOrder = pairs.map((p) => p[1]);
    if (index < 0 || index >= displayOrder.length) {
      throw new IntegrationValidationError(`Catalog index ${index} out of range (0-${displayOrder.length - 1}).`);
    }
    const [removed] = catalogs.splice(displayOrder[index], 1);
    if (catalogs.some((item: unknown) => removable(item))) {
      data.catalogs = catalogs;
      writeFileSync(configPath, dumpYaml(data, { defaultFlowStyle: false, sortKeys: false, allowUnicode: true }), 'utf-8');
    } else {
      try {
        if (existsSync(configPath)) unlinkSync(configPath);
      } catch (exc) {
        throw new IntegrationValidationError(`Failed to delete catalog config ${configPath}: ${(exc as Error).message}`);
      }
    }
    if (isPlainObject(removed)) {
      if (removed.name !== null && removed.name !== undefined) {
        const n = pyStrOf(removed.name).trim();
        if (n) return n;
      }
      if (removed.url !== null && removed.url !== undefined) {
        const u = pyStrOf(removed.url).trim();
        if (u) return u;
      }
    }
    return `catalog-${index + 1}`;
  }
}

class UrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'URLError';
  }
}

function responseUrl(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as { url?: unknown; geturl?: () => string };
  if (typeof r.geturl === 'function') return r.geturl();
  if (typeof r.url === 'string' && r.url) return r.url;
  return null;
}

function entryToConfig(e: IntegrationCatalogEntry): IntegrationCatalogConfig {
  return { name: e.name, url: e.url, priority: e.priority, install_allowed: e.install_allowed, description: e.description };
}

/** Python ``str(value)`` for YAML/JSON-loaded values. */
function pyStrOf(value: unknown): string {
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null || value === undefined) return 'None';
  return String(value);
}

function pyBool(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

// ============================================================================
// IntegrationDescriptor (integration.yml)
// ============================================================================

function isUnsafeRelative(p: string): boolean {
  return isAbsolute(p) || pathParts(p).includes('..') || /^[A-Za-z]:/.test(p) || p.startsWith('/') || p.startsWith('\\');
}

/** Loads and validates an ``integration.yml`` descriptor. */
export class IntegrationDescriptor {
  static SCHEMA_VERSION = '1.0';
  static REQUIRED_TOP_LEVEL = ['schema_version', 'integration', 'requires', 'provides'];

  path: string;
  data: Record<string, any>;

  constructor(descriptorPath: string) {
    this.path = descriptorPath;
    this.data = IntegrationDescriptor.load(descriptorPath) as Record<string, any>;
    this.validate();
  }

  static load(path: string): unknown {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === 'ENOENT') throw new IntegrationDescriptorError(`Descriptor not found: ${path}`);
      throw new IntegrationDescriptorError(`Unable to read descriptor ${path}: ${(exc as Error).message}`);
    }
    let data: unknown;
    let isEmpty: boolean;
    try {
      isEmpty = isEmptyYamlDocument(text);
      data = parseYaml(text);
    } catch (exc) {
      if (exc instanceof YAMLError) throw new IntegrationDescriptorError(`Invalid YAML in ${path}: ${exc.message}`);
      throw exc;
    }
    if (isEmpty) data = {};
    return data;
  }

  validate(): void {
    const data = this.data as unknown;
    if (!isPlainObject(data)) {
      throw new IntegrationDescriptorError(`Descriptor root must be a YAML mapping, got ${pyTypeName(data)}`);
    }
    for (const field of IntegrationDescriptor.REQUIRED_TOP_LEVEL) {
      if (!(field in data)) throw new IntegrationDescriptorError(`Missing required field: ${field}`);
    }
    if (data.schema_version !== IntegrationDescriptor.SCHEMA_VERSION) {
      throw new IntegrationDescriptorError(
        `Unsupported schema version: ${pyStrOf(data.schema_version)} (expected ${IntegrationDescriptor.SCHEMA_VERSION})`,
      );
    }
    const integ = data.integration;
    if (!isPlainObject(integ)) throw new IntegrationDescriptorError("'integration' must be a mapping");
    for (const field of ['id', 'name', 'version', 'description']) {
      if (!(field in integ)) throw new IntegrationDescriptorError(`Missing integration.${field}`);
      if (typeof integ[field] !== 'string') {
        throw new IntegrationDescriptorError(`integration.${field} must be a string, got ${pyTypeName(integ[field])}`);
      }
    }
    if (!/^[a-z0-9-]+$/.test(integ.id as string)) {
      throw new IntegrationDescriptorError(
        `Invalid integration ID '${integ.id as string}': must be lowercase alphanumeric with hyphens only`,
      );
    }
    try {
      new Version(integ.version as string);
    } catch {
      throw new IntegrationDescriptorError(`Invalid version '${integ.version as string}'`);
    }
    const requires = data.requires;
    if (!isPlainObject(requires)) throw new IntegrationDescriptorError("'requires' must be a mapping");
    if (!('speckit_version' in requires)) throw new IntegrationDescriptorError('Missing requires.speckit_version');
    if (typeof requires.speckit_version !== 'string' || !requires.speckit_version.trim()) {
      throw new IntegrationDescriptorError('requires.speckit_version must be a non-empty string');
    }
    const tools = requires.tools;
    if (tools !== null && tools !== undefined) {
      if (!Array.isArray(tools)) throw new IntegrationDescriptorError('requires.tools must be a list');
      for (const tool of tools) {
        if (!isPlainObject(tool)) throw new IntegrationDescriptorError('Each requires.tools entry must be a mapping');
        const toolName = tool.name;
        if (typeof toolName !== 'string' || !toolName.trim()) {
          throw new IntegrationDescriptorError("requires.tools entry 'name' must be a non-empty string");
        }
      }
    }
    const provides = data.provides;
    if (!isPlainObject(provides)) throw new IntegrationDescriptorError("'provides' must be a mapping");
    const commands = 'commands' in provides ? provides.commands : [];
    const scripts = 'scripts' in provides ? provides.scripts : [];
    if ('commands' in provides && !Array.isArray(commands)) {
      throw new IntegrationDescriptorError('Invalid provides.commands: expected a list');
    }
    if ('scripts' in provides && !Array.isArray(scripts)) {
      throw new IntegrationDescriptorError('Invalid provides.scripts: expected a list');
    }
    if (!pyBool(commands) && !pyBool(scripts)) {
      throw new IntegrationDescriptorError('Integration must provide at least one command or script');
    }
    for (const cmd of (commands ?? []) as unknown[]) {
      if (!isPlainObject(cmd)) throw new IntegrationDescriptorError('Each command entry must be a mapping');
      if (!('name' in cmd) || !('file' in cmd)) throw new IntegrationDescriptorError("Command entry missing 'name' or 'file'");
      if (typeof cmd.name !== 'string' || !cmd.name.trim()) {
        throw new IntegrationDescriptorError("Command entry 'name' must be a non-empty string");
      }
      if (typeof cmd.file !== 'string' || !cmd.file.trim()) {
        throw new IntegrationDescriptorError("Command entry 'file' must be a non-empty string");
      }
      if (isUnsafeRelative(cmd.file)) {
        throw new IntegrationDescriptorError(`Command entry 'file' must be a relative path without '..': ${cmd.file}`);
      }
    }
    for (const scriptEntry of (scripts ?? []) as unknown[]) {
      if (typeof scriptEntry !== 'string' || !scriptEntry.trim()) {
        throw new IntegrationDescriptorError('Script entry must be a non-empty string');
      }
      if (isUnsafeRelative(scriptEntry)) {
        throw new IntegrationDescriptorError(`Script entry must be a relative path without '..': ${scriptEntry}`);
      }
    }
  }

  get id(): string {
    return this.data.integration.id;
  }
  get name(): string {
    return this.data.integration.name;
  }
  get version(): string {
    return this.data.integration.version;
  }
  get description(): string {
    return this.data.integration.description;
  }
  get requiresSpeckitVersion(): string {
    return this.data.requires.speckit_version;
  }
  get commands(): Array<Record<string, unknown>> {
    return (this.data.provides ?? {}).commands ?? [];
  }
  get scripts(): string[] {
    return (this.data.provides ?? {}).scripts ?? [];
  }
  get tools(): Array<Record<string, unknown>> {
    return (this.data.requires ?? {}).tools || [];
  }

  /** ``sha256:<hex>`` of the descriptor file. */
  getHash(): string {
    return `sha256:${createHash('sha256').update(readFileSync(this.path)).digest('hex')}`;
  }
}
