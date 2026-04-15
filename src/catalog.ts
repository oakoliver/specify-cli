/**
 * @oakoliver/specify-cli - Extension & Preset Catalog
 *
 * Manages fetching and searching extensions and presets from catalogs.
 * Supports both official GitHub catalog and custom community catalogs.
 *
 * @module catalog
 */

import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

// ============================================================================
// Types
// ============================================================================

/**
 * Catalog entry for an extension or preset.
 */
export interface CatalogEntry {
  name: string;
  id: string;
  description: string;
  author?: string;
  version: string;
  download_url: string;
  repository?: string;
  homepage?: string;
  documentation?: string;
  changelog?: string;
  license?: string;
  requires?: {
    speckit_version?: string;
    tools?: { name: string; version?: string; required?: boolean }[];
    extensions?: string[];
  };
  provides?: {
    commands?: number;
    hooks?: number;
    templates?: number;
  };
  tags?: string[];
  verified?: boolean;
  downloads?: number;
  stars?: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * Full catalog structure.
 */
export interface Catalog {
  schema_version: string;
  name: string;
  description?: string;
  updated_at: string;
  entries: CatalogEntry[];
}

/**
 * Search result from catalog.
 */
export interface SearchResult {
  entry: CatalogEntry;
  catalog_name: string;
  score: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Default catalog URLs */
export const DEFAULT_EXTENSION_CATALOG = 'https://raw.githubusercontent.com/github/spec-kit/main/extensions/catalog.community.json';
export const DEFAULT_PRESET_CATALOG = 'https://raw.githubusercontent.com/github/spec-kit/main/presets/catalog.community.json';

/** Cache directory relative to project */
export const CATALOG_CACHE_DIR = '.specify/.cache';

/** Cache expiry in milliseconds (1 hour) */
export const CACHE_EXPIRY_MS = 60 * 60 * 1000;

// ============================================================================
// Catalog Fetching
// ============================================================================

/**
 * Fetch a catalog from URL with caching.
 */
export async function fetchCatalog(url: string, projectRoot?: string): Promise<Catalog> {
  // Try cache first if projectRoot provided
  if (projectRoot) {
    const cached = loadCachedCatalog(url, projectRoot);
    if (cached) return cached;
  }

  // Fetch from URL
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch catalog from ${url}: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as Catalog;

  // Validate structure
  if (!data.entries || !Array.isArray(data.entries)) {
    throw new Error(`Invalid catalog format from ${url}: missing entries array`);
  }

  // Cache the result
  if (projectRoot) {
    cacheCatalog(url, data, projectRoot);
  }

  return data;
}

/**
 * Get cache file path for a URL.
 */
function getCachePath(url: string, projectRoot: string): string {
  // Create a simple hash of the URL
  const hash = url.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0).toString(16);
  
