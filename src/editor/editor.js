'use strict';

// Pont vers le processus principal (absent quand la page est ouverte dans un simple navigateur).
const api = window.snapit ?? null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const stage = $('#stage');
const textEditor = $('#text-editor');

// Langue de l'interface (mise à jour par les paramètres de l'application)
let lang = I18N.resolve('auto', navigator.language);
const t = (key, params) => I18N.t(lang, key, params);

// [couleur, clé de traduction du nom]
const COLORS = [
  ['#e5484d', 'red'],
  ['#f76b15', 'orange'],
  ['#ffc53d', 'yellow'],
  ['#30a46c', 'green'],
  ['#0090ff', 'blue'],
  ['#8e4ec6', 'purple'],
  ['#ffffff', 'white'],
  ['#1c1c1f', 'black'],
];
// Palette étendue proposée dans le sélecteur de couleur (fond, contour…)
const PALETTE = [
  ...COLORS,
  ['#ff8dc7', 'pink'],
  ['#ffe629', 'brightYellow'],
  ['#7ce2fe', 'sky'],
  ['#3dd68c', 'mint'],
  ['#fff7c2', 'cream'],
  ['#e0e1e6', 'lightGray'],
  ['#8b8d98', 'gray'],
  ['#3a3a44', 'charcoal'],
];

const TOOL_ICONS = {
  arrow: 'i-arrow',
  line: 'i-line',
  rect: 'i-rect',
  ellipse: 'i-ellipse',
  pen: 'i-pen',
  marker: 'i-marker',
  text: 'i-text',
  step: 'i-step',
  blur: 'i-blur',
  select: 'i-select',
  crop: 'i-crop',
};

// Contrôles du panneau de propriétés. Libellé : « prop.<clé> » ; options : [valeur, icône, clé « opt.* »].
// « when » masque un contrôle selon les autres réglages.
const CONTROLS = {
  color: { type: 'swatches' },
  width: { type: 'range', min: 1, max: 40, suffix: ' px' },
  heads: { type: 'segmented', options: [['end', 'i-head-end'], ['start', 'i-head-start'], ['both', 'i-head-both'], ['none', 'i-head-none']] },
  headStyle: { type: 'segmented', options: [['filled', 'i-hs-filled'], ['open', 'i-hs-open'], ['dot', 'i-hs-dot']], when: (v) => v.heads !== 'none' },
  taper: {
    type: 'toggle',
    icon: 'i-taper',
    withText: true,
    when: (v) => (v.heads === 'end' || v.heads === 'start') && v.headStyle === 'filled' && v.dash === 'solid',
  },
  dash: { type: 'segmented', options: [['solid', 'i-dash-solid'], ['dashed', 'i-dash-dashed'], ['dotted', 'i-dash-dotted']] },
  radius: { type: 'range', min: 0, max: 60, suffix: ' px' },
  fill: { type: 'color', none: true },
  fillOpacity: { type: 'range', min: 5, max: 100, suffix: ' %', when: (v) => v.fill },
  fontFamily: { type: 'select', options: Shapes.FONTS.map((f) => [f.name, f.name]) },
  fontSize: { type: 'number', min: 6, max: 400, step: 1 },
  bold: { type: 'toggle', icon: 'i-bold' },
  italic: { type: 'toggle', icon: 'i-italic' },
  background: { type: 'color', none: true },
  stepSize: { type: 'range', min: 8, max: 80, suffix: ' px' },
  stepShape: { type: 'segmented', options: [['circle', 'i-step-circle'], ['square', 'i-step-square']] },
  number: { type: 'number', min: 0, max: 9999, step: 1 },
  blurMode: { type: 'segmented', options: [['pixelate', 'i-blur'], ['blur', 'i-blur-soft']] },
  intensity: { type: 'range', min: 2, max: 50 },
  outline: { type: 'color', none: true },
  outlineWidth: { type: 'range', min: 1, max: 12, suffix: ' px', when: (v) => v.outline },
  shadow: { type: 'toggle', icon: 'i-shadow', withText: true },
  opacity: { type: 'range', min: 10, max: 100, suffix: ' %' },
};

const TOOL_PROPS = {
  arrow: ['color', 'width', 'heads', 'headStyle', 'taper', 'dash', 'outline', 'outlineWidth', 'shadow', 'opacity'],
  line: ['color', 'width', 'dash', 'outline', 'outlineWidth', 'shadow', 'opacity'],
  rect: ['color', 'width', 'dash', 'radius', 'fill', 'fillOpacity', 'outline', 'outlineWidth', 'shadow', 'opacity'],
  ellipse: ['color', 'width', 'dash', 'fill', 'fillOpacity', 'outline', 'outlineWidth', 'shadow', 'opacity'],
  pen: ['color', 'width', 'outline', 'outlineWidth', 'shadow', 'opacity'],
  marker: ['color', 'width', 'opacity'],
  text: ['color', 'fontFamily', 'fontSize', 'bold', 'italic', 'outline', 'outlineWidth', 'background', 'shadow'],
  step: ['color', 'stepSize', 'stepShape', 'number', 'outline', 'outlineWidth', 'shadow'],
  blur: ['blurMode', 'intensity'],
};

const STYLES_KEY = 'snapit.toolStyles.v1';
const PRESETS_KEY = 'snapit.presets.v1';
const MAX_PRESETS = 12;

// Réglages par outil, mémorisés entre les sessions.
function loadStyles() {
  const styles = structuredClone(Shapes.DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(STYLES_KEY) || '{}');
    for (const [tool, values] of Object.entries(saved)) {
      if (!styles[tool] || typeof values !== 'object') continue;
      for (const key of Object.keys(styles[tool])) {
        if (key in values) styles[tool][key] = values[key];
      }
    }
  } catch {
    // réglages illisibles : on garde les valeurs par défaut
  }
  return styles;
}

function saveStyles() {
  try {
    localStorage.setItem(STYLES_KEY, JSON.stringify(state.styles));
  } catch {
    // stockage indisponible : les réglages ne dureront que la session
  }
}

// Préréglages proposés au premier lancement (l'utilisateur peut les supprimer).
const STARTER_PRESETS = {
  arrow: [{}, { color: '#ffc53d', width: 6, outline: '#1c1c1f', outlineWidth: 2 }, { color: '#0090ff', width: 4, dash: 'dashed', taper: false }, { color: '#ffffff', width: 6, outline: '#e5484d', outlineWidth: 2 }],
  line: [{}, { color: '#0090ff', dash: 'dashed' }],
  rect: [{}, { color: '#0090ff', radius: 12 }, { color: '#ffc53d', fill: '#ffc53d', fillOpacity: 20, shadow: false }],
  ellipse: [{}, { color: '#30a46c', width: 5 }],
  pen: [{}, { color: '#0090ff' }],
  marker: [{}, { color: '#7ce2fe' }, { color: '#3dd68c' }, { color: '#ff8dc7' }],
  text: [{}, { color: '#ffffff', outline: null, background: '#1c1c1f' }, { color: '#1c1c1f', outline: null, background: '#ffe629' }, { color: '#ffffff', outline: '#1c1c1f', fontFamily: 'Impact', bold: false }],
  step: [{}, { color: '#0090ff' }, { color: '#1c1c1f', stepShape: 'square' }],
  blur: [{}, { blurMode: 'blur', intensity: 12 }],
};

let presetSeq = 0;
const presetId = () => `p${Date.now().toString(36)}${(presetSeq++).toString(36)}`;

