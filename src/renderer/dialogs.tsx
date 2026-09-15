import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, FolderOpen, GitBranch, Globe, Laptop, Moon, Plus, RefreshCw, Sun, Trash2 } from 'lucide-react';
import type { AppError, AppState, Branch, RepoStatus, Repository, Theme } from '../shared/api';
import { errorInfo, request, safely, useResource, type Perform } from './core';
import { Dialog, ErrorBox, IconButton, Spinner, formatDate, type Confirm } from './ui';
import { HttpsAuthPanel } from './auth';
import { httpsRepositoryUrl } from '../shared/https';

function useAction() {
  const [error, setError] = useState<AppError | null>(null);
  const [pending, setPending] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setPending(true); setError(null);
    try { await action(); return true; } catch (reason) { setError(errorInfo(reason)); return false; }
    finally { setPending(false); }
  };
  return { error, pending, run };
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function RepositoryDialog({ mode, defaultBranch, perform, onClose, busy, progress, onActivity, onGitHub }: {
  mode: 'add' | 'create' | 'clone'; defaultBranch: string; perform: Perform; onClose: () => void; busy: boolean;
  progress?: string; onActivity: () => void; onGitHub: () => void;
}) {
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState(defaultBranch);
  const action = useAction();
  const titles = { add: 'Add an existing repository', create: 'Create a repository', clone: 'Clone a repository' };
  const browse = () => action.run(async () => {
    const chosen = await perform('chooseDirectory', { title: mode === 'add' ? 'Choose a Git repository' : 'Choose a parent folder' });
    if (chosen) setPath(chosen);
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      if (mode === 'add') await perform('addRepository', { path });
      else if (mode === 'create') await perform('initRepository', { parentPath: path, name: name.trim(), defaultBranch: branch.trim() });
      else await perform('cloneRepository', { url: url.trim(), parentPath: path, name: name.trim() });
      onClose();
    });
  };
  return <Dialog title={titles[mode]} subtitle={mode === 'clone' ? 'Bring a remote repository to your own machine.' : 'A home for your code, right here on your machine.'}
    onClose={onClose} closingDisabled={action.pending}>
    <form onSubmit={submit}>
      <div className="dialog-body form-stack">
        {mode === 'clone' && <div className="github-clone-entry"><Globe size={18} /><div><strong>Looking for a GitHub repository?</strong><p className="muted">Sign in and choose from your accessible repositories.</p></div>
          <button type="button" className="button small" disabled={busy || action.pending} onClick={onGitHub}>Clone from GitHub…</button></div>}
        {mode === 'clone' && <Field label="Repository URL" hint="Company GitLab and other Git hosts: use HTTPS or SSH. Configure HTTPS credentials below, or use your existing Git helpers.">
          <input data-autofocus required value={url} placeholder="https://gitlab.company.com/team/project.git" disabled={action.pending}
            onChange={event => setUrl(event.target.value)} onBlur={() => {
              if (!name) setName(url.trim().split(/[/:]/).filter(Boolean).at(-1)?.replace(/\.git$/, '') ?? '');
            }} />
        </Field>}
        {mode === 'clone' && <HttpsAuthPanel url={url.trim()} perform={perform} busy={busy} />}
        {mode !== 'add' && <Field label="Repository name"><input data-autofocus={mode === 'create' || undefined} required maxLength={200}
          value={name} onChange={event => setName(event.target.value)} placeholder="my-project" disabled={action.pending} /></Field>}
        <div className="field"><label htmlFor="repository-directory">{mode === 'add' ? 'Repository folder' : 'Parent folder'}</label>
          <div className="input-with-button"><input id="repository-directory" data-autofocus={mode === 'add' || undefined} required
            value={path} onChange={event => setPath(event.target.value)} placeholder="Choose a local folder…" disabled={action.pending} />
            <button type="button" className="button" onClick={() => void browse()} disabled={action.pending}><FolderOpen size={15} /> Choose…</button>
          </div>
          <small>{mode === 'add' ? 'The folder must already contain a Git repository.' : 'A new subfolder is created here. Existing files will not be overwritten.'}</small>
        </div>
        {mode === 'create' && <Field label="Initial branch"><input required value={branch} onChange={event => setBranch(event.target.value)} disabled={action.pending} /></Field>}
        {mode !== 'add' && path && name && <div className="path-preview"><FolderOpen size={14} /><span>{path.replace(/[/\\]$/, '')}/{name}</span></div>}
        {action.error && <ErrorBox error={action.error} />}
        {action.pending && <div className="inline-progress"><Spinner label={mode === 'clone' ? 'Cloning repository…' : 'Opening repository…'} />
          {progress && <pre>{progress}</pre>}<p>Large repositories can take a little while.</p>
          <button type="button" className="text-button" onClick={onActivity}>View command activity</button></div>}
      </div>
      <footer className="dialog-footer">
        {action.pending ? <button type="button" className="button" onClick={() => void safely(() => perform('cancel', {}))}>Cancel operation</button>
          : <button type="button" className="button" onClick={onClose}>Cancel</button>}
        <button type="submit" className="button primary" disabled={action.pending || busy || !path || (mode !== 'add' && !name.trim()) || (mode === 'clone' && !url.trim())}>
          {mode === 'add' ? 'Add repository' : mode === 'create' ? 'Create repository' : 'Clone repository'}
        </button>
      </footer>
    </form>
  </Dialog>;
}

