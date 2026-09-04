// ---------------------------------------------------------------------------
// COMBIEN DE FILS DANS LE DOCUMENT OFFSCREEN ? — la seule mesure qui compte
// ---------------------------------------------------------------------------
//
// `test-fils.html` mesure les fils dans une PAGE d'extension. La production, elle,
// ne tourne pas dans une page : elle tourne dans un DOCUMENT OFFSCREEN, et
// CLAUDE.md pose depuis le 30/08/2026 la question restee ouverte — l'isolation
// d'origine croisee peut y differer, donc `SharedArrayBuffer` peut y manquer.
// Un « 4 fils » mesure dans une page ne prouve rien ici.
//
// ⚠️ CETTE PAGE N'EST PAS OUVERTE A LA MAIN. Elle est lancee par le service
// worker via `chrome.offscreen.createDocument({ reasons: ['USER_MEDIA'] })` —
// la meme raison que `offscreen.html` en production. L'ouvrir dans un onglet en
// ferait une page ordinaire, et on remesurerait ce qu'on sait deja.
//
// ⚠️ ET ELLE REND SON RELEVE PAR MESSAGE, pas par `chrome.storage` : le storage
// est indisponible dans un document offscreen (lecon deja payee, voir CLAUDE.md).

const params = new URLSearchParams(location.search);
const FILS = Math.max(1, Math.min(32, parseInt(params.get("fils"), 10) || 1));
const PASSES = Math.max(1, Math.min(10, parseInt(params.get("passes"), 10) || 3));
const DUREE = 23; // PREP_BLOC_CONTENU (20 s) + PREP_CONTEXTE (3 s), comme la production.
const AUDIO = "test/extrait-fr-dur-75s.wav";

const journal = [];
function noter(texte) { journal.push(texte); }

function rendre(charge) {
  chrome.runtime.sendMessage({ type: "MESURE_FILS_OFFSCREEN", fils: FILS, journal, ...charge });
}

async function chargerAudio() {
  const reponse = await fetch(chrome.runtime.getURL(AUDIO));
  if (!reponse.ok) throw new Error(`${AUDIO} : HTTP ${reponse.status}`);
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const decode = await ctx.decodeAudioData(await reponse.arrayBuffer());
  return decode.getChannelData(0).slice(0, Math.round(DUREE * 16000));
}

const worker = new Worker(chrome.runtime.getURL("parakeet.worker.js"), { type: "module" });
const attentes = new Map();
let resoudrePret, rejeterPret;
const pret = new Promise((r, j) => { resoudrePret = r; rejeterPret = j; });

worker.onerror = (e) => rejeterPret(new Error("worker : " + (e.message || "echec au chargement")));
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "ready") return resoudrePret(m);
  if (m.type === "result") { const a = attentes.get(m.id); attentes.delete(m.id); if (a) a.resolve(m); return; }
  if (m.type === "error") {
    if (m.id == null) return rejeterPret(new Error(m.message));
    const a = attentes.get(m.id); attentes.delete(m.id); if (a) a.reject(new Error(m.message));
  }
};

let prochainId = 1;
function transcrire(pcm) {
  const id = prochainId++;
  const copie = pcm.slice(); // le tampon est transfere : une copie par passe.
  return new Promise((resolve, reject) => {
    attentes.set(id, { resolve, reject });
    worker.postMessage({ type: "transcribe", id, audio: copie, taux: 16000 }, [copie.buffer]);
  });
}

(async () => {
  try {
    // Le releve de contexte part AVANT toute transcription : meme si le moteur
    // echoue ensuite, on saura si SharedArrayBuffer etait la, et c'est la
    // question posee.
    const contexte = {
      memoirePartageeDocument: typeof SharedArrayBuffer !== "undefined",
      crossOriginIsolated: typeof crossOriginIsolated === "undefined" ? null : crossOriginIsolated,
      filsMateriel: navigator.hardwareConcurrency,
    };
    noter(`document offscreen : SharedArrayBuffer ${contexte.memoirePartageeDocument ? "present" : "ABSENT"}, `
      + `crossOriginIsolated ${contexte.crossOriginIsolated}, ${contexte.filsMateriel} fil(s) materiel`);

    const pcm = await chargerAudio();
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
    noter(`moteur : ${infos.filsDemandes} fil(s) demande(s), ${infos.fils} pose(s), `
      + `SharedArrayBuffer dans le WORKER ${infos.memoirePartagee ? "present" : "ABSENT"}`);

    const temps = [];
    let mots = 0, texte = "";
    for (let i = 1; i <= PASSES; i++) {
      const t0 = performance.now();
      const res = await transcrire(pcm);
      temps.push(performance.now() - t0);
      mots = (res.words || []).length;
      texte = (res.words || []).map((m) => m.text).join("|");
    }

    // Le meilleur, pas la moyenne : une machine occupee ne peut qu'ajouter du temps.
    const meilleur = Math.min(...temps);
    rendre({
      ok: true, ...contexte,
      filsPoses: infos.fils, memoirePartageeWorker: infos.memoirePartagee,
      msChargement: infos.msChargement, memoireWasmMo: infos.memoireWasmMo,
      temps, meilleur, rtf: meilleur / 1000 / DUREE, seuil: 10 / DUREE, mots, texte,
    });
  } catch (err) {
    rendre({ ok: false, erreur: String((err && err.message) || err) });
  }
})();
