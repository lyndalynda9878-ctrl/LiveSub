# Traduction branchee — mesures dans Chrome (2026-08-31)

Chrome 151.0.7922.174. Extension chargee non empaquetee.
Video de test : `bancs/test-video-traduction.js` (port 8733), balise `<video>` reelle,
`bancs/audio/extrait-fr-dur.wav` (ARTE, francais) ou `bancs/audio/extrait-en.wav` (anglais),
repetes jusqu'a 1 min 30.

---

## Le fait qui a commande l'architecture

Mesure dans Chrome 151 :

```
Translator.create({ sourceLanguage: "auto", targetLanguage: "en" })
  -> RangeError: Invalid language tag: auto
Translator.create({ targetLanguage: "en" })                    // source omise
  -> TypeError: Failed to read the 'sourceLanguage' property from
     'TranslatorCreateCoreOptions': Required member is undefined.
Translator.create({ sourceLanguage: "und", targetLanguage: "en" })
  -> NotSupportedError: Unable to create translator for the given source and target language.
LanguageDetector.availability()  ->  "unavailable"
LanguageDetector.create()        ->  NotSupportedError: Model not available
```

L'API exige une langue source explicite, et Parakeet n'en donne aucune. D'ou le
menu qui porte la PAIRE.

Et, dans le document offscreen :

| | popup | service worker | document offscreen |
|---|---|---|---|
| `Translator` | oui | oui | **oui** |
| `chrome.i18n.detectLanguage` | oui | oui | **`undefined`** |
| `chrome.storage` | oui | oui | `undefined` |
| activation utilisateur | **oui** | jamais | jamais |

C'est pour ca que la detection de langue passe par le service worker
(`PREPARATION_DETECTER_LANGUE`) et que le telechargement se fait dans la popup.

---

## Les criteres

| # | mesure | resultat |
|---|---|---|
| 1 | video FR, cible anglais | 21 blocs, 135 mots, texte anglais a l'ecran |
| 2 | video EN, cible francais | 31 blocs, 246 mots, texte francais a l'ecran |
| 3 | « Langue d'origine » | `traduction: null`, **0 segment**, **0 bloc traduit**, texte brut de Parakeet |
| 4 | mediane phrase prononcee -> phrase affichee | **7 ms** (fr->en, n=21) et **8 ms** (en->fr, n=24) |
| 5 | texte d'origine conserve | chaque bloc porte `texte` + `texteTraduit` ; `mots` inchange |
| 6 | temps ajoute | **+0,3 a +0,5 s** sur une preparation de 119 s ; 61 a 66 ms par segment |
| 7 | reseau, paire installee | **0 requete externe** (15 requetes : localhost, `data:`, `blob:`) |
| 8 | les 7 acquis | 6 verifies par mesure, 1 non re-mesure (voir plus bas) |

### Critere 6 — le detail

Meme video anglaise de 1 min 30, meme machine :

| | duree totale | traduction |
|---|---|---|
| sans traduction | **118 978 ms** | — |
| avec en->fr (essai 1) | **119 276 ms** | 31 segments, 2 059 ms, 66 ms/segment |
| avec en->fr (essai 2) | **119 500 ms** | 31 segments, 1 990 ms, 64 ms/segment |
| avec fr->en (hors ligne) | — | 21 segments, 1 282 ms, 61 ms/segment |

L'ecart bout-en-bout (+0,3 a +0,5 s) est du meme ordre que l'ecart entre deux
essais identiques : la traduction ne se voit pas a l'echelle d'une preparation.

---

## Les contre-preuves

### Volet A — la traduction a-t-elle eu lieu ?

Mots du texte AFFICHE presents tels quels dans le texte d'origine
(`docs/mesures/traduction/volet-a-recouvrement.js`, comparaison sans accents ni
ponctuation) :

| paire | mots affiches | identiques a l'original | lesquels |
|---|---|---|---|
| fr -> en | 128 | **8 (6,3 %)** | surface, a, horizon, invisible |
| en -> fr | 287 | **31 (10,8 %)** | possible, a, masses, millions, 17, 4, 400, 142, 150 |

Ce qui survit est exactement ce qui doit survivre : les cognats et les chiffres.

### Volet B — hors ligne

Reseau de Chrome coupe par le proxy systeme (HKCU `127.0.0.1:1`) — le shell n'est
pas eleve, `netsh wlan` renvoie « erreur 5, requiert une elevation ».

Temoin avant : `fetch("https://update.googleapis.com/")` -> `TypeError: Failed to
fetch` (2 127 ms) ; `fetch("http://localhost:8733/")` -> 200.
Temoin apres la preparation : toujours `Failed to fetch`.

Resultat : **la preparation est allee au bout** — « ✅ Prêt — 131 mots préparés,
1 min 30 s couvertes », 21 segments, **21 traduits, 0 echec**.
Guetteur TCP sur la fenetre complete : **aucune connexion sortante nouvelle**
(seules les 4 sockets deja ouvertes au premier sondage).

### Volet C — la mesure mesure-t-elle quelque chose ?

| decalage de test | mediane | min | max |
|---|---|---|---|
| 0 ms | **7 ms** | 0 | 19 |
| +3000 ms | **3 008 ms** | 3 002 | 3 020 |
| remis a 0 | mesures remises a zero | | |

---

## Les 7 acquis

| # | acquis | ce que j'ai vu |
|---|---|---|
| 1 | l'overlay ne disparait jamais | `ecranVideS` : **7,8 s** avec traduction contre **9,2 s** sans, sur la MEME video francaise. Le blanc vient des silences de la piste, pas de la traduction — il diminue meme. Sur la video anglaise : **0 s**. |
| 2 | mediane sous 200 ms | **7 ms** et **8 ms** |
| 3 | phrases en blocs lisibles | duree mediane a l'ecran **3 890 / 2 782 / 4 142 ms** ; le journal de lecture montre des phrases entieres |
| 4 | la boite ne saute pas | **une seule hauteur** relevee sur toute la lecture : **100 px**. `nbDebordent: 0`, `debordementsVus: 0`. ⚠️ Marge : en->fr, le bloc le plus long fait **83 caracteres** et remplit la boite **exactement** (65 px sur 65). Sous la borne de content.js (`BLOC_CARACTERES_ABSOLU = 88`), mais la marge est nulle. |
| 5 | preparation silencieuse | **NON RE-MESURE.** `tab.audible` vaut `true` pendant la preparation, mais ce temoin ne mesure pas la sortie haut-parleur (Chrome : « may not be heard if also muted »). Ce que je peux affirmer : le diff ne touche AUCUNE ligne du graphe audio — pas de `connect`, pas de `destination`, pas de `new Audio`. |
| 6 | la video revient ou elle etait | depart force a **12,5 s**, volume **0,7** : apres la preparation, `currentTime 12.5`, `paused true`, `rate 1`, `muted false`, `volume 0.7`, `preservesPitch true` — identique champ par champ |
| 7 | pause, reprise, sauts | pause a 24,95 s : texte inchange apres 3 s. Saut a 60 s : bon bloc en **0,03 s**. Saut arriere a 20 s : bon bloc en **0,03 s**. |

---

## Une observation qui n'est PAS de moi

Le message « ⚠️ Préparation interrompue — le lecteur a été remis en état »
apparait a ~103 s sur une video de 1 min 30 : c'est le chien de garde
`PREP_VEILLE_MS = 60000` de `content.js`, la file mettant plus de 60 s a se vider
apres la fin de la video.

Il se declenche **a l'identique sans traduction** (103 396 ms) et **avec**
(102 210 / 103 706 ms). Ce n'est donc pas la traduction qui le provoque.
