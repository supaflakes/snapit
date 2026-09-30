// Test de la capture défilante sur des pages difficiles, sans overlay ni touches simulées : en-tête opaque,
// en-tête translucide et barre latérale collante, barre latérale presque aussi haute que la page, bouton
// flottant. Chaque page est ouverte comme dans le test de fumée (scripts/smoke-page.js) et capturée par
// l'assistant (src/native/regions.cs) ; l'image doit couvrir toute la page, chaque bande à sa place.
// Usage : npm run scroll-test   (dossier de sortie : SNAPIT_SMOKE_OUT ou %TEMP%\snapit-scroll-test)
'use strict';

const { app, nativeImage, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Regions } = require('../src/regions.js');

const OUT = process.env.SNAPIT_SMOKE_OUT || path.join(os.tmpdir(), 'snapit-scroll-test');
app.setPath('userData', path.join(OUT, 'profil'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

// Page de test dans un autre processus, comme un vrai navigateur : `hwnd` sa fenêtre, `scrollY` sa position.
function openTestPage(file, { x, y, width, height }, scrollY) {
  const child = spawn(process.execPath, [path.join(__dirname, 'smoke-page.js'), file, ...[x, y, width, height, scrollY].map(String)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const page = { hwnd: null, scrollY: null, close: () => child.kill() };
  page.ready = new Promise((resolve) => {
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (line.startsWith('ready ')) {
          page.hwnd = Number(line.slice(6));
          resolve(true);
        } else if (line.startsWith('scrollY ')) {
          page.scrollY = Number(line.slice(8));
        }
      }
    });
    child.on('exit', () => resolve(false));
  });
  return page;
}

const WIDTH = 700;
const HEIGHT = 480;
const HEADER = 50;
const BAND = 150;
const BANDS = 16;

// `sidebar` : hauteur d'une barre latérale collante (px CSS), `translucent` : en-tête flou où la page transparaît
const PAGES = [
  { name: 'en-tête opaque' },
  { name: 'en-tête translucide et barre latérale collante', translucent: true, sidebar: 260 },
  { name: 'barre latérale presque aussi haute que la fenêtre', translucent: true, sidebar: 400 },
  { name: 'bouton flottant', floating: true },
];

function html({ translucent, sidebar, floating }) {
  const bands = Array.from(
    { length: BANDS },
    (_, i) =>
      `<div style="height:${BAND}px;background:hsl(${(i * 47) % 360},70%,${i % 2 ? 40 : 70}%)">` +
      `<p style="margin:0;padding:24px 0 0 120px">Bande ${i} : du texte pour superposer les captures</p>` +
      `<p style="margin:0;padding:8px 0 0 120px">Deuxième ligne ${i * 7}</p></div>`,
  ).join('');
  const header = translucent ? 'background:rgba(15,23,42,.55);backdrop-filter:blur(10px)' : 'background:#0f172a';
  const aside = sidebar
    ? `<aside style="width:140px;flex:none"><div style="position:sticky;top:${HEADER + 10}px;height:${sidebar}px;box-sizing:border-box;padding:8px;background:#1e293b;border:1px solid #94a3b8;color:#e2e8f0">Chapitres<br>1. Un<br>2. Deux<br>3. Trois</div></aside>`
    : '';
  const button = floating ? '<div style="position:fixed;right:24px;bottom:24px;width:56px;height:56px;border-radius:28px;background:#f59e0b"></div>' : '';
  return (
    `<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px sans-serif;background:#0b0d12">` +
    `<div style="position:sticky;top:0;z-index:2;height:${HEADER}px;${header};color:#fff;padding-left:120px;line-height:${HEADER}px">En-tête fixe</div>` +
    `<div style="display:flex;gap:16px"><main style="flex:1">${bands}</main>${aside}</div>${button}</body>`
  );
}

async function scrollingCapture(regions, page, index) {
  const primary = screen.getPrimaryDisplay();
  const sf = primary.scaleFactor;
  const file = path.join(OUT, `page-${index}.html`);
  fs.writeFileSync(file, html(page));
  const bounds = { x: primary.bounds.x + 260, y: primary.bounds.y + 160, width: WIDTH, height: HEIGHT };
  const target = openTestPage(file, bounds, 400);
  if (!(await Promise.race([target.ready, wait(15000)]))) {
    check(`${page.name} : page de test ouverte`, false);
    target.close();
    return;
  }
  await wait(800);

  // la page sous un point de sa colonne principale (pixels physiques), comme au survol dans l'overlay
  const physical = screen.dipToScreenRect(null, bounds);
  let chain = null;
  for (let i = 0; i < 20 && !chain?.some((e) => e[5] > 0); i++) {
    chain = await regions.probe(target.hwnd, physical.x + Math.round(60 * sf) + (i % 2), physical.y + Math.round(240 * sf));
    await wait(150);
  }
  const scrollable = chain && [...chain].reverse().find((e) => e[5] > 0);
  check(`${page.name} : la page défile`, Boolean(scrollable), scrollable ? '' : JSON.stringify(chain));
  if (!scrollable) {
    target.close();
    return;
  }

  const png = path.join(OUT, `page-${index}.png`);
  const started = Date.now();
  const done = await regions.scrollCapture(scrollable[5], scrollable.slice(0, 4), sf, png, () => {});
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  check(`${page.name} : capture jusqu'en bas de la page`, done?.end === 'bottom', `${JSON.stringify(done)} en ${seconds} s`);
  if (done) {
    const image = nativeImage.createFromPath(png);
    const { width, height } = image.getSize();
    const bitmap = image.toBitmap(); // BGRA
    // couleur de l'image assemblée à un point donné, en pixels CSS de la page
    const at = (x, y) => {
      const i = (Math.round(y * sf) * width + Math.round(x * sf)) * 4;
      return `${bitmap[i + 2]},${bitmap[i + 1]},${bitmap[i]}`;
    };
    const expected = Math.round((HEADER + BAND * BANDS) * sf);
    check(`${page.name} : hauteur de la page entière`, Math.abs(height - expected) <= 2, `${width}×${height}, attendu ${expected} de haut`);
    check(`${page.name} : seule la barre de défilement est retirée`, width > (WIDTH - 20) * sf && width < WIDTH * sf + 8, `${width} px de large`);
    // chaque bande commence à sa place (pas de décalage ni de doublon), d'une couleur unie, et l'en-tête n'apparaît qu'en haut
    const bands = [];
    for (let i = 0; i < BANDS; i++) {
      const top = HEADER + BAND * i;
      bands.push({ above: at(20, top - 3), below: at(20, top + 3), low: at(20, top + BAND * 0.7), bottom: at(20, top + BAND - 4) });
    }
    const header = at(20, HEADER / 2);
    const placed = bands.every((b, i) => b.below === b.low && b.low === b.bottom && (i === 0 || b.above === bands[i - 1].low));
    const distinct = bands.every((b, i) => i === 0 || b.low !== bands[i - 1].low) && bands.every((b) => b.low !== header);
    check(`${page.name} : bandes assemblées à leur place, en-tête une seule fois`, placed && distinct, placed && distinct ? '' : JSON.stringify(bands.slice(0, 3)));
    if (page.sidebar && page.sidebar < HEIGHT * 0.6) {
      // la barre latérale collante n'apparaît qu'en haut : plus bas, sa colonne montre le fond de la page
      const x = WIDTH - 70;
      const color = at(x, HEADER + 10 + page.sidebar / 2);
      let repeated = 0;
      for (let y = HEADER + 10 + page.sidebar + 20; y < HEADER + BAND * BANDS - 10; y += 10) if (at(x, y) === color) repeated++;
      check(`${page.name} : barre latérale une seule fois`, repeated === 0, repeated ? `${repeated} échantillon(s) de sa couleur plus bas` : '');
    }
  }
  await wait(300);
  check(`${page.name} : la page revient à sa position`, Math.abs(target.scrollY - 400) <= 1, `scrollY = ${target.scrollY}`);
  target.close();
  await wait(500);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const regions = new Regions({ helperDir: path.join(OUT, 'bin') });
  try {
    const started = await regions.start();
    check('assistant de détection des zones démarré', started);
    if (started) for (const [index, page] of PAGES.entries()) await scrollingCapture(regions, page, index);
  } catch (err) {
    check('exécution sans erreur', false, err.stack);
  } finally {
    regions.stop();
    console.log(failures.length ? `\n${failures.length} échec(s) — images dans ${OUT}` : `\nTout est OK — images dans ${OUT}`);
    app.exit(failures.length ? 1 : 0);
  }
});
