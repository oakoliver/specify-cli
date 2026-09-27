/**
 * Events: command template resolution, script path confinement, the core
 * runner, and the generated Python dispatcher. Ports of
 * tests/specify_cli/events/test_events.py::TestCommandRunner.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  EVENTS_DISPATCHER_REL,
  EVENTS_DISPATCHER_TEMPLATE,
  EVENT_SCRIPT_PATH_CONFINEMENT,
  eventRuntimeHooks,
  findCommandTemplate,
  installIntegrationEvents,
  resolveAndRunEventCommand,
  resolveEventCommandArgv,
  type EventManifest,
} from '../src/events/index.js';
import { shlexQuote } from '../src/events/py-compat.js';
import { ExtensionRegistry } from '../src/extensions/registry.js';
import { ClaudeIntegration } from '../src/integrations/claude.js';
import { dumpYaml } from '../src/yaml.js';

const IS_WIN = process.platform === 'win32';
const PYTHON = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'pass']).status === 0) ?? null;

let root: string;
let tmp: string;
let stderrSpy: ReturnType<typeof spyOn>;
const originalWhich = eventRuntimeHooks.which;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'events-runner-')));
  tmp = path.join(root, 'proj');
  mkdirSync(tmp);
  stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  eventRuntimeHooks.which = originalWhich;
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer, base = tmp): string {
  const p = path.join(base, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

function coreTemplate(name: string, scripts: string): string {
  return write(`.specify/templates/commands/${name}.md`, `---\ndescription: "X"\nscripts:\n${scripts}---\nBody\n`);
}

function noopManifest(): EventManifest {
  return { files: {}, recordFile() {}, recordExisting() {}, remove() {} };
}

describe('findCommandTemplate', () => {
  test('not found no-ops gracefully', () => {
    expect(resolveAndRunEventCommand('nonexistent.command', 'session_start', '{}', tmp)).toBe(0);
    expect(stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('')).toContain(
      "Event command 'nonexistent.command' not found",
    );
  });

  test('extension command resolves via manifest when file stem differs (S8)', () => {
    write(
      '.specify/extensions/selftest/extension.yml',
      "schema_version: '1.0'\nextension:\n  id: selftest\n  name: Selftest\n  version: 1.0.0\n  description: test\n" +
        "requires:\n  speckit_version: '>=0.1'\nprovides:\n  commands:\n    - name: speckit.selftest.extension\n" +
        '      file: commands/selftest.md\n',
    );
    write('.specify/extensions/selftest/commands/selftest.md', '---\ndescription: "x"\n---\nBody\n');
    new ExtensionRegistry(path.join(tmp, '.specify', 'extensions')).add('selftest', { enabled: true });
    const [template, ext] = findCommandTemplate('speckit.selftest.extension', tmp);
    expect(template).not.toBeNull();
    expect(path.basename(template!)).toBe('selftest.md');
    expect(ext).toBe('selftest');
  });

  test('disabled extension command not resolved (S1)', () => {
    write(
      '.specify/extensions/my-ext/extension.yml',
      dumpYaml({
        schema_version: '1.0',
        extension: { id: 'my-ext', name: 'My Ext', version: '1.0.0', description: 'test' },
        requires: { speckit_version: '>=0.1' },
        provides: { commands: [{ name: 'speckit.my-ext.boot', file: 'commands/boot.md' }] },
      }),
    );
    write('.specify/extensions/my-ext/commands/boot.md', '---\ndescription: "x"\n---\nBody\n');
    new ExtensionRegistry(path.join(tmp, '.specify', 'extensions')).add('my-ext', { enabled: false });
    expect(findCommandTemplate('speckit.my-ext.boot', tmp)[0]).toBeNull();
    write('.specify/extensions/my-ext/commands/speckit.my-ext.boot.md', '---\ndescription: "x"\n---\nBody\n');
    expect(findCommandTemplate('speckit.my-ext.boot', tmp)[0]).toBeNull();
  });

  test('core project template then bundled core_pack fallback', () => {
    const p = write('.specify/templates/commands/plan.md', '---\ndescription: x\n---\n');
    expect(findCommandTemplate('speckit.plan', tmp)).toEqual([p, null]);
    const [bundled, ext] = findCommandTemplate('speckit.specify', tmp);
    expect(bundled).not.toBeNull();
    expect(bundled!.replace(/\\/g, '/')).toEndWith('core_pack/commands/specify.md');
    expect(ext).toBeNull();
  });
});

describe('resolveEventCommandArgv', () => {
  test('py variant anchored under .specify with interpreter prefix (S2)', () => {
    const t = coreTemplate('boot', '  py: scripts/python/boot.py\n');
    write('.specify/scripts/python/boot.py', 'import sys; sys.exit(0)\n');
    const argv = resolveEventCommandArgv(t, tmp, null);
    expect(argv).not.toBeNull();
    expect(argv!.length).toBe(2);
    expect(argv![1]!.replace(/\\/g, '/')).toEndWith('.specify/scripts/python/boot.py');
  });

  test('unparseable scripts value returns null', () => {
    const t = coreTemplate('boot', '  sh: scripts/bash/boot.sh "unclosed\n');
    expect(resolveEventCommandArgv(t, tmp, null)).toBeNull();
  });

  test('unreadable (non-UTF-8) template returns null', () => {
    const t = write('.specify/templates/commands/boot.md', Buffer.from('---\ndescription: "B\xff\xfeoot"\n---\nBody\n', 'latin1'));
    expect(resolveEventCommandArgv(t, tmp, null)).toBeNull();
    expect(resolveEventCommandArgv(path.join(tmp, 'missing.md'), tmp, null)).toBeNull();
  });

  test('ps variant prefixed with launcher; null when no launcher (no fake pwsh)', () => {
    const t = coreTemplate('boot', '  ps: scripts/powershell/boot.ps1\n');
    write('.specify/scripts/powershell/boot.ps1', 'exit 0\n');
    write('.specify/init-options.json', JSON.stringify({ script: 'ps' }));
    eventRuntimeHooks.which = (name) => (name === 'pwsh' ? '/usr/bin/pwsh' : null);
    const argv = resolveEventCommandArgv(t, tmp, null);
    expect(argv![0]).toBe('/usr/bin/pwsh');
    expect(argv![1]).toBe('-File');
    expect(argv![2]!.replace(/\\/g, '/')).toEndWith('.specify/scripts/powershell/boot.ps1');
    eventRuntimeHooks.which = () => null;
    expect(resolveEventCommandArgv(t, tmp, null)).toBeNull();
  });

  test('sh variant runs directly on POSIX, with trailing args', () => {
    const t = coreTemplate('boot', '  sh: scripts/bash/boot.sh --json "a b"\n');
    write('.specify/scripts/bash/boot.sh', '#!/bin/sh\nexit 0\n');
    const argv = resolveEventCommandArgv(t, tmp, null);
    if (!IS_WIN) {
      expect(argv![0]!).toEndWith('.specify/scripts/bash/boot.sh');
      expect(argv!.slice(1)).toEqual(['--json', 'a b']);
    }
  });

  test('absolute, dotdot-escaping, windows-drive and symlink-escaping tokens rejected', () => {
    const outside = write('outside-event-script.sh', '#!/bin/sh\nexit 0\n', root);
    const t1 = coreTemplate('abs', `  sh: ${outside}\n`);
    expect(resolveEventCommandArgv(t1, tmp, null)).toBeNull();
    const t2 = coreTemplate('dotdot', '  sh: ../../outside-event-script.sh\n');
    expect(resolveEventCommandArgv(t2, tmp, null)).toBeNull();
    const t3 = coreTemplate('drive', '  sh: C:/Windows/System32/cmd.exe\n');
    expect(resolveEventCommandArgv(t3, tmp, null)).toBeNull();
    mkdirSync(path.join(tmp, '.specify', 'scripts'), { recursive: true });
    symlinkSync(outside, path.join(tmp, '.specify', 'scripts', 'sneak.sh'));
    const t4 = coreTemplate('sneak', '  sh: scripts/sneak.sh\n');
    expect(resolveEventCommandArgv(t4, tmp, null)).toBeNull();
  });

  test('extension ../../scripts reaching core scripts resolves', () => {
    const t = write(
      '.specify/extensions/my-ext/commands/boot.md',
      '---\ndescription: "Boot"\nscripts:\n  sh: ../../scripts/bash/helper.sh\n---\nBody\n',
    );
    write('.specify/scripts/bash/helper.sh', '#!/bin/sh\nexit 0\n');
    const argv = resolveEventCommandArgv(t, tmp, 'my-ext');
    expect(argv).not.toBeNull();
    expect(argv![IS_WIN ? 1 : 0]!.replace(/\\/g, '/')).toEndWith('.specify/scripts/bash/helper.sh');
  });
});

describe.skipIf(IS_WIN)('resolveAndRunEventCommand', () => {
  test('executes the script with the payload in the project root', () => {
    coreTemplate('cwd', '  sh: scripts/cwd.sh\n');
    const out = path.join(tmp, 'cwd.out');
    const script = write('.specify/scripts/cwd.sh', `#!/bin/sh\npwd > ${shlexQuote(out)}\ncat >> ${shlexQuote(out)}\nexit 0\n`);
    chmodSync(script, 0o755);
    const prev = process.cwd();
    mkdirSync(path.join(tmp, 'sub'));
    process.chdir(path.join(tmp, 'sub'));
    try {
      expect(resolveAndRunEventCommand('speckit.cwd', 'session_start', '{"é": 1}', tmp)).toBe(0);
    } finally {
      process.chdir(prev);
    }
    expect(readFileSync(out, 'utf8')).toBe(`${tmp}\n{"é": 1}`);
  });

  test('stdout is emitted through the envelope; failures surface stderr + exit code', () => {
    coreTemplate('ctx', '  sh: scripts/ctx.sh\n');
    chmodSync(write('.specify/scripts/ctx.sh', '#!/bin/sh\necho hi\n'), 0o755);
    coreTemplate('fail', '  sh: scripts/fail.sh\n');
    chmodSync(write('.specify/scripts/fail.sh', '#!/bin/sh\necho boom >&2\nexit 3\n'), 0o755);
    const out: string[] = [];
    const spy = spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      out.push(String(c));
      return true;
    });
    try {
      expect(
        resolveAndRunEventCommand('speckit.ctx', 'session_start', '{}', tmp, {
          envelope: 'hookSpecificOutput',
          nativeEvent: 'SessionStart',
        }),
      ).toBe(0);
      expect(resolveAndRunEventCommand('speckit.fail', 'stop', '{}', tmp)).toBe(3);
    } finally {
      spy.mockRestore();
    }
    expect(out.join('')).toBe('{"hookSpecificOutput": {"additionalContext": "hi\\n", "hookEventName": "SessionStart"}}\n');
    expect(stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('')).toContain('boom\n');
  });

  test('timeout reports a clean error with exit code 2', () => {
    coreTemplate('slow', '  sh: scripts/slow.sh\n');
    chmodSync(write('.specify/scripts/slow.sh', '#!/bin/sh\nsleep 5\n'), 0o755);
    expect(resolveAndRunEventCommand('speckit.slow', 'stop', '{}', tmp, { timeout: 1 })).toBe(2);
    expect(stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('')).toContain('Event command speckit.slow timed out\n');
  });

  test('non-executable script reports errno-style error', () => {
    coreTemplate('noexec', '  sh: scripts/noexec.sh\n');
    write('.specify/scripts/noexec.sh', '#!/bin/sh\nexit 0\n');
    chmodSync(path.join(tmp, '.specify/scripts/noexec.sh'), 0o644);
    expect(resolveAndRunEventCommand('speckit.noexec', 'stop', '{}', tmp)).toBe(2);
    expect(stderrSpy.mock.calls.map((c: unknown[]) => c[0]).join('')).toContain(
      'Event command speckit.noexec error: [Errno 13] Permission denied:',
    );
  });
});

describe('generated dispatcher', () => {
  test('template is self-contained, confined and capped', () => {
    expect(EVENT_SCRIPT_PATH_CONFINEMENT).toBe(true);
    expect(EVENTS_DISPATCHER_TEMPLATE.startsWith('#!/usr/bin/env python3\n')).toBe(true);
    expect(EVENTS_DISPATCHER_TEMPLATE).toContain('EVENT_SCRIPT_PATH_CONFINEMENT');
    expect(EVENTS_DISPATCHER_TEMPLATE).toContain('from specify_cli.events import');
    expect(EVENTS_DISPATCHER_TEMPLATE).toContain('except (ImportError, TypeError):');
    expect(EVENTS_DISPATCHER_TEMPLATE).toContain('_script_under_base');
    expect(EVENTS_DISPATCHER_TEMPLATE).toContain('PureWindowsPath');
    expect(EVENTS_DISPATCHER_TEMPLATE).toContain('MAX_STDIN_BYTES = 1 * 1024 * 1024');
    expect(EVENTS_DISPATCHER_TEMPLATE).toContain('sys.argv[3]');
    expect(EVENTS_DISPATCHER_TEMPLATE).toContain('timeout=timeout');
    expect(EVENTS_DISPATCHER_TEMPLATE).toContain('m = re.match(r"^---\\n(.*?)\\n---", content, re.DOTALL)');
    expect(EVENTS_DISPATCHER_TEMPLATE).not.toContain('["specify"]');
  });

  describe.skipIf(IS_WIN || PYTHON === null)('executed with python', () => {
    function install(): string {
      installIntegrationEvents(new ClaudeIntegration(), tmp, noopManifest(), {
        session_start: [{ command: 'speckit.boot' }],
      });
      return path.join(tmp, EVENTS_DISPATCHER_REL);
    }

    function fakePkg(withEvents: string | null): Record<string, string> {
      const fakeDir = path.join(root, '_fake');
      write('specify_cli/__init__.py', '', fakeDir);
      if (withEvents !== null) write('specify_cli/events.py', withEvents, fakeDir);
      return { ...process.env, PYTHONPATH: fakeDir } as Record<string, string>;
    }

    test('inline fallback runs the script with the payload', () => {
      const dispatcher = install();
      coreTemplate('boot', '  sh: scripts/boot.sh\n');
      const out = path.join(tmp, 'payload.out');
      chmodSync(write('.specify/scripts/boot.sh', `#!/bin/sh\ncat > ${shlexQuote(out)}\nexit 0\n`), 0o755);
      const res = spawnSync(PYTHON!, [dispatcher, 'speckit.boot', 'session_start', '60'], {
        input: '{"tool_name":"é"}',
        env: fakePkg(null),
        cwd: tmp,
        encoding: 'utf8',
      });
      expect(res.status).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe('{"tool_name":"é"}');
    });

    test('stale specify_cli without confinement is not delegated to', () => {
      const dispatcher = install();
      const ran = path.join(tmp, 'stale-ran');
      coreTemplate('boot', '  sh: /tmp/outside.sh\n');
      const env = fakePkg(`def resolve_and_run_event_command(*_a, **_k):\n    open(${JSON.stringify(ran)}, 'w').write('delegated')\n    return 0\n`);
      spawnSync(PYTHON!, [dispatcher, 'speckit.boot', 'session_start', '60'], { input: '{}', env, cwd: tmp });
      expect(existsSync(ran)).toBe(false);
    });

    test('oversized stdin rejected by byte count', () => {
      const dispatcher = install();
      for (const payload of ['x'.repeat(1024 * 1024 + 10), '\u{1F600}'.repeat(300_000)]) {
        const res = spawnSync(PYTHON!, [dispatcher, 'speckit.boot', 'session_start', '60'], {
          input: payload,
          cwd: tmp,
          encoding: 'utf8',
        });
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('1 MiB limit');
      }
    });

    test('inline fallback rejects absolute script tokens', () => {
      const dispatcher = install();
      const marker = path.join(tmp, 'should-not-run.out');
      const host = write('host-boot.sh', `#!/bin/sh\necho ran > ${shlexQuote(marker)}\nexit 0\n`, root);
      chmodSync(host, 0o755);
      coreTemplate('boot', `  sh: ${host}\n`);
      const res = spawnSync(PYTHON!, [dispatcher, 'speckit.boot', 'session_start', '60'], {
        input: '{}',
        env: fakePkg(null),
        cwd: tmp,
      });
      expect(res.status).toBe(0);
      expect(existsSync(marker)).toBe(false);
    });
  });
});
