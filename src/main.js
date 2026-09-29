'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  globalShortcut,
  desktopCapturer,
  screen,
  ipcMain,
  clipboard,
  ClipboardItem,
  nativeImage,
  nativeTheme,
  dialog,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs/promises');
const I18N = require('./i18n');
const { SettingsStore, DEFAULT_SHORTCUTS } = require('./settings');
const { Hotkeys } = require('./hotkeys');
const { Library, THUMB_SIZE } = require('./library');

const ASSETS = path.join(__dirname, '..', 'assets');
const PRELOAD = path.join(__dirname, 'preload.js');

// Lancé au démarrage de Windows, Snapit démarre discrètement dans la zone de notification.
const HIDDEN_ARG = '--hidden';
const LOGIN_ARGS = [HIDDEN_ARG];

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' };

let tray = null;
let quitting = false;
let balloonShown = false;
let capturing = false;
let session = null; // sélection de zone en cours
let settingsWindow = null;
let settings = null;
let hotkeys = null;
let library = null;

const editors = new Map(); // webContents.id -> { win, hasImage, libraryId, focusedAt }
const pendingImages = new Map(); // webContents.id -> image à charger au démarrage de l'éditeur
const overlays = new Map(); // display.id -> { win, ready }
const overlayAcks = new Map(); // webContents.id -> resolve

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showEditor());
}

// ---------------------------------------------------------------------------
// Langue, thème
// ---------------------------------------------------------------------------

const lang = () => I18N.resolve(settings.get().language, app.getLocale());
const t = (key, params) => I18N.t(lang(), key, params);
const shortcutLabel = (action) => I18N.formatAccelerator(lang(), settings.get().shortcuts[action]);
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#141418' : '#f4f4f7');
const libraryFolder = () => path.resolve(settings.get().libraryFolder || path.join(app.getPath('pictures'), 'Snapit'));

function applyTheme() {
  nativeTheme.themeSource = settings.get().theme;
}

// État partagé avec les pages (éditeur, paramètres)
function appState() {
  return {
    settings: settings.get(),
    lang: lang(),
    status: hotkeys?.getStatus() ?? { shortcuts: {}, hookAvailable: false, hookFailed: false },
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    // Sous Windows, l'entrée de démarrage n'est reconnue qu'avec les mêmes arguments qu'à l'activation
    openAtLogin: app.isPackaged ? app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin : false,
    libraryFolder: libraryFolder(),
  };
}

function broadcast() {
  const state = appState();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('app:state', state);
  }
}

function sendToEditors(channel, ...args) {
  for (const { win } of liveEditors()) win.webContents.send(channel, ...args);
}

const secureWebPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function lockDownNavigation(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }
}

// ---------------------------------------------------------------------------
// Éditeur
// ---------------------------------------------------------------------------

function createEditor(payload) {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const width = Math.min(1480, Math.round(area.width * 0.85));
  const height = Math.min(940, Math.round(area.height * 0.85));
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    minWidth: 820,
    minHeight: 520,
    show: false,
    title: 'Snapit',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences,
  });
  lockDownNavigation(win);

  const id = win.webContents.id;
  editors.set(id, { win, hasImage: Boolean(payload), libraryId: payload?.libraryId ?? null, focusedAt: Date.now() });
  if (payload) pendingImages.set(id, payload);

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  win.on('focus', () => {
    const entry = editors.get(id);
    if (entry) entry.focusedAt = Date.now();
  });

  // L'éditeur bloque la fermeture s'il reste des annotations non enregistrées.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: [t('unsaved.close'), t('unsaved.cancel')],
      defaultId: 1,
      cancelId: 1,
      title: 'Snapit',
      message: t('unsaved.message'),
      detail: t('unsaved.detail'),
    });
    if (choice === 0) e.preventDefault();
  });

  win.on('closed', () => {
    editors.delete(id);
    pendingImages.delete(id);
    if (editors.size === 0 && !quitting && !balloonShown && tray) {
      balloonShown = true;
      tray.displayBalloon({
        iconType: 'info',
        title: t('balloon.title'),
        content: t('balloon.body', { key: shortcutLabel('region') || t('balloon.noKey') }),
      });
    }
  });

  win.loadFile(path.join(__dirname, 'editor', 'index.html'));
  return win;
}

