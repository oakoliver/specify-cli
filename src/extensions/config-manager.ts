/**
 * @oakoliver/specify-cli - Extension layered configuration
 *
 * Port of ``ConfigManager`` from ``specify_cli/extensions/__init__.py``.
 *
 * Configuration layers (lowest to highest precedence):
 * 1. Defaults (from extension.yml)
 * 2. Project config (.specify/extensions/{ext-id}/{ext-id}-config.yml)
 * 3. Local config (.specify/extensions/{ext-id}/local-config.yml) - gitignored
 * 4. Environment variables (SPECKIT_{EXT_ID}_{KEY})
 *
 * @module extensions/config-manager
 */

import { join } from 'node:path';

import { parseYaml } from '../yaml.js';
import { exists, readTextUtf8 } from './compat.js';
import { type Dict, isMapping } from './manifest.js';
import { ExtensionRegistry } from './registry.js';

/** Manages layered configuration for extensions. */
export class ConfigManager {
  readonly projectRoot: string;
  readonly extensionId: string;
  readonly extensionDir: string;

  constructor(projectRoot: string, extensionId: string) {
    this.projectRoot = projectRoot;
    this.extensionId = extensionId;
    this.extensionDir = join(projectRoot, '.specify', 'extensions', extensionId);
  }

  /** Load configuration from YAML file (non-mapping roots coerce to ``{}``). */
  loadYamlConfig(filePath: string): Dict {
    if (!exists(filePath)) return {};
    try {
      const data = parseYaml(readTextUtf8(filePath));
      return isMapping(data) ? data : {};
    } catch {
      return {};
    }
  }

  /** Default configuration from the extension manifest's ``config.defaults``. */
  getExtensionDefaults(): Dict {
    const manifestPath = join(this.extensionDir, 'extension.yml');
    if (!exists(manifestPath)) return {};
    const manifestData = this.loadYamlConfig(manifestPath);
    const configSection = Object.prototype.hasOwnProperty.call(manifestData, 'config')
      ? manifestData.config
      : {};
    if (!isMapping(configSection)) return {};
    const defaults = Object.prototype.hasOwnProperty.call(configSection, 'defaults')
      ? configSection.defaults
      : {};
    return isMapping(defaults) ? defaults : {};
  }

  /** Project-level configuration. */
  getProjectConfig(): Dict {
    return this.loadYamlConfig(join(this.extensionDir, `${this.extensionId}-config.yml`));
  }

  /** Local configuration (gitignored, machine-specific). */
  getLocalConfig(): Dict {
    return this.loadYamlConfig(join(this.extensionDir, 'local-config.yml'));
  }

  /** IDs of other extensions installed alongside this one (from the registry). */
  siblingExtensionIds(): string[] {
    const extensionsDir = join(this.projectRoot, '.specify', 'extensions');
    try {
      return [...new ExtensionRegistry(extensionsDir).keys()];
    } catch {
      return [];
    }
  }

  /** Configuration from ``SPECKIT_{EXT_ID}_{SECTION}_{KEY}`` environment variables. */
  getEnvConfig(): Dict {
    const envConfig: Dict = {};
    const extIdUpper = this.extensionId.replace(/-/g, '_').toUpperCase();
    const prefix = `SPECKIT_${extIdUpper}_`;

    const siblingPrefixes: string[] = [];
    for (const siblingId of this.siblingExtensionIds()) {
      if (siblingId === this.extensionId) continue;
      const sibUpper = siblingId.replace(/-/g, '_').toUpperCase();
      if (sibUpper.startsWith(extIdUpper + '_')) {
        siblingPrefixes.push(sibUpper.slice(extIdUpper.length + 1) + '_');
      }
    }

    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (!key.startsWith(prefix)) continue;
      const remainder = key.slice(prefix.length);
      if (siblingPrefixes.some((sp) => remainder.startsWith(sp))) continue;

      const configPath = remainder
        .toLowerCase()
        .split('_')
        .filter((p) => p);
      if (!configPath.length) continue;

      let current: Dict = envConfig;
      for (const part of configPath.slice(0, -1)) {
        if (!isMapping(current[part])) current[part] = {};
        current = current[part];
      }
      const leaf = configPath[configPath.length - 1];
      if (!isMapping(current[leaf])) current[leaf] = value;
    }
    return envConfig;
  }

  /** Recursively merge two configuration dictionaries. */
  mergeConfigs(base: Dict, override: Dict): Dict {
    const result: Dict = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (Object.prototype.hasOwnProperty.call(result, key) && isMapping(result[key]) && isMapping(value)) {
        result[key] = this.mergeConfigs(result[key], value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /** Final merged configuration: defaults -> project -> local -> env. */
  getConfig(): Dict {
    let config = this.getExtensionDefaults();
    config = this.mergeConfigs(config, this.getProjectConfig());
    config = this.mergeConfigs(config, this.getLocalConfig());
    config = this.mergeConfigs(config, this.getEnvConfig());
    return config;
  }

  /** Get a specific configuration value by dot-notation path. */
  getValue(keyPath: string, defaultValue: unknown = null): unknown {
    let current: unknown = this.getConfig();
    for (const key of keyPath.split('.')) {
      if (!isMapping(current) || !Object.prototype.hasOwnProperty.call(current, key)) return defaultValue;
      current = current[key];
    }
    return current;
  }

  /** Check if a configuration value exists (even if null). */
  hasValue(keyPath: string): boolean {
    let current: unknown = this.getConfig();
    for (const key of keyPath.split('.')) {
      if (!isMapping(current) || !Object.prototype.hasOwnProperty.call(current, key)) return false;
      current = current[key];
    }
    return true;
  }
}
