# Snapit

Capture d'écran et annotations pour Windows, dans l'esprit de Snagit.

## Démarrer

Prérequis : Node.js et Rust (rustup, avec les outils de compilation MSVC). L'interface s'affiche avec WebView2,
inclus dans Windows 11.

```bash
npm install
npm start
```

Snapit est écrit en Rust avec [Tauri](https://tauri.app) : la capture, la sélection de zone, la détection des zones,
la capture défilante et les raccourcis sont natifs ; l'éditeur et les paramètres sont des pages web. Jusqu'à la
version 0.4, Snapit reposait sur Electron (installateur de 106 Mo) ; l'histoire de la migration et ses mesures sont
dans `docs/plan-migration-tauri.md`. Les paramètres et la bibliothèque des versions Electron sont repris tels quels.

Snapit s'installe dans la zone de notification : fermer l'éditeur ne quitte pas l'application
(clic droit sur l'icône → **Quitter Snapit**).

## Capturer

| Raccourci global (par défaut) | Action |
| --- | --- |
| `Impr. écran` | Capturer une zone |
| `Maj+Impr. écran` | Capturer l'écran entier (écran sous la souris) |
| `Ctrl+Impr. écran` | Capture différée (3 s par défaut) |

Les raccourcis se changent dans **Paramètres** (icône ⚙ de l'éditeur ou menu de la zone de notification).

Pendant la sélection, comme dans Snagit, Snapit **détecte ce qui se trouve sous la souris** et le met en
surbrillance : une fenêtre, un menu ouvert, la barre des tâches, et à l'intérieur des fenêtres la page web d'un
navigateur, une barre d'outils, un panneau, une liste, une image ou un bouton.

| Action | Effet |
| --- | --- |
| Clic | Capture la zone en surbrillance (l'écran entier au-dessus du bureau) |
| Glisser | Capture une zone libre |
| Molette vers le haut / `↑` | Zone englobante (par exemple la fenêtre plutôt que la page), jusqu'à l'écran entier |
| Molette vers le bas / `↓` | Zone plus petite |
| `Entrée` | Capture la zone en surbrillance |
| `Échap` ou clic droit | Annule |

Une zone choisie à la molette reste sélectionnée tant que la souris ne la quitte pas. La loupe affiche les pixels
sous le curseur et la taille de la zone. Le multi-écran et les échelles mixtes (ex. 4K à 150 % + 1080p à 100 %)
sont gérés.

Au moment de la capture, Snapit relève la position des fenêtres visibles et de leurs sous-fenêtres, puis, sous la
souris, celle des éléments d'interface grâce à UI Automation (l'interface d'accessibilité de Windows). Il ne lit que
des positions et des types d'éléments, jamais de texte. L'option « Détecter les fenêtres et les zones sous la souris »
des paramètres la désactive : un clic capture alors l'écran entier, comme avant.

L'écran est copié directement depuis la carte graphique (duplication du bureau DXGI) en une quinzaine de
millisecondes, et la sélection s'affiche environ 30 ms après le raccourci. Les fenêtres de Snapit restent affichées
mais sont retirées de l'image (Windows 10 2004 et suivants).

### Capturer toute la page (capture défilante)

Comme dans Snagit, quand la souris survole une page web qui défile (Chrome, Edge…), un bouton
**Capturer toute la page** apparaît en bas de la page. Un clic la capture en entier, jusqu'en bas, y compris ce
qu'on ne voit qu'en faisant défiler :

- Snapit remonte en haut de la page, la fait défiler écran par écran et assemble les captures au pixel près ;
  l'overlay reste affiché avec l'avancement (Windows le retire des captures) et la page défile dessous ;
- un en-tête ou un pied de page fixes, même translucides, et une barre latérale collante ne sont gardés qu'une
  fois, la barre de défilement est retirée ;
- la page revient ensuite là où elle était ;
- `Échap` arrête la capture en gardant ce qui est déjà capturé.

Le défilement passe par UI Automation : le bouton apparaît aussi,
sous le nom **Capturer toute la zone**, sur les autres zones qui défilent quand l'application les décrit à Windows.
La capture s'arrête à 30 000 pixels de haut. Comme dans Snagit, ce qui reste fixe à l'écran dans le bas de la page
ou sur presque toute sa hauteur (bouton flottant, barre latérale pleine hauteur, notification) se répète à chaque
écran. Dans l'éditeur, une page très haute s'affiche ajustée à la largeur.

Par défaut, chaque capture est **copiée dans le presse-papiers** et **enregistrée dans la bibliothèque**
(voir ci-dessous) ; les deux se désactivent dans les paramètres.

## Bibliothèque et galerie

Comme dans Snagit, chaque capture est enregistrée automatiquement, annotations comprises, dans
`Images\Snapit` (dossier modifiable dans les paramètres), puis mise à jour à chaque modification :
plus besoin d'enregistrer, et fermer la fenêtre ne demande rien.

```
Images\Snapit\Capture 2026-09-29 à 14.03.22.png   l'image annotée, telle qu'exportée
Images\Snapit\.snapit\                            (caché) image d'origine, annotations, miniatures
```

La **galerie**, en bas de l'éditeur, présente toutes les captures, de la plus récente à la plus ancienne :

- un clic rouvre la capture avec ses annotations, toujours modifiables ;
- une nouvelle capture s'ouvre dans la même fenêtre, la précédente reste dans la galerie
  (sans galerie, chaque capture a sa fenêtre, comme avant) ;
- `×` au survol ou `Suppr` supprime une capture (l'image annotée va dans la corbeille) ;
- clic droit : ouvrir dans une nouvelle fenêtre, copier l'image, afficher dans l'Explorateur, supprimer ;
- **Dossier** ouvre le dossier des captures ; le bouton à droite de la barre d'état masque ou affiche la galerie.

Les images ouvertes (`Ctrl+O`), collées ou déposées ne vont pas dans la bibliothèque : elles gardent
l'enregistrement classique (`Ctrl+S`).

### Impr. écran et l'Outil Capture de Windows

Sous Windows 11, `Impr. écran` ouvre normalement l'Outil Capture. Tant que Snapit est ouvert (et que l'option
« Utiliser Impr. écran pour Snapit » est active), Snapit intercepte la touche avant Windows : un hook clavier bas
niveau qui ne reconnaît que les combinaisons de capture configurées. Il tourne dans un petit processus à part
(`snapit.exe --keyhook`, environ 9 Mo), car Windows ne transmet pas Impr. écran au hook d'une application dont une
fenêtre est au premier plan ; il se ferme avec Snapit.
Aucun réglage de Windows n'est modifié : l'Outil Capture reprend la main dès que Snapit est fermé.

Beaucoup de claviers (ou leur logiciel) n'envoient pas vraiment Impr. écran mais `Win+Maj+S`, le raccourci de
l'Outil Capture. Snapit intercepte donc aussi `Win+Maj+S` et le redirige vers la capture de zone ; une touche neutre
est envoyée pour que le relâchement de `Win` n'ouvre pas le menu Démarrer.

## Annoter

| Touche | Outil |
| --- | --- |
| `M` | Mes préréglages : vos préréglages de tous les outils (voir plus bas) |
| `V` | Sélection (déplacer, redimensionner, flèches du clavier pour ajuster) |
| `A` | Flèche |
| `R` / `E` | Rectangle / Ellipse (`Maj` : carré / cercle) |
| `L` | Ligne (`Maj` : angles de 45°) |
| `P` / `H` | Crayon / Surligneur |
| `T` | Texte (double-clic pour modifier) |
| `N` | Étape numérotée (1, 2, 3…) |
| `B` | Pixeliser une zone sensible |
| `C` | Rogner en traçant la zone à garder |

**Rogner comme dans Paint** : tirez les poignées autour de l'image (coins et milieux des bords). `Ctrl+Z` annule.

### Panneau de propriétés

Le panneau de droite affiche les réglages de l'outil actif, ou de l'annotation sélectionnée :

| Outil | Réglages |
| --- | --- |
| Flèche | couleur, épaisseur, pointes (fin / début / deux bouts / aucune), forme de pointe (pleine / ouverte / point), corps effilé, trait (continu / tirets / pointillés), contour, ombre, opacité |
| Ligne | couleur, épaisseur, trait, contour, ombre, opacité |
| Rectangle / Ellipse | couleur, épaisseur, trait, arrondi (rectangle), remplissage et son opacité, contour, ombre, opacité |
| Crayon / Surligneur | couleur, épaisseur, contour, ombre, opacité |
| Texte | couleur, police, taille, gras, italique, contour, fond, ombre |
| Étape | couleur, taille, forme (cercle / carré), numéro, contour, ombre |
| Pixeliser | effet (pixeliser / flouter), intensité |

Modifier un réglage s'applique à l'annotation sélectionnée et devient le réglage par défaut de l'outil.
Chaque outil mémorise ses réglages d'une session à l'autre ; le bouton ↺ rétablit les valeurs d'origine.

**Préréglages** : en haut du panneau, chaque outil propose des styles enregistrés, appliqués en un clic
(à l'outil et à l'annotation sélectionnée). `+` enregistre le style actuel, `×` au survol supprime un préréglage.
Si vous modifiez les réglages après avoir choisi un préréglage, il s'encadre de tirets : au survol, **Mettre à jour**
y enregistre les nouveaux réglages, **Appliquer** revient aux siens. Ils sont conservés d'une capture et d'une session
à l'autre.

**Mes préréglages** (★ au début de la barre d'outils, touche `M`) réunit les préréglages que vous avez enregistrés
avec `+`, tous outils confondus : un clic sur l'un d'eux et l'on dessine directement avec son outil, sans quitter la
catégorie ni passer d'un outil à l'autre. Les réglages de l'outil choisi restent modifiables en dessous, où `+`
enregistre le style actuel. Les préréglages proposés d'office restent dans leur outil ; `+` sur l'un d'eux l'ajoute
à Mes préréglages.

Autres raccourcis : `Ctrl+Z` / `Ctrl+Y` annuler / rétablir, `Suppr` supprimer,
`Ctrl+C` copier l'image, `Ctrl+S` enregistrer (PNG ou JPEG), `Ctrl+O` ouvrir,
`Ctrl+V` coller une image, `Ctrl+N` nouvelle capture, `Ctrl+molette` zoom,
`Ctrl+0` ajuster, `Ctrl+1` taille réelle, `Espace`+glisser pour se déplacer.
On peut aussi glisser-déposer une image dans la fenêtre.

## Paramètres

- **Langue** : automatique, français ou anglais (appliquée immédiatement à toutes les fenêtres).
- **Thème** : système, sombre ou clair.
- **Lancer au démarrage de Windows** (version installée uniquement).
- **Raccourcis de capture** : cliquer sur un raccourci puis appuyer sur la combinaison voulue ; l'état de chaque
  raccourci est affiché (actif, prioritaire sur l'Outil Capture, ou déjà pris par une autre application).
- **Utiliser Impr. écran pour Snapit** plutôt que l'Outil Capture de Windows.
- **Délai** de la capture différée, **détection des fenêtres et des zones** sous la souris et **copie automatique**
  de chaque capture dans le presse-papiers (toutes deux activées par défaut).
- **Bibliothèque de captures** : enregistrement automatique de chaque capture, dossier des captures,
  affichage de la galerie en bas de l'éditeur (tous deux activés par défaut).
- **Dossier et format** proposés par « Enregistrer » (`Ctrl+S`).

Les paramètres sont enregistrés dans `%APPDATA%\snapit\settings.json`.

## Mises à jour

Snapit vérifie au démarrage, puis toutes les 6 heures, si une nouvelle version est publiée sur GitHub. Si oui, une
notification le signale et le menu de l'icône propose **Installer la mise à jour** : rien n'est téléchargé ni installé
sans votre accord. Les fenêtres de l'éditeur sont fermées (avec confirmation s'il reste des modifications non
enregistrées), l'installateur remplace Snapit et le relance. Les mises à jour sont signées : Snapit refuse un fichier
qui ne porte pas la signature de son auteur.

## Développement

- `npm start` : lance Snapit en développement (`F12` ouvre les outils de développement de WebView2).
- `npm run selftest` : test de bout en bout, avec un profil et une bibliothèque à part dans
  `%TEMP%\snapit-selftest` : vos paramètres et vos captures ne sont pas touchés. Il couvre les touches réelles
  (Impr. écran, `Win+Maj+S`, enregistrement d'un raccourci), l'overlay de sélection (rendu, clavier, zone tracée à la
  souris), la capture défilante de pages de test ouvertes dans un processus à part (`snapit.exe --test-page`), dont
  des pages difficiles (en-tête translucide, barre latérale collante, bouton flottant), le chemin complet depuis le
  bouton « Capturer toute la page », les annotations enregistrées automatiquement, les paramètres et la langue, la
  capture plein écran (l'éditeur affiché n'y figure pas), le presse-papiers, la galerie et le chargement du module
  de mise à jour. Captures d'écran de contrôle et rapport dans ce même dossier.
- `npm run measure` : mesures de performance (démarrage, délai avant l'overlay et son détail, capture plein écran,
  mémoire), avec un profil à part. Résultats dans `%TEMP%\snapit-measure-tauri\mesures.json`.
- `npm run dist` : construit l'installateur et la mise à jour signée dans `src-tauri\target\release\bundle\nsis` :
  `Snapit_<version>_x64-setup.exe`, sa signature (`.sig`) et `latest.json`, à joindre tous trois à la publication
  GitHub `v<version>`. La clé privée de signature est lue dans `TAURI_SIGNING_PRIVATE_KEY`, sinon dans
  `%USERPROFILE%\.tauri\snapit-updater.key` ; elle ne doit jamais être publiée. Sans elle, les installations
  existantes ne peuvent plus être mises à jour.
- `npm run icons` : régénère les icônes de `assets/`.
- L'éditeur et les paramètres fonctionnent aussi dans un navigateur pour itérer sur l'interface :
  servir la racine du projet puis ouvrir `src/editor/index.html?demo` (ajouter `&lang=en` pour l'anglais)
  ou `src/settings/index.html`.

## Structure

```
src/editor/shapes.js       modèle, rendu et géométrie des annotations
src/editor/editor.js       interface de l'éditeur : outils, préréglages, historique, zoom, export,
                           enregistrement automatique et galerie
src/settings/              fenêtre des paramètres
src/bridge.js              API window.snapit des pages, au-dessus de Tauri
src/i18n.js                traductions français / anglais, partagées par les pages et Snapit
src/theme.css              couleurs des thèmes sombre et clair
src-tauri/src/main.rs      démarrage, zone de notification, fenêtres
src-tauri/src/commands.rs  commandes appelées par les pages
src-tauri/src/capture.rs   capture d'écran (dxgi.rs : duplication du bureau ; win.rs : GDI) et sélection
src-tauri/src/overlay.rs   overlay de sélection natif (Win32, Direct2D)
src-tauri/src/zones.rs     détection des fenêtres et des éléments d'interface (UI Automation), capture défilante
src-tauri/src/hotkeys.rs   raccourcis ; keyhook.rs : hook clavier bas niveau (processus --keyhook)
src-tauri/src/editors.rs   fenêtres de l'éditeur et des paramètres
src-tauri/src/library.rs   bibliothèque des captures ; settings.rs : paramètres ; images.rs : PNG, JPEG, presse-papiers
src-tauri/src/updater.rs   mise à jour automatique
src-tauri/src/selftest.rs  test de bout en bout ; testpage.rs : page de test ; measure.rs : mesures
```
