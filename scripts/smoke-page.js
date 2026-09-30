// Page de test de la capture défilante (test de fumée), ouverte comme un navigateur ordinaire : dans un
// processus à part (Chromium cesse de dessiner les fenêtres de son propre processus recouvertes par l'overlay)
// et sans rester au premier plan (le défilement par UI Automation active la fenêtre, qui passerait alors
// au-dessus de l'overlay).
// Usage : electron smoke-page.js <fichier HTML> <x> <y> <largeur> <hauteur> <scrollY>
// Sortie : "ready <fenêtre>" une fois la page affichée (handle de la fenêtre), puis "scrollY <n>" à chaque
// changement de position.
'use strict';

const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');

const [file, x, y, width, height, scrollY] = process.argv.slice(2);
app.setPath('userData', path.join(os.tmpdir(), 'snapit-smoke', 'page'));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    x: Number(x),
    y: Number(y),
    width: Number(width),
    height: Number(height),
    frame: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
  });
  await win.loadFile(file);
  await win.webContents.executeJavaScript(`scrollTo(0, ${Number(scrollY) || 0})`);
  win.showInactive(); // au premier plan le temps d'arriver devant les autres fenêtres…
  await new Promise((resolve) => setTimeout(resolve, 200));
  win.setAlwaysOnTop(false); // … où elle reste
  process.stdout.write(`ready ${win.getNativeWindowHandle().readBigUInt64LE()}\n`);

  let last = null;
  setInterval(async () => {
    const position = await win.webContents.executeJavaScript('scrollY');
    if (position !== last) process.stdout.write(`scrollY ${position}\n`);
    last = position;
  }, 100);
});
