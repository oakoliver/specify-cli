/**
 * Port of upstream ``TestHookExecutorRegistration``,
 * ``TestHookInvocationRendering`` and the ``ConfigManager`` test classes
 * (tests/test_extensions.py) plus tests/test_command_template_hooks.py
 * condition semantics.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ConfigManager,
  DEFAULT_HOOK_PRIORITY,
  ExtensionManifest,
  ExtensionRegistry,
  HookExecutor,
} from '../src/extensions/index.js';
import { dumpYaml } from '../src/yaml.js';
import { type AnyDict, cleanupTempDirs, makeProjectDir, makeTempDir } from './extensions-helpers.js';

afterEach(cleanupTempDirs);

/** ExtensionManifest stub bypassing the file-based validation pipeline. */
function stubManifest(extId: string, hooks: AnyDict): ExtensionManifest {
  const m = Object.create(ExtensionManifest.prototype) as ExtensionManifest;
  Object.defineProperty(m, 'data', { value: { extension: { id: extId }, hooks }, writable: true });
  return m;
}

function project(initOptions?: AnyDict): string {
  const proj = makeProjectDir(makeTempDir());
  if (initOptions) writeFileSync(join(proj, '.specify', 'init-options.json'), JSON.stringify(initOptions));
  return proj;
}

