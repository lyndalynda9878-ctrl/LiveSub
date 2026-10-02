// Web Worker de transcription Parakeet : NVIDIA Parakeet TDT 0.6B v3 tourne
// ICI, pas sur le fil principal.
//
// Meme raison d'etre que whisper.worker.js : le WASM d'ONNX Runtime est
// SYNCHRONE. Tant qu'il calcule, la page ne repeint plus, ne scrolle plus, ne
// repond plus. C'est verifiable a l'oeil sur bancs/test-parakeet.html (etape 2), ou
// l'inference tourne sur le fil principal : le compteur de la page se fige
// pendant toute la transcription. Ici il ne se fige pas.
//
// ⚠️ CE FICHIER NE REMPLACE RIEN. whisper.worker.js reste en place et reste le
// moteur de l'extension. Les deux ne doivent JAMAIS vivre dans le meme worker :
// ONNX Runtime ne charge qu'un seul moteur WASM par worker, et le premier
// backend initialise s'impose aux suivants (voir CLAUDE.md, « choix du
// backend »). Deux modeles = deux workers.
//
// Protocole, calque sur celui de whisper.worker.js :
//   page -> { type: "init", urls }            worker -> { type: "ready", ... }
//   page -> { type: "transcribe", id, audio } worker -> { type: "result", id, words, text, ... }
//   en cas de pepin                           worker -> { type: "error", id?, message }

// Les modules de parakeet.js, en import STATIQUE : ils ne touchent pas a
// WebAssembly au chargement, donc leur ordre vis-a-vis de l'espion memoire
// pose plus bas n'a pas d'importance. ONNX Runtime, lui, est charge
// dynamiquement -- et la, l'ordre compte : voir le commentaire du bundle.
//
// ⚠️ Les `import` d'un module sont HISSES : ils sont resolus avant la premiere
// ligne executee. Les ecrire ici plutot qu'au milieu du fichier evite de
// laisser croire a un ordre qui n'existe pas.
import { ParakeetModel } from "./node_modules/parakeet.js/src/index.js";
import { ParakeetTokenizer } from "./node_modules/parakeet.js/src/tokenizer.js";
import { OnnxPreprocessor } from "./node_modules/parakeet.js/src/preprocessor.js";

// ---------------------------------------------------------------------------
// Ou vivent les fichiers
// ---------------------------------------------------------------------------
//
// ⚠️ `chrome.*` n'est PAS disponible dans un worker dedie (verifie, voir
// CLAUDE.md). C'est donc la PAGE qui construit les URL avec
// chrome.runtime.getURL et nous les envoie dans le message `init`. On garde un
// repli derive de `self.location` -- toujours defini dans un worker -- pour que
// le fichier reste testable meme si l'appelant oublie de les fournir.
const RACINE = new URL("./", self.location.href).href;
const DIST_ORT = new URL("./node_modules/parakeet.js/node_modules/onnxruntime-web/dist/", RACINE).href;

const URLS_DEFAUT = {
  encodeur: new URL("./models/parakeet-tdt-0.6b-v3/encoder-model.int8.onnx", RACINE).href,
  decodeur: new URL("./models/parakeet-tdt-0.6b-v3/decoder_joint-model.int8.onnx", RACINE).href,
  vocab: new URL("./models/parakeet-tdt-0.6b-v3/vocab.txt", RACINE).href,
  preproc: new URL("./models/parakeet-tdt-0.6b-v3/nemo128.onnx", RACINE).href,
  config: new URL("./models/parakeet-tdt-0.6b-v3/config.json", RACINE).href,
};

