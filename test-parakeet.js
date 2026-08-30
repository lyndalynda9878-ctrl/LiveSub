// Test isole : prouver que NVIDIA Parakeet TDT 0.6B v3 transcrit un extrait,
// 100 % hors ligne, avec l'heure ET la confiance de chaque mot.
//
// Cette page ne touche a RIEN de la production : ni offscreen.js, ni content.js,
// ni whisper.worker.js. Whisper reste en place et reste le moteur de
// l'extension. C'est une page de mesure, exactement comme test-whisper.html.
//
// Ce qui est mesure ici :
//   - le texte rendu (le seul juge de la qualite) ;
//   - l'heure de debut et de fin de chaque mot, et sa confiance ;
//   - le temps de calcul brut, et le RTF (temps de calcul / duree de l'audio).
//
// ⚠️ L'inference tourne sur le fil principal. C'est volontaire pour une page de
// mesure : un Worker ajouterait un transfert de tampon entre les chronos. En
// production ca ira dans un Worker, comme Whisper aujourd'hui.

// ---------------------------------------------------------------------------
// ⚠️ POURQUOI ON N'APPELLE PAS `ParakeetModel.fromUrls` (le chargeur maison)
// ---------------------------------------------------------------------------
//
// parakeet.js est publie en ESM *source*, sans bundle, et son src/backend.js
// fait un `await import("onnxruntime-web")` : un specifieur NU. Un navigateur
// ne sait pas resoudre ca -- il n'y a pas de node_modules cote navigateur. La
// reponse normale serait une carte d'import. Les DEUX formes ont ete essayees
// dans Chrome 151, et les deux echouent ici :
//
//   - carte EN LIGNE : refusee par la CSP du projet
//     (`script-src 'self' 'wasm-unsafe-eval'`, pas de 'unsafe-inline'). La
//     console dit « Executing inline script violates the following Content
//     Security Policy directive ». Corriger ca demanderait de toucher au
//     manifeste.
//   - carte EXTERNE (`<script type="importmap" src="...">`) : acceptee par la
//     CSP, mais ce Chrome ne la lit meme pas -- l'onglet Reseau ne montre
//     AUCUNE requete vers le fichier, et l'erreur « Failed to resolve module
//     specifier » revient telle quelle.
//
// On importe donc ONNX Runtime par un chemin RELATIF (que le navigateur sait
// resoudre), on le pose dans `globalThis.ort` -- c'est la que parakeet.js va le
// chercher partout ailleurs que dans `fromUrls` -- et on assemble le modele a
// la main. C'est une trentaine de lignes recopiees de `fromUrls`.
//
// EFFET DE BORD, ET IL EST DANS LE BON SENS : `initOrt` n'est jamais appele.
// Or c'est la SEULE ligne de toute la librairie qui contient une URL internet :
//
//     ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ver}/dist/`;
//
// Ne pas passer par ce chargeur, ce n'est donc pas seulement contourner la
// carte d'import : c'est rendre le repli vers le CDN structurellement
// inatteignable, au lieu de compter sur un `if` pour ne pas se declencher.
//
// ⚠️ Le prix, honnetement : on court-circuite le chargeur officiel. Si
// parakeet.js change la facon dont il assemble ses sessions, cette page casse
// alors que la librairie, elle, marche. C'est acceptable pour une page de
// mesure ; ce n'est PAS ce qu'on mettra en production.
// Le dossier ONNX Runtime, declare ici parce que l'import dynamique du bundle
// (plus bas) en a besoin. Chemin RELATIF : le navigateur sait le resoudre, et
// il ne pointe que sur le disque.
const DIST_ORT_BUNDLE = "./node_modules/parakeet.js/node_modules/onnxruntime-web/dist/";

import { ParakeetModel } from "./node_modules/parakeet.js/src/index.js";
import { ParakeetTokenizer } from "./node_modules/parakeet.js/src/tokenizer.js";
import { OnnxPreprocessor } from "./node_modules/parakeet.js/src/preprocessor.js";

