import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import type { AppError, AppState, CommandArgs, CommandData, CommandLog, CommandName } from '../shared/api';

export class CommandError extends Error {
  readonly info: AppError;
  constructor(info: AppError) {
    super(info.message);
    this.name = 'CommandError';
    this.info = info;
  }
}

export function errorInfo(error: unknown): AppError {
  if (error instanceof CommandError) return error.info;
  return { code: 'CLIENT_ERROR', message: error instanceof Error ? error.message : String(error) };
}

export async function request<K extends CommandName>(command: K, args: CommandArgs<K>): Promise<CommandData<K>> {
  if (!window.gitdesk) throw new CommandError({
    code: 'DESKTOP_REQUIRED',
    message: 'The desktop connection is unavailable.',
    detail: 'Open GitDesk using the installed application, not a web browser. If you are already in the app, close and reopen it.',
  });
  const result = await window.gitdesk.call(command, args);
  if (!result.ok) throw new CommandError(result.error);
  return result.data;
}

const mutations = new Set<CommandName>([
  'selectRepository', 'addRepository', 'initRepository', 'cloneRepository', 'removeRepository',
  'setPreferences', 'stage', 'commit', 'discard', 'ignore', 'branch', 'network', 'integrate',
  'commitAction', 'stash', 'resolve', 'operation', 'setIdentity', 'remote',
  'setHttpsCredentials', 'forgetHttpsCredentials',
  'githubSignIn', 'githubImportCli', 'githubBeginLogin', 'githubSignOut',
  'githubCreate', 'githubClone', 'githubPublish',
]);

export type Perform = <K extends CommandName>(command: K, args: CommandArgs<K>) => Promise<CommandData<K>>;

export function useController() {
  const [app, setApp] = useState<AppState | null>(null);
  const [appError, setAppError] = useState<AppError | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [logs, setLogs] = useState<CommandLog[]>([]);
  const [toast, setToast] = useState<AppError | null>(null);
  const stateGeneration = useRef(0);
  const mounted = useRef(true);

  const report = useCallback((error: unknown, command = 'GitDesk') => {
    const info = errorInfo(error);
    setToast(info);
    setLogs(previous => [...previous.slice(-399), {
      id: crypto.randomUUID(), command, phase: 'failed', message: [info.message, info.detail].filter(Boolean).join('\n'),
      time: new Date().toISOString(),
    }]);
    return info;
  }, []);

  const loadApp = useCallback(async () => {
    const generation = ++stateGeneration.current;
    try {
      const state = await request('getAppState', {});
      if (mounted.current && generation === stateGeneration.current) {
        setApp(state);
        setAppError(null);
      }
    } catch (error) {
      if (mounted.current && generation === stateGeneration.current) setAppError(errorInfo(error));
    }
  }, []);

  const refresh = useCallback(() => {
    setRevision(value => value + 1);
    void loadApp();
  }, [loadApp]);

  const perform: Perform = useCallback(async <K extends CommandName>(command: K, args: CommandArgs<K>) => {
    const mutating = mutations.has(command);
    if (mutating && busyRef.current) throw new CommandError({
      code: 'BUSY', message: 'Another operation is in progress. Wait for it to finish or cancel it in Activity.',
    });
    if (mutating) {
      busyRef.current = true;
      setBusy(command);
    }
    try {
      const data = await request(command, args);
      return data;
    } catch (error) {
      report(error, command);
      throw error;
    } finally {
      if (mutating) {
        busyRef.current = false;
        setBusy(null);
        refresh();
      }
    }
  }, [refresh, report]);

  useEffect(() => {
    mounted.current = true;
    void loadApp();
    const unsubscribe = window.gitdesk?.onEvent(event => {
      if (event.type === 'changed') refresh();
      else setLogs(previous => {
        const index = previous.findIndex(log => log.id === event.log.id);
        if (index < 0) return [...previous.slice(-399), event.log];
        return previous.map((log, position) => position === index ? event.log : log);
      });
    });
    const onFocus = () => { if (document.visibilityState === 'visible' && !busyRef.current) refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    const timer = window.setInterval(onFocus, 5000);
    return () => {
      mounted.current = false;
      unsubscribe?.();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
      window.clearInterval(timer);
    };
  }, [loadApp, refresh]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      document.documentElement.dataset.theme = app?.theme === 'system' || !app?.theme
        ? query.matches ? 'dark' : 'light' : app.theme;
    };
    apply();
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [app?.theme]);

  return { app, appError, revision, busy, logs, toast, setToast, report, perform, refresh };
}

export function useResource<T>(key: string | null, loader: () => Promise<T>, dependencies: DependencyList = []) {
  const [state, setState] = useState<{ key: string | null; data: T | null; error: AppError | null; loading: boolean }>({
    key: null, data: null, error: null, loading: false,
  });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    setState(previous => ({
      key, data: previous.key === key ? previous.data : null, error: null, loading: true,
    }));
    void loaderRef.current().then(data => {
      if (!cancelled) setState({ key, data, error: null, loading: false });
    }, error => {
      if (!cancelled) setState({ key, data: null, error: errorInfo(error), loading: false });
    });
    return () => { cancelled = true; };
    // Callers explicitly describe when the resource changes; the ref avoids restarting on render.
  }, [key, ...dependencies]);
  return state.key === key && key !== null ? state : { key, data: null, error: null, loading: key !== null };
}

export function useDebounced<T>(value: T, delay = 200) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export async function safely(action: () => Promise<unknown>) {
  try { await action(); } catch { /* perform has already recorded this error in Activity. */ }
}
