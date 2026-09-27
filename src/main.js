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
  dialog,
} = require('electron');
const path = require('path');
const fs = require('fs/promises');

const ASSETS = path.join(__dirname, '..', 'assets');
const PRELOAD = path.join(__dirname, 'preload.js');
const CAPTURE_DELAY_MS = 3000;

const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' };

// Raccourcis globaux : [accélérateur, mode, libellé affiché]
const SHORTCUTS = [
  ['PrintScreen', 'region', 'Impr. écran'],
  ['Shift+PrintScreen', 'fullscreen', 'Maj+Impr. écran'],
  ['Alt+Shift+S', 'region', 'Alt+Maj+S'],
];

let tray = null;
let quitting = false;
let balloonShown = false;
let capturing = false;
let session = null; // sélection de zone en cours
let registeredShortcuts = [];

const editors = new Map(); // webContents.id -> { win, hasImage }
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
  const width = Math.min(1400, Math.round(area.width * 0.85));
  const height = Math.min(920, Math.round(area.height * 0.85));
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    minWidth: 760,
    minHeight: 480,
    show: false,
    title: 'Snapit',
    icon: path.join(ASSETS, 'icon.png'),
    backgroundColor: '#141418',
    autoHideMenuBar: true,
    webPreferences: secureWebPreferences,
  });
  lockDownNavigation(win);

  const id = win.webContents.id;
  editors.set(id, { win, hasImage: Boolean(payload) });
  if (payload) pendingImages.set(id, payload);

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  // L'éditeur bloque la fermeture s'il reste des annotations non enregistrées.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Fermer sans enregistrer', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      title: 'Snapit',
      message: 'Cette capture contient des modifications non enregistrées.',
      detail: 'Voulez-vous vraiment fermer la fenêtre ?',
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
        title: 'Snapit reste actif',
        content: `Appuyez sur ${primaryShortcutLabel()} pour capturer. Clic droit sur l'icône pour plus d'options.`,
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

// Charge l'image dans un éditeur vide s'il y en a un, sinon ouvre une nouvelle fenêtre.
function openImageInEditor(payload) {
  const empty = liveEditors().find((e) => !e.hasImage);
  if (empty) {
    empty.hasImage = true;
    empty.win.webContents.send('editor:load', payload);
    focusWindow(empty.win);
    return empty.win;
  }
  return createEditor(payload);
}

async function readImageFile(filePath) {
  const mime = IMAGE_TYPES[path.extname(filePath).toLowerCase()];
  if (!mime) throw new Error('Format de fichier non pris en charge.');
  const data = await fs.readFile(filePath);
  return {
    dataUrl: `data:${mime};base64,${data.toString('base64')}`,
    name: path.basename(filePath, path.extname(filePath)),
    scaleFactor: 1,
  };
}

async function openImageFromDialog(parent) {
  const { canceled, filePaths } = await dialog.showOpenDialog(parent ?? undefined, {
    title: 'Ouvrir une image',
    defaultPath: app.getPath('pictures'),
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: Object.keys(IMAGE_TYPES).map((e) => e.slice(1)) }],
  });
  if (canceled || !filePaths.length) return null;
  return readImageFile(filePaths[0]);
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

function hideEditorsForCapture() {
  const hidden = liveEditors()
    .map((e) => e.win)
    .filter((w) => w.isVisible() && !w.isMinimized());
  hidden.forEach((w) => w.hide());
  return hidden;
}

function restoreEditors(hidden) {
  hidden.filter((w) => !w.isDestroyed()).forEach((w) => w.showInactive());
}

async function startCapture(mode = 'region') {
  if (capturing) return;
  capturing = true;
  const hidden = hideEditorsForCapture();
  try {
    if (mode === 'delay') {
      await delay(CAPTURE_DELAY_MS);
      mode = 'region';
    }
    // Laisse le temps à Windows de retirer nos fenêtres (et le menu de la zone de notification) de l'écran.
    await delay(hidden.length ? 250 : 180);
    const captures = await grabDisplays();
    if (!captures.length) throw new Error("Aucun écran n'a pu être capturé.");

    let result;
    if (mode === 'fullscreen') {
      const target = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const c = captures.find((c) => c.display.id === target.id) ?? captures[0];
      result = { image: c.image, scaleFactor: c.display.scaleFactor };
    } else {
      result = await selectRegion(captures);
    }

    restoreEditors(hidden);
    if (result) {
      openImageInEditor({
        dataUrl: result.image.toDataURL(),
        scaleFactor: result.scaleFactor,
        name: captureName(),
      });
    }
  } catch (err) {
    restoreEditors(hidden);
    dialog.showErrorBox('Capture impossible', String(err?.message ?? err));
  } finally {
    capturing = false;
  }
}

