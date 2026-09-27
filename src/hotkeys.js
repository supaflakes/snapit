'use strict';

// Raccourcis globaux de capture.
// Les combinaisons avec Impr. écran passent par un petit assistant (hook clavier bas niveau)
// pour garder la priorité sur l'Outil Capture de Windows ; les autres utilisent globalShortcut.
const { globalShortcut } = require('electron');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MODIFIERS = { Ctrl: 1, Control: 1, CommandOrControl: 1, CmdOrCtrl: 1, Alt: 2, Shift: 4, Super: 8, Meta: 8 };
const MODIFIER_NAMES = [[1, 'Ctrl'], [2, 'Alt'], [4, 'Shift'], [8, 'Super']];
const WIN = 8;
const VK_SNAPSHOT = 0x2c;
const RECORD_PREFIX = 'rec';

// Win+Maj+S : raccourci de l'Outil Capture. Beaucoup de claviers l'envoient quand on appuie sur Impr. écran,
// il est donc redirigé vers la capture de zone quand Snapit remplace l'Outil Capture.
const SNIPPING_SHORTCUT = { mods: 4 | WIN, vk: 0x53 };

const NAMED_KEYS = {
  PrintScreen: VK_SNAPSHOT,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  Left: 0x25,
  Up: 0x26,
  Right: 0x27,
  Down: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
  Pause: 0x13,
  Scrolllock: 0x91,
};

// Code de touche virtuelle Windows d'une touche d'accélérateur Electron.
function virtualKey(key) {
  if (/^[A-Z0-9]$/.test(key)) return key.charCodeAt(0);
  const f = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (f) return 0x6f + Number(f[1]);
  return NAMED_KEYS[key] ?? null;
}

function parseAccelerator(accelerator) {
  const parts = accelerator.split('+');
  const key = parts.pop();
  let mods = 0;
  for (const part of parts) {
    if (!MODIFIERS[part]) return null;
    mods |= MODIFIERS[part];
  }
  return key ? { mods, key } : null;
}

function acceleratorFrom(mods, key) {
  return [...MODIFIER_NAMES.filter(([bit]) => mods & bit).map(([, name]) => name), key].join('+');
}

// Compile l'assistant avec le compilateur C# fourni avec Windows (.NET Framework), une seule fois par version.
async function buildHelper(dir) {
  const source = fs.readFileSync(path.join(__dirname, 'native', 'keyhook.cs'), 'utf8');
  const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 10);
  const exe = path.join(dir, `keyhook-${hash}.exe`);
  if (fs.existsSync(exe)) return exe;

  const windir = process.env.WINDIR || 'C:\\Windows';
  const csc = ['Framework64', 'Framework']
    .map((f) => path.join(windir, 'Microsoft.NET', f, 'v4.0.30319', 'csc.exe'))
    .find((p) => fs.existsSync(p));
  if (!csc) throw new Error('csc.exe introuvable');

  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'keyhook.cs');
  fs.writeFileSync(src, source);
  await new Promise((resolve, reject) => {
    execFile(csc, ['/nologo', '/optimize', '/target:exe', `/out:${exe}`, src], { windowsHide: true }, (err, stdout) =>
      err ? reject(new Error(String(stdout || err.message))) : resolve(),
    );
  });
  // supprime les versions précédentes de l'assistant
  for (const name of fs.readdirSync(dir)) {
    if (/^keyhook-.*\.exe$/.test(name) && path.join(dir, name) !== exe) fs.rmSync(path.join(dir, name), { force: true });
  }
  return exe;
}

class HelperProcess {
  constructor(exe, { onLine, onExit }) {
    this.exe = exe;
    this.onLine = onLine;
    this.onExit = onExit;
    this.child = null;
    this.command = 'set\n';
  }

  start() {
    return new Promise((resolve) => {
      let ready = false;
      let buffer = '';
      const child = spawn(this.exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      this.child = child;
      const timer = setTimeout(() => finish(false), 5000);
      const finish = (ok) => {
        clearTimeout(timer);
        if (!ok && this.child === child) this.stop();
        resolve(ok);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (line === 'ready') {
            ready = true;
            child.stdin.write(this.command);
            finish(true);
          } else if (line === 'error') {
            finish(false);
          } else if (line) {
            this.onLine(line);
          }
        }
      });
      child.stdin.on('error', () => {});
      child.on('error', () => finish(false));
      child.on('exit', () => {
        if (this.child === child) this.child = null;
        if (ready) this.onExit();
        else finish(false);
      });
    });
  }

  set(combos) {
    this.command = `set ${combos.join(' ')}\n`;
    if (this.child?.stdin.writable) this.child.stdin.write(this.command);
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end();
    setTimeout(() => child.exitCode === null && child.kill(), 500);
  }
}

