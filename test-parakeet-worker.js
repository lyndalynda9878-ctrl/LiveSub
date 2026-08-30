// Etape 3 : prouver que Parakeet transcrit depuis un WEB WORKER de l'extension.
//
// Cette page ne calcule RIEN. Elle decode le .wav, envoie les echantillons au
// worker, et affiche ce qu'il renvoie. Tout ce qui touche a ONNX Runtime vit
// dans parakeet.worker.js.
//
// Elle ne touche a rien de la production : ni offscreen.js, ni content.js, ni
// whisper.worker.js. Whisper reste le moteur de l'extension.
//
// ⚠️ Ce qui est VRAIMENT teste ici, et qui n'allait pas de soi :
//   - un worker de type "module" cree par chrome.runtime.getURL passe la CSP
//     de MV3 (une URL blob:, elle, serait bloquee) ;
//   - 652 Mo de poids se chargent dans un worker sans faire tomber l'onglet ;
//   - le worker rend EXACTEMENT le meme resultat que la page de l'etape 2.

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------
const logDiv = document.getElementById("log");
const journalWorkerDiv = document.getElementById("journalWorker");
const preuveDiv = document.getElementById("preuve");
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

// ---------------------------------------------------------------------------
// Le battement du fil principal — la piece a conviction
// ---------------------------------------------------------------------------
//
// ⚠️ « le compteur tourne » ne prouve rien : une barre de progression ne prouve
// que l'ecoulement du temps (CLAUDE.md). Ce qu'on veut savoir, c'est si le fil
// principal a ete BLOQUE. On enregistre donc l'instant de chaque battement et
// on regarde le PLUS GRAND ECART entre deux.
//
// A l'etape 2, l'inference tournait dans la page : le WASM d'ONNX Runtime est
// synchrone, donc aucun `setInterval` ne pouvait se declencher pendant tout le
// calcul. L'ecart maximum valait la duree de la transcription entiere. Ici il
// doit rester de l'ordre de la periode demandee.
const PERIODE_BATTEMENT = 100;
let timer = null;
let ticks = 0;
let battements = [];

function demarrerIndicateur(libelle) {
  indicateurDiv.querySelector(".libelle").textContent = libelle;
  indicateurDiv.hidden = false;
  ticks = 0;
  battements = [performance.now()];
  clearInterval(timer);
  timer = setInterval(() => {
    battements.push(performance.now());
    ticks += 1;
    compteurSpan.textContent = `${(ticks / 10).toFixed(1)} s ` + ".".repeat(1 + (ticks % 3));
  }, PERIODE_BATTEMENT);
}

function arreterIndicateur() {
  clearInterval(timer);
  timer = null;
  indicateurDiv.hidden = true;
}

function bilanBattements() {
  let ecartMax = 0;
  for (let i = 1; i < battements.length; i++) {
    ecartMax = Math.max(ecartMax, battements[i] - battements[i - 1]);
  }
  return { nombre: battements.length, ecartMaxMs: Math.round(ecartMax) };
}

// ---------------------------------------------------------------------------
// Decodage audio : .wav -> Float32Array a 16 kHz, mono
// ---------------------------------------------------------------------------
//
// Identique a l'etape 2, pour que la comparaison soit honnete : si l'audio
// n'entrait pas pareil, le texte pourrait differer pour une raison qui n'a rien
// a voir avec le worker.
//
// Si le fichier est stereo on prend la MOYENNE des deux canaux, jamais un seul
// (lecon du point « 5 bis » de CLAUDE.md).
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
  const infos = { canaux: audio.numberOfChannels, duree: copie.length / 16000 };
  await ctx.close();
  return { pcm: copie, infos };
}