// ---------------------------------------------------------------------------
// LES DEUX REGLAGES A MESURER
// ---------------------------------------------------------------------------
//
// ⚠️ POURQUOI PAR L'URL, ET POURQUOI CHANGER UN REGLAGE RECHARGE LA PAGE
//
// Deux choses se decident UNE SEULE FOIS, au tout debut de la vie de la page,
// et ne peuvent plus etre changees ensuite :
//
//   - le nombre de fils, lu par ONNX Runtime quand il demarre son moteur WASM
//     (a la creation de la premiere session). Ecrire `numThreads = 4` apres
//     coup ne fait rien : le champ change, le moteur non ;
//   - le BINAIRE WASM, choisi par le bundle qu'on importe (voir juste en bas).
//
// Les reglages vivent donc dans l'URL (`?webgpu=non&fils=4`), ils sont lus ICI,
// avant tout le reste, et changer une case recharge la page. C'est aussi
// verifiable a l'oeil : l'URL dit ce qui a ete mesure.
//
// LES DEFAUTS NE CHANGENT PAS : sans parametre, WebGPU est demande et il y a
// 1 fil -- le comportement d'avant l'ajout des cases.
const params = new URLSearchParams(location.search);
const AVEC_WEBGPU = params.get("webgpu") !== "non";
const FILS = Math.max(1, Math.min(16, parseInt(params.get("fils"), 10) || 1));

// ---------------------------------------------------------------------------
// ⚠️ LE BUNDLE DECIDE DU BINAIRE, PAS LA LISTE DES PROVIDERS
// ---------------------------------------------------------------------------
//
// Piege trouve a la mesure (2026-08-30), et il rendait la case a cocher
// MENSONGERE. `ort.bundle.min.mjs` charge toujours le binaire
// `ort-wasm-simd-threaded.jsep.wasm` -- la variante WebGPU. Retirer "webgpu"
// de la liste des providers ne change PAS ce binaire : on obtenait un calcul
// annonce « CPU seul » qui tournait quand meme sur le moteur WebGPU, et ou les
// fils supplementaires n'apportaient rien.
//
// Mesure sur extrait-fr-dur.wav, 4 fils, WebGPU decoche :
//   - avec ort.bundle.min.mjs (binaire jsep) ......... 35,8 s
//   - avec ort.wasm.bundle.min.mjs (binaire simple) .. 14,7 s
// Le meme reglage affiche, deux fois et demie le temps. Une case qui ne change
// pas ce qu'elle annonce est pire que pas de case du tout.
//
// On importe donc le bundle qui correspond au reglage. L'import est dynamique
// (`await import`) parce qu'un import statique est resolu avant que la moindre
// ligne ne s'execute -- donc avant qu'on ait pu lire l'URL.
const BUNDLE = AVEC_WEBGPU ? "ort.bundle.min.mjs" : "ort.wasm.bundle.min.mjs";
const ortModule = await import(DIST_ORT_BUNDLE + BUNDLE);

const ort = ortModule.default || ortModule;

// parakeet.js lit `ort` dans le global partout hors de `fromUrls` (c'est
// `initOrt` qui l'y pose d'habitude). On le pose nous-memes.
globalThis.ort = ort;

// ---------------------------------------------------------------------------
// Ou vivent les fichiers. TOUT est sur le disque, rien sur internet.
// ---------------------------------------------------------------------------
//
// `new URL(..., import.meta.url)` donne des URL absolues chrome-extension://
// (ou file://, selon d'ou la page est ouverte). On les ecrit en clair ici pour
// qu'un lecteur puisse verifier d'un coup d'oeil qu'aucune ne pointe ailleurs.
const MODELE = "./models/parakeet-tdt-0.6b-v3/";
// Meme dossier que celui utilise plus haut pour importer le bundle : un seul
// chemin, pour qu-il ne puisse pas y en avoir deux qui divergent.
const DIST_ORT = DIST_ORT_BUNDLE;

