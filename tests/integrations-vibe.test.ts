/**
 * Mistral Vibe integration (ports of the cases added to upstream
 * tests/integrations/test_integration_vibe.py between spec-kit v1.0.12 and
 * v1.2.5: dispatch flags (#4784), --no-model-invocation (#5119), unowned
 * hooks.toml preservation (#4646) and comments after managed blocks (#5109)).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installIntegrationEvents, removeIntegrationEvents } from '../src/events/index.js';
import { getIntegration } from '../src/integrations/index.js';
import { IntegrationManifest } from '../src/integrations/manifest.js';
import { VibeIntegration } from '../src/integrations/vibe.js';
import { captureWarnings } from '../src/integrations/base.js';
import { parseToml } from '../src/toml-string.js';

let tmp: string;
const vibe = getIntegration('vibe') as VibeIntegration;
const saved = { ...process.env };

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'speckit-vibe-')));
  vibe.disableModelInvocation = false;
  for (const k of Object.keys(process.env)) if (k.startsWith('SPECKIT_')) delete process.env[k];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vibe.disableModelInvocation = false;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const hooksPath = (): string => join(tmp, '.vibe', 'hooks.toml');
const parse = (): { hooks: Array<Record<string, unknown>> } => parseToml(readFileSync(hooksPath(), 'utf8')) as never;
const noSafety = { ensureSafeDestination: (_p: string): void => {} };

function install(events: Record<string, unknown>): IntegrationManifest {
  const manifest = new IntegrationManifest('vibe', tmp);
  installIntegrationEvents(vibe, tmp, manifest, events as never);
  return manifest;
}

function writeUserFile(content: Buffer | string): [string, number] {
  mkdirSync(join(tmp, '.vibe'), { recursive: true });
  writeFileSync(hooksPath(), content);
  const fixed = new Date(1_700_000_000_123);
  utimesSync(hooksPath(), fixed, fixed);
  return [hooksPath(), statSync(hooksPath()).mtimeMs];
}

describe('dispatch (#4784)', () => {
  test('prompt mode without JSON', () => {
    expect(vibe.buildExecArgs('/speckit-specify build a login page', { outputJson: false })).toEqual([
      'vibe',
      '-p',
      '/speckit-specify build a login page',
    ]);
  });
  test('structured output is --output json', () => {
    const args = vibe.buildExecArgs('/speckit-plan add OAuth', { outputJson: true })!;
    expect(args).toEqual(['vibe', '-p', '/speckit-plan add OAuth', '--output', 'json']);
    expect(args).not.toContain('--output-format');
  });
  test('model flag is omitted', () => {
    expect(vibe.buildExecArgs('explain', { model: 'mistral-medium-latest', outputJson: false })).toEqual(['vibe', '-p', 'explain']);
  });
  test('extra args come before --output', () => {
    process.env.SPECKIT_INTEGRATION_VIBE_EXTRA_ARGS = '--auto-approve';
    expect(vibe.buildExecArgs('check the build', { outputJson: true })).toEqual([
      'vibe',
      '-p',
      'check the build',
      '--auto-approve',
      '--output',
      'json',
    ]);
  });
});

describe('--no-model-invocation (#5119)', () => {
  const fm = (rel: string): string => readFileSync(join(tmp, rel), 'utf8').split('---')[1];

  test('core skills become user-invocable only; default stays model-invocable', () => {
    const manifest = new IntegrationManifest('vibe', tmp);
    captureWarnings(() => vibe.setup(tmp, manifest, { no_model_invocation: true }, { scriptType: 'sh' }));
    expect(fm('.vibe/skills/speckit-plan/SKILL.md')).toContain('disable-model-invocation: true');
    expect(fm('.vibe/skills/speckit-plan/SKILL.md')).toContain('user-invocable: true');
    // Non-core skills (e.g. extension hooks) stay model-invocable.
    const ext = vibe.postProcessSkillContent('---\nname: speckit-git-commit\ndescription: x\n---\nbody\n');
    expect(ext).toContain('disable-model-invocation: false');

    captureWarnings(() => vibe.setup(tmp, new IntegrationManifest('vibe', tmp), null, { scriptType: 'sh' }));
    expect(fm('.vibe/skills/speckit-plan/SKILL.md')).toContain('disable-model-invocation: false');
  });

  test('the same option exists for claude (#4919)', () => {
    const claude = getIntegration('claude')!;
    expect(claude.options().map((o) => o.name)).toContain('--no-model-invocation');
    claude.setup(tmp, new IntegrationManifest('claude', tmp), { no_model_invocation: true }, { scriptType: 'sh' });
    expect(fm('.claude/skills/speckit-plan/SKILL.md')).toContain('disable-model-invocation: true');
    claude.setup(tmp, new IntegrationManifest('claude', tmp), null, { scriptType: 'sh' });
    expect(fm('.claude/skills/speckit-plan/SKILL.md')).toContain('disable-model-invocation: false');
  });
});

describe('hooks.toml merging', () => {
  test('non-BMP matcher round-trips through TOML', () => {
    install({ pre_tool_use: [{ command: 'speckit.tdd.validate', matcher: 'Edit|😀' }] });
    expect(parse().hooks[0].match).toBe('re:Edit|😀');
  });

  for (const separator of ['\u0085', ' ', ' ']) {
    test(`unicode separator ${JSON.stringify(separator)} in a matcher does not split managed spans`, () => {
      const matcher = `Edit${separator}Write`;
      install({ pre_tool_use: [{ command: 'speckit.tdd.validate', matcher }] });
      install({ pre_tool_use: [{ command: 'speckit.review.verify', matcher }] });
      const hooks = parse().hooks;
      expect(hooks.length).toBe(1);
      expect(hooks[0].name).toBe('speckit-pre_tool-verify');
      expect(hooks[0].match).toBe(`re:${matcher}`);
      expect(vibe.removeVibeEventHooks(tmp, noSafety)).toBe(true);
      expect(existsSync(hooksPath())).toBe(false);
    });
  }

  for (const [label, userAfter] of [
    ['comment before user hook', '# NOTE: keep guard-bash first\n[[hooks]]\nname = "user-hook"\ntype = "pre_tool"\ncommand = "guard-bash"\n'],
    ['trailing comment', '# notes about these hooks\n'],
  ] as const) {
    test(`refresh and teardown keep a ${label} after a managed hook (#5109)`, () => {
      mkdirSync(join(tmp, '.vibe'), { recursive: true });
      writeFileSync(hooksPath(), '[[hooks]]\nname = "deny-rm-rf"\ntype = "pre_tool"\ncommand = "guard-rm"\n');
      const events = { pre_tool_use: [{ command: 'speckit.tdd.validate' }] };
      install(events);
      writeFileSync(hooksPath(), readFileSync(hooksPath(), 'utf8') + '\n' + userAfter);
      const manifest = install(events);
      expect(readFileSync(hooksPath(), 'utf8')).toContain(userAfter);
      removeIntegrationEvents(vibe, tmp, manifest);
      const remaining = readFileSync(hooksPath(), 'utf8');
      expect(remaining).toContain(userAfter);
      expect(remaining).not.toContain('speckit_marker');
    });
  }

  for (const newline of ['\n', '\r\n']) {
    test(`merge preserves user physical line bytes (${JSON.stringify(newline)})`, () => {
      const user = `[[hooks]]${newline}name = "user-hook"${newline}type = "pre_tool"${newline}command = "guard-bash"`;
      mkdirSync(join(tmp, '.vibe'), { recursive: true });
      writeFileSync(hooksPath(), user + newline);
      install({ pre_tool_use: [{ command: 'speckit.tdd.validate' }] });
      const merged = readFileSync(hooksPath(), 'utf8');
      expect(merged.startsWith(user + '\n\n')).toBe(true);
      expect(merged).not.toContain('\r\r\n');
      expect(parse().hooks.map((h) => h.name)).toEqual(['user-hook', 'speckit-pre_tool-validate']);
    });
  }

  test('a marker-looking command string does not claim a user hook', () => {
    const userBlock = '[[hooks]]\nname = "user-hook"\ntype = "pre_tool"\ncommand = "echo speckit_marker = true"\n';
    mkdirSync(join(tmp, '.vibe'), { recursive: true });
    writeFileSync(hooksPath(), userBlock);
    install({ pre_tool_use: [{ command: 'speckit.tdd.validate' }] });
    expect(readFileSync(hooksPath(), 'utf8')).toContain(userBlock);
    expect(parse().hooks.map((h) => h.name)).toEqual(['user-hook', 'speckit-pre_tool-validate']);
  });

  for (const separator of ['\u0085', ' ', ' ']) {
    test(`a unicode separator in a comment cannot spoof the marker (${JSON.stringify(separator)})`, () => {
      const userBlock = `[[hooks]]\nname = "user-hook"\ntype = "pre_tool"\n# user note${separator}speckit_marker = true\ncommand = "guard-bash"\n`;
      const original = Buffer.from(userBlock, 'utf-8');
      const [path, mtime] = writeUserFile(original);
      expect(vibe.removeVibeEventHooks(tmp, noSafety)).toBe(false);
      expect(readFileSync(path).equals(original)).toBe(true);
      expect(statSync(path).mtimeMs).toBe(mtime);
    });
  }

  test('teardown deletes the file when only comments remain', () => {
    const events = { pre_tool_use: [{ command: 'speckit.tdd.validate' }] };
    install(events);
    writeFileSync(hooksPath(), readFileSync(hooksPath(), 'utf8') + '\n# notes about these hooks\n');
    const manifest = install(events);
    expect(readFileSync(hooksPath(), 'utf8')).toContain('# notes about these hooks');
    removeIntegrationEvents(vibe, tmp, manifest);
    expect(existsSync(hooksPath())).toBe(false);
  });

  test('the merged config is tracked with partial ownership', () => {
    const manifest = install({ pre_tool_use: [{ command: 'speckit.tdd.validate' }] });
    expect(manifest.ownershipModes['.vibe/hooks.toml']).toBe('partial');
    expect(manifest.ownershipModes['.specify/events.py']).toBe('shared');
  });
});

describe('unowned hooks.toml survives no-op cleanup (#4646)', () => {
  for (const [label, original] of [
    ['user CRLF file', Buffer.from('user_option = "keep"\r\nsecond_option = true')],
    ['comments-only file', Buffer.from('# maintained by the user\n# no hooks yet\n')],
    ['whitespace-only file', Buffer.from('\r\n \t\r\n')],
  ] as const) {
    test(`empty events leave a ${label} untouched`, () => {
      const [path, mtime] = writeUserFile(original);
      const manifest = new IntegrationManifest('vibe', tmp);
      installIntegrationEvents(vibe, tmp, manifest, {});
      expect(readFileSync(path).equals(original)).toBe(true);
      expect(statSync(path).mtimeMs).toBe(mtime);
      expect('.vibe/hooks.toml' in manifest.files).toBe(false);
    });
  }

  test('a commented marker inside a user hook is not ownership', () => {
    const original = Buffer.from('[[hooks]]\nname = "user-hook"\ntype = "pre_tool"\n# speckit_marker = true\ncommand = "guard-bash"\n');
    const [path, mtime] = writeUserFile(original);
    expect(vibe.removeVibeEventHooks(tmp, noSafety)).toBe(false);
    expect(readFileSync(path).equals(original)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(mtime);
  });

  for (const newline of ['\n', '\r\n']) {
    test(`removal recognizes a valid marker with TOML line endings (${JSON.stringify(newline)})`, () => {
      const managed = `[[hooks]]${newline}name = "managed"${newline}speckit_marker = true${newline}`;
      const user = `[[hooks]]${newline}name = "user-hook"${newline}command = "guard-bash"${newline}`;
      writeUserFile(managed + user);
      expect(vibe.removeVibeEventHooks(tmp, noSafety)).toBe(false);
      expect(readFileSync(hooksPath(), 'utf8')).toBe(user);
    });
  }

  test('malformed TOML is left byte-for-byte untouched', () => {
    const original = Buffer.from('[[hooks]]\nname = "managed\nspeckit_marker = true\n');
    const [path, mtime] = writeUserFile(original);
    expect(vibe.removeVibeEventHooks(tmp, noSafety)).toBe(false);
    expect(readFileSync(path).equals(original)).toBe(true);
    expect(statSync(path).mtimeMs).toBe(mtime);
  });
});

describe('TOML header parsing', () => {
  test('recognizes headers and rejects ambiguous ones', () => {
    expect(VibeIntegration.parseTomlHeader('[[hooks]]')).toEqual([true, ['hooks']]);
    expect(VibeIntegration.parseTomlHeader(' [ a . "b" ] ')).toEqual([false, ['a', 'b']]);
    expect(VibeIntegration.parseTomlHeader('[é]')).toEqual([false, null]);
    expect(VibeIntegration.parseTomlHeader('[a b]')).toEqual([false, null]);
    expect(VibeIntegration.parseTomlHeader('["x\\\\y"]')).toEqual([false, [null]]);
    expect(VibeIntegration.parseTomlHeader('not a header')).toEqual([false, null]);
  });
});
