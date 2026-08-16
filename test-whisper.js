// Test isole : prouver que Whisper transcrit un extrait audio SANS figer la page.
//
// Volontairement PAS branche sur le VAD ni sur la capture : on valide d'abord le
// worker avec des extraits de test. Ce fichier ne fait plus d'inference : il
// decode l'audio, l'envoie a whisper.worker.js, et affiche le texte recu.
//
// Note : on n'importe PLUS Transformers.js ici. La librairie n'existe que dans
// le worker -- c'est justement ce qui garantit que le fil principal reste libre.

const logDiv = document.getElementById("log");
const indicateurDiv = document.getElementById("indicateur");
const compteurSpan = document.getElementById("compteur");
const progresSpan = document.getElementById("progres");

function log(message, className) {
  console.log(message);
  const line = document.createElement("div");
  line.textContent = message;
  if (className) line.className = className;
  logDiv.appendChild(line);
}

// ---------------------------------------------------------------------------
// Indicateur "la page n'est pas figee"
// ---------------------------------------------------------------------------
//
// Le compteur est mis a jour par un setInterval, donc PAR LE FIL PRINCIPAL :
// s'il continue de defiler pendant l'inference, c'est la preuve que le fil
// principal n'est pas bloque. (Un spinner CSS seul ne prouverait rien : les
// animations CSS tournent sur le compositeur et continuent meme page figee.)
let timer = null;
let ticks = 0;

function demarrerIndicateur(libelle) {
  indicateurDiv.querySelector(".libelle").textContent = libelle;
  progresSpan.textContent = "";
  indicateurDiv.hidden = false;
  ticks = 0;
  clearInterval(timer);
  timer = setInterval(() => {
    ticks += 1;
    const points = ".".repeat(1 + (ticks % 3));
    compteurSpan.textContent = `${(ticks / 10).toFixed(1)} s ${points}`;
  }, 100);
}

function arreterIndicateur() {
  clearInterval(timer);
  timer = null;
  indicateurDiv.hidden = true;
}

// ---------------------------------------------------------------------------
// Decodage audio (reste sur le fil principal, et c'est normal)
// ---------------------------------------------------------------------------
//
// read_audio() de Transformers.js s'appuie sur AudioContext, qui n'existe pas
// dans un Worker. Le decodage reste donc ici -- il ne dure que quelques
// millisecondes, contrairement a l'inference. On reproduit ce que fait
// read_audio : decodage direct a 16 kHz, et melange en mono si stereo.
const SAMPLE_RATE = 16000;

async function decoderEn16kHz(url) {
  const donnees = await (await fetch(url)).arrayBuffer();

  // sampleRate: 16000 => Chrome reechantillonne pendant le decodage.
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const decode = await ctx.decodeAudioData(donnees);

    if (decode.numberOfChannels === 2) {
      const FACTEUR = Math.sqrt(2);
      const gauche = decode.getChannelData(0);
      const droite = decode.getChannelData(1);
      const audio = new Float32Array(gauche.length);
      for (let i = 0; i < gauche.length; i++) {
        audio[i] = (FACTEUR * (gauche[i] + droite[i])) / 2;
      }
      return audio;
    }

    // getChannelData renvoie une vue sur le buffer interne : on copie, sinon on
    // ne peut pas transferer le buffer au worker.
    return new Float32Array(decode.getChannelData(0));
  } finally {
    ctx.close();
  }
}

// ---------------------------------------------------------------------------
// Le worker
// ---------------------------------------------------------------------------

// type: "module" -> le worker peut faire `import` de Transformers.js.
const worker = new Worker(chrome.runtime.getURL("whisper.worker.js"), { type: "module" });

// Chaque demande recoit un id ; la reponse du worker le renvoie, ce qui permet
// de retrouver la promesse a resoudre.
let prochainId = 1;
const enAttente = new Map();

worker.onmessage = (event) => {
  const message = event.data;

  switch (message.type) {
    case "ready":
      enAttente.get("init")?.resolve(message);
      enAttente.delete("init");
      break;

    case "info":
      // Ex : WebGPU a echoue, le worker est reparti sur le CPU. Pas bloquant.
      log(`ℹ️  ${message.message}`);
      break;

    case "progress":
      // Telechargement du modele : une seule ligne, mise a jour en place.
      progresSpan.textContent = `${message.fichier} ${message.pourcent}%`;
      break;

    case "result": {
      enAttente.get(message.id)?.resolve(message);
      enAttente.delete(message.id);
      break;
    }

    case "error": {
      const cle = message.id ?? "init";
      const attente = enAttente.get(cle);
      enAttente.delete(cle);
      if (attente) attente.reject(new Error(message.message));
      else log(`❌ Worker : ${message.message}`, "err");
      break;
    }
  }
};

