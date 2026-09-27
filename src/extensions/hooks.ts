/**
 * @oakoliver/specify-cli - Extension hook executor
 *
 * Port of ``HookExecutor`` from ``specify_cli/extensions/__init__.py``.
 * Hooks are persisted in ``.specify/extensions.yml``; the executor renders
 * agent-specific invocations and evaluates hook conditions. Actual execution
 * is delegated to the AI agent.
 *
 * @module extensions/hooks
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { dumpYaml, parseYaml } from '../yaml.js';
import { loadInitOptions, isAiSkillsEnabled } from '../init-options.js';
import { isDollarSkillsAgent, isSlashSkillsAgent } from '../invocation-style.js';
import { formatClineCommandName } from '../integrations/cline.js';
import { formatForgeCommandName } from '../integrations/forge.js';
import { formatJunieCommandName } from '../integrations/junie.js';
import { pyStr, pyTruthy } from '../bundles/pycompat.js';
import { exists, pyEquals, readTextUtf8 } from './compat.js';
import { ConfigManager } from './config-manager.js';
import {
  DEFAULT_HOOK_PRIORITY,
  type Dict,
  type ExtensionManifest,
  coerceHookEntries,
  isMapping,
  normalizePriority,
} from './manifest.js';

/** Result of {@link HookExecutor.checkHooksForEvent}. */
export interface HookCheckResult {
  has_hooks: boolean;
  hooks: Dict[];
  message: string;
}

/** Result of {@link HookExecutor.executeHook}. */
export interface HookExecutionInfo {
  command: unknown;
  invocation: string;
  extension: unknown;
  optional: unknown;
  description: unknown;
  prompt: unknown;
}

const VALID_ID = /^[a-z0-9-]+$/;

function get(obj: Dict, key: string, fallback: unknown = null): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

function defaultConfig(): Dict {
  return { installed: [], settings: { auto_execute_hooks: true }, hooks: {} };
}

