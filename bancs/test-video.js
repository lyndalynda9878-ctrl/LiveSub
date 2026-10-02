// Page de test pour le mode « preparer d'abord ».
//
// Il faut une VRAIE page http avec une VRAIE balise <video> : content.js n'est
// pas injecte dans les pages chrome-extension://, et le mode pilote un
// HTMLVideoElement (playbackRate, preservesPitch, currentTime, duration).
//
// La video est construite dans la page a partir de bancs/audio/speech.wav repete :
// l'extrait fait 11 s, il en faut plusieurs minutes pour voir defiler
// plusieurs blocs de 30 s.
//
// Le bouton « Charger » sert de GESTE UTILISATEUR : sans lui, le `play()`
// declenche par l'extension serait refuse par la politique d'autoplay de
// Chrome -- et on croirait a un bug du mode alors que c'est une regle du
// navigateur.
const http = require("http");
const fs = require("fs");
const path = require("path");

const RACINE = __dirname;

const PAGE = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><title>Video de test — LiveSub</title>
<style>
  body { font-family: system-ui, Arial, sans-serif; padding: 24px; background: #111; color: #eee; }
  video { width: 640px; height: 200px; background: #000; border: 2px solid #4f46e5; border-radius: 8px; }
  button { font-size: 18px; padding: 10px 18px; border-radius: 8px; border: none;
           background: #4f46e5; color: #fff; cursor: pointer; }
  #infos { font-family: ui-monospace, monospace; margin-top: 12px; font-size: 13px; }
</style></head>
<body>
  <h1>Video de test</h1>
  <p>Clique <strong>Charger</strong> (geste utilisateur obligatoire), puis lance
     « Preparer » depuis la popup LiveSub.</p>
  <p><button id="charger">Charger la video</button>
     <label style="font-size:14px">durée
       <select id="minutes">
         <option value="2">2 min</option>
         <option value="4" selected>4 min</option>
         <option value="8">8 min</option>
       </select>
     </label></p>
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

document.getElementById("charger").addEventListener("click", async () => {
  const minutes = Number(document.getElementById("minutes").value);
  const infos = document.getElementById("infos");
  infos.textContent = "decodage...";

  const donnees = await (await fetch("/speech.wav")).arrayBuffer();
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

  // Le geste utilisateur est encore "chaud" ici : on joue puis on met en pause
  // tout de suite. Ca accorde a l'element le droit de rejouer plus tard sans
  // nouveau clic -- c'est ce dont l'extension a besoin.
  try { await v.play(); v.pause(); v.currentTime = 0; } catch (e) {}

  infos.textContent =
    "duree " + v.duration.toFixed(1) + " s (" + fois + " repetitions) — prete";
});
</script>
</body></html>`;

const FICHIERS = {
  "/speech.wav": ["audio/speech.wav", "audio/wav"],
  "/speech-fr.mp3": ["audio/speech-fr.mp3", "audio/mpeg"],
  // Ajoute pour l etape 4 : l extrait ARTE francais (« trous noirs »), le seul
  // materiel qui permette de verifier que les fautes de whisper-tiny ont disparu.
  "/extrait-fr-dur.wav": ["audio/extrait-fr-dur.wav", "audio/wav"],
  // Volet B de l etape 5 : deux discours du Parlement europeen en ALLEMAND.
  "/allemand-1.wav": ["audio/allemand-1.wav", "audio/wav"],
  "/allemand-2.wav": ["audio/allemand-2.wav", "audio/wav"],
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
      const chemin = path.join(RACINE, entree[0]);
      const donnees = fs.readFileSync(chemin);
      res.writeHead(200, { "Content-Type": entree[1], "Content-Length": donnees.length });
      return res.end(donnees);
    }
    res.writeHead(404);
    res.end("non trouve");
  })
  .listen(8732, () => console.log("Page video de test sur http://localhost:8732"));
