// Web Worker de transcription : Whisper tourne ICI, pas sur le fil principal.
//
// Avant, l'inference se faisait dans la page et la figeait plusieurs secondes
// a chaque extrait (le WASM d'ONNX Runtime est synchrone : tant qu'il calcule,
// la page ne repeint plus, ne scrolle plus, ne repond plus). En le deplacant
// dans un worker, le fil principal reste libre : c'est tout l'objet de ce
// fichier.
//
// (Le "~12 s" cite dans les premieres notes du projet melangeait le chargement
// du modele et l'inference. L'inference seule tourne autour de 2,3 s sur CPU
// pour un extrait de ~10 s.)
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

// Le modele vit DANS l'extension, comme les librairies de vendor/.
//
// Avant, il etait telecharge depuis Hugging Face au demarrage. Ce n'etait pas
// « une fois puis en cache » : mesure sur trois captures consecutives, trois
// telechargements complets de ~150 Mo. Sans internet, l'extension ne demarrait
// pas -- ce qui contredit l'argument central du projet.
//
// allowRemoteModels = false est LA garantie, et pas une preference : si un
// fichier manque, le chargement doit echouer bruyamment (voir
// verifierModeleLocal) et surtout PAS repartir en douce sur internet. C'est ce
// qui rend le « 100 % hors ligne » verifiable au lieu d'etre une intention.
//
// models/ est rempli par `npm run build:model` (scripts/fetch-model.js) et
// gitignore, exactement comme vendor/.
env.allowLocalModels = true;
env.allowRemoteModels = false;

// Comme pour les .wasm plus haut : on derive l'URL de self.location, parce que
// les API chrome.* ne sont pas garanties dans un worker dedie.
env.localModelPath = new URL("./models/", self.location.href).href;

// whisper-tiny MULTILINGUE (surtout pas la variante .en, qui ne fait que
// l'anglais : LiveSub doit sous-titrer du francais).
const MODELE_DEFAUT = "Xenova/whisper-tiny";

// Nombre maximum de jetons (~mots) que Whisper a le droit d'ecrire pour UN
// segment. Sans reglage, la librairie autorise 448 jetons.
//
// Ce n'est pas theorique : mesure sur de la parole propre, un segment a mis
// 17,1 s a etre transcrit alors que la mediane etait de 4,3 s. Whisper part en
// boucle de repetition et ecrit jusqu'a epuisement du quota. Pendant ce
// temps-la le worker est monopolise, les segments s'empilent, et c'est
// exactement le « blocage » observe.
//
// 60 jetons est large : un segment fait au plus 7 s de parole (DUREE_MAX dans
// offscreen.js), soit ~20 a 25 mots a debit normal. On ne coupe donc jamais une
// phrase legitime -- on ne coupe que les boucles.
const MAX_JETONS = 60;

// Interdit a Whisper de repeter une meme suite de 6 jetons dans une sortie.
//
// MAX_JETONS borne la LONGUEUR d'une boucle de repetition ; celui-ci l'empeche
// de commencer. Les deux se completent : sans lui, une boucle occupe quand meme
// les 60 jetons et produit un sous-titre entierement faux.
//
// 6 et pas 3 : la parole naturelle repete des suites courtes tout le temps
// (« je ne sais pas, je ne sais pas »). A 3, on casserait ces repetitions
// legitimes en forcant le modele a ecrire autre chose -- c'est-a-dire a
// inventer, exactement ce qu'on cherche a eviter. A 6, une suite de 6 mots
// identiques n'arrive quasiment jamais dans de la vraie parole.
const NO_REPEAT_NGRAM = 6;

