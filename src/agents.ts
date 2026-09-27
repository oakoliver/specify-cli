/**
 * @oakoliver/specify-cli - Agent Command Registrar
 *
 * Port of `agents.py`: shared infrastructure for registering commands with AI
 * agents. Used by both the extension system and the preset system to write
 * command files into agent-specific directories in the correct format.
 *
 * All operations are synchronous (mirrors Python).
 *
 * @module agents
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, parse as parsePath, relative, sep } from 'node:path';

import { isAiSkillsEnabled, loadInitOptions } from './init-options.js';
import { getInvocationPrefix } from './invocation-style.js';
import { escapeTomlBasic, hasIllegalTomlControl } from './toml-string.js';
import { relativeExtensionPathViolation } from './utils.js';
import { dumpYaml, parseYaml } from './yaml.js';
import { INTEGRATION_REGISTRY, getIntegration } from './integrations/index.js';
import {
  IntegrationBase,
  YamlIntegration,
  buildSkillFrontmatter,
  pyRepr,
  pyRstrip,
  pyStr,
  pyStrip,
  replaceAllLiteral,
  rewriteProjectRelativePaths,
  splitlines,
  warn,
  type RegistrarConfig,
} from './integrations/base.js';
import { ValueError, homeDir, isValueError, isDir, isFile, isOSError, isRelativeTo, isSymlink, resolvePath } from './integrations/manifest.js';
import { substituteCoreTemplate } from './presets/manager-commands.js';
import { resolveActiveSkillsDir } from './shared-infra.js';

// ============================================================================
// Types
// ============================================================================

/** One entry of ``CommandRegistrar.AGENT_CONFIGS``. */
export interface AgentRegistrarConfig extends RegistrarConfig {
  invoke_separator: string;
}

/** Command info dict (``{name, file, aliases?}``). */
export interface CommandInfo {
  name: string;
  file: string;
  aliases?: string[] | null;
  [key: string]: unknown;
}

/** ``{agent: [command names]}`` */
export type RegisteredCommandsMap = Record<string, string[]>;

export interface RegisterCommandsOptions {
  /** Custom context comment for markdown output. */
  contextNote?: string | null;
  /** Pre-resolved command directory (internal). */
  resolvedDir?: string | null;
  /** Write dev-cache output and symlink agent files to it. */
  linkOutputs?: boolean;
  /** Extension id when rendering extension-owned commands. */
  extensionId?: string | null;
  /** Author attributed in generated skill metadata. */
  author?: unknown;
}

export interface RegisterForAllAgentsOptions {
  contextNote?: string | null;
  linkOutputs?: boolean;
  createMissingActiveSkillsDir?: boolean;
  extensionId?: string | null;
  onlyAgent?: string | null;
  author?: unknown;
}

export interface RegisterForNonSkillAgentsOptions {
  contextNote?: string | null;
  linkOutputs?: boolean;
  extensionId?: string | null;
  onlyAgent?: string | null;
  extraAgents?: Iterable<string> | null;
}

// ============================================================================
// AGENT_CONFIGS derivation
// ============================================================================

/** Derive ``CommandRegistrar.AGENT_CONFIGS`` from ``INTEGRATION_REGISTRY``. */
export function buildAgentConfigs(): Record<string, AgentRegistrarConfig> {
  const configs: Record<string, AgentRegistrarConfig> = {};
  for (const [key, integration] of Object.entries(INTEGRATION_REGISTRY)) {
    if (key === 'generic') continue;
    if (integration.registrarConfig) {
      const config = { ...integration.registrarConfig } as AgentRegistrarConfig;
      if (!('invoke_separator' in config) || config.invoke_separator === undefined) {
        config.invoke_separator = integration.invokeSeparator;
      }
      if (integration.devNoSymlink) config.dev_no_symlink = true;
      configs[key] = config;
    }
  }
  return configs;
}

const SPECKIT_DOTTED_REF = /\bspeckit\.[A-Za-z0-9\-_]+(?:\.[A-Za-z0-9\-_]+)*\b/g;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepCopy(v)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepCopy(v);
    return out as T;
  }
  return value;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

// ============================================================================
// CommandRegistrar
// ============================================================================

/**
 * Handles registration of commands with AI agents (Markdown, TOML, YAML and
 * SKILL.md outputs, correct argument placeholders, companion files).
 */
export class CommandRegistrar {
  private static _agentConfigs: Record<string, AgentRegistrarConfig> = {};
  private static _configsLoaded = false;

  /** Derived from ``INTEGRATION_REGISTRY`` — built lazily on first access. */
  static get AGENT_CONFIGS(): Record<string, AgentRegistrarConfig> {
    CommandRegistrar.ensureConfigs();
    return CommandRegistrar._agentConfigs;
  }

  /** Replace the config table (tests / monkeypatching). */
  static set AGENT_CONFIGS(value: Record<string, AgentRegistrarConfig>) {
    CommandRegistrar._agentConfigs = value;
    CommandRegistrar._configsLoaded = true;
  }

