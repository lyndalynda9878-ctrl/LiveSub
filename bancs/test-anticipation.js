// ===========================================================================
// Branche « anticipation » — MESURE UNIQUEMENT. Ne modifie rien a l'extension.
// ===========================================================================
//
// L'idee a valider : au lieu de transcrire en direct, faire jouer la video en
// ACCELERE pendant un temps de preparation, puis revenir au debut et lire
// normalement avec les sous-titres deja prets.
//
// Toute l'idee repose sur UNE brique : est-ce que le son joue a x2 donne le
// MEME texte qu'a x1 ? Si non, il n'y a rien a construire. Cette page ne
// repond qu'a ca (+ la question annexe de la capture silencieuse).
//
// ---------------------------------------------------------------------------
// Le piege methodologique principal, et comment il est traite
// ---------------------------------------------------------------------------
// On pourrait croire qu'il suffit de comparer « le fichier decode » a « le
// fichier decode, reechantillonne x2, puis x0,5 ». Ce serait de l'arithmetique,
// pas une mesure : ca ne dirait rien de ce que fait VRAIMENT le pipeline media
// de Chrome quand `playbackRate = 2`.
//
// Donc ici les DEUX vitesses passent par le meme chemin reel :
//   <audio> (playbackRate 1 ou 2, preservesPitch = false)
//     -> MediaElementAudioSourceNode
//     -> AudioWorklet qui enregistre a 48 kHz (le taux d'une capture d'onglet)
// Seule la vitesse change. Toute difference observee est donc imputable a la
// vitesse, et a rien d'autre.
//
// ⚠️ Second piege : les deux enregistrements ne commencent PAS au meme endroit
// du contenu (play() et le demarrage du worklet ne sont pas synchronises a
// l'echantillon). Un decalage de 300 ms suffirait a faire tomber les coupures
// de fragments ailleurs, donc a produire des textes differents POUR UNE RAISON
// QUI N'EST PAS LA VITESSE. D'ou le recalage par intercorrelation avant tout
// decoupage, et la mesure de ressemblance du signal qui le controle.

const TAUX_WHISPER = 16000;

// Duree de contenu visee. Assez long pour que le decoupage produise plusieurs
// fragments dont les coupures tombent a des endroits varies (les extraits font
// 11 s et 6,2 s : on les repete, comme test-bruit.js).
const DUREE_CONTENU_VISEE = 88;

// Taille des fragments donnes a Whisper. 15 s : c'est ce qu'un moteur
// d'anticipation utiliserait (des blocs transcrits UNE fois), pas la fenetre
// glissante de 12 s de la production, qui re-transcrit sans arret.
const DUREE_FRAGMENT = 15;

const CLIPS = [
  { url: "audio/speech.wav", langue: "english", intitule: "EN" },
  { url: "audio/speech-fr.mp3", langue: "french", intitule: "FR" },
];

const VITESSES = [1, 2];

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

const journalEl = document.getElementById("journal");
const etatEl = document.getElementById("etat");

function log(message, classe) {
  const ligne = document.createElement("div");
  if (classe) ligne.className = classe;
  ligne.textContent = message;
  journalEl.appendChild(ligne);
  journalEl.scrollTop = journalEl.scrollHeight;
  console.log(message);
}

function etat(m) {
  etatEl.textContent = m;
  console.log("[etat] " + m);
}

const resultats = { A: null, C: null, erreur: null, fini: false };
window.resultats = resultats;

// ---------------------------------------------------------------------------
// Audio : outils
// ---------------------------------------------------------------------------

async function decoder(url, taux) {
  const donnees = await (await fetch(url)).arrayBuffer();
  const ctx = new AudioContext({ sampleRate: taux });
  try {
    const d = await ctx.decodeAudioData(donnees);
    if (d.numberOfChannels === 2) {
      const g = d.getChannelData(0);
      const dr = d.getChannelData(1);
      const out = new Float32Array(g.length);
      for (let i = 0; i < g.length; i++) out[i] = (g[i] + dr[i]) / 2;
      return out;
    }
    return new Float32Array(d.getChannelData(0));
  } finally {
    ctx.close();
  }
}

function repeter(audio, fois) {
  const t = new Float32Array(audio.length * fois);
  for (let i = 0; i < fois; i++) t.set(audio, i * audio.length);
  return t;
}

