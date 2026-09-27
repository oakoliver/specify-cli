/**
 * Dispatch / CLI invocation tests.
 *
 * Golden parity (tests/fixtures/integrations/dispatch.json, generated from
 * Python v1.0.12) for every registered integration: build_exec_args across
 * prompts/models/output modes/env overrides, build_command_invocation,
 * options, configs, separators and skills-mode defaults. Plus real
 * dispatch_command runs against fake executables.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INTEGRATION_REGISTRY, getIntegration } from '../src/integrations/index.js';
import { NotImplementedError, TimeoutExpired, captureWarnings, shlexSplit } from '../src/integrations/base.js';

const FIXTURES = join(import.meta.dir, 'fixtures', 'integrations');

interface DispatchFixture {
  invocations: Record<string, string>;
  exec: Array<[string, string | null, boolean, Record<string, string>, string[] | null | { error: string; message: string }]>;
  options: Array<[string, boolean, boolean, unknown, string]>;
  config: Record<string, unknown>;
  registrar_config: Record<string, unknown>;
  invoke_separator: string;
  multi_install_safe: boolean;
  effective_sep_default: string;
  effective_sep_skills: string;
  sep_for_mode: [string, string];
  is_skills_mode_default: boolean;
  is_skills_mode_skills: boolean;
  supports_events: boolean;
  command_filename: string;
}

const fixture = JSON.parse(readFileSync(join(FIXTURES, 'dispatch.json'), 'utf-8')) as Record<string, DispatchFixture>;

const savedEnv = { ...process.env };

function resetSpeckitEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SPECKIT_')) delete process.env[k];
  }
}

beforeEach(() => {
  resetSpeckitEnv();
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

describe('registry metadata parity', () => {
  test('41 integrations in upstream order', () => {
    expect(Object.keys(INTEGRATION_REGISTRY)).toEqual(Object.keys(fixture));
    expect(Object.keys(INTEGRATION_REGISTRY).length).toBe(41);
  });

  for (const [key, exp] of Object.entries(fixture)) {
    test(`${key} metadata`, () => {
      const integ = getIntegration(key)!;
      expect(integ.config).toEqual(exp.config as never);
      const reg = { ...(integ.registrarConfig ?? {}) } as Record<string, unknown>;
      delete reg.format_name;
      expect(reg).toEqual(exp.registrar_config);
      expect(integ.invokeSeparator).toBe(exp.invoke_separator);
      expect(integ.multiInstallSafe).toBe(exp.multi_install_safe);
      expect(integ.effectiveInvokeSeparator(null)).toBe(exp.effective_sep_default);
      expect(integ.effectiveInvokeSeparator({ skills: true })).toBe(exp.effective_sep_skills);
      expect([integ.invokeSeparatorForMode(true), integ.invokeSeparatorForMode(false)]).toEqual(exp.sep_for_mode);
      expect(integ.isSkillsMode(null)).toBe(exp.is_skills_mode_default);
      expect(integ.isSkillsMode({ skills: true })).toBe(exp.is_skills_mode_skills);
      expect(integ.supportsEvents()).toBe(exp.supports_events);
      expect(integ.commandFilename('plan')).toBe(exp.command_filename);
      expect(integ.options().map((o) => [o.name, o.isFlag, o.required, o.default, o.help])).toEqual(exp.options);
      for (const [spec, expected] of Object.entries(exp.invocations)) {
        const [name, args] = spec.split('|');
        expect({ spec, out: integ.buildCommandInvocation(name, args) }).toEqual({ spec, out: expected });
      }
    });
  }
});

describe('build_exec_args parity', () => {
  for (const [key, exp] of Object.entries(fixture)) {
    test(key, () => {
      const integ = getIntegration(key)!;
      const savedPath = process.env.PATH;
      process.env.PATH = '/usr/bin:/bin';
      try {
        for (const [prompt, model, outputJson, env, expected] of exp.exec) {
          resetSpeckitEnv();
          Object.assign(process.env, env);
          let actual: unknown;
          try {
            [actual] = captureWarnings(() =>
              integ.buildExecArgs(prompt, {
                model,
                outputJson,
                integrationArgs: key === 'docker-agent' ? ['./agent.yaml'] : null,
                integrationOptions: key === 'docker-agent' ? { agent: 'root', safety: 'strict' } : null,
                projectRoot: null,
              }),
            );
          } catch (exc) {
            actual = { error: (exc as Error).name, message: (exc as Error).message };
          }
          expect({ prompt, model, outputJson, env, actual }).toEqual({ prompt, model, outputJson, env, actual: expected });
        }
      } finally {
        process.env.PATH = savedPath;
      }
    });
  }
});

describe('runtime config validation', () => {
  test('default integrations reject per-step args/options', () => {
    const claude = getIntegration('claude')!;
    expect(() => claude.validateRuntimeConfig(['x'], null)).toThrow("Integration 'claude' does not support per-step 'integration_args'.");
    expect(() => claude.validateRuntimeConfig(null, { b: 1, a: 2 })).toThrow(
      "Integration 'claude' does not support per-step 'integration_options' (a, b).",
    );
  });

  test('docker-agent validation', () => {
    const d = getIntegration('docker-agent')!;
    expect(() => d.validateRuntimeConfig(['a', 'b'])).toThrow(/at most one/);
    expect(() => d.validateRuntimeConfig(['-x'])).toThrow(/must start with an agent configuration reference/);
    expect(() => d.validateRuntimeConfig(null, { model: 'x' })).toThrow(/command-step 'model' field/);
    expect(() => d.validateRuntimeConfig(null, { nope: 'x' })).toThrow("Docker Agent received unknown integration option(s): 'nope'. Supported options: agent, safety.");
    expect(() => d.validateRuntimeConfig(null, { safety: 'yolo' })).toThrow(/must be one of: autonomous, balanced, restricted, strict/);
    expect(() => d.buildExecArgs('p')).toThrow(/requires an agent configuration reference/);
  });

  test('extra args env var must be POSIX-quoted', () => {
    process.env.SPECKIT_INTEGRATION_CLAUDE_EXTRA_ARGS = '--x "unterminated';
    expect(() => getIntegration('claude')!.buildExecArgs('p')).toThrow(/is not parseable as a POSIX-quoted command line/);
  });

  test('shlexSplit', () => {
    expect(shlexSplit(`a "b c" 'd e' f\\ g`)).toEqual(['a', 'b c', 'd e', 'f g']);
    expect(() => shlexSplit('"x')).toThrow('No closing quotation');
  });

  test('copilot SPECKIT_ALLOW_ALL_TOOLS deprecation', () => {
    process.env.SPECKIT_ALLOW_ALL_TOOLS = '0';
    const [args, warnings] = captureWarnings(() => getIntegration('copilot')!.buildExecArgs('p', { outputJson: false }));
    expect(args).not.toContain('--yolo');
    expect(warnings[0].message).toContain('SPECKIT_ALLOW_ALL_TOOLS is deprecated');
  });

  test('agy allow-all and add-dir', () => {
    process.env.SPECKIT_AGY_ALLOW_ALL_TOOLS = 'yes';
    const args = getIntegration('agy')!.buildExecArgs('/speckit-plan', { outputJson: false, projectRoot: tmpdir() })!;
    expect(args[1]).toBe('--dangerously-skip-permissions');
    expect(args).toContain('--add-dir');
    expect(args.slice(-2)).toEqual(['--print', '/speckit-plan']);
  });
});

// ============================================================================
// dispatch_command against fake executables
// ============================================================================

describe('dispatch_command', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-dispatch-')));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function fakeExe(name: string, body: string): string {
    const p = join(tmp, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  test('captured mode returns stdout/stderr/exit code and runs in project root', () => {
    const exe = fakeExe('claude', 'echo "ARGS:$*"; pwd; echo err >&2; exit 3');
    process.env.SPECKIT_INTEGRATION_CLAUDE_EXECUTABLE = exe;
    const res = getIntegration('claude')!.dispatchCommand('speckit.plan', 'do it', { projectRoot: tmp, stream: false });
    expect(res.exit_code).toBe(3);
    expect(res.stdout).toBe(`ARGS:-p /speckit-plan do it --output-format json\n${tmp}\n`);
    expect(res.stderr).toBe('err\n');
  });

  test('object-style call (workflow engine form)', () => {
    const exe = fakeExe('codex', 'echo "$*"');
    process.env.SPECKIT_INTEGRATION_CODEX_EXECUTABLE = exe;
    const res = getIntegration('codex')!.dispatchCommand('speckit.git.commit', { args: 'x', stream: false, model: 'm' });
    expect(res.stdout).toBe('exec $speckit-git-commit x --model m --json\n');
  });

  test('copilot commands-mode dispatch uses --agent', () => {
    mkdirSync(join(tmp, '.github', 'agents'), { recursive: true });
    writeFileSync(join(tmp, '.github', 'agents', 'speckit.plan.agent.md'), 'x');
    const exe = fakeExe('copilot', 'echo "$*"');
    process.env.SPECKIT_INTEGRATION_COPILOT_EXECUTABLE = exe;
    const res = getIntegration('copilot')!.dispatchCommand('speckit.plan', 'go', { projectRoot: tmp, stream: false });
    expect(res.stdout).toBe('-p go --agent speckit.plan --yolo --output-format json\n');
  });

  test('bob dispatch detects legacy layout from project root', () => {
    mkdirSync(join(tmp, '.bob', 'commands'), { recursive: true });
    writeFileSync(join(tmp, '.bob', 'commands', 'speckit.plan.md'), 'x');
    const exe = fakeExe('bob', 'echo "$*"');
    process.env.SPECKIT_INTEGRATION_BOB_EXECUTABLE = exe;
    const res = getIntegration('bob')!.dispatchCommand('speckit.plan', '', { projectRoot: tmp, stream: false });
    expect(res.stdout).toBe('run --trust --accept-license -f json /speckit.plan\n');
  });

  test('unsupported dispatch raises NotImplementedError', () => {
    expect(() => getIntegration('zed')!.dispatchCommand('speckit.plan', '', { stream: false })).toThrow(NotImplementedError);
  });

  test('timeout raises TimeoutExpired', () => {
    const exe = fakeExe('claude', 'sleep 5');
    process.env.SPECKIT_INTEGRATION_CLAUDE_EXECUTABLE = exe;
    expect(() => getIntegration('claude')!.dispatchCommand('speckit.plan', '', { stream: false, timeout: 0.2 })).toThrow(TimeoutExpired);
  });
});
