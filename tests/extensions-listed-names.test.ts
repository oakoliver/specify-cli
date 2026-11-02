/**
 * `extension add` and `extension info` list commands the way the active agent
 * registers them (port of upstream #4964: tests/specify_cli/extensions/_helpers.py
 * LISTED_COMMAND_NAME_CASES, test_command_add.py, test_command_info.py and
 * tests/integrations/test_registry.py::test_command_mode_separator_matches_registered_names).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CommandRegistrar } from '../src/agents.js';
import { console as richConsole, errConsole } from '../src/console.js';
import * as shared from '../src/extensions/command-shared.js';
import { extensionInfo, runExtensionCommand } from '../src/extensions/commands.js';
import { ExtensionCatalog, ExtensionManager } from '../src/extensions/index.js';
import { writeIntegrationJson } from '../src/integration-state.js';
import { INTEGRATION_REGISTRY, getIntegration } from '../src/integrations/index.js';
import { IntegrationManifest } from '../src/integrations/manifest.js';
import { type AnyDict, cleanupTempDirs, makeExtensionDir, makeProjectDir, makeTempDir } from './extensions-helpers.js';

const HYPHENATED = 'speckit-test-ext-hello';
const DOTTED = 'speckit.test-ext.hello';
const CASES: Array<[string, AnyDict, string, string]> = [
  ['claude', { ai: 'claude', ai_skills: true }, HYPHENATED, DOTTED],
  ['codex', { ai: 'codex', ai_skills: true }, HYPHENATED, DOTTED],
  ['junie', { ai: 'junie' }, HYPHENATED, DOTTED],
  ['copilot-skills', { ai: 'copilot', ai_skills: true }, HYPHENATED, DOTTED],
  ['cline', { ai: 'cline' }, HYPHENATED, DOTTED],
  ['forge', { ai: 'forge' }, HYPHENATED, DOTTED],
  ['copilot-commands', { ai: 'copilot' }, DOTTED, HYPHENATED],
  ['gemini', { ai: 'gemini' }, DOTTED, HYPHENATED],
  ['generic-skills', { ai: 'generic', ai_skills: true }, HYPHENATED, DOTTED],
  ['generic-commands', { ai: 'generic' }, DOTTED, HYPHENATED],
];

let out: string[] = [];
let origCwd: string;
let savedHome: string | undefined;
const origSearch = ExtensionCatalog.prototype.search;
const origInfo = ExtensionCatalog.prototype.getExtensionInfo;

beforeEach(() => {
  out = [];
  origCwd = process.cwd();
  savedHome = process.env.HOME;
  process.env.HOME = makeTempDir('speckit-home-');
  richConsole.file = { write: (s: string) => out.push(s), isTTY: false, columns: 200 };
  errConsole.file = { write: (s: string) => out.push(s), isTTY: false, columns: 200 };
  // Force the "installed locally, not in catalog" branch without network access.
  ExtensionCatalog.prototype.getExtensionInfo = async () => null;
  ExtensionCatalog.prototype.search = async () => [];
});

afterEach(() => {
  process.chdir(origCwd);
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  richConsole.file = process.stdout;
  errConsole.file = process.stderr;
  ExtensionCatalog.prototype.getExtensionInfo = origInfo;
  ExtensionCatalog.prototype.search = origSearch;
  cleanupTempDirs();
});

/** Record the init options; generic projects also set up the integration like `specify init`. */
function writeListingProjectOptions(projectDir: string, initOptions: AnyDict): void {
  writeFileSync(join(projectDir, '.specify', 'init-options.json'), JSON.stringify({ ...initOptions, script: 'sh' }));
  if (initOptions.ai === 'generic') {
    const parsedOptions = { commands_dir: '.myagent/commands', skills: Boolean(initOptions.ai_skills) };
    const manifest = new IntegrationManifest('generic', projectDir);
    getIntegration('generic')!.setup(projectDir, manifest, parsedOptions);
    manifest.save();
    writeIntegrationJson(projectDir, {
      version: '1.0.0',
      integrationKey: 'generic',
      settings: { generic: { parsed_options: parsedOptions } },
    });
  }
}

describe('listed command names follow the active agent', () => {
  for (const [id, initOptions, listed, notListed] of CASES) {
    test(`extension add (${id})`, async () => {
      const tmp = makeTempDir();
      const extDir = makeExtensionDir(tmp);
      const projectDir = makeProjectDir(tmp);
      writeListingProjectOptions(projectDir, initOptions);
      process.chdir(projectDir);
      const code = await runExtensionCommand(['add', extDir, '--dev']);
      const text = out.join('');
      expect(code).toBe(0);
      expect(text).toContain(`• ${listed} - `);
      expect(text).not.toContain(`• ${notListed} - `);
    });

    test(`extension info (${id})`, async () => {
      const tmp = makeTempDir();
      const extDir = makeExtensionDir(tmp);
      const projectDir = makeProjectDir(tmp);
      writeListingProjectOptions(projectDir, initOptions);
      new ExtensionManager(projectDir).installFromDirectory(extDir, '1.0.0', { registerCommands: false });
      process.chdir(projectDir);
      await extensionInfo('test-ext');
      const text = out.join('');
      expect(text).toContain(`• ${listed}: `);
      expect(text).not.toContain(`• ${notListed}: `);
    });
  }

  test('registeredCommandName keeps the manifest name without init options', () => {
    const projectDir = makeProjectDir(makeTempDir());
    expect(shared.registeredCommandName(projectDir, DOTTED)).toBe(DOTTED);
  });
});

describe('command-mode separator matches registered names', () => {
  // generic and none have no fixed registrar output (no AGENT_CONFIGS entry).
  for (const key of Object.keys(INTEGRATION_REGISTRY)
    .filter((k) => k in (CommandRegistrar.AGENT_CONFIGS as AnyDict))
    .sort()) {
    test(key, () => {
      const registered = CommandRegistrar.computeOutputName(
        key,
        'speckit.ext.cmd',
        (CommandRegistrar.AGENT_CONFIGS as AnyDict)[key],
      );
      const hyphenated = INTEGRATION_REGISTRY[key].invokeSeparatorForMode(false) === '-';
      expect(registered).toBe(hyphenated ? 'speckit-ext-cmd' : 'speckit.ext.cmd');
    });
  }
});
