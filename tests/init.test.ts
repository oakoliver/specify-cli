/**
 * Tests for `specify init` (port of upstream command_init.py, spec-kit v1.0.12).
 *
 * Ports the key cases of upstream tests/specify_cli/test_command_init.py,
 * tests/integrations/test_cli.py (TestInitIntegrationFlag,
 * TestForceExistingDirectory, TestGitExtensionOptIn, TestExtensionFlag),
 * tests/test_branch_numbering.py, plus end-to-end layout checks whose expected
 * file lists were captured from a real upstream v1.0.12 run.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';

import {
  extSpecIsUrl,
  init,
  initHooks,
  list2cmdline,
  parseInitArgs,
  promptsAllowed,
  runInitCommand,
  shellQuoteArg,
  shlexQuote,
} from '../src/init.js';
import { cliErrorDetail, cliPhaseLabel } from '../src/app.js';
import { console as appConsole, setPromptInput, stripMarkup } from '../src/console.js';
import { UsageError } from '../src/cli-args.js';

// ============================================================================
// Harness
// ============================================================================

const ANSI = /\x1b\[[0-9;]*m/g;

let tmp: string;
let prevCwd: string;
const originalHooks = { ...initHooks };
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'specify-init-test-'));
  prevCwd = process.cwd();
  // Default: behave like a non-TTY CI session (CliRunner has no TTY either).
  initHooks.stdinIsInteractive = () => false;
  savedEnv.SPECKIT_INTEGRATION_DEFAULT = process.env.SPECKIT_INTEGRATION_DEFAULT;
  delete process.env.SPECKIT_INTEGRATION_DEFAULT;
  appConsole.width = 100;
});

afterEach(() => {
  process.chdir(prevCwd);
  Object.assign(initHooks, originalHooks);
  setPromptInput(null);
  if (savedEnv.SPECKIT_INTEGRATION_DEFAULT === undefined) delete process.env.SPECKIT_INTEGRATION_DEFAULT;
  else process.env.SPECKIT_INTEGRATION_DEFAULT = savedEnv.SPECKIT_INTEGRATION_DEFAULT;
  rmSync(tmp, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  output: string;
  /** Output with ANSI stripped and whitespace collapsed. */
  normalized: string;
}

/** Run `specify init <args>` with cwd = `cwd`, capturing console output. */
async function runInit(args: string[], cwd: string = tmp, input?: string[]): Promise<RunResult> {
  process.chdir(cwd);
  if (input) setPromptInput(input);
  else setPromptInput([]); // EOF for any confirm, like CliRunner without input=
  appConsole.beginCapture();
  let code: number;
  let output = '';
  try {
    code = await runInitCommand(args);
  } finally {
    output = appConsole.endCapture().replace(ANSI, '');
    process.chdir(prevCwd);
  }
  return { code, output, normalized: output.split(/\s+/).join(' ').trim() };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(root, p).split('\\').join('/'));
    }
  };
  walk(root);
  return out.sort();
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

const CORE_COMMANDS = [
  'analyze',
  'checklist',
  'clarify',
  'constitution',
  'converge',
  'implement',
  'plan',
  'specify',
  'tasks',
  'taskstoissues',
];

const SHARED_FILES = [
  '.specify/.gitignore',
  '.specify/init-options.json',
  '.specify/integration.json',
  '.specify/integrations/speckit.manifest.json',
  '.specify/memory/.constitution-template.json',
  '.specify/memory/constitution.md',
  '.specify/templates/checklist-template.md',
  '.specify/templates/constitution-template.md',
  '.specify/templates/plan-template.md',
  '.specify/templates/spec-template.md',
  '.specify/templates/tasks-template.md',
  '.specify/workflows/speckit/workflow.yml',
  '.specify/workflows/workflow-registry.json',
];

const SCRIPTS: Record<string, string[]> = {
  sh: [
    'check-prerequisites.sh',
    'common.sh',
    'create-new-feature.sh',
    'resolve-template.sh',
    'setup-plan.sh',
    'setup-tasks.sh',
  ].map((f) => `.specify/scripts/bash/${f}`),
  ps: [
    'check-prerequisites.ps1',
    'common.ps1',
    'create-new-feature.ps1',
    'resolve-template.ps1',
    'setup-plan.ps1',
    'setup-tasks.ps1',
  ].map((f) => `.specify/scripts/powershell/${f}`),
};

