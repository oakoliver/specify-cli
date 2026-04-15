/**
 * Catalog Module Tests
 *
 * Tests for the extension and preset catalog system including
 * fetching, caching, searching, and downloading.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  type Catalog,
  type CatalogEntry,
  DEFAULT_EXTENSION_CATALOG,
  DEFAULT_PRESET_CATALOG,
  CATALOG_CACHE_DIR,
  CACHE_EXPIRY_MS,
  searchCatalog,
  findEntryById,
} from '../src/index.js';

// ============================================================================
// Test Fixtures
// ============================================================================

let testDir: string;

function createTestProject(): string {
  const dir = join(tmpdir(), `catalog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, '.specify'), { recursive: true });
  return dir;
}

beforeEach(() => {
  testDir = createTestProject();
});

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true });
  }
});

// Sample catalog for testing
const sampleCatalog: Catalog = {
  schema_version: '1.0.0',
  name: 'test-catalog',
  description: 'Test catalog for unit tests',
  updated_at: '2026-04-15T00:00:00Z',
  entries: [
    {
      name: 'Feature Planner',
      id: 'feature-planner',
      description: 'Plan and organize features',
      author: 'spec-kit',
      version: '1.0.0',
      download_url: 'https://example.com/feature-planner.zip',
      tags: ['planning', 'organization'],
      verified: true,
      downloads: 1000,
      stars: 50,
    },
    {
      name: 'Code Reviewer',
      id: 'code-reviewer',
      description: 'Automated code review assistant',
      author: 'community',
      version: '2.1.0',
      download_url: 'https://example.com/code-reviewer.tar.gz',
      tags: ['review', 'quality'],
      verified: false,
      downloads: 500,
      stars: 25,
    },
    {
      name: 'Doc Generator',
      id: 'doc-generator',
      description: 'Generate documentation from code',
      author: 'spec-kit',
      version: '1.5.0',
      download_url: 'https://github.com/example/doc-generator',
      tags: ['documentation', 'automation'],
      verified: true,
      downloads: 2000,
      stars: 100,
    },
    {
      name: 'Test Runner',
      id: 'test-runner',
      description: 'Run tests with AI assistance',
      author: 'third-party',
      version: '0.9.0',
      download_url: 'https://example.com/test-runner.zip',
      tags: ['testing', 'automation'],
      verified: false,
      downloads: 100,
      stars: 10,
    },
  ],
};

// ============================================================================
// Constants Tests
// ============================================================================

describe('catalog constants', () => {
  test('DEFAULT_EXTENSION_CATALOG is valid URL', () => {
    expect(DEFAULT_EXTENSION_CATALOG).toMatch(/^https:\/\//);
    expect(DEFAULT_EXTENSION_CATALOG).toContain('githubusercontent.com');
    expect(DEFAULT_EXTENSION_CATALOG).toContain('catalog');
  });

  test('DEFAULT_PRESET_CATALOG is valid URL', () => {
    expect(DEFAULT_PRESET_CATALOG).toMatch(/^https:\/\//);
    expect(DEFAULT_PRESET_CATALOG).toContain('githubusercontent.com');
    expect(DEFAULT_PRESET_CATALOG).toContain('catalog');
  });

  test('CATALOG_CACHE_DIR is expected path', () => {
    expect(CATALOG_CACHE_DIR).toBe('.specify/.cache');
  });

  test('CACHE_EXPIRY_MS is 1 hour', () => {
    expect(CACHE_EXPIRY_MS).toBe(60 * 60 * 1000);
  });
});

// ============================================================================
// searchCatalog Tests
// ============================================================================

describe('searchCatalog', () => {
  test('returns all entries when no filter applied', () => {
    const results = searchCatalog(sampleCatalog);
    expect(results.length).toBe(4);
  });

  test('filters by query in name', () => {
    const results = searchCatalog(sampleCatalog, 'planner');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('feature-planner');
  });

  test('filters by query in description', () => {
    const results = searchCatalog(sampleCatalog, 'documentation');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('doc-generator');
  });

  test('filters by query in author', () => {
    const results = searchCatalog(sampleCatalog, 'community');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('code-reviewer');
  });

  test('filters by query in id', () => {
    const results = searchCatalog(sampleCatalog, 'test-runner');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('test-runner');
  });

  test('filters by single tag', () => {
    const results = searchCatalog(sampleCatalog, undefined, ['testing']);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('test-runner');
  });

  test('filters by multiple tags (OR logic)', () => {
    const results = searchCatalog(sampleCatalog, undefined, ['testing', 'review']);
    expect(results.length).toBe(2);
    expect(results.map(r => r.id).sort()).toEqual(['code-reviewer', 'test-runner']);
  });

  test('combines query and tag filters', () => {
    const results = searchCatalog(sampleCatalog, 'automation', ['automation']);
    expect(results.length).toBe(2);
    expect(results.map(r => r.id).sort()).toEqual(['doc-generator', 'test-runner']);
  });

  test('returns empty array for no matches', () => {
    const results = searchCatalog(sampleCatalog, 'nonexistent');
    expect(results.length).toBe(0);
  });

  test('query is case insensitive', () => {
    const results = searchCatalog(sampleCatalog, 'PLANNER');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('feature-planner');
  });

  test('sorts verified entries first', () => {
    const results = searchCatalog(sampleCatalog);
    // First two should be verified
    expect(results[0].verified).toBe(true);
    expect(results[1].verified).toBe(true);
  });

  test('sorts by downloads within verified group', () => {
    const results = searchCatalog(sampleCatalog);
    const verifiedResults = results.filter(r => r.verified);
    // doc-generator has 2000 downloads, feature-planner has 1000
    expect(verifiedResults[0].id).toBe('doc-generator');
    expect(verifiedResults[1].id).toBe('feature-planner');
  });

  test('sorts by stars when downloads are equal', () => {
    const catalog: Catalog = {
      ...sampleCatalog,
      entries: [
        { ...sampleCatalog.entries[0], verified: true, downloads: 100, stars: 10 },
        { ...sampleCatalog.entries[1], verified: true, downloads: 100, stars: 20 },
      ],
    };
    const results = searchCatalog(catalog);
    // Higher stars should come first when downloads are equal
    expect(results[0].stars).toBe(20);
    expect(results[1].stars).toBe(10);
  });
});

// ============================================================================
// findEntryById Tests
// ============================================================================

describe('findEntryById', () => {
  test('finds entry by exact id', () => {
    const entry = findEntryById(sampleCatalog, 'feature-planner');
    expect(entry).not.toBeNull();
    expect(entry?.name).toBe('Feature Planner');
  });

  test('returns null for non-existent id', () => {
    const entry = findEntryById(sampleCatalog, 'nonexistent');
    expect(entry).toBeNull();
  });

  test('is case sensitive', () => {
    const entry = findEntryById(sampleCatalog, 'Feature-Planner');
    expect(entry).toBeNull();
  });
});

// ============================================================================
// CatalogEntry Type Tests
// ============================================================================

describe('CatalogEntry structure', () => {
  test('required fields are present', () => {
    const entry = sampleCatalog.entries[0];
    expect(entry.name).toBeDefined();
    expect(entry.id).toBeDefined();
    expect(entry.description).toBeDefined();
    expect(entry.version).toBeDefined();
    expect(entry.download_url).toBeDefined();
  });

  test('optional fields can be undefined', () => {
    const minimalEntry: CatalogEntry = {
      name: 'Minimal',
      id: 'minimal',
      description: 'A minimal entry',
      version: '1.0.0',
      download_url: 'https://example.com/minimal.zip',
    };
    
    const catalog: Catalog = {
      ...sampleCatalog,
      entries: [minimalEntry],
    };

    const found = findEntryById(catalog, 'minimal');
    expect(found).not.toBeNull();
    expect(found?.author).toBeUndefined();
    expect(found?.tags).toBeUndefined();
    expect(found?.verified).toBeUndefined();
  });

  test('provides field contains expected structure', () => {
    const entryWithProvides: CatalogEntry = {
      name: 'Full Extension',
      id: 'full-ext',
      description: 'Extension with provides field',
      version: '1.0.0',
      download_url: 'https://example.com/full.zip',
      provides: {
        commands: 5,
        hooks: 2,
        templates: 3,
      },
    };

    expect(entryWithProvides.provides?.commands).toBe(5);
    expect(entryWithProvides.provides?.hooks).toBe(2);
    expect(entryWithProvides.provides?.templates).toBe(3);
  });

  test('requires field contains expected structure', () => {
    const entryWithRequires: CatalogEntry = {
      name: 'Dependent Extension',
      id: 'dependent',
      description: 'Extension with dependencies',
      version: '1.0.0',
      download_url: 'https://example.com/dependent.zip',
      requires: {
        speckit_version: '>=1.0.0',
        tools: [
          { name: 'git', version: '>=2.0', required: true },
          { name: 'gh', required: false },
        ],
        extensions: ['feature-planner'],
      },
    };

    expect(entryWithRequires.requires?.speckit_version).toBe('>=1.0.0');
    expect(entryWithRequires.requires?.tools?.length).toBe(2);
    expect(entryWithRequires.requires?.extensions).toContain('feature-planner');
  });
});

// ============================================================================
// Catalog Structure Tests
// ============================================================================

describe('Catalog structure', () => {
  test('has required fields', () => {
    expect(sampleCatalog.schema_version).toBeDefined();
    expect(sampleCatalog.name).toBeDefined();
    expect(sampleCatalog.updated_at).toBeDefined();
    expect(sampleCatalog.entries).toBeDefined();
    expect(Array.isArray(sampleCatalog.entries)).toBe(true);
  });

  test('schema_version follows semver', () => {
    expect(sampleCatalog.schema_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('updated_at is valid date string', () => {
    const date = new Date(sampleCatalog.updated_at);
    expect(date.getTime()).not.toBeNaN();
    expect(date.getFullYear()).toBe(2026);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('edge cases', () => {
  test('handles empty catalog', () => {
    const emptyCatalog: Catalog = {
      schema_version: '1.0.0',
      name: 'empty',
      updated_at: '2026-04-15T00:00:00Z',
      entries: [],
    };

    const results = searchCatalog(emptyCatalog, 'anything');
    expect(results.length).toBe(0);
  });

  test('handles entries with null/undefined tags', () => {
    const catalog: Catalog = {
      ...sampleCatalog,
      entries: [
        {
          name: 'No Tags',
          id: 'no-tags',
          description: 'Entry without tags',
          version: '1.0.0',
          download_url: 'https://example.com/no-tags.zip',
          tags: undefined,
        },
      ],
    };

    // Should not throw
    const results = searchCatalog(catalog, undefined, ['some-tag']);
    expect(results.length).toBe(0);
  });

  test('handles empty query string', () => {
    const results = searchCatalog(sampleCatalog, '');
    expect(results.length).toBe(4);
  });

  test('handles empty tags array', () => {
    const results = searchCatalog(sampleCatalog, undefined, []);
    expect(results.length).toBe(4);
  });

  test('handles special characters in query', () => {
    const catalog: Catalog = {
      ...sampleCatalog,
      entries: [
        {
          name: 'C++ Helper',
          id: 'cpp-helper',
          description: 'Helps with C++ code (including templates)',
          version: '1.0.0',
          download_url: 'https://example.com/cpp.zip',
        },
      ],
    };

    const results = searchCatalog(catalog, 'C++');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('cpp-helper');
  });
});
