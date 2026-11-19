// Exposes a tiny native API to the Forge page (only exists inside the desktop app).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('forgeDesktop', {
  pickFolder: () => ipcRenderer.invoke('forge:pickFolder'),
  openPath: (p) => ipcRenderer.invoke('forge:openPath', p),
});
