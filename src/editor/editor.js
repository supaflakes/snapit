'use strict';

// Pont vers le processus principal (absent quand la page est ouverte dans un simple navigateur).
const api = window.snapit ?? null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const stage = $('#stage');
const textEditor = $('#text-editor');

const COLORS = [
  ['#e5484d', 'Rouge'],
  ['#f76b15', 'Orange'],
  ['#ffc53d', 'Jaune'],
  ['#30a46c', 'Vert'],
  ['#0090ff', 'Bleu'],
  ['#8e4ec6', 'Violet'],
  ['#ffffff', 'Blanc'],
  ['#1c1c1f', 'Noir'],
];
const SIZE_LABELS = ['Fin', 'Moyen', 'Épais', 'Très épais'];

const TOOLS = {
  select: { key: 'v', cursor: 'default', hint: 'Cliquez sur une annotation pour la sélectionner, la déplacer ou la redimensionner. Flèches du clavier pour ajuster.' },
  arrow: { key: 'a', cursor: 'crosshair', hint: 'Glissez pour tracer une flèche. Maj : angles de 45°.' },
  rect: { key: 'r', cursor: 'crosshair', hint: 'Glissez pour tracer un rectangle. Maj : carré.' },
  ellipse: { key: 'e', cursor: 'crosshair', hint: 'Glissez pour tracer une ellipse. Maj : cercle.' },
  line: { key: 'l', cursor: 'crosshair', hint: 'Glissez pour tracer une ligne. Maj : angles de 45°.' },
  pen: { key: 'p', cursor: 'crosshair', hint: 'Dessinez à main levée.' },
  marker: { key: 'h', cursor: 'crosshair', hint: 'Surlignez à main levée. Maj : trait droit.' },
  text: { key: 't', cursor: 'text', hint: 'Cliquez pour écrire. Ctrl+Entrée ou clic ailleurs pour valider. Double-clic sur un texte pour le modifier.' },
  step: { key: 'n', cursor: 'copy', hint: 'Cliquez pour placer une étape numérotée (1, 2, 3…).' },
  blur: { key: 'b', cursor: 'crosshair', hint: 'Glissez sur une zone pour la pixeliser et masquer des informations sensibles.' },
  crop: { key: 'c', cursor: 'crosshair', hint: 'Glissez pour choisir la zone à conserver. Ctrl+Z pour annuler le rognage.' },
};

const state = {
  base: null, // canvas contenant l'image d'origine (ou rognée)
  shapes: [],
  tool: 'arrow',
  lastDrawTool: 'arrow',
  color: COLORS[0][0],
  sizeIndex: 1,
  unit: 1, // facteur d'échelle de l'écran capturé : garde des annotations lisibles en haute densité
  selected: null,
  scale: 1, // pixels CSS par pixel d'image
  fit: true,
  dirty: false,
  name: 'Capture',
};

const undoStack = [];
const redoStack = [];
let interaction = null;
let textEdit = null;
let spaceDown = false;
let renderQueued = false;

// ---------------------------------------------------------------- historique

function snapshot() {
  return { base: state.base, shapes: structuredClone(state.shapes) };
}

function commit(before) {
  undoStack.push(before);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  setDirty(true);
  updateButtons();
}

function restore(snap) {
  const baseChanged = snap.base !== state.base;
  state.base = snap.base;
  state.shapes = structuredClone(snap.shapes);
  select(null);
  if (baseChanged) state.fit = true;
  layout();
  requestRender();
  setDirty(true);
  updateButtons();
}

function undo() {
  commitTextEdit();
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
}

function redo() {
  commitTextEdit();
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
}

function setDirty(dirty) {
  state.dirty = dirty;
  document.title = state.base ? `${dirty ? '• ' : ''}${state.name} — Snapit` : 'Snapit';
}

// -------------------------------------------------------------------- image

