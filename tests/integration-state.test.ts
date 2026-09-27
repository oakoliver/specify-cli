/**
 * Tests for integration state / runtime helpers
 * (ports of tests/integrations/test_integration_state.py).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  INTEGRATION_JSON,
  INTEGRATION_STATE_SCHEMA,
  cleanIntegrationKey,
  dedupeIntegrationKeys,
  defaultIntegrationKey,
  installedIntegrationKeys,
  integrationSetting,
  normalizeIntegrationSettings,
  normalizeIntegrationState,
  tryReadIntegrationJson,
  tryReadIntegrationJsonWithRaw,
  writeIntegrationJson,
} from '../src/integration-state.js';
import {
  invokeSeparatorForIntegration,
  resolveIntegrationOptions,
  withIntegrationSetting,
  type RuntimeIntegration,
  type ParsedOptions,
} from '../src/integration-runtime.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'integration-state-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Copilot-like fake: '.' separator when --commands, '-' otherwise. */
const fakeCopilot: RuntimeIntegration = {
  effectiveInvokeSeparator(parsed?: ParsedOptions | null) {
    return parsed && parsed['commands'] ? '.' : '-';
  },
  isSkillsMode(parsed?: ParsedOptions | null) {
    return !(parsed && parsed['commands']);
  },
};

describe('normalizeIntegrationState', () => {
  test('strips default key without duplicates', () => {
    const state = normalizeIntegrationState({
      default_integration: ' claude ',
      integration: ' claude ',
      installed_integrations: ['claude'],
    });
    expect(state['integration']).toBe('claude');
    expect(state['default_integration']).toBe('claude');
    expect(state['installed_integrations']).toEqual(['claude']);
  });

  test('strips legacy key fallback', () => {
    const state = normalizeIntegrationState({ integration: ' codex ', installed_integrations: [] });
    expect(state['integration']).toBe('codex');
    expect(state['default_integration']).toBe('codex');
    expect(state['installed_integrations']).toEqual(['codex']);
  });

  test('preserves newer schema and unknown fields', () => {
    const state = normalizeIntegrationState({
      integration_state_schema: 99,
      integration: 'claude',
      installed_integrations: ['claude'],
      future_field: { keep: true },
    });
    expect(state['integration_state_schema']).toBe(99);
    expect(state['future_field']).toEqual({ keep: true });
  });

  test('defaults schema and picks first installed as default', () => {
    const state = normalizeIntegrationState({ installed_integrations: ['a', 'b', 'a', '', 3] });
    expect(state['integration_state_schema']).toBe(INTEGRATION_STATE_SCHEMA);
    expect(state['default_integration']).toBe('a');
    expect(state['installed_integrations']).toEqual(['a', 'b']);
  });

  test('drops keys when nothing is installed', () => {
    const state = normalizeIntegrationState({ integration: '  ', installed_integrations: 'nope' });
    expect('integration' in state).toBe(false);
    expect('default_integration' in state).toBe(false);
    expect(state['installed_integrations']).toEqual([]);
  });

  test('filters settings to installed keys', () => {
    const state = normalizeIntegrationState({
      integration: 'claude',
      integration_settings: { claude: { script: ' sh ' }, codex: { script: 'ps' } },
    });
    expect(state['integration_settings']).toEqual({ claude: { script: 'sh' } });
  });
});

describe('key helpers', () => {
  test('defaultIntegrationKey strips raw state values', () => {
    expect(defaultIntegrationKey({ default_integration: ' claude ' })).toBe('claude');
    expect(defaultIntegrationKey({ integration: ' codex ' })).toBe('codex');
    expect(defaultIntegrationKey({})).toBeNull();
  });

  test('cleanIntegrationKey / dedupe', () => {
    expect(cleanIntegrationKey(5)).toBeNull();
    expect(cleanIntegrationKey('  ')).toBeNull();
    expect(dedupeIntegrationKeys([' a', 'a', null, 'b '])).toEqual(['a', 'b']);
    expect(installedIntegrationKeys({ installed_integrations: ['x', 'x'] })).toEqual(['x']);
  });

  test('integration settings strip invoke separator', () => {
    const setting = integrationSetting({ integration_settings: { claude: { invoke_separator: ' - ' } } }, 'claude');
    expect(setting.invoke_separator).toBe('-');
  });

  test('normalizeIntegrationSettings keeps only known typed fields', () => {
    expect(
      normalizeIntegrationSettings({
        a: { script: 'sh', raw_options: '', parsed_options: { x: 1 }, junk: 1 },
        b: 'nope',
        ' ': { script: 'sh' },
        c: { parsed_options: [] },
      }),
    ).toEqual({ a: { script: 'sh', raw_options: '', parsed_options: { x: 1 } } });
  });
});

