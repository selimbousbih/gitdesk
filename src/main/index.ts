import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell } from 'electron';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitService } from './git/service';
import { commandNames, runCommand, trustedSender } from './ipc';
import { NativeError, openEditor, openTerminal, remoteWebUrl, repositoryFile } from './native';
import type { AppEvent, CommandHandlers } from '../shared/api';

const root = resolve(__dirname, '../..');
const documentPath = resolve(root, 'dist/index.html');
const documentUrl = pathToFileURL(documentPath).href;
const devUrl = !app.isPackaged && process.env.GITDESK_DEV_URL === 'http://127.0.0.1:5173' ? 'http://127.0.0.1:5173/' : undefined;
if (process.env.GITDESK_USER_DATA) app.setPath('userData', resolve(process.env.GITDESK_USER_DATA));
app.setName('GitDesk');

let window: BrowserWindow | null = null;
let dispose: (() => void | Promise<void>) | undefined;

function emit(event: AppEvent) {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('gitdesk:event', event);
}

async function start() {
  const service = createGitService({
    dataDir: app.getPath('userData'), onEvent: emit,
    github: {
      clientId: process.env.GITDESK_GITHUB_CLIENT_ID,
      encryption: {
        available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend())),
        encrypt: value => safeStorage.encryptString(value),
        decrypt: value => safeStorage.decryptString(value),
      },
    },
  });
  dispose = () => service.dispose();
  const handlers: CommandHandlers = {
    ...service.handlers,
    async githubOpenPage({ page, fullName }) {
      if (page === 'repository' && !fullName) throw new NativeError('INVALID_INPUT', 'Choose a GitHub repository first.');
      await shell.openExternal(page === 'device' ? 'https://github.com/login/device' : page === 'tokens' ? 'https://github.com/settings/tokens' : `https://github.com/${fullName}`);
    },
    async chooseDirectory({ title }) {
      if (!window) throw new NativeError('NO_WINDOW', 'The application window is unavailable.');
      const result = await dialog.showOpenDialog(window, { title, properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    async openPath({ repoId, target, path }) {
      const rootPath = await service.repositoryPath(repoId);
      const file = path ? await repositoryFile(rootPath, path) : undefined;
      if (target === 'editor') return openEditor(rootPath, file);
      if (target === 'terminal') return openTerminal(rootPath);
      if (target === 'file' && !file) throw new NativeError('INVALID_PATH', 'Choose a file to open.');
      // Open files in a text editor rather than asking the OS to execute repository content.
      if (target === 'file') return openEditor(rootPath, file);
      const error = await shell.openPath(rootPath);
      if (error) throw new NativeError('OPEN_FAILED', error);
    },
    async openRemote({ repoId, sha }) {
      const { remotes } = await service.handlers.getRepoSettings({ repoId });
      const remote = remotes.find((item) => item.name === 'origin') ?? remotes[0];
      if (!remote) throw new NativeError('NO_REMOTE', 'Add a remote in Repository settings first.');
      await shell.openExternal(remoteWebUrl(remote.url, sha));
    },
    async windowControl({ action }) {
      if (!window) throw new NativeError('NO_WINDOW', 'The application window is unavailable.');
      if (action === 'close') window.close();
      if (action === 'minimize') window.minimize();
      if (action === 'maximize') {
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
      }
    },
  };
  for (const command of commandNames) {
    ipcMain.handle(`gitdesk:${command}`, async (event, input: unknown) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !trustedSender(event.senderFrame.url, documentUrl, devUrl)) {
        return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: 'This request did not originate in the GitDesk window.' } };
      }
      return runCommand(handlers, command, input);
    });
  }
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === window?.webContents && permission === 'clipboard-sanitized-write');
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === window?.webContents && permission === 'clipboard-sanitized-write');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const policy = `default-src 'self'; script-src 'self'${devUrl ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'${devUrl ? ' ws://127.0.0.1:5173' : ''}; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`;
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } });
  });
  Menu.setApplicationMenu(null);
  window = new BrowserWindow({
    title: 'GitDesk',
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#17191e',
    icon: resolve(root, 'assets/icon.png'),
    frame: false,
    show: false,
    webPreferences: {
      preload: resolve(root, 'out/preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error('GitDesk renderer stopped:', details.reason);
  });
  window.on('focus', () => emit({ type: 'changed' }));
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => window?.show());
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(documentPath);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.whenReady().then(start).catch((error: unknown) => {
    console.error('Unable to start GitDesk:', error instanceof Error ? error.message : 'Unknown error');
    dialog.showErrorBox('GitDesk could not start', error instanceof Error ? error.message : 'Unknown startup error');
    app.quit();
  });
}
app.on('window-all-closed', () => app.quit());
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void Promise.resolve(dispose?.()).catch(() => {
    console.error('GitDesk could not close its credential cache cleanly; cached credentials expire automatically.');
  }).finally(() => app.quit());
});