async function loadImage({ dataUrl, scaleFactor = 1, name }) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const base = document.createElement('canvas');
  base.width = img.naturalWidth;
  base.height = img.naturalHeight;
  base.getContext('2d').drawImage(img, 0, 0);

  cancelTextEdit();
  interaction = null;
  state.base = base;
  state.shapes = [];
  state.selected = null;
  state.unit = Math.max(1, scaleFactor || 1);
  state.name = name || defaultName();
  state.fit = true;
  undoStack.length = 0;
  redoStack.length = 0;

  document.body.classList.add('has-image');
  api?.setHasImage(true);
  setDirty(false);
  layout();
  requestRender();
  updateButtons();
  stage.focus();
}

// Ouvre une image : dans cette fenêtre si elle est vide, sinon dans une nouvelle.
function openPayload(payload) {
  if (!payload) return;
  if (state.base && api) api.openInNewEditor(payload);
  else loadImage(payload).catch(() => toast("Impossible d'ouvrir cette image."));
}

function defaultName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Capture ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} à ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ dataUrl: reader.result, name: file.name.replace(/\.[^.]+$/, ''), scaleFactor: 1 });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ------------------------------------------------------------------- rendu

function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  if (!state.base) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.base, 0, 0);
  const opts = { base: state.base, unit: state.unit };
  for (const s of state.shapes) {
    if (s !== textEdit?.shape) Shapes.draw(ctx, s, opts);
  }
  if (interaction?.kind === 'crop') drawCropPreview(interaction);
  if (state.selected && state.selected !== textEdit?.shape && interaction?.kind !== 'draw') drawSelection(state.selected);
}

