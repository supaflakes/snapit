'use strict';

const shot = document.getElementById('shot');
const fx = document.getElementById('fx');
const ctx = fx.getContext('2d');

const ACCENT = '#8f72ff';
const FONT = '12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const LOUPE_SIZE = 128;
const LOUPE_PIXELS = 15; // pixels d'image affichés sur la largeur de la loupe
const MIN_SELECTION = 4;
const DRAG_THRESHOLD = 4; // pixels CSS : au-delà, l'appui devient un glisser (zone libre) plutôt qu'un clic
const MIN_REGION = 12; // pixels CSS : les zones détectées plus petites ne sont pas proposées
const PROBE_DELAY = 40; // ms de pause de la souris avant de chercher les éléments d'interface sous elle
const WHEEL_STEP = 50; // défilement cumulé pour passer d'une zone à la suivante
// Éléments d'interface qu'on ne propose pas : texte courant, liens, barres de défilement…
const SKIPPED_TYPES = new Set(['Text', 'Hyperlink', 'ScrollBar', 'Thumb', 'Separator', 'TitleBar', 'ToolTip']);

let active = false;
let mouse = null; // position de la souris (pixels CSS)
let start = null; // appui du bouton gauche
let dragging = false;
let selection = null; // zone libre en cours de tracé (pixels CSS)
let frame = 0;
let hint = '';

// Détection des fenêtres et des zones (pixels de l'image). `windows` à null : détection désactivée.
let windows = null;
let elements = new Map(); // fenêtre -> éléments d'interface déjà trouvés sous la souris
let chain = []; // zones imbriquées sous la souris, de l'écran entier à la plus petite
let pinned = null; // zone choisie à la molette, gardée tant que la souris reste dedans
let hovered = null; // zone en surbrillance, capturée d'un clic
let probeTimer = 0;
let probing = false;
let wheelDelta = 0;
let focusAsked = false;

window.snapit.onOverlayShow(async ({ dataUrl, hint: text, regions, cursor }) => {
  hint = text ?? '';
  shot.src = dataUrl;
  try {
    await shot.decode();
  } catch {
    // l'image s'affichera quand même une fois chargée
  }
  reset();
  windows = regions ? regions.map(fromPayload) : null;
  active = true;
  resizeCanvas();
  if (cursor) {
    // la zone sous la souris est en surbrillance d'emblée, sans attendre qu'elle bouge
    mouse = cursor;
    updateHover();
    scheduleProbe();
  }
  draw();
  window.snapit.overlayReady();
});

window.snapit.onOverlayReset(() => {
  active = false;
  reset();
});