// Préréglage : { id, style, custom }. `custom` : enregistré par l'utilisateur (bouton +), donc réuni avec
// ceux des autres outils dans la catégorie « Mes préréglages » ; les préréglages proposés restent dans leur outil.
function loadPresets() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}');
  } catch {
    saved = {};
  }
  const presets = {};
  for (const tool of Object.keys(Shapes.DEFAULTS)) {
    const starters = STARTER_PRESETS[tool].map((overrides) => pickStyle(tool, { ...Shapes.DEFAULTS[tool], ...overrides }));
    const list = Array.isArray(saved[tool]) ? saved[tool] : starters.map((style) => ({ style, custom: false }));
    // ne garde que les réglages connus de l'outil, complétés par les valeurs par défaut
    presets[tool] = list
      .filter((p) => p && typeof p.style === 'object')
      .map((p) => {
        const style = pickStyle(tool, { ...Shapes.DEFAULTS[tool], ...p.style });
        // enregistré avant « Mes préréglages » : de l'utilisateur s'il ne fait pas partie des préréglages proposés
        const custom = typeof p.custom === 'boolean' ? p.custom : !starters.some((s) => sameStyle(s, style));
        return { id: p.id || presetId(), style, custom };
      });
  }
  return presets;
}

function savePresets() {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(state.presets));
  } catch {
    // stockage indisponible
  }
}

// Extrait d'une annotation (ou d'un style) les seuls réglages propres à l'outil.
function pickStyle(tool, source) {
  const style = {};
  for (const key of Object.keys(Shapes.DEFAULTS[tool])) style[key] = source[key];
  return style;
}

const sameStyle = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const TOOLS = {
  presets: { key: 'm' }, // catégorie « Mes préréglages » : on y dessine avec l'outil du préréglage choisi
  select: { key: 'v', cursor: 'default' },
  arrow: { key: 'a', cursor: 'crosshair' },
  rect: { key: 'r', cursor: 'crosshair' },
  ellipse: { key: 'e', cursor: 'crosshair' },
  line: { key: 'l', cursor: 'crosshair' },
  pen: { key: 'p', cursor: 'crosshair' },
  marker: { key: 'h', cursor: 'crosshair' },
  text: { key: 't', cursor: 'text' },
  step: { key: 'n', cursor: 'copy' },
  blur: { key: 'b', cursor: 'crosshair' },
  crop: { key: 'c', cursor: 'crosshair' },
};

const state = {
  base: null, // canvas contenant l'image d'origine (ou rognée)
  shapes: [],
  tool: 'arrow',
  lastDrawTool: 'arrow',
  presetsView: false, // catégorie « Mes préréglages » affichée (`tool` reste l'outil de dessin)
  activePreset: null, // dernier préréglage choisi { tool, id } : modifié ensuite, il peut être mis à jour
  styles: null, // réglages de chaque outil (voir loadStyles)
  presets: null, // préréglages enregistrés, par outil
  nextStep: null, // numéro imposé pour la prochaine étape (null : à la suite des existantes)
  unit: 1, // facteur d'échelle de l'écran capturé : garde des annotations lisibles en haute densité
  selected: null,
  scale: 1, // pixels CSS par pixel d'image
  fit: true,
  dirty: false,
  name: 'Capture',
  libraryId: null, // capture de la bibliothèque affichée (enregistrée automatiquement)
};

const undoStack = [];
const redoStack = [];
let interaction = null;
let textEdit = null;
let spaceDown = false;
let renderQueued = false;

state.styles = loadStyles();
state.presets = loadPresets();

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
  if (dirty) scheduleAutosave();
  // une capture de la bibliothèque s'enregistre seule : pas de marque « non enregistrée »
  document.title = state.base ? `${dirty && !state.libraryId ? '• ' : ''}${state.name} — Snapit` : 'Snapit';
}

// -------------------------------------------------------------------- image

// `libraryId` et `shapes` : capture rouverte depuis la bibliothèque, avec ses annotations.
async function loadImage({ dataUrl, scaleFactor = 1, name, libraryId = null, shapes = [], copied = false, notice = null }) {
  const img = new Image();
  // image servie par l'application (version Tauri) : chargée avec CORS pour que l'export reste possible
  if (/^https?:/.test(dataUrl)) img.crossOrigin = 'anonymous';
  img.src = dataUrl;
  await img.decode();
  const base = document.createElement('canvas');
  base.width = img.naturalWidth;
  base.height = img.naturalHeight;
  base.getContext('2d').drawImage(img, 0, 0);

  cancelTextEdit();
  interaction = null;
  state.base = base;
  state.shapes = adoptShapes(shapes);
  state.selected = null;
  state.unit = Math.max(1, scaleFactor || 1);
  state.name = name || defaultName();
  state.libraryId = libraryId;
  state.fit = true;
  state.nextStep = null;
  undoStack.length = 0;
  redoStack.length = 0;
  resetAutosave(base);
  Shapes.setUnit(state.unit);

  document.body.classList.add('has-image');
  api?.setDocument({ hasImage: true, libraryId });
  setDirty(false);
  layout();
  stage.scrollTo(0, 0); // une page entière s'affiche depuis son haut
  requestRender();
  updateButtons();
  renderPropsBar();
  syncGalleryActive();
  stage.focus();
  if (notice) toast(notice);
  else if (copied) toast(t('toast.captureCopied'));
}

// Annotations enregistrées : types connus, réglages complétés, identifiants propres à cette session.
function adoptShapes(list) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && typeof s === 'object' && Shapes.DEFAULTS[s.type])
    .map((s) => ({ ...structuredClone(Shapes.DEFAULTS[s.type]), ...s, id: Shapes.nextId() }));
}

// La capture affichée a été supprimée de la bibliothèque : retour à l'écran d'accueil.
function unloadImage() {
  cancelTextEdit();
  interaction = null;
  resetAutosave(null);
  Object.assign(state, { base: null, shapes: [], selected: null, libraryId: null, nextStep: null });
  undoStack.length = 0;
  redoStack.length = 0;
  document.body.classList.remove('has-image');
  api?.setDocument({ hasImage: false, libraryId: null });
  setDirty(false);
  setStatusSize('');
  updateButtons();
  renderPropsBar();
  syncGalleryActive();
}

// Ouvre une image : dans cette fenêtre si elle est vide. Sinon le processus principal choisit :
// cette fenêtre si sa capture est enregistrée dans la bibliothèque, une autre sinon.
function openPayload(payload) {
  if (!payload) return;
  if (state.base && api) api.showImage(payload);
  else loadImage(payload).catch(() => toast(t('toast.openFailed')));
}

// Image envoyée par le processus principal (capture, galerie…) : la capture affichée est
// d'abord enregistrée, texte en cours d'écriture compris.
let loadQueue = Promise.resolve();
function replaceDocument(payload) {
  loadQueue = loadQueue
    .then(async () => {
      commitTextEdit();
      await flushAutosave();
      await loadImage(payload);
    })
    .catch(() => toast(t('toast.openFailed')));
  return loadQueue;
}

