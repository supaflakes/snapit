'use strict';

// Bibliothèque des captures, comme dans Snagit : chaque capture est enregistrée automatiquement
// avec ses annotations, puis mise à jour à chaque modification. La galerie de l'éditeur la présente.
//
//   <dossier>\Capture 2026-09-29 à 14.03.22.png   image annotée, telle qu'exportée
//   <dossier>\.snapit\<id>.json                   nom, dates et annotations (modifiables à la réouverture)
//   <dossier>\.snapit\<id>.png                    image d'origine, sans annotations
//   <dossier>\.snapit\<id>.jpg                    miniature de la galerie
//
// Les écritures sont synchrones : les enregistrements d'une capture s'appliquent dans l'ordre
// d'arrivée, y compris le dernier, envoyé de façon synchrone à la fermeture de la fenêtre.
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const DATA_DIR = '.snapit';
const ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
// Taille maximale des miniatures ; l'éditeur utilise la même quand il les régénère.
const THUMB_SIZE = { width: 320, height: 200 };

const pad = (n) => String(n).padStart(2, '0');

// Identifiant triable : date, heure et suffixe aléatoire (20260929-140322-a1b2c3).
function newId(d = new Date()) {
  const day = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${day}-${time}-${crypto.randomBytes(3).toString('hex')}`;
}

// Entrée décrite par un fichier .json de la bibliothèque, ou null s'il n'est pas valable.
function parseEntry(data, fileName, folder) {
  if (!data || typeof data !== 'object' || !ID_PATTERN.test(data.id) || fileName !== `${data.id}.json`) return null;
  const file = data.file;
  if (typeof file !== 'string' || path.basename(file) !== file || !/\.png$/i.test(file)) return null;
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  const created = num(data.created, 0);
  return {
    id: data.id,
    folder,
    file,
    name: typeof data.name === 'string' ? data.name : path.basename(file, path.extname(file)),
    created,
    modified: num(data.modified, created),
    width: num(data.width, 0),
    height: num(data.height, 0),
    unit: num(data.unit, 1),
    rev: 0, // dernière modification enregistrée pendant la session d'édition en cours
  };
}

async function readEntries(folder) {
  const dir = path.join(folder, DATA_DIR);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return []; // pas encore de bibliothèque dans ce dossier
  }
  const entries = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          return parseEntry(JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')), name, folder);
        } catch {
          return null; // fichier illisible : ignoré
        }
      }),
  );
  return entries.filter(Boolean);
}

// Données d'image reçues de l'éditeur : octets, ou URL data: (envoi synchrone à la fermeture).
const toData = (value) => (typeof value === 'string' ? Buffer.from(value.slice(value.indexOf(',') + 1), 'base64') : value);

// Écrit via un fichier temporaire pour ne jamais laisser de fichier à moitié écrit.
function writeFileAtomic(file, data, tmpDir) {
  const tmp = path.join(tmpDir, `~${path.basename(file)}.tmp`);
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // fichier ouvert dans une autre application (visionneuse…) : on le réécrit directement
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, data);
  }
}

// Masque le dossier des données d'édition dans l'Explorateur.
function hide(dir) {
  if (process.platform === 'win32') execFile('attrib', ['+h', dir], { windowsHide: true }, () => {});
}

class Library extends EventEmitter {
  // folder : () => dossier courant (paramètres) ; trash : (fichier) => Promise, envoi à la corbeille
  constructor({ folder, trash }) {
    super();
    this.folder = folder;
    this.trash = trash;
    this.entries = new Map(); // id -> entrée, pour tous les dossiers lus (une capture ouverte reste
    // enregistrable même si l'on change de dossier entre-temps)
    this.scans = new Map(); // dossier -> lecture (une seule fois par dossier)
  }

  scan(folder) {
    if (!this.scans.has(folder)) {
      this.scans.set(
        folder,
        readEntries(folder).then((list) => {
          for (const entry of list) if (!this.entries.has(entry.id)) this.entries.set(entry.id, entry);
        }),
      );
    }
    return this.scans.get(folder);
  }

  // Captures du dossier courant, de la plus récente à la plus ancienne.
  async list() {
    const folder = this.folder();
    await this.scan(folder);
    return [...this.entries.values()]
      .filter((e) => e.folder === folder)
      .sort((a, b) => b.created - a.created)
      .map((e) => this.item(e));
  }

  // Description transmise à la galerie.
  item(entry) {
    const thumb = pathToFileURL(this.dataPath(entry, '.jpg')).href;
    const { id, name, created, modified, width, height } = entry;
    return { id, name, created, modified, width, height, thumb: `${thumb}?v=${modified}` };
  }

  dataPath(entry, ext) {
    return path.join(entry.folder, DATA_DIR, `${entry.id}${ext}`);
  }

  // Image annotée d'une capture (celle que l'on voit dans le dossier).
  imagePath(id) {
    const entry = this.entries.get(id);
    return entry ? path.join(entry.folder, entry.file) : null;
  }

  // Nom de fichier libre : « Capture ….png », sinon « Capture … (2).png »…
  uniqueFile(folder, name) {
    const base = String(name || 'Capture').replace(/[\\/:*?"<>|]/g, '-').trim() || 'Capture';
    const taken = new Set([...this.entries.values()].filter((e) => e.folder === folder).map((e) => e.file.toLowerCase()));
    for (let i = 1; ; i++) {
      const file = i === 1 ? `${base}.png` : `${base} (${i}).png`;
      if (!taken.has(file.toLowerCase()) && !fs.existsSync(path.join(folder, file))) return file;
    }
  }

  // Ajoute une nouvelle capture (PNG et miniature JPEG déjà encodés).
  async create({ png, thumb, name, unit, width, height }) {
    const folder = this.folder();
    await this.scan(folder);
    const dir = path.join(folder, DATA_DIR);
    if (fs.mkdirSync(dir, { recursive: true })) hide(dir);
    const now = Date.now();
    const entry = { id: newId(), folder, file: this.uniqueFile(folder, name), name, created: now, modified: now, width, height, unit, rev: 0 };
    writeFileAtomic(this.dataPath(entry, '.png'), png, dir);
    writeFileAtomic(path.join(folder, entry.file), png, dir);
    writeFileAtomic(this.dataPath(entry, '.jpg'), thumb, dir);
    this.writeData(entry, []);
    this.entries.set(entry.id, entry);
    this.emit('change', { type: 'add', item: this.item(entry) });
    return this.item(entry);
  }

  writeData(entry, shapes) {
    const { id, name, file, created, modified, width, height, unit } = entry;
    const data = { version: 1, id, name, file, created, modified, width, height, unit, shapes };
    writeFileAtomic(this.dataPath(entry, '.json'), JSON.stringify(data), path.join(entry.folder, DATA_DIR));
  }

  // Enregistre les modifications faites dans l'éditeur. `rev` augmente à chaque modification :
  // un envoi plus ancien que le dernier enregistré (arrivé en retard) est ignoré.
  // `base` (image d'origine) n'est envoyée qu'après un rognage.
  save({ id, rev, shapes, unit, width, height, image, thumb, base }) {
    const entry = this.entries.get(id);
    if (!entry || !(rev > entry.rev)) return false;
    const dir = path.join(entry.folder, DATA_DIR);
    if (fs.mkdirSync(dir, { recursive: true })) hide(dir);
    if (base) writeFileAtomic(this.dataPath(entry, '.png'), toData(base), dir);
    writeFileAtomic(path.join(entry.folder, entry.file), toData(image), dir);
    writeFileAtomic(this.dataPath(entry, '.jpg'), toData(thumb), dir);
    Object.assign(entry, { rev, unit, width, height, modified: Date.now() });
    this.writeData(entry, Array.isArray(shapes) ? shapes : []);
    this.emit('change', { type: 'update', item: this.item(entry) });
    return true;
  }

  // Données pour rouvrir une capture dans l'éditeur, annotations comprises.
  async load(id) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('Capture introuvable');
    let shapes = [];
    try {
      const data = JSON.parse(await fsp.readFile(this.dataPath(entry, '.json'), 'utf8'));
      if (Array.isArray(data.shapes)) shapes = data.shapes;
    } catch {
      // annotations illisibles : l'image s'ouvre sans elles
    }
    let png;
    try {
      png = await fsp.readFile(this.dataPath(entry, '.png'));
    } catch {
      // image d'origine absente : l'image annotée devient la nouvelle image d'origine
      png = await fsp.readFile(path.join(entry.folder, entry.file));
      shapes = [];
      try {
        const dir = path.join(entry.folder, DATA_DIR);
        fs.mkdirSync(dir, { recursive: true });
        writeFileAtomic(this.dataPath(entry, '.png'), png, dir);
      } catch {
        // dossier en lecture seule : la capture s'ouvre quand même
      }
    }
    entry.rev = 0; // nouvelle session d'édition : l'éditeur recompte ses modifications
    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      name: entry.name,
      scaleFactor: entry.unit,
      libraryId: id,
      shapes,
    };
  }

  // L'image annotée part dans la corbeille ; les données d'édition sont effacées.
  async remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id); // un enregistrement arrivé entre-temps ne recrée plus rien
    const image = path.join(entry.folder, entry.file);
    try {
      if (fs.existsSync(image)) await this.trash(image);
    } catch (err) {
      this.entries.set(id, entry);
      throw err;
    }
    for (const ext of ['.json', '.png', '.jpg']) fs.rmSync(this.dataPath(entry, ext), { force: true });
    this.emit('change', { type: 'remove', id });
    return true;
  }
}

module.exports = { Library, THUMB_SIZE };