function drawSelection(s) {
  const px = 1 / state.scale; // un pixel CSS en pixels d'image
  ctx.save();
  if (!['line', 'arrow'].includes(s.type)) {
    const b = Shapes.bounds(s);
    const pad = 4 * px;
    ctx.strokeStyle = 'rgba(143, 114, 255, 0.95)';
    ctx.lineWidth = 1.25 * px;
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
    ctx.setLineDash([]);
  }
  const size = 9 * px;
  for (const h of Shapes.handles(s)) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#7c5cff';
    ctx.lineWidth = 1.75 * px;
    ctx.beginPath();
    ctx.roundRect(h.x - size / 2, h.y - size / 2, size, size, 2 * px);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function cropRect(it) {
  const r = Shapes.normRect({ x: it.x0, y: it.y0, w: it.x1 - it.x0, h: it.y1 - it.y0 });
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  const w = Math.min(state.base.width, Math.round(r.x + r.w)) - x;
  const h = Math.min(state.base.height, Math.round(r.y + r.h)) - y;
  return { x, y, w, h };
}

function drawCropPreview(it) {
  const r = cropRect(it);
  const px = 1 / state.scale;
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.fill('evenodd');
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5 * px;
  ctx.setLineDash([6 * px, 4 * px]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
  // grille des tiers
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = px;
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(r.x + (r.w * i) / 3, r.y);
    ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
    ctx.moveTo(r.x, r.y + (r.h * i) / 3);
    ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
  }
  ctx.stroke();
  ctx.restore();
  setStatusSize(`${r.w} × ${r.h} px`);
}

function exportCanvas() {
  const out = document.createElement('canvas');
  out.width = state.base.width;
  out.height = state.base.height;
  const c = out.getContext('2d');
  c.drawImage(state.base, 0, 0);
  const opts = { base: state.base, unit: state.unit };
  for (const s of state.shapes) Shapes.draw(c, s, opts);
  return out;
}

// ------------------------------------------------------------ mise en page

function fitScale() {
  const pad = 56;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(50, stage.clientWidth - pad);
  const h = Math.max(50, stage.clientHeight - pad);
  // Ne jamais agrandir au-delà de la taille réelle (1 pixel d'image = 1 pixel physique).
  return Math.min(w / state.base.width, h / state.base.height, 1 / dpr);
}

function layout() {
  if (!state.base) return;
  if (canvas.width !== state.base.width || canvas.height !== state.base.height) {
    canvas.width = state.base.width;
    canvas.height = state.base.height;
  }
  if (state.fit) state.scale = fitScale();
  canvas.style.width = `${state.base.width * state.scale}px`;
  canvas.style.height = `${state.base.height * state.scale}px`;
  $('#zoom-label').textContent = `${Math.round(state.scale * (window.devicePixelRatio || 1) * 100)} %`;
  setStatusSize(`${state.base.width} × ${state.base.height} px`);
  if (textEdit) positionTextEditor();
  requestRender();
}

function setStatusSize(text) {
  $('#status-size').textContent = text;
}

function setZoom(scale, anchor) {
  if (!state.base) return;
  const dpr = window.devicePixelRatio || 1;
  scale = Math.min(Math.max(scale, 0.05 / dpr), 8 / dpr);
  const rect = canvas.getBoundingClientRect();
  const ax = anchor?.x ?? rect.left + rect.width / 2;
  const ay = anchor?.y ?? rect.top + rect.height / 2;
  const ix = (ax - rect.left) / state.scale;
  const iy = (ay - rect.top) / state.scale;
  state.scale = scale;
  state.fit = false;
  layout();
  const next = canvas.getBoundingClientRect();
  stage.scrollLeft += next.left + ix * scale - ax;
  stage.scrollTop += next.top + iy * scale - ay;
}

function zoomBy(factor, anchor) {
  setZoom(state.scale * factor, anchor);
}

function zoomFit() {
  state.fit = true;
  layout();
}

function zoomActual() {
  setZoom(1 / (window.devicePixelRatio || 1));
}

// --------------------------------------------------------------- sélection

function select(shape) {
  state.selected = shape;
  if (shape) syncToolbarFrom(shape);
  updateButtons();
  requestRender();
}

function syncToolbarFrom(s) {
  if (Shapes.hasColor(s)) {
    state.color = s.color;
    $('#custom-color').value = s.color;
  }
  state.sizeIndex = Shapes.sizeIndexOf(s, state.unit);
  renderProps();
}

function deleteSelected() {
  const s = state.selected;
  if (!s) return;
  const before = snapshot();
  state.shapes = state.shapes.filter((x) => x !== s);
  select(null);
  commit(before);
  requestRender();
}

function nextStepNumber() {
  const steps = state.shapes.filter((s) => s.type === 'step').map((s) => s.n);
  return steps.length ? Math.max(...steps) + 1 : 1;
}

function hitTest(p) {
  const tol = 5 / state.scale;
  for (let i = state.shapes.length - 1; i >= 0; i--) {
    if (Shapes.hit(state.shapes[i], p, tol)) return state.shapes[i];
  }
  return null;
}

function hitHandle(s, p) {
  const r = 8 / state.scale;
  return Shapes.handles(s).find((h) => Math.abs(h.x - p.x) <= r && Math.abs(h.y - p.y) <= r) ?? null;
}

// -------------------------------------------------------------------- texte

function startTextEdit(shape, { before = snapshot(), isNew = false } = {}) {
  commitTextEdit();
  textEdit = { shape, before, isNew, original: shape.text };
  state.selected = shape;
  textEditor.value = shape.text;
  textEditor.hidden = false;
  styleTextEditor();
  positionTextEditor();
  requestRender();
  textEditor.focus();
  textEditor.setSelectionRange(textEditor.value.length, textEditor.value.length);
}

function styleTextEditor() {
  const s = textEdit.shape;
  textEditor.style.fontSize = `${s.size * state.scale}px`;
  textEditor.style.color = s.color;
  const halo = Shapes.isLight(s.color) ? 'rgba(0,0,0,.85)' : '#fff';
  const r = Math.max(1, s.size * state.scale * 0.08);
  textEditor.style.textShadow = [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]
    .map(([x, y]) => `${x}px ${y}px 0 ${halo}`)
    .join(', ');
  autosizeTextEditor();
}

function positionTextEditor() {
  const s = textEdit.shape;
  textEditor.style.left = `${s.x * state.scale}px`;
  // le line-height (1.25) du textarea ajoute un demi-interligne au-dessus du texte : on le compense
  textEditor.style.top = `${(s.y + s.size * 0.1 - s.size * 0.125) * state.scale}px`;
  styleTextEditorSizeOnly();
}

function styleTextEditorSizeOnly() {
  textEditor.style.fontSize = `${textEdit.shape.size * state.scale}px`;
  autosizeTextEditor();
}

function autosizeTextEditor() {
  textEditor.style.width = '0px';
  textEditor.style.height = '0px';
  const fs = textEdit.shape.size * state.scale;
  textEditor.style.width = `${textEditor.scrollWidth + fs * 0.6}px`;
  textEditor.style.height = `${textEditor.scrollHeight}px`;
}

function commitTextEdit() {
  if (!textEdit) return;
  const { shape, before, isNew, original } = textEdit;
  textEdit = null;
  textEditor.hidden = true;
  shape.text = textEditor.value.replace(/\s+$/, '');
  if (!shape.text.trim()) {
    state.shapes = state.shapes.filter((s) => s !== shape);
    if (state.selected === shape) state.selected = null;
    if (!isNew) commit(before);
  } else if (isNew || shape.text !== original) {
    commit(before);
  }
  updateButtons();
  requestRender();
  stage.focus();
}

function cancelTextEdit() {
  if (!textEdit) return;
  const { shape, isNew, original } = textEdit;
  textEdit = null;
  textEditor.hidden = true;
  if (isNew) state.shapes = state.shapes.filter((s) => s !== shape);
  else shape.text = original;
  if (state.selected === shape && isNew) state.selected = null;
  requestRender();
}

textEditor.addEventListener('input', autosizeTextEditor);
textEditor.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault();
    commitTextEdit();
  }
});
textEditor.addEventListener('blur', () => {
  // laisse le clic suivant se traiter avant de valider (évite de recréer un texte au même endroit)
  setTimeout(() => {
    if (textEdit && document.activeElement !== textEditor) commitTextEdit();
  }, 0);
});

