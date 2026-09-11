import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowRight, Check, CheckCheck, Circle, Copy, ExternalLink, File, FileCode2,
  FilePlus2, GitCommitHorizontal, GitMerge, GitPullRequestArrow, History, MoreHorizontal,
  Search, ShieldCheck, SquareMinus, SquarePen, Undo2,
} from 'lucide-react';
import type { AppError, ChangedFile, Commit, RepoStatus, Repository, StatusFile } from '../shared/api';
import { errorInfo, request, safely, useDebounced, useResource, type Perform } from './core';
import { DiffView } from './diff';
import { EmptyState, ErrorBox, Menu, MenuItem, Spinner, formatDate, shortPath, type Confirm } from './ui';

export type WorkspaceTab = 'changes' | 'history';
interface WorkspaceProps {
  repo: Repository;
  status: RepoStatus;
  perform: Perform;
  confirm: Confirm;
  busy: boolean;
  revision: number;
  refresh: () => void;
  tab: WorkspaceTab;
  setTab: (tab: WorkspaceTab) => void;
}

export function SidebarTabs({ tab, setTab, count }: { tab: WorkspaceTab; setTab: (tab: WorkspaceTab) => void; count: number }) {
  return <div className="sidebar-tabs" role="tablist" aria-label="Repository view" onKeyDown={event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'changes' : event.key === 'End' ? 'history' : tab === 'changes' ? 'history' : 'changes';
    setTab(next);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[role="tab"][aria-controls="${next}-panel"]`)?.focus());
  }}>
    <button role="tab" tabIndex={tab === 'changes' ? 0 : -1} aria-selected={tab === 'changes'} aria-controls="changes-panel" className={tab === 'changes' ? 'active' : ''}
      onClick={() => setTab('changes')}><SquarePen size={14} />Changes<span className="count-badge">{count}</span></button>
    <button role="tab" tabIndex={tab === 'history' ? 0 : -1} aria-selected={tab === 'history'} aria-controls="history-panel" className={tab === 'history' ? 'active' : ''}
      onClick={() => setTab('history')}><History size={14} />History</button>
  </div>;
}

function FileStatus({ file }: { file: StatusFile | ChangedFile }) {
  const conflicted = 'conflicted' in file && file.conflicted;
  const code = 'status' in file ? file.status : file.untracked ? '?' : `${file.index}${file.worktree}`;
  const kind = conflicted ? 'conflict' : code.includes('D') ? 'deleted' : code.includes('R') ? 'renamed'
    : code.includes('A') || code === '?' ? 'added' : 'modified';
  const icons = { conflict: <AlertTriangle size={14} />, deleted: <SquareMinus size={14} />, renamed: <ArrowRight size={14} />, added: <FilePlus2 size={14} />, modified: <SquarePen size={14} /> };
  return <span className={`file-status ${kind}`} title={conflicted ? 'Conflicted' : code === '?' ? 'Untracked' : kind} aria-label={conflicted ? 'Conflicted' : code === '?' ? 'Untracked' : kind}>{icons[kind]}</span>;
}

function StageCheckbox({ checked, mixed, label, disabled, onChange }: {
  checked: boolean; mixed?: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!mixed; }, [mixed]);
  return <input ref={ref} className="stage-checkbox" type="checkbox" aria-label={label} title={label} checked={checked}
    aria-checked={mixed ? 'mixed' : checked} disabled={disabled} onChange={event => {
      if (mixed) event.currentTarget.indeterminate = true;
      onChange(mixed ? true : event.currentTarget.checked);
    }} />;
}

function FileName({ path, oldPath }: { path: string; oldPath?: string }) {
  const { name, directory } = shortPath(path);
  return <span className="filename" title={oldPath ? `${oldPath} → ${path}` : path}><span>{name}</span>
    {directory && <small>{directory}/</small>}{oldPath && <small className="renamed-from">from {oldPath}</small>}</span>;
}

function ConflictBanner({ status, repo, busy, perform, confirm }: Pick<WorkspaceProps, 'status' | 'repo' | 'busy' | 'perform' | 'confirm'>) {
  const conflicts = status.files.filter(file => file.conflicted).length;
  if (!status.operation && !conflicts) return null;
  return <div className={`operation-banner ${conflicts ? 'has-conflicts' : ''}`}>
    {conflicts ? <AlertTriangle size={19} /> : <GitMerge size={19} />}
    <div><strong>{status.operation ? `${status.operation.type === 'rebase' ? 'Rebase' : status.operation.type === 'merge' ? 'Merge' : status.operation.type === 'revert' ? 'Revert' : 'Cherry-pick'} in progress` : 'Conflicts need your attention'}</strong>
      <p>{conflicts ? `${conflicts} conflicted ${conflicts === 1 ? 'file' : 'files'}. Select a file to resolve it.` :
        status.operation?.message || 'Review the staged result, then continue the operation.'}
        {!status.operation && ' These may be from a stash or another Git action; there is no active operation to continue or abort.'}</p>
    </div>
    {status.operation && <div className="button-row">
      <button className="button small" disabled={busy} onClick={() => void safely(async () => {
        if (!await confirm({ title: `Abort ${status.operation!.type}?`, message: 'Stop this operation and restore its previous state?',
          detail: 'Conflict resolutions and changes made during the operation may be lost.', confirmLabel: 'Abort operation', danger: true })) return;
        await perform('operation', { repoId: repo.id, action: 'abort', confirmed: true });
      })}>Abort…</button>
      <button className="button primary small" disabled={busy || conflicts > 0} onClick={() => void safely(async () => {
        if (!await confirm({ title: `Continue ${status.operation!.type}?`, message: 'Continue with the current staged resolutions?',
          detail: 'Make sure every conflict is resolved and the staged result is correct.', confirmLabel: 'Continue operation' })) return;
        await perform('operation', { repoId: repo.id, action: 'continue', confirmed: true });
      })}>Continue…</button>
    </div>}
  </div>;
}

function ConflictTools({ file, status, repo, perform, confirm, busy, binary }: Pick<WorkspaceProps, 'status' | 'repo' | 'busy' | 'perform' | 'confirm'> & { file: StatusFile; binary: boolean }) {
  const [resolutionError, setResolutionError] = useState<AppError | null>(null);
  useEffect(() => { setResolutionError(null); }, [file.path]);
  const resolve = async (action: () => Promise<unknown>) => {
    setResolutionError(null);
    try { await action(); } catch (error) { setResolutionError(errorInfo(error)); }
  };
  if (!file.conflicted) return null;
  const rebase = status.operation?.type === 'rebase';
  const labels = { ours: rebase ? 'Upstream (ours)' : 'Current branch (ours)', theirs: rebase ? 'Replayed commit (theirs)' : 'Incoming (theirs)' };
  return <div className="conflict-tools">
    <div><AlertTriangle size={16} /><strong>Resolve this conflict</strong><span>Choose a side, or edit the file and mark it resolved.</span></div>
    <div className="button-row">
      <button className="button small" title="Open in VS Code or VSCodium" disabled={busy} onClick={() => void safely(() => perform('openPath', { repoId: repo.id, target: 'editor', path: file.path }))}>Edit in editor</button>
      {(['ours', 'theirs'] as const).map(choice => <button key={choice} className="button small" disabled={busy} onClick={() => void resolve(async () => {
        if (!await confirm({ title: `Use ${labels[choice]}?`, message: `Replace “${file.path}” with ${labels[choice].toLowerCase()}?`,
          detail: 'This discards the other side and any manual edits in this file. The selected version will be staged as the resolution. For a deletion, the file may be removed.', confirmLabel: `Use ${labels[choice]}`, danger: true })) return;
        await perform('resolve', { repoId: repo.id, paths: [file.path], choice, confirmed: true });
      })}>{labels[choice]}…</button>)}
      <button className="button primary small" disabled={busy} onClick={() => void resolve(async () => {
        if (!await confirm({ title: 'Mark file resolved?', message: `Stage the current contents of “${file.path}” as the conflict resolution?`,
          detail: binary ? 'Git cannot verify binary conflict resolutions. Confirm that you have inspected this file and it contains the version you want to keep.'
            : 'Check that you have combined the changes correctly. Any remaining conflict markers will prevent this file from being marked resolved.',
          confirmLabel: 'Mark resolved' })) return;
        await perform('resolve', { repoId: repo.id, paths: [file.path], choice: 'mark', confirmed: true });
      })}><Check size={13} />Mark resolved…</button>
    </div>
    {resolutionError && <ErrorBox error={resolutionError} />}
  </div>;
}

interface Draft { summary: string; description: string; amend: boolean }
const commitDrafts = new Map<string, Draft>();

export function ChangesWorkspace(props: WorkspaceProps) {
  const { repo, status, perform, confirm, busy, revision, refresh, tab, setTab } = props;
  const [filter, setFilter] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [source, setSource] = useState<'working' | 'staged'>('working');
  const [draft, setDraft] = useState<Draft>(() => commitDrafts.get(repo.id) ?? { summary: '', description: '', amend: false });
  const [commitError, setCommitError] = useState<AppError | null>(null);
  useEffect(() => { commitDrafts.set(repo.id, draft); }, [repo.id, draft]);
  const visibleFiles = status.files.filter(file => file.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const selected = status.files.find(file => file.path === selectedPath) ?? visibleFiles[0] ?? null;
  useEffect(() => {
    if (selected && selected.path !== selectedPath) {
      setSelectedPath(selected.path);
      setSource(selected.staged && !selected.unstaged ? 'staged' : 'working');
    }
  }, [selected, selectedPath]);
  const diff = useResource(selected ? `${repo.id}:${selected.path}:${source}` : null,
    () => request('diff', { repoId: repo.id, path: selected!.path, source }), [revision]);
  const staged = status.files.filter(file => file.staged && !file.conflicted);
  const stageable = status.files.filter(file => !file.conflicted);
  const allStaged = stageable.length > 0 && stageable.every(file => file.staged && !file.unstaged);
  const conflicts = status.files.some(file => file.conflicted);
  const stage = (files: StatusFile[], value: boolean) => safely(() => perform('stage', { repoId: repo.id, paths: files.map(file => file.path), stage: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || (!staged.length && !draft.amend) || !draft.summary.trim() || conflicts || status.operation) return;
    void (async () => {
      if (draft.amend && !await confirm({ title: 'Amend the last commit?', message: 'Replace the last commit with this message and the staged changes?',
        detail: 'Amending changes the commit ID and rewrites history. Avoid amending a commit that others have already pulled.', confirmLabel: 'Amend commit', danger: true })) return;
      setCommitError(null);
      try {
        await perform('commit', { repoId: repo.id, summary: draft.summary.trim(), description: draft.description, amend: draft.amend,
          ...(draft.amend ? { confirmed: true } : {}) });
        setDraft({ summary: '', description: '', amend: false });
      } catch (error) { setCommitError(errorInfo(error)); }
    })();
  };
  return <>
    <aside className="sidebar" aria-label="Changes sidebar">
      <SidebarTabs tab={tab} setTab={setTab} count={status.files.length} />
      <div className="sidebar-filter"><Search size={14} /><input aria-label="Filter changed files" placeholder="Filter changed files…" value={filter} onChange={event => setFilter(event.target.value)} /></div>
      <div className="files-heading"><StageCheckbox checked={allStaged} mixed={!allStaged && staged.length > 0}
        label={allStaged ? 'Unstage all files' : 'Stage all non-conflicted files'} disabled={busy || !stageable.length}
        onChange={value => void stage(stageable, value)} />
        <strong>{filter ? `${visibleFiles.length} of ${status.files.length}` : status.files.length} changed {status.files.length === 1 ? 'file' : 'files'}</strong>
        <span title="Files in the Git index">{staged.length} staged</span>
      </div>
      <div className="file-list" role="list" aria-label="Changed files">
        {visibleFiles.map(file => <div role="listitem" key={file.path} className={`file-row${selected?.path === file.path ? ' selected' : ''}`}>
          <StageCheckbox checked={file.staged} mixed={file.staged && file.unstaged} disabled={busy || file.conflicted}
            label={file.conflicted ? `Resolve conflicts in ${file.path} first` : file.staged && file.unstaged ? `Stage remaining changes in ${file.path} (partially staged)` : `${file.staged ? 'Unstage' : 'Stage'} ${file.path}`}
            onChange={value => void stage([file], value)} />
          <button className="file-select" aria-label={`View changes to ${file.path}`} aria-pressed={selected?.path === file.path} onClick={() => {
            setSelectedPath(file.path); setSource(file.staged && !file.unstaged ? 'staged' : 'working');
          }}><FileName path={file.path} oldPath={file.oldPath} />
            {file.staged && file.unstaged && <span className="partial-dot" title="Partially staged" aria-label="Partially staged" />}
            <FileStatus file={file} />
          </button>
        </div>)}
        {visibleFiles.length === 0 && <div className="list-empty">{filter ? 'No files match your filter.' : <><CheckCheck size={22} /><span>No local changes</span></>}</div>}
      </div>
      <form id="commit-form" className="commit-form" onSubmit={submit}>
        <div className="commit-identity"><span className="commit-avatar"><GitCommitHorizontal size={17} /></span>
          <div><strong>{draft.amend ? 'Amend last commit' : 'Commit your changes'}</strong><small>{staged.length} {staged.length === 1 ? 'file' : 'files'} staged · {status.files.length - staged.length} not staged</small></div>
        </div>
        <label className="sr-only" htmlFor="commit-summary">Commit summary</label>
        <input id="commit-summary" placeholder="Summary (required)" value={draft.summary} maxLength={1000} required disabled={busy}
          onChange={event => setDraft({ ...draft, summary: event.target.value })} />
        <label className="sr-only" htmlFor="commit-description">Commit description</label>
        <textarea id="commit-description" placeholder="Description" value={draft.description} maxLength={32768} rows={3} disabled={busy}
          onChange={event => setDraft({ ...draft, description: event.target.value })} />
        <div className="commit-options"><label className="checkbox-label"><input type="checkbox" checked={draft.amend} disabled={busy || status.unborn || !!status.operation}
          onChange={event => setDraft({ ...draft, amend: event.target.checked })} />Amend last commit</label>
          <span className={draft.summary.length > 72 ? 'text-warning' : 'muted'} title="A concise summary is easier to read">{draft.summary.length}/72</span>
        </div>
        {draft.amend && <p className="commit-warning">Rewrites the last commit. Confirmation required.</p>}
        {commitError && <ErrorBox error={commitError} />}
        {conflicts && <p className="commit-warning">Resolve conflicts before committing.</p>}
        {status.operation && <p className="commit-warning">Use Continue to finish the {status.operation.type}.</p>}
        <button className="button primary commit-button" type="submit" disabled={busy || (!staged.length && !draft.amend) || !draft.summary.trim() || conflicts || !!status.operation}>
          <GitCommitHorizontal size={16} /><span>{draft.amend ? 'Amend last commit' : `Commit ${staged.length ? `${staged.length} staged ${staged.length === 1 ? 'file' : 'files'}` : 'staged changes'}`}</span>
        </button>
        <p className="commit-hint">Only staged changes are committed. <kbd>{window.gitdesk?.platform === 'darwin' ? '⌘' : 'Ctrl'} ↵</kbd></p>
      </form>
    </aside>
    <main className="detail-pane" id="changes-panel" role="tabpanel" aria-label="Changes">
      <ConflictBanner {...props} />
      {selected ? <>
        <header className="file-toolbar"><FileCode2 size={17} /><div className="detail-path"><strong>{selected.path}</strong>
          {selected.oldPath && <small>Renamed from {selected.oldPath}</small>}</div>
          {selected.untracked && <span className="label-tag">Untracked</span>}
          {selected.staged && selected.unstaged && <span className="label-tag partial">Partially staged</span>}
          <Menu label="File actions" align="right" trigger={<MoreHorizontal size={18} />}>
            <MenuItem icon={<ExternalLink size={15} />} title="Open in VS Code or VSCodium" onClick={() => void safely(() => perform('openPath', { repoId: repo.id, target: 'file', path: selected.path }))}>Open in editor</MenuItem>
            <hr />
            <MenuItem disabled={busy || selected.conflicted || (!selected.unstaged && !selected.untracked)} onClick={() => void stage([selected], true)}>Stage file</MenuItem>
            <MenuItem disabled={busy || selected.conflicted || !selected.staged} onClick={() => void stage([selected], false)}>Unstage file</MenuItem>
            <MenuItem disabled={busy || !selected.untracked || selected.conflicted} onClick={() => void safely(() => perform('ignore', { repoId: repo.id, paths: [selected.path] }))}>Ignore untracked file</MenuItem>
            <hr />
            <MenuItem danger disabled={busy || selected.conflicted || (!selected.unstaged && !selected.untracked)} icon={<Undo2 size={15} />} onClick={() => void safely(async () => {
              if (!await confirm({ title: 'Discard unstaged changes?', message: `Permanently discard unstaged changes in “${selected.path}”?`,
                detail: selected.untracked ? 'This untracked file will be deleted. Staged changes are preserved. This cannot be undone in GitDesk.'
                  : 'The working-tree file will be restored from the index. Its staged changes are preserved. This cannot be undone in GitDesk.',
                confirmLabel: 'Discard unstaged changes', danger: true })) return;
              await perform('discard', { repoId: repo.id, paths: [selected.path], confirmed: true });
            })}>Discard unstaged changes…</MenuItem>
          </Menu>
        </header>
        <div className="diff-source-bar"><div className="segmented" role="group" aria-label="Diff source">
          <button className={source === 'working' ? 'active' : ''} aria-pressed={source === 'working'} onClick={() => setSource('working')}>Working tree{selected.unstaged || selected.untracked ? <Circle size={7} fill="currentColor" /> : null}</button>
          <button className={source === 'staged' ? 'active' : ''} aria-pressed={source === 'staged'} onClick={() => setSource('staged')}>Staged{selected.staged ? <Circle size={7} fill="currentColor" /> : null}</button>
        </div><span>{source === 'working' ? 'Working tree ↔ index' : 'Index ↔ HEAD'}{diff.loading && ' · refreshing…'}</span>
          <button className="text-button" disabled={busy || selected.conflicted || (source === 'working' ? !selected.unstaged && !selected.untracked : !selected.staged)}
            onClick={() => void stage([selected], source === 'working')}>{source === 'working' ? 'Stage file' : 'Unstage file'}</button>
        </div>
        <ConflictTools file={selected} binary={diff.data?.binary ?? false} {...props} />
        {diff.error ? <div className="detail-error"><ErrorBox error={diff.error} retry={refresh} /></div>
          : diff.data ? <DiffView key={`${selected.path}:${source}`} diff={diff.data} /> : <div className="pane-loading"><Spinner label="Reading diff…" /></div>}
      </> : <EmptyState icon={<ShieldCheck size={34} />} title={status.unborn ? 'Your first commit starts here' : 'All changes committed'}>
        <p>{status.unborn ? 'Add files to this repository, then stage them in Changes to create your first commit.' : 'Your working tree is clean. A good moment to make something new.'}</p>
        <div className="button-row centered"><button className="button" title="Open in VS Code or VSCodium" onClick={() => void safely(() => perform('openPath', { repoId: repo.id, target: 'editor' }))}>Open in editor<ExternalLink size={13} /></button>
          <button className="button" onClick={() => void safely(() => perform('openPath', { repoId: repo.id, target: 'folder' }))}>Show in file manager</button></div>
        {!status.unborn && <button className="text-button" onClick={() => setTab('history')}>Explore commit history <ArrowRight size={13} /></button>}
      </EmptyState>}
    </main>
  </>;
}

function useHistory(repoId: string, head: string | null, search: string) {
  const key = `${repoId}:${head}:${search}`;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ key: string; commits: Commit[]; hasMore: boolean; error: AppError | null; loading: boolean }>({
    key, commits: [], hasMore: false, error: null, loading: true,
  });
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setState({ key, commits: [], hasMore: false, error: null, loading: true });
    void request('history', { repoId, skip: 0, limit: 50, search }).then(data => {
      if (current === generation.current) setState({ key, ...data, error: null, loading: false });
    }, error => {
      if (current === generation.current) setState({ key, commits: [], hasMore: false, error: errorInfo(error), loading: false });
    });
    return () => { generation.current++; };
  }, [key, repoId, search, revision]);
  const loadMore = async () => {
    if (state.loading || !state.hasMore || state.key !== key) return;
    const current = generation.current;
    setState(value => ({ ...value, loading: true, error: null }));
    try {
      const result = await request('history', { repoId, skip: state.commits.length, limit: 50, search });
      if (current === generation.current) setState(value => ({ ...value, commits: [...value.commits, ...result.commits], hasMore: result.hasMore, loading: false }));
    } catch (error) {
      if (current === generation.current) setState(value => ({ ...value, error: errorInfo(error), loading: false }));
    }
  };
  return { ...(state.key === key ? state : { commits: [], hasMore: false, error: null, loading: true }), loadMore, retry: () => setRevision(value => value + 1) };
}

export function HistoryWorkspace(props: WorkspaceProps) {
  const { repo, status, perform, confirm, busy, tab, setTab } = props;
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const history = useHistory(repo.id, status.head, debounced);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const selected = history.commits.find(commit => commit.sha === selectedSha) ?? history.commits[0] ?? null;
  const [filePath, setFilePath] = useState<string | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const details = useResource(selected ? `${repo.id}:${selected.sha}` : null,
    () => request('commitDetails', { repoId: repo.id, sha: selected!.sha }), [detailRevision]);
  const selectedFile = details.data?.files.find(file => file.path === filePath) ?? details.data?.files[0] ?? null;
  const diff = useResource(selected && selectedFile ? `${repo.id}:${selected.sha}:${selectedFile.path}` : null,
    () => request('diff', { repoId: repo.id, path: selectedFile!.path, source: 'commit', commit: selected!.sha }), [detailRevision]);
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState<AppError | null>(null);
  useEffect(() => { setCopied(false); setActionError(null); }, [selected?.sha]);
  const commitAction = async (action: 'revert' | 'cherryPick' | 'checkout') => {
    if (!selected) return;
    const labels = { revert: 'Revert commit', cherryPick: 'Cherry-pick commit', checkout: 'Check out commit' };
    const messages = {
      revert: 'Create a new commit that undoes this commit. Conflicts may need to be resolved.',
      cherryPick: `Apply this commit on “${status.branch}”. This creates a new commit and may cause conflicts.`,
      checkout: 'Enter detached HEAD at this commit. New commits will not belong to a branch until you create one. This requires a clean working tree; commit or stash all local changes first.',
    };
    if (!await confirm({ title: `${labels[action]}?`, message: `${selected.summary} (${selected.sha.slice(0, 7)})`,
      detail: messages[action], confirmLabel: labels[action], danger: action === 'checkout' })) return;
    setActionError(null);
    try { await perform('commitAction', { repoId: repo.id, action, sha: selected.sha, confirmed: true }); }
    catch (error) { setActionError(errorInfo(error)); }
  };
  return <>
    <aside className="sidebar" aria-label="History sidebar">
      <SidebarTabs tab={tab} setTab={setTab} count={status.files.length} />
      <div className="sidebar-filter"><Search size={14} /><input aria-label="Search commit history" title="Search by commit SHA, message, author, or email" placeholder="Search commit history…" value={search} maxLength={500} onChange={event => setSearch(event.target.value)} /></div>
      <div className="history-heading"><span>{history.commits.length} commits loaded</span><GitCommitHorizontal size={14} /></div>
      <div className="history-list" role="list" aria-label="Commit history">
        {history.commits.map(commit => <div role="listitem" key={commit.sha}><button className={`history-row${selected?.sha === commit.sha ? ' selected' : ''}`}
          aria-current={selected?.sha === commit.sha ? 'true' : undefined} onClick={() => { setSelectedSha(commit.sha); setFilePath(null); }}>
          <span className="history-node"><GitCommitHorizontal size={17} /></span>
          <span className="history-row-content"><strong>{commit.summary || '(no commit message)'}</strong>
            <span><b>{commit.author}</b><time title={formatDate(commit.date)}>{formatDate(commit.date, true)}</time></span>
            <code>{commit.sha.slice(0, 7)}{commit.parents.length > 1 ? ' · merge commit' : ''}</code>
          </span>
        </button></div>)}
        {!history.loading && !history.error && !history.commits.length && <div className="list-empty"><GitCommitHorizontal size={24} /><span>{search ? 'No matching commits.' : 'No commits yet.'}</span></div>}
        {history.error && <ErrorBox error={history.error} retry={history.retry} />}
        {history.loading && <div className="list-loading"><Spinner label="Reading history…" /></div>}
        {history.hasMore && <button className="load-more" disabled={history.loading} onClick={() => void history.loadMore()}>Load 50 more commits</button>}
      </div>
      <footer className="sidebar-footnote"><GitBranchIcon />History of {status.detached ? 'detached HEAD' : status.branch}</footer>
    </aside>
    <main className="detail-pane" id="history-panel" role="tabpanel" aria-label="History">
      <ConflictBanner {...props} />
      {selected ? <>
        <header className="commit-detail-header"><div className="commit-heading-line"><span className="commit-detail-icon"><GitCommitHorizontal size={23} /></span>
          <div><h1>{selected.summary || '(no commit message)'}</h1><div className="commit-meta"><strong>{selected.author}</strong>
            <span title={selected.email}>{selected.email}</span><span>committed {formatDate(selected.date)}</span></div></div>
          <Menu label="Commit actions" align="right" trigger={<MoreHorizontal size={18} />}>
            <MenuItem icon={<Undo2 size={15} />} disabled={busy || !!status.operation || selected.parents.length > 1} onClick={() => void commitAction('revert')}>Revert commit…</MenuItem>
            <MenuItem icon={<GitPullRequestArrow size={15} />} disabled={busy || !!status.operation || selected.parents.length > 1} onClick={() => void commitAction('cherryPick')}>Cherry-pick commit…</MenuItem>
            <MenuItem disabled={busy || !!status.operation || status.files.length > 0} onClick={() => void commitAction('checkout')}>Check out commit (detached)…</MenuItem>
            {status.files.length > 0 && <p className="menu-note">Commit or stash local changes before checking out a commit.</p>}
            {selected.parents.length > 1 && <p className="menu-note">Merge commits need a mainline parent. Revert and cherry-pick are unavailable here.</p>}
          </Menu>
        </div>
          {(details.data?.commit.body ?? selected.body) && <p className="commit-body">{details.data?.commit.body ?? selected.body}</p>}
          <div className="commit-detail-footer"><button className="sha-button" aria-label="Copy commit SHA" title={selected.sha} onClick={() => void (async () => {
            try { await navigator.clipboard.writeText(selected.sha); setCopied(true); }
            catch (error) { setActionError(errorInfo(error)); }
          })()}><code>{selected.sha.slice(0, 12)}</code>{copied ? <Check size={13} /> : <Copy size={13} />}{copied && <span>Copied</span>}</button>
            {selected.parents.length === 0 && <span className="label-tag">Initial commit</span>}
            {selected.parents.length > 1 && <span className="label-tag">Merge · {selected.parents.length} parents</span>}
            <span className="spacer" /><button className="text-button" disabled={!status.remotes.length} onClick={() => void safely(() => perform('openRemote', { repoId: repo.id, sha: selected.sha }))}>View on remote<ExternalLink size={13} /></button>
          </div>
        </header>
        {actionError && <ErrorBox error={actionError} />}
        {details.error ? <div className="detail-error"><ErrorBox error={details.error} retry={() => setDetailRevision(value => value + 1)} /></div>
          : !details.data ? <div className="pane-loading"><Spinner label="Reading commit…" /></div>
            : <div className="history-detail-grid">
              <aside className="commit-files" aria-label="Files changed in commit"><div className="commit-files-heading">{details.data.files.length} changed {details.data.files.length === 1 ? 'file' : 'files'}</div>
                {details.data.files.map(file => <button key={file.path} className={`commit-file${selectedFile?.path === file.path ? ' selected' : ''}`}
                  aria-pressed={selectedFile?.path === file.path} onClick={() => setFilePath(file.path)}>
                  <FileStatus file={file} /><FileName path={file.path} oldPath={file.oldPath} /></button>)}
                {!details.data.files.length && <p className="list-empty">No file changes.</p>}
              </aside>
              <div className="commit-diff-pane">{selectedFile ? <>
                <div className="commit-diff-path"><File size={14} /><span>{selectedFile.path}</span><span className="label-tag">Committed</span></div>
                {diff.error ? <div className="detail-error"><ErrorBox error={diff.error} retry={() => setDetailRevision(value => value + 1)} /></div>
                  : diff.data ? <DiffView key={`${selected.sha}:${selectedFile.path}`} diff={diff.data} /> : <div className="pane-loading"><Spinner label="Reading commit diff…" /></div>}
              </> : <EmptyState compact icon={<FileCode2 size={26} />} title="No file changes"><p>This commit does not change any files relative to its first parent.</p></EmptyState>}</div>
            </div>}
      </> : history.loading ? <div className="pane-loading"><Spinner label="Reading commit history…" /></div>
        : history.error ? <div className="detail-error"><ErrorBox error={history.error} retry={history.retry} /></div>
        : <EmptyState icon={<History size={32} />} title={search ? 'No matching commits' : 'A fresh start'}>
        <p>{search ? 'Try a commit SHA, message, author name, or email.' : 'Your history will appear here after the first commit. Every meaningful change has a place.'}</p>
        {!search && <button className="button" onClick={() => setTab('changes')}>Go to Changes</button>}
      </EmptyState>}
    </main>
  </>;
}

function GitBranchIcon(): ReactNode { return <GitCommitHorizontal size={13} />; }