  /** Instance view of the static table (Python ``self.AGENT_CONFIGS``). */
  get AGENT_CONFIGS(): Record<string, AgentRegistrarConfig> {
    return CommandRegistrar.AGENT_CONFIGS;
  }

  /** Build ``AGENT_CONFIGS`` if not yet loaded. */
  static ensureConfigs(): void {
    if (!CommandRegistrar._configsLoaded) {
      const built = buildAgentConfigs();
      if (Object.keys(built).length > 0) {
        CommandRegistrar._agentConfigs = built;
        CommandRegistrar._configsLoaded = true;
      }
    }
  }

  /** Force a rebuild from the registry on next access. */
  static resetConfigs(): void {
    CommandRegistrar._configsLoaded = false;
    CommandRegistrar._agentConfigs = {};
  }

  constructor() {
    CommandRegistrar.ensureConfigs();
  }

  // -- Reference hyphenation --------------------------------------------

  /** Recursively hyphenate dotted ``speckit.`` references in frontmatter values. */
  static hyphenateFrontmatterRefs(val: unknown): unknown {
    if (isPlainObject(val)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) out[k] = CommandRegistrar.hyphenateFrontmatterRefs(v);
      return out;
    }
    if (Array.isArray(val)) return val.map((x) => CommandRegistrar.hyphenateFrontmatterRefs(x));
    if (typeof val === 'string') return CommandRegistrar.hyphenateBodyRefs(val);
    return val;
  }

  /** Hyphenate dotted speckit references in command body text. */
  static hyphenateBodyRefs(body: string): string {
    return body.replace(SPECKIT_DOTTED_REF, (m) => replaceAllLiteral(m, '.', '-'));
  }

  // -- Frontmatter ------------------------------------------------------

  /** Parse YAML frontmatter from Markdown content → ``[frontmatter, body]``. */
  static parseFrontmatter(content: string): [Record<string, unknown>, string] {
    if (!content.startsWith('---')) return [{}, content];
    const lines = splitlines(content, true);
    let endLine: number | null = null;
    for (let i = 1; i < lines.length; i++) {
      if (pyRstrip(lines[i]) === '---') {
        endLine = i;
        break;
      }
    }
    if (endLine === null) return [{}, content];
    const fmStr = pyStrip(lines.slice(1, endLine).join(''));
    const body = pyStrip(lines.slice(endLine + 1).join(''));
    let frontmatter: unknown;
    try {
      frontmatter = parseYaml(fmStr) ?? {};
    } catch {
      frontmatter = {};
    }
    if (!isPlainObject(frontmatter)) frontmatter = {};
    return [frontmatter as Record<string, unknown>, body];
  }

  parseFrontmatter(content: string): [Record<string, unknown>, string] {
    return CommandRegistrar.parseFrontmatter(content);
  }

  /** Render a frontmatter dict as ``---\n<yaml>---\n`` (``""`` when empty). */
  static renderFrontmatter(fm: Record<string, unknown>): string {
    if (!fm || Object.keys(fm).length === 0) return '';
    const yamlStr = dumpYaml(fm, {
      defaultFlowStyle: false,
      sortKeys: false,
      allowUnicode: true,
      width: Infinity,
    });
    return `---\n${yamlStr}---\n`;
  }

  renderFrontmatter(fm: Record<string, unknown>): string {
    return CommandRegistrar.renderFrontmatter(fm);
  }

  /** Normalize script paths under the ``scripts`` key to ``.specify/...`` locations. */
  adjustScriptPaths(frontmatter: Record<string, unknown>, extensionId: string | null = null): Record<string, unknown> {
    const copy = deepCopy(frontmatter);
    const scripts = copy.scripts;
    if (isPlainObject(scripts)) {
      for (const [key, scriptPath] of Object.entries(scripts)) {
        if (typeof scriptPath === 'string') {
          scripts[key] = CommandRegistrar.rewriteProjectRelativePaths(scriptPath, extensionId);
        }
      }
    }
    return copy;
  }

  /** Rewrite repo-relative paths to their generated project locations. */
  static rewriteProjectRelativePaths(text: string, extensionId: string | null = null): string {
    return rewriteProjectRelativePaths(text, extensionId);
  }

  /**
   * Rewrite extension-relative paths (``agents/x.md``) to
   * ``.specify/extensions/<id>/agents/x.md`` for subdirectories that exist in
   * *extensionDir* (``commands``, ``specs`` and dot-dirs excluded).
   */
  static rewriteExtensionPaths(text: string, extensionId: string, extensionDir: string): string {
    if (typeof text !== 'string' || !text) return text;
    const skip = new Set(['commands', '.git', 'specs']);
    let subdirs: string[];
    try {
      subdirs = readdirSync(extensionDir).filter(
        (name) => isDir(join(extensionDir, name)) && !skip.has(name) && !name.startsWith('.'),
      );
    } catch {
      return text;
    }
    for (const subdir of subdirs) {
      const replacement = `.specify/extensions/${extensionId}/${subdir}/`;
      const re = new RegExp('(^|[\\s`"\'(])(?:\\./)?' + escapeRegExp(subdir) + '/', 'g');
      text = text.replace(re, (_m, pre: string) => pre + replacement);
    }
    return text;
  }

  // -- Renderers --------------------------------------------------------

  /** Render command in Markdown format. */
  renderMarkdownCommand(
    frontmatter: Record<string, unknown>,
    body: string,
    sourceId: string,
    contextNote: string | null = null,
  ): string {
    const note = contextNote ?? `\n<!-- Source: ${sourceId} -->\n`;
    return this.renderFrontmatter(frontmatter) + '\n' + note + body;
  }

  /** Render command in TOML format. */
  renderTomlCommand(frontmatter: Record<string, unknown>, body: string, sourceId: string): string {
    const lines: string[] = [];
    if ('description' in frontmatter) {
      let description = frontmatter.description;
      if (typeof description !== 'string') {
        description = description !== null && description !== undefined ? pyStr(description) : '';
      }
      lines.push(`description = ${CommandRegistrar.renderBasicTomlString(description as string)}`);
      lines.push('');
    }
    lines.push(`# Source: ${sourceId}`);
    lines.push('');
    if (hasIllegalTomlControl(body)) {
      lines.push(`prompt = ${CommandRegistrar.renderBasicTomlString(body)}`);
    } else if (!body.includes('"""') && !body.includes('\\')) {
      lines.push('prompt = """');
      lines.push(body);
      lines.push('"""');
    } else if (!body.includes("'''")) {
      lines.push("prompt = '''");
      lines.push(body);
      lines.push("'''");
    } else {
      lines.push(`prompt = ${CommandRegistrar.renderBasicTomlString(body)}`);
    }
    return lines.join('\n');
  }

  static hasIllegalTomlControl(value: string): boolean {
    return hasIllegalTomlControl(value);
  }

  static renderBasicTomlString(value: string): string {
    return escapeTomlBasic(value);
  }

  /** Render command in YAML recipe format (Goose). */
  renderYamlCommand(frontmatter: Record<string, unknown>, body: string, sourceId: string, cmdName = ''): string {
    const truthy = (v: unknown) => v !== undefined && v !== null && v !== '' && v !== false && v !== 0;
    let title: unknown = truthy(frontmatter.title) ? frontmatter.title : frontmatter.name ?? '';
    if (typeof title !== 'string') title = title !== null && title !== undefined ? pyStr(title) : '';
    if (!title && cmdName) title = YamlIntegration.humanTitle(cmdName);
    if (!title && sourceId) title = YamlIntegration.humanTitle(parsePath(basename(String(sourceId))).name);
    if (!title) title = 'Command';
    let description: unknown = 'description' in frontmatter ? frontmatter.description : '';
    if (typeof description !== 'string') {
      description = description !== null && description !== undefined ? pyStr(description) : '';
    }
    return YamlIntegration.renderYaml(title as string, description as string, body, sourceId);
  }

  /** Render a command override as a SKILL.md file. */
  renderSkillCommand(
    agentName: string,
    skillName: string,
    frontmatter: Record<string, unknown>,
    body: string,
    sourceId: string,
    sourceFile: string,
    projectRoot: string,
    opts: { extensionId?: string | null; author?: unknown } = {},
  ): string {
    if (!isPlainObject(frontmatter)) frontmatter = {};
    const agentConfig = this.AGENT_CONFIGS[agentName];
    if (agentConfig && agentConfig.extension === '/SKILL.md') {
      body = CommandRegistrar.resolveSkillPlaceholders(agentName, frontmatter, body, projectRoot, opts.extensionId ?? null);
    }
    const description = 'description' in frontmatter ? frontmatter.description : `Spec-kit workflow command: ${skillName}`;
    const skillFrontmatter = CommandRegistrar.buildSkillFrontmatter(
      agentName,
      skillName,
      description,
      `${sourceId}:${sourceFile}`,
      opts.author === undefined ? 'github-spec-kit' : opts.author,
    );
    return this.renderFrontmatter(skillFrontmatter) + '\n' + body;
  }

  /** Build consistent SKILL.md frontmatter across all skill generators. */
  static buildSkillFrontmatter(
    agentName: string,
    skillName: string,
    description: unknown,
    source: string,
    author: unknown = 'github-spec-kit',
  ): Record<string, unknown> {
    return buildSkillFrontmatter(agentName, skillName, description, source, author);
  }

  /**
   * Carry a command's ``argument-hint`` into its generated skill frontmatter
   * (mutates *skillFrontmatter*) for integrations exposing
   * ``injectArgumentHint`` (Claude, Alquimia).
   */
  static applyArgumentHint(
    sourceFrontmatter: Record<string, unknown>,
    skillFrontmatter: Record<string, unknown>,
    integration: unknown = null,
  ): void {
    if (!isPlainObject(sourceFrontmatter) || !isPlainObject(skillFrontmatter)) return;
    const hint = sourceFrontmatter['argument-hint'];
    const truthy = hint !== undefined && hint !== null && hint !== '' && hint !== false && hint !== 0;
    if (
      truthy &&
      integration !== null &&
      integration !== undefined &&
      typeof (integration as { injectArgumentHint?: unknown }).injectArgumentHint === 'function'
    ) {
      skillFrontmatter['argument-hint'] = pyStr(hint);
    }
  }

  /** Resolve script placeholders for skills-backed agents. */
  static resolveSkillPlaceholders(
    agentName: string,
    frontmatter: Record<string, unknown>,
    body: string,
    projectRoot: string,
    extensionId: string | null = null,
  ): string {
    if (!isPlainObject(frontmatter)) frontmatter = {};
    let scripts: unknown = frontmatter.scripts ?? {};
    if (!isPlainObject(scripts)) scripts = {};
    const scriptMap = scripts as Record<string, unknown>;
    let initOpts: unknown = loadInitOptions(projectRoot);
    if (!isPlainObject(initOpts)) initOpts = {};
    let scriptVariant: unknown = (initOpts as Record<string, unknown>).script;
    if (Object.keys(scriptMap).length > 0) {
      scriptVariant = IntegrationBase.selectScriptVariant(scriptVariant, scriptMap);
    }
    let scriptCommand: unknown = scriptVariant ? scriptMap[scriptVariant as string] : null;
    if (typeof scriptCommand === 'string' && scriptCommand) {
      if (scriptVariant === 'py') {
        scriptCommand = IntegrationBase.buildPythonInvocation(scriptCommand as string, projectRoot);
      }
      scriptCommand = replaceAllLiteral(scriptCommand as string, '{ARGS}', '$ARGUMENTS');
      body = replaceAllLiteral(body, '{SCRIPT}', scriptCommand as string);
    }
    body = replaceAllLiteral(replaceAllLiteral(body, '{ARGS}', '$ARGUMENTS'), '__AGENT__', agentName);
    return CommandRegistrar.rewriteProjectRelativePaths(body, extensionId);
  }

  /** Convert argument placeholder format. */
  convertArgumentPlaceholder(content: string, fromPlaceholder: string, toPlaceholder: string): string {
    return replaceAllLiteral(content, fromPlaceholder, toPlaceholder);
  }

  /** On-disk command or skill name for an agent. */
  static computeOutputName(_agentName: string, cmdName: string, agentConfig: RegistrarConfig): string {
    if (agentConfig.extension !== '/SKILL.md') {
      const formatName = agentConfig.format_name;
      if (typeof formatName === 'function') return formatName(cmdName);
      return cmdName;
    }
    let shortName = cmdName;
    if (shortName.startsWith('speckit.')) shortName = shortName.slice('speckit.'.length);
    shortName = replaceAllLiteral(shortName, '.', '-');
    return `speckit-${shortName}`;
  }

  /** Validate that a write target stays within *base* (lexical). */
  static ensureInside(candidate: string, base: string): void {
    const normalized = normalize(candidate);
    const baseNormalized = normalize(base);
    if (!isRelativeTo(normalized, baseNormalized)) {
      throw new ValueError(`Output path ${pyRepr(candidate)} escapes directory ${pyRepr(base)}`);
    }
  }

  /** Reject names that could escape the commands directory. */
  static isSafeCommandName(name: string): boolean {
    if (name.includes(sep) || name.includes('/') || name.includes('\\')) return false;
    return pyNormpath(name) === name;
  }

  /** Compare paths after lexical normalization. */
  static sameLexicalPath(left: string, right: string): boolean {
    const norm = (p: string) => {
      const n = pyNormpath(p);
      return process.platform === 'win32' ? n.toLowerCase() : n;
    };
    return norm(left) === norm(right);
  }

  /** The initialized skills-backed agent, if skills mode is active. */
  static activeSkillsAgent(projectRoot: string): string | null {
    const opts: unknown = loadInitOptions(projectRoot);
    if (!isPlainObject(opts)) return null;
    const agent = opts.ai;
    if (typeof agent !== 'string' || !agent) return null;
    if (!isAiSkillsEnabled(opts) && agent !== 'kimi') return null;
    return agent;
  }

  // -- Registration -----------------------------------------------------

  /**
   * Register commands for a specific agent. Returns the list of registered
   * command names (including aliases). Throws {@link ValueError} for an
   * unsupported agent or unsafe names.
   */
  registerCommands(
    agentName: string,
    commands: CommandInfo[],
    sourceId: string,
    sourceDir: string,
    projectRoot: string,
    opts: RegisterCommandsOptions = {},
  ): string[] {
    CommandRegistrar.ensureConfigs();
    const configs = this.AGENT_CONFIGS;
    if (!(agentName in configs)) throw new ValueError(`Unsupported agent: ${agentName}`);
    const agentConfig = configs[agentName];
    const contextNote = opts.contextNote ?? null;
    const linkOutputs = opts.linkOutputs ?? false;
    const extensionId = opts.extensionId ?? null;
    const author = opts.author === undefined ? 'github-spec-kit' : opts.author;

    const commandsDir = opts.resolvedDir || CommandRegistrar.resolveAgentDir(agentName, agentConfig, projectRoot);
    mkdirSync(commandsDir, { recursive: true });

    const registered: string[] = [];
    const isClineExt = agentName === 'cline' && sourceId !== 'core';
    const sourceRoot = resolvePath(sourceDir);

    let sepChar = agentConfig.invoke_separator ?? '.';
    const registrarWritesSkills = agentConfig.extension === '/SKILL.md';
    const integ = getIntegration(agentName);
    if (integ) sepChar = integ.invokeSeparatorForMode(registrarWritesSkills);
    const prefix = getInvocationPrefix(agentName, registrarWritesSkills);

    for (const cmdInfo of commands) {
      const cmdName = cmdInfo.name;
      let aliases: unknown = 'aliases' in cmdInfo ? cmdInfo.aliases : [];
      const cmdFile = cmdInfo.file;
      const nameReason = relativeExtensionPathViolation(cmdName);
      if (nameReason) throw new ValueError(`Invalid command name ${pyRepr(cmdName)}: ${nameReason}`);
      if (aliases === null || aliases === undefined) aliases = [];
      if (!Array.isArray(aliases)) throw new ValueError(`Aliases for command ${pyRepr(cmdName)} must be a list`);
      for (const alias of aliases as unknown[]) {
        const aliasReason = relativeExtensionPathViolation(alias);
        if (aliasReason) throw new ValueError(`Invalid command alias ${pyRepr(alias)}: ${aliasReason}`);
      }
      const aliasList = aliases as string[];

      if (relativeExtensionPathViolation(cmdFile)) continue;
      let sourceFile: string;
      try {
        sourceFile = resolvePath(join(sourceRoot, cmdFile));
        if (!isRelativeTo(sourceFile, sourceRoot)) continue;
      } catch {
        continue;
      }
      if (!isFile(sourceFile)) continue;

      let content: string;
      try {
        content = decodeUtf8(readFileSync(sourceFile));
      } catch (exc) {
        const name = exc instanceof TypeError ? 'UnicodeDecodeError' : (exc as Error).name || 'OSError';
        warn(
          `Skipping command '${cmdName}': could not read source file '${cmdFile}' (${name}: ${(exc as Error).message}).`,
        );
        continue;
      }
      let [frontmatter, body] = this.parseFrontmatter(content);

      if (frontmatter.strategy === 'wrap') {
        const [newBody, coreFrontmatter] = substituteCoreTemplate(body, cmdName, projectRoot, this) as [
          string,
          Record<string, unknown>,
        ];
        body = newBody;
        frontmatter = { ...frontmatter };
        for (const key of ['scripts', 'agent_scripts']) {
          if (!(key in frontmatter) && coreFrontmatter && key in coreFrontmatter) {
            frontmatter[key] = coreFrontmatter[key];
          }
        }
        delete frontmatter.strategy;
      }

      if (extensionId) body = CommandRegistrar.rewriteExtensionPaths(body, extensionId, sourceRoot);

      frontmatter = this.adjustScriptPaths(frontmatter, extensionId);

      for (const key of agentConfig.strip_frontmatter_keys ?? []) delete frontmatter[key];

      if (agentConfig.inject_name && !frontmatter.name) {
        const formatName = agentConfig.format_name;
        frontmatter.name = typeof formatName === 'function' ? formatName(cmdName) : cmdName;
      }

      if (isClineExt) {
        frontmatter = CommandRegistrar.hyphenateFrontmatterRefs(frontmatter) as Record<string, unknown>;
        body = CommandRegistrar.hyphenateBodyRefs(body);
      }

      body = this.convertArgumentPlaceholder(body, '$ARGUMENTS', agentConfig.args);
      body = IntegrationBase.resolveCommandRefs(body, sepChar, prefix);

      const outputName = CommandRegistrar.computeOutputName(agentName, cmdName, agentConfig);

      let output: string;
      if (agentConfig.extension === '/SKILL.md') {
        output = this.renderSkillCommand(agentName, outputName, frontmatter, body, sourceId, cmdFile, projectRoot, {
          extensionId,
          author,
        });
      } else if (agentConfig.format === 'markdown') {
        body = CommandRegistrar.resolveSkillPlaceholders(agentName, frontmatter, body, projectRoot, extensionId);
        if (extensionId) delete frontmatter.scripts;
        body = this.convertArgumentPlaceholder(body, '$ARGUMENTS', agentConfig.args);
        output = this.renderMarkdownCommand(frontmatter, body, sourceId, contextNote);
      } else if (agentConfig.format === 'toml') {
        body = CommandRegistrar.resolveSkillPlaceholders(agentName, frontmatter, body, projectRoot, extensionId);
        body = this.convertArgumentPlaceholder(body, '$ARGUMENTS', agentConfig.args);
        output = this.renderTomlCommand(frontmatter, body, sourceId);
      } else if (agentConfig.format === 'yaml') {
        body = CommandRegistrar.resolveSkillPlaceholders(agentName, frontmatter, body, projectRoot);
        body = this.convertArgumentPlaceholder(body, '$ARGUMENTS', agentConfig.args);
        output = this.renderYamlCommand(frontmatter, body, sourceId, cmdName);
      } else {
        throw new ValueError(`Unsupported format: ${String(agentConfig.format)}`);
      }

      let integration: IntegrationBase | null = null;
      if (agentConfig.extension !== '/SKILL.md') {
        integration = getIntegration(agentName);
        if (integration) output = integration.postProcessCommandContent(output);
      }

      const destFile = join(commandsDir, `${outputName}${agentConfig.extension}`);
      CommandRegistrar.ensureInside(destFile, commandsDir);
      mkdirSync(dirname(destFile), { recursive: true });
      CommandRegistrar.writeRegisteredOutput(
        destFile,
        output,
        sourceDir,
        agentName,
        outputName,
        agentConfig.extension,
        linkOutputs,
        agentConfig,
      );

      if (agentName === 'copilot') CommandRegistrar.writeCopilotPrompt(projectRoot, cmdName);
      registered.push(cmdName);

      for (const alias of aliasList) {
        const aliasOutputName = CommandRegistrar.computeOutputName(agentName, alias, agentConfig);
        let aliasOutput: string;
        if (agentConfig.inject_name) {
          const aliasFrontmatter = deepCopy(frontmatter);
          const formatName = agentConfig.format_name;
          aliasFrontmatter.name = typeof formatName === 'function' ? formatName(alias) : alias;
          if (agentConfig.extension === '/SKILL.md') {
            aliasOutput = this.renderSkillCommand(agentName, aliasOutputName, aliasFrontmatter, body, sourceId, cmdFile, projectRoot, {
              extensionId,
              author,
            });
          } else if (agentConfig.format === 'markdown') {
            aliasOutput = this.renderMarkdownCommand(aliasFrontmatter, body, sourceId, contextNote);
          } else if (agentConfig.format === 'toml') {
            aliasOutput = this.renderTomlCommand(aliasFrontmatter, body, sourceId);
          } else if (agentConfig.format === 'yaml') {
            aliasOutput = this.renderYamlCommand(aliasFrontmatter, body, sourceId, alias);
          } else {
            throw new ValueError(`Unsupported format: ${String(agentConfig.format)}`);
          }
          if (agentConfig.extension !== '/SKILL.md' && integration) {
            aliasOutput = integration.postProcessCommandContent(aliasOutput);
          }
        } else {
          aliasOutput = output;
          if (agentConfig.extension === '/SKILL.md') {
            aliasOutput = this.renderSkillCommand(agentName, aliasOutputName, frontmatter, body, sourceId, cmdFile, projectRoot, {
              extensionId,
              author,
            });
          }
        }
        const aliasFile = join(commandsDir, `${aliasOutputName}${agentConfig.extension}`);
        CommandRegistrar.ensureInside(aliasFile, commandsDir);
        mkdirSync(dirname(aliasFile), { recursive: true });
        CommandRegistrar.writeRegisteredOutput(
          aliasFile,
          aliasOutput,
          sourceDir,
          agentName,
          aliasOutputName,
          agentConfig.extension,
          linkOutputs,
          agentConfig,
        );
        if (agentName === 'copilot') CommandRegistrar.writeCopilotPrompt(projectRoot, alias);
        registered.push(alias);
      }
    }
    return registered;
  }

  /** Write a rendered agent artifact, optionally as a dev-mode symlink. */
  static writeRegisteredOutput(
    destFile: string,
    content: string,
    sourceDir: string,
    agentName: string,
    outputName: string,
    extension: string,
    linkOutputs: boolean,
    agentConfig: RegistrarConfig | null = null,
  ): void {
    if (!linkOutputs || (agentConfig ?? ({} as RegistrarConfig)).dev_no_symlink) {
      if (isSymlink(destFile)) unlinkSync(destFile);
      writeFileSync(destFile, content, 'utf-8');
      return;
    }
    const cacheRoot = join(sourceDir, '.specify-dev', 'agent-commands', agentName);
    const cacheFile = join(cacheRoot, `${outputName}${extension}`);
    CommandRegistrar.ensureInside(cacheFile, cacheRoot);
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, content, 'utf-8');
      if (existsSync(destFile) || isSymlink(destFile)) unlinkSync(destFile);
      const target = relative(dirname(destFile), cacheFile);
      symlinkSync(target, destFile);
    } catch (exc) {
      if (!(isOSError(exc) || isValueError(exc))) throw exc;
      if (isSymlink(destFile)) unlinkSync(destFile);
      writeFileSync(destFile, content, 'utf-8');
    }
  }

  /** Generate a companion ``.github/prompts/<cmd>.prompt.md`` for Copilot. */
  static writeCopilotPrompt(projectRoot: string, cmdName: string): void {
    const reason = relativeExtensionPathViolation(cmdName);
    if (reason) throw new ValueError(`Invalid Copilot prompt name ${pyRepr(cmdName)}: ${reason}`);
    const promptsDir = join(projectRoot, '.github', 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    const promptFile = join(promptsDir, `${cmdName}.prompt.md`);
    CommandRegistrar.ensureInside(promptFile, promptsDir);
    mkdirSync(dirname(promptFile), { recursive: true });
    writeFileSync(promptFile, `---\nagent: ${cmdName}\n---\n`, 'utf-8');
  }

  /**
   * Return the agent command directory (``~``-relative, absolute or
   * project-relative), falling back to ``legacy_dir`` with a deprecation
   * warning when only the legacy directory exists.
   */
  static resolveAgentDir(agentName: string, agentConfig: RegistrarConfig, projectRoot: string): string {
    const dirStr = agentConfig.dir;
    let agentDir: string;
    if (dirStr.startsWith('~')) {
      agentDir = join(homeDir(), dirStr.slice(1).replace(/^\/+/, ''));
    } else {
      agentDir = isAbsolute(dirStr) ? dirStr : join(projectRoot, dirStr);
    }
    if (!existsSync(agentDir)) {
      const legacy = agentConfig.legacy_dir;
      if (legacy) {
        const legacyDir = join(projectRoot, legacy);
        if (existsSync(legacyDir)) {
          warn(
            `Found legacy '${legacy}' directory for ${agentName}. Run 'specify integration upgrade ${agentName}' to migrate to '${agentConfig.dir}'.`,
          );
          return legacyDir;
        }
      }
    }
    return agentDir;
  }

  /** Register commands for all detected agents in the project. */
  registerCommandsForAllAgents(
    commands: CommandInfo[],
    sourceId: string,
    sourceDir: string,
    projectRoot: string,
    opts: RegisterForAllAgentsOptions = {},
  ): RegisteredCommandsMap {
    const results: RegisteredCommandsMap = {};
    CommandRegistrar.ensureConfigs();
    const onlyAgent = opts.onlyAgent ?? null;
    const activeSkillsAgent = opts.createMissingActiveSkillsDir ? CommandRegistrar.activeSkillsAgent(projectRoot) : null;
    let activeSkillsDir: string | null = null;
    if (activeSkillsAgent) {
      const cfg = this.AGENT_CONFIGS[activeSkillsAgent];
      if (cfg && cfg.extension === '/SKILL.md') {
        activeSkillsDir = CommandRegistrar.resolveAgentDir(activeSkillsAgent, cfg, projectRoot);
      }
    }
    let activeCreatedSkillsDir: string | null = null;

    for (const [agentName, agentConfig] of Object.entries(this.AGENT_CONFIGS)) {
      if (onlyAgent !== null && agentName !== onlyAgent) continue;
      const activeSkillsOutput = agentName === activeSkillsAgent && agentConfig.extension === '/SKILL.md';
      let recovered: string | null = null;
      const detectDirStr = agentConfig.detect_dir;
      if (detectDirStr) {
        const detectPath = join(projectRoot, detectDirStr);
        if (!isDir(detectPath)) {
          if (!activeSkillsOutput) continue;
          try {
            recovered = resolveActiveSkillsDir(projectRoot);
          } catch (exc) {
            if (isValueError(exc) || isOSError(exc)) continue;
            throw exc;
          }
          if (recovered === null || !isDir(detectPath)) continue;
          activeCreatedSkillsDir = recovered;
        }
      }
      const agentDir = CommandRegistrar.resolveAgentDir(agentName, agentConfig, projectRoot);
      const sharesActive =
        activeSkillsDir !== null &&
        agentName !== activeSkillsAgent &&
        agentConfig.extension === '/SKILL.md' &&
        CommandRegistrar.sameLexicalPath(agentDir, activeSkillsDir);
      if (sharesActive) continue;

      const agentDirExisted = isDir(agentDir);
      const registerMissingActive = !agentDirExisted && activeSkillsOutput;
      if (registerMissingActive) {
        if (recovered === null) {
          try {
            recovered = resolveActiveSkillsDir(projectRoot);
          } catch (exc) {
            if (isValueError(exc) || isOSError(exc)) continue;
            throw exc;
          }
          if (recovered === null) continue;
        }
        activeCreatedSkillsDir = recovered;
      }
      const createdByActive =
        activeCreatedSkillsDir !== null &&
        CommandRegistrar.sameLexicalPath(agentDir, activeCreatedSkillsDir) &&
        agentName !== activeSkillsAgent;
      const shouldRegister = (agentDirExisted && !createdByActive) || registerMissingActive;

      if (shouldRegister) {
        try {
          const registered = this.registerCommands(agentName, commands, sourceId, sourceDir, projectRoot, {
            contextNote: opts.contextNote ?? null,
            resolvedDir: agentDir,
            linkOutputs: opts.linkOutputs ?? false,
            extensionId: opts.extensionId ?? null,
            author: opts.author === undefined ? 'github-spec-kit' : opts.author,
          });
          if (registered.length > 0) results[agentName] = registered;
          if (registerMissingActive) activeCreatedSkillsDir = recovered ?? agentDir;
        } catch (exc) {
          if (isValueError(exc)) continue;
          if (isOSError(exc)) {
            if (registerMissingActive) continue;
          }
          throw exc;
        }
      }
    }
    return results;
  }

  /** Register commands for all non-skill agents in the project. */
  registerCommandsForNonSkillAgents(
    commands: CommandInfo[],
    sourceId: string,
    sourceDir: string,
    projectRoot: string,
    opts: RegisterForNonSkillAgentsOptions = {},
  ): RegisteredCommandsMap {
    const results: RegisteredCommandsMap = {};
    CommandRegistrar.ensureConfigs();
    const onlyAgent = opts.onlyAgent ?? null;
    const extra = new Set(opts.extraAgents ? [...opts.extraAgents] : []);
    for (const [agentName, agentConfig] of Object.entries(this.AGENT_CONFIGS)) {
      if (onlyAgent !== null && agentName !== onlyAgent && !extra.has(agentName)) continue;
      if (agentConfig.extension === '/SKILL.md') continue;
      const detectDirStr = agentConfig.detect_dir;
      if (detectDirStr && !isDir(join(projectRoot, detectDirStr))) continue;
      const agentDir = CommandRegistrar.resolveAgentDir(agentName, agentConfig, projectRoot);
      if (isDir(agentDir)) {
        try {
          const registered = this.registerCommands(agentName, commands, sourceId, sourceDir, projectRoot, {
            contextNote: opts.contextNote ?? null,
            resolvedDir: agentDir,
            linkOutputs: opts.linkOutputs ?? false,
            extensionId: opts.extensionId ?? null,
          });
          if (registered.length > 0) results[agentName] = registered;
        } catch (exc) {
          if (isValueError(exc)) continue;
          throw exc;
        }
      }
    }
    return results;
  }

  /**
   * Remove previously registered command files from agent directories
   * (canonical and legacy dirs; empty SKILL.md parent dirs removed).
   */
  unregisterCommands(registeredCommands: RegisteredCommandsMap, projectRoot: string): void {
    CommandRegistrar.ensureConfigs();
    for (const [agentName, cmdNames] of Object.entries(registeredCommands)) {
      if (!(agentName in this.AGENT_CONFIGS)) continue;
      const agentConfig = this.AGENT_CONFIGS[agentName];
      const commandsDir = CommandRegistrar.resolveAgentDir(agentName, agentConfig, projectRoot);
      const dirsToClean = [commandsDir];
      const legacy = agentConfig.legacy_dir;
      if (legacy) {
        const legacyDir = join(projectRoot, legacy);
        if (existsSync(legacyDir) && legacyDir !== commandsDir) dirsToClean.push(legacyDir);
      }
      for (const cmdName of cmdNames) {
        const outputName = CommandRegistrar.computeOutputName(agentName, cmdName, agentConfig);
        const names = [outputName];
        if (outputName !== cmdName && CommandRegistrar.isSafeCommandName(cmdName)) names.push(cmdName);
        for (const targetDir of dirsToClean) {
          for (const name of names) {
            const cmdFile = join(targetDir, `${name}${agentConfig.extension}`);
            try {
              CommandRegistrar.ensureInside(cmdFile, targetDir);
            } catch {
              continue;
            }
            if (existsSync(cmdFile) || isSymlink(cmdFile)) {
              unlinkSync(cmdFile);
              const parent = dirname(cmdFile);
              if (parent !== targetDir && existsSync(parent)) {
                try {
                  rmdirSync(parent);
                } catch {
                  // not empty
                }
              }
            }
          }
        }
        if (agentName === 'copilot') {
          const promptFile = join(projectRoot, '.github', 'prompts', `${cmdName}.prompt.md`);
          if (existsSync(promptFile)) unlinkSync(promptFile);
        }
      }
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Python ``os.path.normpath`` (POSIX semantics, keeps a leading ``//``). */
export function pyNormpath(p: string): string {
  if (p === '') return '.';
  if (process.platform === 'win32') return normalize(p);
  const initialSlashes = p.startsWith('/') ? (p.startsWith('//') && !p.startsWith('///') ? 2 : 1) : 0;
  const comps = p.split('/');
  const out: string[] = [];
  for (const comp of comps) {
    if (comp === '' || comp === '.') continue;
    if (comp !== '..' || (!initialSlashes && out.length === 0) || (out.length > 0 && out[out.length - 1] === '..')) {
      out.push(comp);
    } else if (out.length > 0) {
      out.pop();
    }
  }
  const joined = '/'.repeat(initialSlashes) + out.join('/');
  return joined || '.';
}

/** Is *p* a symlink (re-exported convenience). */
export function isSymlinkPath(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
