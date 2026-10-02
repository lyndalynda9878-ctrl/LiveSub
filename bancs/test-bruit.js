// Mesure : Whisper sur son BRUITE, et cout des horodatages par mot.
//
// Pourquoi cette page existe alors que test-bench.html existe deja : test-bench
// compare des variantes sur du son PROPRE. C'est comme ca que whisper-base a
// ete ecarte -- WER 0 %, donc aucun gain a esperer. Sauf que le probleme reel
// est sur du son bruite (documentaire avec musique). Cette condition-la n'avait
// jamais ete mesuree : la decision avait ete prise sur les mauvaises donnees.
//
// Deux questions, un seul passage :
//
//   1. COUT DES HORODATAGES. `return_timestamps: "word"` donne l'instant de
//      chaque mot. C'est ce qui permettrait a l'overlay d'afficher un mot A
//      L'HEURE ou il a ete prononce, au lieu de tout lacher a cadence fixe
//      (80 ms) en rafales. Mais sortir les attentions croisees puis les aligner
//      (DTW) n'est pas gratuit : si ca coute 40 %, tout le calcul de latence est
//      a refaire. On chiffre avant de s'engager.
//
//   2. UN MODELE PLUS GROS CORRIGE-T-IL LE BRUIT ? Et a quel prix en latence.
//      Si base et small font le meme WER que tiny meme a 0,4 de musique, alors
//      un modele plus gros ne sert a rien et le sujet est clos.
//
// ⚠️ Cette page ne change RIEN a la production : le worker garde whisper-tiny
// fp32 par defaut, les parametres (`modele`, `dtype`, `opt`, `horodatage`) ne
// voyagent que dans la query string du worker ouvert ici.

const SAMPLE_RATE = 16000;

// Taille des fragments : celle de la PRODUCTION. Mesurer sur un extrait entier
// et propre est exactement l'erreur qui a fait ecarter whisper-base -- une
// variante peut donner 0 % de WER sur une phrase complete et se mettre a
// inventer sur des bouts de 7 s.
const DUREE_SEGMENT = 7;

// Combien de fragments par case du tableau.
//
// Volontairement modeste : le tableau complet fait deja
// modeles x 3 niveaux x 2 langues cases, et chaque inference chauffe la
// machine. Mieux vaut un signal clair obtenu en entier qu'un tableau parfait
// qui s'arrete au milieu. On pourra densifier ensuite si une piste s'ouvre.
const NB_FRAGMENTS = 6;

// Departs decales : la meme parole coupee ailleurs donne un fragment different,
// et c'est exactement ce qui arrive en vrai (la fenetre tombe n'importe ou).
const DECALAGES = [0, 0.9, 1.8, 2.7];

// Les extraits durent 11 s (EN) et 6,2 s (FR) -- le francais est donc PLUS
// COURT qu'un fragment de 7 s, et un decoupage direct n'en produit aucun
// (verifie : 0 fragment au premier essai). On les repete, exactement comme
// test-bench.js et comme la page qui les joue en boucle : ca donne de la parole
// quasi continue, avec les respirations naturelles de l'extrait, et les
// coupures tombent a des endroits varies -- y compris a cheval sur le raccord,
// qui est le cas le plus dur.
const REPETITIONS = 4;

function repeter(audio, fois) {
  const total = new Float32Array(audio.length * fois);
  for (let i = 0; i < fois; i++) total.set(audio, i * audio.length);
  return total;
}

const BACKEND = "wasm"; // CPU : c'est le backend retenu sur cette machine.

// Les trois niveaux de musique demandes. 0 est le TEMOIN : c'est lui qui dit si
// une difference vient du modele ou du bruit.
const NIVEAUX = [
  { gain: 0, intitule: "0 (propre)" },
  { gain: 0.2, intitule: "0.2 (musique nette)" },
  { gain: 0.4, intitule: "0.4 (musique forte)" },
];

