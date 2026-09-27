/**
 * Tests for src/authentication/* (port of upstream
 * tests/specify_cli/authentication/test_authentication.py and test_github_http.py).
 * No network: globalThis.fetch is mocked.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AUTH_REGISTRY,
  AzureDevOpsAuth,
  BitbucketAuth,
  GitHubAuth,
  KeyError,
  getProvider,
  registerProvider,
} from '../src/authentication/index.js';
import { AuthProvider } from '../src/authentication/base.js';
import {
  type AuthConfigEntry,
  authWarnings,
  findEntriesForUrl,
  loadAuthConfig,
  makeAuthConfigEntry,
} from '../src/authentication/config.js';
import {
  HTTPError,
  RedirectPolicyError,
  URLError,
  buildRequest,
  githubProviderHosts,
  loadConfig,
  openUrl,
  resetAuthConfigCache,
  setAuthConfigOverride,
} from '../src/authentication/http.js';
import { azureHooks } from '../src/authentication/azure-devops.js';
import {
  buildGithubRequest,
  fnmatch,
  resolveGithubReleaseAssetApiUrl,
} from '../src/authentication/github-http.js';
import { ValueError } from '../src/download-security.js';

// ============================================================================
// Helpers
// ============================================================================

let tmp: string;
const savedEnv = { ...process.env };
const realFetch = globalThis.fetch;
const savedEmit = authWarnings.emit;
let warnings: string[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'));
  warnings = [];
  authWarnings.emit = (m: string) => {
    warnings.push(m);
  };
  setAuthConfigOverride(null);
  resetAuthConfigCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  authWarnings.emit = savedEmit;
  setAuthConfigOverride(null);
  resetAuthConfigCache();
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(data: unknown, mode = 0o600): string {
  const p = path.join(tmp, 'auth.json');
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
  fs.chmodSync(p, mode);
  return p;
}

function githubEntry(tokenEnv = 'GH_TOKEN'): AuthConfigEntry {
  return makeAuthConfigEntry({
    hosts: ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com'],
    provider: 'github',
    auth: 'bearer',
    token_env: tokenEnv,
  });
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Install a fetch mock driven by `handler(url, call)`. */
function mockFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers, body: init?.body };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function redirect(to: string, code = 302): Response {
  return new Response(null, { status: code, headers: { Location: to } });
}

// ============================================================================
// config
// ============================================================================

