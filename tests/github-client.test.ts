import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { GitHubClient, githubCloneUrl, githubUrlName, readCliToken, type GitHubOptions } from '../src/main/github/client';
import { GitHubVault, type SecretEncryption } from '../src/main/github/vault';
import { GitError, toAppError } from '../src/main/git/errors';

const token = 'fixture_token_only_1234567890';
const clientId = 'fixture_owned_oauth_client';
const user = { login: 'fixture', name: 'Fixture Developer' };
const now = new Date('2026-09-01T12:00:00.000Z');
const deviceCode = {
  device_code: 'fixture_device_secret', user_code: 'ABCD-1234',
  verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5,
};
const apiRepository = (name = 'private-project', owner = 'fixture') => ({
  id: 123, name, full_name: `${owner}/${name}`, owner: { login: owner },
  description: 'Private fixture', private: true, archived: false, default_branch: 'main',
  updated_at: '2026-09-01T11:00:00Z', permissions: { push: true },
});
const renderedRepository = {
  id: 123, name: 'private-project', fullName: 'fixture/private-project', owner: 'fixture',
  description: 'Private fixture', private: true, archived: false, canPush: true,
  defaultBranch: 'main', updatedAt: '2026-09-01T11:00:00Z',
};

// Reversible test adapter only; production encryption is supplied by the OS keychain.
const encryption: SecretEncryption = {
  available: () => true,
  encrypt: value => Buffer.from(Buffer.from(value).map(byte => byte ^ 0x5a)),
  decrypt: value => Buffer.from(value.map(byte => byte ^ 0x5a)).toString('utf8'),
};

let root: string;
let client: GitHubClient;
let clients: GitHubClient[];
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let networkGuard: MockInstance<typeof fetch>;

function deferredResult<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

function makeClient(options: Partial<GitHubOptions> = {}): GitHubClient {
  const instance = new GitHubClient({ dataDir: root, fetch: fetcher, ...options });
  clients.push(instance);
  return instance;
}

async function signIn(remember = false): Promise<void> {
  fetcher.mockResolvedValueOnce(Response.json(user));
  await client.signInToken(token, remember);
}

async function failure(operation: Promise<unknown>, code: string) {
  let error: unknown;
  try { await operation; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(GitError);
  expect(error).toMatchObject({ code });
  const rendered = toAppError(error);
  expect(JSON.stringify(rendered)).not.toContain(token);
  return rendered;
}

function request(index: number) {
  const [input, init] = fetcher.mock.calls[index];
  return { url: new URL(String(input)), init: init!, headers: new Headers(init?.headers) };
}

async function beginLogin(remember = false): Promise<void> {
  fetcher.mockResolvedValueOnce(Response.json(deviceCode));
  await client.beginLogin(clientId, remember);
}

function advance(milliseconds: number): void {
  vi.setSystemTime(Date.now() + milliseconds);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(process.cwd(), '.gitdesk-github-client-tests-'));
  vi.setSystemTime(now);
  networkGuard = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real network requests are forbidden in GitHub fixtures'));
  fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected fixture request'));
  clients = [];
  client = makeClient();
});

