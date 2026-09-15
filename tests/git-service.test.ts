import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGitService, GitError, toAppError } from '../src/main/git/service';
import type { AppEvent, GitHandlers, Repository } from '../src/shared/api';

let scratch: string;
let root: string;
let service: ReturnType<typeof createGitService>;
let handlers: GitHandlers;
let events: AppEvent[];
let gitEnv: NodeJS.ProcessEnv;

async function git(cwd: string, args: string[], allowedCodes = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.test', ...args], { cwd, env: gitEnv, shell: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (allowedCodes.includes(code ?? -1)) resolve(Buffer.concat(out).toString('utf8').replace(/\n$/, ''));
      else reject(new Error(`Fixture git ${args[0]} exited ${code}: ${Buffer.concat(err).toString('utf8')}`));
    });
    child.stdin.end();
  });
}

async function repository(name = 'repo'): Promise<Repository> {
  const repo = await handlers.initRepository({ parentPath: root, name, defaultBranch: 'main' });
  await handlers.setIdentity({ repoId: repo.id, name: 'Test Author', email: 'test@example.test' });
  return repo;
}

async function put(repo: Repository, filename: string, content: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(repo.path, filename)), { recursive: true });
  await writeFile(path.join(repo.path, filename), content);
}

async function commit(repo: Repository, summary: string, files: Record<string, string> = { 'file.txt': `${summary}\n` }): Promise<string> {
  for (const [filename, content] of Object.entries(files)) await put(repo, filename, content);
  await handlers.stage({ repoId: repo.id, paths: Object.keys(files), stage: true });
  await handlers.commit({ repoId: repo.id, summary, description: '', amend: false });
  return git(repo.path, ['rev-parse', 'HEAD']);
}

async function bare(name = 'remote.git'): Promise<string> {
  const destination = path.join(root, name);
  await git(root, ['init', '--bare', '--initial-branch=main', '--', destination]);
  return destination;
}

async function connected(): Promise<{ local: Repository; other: Repository; remote: string }> {
  const local = await repository('local');
  await commit(local, 'Initial');
  const remote = await bare();
  await handlers.remote({ repoId: local.id, action: 'add', name: 'origin', url: remote });
  await handlers.network({ repoId: local.id, action: 'push' });
  const other = await handlers.cloneRepository({ url: remote, parentPath: root, name: 'other' });
  await handlers.setIdentity({ repoId: other.id, name: 'Other Author', email: 'other@example.test' });
  return { local, other, remote };
}

beforeAll(async () => {
  // Keep os.tmpdir() fixtures inside our explicitly created workspace, never the shared system /tmp.
  scratch = await mkdtemp(path.join(process.cwd(), '.gitdesk-tests-'));
});

beforeEach(async () => {
  vi.stubEnv('TMPDIR', scratch);
  vi.stubEnv('TMP', scratch);
  vi.stubEnv('TEMP', scratch);
  root = await mkdtemp(path.join(tmpdir(), 'case-'));
  await mkdir(path.join(root, 'home'));
  await writeFile(path.join(root, 'global.config'), '');
  await writeFile(path.join(root, 'system.config'), '');
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'home', 'config'));
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'global.config'));
  vi.stubEnv('GIT_CONFIG_SYSTEM', path.join(root, 'system.config'));
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  gitEnv = { ...process.env };
  for (const key of Object.keys(gitEnv)) {
    if (/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|PREFIX)$/.test(key)) delete gitEnv[key];
  }
  events = [];
  service = createGitService({ dataDir: path.join(root, 'data'), onEvent: (event) => events.push(event) });
  handlers = service.handlers;
});