// WAV 16 bits mono : c'est ce qu'on donne a l'element <audio>. Passer par un
// vrai fichier (blob) et non par un AudioBufferSourceNode est volontaire :
// `playbackRate` et `preservesPitch` sont des proprietes de l'element media, et
// c'est CE chemin-la qu'une video reelle empruntera.
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
    const v = Math.max(-1, Math.min(1, audio[i]));
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

// Reechantillonnage par le moteur de Chrome (OfflineAudioContext), pas par une
// interpolation maison : c'est le meme resampler que celui du pipeline audio,
// donc on ne mesure pas la qualite de MON code.
//
// L'astuce du x2 : on declare le buffer enregistre a 24 kHz alors qu'il a ete
// pris a 48 kHz. Un buffer declare a un taux plus BAS est interprete comme
// durant plus longtemps, donc il est joue plus LENTEMENT : la hauteur de voix
// et la duree reviennent a l'original d'un seul coup.
//
// (Le sens compte, et se trompe facilement : declarer 96 kHz — le reflexe
// « x2 » — accelere encore au lieu de ralentir. Verifie au test a blanc :
// 6 s de contenu revenaient a 1,71 s au lieu de 6 s.)
async function reechantillonner(audio, tauxDeclare, tauxCible) {
  const longueur = Math.max(1, Math.floor((audio.length * tauxCible) / tauxDeclare));
  const off = new OfflineAudioContext(1, longueur, tauxCible);
  const buf = new AudioBuffer({ length: audio.length, sampleRate: tauxDeclare, numberOfChannels: 1 });
  buf.copyToChannel(audio, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const rendu = await off.startRendering();
  return new Float32Array(rendu.getChannelData(0));
}

// ---------------------------------------------------------------------------
// Jouer pour de vrai et capturer
// ---------------------------------------------------------------------------

async function jouerEtCapturer(blobUrl, vitesse) {
  const ctx = new AudioContext(); // taux natif (48 kHz), comme une capture d'onglet
  if (ctx.state === "suspended") await ctx.resume();
  await ctx.audioWorklet.addModule(chrome.runtime.getURL("bancs/test-anticipation.worklet.js"));

  const el = new Audio();
  el.src = blobUrl;
  el.preservesPitch = false;   // LE point : un simple reechantillonnage,
  el.playbackRate = vitesse;   // pas un etirement qui garderait la hauteur
  el.volume = 1;
  await new Promise((res, rej) => {
    el.onloadedmetadata = res;
    el.onerror = () => rej(new Error("chargement audio impossible"));
  });

  const source = ctx.createMediaElementSource(el);
  const noeud = new AudioWorkletNode(ctx, "enregistreur", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    processorOptions: { envoyer: true },
  });
  source.connect(noeud);
  noeud.connect(ctx.destination); // le worklet n'ecrit rien en sortie : silencieux

  const blocs = [];
  let total = 0;
  let stats = null;
  const fini = new Promise((res) => {
    noeud.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "audio") { blocs.push(m.bloc); total += m.bloc.length; }
      else if (m.type === "fin") { stats = m; res(); }
    };
  });

  const t0 = performance.now();
  await el.play();
  await new Promise((res) => { el.onended = res; });
  const murMs = performance.now() - t0;

  // Laisser le worklet ecouler ce qui reste en vol avant de demander l'arret.
  await new Promise((r) => setTimeout(r, 400));
  noeud.port.postMessage("stop");
  await fini;

  const taux = ctx.sampleRate;
  source.disconnect();
  noeud.disconnect();
  await ctx.close();

  const audio = new Float32Array(total);
  let o = 0;
  for (const b of blocs) { audio.set(b, o); o += b.length; }

  return { audio, taux, murMs, vitesseEffective: el.playbackRate, stats };
}

// ---------------------------------------------------------------------------
// Recalage : intercorrelation
// ---------------------------------------------------------------------------

function enveloppe(x, pas) {
  const n = Math.floor(x.length / pas);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < pas; j++) { const v = x[i * pas + j]; s += v * v; }
    out[i] = Math.sqrt(s / pas);
  }
  return out;
}

