/**
 * @oakoliver/specify-cli - Init Command
 *
 * Port of upstream `specify_cli/command_init.py` (spec-kit v1.0.12):
 * `specify init` scaffolds a Spec Kit project from the bundled core_pack
 * assets, installs the selected coding agent integration, shared
 * infrastructure (scripts + templates + managed `.specify/.gitignore`), the
 * bundled `speckit` workflow, optional presets and extensions, and seeds the
 * project constitution.
 *
 * @module init
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import {
  CliAbort,
  CliExit,
  Panel,
  StepTracker,
  confirm,
  console,
  escapeMarkup,
  selectWithArrows,
} from './console.js';
import { parseArgs, runCommand, type CommandSpec, type ParsedArgs } from './cli-args.js';
import { AGENT_CONFIG, SCRIPT_TYPE_CHOICES, resolveDefaultInitIntegration } from './agent-config.js';
import {
  getSpeckitVersion,
  locateBundledExtension,
  locateBundledPreset,
  locateBundledWorkflow,
} from './assets.js';
import { checkTool } from './utils.js';
import { isDollarSkillsAgent, isSlashSkillsAgent } from './invocation-style.js';
import { invokePrefixForIntegration, withIntegrationSetting } from './integration-runtime.js';
import { INTEGRATION_REGISTRY, getIntegration } from './integrations/index.js';
import type { IntegrationBase, SetupOptions } from './integrations/base.js';
import { IntegrationManifest } from './integrations/manifest.js';
import {
  parseIntegrationOptions,
  registerExtensionsForAgent,
  registerPresetsForAgent,
  writeIntegrationJson,
} from './integrations/helpers.js';
import { resolveEvents } from './events/index.js';
import { WorkflowRegistry } from './workflows/catalog/index.js';
import { WorkflowDefinition } from './workflows/engine.js';
import { PresetCatalog, PresetError, PresetManager, materializeConstitutionTemplate } from './presets/index.js';
import { ExtensionCatalog, ExtensionError, ExtensionManager, REINSTALL_COMMAND } from './extensions/index.js';
import {
  installExtensionFromUrl,
  refreshEventsAndWarn,
  resolveCatalogExtension,
} from './extensions/command-shared.js';
import {
  ensureExecutableScripts,
  installSharedInfraOrExit,
  printCliWarning,
  saveInitOptions,
  showBanner,
} from './app.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Options for `specify init` (mirrors the Typer signature of upstream
 * `command_init.init`). Field names are camelCase versions of the Python
 * parameters.
 */
export interface InitCommandOptions {
  /** Name for the new project directory ('.' means the current directory). */
  projectName?: string | null;
  /** `--script sh|ps|py` */
  scriptType?: string | null;
  /** `--ignore-agent-tools` */
  ignoreAgentTools?: boolean;
  /** `--here` */
  here?: boolean;
  /** `--force` */
  force?: boolean;
  /** `--non-interactive` */
  nonInteractive?: boolean;
  /** `--skip-tls` (hidden, deprecated no-op) */
  skipTls?: boolean;
  /** `--debug` (hidden, deprecated: extra diagnostics on failure only) */
  debug?: boolean;
  /** `--github-token` (hidden, deprecated no-op) */
  githubToken?: string | null;
  /** `--offline` (hidden, deprecated no-op) */
  offline?: boolean;
  /** `--preset <id|path>` */
  preset?: string | null;
  /** `--integration <key>` */
  integration?: string | null;
  /** `--integration-options "<opts>"` */
  integrationOptions?: string | null;
  /** `--extension <spec>` (repeatable) */
  extensions?: string[] | null;
  /** `--trust-extension-urls` */
  trustExtensionUrls?: boolean;
}

// ============================================================================
// Test hooks (Python tests monkeypatch module attributes; ESM exports are
// immutable, so the overridable seams live on this object instead)
// ============================================================================

export const initHooks = {
  /** `_stdin_is_interactive` */
  stdinIsInteractive: (): boolean => Boolean(process.stdin.isTTY),
  /** `select_with_arrows` */
  selectWithArrows: (
    options: Record<string, string>,
    promptText: string,
    defaultKey: string | null,
    opts: { flagHint?: string | null } = {},
  ): Promise<string> => selectWithArrows(options, promptText, defaultKey, opts),
  /** `typer.confirm`; resolves `null` where typer raises `Abort` (EOF / Ctrl+C). */
  confirm: async (message: string, defaultValue = false): Promise<boolean | null> => {
    try {
      return await confirm(message, { default: defaultValue });
    } catch (exc) {
      if (exc instanceof CliAbort) return null;
      throw exc;
    }
  },
  /** `get_speckit_version` as seen by command_init */
  getSpeckitVersion: (): string => getSpeckitVersion(),
};

// ============================================================================
// Help / argument parsing
// ============================================================================

export const INIT_HELP_DOC = `Initialize a new Specify project.

Project files are scaffolded from assets bundled inside the specify-cli
package, so initialization does not need network access and templates
match the installed CLI version.

This command will:
1. Check that required tools are installed
2. Let you choose your coding agent integration, or default to Copilot
   in non-interactive sessions (no TTY, or --non-interactive)
3. Install bundled Spec Kit templates, scripts, workflow, and shared
   project infrastructure
4. Set up coding agent integration commands and optional presets

Examples:
    specify init my-project
    specify init my-project --integration claude
    specify init --ignore-agent-tools my-project
    specify init . --integration claude         # Initialize in current directory
    specify init .                     # Initialize in current directory (interactive integration selection)
    specify init --here --integration claude    # Alternative syntax for current directory
    specify init --here --integration codex --integration-options="--skills"
    specify init --here --integration codebuddy
    specify init --here --integration vibe      # Initialize with Mistral Vibe support
    specify init --here
    specify init --here --force  # Skip confirmation when current directory not empty
    specify init my-project --non-interactive  # CI/agent: defaults, no prompts
    specify init --here --force --non-interactive --integration claude  # Scripted init, no hang
    specify init my-project --integration claude   # Claude installs skills by default
    specify init --here --integration gemini
    specify init my-project --integration generic --integration-options="--commands-dir .myagent/commands/"  # Bring your own agent; requires --commands-dir
    specify init my-project --integration claude --preset healthcare-compliance  # With preset
    specify init my-project --integration copilot --extension git  # With bundled extension
    specify init my-project --extension git --extension selftest  # Multiple extensions
    specify init my-project --extension ./my-extensions/custom-ext  # Local path extension
    specify init my-project --extension https://example.com/extensions/my-ext.zip --trust-extension-urls  # URL extension (non-interactive)`;

