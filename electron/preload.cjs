const { contextBridge, ipcRenderer } = require('electron');

// Expose safe, isolated desktop APIs to the renderer process
contextBridge.exposeInMainWorld('desktopAPI', {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
});
