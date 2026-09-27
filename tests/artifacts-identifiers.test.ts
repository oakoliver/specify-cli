/**
 * Artifact identifier helpers and error messages. Ports of the identifier
 * behaviors exercised across tests/specify_cli/artifacts/*.
 */

import { describe, expect, test } from 'bun:test';

import {
  IdentifierComponentError,
  deriveHookLookupId,
  deriveHookPublicId,
  deriveLookupId,
  derivePublicId,
  parseHookArtifactName,
  parseLookupId,
  validateComponent,
} from '../src/artifacts/identifiers.js';
import {
  AmbiguousArtifactError,
  ArtifactNotFoundError,
  ArtifactResolutionError,
  ContributionNotFoundError,
  NotASpecKitProjectError,
} from '../src/artifacts/models.js';

describe('identifiers', () => {
  test('validateComponent', () => {
    expect(validateComponent('a', 'name')).toBe('a');
    expect(() => validateComponent(3, 'name')).toThrow('Invalid name: expected a string, got int');
    expect(() => validateComponent('', 'name')).toThrow('Invalid name: value must not be empty');
    expect(() => validateComponent('a:b', 'command name')).toThrow(
      "Invalid command name 'a:b': ':' is reserved as an identifier delimiter",
    );
  });

  test('public and lookup ids', () => {
    expect(derivePublicId('command', 'speckit.plan')).toBe('command:speckit.plan');
    expect(() => derivePublicId('hook', 'x')).toThrow("Invalid public artifact kind 'hook'");
    expect(deriveLookupId('project', '_', 'template', 'spec')).toBe('project:_:template:spec');
    expect(() => deriveLookupId('project', 'x', 'template', 'spec')).toThrow("project layer requires '_'");
    expect(() => deriveLookupId('preset', '_', 'template', 'spec')).toThrow('reserved for project layer');
    expect(() => deriveLookupId('bogus', 'x', 'template', 'spec')).toThrow("Invalid layer 'bogus'");
  });

  test('hook ids percent-encode components like urllib.parse.quote(safe="")', () => {
    expect(deriveHookPublicId('before_specify', 'speckit.a.b')).toBe('hook:before_specify:speckit.a.b');
    expect(deriveHookPublicId('ev:x', 'a/b c~é')).toBe('hook:ev%3Ax:a%2Fb%20c~%C3%A9');
    expect(deriveHookLookupId('extension', 'ext', 'ev', 'cmd')).toBe('extension:ext:hook:ev:cmd');
    expect(() => deriveHookLookupId('project', '_', 'ev', 'cmd')).toThrow("Invalid hook layer 'project'");
    expect(() => deriveHookPublicId('ev', '\ud800')).toThrow('Invalid command: value cannot be UTF-8 encoded');
    expect(() => deriveHookPublicId('ev', null)).toThrow('Invalid command: expected a string, got NoneType');
  });

  test('parseHookArtifactName round-trips and rejects malformed escapes', () => {
    expect(parseHookArtifactName('ev%3Ax:a%2Fb%20c~%C3%A9')).toEqual(['ev:x', 'a/b c~é']);
    expect(() => parseHookArtifactName('noseparator')).toThrow('Invalid hook artifact name');
    expect(() => parseHookArtifactName('a:b:c')).toThrow('Invalid hook artifact name');
    expect(() => parseHookArtifactName('event:bad%escape')).toThrow('Invalid command: malformed percent escape');
    expect(() => parseHookArtifactName('event:%FF')).toThrow('Invalid command: value is not valid UTF-8');
  });

  test('parseLookupId', () => {
    expect(parseLookupId('preset:p:template:t')).toEqual(['preset', 'p', 'template', 't']);
    expect(parseLookupId('extension:e:hook:ev%3Ax:cmd')).toEqual(['extension', 'e', 'hook', 'ev%3Ax:cmd']);
    for (const bad of [
      'invalid:source:command:name',
      'extension:source:invalid:name',
      'extension:source:hook:%FF:command',
      'extension:source:hook:event:%ZZ',
      'extension:source:hook:event:%63md',
      'a:b',
    ]) {
      expect(() => parseLookupId(bad)).toThrow(IdentifierComponentError);
    }
  });
});

describe('error messages', () => {
  test('stable messages', () => {
    expect(new ArtifactNotFoundError('x').message).toBe('unknown artifact x');
    expect(new ContributionNotFoundError('a:b').message).toBe('unknown contribution a:b');
    expect(new AmbiguousArtifactError('spec', ['template', 'command']).message).toBe(
      "ambiguous artifact spec: matches kinds ['command', 'template']",
    );
    expect(new NotASpecKitProjectError().message).toBe('not a Spec Kit project: no .specify/ directory found');
    expect(new ArtifactResolutionError().message).toBe('artifact resolution failed');
  });
});
