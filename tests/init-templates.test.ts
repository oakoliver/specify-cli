/**
 * Tests for the legacy template helpers (now backed by core_pack/).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  copyTemplatesToProject,
  getAvailableCommands,
  getCommandTemplate,
  getTemplatesDir,
} from '../src/templates.js';

let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('legacy templates helpers', () => {
  test('getTemplatesDir points at core_pack, not the obsolete templates/ dir', () => {
    const dir = getTemplatesDir();
    expect(dir.replace(/\\/g, '/')).toMatch(/core_pack\/?$/);
    expect(existsSync(join(dir, 'commands', 'specify.md'))).toBe(true);
    expect(existsSync(join(dir, 'templates', 'spec-template.md'))).toBe(true);
  });

  test('getAvailableCommands lists core commands in legacy speckit.<name> form', () => {
    const cmds = getAvailableCommands();
    expect(cmds).toContain('speckit.specify');
    expect(cmds).toContain('speckit.converge');
    expect(cmds).toEqual([...cmds].sort());
  });

  test('getCommandTemplate accepts legacy and bare names and substitutes $ARGUMENTS', () => {
    const legacy = getCommandTemplate('speckit.specify', '{{args}}');
    const bare = getCommandTemplate('specify', '{{args}}');
    expect(legacy).not.toBeNull();
    expect(legacy).toBe(bare);
    expect(legacy!.includes('$ARGUMENTS')).toBe(false);
    expect(getCommandTemplate('speckit.nope', 'x')).toBeNull();
  });

  test('copyTemplatesToProject copies page templates and the selected script variant', () => {
    tmp = mkdtempSync(join(tmpdir(), 'specify-templates-'));
    copyTemplatesToProject(tmp, { scriptType: 'ps', agent: 'claude', agentArgs: '$ARGUMENTS' });
    expect(existsSync(join(tmp, '.specify/templates/plan-template.md'))).toBe(true);
    expect(existsSync(join(tmp, '.specify/templates/vscode-settings.json'))).toBe(false);
    expect(existsSync(join(tmp, '.specify/scripts/powershell/common.ps1'))).toBe(true);
    expect(existsSync(join(tmp, '.specify/scripts/bash'))).toBe(false);
    expect(readFileSync(join(tmp, '.specify/templates/spec-template.md'), 'utf-8').length).toBeGreaterThan(0);
  });
});
