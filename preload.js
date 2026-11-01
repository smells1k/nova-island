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
  focusTimer: (action, minutes, mode, taskId) => ipcRenderer.invoke('nova:focus-timer', action, minutes, mode, taskId),
  addTask: (data) => ipcRenderer.invoke('nova:add-task', data),
  toggleTask: (id) => ipcRenderer.invoke('nova:toggle-task', id),
  deleteTask: (id) => ipcRenderer.invoke('nova:delete-task', id),
  exportBackup: () => ipcRenderer.invoke('nova:export-backup'),
  importBackup: () => ipcRenderer.invoke('nova:import-backup'),
  addItem: (data) => ipcRenderer.invoke('nova:add-item', data),
  chooseFiles: () => ipcRenderer.invoke('nova:choose-files'),
  addDroppedFiles: (paths) => ipcRenderer.invoke('nova:add-dropped-files', paths),
  togglePin: (id) => ipcRenderer.invoke('nova:toggle-pin', id),
  deleteItem: (id) => ipcRenderer.invoke('nova:delete-item', id),
  clearClipboard: () => ipcRenderer.invoke('nova:clear-clipboard'),
  setClipboardEnabled: (enabled) => ipcRenderer.invoke('nova:set-clipboard-enabled', Boolean(enabled)),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('nova:set-always-on-top', Boolean(enabled)),
  setClickThrough: (enabled) => ipcRenderer.invoke('nova:set-click-through', Boolean(enabled)),
  setGameMode: (enabled) => ipcRenderer.invoke('nova:set-game-mode', Boolean(enabled)),
  setVolumeWheel: (enabled) => ipcRenderer.invoke('nova:set-volume-wheel', Boolean(enabled)),
  setMicMonitoring: (enabled) => ipcRenderer.invoke('nova:set-mic-monitoring', Boolean(enabled)),
  setVisualEffects: (values) => ipcRenderer.invoke('nova:set-visual-effects', values && typeof values === 'object' ? values : {}),
  setExpandedPosition: (x, y) => ipcRenderer.invoke('nova:set-expanded-position', Number(x), Number(y)),
  createFolder: (name) => ipcRenderer.invoke('nova:create-folder', String(name || '').slice(0, 60)),
  assignFolder: (id, name) => ipcRenderer.invoke('nova:assign-folder', String(id || ''), String(name || '').slice(0, 60)),
  chooseQuickApp: () => ipcRenderer.invoke('nova:choose-quick-app'),
  launchQuickApp: (id) => ipcRenderer.invoke('nova:launch-quick-app', String(id || '')),
  removeQuickApp: (id) => ipcRenderer.invoke('nova:remove-quick-app', String(id || '')),
  runAdminCommand: (command) => ipcRenderer.invoke('nova:run-admin-command', String(command || '').slice(0, 2000)),
  captureScreens: () => ipcRenderer.invoke('nova:capture-screens'),
  prepareRecordSource: () => ipcRenderer.invoke('nova:prepare-record-source'),
  getRecordScreens: () => ipcRenderer.invoke('nova:get-record-screens'),
  selectRecordScreen: (id) => ipcRenderer.invoke('nova:select-record-screen', String(id || '')),
  setWeatherCity: (city) => ipcRenderer.invoke('nova:set-weather-city', String(city || '').slice(0, 80)),
  saveScreenshot: (dataUrl) => ipcRenderer.invoke('nova:save-screenshot', String(dataUrl || '')),
  copyScreenshot: (dataUrl) => ipcRenderer.invoke('nova:copy-screenshot', String(dataUrl || '')),
  saveRecording: (payload) => ipcRenderer.invoke('nova:save-recording', payload),
  approveAudioRecording: () => ipcRenderer.invoke('nova:approve-audio-recording'),
  getSystemSnapshot: () => ipcRenderer.invoke('nova:get-system-snapshot'),
  getRepositoryStatus: () => ipcRenderer.invoke('nova:get-repository-status'),
  pingHost: (host) => ipcRenderer.invoke('nova:ping-host', String(host || '').slice(0, 253)),
  systemAction: (action) => ipcRenderer.invoke('nova:system-action', String(action || '')),
  adjustSystemControl: (control, direction) => ipcRenderer.invoke('nova:adjust-system-control', String(control || ''), Number(direction) || 0),
  openRepository: () => ipcRenderer.invoke('nova:open-repository'),
  openLatestRelease: () => ipcRenderer.invoke('nova:open-latest-release'),
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
  onFocusTick: (callback) => subscribe('nova:focus-tick', callback),
  onClipboardPulse: (callback) => subscribe('nova:clipboard-pulse', callback),
  onShortcut: (callback) => subscribe('nova:shortcut', callback),
}));
