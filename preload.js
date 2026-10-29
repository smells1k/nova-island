'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('novaAPI', Object.freeze({
  getState: () => ipcRenderer.invoke('nova:get-state'),
  setExpanded: (expanded) => ipcRenderer.invoke('nova:set-expanded', Boolean(expanded)),
  addItem: (data) => ipcRenderer.invoke('nova:add-item', data),
  chooseFiles: () => ipcRenderer.invoke('nova:choose-files'),
  addDroppedFiles: (paths) => ipcRenderer.invoke('nova:add-dropped-files', paths),
  togglePin: (id) => ipcRenderer.invoke('nova:toggle-pin', id),
  deleteItem: (id) => ipcRenderer.invoke('nova:delete-item', id),
  clearClipboard: () => ipcRenderer.invoke('nova:clear-clipboard'),
  setClipboardEnabled: (enabled) => ipcRenderer.invoke('nova:set-clipboard-enabled', Boolean(enabled)),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('nova:set-always-on-top', Boolean(enabled)),
  setActiveMedia: (id) => ipcRenderer.invoke('nova:set-active-media', id),
  closeActiveMedia: () => ipcRenderer.invoke('nova:close-active-media'),
  cleanOrphanedStorage: () => ipcRenderer.invoke('nova:clean-orphaned-storage'),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke('nova:set-launch-at-login', Boolean(enabled)),
  copyItem: (id) => ipcRenderer.invoke('nova:copy-item', id),
  openItem: (id) => ipcRenderer.invoke('nova:open-item', id),
  revealItem: (id) => ipcRenderer.invoke('nova:reveal-item', id),
  openStorage: () => ipcRenderer.invoke('nova:open-storage'),
  quit: () => ipcRenderer.invoke('nova:quit'),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  onState: (callback) => subscribe('nova:state', callback),
  onExpanded: (callback) => subscribe('nova:expanded', callback),
  onShortcut: (callback) => subscribe('nova:shortcut', callback),
}));
