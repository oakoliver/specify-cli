/**
 * The bundled `github` extension and the deprecated core taskstoissues
 * command (port of the layout, manifest, install and text-contract cases of
 * upstream tests/extensions/github/test_github_extension.py and
 * test_taskstoissues_deprecation.py; the resolve-tasks script-twin cases test
 * upstream's own scripts, which the port vendors byte for byte).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { locateBundledExtension, locateCorePack } from '../src/assets.js';
import { SKILL_DESCRIPTIONS } from '../src/app.js';
import { ExtensionManager, ExtensionManifest } from '../src/extensions/index.js';
import { SpecifierSet, Version } from '../src/bundles/versioning.js';
import { parseYaml } from '../src/yaml.js';
import { cleanupTempDirs, makeProjectDir, makeTempDir } from './extensions-helpers.js';

afterEach(() => cleanupTempDirs());

const CORE_PACK = locateCorePack()!;
const EXT_DIR = join(CORE_PACK, 'extensions', 'github');
const CORE = join(CORE_PACK, 'commands', 'taskstoissues.md');
const COMMAND_NAME = 'speckit.github.taskstoissues';
const EXTENSION_COMMAND = join(EXT_DIR, 'commands', `${COMMAND_NAME}.md`);
const SCRIPT_TWINS = ['scripts/bash/resolve-tasks.sh', 'scripts/powershell/resolve-tasks.ps1', 'scripts/python/resolve_tasks.py'];
const INSTALL_SPECKIT_VERSION = '1.0.12';

const frontmatter = (path: string): Record<string, any> =>
  parseYaml(readFileSync(path, 'utf-8').split('---', 3)[1]) as Record<string, any>;

describe('bundled github extension', () => {
  test('ships its manifest, README, command and script twins', () => {
    for (const rel of ['extension.yml', 'README.md', `commands/${COMMAND_NAME}.md`, ...SCRIPT_TWINS]) {
      expect(existsSync(join(EXT_DIR, rel))).toBe(true);
    }
  });

  test('locateBundledExtension finds it', () => {
    expect(locateBundledExtension('github')).toBe(EXT_DIR);
  });

  test('the manifest validates', () => {
    const m = new ExtensionManifest(join(EXT_DIR, 'extension.yml'));
    expect(m.id).toBe('github');
    expect(m.version).toBe('1.0.3');
    expect(m.commands.map((c) => c.name)).toEqual([COMMAND_NAME]);
    for (const cmd of m.commands) expect(existsSync(join(EXT_DIR, cmd.file))).toBe(true);
    expect(m.commands.flatMap((c) => c.aliases ?? [])).toEqual([]);
  });

  test('declares its mandatory external tools and a version floor the install satisfies', () => {
    const data = parseYaml(readFileSync(join(EXT_DIR, 'extension.yml'), 'utf-8')) as Record<string, any>;
    const tools = Object.fromEntries((data.requires.tools as Array<Record<string, any>>).map((t) => [t.name, t]));
    expect(new Set(Object.keys(tools))).toEqual(new Set(['git', 'github-mcp-server']));
    expect(Object.values(tools).every((t) => t.required === true)).toBe(true);
    const spec = new SpecifierSet(data.requires.speckit_version);
    expect(spec.contains(new Version('0.12.16'))).toBe(false);
    expect(spec.contains(new Version('0.12.17'))).toBe(true);
    expect(spec.contains(new Version(INSTALL_SPECKIT_VERSION))).toBe(true);
  });

  test('install copies the command and scripts; remove uninstalls cleanly', () => {
    const proj = makeProjectDir(makeTempDir());
    const manager = new ExtensionManager(proj);
    const manifest = manager.installFromDirectory(EXT_DIR, INSTALL_SPECKIT_VERSION, { registerCommands: false });
    expect(manifest.id).toBe('github');
    expect(manager.registry.isInstalled('github')).toBe(true);
    const installed = join(proj, '.specify', 'extensions', 'github');
    expect(existsSync(join(installed, 'commands', `${COMMAND_NAME}.md`))).toBe(true);
    for (const rel of SCRIPT_TWINS) expect(existsSync(join(installed, rel))).toBe(true);
    expect(manager.remove('github')).toBe(true);
    expect(manager.registry.isInstalled('github')).toBe(false);
    expect(existsSync(installed)).toBe(false);
  });
});

describe('core taskstoissues deprecation (#4879)', () => {
  test('the core command warns first and continues', () => {
    const text = readFileSync(CORE, 'utf-8');
    expect(text.indexOf('## Deprecation Notice')).toBeLessThan(text.indexOf('## User Input'));
    expect(text.indexOf('## User Input')).toBeLessThan(text.indexOf('## Pre-Execution Checks'));
    const notice = text.split('## Deprecation Notice\n', 2)[1].split('## User Input', 1)[0];
    for (const phrase of [
      'MUST display the following concise warning first',
      '`__SPECKIT_COMMAND_TASKSTOISSUES__` is deprecated',
      'will be removed in a future minor release',
      'bundled `github` extension',
      'specify extension add github',
      '__SPECKIT_COMMAND_GITHUB_TASKSTOISSUES__',
      'Continue with the existing workflow unchanged',
      'Do not install or enable the extension automatically',
      'do not stop',
      'do not run the replacement command',
    ]) {
      expect(notice).toContain(phrase);
    }
  });

  test('the core frontmatter keeps its execution metadata', () => {
    const metadata = frontmatter(CORE);
    expect(metadata.description.startsWith('Deprecated: ')).toBe(true);
    expect(metadata.tools).toEqual(['github/github-mcp-server/list_issues', 'github/github-mcp-server/issue_write']);
  });

  test('the recommended extension command is not deprecated', () => {
    const text = readFileSync(EXTENSION_COMMAND, 'utf-8');
    expect(text).not.toContain('## Deprecation Notice');
    expect(frontmatter(EXTENSION_COMMAND).description.startsWith('Deprecated:')).toBe(false);
  });

  test('the skills-mode fallback description is deprecated too', () => {
    expect(SKILL_DESCRIPTIONS.taskstoissues.startsWith('Deprecated: ')).toBe(true);
  });

  for (const command of [CORE, EXTENSION_COMMAND]) {
    test(`hook contract remains (${command === CORE ? 'core' : 'github'})`, () => {
      const text = readFileSync(command, 'utf-8');
      expect(text).toContain('hooks.before_taskstoissues');
      expect(text).toContain('hooks.after_taskstoissues');
    });
  }
});