// Correlation normalisee de a et b decale de s : a[i] face a b[i+s].
function correlationA(a, b, s) {
  const debut = Math.max(0, -s);
  const fin = Math.min(a.length, b.length - s);
  const n = fin - debut;
  if (n < 100) return { r: -1, n };
  let sa = 0, sb = 0;
  for (let i = debut; i < fin; i++) { sa += a[i]; sb += b[i + s]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = debut; i < fin; i++) {
    const x = a[i] - ma, y = b[i + s] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return { r: den > 0 ? num / den : 0, n };
}

// Deux etages : l'enveloppe d'energie a 100 Hz donne le decalage a 10 ms pres
// sur toute la duree (rapide), puis on affine a l'echantillon sur une fenetre
// courte. Une intercorrelation brute a 16 kHz sur 88 s serait inutilisable.
function recaler(x1, x2) {
  const PAS = 160; // 16000 / 100 -> enveloppe a 100 Hz
  const e1 = enveloppe(x1, PAS);
  const e2 = enveloppe(x2, PAS);

  let best = 0, bestR = -Infinity;
  for (let s = -400; s <= 400; s++) {   // +/- 4 s
    const { r } = correlationA(e1, e2, s);
    if (r > bestR) { bestR = r; best = s; }
  }
  let s = best * PAS;

  // Affinage a l'echantillon sur 4 s pris au milieu.
  const milieu = Math.floor(x1.length / 2);
  const largeur = Math.min(4 * TAUX_WHISPER, Math.floor(x1.length / 3));
  const a = x1.subarray(milieu, milieu + largeur);
  let meilleurR = -Infinity, meilleurD = 0;
  for (let d = -400; d <= 400; d += 2) {       // +/- 25 ms
    const dep = milieu + s + d;
    if (dep < 0 || dep + largeur > x2.length) continue;
    const b = x2.subarray(dep, dep + largeur);
    const { r } = correlationA(a, b, 0);
    if (r > meilleurR) { meilleurR = r; meilleurD = d; }
  }
  s += meilleurD;

  const global = correlationA(x1, x2, s);
  return {
    decalageEchantillons: s,
    decalageMs: Math.round((s / TAUX_WHISPER) * 1000),
    rEnveloppe: Number(bestR.toFixed(4)),
    rLocal: Number(meilleurR.toFixed(4)),
    rGlobal: Number(global.r.toFixed(4)),
  };
}

// ---------------------------------------------------------------------------
// Comparaison des textes
// ---------------------------------------------------------------------------

// Meme normalisation que test-bruit.js : minuscules, sans ponctuation ni
// apostrophes. On compare des mots, pas de la typographie.
function mots(texte) {
  return String(texte || "")
    .toLowerCase()
    .replace(/[‘’']/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}

// Alignement de Levenshtein AVEC retour arriere : on veut le nombre de mots
// reellement identiques, pas seulement une distance. C'est ce qui permet de
// donner un pourcentage plutot qu'une impression.
function comparerMots(ref, cand) {
  const a = mots(ref), b = mots(cand);
  const n = a.length, m = b.length;
  const d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }

  let i = n, j = m, egaux = 0, subs = 0, sup = 0, ins = 0;
  const differences = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      egaux++; i--; j--;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      subs++; differences.push('x1 "' + a[i - 1] + '" -> x2 "' + b[j - 1] + '"'); i--; j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      sup++; differences.push('x1 "' + a[i - 1] + '" -> x2 (rien)'); i--;
    } else {
      ins++; differences.push('x1 (rien) -> x2 "' + b[j - 1] + '"'); j--;
    }
  }
  return {
    motsRef: n, motsCand: m, egaux,
    substitutions: subs, suppressions: sup, insertions: ins,
    pourcentIdentiques: n ? Number(((egaux / n) * 100).toFixed(1)) : 0,
    wer: n ? Number((((subs + sup + ins) / n) * 100).toFixed(1)) : 0,
    differences: differences.reverse(),
  };
}

// ---------------------------------------------------------------------------
// Le worker Whisper (configuration de PRODUCTION : tiny fp32 + horodatage mot)
// ---------------------------------------------------------------------------

function ouvrirWorker() {
  const worker = new Worker(chrome.runtime.getURL("whisper.worker.js"), { type: "module" });
  const attente = new Map();
  let prochainId = 1;

  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "ready") { const a = attente.get("init"); attente.delete("init"); if (a) a.resolve(m); }
    else if (m.type === "progress") etat("chargement " + m.fichier + " " + m.pourcent + " %");
    else if (m.type === "info") log("   i  " + m.message);
    else if (m.type === "result") { const a = attente.get(m.id); attente.delete(m.id); if (a) a.resolve(m); }
    else if (m.type === "error") {
      const cle = m.id === undefined || m.id === null ? "init" : m.id;
      const a = attente.get(cle); attente.delete(cle);
      if (a) a.reject(new Error(m.message)); else log("   ERREUR " + m.message, "err");
    }
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || "erreur worker");
    for (const a of attente.values()) a.reject(err);
    attente.clear();
  };
  const attendre = (c) => new Promise((res, rej) => attente.set(c, { resolve: res, reject: rej }));

  return {
    init() { const p = attendre("init"); worker.postMessage({ type: "init", forcer: "wasm" }); return p; },
    transcrire(audio, langue) {
      const id = prochainId++;
      const p = attendre(id);
      const copie = new Float32Array(audio);
      worker.postMessage({ type: "transcribe", id, audio: copie, langue }, [copie.buffer]);
      return p;
    },
    fermer() { worker.terminate(); },
  };
}

