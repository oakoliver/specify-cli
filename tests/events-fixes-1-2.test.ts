/**
 * Event fixes from spec-kit 1.1-1.2 (ports of the matching cases in upstream
 * tests/specify_cli/events/test_events.py): JSON configs with nothing owned are
 * left untouched (#5017), an override without `events` keeps prior layers
 * (#5102), collected extension handlers are validated one by one and explicit
 * null matcher/timeout are rejected (#5133), and merged JSON keeps non-ASCII
 * text readable (#4773).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { type EventManifest, installIntegrationEvents, resolveEvents, validateEvents } from '../src/events/index.js';
import { validateEvents as validateManifestEvents } from '../src/extensions/events-validation.js';
import { ValidationError } from '../src/extensions/errors.js';
import { ClaudeIntegration } from '../src/integrations/claude.js';
import { getIntegration } from '../src/integrations/index.js';

let tmp: string;
let stderr: string[];
let stderrSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'events-fixes-')));
  stderr = [];
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation(((s: string) => {
    stderr.push(String(s));
    return true;
  }) as never);
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

function fakeManifest(): EventManifest {
  return {
    files: {},
    recordFile() {},
    recordExisting() {},
    remove() {},
  } as unknown as EventManifest;
}

function write(rel: string, content: string | Buffer): string {
  const p = path.join(tmp, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

describe('JSON no-op removal (#5017)', () => {
  const USER_CONFIGS: Record<string, [string, string]> = {
    claude: [
      '.claude/settings.json',
      '{\n\t"hooks": {"Notification": [], "Stop": [{"hooks": [{"type": "command", "command": "./user-hook.sh"}]}]}\n}',
    ],
    copilot: [
      '.github/hooks/speckit.json',
      '{"version": 1, "hooks": {"agentStop": [], "sessionStart": [{"type": "command", "bash": "./user-hook.sh"}]}}',
    ],
    'cursor-agent': [
      '.cursor/hooks.json',
      '{"version": 1, "hooks": {"afterFileEdit": [], "stop": [{"command": "./user-hook.sh"}]}}',
    ],
    devin: [
      '.devin/hooks.v1.json',
      '{"Stop": [], "SessionStart": [{"matcher": "", "hooks": [{"type": "command", "command": "./user-hook.sh"}]}]}',
    ],
    opencode: ['opencode.json', '{"instructions": [], "plugin": ["./user-hook.ts"]}'],
  };

  for (const key of Object.keys(USER_CONFIGS).sort()) {
    test(`${key}: no events leaves the user config untouched`, () => {
      const [rel, original] = USER_CONFIGS[key];
      const p = write(rel, original);
      const mtime = statSync(p).mtimeMs;
      installIntegrationEvents(getIntegration(key)!, tmp, fakeManifest(), {});
      expect(readFileSync(p, 'utf8')).toBe(original);
      expect(statSync(p).mtimeMs).toBe(mtime);
    });

    test(`${key}: no events keeps an empty user config`, () => {
      const p = write(USER_CONFIGS[key][0], '{}');
      installIntegrationEvents(getIntegration(key)!, tmp, fakeManifest(), {});
      expect(readFileSync(p, 'utf8')).toBe('{}');
    });

    test(`${key}: no events still strips owned entries`, () => {
      const integration = getIntegration(key)!;
      const p = write(...USER_CONFIGS[key]);
      installIntegrationEvents(integration, tmp, fakeManifest(), { session_start: [{ command: 'speckit.boot' }] });
      const merged = readFileSync(p, 'utf8');
      expect(merged.includes('__speckit_event__') || merged.includes('speckit-events.ts')).toBe(true);
      installIntegrationEvents(integration, tmp, fakeManifest(), {});
      const cleaned = readFileSync(p, 'utf8');
      expect(cleaned).not.toContain('__speckit_event__');
      expect(cleaned).not.toContain('speckit-events.ts');
      expect(cleaned).toContain('./user-hook.');
    });
  }
});

describe('override without events keeps prior layers (#5102)', () => {
  for (const entry of ['{}', '{evnts: {stop: {command: speckit.typo}}}']) {
    test(entry, () => {
      write('.specify/extensions/my-ext/extension.yml', 'events:\n  session_start:\n    command: speckit.my-ext.boot\n');
      write('.specify/integration-events.yml', `integrations:\n  claude: ${entry}\n`);
      const result = resolveEvents(
        'claude',
        { events: { post_tool_use: { command: 'speckit.tdd.validate' } } },
        tmp,
        null,
      );
      expect(result).toEqual({
        post_tool_use: [{ command: 'speckit.tdd.validate' }],
        session_start: [{ command: 'speckit.my-ext.boot' }],
      });
      expect(stderr.join('')).toContain("'events' for 'claude' is not a mapping; ignoring override");
    });
  }
});

describe('collected extension events are validated (#5133)', () => {
  const INVALID: Array<[string, Record<string, unknown>]> = [
    ['matcher-list', { command: 'speckit.bad.check', matcher: ['Bash'] }],
    ['timeout-string', { command: 'speckit.bad.check', timeout: '30' }],
    ['timeout-null', { command: 'speckit.bad.check', timeout: null }],
    ['matcher-null', { command: 'speckit.bad.check', matcher: null }],
    ['missing-command', { matcher: 'Bash' }],
  ];
  for (const [id, invalid] of INVALID) {
    test(`an unregistered invalid handler does not break install (${id})`, () => {
      const valid = { command: 'speckit.staged.check', matcher: 'Bash' };
      write('.specify/extensions/staged/extension.yml', JSON.stringify({ events: { pre_tool_use: [invalid, valid] } }));
      const resolved = resolveEvents('claude', null, tmp, null);
      installIntegrationEvents(new ClaudeIntegration(), tmp, fakeManifest(), resolved);
      expect(resolved).toEqual({ pre_tool_use: [valid] });
      const config = JSON.parse(readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8'));
      const hooks = config.hooks.PreToolUse[0].hooks;
      expect(hooks.length).toBe(1);
      expect(hooks[0].command).toContain('speckit.staged.check');
      expect(stderr.join('')).toContain('staged');
      expect(stderr.join('')).toContain('pre_tool_use');
    });
  }

  for (const field of ['matcher', 'timeout']) {
    test(`an explicit null ${field} is rejected by manifest validation`, () => {
      const data = { events: { pre_tool_use: { command: 'speckit.test', [field]: null } } };
      expect(() => validateEvents(data)).toThrow(ValidationError);
      expect(() => validateEvents(data)).toThrow(field);
      expect(() => validateManifestEvents(data)).toThrow(field);
    });
  }
});

describe('merged JSON keeps non-ASCII text readable (#4773)', () => {
  test('user settings stay readable', () => {
    const p = write('.claude/settings.json', JSON.stringify({ env: { GREETING: 'Привіт — ¿qué tal? 日本語' } }));
    installIntegrationEvents(new ClaudeIntegration(), tmp, fakeManifest(), {
      pre_tool_use: [{ command: 'speckit.tdd.validate' }],
    });
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('Привіт — ¿qué tal? 日本語');
    expect(JSON.parse(text).env.GREETING).toBe('Привіт — ¿qué tal? 日本語');
  });

  test('an escaped lone surrogate is written back as its escape', () => {
    const p = write('.claude/settings.json', '{"env": {"ODD": "\\ud800"}}');
    installIntegrationEvents(new ClaudeIntegration(), tmp, fakeManifest(), {
      pre_tool_use: [{ command: 'speckit.tdd.validate' }],
    });
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('"\\ud800"');
    const data = JSON.parse(text);
    expect(data.env.ODD).toBe('\ud800');
    expect('PreToolUse' in data.hooks).toBe(true);
  });
});