describe('loadAuthConfig', () => {
  test('missing file returns empty', () => {
    expect(loadAuthConfig(path.join(tmp, 'none.json'))).toEqual([]);
  });
  test('valid github config', () => {
    const entries = loadAuthConfig(writeConfig({ providers: [{ hosts: [' GitHub.com '], provider: 'github', auth: 'bearer', token_env: 'GH_TOKEN' }] }));
    expect(entries).toHaveLength(1);
    expect(entries[0].hosts).toEqual(['github.com']);
    expect(entries[0].token_env).toBe('GH_TOKEN');
    expect(entries[0].username).toBeNull();
  });
  test('padded token_env is normalized and resolves', () => {
    process.env.MY_TOKEN = ' secret ';
    const [entry] = loadAuthConfig(writeConfig({ providers: [{ hosts: ['github.com'], provider: 'github', auth: 'bearer', token_env: '  MY_TOKEN  ' }] }));
    expect(entry.token_env).toBe('MY_TOKEN');
    expect(new GitHubAuth().resolveToken(entry)).toBe('secret');
  });
  test('valid ado / bitbucket / azure-ad / azure-cli configs', () => {
    const entries = loadAuthConfig(
      writeConfig({
        providers: [
          { hosts: ['dev.azure.com', '*.visualstudio.com'], provider: 'azure-devops', auth: 'basic-pat', token_env: 'ADO' },
          { hosts: ['bitbucket.org'], provider: 'bitbucket', auth: 'bearer', token: 'tok' },
          { hosts: ['bitbucket.org'], provider: 'bitbucket', auth: 'basic', token_env: 'BB', username: ' me@example.com ' },
          { hosts: ['dev.azure.com'], provider: 'azure-devops', auth: 'azure-ad', tenant_id: ' t ', client_id: ' c ', client_secret_env: ' S ' },
          { hosts: ['dev.azure.com'], provider: 'azure-devops', auth: 'azure-cli' },
        ],
      }),
    );
    expect(entries.map((e) => e.auth)).toEqual(['basic-pat', 'bearer', 'basic', 'azure-ad', 'azure-cli']);
    expect(entries[2].username).toBe('me@example.com');
    expect([entries[3].tenant_id, entries[3].client_id, entries[3].client_secret_env]).toEqual(['t', 'c', 'S']);
  });
  test.each([
    ['not json', /contains invalid JSON/],
    ['[]', /auth.json must be a JSON object, got list/],
    ['{}', /must contain a 'providers' array/],
    [{ providers: [{ hosts: [], provider: 'github', auth: 'bearer', token: 't' }] }, /'hosts' must be a non-empty array/],
    [{ providers: [{ hosts: ['github.com'], auth: 'bearer', token: 't' }] }, /'provider' must be a non-empty string/],
    [{ providers: [{ hosts: ['github.com'], provider: 'github', auth: 'basic-pat', token: 't' }] }, /does not support auth scheme 'basic-pat'; supported: \['bearer'\]/],
    [{ providers: [{ hosts: ['github.com'], provider: 'github', auth: 'bearer' }] }, /auth='bearer' requires 'token' or 'token_env'/],
    [{ providers: [{ hosts: ['x'], provider: 'azure-devops', auth: 'azure-ad', tenant_id: 't' }] }, /requires 'tenant_id', 'client_id', and 'client_secret_env'/],
    [{ providers: [{ hosts: ['x'], provider: 'gitlab', auth: 'bearer', token: 't' }] }, /unknown provider 'gitlab'; registered: \['azure-devops', 'bitbucket', 'github'\]/],
    [{ providers: [{ hosts: ['*github.com'], provider: 'github', auth: 'bearer', token: 't' }] }, /invalid host pattern '\*github.com'/],
    [{ providers: [{ hosts: ['*.*.com'], provider: 'github', auth: 'bearer', token: 't' }] }, /invalid host pattern/],
    [{ providers: [{ hosts: ['git?ub.com'], provider: 'github', auth: 'bearer', token: 't' }] }, /invalid host pattern/],
    [{ providers: [{ hosts: ['b.org'], provider: 'bitbucket', auth: 'basic', token: 't' }] }, /auth='basic' requires 'username'/],
    [{ providers: [{ hosts: ['b.org'], provider: 'bitbucket', auth: 'basic', token: 't', username: 'a:b' }] }, /'username' must not contain ':'/],
    [{ providers: [{ hosts: ['b.org'], provider: 'bitbucket', auth: 'basic', token: 't', username: 5 }] }, /'username' must be a non-empty string/],
  ])('invalid config %#', (data, message) => {
    const p = writeConfig(data);
    expect(() => loadAuthConfig(p)).toThrow(ValueError);
    expect(() => loadAuthConfig(p)).toThrow(message);
  });
  test('world-readable file warns', () => {
    const p = writeConfig({ providers: [] }, 0o644);
    loadAuthConfig(p);
    expect(warnings.join('\n')).toContain('is readable by group/others');
  });
});

