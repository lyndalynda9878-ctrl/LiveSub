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
// Transformers.js a son propre ONNX Runtime, d'une version differente de celle
// du VAD, avec des fichiers qui portent LE MEME NOM. D'ou un sous-dossier
// dedie : melanger les deux jeux de .wasm casserait l'un ou l'autre.
const VENDOR_TRANSFORMERS = path.join(VENDOR, "transformers");

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

// Transformers.js : le bundle web (ESM) + le runtime WebAssembly qu'il charge
// dynamiquement. Sans ces .wasm en local, la librairie irait les chercher sur
// le CDN jsdelivr -- ce qu'on ne veut pas (objectif hors-ligne).
//
// Le .wasm doit venir de l'onnxruntime-web imbrique SOUS @huggingface/transformers,
// pas de celui du VAD : ce sont deux versions differentes, et un .wasm depareille
// echoue au chargement.
const TRANSFORMERS_DIST = "@huggingface/transformers/dist";
const TRANSFORMERS_ORT_DIST =
  "@huggingface/transformers/node_modules/onnxruntime-web/dist";

const TRANSFORMERS_FILES = [
  // La librairie elle-meme (module ES autonome).
  // Bien prendre transformers.min.js et PAS transformers.web.js : cette
  // derniere version laisse des imports non resolus ("onnxruntime-web/webgpu")
  // destines a un bundler, que le navigateur refuse. transformers.min.js
  // embarque ONNX Runtime et se charge directement.
  [`${TRANSFORMERS_DIST}/transformers.min.js`, "transformers.min.js"],
  // Le runtime WASM, dans ses 4 variantes.
  // ONNX Runtime choisit laquelle charger au demarrage, par detection des
  // capacites du navigateur (jspi si disponible, sinon asyncify ; jsep pour
  // WebGPU). Comme le choix se fait a l'execution, on les fournit toutes :
  // s'il en manque une, le chargement echoue avec "no available backend found".
  ...["", ".jsep", ".asyncify", ".jspi"].flatMap((variante) => [
    [
      `${TRANSFORMERS_ORT_DIST}/ort-wasm-simd-threaded${variante}.mjs`,
      `ort-wasm-simd-threaded${variante}.mjs`,
    ],
    [
      `${TRANSFORMERS_ORT_DIST}/ort-wasm-simd-threaded${variante}.wasm`,
      `ort-wasm-simd-threaded${variante}.wasm`,
    ],
  ]),
];

function copyInto(destDir, files, label) {
  fs.mkdirSync(destDir, { recursive: true });

  for (const [from, to] of files) {
    const src = path.join(ROOT, "node_modules", from);
    const dest = path.join(destDir, to);

    if (!fs.existsSync(src)) {
      throw new Error(`Fichier source introuvable : ${src}`);
    }

    fs.copyFileSync(src, dest);

    const sizeKo = Math.round(fs.statSync(dest).size / 1024);
    console.log(`  ✅ ${label}${to} (${sizeKo} Ko)`);
  }
}

console.log("📦 Copie des assets du VAD vers vendor/ ...");
checkOrtVersion();
copyInto(VENDOR, FILES, "vendor/");
console.log("✅ Assets du VAD prets.");

console.log("📦 Copie de Transformers.js vers vendor/transformers/ ...");
copyInto(VENDOR_TRANSFORMERS, TRANSFORMERS_FILES, "vendor/transformers/");
console.log("✅ Assets de Transformers.js prets.");