/** Expected tree (captured from upstream v1.0.12 `specify init`). */
function expectedTree(key: string, script: 'sh' | 'ps', agentFiles: string[]): string[] {
  return [...SHARED_FILES, ...SCRIPTS[script], `.specify/integrations/${key}.manifest.json`, ...agentFiles].sort();
}

// ============================================================================
// Argument parsing
// ============================================================================

describe('parseInitArgs', () => {
  test('parses project name and new flags', () => {
    const opts = parseInitArgs([
      'my-project',
      '--integration',
      'claude',
      '--integration-options=--skills',
      '--script',
      'ps',
      '--preset',
      'lean',
      '--extension',
      'git',
      '--extension',
      './local-ext',
      '--trust-extension-urls',
      '--non-interactive',
      '--ignore-agent-tools',
      '--force',
    ]);
    expect(opts.projectName).toBe('my-project');
    expect(opts.integration).toBe('claude');
    expect(opts.integrationOptions).toBe('--skills');
    expect(opts.scriptType).toBe('ps');
    expect(opts.preset).toBe('lean');
    expect(opts.extensions).toEqual(['git', './local-ext']);
    expect(opts.trustExtensionUrls).toBe(true);
    expect(opts.nonInteractive).toBe(true);
    expect(opts.ignoreAgentTools).toBe(true);
    expect(opts.force).toBe(true);
    expect(opts.here).toBe(false);
  });

  test('parses --here and dot', () => {
    expect(parseInitArgs(['--here']).here).toBe(true);
    expect(parseInitArgs(['.']).projectName).toBe('.');
  });

  test('accepts hidden deprecated no-op flags', () => {
    const opts = parseInitArgs(['p', '--skip-tls', '--debug', '--github-token', 'tok', '--offline']);
    expect(opts.skipTls).toBe(true);
    expect(opts.debug).toBe(true);
    expect(opts.githubToken).toBe('tok');
    expect(opts.offline).toBe(true);
  });

  const legacyFlags: string[][] = [
    ['--ai', 'claude'],
    ['--ai-skills'],
    ['--ai-commands-dir', '.x'],
    ['--no-git'],
    ['--branch-numbering', 'sequential'],
  ];
  for (const flag of legacyFlags) {
    test(`rejects removed legacy flag ${flag[0]}`, () => {
      expect(() => parseInitArgs(['proj', ...flag])).toThrow(UsageError);
      expect(() => parseInitArgs(['proj', ...flag])).toThrow(/No such option/);
    });
  }

  test('--no-git is rejected with exit code 2 by the CLI adapter', async () => {
    const r = await runInit(['--here', '--integration', 'claude', '--script', 'sh', '--no-git', '--ignore-agent-tools']);
    expect(r.code).toBe(2);
    expect(existsSync(join(tmp, '.specify'))).toBe(false);
  });
});

// ============================================================================
// Helpers
// ============================================================================

describe('helpers', () => {
  test('shellQuoteArg is host appropriate', () => {
    expect(shellQuoteArg('my-project', 'linux')).toBe('my-project');
    expect(shellQuoteArg('my project', 'linux')).toBe("'my project'");
    expect(shellQuoteArg('my project', 'win32')).toBe('"my project"');
    expect(shellQuoteArg('my-project', 'win32')).toBe('my-project');
  });

  test('shlexQuote matches Python shlex.quote', () => {
    expect(shlexQuote('')).toBe("''");
    expect(shlexQuote('a/b.c-d_e@f%g+h=i:j,k')).toBe('a/b.c-d_e@f%g+h=i:j,k');
    expect(shlexQuote("it's")).toBe(`'it'"'"'s'`);
    expect(shlexQuote('proj [v2]')).toBe("'proj [v2]'");
  });

  test('list2cmdline matches Python subprocess.list2cmdline', () => {
    expect(list2cmdline(['a b', 'c'])).toBe('"a b" c');
    expect(list2cmdline(['a"b'])).toBe('a\\"b');
    expect(list2cmdline([''])).toBe('""');
    expect(list2cmdline(['a\\ b\\'])).toBe('"a\\ b\\\\"');
  });

  test('extSpecIsUrl', () => {
    expect(extSpecIsUrl('https://example.com/x.zip')).toBe(true);
    expect(extSpecIsUrl('http://example.com/x.zip')).toBe(true);
    expect(extSpecIsUrl('git')).toBe(false);
    expect(extSpecIsUrl('./ext')).toBe(false);
    expect(extSpecIsUrl('C:\\ext')).toBe(false);
  });

  test('promptsAllowed honours --non-interactive even on a TTY', () => {
    initHooks.stdinIsInteractive = () => true;
    expect(promptsAllowed(false)).toBe(true);
    expect(promptsAllowed(true)).toBe(false);
    initHooks.stdinIsInteractive = () => false;
    expect(promptsAllowed(false)).toBe(false);
  });

  test('CLI diagnostic formatting', () => {
    expect(cliErrorDetail(new Error('line one\nline two'))).toBe('line one line two');
    expect(cliErrorDetail(new RangeError(''))).toBe('RangeError');
    expect(cliPhaseLabel('rollback', 'integration', 'codex')).toBe("rollback integration 'codex'");
  });
});