const URL_ENCODEUR = new URL(MODELE + "encoder-model.int8.onnx", import.meta.url).href;
const URL_DECODEUR = new URL(MODELE + "decoder_joint-model.int8.onnx", import.meta.url).href;
const URL_VOCAB = new URL(MODELE + "vocab.txt", import.meta.url).href;
const URL_PREPROC = new URL(MODELE + "nemo128.onnx", import.meta.url).href;
const URL_CONFIG = new URL(MODELE + "config.json", import.meta.url).href;
const CHEMIN_WASM = new URL(DIST_ORT, import.meta.url).href;

// ---------------------------------------------------------------------------
// Ou ONNX Runtime va chercher son .wasm
// ---------------------------------------------------------------------------
//
// A defaut, ONNX Runtime demande son binaire a un CDN. On lui donne le dossier
// du disque -- celui de la copie 1.24.1 nichee sous parakeet.js. Le fichier
// reellement demande sera `ort-wasm-simd-threaded.jsep.wasm` (variante WebGPU),
// il est dans ce dossier.
ort.env.wasm.wasmPaths = CHEMIN_WASM;

// 1 fil par defaut : la CSP de MV3 interdit les workers `blob:`, et c'est
// comme ca que ONNX Runtime demarrait ses fils du temps de Whisper (voir
// CLAUDE.md). La case est la pour VERIFIER si c'est encore vrai avec ONNX
// Runtime 1.24, pas pour supposer que ca l'est. `proxy = false` pour la meme
// raison.
ort.env.wasm.numThreads = FILS;
ort.env.wasm.proxy = false;

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------
const logDiv = document.getElementById("log");
const texteDiv = document.getElementById("texte");
const motsDiv = document.getElementById("mots");
const chiffresDiv = document.getElementById("chiffres");
const fichierInput = document.getElementById("fichier");
const indicateurDiv = document.getElementById("indicateur");
const compteurSpan = document.getElementById("compteur");

function log(message, classe) {
  console.log(message);
  const ligne = document.createElement("div");
  ligne.textContent = message;
  if (classe) ligne.className = classe;
  logDiv.appendChild(ligne);
}

let timer = null;
let ticks = 0;
function demarrerIndicateur(libelle) {
  indicateurDiv.querySelector(".libelle").textContent = libelle;
  indicateurDiv.hidden = false;
  ticks = 0;
  clearInterval(timer);
  timer = setInterval(() => {
    ticks += 1;
    compteurSpan.textContent = `${(ticks / 10).toFixed(1)} s ` + ".".repeat(1 + (ticks % 3));
  }, 100);
}
function arreterIndicateur() {
  clearInterval(timer);
  timer = null;
  indicateurDiv.hidden = true;
}

// ---------------------------------------------------------------------------
// Decodage audio : .wav -> Float32Array a 16 kHz, mono
// ---------------------------------------------------------------------------
//
// Parakeet attend du 16 kHz mono, comme Whisper. On demande 16 kHz a
// l'AudioContext : c'est lui qui reechantillonne si besoin.
//
// Si le fichier est stereo on prend la MOYENNE des deux canaux, jamais un seul.
// C'est la lecon du point « 5 bis » de CLAUDE.md : prendre un canal au hasard
// garde toute la musique de ce cote-la, la moyenne garde la voix (qui est au
// centre) et fait s'annuler une partie de ce qui differe.
async function decoder16k(arrayBuffer) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const audio = await ctx.decodeAudioData(arrayBuffer);
  let pcm;
  if (audio.numberOfChannels === 1) {
    pcm = audio.getChannelData(0);
  } else {
    const g = audio.getChannelData(0);
    const d = audio.getChannelData(1);
    pcm = new Float32Array(g.length);
    for (let i = 0; i < g.length; i++) pcm[i] = (g[i] + d[i]) / 2;
  }
  const copie = new Float32Array(pcm); // detache du AudioBuffer avant close()
  const infos = {
    canaux: audio.numberOfChannels,
    tauxOrigine: ctx.sampleRate,
    duree: copie.length / 16000,
  };
  await ctx.close();
  return { pcm: copie, infos };
}

