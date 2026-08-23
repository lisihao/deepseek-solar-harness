/** Sandboxed bridge for the Desktop-owned remote Server pairing window. */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('dshFrontendSetup', {
  describe: () => ipcRenderer.invoke('dsh-desktop:frontend-setup:describe'),
  configure: (value: unknown) => ipcRenderer.invoke('dsh-desktop:frontend-setup:configure', value),
  useServer: () => ipcRenderer.invoke('dsh-desktop:frontend-setup:use-server'),
  close: () => ipcRenderer.send('dsh-desktop:frontend-setup:close'),
})
