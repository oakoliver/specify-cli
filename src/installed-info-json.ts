/**
 * @oakoliver/specify-cli - Installed-info JSON helpers
 *
 * Port of upstream `_installed_info_json.py` (spec-kit v1.2.5): the JSON
 * objects printed by `preset info --json` and `extension info --json`. The
 * top-level fields are the `list --json` item for that pack (see
 * `installed-list-json.ts`); its `provides` counts are replaced by one array
 * per contribution kind, so the detail view and the summary view never drift.
 *
 * @module installed-info-json
 */

import { DEFAULT_HOOK_PRIORITY, coerceHookEntries, isMapping, normalizePriority } from './extensions/manifest.js';
import { installedListItem } from './installed-list-json.js';
import { pyTruthy } from './bundles/pycompat.js';

type Dict = Record<string, any>;

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

/**
 * Return the installed record for an ID, or (optionally) a unique display
 * name. Presets resolve by ID only; extensions also accept a
 * case-insensitive display name.
 */
function findInstalled(records: Dict[], key: string, kind: string, matchNames: boolean): Dict {
  for (const record of records) if (record.id === key) return record;
  let byName: Dict[] = [];
  if (matchNames) byName = records.filter((r) => String(r.name).toLowerCase() === key.toLowerCase());
  if (byName.length === 1) return byName[0];
  if (byName.length) {
    throw new Error(
      `${capitalize(kind)} name '${key}' is ambiguous; use one of the IDs: ` +
        byName
          .map((r) => String(r.id))
          .sort()
          .join(', '),
    );
  }
  throw new Error(`${capitalize(kind)} '${key}' is not installed`);
}

/** One command, template or script entry of an installed pack. */
function contribution(entry: Dict, source: Record<string, string>): Dict {
  const description = entry.description;
  return {
    name: entry.name,
    // ``description:`` with no value reads as None, and the preset manifest
    // does not check contribution descriptions
    description: typeof description === 'string' ? description : '',
    source: { ...source },
    sourcePath: entry.file,
  };
}

function withoutProvides(item: Dict): Dict {
  const out: Dict = { ...item };
  delete out.provides;
  return out;
}

/** The JSON object for one installed preset. */
export function presetInfoItem(records: Dict[], manager: { getPack(id: string): any }, key: string): Dict {
  const record = findInstalled(records, key, 'preset', false);
  const manifest = manager.getPack(record.id);
  if (manifest === null || manifest === undefined) throw new Error(`Preset '${record.id}' has an unreadable manifest`);

  const item = withoutProvides(installedListItem(record, { includeHooks: false }));
  const groups: Record<string, Dict[]> = { commands: [], templates: [], scripts: [] };
  const provenance = { layer: 'preset', presetId: record.id };
  for (const template of manifest.templates as Dict[]) {
    const entry = contribution(template, provenance);
    entry.strategy = Object.prototype.hasOwnProperty.call(template, 'strategy') ? template.strategy : 'replace';
    groups[`${template.type}s`].push(entry);
  }
  return { ...item, ...groups };
}

/** The JSON object for one installed extension. */
export function extensionInfoItem(records: Dict[], manager: { getExtension(id: string): any }, key: string): Dict {
  const record = findInstalled(records, key, 'extension', true);
  const manifest = manager.getExtension(record.id);
  if (manifest === null || manifest === undefined) {
    throw new Error(`Extension '${record.id}' has an unreadable manifest`);
  }

  const item = withoutProvides(installedListItem(record, { includeHooks: true }));
  const provenance = { layer: 'extension', extensionId: record.id };
  const scripts: Dict[] = [];
  for (const script of manifest.scripts as Dict[]) {
    const entry = contribution(script, provenance);
    if (Object.prototype.hasOwnProperty.call(script, 'runtimes')) entry.runtimes = [...script.runtimes];
    scripts.push(entry);
  }

  // Read hooks the way hook registration does: per event, a later
  // declaration for the same command replaces the earlier one, and the
  // priority/optional defaults are the ones the hook executor applies.
  const hooks: Dict[] = [];
  for (const [eventName, hookConfig] of Object.entries(manifest.hooks as Dict)) {
    const byCommand = new Map<unknown, Dict>();
    for (const entry of coerceHookEntries(hookConfig)) {
      if (isMapping(entry) && pyTruthy(entry.command)) {
        byCommand.delete(entry.command);
        byCommand.set(entry.command, entry);
      }
    }
    for (const [command, entry] of byCommand) {
      hooks.push({
        trigger: eventName,
        targetCommand: command,
        optional: pyTruthy(Object.prototype.hasOwnProperty.call(entry, 'optional') ? entry.optional : true),
        priority: normalizePriority(entry.priority, DEFAULT_HOOK_PRIORITY),
      });
    }
  }

  return {
    ...item,
    commands: (manifest.commands as Dict[]).map((c) => contribution(c, provenance)),
    templates: (manifest.templates as Dict[]).map((t) => contribution(t, provenance)),
    scripts,
    hooks,
  };
}
