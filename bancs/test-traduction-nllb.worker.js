// CANDIDAT B -- NLLB-200 distilled 600M (q8) via transformers.js, DANS UN WORKER.
//
// Fichier de MESURE. Il ne touche a aucun fichier de production, et le modele
// vit dans test-nllb-model/, jamais dans models/.
//
// ---------------------------------------------------------------------------
// ⚠️ LE GUICHET EST POSE A LA PREMIERE LIGNE EXECUTEE -- ET C'EST OBLIGATOIRE
// ---------------------------------------------------------------------------
// Ce fichier contient un `await` de niveau module (l'import dynamique de
// transformers.js). Pendant cette attente la boucle d'evenements du worker
// TOURNE : un message envoye par la page serait distribue tout de suite et,
// sans onmessage, JETE EN SILENCE. Ni erreur, ni echec, ni delai -- la page
// attendrait une reponse qui ne viendrait jamais. Deja paye 227 s une fois
// (CLAUDE.md). On empile donc, et on rejoue quand le moteur est pret.

let remettre = (m) => file.push(m);
const file = [];
self.onmessage = (event) => remettre(event.data || {});

const journal = [];
function noter(m) {
  journal.push(m);
  console.log("[NLLB-WORKER] " + m);
}

// ---------------------------------------------------------------------------
// ⚠️ LA MEMOIRE : performance.memory ne compte QUE le tas JS
// ---------------------------------------------------------------------------
// Les poids vivent dans la memoire lineaire du WebAssembly, qui n'y figure pas.
// Interroge seul, performance.memory repondrait ~1 Mo -- faux d'un facteur
// mille (CLAUDE.md). On espionne donc le constructeur WebAssembly.Memory AVANT
// de charger quoi que ce soit, et on lit buffer.byteLength.
//
// Difference avec parakeet.worker.js : ici on garde TOUTES les memoires creees
// (encodeur et decodeur sont deux sessions), pas seulement la premiere, et on
// dit combien il y en a. Si le runtime cesse de passer par ce constructeur, la
// liste reste vide et on le DIT au lieu d'inventer un chiffre.
const memoires = [];
const VraieMemory = WebAssembly.Memory;
function MemoireEspionnee(descripteur) {
  const m = new VraieMemory(descripteur);
  memoires.push(m);
  return m;
}
MemoireEspionnee.prototype = VraieMemory.prototype;
WebAssembly.Memory = MemoireEspionnee;

function memoireWasm() {
  if (!memoires.length) {
    return { mo: null, nombre: 0, note: "aucune WebAssembly.Memory construite via le constructeur espionne" };
  }
  let total = 0;
  const tailles = [];
  for (const m of memoires) {
    try {
      const o = m.buffer.byteLength;
      tailles.push(+(o / 1048576).toFixed(1));
      total += o;
    } catch (_) {
      tailles.push(null);
    }
  }
  return {
    mo: +(total / 1048576).toFixed(1),
    nombre: memoires.length,
    parMemoireMo: tailles,
  };
}

const RACINE = new URL("../", self.location.href).href; // racine de l'extension (ce fichier vit dans bancs/)

// Import DYNAMIQUE, et c'est necessaire : un import statique serait resolu avant
// que la moindre ligne de ce fichier ne s'execute -- donc avant l'espion pose
// sur WebAssembly.Memory, qui ne verrait alors rien.
const tf = await import(RACINE + "vendor/transformers/transformers.min.js");
const { pipeline, env } = tf;

// 100 % local : aucune requete vers Hugging Face. C'est ce que le volet C
// verifie en renommant le dossier -- le chargement DOIT alors echouer.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = RACINE + "bancs/test-nllb-model/";

// Memes regles que Parakeet : un seul fil, pas de proxy, pas de WebGPU.
//
// ⚠️ CE QU'ON NE PEUT PAS FAIRE ICI, ET IL FAUT LE DIRE : transformers.js 4.2.0
// EMBARQUE son propre ONNX Runtime et ne permet pas de lui substituer
// `ort.wasm.bundle.min.mjs`. La chaine « le bundle importe decide du binaire »
// n'est donc pas sous notre controle. On force ce qui est sous notre controle
// (device "wasm", 1 fil) et on RELEVE quel binaire a reellement ete telecharge.
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.wasmPaths = RACINE + "vendor/transformers/";