const CLIPS = [
  { url: "audio/speech-fr.mp3", langue: "french", intitule: "FR" },
  { url: "audio/speech.wav", langue: "english", intitule: "EN" },
];

// Les variantes a comparer. `opt: "basic"` sur les quantifiees : en "all" elles
// ne chargent tout simplement pas (voir le long commentaire dans
// whisper.worker.js -- ce sont des passes de fusion d'ONNX Runtime, pas les
// poids).
const MODELES = [
  { nom: "tiny fp32", modele: "Xenova/whisper-tiny", dtype: "fp32", opt: "all" },
  { nom: "base q8", modele: "Xenova/whisper-base", dtype: "q8", opt: "basic" },
  { nom: "base fp32", modele: "Xenova/whisper-base", dtype: "fp32", opt: "all" },
  { nom: "small q8", modele: "Xenova/whisper-small", dtype: "q8", opt: "basic" },
];

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

const journalEl = document.getElementById("journal");
const etatEl = document.getElementById("etat");
const sortiesEl = document.getElementById("sorties");
const jsonEl = document.getElementById("resultatJson");

let annule = false;

function log(message, classe) {
  const ligne = document.createElement("div");
  if (classe) ligne.className = classe;
  ligne.textContent = message;
  journalEl.appendChild(ligne);
  journalEl.scrollTop = journalEl.scrollHeight;
  console.log(message);
}

function etat(message) {
  etatEl.textContent = message;
}

// Tout ce qui est acquis, en continu. C'est ce qui rend la mesure REPRENABLE :
// une machine qui s'eteint ne fait plus perdre la seance entiere.
const acquis = { sonde: null, cases: [] };

function sauver() {
  jsonEl.value = JSON.stringify(acquis, null, 1);
  try {
    localStorage.setItem("livesub-mesure-bruit", JSON.stringify(acquis));
  } catch (err) {
    /* pas grave : le textarea reste la source */
  }
}

// ---------------------------------------------------------------------------
// Audio : parole + lit musical
// ---------------------------------------------------------------------------

async function decoderEn16kHz(url) {
  const donnees = await (await fetch(url)).arrayBuffer();
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const decode = await ctx.decodeAudioData(donnees);
    if (decode.numberOfChannels === 2) {
      const FACTEUR = Math.sqrt(2);
      const g = decode.getChannelData(0);
      const d = decode.getChannelData(1);
      const audio = new Float32Array(g.length);
      for (let i = 0; i < g.length; i++) audio[i] = (FACTEUR * (g[i] + d[i])) / 2;
      return audio;
    }
    return new Float32Array(decode.getChannelData(0));
  } finally {
    ctx.close();
  }
}