function liveEditors() {
  return [...editors.values()].filter((e) => !e.win.isDestroyed());
}

function focusWindow(win) {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function showEditor() {
  const list = liveEditors();
  if (list.length) focusWindow(list[list.length - 1].win);
  else createEditor();
}

// Affiche une image dans l'éditeur. Si une fenêtre montre déjà cette capture, elle est mise en avant.
// Sinon l'image remplace le contenu de `preferred`, d'une fenêtre vide ou — galerie affichée — d'une fenêtre
// dont la capture est enregistrée automatiquement (on la retrouve dans la galerie). Sinon, nouvelle fenêtre.
function openImageInEditor(payload, preferred = null) {
  const list = liveEditors();
  const showing = payload.libraryId && list.find((e) => e.libraryId === payload.libraryId);
  if (showing) {
    focusWindow(showing.win);
    return showing.win;
  }
  const reusable = (e) => !e.hasImage || (Boolean(e.libraryId) && settings.get().showGallery);
  const byFocus = [...list].sort((a, b) => b.focusedAt - a.focusedAt);
  const target = [preferred, ...list.filter((e) => !e.hasImage), ...byFocus].find((e) => e && !e.win.isDestroyed() && reusable(e));
  if (!target) return createEditor(payload);
  Object.assign(target, { hasImage: true, libraryId: payload.libraryId ?? null });
  target.win.webContents.send('editor:load', payload); // l'éditeur enregistre d'abord la capture qu'il affiche
  focusWindow(target.win);
  return target.win;
}

// Rouvre une capture de la bibliothèque, annotations comprises.
async function openFromLibrary(id, preferred, newWindow = false) {
  const showing = liveEditors().find((e) => e.libraryId === id);
  if (showing) return focusWindow(showing.win);
  const payload = await library.load(id);
  if (newWindow) createEditor(payload);
  else openImageInEditor(payload, preferred);
}

async function readImageFile(filePath) {
  const mime = IMAGE_TYPES[path.extname(filePath).toLowerCase()];
  if (!mime) throw new Error(t('error.format'));
  const data = await fs.readFile(filePath);
  return {
    dataUrl: `data:${mime};base64,${data.toString('base64')}`,
    name: path.basename(filePath, path.extname(filePath)),
    scaleFactor: 1,
  };
}

async function openImageFromDialog(parent) {
  const { canceled, filePaths } = await dialog.showOpenDialog(parent ?? undefined, {
    title: t('dialog.open'),
    defaultPath: app.getPath('pictures'),
    properties: ['openFile'],
    filters: [{ name: t('filter.images'), extensions: Object.keys(IMAGE_TYPES).map((e) => e.slice(1)) }],
  });
  if (canceled || !filePaths.length) return null;
  return readImageFile(filePaths[0]);
}

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    focusWindow(settingsWindow);
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 760,
    minWidth: 560,
    minHeight: 480,
    show: false,
    title: t('settings.title'),
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: windowBackground(),
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences,
  });
  lockDownNavigation(settingsWindow);
  settingsWindow.once('ready-to-show', () => settingsWindow.show());
  settingsWindow.on('closed', () => {
    settingsWindow = null;
    hotkeys?.stopRecording();
  });
  settingsWindow.loadFile(path.join(__dirname, 'settings', 'index.html'));
}

