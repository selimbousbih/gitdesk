import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUp, Check, Copy, ExternalLink, FolderOpen, Globe, LockKeyhole, Search } from 'lucide-react';
import type { AppError, GitHubAccountState, GitHubDeviceCode, GitHubRepository, Repository, RepoStatus } from '../shared/api';
import { errorInfo, request, useResource, type Perform } from './core';
import { Dialog, ErrorBox, Spinner, formatDate, type Confirm } from './ui';

export type GitHubTab = 'repositories' | 'create' | 'publish' | 'account';
type Pending = { label: string; cancellable?: boolean; repoId?: string };
type Run = <T>(operation: Pending, task: () => Promise<T>) => Promise<T | undefined>;
type Actions = { perform: Perform; run: Run; disabled: boolean };

const validName = (value: string) => /^[A-Za-z0-9_.-]{1,100}$/.test(value) && value !== '.' && value !== '..';
const validFolder = (value: string) => value.length > 0 && value.length <= 200
  && value !== '.' && value !== '..' && value.toLowerCase() !== '.git' && !value.startsWith('-') && !/[/\\\x00-\x1f]/.test(value);
const validRemote = (value: string) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value);

export function GitHubDialog({ initial = 'repositories', repo, status, perform, confirm, busy, onClose, progress, onActivity }: {
  initial?: GitHubTab; repo: Repository | null; status: RepoStatus | null; perform: Perform; confirm: Confirm;
  busy: boolean; onClose: () => void; progress?: string; onActivity: () => void;
}) {
  const [tab, setTab] = useState<GitHubTab>(initial);
  const [revision, setRevision] = useState(0);
  const cachedAccount = useResource('github-account', () => request('githubAccount', {}), [revision]);
  const [updatedAccount, setUpdatedAccount] = useState<GitHubAccountState | null>(null);
  const [accountEpoch, setAccountEpoch] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<AppError | null>(null);
  const errorElement = useRef<HTMLDivElement>(null);
  const [cancelling, setCancelling] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (error) errorElement.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
  const account = updatedAccount ?? cachedAccount.data;
  const acceptAccount = useCallback((next: GitHubAccountState) => {
    setUpdatedAccount(next);
    setAccountEpoch(value => value + 1);
  }, []);
  const run: Run = async (operation, task) => {
    if (pendingRef.current) return undefined;
    pendingRef.current = true;
    setPending(operation); setError(null);
    try { return await task(); }
    catch (reason) { if (mounted.current) setError(errorInfo(reason)); return undefined; }
    finally {
      pendingRef.current = false;
      if (mounted.current) { setPending(null); setCancelling(false); }
    }
  };
  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try { await perform('cancel', pending?.repoId ? { repoId: pending.repoId } : {}); }
    catch (reason) { setError(errorInfo(reason)); }
    finally { if (mounted.current) setCancelling(false); }
  };
  const actions: Actions = { perform, run, disabled: busy || !!pending };
  const tabs: { id: GitHubTab; label: string }[] = [
    { id: 'repositories', label: 'Repositories' }, { id: 'create', label: 'Create private' },
    { id: 'publish', label: 'Publish local' }, { id: 'account', label: 'Account' },
  ];
  return <Dialog title="GitHub" subtitle="Your account, private repositories, and a way to share your work."
    wide onClose={onClose} closingDisabled={!!pending || busy}>
    <nav className="github-tabs" aria-label="GitHub sections">{tabs.map(item =>
      <button key={item.id} type="button" aria-current={tab === item.id ? 'page' : undefined}
        className={tab === item.id ? 'active' : ''} disabled={actions.disabled}
        onClick={() => { setTab(item.id); setError(null); }}>{item.label}</button>)}</nav>
    <div className="dialog-body github-body form-stack">
      {!account && cachedAccount.loading && <Spinner label="Reading GitHub account…" />}
      {!account && cachedAccount.error && <>
        <ErrorBox error={cachedAccount.error} retry={() => setRevision(value => value + 1)} />
        <button type="button" className="button align-start" disabled={actions.disabled} onClick={() => void run({ label: 'Removing the saved GitHub account…' }, async () => {
          if (!await confirm({ title: 'Forget saved GitHub account?', message: 'Remove the saved GitDesk login so you can sign in again?', detail: 'This does not revoke the credential on GitHub or change your CLI login.', confirmLabel: 'Forget saved account' })) return;
          await perform('githubSignOut', {});
          acceptAccount(await request('githubAccount', {}));
        })}>Forget saved GitHub account</button>
      </>}
      {account && (!account.user || tab === 'account') && <GitHubAccountPanel account={account} onAccount={acceptAccount}
        {...actions} onError={setError} onBrowse={() => setTab('repositories')} />}
      {account?.user && tab !== 'account' && <div className="github-account-summary">
        <Globe size={17} /><span>Signed in as <strong>{account.user.login}</strong></span>
        <button type="button" className="text-button" disabled={actions.disabled} onClick={() => setTab('account')}>Manage account</button>
      </div>}
      {account?.user && tab === 'repositories' && <GitHubRepositories key={accountEpoch} {...actions} onClose={onClose} />}
      {account?.user && tab === 'create' && <GitHubCreate key={accountEpoch} account={account} {...actions} confirm={confirm} onClose={onClose} />}
      {account?.user && tab === 'publish' && <GitHubPublish key={`${accountEpoch}:${repo?.id}`} account={account}
        repo={repo} status={status} {...actions} confirm={confirm} onCreate={() => setTab('create')} />}
      {account && window.gitdesk?.platform === 'win32' && <p className="warning-box">On Windows, automatic reuse of this GitHub account for HTTPS Git operations is unavailable. Configure Git Credential Manager and use the normal Clone / Push workflows. Account sign-in, repository browsing, and private repository creation are separate from Git authentication.</p>}
      {error && <div ref={errorElement}><ErrorBox error={error} /></div>}
      {pending && <div className="inline-progress"><Spinner label={pending.label} />
        {pending.cancellable && <><p>Cancellation does not undo completed work. Review the result and any recovery instructions before trying again.</p>
          {progress && <pre>{progress}</pre>}
          <button type="button" className="text-button" onClick={onActivity}>View command activity</button></>}
      </div>}
    </div>
    <footer className="dialog-footer">
      <span className="github-footer-note"><LockKeyhole size={13} />New repositories are always private</span>
      {pending?.cancellable && <button type="button" className="button" disabled={cancelling} onClick={() => void cancel()}>
        {cancelling ? 'Cancelling…' : 'Cancel operation'}</button>}
      <button type="button" className="button" onClick={onClose} disabled={!!pending || busy}>Done</button>
    </footer>
  </Dialog>;
}