describe('HookExecutor registration', () => {
  test('single mapping back compat', () => {
    const executor = new HookExecutor(project());
    executor.registerHooks(stubManifest('ext-a', { after_tasks: { command: 'speckit.ext-a.go' } }));
    const entries = executor.getProjectConfig().hooks.after_tasks;
    expect(entries).toHaveLength(1);
    expect(entries[0].extension).toBe('ext-a');
    expect(entries[0].command).toBe('speckit.ext-a.go');
    expect(entries[0].priority).toBe(DEFAULT_HOOK_PRIORITY);
    expect(entries[0].prompt).toBe('Execute speckit.ext-a.go?');
  });

  test('multiple entries same event', () => {
    const executor = new HookExecutor(project());
    executor.registerHooks(
      stubManifest('ext-a', {
        after_tasks: [
          { command: 'speckit.ext-a.first', description: '1st' },
          { command: 'speckit.ext-a.second', description: '2nd' },
        ],
      }),
    );
    const entries = executor.getProjectConfig().hooks.after_tasks;
    expect(entries.map((e: AnyDict) => e.command)).toEqual(['speckit.ext-a.first', 'speckit.ext-a.second']);
  });

  test('dedup on extension and command', () => {
    const executor = new HookExecutor(project());
    const hooks = {
      after_tasks: [
        { command: 'speckit.ext-a.first', description: 'v1' },
        { command: 'speckit.ext-a.second', description: 'v1' },
      ],
    };
    const manifest = stubManifest('ext-a', hooks);
    executor.registerHooks(manifest);
    hooks.after_tasks[0].description = 'v2';
    executor.registerHooks(manifest);
    const entries = executor.getProjectConfig().hooks.after_tasks;
    expect(entries).toHaveLength(2);
    expect(entries.find((e: AnyDict) => e.command === 'speckit.ext-a.first').description).toBe('v2');
  });

  test('shape change removes orphans; dropped events purged', () => {
    const executor = new HookExecutor(project());
    executor.registerHooks(
      stubManifest('ext-a', {
        after_tasks: [{ command: 'speckit.ext-a.first' }, { command: 'speckit.ext-a.second' }],
        before_plan: { command: 'speckit.ext-a.first' },
      }),
    );
    executor.registerHooks(stubManifest('ext-a', { after_tasks: { command: 'speckit.ext-a.first' } }));
    const hooks = executor.getProjectConfig().hooks;
    expect(hooks.after_tasks.map((e: AnyDict) => e.command)).toEqual(['speckit.ext-a.first']);
    expect(hooks.before_plan).toBeUndefined();
  });

  test('skips entries without command / non-dict entries; duplicate moves to end', () => {
    const executor = new HookExecutor(project());
    executor.registerHooks(
      stubManifest('ext-a', {
        after_tasks: [
          { command: 'speckit.ext-a.a', description: 'first' },
          { description: 'no command' },
          'garbage',
          { command: 'speckit.ext-a.b' },
          { command: 'speckit.ext-a.a', description: 'last' },
        ],
      }),
    );
    const entries = executor.getProjectConfig().hooks.after_tasks;
    expect(entries.map((e: AnyDict) => [e.command, e.description])).toEqual([
      ['speckit.ext-a.b', ''],
      ['speckit.ext-a.a', 'last'],
    ]);
  });

  test('preserves other extensions and unregister removes only own entries', () => {
    const executor = new HookExecutor(project());
    executor.registerHooks(stubManifest('ext-a', { after_tasks: { command: 'speckit.ext-a.go' } }));
    executor.registerHooks(stubManifest('ext-b', { after_tasks: { command: 'speckit.ext-b.go' } }));
    expect(executor.getProjectConfig().installed).toEqual(['ext-a', 'ext-b']);
    executor.unregisterHooks('ext-a');
    const cfg = executor.getProjectConfig();
    expect(cfg.installed).toEqual(['ext-b']);
    expect(cfg.hooks.after_tasks.map((e: AnyDict) => e.extension)).toEqual(['ext-b']);
  });

  test('get hooks for event sorts by priority, stable, corrupted = default', () => {
    const executor = new HookExecutor(project());
    executor.registerHooks(
      stubManifest('ext-a', {
        after_tasks: [
          { command: 'speckit.ext-a.late', priority: 50 },
          { command: 'speckit.ext-a.default' },
          { command: 'speckit.ext-a.early', priority: 1 },
        ],
      }),
    );
    const cfg = executor.getProjectConfig();
    cfg.hooks.after_tasks.push({ extension: 'ext-z', command: 'speckit.ext-z.bad', priority: 'bogus' });
    executor.saveProjectConfig(cfg);
    expect(executor.getHooksForEvent('after_tasks').map((h) => h.command)).toEqual([
      'speckit.ext-a.early',
      'speckit.ext-a.default',
      'speckit.ext-z.bad',
      'speckit.ext-a.late',
    ]);
  });

  test('extensions.yml written with PyYAML block style, insertion order', () => {
    const proj = project();
    const executor = new HookExecutor(proj);
    executor.registerHooks(stubManifest('ext-a', { after_tasks: { command: 'speckit.ext-a.go' } }));
    const text = readFileSync(join(proj, '.specify', 'extensions.yml'), 'utf-8');
    expect(text).toBe(
      'installed:\n- ext-a\nsettings:\n  auto_execute_hooks: true\nhooks:\n  after_tasks:\n  - extension: ext-a\n' +
        '    command: speckit.ext-a.go\n    enabled: true\n    optional: true\n    priority: 10\n' +
        "    prompt: Execute speckit.ext-a.go?\n    description: ''\n    condition: null\n",
    );
  });

  test('corrupt extensions.yml normalizes', () => {
    const proj = project();
    writeFileSync(join(proj, '.specify', 'extensions.yml'), 'hooks: [1]\ninstalled: nope\n');
    const cfg = new HookExecutor(proj).getProjectConfig();
    expect(cfg.hooks).toEqual({});
    expect(cfg.installed).toEqual([]);
    expect(cfg.settings).toEqual({ auto_execute_hooks: true });
  });
});