function captureName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Capture ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} à ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
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

    const shown = captures.map(async (c) => {
      const overlay = getOverlay(c.display);
      await overlay.ready;
      const wc = overlay.win.webContents;
      const ack = new Promise((r) => overlayAcks.set(wc.id, r));
      // JPEG : bien plus rapide à encoder que PNG, et suffisant pour l'aperçu figé.
      wc.send('overlay:show', {
        dataUrl: `data:image/jpeg;base64,${c.image.toJPEG(92).toString('base64')}`,
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
// IPC éditeur
// ---------------------------------------------------------------------------

ipcMain.handle('capture', (_e, mode) => startCapture(mode));

ipcMain.handle('editor:initial', (e) => {
  const payload = pendingImages.get(e.sender.id) ?? null;
  pendingImages.delete(e.sender.id);
  return payload;
});

ipcMain.on('editor:state', (e, { hasImage }) => {
  const entry = editors.get(e.sender.id);
  if (entry) entry.hasImage = Boolean(hasImage);
});

ipcMain.handle('editor:open-new', (_e, payload) => {
  openImageInEditor(payload);
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  shortcuts: registeredShortcuts.map(([, mode, label]) => ({ mode, label })),
}));

ipcMain.handle('clipboard:write-image', async (_e, dataUrl) => {
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
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
  const safeName = String(suggestedName || 'Capture').replace(/[\\/:*?"<>|]/g, '-');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Enregistrer l'image",
    defaultPath: path.join(lastSaveDir ?? app.getPath('pictures'), `${safeName}.png`),
    filters: [
      { name: 'Image PNG', extensions: ['png'] },
      { name: 'Image JPEG', extensions: ['jpg', 'jpeg'] },
    ],
  });
  if (canceled || !filePath) return null;

  const ext = path.extname(filePath).toLowerCase();
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  const data = ext === '.jpg' || ext === '.jpeg' ? nativeImage.createFromBuffer(png).toJPEG(92) : png;
  await fs.writeFile(filePath, data);
  lastSaveDir = path.dirname(filePath);
  return filePath;
});

ipcMain.handle('file:open-image', (e) => openImageFromDialog(BrowserWindow.fromWebContents(e.sender)));

// ---------------------------------------------------------------------------
// Zone de notification & raccourcis
// ---------------------------------------------------------------------------

function registerShortcuts() {
  registeredShortcuts = SHORTCUTS.filter(([accelerator, mode]) => {
    try {
      return globalShortcut.register(accelerator, () => startCapture(mode));
    } catch {
      return false;
    }
  });
}

function primaryShortcutLabel() {
  return registeredShortcuts.find(([, mode]) => mode === 'region')?.[2] ?? 'le menu de Snapit';
}

function shortcutFor(mode) {
  return registeredShortcuts.find(([, m]) => m === mode)?.[0];
}

function buildTrayMenu() {
  const template = [
    { label: 'Capturer une zone', accelerator: shortcutFor('region'), registerAccelerator: false, click: () => startCapture('region') },
    { label: "Capturer l'écran entier", accelerator: shortcutFor('fullscreen'), registerAccelerator: false, click: () => startCapture('fullscreen') },
    { label: 'Capture différée (3 s)', click: () => startCapture('delay') },
    { type: 'separator' },
    { label: "Ouvrir l'éditeur", click: showEditor },
    {
      label: 'Ouvrir une image…',
      click: async () => {
        try {
          const payload = await openImageFromDialog();
          if (payload) openImageInEditor(payload);
        } catch (err) {
          dialog.showErrorBox('Ouverture impossible', String(err?.message ?? err));
        }
      },
    },
    { type: 'separator' },
  ];
  if (app.isPackaged) {
    template.push({
      label: 'Lancer au démarrage de Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
    });
    template.push({ type: 'separator' });
  }
  template.push({
    label: 'Quitter Snapit',
    click: () => {
      quitting = true;
      app.quit();
    },
  });
  return Menu.buildFromTemplate(template);
}

function createTray() {
  tray = new Tray(path.join(ASSETS, 'tray.png'));
  tray.setToolTip('Snapit — capture d’écran');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showEditor);
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.snapit.app');
  Menu.setApplicationMenu(null);
  registerShortcuts();
  createTray();

  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, destroyOverlays);
  }

  if (!process.argv.includes('--hidden')) createEditor();
});

// L'application vit dans la zone de notification : fermer les fenêtres ne la quitte pas.
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

module.exports = { startCapture, openImageInEditor };