// Erreur non rattrapee dans le worker (ex : import qui echoue au demarrage).
// On debloque tout ce qui attendait, sinon main() resterait suspendu.
worker.onerror = (event) => {
  arreterIndicateur();
  const erreur = new Error(event.message || "erreur inconnue dans le worker");
  for (const attente of enAttente.values()) attente.reject(erreur);
  enAttente.clear();
};

function attendre(cle) {
  return new Promise((resolve, reject) => enAttente.set(cle, { resolve, reject }));
}

// ---------------------------------------------------------------------------
// Memoire du backend le plus rapide
// ---------------------------------------------------------------------------
//
// Le worker chronometre le GPU et le CPU au tout premier lancement, puis garde
// le plus rapide. On range le verdict ici pour ne PAS refaire la mesure a
// chaque demarrage. C'est la page qui s'en charge et pas le worker : `chrome`
// est indefini dans un worker dedie.
//
// storage.local (et pas .session) : la mesure doit survivre a la fermeture du
// navigateur, c'est une propriete de la machine, pas de la session.
const CLE_BACKEND = "whisperBackend";

async function lireMemoBackend() {
  try {
    return (await chrome.storage.local.get(CLE_BACKEND))[CLE_BACKEND] ?? null;
  } catch {
    // Pas de storage : on remesurera, c'est tout.
    return null;
  }
}

async function ecrireMemoBackend(backend, signature) {
  try {
    await chrome.storage.local.set({ [CLE_BACKEND]: { backend, signature } });
  } catch {
    // Idem : sans memoire on remesure au prochain lancement, rien de casse.
  }
}

async function initialiserWorker() {
  const promesse = attendre("init");
  worker.postMessage({ type: "init", memo: await lireMemoBackend() });

  const pret = await promesse;
  // Toujours reecrire : si le backend memorise s'est revele inutilisable, le
  // worker a bascule et c'est le nouveau choix qu'il faut retenir.
  await ecrireMemoBackend(pret.backend, pret.signature);
  return pret;
}

function transcrire(audio, langue) {
  const id = prochainId++;
  const promesse = attendre(id);
  // 2e argument : liste des buffers TRANSFERES. Le Float32Array change de
  // proprietaire au lieu d'etre copie -- zero copie, meme sur de longs extraits.
  // Attention : apres ca, `audio` est vide cote page (byteLength === 0).
  worker.postMessage({ type: "transcribe", id, audio, langue }, [audio.buffer]);
  return promesse;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const EXTRAITS = [
  { fichier: "test/speech.wav", langue: "english", intitule: "Extrait anglais" },
  { fichier: "test/speech-fr.mp3", langue: "french", intitule: "Extrait francais" },
];

// Le worker renvoie "webgpu" ou "wasm" ; ici on l'ecrit en clair.
const LIBELLE_BACKEND = {
  webgpu: "WebGPU (carte graphique) 🚀",
  wasm: "WASM (processeur)",
};

async function main() {
  logDiv.textContent = "";

  try {
    log("⏳ Chargement du modele dans le worker (premier lancement : telechargement)...");
    demarrerIndicateur("Chargement du modele");

    const pret = await initialiserWorker();
    arreterIndicateur();
    log(`✅ Modele charge en ${Math.round(pret.ms / 1000)} s`, "ok");
    log(`⚙️  Backend : ${LIBELLE_BACKEND[pret.backend] ?? pret.backend}`, "ok");

    if (pret.mesures) {
      // Uniquement au premier lancement : le detail du match GPU / CPU.
      const chiffre = (ms) => (ms == null ? "indisponible" : `${(ms / 1000).toFixed(2)} s`);
      log(`   mesure : GPU ${chiffre(pret.mesures.webgpu)} / CPU ${chiffre(pret.mesures.wasm)}`);
      log("   (verdict memorise : les prochains lancements ne remesurent plus)");
    } else {
      log("   (backend deja mesure sur cette machine, repris de la memoire)");
    }

    for (const extrait of EXTRAITS) {
      log("");
      log(`⏳ ${extrait.intitule} (${extrait.fichier}) ...`);

      const audio = await decoderEn16kHz(chrome.runtime.getURL(extrait.fichier));
      const secondesAudio = (audio.length / SAMPLE_RATE).toFixed(1);
      log(`   ${secondesAudio} s d'audio a 16 kHz`);

      demarrerIndicateur(`Transcription : ${extrait.intitule}`);
      const resultat = await transcrire(audio, extrait.langue);
      arreterIndicateur();

      log(
        `📝 TEXTE TRANSCRIT (${extrait.langue}, ${(resultat.ms / 1000).toFixed(1)} s ` +
          `sur ${resultat.backend}) :`,
        "ok"
      );
      log(`   "${resultat.texte}"`, "ok");
    }

    log("");
    log("✅ Termine : le worker transcrit bien les extraits, sans figer la page.", "ok");

  } catch (error) {
    arreterIndicateur();
    log(`❌ Echec : ${error.message || error}`, "err");
    console.error(error);
  }
}

main();
