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
l'onglet) → **VAD** découpe la parole en segments (voir « Découpage » plus bas) →
`whisper.worker.js` transcrit (Web Worker, GPU ou CPU selon la mesure) → `background.js`
relaie (l'offscreen n'a pas accès à `chrome.tabs`) → `content.js` affiche l'overlay.

## Fichiers
- `manifest.json` — MV3 ; permissions (storage, tabCapture, activeTab, offscreen) ;
  CSP avec `wasm-unsafe-eval`.
- `background.js` — service worker : orchestre la capture, gère l'offscreen, stocke
  l'état dans `chrome.storage.session`. ⚠️ Le SW est tué régulièrement → ne jamais
  stocker l'état dans une simple variable mémoire.
- `popup.html` / `popup.js` — bouton Démarrer/Arrêter ; demande l'état au background
  (`GET_STATE`), ne le devine pas.
- `content.js` — injecte l'overlay de sous-titres dans la page.
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

## Découpage des segments : la longueur fait TOUT
**Whisper complète tout extrait à 30 s avant de le traiter.** Un segment de 2,5 s lui
coûte donc presque autant qu'un de 7 s (~1,4 s de calcul). Cette seule propriété
explique les deux défauts qu'on a eus, et leur correction.

Avant (`DUREE_MAX = 2,5 s`, plancher `0,4 s`) :
- **Latence divergente** : une inférence toutes les ~2,5 s pour ~1,4 s de calcul, plus
  les segments fermés en avance par les silences → la file ne se vidait jamais. Mesuré :
  +0,3 s de retard par seconde d'audio (5 s de retard après 10 s, **32 s après 90 s**).
- **Hallucinations** : sous ~5 s, whisper-tiny manque de contexte et sort les phrases les
  plus fréquentes de son entraînement — « Thank you for watching », « don't forget to
  subscribe », « I'm gonna kill you ». Ce ne sont pas des erreurs d'écoute.

Après, trois réglages qui vont ensemble (`offscreen.js`) :
- `DUREE_MAX = 7` — borne le haut. Divise le nombre d'inférences par ~3 **à coût unitaire
  identique**.
- `DUREE_MIN_ENVOI = 3` + `SILENCE_MAX = 1,5` — bornent le BAS. Quand le VAD ferme sur un
  silence et que le segment est court, on ne l'envoie pas : on attend que la phrase
  reprenne et on recolle. Sans ce plancher, allonger `DUREE_MAX` ne sert à rien — c'était
  encore la moitié des sous-titres.
- `RECOUVREMENT = 0,5` — la coupure à `DUREE_MAX` tombe en plein mot ; on garde la fin du
  segment comme début du suivant.

Résultat mesuré (même audio, même protocole) : latence **stable à ~2 s** au lieu de
dériver, et plus une seule hallucination.

⚠️ Attention en modifiant ces valeurs : baisser `DUREE_MAX` « pour être plus réactif » est
le piège — ça dégrade la latence *et* le texte.

## Contraintes techniques connues
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

## Avancement
- ✅ Structure de l'extension (popup, overlay, messages).
- ✅ Capture audio de l'onglet + VAD (segments de parole), avec état popup robuste.
- ✅ Whisper dans un Web Worker (la page ne fige plus) + choix mesuré du backend
  GPU/CPU, mémorisé.
- ✅ Segments du VAD branchés au worker puis à l'overlay : la chaîne complète tourne.
- ✅ Découpage réglé (7 s / plancher 3 s / recouvrement) : latence stable à ~2 s au lieu
  de dériver jusqu'à 32 s, et plus d'hallucinations. Voir « Découpage » plus haut.
- ⬜ Traduction, personnalisation de l'overlay, historique/export, hors-ligne complet
  (bundler le modèle).
- ⬜ Pistes de latence non explorées : multithread WASM (on est à `numThreads = 1` à
  cause des workers `blob:` bloqués par la CSP — 2 à 3× à gagner si on débloque),
  fusion des segments en attente si la file grandit malgré tout.
