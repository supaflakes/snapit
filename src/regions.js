'use strict';

// Détection des fenêtres et des éléments d'interface pour la sélection de zone, comme dans Snagit.
// Un assistant natif (src/native/regions.cs) décrit, en pixels physiques de l'écran virtuel, les fenêtres
// visibles au moment de la capture puis, à la demande, les éléments d'interface sous la souris.
// Il réalise aussi la capture défilante d'une page web ou d'une zone qui défile.
const { spawn } = require('child_process');
const { buildHelper } = require('./native/helper');

// UI Automation et les types WPF (Rect, Point) qu'il utilise, dans le dossier du .NET Framework,
// et GDI+ pour la capture défilante
const REFERENCES = ['WPF\\UIAutomationClient.dll', 'WPF\\UIAutomationTypes.dll', 'WPF\\WindowsBase.dll', 'System.Drawing.dll'];
const WINDOWS_TIMEOUT = 500; // ms : au-delà, la capture se fait sans détection
const PROBE_TIMEOUT = 1500;
const SCROLL_TIMEOUT = 20000; // ms sans nouvelles de la capture défilante (chaque pas en donne)

class Regions {
  constructor({ helperDir }) {
    this.helperDir = helperDir;
    this.child = null;
    this.starting = null;
    this.pending = new Map(); // id de la demande -> resolve
    this.seq = 0;
  }

  // Compile (au premier lancement) et démarre l'assistant, en arrière-plan. Windows uniquement.
  start() {
    if (process.platform !== 'win32' || this.child) return Promise.resolve(Boolean(this.child));
    this.starting ??= this.launch()
      .catch(() => false)
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  async launch() {
    const exe = await buildHelper(this.helperDir, 'regions', { references: REFERENCES });
    return new Promise((resolve) => {
      const child = spawn(exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let buffer = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 5000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i).trim();
          buffer = buffer.slice(i + 1);
          if (line === 'ready') {
            clearTimeout(timer);
            this.child = child;
            resolve(true);
          } else if (line) {
            this.answer(line);
          }
        }
      });
      child.stdin.on('error', () => {});
      child.on('error', () => resolve(false));
      child.on('exit', () => {
        clearTimeout(timer);
        resolve(false);
        if (this.child === child) this.child = null;
        // demandes restées sans réponse : la capture continue sans détection
        for (const done of this.pending.values()) done(null);
        this.pending.clear();
      });
    });
  }

  answer(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    this.pending.get(message.id)?.(message);
  }

  // `onProgress` : messages d'avancement avant la réponse, qui repoussent chacun le délai d'attente.
  request(command, timeout, onProgress = null) {
    if (!this.child?.stdin.writable) {
      this.start(); // arrêté ou pas encore prêt : disponible pour la prochaine capture
      return Promise.resolve(null);
    }
    const id = ++this.seq;
    return new Promise((resolve) => {
      let timer = setTimeout(() => done(null), timeout);
      const done = (message) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(message);
      };
      this.pending.set(id, (message) => {
        if (!message || !onProgress || !('progress' in message)) return done(message);
        clearTimeout(timer);
        timer = setTimeout(() => done(null), timeout);
        onProgress(message.progress);
      });
      this.child.stdin.write(command(id));
    });
  }

  // Fenêtres visibles, de la plus haute à la plus basse : { hwnd, frame, client, children: [[x, y, l, h, parent]] }.
  async windows() {
    const message = await this.request((id) => `windows ${id}\n`, WINDOWS_TIMEOUT);
    return message?.windows ?? null;
  }

  // Éléments d'interface de la fenêtre `hwnd` sous le point, du plus grand au plus petit : [[x, y, l, h, type, n]],
  // n > 0 pour un élément qui défile (voir scrollCapture).
  async probe(hwnd, x, y) {
    const message = await this.request((id) => `at ${id} ${hwnd} ${Math.round(x)} ${Math.round(y)}\n`, PROBE_TIMEOUT);
    return message?.chain ?? null;
  }

  // Capture défilante de l'élément n (donné par probe), visible dans la zone [x, y, l, h] (pixels physiques) d'un
  // écran à l'échelle `scale` : l'assistant le fait défiler de haut en bas en capturant la zone, enregistre l'image
  // assemblée dans `file`, puis le ramène où il était. Renvoie { width, height, end }, ou null en cas d'échec ;
  // `end` : 'bottom' (bas atteint), 'stopped' (stopScroll), 'limit' (image trop haute) ou 'interrupted'.
  async scrollCapture(n, [x, y, w, h], scale, file, onProgress) {
    const message = await this.request((id) => `scroll ${id} ${n} ${scale} ${x} ${y} ${w} ${h} ${file}\n`, SCROLL_TIMEOUT, onProgress);
    return message?.done ?? null;
  }

  // Arrête la capture défilante en cours : ce qui est déjà capturé est gardé.
  stopScroll() {
    if (this.child?.stdin.writable) this.child.stdin.write('stop\n');
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end(); // l'assistant se ferme de lui-même
    setTimeout(() => child.exitCode === null && child.kill(), 500);
  }
}

module.exports = { Regions };
