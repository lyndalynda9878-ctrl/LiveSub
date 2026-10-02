// Obtenir la transcription REELLE de test/extrait-fr-dur.wav, telle que
// Parakeet la produit -- c'est la matiere des mesures de traduction.
//
// ⚠️ Le texte est derive de res.words, JAMAIS de res.utterance_text :
// parakeet.js avale l'espace devant les accents (CLAUDE.md, « Le bug de
// parakeet.js »). En francais, utterance_text donnerait « premieresetoiles ».
//
// Cette page ne touche a aucun fichier de production : elle IMPORTE
// parakeet.worker.js tel quel, sans le modifier.

const etatDiv = document.getElementById("etat");
const texteDiv = document.getElementById("texte");
const logDiv = document.getElementById("log");
const lignes = [];

function log(m) {
  console.log(m);
  lignes.push(m);
  logDiv.textContent = lignes.join("\n");
}

// Le meme recollage que le worker de production : ce qui distingue deux
// morceaux du meme mot de deux mots differents, c'est le marqueur d'espace.
// On exclut lettres et chiffres au sens UNICODE (\p{L}\p{N}, drapeau u) --
// avec \w, tout accent serait pris pour de la ponctuation.
function texteDepuisMots(mots) {
  let out = "";
  for (const m of mots) {
    const brut = m.word ?? m.text ?? "";
    if (!out) { out = brut.trim(); continue; }
    out += /^[^\p{L}\p{N}]/u.test(brut.trim()) ? brut.trim() : " " + brut.trim();
  }
  return out;
}

async function main() {
  etatDiv.textContent = "decodage du .wav...";
  const url = chrome.runtime.getURL(new URLSearchParams(location.search).get("wav") || "bancs/audio/extrait-fr-dur.wav");
  log("audio : " + url);

  const buf = await (await fetch(url)).arrayBuffer();
  const ctx = new AudioContext({ sampleRate: 16000 });
  const audio = await ctx.decodeAudioData(buf);

  // Moyenne des deux canaux si stereo -- meme regle que preparation.worklet.js.
  let pcm;
  if (audio.numberOfChannels === 1) {
    pcm = new Float32Array(audio.getChannelData(0));
  } else {
    const g = audio.getChannelData(0), d = audio.getChannelData(1);
    pcm = new Float32Array(g.length);
    for (let i = 0; i < g.length; i++) pcm[i] = (g[i] + d[i]) / 2;
  }
  log(`wav : ${audio.numberOfChannels} canal(aux), ${(pcm.length / 16000).toFixed(2)} s a 16000 Hz`);

  etatDiv.textContent = "chargement du modele dans le worker...";
  const worker = new Worker(chrome.runtime.getURL("parakeet.worker.js"), { type: "module" });

  const fini = new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") {
        log(`worker pret en ${(m.msChargement / 1000).toFixed(1)} s, bundle=${m.bundle}, fils=${m.fils}, wasm=${m.memoireWasmMo} Mo`);
        etatDiv.textContent = "transcription...";
        worker.postMessage({ type: "transcribe", id: 1, audio: pcm, taux: 16000 }, [pcm.buffer]);
      } else if (m.type === "result") {
        resolve(m);
      } else if (m.type === "error") {
        reject(new Error(m.message + "\n" + (m.journal || []).join("\n")));
      }
    };
    worker.onerror = (e) => reject(new Error("worker.onerror : " + e.message));
  });

  worker.postMessage({ type: "init" });
  const res = await fini;

  const texte = texteDepuisMots(res.words);
  log(`transcrit : ${res.words.length} mots en ${(res.msBrut / 1000).toFixed(2)} s`);
  log(`contre-preuve utterance_text (doit etre casse sur les accents) : ${String(res.texteLibrairie).slice(0, 160)}`);

  texteDiv.textContent = texte;
  etatDiv.textContent = "OK";

  // Point de lecture pour l'outil de mesure.
  window.RESULTAT = {
    texte,
    mots: res.words.length,
    motsTexte: texte.split(/\s+/).filter(Boolean).length,
    caracteres: texte.length,
    msBrut: res.msBrut,
    texteLibrairie: res.texteLibrairie,
    dureeAudioS: pcm.length ? undefined : undefined,
  };
  worker.terminate();
  log("worker termine (1,3 Go de WASM rendus a la machine)");
}

main().catch((e) => {
  etatDiv.textContent = "ECHEC";
  log("ECHEC : " + e.message);
  window.RESULTAT = { erreur: e.message };
});
