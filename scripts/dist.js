// Construit l'installateur de Snapit et ce qu'il faut pour la mise à jour automatique.
// Usage : npm run dist
//
// La mise à jour est signée avec la clé privée de Snapit : TAURI_SIGNING_PRIVATE_KEY (contenu ou chemin de la clé),
// sinon %USERPROFILE%\.tauri\snapit-updater.key ; mot de passe éventuel dans TAURI_SIGNING_PRIVATE_KEY_PASSWORD.
// Résultat dans src-tauri/target/release/bundle/nsis : l'installateur, sa signature (.sig) et latest.json, les trois
// fichiers à joindre à la publication GitHub (tag v<version>).
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'src-tauri', 'tauri.conf.json'));
const REPO = 'supaflakes/snapit';

const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const key = path.join(os.homedir(), '.tauri', 'snapit-updater.key');
  if (!fs.existsSync(key)) {
    console.error(`Clé de signature des mises à jour introuvable : ${key}\n(TAURI_SIGNING_PRIVATE_KEY ou npx tauri signer generate)`);
    process.exit(1);
  }
  env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(key, 'utf8');
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';

execSync('npx tauri build', { cwd: root, env, stdio: 'inherit' });

const dir = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const installer = `Snapit_${version}_x64-setup.exe`;
const signature = fs.readFileSync(path.join(dir, `${installer}.sig`), 'utf8').trim();
const latest = {
  version,
  notes: `Snapit ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/${REPO}/releases/download/v${version}/${installer}`,
    },
  },
};
fs.writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
console.log(`\nÀ joindre à la publication v${version} : ${installer}, ${installer}.sig et latest.json\n(${dir})`);
