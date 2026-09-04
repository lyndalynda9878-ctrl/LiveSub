// ---------------------------------------------------------------------------
// COMBIEN DE FILS POUR LE MOTEUR ? — mesure sur le worker DE PRODUCTION
// ---------------------------------------------------------------------------
//
// La question a laquelle cette page repond, et une seule :
//
//   « Un bloc de la taille de ceux de la preparation coute combien de temps,
//     selon le nombre de fils qu'on donne a ONNX Runtime ? »
//
// Ce qui la rend utile, c'est qu'elle n'utilise AUCUNE copie du moteur : elle
// instancie `parakeet.worker.js`, le fichier que la preparation instancie. Une
// page qui mesurerait une variante ne prouverait rien sur la production.
//
// ⚠️ POURQUOI UNE PAGE DE PLUS PLUTOT QUE test-parakeet-worker.html : celle-la
// demande un fichier a la souris. On veut ici une mesure qu'on puisse relancer
// a l'identique en changeant UN parametre, sans qu'un choix de fichier ou une
// duree differente ne se glisse entre deux chiffres qu'on va comparer.
//
// ⚠️ ET ON NE COMPARE QUE DES RAPPORTS. Les chiffres absolus d'un Chrome pilote
// ne valent pas pour la vraie machine (memoire `chrome-pilote-3x-plus-lent`), et
// une seance de mesure s'use (CLAUDE.md). Le rapport 1 fil / N fils, lui, se
// tient -- a condition que les deux chiffres viennent de la meme seance.

const params = new URLSearchParams(location.search);
const FILS = Math.max(1, Math.min(32, parseInt(params.get("fils"), 10) || 1));
const PASSES = Math.max(1, Math.min(10, parseInt(params.get("passes"), 10) || 3));

// 23 s : c'est EXACTEMENT ce que la preparation envoie au moteur pour un bloc
// plein -- PREP_BLOC_CONTENU (20 s de contenu) + PREP_CONTEXTE (3 s de contexte
// audio repris au bloc precedent). Mesurer sur 10 s donnerait un RTF qui ne
// dit rien du regime reel.
const DUREE = Math.max(1, Math.min(60, parseFloat(params.get("duree")) || 23));

const AUDIO = params.get("audio") || "test/extrait-fr-dur-75s.wav";

const zone = document.getElementById("log");
const lignes = [];
function log(texte) {
  lignes.push(texte);
  zone.textContent = lignes.join("\n");
  console.log(texte);
}

// ---------------------------------------------------------------------------
// L'audio
// ---------------------------------------------------------------------------
//
// Fetch d'une ressource de l'extension depuis une page de l'extension : meme
// origine, aucune requete reseau, aucun `web_accessible_resources` a declarer.
async function chargerAudio() {
  const url = chrome.runtime.getURL(AUDIO);
  const reponse = await fetch(url);
  if (!reponse.ok) throw new Error(`${AUDIO} : HTTP ${reponse.status}`);
  const octets = await reponse.arrayBuffer();

  // 16 000 Hz, mono : le taux que le worker attend, et celui que la preparation
  // lui donne apres son reechantillonnage.
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const decode = await ctx.decodeAudioData(octets);
  const canal = decode.getChannelData(0);

  const voulu = Math.round(DUREE * 16000);
  if (canal.length < voulu) {
    throw new Error(
      `${AUDIO} ne dure que ${(canal.length / 16000).toFixed(1)} s, ` +
        `il en faut ${DUREE} s. Choisir un autre fichier avec ?audio=…`
    );
  }
  return canal.slice(0, voulu);
}

// ---------------------------------------------------------------------------
// Le worker
// ---------------------------------------------------------------------------
const worker = new Worker(chrome.runtime.getURL("parakeet.worker.js"), { type: "module" });

worker.onerror = (e) => {
  log(`❌ ECHEC AU CHARGEMENT DU WORKER : ${e.message || "(pas de message)"} ` +
      `[${e.filename || "?"}:${e.lineno || "?"}]`);
};

const attentes = new Map();
let pret = null;
let resoudrePret;
let rejeterPret;
pret = new Promise((r, j) => { resoudrePret = r; rejeterPret = j; });

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "ready") { resoudrePret(m); return; }
  if (m.type === "result") {
    const a = attentes.get(m.id);
    attentes.delete(m.id);
    if (a) a.resolve(m);
    return;
  }
  if (m.type === "error") {
    if (m.id == null) { rejeterPret(new Error(m.message)); return; }
    const a = attentes.get(m.id);
    attentes.delete(m.id);
    if (a) a.reject(new Error(m.message));
  }
};

let prochainId = 1;
function transcrire(pcm) {
  const id = prochainId++;
  // ⚠️ UNE COPIE PAR PASSE. Le tampon est TRANSFERE au worker : apres le
  // premier envoi il est detache, et le renvoyer donnerait « ArrayBuffer is
  // detached » -- une erreur deja payee ailleurs dans ce projet.
  const copie = pcm.slice();
  return new Promise((resolve, reject) => {
    attentes.set(id, { resolve, reject });
    worker.postMessage({ type: "transcribe", id, audio: copie, taux: 16000 }, [copie.buffer]);
  });
}