/** Manages extension hook execution. */
export class HookExecutor {
  readonly projectRoot: string;
  readonly extensionsDir: string;
  readonly configFile: string;
  private initOptionsCache: Dict | null = null;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.extensionsDir = join(projectRoot, '.specify', 'extensions');
    this.configFile = join(projectRoot, '.specify', 'extensions.yml');
  }

  /** Load (and cache) persisted init options used to determine invocation style. */
  loadInitOptions(): Dict {
    if (this.initOptionsCache === null) {
      const payload = loadInitOptions(this.projectRoot);
      this.initOptionsCache = isMapping(payload) ? payload : {};
    }
    return this.initOptionsCache;
  }

  /** Map a command id like ``speckit.plan`` to ``speckit-plan`` skill name. */
  static skillNameFromCommand(command: unknown): string {
    if (typeof command !== 'string') return '';
    const commandId = command.trim();
    if (!commandId.startsWith('speckit.')) return '';
    return `speckit-${commandId.slice('speckit.'.length).replace(/\./g, '-')}`;
  }

  /** Render an agent-specific invocation string for a hook command. */
  renderHookInvocation(command: unknown): string {
    if (typeof command !== 'string') return '';
    const commandId = command.trim();
    if (!commandId) return '';

    const initOptions = this.loadInitOptions();
    const rawAi = initOptions.ai;
    const selectedAi = typeof rawAi === 'string' ? rawAi : null;
    const aiSkillsEnabled = isAiSkillsEnabled(initOptions);

    const dollarSkillMode = isDollarSkillsAgent(selectedAi, aiSkillsEnabled);
    const kimiSkillMode = selectedAi === 'kimi';
    const clineMode = selectedAi === 'cline';
    const forgeMode = selectedAi === 'forge';
    const junieMode = selectedAi === 'junie';

    const skillName = HookExecutor.skillNameFromCommand(commandId);
    if (dollarSkillMode && skillName) return `$${skillName}`;
    if (kimiSkillMode && skillName) return `/skill:${skillName}`;
    if (clineMode) return `/${formatClineCommandName(commandId)}`;
    if (forgeMode) return `/${formatForgeCommandName(commandId)}`;
    if (junieMode) return `/${formatJunieCommandName(commandId)}`;

    const useSlash = isSlashSkillsAgent(selectedAi, aiSkillsEnabled);
    if (skillName && useSlash) return `/${skillName}`;
    return `/${commandId}`;
  }

  /** Load project-level extension configuration (always normalized). */
  getProjectConfig(): Dict {
    if (!exists(this.configFile)) return defaultConfig();
    let result: unknown;
    try {
      result = parseYaml(readTextUtf8(this.configFile));
    } catch {
      return defaultConfig();
    }
    if (!isMapping(result)) return defaultConfig();
    if (!isMapping(result.hooks)) result.hooks = {};
    if (!Array.isArray(result.installed)) result.installed = [];
    if (!isMapping(result.settings)) result.settings = { auto_execute_hooks: true };
    for (const eventKey of Object.keys(result.hooks)) {
      const eventVal = result.hooks[eventKey];
      if (!Array.isArray(eventVal)) {
        result.hooks[eventKey] = [];
      } else {
        result.hooks[eventKey] = eventVal.filter((h) => isMapping(h));
      }
    }
    return result;
  }

  /** Save project-level extension configuration. */
  saveProjectConfig(config: Dict): void {
    mkdirSync(dirname(this.configFile), { recursive: true });
    writeFileSync(
      this.configFile,
      dumpYaml(config, { defaultFlowStyle: false, sortKeys: false, allowUnicode: true }),
      'utf-8',
    );
  }

  /** Add extension to the installed list in project config. */
  registerExtension(extensionId: string): void {
    let config: Dict = this.getProjectConfig();
    if (!isMapping(config)) config = {};
    const rawInstalled = get(config, 'installed');
    const sanitized = HookExecutor.sanitizeInstalledList(rawInstalled, { addId: extensionId });
    if (!pyEquals(sanitized, rawInstalled)) {
      config.installed = sanitized;
      this.saveProjectConfig(config);
    }
  }

  /** Remove extension from the installed list in project config. */
  unregisterExtension(extensionId: string): void {
    let config: Dict = this.getProjectConfig();
    if (!isMapping(config)) config = {};
    const rawInstalled = get(config, 'installed');
    const sanitized = HookExecutor.sanitizeInstalledList(rawInstalled, { removeId: extensionId });
    if (!pyEquals(sanitized, rawInstalled)) {
      config.installed = sanitized;
      this.saveProjectConfig(config);
    }
  }

  /** Normalize, deduplicate, and optionally add/remove an extension id. */
  static sanitizeInstalledList(
    raw: unknown,
    opts: { addId?: string; removeId?: string } = {},
  ): unknown[] {
    const addId = opts.addId ?? '';
    const removeId = opts.removeId ?? '';
    const installed = Array.isArray(raw) ? raw : [];

    const validEntry = (x: unknown): boolean => {
      if (typeof x === 'string') return VALID_ID.test(x.trim());
      if (isMapping(x)) {
        const eid = x.id;
        return typeof eid === 'string' && VALID_ID.test(eid.trim());
      }
      return false;
    };

    const seen = new Map<string, unknown>();
    for (const x of installed.filter(validEntry)) {
      const eid = typeof x === 'string' ? x.trim() : String((x as Dict).id ?? '').trim();
      if (!seen.has(eid) || isMapping(x)) seen.set(eid, x);
    }
    if (addId && VALID_ID.test(addId.trim()) && !seen.has(addId)) seen.set(addId, addId);
    if (removeId) seen.delete(removeId);

    const sortKey = (x: unknown): string => (typeof x === 'string' ? x : String((x as Dict).id ?? ''));
    return [...seen.values()].sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  /** Register extension hooks in project config. */
  registerHooks(manifest: ExtensionManifest): void {
    this.registerExtension(manifest.id);

    let config: Dict = this.getProjectConfig();
    let changed = false;
    if (!isMapping(config)) {
      config = {};
      changed = true;
    }

    if (!Object.prototype.hasOwnProperty.call(config, 'hooks') || !isMapping(config.hooks)) {
      config.hooks = {};
      changed = true;
    } else {
      for (const hName of Object.keys(config.hooks)) {
        const hList = config.hooks[hName];
        if (!Array.isArray(hList)) {
          config.hooks[hName] = [];
          changed = true;
        } else {
          const sanitized = hList.filter((h) => isMapping(h));
          if (sanitized.length !== hList.length) {
            config.hooks[hName] = sanitized;
            changed = true;
          }
        }
      }
    }

    const manifestHooks = isMapping(manifest.hooks) ? manifest.hooks : {};
    const declaredEvents = new Set(Object.keys(manifestHooks));
    for (const hName of Object.keys(config.hooks)) {
      if (declaredEvents.has(hName)) continue;
      const current: unknown[] = config.hooks[hName];
      const kept = current.filter((h) => !(isMapping(h) && h.extension === manifest.id));
      if (!pyEquals(kept, current)) {
        config.hooks[hName] = kept;
        changed = true;
      }
    }

    for (const [hookName, hookConfig] of Object.entries(manifestHooks)) {
      if (!Object.prototype.hasOwnProperty.call(config.hooks, hookName) || !Array.isArray(config.hooks[hookName])) {
        config.hooks[hookName] = [];
        changed = true;
      }

      const newEntries = new Map<string, Dict>();
      for (const entry of coerceHookEntries(hookConfig)) {
        if (!isMapping(entry)) continue;
        const command = entry.command;
        if (!pyTruthy(command)) continue;
        const key = String(command);
        if (newEntries.has(key)) newEntries.delete(key);
        newEntries.set(key, {
          extension: manifest.id,
          command,
          enabled: true,
          optional: get(entry, 'optional', true),
          priority: normalizePriority(get(entry, 'priority'), DEFAULT_HOOK_PRIORITY),
          prompt: get(entry, 'prompt', `Execute ${pyStr(command)}?`),
          description: get(entry, 'description', ''),
          condition: get(entry, 'condition'),
        });
      }

      const originalList: unknown[] = config.hooks[hookName];
      const deduped = originalList.filter((h) => !(isMapping(h) && h.extension === manifest.id));
      deduped.push(...newEntries.values());
      if (!pyEquals(deduped, originalList)) {
        config.hooks[hookName] = deduped;
        changed = true;
      }
    }

    const nonEmpty: Dict = {};
    for (const [name, hooks] of Object.entries(config.hooks as Dict)) {
      if (pyTruthy(hooks)) nonEmpty[name] = hooks;
    }
    if (!pyEquals(nonEmpty, config.hooks)) {
      config.hooks = nonEmpty;
      changed = true;
    }

    if (changed) this.saveProjectConfig(config);
  }

  /** Remove extension hooks from project config. */
  unregisterHooks(extensionId: string): void {
    this.unregisterExtension(extensionId);

    const config: Dict = this.getProjectConfig();
    if (!isMapping(config)) return;
    if (!Object.prototype.hasOwnProperty.call(config, 'hooks') || !isMapping(config.hooks)) return;

    for (const hookName of Object.keys(config.hooks)) {
      const hookList = config.hooks[hookName];
      if (!Array.isArray(hookList)) {
        config.hooks[hookName] = [];
        continue;
      }
      config.hooks[hookName] = hookList.filter((h) => isMapping(h) && h.extension !== extensionId);
    }
    const cleaned: Dict = {};
    for (const [name, hooks] of Object.entries(config.hooks as Dict)) {
      if (pyTruthy(hooks)) cleaned[name] = hooks;
    }
    config.hooks = cleaned;
    this.saveProjectConfig(config);
  }

  /** All enabled hooks for an event, sorted by priority ascending (stable). */
  getHooksForEvent(eventName: string): Dict[] {
    const config = this.getProjectConfig();
    const hooksMap = isMapping(config.hooks) ? config.hooks : {};
    const hooks: Dict[] = Object.prototype.hasOwnProperty.call(hooksMap, eventName) ? hooksMap[eventName] : [];
    const enabled = hooks.filter((h) => pyTruthy(get(h, 'enabled', true)));
    return enabled
      .map((h, i) => ({ h, i, p: normalizePriority(get(h, 'priority'), DEFAULT_HOOK_PRIORITY) }))
      .sort((a, b) => a.p - b.p || a.i - b.i)
      .map((x) => x.h);
  }

  /** Determine if a hook should be executed based on its condition. */
  shouldExecuteHook(hook: Dict): boolean {
    const condition = get(hook, 'condition');
    if (!pyTruthy(condition)) return true;
    try {
      const ext = get(hook, 'extension');
      return this.evaluateCondition(condition as string, typeof ext === 'string' ? ext : null);
    } catch {
      return false;
    }
  }

  /**
   * Evaluate a hook condition expression.
   *
   * Supported: ``config.key.path is set``, ``config.key.path == 'value'``,
   * ``config.key.path != 'value'``, ``env.VAR_NAME is set``,
   * ``env.VAR_NAME == 'value'`` / ``!=``.
   */
  evaluateCondition(conditionInput: string, extensionId: string | null): boolean {
    const condition = conditionInput.trim();

    let match = /^config\.([a-z0-9_.]+)\s+is\s+set/i.exec(condition);
    if (match) {
      if (!extensionId) return false;
      return new ConfigManager(this.projectRoot, extensionId).hasValue(match[1]);
    }

    match = /^config\.([a-z0-9_.]+)\s*(==|!=)\s*["']([^"']+)["']/i.exec(condition);
    if (match) {
      const [, keyPath, operator, expectedValue] = match;
      if (!extensionId) return false;
      const actualValue = new ConfigManager(this.projectRoot, extensionId).getValue(keyPath);
      const normalizedValue =
        typeof actualValue === 'boolean' ? (actualValue ? 'true' : 'false') : pyStr(actualValue);
      return operator === '==' ? normalizedValue === expectedValue : normalizedValue !== expectedValue;
    }

    match = /^env\.([A-Z0-9_]+)\s+is\s+set/i.exec(condition);
    if (match) {
      return Object.prototype.hasOwnProperty.call(process.env, match[1].toUpperCase());
    }

    match = /^env\.([A-Z0-9_]+)\s*(==|!=)\s*["']([^"']+)["']/i.exec(condition);
    if (match) {
      const varName = match[1].toUpperCase();
      const operator = match[2];
      const expectedValue = match[3];
      const actualValue = process.env[varName] ?? '';
      return operator === '==' ? actualValue === expectedValue : actualValue !== expectedValue;
    }

    return false;
  }

  /** Format hook execution message for display in command output. */
  formatHookMessage(eventName: string, hooks: Dict[]): string {
    if (!hooks.length) return '';
    const lines: string[] = ['\n## Extension Hooks\n'];
    lines.push(`Hooks available for event '${eventName}':\n`);

    for (const hook of hooks) {
      const extension = pyStr(get(hook, 'extension'));
      const command = get(hook, 'command');
      const invocation = this.renderHookInvocation(command);
      const commandText = typeof command === 'string' && command.trim() ? command : '<missing command>';
      const displayInvocation =
        invocation || (commandText !== '<missing command>' ? `/${commandText}` : '/<missing command>');
      const optional = get(hook, 'optional', true);
      const prompt = pyStr(get(hook, 'prompt', ''));
      const description = get(hook, 'description', '');

      if (pyTruthy(optional)) {
        lines.push(`\n**Optional Hook**: ${extension}`);
        lines.push(`Command: \`${displayInvocation}\``);
        if (pyTruthy(description)) lines.push(`Description: ${pyStr(description)}`);
        lines.push(`\nPrompt: ${prompt}`);
        lines.push(`To execute: \`${displayInvocation}\``);
      } else {
        lines.push(`\n**Automatic Hook**: ${extension}`);
        lines.push(`Executing: \`${displayInvocation}\``);
        lines.push(`EXECUTE_COMMAND: ${commandText}`);
        lines.push(`EXECUTE_COMMAND_INVOCATION: ${displayInvocation}`);
      }
    }
    return lines.join('\n');
  }

  /** Check for hooks registered for a specific event (called by agents). */
  checkHooksForEvent(eventName: string): HookCheckResult {
    const hooks = this.getHooksForEvent(eventName);
    if (!hooks.length) return { has_hooks: false, hooks: [], message: '' };

    const executableHooks = hooks.filter((hook) => this.shouldExecuteHook(hook));
    if (!executableHooks.length) {
      return {
        has_hooks: false,
        hooks: [],
        message: `# No executable hooks for event '${eventName}' (conditions not met)`,
      };
    }
    return {
      has_hooks: true,
      hooks: executableHooks,
      message: this.formatHookMessage(eventName, executableHooks),
    };
  }

  /** Describe how to execute a single hook (execution is delegated to the agent). */
  executeHook(hook: Dict): HookExecutionInfo {
    return {
      command: get(hook, 'command'),
      invocation: this.renderHookInvocation(get(hook, 'command')),
      extension: get(hook, 'extension'),
      optional: get(hook, 'optional', true),
      description: get(hook, 'description', ''),
      prompt: get(hook, 'prompt', ''),
    };
  }

  private setHooksEnabled(extensionId: string, enabled: boolean): void {
    const config = this.getProjectConfig();
    if (!Object.prototype.hasOwnProperty.call(config, 'hooks')) return;
    for (const hookName of Object.keys(config.hooks)) {
      for (const hook of config.hooks[hookName]) {
        if (get(hook, 'extension') === extensionId) hook.enabled = enabled;
      }
    }
    this.saveProjectConfig(config);
  }

  /** Enable all hooks for an extension. */
  enableHooks(extensionId: string): void {
    this.setHooksEnabled(extensionId, true);
  }

  /** Disable all hooks for an extension. */
  disableHooks(extensionId: string): void {
    this.setHooksEnabled(extensionId, false);
  }
}
