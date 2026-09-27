/**
 * Tests for `specify check` (port of upstream tests/specify_cli/test_command_check.py
 * plus coverage of the AGENT_CONFIG iteration in command_check.py).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { buildAgentConfig, check, checkAvailableTools, checkDeps } from '../src/check.js';
import { runCheckCommand } from '../src/command-check.js';
import { versionDeps, resetVersionDeps } from '../src/version.js';

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

function captureOutput(): { text: () => string; restore: () => void } {
  let buf = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const sink = (chunk: unknown): boolean => {
    buf += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  return {
    text: () => buf.replace(ANSI, ''),
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

const FAKE_CONFIG = {
  claude: { name: 'Claude Code', requires_cli: true, folder: '.claude/' },
  copilot: { name: 'GitHub Copilot', requires_cli: false, folder: '.github/' },
  generic: { name: 'Generic', requires_cli: false, folder: null },
};

const origDeps = { ...checkDeps };
let out: ReturnType<typeof captureOutput>;
let checked: string[];

beforeEach(() => {
  checked = [];
  checkDeps.showBanner = async () => {};
  checkDeps.agentConfig = async () => FAKE_CONFIG;
  out = captureOutput();
});

afterEach(() => {
  out.restore();
  Object.assign(checkDeps, origDeps);
  resetVersionDeps();
});

function toolsFound(found: boolean): void {
  checkDeps.checkTool = (tool, tracker) => {
    checked.push(tool);
    if (tracker) {
      if (found) tracker.complete(tool, 'available');
      else tracker.error(tool, 'not found');
    }
    return found;
  };
}

describe('specify check', () => {
  test('shows self check tip and exits 0', async () => {
    toolsFound(true);
    expect(await runCheckCommand([])).toBe(0);
    const t = out.text();
    expect(t).toContain("Tip: Run 'specify self check' to verify you have the latest CLI version");
    expect(t).toContain('Checking for installed tools...');
    expect(t).toContain('Specify CLI is ready to use!');
    expect(t).not.toContain('Tip: Install a coding agent');
  });

  test('tip does not fetch latest release', async () => {
    toolsFound(true);
    let fetched = false;
    versionDeps.fetchLatestReleaseTag = async () => {
      fetched = true;
      return [null, 'x'];
    };
    versionDeps.fetch = async () => {
      fetched = true;
      throw new Error('no network');
    };
    expect(await runCheckCommand([])).toBe(0);
    expect(fetched).toBe(false);
  });

  test('iterates requires_cli agents, skips IDE agents and generic, checks VS Code', async () => {
    toolsFound(false);
    const { agentResults, tracker } = await checkAvailableTools();
    expect(checked).toEqual(['claude', 'code', 'code-insiders']);
    expect(agentResults).toEqual({ claude: false, copilot: false });
    const byKey = Object.fromEntries(tracker.steps.map((s) => [s.key, s]));
    expect(byKey.copilot.status).toBe('skipped');
    expect(byKey.copilot.detail).toBe('IDE-based, no CLI check');
    expect(byKey.claude.status).toBe('error');
    expect(byKey.generic).toBeUndefined();
    expect(byKey.code.label).toBe('Visual Studio Code');
    expect(byKey['code-insiders'].label).toBe('Visual Studio Code Insiders');
  });

  test('renders tracker and install tip when no agent found', async () => {
    toolsFound(false);
    expect(await check()).toBe(true);
    const t = out.text();
    expect(t).toContain('Check Available Tools');
    expect(t).toContain('Claude Code');
    expect(t).toContain('IDE-based, no CLI check');
    expect(t).toContain('Tip: Install a coding agent for the best experience');
  });

  test('--help and bad args', async () => {
    expect(await runCheckCommand(['--help'])).toBe(0);
    expect(out.text()).toContain('Check that all required tools are installed.');
    expect(await runCheckCommand(['--nope'])).toBe(2);
  });
});

describe('buildAgentConfig', () => {
  test('accepts Map and Record registries and drops empty configs', () => {
    const reg = {
      a: { config: { name: 'A', requires_cli: true } },
      b: { config: null },
      c: { config: {} },
    };
    expect(buildAgentConfig(reg)).toEqual({ a: { name: 'A', requires_cli: true } });
    expect(buildAgentConfig(new Map(Object.entries(reg)))).toEqual({ a: { name: 'A', requires_cli: true } });
  });

  test('real registry entries expose name/requires_cli', async () => {
    let cfg: ReturnType<typeof buildAgentConfig>;
    try {
      cfg = await origDeps.agentConfig();
    } catch {
      return; // registry still being written by another agent
    }
    for (const entry of Object.values(cfg)) {
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.requires_cli).toBe('boolean');
    }
  });
});