class Hotkeys {
  constructor({ helperDir, onTrigger, onRecord, onStatus }) {
    this.helperDir = helperDir;
    this.onTrigger = onTrigger;
    this.onRecord = onRecord;
    this.onStatus = onStatus;
    this.helper = null;
    this.hookReady = false;
    this.hookFailed = false;
    this.recording = false;
    this.config = { shortcuts: {}, override: false };
    this.status = {};
  }

  // Démarre l'assistant clavier (Windows uniquement). Sans lui, tout passe par globalShortcut.
  async init() {
    if (process.platform !== 'win32') return;
    try {
      const exe = await buildHelper(this.helperDir);
      this.helper = new HelperProcess(exe, {
        onLine: (id) => this.handle(id),
        onExit: () => {
          // l'assistant s'est arrêté (antivirus, fin de session…) : repli sur globalShortcut
          this.hookReady = false;
          this.hookFailed = true;
          this.apply(this.config.shortcuts, this.config.override);
        },
      });
      this.hookReady = await this.helper.start();
    } catch {
      this.hookReady = false;
    }
    this.hookFailed = !this.hookReady;
    this.apply(this.config.shortcuts, this.config.override);
  }

  apply(shortcuts, override) {
    this.config = { shortcuts: { ...shortcuts }, override };
    if (this.recording) return this.status;
    globalShortcut.unregisterAll();
    const combos = [];
    const status = {};
    for (const [action, accelerator] of Object.entries(shortcuts)) {
      if (!accelerator) {
        status[action] = 'none';
        continue;
      }
      const parsed = parseAccelerator(accelerator);
      if (!parsed) {
        status[action] = 'conflict';
        continue;
      }
      // Impr. écran et les combinaisons avec Win (réservées par Windows) passent par l'assistant
      const vk = virtualKey(parsed.key);
      const viaHook = parsed.key === 'PrintScreen' || parsed.mods & WIN;
      if (viaHook && vk && override && this.hookReady) {
        combos.push(`${action}:${parsed.mods}:${vk}`);
        status[action] = 'hook';
        continue;
      }
      let ok = false;
      try {
        ok = globalShortcut.register(accelerator, () => this.onTrigger(action));
      } catch {
        ok = false;
      }
      status[action] = ok ? 'ok' : 'conflict';
    }
    const snipping = `:${SNIPPING_SHORTCUT.mods}:${SNIPPING_SHORTCUT.vk}`;
    if (override && this.hookReady && !combos.some((c) => c.endsWith(snipping))) combos.push(`region${snipping}`);
    this.helper?.set(combos);
    this.status = status;
    this.onStatus?.(this.getStatus());
    return status;
  }

  // Pendant l'enregistrement d'un raccourci, les raccourcis sont suspendus pour que la fenêtre
  // des paramètres reçoive les touches ; Impr. écran est remonté par l'assistant.
  startRecording() {
    this.recording = true;
    globalShortcut.unregisterAll();
    const combos = [];
    for (let mods = 0; mods < 16; mods++) combos.push(`${RECORD_PREFIX}${mods}-${VK_SNAPSHOT}:${mods}:${VK_SNAPSHOT}`);
    const { mods, vk } = SNIPPING_SHORTCUT;
    combos.push(`${RECORD_PREFIX}${mods}-${vk}:${mods}:${vk}`);
    this.helper?.set(this.hookReady ? combos : []);
  }

  stopRecording() {
    if (!this.recording) return;
    this.recording = false;
    this.apply(this.config.shortcuts, this.config.override);
  }

  handle(id) {
    if (id.startsWith(RECORD_PREFIX)) {
      const [mods, vk] = id.slice(RECORD_PREFIX.length).split('-').map(Number);
      const key = vk === VK_SNAPSHOT ? 'PrintScreen' : String.fromCharCode(vk);
      if (this.recording) this.onRecord(acceleratorFrom(mods, key));
      return;
    }
    this.onTrigger(id);
  }

  getStatus() {
    return { shortcuts: { ...this.status }, hookAvailable: this.hookReady, hookFailed: this.hookFailed };
  }

  dispose() {
    globalShortcut.unregisterAll();
    this.helper?.stop();
  }
}

module.exports = { Hotkeys, parseAccelerator };
