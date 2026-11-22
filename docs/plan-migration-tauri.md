# Plan de migration hybride : Electron → Tauri + cœur natif Rust

> Objectif : une app plus réactive au moment de capturer, plus légère sur le disque et en mémoire,
> **sans changer l'apparence** de l'éditeur, des paramètres ni de la galerie.

## 1. Principes

- **Migration par étapes** : à la fin de chaque phase, Snapit fonctionne, se teste et peut être publié.
- **L'interface web est conservée** : `src/editor`, `src/settings`, `theme.css`, `i18n.js` restent du HTML/CSS/JS,
  affichés par WebView2 (le moteur Chromium intégré à Windows, le même rendu qu'Electron).
- **Le pont `window.snapit` reste identique** : toute l'interface parle déjà au processus principal par cette seule
  API (`src/preload.js`). On la réimplémente côté Tauri ; `editor.js` et `settings.js` n'ont presque pas à changer.
- **Le natif là où l'utilisateur le ressent** : capture, overlay de sélection, raccourcis, détection des zones,
  capture défilante.

## 2. Architecture cible

```
snapit/
├─ src/                      interface web (inchangée ou presque)
│  ├─ editor/  settings/  theme.css  i18n.js
│  └─ bridge.js              remplace preload.js : window.snapit → invoke()/listen() de Tauri
└─ src-tauri/                application Rust
   ├─ main.rs                zone de notification, fenêtres, commandes (ex-main.js)
   ├─ settings.rs            settings.json (même format, même emplacement %APPDATA%\snapit)
   ├─ library.rs             bibliothèque (même format de dossier : les captures existantes restent lisibles)
   ├─ hotkeys.rs             hook clavier bas niveau dans le processus (ex-keyhook.cs)
   ├─ capture.rs             capture d'écran GPU (Windows.Graphics.Capture / DXGI)
   ├─ regions.rs             fenêtres + UI Automation (ex-regions.cs)
   ├─ scroll.rs              capture défilante et assemblage (ex-regions.cs)
   └─ overlay/               overlay de sélection natif (Win32 + Direct2D)
```

## 3. Correspondance des briques actuelles

| Aujourd'hui (Electron) | Demain |
| --- | --- |
| `Tray`, `Menu` | `tauri::tray` |
| `BrowserWindow` éditeur / paramètres | `WebviewWindow` Tauri |
| `desktopCapturer` + redimensionnement | `capture.rs` (Windows.Graphics.Capture), résolution physique directe |
| Overlay HTML par écran, image envoyée en JPEG base64 | fenêtre native par écran qui affiche directement la texture capturée |
| `setContentProtection` | `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` |
| `globalShortcut` + `keyhook.cs` compilé par `csc.exe` | `hotkeys.rs` (hook WH_KEYBOARD_LL, même logique Win+Maj+S) ; plugin `global-shortcut` en repli |
| `regions.cs` compilé par `csc.exe` | `regions.rs` + `scroll.rs` (crate `windows`, UI Automation) |
| `clipboard` | crate `clipboard-win` ou API Win32 (format PNG + DIB) |
| `dialog` | plugin `tauri-plugin-dialog` |
| `shell.showItemInFolder`, `openPath`, `trashItem` | plugin `opener` + `SHFileOperation`/`IFileOperation` pour la corbeille |
| `app.setLoginItemSettings` | plugin `tauri-plugin-autostart` |
| `requestSingleInstanceLock` | plugin `tauri-plugin-single-instance` |
| `nativeImage` (PNG, JPEG, miniatures) | crate `image` ou WIC |
| `electron-builder` (NSIS, ~107 Mo) | bundler Tauri (NSIS ou MSI, ~5 à 10 Mo) |

## 4. Phases

### Phase 0 — Préparer le terrain (dans Electron)

1. **Mesurer l'état actuel** pour comparer ensuite : délai raccourci → overlay affiché, mémoire au repos et
   éditeur ouvert, temps de démarrage, taille de l'installeur.
2. **Supprimer l'appel synchrone** `librarySaveSync` (`sendSync` au `beforeunload` de l'éditeur) : Tauri n'a pas
   d'IPC synchrone. Le remplacer par un enregistrement déclenché à la demande de fermeture, que la fenêtre
   confirme une fois l'écriture terminée.
3. **Isoler le pont** : vérifier qu'aucun fichier de l'interface n'utilise autre chose que `window.snapit`.

*Résultat : aucune différence visible, mais l'interface est prête à changer de « moteur ».*

