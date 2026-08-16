---
name: extension-vendor-lib
description: >
  Ajouter une librairie JavaScript (npm) à l'extension Chrome MV3 LiveSub en 100 %
  local, sans CDN. À utiliser dès qu'on veut intégrer une nouvelle librairie
  (modèle IA, moteur ONNX, lib de traitement audio, etc.) : copie dans vendor/,
  chargement local UMD ou ESM, CSP WebAssembly, chemins d'assets, variantes WASM.
---

# Ajouter une librairie locale à l'extension (sans CDN)

## Pourquoi
LiveSub doit fonctionner **100 % en local et hors ligne** : **aucun CDN**, aucun
script distant. Toute librairie npm doit être copiée dans le projet et chargée depuis
`vendor/`. La CSP d'une extension MV3 interdit les scripts distants et bloque le WASM
par défaut. Ce document capture le pattern éprouvé (VAD + Transformers.js).

## Procédure

1. **Installer** : `npm install <lib>`.

2. **Copier les fichiers dans `vendor/`** via `scripts/copy-assets.js` (lancé
   automatiquement par le `postinstall` de `package.json`). Ajouter la nouvelle lib à
   ce script. Ne JAMAIS dépendre de `node_modules/` au runtime : l'extension n'y a
   pas accès.

3. **Charger la lib localement** (jamais par `<script src="https://cdn...">`) :
   - **Lib UMD** (expose un global, ex : VAD `bundle.min.js` → `self.vad`) :
     `<script src="vendor/<lib>/bundle.min.js"></script>` AVANT le script qui
     l'utilise.
   - **Lib ESM** (ex : Transformers.js) : `import { ... } from
     "./vendor/<lib>/xxx.min.js"` dans un `<script type="module">`. Pour
     Transformers.js, utiliser **`transformers.min.js`** et PAS `transformers.web.js`
     (imports onnxruntime non résolus, destinés à un bundler).

4. **Autoriser le WebAssembly dans `manifest.json`** :
   ```json
   "content_security_policy": {
     "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
   }
   ```

5. **Pointer les chemins d'assets vers `vendor/`** (sinon la lib va chercher sur un
   CDN) :
   - ONNX Runtime / Transformers.js :
     `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/<lib>/")`
   - VAD : `baseAssetPath` + `onnxWASMBasePath` = `chrome.runtime.getURL("vendor/")`

6. **Copier TOUTES les variantes du runtime WASM** d'onnxruntime-web
   (`ort-wasm-simd-threaded.wasm`, `.mjs`, et les variantes `asyncify` / `jsep` /
   `jspi`). ONNX Runtime choisit la sienne à l'exécution par détection de capacités :
   s'il en manque une → erreur **« no available backend found »**.

7. **Un seul thread** : `numThreads = 1` et `proxy = false`. ONNX Runtime crée ses
   workers depuis des `blob:` URLs, **bloquées par la CSP MV3**.
   - Transformers.js :
     `env.backends.onnx.wasm.numThreads = 1; env.backends.onnx.wasm.proxy = false;`
   - VAD : `ortConfig: (ort) => { ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; }`

## Pièges connus
- **Pas de CDN** (hors-ligne + la CSP bloque les scripts distants).
- CSP sans `wasm-unsafe-eval` → le WASM est bloqué silencieusement.
- Variante WASM manquante → « no available backend found ».
- Transformers.js : `transformers.web.js` casse dans le navigateur → utiliser
  `transformers.min.js`.
- Certains exports **quantifiés** échouent avec l'ONNX Runtime embarqué
  (`Missing required scale ... MatMulNBits`) → utiliser `dtype: "fp32"`, ou tester les
  exports `onnx-community/*` (plus récents, quantification compatible).
- Garder `vendor/` dans `.gitignore` et le régénérer via `scripts/copy-assets.js`
  (postinstall).

## Vérifier
Recharger l'extension (`chrome://extensions` → 🔄), ouvrir la console du contexte
concerné (offscreen : « Inspecter les vues → offscreen.html »), et confirmer : pas
d'erreur CSP, pas de « no available backend found », la lib se charge et fonctionne.