function defaultName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return t('capture.name', {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`,
  });
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
  const cropping = interaction?.kind === 'crop';
  if (cropping) drawCropPreview(interaction);
  positionCropHandles(cropping ? cropRect(interaction) : null);
  if (state.selected && state.selected !== textEdit?.shape && interaction?.kind !== 'draw') drawSelection(state.selected);
}

// Poignées de rognage autour de l'image (ou de la zone en cours de rognage).
function positionCropHandles(r) {
  const rect = r ?? { x: 0, y: 0, w: state.base.width, h: state.base.height };
  for (const h of $$('.crop-handle')) {
    const edge = h.dataset.edge;
    const x = edge.includes('w') ? rect.x : edge.includes('e') ? rect.x + rect.w : rect.x + rect.w / 2;
    const y = edge.includes('n') ? rect.y : edge.includes('s') ? rect.y + rect.h : rect.y + rect.h / 2;
    h.style.left = `${x * state.scale}px`;
    h.style.top = `${y * state.scale}px`;
  }
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
  const { width, height } = state.base;
  const whole = Math.min(w / width, h / height);
  // Page entière (capture défilante) : en entier, elle ne serait qu'une bande illisible ; on l'ajuste à la largeur.
  const scale = height > width && whole * width < w / 3 ? w / width : whole;
  // Ne jamais agrandir au-delà de la taille réelle (1 pixel d'image = 1 pixel physique).
  return Math.min(scale, 1 / dpr);
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
  if (textEdit) styleTextEditor();
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
  updateButtons();
  renderPropsBar();
  requestRender();
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
  if (state.nextStep != null) return state.nextStep;
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
  document.body.classList.add('editing-text');
  state.selected = shape;
  textEditor.value = shape.text;
  textEditor.hidden = false;
  styleTextEditor();
  positionTextEditor();
  requestRender();
  textEditor.focus();
  textEditor.setSelectionRange(textEditor.value.length, textEditor.value.length);
}

// Le champ de saisie imite le rendu final (police, contour, fond) pendant l'écriture.
function styleTextEditor() {
  const s = textEdit.shape;
  const size = s.fontSize * state.unit * state.scale;
  const st = textEditor.style;
  st.fontFamily = Shapes.fontCss(s.fontFamily);
  st.fontWeight = s.bold ? '700' : '400';
  st.fontStyle = s.italic ? 'italic' : 'normal';
  st.fontSize = `${size}px`;
  st.color = s.color;
  st.background = s.background ?? 'transparent';
  st.borderRadius = `${size * 0.25}px`;
  const r = s.outline ? Math.max(0.5, s.outlineWidth * state.unit * state.scale) : 0;
  st.textShadow = r
    ? [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]].map(([x, y]) => `${x}px ${y}px 0 ${s.outline}`).join(', ')
    : 'none';
  positionTextEditor();
}

function positionTextEditor() {
  const s = textEdit.shape;
  // même boîte que le rendu : le line-height 1.25 du champ place le texte comme sur le canvas
  const b = Shapes.bounds(s);
  const padX = (s.x - b.x) * state.scale;
  const padY = (s.y - b.y) * state.scale;
  textEditor.style.padding = `${padY}px ${padX}px`;
  textEditor.style.left = `${b.x * state.scale}px`;
  textEditor.style.top = `${b.y * state.scale}px`;
  autosizeTextEditor();
}

function autosizeTextEditor() {
  textEditor.style.width = '0px';
  textEditor.style.height = '0px';
  const fs = textEdit.shape.fontSize * state.unit * state.scale;
  textEditor.style.width = `${textEditor.scrollWidth + fs * 0.6}px`;
  textEditor.style.height = `${textEditor.scrollHeight}px`;
}

function commitTextEdit() {
  if (!textEdit) return;
  const { shape, before, isNew, original } = textEdit;
  textEdit = null;
  textEditor.hidden = true;
  document.body.classList.remove('editing-text');
  shape.text = textEditor.value.replace(/\s+$/, '');
  if (!shape.text.trim()) {
    state.shapes = state.shapes.filter((s) => s !== shape);
    if (state.selected === shape) state.selected = null;
    if (!isNew) commit(before);
  } else if (isNew || shape.text !== original) {
    commit(before);
  }
  updateButtons();
  renderPropsBar();
  requestRender();
  stage.focus();
}

function cancelTextEdit() {
  if (!textEdit) return;
  const { shape, isNew, original } = textEdit;
  textEdit = null;
  textEditor.hidden = true;
  document.body.classList.remove('editing-text');
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
  // (sauf si l'on règle la police ou la couleur dans la barre de propriétés)
  setTimeout(() => {
    const active = document.activeElement;
    if (textEdit && active !== textEditor && !active?.closest('#propsbar, #color-popover')) commitTextEdit();
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

  // Poignées autour de l'image : rognage direct, comme dans Paint
  const cropHandle = e.target.closest('.crop-handle');
  if (cropHandle) {
    select(null);
    stage.setPointerCapture(e.pointerId);
    const { width: w, height: h } = state.base;
    interaction = { kind: 'crop', edge: cropHandle.dataset.edge, x0: 0, y0: 0, x1: w, y1: h };
    stage.style.cursor = getComputedStyle(cropHandle).cursor; // garde le curseur pendant le glisser
    requestRender();
    return;
  }

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
  const shape = Shapes.create(tool, p, state.styles[tool]);
  if (!shape) return;
  if (tool === 'step') {
    shape.n = nextStepNumber();
    if (state.nextStep != null) state.nextStep = shape.n + 1;
  }
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
      if (it.edge) moveCropEdge(it, p);
      else {
        it.x1 = p.x;
        it.y1 = p.y;
      }
      break;
  }
  requestRender();
}

// Déplace le ou les bords saisis par une poignée, sans sortir de l'image ni inverser la zone.
function moveCropEdge(it, p) {
  const min = 8;
  const { width: w, height: h } = state.base;
  if (it.edge.includes('w')) it.x0 = Math.min(Math.max(0, p.x), it.x1 - min);
  if (it.edge.includes('e')) it.x1 = Math.max(Math.min(w, p.x), it.x0 + min);
  if (it.edge.includes('n')) it.y0 = Math.min(Math.max(0, p.y), it.y1 - min);
  if (it.edge.includes('s')) it.y1 = Math.max(Math.min(h, p.y), it.y0 + min);
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
      const unchanged = r.x === 0 && r.y === 0 && r.w === state.base.width && r.h === state.base.height;
      if (r.w >= 4 && r.h >= 4 && !unchanged) applyCrop(r);
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
  if (state.tool === 'crop') setTool(state.lastDrawTool);
  layout();
  toast(t('toast.cropped'));
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

// `presets` : catégorie « Mes préréglages », où l'on dessine avec l'outil `tool` (celui du préréglage choisi)
// sans quitter la catégorie. `setTool('presets')` l'ouvre avec le dernier outil de dessin.
function setTool(tool, { presets = false } = {}) {
  if (tool === 'presets') {
    presets = true;
    tool = state.lastDrawTool;
  }
  if (!TOOLS[tool]) return;
  commitTextEdit();
  state.tool = tool;
  state.presetsView = presets;
  if (!['select', 'crop'].includes(tool)) state.lastDrawTool = tool;
  // la barre de propriétés doit refléter le nouvel outil, pas l'annotation d'un autre type
  if (tool === 'crop' || (state.selected && tool !== 'select' && state.selected.type !== tool)) select(null);
  const pressed = presets ? 'presets' : tool;
  $$('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === pressed)));
  $('#status-hint').textContent = t(`hint.${tool}`);
  stage.style.cursor = TOOLS[tool].cursor;
  renderPropsBar();
}

// ------------------------------------------------------- barre de propriétés
// Affiche les réglages de l'annotation sélectionnée, sinon ceux de l'outil actif.
// Modifier un réglage met à jour l'annotation sélectionnée ET devient le réglage par défaut de l'outil.

let propsKey = null;
let propControls = [];
let pendingEdit = null; // modification continue (curseur glissé) : un seul pas d'annulation
let popover = null; // { anchor, key } du sélecteur de couleur ouvert

function propsContext() {
  const shape = textEdit?.shape ?? state.selected;
  if (shape && TOOL_PROPS[shape.type]) return { type: shape.type, shape };
  if (TOOL_PROPS[state.tool]) return { type: state.tool, shape: null };
  return { type: null, shape: null };
}

function propValues(c) {
  const values = { ...(c.shape ?? state.styles[c.type]) };
  if (c.type === 'step') values.number = c.shape ? c.shape.n : nextStepNumber();
  return values;
}

function renderPropsBar() {
  const c = propsContext();
  const key = `${state.presetsView ? 'mes-prereglages' : 'outil'}:${c.type ?? state.tool}:${c.shape?.id ?? 'outil'}`;
  if (key !== propsKey) {
    propsKey = key;
    buildPropsBar(c);
  }
  syncPropsBar(c);
}

function iconEl(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

function buildPropsBar(c) {
  closeColorPopover();
  pendingEdit = null;
  const title = $('#props-title');
  const box = $('#props-controls');
  title.replaceChildren();
  box.replaceChildren();
  propControls = [];

  // « Mes préréglages » : la liste de la catégorie, puis les réglages de l'outil choisi sous leur propre titre
  const presetsView = state.presetsView && Boolean(c.type);
  $('#propsbar').classList.toggle('presets-view', presetsView);
  if (presetsView) {
    title.append(iconEl('i-presets'), t('tool.presets'));
    box.append(propsSubhead(c));
  } else {
    appendToolTitle(title, c);
  }
  $('#btn-reset-style').hidden = !c.type || presetsView;
  renderPresets(c);

  if (!c.type) {
    const hint = document.createElement('span');
    hint.className = 'props-empty';
    hint.textContent = t(state.tool === 'crop' ? 'panel.emptyCrop' : 'panel.emptySelect');
    box.append(hint);
    return;
  }
  for (const key of TOOL_PROPS[c.type]) {
    const control = buildControl(key, CONTROLS[key]);
    propControls.push(control);
    box.append(control.el);
  }
}

// Outil (ou annotation sélectionnée) dont le panneau affiche les réglages.
function appendToolTitle(el, c) {
  const tool = c.type ?? state.tool;
  el.append(iconEl(TOOL_ICONS[tool] ?? 'i-select'), t(`tool.${tool}`));
  if (c.shape) {
    const small = document.createElement('small');
    small.textContent = t('panel.selection');
    el.append(small);
  }
}

// Titre des réglages dans « Mes préréglages » : l'outil, et de quoi rétablir ses valeurs d'origine.
function propsSubhead(c) {
  const head = document.createElement('div');
  head.className = 'props-subhead';
  const title = document.createElement('div');
  title.className = 'props-title';
  appendToolTitle(title, c);
  const reset = document.createElement('button');
  reset.className = 'btn mini';
  reset.title = t('panel.reset');
  reset.setAttribute('aria-label', t('panel.reset'));
  reset.append(iconEl('i-reset'));
  reset.addEventListener('click', () => {
    resetStyle();
    refocusText();
  });
  head.append(title, reset);
  return head;
}

function syncPropsBar(c = propsContext()) {
  if (!c.type) return;
  const values = propValues(c);
  for (const control of propControls) {
    const def = CONTROLS[control.key];
    control.el.hidden = def.when ? !def.when(values) : false;
    control.sync(values[control.key]);
  }
  syncPresets(c);
}

// ------------------------------------------------------------- préréglages
// Styles enregistrés par outil, appliqués en un clic (à l'outil et à l'annotation sélectionnée).
// La catégorie « Mes préréglages » réunit ceux de l'utilisateur, tous outils confondus.

const THUMB_W = 56;
const THUMB_H = 40;

function currentStyle(c) {
  return pickStyle(c.type, c.shape ?? state.styles[c.type]);
}

function renderPresets(c) {
  const box = $('#presets');
  box.hidden = !c.type;
  if (!c.type) return;
  const list = $('#preset-list');
  list.replaceChildren();
  if (state.presetsView) renderMyPresets(list);
  else for (const preset of state.presets[c.type]) list.append(presetItem(c.type, preset));
  // + enregistre le style de l'outil affiché (dans « Mes préréglages », celui des réglages en dessous)
  if (state.presets[c.type].length < MAX_PRESETS) {
    const add = document.createElement('button');
    add.className = 'preset-add';
    add.title = t('presets.add');
    add.setAttribute('aria-label', t('presets.add'));
    add.append(iconEl('i-plus-circle'));
    add.addEventListener('click', () => {
      addPreset();
      refocusText();
    });
    list.append(add);
  }
}

// « Mes préréglages » : ceux de l'utilisateur, tous outils confondus, dans l'ordre de la barre d'outils
// (la miniature montre l'outil, l'infobulle le nomme).
function renderMyPresets(list) {
  for (const tool of Object.keys(TOOLS).filter((tool) => TOOL_PROPS[tool])) {
    for (const preset of state.presets[tool]) if (preset.custom) list.append(presetItem(tool, preset));
  }
  if (!list.children.length) {
    const empty = document.createElement('p');
    empty.className = 'presets-empty';
    empty.textContent = t('presets.empty');
    list.append(empty);
  }
}

function presetItem(tool, preset) {
  const item = document.createElement('div');
  item.className = 'preset';
  const apply = document.createElement('button');
  apply.className = 'preset-apply';
  apply.dataset.tool = tool;
  apply.dataset.id = preset.id;
  apply.title = state.presetsView ? t('presets.applyTool', { tool: t(`tool.${tool}`) }) : t('presets.apply');
  apply.setAttribute('aria-label', apply.title);
  apply.append(presetThumbnail(tool, preset.style));
  apply.addEventListener('click', () => choosePreset(tool, preset));
  const remove = document.createElement('button');
  remove.className = 'preset-delete';
  remove.title = t('presets.delete');
  remove.setAttribute('aria-label', t('presets.delete'));
  remove.append(iconEl('i-close'));
  remove.addEventListener('click', () => deletePreset(tool, preset.id));
  // préréglage choisi puis modifié (classe « modified ») : au survol, le mettre à jour ou revenir à lui
  const menu = document.createElement('div');
  menu.className = 'preset-menu';
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', t('presets.modified'));
  menu.append(
    presetMenuButton(preset.id, 'i-save', 'presets.update', () => updatePreset(tool, preset.id)),
    presetMenuButton(preset.id, 'i-check', 'presets.reapply', () => choosePreset(tool, preset)),
  );
  const actions = document.createElement('div');
  actions.className = 'preset-actions';
  actions.append(menu);
  item.append(apply, remove, actions);
  return item;
}

function presetMenuButton(id, icon, key, action) {
  const b = document.createElement('button');
  b.title = t(`${key}Tip`);
  b.append(iconEl(icon), t(key));
  b.addEventListener('click', () => {
    action();
    // le menu a disparu : le focus revient sur la miniature, ou sur le texte en cours d'écriture
    if (textEdit) refocusText();
    else $(`.preset-apply[data-id="${id}"]`)?.focus();
  });
  return b;
}

function syncPresets(c) {
  if (!c.type) return;
  const style = currentStyle(c);
  // Le préréglage choisi est modifié quand les réglages affichés, ceux de l'outil, ne sont plus les siens.
  // Une annotation sélectionnée aux réglages différents de ceux de l'outil n'en vient pas : il reste tel quel.
  const own = sameStyle(style, pickStyle(c.type, state.styles[c.type]));
  const active = state.activePreset?.tool === c.type ? state.activePreset.id : null;
  for (const b of $$('#preset-list .preset-apply')) {
    const preset = b.dataset.tool === c.type && state.presets[c.type].find((p) => p.id === b.dataset.id);
    const pressed = Boolean(preset) && sameStyle(preset.style, style);
    b.setAttribute('aria-pressed', String(pressed));
    b.parentElement.classList.toggle('modified', Boolean(preset) && !pressed && own && preset.id === active);
  }
}

// Dans « Mes préréglages », choisir le préréglage d'un autre outil en fait l'outil de dessin.
function choosePreset(tool, preset) {
  const focused = document.activeElement?.matches('.preset-apply');
  if (propsContext().type !== tool) setTool(tool, { presets: state.presetsView });
  state.activePreset = { tool, id: preset.id };
  applyPreset(tool, preset);
  // la liste a pu être reconstruite : le focus reste sur le préréglage choisi
  if (focused && !textEdit) $(`.preset-apply[data-id="${preset.id}"]`)?.focus();
  refocusText();
}

function applyPreset(tool, preset) {
  const c = propsContext();
  state.styles[tool] = { ...state.styles[tool], ...structuredClone(preset.style) };
  saveStyles();
  if (c.shape?.type === tool) {
    const before = snapshot();
    const prev = JSON.stringify(c.shape);
    Object.assign(c.shape, structuredClone(preset.style));
    if (textEdit) styleTextEditor();
    else if (JSON.stringify(c.shape) !== prev) commit(before);
    requestRender();
  }
  syncPropsBar(c);
}

function addPreset() {
  const c = propsContext();
  if (!c.type) return;
  const style = currentStyle(c);
  const same = state.presets[c.type].find((p) => sameStyle(p.style, style));
  if (same?.custom) {
    toast(t('toast.presetExists'));
    return;
  }
  // un préréglage proposé d'office rejoint simplement « Mes préréglages »
  let preset = same;
  if (preset) preset.custom = true;
  else if (state.presets[c.type].length < MAX_PRESETS) {
    preset = { id: presetId(), style, custom: true };
    state.presets[c.type].push(preset);
  } else return;
  state.activePreset = { tool: c.type, id: preset.id };
  savePresets();
  renderPresets(c);
  syncPresets(c);
  toast(t('toast.presetSaved'));
}

// Enregistre dans le préréglage les réglages affichés, modifiés depuis qu'on l'a choisi.
function updatePreset(tool, id) {
  const c = propsContext();
  const preset = state.presets[tool].find((p) => p.id === id);
  if (!preset || c.type !== tool) return;
  const style = currentStyle(c);
  if (state.presets[tool].some((p) => p !== preset && sameStyle(p.style, style))) {
    toast(t('toast.presetDuplicate'));
    return;
  }
  preset.style = style;
  preset.custom = true; // un préréglage proposé d'office, une fois modifié, devient celui de l'utilisateur
  savePresets();
  renderPresets(c);
  syncPresets(c);
  toast(t('toast.presetUpdated'));
}

function deletePreset(tool, id) {
  state.presets[tool] = state.presets[tool].filter((p) => p.id !== id);
  if (state.activePreset?.id === id) state.activePreset = null;
  savePresets();
  const c = propsContext();
  renderPresets(c);
  syncPresets(c);
  toast(t('toast.presetDeleted'));
}

// Miniature : l'annotation d'exemple dessinée avec le style du préréglage.
function presetThumbnail(tool, style) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(THUMB_W * dpr);
  const h = Math.round(THUMB_H * dpr);
  const thumb = document.createElement('canvas');
  thumb.width = w;
  thumb.height = h;
  const g = thumb.getContext('2d');
  g.fillStyle = '#dfe1e8';
  g.fillRect(0, 0, w, h);

  let u = dpr * 0.5;
  let base = thumb;
  const s = { id: 0, type: tool, ...structuredClone(style) };
  switch (tool) {
    case 'arrow':
    case 'line':
      Object.assign(s, { x1: w * 0.16, y1: h * 0.74, x2: w * 0.84, y2: h * 0.28 });
      break;
    case 'rect':
    case 'ellipse':
      Object.assign(s, { x: w * 0.18, y: h * 0.2, w: w * 0.64, h: h * 0.6 });
      break;
    case 'pen':
      s.points = Array.from({ length: 13 }, (_, i) => [w * (0.14 + (0.72 * i) / 12), h * (0.5 + 0.22 * Math.sin((i / 12) * Math.PI * 2))]);
      break;
    case 'marker':
      s.points = [[w * 0.16, h * 0.5], [w * 0.84, h * 0.5]];
      break;
    case 'step':
      u = Math.min(u * 1.2, (h * 0.34) / style.stepSize);
      Object.assign(s, { x: w / 2, y: h / 2, n: 1 });
      break;
    case 'text':
      u = Math.min(u * 1.4, (h * 0.5) / style.fontSize);
      s.text = 'Aa';
      break;
    case 'blur': {
      // motif rayé + texte, pour voir l'effet de pixelisation ou de flou
      base = document.createElement('canvas');
      base.width = w;
      base.height = h;
      const b = base.getContext('2d');
      ['#e5484d', '#0090ff', '#ffc53d', '#30a46c'].forEach((color, i) => {
        b.fillStyle = color;
        b.fillRect((w / 4) * i, 0, w / 4, h);
      });
      b.fillStyle = '#fff';
      b.font = `700 ${h * 0.45}px sans-serif`;
      b.textAlign = 'center';
      b.textBaseline = 'middle';
      b.fillText('Abc', w / 2, h / 2);
      g.drawImage(base, 0, 0);
      Object.assign(s, { x: w * 0.12, y: h * 0.15, w: w * 0.76, h: h * 0.7 });
      break;
    }
  }

  Shapes.setUnit(u);
  try {
    if (tool === 'text') {
      const box = Shapes.bounds({ ...s, x: 0, y: 0 });
      s.x = (w - box.w) / 2 - box.x;
      s.y = (h - box.h) / 2 - box.y;
    }
    Shapes.draw(g, s, { base });
  } finally {
    Shapes.setUnit(state.unit);
  }
  return thumb;
}

// Après un clic dans la barre, rend la main au texte en cours d'écriture.
function refocusText() {
  if (textEdit) textEditor.focus();
}

function colorName(value) {
  const known = PALETTE.find(([c]) => c.toLowerCase() === value.toLowerCase());
  return known ? t(`color.${known[1]}`) : value.toUpperCase();
}

function buildControl(key, def) {
  const name = t(`prop.${key}`);
  const el = document.createElement('div');
  el.className = 'prop';

  // En-tête : libellé à gauche, valeur courante à droite
  const head = () => {
    const row = document.createElement('div');
    row.className = 'prop-head';
    const label = document.createElement('span');
    label.className = 'prop-label';
    label.textContent = name;
    const value = document.createElement('span');
    value.className = 'prop-value';
    row.append(label, value);
    el.append(row);
    return value;
  };
  const inlineLabel = () => {
    el.classList.add('row');
    const label = document.createElement('span');
    label.className = 'prop-label';
    label.textContent = name;
    el.append(label);
  };

  switch (def.type) {
    case 'swatches': {
      const value = head();
      const row = document.createElement('div');
      row.className = 'swatches';
      row.setAttribute('role', 'radiogroup');
      row.setAttribute('aria-label', name);
      for (const [color, colorKey] of COLORS) {
        const colorLabel = t(`color.${colorKey}`);
        const b = document.createElement('button');
        b.className = 'swatch';
        b.dataset.color = color;
        b.style.setProperty('--c', color);
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-label', colorLabel);
        b.title = colorLabel;
        b.addEventListener('click', () => {
          setProp(key, color);
          refocusText();
        });
        row.append(b);
      }
      const custom = document.createElement('label');
      custom.className = 'custom-color';
      custom.title = t('color.custom');
      const input = document.createElement('input');
      input.type = 'color';
      input.setAttribute('aria-label', t('color.custom'));
      input.addEventListener('input', () => setProp(key, input.value, { final: false }));
      input.addEventListener('change', () => setProp(key, input.value));
      custom.append(input);
      row.append(custom);
      el.append(row);
      return {
        key,
        el,
        sync(v) {
          let known = false;
          for (const b of row.querySelectorAll('.swatch')) {
            const on = b.dataset.color.toLowerCase() === v.toLowerCase();
            known ||= on;
            b.setAttribute('aria-checked', String(on));
          }
          custom.setAttribute('aria-checked', String(!known));
          custom.style.setProperty('--c', v);
          value.textContent = colorName(v);
          if (document.activeElement !== input) input.value = v;
        },
      };
    }

    case 'range': {
      const value = head();
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', min: def.min, max: def.max, step: 1 });
      input.setAttribute('aria-label', name);
      input.addEventListener('input', () => setProp(key, Number(input.value), { final: false }));
      input.addEventListener('change', () => setProp(key, Number(input.value)));
      el.append(input);
      return {
        key,
        el,
        sync(v) {
          input.value = v;
          value.textContent = `${v}${def.suffix ?? ''}`;
        },
      };
    }

    case 'number': {
      inlineLabel();
      const input = document.createElement('input');
      Object.assign(input, { type: 'number', min: def.min, max: def.max, step: def.step ?? 1 });
      input.setAttribute('aria-label', name);
      const read = () => {
        const v = Number(input.value);
        return Number.isFinite(v) && input.value !== '' ? Math.min(def.max, Math.max(def.min, v)) : null;
      };
      input.addEventListener('input', () => {
        const v = read();
        if (v != null) setProp(key, v, { final: false });
      });
      input.addEventListener('change', () => {
        const v = read();
        if (v != null) setProp(key, v);
        else syncPropsBar();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault(); // sinon la touche arrive dans le texte en cours d'écriture
          input.blur();
          refocusText();
        }
      });
      el.append(input);
      return {
        key,
        el,
        sync(v) {
          if (document.activeElement !== input) input.value = v;
        },
      };
    }

    case 'select': {
      head();
      const select = document.createElement('select');
      select.setAttribute('aria-label', name);
      for (const [value, text] of def.options) {
        const option = new Option(text, value);
        if (key === 'fontFamily') option.style.fontFamily = Shapes.fontCss(value);
        select.append(option);
      }
      select.addEventListener('change', () => {
        setProp(key, select.value);
        refocusText();
      });
      el.append(select);
      return {
        key,
        el,
        sync(v) {
          select.value = v;
          if (key === 'fontFamily') select.style.fontFamily = Shapes.fontCss(v);
        },
      };
    }

    case 'segmented': {
      const value = head();
      const group = document.createElement('div');
      group.className = 'seg';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', name);
      for (const [option, icon] of def.options) {
        const text = t(`opt.${option}`);
        const b = document.createElement('button');
        b.dataset.value = option;
        b.title = text;
        b.setAttribute('aria-label', text);
        b.append(iconEl(icon));
        b.addEventListener('click', () => {
          setProp(key, option);
          refocusText();
        });
        group.append(b);
      }
      el.append(group);
      return {
        key,
        el,
        sync(v) {
          for (const b of group.children) b.setAttribute('aria-pressed', String(b.dataset.value === v));
          value.textContent = t(`opt.${v}`);
        },
      };
    }

    case 'toggle': {
      el.classList.add('compact');
      const b = document.createElement('button');
      b.className = def.withText ? 'toggle with-text' : 'toggle';
      b.title = name;
      b.setAttribute('aria-label', name);
      b.append(iconEl(def.icon));
      if (def.withText) b.append(name);
      let current = false;
      b.addEventListener('click', () => {
        setProp(key, !current);
        refocusText();
      });
      el.append(b);
      return {
        key,
        el,
        sync(v) {
          current = Boolean(v);
          b.setAttribute('aria-pressed', String(current));
        },
      };
    }

    case 'color': {
      inlineLabel();
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.setAttribute('aria-haspopup', 'dialog');
      chip.setAttribute('aria-expanded', 'false');
      const dot = document.createElement('span');
      const text = document.createElement('span');
      chip.append(dot, text);
      let current = null;
      chip.addEventListener('click', () => openColorPopover(chip, key, def, current));
      el.append(chip);
      return {
        key,
        el,
        sync(v) {
          current = v;
          dot.className = v ? 'chip-dot' : 'swatch-none';
          dot.style.setProperty('--c', v ?? 'transparent');
          text.textContent = v ? colorName(v) : t('color.none');
          chip.setAttribute('aria-label', `${name} : ${text.textContent}`);
        },
      };
    }
  }
  return { key, el, sync() {} };
}

function setProp(key, value, { final = true } = {}) {
  const c = propsContext();
  if (!c.type) return;

  if (key === 'number') {
    if (!c.shape) {
      state.nextStep = value;
      syncPropsBar(c);
      return;
    }
  } else {
    state.styles[c.type][key] = value;
    saveStyles();
  }

  if (c.shape) {
    pendingEdit ??= { before: snapshot(), prev: JSON.stringify(c.shape) };
    if (key === 'number') c.shape.n = value;
    else c.shape[key] = value;
    if (textEdit) styleTextEditor();
    if (final) {
      // pendant l'écriture, la validation du texte enregistre déjà ce pas d'annulation
      if (!textEdit && JSON.stringify(c.shape) !== pendingEdit.prev) commit(pendingEdit.before);
      pendingEdit = null;
    }
    requestRender();
  }
  syncPropsBar(c);
}

function resetStyle() {
  const c = propsContext();
  if (!c.type) return;
  state.styles[c.type] = structuredClone(Shapes.DEFAULTS[c.type]);
  saveStyles();
  // revenu aux valeurs d'origine : le préréglage choisi n'est plus celui dont on part
  if (state.activePreset?.tool === c.type) state.activePreset = null;
  if (c.shape) {
    const before = snapshot();
    Object.assign(c.shape, structuredClone(Shapes.DEFAULTS[c.type]));
    if (textEdit) styleTextEditor();
    else commit(before);
    requestRender();
  }
  syncPropsBar(c);
  toast(t('toast.reset'));
}

function openColorPopover(anchor, key, def, value) {
  const pop = $('#color-popover');
  if (popover?.anchor === anchor) {
    closeColorPopover();
    return;
  }
  closeColorPopover();
  popover = { anchor, key };
  $('#popover-none').hidden = !def.none;
  for (const b of $('#popover-swatches').children) {
    b.setAttribute('aria-checked', String(Boolean(value) && b.dataset.color.toLowerCase() === value.toLowerCase()));
  }
  $('#popover-custom').value = value ?? '#ffffff';
  anchor.setAttribute('aria-expanded', 'true');
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${r.bottom + 6}px`;
}

function closeColorPopover() {
  if (!popover) return;
  popover.anchor.setAttribute('aria-expanded', 'false');
  popover = null;
  $('#color-popover').hidden = true;
}

function buildColorPopover() {
  const grid = $('#popover-swatches');
  for (const [color, colorKey] of PALETTE) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = color;
    b.dataset.colorKey = colorKey; // libellé traduit par applyLanguage()
    b.style.setProperty('--c', color);
    b.addEventListener('click', () => {
      setProp(popover.key, color);
      closeColorPopover();
      refocusText();
    });
    grid.append(b);
  }
  $('#popover-none').addEventListener('click', () => {
    setProp(popover.key, null);
    closeColorPopover();
    refocusText();
  });
  const custom = $('#popover-custom');
  custom.addEventListener('input', () => popover && setProp(popover.key, custom.value, { final: false }));
  custom.addEventListener('change', () => popover && setProp(popover.key, custom.value));
  document.addEventListener('pointerdown', (e) => {
    if (popover && !e.target.closest('#color-popover') && e.target.closest('.chip') !== popover.anchor) closeColorPopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popover) {
      const anchor = popover.anchor;
      closeColorPopover();
      anchor.focus();
      e.stopImmediatePropagation();
    }
  }, true);
  $('#btn-reset-style').addEventListener('click', () => {
    resetStyle();
    refocusText();
  });
}

