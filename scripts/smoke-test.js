// Test de fumée de bout en bout : lance l'application, fait une capture plein écran,
// une capture de zone (souris simulée dans l'overlay), dessine des annotations,
// puis enregistre des images de contrôle.
// Usage : npm run smoke   (dossier de sortie : SNAPIT_SMOKE_OUT ou %TEMP%\snapit-smoke)
'use strict';

const { app, BrowserWindow, clipboard, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const snapit = require('../src/main.js');

const OUT = process.env.SNAPIT_SMOKE_OUT || path.join(os.tmpdir(), 'snapit-smoke');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

async function savePage(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), image.toPNG());
}

const editorWindows = () =>
  BrowserWindow.getAllWindows().filter((w) => w.isVisible() && w.webContents.getURL().includes('/editor/'));

async function drag(win, from, to, steps = 12) {
  const wc = win.webContents;
  wc.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
  wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers: ['leftButtonDown'] });
    await wait(16);
  }
  wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  await wait(80);
}

async function key(win, keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await wait(50);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  try {
    await wait(2000);
    const [home] = editorWindows();
    check("l'éditeur s'ouvre au démarrage", Boolean(home));
    await savePage(home, '0-accueil.png');

    // 1. Plein écran : l'image doit arriver dans l'éditeur vide existant
    await snapit.startCapture('fullscreen');
    await wait(1200);
    const full = await home.webContents.executeJavaScript('[document.body.classList.contains("has-image"), canvas.width, canvas.height]');
    check('capture plein écran chargée dans l’éditeur', full[0] && full[1] > 0, `${full[1]}×${full[2]}`);
    await savePage(home, '1-plein-ecran.png');

    // 2. Zone : sélection simulée dans l'overlay, doit ouvrir un nouvel éditeur
    const pending = snapit.startCapture('region');
    let overlay = null;
    for (let i = 0; i < 40 && !overlay; i++) {
      await wait(100);
      overlay = BrowserWindow.getAllWindows().find((w) => w.isVisible() && w.webContents.getURL().includes('/overlay/'));
    }
    check("l'overlay de sélection s'affiche", Boolean(overlay));
    if (overlay) {
      await wait(300);
      // Chaque overlay doit couvrir exactement son écran, en pixels physiques.
      const overlayWindows = BrowserWindow.getAllWindows().filter((w) => w.isVisible() && w.webContents.getURL().includes('/overlay/'));
      check('un overlay par écran', overlayWindows.length === screen.getAllDisplays().length, `${overlayWindows.length} overlay(s)`);
      for (const win of overlayWindows) {
        const [iw, ih, dpr, nw, nh] = await win.webContents.executeJavaScript('[innerWidth, innerHeight, devicePixelRatio, shot.naturalWidth, shot.naturalHeight]');
        const display = screen.getDisplayMatching(win.getBounds());
        const covers = Math.abs(iw * dpr - nw) <= 2 && Math.abs(ih * dpr - nh) <= 2;
        check(`overlay couvre l'écran ${display.bounds.width}×${display.bounds.height} @${display.scaleFactor}`, covers, `page ${iw}×${ih} @${dpr}, image ${nw}×${nh}`);
      }
      overlay.webContents.sendInputEvent({ type: 'mouseMove', x: 180, y: 140 });
      await wait(150);
      await savePage(overlay, '2-overlay.png');
      await drag(overlay, { x: 180, y: 140 }, { x: 900, y: 620 });
    }
    await pending;
    await wait(1500);
    const editors = editorWindows();
    const region = editors.find((w) => w !== home);
    check('la capture de zone ouvre un nouvel éditeur', Boolean(region), `${editors.length} éditeur(s)`);

    if (region) {
      const [w, h, scale] = await region.webContents.executeJavaScript('[canvas.width, canvas.height, state.scale]');
      check('taille de la zone capturée cohérente', w > 600 && h > 400, `${w}×${h}`);
      const rect = await region.webContents.executeJavaScript('(() => { const r = canvas.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
      const at = (fx, fy) => ({ x: Math.round(rect.x + rect.w * fx), y: Math.round(rect.y + rect.h * fy) });

      await key(region, 'a');
      await drag(region, at(0.15, 0.2), at(0.45, 0.5));
      await key(region, 'r');
      await drag(region, at(0.5, 0.45), at(0.85, 0.8));
      await key(region, 'n');
      await drag(region, at(0.12, 0.7), at(0.12, 0.7), 1);
      await drag(region, at(0.3, 0.75), at(0.3, 0.75), 1);
      await key(region, 'b');
      await drag(region, at(0.55, 0.1), at(0.9, 0.3));
      await key(region, 't');
      await drag(region, at(0.2, 0.85), at(0.2, 0.85), 1);
      await wait(150);
      region.webContents.insertText('Cliquez ici');
      await wait(100);
      await key(region, 'Enter', ['control']);

      const shapes = await region.webContents.executeJavaScript('state.shapes.map((s) => s.type + (s.n ? s.n : "") + (s.text ? ":" + s.text : ""))');
      check('annotations créées', shapes.length === 6, shapes.join(', '));

      await key(region, 'z', ['control']);
      const afterUndo = await region.webContents.executeJavaScript('state.shapes.length');
      check('Ctrl+Z annule la dernière annotation', afterUndo === 5);
      await key(region, 'y', ['control']);
      const afterRedo = await region.webContents.executeJavaScript('state.shapes.length');
      check('Ctrl+Y rétablit', afterRedo === 6);

      await key(region, 'c', ['control']);
      await wait(500);
      const items = await clipboard.read();
      check('Ctrl+C copie l’image dans le presse-papiers', items.some((i) => i.types.some((t) => t.startsWith('image/'))), items.map((i) => i.types.join('+')).join(', '));
      await savePage(region, '3-annotations.png');
      const exported = await region.webContents.executeJavaScript('exportCanvas().toDataURL()');
      fs.writeFileSync(path.join(OUT, '4-export.png'), Buffer.from(exported.split(',')[1], 'base64'));
      check('export PNG', exported.length > 1000, `${Math.round(exported.length / 1024)} Ko`);
      console.log(`échelle d'affichage : ${scale.toFixed(3)}`);
    }
  } catch (err) {
    check('exécution sans erreur', false, err.stack);
  }
  console.log(`\nImages de contrôle : ${OUT}`);
  console.log(failures.length ? `${failures.length} échec(s)` : 'Tous les contrôles sont passés.');
  app.exit(failures.length ? 1 : 0);
});
