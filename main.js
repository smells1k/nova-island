'use strict';

const {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  Tray,
} = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const systemServices = require('./system-services');
const taskUtils = require('./task-utils');

const PRODUCT_NAME = 'NOVA Island';
const STORE_VERSION = 2;
const MAX_ITEMS = 180;
const MAX_TASKS = taskUtils.MAX_TASKS;
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES = 180 * 1024 * 1024;
const MEDIA_TYPE_BY_EXTENSION = {
  MP3: 'audio', M4A: 'audio', OGG: 'audio', WAV: 'audio', AAC: 'audio', FLAC: 'audio',
  MP4: 'video', MPG: 'video', MPEG: 'video', OGV: 'video', WEBM: 'video', MOV: 'video',
};
const DEFAULT_SETTINGS = {
  clipboardEnabled: true,
  launchAtLogin: false,
  alwaysOnTop: true,
  clickThroughCollapsed: false,
  gameMode: false,
  micMonitoringEnabled: false,
  volumeWheelEnabled: true,
  liquidGlassEnabled: false,
  rainEnabled: false,
  rainIntensity: 'normal',
  accentColor: '#b5a8ff',
  expandedPosition: null,
  windowPosition: null,
  weatherLocation: { name: 'Хабаровск', latitude: 48.48, longitude: 135.07 },
  quickApps: [],
  mediaPlayerItemId: '',
  focusTimer: {
    mode: 'focus',
    durationMinutes: 25,
    durationMs: 25 * 60 * 1000,
    remainingMs: 25 * 60 * 1000,
    endsAt: 0,
    running: false,
    taskId: '',
    taskTitle: '',
  },
};

let mainWindow = null;
let rainWindows = new Map();
let tray = null;
let storePath = '';
let libraryPath = '';
let store = { version: STORE_VERSION, settings: { ...DEFAULT_SETTINGS }, items: [], tasks: [], folders: [] };
let dashboardMetrics = null;
let dashboardWeather = null;
let dashboardRefreshTimer = null;
let dashboardWeatherTimer = null;
let audioRecordApproval = false;
let screenRecordSourceId = '';
let preferredScreenRecordSourceId = '';
let expanded = false;
let isQuitting = false;
let clipboardTimer = null;
let focusTimerInterval = null;
let collapseTimer = null;
let positionSaveTimer = null;
let fullscreenTimer = null;
let fullscreenProbeRunning = false;
let rainSurfaceTimer = null;
let rainSurfaceProbeRunning = false;
let clipboardPulseTimer = null;
let clipboardPulseUntil = 0;
let isGameHidden = false;
let manuallyHidden = false;
let lastClipboardText = '';
let lastClipboardUriKey = '';
let lastClipboardImageHash = '';
let isPollingClipboard = false;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    setExpanded(true);
  });
}

function ensureDirectories() {
  const userData = app.getPath('userData');
  storePath = path.join(userData, 'nova-store.json');
  libraryPath = path.join(userData, 'library');
  fs.mkdirSync(libraryPath, { recursive: true });
}

function normalizeFocusTimer(value) {
  const timer = value && typeof value === 'object' ? value : {};
  const durationMinutes = Math.min(180, Math.max(1, Math.round(Number(timer.durationMinutes) || 25)));
  const durationMs = durationMinutes * 60 * 1000;
  const endsAt = Math.max(0, Number(timer.endsAt) || 0);
  const requestedRunning = Boolean(timer.running);
  const remainingMs = requestedRunning
    ? Math.max(0, endsAt - Date.now())
    : Math.min(durationMs, Math.max(0, Number(timer.remainingMs) || durationMs));
  const running = requestedRunning && remainingMs > 0;
  return {
    mode: timer.mode === 'break' ? 'break' : 'focus',
    durationMinutes,
    durationMs,
    remainingMs: running ? remainingMs : (requestedRunning ? 0 : remainingMs),
    endsAt: running ? endsAt : 0,
    running,
    taskId: safeString(timer.taskId, 100).trim(),
    taskTitle: safeString(timer.taskTitle, 180).trim(),
  };
}

function focusTimerSnapshot() {
  const timer = store.settings.focusTimer || DEFAULT_SETTINGS.focusTimer;
  const remainingMs = timer.running ? Math.max(0, timer.endsAt - Date.now()) : timer.remainingMs;
  return { ...timer, remainingMs };
}

function loadStore() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    saved = null;
  }

  const settings = {
    ...DEFAULT_SETTINGS,
    ...(saved && saved.settings && typeof saved.settings === 'object' ? saved.settings : {}),
  };
  // Focus timer removed from the interface in v1.6; discard any previous running session.
  settings.focusTimer = normalizeFocusTimer(DEFAULT_SETTINGS.focusTimer);
  settings.liquidGlassEnabled = Boolean(settings.liquidGlassEnabled);
  settings.rainEnabled = Boolean(settings.rainEnabled);
  settings.rainIntensity = ['light', 'normal', 'storm'].includes(settings.rainIntensity) ? settings.rainIntensity : 'normal';
  settings.accentColor = /^#[0-9a-f]{6}$/i.test(String(settings.accentColor)) ? String(settings.accentColor) : DEFAULT_SETTINGS.accentColor;
  const location = settings.weatherLocation && typeof settings.weatherLocation === 'object' ? settings.weatherLocation : DEFAULT_SETTINGS.weatherLocation;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  settings.weatherLocation = {
    name: safeString(location.name || DEFAULT_SETTINGS.weatherLocation.name, 60).trim() || DEFAULT_SETTINGS.weatherLocation.name,
    latitude: Number.isFinite(latitude) ? Math.max(-90, Math.min(90, latitude)) : DEFAULT_SETTINGS.weatherLocation.latitude,
    longitude: Number.isFinite(longitude) ? Math.max(-180, Math.min(180, longitude)) : DEFAULT_SETTINGS.weatherLocation.longitude,
  };
  settings.quickApps = Array.isArray(settings.quickApps) ? settings.quickApps.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.path === 'string').slice(0, 16).map((entry) => ({ id: safeString(entry.id, 80), title: safeString(entry.title, 60), path: safeString(entry.path, 1000) })) : [];
  const items = Array.isArray(saved && saved.items) ? saved.items : [];
  store = {
    version: STORE_VERSION,
    settings,
    items: items.filter((item) => item && typeof item.id === 'string' && typeof item.kind === 'string'),
    tasks: taskUtils.normalizeTasks(saved && saved.tasks),
    folders: Array.isArray(saved && saved.folders) ? [...new Set(saved.folders.map((name) => safeString(name, 60).trim()).filter(Boolean))].slice(0, 40) : [],
  };
  persistStore();
}

