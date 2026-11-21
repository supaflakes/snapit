// Mesures de référence avant la migration vers Tauri (docs/plan-migration-tauri.md, phase 0) :
// démarrage, mémoire, délai entre la demande de capture et l'affichage de l'overlay, capture plein écran,
// taille de l'installeur. Les mêmes mesures serviront à comparer la version Tauri.
// Usage : npm run measure   (dossier de sortie : SNAPIT_MEASURE_OUT ou %TEMP%\snapit-measure)
'use strict';

const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T0 = performance.now(); // le plus tôt possible : avant le chargement de l'application

const OUT = process.env.SNAPIT_MEASURE_OUT || path.join(os.tmpdir(), 'snapit-measure');
const RUNS = 5;

// Profil et bibliothèque propres aux mesures, comme le test de fumée.
const PROFILE = path.join(OUT, 'profil');
const LIBRARY = path.join(OUT, 'bibliotheque');
fs.rmSync(LIBRARY, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify({ version: 2, libraryFolder: LIBRARY }));
app.setPath('userData', PROFILE);

let firstEditorShown = null;
// Étapes de l'affichage de l'overlay : image envoyée à l'overlay, overlay prêt (image décodée et dessinée)
let phases = {};
app.on('browser-window-created', (_e, win) => {
  win.once('ready-to-show', () => {
    // depuis le lancement du processus, chargement d'Electron compris
    if (firstEditorShown === null && win.webContents.getURL().includes('/editor/')) firstEditorShown = process.uptime() * 1000;
  });
  const send = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, ...args) => {
    if (channel === 'overlay:show') phases.sent ??= performance.now();
    return send(channel, ...args);
  };
});
app.whenReady().then(() => ipcMain.on('overlay:ready', () => (phases.ready ??= performance.now())));
// début et fin de la capture de l'écran par Electron
const getSources = desktopCapturer.getSources.bind(desktopCapturer);
desktopCapturer.getSources = async (...args) => {
  phases.grabStart ??= performance.now();
  try {
    return await getSources(...args);
  } finally {
    phases.grabEnd = performance.now();
    phases.grabWith = 'Electron';
  }
};
// même chose pour la capture par l'assistant natif (un appel par écran)
function watchNativeGrab(regions) {
  const grab = regions.grab.bind(regions);
  regions.grab = async (...args) => {
    phases.grabStart ??= performance.now();
    try {
      return await grab(...args);
    } finally {
      phases.grabEnd = performance.now();
      phases.grabWith ??= 'native';
    }
  };
}

const snapit = require('../src/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const isOverlay = (w) => !w.isDestroyed() && w.webContents.getURL().includes('/overlay/');
const editorWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('/editor/'));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const ms = (v) => (v == null ? '—' : `${Math.round(v)} ms`);
const mb = (kb) => `${Math.round(kb / 1024)} Mo`;

async function until(test, timeout = 5000, step = 2) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    if (test()) return performance.now();
    await wait(step);
  }
  return null;
}

// Mémoire de travail de Snapit : processus Electron et assistants natifs (en Ko).
function memory() {
  const electron = app.getAppMetrics().reduce((sum, p) => sum + (p.memory?.workingSetSize ?? 0), 0);
  const pids = [snapit.getHotkeys()?.helper?.child?.pid, snapit.getRegions()?.child?.pid].filter(Boolean);
  let helpers = 0;
  for (const pid of pids) {
    try {
      const line = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).toString();
      const kb = line.split('","')[4]?.replace(/[^\d]/g, '');
      helpers += Number(kb) || 0;
    } catch {
      // processus déjà terminé
    }
  }
  return { electron, helpers, total: electron + helpers };
}

async function closeVisibleOverlay() {
  const overlay = BrowserWindow.getAllWindows().find((w) => isOverlay(w) && w.isVisible());
  if (overlay) {
    overlay.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    overlay.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  }
  await until(() => !BrowserWindow.getAllWindows().some((w) => isOverlay(w) && w.isVisible()), 3000, 20);
}

// Demande de capture de zone → overlay visible (le raccourci clavier arrive au même endroit).
async function overlayLatency() {
  phases = {};
  const start = performance.now();
  const pending = snapit.startCapture('region');
  const shown = await until(() => BrowserWindow.getAllWindows().some((w) => isOverlay(w) && w.isVisible()));
  await wait(200);
  await closeVisibleOverlay();
  await pending;
  await wait(300);
  const at = (t) => (t == null ? null : t - start);
  overlaySteps.push({ grabWith: phases.grabWith, grabStart: at(phases.grabStart), grabEnd: at(phases.grabEnd), sent: at(phases.sent), ready: at(phases.ready), shown: at(shown) });
  return shown && shown - start;
}
const overlaySteps = []; // pour chaque capture : envoi de l'image, overlay prêt, overlay visible (ms depuis la demande)

