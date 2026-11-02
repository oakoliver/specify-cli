/**
 * Shared `artifact.list` / `artifact.info` operations (spec-kit v1.2.5
 * #4866 / #4882). Ports of tests/specify_cli/artifacts/test_operation_list.py
 * and test_operation_info.py.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  ARTIFACT_INFO_OPERATION,
  ARTIFACT_LIST_MAX_LIMIT,
  ARTIFACT_LIST_OPERATION,
  ArtifactInfoError,
  ArtifactListError,
  getArtifactInfo,
  listArtifacts,
} from '../src/artifacts/operations.js';
import { ArtifactCatalog } from '../src/artifacts/catalog.js';

let tmp: string;
let project: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'artifacts-op-')));
  project = path.join(tmp, 'proj');
  for (const d of ['presets', 'extensions', 'templates/commands']) mkdirSync(path.join(project, '.specify', d), { recursive: true });
  writeFileSync(path.join(project, '.specify/templates/spec-template.md'), '# Spec\n');
  writeFileSync(path.join(project, '.specify/templates/commands/plan.md'), '---\ndescription: Plan it\n---\nBody\n');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

describe('artifact.list', () => {
  test('descriptor is stable', () => {
    expect(ARTIFACT_LIST_OPERATION.operationId).toBe('artifact.list');
    expect(ARTIFACT_LIST_OPERATION.contractVersion).toBe('2');
    expect(ARTIFACT_LIST_OPERATION.networkAccess).toBe('none');
  });

  test('returns the complete inventory, same as the catalog', () => {
    const result = listArtifacts({ projectDirectory: project });
    expect(result.rows).toEqual(new ArtifactCatalog(project).listArtifactsWithStack());
    expect(result.truncated).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  test('returns deterministic pages', () => {
    const all = listArtifacts({ projectDirectory: project }).rows;
    const pages: unknown[] = [];
    let cursor: string | null = null;
    do {
      const page = listArtifacts({ projectDirectory: project, limit: 1, cursor });
      pages.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(pages).toEqual(all);
    const beyond = listArtifacts({ projectDirectory: project, cursor: String(all.length + 5) });
    expect(beyond).toEqual({ rows: [], nextCursor: null, truncated: false });
  });

  for (const limit of [0, -1, ARTIFACT_LIST_MAX_LIMIT + 1, 1.5]) {
    test(`rejects invalid limit ${limit}`, () => {
      expect(codeOf(() => listArtifacts({ projectDirectory: project, limit }))).toBe('invalid_pagination');
    });
  }

  for (const cursor of ['', '01', '-1', '1.0', 'x', '１', '123456789012345678901']) {
    test(`rejects invalid cursor ${JSON.stringify(cursor)}`, () => {
      let err: ArtifactListError | null = null;
      try {
        listArtifacts({ projectDirectory: project, cursor });
      } catch (e) {
        err = e as ArtifactListError;
      }
      expect(err?.code).toBe('invalid_pagination');
      expect(err?.details).toEqual({ field: 'cursor', value: cursor, max_limit: ARTIFACT_LIST_MAX_LIMIT });
    });
  }

  test('rejects relative and non-project directories', () => {
    expect(codeOf(() => listArtifacts({ projectDirectory: 'relative' }))).toBe('invalid_project_directory');
    mkdirSync(path.join(tmp, 'plain'));
    expect(codeOf(() => listArtifacts({ projectDirectory: path.join(tmp, 'plain') }))).toBe('not_a_spec_kit_project');
  });

  test('maps a corrupt registry to a resolution error', () => {
    writeFileSync(path.join(project, '.specify/extensions/.registry'), '{invalid');
    let err: ArtifactListError | null = null;
    try {
      listArtifacts({ projectDirectory: project });
    } catch (e) {
      err = e as ArtifactListError;
    }
    expect(err?.code).toBe('artifact_resolution_failed');
    expect(err?.message).toBe('artifact resolution failed');
    expect(err?.details).toEqual({ project_directory: project });
    expect(err?.retryable).toBe(false);
  });

  test('maps an invalid persisted policy to a resolution error with its message', () => {
    writeFileSync(path.join(project, '.specify/init-options.json'), '{"allow_symlinks": 1}');
    let err: ArtifactListError | null = null;
    try {
      listArtifacts({ projectDirectory: project });
    } catch (e) {
      err = e as ArtifactListError;
    }
    expect(err?.code).toBe('artifact_resolution_failed');
    expect(err?.message).toContain('allow_symlinks must be a JSON boolean');
  });
});

describe('artifact.info', () => {
  test('descriptor is stable', () => {
    expect(ARTIFACT_INFO_OPERATION.operationId).toBe('artifact.info');
    expect(ARTIFACT_INFO_OPERATION.contractVersion).toBe('1');
  });

  test('bare names and public ids are identical, and match the list row', () => {
    const bare = getArtifactInfo({ projectDirectory: project, identifier: 'spec-template' }).toJsonDict();
    const pub = getArtifactInfo({ projectDirectory: project, identifier: 'template:spec-template' }).toJsonDict();
    expect(bare).toEqual(pub);
    const row = listArtifacts({ projectDirectory: project }).rows.find((r) => r.id === 'template:spec-template');
    expect(row).toEqual(bare);
  });

  test('explicit kind selects the family', () => {
    const r = getArtifactInfo({ projectDirectory: project, identifier: 'spec-template', kind: 'template' });
    expect(r.artifact.kind).toBe('template');
  });

  test('error mapping', () => {
    const err = (req: Parameters<typeof getArtifactInfo>[0]): ArtifactInfoError | null => {
      try {
        getArtifactInfo(req);
      } catch (e) {
        return e as ArtifactInfoError;
      }
      return null;
    };
    expect(err({ projectDirectory: 'rel', identifier: 'x' })?.code).toBe('invalid_project_directory');
    expect(err({ projectDirectory: project, identifier: 'x', kind: 'bogus' as never })?.code).toBe('invalid_artifact_kind');
    expect(err({ projectDirectory: project, identifier: '' })?.code).toBe('invalid_artifact_identifier');
    expect(err({ projectDirectory: project, identifier: 'weird:thing' })?.code).toBe('invalid_artifact_identifier');
    expect(err({ projectDirectory: project, identifier: 'command:nope' })?.code).toBe('unknown_artifact');
    mkdirSync(path.join(tmp, 'plain'));
    expect(err({ projectDirectory: path.join(tmp, 'plain'), identifier: 'x' })?.code).toBe('not_a_spec_kit_project');
    // Malformed identifiers are rejected before project validation.
    expect(err({ projectDirectory: path.join(tmp, 'plain'), identifier: 'weird:thing' })?.code).toBe(
      'invalid_artifact_identifier',
    );
    const kindError = err({ projectDirectory: project, identifier: 'x', kind: 'bogus' as never });
    expect(kindError?.message).toBe("invalid artifact kind 'bogus': expected one of command, template, script, hook");
  });
});