function persistStore() {
  try {
    const tmpPath = `${storePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf8');
    fs.renameSync(tmpPath, storePath);
  } catch (error) {
    console.error('[NOVA] Failed to save local data:', error);
  }
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function safeString(value, maxLength = 50000) {
  return String(value == null ? '' : value).replace(/\u0000/g, '').slice(0, maxLength);
}

function titleFromText(text) {
  const firstLine = String(text).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || 'Скопированный текст';
  return firstLine.length > 54 ? `${firstLine.slice(0, 51)}…` : firstLine;
}

function sortedItems() {
  return [...store.items].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

function publicItem(item) {
  const result = {
    id: item.id,
    kind: item.kind,
    title: item.title || 'Без названия',
    content: item.content || '',
    createdAt: item.createdAt,
    pinned: Boolean(item.pinned),
    source: item.source || 'manual',
    extension: item.extension || '',
    size: Number(item.size) || 0,
    mediaType: item.mediaType || '',
    folder: item.folder || '',
  };

  if (item.kind === 'media' && item.storedPath && isInsideLibrary(item.storedPath)) {
    result.mediaType = item.mediaType || 'audio';
    result.mediaUrl = pathToFileURL(item.storedPath).href;
  }

  if (item.kind === 'image' && item.storedPath) {
    try {
      const image = nativeImage.createFromPath(item.storedPath);
      if (!image.isEmpty()) {
        result.thumbnail = image.resize({ width: 92, height: 66, quality: 'good' }).toDataURL();
      }
    } catch {
      // A missing thumbnail should never prevent the rest of the island from rendering.
    }
  }
  return result;
}

function publicState() {
  const activeMedia = store.items.find((item) => item.id === store.settings.mediaPlayerItemId && item.kind === 'media') || null;
  return {
    appVersion: app.getVersion(),
    items: sortedItems().map(publicItem),
    activeMedia: activeMedia ? publicItem(activeMedia) : null,
    storage: getStorageStats(),
    tasks: (store.tasks || []).map((task) => ({ ...task })),
    settings: { ...store.settings, quickApps: store.settings.quickApps.map(({ id, title }) => ({ id, title })), weatherLocation: { ...store.settings.weatherLocation } },
    folders: [...store.folders],
    dashboard: { metrics: dashboardMetrics, weather: dashboardWeather },
    focusTimer: focusTimerSnapshot(),
    expanded,
  };
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('nova:state', publicState());
  }
  refreshTrayMenu();
}

function broadcastClipboardPulse(kind) {
  if (!store.settings.clipboardEnabled) return;
  clipboardPulseUntil = Date.now() + 1450;
  if (!expanded && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds(makeWindowBounds(false), false);
    applyWindowShape(false);
  }
  if (clipboardPulseTimer) clearTimeout(clipboardPulseTimer);
  clipboardPulseTimer = setTimeout(() => {
    clipboardPulseUntil = 0;
    clipboardPulseTimer = null;
    syncCollapsedBounds();
  }, 1500);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('nova:clipboard-pulse', { kind, at: Date.now() });
  }
}

function makeWindowBounds(isExpanded) {
  const legacyPosition = store.settings.expandedPosition;
  const saved = store.settings.windowPosition || (legacyPosition && Number.isFinite(Number(legacyPosition.x))
    ? { centerX: Number(legacyPosition.x) + 223, y: Number(legacyPosition.y) }
    : null);
  const hasSavedPosition = saved && Number.isFinite(Number(saved.centerX)) && Number.isFinite(Number(saved.y));
  const display = hasSavedPosition
    ? screen.getDisplayNearestPoint({ x: Number(saved.centerX), y: Number(saved.y) })
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const hasPinnedItems = store.items.some((item) => item.pinned);
  const hasActiveMedia = Boolean(store.settings.mediaPlayerItemId);
  const baseCollapsedWidth = hasPinnedItems || hasActiveMedia ? 356 : 332;
  const pulseWidth = clipboardPulseUntil > Date.now() ? 284 : 0;
  const collapsedWidth = Math.max(baseCollapsedWidth, pulseWidth);
  const width = Math.min(isExpanded ? 446 : collapsedWidth, Math.max(190, area.width - 8));
  const height = isExpanded
    ? Math.max(420, Math.min(666, area.height - 18))
    : 64;
  const finalHeight = Math.min(height, Math.max(70, area.height - 8));
  const desiredX = hasSavedPosition ? Number(saved.centerX) - width / 2 : area.x + (area.width - width) / 2;
  const desiredY = hasSavedPosition ? Number(saved.y) : area.y + 8;
  return {
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - width, desiredX))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - finalHeight, desiredY))),
    width,
    height: finalHeight,
  };
}

function roundedWindowShape(width, height, radius) {
  const r = Math.max(1, Math.min(Math.floor(radius), Math.floor(width / 2), Math.floor(height / 2)));
  const rects = [];
  let active = null;
  for (let y = 0; y < height; y += 1) {
    const distance = y < r ? r - y - 0.5 : (y >= height - r ? y - (height - r) + 0.5 : 0);
    const inset = distance > 0 ? Math.max(0, Math.ceil(r - Math.sqrt(Math.max(0, r * r - distance * distance)))) : 0;
    const x = inset;
    const rowWidth = Math.max(1, width - inset * 2);
    if (active && active.x === x && active.width === rowWidth && active.y + active.height === y) {
      active.height += 1;
    } else {
      active = { x, y, width: rowWidth, height: 1 };
      rects.push(active);
    }
  }
  return rects;
}

function applyWindowShape(isExpanded) {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed() || typeof mainWindow.setShape !== 'function') return;
  try {
    const bounds = mainWindow.getBounds();
    const radius = isExpanded ? 30 : Math.floor(Math.min(bounds.width, bounds.height) / 2);
    mainWindow.setShape(roundedWindowShape(bounds.width, bounds.height, radius));
  } catch (error) {
    console.warn('[NOVA] Could not apply the rounded Windows window region:', error.message);
  }
}

function syncCollapsedBounds() {
  if (!expanded && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds(makeWindowBounds(false), false);
    applyWindowShape(false);
  }
}

function updateFocusTimer(action, minutes = 25, mode = 'focus', taskId = '') {
  const timer = normalizeFocusTimer(store.settings.focusTimer);
  if (action === 'task') {
    const task = store.tasks.find((candidate) => candidate.id === String(taskId || '') && !candidate.completed);
    if (!task) return publicState();
    timer.mode = 'focus';
    timer.durationMinutes = 25;
    timer.durationMs = 25 * 60 * 1000;
    timer.remainingMs = timer.durationMs;
    timer.endsAt = Date.now() + timer.durationMs;
    timer.running = true;
    timer.taskId = task.id;
    timer.taskTitle = task.title;
  } else if (action === 'preset') {
    const durationMinutes = Math.min(180, Math.max(1, Math.round(Number(minutes) || 25)));
    timer.mode = mode === 'break' ? 'break' : 'focus';
    timer.durationMinutes = durationMinutes;
    timer.durationMs = durationMinutes * 60 * 1000;
    timer.remainingMs = timer.durationMs;
    timer.endsAt = 0;
    timer.running = false;
    timer.taskId = '';
    timer.taskTitle = '';
  } else if (action === 'reset') {
    timer.remainingMs = timer.durationMs;
    timer.endsAt = 0;
    timer.running = false;
    timer.taskId = '';
    timer.taskTitle = '';
  } else if (action === 'toggle' && timer.running) {
    timer.remainingMs = Math.max(0, timer.endsAt - Date.now());
    timer.endsAt = 0;
    timer.running = false;
  } else if (action === 'toggle') {
    if (timer.remainingMs <= 0) timer.remainingMs = timer.durationMs;
    timer.endsAt = Date.now() + timer.remainingMs;
    timer.running = true;
  }
  store.settings.focusTimer = timer;
  persistStore();
  syncCollapsedBounds();
  broadcastState();
  return publicState();
}

function tickFocusTimer() {
  const timer = store.settings.focusTimer;
  if (!timer || !timer.running) return;
  const snapshot = focusTimerSnapshot();
  if (snapshot.remainingMs <= 0) {
    timer.running = false;
    timer.remainingMs = 0;
    timer.endsAt = 0;
    persistStore();
    try {
      if (Notification.isSupported()) {
        const body = timer.mode === 'break'
          ? 'Перерыв закончен — возвращайся, когда будешь готов.'
          : (timer.taskTitle ? `Фокус на задаче «${timer.taskTitle}» завершён. Пора сделать короткий перерыв.` : 'Отличная работа. Пора сделать короткий перерыв.');
        new Notification({ title: 'NOVA · фокус завершён', body }).show();
      }
    } catch (error) {
      console.warn('[NOVA] Focus notification could not be shown:', error.message);
    }
    syncCollapsedBounds();
    broadcastState();
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('nova:focus-tick', snapshot);
  }
}

function applyMousePassthrough() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const ignore = Boolean(store.settings.clickThroughCollapsed && !expanded && !isGameHidden);
  try {
    mainWindow.setIgnoreMouseEvents(ignore);
  } catch (error) {
    console.warn('[NOVA] Click-through mode is unavailable:', error.message);
  }
}

function restoreAfterFullscreen() {
  isGameHidden = false;
  if (store.settings.rainEnabled) {
    for (const overlay of rainWindows.values()) if (!overlay.isDestroyed()) overlay.showInactive();
  }
  if (manuallyHidden || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBounds(makeWindowBounds(false), false);
  applyWindowShape(false);
  mainWindow.setAlwaysOnTop(Boolean(store.settings.alwaysOnTop));
  mainWindow.showInactive();
  if (store.settings.alwaysOnTop) mainWindow.moveTop();
  applyMousePassthrough();
}

async function pollFullscreenApplication() {
  if (!store.settings.gameMode || process.platform !== 'win32' || fullscreenProbeRunning || !mainWindow || mainWindow.isDestroyed()) return;
  fullscreenProbeRunning = true;
  try {
    const result = await systemServices.isExternalFullscreen(screen.getAllDisplays(), process.pid);
    if (!result.supported) return;
    if (result.fullscreen && !isGameHidden) {
      if (expanded) setExpanded(false, false);
      isGameHidden = true;
      mainWindow.hide();
      for (const overlay of rainWindows.values()) if (!overlay.isDestroyed()) overlay.hide();
    } else if (!result.fullscreen && isGameHidden) {
      restoreAfterFullscreen();
    }
  } catch (error) {
    console.warn('[NOVA] Full-screen detection failed:', error.message);
  } finally {
    fullscreenProbeRunning = false;
  }
}

function configureFullscreenWatcher() {
  if (fullscreenTimer) {
    clearInterval(fullscreenTimer);
    fullscreenTimer = null;
  }
  if (store.settings.gameMode && process.platform === 'win32') {
    pollFullscreenApplication();
    fullscreenTimer = setInterval(pollFullscreenApplication, 2500);
  } else if (isGameHidden) {
    restoreAfterFullscreen();
  }
}

function setClickThrough(enabled) {
  store.settings.clickThroughCollapsed = Boolean(enabled);
  persistStore();
  applyMousePassthrough();
  broadcastState();
  return publicState();
}

function setGameMode(enabled) {
  store.settings.gameMode = Boolean(enabled);
  persistStore();
  configureFullscreenWatcher();
  broadcastState();
  return publicState();
}

function setVolumeWheelEnabled(enabled) {
  store.settings.volumeWheelEnabled = Boolean(enabled);
  persistStore();
  broadcastState();
  return publicState();
}

function setExpanded(nextValue, shouldFocus = true) {
  const next = Boolean(nextValue);
  if (next && store.settings.gameMode && isGameHidden) return;
  if (next) manuallyHidden = false;
  expanded = next;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }

  if (next) {
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.setBounds(makeWindowBounds(true), false);
    applyWindowShape(true);
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.setAlwaysOnTop(Boolean(store.settings.alwaysOnTop));
    if (store.settings.alwaysOnTop) mainWindow.moveTop();
    if (shouldFocus) mainWindow.focus();
    if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('nova:expanded', true);
    }
  } else {
    mainWindow.setIgnoreMouseEvents(false);
    if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('nova:expanded', false);
    }
    // Let the CSS pill animation finish before shrinking the transparent native window.
    collapseTimer = setTimeout(() => {
      if (!expanded && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBounds(makeWindowBounds(false), false);
        applyWindowShape(false);
        applyMousePassthrough();
      }
    }, 650);
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: 'Открыть NOVA',
      click: () => setExpanded(true),
    },
    {
      label: 'Свернуть остров',
      click: () => setExpanded(false),
    },
    { type: 'separator' },
    {
      label: 'Записывать буфер обмена',
      type: 'checkbox',
      checked: Boolean(store.settings.clipboardEnabled),
      click: (menuItem) => setClipboardEnabled(menuItem.checked),
    },
    {
      label: 'Сквозные клики в свёрнутом виде',
      type: 'checkbox',
      checked: Boolean(store.settings.clickThroughCollapsed),
      click: (menuItem) => setClickThrough(menuItem.checked),
    },
    {
      label: 'Игровой режим: скрывать в полноэкранном приложении',
      type: 'checkbox',
      checked: Boolean(store.settings.gameMode),
      click: (menuItem) => setGameMode(menuItem.checked),
    },
    {
      label: 'Открыть локальное хранилище',
      click: () => shell.openPath(libraryPath),
    },
    { type: 'separator' },
    {
      label: 'Выход',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function refreshTrayMenu() {
  updateTrayMenu();
}

function createTray() {
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
    tray.setToolTip('NOVA Island — всё под рукой');
    tray.on('click', () => setExpanded(!expanded));
    tray.on('double-click', () => setExpanded(true));
    updateTrayMenu();
  } catch (error) {
    console.error('[NOVA] Tray icon could not be created:', error);
  }
}

async function updateRainWindowSurfaces() {
  if (process.platform !== 'win32' || !store.settings.rainEnabled || rainSurfaceProbeRunning || rainWindows.size === 0) return;
  rainSurfaceProbeRunning = true;
  try {
    const displays = screen.getAllDisplays();
    const bounds = {
      x: Math.min(...displays.map((display) => display.bounds.x)),
      y: Math.min(...displays.map((display) => display.bounds.y)),
      right: Math.max(...displays.map((display) => display.bounds.x + display.bounds.width)),
      bottom: Math.max(...displays.map((display) => display.bounds.y + display.bounds.height)),
    };
    bounds.width = bounds.right - bounds.x; bounds.height = bounds.bottom - bounds.y;
    const result = await systemServices.getRainWindowSurfaces(process.pid, bounds);
    if (!result || !Array.isArray(result.surfaces)) return;
    for (const display of displays) {
      const overlay = rainWindows.get(display.id);
      if (!overlay || overlay.isDestroyed() || overlay.webContents.isLoading()) continue;
      const localSurfaces = result.surfaces.flatMap((surface) => {
        const left = Math.max(surface.x + bounds.x, display.bounds.x);
        const top = surface.y + bounds.y;
        const right = Math.min(surface.x + bounds.x + surface.width, display.bounds.x + display.bounds.width);
        if (right - left < 1 || top < display.bounds.y || top >= display.bounds.y + display.bounds.height) return [];
        return [{ ...surface, x:left - display.bounds.x, y:top - display.bounds.y, width:right-left }];
      });
      overlay.webContents.send('nova:rain-surfaces', localSurfaces);
    }
  } catch (error) {
    console.warn('[NOVA] Rain window surface scan failed:', error.message);
  } finally { rainSurfaceProbeRunning = false; }
}

function configureRainSurfacePolling() {
  if (rainSurfaceTimer) { clearInterval(rainSurfaceTimer); rainSurfaceTimer = null; }
  if (process.platform === 'win32' && store.settings.rainEnabled) {
    updateRainWindowSurfaces();
    rainSurfaceTimer = setInterval(updateRainWindowSurfaces, 1800);
  }
}

function createRainOverlay(display) {
  const displayId = display.id;
  const bounds = { ...display.bounds };
  const overlay = new BrowserWindow({
    ...bounds,
    title: `NOVA Rain ${displayId}`, frame: false, transparent: true, backgroundColor: '#00000000',
    hasShadow: false, resizable: false, movable: false, minimizable: false,
    maximizable: false, fullscreenable: false, focusable: false, skipTaskbar: true,
    show: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'rain-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  rainWindows.set(displayId, overlay);
  overlay.setMenu(null);
  overlay.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating');
  overlay.setIgnoreMouseEvents(true);
  try { overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* Not supported on every platform. */ }
  overlay.loadFile(path.join(__dirname, 'rain.html'), { query: { intensity: store.settings.rainIntensity } });
  overlay.once('ready-to-show', () => {
    if (rainWindows.get(displayId) === overlay && !overlay.isDestroyed() && !isGameHidden) overlay.showInactive();
  });
  overlay.on('closed', () => {
    if (rainWindows.get(displayId) === overlay) rainWindows.delete(displayId);
  });
}

function syncRainOverlay() {
  const enabled = Boolean(store.settings.rainEnabled);
  configureRainSurfacePolling();
  if (!enabled) {
    for (const overlay of rainWindows.values()) if (!overlay.isDestroyed()) overlay.destroy();
    rainWindows.clear();
    return;
  }
  const displays = screen.getAllDisplays();
  const liveIds = new Set(displays.map((display) => display.id));
  for (const [displayId, overlay] of rainWindows.entries()) {
    if (!liveIds.has(displayId) || overlay.isDestroyed()) {
      if (!overlay.isDestroyed()) overlay.destroy();
      rainWindows.delete(displayId);
    }
  }
  for (const display of displays) {
    const overlay = rainWindows.get(display.id);
    if (overlay && !overlay.isDestroyed()) {
      overlay.setBounds({ ...display.bounds }, false);
      if (!overlay.webContents.isLoading()) overlay.webContents.send('nova:rain-intensity', store.settings.rainIntensity);
      if (!isGameHidden && !overlay.isVisible()) overlay.showInactive();
    } else {
      createRainOverlay(display);
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...makeWindowBounds(false),
    title: PRODUCT_NAME,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    ...(process.platform === 'win32' ? { thickFrame: false, roundedCorners: true } : {}),
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: Boolean(store.settings.alwaysOnTop),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.setAlwaysOnTop(Boolean(store.settings.alwaysOnTop));
  mainWindow.setBackgroundColor('#00000000');
  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setBounds(makeWindowBounds(false), false);
    applyWindowShape(false);
    mainWindow.show();
    applyMousePassthrough();
  });

  mainWindow.on('move', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { x, y, width } = mainWindow.getBounds();
    store.settings.windowPosition = { centerX: x + width / 2, y };
    store.settings.expandedPosition = { x, y };
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(() => { positionSaveTimer = null; persistStore(); }, 250);
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      manuallyHidden = true;
      setExpanded(false);
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function sanitizeFileName(fileName) {
  const base = path.basename(String(fileName || 'file'));
  return base.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/[. ]+$/g, '').slice(0, 160) || 'file';
}

function isInsideLibrary(filePath) {
  const relative = path.relative(libraryPath, path.resolve(filePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function getStorageStats() {
  const tracked = new Set(store.items.filter((item) => item.storedPath && isInsideLibrary(item.storedPath)).map((item) => path.resolve(item.storedPath)));
  const stats = { fileCount: 0, totalBytes: 0, orphanedFiles: 0 };
  if (!libraryPath) return stats;
  try {
    for (const entry of fs.readdirSync(libraryPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(libraryPath, entry.name);
      try {
        const fileStat = fs.statSync(filePath);
        stats.totalBytes += fileStat.size;
        if (tracked.has(path.resolve(filePath))) stats.fileCount += 1;
        else stats.orphanedFiles += 1;
      } catch {
        // Ignore files that disappear while the folder is being measured.
      }
    }
  } catch (error) {
    console.warn('[NOVA] Could not inspect the local library:', error.message);
  }
  return stats;
}

async function cleanOrphanedFiles() {
  const tracked = new Set(store.items.filter((item) => item.storedPath && isInsideLibrary(item.storedPath)).map((item) => path.resolve(item.storedPath)));
  let removed = 0;
  try {
    for (const entry of await fs.promises.readdir(libraryPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(libraryPath, entry.name);
      if (tracked.has(path.resolve(filePath))) continue;
      try {
        await fs.promises.unlink(filePath);
        removed += 1;
      } catch (error) {
        console.warn('[NOVA] Could not remove orphaned file:', error.message);
      }
    }
  } catch (error) {
    console.warn('[NOVA] Could not clean orphaned library files:', error.message);
  }
  persistStore();
  broadcastState();
  return { removed, state: publicState() };
}

async function importFile(sourcePath, source = 'drop') {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
    throw new Error('Путь к файлу недоступен. Добавьте файл через кнопку «Файл».');
  }
  const sourceStat = await fs.promises.stat(sourcePath);
  if (!sourceStat.isFile()) return null;

  const originalName = sanitizeFileName(path.basename(sourcePath));
  const parsed = path.parse(originalName);
  const extension = (parsed.ext || '').replace('.', '').toUpperCase().slice(0, 12);
  const safeStem = (parsed.name || 'file').slice(0, 100);
  const uniqueName = `${safeStem}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${parsed.ext}`;
  const storedPath = path.join(libraryPath, uniqueName);
  await fs.promises.copyFile(sourcePath, storedPath);

  const imageExts = new Set(['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'BMP', 'TIFF', 'TIF']);
  const mediaType = MEDIA_TYPE_BY_EXTENSION[extension] || '';
  const item = {
    id: makeId(),
    kind: imageExts.has(extension) ? 'image' : (mediaType ? 'media' : 'file'),
    mediaType,
    title: originalName,
    source,
    createdAt: new Date().toISOString(),
    pinned: false,
    extension: extension || 'FILE',
    size: sourceStat.size,
    storedPath,
    content: '',
  };
  store.items.unshift(item);
  trimStore();
  persistStore();
  broadcastState();
  return item;
}

function addTextItem(kind, title, content, source = 'manual') {
  if (kind !== 'note' && kind !== 'text') return null;
  const cleanContent = safeString(content, 50000).trim();
  if (!cleanContent) return null;
  const cleanTitle = safeString(title, 120).trim() || (kind === 'note' ? 'Новая заметка' : titleFromText(cleanContent));
  const item = {
    id: makeId(),
    kind,
    title: cleanTitle,
    content: cleanContent,
    source,
    createdAt: new Date().toISOString(),
    pinned: false,
    extension: '',
    size: Buffer.byteLength(cleanContent, 'utf8'),
  };
  store.items.unshift(item);
  trimStore();
  persistStore();
  broadcastState();
  return item;
}

function addClipboardText(text) {
  const cleanText = safeString(text, 50000).trim();
  if (!cleanText) return;
  const item = {
    id: makeId(),
    kind: 'text',
    title: titleFromText(cleanText),
    content: cleanText,
    source: 'clipboard',
    createdAt: new Date().toISOString(),
    pinned: false,
    extension: '',
    size: Buffer.byteLength(cleanText, 'utf8'),
  };
  store.items.unshift(item);
  trimStore();
  persistStore();
  broadcastState();
}

async function addClipboardImage(image) {
  try {
    const buffer = image.toPNG();
    if (!buffer || buffer.length === 0) return;
    const fileName = `clipboard-image-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`;
    const storedPath = path.join(libraryPath, fileName);
    await fs.promises.writeFile(storedPath, buffer);
    const item = {
      id: makeId(),
      kind: 'image',
      title: 'Скопированное изображение',
      content: '',
      source: 'clipboard',
      createdAt: new Date().toISOString(),
      pinned: false,
      extension: 'PNG',
      size: buffer.length,
      storedPath,
    };
    store.items.unshift(item);
    trimStore();
    persistStore();
    broadcastState();
  } catch (error) {
    console.error('[NOVA] Could not save clipboard image:', error);
  }
}

function trimStore() {
  if (store.items.length <= MAX_ITEMS) return;
  const removable = [...store.items]
    .filter((item) => !item.pinned)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const toRemove = store.items.length - MAX_ITEMS;
  for (const item of removable.slice(0, toRemove)) {
    store.items = store.items.filter((candidate) => candidate.id !== item.id);
    if (store.settings.mediaPlayerItemId === item.id) store.settings.mediaPlayerItemId = '';
    if (item.storedPath && isInsideLibrary(item.storedPath)) {
      fs.promises.unlink(item.storedPath).catch(() => {});
    }
  }
}

function clipboardUriListToPaths(value) {
  const paths = [];
  for (const line of String(value || '').split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) continue;
    try {
      const parsed = new URL(entry);
      if (parsed.protocol === 'file:') paths.push(fileURLToPath(parsed));
    } catch {
      // Ignore non-file or malformed clipboard entries.
    }
  }
  return [...new Set(paths)];
}

async function readClipboardSnapshot() {
  const snapshot = { text: '', filePaths: [], uriKey: '', image: null, imageHash: '' };
  const items = await clipboard.read();
  if (!Array.isArray(items)) return snapshot;

  for (const clipboardItem of items) {
    const types = Array.isArray(clipboardItem.types) ? clipboardItem.types : [];

    if (types.includes('text/uri-list')) {
      try {
        const uriBlob = await clipboardItem.getType('text/uri-list');
        snapshot.filePaths.push(...clipboardUriListToPaths(await uriBlob.text()));
      } catch {
        // Some applications advertise a URI list but do not provide a readable payload.
      }
    }

    if (!snapshot.text && types.includes('text/plain')) {
      try {
        const textBlob = await clipboardItem.getType('text/plain');
        snapshot.text = await textBlob.text();
      } catch {
        // Plain-text data is optional.
      }
    }

    if (!snapshot.image) {
      const imageType = types.find((type) => /^image\/(png|jpeg|webp|bmp|gif)$/i.test(type));
      if (imageType) {
        try {
          const imageBlob = await clipboardItem.getType(imageType);
          const imageBuffer = Buffer.from(await imageBlob.arrayBuffer());
          const image = nativeImage.createFromBuffer(imageBuffer);
          if (!image.isEmpty()) {
            const png = image.toPNG();
            snapshot.image = image;
            snapshot.imageHash = crypto.createHash('sha1').update(png).digest('hex');
          }
        } catch {
          // Ignore image types that Electron or the OS cannot decode.
        }
      }
    }
  }

  snapshot.filePaths = [...new Set(snapshot.filePaths)];
  snapshot.uriKey = snapshot.filePaths.map((filePath) => path.resolve(filePath)).sort().join('\n');
  return snapshot;
}

function applyClipboardBaseline(snapshot) {
  lastClipboardText = snapshot.text || '';
  lastClipboardUriKey = snapshot.uriKey || '';
  lastClipboardImageHash = snapshot.imageHash || '';
}

async function primeClipboardBaseline() {
  try {
    applyClipboardBaseline(await readClipboardSnapshot());
  } catch {
    lastClipboardText = '';
    lastClipboardUriKey = '';
    lastClipboardImageHash = '';
  }
}

async function pollClipboard() {
  if (isPollingClipboard) return;
  isPollingClipboard = true;
  try {
    const snapshot = await readClipboardSnapshot();

    if (!store.settings.clipboardEnabled) {
      applyClipboardBaseline(snapshot);
      return;
    }

    let pulseKind = '';
    if (snapshot.uriKey && snapshot.uriKey !== lastClipboardUriKey) {
      lastClipboardUriKey = snapshot.uriKey;
      for (const filePath of snapshot.filePaths.slice(0, 30)) {
        try {
          const imported = await importFile(filePath, 'clipboard');
          if (imported) pulseKind = 'file';
        } catch (error) {
          console.warn('[NOVA] Clipboard file could not be saved:', error.message);
        }
      }
    } else if (!snapshot.uriKey) {
      lastClipboardUriKey = '';
    }

    if (snapshot.text !== lastClipboardText) {
      lastClipboardText = snapshot.text;
      // File copies sometimes also expose their names as text; keep them as file cards instead.
      if (!snapshot.uriKey && snapshot.text.trim()) {
        addClipboardText(snapshot.text);
        pulseKind = /^https?:\/\//i.test(snapshot.text.trim()) ? 'link' : 'text';
      }
    }

    if (snapshot.imageHash && snapshot.imageHash !== lastClipboardImageHash) {
      lastClipboardImageHash = snapshot.imageHash;
      await addClipboardImage(snapshot.image);
      pulseKind = 'image';
    } else if (!snapshot.imageHash) {
      lastClipboardImageHash = '';
    }

    if (pulseKind) broadcastClipboardPulse(pulseKind);
  } catch (error) {
    console.error('[NOVA] Clipboard polling failed:', error);
  } finally {
    isPollingClipboard = false;
  }
}

async function setClipboardEnabled(enabled) {
  store.settings.clipboardEnabled = Boolean(enabled);
  await primeClipboardBaseline();
  persistStore();
  broadcastState();
  return publicState();
}

function activateMedia(id) {
  const item = store.items.find((candidate) => candidate.id === id && candidate.kind === 'media');
  if (!item) return { ok: false, message: 'Медиафайл не найден', state: publicState() };
  item.pinned = true;
  store.settings.mediaPlayerItemId = item.id;
  persistStore();
  broadcastState();
  return { ok: true, message: 'Медиаплеер закреплён', state: publicState() };
}

function closeActiveMedia() {
  store.settings.mediaPlayerItemId = '';
  persistStore();
  syncCollapsedBounds();
  broadcastState();
  return publicState();
}

function setAlwaysOnTop(enabled) {
  store.settings.alwaysOnTop = Boolean(enabled);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(store.settings.alwaysOnTop);
    if (store.settings.alwaysOnTop && mainWindow.isVisible()) mainWindow.moveTop();
  }
  persistStore();
  broadcastState();
  return publicState();
}

async function copyItemToClipboard(item) {
  if (!item) return { ok: false, message: 'Элемент не найден' };
  try {
    if (item.kind === 'image' && item.storedPath) {
      const image = nativeImage.createFromPath(item.storedPath);
      if (image.isEmpty()) return { ok: false, message: 'Не удалось открыть изображение' };
      const png = image.toPNG();
      await clipboard.write([new ClipboardItem({
        'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }),
      })]);
      lastClipboardImageHash = crypto.createHash('sha1').update(png).digest('hex');
      lastClipboardText = '';
      lastClipboardUriKey = '';
      broadcastClipboardPulse('image');
      return { ok: true, message: 'Изображение скопировано' };
    }

    if ((item.kind === 'file' || item.kind === 'media') && item.storedPath) {
      const uri = pathToFileURL(item.storedPath).href;
      await clipboard.write([new ClipboardItem({ 'text/uri-list': uri })]);
      lastClipboardUriKey = path.resolve(item.storedPath);
      lastClipboardText = '';
      lastClipboardImageHash = '';
      broadcastClipboardPulse('file');
      return { ok: true, message: 'Файл скопирован — его можно вставить в другое окно' };
    }

    await clipboard.writeText(item.content || '');
    lastClipboardText = item.content || '';
    lastClipboardUriKey = '';
    lastClipboardImageHash = '';
    broadcastClipboardPulse(/^https?:\/\//i.test(lastClipboardText.trim()) ? 'link' : 'text');
    return { ok: true, message: 'Текст скопирован' };
  } catch (error) {
    console.error('[NOVA] Clipboard write failed:', error);
    return { ok: false, message: 'Не удалось скопировать' };
  }
}

async function exportBackup() {
  try {
    const backupItems = [];
    let totalBytes = 0;
    for (const item of store.items) {
      const backupItem = {
        id: item.id,
        kind: item.kind,
        title: item.title || 'Без названия',
        content: item.content || '',
        createdAt: item.createdAt || new Date().toISOString(),
        pinned: Boolean(item.pinned),
        source: item.source || 'manual',
        extension: item.extension || '',
        size: Number(item.size) || 0,
        mediaType: item.mediaType || '',
        folder: item.folder || '',
      };
      if (item.storedPath && isInsideLibrary(item.storedPath)) {
        const stat = await fs.promises.stat(item.storedPath);
        if (totalBytes + stat.size > MAX_BACKUP_BYTES) {
          return { ok: false, message: 'Экспорт отменён: вложения в резервной копии превышают 128 МБ.' };
        }
        const bytes = await fs.promises.readFile(item.storedPath);
        totalBytes += bytes.length;
        backupItem.blob = { name: path.basename(item.storedPath), data: bytes.toString('base64') };
      }
      backupItems.push(backupItem);
    }

    const defaultName = `NOVA-backup-${new Date().toISOString().slice(0, 10)}.nova.json`;
    const options = {
      title: 'Экспорт резервной копии NOVA',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: [{ name: 'Резервная копия NOVA', extensions: ['json'] }],
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, message: 'Экспорт отменён.' };
    const backup = {
      format: 'nova-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: { mediaPlayerItemId: store.settings.mediaPlayerItemId || '' },
      items: backupItems,
      tasks: store.tasks.map((task) => ({ ...task })),
      folders: [...store.folders],
    };
    await fs.promises.writeFile(result.filePath, JSON.stringify(backup), 'utf8');
    return { ok: true, message: `Резервная копия создана: ${backupItems.length} элементов и ${store.tasks.length} задач.` };
  } catch (error) {
    console.error('[NOVA] Backup export failed:', error);
    return { ok: false, message: 'Не удалось создать резервную копию.' };
  }
}

async function importBackup() {
  let createdFiles = [];
  try {
    const options = {
      title: 'Импорт резервной копии NOVA',
      properties: ['openFile'],
      filters: [{ name: 'Резервная копия NOVA', extensions: ['json'] }],
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) return { ok: false, message: 'Импорт отменён.' };
    const backupPath = result.filePaths[0];
    const stat = await fs.promises.stat(backupPath);
    if (stat.size > MAX_BACKUP_FILE_BYTES) return { ok: false, message: 'Файл резервной копии слишком большой (лимит 180 МБ).' };
    const backup = JSON.parse(await fs.promises.readFile(backupPath, 'utf8'));
    if (!backup || backup.format !== 'nova-backup' || backup.version !== 1 || !Array.isArray(backup.items)) {
      return { ok: false, message: 'Это не резервная копия NOVA.' };
    }
    if (backup.items.length > MAX_ITEMS * 4) return { ok: false, message: 'В резервной копии слишком много элементов.' };

    const allowedKinds = new Set(['file', 'image', 'media', 'note', 'text']);
    const backupFolders = [...new Set([...store.folders, ...(Array.isArray(backup.folders) ? backup.folders : []).map((name) => safeString(name, 60).trim()).filter((name) => name && !/[\\/]/.test(name))])].slice(0, 40);
    const existingTaskKeys = new Set(store.tasks.map((task) => `${task.title.toLocaleLowerCase('ru-RU')}\u0000${task.dueDate || ''}`));
    const importedTasks = [];
    let skippedTasks = 0;
    for (const record of (Array.isArray(backup.tasks) ? backup.tasks.slice(0, MAX_TASKS * 4) : [])) {
      const task = taskUtils.normalizeTask(record);
      if (!task) { skippedTasks += 1; continue; }
      const key = `${task.title.toLocaleLowerCase('ru-RU')}\u0000${task.dueDate || ''}`;
      if (existingTaskKeys.has(key) || store.tasks.length + importedTasks.length >= MAX_TASKS) { skippedTasks += 1; continue; }
      existingTaskKeys.add(key);
      importedTasks.push({ ...task, id: makeId() });
    }
    const prepared = [];
    const existingKeys = new Set(store.items.map((item) => `${item.kind}\u0000${item.title || ''}\u0000${item.content || ''}\u0000${Number(item.size) || 0}`));
    let totalBytes = 0;
    let skipped = 0;
    for (const record of backup.items.slice(0, MAX_ITEMS * 4)) {
      if (!record || !allowedKinds.has(record.kind)) { skipped += 1; continue; }
      const title = safeString(record.title || 'Импортированный элемент', 120);
      const content = safeString(record.content || '');
      let bytes = null;
      let fileName = '';
      let dedupeKey = `${record.kind}\u0000${title}\u0000${content}\u0000${Number(record.size) || 0}`;
      if (record.blob && typeof record.blob.data === 'string') {
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.blob.data)) { skipped += 1; continue; }
        bytes = Buffer.from(record.blob.data, 'base64');
        totalBytes += bytes.length;
        if (totalBytes > MAX_BACKUP_BYTES) return { ok: false, message: 'Импорт отменён: вложения превышают лимит 128 МБ.' };
        fileName = sanitizeFileName(record.blob.name || title || 'file');
        dedupeKey = `${record.kind}\u0000${title}\u0000\u0000${bytes.length}`;
      } else if (['file', 'image', 'media'].includes(record.kind)) {
        skipped += 1;
        continue;
      }
      if (existingKeys.has(dedupeKey)) { skipped += 1; continue; }
      existingKeys.add(dedupeKey);
      const createdAt = Number.isNaN(new Date(record.createdAt).getTime()) ? new Date().toISOString() : new Date(record.createdAt).toISOString();
      prepared.push({ record, title, content, bytes, fileName, createdAt });
    }

    const room = Math.max(0, MAX_ITEMS - store.items.length);
    const imports = prepared.slice(0, room);
    if (!imports.length && !importedTasks.length && prepared.length && !room) {
      return { ok: false, message: 'Хранилище заполнено. Удали несколько элементов и повтори импорт.' };
    }
    const idMap = new Map();
    const importedItems = [];
    for (const entry of imports) {
      const id = makeId();
      const item = {
        id,
        kind: entry.record.kind,
        title: entry.title || 'Импортированный элемент',
        content: entry.content,
        createdAt: entry.createdAt,
        pinned: Boolean(entry.record.pinned),
        source: 'import',
        extension: safeString(entry.record.extension || '', 12).toUpperCase(),
        size: Number(entry.record.size) || 0,
        mediaType: entry.record.mediaType === 'video' ? 'video' : (entry.record.mediaType === 'audio' ? 'audio' : ''),
        folder: backupFolders.includes(safeString(entry.record.folder || '', 60)) ? safeString(entry.record.folder || '', 60) : '',
      };
      if (entry.bytes) {
        const targetPath = path.join(libraryPath, `${id}-${entry.fileName}`);
        await fs.promises.writeFile(targetPath, entry.bytes, { flag: 'wx' });
        createdFiles.push(targetPath);
        item.storedPath = targetPath;
        item.size = entry.bytes.length;
      }
      if (typeof entry.record.id === 'string') idMap.set(entry.record.id, id);
      importedItems.push(item);
    }

    store.items = [...importedItems, ...store.items].slice(0, MAX_ITEMS);
    store.tasks = [...importedTasks, ...store.tasks].slice(0, MAX_TASKS);
    store.folders = backupFolders;
    const previousActiveId = store.settings.mediaPlayerItemId;
    const restoredActiveId = backup.settings && idMap.get(backup.settings.mediaPlayerItemId);
    if (!previousActiveId && restoredActiveId) store.settings.mediaPlayerItemId = restoredActiveId;
    persistStore();
    syncCollapsedBounds();
    broadcastState();
    const omitted = skipped + skippedTasks + Math.max(0, prepared.length - imports.length);
    return { ok: true, message: `Импортировано: ${importedItems.length} элементов и ${importedTasks.length} задач${omitted ? ` · пропущено: ${omitted}` : ''}. Текущие данные сохранены.` };
  } catch (error) {
    await Promise.all(createdFiles.map((filePath) => fs.promises.unlink(filePath).catch(() => {})));
    console.error('[NOVA] Backup import failed:', error);
    return { ok: false, message: 'Не удалось прочитать или восстановить резервную копию.' };
  }
}

async function confirmQuickAction(title, message) {
  const options = {
    type: 'warning',
    title: `NOVA · ${title}`,
    message,
    buttons: ['Отмена', 'Продолжить'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

async function runSystemQuickAction(action) {
  if (action === 'terminal') return systemServices.openTerminal();
  if (action === 'restart-explorer') {
    if (process.platform !== 'win32') return { ok: false, message: 'Перезапуск Проводника доступен только в Windows.' };
    const confirmed = await confirmQuickAction('Перезапустить Проводник?', 'Панель задач и окна Проводника перезапустятся. Несохранённые операции с файлами могут быть прерваны.');
    return confirmed ? systemServices.restartExplorer() : { ok: false, cancelled: true, message: 'Действие отменено.' };
  }
  if (action === 'clear-user-temp') {
    const confirmed = await confirmQuickAction('Очистить временные файлы?', 'Будут удалены только обычные файлы старше 7 дней из верхнего уровня пользовательской TEMP-папки. Системные папки и вложенные каталоги не затрагиваются.');
    return confirmed ? systemServices.clearOldUserTempFiles() : { ok: false, cancelled: true, message: 'Действие отменено.' };
  }
  return { ok: false, message: 'Такого системного действия нет.' };
}

function addTask(data) {
  if (store.tasks.length >= MAX_TASKS) return { ok: false, message: `Можно хранить не больше ${MAX_TASKS} задач.`, state: publicState() };
  const record = data && typeof data === 'object' ? data : {};
  const task = taskUtils.createTask(record.title, record.dueDate, makeId());
  if (!task) return { ok: false, message: 'Проверь название и срок задачи.', state: publicState() };
  store.tasks.unshift(task);
  persistStore();
  broadcastState();
  return { ok: true, message: 'Задача добавлена в план.', state: publicState() };
}

function toggleTask(id) {
  const result = taskUtils.toggleTask(store.tasks, id);
  if (!result.changed) return publicState();
  store.tasks = result.tasks;
  persistStore();
  broadcastState();
  return publicState();
}

function deleteTask(id) {
  const targetId = String(id || '');
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((task) => task.id !== targetId);
  if (store.tasks.length === before) return publicState();
  const timer = store.settings.focusTimer;
  if (timer && timer.taskId === targetId) {
    timer.taskId = '';
    timer.taskTitle = '';
  }
  persistStore();
  broadcastState();
  return publicState();
}

async function setMicMonitoringEnabled(enabled) {
  store.settings.micMonitoringEnabled = Boolean(enabled);
  persistStore();
  broadcastState();
  return publicState();
}

function weatherCodeLabel(code) {
  const labels = { clear: 'Ясно', clearsky: 'Ясно', fair: 'Переменная облачность', partlycloudy: 'Облачно с прояснениями', cloudy: 'Облачно', fog: 'Туман', lightrain: 'Небольшой дождь', rain: 'Дождь', rainshowers: 'Ливневый дождь', heavyrainshowers: 'Сильный ливень', heavyrain: 'Сильный дождь', lightsnow: 'Небольшой снег', lightsnowshowers: 'Небольшой снег', snowshowers: 'Снегопад', snow: 'Снег', heavysnow: 'Сильный снег', sleet: 'Мокрый снег', rainandthunder: 'Дождь с грозой', thunderstorm: 'Гроза' };
  const token = String(code || '').toLowerCase().replace(/_(day|night|polartwilight)$/, '');
  return labels[token] || 'Погода';
}

async function searchWeatherCity(query) {
  const city = safeString(query, 80).trim();
  if (city.length < 2) return { ok: false, message: 'Укажи название города.' };
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5&language=ru&format=json`;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'NOVA-Island/1.7 (https://github.com/smells1k/nova-island)' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Weather search returned ${response.status}`);
    const payload = await response.json();
    const result = Array.isArray(payload.results) ? payload.results[0] : null;
    if (!result || !Number.isFinite(Number(result.latitude)) || !Number.isFinite(Number(result.longitude))) return { ok: false, message: 'Город не найден. Попробуй уточнить название.' };
    const name = [result.name, result.admin1 && result.admin1 !== result.name ? result.admin1 : '', result.country].filter(Boolean).join(', ');
    store.settings.weatherLocation = { name: safeString(name, 60), latitude: Number(result.latitude), longitude: Number(result.longitude) };
    persistStore();
    await refreshDashboardWeather();
    return { ok: true, state: publicState() };
  } catch (error) {
    return { ok: false, message: `Не удалось найти город: ${safeString(error && error.message, 100)}` };
  }
}

async function refreshDashboardWeather() {
  const place = store.settings.weatherLocation;
  try {
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${encodeURIComponent(place.latitude)}&lon=${encodeURIComponent(place.longitude)}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'NOVA-Island/1.7 (https://github.com/smells1k/nova-island)' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Weather service returned ${response.status}`);
    const payload = await response.json();
    const now = payload && payload.properties && payload.properties.timeseries && payload.properties.timeseries[0];
    const instant = now && now.data && now.data.instant && now.data.instant.details || {};
    const next = now && now.data || {};
    const symbol = next.next_1_hours && next.next_1_hours.summary && next.next_1_hours.summary.symbol_code
      || next.next_6_hours && next.next_6_hours.summary && next.next_6_hours.summary.symbol_code || '';
    dashboardWeather = {
      ok: Number.isFinite(Number(instant.air_temperature)),
      temperatureC: Number.isFinite(Number(instant.air_temperature)) ? Math.round(Number(instant.air_temperature)) : null,
      description: weatherCodeLabel(symbol), symbol: String(symbol),
      windSpeed: Number.isFinite(Number(instant.wind_speed)) ? Math.round(Number(instant.wind_speed)) : null,
      precipitationMm: Number(next.next_1_hours && next.next_1_hours.details && next.next_1_hours.details.precipitation_amount) || 0,
      location: place.name, sampledAt: Date.now(),
    };
  } catch (error) {
    dashboardWeather = { ok: false, temperatureC: null, description: 'Погода недоступна', location: place.name, message: safeString(error && error.message, 120), sampledAt: Date.now() };
  }
  broadcastState();
  return dashboardWeather;
}

