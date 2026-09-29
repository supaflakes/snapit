// Test de fumée de bout en bout : lance l'application, fait une capture plein écran,
// une capture de zone (souris simulée dans l'overlay), dessine des annotations,
// vérifie la bibliothèque et la galerie, puis enregistre des images de contrôle.
// Usage : npm run smoke   (dossier de sortie : SNAPIT_SMOKE_OUT ou %TEMP%\snapit-smoke)
'use strict';

const { app, BrowserWindow, clipboard, nativeImage, screen } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = process.env.SNAPIT_SMOKE_OUT || path.join(os.tmpdir(), 'snapit-smoke');

// Profil et bibliothèque propres au test : les paramètres et les captures de l'utilisateur restent
// intacts, et une instance de Snapit déjà ouverte ne capte pas le lancement (instance unique).
const PROFILE = path.join(OUT, 'profil');
const LIBRARY = path.join(OUT, 'bibliotheque');
fs.rmSync(LIBRARY, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
fs.writeFileSync(path.join(PROFILE, 'settings.json'), JSON.stringify({ version: 2, libraryFolder: LIBRARY }));
app.setPath('userData', PROFILE);

const snapit = require('../src/main.js');
const { SettingsStore } = require('../src/settings.js');

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

// Simule un vrai appui sur Impr. écran, au niveau du système (comme le clavier physique).
function pressPrintScreen() {
  const script = [
    "$sig = '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'",
    '$k = Add-Type -MemberDefinition $sig -Name K -Namespace SnapitSmoke -PassThru',
    '$k::keybd_event(0x2C, 0, 0, [UIntPtr]::Zero)',
    '$k::keybd_event(0x2C, 0, 2, [UIntPtr]::Zero)',
  ].join('\n');
  execFileSync('powershell', ['-NoProfile', '-Command', script]);
}

// Simule la macro de nombreux claviers pour Impr. écran : Win+Maj+S en quelques millisecondes.
// Renvoie les titres des fenêtres passées au premier plan juste après (pour repérer le menu Démarrer)
// et le nombre de processus de l'Outil Capture avant / après.
function pressWinShiftS() {
  const script = [
    'Add-Type @"',
    'using System; using System.Text; using System.Runtime.InteropServices;',
    'public static class SmokeKeys {',
    '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  public static string Foreground() { var sb = new StringBuilder(256); GetWindowText(GetForegroundWindow(), sb, 256); return sb.ToString(); }',
    '}',
    '"@',
    '$before = @(Get-Process ScreenClippingHost -ErrorAction SilentlyContinue).Count',
    '[SmokeKeys]::keybd_event(0x5B, 0x5B, 1, [UIntPtr]::Zero)',
    '[SmokeKeys]::keybd_event(0xA0, 0x2A, 0, [UIntPtr]::Zero)',
    '[SmokeKeys]::keybd_event(0x53, 0x1F, 0, [UIntPtr]::Zero)',
    'Start-Sleep -Milliseconds 70',
    '[SmokeKeys]::keybd_event(0x53, 0x1F, 2, [UIntPtr]::Zero)',
    '[SmokeKeys]::keybd_event(0xA0, 0x2A, 2, [UIntPtr]::Zero)',
    '[SmokeKeys]::keybd_event(0x5B, 0x5B, 3, [UIntPtr]::Zero)',
    '$titles = @(); for ($i = 0; $i -lt 16; $i++) { Start-Sleep -Milliseconds 60; $titles += [SmokeKeys]::Foreground() }',
    '$after = @(Get-Process ScreenClippingHost -ErrorAction SilentlyContinue).Count',
    '"$before|$after|" + (($titles | Select-Object -Unique) -join ";")',
  ].join('\n');
  const [before, after, titles] = execFileSync('powershell', ['-NoProfile', '-Command', script]).toString().trim().split('|');
  return { snippingBefore: Number(before), snippingAfter: Number(after), titles: titles.split(';').filter(Boolean) };
}

async function closeOverlay() {
  const isOverlay = (w) => w.isVisible() && w.webContents.getURL().includes('/overlay/');
  const visible = BrowserWindow.getAllWindows().find(isOverlay);
  if (visible) await key(visible, 'Escape');
  for (let i = 0; i < 20 && BrowserWindow.getAllWindows().some(isOverlay); i++) await wait(100);
  await wait(500);
}

async function key(win, keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await wait(50);
}

async function clipboardImageSize() {
  for (const item of await clipboard.read()) {
    const type = item.types.find((t) => t.startsWith('image/'));
    if (!type) continue;
    const data = Buffer.from(await (await item.getType(type)).arrayBuffer());
    return nativeImage.createFromBuffer(data).getSize();
  }
  return null;
}

// Attend qu'une condition (évaluée dans une fenêtre) soit vraie.
async function until(win, expression, timeout = 4000) {
  for (let t = 0; t < timeout; t += 100) {
    if (await win.webContents.executeJavaScript(expression)) return true;
    await wait(100);
  }
  return false;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  try {
    // Paramètres d'une version précédente : la copie automatique devient active par défaut
    const legacy = path.join(OUT, 'settings-v1.json');
    fs.writeFileSync(legacy, JSON.stringify({ copyAfterCapture: false, captureDelay: 5 }));
    const migrated = new SettingsStore(legacy).get();
    check('anciens paramètres : copie automatique activée', migrated.copyAfterCapture && migrated.captureDelay === 5);

    await wait(2000);
    const [home] = editorWindows();
    check("l'éditeur s'ouvre au démarrage", Boolean(home));
    const library = snapit.getLibrary();
    library.trash = async (file) => fs.rmSync(file); // pas de passage par la corbeille de l'utilisateur
    await savePage(home, '0-accueil.png');

    // 0. Impr. écran : l'assistant clavier doit la prendre avant l'Outil Capture de Windows
    const hotkeys = snapit.getHotkeys();
    for (let i = 0; i < 100 && !hotkeys.getStatus().hookAvailable && !hotkeys.getStatus().hookFailed; i++) await wait(100);
    const status = hotkeys.getStatus();
    check('assistant clavier démarré', status.hookAvailable, JSON.stringify(status.shortcuts));
    if (status.hookAvailable) {
      pressPrintScreen();
      let overlayShown = false;
      for (let i = 0; i < 40 && !overlayShown; i++) {
        await wait(100);
        overlayShown = BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.webContents.getURL().includes('/overlay/'));
      }
      check('Impr. écran ouvre la sélection Snapit', overlayShown);
      await closeOverlay();

      const macro = pressWinShiftS();
      let macroOverlay = false;
      for (let i = 0; i < 40 && !macroOverlay; i++) {
        await wait(100);
        macroOverlay = BrowserWindow.getAllWindows().some((w) => w.isVisible() && w.webContents.getURL().includes('/overlay/'));
      }
      check('Win+Maj+S (macro « Impr. écran » du clavier) ouvre la sélection Snapit', macroOverlay);
      check('l’Outil Capture ne s’ouvre pas', macro.snippingAfter <= macro.snippingBefore, `${macro.snippingBefore} → ${macro.snippingAfter}`);
      const startMenu = macro.titles.some((title) => /^(Démarrer|Start|Rechercher|Search)$/.test(title));
      check('le menu Démarrer ne s’ouvre pas', !startMenu, macro.titles.join(' / ') || '(aucun titre)');
      await closeOverlay();
    }

    // 0 bis. Paramètres : fenêtre, langue répercutée dans l'éditeur
    snapit.openSettings();
    let settingsWin = null;
    for (let i = 0; i < 40 && !settingsWin; i++) {
      await wait(100);
      settingsWin = BrowserWindow.getAllWindows().find((w) => w.isVisible() && w.webContents.getURL().includes('/settings/'));
    }
    check('la fenêtre Paramètres s’ouvre', Boolean(settingsWin));
    if (settingsWin) {
      await wait(500);
      const shortcut = await settingsWin.webContents.executeJavaScript('document.querySelector(".shortcut").textContent');
      check('raccourci affiché dans les paramètres', shortcut.length > 0, shortcut);
      await savePage(settingsWin, '0-parametres.png');
      snapit.getSettings().set({ language: 'en' });
      await wait(400);
      const english = await home.webContents.executeJavaScript('document.querySelector("#btn-capture span").textContent');
      check('changer de langue traduit l’éditeur', english === 'Capture', english);
      snapit.getSettings().set({ language: 'auto' });
      settingsWin.close();
      await wait(300);
    }

    // 0 ter. Détection des zones : une fenêtre de test, puis un élément de sa page (UI Automation),
    // se mettent en surbrillance sous la souris ; Échap annule sans rien capturer
    const regions = snapit.getRegions();
    for (let i = 0; i < 150 && !regions.child; i++) await wait(100);
    check('assistant de détection des zones démarré', Boolean(regions.child));
    if (regions.child) {
      const primary = screen.getPrimaryDisplay();
      const target = new BrowserWindow({
        x: primary.bounds.x + 300,
        y: primary.bounds.y + 200,
        width: 640,
        height: 420,
        frame: false,
        resizable: false,
        show: false,
        skipTaskbar: true,
        alwaysOnTop: true,
      });
      const page = '<body style="margin:0;background:#1e293b"><div role="img" aria-label="Image" style="position:absolute;left:40px;top:90px;width:300px;height:200px;background:#f59e0b"></div></body>';
      await target.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
      target.showInactive();
      await wait(600);
      const detecting = snapit.startCapture('region');
      let overlayWin = null;
      for (let i = 0; i < 60 && !overlayWin; i++) {
        await wait(50);
        overlayWin = BrowserWindow.getAllWindows().find(
          (w) => w.isVisible() && w.webContents.getURL().includes('/overlay/') && screen.getDisplayMatching(w.getBounds()).id === primary.id,
        );
      }
      if (overlayWin) {
        await wait(300);
        // attendus en pixels de l'image de l'écran
        const sf = primary.scaleFactor;
        const origin = screen.dipToScreenRect(null, primary.bounds);
        const tb = screen.dipToScreenRect(null, target.getBounds());
        const cb = screen.dipToScreenRect(null, target.getContentBounds());
        const frame = [tb.x - origin.x, tb.y - origin.y, tb.width, tb.height];
        const image = [cb.x - origin.x + Math.round(40 * sf), cb.y - origin.y + Math.round(90 * sf), Math.round(300 * sf), Math.round(200 * sf)];
        // la page d'une fenêtre sans cadre peut être décalée de quelques pixels selon l'échelle de l'écran
        const near = (a, b, tolerance = 8) => Boolean(a) && a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
        // survole un point jusqu'à ce que la zone attendue soit en surbrillance (les éléments arrivent après la fenêtre)
        const hoverUntil = async (x, y, expected) => {
          let h = null;
          for (let i = 0; i < 30 && !near(h, expected); i++) {
            overlayWin.webContents.sendInputEvent({ type: 'mouseMove', x: x + (i % 2), y });
            await wait(120);
            h = await overlayWin.webContents.executeJavaScript('hovered && [hovered.x, hovered.y, hovered.w, hovered.h]');
          }
          return h;
        };
        const onWindow = await hoverUntil(320, 600, frame);
        check('détection : la fenêtre sous la souris', near(onWindow, frame), `${JSON.stringify(onWindow)}, attendu ${JSON.stringify(frame)}`);
        const onImage = await hoverUntil(490, 390, image);
        check('détection : l’élément de page sous la souris', near(onImage, image), `${JSON.stringify(onImage)}, attendu ${JSON.stringify(image)}`);
        await savePage(overlayWin, '0-detection.png');
        await key(overlayWin, 'Escape');
      }
      await detecting;
      target.destroy();
    }

    // 1. Plein écran : l'image doit arriver dans l'éditeur vide existant
    await snapit.startCapture('fullscreen');
    await wait(1200);
    const full = await home.webContents.executeJavaScript('[document.body.classList.contains("has-image"), canvas.width, canvas.height]');
    check('capture plein écran chargée dans l’éditeur', full[0] && full[1] > 0, `${full[1]}×${full[2]}`);
    const copied = await clipboardImageSize();
    check('capture copiée dans le presse-papiers', copied?.width === full[1] && copied?.height === full[2], copied && `${copied.width}×${copied.height}`);
    await savePage(home, '1-plein-ecran.png');

    // Bibliothèque : capture enregistrée (image visible + données d'édition), affichée dans la galerie
    const [fullItem] = await library.list();
    const dataFile = (id, ext) => path.join(LIBRARY, '.snapit', `${id}${ext}`);
    const stored = fullItem && ['.json', '.png', '.jpg'].every((ext) => fs.existsSync(dataFile(fullItem.id, ext)));
    check('capture enregistrée dans la bibliothèque', stored && fs.existsSync(library.imagePath(fullItem.id)), fullItem?.name);
    const fullId = fullItem?.id;
    const shown = await until(home, `state.libraryId === ${JSON.stringify(fullId)} && document.querySelectorAll('.shot').length === 1 && document.querySelector('.shot-open[aria-current="true"]')?.parentElement.dataset.id === state.libraryId`);
    check('la galerie affiche la capture, mise en évidence', shown);

    // 2. Zone : sélection simulée dans l'overlay ; la capture remplace la précédente dans le même
    // éditeur (galerie affichée : la précédente reste accessible d'un clic)
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
    const regionId = await home.webContents.executeJavaScript('state.libraryId');
    const reused = editors.length === 1 && regionId && regionId !== fullId;
    check('la capture de zone s’affiche dans le même éditeur', reused, `${editors.length} éditeur(s)`);
    const galleryCount = await home.webContents.executeJavaScript('document.querySelectorAll(".shot").length');
    check('la galerie contient les deux captures', galleryCount === 2, `${galleryCount} miniature(s)`);
    const region = reused ? home : null;

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

      // Réglages : modifier une annotation sélectionnée, puis annuler
      const props = await region.webContents.executeJavaScript(`(() => {
        const arrow = state.shapes.find((s) => s.type === 'arrow');
        select(arrow);
        // les réglages sont mémorisés d'une session à l'autre : on choisit des valeurs différentes des actuelles
        const heads = arrow.heads === 'both' ? 'start' : 'both';
        const original = arrow.outline;
        const outline = original === '#ffffff' ? '#1c1c1f' : '#ffffff';
        setProp('heads', heads);
        setProp('outline', outline);
        const ok = arrow.heads === heads && arrow.outline === outline;
        undo();
        const restored = state.shapes.find((s) => s.type === 'arrow');
        return [ok, document.querySelectorAll('#props-controls .prop').length, restored.outline === original, restored.heads === heads];
      })()`);
      check('réglages appliqués à l’annotation sélectionnée', props[0] && props[1] > 5, props.join(', '));
      check('Ctrl+Z annule un changement de réglage', props[2] && props[3], props.join(', '));
      await key(region, 'y', ['control']);

      // Mes préréglages : un style enregistré avec + s'y retrouve ; le choisir en fait l'outil de dessin,
      // sans quitter la catégorie. Modifié ensuite, il se met à jour depuis son menu
      // (le préréglage de test est ensuite supprimé)
      const mine = await region.webContents.executeJavaScript(`(() => {
        setTool('marker');
        const color = '#' + Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0');
        setProp('color', color);
        addPreset();
        const preset = state.presets.marker.find((p) => p.style.color === color);
        setTool('arrow');
        setTool('presets');
        const button = () => document.querySelector('.preset-apply[data-id="' + preset?.id + '"]');
        button()?.click();
        const chosen = button()?.getAttribute('aria-pressed') === 'true';
        const width = preset?.style.width === 30 ? 31 : 30;
        setProp('width', width);
        const modified = Boolean(button()?.parentElement.classList.contains('modified'));
        button()?.parentElement.querySelector('.preset-menu button')?.click(); // « Mettre à jour »
        const updated = preset?.style.width === width && button()?.getAttribute('aria-pressed') === 'true';
        const result = [preset?.custom, state.presetsView, state.tool, chosen, modified, updated];
        if (preset) deletePreset('marker', preset.id);
        setTool('arrow');
        return result;
      })()`);
      check('Mes préréglages : un style enregistré s’y choisit en un clic', mine[0] === true && mine[1] && mine[2] === 'marker' && mine[3], mine.join(', '));
      check('Mes préréglages : un préréglage modifié se met à jour depuis son menu', mine[4] && mine[5], mine.join(', '));

      await key(region, 'c', ['control']);
      await wait(500);
      const items = await clipboard.read();
      check('Ctrl+C copie l’image dans le presse-papiers', items.some((i) => i.types.some((t) => t.startsWith('image/'))), items.map((i) => i.types.join('+')).join(', '));
      await savePage(region, '3-annotations.png');
      const exported = await region.webContents.executeJavaScript('exportCanvas().toDataURL()');
      fs.writeFileSync(path.join(OUT, '4-export.png'), Buffer.from(exported.split(',')[1], 'base64'));
      check('export PNG', exported.length > 1000, `${Math.round(exported.length / 1024)} Ko`);
      console.log(`échelle d'affichage : ${scale.toFixed(3)}`);

      // Enregistrement automatique : annotations (modifiables) et image annotée mises à jour
      const types = await region.webContents.executeJavaScript('state.shapes.map((s) => s.type).join(",")');
      const readData = (id) => JSON.parse(fs.readFileSync(dataFile(id, '.json'), 'utf8'));
      let saved = null;
      for (let i = 0; i < 40 && saved?.shapes.length !== 6; i++) {
        await wait(100);
        saved = readData(regionId);
      }
      check('annotations enregistrées automatiquement', saved.shapes.map((s) => s.type).join(',') === types, `${saved.shapes.length} annotation(s)`);
      const annotated = !fs.readFileSync(library.imagePath(regionId)).equals(fs.readFileSync(dataFile(regionId, '.png')));
      check('image annotée enregistrée à côté de l’originale', annotated);
      const regionItem = (await library.list()).find((i) => i.id === regionId);
      const thumbSynced = await until(region, `document.querySelector('.shot[data-id="${regionId}"] img').src === ${JSON.stringify(regionItem.thumb)}`);
      check('la miniature de la galerie suit les modifications', thumbSynced);
      await savePage(region, '5-galerie.png');

      // Galerie : rouvrir la capture précédente, puis revenir avec les annotations
      const click = (id) => region.webContents.executeJavaScript(`document.querySelector('.shot[data-id="${id}"] .shot-open').click()`);
      await click(fullId);
      const back = await until(region, `state.libraryId === ${JSON.stringify(fullId)} && state.shapes.length === 0`);
      check('clic dans la galerie : la capture précédente s’ouvre', back);
      await click(regionId);
      const restored = await until(region, `state.libraryId === ${JSON.stringify(regionId)} && state.shapes.map((s) => s.type).join(",") === ${JSON.stringify(types)}`);
      check('la capture rouverte retrouve ses annotations', restored);

      // Suppression depuis la galerie
      await region.webContents.executeJavaScript(`deleteCapture(${JSON.stringify(fullId)})`);
      const removed = await until(region, 'document.querySelectorAll(".shot").length === 1');
      check('supprimer une capture la retire de la galerie et du dossier', removed && !fs.existsSync(dataFile(fullId, '.json')));

      // Fermeture juste après une modification : enregistrée sans confirmation
      await region.webContents.executeJavaScript(`(() => {
        const before = snapshot();
        state.shapes.push(Shapes.create('rect', { x: 10, y: 10 }, { ...state.styles.rect }));
        Object.assign(state.shapes.at(-1), { w: 40, h: 30 });
        commit(before);
      })()`);
      region.close();
      await wait(800);
      const final = readData(regionId);
      check('fermer la fenêtre enregistre la dernière modification', final.shapes.length === 7 && region.isDestroyed(), `${final.shapes.length} annotation(s)`);
      const leftovers = fs.readdirSync(path.join(LIBRARY, '.snapit')).filter((name) => name.endsWith('.tmp'));
      check('aucun fichier temporaire laissé dans la bibliothèque', leftovers.length === 0, leftovers.join(', '));
    }
  } catch (err) {
    check('exécution sans erreur', false, err.stack);
  }
  console.log(`\nImages de contrôle : ${OUT}`);
  console.log(failures.length ? `${failures.length} échec(s)` : 'Tous les contrôles sont passés.');
  app.exit(failures.length ? 1 : 0);
});
