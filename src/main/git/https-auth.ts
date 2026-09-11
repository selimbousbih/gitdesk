import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HttpsAuthStatus } from '../../shared/api';
import { httpsRepositoryUrl } from '../../shared/https';
import { GitError } from './errors';
import { GitRunner, type Execution, type GitOutput, type RunOptions } from './runner';

const LIFETIME_SECONDS = 3600;
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export class HttpsAuthentication {
  private readonly cacheRunner = new GitRunner();
  private directory?: Promise<string>;
  private readonly accounts = new Map<string, { username: string; expires: number }>();
  private tail: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(private readonly runner: GitRunner) {}

  private url(input: string): string {
    const url = httpsRepositoryUrl(input);
    if (!url) throw new GitError('INVALID_URL', 'Use an HTTPS repository URL without embedded credentials.');
    return url;
  }

  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(action);
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async configuration(): Promise<NonNullable<RunOptions['config']>> {
    if (process.platform === 'win32') {
      throw new GitError('NOT_AVAILABLE', 'Session credentials require Git credential-cache on Linux or macOS. On Windows, configure Git Credential Manager instead.');
    }
    this.directory ??= mkdtemp(path.join(tmpdir(), 'gitdesk-https-')).catch(error => {
      this.directory = undefined;
      throw error;
    });
    const socket = path.join(await this.directory, 'cache');
    return [
      ['credential.helper', ''],
      ['credential.helper', `cache --timeout=${LIFETIME_SECONDS} --socket=${quote(socket)}`],
      ['credential.useHttpPath', 'true'],
      ['http.followRedirects', 'false'],
    ];
  }

  status(input: string): HttpsAuthStatus {
    const account = this.accounts.get(this.url(input));
    const current = account && account.expires > Date.now() ? account : null;
    return {
      supported: process.platform !== 'win32',
      username: current?.username ?? null,
      expiresAt: current ? new Date(current.expires).toISOString() : null,
    };
  }

  async set(input: string, username: string, password: string, execution: Execution): Promise<HttpsAuthStatus> {
    const url = this.url(input);
    return this.serial(async () => {
      if (this.closing) throw new GitError('CANCELLED', 'GitDesk is shutting down.');
      const config = await this.configuration();
      this.accounts.set(url, { username, expires: 0 });
      // Resetting the helper list prevents existing plaintext "store" helpers from receiving this secret.
      await this.cacheRunner.run(undefined, ['credential', 'reject'], execution, {
        config, input: `url=${url}\n\n`, sensitive: true, timeoutMs: 5000,
      });
      await this.cacheRunner.run(undefined, ['credential', 'approve'], execution, {
        config, input: `url=${url}\nusername=${username}\npassword=${password}\n\n`, sensitive: true, timeoutMs: 5000,
      });
      this.accounts.set(url, { username, expires: Date.now() + LIFETIME_SECONDS * 1000 });
      return this.status(url);
    });
  }

  async forget(input: string): Promise<void> {
    const url = this.url(input);
    return this.serial(async () => {
      this.accounts.delete(url);
      if (!this.directory) return;
      await this.cacheRunner.run(undefined, ['credential', 'reject'], { controller: new AbortController() }, {
        config: await this.configuration(), input: `url=${url}\n\n`, sensitive: true, timeoutMs: 5000,
      });
    });
  }

  run(cwd: string | undefined, args: string[], execution: Execution, input: string): Promise<GitOutput> {
    return this.serial(() => this.executeNetwork(cwd, args, execution, input));
  }

  private async executeNetwork(cwd: string | undefined, args: string[], execution: Execution, input: string): Promise<GitOutput> {
    if (this.closing) throw new GitError('CANCELLED', 'GitDesk is shutting down.');
    const url = httpsRepositoryUrl(input);
    const own = url !== null && this.accounts.has(url);
    // An expired or rejected session must not silently fall back to a different account's helper.
    const config = own ? await this.configuration() : undefined;
    if (own && !this.status(url).username) {
      throw new GitError('AUTHENTICATION_FAILED', 'Your HTTPS session expired or was rejected. Enter your credentials again before retrying.');
    }
    try {
      const result = await this.runner.run(cwd, args, execution, { network: true, config, privateDiagnostics: own });
      const account = url ? this.accounts.get(url) : undefined;
      if (account) account.expires = Date.now() + LIFETIME_SECONDS * 1000;
      return result;
    } catch (error) {
      if (own && error instanceof GitError && error.code === 'AUTHENTICATION_FAILED') {
        const account = this.accounts.get(url);
        if (account) account.expires = 0;
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.closing = true;
    await this.tail;
    this.accounts.clear();
    if (!this.directory) { this.cacheRunner.dispose(); return; }
    const directory = await this.directory;
    try {
      await this.cacheRunner.run(undefined, ['credential-cache', `--socket=${path.join(directory, 'cache')}`, 'exit'], {
        controller: new AbortController(),
      }, { sensitive: true, timeoutMs: 5000 });
    } finally {
      this.cacheRunner.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
