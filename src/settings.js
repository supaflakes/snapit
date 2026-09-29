'use strict';

// Paramètres de l'application, enregistrés en JSON dans le dossier de données de l'utilisateur.
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const DEFAULT_SHORTCUTS = {
  region: 'PrintScreen',
  fullscreen: 'Shift+PrintScreen',
  delay: 'Ctrl+PrintScreen',
};

const DEFAULTS = {
  version: 2, // format du fichier (voir sanitize)
  language: 'auto', // 'auto' | 'fr' | 'en'
  theme: 'dark', // 'system' | 'dark' | 'light'
  shortcuts: { ...DEFAULT_SHORTCUTS },
  overrideSnippingTool: true,
  captureDelay: 3,
  copyAfterCapture: true,
  autoSave: true, // enregistre chaque capture, annotations comprises, dans la bibliothèque
  libraryFolder: '', // vide : Images\Snapit
  showGallery: true, // galerie des captures en bas de l'éditeur
  saveFolder: '', // vide : dossier Images
  saveFormat: 'png', // 'png' | 'jpeg'
};

const clone = (v) => JSON.parse(JSON.stringify(v));

function sanitize(input) {
  const s = clone(DEFAULTS);
  if (!input || typeof input !== 'object') return s;
  if (['auto', 'fr', 'en'].includes(input.language)) s.language = input.language;
  if (['system', 'dark', 'light'].includes(input.theme)) s.theme = input.theme;
  if (input.shortcuts && typeof input.shortcuts === 'object') {
    for (const key of Object.keys(DEFAULT_SHORTCUTS)) {
      if (typeof input.shortcuts[key] === 'string') s.shortcuts[key] = input.shortcuts[key];
    }
  }
  if (typeof input.overrideSnippingTool === 'boolean') s.overrideSnippingTool = input.overrideSnippingTool;
  if (Number.isFinite(input.captureDelay)) s.captureDelay = Math.min(60, Math.max(1, Math.round(input.captureDelay)));
  // Avant la version 2, la copie automatique était désactivée par défaut : la valeur enregistrée
  // n'était souvent que ce défaut. Le nouveau réglage par défaut s'applique donc une fois.
  if (typeof input.copyAfterCapture === 'boolean' && input.version >= 2) s.copyAfterCapture = input.copyAfterCapture;
  if (typeof input.autoSave === 'boolean') s.autoSave = input.autoSave;
  if (typeof input.libraryFolder === 'string') s.libraryFolder = input.libraryFolder;
  if (typeof input.showGallery === 'boolean') s.showGallery = input.showGallery;
  if (typeof input.saveFolder === 'string') s.saveFolder = input.saveFolder;
  if (['png', 'jpeg'].includes(input.saveFormat)) s.saveFormat = input.saveFormat;
  return s;
}

class SettingsStore extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.values = clone(DEFAULTS);
    try {
      this.values = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // premier lancement ou fichier illisible : valeurs par défaut
    }
  }

  get() {
    return clone(this.values);
  }

  set(patch) {
    const next = sanitize({
      ...this.values,
      ...patch,
      shortcuts: { ...this.values.shortcuts, ...(patch.shortcuts ?? {}) },
    });
    const previous = this.values;
    this.values = next;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(next, null, 2));
    } catch {
      // l'enregistrement a échoué : les réglages restent valables pour la session
    }
    this.emit('change', this.get(), previous);
    return this.get();
  }
}

module.exports = { SettingsStore, DEFAULTS, DEFAULT_SHORTCUTS };
