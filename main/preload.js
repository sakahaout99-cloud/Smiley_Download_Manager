'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sdm', {
  call(method, payload) {
    return ipcRenderer.invoke('sdm:call', { method, payload });
  },
  onEvent(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('sdm:event', listener);
    return () => ipcRenderer.removeListener('sdm:event', listener);
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
});
