import type { ChangedFile, Commit, StatusFile } from '../../shared/api';
import { isUtf8 } from 'node:buffer';
import { GitError } from './errors';

function fieldsAndPath(record: string, count: number): { fields: string[]; path: string } {
  const fields: string[] = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const next = record.indexOf(' ', offset);
    if (next < 0) throw new GitError('INVALID_GIT_OUTPUT', 'Git returned an invalid status record.');
    fields.push(record.slice(offset, next));
    offset = next + 1;
  }
  return { fields, path: record.slice(offset) };
}

export function parseStatus(output: Buffer): {
  files: StatusFile[]; branch: string; head: string | null; upstream: string | null;
  ahead: number; behind: number; unborn: boolean; detached: boolean;
} {
  if (!isUtf8(output)) throw new GitError('UNSUPPORTED_ENCODING', 'A repository filename is not valid UTF-8. Rename it using Git before managing these files in GitDesk.');
  const result = { files: [] as StatusFile[], branch: '', head: null as string | null, upstream: null as string | null, ahead: 0, behind: 0, unborn: false, detached: false };
  const records = output.toString('utf8').split('\0');
  const files = new Map<string, StatusFile>();
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice(13);
      result.unborn = oid === '(initial)';
      result.head = result.unborn ? null : oid;
    } else if (record.startsWith('# branch.head ')) {
      result.branch = record.slice(14);
      result.detached = result.branch === '(detached)';
    } else if (record.startsWith('# branch.upstream ')) {
      result.upstream = record.slice(18);
    } else if (record.startsWith('# branch.ab ')) {
      const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]); }
    } else if (['1', '2', 'u'].includes(record[0])) {
      const parsed = fieldsAndPath(record, record[0] === 'u' ? 10 : record[0] === '2' ? 9 : 8);
      const xy = parsed.fields[1];
      const file: StatusFile = {
        path: parsed.path, index: xy[0], worktree: xy[1], staged: xy[0] !== '.',
        unstaged: xy[1] !== '.', untracked: false, conflicted: record[0] === 'u',
      };
      if (record[0] === '2') {
        const original = records[++i];
        if (!original) throw new GitError('INVALID_GIT_OUTPUT', 'Git returned a rename without its original path.');
        file.oldPath = original;
      }
      files.set(file.path, file);
    } else if (record.startsWith('? ')) {
      const name = record.slice(2);
      const previous = files.get(name);
      files.set(name, {
        path: name, index: previous?.index ?? '?', worktree: '?', staged: previous?.staged ?? false,
        unstaged: true, untracked: true, conflicted: previous?.conflicted ?? false,
        ...(previous?.oldPath ? { oldPath: previous.oldPath } : {}),
      });
    }
  }
  result.files = [...files.values()];
  if (result.detached) result.branch = `Detached at ${result.head?.slice(0, 8) ?? 'HEAD'}`;
  return result;
}

export const COMMIT_FORMAT = '%H%x00%s%x00%b%x00%an%x00%ae%x00%aI%x00%P';

export function parseCommits(output: Buffer): Commit[] {
  const fields = output.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 7 !== 0) throw new GitError('INVALID_GIT_OUTPUT', 'Git returned an invalid commit record.');
  const commits: Commit[] = [];
  for (let i = 0; i < fields.length; i += 7) {
    commits.push({
      sha: fields[i], summary: fields[i + 1], body: fields[i + 2], author: fields[i + 3],
      email: fields[i + 4], date: fields[i + 5], parents: fields[i + 6] ? fields[i + 6].split(' ') : [],
    });
  }
  return commits;
}

export function parseChangedFiles(output: Buffer): ChangedFile[] {
  if (!isUtf8(output)) throw new GitError('UNSUPPORTED_ENCODING', 'A changed filename is not valid UTF-8 and cannot safely be represented in GitDesk.');
  const fields = output.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const files: ChangedFile[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (/^[RC]\d+$/.test(status)) {
      const oldPath = fields[i++];
      const path = fields[i++];
      if (path === undefined) throw new GitError('INVALID_GIT_OUTPUT', 'Git returned an incomplete renamed file.');
      files.push({ path, oldPath, status });
    } else {
      const path = fields[i++];
      if (path === undefined) throw new GitError('INVALID_GIT_OUTPUT', 'Git returned an incomplete changed file.');
      files.push({ path, status });
    }
  }
  return files;
}
