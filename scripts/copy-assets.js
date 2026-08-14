// Copie les fichiers de la librairie VAD depuis node_modules vers vendor/.
//
// Pourquoi ? Une extension Chrome ne sait pas resoudre un nom de package npm
// (@ricky0123/vad-web) : elle ne charge que des fichiers presents dans son
// propre dossier. Et @ricky0123/vad-web va chercher son worklet, son modele
// .onnx et les .wasm d'ONNX Runtime a l'URL qu'on lui donne (baseAssetPath /
// onnxWASMBasePath) -- ces fichiers doivent donc etre dans l'extension.
//
// Lance automatiquement apres `npm install` (script postinstall).

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const VENDOR = path.join(ROOT, "vendor");

// Version d'ONNX Runtime Web inlinee dans @ricky0123/vad-web/dist/bundle.min.js.
// Le fichier .wasm et sa glue .mjs sont apparies a cette version precise :
// prendre ceux d'une autre version fait echouer le chargement du modele.
const EXPECTED_ORT_VERSION = "1.22.0";

const FILES = [
  // Le bundle UMD de la librairie VAD (il expose self.vad).
  ["@ricky0123/vad-web/dist/bundle.min.js", "bundle.min.js"],
  // L'AudioWorklet qui reechantillonne l'audio en 16 kHz.
  ["@ricky0123/vad-web/dist/vad.worklet.bundle.min.js", "vad.worklet.bundle.min.js"],
  // Le modele de detection de parole (Silero VAD v5).
  ["@ricky0123/vad-web/dist/silero_vad_v5.onnx", "silero_vad_v5.onnx"],
  // Le moteur WebAssembly qui fait tourner le modele.
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.mjs"],
  ["onnxruntime-web/dist/ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.wasm"],
];

function checkOrtVersion() {
  const pkgPath = path.join(ROOT, "node_modules", "onnxruntime-web", "package.json");

  if (!fs.existsSync(pkgPath)) {
    throw new Error(
      "onnxruntime-web est introuvable dans node_modules. Lance `npm install`."
    );
  }

  const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;

  if (version !== EXPECTED_ORT_VERSION) {
    console.warn("");
    console.warn("⚠️  ATTENTION : version d'ONNX Runtime Web inattendue.");
    console.warn(`   Installee : ${version}`);
    console.warn(`   Attendue  : ${EXPECTED_ORT_VERSION}`);
    console.warn(
      "   bundle.min.js de @ricky0123/vad-web embarque le JS d'ORT " +
        `${EXPECTED_ORT_VERSION}. Avec un .wasm d'une autre version, le`
    );
    console.warn(
      "   chargement du modele echouera avec une erreur obscure. " +
        `Epingle "onnxruntime-web": "${EXPECTED_ORT_VERSION}" dans package.json.`
    );
    console.warn("");
  }
}

function copyAssets() {
  fs.mkdirSync(VENDOR, { recursive: true });

  for (const [from, to] of FILES) {
    const src = path.join(ROOT, "node_modules", from);
    const dest = path.join(VENDOR, to);

    if (!fs.existsSync(src)) {
      throw new Error(`Fichier source introuvable : ${src}`);
    }

    fs.copyFileSync(src, dest);

    const sizeKo = Math.round(fs.statSync(dest).size / 1024);
    console.log(`  ✅ vendor/${to} (${sizeKo} Ko)`);
  }
}

console.log("📦 Copie des assets du VAD vers vendor/ ...");
checkOrtVersion();
copyAssets();
console.log("✅ Assets du VAD prets.");
