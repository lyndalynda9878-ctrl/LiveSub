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
l'onglet) → **VAD** découpe la parole en segments → *[à venir : brancher les segments]*
→ `whisper.worker.js` transcrit (Web Worker, GPU ou CPU selon la mesure) → *[à venir :
`content.js` affiche l'overlay]*.

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

## Contraintes techniques connues
- CSP MV3 : `wasm-unsafe-eval` requis pour le WASM ; les workers `blob:` sont bloqués
  → `numThreads = 1` et `proxy = false`.
- Whisper : `dtype: "fp32"`, **sur les deux backends**. Les exports quantifiés de
  `Xenova/whisper-tiny` échouent avec cette version d'ONNX Runtime
  (`Missing required scale ... MatMulNBits`), et en WebGPU les variantes `fp16` /
  `q4f16` **chargent mais produisent du texte cassé** (boucles de répétition du type
  « Je ne m'aime pas. Je ne m'aime pas… »). Ne pas y revenir sans re-tester la sortie,
  pas seulement le chargement.
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
- 🔵 Whisper : **brancher les segments du VAD** vers le worker, puis vers l'overlay.
- ⬜ Traduction, personnalisation de l'overlay, historique/export, optimisation de la
  latence, hors-ligne complet (bundler le modèle).
