import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { GitError, isMissing } from './errors';

export function relativePath(value: string): string {
  if (!value || value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new GitError('INVALID_PATH', 'Choose an exact repository-relative file path.');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || (process.platform === 'win32' && value.includes('\\'))) {
    throw new GitError('INVALID_PATH', 'Traversal, Git metadata, and non-canonical paths are not permitted.');
  }
  // Backslashes are ordinary filenames on Unix, but never accept Windows-style traversal.
  if (value.split(/[\\/]/).some((part) => part === '..' || part.toLowerCase() === '.git')) throw new GitError('INVALID_PATH', 'Unsafe file path.');
  if (process.platform === 'win32' && parts.some((part) => /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) {
    throw new GitError('INVALID_PATH', 'Windows device names, alternate streams, and ambiguous Windows paths are not permitted.');
  }
  return value;
}

export async function exactPath(root: string, value: string, allowMissing = true): Promise<string> {
  relativePath(value);
  const components = value.split('/');
  let cursor = root;
  for (let i = 0; i < components.length; i++) {
    cursor = path.join(cursor, components[i]);
    let info;
    try { info = await lstat(cursor); } catch (error) {
      if (allowMissing && isMissing(error)) return path.join(root, ...components);
      if (isMissing(error)) throw new GitError('FILE_NOT_FOUND', 'The selected file no longer exists.');
      throw error;
    }
    if (i !== components.length - 1 && (info.isSymbolicLink() || !info.isDirectory())) {
      throw new GitError('UNSAFE_PATH', 'A parent of the selected file is a symlink or not a directory. GitDesk will not follow it.');
    }
    if (i === components.length - 1 && info.isDirectory()) {
      throw new GitError('DIRECTORY_NOT_ALLOWED', 'Select individual files, not directories or submodules.');
    }
    if (i === components.length - 1 && !info.isFile() && !info.isSymbolicLink()) {
      throw new GitError('UNSAFE_PATH', 'Special files such as sockets and named pipes cannot be changed through GitDesk.');
    }
  }
  return cursor;
}

export async function readExactFile(root: string, value: string, maxBytes: number): Promise<Buffer> {
  const file = await exactPath(root, value, false);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new GitError('UNSAFE_PATH', 'This operation requires a regular file, not a symlink or special file.');
    if (info.size > maxBytes) throw new GitError('FILE_TOO_LARGE', 'The file is too large to inspect safely.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new GitError('FILE_TOO_LARGE', 'The file is too large to inspect safely.');
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}

export async function newDestination(parentPath: string, name: string): Promise<string> {
  relativePath(name);
  if (name === '.' || name === '..' || name.toLowerCase() === '.git' || name.startsWith('-') || /[/\\\x00-\x1f]/.test(name)) {
    throw new GitError('INVALID_PATH', 'Enter a safe, new child folder name.');
  }
  const parent = await realpath(parentPath);
  if (!(await stat(parent)).isDirectory()) throw new GitError('INVALID_PATH', 'The parent must be an existing directory.');
  const destination = path.join(parent, name);
  try {
    await lstat(destination);
    throw new GitError('DESTINATION_EXISTS', 'That destination already exists. Choose a new folder; GitDesk will not overwrite it.');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return destination;
}

export async function approvedUrl(value: string, root?: string): Promise<string> {
  if (!value || value.startsWith('-') || /[\x00-\x20\x7f]/.test(value)) {
    // Local directory names may contain spaces; control characters still may not.
    if (!value || value.startsWith('-') || /[\x00-\x1f\x7f]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
      throw new GitError('INVALID_URL', 'Use an HTTPS URL, SSH URL, scp-style SSH address, or existing local directory.');
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try { url = new URL(value); } catch { throw new GitError('INVALID_URL', 'The remote URL is invalid.'); }
    if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password || (url.protocol !== 'ssh:' && url.username) || url.search || url.hash) {
      throw new GitError('INVALID_URL', 'Only HTTPS and SSH URLs without passwords, access tokens, query strings, or embedded HTTPS credentials are permitted.');
    }
    if (/\s/.test(value) || url.hostname.startsWith('-')) throw new GitError('INVALID_URL', 'The remote URL contains an unsafe host or whitespace.');
    return value;
  }
  if (/^(?:[A-Za-z0-9_.-]+@)?(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[a-fA-F0-9:]+\]):[^:]/.test(value) && !path.isAbsolute(value)) {
    const host = value.slice(0, value.indexOf(':'));
    if (!/\s/.test(value) && !host.startsWith('-') && !value.includes('::')) return value;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !path.win32.isAbsolute(value)) throw new GitError('INVALID_URL', 'Command protocols and remote helpers are not permitted.');
  let local: string;
  try {
    local = await realpath(path.resolve(root ?? process.cwd(), value));
    if (!(await stat(local)).isDirectory()) throw new GitError('INVALID_URL', 'The local remote must be a directory.');
  } catch (error) {
    if (isMissing(error)) throw new GitError('INVALID_URL', 'The local remote directory does not exist.');
    throw error;
  }
  return local;
}
