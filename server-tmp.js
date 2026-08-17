// TEMPORAIRE : sert une page http locale qui joue de la parole en boucle.
// Il faut une vraie page http(s) pour tester l'overlay : content.js n'est pas
// injecte dans les pages chrome-extension://.
//
// Deux extraits : anglais et francais. Le sous-titrage doit tenir dans les deux
// langues -- c'est tout l'interet de garder un modele multilingue.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PAGE = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Source de parole</title></head>
<body style="font-family:sans-serif;padding:40px">
  <h1>Video qui parle (en boucle)</h1>
  <button id="en" style="font-size:20px;padding:12px 20px">Jouer anglais</button>
  <button id="fr" style="font-size:20px;padding:12px 20px">Jouer francais</button>
  <button id="stop" style="font-size:20px;padding:12px 20px">Arreter</button>
  <audio id="a" loop controls style="display:block;margin-top:20px"></audio>
  <div style="height:1200px"></div>
  <script>
    const audio = document.getElementById("a");
    const jouer = (src) => { audio.src = src; audio.play(); };
    document.getElementById("en").addEventListener("click", () => jouer("/speech.wav"));
    document.getElementById("fr").addEventListener("click", () => jouer("/speech-fr.mp3"));
    document.getElementById("stop").addEventListener("click", () => audio.pause());
  </script>
</body></html>`;

const FICHIERS = {
  "/speech.wav": ["speech.wav", "audio/wav"],
  "/speech-fr.mp3": ["speech-fr.mp3", "audio/mpeg"],
};

http
  .createServer((req, res) => {
    const fichier = FICHIERS[req.url];
    if (fichier) {
      const [nom, type] = fichier;
      const donnees = fs.readFileSync(path.join(__dirname, "test", nom));
      res.writeHead(200, { "Content-Type": type, "Content-Length": donnees.length });
      res.end(donnees);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  })
  .listen(8731, () => console.log("Serveur de test sur http://localhost:8731"));
