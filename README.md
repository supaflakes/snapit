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

Pendant la sélection : glisser pour choisir la zone, simple clic pour l'écran entier,
`Échap` ou clic droit pour annuler. Une loupe affiche les pixels sous le curseur.
Le multi-écran et les échelles mixtes (ex. 4K à 150 % + 1080p à 100 %) sont gérés.

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
Ils sont conservés d'une capture et d'une session à l'autre.

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
- **Délai** de la capture différée, **copie automatique** de chaque capture dans le presse-papiers (activée par défaut).
- **Bibliothèque de captures** : enregistrement automatique de chaque capture, dossier des captures,
  affichage de la galerie en bas de l'éditeur (tous deux activés par défaut).
- **Dossier et format** proposés par « Enregistrer » (`Ctrl+S`).

Les paramètres sont enregistrés dans `%APPDATA%\snapit\settings.json`.

## Développement

- `npm run smoke` : test de bout en bout (Impr. écran simulée, paramètres et langue, capture plein écran,
  sélection de zone simulée, annotations, réglages, annuler/rétablir, presse-papiers, bibliothèque et galerie).
  Affiche brièvement l'overlay de sélection. Il utilise son propre profil et sa propre bibliothèque
  (dans `%TEMP%\snapit-smoke`) : vos paramètres et vos captures ne sont pas touchés.
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
src/native/keyhook.cs  assistant clavier (hook bas niveau) pour Impr. écran
src/i18n.js            traductions français / anglais, partagées par toutes les fenêtres
src/theme.css          couleurs des thèmes sombre et clair
src/preload.js         pont IPC exposé aux pages (contextIsolation + sandbox)
src/overlay/           sélection de zone plein écran (une fenêtre par écran)
src/editor/shapes.js   modèle, rendu et géométrie des annotations
src/editor/editor.js   interface de l'éditeur : outils, préréglages, historique, zoom, export,
                       enregistrement automatique et galerie
src/settings/          fenêtre des paramètres
```