// ---------------------------------------------------------------------------
// Chargement du modele
// ---------------------------------------------------------------------------
let modele = null;

async function chargerModele() {
  log("Fichiers demandes (tous locaux) :");
  for (const u of [URL_ENCODEUR, URL_DECODEUR, URL_VOCAB, URL_PREPROC, URL_CONFIG, CHEMIN_WASM]) {
    log("   " + u);
  }

  // config.json du depot : on le lit pour ne pas coder 128 mels en dur.
  const config = await (await fetch(URL_CONFIG)).json();
  log(`config.json : ${config.model_type}, ${config.features_size} mels, `
    + `sous-echantillonnage ${config.subsampling_factor}`);

  demarrerIndicateur("Chargement du modele (652 Mo d'encodeur)");
  const t0 = performance.now();

  // Les memes options que celles que `fromUrls` construit en mode
  // 'webgpu-hybrid' : l'encodeur sur le GPU s'il est la, avec repli wasm ; le
  // decodeur TOUJOURS sur le CPU (il enchaine des milliers de tout petits pas,
  // exactement le regime ou le GPU perd -- c'est la meme lecon que pour le
  // decodeur de Whisper, voir CLAUDE.md).
  const optionsCommunes = {
    graphOptimizationLevel: "all",
    executionMode: "parallel",
    enableCpuMemArena: true,
    enableMemPattern: true,
    enableProfiling: false,
    logSeverityLevel: 2,
  };
  // La case decide. Decochee, WebGPU n'est meme pas propose : on ne compte pas
  // sur un repli pour ne pas se declencher, on retire la possibilite.
  const optionsEncodeur = {
    ...optionsCommunes,
    executionProviders: AVEC_WEBGPU
      ? [
          { name: "webgpu", deviceType: "gpu", powerPreference: "high-performance" },
          "wasm",
        ]
      : ["wasm"],
  };
  const optionsDecodeur = { ...optionsCommunes, executionProviders: ["wasm"] };

  const tokenizer = await ParakeetTokenizer.fromUrl(URL_VOCAB);
  log(`Vocabulaire : ${tokenizer.id2token.length} entrees, blank = ${tokenizer.blankId}.`);

  const encoderSession = await ort.InferenceSession.create(URL_ENCODEUR, optionsEncodeur);
  const joinerSession = await ort.InferenceSession.create(URL_DECODEUR, optionsDecodeur);

  // Le preprocesseur mel. On utilise VRAIMENT nemo128.onnx -- l'un des cinq
  // fichiers telecharges -- et pas le calcul mel en JS : c'est le mel avec
  // lequel le modele a ete entraine.
  //
  // On lui pose sa session et son `ort` a la main : sans ca, sa methode
  // `_ensureSession` appellerait `initOrt`, donc le specifieur nu. Avec
  // `this.session` deja rempli, elle retourne immediatement.
  const preprocesseur = new OnnxPreprocessor(URL_PREPROC, {});
  preprocesseur.ort = ort;
  preprocesseur.session = await ort.InferenceSession.create(URL_PREPROC, {
    enableProfiling: false,
  });

  // Chauffe, comme le fait `fromUrls` : la premiere execution d'une session
  // paie la compilation. Sans elle, le premier fichier transcrit porterait ce
  // surcout et son RTF serait faux.
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
  arreterIndicateur();
  log(`Modele charge en ${(ms / 1000).toFixed(1)} s.`, "ok");
  log(`ONNX Runtime ${ort.env.versions?.common || "?"} — wasmPaths = ${ort.env.wasm.wasmPaths}`);
  log(`WebGPU dispose par le navigateur : ${navigator.gpu ? "oui" : "non"} `
    + `— demande pour l'encodeur : ${AVEC_WEBGPU ? "oui" : "NON (CPU seul)"}.`);

  // On affiche les fils DEMANDES et les fils RETENUS. Sans SharedArrayBuffer,
  // ONNX Runtime retombe a 1 sans rien dire : croire qu'on mesure 4 fils alors
  // qu'il n'y en a qu'un donnerait un chiffre faux et silencieux.
  log(`Fils WASM : ${FILS} demande(s), ${ort.env.wasm.numThreads} retenu(s). `
    + `SharedArrayBuffer : ${typeof SharedArrayBuffer !== "undefined" ? "oui" : "NON"}.`,
    ort.env.wasm.numThreads === FILS ? undefined : "attention");

  // La preuve que la case a mordu : le nom du bundle. `ort.bundle.min.mjs`
  // charge le binaire `...jsep.wasm` (WebGPU), `ort.wasm.bundle.min.mjs` charge
  // `...threaded.wasm` (CPU). A verifier dans l'onglet Reseau si un doute.
  log(`Bundle ONNX Runtime : ${BUNDLE} — binaire attendu : `
    + `${AVEC_WEBGPU ? "ort-wasm-simd-threaded.jsep.wasm" : "ort-wasm-simd-threaded.wasm"}.`);
}