function reset() {
  mouse = null;
  start = null;
  dragging = false;
  selection = null;
  windows = null;
  elements = new Map();
  chain = [];
  pinned = null;
  hovered = null;
  clearTimeout(probeTimer);
  wheelDelta = 0;
  ctx.clearRect(0, 0, fx.width, fx.height);
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  fx.width = Math.round(innerWidth * dpr);
  fx.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function scheduleDraw() {
  if (!frame) frame = requestAnimationFrame(() => {
    frame = 0;
    draw();
  });
}

// Taille en pixels réels de l'image pour une distance en pixels CSS
const toImageX = (v) => Math.round((v * shot.naturalWidth) / innerWidth);
const toImageY = (v) => Math.round((v * shot.naturalHeight) / innerHeight);

function rectFrom(a, b) {
  const x1 = Math.max(0, Math.min(a.x, b.x));
  const y1 = Math.max(0, Math.min(a.y, b.y));
  const x2 = Math.min(innerWidth, Math.max(a.x, b.x));
  const y2 = Math.min(innerHeight, Math.max(a.y, b.y));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// ------------------------------------------------------ détection des zones

const rect = ([x, y, w, h]) => ({ x, y, w, h });

function fromPayload(w) {
  return {
    hwnd: w.hwnd,
    frame: { ...rect(w.frame), kind: 'window' },
    client: w.client && rect(w.client),
    children: w.children.map((c) => c && { ...rect(c), parent: c[4] }),
  };
}

// pixels de l'image par pixel CSS
const scale = () => shot.naturalWidth / innerWidth;
const toImagePoint = (p) => ({ x: p.x * scale(), y: (p.y * shot.naturalHeight) / innerHeight });
const toCss = (r) => ({
  x: r.x / scale(),
  y: (r.y * innerHeight) / shot.naturalHeight,
  w: r.w / scale(),
  h: (r.h * innerHeight) / shot.naturalHeight,
});
const contains = (r, p) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
const near = (a, b, tolerance) =>
  Math.abs(a.x - b.x) <= tolerance &&
  Math.abs(a.y - b.y) <= tolerance &&
  Math.abs(a.x + a.w - b.x - b.w) <= tolerance &&
  Math.abs(a.y + a.h - b.y - b.h) <= tolerance;

// Zones sous le point p (pixels de l'image), de l'écran entier à la plus petite : la fenêtre la plus haute,
// sa zone cliente, ses sous-fenêtres et les éléments d'interface déjà trouvés, sans doublons.
function computeChain(p) {
  const screen = { x: 0, y: 0, w: shot.naturalWidth, h: shot.naturalHeight, kind: 'screen' };
  const win = windows?.find((w) => contains(w.frame, p));
  if (!win) return [screen];

  const found = [win.frame];
  if (win.client && contains(win.client, p)) found.push(win.client);
  // sous-fenêtres : à chaque niveau, la plus haute qui contient le point
  for (let parent = -1; ;) {
    const i = win.children.findIndex((c) => c && c.parent === parent && contains(c, p));
    if (i < 0) break;
    found.push(win.children[i]);
    parent = i;
  }
  for (const el of elements.get(win.hwnd) ?? []) if (contains(el, p)) found.push(el);

  const f = win.frame;
  const min = MIN_REGION * scale();
  const clipped = found
    .map((r) => {
      // dans les limites de la fenêtre
      const x = Math.max(r.x, f.x);
      const y = Math.max(r.y, f.y);
      return { ...r, x, y, w: Math.min(r.x + r.w, f.x + f.w) - x, h: Math.min(r.y + r.h, f.y + f.h) - y };
    })
    .filter((r) => r.w >= min && r.h >= min)
    .sort((a, b) => b.w * b.h - a.w * a.h);
  const list = [screen];
  const tolerance = 2 * scale();
  for (const r of clipped) if (!list.some((q) => near(q, r, tolerance))) list.push(r);
  return list;
}

function updateHover() {
  if (!windows || !mouse) {
    chain = [];
    hovered = null;
    return;
  }
  const p = toImagePoint(mouse);
  chain = computeChain(p);
  const kept = pinned && contains(pinned, p) ? chain.find((r) => near(r, pinned, 0.5)) : null;
  pinned = kept ?? null;
  hovered = kept ?? chain[chain.length - 1];
}

// Molette ou flèches : zone englobante (-1) ou plus petite (+1), gardée tant que la souris reste dedans.
function changeLevel(step) {
  if (!chain.length || start) return;
  const i = Math.max(0, chain.indexOf(hovered));
  const next = Math.min(chain.length - 1, Math.max(0, i + step));
  hovered = chain[next];
  pinned = next === chain.length - 1 ? null : hovered;
  scheduleDraw();
}

function scheduleProbe() {
  clearTimeout(probeTimer);
  if (windows && mouse && !start) probeTimer = setTimeout(probe, PROBE_DELAY);
}

// Cherche les éléments d'interface sous la souris (barres d'outils, panneaux, page web, images…) :
// la zone en surbrillance s'affine dès qu'ils arrivent.
async function probe() {
  if (probing || !active || !mouse || start) return;
  const p = toImagePoint(mouse);
  const win = windows.find((w) => contains(w.frame, p));
  if (!win) return;
  probing = true;
  let found = null;
  try {
    found = await window.snapit.overlayProbe(win.hwnd, Math.round(p.x), Math.round(p.y));
  } catch {
    found = null;
  }
  probing = false;
  if (!active) return;
  if (found?.length) {
    const list = elements.get(win.hwnd) ?? [];
    for (const [x, y, w, h, type] of found) {
      const el = { x, y, w, h, type };
      if (!SKIPPED_TYPES.has(type) && !list.some((e) => near(e, el, 0))) list.push(el);
    }
    elements.set(win.hwnd, list);
    if (!start) updateHover();
    scheduleDraw();
  }
  // la souris a bougé pendant la recherche : on recommence là où elle est
  if (mouse && !start) {
    const q = toImagePoint(mouse);
    if (Math.abs(q.x - p.x) >= 1 || Math.abs(q.y - p.y) >= 1) scheduleProbe();
  }
}

// --------------------------------------------------------------------- rendu

function pill(text, x, y, { align = 'left', bg = 'rgba(20, 20, 26, 0.9)' } = {}) {
  ctx.font = FONT;
  const w = ctx.measureText(text).width + 16;
  const h = 24;
  let left = align === 'center' ? x - w / 2 : x;
  left = Math.max(4, Math.min(left, innerWidth - w - 4));
  const top = Math.max(4, Math.min(y, innerHeight - h - 4));
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(left, top, w, h, 6);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + 8, top + h / 2 + 0.5);
}

function drawLoupe(label) {
  if (!mouse || !shot.naturalWidth) return;
  const ix = (mouse.x * shot.naturalWidth) / innerWidth;
  const iy = (mouse.y * shot.naturalHeight) / innerHeight;
  const half = LOUPE_PIXELS / 2;
  const cell = LOUPE_SIZE / LOUPE_PIXELS;

  let x = mouse.x + 24;
  let y = mouse.y + 24;
  if (x + LOUPE_SIZE > innerWidth - 8) x = mouse.x - 24 - LOUPE_SIZE;
  if (y + LOUPE_SIZE + 30 > innerHeight - 8) y = mouse.y - 24 - LOUPE_SIZE - 30;

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 16;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.roundRect(x, y, LOUPE_SIZE, LOUPE_SIZE, 10);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, LOUPE_SIZE, LOUPE_SIZE, 10);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(shot, Math.floor(ix - half), Math.floor(iy - half), LOUPE_PIXELS, LOUPE_PIXELS, x, y, LOUPE_SIZE, LOUPE_SIZE);
  // pixel central
  const cx = x + Math.floor(LOUPE_PIXELS / 2) * cell;
  const cy = y + Math.floor(LOUPE_PIXELS / 2) * cell;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, cy + cell / 2);
  ctx.lineTo(x + LOUPE_SIZE, cy + cell / 2);
  ctx.moveTo(cx + cell / 2, y);
  ctx.lineTo(cx + cell / 2, y + LOUPE_SIZE);
  ctx.stroke();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(cx, cy, cell, cell);
  ctx.restore();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, LOUPE_SIZE, LOUPE_SIZE, 10);
  ctx.stroke();

  pill(label ?? `${Math.round(ix)}, ${Math.round(iy)}`, x + LOUPE_SIZE / 2, y + LOUPE_SIZE + 6, { align: 'center' });
}

