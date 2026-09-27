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

| Raccourci global | Action |
| --- | --- |
| `Impr. écran` | Capturer une zone |
| `Maj+Impr. écran` | Capturer l'écran entier (écran sous la souris) |
| `Alt+Maj+S` | Capturer une zone (alternative) |

Pendant la sélection : glisser pour choisir la zone, simple clic pour l'écran entier,
`Échap` ou clic droit pour annuler. Une loupe affiche les pixels sous le curseur.
Le multi-écran et les échelles mixtes (ex. 4K à 150 % + 1080p à 100 %) sont gérés.

> Sous Windows 11, si `Impr. écran` ouvre l'Outil Capture, désactivez
> *Paramètres → Accessibilité → Clavier → « Utiliser le bouton Impr. écran pour ouvrir la capture d'écran »*,
> ou utilisez `Alt+Maj+S`.

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
| `C` | Rogner |

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

Autres raccourcis : `Ctrl+Z` / `Ctrl+Y` annuler / rétablir, `Suppr` supprimer,
`Ctrl+C` copier l'image, `Ctrl+S` enregistrer (PNG ou JPEG), `Ctrl+O` ouvrir,
`Ctrl+V` coller une image, `Ctrl+N` nouvelle capture, `Ctrl+molette` zoom,
`Ctrl+0` ajuster, `Ctrl+1` taille réelle, `Espace`+glisser pour se déplacer.
On peut aussi glisser-déposer une image dans la fenêtre.

## Développement

- `npm run smoke` : test de bout en bout (capture plein écran, sélection de zone simulée,
  annotations, annuler/rétablir, presse-papiers). Affiche brièvement l'overlay de sélection.
- `npm run icons` : régénère les icônes de `assets/`.
- `npm run dist` : construit l'installateur Windows dans `dist/`.
- `F12` ouvre les outils de développement (hors version packagée).
- L'éditeur fonctionne aussi dans un navigateur pour itérer sur l'interface :
  servir la racine du projet puis ouvrir `src/editor/index.html?demo`.

## Structure

```
src/main.js            processus principal : zone de notification, raccourcis, capture, fenêtres
src/preload.js         pont IPC exposé aux pages (contextIsolation + sandbox)
src/overlay/           sélection de zone plein écran (une fenêtre par écran)
src/editor/shapes.js   modèle, rendu et géométrie des annotations
src/editor/editor.js   interface de l'éditeur : outils, historique, zoom, export
```
