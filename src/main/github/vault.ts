import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GitError, isMissing } from '../git/errors';
import { githubOwner } from '../../shared/validation';

export interface SecretEncryption {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

const savedAccount = z.object({
  token: z.string().min(10).max(4096).regex(/^[A-Za-z0-9_]+$/),
  user: z.object({ login: githubOwner, name: z.string().nullable() }),
  source: z.enum(['token', 'cli', 'device']),
  expiresAt: z.number().nullable(),
}).strict();

export type SavedAccount = z.infer<typeof savedAccount>;

export class GitHubVault {
  private readonly file: string;
  constructor(private readonly directory: string, private readonly encryption?: SecretEncryption) {
    this.file = path.join(directory, 'github-account.enc');
  }

  available(): boolean { return this.encryption?.available() ?? false; }

  async load(): Promise<SavedAccount | null> {
    let bytes: Buffer;
    try { bytes = await readFile(this.file); }
    catch (error) { if (isMissing(error)) return null; throw new GitError('ACCOUNT_STORAGE_FAILED', 'Could not read the saved GitHub account. Check app data permissions.'); }
    if (!this.encryption || !this.available()) {
      throw new GitError('KEYCHAIN_UNAVAILABLE', 'Unlock your operating-system keychain to access the saved GitHub account, or sign out to remove it.');
    }
    try {
      if (bytes.length > 64 * 1024) throw new Error('Oversized account file');
      return savedAccount.parse(JSON.parse(this.encryption.decrypt(bytes)));
    } catch {
      throw new GitError('ACCOUNT_STORAGE_FAILED', 'The saved GitHub account could not be decrypted. Sign out, then sign in again.');
    }
  }

  async save(account: SavedAccount): Promise<void> {
    if (!this.encryption || !this.available()) throw new GitError('KEYCHAIN_UNAVAILABLE', 'Secure OS credential storage is unavailable. Sign in without Remember me to use a memory-only session.');
    const temporary = path.join(this.directory, `.github-account-${randomUUID()}.tmp`);
    let created = false;
    try {
      const bytes = this.encryption.encrypt(JSON.stringify(savedAccount.parse(account)));
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      created = true;
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, this.file);
    } catch {
      if (created) {
        try { await unlink(temporary); } catch (error) { if (!isMissing(error)) throw new GitError('ACCOUNT_STORAGE_FAILED', 'Could not clean up encrypted GitHub account data. Check app data permissions.'); }
      }
      throw new GitError('ACCOUNT_STORAGE_FAILED', 'Could not save the encrypted GitHub account. Check app data permissions.');
    }
  }

  async clear(): Promise<void> {
    try { await unlink(this.file); }
    catch (error) { if (!isMissing(error)) throw new GitError('ACCOUNT_STORAGE_FAILED', 'Could not remove the saved GitHub account. Check app data permissions.'); }
  }
}
