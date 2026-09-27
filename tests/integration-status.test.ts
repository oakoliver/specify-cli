/**
 * Tests for the read-only integration status report
 * (port of the report-level cases in test_command_status.py).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildIntegrationStatusReport, isSafeManifestKey } from '../src/integration-status.js';

let project: string;

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function writeState(data: unknown): void {
  writeFileSync(join(project, '.specify', 'integration.json'), JSON.stringify(data));
}

function writeManifest(key: string, files: Record<string, string>): void {
  mkdirSync(join(project, '.specify', 'integrations'), { recursive: true });
  writeFileSync(
    join(project, '.specify', 'integrations', `${key}.manifest.json`),
    JSON.stringify({ integration: key, version: '1', installed_at: '', files }),
  );
}

function writeFile(rel: string, content: string): string {
  const abs = join(project, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  return sha(content);
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'integration-status-'));
  mkdirSync(join(project, '.specify'), { recursive: true });
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('buildIntegrationStatusReport', () => {
  test('missing state', () => {
    const report = buildIntegrationStatusReport(project);
    expect(report.status).toBe('error');
    expect(report.default_integration).toBeNull();
    expect(report.multi_install_safe).toBeNull();
    expect(report.findings).toEqual([
      {
        severity: 'error',
        code: 'integration-state-missing',
        message: '.specify/integration.json is missing.',
        path: '.specify/integration.json',
        suggestion: 'Run `specify integration install <key>` to install an integration.',
      },
    ]);
  });

  test('not an object', () => {
    writeFileSync(join(project, '.specify', 'integration.json'), '"x"');
    const report = buildIntegrationStatusReport(project);
    expect(report.findings[0].message).toBe('.specify/integration.json must contain a JSON object, got str.');
  });

  test('healthy single integration', () => {
    const h = writeFile('.claude/skills/speckit-plan/SKILL.md', 'plan');
    const s = writeFile('.specify/.gitignore', 'x');
    writeManifest('claude', { '.claude/skills/speckit-plan/SKILL.md': h });
    writeManifest('speckit', { '.specify/.gitignore': s });
    writeState({ integration: 'claude', installed_integrations: ['claude'] });
    const report = buildIntegrationStatusReport(project);
    expect(report.status).toBe('ok');
    expect(report.default_integration).toBe('claude');
    expect(report.installed_integrations).toEqual(['claude']);
    expect(report.recorded_installed_integrations).toEqual(['claude']);
    expect(report.manifest_checked_integrations).toEqual(['claude', 'speckit']);
    expect(report.multi_install_safe).toBe(true);
    expect(report.manifests['claude']).toEqual({
      manifest: '.specify/integrations/claude.manifest.json',
      readable: true,
      tracked_files: 1,
      missing_files: [],
      modified_files: [],
      invalid_files: [],
    });
  });

  test('legacy state without installed list', () => {
    writeManifest('speckit', {});
    writeManifest('claude', {});
    writeState({ integration: 'claude' });
    const report = buildIntegrationStatusReport(project);
    expect(report.status).toBe('ok');
    expect(report.recorded_installed_integrations).toEqual([]);
    expect(report.multi_install_safe).toBeNull();
  });

  test('non-list installed_integrations warns', () => {
    writeManifest('speckit', {});
    writeManifest('claude', {});
    writeState({ integration: 'claude', installed_integrations: 'claude' });
    const report = buildIntegrationStatusReport(project);
    const f = report.findings.find((x) => x.code === 'installed-integrations-invalid');
    expect(f?.message).toBe('installed_integrations must be a list, got str.');
  });

  test('no installed integrations still checks shared manifest', () => {
    writeState({ installed_integrations: [] });
    const report = buildIntegrationStatusReport(project);
    const codes = report.findings.map((f) => f.code);
    expect(codes).toContain('no-installed-integrations');
    expect(codes).toContain('manifest-missing');
    const missing = report.findings.find((f) => f.code === 'manifest-missing');
    expect(missing?.message).toBe('Manifest for shared Spec Kit infrastructure is missing.');
    expect(missing?.suggestion).toBe(
      'Run `specify init --here --force --integration <key>` to regenerate shared managed files.',
    );
  });

  test('unsafe manifest paths are invalid without hashing', () => {
    writeManifest('speckit', { '../outside.txt': sha('x'), '/abs/path': sha('y') });
    writeManifest('claude', {});
    writeState({ integration: 'claude', installed_integrations: ['claude'] });
    const report = buildIntegrationStatusReport(project);
    expect(report.manifests['speckit'].invalid_files).toEqual(['../outside.txt', '/abs/path']);
    expect(report.invalid_manifest_paths).toBe(2);
    const f = report.findings.find((x) => x.code === 'manifest-paths-invalid');
    expect(f?.message).toBe('2 unsafe manifest path(s) are recorded for shared Spec Kit infrastructure.');
    expect(f?.suggestion).toBe('Run `specify integration upgrade claude` to regenerate shared managed files.');
  });

  test('unreadable manifest', () => {
    writeManifest('speckit', {});
    mkdirSync(join(project, '.specify', 'integrations'), { recursive: true });
    writeFileSync(join(project, '.specify', 'integrations', 'claude.manifest.json'), Buffer.from([0xff, 0xfe]));
    writeState({ integration: 'claude', installed_integrations: ['claude'] });
    const report = buildIntegrationStatusReport(project);
    const f = report.findings.find((x) => x.code === 'manifest-unreadable');
    expect(f?.message).toContain("Manifest for integration 'claude' is unreadable:");
    expect(report.unchecked_manifests).toBe(1);
  });

  test('managed file collisions', () => {
    const h = writeFile('shared.md', 'x');
    writeManifest('speckit', {});
    writeManifest('claude', { 'shared.md': h });
    writeManifest('gemini', { 'shared.md': h });
    writeState({ integration: 'claude', installed_integrations: ['claude', 'gemini'] });
    const report = buildIntegrationStatusReport(project);
    const f = report.findings.find((x) => x.code === 'managed-file-collision');
    expect(f?.message).toBe("Managed file 'shared.md' is tracked by multiple integrations: claude, gemini.");
    expect(f?.path).toBe('shared.md');
  });

  test('unknown integration suggestion', () => {
    writeManifest('speckit', {});
    writeState({ integration: 'mystery', installed_integrations: ['mystery'] });
    const report = buildIntegrationStatusReport(project);
    const unknown = report.findings.find((x) => x.code === 'unknown-integration');
    expect(unknown?.message).toBe("Integration 'mystery' is installed but is not known to this CLI.");
    const missing = report.findings.find((x) => x.code === 'manifest-missing');
    expect(missing?.suggestion).toBe(
      'Upgrade Spec Kit, reinstall with a supported CLI version, or remove the stale integration entry from .specify/integration.json.',
    );
    // a single unknown integration alone is not a multi-install problem
    expect(report.findings.some((x) => x.code === 'unsafe-multi-install')).toBe(false);
  });
});

describe('isSafeManifestKey', () => {
  test('accepts normal keys and rejects unsafe ones', () => {
    expect(isSafeManifestKey('claude')).toBe(true);
    expect(isSafeManifestKey('kiro-cli')).toBe(true);
    for (const bad of ['', '.', '..', 'a.', 'a/b', 'a\\b', 'CON', 'con.json', 'LPT9', 'a b']) {
      expect(isSafeManifestKey(bad)).toBe(false);
    }
  });
});