export function SettingsDialog({ app, repo, perform, confirm, busy, onClose, onGitHub }: {
  app: AppState; repo: Repository | null; perform: Perform; confirm: Confirm; busy: boolean; onClose: () => void; onGitHub: () => void;
}) {
  const [tab, setTab] = useState<'general' | 'identity' | 'remotes' | 'authentication' | 'github'>('general');
  const github = useResource(tab === 'github' ? 'github-settings' : null, () => request('githubAccount', {}));
  const [revision, setRevision] = useState(0);
  const settings = useResource(repo?.id ?? null, () => request('getRepoSettings', { repoId: repo!.id }), [revision]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [defaultBranch, setDefaultBranch] = useState(app.defaultBranch);
  const [remoteName, setRemoteName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const action = useAction();
  useEffect(() => {
    if (settings.data) { setName(settings.data.name); setEmail(settings.data.email); }
  }, [settings.data]);
  const save = (task: () => Promise<unknown>, message: string) => {
    setSaved('');
    void action.run(async () => { await task(); setSaved(message); });
  };
  const themes: { id: Theme; label: string; icon: ReactNode }[] = [
    { id: 'light', label: 'Light', icon: <Sun size={19} /> },
    { id: 'dark', label: 'Dark', icon: <Moon size={19} /> },
    { id: 'system', label: 'System', icon: <Laptop size={19} /> },
  ];
  return <Dialog title="Settings" subtitle={repo ? `Application preferences and settings for ${repo.name}` : 'Make GitDesk feel at home.'}
    wide onClose={onClose} closingDisabled={action.pending}>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings sections">{(['general', 'identity', 'remotes', 'authentication', 'github'] as const).map(value =>
        <button key={value} className={tab === value ? 'active' : ''} aria-current={tab === value ? 'page' : undefined}
          onClick={() => { setTab(value); setSaved(''); }}>{value === 'general' ? 'Appearance & defaults' : value === 'identity' ? 'Git identity' : value === 'authentication' ? 'HTTPS authentication' : value === 'github' ? 'GitHub account' : 'Remotes'}</button>)}</nav>
      <div className="settings-content">
        {tab === 'general' && <div className="form-stack">
          <div><h3>Appearance</h3><p className="muted">Your workspace, in the right light.</p></div>
          <div className="theme-options" role="group" aria-label="Color theme">{themes.map(theme =>
            <button key={theme.id} className={`theme-option ${theme.id}${app.theme === theme.id ? ' selected' : ''}`} aria-pressed={app.theme === theme.id}
              disabled={busy} onClick={() => save(() => perform('setPreferences', { theme: theme.id }), 'Theme updated')}>
              <span className="theme-preview"><i /><i /><i /></span><span>{theme.icon}{theme.label}{app.theme === theme.id && <Check size={13} />}</span>
            </button>)}</div>
          <hr />
          <form className="form-stack" onSubmit={event => { event.preventDefault(); save(() => perform('setPreferences', { defaultBranch: defaultBranch.trim() }), 'Default branch saved'); }}>
            <Field label="Default branch for new repositories" hint="This only affects repositories created in GitDesk. Existing branches are not renamed.">
              <input required value={defaultBranch} onChange={event => setDefaultBranch(event.target.value)} maxLength={1024} />
            </Field>
            <button className="button align-start" disabled={busy || !defaultBranch.trim()}>Save default branch</button>
          </form>
          <p className="settings-version"><strong>GitDesk</strong> · A little closer to your code<br />{app.gitVersion ?? 'Git is not available. Install Git and restart GitDesk.'}</p>
        </div>}
        {tab === 'authentication' && <div className="form-stack">
          <h3>HTTPS authentication</h3>
          <Field label="HTTPS repository URL" hint="Use your full company GitLab repository URL, including any group/subgroup path.">
            <input type="url" aria-label="HTTPS repository URL" value={authUrl ?? settings.data?.remotes.find(remote => httpsRepositoryUrl(remote.url))?.url ?? ''}
              placeholder="https://gitlab.company.com/team/project.git" disabled={busy} list="https-remotes"
              onChange={event => setAuthUrl(event.target.value)} />
            <datalist id="https-remotes">{settings.data?.remotes.filter(remote => httpsRepositoryUrl(remote.url)).map(remote => <option key={remote.name} value={remote.url}>{remote.name}</option>)}</datalist>
          </Field>
          <HttpsAuthPanel url={(authUrl ?? settings.data?.remotes.find(remote => httpsRepositoryUrl(remote.url))?.url ?? '').trim()} perform={perform} busy={busy} expanded />
        </div>}
        {tab === 'github' && <div className="form-stack"><h3>GitHub account</h3>
          <p className="muted">Connect to browse and clone your repositories, create an empty private repository, or publish a local branch privately.</p>
          {github.loading && <Spinner label="Reading GitHub account…" />}
          {github.error && <ErrorBox error={github.error} />}
          {github.data && <p className="inset-message">{github.data.user ? <>Signed in as <strong>{github.data.user.login}</strong>. {github.data.remembered ? 'Saved with OS-encrypted storage.' : 'Session-only sign-in.'}</> : 'Not signed in. A personal access token or existing GitHub CLI login works immediately.'}</p>}
          <button type="button" className="button primary align-start" disabled={busy || action.pending} onClick={onGitHub}><Globe size={15} />{github.data?.user ? 'Manage GitHub account…' : 'Connect to GitHub…'}</button>
          <p className="muted">GitHub sign-in is optional. Company GitLab and other HTTPS authentication stay separate and unchanged. Repository lists are fetched only when requested.</p>
        </div>}
        {(tab === 'identity' || tab === 'remotes') && !repo && <p className="muted">Open a repository to manage its {tab === 'identity' ? 'Git identity' : 'remotes'}.</p>}
        {tab !== 'general' && tab !== 'github' && repo && settings.loading && !settings.data && <Spinner />}
        {tab !== 'general' && tab !== 'github' && settings.error && <ErrorBox error={settings.error} retry={() => setRevision(value => value + 1)} />}
        {tab === 'identity' && repo && settings.data && <form className="form-stack" onSubmit={event => {
          event.preventDefault(); save(() => perform('setIdentity', { repoId: repo.id, name: name.trim(), email: email.trim() }), 'Repository identity saved');
        }}>
          <div><h3>Commit identity</h3><p className="muted">The effective identity for this repository. Saving writes repository-local Git configuration, not your global identity.</p></div>
          <Field label="Name"><input required value={name} maxLength={500} onChange={event => setName(event.target.value)} /></Field>
          <Field label="Email"><input required type="email" value={email} maxLength={500} onChange={event => setEmail(event.target.value)} /></Field>
          <button className="button primary align-start" disabled={busy || !name.trim() || !email.trim()}>Save repository identity</button>
        </form>}
        {tab === 'remotes' && repo && settings.data && <div className="form-stack">
          <div><h3>Remote repositories</h3><p className="muted">Remote URLs are stored locally. Editing a remote does not fetch, push, or change the remote repository.</p></div>
          {settings.data.remotes.length === 0 && <p className="inset-message">No remotes yet. Add one to fetch or publish your work.</p>}
          <div className="remote-list">{settings.data.remotes.map(remote => <div className="remote-item" key={remote.name}>
            <Globe size={17} /><div><strong>{remote.name}</strong><code>{remote.url}</code>
              {remote.pushUrl !== remote.url && <small>Push: {remote.pushUrl}</small>}</div>
            <button className="button small" disabled={busy} onClick={() => { setEditing(remote.name); setRemoteName(remote.name); setRemoteUrl(remote.url); }}>Edit</button>
            <IconButton label={`Remove remote ${remote.name}`} disabled={busy} onClick={() => void action.run(async () => {
              if (!await confirm({ title: 'Remove remote?', message: `Remove “${remote.name}” from this repository?`, detail: 'The remote repository and its files will not be deleted. Local remote-tracking references may be removed.', confirmLabel: 'Remove remote', danger: true })) return;
              await perform('remote', { repoId: repo.id, action: 'remove', name: remote.name, confirmed: true }); setRevision(value => value + 1);
            })}><Trash2 size={15} /></IconButton>
          </div>)}</div>
          <hr />
          <form className="form-stack" onSubmit={event => {
            event.preventDefault();
            void action.run(async () => {
              if (editing && !await confirm({
                title: 'Change remote URL?', message: `Change the URL for “${editing}” to ${remoteUrl.trim()}?`,
                detail: 'Future fetches and pushes will use this remote configuration. No network request is made by this change.',
                confirmLabel: 'Save remote URL',
              })) return;
              await perform('remote', { repoId: repo.id, action: editing ? 'edit' : 'add', name: remoteName.trim(), url: remoteUrl.trim(),
                ...(editing ? { confirmed: true } : {}) });
              setEditing(null); setRemoteName(''); setRemoteUrl(''); setRevision(value => value + 1); setSaved('Remote saved');
            });
          }}>
            <h3>{editing ? `Edit ${editing}` : 'Add a remote'}</h3>
            <Field label="Remote name"><input required value={remoteName} disabled={!!editing || busy} placeholder="origin" pattern="[A-Za-z0-9_][A-Za-z0-9_.-]*" onChange={event => setRemoteName(event.target.value)} /></Field>
            <Field label="Remote URL"><input required value={remoteUrl} disabled={busy} placeholder="https://gitlab.company.com/team/project.git" onChange={event => setRemoteUrl(event.target.value)} /></Field>
            <div className="button-row">
              <button className="button primary" disabled={busy || !remoteName.trim() || !remoteUrl.trim()}>{editing ? 'Save remote URL' : 'Add remote'}</button>
              {editing && <button type="button" className="button" onClick={() => { setEditing(null); setRemoteName(''); setRemoteUrl(''); }}>Cancel edit</button>}
            </div>
          </form>
        </div>}
        {action.error && <ErrorBox error={action.error} />}
        {saved && <p className="saved-message" role="status"><Check size={14} />{saved}</p>}
      </div>
    </div>
    <footer className="dialog-footer"><button className="button" onClick={onClose} disabled={action.pending}>Done</button></footer>
  </Dialog>;
}