// ------------------------------------------------------------ interactions

function toImage(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / state.scale, y: (e.clientY - rect.top) / state.scale };
}

function onPointerDown(e) {
  if (!state.base || e.target === textEditor || e.target.closest('#empty')) return;

  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    e.preventDefault();
    interaction = { kind: 'pan', x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(e.pointerId);
    stage.style.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0) return;
  // Empêche le mousedown implicite de déplacer le focus (le champ texte doit le garder).
  e.preventDefault();

  const wasEditing = Boolean(textEdit);
  commitTextEdit();
  if (wasEditing && state.tool === 'text') return;

  const p = toImage(e);
  const tool = state.tool;
  stage.setPointerCapture(e.pointerId);

  // Poignées de l'annotation sélectionnée
  const sel = state.selected;
  if (sel && tool !== 'crop') {
    const handle = hitHandle(sel, p);
    if (handle) {
      const before = snapshot();
      Shapes.normalize(sel);
      interaction = { kind: 'handle', shape: sel, handle: handle.id, before, orig: structuredClone(sel) };
      return;
    }
  }

  if (tool === 'crop') {
    select(null);
    interaction = { kind: 'crop', x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    return;
  }

  const hit = hitTest(p);

  if (tool === 'text' && hit?.type === 'text') {
    select(hit);
    startTextEdit(hit);
    return;
  }

  // Déplacement : n'importe quelle annotation avec l'outil Sélection, ou celle déjà sélectionnée.
  if (hit && (tool === 'select' || hit === sel)) {
    select(hit);
    interaction = { kind: 'move', shape: hit, before: snapshot(), orig: structuredClone(hit), start: p };
    return;
  }

  if (tool === 'select') {
    select(null);
    return;
  }

  const before = snapshot();
  const shape = Shapes.create(tool, p, { color: state.color, sizeIndex: state.sizeIndex, unit: state.unit });
  if (!shape) return;
  if (tool === 'step') shape.n = nextStepNumber();
  state.shapes.push(shape);

  if (tool === 'text') {
    select(shape);
    startTextEdit(shape, { before, isNew: true });
    return;
  }

  if (tool === 'step') {
    select(shape);
    commit(before);
    // l'étape suit le pointeur tant que le bouton est enfoncé
    interaction = { kind: 'move', shape, before: null, orig: structuredClone(shape), start: p };
    return;
  }

  state.selected = null;
  interaction = { kind: 'draw', shape, before, start: p };
  requestRender();
}

function onPointerMove(e) {
  if (!state.base) return;
  const it = interaction;
  if (!it) {
    updateCursor(e);
    return;
  }
  if (it.kind === 'pan') {
    stage.scrollLeft = it.left - (e.clientX - it.x);
    stage.scrollTop = it.top - (e.clientY - it.y);
    return;
  }

  const p = toImage(e);
  const s = it.shape;
  switch (it.kind) {
    case 'draw':
      updateDraw(s, p, e.shiftKey, it.start);
      break;
    case 'move': {
      Object.assign(s, structuredClone(it.orig));
      Shapes.translate(s, p.x - it.start.x, p.y - it.start.y);
      break;
    }
    case 'handle':
      Shapes.resize(s, it.orig, it.handle, p, e.shiftKey);
      break;
    case 'crop':
      it.x1 = p.x;
      it.y1 = p.y;
      break;
  }
  requestRender();
}

function updateDraw(s, p, constrain, start) {
  switch (s.type) {
    case 'rect':
    case 'ellipse':
    case 'blur': {
      let w = p.x - start.x, h = p.y - start.y;
      if (constrain && s.type !== 'blur') {
        const m = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * m;
        h = Math.sign(h || 1) * m;
      }
      s.w = w;
      s.h = h;
      break;
    }
    case 'line':
    case 'arrow': {
      const q = constrain ? Shapes.snapAngle(s.x1, s.y1, p.x, p.y) : p;
      s.x2 = q.x;
      s.y2 = q.y;
      break;
    }
    case 'pen':
    case 'marker': {
      if (constrain) {
        const q = Shapes.snapAngle(start.x, start.y, p.x, p.y);
        s.points = [[start.x, start.y], [q.x, q.y]];
        break;
      }
      const last = s.points[s.points.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) >= 1.5 / state.scale) s.points.push([p.x, p.y]);
      break;
    }
  }
}