  return join(projectRoot, CATALOG_CACHE_DIR, `catalog-${hash}.json`);
}

/**
 * Load cached catalog if valid.
 */
function loadCachedCatalog(url: string, projectRoot: string): Catalog | null {
  const cachePath = getCachePath(url, projectRoot);
  
  if (!existsSync(cachePath)) return null;

  try {
    const { readFileSync, statSync } = require('node:fs');
    const stats = statSync(cachePath);
    const age = Date.now() - stats.mtimeMs;

    // Check expiry
    if (age > CACHE_EXPIRY_MS) return null;

    return JSON.parse(readFileSync(cachePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Cache a catalog.
 */
function cacheCatalog(url: string, catalog: Catalog, projectRoot: string): void {
  try {
    const cacheDir = join(projectRoot, CATALOG_CACHE_DIR);
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    const cachePath = getCachePath(url, projectRoot);
    writeFileSync(cachePath, JSON.stringify(catalog, null, 2));
  } catch {
    // Ignore cache write failures
  }
}

// ============================================================================
// Search & Filtering
// ============================================================================

/**
 * Search catalog entries.
 */
export function searchCatalog(
  catalog: Catalog,
  query?: string,
  tags?: string[]
): CatalogEntry[] {
  let results = [...catalog.entries];

  // Filter by tags
  if (tags && tags.length > 0) {
    results = results.filter(entry =>
      tags.some(tag => entry.tags?.includes(tag))
    );
  }

  // Search by query
  if (query) {
    const lowerQuery = query.toLowerCase();
    results = results.filter(entry => {
      const searchText = [
        entry.name,
        entry.id,
        entry.description,
        entry.author,
        ...(entry.tags || []),
      ].join(' ').toLowerCase();

      return searchText.includes(lowerQuery);
    });
  }

  // Sort by relevance (downloads, stars, name)
  results.sort((a, b) => {
    // Verified first
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    // Then by downloads
    if ((a.downloads || 0) !== (b.downloads || 0)) {
      return (b.downloads || 0) - (a.downloads || 0);
    }
    // Then by stars
    if ((a.stars || 0) !== (b.stars || 0)) {
      return (b.stars || 0) - (a.stars || 0);
    }
    // Then alphabetically
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Find entry by ID.
 */
export function findEntryById(catalog: Catalog, id: string): CatalogEntry | null {
  return catalog.entries.find(e => e.id === id) || null;
}

// ============================================================================
// Download & Extract
// ============================================================================

/**
 * Download and extract an extension/preset from URL.
 * Returns path to extracted directory.
 */
export async function downloadAndExtract(
  entry: CatalogEntry,
  destDir: string
): Promise<string> {
  const downloadUrl = entry.download_url;
  
  // Create temp directory
  const tempDir = join(destDir, '.download-temp');
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true });
  }
  mkdirSync(tempDir, { recursive: true });

  try {
    // Determine download type from URL
    const isZip = downloadUrl.endsWith('.zip');
    const isTarGz = downloadUrl.endsWith('.tar.gz') || downloadUrl.endsWith('.tgz');
    const isGitRepo = downloadUrl.includes('github.com') && !isZip && !isTarGz;

    if (isGitRepo) {
      // Clone repository
      const repoUrl = downloadUrl.replace('/tree/', '/archive/refs/heads/').replace(/\/([^/]+)$/, '.zip');
      await downloadFile(repoUrl, join(tempDir, 'repo.zip'));
      await extractZip(join(tempDir, 'repo.zip'), tempDir);
    } else if (isZip) {
      await downloadFile(downloadUrl, join(tempDir, 'package.zip'));
      await extractZip(join(tempDir, 'package.zip'), tempDir);
    } else if (isTarGz) {
      await downloadFile(downloadUrl, join(tempDir, 'package.tar.gz'));
      await extractTarGz(join(tempDir, 'package.tar.gz'), tempDir);
    } else {
      throw new Error(`Unsupported download URL format: ${downloadUrl}`);
    }

    // Find extracted directory (usually first directory inside temp)
    const extracted = readdirSync(tempDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)[0];

    if (!extracted) {
      throw new Error('No directory found after extraction');
    }

    return join(tempDir, extracted);
  } catch (error) {
    // Cleanup on failure
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
    throw error;
  }
}

/**
 * Download a file from URL.
 */
async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(dest, buffer);
}

/**
 * Extract a zip file.
 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  // Use system unzip command
  try {
    execSync(`unzip -q "${zipPath}" -d "${destDir}"`, { stdio: 'ignore' });
  } catch {
    throw new Error('Failed to extract zip file. Ensure unzip is installed.');
  }
}

/**
 * Extract a tar.gz file.
 */
async function extractTarGz(tarPath: string, destDir: string): Promise<void> {
  // Use system tar command
  try {
    execSync(`tar -xzf "${tarPath}" -C "${destDir}"`, { stdio: 'ignore' });
  } catch {
    throw new Error('Failed to extract tar.gz file. Ensure tar is installed.');
  }
}

/**
 * Cleanup download temp directory.
 */
export function cleanupDownloadTemp(destDir: string): void {
  const tempDir = join(destDir, '.download-temp');
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true });
  }
}
