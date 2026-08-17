// Comparaison de plusieurs variantes de Whisper, dans les conditions de LiveSub.
//
// Pourquoi cette page ? On veut savoir si un modele quantifie (plus leger, plus
// rapide en theorie) transcrit toujours correctement -- en anglais ET en
// francais. La reponse ne se devine pas : elle se mesure. Cette page fait donc
// tourner chaque variante sur EXACTEMENT le meme audio, chronometre, et affiche
// les textes cote a cote.
//
// Elle ne remplace pas le test bout-en-bout (capture -> VAD -> overlay) : elle
// isole la seule etape qui change, la transcription.
//
// Le worker de production est reutilise tel quel ; on lui passe la variante a
// charger dans sa query string (?modele=...&dtype=...). Aucun code duplique :
// ce qu'on mesure ici est litteralement ce qui tournera en production.

const SAMPLE_RATE = 16000;

// Meme duree que DUREE_MAX dans offscreen.js : c'est la taille des extraits que
// le VAD envoie reellement a Whisper. Mesurer sur des extraits de 10 s donnerait
// un chiffre qui ne correspond a rien de ce que vit l'utilisateur.
//
// A garder aligne sur offscreen.js. C'est justement ce que ce banc a servi a
// trancher : a 2,5 s toutes les variantes hallucinaient, a 7 s beaucoup moins.
const DUREE_SEGMENT = 7;

// Nombre de segments chronometres par langue. Assez pour une mediane stable,
// pas trop pour que la page ne tourne pas pendant une demi-heure.
const NB_SEGMENTS = 12;

// Les extraits de test durent 11 s et 6 s : plus courts qu'un segment de 7 s.
// On les repete, exactement comme la page de test bout-en-bout qui les joue en
// boucle. Les coupures tombent alors a des endroits varies, y compris a cheval
// sur le raccord -- ce qui est bien le cas le plus dur.
const REPETITIONS = 4;

function repeter(audio, fois) {
  const total = new Float32Array(audio.length * fois);
  for (let i = 0; i < fois; i++) total.set(audio, i * audio.length);
  return total;
}

// Les extraits de test sont courts (11 s et 6 s) : decoupes une seule fois, ils
// ne donnent que 4 et 2 segments. On les redecoupe donc plusieurs fois avec des
// departs decales, ce qui multiplie les fragments sans changer l'audio.
//
// Ce n'est pas de la triche statistique : chaque decalage produit une coupure
// DIFFERENTE, donc un fragment different. Et c'est exactement ce qui arrive en
// vrai -- LiveSub coupe a 2,5 s sans savoir ou en est la phrase.
const DECALAGES = [0, 0.6, 1.2, 1.8];

// La premiere variante sert de REFERENCE : c'est celle qui tourne aujourd'hui
// et qui a ete validee. Les suivantes sont comparees a son texte.
// Note sur `opt` (niveau d'optimisation du graphe ONNX) : sans lui, q8 et fp16
// ne CHARGENT pas du tout sur cette version d'ONNX Runtime -- ce sont des
// passes de fusion "extended" qui plantent, pas les poids. D'ou les variantes
// qui abaissent ce niveau : c'est le seul moyen de savoir si le modele
// quantifie est utilisable ici.
const OC = "onnx-community/whisper-tiny";

const CONFIGS = [
  {
    nom: "Xenova · fp32",
    detail: "la variante retenue (reference)",
    modele: "Xenova/whisper-tiny",
    dtype: "fp32",
    // On ecrit le niveau noir sur blanc plutot que de laisser le defaut : la
    // comparaison ne veut rien dire si une variante change de reglage sans
    // qu'on le voie.
    opt: "all",
  },
  {
    nom: "onnx-community · q8 (opt basic)",
    detail: "quantifie 8 bits, fusions extended desactivees",
    modele: OC,
    dtype: "q8",
    opt: "basic",
  },
  {
    nom: "onnx-community · encodeur q8",
    detail: "encodeur quantifie, decodeur fp32 (le decodeur est ce qui casse)",
    modele: OC,
    dtype: '{"encoder_model":"q8","decoder_model_merged":"fp32"}',
    opt: "basic",
  },
];

// On compare les variantes sur le PROCESSEUR : c'est le backend que la mesure
// GPU/CPU a retenu sur cette machine, donc celui qui tourne en production. Le
// forcer evite en plus qu'une variante soit mesuree sur un backend et une autre
// sur l'autre -- la comparaison ne voudrait plus rien dire.
const BACKEND = "wasm";

const CLIPS = [
  { fichier: "test/speech.wav", langue: "english", intitule: "Anglais" },
  { fichier: "test/speech-fr.mp3", langue: "french", intitule: "Francais" },
];

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

