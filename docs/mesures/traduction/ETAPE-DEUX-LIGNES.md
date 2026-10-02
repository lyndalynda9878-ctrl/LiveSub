# L'overlay a deux lignes (2026-09-01)

Chrome 151.0.7922.174. Balise `<video>` reelle servie par
`bancs/test-video-traduction.js` (port 8733), construite a partir de
`bancs/audio/extrait-fr-dur.wav` (extrait ARTE, francais). Durees utilisees : 3 min
(fr -> en) et 1 min 30 (langue d'origine, et fr -> ar).

Un seul fichier touche : **`content.js`**.

---

## Ce qui a ete fait

Une SECONDE zone d'affichage a ete posee a cote de l'existante :

```
subtitleBox
├── zone          (inchangee : statuts, messages d'echec, ruban)
│   └── ligne
└── zoneLecture   (nouvelle : montree PENDANT la lecture, cachee sinon)
    ├── boiteOrigine   hauteur 47 px, overflow hidden   -> ligneOrigine  18 px
    └── boiteTraduite  hauteur 65 px, overflow hidden   -> ligneTraduite 25 px
```

`zone` n'a pas ete transformee : la toucher aurait fait porter le risque a des
chemins qui n'avaient rien demande (le message d'echec qui doit rester entier,
le ruban du mode « mots »).

**Les hauteurs sont en PIXELS, pas en `em`.** `zone` mesure sa hauteur en `em`,
donc elle depend du `font-size` de la boite ; ici les deux lignes ont chacune
leur taille propre, et une hauteur en `em` n'aurait plus de sens commun.

**Deux hauteurs fixes, et seulement deux :**

| mode | contenu | hauteur de boite MESUREE |
|---|---|---|
| avec traduction | 47 + 6 + 65 px | **143,6 px** |
| langue d'origine | 65 px | **90,6 px** |

⚠️ **Les messages de la lecture passent par la MEME zone.** C'est ce qui manquait
pour que l'acquis 4 tienne vraiment : « ⏭️ Au-dela de la preparation », affiche
dans l'ancienne zone, aurait fait changer la boite de hauteur en pleine lecture.

---

## Les criteres

### 1. Capture d'ecran

`capture-deux-lignes-fr-en.png` — original en petit gris, traduction en grand
blanc, l'un sous l'autre.

### 2. La ligne du haut est `texteOrigine`, celle du bas `texteTraduit`

Croisement automatique entre ce qui a ete RELEVE A L'ECRAN pendant la lecture et
le contenu des blocs :

```
couples (haut,bas) affiches retrouves a l'identique dans un bloc : 56
couples affiches qui ne correspondent a AUCUN bloc               : 0
```

Trois exemples :

| affiche a | ligne du HAUT | `bloc.texteOrigine` | ligne du BAS | `bloc.texteTraduit` |
|---|---|---|---|---|
| 0,20 s | La mort de mes premières étoiles, | idem | The death of my first stars, | idem |
| 2,10 s | les trous noirs supermassifs, se sont nourris pendant des milliards | idem | supermassive black holes, fed for billions | idem |
| 5,91 s | d'années de matière, de gaz, d'étoiles parfois, | idem | years of matter, gas, stars sometimes, | idem |

### 3. Hauteur de la boite, relevee toutes les 250 ms

| | fr -> en (3 min) | langue d'origine (1 min 30) |
|---|---|---|
| echantillons | **941** | **361** |
| minimum | **143,6 px** | **90,6 px** |
| maximum | **143,6 px** | **90,6 px** |
| valeurs distinctes | **[143,6]** | **[90,6]** |

### 4. Debordements

```
nbDebordent (ligne du bas, audit des 46 blocs) : 0
nbDebordentHaut (ligne du haut)                : 0
debordementsVus (compteur de l'affichage reel) : 0
case du bas 65 px | case du haut 47 px | plus haut texte rendu 65 px
```

### 5. Mode « Langue d'origine »

361 echantillons, hauteur **90,6 px** constante, **22 affichages, 0 a deux
lignes**. Capture : `capture-langue-origine.png`.

### 6. Blocs sans traduction

**0 sur 46.** Le compte est fait sur le STOCK COMPLET au chargement, pas sur ce
qui a ete lu : un chiffre qui dependrait de jusqu'ou on a regarde la video ne
voudrait rien dire. Quand il n'est pas nul, il s'ecrit dans le resume de fin
(« ✅ Prêt — … — ⚠️ N bloc(s) sans traduction »), dans la console, et il est
rendu par `PREPARATION_MESURES` / `PREPARATION_BLOCS`.

### 7. Arabe

`capture-arabe-rtl.png`. Styles calcules, lus dans le navigateur :

| | direction | text-align | font-size | font-weight | color |
|---|---|---|---|---|---|
| ligne du haut (fr) | `ltr` | `center` | 18px | 400 | rgba(255,255,255,0.62) |
| ligne du bas (ar) | **`rtl`** | **`right`** | 25px | 600 | rgb(255,255,255) |

Hauteur de boite : 143,6 px — la meme qu'en fr -> en.

---

## Contre-preuves

### Volet A — deux textes vraiment differents ?

Mots de la ligne du BAS presents a l'identique dans la ligne du HAUT du MEME
bloc, sur les 46 blocs :

```
mots de la ligne du bas : 268
identiques              : 12  (4,5 %)
les voici               : surface, horizon, invisible
```

Trois cognats, rien d'autre.

### Volet B — la hauteur bouge-t-elle sur un bloc tres court ?

Bloc le plus long du stock (10 mots, 62 caracteres en haut + 75 en bas), puis
saut immediat sur le bloc de 2 mots, puis retour :

| etape | texte | hauteur |
|---|---|---|
| bloc le PLUS LONG | duquel matière et lumière restent piégées sans espace de tout. / from which matter and light remain trapped without the space of everything. | **143,6 px** |
| juste apres le saut | De gaz. / of gas. | **143,6 px** |
| bloc le PLUS COURT | D'étoiles parfois. / Stars sometimes. | **143,6 px** |
| retour au PLUS LONG | (idem) | **143,6 px** |

**Ecart : 0 px.**

---

## Les 7 acquis

| # | ce que j'ai vu |
|---|---|
| 1 | `ecranVideS` 18,1 s sur 180 s — les silences de la piste, inchanges |
| 2 | **mediane 6 ms** (n=102, min 0, max 25) |
| 3 | duree mediane d'un bloc a l'ecran **3 810 ms** ; phrases entieres |
| 4 | **941 echantillons, min = max = 143,6 px** ; 0 debordement |
| 5 | **NON RE-MESURE.** Cette etape ne touche que l'affichage : aucune ligne du graphe audio n'est dans le diff |
| 6 | depart force a **7,5 s**, volume **0,6** : apres la preparation, `currentTime 7.5`, `rate 1`, `volume 0.6`, `paused true`, `preservesPitch true` |
| 7 | pause a 43,94 s : texte inchange apres 3 s, hauteur 143,6 px ; saut avant a 150 s : bon bloc en 0,05 s ; saut arriere a 20 s : bon bloc en 0,05 s ; hauteur 143,6 px a chaque etape |
