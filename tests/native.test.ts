import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isInside, remoteWebUrl, repositoryFile } from '../src/main/native';

describe('safe native file actions', () => {
  let temp: string;
  let repo: string;
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'gitdesk-native-test-'));
    repo = join(temp, 'repository');
    await mkdir(repo);
  });
  afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

  it('opens only canonical regular repository files', async () => {
    await writeFile(join(repo, 'odd\n名 name.txt'), 'content');
    expect(await repositoryFile(repo, 'odd\n名 name.txt')).toBe(join(repo, 'odd\n名 name.txt'));
    expect(isInside(repo, `${repo}-other/file`)).toBe(false);
    expect(isInside(repo, repo)).toBe(false);
    await expect(repositoryFile(repo, '..')).rejects.toThrow();
    await expect(repositoryFile(repo, '/etc/passwd')).rejects.toThrow();
    await expect(repositoryFile(repo, '.git/config')).rejects.toThrow();
  });

  it('rejects outside symlinks, directories and symlinks into Git metadata', async () => {
    await writeFile(join(temp, 'outside'), 'outside');
    await symlink(join(temp, 'outside'), join(repo, 'link'));
    await expect(repositoryFile(repo, 'link')).rejects.toThrow();
    await mkdir(join(repo, 'directory'));
    await expect(repositoryFile(repo, 'directory')).rejects.toThrow();
    await mkdir(join(repo, '.git'));
    await writeFile(join(repo, '.git/config'), 'metadata');
    await symlink(join(repo, '.git/config'), join(repo, 'metadata-link'));
    await expect(repositoryFile(repo, 'metadata-link')).rejects.toThrow();
  });
});

describe('remote browser links', () => {
  const sha = 'a'.repeat(40);
  it('converts supported SSH and HTTPS remotes without shell interpolation', () => {
    expect(remoteWebUrl('git@github.com:owner/repository.git', sha)).toBe(`https://github.com/owner/repository/commit/${sha}`);
    expect(remoteWebUrl('ssh://git@gitlab.com/owner/repository.git', sha)).toBe(`https://gitlab.com/owner/repository/-/commit/${sha}`);
    expect(remoteWebUrl('https://bitbucket.org/owner/repository.git', sha)).toBe(`https://bitbucket.org/owner/repository/commits/${sha}`);
    expect(remoteWebUrl('https://git.example.com/team/repo.git')).toBe('https://git.example.com/team/repo');
  });
  it('rejects local, executable, credential-bearing and unsupported commit addresses', () => {
    for (const value of [
      'file:///tmp/repo', '/tmp/repo', 'ext::sh -c run',
      'https://user:secret@github.com/a/b', 'https://github.com/a/b?token=secret',
      'javascript:alert(1)', 'https://github.com/a\nb', 'https://github.com\\a\\b',
      'ssh://git:secret@github.com/a/b', 'ssh://git@github.com/a/b?token=secret',
      'ssh://git@github.com/a/b#fragment', 'ssh://[redacted]@github.com/a/b',
      'ssh://%5Bredacted%5D@github.com/a/b',
    ]) {
      expect(() => remoteWebUrl(value)).toThrow();
    }
    expect(() => remoteWebUrl('https://custom.example/a/b', sha)).toThrow('supported');
    expect(() => remoteWebUrl('https://github.com/a/b', '--oops')).toThrow();
  });
});