describe('HookExecutor invocation rendering', () => {
  const cases: Array<[AnyDict, string, string]> = [
    [{ ai: 'kimi', ai_skills: true }, 'speckit.tasks', '/skill:speckit-tasks'],
    [{ ai: 'codex', ai_skills: true }, 'speckit.tasks', '$speckit-tasks'],
    [{ ai: 'zcode', ai_skills: true }, 'speckit.tasks', '$speckit-tasks'],
    [{ ai: 'codex', ai_skills: 'true' }, 'speckit.tasks', '/speckit.tasks'],
    [{ ai: 'cline' }, 'speckit.tasks', '/speckit-tasks'],
    [{ ai: 'cline' }, 'speckit.git.commit', '/speckit-git-commit'],
    [{ ai: 'forge' }, 'speckit.git.commit', '/speckit-git-commit'],
    [{ ai: 'claude', ai_skills: false }, 'speckit.tasks', '/speckit.tasks'],
    [{ ai: 'claude', ai_skills: true }, 'speckit.git.commit', '/speckit-git-commit'],
    [{ ai: 'claude', ai_skills: true }, 'custom-command', '/custom-command'],
  ];
  for (const [opts, command, expected] of cases) {
    test(`${JSON.stringify(opts)} ${command} -> ${expected}`, () => {
      const executor = new HookExecutor(project(opts));
      const execution = executor.executeHook({ extension: 'test-ext', command, optional: false });
      expect(execution.command).toBe(command);
      expect(execution.invocation).toBe(expected);
    });
  }

  test('message falls back when invocation is empty', () => {
    const executor = new HookExecutor(project({ ai: 'kimi', ai_skills: false }));
    const message = executor.formatHookMessage('after_tasks', [
      { extension: 'test-ext', command: null, optional: false },
    ]);
    expect(message).toContain('Executing: `/<missing command>`');
    expect(message).toContain('EXECUTE_COMMAND: <missing command>');
    expect(message).toContain('EXECUTE_COMMAND_INVOCATION: /<missing command>');
  });

  test('optional hook message format', () => {
    const executor = new HookExecutor(project());
    const message = executor.formatHookMessage('after_tasks', [
      { extension: 'git', command: 'speckit.git.commit', optional: true, prompt: 'Commit?', description: 'Auto commit' },
    ]);
    expect(message).toBe(
      "\n## Extension Hooks\n\nHooks available for event 'after_tasks':\n\n\n" +
        '**Optional Hook**: git\nCommand: `/speckit.git.commit`\nDescription: Auto commit\n\nPrompt: Commit?\n' +
        'To execute: `/speckit.git.commit`',
    );
  });

  test('init options are cached per executor', () => {
    const proj = project({ ai: 'codex', ai_skills: true });
    const executor = new HookExecutor(proj);
    expect(executor.renderHookInvocation('speckit.plan')).toBe('$speckit-plan');
    writeFileSync(join(proj, '.specify', 'init-options.json'), JSON.stringify({ ai: 'claude' }));
    expect(executor.renderHookInvocation('speckit.plan')).toBe('$speckit-plan');
  });

  test('check hooks for event applies conditions', () => {
    const proj = project();
    const executor = new HookExecutor(proj);
    executor.registerHooks(
      stubManifest('ext-a', {
        after_tasks: [
          { command: 'speckit.ext-a.always' },
          { command: 'speckit.ext-a.never', condition: 'env.SPECKIT_TEST_NEVER_SET_VAR is set' },
        ],
      }),
    );
    delete process.env.SPECKIT_TEST_NEVER_SET_VAR;
    const result = executor.checkHooksForEvent('after_tasks');
    expect(result.has_hooks).toBe(true);
    expect(result.hooks.map((h) => h.command)).toEqual(['speckit.ext-a.always']);
    expect(executor.checkHooksForEvent('nothing')).toEqual({ has_hooks: false, hooks: [], message: '' });
  });
});