function GitHubAccountPanel({ account, onAccount, onError, onBrowse, perform, run, disabled }: Actions & {
  account: GitHubAccountState; onAccount: (account: GitHubAccountState) => void;
  onError: (error: AppError | null) => void; onBrowse: () => void;
}) {
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(false);
  const [clientId, setClientId] = useState('');
  const [device, setDevice] = useState<GitHubDeviceCode | null>(null);
  const [copied, setCopied] = useState(false);
  const cancelledDevice = useRef<GitHubDeviceCode | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!device) return;
    let active = true;
    let interval = Math.max(1, device.intervalSeconds) * 1000;
    let timer: number;
    const expires = Date.parse(device.expiresAt);
    const poll = async () => {
      if (!active) return;
      if (Date.now() >= expires) {
        onError({ code: 'GITHUB_LOGIN_EXPIRED', message: 'Your GitHub sign-in code expired.', detail: 'Start browser sign-in again to get a new code, or use a personal access token.' });
        setDevice(null); return;
      }
      try {
        const result = await request('githubPollLogin', {});
        if (!active) return;
        if (result.state === 'complete') {
          if (!result.account?.user) throw new Error('GitHub did not return an account. Start sign-in again.');
          setDevice(null); onAccount(result.account);
        } else {
          interval = Math.max(interval, result.intervalSeconds * 1000);
          schedule();
        }
      } catch (reason) {
        if (active) { onError(errorInfo(reason)); setDevice(null); }
      }
    };
    const schedule = () => { timer = window.setTimeout(() => void poll(), Math.min(interval, Math.max(0, expires - Date.now()))); };
    schedule();
    return () => {
      active = false;
      window.clearTimeout(timer);
      // Closing the dialog also cancels the main-process login; no token reaches this renderer.
      if (cancelledDevice.current !== device) void perform('githubCancelLogin', {}).catch(reason => {
        if (mounted.current) onError(errorInfo(reason));
      });
    };
  }, [device, onAccount, onError, perform]);

  const browserReady = clientId.trim() ? /^[A-Za-z0-9_.-]{10,100}$/.test(clientId.trim()) : account.browserLoginConfigured;
  const signIn = async () => {
    if (disabled || device || token.length < 10) return;
    const secret = token;
    setToken('');
    const next = await run({ label: 'Checking GitHub token…', cancellable: true }, () => perform('githubSignIn', { token: secret, remember: remember && account.canRemember }));
    if (next && mounted.current) onAccount(next);
  };
  const begin = async () => {
    if (disabled || device || !browserReady) return;
    setToken('');
    const code = await run({ label: 'Starting GitHub browser sign-in…', cancellable: true }, () => perform('githubBeginLogin', {
      ...(clientId.trim() ? { clientId: clientId.trim() } : {}), remember: remember && account.canRemember,
    }));
    if (code) {
      if (!mounted.current) {
        await perform('githubCancelLogin', {}).catch(reason => { if (mounted.current) onError(errorInfo(reason)); });
        return;
      }
      setCopied(false); setDevice(code);
    }
  };
  if (account.user) return <section className="form-stack">
    <div className="github-account-card"><span className="github-avatar"><Globe size={24} /></span>
      <div><h3>{account.user.name || account.user.login}</h3><p className="muted">@{account.user.login}</p></div>
      <span className="label-tag">Connected</span>
    </div>
    <p className="muted">Signed in using {account.source === 'cli' ? 'an explicitly imported GitHub CLI login' : account.source === 'device' ? 'browser sign-in' : 'a personal access token'}.
      {' '}{account.remembered ? 'Your credential is saved using OS-encrypted storage.' : 'Your credential is kept for this GitDesk session only.'}</p>
    <div className="button-row"><button type="button" className="button primary" disabled={disabled} onClick={onBrowse}>Browse GitHub repositories</button>
      <button type="button" className="button" disabled={disabled} onClick={() => void run({ label: 'Signing out of GitDesk…' }, async () => {
        await perform('githubSignOut', {});
        setToken(''); setRemember(false);
        onAccount({ ...account, user: null, source: null, remembered: false });
      })}>Sign out of GitHub</button></div>
    <p className="inset-message">Signing out removes GitDesk’s GitHub credentials only. Your system GitHub CLI login and company GitLab / HTTPS credentials remain unchanged.</p>
    <p className="muted">On Linux/macOS, GitDesk can reuse this account for GitHub HTTPS Git operations. Windows requires Git Credential Manager; automatic account reuse is not available there.</p>
  </section>;
  return <section className="form-stack">
    <div><h3>Connect your GitHub account</h3><p className="muted">Use a personal access token or import an existing GitHub CLI login. No OAuth app setup is needed for these options.</p></div>
    <div className="github-remember">
      <label className="checkbox-label"><input type="checkbox" checked={remember && account.canRemember}
        disabled={disabled || !!device || !account.canRemember} onChange={event => setRemember(event.target.checked)} />Remember this account on this computer</label>
      <small className="muted">{account.canRemember ? 'Optional. Credentials are saved only in OS-encrypted storage.' : 'OS-encrypted storage is unavailable. Sign-in is session-only; credentials are forgotten when GitDesk exits.'}</small>
    </div>
    {!device && <>
      <form className="form-stack" onSubmit={event => { event.preventDefault(); void signIn(); }}>
        <label className="field"><span>Personal access token</span>
          <input data-autofocus type="password" autoComplete="off" spellCheck={false} required minLength={10} maxLength={4096}
            value={token} pattern="[A-Za-z0-9_]+" placeholder="Paste your GitHub token" disabled={disabled}
            onChange={event => setToken(event.target.value)} />
        </label>
        <div className="button-row"><button className="button primary" disabled={disabled || token.length < 10}>Sign in with token</button>
          <button type="button" className="text-button" disabled={disabled} onClick={() => void run({ label: 'Opening GitHub token settings…' },
            () => perform('githubOpenPage', { page: 'tokens' }))}>Token settings on GitHub<ExternalLink size={13} /></button></div>
      </form>
      <p className="inset-message">Classic token: use the <code>repo</code> scope. Fine-grained token: allow access to the target repositories, <strong>Contents: read and write</strong> for clone/push, and <strong>Administration: read and write</strong> to create repositories. Organization access may require approval or SSO authorization.</p>
      <div className="github-cli"><button type="button" className="button" disabled={disabled} onClick={() => {
        setToken('');
        void run({ label: 'Importing your GitHub CLI login…', cancellable: true }, async () => {
          const next = await perform('githubImportCli', { remember: remember && account.canRemember });
          onAccount(next);
        });
      }}>Import GitHub CLI login</button><small className="muted">Already ran <code>gh auth login</code>? Import it explicitly here. GitDesk never uses it automatically.</small></div>
      <details className="github-oauth">
        <summary>Browser login / OAuth client ID</summary>
        <div className="form-stack">
          <p className="muted">Use your own registered GitHub OAuth app with device flow enabled. Enter its public client ID, not a client secret. GitDesk does not borrow another app’s client ID.</p>
          <label className="field"><span>OAuth client ID</span><input value={clientId} maxLength={100} spellCheck={false} autoComplete="off"
            placeholder={account.browserLoginConfigured ? 'Use the configured OAuth app' : 'Your OAuth app’s public client ID'} disabled={disabled}
            onChange={event => setClientId(event.target.value)} />
            <small>{account.browserLoginConfigured ? 'A browser-login app is already configured. Leave blank to use it.' : 'Browser login requires an OAuth client ID. Token and CLI sign-in work without one.'}</small>
          </label>
          <button type="button" className="button align-start" disabled={disabled || !browserReady} onClick={() => void begin()}><Globe size={15} />Continue with browser</button>
        </div>
      </details>
    </>}
    {device && <div className="github-device form-stack">
      <h3>Authorize GitDesk in your browser</h3>
      <p className="muted">Copy this one-time code, open GitHub, and approve access. GitDesk checks for approval while this dialog stays open.</p>
      <div className="github-device-code"><code aria-label="GitHub sign-in code">{device.userCode}</code>
        <button type="button" className="button small" onClick={() => {
          void (async () => {
            try { await navigator.clipboard.writeText(device.userCode); setCopied(true); }
            catch { onError({ code: 'CLIPBOARD_UNAVAILABLE', message: 'The code could not be copied automatically.', detail: 'Select the sign-in code above and copy it using your keyboard, then paste it on GitHub.' }); }
          })();
        }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy code'}</button></div>
      <p className="muted github-verification-uri">{device.verificationUri}</p>
      <div className="button-row"><button type="button" className="button primary" disabled={disabled} onClick={() => void run({ label: 'Opening GitHub in your browser…' },
        () => perform('githubOpenPage', { page: 'device' }))}><ExternalLink size={15} />Open GitHub in browser</button>
        <button type="button" className="button" disabled={disabled} onClick={() => {
          cancelledDevice.current = device;
          setDevice(null);
          void run({ label: 'Cancelling browser sign-in…' }, () => perform('githubCancelLogin', {}));
        }}>Cancel browser sign-in</button></div>
      <Spinner label="Waiting for GitHub approval…" /><small className="muted">Expires {formatDate(device.expiresAt)}. Closing this dialog cancels browser sign-in.</small>
    </div>}
    <small className="muted">GitHub credentials stay separate from company GitLab and other HTTPS Git credentials. Tokens are never written to repository URLs or Git config.</small>
  </section>;
}

