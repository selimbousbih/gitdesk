import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubVault, type SavedAccount, type SecretEncryption } from '../src/main/github/vault';
import { GitError, toAppError } from '../src/main/git/errors';

const account: SavedAccount = {
  token: 'fixture_vault_token_1234567890', user: { login: 'fixture', name: 'Fixture User' },
  source: 'device', expiresAt: new Date('2026-09-01T12:30:00.000Z').getTime(),
};

function fixtureEncryption(): SecretEncryption {
  const key = Buffer.alloc(32, 0x71);
  return {
    available: vi.fn(() => true),
    encrypt: vi.fn((value: string) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    }),
    decrypt: vi.fn((value: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    }),
  };
}

let root: string;
let directory: string;
let file: string;
let encryption: SecretEncryption;
let vault: GitHubVault;

async function expectStorageFailure(operation: Promise<unknown>, code = 'ACCOUNT_STORAGE_FAILED'): Promise<void> {
  let error: unknown;
  try { await operation; } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(GitError);
  expect(error).toMatchObject({ code });
  expect(JSON.stringify(toAppError(error))).not.toContain(account.token);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(process.cwd(), '.gitdesk-github-vault-tests-'));
  directory = path.join(root, 'data');
  file = path.join(directory, 'github-account.enc');
  encryption = fixtureEncryption();
  vault = new GitHubVault(directory, encryption);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('encrypted GitHub account vault', () => {
  it('does not create files or require a keychain for a missing account', async () => {
    const unavailable = new GitHubVault(directory);
    expect(unavailable.available()).toBe(false);
    expect(await unavailable.load()).toBeNull();
    await unavailable.clear();
    expect(await readdir(root)).toEqual([]);
    expect(encryption.decrypt).not.toHaveBeenCalled();
  });

  it('round-trips a remembered account through authenticated encryption without plaintext disk data', async () => {
    await vault.save(account);
    expect(encryption.encrypt).toHaveBeenCalledExactlyOnceWith(JSON.stringify(account));
    const bytes = await readFile(file);
    expect(bytes.toString('utf8')).not.toContain(account.token);
    expect(bytes.toString('utf8')).not.toContain(account.user.login);
    expect(() => JSON.parse(bytes.toString('utf8'))).toThrow();
    expect(await new GitHubVault(directory, fixtureEncryption()).load()).toEqual(account);
    expect(await readdir(directory)).toEqual(['github-account.enc']);
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('atomically replaces a saved account without leftover staging files', async () => {
    await vault.save(account);
    const previous = await readFile(file);
    const replacement: SavedAccount = { ...account, token: 'fixture_replacement_token_12345', source: 'cli', expiresAt: null };
    await vault.save(replacement);
    expect(await vault.load()).toEqual(replacement);
    expect(await readFile(file)).not.toEqual(previous);
    expect(await readdir(directory)).toEqual(['github-account.enc']);
  });

  it('preserves expiry metadata for the client to enforce rather than contacting a provider', async () => {
    const expired: SavedAccount = { ...account, expiresAt: 1 };
    await vault.save(expired);
    expect(await vault.load()).toEqual(expired);
  });

  it.each([false, undefined])('refuses persistence when encryption availability is %s', async available => {
    const storage = new GitHubVault(directory, available === undefined ? undefined : { ...encryption, available: () => available });
    expect(storage.available()).toBe(false);
    await expectStorageFailure(storage.save(account), 'KEYCHAIN_UNAVAILABLE');
    expect(encryption.encrypt).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses loading saved credentials while the keychain is locked, but allows explicit removal', async () => {
    await vault.save(account);
    const locked = new GitHubVault(directory, { ...encryption, available: () => false });
    await expectStorageFailure(locked.load(), 'KEYCHAIN_UNAVAILABLE');
    expect(encryption.decrypt).not.toHaveBeenCalled();
    expect(await readFile(file)).toBeInstanceOf(Buffer);
    await locked.clear();
    expect(await locked.load()).toBeNull();
  });

  it('removes only the account file and can be called repeatedly', async () => {
    await vault.save(account);
    await writeFile(path.join(directory, 'state.json'), '{"repositories":["preserved"]}');
    await mkdir(path.join(directory, 'other-data'));
    await writeFile(path.join(directory, 'other-data', 'keep.txt'), 'keep');
    await vault.clear();
    await vault.clear();
    expect((await readdir(directory)).sort()).toEqual(['other-data', 'state.json']);
    expect(await readFile(path.join(directory, 'state.json'), 'utf8')).toBe('{"repositories":["preserved"]}');
    expect(await readFile(path.join(directory, 'other-data', 'keep.txt'), 'utf8')).toBe('keep');
    expect(await vault.load()).toBeNull();
  });

  it('rejects authentication-tag corruption without leaking account contents', async () => {
    await vault.save(account);
    const bytes = await readFile(file);
    bytes[bytes.length - 1] ^= 1;
    await writeFile(file, bytes);
    await expectStorageFailure(vault.load());
    expect(await readFile(file)).toEqual(bytes);
  });

  it('rejects oversized persisted data before passing it to the encryption adapter', async () => {
    await mkdir(directory);
    await writeFile(file, Buffer.alloc(64 * 1024 + 1));
    await expectStorageFailure(vault.load());
    expect(encryption.decrypt).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', '{not JSON'],
    ['malformed token', JSON.stringify({ ...account, token: 'bad token\n' })],
    ['malformed owner', JSON.stringify({ ...account, user: { login: '../bad', name: null } })],
    ['unknown source', JSON.stringify({ ...account, source: 'other' })],
    ['invalid expiry', JSON.stringify({ ...account, expiresAt: 'tomorrow' })],
    ['unexpected field', JSON.stringify({ ...account, password: account.token })],
    ['missing user', JSON.stringify({ token: account.token, source: 'token', expiresAt: null })],
  ])('rejects decryptable account data containing %s', async (_label, plaintext) => {
    await mkdir(directory);
    await writeFile(file, encryption.encrypt(plaintext));
    await expectStorageFailure(vault.load());
  });

  it('sanitizes decryption failures raised by a platform encryption adapter', async () => {
    await vault.save(account);
    const broken = new GitHubVault(directory, {
      ...encryption, decrypt: () => { throw new Error(`Fixture decrypt error: ${account.token}`); },
    });
    await expectStorageFailure(broken.load());
  });

  it('sanitizes encryption failures without replacing an existing saved account', async () => {
    await vault.save(account);
    const original = await readFile(file);
    const broken = new GitHubVault(directory, {
      ...encryption, encrypt: () => { throw new Error(`Fixture encrypt error: ${account.token}`); },
    });
    await expectStorageFailure(broken.save(account));
    expect(await readFile(file)).toEqual(original);
    expect(await readdir(directory)).toEqual(['github-account.enc']);
  });

  it('reports an unreadable account path rather than treating it as a missing login', async () => {
    await mkdir(file, { recursive: true });
    await expectStorageFailure(vault.load());
    await expectStorageFailure(vault.clear());
  });

  it('cleans up encrypted staging data when replacing the account file fails', async () => {
    await mkdir(file, { recursive: true });
    await writeFile(path.join(file, 'keep.txt'), 'unrelated directory contents');
    await expectStorageFailure(vault.save(account));
    expect(await readdir(directory)).toEqual(['github-account.enc']);
    expect(await readFile(path.join(file, 'keep.txt'), 'utf8')).toBe('unrelated directory contents');
  });

  it('reports an actionable storage error when the data directory is a file', async () => {
    await writeFile(directory, 'unrelated file');
    await expectStorageFailure(vault.save(account));
    expect(await readFile(directory, 'utf8')).toBe('unrelated file');
    expect(await readdir(root)).toEqual(['data']);
  });
});