/** `specify init` command spec (mirrors the upstream Typer signature). */
export const INIT_COMMAND_SPEC: CommandSpec = {
  name: 'init',
  help: INIT_HELP_DOC,
  arguments: [
    {
      name: 'project_name',
      required: false,
      default: null,
      metavar: 'project_name',
      help: "Name for your new project directory (optional if using --here, or use '.' for current directory)",
    },
  ],
  options: [
    { name: 'scriptType', flags: ['--script'], help: 'Script type to use: sh, ps, or py' },
    { name: 'ignoreAgentTools', flags: ['--ignore-agent-tools'], type: 'boolean', help: 'Skip checks for coding agent tools like Claude Code' },
    { name: 'here', flags: ['--here'], type: 'boolean', help: 'Initialize project in the current directory instead of creating a new one' },
    { name: 'force', flags: ['--force'], type: 'boolean', help: 'Force merge/overwrite when using --here (skip confirmation)' },
    {
      name: 'nonInteractive',
      flags: ['--non-interactive'],
      type: 'boolean',
      help:
        'Never prompt. Use documented defaults for unspecified selections and fail instead of hanging when a choice has no safe default. Required for agent harnesses that allocate a PTY but cannot send arrow-key input.',
    },
    { name: 'skipTls', flags: ['--skip-tls'], type: 'boolean', hidden: true, help: 'Deprecated (no-op). Previously: skip SSL/TLS verification.' },
    {
      name: 'debug',
      flags: ['--debug'],
      type: 'boolean',
      hidden: true,
      help: 'Deprecated. Previously: show verbose diagnostic output; currently only prints additional diagnostic details on failure.',
    },
    { name: 'githubToken', flags: ['--github-token'], hidden: true, help: 'Deprecated (no-op). Previously: GitHub token for API requests.' },
    { name: 'offline', flags: ['--offline'], type: 'boolean', hidden: true, help: 'Deprecated (no-op). All scaffolding now uses bundled assets.' },
    { name: 'preset', flags: ['--preset'], help: 'Install a preset during initialization (by preset ID)' },
    {
      name: 'integration',
      flags: ['--integration'],
      help: "AI coding agent integration to use (e.g. --integration copilot). See 'specify check' for available integrations.",
    },
    {
      name: 'integrationOptions',
      flags: ['--integration-options'],
      help: 'Options for the integration (e.g. --integration-options="--commands-dir .myagent/cmds")',
    },
    {
      name: 'extensions',
      flags: ['--extension'],
      multiple: true,
      help: 'Install an extension during initialization (bundled name, local path, or HTTPS URL). Repeatable.',
    },
    {
      name: 'trustExtensionUrls',
      flags: ['--trust-extension-urls'],
      type: 'boolean',
      help: 'Pre-authorize installing extensions from external URLs without the interactive trust prompt (required for non-interactive URL installs).',
    },
  ],
};

/** Map parsed cli-args output onto {@link InitCommandOptions}. */
function toInitOptions(parsed: ParsedArgs): InitCommandOptions {
  const o = parsed.options;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const exts = Array.isArray(o['extensions']) ? (o['extensions'] as string[]) : [];
  return {
    projectName: str(parsed.args['project_name']),
    scriptType: str(o['scriptType']),
    ignoreAgentTools: Boolean(o['ignoreAgentTools']),
    here: Boolean(o['here']),
    force: Boolean(o['force']),
    nonInteractive: Boolean(o['nonInteractive']),
    skipTls: Boolean(o['skipTls']),
    debug: Boolean(o['debug']),
    githubToken: str(o['githubToken']),
    offline: Boolean(o['offline']),
    preset: str(o['preset']),
    integration: str(o['integration']),
    integrationOptions: str(o['integrationOptions']),
    extensions: exts.length ? exts : null,
    trustExtensionUrls: Boolean(o['trustExtensionUrls']),
  };
}

/**
 * Parse `specify init` arguments (the args after the `init` word).
 *
 * Unknown options -- including the removed legacy `--ai`, `--ai-skills`,
 * `--ai-commands-dir`, `--no-git` and `--branch-numbering` -- raise a
 * cli-args `UsageError` ("No such option: ...", exit code 2), like Click.
 */
export function parseInitArgs(args: string[]): InitCommandOptions & { help?: boolean } {
  const parsed = parseArgs(INIT_COMMAND_SPEC, args, 'specify init');
  const opts: InitCommandOptions & { help?: boolean } = toInitOptions(parsed);
  if (parsed.help) opts.help = true;
  return opts;
}


// ============================================================================
// Helpers (module-level functions of command_init.py)
// ============================================================================

/** Return true when interactive pickers and confirmations may be shown. */
export function promptsAllowed(nonInteractive: boolean): boolean {
  return !nonInteractive && initHooks.stdinIsInteractive();
}

/** Return true when `extSpec` is an http(s) URL rather than a name/path. */
export function extSpecIsUrl(extSpec: string): boolean {
  try {
    const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(extSpec)?.[1]?.toLowerCase();
    return scheme === 'http' || scheme === 'https';
  } catch {
    return false;
  }
}

/**
 * Resolve trust for each URL-based extension before the tracker display.
 * Returns a mapping of `urlSpec -> approved` (default-deny when prompts are
 * not allowed and no override was given).
 */
