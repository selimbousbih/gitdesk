import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { GitHubAccountState, GitHubDeviceCode, GitHubRepository } from '../../shared/api';
import { githubName, githubOwner, githubFullName } from '../../shared/validation';
import { GitError, requireConfirmation } from '../git/errors';
import { GitHubVault, type SavedAccount, type SecretEncryption } from './vault';

const API = 'https://api.github.com';
const WEBSITE = 'https://github.com';
const userSchema = z.object({ login: githubOwner, name: z.string().nullable() });
const repositorySchema = z.object({
  id: z.number().int().positive(), name: githubName, full_name: githubFullName,
  owner: z.object({ login: githubOwner }), description: z.string().nullable(),
  private: z.boolean(), archived: z.boolean(), default_branch: z.string().nullable(),
  updated_at: z.string().nullable(), permissions: z.object({ push: z.boolean() }).optional(),
});
const deviceSchema = z.object({
  device_code: z.string().min(1), user_code: z.string().regex(/^[A-Z0-9-]{4,32}$/),
  verification_uri: z.literal('https://github.com/login/device'),
  expires_in: z.number().int().positive().max(3600),
  interval: z.number().int().min(1).max(60),
});
const tokenResponse = z.object({
  access_token: z.string().min(10).max(4096).regex(/^[A-Za-z0-9_]+$/).optional(),
  error: z.string().optional(), expires_in: z.number().positive().optional(),
}).refine(value => Boolean(value.access_token) !== Boolean(value.error));

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new GitError('GITHUB_RESPONSE_INVALID', 'GitHub returned an unexpected response. Refresh and retry.');
  return result.data;
}

function repository(value: z.infer<typeof repositorySchema>): GitHubRepository {
  if (value.full_name.toLowerCase() !== `${value.owner.login}/${value.name}`.toLowerCase()) {
    throw new GitError('GITHUB_RESPONSE_INVALID', 'GitHub returned inconsistent repository details.');
  }
  return {
    id: value.id, name: value.name, fullName: value.full_name, owner: value.owner.login,
    description: value.description, private: value.private, archived: value.archived,
    canPush: value.permissions?.push ?? false, defaultBranch: value.default_branch, updatedAt: value.updated_at,
  };
}

export function githubCloneUrl(fullName: string): string {
  return `${WEBSITE}/${githubFullName.parse(fullName)}.git`;
}

export function githubUrlName(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== WEBSITE || parsed.username || parsed.password || parsed.search || parsed.hash || /[\x00-\x20\\]/.test(url)) return null;
    const name = parsed.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/, '');
    return githubFullName.safeParse(name).success ? name : null;
  } catch { return null; }
}

export async function readCliToken(signal: AbortSignal): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  for (const key of Object.keys(env)) {
    if (/^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_CONFIG_DIR|GH_HOST|GH_DEBUG|GH_HTTP_UNIX_SOCKET|DEBUG)$/.test(key)) delete env[key];
  }
  return new Promise<string>((resolve, reject) => {
    const child = spawn('gh', ['auth', 'token', '--hostname', 'github.com'], { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure = false;
    const stop = () => child.kill('SIGKILL');
    const timeout = setTimeout(stop, 15_000);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 8192) chunks.push(chunk); else { failure = true; stop(); } });
    child.stderr.resume();
    child.on('error', () => { failure = true; });
    child.on('close', code => {
      clearTimeout(timeout); signal.removeEventListener('abort', stop);
      const token = Buffer.concat(chunks).toString('utf8').trim();
      if (signal.aborted) return reject(new GitError('CANCELLED', 'GitHub sign-in was cancelled.'));
      if (failure || code !== 0 || !/^[A-Za-z0-9_]{10,4096}$/.test(token)) {
        return reject(new GitError('GITHUB_CLI_UNAVAILABLE', 'No usable GitHub CLI login was found. Run gh auth login --hostname github.com, then import it, or sign in with a token.'));
      }
      resolve(token);
    });
  });
}

interface DeviceSession {
  code: string; clientId: string; expires: number; interval: number; nextPoll: number; remember: boolean; controller: AbortController;
}