function draw() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  if (!active) return;

  const r = dragging && selection && selection.w > 0 && selection.h > 0 ? selection : null;
  // zone détectée en surbrillance ; l'écran entier n'assombrit rien
  const spot = !r && hovered ? (hovered.kind === 'screen' ? { x: 0, y: 0, w: innerWidth, h: innerHeight } : toCss(hovered)) : null;

  if (!spot || hovered.kind !== 'screen') {
    ctx.fillStyle = 'rgba(6, 6, 10, 0.5)';
    ctx.beginPath();
    ctx.rect(0, 0, innerWidth, innerHeight);
    const hole = r ?? spot;
    if (hole) ctx.rect(hole.x, hole.y, hole.w, hole.h);
    ctx.fill('evenodd');
  }

  if (r) {
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.setLineDash([]);
  } else {
    if (spot) {
      // cadre à l'intérieur de la zone : visible même pour une fenêtre plein écran
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 3;
      ctx.strokeRect(spot.x + 1.5, spot.y + 1.5, spot.w - 3, spot.h - 3);
    }
    if (mouse) {
      // réticule
      ctx.strokeStyle = 'rgba(143, 114, 255, 0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(mouse.y) + 0.5);
      ctx.lineTo(innerWidth, Math.round(mouse.y) + 0.5);
      ctx.moveTo(Math.round(mouse.x) + 0.5, 0);
      ctx.lineTo(Math.round(mouse.x) + 0.5, innerHeight);
      ctx.stroke();
    }
  }

  if (!start && hint) pill(hint, innerWidth / 2, 20, { align: 'center' });

  const label = r ? `${toImageX(r.w)} × ${toImageY(r.h)} px` : hovered ? `${hovered.w} × ${hovered.h} px` : null;
  drawLoupe(label);
}