**Fait (20/11/2026)** :

- `npm run measure` (`scripts/measure.js`) relève les mesures de référence (section 7) et les enregistre dans
  `%TEMP%\snapit-measure\mesures.json`.
- La fermeture de l'éditeur ne fait plus d'appel synchrone. Le processus principal demande la fermeture
  (`editor:close-request`), l'éditeur enregistre ce qui reste (avec un second essai en cas d'échec) puis répond
  (`editor:close-ready`). La confirmation « modifications non enregistrées » passe aussi par cet échange : c'est
  le fonctionnement de `onCloseRequested` dans Tauri. Nouveauté : si l'enregistrement d'une capture de la
  bibliothèque échoue, la fermeture est confirmée par l'utilisateur au lieu de perdre la modification en silence.
- Pont vérifié : l'éditeur, les paramètres et l'overlay ne passent que par `window.snapit`. Seuls points à
  surveiller : `navigator.clipboard` (utilisé uniquement en mode démo, dans un navigateur) et le glisser-déposer
  d'images dans l'éditeur (API HTML5), qui demandera `dragDropEnabled: false` sur la fenêtre Tauri.

### Phase 1 — Coquille Tauri à parité de fonctionnalités

1. Installer Rust (rustup + outils de compilation MSVC) et créer `src-tauri/` avec Tauri 2.
2. Porter `main.js`, `settings.js` et `library.js` en Rust, en gardant **les mêmes formats de fichiers** :
   paramètres et captures existants repris tels quels.
3. Écrire `src/bridge.js` : la même API `window.snapit`, branchée sur `invoke()` et `listen()`.
4. **Réutiliser temporairement les assistants C#** : leurs protocoles sont de simples lignes sur l'entrée et la
   sortie standard, Rust peut les lancer sans modification.
5. Overlay temporaire : `overlay.html` dans une fenêtre Tauri transparente.

*Résultat : Snapit sous Tauri, même apparence, installeur d'environ 10 Mo, mémoire au repos fortement réduite.
Publiable en 0.5.0.*

**Faite (20/11/2026), à côté de la version Electron, qui reste intacte** :

- `src-tauri/` : Tauri 2, en Rust. Paramètres (`%APPDATA%\snapit\settings.json`) et bibliothèque dans le même
  format que la version Electron. Les assistants C# sont repris tels quels pour les raccourcis et la détection des
  zones.
- `src/bridge.js` remplace `preload.js`. Les pages ne changent pas, à trois détails près : la politique de sécurité
  (CSP) autorise l'IPC de Tauri et ses images, l'icône est servie depuis `src/icon.png`, et l'overlay libère son
  image à la fin d'une sélection.
- La capture d'écran se fait directement en Rust (GDI, `win::grab_screen`). L'overlay reçoit un aperçu JPEG encodé
  par Windows (WIC, environ 12 ms) par le protocole `snapit://`.
- Les overlays restent prêts entre deux captures, avec une mémoire réduite dans WebView2. Après 2 minutes sans
  capture, ils sont détruits : Snapit au repos redescend à environ 110 Mo.
- `npm run tauri:selftest` : autotest de bout en bout (15 vérifications, captures d'écran de contrôle dans
  `%TEMP%\snapit-selftest`). `npm run tauri:measure` : mesures, dans `%TEMP%\snapit-measure-tauri`.
  `npm run tauri:dist` : installeur.

| | Electron (capture native) | Tauri |
| --- | --- | --- |
| Installeur | 106,3 Mo | **1,7 Mo** |
| Demande de capture → overlay affiché | 114 ms | 125 à 170 ms (200 à 280 ms la première fois) |
| Capture plein écran → éditeur | 226 ms | 220 à 250 ms |
| Mémoire, éditeur ouvert | 389 Mo | 424 à 438 Mo |
| Mémoire au repos, juste après des captures | 759 à 870 Mo | 529 Mo |
| Mémoire au repos, après 2 minutes sans capture | 759 à 870 Mo | **112 Mo** |

Points restant à vérifier à la main, que l'autotest ne couvre pas : la touche Impr. écran réelle (la version
Electron installée était ouverte pendant les tests et intercepte aussi la touche), la capture défilante (dont le
test échoue aussi dans la version Electron), le menu de la zone de notification, le menu contextuel de la galerie,
les boîtes d'enregistrement et d'ouverture, le glisser-déposer d'une image et le lancement au démarrage. Les
notifications apparaissent sous le nom « Windows PowerShell » tant que Snapit n'est pas installé.