// ---------------------------------------------------------------------------
// La mesure
// ---------------------------------------------------------------------------
(async () => {
  try {
    log(`Fils demandes : ${FILS} | passes : ${PASSES} | bloc : ${DUREE} s | audio : ${AUDIO}`);
    log(`SharedArrayBuffer dans la PAGE : ${typeof SharedArrayBuffer !== "undefined" ? "present" : "ABSENT"}`);
    log(`crossOriginIsolated dans la PAGE : ${typeof crossOriginIsolated === "undefined" ? "?" : crossOriginIsolated}`);
    log(`Coeurs annonces : ${navigator.hardwareConcurrency}`);
    log("");

    const pcm = await chargerAudio();
    log(`Audio prêt : ${(pcm.length / 16000).toFixed(2)} s à 16 000 Hz.`);

    worker.postMessage({
      type: "init",
      urls: {
        encodeur: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/encoder-model.int8.onnx"),
        decodeur: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/decoder_joint-model.int8.onnx"),
        vocab: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/vocab.txt"),
        preproc: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/nemo128.onnx"),
        config: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/config.json"),
      },
      fils: FILS,
    });

    const infos = await pret;
    log(
      `Modèle chargé en ${(infos.msChargement / 1000).toFixed(1)} s — ` +
        `${infos.filsDemandes} fil(s) demandé(s), ${infos.fils} posé(s), ` +
        `${infos.filsMateriel} matériel, SharedArrayBuffer dans le WORKER : ` +
        `${infos.memoirePartagee ? "présent" : "ABSENT"}.`
    );
    log(`Mémoire WASM : ${infos.memoireWasmMo === null ? "non mesurée" : infos.memoireWasmMo + " Mo"}`);
    log("");

    const temps = [];
    let mots = 0;
    // ⚠️ LE TEXTE, PAS SEULEMENT LE CHRONO. Une variante plus rapide qui ne rend
    // pas le meme texte n'est pas plus rapide, elle est fausse — lecon deja payee
    // avec WebGPU (« d'etoil » au lieu de « d'etoiles »). On garde donc les mots
    // separes par « | » pour qu'une comparaison entre deux relevés soit exacte.
    let texte = "";
    for (let i = 1; i <= PASSES; i++) {
      const t0 = performance.now();
      const res = await transcrire(pcm);
      const ms = performance.now() - t0;
      temps.push(ms);
      mots = (res.words || []).length;
      texte = (res.words || []).map((m) => m.text).join("|");
      log(
        `passe ${i} : ${(ms / 1000).toFixed(2)} s — RTF ${(ms / 1000 / DUREE).toFixed(3)} — ` +
          `${mots} mots — mémoire WASM ${res.memoireWasmMo ?? "?"} Mo`
      );
    }

    // ⚠️ LE MEILLEUR DES PASSES, PAS LA MOYENNE. Une machine occupee ne peut
    // qu'AJOUTER du temps : le minimum est la mesure la moins polluee. Meme
    // regle que pour le choix de backend du temps de Whisper.
    const meilleur = Math.min(...temps);
    const rtf = meilleur / 1000 / DUREE;
    log("");
    log(`MEILLEUR : ${(meilleur / 1000).toFixed(2)} s pour ${DUREE} s d'audio → RTF ${rtf.toFixed(3)}`);
    // Le seuil n'est pas une opinion : pour suivre une video a x2, il faut
    // transcrire PREP_BLOC_CONTENU (20 s) + PREP_CONTEXTE (3 s) dans les 10 s
    // que la video met a livrer ces 20 s de contenu.
    const seuil = 10 / DUREE;
    log(
      `Seuil pour tenir le défilement à x2 : RTF < ${seuil.toFixed(3)} — ` +
        (rtf < seuil
          ? `✅ TENU, avec ${((1 - rtf / seuil) * 100).toFixed(0)} % de marge.`
          : `❌ PAS TENU : ${((rtf / seuil - 1) * 100).toFixed(0)} % de trop. ` +
            `La file prendra ${((rtf * DUREE - 10) * 2).toFixed(1)} s de contenu de retard par bloc.`)
    );

    window.RESULTAT = { fils: FILS, filsPoses: infos.fils, duree: DUREE, temps, meilleur, rtf, seuil, mots, texte,
                        memoirePartagee: infos.memoirePartagee, memoireWasmMo: infos.memoireWasmMo };
    log("");
    log("Fini. window.RESULTAT contient le relevé.");
  } catch (err) {
    log(`❌ ${err && err.message ? err.message : err}`);
    window.RESULTAT = { erreur: String((err && err.message) || err) };
  }
})();
