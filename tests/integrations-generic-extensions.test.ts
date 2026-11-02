/**
 * Extension commands and skills for the generic integration (port of the
 * core cases of upstream #4785, tests/integrations/test_integration_generic.py
 * in spec-kit v1.2.5).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { getIntegration } from '../src/integrations/index.js';
import { IntegrationManifest } from '../src/integrations/manifest.js';
import { writeIntegrationJson } from '../src/integration-state.js';
import { saveInitOptions } from '../src/init-options.js';
import { ExtensionManager } from '../src/extensions/manager.js';
import { CommandRegistrar } from '../src/agents.js';
import { registrationDirectory } from '../src/integrations/generic.js';
import { main as cliMain } from '../src/cli.js';
import { console as appConsole, errConsole } from '../src/console.js';

let tmp: string;
let source: string;
const savedHome = process.env.HOME;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-generic-ext-')));
  process.env.HOME = join(tmp, 'home');
  source = join(tmp, 'source');
  mkdirSync(join(source, 'commands'), { recursive: true });
  mkdirSync(join(source, 'scripts'), { recursive: true });
  writeFileSync(
    join(source, 'extension.yml'),
    [
      "schema_version: '1.0'",
      'extension:',
      '  id: sample',
      '  name: Sample',
      '  version: 1.0.0',
      '  description: Sample commands',
      '  author: Test',
      'requires:',
      "  speckit_version: '>=0.1.0'",
      'provides:',
      '  commands:',
      '  - name: speckit.sample.run',
      '    file: commands/run.md',
      '    description: Run sample',
      '',
    ].join('\n'),
  );
  writeFileSync(join(source, 'scripts', 'run.sh'), 'echo sample\n');
  writeFileSync(
    join(source, 'commands', 'run.md'),
    '---\ndescription: Run sample\nscripts:\n  sh: scripts/run.sh\n---\n' +
      'Execute {SCRIPT} with {ARGS}; see scripts/run.sh. Then __SPECKIT_COMMAND_TASKS__.\n',
  );
});
afterEach(() => {
  process.env.HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

function genericProject(skills: boolean, commandsDir = '.custom/commands'): string {
  const project = join(tmp, 'project');
  mkdirSync(project);
  const opts = { commands_dir: commandsDir, skills };
  const manifest = new IntegrationManifest('generic', project);
  getIntegration('generic')!.setup(project, manifest, opts, { scriptType: 'sh' });
  manifest.save();
  writeIntegrationJson(project, { version: '1.0.0', integrationKey: 'generic', settings: { generic: { parsed_options: opts } } });
  saveInitOptions(project, { ai: 'generic', ai_skills: skills, script: 'sh' });
  return project;
}

const artifactRel = (skills: boolean): string => (skills ? 'speckit-sample-run/SKILL.md' : 'speckit.sample.run.md');

async function run(args: string[], cwd: string): Promise<number> {
  const prev = process.cwd();
  process.chdir(cwd);
  appConsole.beginCapture();
  errConsole.beginCapture();
  try {
    return await cliMain(args);
  } finally {
    appConsole.endCapture();
    errConsole.endCapture();
    process.chdir(prev);
  }
}

describe('registrar', () => {
  test('a generic project gets a project-scoped generic registrar entry', () => {
    const project = genericProject(false);
    expect('generic' in CommandRegistrar.AGENT_CONFIGS).toBe(false);
    const registrar = new CommandRegistrar(project);
    expect(registrar.AGENT_CONFIGS.generic).toEqual({
      dir: join(project, '.custom', 'commands'),
      format: 'markdown',
      args: '$ARGUMENTS',
      extension: '.md',
      invoke_separator: '.',
    });
    expect(new CommandRegistrar(project, { includeGeneric: false }).AGENT_CONFIGS.generic).toBeUndefined();
    expect(registrationDirectory(project)).toBe(join(project, '.custom', 'commands'));
  });

  test('an escaping --commands-dir is rejected', () => {
    const project = genericProject(false);
    writeIntegrationJson(project, {
      version: '1.0.0',
      integrationKey: 'generic',
      settings: { generic: { parsed_options: { commands_dir: '../outside' } } },
    });
    expect(() => registrationDirectory(project)).toThrow('escapes project root');
  });
});

for (const skills of [false, true]) {
  describe(`generic extension lifecycle (skills: ${skills})`, () => {
    test('install renders into --commands-dir, refresh is stable, remove keeps unrelated files', () => {
      const commandsDir = skills ? '.custom/skills' : '.custom/commands';
      const project = genericProject(skills, commandsDir);
      const outputDir = join(project, commandsDir);
      const core = join(outputDir, skills ? 'speckit-taskstoissues/SKILL.md' : 'speckit.taskstoissues.md');
      const coreContent = readFileSync(core, 'utf8');
      const unrelated = join(outputDir, skills ? 'user-skill/SKILL.md' : 'user.md');
      mkdirSync(dirname(unrelated), { recursive: true });
      writeFileSync(unrelated, 'user-owned');

      const manager = new ExtensionManager(project);
      manager.installFromDirectory(source, '1.0.0');
      const artifact = join(outputDir, artifactRel(skills));
      const content = readFileSync(artifact, 'utf8');
      expect(content).toContain('.specify/extensions/sample/scripts/run.sh');
      expect(content).not.toContain('{SCRIPT}');
      expect(content).toContain('$ARGUMENTS');
      expect(content).toContain(skills ? '/speckit-tasks' : '/speckit.tasks');
      const hashes = manager.registry.get('sample')!.generic_artifact_hashes as Record<string, string>;
      expect(Object.keys(hashes)).toEqual([`${commandsDir}/${artifactRel(skills)}`]);

      manager.registerEnabledExtensionsForAgent('generic');
      expect(readFileSync(artifact, 'utf8')).toBe(content);
      let sibling = '';
      if (skills) {
        sibling = join(dirname(artifact), 'user-notes.md');
        writeFileSync(sibling, 'keep this');
      }
      expect(manager.remove('sample')).toBe(true);
      expect(existsSync(artifact)).toBe(false);
      if (skills) expect(readFileSync(sibling, 'utf8')).toBe('keep this');
      expect(readFileSync(core, 'utf8')).toBe(coreContent);
      expect(readFileSync(unrelated, 'utf8')).toBe('user-owned');
    });

    test('remove preserves a modified artifact', () => {
      const project = genericProject(skills);
      const manager = new ExtensionManager(project);
      manager.installFromDirectory(source, '1.0.0');
      const artifact = join(project, '.custom/commands', artifactRel(skills));
      writeFileSync(artifact, readFileSync(artifact, 'utf8') + '\nuser edit\n');
      expect(manager.remove('sample')).toBe(true);
      expect(readFileSync(artifact, 'utf8').endsWith('user edit\n')).toBe(true);
    });

    test('install does not overwrite an existing command or skill', () => {
      const project = genericProject(skills);
      const output = join(project, '.custom/commands', artifactRel(skills));
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, '<!-- Extension: sample -->\nmy own command');
      expect(() => new ExtensionManager(project).installFromDirectory(source, '1.0.0')).toThrow('cannot be replaced safely');
      expect(readFileSync(output, 'utf8')).toBe('<!-- Extension: sample -->\nmy own command');
      const manager = new ExtensionManager(project);
      expect(manager.registry.isInstalled('sample')).toBe(false);
      expect(existsSync(join(manager.extensionsDir, 'sample'))).toBe(false);
      unlinkSync(output);
      if (skills) rmdirSync(dirname(output));
      manager.installFromDirectory(source, '1.0.0');
      expect(manager.registry.isInstalled('sample')).toBe(true);
      expect(manager.remove('sample')).toBe(true);
    });

    test('install rejects init options that disagree with the integration state', () => {
      const project = genericProject(skills);
      saveInitOptions(project, { ai: 'generic', ai_skills: !skills, script: 'sh' });
      expect(() => new ExtensionManager(project).installFromDirectory(source, '1.0.0')).toThrow('disagree on skills mode');
    });

    test('disable retires invocations and enable restores them', async () => {
      const project = genericProject(skills);
      new ExtensionManager(project).installFromDirectory(source, '1.0.0');
      const output = join(project, '.custom/commands', artifactRel(skills));
      expect(await run(['extension', 'disable', 'sample'], project)).toBe(0);
      expect(existsSync(output)).toBe(false);
      expect(existsSync(join(project, '.specify/extensions/sample/extension.yml'))).toBe(true);
      expect(await run(['extension', 'enable', 'sample'], project)).toBe(0);
      expect(existsSync(output)).toBe(true);
    });

    test('disable refuses to delete a modified artifact', async () => {
      const project = genericProject(skills);
      new ExtensionManager(project).installFromDirectory(source, '1.0.0');
      const output = join(project, '.custom/commands', artifactRel(skills));
      writeFileSync(output, 'edited');
      expect(await run(['extension', 'disable', 'sample'], project)).toBe(1);
      expect(readFileSync(output, 'utf8')).toBe('edited');
      expect(new ExtensionManager(project).registry.get('sample')!.enabled).toBe(true);
    });
  });
}
