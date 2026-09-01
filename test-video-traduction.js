// Page de test pour la TRADUCTION — fichier de mesure, il ne touche a rien.
//
// `test-video.js` ne sert que /speech.wav (anglais). Il en faut deux ici : une
// video FRANCAISE et une video ANGLAISE, pour verifier les deux sens sans
// changer de page ni de serveur.
//
// Comme test-video.js : une VRAIE page http avec une VRAIE balise <video>.
// content.js n'est pas injecte dans les pages chrome-extension://, et le mode
// pilote un HTMLVideoElement (playbackRate, preservesPitch, currentTime).
//
// Le bouton « Charger » est le GESTE UTILISATEUR : sans lui, le `play()`
// declenche par l'extension serait refuse par la politique d'autoplay, et on
// croirait a un bug de LiveSub alors que c'est une regle du navigateur.
const http = require("http");
const fs = require("fs");
const path = require("path");

const RACINE = __dirname;

const PAGE = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Trous noirs — documentaire</title>
<style>
  body { font-family: system-ui, Arial, sans-serif; padding: 24px; background: #111; color: #eee; }
  video { width: 720px; height: 220px; background: #000; border: 2px solid #4f46e5; border-radius: 8px; }
  button { font-size: 18px; padding: 10px 18px; border-radius: 8px; border: none;
           background: #4f46e5; color: #fff; cursor: pointer; }
  select { font-size: 15px; padding: 6px; }
  #infos { font-family: ui-monospace, monospace; margin-top: 12px; font-size: 13px; }
</style></head>
<body>
  <h1>Trous noirs — documentaire</h1>
  <p>Clique <strong>Charger</strong> (geste utilisateur obligatoire), puis lance
     « Demarrer » depuis la popup LiveSub.</p>
  <p>
    <label>source
      <select id="source">
        <option value="/extrait-fr-dur.wav" selected>francais (ARTE, trous noirs)</option>
        <option value="/extrait-en.wav">anglais (Kurzgesagt, black holes)</option>
      </select>
    </label>
    <label>durée
      <select id="minutes">
        <option value="1.5">1 min 30</option>
        <option value="3">3 min</option>
        <option value="6">6 min</option>
        <option value="9" selected>9 min</option>
        <option value="18">18 min</option>
      </select>
    </label>
    <button id="charger">Charger la video</button>
  </p>
  <video id="v" controls></video>
  <div id="infos">pas encore chargee</div>

<script>
const TAUX = 16000;

function construireWav(audio, taux) {
  const n = audio.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const dv = new DataView(buf);
  const txt = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  txt(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); txt(8, "WAVE");
  txt(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, taux, true);
  dv.setUint32(28, taux * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  txt(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, audio[i]));
    dv.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

window.CHARGEE = null;

async function charger() {
  const minutes = Number(document.getElementById("minutes").value);
  const source = document.getElementById("source").value;
  const infos = document.getElementById("infos");
  infos.textContent = "decodage...";

  const donnees = await (await fetch(source)).arrayBuffer();
  const ctx = new AudioContext({ sampleRate: TAUX });
  const decode = await ctx.decodeAudioData(donnees);
  const mono = decode.getChannelData(0);
  ctx.close();

  const fois = Math.max(1, Math.round((minutes * 60 * TAUX) / mono.length));
  const total = new Float32Array(mono.length * fois);
  for (let i = 0; i < fois; i++) total.set(mono, i * mono.length);

  const v = document.getElementById("v");
  v.src = URL.createObjectURL(construireWav(total, TAUX));
  await new Promise((r) => { v.onloadedmetadata = r; });

  // Le geste utilisateur est encore chaud : on joue puis on met en pause tout de
  // suite. Ca accorde a l'element le droit de rejouer plus tard sans nouveau
  // clic -- c'est ce dont l'extension a besoin.
  try { await v.play(); v.pause(); v.currentTime = 0; } catch (e) {}

  window.CHARGEE = { source, dureeS: v.duration, repetitions: fois };
  infos.textContent =
    "source " + source + " — duree " + v.duration.toFixed(1) + " s (" + fois + " repetitions) — prete";
}

document.getElementById("charger").addEventListener("click", charger);
</script>
</body></html>`;

const FICHIERS = {
  "/extrait-fr-dur.wav": ["test/extrait-fr-dur.wav", "audio/wav"],
  "/extrait-en.wav": ["test/extrait-en.wav", "audio/wav"],
};

http
  .createServer((req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    const entree = FICHIERS[url];
    if (entree) {
      const donnees = fs.readFileSync(path.join(RACINE, entree[0]));
      res.writeHead(200, { "Content-Type": entree[1], "Content-Length": donnees.length });
      return res.end(donnees);
    }
    res.writeHead(404);
    res.end("non trouve");
  })
  .listen(8733, () => console.log("Page video de test (traduction) sur http://localhost:8733"));