// ---------------------------------------------------------------------------
// Le worker
// ---------------------------------------------------------------------------
//
// ⚠️ `chrome.runtime.getURL`, PAS une URL blob:. La CSP d'une extension MV3
// bloque `worker-src blob:` -- c'est la meme contrainte qui force
// `numThreads = 1` dans tout le projet (ONNX Runtime demarre ses fils par des
// blob:). C'est comme ca que whisper.worker.js est cree, on ne fait pas
// autrement.
//
// `type: "module"` pour que le worker puisse faire ses `import`.
const urlWorker = chrome.runtime.getURL("parakeet.worker.js");
log("Worker : " + urlWorker);

const worker = new Worker(urlWorker, { type: "module" });

// Une erreur de CHARGEMENT du worker (CSP, syntaxe, import introuvable) n'arrive
// PAS dans onmessage : elle arrive ici. Sans ce gestionnaire, un worker mort
// laisserait la page attendre indefiniment -- exactement le blocage muet decrit
// dans CLAUDE.md.
worker.onerror = (e) => {
  arreterIndicateur();
  log(`ECHEC AU CHARGEMENT DU WORKER : ${e.message || "(pas de message)"} `
    + `[${e.filename || "?"}:${e.lineno || "?"}]`, "err");
  log("Si le message parle de Content Security Policy, c'est la CSP de MV3. "
    + "Si le dossier models/parakeet-tdt-0.6b-v3/ est absent, c'est NORMAL : "
    + "rien n'est telecharge sur internet.", "err");
};

// Les URL des modeles sont construites ICI, par la page, avec
// chrome.runtime.getURL -- `chrome.*` n'est pas disponible dans un worker dedie
// (verifie, voir CLAUDE.md). Le worker les recoit dans `init`.
const urlsModele = {
  encodeur: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/encoder-model.int8.onnx"),
  decodeur: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/decoder_joint-model.int8.onnx"),
  vocab: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/vocab.txt"),
  preproc: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/nemo128.onnx"),
  config: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/config.json"),
};

let infosPret = null;
let dureeCourante = 0;
let nomCourant = "";
let envoiMs = 0;

function afficherJournalWorker(lignes) {
  if (!lignes || !lignes.length) return;
  journalWorkerDiv.textContent = lignes.map((l) => "[PARAKEET-WORKER] " + l).join("\n");
}

worker.onmessage = (event) => {
  const m = event.data || {};

  if (m.type === "ready") {
    infosPret = m;
    arreterIndicateur();
    afficherJournalWorker(m.journal);

    log(`Modele charge par le worker en ${(m.msChargement / 1000).toFixed(1)} s.`, "ok");
    log(`ONNX Runtime ${m.versionOrt || "?"}, bundle ${m.bundle}, ${m.fils} fil(s).`);
    log(`Memoire WASM du worker apres chargement : `
      + `${m.memoireWasmMo === null ? "non mesuree" : m.memoireWasmMo + " Mo"}. `
      + `Tas JS du worker : ${m.tasJsMo === null ? "?" : m.tasJsMo + " Mo"}.`);

    fichierInput.disabled = false;
    log("Pret. Choisissez un fichier .wav ci-dessus.", "ok");
    return;
  }

  if (m.type === "result") {
    const bilan = bilanBattements();
    arreterIndicateur();
    afficherJournalWorker(m.journal);
    afficher(m, bilan);
    return;
  }

  if (m.type === "error") {
    arreterIndicateur();
    afficherJournalWorker(m.journal);
    log("ECHEC cote worker : " + m.message, "err");
    log("Si le dossier models/parakeet-tdt-0.6b-v3/ est absent ou renomme, c'est "
      + "NORMAL que ca echoue : rien n'est telecharge sur internet.", "err");
    return;
  }

  log("Message inconnu du worker : " + JSON.stringify(m).slice(0, 200), "attention");
};

