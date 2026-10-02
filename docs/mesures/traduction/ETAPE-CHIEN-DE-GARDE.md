# Le chien de garde et le temps restant (2026-08-31)

Chrome 151.0.7922.174. Video de mesure : une balise `<video>` reelle servie par
`bancs/test-video-traduction.js` (port 8733), construite a partir de
`bancs/audio/extrait-fr-dur.wav` (extrait ARTE, francais, 45 s) repete jusqu'a la duree
voulue. Durees utilisees : **9 min 00 s** et **18 min 00 s**.

Un essai a aussi ete fait sur une VRAIE video YouTube :
« La lumiere nous raconte l'histoire de l'univers | David Elbaz | ARTE »
(https://www.youtube.com/watch?v=07h6WA3Tdwk, 9 min 52). Il a revele un DEUXIEME
defaut, decrit au point 8, et n'a pas pu servir de vehicule de validation.

---

## 1. Le diagnostic : la file avancait-elle ?

Journal releve toutes les 5 s par `bancs/test-progres.html` (page d'extension, donc non
ephemere), video de 9 minutes, AVANT tout correctif :

```
   s | partis | finis |  file s | traite s | debit | dernier bloc ms | mots | arret
   0 |      1 |     0 |   24.02 |    19.67 | 2.117 |               - |    0 | non
  55 |      4 |     3 |   75.32 |    78.28 | 1.218 |           10301 |   96 | non
 110 |      7 |     6 |  127.53 |   136.15 | 1.141 |            7691 |  181 | non
 160 |     10 |     9 |  170.69 |   193.00 | 1.140 |             706 |  266 | non
 215 |     12 |    11 |  241.62 |   231.98 | 1.034 |           18545 |  324 | non
 245 |     14 |    13 |  262.05 |   271.62 | 1.068 |            9818 |  391 | non  <- file au maximum
 270 |     15 |    14 |  250.39 |   290.63 | 1.041 |           15270 |  417 | OUI  <- fin de la video
 355 |     20 |    19 |  153.34 |   387.68 | 1.064 |            7954 |  569 | OUI
 435 |     25 |    24 |   58.47 |   482.55 | 1.086 |            4542 |  713 | OUI
 495 |     28 |    27 |    0.00 |   541.02 | 1.073 |            9247 |  804 | OUI
```

**Reponse : LA FILE AVANCAIT.** `finis` monte de 0 a 28 sans jamais stagner,
`traite` de 19,7 s a 541 s, `mots` de 0 a 804. Le plus long silence entre deux
blocs TERMINES est de **18 545 ms**.

Les deux chiffres qui condamnent l'ancien filet :

- la file a culmine a **262 s de contenu en attente** ;
- la vidange APRES la fin de la video a dure **3 min 45 s**, contre un
  `setTimeout` de 60 s.

Le service worker, lui, a survecu du debut a la fin (`sw ok` a chaque releve) :
ce n'etait pas lui le probleme.

---

## 2. Le correctif

`PREP_VEILLE_MS = 60000` (un `setTimeout` arme a la fin du defilement) est
**entierement retire**. A sa place, une sonde qui interroge l'offscreen toutes
les 5 s et compare une signature de QUATRE compteurs de travail :
`blocsPartis / blocsTermines / contenuTraite / nbMots`. Il suffit qu'UN SEUL
bouge pour que ce ne soit pas une panne. `PREP_PANNE_MS = 90000` est le temps
d'IMMOBILITE tolere — dimensionne sur le pire silence mesure (18,5 s) et sur les
blocs de 26 s documentes dans CLAUDE.md, soit un facteur ~3,5.

⚠️ **Pourquoi quatre compteurs et pas seulement « blocs termines »** : un bloc
juge silencieux par `prepEstSilence` revient sans passer par le compteur des
blocs transcrits. Mesure sur YouTube : **27 blocs PARTIS pour 3 TERMINES** sur
une piste devenue muette. Surveiller les seuls blocs termines aurait crie a la
panne sur un moteur qui travaillait.

---

## 3. Le temps restant

```
reste = max( (file + contenu pas encore capte) / debit_moteur ,
             (contenu pas encore capte) / vitesse )
```

⚠️ **Le debit est celui du MOTEUR, pas celui de l'horloge**, et la distinction a
coute une mesure fausse. « contenu consomme / temps ecoule » vaut ~2 tant que la
file est vide : il mesure alors le DEFILEMENT. Premiere version : elle annoncait
**251 s** la ou il en restait **480**. Le debit moteur rapporte le contenu au
temps ou le moteur a reellement travaille (`msMoteur`).

⚠️ **Et il a fallu deux compteurs de contenu.** `prepConsommes` avance quand un
bloc PART, `msMoteur` quand il REVIENT : les rapporter l'un a l'autre donnait un
debit faux d'un bloc entier (2,456 au lieu de ~1,2 apres un seul bloc). D'ou
`prepContenuTranscritS`, qui n'avance qu'au retour.

**Non-recul** : la valeur affichee est bornee par la precedente diminuee du temps
ecoule. Elle peut chuter, jamais grimper.

---

## 4. Les mesures apres correctif

| | 9 min (validation) | 18 min | 9 min (juste apres le 18 min) |
|---|---|---|---|
| va au bout | **oui** | **oui** | **oui** |
| « Preparation interrompue » | **jamais** | **jamais** | **jamais** |
| duree reelle | 543,8 s | 567,5 s | 393,5 s |
| mots | 802 | 1613 | 791 |
| blocs vus / abandonnes | 28 / **0** | — | — |
| 1re annonce | 429 s a 99,5 s | 500 s a 62,0 s | 230 s a 88,3 s |
| fin predite | 528,5 s | 562,0 s | 318,3 s |
| **ecart** | **15,3 s (2,8 %)** | **5,5 s (1,0 %)** | **75,3 s (19 %)** |
| valeurs annoncees | 89 | 999 | 459 |
| **valeurs qui augmentent** | **0** | **0** | **0** |

⚠️ **Le troisieme run montre la limite de l'estimation, et il faut la dire** :
l'annonce suppose que le debit du moteur reste ce qu'il est au moment ou elle est
faite. Quand il se degrade en cours de route (file qui grossit), la regle du
non-recul empeche de corriger vers le haut : le compteur arrive a zero avant la
fin et affiche « encore un instant… ». C'est le prix assume de la regle.

---

## 5. Les acquis, sur la video de 9 minutes

| # | ce que j'ai vu |
|---|---|
| 1 | `ecranVideS` 52,1 s sur 540 s ; a la lecture, 5,7 % des releves sans texte — ce sont les silences de la piste (l'extrait de 45 s finit par une pause, repetee 12 fois) |
| 2 | **mediane 6 ms** (n=46, min 0, max 22) |
| 3 | duree mediane d'un bloc a l'ecran **3 334 ms** ; le journal montre des phrases entieres |
| 4 | **une seule hauteur de boite sur toute la lecture : 100 px** ; `nbDebordent: 0`, `debordementsVus: 0` |
| 5 | **NON RE-MESURE.** `tab.audible` ne mesure pas la sortie haut-parleur. Le diff ne touche aucune ligne du graphe audio |
| 6 | apres la preparation : `currentTime 0`, `paused true`, `rate 1`, `volume 1`, `preservesPitch true` — identique a l'etat de depart |
| 7 | pause a 149,8 s : texte inchange apres 3 s ; saut a 400 s : bon bloc en 0,03 s ; saut arriere a 60 s : bon bloc en 0,03 s |

---

## 6. « Texte incomplet » — le rapport, sans correction

6 blocs signales sur 28, tous par le detecteur de troncature. Zero bloc
silencieux, zero radotage, zero bloc abandonne.

| bloc | instant video | duree | couvert | texte rendu |
|---|---|---|---|---|
| 4 | 58,0 s | 19,9 s | 75 % | la surface d'un trou noir marque l'espace a l'interieur duquel matiere et lumiere restent piegees sans espoir c'est l'horizon des evenements |
| 11 | 192,7 s | 19,0 s | 80 % | La surface d'un trou noir marque l'espace. A l'interieur duquel matiere et lumiere. Restent piegee sans espace de tout. C'est l'horizon des evenements. |
| 14 | 251,3 s | 19,2 s | 82 % | C'est l'horizon des evenements. La matiere tourbillonne avant de disparaitre tout jamais. Elle dessine un contour qui devoile l'invisible. |
| 18 | 328,0 s | 19,9 s | 76 % | La surface d'un trou noir marque l'espace. A l'interieur duquel matiere et lumiere. Restent piegee sans espace. C'est l'horizon des evenements. |
| 25 | 462,7 s | 19,0 s | 80 % | noir la surface d'un trou noir marque l'espace a l'interieur duquel matiere et lumiere restent piegees sans espace de tout c'est l'horizon des evenements |
| 28 | 519,4 s | 20,7 s | 84 % | espoir. C'est l'horizon des evenements. Autour d'eux. La matiere tourbillonne avant de disparaitre tout jamais. Elle dessine un contour qui devoile l'invisible. |

Fait brut : les six blocs finissent tous sur la fin de l'extrait de 45 s, dont les
dernieres secondes sont une pause. Le detecteur compare « instant du dernier
mot » a « duree du bloc » : un bloc dont la queue tombe dans le silence de
l'extrait est signale incomplet alors qu'aucun mot ne manque. C'est un constat,
pas un diagnostic : je n'y ai pas touche.

---

## 7. Contre-preuves

### Volet A — le detecteur crie-t-il encore quand il DOIT crier ?

Panne provoquee : `chrome.runtime.reload()` depuis le service worker, **en pleine
vidange** de la video de 3 minutes. Le service worker et l'offscreen
disparaissent, `content.js` reste orphelin, le lecteur reste a **x2** a 179,96 s.

```
  t+0     s : video 179,96 s, x2 — « derniers mots en cours de transcription »
  t+86,9  s : « ⚠️ Préparation bloquée — rien n'a avancé depuis 95 s.
                Le lecteur a été remis en état. »
              video 0 s, x1, en pause
```

Le message apparait, et il dit CE QU'ON A CONSTATE. Le lecteur est rendu.

### Volet B — l'estimation mesure-t-elle quelque chose ?

Les deux runs faits **a la suite**, machine dans le meme etat, comparaison a la
**meme position video** (81 s) :

| video | contenu restant | reste annonce |
|---|---|---|
| 18 min | 999 s | **500 s** |
| 9 min | 459 s | **230 s** |
| rapport | **2,18** | **2,17** |

L'estimation suit le travail restant.

---

## 8. Le defaut trouve en chemin, et NON corrige

Sur la vraie video YouTube, l'element `<video>` a ete **demonte par la page** a
~48 s : `readyState: 0`, `duration: null`, `paused: true`, position figee.

- Le detecteur d'enlisement de `content.js` ne le voit pas : sa condition
  commence par `!v.paused`, et la video etait EN PAUSE.
- L'offscreen a continue de capter du silence : 27 blocs partis, 3 transcrits,
  `traite` monte a 637 s pour une video de 592 s.
- La preparation ne pouvait plus se terminer : `prepSurFin` attend `v.ended` ou
  `currentTime >= duration`, et `duration` valait `null`.

C'est un DEUXIEME defaut, distinct du chien de garde, et hors du perimetre
demande. Il n'a pas ete corrige.
