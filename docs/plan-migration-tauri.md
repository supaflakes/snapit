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

### Phase 3 — Raccourcis clavier natifs

Porter `keyhook.cs` dans `hotkeys.rs`, sur un fil dédié du processus. Même comportement : Impr. écran prioritaire
sur l'Outil Capture, redirection de Win+Maj+S, enregistrement des raccourcis dans les paramètres.

*Résultat : plus d'assistant clavier séparé, plus de compilation au premier lancement pour lui.*

### Phase 4 — Détection des zones et capture défilante en Rust

1. `regions.rs` : énumération des fenêtres et sous-fenêtres, puis éléments sous la souris par UI Automation
   (positions et types seulement, jamais de texte, comme aujourd'hui).
2. `scroll.rs` : défilement par UI Automation, assemblage au pixel près, gestion des en-têtes et pieds fixes,
   des barres latérales collantes et de la limite de 30 000 px.
3. Valider sur les pages de `scripts/scroll-test.js`, transformées en tests Rust automatiques.

*Résultat : plus aucun code C#, plus de dépendance à `csc.exe`, donc plus de risque de blocage par un antivirus.
C'est la phase la plus longue (environ 1 000 lignes de C# délicates).*

### Phase 5 — Overlay de sélection natif

1. Une fenêtre Win32 par écran (WS_EX_TOOLWINDOW, comme aujourd'hui, pour que Chrome et Edge continuent de
   décrire leurs pages), dessinée en Direct2D / DirectComposition.
2. Reproduire à l'identique : fond assombri, surbrillance de la zone détectée, sélection libre, dimensions,
   loupe, bouton « Capturer toute la page », barre d'avancement. Couleurs, arrondis et police repris de
   `theme.css` et `overlay.js`.
3. Fenêtres créées d'avance et gardées cachées pour un affichage instantané.

*Résultat : overlay affiché sans délai perceptible après le raccourci.*

### Phase 6 — Finitions

- Miniatures et encodage PNG/JPEG en Rust.
- Fermer les WebView quand l'éditeur et les paramètres sont fermés, pour ne garder que le cœur natif en mémoire.
- Installeur Tauri, signature du code, mise à jour automatique (plugin `updater`), éventuellement.
- Suppression d'Electron, de `electron-builder` et de `src/native/`.

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
