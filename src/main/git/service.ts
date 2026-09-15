import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readlink, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AppEvent, AppState, Branch, ChangedFile, CommandArgs, CommandData, Commit, GitCommand,
  GitHandlers, OperationState, Remote, Repository, RepoStatus, Stash, StatusFile, GitHubRepository,
} from '../../shared/api';
import { parseCommandArgs } from '../../shared/validation';
import { AppStore } from '../store';
import { GitError, isMissing, redact, requireConfirmation } from './errors';
import { approvedUrl, exactPath, newDestination, readExactFile, relativePath } from './paths';
import { COMMIT_FORMAT, parseChangedFiles, parseCommits, parseStatus } from './parsers';
import { DIFF_LIMIT, GitRunner, type Execution } from './runner';
import { HttpsAuthentication } from './https-auth';
import { GitHubClient, githubCloneUrl, type GitHubOptions } from '../github/client';

export { GitError, toAppError } from './errors';

type GitMetadata = { gitDir: string; commonDir: string };

interface Context extends Execution {
  root?: string;
  repoId?: string;
  id: string;
  metadata?: Promise<GitMetadata>;
}

type RepoContext = Context & { root: string; repoId: string };
const mutations = new Set<GitCommand>([
  'setPreferences', 'selectRepository', 'addRepository', 'initRepository', 'cloneRepository', 'removeRepository',
  'stage', 'commit', 'discard', 'ignore', 'branch', 'network', 'integrate', 'commitAction', 'stash', 'resolve',
  'operation', 'setIdentity', 'remote', 'setHttpsCredentials', 'forgetHttpsCredentials',
  'githubSignIn', 'githubImportCli', 'githubBeginLogin', 'githubSignOut',
  'githubClone', 'githubCreate', 'githubPublish',
]);
const newline = (buffer: Buffer): string => buffer.toString('utf8').replace(/\n$/, '');