function onPointerUp() {
  const it = interaction;
  interaction = null;
  if (!it) return;
  if (it.kind === 'pan') {
    stage.style.cursor = '';
    return;
  }

  const s = it.shape;
  switch (it.kind) {
    case 'draw':
      if (Shapes.isDegenerate(s, 3 / state.scale)) {
        state.shapes = state.shapes.filter((x) => x !== s);
      } else {
        Shapes.normalize(s);
        commit(it.before);
        select(s);
      }
      break;
    case 'move':
    case 'handle': {
      Shapes.normalize(s);
      const changed = JSON.stringify(s) !== JSON.stringify(it.orig);
      if (changed && it.before) commit(it.before);
      break;
    }
    case 'crop': {
      const r = cropRect(it);
      if (r.w >= 4 && r.h >= 4) applyCrop(r);
      else setStatusSize(`${state.base.width} × ${state.base.height} px`);
      break;
    }
  }
  requestRender();
}

function onDoubleClick(e) {
  if (!state.base || e.target === textEditor) return;
  const hit = hitTest(toImage(e));
  if (hit?.type === 'text') startTextEdit(hit);
}

function updateCursor(e) {
  if (spaceDown) {
    stage.style.cursor = 'grab';
    return;
  }
  const p = toImage(e);
  const tool = state.tool;
  let cursor = TOOLS[tool].cursor;
  if (tool !== 'crop') {
    const handle = state.selected && hitHandle(state.selected, p);
    if (handle) {
      cursor = handle.cursor;
    } else {
      const hit = hitTest(p);
      if (hit && (tool === 'select' || hit === state.selected)) cursor = 'move';
      else if (hit?.type === 'text' && tool === 'text') cursor = 'text';
    }
  }
  stage.style.cursor = cursor;
}

