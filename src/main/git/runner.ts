import { spawn, type ChildProcess } from 'node:child_process';
import { GitError, redact } from './errors';

export interface Execution {
  controller: AbortController;
  progress?: (message: string) => void;
}

export interface RunOptions {
  input?: string | Buffer;
  allowedCodes?: number[];
  maxBytes?: number;
  allowTooLarge?: boolean;
  network?: boolean;
  config?: readonly (readonly [string, string])[];
  timeoutMs?: number;
  sensitive?: boolean;
  privateDiagnostics?: boolean;
}

export interface GitOutput {
  stdout: Buffer;
  stderr: string;
  code: number;
  tooLarge: boolean;
}

const MAX_OUTPUT = 16 * 1024 * 1024;
export const DIFF_LIMIT = 2 * 1024 * 1024;

export class GitRunner {
  private readonly children = new Set<ChildProcess>();
  private disposed = false;

  async run(cwd: string | undefined, args: string[], execution: Execution, options: RunOptions = {}): Promise<GitOutput> {
    if (this.disposed || execution.controller.signal.aborted) throw new GitError('CANCELLED', 'The operation was cancelled.');
    const env = { ...process.env };
    // Never inherit an index, worktree, injected config, or credential prompt from our launcher.
    for (const key of Object.keys(env)) {
      if (/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|PREFIX|NAMESPACE|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS|AUTHOR_.*|COMMITTER_.*|EXTERNAL_DIFF|TRACE.*)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=15 -oConnectionAttempts=1',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_ALLOW_PROTOCOL: 'file:https:ssh',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_EDITOR: 'true',
      GIT_SEQUENCE_EDITOR: 'true',
      GIT_PAGER: 'cat',
      LC_ALL: 'C.UTF-8',
    });
    // `stash push` internally generates literal magic pathspecs for `clean`. Inheriting
    // GIT_LITERAL_PATHSPECS breaks its untracked cleanup (even on Git 2.53). This
    // command accepts no caller-supplied paths; all file-selecting commands keep it on.
    if (args[0] === 'stash' && args[1] === 'push') delete env.GIT_LITERAL_PATHSPECS;
    return new Promise<GitOutput>((resolve, reject) => {
      const child = spawn('git', [
        '-c', 'color.ui=false',
        '-c', 'core.quotePath=false',
        '-c', 'credential.interactive=false',
        '-c', 'core.fsmonitor=false',
        '-c', 'submodule.recurse=false',
        '-c', 'http.connectTimeout=20',
        '-c', 'http.lowSpeedLimit=1',
        '-c', 'http.lowSpeedTime=30',
        ...(options.config ?? []).flatMap(([key, value]) => ['-c', `${key}=${value}`]),
        ...args,
      ], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
      this.children.add(child);
      let outputBytes = 0;
      let errorBytes = 0;
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      let tooLarge = false;
      let timedOut = false;
      let spawnError: Error | undefined;
      let progressLine = '';
      let progressOmitted = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        this.kill(child, 'SIGTERM');
        escalation ??= setTimeout(() => this.kill(child, 'SIGKILL'), 1_000);
        escalation.unref();
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? (options.network ? 180_000 : 90_000));
      timer.unref();
      execution.controller.signal.addEventListener('abort', stop, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes <= (options.maxBytes ?? MAX_OUTPUT)) chunks.push(chunk);
        else if (!tooLarge) { tooLarge = true; stop(); }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (options.sensitive) return;
        errorBytes += chunk.length;
        if (errorBytes <= 128 * 1024) errors.push(chunk);
        if (options.privateDiagnostics) return;
        const fragments = chunk.toString('utf8').split(/[\r\n]/);
        for (let index = 0; index < fragments.length; index++) {
          if (!progressOmitted) progressLine += fragments[index];
          if (progressLine.length > 16_384) { progressLine = ''; progressOmitted = true; }
          if (index < fragments.length - 1) {
            if (progressOmitted) execution.progress?.('[Oversized Git progress line omitted]');
            else if (progressLine) execution.progress?.(redact(progressLine).slice(0, 4_000));
            progressLine = '';
            progressOmitted = false;
          }
        }
      });
      child.on('error', (error) => { spawnError = error; });
      child.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') { spawnError = error; stop(); }
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        execution.controller.signal.removeEventListener('abort', stop);
        this.children.delete(child);
        const stderr = errorBytes > 128 * 1024
          ? 'Git error output exceeded 128 KiB; diagnostic text was omitted.'
          : redact(Buffer.concat(errors).toString('utf8')).trim();
        if (progressOmitted) execution.progress?.('[Oversized Git progress line omitted]');
        else if (progressLine) execution.progress?.(redact(progressLine).slice(0, 4_000));
        if (execution.controller.signal.aborted || this.disposed) return reject(new GitError('CANCELLED', 'The operation was cancelled. Refresh to inspect any partial changes.'));
        if (timedOut) return reject(new GitError('TIMEOUT', options.network
          ? 'Git timed out. Check connectivity and configure non-interactive credentials or your SSH agent before retrying.'
          : 'Git timed out. A hook, signing tool, or subprocess may be waiting for input. Run Git from a terminal to diagnose it, then refresh.', options.privateDiagnostics || options.sensitive ? undefined : stderr));
        if (spawnError) return reject(new GitError('GIT_UNAVAILABLE', 'Git could not be started. Install Git and make sure it is on PATH.', spawnError.message));
        if (tooLarge && !options.allowTooLarge) return reject(new GitError('OUTPUT_TOO_LARGE', 'Git returned too much data. Narrow the request before retrying.'));
        if (!tooLarge && !(options.allowedCodes ?? [0]).includes(code ?? -1)) {
          const detail = [stderr, redact(Buffer.concat(chunks).toString('utf8')).trim()].filter(Boolean).join('\n');
          let message = `Git ${args.find((arg) => !arg.startsWith('-')) ?? 'operation'} failed.`;
          let errorCode = 'GIT_FAILED';
          if (options.sensitive) {
            errorCode = 'CREDENTIAL_CACHE_FAILED';
            message = 'Git could not update its private in-memory credential cache. Check that your Git installation includes credential-cache.';
          } else if (/authentication failed|HTTP Basic: Access denied|could not read (?:Username|Password)|unable to get password from user|terminal prompts disabled|returned error: 401/i.test(detail)) {
            errorCode = 'AUTHENTICATION_FAILED';
            message = 'HTTPS authentication failed. Enter your email/username and password or personal access token in HTTPS authentication, then retry. Company GitLab instances using 2FA or SSO may require a token.';
          } else if (/stale info|stale lease|fetch first|non-fast-forward|\[rejected\]/i.test(detail)) {
            errorCode = 'PUSH_REJECTED';
            message = 'The remote has changes this push would overwrite. Fetch and review them before trying again; a force push never bypasses the lease.';
          } else if (/authentication|could not read Username|permission denied|terminal prompts disabled|could not resolve host|unable to access|could not read from remote/i.test(detail)) {
            errorCode = 'NETWORK_FAILED';
            message = 'Could not access the remote. Check its URL, your connection, and credentials or SSH agent. GitDesk never opens terminal prompts.';
          } else if (/conflict|unmerged|fix conflicts/i.test(detail)) {
            errorCode = 'CONFLICT';
            message = 'Git stopped because of conflicts. Resolve the listed files, then continue or abort the operation.';
          } else if (/would be overwritten|local changes/i.test(detail)) {
            errorCode = 'DIRTY_WORKTREE';
            message = 'Local changes prevent this operation. Commit or stash them first; nothing was automatically discarded.';
          } else if (/identity unknown|unable to auto-detect email/i.test(detail)) {
            errorCode = 'IDENTITY_REQUIRED';
            message = 'Set a Git name and email in repository settings before committing.';
          }
          return reject(new GitError(errorCode, message, options.sensitive || options.privateDiagnostics ? undefined : detail.slice(0, 16_384) || `Git exited with code ${code ?? 'unknown'}.`));
        }
        resolve({ stdout: tooLarge || options.privateDiagnostics ? Buffer.alloc(0) : Buffer.concat(chunks), stderr: options.privateDiagnostics ? '' : stderr, code: code ?? -1, tooLarge });
      });
      child.stdin.end(options.input);
    });
  }

  private kill(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid || (process.platform === 'win32' && child.exitCode !== null)) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.children) this.kill(child, 'SIGKILL');
  }
}
