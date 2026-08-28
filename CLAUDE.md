# LiveSub — Mémoire du projet

## Vue d'ensemble
LiveSub est une **extension de navigateur (Chrome, Manifest V3)** qui capte le son de
l'onglet, détecte la parole, la transcrit (Whisper), puis la traduit — et affiche des
sous-titres en overlay sur la page.

**Contrainte fondamentale : tout tourne 100 % en local, hors ligne, aucun envoi vers
un serveur tiers.** C'est l'argument central du projet.

## Règles à respecter (non négociables)
- **100 % local / hors ligne** : aucune API distante pour la transcription ou la
  traduction. Le son ne quitte jamais la machine.
- **Aucun CDN** : toute librairie est copiée dans `vendor/` et chargée localement
  (voir la skill `extension-vendor-lib`).
- Chrome uniquement (MV3) ; audio d'un **onglet** (pas le système entier, pour la V1).
- **Une tâche à la fois** : implémenter → tester → valider → committer. Expliquer les
  changements en français simple.

## Architecture (le flux)
onglet (son) → `background.js` (`getMediaStreamId`) → `offscreen.js` (getUserMedia sur
l'onglet) → **VAD** alimente une **fenêtre de parole** (voir « Le flux » plus bas) →
`whisper.worker.js` la re-transcrit en boucle (Web Worker, GPU ou CPU selon la mesure) →
`background.js` relaie le message `FLUX` — `ruban` (stable) + `provisoire` — parce que
l'offscreen n'a pas accès à `chrome.tabs` → `content.js` révèle les mots un par un.

## Fichiers
- `manifest.json` — MV3 ; permissions (storage, tabCapture, activeTab, offscreen) ;
  CSP avec `wasm-unsafe-eval`.
- `background.js` — service worker : orchestre la capture, gère l'offscreen, stocke
  l'état dans `chrome.storage.session`. ⚠️ Le SW est tué régulièrement → ne jamais
  stocker l'état dans une simple variable mémoire.
- `popup.html` / `popup.js` — bouton Démarrer/Arrêter ; demande l'état au background
  (`GET_STATE`), ne le devine pas.
- `content.js` — overlay de sous-titres : boîte de **deux lignes de hauteur fixe**, les
  mots nouveaux révélés **un par un** (`PAS_REVELATION`), le début qui sort par le haut.
  `RETARD_MAX_MOTS` empêche l'affichage de traîner derrière la parole. C'est aussi lui
  qui décide **ce qu'on montre** — stable seul, ou stable + provisoire (voir « Les deux
  modes d'affichage »).
- `offscreen.html` / `offscreen.js` — capture audio (getUserMedia sur l'onglet) + VAD
  (Silero via `@ricky0123/vad-web` ; `getStream/pauseStream/resumeStream` pour écouter
  l'onglet et PAS le micro ; `model: "v5"`).
- `vendor/` — librairies locales (VAD + Transformers.js + runtime ONNX). Gitignoré,
  régénéré par `scripts/copy-assets.js` (postinstall).
- `whisper.worker.js` — **Web Worker** de transcription : c'est là que vivent
  Transformers.js et Whisper, pour que le fil principal ne fige jamais. Choisit aussi
  le backend (GPU/CPU) — voir « Choix du backend » plus bas.
- `test-whisper.html` / `test-whisper.js` — page de test isolée : prouve que Whisper
  transcrit (Transformers.js, `Xenova/whisper-tiny`, `dtype: "fp32"`) depuis le worker,
  sans figer la page. C'est aussi la page qui lit/écrit le backend mémorisé.
- `test-bench.html` / `test-bench.js` — page de **comparaison** : fait tourner plusieurs
  variantes du modèle sur le même audio (fragments à la taille de production + extrait
  complet, EN et FR), chronomètre, et affiche les textes côte à côte. Le worker accepte
  `?modele=…&dtype=…&opt=…` uniquement pour elle ; en production personne ne passe de
  paramètre.

## Dépendances
- `@ricky0123/vad-web` — détection de parole (VAD).
- `@huggingface/transformers` — Whisper (transcription).
- `onnxruntime-web` — moteur d'exécution des modèles.

## Choix du backend : WebGPU ou CPU ? On mesure, on ne suppose pas
**WebGPU n'est PAS toujours plus rapide.** Sur un GPU intégré (ex : Intel Iris Xe,
`gen-12lp`), WebGPU est ~2× **plus lent** que le CPU sur whisper-tiny : le décodeur
enchaîne des dizaines de toutes petites étapes, et le coût de lancement de chaque
calcul sur le GPU dépasse le gain de parallélisme. Sur une carte dédiée, c'est
l'inverse. D'où le choix : **mesurer les deux et garder le plus rapide**, plutôt que
de forcer le GPU.

Comment ça marche :
- Au **tout premier lancement**, le worker chronomètre le GPU et le CPU sur la même
  charge de test, puis garde le gagnant. Les lancements suivants ne remesurent plus.
- Le verdict est mémorisé dans `chrome.storage.local` (clé `whisperBackend`), **par la
  page** : `chrome` est indéfini dans un worker dédié (vérifié). Le worker reçoit le
  verdict dans le message `init` et le renvoie dans `ready`.
- Chaque backend est chronométré dans un **worker neuf**. ONNX Runtime ne charge qu'un
  seul moteur WASM par worker, et le premier backend initialisé l'impose aux suivants :
  mesurer le CPU dans le worker qui vient d'initialiser le GPU le fait tourner sur le
  moteur du GPU (variante `asyncify`) et fausse le classement.
- On garde le **meilleur de 3 passages** : une machine occupée ne peut qu'ajouter du
  temps. Un passage unique a donné 2,4 s puis 6,5 s pour le même backend — assez pour
  inverser un classement qui, lui, est mémorisé pour de bon.
- Repli automatique : si le backend retenu ne charge pas ou ne transcrit pas, on
  bascule sur le CPU sans erreur visible.

Ordres de grandeur mesurés sur cette machine (Intel Iris Xe, extrait de ~10 s) :
CPU ~2,3 s, GPU ~4 à 5 s. *(L'ancien chiffre de « ~12 s » n'est plus d'actualité : il
datait de l'inférence sur le fil principal, chargement du modèle compris.)*

## Les deux modes d'affichage : « ça se réécrit » n'est pas un bug
Le moteur produit **deux** textes : le `ruban` (stable — deux passes successives sont
tombées d'accord dessus, il ne bougera plus jamais) et le `provisoire` (la dernière
hypothèse, que la passe suivante a le droit de corriger).

Afficher le provisoire, **c'est** accepter que du texte déjà lu se réécrive sous les
yeux : « nouve. » devient « nouvelle », « rembobi. » devient « rembobiner ». Ce n'est
pas un défaut qu'on peut corriger — c'est la définition du mot « provisoire ».

D'où une **option**, et pas un remplacement : case « Afficher la fin provisoire » dans la
popup, **décochée par défaut**, rangée dans `chrome.storage.local` sous
`afficherProvisoire`.

- **Décochée (défaut) — stable seulement.** Le texte ne peut que s'allonger. Prix assumé :
  un mot n'apparaît qu'une fois confirmé, soit **une cadence de retard en plus**.
- **Cochée — avec la fin provisoire.** Plus réactif, mais les derniers mots se corrigent
  en direct.

⚠️ **La bascule est à chaud, et c'est le point important** : le choix se juge à l'œil, sur
la même vidéo et la même phrase — aucun redémarrage de capture, aucune recalibration.
`offscreen.js` **n'est pas au courant des modes** pour ce qu'il produit : il envoie
toujours `ruban` ET `provisoire`. C'est l'affichage qui tranche.

Les deux destinataires ne sont **pas** prévenus de la même façon, et ce n'est pas un
caprice (voir « `chrome.storage` est indisponible dans l'offscreen ») :
- `content.js` lit `chrome.storage` lui-même et écoute `storage.onChanged` — un content
  script y a accès ;
- `offscreen.js` est prévenu par **message** (`SET_PROVISOIRE` → `PROVISOIRE`), relayé par
  le service worker, exactement comme la langue et le retard.

Mesuré au banc, 2 min 10 s de parole continue (voir « Comment tester ») :

| | avec provisoire | stable seulement |
|---|---|---|
| mots déjà affichés qui **changent** | **50** | **0** |
| mots prononcés jamais affichés | 0 | 0 |
| écrans vides | 0 | 0 |
| âge du son affiché | 1,9 s | 3,2 s |

⚠️ **La dernière ligne date d'avant l'horloge des mots** (étape 2) : l'écran ajoute
désormais le retard d'affichage, mesuré au banc à 4,4 s avec provisoire et 6,4 s en
stable. Les trois premières lignes, elles, tiennent toujours. Et « mots déjà affichés qui
changent » devrait baisser en mode provisoire — un mot qui attend son heure a le temps
d'être corrigé avant d'apparaître : **4 → 1 sur le flux de 7 messages du banc de chaîne**.
Le run de 2 min 10 s n'a pas été refait, donc le « 50 » du tableau n'a pas d'équivalent
mesuré après l'étape 2.

Aucun mot n'est perdu en mode stable : c'est la **clôture de fenêtre** qui le garantit —
`figerFenetre` verse tout le provisoire dans le ruban quand la fenêtre se ferme, donc la
fin de phrase finit toujours par s'afficher.

## Le retard du son : DEUX valeurs, une par mode
Le retard audio aligne ce qu'on **entend** sur ce qu'on **lit**. La règle est la même dans
les deux modes — *on mesure l'âge du dernier mot réellement affiché* — mais ce mot n'est
pas le même :

- **avec provisoire** → le dernier mot est le bout de la fenêtre. Repère : `finAudioMs`.
- **stable seulement** → le dernier mot est le dernier **confirmé**. LocalAgreement-2 le
  borne par l'hypothèse *précédente* : un mot ne peut pas être confirmé s'il n'était pas
  déjà dans la passe d'avant. Repère : `finAudioPassePrecedente`.

L'écart entre les deux repères est exactement l'audio avalé entre deux passes — **une
cadence**. Mesuré : 1,8 s / 3,3 s sur machine normale (écart 1,5 s), 4,3 s / 8,3 s sur
machine lente simulée (écart 4,0 s).

Prendre `finAudioMs` dans les deux cas était le défaut : en mode stable on calait le son
sur la fin de la *fenêtre* alors que l'écran montrait du texte plus vieux d'une cadence,
donc le son passait systématiquement en avance sur le texte lu.

Les **deux** valeurs sont mesurées dans le même passage de calibration (les deux repères
vivent sur les mêmes passes) et mémorisées ensemble sous
`retardCalibreFluxParMode = { avecProvisoire, stable }`. Cocher la case recale donc le son
**tout de suite**, sans remesurer.

⚠️ **Le nom de la clé porte la génération, et ce n'est toujours pas cosmétique.** Une
valeur mémorisée par une génération précédente est fausse pour celle-ci, et comme elle
est mémorisée pour de bon elle ne serait jamais remesurée. Trois générations à ce jour :
`retardCalibre` (moteur par blocs, ~9 s), `retardCalibreFlux` (flux, un seul mode),
`retardCalibreFluxParMode` (l'actuelle). Les deux premières sont effacées dans
`onInstalled` — mais **le ménage n'est qu'un confort** : la vraie protection est que
`readRetardCalibre` ne lit que le nom courant, et refuse toute valeur qui n'a pas les deux
champs attendus. Vérifié au banc sur un storage contenant les trois clés.

## Le flux : une fenêtre qu'on re-transcrit, pas des blocs qu'on oublie
C'est le cœur du moteur, et c'est ce qui donne l'effet « sous-titres YouTube » : les mots
s'ajoutent au fil de la parole au lieu qu'une phrase entière saute toutes les 7 secondes.

**La propriété qui rend tout possible : Whisper complète TOUT extrait à 30 s avant de le
traiter.** Transcrire 4 s ou 11 s coûte donc presque pareil. Re-transcrire une phrase
depuis son début est quasi gratuit — et chaque passe a *plus* de contexte que la
précédente, jamais moins. C'est l'exact inverse du découpage en blocs, où chaque bloc
était aveugle à ce qui le précédait.

**La règle qui tient tout le reste : UNE SEULE INFÉRENCE EN VOL** (`passeEnVol`). Dès
qu'une passe rend son texte, on relance sur la fenêtre telle qu'elle est *à cet instant*.
Il n'y a donc aucune file d'attente, et la latence **ne peut pas** diverger : la cadence
s'adapte toute seule à la machine. Toute l'ancienne surveillance de file (`FILE_MAX`,
`segmentsAbandonnes`…) a disparu avec elle — c'était le remède à un mal que le moteur ne
produit plus.

**Stable / provisoire (LocalAgreement-2)** — c'est ce qui permet d'*ajouter* des mots
plutôt que de réécrire la phrase. Deux passes successives partagent presque tout leur
texte : leur **préfixe commun** n'a plus aucune raison de changer, on le verse dans le
`ruban` pour de bon. Ce qui suit reste `provisoire`, la passe suivante peut le corriger.
On **compare** des formes normalisées (sans accents ni ponctuation) mais on **affiche** le
mot d'origine.

Réglages (`offscreen.js`) :
- `FENETRE_MAX = 12` — au-delà on fige et on repart. Sans borne, Whisper tronquerait à
  30 s en perdant le début, sans rien dire.
- `MIN_NOUVEAU = 0,7` — audio neuf minimum avant de relancer (~un mot). Sans ce plancher
  on relancerait sur une fenêtre identique, et elle ne s'allongerait jamais.
- `RECOUVREMENT_FENETRE = 0,5` — la coupure à `FENETRE_MAX` tombe en plein mot.
- À la fermeture « fenêtre pleine », **on jette le dernier mot du provisoire** : il est
  coupé en deux, et le recouvrement le retranscrira entier. Sans ce tri, le demi-mot était
  figé pour de bon puis doublé (« apres une **pa. pause** et doit »).

Ce que ça a remplacé (`DUREE_MAX = 7`, `DUREE_MIN_ENVOI = 3`, `SILENCE_MAX`,
`RECOUVREMENT`) : des blocs transcrits **une fois** puis oubliés, dont le texte
*remplaçait* le précédent à l'écran.

Résultat mesuré au banc (voir « Comment tester ») : l'âge du son au moment de l'affichage
reste **plat** — 1,5 s sur machine normale, 4,0 s sur machine lente simulée — au lieu de
dériver (+0,3 s par seconde d'audio dans l'ancien moteur : 32 s de retard après 90 s). Le
ruban ne recule jamais, aucun mot prononcé n'est perdu.

⚠️ Le piège reste le même qu'avant : baisser les bornes « pour être plus réactif » dégrade
la latence *et* le texte. Sous ~5 s de contexte, whisper-tiny n'écoute plus, il récite les
phrases les plus fréquentes de son entraînement (« Thank you for watching »).

## Les instants : chaque mot connaît l'heure à laquelle il a été prononcé
**Le triangle impossible, d'abord.** Trois choses souhaitables, on ne peut en avoir que
deux : *(1)* le texte synchrone avec le son, *(2)* le son synchrone avec l'image, *(3)* la
transcription faite en direct depuis l'onglet. On ne peut pas transcrire un mot avant
qu'il soit prononcé : le mot dit à l'instant T n'existe en texte qu'à T + ~2 s. YouTube
n'a pas ce problème parce qu'il ne fait pas du direct — la vidéo est transcrite sur ses
serveurs *avant* d'être lue. **On abandonne donc le point 1** : le texte restera derrière
la voix. Ce qui est réparable, et complètement, c'est que ce retard soit **régulier**.

**La maladie que ça soigne.** `content.js` révélait les mots à cadence fixe
(`PAS_REVELATION`, 80 ms) parce qu'il savait *lesquels* mais pas *quand*. D'où des rafales
suivies de trous, sans rapport avec le rythme réel de la parole, et des silences qui
n'existaient pas à l'écran. Avec l'instant de chaque mot, l'affichage peut le sortir à
l'heure : parole rapide → texte rapide, pause → l'écran s'arrête.

### Ce que ça coûte : mesuré, pas supposé (2026-08-20, `test-bruit.html`)
| fenêtre | mots/passe | sans | avec | surcoût |
|---|---|---|---|---|
| 7 s | 11 | 2 201 ms | 2 276 ms | +3 % |
| 8 s | 13 | 1 924 ms | 2 153 ms | +12 % |
| 10 s | 15 | 1 932 ms | 2 227 ms | +15 % |
| 11 s | 17 | 2 013 ms | 2 409 ms | **+20 %** |
| 12 s | 20 | 2 100 ms | 2 504 ms | **+19 %** |

Le coût suit le **nombre de mots décodés**, pas la durée du son (Whisper complète tout
extrait à 30 s). Le seuil qu'on s'était donné pour renoncer était +40 % : on est à la
moitié. Et **rien ne s'accumule** — 14 passes consécutives du même worker sur le même
fragment, les deux courbes restent plates.

### La justesse des instants sous le bruit : intacte
| musique | signal/bruit | mots retrouvés | écart médian | p90 | instants non croissants |
|---|---|---|---|---|---|
| 0.2 | 4,3 dB | 100 % | 20 ms | 160 ms | 0 |
| 0.4 | **−1,8 dB** | 97 % | 20 ms | 180 ms | 0 |

À −1,8 dB la musique est *plus forte que la voix*, et les instants ne bougent que de
20 ms. Le bruit abîme le **mot**, pas l'**heure**.

### ⚠️ Deux pièges trouvés à la mesure, tous deux traités dans le code
- **Un mot peut être daté APRÈS la fin de la fenêtre.** Sur une fenêtre de 11 s, 9 mots
  au-delà de la fin, dont un à **+7,4 s** : Whisper complète l'extrait à 30 s et
  l'alignement place parfois la fin dans ce silence de remplissage. Un mot daté dans le
  futur ne s'afficherait jamais à l'heure — l'écran resterait figé à l'attendre. D'où le
  bornage dans `instantsAbsolus`.
- **Un « mot » de Whisper n'est pas un mot.** « J'adore, » arrive en **deux** morceaux,
  `" J"` puis `"'adore,"`. Ce qui distingue deux morceaux du même mot de deux mots
  différents, c'est **l'espace qui précède** — d'où le texte transmis **sans `.trim()`**
  par le worker. Trimmer effaçait la seule information permettant de recoller.

### Le chemin, maillon par maillon
1. `whisper.worker.js` demande `return_timestamps: "word"` **en production**
   (`?horodatage=non` désactive, pour les pages de mesure seulement). La signature du
   backend porte `|ts=word` : une mesure GPU/CPU faite sans horodatage ne vaut plus, elle
   est donc automatiquement refaite.
2. `offscreen.js` recolle les morceaux (`recollerMots`), convertit en heure absolue
   (`instantsAbsolus` : `finAudioMs - samples/TAUX` donne le début de fenêtre), borne, et
   garantit des instants croissants.
3. **LocalAgreement-2 n'a pas changé d'une ligne** : il compare toujours des mots,
   l'instant voyage à côté. `ruban` et `provisoire` sont devenus des **listes de
   `{mot, instant}`** — la chaîne est *dérivée*, pour qu'une troncature ne puisse pas
   désynchroniser les mots et leurs heures.
4. `FLUX` porte `rubanInstants` et `provisoireInstants`, un instant par mot.

**Garde-fou** : si le recollage ne redonne pas exactement les mots affichés, on renonce
aux instants **pour cette passe** (compteur `motsSansInstant`) plutôt que de les décaler
d'un cran. Un mot affiché à l'heure de son voisin serait pire que pas d'heure du tout.

### ⚠️ Le relais du service worker ne doit RIEN reconstruire
`sendFlux` prenait `(ruban, provisoire, finAudio)` et réassemblait un objet. Tout champ
ajouté par l'offscreen était donc **jeté là, en silence**. C'est arrivé : `finAudioStable`
— le repère du mode « stable seulement » — était produit et attendu, mais n'a jamais
traversé ; `content.js` retombait sur `finAudioStable || finAudio`, donc rien ne plantait
et seule la mesure d'âge du mode stable était fausse d'une cadence. **Un repli qui marche
est exactement ce qui rend ce genre de perte invisible.** `sendFlux` relaie désormais le
message entier.

## L'horloge des mots : `content.js` n'estime plus, il lit l'heure
`PAS_REVELATION = 80` et `RETARD_MAX_MOTS = 12` **ont disparu**, et c'est le signe que
l'étape 2 a fait son travail : c'étaient deux rustines pour compenser l'absence
d'horloge. Un seul réveil toutes les 50 ms, qui sort tout mot dont l'heure est venue.

`RETARD_MAX_MOTS` ne peut même plus avoir de raison d'être : un vieux mot porte un vieil
instant, son heure est passée depuis longtemps, il est visible immédiatement. Il n'y a
plus rien à « rattraper », donc plus rien à borner.

### ⚠️ Le retard d'affichage se cale sur le mot le plus ANCIEN en attente, pas le plus frais
C'est le point qui décide de tout, et il a été tranché au banc. Les mots n'arrivent pas un
par un : ils arrivent **par lots**, un lot couvrant une cadence de parole. Le plus ancien
d'un lot est donc plus vieux que le plus frais d'exactement une cadence — et si le retard
est calé sur le plus frais, tous les autres sont déjà en retard et sortent d'un bloc.

Mesuré sur une piste à rythme variable (rapide 180 ms/mot, **pause de 2 s**, lent
520 ms/mot) :

| | calé sur le plus frais | calé sur le plus ancien en attente |
|---|---|---|
| normale, stable | 30 ms d'écart, rafales de **5** | **20 ms, rafales de 1** |
| normale, provisoire | 180 ms, rafales de 4 | **20 ms, rafales de 1** |
| lente, provisoire | 300 ms, **pause perdue** | **20 ms, pause conservée** |

Prix assumé : **+1,5 s de retard à l'écran** (4,9 → 6,4 s en mode stable). C'est ce qu'il
en coûte pour que les mots sortent un par un au bon rythme au lieu de gicler par paquets.

Le retard n'est **pas** une constante : il est **observé** (percentile 90 des 20 derniers
lots, un jeu par mode), parce qu'il doit couvrir la latence du moteur — 2 s ici, 6 s sur
une machine lente, plus une cadence en mode stable. Une valeur écrite en dur serait juste
pour une machine et fausse pour toutes les autres.

**Vérifié dans Chrome, pas seulement au banc** : intervalles prononcés 200 / 1500 / 600 /
600 / 600 ms → affichés 196 / **1504** / 597 / 603 / 598 ms. La pause est restée une pause
à 4 ms près.

### La limite, et pourquoi on la choisit
`RETARD_MAX = 10 s`. Le retard nécessaire vaut ~2 cadences en mode provisoire et ~3 en
mode stable. Sur une machine à 6 s par passe, ça ferait 12 à 18 s — un sous-titre qui n'a
plus aucun rapport avec l'image. Au-delà du plafond on réaffiche donc par paquets :
moins beau, mais lisible. Sur la machine de référence (2,2 s par passe, ~6,6 s de besoin
en stable) le plafond ne mord pas.

*Effet de bord agréable, mesuré : en mode provisoire, les mots déjà lus qui se réécrivent
sont passés de 4 à 1 sur le même flux — un mot qui attend son heure a le temps d'être
corrigé avant d'être affiché.*

⚠️ **Conséquence pour le retard du son (étape 3)** : l'âge du texte affiché n'est plus
celui que `offscreen.js` calibre. La calibration mesure l'âge du mot **à son arrivée** ;
l'écran, lui, ajoute maintenant le retard d'affichage. `retardCalibreFluxParMode` sous-
estime donc l'âge réel. À reprendre à l'étape 3 — qui prévoit de toute façon de mettre le
retard du son à zéro par défaut.

## Mode « préparer d'abord » : trois défauts, une seule maladie (2026-08-28)

Le mode fait défiler la vidéo à x2 en silence, transcrit tout d'avance en blocs de 15 s,
puis affiche le stock à l'heure pendant la lecture normale. Trois symptômes ont été
rapportés — *l'overlay disparaît puis réapparaît d'un coup*, *des phrases entières
manquent*, *le texte est parfois faux*. **Ce sont trois façons de voir le même trou dans
le stock**, plus une désynchronisation qui s'y ajoute.

### 1. `CONFIRMÉ` — 60 jetons coupent le français au bout de 13 s

`whisper.worker.js` imposait `max_new_tokens = 60` à **tout le monde**. Cette valeur avait
été dimensionnée pour les segments de 7 s du mode direct ; la préparation, elle, envoie des
blocs de 15 s.

Mesure du 2026-08-28, tokenizer de `whisper-tiny` chargé en local :

| langue | mots | jetons | jetons/mot |
|---|---|---|---|
| français (documentaire) | 31 | 48 | **1,55** |
| français (conversation) | 33 | 51 | **1,55** |
| anglais (JFK) | 22 | 23 | 1,05 |

60 jetons valent donc **39 mots français**. Un bloc de 15 s ne tient sous ce plafond que si
on parle à **moins de 2,6 mots/s** — un documentaire est à ~3, une conversation à ~4. Au
delà, Whisper est coupé net **sans rien signaler** : le bloc rend un texte crédible qui
s'arrête au bout de 10 à 13 s, et les dernières secondes de *chaque* bloc n'ont aucun mot
dans le stock. C'est la source principale des trous.

Correctif : le plafond est un **paramètre du message `transcribe`** (`maxJetons`), borné à
400 côté worker. Le direct garde 60 ; la préparation demande `PREP_JETONS_PAR_S = 12`
jetons par seconde de contenu, soit 180 pour un bloc de 15 s (~7,7 mots français/s, le
double du débit le plus rapide). La protection anti-boucle ne repose plus sur le plafond
mais sur `no_repeat_ngram_size`, qui empêche la boucle de *commencer*.

*Ce qui prouverait que c'est faux* : des blocs qui, plafond levé, s'arrêtent toujours au
même endroit — ce serait Whisper qui renonce, pas le quota. Le détecteur de troncature de
`prepTraiterBloc` le dit maintenant à partir de 12 morceaux (au lieu de 30, seuil qui
n'avait de sens que sous l'ancien plafond).

### 2. `CONFIRMÉ` — la coupure des blocs tombait en plein mot

Contrairement au moteur en flux, **il n'y a aucun recouvrement** ici : chaque bloc est
transcrit une fois et jamais revu. Une coupure à l'échantillon près tombe donc là où elle
tombe — le plus souvent à l'intérieur d'un mot, qui est perdu deux fois (amputé à la fin
d'un bloc, amputé au début du suivant, où il donne en plus à whisper-tiny une attaque qui
ne ressemble à rien).

Correctif : `prepTailleJusquAuSilence` recule d'au plus **1,5 s de contenu** pour couper au
milieu de la tranche de 20 ms la moins bruyante. Le bloc est un peu plus court, jamais plus
long : rien n'est sauté, le reste part avec le bloc suivant.

Mesuré au banc (`banc-coupe.js`, bruit + un silence de 120 ms placé à un endroit connu) :

| silence à | coupure | résultat |
|---|---|---|
| −0,2 s | −0,15 s | dans le silence |
| −0,5 s | −0,45 s | dans le silence |
| −1,0 s | −0,95 s | dans le silence |
| −1,4 s | −1,35 s | dans le silence |
| −3,0 s | −0,93 s | hors de portée : coupure quelconque, comme avant |

⚠️ Le départage des ex æquo est `<=`, pas `<` : sur du silence pur toutes les tranches se
valent, et avec `<` le bloc se faisait raccourcir de 1,5 s **à chaque fois, pour rien**.

### 3. `CONFIRMÉ` — l'heure des mots était calculée, pas observée

L'instant d'un mot valait `positionDepart + échantillonsConsommés / taux × 2`. C'est de
l'arithmétique : elle suppose que la vidéo avance d'exactement deux secondes par seconde
d'horloge, du début à la fin. Un rechargement de tampon, une publicité, un lecteur qui
reprend une seconde la main sur la vitesse (`content.js` en accepte jusqu'à
`PREP_RECALAGES_MAX`), et la capture continue d'empiler du son pendant que `currentTime`
n'avance pas. **L'écart ne se rattrape jamais, il s'ajoute** — et du texte juste affiché au
mauvais moment se lit exactement comme une transcription fausse.

Correctif : `content.js` envoie la position réelle de la vidéo à **chaque battement**
(500 ms) ; `offscreen.js` garde la table `prepAncres` (« autant d'échantillons captés ↔ la
vidéo en était là ») et **interpole** l'heure de chaque mot dedans.

Mesuré au banc Node/vm (`banc-ancres.js`, capture simulée de 120 s, un calage de 6 s au
milieu — la vidéo s'arrête, la capture continue) :

| | avant | après |
|---|---|---|
| sans incident, écart max | 0,17 s | 0,17 s |
| calage 6 s — écart sur les **deux derniers** blocs | **12,17 s** | **0,06 s** |

12 s et pas 6 : pendant 6 s d'horloge la vidéo aurait avancé de 12 s de contenu. Avec
l'ancien calcul ce décalage restait jusqu'à la fin de la vidéo ; avec la table il a disparu
dès le bloc suivant. (Dans le bloc qui *contient* le calage, l'écart reste grand des deux
côtés : le silence du calage n'a de toute façon pas de mots à placer.)

Au passage : la position de départ du stock est maintenant relevée **après** `play()`
(`positionDepart`), pas avant (`position`, qui sert à rendre le lecteur tel qu'on l'a
trouvé). Les confondre datait tout le stock trop tôt du temps de démarrage du lecteur.

### 4. L'overlay qui disparaît : le symptôme, traité en symptôme

`BLOC_APRES_PAROLE` efface la boîte quand un sous-titre a fait son temps sans que le
suivant soit là. C'est **volontaire** — un sous-titre qui traîne pendant qu'on parle a l'air
de fonctionner, ce qui est pire qu'une absence. Mais deux choses le rendaient brutal :

- la valeur, **1,5 s**, avait été choisie contre des trous de 13,5 s dus au plafond de
  jetons (défaut 1). Ce plafond levé, les trous restants sont des respirations : la tenue
  passe à **3 s** ;
- l'effacement se faisait par `display: none`, qui **ne se transitionne pas** — la boîte
  disparaissait d'une image à l'autre, ce qui se lit comme une panne. Elle s'efface
  maintenant par l'**opacité**, avec un fondu de 220 ms posé sur la boîte (et
  `pointer-events: none`, pour qu'une boîte invisible n'intercepte pas les clics).

⚠️ Si l'écran continue de se vider souvent après tout ça, **ce n'est plus l'affichage** :
c'est qu'il reste des trous dans le stock. `PREPARATION_BLOCS` rend `ecranVideS` — le temps
total sans aucun sous-titre — et c'est cette mesure-là qu'il faut regarder, pas l'écran.

## Contraintes techniques connues
- ⚠️ **`chrome.storage` est indisponible dans un document offscreen.** Vérifié dans
  Chrome : `typeof chrome === "object"` mais `typeof chrome.storage === "undefined"`.
  Tout ce qui touche au storage passe donc par le service worker — c'est déjà le cas du
  backend, de la langue et du retard, et ça vaut aussi pour le mode d'affichage.

  **Ce que ça coûte quand on l'oublie** (arrivé une fois, à ne pas refaire) : un
  `chrome.storage.onChanged.addListener` ajouté dans `offscreen.js` lève un `TypeError`
  **au chargement**. Le fichier meurt à cette ligne : tout ce qui suit n'est jamais évalué,
  et les `let` déclarés plus bas restent en zone morte. Le listener de messages, lui, était
  déjà enregistré — donc `START_CAPTURE` arrive, `startCapture` rejette, et comme la
  réponse était branchée en `.then(sendResponse)` **sans `.catch`**, `sendResponse` n'est
  jamais appelé. Le service worker attend sa réponse indéfiniment, la popup reste sur
  « Démarrage… », et **rien n'apparaît nulle part** : ni erreur, ni échec, ni délai. Le
  bouton Démarrer ne répond plus.

  D'où deux règles : *(1)* l'offscreen ne touche jamais `chrome.storage` ; *(2)* tout
  `return true` dans un `onMessage` doit avoir un `.catch` qui répond — sinon la moindre
  erreur devient un blocage muet.
- CSP MV3 : `wasm-unsafe-eval` requis pour le WASM ; les workers `blob:` sont bloqués
  → `numThreads = 1` et `proxy = false`.
- Whisper : `dtype: "fp32"`, **sur les deux backends**. Choix mesuré, pas par défaut —
  voir le long commentaire dans `whisper.worker.js`. En résumé :
  - Si un export quantifié refuse de charger (`Missing required scale ... MatMulNBits`
    pour q8, `SimplifiedLayerNormFusion` pour fp16), **ce ne sont pas les poids** : ce
    sont des passes de fusion de niveau `extended` d'ONNX Runtime. Avec
    `session_options: { graphOptimizationLevel: "basic" }`, les deux chargent et
    transcrivent.
  - q8 marche donc (42 Mo au lieu de 147, ~18 % plus rapide) mais **dégrade le texte**
    en conditions réelles : « What **you are** country » au lieu de « What **your**
    country », « as what » au lieu de « ask what ». Comme la latence est déjà stable
    en fp32, ces 18 % n'achètent rien. Écarté.
  - fp16 sur CPU est 1,3 à 1,4× **plus lent** que fp32 (pas d'unité fp16 native).
  - En WebGPU, `fp16` / `q4f16` **chargent mais produisent du texte cassé** (boucles de
    répétition « Je ne m'aime pas. Je ne m'aime pas… »). Ne jamais valider une variante
    sur le seul chargement : toujours lire la sortie, et sur des fragments courts, pas
    seulement sur un extrait propre (q8 donne 0 % de WER sur extrait propre et se
    dégrade quand même en production).
  - Piste si le poids devient critique (modèle embarqué) : **whisper-base en q8**, 77 Mo,
    soit moins que tiny fp32, et moins sujet aux hallucinations. À mesurer.
- WebGPU (ONNX Runtime 1.26) passe par la variante WASM `asyncify` (ou `jspi`), **pas**
  par `jsep` comme dans les versions 1.19–1.21. Les 4 variantes sont copiées dans
  `vendor/`, laisser comme ça.
- `chrome.*` est **indisponible dans un worker dédié** : dériver les URL de
  `self.location`, et laisser la page faire ce qui touche à `chrome.storage`.
- Le service worker est éphémère : toujours re-vérifier l'état réel via
  `chrome.offscreen.hasDocument()` et `chrome.storage.session`.

## Comment tester
Recharger l'extension (`chrome://extensions` → 🔄) puis la page (F5). Console du
service worker : « Inspecter les vues → service worker ». Console du VAD/capture :
« Inspecter les vues → **offscreen.html** ». Test Whisper isolé : ouvrir
`chrome-extension://<ID>/test-whisper.html`. (Voir la skill `tester-extension`.)

**Sans Chrome** : `offscreen.js` et `content.js` se chargent tels quels dans un contexte
`vm` de Node avec des bouchons (`chrome`, `Worker`, DOM, `Date.now`), ce qui permet de
jouer une piste de parole simulée trame par trame sur une horloge virtuelle et de mesurer
le moteur pour de vrai — dérive de latence, ruban qui recule, mots perdus, demi-mots
figés, mots révélés un par un. Voir la mémoire `banc-essai-node-vm`. Ça ne remplace pas
Chrome pour la latence réelle, la qualité du texte, le VAD et WebGPU.

⚠️ **Une séance de mesure s'use, et le témoin le prouve.** Après une vingtaine de workers
instanciés (147 Mo de poids chacun), le même fragment passe de **2,1 s à 7,7 s** — y
compris pour la variante *sans* la fonctionnalité mesurée. Recharger la page ne répare
rien : c'est la machine entière qui est descendue. C'est comme ça qu'un surcoût
d'horodatage a été mesuré à **+71 %** puis à **+19 %** sur exactement le même audio. Donc :
ne jamais comparer deux chiffres absolus pris à des moments différents ; faire tourner les
deux variantes **alternées fragment par fragment** et ne conclure que sur le **rapport**.
Si le témoin lui-même a dérivé, la séance est finie — redémarrer avant de mesurer autre
chose.

⚠️ **Un banc Node ne prouve rien sur ce que le navigateur rend disponible.** Le bouchon
`chrome` du banc est écrit à la main : s'il offre `chrome.storage` à `offscreen.js`, le
banc passe au vert sur du code que Chrome refuse. C'est exactement comme ça que le bug
ci-dessus est passé. Les bouchons doivent **ressembler à la réalité, pas la rendre
confortable** — celui de l'offscreen n'a donc plus de `chrome.storage` du tout. Et toute
modif qui touche au démarrage se vérifie **dans Chrome, popup réel ouvert**, pas seulement
au banc.

Le banc le plus utile est celui **en deux temps** : on fait tourner le moteur une fois, on
enregistre la suite exacte des messages `FLUX`, puis on la **rejoue dans deux instances de
`content.js`** — une par mode. Les deux modes voient alors rigoureusement le même flux, ce
qui rend la comparaison honnête (mots réécrits, mots perdus, âge du son). C'est comme ça
que le tableau des deux modes plus haut a été obtenu, et c'est là qu'on injecte une
bascule de la case en plein milieu du run pour vérifier qu'elle ne perd ni mot ni image.

## Avancement
- ✅ Structure de l'extension (popup, overlay, messages).
- ✅ Capture audio de l'onglet + VAD (segments de parole), avec état popup robuste.
- ✅ Whisper dans un Web Worker (la page ne fige plus) + choix mesuré du backend
  GPU/CPU, mémorisé.
- ✅ Segments du VAD branchés au worker puis à l'overlay : la chaîne complète tourne.
- ✅ Découpage réglé (7 s / plancher 3 s / recouvrement) : latence stable au lieu de
  dériver jusqu'à 32 s, et plus d'hallucinations.
- ✅ **Mode flux** : fenêtre re-transcrite + LocalAgreement-2 + une seule inférence en vol,
  overlay qui révèle les mots un par un sur deux lignes. Les sous-titres s'écrivent au fil
  de la parole. Voir « Le flux » plus haut.
- ✅ **Option « texte stable seulement »** (défaut) : plus rien ne se réécrit sous les yeux,
  bascule à chaud pour comparer. Retard du son calibré par mode. Voir les deux sections
  dédiées plus haut.
- ✅ **Étape 0 — chiffrer avant de s'engager** : coût des horodatages (+20 %, sous le seuil
  de renoncement de 40 %), absence de dérive sur 14 passes, justesse des instants sous
  musique (20 ms à −1,8 dB). Page `test-bruit.html`.
- ✅ **Étape 1 — les instants voyagent** : worker → offscreen → service worker → `FLUX`.
  Chaque mot porte l'heure à laquelle il a été prononcé. Voir « Les instants » plus haut.
- ✅ **Étape 2 — `content.js` affiche à l'heure** : `PAS_REVELATION` et `RETARD_MAX_MOTS`
  ont disparu, les mots sortent un par un au rythme réel, les pauses redeviennent des
  pauses. Voir « L'horloge des mots » plus haut.
- ✅ **Mode « préparer d'abord » — les trois trous bouchés** : plafond de jetons dimensionné
  sur le bloc, coupure au silence, heure des mots lue sur la vidéo au lieu d'être calculée.
  Voir la section dédiée plus haut. ⚠️ Validé **au banc Node/vm uniquement** — la coupure au
  silence et le plafond de jetons demandent une vérification sur du son réel dans Chrome
  (couverture par bloc, `ecranVideS`).
- ⬜ **Étape 3 — retard du son à zéro par défaut** : garder les lèvres synchrones et
  laisser le texte suivre à ~2-3 s, comme les sous-titres du direct à la télé. L'option
  « Auto » reste pour qui préfère l'inverse.
- ⬜ Traduction, personnalisation de l'overlay, historique/export, hors-ligne complet
  (bundler le modèle).
- ⬜ **Qualité du texte sur son BRUITÉ** — le reproche qui reste. whisper-base a été écarté
  sur une mesure faite sur du son *propre* (WER 0 %, donc aucun gain à espérer), mais le
  problème se pose sur du son bruité (documentaire avec musique : « lourire » pour
  « nourrir »). Cette condition n'a jamais été mesurée : la décision a été prise sur les
  mauvaises données. À reprendre — tiny/base/small × trois niveaux de musique.
- ⬜ Pistes de latence non explorées : multithread WASM (on est à `numThreads = 1` à
  cause des workers `blob:` bloqués par la CSP — 2 à 3× à gagner si on débloque). Ça se
  verrait directement : moins de temps par passe = mots révélés plus tôt.

## Débogage — les trois consoles

Une extension MV3 n'a pas une console mais TROIS, et elles ne se voient pas entre elles :

| console          | ce qui s'y écrit                                    |
|------------------|-----------------------------------------------------|
| l'onglet         | `content.js` (l'overlay)                            |
| service worker   | `background.js`                                     |
| offscreen.html   | `offscreen.js`, le VAD, Whisper, la capture         |

⚠️ **Le document offscreen n'apparaît PAS comme cible DevTools** dans une session pilotée.
C'est pourtant là que vivent les erreurs les plus graves — celle de `chrome.storage` avait
tout cassé en silence. Ses messages importants doivent donc remonter au service worker,
préfixés `[OFFSCREEN]`. Côté humain, il reste inspectable à la main :
chrome://extensions → « Inspecter les vues : offscreen.html ».

**RÈGLE : ne jamais dire « aucune erreur » sans préciser sur quelle cible on était
branché.** Une console propre ne prouve rien sur les deux autres.

Et sur chrome://extensions, le bouton « Erreurs » n'apparaît que si le **mode développeur**
est activé. Sans lui, une absence d'erreur ne prouve rien du tout.

## Quand quelque chose casse — la forme de réponse attendue

1. **LA CAUSE, pas le symptôme.** « Ça ne s'affiche pas » n'est pas une cause ; « le
   message n'arrive jamais parce que le relais reconstruit l'objet et jette les champs
   ajoutés » en est une.

2. **Les solutions possibles, classées par niveau de confiance :**
   - `CONFIRMÉ` — j'ai la preuve, la voici
   - `PROBABLE` — cohérent avec les faits, voici lesquels
   - `HYPOTHÈSE` — je n'ai rien pour trancher

3. **Pour chacune : qu'est-ce qui prouverait qu'elle est FAUSSE ?**

⛔ **Pas de pourcentage inventé.** « 80 % de chances » sans mesure est une fausse
précision, et c'est pire que « je ne sais pas ».

⚠️ **Une barre de progression n'est pas une preuve de travail.** Elle ne prouve que
l'écoulement du temps. Vécu : la pompe de transcription se tuait elle-même (le `finally`
d'une fonction `async` s'exécutait avant l'affectation de la promesse), plus aucun bloc
n'était transcrit — et la barre avançait normalement jusqu'au bout.
