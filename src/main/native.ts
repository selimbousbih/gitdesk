import { access, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

export class NativeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function repositoryFile(root: string, input: string): Promise<string> {
  if (!input || input.includes('\0') || isAbsolute(input) || input.split(/[\\/]/).some((part) => part === '..' || part === '.git')) {
    throw new NativeError('INVALID_PATH', 'Choose a file inside this repository, outside Git metadata.');
  }
  const path = resolve(root, input);
  if (!isInside(root, path)) throw new NativeError('INVALID_PATH', 'The file is outside the repository.');
  const canonical = await realpath(path);
  if (!isInside(root, canonical) || relative(root, canonical).split(sep).includes('.git') || !(await lstat(canonical)).isFile()) {
    throw new NativeError('INVALID_PATH', 'Only regular files inside this repository can be opened.');
  }
  return canonical;
}

export function remoteWebUrl(remote: string, sha?: string): string {
  if (/[\x00-\x20\x7f\\]/.test(remote) || /\[redacted\]/i.test(remote)) {
    throw new NativeError('INVALID_URL', 'The remote web address contains unsupported characters.');
  }
  let url: URL;
  if (/^https?:\/\//i.test(remote)) {
    url = new URL(remote);
  } else if (/^ssh:\/\//i.test(remote)) {
    const ssh = new URL(remote);
    if (ssh.password || ssh.search || ssh.hash || /\[redacted\]/i.test(decodeURIComponent(ssh.username))) {
      throw new NativeError('INVALID_URL', 'The remote web address must not contain credentials or query parameters.');
    }
    url = new URL(`https://${ssh.hostname}${ssh.pathname}`);
  } else {
    const scp = /^[^@/:\s]+@([A-Za-z0-9.-]+):(.+)$/.exec(remote);
    if (!scp) throw new NativeError('NOT_AVAILABLE', 'This remote does not have a supported web address.');
    url = new URL(`https://${scp[1]}/${scp[2]}`);
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) {
    throw new NativeError('INVALID_URL', 'The remote web address must not contain credentials or query parameters.');
  }
  url.pathname = url.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  if (sha) {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new NativeError('INVALID_COMMIT', 'A full commit ID is required.');
    const host = url.hostname.toLowerCase();
    const segment = host === 'github.com' ? '/commit/' : host === 'gitlab.com' ? '/-/commit/' : host === 'bitbucket.org' ? '/commits/' : null;
    if (!segment) throw new NativeError('NOT_AVAILABLE', 'Commit links are supported for github.com, gitlab.com and bitbucket.org. Open the repository page for other hosts.');
    url.pathname += segment + sha;
  }
  return url.toString();
}

async function executable(name: string): Promise<string | null> {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const suffixes = process.platform === 'win32' ? ['.exe'] : [''];
    for (const suffix of suffixes) {
      const candidate = resolve(directory, name + suffix);
      try {
        await access(candidate, constants.X_OK);
        if ((await lstat(candidate)).isFile()) return candidate;
        const target = await realpath(candidate);
        if ((await lstat(target)).isFile()) return target;
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'EACCES')) continue;
        throw error;
      }
    }
  }
  return null;
}

async function launch(program: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(program, args, { cwd, stdio: 'ignore', shell: false });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolveLaunch();
    });
  });
}

export async function openEditor(root: string, file?: string): Promise<void> {
  const code = await executable('code') ?? await executable('codium');
  if (!code) throw new NativeError('NOT_AVAILABLE', 'Install the VS Code or VSCodium command-line launcher (code or codium) to use Open in editor.');
  await launch(code, ['--new-window', '--', file ?? root], root);
}

export async function openTerminal(root: string): Promise<void> {
  if (process.platform === 'darwin') {
    await launch('/usr/bin/open', ['-a', 'Terminal', root], root);
    return;
  }
  if (process.platform === 'win32') {
    const terminal = await executable('wt');
    if (!terminal) throw new NativeError('NOT_AVAILABLE', 'Install Windows Terminal and enable its wt.exe app execution alias.');
    await launch(terminal, ['-d', root], root);
    return;
  }
  const konsole = await executable('konsole');
  if (konsole) {
    await launch(konsole, ['--workdir', root], root);
    return;
  }
  const gnome = await executable('gnome-terminal');
  if (gnome) {
    await launch(gnome, ['--working-directory', root], root);
    return;
  }
  throw new NativeError('NOT_AVAILABLE', 'Open in terminal currently supports Konsole, GNOME Terminal, macOS Terminal and Windows Terminal.');
}