// ---------------------------------------------------------------------------
// ⚠️ LE GUICHET, POSE AVANT TOUT LE RESTE -- ET C'EST OBLIGATOIRE
// ---------------------------------------------------------------------------
//
// Ce fichier contient un `await` au niveau du module (l'import dynamique de
// ONNX Runtime, plus bas). Pendant cette attente, LA BOUCLE D'EVENEMENTS DU
// WORKER TOURNE DEJA : un message envoye par la page a cet instant est
// distribue tout de suite. S'il n'y a pas encore de `onmessage`, il est
// **jete en silence** -- pas d'erreur, pas d'echec, pas de delai. La page
// attend alors une reponse qui ne viendra jamais.
//
// C'est arrive : premiere version de ce fichier, `self.onmessage` en bas.
// Le worker chargeait son bundle correctement puis restait muet 227 secondes,
// et l'onglet Reseau montrait que le `init` n'avait rien declenche. Meme forme
// de panne que le blocage decrit dans CLAUDE.md (« chrome.storage est
// indisponible dans l'offscreen ») : ce qui rend le bug invisible, c'est
// qu'il n'echoue nulle part.
//
// On installe donc le gestionnaire DES LA PREMIERE LIGNE executee, et on met
// les messages en attente tant que le moteur n'est pas pret.
const enAttente = [];
let remettre = (message) => enAttente.push(message);
self.onmessage = (event) => remettre(event.data || {});

// ---------------------------------------------------------------------------
// Journal : ce worker doit pouvoir PROUVER que c'est lui qui a travaille
// ---------------------------------------------------------------------------
//
// Un worker dedie n'a pas de console a lui dans une session pilotee -- meme
// probleme que le document offscreen (voir CLAUDE.md, « les trois consoles »).
// Ses messages doivent donc REMONTER a la page, prefixes, sinon « aucune
// erreur » ne veut rien dire.
const journal = [];
function noter(ligne) {
  journal.push(ligne);
  console.log("[PARAKEET-WORKER] " + ligne);
}

// La preuve de contexte, relevee une fois pour toutes au chargement du fichier.
// `window` n'existe pas dans un worker ; `DedicatedWorkerGlobalScope` est le
// nom de la portee globale. Un mensonge sur ce point serait immediat a voir.
const PREUVE_CONTEXTE = {
  portee: self.constructor && self.constructor.name,
  windowExiste: typeof window !== "undefined",
  documentExiste: typeof document !== "undefined",
  chromeExiste: typeof chrome !== "undefined",
  chromeStorageExiste: typeof chrome !== "undefined" && typeof chrome.storage !== "undefined",
};

// ---------------------------------------------------------------------------
// ⚠️ MESURE DE LA MEMOIRE WASM -- a poser AVANT que ONNX Runtime ne se charge
// ---------------------------------------------------------------------------
//
// `performance.memory` ne compte QUE le tas JavaScript. Les 652 Mo de poids du
// modele vivent dans la memoire lineaire du WebAssembly, qui n'y figure pas :
// s'en contenter donnerait un chiffre rassurant et faux.
//
// On garde donc une reference sur l'objet WebAssembly.Memory que le runtime
// cree, pour pouvoir lire sa vraie taille apres coup. Si ONNX Runtime change de
// facon de faire (memoire exportee par le module au lieu d'etre construite ici),
// la reference restera nulle et on le DIRA au lieu d'inventer un chiffre.
const memoireWasm = { objet: null };
const VraieMemory = WebAssembly.Memory;
function MemoireEspionnee(descripteur) {
  const m = new VraieMemory(descripteur);
  if (!memoireWasm.objet) memoireWasm.objet = m;
  return m;
}
MemoireEspionnee.prototype = VraieMemory.prototype;
WebAssembly.Memory = MemoireEspionnee;