function buildToolbar() {
  buildColorPopover();

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
    toast(t('toast.desktopOnly'));
    return;
  }
  if (mode === 'delay') toast(t('toast.delay', { s: appState?.settings.captureDelay ?? 3 }));
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
    toast(t('toast.copied'));
  } catch {
    toast(t('toast.copyFailed'));
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
    toast(t('toast.saved', { path: filePath }));
  } catch {
    toast(t('toast.saveFailed'));
  }
}

async function openImage() {
  if (api) {
    try {
      openPayload(await api.openImage());
    } catch (err) {
      toast(err?.message ?? t('toast.openFailed'));
    }
  } else {
    $('#file-input').click();
  }
}

async function pasteImage() {
  if (api) {
    const payload = await api.readClipboardImage();
    if (payload) openPayload(payload);
    else toast(t('toast.noClipboardImage'));
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
    toast(t('toast.noClipboardImage'));
  } catch {
    toast(t('toast.useCtrlV'));
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

// ------------------------------------------------------ enregistrement automatique
// Une capture de la bibliothèque s'enregistre seule peu après chaque modification : image annotée,
// annotations (modifiables à la réouverture) et miniature de la galerie.

const AUTOSAVE_DELAY = 700;
const THUMB_SIZE = { width: 320, height: 200 }; // comme les miniatures créées à la capture (library.js)

const autosave = {
  timer: 0,
  rev: 0, // numéro de la dernière modification
  queuedRev: 0, // dernière modification confiée à la file d'enregistrement
  savedRev: 0, // dernière modification confirmée sur le disque
  queuedBase: null, // image d'origine confiée à la file (renvoyée seulement quand elle change : rognage)
  savedBase: null, // image d'origine confirmée sur le disque
  queue: Promise.resolve(),
};

function resetAutosave(base) {
  clearTimeout(autosave.timer);
  Object.assign(autosave, { rev: 0, queuedRev: 0, savedRev: 0, queuedBase: base, savedBase: base });
}

function scheduleAutosave() {
  if (!state.libraryId || !api) return;
  autosave.rev++;
  clearTimeout(autosave.timer);
  autosave.timer = setTimeout(autosaveWhenIdle, AUTOSAVE_DELAY);
}

// Attend la fin du geste ou de la saisie en cours avant d'enregistrer.
function autosaveWhenIdle() {
  if (interaction || textEdit) autosave.timer = setTimeout(autosaveWhenIdle, AUTOSAVE_DELAY);
  else flushAutosave();
}

// Enregistre sans attendre les modifications en suspens ; se résout une fois tout écrit.
function flushAutosave() {
  clearTimeout(autosave.timer);
  if (api && state.libraryId && autosave.rev > autosave.queuedRev) {
    const snap = autosaveSnapshot(autosave.queuedBase);
    autosave.queuedRev = snap.rev;
    autosave.queuedBase = state.base;
    autosave.queue = autosave.queue.then(() => writeAutosave(snap));
  }
  return autosave.queue;
}

// État à enregistrer, figé tout de suite (l'encodage des images se fait ensuite).
function autosaveSnapshot(knownBase) {
  const out = exportCanvas();
  return {
    id: state.libraryId,
    rev: autosave.rev,
    shapes: structuredClone(state.shapes),
    unit: state.unit,
    out,
    thumb: thumbnailOf(out),
    base: state.base === knownBase ? null : state.base,
  };
}

const saveFields = (snap) => ({ id: snap.id, rev: snap.rev, shapes: snap.shapes, unit: snap.unit, width: snap.out.width, height: snap.out.height });

async function writeAutosave(snap) {
  const current = () => snap.id === state.libraryId;
  try {
    const [image, thumb, base] = await Promise.all([
      canvasBytes(snap.out, 'image/png'),
      canvasBytes(snap.thumb, 'image/jpeg', 0.85),
      snap.base && canvasBytes(snap.base, 'image/png'),
    ]);
    await api.librarySave({ ...saveFields(snap), image, thumb, base });
    if (current()) {
      autosave.savedRev = Math.max(autosave.savedRev, snap.rev);
      if (snap.base) autosave.savedBase = snap.base;
    }
  } catch {
    if (current()) {
      // nouvel essai à la prochaine modification, ou à la fermeture de la fenêtre
      autosave.queuedRev = autosave.savedRev;
      autosave.queuedBase = autosave.savedBase;
    }
    toast(t('toast.autosaveFailed'));
  }
}

// À la fermeture de la fenêtre : enregistre tout ce qui n'est pas encore confirmé sur le disque, avec un second
// essai si le premier échoue. Renvoie vrai si des modifications restent non enregistrées.
async function saveBeforeClose() {
  commitTextEdit();
  if (!state.libraryId) return state.dirty && Boolean(state.base);
  await flushAutosave();
  if (autosave.savedRev < autosave.rev) await flushAutosave();
  return autosave.savedRev < autosave.rev;
}

function thumbnailOf(source) {
  const ratio = Math.min(1, THUMB_SIZE.width / source.width, THUMB_SIZE.height / source.height);
  const thumb = document.createElement('canvas');
  thumb.width = Math.max(1, Math.round(source.width * ratio));
  thumb.height = Math.max(1, Math.round(source.height * ratio));
  const g = thumb.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, thumb.width, thumb.height);
  return thumb;
}

function canvasBytes(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject) : reject(new Error('encodage impossible'))),
      type,
      quality,
    );
  });
}

