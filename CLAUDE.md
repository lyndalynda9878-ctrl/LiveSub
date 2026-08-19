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
