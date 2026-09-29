'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// Hors de l'application (aperçu dans un navigateur), un faux pont garde les réglages en mémoire.
const api = window.snapit ?? createPreviewApi();

let state = null;
let lang = 'fr';
let recording = null; // action dont on enregistre le raccourci
const t = (key, params) => I18N.t(lang, key, params);

const NEEDS_NO_MODIFIER = /^(PrintScreen|F([1-9]|1[0-9]|2[0-4])|Pause|Scrolllock)$/;
const CODE_KEYS = {
  PrintScreen: 'PrintScreen',
  Space: 'Space',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Pause: 'Pause',
  ScrollLock: 'Scrolllock',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

// Nom de touche au format des accélérateurs Electron, d'après sa position physique (e.code).
function keyName(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code] ?? null;
}

function acceleratorFromEvent(e) {
  const key = keyName(e.code);
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return { accelerator: [...mods, key].join('+'), hasModifier: mods.length > 0, key };
}

// ------------------------------------------------------------------- rendu

function applyLanguage() {
  document.documentElement.lang = lang;
  document.title = `${t('settings.title')} — Snapit`;
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of $$('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of $$('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel));

  const select = $('#language');
  select.replaceChildren(
    new Option(t('settings.languageAuto'), 'auto'),
    ...I18N.LANGUAGES.map(([code, name]) => new Option(name, code)),
  );
}

function render(next) {
  const languageChanged = next.lang !== lang || !state;
  state = next;
  lang = next.lang;
  if (languageChanged) applyLanguage();
  const s = state.settings;

  $('#language').value = s.language;
  setSeg('#theme', s.theme);
  setSeg('#format', s.saveFormat);
  setSwitch('#startup', state.openAtLogin);
  $('#startup').disabled = !state.isPackaged;
  $('#startup-note').hidden = state.isPackaged;
  setSwitch('#override', s.overrideSnippingTool);
  setSwitch('#detect-regions', s.detectRegions);
  setSwitch('#copy-after', s.copyAfterCapture);
  if (document.activeElement !== $('#delay')) $('#delay').value = s.captureDelay;
  setSwitch('#auto-save', s.autoSave);
  setSwitch('#show-gallery', s.showGallery);
  $('#library-path').textContent = state.libraryFolder;
  $('#library-path').title = state.libraryFolder;
  $('#folder-path').textContent = s.saveFolder || t('settings.folderDefault');
  $('#folder-path').title = s.saveFolder;
  $('#override-unavailable').hidden = !(s.overrideSnippingTool && state.status.hookFailed);
  $('#about').textContent = t('settings.about', { version: state.version });

  for (const row of $$('.shortcut-row')) {
    const action = row.dataset.action;
    const accelerator = s.shortcuts[action];
    const button = row.querySelector('.shortcut');
    const isRecording = recording === action;
    button.classList.toggle('recording', isRecording);
    button.classList.toggle('empty', !accelerator && !isRecording);
    button.textContent = isRecording ? t('settings.shortcutRecord') : accelerator ? I18N.formatAccelerator(lang, accelerator) : t('settings.shortcutNone');
    button.title = t('settings.shortcutChange');
    row.querySelector('.clear').disabled = !accelerator;
    const status = row.querySelector('.status');
    const code = accelerator ? state.status.shortcuts[action] : 'none';
    status.dataset.state = code ?? '';
    status.textContent = code ? t(`settings.status.${code}`) : '';
  }
}

function setSeg(selector, value) {
  for (const b of $(selector).children) b.setAttribute('aria-checked', String(b.dataset.value === value));
}

function setSwitch(selector, on) {
  $(selector).setAttribute('aria-checked', String(Boolean(on)));
}

function showError(message) {
  const el = $('#shortcut-error');
  el.textContent = message ?? '';
  el.hidden = !message;
}

async function update(patch) {
  render(await api.setSettings(patch));
}

// --------------------------------------------------- enregistrement de raccourci

function startRecording(action) {
  showError(null);
  recording = action;
  api.startRecording();
  render(state);
}

function stopRecording() {
  if (!recording) return;
  recording = null;
  api.stopRecording();
  render(state);
}

async function finishRecording(accelerator) {
  const action = recording;
  if (!action) return;
  const duplicate = Object.entries(state.settings.shortcuts).find(([other, value]) => other !== action && value === accelerator);
  if (duplicate) {
    showError(t('settings.shortcutDuplicate'));
    stopRecording();
    return;
  }
  recording = null;
  api.stopRecording();
  await update({ shortcuts: { [action]: accelerator } });
}