// ------------------------------------------------------------------- galerie
// Miniatures des captures de la bibliothèque, de la plus récente à la plus ancienne, en bas de la fenêtre.
// Un clic rouvre la capture avec ses annotations ; sa miniature suit chaque enregistrement.

const gallery = {
  items: [],
  nodes: new Map(), // id -> élément de la liste
  scrolledTo: null, // dernière capture active amenée à l'écran
  demo: null, // aperçu dans un navigateur (?demo) : galerie affichée ou non
};

const galleryShown = () => (api ? Boolean(appState?.settings.showGallery) : gallery.demo === true);

function applyGallery() {
  const shown = galleryShown();
  const changed = $('#gallery').hidden === shown;
  $('#gallery').hidden = !shown;
  document.body.classList.toggle('gallery-on', shown);
  const toggle = $('#btn-gallery');
  toggle.hidden = !api && gallery.demo === null;
  toggle.setAttribute('aria-pressed', String(shown));
  renderGallery();
  if (changed && state.fit) layout(); // la zone de travail a changé de hauteur
}

function toggleGallery() {
  if (api) api.setSettings({ showGallery: !galleryShown() });
  else {
    gallery.demo = !gallery.demo;
    applyGallery();
  }
}

async function loadGallery() {
  try {
    gallery.items = await api.libraryList();
  } catch {
    gallery.items = [];
  }
  renderGallery();
}

