'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastApi', {
  onData: (cb) => ipcRenderer.on('toast:data', (_e, p) => cb(p)),
  click: () => ipcRenderer.send('toast:click'),
  dismiss: () => ipcRenderer.send('toast:dismiss'),
});