// ---------------------------------------------------------------------------
// Affichage d'un resultat
// ---------------------------------------------------------------------------
function afficher(m, bilan) {
  const mots = m.words || [];
  const secondes = m.msBrut / 1000;
  const rtf = secondes / dureeCourante;

  // --- le texte -----------------------------------------------------------
  //
  // Il vient du worker, qui l'a DERIVE de la liste des mots. On n'affiche jamais
  // `utterance_text` : parakeet.js le recolle avec une expression reguliere ou
  // `\w` est de l'ASCII pur, ce qui mange l'espace devant toute lettre accentuee
  // (« premieresetoiles »). Le texte de la librairie est affiche a cote, pour
  // qu'on VOIE la difference au lieu d'avoir a la croire.
  texteDiv.textContent = m.text;
  console.log("TEXTE (derive des mots) :\n" + m.text);
  console.log("TEXTE DE LA LIBRAIRIE (casse sur les accents) :\n" + m.texteLibrairie);

  // --- les 20 premiers mots ----------------------------------------------
  const lignes = mots.slice(0, 20).map((w) => {
    const conf = typeof w.confidence === "number" ? w.confidence.toFixed(4) : "—";
    return `[${w.start_time.toFixed(3)} -> ${w.end_time.toFixed(3)}] ${w.text} (${conf})`;
  });
  motsDiv.textContent = lignes.join("\n") || "(aucun mot)";

  // --- verification des instants -----------------------------------------
  let croissants = true;
  let chevauchements = 0;
  let precedent = -Infinity;
  let finPrecedente = -Infinity;
  for (const w of mots) {
    if (w.start_time < precedent - 1e-6 || w.end_time < w.start_time - 1e-6) croissants = false;
    if (w.start_time < finPrecedente - 1e-6) chevauchements++;
    precedent = w.start_time;
    finPrecedente = w.end_time;
  }
  const dernierFin = mots.length ? mots[mots.length - 1].end_time : 0;
  const auDela = mots.filter((w) => w.end_time > dureeCourante + 1e-6).length;

  // --- la preuve que le worker a travaille --------------------------------
  //
  // Trois choses independantes, et il en faut trois : prise separement, chacune
  // a une explication paresseuse.
  //   1. le contexte du worker (window absent) -- prouve OU le code tourne ;
  //   2. l'ecart maximum entre deux battements du fil principal PENDANT le
  //      calcul -- prouve que la page n'a pas ete bloquee ;
  //   3. le recouvrement des horloges -- prouve que les battements comptes sont
  //      bien ceux du calcul, et pas ceux d'avant ou d'apres.
  const c = infosPret ? infosPret.contexte : {};
  const battementsPendant = battements.filter(
    (b) => b >= envoiMs && b <= envoiMs + m.msBrut + 2000
  ).length;

  preuveDiv.textContent = [
    `1. OU tourne le code`,
    `   portee globale du worker    : ${c.portee}`,
    `   window y existe ?           : ${c.windowExiste}   (false = ce n'est pas la page)`,
    `   document y existe ?         : ${c.documentExiste}   (false = ce n'est pas la page)`,
    `   chrome.* y existe ?         : ${c.chromeExiste}   (false = worker dedie, comme prevu)`,
    ``,
    `2. LE FIL PRINCIPAL est-il reste libre pendant le calcul ?`,
    `   battements demandes toutes les ${PERIODE_BATTEMENT} ms`,
    `   battements enregistres      : ${bilan.nombre}`,
    `   ECART MAXIMUM entre deux    : ${bilan.ecartMaxMs} ms`,
    `   -> si le calcul tournait dans la page, cet ecart vaudrait`,
    `      la duree entiere de la transcription (${Math.round(m.msBrut)} ms).`,
    ``,
    `3. LES BATTEMENTS COMPTES sont-ils bien ceux du calcul ?`,
    `   battements tombes dans la fenetre de calcul : ${battementsPendant}`,
    `   duree du calcul cote worker : ${Math.round(m.msBrut)} ms`,
  ].join("\n");

  // --- les chiffres -------------------------------------------------------
  const metriques = m.metrics || {};
  const confs = mots.map((w) => w.confidence).filter((x) => typeof x === "number");
  const confMoy = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;

  const rapport = [
    `fichier             : ${nomCourant}`,
    `calcule par         : le worker (parakeet.worker.js)`,
    `duree de l'audio    : ${dureeCourante.toFixed(2)} s`,
    `TEMPS DE CALCUL     : ${secondes.toFixed(2)} s   (chronometre DANS le worker)`,
    `RTF                 : ${rtf.toFixed(3)}`,
    ``,
    `detail parakeet.js  : preprocess ${(metriques.preprocess_ms ?? 0).toFixed(0)} ms, `
      + `encode ${(metriques.encode_ms ?? 0).toFixed(0)} ms, `
      + `decode ${(metriques.decode_ms ?? 0).toFixed(0)} ms`,
    ``,
    `mots                : ${mots.length}`,
    `confiance moyenne   : ${confMoy === null ? "—" : confMoy.toFixed(4)}`,
    `instants croissants : ${croissants ? "OUI" : "NON"}`,
    `mots qui commencent avant la fin du precedent : ${chevauchements}`,
    `dernier end_time    : ${dernierFin.toFixed(3)} s`,
    `mots dates APRES la fin de l'audio : ${auDela}`,
    ``,
    `memoire WASM du worker : ${m.memoireWasmMo === null ? "non mesuree" : m.memoireWasmMo + " Mo"}`,
    `tas JS du worker       : ${m.tasJsMo === null ? "?" : m.tasJsMo + " Mo"}`,
    `tas JS de la page      : ${performance.memory
      ? (performance.memory.usedJSHeapSize / 1048576).toFixed(1) + " Mo"
      : "?"}`,
  ].join("\n");

  chiffresDiv.textContent = rapport;
  console.log("CHIFFRES :\n" + rapport);

  log(`Fini : ${mots.length} mots, ${secondes.toFixed(2)} s de calcul dans le worker. `
    + `Ecart maximum du fil principal : ${bilan.ecartMaxMs} ms.`,
    croissants && auDela === 0 ? "ok" : "attention");

  // Laisse a disposition de la console pour tout recompter sans refaire tourner
  // le modele.
  window.dernierResultat = {
    fichier: nomCourant, duree: dureeCourante, secondes, rtf,
    words: mots, text: m.text, texteLibrairie: m.texteLibrairie, bilan,
  };
}

