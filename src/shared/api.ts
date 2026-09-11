export type Theme = 'system' | 'light' | 'dark';

export interface Repository {
  id: string;
  name: string;
  path: string;
}

export interface AppState {
  repositories: Repository[];
  selectedRepoId: string | null;
  theme: Theme;
  defaultBranch: string;
  gitVersion: string | null;
}

export interface StatusFile {
  path: string;
  oldPath?: string;
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface Remote {
  name: string;
  url: string;
  pushUrl: string;
}

export interface OperationState {
  type: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  message: string;
}

export interface RepoStatus {
  branch: string;
  head: string | null;
  unborn: boolean;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: StatusFile[];
  remotes: Remote[];
  operation: OperationState | null;
}

export interface Branch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
}

export interface Commit {
  sha: string;
  summary: string;
  body: string;
  author: string;
  email: string;
  date: string;
  parents: string[];
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: string;
}

export interface DiffResult {
  path: string;
  text: string;
  binary: boolean;
  tooLarge: boolean;
  message?: string;
}

export interface Stash {
  ref: string;
  sha: string;
  message: string;
  date: string;
}

export interface RepoSettings {
  name: string;
  email: string;
  remotes: Remote[];
}

export interface HttpsAuthStatus {
  supported: boolean;
  username: string | null;
  expiresAt: string | null;
}

export interface GitHubUser {
  login: string;
  name: string | null;
}

export interface GitHubAccountState {
  user: GitHubUser | null;
  source: 'token' | 'cli' | 'device' | null;
  remembered: boolean;
  canRemember: boolean;
  browserLoginConfigured: boolean;
}

export interface GitHubRepository {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  description: string | null;
  private: boolean;
  archived: boolean;
  canPush: boolean;
  defaultBranch: string | null;
  updatedAt: string | null;
}

