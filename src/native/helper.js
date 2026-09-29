'use strict';

// Assistants natifs de Snapit (C#, dans ce dossier) : compilés au premier lancement avec le compilateur fourni
// avec Windows (.NET Framework), une seule fois par version de leur source.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function frameworkDir() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  return ['Framework64', 'Framework']
    .map((f) => path.join(windir, 'Microsoft.NET', f, 'v4.0.30319'))
    .find((dir) => fs.existsSync(path.join(dir, 'csc.exe')));
}

// `references` : bibliothèques du .NET Framework utilisées par l'assistant, relatives à son dossier.
async function buildHelper(dir, name, { references = [] } = {}) {
  const source = fs.readFileSync(path.join(__dirname, `${name}.cs`), 'utf8');
  const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 10);
  const exe = path.join(dir, `${name}-${hash}.exe`);
  if (fs.existsSync(exe)) return exe;

  const framework = frameworkDir();
  if (!framework) throw new Error('csc.exe introuvable');

  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `${name}.cs`);
  fs.writeFileSync(src, source);
  const args = ['/nologo', '/optimize', '/target:exe', `/out:${exe}`, ...references.map((r) => `/r:${path.join(framework, r)}`), src];
  await new Promise((resolve, reject) => {
    execFile(path.join(framework, 'csc.exe'), args, { windowsHide: true }, (err, stdout) =>
      err ? reject(new Error(String(stdout || err.message))) : resolve(),
    );
  });
  // supprime les versions précédentes de l'assistant
  for (const file of fs.readdirSync(dir)) {
    if (file.startsWith(`${name}-`) && file.endsWith('.exe') && path.join(dir, file) !== exe) fs.rmSync(path.join(dir, file), { force: true });
  }
  return exe;
}

module.exports = { buildHelper };