function onSettingsChanged(next, previous) {
  if (next.theme !== previous.theme) applyTheme();
  if (JSON.stringify(next.shortcuts) !== JSON.stringify(previous.shortcuts) || next.overrideSnippingTool !== previous.overrideSnippingTool) {
    hotkeys.apply(next.shortcuts, next.overrideSnippingTool);
  }
  if (next.language !== previous.language) destroyOverlays();
  if (next.libraryFolder !== previous.libraryFolder) sendToEditors('library:changed', { type: 'reset' });
  refreshTray();
  broadcast();
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

async function grabDisplays() {
  const displays = screen.getAllDisplays();
  const pixelSize = (d) => ({
    width: Math.round(d.bounds.width * d.scaleFactor),
    height: Math.round(d.bounds.height * d.scaleFactor),
  });
  const thumbnailSize = {
    width: Math.max(...displays.map((d) => pixelSize(d).width)),
    height: Math.max(...displays.map((d) => pixelSize(d).height)),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });

  return displays
    .map((display, i) => {
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[i];
      let image = source?.thumbnail;
      if (!image || image.isEmpty()) return null;
      const want = pixelSize(display);
      const got = image.getSize();
      if (got.width !== want.width || got.height !== want.height) {
        image = image.resize({ ...want, quality: 'best' });
      }
      return { display, image };
    })
    .filter(Boolean);
}

function hideWindowsForCapture() {
  const windows = [...liveEditors().map((e) => e.win), settingsWindow].filter(
    (w) => w && !w.isDestroyed() && w.isVisible() && !w.isMinimized(),
  );
  windows.forEach((w) => w.hide());
  return windows;
}

function restoreWindows(hidden) {
  hidden.filter((w) => !w.isDestroyed()).forEach((w) => w.showInactive());
}

async function startCapture(mode = 'region') {
  if (capturing) return;
  capturing = true;
  const hidden = hideWindowsForCapture();
  try {
    if (mode === 'delay') {
      await delay(settings.get().captureDelay * 1000);
      mode = 'region';
    }
    // Laisse le temps à Windows de retirer nos fenêtres (et le menu de la zone de notification) de l'écran.
    await delay(hidden.length ? 250 : 180);
    const captures = await grabDisplays();
    if (!captures.length) throw new Error(t('error.noScreen'));

    let result;
    if (mode === 'fullscreen') {
      const target = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const c = captures.find((c) => c.display.id === target.id) ?? captures[0];
      result = { image: c.image, scaleFactor: c.display.scaleFactor };
    } else {
      result = await selectRegion(captures);
    }

    restoreWindows(hidden);
    if (result) await deliverCapture(result);
  } catch (err) {
    restoreWindows(hidden);
    dialog.showErrorBox(t('error.capture'), String(err?.message ?? err));
  } finally {
    capturing = false;
  }
}

// Copie la capture dans le presse-papiers et l'enregistre dans la bibliothèque (selon les paramètres),
// puis l'ouvre dans l'éditeur.
async function deliverCapture({ image, scaleFactor }) {
  const { copyAfterCapture, autoSave } = settings.get();
  const png = image.toPNG();
  if (copyAfterCapture) await writeClipboardPng(png);
  const payload = {
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    scaleFactor,
    name: captureName(),
    copied: copyAfterCapture,
  };
  if (autoSave) {
    try {
      const { width, height } = image.getSize();
      const item = await library.create({ png, thumb: thumbnail(image), name: payload.name, unit: scaleFactor, width, height });
      payload.libraryId = item.id;
    } catch {
      payload.notice = t('toast.autosaveFailed'); // la capture s'ouvre quand même, sans enregistrement
    }
  }
  openImageInEditor(payload);
}