export interface GitHubDeviceCode {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface CommandLog {
  id: string;
  repoId?: string;
  command: string;
  phase: 'started' | 'progress' | 'completed' | 'failed';
  message: string;
  time: string;
}

export type AppEvent =
  | { type: 'changed'; repoId?: string }
  | { type: 'command'; log: CommandLog };

export interface AppError {
  code: string;
  message: string;
  detail?: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

type RepoArgs = { repoId: string };
type RepoPaths = RepoArgs & { paths: string[] };
type Command<A, D> = { args: A; data: D };

export interface CommandMap {
  getAppState: Command<Record<string, never>, AppState>;
  setPreferences: Command<{ theme?: Theme; defaultBranch?: string }, AppState>;
  selectRepository: Command<{ repoId: string | null }, void>;
  addRepository: Command<{ path: string }, Repository>;
  initRepository: Command<{ parentPath: string; name: string; defaultBranch: string }, Repository>;
  cloneRepository: Command<{ url: string; parentPath: string; name: string }, Repository>;
  removeRepository: Command<RepoArgs, void>;
  status: Command<RepoArgs, RepoStatus>;
  diff: Command<RepoArgs & { path: string; source: 'working' | 'staged' | 'commit'; commit?: string }, DiffResult>;
  history: Command<RepoArgs & { skip: number; limit: number; search: string }, { commits: Commit[]; hasMore: boolean }>;
  commitDetails: Command<RepoArgs & { sha: string }, { commit: Commit; files: ChangedFile[] }>;
  stage: Command<RepoPaths & { stage: boolean }, void>;
  commit: Command<RepoArgs & { summary: string; description: string; amend: boolean; confirmed?: boolean }, void>;
  discard: Command<RepoPaths & { confirmed: boolean }, void>;
  ignore: Command<RepoPaths, void>;
  branches: Command<RepoArgs, Branch[]>;
  branch: Command<RepoArgs & { action: 'create' | 'switch' | 'rename' | 'delete'; name: string; from?: string; confirmed?: boolean }, void>;
  network: Command<RepoArgs & { action: 'fetch' | 'pull' | 'pullRebase' | 'push' | 'forcePush'; remote?: string; confirmed?: boolean }, void>;
  integrate: Command<RepoArgs & { action: 'merge' | 'rebase'; branch: string }, void>;
  commitAction: Command<RepoArgs & { action: 'revert' | 'cherryPick' | 'checkout'; sha: string; confirmed: boolean }, void>;
  stashes: Command<RepoArgs, Stash[]>;
  stash: Command<RepoArgs & { action: 'save' | 'apply' | 'pop' | 'drop'; ref?: string; message?: string; includeUntracked?: boolean; confirmed?: boolean }, void>;
  resolve: Command<RepoPaths & { choice: 'ours' | 'theirs' | 'mark'; confirmed?: boolean }, void>;
  operation: Command<RepoArgs & { action: 'continue' | 'abort'; confirmed?: boolean }, void>;
  getRepoSettings: Command<RepoArgs, RepoSettings>;
  setIdentity: Command<RepoArgs & { name: string; email: string }, void>;
  getHttpsAuth: Command<{ url: string }, HttpsAuthStatus>;
  setHttpsCredentials: Command<{ url: string; username: string; password: string }, HttpsAuthStatus>;
  forgetHttpsCredentials: Command<{ url: string }, void>;
  githubAccount: Command<Record<string, never>, GitHubAccountState>;
  githubSignIn: Command<{ token: string; remember: boolean }, GitHubAccountState>;
  githubImportCli: Command<{ remember: boolean }, GitHubAccountState>;
  githubBeginLogin: Command<{ clientId?: string; remember: boolean }, GitHubDeviceCode>;
  githubPollLogin: Command<Record<string, never>, { state: 'pending' | 'complete'; intervalSeconds: number; account?: GitHubAccountState }>;
  githubCancelLogin: Command<Record<string, never>, void>;
  githubSignOut: Command<Record<string, never>, void>;
  githubRepositories: Command<{ page: number }, { repositories: GitHubRepository[]; hasMore: boolean }>;
  githubClone: Command<{ fullName: string; parentPath: string; name: string }, Repository>;
  githubCreate: Command<{ name: string; description: string; confirmed: boolean }, GitHubRepository>;
  githubPublish: Command<RepoArgs & { name: string; description: string; remote: string; confirmed: boolean }, GitHubRepository>;
  githubOpenPage: Command<{ page: 'device' | 'tokens' | 'repository'; fullName?: string }, void>;
  remote: Command<RepoArgs & { action: 'add' | 'edit' | 'remove'; name: string; url?: string; confirmed?: boolean }, void>;
  cancel: Command<{ repoId?: string }, void>;
  chooseDirectory: Command<{ title: string }, string | null>;
  openPath: Command<RepoArgs & { target: 'folder' | 'file' | 'editor' | 'terminal'; path?: string }, void>;
  openRemote: Command<RepoArgs & { sha?: string }, void>;
  windowControl: Command<{ action: 'minimize' | 'maximize' | 'close' }, void>;
}

export type CommandName = keyof CommandMap;
export type CommandArgs<K extends CommandName> = CommandMap[K]['args'];
export type CommandData<K extends CommandName> = CommandMap[K]['data'];
export type CommandHandlers = { [K in CommandName]: (args: CommandArgs<K>) => Promise<CommandData<K>> };
export type NativeCommand = 'chooseDirectory' | 'openPath' | 'openRemote' | 'windowControl' | 'githubOpenPage';
export type GitCommand = Exclude<CommandName, NativeCommand>;
export type GitHandlers = Pick<CommandHandlers, GitCommand>;

export interface GitDeskAPI {
  call<K extends CommandName>(command: K, args: CommandArgs<K>): Promise<Result<CommandData<K>>>;
  onEvent(callback: (event: AppEvent) => void): () => void;
  platform: string;
}

declare global {
  interface Window { gitdesk: GitDeskAPI }
}
