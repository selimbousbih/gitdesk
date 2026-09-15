import { describe, expect, it } from 'vitest';
import { commandNames, parseCommandArgs } from '../src/shared/validation';
import { appError, runCommand, safeMessage, trustedSender } from '../src/main/ipc';

const repoId = 'dc695ce2-28f4-43cf-bb13-6926f658d286';

describe('narrow desktop IPC validation', () => {
  it('exposes only the explicitly declared command set', () => {
    expect(commandNames).toContain('status');
    expect(commandNames).not.toContain('exec');
    expect(commandNames).not.toContain('readFile');
    expect(commandNames).not.toContain('shell');
  });

  it('rejects unknown input fields, bad identifiers and wrong types', () => {
    expect(() => parseCommandArgs('status', { repoId, cwd: '/tmp' })).toThrow();
    expect(() => parseCommandArgs('status', { repoId: '/tmp/repository' })).toThrow();
    expect(() => parseCommandArgs('stage', { repoId, paths: ['hello'], stage: 'yes' })).toThrow();
    expect(() => parseCommandArgs('stage', { repoId, paths: [], stage: true })).toThrow();
    expect(() => parseCommandArgs('discard', { repoId, paths: ['hello'] })).toThrow();
    expect(() => parseCommandArgs('windowControl', { action: 'exec' })).toThrow();
  });

  it('keeps legal unusual filenames intact, rejects NUL', () => {
    const paths = ['space name', 'ユニコード', 'line\nbreak', '--flag', 'a[1].txt'];
    expect(parseCommandArgs('stage', { repoId, paths, stage: true }).paths).toEqual(paths);
    expect(() => parseCommandArgs('stage', { repoId, paths: ['a\0b'], stage: true })).toThrow();
  });

  it('prevents reference option injection and bounds history/diff input', () => {
    for (const name of ['--exec=touch', '-b', 'main\n--force', 'main branch']) {
      expect(() => parseCommandArgs('branch', { repoId, action: 'switch', name })).toThrow();
    }
    const create = parseCommandArgs('branch', { repoId, action: 'create', name: 'feature', dirtyAction: 'carry' });
    expect(create.action === 'create' && create.dirtyAction).toBe('carry');
    expect(() => parseCommandArgs('branch', { repoId, action: 'create', name: 'feature', dirtyAction: 'discard' })).toThrow();
    expect(() => parseCommandArgs('branch', { repoId, action: 'switch', name: 'feature', dirtyAction: 'carry' })).toThrow();
    expect(() => parseCommandArgs('diff', { repoId, path: 'x', source: 'commit', commit: '--output=x' })).toThrow();
    expect(() => parseCommandArgs('history', { repoId, skip: -1, limit: 30, search: '' })).toThrow();
    expect(() => parseCommandArgs('history', { repoId, skip: 0, limit: 100_000, search: '' })).toThrow();
    expect(() => parseCommandArgs('stash', { repoId, action: 'drop', ref: '--all', confirmed: true })).toThrow();
  });

  it('does not allow clone/init destination to escape its chosen parent', () => {
    for (const name of ['..', '../x', '/tmp/a', 'a/b', 'a\\b', '-flag', '.']) {
      expect(() => parseCommandArgs('initRepository', { parentPath: '/tmp', name, defaultBranch: 'main' })).toThrow();
    }
  });

  it('only trusts the exact app main document or explicit loopback dev document', () => {
    const file = 'file:///app/dist/index.html';
    const dev = 'http://127.0.0.1:5173/';
    expect(trustedSender(file, file)).toBe(true);
    expect(trustedSender(dev, file, dev)).toBe(true);
    for (const url of ['https://evil.test/', 'file:///tmp/index.html', `${file}?x=1`, `${file}#x`, 'http://127.0.0.1:5174/', 'http://127.0.0.1:5173/other', 'not a url']) {
      expect(trustedSender(url, file)).toBe(false);
      expect(trustedSender(url, file, dev)).toBe(false);
    }
  });

  it('returns structured errors without leaking URL credentials', () => {
    expect(safeMessage('fatal: https://alice:secret@example.test/repo.git')).not.toContain('secret');
    expect(safeMessage('https://host/repo?token=secret&x=yes')).not.toContain('secret');
    expect(appError(new Error('operation failed')).code).toBe('OPERATION_FAILED');
    try {
      parseCommandArgs('status', {});
    } catch (error) {
      expect(appError(error).code).toBe('INVALID_INPUT');
    }
  });

  it('validates before dispatch and reports command failures as failures', async () => {
    let calls = 0;
    const handlers = {
      async removeRepository() { calls++; },
    };
    const rejected = await runCommand(handlers, 'removeRepository', { repoId: '../../outside' });
    expect(rejected.ok).toBe(false);
    expect(calls).toBe(0);
    const accepted = await runCommand(handlers, 'removeRepository', { repoId });
    expect(accepted).toEqual({ ok: true, data: undefined });
    expect(calls).toBe(1);
    const failed = await runCommand({
      async removeRepository() {
        throw Object.assign(new Error('Repository is missing'), { code: 'MISSING_REPO', detail: 'Restore the folder or remove it from the app.' });
      },
    }, 'removeRepository', { repoId });
    expect(failed).toEqual({
      ok: false,
      error: { code: 'MISSING_REPO', message: 'Repository is missing', detail: 'Restore the folder or remove it from the app.' },
    });
  });
});