function onLibraryChange(event) {
  if (event.type === 'reset') return loadGallery(); // autre dossier de captures
  if (event.type === 'update') {
    // capture réenregistrée : seule sa miniature change
    const index = gallery.items.findIndex((i) => i.id === event.item.id);
    if (index < 0) return;
    gallery.items[index] = event.item;
    updateGalleryNode(gallery.nodes.get(event.item.id), event.item);
    return;
  }
  if (event.type === 'add' && !gallery.items.some((i) => i.id === event.item.id)) {
    gallery.items.push(event.item);
    gallery.items.sort((a, b) => b.created - a.created);
  } else if (event.type === 'remove') {
    gallery.items = gallery.items.filter((i) => i.id !== event.id);
    if (state.libraryId === event.id) unloadImage();
  }
  renderGallery();
}

function renderGallery() {
  const list = $('#gallery-list');
  const ids = new Set(gallery.items.map((i) => i.id));
  for (const [id, node] of gallery.nodes) {
    if (ids.has(id)) continue;
    node.remove();
    gallery.nodes.delete(id);
  }
  gallery.items.forEach((item, index) => {
    let node = gallery.nodes.get(item.id);
    if (!node) {
      node = galleryNode();
      gallery.nodes.set(item.id, node);
    }
    updateGalleryNode(node, item);
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
  });
  $('#gallery-count').textContent = gallery.items.length;
  const empty = $('#gallery-empty');
  empty.hidden = gallery.items.length > 0;
  empty.textContent = t(appState && !appState.settings.autoSave ? 'gallery.emptyOff' : 'gallery.empty');
  syncGalleryActive();
}