// LE MEME lit musical que server-tmp.js, mais synthetise a la main plutot que
// joue par des noeuds Web Audio : ici on veut un Float32Array reproductible,
// identique d'un passage a l'autre. Meme recette, meme resultat :
//   - 4 oscillateurs en dents de scie (110/165/220/330 Hz), legerement
//     detunes par un LFO a 0,13 Hz, passe-bas a 2 kHz ;
//   - un souffle large bande (generateur congruentiel, graine fixe) filtre en
//     passe-bande autour de 1200 Hz, pour couvrir aussi les aigus.
//
// Pourquoi une musique synthetique et pas un vrai extrait : on veut faire
// VARIER le niveau du masque et voir a partir de quand la parole se perd. Avec
// un extrait de YouTube on ne peut que constater ; ici on peut demontrer.
function litMusical(nbEchantillons, gain) {
  const sortie = new Float32Array(nbEchantillons);
  if (gain <= 0) return sortie;

  const FREQS = [110, 165, 220, 330];
  const AMPL = 0.25;

  // --- Les dents de scie, avec leur vibrato lent -----------------------------
  for (const f of FREQS) {
    let phase = 0;
    for (let i = 0; i < nbEchantillons; i++) {
      const t = i / SAMPLE_RATE;
      // LFO : +/- 3 Hz a 0,13 Hz, comme prof.gain.value = 3 cote Web Audio.
      const freq = f + 3 * Math.sin(2 * Math.PI * 0.13 * t);
      phase += freq / SAMPLE_RATE;
      if (phase >= 1) phase -= 1;
      // Dent de scie : rampe de -1 a +1.
      sortie[i] += (2 * phase - 1) * AMPL;
    }
  }

  // --- Passe-bas 2 kHz, un pole (equivalent simple du biquad) ---------------
  {
    const rc = 1 / (2 * Math.PI * 2000);
    const dt = 1 / SAMPLE_RATE;
    const a = dt / (rc + dt);
    let precedent = 0;
    for (let i = 0; i < nbEchantillons; i++) {
      precedent += a * (sortie[i] - precedent);
      sortie[i] = precedent;
    }
  }

  // --- Le souffle : bruit a graine FIXE, donc reproductible -----------------
  const bruit = new Float32Array(nbEchantillons);
  let graine = 1;
  for (let i = 0; i < nbEchantillons; i++) {
    graine = (graine * 1103515245 + 12345) & 0x7fffffff;
    bruit[i] = ((graine / 0x7fffffff) * 2 - 1) * 0.5;
  }
  // Passe-bande approxime : passe-haut puis passe-bas autour de 1200 Hz.
  {
    const dt = 1 / SAMPLE_RATE;
    const rcHaut = 1 / (2 * Math.PI * 600);
    const aHaut = rcHaut / (rcHaut + dt);
    let precedentEntree = 0;
    let precedentSortie = 0;
    for (let i = 0; i < nbEchantillons; i++) {
      const x = bruit[i];
      precedentSortie = aHaut * (precedentSortie + x - precedentEntree);
      precedentEntree = x;
      bruit[i] = precedentSortie;
    }
    const rcBas = 1 / (2 * Math.PI * 2400);
    const aBas = dt / (rcBas + dt);
    let precedent = 0;
    for (let i = 0; i < nbEchantillons; i++) {
      precedent += aBas * (bruit[i] - precedent);
      bruit[i] = precedent;
    }
  }
  for (let i = 0; i < nbEchantillons; i++) sortie[i] += bruit[i] * 0.35;

  for (let i = 0; i < nbEchantillons; i++) sortie[i] *= gain;
  return sortie;
}

// Parole + musique, en gardant la parole a niveau constant : c'est le MASQUE
// qui monte, pas la voix qui baisse. On ecrete a +/-1 comme le ferait une carte
// son.
function melanger(parole, gain) {
  const musique = litMusical(parole.length, gain);
  const sortie = new Float32Array(parole.length);
  for (let i = 0; i < parole.length; i++) {
    let v = parole[i] + musique[i];
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    sortie[i] = v;
  }
  return sortie;
}

// Rapport signal/bruit reel, pour que le « 0.2 » ait un sens physique et pas
// seulement un numero.
function rapportSignalBruit(parole, gain) {
  if (gain <= 0) return Infinity;
  const musique = litMusical(parole.length, gain);
  let ep = 0;
  let em = 0;
  for (let i = 0; i < parole.length; i++) {
    ep += parole[i] * parole[i];
    em += musique[i] * musique[i];
  }
  if (em === 0) return Infinity;
  return 10 * Math.log10(ep / em);
}

function decouperEnFragments(audioBrut, combien) {
  const audio = repeter(audioBrut, REPETITIONS);
  const taille = Math.round(DUREE_SEGMENT * SAMPLE_RATE);
  const fragments = [];
  for (const decalage of DECALAGES) {
    let debut = Math.round(decalage * SAMPLE_RATE);
    while (fragments.length < combien && debut + taille <= audio.length) {
      const tranche = audio.subarray(debut, debut + taille);
      let energie = 0;
      for (let i = 0; i < tranche.length; i++) energie += tranche[i] * tranche[i];
      // On ecarte le silence : il ne mesurerait que le decodage a vide.
      if (Math.sqrt(energie / tranche.length) > 0.01) fragments.push(tranche);
      debut += taille;
    }
  }
  // ⚠️ Une mesure sur zero fragment donnait « 0 ms/fragment — tenable (0 % du
  // temps reel) », c'est-a-dire un verdict rassurant tire de rien. Un banc qui
  // repond quand il n'a rien mesure est pire qu'un banc qui plante.
  if (!fragments.length) {
    throw new Error(
      `Aucun fragment de ${DUREE_SEGMENT} s extrait : l'extrait fait ` +
        `${(audio.length / SAMPLE_RATE).toFixed(1)} s apres repetition. ` +
        "Augmenter REPETITIONS ou baisser DUREE_SEGMENT."
    );
  }
  return fragments;
}