// Langue imposee a Whisper.
//
// Avant, on laissait la detection automatique (`language` absent). Elle se
// trompe reguliserement sur des segments courts : dans les tests, du francais
// est ressorti en anglais (« J'adore, j'aime » -> « I love you »), et une
// langue mal detectee donne du texte faux ou vide.
//
// C'est un REPLI, pas le reglage principal : la langue vient normalement du
// selecteur de la popup, et voyage jusqu'ici dans le message `transcribe`
// (popup -> background -> offscreen -> worker). Elle l'emporte toujours sur
// cette constante. La page de comparaison test-bench.html passe elle aussi sa
// propre langue.
//
// LANGUE_DEFAUT ne sert donc que si personne n'en precise : worker appele sans
// langue, ou storage illisible.
const LANGUE_DEFAUT = "french";

// Poids NON quantifies. C'est un choix mesure, pas un choix par defaut.
//
// La quantification 8 bits (onnx-community/whisper-tiny en `q8`, avec
// `opt=basic` -- voir plus bas) a ete essayee serieusement et compare a fp32
// sur la meme machine (page test-bench.html) :
//   - 42 Mo au lieu de 147, et ~18 % plus rapide par segment ;
//   - texte IDENTIQUE sur un extrait propre et complet (0 % de WER, FR et EN) ;
//   - mais TEXTE DEGRADE sur le regime reel de LiveSub. En bout-en-bout, q8
//     ecrivait systematiquement « What you are country can do for you » la ou
//     fp32 ecrivait « What your country can do for you », et « as what » au
//     lieu de « ask what ». Sur 21 fragments compares, fp32 gagnait 8 fois,
//     q8 une seule.
//
// Comme la latence est stable a ~2 s avec fp32 (voir le decoupage dans
// offscreen.js), les 18 % de vitesse n'achetent rien : on paierait une perte de
// precision pour un gain invisible. On garde donc fp32.
//
// Le seul vrai avantage restant de q8 est le poids (105 Mo de moins), qui
// comptera le jour ou on embarquera le modele dans l'extension. La piste a
// creuser ce jour-la n'est pas tiny en q8, mais whisper-BASE en q8 : 77 Mo,
// soit toujours moins que tiny fp32, et un modele nettement moins sujet aux
// hallucinations.
//
// A ne pas confondre avec q4 / q4f16, essayes et abandonnes : q4 ne charge pas
// du tout, et en WebGPU fp16 et q4f16 produisent du texte casse (boucles de
// repetition). fp16 sur CPU est mesure 1,3 a 1,4x plus LENT que fp32 (le
// processeur n'a pas d'unite fp16 native).
const DTYPE_DEFAUT = "fp32";

// Le modele et la precision peuvent etre imposes par la query string du worker
// (`whisper.worker.js?modele=...&dtype=...`). Ca ne sert QU'A la page de
// comparaison test-bench.html, qui doit faire tourner plusieurs variantes cote
// a cote sans qu'on reecrive ce fichier entre chaque mesure. En production
// personne ne passe de parametre : ce sont les valeurs par defaut ci-dessus qui
// s'appliquent.
//
// Bonus : `mesurerDansUnEnfant` cree les workers enfants a partir de
// self.location.href, donc ils heritent automatiquement de ces parametres.
const PARAMETRES = new URL(self.location.href).searchParams;
const MODEL = PARAMETRES.get("modele") || MODELE_DEFAUT;

// Le dtype accepte soit un nom ("q8"), soit un objet JSON par sous-modele
// ({"encoder_model":"q8","decoder_model_merged":"fp32"}) : Transformers.js
// permet de quantifier l'encodeur sans toucher au decodeur.
const DTYPE = (() => {
  const brut = PARAMETRES.get("dtype") || DTYPE_DEFAUT;
  return brut.startsWith("{") ? JSON.parse(brut) : brut;
})();