function memoireWasmMo() {
  if (!memoireWasm.objet) return null;
  try {
    return +(memoireWasm.objet.buffer.byteLength / 1048576).toFixed(1);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ⚠️ LE BUNDLE IMPORTE DECIDE DU BINAIRE .wasm -- PAS LES executionProviders
// ---------------------------------------------------------------------------
//
// Piege paye deux fois. `ort.bundle.min.mjs` charge TOUJOURS
// `ort-wasm-simd-threaded.jsep.wasm`, la variante WebGPU, meme si toutes les
// sessions demandent `["wasm"]`. Retirer "webgpu" de la liste ne change rien au
// binaire.
//
// Et ce n'est pas qu'une question de vitesse : le mauvais bundle ne rend pas le
// meme texte. Il ecrit « d'etoil » la ou celui-ci ecrit « d'etoiles ». Sans le
// moindre message.
//
// ⚠️ NE PAS remplacer la ligne ci-dessous par "ort.bundle.min.mjs".
const BUNDLE = "ort.wasm.bundle.min.mjs";

// Import DYNAMIQUE, et c'est necessaire : un import statique est resolu avant
// que la moindre ligne de ce fichier ne s'execute -- donc avant l'espion pose
// sur WebAssembly.Memory, qui ne verrait alors rien.
const ortModule = await import(DIST_ORT + BUNDLE);
const ort = ortModule.default || ortModule;

// parakeet.js lit `ort` dans le global partout ailleurs que dans son chargeur
// maison. C'est `initOrt` qui l'y pose d'habitude -- et `initOrt` est justement
// la SEULE ligne de la librairie qui contienne une URL internet (un repli vers
// cdn.jsdelivr.net). On pose `ort` nous-memes : ce repli devient structurellement
// inatteignable, au lieu de dependre d'un `if` qui ne se declenche pas.
globalThis.ort = ort;

// Ou trouver le .wasm : sur le disque, jamais sur un CDN.
ort.env.wasm.wasmPaths = DIST_ORT;

// ---------------------------------------------------------------------------
// ⚠️ LES FILS D'EXECUTION -- UNE DES RAISONS POUR LESQUELLES LA PREPARATION NE
// TENAIT PAS. PAS LA SEULE : lire l'attribution corrigee plus bas.
// ---------------------------------------------------------------------------
//
// Il etait ecrit ici : « Un seul fil. La CSP de MV3 bloque les workers `blob:`,
// et c'est comme ca que ONNX Runtime demarre les siens. » LES DEUX MOITIES DE
// CETTE PHRASE SONT FAUSSES, et elles ont coute cher :
//
//   1. ONNX Runtime 1.24 ne demarre PAS ses fils par un `blob:`. Verifie dans
//      `ort-wasm-simd-threaded.mjs` : `new Worker(new URL(import.meta.url))`,
//      donc une URL `chrome-extension://` ordinaire. Zero occurrence de
//      « blob: » dans tout le fichier. La CSP n'a rien a bloquer.
//   2. Meme si elle bloquait, ce serait la CSP des PAGES d'extension ; ce
//      fichier-ci est un worker dedie, qui a le droit d'en creer d'autres.
//
// CE QUE CE « 1 » COUTAIT -- ET CE QU'IL NE COUTAIT PAS.
//
// ⚠️ ATTRIBUTION CORRIGEE LE 04/09/2026. Il etait ecrit ici, sur les 17,7 s par
// bloc, que « c'est le 1 fil qui coute ca ». LA MESURE DIT NON. Les deux
// chiffres sont vrais tous les deux ; ils ne mesurent simplement pas la meme
// chose :
//
//   - LA CHAINE COMPLETE, run reel de 9 min a 1 fil (28 blocs,
//     docs/mesures/traduction/9min-valide.json) : 17,7 s de calcul par bloc de ~22 s
//     d'audio, soit un RTF de 0,82 sur une machine a 12 fils logiques. Il en
//     faut moins de 0,44 pour suivre une video qui defile a x2. La preparation
//     prenait donc du retard a CHAQUE bloc, et ce retard n'etait jamais
//     rembourse : il s'accumulait dans la file et se payait d'un bloc a la
//     toute fin -- 237 s de deficit sur ce run, soit les « environ 5 minutes »
//     d'attente rapportees.
//   - LE MOTEUR SEUL, meme machine, meme taille de bloc (23 s), toujours a
//     1 fil : 6,1 a 7,1 s, soit un RTF de 0,27 a 0,31
//     (docs/mesures/fils/releve-A-1fil, -C-1fil-temoin, -D-1fil-texte).
//
// Le fil unique explique donc environ 7 s des 17,7, pas les 17,7. D'ou viennent
// les ~11 s restantes -- la meme machine decode la video a x2, capte et
// reechantillonne le son en meme temps -- est NON MESURE. Ne pas reecrire
// « c'est le 1 fil » : c'etait un raccourci, et un raccourci sur une cause fait
// chercher au mauvais endroit.
//
// CE QUI EST MESURE, en revanche : a 4 fils le moteur seul tombe a ~3,2 s
// (RTF 0,137 a 0,141), soit x1,95, pour un texte RIGOUREUSEMENT IDENTIQUE.
// Et 4 est un optimum, pas un plancher : a 6 et 8 fils c'est plus lent.
//
// ⚠️ ON NE SUPPOSE RIEN : on regarde d'abord si SharedArrayBuffer est la.
// C'est LA condition des fils WASM (ils partagent la memoire lineaire du
// module). Sans lui, demander 4 fils ne donne pas 4 fils -- au mieux un repli
// silencieux, au pire un echec de chargement. Le releve part dans `ready`,
// avec le nombre de fils REELLEMENT retenu par ONNX Runtime, pas celui demande.
const FILS_POSSIBLES = typeof SharedArrayBuffer !== "undefined";
const FILS_MATERIEL = (self.navigator && self.navigator.hardwareConcurrency) || 1;

// Combien en prendre. Pas tous : pendant la preparation, la meme machine decode
// aussi la video a x2 et fait tourner la capture audio. La valeur arrive de la
// page (message `init`), qui est le seul endroit ou elle se regle.
function filsRetenus(demandes) {
  if (!FILS_POSSIBLES) return 1;
  const n = Math.floor(Number(demandes));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.max(1, Math.min(n, FILS_MATERIEL));
}

// ⚠️ La valeur n'est PAS posee ici. ONNX Runtime la lit quand il demarre son
// moteur WASM, c'est-a-dire a la creation de la PREMIERE session -- l'ecrire
// apres coup change le champ et rien d'autre (lecon deja payee dans
// bancs/test-parakeet.js). On la pose donc au debut de `charger()`, qui est le seul
// endroit ou des sessions sont creees, et jamais ailleurs.
ort.env.wasm.proxy = false;

noter(`portee = ${PREUVE_CONTEXTE.portee}, window = ${PREUVE_CONTEXTE.windowExiste}, `
  + `chrome = ${PREUVE_CONTEXTE.chromeExiste}`);
// Le nom du binaire est DERIVE du bundle, pas ecrit en dur : pendant la
// contre-preuve du volet B, une chaine figee annoncait `ort-wasm-simd-threaded.wasm`
// alors que jsep.wasm etait charge. Un journal qui ment est pire que pas de journal.
noter(`bundle = ${BUNDLE} (binaire attendu : ${BUNDLE === "ort.wasm.bundle.min.mjs" ? "ort-wasm-simd-threaded.wasm" : "ort-wasm-simd-threaded.jsep.wasm"})`);

// ---------------------------------------------------------------------------
// Recoller le texte a partir des mots
// ---------------------------------------------------------------------------
//
// ⚠️ ON NE RENVOIE PAS `res.utterance_text`. parakeet.js le recolle dans
// tokenizer.js avec `text.replace(/\s+(?=[^\w\s])/g, "")`. En JavaScript, `\w`
// vaut `[A-Za-z0-9_]` -- de l'ASCII pur. Les lettres accentuees n'en font pas
// partie, tombent donc dans la classe « ponctuation », et l'espace qui les
// precede est efface : « premieresetoiles », « desevenements », « disparaitrea ».
// En anglais ca ne se voit jamais ; en francais ca hache le texte a chaque accent.
//
// `res.words` est juste : il est construit ailleurs, par `raw.startsWith("▁")`,
// un test direct sur le marqueur SentencePiece qui ne passe pas par cette
// expression reguliere. On DERIVE donc le texte des mots -- meme regle que dans
// offscreen.js (CLAUDE.md, « les instants ») : une seule verite, pas deux.
//
// Pas d'espace devant un morceau qui commence par de la ponctuation. Le test
// exclut explicitement lettres et chiffres au sens UNICODE (`\p{L}`, `\p{N}`,
// drapeau `u`) : il serait absurde de refaire ici l'erreur qu'on evite.
const PONCTUATION_COLLEE = /^[^\p{L}\p{N}]/u;

function texteDepuisMots(mots) {
  let texte = "";
  for (const m of mots) {
    const mot = m.text;
    if (!mot) continue;
    if (texte && !PONCTUATION_COLLEE.test(mot)) texte += " ";
    texte += mot;
  }
  return texte;
}

// ---------------------------------------------------------------------------
// Chargement du modele
// ---------------------------------------------------------------------------
let modele = null;

async function charger(urlsFournies, filsDemandes) {
  const urls = { ...URLS_DEFAUT, ...(urlsFournies || {}) };
  noter(`urls ${urlsFournies ? "recues de la page" : "derivees de self.location"}`);

  // Les fils, ICI et nulle part ailleurs : juste avant la premiere session.
  ort.env.wasm.numThreads = filsRetenus(filsDemandes);
  noter(
    `fils : ${filsDemandes} demande(s), ${ort.env.wasm.numThreads} pose(s) ` +
      `| SharedArrayBuffer ${FILS_POSSIBLES ? "present" : "ABSENT"} ` +
      `| crossOriginIsolated ${typeof crossOriginIsolated === "undefined" ? "?" : crossOriginIsolated} ` +
      `| ${FILS_MATERIEL} fil(s) materiel`
  );

  const t0 = performance.now();

  const config = await (await fetch(urls.config)).json();
  noter(`config.json : ${config.model_type}, ${config.features_size} mels, `
    + `sous-echantillonnage ${config.subsampling_factor}`);

  // Les memes options que celles que `fromUrls` construit, moins WebGPU :
  // l'encodeur ET le decodeur sur le CPU. Le decodeur enchaine des milliers de
  // tout petits pas, exactement le regime ou le GPU perd -- meme lecon que pour
  // le decodeur de Whisper.
  const optionsCommunes = {
    graphOptimizationLevel: "all",
    executionMode: "parallel",
    enableCpuMemArena: true,
    enableMemPattern: true,
    enableProfiling: false,
    logSeverityLevel: 2,
  };
  const optionsSession = { ...optionsCommunes, executionProviders: ["wasm"] };

  const tokenizer = await ParakeetTokenizer.fromUrl(urls.vocab);
  noter(`vocabulaire : ${tokenizer.id2token.length} entrees, blank = ${tokenizer.blankId}`);

  const encoderSession = await ort.InferenceSession.create(urls.encodeur, optionsSession);
  const joinerSession = await ort.InferenceSession.create(urls.decodeur, optionsSession);

  // Le preprocesseur mel : on utilise VRAIMENT nemo128.onnx, celui avec lequel
  // le modele a ete entraine, pas le calcul mel en JavaScript.
  //
  // On lui pose sa session et son `ort` a la main : sans ca, `_ensureSession`
  // appellerait `initOrt`, donc le specifieur nu `onnxruntime-web`, qu'un
  // navigateur ne sait pas resoudre.
  const preprocesseur = new OnnxPreprocessor(urls.preproc, {});
  preprocesseur.ort = ort;
  preprocesseur.session = await ort.InferenceSession.create(urls.preproc, {
    enableProfiling: false,
  });

  // Chauffe, comme le fait `fromUrls`. La premiere execution d'une session paie
  // la compilation : sans elle, le premier fichier transcrit porterait ce
  // surcout et son temps serait faux.
  await preprocesseur.process(new Float32Array(1600));

  modele = new ParakeetModel({
    tokenizer,
    encoderSession,
    joinerSession,
    preprocessor: preprocesseur,
    ort,
    subsampling: config.subsampling_factor,
    windowStride: 0.01,
    nMels: config.features_size,
  });

  const ms = performance.now() - t0;
  noter(`modele charge en ${(ms / 1000).toFixed(1)} s`);
  return ms;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
//
// ⚠️ Chaque branche a son `.catch` qui REPOND. Une promesse rejetee sans reponse
// laisse l'appelant attendre indefiniment, sans erreur, sans echec, sans delai --
// c'est comme ca que le bouton Demarrer s'est bloque en silence une fois (voir
// CLAUDE.md, « chrome.storage est indisponible dans l'offscreen »).
function gererMessage(message) {

  if (message.type === "init") {
    charger(message.urls, message.fils)
      .then((msChargement) => {
        self.postMessage({
          type: "ready",
          msChargement,
          bundle: BUNDLE,
          // ⚠️ `fils` est ce qui a ete POSE, pas une preuve que ONNX Runtime a
          // vraiment demarre autant de fils. La seule preuve est le temps par
          // bloc -- c'est lui qu'il faut lire, pas ce chiffre. Les deux champs
          // suivants disent, eux, si les fils etaient seulement POSSIBLES.
          fils: ort.env.wasm.numThreads,
          filsDemandes: message.fils ?? null,
          filsMateriel: FILS_MATERIEL,
          memoirePartagee: FILS_POSSIBLES,
          versionOrt: ort.env.versions ? ort.env.versions.common : null,
          contexte: PREUVE_CONTEXTE,
          memoireWasmMo: memoireWasmMo(),
          tasJsMo: performance.memory
            ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1)
            : null,
          journal: journal.slice(),
        });
      })
      .catch((erreur) => {
        noter("ECHEC du chargement : " + (erreur && erreur.message ? erreur.message : erreur));
        self.postMessage({
          type: "error",
          message: String((erreur && erreur.message) || erreur),
          journal: journal.slice(),
        });
      });
    return;
  }

  if (message.type === "transcribe") {
    const { id, audio, taux } = message;

    (async () => {
      if (!modele) throw new Error("modele pas encore charge");

      const debutHorloge = Date.now();
      const t0 = performance.now();
      const res = await modele.transcribe(audio, taux || 16000, {
        returnTimestamps: true,
        returnConfidences: true,
      });
      const msBrut = performance.now() - t0;
      const finHorloge = Date.now();

      const mots = res.words || [];
      const texte = texteDepuisMots(mots) || res.utterance_text;

      noter(`transcrit : ${mots.length} mots en ${(msBrut / 1000).toFixed(2)} s`);

      self.postMessage({
        type: "result",
        id,
        words: mots,
        text: texte,
        // Le texte de la librairie, transmis a part : il sert de CONTRE-PREUVE
        // (il doit etre casse sur les accents ; s'il ne l'est pas, c'est qu'on
        // ne regarde pas ce qu'on croit).
        texteLibrairie: res.utterance_text,
        msBrut,
        metrics: res.metrics || null,
        // Les bornes de l'horloge murale du worker : elles permettent a la page
        // de verifier que son propre fil a continue de tourner PENDANT ce
        // calcul-la, et pas avant ou apres.
        debutHorloge,
        finHorloge,
        memoireWasmMo: memoireWasmMo(),
        tasJsMo: performance.memory
          ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1)
          : null,
        journal: journal.slice(),
      });
    })().catch((erreur) => {
      noter("ECHEC de la transcription : " + (erreur && erreur.message ? erreur.message : erreur));
      self.postMessage({
        type: "error",
        id,
        message: String((erreur && erreur.message) || erreur),
        journal: journal.slice(),
      });
    });
    return;
  }

  self.postMessage({ type: "error", message: `Message inconnu : ${message.type}` });
}

// Le guichet est ouvert pour de bon : on bascule, puis on rejoue ce qui est
// arrive pendant le chargement du module. Sans cette relecture, le `init`
// envoye tot resterait dans la file et rien ne demarrerait jamais.
remettre = gererMessage;
for (const message of enAttente.splice(0)) gererMessage(message);
noter(`guichet ouvert (${enAttente.length} message(s) restant(s) en file)`);