// ---------------------------------------------------------------------------
// PARTIE A — x1 contre x2
// ---------------------------------------------------------------------------

async function partieA() {
  const sortie = [];

  for (const clip of CLIPS) {
    etat(clip.intitule + " — preparation de l'extrait");
    const brut = await decoder(clip.url, 48000);
    const fois = Math.max(1, Math.round((DUREE_CONTENU_VISEE * 48000) / brut.length));
    const contenu = repeter(brut, fois);
    const dureeContenu = contenu.length / 48000;
    const blobUrl = URL.createObjectURL(construireWav(contenu, 48000));
    log(clip.intitule + " : extrait de " + (brut.length / 48000).toFixed(1) +
        " s repete " + fois + "x = " + dureeContenu.toFixed(1) + " s");

    // --- Jouer pour de vrai, aux deux vitesses ----------------------------
    // Les captures sont gardees sur `window` : la lecture reelle coute 2 min par
    // clip, et il serait absurde de la rejouer a chaque mise au point du calcul
    // qui suit. Surtout, chaque rejeu use la seance (cf. la memoire
    // `mesures-whisper-seance-usee`).
    window.__captures = window.__captures || {};
    let cache = window.__captures[clip.intitule];
    if (!cache) {
      const captures = {};
      for (const v of VITESSES) {
        etat(clip.intitule + " — lecture x" + v + " en cours (" + (dureeContenu / v).toFixed(0) + " s)…");
        const c = await jouerEtCapturer(blobUrl, v);
        // 48000 / v : a x2 le buffer est declare a 24 kHz, donc ralenti d'un facteur 2.
        const restitue = await reechantillonner(c.audio, 48000 / v, TAUX_WHISPER);
        captures[v] = Object.assign({}, c, { restitue });
        log("  x" + v + " : " + (c.murMs / 1000).toFixed(1) + " s d'horloge, " +
            (c.audio.length / c.taux).toFixed(2) + " s captures a " + c.taux + " Hz, " +
            (restitue.length / TAUX_WHISPER).toFixed(2) + " s apres remise a vitesse normale");
      }
      etat(clip.intitule + " — recalage des deux enregistrements");
      const cal0 = recaler(captures[1].restitue, captures[2].restitue);
      cache = {
        x1: captures[1].restitue, x2: captures[2].restitue, cal: cal0,
        murX1: captures[1].murMs, murX2: captures[2].murMs,
        capturesX1s: captures[1].audio.length / captures[1].taux,
        capturesX2s: captures[2].audio.length / captures[2].taux,
      };
      window.__captures[clip.intitule] = cache;
    } else {
      log("  (captures deja en memoire : lecture non rejouee)");
    }
    URL.revokeObjectURL(blobUrl);

    const x1 = cache.x1, x2 = cache.x2, cal = cache.cal;
    log("  recalage : " + cal.decalageMs + " ms — ressemblance du signal r = " +
        cal.rGlobal + " (local " + cal.rLocal + ")", cal.rGlobal > 0.8 ? "ok" : "warn");

    // Region commune, coupee IDENTIQUEMENT dans les deux.
    const s = cal.decalageEchantillons;
    const debut1 = Math.max(0, -s), debut2 = Math.max(0, s);
    const commun = Math.min(x1.length - debut1, x2.length - debut2);
    const n = DUREE_FRAGMENT * TAUX_WHISPER;
    const nbFrag = Math.floor(commun / n);
    log("  " + nbFrag + " fragments de " + DUREE_FRAGMENT + " s sur la region commune");

    // --- Transcription, x1 et x2 ALTERNES dans le MEME worker -------------
    // Memoire `mesures-whisper-seance-usee` : la machine ralentit au fil d'une
    // seance. Faire tout le x1 puis tout le x2 donnerait un ecart de temps qui
    // ne serait que cette derive. Alterner fragment par fragment est la seule
    // facon d'obtenir un rapport honnete.
    const w = ouvrirWorker();
    const lignes = [];
    try {
      const pret = await w.init();
      log("  worker pret (backend " + (pret.backend || "?") + ")");

      // Passage a blanc : la premiere inference porte le cout de chauffe.
      etat(clip.intitule + " — chauffe");
      await w.transcrire(x1.subarray(debut1, debut1 + n), clip.langue);

      for (let k = 0; k < nbFrag; k++) {
        const f1 = x1.subarray(debut1 + k * n, debut1 + (k + 1) * n);
        const f2 = x2.subarray(debut2 + k * n, debut2 + (k + 1) * n);
        const ligne = { fragment: k };
        const paires = [["x1", f1], ["x2", f2]];
        for (const paire of paires) {
          etat(clip.intitule + " — fragment " + (k + 1) + "/" + nbFrag + " " + paire[0]);
          const t = performance.now();
          const r = await w.transcrire(paire[1], clip.langue);
          ligne[paire[0]] = { texte: (r.texte || "").trim(), ms: Math.round(performance.now() - t) };
        }
        ligne.comparaison = comparerMots(ligne.x1.texte, ligne.x2.texte);
        log("  frag " + (k + 1) + ": " + ligne.comparaison.pourcentIdentiques +
            " % identiques (" + ligne.comparaison.egaux + "/" + ligne.comparaison.motsRef +
            ") — x1 " + ligne.x1.ms + " ms / x2 " + ligne.x2.ms + " ms",
            ligne.comparaison.pourcentIdentiques >= 95 ? "ok" : "warn");
        lignes.push(ligne);
      }
    } finally {
      w.fermer();
    }

    // --- Bilan du clip ----------------------------------------------------
    const texte1 = lignes.map((l) => l.x1.texte).join(" ");
    const texte2 = lignes.map((l) => l.x2.texte).join(" ");
    const global = comparerMots(texte1, texte2);
    const ms1 = lignes.reduce((acc, l) => acc + l.x1.ms, 0);
    const ms2 = lignes.reduce((acc, l) => acc + l.x2.ms, 0);
    const dureeTraitee = nbFrag * DUREE_FRAGMENT;

    sortie.push({
      clip: clip.intitule,
      langue: clip.langue,
      dureeContenu: Number(dureeContenu.toFixed(1)),
      dureeTraitee,
      recalage: cal,
      murX1s: Number((cache.murX1 / 1000).toFixed(1)),
      murX2s: Number((cache.murX2 / 1000).toFixed(1)),
      capturesX1s: Number(cache.capturesX1s.toFixed(2)),
      capturesX2s: Number(cache.capturesX2s.toFixed(2)),
      dureeRestitueeX1: Number((x1.length / TAUX_WHISPER).toFixed(2)),
      dureeRestitueeX2: Number((x2.length / TAUX_WHISPER).toFixed(2)),
      global,
      parFragment: lignes.map((l) => ({
        fragment: l.fragment, msX1: l.x1.ms, msX2: l.x2.ms,
        pourcentIdentiques: l.comparaison.pourcentIdentiques,
        motsRef: l.comparaison.motsRef,
      })),
      texteX1: texte1,
      texteX2: texte2,
      tempsWhisper: {
        totalMsX1: ms1,
        totalMsX2: ms2,
        // Le critere demande : a x2, la transcription doit tenir dans le temps
        // que dure la lecture acceleree. Sinon on ne prend aucune avance.
        dureeLectureX2s: Number((dureeTraitee / 2).toFixed(1)),
        partDuTempsDeLectureX2: Number(((ms2 / 1000 / (dureeTraitee / 2)) * 100).toFixed(1)),
        facteurTempsReel: Number((dureeTraitee / (ms2 / 1000)).toFixed(2)),
      },
    });
    log(clip.intitule + " — BILAN : " + global.pourcentIdentiques +
        " % de mots identiques (" + global.egaux + "/" + global.motsRef +
        "), WER " + global.wer + " %",
        global.pourcentIdentiques >= 95 ? "ok" : "err");
  }

  return sortie;
}

