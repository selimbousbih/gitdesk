import { useState } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { AppError } from '../shared/api';
import { httpsRepositoryUrl } from '../shared/https';
import { errorInfo, request, useResource, type Perform } from './core';
import { ErrorBox, Spinner } from './ui';

export function HttpsAuthPanel({ url, perform, busy, expanded = false }: {
  url: string; perform: Perform; busy: boolean; expanded?: boolean;
}) {
  const normalized = httpsRepositoryUrl(url);
  return normalized ? <CredentialFields key={normalized} url={normalized} perform={perform} busy={busy} expanded={expanded} /> : null;
}

function CredentialFields({ url, perform, busy, expanded }: {
  url: string; perform: Perform; busy: boolean; expanded: boolean;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<AppError | null>(null);
  const [pending, setPending] = useState(false);
  const auth = useResource(url, () => request('getHttpsAuth', { url }), [busy, revision]);
  const github = new URL(url).hostname === 'github.com';
  const disabled = busy || pending || !auth.data?.supported;

  const save = async () => {
    if (disabled || !username.trim() || !password) return;
    const secret = password;
    setPassword('');
    setPending(true);
    setError(null);
    try {
      await perform('setHttpsCredentials', { url, username: username.trim(), password: secret });
      setRevision(value => value + 1);
    } catch (reason) { setError(errorInfo(reason)); }
    finally { setPending(false); }
  };
  const forget = async () => {
    setPending(true);
    setPassword('');
    setError(null);
    try {
      await perform('forgetHttpsCredentials', { url });
      setUsername('');
      setRevision(value => value + 1);
    } catch (reason) { setError(errorInfo(reason)); }
    finally { setPending(false); }
  };

  return <details className="https-auth" open={expanded || undefined}>
    <summary><LockKeyhole size={15} />HTTPS authentication{auth.data?.username && <span className="label-tag">Session ready</span>}</summary>
    <div className="form-stack https-auth-body" onKeyDown={event => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault(); event.stopPropagation(); void save();
      }
    }}>
      <p className="muted">Use your company GitLab or another HTTPS Git server. Credentials are scoped to this repository URL, kept only in memory, and forgotten on exit or after one hour without use.</p>
      <code className="https-auth-url">{url}</code>
      {github ? <p className="inset-message">GitHub requires your username and a personal access token, not your account password.</p>
        : <p className="inset-message">Use the email or username accepted by your GitLab instance. With 2FA or SSO, use a personal access token instead of your account password. GitLab tokens need read_repository for clone/fetch and write_repository for push.</p>}
      {auth.data && !auth.data.supported && <p className="warning-box">In-app session credentials use Git credential-cache on Linux/macOS. On Windows, configure Git Credential Manager instead.</p>}
      {auth.data?.username && <p className="saved-message" role="status">Credentials prepared for {auth.data.username}. Access is checked on your next clone, fetch, pull or push—not by saving this form.</p>}
      <label className="field"><span>Email or username</span><input type="text" autoComplete="username" value={username}
        maxLength={500} placeholder={github ? 'Your GitHub username' : 'name@company.com'} disabled={disabled}
        onChange={event => setUsername(event.target.value)} /></label>
      <label className="field"><span>Password or personal access token</span><input type="password" autoComplete="current-password" value={password}
        maxLength={8192} placeholder="Password or token" disabled={disabled} onChange={event => setPassword(event.target.value)} /></label>
      <div className="button-row">
        <button type="button" className="button primary" disabled={disabled || !username.trim() || !password}
          onClick={() => void save()}>Use credentials for this session</button>
        <button type="button" className="button" disabled={disabled} onClick={() => void forget()}>Forget session credentials</button>
      </div>
      <small className="muted">No password is saved to app settings, Git config, URLs or logs. Existing system Git credentials remain unchanged.</small>
      {pending && <Spinner label="Updating session credentials…" />}
      {(error || auth.error) && <ErrorBox error={error ?? auth.error!} />}
    </div>
  </details>;
}