// Niveau d'optimisation du graphe ONNX ("disabled", "basic", "extended",
// "all"). "all" = le comportement par defaut d'ONNX Runtime, et ce qui va bien
// a fp32.
//
// Ce reglage existe parce qu'il est la CLE des variantes quantifiees : en
// "all", ni q8 ni fp16 ne chargent, et l'erreur donne le change en accusant les
// poids alors que le coupable est l'optimiseur --
//   q8   : qdq_actions.cc TransposeDQWeightsForMatMulNBits
//          « Missing required scale: model.decoder.embed_tokens... »
//   fp16 : SimplifiedLayerNormFusion
// Ce sont deux passes de fusion de niveau "extended". En "basic", les deux
// chargent et transcrivent. (C'est ce qui explique l'echec note plus tot dans
// le projet sur les exports quantifies : le probleme n'a jamais ete la
// quantification elle-meme.)
//
// A garder en tete si on retente la quantification un jour -- par exemple avec
// whisper-base en q8. Mesure au passage : "basic" est plus rapide que
// "disabled" (1345 ms contre 1505 ms par segment), on ne coupe donc que ce
// qu'il faut.
const OPTIMISATION_DEFAUT = "all";

const OPTIMISATION = PARAMETRES.get("opt") || OPTIMISATION_DEFAUT;

// Options passees telles quelles a ONNX Runtime a la creation de la session.
const SESSION_OPTIONS = { graphOptimizationLevel: OPTIMISATION };

// Horodatage par mot. Contrairement a `modele`, `dtype` et `opt`, celui-ci est
// ACTIF EN PRODUCTION : `?horodatage=non` sert seulement aux pages de mesure,
// qui doivent pouvoir comparer avec et sans.
//
// A quoi ca sert : sans lui, l'overlay ne sait pas QUAND un mot a ete prononce,
// seulement lesquels. Il les revele donc a cadence fixe, ce qui donne des
// rafales suivies de trous au lieu du rythme de la parole. Avec l'instant de
// chaque mot, l'affichage peut le sortir a l'heure.
//
// Deux conditions, verifiees sur nos fichiers :
//   - le modele doit avoir `alignment_heads` dans generation_config.json
//     (tiny 6, base 8, small 10) ;
//   - l'export ONNX doit SORTIR les attentions croisees (`cross_attentions.N`),
//     sinon Transformers.js leve « Model outputs must contain cross attentions ».
// Les trois modeles remplissent les deux conditions.
//
// CE QUE CA COUTE, mesure au banc le 2026-08-20 (test-bruit.html) :
//   - +20 % de temps par passe sur une fenetre de 11-12 s (2,0 s -> 2,4 s) ;
//   - rapport identique (+18 %) sur une machine trois fois plus lente, donc ce
//     n'est pas un effet de mesure ;
//   - PLAT sur 14 passes consecutives du meme worker : rien ne s'accumule, un
//     worker peut vivre toute une session.
// Le seuil qu'on s'etait donne pour renoncer etait +40 %. On est a la moitie.
//
// ⚠️ Ne pas se fier a un chiffre absolu pris en fin de seance de mesure : le
// meme fragment passe de 2,1 s a 7,7 s quand la machine a deja charge une
// vingtaine de modeles, SANS horodatage. Seul le rapport entre deux variantes
// mesurees en alternance veut dire quelque chose.
const HORODATAGE_DEFAUT = "word";
const horodatageDemande = PARAMETRES.get("horodatage");
const HORODATAGE =
  horodatageDemande === "non" ? null : horodatageDemande || HORODATAGE_DEFAUT;

// Change des que le modele, la precision ou le niveau d'optimisation change.
// Une mesure memorisee qui ne porte pas la meme signature est jetee : elle ne
// dit plus rien d'utile.
// (L'horodatage en fait partie : il change le cout d'une passe, donc une mesure
// de backend faite sans lui ne vaut pas pour une session avec.)
const SIGNATURE = `${MODEL}|${JSON.stringify(DTYPE)}|${OPTIMISATION}${
  HORODATAGE ? `|ts=${HORODATAGE}` : ""
}`;

