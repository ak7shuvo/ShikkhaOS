'use strict';
// Preload (sandboxed, CommonJS). Exposes ONE read-only function; no Node.js or Electron objects reach the page.
const { contextBridge, ipcRenderer } = require('electron');

const ALLOWED_CHANNELS = new Set(['desktop:info']);
const invoke = (channel) => {
  if (!ALLOWED_CHANNELS.has(channel)) return Promise.reject(new Error('channel not allowed'));
  return ipcRenderer.invoke(channel);
};

contextBridge.exposeInMainWorld('shikkhaDesktop', Object.freeze({ info: () => invoke('desktop:info') }));
