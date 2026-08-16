// Web Worker de transcription : Whisper tourne ICI, pas sur le fil principal.
//
// Avant, l'inference se faisait dans la page et la figeait ~12 s (le WASM
// d'ONNX Runtime est synchrone : tant qu'il calcule, la page ne repeint plus,
// ne scrolle plus, ne repond plus). En le deplacant dans un worker, le fil
// principal reste libre : c'est tout l'objet de ce fichier.
//
// Worker de type "module" (`new Worker(url, { type: "module" })`), pour pouvoir
// faire un `import` ES de Transformers.js.

// Import local depuis vendor/, jamais un CDN (CSP de l'extension + hors-ligne).
// Le chemin est relatif a CE fichier, qui est a la racine de l'extension.
import { pipeline, env } from "./vendor/transformers/transformers.min.js";

// ---------------------------------------------------------------------------
// Configuration de Transformers.js -- identique a celle qui marchait dans la page
// ---------------------------------------------------------------------------

// Ou trouver ort-wasm-simd-threaded.wasm. Sans ca, la librairie va le chercher
// sur le CDN jsdelivr : on veut des fichiers locaux.
//
// On derive l'URL de self.location (= .../whisper.worker.js) plutot que
// d'appeler chrome.runtime.getURL() : les API chrome.* ne sont pas garanties
// dans un worker dedie, alors que self.location l'est toujours.
env.backends.onnx.wasm.wasmPaths = new URL("./vendor/transformers/", self.location.href).href;

// Un seul thread : ONNX Runtime cree ses workers depuis des blob: URLs, que la
// CSP d'une extension MV3 bloque. Meme contrainte que pour le VAD.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

// Le modele n'est pas dans l'extension : on le telecharge depuis Hugging Face
// (Chrome le met ensuite en cache). Le passer en local viendra plus tard.
env.allowLocalModels = false;
env.allowRemoteModels = true;

// whisper-tiny MULTILINGUE (surtout pas la variante .en, qui ne fait que
// l'anglais : LiveSub doit sous-titrer du francais).
const MODEL = "Xenova/whisper-tiny";

// ---------------------------------------------------------------------------
// Chargement du modele
// ---------------------------------------------------------------------------

let transcrirePromise = null;

// Charge le modele une seule fois, meme si plusieurs messages arrivent avant
// la fin du chargement : tout le monde attend la meme promesse.
function chargerModele() {
  if (transcrirePromise) return transcrirePromise;

  transcrirePromise = pipeline("automatic-speech-recognition", MODEL, {
    // Poids non quantifies. Par defaut la librairie prend une variante
    // quantifiee du depot Xenova, que cette version d'ONNX Runtime refuse
    // ("Missing required scale ... MatMulNBits"). fp32 est plus lourd a
    // telecharger mais se charge sans probleme.
    dtype: "fp32",
    // Suit le telechargement des fichiers du modele et le remonte a la page.
    progress_callback: (etat) => {
      if (etat.status === "progress" && etat.progress != null) {
        self.postMessage({
          type: "progress",
          fichier: etat.file,
          pourcent: Math.round(etat.progress),
        });
      }
    },
  });

  return transcrirePromise;
}

// ---------------------------------------------------------------------------
// File d'attente
// ---------------------------------------------------------------------------

// Les handlers onmessage sont asynchrones : sans ca, deux extraits envoyes coup
// sur coup lanceraient deux inferences en parallele sur le meme pipeline. On
// les enchaine donc a la queue leu leu.
let file = Promise.resolve();

function enfiler(tache) {
  file = file.then(tache, tache);
  return file;
}

// ---------------------------------------------------------------------------
// Protocole avec la page
// ---------------------------------------------------------------------------
//
// Page -> worker :
//   { type: "init" }
//   { type: "transcribe", id, audio: Float32Array (16 kHz mono), langue }
// Worker -> page :
//   { type: "ready", ms }               modele charge, pret a transcrire
//   { type: "progress", fichier, pourcent }
//   { type: "result", id, texte, ms }
//   { type: "error", id?, message }

self.onmessage = (event) => {
  const message = event.data;

  if (message.type === "init") {
    enfiler(async () => {
      const debut = performance.now();
      try {
        await chargerModele();
        self.postMessage({ type: "ready", ms: Math.round(performance.now() - debut) });
      } catch (error) {
        self.postMessage({ type: "error", message: String(error?.message || error) });
      }
    });
    return;
  }

  if (message.type === "transcribe") {
    const { id, audio, langue } = message;

    enfiler(async () => {
      const debut = performance.now();
      try {
        const transcrire = await chargerModele();
        // On force la langue : sur un extrait court, la detection automatique
        // de whisper-tiny se trompe facilement.
        const resultat = await transcrire(audio, { language: langue });
        self.postMessage({
          type: "result",
          id,
          texte: resultat.text.trim(),
          ms: Math.round(performance.now() - debut),
        });
      } catch (error) {
        self.postMessage({ type: "error", id, message: String(error?.message || error) });
      }
    });
    return;
  }

  self.postMessage({ type: "error", message: `Message inconnu : ${message.type}` });
};