describe('writeIntegrationJson / tryReadIntegrationJson', () => {
  test('write strips integration key', () => {
    writeIntegrationJson(tmp, { version: '1.2.3', integrationKey: ' claude ', installedIntegrations: ['claude'] });
    const state = JSON.parse(readFileSync(join(tmp, INTEGRATION_JSON), 'utf-8'));
    expect(state.integration).toBe('claude');
    expect(state.default_integration).toBe('claude');
    expect(state.installed_integrations).toEqual(['claude']);
  });

  test('write output matches Python json.dumps(indent=2) layout', () => {
    writeIntegrationJson(tmp, {
      version: '1.0.0',
      integrationKey: 'claude',
      installedIntegrations: ['codex'],
      settings: { claude: { script: 'sh' }, other: { script: 'ps' } },
    });
    const text = readFileSync(join(tmp, INTEGRATION_JSON), 'utf-8');
    expect(text).toBe(
      '{\n' +
        '  "version": "1.0.0",\n' +
        '  "integration_state_schema": 1,\n' +
        '  "installed_integrations": [\n    "claude",\n    "codex"\n  ],\n' +
        '  "integration_settings": {\n    "claude": {\n      "script": "sh"\n    }\n  },\n' +
        '  "integration": "claude",\n' +
        '  "default_integration": "claude"\n' +
        '}\n',
    );
  });

  test('absent file reads as [null, null]', () => {
    expect(tryReadIntegrationJson(tmp)).toEqual([null, null]);
  });

  test('invalid JSON is a decode error', () => {
    mkdirSync(join(tmp, '.specify'), { recursive: true });
    writeFileSync(join(tmp, INTEGRATION_JSON), '{bad');
    const [state, err] = tryReadIntegrationJson(tmp);
    expect(state).toBeNull();
    expect(err?.kind).toBe('decode');
  });

  test('non-UTF8 is a decode error', () => {
    mkdirSync(join(tmp, '.specify'), { recursive: true });
    writeFileSync(join(tmp, INTEGRATION_JSON), Buffer.from([0xff, 0xfe, 0x00]));
    const [, err] = tryReadIntegrationJson(tmp);
    expect(err?.kind).toBe('decode');
  });

  test('non-object is not_object with python type name', () => {
    mkdirSync(join(tmp, '.specify'), { recursive: true });
    writeFileSync(join(tmp, INTEGRATION_JSON), '[1]');
    const [, err] = tryReadIntegrationJson(tmp);
    expect(err?.kind).toBe('not_object');
    expect(err?.detail).toBe('list');
  });

  test('directory is an os error', () => {
    mkdirSync(join(tmp, INTEGRATION_JSON), { recursive: true });
    const [, err] = tryReadIntegrationJson(tmp);
    expect(err?.kind).toBe('os');
  });

  test('newer schema is rejected', () => {
    mkdirSync(join(tmp, '.specify'), { recursive: true });
    writeFileSync(join(tmp, INTEGRATION_JSON), JSON.stringify({ integration_state_schema: 2, integration: 'x' }));
    const [, err] = tryReadIntegrationJson(tmp);
    expect(err?.kind).toBe('schema_too_new');
    expect(err?.schema).toBe(2);
  });

  test('with raw returns both shapes', () => {
    mkdirSync(join(tmp, '.specify'), { recursive: true });
    writeFileSync(join(tmp, INTEGRATION_JSON), JSON.stringify({ integration: ' claude ' }));
    const [norm, raw, err] = tryReadIntegrationJsonWithRaw(tmp);
    expect(err).toBeNull();
    expect(norm?.['installed_integrations']).toEqual(['claude']);
    expect(raw?.['integration']).toBe(' claude ');
    expect(raw && 'installed_integrations' in raw).toBe(false);
  });
});

describe('integration runtime', () => {
  test('withIntegrationSetting recomputes separator from retained options', () => {
    const settings = withIntegrationSetting({}, 'copilot', fakeCopilot, { parsedOptions: { commands: true } });
    expect(settings['copilot'].invoke_separator).toBe('.');

    const settings2 = withIntegrationSetting({ integration_settings: settings }, 'copilot', fakeCopilot, {
      scriptType: 'ps',
    });
    expect(settings2['copilot'].parsed_options).toEqual({ commands: true });
    expect(settings2['copilot'].script).toBe('ps');
    expect(settings2['copilot'].invoke_separator).toBe('.');
  });

  test('withIntegrationSetting drops parsed options when raw options change', () => {
    const state = { integration_settings: { copilot: { raw_options: '--commands', parsed_options: { commands: true } } } };
    const settings = withIntegrationSetting(state, 'copilot', fakeCopilot, { rawOptions: '' });
    expect(settings['copilot'].raw_options).toBe('');
    expect('parsed_options' in settings['copilot']).toBe(false);
    expect(settings['copilot'].invoke_separator).toBe('-');
  });

  test('resolveIntegrationOptions prefers explicit, then stored parsed, then stored raw', () => {
    const calls: string[] = [];
    const parse = (_i: unknown, raw: string): ParsedOptions | null => {
      calls.push(raw);
      return raw ? { parsed: raw } : null;
    };
    expect(resolveIntegrationOptions(null, {}, 'k', '--x', { parseOptions: parse })).toEqual(['--x', { parsed: '--x' }]);
    const stored = { integration_settings: { k: { raw_options: '--y', parsed_options: { y: true } } } };
    expect(resolveIntegrationOptions(null, stored, 'k', null, { parseOptions: parse })).toEqual(['--y', { y: true }]);
    const emptyParsed = { integration_settings: { k: { raw_options: '--y', parsed_options: {} } } };
    expect(resolveIntegrationOptions(null, emptyParsed, 'k', null, { parseOptions: parse })).toEqual(['--y', null]);
    const rawOnly = { integration_settings: { k: { raw_options: '--z' } } };
    expect(resolveIntegrationOptions(null, rawOnly, 'k', null, { parseOptions: parse })).toEqual(['--z', { parsed: '--z' }]);
    expect(resolveIntegrationOptions(null, {}, 'k', null, { parseOptions: parse })).toEqual([null, null]);
    expect(calls).toEqual(['--x', '--z']);
  });

  test('invokeSeparatorForIntegration uses stored separator', () => {
    const state = { integration_settings: { copilot: { invoke_separator: '.' } } };
    expect(invokeSeparatorForIntegration(fakeCopilot, state, 'copilot')).toBe('.');
    expect(invokeSeparatorForIntegration(fakeCopilot, {}, 'copilot')).toBe('-');
    expect(invokeSeparatorForIntegration(fakeCopilot, state, 'copilot', {})).toBe('-');
  });
});