### Phase 2 — Capture native

**Avancée et faite en partie dans Electron (20/11/2026)** :

- L'assistant `regions.cs`, déjà lancé en permanence, capture l'écran (commande `grab`, GDI) en environ 45 ms au
  lieu des 1 150 ms de `desktopCapturer`. Les pixels bruts passent par un fichier temporaire. Electron reste le
  repli si l'assistant est indisponible.
- Les fenêtres de Snapit ne sont plus cachées avant la capture : elles sont retirées de l'image
  (`setContentProtection`, soit WDA_EXCLUDEFROMCAPTURE), puis cachées sous l'overlay une fois celui-ci affiché.
  L'attente avant capture passe de 263 ms à 16 ms. Elle reste de 180 ms quand la capture part du menu de la zone
  de notification, le temps que le menu disparaisse.
- Résultat : overlay affiché en **114 ms** au lieu de 1 450 ms, capture plein écran dans l'éditeur en **226 ms**
  au lieu de 1 535 ms.

Reste à faire, en Rust :

1. `capture.rs` : Windows.Graphics.Capture (repli DXGI), directement à la résolution physique de chaque écran,
   multi-écran et échelles mixtes compris.
2. Masquer les fenêtres de Snapit par « cloaking » DWM plutôt qu'en les cachant, ce qui permet de réduire les
   180 à 250 ms d'attente actuelles avant la capture.
3. Transmettre les images à l'éditeur par un protocole local (`snapit://capture/<id>.png`) plutôt qu'en base64.

*Résultat : capture nettement plus rapide.*

**Faite dans la version Tauri (20/11/2026)** :

- `dxgi.rs` : duplication du bureau (DXGI Desktop Duplication), ouverte au démarrage et gardée sur un fil dédié, un
  périphérique Direct3D par carte graphique (portables à deux cartes). L'écran est copié depuis la carte graphique
  en **14 ms** au lieu de 65 ms avec GDI.
- Limite constatée : retirer une fenêtre de la capture (WDA_EXCLUDEFROMCAPTURE) ne produit pas de nouvelle image
  dans la duplication. Sur un écran où une fenêtre de Snapit est affichée, l'image vient donc de GDI, qui en tient
  compte. GDI sert aussi de secours : écran tourné, écran HDR, bureau sécurisé, accès perdu.
  Windows.Graphics.Capture n'a pas été retenu : il affiche une bordure jaune autour de l'écran capturé et demande
  plus de temps pour démarrer une session.
- Les fenêtres de Snapit sont retirées de l'image sans être cachées, puis cachées sous l'overlay (déjà fait en
  phase 1) : il n'y a plus d'attente avant la capture, sauf les 180 ms du menu de la zone de notification.
- L'éditeur reçoit ses images par le protocole `snapit://image/<n>.png` (chargées avec CORS pour que l'export
  reste possible) au lieu d'une URL data: en base64 ; de même pour les captures rouvertes depuis la galerie.
- Autotest : l'éditeur rempli de magenta reste affiché pendant une capture plein écran, et la vérification relève
  0 pixel magenta sur toute sa zone.

| | Avant la phase 2 | Après |
| --- | --- | --- |
| Raccourci → overlay, aucune fenêtre de Snapit à l'écran | 125 à 170 ms | **85 à 95 ms** |
| Raccourci → overlay, éditeur affiché (GDI) | 125 à 170 ms | 145 à 200 ms |
| Capture plein écran → éditeur | 220 à 250 ms | **189 à 193 ms** |

Non vérifié : plusieurs écrans, échelles mixtes, écran tourné, écran HDR et portable à deux cartes graphiques
(une seule configuration disponible pour les tests).

### Phase 3 — Raccourcis clavier natifs

Porter `keyhook.cs` dans `hotkeys.rs`, sur un fil dédié du processus. Même comportement : Impr. écran prioritaire
sur l'Outil Capture, redirection de Win+Maj+S, enregistrement des raccourcis dans les paramètres.

*Résultat : plus d'assistant clavier séparé, plus de compilation au premier lancement pour lui.*

**Faite dans la version Tauri (20/11/2026), avec une différence** :

- `keyhook.rs` : le hook clavier bas niveau est écrit en Rust, avec le même comportement que `keyhook.cs` :
  - Impr. écran est prioritaire sur l'Outil Capture ;
  - Win+Maj+S est redirigé vers la capture de zone, avec une touche neutre pour que le menu Démarrer ne s'ouvre
    pas ;
  - le hook remonte les touches lors de l'enregistrement d'un raccourci dans les paramètres.