// ============================================================================
// Validation / error paths
// ============================================================================

describe('init validation', () => {
  test('unknown integration is rejected', async () => {
    const r = await runInit([join(tmp, 'test-project'), '--integration', 'nonexistent']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('Unknown integration');
    expect(r.output).toContain('Available integrations:');
  });

  test('invalid integration value is rendered literally (markup escaped)', async () => {
    const r = await runInit(['proj', '--integration', 'nope[/red]', '--ignore-agent-tools']);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('nope[/red]');
  });

  test('project name and --here are mutually exclusive', async () => {
    const r = await runInit(['proj', '--here', '--integration', 'claude']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('Cannot specify both project name and --here flag');
  });

  test('requires a project name or --here', async () => {
    const r = await runInit(['--integration', 'claude']);
    expect(r.code).toBe(1);
    expect(r.normalized).toContain("Must specify either a project name, use '.' for current directory, or use --here flag");
  });

  test('existing directory without --force errors', async () => {
    mkdirSync(join(tmp, 'existing-proj'));
    const r = await runInit([join(tmp, 'existing-proj'), '--integration', 'copilot', '--script', 'sh']);
    expect(r.code).toBe(1);
    expect(r.normalized).toContain('already exists');
    expect(r.output).toContain('Directory Conflict');
  });

  test('existing file (not a directory) errors', async () => {
    writeFileSync(join(tmp, 'afile'), 'x');
    const r = await runInit(['afile', '--integration', 'copilot']);
    expect(r.code).toBe(1);
    expect(r.output).toContain("'afile' exists but is not a directory.");
  });

  test('generic requires --integration-options', async () => {
    const r = await runInit(['proj', '--integration', 'generic', '--ignore-agent-tools']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('--integration generic requires --integration-options with --commands-dir');
    expect(existsSync(join(tmp, 'proj'))).toBe(false);
  });

  test('invalid script type', async () => {
    const r = await runInit(['proj', '--integration', 'claude', '--script', 'zsh', '--ignore-agent-tools']);
    expect(r.code).toBe(1);
    expect(r.output).toContain("Invalid script type 'zsh'. Choose from: sh, ps, py");
  });

  test('--here on non-empty dir with --non-interactive requires --force (no prompts)', async () => {
    initHooks.stdinIsInteractive = () => true;
    initHooks.selectWithArrows = () => {
      throw new Error('picker must not run under --non-interactive');
    };
    initHooks.confirm = () => {
      throw new Error('--non-interactive must not confirm');
    };
    const project = join(tmp, 'nonempty-here-flag');
    mkdirSync(project);
    writeFileSync(join(project, 'existing.txt'), 'keep me');
    const r = await runInit(
      ['--here', '--non-interactive', '--integration', 'copilot', '--ignore-agent-tools'],
      project,
    );
    expect(r.code).toBe(1);
    expect(r.output).toContain('--force');
    expect(r.output).toContain('--non-interactive');
    expect(readFileSync(join(project, 'existing.txt'), 'utf-8')).toBe('keep me');
  });

  test('--here on non-empty dir without input errors with --force guidance', async () => {
    const project = join(tmp, 'nonempty-here');
    mkdirSync(project);
    writeFileSync(join(project, 'existing.txt'), 'keep me');
    const r = await runInit(
      ['--here', '--integration', 'copilot', '--script', 'sh', '--ignore-agent-tools'],
      project,
    );
    expect(r.code).toBe(1);
    expect(r.output).toContain('no confirmation input is available');
    expect(r.output).toContain('--force');
    expect(existsSync(join(project, '.specify'))).toBe(false);
  });

  test('--here interactive cancel exits 0', async () => {
    initHooks.stdinIsInteractive = () => true;
    const project = join(tmp, 'cancel-here');
    mkdirSync(project);
    writeFileSync(join(project, 'existing.txt'), 'keep me');
    const r = await runInit(
      ['--here', '--integration', 'copilot', '--script', 'sh', '--ignore-agent-tools'],
      project,
    );
    expect(r.code).toBe(0);
    expect(r.output.toLowerCase()).toContain('cancelled');
    expect(r.output).not.toContain('--force');
    expect(existsSync(join(project, '.specify'))).toBe(false);
  });

  test('agent tool check fails when the CLI is missing', async () => {
    const savedPath = process.env.PATH;
    const savedHome = process.env.HOME;
    process.env.PATH = join(tmp, 'empty-bin');
    process.env.HOME = tmp;
    try {
      const r = await runInit(['proj', '--integration', 'gemini', '--script', 'sh']);
      expect(r.code).toBe(1);
      expect(r.output).toContain('Agent Detection Error');
      expect(r.output).toContain('--ignore-agent-tools');
    } finally {
      process.env.PATH = savedPath;
      process.env.HOME = savedHome;
    }
  });
});

// ============================================================================
// End-to-end layouts (expected trees captured from upstream v1.0.12)
// ============================================================================

describe('init end-to-end layouts', () => {
  const skills = (dir: string): string[] => CORE_COMMANDS.map((c) => `${dir}/speckit-${c}/SKILL.md`);
  const flat = (dir: string, ext: string): string[] => CORE_COMMANDS.map((c) => `${dir}/speckit.${c}.${ext}`);

  test('claude (sh) installs skills and shared infra', async () => {
    const r = await runInit(['proj', '--integration', 'claude', '--script', 'sh', '--ignore-agent-tools']);
    expect(r.code).toBe(0);
    const project = join(tmp, 'proj');
    expect(listFiles(project)).toEqual(expectedTree('claude', 'sh', skills('.claude/skills')));

    expect(readJson(join(project, '.specify/init-options.json'))).toEqual({
      ai: 'claude',
      ai_skills: true,
      feature_numbering: 'sequential',
      here: false,
      integration: 'claude',
      script: 'sh',
      speckit_version: readJson(join(project, '.specify/init-options.json'))['speckit_version'],
    });
    const state = readJson(join(project, '.specify/integration.json'));
    expect(state['integration']).toBe('claude');
    expect(state['default_integration']).toBe('claude');
    expect(state['installed_integrations']).toEqual(['claude']);
    expect(state['integration_settings']).toEqual({ claude: { script: 'sh', invoke_separator: '-' } });

    // Scripts are executable
    if (process.platform !== 'win32') {
      expect(statSync(join(project, '.specify/scripts/bash/common.sh')).mode & 0o111).not.toBe(0);
    }
    // Managed .specify/.gitignore
    expect(readFileSync(join(project, '.specify/.gitignore'), 'utf-8')).toContain('feature.json');

    // Output
    expect(r.output).toContain('Specify Project Setup');
    expect(r.output).toContain('Selected coding agent integration: claude');
    expect(r.output).toContain('Selected script type: sh');
    expect(r.output).toContain('Initialize Specify Project');
    expect(r.output).toContain('Install bundled workflow (speckit installed)');
    expect(r.output).toContain('Constitution setup (copied from template)');
    expect(r.output).toContain('Project ready.');
    expect(r.output).toContain('Agent Folder Security');
    expect(r.output).toContain('.claude/');
    expect(r.output).toContain('Start Claude in this project directory; spec-kit skills were installed to .claude/skills');
    expect(r.output).toContain('/speckit-constitution - Establish project principles');
    expect(r.output).toContain('Enhancement Skills');
  });

  test('copilot (ps) installs skills, no agent-context files', async () => {
    const r = await runInit(['proj', '--integration', 'copilot', '--script', 'ps', '--ignore-agent-tools']);
    expect(r.code).toBe(0);
    const project = join(tmp, 'proj');
    expect(listFiles(project)).toEqual(expectedTree('copilot', 'ps', skills('.github/skills')));
    const opts = readJson(join(project, '.specify/init-options.json'));
    expect(opts['integration']).toBe('copilot');
    expect(opts['ai_skills']).toBe(true);
    expect(opts['script']).toBe('ps');
    expect('context_file' in opts).toBe(false);
    expect(existsSync(join(project, '.github/copilot-instructions.md'))).toBe(false);
    expect(existsSync(join(project, '.specify/extensions/agent-context'))).toBe(false);
  });

  test('gemini (sh) installs TOML commands', async () => {
    const r = await runInit(['proj', '--integration', 'gemini', '--script', 'sh', '--ignore-agent-tools']);
    expect(r.code).toBe(0);
    const project = join(tmp, 'proj');
    expect(listFiles(project)).toEqual(expectedTree('gemini', 'sh', flat('.gemini/commands', 'toml')));
    expect('ai_skills' in readJson(join(project, '.specify/init-options.json'))).toBe(false);
    expect(r.output).toContain('/speckit.plan - Create implementation plan');
    expect(r.output).toContain('Enhancement Commands');
  });

  test('codex (sh) installs .agents/skills and prints $ invocations', async () => {
    const r = await runInit(['proj', '--integration', 'codex', '--script', 'sh', '--ignore-agent-tools']);
    expect(r.code).toBe(0);
    const project = join(tmp, 'proj');
    expect(listFiles(project)).toEqual(expectedTree('codex', 'sh', skills('.agents/skills')));
    expect(r.output).toContain('$speckit-constitution');
    expect(r.output).toContain('Start Codex in this project directory');
  });

  test('generic with --commands-dir', async () => {
    const r = await runInit([
      'proj',
      '--integration',
      'generic',
      '--integration-options',
      '--commands-dir .myagent/commands/',
      '--script',
      'sh',
      '--ignore-agent-tools',
    ]);
    expect(r.code).toBe(0);
    const project = join(tmp, 'proj');
    expect(listFiles(project)).toEqual(expectedTree('generic', 'sh', flat('.myagent/commands', 'md')));
    const state = readJson(join(project, '.specify/integration.json'));
    expect(state['integration_settings']).toEqual({
      generic: {
        script: 'sh',
        raw_options: '--commands-dir .myagent/commands/',
        parsed_options: { commands_dir: '.myagent/commands/' },
        invoke_separator: '.',
      },
    });
    // Security notice names the commands dir for folder-less generic
    expect(r.output).toContain('.myagent/commands/');
  });

  test('py script type installs python scripts', async () => {
    const r = await runInit(['proj', '--integration', 'opencode', '--script', 'py', '--ignore-agent-tools']);
    expect(r.code).toBe(0);
    const project = join(tmp, 'proj');
    expect(existsSync(join(project, '.specify/scripts/python/common.py'))).toBe(true);
    expect(readJson(join(project, '.specify/init-options.json'))['script']).toBe('py');
  });
});

// ============================================================================
// Behavioural cases (ported from upstream tests/integrations/test_cli.py)
// ============================================================================

describe('init behaviour', () => {
  test('non-interactive init defaults to copilot', async () => {
    initHooks.selectWithArrows = () => {
      throw new Error('non-interactive init should not open the integration picker');
    };
    const project = join(tmp, 'noninteractive');
    const r = await runInit([project, '--script', 'sh', '--ignore-agent-tools']);
    expect(r.code).toBe(0);
    expect(r.output).toContain("defaulting to 'copilot'");
    expect(existsSync(join(project, '.github/skills/speckit-plan/SKILL.md'))).toBe(true);
    expect(readJson(join(project, '.specify/integration.json'))['integration']).toBe('copilot');
  });

  test('--non-interactive skips pickers even when stdin is a TTY', async () => {
    initHooks.stdinIsInteractive = () => true;
    initHooks.selectWithArrows = () => {
      throw new Error('--non-interactive must not open select_with_arrows even on a TTY');
    };
    const project = join(tmp, 'agent-pty');
    const r = await runInit([project, '--non-interactive', '--ignore-agent-tools']);
    expect(r.code).toBe(0);
    expect(r.output).toContain("defaulting to 'copilot'");
    expect(readJson(join(project, '.specify/init-options.json'))['script']).toBe(
      process.platform === 'win32' ? 'ps' : 'sh',
    );
  });

  test('non-interactive default honours SPECKIT_INTEGRATION_DEFAULT', async () => {
    process.env.SPECKIT_INTEGRATION_DEFAULT = 'gemini';
    const project = join(tmp, 'noninteractive_env');
    const r = await runInit([project, '--script', 'sh', '--ignore-agent-tools']);
    expect(r.code).toBe(0);
    expect(r.output).toContain("defaulting to 'gemini'");
    expect(readJson(join(project, '.specify/integration.json'))['integration']).toBe('gemini');
  });

  test('interactive picker default honours SPECKIT_INTEGRATION_DEFAULT', async () => {
    initHooks.stdinIsInteractive = () => true;
    process.env.SPECKIT_INTEGRATION_DEFAULT = 'gemini';
    const captured: Record<string, string | null> = {};
    initHooks.selectWithArrows = async (_options, promptText, defaultKey) => {
      if (promptText.includes('Choose your coding agent integration')) captured.defaultKey = defaultKey;
      return defaultKey as string;
    };
    const project = join(tmp, 'interactive_env');
    const r = await runInit([project, '--script', 'sh', '--ignore-agent-tools']);
    expect(r.code).toBe(0);
    expect(captured.defaultKey).toBe('gemini');
    expect(readJson(join(project, '.specify/integration.json'))['integration']).toBe('gemini');
  });

  test('--force merges into an existing directory and keeps user files', async () => {
    const target = join(tmp, 'existing-proj');
    mkdirSync(target);
    writeFileSync(join(target, 'user-file.txt'), 'keep me');
    const r = await runInit([target, '--integration', 'copilot', '--force', '--script', 'sh']);
    expect(r.code).toBe(0);
    expect(readFileSync(join(target, 'user-file.txt'), 'utf-8')).toBe('keep me');
    expect(existsSync(join(target, '.specify/init-options.json'))).toBe(true);
    expect(existsSync(join(target, '.specify/templates/spec-template.md'))).toBe(true);
    expect(r.output).toContain('--force supplied: merging into existing directory');
  });

  test('--here --force overwrites shared infra', async () => {
    const project = join(tmp, 'e2e-force');
    const scriptsDir = join(project, '.specify/scripts/bash');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'common.sh'), '# user-modified common.sh\n');
    const r = await runInit(['--here', '--force', '--integration', 'copilot', '--script', 'sh'], project);
    expect(r.code).toBe(0);
    expect(readFileSync(join(scriptsDir, 'common.sh'), 'utf-8')).not.toBe('# user-modified common.sh\n');
    expect(readJson(join(project, '.specify/init-options.json'))['here']).toBe(true);
    expect(r.output).toContain("You're already in the project directory!");
  });

  test('--here with piped "y" preserves customized shared infra', async () => {
    const project = join(tmp, 'e2e-no-force');
    const scriptsDir = join(project, '.specify/scripts/bash');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'common.sh'), '# user-modified common.sh\n');
    const r = await runInit(['--here', '--integration', 'copilot', '--script', 'sh'], project, ['y']);
    expect(r.code).toBe(0);
    expect(readFileSync(join(scriptsDir, 'common.sh'), 'utf-8')).toBe('# user-modified common.sh\n');
    expect(r.output).toContain('not updated');
  });

  test('--here --force with claude replaces pre-existing skill content', async () => {
    const project = join(tmp, 'claude-here-existing');
    const skill = join(project, '.claude/skills/speckit-specify/SKILL.md');
    mkdirSync(join(project, '.claude/skills/speckit-specify'), { recursive: true });
    writeFileSync(skill, '# preexisting command\n');
    const r = await runInit(
      ['--here', '--force', '--integration', 'claude', '--script', 'sh', '--ignore-agent-tools'],
      project,
    );
    expect(r.code).toBe(0);
    expect(readFileSync(skill, 'utf-8')).toContain('speckit-specify');
    expect(existsSync(join(project, '.claude/skills/speckit-plan/SKILL.md'))).toBe(true);
  });

  test('re-running --here --force keeps the workflow and constitution', async () => {
    const project = join(tmp, 'rerun');
    mkdirSync(project);
    const args = ['--here', '--force', '--integration', 'claude', '--script', 'sh', '--ignore-agent-tools'];
    expect((await runInit(args, project)).code).toBe(0);
    writeFileSync(join(project, '.specify/memory/constitution.md'), '# Mine\n');
    const r2 = await runInit(args, project);
    expect(r2.code).toBe(0);
    expect(r2.output).toContain('Install bundled workflow (already installed)');
    expect(r2.output).toContain('Constitution setup (existing file preserved)');
    expect(readFileSync(join(project, '.specify/memory/constitution.md'), 'utf-8')).toBe('# Mine\n');
  });

  test('git extension is opt-in (not installed by default)', async () => {
    const project = join(tmp, 'git-opt-in');
    mkdirSync(project);
    const r = await runInit(['--here', '--integration', 'claude', '--script', 'sh', '--ignore-agent-tools'], project);
    expect(r.code).toBe(0);
    expect(existsSync(join(project, '.specify/extensions/git'))).toBe(false);
    const gitSkills = readdirSync(join(project, '.claude/skills')).filter((n) => n.startsWith('speckit-git-'));
    expect(gitSkills).toEqual([]);
  });
});