// Miniature de la galerie ; l'éditeur la régénère ensuite à chaque modification.
function thumbnail(image) {
  const { width, height } = image.getSize();
  const ratio = Math.min(1, THUMB_SIZE.width / width, THUMB_SIZE.height / height);
  const size = { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
  return image.resize({ ...size, quality: 'good' }).toJPEG(85);
}

function captureName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return t('capture.name', {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`,
  });
}

async function writeClipboardPng(png) {
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
}

// ---------------------------------------------------------------------------
// Sélection de zone : une fenêtre plein écran par moniteur affiche la capture figée.
// Les fenêtres sont conservées et réutilisées pour que la capture suivante soit instantanée.
// ---------------------------------------------------------------------------

function getOverlay(display) {
  const existing = overlays.get(display.id);
  if (existing && !existing.win.isDestroyed()) return existing;

  const win = new BrowserWindow({
    ...display.bounds,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    backgroundColor: '#000000',
    webPreferences: secureWebPreferences,
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenu(null);
  lockDownNavigation(win);

  const ready = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  win.loadFile(path.join(__dirname, 'overlay', 'overlay.html'));
  const overlay = { win, ready, displayId: display.id };
  overlays.set(display.id, overlay);
  win.on('closed', () => {
    if (overlays.get(display.id) === overlay) overlays.delete(display.id);
  });
  return overlay;
}

function destroyOverlays() {
  if (session) return; // on ne détruit rien pendant une sélection
  for (const { win } of overlays.values()) if (!win.isDestroyed()) win.destroy();
  overlays.clear();
}

function selectRegion(captures) {
  return new Promise((resolve) => {
    session = { captures, resolve };
    globalShortcut.register('Escape', () => endSession(null));
    const hint = t('overlay.hint');

    const shown = captures.map(async (c) => {
      const overlay = getOverlay(c.display);
      await overlay.ready;
      const wc = overlay.win.webContents;
      const ack = new Promise((r) => overlayAcks.set(wc.id, r));
      // JPEG : bien plus rapide à encoder que PNG, et suffisant pour l'aperçu figé.
      wc.send('overlay:show', {
        dataUrl: `data:image/jpeg;base64,${c.image.toJPEG(92).toString('base64')}`,
        hint,
      });
      await Promise.race([ack, delay(1500)]);
      overlayAcks.delete(wc.id);
      if (session?.resolve !== resolve) return;
      overlay.win.setBounds(c.display.bounds);
      overlay.win.show();
      overlay.win.setBounds(c.display.bounds); // corrige le positionnement sur les écrans à échelle mixte
    });

    Promise.all(shown).then(() => {
      if (session?.resolve !== resolve) return;
      const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const active = overlays.get(cursor.id) ?? [...overlays.values()][0];
      active?.win.focus();
    });
  });
}

function endSession(result) {
  if (!session) return;
  const { resolve } = session;
  session = null;
  globalShortcut.unregister('Escape');
  for (const { win } of overlays.values()) {
    if (win.isDestroyed()) continue;
    win.hide();
    win.webContents.send('overlay:reset');
  }
  resolve(result);
}

ipcMain.on('overlay:ready', (e) => {
  overlayAcks.get(e.sender.id)?.();
});

ipcMain.on('overlay:cancel', () => endSession(null));

ipcMain.on('overlay:select', (e, frac) => {
  if (!session) return;
  const overlay = [...overlays.values()].find((o) => !o.win.isDestroyed() && o.win.webContents.id === e.sender.id);
  const capture = session.captures.find((c) => c.display.id === overlay?.displayId);
  if (!capture) return endSession(null);

  const { width: W, height: H } = capture.image.getSize();
  const x = clamp(Math.round(frac.x * W), 0, W - 1);
  const y = clamp(Math.round(frac.y * H), 0, H - 1);
  const width = clamp(Math.round(frac.w * W), 1, W - x);
  const height = clamp(Math.round(frac.h * H), 1, H - y);
  endSession({
    image: capture.image.crop({ x, y, width, height }),
    scaleFactor: capture.display.scaleFactor,
  });
});

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('capture', (_e, mode) => startCapture(mode));

ipcMain.handle('editor:initial', (e) => {
  const payload = pendingImages.get(e.sender.id) ?? null;
  pendingImages.delete(e.sender.id);
  return payload;
});

ipcMain.on('editor:state', (e, { hasImage, libraryId }) => {
  const entry = editors.get(e.sender.id);
  if (entry) Object.assign(entry, { hasImage: Boolean(hasImage), libraryId: libraryId ?? null });
});

ipcMain.handle('editor:show', (e, payload) => {
  openImageInEditor(payload, editors.get(e.sender.id));
});

// Bibliothèque des captures
ipcMain.handle('library:list', () => library.list());
ipcMain.handle('library:open', (e, id, newWindow) => openFromLibrary(id, editors.get(e.sender.id), newWindow));
ipcMain.handle('library:save', (_e, data) => library.save(data));
// Dernier enregistrement, envoyé pendant la fermeture de la fenêtre
ipcMain.on('library:save-sync', (e, data) => {
  try {
    e.returnValue = library.save(data);
  } catch {
    e.returnValue = false;
  }
});
ipcMain.handle('library:remove', (_e, id) => library.remove(id));
ipcMain.handle('library:copy', async (_e, id) => writeClipboardPng(await fs.readFile(library.imagePath(id))));
ipcMain.handle('library:reveal', (_e, id) => {
  const file = library.imagePath(id);
  if (file) shell.showItemInFolder(file);
});
ipcMain.handle('library:open-folder', async () => {
  await fs.mkdir(libraryFolder(), { recursive: true });
  return shell.openPath(libraryFolder());
});
// Menu contextuel d'une miniature : l'éditeur exécute l'action choisie.
ipcMain.on('library:menu', (e, id) => {
  const act = (action) => () => {
    if (!e.sender.isDestroyed()) e.sender.send('library:menu-action', action, id);
  };
  Menu.buildFromTemplate([
    { label: t('gallery.menuOpen'), click: act('open') },
    { label: t('gallery.menuOpenNew'), click: act('openNew') },
    { type: 'separator' },
    { label: t('gallery.menuCopy'), click: act('copy') },
    { label: t('gallery.menuReveal'), click: act('reveal') },
    { type: 'separator' },
    { label: t('gallery.menuDelete'), click: act('delete') },
  ]).popup({ window: BrowserWindow.fromWebContents(e.sender) });
});

ipcMain.handle('app:state', () => appState());

ipcMain.handle('clipboard:write-image', async (_e, dataUrl) => {
  await writeClipboardPng(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  return true;
});

ipcMain.handle('clipboard:read-image', async () => {
  for (const item of await clipboard.read()) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    const blob = await item.getType(type);
    const data = Buffer.from(await blob.arrayBuffer());
    return { dataUrl: `data:${type};base64,${data.toString('base64')}`, name: captureName(), scaleFactor: 1 };
  }
  return null;
});

let lastSaveDir = null;

ipcMain.handle('file:save-image', async (e, dataUrl, suggestedName) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { saveFolder, saveFormat } = settings.get();
  const safeName = String(suggestedName || 'Capture').replace(/[\\/:*?"<>|]/g, '-');
  const png = { name: t('filter.png'), extensions: ['png'] };
  const jpeg = { name: t('filter.jpeg'), extensions: ['jpg', 'jpeg'] };
  const dir = lastSaveDir ?? (saveFolder || app.getPath('pictures'));
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: t('dialog.save'),
    defaultPath: path.join(dir, `${safeName}.${saveFormat === 'jpeg' ? 'jpg' : 'png'}`),
    filters: saveFormat === 'jpeg' ? [jpeg, png] : [png, jpeg],
  });
  if (canceled || !filePath) return null;

  const ext = path.extname(filePath).toLowerCase();
  const data = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await fs.writeFile(filePath, ext === '.jpg' || ext === '.jpeg' ? nativeImage.createFromBuffer(data).toJPEG(92) : data);
  lastSaveDir = path.dirname(filePath);
  return filePath;
});

ipcMain.handle('file:open-image', (e) => openImageFromDialog(BrowserWindow.fromWebContents(e.sender)));

ipcMain.handle('settings:open', () => openSettings());

ipcMain.handle('settings:set', (_e, patch) => {
  settings.set(patch);
  return appState();
});

ipcMain.handle('settings:set-login', (_e, enabled) => {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: LOGIN_ARGS });
  broadcast();
  return appState();
});

ipcMain.handle('settings:choose-folder', async (e) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: t('dialog.folder'),
    defaultPath: settings.get().saveFolder || app.getPath('pictures'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return appState();
  settings.set({ saveFolder: filePaths[0] });
  return appState();
});

ipcMain.handle('settings:choose-library-folder', async (e) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: t('dialog.libraryFolder'),
    defaultPath: libraryFolder(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths.length) return appState();
  settings.set({ libraryFolder: filePaths[0] });
  return appState();
});

ipcMain.handle('settings:reset-shortcuts', () => {
  settings.set({ shortcuts: { ...DEFAULT_SHORTCUTS } });
  return appState();
});

ipcMain.handle('settings:open-windows-keyboard', () => shell.openExternal('ms-settings:easeofaccess-keyboard'));

ipcMain.on('shortcuts:record-start', () => hotkeys.startRecording());
ipcMain.on('shortcuts:record-stop', () => hotkeys.stopRecording());

// ---------------------------------------------------------------------------
// Zone de notification
// ---------------------------------------------------------------------------

function buildTrayMenu() {
  const accel = (action) => settings.get().shortcuts[action] || undefined;
  const template = [
    { label: t('tray.region'), accelerator: accel('region'), registerAccelerator: false, click: () => startCapture('region') },
    { label: t('tray.fullscreen'), accelerator: accel('fullscreen'), registerAccelerator: false, click: () => startCapture('fullscreen') },
    { label: t('tray.delay', { s: settings.get().captureDelay }), accelerator: accel('delay'), registerAccelerator: false, click: () => startCapture('delay') },
    { type: 'separator' },
    { label: t('tray.editor'), click: showEditor },
    {
      label: t('tray.open'),
      click: async () => {
        try {
          const payload = await openImageFromDialog();
          if (payload) openImageInEditor(payload);
        } catch (err) {
          dialog.showErrorBox(t('error.open'), String(err?.message ?? err));
        }
      },
    },
    { type: 'separator' },
    { label: t('tray.settings'), click: openSettings },
    { label: t('tray.quit'), click: () => { quitting = true; app.quit(); } },
  ];
  return Menu.buildFromTemplate(template);
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(t('tray.tooltip'));
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  tray = new Tray(path.join(ASSETS, 'tray.png'));
  refreshTray();
  tray.on('click', showEditor);
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.snapit.app');
  Menu.setApplicationMenu(null);

  settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  settings.on('change', onSettingsChanged);
  applyTheme();

  library = new Library({ folder: libraryFolder, trash: (file) => shell.trashItem(file) });
  library.on('change', (event) => sendToEditors('library:changed', event));

  hotkeys = new Hotkeys({
    helperDir: path.join(app.getPath('userData'), 'bin'),
    onTrigger: (action) => startCapture(action),
    onRecord: (accelerator) => settingsWindow?.webContents.send('shortcuts:recorded', accelerator),
    onStatus: () => broadcast(),
  });
  const { shortcuts, overrideSnippingTool } = settings.get();
  hotkeys.apply(shortcuts, overrideSnippingTool);
  hotkeys.init(); // compile/démarre l'assistant clavier en arrière-plan, puis réapplique les raccourcis

  createTray();
  nativeTheme.on('updated', broadcast);

  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, destroyOverlays);
  }

  if (!process.argv.includes(HIDDEN_ARG)) createEditor();
});

// L'application vit dans la zone de notification : fermer les fenêtres ne la quitte pas.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  hotkeys?.dispose();
  globalShortcut.unregisterAll();
});

module.exports = {
  startCapture,
  openImageInEditor,
  openSettings,
  getSettings: () => settings,
  getHotkeys: () => hotkeys,
  getLibrary: () => library,
};