async function refreshDashboardMetrics() {
  try { dashboardMetrics = await systemServices.getMachineSnapshot(); }
  catch (error) { dashboardMetrics = { ok: false, message: safeString(error && error.message, 120) }; }
  broadcastState();
}

async function captureScreenSources() {
  const wasVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  const wasExpanded = expanded;
  const visibleRain = [...rainWindows.values()].filter((window) => window && !window.isDestroyed() && window.isVisible());
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  for (const window of visibleRain) window.hide();
  await new Promise((resolve) => setTimeout(resolve, 220));
  try {
    const displays = screen.getAllDisplays();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 2560, height: 1600 }, fetchWindowIcons: false });
    return sources.slice(0, 8).map((source, index) => {
      const display = displays.find((candidate) => String(candidate.id) === String(source.display_id)) || displays[index] || displays[0];
      return { id: source.id, name: source.name, displayId: source.display_id, width: source.thumbnail.getSize().width, height: source.thumbnail.getSize().height, image: source.thumbnail.toDataURL(), displayName: display ? `Экран ${displays.indexOf(display) + 1}` : source.name };
    }).filter((source) => source.width > 0 && source.height > 0);
  } finally {
    for (const window of visibleRain) if (!window.isDestroyed()) window.showInactive();
    if (wasVisible && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.showInactive();
      if (wasExpanded) setExpanded(true, false);
      else { mainWindow.setBounds(makeWindowBounds(false), false); applyWindowShape(false); }
    }
  }
}

