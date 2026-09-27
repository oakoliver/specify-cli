/**
 * Events domain: layered resolution, extension event collection, manifest
 * validation, envelopes, dispatcher command quoting. Ports of
 * tests/specify_cli/events/test_events.py (TestResolveEvents,
 * TestCollectExtensionEvents, TestValidateEvents, TestContextInjectionEnvelopes,
 * TestDispatcherCommandQuoting, TestGeminiTimeoutUnit, override/matcher/timeout
 * validation classes).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  CANONICAL_EVENTS,
  collectExtensionEvents,
  contextEnvelopeFor,
  dispatcherCommand,
  emitEventStdout,
  eventsStaleExclusions,
  EVENTS_DISPATCHER_REL,
  nativeTimeout,
  resolveEvents,
  shellQuote,
  validateEvents,
} from '../src/events/index.js';
import { shlexQuote, shlexSplit } from '../src/events/py-compat.js';
import { ExtensionRegistry } from '../src/extensions/registry.js';
import { ClaudeIntegration } from '../src/integrations/claude.js';
import { CodexIntegration } from '../src/integrations/codex.js';
import { CopilotIntegration } from '../src/integrations/copilot.js';
import { CursorAgentIntegration } from '../src/integrations/cursor-agent.js';
import { GeminiIntegration } from '../src/integrations/gemini.js';
import { QwenIntegration } from '../src/integrations/qwen.js';
import { TabnineIntegration } from '../src/integrations/tabnine.js';
import { dumpYaml } from '../src/yaml.js';

let tmp: string;
let stderrSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'events-core-')));
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): string {
  const p = path.join(tmp, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function stderrText(): string {
  return stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
}

const BUILTIN = { events: { post_tool_use: { command: 'speckit.tdd.validate' } } };

// ============================================================================
// resolveEvents
// ============================================================================

describe('resolveEvents', () => {
  test('layer1 --events false returns empty', () => {
    expect(resolveEvents('claude', BUILTIN, tmp, { events: 'false' })).toEqual({});
    expect(resolveEvents('claude', BUILTIN, tmp, { events: false })).toEqual({});
    expect(resolveEvents('claude', BUILTIN, tmp, { events: 'OFF' })).toEqual({});
  });

  test('built-in defaults are wrapped in lists', () => {
    expect(resolveEvents('claude', BUILTIN, tmp, null)).toEqual({
      post_tool_use: [{ command: 'speckit.tdd.validate' }],
    });
  });

  test('extension events appended', () => {
    write('.specify/extensions/my-ext/extension.yml', 'events:\n  session_start:\n    command: speckit.my-ext.boot\n');
    const result = resolveEvents('claude', BUILTIN, tmp, null);
    expect(result.post_tool_use).toBeDefined();
    expect(result.session_start).toEqual([{ command: 'speckit.my-ext.boot' }]);
  });

  test('multiple extensions declaring the same event accumulate (#2)', () => {
    write('.specify/extensions/my-ext/extension.yml', 'events:\n  session_start:\n    command: speckit.my-ext.boot\n');
    write('.specify/extensions/other-ext/extension.yml', 'events:\n  session_start:\n    command: speckit.other.boot\n');
    expect(resolveEvents('claude', null, tmp, null).session_start).toEqual([
      { command: 'speckit.my-ext.boot' },
      { command: 'speckit.other.boot' },
    ]);
  });

  test('YAML override replaces baseline entirely', () => {
    write(
      '.specify/integration-events.yml',
      'integrations:\n  claude:\n    events:\n      stop:\n        command: speckit.override.stop\n',
    );
    expect(resolveEvents('claude', BUILTIN, tmp, null)).toEqual({ stop: [{ command: 'speckit.override.stop' }] });
  });

  test('explicit empty override disables events', () => {
    write('.specify/integration-events.yml', 'integrations:\n  claude:\n    events: {}\n');
    expect(resolveEvents('claude', BUILTIN, tmp, null)).toEqual({});
  });

  test('unreadable (non-UTF-8) override keeps prior layers', () => {
    write('.specify/integration-events.yml', Buffer.from([0xff, 0xfe]));
    expect(resolveEvents('claude', BUILTIN, tmp, null)).toEqual({
      post_tool_use: [{ command: 'speckit.tdd.validate' }],
    });
    expect(stderrText()).toContain('ignoring override');
  });

  test('no config yields no events', () => {
    expect(resolveEvents('claude', null, tmp, null)).toEqual({});
  });

  test('invalid override entry keeps prior layers (#10)', () => {
    write(
      '.specify/integration-events.yml',
      'integrations:\n  claude:\n    events:\n      bogus_event:\n        command: speckit.x\n',
    );
    expect(resolveEvents('claude', BUILTIN, tmp, null)).toEqual({
      post_tool_use: [{ command: 'speckit.tdd.validate' }],
    });
    expect(stderrText()).toContain("invalid event 'bogus_event': Unknown event 'bogus_event'");
  });

  test('empty handler override abandons override (C4)', () => {
    write('.specify/integration-events.yml', 'integrations:\n  claude:\n    events:\n      stop: []\n');
    expect(resolveEvents('claude', BUILTIN, tmp, null)).toEqual({
      post_tool_use: [{ command: 'speckit.tdd.validate' }],
    });
    expect(stderrText()).toContain("event 'stop' has no valid handler; ignoring entire override");
  });

  test('non-mapping integration entry abandons override (C6)', () => {
    write('.specify/integration-events.yml', 'integrations:\n  claude: bad\n');
    expect(resolveEvents('claude', BUILTIN, tmp, null)).toEqual({
      post_tool_use: [{ command: 'speckit.tdd.validate' }],
    });
    expect(stderrText()).toContain("entry for 'claude' is not a mapping; ignoring override");
  });

  test('non-string matcher in override is rejected (C10)', () => {
    write(
      '.specify/integration-events.yml',
      'integrations:\n  claude:\n    events:\n      stop:\n        command: speckit.x\n        matcher: []\n',
    );
    expect(resolveEvents('claude', BUILTIN, tmp, null)).toEqual({
      post_tool_use: [{ command: 'speckit.tdd.validate' }],
    });
  });

  test('malformed handler entries are skipped with a warning', () => {
    const result = resolveEvents('claude', { events: { stop: [{ command: 'speckit.a' }, 'nope'] } }, tmp, null);
    expect(result).toEqual({ stop: [{ command: 'speckit.a' }] });
    expect(stderrText()).toContain("Skipping malformed event handler (expected a mapping): 'nope'");
  });
});

// ============================================================================
// collectExtensionEvents
// ============================================================================

describe('collectExtensionEvents', () => {
  test('no extensions dir', () => {
    expect(collectExtensionEvents(tmp)).toEqual({});
  });

  test('extension without events', () => {
    write('.specify/extensions/my-ext/extension.yml', 'extension:\n  id: my-ext\n');
    expect(collectExtensionEvents(tmp)).toEqual({});
  });

  test('events collected', () => {
    write('.specify/extensions/my-ext/extension.yml', 'events:\n  pre_tool_use:\n    command: speckit.my-ext.check\n');
    expect(collectExtensionEvents(tmp)).toEqual({ pre_tool_use: [{ command: 'speckit.my-ext.check' }] });
  });

  test('invalid YAML skipped', () => {
    write('.specify/extensions/my-ext/extension.yml', 'invalid: - - -');
    expect(collectExtensionEvents(tmp)).toEqual({});
  });

  test('non-UTF-8 manifest skipped', () => {
    write('.specify/extensions/my-ext/extension.yml', Buffer.from([0xff, 0xfe]));
    expect(collectExtensionEvents(tmp)).toEqual({});
  });

  test('event command ref canonicalized via validated manifest (R1)', () => {
    write(
      '.specify/extensions/my-ext/extension.yml',
      dumpYaml({
        schema_version: '1.0',
        extension: { id: 'my-ext', name: 'My Ext', version: '1.0.0', description: 'test' },
        requires: { speckit_version: '>=0.1' },
        provides: { commands: [{ name: 'speckit.my-ext.boot', file: 'commands/boot.md' }] },
        events: { session_start: { command: 'my-ext.boot' } },
      }),
    );
    new ExtensionRegistry(path.join(tmp, '.specify', 'extensions')).add('my-ext', { enabled: true });
    expect(collectExtensionEvents(tmp)).toEqual({ session_start: [{ command: 'speckit.my-ext.boot' }] });
  });

  test('disabled extension events skipped; enabled collected', () => {
    for (const id of ['off-ext', 'on-ext']) {
      write(`.specify/extensions/${id}/extension.yml`, `events:\n  stop:\n    command: speckit.${id}.x\n`);
    }
    const reg = new ExtensionRegistry(path.join(tmp, '.specify', 'extensions'));
    reg.add('off-ext', { enabled: false });
    expect(collectExtensionEvents(tmp)).toEqual({ stop: [{ command: 'speckit.on-ext.x' }] });
  });
});

// ============================================================================
// validateEvents
// ============================================================================

describe('validateEvents', () => {
  test('unknown event rejected with sorted canonical list', () => {
    expect(() => validateEvents({ events: { bogus: { command: 'x' } } })).toThrow(
      "Unknown event 'bogus': must be one of ['post_tool_use', 'pre_tool_use', 'session_end', 'session_start', 'stop', 'user_prompt_submit']",
    );
  });

  test('all canonical events accepted', () => {
    for (const ev of CANONICAL_EVENTS) validateEvents({ events: { [ev]: { command: 'speckit.x' } } });
  });

  test('non-string and empty commands rejected (#17)', () => {
    expect(() => validateEvents({ events: { stop: { command: ['x'] } } })).toThrow(
      "Event 'stop' missing required 'command' string",
    );
    expect(() => validateEvents({ events: { stop: { command: '  ' } } })).toThrow("missing required 'command'");
  });

  test('events must be a mapping', () => {
    expect(() => validateEvents({ events: [] })).toThrow('Invalid events: expected a mapping');
    expect(() => validateEvents({ events: { stop: 'x' } })).toThrow("Invalid event 'stop': expected a mapping");
  });

  test('matcher and timeout validation', () => {
    expect(() => validateEvents({ events: { stop: { command: 'x', matcher: [] } } })).toThrow(
      "Event 'stop' has invalid 'matcher': must be a string",
    );
    for (const timeout of ['5', true, 0, -3, 1.5]) {
      expect(() => validateEvents({ events: { stop: { command: 'x', timeout } } })).toThrow(
        "Event 'stop' has invalid 'timeout': must be a positive integer",
      );
    }
    validateEvents({ events: { stop: { command: 'x', timeout: 30, matcher: 'Edit' } } });
  });
});

// ============================================================================
// Envelopes & dispatcher command
// ============================================================================

describe('emitEventStdout', () => {
  test('wraps output per envelope', () => {
    const out: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    try {
      const take = (): string => out.splice(0).join('');
      emitEventStdout('hello ctx', 'plain');
      expect(take()).toBe('hello ctx');
      emitEventStdout('hello ctx', 'hookSpecificOutput');
      expect(take()).toBe('{"hookSpecificOutput": {"additionalContext": "hello ctx"}}\n');
      emitEventStdout('hello ctx', 'hookSpecificOutput', 'SessionStart');
      expect(take()).toBe(
        '{"hookSpecificOutput": {"additionalContext": "hello ctx", "hookEventName": "SessionStart"}}\n',
      );
      emitEventStdout('hello ctx', 'additionalContext');
      expect(take()).toBe('{"additionalContext": "hello ctx"}\n');
      emitEventStdout('hello ctx', 'additional_context');
      expect(take()).toBe('{"additional_context": "hello ctx"}\n');
      emitEventStdout('héllo', 'hook_specific_output');
      expect(take()).toBe('{"decision": "allow", "hook_specific_output": {"additional_context": "h\\u00e9llo"}}\n');
      emitEventStdout('hello ctx', 'suppress');
      expect(take()).toBe('');
      emitEventStdout('', 'additionalContext');
      expect(take()).toBe('');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('dispatcherCommand', () => {
  test('envelope resolution and argument formatting', () => {
    const gemini = new GeminiIntegration();
    expect(contextEnvelopeFor(gemini, 'session_start')).toBe('hookSpecificOutput');
    expect(contextEnvelopeFor(gemini, 'pre_tool_use')).toBe('suppress');
    expect(dispatcherCommand(gemini, '/proj', 'speckit.boot', 'session_start')).toEndWith(
      ' 60 hookSpecificOutput SessionStart',
    );
    expect(dispatcherCommand(gemini, '/proj', 'speckit.prompt', 'user_prompt_submit')).toEndWith(
      ' 60 hookSpecificOutput BeforeAgent',
    );
    expect(dispatcherCommand(gemini, '/proj', 'speckit.guard', 'pre_tool_use')).toEndWith(' 60 suppress');

    const qwen = new QwenIntegration();
    expect(dispatcherCommand(qwen, '/proj', 'speckit.prompt', 'user_prompt_submit')).toEndWith(
      ' 60 hookSpecificOutput UserPromptSubmit',
    );

    const copilot = new CopilotIntegration();
    expect(dispatcherCommand(copilot, '/proj', 'speckit.boot', 'session_start')).toEndWith(' 60 additionalContext');

    const cursor = new CursorAgentIntegration();
    expect(contextEnvelopeFor(cursor, 'user_prompt_submit')).toBe('suppress');
    expect(dispatcherCommand(cursor, '/proj', 'speckit.boot', 'session_start')).toEndWith(' 60 additional_context');

    expect(contextEnvelopeFor(new ClaudeIntegration(), 'session_start')).toBeNull();
    expect(contextEnvelopeFor(new CodexIntegration(), 'session_start')).toBeNull();
  });

  test('metacharacters quoted for POSIX', () => {
    const cmd = dispatcherCommand(new ClaudeIntegration(), tmp, 'speckit.x; rm -rf /', 'pre_tool_use', {
      targetOs: 'posix',
    });
    expect(cmd).toContain("'speckit.x; rm -rf /'");
    expect(cmd).toBe(`python3 "\${CLAUDE_PROJECT_DIR}/.specify/events.py" 'speckit.x; rm -rf /' pre_tool_use 60`);
  });

  test('venv interpreter with spaces tokenizes back', () => {
    const proj = path.join(tmp, 'with space');
    mkdirSync(path.join(proj, '.venv', 'bin'), { recursive: true });
    writeFileSync(path.join(proj, '.venv', 'bin', 'python'), '#!/bin/sh\n');
    const cmd = dispatcherCommand(new ClaudeIntegration(), proj, 'speckit.x.y', 'stop', { targetOs: 'host' });
    expect(cmd.startsWith('.venv/bin/python ')).toBe(true);
    const tokens = shlexSplit(cmd);
    expect(tokens.some((t) => t.includes('events.py'))).toBe(true);
    expect(tokens).toContain('speckit.x.y');
    expect(tokens).toContain('stop');
  });

  test('windows target uses PowerShell quoting and call operator', () => {
    const cmd = dispatcherCommand(new CopilotIntegration(), tmp, 'speckit.x.y', 'session_start', {
      targetOs: 'windows',
    });
    expect(cmd).toBe("& 'python' '.specify/events.py' 'speckit.x.y' 'session_start' '60' 'additionalContext'");
  });

  test('host quoting leaves safe tokens bare; cmd quoting', () => {
    expect(shellQuote('python3', 'host')).toBe('python3');
    expect(shellQuote('speckit.x.y', 'host')).toBe('speckit.x.y');
    expect(shellQuote("it's", 'host')).toBe(`'it'"'"'s'`);
    expect(shellQuote('C:\\a b\\python.exe', 'cmd')).toBe('"C:\\a b\\python.exe"');
    expect(shellQuote('C:\\ab\\python.exe', 'cmd')).toBe('C:\\ab\\python.exe');
  });

  test('claude dispatcher double-quoted; timeout argument threaded', () => {
    const cmd = dispatcherCommand(new ClaudeIntegration(), tmp, 'speckit.x.y', 'stop', { timeoutSeconds: 300 });
    expect(cmd).toContain('"${CLAUDE_PROJECT_DIR}/.specify/events.py"');
    expect(cmd).toEndWith(' speckit.x.y stop 300');
  });

  test('gemini dispatcher timeout not unit-converted', () => {
    const cmd = dispatcherCommand(new GeminiIntegration(), tmp, 'speckit.x', 'stop', { timeoutSeconds: 90 });
    expect(cmd).toContain(' speckit.x stop 90');
  });
});

describe('nativeTimeout', () => {
  test('ms-based integrations convert', () => {
    expect(nativeTimeout(new GeminiIntegration(), 60)).toBe(60000);
    expect(nativeTimeout(new TabnineIntegration(), 60)).toBe(60000);
    expect(nativeTimeout(new QwenIntegration(), 60)).toBe(60000);
    expect(nativeTimeout(new ClaudeIntegration(), 60)).toBe(60);
    expect(nativeTimeout(new ClaudeIntegration(), 'bad')).toBe(60);
  });
});

describe('stale exclusions & helpers', () => {
  test('dispatcher always protected from stale cleanup (C3)', () => {
    const ex = eventsStaleExclusions('claude');
    expect(ex.has(EVENTS_DISPATCHER_REL)).toBe(true);
    expect(ex.has('.claude/settings.json')).toBe(true);
    const oc = eventsStaleExclusions('opencode');
    expect(oc.has('.opencode/plugin/speckit-events.ts')).toBe(true);
    expect(eventsStaleExclusions('no-such-integration').size).toBe(0);
  });

  test('shlex helpers match Python', () => {
    expect(shlexQuote('')).toBe("''");
    expect(shlexSplit(`a "b c" 'd e' f\\ g`)).toEqual(['a', 'b c', 'd e', 'f g']);
    expect(() => shlexSplit('scripts/bash/boot.sh "unclosed')).toThrow('No closing quotation');
  });
});
