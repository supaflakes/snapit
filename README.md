# Snapit

Capture d'écran et annotations pour Windows, dans l'esprit de Snagit.

## Démarrer

```bash
npm install
npm start
```

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

La détection repose sur un second petit assistant (`src/native/regions.cs`), compilé comme celui du clavier : au
moment de la capture, il relève la position des fenêtres visibles et de leurs sous-fenêtres, puis, sous la souris,
celle des éléments d'interface grâce à UI Automation (l'interface d'accessibilité de Windows). Il ne lit que des
positions et des types d'éléments, jamais de texte. L'option « Détecter les fenêtres et les zones sous la souris »
des paramètres la désactive : un clic capture alors l'écran entier, comme avant.

Ce même assistant réalise la capture de l'écran elle-même, en quelques dizaines de millisecondes. Les fenêtres de
Snapit restent affichées mais sont retirées de l'image (Windows 10 2004 et suivants), si bien que l'overlay
apparaît presque instantanément. Si l'assistant n'est pas disponible, la capture passe par Electron, plus lente.

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

Le défilement passe par UI Automation (c'est l'assistant des zones qui s'en charge) : le bouton apparaît aussi,
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
« Utiliser Impr. écran pour Snapit » est active), un petit assistant intercepte la touche avant Windows :
un hook clavier bas niveau (`src/native/keyhook.cs`) qui ne reconnaît que les combinaisons de capture configurées.
Il est compilé au premier lancement avec le compilateur C# fourni avec Windows (.NET Framework) et se ferme avec Snapit.
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

## Développement

- `npm run smoke` : test de bout en bout (Impr. écran simulée, paramètres et langue, détection des fenêtres et des
  éléments de page, capture plein écran, sélection de zone simulée, annotations, réglages, Mes préréglages,
  annuler/rétablir, presse-papiers, bibliothèque et galerie, capture défilante d'une page de test ouverte dans un
  processus à part par `scripts/smoke-page.js`).
  Affiche brièvement l'overlay de sélection. Il utilise son propre profil et sa propre bibliothèque
  (dans `%TEMP%\snapit-smoke`) : vos paramètres et vos captures ne sont pas touchés.
- `npm run scroll-test` : capture défilante de pages de test difficiles (en-tête opaque ou translucide, barre
  latérale collante, barre latérale presque pleine hauteur, bouton flottant), sans overlay ni touches simulées :
  l'image doit couvrir toute la page, chaque bande à sa place, la barre latérale une seule fois. Images dans
  `%TEMP%\snapit-scroll-test`.
- `npm run measure` : mesures de performance (démarrage, délai avant l'overlay et son détail, capture plein
  écran, mémoire, taille de l'installeur), avec un profil et une bibliothèque à part. Résultats dans
  `%TEMP%\snapit-measure\mesures.json`. Voir `docs/plan-migration-tauri.md`.
- `npm run icons` : régénère les icônes de `assets/`.
- `npm run dist` : construit l'installateur Windows dans `dist/`.
- `F12` ouvre les outils de développement (hors version packagée).
- L'éditeur et les paramètres fonctionnent aussi dans un navigateur pour itérer sur l'interface :
  servir la racine du projet puis ouvrir `src/editor/index.html?demo` (ajouter `&lang=en` pour l'anglais)
  ou `src/settings/index.html`.

## Structure

```
src/main.js            processus principal : zone de notification, capture, fenêtres, IPC
src/settings.js        paramètres de l'application (settings.json)
src/library.js         bibliothèque des captures (enregistrement automatique, galerie)
src/hotkeys.js         raccourcis globaux et assistant clavier
src/regions.js         détection des fenêtres et des éléments d'interface pour la sélection de zone,
                       capture défilante
src/native/helper.js   compilation des assistants natifs (compilateur C# fourni avec Windows)
src/native/keyhook.cs  assistant clavier (hook bas niveau) pour Impr. écran
src/native/regions.cs  assistant de détection : fenêtres, sous-fenêtres, éléments UI Automation ;
                       capture défilante (défilement, captures, assemblage)
src/i18n.js            traductions français / anglais, partagées par toutes les fenêtres
src/theme.css          couleurs des thèmes sombre et clair
src/preload.js         pont IPC exposé aux pages (contextIsolation + sandbox)
src/overlay/           sélection de zone plein écran (une fenêtre par écran) ; la version Tauri la
                       dessine en natif (src-tauri/src/overlay.rs)
src/editor/shapes.js   modèle, rendu et géométrie des annotations
src/editor/editor.js   interface de l'éditeur : outils, préréglages, historique, zoom, export,
                       enregistrement automatique et galerie
src/settings/          fenêtre des paramètres
```