async function getRecordScreenSources() {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false });
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const primarySource = sources.find((source) => String(source.display_id) === String(primary.id)) || sources[0];
  if (!preferredScreenRecordSourceId || !sources.some((source) => source.id === preferredScreenRecordSourceId)) {
    preferredScreenRecordSourceId = primarySource ? primarySource.id : '';
  }
  if (!screenRecordSourceId) screenRecordSourceId = preferredScreenRecordSourceId;
  return sources.slice(0, 8).map((source, index) => {
    const display = displays.find((candidate) => String(candidate.id) === String(source.display_id)) || displays[index] || primary;
    const displayNumber = Math.max(1, displays.indexOf(display) + 1);
    return { id: source.id, name: `Экран ${displayNumber}${String(display.id) === String(primary.id) ? ' · основной' : ''}`, selected: source.id === preferredScreenRecordSourceId };
  });
}

async function chooseScreenForRecording() {
  const screens = await getRecordScreenSources();
  const selected = screens.find((source) => source.id === preferredScreenRecordSourceId) || screens[0];
  screenRecordSourceId = selected ? selected.id : '';
  return selected ? { ok: true, displayName: selected.name } : { ok: false, message: 'Экраны не найдены.' };
}

async function selectRecordScreen(id) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false });
  const selected = sources.find((source) => source.id === id);
  if (!selected) return { ok: false, message: 'Экран больше не доступен.' };
  preferredScreenRecordSourceId = selected.id;
  screenRecordSourceId = selected.id;
  return { ok: true, state: publicState() };
}