export interface GitHubOptions {
  dataDir: string;
  encryption?: SecretEncryption;
  clientId?: string;
  fetch?: typeof fetch;
  importCli?: (signal: AbortSignal) => Promise<string>;
}

export class GitHubClient {
  private readonly vault: GitHubVault;
  private readonly fetcher: typeof fetch;
  private readonly clientId?: string;
  private account: SavedAccount | null = null;
  private remembered = false;
  private loaded = false;
  private device?: DeviceSession;
  private loginController?: AbortController;
  private readonly active = new Set<AbortController>();
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private cancellation = 0;

  constructor(private readonly options: GitHubOptions) {
    this.vault = new GitHubVault(options.dataDir, options.encryption);
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.clientId = options.clientId;
  }

  private serial<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const generation = this.cancellation;
    const result = this.tail.then(async () => {
      if (this.disposed) throw new GitError('CANCELLED', 'GitDesk is shutting down.');
      if (generation !== this.cancellation || signal?.aborted) throw new GitError('CANCELLED', 'The queued GitHub operation was cancelled.');
      return task();
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const saved = await this.vault.load();
    this.account = saved;
    this.remembered = Boolean(saved);
    this.loaded = true;
  }

  private state(): GitHubAccountState {
    const expired = this.account?.expiresAt !== null && this.account?.expiresAt !== undefined && this.account.expiresAt <= Date.now();
    return {
      user: expired ? null : this.account?.user ?? null, source: expired ? null : this.account?.source ?? null,
      remembered: this.remembered, canRemember: this.vault.available(), browserLoginConfigured: Boolean(this.clientId),
    };
  }

  status(): Promise<GitHubAccountState> {
    return this.serial(async () => { await this.load(); return this.state(); });
  }

  private async request(endpoint: string, options: { token?: string; method?: string; body?: object; oauth?: boolean; signal?: AbortSignal } = {}): Promise<{ value: unknown; headers: Headers }> {
    const origin = options.oauth ? WEBSITE : API;
    const url = new URL(endpoint, origin);
    if (url.origin !== origin || !endpoint.startsWith('/')) throw new GitError('GITHUB_URL_INVALID', 'Only the configured GitHub API is allowed.');
    const controller = new AbortController();
    this.active.add(controller);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetcher(url, {
        method: options.method ?? 'GET', redirect: 'error', signal,
        headers: {
          Accept: options.oauth ? 'application/json' : 'application/vnd.github+json', 'User-Agent': 'GitDesk/0.1.0',
          ...(!options.oauth ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new GitError('GITHUB_AUTH_REQUIRED', 'GitHub rejected this credential. Sign in again with a valid token.');
        if (response.status === 403 || response.status === 429) {
          const rateLimited = response.headers.get('x-ratelimit-remaining') === '0' || response.status === 429;
          throw new GitError(rateLimited ? 'GITHUB_RATE_LIMIT' : 'GITHUB_PERMISSION',
            rateLimited ? 'GitHub rate-limited this request. Wait before refreshing.' : 'GitHub denied access. Check token permissions and organization SSO authorization.');
        }
        if (response.status === 404) throw new GitError('GITHUB_NOT_FOUND', 'This GitHub repository is missing or not accessible to the signed-in account.');
        if (response.status === 422) throw new GitError('GITHUB_VALIDATION', 'GitHub could not create this repository. The name may already exist or your account policy may disallow it.');
        throw new GitError('GITHUB_REQUEST_FAILED', `GitHub returned HTTP ${response.status}. Retry after checking its status.`);
      }
      if (!response.body) throw new GitError('GITHUB_RESPONSE_INVALID', 'GitHub returned an empty response.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.length;
        if (length > 4 * 1024 * 1024) { await reader.cancel(); throw new GitError('GITHUB_RESPONSE_TOO_LARGE', 'GitHub returned too much data for one page.'); }
        chunks.push(result.value);
      }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new GitError('GITHUB_RESPONSE_INVALID', 'GitHub returned unreadable data.'); }
      return { value, headers: response.headers };
    } catch (error) {
      if (error instanceof GitError) throw error;
      if (signal.aborted) throw new GitError('CANCELLED', 'The GitHub request was cancelled or timed out. For repository creation, check your GitHub account before retrying.');
      throw new GitError('GITHUB_NETWORK_FAILED', 'Could not reach GitHub securely. Check your network and certificate configuration. If creating a repository, check GitHub before retrying.');
    } finally {
      clearTimeout(timeout); this.active.delete(controller);
    }
  }

  private async signIn(token: string, source: SavedAccount['source'], remember: boolean, expiresAt: number | null = null, signal?: AbortSignal): Promise<GitHubAccountState> {
    const generation = this.cancellation;
    if (remember && !this.vault.available()) throw new GitError('KEYCHAIN_UNAVAILABLE', 'Secure storage is unavailable. Uncheck Remember me to use a memory-only session.');
    const user = parse(userSchema, (await this.request('/user', { token, signal })).value);
    if (signal?.aborted) throw new GitError('CANCELLED', 'GitHub sign-in was cancelled.');
    const account = { token, user, source, expiresAt };
    if (remember) await this.vault.save(account);
    else await this.vault.clear();
    if (signal?.aborted || this.disposed || generation !== this.cancellation) { await this.vault.clear(); throw new GitError('CANCELLED', 'GitHub sign-in was cancelled.'); }
    this.account = account; this.remembered = remember; this.loaded = true; this.device = undefined;
    return this.state();
  }

  signInToken(token: string, remember: boolean): Promise<GitHubAccountState> {
    return this.serial(() => this.signIn(token, 'token', remember));
  }

  importCli(remember: boolean): Promise<GitHubAccountState> {
    return this.serial(async () => {
      const controller = new AbortController();
      this.active.add(controller);
      try {
        const token = await (this.options.importCli ?? readCliToken)(controller.signal);
        if (controller.signal.aborted) throw new GitError('CANCELLED', 'GitHub sign-in was cancelled.');
        return await this.signIn(token, 'cli', remember, null, controller.signal);
      }
      finally { this.active.delete(controller); }
    });
  }

  beginLogin(clientId: string | undefined, remember: boolean): Promise<GitHubDeviceCode> {
    this.cancelLogin();
    const controller = new AbortController();
    this.loginController = controller;
    return this.serial(async () => {
      if (controller.signal.aborted) throw new GitError('CANCELLED', 'GitHub sign-in was cancelled.');
      const id = clientId ?? this.clientId;
      if (!id || !/^[A-Za-z0-9_.-]{10,100}$/.test(id)) throw new GitError('GITHUB_OAUTH_SETUP', 'Browser sign-in needs your registered GitDesk OAuth client ID with device flow enabled. Use a token or import your GitHub CLI login instead.');
      if (remember && !this.vault.available()) throw new GitError('KEYCHAIN_UNAVAILABLE', 'Uncheck Remember me: OS credential storage is unavailable.');
      this.device = undefined;
      const result = parse(deviceSchema, (await this.request('/login/device/code', { oauth: true, method: 'POST', signal: controller.signal, body: { client_id: id, scope: 'repo read:user' } })).value);
      if (controller.signal.aborted) throw new GitError('CANCELLED', 'GitHub sign-in was cancelled.');
      this.device = { code: result.device_code, clientId: id, expires: Date.now() + result.expires_in * 1000, interval: result.interval, nextPoll: Date.now() + result.interval * 1000, remember, controller };
      return { userCode: result.user_code, verificationUri: result.verification_uri, expiresAt: new Date(this.device.expires).toISOString(), intervalSeconds: result.interval };
    });
  }

  pollLogin(): Promise<{ state: 'pending' | 'complete'; intervalSeconds: number; account?: GitHubAccountState }> {
    return this.serial(async () => {
      const device = this.device;
      if (!device) throw new GitError('GITHUB_LOGIN_MISSING', 'Start browser sign-in first.');
      if (Date.now() >= device.expires) { this.device = undefined; throw new GitError('GITHUB_LOGIN_EXPIRED', 'The sign-in code expired. Start a new sign-in.'); }
      if (Date.now() < device.nextPoll) return { state: 'pending', intervalSeconds: Math.max(1, Math.ceil((device.nextPoll - Date.now()) / 1000)) };
      device.nextPoll = Date.now() + device.interval * 1000;
      const result = parse(tokenResponse, (await this.request('/login/oauth/access_token', {
        oauth: true, method: 'POST', signal: device.controller.signal, body: { client_id: device.clientId, device_code: device.code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
      })).value);
      if (this.device !== device) throw new GitError('CANCELLED', 'GitHub sign-in was cancelled.');
      if (result.error === 'slow_down') { device.interval += 5; device.nextPoll = Date.now() + device.interval * 1000; }
      else if (result.error && result.error !== 'authorization_pending') {
        this.device = undefined;
        throw new GitError('GITHUB_LOGIN_DENIED', 'GitHub sign-in was denied or expired. Start again when ready.');
      } else if (result.access_token) {
        const account = await this.signIn(result.access_token, 'device', device.remember, result.expires_in ? Date.now() + result.expires_in * 1000 : null, device.controller.signal);
        return { state: 'complete', intervalSeconds: 0, account };
      }
      return { state: 'pending', intervalSeconds: device.interval };
    });
  }

  cancelLogin(): void { this.loginController?.abort(); this.loginController = undefined; this.device = undefined; }

  signOut(): Promise<void> {
    this.cancelLogin();
    return this.serial(async () => {
      this.account = null; this.loaded = true; this.remembered = false;
      await this.vault.clear();
    });
  }

  private async authenticated<T>(action: (token: string, account: SavedAccount) => Promise<T>): Promise<T> {
    await this.load();
    if (!this.account || !this.state().user) throw new GitError('GITHUB_AUTH_REQUIRED', 'Sign in to GitHub first.');
    try { return await action(this.account.token, this.account); }
    catch (error) {
      if (error instanceof GitError && error.code === 'GITHUB_AUTH_REQUIRED') {
        this.account = null; this.remembered = false; await this.vault.clear();
      }
      throw error;
    }
  }

  listRepositories(page: number): Promise<{ repositories: GitHubRepository[]; hasMore: boolean }> {
    return this.serial(() => this.authenticated(async token => {
      const result = await this.request(`/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=50&page=${page}`, { token });
      const entries = parse(z.array(repositorySchema).max(50), result.value);
      return { repositories: entries.map(repository), hasMore: /rel="next"/.test(result.headers.get('link') ?? '') };
    }));
  }

  getRepository(fullName: string, signal?: AbortSignal): Promise<GitHubRepository> {
    return this.serial(() => this.authenticated(async token => {
      const name = githubFullName.parse(fullName);
      const result = repository(parse(repositorySchema, (await this.request(`/repos/${name}`, { token, signal })).value));
      if (result.fullName.toLowerCase() !== name.toLowerCase()) throw new GitError('GITHUB_RESPONSE_INVALID', 'GitHub returned a different repository. Refresh the repository list before cloning.');
      return result;
    }), signal);
  }

  createRepository(name: string, description: string, confirmed: boolean, signal?: AbortSignal): Promise<GitHubRepository> {
    requireConfirmation(confirmed);
    return this.serial(() => this.authenticated(async (token, account) => {
      const result = await this.request('/user/repos', { token, signal, method: 'POST', body: { name: githubName.parse(name), description, private: true, auto_init: false } });
      const created = repository(parse(repositorySchema, result.value));
      if (!created.private || created.owner.toLowerCase() !== account.user.login.toLowerCase() || created.name.toLowerCase() !== name.toLowerCase()) {
        throw new GitError('GITHUB_CREATE_UNEXPECTED', 'GitHub created an unexpected repository. Check your account before continuing; nothing was pushed.');
      }
      return created;
    }), signal);
  }

  credentials(url: string): Promise<{ username: string; password: string } | null> {
    if (!githubUrlName(url)) return Promise.resolve(null);
    return this.serial(async () => {
      await this.load();
      if (!this.account) return null;
      if (!this.state().user) throw new GitError('GITHUB_AUTH_REQUIRED', 'Your GitHub session expired. Sign in again before syncing.');
      return { username: this.account.user.login, password: this.account.token };
    });
  }

  cancel(): void { this.cancellation++; for (const controller of this.active) controller.abort(); }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelLogin();
    this.cancel();
    await this.tail;
    this.account = null;
  }
}