describe('HookExecutor conditions + ConfigManager', () => {
  function withExtension(extId: string, files: Record<string, string | AnyDict>, register = true): string {
    const proj = project();
    const dir = join(proj, '.specify', 'extensions', extId);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), typeof content === 'string' ? content : dumpYaml(content));
    }
    if (register) new ExtensionRegistry(join(proj, '.specify', 'extensions')).add(extId, { version: '1.0.0' });
    return proj;
  }

  test('config conditions: is set, ==, !=, bool normalization', () => {
    const proj = withExtension('jira', {
      'extension.yml': { config: { defaults: { connection: { url: 'https://x' }, enabled: true } } },
      'jira-config.yml': { project: { key: 'ABC' } },
    });
    const executor = new HookExecutor(proj);
    expect(executor.evaluateCondition('config.connection.url is set', 'jira')).toBe(true);
    expect(executor.evaluateCondition('config.missing is set', 'jira')).toBe(false);
    expect(executor.evaluateCondition("config.project.key == 'ABC'", 'jira')).toBe(true);
    expect(executor.evaluateCondition('config.project.key != "ABC"', 'jira')).toBe(false);
    expect(executor.evaluateCondition("config.enabled == 'true'", 'jira')).toBe(true);
    expect(executor.evaluateCondition('config.connection.url is set', null)).toBe(false);
    expect(executor.evaluateCondition('something weird', 'jira')).toBe(false);
  });

  test('env conditions', () => {
    const executor = new HookExecutor(project());
    process.env.SPECKIT_HOOK_TEST_VAR = 'yes';
    try {
      expect(executor.evaluateCondition('env.SPECKIT_HOOK_TEST_VAR is set', null)).toBe(true);
      expect(executor.evaluateCondition("env.speckit_hook_test_var == 'yes'", null)).toBe(true);
      expect(executor.evaluateCondition("env.SPECKIT_HOOK_TEST_VAR != 'yes'", null)).toBe(false);
    } finally {
      delete process.env.SPECKIT_HOOK_TEST_VAR;
    }
  });

  test('layering: defaults -> project -> local -> env', () => {
    const proj = withExtension('jira', {
      'extension.yml': { config: { defaults: { a: 1, nested: { x: 1, y: 1 } } } },
      'jira-config.yml': { nested: { y: 2 } },
      'local-config.yml': { b: 3 },
    });
    process.env.SPECKIT_JIRA_NESTED_Z = 'env';
    try {
      expect(new ConfigManager(proj, 'jira').getConfig()).toEqual({ a: 1, nested: { x: 1, y: 2, z: 'env' }, b: 3 });
    } finally {
      delete process.env.SPECKIT_JIRA_NESTED_Z;
    }
  });

  test('non-mapping YAML roots and config sections coerce to {}', () => {
    const proj = withExtension('jira', { 'extension.yml': 'config: [1, 2]\n', 'jira-config.yml': '- a\n- b\n' });
    const cm = new ConfigManager(proj, 'jira');
    expect(cm.getConfig()).toEqual({});
    expect(cm.hasValue('a')).toBe(false);
    expect(cm.getValue('a.b', 'dflt')).toBe('dflt');
    expect(new HookExecutor(proj).shouldExecuteHook({ extension: 'jira', condition: 'config.a is set' })).toBe(false);
  });

  test('env prefix collision: nested wins regardless of order', () => {
    const proj = withExtension('x', {});
    process.env.SPECKIT_X_CONNECTION = 'a';
    process.env.SPECKIT_X_CONNECTION_URL = 'b';
    process.env.SPECKIT_X_ = 'empty';
    process.env.SPECKIT_X__Y = 'double';
    try {
      const cfg = new ConfigManager(proj, 'x').getEnvConfig();
      expect(cfg.connection).toEqual({ url: 'b' });
      expect(cfg.y).toBe('double');
      expect(Object.keys(cfg).includes('')).toBe(false);
    } finally {
      for (const k of ['SPECKIT_X_CONNECTION', 'SPECKIT_X_CONNECTION_URL', 'SPECKIT_X_', 'SPECKIT_X__Y']) delete process.env[k];
    }
  });

  test('sibling owns longer prefix env; legacy absorption without sibling', () => {
    const proj = withExtension('git', {});
    process.env.SPECKIT_GIT_URL = 'for_git';
    process.env.SPECKIT_GIT_HOOKS_URL = 'for_git_hooks';
    try {
      expect(new ConfigManager(proj, 'git').getEnvConfig()).toEqual({ url: 'for_git', hooks: { url: 'for_git_hooks' } });
      new ExtensionRegistry(join(proj, '.specify', 'extensions')).add('git-hooks', { version: '1.0.0' });
      expect(new ConfigManager(proj, 'git').getEnvConfig()).toEqual({ url: 'for_git' });
      expect(new ConfigManager(proj, 'git-hooks').getEnvConfig()).toEqual({ url: 'for_git_hooks' });
    } finally {
      delete process.env.SPECKIT_GIT_URL;
      delete process.env.SPECKIT_GIT_HOOKS_URL;
    }
  });

  test('non-UTF-8 registry does not crash env config', () => {
    const proj = withExtension('git', {}, false);
    writeFileSync(join(proj, '.specify', 'extensions', '.registry'), Buffer.from([0xff, 0xfe]));
    process.env.SPECKIT_GIT_URL = 'u';
    try {
      expect(new ConfigManager(proj, 'git').getEnvConfig()).toEqual({ url: 'u' });
    } finally {
      delete process.env.SPECKIT_GIT_URL;
    }
  });
});