function applyCrop(r) {
  const before = snapshot();
  const base = document.createElement('canvas');
  base.width = r.w;
  base.height = r.h;
  base.getContext('2d').drawImage(state.base, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  state.base = base;
  state.shapes.forEach((s) => Shapes.translate(s, -r.x, -r.y));
  commit(before);
  state.fit = true;
  setTool(state.lastDrawTool);
  layout();
  toast('Image rognée — Ctrl+Z pour annuler');
}

function nudgeSelected(dx, dy) {
  const s = state.selected;
  if (!s) return;
  const before = snapshot();
  Shapes.translate(s, dx, dy);
  commit(before);
  requestRender();
}

// -------------------------------------------------------------- toolbar

function setTool(tool) {
  if (!TOOLS[tool]) return;
  commitTextEdit();
  state.tool = tool;
  if (!['select', 'crop'].includes(tool)) state.lastDrawTool = tool;
  if (tool === 'crop') select(null);
  $$('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
  $('#status-hint').textContent = TOOLS[tool].hint;
  stage.style.cursor = TOOLS[tool].cursor;
}

function renderProps() {
  $$('.swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.color === state.color)));
  $$('.size').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.size) === state.sizeIndex)));
}

// Change la couleur ou la taille : s'applique aussi à l'annotation sélectionnée.
function applyToSelection(mutate) {
  const s = textEdit?.shape ?? state.selected;
  if (!s) return;
  const before = snapshot();
  const prev = JSON.stringify(s);
  mutate(s);
  if (textEdit) {
    styleTextEditor();
    positionTextEditor();
  } else if (JSON.stringify(s) !== prev) {
    commit(before);
  }
  requestRender();
}

function setColor(color) {
  state.color = color;
  $('#custom-color').value = color;
  renderProps();
  applyToSelection((s) => {
    if (Shapes.hasColor(s)) s.color = color;
  });
}

function setSize(index) {
  state.sizeIndex = index;
  renderProps();
  applyToSelection((s) => Shapes.applySize(s, index, state.unit));
}

function buildToolbar() {
  const swatches = $('#swatches');
  for (const [color, label] of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = color;
    b.style.setProperty('--c', color);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', label);
    b.addEventListener('click', () => setColor(color));
    swatches.append(b);
  }
  const sizes = $('#sizes');
  [5, 8, 11, 15].forEach((dot, i) => {
    const b = document.createElement('button');
    b.className = 'size';
    b.dataset.size = String(i);
    b.dataset.tip = `Taille : ${SIZE_LABELS[i]} (${i + 1})`;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', SIZE_LABELS[i]);
    const span = document.createElement('span');
    span.style.width = span.style.height = `${dot}px`;
    b.append(span);
    b.addEventListener('click', () => setSize(i));
    sizes.append(b);
  });
  $('#custom-color').addEventListener('input', (e) => setColor(e.target.value));

  $$('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#btn-undo').addEventListener('click', undo);
  $('#btn-redo').addEventListener('click', redo);
  $('#btn-delete').addEventListener('click', deleteSelected);
  $('#btn-copy').addEventListener('click', copyImage);
  $('#btn-save').addEventListener('click', saveImage);
  $('#btn-capture').addEventListener('click', () => capture('region'));
  $('#btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('#btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
  $('#btn-zoom-fit').addEventListener('click', zoomFit);
  $('#zoom-label').addEventListener('click', zoomActual);

  const menu = $('#capture-menu');
  const menuButton = $('#btn-capture-menu');
  const toggleMenu = (open = menu.hidden) => {
    menu.hidden = !open;
    menuButton.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('button')?.focus();
  };
  menuButton.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !e.target.closest('.capture-group')) toggleMenu(false);
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
    else if (e.key === 'Escape') {
      toggleMenu(false);
      menuButton.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });

  $$('[data-action]').forEach((b) =>
    b.addEventListener('click', () => {
      toggleMenu(false);
      runAction(b.dataset.action);
    }),
  );
}

function runAction(action) {
  switch (action) {
    case 'capture-region': return capture('region');
    case 'capture-fullscreen': return capture('fullscreen');
    case 'capture-delay': return capture('delay');
    case 'open': return openImage();
    case 'paste': return pasteImage();
  }
}

