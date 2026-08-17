// TEMPORAIRE : page http locale qui joue de la parole en boucle.
// Il faut une vraie page http(s) pour tester l'overlay : content.js n'est pas
// injecte dans les pages chrome-extension://.
//
// Deux modes :
//   - parole seule (anglais / francais) : le cas facile ;
//   - parole + LIT MUSICAL a niveau reglable : le cas d'une vraie video.
//
// Pourquoi un lit musical synthetise plutot qu'une vraie musique ? Parce qu'on
// veut faire VARIER le niveau du masque et voir a partir de quand la parole se
// perd. Avec un extrait YouTube on ne peut que constater ; ici on peut
// demontrer. Le VAD, lui, ne fait pas la difference : ce qui compte est qu'un
// signal large bande couvre la voix.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PAGE = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Source de parole</title></head>
<body style="font-family:sans-serif;padding:30px">
  <h1>Parole continue + musique de fond</h1>

  <p>
    Contenu :
    <select id="contenu" style="font-size:18px">
      <option value="fr">Francais seul</option>
      <option value="en">Anglais seul</option>
      <option value="mix" selected>Les deux a la suite</option>
    </select>
  </p>

  <p>
    Niveau de musique :
    <select id="niveau" style="font-size:18px">
      <option value="0">0 — parole seule (temoin)</option>
      <option value="0.08">0.08 — musique discrete</option>
      <option value="0.2" selected>0.2 — musique nette (cas type documentaire)</option>
      <option value="0.4">0.4 — musique forte</option>
    </select>
  </p>

  <p>
    <button id="go" style="font-size:20px;padding:12px 20px">Jouer en boucle</button>
    <button id="stop" style="font-size:20px;padding:12px 20px">Arreter</button>
  </p>

  <p id="etat" style="font-family:monospace;color:#4f46e5"></p>
  <div style="height:1200px"></div>

  <script>
    const etat = document.getElementById("etat");
    let ctx = null, sources = [];

    // Parole : les deux extraits colles bout a bout, en boucle. Ca donne de la
    // parole quasi continue, avec les respirations naturelles des extraits --
    // ce qui est bien le regime d'une narration de documentaire.
    async function chargerParole() {
      const choix = document.getElementById("contenu").value;
      const fichiers =
        choix === "fr" ? ["/speech-fr.mp3"] :
        choix === "en" ? ["/speech.wav"] :
        ["/speech.wav", "/speech-fr.mp3"];
      const morceaux = [];
      for (const f of fichiers) {
        const buf = await (await fetch(f)).arrayBuffer();
        morceaux.push(await ctx.decodeAudioData(buf));
      }
      const total = morceaux.reduce((n, m) => n + m.length, 0);
      const sortie = ctx.createBuffer(1, total, ctx.sampleRate);
      const canal = sortie.getChannelData(0);
      let pos = 0;
      for (const m of morceaux) {
        canal.set(m.getChannelData(0), pos);
        pos += m.length;
      }
      return sortie;
    }

    // Lit musical : quelques notes tenues qui changent lentement + un souffle
    // filtre pour les « effets ». Large bande, comme une vraie musique de fond.
    function musique(gain) {
      const sortie = ctx.createGain();
      sortie.gain.value = gain;

      for (const f of [110, 165, 220, 330]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = f;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = 0.13;
        const prof = ctx.createGain();
        prof.gain.value = 3;
        lfo.connect(prof).connect(osc.frequency);
        const g = ctx.createGain();
        g.gain.value = 0.25;
        const filtre = ctx.createBiquadFilter();
        filtre.type = "lowpass";
        filtre.frequency.value = 2000;
        osc.connect(g).connect(filtre).connect(sortie);
        osc.start(); lfo.start();
        sources.push(osc, lfo);
      }

      // Souffle : bruit rose approxime, pour couvrir aussi les aigus.
      const bruit = ctx.createBufferSource();
      const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let graine = 1;
      for (let i = 0; i < d.length; i++) {
        graine = (graine * 1103515245 + 12345) & 0x7fffffff;
        d[i] = ((graine / 0x7fffffff) * 2 - 1) * 0.5;
      }
      bruit.buffer = buf; bruit.loop = true;
      const bg = ctx.createGain(); bg.gain.value = 0.35;
      const bf = ctx.createBiquadFilter(); bf.type = "bandpass";
      bf.frequency.value = 1200; bf.Q.value = 0.4;
      bruit.connect(bf).connect(bg).connect(sortie);
      bruit.start();
      sources.push(bruit);

      return sortie;
    }

    async function jouer() {
      arreter();
      ctx = new AudioContext();
      const gain = parseFloat(document.getElementById("niveau").value);

      const parole = await chargerParole();
      const src = ctx.createBufferSource();
      src.buffer = parole; src.loop = true;
      const pg = ctx.createGain(); pg.gain.value = 1;
      src.connect(pg).connect(ctx.destination);
      src.start();
      sources.push(src);

      if (gain > 0) musique(gain).connect(ctx.destination);

      etat.textContent = "En lecture — " + document.getElementById("contenu").value +
        ", parole " + parole.duration.toFixed(1) + " s en boucle, musique a " + gain;
    }

    function arreter() {
      for (const s of sources) { try { s.stop(); } catch (e) {} }
      sources = [];
      if (ctx) { ctx.close(); ctx = null; }
      etat.textContent = "Arrete";
    }

    document.getElementById("go").addEventListener("click", jouer);
    document.getElementById("stop").addEventListener("click", arreter);
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