function onRecordKey(e) {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.type === 'keydown' && e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
    stopRecording();
    return;
  }
  const combo = acceleratorFromEvent(e);
  if (!combo) return; // touche de modification seule : on attend la suite
  // Impr. écran n'arrive souvent qu'au relâchement ; les autres touches à l'appui.
  if (e.type === 'keyup' && combo.key !== 'PrintScreen') return;
  if (!combo.hasModifier && !NEEDS_NO_MODIFIER.test(combo.key)) {
    showError(t('settings.shortcutNeedsModifier'));
    return;
  }
  showError(null);
  finishRecording(combo.accelerator);
}

// ------------------------------------------------------------------ actions

$('#language').addEventListener('change', (e) => update({ language: e.target.value }));
$('#theme').addEventListener('click', (e) => {
  const value = e.target.closest('button')?.dataset.value;
  if (value) update({ theme: value });
});
$('#format').addEventListener('click', (e) => {
  const value = e.target.closest('button')?.dataset.value;
  if (value) update({ saveFormat: value });
});
$('#startup').addEventListener('click', async () => render(await api.setOpenAtLogin(!state.openAtLogin)));
$('#override').addEventListener('click', () => update({ overrideSnippingTool: !state.settings.overrideSnippingTool }));
$('#detect-regions').addEventListener('click', () => update({ detectRegions: !state.settings.detectRegions }));
$('#copy-after').addEventListener('click', () => update({ copyAfterCapture: !state.settings.copyAfterCapture }));
$('#auto-save').addEventListener('click', () => update({ autoSave: !state.settings.autoSave }));
$('#show-gallery').addEventListener('click', () => update({ showGallery: !state.settings.showGallery }));
$('#open-library').addEventListener('click', () => api.openLibraryFolder());
$('#choose-library').addEventListener('click', async () => render(await api.chooseLibraryFolder()));
$('#delay').addEventListener('change', (e) => {
  const value = Number(e.target.value);
  if (Number.isFinite(value)) update({ captureDelay: value });
});
$('#choose-folder').addEventListener('click', async () => render(await api.chooseFolder()));
$('#reset-shortcuts').addEventListener('click', async () => {
  stopRecording();
  showError(null);
  render(await api.resetShortcuts());
});
$('#open-windows-settings').addEventListener('click', () => api.openWindowsKeyboardSettings());

for (const row of $$('.shortcut-row')) {
  const action = row.dataset.action;
  row.querySelector('.shortcut').addEventListener('click', () => (recording === action ? stopRecording() : startRecording(action)));
  row.querySelector('.clear').addEventListener('click', () => {
    stopRecording();
    showError(null);
    update({ shortcuts: { [action]: '' } });
  });
}

window.addEventListener('keydown', onRecordKey, true);
window.addEventListener('keyup', onRecordKey, true);
window.addEventListener('blur', stopRecording);
api.onRecorded((accelerator) => finishRecording(accelerator));
api.onState((next) => render(next));
api.getState().then(render);

// Faux pont pour afficher la page hors de l'application.
function createPreviewApi() {
  const s = {
    settings: {
      language: 'auto',
      theme: 'dark',
      shortcuts: { region: 'PrintScreen', fullscreen: 'Shift+PrintScreen', delay: 'Ctrl+PrintScreen' },
      overrideSnippingTool: true,
      captureDelay: 3,
      detectRegions: true,
      copyAfterCapture: true,
      autoSave: true,
      libraryFolder: '',
      showGallery: true,
      saveFolder: '',
      saveFormat: 'png',
    },
    lang: I18N.resolve('auto', navigator.language),
    status: { shortcuts: { region: 'hook', fullscreen: 'hook', delay: 'hook' }, hookAvailable: true, hookFailed: false },
    version: 'aperçu',
    isPackaged: false,
    openAtLogin: false,
    libraryFolder: 'C:\\Users\\Vous\\Pictures\\Snapit',
  };
  const snapshot = () => JSON.parse(JSON.stringify(s));
  return {
    getState: async () => snapshot(),
    onState: () => {},
    onRecorded: () => {},
    setSettings: async (patch) => {
      Object.assign(s.settings, { ...patch, shortcuts: { ...s.settings.shortcuts, ...(patch.shortcuts ?? {}) } });
      s.lang = I18N.resolve(s.settings.language, navigator.language);
      for (const [k, v] of Object.entries(s.settings.shortcuts)) s.status.shortcuts[k] = !v ? 'none' : v.endsWith('PrintScreen') ? 'hook' : 'ok';
      return snapshot();
    },
    setOpenAtLogin: async () => snapshot(),
    chooseFolder: async () => snapshot(),
    chooseLibraryFolder: async () => snapshot(),
    openLibraryFolder: () => {},
    resetShortcuts: async () => {
      s.settings.shortcuts = { region: 'PrintScreen', fullscreen: 'Shift+PrintScreen', delay: 'Ctrl+PrintScreen' };
      return snapshot();
    },
    openWindowsKeyboardSettings: () => {},
    startRecording: () => {},
    stopRecording: () => {},
  };
}
