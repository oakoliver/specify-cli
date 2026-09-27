/**
 * Tests for shared infrastructure installation
 * (ports of tests/test_shared_infra_gitignore.py, test_shared_infra_integrity.py
 * and the shared-infra refresh / stale-cleanup cases from the integration CLI tests).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  SPECIFY_GITIGNORE_CONTENT,
  SymlinkedSharedPathError,
  ensureExecutableScripts,
  ensureSafeSharedDirectory,
  installSharedInfra,
  installSharedInfraOrExit,
  refreshSharedTemplates,
  resolveDynamicCommandRefs,
  verifyArchiveSha256,
  writeSharedText,
} from '../src/shared-infra.js';
import { CliExit } from '../src/console.js';

const REPO_CORE_PACK = fileURLToPath(new URL('../core_pack', import.meta.url));
const IS_WINDOWS = process.platform === 'win32';

let tmp: string;
let project: string;
let pack: string;
let lines: string[];
const fakeConsole = { print: (m = ''): void => void lines.push(m) };

function sha(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

function manifestFiles(): Record<string, string> {
  const data = JSON.parse(
    readFileSync(join(project, '.specify', 'integrations', 'speckit.manifest.json'), 'utf-8'),
  );
  return data.files;
}

function manifestData(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(project, '.specify', 'integrations', 'speckit.manifest.json'), 'utf-8'));
}

function install(opts: Record<string, unknown> = {}, scriptType = 'sh'): void {
  installSharedInfra(project, scriptType, {
    version: '9.9.9',
    corePack: pack,
    repoRoot: tmp,
    console: fakeConsole,
    ...opts,
  });
}

function output(): string {
  return lines.join('\n');
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'shared-infra-'));
  project = join(tmp, 'proj');
  mkdirSync(join(project, '.specify'), { recursive: true });
  pack = join(tmp, 'pack');
  mkdirSync(join(pack, 'templates'), { recursive: true });
  mkdirSync(join(pack, 'scripts', 'bash'), { recursive: true });
  mkdirSync(join(pack, 'scripts', 'powershell'), { recursive: true });
  mkdirSync(join(pack, 'scripts', 'python', '__pycache__'), { recursive: true });
  writeFileSync(join(pack, 'templates', 'plan-template.md'), 'Run __SPECKIT_COMMAND_PLAN__ then __SPECKIT_COMMAND_GIT_COMMIT__\n');
  writeFileSync(join(pack, 'templates', 'spec-template.md'), '# Spec\n');
  writeFileSync(join(pack, 'templates', 'vscode-settings.json'), '{}');
  writeFileSync(join(pack, 'templates', '.hidden'), 'x');
  writeFileSync(join(pack, 'scripts', 'bash', 'common.sh'), '#!/usr/bin/env bash\necho "$(format_speckit_command plan)"\n');
  chmodSync(join(pack, 'scripts', 'bash', 'common.sh'), 0o755);
  writeFileSync(join(pack, 'scripts', 'bash', 'data.txt'), 'plain\n');
  chmodSync(join(pack, 'scripts', 'bash', 'data.txt'), 0o644);
  writeFileSync(join(pack, 'scripts', 'powershell', 'common.ps1'), "Write-Output (Format-SpecKitCommand -CommandName 'tasks')\n");
  writeFileSync(join(pack, 'scripts', 'python', 'common.py'), 'print(1)\n');
  writeFileSync(join(pack, 'scripts', 'python', '__pycache__', 'common.cpython-312.pyc'), 'bytecode');
  lines = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ============================================================================
// Managed .specify/.gitignore
// ============================================================================

describe('managed .specify/.gitignore', () => {
  test('is written and tracked', () => {
    install();
    const gitignore = join(project, '.specify', '.gitignore');
    const content = readFileSync(gitignore, 'utf-8');
    expect(content).toBe(SPECIFY_GITIGNORE_CONTENT);
    expect(content).toContain('feature.json');
    expect(content).toContain('extensions/*/local-config.yml');
    expect(manifestFiles()['.specify/.gitignore']).toBe(sha(SPECIFY_GITIGNORE_CONTENT));
  });

  test('user edits preserved by default', () => {
    install();
    const gitignore = join(project, '.specify', '.gitignore');
    writeFileSync(gitignore, '# my customization\n');
    install();
    expect(readFileSync(gitignore, 'utf-8')).toBe('# my customization\n');
  });

  test('force restores managed content', () => {
    install();
    const gitignore = join(project, '.specify', '.gitignore');
    writeFileSync(gitignore, '# my customization\n');
    install({ force: true });
    expect(readFileSync(gitignore, 'utf-8')).toBe(SPECIFY_GITIGNORE_CONTENT);
  });
});