// ---------------------------------------------------------------------------
// Recoller le texte a partir des mots
// ---------------------------------------------------------------------------
//
// Un espace entre deux mots, sauf devant un morceau qui commence par de la
// ponctuation -- « mot , » se lirait mal. Le test porte sur le PREMIER
// caractere et exclut explicitement les lettres (\p{L}) et les chiffres
// (\p{N}) au sens Unicode, avec le drapeau `u` : c'est exactement l'erreur
// que fait la librairie qu'on evite ici, il serait absurde de la refaire.
//
// Dans les mesures du 2026-08-30, cette exception ne s'est jamais declenchee :
// la ponctuation arrive collee au mot qui la precede (« etoiles, » est UN mot).
// Elle est la par prudence, pas pour reparer un cas observe.
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
// Transcription
// ---------------------------------------------------------------------------
async function transcrire(file) {
  texteDiv.textContent = "—";
  motsDiv.textContent = "—";
  chiffresDiv.textContent = "—";

  log("");
  log(`--- ${file.name} (${(file.size / 1024).toFixed(0)} Ko) ---`);

  const { pcm, infos } = await decoder16k(await file.arrayBuffer());
  log(`Audio decode : ${infos.duree.toFixed(2)} s, ${infos.canaux} canal(aux) `
    + `a l'origine, ramene a 16000 Hz mono.`);

  demarrerIndicateur("Transcription");

  // Le chrono ENCADRE le seul appel de transcription. Il ne contient ni le
  // decodage du .wav, ni le chargement du modele : c'est bien le calcul.
  const t0 = performance.now();
  const res = await modele.transcribe(pcm, 16000, {
    returnTimestamps: true,
    returnConfidences: true,
  });
  const msBrut = performance.now() - t0;

  arreterIndicateur();

  const secondes = msBrut / 1000;
  const rtf = secondes / infos.duree;

  const mots = res.words || [];

  // --- le texte -----------------------------------------------------------
  //
  // ⚠️ ON N'AFFICHE PAS `res.utterance_text`, ET CE N'EST PAS UN CAPRICE
  //
  // parakeet.js recolle son texte complet dans `tokenizer.js`, avec ceci :
  //
  //     text = text.replace(/\s+(?=[^\w\s])/g, "");  // espace avant ponctuation
  //
  // En JavaScript, `\w` vaut `[A-Za-z0-9_]` -- de l'ASCII pur. Les lettres
  // accentuees n'en font PAS partie : é, à, è, î, ç tombent donc dans la classe
  // « ponctuation », et l'espace qui les precede est supprime. La regle « pas
  // d'espace avant une virgule » s'applique en silence a toute lettre accentuee
  // en debut de mot. Mesure sur extrait-fr-dur.wav : « premièresétoiles »,
  // « desévénements », « disparaîtreà », « l'espace,à » -- quatre fois, toujours
  // devant é ou à. Un texte anglais ne montre rien ; le francais est hache.
  //
  // `res.words`, LUI, EST JUSTE : il est construit ailleurs (parakeet.js, la ou
  // les mots sont assembles) par `raw.startsWith("▁")`, un test direct sur le
  // marqueur SentencePiece, qui ne passe pas par cette expression reguliere.
  // C'est verifiable a l'oeil dans la liste des 20 mots : « premières » et
  // « étoiles, » y sont deja separes, avec leurs heures distinctes.
  //
  // On DERIVE donc le texte de la liste des mots, au lieu d'afficher une
  // seconde version recollee par un chemin casse. C'est la meme regle que dans
  // offscreen.js (voir CLAUDE.md, « les instants ») : la chaine est DERIVEE des
  // mots, pour qu'il ne puisse pas exister deux verites qui divergent.
  //
  // ⚠️ On ne corrige PAS la librairie : `node_modules/` est regenere par le
  // prochain `npm install`, un correctif pose la disparaitrait sans bruit.
  const texteDerive = texteDepuisMots(mots) || res.utterance_text;
  texteDiv.textContent = texteDerive;
  console.log("TEXTE COMPLET :\n" + texteDerive);

  // Ce que le texte de la librairie aurait donne, pour pouvoir comparer les
  // deux sans refaire tourner le modele.
  console.log("TEXTE DE LA LIBRAIRIE (casse sur les accents) :\n" + res.utterance_text);

  // --- les 20 premiers mots ----------------------------------------------
  const lignes = mots.slice(0, 20).map((m) => {
    const conf = typeof m.confidence === "number" ? m.confidence.toFixed(4) : "—";
    return `[${m.start_time.toFixed(3)} -> ${m.end_time.toFixed(3)}] ${m.text} (${conf})`;
  });
  motsDiv.textContent = lignes.join("\n") || "(aucun mot)";
  console.log("20 PREMIERS MOTS :\n" + lignes.join("\n"));

  // --- verification des instants -----------------------------------------
  //
  // Whisper datait parfois un mot APRES la fin de l'extrait (jusqu'a +7,4 s,
  // voir CLAUDE.md) parce qu'il complete tout extrait a 30 s et que
  // l'alignement se perdait dans le silence de remplissage. Parakeet est un
  // modele a alignement par trame : chaque mot est ancre sur une trame reelle.
  // On le VERIFIE au lieu de le supposer.
  let croissants = true;
  let chevauchements = 0;
  let precedent = -Infinity;
  let finPrecedente = -Infinity;
  for (const m of mots) {
    if (m.start_time < precedent - 1e-6 || m.end_time < m.start_time - 1e-6) croissants = false;
    if (m.start_time < finPrecedente - 1e-6) chevauchements++;
    precedent = m.start_time;
    finPrecedente = m.end_time;
  }
  const dernierFin = mots.length ? mots[mots.length - 1].end_time : 0;
  const auDela = mots.filter((m) => m.end_time > infos.duree + 1e-6).length;

  // --- les chiffres -------------------------------------------------------
  const metriques = res.metrics || {};
  const confs = mots.map((m) => m.confidence).filter((c) => typeof c === "number");
  const confMoy = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;

  const rapport = [
    `fichier             : ${file.name}`,
    `reglages            : WebGPU ${AVEC_WEBGPU ? "oui" : "non"}, `
      + `${ort.env.wasm.numThreads} fil(s)`,
    `duree de l'audio    : ${infos.duree.toFixed(2)} s`,
    `TEMPS DE CALCUL     : ${secondes.toFixed(2)} s   (brut, autour du seul appel transcribe)`,
    `RTF                 : ${rtf.toFixed(3)}   (= ${secondes.toFixed(2)} / ${infos.duree.toFixed(2)})`,
    ``,
    `detail parakeet.js  : preprocess ${(metriques.preprocess_ms ?? 0).toFixed(0)} ms, `
      + `encode ${(metriques.encode_ms ?? 0).toFixed(0)} ms, `
      + `decode ${(metriques.decode_ms ?? 0).toFixed(0)} ms, `
      + `total ${(metriques.total_ms ?? 0).toFixed(0)} ms (rtf annonce ${(metriques.rtf ?? 0).toFixed(3)})`,
    ``,
    `mots                : ${mots.length}`,
    `confiance moyenne   : ${confMoy === null ? "—" : confMoy.toFixed(4)}`,
    `instants croissants : ${croissants ? "OUI" : "NON"}`,
    `mots qui commencent avant la fin du precedent : ${chevauchements}`,
    `dernier end_time    : ${dernierFin.toFixed(3)} s`,
    `mots dates APRES la fin de l'audio : ${auDela}`,
  ].join("\n");

  chiffresDiv.textContent = rapport;
  console.log("CHIFFRES :\n" + rapport);

  log(`Fini : ${mots.length} mots, ${secondes.toFixed(2)} s de calcul, RTF ${rtf.toFixed(3)}.`,
    croissants && auDela === 0 ? "ok" : "attention");

  // Objet complet laisse a disposition de la console, pour pouvoir tout
  // recompter a la main sans refaire tourner le modele.
  window.dernierResultat = { fichier: file.name, duree: infos.duree, secondes, rtf, res };
}

