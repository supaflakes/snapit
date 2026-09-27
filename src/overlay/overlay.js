'use strict';

const shot = document.getElementById('shot');
const fx = document.getElementById('fx');
const ctx = fx.getContext('2d');

const ACCENT = '#8f72ff';
const FONT = '12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const LOUPE_SIZE = 128;
const LOUPE_PIXELS = 15; // pixels d'image affichés sur la largeur de la loupe
const MIN_SELECTION = 4;

let active = false;
let mouse = null;
let start = null;
let selection = null;
let frame = 0;
let hint = '';

window.snapit.onOverlayShow(async ({ dataUrl, hint: text }) => {
  hint = text ?? '';
  shot.src = dataUrl;
  try {
    await shot.decode();
  } catch {
    // l'image s'affichera quand même une fois chargée
  }
  reset();
  active = true;
  resizeCanvas();
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
  selection = null;
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

function drawLoupe() {
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

  const label = selection
    ? `${toImageX(selection.w)} × ${toImageY(selection.h)} px`
    : `${Math.round(ix)}, ${Math.round(iy)}`;
  pill(label, x + LOUPE_SIZE / 2, y + LOUPE_SIZE + 6, { align: 'center' });
}

function draw() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  if (!active) return;

  const r = selection && selection.w > 0 && selection.h > 0 ? selection : null;

  ctx.fillStyle = 'rgba(6, 6, 10, 0.5)';
  ctx.beginPath();
  ctx.rect(0, 0, innerWidth, innerHeight);
  if (r) ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fill('evenodd');

  if (r) {
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    ctx.setLineDash([]);
  } else if (mouse) {
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

  if (!start && hint) pill(hint, innerWidth / 2, 20, { align: 'center' });

  drawLoupe();
}

addEventListener('mousedown', (e) => {
  if (!active) return;
  if (e.button === 2) {
    // clic droit : annule la sélection en cours, sinon quitte
    if (start) {
      start = null;
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
  selection = rectFrom(start, mouse);
  scheduleDraw();
});

addEventListener('mousemove', (e) => {
  if (!active) return;
  mouse = { x: e.clientX, y: e.clientY };
  if (start) selection = rectFrom(start, mouse);
  scheduleDraw();
});

addEventListener('mouseup', (e) => {
  if (!active || e.button !== 0 || !start) return;
  const r = rectFrom(start, { x: e.clientX, y: e.clientY });
  start = null;
  if (r.w < MIN_SELECTION || r.h < MIN_SELECTION) {
    finish({ x: 0, y: 0, w: 1, h: 1 }); // simple clic : écran entier
  } else {
    finish({ x: r.x / innerWidth, y: r.y / innerHeight, w: r.w / innerWidth, h: r.h / innerHeight });
  }
});

addEventListener('mouseleave', () => {
  if (!active || start) return;
  mouse = null;
  scheduleDraw();
});

addEventListener('keydown', (e) => {
  if (active && e.key === 'Escape') cancel();
});

addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('resize', () => {
  resizeCanvas();
  scheduleDraw();
});

function finish(fraction) {
  active = false;
  window.snapit.overlaySelect(fraction);
}

function cancel() {
  active = false;
  window.snapit.overlayCancel();
}