// ---------------------------------------------------------------------------
// Le worker (un neuf par variante -- ONNX ne relache jamais son moteur WASM)
// ---------------------------------------------------------------------------

function ouvrirWorker(config, horodatage) {
  const url = new URL(chrome.runtime.getURL("whisper.worker.js"));
  url.searchParams.set("modele", config.modele);
  url.searchParams.set("dtype", config.dtype);
  if (config.opt) url.searchParams.set("opt", config.opt);
  if (horodatage) url.searchParams.set("horodatage", horodatage);

  const worker = new Worker(url.href, { type: "module" });
  const enAttente = new Map();
  let prochainId = 1;
  const octetsParFichier = new Map();

  worker.onmessage = (event) => {
    const m = event.data;
    switch (m.type) {
      case "ready":
        enAttente.get("init")?.resolve(m);
        enAttente.delete("init");
        break;
      case "progress":
        if (m.octets) octetsParFichier.set(m.fichier, m.octets);
        etat(`${config.nom} — chargement ${m.fichier} ${m.pourcent} %`);
        break;
      case "info":
        log(`   ℹ️  ${m.message}`);
        break;
      case "result":
        enAttente.get(m.id)?.resolve(m);
        enAttente.delete(m.id);
        break;
      case "error": {
        const cle = m.id ?? "init";
        const a = enAttente.get(cle);
        enAttente.delete(cle);
        if (a) a.reject(new Error(m.message));
        else log(`   ❌ ${m.message}`, "err");
        break;
      }
    }
  };

  worker.onerror = (event) => {
    const err = new Error(event.message || "erreur inconnue dans le worker");
    for (const a of enAttente.values()) a.reject(err);
    enAttente.clear();
  };

  const attendre = (cle) =>
    new Promise((resolve, reject) => enAttente.set(cle, { resolve, reject }));

  return {
    async init() {
      const p = attendre("init");
      // `forcer` : pas de memoire, pas de repli silencieux. Si la variante ne
      // tient pas sur ce backend, on veut le savoir.
      worker.postMessage({ type: "init", forcer: BACKEND });
      return p;
    },
    transcrire(audio, langue) {
      const id = prochainId++;
      const p = attendre(id);
      // Copie : on transfere le buffer, donc l'original serait vide au passage
      // suivant. Chaque variante doit voir EXACTEMENT le meme audio.
      const copie = new Float32Array(audio);
      worker.postMessage({ type: "transcribe", id, audio: copie, langue }, [copie.buffer]);
      return p;
    },
    poids() {
      let total = 0;
      for (const o of octetsParFichier.values()) total += o;
      return total;
    },
    fermer() {
      worker.terminate();
    },
  };
}

// ---------------------------------------------------------------------------
// Comparaison des textes
// ---------------------------------------------------------------------------

function mots(texte) {
  return String(texte || "")
    .toLowerCase()
    .replace(/['']/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}

// WER : combien de mots ajouter / supprimer / remplacer pour retomber sur la
// reference, divise par la longueur de la reference. 0 % = identique.
function tauxErreur(reference, candidat) {
  const a = mots(reference);
  const b = mots(candidat);
  if (a.length === 0) return b.length === 0 ? 0 : 100;
  let prec = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prec[j] + 1,
        cur[j - 1] + 1,
        prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prec = cur;
  }
  return Math.round((prec[b.length] / a.length) * 100);
}