async function saveScreenshot(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 40 * 1024 * 1024 || !/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) return { ok: false, message: 'Некорректное изображение.' };
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) return { ok: false, message: 'Не удалось обработать скриншот.' };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showSaveDialog(mainWindow, { title: 'Сохранить скриншот', defaultPath: path.join(app.getPath('pictures'), `NOVA-${new Date().toISOString().replace(/[:.]/g, '-')}.png`), filters: [{ name: 'PNG', extensions: ['png'] }] })
    : await dialog.showSaveDialog({ title: 'Сохранить скриншот', defaultPath: path.join(app.getPath('pictures'), `NOVA-${Date.now()}.png`), filters: [{ name: 'PNG', extensions: ['png'] }] });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  await fs.promises.writeFile(result.filePath, image.toPNG());
  return { ok: true, filePath: result.filePath };
}

function copyScreenshot(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 40 * 1024 * 1024 || !/^data:image\/(png|jpeg);base64,/i.test(dataUrl)) return { ok: false, message: 'Некорректное изображение.' };
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) return { ok: false, message: 'Не удалось обработать скриншот.' };
  clipboard.writeImage(image);
  return { ok: true };
}

async function saveRecording(payload) {
  const mimeType = String(payload && payload.mimeType || '').split(';')[0].toLowerCase();
  if (!payload || !payload.data || !['video/webm', 'audio/webm', 'video/mp4', 'audio/mp4'].includes(mimeType)) return { ok: false, message: 'Формат записи не поддерживается.' };
  const bytes = Buffer.isBuffer(payload.data) ? payload.data : Buffer.from(payload.data);
  if (!bytes.length || bytes.length > 256 * 1024 * 1024) return { ok: false, message: 'Запись пуста или превышает лимит 256 МБ.' };
  const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const isVideo = mimeType.startsWith('video/');
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showSaveDialog(mainWindow, { title: 'Сохранить запись', defaultPath: path.join(app.getPath('videos'), `NOVA-${Date.now()}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] })
    : await dialog.showSaveDialog({ title: 'Сохранить запись', defaultPath: path.join(isVideo ? app.getPath('videos') : app.getPath('music'), `NOVA-${Date.now()}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  await fs.promises.writeFile(result.filePath, bytes);
  return { ok: true, filePath: result.filePath };
}

async function chooseQuickApp() {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Выберите приложение для быстрого запуска', properties: ['openFile'], filters: process.platform === 'win32' ? [{ name: 'Приложения', extensions: ['exe', 'lnk', 'bat', 'cmd'] }, { name: 'Все файлы', extensions: ['*'] }] : [{ name: 'Приложения и файлы', extensions: ['*'] }] });
  if (result.canceled || !result.filePaths[0]) return publicState();
  const appPath = result.filePaths[0];
  if (store.settings.quickApps.some((entry) => entry.path.toLowerCase() === appPath.toLowerCase())) return publicState();
  if (store.settings.quickApps.length >= 16) return publicState();
  store.settings.quickApps.push({ id: makeId(), title: path.basename(appPath, path.extname(appPath)).slice(0, 60), path: appPath });
  persistStore(); broadcastState(); return publicState();
}

async function launchQuickApp(id) {
  const entry = store.settings.quickApps.find((candidate) => candidate.id === id);
  if (!entry || !path.isAbsolute(entry.path)) return { ok: false, message: 'Ярлык не найден.' };
  try { await fs.promises.access(entry.path, fs.constants.F_OK); }
  catch { return { ok: false, message: 'Файл приложения не найден.' }; }
  const error = await shell.openPath(entry.path);
  return { ok: !error, message: error || 'Запускаю…' };
}

async function runAdminCommand(command) {
  if (process.platform !== 'win32') return { ok: false, message: 'Запуск с повышением прав доступен только в Windows.' };
  const text = safeString(command, 2000).trim();
  if (!text) return { ok: false, message: 'Введите команду для CMD.' };
  const answer = await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Команда с правами администратора', message: 'Открыть CMD от имени администратора и выполнить эту команду?', detail: `${text.slice(0, 500)}\n\nWindows покажет системный запрос UAC. Выполняйте только команды, которым доверяете.`, buttons: ['Отмена', 'Продолжить'], defaultId: 0, cancelId: 0, noLink: true });
  if (answer.response !== 1) return { ok: false, canceled: true };
  const cmdPath = path.join(app.getPath('temp'), `nova-admin-${crypto.randomUUID()}.cmd`);
  await fs.promises.writeFile(cmdPath, `@echo off\r\n${text.replace(/[\r\n]+/g, '\r\n')}\r\necho.\r\necho Команда завершена.\r\npause\r\ndel "%~f0"\r\n`, 'utf8');
  const script = `$p=Start-Process -FilePath $env:ComSpec -ArgumentList ('/k "${cmdPath}"') -Verb RunAs -PassThru;`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const child = require('node:child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true, message: 'Открываю административный CMD. Подтвердите UAC в Windows.' };
  } catch (error) {
    await fs.promises.unlink(cmdPath).catch(() => {});
    return { ok: false, message: safeString(error && error.message, 180) };
  }
}

function setExpandedPosition(x, y) {
  if (!mainWindow || mainWindow.isDestroyed() || !expanded) return false;
  const point = { x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) };
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  const bounds = mainWindow.getBounds();
  const nextX = Math.max(area.x, Math.min(area.x + area.width - bounds.width, point.x));
  const nextY = Math.max(area.y, Math.min(area.y + area.height - bounds.height, point.y));
  mainWindow.setPosition(nextX, nextY, false);
  store.settings.expandedPosition = { x: nextX, y: nextY };
  store.settings.windowPosition = { centerX: nextX + bounds.width / 2, y: nextY };
  persistStore();
  return true;
}

function setVisualEffects(values = {}) {
  if (Object.prototype.hasOwnProperty.call(values, 'liquidGlassEnabled')) {
    store.settings.liquidGlassEnabled = Boolean(values.liquidGlassEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(values, 'rainEnabled')) {
    store.settings.rainEnabled = Boolean(values.rainEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(values, 'rainIntensity')) {
    const intensity = String(values.rainIntensity);
    if (['light', 'normal', 'storm'].includes(intensity)) store.settings.rainIntensity = intensity;
  }
  if (Object.prototype.hasOwnProperty.call(values, 'accentColor') && /^#[0-9a-f]{6}$/i.test(String(values.accentColor))) {
    store.settings.accentColor = String(values.accentColor);
  }
  persistStore();
  syncRainOverlay();
  broadcastState();
  return publicState();
}

function registerIpc() {
  ipcMain.handle('nova:get-state', () => publicState());
  ipcMain.handle('nova:set-expanded', (_event, value) => {
    setExpanded(Boolean(value));
    return true;
  });
  ipcMain.handle('nova:focus-timer', (_event, action, minutes, mode, taskId) => updateFocusTimer(action, minutes, mode, taskId));
  ipcMain.handle('nova:add-task', (_event, data) => addTask(data));
  ipcMain.handle('nova:toggle-task', (_event, id) => toggleTask(id));
  ipcMain.handle('nova:delete-task', (_event, id) => deleteTask(id));
  ipcMain.handle('nova:export-backup', () => exportBackup());
  ipcMain.handle('nova:import-backup', () => importBackup());
  ipcMain.handle('nova:add-item', (_event, data) => {
    if (!data || typeof data !== 'object') return { ok: false };
    const item = addTextItem(data.kind, data.title, data.content, data.source || 'manual');
    return { ok: Boolean(item), state: publicState() };
  });
  ipcMain.handle('nova:choose-files', async () => {
    const options = {
      title: 'Добавить в NOVA',
      properties: ['openFile', 'multiSelections'],
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return { added: 0, state: publicState() };
    let added = 0;
    for (const filePath of result.filePaths) {
      try {
        if (await importFile(filePath, 'manual')) added += 1;
      } catch (error) {
        console.error('[NOVA] File import failed:', error);
      }
    }
    return { added, state: publicState() };
  });
  ipcMain.handle('nova:add-dropped-files', async (_event, paths) => {
    let added = 0;
    const candidates = Array.isArray(paths) ? paths.slice(0, 30) : [];
    for (const sourcePath of candidates) {
      try {
        if (await importFile(sourcePath, 'drop')) added += 1;
      } catch (error) {
        console.warn('[NOVA] Dropped file could not be imported:', error.message);
      }
    }
    return { added, state: publicState() };
  });
  ipcMain.handle('nova:toggle-pin', (_event, id) => {
    const item = store.items.find((candidate) => candidate.id === id);
    if (item) {
      item.pinned = !item.pinned;
      persistStore();
      if (item.pinned) setExpanded(true);
      else syncCollapsedBounds();
      broadcastState();
    }
    return publicState();
  });
  ipcMain.handle('nova:delete-item', async (_event, id) => {
    const item = store.items.find((candidate) => candidate.id === id);
    if (!item) return publicState();
    store.items = store.items.filter((candidate) => candidate.id !== id);
    if (store.settings.mediaPlayerItemId === id) store.settings.mediaPlayerItemId = '';
    if (item.storedPath && isInsideLibrary(item.storedPath)) {
      await fs.promises.unlink(item.storedPath).catch(() => {});
    }
    persistStore();
    syncCollapsedBounds();
    broadcastState();
    return publicState();
  });
  ipcMain.handle('nova:clear-clipboard', async () => {
    const removed = store.items.filter((item) => item.source === 'clipboard');
    if (removed.some((item) => item.id === store.settings.mediaPlayerItemId)) store.settings.mediaPlayerItemId = '';
    store.items = store.items.filter((item) => item.source !== 'clipboard');
    await Promise.all(removed.map((item) => {
      if (item.storedPath && isInsideLibrary(item.storedPath)) return fs.promises.unlink(item.storedPath).catch(() => {});
      return Promise.resolve();
    }));
    persistStore();
    syncCollapsedBounds();
    broadcastState();
    return publicState();
  });
  ipcMain.handle('nova:set-clipboard-enabled', (_event, enabled) => setClipboardEnabled(enabled));
  ipcMain.handle('nova:set-always-on-top', (_event, enabled) => setAlwaysOnTop(enabled));
  ipcMain.handle('nova:set-click-through', (_event, enabled) => setClickThrough(enabled));
  ipcMain.handle('nova:set-game-mode', (_event, enabled) => setGameMode(enabled));
  ipcMain.handle('nova:set-volume-wheel', (_event, enabled) => setVolumeWheelEnabled(enabled));
  ipcMain.handle('nova:set-mic-monitoring', (_event, enabled) => setMicMonitoringEnabled(enabled));
  ipcMain.handle('nova:set-visual-effects', (_event, values) => setVisualEffects(values));
  ipcMain.handle('nova:set-expanded-position', (_event, x, y) => setExpandedPosition(x, y));
  ipcMain.handle('nova:create-folder', (_event, name) => {
    const folder = safeString(name, 60).trim();
    if (!folder || /^all$/i.test(folder) || /[\\/]/.test(folder) || store.folders.length >= 40) return { ok: false, message: 'Имя папки недопустимо, зарезервировано или достигнут лимит.' };
    if (store.folders.some((entry) => entry.toLocaleLowerCase() === folder.toLocaleLowerCase())) return { ok: false, message: 'Такая папка уже существует.' };
    store.folders.push(folder); persistStore(); broadcastState(); return { ok: true, state: publicState() };
  });
  ipcMain.handle('nova:assign-folder', (_event, id, name) => {
    const item = store.items.find((candidate) => candidate.id === id);
    const folder = safeString(name, 60).trim();
    if (!item || !['file', 'image', 'media'].includes(item.kind) || (folder && !store.folders.includes(folder))) return { ok: false, message: 'Не удалось переместить элемент.' };
    item.folder = folder; persistStore(); broadcastState(); return { ok: true, state: publicState() };
  });
  ipcMain.handle('nova:choose-quick-app', () => chooseQuickApp());
  ipcMain.handle('nova:launch-quick-app', (_event, id) => launchQuickApp(id));
  ipcMain.handle('nova:remove-quick-app', (_event, id) => {
    store.settings.quickApps = store.settings.quickApps.filter((entry) => entry.id !== id); persistStore(); broadcastState(); return publicState();
  });
  ipcMain.handle('nova:run-admin-command', (_event, command) => runAdminCommand(command));
  ipcMain.handle('nova:capture-screens', () => captureScreenSources());
  ipcMain.handle('nova:prepare-record-source', () => chooseScreenForRecording());
  ipcMain.handle('nova:get-record-screens', () => getRecordScreenSources());
  ipcMain.handle('nova:select-record-screen', (_event, id) => selectRecordScreen(id));
  ipcMain.handle('nova:set-weather-city', (_event, city) => searchWeatherCity(city));
  ipcMain.handle('nova:save-screenshot', (_event, dataUrl) => saveScreenshot(dataUrl));
  ipcMain.handle('nova:copy-screenshot', (_event, dataUrl) => copyScreenshot(dataUrl));
  ipcMain.handle('nova:save-recording', (_event, payload) => saveRecording(payload));
  ipcMain.handle('nova:approve-audio-recording', async () => {
    const answer = await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Запись с микрофона', message: 'Разрешить NOVA записать звук с микрофона?', detail: 'Запись остаётся на этом компьютере. После завершения выберите, куда сохранить файл. Перед отправкой разговора убедитесь, что участники дали согласие.', buttons: ['Не разрешать', 'Разрешить один раз'], defaultId: 0, cancelId: 0, noLink: true });
    audioRecordApproval = answer.response === 1;
    return audioRecordApproval;
  });
  ipcMain.handle('nova:get-system-snapshot', async () => {
    try { return { ...(await systemServices.getMachineSnapshot()), appVersion: app.getVersion() }; }
    catch (error) { return { ok: false, message: error.message || 'Не удалось получить данные системы.' }; }
  });
  ipcMain.handle('nova:get-repository-status', () => systemServices.getRepositoryStatus(app.getVersion()));
  ipcMain.handle('nova:ping-host', (_event, host) => systemServices.pingHost(host));
  ipcMain.handle('nova:system-action', (_event, action) => runSystemQuickAction(action));
  ipcMain.handle('nova:adjust-system-control', (_event, control, direction) => {
    if (!store.settings.volumeWheelEnabled) return { ok: false, message: 'Колесо системных регуляторов отключено.' };
    return systemServices.adjustSystemControl(control, direction);
  });
  ipcMain.handle('nova:open-repository', () => shell.openExternal('https://github.com/smells1k/nova-island'));
  ipcMain.handle('nova:open-latest-release', () => shell.openExternal('https://github.com/smells1k/nova-island/releases/latest'));
  ipcMain.handle('nova:set-active-media', (_event, id) => activateMedia(id));
  ipcMain.handle('nova:close-active-media', () => closeActiveMedia());
  ipcMain.handle('nova:clean-orphaned-storage', () => cleanOrphanedFiles());
  ipcMain.handle('nova:set-launch-at-login', (_event, enabled) => {
    store.settings.launchAtLogin = Boolean(enabled);
    try {
      app.setLoginItemSettings({
        openAtLogin: store.settings.launchAtLogin,
        openAsHidden: true,
      });
    } catch (error) {
      console.warn('[NOVA] Startup setting is not available on this platform:', error.message);
    }
    persistStore();
    broadcastState();
    return publicState();
  });
  ipcMain.handle('nova:copy-item', (_event, id) => {
    return copyItemToClipboard(store.items.find((item) => item.id === id));
  });
  ipcMain.handle('nova:open-item', async (_event, id) => {
    const item = store.items.find((candidate) => candidate.id === id);
    if (!item) return { ok: false, message: 'Элемент не найден' };
    if (item.kind === 'media') return activateMedia(id);
    if (item.kind === 'file' || item.kind === 'image') {
      const error = await shell.openPath(item.storedPath || '');
      return { ok: !error, message: error || 'Открываю файл…' };
    }
    return copyItemToClipboard(item);
  });
  ipcMain.handle('nova:reveal-item', (_event, id) => {
    const item = store.items.find((candidate) => candidate.id === id);
    if (item && item.storedPath) shell.showItemInFolder(item.storedPath);
    return true;
  });
  ipcMain.handle('nova:open-storage', () => shell.openPath(libraryPath));
  ipcMain.handle('nova:quit', () => {
    isQuitting = true;
    app.quit();
    return true;
  });
}

app.whenReady().then(async () => {
  ensureDirectories();
  loadStore();
  if (process.platform === 'win32') app.setAppUserModelId('studio.nova.island');
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details = {}) => {
    const requestedTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
    const audioOnlyMicPermission = permission === 'media'
      && requestedTypes.includes('audio')
      && !requestedTypes.includes('video')
      && (Boolean(store.settings.micMonitoringEnabled) || audioRecordApproval);
    if (audioOnlyMicPermission && audioRecordApproval) audioRecordApproval = false;
    callback(audioOnlyMicPermission);
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const selectedId = screenRecordSourceId;
    screenRecordSourceId = '';
    if (!selectedId) { callback({}); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 }, fetchWindowIcons: false });
      const selected = sources.find((source) => source.id === selectedId);
      const audio = request && request.audioRequested && process.platform === 'win32' ? 'loopback' : undefined;
      callback(selected ? { video: selected, ...(audio ? { audio } : {}) } : {});
    } catch { callback({}); }
  });
  registerIpc();
  await chooseScreenForRecording().catch(() => {});
  createWindow();
  createTray();
  refreshDashboardMetrics();
  refreshDashboardWeather();
  dashboardRefreshTimer = setInterval(refreshDashboardMetrics, 12000);
  dashboardWeatherTimer = setInterval(refreshDashboardWeather, 30 * 60 * 1000);
  syncRainOverlay();
  screen.on('display-added', syncRainOverlay);
  screen.on('display-removed', syncRainOverlay);
  screen.on('display-metrics-changed', syncRainOverlay);
  configureFullscreenWatcher();
  await primeClipboardBaseline();

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    setExpanded(!expanded);
  });

  clipboardTimer = setInterval(pollClipboard, 900);
  focusTimerInterval = setInterval(tickFocusTimer, 1000);
  app.on('activate', () => setExpanded(true));
});

app.on('before-quit', () => {
  isQuitting = true;
  for (const overlay of rainWindows.values()) if (!overlay.isDestroyed()) overlay.destroy();
  rainWindows.clear();
  if (rainSurfaceTimer) clearInterval(rainSurfaceTimer);
  rainSurfaceTimer = null;
  if (clipboardTimer) clearInterval(clipboardTimer);
  if (focusTimerInterval) clearInterval(focusTimerInterval);
  if (fullscreenTimer) clearInterval(fullscreenTimer);
  if (clipboardPulseTimer) clearTimeout(clipboardPulseTimer);
  if (collapseTimer) clearTimeout(collapseTimer);
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // NOVA is a tray app; closing the floating island should not stop background capture.
});