function galleryNode() {
  const node = document.createElement('div');
  node.className = 'shot';
  node.setAttribute('role', 'listitem');
  const open = document.createElement('button');
  open.className = 'shot-open';
  const img = document.createElement('img');
  Object.assign(img, { alt: '', loading: 'lazy', decoding: 'async', draggable: false });
  open.append(img);
  const remove = document.createElement('button');
  remove.className = 'shot-delete';
  remove.tabIndex = -1; // au clavier : touche Suppr sur la miniature
  remove.append(iconEl('i-close'));
  node.append(open, remove);
  return node;
}

function updateGalleryNode(node, item) {
  node.dataset.id = item.id;
  const [open, remove] = node.children;
  const img = open.firstChild;
  if (img.getAttribute('src') !== item.thumb) img.src = item.thumb;
  open.title = t('gallery.item', { name: item.name, width: item.width, height: item.height });
  open.setAttribute('aria-label', item.name);
  remove.title = t('gallery.delete');
  remove.setAttribute('aria-label', `${t('gallery.delete')} : ${item.name}`);
}

// Met en évidence la capture affichée et l'amène à l'écran quand elle change.
function syncGalleryActive() {
  for (const [id, node] of gallery.nodes) node.firstChild.setAttribute('aria-current', String(id === state.libraryId));
  const node = gallery.nodes.get(state.libraryId);
  const visible = Boolean(node) && !$('#gallery').hidden;
  if (visible && gallery.scrolledTo !== state.libraryId) {
    const strip = $('#gallery-strip');
    const s = strip.getBoundingClientRect();
    const n = node.getBoundingClientRect();
    const margin = 16;
    if (n.left < s.left + margin) strip.scrollLeft += n.left - s.left - margin;
    else if (n.right > s.right - margin) strip.scrollLeft += n.right - s.right + margin;
  }
  gallery.scrolledTo = visible ? state.libraryId : null;
}