export async function confirmExtensionUrlTrust(
  urlSpecs: string[],
  opts: { trustOverride: boolean; allowPrompt?: boolean | null },
): Promise<Record<string, boolean>> {
  const approvals: Record<string, boolean> = {};
  const interactive =
    opts.allowPrompt === undefined || opts.allowPrompt === null
      ? initHooks.stdinIsInteractive()
      : opts.allowPrompt;
  for (const spec of urlSpecs) {
    if (opts.trustOverride) {
      approvals[spec] = true;
      continue;
    }
    if (!interactive) {
      approvals[spec] = false;
      continue;
    }
    console.print();
    console.print(
      new Panel(
        '[bold]You are installing an extension from an external URL that is not\n' +
          'listed in any of your configured extension catalogs.[/bold]\n\n' +
          `URL: ${escapeMarkup(spec)}\n\n` +
          'Only install extensions from sources you trust.',
        { title: '[bold yellow]⚠ Untrusted Source[/bold yellow]', borderStyle: 'yellow', padding: [1, 2] },
      ),
    );
    console.print();
    const answer = await initHooks.confirm(`Install extension from ${spec}?`, false);
    if (answer === null) {
      // typer.confirm raises Abort on EOF / Ctrl+C -> Click prints "Aborted!".
      throw new CliAbort();
    }
    approvals[spec] = answer;
  }
  return approvals;
}