// ------------------------------------------------------------------ souris

addEventListener('mousedown', (e) => {
  if (!active) return;
  if (e.button === 2) {
    // clic droit : annule la zone en cours de tracé, sinon quitte
    if (start) {
      start = null;
      dragging = false;
      selection = null;
      scheduleDraw();
    } else {
      cancel();
    }
    return;
  }
  if (e.button !== 0) return;
  start = { x: e.clientX, y: e.clientY };
  mouse = { ...start };
  dragging = false;
  selection = null;
  clearTimeout(probeTimer);
  scheduleDraw();
});

addEventListener('mousemove', (e) => {
  if (!active) return;
  if (!focusAsked && !document.hasFocus()) {
    focusAsked = true; // Entrée et les flèches visent l'écran sous la souris
    window.snapit.overlayFocus();
  }
  mouse = { x: e.clientX, y: e.clientY };
  if (start) {
    dragging ||= Math.hypot(mouse.x - start.x, mouse.y - start.y) > DRAG_THRESHOLD;
    if (dragging) selection = rectFrom(start, mouse);
  } else {
    updateHover();
    scheduleProbe();
  }
  scheduleDraw();
});

addEventListener('mouseup', (e) => {
  if (!active || e.button !== 0 || !start) return;
  const r = dragging ? rectFrom(start, { x: e.clientX, y: e.clientY }) : null;
  start = null;
  dragging = false;
  if (r && r.w >= MIN_SELECTION && r.h >= MIN_SELECTION) {
    finish({ x: r.x / innerWidth, y: r.y / innerHeight, w: r.w / innerWidth, h: r.h / innerHeight });
  } else {
    captureHovered(); // simple clic : la zone en surbrillance, sinon l'écran entier
  }
});

addEventListener('mouseleave', () => {
  if (!active || start) return;
  mouse = null;
  chain = [];
  hovered = null;
  pinned = null;
  clearTimeout(probeTimer);
  scheduleDraw();
});

addEventListener(
  'wheel',
  (e) => {
    if (!active || !windows || start) return;
    e.preventDefault();
    wheelDelta += e.deltaY;
    if (Math.abs(wheelDelta) < WHEEL_STEP) return;
    changeLevel(wheelDelta < 0 ? -1 : 1); // vers le haut : zone plus grande
    wheelDelta = 0;
  },
  { passive: false },
);

addEventListener('keydown', (e) => {
  if (!active) return;
  if (e.key === 'Escape') {
    cancel();
  } else if (e.key === 'Enter' && !start) {
    captureHovered();
  } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && windows) {
    e.preventDefault();
    changeLevel(e.key === 'ArrowUp' ? -1 : 1);
  }
});

addEventListener('blur', () => {
  focusAsked = false;
});
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('resize', () => {
  resizeCanvas();
  scheduleDraw();
});

function captureHovered() {
  const r = hovered ?? { x: 0, y: 0, w: shot.naturalWidth, h: shot.naturalHeight };
  finish({ x: r.x / shot.naturalWidth, y: r.y / shot.naturalHeight, w: r.w / shot.naturalWidth, h: r.h / shot.naturalHeight });
}

function finish(fraction) {
  active = false;
  window.snapit.overlaySelect(fraction);
}

function cancel() {
  active = false;
  window.snapit.overlayCancel();
}