async function openCapture(id, newWindow = false) {
  if (!newWindow && id === state.libraryId) return;
  if (!api) {
    // aperçu dans un navigateur : sélection seulement
    state.libraryId = id;
    syncGalleryActive();
    return;
  }
  try {
    await api.libraryOpen(id, newWindow);
  } catch {
    toast(t('toast.openFailed'));
  }
}

async function deleteCapture(id) {
  const index = gallery.items.findIndex((i) => i.id === id);
  if (index < 0) return;
  // la capture suivante (plus ancienne), sinon la précédente, prend la place de celle qu'on supprime
  const next = id === state.libraryId ? (gallery.items[index + 1] ?? gallery.items[index - 1]) : null;
  const hadFocus = gallery.nodes.get(id)?.contains(document.activeElement);
  try {
    if (api) await api.libraryRemove(id);
    else {
      gallery.items = gallery.items.filter((i) => i.id !== id);
      renderGallery();
    }
  } catch {
    toast(t('toast.deleteFailed'));
    return;
  }
  toast(t('toast.captureDeleted'));
  if (hadFocus) $('#gallery-list').children[Math.min(index, gallery.items.length - 1)]?.firstChild.focus();
  if (next) openCapture(next.id);
}

async function copyCapture(id) {
  if (id === state.libraryId) return copyImage(); // l'image affichée, avec ses dernières modifications
  try {
    await api.libraryCopy(id);
    toast(t('toast.copied'));
  } catch {
    toast(t('toast.copyFailed'));
  }
}

// Action choisie dans le menu contextuel d'une miniature.
function runGalleryAction(action, id) {
  switch (action) {
    case 'open': return openCapture(id);
    case 'openNew': return openCapture(id, true);
    case 'copy': return copyCapture(id);
    case 'reveal': return api.libraryReveal(id);
    case 'delete': return deleteCapture(id);
  }
}

function buildGallery() {
  const list = $('#gallery-list');
  list.addEventListener('click', (e) => {
    const node = e.target.closest('.shot');
    if (!node) return;
    if (e.target.closest('.shot-delete')) deleteCapture(node.dataset.id);
    else openCapture(node.dataset.id);
  });
  list.addEventListener('contextmenu', (e) => {
    const node = e.target.closest('.shot');
    if (!node || !api) return;
    e.preventDefault();
    api.libraryMenu(node.dataset.id);
  });
  list.addEventListener('keydown', (e) => {
    const node = e.target.closest('.shot');
    if (!node) return;
    const nodes = [...list.children];
    const i = nodes.indexOf(node);
    const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: nodes.length - 1 }[e.key];
    if (to !== undefined) nodes[Math.max(0, Math.min(nodes.length - 1, to))].firstChild.focus();
    else if (e.key === 'Delete') deleteCapture(node.dataset.id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  // molette : défilement horizontal
  const strip = $('#gallery-strip');
  strip.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  $('#btn-gallery').addEventListener('click', toggleGallery);
  $('#btn-gallery-folder').addEventListener('click', () => {
    if (api) api.openLibraryFolder();
    else toast(t('toast.desktopOnly'));
  });
}

// ------------------------------------------------------------------ clavier

document.addEventListener('keydown', (e) => {
  // les curseurs de la barre de propriétés laissent passer les raccourcis, sauf les flèches
  if (e.target.closest('textarea, select, input:not([type="range"])')) return;
  if (e.target.matches('input[type="range"]') && e.key.startsWith('Arrow')) return;
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
  else if (e.dataTransfer?.files?.length) toast(t('toast.imagesOnly'));
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
if (api) {
  // Fermeture de la fenêtre : l'application attend la réponse pour fermer, ou demander confirmation
  // (une capture de la bibliothèque est enregistrée, rien à demander).
  api.onCloseRequest(async () => {
    let unsaved = true;
    try {
      unsaved = await saveBeforeClose();
    } finally {
      api.closeReady({ unsaved });
    }
  });
} else {
  // dans un navigateur (mode démo) : avertissement classique avant de quitter la page
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty && state.base) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// ------------------------------------------------------------- langue, état

let appState = null;

// Traduit les textes statiques de la page puis reconstruit les éléments générés.
function applyLanguage() {
  document.documentElement.lang = lang;
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-tip]')) el.dataset.tip = t(el.dataset.i18nTip);
  for (const el of $$('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  for (const el of $$('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const b of $$('.tool')) {
    const label = t(`tool.${b.dataset.tool}`);
    b.dataset.tip = `${label} (${TOOLS[b.dataset.tool].key.toUpperCase()})`;
    b.setAttribute('aria-label', label);
  }
  for (const b of $$('#popover-swatches .swatch')) {
    b.setAttribute('aria-label', t(`color.${b.dataset.colorKey}`));
    b.title = b.getAttribute('aria-label');
  }
  for (const h of $$('.crop-handle')) h.title = t('crop.handle');
  $('#status-hint').textContent = t(`hint.${state.tool}`);
  applyShortcutLabels();
  propsKey = null;
  renderPropsBar();
  renderGallery();
}

function applyShortcutLabels() {
  const shortcuts = appState?.settings.shortcuts ?? {};
  for (const kbd of $$('kbd[data-shortcut]')) kbd.textContent = I18N.formatAccelerator(lang, shortcuts[kbd.dataset.shortcut]);
  $('#menu-delay').textContent = t('menu.delay', { s: appState?.settings.captureDelay ?? 3 });

  const hint = $('#empty-hint');
  hint.replaceChildren();
  if (shortcuts.region) {
    const [before, after] = t('empty.hintKey').split('{key}');
    hint.append(before, Object.assign(document.createElement('kbd'), { textContent: I18N.formatAccelerator(lang, shortcuts.region) }), after);
  } else {
    hint.textContent = t('empty.hint');
  }
}

function applyAppState(next) {
  appState = next;
  lang = next.lang;
  applyLanguage();
  applyGallery();
}

$('#btn-settings').addEventListener('click', () => {
  if (api) api.openSettings();
  else toast(t('toast.desktopOnly'));
});

buildToolbar();
buildGallery();
setTool('arrow');
updateButtons();
applyLanguage();

(async () => {
  if (api) {
    api.onLoadImage(replaceDocument);
    api.onState(applyAppState);
    api.onLibraryChange(onLibraryChange);
    api.onLibraryMenu(runGalleryAction);
    applyAppState(await api.getState());
    const initial = await api.getInitialImage();
    if (initial) await loadImage(initial);
    await loadGallery();
  } else {
    const params = new URLSearchParams(location.search);
    if (params.has('lang')) {
      lang = I18N.resolve(params.get('lang'), navigator.language);
      applyLanguage();
    }
    if (params.has('demo')) {
      await loadImage({ dataUrl: demoImage(), name: 'Démo', libraryId: 'demo-0' });
      showDemoGallery();
    }
  }
})();

// Galerie de démonstration (?demo) : quelques miniatures de l'image de démonstration.
function showDemoGallery() {
  const thumb = thumbnailOf(state.base).toDataURL('image/jpeg', 0.85);
  const now = Date.now();
  gallery.items = Array.from({ length: 8 }, (_, i) => ({
    id: `demo-${i}`,
    name: `Capture démo ${8 - i}`,
    created: now - i * 60000,
    width: state.base.width,
    height: state.base.height,
    thumb,
  }));
  gallery.demo = true;
  applyGallery();
}

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