function GitHubRepositories({ perform, run, disabled, onClose }: Actions & { onClose: () => void }) {
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<GitHubRepository | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const failedPage = useRef(1);
  const generation = useRef(0);
  const loadingRef = useRef(false);
  useEffect(() => () => { generation.current += 1; }, []);
  const load = async (nextPage: number) => {
    if (loadingRef.current || disabled) return;
    loadingRef.current = true;
    failedPage.current = nextPage;
    setLoading(true); setError(null);
    const current = generation.current;
    try {
      const result = await request('githubRepositories', { page: nextPage });
      if (current !== generation.current) return;
      setRepositories(previous => {
        const merged = new Map((nextPage === 1 ? [] : previous).map(item => [item.id, item]));
        result.repositories.forEach(item => merged.set(item.id, item));
        return [...merged.values()];
      });
      setPage(nextPage); setHasMore(result.hasMore);
      if (nextPage === 1) setSelected(null);
    } catch (reason) { if (current === generation.current) setError(errorInfo(reason)); }
    finally { if (current === generation.current) { setLoading(false); loadingRef.current = false; } }
  };
  const filtered = repositories.filter(item => `${item.fullName} ${item.description ?? ''}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <section className="form-stack">
    <div className="github-section-heading"><div><h3>Clone from GitHub</h3>
      <p className="muted">Browse accessible personal, collaborator, and organization repositories.</p></div>
      {page > 0 && <button type="button" className="button small" disabled={disabled || loading} onClick={() => void load(1)}>Refresh list</button>}
    </div>
    {!page && <div className="github-empty"><Globe size={28} /><p>Nothing is fetched until you ask.</p>
      <button type="button" className="button primary" disabled={disabled || loading} onClick={() => void load(1)}>Load repositories</button>
      <small className="muted">Up to 50 repositories per page, limited by your token’s access.</small></div>}
    {page > 0 && <>
      <label className="field"><span>Filter loaded repositories</span><div className="github-search"><Search size={15} />
        <input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Name or description…" aria-label="Filter loaded GitHub repositories" /></div></label>
      <div className="github-list-summary"><span>{filtered.length} shown · {repositories.length} loaded</span>
        <span>{hasMore ? 'More repositories available · 50 per page' : 'All available pages loaded'}</span></div>
      <div className="github-repositories" role="group" aria-label="GitHub repositories">
        {filtered.map(item => <button key={item.id} type="button" className={`github-repository${selected?.id === item.id ? ' selected' : ''}`}
          aria-pressed={selected?.id === item.id} disabled={disabled} onClick={() => setSelected(item)}>
          <Globe size={17} /><span className="github-repository-text"><strong>{item.fullName}</strong>
            {item.description && <small title={item.description}>{item.description}</small>}</span>
          <span className="github-repository-tags"><span className="label-tag">{item.private ? 'Private' : 'Public'}</span>
            {item.archived && <span className="label-tag">Archived</span>}{selected?.id === item.id && <Check size={14} />}</span>
        </button>)}
        {!filtered.length && <p className="github-empty">{repositories.length ? 'No loaded repositories match this filter. Load more pages or change your filter.' : 'No repositories are accessible with this account. Check the token’s repository access and organization approval.'}</p>}
      </div>
      {hasMore && <button type="button" className="button align-start" disabled={disabled || loading} onClick={() => void load(page + 1)}>Load more repositories</button>}
    </>}
    {loading && <Spinner label="Loading GitHub repositories…" />}
    {error && <ErrorBox error={error} retry={() => void load(failedPage.current)} />}
    {selected && <GitHubClone key={selected.id} repository={selected} perform={perform} run={run} disabled={disabled} onClose={onClose} />}
  </section>;
}

function GitHubClone({ repository, perform, run, disabled, onClose }: Actions & { repository: GitHubRepository; onClose: () => void }) {
  const [path, setPath] = useState('');
  const [name, setName] = useState(repository.name);
  const id = useId();
  return <form className="form-stack github-clone" onSubmit={event => {
    event.preventDefault();
    if (disabled || !path || !validFolder(name)) return;
    void run({ label: `Cloning ${repository.fullName}…`, cancellable: true }, async () => {
      await perform('githubClone', { fullName: repository.fullName, parentPath: path, name });
      onClose();
    });
  }}>
    <h3>Clone {repository.fullName}</h3>
    <div className="field"><label htmlFor={id}>Parent folder</label><div className="input-with-button">
      <input id={id} required value={path} onChange={event => setPath(event.target.value)} placeholder="Choose a local folder…" disabled={disabled} />
      <button type="button" className="button" disabled={disabled} onClick={() => void run({ label: 'Choosing a clone destination…' }, async () => {
        const chosen = await perform('chooseDirectory', { title: 'Choose a parent folder for the GitHub clone' });
        if (chosen !== null) setPath(chosen);
      })}><FolderOpen size={15} />Choose…</button></div>
      <small>A new subfolder is created here. Existing files will not be overwritten.</small>
    </div>
    <label className="field"><span>Local folder name</span><input required maxLength={200} value={name} disabled={disabled}
      onChange={event => setName(event.target.value)} /><small>Use a single folder name, without slashes or a leading hyphen. Folder and parent-path spaces are preserved exactly.</small></label>
    <button type="submit" className="button primary align-start" disabled={disabled || !path || !validFolder(name)}><ArrowDownToLine size={15} />Clone repository</button>
  </form>;
}

function GitHubResult({ repository, perform, run, disabled }: Actions & { repository: GitHubRepository }) {
  return <div className="github-result" role="status"><Check size={19} /><div><strong>Created {repository.fullName}</strong>
    <p className="muted">Private repository on GitHub</p>
    <button type="button" className="text-button" disabled={disabled} onClick={() => void run({ label: 'Opening your GitHub repository…' },
      () => perform('githubOpenPage', { page: 'repository', fullName: repository.fullName }))}>
      <span>github.com/{repository.fullName}</span><ExternalLink size={13} /></button></div></div>;
}

function GitHubCreate({ account, confirm, onClose, ...actions }: Actions & {
  account: GitHubAccountState; confirm: Confirm; onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [created, setCreated] = useState<GitHubRepository | null>(null);
  const [cloning, setCloning] = useState(false);
  const { disabled, run, perform } = actions;
  if (created) return <section className="form-stack"><GitHubResult repository={created} {...actions} />
    <p className="muted">This is an empty remote repository. No local files or commits were created.</p>
    {cloning ? <GitHubClone repository={created} {...actions} onClose={onClose} /> : <button type="button" className="button primary align-start"
      disabled={disabled} onClick={() => setCloning(true)}><ArrowDownToLine size={15} />Clone this repository</button>}
  </section>;
  return <form className="form-stack" onSubmit={event => {
    event.preventDefault();
    if (disabled || !validName(name)) return;
    void run({ label: 'Creating private GitHub repository…', cancellable: true }, async () => {
      if (!await confirm({ title: 'Create a private GitHub repository?', message: `Create ${account.user!.login}/${name} on GitHub?`,
        detail: 'This creates an empty private repository under your personal account. No local folder, commit, README, or public repository is created. Organization creation is not supported.',
        confirmLabel: 'Create private repository' })) return;
      const result = await perform('githubCreate', { name, description, confirmed: true });
      setCreated(result);
    });
  }}>
    <div><h3>Create an empty repository</h3><p className="muted">Owner: <strong>{account.user!.login}</strong> · Personal account only. Organization repositories can be listed and cloned.</p></div>
    <GitHubRepositoryFields name={name} setName={setName} description={description} setDescription={setDescription} disabled={disabled} />
    <button className="button primary align-start" disabled={disabled || !validName(name)}><LockKeyhole size={15} />Create private repository</button>
  </form>;
}

function GitHubRepositoryFields({ name, setName, description, setDescription, disabled }: {
  name: string; setName: (name: string) => void; description: string; setDescription: (description: string) => void; disabled: boolean;
}) {
  return <>
    <label className="field"><span>GitHub repository name</span><input required value={name} maxLength={100} pattern="[A-Za-z0-9_.\-]+"
      placeholder="my-project" onChange={event => setName(event.target.value)} disabled={disabled} />
      <small>Letters, numbers, dots, hyphens, and underscores; up to 100 characters.</small></label>
    <label className="field"><span>Description <span className="muted">(optional)</span></span><textarea value={description} maxLength={350} rows={2}
      onChange={event => setDescription(event.target.value)} disabled={disabled} /></label>
    <div className="github-privacy"><LockKeyhole size={17} /><div><strong>Private · locked</strong><p className="muted">Only you and people you grant access can see this repository. GitDesk never creates public repositories.</p></div></div>
  </>;
}

function GitHubPublish({ account, repo, status, confirm, onCreate, ...actions }: Actions & {
  account: GitHubAccountState; repo: Repository | null; status: RepoStatus | null; confirm: Confirm; onCreate: () => void;
}) {
  const [name, setName] = useState(repo?.name ?? '');
  const [description, setDescription] = useState('');
  const [remoteInput, setRemoteInput] = useState<string | null>(null);
  const [published, setPublished] = useState<GitHubRepository | null>(null);
  const { disabled, run, perform } = actions;
  const remote = remoteInput ?? (status?.remotes.some(item => item.name === 'origin') ? 'github' : 'origin');
  const problems: string[] = [];
  if (!repo) problems.push('Open a local repository in GitDesk first.');
  else if (!status) problems.push('Local repository status is unavailable. Close this dialog and refresh local status.');
  else {
    if (status.unborn || !status.head) problems.push('Create at least one local commit before publishing.');
    if (status.detached) problems.push('Check out a local branch before publishing; HEAD is detached.');
    if (status.files.length) problems.push('Commit, stash, or remove all local changes, including untracked files, before publishing.');
    if (status.operation) problems.push(`Finish or abort the active ${status.operation.type} before publishing.`);
    if (status.upstream) problems.push(`This branch already tracks “${status.upstream}”. GitDesk preserves that upstream instead of retargeting it. Create an empty private repository and configure separate publication with command-line Git, or create a new local branch without tracking.`);
    if (status.remotes.some(item => item.name === remote)) problems.push(`A remote named “${remote}” already exists. Choose an unused remote name; existing remotes are never overwritten.`);
  }
  if (published) return <section className="form-stack"><GitHubResult repository={published} {...actions} />
    <p className="saved-message"><Check size={15} />Current branch published and upstream configured.</p>
    <p className="muted">Only the current branch and its history were pushed. Other branches and tags were not published.</p></section>;
  return <form className="form-stack" onSubmit={event => {
    event.preventDefault();
    if (disabled || problems.length || !repo || !status || !validName(name) || !validRemote(remote)) return;
    void run({ label: 'Publishing private GitHub repository…', cancellable: true, repoId: repo.id }, async () => {
      if (!await confirm({ title: 'Publish this repository to GitHub?', message: `Create private repository ${account.user!.login}/${name} and push branch “${status.branch}”?`,
        detail: `This uploads the current branch and all of its history, adds the unused local remote “${remote}”, and sets the branch’s first upstream. Check committed history for secrets before sharing. Other branches and tags are not pushed. Nothing is staged, committed, or force-pushed. Existing remotes, upstreams, and custom push destinations are never replaced; publication is refused if any tracking or push configuration would be retargeted.\n\nIf a later step fails or you cancel, an already-created GitHub repository or local remote is retained for recovery. Review the error and remote settings before trying again.`,
        confirmLabel: 'Publish private repository' })) return;
      const result = await perform('githubPublish', { repoId: repo.id, name, description, remote, confirmed: true });
      setPublished(result);
    });
  }}>
    <div><h3>Publish a local repository</h3><p className="muted">{repo ? `${repo.name} → ${account.user!.login} · personal GitHub account` : 'Share an existing local repository, privately.'}</p></div>
    {repo && <div className="github-local-repository"><FolderOpen size={16} /><div><code>{repo.path}</code>
      <small className="muted">Current branch: {status?.detached ? 'Detached HEAD' : status?.branch || 'Reading status…'}</small></div></div>}
    <GitHubRepositoryFields name={name} setName={setName} description={description} setDescription={setDescription} disabled={disabled || !repo} />
    <label className="field"><span>New remote name</span><input required value={remote} maxLength={128} pattern="[A-Za-z0-9_][A-Za-z0-9_.\-]*"
      disabled={disabled || !repo} onChange={event => setRemoteInput(event.target.value)} /><small>Must be unused. Existing remotes{status?.remotes.length ? `: ${status.remotes.map(item => item.name).join(', ')}` : ' are never overwritten'}.</small></label>
    <p className="inset-message">Publishes only the current branch and its complete committed history, then sets its first upstream. Requires a clean working tree, including untracked files, and no existing upstream or custom push destination. GitDesk never stages, commits, force-pushes, or retargets existing tracking for you.</p>
    {problems.length > 0 && <div className="warning-box"><strong>Before you publish</strong><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div>}
    {status?.upstream && <button type="button" className="text-button align-start" disabled={disabled} onClick={onCreate}>Create an empty private repository instead</button>}
    <button className="button primary align-start" disabled={disabled || problems.length > 0 || !validName(name) || !validRemote(remote)}><ArrowUp size={15} />Publish private repository</button>
  </form>;
}