const logDiv = document.getElementById("log");
const etatDiv = document.getElementById("etat");
const tableauDiv = document.getElementById("tableau");

function log(message, className) {
  console.log(message);
  const ligne = document.createElement("div");
  ligne.textContent = message;
  if (className) ligne.className = className;
  logDiv.appendChild(ligne);
  logDiv.scrollTop = logDiv.scrollHeight;
}

function etat(message) {
  etatDiv.textContent = message;
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

// Meme decodage que test-whisper.js : 16 kHz mono, comme ce que produit le VAD.
async function decoderEn16kHz(url) {
  const donnees = await (await fetch(url)).arrayBuffer();
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
    return new Float32Array(decode.getChannelData(0));
  } finally {
    ctx.close();
  }
}

// Decoupe l'extrait en tranches de DUREE_SEGMENT, en sautant le tout debut
// (souvent du silence) et les tranches vides. On prend des tranches CONSECUTIVES
// au milieu du fichier : c'est la ou il y a de la parole a coup sur.
function decouperEnSegments(audio, combien) {
  const taille = Math.round(DUREE_SEGMENT * SAMPLE_RATE);
  const segments = [];

  for (const decalage of DECALAGES) {
    let debut = Math.round(decalage * SAMPLE_RATE);

    while (segments.length < combien && debut + taille <= audio.length) {
      const tranche = audio.subarray(debut, debut + taille);
      // Energie moyenne : une tranche de silence ne mesurerait que le temps de
      // decodage a vide, pas le vrai cout d'un segment de parole.
      let energie = 0;
      for (let i = 0; i < tranche.length; i++) energie += tranche[i] * tranche[i];
      if (Math.sqrt(energie / tranche.length) > 0.01) segments.push(tranche);
      debut += taille;
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Le worker (un par variante, jete apres usage)
// ---------------------------------------------------------------------------

// ONNX Runtime ne charge qu'un moteur WASM par worker et ne le relache jamais :
// il FAUT un worker neuf par variante, sinon la deuxieme mesure herite du
// moteur de la premiere. (Meme raison que dans whisper.worker.js.)
function ouvrirWorker(config) {
  const url = new URL(chrome.runtime.getURL("whisper.worker.js"));
  url.searchParams.set("modele", config.modele);
  url.searchParams.set("dtype", config.dtype);
  if (config.opt) url.searchParams.set("opt", config.opt);

  const worker = new Worker(url.href, { type: "module" });
  const enAttente = new Map();
  let prochainId = 1;
  // Poids des fichiers telecharges, par nom de fichier (on garde le max : le
  // meme fichier est annonce plusieurs fois pendant le telechargement).
  const octetsParFichier = new Map();

  worker.onmessage = (event) => {
    const message = event.data;
    switch (message.type) {
      case "ready":
        enAttente.get("init")?.resolve(message);
        enAttente.delete("init");
        break;
      case "progress":
        if (message.octets) octetsParFichier.set(message.fichier, message.octets);
        etat(`${config.nom} — telechargement ${message.fichier} ${message.pourcent} %`);
        break;
      case "info":
        log(`   ℹ️  ${message.message}`);
        break;
      case "result":
        enAttente.get(message.id)?.resolve(message);
        enAttente.delete(message.id);
        break;
      case "error": {
        const cle = message.id ?? "init";
        const attente = enAttente.get(cle);
        enAttente.delete(cle);
        if (attente) attente.reject(new Error(message.message));
        else log(`   ❌ ${message.message}`, "err");
        break;
      }
    }
  };

  worker.onerror = (event) => {
    const erreur = new Error(event.message || "erreur inconnue dans le worker");
    for (const attente of enAttente.values()) attente.reject(erreur);
    enAttente.clear();
  };

  const attendre = (cle) =>
    new Promise((resolve, reject) => enAttente.set(cle, { resolve, reject }));

  return {
    async init() {
      const promesse = attendre("init");
      // `forcer` : pas de memoire, pas de repli silencieux sur un autre backend.
      // Si cette variante ne tient pas sur ce backend, on veut le savoir.
      worker.postMessage({ type: "init", forcer: BACKEND });
      return promesse;
    },
    transcrire(audio, langue) {
      const id = prochainId++;
      const promesse = attendre(id);
      worker.postMessage({ type: "transcribe", id, audio, langue }, [audio.buffer]);
      return promesse;
    },
    poids() {
      let total = 0;
      for (const octets of octetsParFichier.values()) total += octets;
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

// Normalisation avant comparaison : la ponctuation et la casse varient d'une
// variante a l'autre sans que le sous-titre soit faux pour autant.
function mots(texte) {
  return texte
    .toLowerCase()
    .replace(/['']/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .split(/\s+/)
    .filter(Boolean);
}

// Taux d'erreur mot a mot (WER) par rapport au texte de reference : nombre de
// mots a ajouter / supprimer / remplacer pour retomber sur la reference, divise
// par le nombre de mots de la reference. 0 % = texte identique.
function tauxErreur(reference, candidat) {
  const a = mots(reference);
  const b = mots(candidat);
  if (a.length === 0) return b.length === 0 ? 0 : 100;

  // Distance de Levenshtein sur les mots, en n'gardant que deux lignes.
  let precedente = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const courante = [i];
    for (let j = 1; j <= b.length; j++) {
      courante[j] = Math.min(
        precedente[j] + 1, // suppression
        courante[j - 1] + 1, // insertion
        precedente[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
    }
    precedente = courante;
  }
  return Math.round((precedente[b.length] / a.length) * 100);
}

// ---------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------

function mediane(valeurs) {
  const triees = [...valeurs].sort((x, y) => x - y);
  const milieu = Math.floor(triees.length / 2);
  return triees.length % 2 ? triees[milieu] : (triees[milieu - 1] + triees[milieu]) / 2;
}

function moyenne(valeurs) {
  return valeurs.reduce((somme, v) => somme + v, 0) / valeurs.length;
}

// ---------------------------------------------------------------------------
// Le test
// ---------------------------------------------------------------------------

async function mesurerUneConfig(config, audios) {
  log("");
  log(`▶ ${config.nom} — ${config.detail}`, "titre");

  const worker = ouvrirWorker(config);
  const resultat = { config, segments: {}, textes: {}, erreur: null };

  try {
    etat(`${config.nom} — chargement du modele...`);
    const debutChargement = performance.now();
    const pret = await worker.init();
    resultat.msChargement = Math.round(performance.now() - debutChargement);
    resultat.poids = worker.poids();
    resultat.backend = pret.backend;

    const poidsMo = resultat.poids ? `${(resultat.poids / 1024 / 1024).toFixed(1)} Mo` : "?";
    log(
      `   modele charge en ${(resultat.msChargement / 1000).toFixed(1)} s ` +
        `(${poidsMo} de fichiers, backend ${resultat.backend})`
    );

    for (const clip of CLIPS) {
      const { audio, segments } = audios[clip.fichier];

      // --- Fragments de DUREE_SEGMENT : le regime reel de LiveSub. ----------
      etat(`${config.nom} — segments ${clip.intitule}...`);
      const temps = [];
      const textesSegments = [];
      for (const segment of segments) {
        // .slice() : le buffer est TRANSFERE au worker, donc detruit cote page.
        // Sans copie, la variante suivante n'aurait plus d'audio a mesurer.
        const reponse = await worker.transcrire(segment.slice(), clip.langue);
        temps.push(reponse.ms);
        textesSegments.push(reponse.texte);
      }
      resultat.segments[clip.intitule] = {
        temps,
        mediane: Math.round(mediane(temps)),
        moyenne: Math.round(moyenne(temps)),
        min: Math.min(...temps),
        max: Math.max(...temps),
        textes: textesSegments,
      };
      log(
        `   segments ${clip.intitule} (${temps.length} × ${DUREE_SEGMENT} s) : ` +
          `mediane ${resultat.segments[clip.intitule].mediane} ms ` +
          `(min ${resultat.segments[clip.intitule].min}, max ${resultat.segments[clip.intitule].max})`
      );

      // --- Extrait complet : la reference « audio propre ». ------------------
      // Sur un fragment isole, tous les modeles ont l'air moyens ; sur une phrase
      // entiere, une variante degradee se voit tout de suite.
      etat(`${config.nom} — extrait complet ${clip.intitule}...`);
      const debutComplet = performance.now();
      const complet = await worker.transcrire(audio.slice(), clip.langue);
      resultat.textes[clip.intitule] = {
        texte: complet.texte,
        ms: complet.ms,
        msTotal: Math.round(performance.now() - debutComplet),
      };
      log(`   texte ${clip.intitule} (${(complet.ms / 1000).toFixed(1)} s) : « ${complet.texte} »`);
    }
  } catch (error) {
    resultat.erreur = String(error?.message || error);
    log(`   ❌ ${resultat.erreur}`, "err");
  } finally {
    worker.fermer();
  }

  return resultat;
}

function afficherTableau(resultats) {
  const reference = resultats[0];
  const lignes = [];

  const entete = ["Variante", "Poids", "Chargement", ...CLIPS.map((c) => `Segment ${c.intitule}`), ...CLIPS.map((c) => `WER ${c.intitule}`)];

  for (const r of resultats) {
    if (r.erreur) {
      lignes.push([r.config.nom, "—", "—", ...CLIPS.map(() => "échec"), ...CLIPS.map(() => "—")]);
      continue;
    }
    const cellules = [
      r.config.nom,
      r.poids ? `${(r.poids / 1024 / 1024).toFixed(0)} Mo` : "?",
      `${(r.msChargement / 1000).toFixed(1)} s`,
    ];
    for (const clip of CLIPS) {
      const s = r.segments[clip.intitule];
      const ecart =
        r === reference || !reference.segments[clip.intitule]
          ? ""
          : ` (${(s.mediane / reference.segments[clip.intitule].mediane).toFixed(2)}×)`;
      cellules.push(`${s.mediane} ms${ecart}`);
    }
    for (const clip of CLIPS) {
      cellules.push(
        r === reference
          ? "référence"
          : `${tauxErreur(reference.textes[clip.intitule].texte, r.textes[clip.intitule].texte)} %`
      );
    }
    lignes.push(cellules);
  }

  const table = document.createElement("table");
  const trEntete = document.createElement("tr");
  for (const titre of entete) {
    const th = document.createElement("th");
    th.textContent = titre;
    trEntete.appendChild(th);
  }
  table.appendChild(trEntete);
  for (const ligne of lignes) {
    const tr = document.createElement("tr");
    for (const cellule of ligne) {
      const td = document.createElement("td");
      td.textContent = cellule;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  tableauDiv.textContent = "";
  tableauDiv.appendChild(table);
}

// Les textes des fragments de 2,5 s, variante par variante.
//
// C'est le tableau le plus important de la page : le WER sur l'extrait entier
// dit si le modele sait transcrire une phrase propre, mais LiveSub ne lui donne
// JAMAIS de phrase propre -- il lui donne des bouts de 2,5 s coupes en plein
// milieu. Une variante peut avoir 0 % de WER sur l'extrait complet et se mettre
// a inventer des phrases entieres sur les fragments.
function afficherFragments(resultats) {
  const valides = resultats.filter((r) => !r.erreur);
  if (valides.length < 2) return;

  const conteneur = document.getElementById("fragments");
  conteneur.textContent = "";

  for (const clip of CLIPS) {
    const titre = document.createElement("h3");
    titre.textContent = `Fragments de ${DUREE_SEGMENT} s — ${clip.intitule}`;
    conteneur.appendChild(titre);

    const table = document.createElement("table");
    const trEntete = document.createElement("tr");
    for (const libelle of ["#", ...valides.map((r) => r.config.nom)]) {
      const th = document.createElement("th");
      th.textContent = libelle;
      trEntete.appendChild(th);
    }
    table.appendChild(trEntete);

    const nb = valides[0].segments[clip.intitule].textes.length;
    for (let i = 0; i < nb; i++) {
      const tr = document.createElement("tr");
      const num = document.createElement("td");
      num.textContent = String(i + 1);
      tr.appendChild(num);
      for (const r of valides) {
        const td = document.createElement("td");
        td.textContent = r.segments[clip.intitule].textes[i] || "(vide)";
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    conteneur.appendChild(table);
  }
}

async function main() {
  logDiv.textContent = "";
  log(`Backend force : ${BACKEND === "wasm" ? "processeur (WASM)" : BACKEND}`);
  log(`Segments de ${DUREE_SEGMENT} s, comme le decoupage de offscreen.js.`);

  // Audio decode UNE FOIS, partage par toutes les variantes : sans ca on ne
  // comparerait pas les modeles sur le meme signal.
  const audios = {};
  for (const clip of CLIPS) {
    const audio = await decoderEn16kHz(chrome.runtime.getURL(clip.fichier));
    // `audio` (une seule fois) sert au texte de reference sur audio propre ;
    // la version repetee sert a fabriquer les fragments.
    const segments = decouperEnSegments(repeter(audio, REPETITIONS), NB_SEGMENTS);
    audios[clip.fichier] = { audio, segments };
    log(
      `${clip.intitule} : ${(audio.length / SAMPLE_RATE).toFixed(1)} s d'audio ` +
        `(x${REPETITIONS} pour le decoupage), ${segments.length} fragments retenus`
    );
  }

  const resultats = [];
  for (const config of CONFIGS) {
    resultats.push(await mesurerUneConfig(config, audios));
    afficherTableau(resultats);
    afficherFragments(resultats);
  }

  // Recuperable depuis la console / l'automatisation.
  window.RESULTATS = resultats;
  etat("Termine.");
  log("");
  log("✅ Comparaison terminee.", "ok");
}

main().catch((error) => {
  etat("Echec.");
  log(`❌ ${error.message || error}`, "err");
  console.error(error);
  window.RESULTATS = { erreur: String(error?.message || error) };
});