// ============================================================================
// Install layout
// ============================================================================

describe('installSharedInfra', () => {
  test('installs bash scripts and templates, resolving command refs', () => {
    install({ invokeSeparator: '-' });
    const plan = readFileSync(join(project, '.specify', 'templates', 'plan-template.md'), 'utf-8');
    expect(plan).toBe('Run /speckit-plan then /speckit-git-commit\n');
    expect(existsSync(join(project, '.specify', 'templates', 'vscode-settings.json'))).toBe(false);
    expect(existsSync(join(project, '.specify', 'templates', '.hidden'))).toBe(false);
    const common = readFileSync(join(project, '.specify', 'scripts', 'bash', 'common.sh'), 'utf-8');
    expect(common).toBe('#!/usr/bin/env bash\necho "/speckit-plan"\n');
    expect(existsSync(join(project, '.specify', 'scripts', 'powershell'))).toBe(false);

    const files = manifestFiles();
    expect(Object.keys(files).sort()).toEqual([
      '.specify/.gitignore',
      '.specify/scripts/bash/common.sh',
      '.specify/scripts/bash/data.txt',
      '.specify/templates/plan-template.md',
      '.specify/templates/spec-template.md',
    ]);
    expect(manifestData()['integration']).toBe('speckit');
    expect(manifestData()['version']).toBe('9.9.9');
  });

  test.skipIf(IS_WINDOWS)('preserves source executable bits', () => {
    install();
    expect(statSync(join(project, '.specify', 'scripts', 'bash', 'common.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(project, '.specify', 'scripts', 'bash', 'data.txt')).mode & 0o777).toBe(0o644);
  });

  test('ps installs powershell with rendered Format-SpecKitCommand', () => {
    install({}, 'ps');
    const ps = readFileSync(join(project, '.specify', 'scripts', 'powershell', 'common.ps1'), 'utf-8');
    expect(ps).toBe("Write-Output ('/speckit.tasks')\n");
    expect(existsSync(join(project, '.specify', 'scripts', 'bash'))).toBe(false);
  });

  test('py installs python plus platform shell, skipping __pycache__', () => {
    install({}, 'py');
    expect(existsSync(join(project, '.specify', 'scripts', 'python', 'common.py'))).toBe(true);
    expect(existsSync(join(project, '.specify', 'scripts', 'python', '__pycache__'))).toBe(false);
    const shell = IS_WINDOWS ? 'powershell' : 'bash';
    expect(existsSync(join(project, '.specify', 'scripts', shell))).toBe(true);
  });

  test('existing untracked files are skipped and recorded as recovered', () => {
    mkdirSync(join(project, '.specify', 'templates'), { recursive: true });
    writeFileSync(join(project, '.specify', 'templates', 'spec-template.md'), 'mine\n');
    install();
    expect(readFileSync(join(project, '.specify', 'templates', 'spec-template.md'), 'utf-8')).toBe('mine\n');
    expect(output()).toContain('1 shared infrastructure path(s) already exist and were not updated:');
    expect(output()).toContain('    .specify/templates/spec-template.md');
    expect(output()).toContain('[cyan]specify integration upgrade --force[/cyan]');
    const data = manifestData();
    expect((data['files'] as Record<string, string>)['.specify/templates/spec-template.md']).toBe(sha('mine\n'));
    expect(data['recovered_files']).toEqual(['.specify/templates/spec-template.md']);

    // refresh_managed never overwrites a recovered file.
    lines = [];
    install({ refreshManaged: true, refreshHint: 'HINT' });
    expect(readFileSync(join(project, '.specify', 'templates', 'spec-template.md'), 'utf-8')).toBe('mine\n');
    expect(output()).toContain('Preserved 1 customized shared infrastructure file(s)');
    expect(output()).toContain('HINT');
  });

  test('refreshManaged overwrites unmodified files and preserves customized ones', () => {
    install();
    writeFileSync(join(pack, 'templates', 'spec-template.md'), '# Spec v2\n');
    writeFileSync(join(pack, 'templates', 'plan-template.md'), 'plan v2\n');
    writeFileSync(join(project, '.specify', 'templates', 'plan-template.md'), 'custom\n');
    lines = [];
    install({ refreshManaged: true, refreshHint: 'To overwrite customizations, re-run with --force.' });
    expect(readFileSync(join(project, '.specify', 'templates', 'spec-template.md'), 'utf-8')).toBe('# Spec v2\n');
    expect(readFileSync(join(project, '.specify', 'templates', 'plan-template.md'), 'utf-8')).toBe('custom\n');
    expect(output()).toContain(
      '[yellow]⚠[/yellow]  Preserved 1 customized shared infrastructure file(s) (hash differs from previous install):',
    );
    expect(output()).toContain('    .specify/templates/plan-template.md');
    expect(output()).toContain('To overwrite customizations, re-run with --force.');
    expect(manifestFiles()['.specify/templates/spec-template.md']).toBe(sha('# Spec v2\n'));
  });

  test('force overwrites customizations', () => {
    install();
    writeFileSync(join(project, '.specify', 'templates', 'spec-template.md'), 'custom\n');
    install({ force: true });
    expect(readFileSync(join(project, '.specify', 'templates', 'spec-template.md'), 'utf-8')).toBe('# Spec\n');
  });

  test('removes stale managed scripts but preserves modified ones', () => {
    install();
    const bash = join(project, '.specify', 'scripts', 'bash');
    writeFileSync(join(bash, 'update-agent-context.sh'), 'old\n');
    writeFileSync(join(bash, 'custom-stale.sh'), 'edited\n');
    const mpath = join(project, '.specify', 'integrations', 'speckit.manifest.json');
    const data = JSON.parse(readFileSync(mpath, 'utf-8'));
    data.files['.specify/scripts/bash/update-agent-context.sh'] = sha('old\n');
    data.files['.specify/scripts/bash/custom-stale.sh'] = sha('original\n');
    data.files['.specify/scripts/bash/gone.sh'] = sha('gone\n');
    data.files['.specify/scripts/bash/../../escape.sh'] = sha('x');
    data.files['.specify/scripts/powershell/other.ps1'] = sha('y');
    writeFileSync(mpath, JSON.stringify(data));

    lines = [];
    install();
    expect(existsSync(join(bash, 'update-agent-context.sh'))).toBe(false);
    expect(readFileSync(join(bash, 'custom-stale.sh'), 'utf-8')).toBe('edited\n');
    expect(output()).toContain('[yellow]⚠[/yellow]  Removed 1 obsolete shared script(s) left by a previous install:');
    expect(output()).toContain('    .specify/scripts/bash/update-agent-context.sh');
    const files = manifestFiles();
    expect('.specify/scripts/bash/update-agent-context.sh' in files).toBe(false);
    expect('.specify/scripts/bash/gone.sh' in files).toBe(false);
    expect('.specify/scripts/bash/custom-stale.sh' in files).toBe(true);
    // Other variants and unsafe keys are left alone.
    expect('.specify/scripts/powershell/other.ps1' in files).toBe(true);
    expect('.specify/scripts/bash/../../escape.sh' in files).toBe(true);
  });

  test.skipIf(IS_WINDOWS)('symlinked destinations are skipped with a warning', () => {
    mkdirSync(join(project, '.specify', 'templates'), { recursive: true });
    const outside = join(tmp, 'outside.md');
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, join(project, '.specify', 'templates', 'spec-template.md'));
    install({ force: true });
    expect(readFileSync(outside, 'utf-8')).toBe('outside\n');
    expect(lstatSync(join(project, '.specify', 'templates', 'spec-template.md')).isSymbolicLink()).toBe(true);
    expect(output()).toContain('Skipped 1 symlinked shared infrastructure path(s)');
    expect(output()).toContain('    .specify/templates/spec-template.md');
  });

  test.skipIf(IS_WINDOWS)('symlinked scripts directory is bucketed, not followed', () => {
    const outsideDir = join(tmp, 'outside-scripts');
    mkdirSync(outsideDir);
    symlinkSync(outsideDir, join(project, '.specify', 'scripts'));
    install();
    expect(existsSync(join(outsideDir, 'bash'))).toBe(false);
    expect(output()).toContain('    .specify/scripts');
  });

  test('corrupt shared manifest is replaced with a warning', () => {
    mkdirSync(join(project, '.specify', 'integrations'), { recursive: true });
    writeFileSync(join(project, '.specify', 'integrations', 'speckit.manifest.json'), '{bad');
    install();
    expect(output()).toContain('[yellow]Warning:[/yellow] Could not read shared infrastructure manifest at');
    expect(output()).toContain('A new shared manifest will be created');
    expect(Object.keys(manifestFiles()).length).toBeGreaterThan(0);
  });

  test('installSharedInfraOrExit converts failures into CliExit(1)', () => {
    writeFileSync(join(project, '.specify', 'templates'), 'not a dir');
    expect(() =>
      installSharedInfraOrExit(project, 'sh', { version: '1', corePack: pack, repoRoot: tmp, console: fakeConsole }),
    ).toThrow(CliExit);
    expect(output()).toContain('[red]Error:[/red] Failed to install shared infrastructure:');
  });

  test('bundled core_pack installs the real shared infrastructure', () => {
    installSharedInfra(project, 'sh', { version: '1.0.0', corePack: REPO_CORE_PACK, repoRoot: tmp, console: fakeConsole });
    for (const name of ['common.sh', 'check-prerequisites.sh', 'create-new-feature.sh', 'setup-plan.sh']) {
      expect(existsSync(join(project, '.specify', 'scripts', 'bash', name))).toBe(true);
    }
    for (const name of ['plan-template.md', 'spec-template.md', 'tasks-template.md']) {
      const content = readFileSync(join(project, '.specify', 'templates', name), 'utf-8');
      expect(content).not.toContain('__SPECKIT_COMMAND_');
    }
    expect(existsSync(join(project, '.specify', 'templates', 'vscode-settings.json'))).toBe(false);
  });
});

// ============================================================================
// Template refresh
// ============================================================================

describe('refreshSharedTemplates', () => {
  test('refreshes tracked unmodified templates, skips modified ones', () => {
    install();
    writeFileSync(join(project, '.specify', 'templates', 'spec-template.md'), 'edited\n');
    lines = [];
    refreshSharedTemplates(project, {
      invokeSeparator: '-',
      version: '2',
      corePack: pack,
      repoRoot: tmp,
      console: fakeConsole,
    });
    expect(readFileSync(join(project, '.specify', 'templates', 'plan-template.md'), 'utf-8')).toBe(
      'Run /speckit-plan then /speckit-git-commit\n',
    );
    expect(readFileSync(join(project, '.specify', 'templates', 'spec-template.md'), 'utf-8')).toBe('edited\n');
    expect(output()).toContain(
      '1 modified, untracked, or preserved (recovered) shared template file(s) were not updated:',
    );
    // force refreshes modified templates too
    refreshSharedTemplates(project, {
      invokeSeparator: '.',
      invokePrefix: '$',
      force: true,
      version: '2',
      corePack: pack,
      repoRoot: tmp,
      console: fakeConsole,
    });
    expect(readFileSync(join(project, '.specify', 'templates', 'spec-template.md'), 'utf-8')).toBe('# Spec\n');
    expect(readFileSync(join(project, '.specify', 'templates', 'plan-template.md'), 'utf-8')).toBe(
      'Run $speckit.plan then $speckit.git.commit\n',
    );
  });
});

// ============================================================================
// Dynamic command refs
// ============================================================================

describe('resolveDynamicCommandRefs', () => {
  test('bash command substitutions', () => {
    expect(resolveDynamicCommandRefs('x $(format_speckit_command "speckit.git.commit" "$ROOT") y', '-')).toBe(
      'x /speckit-git-commit y',
    );
    expect(resolveDynamicCommandRefs('$(format_speckit_command plan)', '.', '$')).toBe('\\$speckit.plan');
  });

  test('formatter return statements', () => {
    const bash = `printf '/speckit%s%s\\n' "$separator" "$command_name"`;
    expect(resolveDynamicCommandRefs(bash, '.', '$')).toBe(`printf '$speckit%s%s\\n' "$separator" "$command_name"`);
    expect(resolveDynamicCommandRefs('return "/speckit$separator$name"', '.', '$')).toBe(
      'return "`$speckit$separator$name"',
    );
    expect(resolveDynamicCommandRefs('return f"/speckit{separator}{name}"', '.', '$')).toBe(
      'return f"$speckit{separator}{name}"',
    );
    expect(resolveDynamicCommandRefs("Format-SpecKitCommand -CommandName 'speckit-plan' -RepoRoot $r", '.')).toBe(
      "'/speckit.plan'",
    );
  });
});

// ============================================================================
// Archive integrity (test_shared_infra_integrity.py)
// ============================================================================

class BoomError extends Error {}

describe('verifyArchiveSha256', () => {
  const data = new TextEncoder().encode('hello-archive');
  const digest = sha(Buffer.from(data));

  test('matching digest passes', () => {
    verifyArchiveSha256(data, digest, 'thing', BoomError);
  });

  test('mismatch raises errorCls', () => {
    expect(() => verifyArchiveSha256(data, '0'.repeat(64), 'thing', BoomError)).toThrow(/[Ii]ntegrity/);
    expect(() => verifyArchiveSha256(data, '0'.repeat(64), 'thing', BoomError)).toThrow(BoomError);
  });

  test('sha256 prefix and case-insensitivity', () => {
    verifyArchiveSha256(data, `sha256:${digest}`, 'thing', BoomError);
    verifyArchiveSha256(data, `SHA256:${digest.toUpperCase()}`, 'thing', BoomError);
  });

  test('malformed, non-sha256-prefixed and blank digests are rejected', () => {
    for (const bad of ['deadbeef', 'z'.repeat(64), '0'.repeat(63), '0'.repeat(65), `md5:${digest}`, '', '   ', 'sha256:']) {
      expect(() => verifyArchiveSha256(data, bad, 'thing', BoomError)).toThrow(/[Ii]nvalid sha256/);
    }
  });

  test('message wording matches upstream', () => {
    expect(() => verifyArchiveSha256(data, 'abc', 'thing', BoomError)).toThrow(
      "Invalid sha256 declared for 'thing': expected 64 hexadecimal characters (optionally prefixed with 'sha256:'), got 'abc'.",
    );
  });

  test('absent digest skips', () => {
    verifyArchiveSha256(data, null, 'thing', BoomError);
    verifyArchiveSha256(data, undefined, 'thing', BoomError);
  });
});

// ============================================================================
// Safe path helpers / executable scripts
// ============================================================================

describe('safe path helpers', () => {
  test.skipIf(IS_WINDOWS)('ensureSafeSharedDirectory rejects symlinked parents', () => {
    const outside = join(tmp, 'elsewhere');
    mkdirSync(outside);
    symlinkSync(outside, join(project, 'link'));
    expect(() => ensureSafeSharedDirectory(project, join(project, 'link', 'sub'))).toThrow(SymlinkedSharedPathError);
    expect(existsSync(join(outside, 'sub'))).toBe(false);
  });

  test('ensureSafeSharedDirectory rejects escapes and non-directories', () => {
    expect(() => ensureSafeSharedDirectory(project, join(tmp, 'other'))).toThrow(
      'Shared infrastructure path escapes project root',
    );
    writeFileSync(join(project, 'file'), 'x');
    expect(() => ensureSafeSharedDirectory(project, join(project, 'file', 'sub'))).toThrow(
      'Shared infrastructure directory path is not a directory: file',
    );
    expect(() =>
      ensureSafeSharedDirectory(project, join(project, 'missing'), { create: false, context: 'agent skills directory' }),
    ).toThrow('Agent skills directory does not exist: missing');
  });

  test('writeSharedText writes atomically', () => {
    writeSharedText(project, join(project, '.specify', 'x.txt'), 'hello');
    expect(readFileSync(join(project, '.specify', 'x.txt'), 'utf-8')).toBe('hello');
  });

  test.skipIf(IS_WINDOWS)('ensureExecutableScripts adds execute bits to shebang .sh files', () => {
    const dir = join(project, '.specify', 'extensions', 'git', 'scripts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(join(dir, 'a.sh'), 0o644);
    writeFileSync(join(dir, 'b.sh'), 'echo no shebang\n');
    chmodSync(join(dir, 'b.sh'), 0o644);
    ensureExecutableScripts(project, null, fakeConsole);
    expect(statSync(join(dir, 'a.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, 'b.sh')).mode & 0o777).toBe(0o644);
    expect(output()).toContain('[cyan]Updated execute permissions on 1 script(s) recursively[/cyan]');
  });
});