// ---------------------------------------------------------------------------
// PARTIE C — tabCapture sans reinjection vers les haut-parleurs
// ---------------------------------------------------------------------------
//
// Question posee : si l'extension ne renvoie PAS le son vers les haut-parleurs
// (ce que fait aujourd'hui `audioElement.srcObject = sortie.stream` dans
// offscreen.js), est-ce que tabCapture continue de livrer du son ?
//
// Il y a deux facons d'echouer, et il faut pouvoir les distinguer :
//   1. le graphe Web Audio n'est plus « tire » faute de destination -> le
//      worklet ne serait meme pas appele ;
//   2. tabCapture cesse de livrer -> le worklet est appele mais ne recoit que
//      des zeros.
// Le worklet remonte donc le nombre d'appels ET le niveau. Trois cablages sont
// essayes pour trancher.

const CONFIGS_C = [
  { cle: "aucune", intitule: "aucune destination (rien vers les haut-parleurs)", duree: 20 },
  { cle: "gainZero", intitule: "puits muet : gain 0 -> destination", duree: 8 },
  { cle: "directe", intitule: "temoin : source -> destination (on entend)", duree: 8 },
];

// `idOnglet` : l'onglet source doit DEJA exister et DEJA jouer du son. Il n'est
// ni cree ni demarre ici, et c'est volontaire : le manifeste n'a pas la
// permission `scripting`, et surtout la lecture d'un son demande un vrai geste
// utilisateur. On ne veut pas d'un test qui « marche » parce qu'il a contourne
// une regle que la production subira.
async function partieC(idOnglet) {
  const onglet = await chrome.tabs.get(idOnglet);
  log("onglet source " + onglet.id + " — audible avant capture : " + onglet.audible);
  if (!onglet.audible) {
    log("   attention : l'onglet ne joue pas de son, la mesure ne vaudrait rien", "warn");
  }
  const avant = onglet;

  const mesures = [];
  for (const cfg of CONFIGS_C) {
    etat("Q3 — " + cfg.intitule);
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: idOnglet });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    });
    const ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    await ctx.audioWorklet.addModule(chrome.runtime.getURL("bancs/test-anticipation.worklet.js"));

    const source = ctx.createMediaStreamSource(stream);
    const noeud = new AudioWorkletNode(ctx, "enregistreur", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { envoyer: false },
    });
    source.connect(noeud);

    if (cfg.cle === "gainZero") {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      gain.connect(ctx.destination);
    } else if (cfg.cle === "directe") {
      source.connect(ctx.destination);
    }
    // "aucune" : on ne relie RIEN a ctx.destination, et on ne cree aucun
    // MediaStreamAudioDestinationNode. Aucun son ne peut sortir.

    const fini = new Promise((res) => {
      noeud.port.onmessage = (e) => { if (e.data.type === "fin") res(e.data); };
    });
    await new Promise((r) => setTimeout(r, cfg.duree * 1000));
    const pendant = await chrome.tabs.get(idOnglet);
    noeud.port.postMessage("stop");
    const st = await fini;

    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();

    const m = {
      config: cfg.cle,
      intitule: cfg.intitule,
      dureeDemandeeS: cfg.duree,
      appelsWorklet: st.appels,
      appelsAvecEntree: st.appelsAvecEntree,
      secondesRecues: Number((st.echantillons / st.tauxContexte).toFixed(2)),
      rms: Number(st.rms.toFixed(5)),
      max: Number(st.max.toFixed(5)),
      ongletAudiblePendant: pendant.audible,
      verdict: st.appels === 0 ? "graphe jamais execute"
             : st.rms > 0.0005 ? "capte du son"
             : "execute mais silence",
    };
    mesures.push(m);
    log("  " + cfg.intitule + " : " + m.verdict + " — " + m.secondesRecues +
        " s recues, rms " + m.rms + ", max " + m.max + ", appels " + m.appelsWorklet,
        m.verdict === "capte du son" ? "ok" : "err");
    await new Promise((r) => setTimeout(r, 1000));
  }

  return { ongletAudibleAvant: avant.audible, mesures };
}

// ---------------------------------------------------------------------------
// Lancement
// ---------------------------------------------------------------------------

window.lancerA = async function () {
  resultats.fini = false;
  try { resultats.A = await partieA(); etat("A termine"); }
  catch (err) { resultats.erreur = String((err && err.stack) || err); log("ERREUR " + err.message, "err"); }
  finally { resultats.fini = true; }
  return "ok";
};

window.lancerC = async function (idOnglet) {
  resultats.fini = false;
  try { resultats.C = await partieC(idOnglet); etat("C termine"); }
  catch (err) { resultats.erreur = String((err && err.stack) || err); log("ERREUR " + err.message, "err"); }
  finally { resultats.fini = true; }
  return "ok";
};

document.getElementById("go").addEventListener("click", () => window.lancerA());
log("page prete");