function mediane(v) {
  if (!v.length) return 0;
  const t = [...v].sort((x, y) => x - y);
  const m = Math.floor(t.length / 2);
  return t.length % 2 ? t[m] : Math.round((t[m - 1] + t[m]) / 2);
}

// ---------------------------------------------------------------------------
// 1. SONDE RAPIDE
// ---------------------------------------------------------------------------
//
// Elle repond a deux choses avant d'engager la machine dans le tableau complet :
//
//   - le COUT DES HORODATAGES, sur tiny (le modele de production) ;
//   - la VITESSE de chaque modele, sur 2 fragments seulement.
//
// La vitesse est eliminatoire : si un modele met plus de temps par fragment que
// la cadence a laquelle les fragments arrivent, la file recommence a grossir et
// la latence diverge -- il est disqualifie quel que soit son WER. Autant le
// savoir en 2 minutes plutot qu'apres 20 minutes de WER.
async function sondeRapide() {
  const clip = CLIPS[0]; // le francais : c'est la langue du probleme signale.
  etat("Sonde — decodage de l'audio…");
  const parole = await decoderEn16kHz(clip.url);
  const fragments = decouperEnFragments(parole, 2);
  log(`Sonde sur ${clip.intitule} : ${fragments.length} fragments de ${DUREE_SEGMENT} s`);

  const resultats = [];

  // --- a) Cout des horodatages, sur tiny -----------------------------------
  for (const horodatage of [null, "word"]) {
    if (annule) return;
    const config = MODELES[0];
    const nom = `${config.nom}${horodatage ? " + horodatage mot" : ""}`;
    etat(`Sonde — ${nom}`);
    const w = ouvrirWorker(config, horodatage);
    try {
      const pret = await w.init();
      const temps = [];
      let exemple = null;
      for (const f of fragments) {
        if (annule) break;
        const r = await w.transcrire(f, clip.langue);
        temps.push(r.ms);
        if (!exemple) exemple = r;
      }
      const entree = {
        nom,
        horodatage: Boolean(horodatage),
        chargementMs: pret.ms,
        medianeMs: mediane(temps),
        temps,
        texte: exemple?.texte || "",
        mots: exemple?.mots || null,
      };
      resultats.push(entree);
      log(
        `  ${nom} : ${entree.medianeMs} ms/fragment (chargement ${pret.ms} ms)` +
          (entree.mots ? ` — ${entree.mots.length} mots horodates` : ""),
        "ok"
      );
      if (entree.mots) {
        log(
          "    " +
            entree.mots
              .slice(0, 8)
              .map((m) => `${m.mot}@${m.debut != null ? m.debut.toFixed(2) : "?"}s`)
              .join("  ")
        );
      }
    } catch (err) {
      log(`  ${nom} : ECHEC — ${err.message}`, "err");
      resultats.push({ nom, horodatage: Boolean(horodatage), erreur: err.message });
    } finally {
      w.fermer();
    }
  }

  // --- b) Vitesse de chaque modele -----------------------------------------
  for (const config of MODELES) {
    if (annule) return;
    etat(`Sonde vitesse — ${config.nom}`);
    const w = ouvrirWorker(config, null);
    try {
      const pret = await w.init();
      const temps = [];
      let texte = "";
      for (const f of fragments) {
        if (annule) break;
        const r = await w.transcrire(f, clip.langue);
        temps.push(r.ms);
        texte = r.texte;
      }
      if (!temps.length) throw new Error("aucune inference chronometree");
      const med = mediane(temps);
      const entree = {
        nom: config.nom,
        vitesse: true,
        chargementMs: pret.ms,
        medianeMs: med,
        poidsMo: Math.round(w.poids() / 1024 / 1024),
        texte,
      };
      resultats.push(entree);
      // Le verdict eliminatoire : un fragment de 7 s doit etre transcrit en
      // moins de 7 s, sinon le moteur ne suit plus le direct.
      const tenable = med < DUREE_SEGMENT * 1000;
      log(
        `  ${config.nom} : ${med} ms/fragment, ${entree.poidsMo} Mo — ` +
          (tenable
            ? `tenable (${((med / 1000 / DUREE_SEGMENT) * 100).toFixed(0)} % du temps reel)`
            : `⚠️ TROP LENT : ${(med / 1000).toFixed(1)} s pour ${DUREE_SEGMENT} s d'audio`),
        tenable ? "ok" : "warn"
      );
    } catch (err) {
      log(`  ${config.nom} : ECHEC — ${err.message}`, "err");
      resultats.push({ nom: config.nom, vitesse: true, erreur: err.message });
    } finally {
      w.fermer();
    }
  }

  acquis.sonde = resultats;
  sauver();
  afficherSonde(resultats);
  etat("Sonde terminee.");
}