describe('findEntriesForUrl', () => {
  const exact = makeAuthConfigEntry({ hosts: ['github.com'], provider: 'github', auth: 'bearer', token: 't' });
  const wild = makeAuthConfigEntry({ hosts: ['*.visualstudio.com'], provider: 'azure-devops', auth: 'bearer', token: 't' });
  test('exact and wildcard matches', () => {
    expect(findEntriesForUrl('https://GitHub.com/x', [exact, wild])).toEqual([exact]);
    expect(findEntriesForUrl('https://org.visualstudio.com/x', [exact, wild])).toEqual([wild]);
  });
  test('wildcard does not match apex or lookalikes; exact hosts are literal', () => {
    expect(findEntriesForUrl('https://visualstudio.com/x', [wild])).toEqual([]);
    expect(findEntriesForUrl('https://evilvisualstudio.com/x', [wild])).toEqual([]);
    expect(findEntriesForUrl('https://github.com.evil.com/x', [exact])).toEqual([]);
    const literal = makeAuthConfigEntry({ hosts: ['[x].com'], provider: 'github', auth: 'bearer', token: 't' });
    expect(findEntriesForUrl('https://x.com/', [literal])).toEqual([]);
  });
  test('empty / malformed urls', () => {
    expect(findEntriesForUrl('', [exact])).toEqual([]);
    expect(findEntriesForUrl('https://[::1/x', [exact])).toEqual([]);
    expect(findEntriesForUrl('https://github.com:bad/', [exact])).toEqual([]);
    expect(findEntriesForUrl('https://github.com/', [])).toEqual([]);
  });
  test('multiple matches returned in order', () => {
    const second = makeAuthConfigEntry({ hosts: ['github.com'], provider: 'github', auth: 'bearer', token: 'u' });
    expect(findEntriesForUrl('https://github.com/', [exact, second])).toEqual([exact, second]);
  });
});

// ============================================================================
// registry + providers
// ============================================================================

describe('registry', () => {
  test('built-ins registered', () => {
    expect(Object.keys(AUTH_REGISTRY).sort()).toEqual(['azure-devops', 'bitbucket', 'github']);
    expect(getProvider('github')).toBeInstanceOf(GitHubAuth);
    expect(getProvider('azure-devops')).toBeInstanceOf(AzureDevOpsAuth);
    expect(getProvider('bitbucket')).toBeInstanceOf(BitbucketAuth);
    expect(getProvider('nope')).toBeNull();
  });
  test('duplicate / empty keys rejected', () => {
    expect(() => registerProvider(new GitHubAuth())).toThrow(KeyError);
    class Empty extends AuthProvider {
      authHeaders(): Record<string, string> {
        return {};
      }
    }
    expect(() => registerProvider(new Empty())).toThrow('Cannot register provider with an empty key.');
  });
});