export type BranchMode = 'create' | 'rename' | 'delete' | 'merge' | 'rebase';

export function BranchDialog({ mode, repo, status, perform, confirm, busy, onClose }: {
  mode: BranchMode; repo: Repository; status: RepoStatus; perform: Perform; confirm: Confirm; busy: boolean; onClose: () => void;
}) {
  const branches = useResource(repo.id, () => request('branches', { repoId: repo.id }));
  const [name, setName] = useState('');
  const [source, setSource] = useState(status.detached ? status.head ?? '' : status.branch);
  const [target, setTarget] = useState('');
  const [dirtyAction, setDirtyAction] = useState<'carry' | 'stash'>('carry');
  const action = useAction();
  const hasChanges = status.files.length > 0;
  const hasConflicts = status.files.some(file => file.conflicted);
  const candidates = (branches.data ?? []).filter(branch => mode === 'delete' ? !branch.remote && !branch.current
    : mode === 'rename' ? !branch.remote : !branch.current);
  const titles = { create: 'Create a branch', rename: 'Rename a branch', delete: 'Delete a branch', merge: 'Merge into current branch', rebase: 'Rebase current branch' };
  const selected = target || candidates[0]?.name || '';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      if (mode === 'merge' || mode === 'rebase') {
        if (!await confirm({ title: titles[mode], message: mode === 'merge' ? `Merge “${selected}” into “${status.branch}”?` : `Replay “${status.branch}” on top of “${selected}”?`,
          detail: mode === 'rebase' ? 'Rebase rewrites commit IDs. Avoid rebasing commits shared with others. Conflicts may require your attention.' : 'Git may create a merge commit. Conflicts may require your attention.',
          confirmLabel: mode === 'merge' ? 'Merge branch' : 'Rebase branch' })) return;
        await perform('integrate', { repoId: repo.id, action: mode, branch: selected });
      } else if (mode === 'delete') {
        if (!await confirm({ title: 'Delete local branch?', message: `Permanently remove the local branch “${selected}”?`,
          detail: 'This does not delete a remote branch. GitDesk will not force-delete a branch with unmerged commits.', confirmLabel: 'Delete branch', danger: true })) return;
        await perform('branch', { repoId: repo.id, action: 'delete', name: selected, confirmed: true });
      } else if (mode === 'rename') {
        await perform('branch', { repoId: repo.id, action: 'rename', name: name.trim(), from: selected });
      } else await perform('branch', {
        repoId: repo.id, action: 'create', name: name.trim(), ...(source.trim() ? { from: source.trim() } : {}),
        ...(hasChanges ? { dirtyAction } : {}),
      });
      onClose();
    });
  };
  return <Dialog title={titles[mode]} subtitle={`Current branch: ${status.detached ? 'Detached HEAD' : status.branch}`}
    onClose={onClose} closingDisabled={action.pending}>
    <form onSubmit={submit}><div className="dialog-body form-stack">
      {branches.error && <ErrorBox error={branches.error} />}
      {mode !== 'create' && <Field label={mode === 'merge' || mode === 'rebase' ? 'Branch to integrate' : 'Local branch'}>
        <select data-autofocus value={selected} onChange={event => setTarget(event.target.value)} required disabled={busy}>
          {!candidates.length && <option value="">No eligible branches</option>}
          {candidates.map(branch => <option key={branch.name} value={branch.name}>{branch.name}{branch.remote ? ' (remote)' : ''}</option>)}
        </select>
      </Field>}
      {(mode === 'create' || mode === 'rename') && <Field label={mode === 'rename' ? 'New branch name' : 'Branch name'}>
        <input data-autofocus={mode === 'create' || undefined} required value={name} placeholder="feature/my-change" maxLength={1024} onChange={event => setName(event.target.value)} disabled={busy} />
      </Field>}
      {mode === 'create' && !status.unborn && <Field label="Create from" hint="The new branch will be checked out.">
        <input value={source} onChange={event => setSource(event.target.value)} list="branch-sources" disabled={busy} />
        <datalist id="branch-sources">{branches.data?.map(branch => <option key={branch.name} value={branch.name} />)}</datalist>
      </Field>}
      {mode === 'create' && status.unborn && <p className="inset-message">This repository has no commits. Create the first commit before creating another branch.</p>}
      {mode === 'create' && hasChanges && !hasConflicts && <Field label="Uncommitted changes" hint={dirtyAction === 'carry'
        ? 'Your staged, unstaged, and untracked changes will remain in the working tree on the new branch.'
        : 'Your staged, unstaged, and untracked changes will be saved in Stashed changes. The new branch will start clean.'}>
        <select value={dirtyAction} onChange={event => setDirtyAction(event.target.value as 'carry' | 'stash')} disabled={busy}>
          <option value="carry">Bring changes to the new branch</option>
          <option value="stash">Stash changes before creating the branch</option>
        </select>
      </Field>}
      {mode === 'create' && hasConflicts && <p className="warning-box">Resolve conflicted files before creating a branch.</p>}
      {mode === 'rebase' && <p className="warning-box">Rebase rewrites history. Use merge instead for a branch that other people already work on.</p>}
      {action.error && <ErrorBox error={action.error} />}
      {action.pending && <Spinner label="Updating branches…" />}
    </div><footer className="dialog-footer"><button type="button" className="button" onClick={onClose} disabled={action.pending}>Cancel</button>
      <button className={`button ${mode === 'delete' ? 'danger' : 'primary'}`} disabled={busy || action.pending || status.unborn || (mode === 'create' && hasConflicts) || ((mode === 'create' || mode === 'rename') && !name.trim()) || (mode !== 'create' && !selected)}>
        {mode === 'create' ? 'Create branch' : mode === 'rename' ? 'Rename branch' : mode === 'delete' ? 'Delete branch' : mode === 'merge' ? 'Merge branch…' : 'Rebase branch…'}
      </button></footer></form>
  </Dialog>;
}

