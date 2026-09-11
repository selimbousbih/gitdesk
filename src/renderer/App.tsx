import { useEffect, useState, type CSSProperties } from 'react';
import {
  Activity, AlertCircle, ArrowDown, ArrowDownToLine, ArrowUp, BookOpen, Check,
  ChevronDown, CircleDot, Code2, Command, ExternalLink, FolderGit2, FolderOpen, GitBranch,
  GitFork, GitMerge, Globe, HardDrive, Keyboard, LoaderCircle, Maximize2, Minus,
  Package, Plus, RefreshCw, Search, Settings, Terminal, Trash2, X,
} from 'lucide-react';
import type { Branch, Repository } from '../shared/api';
import { request, safely, useController, useResource } from './core';
import {
  BranchDialog, BranchRows, NetworkDialog, RepositoryDialog, SettingsDialog, ShortcutsDialog, StashDialog,
  type BranchMode, type NetworkMode,
} from './dialogs';
import { Brand, Dialog, EmptyState, ErrorBox, IconButton, Menu, MenuItem, Spinner, formatDate, useConfirmation } from './ui';
import { ChangesWorkspace, HistoryWorkspace, type WorkspaceTab } from './workspace';
import { GitHubDialog, type GitHubTab } from './github';

type Modal = { type: 'repository'; mode: 'add' | 'create' | 'clone' } | { type: 'settings' | 'shortcuts' | 'about' | 'stashes' }
  | { type: 'branch'; mode: BranchMode } | { type: 'network'; mode: NetworkMode } | { type: 'github'; tab?: GitHubTab } | null;