afterEach(async () => {
  await Promise.all(clients.map(instance => instance.dispose()));
  expect(networkGuard).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('GitHub account verification and local state', () => {
  it('starts and reads cached account status without making any network request', async () => {
    expect(fetcher).not.toHaveBeenCalled();
    expect(await client.status()).toEqual({
      user: null, source: null, remembered: false, canRemember: false, browserLoginConfigured: false,
    });
    await new GitHubVault(root, encryption).save({ token, user, source: 'token', expiresAt: null });
    const restored = makeClient({ encryption, clientId });
    const expected = { user, source: 'token', remembered: true, canRemember: true, browserLoginConfigured: true };
    expect(await restored.status()).toEqual(expected);
    expect(await restored.status()).toEqual(expected);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(expected)).not.toContain(token);
  });

  it('verifies the token at the fixed API before returning only public account fields', async () => {
    const logs = ['log', 'info', 'warn', 'error', 'debug'].map(method =>
      vi.spyOn(console, method as 'log').mockImplementation(() => undefined));
    fetcher.mockResolvedValueOnce(Response.json({ ...user, token, access_token: token, email: 'private@example.invalid' }));
    const state = await client.signInToken(token, false);
    expect(state).toEqual({ user, source: 'token', remembered: false, canRemember: false, browserLoginConfigured: false });
    expect(await client.status()).toEqual(state);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const sent = request(0);
    expect(sent.url.href).toBe('https://api.github.com/user');
    expect(sent.init).toMatchObject({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) });
    expect(sent.headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(sent.headers.get('accept')).toBe('application/vnd.github+json');
    expect(sent.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(sent.headers.get('user-agent')).toMatch(/^GitDesk\//);
    expect(JSON.stringify(state)).not.toContain(token);
    expect(JSON.stringify(logs.map(log => log.mock.calls))).not.toContain(token);
    expect(await readdir(root)).toEqual([]);
  });

  it('rejects a malformed account response without accepting or persisting the credential', async () => {
    client = makeClient({ encryption });
    fetcher.mockResolvedValueOnce(Response.json({ login: '../invalid', name: token }));
    await failure(client.signInToken(token, true), 'GITHUB_RESPONSE_INVALID');
    expect((await client.status()).user).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it('does not replace a valid account when verification of a replacement token fails', async () => {
    await signIn();
    fetcher.mockResolvedValueOnce(new Response(token, { status: 401 }));
    await failure(client.signInToken('fixture_replacement_token', false), 'GITHUB_AUTH_REQUIRED');
    expect((await client.status()).user).toEqual(user);
    expect(await client.credentials('https://github.com/fixture/private-project.git')).toEqual({ username: user.login, password: token });
  });

  it('refuses remembered sign-in without secure storage before contacting GitHub', async () => {
    await failure(client.signInToken(token, true), 'KEYCHAIN_UNAVAILABLE');
    await failure(client.beginLogin(clientId, true), 'KEYCHAIN_UNAVAILABLE');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('persists only encrypted account data and sign-out preserves unrelated application state', async () => {
    client = makeClient({ encryption });
    await writeFile(path.join(root, 'state.json'), '{"repositories":["keep-me"]}');
    await writeFile(path.join(root, 'unrelated.txt'), 'keep this file');
    await signIn(true);
    const bytes = await readFile(path.join(root, 'github-account.enc'));
    expect(bytes.toString('utf8')).not.toContain(token);
    expect(bytes.toString('utf8')).not.toContain(user.login);
    const restored = makeClient({ encryption });
    expect((await restored.status()).remembered).toBe(true);
    expect(await restored.credentials('https://github.com/fixture/private-project')).toEqual({ username: 'fixture', password: token });
    await restored.signOut();
    expect(await restored.status()).toMatchObject({ user: null, source: null, remembered: false });
    expect(await restored.credentials('https://github.com/fixture/private-project')).toBeNull();
    expect((await readdir(root)).sort()).toEqual(['state.json', 'unrelated.txt']);
    expect(await readFile(path.join(root, 'state.json'), 'utf8')).toBe('{"repositories":["keep-me"]}');
    expect(await readFile(path.join(root, 'unrelated.txt'), 'utf8')).toBe('keep this file');
    expect((await makeClient({ encryption }).status()).user).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('removes previously remembered credentials when switching to memory-only sign-in', async () => {
    client = makeClient({ encryption });
    await signIn(true);
    await signIn(false);
    expect(await readdir(root)).toEqual([]);
    expect(await client.status()).toMatchObject({ user, remembered: false });
    expect((await makeClient({ encryption }).status()).user).toBeNull();
  });

  it('allows sign-out to recover a corrupt saved account without decrypting it', async () => {
    await writeFile(path.join(root, 'github-account.enc'), 'corrupt fixture bytes');
    client = makeClient({ encryption });
    await failure(client.status(), 'ACCOUNT_STORAGE_FAILED');
    await client.signOut();
    expect((await client.status()).user).toBeNull();
    expect(await readdir(root)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not use expired remembered tokens for API requests or Git credentials', async () => {
    await new GitHubVault(root, encryption).save({ token, user, source: 'device', expiresAt: now.getTime() });
    client = makeClient({ encryption });
    expect(await client.status()).toMatchObject({ user: null, source: null });
    await failure(client.listRepositories(1), 'GITHUB_AUTH_REQUIRED');
    await failure(client.credentials('https://github.com/fixture/private-project'), 'GITHUB_AUTH_REQUIRED');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('GitHub HTTP failure handling', () => {
  it.each([
    [401, {}, 'GITHUB_AUTH_REQUIRED'],
    [403, {}, 'GITHUB_PERMISSION'],
    [403, { 'x-ratelimit-remaining': '0' }, 'GITHUB_RATE_LIMIT'],
    [429, {}, 'GITHUB_RATE_LIMIT'],
    [404, {}, 'GITHUB_NOT_FOUND'],
    [422, {}, 'GITHUB_VALIDATION'],
    [500, {}, 'GITHUB_REQUEST_FAILED'],
    [302, { location: 'https://elsewhere.invalid/steal' }, 'GITHUB_REQUEST_FAILED'],
  ] as const)('handles HTTP %s (%j) without exposing response bodies', async (status, headers, code) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from(`Authorization: Bearer ${token}`)); },
      cancel: vi.fn(),
    });
    const cancel = vi.spyOn(body, 'cancel');
    fetcher.mockResolvedValueOnce(new Response(body, { status, headers }));
    await failure(client.signInToken(token, false), code);
    expect(cancel).toHaveBeenCalledOnce();
    expect((await client.status()).user).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ['invalid JSON', () => new Response(`not JSON ${token}`), 'GITHUB_RESPONSE_INVALID'],
    ['empty body', () => new Response(null), 'GITHUB_RESPONSE_INVALID'],
    ['more than 4 MiB', () => new Response('x'.repeat(4 * 1024 * 1024 + 1)), 'GITHUB_RESPONSE_TOO_LARGE'],
  ] as const)('rejects %s without saving an account', async (_label, response, code) => {
    fetcher.mockResolvedValueOnce(response());
    await failure(client.signInToken(token, false), code);
    expect((await client.status()).user).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it('caps streamed responses by accumulated bytes and cancels the reader', async () => {
    const cancelled = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel: cancelled,
    });
    fetcher.mockResolvedValueOnce(new Response(body));
    await failure(client.signInToken(token, false), 'GITHUB_RESPONSE_TOO_LARGE');
    expect(cancelled).toHaveBeenCalledOnce();
    expect(chunks).toBeLessThanOrEqual(6);
  });

  it.each(['redirect refused', 'certificate verification failed'])('sanitizes transport errors: %s', async message => {
    fetcher.mockRejectedValueOnce(new TypeError(`${message}: ${token}`));
    await failure(client.signInToken(token, false), 'GITHUB_NETWORK_FAILED');
    expect(request(0).init.redirect).toBe('error');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('clears a rejected remembered session on authenticated requests', async () => {
    client = makeClient({ encryption });
    await signIn(true);
    fetcher.mockResolvedValueOnce(new Response(token, { status: 401 }));
    await failure(client.listRepositories(1), 'GITHUB_AUTH_REQUIRED');
    expect(await client.status()).toMatchObject({ user: null, source: null, remembered: false });
    expect(await readdir(root)).toEqual([]);
    await failure(client.listRepositories(2), 'GITHUB_AUTH_REQUIRED');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retains an authenticated session after permission or rate-limit errors', async () => {
    await signIn();
    for (const [status, code] of [[403, 'GITHUB_PERMISSION'], [429, 'GITHUB_RATE_LIMIT']] as const) {
      fetcher.mockResolvedValueOnce(new Response(token, { status }));
      await failure(client.listRepositories(1), code);
      expect((await client.status()).user).toEqual(user);
    }
  });
});

describe('GitHub repository API', () => {
  it('requires authentication before listing, inspecting, or creating repositories', async () => {
    await failure(client.listRepositories(1), 'GITHUB_AUTH_REQUIRED');
    await failure(client.getRepository('fixture/private-project'), 'GITHUB_AUTH_REQUIRED');
    await failure(client.createRepository('private-project', '', true), 'GITHUB_AUTH_REQUIRED');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requests pages of 50 including private and organizational repositories without following Link URLs', async () => {
    await signIn();
    const entries = Array.from({ length: 50 }, (_, index) => ({
      ...apiRepository(`project-${index}`, index % 2 ? 'organization' : 'fixture'),
      id: index + 1, private: index % 2 === 0,
    }));
    fetcher.mockResolvedValueOnce(Response.json(entries, {
      headers: { link: '<https://elsewhere.invalid/steal?secret=1>; rel="next", <https://api.github.com/user/repos?page=99>; rel="last"' },
    }));
    const firstPage = await client.listRepositories(1);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.repositories).toHaveLength(50);
    expect(firstPage.repositories[0]).toMatchObject({ owner: 'fixture', private: true, fullName: 'fixture/project-0' });
    expect(firstPage.repositories[1]).toMatchObject({ owner: 'organization', private: false, fullName: 'organization/project-1' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(Response.json([apiRepository()], {
      headers: { link: '<https://elsewhere.invalid/back>; rel="prev"' },
    }));
    expect(await client.listRepositories(2)).toEqual({ repositories: [renderedRepository], hasMore: false });
    for (const [index, page] of [[1, '1'], [2, '2']] as const) {
      const sent = request(index);
      expect(sent.url.origin).toBe('https://api.github.com');
      expect(sent.url.pathname).toBe('/user/repos');
      expect(Object.fromEntries(sent.url.searchParams)).toEqual({
        visibility: 'all', affiliation: 'owner,collaborator,organization_member',
        sort: 'updated', direction: 'desc', per_page: '50', page,
      });
      expect(sent.headers.get('authorization')).toBe(`Bearer ${token}`);
      expect(sent.init.redirect).toBe('error');
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('rejects pages exceeding 50 items and internally inconsistent repository identities', async () => {
    await signIn();
    for (const body of [
      Array.from({ length: 51 }, () => apiRepository()),
      [{ ...apiRepository(), full_name: 'another-owner/private-project' }],
      [{ ...apiRepository(), owner: { login: '../invalid' } }],
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(body));
      await failure(client.listRepositories(1), 'GITHUB_RESPONSE_INVALID');
    }
  });

  it('maps repository details and defaults missing push permission to false', async () => {
    await signIn();
    fetcher.mockResolvedValueOnce(Response.json({ ...apiRepository(), permissions: undefined, token, html_url: `https://elsewhere.invalid/${token}` }));
    const result = await client.getRepository('fixture/private-project');
    expect(result).toEqual({ ...renderedRepository, canPush: false });
    expect(request(1).url.href).toBe('https://api.github.com/repos/fixture/private-project');
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('rejects a repository response for a different owner/name than requested', async () => {
    await signIn();
    fetcher.mockResolvedValueOnce(Response.json(apiRepository('another-project', 'another-owner')));
    await failure(client.getRepository('fixture/private-project'), 'GITHUB_RESPONSE_INVALID');
  });

  it('requires confirmation before a private-only personal repository creation', async () => {
    expect(() => client.createRepository('private-project', '', false)).toThrowError(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }));
    expect(fetcher).not.toHaveBeenCalled();
    await signIn();
    fetcher.mockResolvedValueOnce(Response.json(apiRepository(), { status: 201 }));
    expect(await client.createRepository('private-project', 'Private fixture', true)).toEqual(renderedRepository);
    const sent = request(1);
    expect(sent.url.href).toBe('https://api.github.com/user/repos');
    expect(sent.init.method).toBe('POST');
    expect(JSON.parse(String(sent.init.body))).toEqual({
      name: 'private-project', description: 'Private fixture', private: true, auto_init: false,
    });
    expect(sent.headers.get('content-type')).toBe('application/json');
  });

  it.each([
    ['public', { ...apiRepository(), private: false }, 'GITHUB_CREATE_UNEXPECTED'],
    ['organization-owned', apiRepository('private-project', 'organization'), 'GITHUB_CREATE_UNEXPECTED'],
    ['different name', apiRepository('different-name'), 'GITHUB_CREATE_UNEXPECTED'],
    ['inconsistent identity', { ...apiRepository(), full_name: 'fixture/different-name' }, 'GITHUB_RESPONSE_INVALID'],
  ] as const)('rejects a %s creation response without retrying', async (_label, response, code) => {
    await signIn();
    fetcher.mockResolvedValueOnce(Response.json(response, { status: 201 }));
    await failure(client.createRepository('private-project', '', true), code);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('accepts case-insensitive canonical names returned by GitHub', async () => {
    await signIn();
    fetcher.mockResolvedValueOnce(Response.json(apiRepository('Private-Project', 'Fixture')));
    expect(await client.createRepository('private-project', '', true)).toMatchObject({
      fullName: 'Fixture/Private-Project', private: true,
    });
  });

  it.each(['.github', '-private-project'])('preserves the valid leading punctuation in repository %s', async name => {
    await signIn();
    fetcher.mockResolvedValueOnce(Response.json(apiRepository(name)));
    expect(await client.getRepository(`fixture/${name}`)).toMatchObject({ name, fullName: `fixture/${name}` });
    expect(request(1).url.href).toBe(`https://api.github.com/repos/fixture/${name}`);
    fetcher.mockResolvedValueOnce(Response.json(apiRepository(name), { status: 201 }));
    expect(await client.createRepository(name, '', true)).toMatchObject({ name, private: true });
    expect(request(2).url.href).toBe('https://api.github.com/user/repos');
    expect(JSON.parse(String(request(2).init.body))).toEqual({ name, description: '', private: true, auto_init: false });
  });

  it.each(['../project', 'fixture/../../evil', 'https://elsewhere.invalid/repo', '//elsewhere.invalid/repo', 'fixture/repo?token=bad', 'fixture/repo%2fother'])(
    'does not issue requests for invalid repository identity %s', async fullName => {
      await signIn();
      await expect(client.getRepository(fullName)).rejects.toThrow();
      expect(() => githubCloneUrl(fullName)).toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(['../project', '.', '..', 'repo?private=false', '--name/repo'])('validates create name %s before POST', async name => {
    await signIn();
    await expect(client.createRepository(name, '', true)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('GitHub clone URL and credential boundaries', () => {
  it.each(['fixture/repo', 'Some-Owner/repo.name_1-2', 'fixture/.github', 'fixture/-private-project'])('builds a fixed-host HTTPS clone URL for %s', fullName => {
    expect(githubCloneUrl(fullName)).toBe(`https://github.com/${fullName}.git`);
  });

  it.each([
    ['https://github.com/fixture/repo', 'fixture/repo'],
    ['https://github.com/fixture/repo.git', 'fixture/repo'],
    ['https://github.com/fixture/repo.git/', 'fixture/repo'],
    ['https://github.com/Some-Owner/repo.name_1-2', 'Some-Owner/repo.name_1-2'],
    ['https://github.com/fixture/.github.git', 'fixture/.github'],
    ['https://github.com/fixture/-private-project.git', 'fixture/-private-project'],
  ])('recognizes a safe clone URL %s', (url, fullName) => {
    expect(githubUrlName(url)).toBe(fullName);
  });

  it.each([
    'http://github.com/fixture/repo', 'ssh://git@github.com/fixture/repo',
    'git@github.com:fixture/repo.git', 'https://github.com.evil.invalid/fixture/repo',
    'https://api.github.com/fixture/repo', 'https://github.com:444/fixture/repo',
    'https://user:password@github.com/fixture/repo', 'https://user@github.com/fixture/repo',
    'https://github.com/fixture/repo?token=secret', 'https://github.com/fixture/repo#fragment',
    'https://github.com/fixture/repo/issues', 'https://github.com/fixture',
    'https://github.com/fixture/repo%0a', 'https://github.com/fixture/repo%2fother',
    'https://github.com/fixture\\repo', ' https://github.com/fixture/repo',
    'https://github.com/fixture/repo\n', 'not a URL',
  ])('never supplies credentials to unsafe or non-GitHub URL %s', async url => {
    await signIn();
    expect(githubUrlName(url)).toBeNull();
    expect(await client.credentials(url)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('GitHub device OAuth', () => {
  it.each([undefined, 'short', 'client id with spaces', 'https://elsewhere.invalid/client'])(
    'has no borrowed/default OAuth ID and refuses invalid setup %s', async id => {
      await failure(client.beginLogin(id, false), 'GITHUB_OAUTH_SETUP');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'fixture_override_client'])('uses only the configured or explicitly supplied client ID: %s', async override => {
    client = makeClient({ clientId });
    fetcher.mockResolvedValueOnce(Response.json(deviceCode));
    const result = await client.beginLogin(override, false);
    expect(result).toEqual({
      userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device',
      expiresAt: new Date(now.getTime() + 900_000).toISOString(), intervalSeconds: 5,
    });
    expect(JSON.stringify(result)).not.toContain(deviceCode.device_code);
    const sent = request(0);
    expect(sent.url.href).toBe('https://github.com/login/device/code');
    expect(sent.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(sent.init.body))).toEqual({ client_id: override ?? clientId, scope: 'repo read:user' });
    expect(sent.headers.get('accept')).toBe('application/json');
    expect(sent.headers.has('authorization')).toBe(false);
    expect(sent.headers.has('x-github-api-version')).toBe(false);
  });

  it.each([
    { verification_uri: 'https://elsewhere.invalid/login' },
    { interval: 0 }, { expires_in: 3601 }, { user_code: '<script>' },
  ])('rejects invalid device code data %j', async override => {
    fetcher.mockResolvedValueOnce(Response.json({ ...deviceCode, ...override }));
    await failure(client.beginLogin(clientId, false), 'GITHUB_RESPONSE_INVALID');
    await failure(client.pollLogin(), 'GITHUB_LOGIN_MISSING');
  });

  it('does not poll early, honors pending and slowdown intervals, then verifies the granted token', async () => {
    await beginLogin();
    expect(await client.pollLogin()).toEqual({ state: 'pending', intervalSeconds: 5 });
    expect(fetcher).toHaveBeenCalledOnce();
    advance(4_100);
    expect(await client.pollLogin()).toEqual({ state: 'pending', intervalSeconds: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
    advance(900);
    fetcher.mockResolvedValueOnce(Response.json({ error: 'authorization_pending' }));
    expect(await client.pollLogin()).toEqual({ state: 'pending', intervalSeconds: 5 });
    expect(request(1).url.href).toBe('https://github.com/login/oauth/access_token');
    expect(JSON.parse(String(request(1).init.body))).toEqual({
      client_id: clientId, device_code: deviceCode.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    advance(5_000);
    fetcher.mockResolvedValueOnce(Response.json({ error: 'slow_down' }));
    expect(await client.pollLogin()).toEqual({ state: 'pending', intervalSeconds: 10 });
    advance(5_000);
    expect(await client.pollLogin()).toEqual({ state: 'pending', intervalSeconds: 5 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    advance(5_000);
    fetcher.mockResolvedValueOnce(Response.json({ access_token: token }));
    fetcher.mockResolvedValueOnce(Response.json(user));
    const completed = await client.pollLogin();
    expect(completed).toEqual({
      state: 'complete', intervalSeconds: 0,
      account: { user, source: 'device', remembered: false, canRemember: false, browserLoginConfigured: false },
    });
    expect(request(4).url.href).toBe('https://api.github.com/user');
    expect(request(4).headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(JSON.stringify(completed)).not.toContain(token);
    expect(JSON.stringify(completed)).not.toContain(deviceCode.device_code);
    await failure(client.pollLogin(), 'GITHUB_LOGIN_MISSING');
  });

  it.each(['access_denied', 'expired_token', 'incorrect_device_code'])('ends device login after %s', async error => {
    await beginLogin();
    advance(5_000);
    fetcher.mockResolvedValueOnce(Response.json({ error, error_description: token }));
    await failure(client.pollLogin(), 'GITHUB_LOGIN_DENIED');
    await failure(client.pollLogin(), 'GITHUB_LOGIN_MISSING');
    expect((await client.status()).user).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('expires a code at its deadline without polling the provider', async () => {
    await beginLogin();
    advance(900_000);
    await failure(client.pollLogin(), 'GITHUB_LOGIN_EXPIRED');
    await failure(client.pollLogin(), 'GITHUB_LOGIN_MISSING');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([{}, { access_token: token, error: 'authorization_pending' }, { access_token: 'bad token' }])(
    'rejects ambiguous or malformed OAuth token responses %j', async response => {
      await beginLogin();
      advance(5_000);
      fetcher.mockResolvedValueOnce(Response.json(response));
      await failure(client.pollLogin(), 'GITHUB_RESPONSE_INVALID');
      expect((await client.status()).user).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it('requires user verification after OAuth grant and stores nothing if verification fails', async () => {
    client = makeClient({ encryption });
    await beginLogin(true);
    advance(5_000);
    fetcher.mockResolvedValueOnce(Response.json({ access_token: token }));
    fetcher.mockResolvedValueOnce(new Response(token, { status: 401 }));
    await failure(client.pollLogin(), 'GITHUB_AUTH_REQUIRED');
    expect((await client.status()).user).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it('remembers OAuth expiry and refuses expired tokens without a background refresh', async () => {
    client = makeClient({ encryption });
    await beginLogin(true);
    advance(5_000);
    fetcher.mockResolvedValueOnce(Response.json({ access_token: token, expires_in: 30 }));
    fetcher.mockResolvedValueOnce(Response.json(user));
    expect((await client.pollLogin()).account).toMatchObject({ user, source: 'device', remembered: true });
    const restored = makeClient({ encryption });
    expect((await restored.status()).user).toEqual(user);
    advance(29_999);
    expect(await restored.credentials('https://github.com/fixture/private-project.git')).toEqual({ username: 'fixture', password: token });
    advance(1);
    expect((await restored.status()).user).toBeNull();
    expect((await client.status()).user).toBeNull();
    await failure(restored.credentials('https://github.com/fixture/private-project.git'), 'GITHUB_AUTH_REQUIRED');
    await failure(restored.listRepositories(1), 'GITHUB_AUTH_REQUIRED');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('cancels an unused device code without a network request', async () => {
    await beginLogin();
    client.cancelLogin();
    advance(5_000);
    await failure(client.pollLogin(), 'GITHUB_LOGIN_MISSING');
    expect((await client.status()).user).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('keeps unrelated API requests and queued status reads running when device login is cancelled', async () => {
    await signIn();
    await beginLogin();
    const started = deferredResult<void>();
    const deferred = deferredResult<Response>();
    fetcher.mockImplementationOnce(async () => { started.resolve(); return deferred.promise; });
    const listing = client.listRepositories(1);
    await started.promise;
    const queuedStatus = client.status();
    client.cancelLogin();
    expect(request(2).init.signal?.aborted).toBe(false);
    deferred.resolve(Response.json([apiRepository()]));
    expect(await listing).toEqual({ repositories: [renderedRepository], hasMore: false });
    expect(await queuedStatus).toMatchObject({ user, source: 'token' });
    await failure(client.pollLogin(), 'GITHUB_LOGIN_MISSING');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(['device response', 'OAuth token response', 'user verification'])(
    'does not log in when cancelled concurrently with the %s', async stage => {
      client = makeClient({ encryption });
      if (stage !== 'device response') { await beginLogin(true); advance(5_000); }
      if (stage === 'user verification') fetcher.mockResolvedValueOnce(Response.json({ access_token: token }));
      const started = deferredResult<void>();
      const deferred = deferredResult<Response>();
      fetcher.mockImplementationOnce(async () => { started.resolve(); return deferred.promise; });
      const operation = stage === 'device response' ? client.beginLogin(clientId, true) : client.pollLogin();
      const checked = failure(operation, 'CANCELLED');
      await started.promise;
      const signal = request(fetcher.mock.calls.length - 1).init.signal!;
      client.cancelLogin();
      expect(signal.aborted).toBe(true);
      deferred.resolve(Response.json(stage === 'device response' ? deviceCode : stage === 'OAuth token response' ? { access_token: token } : user));
      await checked;
      expect((await client.status()).user).toBeNull();
      expect(await readdir(root)).toEqual([]);
    },
  );
});

describe('GitHub cancellation and CLI import', () => {
  it('maps an aborted fetch to cancellation rather than exposing the transport error', async () => {
    const started = deferredResult<void>();
    fetcher.mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error(`Transport aborted with ${token}`)), { once: true });
      started.resolve();
    }));
    const signingIn = failure(client.signInToken(token, false), 'CANCELLED');
    await started.promise;
    client.cancel();
    await signingIn;
    expect((await client.status()).user).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it('cancels an in-flight sign-in and its queued operations even if fetch ignores abort', async () => {
    client = makeClient({ encryption });
    const started = deferredResult<void>();
    const deferred = deferredResult<Response>();
    fetcher.mockImplementationOnce(async () => { started.resolve(); return deferred.promise; });
    const signingIn = failure(client.signInToken(token, true), 'CANCELLED');
    await started.promise;
    const queued = failure(client.listRepositories(1), 'CANCELLED');
    client.cancel();
    expect(request(0).init.signal?.aborted).toBe(true);
    deferred.resolve(Response.json(user));
    await Promise.all([signingIn, queued]);
    expect((await client.status()).user).toBeNull();
    expect(await readdir(root)).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not leave an authenticated account when disposed during verification', async () => {
    const started = deferredResult<void>();
    const deferred = deferredResult<Response>();
    fetcher.mockImplementationOnce(async () => { started.resolve(); return deferred.promise; });
    const signingIn = failure(client.signInToken(token, false), 'CANCELLED');
    await started.promise;
    const disposal = client.dispose();
    deferred.resolve(Response.json(user));
    await Promise.all([signingIn, disposal]);
    await failure(client.status(), 'CANCELLED');
    expect(await readdir(root)).toEqual([]);
  });

  it('imports using only the injected CLI adapter and verifies its returned credential', async () => {
    const importCli = vi.fn<(signal: AbortSignal) => Promise<string>>().mockResolvedValue(token);
    client = makeClient({ importCli });
    fetcher.mockResolvedValueOnce(Response.json(user));
    expect(await client.importCli(false)).toMatchObject({ user, source: 'cli', remembered: false });
    expect(importCli).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal));
    expect(request(0).url.href).toBe('https://api.github.com/user');
    expect(request(0).headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(await readdir(root)).toEqual([]);
  });

  it('does not accept an imported CLI credential rejected by GitHub', async () => {
    const importCli = vi.fn<(signal: AbortSignal) => Promise<string>>().mockResolvedValue(token);
    client = makeClient({ importCli, encryption });
    fetcher.mockResolvedValueOnce(new Response(token, { status: 401 }));
    await failure(client.importCli(true), 'GITHUB_AUTH_REQUIRED');
    expect(importCli).toHaveBeenCalledOnce();
    expect((await client.status()).user).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it('does not accept a late CLI import result after cancellation', async () => {
    const started = deferredResult<void>();
    const deferred = deferredResult<string>();
    const importCli = vi.fn(async (_signal: AbortSignal) => { started.resolve(); return deferred.promise; });
    client = makeClient({ importCli });
    fetcher.mockResolvedValueOnce(Response.json(user));
    const importing = failure(client.importCli(false), 'CANCELLED');
    await started.promise;
    client.cancel();
    expect(importCli.mock.calls[0][0].aborted).toBe(true);
    deferred.resolve(token);
    await importing;
    expect((await client.status()).user).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('propagates a CLI-unavailable result without contacting GitHub', async () => {
    client = makeClient({ importCli: async () => { throw new GitError('GITHUB_CLI_UNAVAILABLE', 'No fixture CLI account'); } });
    await failure(client.importCli(false), 'GITHUB_CLI_UNAVAILABLE');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('real CLI adapter with an isolated fake gh executable', () => {
  async function fakeGh(source: string): Promise<void> {
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    await mkdir(bin);
    await mkdir(home);
    const executable = path.join(bin, 'gh');
    await writeFile(executable, `#!${process.execPath}\n${source}\n`);
    await chmod(executable, 0o700);
    vi.stubEnv('PATH', bin);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('XDG_CONFIG_HOME', home);
    vi.stubEnv('TMPDIR', root);
    vi.stubEnv('TMP', root);
    vi.stubEnv('TEMP', root);
    vi.stubEnv('NODE_OPTIONS', '');
  }

  it('passes the fixed hostname arguments, removes credential/config/debug overrides, and disables prompts', async () => {
    const forbidden = [
      'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
      'GH_CONFIG_DIR', 'GH_HOST', 'GH_DEBUG', 'GH_HTTP_UNIX_SOCKET', 'DEBUG',
    ];
    for (const name of forbidden) vi.stubEnv(name, 'fixture_override_must_not_reach_cli');
    const evidence = path.join(root, 'cli-evidence.json');
    await fakeGh(`
      import('node:fs').then(fs => {
        const keys = ${JSON.stringify([...forbidden, 'GH_PROMPT_DISABLED', 'GH_NO_UPDATE_NOTIFIER', 'HOME', 'PATH'])};
        fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({
          args: process.argv.slice(2),
          env: Object.fromEntries(keys.filter(key => key in process.env).map(key => [key, process.env[key]]))
        }));
        process.stdout.write(${JSON.stringify(`\n${token}\n`)});
      });
    `);
    expect(await readCliToken(new AbortController().signal)).toBe(token);
    const result = JSON.parse(await readFile(evidence, 'utf8'));
    expect(result.args).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(result.env).toEqual({
      GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', HOME: path.join(root, 'home'), PATH: path.join(root, 'bin'),
    });
    for (const name of forbidden) expect(process.env[name]).toBe('fixture_override_must_not_reach_cli');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid output', `process.stdout.write('invalid token with spaces');`],
    ['oversized output', `process.stdout.write('a'.repeat(9000));`],
    ['failure status', `process.stderr.write(${JSON.stringify(token)}); process.exitCode = 1;`],
  ])('reports %s without exposing child output', async (_label, source) => {
    await fakeGh(source);
    await failure(readCliToken(new AbortController().signal), 'GITHUB_CLI_UNAVAILABLE');
  });

  it('reports a missing CLI rather than using the real machine login', async () => {
    const bin = path.join(root, 'empty-bin');
    await mkdir(bin);
    vi.stubEnv('PATH', bin);
    await failure(readCliToken(new AbortController().signal), 'GITHUB_CLI_UNAVAILABLE');
  });

  it('honors a pre-cancelled CLI import', async () => {
    await fakeGh(`setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    controller.abort();
    await failure(readCliToken(controller.signal), 'CANCELLED');
  });
});