function afficherSonde(resultats) {
  const horod = resultats.filter((r) => r.horodatage !== undefined && !r.vitesse);
  const vit = resultats.filter((r) => r.vitesse);

  let html = "<h2>1a. Cout des horodatages par mot (whisper-tiny fp32)</h2>";
  const sans = horod.find((r) => !r.horodatage && !r.erreur);
  const avec = horod.find((r) => r.horodatage && !r.erreur);
  html += "<table><tr><th>Variante</th><th>ms / fragment</th><th>Surcout</th><th>Mots horodates</th></tr>";
  for (const r of horod) {
    if (r.erreur) {
      html += `<tr><td>${r.nom}</td><td colspan="3" class="err">ECHEC : ${r.erreur}</td></tr>`;
      continue;
    }
    const surcout =
      sans && r.horodatage
        ? `+${Math.round(((r.medianeMs - sans.medianeMs) / sans.medianeMs) * 100)} %`
        : "—";
    html += `<tr><td>${r.nom}</td><td class="num">${r.medianeMs}</td><td class="num">${surcout}</td><td class="num">${r.mots ? r.mots.length : "—"}</td></tr>`;
  }
  html += "</table>";

  if (avec?.mots?.length) {
    html +=
      '<p class="note">Exemple d\'horodatage (les instants sont en secondes depuis le debut du fragment) :</p><p class="texte">' +
      avec.mots
        .map((m) => `${m.mot}<sub>${m.debut != null ? m.debut.toFixed(2) : "?"}</sub>`)
        .join(" ") +
      "</p>";
  }

  html += "<h2>1b. Vitesse par modele (eliminatoire)</h2>";
  html +=
    '<p class="note">Un fragment fait ' +
    DUREE_SEGMENT +
    " s. S'il faut plus de " +
    DUREE_SEGMENT +
    " s pour le transcrire, le moteur ne suit plus le direct : la file grossit et la latence diverge. " +
    "Le modele est alors disqualifie quel que soit son WER.</p>";
  html += "<table><tr><th>Modele</th><th>ms / fragment</th><th>Part du temps reel</th><th>Poids</th><th>Verdict</th></tr>";
  for (const r of vit) {
    if (r.erreur) {
      html += `<tr><td>${r.nom}</td><td colspan="4" class="err">ECHEC : ${r.erreur}</td></tr>`;
      continue;
    }
    const part = (r.medianeMs / 1000 / DUREE_SEGMENT) * 100;
    const tenable = r.medianeMs < DUREE_SEGMENT * 1000;
    html += `<tr><td>${r.nom}</td><td class="num">${r.medianeMs}</td><td class="num">${part.toFixed(0)} %</td><td class="num">${r.poidsMo} Mo</td><td>${tenable ? "✅ tenable" : "⛔ trop lent"}</td></tr>`;
  }
  html += "</table>";

  sortiesEl.innerHTML = html + sortiesEl.innerHTML;
}