export function createGitService(options: { dataDir: string; onEvent?: (event: AppEvent) => void; github?: Omit<GitHubOptions, 'dataDir'> }): {
  handlers: GitHandlers;
  repositoryPath(repoId: string): Promise<string>;
  dispose(): Promise<void>;
} {
  const store = new AppStore(options.dataDir);
  const runner = new GitRunner();
  const httpsAuth = new HttpsAuthentication(runner);
  const githubHttpsAuth = new HttpsAuthentication(runner);
  const github = new GitHubClient({ ...options.github, dataDir: options.dataDir });
  const queues = new Map<string, Promise<void>>();
  const active = new Set<Context>();
  const leases = new Map<string, string>();
  let disposed = false;
  let disposal: Promise<void> | undefined;

  function event(value: AppEvent): void { options.onEvent?.(value); }

  function log(ctx: Context, command: string, phase: 'started' | 'progress' | 'completed' | 'failed', message: string): void {
    event({ type: 'command', log: { id: ctx.id, repoId: ctx.repoId, command, phase, message: redact(message), time: new Date().toISOString() } });
  }

  async function serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.then(task);
    const barrier = current.then(() => undefined, () => undefined);
    queues.set(key, barrier);
    try { return await current; } finally { if (queues.get(key) === barrier) queues.delete(key); }
  }

  async function canonicalRoot(input: string, ctx: Execution): Promise<string> {
    let actual: string;
    try {
      actual = await realpath(input);
      if (!(await stat(actual)).isDirectory()) throw new GitError('INVALID_REPOSITORY', 'Select a Git working directory.');
    } catch (error) {
      if (isMissing(error)) throw new GitError('REPOSITORY_MISSING', 'This repository directory is missing. Locate it again or remove its registration.');
      throw error;
    }
    const result = await runner.run(actual, ['rev-parse', '--show-toplevel', '--is-bare-repository'], ctx, { allowedCodes: [0, 128] });
    if (result.code !== 0) throw new GitError('INVALID_REPOSITORY', 'This is not a non-bare Git working directory. Choose the checkout folder, not its .git directory.', result.stderr);
    const output = result.stdout.toString('utf8');
    if (!output.endsWith('\nfalse\n')) throw new GitError('INVALID_REPOSITORY', 'Bare repositories cannot be opened as working directories.');
    const top = await realpath(output.slice(0, -7));
    const directories = await readMetadata(top, ctx);
    for (const directory of [directories.gitDir, directories.commonDir]) {
      if (contains(directory, top) || (contains(top, directory) && !contains(path.join(top, '.git'), directory))) {
        throw new GitError('UNSAFE_REPOSITORY_LAYOUT', 'Git metadata is inside the working tree outside .git, or contains the working tree. Move the metadata outside the checkout (or into .git) before using GitDesk; whole-tree actions could otherwise include or overwrite it.');
      }
    }
    if ('id' in ctx) (ctx as Context).metadata = Promise.resolve(directories);
    return top;
  }

  async function repositoryPath(repoId: string, ctx: Execution = { controller: new AbortController() }): Promise<string> {
    parseCommandArgs('status', { repoId });
    const state = await store.read();
    const repository = state.repositories.find((repo) => repo.id === repoId);
    if (!repository) throw new GitError('REPOSITORY_NOT_REGISTERED', 'This repository is not registered. Add it again before continuing.');
    const root = await canonicalRoot(repository.path, ctx);
    if (root !== repository.path) throw new GitError('REPOSITORY_CHANGED', 'The registered location no longer identifies the same repository. Remove its registration and add the checkout again.');
    return root;
  }

  function route<K extends GitCommand>(
    command: K,
    implementation: (args: CommandArgs<K>, ctx: Context) => Promise<CommandData<K>>,
  ): GitHandlers[K] {
    return (async (input: CommandArgs<K>) => {
      const args = parseCommandArgs(command, input);
      if (disposed) throw new GitError('CANCELLED', 'GitDesk is shutting down.');
      const ctx: Context = { id: randomUUID(), controller: new AbortController() };
      if ('repoId' in args && typeof args.repoId === 'string') {
        ctx.repoId = args.repoId;
        // Unregistration and cancellation must also work for a checkout that has disappeared.
        if (!['removeRepository', 'cancel', 'selectRepository'].includes(command)) ctx.root = await repositoryPath(args.repoId, ctx);
        else if (!(await store.read()).repositories.some((repo) => repo.id === args.repoId)) throw new GitError('REPOSITORY_NOT_REGISTERED', 'This repository is not registered.');
      }
      const mutating = mutations.has(command);
      if (mutating) ctx.progress = (message) => log(ctx, command, 'progress', message);
      const execute = async () => {
        if (mutating) log(ctx, command, 'started', `${command} started.`);
        try {
          if (ctx.controller.signal.aborted) throw new GitError('CANCELLED', 'The queued operation was cancelled.');
          const result = await implementation(args, ctx);
          if (mutating) log(ctx, command, 'completed', `${command} completed.`);
          return result;
        } catch (error) {
          if (mutating) log(ctx, command, 'failed', error instanceof Error ? error.message : 'The operation failed.');
          throw error;
        } finally {
          if (mutating) event({ type: 'changed', repoId: ctx.repoId });
        }
      };
      active.add(ctx);
      try {
        return await (mutating && ctx.root ? serial((await metadata(repo(ctx))).commonDir, execute) : execute());
      } finally { active.delete(ctx); }
    }) as GitHandlers[K];
  }

  function repo(ctx: Context): RepoContext {
    if (!ctx.root || !ctx.repoId) throw new GitError('REPOSITORY_NOT_REGISTERED', 'A registered repository is required.');
    return ctx as RepoContext;
  }

  function contains(directory: string, target: string): boolean {
    const rel = path.relative(directory, target);
    return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  }

  async function readMetadata(root: string, ctx: Execution): Promise<GitMetadata> {
    // Keep these as separate records: either directory name may itself end in LF.
    const gitDir = newline((await runner.run(root, ['rev-parse', '--absolute-git-dir'], ctx)).stdout);
    const commonDir = newline((await runner.run(root, ['rev-parse', '--git-common-dir'], ctx)).stdout);
    return { gitDir: await realpath(gitDir), commonDir: await realpath(path.resolve(root, commonDir)) };
  }

  async function metadata(ctx: RepoContext): Promise<GitMetadata> {
    ctx.metadata ??= readMetadata(ctx.root, ctx);
    return ctx.metadata;
  }

  async function validateRepoPath(ctx: RepoContext, value: string): Promise<void> {
    const absolute = path.join(ctx.root, relativePath(value));
    const directories = await metadata(ctx);
    for (const directory of [directories.gitDir, directories.commonDir]) {
      if (contains(directory, absolute)) {
        throw new GitError('INVALID_PATH', 'Git metadata cannot be read or changed as a repository file.');
      }
    }
  }

  async function filePath(ctx: RepoContext, value: string, allowMissing = true): Promise<string> {
    await validateRepoPath(ctx, value);
    return exactPath(ctx.root, value, allowMissing);
  }

  async function config(ctx: RepoContext, key: string): Promise<string[]> {
    const output = await runner.run(ctx.root, ['config', '--null', '--get-all', key], ctx, { allowedCodes: [0, 1] });
    return output.code === 1 ? [] : output.stdout.toString('utf8').split('\0').slice(0, -1);
  }

  async function validateBranch(ctx: Execution, name: string): Promise<void> {
    if (!name || name.startsWith('-') || name === 'HEAD' || /[\x00-\x20\x7f]/.test(name)) throw new GitError('INVALID_REF', 'Enter a valid Git branch name.');
    const result = await runner.run(undefined, ['check-ref-format', `refs/heads/${name}`], ctx, { allowedCodes: [0, 1] });
    if (result.code !== 0) throw new GitError('INVALID_REF', 'Enter a valid Git branch name without revision expressions or wildcards.');
  }

  async function verifySha(ctx: RepoContext, sha: string): Promise<string> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) throw new GitError('INVALID_REF', 'A full commit ID is required.');
    const result = await runner.run(ctx.root, ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`], ctx, { allowedCodes: [0, 128] });
    if (result.code !== 0 || newline(result.stdout) !== sha) throw new GitError('COMMIT_NOT_FOUND', 'That full commit ID does not identify a commit in this repository.');
    return sha;
  }

  async function refExists(ctx: RepoContext, ref: string): Promise<boolean> {
    const result = await runner.run(ctx.root, ['show-ref', '--verify', '--quiet', '--', ref], ctx, { allowedCodes: [0, 1] });
    return result.code === 0;
  }

  async function namedRef(ctx: RepoContext, name: string): Promise<string> {
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(name)) return verifySha(ctx, name);
    if (name.startsWith('refs/heads/') || name.startsWith('refs/remotes/')) {
      await validateBranch(ctx, name);
      if (await refExists(ctx, name)) return name;
    } else {
      await validateBranch(ctx, name);
      const matches: string[] = [];
      for (const prefix of ['refs/heads/', 'refs/remotes/']) if (await refExists(ctx, prefix + name)) matches.push(prefix + name);
      if (matches.length > 1) throw new GitError('AMBIGUOUS_REF', 'Both a local and remote branch have that name. Use a fully qualified refs/heads/ or refs/remotes/ reference.');
      if (matches[0]) return matches[0];
    }
    throw new GitError('BRANCH_NOT_FOUND', 'That local or remote branch no longer exists. Refresh the branch list.');
  }

  async function operationState(ctx: RepoContext): Promise<OperationState | null> {
    const { gitDir } = await metadata(ctx);
    for (const [file, type, message] of [
      ['rebase-merge', 'rebase', 'Rebase in progress. During rebase, ours is the upstream branch; theirs is the commit being replayed.'],
      ['rebase-apply', 'rebase', 'Rebase in progress. During rebase, ours is upstream; theirs is the commit being replayed.'],
      ['MERGE_HEAD', 'merge', 'Merge in progress. Resolve conflicts, then continue or abort.'],
      ['CHERRY_PICK_HEAD', 'cherry-pick', 'Cherry-pick in progress. Resolve conflicts, then continue or abort.'],
      ['REVERT_HEAD', 'revert', 'Revert in progress. Resolve conflicts, then continue or abort.'],
    ] as const) {
      try { await lstat(path.join(gitDir, file)); return { type, message }; } catch (error) { if (!isMissing(error)) throw error; }
    }
    try {
      const todo = await readFile(path.join(gitDir, 'sequencer', 'todo'), 'utf8');
      if (todo.startsWith('pick ')) return { type: 'cherry-pick', message: 'Cherry-pick sequence in progress.' };
      if (todo.startsWith('revert ')) return { type: 'revert', message: 'Revert sequence in progress.' };
    } catch (error) { if (!isMissing(error)) throw error; }
    return null;
  }

  async function remotes(ctx: RepoContext): Promise<Remote[]> {
    const names = newline((await runner.run(ctx.root, ['remote'], ctx)).stdout);
    if (!names) return [];
    const results: Remote[] = [];
    for (const name of names.split('\n')) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) {
        throw new GitError('UNSUPPORTED_REMOTE', 'A configured remote has an unsafe name. Rename it using Git before managing it in GitDesk.');
      }
      const url = newline((await runner.run(ctx.root, ['remote', 'get-url', '--', name], ctx)).stdout);
      const pushUrl = newline((await runner.run(ctx.root, ['remote', 'get-url', '--push', '--', name], ctx)).stdout);
      results.push({ name, url: redact(url), pushUrl: redact(pushUrl) });
    }
    return results;
  }

  async function rawStatus(ctx: RepoContext): Promise<ReturnType<typeof parseStatus>> {
    return parseStatus((await runner.run(ctx.root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--renames'], ctx)).stdout);
  }

  function leaseKey(ctx: RepoContext, remote: string, target: string): string { return `${ctx.root}\0${remote}\0${target}`; }

  async function observeRemotes(ctx: RepoContext): Promise<void> {
    const result = await runner.run(ctx.root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/remotes/'], ctx);
    for (const record of result.stdout.toString('utf8').split('\n')) {
      if (!record) continue;
      const [ref, sha, symbolic] = record.split('\0');
      if (symbolic) continue;
      const match = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
      if (match) leases.set(leaseKey(ctx, match[1], `refs/heads/${match[2]}`), sha);
    }
  }

  async function status(ctx: RepoContext, observe = false): Promise<RepoStatus> {
    const result = await rawStatus(ctx);
    const remoteList = await remotes(ctx);
    const operation = await operationState(ctx);
    if (observe) await observeRemotes(ctx);
    return { ...result, remotes: remoteList, operation };
  }

  async function guardIdle(ctx: RepoContext, clean = false): Promise<ReturnType<typeof parseStatus>> {
    const currentOperation = await operationState(ctx);
    if (currentOperation) throw new GitError('OPERATION_IN_PROGRESS', `A ${currentOperation.type} is already in progress. Continue or abort it first.`);
    const state = await rawStatus(ctx);
    if (state.files.some((file) => file.conflicted)) throw new GitError('CONFLICT', 'Resolve existing conflicts before continuing.');
    if (clean && state.files.length) throw new GitError('DIRTY_WORKTREE', 'Commit or stash all staged, unstaged, and untracked changes first. GitDesk never automatically discards or stashes them.');
    return state;
  }

  async function selectedFiles(ctx: RepoContext, paths: string[]): Promise<StatusFile[]> {
    const state = await rawStatus(ctx);
    const result: StatusFile[] = [];
    for (const value of [...new Set(paths)]) {
      await filePath(ctx, value);
      const selected = state.files.find((file) => file.path === value);
      if (!selected) throw new GitError('FILE_NOT_CHANGED', 'A selected file is no longer changed. Refresh the repository.');
      if (selected.oldPath) await filePath(ctx, selected.oldPath);
      result.push(selected);
    }
    return result;
  }

  function pathsFor(files: StatusFile[], includeOld: boolean): string[] {
    return [...new Set(files.flatMap((file) => includeOld && file.oldPath ? [file.path, file.oldPath] : [file.path]))];
  }

  async function commitRecord(ctx: RepoContext, sha: string): Promise<Commit> {
    await verifySha(ctx, sha);
    const commits = parseCommits((await runner.run(ctx.root, ['log', '-z', '-1', `--format=${COMMIT_FORMAT}`, sha, '--'], ctx)).stdout);
    if (!commits[0]) throw new GitError('COMMIT_NOT_FOUND', 'That commit no longer exists.');
    return commits[0];
  }

  async function parentTree(ctx: RepoContext, commit: Commit): Promise<string> {
    if (commit.parents[0]) return commit.parents[0];
    return newline((await runner.run(ctx.root, ['hash-object', '-t', 'tree', '--stdin'], ctx, { input: '' })).stdout);
  }

  async function changedFiles(ctx: RepoContext, commit: Commit): Promise<ChangedFile[]> {
    return parseChangedFiles((await runner.run(ctx.root, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '-M', await parentTree(ctx, commit), commit.sha, '--'], ctx)).stdout);
  }

  async function appState(ctx: Context): Promise<AppState> {
    const state = await store.read();
    let gitVersion: string | null;
    try { gitVersion = newline((await runner.run(undefined, ['--version'], ctx)).stdout); } catch (error) {
      if (!(error instanceof GitError && error.code === 'GIT_UNAVAILABLE')) throw error;
      gitVersion = null;
    }
    return { repositories: state.repositories, selectedRepoId: state.selectedRepoId, theme: state.theme, defaultBranch: state.defaultBranch, gitVersion };
  }

  async function register(root: string): Promise<Repository> {
    return store.update((state) => {
      let repository = state.repositories.find((item) => item.path === root);
      if (!repository) {
        repository = { id: randomUUID(), name: path.basename(root) || root, path: root };
        state.repositories.push(repository);
      }
      state.selectedRepoId = repository.id;
      return structuredClone(repository);
    });
  }

  async function stashList(ctx: RepoContext): Promise<Stash[]> {
    const output = await runner.run(ctx.root, ['stash', 'list', '-z', '--format=%gd%x00%H%x00%gs%x00%cI'], ctx);
    const fields = output.stdout.toString('utf8').split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 4 !== 0) throw new GitError('INVALID_GIT_OUTPUT', 'Git returned an invalid stash list.');
    const list: Stash[] = [];
    for (let index = 0; index < fields.length; index += 4) list.push({ ref: fields[index], sha: fields[index + 1], message: fields[index + 2], date: fields[index + 3] });
    return list;
  }

  async function safeRemote(ctx: RepoContext, name: string, pushing: boolean): Promise<string> {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)) throw new GitError('INVALID_REMOTE', 'The remote name is invalid.');
    const urls = await config(ctx, `remote.${name}.url`);
    if (urls.length !== 1) throw new GitError('UNSUPPORTED_REMOTE', 'The remote must have exactly one fetch URL.');
    const packProgram = pushing ? 'receivepack' : 'uploadpack';
    const standardProgram = pushing ? 'git-receive-pack' : 'git-upload-pack';
    if ((await config(ctx, `remote.${name}.${packProgram}`)).some((value) => value !== standardProgram) ||
        (await config(ctx, `remote.${name}.vcs`)).length) {
      throw new GitError('UNSUPPORTED_REMOTE', 'Custom remote helper and upload/receive programs are not permitted. Use a standard Git remote transport.');
    }
    await approvedUrl(urls[0], ctx.root);
    const effective = newline((await runner.run(ctx.root, ['remote', 'get-url', '--', name], ctx)).stdout);
    await approvedUrl(effective, ctx.root);
    const fetchSpecs = await config(ctx, `remote.${name}.fetch`);
    if (fetchSpecs.length !== 1 || fetchSpecs[0] !== `+refs/heads/*:refs/remotes/${name}/*`) {
      throw new GitError('UNSUPPORTED_REMOTE', 'GitDesk requires the standard remote branch fetch mapping. Custom or ambiguous refspecs must be managed with Git.');
    }
    if (pushing) {
      const pushUrls = await config(ctx, `remote.${name}.pushurl`);
      const effectivePush = newline((await runner.run(ctx.root, ['remote', 'get-url', '--push', '--', name], ctx)).stdout);
      await approvedUrl(effectivePush, ctx.root);
      if (pushUrls.length > 1 || (pushUrls.length === 1 && pushUrls[0] !== urls[0]) || effectivePush !== effective ||
          (await config(ctx, `remote.${name}.push`)).length || (await config(ctx, `remote.${name}.mirror`)).some((value) => value !== 'false')) {
        throw new GitError('UNSUPPORTED_REMOTE', 'A different push URL, custom push refspec, or mirror setting makes this push ambiguous. Use matching fetch/push URLs and standard branch mappings.');
      }
    }
    return effective;
  }

  async function networkTarget(ctx: RepoContext, selected: string | undefined, pushing: boolean): Promise<{
    remote: string; branch: string; target: string; upstream: boolean; head: string; url: string;
  }> {
    const current = await rawStatus(ctx);
    if (current.unborn || current.detached || !current.head) throw new GitError('BRANCH_REQUIRED', 'Check out a branch with at least one commit first.');
    await validateBranch(ctx, current.branch);
    const branchRemotes = await config(ctx, `branch.${current.branch}.remote`);
    const mergeRefs = await config(ctx, `branch.${current.branch}.merge`);
    if (branchRemotes.length > 1 || mergeRefs.length > 1 || (branchRemotes.length !== mergeRefs.length)) throw new GitError('UNSUPPORTED_REMOTE', 'The current branch has an ambiguous upstream configuration.');
    const list = await remotes(ctx);
    const remote = selected ?? branchRemotes[0] ?? (list.some((item) => item.name === 'origin') ? 'origin' : list.length === 1 ? list[0].name : '');
    if (!remote || !list.some((item) => item.name === remote)) throw new GitError('REMOTE_REQUIRED', 'Select a configured remote before continuing.');
    if (branchRemotes[0] && branchRemotes[0] !== remote) throw new GitError('UPSTREAM_MISMATCH', 'The selected remote differs from this branch’s upstream. Switch to its upstream remote or configure the branch explicitly with Git.');
    const target = mergeRefs[0] ?? `refs/heads/${current.branch}`;
    if (!target.startsWith('refs/heads/')) throw new GitError('UNSUPPORTED_REMOTE', 'The upstream must point to a remote branch.');
    await validateBranch(ctx, target.slice(11));
    if (pushing) {
      const pushRemote = await config(ctx, `branch.${current.branch}.pushRemote`);
      const pushDefault = await config(ctx, 'remote.pushDefault');
      if (pushRemote.some((value) => value !== remote) || (!pushRemote.length && pushDefault.some((value) => value !== remote))) {
        throw new GitError('UNSUPPORTED_REMOTE', 'This branch is configured to push to a different remote. GitDesk will not silently choose a different destination.');
      }
    }
    const url = await safeRemote(ctx, remote, pushing);
    return { remote, branch: current.branch, target, upstream: Boolean(branchRemotes[0]), head: current.head, url };
  }

  async function networkRun(cwd: string | undefined, args: string[], ctx: Context, url: string) {
    return serial('github-https', async () => {
      const credentials = await github.credentials(url);
      if (!credentials) return httpsAuth.run(cwd, args, ctx, url);
      try {
        await githubHttpsAuth.set(url, credentials.username, credentials.password, ctx);
        return await githubHttpsAuth.run(cwd, args, ctx, url);
      } catch (error) {
        if (error instanceof GitError && error.code === 'AUTHENTICATION_FAILED') {
          throw new GitError('GITHUB_AUTH_REQUIRED', 'GitHub rejected the signed-in account credential. Sign in again in GitHub repositories and check token access, Contents permissions and organization SSO authorization.');
        }
        throw error;
      } finally { await githubHttpsAuth.forget(url); }
    });
  }

  async function clone(url: string, parentPath: string, name: string, ctx: Context): Promise<Repository> {
    await approvedUrl(url);
    const destination = await newDestination(parentPath, name);
    return serial(destination, async () => {
      await mkdir(destination, { mode: 0o755 });
      try {
        await networkRun(path.dirname(destination), ['clone', '--progress', '--no-recurse-submodules', '--', url, destination], ctx, url);
      } catch (error) {
        throw new GitError(error instanceof GitError ? error.code : 'CLONE_FAILED', `Clone did not complete. The new destination may contain partial data: ${destination}. Inspect it before retrying; no existing directory was removed.`, error instanceof GitError ? error.detail ?? error.message : error instanceof Error ? error.message : undefined);
      }
      return register(await canonicalRoot(destination, ctx));
    });
  }

  const handlers: GitHandlers = {
    githubAccount: route('githubAccount', async () => github.status()),
    githubSignIn: route('githubSignIn', async args => github.signInToken(args.token, args.remember)),
    githubImportCli: route('githubImportCli', async args => github.importCli(args.remember)),
    githubBeginLogin: route('githubBeginLogin', async args => github.beginLogin(args.clientId, args.remember)),
    githubPollLogin: route('githubPollLogin', async () => github.pollLogin()),
    githubCancelLogin: route('githubCancelLogin', async () => github.cancelLogin()),
    githubSignOut: route('githubSignOut', async () => github.signOut()),
    githubRepositories: route('githubRepositories', async args => github.listRepositories(args.page)),
    githubClone: route('githubClone', async (args, ctx) => {
      const remote = await github.getRepository(args.fullName, ctx.controller.signal);
      return clone(githubCloneUrl(remote.fullName), args.parentPath, args.name, ctx);
    }),
    githubCreate: route('githubCreate', async (args, ctx) => github.createRepository(args.name, args.description, args.confirmed, ctx.controller.signal)),
    githubPublish: route('githubPublish', async (args, context): Promise<GitHubRepository> => {
      requireConfirmation(args.confirmed);
      const ctx = repo(context);
      const initial = await guardIdle(ctx, true);
      if (!initial.head || initial.unborn || initial.detached) throw new GitError('BRANCH_REQUIRED', 'Create a commit on a local branch before publishing to GitHub.');
      if ((await remotes(ctx)).some(remote => remote.name === args.remote)) throw new GitError('REMOTE_EXISTS', 'That remote name already exists. Choose an unused name; GitDesk never overwrites existing remotes.');
      if (initial.upstream || (await config(ctx, `branch.${initial.branch}.remote`)).length) {
        throw new GitError('UPSTREAM_EXISTS', 'This branch already tracks a remote. Create a new local branch without an upstream before publishing a separate GitHub repository.');
      }
      if ((await config(ctx, 'remote.pushDefault')).length || (await config(ctx, `branch.${initial.branch}.pushRemote`)).length) {
        throw new GitError('UNSUPPORTED_REMOTE', 'Custom push destination configuration prevents safe publication. Use Git to review it first.');
      }
      const created = await github.createRepository(args.name, args.description, true, ctx.controller.signal);
      let remoteAdded = false;
      try {
        const current = await guardIdle(ctx, true);
        if (current.head !== initial.head || current.branch !== initial.branch) throw new GitError('REPOSITORY_CHANGED', 'The current branch changed while the GitHub repository was being created.');
        if ((await remotes(ctx)).some(remote => remote.name === args.remote)) throw new GitError('REMOTE_EXISTS', 'The chosen remote name was added externally while publishing.');
        await runner.run(ctx.root, ['remote', 'add', '--', args.remote, githubCloneUrl(created.fullName)], ctx);
        remoteAdded = true;
        const target = await networkTarget(ctx, args.remote, true);
        await networkRun(ctx.root, ['push', '--progress', '--no-follow-tags', '--recurse-submodules=no', '--set-upstream', '--', args.remote, `refs/heads/${initial.branch}:refs/heads/${initial.branch}`], ctx, target.url);
        leases.set(leaseKey(ctx, args.remote, `refs/heads/${initial.branch}`), initial.head);
        return created;
      } catch (error) {
        throw new GitError('GITHUB_PUBLISH_INCOMPLETE', `Private GitHub repository ${created.fullName} was created, but publishing did not complete.`,
          `${remoteAdded ? `Local remote "${args.remote}" was kept. Refresh and retry a normal Push; do not create another repository.` : 'No remote was overwritten. Add the new GitHub repository as a remote to recover.'}\nhttps://github.com/${created.fullName}\n${error instanceof GitError ? error.message : 'The local Git operation failed.'}`);
      }
    }),
    getHttpsAuth: route('getHttpsAuth', async ({ url }) => httpsAuth.status(url)),
    setHttpsCredentials: route('setHttpsCredentials', async ({ url, username, password }, ctx) => httpsAuth.set(url, username, password, ctx)),
    forgetHttpsCredentials: route('forgetHttpsCredentials', async ({ url }) => httpsAuth.forget(url)),
    getAppState: route('getAppState', async (_args, ctx) => appState(ctx)),
    setPreferences: route('setPreferences', async (args, ctx) => {
      if (args.defaultBranch !== undefined) await validateBranch(ctx, args.defaultBranch);
      await store.update((state) => {
        if (args.theme !== undefined) state.theme = args.theme;
        if (args.defaultBranch !== undefined) state.defaultBranch = args.defaultBranch;
      });
      return appState(ctx);
    }),
    selectRepository: route('selectRepository', async (args) => {
      if (args.repoId) await repositoryPath(args.repoId);
      await store.update((state) => {
        if (args.repoId && !state.repositories.some((repository) => repository.id === args.repoId)) throw new GitError('REPOSITORY_NOT_REGISTERED', 'This repository was removed before it could be selected.');
        state.selectedRepoId = args.repoId;
      });
    }),
    addRepository: route('addRepository', async (args, ctx) => register(await canonicalRoot(args.path, ctx))),
    initRepository: route('initRepository', async (args, ctx) => {
      await validateBranch(ctx, args.defaultBranch);
      const destination = await newDestination(args.parentPath, args.name);
      return serial(destination, async () => {
        await mkdir(destination, { mode: 0o755 });
        await runner.run(destination, ['init', `--initial-branch=${args.defaultBranch}`, '--', '.'], ctx);
        return register(await canonicalRoot(destination, ctx));
      });
    }),
    cloneRepository: route('cloneRepository', async (args, ctx) => clone(await approvedUrl(args.url), args.parentPath, args.name, ctx)),
    removeRepository: route('removeRepository', async (args) => {
      await store.update((state) => {
        state.repositories = state.repositories.filter((item) => item.id !== args.repoId);
        if (state.selectedRepoId === args.repoId) state.selectedRepoId = state.repositories[0]?.id ?? null;
      });
    }),
    status: route('status', async (_args, ctx) => status(repo(ctx), true)),
    diff: route('diff', async (args, context) => {
      const ctx = repo(context);
      await validateRepoPath(ctx, args.path);
      let paths = [args.path];
      let diffArgs: string[];
      if (args.source === 'commit') {
        if (!args.commit) throw new GitError('INVALID_INPUT', 'Select a full commit ID to inspect its diff.');
        const commit = await commitRecord(ctx, args.commit);
        const file = (await changedFiles(ctx, commit)).find((item) => item.path === args.path);
        if (!file) return { path: args.path, text: '', binary: false, tooLarge: false, message: 'This file was not changed by the selected commit.' };
        if (file.oldPath) { await validateRepoPath(ctx, file.oldPath); paths.push(file.oldPath); }
        diffArgs = ['diff', await parentTree(ctx, commit), commit.sha];
      } else {
        await filePath(ctx, args.path);
        const file = (await rawStatus(ctx)).files.find((item) => item.path === args.path);
        if (!file || (args.source === 'staged' && !file.staged) || (args.source === 'working' && !file.unstaged)) {
          return { path: args.path, text: '', binary: false, tooLarge: false, message: 'There are no changes in this view.' };
        }
        if (file.oldPath) { await filePath(ctx, file.oldPath); paths.push(file.oldPath); }
        if (args.source === 'working' && file.untracked) {
          const absolute = await filePath(ctx, args.path, false);
          const info = await lstat(absolute);
          if (info.isSymbolicLink()) {
            const target = await readlink(absolute);
            return { path: args.path, text: `new symlink ${args.path}\n+${target}\n`, binary: false, tooLarge: false };
          }
          if (info.size > DIFF_LIMIT) return { path: args.path, text: '', binary: false, tooLarge: true, message: 'The diff exceeds the 2 MiB display limit. Open the file in an external editor.' };
          const output = await runner.run(ctx.root, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', absolute], ctx, { maxBytes: DIFF_LIMIT, allowTooLarge: true, allowedCodes: [0, 1] });
          const text = output.stdout.toString('utf8');
          return { path: args.path, text, binary: /^Binary files /m.test(text), tooLarge: output.tooLarge, ...(output.tooLarge ? { message: 'The diff exceeds the 2 MiB display limit.' } : !text ? { message: 'This is an empty untracked file.' } : {}) };
        }
        diffArgs = args.source === 'staged' ? ['diff', '--cached'] : ['diff'];
      }
      const output = await runner.run(ctx.root, [...diffArgs, '--no-ext-diff', '--no-textconv', '--no-color', '-M', '--', ...paths], ctx, { maxBytes: DIFF_LIMIT, allowTooLarge: true });
      const text = output.stdout.toString('utf8');
      return { path: args.path, text, binary: /^Binary files /m.test(text), tooLarge: output.tooLarge, ...(output.tooLarge ? { message: 'The diff exceeds the 2 MiB display limit. Open it externally.' } : !text ? { message: 'There are no textual changes in this view.' } : {}) };
    }),
    history: route('history', async (args, context) => {
      const ctx = repo(context);
      if ((await rawStatus(ctx)).unborn) return { commits: [], hasMore: false };
      if (!args.search) {
        const commits = parseCommits((await runner.run(ctx.root, ['log', '-z', `--format=${COMMIT_FORMAT}`, `--skip=${args.skip}`, `--max-count=${args.limit + 1}`, 'HEAD', '--'], ctx)).stdout);
        return { commits: commits.slice(0, args.limit), hasMore: commits.length > args.limit };
      }
      const search = args.search.toLocaleLowerCase();
      const matches: Commit[] = [];
      let skipped = 0;
      for (let offset = 0; ; offset += 200) {
        const page = parseCommits((await runner.run(ctx.root, ['log', '-z', `--format=${COMMIT_FORMAT}`, `--skip=${offset}`, '--max-count=200', 'HEAD', '--'], ctx)).stdout);
        for (const commit of page) {
          if (![commit.sha, commit.summary, commit.body, commit.author, commit.email].some((text) => text.toLocaleLowerCase().includes(search))) continue;
          if (skipped++ < args.skip) continue;
          matches.push(commit);
          if (matches.length > args.limit) return { commits: matches.slice(0, args.limit), hasMore: true };
        }
        if (page.length < 200) return { commits: matches, hasMore: false };
      }
    }),
    commitDetails: route('commitDetails', async (args, context) => {
      const ctx = repo(context);
      const commit = await commitRecord(ctx, args.sha);
      return { commit, files: await changedFiles(ctx, commit) };
    }),
    stage: route('stage', async (args, context) => {
      const ctx = repo(context);
      const files = await selectedFiles(ctx, args.paths);
      if (files.some((file) => file.conflicted)) throw new GitError('CONFLICT', 'Use the conflict resolution actions before staging conflicted files.');
      const paths = pathsFor(files, !args.stage);
      const input = `${paths.join('\0')}\0`;
      const pathspec = ['--pathspec-from-file=-', '--pathspec-file-nul', '--'];
      if (args.stage) await runner.run(ctx.root, ['add', ...pathspec], ctx, { input });
      else if ((await rawStatus(ctx)).unborn) await runner.run(ctx.root, ['rm', '--cached', '--force', '--ignore-unmatch', ...pathspec], ctx, { input });
      else await runner.run(ctx.root, ['restore', '--staged', '--source=HEAD', ...pathspec], ctx, { input });
    }),
    commit: route('commit', async (args, context) => {
      const ctx = repo(context);
      if (!args.summary.trim() || /[\r\n]/.test(args.summary)) throw new GitError('INVALID_INPUT', 'Write a non-empty, single-line commit summary.');
      const state = await rawStatus(ctx);
      if (state.files.some((file) => file.conflicted)) throw new GitError('CONFLICT', 'Resolve all conflicts before committing.');
      const operation = await operationState(ctx);
      if (operation && operation.type !== 'merge') throw new GitError('OPERATION_IN_PROGRESS', 'Use Continue to finish the active operation.');
      if (args.amend) {
        requireConfirmation(args.confirmed);
        if (state.unborn || operation) throw new GitError('AMEND_NOT_AVAILABLE', 'Amend requires an existing commit and no active operation.');
      } else if (!state.files.some((file) => file.staged) && !operation) throw new GitError('NOTHING_STAGED', 'Stage at least one change before committing. Unstaged and untracked files are never added automatically.');
      await runner.run(ctx.root, ['commit', ...(args.amend ? ['--amend'] : []), '--file=-'], ctx, { input: `${args.summary.trim()}\n\n${args.description}\n` });
    }),
    discard: route('discard', async (args, context) => {
      requireConfirmation(args.confirmed);
      const ctx = repo(context);
      const files = await selectedFiles(ctx, args.paths);
      if (files.some((file) => file.conflicted)) throw new GitError('CONFLICT', 'Use conflict resolution or abort instead of discarding conflicted data.');
      if (files.some((file) => !file.unstaged)) throw new GitError('NO_UNSTAGED_CHANGES', 'Discard applies only to unstaged changes. Staged data is preserved.');
      for (const file of files) {
        const absolute = await filePath(ctx, file.path);
        if (file.untracked) await unlink(absolute);
        else await runner.run(ctx.root, ['restore', '--worktree', '--', file.path], ctx);
      }
    }),
    ignore: route('ignore', async (args, context) => {
      const ctx = repo(context);
      const files = await selectedFiles(ctx, args.paths);
      if (files.some((file) => !file.untracked)) throw new GitError('TRACKED_FILE', 'Ignore rules do not affect tracked files. Select only untracked files.');
      if (files.some((file) => /[\r\n]/.test(file.path))) throw new GitError('UNSUPPORTED_PATH', 'Git ignore files cannot represent a literal filename containing a newline.');
      const target = await filePath(ctx, '.gitignore');
      try {
        if ((await lstat(target)).isSymbolicLink()) throw new GitError('UNSAFE_PATH', '.gitignore is a symlink. Replace it with a regular repository-local file before appending ignore rules.');
      } catch (error) { if (!isMissing(error)) throw error; }
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o644);
      try {
        if (!(await handle.stat()).isFile()) throw new GitError('UNSAFE_PATH', '.gitignore must be a regular file, not a symlink or special file.');
        const patterns = files.map((file) => `/${file.path.replace(/[\\*?[\]#! \t]/g, '\\$&')}`);
        await handle.writeFile(`\n${patterns.join('\n')}\n`);
      } finally { await handle.close(); }
    }),
    branches: route('branches', async (_args, context) => {
      const ctx = repo(context);
      const output = await runner.run(ctx.root, ['for-each-ref', '--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(symref)', 'refs/heads/', 'refs/remotes/'], ctx);
      const branches: Branch[] = [];
      for (const line of output.stdout.toString('utf8').split('\n')) {
        if (!line) continue;
        const [ref, current, upstream, symbolic] = line.split('\0');
        if (symbolic) continue;
        const remote = ref.startsWith('refs/remotes/');
        branches.push({ name: ref.slice(remote ? 13 : 11), current: current === '*', remote, upstream: upstream || null });
      }
      const current = await rawStatus(ctx);
      if (current.unborn) branches.unshift({ name: current.branch, current: true, remote: false, upstream: null });
      await observeRemotes(ctx);
      return branches;
    }),
    branch: route('branch', async (args, context) => {
      const ctx = repo(context);
      await validateBranch(ctx, args.name);
      const current = await guardIdle(ctx, args.action === 'switch');
      if (args.action === 'create') {
        const from = args.from ? await namedRef(ctx, args.from) : undefined;
        if (await refExists(ctx, `refs/heads/${args.name}`)) throw new GitError('BRANCH_EXISTS', 'A local branch with that name already exists.');
        if (current.files.length && !args.dirtyAction) {
          throw new GitError('DIRTY_WORKTREE', 'Choose whether to bring your local changes to the new branch or stash them first.');
        }
        if (current.files.length && args.dirtyAction === 'stash') {
          if (current.unborn) throw new GitError('COMMIT_REQUIRED', 'Create an initial commit before stashing changes.');
          await runner.run(ctx.root, ['stash', 'push', '--include-untracked', '--message', `Before creating branch ${args.name}`], ctx);
        }
        await runner.run(ctx.root, ['switch', '--no-track', '-c', args.name, ...(from ? ['--', from] : [])], ctx);
      } else if (args.action === 'switch') {
        const ref = await namedRef(ctx, args.name);
        if (ref.startsWith('refs/remotes/')) {
          const local = ref.slice(13).split('/').slice(1).join('/');
          await validateBranch(ctx, local);
          if (await refExists(ctx, `refs/heads/${local}`)) throw new GitError('BRANCH_EXISTS', 'A local branch with that name already exists. Switch to the local branch explicitly.');
          await runner.run(ctx.root, ['switch', '--track', '-c', local, '--', ref], ctx);
        } else if (ref.startsWith('refs/heads/')) await runner.run(ctx.root, ['switch', '--', ref.slice(11)], ctx);
        else throw new GitError('INVALID_REF', 'Use the confirmed detached checkout action to check out a commit.');
      } else if (args.action === 'rename') {
        const from = args.from ?? (current.detached ? '' : current.branch);
        await validateBranch(ctx, from);
        await runner.run(ctx.root, ['branch', '-m', '--', from, args.name], ctx);
      } else {
        requireConfirmation(args.confirmed);
        const protectedNames = new Set(['main', 'master', (await store.read()).defaultBranch, current.branch]);
        const heads = await runner.run(ctx.root, ['for-each-ref', '--format=%(symref)', 'refs/remotes/'], ctx);
        for (const ref of heads.stdout.toString('utf8').split('\n')) if (ref.startsWith('refs/remotes/')) protectedNames.add(ref.slice(13).split('/').slice(1).join('/'));
        if (protectedNames.has(args.name)) throw new GitError('PROTECTED_BRANCH', 'The current branch and default branches cannot be deleted in GitDesk.');
        await runner.run(ctx.root, ['branch', '-d', '--', args.name], ctx);
      }
    }),
    network: route('network', async (args, context) => {
      const ctx = repo(context);
      if (args.action === 'fetch') {
        const list = await remotes(ctx);
        const remote = args.remote ?? (list.some((item) => item.name === 'origin') ? 'origin' : list.length === 1 ? list[0].name : '');
        if (!remote || !list.some((item) => item.name === remote)) throw new GitError('REMOTE_REQUIRED', 'Select a configured remote to fetch.');
        const url = await safeRemote(ctx, remote, false);
        await networkRun(ctx.root, ['fetch', '--progress', '--no-recurse-submodules', '--', remote], ctx, url);
        await observeRemotes(ctx);
        return;
      }
      await guardIdle(ctx, args.action === 'pull' || args.action === 'pullRebase');
      if (args.action === 'forcePush') requireConfirmation(args.confirmed);
      const target = await networkTarget(ctx, args.remote, args.action === 'push' || args.action === 'forcePush');
      if (args.action === 'pull' || args.action === 'pullRebase') {
        if (!target.upstream) throw new GitError('UPSTREAM_REQUIRED', 'Publish this branch or configure an upstream before pulling.');
        await networkRun(ctx.root, ['-c', 'rebase.autoStash=false', '-c', 'merge.autoStash=false', 'pull', '--progress', '--no-autostash', '--no-recurse-submodules', ...(args.action === 'pullRebase' ? ['--rebase'] : ['--no-rebase', '--no-edit']), '--', target.remote, target.target], ctx, target.url);
        await observeRemotes(ctx);
        return;
      }
      const pushArgs = ['push', '--progress', '--no-follow-tags', '--recurse-submodules=no'];
      if (args.action === 'forcePush') {
        const expected = leases.get(leaseKey(ctx, target.remote, target.target));
        if (!expected) throw new GitError('LEASE_REQUIRED', 'Fetch and review this remote branch before force pushing. No previously observed remote tip is available.');
        if (target.head !== expected) {
          const ahead = await runner.run(ctx.root, ['merge-base', '--is-ancestor', target.head, expected], ctx, { allowedCodes: [0, 1] });
          if (ahead.code === 0) throw new GitError('REMOTE_AHEAD', 'The observed remote branch is ahead of the local branch. Pull and review its commits instead of overwriting them.');
        }
        pushArgs.push(`--force-with-lease=${target.target}:${expected}`);
      }
      if (!target.upstream) pushArgs.push('--set-upstream');
      pushArgs.push('--', target.remote, `refs/heads/${target.branch}:${target.target}`);
      await networkRun(ctx.root, pushArgs, ctx, target.url);
      leases.set(leaseKey(ctx, target.remote, target.target), target.head);
    }),
    integrate: route('integrate', async (args, context) => {
      const ctx = repo(context);
      const current = await guardIdle(ctx, true);
      if (current.unborn || current.detached) throw new GitError('BRANCH_REQUIRED', 'Check out an existing local branch before merging or rebasing.');
      const target = await namedRef(ctx, args.branch);
      await runner.run(ctx.root, args.action === 'merge'
        ? ['merge', '--no-edit', '--no-autostash', '--', target]
        : ['rebase', '--no-autostash', '--', target], ctx);
    }),
    commitAction: route('commitAction', async (args, context) => {
      requireConfirmation(args.confirmed);
      const ctx = repo(context);
      const current = await guardIdle(ctx, true);
      await verifySha(ctx, args.sha);
      if (args.action === 'checkout') await runner.run(ctx.root, ['switch', '--detach', '--', args.sha], ctx);
      else {
        if (current.detached || current.unborn) throw new GitError('BRANCH_REQUIRED', 'Check out an existing local branch before reverting or cherry-picking.');
        if ((await commitRecord(ctx, args.sha)).parents.length > 1) throw new GitError('MAINLINE_REQUIRED', 'Merge commits require an explicit mainline parent. Revert or cherry-pick them using Git.');
        await runner.run(ctx.root, [args.action === 'revert' ? 'revert' : 'cherry-pick', '--no-edit', '--', args.sha], ctx);
      }
    }),
    stashes: route('stashes', async (_args, ctx) => stashList(repo(ctx))),
    stash: route('stash', async (args, context) => {
      const ctx = repo(context);
      const state = await guardIdle(ctx, args.action === 'apply' || args.action === 'pop');
      if (args.action === 'save') {
        if (typeof args.includeUntracked !== 'boolean') throw new GitError('INVALID_INPUT', 'Explicitly choose whether this stash includes untracked files.');
        if (state.unborn) throw new GitError('COMMIT_REQUIRED', 'Create an initial commit before saving a stash.');
        if (!state.files.some((file) => !file.untracked || args.includeUntracked)) throw new GitError('NOTHING_TO_STASH', 'There are no selected kinds of changes to stash.');
        await runner.run(ctx.root, ['stash', 'push', ...(args.includeUntracked ? ['--include-untracked'] : []), '--message', args.message || 'GitDesk stash'], ctx);
      } else {
        requireConfirmation(args.confirmed);
        if (!args.ref || !(await stashList(ctx)).some((item) => item.ref === args.ref)) throw new GitError('STASH_NOT_FOUND', 'Select an existing stash and refresh if its number has changed.');
        await runner.run(ctx.root, ['stash', args.action, ...(args.action === 'drop' ? [] : ['--index']), '--', args.ref], ctx);
      }
    }),
    resolve: route('resolve', async (args, context) => {
      const ctx = repo(context);
      const files = await selectedFiles(ctx, args.paths);
      if (files.some((file) => !file.conflicted)) throw new GitError('NOT_CONFLICTED', 'Select only files that are currently conflicted.');
      if (args.choice !== 'mark') requireConfirmation(args.confirmed);
      if ((await operationState(ctx))?.type === 'rebase') ctx.progress?.('Rebase terminology: ours is the upstream branch; theirs is the commit being replayed.');
      const stages = (await runner.run(ctx.root, ['ls-files', '--unmerged', '-z'], ctx)).stdout.toString('utf8').split('\0').filter(Boolean);
      for (const file of files) {
        const absolute = await filePath(ctx, file.path);
        if (args.choice === 'mark') {
          let content: Buffer | undefined;
          try {
            if ((await lstat(absolute)).isSymbolicLink()) {
              requireConfirmation(args.confirmed);
              content = Buffer.from(await readlink(absolute), 'utf8');
            } else content = await readExactFile(ctx.root, file.path, DIFF_LIMIT);
          } catch (error) {
            if (!isMissing(error) && !(error instanceof GitError && error.code === 'FILE_NOT_FOUND')) throw error;
          }
          if (content && /^(?:<{7,}|={7,}|>{7,}|\|{7,})(?:[ \t].*)?\r?$/m.test(content.toString('utf8'))) {
            throw new GitError('CONFLICT_MARKERS', 'Conflict markers remain in this file. Remove them and inspect the resolution before marking it resolved.');
          }
          if (content?.includes(0)) requireConfirmation(args.confirmed);
        } else {
          const stage = args.choice === 'ours' ? '2' : '3';
          const present = stages.some((record) => {
            const tab = record.indexOf('\t');
            return record.slice(tab + 1) === file.path && record.slice(0, tab).endsWith(` ${stage}`);
          });
          if (present) await runner.run(ctx.root, ['checkout', `--${args.choice}`, '--', file.path], ctx);
          else {
            try { await unlink(absolute); } catch (error) { if (!isMissing(error)) throw error; }
          }
        }
        await filePath(ctx, file.path);
        await runner.run(ctx.root, ['add', '-A', '--', file.path], ctx);
      }
    }),
    operation: route('operation', async (args, context) => {
      const ctx = repo(context);
      const operation = await operationState(ctx);
      if (!operation) throw new GitError('NO_OPERATION', 'There is no merge, rebase, cherry-pick, or revert to continue or abort.');
      if (args.action === 'abort') requireConfirmation(args.confirmed);
      else if ((await rawStatus(ctx)).files.some((file) => file.conflicted)) throw new GitError('CONFLICT', 'Resolve and stage all conflicted files before continuing.');
      if (args.action === 'continue' && operation.type === 'merge') await runner.run(ctx.root, ['commit', '--no-edit'], ctx);
      else await runner.run(ctx.root, [operation.type, `--${args.action}`], ctx);
    }),
    getRepoSettings: route('getRepoSettings', async (_args, context) => {
      const ctx = repo(context);
      return { name: (await config(ctx, 'user.name')).at(-1) ?? '', email: (await config(ctx, 'user.email')).at(-1) ?? '', remotes: await remotes(ctx) };
    }),
    setIdentity: route('setIdentity', async (args, context) => {
      const ctx = repo(context);
      if (!args.name.trim() || !args.email.trim() || /[\r\n<>]/.test(args.name + args.email)) throw new GitError('INVALID_INPUT', 'Enter a non-empty Git identity without newlines or angle brackets.');
      await runner.run(ctx.root, ['config', '--local', '--replace-all', '--', 'user.name', args.name.trim()], ctx);
      await runner.run(ctx.root, ['config', '--local', '--replace-all', '--', 'user.email', args.email.trim()], ctx);
    }),
    remote: route('remote', async (args, context) => {
      const ctx = repo(context);
      if (args.action === 'remove') {
        requireConfirmation(args.confirmed);
        await runner.run(ctx.root, ['remote', 'remove', '--', args.name], ctx);
      } else {
        if (!args.url) throw new GitError('INVALID_URL', 'Enter a remote URL.');
        const url = await approvedUrl(args.url, ctx.root);
        if (args.action === 'edit') {
          requireConfirmation(args.confirmed);
          if ((await config(ctx, `remote.${args.name}.url`)).length !== 1 || (await config(ctx, `remote.${args.name}.pushurl`)).length) throw new GitError('UNSUPPORTED_REMOTE', 'Edit remotes with multiple URLs or a separate push URL using Git.');
          await runner.run(ctx.root, ['remote', 'set-url', '--', args.name, url], ctx);
        } else await runner.run(ctx.root, ['remote', 'add', '--', args.name, url], ctx);
      }
      for (const key of leases.keys()) if (key.startsWith(`${ctx.root}\0${args.name}\0`)) leases.delete(key);
    }),
    cancel: route('cancel', async (args) => {
      for (const ctx of active) if (!args.repoId || ctx.repoId === args.repoId) ctx.controller.abort();
      if (!args.repoId) github.cancel();
    }),
  };

  return {
    handlers,
    repositoryPath,
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      for (const ctx of active) ctx.controller.abort();
      const githubDisposal = github.dispose();
      runner.dispose();
      disposal = (async () => {
        await queues.get('github-https');
        await Promise.all([githubDisposal, httpsAuth.dispose(), githubHttpsAuth.dispose()]);
      })();
      return disposal;
    },
  };
}