// Capture plein écran → image affichée dans l'éditeur (copie et bibliothèque comprises).
async function fullscreenLatency() {
  for (const win of editorWindows()) await win.webContents.executeJavaScript('window.__measureBase = state.base; true');
  const start = performance.now();
  snapit.startCapture('fullscreen');
  while (performance.now() - start < 8000) {
    for (const win of editorWindows()) {
      const ok = await win.webContents
        .executeJavaScript('Boolean(state.base) && state.base !== window.__measureBase')
        .catch(() => false);
      if (ok) return performance.now() - start;
    }
    await wait(10);
  }
  return null;
}

function installerSize() {
  const dir = path.join(__dirname, '..', 'dist');
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.exe'))
    .map((f) => ({ f, stat: fs.statSync(path.join(dir, f)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return files[0] ? { file: files[0].f, bytes: files[0].stat.size } : null;
}

app.whenReady().then(async () => {
  const results = {};
  try {
    // Démarrage : jusqu'à l'affichage de l'éditeur
    await until(() => firstEditorShown !== null, 15000, 20);
    results.startupMs = firstEditorShown;

    // Assistants prêts (compilés au premier lancement)
    const hotkeys = snapit.getHotkeys();
    const regions = snapit.getRegions();
    watchNativeGrab(regions);
    await until(() => hotkeys.getStatus().hookAvailable || hotkeys.getStatus().hookFailed, 30000, 50);
    await until(() => Boolean(regions.child), 30000, 50);
    await wait(3000);
    results.memoryEditorOpen = memory();

    // Délai jusqu'à l'overlay : la première fois (fenêtres à créer), puis les suivantes
    results.overlayColdMs = await overlayLatency();
    const warm = [];
    for (let i = 0; i < RUNS; i++) warm.push(await overlayLatency());
    results.overlayWarmMs = warm;
    results.overlayWarmMedianMs = median(warm.filter((v) => v != null));
    results.overlaySteps = overlaySteps;
    const step = (k) => median(overlaySteps.slice(1).map((s) => s[k]).filter((v) => v != null));
    results.overlayStepsMedianMs = { grabStart: step('grabStart'), grabEnd: step('grabEnd'), sent: step('sent'), ready: step('ready'), shown: step('shown') };

    // Capture plein écran jusqu'à l'image dans l'éditeur
    const full = [];
    for (let i = 0; i < RUNS; i++) {
      full.push(await fullscreenLatency());
      await wait(500);
    }
    results.fullscreenMs = full;
    results.fullscreenMedianMs = median(full.filter((v) => v != null));

    // Mémoire au repos : toutes les fenêtres d'édition fermées, Snapit dans la zone de notification
    for (const win of editorWindows()) win.close();
    await until(() => editorWindows().length === 0, 15000, 50);
    await wait(5000);
    results.memoryTrayOnly = memory();

    results.installer = installerSize();
    results.screens = require('electron').screen.getAllDisplays().map((d) => `${d.size.width}×${d.size.height} @${d.scaleFactor}`);
    results.date = new Date().toISOString();
    results.version = require('../package.json').version;
    results.processes = app.getAppMetrics().map((p) => ({ type: p.type, kb: p.memory?.workingSetSize ?? 0 }));

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'mesures.json'), JSON.stringify(results, null, 2));

    const lines = [
      `Snapit ${results.version} — écrans : ${results.screens.join(', ')}`,
      `Démarrage jusqu'à l'éditeur affiché        ${ms(results.startupMs)}`,
      `Overlay affiché, première capture          ${ms(results.overlayColdMs)}`,
      `Overlay affiché, captures suivantes        ${ms(results.overlayWarmMedianMs)} (médiane de ${RUNS} : ${warm.map((v) => Math.round(v ?? NaN)).join(', ')})`,
      `  attente avant la capture                 ${ms(results.overlayStepsMedianMs.grabStart)}`,
      `  capture de l'écran (${overlaySteps.at(-1)?.grabWith ?? '?'})${' '.repeat(Math.max(1, 20 - (overlaySteps.at(-1)?.grabWith ?? '?').length))}${ms(results.overlayStepsMedianMs.grabEnd - results.overlayStepsMedianMs.grabStart)}`,
      `  préparation et envoi à l'overlay         ${ms(results.overlayStepsMedianMs.sent - results.overlayStepsMedianMs.grabEnd)}`,
      `  overlay prêt puis affiché                ${ms(results.overlayStepsMedianMs.shown - results.overlayStepsMedianMs.sent)}`,
      `Capture plein écran → éditeur              ${ms(results.fullscreenMedianMs)} (médiane de ${RUNS} : ${full.map((v) => Math.round(v ?? NaN)).join(', ')})`,
      `Mémoire, éditeur ouvert                    ${mb(results.memoryEditorOpen.total)} (assistants C# : ${mb(results.memoryEditorOpen.helpers)})`,
      `Mémoire au repos, zone de notification     ${mb(results.memoryTrayOnly.total)} (assistants C# : ${mb(results.memoryTrayOnly.helpers)})`,
      `Installeur                                 ${results.installer ? `${(results.installer.bytes / 1024 / 1024).toFixed(1)} Mo (${results.installer.file})` : '— (npm run dist)'}`,
      `Détail : ${path.join(OUT, 'mesures.json')}`,
    ];
    console.log(`\n${lines.join('\n')}\n`);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.exit(process.exitCode ?? 0);
});
