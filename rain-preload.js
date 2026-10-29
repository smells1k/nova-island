'use strict';

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rainAPI', Object.freeze({
  onIntensity(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, intensity) => callback(intensity);
    ipcRenderer.on('nova:rain-intensity', listener);
    return () => ipcRenderer.removeListener('nova:rain-intensity', listener);
  },
  onSurfaces(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, surfaces) => callback(Array.isArray(surfaces) ? surfaces : []);
    ipcRenderer.on('nova:rain-surfaces', listener);
    return () => ipcRenderer.removeListener('nova:rain-surfaces', listener);
  },
}));