describe('providers', () => {
  const entry = (init: Partial<AuthConfigEntry> & { auth: string; provider: string }): AuthConfigEntry =>
    makeAuthConfigEntry({ hosts: ['h'], ...init });
  test('GitHubAuth', () => {
    const gh = new GitHubAuth();
    expect(gh.authHeaders('tok', 'bearer')).toEqual({ Authorization: 'Bearer tok' });
    expect(() => gh.authHeaders('tok', 'basic')).toThrow("GitHubAuth does not support auth scheme 'basic'");
    process.env.T1 = '  abc  ';
    expect(gh.resolveToken(entry({ provider: 'github', auth: 'bearer', token_env: 'T1' }))).toBe('abc');
    expect(gh.resolveToken(entry({ provider: 'github', auth: 'bearer', token: ' inline ' }))).toBe('inline');
    process.env.T2 = '   ';
    expect(gh.resolveToken(entry({ provider: 'github', auth: 'bearer', token_env: 'T2' }))).toBeNull();
    expect(gh.resolveToken(entry({ provider: 'github', auth: 'bearer', token_env: 'MISSING_XYZ' }))).toBeNull();
  });
  test('AzureDevOpsAuth headers', () => {
    const ado = new AzureDevOpsAuth();
    expect(ado.authHeaders('pat', 'basic-pat')).toEqual({ Authorization: `Basic ${Buffer.from(':pat').toString('base64')}` });
    for (const s of ['bearer', 'azure-cli', 'azure-ad']) expect(ado.authHeaders('t', s)).toEqual({ Authorization: 'Bearer t' });
    expect(() => ado.authHeaders('t', 'basic')).toThrow('AzureDevOpsAuth does not support auth scheme');
  });
  test('AzureDevOpsAuth azure-cli', async () => {
    const saved = { ...azureHooks };
    try {
      let ran: string[] = [];
      azureHooks.which = () => '/usr/bin/az';
      azureHooks.run = (cmd) => {
        ran = cmd;
        return { status: 0, stdout: JSON.stringify({ accessToken: ' tok ' }) };
      };
      const e = entry({ provider: 'azure-devops', auth: 'azure-cli' });
      expect(await new AzureDevOpsAuth().resolveToken(e)).toBe('tok');
      expect(ran[0]).toBe('/usr/bin/az');
      azureHooks.which = () => 'relative/az';
      await new AzureDevOpsAuth().resolveToken(e);
      expect(ran[0]).toBe('az');
      azureHooks.run = () => ({ status: 1, stdout: '' });
      expect(await new AzureDevOpsAuth().resolveToken(e)).toBeNull();
      azureHooks.run = () => ({ status: null, stdout: '', error: new Error('ENOENT') });
      expect(await new AzureDevOpsAuth().resolveToken(e)).toBeNull();
      azureHooks.run = () => ({ status: 0, stdout: Buffer.from([0xff, 0xfe]) });
      expect(await new AzureDevOpsAuth().resolveToken(e)).toBeNull();
      azureHooks.run = () => ({ status: 0, stdout: '[1]' });
      expect(await new AzureDevOpsAuth().resolveToken(e)).toBeNull();
    } finally {
      Object.assign(azureHooks, saved);
    }
  });
  test('AzureDevOpsAuth azure-ad', async () => {
    const e = entry({ provider: 'azure-devops', auth: 'azure-ad', tenant_id: 'ten', client_id: 'cid', client_secret_env: 'ADO_SECRET' });
    expect(await new AzureDevOpsAuth().resolveToken(e)).toBeNull(); // missing secret
    process.env.ADO_SECRET = 's3cret';
    const calls = mockFetch(() => new Response(JSON.stringify({ access_token: 'aad' })));
    expect(await new AzureDevOpsAuth().resolveToken(e)).toBe('aad');
    expect(calls[0].url).toBe('https://login.microsoftonline.com/ten/oauth2/v2.0/token');
    expect(calls[0].method).toBe('POST');
    expect(String(calls[0].body)).toContain('client_secret=s3cret');
    mockFetch(() => redirect('https://evil.example/token', 307));
    expect(await new AzureDevOpsAuth().resolveToken(e)).toBeNull();
    mockFetch(() => {
      throw new TypeError('network down');
    });
    expect(await new AzureDevOpsAuth().resolveToken(e)).toBeNull();
    mockFetch(() => new Response('x'.repeat(1024 * 1024 + 1)));
    expect(await new AzureDevOpsAuth().resolveToken(e)).toBeNull();
    mockFetch(() => new Response('[1]'));
    expect(await new AzureDevOpsAuth().resolveToken(e)).toBeNull();
    mockFetch(() => new Response(new Uint8Array([0xff])));
    expect(await new AzureDevOpsAuth().resolveToken(e)).toBeNull();
  });
  test('BitbucketAuth', () => {
    const bb = new BitbucketAuth();
    expect(bb.authHeaders('t', 'bearer')).toEqual({ Authorization: 'Bearer t' });
    expect(bb.authHeaders('me@x.com:se:cret', 'basic')).toEqual({ Authorization: `Basic ${Buffer.from('me@x.com:se:cret').toString('base64')}` });
    expect(bb.authHeaders('mé:s', 'basic').Authorization).toBe(`Basic ${Buffer.from('mé:s', 'utf8').toString('base64')}`);
    expect(() => bb.authHeaders('bare', 'basic')).toThrow("expects a '<username>:<secret>'");
    expect(() => bb.authHeaders(':s', 'basic')).toThrow();
    expect(() => bb.authHeaders('u:', 'basic')).toThrow();
    expect(() => bb.authHeaders('t', 'basic-pat')).toThrow('BitbucketAuth does not support auth scheme');
    process.env.BB = ' sec ';
    expect(bb.resolveToken(entry({ provider: 'bitbucket', auth: 'basic', token_env: 'BB', username: ' me ' }))).toBe('me:sec');
    expect(bb.resolveToken(entry({ provider: 'bitbucket', auth: 'basic', token: 'x', username: 'me' }))).toBe('me:x');
    expect(bb.resolveToken(entry({ provider: 'bitbucket', auth: 'basic', token: 'x' }))).toBeNull();
    expect(bb.resolveToken(entry({ provider: 'bitbucket', auth: 'basic', token: 'x', username: '  ' }))).toBeNull();
    expect(bb.resolveToken(entry({ provider: 'bitbucket', auth: 'basic', token: 'x', username: 'a:b' }))).toBeNull();
    expect(bb.resolveToken(entry({ provider: 'bitbucket', auth: 'basic', username: 'me' }))).toBeNull();
    expect(bb.resolveToken(entry({ provider: 'bitbucket', auth: 'bearer', token_env: 'BB' }))).toBe('sec');
  });
});