// ---------------------------------------------------------------------------
// Les deux cases : on les met a l'etat de l'URL, et les changer recharge
// ---------------------------------------------------------------------------
const webgpuCase = document.getElementById("webgpu");
const filsInput = document.getElementById("fils");

webgpuCase.checked = AVEC_WEBGPU;
filsInput.value = String(FILS);
document.getElementById("noteReglages").textContent =
  "Changer un reglage recharge la page : ONNX Runtime ne lit le nombre de fils "
  + "qu'une fois, au demarrage de son moteur. Le modele est donc recharge (~7 s). "
  + "Par defaut : WebGPU coche, 1 fil.";

function appliquerReglages() {
  const q = new URLSearchParams();
  if (!webgpuCase.checked) q.set("webgpu", "non");
  const n = Math.max(1, Math.min(16, parseInt(filsInput.value, 10) || 1));
  if (n !== 1) q.set("fils", String(n));
  // Sans parametre on retombe sur l'URL nue, donc sur les defauts.
  location.search = q.toString();
}

webgpuCase.addEventListener("change", appliquerReglages);
filsInput.addEventListener("change", appliquerReglages);

// ---------------------------------------------------------------------------
// Demarrage
// ---------------------------------------------------------------------------
fichierInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    await transcrire(file);
  } catch (err) {
    arreterIndicateur();
    log("ECHEC de la transcription : " + (err?.message || err), "err");
    console.error(err);
  }
});

(async () => {
  try {
    await chargerModele();
    fichierInput.disabled = false;
    log("Pret. Choisissez un fichier .wav ci-dessus.", "ok");
  } catch (err) {
    arreterIndicateur();
    log("ECHEC du chargement du modele : " + (err?.message || err), "err");
    log("Si le dossier models/parakeet-tdt-0.6b-v3/ est absent ou renomme, "
      + "c'est NORMAL que ca echoue ici : rien n'est telecharge sur internet.", "err");
    console.error(err);
  }
})();