afterEach(async () => {
  await service.dispose();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

describe('GitDesk repository lifecycle and persistence', () => {
  it('initializes, canonicalizes aliases, supports linked worktrees, and preserves local data on removal', async () => {
    const repo = await repository();
    const initial = await handlers.status({ repoId: repo.id });
    expect(initial).toMatchObject({ unborn: true, detached: false, head: null, branch: 'main', files: [] });
    expect(await handlers.branches({ repoId: repo.id })).toEqual([{ name: 'main', current: true, remote: false, upstream: null }]);
    expect(await handlers.history({ repoId: repo.id, skip: 0, limit: 20, search: '' })).toEqual({ commits: [], hasMore: false });
    await mkdir(path.join(repo.path, 'nested'));
    await symlink(repo.path, path.join(root, 'alias'), 'dir');
    expect((await handlers.addRepository({ path: path.join(root, 'alias', 'nested') })).id).toBe(repo.id);
    await expect(handlers.initRepository({ parentPath: root, name: 'repo', defaultBranch: 'main' })).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' });
    await expect(handlers.addRepository({ path: await bare() })).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
    await commit(repo, 'Root');
    await git(repo.path, ['worktree', 'add', '-b', 'linked', '--', path.join(root, 'linked')]);
    const linked = await handlers.addRepository({ path: path.join(root, 'linked') });
    expect(await service.repositoryPath(linked.id)).toBe(linked.path);
    expect((await handlers.status({ repoId: linked.id })).branch).toBe('linked');
    await handlers.setPreferences({ theme: 'dark', defaultBranch: 'trunk' });
    await handlers.selectRepository({ repoId: repo.id });
    await service.dispose();
    service = createGitService({ dataDir: path.join(root, 'data') });
    handlers = service.handlers;
    expect(await handlers.getAppState({})).toMatchObject({ theme: 'dark', defaultBranch: 'trunk', selectedRepoId: repo.id, repositories: [repo, linked] });
    expect((await readdir(path.join(root, 'data'))).filter((file) => file.startsWith('.state-'))).toEqual([]);
    await handlers.removeRepository({ repoId: repo.id });
    expect(await readFile(path.join(repo.path, 'file.txt'), 'utf8')).toBe('Root\n');
    await expect(service.repositoryPath(repo.id)).rejects.toMatchObject({ code: 'REPOSITORY_NOT_REGISTERED' });
    await rm(linked.path, { recursive: true });
    await expect(handlers.status({ repoId: linked.id })).rejects.toMatchObject({ code: 'REPOSITORY_MISSING' });
    await handlers.removeRepository({ repoId: linked.id });
    expect((await handlers.getAppState({})).repositories).toEqual([]);
  });

  it('clones into a new child, reads identity without changing Git configuration, and updates it locally only', async () => {
    const repo = await handlers.initRepository({ parentPath: root, name: 'identity', defaultBranch: 'trunk' });
    const before = await readFile(path.join(repo.path, '.git', 'config'), 'utf8');
    expect(await handlers.getRepoSettings({ repoId: repo.id })).toEqual({ name: '', email: '', remotes: [] });
    expect(await readFile(path.join(repo.path, '.git', 'config'), 'utf8')).toBe(before);
    await handlers.setIdentity({ repoId: repo.id, name: 'Unicode Ω', email: 'person@example.test' });
    expect(await git(repo.path, ['config', '--local', '--get', 'user.name'])).toBe('Unicode Ω');
    expect(await readFile(path.join(root, 'global.config'), 'utf8')).toBe('');
    await commit(repo, 'Initial');
    const cloned = await handlers.cloneRepository({ url: repo.path, parentPath: root, name: 'cloned' });
    expect((await handlers.status({ repoId: cloned.id })).branch).toBe('trunk');
    expect(await readFile(path.join(cloned.path, 'file.txt'), 'utf8')).toBe('Initial\n');
    await expect(handlers.cloneRepository({ url: repo.path, parentPath: root, name: 'cloned' })).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' });
    await expect(handlers.setIdentity({ repoId: repo.id, name: 'x\ninjected', email: 'ok@example.test' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each(['\n', '\r\n'])('preserves checkout and shared Git directory paths ending in %j', async (ending) => {
    const checkout = path.join(root, `checkout-Ω${ending}`);
    const originalMetadata = path.join(root, 'git-data');
    const gitDirectory = `${originalMetadata}${ending}`;
    await git(root, ['init', '--initial-branch=main', `--separate-git-dir=${originalMetadata}`, '--', checkout]);
    await rename(originalMetadata, gitDirectory);
    // A trailing "/." keeps Git's gitfile parser from trimming the directory name itself.
    await writeFile(path.join(checkout, '.git'), `gitdir: ${gitDirectory}/.\n`);
    await git(checkout, ['config', 'core.quotePath', 'true']);
    const repo = await handlers.addRepository({ path: checkout });
    expect(repo.path).toBe(checkout);
    expect(await service.repositoryPath(repo.id)).toBe(checkout);
    await handlers.setIdentity({ repoId: repo.id, name: 'Newline Author', email: 'newline@example.test' });
    await commit(repo, 'Root', { 'odd\nfile-Ω.txt': 'base\n' });
    await handlers.branch({ repoId: repo.id, action: 'create', name: 'feature' });
    await commit(repo, 'Feature', { 'odd\nfile-Ω.txt': 'feature\n' });
    await handlers.branch({ repoId: repo.id, action: 'switch', name: 'main' });
    await commit(repo, 'Main', { 'odd\nfile-Ω.txt': 'main\n' });
    await expect(handlers.integrate({ repoId: repo.id, action: 'merge', branch: 'feature' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await handlers.status({ repoId: repo.id })).operation?.type).toBe('merge');
    await handlers.operation({ repoId: repo.id, action: 'abort', confirmed: true });

    const linkedPath = path.join(root, 'linked-Ω');
    await git(repo.path, ['worktree', 'add', '-b', 'linked', '--', linkedPath]);
    const linked = await handlers.addRepository({ path: linkedPath });
    expect((await handlers.status({ repoId: linked.id })).branch).toBe('linked');
    await put(repo, 'main.txt', 'main-only\n');
    await put(linked, 'linked.txt', 'linked-only\n');
    await handlers.stage({ repoId: repo.id, paths: ['main.txt'], stage: true });
    await handlers.stage({ repoId: linked.id, paths: ['linked.txt'], stage: true });
    await writeFile(path.join(gitDirectory, 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 0.05\n', { mode: 0o755 });
    events.length = 0;
    await Promise.all([
      handlers.commit({ repoId: repo.id, summary: 'Main worktree', description: '', amend: false }),
      handlers.commit({ repoId: linked.id, summary: 'Linked worktree', description: '', amend: false }),
    ]);
    const phases = events.flatMap((event) => event.type === 'command' && event.log.command === 'commit' && event.log.phase !== 'progress' ? [event.log.phase] : []);
    expect(phases).toEqual(['started', 'completed', 'started', 'completed']);
    expect(await git(repo.path, ['ls-files', '--', 'linked.txt'])).toBe('');
    expect(await git(linked.path, ['ls-files', '--', 'main.txt'])).toBe('');
    await expect(handlers.stage({ repoId: linked.id, paths: ['.git'], stage: true })).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await symlink(gitDirectory, path.join(linked.path, 'metadata-alias'), 'dir');
    await expect(handlers.discard({ repoId: linked.id, paths: ['metadata-alias/config'], confirmed: true })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });

    await service.dispose();
    service = createGitService({ dataDir: path.join(root, 'data') });
    handlers = service.handlers;
    expect(await service.repositoryPath(repo.id)).toBe(checkout);
    expect((await handlers.getAppState({})).repositories).toEqual([repo, linked]);
  });

  it('refuses layouts that expose real Git metadata as working-tree files', async () => {
    const checkout = path.join(root, 'internal-checkout');
    const gitDirectory = path.join(checkout, 'git-internals');
    await mkdir(checkout);
    await git(checkout, ['init', '--initial-branch=main', `--separate-git-dir=${gitDirectory}`, '--', '.']);
    const before = await readFile(path.join(gitDirectory, 'config'), 'utf8');
    await expect(handlers.addRepository({ path: checkout })).rejects.toMatchObject({ code: 'UNSAFE_REPOSITORY_LAYOUT' });
    expect((await handlers.getAppState({})).repositories).toEqual([]);
    expect(await readFile(path.join(gitDirectory, 'config'), 'utf8')).toBe(before);
  });
});

describe('index, exact paths, history, and diffs', () => {
  it('keeps odd paths literal and preserves excluded index/worktree changes, including unborn unstaging', async () => {
    const repo = await repository();
    const odd = ['a[1].txt', 'a1.txt', '--flag', 'line\nユニコード.txt', 'tab\tfile.txt'];
    for (const name of odd) await put(repo, name, `${name}\n`);
    await put(repo, 'selected.txt', 'index version\n');
    const state = await handlers.status({ repoId: repo.id });
    expect(state.files.map((file) => file.path).sort()).toEqual([...odd, 'selected.txt'].sort());
    expect((await handlers.diff({ repoId: repo.id, path: 'line\nユニコード.txt', source: 'working' })).text).toContain('ユニコード');
    await handlers.stage({ repoId: repo.id, paths: ['a[1].txt', 'selected.txt'], stage: true });
    await put(repo, 'selected.txt', 'index version\nexcluded working edit\n');
    await handlers.stage({ repoId: repo.id, paths: ['a[1].txt'], stage: false });
    expect((await handlers.status({ repoId: repo.id })).files.filter((file) => file.staged).map((file) => file.path)).toEqual(['selected.txt']);
    const staged = await handlers.diff({ repoId: repo.id, path: 'selected.txt', source: 'staged' });
    const working = await handlers.diff({ repoId: repo.id, path: 'selected.txt', source: 'working' });
    expect(staged.text).toContain('+index version');
    expect(staged.text).not.toContain('excluded working edit');
    expect(working.text).toContain('+excluded working edit');
    await handlers.commit({ repoId: repo.id, summary: 'Only staged data', description: 'Body\n\nsecond paragraph', amend: false });
    expect(await git(repo.path, ['show', 'HEAD:selected.txt'])).toBe('index version');
    expect(await git(repo.path, ['ls-tree', '--name-only', 'HEAD'])).toBe('selected.txt');
    await expect(handlers.commit({ repoId: repo.id, summary: 'No automatic add', description: '', amend: false })).rejects.toMatchObject({ code: 'NOTHING_STAGED' });
    expect((await handlers.status({ repoId: repo.id })).files.find((file) => file.path === 'selected.txt')).toMatchObject({ staged: false, unstaged: true });
    await Promise.all(odd.map((name) => handlers.stage({ repoId: repo.id, paths: [name], stage: true })));
    expect((await handlers.status({ repoId: repo.id })).files.filter((file) => file.staged)).toHaveLength(odd.length);
  });

  it('handles root and selected-commit rename diffs, paging/search, binary/empty files, and explicit size caps', async () => {
    const repo = await repository();
    const rootSha = await commit(repo, 'Root searchable', { 'old\nα.txt': 'line1\nline2\nline3\nline4\n' });
    const rootDetails = await handlers.commitDetails({ repoId: repo.id, sha: rootSha });
    expect(rootDetails.commit.parents).toEqual([]);
    expect(rootDetails.files).toEqual([{ path: 'old\nα.txt', status: 'A' }]);
    expect((await handlers.diff({ repoId: repo.id, path: 'old\nα.txt', source: 'commit', commit: rootSha })).text).toContain('+line1');
    await git(repo.path, ['mv', '--', 'old\nα.txt', 'new\nβ.txt']);
    expect((await handlers.status({ repoId: repo.id })).files).toEqual([expect.objectContaining({ path: 'new\nβ.txt', oldPath: 'old\nα.txt', staged: true })]);
    expect((await handlers.diff({ repoId: repo.id, path: 'new\nβ.txt', source: 'staged' })).text).toContain('rename from');
    await handlers.stage({ repoId: repo.id, paths: ['new\nβ.txt'], stage: false });
    expect((await handlers.status({ repoId: repo.id })).files.every((file) => !file.staged)).toBe(true);
    await handlers.stage({ repoId: repo.id, paths: ['old\nα.txt', 'new\nβ.txt'], stage: true });
    await handlers.commit({ repoId: repo.id, summary: 'Rename', description: 'Paragraph one\n\nParagraph two', amend: false });
    const renameSha = await git(repo.path, ['rev-parse', 'HEAD']);
    expect((await handlers.commitDetails({ repoId: repo.id, sha: renameSha })).files).toEqual([{ path: 'new\nβ.txt', oldPath: 'old\nα.txt', status: 'R100' }]);
    await put(repo, 'new\nβ.txt', 'Uncommitted noise\n');
    expect((await handlers.diff({ repoId: repo.id, path: 'new\nβ.txt', source: 'commit', commit: renameSha })).text).not.toContain('Uncommitted noise');
    const page = await handlers.history({ repoId: repo.id, skip: 0, limit: 1, search: '' });
    expect(page).toMatchObject({ hasMore: true, commits: [{ sha: renameSha, body: 'Paragraph one\n\nParagraph two\n' }] });
    expect((await handlers.history({ repoId: repo.id, skip: 1, limit: 1, search: '' })).commits[0].sha).toBe(rootSha);
    expect((await handlers.history({ repoId: repo.id, skip: 0, limit: 10, search: 'SEARCHABLE' })).commits.map((item) => item.sha)).toEqual([rootSha]);
    expect((await handlers.history({ repoId: repo.id, skip: 1, limit: 10, search: 'test@example.test' })).commits.map((item) => item.sha)).toEqual([rootSha]);
    expect((await handlers.history({ repoId: repo.id, skip: 0, limit: 10, search: renameSha.slice(0, 12) })).commits[0].sha).toBe(renameSha);
    await put(repo, 'binary.bin', Buffer.from([0, 1, 2, 3]));
    await put(repo, 'empty.txt', '');
    await put(repo, 'large.txt', 'x'.repeat(3 * 1024 * 1024));
    expect((await handlers.diff({ repoId: repo.id, path: 'binary.bin', source: 'working' })).binary).toBe(true);
    expect(await handlers.diff({ repoId: repo.id, path: 'empty.txt', source: 'working' })).toMatchObject({ binary: false, tooLarge: false });
    expect(await handlers.diff({ repoId: repo.id, path: 'large.txt', source: 'working' })).toMatchObject({ text: '', tooLarge: true });
    await handlers.stage({ repoId: repo.id, paths: ['large.txt'], stage: true });
    expect(await handlers.diff({ repoId: repo.id, path: 'large.txt', source: 'staged' })).toMatchObject({ text: '', tooLarge: true });
  });

  it('discards only selected unstaged data, restores from the index, and escapes literal ignore patterns', async () => {
    const repo = await repository();
    await commit(repo, 'Base');
    await put(repo, 'file.txt', 'staged version\n');
    await handlers.stage({ repoId: repo.id, paths: ['file.txt'], stage: true });
    await put(repo, 'file.txt', 'unstaged version\n');
    await put(repo, 'unselected.txt', 'keep me\n');
    await expect(handlers.discard({ repoId: repo.id, paths: ['file.txt'], confirmed: false })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await handlers.discard({ repoId: repo.id, paths: ['file.txt'], confirmed: true });
    expect(await readFile(path.join(repo.path, 'file.txt'), 'utf8')).toBe('staged version\n');
    expect((await handlers.status({ repoId: repo.id })).files.find((file) => file.path === 'file.txt')).toMatchObject({ staged: true, unstaged: false });
    await put(repo, 'new-dir/one.txt', 'one');
    await put(repo, 'new-dir/two.txt', 'two');
    await expect(handlers.discard({ repoId: repo.id, paths: ['new-dir'], confirmed: true })).rejects.toMatchObject({ code: 'DIRECTORY_NOT_ALLOWED' });
    await handlers.discard({ repoId: repo.id, paths: ['new-dir/one.txt'], confirmed: true });
    expect(await readFile(path.join(repo.path, 'new-dir/two.txt'), 'utf8')).toBe('two');
    await put(repo, '#[a]*!.txt ', 'ignore exact');
    await put(repo, '#aa!.txt ', 'keep literal neighbor');
    await handlers.ignore({ repoId: repo.id, paths: ['#[a]*!.txt '] });
    const paths = (await handlers.status({ repoId: repo.id })).files.map((file) => file.path);
    expect(paths).not.toContain('#[a]*!.txt ');
    expect(paths).toContain('#aa!.txt ');
    expect(paths).toContain('unselected.txt');
    await put(repo, 'newline\nfile', 'x');
    await expect(handlers.ignore({ repoId: repo.id, paths: ['newline\nfile'] })).rejects.toMatchObject({ code: 'UNSUPPORTED_PATH' });
  });

  it('does not stage a newly reused rename source and handles staged deletions independently from replacement files', async () => {
    const repo = await repository();
    await commit(repo, 'Base', { 'source.txt': 'original\n', 'other.txt': 'other\n' });
    await git(repo.path, ['mv', '--', 'source.txt', 'destination.txt']);
    await put(repo, 'destination.txt', 'original\nselected change\n');
    await put(repo, 'source.txt', 'unselected replacement\n');
    await handlers.stage({ repoId: repo.id, paths: ['destination.txt'], stage: true });
    expect(await git(repo.path, ['ls-files', '--', 'source.txt'])).toBe('');
    expect((await handlers.status({ repoId: repo.id })).files.find((file) => file.path === 'source.txt')).toMatchObject({ untracked: true });
    await handlers.commit({ repoId: repo.id, summary: 'Selected rename', description: '', amend: false });
    expect(await readFile(path.join(repo.path, 'source.txt'), 'utf8')).toBe('unselected replacement\n');
    await git(repo.path, ['rm', '--', 'other.txt']);
    await put(repo, 'other.txt', 'untracked replacement\n');
    expect((await handlers.status({ repoId: repo.id })).files.find((file) => file.path === 'other.txt')).toMatchObject({ staged: true, untracked: true, index: 'D' });
    await handlers.discard({ repoId: repo.id, paths: ['other.txt'], confirmed: true });
    expect((await handlers.status({ repoId: repo.id })).files.find((file) => file.path === 'other.txt')).toMatchObject({ staged: true, untracked: false, index: 'D' });
  });
});

describe('branches, network, and force-with-lease', () => {
  it('carries or stashes dirty worktrees when creating a branch', async () => {
    const carried = await repository('carried');
    await commit(carried, 'Initial', { 'tracked.txt': 'base\n' });
    await put(carried, 'tracked.txt', 'staged\n');
    await handlers.stage({ repoId: carried.id, paths: ['tracked.txt'], stage: true });
    await put(carried, 'tracked.txt', 'unstaged\n');
    await put(carried, 'untracked.txt', 'untracked\n');
    await handlers.branch({ repoId: carried.id, action: 'create', name: 'with-changes', dirtyAction: 'carry' });
    const carriedStatus = await handlers.status({ repoId: carried.id });
    expect(carriedStatus.branch).toBe('with-changes');
    expect(carriedStatus.files.find(file => file.path === 'tracked.txt')).toMatchObject({ staged: true, unstaged: true });
    expect(carriedStatus.files.find(file => file.path === 'untracked.txt')).toMatchObject({ untracked: true });
    expect(await git(carried.path, ['show', ':tracked.txt'])).toBe('staged');
    expect(await readFile(path.join(carried.path, 'tracked.txt'), 'utf8')).toBe('unstaged\n');

    const stashed = await repository('stashed');
    await commit(stashed, 'Initial', { 'tracked.txt': 'base\n' });
    await put(stashed, 'tracked.txt', 'staged\n');
    await handlers.stage({ repoId: stashed.id, paths: ['tracked.txt'], stage: true });
    await put(stashed, 'untracked.txt', 'untracked\n');
    await handlers.branch({ repoId: stashed.id, action: 'create', name: 'without-changes', dirtyAction: 'stash' });
    expect(await handlers.status({ repoId: stashed.id })).toMatchObject({ branch: 'without-changes', files: [] });
    expect(await handlers.stashes({ repoId: stashed.id })).toEqual([
      expect.objectContaining({ message: 'On main: Before creating branch without-changes' }),
    ]);
    await handlers.stash({ repoId: stashed.id, action: 'pop', ref: 'stash@{0}', confirmed: true });
    expect((await handlers.status({ repoId: stashed.id })).files.map(file => file.path).sort()).toEqual(['tracked.txt', 'untracked.txt']);
    expect(await git(stashed.path, ['show', ':tracked.txt'])).toBe('staged');
  });

  it('guards dirty trees, protects default/unmerged branches, validates refs, and confirms amend and detached checkout', async () => {
    const repo = await repository();
    const initial = await commit(repo, 'Initial');
    await put(repo, 'dirty.txt', 'keep');
    await expect(handlers.branch({ repoId: repo.id, action: 'create', name: 'feature' })).rejects.toMatchObject({ code: 'DIRTY_WORKTREE' });
    await handlers.discard({ repoId: repo.id, paths: ['dirty.txt'], confirmed: true });
    await handlers.branch({ repoId: repo.id, action: 'create', name: 'feature' });
    await commit(repo, 'Feature only');
    await handlers.branch({ repoId: repo.id, action: 'rename', name: 'renamed' });
    await handlers.branch({ repoId: repo.id, action: 'switch', name: 'main' });
    await expect(handlers.branch({ repoId: repo.id, action: 'delete', name: 'renamed', confirmed: true })).rejects.toBeInstanceOf(GitError);
    await expect(handlers.branch({ repoId: repo.id, action: 'delete', name: 'main', confirmed: true })).rejects.toMatchObject({ code: 'PROTECTED_BRANCH' });
    await handlers.integrate({ repoId: repo.id, action: 'merge', branch: 'renamed' });
    await handlers.branch({ repoId: repo.id, action: 'delete', name: 'renamed', confirmed: true });
    await expect(handlers.branch({ repoId: repo.id, action: 'create', name: 'feature..bad' })).rejects.toMatchObject({ code: 'INVALID_REF' });
    await expect(handlers.commit({ repoId: repo.id, summary: 'Amended', description: '', amend: true })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await handlers.commit({ repoId: repo.id, summary: 'Amended', description: '', amend: true, confirmed: true });
    await expect(handlers.commitAction({ repoId: repo.id, action: 'checkout', sha: initial, confirmed: false })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await handlers.commitAction({ repoId: repo.id, action: 'checkout', sha: initial, confirmed: true });
    expect((await handlers.status({ repoId: repo.id })).detached).toBe(true);
    await handlers.branch({ repoId: repo.id, action: 'switch', name: 'main' });
  });

  it('publishes upstreams, fetches explicitly, pulls merge/rebase, and switches remote tracking branches', async () => {
    const { local, other } = await connected();
    expect(await handlers.status({ repoId: local.id })).toMatchObject({ upstream: 'origin/main', ahead: 0, behind: 0 });
    await commit(other, 'Remote next', { 'remote.txt': 'remote\n' });
    await handlers.network({ repoId: other.id, action: 'push' });
    expect((await handlers.status({ repoId: local.id })).behind).toBe(0);
    await handlers.network({ repoId: local.id, action: 'fetch', remote: 'origin' });
    expect((await handlers.status({ repoId: local.id })).behind).toBe(1);
    await handlers.network({ repoId: local.id, action: 'pull' });
    expect(await readFile(path.join(local.path, 'remote.txt'), 'utf8')).toBe('remote\n');
    await commit(local, 'Local divergent', { 'local.txt': 'local\n' });
    await commit(other, 'Other divergent', { 'other.txt': 'other\n' });
    await handlers.network({ repoId: other.id, action: 'push' });
    await handlers.network({ repoId: local.id, action: 'pullRebase' });
    expect((await handlers.status({ repoId: local.id })).ahead).toBe(1);
    await handlers.network({ repoId: local.id, action: 'push' });
    await handlers.branch({ repoId: other.id, action: 'create', name: 'topic' });
    await commit(other, 'Topic', { 'topic.txt': 'topic\n' });
    await handlers.network({ repoId: other.id, action: 'push' });
    await handlers.network({ repoId: local.id, action: 'fetch' });
    expect((await handlers.branches({ repoId: local.id })).find((item) => item.name === 'origin/topic')).toMatchObject({ remote: true });
    await handlers.branch({ repoId: local.id, action: 'switch', name: 'origin/topic' });
    expect(await handlers.status({ repoId: local.id })).toMatchObject({ branch: 'topic', upstream: 'origin/topic' });
  });

  it('never inherits a creation upstream that would accidentally publish a new branch over its parent', async () => {
    const { local, remote } = await connected();
    const mainTip = await git(remote, ['rev-parse', 'refs/heads/main']);
    await git(local.path, ['config', 'branch.autoSetupMerge', 'inherit']);
    await handlers.branch({ repoId: local.id, action: 'create', name: 'new-publication' });
    expect((await handlers.status({ repoId: local.id })).upstream).toBeNull();
    await commit(local, 'New branch', { 'new.txt': 'new\n' });
    await handlers.network({ repoId: local.id, action: 'push' });
    expect(await git(remote, ['rev-parse', 'refs/heads/main'])).toBe(mainTip);
    expect(await git(remote, ['rev-parse', 'refs/heads/new-publication'])).toBe(await git(local.path, ['rev-parse', 'HEAD']));
    await service.dispose();
    service = createGitService({ dataDir: path.join(root, 'data') });
    handlers = service.handlers;
    await expect(handlers.network({ repoId: local.id, action: 'forcePush', confirmed: true })).rejects.toMatchObject({ code: 'LEASE_REQUIRED' });
  });

  it('refuses a stale explicit force lease even if a background fetch changed the tracking ref, and never overwrites a remote-ahead branch', async () => {
    const { local, other, remote } = await connected();
    await commit(local, 'Published work', { 'local.txt': 'published\n' });
    await handlers.network({ repoId: local.id, action: 'push' });
    await handlers.network({ repoId: other.id, action: 'pull' });
    const observed = (await handlers.status({ repoId: local.id })).head;
    await handlers.commit({ repoId: local.id, summary: 'Rewritten published work', description: '', amend: true, confirmed: true });
    await commit(other, 'Someone else advanced remote', { 'external.txt': 'must not lose\n' });
    await handlers.network({ repoId: other.id, action: 'push' });
    const advanced = await git(remote, ['rev-parse', 'refs/heads/main']);
    expect(advanced).not.toBe(observed);
    await git(local.path, ['fetch', 'origin']);
    await expect(handlers.network({ repoId: local.id, action: 'forcePush', confirmed: true })).rejects.toMatchObject({ code: 'PUSH_REJECTED' });
    expect(await git(remote, ['rev-parse', 'refs/heads/main'])).toBe(advanced);
    expect(events.filter((event) => event.type === 'command' && event.log.command === 'network' && event.log.phase === 'failed')).not.toHaveLength(0);
    await git(local.path, ['reset', '--hard', observed!]);
    await handlers.status({ repoId: local.id });
    await expect(handlers.network({ repoId: local.id, action: 'forcePush', confirmed: true })).rejects.toMatchObject({ code: 'REMOTE_AHEAD' });
    expect(await git(remote, ['rev-parse', 'refs/heads/main'])).toBe(advanced);
  });

  it('allows an intentionally confirmed rewrite against an unchanged observed tip and rejects ambiguous push configuration', async () => {
    const { local, remote } = await connected();
    await commit(local, 'Published', { 'extra.txt': 'extra\n' });
    await handlers.network({ repoId: local.id, action: 'push' });
    await handlers.status({ repoId: local.id });
    await handlers.commit({ repoId: local.id, summary: 'Amended publication', description: '', amend: true, confirmed: true });
    await expect(handlers.network({ repoId: local.id, action: 'forcePush' })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await handlers.network({ repoId: local.id, action: 'forcePush', confirmed: true });
    expect(await git(remote, ['rev-parse', 'refs/heads/main'])).toBe(await git(local.path, ['rev-parse', 'HEAD']));
    const wrongRemote = await bare('wrong.git');
    await git(local.path, ['config', 'remote.origin.pushurl', wrongRemote]);
    await expect(handlers.network({ repoId: local.id, action: 'push' })).rejects.toMatchObject({ code: 'UNSUPPORTED_REMOTE' });
    await git(local.path, ['config', '--unset', 'remote.origin.pushurl']);
    await git(local.path, ['config', 'remote.origin.push', 'refs/heads/main:refs/heads/wrong']);
    await expect(handlers.network({ repoId: local.id, action: 'push' })).rejects.toMatchObject({ code: 'UNSUPPORTED_REMOTE' });
    await git(local.path, ['config', '--unset', 'remote.origin.push']);
    await git(local.path, ['config', 'remote.origin.uploadpack', 'nonstandard-upload-command']);
    await expect(handlers.network({ repoId: local.id, action: 'fetch' })).rejects.toMatchObject({ code: 'UNSUPPORTED_REMOTE' });
  });
});

describe('stashes and conflict workflows', () => {
  it('saves only explicitly requested untracked files, restores the index, and confirms apply/pop/drop', async () => {
    const repo = await repository();
    await commit(repo, 'Base');
    await put(repo, 'file.txt', 'staged stash\n');
    await handlers.stage({ repoId: repo.id, paths: ['file.txt'], stage: true });
    await put(repo, 'untracked.txt', 'untracked stash\n');
    await put(repo, 'stash[1]\nΩ.txt', 'literal odd stash\n');
    await put(repo, '--stash-flag', 'literal flag\n');
    await expect(handlers.stash({ repoId: repo.id, action: 'save' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await handlers.stash({ repoId: repo.id, action: 'save', includeUntracked: true, message: 'Fixture stash' });
    expect((await handlers.status({ repoId: repo.id })).files).toEqual([]);
    expect(await handlers.stashes({ repoId: repo.id })).toEqual([expect.objectContaining({ ref: 'stash@{0}', message: 'On main: Fixture stash' })]);
    await expect(handlers.stash({ repoId: repo.id, action: 'apply', ref: 'stash@{0}' })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await handlers.stash({ repoId: repo.id, action: 'apply', ref: 'stash@{0}', confirmed: true });
    expect((await handlers.status({ repoId: repo.id })).files.find((file) => file.path === 'file.txt')).toMatchObject({ staged: true });
    expect(await readFile(path.join(repo.path, 'untracked.txt'), 'utf8')).toBe('untracked stash\n');
    expect(await readFile(path.join(repo.path, 'stash[1]\nΩ.txt'), 'utf8')).toBe('literal odd stash\n');
    expect(await readFile(path.join(repo.path, '--stash-flag'), 'utf8')).toBe('literal flag\n');
    await handlers.stash({ repoId: repo.id, action: 'save', includeUntracked: false, message: 'Tracked only' });
    expect((await handlers.status({ repoId: repo.id })).files.map((file) => file.path).sort()).toEqual(['--stash-flag', 'stash[1]\nΩ.txt', 'untracked.txt']);
    await handlers.discard({ repoId: repo.id, paths: ['untracked.txt', 'stash[1]\nΩ.txt', '--stash-flag'], confirmed: true });
    await handlers.stash({ repoId: repo.id, action: 'pop', ref: 'stash@{0}', confirmed: true });
    expect((await handlers.stashes({ repoId: repo.id }))).toHaveLength(1);
    await handlers.stash({ repoId: repo.id, action: 'drop', ref: 'stash@{0}', confirmed: true });
    expect(await handlers.stashes({ repoId: repo.id })).toEqual([]);
    await expect(handlers.stash({ repoId: repo.id, action: 'drop', ref: 'stash@{0}', confirmed: true })).rejects.toMatchObject({ code: 'STASH_NOT_FOUND' });
  });

  async function conflicting(): Promise<Repository> {
    const repo = await repository();
    await commit(repo, 'Base', { 'a.txt': 'base\n', 'b.txt': 'base\n' });
    await handlers.branch({ repoId: repo.id, action: 'create', name: 'feature' });
    await commit(repo, 'Feature', { 'a.txt': 'feature\n', 'b.txt': 'feature\n' });
    await handlers.branch({ repoId: repo.id, action: 'switch', name: 'main' });
    await commit(repo, 'Main', { 'a.txt': 'main\n', 'b.txt': 'main\n' });
    return repo;
  }

  it('detects merge conflicts, rejects unresolved markers, resolves only selected files, and supports continue/abort', async () => {
    const repo = await conflicting();
    const before = await git(repo.path, ['rev-parse', 'HEAD']);
    const changedBefore = events.filter((event) => event.type === 'changed').length;
    await expect(handlers.integrate({ repoId: repo.id, action: 'merge', branch: 'feature' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(events.filter((event) => event.type === 'changed').length).toBeGreaterThan(changedBefore);
    expect((await handlers.status({ repoId: repo.id })).operation?.type).toBe('merge');
    await expect(handlers.resolve({ repoId: repo.id, paths: ['a.txt'], choice: 'mark' })).rejects.toMatchObject({ code: 'CONFLICT_MARKERS' });
    await expect(handlers.resolve({ repoId: repo.id, paths: ['a.txt'], choice: 'ours' })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await handlers.resolve({ repoId: repo.id, paths: ['a.txt'], choice: 'ours', confirmed: true });
    expect(await readFile(path.join(repo.path, 'a.txt'), 'utf8')).toBe('main\n');
    expect((await handlers.status({ repoId: repo.id })).files.filter((file) => file.conflicted).map((file) => file.path)).toEqual(['b.txt']);
    await expect(handlers.operation({ repoId: repo.id, action: 'continue' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(handlers.operation({ repoId: repo.id, action: 'abort' })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await handlers.operation({ repoId: repo.id, action: 'abort', confirmed: true });
    expect(await git(repo.path, ['rev-parse', 'HEAD'])).toBe(before);
    expect((await handlers.status({ repoId: repo.id })).files).toEqual([]);
    await expect(handlers.integrate({ repoId: repo.id, action: 'merge', branch: 'feature' })).rejects.toBeInstanceOf(GitError);
    await put(repo, 'a.txt', 'manual combination\n');
    await handlers.resolve({ repoId: repo.id, paths: ['a.txt'], choice: 'mark' });
    await handlers.resolve({ repoId: repo.id, paths: ['b.txt'], choice: 'theirs', confirmed: true });
    await handlers.operation({ repoId: repo.id, action: 'continue' });
    expect((await handlers.status({ repoId: repo.id })).operation).toBeNull();
    expect((await handlers.commitDetails({ repoId: repo.id, sha: await git(repo.path, ['rev-parse', 'HEAD']) })).commit.parents).toHaveLength(2);
  });

  it('detects rebase reversal, aborts safely, and continues a selectively resolved replay', async () => {
    const repo = await conflicting();
    await handlers.branch({ repoId: repo.id, action: 'switch', name: 'feature' });
    const before = await git(repo.path, ['rev-parse', 'HEAD']);
    await expect(handlers.integrate({ repoId: repo.id, action: 'rebase', branch: 'main' })).rejects.toBeInstanceOf(GitError);
    expect((await handlers.status({ repoId: repo.id })).operation).toMatchObject({ type: 'rebase', message: expect.stringContaining('ours is the upstream') });
    await handlers.operation({ repoId: repo.id, action: 'abort', confirmed: true });
    expect(await git(repo.path, ['rev-parse', 'HEAD'])).toBe(before);
    await expect(handlers.integrate({ repoId: repo.id, action: 'rebase', branch: 'main' })).rejects.toBeInstanceOf(GitError);
    await handlers.resolve({ repoId: repo.id, paths: ['a.txt'], choice: 'theirs', confirmed: true });
    expect(await readFile(path.join(repo.path, 'a.txt'), 'utf8')).toBe('feature\n');
    await handlers.resolve({ repoId: repo.id, paths: ['b.txt'], choice: 'ours', confirmed: true });
    expect(await readFile(path.join(repo.path, 'b.txt'), 'utf8')).toBe('main\n');
    await handlers.operation({ repoId: repo.id, action: 'continue' });
    expect(await handlers.status({ repoId: repo.id })).toMatchObject({ branch: 'feature', operation: null, files: [] });
    expect(await git(repo.path, ['rev-parse', 'HEAD^'])).toBe(await git(repo.path, ['rev-parse', 'main']));
  });

  it('cherry-picks and reverts exact commits and exposes abort for conflicting cherry-picks', async () => {
    const repo = await repository();
    await commit(repo, 'Base');
    await handlers.branch({ repoId: repo.id, action: 'create', name: 'feature' });
    const feature = await commit(repo, 'Feature', { 'feature.txt': 'feature\n' });
    await handlers.branch({ repoId: repo.id, action: 'switch', name: 'main' });
    await handlers.commitAction({ repoId: repo.id, action: 'cherryPick', sha: feature, confirmed: true });
    expect(await readFile(path.join(repo.path, 'feature.txt'), 'utf8')).toBe('feature\n');
    const cherry = await git(repo.path, ['rev-parse', 'HEAD']);
    await handlers.commitAction({ repoId: repo.id, action: 'revert', sha: cherry, confirmed: true });
    expect((await handlers.commitDetails({ repoId: repo.id, sha: await git(repo.path, ['rev-parse', 'HEAD']) })).files).toEqual([{ path: 'feature.txt', status: 'D' }]);
    await commit(repo, 'Conflicting addition', { 'feature.txt': 'local different\n' });
    await expect(handlers.commitAction({ repoId: repo.id, action: 'cherryPick', sha: feature, confirmed: true })).rejects.toBeInstanceOf(GitError);
    expect((await handlers.status({ repoId: repo.id })).operation?.type).toBe('cherry-pick');
    await handlers.operation({ repoId: repo.id, action: 'abort', confirmed: true });
    expect((await handlers.status({ repoId: repo.id })).operation).toBeNull();
  });

  it('resolves selected modify/delete conflicts without recreating deleted-side data', async () => {
    const repo = await repository();
    await commit(repo, 'Base', { 'delete.txt': 'base\n', 'keep.txt': 'base\n' });
    await handlers.branch({ repoId: repo.id, action: 'create', name: 'deleting' });
    await git(repo.path, ['rm', '--', 'delete.txt']);
    await handlers.commit({ repoId: repo.id, summary: 'Delete', description: '', amend: false });
    await handlers.branch({ repoId: repo.id, action: 'switch', name: 'main' });
    await commit(repo, 'Modify', { 'delete.txt': 'modified\n' });
    await expect(handlers.integrate({ repoId: repo.id, action: 'merge', branch: 'deleting' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await handlers.resolve({ repoId: repo.id, paths: ['delete.txt'], choice: 'theirs', confirmed: true });
    expect((await handlers.status({ repoId: repo.id })).files.find((file) => file.path === 'delete.txt')).toMatchObject({ index: 'D', conflicted: false });
    await handlers.operation({ repoId: repo.id, action: 'continue' });
    expect(await readFile(path.join(repo.path, 'keep.txt'), 'utf8')).toBe('base\n');
  });
});

describe('runtime validation, path boundaries, and cancellation', () => {
  it('validates every service route and rejects traversal, metadata, option refs, and symlink parents', async () => {
    for (const handler of Object.values(handlers)) await expect((handler as (args: unknown) => Promise<unknown>)({ invalid: true })).rejects.toThrow();
    const repo = await repository();
    await commit(repo, 'Base');
    for (const value of ['../outside', '/absolute', 'C:\\outside', 'nested/../../outside', '.git/config', 'nested/./file', 'nested//file', 'a\\..\\outside']) {
      await expect(handlers.stage({ repoId: repo.id, paths: [value], stage: true })).rejects.toMatchObject({ code: 'INVALID_PATH' });
    }
    await mkdir(path.join(root, 'outside'));
    await writeFile(path.join(root, 'outside', 'secret.txt'), 'outside untouched');
    await symlink(path.join(root, 'outside'), path.join(repo.path, 'linked'), 'dir');
    await expect(handlers.discard({ repoId: repo.id, paths: ['linked/secret.txt'], confirmed: true })).rejects.toMatchObject({ code: 'UNSAFE_PATH' });
    await handlers.discard({ repoId: repo.id, paths: ['linked'], confirmed: true });
    expect(await readFile(path.join(root, 'outside', 'secret.txt'), 'utf8')).toBe('outside untouched');
    await symlink(path.join(root, 'outside', 'secret.txt'), path.join(repo.path, '.gitignore'));
    await put(repo, 'ignore-me', 'x');
    await expect(handlers.ignore({ repoId: repo.id, paths: ['ignore-me'] })).rejects.toThrow();
    expect(await readFile(path.join(root, 'outside', 'secret.txt'), 'utf8')).toBe('outside untouched');
    for (const value of ['main~1', 'main^{commit}', '@{-1}', 'feature..bad', 'foo.lock']) {
      await expect(handlers.branch({ repoId: repo.id, action: 'switch', name: value })).rejects.toThrow();
    }
    await expect(handlers.commitDetails({ repoId: repo.id, sha: 'a'.repeat(41) })).rejects.toMatchObject({ code: 'INVALID_REF' });
    await expect(handlers.status({ repoId: '01234567-89ab-4def-8123-456789abcdef' })).rejects.toMatchObject({ code: 'REPOSITORY_NOT_REGISTERED' });
  });

  it('rejects command protocols/credentials and redacts existing secrets without contacting remotes on reads', async () => {
    const repo = await repository();
    await commit(repo, 'Base');
    for (const url of ['ext::sh -c echo', 'file:///etc', 'git://example.test/repo', 'http://example.test/repo', 'https://person:secret@example.test/repo', 'ssh://person:secret@example.test/repo', '--upload-pack=evil', 'https://example.test/repo?token=secret']) {
      await expect(handlers.remote({ repoId: repo.id, action: 'add', name: 'bad', url })).rejects.toMatchObject({ code: 'INVALID_URL' });
    }
    await handlers.remote({ repoId: repo.id, action: 'add', name: 'ssh', url: 'git@example.test:owner/repository.git' });
    await handlers.remote({ repoId: repo.id, action: 'edit', name: 'ssh', url: 'ssh://git@example.test/owner/repo.git', confirmed: true });
    expect((await handlers.getRepoSettings({ repoId: repo.id })).remotes[0].url).toBe('ssh://git@example.test/owner/repo.git');
    await handlers.remote({ repoId: repo.id, action: 'remove', name: 'ssh', confirmed: true });
    await git(repo.path, ['remote', 'add', 'origin', 'https://person:super-secret@example.test/repo?token=hidden-token']);
    const state = await handlers.status({ repoId: repo.id });
    const settings = await handlers.getRepoSettings({ repoId: repo.id });
    expect(JSON.stringify([state, settings, events])).not.toMatch(/super-secret|hidden-token/);
    await expect(handlers.network({ repoId: repo.id, action: 'fetch' })).rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(toAppError(new GitError('EXAMPLE', 'https://person:private@example.test', 'Authorization: Bearer ghp_privatePAT'))).toEqual({
      code: 'EXAMPLE', message: 'https://[redacted]@example.test', detail: 'Authorization: Bearer [redacted]',
    });
  });

  it('fails honestly on invalid filename encodings and corrupt persisted settings without overwriting them', async () => {
    const repo = await repository();
    const invalidPath = Buffer.concat([Buffer.from(`${repo.path}/invalid-`), Buffer.from([0xff])]);
    await writeFile(invalidPath, 'invalid UTF-8 filename');
    await expect(handlers.status({ repoId: repo.id })).rejects.toMatchObject({ code: 'UNSUPPORTED_ENCODING' });
    const originalSettings = await readFile(path.join(root, 'data', 'state.json'), 'utf8');
    await service.dispose();
    await writeFile(path.join(root, 'data', 'state.json'), '{"broken":');
    service = createGitService({ dataDir: path.join(root, 'data') });
    handlers = service.handlers;
    await expect(handlers.getAppState({})).rejects.toMatchObject({ code: 'APP_STATE_INVALID' });
    await expect(handlers.setPreferences({ theme: 'dark' })).rejects.toMatchObject({ code: 'APP_STATE_INVALID' });
    expect(await readFile(path.join(root, 'data', 'state.json'), 'utf8')).toBe('{"broken":');
    await writeFile(path.join(root, 'data', 'state.json'), originalSettings);
    expect(await handlers.setPreferences({ theme: 'dark' })).toMatchObject({ repositories: [repo], selectedRepoId: repo.id, theme: 'dark' });
    expect(await handlers.getAppState({})).toMatchObject({ repositories: [repo], theme: 'dark' });
  });

  it('cancels an active Git process tree and emits failure plus changed events', async () => {
    const repo = await repository();
    await put(repo, 'file.txt', 'new\n');
    await handlers.stage({ repoId: repo.id, paths: ['file.txt'], stage: true });
    await writeFile(path.join(repo.path, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho GITDESK_TEST_HOOK_WAIT >&2\nsleep 60\n', { mode: 0o755 });
    const pending = handlers.commit({ repoId: repo.id, summary: 'Cancelled', description: '', amend: false });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    for (let attempt = 0; attempt < 200 && !events.some((event) => event.type === 'command' && event.log.message.includes('GITDESK_TEST_HOOK_WAIT')); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(events.some((event) => event.type === 'command' && event.log.message.includes('GITDESK_TEST_HOOK_WAIT'))).toBe(true);
    await handlers.cancel({ repoId: repo.id });
    await rejection;
    expect(events).toContainEqual(expect.objectContaining({ type: 'changed', repoId: repo.id }));
    expect(events).toContainEqual({ type: 'command', log: expect.objectContaining({ command: 'commit', phase: 'failed' }) });
    expect((await handlers.status({ repoId: repo.id })).unborn).toBe(true);
    await rm(path.join(repo.path, '.git', 'hooks', 'pre-commit'));
    await handlers.commit({ repoId: repo.id, summary: 'After cancellation', description: '', amend: false });
    expect((await handlers.status({ repoId: repo.id })).unborn).toBe(false);
  });
});