describe('init failure handling', () => {
  test('failure prints the Failure panel and debug environment, exits 1', async () => {
    const target = join(tmp, 'broken');
    mkdirSync(target);
    // A file where the agent folder should be makes integration setup throw.
    writeFileSync(join(target, '.claude'), 'not a directory');
    const r = await runInit([target, '--force', '--integration', 'claude', '--script', 'sh', '--ignore-agent-tools', '--debug']);
    expect(r.code).toBe(1);
    expect(r.output).toContain('Failure');
    expect(r.normalized).toContain('Initialization failed:');
    expect(r.output).toContain('Debug Environment');
    // Pre-existing directory is not removed on failure.
    expect(existsSync(target)).toBe(true);
  });

  test('unreadable integration state aborts before setup', async () => {
    const target = join(tmp, 'broken-state');
    mkdirSync(target);
    writeFileSync(join(target, '.specify'), 'not a directory');
    const r = await runInit([target, '--force', '--integration', 'claude', '--script', 'sh', '--ignore-agent-tools']);
    expect(r.code).toBe(1);
    expect(r.normalized).toContain('Please fix file permissions or delete .specify/integration.json and retry.');
  });
});

// ============================================================================
// Markup escaping / next-steps cd line (upstream test_command_init.py)
// ============================================================================