// ---------------------------------------------------------------------------
// Demarrage
// ---------------------------------------------------------------------------
fichierInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  texteDiv.textContent = "—";
  motsDiv.textContent = "—";
  chiffresDiv.textContent = "—";
  preuveDiv.textContent = "—";

  log("");
  log(`--- ${file.name} (${(file.size / 1024).toFixed(0)} Ko) ---`);

  try {
    const { pcm, infos } = await decoder16k(await file.arrayBuffer());
    dureeCourante = infos.duree;
    nomCourant = file.name;
    log(`Audio decode par la page : ${infos.duree.toFixed(2)} s, `
      + `${infos.canaux} canal(aux) a l'origine, ramene a 16000 Hz mono.`);

    demarrerIndicateur("Transcription DANS LE WORKER");
    envoiMs = performance.now();

    // Le tampon est TRANSFERE (second argument) : pas de copie de 2,8 Mo, et la
    // page perd la main dessus -- ce qui garantit qu'elle ne peut pas travailler
    // dessus en parallele.
    worker.postMessage({ type: "transcribe", id: 1, audio: pcm, taux: 16000 }, [pcm.buffer]);
  } catch (err) {
    arreterIndicateur();
    log("ECHEC cote page : " + (err?.message || err), "err");
    console.error(err);
  }
});

demarrerIndicateur("Chargement du modele dans le worker (652 Mo d'encodeur)");
worker.postMessage({ type: "init", urls: urlsModele });