noter("transformers.js charge, localModelPath = " + env.localModelPath);

const MODELE = "Xenova/nllb-200-distilled-600M";

// Les codes de langue de NLLB : ce ne sont pas des codes ISO a deux lettres.
const CODES = { fr: "fra_Latn", en: "eng_Latn", ar: "arb_Arab" };

let traducteur = null;

async function charger() {
  const t0 = performance.now();
  // ⚠️ graphOptimizationLevel: "basic" -- ET CE N'EST PAS UN REGLAGE DE CONFORT.
  // Sans lui, ONNX Runtime refuse l'export q8 avec :
  //   « qdq_actions.cc:137 TransposeDQWeightsForMatMulNBits Missing required
  //     scale: model.shared.weight_merged_0_scale »
  // Ce ne sont PAS les poids qui sont casses : ce sont les passes de fusion de
  // niveau `extended` d'ONNX Runtime. La panne est mot pour mot celle deja payee
  // sur le q8 de Whisper (CLAUDE.md, « Contraintes techniques connues »), et le
  // remede est le meme.
  const vus = new Set();
  traducteur = await pipeline("translation", MODELE, {
    dtype: "q8",
    device: "wasm",
    session_options: { graphOptimizationLevel: "basic" },
    progress_callback: (p) => {
      if (p && p.status === "progress" && p.file && p.progress === 100 && !vus.has(p.file)) {
        vus.add(p.file);
        noter(`fichier lu : ${p.file} (${p.total} o)`);
      }
    },
  });
  const ms = Math.round(performance.now() - t0);
  noter(`modele charge en ${(ms / 1000).toFixed(1)} s`);
  return ms;
}

async function traduire(texte, src, dst) {
  const t0 = performance.now();
  const sortie = await traducteur(texte, {
    src_lang: CODES[src],
    tgt_lang: CODES[dst],
    max_new_tokens: 512,
  });
  return {
    ms: Math.round(performance.now() - t0),
    texte: Array.isArray(sortie) ? sortie[0].translation_text : sortie.translation_text,
  };
}

// ⚠️ Chaque branche a son `.catch` qui REPOND : une promesse rejetee sans
// reponse laisse la page attendre indefiniment, sans erreur ni delai.
function gererMessage(message) {
  if (message.type === "init") {
    charger()
      .then((msChargement) => {
        self.postMessage({
          type: "ready",
          msChargement,
          memoireWasm: memoireWasm(),
          tasJsMo: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
          numThreads: env.backends.onnx.wasm.numThreads,
          journal: journal.slice(),
        });
      })
      .catch((erreur) => {
        self.postMessage({
          type: "error",
          phase: "init",
          message: String((erreur && erreur.message) || erreur),
          pile: erreur && erreur.stack ? String(erreur.stack) : null,
          journal: journal.slice(),
        });
      });
    return;
  }

  if (message.type === "translate") {
    traduire(message.texte, message.src, message.dst)
      .then((r) => {
        self.postMessage({
          type: "result",
          id: message.id,
          paire: message.src + "->" + message.dst,
          ms: r.ms,
          texte: r.texte,
          motsEntree: message.texte.split(/\s+/).filter(Boolean).length,
          memoireWasm: memoireWasm(),
          tasJsMo: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
          journal: journal.slice(),
        });
      })
      .catch((erreur) => {
        self.postMessage({
          type: "error",
          phase: "translate",
          id: message.id,
          message: String((erreur && erreur.message) || erreur),
          pile: erreur && erreur.stack ? String(erreur.stack) : null,
          journal: journal.slice(),
        });
      });
    return;
  }

  self.postMessage({ type: "error", message: "Message inconnu : " + message.type });
}

// Le guichet est ouvert pour de bon : on bascule, puis on rejoue ce qui est
// arrive pendant le chargement du module.
remettre = gererMessage;
while (file.length) gererMessage(file.shift());