export default function App() {
  const controller = useController();
  const { app, appError, revision, busy, logs, toast, setToast, perform, refresh } = controller;
  const repo = app?.repositories.find(value => value.id === app.selectedRepoId) ?? null;
  const status = useResource(repo?.id ?? null, () => request('status', { repoId: repo!.id }), [revision]);
  const [tab, setTab] = useState<WorkspaceTab>('changes');
  const [modal, setModal] = useState<Modal>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [repoFilter, setRepoFilter] = useState('');
  const [branchFilter, setBranchFilter] = useState('');
  const [branchOpen, setBranchOpen] = useState(false);
  const branches = useResource(repo && branchOpen ? repo.id : null, () => request('branches', { repoId: repo!.id }), [revision]);
  const { confirm, confirmation } = useConfirmation();
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { return Math.max(260, Math.min(460, Number(localStorage.getItem('gitdesk.sidebarWidth')) || 310)); }
    catch { return 310; }
  });
  const [resizing, setResizing] = useState(false);
  const blocked = !!busy;
  const statusBlocked = blocked || !status.data;
  const current = status.data;
  const mod = window.gitdesk?.platform === 'darwin' ? '⌘' : 'Ctrl';
  const chooseRepo = (repository: Repository) => safely(() => perform('selectRepository', { repoId: repository.id }));
  const removeRepo = async (repository: Repository) => {
    if (!await confirm({ title: 'Remove repository from GitDesk?', message: `Remove “${repository.name}” from your repository list?`,
      detail: `Your files and Git history will stay untouched on disk.\n${repository.path}`, confirmLabel: 'Remove from list' })) return;
    await safely(() => perform('removeRepository', { repoId: repository.id }));
  };
  const switchBranch = (branch: Branch) => {
    if (!repo || !current) return;
    void safely(async () => {
      if (current.files.length) {
        await confirm({ title: 'Commit or stash changes first', message: `Switching to “${branch.name}” requires a clean working tree.`,
          detail: 'Commit or stash all local changes, then switch branches. GitDesk does not carry uncommitted changes across a branch switch.', confirmLabel: 'Got it' });
        return;
      }
      await perform('branch', { repoId: repo.id, action: 'switch', name: branch.name });
    });
  };
  const open = (target: 'folder' | 'editor' | 'terminal') => repo && safely(() => perform('openPath', { repoId: repo.id, target }));
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'r') { event.preventDefault(); if (!busy) refresh(); return; }
      if (document.querySelector('[role="dialog"]')) return;
      if (key === 'o') { event.preventDefault(); if (!busy) setModal({ type: 'repository', mode: 'add' }); }
      else if (key === 'enter') {
        event.preventDefault();
        if (!busy) {
          const form = document.getElementById('commit-form');
          if (form instanceof HTMLFormElement) form.requestSubmit();
        }
      } else if (key === ',') { event.preventDefault(); setModal({ type: 'settings' }); }
      else if (key === '/') { event.preventDefault(); setModal({ type: 'shortcuts' }); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [busy, refresh]);
  useEffect(() => { setBranchFilter(''); setBranchOpen(false); }, [repo?.id]);

  const branchMenuItems = <>
    <MenuItem icon={<Plus size={15} />} disabled={statusBlocked || !!current?.operation || !!current?.unborn} onClick={() => setModal({ type: 'branch', mode: 'create' })}>New branch…</MenuItem>
    <MenuItem disabled={statusBlocked || !!current?.operation} onClick={() => setModal({ type: 'branch', mode: 'rename' })}>Rename branch…</MenuItem>
    <MenuItem disabled={statusBlocked || !!current?.operation} onClick={() => setModal({ type: 'branch', mode: 'delete' })}>Delete local branch…</MenuItem>
    <hr />
    <MenuItem icon={<GitMerge size={15} />} disabled={statusBlocked || !!current?.operation || !!current?.unborn || !!current?.detached} onClick={() => setModal({ type: 'branch', mode: 'merge' })}>Merge into current branch…</MenuItem>
    <MenuItem icon={<GitFork size={15} />} disabled={statusBlocked || !!current?.operation || !!current?.unborn || !!current?.detached} onClick={() => setModal({ type: 'branch', mode: 'rebase' })}>Rebase current branch…</MenuItem>
    <hr />
    <MenuItem icon={<Package size={15} />} disabled={statusBlocked} onClick={() => setModal({ type: 'stashes' })}>Stashed changes…</MenuItem>
  </>;
  const failures = logs.filter(log => log.phase === 'failed').length;
  const latestLog = [...logs].reverse().find(log => log.phase === 'started' || log.phase === 'progress');
  return <div className={`app-shell${resizing ? ' resizing' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
    <header className="titlebar">
      <div className="app-brand"><Brand /><span>GitDesk</span></div>
      <nav className="native-menus" aria-label="Application menu">
        <Menu label="File">
          <MenuItem icon={<FolderOpen size={15} />} shortcut={`${mod}+O`} disabled={blocked} onClick={() => setModal({ type: 'repository', mode: 'add' })}>Add repository…</MenuItem>
          <MenuItem icon={<Plus size={15} />} disabled={blocked} onClick={() => setModal({ type: 'repository', mode: 'create' })}>New repository…</MenuItem>
          <MenuItem icon={<ArrowDownToLine size={15} />} disabled={blocked} onClick={() => setModal({ type: 'repository', mode: 'clone' })}>Clone repository…</MenuItem>
          <MenuItem icon={<Globe size={15} />} disabled={blocked} onClick={() => setModal({ type: 'github' })}>GitHub repositories…</MenuItem>
          <hr /><MenuItem icon={<Settings size={15} />} shortcut={`${mod}+,`} onClick={() => setModal({ type: 'settings' })}>Settings…</MenuItem>
          <hr /><MenuItem onClick={() => void safely(() => perform('windowControl', { action: 'close' }))}>Close window</MenuItem>
        </Menu>
        <Menu label="Repository">
          <MenuItem icon={<RefreshCw size={15} />} shortcut={`${mod}+R`} disabled={!repo || blocked} onClick={refresh}>Refresh local status</MenuItem>
          <MenuItem icon={<ArrowDownToLine size={15} />} disabled={statusBlocked} onClick={() => setModal({ type: 'network', mode: 'fetch' })}>Fetch…</MenuItem>
          <MenuItem icon={<ArrowDown size={15} />} disabled={statusBlocked || !!current?.operation} onClick={() => setModal({ type: 'network', mode: 'pull' })}>Pull with merge…</MenuItem>
          <MenuItem disabled={statusBlocked || !!current?.operation} onClick={() => setModal({ type: 'network', mode: 'pullRebase' })}>Pull with rebase…</MenuItem>
          <MenuItem icon={<ArrowUp size={15} />} disabled={statusBlocked || !!current?.operation} onClick={() => setModal({ type: 'network', mode: 'push' })}>{current?.upstream ? 'Push…' : 'Publish branch…'}</MenuItem>
          <MenuItem icon={<Globe size={15} />} disabled={statusBlocked || !!current?.operation || !!current?.unborn || !!current?.detached}
            onClick={() => setModal({ type: 'github', tab: 'publish' })}>Publish repository to GitHub…</MenuItem>
          <MenuItem danger disabled={statusBlocked || !!current?.operation || !current?.upstream} onClick={() => setModal({ type: 'network', mode: 'forcePush' })}>Force push with lease…</MenuItem>
          <hr />
          <MenuItem icon={<FolderOpen size={15} />} disabled={!repo} onClick={() => void open('folder')}>Show in file manager</MenuItem>
          <MenuItem icon={<Code2 size={15} />} title="Open in VS Code or VSCodium" disabled={!repo} onClick={() => void open('editor')}>Open in editor</MenuItem>
          <MenuItem icon={<Terminal size={15} />} disabled={!repo} onClick={() => void open('terminal')}>Open in terminal</MenuItem>
          <MenuItem icon={<ExternalLink size={15} />} disabled={!repo || !current?.remotes.length} onClick={() => repo && void safely(() => perform('openRemote', { repoId: repo.id }))}>View on remote</MenuItem>
          <hr /><MenuItem icon={<Settings size={15} />} onClick={() => setModal({ type: 'settings' })}>Repository settings…</MenuItem>
          <MenuItem icon={<Trash2 size={15} />} disabled={!repo || blocked} onClick={() => repo && void removeRepo(repo)}>Remove from GitDesk…</MenuItem>
        </Menu>
        <Menu label="Branch">{branchMenuItems}</Menu>
        <Menu label="Help">
          <MenuItem icon={<Keyboard size={15} />} shortcut={`${mod}+/`} onClick={() => setModal({ type: 'shortcuts' })}>Keyboard shortcuts</MenuItem>
          <MenuItem icon={<Activity size={15} />} onClick={() => setActivityOpen(true)}>Command activity</MenuItem>
          <hr /><MenuItem icon={<BookOpen size={15} />} onClick={() => setModal({ type: 'about' })}>About GitDesk</MenuItem>
        </Menu>
      </nav>
      <div className="titlebar-center">{repo ? repo.name : 'A little closer to your code'}</div>
      <div className="window-controls">
        <IconButton label="Minimize window" onClick={() => void safely(() => perform('windowControl', { action: 'minimize' }))}><Minus size={15} /></IconButton>
        <IconButton label="Maximize or restore window" onClick={() => void safely(() => perform('windowControl', { action: 'maximize' }))}><Maximize2 size={12} /></IconButton>
        <IconButton label="Close window" className="window-close" onClick={() => void safely(() => perform('windowControl', { action: 'close' }))}><X size={16} /></IconButton>
      </div>
    </header>
    <div className="repository-toolbar">
      <Menu className="repository-picker" label="Current repository" trigger={<><FolderGit2 size={21} /><span className="toolbar-label"><small>Current repository</small><strong>{repo?.name ?? 'Choose a repository'}</strong></span><ChevronDown size={15} /></>}>
        <div className="popover-heading">Your repositories<span>{app?.repositories.length ?? 0}</span></div>
        <div className="popover-search"><Search size={14} /><input data-autofocus value={repoFilter} placeholder="Find a repository…" aria-label="Filter repositories" onChange={event => setRepoFilter(event.target.value)} /></div>
        <div className="repository-list">
          {app?.repositories.filter(value => `${value.name} ${value.path}`.toLocaleLowerCase().includes(repoFilter.toLocaleLowerCase())).map(repository =>
            <MenuItem key={repository.id} disabled={blocked} icon={<FolderGit2 size={17} />} checked={repo?.id === repository.id} onClick={() => void chooseRepo(repository)}>
              <span className="repo-option"><strong>{repository.name}</strong><small title={repository.path}>{repository.path}</small></span>
            </MenuItem>)}
          {!app?.repositories.length && <p className="menu-note">Add your first repository to get started.</p>}
          {!!app?.repositories.length && !app.repositories.some(value => `${value.name} ${value.path}`.toLocaleLowerCase().includes(repoFilter.toLocaleLowerCase())) && <p className="menu-note">No repositories match.</p>}
        </div><hr />
        <MenuItem icon={<Plus size={15} />} disabled={blocked} onClick={() => setModal({ type: 'repository', mode: 'add' })}>Add existing repository…</MenuItem>
        <MenuItem icon={<FolderGit2 size={15} />} disabled={blocked} onClick={() => setModal({ type: 'repository', mode: 'create' })}>Create new repository…</MenuItem>
        <MenuItem icon={<ArrowDownToLine size={15} />} disabled={blocked} onClick={() => setModal({ type: 'repository', mode: 'clone' })}>Clone repository…</MenuItem>
        <MenuItem icon={<Globe size={15} />} disabled={blocked} onClick={() => setModal({ type: 'github' })}>Clone from GitHub…</MenuItem>
      </Menu>
      <Menu className="branch-picker" label="Current branch" onOpenChange={setBranchOpen} trigger={<>
        <GitBranch size={20} /><span className="toolbar-label"><small>{current?.detached ? 'Detached HEAD' : 'Current branch'}</small>
          <strong>{repo ? status.error ? 'Status unavailable' : current ? current.detached ? current.head?.slice(0, 7) : `${current.branch}${current.unborn ? ' · no commits' : ''}` : 'Reading repository…' : 'No repository selected'}</strong></span><ChevronDown size={15} />
      </>}>
        <div className="popover-heading">Switch branch</div>
        <div className="popover-search"><Search size={14} /><input data-autofocus placeholder="Filter branches…" aria-label="Filter branches" value={branchFilter} onChange={event => setBranchFilter(event.target.value)} /></div>
        {!repo && <p className="menu-note">Choose a repository first.</p>}
        {branches.loading && repo && <div className="menu-note"><Spinner label="Reading branches…" /></div>}
        {branches.error && <ErrorBox error={branches.error} retry={refresh} />}
        <div className="branch-list">
          {(['Local branches', 'Remote branches'] as const).map((title, index) => {
            const items = (branches.data ?? []).filter(branch => branch.remote === !!index && branch.name.toLocaleLowerCase().includes(branchFilter.toLocaleLowerCase()));
            return items.length ? <div key={title}><p className="menu-section-label">{title}</p><BranchRows branches={items} busy={statusBlocked || !!current?.operation} switchBranch={switchBranch} /></div> : null;
          })}
          {branches.data?.length === 0 && <p className="menu-note">{current?.unborn ? 'Create the first commit to start branching.' : 'No branches found.'}</p>}
          {!!branches.data?.length && !branches.data.some(branch => branch.name.toLocaleLowerCase().includes(branchFilter.toLocaleLowerCase())) && <p className="menu-note">No matching branches.</p>}
        </div><hr />{branchMenuItems}
      </Menu>
      <div className="sync-controls">
        <button className="fetch-button" disabled={statusBlocked || !current?.remotes.length} onClick={() => {
          if (!repo || !current) return;
          if (current.remotes.length > 1) setModal({ type: 'network', mode: 'fetch' });
          else void safely(() => perform('network', { repoId: repo.id, action: 'fetch', remote: current.remotes[0].name }));
        }}>
          {busy === 'network' ? <LoaderCircle size={19} className="spin" /> : <RefreshCw size={19} />}
          <span className="toolbar-label"><strong>Fetch {current?.remotes.length === 1 ? current.remotes[0].name : 'remote'}</strong><small>{current?.remotes.length ? 'Check for remote changes' : 'No remote configured'}</small></span>
        </button>
        {current && !current.unborn && !current.detached && <button className="push-button" disabled={blocked || !!current.operation}
          onClick={() => setModal(current.remotes.length ? { type: 'network', mode: current.behind > 0 ? 'pull' : 'push' } : { type: 'github', tab: 'publish' })}>
          {current.behind > 0 ? <ArrowDown size={16} /> : <ArrowUp size={16} />}
          {!current.remotes.length ? 'Publish repository' : current.behind > 0 ? `Pull ${current.behind}` : !current.upstream ? 'Publish branch' : current.ahead > 0 ? `Push ${current.ahead}` : 'Push'}
        </button>}
        <Menu label="Sync options" align="right" trigger={<ChevronDown size={15} />}>
          <MenuItem disabled={statusBlocked} onClick={() => setModal({ type: 'network', mode: 'fetch' })}>Fetch…</MenuItem>
          <MenuItem disabled={statusBlocked || !!current?.operation} onClick={() => setModal({ type: 'network', mode: 'pull' })}>Pull with merge…</MenuItem>
          <MenuItem disabled={statusBlocked || !!current?.operation} onClick={() => setModal({ type: 'network', mode: 'pullRebase' })}>Pull with rebase…</MenuItem>
          <MenuItem disabled={statusBlocked || !!current?.operation} onClick={() => setModal({ type: 'network', mode: 'push' })}>Push / publish…</MenuItem>
          <MenuItem disabled={statusBlocked || !!current?.operation || !!current?.unborn || !!current?.detached}
            onClick={() => setModal({ type: 'github', tab: 'publish' })}>Publish repository to GitHub…</MenuItem>
          <hr /><MenuItem danger disabled={statusBlocked || !!current?.operation || !current?.upstream} onClick={() => setModal({ type: 'network', mode: 'forcePush' })}>Force push with lease…</MenuItem>
        </Menu>
      </div>
      <IconButton label="Settings" className="toolbar-settings" onClick={() => setModal({ type: 'settings' })}><Settings size={18} /></IconButton>
    </div>
    {appError ? <div className="startup-error"><EmptyState icon={<AlertCircle size={32} />} title="GitDesk couldn’t load your workspace">
      <ErrorBox error={appError} retry={refresh} /></EmptyState></div>
      : !app ? <div className="startup-loading"><Brand large /><Spinner label="Opening your workspace…" /></div>
        : !repo ? <div className="welcome">
          <div className="welcome-content">
            <div className="welcome-illustration" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" />
              <span className="orbit-node node-one"><GitBranch size={22} /></span><span className="orbit-node node-two"><Code2 size={20} /></span>
              <span className="orbit-node node-three"><Check size={18} /></span><Brand large /></div>
            <span className="eyebrow">A LITTLE CLOSER TO YOUR CODE</span>
            <h1>Good work starts here.</h1>
            <p className="welcome-intro">A clear view of your code, a little room to think.<br />Bring a repository to your desk and make your next move.</p>
            {!app.gitVersion && <ErrorBox error={{ code: 'GIT_NOT_FOUND', message: 'Git is not available on this machine.', detail: 'Install Git, make sure it is on your system PATH, then restart GitDesk. Repository actions require Git.' }} retry={refresh} />}
            <div className="welcome-actions">
              <button className="welcome-action" disabled={blocked || !app.gitVersion} onClick={() => setModal({ type: 'repository', mode: 'add' })}>
                <span className="welcome-action-icon"><FolderOpen size={21} /></span><span><strong>Add a repository</strong><small>Pick up where you left off</small></span><kbd>{mod} O</kbd>
              </button>
              <button className="welcome-action" disabled={blocked || !app.gitVersion} onClick={() => setModal({ type: 'repository', mode: 'clone' })}>
                <span className="welcome-action-icon"><ArrowDownToLine size={21} /></span><span><strong>Clone a repository</strong><small>Bring something great home</small></span><Plus size={15} />
              </button>
              <button className="welcome-action" disabled={blocked || !app.gitVersion} onClick={() => setModal({ type: 'repository', mode: 'create' })}>
                <span className="welcome-action-icon"><FolderGit2 size={21} /></span><span><strong>Create a repository</strong><small>Give a new idea its first commit</small></span><Plus size={15} />
              </button>
            </div>
            <button className="button welcome-github" disabled={blocked} onClick={() => setModal({ type: 'github' })}>
              <Globe size={16} />Connect to GitHub<span>Browse, clone, or create private</span>
            </button>
            {!!app.repositories.length && <div className="recent-repositories"><span>RECENT REPOSITORIES</span>{app.repositories.slice(0, 3).map(repository =>
              <button key={repository.id} disabled={blocked} onClick={() => void chooseRepo(repository)}><FolderGit2 size={14} />{repository.name}<small>{repository.path}</small></button>)}</div>}
            <p className="local-first"><HardDrive size={13} /> Local by default. Your repositories stay yours.</p>
          </div><div className="welcome-footer"><span>GITDESK</span><button className="text-button" onClick={() => setModal({ type: 'shortcuts' })}><Keyboard size={14} />Keyboard shortcuts</button></div>
        </div>
          : status.error ? <div className="repository-error"><EmptyState icon={<FolderGit2 size={33} />} title="This repository needs attention">
            <p className="repository-error-path">{repo.path}</p><ErrorBox error={status.error} retry={refresh} />
            <div className="button-row centered"><button className="button" onClick={() => void open('folder')}>Show folder</button>
              <button className="button" disabled={blocked} onClick={() => setModal({ type: 'repository', mode: 'add' })}>Locate a repository…</button>
              <button className="text-button" disabled={blocked} onClick={() => void removeRepo(repo)}>Remove from list</button></div>
          </EmptyState></div>
            : !current ? <div className="startup-loading"><Spinner label={`Reading ${repo.name}…`} /></div>
              : <div className="workspace">
                {tab === 'changes' ? <ChangesWorkspace key={repo.id} repo={repo} status={current} perform={perform} confirm={confirm} busy={blocked} revision={revision} refresh={refresh} tab={tab} setTab={setTab} />
                  : <HistoryWorkspace key={repo.id} repo={repo} status={current} perform={perform} confirm={confirm} busy={blocked} revision={revision} refresh={refresh} tab={tab} setTab={setTab} />}
                <div className="sidebar-resizer" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={460} aria-valuenow={sidebarWidth} tabIndex={0}
                  onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setResizing(true); }}
                  onPointerMove={event => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) setSidebarWidth(Math.max(260, Math.min(460, event.clientX)));
                  }} onPointerUp={event => {
                    event.currentTarget.releasePointerCapture(event.pointerId); setResizing(false);
                    try { localStorage.setItem('gitdesk.sidebarWidth', String(sidebarWidth)); } catch { /* Preferences remain usable when browser storage is unavailable. */ }
                  }} onPointerCancel={() => setResizing(false)}
                  onKeyDown={event => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                      event.preventDefault(); const width = Math.max(260, Math.min(460, sidebarWidth + (event.key === 'ArrowRight' ? 10 : -10)));
                      setSidebarWidth(width); try { localStorage.setItem('gitdesk.sidebarWidth', String(width)); } catch { /* Optional layout persistence. */ }
                    }
                  }} />
              </div>}
    <footer className="statusbar">
      <div className="statusbar-left"><span className={`connection-dot${status.error || appError || app && !app.gitVersion ? ' error' : ''}`} />
        <span>{busy ? `Working · ${busy}` : status.error ? 'Repository unavailable' : appError ? 'Connection unavailable' : app && !app.gitVersion ? 'Git is unavailable' : repo ? current?.operation ? `${current.operation.type} in progress` : 'Local repository' : 'Ready when you are'}</span>
        {repo && <span className="status-path" title={repo.path}>{repo.path}</span>}
      </div>
      <div className="statusbar-right">{current?.upstream && <span className="upstream-status" title={`Upstream: ${current.upstream}`}><ArrowDown size={11} />{current.behind}<ArrowUp size={11} />{current.ahead}<span>{current.upstream}</span></span>}
        <button title="Refresh local status (no network)" disabled={blocked} onClick={refresh}><RefreshCw size={12} className={status.loading ? 'spin' : ''} />Refresh</button>
        <button className={failures ? 'has-errors' : ''} onClick={() => setActivityOpen(true)}>{busy ? <LoaderCircle size={13} className="spin" /> : <Activity size={13} />}Activity{failures > 0 && <span className="activity-count">{failures}</span>}</button>
      </div>
    </footer>
    {toast && !activityOpen && <div className="toast" role="alert"><AlertCircle size={18} /><div><strong>{toast.message}</strong>
      <button className="text-button" onClick={() => setActivityOpen(true)}>View details in Activity</button></div>
      <IconButton label="Dismiss notification" onClick={() => setToast(null)}><X size={15} /></IconButton></div>}
    {modal?.type === 'repository' && <RepositoryDialog mode={modal.mode} defaultBranch={app?.defaultBranch ?? 'main'} perform={perform} onClose={() => setModal(null)} busy={blocked}
      progress={blocked ? latestLog?.message.slice(-1000) : undefined} onActivity={() => setActivityOpen(true)} onGitHub={() => setModal({ type: 'github' })} />}
    {modal?.type === 'settings' && app && <SettingsDialog key={repo?.id ?? 'app'} app={app} repo={repo} perform={perform} confirm={confirm} busy={blocked}
      onClose={() => setModal(null)} onGitHub={() => setModal({ type: 'github', tab: 'account' })} />}
    {modal?.type === 'github' && <GitHubDialog initial={modal.tab} repo={repo} status={current} perform={perform} confirm={confirm} busy={blocked}
      onClose={() => setModal(null)} progress={blocked ? latestLog?.message.slice(-1000) : undefined} onActivity={() => setActivityOpen(true)} />}
    {modal?.type === 'shortcuts' && <ShortcutsDialog onClose={() => setModal(null)} />}
    {modal?.type === 'branch' && repo && current && <BranchDialog mode={modal.mode} repo={repo} status={current} perform={perform} confirm={confirm} busy={blocked} onClose={() => setModal(null)} />}
    {modal?.type === 'network' && repo && current && <NetworkDialog initial={modal.mode} repo={repo} status={current} perform={perform} confirm={confirm} busy={blocked} onClose={() => setModal(null)}
      progress={blocked ? latestLog?.message.slice(-1000) : undefined} onActivity={() => setActivityOpen(true)} />}
    {modal?.type === 'stashes' && repo && current && <StashDialog repo={repo} status={current} perform={perform} confirm={confirm} busy={blocked} onClose={() => setModal(null)} />}
    {modal?.type === 'about' && <Dialog title="A little closer to your code." onClose={() => setModal(null)}>
      <div className="dialog-body about-content"><Brand large /><h1>GitDesk</h1><p>A focused, local-first Git client. Less ceremony.<br />More clarity. Your code at the center.</p>
        <div className="about-features"><span><HardDrive size={16} />Local repositories</span><span><Globe size={16} />Any Git remote</span><span><Command size={16} />Native workflow</span></div>
        <p className="muted">{app?.gitVersion ?? 'Git not detected'}<br />No account required. Nothing fetched until you ask.</p>
      </div><footer className="dialog-footer"><button className="button primary" onClick={() => setModal(null)}>Back to your desk</button></footer>
    </Dialog>}
    {activityOpen && <div className="activity-overlay"><Dialog title="Command activity" subtitle="Real Git output, right where you need it." wide onClose={() => setActivityOpen(false)}>
      <div className="activity-header"><span>{logs.length} recent commands · {failures} errors</span>
        {busy && <button className="button small danger" onClick={() => void safely(() => perform('cancel',
          repo && !['githubCreate', 'githubClone', 'cloneRepository', 'initRepository', 'githubSignIn', 'githubImportCli', 'githubBeginLogin'].includes(busy) ? { repoId: repo.id } : {}))}>Cancel active operation</button>}</div>
      {busy && <div className="activity-current"><Spinner label={`Running ${busy}…`} />{latestLog && <code>{latestLog.message.slice(-500)}</code>}</div>}
      <div className="activity-list" role="log" aria-label="Command log" aria-live="polite">
        {!logs.length && <EmptyState compact icon={<Activity size={27} />} title="Nothing to report"><p>Commands and errors will appear here as you work.</p></EmptyState>}
        {[...logs].reverse().map((log, index) => <article className={`activity-entry ${log.phase}`} key={`${log.id}:${index}`}>
          <div>{log.phase === 'failed' ? <AlertCircle size={14} /> : log.phase === 'completed' ? <Check size={14} /> : <CircleDot size={14} />}
            <strong>{log.command}</strong><time>{formatDate(log.time)}</time><span>{log.phase}</span></div>
          {log.message && <pre>{log.message}</pre>}
        </article>)}
      </div><footer className="dialog-footer"><button className="button" onClick={() => { setActivityOpen(false); setToast(null); }}>Close activity</button></footer>
    </Dialog></div>}
    {confirmation}
  </div>;
}
