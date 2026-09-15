import { z } from 'zod';
import type { CommandArgs, CommandName } from './api';
import { httpsRepositoryUrl } from './https';

const text = z.string().max(32_768).refine((value) => !value.includes('\0'), 'NUL characters are not permitted');
const path = text.min(1);
const repoId = z.string().uuid();
const repo = { repoId };
const paths = z.array(path).min(1).max(10_000);
const ref = text.min(1).max(1024).refine((value) => !value.startsWith('-') && !/[\x00-\x20\x7f]/.test(value), 'Invalid Git reference');
const sha = z.string().regex(/^[0-9a-f]{40,64}$/, 'Expected a full commit ID');
const remoteName = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/).max(128);
const folderName = z.string().min(1).max(200).refine((value) => value !== '.' && value !== '..' && !/[/\\\x00-\x1f]/.test(value) && !value.startsWith('-'), 'Enter a single folder name');
const confirm = z.boolean().optional();
const httpsUrl = text.min(1).refine(value => httpsRepositoryUrl(value) !== null, 'Enter a full HTTPS repository URL without embedded credentials');
const username = text.min(1).max(500).refine(value => value.trim().length > 0 && !/[:\x00-\x1f\x7f]/.test(value), 'Enter an email or username without colons or control characters');
const password = text.min(1).max(8192).refine(value => !/[\x00-\x1f\x7f]/.test(value), 'Passwords and tokens must not contain control characters');
export const githubName = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).refine(value => value !== '.' && value !== '..', 'Invalid repository name');
export const githubOwner = z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/);
export const githubFullName = z.string().refine(value => {
  const parts = value.split('/');
  return parts.length === 2 && githubOwner.safeParse(parts[0]).success && githubName.safeParse(parts[1]).success;
}, 'Expected owner/repository');
const githubClientId = z.string().min(10).max(100).regex(/^[A-Za-z0-9_.-]+$/);

export const commandSchemas = {
  getAppState: z.object({}).strict(),
  setPreferences: z.object({ theme: z.enum(['system', 'light', 'dark']).optional(), defaultBranch: ref.optional() }).strict(),
  selectRepository: z.object({ repoId: repoId.nullable() }).strict(),
  addRepository: z.object({ path }).strict(),
  initRepository: z.object({ parentPath: path, name: folderName, defaultBranch: ref }).strict(),
  cloneRepository: z.object({ url: text.min(1), parentPath: path, name: folderName }).strict(),
  removeRepository: z.object(repo).strict(),
  status: z.object(repo).strict(),
  diff: z.object({ ...repo, path, source: z.enum(['working', 'staged', 'commit']), commit: sha.optional() }).strict(),
  history: z.object({ ...repo, skip: z.number().int().min(0).max(10_000_000), limit: z.number().int().min(1).max(200), search: text.max(500) }).strict(),
  commitDetails: z.object({ ...repo, sha }).strict(),
  stage: z.object({ ...repo, paths, stage: z.boolean() }).strict(),
  commit: z.object({ ...repo, summary: text.min(1).max(1000), description: text, amend: z.boolean(), confirmed: confirm }).strict(),
  discard: z.object({ ...repo, paths, confirmed: z.boolean() }).strict(),
  ignore: z.object({ ...repo, paths }).strict(),
  branches: z.object(repo).strict(),
  branch: z.discriminatedUnion('action', [
    z.object({ ...repo, action: z.literal('create'), name: ref, from: ref.optional(), dirtyAction: z.enum(['carry', 'stash']).optional() }).strict(),
    z.object({ ...repo, action: z.literal('switch'), name: ref }).strict(),
    z.object({ ...repo, action: z.literal('rename'), name: ref, from: ref.optional() }).strict(),
    z.object({ ...repo, action: z.literal('delete'), name: ref, confirmed: confirm }).strict(),
  ]),
  network: z.object({ ...repo, action: z.enum(['fetch', 'pull', 'pullRebase', 'push', 'forcePush']), remote: remoteName.optional(), confirmed: confirm }).strict(),
  integrate: z.object({ ...repo, action: z.enum(['merge', 'rebase']), branch: ref }).strict(),
  commitAction: z.object({ ...repo, action: z.enum(['revert', 'cherryPick', 'checkout']), sha, confirmed: z.boolean() }).strict(),
  stashes: z.object(repo).strict(),
  stash: z.object({ ...repo, action: z.enum(['save', 'apply', 'pop', 'drop']), ref: z.string().regex(/^stash@\{\d+\}$/).optional(), message: text.max(1000).optional(), includeUntracked: z.boolean().optional(), confirmed: confirm }).strict(),
  resolve: z.object({ ...repo, paths, choice: z.enum(['ours', 'theirs', 'mark']), confirmed: confirm }).strict(),
  operation: z.object({ ...repo, action: z.enum(['continue', 'abort']), confirmed: confirm }).strict(),
  getRepoSettings: z.object(repo).strict(),
  setIdentity: z.object({ ...repo, name: text.min(1).max(500), email: text.min(1).max(500) }).strict(),
  getHttpsAuth: z.object({ url: httpsUrl }).strict(),
  setHttpsCredentials: z.object({ url: httpsUrl, username, password }).strict(),
  forgetHttpsCredentials: z.object({ url: httpsUrl }).strict(),
  githubAccount: z.object({}).strict(),
  githubSignIn: z.object({ token: z.string().min(10).max(4096).regex(/^[A-Za-z0-9_]+$/), remember: z.boolean() }).strict(),
  githubImportCli: z.object({ remember: z.boolean() }).strict(),
  githubBeginLogin: z.object({ clientId: githubClientId.optional(), remember: z.boolean() }).strict(),
  githubPollLogin: z.object({}).strict(),
  githubCancelLogin: z.object({}).strict(),
  githubSignOut: z.object({}).strict(),
  githubRepositories: z.object({ page: z.number().int().min(1).max(10_000) }).strict(),
  githubClone: z.object({ fullName: githubFullName, parentPath: path, name: folderName }).strict(),
  githubCreate: z.object({ name: githubName, description: text.max(350), confirmed: z.boolean() }).strict(),
  githubPublish: z.object({ ...repo, name: githubName, description: text.max(350), remote: remoteName, confirmed: z.boolean() }).strict(),
  githubOpenPage: z.object({ page: z.enum(['device', 'tokens', 'repository']), fullName: githubFullName.optional() }).strict(),
  remote: z.object({ ...repo, action: z.enum(['add', 'edit', 'remove']), name: remoteName, url: text.min(1).optional(), confirmed: confirm }).strict(),
  cancel: z.object({ repoId: repoId.optional() }).strict(),
  chooseDirectory: z.object({ title: text.max(200) }).strict(),
  openPath: z.object({ ...repo, target: z.enum(['folder', 'file', 'editor', 'terminal']), path: path.optional() }).strict(),
  openRemote: z.object({ ...repo, sha: sha.optional() }).strict(),
  windowControl: z.object({ action: z.enum(['minimize', 'maximize', 'close']) }).strict(),
} satisfies { [K in CommandName]: z.ZodType<CommandArgs<K>> };

export const commandNames = Object.keys(commandSchemas) as CommandName[];

export function parseCommandArgs<K extends CommandName>(command: K, value: unknown): CommandArgs<K> {
  // The mapped schema constraint above preserves the relationship between each key and its arguments.
  return commandSchemas[command].parse(value) as CommandArgs<K>;
}
