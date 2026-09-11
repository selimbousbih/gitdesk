import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, CommandArgs, CommandData, CommandName, GitDeskAPI, Result } from '../shared/api';

const api: GitDeskAPI = {
  call<K extends CommandName>(command: K, args: CommandArgs<K>): Promise<Result<CommandData<K>>> {
    return ipcRenderer.invoke(`gitdesk:${command}`, args);
  },
  onEvent(callback) {
    const listener = (_event: Electron.IpcRendererEvent, data: AppEvent) => callback(data);
    ipcRenderer.on('gitdesk:event', listener);
    return () => ipcRenderer.removeListener('gitdesk:event', listener);
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('gitdesk', Object.freeze(api));