// ============================================================================
// http
// ============================================================================

describe('buildRequest / openUrl', () => {
  test('buildRequest attaches auth only for matching hosts; extra headers cannot override', async () => {
    process.env.GH_TOKEN = 'ghp';
    setAuthConfigOverride([githubEntry()]);
    const req = await buildRequest('https://github.com/x', { Accept: 'application/json', authorization: 'Bearer evil' });
    expect(req.headers).toEqual({ Accept: 'application/json', Authorization: 'Bearer ghp' });
    expect((await buildRequest('https://example.com/x')).headers).toEqual({});
    setAuthConfigOverride([]);
    expect((await buildRequest('https://github.com/x')).headers).toEqual({});
  });
  test('buildRequest bitbucket basic', async () => {
    process.env.BB = 'sec';
    setAuthConfigOverride([makeAuthConfigEntry({ hosts: ['bitbucket.org'], provider: 'bitbucket', auth: 'basic', token_env: 'BB', username: 'me' })]);
    expect((await buildRequest('https://bitbucket.org/a')).headers.Authorization).toBe(`Basic ${Buffer.from('me:sec').toString('base64')}`);
  });
  test('openUrl attaches auth for matching host, not otherwise', async () => {
    process.env.GH_TOKEN = 'ghp';
    setAuthConfigOverride([githubEntry()]);
    const calls = mockFetch(() => new Response('ok'));
    const res = await openUrl('https://api.github.com/x', { extraHeaders: { Accept: 'application/octet-stream' } });
    expect(await res.text()).toBe('ok');
    expect(res.url).toBe('https://api.github.com/x');
    expect(calls[0].headers.authorization).toBe('Bearer ghp');
    expect(calls[0].headers.accept).toBe('application/octet-stream');
    await openUrl('https://example.com/x');
    expect(calls[1].headers.authorization).toBeUndefined();
  });
  test('falls through on 401 then unauthenticated', async () => {
    process.env.T_A = 'a';
    process.env.T_B = 'b';
    setAuthConfigOverride([githubEntry('T_A'), githubEntry('T_B')]);
    const calls = mockFetch((c) => (c.headers.authorization ? new Response('no', { status: c.headers.authorization === 'Bearer a' ? 401 : 403 }) : new Response('anon')));
    const res = await openUrl('https://github.com/x');
    expect(await res.text()).toBe('anon');
    expect(calls.map((c) => c.headers.authorization)).toEqual(['Bearer a', 'Bearer b', undefined]);
  });
  test('404 and 500 raise immediately as HTTPError', async () => {
    process.env.GH_TOKEN = 'ghp';
    setAuthConfigOverride([githubEntry()]);
    for (const status of [404, 500]) {
      const calls = mockFetch(() => new Response('x', { status }));
      const err = await openUrl('https://github.com/x').catch((e) => e);
      expect(err).toBeInstanceOf(HTTPError);
      expect(err.code).toBe(status);
      expect(err.message).toContain(`HTTP Error ${status}`);
      expect(calls).toHaveLength(1);
    }
  });
  test('network errors propagate as URLError', async () => {
    mockFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(openUrl('https://example.com/x')).rejects.toBeInstanceOf(URLError);
  });
  test('config cached, override bypasses cache, failed load warns once', () => {
    process.env.HOME = tmp;
    fs.mkdirSync(path.join(tmp, '.specify'));
    fs.writeFileSync(path.join(tmp, '.specify', 'auth.json'), '{bad');
    fs.chmodSync(path.join(tmp, '.specify', 'auth.json'), 0o600);
    resetAuthConfigCache();
    expect(loadConfig()).toEqual([]);
    expect(loadConfig()).toEqual([]);
    expect(warnings.filter((w) => w.includes('All requests will be unauthenticated.'))).toHaveLength(1);
    setAuthConfigOverride([githubEntry()]);
    expect(loadConfig()).toHaveLength(1);
  });
  test('redirect within hosts preserves auth; outside strips it', async () => {
    process.env.GH_TOKEN = 'ghp';
    setAuthConfigOverride([githubEntry()]);
    const calls = mockFetch((c) => {
      if (c.url === 'https://github.com/a') return redirect('https://codeload.github.com/b');
      if (c.url === 'https://codeload.github.com/b') return redirect('https://objects.example.net/c');
      return new Response('done');
    });
    const res = await openUrl('https://github.com/a');
    expect(res.url).toBe('https://objects.example.net/c');
    expect(calls.map((c) => c.headers.authorization)).toEqual(['Bearer ghp', 'Bearer ghp', undefined]);
  });
  test('redirect host patterns use literal-safe matching', async () => {
    process.env.GH_TOKEN = 'ghp';
    setAuthConfigOverride([makeAuthConfigEntry({ hosts: ['*.example.com'], provider: 'github', auth: 'bearer', token_env: 'GH_TOKEN' })]);
    const calls = mockFetch((c) => (c.url.includes('a.example.com') ? redirect('https://example.com.evil.net/x') : new Response('ok')));
    await openUrl('https://a.example.com/start');
    expect(calls[1].headers.authorization).toBeUndefined();
  });
  test('unsafe redirects are rejected with a descriptive error', async () => {
    mockFetch(() => redirect('http://evil.example.com/archive.zip'));
    const err = await openUrl('https://example.com/x').catch((e) => e);
    expect(err).toBeInstanceOf(RedirectPolicyError);
    expect(err).toBeInstanceOf(URLError);
    for (const s of ['unsafe redirect', 'http://evil.example.com/archive.zip', 'localhost', '127.0.0.1', '::1']) {
      expect(err.message).toContain(s);
    }
    mockFetch(() => redirect('https://127.0.0.1/internal'));
    await expect(openUrl('https://example.com/x')).rejects.toBeInstanceOf(RedirectPolicyError);
    mockFetch(() => redirect('http://github.com/x'));
    await expect(openUrl('https://github.com/x')).rejects.toBeInstanceOf(RedirectPolicyError);
  });
  test('loopback to http loopback is allowed', async () => {
    mockFetch((c) => (c.url === 'http://localhost:8000/a' ? redirect('http://127.0.0.1:8000/b') : new Response('ok')));
    expect(await (await openUrl('http://localhost:8000/a')).text()).toBe('ok');
  });
  test('multi-hop remote -> loopback chain rejected at first local hop', async () => {
    const calls = mockFetch((c) => (c.url === 'https://a.example/1' ? redirect('https://b.example/2') : redirect('https://localhost/3')));
    await expect(openUrl('https://a.example/1')).rejects.toBeInstanceOf(RedirectPolicyError);
    expect(calls).toHaveLength(2);
  });
  test('malformed redirect URLs raise URLError, not ValueError', async () => {
    mockFetch(() => redirect('https://[::1/x'));
    await expect(openUrl('https://example.com/x')).rejects.toBeInstanceOf(URLError);
    mockFetch(() => redirect('https://example.com:bad/x'));
    const err = await openUrl('https://example.com/x').catch((e) => e);
    expect(err).toBeInstanceOf(RedirectPolicyError);
    expect(err.message).toContain('malformed redirect URL');
  });
  test('redirect validator can reject before following', async () => {
    const calls = mockFetch(() => redirect('https://other.example/x'));
    const err = await openUrl('https://example.com/x', {
      redirectValidator: () => {
        throw new URLError('nope');
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(URLError);
    expect(calls).toHaveLength(1);
  });
  test('githubProviderHosts', () => {
    setAuthConfigOverride([]);
    expect(githubProviderHosts()).toEqual([]);
    setAuthConfigOverride([
      githubEntry(),
      makeAuthConfigEntry({ hosts: ['ghe.corp'], provider: 'github', auth: 'bearer', token: 't' }),
      makeAuthConfigEntry({ hosts: ['dev.azure.com'], provider: 'azure-devops', auth: 'bearer', token: 't' }),
    ]);
    expect(githubProviderHosts()).toEqual(['github.com', 'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com', 'ghe.corp']);
  });
});

// ============================================================================
// github_http
// ============================================================================

describe('buildGithubRequest', () => {
  test.each([
    ['', 'url must not be empty'],
    ['   ', 'url must not be empty'],
    ['file:///etc/passwd', "url must start with http:// or https://, got: 'file:///etc/passwd'"],
    ['ftp://github.com/x', 'url must start with http:// or https://'],
    ['https:///x', 'url must include a hostname'],
    ['https://github.com:bad/x', 'Port could not be cast to integer value'],
  ])('rejects %j', (url, message) => {
    expect(() => buildGithubRequest(url)).toThrow(message);
  });
  test('adds token only for GitHub hosts', () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    expect(buildGithubRequest('https://github.com/x').headers).toEqual({});
    process.env.GH_TOKEN = 'fallback';
    expect(buildGithubRequest('https://api.github.com/x').headers).toEqual({ Authorization: 'Bearer fallback' });
    process.env.GITHUB_TOKEN = 'primary';
    expect(buildGithubRequest(' https://raw.githubusercontent.com:443/x ').headers).toEqual({ Authorization: 'Bearer primary' });
    expect(buildGithubRequest('https://raw.githubusercontent.com:443/x').url).toBe('https://raw.githubusercontent.com:443/x');
    expect(buildGithubRequest('https://example.com/x').headers).toEqual({});
  });
});

describe('resolveGithubReleaseAssetApiUrl', () => {
  const release = (assets: unknown[]): (() => Promise<Response>) => async () => new Response(JSON.stringify({ assets }));
  const openFn = (fn: () => Promise<Response>, seen: string[] = []) => async (url: string) => {
    seen.push(url);
    return fn();
  };
  test('non-github / non-release urls', async () => {
    const seen: string[] = [];
    expect(await resolveGithubReleaseAssetApiUrl('https://example.com/o/r/releases/download/v1/a.zip', openFn(release([]), seen))).toBeNull();
    expect(await resolveGithubReleaseAssetApiUrl('https://github.com/o/r/archive/v1.zip', openFn(release([]), seen))).toBeNull();
    expect(seen).toEqual([]);
  });
  test('passthrough for API asset urls', async () => {
    const url = 'https://api.github.com/repos/o/r/releases/assets/123';
    expect(await resolveGithubReleaseAssetApiUrl(url, openFn(release([])))).toBe(url);
    const ghes = 'https://ghe.corp/api/v3/repos/o/r/releases/assets/9';
    expect(await resolveGithubReleaseAssetApiUrl(ghes, openFn(release([])))).toBe(ghes);
  });
  test('resolves browser url and encodes tag', async () => {
    const seen: string[] = [];
    const assetUrl = 'https://api.github.com/repos/O/R/releases/assets/42';
    const got = await resolveGithubReleaseAssetApiUrl(
      'https://github.com/o/r/releases/download/v1.0%2Bbuild%23x/pkg.zip',
      openFn(release([{ name: 'other', url: 'x' }, { name: 'pkg.zip', url: assetUrl }]), seen),
    );
    expect(got).toBe(assetUrl);
    expect(seen).toEqual(['https://api.github.com/repos/o/r/releases/tags/v1.0%2Bbuild%23x']);
  });
  test('tag with literal slash', async () => {
    const seen: string[] = [];
    await resolveGithubReleaseAssetApiUrl('https://github.com/o/r/releases/download/feat/x/pkg.zip', openFn(release([]), seen));
    expect(seen).toEqual(['https://api.github.com/repos/o/r/releases/tags/feat%2Fx']);
  });
  test.each([
    'https://evil.example/repos/o/r/releases/assets/42',
    'https://api.github.com/repos/other/r/releases/assets/42',
    'https://api.github.com/repos/o/r/releases/assets/42?x=1',
    'https://user@api.github.com/repos/o/r/releases/assets/42',
    'https://api.github.com/repos/o/r/releases/assets/abc',
    'https://api.github.com/repos/o/r/releases/assets/4 2',
    'http://api.github.com/repos/o/r/releases/assets/42',
    5,
  ])('rejects invalid metadata asset url %j', async (assetUrl) => {
    expect(await resolveGithubReleaseAssetApiUrl('https://github.com/o/r/releases/download/v1/pkg.zip', openFn(release([{ name: 'pkg.zip', url: assetUrl }])))).toBeNull();
  });
  test('asset not found / network error / invalid metadata -> null', async () => {
    const dl = 'https://github.com/o/r/releases/download/v1/pkg.zip';
    expect(await resolveGithubReleaseAssetApiUrl(dl, openFn(release([])))).toBeNull();
    expect(
      await resolveGithubReleaseAssetApiUrl(dl, async () => {
        throw new URLError('down');
      }),
    ).toBeNull();
    expect(await resolveGithubReleaseAssetApiUrl(dl, openFn(async () => new Response('not json')))).toBeNull();
    expect(await resolveGithubReleaseAssetApiUrl(dl, openFn(async () => new Response('[1]')))).toBeNull();
  });
  test('metadata lookup is bounded and passes the redirect validator', async () => {
    let received: unknown = null;
    const validator = () => undefined;
    const got = await resolveGithubReleaseAssetApiUrl(
      'https://github.com/o/r/releases/download/v1/pkg.zip',
      async (_url, opts) => {
        received = opts.redirectValidator;
        return new Response('x'.repeat(100));
      },
      { redirectValidator: validator, maxMetadataBytes: 10 },
    );
    expect(got).toBeNull();
    expect(received).toBe(validator);
  });
  test('GHES resolution preserves scheme/port and requires allowlist', async () => {
    const seen: string[] = [];
    const asset = 'http://ghe.corp:8443/api/v3/repos/o/r/releases/assets/7';
    const got = await resolveGithubReleaseAssetApiUrl(
      'http://ghe.corp:8443/o/r/releases/download/v1/pkg.zip',
      openFn(release([{ name: 'pkg.zip', url: asset }]), seen),
      { githubHosts: ['*.corp', 'ghe.corp'] },
    );
    expect(got).toBe(asset);
    expect(seen).toEqual(['http://ghe.corp:8443/api/v3/repos/o/r/releases/tags/v1']);
    expect(await resolveGithubReleaseAssetApiUrl('https://ghe.corp/o/r/releases/download/v1/pkg.zip', openFn(release([])))).toBeNull();
    expect(await resolveGithubReleaseAssetApiUrl('https://ghe.corp:bad/o/r/releases/download/v1/p', openFn(release([])), { githubHosts: ['ghe.corp'] })).toBeNull();
    expect(await resolveGithubReleaseAssetApiUrl('https://[not-an-ip]/o/r/releases/download/v1/p', openFn(release([])), { githubHosts: ['*'] })).toBeNull();
  });
  test('GHES wildcard does not match bare host', async () => {
    expect(await resolveGithubReleaseAssetApiUrl('https://corp/o/r/releases/download/v1/p.zip', openFn(release([])), { githubHosts: ['*.corp'] })).toBeNull();
  });
  test('GHES IPv6 api base and origin normalization', async () => {
    const seen: string[] = [];
    const asset = 'https://[0:0:0:0:0:0:0:1]/api/v3/repos/o/r/releases/assets/3';
    const got = await resolveGithubReleaseAssetApiUrl(
      'https://[::1]/o/r/releases/download/v1/p.zip',
      openFn(release([{ name: 'p.zip', url: asset }]), seen),
      { githubHosts: ['::1'] },
    );
    expect(seen).toEqual(['https://[::1]/api/v3/repos/o/r/releases/tags/v1']);
    expect(got).toBe(asset);
  });
  test('fnmatch', () => {
    expect(fnmatch('a.corp', '*.corp')).toBe(true);
    expect(fnmatch('corp', '*.corp')).toBe(false);
    expect(fnmatch('ab', 'a?')).toBe(true);
    expect(fnmatch('ac', 'a[!b]')).toBe(true);
  });
});