describe('init output escaping', () => {
  const genericArgs = (name: string): string[] => [
    name,
    '--integration',
    'generic',
    '--integration-options',
    '--commands-dir .agent/commands',
    '--ignore-agent-tools',
    '--offline',
  ];

  function cdArgument(output: string): string {
    const marker = 'Go to the project folder: cd ';
    for (const line of output.split('\n')) {
      const idx = line.indexOf(marker);
      if (idx >= 0) return line.slice(idx + marker.length).trimEnd().replace(/│$/, '').trimEnd();
    }
    throw new Error(`no cd line in output:\n${output}`);
  }

  test.each(['proj [v2]', 'my[bold]app', 'app[/red]x'])('cd line shows the real project name: %s', async (name) => {
    const r = await runInit(genericArgs(name));
    expect(r.code).toBe(0);
    expect(existsSync(join(tmp, name))).toBe(true);
    expect(cdArgument(r.output)).toBe(shellQuoteArg(name));
  });

  test.each(['proj v2', 'my project'])('cd line quotes whitespace: %s', async (name) => {
    const r = await runInit(genericArgs(name));
    expect(r.code).toBe(0);
    const printed = cdArgument(r.output);
    expect(printed).not.toBe(name);
    expect(printed).toBe(shellQuoteArg(name));
  });

  test('ordinary name is not quoted', async () => {
    const r = await runInit(genericArgs('my-project'));
    expect(r.code).toBe(0);
    expect(cdArgument(r.output)).toBe('my-project');
  });

  test('stripMarkup sanity for escaped names', () => {
    expect(stripMarkup('[cyan]x[/cyan]')).toBe('x');
  });
});