function expandUser(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

interface InstalledManifestLike {
  name: string;
  version: string;
}

/**
 * Install a single extension during `specify init`.
 *
 * Handles bundled extension names, local directory paths, and HTTPS URLs.
 * Returns a short status message on success; throws `Error` on failure so the
 * caller can convert it into a tracker error without aborting init.
 */
export async function installExtensionDuringInit(
  projectPath: string,
  extSpec: string,
  speckitVersion: string,
): Promise<string> {
  const manager = new ExtensionManager(projectPath);

  // --- URL ---
  if (extSpecIsUrl(extSpec)) {
    let manifest: InstalledManifestLike;
    try {
      manifest = (await installExtensionFromUrl(manager, projectPath, extSpec, speckitVersion)) as InstalledManifestLike;
    } catch (exc) {
      if (exc instanceof ExtensionError) throw new Error(exc.message);
      throw exc;
    }
    return `${manifest.name} v${manifest.version} installed`;
  }

  // --- Local path ---
  const localPrefixes = ['./', '../', '/', '~/', '.\\', '..\\'];
  if (localPrefixes.some((p) => extSpec.startsWith(p)) || isAbsolute(extSpec)) {
    const sourcePath = resolve(expandUser(extSpec));
    if (!existsSync(sourcePath)) {
      throw new Error(`Directory not found: ${sourcePath}`);
    }
    if (!existsSync(join(sourcePath, 'extension.yml'))) {
      throw new Error(`No extension.yml found in ${sourcePath}`);
    }
    const manifest = (await manager.installFromDirectory(sourcePath, speckitVersion)) as InstalledManifestLike;
    return `${manifest.name} v${manifest.version} installed`;
  }

  // --- Bundled extension name or catalog ID ---
  let bundledPath = locateBundledExtension(extSpec);
  if (bundledPath !== null && bundledPath !== undefined) {
    if (manager.registry.isInstalled(extSpec)) return 'already installed';
    const manifest = (await manager.installFromDirectory(bundledPath, speckitVersion)) as InstalledManifestLike;
    return `${manifest.name} v${manifest.version} installed`;
  }

  // Fall back to catalog
  const catalog = new ExtensionCatalog(projectPath);
  const [extInfo, catalogError] = (await resolveCatalogExtension(extSpec, catalog, 'add')) as [
    Record<string, unknown> | null,
    unknown,
  ];
  if (catalogError) {
    throw new Error(`Could not query extension catalog: ${errorText(catalogError)}`);
  }
  if (!extInfo) {
    throw new Error(`Extension '${extSpec}' not found in bundled extensions or catalog`);
  }

  const resolvedId = String(extInfo['id']);
  if (resolvedId !== extSpec) {
    bundledPath = locateBundledExtension(resolvedId);
    if (bundledPath !== null && bundledPath !== undefined) {
      if (manager.registry.isInstalled(resolvedId)) return 'already installed';
      const manifest = (await manager.installFromDirectory(bundledPath, speckitVersion)) as InstalledManifestLike;
      return `${manifest.name} v${manifest.version} installed`;
    }
  }

  if (extInfo['bundled'] && !extInfo['download_url']) {
    throw new Error(
      `Extension '${resolvedId}' is bundled with spec-kit but not found in the installed package. ` +
        `Try reinstalling spec-kit: ${REINSTALL_COMMAND}`,
    );
  }

  if (!(extInfo['_install_allowed'] ?? true)) {
    const catalogName = (extInfo['_catalog_name'] as string | undefined) ?? 'community';
    throw new Error(
      `Extension '${extSpec}' is in the '${catalogName}' catalog but installation is not allowed from that catalog`,
    );
  }

  const zipPath = (await catalog.downloadExtension(resolvedId)) as string;
  try {
    const manifest = (await manager.installFromZip(zipPath, speckitVersion, {
      catalogName: (extInfo['_catalog_name'] as string | undefined) ?? null,
    })) as InstalledManifestLike;
    return `${manifest.name} v${manifest.version} installed`;
  } finally {
    try {
      rmSync(zipPath, { force: true });
    } catch {
      /* missing_ok */
    }
  }
}

/**
 * Quote `value` as one argument for the shells of the host OS
 * (`subprocess.list2cmdline` on Windows, `shlex.quote` elsewhere).
 */
export function shellQuoteArg(value: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return list2cmdline([value]);
  return shlexQuote(value);
}

/** Python `shlex.quote`. */
export function shlexQuote(s: string): string {
  if (!s) return "''";
  if (!/[^\w@%+=:,./-]/.test(s)) return s;
  return "'" + s.replace(/'/g, `'"'"'`) + "'";
}

/** Python `subprocess.list2cmdline`. */
export function list2cmdline(seq: string[]): string {
  const result: string[] = [];
  for (const arg of seq) {
    let bsBuf: string[] = [];
    if (result.length) result.push(' ');
    const needquote = arg.includes(' ') || arg.includes('\t') || !arg;
    if (needquote) result.push('"');
    for (const c of arg) {
      if (c === '\\') {
        bsBuf.push(c);
      } else if (c === '"') {
        result.push('\\'.repeat(bsBuf.length * 2));
        bsBuf = [];
        result.push('\\"');
      } else {
        if (bsBuf.length) {
          result.push(...bsBuf);
          bsBuf = [];
        }
        result.push(c);
      }
    }
    if (bsBuf.length) result.push(...bsBuf);
    if (needquote) {
      result.push(...bsBuf);
      result.push('"');
    }
  }
  return result.join('');
}

/**
 * Materialize the resolved constitution template to memory if missing.
 *
 * Resolution walks the full priority stack (project overrides → installed
 * presets → extensions → core) so a preset that ships a
 * `constitution-template` can seed the memory file.
 */
export function ensureConstitutionFromTemplate(projectPath: string, tracker: StepTracker | null = null): void {
  const memoryConstitution = join(projectPath, '.specify', 'memory', 'constitution.md');

  if (existsSync(memoryConstitution)) {
    if (tracker) {
      tracker.add('constitution', 'Constitution setup');
      tracker.skip('constitution', 'existing file preserved');
    }
    return;
  }

  try {
    const materialization = materializeConstitutionTemplate(projectPath, memoryConstitution);
    if (materialization === null || materialization === undefined) {
      if (tracker) {
        tracker.add('constitution', 'Constitution setup');
        tracker.error('constitution', 'template not found');
      }
      return;
    }
    if (tracker) {
      tracker.add('constitution', 'Constitution setup');
      if (materialization === 'copied') tracker.complete('constitution', 'copied from template');
      else tracker.complete('constitution', 'composed from template');
    } else {
      console.print('[cyan]Initialized constitution from template[/cyan]');
    }
  } catch (e) {
    if (tracker) {
      tracker.add('constitution', 'Constitution setup');
      tracker.error('constitution', errorText(e));
    } else {
      console.print(`[yellow]Warning: Could not initialize constitution: ${errorText(e)}[/yellow]`);
    }
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function pyStr(value: unknown): string {
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null || value === undefined) return 'None';
  return String(value);
}

function listDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

// ============================================================================
// init
// ============================================================================

/**
 * Programmatic `specify init`. Returns the process exit code (0 on success)
 * instead of throwing `CliExit`; unexpected errors propagate.
 */
export async function init(options: InitCommandOptions = {}): Promise<number> {
  try {
    await initOrExit(options);
    return 0;
  } catch (exc) {
    if (exc instanceof CliExit) return exc.code;
    throw exc;
  }
}

/**
 * Core implementation of `specify init` (throws `CliExit` like `typer.Exit`).
 */
export async function initOrExit(options: InitCommandOptions = {}): Promise<void> {
  let projectName: string | null = options.projectName ?? null;
  const scriptType = options.scriptType ?? null;
  const ignoreAgentTools = options.ignoreAgentTools ?? false;
  let here = options.here ?? false;
  const force = options.force ?? false;
  const nonInteractive = options.nonInteractive ?? false;
  const debug = options.debug ?? false;
  const preset = options.preset ?? null;
  const integration = options.integration ?? null;
  const integrationOptions = options.integrationOptions ?? null;
  const extensions = options.extensions && options.extensions.length ? options.extensions : null;
  const trustExtensionUrls = options.trustExtensionUrls ?? false;

  showBanner();

  let resolvedIntegration: IntegrationBase | null = null;
  if (integration) {
    resolvedIntegration = getIntegration(integration) ?? null;
    if (!resolvedIntegration) {
      console.print(`[red]Error:[/red] Unknown integration: '${escapeMarkup(String(integration))}'`);
      const available = Object.keys(INTEGRATION_REGISTRY).sort().join(', ');
      console.print(`[yellow]Available integrations:[/yellow] ${available}`);
      throw new CliExit(1);
    }
  }

  if (projectName === '.') {
    here = true;
    projectName = null;
  }

  if (here && projectName) {
    console.print('[red]Error:[/red] Cannot specify both project name and --here flag');
    throw new CliExit(1);
  }

  if (!here && !projectName) {
    console.print(
      "[red]Error:[/red] Must specify either a project name, use '.' for current directory, or use --here flag",
    );
    throw new CliExit(1);
  }

  let dirExistedBefore = false;
  let projectPath: string;
  if (here) {
    projectPath = process.cwd();
    projectName = basename(projectPath);
    dirExistedBefore = true;

    const existingItems = listDir(projectPath);
    if (existingItems.length) {
      console.print(`[yellow]Warning:[/yellow] Current directory is not empty (${existingItems.length} items)`);
      if (force) {
        console.print(
          '[yellow]Template files will be merged with existing content and may overwrite existing files[/yellow]',
        );
        console.print('[cyan]--force supplied: skipping confirmation and proceeding with merge[/cyan]');
      } else if (nonInteractive) {
        console.print(
          '[red]Error:[/red] Current directory is not empty and ' +
            '--non-interactive was set. Re-run with ' +
            '[bold]--force[/bold] to merge into it.',
        );
        throw new CliExit(1);
      } else {
        const proceed = await initHooks.confirm(
          'Template files will be merged with existing content ' +
            'and may overwrite existing files. Do you want to continue?',
          false,
        );
        if (proceed === null) {
          if (initHooks.stdinIsInteractive()) {
            console.print('[yellow]Operation cancelled[/yellow]');
            throw new CliExit(0);
          }
          console.print(
            '[red]Error:[/red] Current directory is not empty and no ' +
              'confirmation input is available. Re-run with ' +
              '[bold]--force[/bold] to merge into it.',
          );
          throw new CliExit(1);
        }
        if (!proceed) {
          console.print('[yellow]Operation cancelled[/yellow]');
          throw new CliExit(0);
        }
      }
    }
  } else {
    projectPath = resolve(projectName as string);
    dirExistedBefore = existsSync(projectPath);
    if (existsSync(projectPath)) {
      const safeName = escapeMarkup(String(projectName));
      if (!statSync(projectPath).isDirectory()) {
        console.print(`[red]Error:[/red] '${safeName}' exists but is not a directory.`);
        throw new CliExit(1);
      }
      const existingItems = listDir(projectPath);
      if (force) {
        if (existingItems.length) {
          console.print(
            `[yellow]Warning:[/yellow] Directory '${safeName}' is not empty (${existingItems.length} items)`,
          );
          console.print(
            '[yellow]Template files will be merged with existing content and may overwrite existing files[/yellow]',
          );
        }
        console.print(`[cyan]--force supplied: merging into existing directory '[cyan]${safeName}[/cyan]'[/cyan]`);
      } else {
        const errorPanel = new Panel(
          `Directory already exists: '[cyan]${safeName}[/cyan]'\n` +
            'Please choose a different project name or remove the existing directory.\n' +
            'Use [bold]--force[/bold] to merge into the existing directory.',
          { title: '[red]Directory Conflict[/red]', borderStyle: 'red', padding: [1, 2] },
        );
        console.print();
        console.print(errorPanel);
        throw new CliExit(1);
      }
    }
  }

  const agentConfigs = AGENT_CONFIG as Record<string, Record<string, unknown>>;
  let selectedAi: string;
  if (integration) {
    if (!(integration in agentConfigs)) {
      console.print(
        `[red]Error:[/red] Invalid integration '${escapeMarkup(String(integration))}'. Choose from: ${Object.keys(agentConfigs).join(', ')}`,
      );
      throw new CliExit(1);
    }
    selectedAi = integration;
  } else if (!promptsAllowed(nonInteractive)) {
    const defaultIntegration = resolveDefaultInitIntegration();
    console.print(
      `[dim]Non-interactive session detected: defaulting to '${defaultIntegration}'. ` +
        'Use --integration to choose a different agent.[/dim]',
    );
    selectedAi = defaultIntegration;
  } else {
    const aiChoices: Record<string, string> = {};
    for (const [key, config] of Object.entries(agentConfigs)) aiChoices[key] = String(config['name']);
    selectedAi = await initHooks.selectWithArrows(
      aiChoices,
      'Choose your coding agent integration:',
      resolveDefaultInitIntegration(),
      { flagHint: '--integration <agent>' },
    );
  }

  if (!integration) {
    resolvedIntegration = getIntegration(selectedAi) ?? null;
    if (!resolvedIntegration) {
      console.print(`[red]Error:[/red] Unknown agent '${selectedAi}'`);
      throw new CliExit(1);
    }
  }
  const integ = resolvedIntegration as IntegrationBase;

  if (selectedAi === 'generic' && !integrationOptions) {
    console.print('[red]Error:[/red] --integration generic requires --integration-options with --commands-dir');
    console.print(
      '[dim]Example: specify init my-project --integration generic --integration-options="--commands-dir .myagent/commands/"[/dim]',
    );
    throw new CliExit(1);
  }

  const currentDir = process.cwd();

  const setupLines = [
    '[cyan]Specify Project Setup[/cyan]',
    '',
    `${'Project'.padEnd(15)} [green]${escapeMarkup(basename(projectPath))}[/green]`,
    `${'Working Path'.padEnd(15)} [dim]${escapeMarkup(currentDir)}[/dim]`,
  ];
  if (!here) {
    setupLines.push(`${'Target Path'.padEnd(15)} [dim]${escapeMarkup(projectPath)}[/dim]`);
  }
  console.print(new Panel(setupLines.join('\n'), { borderStyle: 'cyan', padding: [1, 2] }));

  if (!ignoreAgentTools) {
    const agentConfig = agentConfigs[selectedAi];
    if (agentConfig && agentConfig['requires_cli']) {
      const installUrl = pyStr(agentConfig['install_url']);
      if (!checkTool(selectedAi)) {
        const errorPanel = new Panel(
          `[cyan]${selectedAi}[/cyan] not found\n` +
            `Install from: [cyan]${installUrl}[/cyan]\n` +
            `${pyStr(agentConfig['name'])} is required to continue with this project type.\n\n` +
            'Tip: Use [cyan]--ignore-agent-tools[/cyan] to skip this check',
          { title: '[red]Agent Detection Error[/red]', borderStyle: 'red', padding: [1, 2] },
        );
        console.print();
        console.print(errorPanel);
        throw new CliExit(1);
      }
    }
  }

  let selectedScript: string;
  if (scriptType) {
    if (!(scriptType in SCRIPT_TYPE_CHOICES)) {
      console.print(
        `[red]Error:[/red] Invalid script type '${escapeMarkup(String(scriptType))}'. Choose from: ${Object.keys(SCRIPT_TYPE_CHOICES).join(', ')}`,
      );
      throw new CliExit(1);
    }
    selectedScript = scriptType;
  } else {
    const defaultScript = process.platform === 'win32' ? 'ps' : 'sh';
    if (promptsAllowed(nonInteractive)) {
      selectedScript = await initHooks.selectWithArrows(
        { ...SCRIPT_TYPE_CHOICES },
        'Choose script type (or press Enter)',
        defaultScript,
        { flagHint: '--script sh|ps|py' },
      );
    } else {
      selectedScript = defaultScript;
    }
  }

  console.print(`[cyan]Selected coding agent integration:[/cyan] ${selectedAi}`);
  console.print(`[cyan]Selected script type:[/cyan] ${selectedScript}`);

  const tracker = new StepTracker('Initialize Specify Project');

  tracker.add('precheck', 'Check required tools');
  tracker.complete('precheck', 'ok');
  tracker.add('ai-select', 'Select coding agent integration');
  tracker.complete('ai-select', `${selectedAi}`);
  tracker.add('script-select', 'Select script type');
  tracker.complete('script-select', selectedScript);

  tracker.add('integration', 'Install integration');
  tracker.add('shared-infra', 'Install shared infrastructure');

  for (const [key, label] of [
    ['chmod', 'Ensure scripts executable'],
    ['constitution', 'Constitution setup'],
    ['workflow', 'Install bundled workflow'],
  ] as const) {
    tracker.add(key, label);
  }

  if (extensions) {
    extensions.forEach((extSpec, i) => {
      tracker.add(`extension-${i}`, `Install extension: ${escapeMarkup(extSpec)}`);
    });
  }

  tracker.add('final', 'Finalize');

  // Resolve trust for URL-based extensions BEFORE any tracker rendering: the
  // confirmation prompt cannot be answered underneath a live display.
  let extensionUrlApprovals: Record<string, boolean> = {};
  if (extensions) {
    const urlSpecs = extensions.filter((e) => extSpecIsUrl(e));
    if (urlSpecs.length) {
      extensionUrlApprovals = await confirmExtensionUrlTrust(urlSpecs, {
        trustOverride: trustExtensionUrls,
        allowPrompt: promptsAllowed(nonInteractive),
      });
    }
  }

  // Disable transient mode on Windows: PowerShell 5.1's legacy console
  // hangs when the cursor state is restored via VT escape sequences.
  const transient = process.platform !== 'win32';

  // Upstream shows the tracker in a Rich Live display (transient except on
  // win32) and re-prints the final tree afterwards. The minimal console Live
  // cannot redraw around interleaved warnings (e.g. preserved shared-infra
  // files, preset failures), so the tree is rendered once when the steps
  // finish -- identical to upstream's final output in both modes.

  const integrationParsedOptions: Record<string, unknown> = {};
  try {
    tracker.start('integration');
    const manifest = new IntegrationManifest(integ.key, projectPath, initHooks.getSpeckitVersion());

    if (integrationOptions) {
      const extra = parseIntegrationOptions(integ, integrationOptions);
      if (extra) Object.assign(integrationParsedOptions, extra);
    }
    const parsedOrNull = Object.keys(integrationParsedOptions).length ? integrationParsedOptions : null;

    const eventsMap = resolveEvents(
      integ.key,
      (integ.config ?? null) as Record<string, unknown> | null,
      projectPath,
      parsedOrNull,
    );
    integ.setup(projectPath, manifest, parsedOrNull, {
      scriptType: selectedScript,
      rawOptions: integrationOptions,
      // SetupOptions.events is typed loosely by the integrations module; the
      // runtime value is the ResolvedEvents map, as upstream.
      events: eventsMap as unknown as SetupOptions['events'],
    });
    manifest.save();

    if (force) {
      await registerExtensionsForAgent(projectPath, integ.key, {
        force: true,
        continuing: 'The project was re-initialized, but installed extensions may need re-registration.',
      });
      await registerPresetsForAgent(projectPath, integ.key, {
        continuing: 'The project was re-initialized, but installed presets may need re-registration.',
      });
    }

    const integrationSettings = withIntegrationSetting({}, integ.key, integ, {
      scriptType: selectedScript,
      rawOptions: integrationOptions,
      parsedOptions: parsedOrNull,
      projectRoot: projectPath,
    });
    writeIntegrationJson(projectPath, integ.key, [integ.key], integrationSettings);

    tracker.complete('integration', String((integ.config as Record<string, unknown> | null)?.['name'] ?? integ.key));

    tracker.start('shared-infra');
    installSharedInfraOrExit(projectPath, selectedScript, {
      tracker,
      force,
      invokeSeparator: integ.effectiveInvokeSeparator(integrationParsedOptions, projectPath),
      invokePrefix: invokePrefixForIntegration(integ, integ.key, integrationParsedOptions, projectPath),
    });
    tracker.complete('shared-infra', `scripts (${selectedScript}) + templates`);

    try {
      const bundledWf = locateBundledWorkflow('speckit');
      if (bundledWf) {
        const wfRegistry = new WorkflowRegistry(projectPath);
        if (wfRegistry.isInstalled('speckit')) {
          tracker.complete('workflow', 'already installed');
        } else {
          const destWf = join(projectPath, '.specify', 'workflows', 'speckit');
          mkdirSync(destWf, { recursive: true });
          copyFileSync(join(bundledWf, 'workflow.yml'), join(destWf, 'workflow.yml'));
          const definition = WorkflowDefinition.fromYaml(join(destWf, 'workflow.yml'));
          wfRegistry.add('speckit', {
            name: definition.name,
            version: definition.version,
            description: definition.description,
            source: 'bundled',
          });
          tracker.complete('workflow', 'speckit installed');
        }
      } else {
        tracker.skip('workflow', 'bundled workflow not found');
      }
    } catch (wfErr) {
      if (wfErr instanceof CliExit) throw wfErr;
      const sanitizedWf = errorText(wfErr).replace(/\n/g, ' ').trim();
      tracker.error('workflow', `install failed: ${sanitizedWf.slice(0, 120)}`);
    }

    const initOpts: Record<string, unknown> = {
      ai: selectedAi,
      integration: integ.key,
      here,
      script: selectedScript,
      feature_numbering: 'sequential',
      speckit_version: initHooks.getSpeckitVersion(),
    };
    if (integ.isSkillsMode(parsedOrNull, projectPath)) {
      initOpts['ai_skills'] = true;
    }
    saveInitOptions(projectPath, initOpts);

    ensureExecutableScripts(projectPath, tracker);

    if (preset) {
      await installPresetDuringInit(projectPath, preset);
    }

    // Install extensions specified via --extension
    if (extensions) {
      const speckitVer = initHooks.getSpeckitVersion();
      let anyExtensionInstalled = false;
      for (let i = 0; i < extensions.length; i++) {
        const extSpec = extensions[i];
        tracker.start(`extension-${i}`);
        // Skip URL extensions the user did not confirm as trusted (default-deny).
        if (extSpecIsUrl(extSpec) && !(extensionUrlApprovals[extSpec] ?? false)) {
          tracker.error(`extension-${i}`, 'skipped: untrusted URL not confirmed (use --trust-extension-urls)');
          continue;
        }
        try {
          const statusMsg = await installExtensionDuringInit(projectPath, extSpec, speckitVer);
          tracker.complete(`extension-${i}`, statusMsg);
          anyExtensionInstalled = true;
        } catch (extErr) {
          if (extErr instanceof CliExit) throw extErr;
          const sanitizedExt = errorText(extErr).replace(/\n/g, ' ').trim();
          tracker.error(`extension-${i}`, `failed: ${escapeMarkup(sanitizedExt.slice(0, 120))}`);
        }
      }

      // Refresh native event configuration once after the batch.
      if (anyExtensionInstalled) {
        await refreshEventsAndWarn(projectPath);
      }
    }

    // Seed the constitution AFTER preset installation so that a
    // preset-provided constitution-template wins over the core template.
    ensureConstitutionFromTemplate(projectPath, tracker);

    tracker.complete('final', 'project ready');
  } catch (e) {
    if (e instanceof CliExit) throw e;
    tracker.error('final', errorText(e));
    // A non-transient (win32) Live leaves the last tracker frame on screen.
    if (!transient) console.print(tracker.render());
    console.print(new Panel(`Initialization failed: ${errorText(e)}`, { title: 'Failure', borderStyle: 'red' }));
    if (debug) {
      const envPairs: [string, string][] = [
        ['Node', process.version],
        ['Platform', process.platform],
        ['CWD', process.cwd()],
      ];
      const labelWidth = Math.max(...envPairs.map(([k]) => k.length));
      const envLines = envPairs.map(([k, v]) => `${k.padEnd(labelWidth)} → [bright_black]${v}[/bright_black]`);
      console.print(new Panel(envLines.join('\n'), { title: 'Debug Environment', borderStyle: 'magenta' }));
    }
    if (!here && existsSync(projectPath) && !dirExistedBefore) {
      rmSync(projectPath, { recursive: true, force: true });
    }
    throw new CliExit(1);
  }

  console.print(tracker.render());
  console.print('\n[bold green]Project ready.[/bold green]');

  const agentConfig = agentConfigs[selectedAi];
  if (agentConfig) {
    const agentFolder = (agentConfig['folder'] as string | null | undefined) || integrationParsedOptions['commands_dir'];
    if (agentFolder) {
      const securityNotice = new Panel(
        'Some agents may store credentials, auth tokens, or other identifying and private artifacts in the agent folder within your project.\n' +
          `Consider adding [cyan]${escapeMarkup(String(agentFolder))}[/cyan] (or parts of it) to [cyan].gitignore[/cyan] to prevent accidental credential leakage.`,
        { title: '[yellow]Agent Folder Security[/yellow]', borderStyle: 'yellow', padding: [1, 2] },
      );
      console.print();
      console.print(securityNotice);
    }
  }

  printNextSteps({
    here,
    projectName: String(projectName),
    selectedAi,
    isSkillsIntegration: integ.isSkillsMode(
      Object.keys(integrationParsedOptions).length ? integrationParsedOptions : null,
      projectPath,
    ),
  });
}

// ============================================================================
// Preset installation during init
// ============================================================================

async function installPresetDuringInit(projectPath: string, preset: string): Promise<void> {
  try {
    const presetManager = new PresetManager(projectPath);
    const speckitVer = initHooks.getSpeckitVersion();

    const localPath = resolve(preset);
    if (isDirectory(localPath) && existsSync(join(localPath, 'preset.yml'))) {
      await presetManager.installFromDirectory(localPath, speckitVer);
    } else {
      const bundledPath = locateBundledPreset(preset);
      if (bundledPath) {
        await presetManager.installFromDirectory(bundledPath, speckitVer);
      } else {
        const presetCatalog = new PresetCatalog(projectPath);
        const packInfo = (await presetCatalog.getPackInfo(preset)) as Record<string, unknown> | null;
        if (!packInfo) {
          console.print(`[yellow]Warning:[/yellow] Preset '${preset}' not found in catalog. Skipping.`);
        } else if (packInfo['bundled'] && !packInfo['download_url']) {
          console.print(
            `[yellow]Warning:[/yellow] Preset '${preset}' is bundled with spec-kit ` +
              'but could not be found in the installed package.',
          );
          console.print('This usually means the spec-kit installation is incomplete or corrupted.');
          console.print(`Try reinstalling: ${REINSTALL_COMMAND}`);
        } else {
          let zipPath: string | null = null;
          try {
            zipPath = (await presetCatalog.downloadPack(preset)) as string;
            await presetManager.installFromZip(zipPath, speckitVer, 10, {
              catalogName: (packInfo['_catalog_name'] as string | undefined) ?? null,
            });
          } catch (presetErr) {
            if (!(presetErr instanceof PresetError)) throw presetErr;
            printCliWarning('install', 'preset', preset, presetErr, {
              continuing: 'Continuing without the optional preset.',
            });
          } finally {
            if (zipPath !== null) {
              try {
                rmSync(zipPath, { force: true });
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
    }
  } catch (presetErr) {
    if (presetErr instanceof CliExit) throw presetErr;
    printCliWarning('install', 'preset', preset, presetErr, {
      continuing: 'Continuing without the optional preset.',
    });
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ============================================================================
// Next steps / enhancement panels
// ============================================================================

function printNextSteps(opts: {
  here: boolean;
  projectName: string;
  selectedAi: string;
  isSkillsIntegration: boolean;
}): void {
  const { here, projectName, selectedAi } = opts;
  const isSkills = opts.isSkillsIntegration;
  const stepsLines: string[] = [];
  let stepNum: number;
  if (!here) {
    stepsLines.push(
      `1. Go to the project folder: [cyan]cd ${escapeMarkup(shellQuoteArg(projectName))}[/cyan]`,
    );
    stepNum = 2;
  } else {
    stepsLines.push("1. You're already in the project directory!");
    stepNum = 2;
  }

  const codexSkillMode = selectedAi === 'codex' && isSkills;
  const zcodeSkillMode = selectedAi === 'zcode' && isSkills;
  const claudeSkillMode = selectedAi === 'claude' && isSkills;
  const kimiSkillMode = selectedAi === 'kimi';
  const agySkillMode = selectedAi === 'agy' && isSkills;
  const traeSkillMode = selectedAi === 'trae';
  const cursorAgentSkillMode = selectedAi === 'cursor-agent' && isSkills;
  const copilotSkillMode = selectedAi === 'copilot' && isSkills;
  const devinSkillMode = selectedAi === 'devin';
  const zedSkillMode = selectedAi === 'zed' && isSkills;
  const museSkillMode = selectedAi === 'muse' && isSkills;
  const grokSkillMode = selectedAi === 'grok' && isSkills;
  const dshSkillMode = selectedAi === 'dsh' && isSkills;
  const clineSkillMode = selectedAi === 'cline';
  const forgeSkillMode = selectedAi === 'forge';
  const bobSkillMode = selectedAi === 'bob' && isSkills;
  const nativeSkillMode =
    codexSkillMode ||
    zcodeSkillMode ||
    claudeSkillMode ||
    kimiSkillMode ||
    agySkillMode ||
    traeSkillMode ||
    cursorAgentSkillMode ||
    copilotSkillMode ||
    devinSkillMode ||
    zedSkillMode ||
    museSkillMode ||
    grokSkillMode ||
    dshSkillMode ||
    bobSkillMode;

  const startLines: [boolean, string][] = [
    [codexSkillMode, 'Start Codex in this project directory; spec-kit skills were installed to [cyan].agents/skills[/cyan]'],
    [zcodeSkillMode, 'Start ZCode in this project directory; spec-kit skills were installed to [cyan].zcode/skills[/cyan]'],
    [claudeSkillMode, 'Start Claude in this project directory; spec-kit skills were installed to [cyan].claude/skills[/cyan]'],
    [
      cursorAgentSkillMode,
      'Start Cursor Agent in this project directory; spec-kit skills were installed to [cyan].cursor/skills[/cyan]',
    ],
    [devinSkillMode, 'Start Devin in this project directory; spec-kit skills were installed to [cyan].devin/skills[/cyan]'],
    [zedSkillMode, 'Start Zed in this project directory; spec-kit skills were installed to [cyan].agents/skills[/cyan]'],
    [museSkillMode, 'Start Muse Code in this project directory; spec-kit skills were installed to [cyan].agents/skills[/cyan]'],
    [grokSkillMode, 'Start Grok Build in this project directory; spec-kit skills were installed to [cyan].grok/skills[/cyan]'],
    [
      dshSkillMode,
      'Start DSH ([cyan]dsh web[/cyan]) in this project directory; spec-kit skills were installed to [cyan].dsh/skills[/cyan]',
    ],
    [bobSkillMode, 'Start Bob in this project directory; spec-kit skills were installed to [cyan].bob/skills[/cyan]'],
  ];
  for (const [enabled, text] of startLines) {
    if (enabled) {
      stepsLines.push(`${stepNum}. ${text}`);
      stepNum += 1;
    }
  }
  const usageLabel = nativeSkillMode ? 'skills' : 'slash commands';

  const aiSkillsEnabled = isSkills;
  const displayCmd = (name: string): string => {
    if (isDollarSkillsAgent(selectedAi, aiSkillsEnabled)) return `$speckit-${name}`;
    if (kimiSkillMode) return `/skill:speckit-${name}`;
    if (isSlashSkillsAgent(selectedAi, aiSkillsEnabled) || clineSkillMode || forgeSkillMode) {
      return `/speckit-${name}`;
    }
    return `/speckit.${name}`;
  };

  stepsLines.push(`${stepNum}. Start using ${usageLabel} with your coding agent:`);
  stepsLines.push(`   ${stepNum}.1 [cyan]${displayCmd('constitution')}[/] - Establish project principles`);
  stepsLines.push(`   ${stepNum}.2 [cyan]${displayCmd('specify')}[/] - Create baseline specification`);
  stepsLines.push(`   ${stepNum}.3 [cyan]${displayCmd('plan')}[/] - Create implementation plan`);
  stepsLines.push(`   ${stepNum}.4 [cyan]${displayCmd('tasks')}[/] - Generate actionable tasks`);
  stepsLines.push(`   ${stepNum}.5 [cyan]${displayCmd('implement')}[/] - Execute implementation`);
  stepsLines.push(
    `   ${stepNum}.6 [cyan]${displayCmd('converge')}[/] - Assess the codebase and append remaining work as tasks`,
  );

  console.print();
  console.print(new Panel(stepsLines.join('\n'), { title: 'Next Steps', borderStyle: 'cyan', padding: [1, 2] }));

  const enhancementIntro = nativeSkillMode
    ? 'Optional skills that you can use for your specs [bright_black](improve quality & confidence)[/bright_black]'
    : 'Optional commands that you can use for your specs [bright_black](improve quality & confidence)[/bright_black]';
  const enhancementLines = [
    enhancementIntro,
    '',
    `○ [cyan]${displayCmd('clarify')}[/] [bright_black](optional)[/bright_black] - Ask structured questions to de-risk ambiguous areas before planning (run before [cyan]${displayCmd('plan')}[/] if used)`,
    `○ [cyan]${displayCmd('analyze')}[/] [bright_black](optional)[/bright_black] - Cross-artifact consistency & alignment report (after [cyan]${displayCmd('tasks')}[/], before [cyan]${displayCmd('implement')}[/])`,
    `○ [cyan]${displayCmd('checklist')}[/] [bright_black](optional)[/bright_black] - Generate quality checklists to validate requirements completeness, clarity, and consistency (after [cyan]${displayCmd('plan')}[/])`,
  ];
  const enhancementsTitle = nativeSkillMode ? 'Enhancement Skills' : 'Enhancement Commands';
  console.print();
  console.print(
    new Panel(enhancementLines.join('\n'), { title: enhancementsTitle, borderStyle: 'cyan', padding: [1, 2] }),
  );
}

// ============================================================================
// CLI adapter
// ============================================================================

/**
 * `specify init ...` CLI adapter. `args` excludes the `init` word.
 * Returns the process exit code.
 */
export async function runInitCommand(args: string[]): Promise<number> {
  return runCommand(INIT_COMMAND_SPEC, args, 'specify init', (parsed) => init(toInitOptions(parsed)));
}
