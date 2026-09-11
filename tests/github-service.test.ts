import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitService } from '../src/main/git/service';
import { GitRunner } from '../src/main/git/runner';
import { parseCommandArgs } from '../src/shared/validation';
import type { AppEvent } from '../src/shared/api';

const exec = promisify(execFile);
let root: string;
let service: ReturnType<typeof createGitService>;
let env: NodeJS.ProcessEnv;
let calls: { url: string; method: string; body: unknown }[];
let events: AppEvent[];
const token = 'ghp_DisposableFixtureNotARealSecret12345';
const remoteData = (name: string) => ({
  id: 1, name, full_name: `fixture/${name}`, owner: { login: 'fixture' },
  description: 'Disposable fixture', private: true, archived: false, default_branch: 'main',
  updated_at: '2026-06-01T12:00:00Z', permissions: { push: true },
});
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd, env })).stdout.trimEnd();
}
async function seed(name = 'local') {
  const repo = await service.handlers.initRepository({ parentPath: root, name, defaultBranch: 'main' });
  await service.handlers.setIdentity({ repoId: repo.id, name: 'Fixture', email: 'fixture@example.invalid' });
  await writeFile(path.join(repo.path, 'README.txt'), 'Private fixture\n');
  await service.handlers.stage({ repoId: repo.id, paths: ['README.txt'], stage: true });
  await service.handlers.commit({ repoId: repo.id, summary: 'Initial', description: '', amend: false });
  return repo;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(process.cwd(), '.gitdesk-github-tests-'));
  await mkdir(path.join(root, 'home'));
  await mkdir(path.join(root, 'remotes'));
  await writeFile(path.join(root, 'gitconfig'), '');
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'home', 'config'));
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|PREFIX)$/.test(key)) delete env[key];
  }
  await git(root, 'config', '--global', `url.${path.join(root, 'remotes')}/.insteadOf`, 'https://github.com/fixture/');
  calls = [];
  events = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.github.com') throw new Error('Unexpected external request');
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: url.href, method: init?.method ?? 'GET', body });
    if (url.pathname === '/user') return Response.json({ login: 'fixture', name: 'Fixture' });
    if (url.pathname === '/user/repos' && init?.method === 'POST') {
      if (!body || typeof body !== 'object' || !('name' in body) || typeof body.name !== 'string') throw new Error('Invalid create request');
      await git(root, 'init', '--bare', '--initial-branch=main', '--', path.join(root, 'remotes', `${body.name}.git`));
      return Response.json(remoteData(body.name));
    }
    const name = url.pathname.split('/').at(-1)!;
    return Response.json(remoteData(name));
  };
  service = createGitService({ dataDir: path.join(root, 'data'), github: { fetch: fetcher }, onEvent: event => events.push(event) });
});
afterEach(async () => {
  await service.dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('GitHub repository workflows in disposable local Git fixtures', () => {
  it('makes no provider requests on app startup and requires confirmation before remote creation', async () => {
    await service.handlers.getAppState({});
    expect((await service.handlers.githubAccount({})).user).toBeNull();
    expect(calls).toEqual([]);
    await service.handlers.githubSignIn({ token, remember: false });
    await expect(service.handlers.githubCreate({ name: 'private', description: '', confirmed: false })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(calls).toHaveLength(1);
    const created = await service.handlers.githubCreate({ name: 'private', description: 'Private project', confirmed: true });
    expect(created.fullName).toBe('fixture/private');
    expect(calls[1].body).toEqual({ name: 'private', description: 'Private project', private: true, auto_init: false });
    expect(JSON.stringify(events)).not.toContain(token);
    expect(await readFile(path.join(root, 'data', 'state.json'), 'utf8').catch(() => '')).not.toContain(token);
  });

  it('publishes only the current branch, preserves local content, and clones the private repository', async () => {
    const local = await seed();
    await git(local.path, 'branch', 'not-published');
    await git(local.path, 'tag', 'not-published');
    await service.handlers.githubSignIn({ token, remember: false });
    const created = await service.handlers.githubPublish({ repoId: local.id, name: 'published', description: '', remote: 'origin', confirmed: true });
    expect(created.private).toBe(true);
    const bare = path.join(root, 'remotes', 'published.git');
    expect(await git(bare, 'show-ref', '--heads')).toBe(`${await git(local.path, 'rev-parse', 'HEAD')} refs/heads/main`);
    expect(await git(bare, 'tag', '-l')).toBe('');
    expect(await git(local.path, 'config', '--get', 'remote.origin.url')).toBe('https://github.com/fixture/published.git');
    expect((await service.handlers.status({ repoId: local.id })).upstream).toBe('origin/main');
    expect(await git(local.path, 'status', '--porcelain')).toBe('');
    const cloned = await service.handlers.githubClone({ fullName: created.fullName, parentPath: root, name: 'cloned Ω space' });
    expect(await readFile(path.join(cloned.path, 'README.txt'), 'utf8')).toBe('Private fixture\n');
    expect((await service.handlers.status({ repoId: cloned.id })).upstream).toBe('origin/main');
    await service.handlers.githubSignOut({});
    expect((await service.handlers.githubAccount({})).user).toBeNull();
    expect(await git(local.path, 'remote')).toBe('origin');
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('rejects dirty, unborn, detached, existing remote and existing upstream publication before POST', async () => {
    await service.handlers.githubSignIn({ token, remember: false });
    const local = await service.handlers.initRepository({ parentPath: root, name: 'empty', defaultBranch: 'main' });
    const publish = () => service.handlers.githubPublish({ repoId: local.id, name: 'blocked', description: '', remote: 'origin', confirmed: true });
    await expect(publish()).rejects.toMatchObject({ code: 'BRANCH_REQUIRED' });
    await service.handlers.setIdentity({ repoId: local.id, name: 'Fixture', email: 'fixture@example.invalid' });
    await writeFile(path.join(local.path, 'file'), 'data');
    await expect(publish()).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });
    await service.handlers.stage({ repoId: local.id, paths: ['file'], stage: true });
    await service.handlers.commit({ repoId: local.id, summary: 'Init', description: '', amend: false });
    await git(local.path, 'checkout', '--detach');
    await expect(publish()).rejects.toMatchObject({ code: 'BRANCH_REQUIRED' });
    await git(local.path, 'checkout', 'main');
    await service.handlers.remote({ repoId: local.id, action: 'add', name: 'origin', url: 'https://example.invalid/repo.git' });
    await expect(publish()).rejects.toMatchObject({ code: 'REMOTE_EXISTS' });
    await git(local.path, 'remote', 'remove', 'origin');
    await git(local.path, 'config', 'branch.main.remote', 'existing');
    await expect(publish()).rejects.toMatchObject({ code: 'UPSTREAM_EXISTS' });
    expect(calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('retains the new remote and reports partial publication when the push is rejected', async () => {
    const local = await seed();
    await service.handlers.githubSignIn({ token, remember: false });
    const original = GitRunner.prototype.run;
    vi.spyOn(GitRunner.prototype, 'run').mockImplementation(function (this: GitRunner, ...args) {
      if (args[1][0] === 'push') return Promise.reject(new Error('fixture push rejected'));
      return original.apply(this, args);
    });
    await expect(service.handlers.githubPublish({ repoId: local.id, name: 'partial', description: '', remote: 'github', confirmed: true })).rejects.toMatchObject({
      code: 'GITHUB_PUBLISH_INCOMPLETE', detail: expect.stringContaining('Local remote "github" was kept'),
    });
    expect(await git(local.path, 'config', '--get', 'remote.github.url')).toBe('https://github.com/fixture/partial.git');
    expect(await git(local.path, 'status', '--porcelain')).toBe('');
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });

  it('uses isolated account credentials for GitHub HTTPS clone, not another provider or after sign-out', async () => {
    const local = await seed();
    await service.handlers.githubSignIn({ token, remember: false });
    await service.handlers.githubPublish({ repoId: local.id, name: 'credentials', description: '', remote: 'origin', confirmed: true });
    const run = vi.spyOn(GitRunner.prototype, 'run');
    await service.handlers.cloneRepository({ url: 'https://github.com/fixture/credentials.git', parentPath: root, name: 'authenticated' });
    const authenticatedClone = run.mock.calls.find(call => call[1][0] === 'clone');
    expect(authenticatedClone?.[3]?.privateDiagnostics).toBe(true);
    expect(authenticatedClone?.[3]?.config).toContainEqual(['credential.helper', '']);
    expect(authenticatedClone?.[3]?.config).toContainEqual(['http.followRedirects', 'false']);
    expect(JSON.stringify(authenticatedClone)).not.toContain(token);
    expect(run.mock.calls.some(call => call[1][0] === 'credential' && call[1][1] === 'reject')).toBe(true);
    await service.handlers.githubSignOut({});
    run.mockClear();
    await service.handlers.cloneRepository({ url: 'https://github.com/fixture/credentials.git', parentPath: root, name: 'after-sign-out' });
    expect(run.mock.calls.find(call => call[1][0] === 'clone')?.[3]?.privateDiagnostics).toBe(false);
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('does not create a remote for malformed or unconfirmed publication IPC', async () => {
    const local = await seed();
    await expect(service.handlers.githubPublish({ repoId: local.id, name: 'safe', description: '', remote: 'origin', confirmed: false })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    const invalid: [string, object][] = [
      ['githubClone', { fullName: 'fixture/../../elsewhere', parentPath: root, name: 'bad' }],
      ['githubCreate', { name: '../evil', description: '', confirmed: true }],
      ['githubPublish', { repoId: local.id, name: 'safe', description: '', remote: '--upload-pack=bad', confirmed: true }],
      ['githubRepositories', { page: 0 }],
      ['githubSignIn', { token: 'secret\ninjection', remember: false }],
      ['githubOpenPage', { page: 'tokens', url: 'https://elsewhere.invalid' }],
    ];
    for (const [command, args] of invalid) {
      expect(() => parseCommandArgs(command as Parameters<typeof parseCommandArgs>[0], args)).toThrow();
    }
    expect(await git(local.path, 'remote')).toBe('');
    expect(calls).toEqual([]);
  });

  it('cancels publication for one repository without cancelling another queued GitHub operation', async () => {
    const local = await seed();
    await service.dispose();
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    const fetcher: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === '/user') return Response.json({ login: 'fixture', name: 'Fixture' });
      const body: unknown = JSON.parse(String(init?.body));
      if (!body || typeof body !== 'object' || !('name' in body) || typeof body.name !== 'string') throw new Error('Invalid request');
      if (body.name === 'cancelled') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('Cancelled fixture request')), { once: true });
          started();
        });
      }
      return Response.json(remoteData(body.name));
    };
    service = createGitService({ dataDir: path.join(root, 'data'), github: { fetch: fetcher } });
    await service.handlers.githubSignIn({ token, remember: false });
    const publishing = service.handlers.githubPublish({ repoId: local.id, name: 'cancelled', description: '', remote: 'origin', confirmed: true });
    const rejected = expect(publishing).rejects.toMatchObject({ code: 'CANCELLED' });
    await pending;
    const independent = service.handlers.githubCreate({ name: 'independent', description: '', confirmed: true });
    await service.handlers.cancel({ repoId: local.id });
    await rejected;
    expect((await independent).fullName).toBe('fixture/independent');
    expect(await git(local.path, 'remote')).toBe('');
  });
});
