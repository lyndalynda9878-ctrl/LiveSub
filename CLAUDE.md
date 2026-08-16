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
l'onglet) → **VAD** découpe la parole en segments → *[à venir : worker Whisper
transcrit]* → *[à venir : `content.js` affiche l'overlay]*.

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
- `test-whisper.html` / `test-whisper.js` — page de test isolée : prouve que Whisper
  transcrit (Transformers.js, `Xenova/whisper-tiny`, `dtype: "fp32"`).

## Dépendances
- `@ricky0123/vad-web` — détection de parole (VAD).
- `@huggingface/transformers` — Whisper (transcription).
- `onnxruntime-web` — moteur d'exécution des modèles.

## Contraintes techniques connues
- CSP MV3 : `wasm-unsafe-eval` requis pour le WASM ; les workers `blob:` sont bloqués
  → `numThreads = 1` et `proxy = false`.
- Whisper : `dtype: "fp32"` (les exports quantifiés de `Xenova/whisper-tiny` échouent
  avec cette version d'ONNX Runtime ; piste `onnx-community/*` pour plus tard).
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
- 🔵 Whisper : transcrit des extraits (fait) → **à mettre dans un Web Worker** →
  WebGPU → brancher les segments du VAD vers Whisper puis l'overlay.
- ⬜ Traduction, personnalisation de l'overlay, historique/export, optimisation de la
  latence, hors-ligne complet (bundler le modèle).