function updateButtons() {
  $('#btn-undo').disabled = !undoStack.length;
  $('#btn-redo').disabled = !redoStack.length;
  $('#btn-delete').disabled = !state.selected;
}

// ------------------------------------------------------------------ actions

function capture(mode) {
  commitTextEdit();
  if (!api) {
    toast("La capture d'écran est disponible dans l'application de bureau.");
    return;
  }
  if (mode === 'delay') toast('Capture dans 3 secondes…');
  api.capture(mode);
}

async function copyImage() {
  if (!state.base) return;
  commitTextEdit();
  const out = exportCanvas();
  try {
    if (api) {
      await api.copyImage(out.toDataURL('image/png'));
    } else {
      const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    }
    setDirty(false);
    toast('Image copiée dans le presse-papiers');
  } catch {
    toast("La copie dans le presse-papiers a échoué.");
  }
}

async function saveImage() {
  if (!state.base) return;
  commitTextEdit();
  const dataUrl = exportCanvas().toDataURL('image/png');
  if (!api) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${state.name}.png`;
    a.click();
    setDirty(false);
    return;
  }
  try {
    const filePath = await api.saveImage(dataUrl, state.name);
    if (!filePath) return;
    state.name = filePath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    setDirty(false);
    toast(`Enregistrée : ${filePath}`);
  } catch {
    toast("L'enregistrement a échoué.");
  }
}

async function openImage() {
  if (api) {
    try {
      openPayload(await api.openImage());
    } catch (err) {
      toast(err?.message ?? "Impossible d'ouvrir cette image.");
    }
  } else {
    $('#file-input').click();
  }
}

async function pasteImage() {
  if (api) {
    const payload = await api.readClipboardImage();
    if (payload) openPayload(payload);
    else toast('Le presse-papiers ne contient pas d’image.');
    return;
  }
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) {
        const blob = await item.getType(type);
        openPayload(await readFile(new File([blob], defaultName(), { type })));
        return;
      }
    }
    toast('Le presse-papiers ne contient pas d’image.');
  } catch {
    toast('Utilisez Ctrl+V pour coller une image.');
  }
}

let toastTimer = 0;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ------------------------------------------------------------------ clavier

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (mod) {
    const handled = {
      z: () => (e.shiftKey ? redo() : undo()),
      y: redo,
      c: copyImage,
      s: saveImage,
      n: () => capture('region'),
      o: openImage,
      v: () => api && pasteImage(), // dans le navigateur, l'événement « paste » s'en charge
      0: zoomFit,
      1: zoomActual,
      '=': () => zoomBy(1.25),
      '+': () => zoomBy(1.25),
      '-': () => zoomBy(0.8),
    }[key];
    if (handled) {
      if (key !== 'v' || api) e.preventDefault();
      handled();
    }
    return;
  }

  if (e.key === ' ' && !e.repeat && state.base) {
    spaceDown = true;
    stage.style.cursor = 'grab';
    e.preventDefault();
    return;
  }
  if (!state.base) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (e.key === 'Escape') {
    if (interaction?.kind === 'draw') state.shapes = state.shapes.filter((s) => s !== interaction.shape);
    interaction = null;
    select(null);
    return;
  }
  const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[key];
  if (arrows && state.selected) {
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 1) * state.unit;
    nudgeSelected(arrows[0] * step, arrows[1] * step);
    return;
  }
  if (/^[1-4]$/.test(e.key)) {
    setSize(Number(e.key) - 1);
    return;
  }
  const tool = Object.entries(TOOLS).find(([, t]) => t.key === key)?.[0];
  if (tool) setTool(tool);
});

document.addEventListener('keyup', (e) => {
  if (e.key === ' ') {
    spaceDown = false;
    stage.style.cursor = TOOLS[state.tool].cursor;
  }
});

// Coller (navigateur, ou Ctrl+V géré nativement)
document.addEventListener('paste', async (e) => {
  if (api || e.target.closest?.('input, textarea')) return;
  const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault();
  openPayload(await readFile(file));
});

// ------------------------------------------------------------ glisser-déposer

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  $('#drop-hint').hidden = false;
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#drop-hint').hidden = true;
  }
});
document.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-hint').hidden = true;
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (file) openPayload(await readFile(file));
  else if (e.dataTransfer?.files?.length) toast('Seules les images peuvent être ouvertes.');
});

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) openPayload(await readFile(file));
});

// ------------------------------------------------------------------- init

stage.tabIndex = -1;
stage.addEventListener('pointerdown', onPointerDown);
stage.addEventListener('pointermove', onPointerMove);
stage.addEventListener('pointerup', onPointerUp);
stage.addEventListener('pointercancel', onPointerUp);
stage.addEventListener('dblclick', onDoubleClick);
stage.addEventListener(
  'wheel',
  (e) => {
    if (!state.base || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoomBy(Math.exp(-e.deltaY * 0.0015), { x: e.clientX, y: e.clientY });
  },
  { passive: false },
);
window.addEventListener('resize', () => state.fit && layout());
window.addEventListener('beforeunload', (e) => {
  if (state.dirty && state.base) {
    e.preventDefault();
    e.returnValue = '';
  }
});

buildToolbar();
renderProps();
setTool('arrow');
updateButtons();

(async () => {
  if (api) {
    api.onLoadImage((payload) => loadImage(payload));
    const info = await api.getInfo();
    for (const { mode, label } of info.shortcuts) {
      const kbd = document.querySelector(`kbd[data-shortcut="${mode}"]`);
      if (kbd && !kbd.textContent) kbd.textContent = label;
    }
    const region = info.shortcuts.find((s) => s.mode === 'region');
    if (region) {
      $('#empty-hint').innerHTML = '';
      $('#empty-hint').append(
        'Raccourci global : ',
        Object.assign(document.createElement('kbd'), { textContent: region.label }),
        ' · Vous pouvez aussi coller (Ctrl+V) ou glisser une image ici.',
      );
    }
    const initial = await api.getInitialImage();
    if (initial) await loadImage(initial);
  } else if (new URLSearchParams(location.search).has('demo')) {
    await loadImage({ dataUrl: demoImage(), name: 'Démo' });
  }
})();

// Image de démonstration pour tester l'éditeur dans un navigateur (?demo).
function demoImage() {
  const c = document.createElement('canvas');
  c.width = 1200;
  c.height = 760;
  const g = c.getContext('2d');
  g.fillStyle = '#f3f4f7';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, 64);
  g.fillStyle = '#1f2330';
  g.font = '600 22px Segoe UI, sans-serif';
  g.fillText('Tableau de bord', 32, 40);
  const cards = [['Utilisateurs', '12 480'], ['Revenus', '48 920 €'], ['Conversion', '3,8 %']];
  cards.forEach(([label, value], i) => {
    const x = 32 + i * 384;
    g.fillStyle = '#fff';
    g.beginPath();
    g.roundRect(x, 96, 360, 140, 12);
    g.fill();
    g.fillStyle = '#6b7080';
    g.font = '16px Segoe UI, sans-serif';
    g.fillText(label, x + 24, 136);
    g.fillStyle = '#1f2330';
    g.font = '600 38px Segoe UI, sans-serif';
    g.fillText(value, x + 24, 196);
  });
  g.fillStyle = '#fff';
  g.beginPath();
  g.roundRect(32, 264, 1136, 460, 12);
  g.fill();
  g.strokeStyle = '#7c5cff';
  g.lineWidth = 4;
  g.beginPath();
  for (let i = 0; i <= 20; i++) {
    const x = 64 + i * 54;
    const y = 620 - Math.sin(i / 3) * 90 - i * 12;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.stroke();
  g.fillStyle = '#1f2330';
  g.font = '15px Segoe UI, sans-serif';
  g.fillText('Clé API : sk-live-8f2a91c4e0b7d3', 64, 312);
  return c.toDataURL('image/png');
}