// ============================================================================
// Extensions / presets during init
// ============================================================================

describe('init --extension / --preset', () => {
  async function runExt(extra: string[], name: string): Promise<[string, RunResult]> {
    const project = join(tmp, name);
    mkdirSync(project, { recursive: true });
    initHooks.getSpeckitVersion = () => '0.8.2';
    const r = await runInit(
      ['--here', '--integration', 'copilot', '--script', 'sh', '--ignore-agent-tools', ...extra],
      project,
    );
    return [project, r];
  }

  test('bundled extension installed', async () => {
    const [project, r] = await runExt(['--extension', 'git'], 'ext-bundled');
    expect(r.code).toBe(0);
    expect(existsSync(join(project, '.specify/extensions/git/extension.yml'))).toBe(true);
    expect(r.normalized).toContain('Install extension: git');
  });

  test('local path extension installed', async () => {
    const bundledGit = join(import.meta.dir, '..', 'core_pack', 'extensions', 'git');
    const [project, r] = await runExt(['--extension', bundledGit], 'ext-local');
    expect(r.code).toBe(0);
    expect(existsSync(join(project, '.specify/extensions/git'))).toBe(true);
  });

  test('unknown extension records a tracker error but does not abort', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network disabled in tests');
    }) as unknown as typeof fetch;
    try {
      const [, r] = await runExt(['--extension', 'nonexistent-xyz-ext'], 'ext-unknown');
      expect(r.code).toBe(0);
      expect(r.normalized.toLowerCase()).toContain('failed');
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test('untrusted URL extension is skipped non-interactively (default-deny)', async () => {
    let fetched = false;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error('should not fetch');
    }) as unknown as typeof fetch;
    try {
      const [project, r] = await runExt(['--extension', 'https://example.com/git.zip'], 'ext-url-denied');
      expect(r.code).toBe(0);
      expect(fetched).toBe(false);
      expect(r.normalized.toLowerCase()).toContain('untrusted url');
      expect(r.output).toContain('--trust-extension-urls');
      expect(existsSync(join(project, '.specify/extensions/git'))).toBe(false);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });

  test('non-HTTPS URL is rejected but init continues', async () => {
    const [project, r] = await runExt(
      ['--extension', 'http://example.com/ext.zip', '--trust-extension-urls'],
      'ext-http',
    );
    expect(r.code).toBe(0);
    expect(r.normalized.toLowerCase()).toContain('failed');
    expect(existsSync(join(project, '.specify/extensions/ext'))).toBe(false);
  });

  test('--extension and --preset can be combined', async () => {
    const [project, r] = await runExt(['--extension', 'git', '--preset', 'lean'], 'ext-preset');
    expect(r.code).toBe(0);
    expect(existsSync(join(project, '.specify/extensions/git'))).toBe(true);
    expect(existsSync(join(project, '.specify/presets/lean'))).toBe(true);
  });

  test('local preset seeds the constitution from its constitution-template', async () => {
    const presetDir = join(tmp, 'constitution-preset');
    mkdirSync(join(presetDir, 'organization'), { recursive: true });
    writeFileSync(join(presetDir, 'organization', 'ratified.md'), '# Ratified Organization Constitution\n');
    writeFileSync(
      join(presetDir, 'preset.yml'),
      [
        "schema_version: '1.0'",
        'preset:',
        '  id: constitution-preset',
        '  name: Constitution Preset',
        "  version: '1.0.0'",
        '  description: Provides a ratified constitution',
        'requires:',
        "  speckit_version: '>=0.1.0'",
        'provides:',
        '  templates:',
        '  - type: template',
        '    name: constitution-template',
        '    file: organization/ratified.md',
        '    strategy: replace',
        '',
      ].join('\n'),
    );
    const project = join(tmp, 'init-with-preset');
    const r = await runInit([
      project,
      '--integration',
      'copilot',
      '--script',
      'sh',
      '--ignore-agent-tools',
      '--preset',
      presetDir,
    ]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(project, '.specify/memory/constitution.md'), 'utf-8')).toBe(
      '# Ratified Organization Constitution\n',
    );
  });

  test('unknown preset warns and continues', async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network disabled in tests');
    }) as unknown as typeof fetch;
    try {
      const [, r] = await runExt(['--preset', 'no-such-preset-xyz'], 'preset-missing');
      expect(r.code).toBe(0);
      expect(r.normalized).toContain('Project ready');
      expect(r.normalized).toMatch(/Preset 'no-such-preset-xyz'|Failed to install preset 'no-such-preset-xyz'/);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
});

// ============================================================================
// Programmatic API
// ============================================================================

describe('init() programmatic API', () => {
  test('returns exit code and scaffolds', async () => {
    process.chdir(tmp);
    appConsole.beginCapture();
    let code: number;
    try {
      code = await init({ projectName: 'api-proj', integration: 'claude', scriptType: 'sh', ignoreAgentTools: true });
    } finally {
      appConsole.endCapture();
      process.chdir(prevCwd);
    }
    expect(code).toBe(0);
    expect(existsSync(join(tmp, 'api-proj/.claude/skills/speckit-plan/SKILL.md'))).toBe(true);
  });

  test('returns 1 on validation errors', async () => {
    process.chdir(tmp);
    appConsole.beginCapture();
    let code: number;
    try {
      code = await init({ integration: 'claude' });
    } finally {
      appConsole.endCapture();
      process.chdir(prevCwd);
    }
    expect(code).toBe(1);
  });
});