export type NetworkMode = 'fetch' | 'pull' | 'pullRebase' | 'push' | 'forcePush';

export function NetworkDialog({ initial, repo, status, perform, confirm, busy, onClose, progress, onActivity }: {
  initial: NetworkMode; repo: Repository; status: RepoStatus; perform: Perform; confirm: Confirm; busy: boolean; onClose: () => void;
  progress?: string; onActivity: () => void;
}) {
  const [mode, setMode] = useState<NetworkMode>(initial);
  const [remote, setRemote] = useState(status.remotes.find(value => value.name === 'origin')?.name ?? status.remotes[0]?.name ?? '');
  const action = useAction();
  const labels: Record<NetworkMode, string> = { fetch: 'Fetch', pull: 'Pull with merge', pullRebase: 'Pull with rebase', push: status.upstream ? 'Push' : 'Publish branch', forcePush: 'Force push with lease' };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      if (mode === 'forcePush' && !await confirm({
        title: 'Force push shared history?', message: `Replace the remote history of “${status.branch}” on “${remote}”?`,
        detail: 'GitDesk uses --force-with-lease, not --force. This can still rewrite shared history and disrupt collaborators. No fetch is run before this command; your existing remote-tracking reference is the safety lease.',
        confirmLabel: 'Force push with lease', danger: true,
      })) return;
      await perform('network', { repoId: repo.id, action: mode, remote, ...(mode === 'forcePush' ? { confirmed: true } : {}) });
      onClose();
    });
  };
  return <Dialog title={initial === 'forcePush' ? 'Force push with lease' : 'Sync with remote'} subtitle={repo.name}
    onClose={onClose} closingDisabled={action.pending}>
    <form onSubmit={submit}><div className="dialog-body form-stack">
      {initial !== 'forcePush' && <Field label="Operation"><select value={mode} onChange={event => setMode(event.target.value as NetworkMode)} disabled={busy}>
        <option value="fetch">Fetch remote references</option><option value="pull">Pull with merge</option>
        <option value="pullRebase">Pull with rebase</option><option value="push">{status.upstream ? 'Push commits' : 'Publish branch'}</option>
      </select></Field>}
      <Field label="Remote"><select data-autofocus value={remote} onChange={event => setRemote(event.target.value)} disabled={busy} required>
        {!status.remotes.length && <option value="">No remotes configured</option>}
        {status.remotes.map(value => <option key={value.name} value={value.name}>{value.name} — {value.url}</option>)}
      </select></Field>
      <HttpsAuthPanel url={status.remotes.find(value => value.name === remote)?.url ?? ''} perform={perform} busy={busy} />
      <div className={mode === 'forcePush' || mode === 'pullRebase' ? 'warning-box' : 'inset-message'}>
        {mode === 'fetch' ? 'Download remote references without changing your working files. GitDesk never fetches automatically.' :
          mode === 'pull' ? 'Fetch, then merge the tracked remote branch into your current branch.' :
            mode === 'pullRebase' ? 'Fetch, then replay local commits on the tracked remote branch. This rewrites local commit IDs.' :
              mode === 'forcePush' ? 'This may replace commits that other people rely on. A separate confirmation is required.' :
                status.upstream ? `Push local commits from ${status.branch} to its upstream.` : `Publish ${status.branch} and set its upstream on the selected remote.`}
      </div>
      {!status.remotes.length && <p className="muted">Add a remote in Settings → Remotes first.</p>}
      {status.detached && mode !== 'fetch' && <p className="warning-box">Check out a local branch before pulling or pushing.</p>}
      {action.error && <ErrorBox error={action.error} />}
      {action.pending && <div className="inline-progress"><Spinner label={`${labels[mode]} in progress…`} />
        {progress && <pre>{progress}</pre>}<button type="button" className="text-button" onClick={onActivity}>View command activity</button></div>}
    </div><footer className="dialog-footer">
      {action.pending ? <button type="button" className="button" onClick={() => void safely(() => perform('cancel', { repoId: repo.id }))}>Cancel operation</button>
        : <button type="button" className="button" onClick={onClose}>Cancel</button>}
      <button className={`button ${mode === 'forcePush' ? 'danger' : 'primary'}`} disabled={busy || action.pending || !remote || (mode !== 'fetch' && (status.detached || status.unborn))}>
        {mode === 'fetch' ? <RefreshCw size={15} /> : mode === 'pull' || mode === 'pullRebase' ? <ArrowDown size={15} /> : <ArrowUp size={15} />}
        {labels[mode]}{mode === 'forcePush' ? '…' : ''}
      </button>
    </footer></form>
  </Dialog>;
}