// ---------------------------------------------------------------------------
// 2. TABLEAU COMPLET : modele x niveau de bruit
// ---------------------------------------------------------------------------
//
// La reference du WER n'est PAS un texte ecrit a la main : c'est le texte que le
// modele produit sur l'extrait PROPRE, transcrit par la meme variante. On mesure
// donc « combien le bruit degrade ce modele », ce qui est la question posee.
// (Comparer a une verite terrain absolue melangerait deux effets : la qualite du
// modele et sa sensibilite au bruit.)
//
// On garde AUSSI le texte de tiny sur son propre comme reference commune, pour
// pouvoir comparer les modeles entre eux.
async function tableauComplet() {
  const audios = {};
  for (const clip of CLIPS) {
    etat(`Decodage ${clip.intitule}…`);
    audios[clip.intitule] = await decoderEn16kHz(clip.url);
    const snr = rapportSignalBruit(audios[clip.intitule], 0.2);
    log(
      `${clip.intitule} : ${(audios[clip.intitule].length / SAMPLE_RATE).toFixed(1)} s` +
        ` — rapport signal/bruit a 0.2 : ${snr.toFixed(1)} dB`
    );
  }
  log(
    `Rapport signal/bruit a 0.4 : ${rapportSignalBruit(audios.FR, 0.4).toFixed(1)} dB (FR)`
  );

  for (const config of MODELES) {
    if (annule) break;

    // Un seul worker par modele, reutilise pour tous les niveaux et toutes les
    // langues : le chargement coute cher (jusqu'a plusieurs secondes), et le
    // refaire 6 fois par modele ne mesurerait rien de plus.
    etat(`${config.nom} — chargement…`);
    const w = ouvrirWorker(config, null);
    let poidsMo = 0;
    try {
      const pret = await w.init();
      poidsMo = Math.round(w.poids() / 1024 / 1024);
      log(`\n=== ${config.nom} — charge en ${pret.ms} ms, ${poidsMo} Mo ===`, "ok");

      for (const clip of CLIPS) {
        const fragments = decouperEnFragments(audios[clip.intitule], NB_FRAGMENTS);

        // Texte de reference de CE modele sur son propre, fragment par fragment.
        const propres = [];

        for (const niveau of NIVEAUX) {
          if (annule) break;
          etat(`${config.nom} — ${clip.intitule} — musique ${niveau.gain}`);

          const temps = [];
          const textes = [];
          for (let i = 0; i < fragments.length; i++) {
            if (annule) break;
            const bruite = melanger(fragments[i], niveau.gain);
            const r = await w.transcrire(bruite, clip.langue);
            temps.push(r.ms);
            textes.push(r.texte);
            // Laisse respirer la machine entre deux inferences : c'est une
            // precaution thermique, pas une necessite technique.
            await new Promise((r2) => setTimeout(r2, 120));
          }
          if (annule) break;

          if (niveau.gain === 0) propres.push(...textes);

          // WER de ce niveau contre le texte du MEME modele sur son propre.
          const wer = textes.map((t, i) => tauxErreur(propres[i] || "", t));
          const werMoyen = wer.length
            ? Math.round(wer.reduce((a, b) => a + b, 0) / wer.length)
            : 0;

          const entree = {
            modele: config.nom,
            langue: clip.intitule,
            bruit: niveau.gain,
            medianeMs: mediane(temps),
            werContrePropre: niveau.gain === 0 ? 0 : werMoyen,
            poidsMo,
            textes,
          };
          acquis.cases.push(entree);
          sauver();

          log(
            `  ${clip.intitule} bruit ${niveau.gain} : ${entree.medianeMs} ms/fragment` +
              (niveau.gain === 0 ? " (reference)" : `, WER ${werMoyen} %`)
          );
          log(`    « ${textes[0] || "(vide)"} »`);
        }
      }
    } catch (err) {
      log(`${config.nom} : ECHEC — ${err.message}`, "err");
      acquis.cases.push({ modele: config.nom, erreur: err.message });
      sauver();
    } finally {
      w.fermer();
    }
  }

  afficherTableau();
  etat(annule ? "Interrompu — ce qui est acquis est sauvegarde." : "Tableau termine.");
}