// ---------------------------------------------------------------------------
// Choix du backend : on MESURE, on ne suppose pas
// ---------------------------------------------------------------------------
//
// Contre-intuitif mais mesure : sur un GPU integre (Intel Iris Xe), WebGPU est
// ~2x plus LENT que le CPU sur whisper-tiny. Le decodeur enchaine des dizaines
// de toutes petites etapes, et le cout de lancement de chaque calcul sur le GPU
// depasse le gain de parallelisme. Sur une carte dediee, c'est l'inverse.
//
// D'ou ce choix : au tout premier lancement on chronometre les deux backends
// sur la meme charge, on garde le plus rapide, et la page memorise le gagnant
// dans chrome.storage. Les lancements suivants ne mesurent plus rien.
//
// (Le worker ne touche pas lui-meme a chrome.storage : `chrome` est indefini
// dans un worker dedie -- verifie. C'est la page qui lit et ecrit la mesure,
// et qui nous la repasse dans le message "init".)

// Quel backend tourne reellement. Renvoye a la page pour pouvoir comparer.
let backend = null;

// `navigator.gpu` peut exister alors qu'aucun adaptateur n'est utilisable
// (GPU sur liste noire, pilote trop vieux, machine virtuelle...). Seul
// requestAdapter() dit la verite -- et il ne jette pas, il renvoie null.
async function webgpuDisponible() {
  if (!self.navigator?.gpu) return false;
  try {
    return (await navigator.gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

function construirePipeline(device) {
  return pipeline("automatic-speech-recognition", MODEL, {
    device,
    dtype: DTYPE,
    session_options: SESSION_OPTIONS,
    // Suit le telechargement des fichiers du modele et le remonte a la page.
    progress_callback: (etat) => {
      if (etat.status === "progress" && etat.progress != null) {
        self.postMessage({
          type: "progress",
          fichier: etat.file,
          pourcent: Math.round(etat.progress),
          // Taille totale du fichier, en octets. Sert a la page de comparaison
          // pour chiffrer le poids reel de chaque variante du modele.
          octets: etat.total ?? null,
        });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// La charge de test qui sert a comparer les deux backends
// ---------------------------------------------------------------------------

// 5 s de bruit deterministe (generateur pseudo-aleatoire a graine fixe) : la
// meme charge exactement a chaque lancement et sur les deux backends, sinon la
// comparaison ne veut rien dire. Le CONTENU importe peu, seul le temps compte.
function audioDeTest() {
  const audio = new Float32Array(16000 * 5);
  let graine = 12345;
  for (let i = 0; i < audio.length; i++) {
    // Generateur congruentiel lineaire : reproductible, sans Math.random().
    graine = (graine * 1103515245 + 12345) & 0x7fffffff;
    audio[i] = (graine / 0x7fffffff) * 2 - 1;
  }
  return audio;
}

const AUDIO_TEST = audioDeTest();

// min = max : on force EXACTEMENT 32 etapes de decodage. Sans ca, le modele
// s'arreterait quand il veut (sur du bruit, souvent tout de suite) et on ne
// mesurerait que l'encodeur -- alors que c'est justement la boucle de decodage
// qui fait perdre le GPU integre. On veut mesurer les deux.
const OPTIONS_TEST = {
  language: "english",
  min_new_tokens: 32,
  max_new_tokens: 32,
};

// Nombre de passages chronometres, dont on garde le MEILLEUR.
//
// Un passage unique n'est pas fiable : selon ce que fait la machine a cet
// instant, le meme backend a donne 2,4 s ou 6,5 s d'une mesure a l'autre --
// assez pour inverser le classement, et ce classement est memorise pour de
// bon. On garde donc le minimum : une machine occupee ne peut qu'AJOUTER du
// temps, jamais en retirer. Le minimum est donc l'estimation la plus propre
// de ce dont le backend est capable.
const PASSAGES_MESURE = 3;

// Charge un backend, le rode, et le chronometre si demande.
//
// Le rodage n'est pas un luxe : sur WebGPU la premiere inference compile les
// shaders (plusieurs secondes), et la chronometrer donnerait un chiffre faux.
// Il sert aussi de TEST : sur GPU, ce qui casse casse a l'execution (operateur
// non supporte, memoire), pas au chargement. Renvoie null si le backend ne
// tient pas debout -- l'appelant ira voir ailleurs.
async function essayerBackend(device, chronometrer) {
  try {
    const transcrire = await construirePipeline(device);

    // Rodage. On ne force le nombre de jetons QUE si on va chronometrer : hors
    // mesure, autant faire tourner le modele dans ses conditions normales.
    await transcrire(AUDIO_TEST, chronometrer ? OPTIONS_TEST : { language: "english" });

    let ms = null;
    if (chronometrer) {
      ms = Infinity;
      for (let passage = 0; passage < PASSAGES_MESURE; passage++) {
        const debut = performance.now();
        await transcrire(AUDIO_TEST, OPTIONS_TEST);
        ms = Math.min(ms, performance.now() - debut);
      }
      ms = Math.round(ms);
    }
    return { transcrire, ms };
  } catch (error) {
    self.postMessage({
      type: "info",
      message: `Backend ${device} inutilisable (${error?.message || error}).`,
    });
    return null;
  }
}

// Chronometre UN backend dans un worker tout neuf, puis jette ce worker.
//
// Pourquoi un worker separe plutot que mesurer les deux ici ? Parce qu'ONNX
// Runtime ne charge qu'UN SEUL moteur WASM par worker, et que c'est le premier
// backend initialise qui l'impose a tous les suivants. Mesurer le CPU dans le
// worker qui vient d'initialiser le GPU le fait tourner sur le moteur du GPU
// (la variante `asyncify`, plus lente) : mesure a 8,5 s au lieu de 2,3 s, et
// le classement s'inverse. Un worker par backend, c'est exactement les
// conditions de production -- ou le worker ne charge qu'un seul backend.
//
// Renvoie le temps en ms, ou null si ce backend ne marche pas ici.
function mesurerDansUnEnfant(device) {
  return new Promise((resolve) => {
    // self.location.href = ce fichier meme : l'enfant est une copie de nous.
    // Il recoit `forcer`, donc il ne remesurera pas a son tour (pas de boucle).
    const enfant = new Worker(self.location.href, { type: "module" });

    const finir = (ms) => {
      enfant.terminate();
      resolve(ms);
    };

    enfant.onmessage = (event) => {
      const m = event.data;
      if (m.type === "ready") finir(m.msMesure ?? null);
      else if (m.type === "error") finir(null);
    };
    enfant.onerror = () => finir(null);

    enfant.postMessage({ type: "init", forcer: device, mesurer: true });
  });
}

// ---------------------------------------------------------------------------
// Chargement du modele
// ---------------------------------------------------------------------------

let transcrirePromise = null;
// Renseigne uniquement le jour ou on mesure. La page l'affiche et le memorise.
let mesures = null;
// Notre propre temps mesure, quand on EST le worker enfant d'une mesure.
let msMesure = null;

// Charge le backend demande, en se rabattant sur le CPU s'il ne repond pas.
async function chargerAvecRepli(device) {
  const essai = await essayerBackend(device, false);
  if (essai) {
    backend = device;
    return essai.transcrire;
  }

  if (device === "wasm") throw new Error("Impossible de charger le modele sur le CPU.");

  self.postMessage({
    type: "info",
    message: `Backend ${device} indisponible -> repli sur le CPU (WASM).`,
  });
  const repli = await essayerBackend("wasm", false);
  if (!repli) throw new Error("Impossible de charger le modele sur le CPU.");
  backend = "wasm";
  return repli.transcrire;
}

// Le modele est-il vraiment la ?
//
// Sans ce controle, un models/ absent donnerait « Impossible de charger le
// modele sur le CPU » -- vrai, mais inexploitable : on chercherait du cote du
// backend alors qu'il manque juste des fichiers. Avec allowRemoteModels a
// false, il n'y a plus de repli silencieux sur internet, donc l'erreur doit
// dire quoi faire. Meme esprit que le message sur vendor/ dans offscreen.js.
//
// Une requete locale (chrome-extension://), pas un aller sur le reseau.
async function verifierModeleLocal() {
  const base = `${env.localModelPath}${MODEL}/`;
  try {
    const reponse = await fetch(base + "config.json");
    if (reponse.ok) return;
  } catch {
    // fetch jette sur un fichier absent d'une extension : meme conclusion.
  }
  throw new Error(
    `Modele introuvable : ${MODEL} n'est pas dans models/. ` +
      "Lance `npm run build:model` (une seule fois, il faut internet), puis " +
      "recharge l'extension. Rien n'est telecharge au demarrage : " +
      "env.allowRemoteModels vaut false, et c'est voulu."
  );
}

// Decide quel backend utiliser, et renvoie le pipeline correspondant.
// `memo` vient de chrome.storage via la page : { backend, signature } ou null.
async function choisirBackend({ memo, forcer, mesurer }) {
  // En premier : si les fichiers manquent, aucun backend ne marchera, et
  // l'utilisateur merite de savoir pourquoi.
  await verifierModeleLocal();

  // --- Cas 0 : on est le worker enfant d'une mesure. -------------------------
  // Un seul backend impose, aucun repli : si ce backend ne marche pas, le
  // parent doit le savoir, pas recevoir le chiffre d'un autre backend.
  if (forcer) {
    const essai = await essayerBackend(forcer, mesurer);
    if (!essai) throw new Error(`Backend ${forcer} indisponible.`);
    backend = forcer;
    msMesure = essai.ms;
    return essai.transcrire;
  }

  const gpuOk = await webgpuDisponible();

  // --- Cas 1 : on a deja mesure sur cette machine -> on suit la memoire. -----
  // Un memo "webgpu" sur une machine sans GPU (pilote desactive depuis) est
  // caduc : on retombe alors sur la mesure, plus bas.
  if (memo?.signature === SIGNATURE && (memo.backend === "wasm" || gpuOk)) {
    return chargerAvecRepli(memo.backend);
  }

  // --- Cas 2 : pas de GPU du tout -> rien a comparer. ------------------------
  if (!gpuOk) return chargerAvecRepli("wasm");

  // --- Cas 3 : premier lancement avec un GPU -> on chronometre les deux. -----
  self.postMessage({
    type: "info",
    message: "Premier lancement : mesure du GPU et du CPU (une seule fois).",
  });

  // Sequentiel, surtout pas en parallele : deux inferences en meme temps se
  // voleraient la machine et fausseraient les deux chiffres.
  const msGpu = await mesurerDansUnEnfant("webgpu");
  const msCpu = await mesurerDansUnEnfant("wasm");

  mesures = { webgpu: msGpu, wasm: msCpu };

  // A egalite, ou si le GPU n'a pas repondu, le CPU gagne : c'est le chemin le
  // plus sur, sans dependance au pilote graphique.
  const gpuGagne = msGpu != null && (msCpu == null || msGpu < msCpu);
  return chargerAvecRepli(gpuGagne ? "webgpu" : "wasm");
}

// Charge le modele une seule fois, meme si plusieurs messages arrivent avant
// la fin du chargement : tout le monde attend la meme promesse.
function chargerModele(message) {
  if (transcrirePromise) return transcrirePromise;

  transcrirePromise = choisirBackend(message);

  // Si tout echoue, on oublie la promesse ratee pour qu'un prochain message
  // puisse retenter, au lieu de rejouer eternellement la meme erreur.
  transcrirePromise.catch(() => {
    transcrirePromise = null;
    backend = null;
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
//   { type: "init", memo }              memo = { backend, signature } ou null,
//                                       relu depuis chrome.storage par la page
//   { type: "transcribe", id, audio: Float32Array (16 kHz mono), langue }
//     `langue` est facultative : absente, on applique LANGUE_DEFAUT. Elle n'est
//     jamais laissee a la detection automatique.
// Worker -> worker enfant (mesure, usage interne) :
//   { type: "init", forcer: "webgpu"|"wasm", mesurer: true }
//     -> l'enfant repond "ready" avec msMesure, puis on le jette.
// Worker -> page :
//   { type: "ready", ms, backend, signature, mesures }
//   { type: "progress", fichier, pourcent }
//   { type: "result", id, texte, ms, backend }
//   { type: "info", message }           mesure en cours, repli... non bloquant
//   { type: "error", id?, message }
//
// `backend` vaut "webgpu" (carte graphique) ou "wasm" (processeur).
// `mesures` = { webgpu, wasm } en ms, uniquement le jour ou on a mesure ;
// null les fois suivantes. La page DOIT ranger { backend, signature } dans
// chrome.storage a la reception de "ready" : c'est ce qui evite de remesurer.

self.onmessage = (event) => {
  const message = event.data;

  if (message.type === "init") {
    enfiler(async () => {
      const debut = performance.now();
      try {
        await chargerModele(message);
        self.postMessage({
          type: "ready",
          ms: Math.round(performance.now() - debut),
          backend,
          signature: SIGNATURE,
          mesures,
          msMesure, // renseigne uniquement si on est un worker enfant de mesure
        });
      } catch (error) {
        self.postMessage({ type: "error", message: String(error?.message || error) });
      }
    });
    return;
  }

  if (message.type === "transcribe") {
    const { id, audio, langue } = message;

    enfiler(async () => {
      try {
        const transcrire = await chargerModele();
        // Chrono demarre APRES le chargement : on veut mesurer l'inference
        // seule, pour comparer honnetement WebGPU et WASM.
        const debut = performance.now();
        // La langue est TOUJOURS imposee : celle du message si elle est
        // fournie, sinon LANGUE_DEFAUT. On ne laisse plus Whisper deviner --
        // sur un segment court il se trompe trop souvent (voir LANGUE_DEFAUT).
        //
        // max_new_tokens borne le temps de calcul : c'est ce qui empeche une
        // boucle de repetition de monopoliser le worker (voir MAX_JETONS).
        const resultat = await transcrire(audio, {
          language: langue || LANGUE_DEFAUT,
          max_new_tokens: MAX_JETONS,
          no_repeat_ngram_size: NO_REPEAT_NGRAM,
          // Absent uniquement si une page de mesure a demande `?horodatage=non`.
          ...(HORODATAGE ? { return_timestamps: HORODATAGE } : {}),
        });

        // `chunks` n'existe que si on a demande les horodatages. Chaque entree
        // vaut { text, timestamp: [debut, fin] }, en SECONDES depuis le debut
        // de l'extrait envoye. On ne transmet que ce dont l'affichage aurait
        // besoin -- le morceau et son debut -- pour ne pas faire voyager un
        // objet enorme a chaque passe.
        //
        // ⚠️ LE TEXTE PART TEL QUEL, SANS `.trim()`, et ce n'est pas un oubli.
        // Un « mot » de Whisper n'est pas un mot typographique : « J'adore, »
        // arrive en DEUX morceaux, « J » puis « 'adore, ». Ce qui distingue
        // « deux morceaux du meme mot » de « deux mots » est justement l'espace
        // qui precede -- « J » puis « 'adore, » se recollent, « je » puis
        // « deteste » non. Trimmer ici effacait la seule information qui permet
        // de le savoir, et l'offscreen n'avait plus aucun moyen d'aligner les
        // instants sur les mots qu'il affiche.
        const mots =
          HORODATAGE && Array.isArray(resultat.chunks)
            ? resultat.chunks.map((c) => ({
                mot: String(c.text || ""),
                debut: Array.isArray(c.timestamp) ? c.timestamp[0] : null,
                fin: Array.isArray(c.timestamp) ? c.timestamp[1] : null,
              }))
            : null;

        self.postMessage({
          type: "result",
          id,
          texte: resultat.text.trim(),
          ms: Math.round(performance.now() - debut),
          backend,
          ...(mots ? { mots } : {}),
        });
      } catch (error) {
        self.postMessage({ type: "error", id, message: String(error?.message || error) });
      }
    });
    return;
  }

  self.postMessage({ type: "error", message: `Message inconnu : ${message.type}` });
};