export function StashDialog({ repo, status, perform, confirm, busy, onClose }: {
  repo: Repository; status: RepoStatus; perform: Perform; confirm: Confirm; busy: boolean; onClose: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const stashes = useResource(repo.id, () => request('stashes', { repoId: repo.id }), [revision]);
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const action = useAction();
  return <Dialog title="Stashed changes" subtitle={`Set work aside in ${repo.name}, and pick it up later.`} wide onClose={onClose} closingDisabled={action.pending}>
    <div className="dialog-body form-stack">
      <form className="form-stack stash-save" onSubmit={event => {
        event.preventDefault(); void action.run(async () => {
          await perform('stash', { repoId: repo.id, action: 'save', message, includeUntracked });
          setMessage(''); setRevision(value => value + 1);
        });
      }}>
        <Field label="Stash message (optional)"><input data-autofocus value={message} maxLength={1000} placeholder="Work in progress…" onChange={event => setMessage(event.target.value)} disabled={busy} /></Field>
        <div className="stash-save-footer"><label className="checkbox-label"><input type="checkbox" checked={includeUntracked} onChange={event => setIncludeUntracked(event.target.checked)} disabled={busy} />Include untracked files</label>
          <button className="button primary" disabled={busy || !!status.operation || status.files.some(file => file.conflicted) || !status.files.some(file => !file.untracked || includeUntracked)}><Plus size={15} />Save stash</button></div>
        <small className="muted">Stashing removes saved changes from the working tree and index. Ignored files are not included.</small>
      </form>
      <h3>Saved in this repository</h3>
      {stashes.loading && !stashes.data && <Spinner />}
      {stashes.error && <ErrorBox error={stashes.error} retry={() => setRevision(value => value + 1)} />}
      {stashes.data?.length === 0 && <p className="inset-message">No stashed changes. Your next unfinished idea can wait here.</p>}
      <div className="stash-list">{stashes.data?.map(stash => <article className="stash-item" key={stash.sha}>
        <div><code>{stash.ref}</code><time>{formatDate(stash.date)}</time></div><h4>{stash.message}</h4>
        <div className="button-row">{(['apply', 'pop', 'drop'] as const).map(mode =>
          <button key={mode} className={`button small${mode === 'drop' ? ' text-danger' : ''}`} disabled={busy || !!status.operation || status.files.some(file => file.conflicted)} onClick={() => void action.run(async () => {
            const descriptions = {
              apply: 'Restore these changes while keeping the stash. Conflicts may occur.',
              pop: 'Restore these changes and remove the stash after a successful apply. If conflicts occur, Git keeps the stash.',
              drop: 'Permanently remove this saved stash. This cannot be undone in GitDesk.',
            };
            if (!await confirm({ title: `${mode === 'apply' ? 'Apply' : mode === 'pop' ? 'Pop' : 'Drop'} ${stash.ref}?`, message: stash.message,
              detail: descriptions[mode], confirmLabel: `${mode === 'apply' ? 'Apply' : mode === 'pop' ? 'Pop' : 'Drop'} stash`, danger: mode === 'drop' })) return;
            try { await perform('stash', { repoId: repo.id, action: mode, ref: stash.ref, confirmed: true }); }
            finally { setRevision(value => value + 1); }
          })}>{mode === 'apply' ? 'Apply · keep stash' : mode === 'pop' ? 'Pop · apply & remove' : 'Drop…'}</button>)}</div>
      </article>)}</div>
      {action.error && <ErrorBox error={action.error} />}
      {action.pending && <Spinner label="Updating stash…" />}
    </div><footer className="dialog-footer"><button className="button" onClick={onClose} disabled={action.pending}>Done</button></footer>
  </Dialog>;
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const mod = window.gitdesk?.platform === 'darwin' ? '⌘' : 'Ctrl';
  return <Dialog title="Keyboard shortcuts" subtitle="Keep your hands on the keyboard." onClose={onClose}>
    <div className="dialog-body"><dl className="shortcut-list">
      {[[`${mod} + O`, 'Add a repository'], [`${mod} + Enter`, 'Commit staged changes'], [`${mod} + R`, 'Refresh local repository'],
        [`${mod} + ,`, 'Open settings'], [`${mod} + /`, 'Show keyboard shortcuts'], ['Escape', 'Close a menu or dialog'],
        ['↑ / ↓', 'Navigate menu items'], ['Tab / Shift + Tab', 'Move between controls']].map(([keys, description]) =>
        <div key={keys}><dt>{description}</dt><dd><kbd>{keys}</kbd></dd></div>)}
    </dl><p className="inset-message">Refresh reads local Git state only. Use Fetch when you want to check a remote.</p></div>
    <footer className="dialog-footer"><button className="button primary" onClick={onClose}>Got it</button></footer>
  </Dialog>;
}

export function BranchRows({ branches, busy, switchBranch }: { branches: Branch[]; busy: boolean; switchBranch: (branch: Branch) => void }) {
  return <>{branches.map(branch => <button role="menuitem" className={`branch-row${branch.current ? ' current' : ''}`} key={branch.name}
    disabled={busy || branch.current} onClick={() => switchBranch(branch)}>
    {branch.remote ? <Globe size={15} /> : <GitBranch size={15} />}
    <span><strong>{branch.name}</strong>{branch.upstream && <small>{branch.upstream}</small>}</span>
    {branch.current && <Check size={14} />}
  </button>)}</>;
}
