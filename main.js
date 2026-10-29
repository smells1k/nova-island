'use strict';

const {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('node:url');

const PRODUCT_NAME = 'NOVA Island';
const STORE_VERSION = 1;
const MAX_ITEMS = 180;
const DEFAULT_SETTINGS = {
  clipboardEnabled: true,
  launchAtLogin: false,
};

let mainWindow = null;
let tray = null;
let storePath = '';
let libraryPath = '';
let store = { version: STORE_VERSION, settings: { ...DEFAULT_SETTINGS }, items: [] };
let expanded = false;
let isQuitting = false;
let clipboardTimer = null;
let collapseTimer = null;
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
  const items = Array.isArray(saved && saved.items) ? saved.items : [];
  store = {
    version: STORE_VERSION,
    settings,
    items: items.filter((item) => item && typeof item.id === 'string' && typeof item.kind === 'string'),
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
  };

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
  return {
    items: sortedItems().map(publicItem),
    settings: { ...store.settings },
    expanded,
  };
}

function broadcastState() {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('nova:state', publicState());
  }
  refreshTrayMenu();
}

function makeWindowBounds(isExpanded) {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const width = Math.min(isExpanded ? 446 : 198, Math.max(190, area.width - 16));
  const height = isExpanded
    ? Math.max(420, Math.min(666, area.height - 18))
    : 62;
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + 8),
    width,
    height: Math.min(height, Math.max(82, area.height - 8)),
  };
}

function setExpanded(nextValue, shouldFocus = true) {
  const next = Boolean(nextValue);
  expanded = next;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (collapseTimer) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }

  if (next) {
    mainWindow.setBounds(makeWindowBounds(true), false);
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.moveTop();
    if (shouldFocus) mainWindow.focus();
    if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('nova:expanded', true);
    }
  } else {
    if (mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('nova:expanded', false);
    }
    // Let the CSS pill animation finish before shrinking the transparent native window.
    collapseTimer = setTimeout(() => {
      if (!expanded && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setBounds(makeWindowBounds(false), false);
      }
    }, 390);
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

function createWindow() {
  mainWindow = new BrowserWindow({
    ...makeWindowBounds(false),
    title: PRODUCT_NAME,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.setAlwaysOnTop(true);
  mainWindow.setMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setBounds(makeWindowBounds(false), false);
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
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
  const item = {
    id: makeId(),
    kind: imageExts.has(extension) ? 'image' : 'file',
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

    if (snapshot.uriKey && snapshot.uriKey !== lastClipboardUriKey) {
      lastClipboardUriKey = snapshot.uriKey;
      for (const filePath of snapshot.filePaths.slice(0, 30)) {
        try {
          await importFile(filePath, 'clipboard');
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
      if (!snapshot.uriKey && snapshot.text.trim()) addClipboardText(snapshot.text);
    }

    if (snapshot.imageHash && snapshot.imageHash !== lastClipboardImageHash) {
      lastClipboardImageHash = snapshot.imageHash;
      await addClipboardImage(snapshot.image);
    } else if (!snapshot.imageHash) {
      lastClipboardImageHash = '';
    }
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
      return { ok: true, message: 'Изображение скопировано' };
    }

    if (item.kind === 'file' && item.storedPath) {
      const uri = pathToFileURL(item.storedPath).href;
      await clipboard.write([new ClipboardItem({ 'text/uri-list': uri })]);
      lastClipboardUriKey = path.resolve(item.storedPath);
      lastClipboardText = '';
      lastClipboardImageHash = '';
      return { ok: true, message: 'Файл скопирован — его можно вставить в другое окно' };
    }

    await clipboard.writeText(item.content || '');
    lastClipboardText = item.content || '';
    lastClipboardUriKey = '';
    lastClipboardImageHash = '';
    return { ok: true, message: 'Текст скопирован' };
  } catch (error) {
    console.error('[NOVA] Clipboard write failed:', error);
    return { ok: false, message: 'Не удалось скопировать' };
  }
}

function registerIpc() {
  ipcMain.handle('nova:get-state', () => publicState());
  ipcMain.handle('nova:set-expanded', (_event, value) => {
    setExpanded(Boolean(value));
    return true;
  });
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
      broadcastState();
    }
    return publicState();
  });
  ipcMain.handle('nova:delete-item', async (_event, id) => {
    const item = store.items.find((candidate) => candidate.id === id);
    if (!item) return publicState();
    store.items = store.items.filter((candidate) => candidate.id !== id);
    if (item.storedPath && isInsideLibrary(item.storedPath)) {
      await fs.promises.unlink(item.storedPath).catch(() => {});
    }
    persistStore();
    broadcastState();
    return publicState();
  });
  ipcMain.handle('nova:clear-clipboard', async () => {
    const removed = store.items.filter((item) => item.source === 'clipboard');
    store.items = store.items.filter((item) => item.source !== 'clipboard');
    await Promise.all(removed.map((item) => {
      if (item.storedPath && isInsideLibrary(item.storedPath)) return fs.promises.unlink(item.storedPath).catch(() => {});
      return Promise.resolve();
    }));
    persistStore();
    broadcastState();
    return publicState();
  });
  ipcMain.handle('nova:set-clipboard-enabled', (_event, enabled) => setClipboardEnabled(enabled));
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
  registerIpc();
  createWindow();
  createTray();
  await primeClipboardBaseline();

  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    setExpanded(!expanded);
  });

  clipboardTimer = setInterval(pollClipboard, 900);
  app.on('activate', () => setExpanded(true));
});

app.on('before-quit', () => {
  isQuitting = true;
  if (clipboardTimer) clearInterval(clipboardTimer);
  if (collapseTimer) clearTimeout(collapseTimer);
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // NOVA is a tray app; closing the floating island should not stop background capture.
});
