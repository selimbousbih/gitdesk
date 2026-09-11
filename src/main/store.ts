import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Repository, Theme } from '../shared/api';
import { GitError, isMissing } from './git/errors';

const schema = z.object({
  version: z.literal(1),
  repositories: z.array(z.object({ id: z.string().uuid(), name: z.string().min(1), path: z.string().min(1) }).strict()),
  selectedRepoId: z.string().uuid().nullable(),
  theme: z.enum(['system', 'light', 'dark']),
  defaultBranch: z.string().min(1).max(1024),
}).strict();

export interface StoredState {
  version: 1;
  repositories: Repository[];
  selectedRepoId: string | null;
  theme: Theme;
  defaultBranch: string;
}

export class AppStore {
  private state?: Promise<StoredState>;
  private tail: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly dataDir: string) { this.file = path.join(dataDir, 'state.json'); }

  private async load(): Promise<StoredState> {
    try {
      const state = schema.parse(JSON.parse(await readFile(this.file, 'utf8')));
      if (new Set(state.repositories.map((repo) => repo.id)).size !== state.repositories.length ||
          new Set(state.repositories.map((repo) => repo.path)).size !== state.repositories.length ||
          state.repositories.some((repo) => !path.isAbsolute(repo.path)) ||
          (state.selectedRepoId !== null && !state.repositories.some((repo) => repo.id === state.selectedRepoId))) {
        throw new Error('Duplicate or inconsistent repository records.');
      }
      return state;
    } catch (error) {
      if (isMissing(error)) return { version: 1, repositories: [], selectedRepoId: null, theme: 'system', defaultBranch: 'main' };
      throw new GitError('APP_STATE_INVALID', 'Could not read GitDesk settings. Check permissions or repair state.json in the app data folder.', error instanceof Error ? error.message : undefined);
    }
  }

  async read(): Promise<StoredState> {
    await this.tail;
    return structuredClone(await this.snapshot());
  }

  private async snapshot(): Promise<StoredState> {
    const pending = this.state ??= this.load();
    try { return await pending; } catch (error) {
      if (this.state === pending) this.state = undefined;
      throw error;
    }
  }

  async update<T>(change: (state: StoredState) => T | Promise<T>): Promise<T> {
    const pending = this.tail.then(async () => {
      const next = structuredClone(await this.snapshot());
      const result = await change(next);
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const staging = path.join(this.dataDir, `.state-${randomUUID()}.json`);
      const handle = await open(staging, 'wx', 0o600);
      try {
        try {
          await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`);
          await handle.sync();
        } finally { await handle.close(); }
        await rename(staging, this.file);
      } catch (error) {
        await unlink(staging);
        throw error;
      }
      this.state = Promise.resolve(next);
      return result;
    });
    // A failed transaction must not poison subsequent requests; its caller still receives the error.
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
}
