/**
 * Shared fixtures for the extensions test suites (port of the upstream
 * ``temp_dir`` / ``valid_manifest_data`` / ``extension_dir`` / ``project_dir``
 * pytest fixtures).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dumpYaml } from '../src/yaml.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDict = Record<string, any>;

const created: string[] = [];

export function makeTempDir(prefix = 'speckit-ext-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (created.length) {
    const dir = created.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
}

export function validManifestData(): AnyDict {
  return {
    schema_version: '1.0',
    extension: {
      id: 'test-ext',
      name: 'Test Extension',
      version: '1.0.0',
      description: 'A test extension',
      author: 'Test Author',
      repository: 'https://github.com/test/test-ext',
      license: 'MIT',
    },
    requires: {
      speckit_version: '>=0.1.0',
      commands: ['speckit.tasks'],
    },
    provides: {
      commands: [
        {
          name: 'speckit.test-ext.hello',
          file: 'commands/hello.md',
          description: 'Test command',
        },
      ],
    },
    hooks: {
      after_tasks: {
        command: 'speckit.test-ext.hello',
        optional: true,
        prompt: 'Run test?',
      },
    },
    tags: ['testing', 'example'],
  };
}

export function writeManifest(dir: string, data: AnyDict): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'extension.yml');
  writeFileSync(path, dumpYaml(data));
  return path;
}

/** Create a complete extension directory structure. */
export function makeExtensionDir(tempDir: string, data: AnyDict = validManifestData(), name?: string): string {
  const extDir = join(tempDir, name ?? data.extension.id);
  writeManifest(extDir, data);
  mkdirSync(join(extDir, 'commands'), { recursive: true });
  writeFileSync(
    join(extDir, 'commands', 'hello.md'),
    '---\ndescription: "Test hello command"\n---\n\n# Test Hello Command\n\n$ARGUMENTS\n',
  );
  return extDir;
}

/** Create a mock spec-kit project directory. */
export function makeProjectDir(tempDir: string): string {
  const projDir = join(tempDir, 'project');
  mkdirSync(join(projDir, '.specify'), { recursive: true });
  return projDir;
}

/** Minimal manifest with a single command. */
export function simpleManifest(id: string, extra: AnyDict = {}): AnyDict {
  return {
    schema_version: '1.0',
    extension: { id, name: `Ext ${id}`, version: '1.0.0', description: 'Test' },
    requires: { speckit_version: '>=0.1.0' },
    provides: {
      commands: [{ name: `speckit.${id}.cmd`, file: 'commands/cmd.md', ...(extra.cmd ?? {}) }],
    },
    ...(extra.top ?? {}),
  };
}

export function makeSimpleExtension(tempDir: string, id: string, extra: AnyDict = {}): string {
  const extDir = join(tempDir, `${id}-src`);
  writeManifest(extDir, simpleManifest(id, extra));
  mkdirSync(join(extDir, 'commands'), { recursive: true });
  writeFileSync(join(extDir, 'commands', 'cmd.md'), '---\ndescription: Test\n---\n\nBody');
  return extDir;
}
