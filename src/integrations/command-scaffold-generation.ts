/**
 * @oakoliver/specify-cli - Integration Scaffold Generation
 *
 * Generation phase for `specify integration scaffold` (port of
 * `integrations/_command_scaffold_generation.py`).
 *
 * Upstream scaffolds a Python package inside the Spec Kit *Python* source
 * repository. This TypeScript port scaffolds the equivalent built-in
 * integration inside the @oakoliver/specify-cli source repository instead:
 * `src/integrations/<key>.ts` plus `tests/integration-<key>.test.ts`
 * (flat file per integration, matching this repo's layout). Validation rules,
 * templates (base class, commands subdir, format, args, extension) and
 * error messages are identical to upstream.
 *
 * @module integrations/command-scaffold-generation
 */

import { existsSync, lstatSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path';

// ============================================================================
// Types
// ============================================================================

/** Files and next steps produced by an integration scaffold run. */
export interface IntegrationScaffoldResult {
  readonly key: string;
  readonly packageName: string;
  readonly className: string;
  readonly integrationFile: string;
  readonly testFile: string;
  readonly nextSteps: readonly string[];
}

interface IntegrationTemplate {
  baseClass: string;
  commandsSubdir: string;
  registrarFormat: string;
  args: string;
  extension: string;
}

/** Python `FileExistsError` equivalent. */
export class FileExistsError extends Error {
  readonly code = 'EEXIST';
  constructor(message: string) {
    super(message);
    this.name = 'FileExistsError';
  }
}

/** Python `ValueError` equivalent raised for invalid scaffold input. */
export class ScaffoldValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

// ============================================================================
// Templates
// ============================================================================

const KEY_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const TEMPLATES: Record<string, IntegrationTemplate> = {
  markdown: {
    baseClass: 'MarkdownIntegration',
    commandsSubdir: 'commands',
    registrarFormat: 'markdown',
    args: '$ARGUMENTS',
    extension: '.md',
  },
  toml: {
    baseClass: 'TomlIntegration',
    commandsSubdir: 'commands',
    registrarFormat: 'toml',
    args: '{{args}}',
    extension: '.toml',
  },
  yaml: {
    baseClass: 'YamlIntegration',
    commandsSubdir: 'recipes',
    registrarFormat: 'yaml',
    args: '{{args}}',
    extension: '.yaml',
  },
  skills: {
    baseClass: 'SkillsIntegration',
    commandsSubdir: 'skills',
    registrarFormat: 'markdown',
    args: '$ARGUMENTS',
    extension: '/SKILL.md',
  },
};

/** Return supported scaffold template names (sorted). */
export function supportedIntegrationScaffoldTypes(): readonly string[] {
  return Object.keys(TEMPLATES).sort();
}

function cleanKey(key: string): string {
  const clean = key.trim();
  if (!KEY_RE.test(clean)) {
    throw new ScaffoldValueError("Integration key must be lowercase kebab-case, for example 'my-agent'.");
  }
  return clean;
}

/** Module name for the integration (flat kebab-case file, e.g. `my-agent`). */
function packageName(key: string): string {
  return key;
}

function capitalizeWord(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
}

function className(key: string): string {
  return key.split('-').map(capitalizeWord).join('') + 'Integration';
}

function displayName(key: string): string {
  return key.split('-').map(capitalizeWord).join(' ');
}

function tsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function integrationContent(key: string, cls: string, integrationType: string): string {
  const template = TEMPLATES[integrationType];
  const name = displayName(key);
  const folder = `.${key}/`;
  const commandsDir = `${folder}${template.commandsSubdir}`;
  return `/**
 * ${name} integration.
 *
 * @module integrations/${key}
 */

import { ${template.baseClass}, type IntegrationConfig, type RegistrarConfig } from './base.js';

export class ${cls} extends ${template.baseClass} {
  key = ${tsString(key)};
  config: IntegrationConfig = {
    name: ${tsString(name)},
    folder: ${tsString(folder)},
    commands_subdir: ${tsString(template.commandsSubdir)},
    install_url: null,
    requires_cli: false,
  };
  registrarConfig: RegistrarConfig = {
    dir: ${tsString(commandsDir)},
    format: ${tsString(template.registrarFormat)},
    args: ${tsString(template.args)},
    extension: ${tsString(template.extension)},
  };
  multiInstallSafe = false;
}
`;
}

function testContent(key: string, cls: string, integrationType: string): string {
  const template = TEMPLATES[integrationType];
  const name = displayName(key);
  const commandsDir = `.${key}/${template.commandsSubdir}`;
  return `/**
 * Tests for the ${key} integration.
 */

import { describe, test, expect } from 'bun:test';

import { ${cls} } from '../src/integrations/${packageName(key)}.js';
import { ${template.baseClass} } from '../src/integrations/base.js';

describe('${key} integration', () => {
  test('metadata', () => {
    const integration = new ${cls}();

    expect(integration).toBeInstanceOf(${template.baseClass});
    expect(integration.key).toBe(${tsString(key)});
    expect(integration.config?.name).toBe(${tsString(name)});
    expect(integration.config?.folder).toBe(${tsString(`.${key}/`)});
    expect(integration.config?.commands_subdir).toBe(${tsString(template.commandsSubdir)});
    expect(integration.config?.requires_cli).toBe(false);
    expect(integration.registrarConfig?.dir).toBe(${tsString(commandsDir)});
    expect(integration.registrarConfig?.format).toBe(${tsString(template.registrarFormat)});
    expect(integration.registrarConfig?.args).toBe(${tsString(template.args)});
    expect(integration.registrarConfig?.extension).toBe(${tsString(template.extension)});
    expect(integration.multiInstallSafe).toBe(false);
  });
});
`;
}

// ============================================================================
// Repo-root / safety checks
// ============================================================================

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Return true when `projectRoot` looks like the specify-cli source repository root. */
export function isSpecKitRepoRoot(projectRoot: string): boolean {
  return (
    isFile(join(projectRoot, 'package.json')) &&
    isFile(join(projectRoot, 'src', 'index.ts')) &&
    isDir(join(projectRoot, 'src', 'integrations')) &&
    isFile(join(projectRoot, 'src', 'integrations', 'index.ts')) &&
    isDir(join(projectRoot, 'tests'))
  );
}

function resolveLoose(p: string): string {
  const abs = resolvePath(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(resolveLoose(parent), abs.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}

function isWithin(child: string, root: string): boolean {
  if (child === root) return true;
  return child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Refuse to scaffold through a symlinked path that could escape the repo. */
function assertSafeScaffoldTarget(projectRoot: string, target: string): void {
  const root = resolvePath(projectRoot);
  const abs = resolvePath(target);
  if (!isWithin(abs, root)) {
    throw new ScaffoldValueError(`Refusing to scaffold outside the repository root: ${target}`);
  }
  const parts = relative(root, abs).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (isSymlink(current)) {
      const label = relative(root, current).split(sep).join('/');
      throw new ScaffoldValueError(`Refusing to scaffold through symlinked path: ${label}`);
    }
  }
  const rootResolved = resolveLoose(root);
  if (!isWithin(resolveLoose(dirname(abs)), rootResolved)) {
    throw new ScaffoldValueError(`Refusing to scaffold outside the repository root: ${target}`);
  }
}

/** Filesystem writer (overridable in tests to simulate failures). */
export const scaffoldFs = {
  writeFile(path: string, content: string): void {
    writeFileSync(path, content, 'utf-8');
  },
};

// ============================================================================
// Scaffold
// ============================================================================

/** Create a minimal built-in integration module and test skeleton. */
export function scaffoldIntegration(
  projectRoot: string,
  key: string,
  integrationType: string,
): IntegrationScaffoldResult {
  const clean = cleanKey(key);
  const normalizedType = integrationType.trim().toLowerCase();
  if (!(normalizedType in TEMPLATES)) {
    const supported = supportedIntegrationScaffoldTypes().join(', ');
    throw new ScaffoldValueError(`Unsupported integration type '${normalizedType}'. Use one of: ${supported}.`);
  }

  const root = resolvePath(projectRoot);
  const integrationsRoot = join(root, 'src', 'integrations');
  const testsRoot = join(root, 'tests');
  if (!isSpecKitRepoRoot(root)) {
    throw new ScaffoldValueError('Run this command from the Spec Kit repository root.');
  }

  const pkg = packageName(clean);
  const cls = className(clean);
  const integrationFile = join(integrationsRoot, `${pkg}.ts`);
  const testFile = join(testsRoot, `integration-${pkg}.test.ts`);

  for (const target of [integrationFile, testFile]) assertSafeScaffoldTarget(root, target);

  const existing = [integrationFile, testFile].filter((p) => existsSync(p) || isSymlink(p));
  if (existing.length > 0) {
    const labels = existing.map((p) => relative(root, p).split(sep).join('/')).join(', ');
    throw new FileExistsError(`Refusing to overwrite existing scaffold file(s): ${labels}`);
  }

  try {
    scaffoldFs.writeFile(integrationFile, integrationContent(clean, cls, normalizedType));
    scaffoldFs.writeFile(testFile, testContent(clean, cls, normalizedType));
  } catch (exc) {
    for (const p of [testFile, integrationFile]) {
      try {
        if (isFile(p) || isSymlink(p)) unlinkSync(p);
      } catch {
        // best effort
      }
    }
    throw exc;
  }

  const nextSteps = [
    `Register ${cls} in src/integrations/index.ts.`,
    'Review config metadata, install_url, requires_cli, and multiInstallSafe.',
    `Run bun test tests/integration-${pkg}.test.ts.`,
  ];
  return {
    key: clean,
    packageName: pkg,
    className: cls,
    integrationFile,
    testFile,
    nextSteps,
  };
}