- Il ne peut pas tourner sur un fil du processus principal : Windows ne transmet pas Impr. écran au hook d'un
  processus dont une fenêtre est au premier plan. Quand l'éditeur était actif, Impr. écran n'arrivait donc jamais.
  C'est sans doute la raison de l'assistant séparé de la version Electron.
- Le hook tourne donc dans un petit processus à part : **le même exécutable**, relancé avec `--keyhook`. Il n'y a
  plus de C#, plus de compilation au premier lancement ni de console associée. Le processus occupe environ 9 Mo,
  contre 14 Mo pour l'assistant C# plus 6 Mo de console. Il démarre en arrière-plan, sans retarder l'ouverture de
  l'éditeur.
- Autotest : Impr. écran et Win+Maj+S sont envoyées depuis un autre processus, comme un vrai clavier. Elles
  doivent ouvrir la sélection de Snapit, sans lancer l'Outil Capture. Maj+Impr. écran doit aussi être enregistrée
  comme nouveau raccourci dans les paramètres.
- `src/native/keyhook.cs` reste utilisé par la version Electron.

### Phase 4 — Détection des zones et capture défilante en Rust

1. `regions.rs` : énumération des fenêtres et sous-fenêtres, puis éléments sous la souris par UI Automation
   (positions et types seulement, jamais de texte, comme aujourd'hui).
2. `scroll.rs` : défilement par UI Automation, assemblage au pixel près, gestion des en-têtes et pieds fixes,
   des barres latérales collantes et de la limite de 30 000 px.
3. Valider sur les pages de `scripts/scroll-test.js`, transformées en tests Rust automatiques.

*Résultat : plus aucun code C#, plus de dépendance à `csc.exe`, donc plus de risque de blocage par un antivirus.
C'est la phase la plus longue (environ 1 000 lignes de C# délicates).*

**Faite dans la version Tauri (20/11/2026)** : `zones.rs` remplace `regions.cs`.

- **Fenêtres :** énumération Win32 directe.
- **Éléments sous la souris :** UI Automation par COM, sur un fil dédié ; seule la dernière recherche compte.
- **Capture défilante :** même algorithme d'assemblage que le C#, transcrit ligne à ligne. L'image est rendue
  directement, sans passer par un fichier PNG.
- **Validation :** avant de retirer le C#, l'autotest a comparé les deux versions. Les listes de fenêtres étaient
  identiques, et les éléments trouvés aussi sur 7 points de l'écran (42 éléments).
- **La version Tauri ne contient plus de C#** : rien n'est compilé au premier lancement, `csc.exe` n'est plus
  appelé, et il n'y a plus d'assistant `regions-….exe` (30 Mo) ni de console associée. Mémoire au repos : 116 Mo
  (le processus principal et celui du hook clavier). `src/native/*.cs` reste utilisé par la version Electron.

Deux problèmes trouvés et corrigés en route :

- **Chromium n'active son accessibilité complète qu'après une première interrogation.** La toute première recherche
  sur une page ne voyait donc pas qu'elle défile, et le bouton « Capturer toute la page » n'apparaissait pas au
  premier survol. C'est très probablement la cause de l'échec du test de fumée Electron, dont l'assistant C# a le
  même défaut. Désormais, les pages Chromium visibles sont « réveillées » au début de chaque sélection, et une
  première recherche sur une page qui ne montre rien à faire défiler est refaite après 150 ms.
- **Tauri réécrit le style étendu de l'overlay à l'affichage**, ce qui lui faisait perdre WS_EX_TOOLWINDOW. Chrome
  et Edge se croyaient alors cachés : ils cessaient de dessiner leur page, et la capture défilante lancée depuis
  l'overlay ne gardait que la partie visible. Le style est maintenant réappliqué après chaque affichage.

Autotest : la page de test du test de fumée Electron est ouverte dans un processus à part. Deux scénarios sont
vérifiés :

- **Capture défilante directe :** hauteur exacte (3 063 px), barre de défilement retirée, 16 bandes à leur place,
  en-tête fixe gardé une seule fois, et la page qui revient à sa position.
- **Chemin complet de l'utilisateur :** sélection de zone, page proposée dans l'overlay, capture défilante lancée
  depuis l'overlay, puis la page entière dans l'éditeur.

Non fait : les pages difficiles de `scripts/scroll-test.js` (en-tête translucide, barre latérale collante, bouton
flottant) n'ont pas encore été portées dans l'autotest Rust.

### Phase 5 — Overlay de sélection natif

1. Une fenêtre Win32 par écran (WS_EX_TOOLWINDOW, comme aujourd'hui, pour que Chrome et Edge continuent de
   décrire leurs pages), dessinée en Direct2D / DirectComposition.
2. Reproduire à l'identique : fond assombri, surbrillance de la zone détectée, sélection libre, dimensions,
   loupe, bouton « Capturer toute la page », barre d'avancement. Couleurs, arrondis et police repris de
   `theme.css` et `overlay.js`.
3. Fenêtres créées d'avance et gardées cachées pour un affichage instantané.

*Résultat : overlay affiché sans délai perceptible après le raccourci.*

**Faite dans la version Tauri (21/11/2026)** : `overlay.rs` remplace la page `src/overlay` (gardée pour la version
Electron).

- **Fenêtres :** une fenêtre Win32 par écran, de style « outil » dès sa création (plus de style réécrit par Tauri).
  Toutes vivent sur un fil dédié, avec sa propre boucle de messages : l'affichage ne dépend ni de la boucle de Tauri
  ni de WebView2.
- **Dessin :** Direct2D et DirectWrite, à la résolution physique de l'écran. L'image capturée est envoyée telle
  quelle à la carte graphique : plus d'aperçu JPEG à encoder (12 ms), ni de page à charger et à décoder.
- **Apparence :** la logique et les dessins d'`overlay.js` sont transcrits à l'identique : mêmes couleurs, arrondis,
  police (Segoe UI Variable), loupe, réticule, bouton « Capturer toute la page » et panneau d'avancement. Seule
  différence : les ombres floues du canvas sont imitées par des rectangles arrondis superposés.
- **Affichage sans éclair :** la fenêtre est affichée masquée par DWM (« cloaking »), dessinée, puis démasquée.
  Aucune image précédente ni fond noir n'apparaît.
- **Clavier :** l'overlay prend le premier plan comme le faisait Tauri, avec une touche neutre si Windows le refuse.
- **Mémoire :** l'image de l'écran est libérée à la fin de chaque sélection. Les surfaces de dessin sont libérées
  après 2 minutes sans capture ; les fenêtres, très légères, restent prêtes.
- **Autotest :** 31 vérifications. Les nouvelles :
  - l'overlay reçoit le clavier ;
  - son rendu correspond à la capture, pixel pour pixel, assombrie hors de la zone en surbrillance ;
  - une zone tracée à la souris (messages envoyés à la fenêtre) donne la bonne taille ;
  - sur la page de test, le bouton « Capturer toute la page » apparaît au survol, et un clic dessus ouvre la page
    entière dans l'éditeur.

Mesures (`npm run tauri:measure`), comparées à la version d'avant la phase 5, sur la même machine :

| | Avant | Après |
| --- | --- | --- |
| Raccourci → overlay, aucune fenêtre de Snapit à l'écran | 82 ms | **30 ms** |
| Raccourci → overlay, éditeur affiché (capture GDI) | 133 ms | **84 ms** |
| Première sélection après le démarrage | 286 ms | 135 ms |
| Capture plein écran → éditeur | 171 ms | 157 ms |
| Mémoire juste après des captures, éditeur fermé | 525 Mo | **167 Mo** |
| Mémoire au repos (2 minutes sans capture) | 118 Mo, dont 80 Mo privés | 122 Mo, dont 82 Mo privés |

Avec l'éditeur affiché, le délai vient surtout de la capture GDI (environ 70 ms), nécessaire tant qu'une fenêtre de
Snapit est à l'écran (voir la phase 2).

Non vérifié :

- plusieurs écrans et échelles mixtes (passage du clavier d'un écran à l'autre, sélection à cheval) ;
- souris et clavier réels : l'autotest envoie des messages à la fenêtre. La molette, les flèches, Entrée et le clic
  droit ne sont pas testés automatiquement ;
- rendu sur un écran HDR ou tourné, et après une réinitialisation de la carte graphique (surfaces recréées).

### Phase 6 — Finitions

- Miniatures et encodage PNG/JPEG en Rust.
- Fermer les WebView quand l'éditeur et les paramètres sont fermés, pour ne garder que le cœur natif en mémoire.
- Installeur Tauri, signature du code, mise à jour automatique (plugin `updater`), éventuellement.
- Suppression d'Electron, de `electron-builder` et de `src/native/`.

**Faite (21/11/2026) : Snapit 0.5.0 ne contient plus Electron.**

- **Déjà acquis :** les WebView de l'éditeur et des paramètres sont détruites à leur fermeture depuis la phase 1 :
  au repos, il ne reste que le cœur natif et le processus du hook clavier. Les captures sont encodées en Rust (PNG,
  miniature JPEG). L'éditeur refait seulement la miniature d'une capture annotée, car c'est lui qui dessine les
  annotations.
- **Electron retiré :** `electron` et `electron-builder`, `src/main.js`, `src/preload.js`, les modules Node de
  `src/`, `src/native/` (assistants C#), la page `src/overlay/` et les scripts de test Electron. `node_modules` passe
  de plusieurs centaines de Mo à 17 Mo. `npm start`, `npm run dist`, `npm run selftest` et `npm run measure` visent
  désormais Tauri.
- **Page de test sans Electron :** la page de la capture défilante est ouverte par Snapit lui-même, dans un autre
  processus (`snapit.exe --test-page`, `testpage.rs`, avec un profil WebView2 à part). Les pages difficiles de
  `scroll-test.js` sont portées dans l'autotest : en-tête translucide, barre latérale collante, barre latérale
  presque pleine hauteur, bouton flottant. Toutes passent avec WebView2. L'autotest compte 58 vérifications.
- **Contrôle plus robuste :** l'éditeur affiché pendant la capture plein écran est rempli d'une couleur exacte et
  inhabituelle, au lieu de magenta. Une page magenta ouverte à l'écran (ChatGPT, dans les tests) donnait un faux
  échec.
- **Mise à jour automatique** (`updater.rs`, plugin `updater`) :
  - vérification 30 s après le démarrage puis toutes les 6 heures, sur
    `releases/latest/download/latest.json` du dépôt GitHub ;
  - si une version est disponible : notification et élément **Installer la mise à jour** en tête du menu de l'icône ;
  - rien n'est installé sans le demander : les fenêtres de l'éditeur sont fermées avec la confirmation habituelle,
    puis l'installateur (mode passif) remplace Snapit et le relance ;
  - le plugin n'est chargé qu'à la première vérification : chargé au démarrage, il retardait l'ouverture de
    Snapit d'environ 0,55 s (préparation de son client HTTPS).
- **Signature des mises à jour :** paire de clés minisign générée par `tauri signer generate`. La clé publique est
  dans `tauri.conf.json`, la clé privée hors du dépôt (`%USERPROFILE%\.tauri\snapit-updater.key`, sans mot de
  passe). `npm run dist` (`scripts/dist.js`) signe l'installateur et écrit `latest.json`.
- **Installateur 0.5.0 :** 2,4 Mo (1,8 Mo en 0.4.1 sous Tauri, 106 Mo avec Electron) : le plugin de mise à jour
  et son client HTTPS en ajoutent environ 0,6.

Mesures finales (`npm run measure`) : démarrage 0,78 s, overlay en 31 ms (90 ms avec l'éditeur affiché), capture
plein écran dans l'éditeur en 156 ms, 131 Mo au repos (dont 87 Mo privés).

Non fait :

- **Signature du code (Authenticode)** : elle demande un certificat de signature de code, à acheter. Sans elle,
  SmartScreen avertit au premier lancement de l'installateur.
- **Publication de la 0.5.0 sur GitHub** et vérification d'une vraie mise à jour de bout en bout (0.5.0 → 0.5.1).
  Les versions Electron (0.4.x) n'ont pas de mise à jour automatique : il faut installer la 0.5.0 à la main, puis
  désinstaller l'ancienne version, installée par un autre installateur.
- **Vérifications manuelles** encore à faire : menu de la zone de notification, boîtes Enregistrer et Ouvrir,
  glisser-déposer d'une image, lancement au démarrage, multi-écran.

### Après la migration — capture rapide même éditeur ouvert (22/11/2026)

Quand une fenêtre de Snapit est à l'écran, elle est retirée de la capture (WDA_EXCLUDEFROMCAPTURE). Mais ce
retrait ne change rien à ce que l'écran affiche : Windows ne recompose pas l'image, et la duplication du bureau ne
fournit pas de nouvelle image sans nos fenêtres. Depuis la phase 2, la capture repassait donc par GDI (≈ 70 ms).

- **Solution :** une fenêtre d'un pixel, quasi transparente (opacité 1/255) et elle-même retirée des captures,
  apparaît 200 ms dans le coin de l'écran (`overlay::recompose`). Son apparition oblige Windows à recomposer
  l'écran ; la duplication reçoit alors une image sans nos fenêtres, en une vingtaine de millisecondes.
- **Essais écartés :**
  - redessiner nos fenêtres (`RedrawWindow`) : nouvelle image seulement quand l'écran bougeait par ailleurs, une
    vidéo par exemple (GDI dans 5 à 6 captures sur 16) ;
  - attendre sans rien provoquer : 150 ms perdus, puis GDI, soit environ 240 ms.
- **Repli :** l'attente d'une image postérieure au retrait est limitée à 60 ms, au lieu de 150. Si elle n'arrive pas,
  GDI prend le relais.
- **Autotest :** nouvelle vérification que la capture plein écran, éditeur affiché, passe par DXGI. L'éditeur est
  rempli d'une couleur témoin, et aucun de ses pixels ne doit figurer sur l'image : 0 sur 9 416 relevés.
  59 vérifications.
- **Mesures plus justes :**
  - l'autotest et les mesures ne se lançaient pas quand le Snapit installé tournait (une seule instance) : ils en sont
    maintenant dispensés ;
  - ils ont désormais leur propre dossier WebView2 : partagé, le moteur de pages était celui du Snapit installé, et
    sa mémoire n'était pas comptée ;
  - les étapes de chaque capture sont écrites dans `%TEMP%\snapit-measure-tauri\etapes.txt`.

| | Avant | Après |
| --- | --- | --- |
| Raccourci → sélection, éditeur affiché | 90 ms (capture GDI) | **39 ms** (16 captures sur 16 par DXGI) |
| Capture plein écran → éditeur | 156 ms | **110 à 120 ms** |
| Raccourci → sélection, aucune fenêtre de Snapit | 31 ms | 31 à 39 ms (inchangé) |

### Après la migration — mémoire de l'éditeur et fin de capture

**Mémoire de l'éditeur.** Avec l'éditeur ouvert, la mesure détaille maintenant chaque processus. Sur environ
460 Mo de mémoire de travail, il y a 220 Mo de mémoire privée, dont 100 Mo pour le processus graphique de WebView2.

- **Retenu :** un éditeur passé en arrière-plan depuis 5 s demande à WebView2 de réduire sa mémoire
  (`MemoryUsageTargetLevel` à « faible »). Il revient à la normale dès qu'il reprend le premier plan. Le délai évite
  de vider les caches pour un simple passage par une boîte de dialogue ou par l'overlay. Gain : 65 à 110 Mo de
  mémoire vive (460 → 395 Mo). Sans ce réglage, la mémoire ne bouge pas (vérifié).
- **Écartés :**
  - `--in-process-gpu` : 30 à 50 Mo privés de moins, mais la capture plein écran ralentit de 15 ms, et un plantage
    du rendu emporterait tout le moteur de pages ;
  - `--disable-gpu` : 80 Mo de moins, mais l'éditeur dessinerait sans la carte graphique ;
  - couper les services réseau de fond : aucun gain mesurable.
- **Mesure corrigée :** un processus étranger pouvait être compté comme enfant de Snapit, quand Windows avait
  réattribué le numéro de son parent disparu (1 081 Mo relevés une fois, le Snapit installé compris). Un enfant
  doit maintenant être né après son parent.

**Fin de capture.** Avant, l'éditeur attendait le PNG, puis la miniature, puis l'écriture des fichiers de la
bibliothèque.

- La miniature est calculée en même temps que le PNG. La capture est réservée dans la bibliothèque (identifiant et
  nom de fichier) et ses fichiers sont écrits après l'envoi à l'éditeur. D'ici là, elle n'apparaît pas dans la
  galerie, et une modification déjà enregistrée par l'éditeur n'est pas écrasée. L'envoi à l'éditeur passe de
  70–94 ms à environ 56 ms.
- **Presse-papiers :** arboard réencodait un PNG avec une compression lente, ce qui occupait le processeur pendant
  220 ms. Ce temps tombait au moment où l'éditeur décodait l'image. Snapit écrit maintenant lui-même le presse-papiers,
  avec son PNG déjà encodé et un bitmap CF_DIBV5 pour les autres applications. La capture est collable environ
  110 ms après le raccourci, au lieu de 300 ms.
- **Essai écarté :** envoyer d'abord une image non compressée (BMP, prête en 20 ms). Pour un écran 2560×1600, elle
  pèse 16 Mo, et WebView2 met environ 275 ms à la recevoir et la décoder, contre environ 45 ms pour le PNG de
  860 Ko. La capture plein écran passait de 110 à 330 ms.
- Le temps restant, environ 45 ms entre l'envoi et l'image affichée, se passe dans la page de l'éditeur : décodage
  et dessin. C'est là que se trouverait le prochain gain.

| | Avant | Après |
| --- | --- | --- |
| Éditeur ouvert, en arrière-plan | ≈ 460 Mo | **≈ 395 Mo** |
| Capture plein écran → éditeur | 107 à 111 ms | 95 à 116 ms (inchangé, à la mesure près) |
| Capture plein écran → presse-papiers | ≈ 300 ms | **≈ 110 ms** |
| Capture plein écran → fichiers de la bibliothèque | 70 à 94 ms, avant l'affichage | ≈ 65 ms, après l'affichage |

## 5. Tests

- **Interface** : le mode démo dans un navigateur (`src/editor/index.html?demo`) reste utilisable tel quel.
- **Rust** : tests unitaires pour l'assemblage de la capture défilante, les conversions de coordonnées
  multi-écran et les formats de la bibliothèque.
- **Bout en bout** : porter `scripts/smoke-test.js` sur `tauri-driver` (WebDriver), avec le même profil isolé
  dans `%TEMP%`.

## 6. Risques et points d'attention

| Risque | Parade |
| --- | --- |
| WebView2 absent sur certains Windows 10 | intégré à Windows 11 ; installeur Tauri avec amorce WebView2 |
| Petites différences WebView2 / Electron (presse-papiers, glisser-déposer de fichiers) | presse-papiers géré côté Rust ; glisser-déposer par l'événement Tauri dédié |
| UI Automation verbeuse en Rust | porter `regions.cs` fonction par fonction, en comparant les résultats aux deux versions |
| DPI et échelles mixtes | processus en « Per-Monitor DPI Aware v2 », toutes les coordonnées internes en pixels physiques |
| L'éditeur ouvert consomme toujours de la mémoire (processus WebView2) | le gain principal est au repos ; fermer la WebView quand l'éditeur est fermé |
| Régressions sur la capture défilante | tests automatiques sur les pages difficiles avant de supprimer `regions.cs` |

## 7. Mesures de référence et objectifs

Mesuré le 20/11/2026 avec `npm run measure`, version 0.4.1, un écran 2560×1600 à 125 %.

| | Aujourd'hui (Electron) | Visé |
| --- | --- | --- |
| Installeur | 106,3 Mo | < 10 Mo |
| Demande de capture → overlay affiché | **1 450 ms** (1 600 ms la première fois), **114 ms** après la capture native | < 100 ms |
| Capture plein écran → image dans l'éditeur | 1 535 ms, **226 ms** après la capture native | < 200 ms |
| Mémoire, éditeur ouvert (aucune capture) | 389 Mo, dont 29 Mo d'assistants C# | < 150 Mo |
| Mémoire au repos, après des captures, éditeur fermé | 759 Mo, dont 45 Mo d'assistants C# | < 30 Mo |
| Premier lancement | compile les assistants C# | rien à compiler |

**D'où vient le délai de 1,45 s avant l'overlay ?**

| Étape | Durée |
| --- | --- |
| Attente que les fenêtres de Snapit disparaissent de l'écran | 263 ms |
| Capture de l'écran par `desktopCapturer` d'Electron | **1 151 ms** |
| Préparation de l'image et envoi à l'overlay | 11 ms |
| Overlay prêt puis affiché | 25 ms |

La capture d'écran d'Electron représente à elle seule **80 % de l'attente**. Seule, hors de l'application, elle
prend déjà environ 420 ms. Windows.Graphics.Capture ou DXGI la font en quelques dizaines de millisecondes : **la
phase 2 apporte le plus gros gain perçu**. Elle pourrait même être avancée et tentée dans Electron, avec un petit
module natif, avant la coquille Tauri.

Au repos, la mémoire est surtout occupée par le processus GPU d'Electron (environ 380 Mo), qui garde les images
des overlays conservés pour la capture suivante.

## 8. Ordre de grandeur de l'effort

| Phase | Taille |
| --- | --- |
| 0 — Préparation | petite |
| 1 — Coquille Tauri | moyenne à grande |
| 2 — Capture native | moyenne |
| 3 — Raccourcis natifs | petite |
| 4 — Zones et capture défilante | grande |
| 5 — Overlay natif | moyenne à grande |
| 6 — Finitions | petite à moyenne |

Les phases 2 et 3 sont indépendantes et peuvent se faire dans n'importe quel ordre après la phase 1.