function afficherTableau() {
  const cases = acquis.cases.filter((c) => !c.erreur);
  if (!cases.length) return;

  let html = "<h2>2. Tableau bruit x modele</h2>";
  html +=
    '<p class="note">WER mesure contre le texte du <strong>meme modele sur son propre</strong> : ' +
    "il dit combien le bruit degrade ce modele-la. Un WER identique partout signifie qu'un modele " +
    "plus gros n'apporte rien contre le bruit.</p>";

  for (const clip of CLIPS) {
    html += `<h3>${clip.intitule}</h3><table><tr><th>Modele</th><th>Poids</th>`;
    for (const n of NIVEAUX) html += `<th>ms — ${n.intitule}</th>`;
    for (const n of NIVEAUX) html += `<th>WER — ${n.intitule}</th>`;
    html += "</tr>";

    for (const config of MODELES) {
      const lignes = cases.filter((c) => c.modele === config.nom && c.langue === clip.intitule);
      if (!lignes.length) continue;
      html += `<tr><td>${config.nom}</td><td class="num">${lignes[0].poidsMo} Mo</td>`;
      for (const n of NIVEAUX) {
        const c = lignes.find((x) => x.bruit === n.gain);
        html += `<td class="num">${c ? c.medianeMs : "—"}</td>`;
      }
      for (const n of NIVEAUX) {
        const c = lignes.find((x) => x.bruit === n.gain);
        html += `<td class="num">${c ? (n.gain === 0 ? "ref" : c.werContrePropre + " %") : "—"}</td>`;
      }
      html += "</tr>";
    }
    html += "</table>";
  }

  // Les textes, pour juger a l'oeil -- c'est ce qui a manque la premiere fois.
  html += "<h2>3. Les textes produits (a lire, pas seulement a compter)</h2>";
  html +=
    '<p class="note">Le WER compte les mots faux ; il ne dit pas si le texte reste LISIBLE. ' +
    "C'est ici qu'on voit « lourire » a la place de « nourrir ».</p>";
  for (const clip of CLIPS) {
    html += `<h3>${clip.intitule} — premier fragment</h3><table><tr><th>Modele</th>`;
    for (const n of NIVEAUX) html += `<th>${n.intitule}</th>`;
    html += "</tr>";
    for (const config of MODELES) {
      const lignes = cases.filter((c) => c.modele === config.nom && c.langue === clip.intitule);
      if (!lignes.length) continue;
      html += `<tr><td>${config.nom}</td>`;
      for (const n of NIVEAUX) {
        const c = lignes.find((x) => x.bruit === n.gain);
        html += `<td class="texte">${c ? (c.textes[0] || "(vide)") : "—"}</td>`;
      }
      html += "</tr>";
    }
    html += "</table>";
  }

  sortiesEl.innerHTML = html + sortiesEl.innerHTML;
}

// ---------------------------------------------------------------------------

document.getElementById("sonde").addEventListener("click", async () => {
  annule = false;
  document.getElementById("sonde").disabled = true;
  document.getElementById("complet").disabled = true;
  try {
    await sondeRapide();
  } catch (err) {
    log("ECHEC : " + err.message, "err");
    console.error(err);
  }
  document.getElementById("sonde").disabled = false;
  document.getElementById("complet").disabled = false;
});

document.getElementById("complet").addEventListener("click", async () => {
  annule = false;
  document.getElementById("sonde").disabled = true;
  document.getElementById("complet").disabled = true;
  try {
    await tableauComplet();
  } catch (err) {
    log("ECHEC : " + err.message, "err");
    console.error(err);
  }
  document.getElementById("sonde").disabled = false;
  document.getElementById("complet").disabled = false;
});

document.getElementById("stop").addEventListener("click", () => {
  annule = true;
  log("Arret demande — la mesure en cours se termine puis on s'arrete.", "warn");
});

sauver();
log("Page de mesure prete. Commence par la sonde rapide.");
