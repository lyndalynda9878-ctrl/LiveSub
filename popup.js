// La popup de LiveSub : UN bouton, et UN seul reglage — la paire de langues.
//
// ⚠️ CE QUI A DISPARU A L'ETAPE 5, AVEC LE MODE DIRECT :
//
//   - le bouton Demarrer/Arreter du direct, son statut, son `updateUI` et les
//     messages GET_STATE / TOGGLE_SUBTITLES ;
//   - le selecteur de MODE (`modeLiveSub`) : il n'y a plus qu'un mode ;
//   - le menu de LANGUE PARLEE (`langueSousTitres`) : Parakeet detecte la langue
//     tout seul pour TRANSCRIRE, son vocabulaire ne contient aucun jeton de
//     langue. Le menu etait devenu un bouton debranche ;
//   - le RETARD DU SON (`retardAudio`) et son affichage de calibration ;
//   - la case « Afficher la fin provisoire » (`afficherProvisoire`).
//
// ⚠️ ET CE QUI REVIENT, POUR UNE RAISON DIFFERENTE — la langue de depart.
//
// Elle n'est PAS revenue pour la transcription : Parakeet n'en a toujours aucun
// besoin. Elle revient parce que l'API Translator de Chrome, elle, l'exige.
// Mesure du 2026-08-31, dans Chrome 151 :
//
//     Translator.create({ sourceLanguage: "auto", ... })
//       -> RangeError: Invalid language tag: auto
//     Translator.create({ targetLanguage: "en" })            // source omise
//       -> TypeError: Failed to read the 'sourceLanguage' property from
//          'TranslatorCreateCoreOptions': Required member is undefined.
//     Translator.create({ sourceLanguage: "und", ... })
//       -> NotSupportedError
//     LanguageDetector.availability()  ->  "unavailable"
//
// Il n'y a donc aucun moyen de laisser Chrome deviner. La case est pre-remplie
// par une devinette locale, et corrigee a l'oeil si elle se trompe.
//
// ===========================================================================
// ⚠️ POURQUOI LE TELECHARGEMENT EST ICI, ET NULLE PART AILLEURS
// ===========================================================================
//
// Mesure du 2026-08-31 (docs/mesures/traduction/RESULTATS.md) :
//
//   - une paire DEJA INSTALLEE se cree sans le moindre geste utilisateur, y
//     compris dans le document offscreen (`isActive: false`, et ca passe) ;
//   - une paire ABSENTE leve, partout :
//         NotAllowedError: Requires a user gesture when availability is
//         "downloading" or "downloadable".
//
// Le clic sur Demarrer est le SEUL instant de tout LiveSub ou une activation
// utilisateur existe. Le telechargement se fait donc ici, dans le gestionnaire
// de clic, et la preparation ne demarre qu'apres.
//
// ⚠️ ET ON NE SE SERT PAS DE `availability()` POUR DECIDER. Le meme mot
// "downloadable" a recouvert une creation en 208 ms (paire deja presente) et un
// telechargement de 20 533 ms (paire absente) : facteur 100. Le seul temoin
// honnete est l'evenement `downloadprogress`, et il ne donne PAS d'octets --
// `e.total` vaut 1 et `e.loaded` va de 0 a 1. C'est une fraction, pas une
// taille : on affiche donc un pourcentage, jamais des megaoctets.

const prepBtn = document.getElementById("prepBtn");
const prepStatus = document.getElementById("prepStatus");
const tradSource = document.getElementById("tradSource");
const tradCible = document.getElementById("tradCible");
const tradAide = document.getElementById("tradAide");
const refaireBtn = document.getElementById("refaireBtn");
const memInfo = document.getElementById("memInfo");

const TRAD_CLE = "traductionPaire";

// ---------------------------------------------------------------------------
// Les deux listes
// ---------------------------------------------------------------------------
//
// DEPART : les 25 langues europeennes de Parakeet TDT 0.6B v3. C'est le modele
// qui borne cette liste -- proposer une langue qu'il ne transcrit pas serait
// proposer un sous-titre vide.
const LANGUES_DEPART = [
  ["de", "Allemand"], ["en", "Anglais"], ["bg", "Bulgare"], ["hr", "Croate"],
  ["da", "Danois"], ["es", "Espagnol"], ["et", "Estonien"], ["fi", "Finnois"],
  ["fr", "Français"], ["el", "Grec"], ["hu", "Hongrois"], ["it", "Italien"],
  ["lv", "Letton"], ["lt", "Lituanien"], ["mt", "Maltais"], ["nl", "Néerlandais"],
  ["pl", "Polonais"], ["pt", "Portugais"], ["ro", "Roumain"], ["ru", "Russe"],
  ["sk", "Slovaque"], ["sl", "Slovène"], ["sv", "Suédois"], ["cs", "Tchèque"],
  ["uk", "Ukrainien"],
];

// ARRIVEE : les langues que Chrome a annoncees `available` ou `downloadable` sur
// cette machine le 2026-08-31 (sonde sur 68 codes). Les 35 autres essayees
// rendaient `unavailable` et n'ont donc rien a faire dans un menu.
//
// ⚠️ Cette liste ne PROMET rien : `availability()` ment (voir plus haut). Elle
// evite seulement de proposer ce dont on sait deja que ca ne marchera pas. La
// verite reste `create()`, au clic.
const LANGUES_ARRIVEE = [
  ["de", "Allemand"], ["en", "Anglais"], ["ar", "Arabe"], ["bn", "Bengali"],
  ["bg", "Bulgare"], ["zh", "Chinois (simplifié)"], ["zh-Hant", "Chinois (traditionnel)"],
  ["ko", "Coréen"], ["hr", "Croate"], ["da", "Danois"], ["es", "Espagnol"],
  ["fi", "Finnois"], ["fr", "Français"], ["el", "Grec"], ["he", "Hébreu"],
  ["hi", "Hindi"], ["hu", "Hongrois"], ["id", "Indonésien"], ["it", "Italien"],
  ["ja", "Japonais"], ["kn", "Kannada"], ["lt", "Lituanien"], ["mr", "Marathi"],
  ["nl", "Néerlandais"], ["pl", "Polonais"], ["pt", "Portugais"], ["ro", "Roumain"],
  ["ru", "Russe"], ["sk", "Slovaque"], ["sv", "Suédois"], ["ta", "Tamoul"],
  ["cs", "Tchèque"], ["te", "Télougou"], ["th", "Thaï"], ["tr", "Turc"],
  ["uk", "Ukrainien"], ["vi", "Vietnamien"],
];

const NOM_LANGUE = new Map([...LANGUES_DEPART, ...LANGUES_ARRIVEE]);
function nomDe(code) {
  return NOM_LANGUE.get(code) || code;
}

function remplir(select, langues, premier) {
  select.textContent = "";
  if (premier) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = premier;
    select.appendChild(o);
  }
  for (const [code, nom] of langues) {
    const o = document.createElement("option");
    o.value = code;
    o.textContent = nom;
    select.appendChild(o);
  }
}

remplir(tradSource, LANGUES_DEPART, null);
remplir(tradCible, LANGUES_ARRIVEE, "Langue d'origine (pas de traduction)");

// ---------------------------------------------------------------------------
// La devinette de langue de depart
// ---------------------------------------------------------------------------
//
// `chrome.i18n.detectLanguage` est le detecteur compact embarque dans Chrome :
// 100 % local, aucune requete. Il ne remplace pas `LanguageDetector` (qui est
// `unavailable` sur cette machine) pour la qualite, mais il n'a pas a le faire :
// il ne fait que PRE-REMPLIR une case.
//
// ⚠️ Un choix deja memorise l'emporte TOUJOURS sur la devinette. Une devinette
// qui ecrase une decision serait un reglage qui se defait tout seul.
async function devinerDepart() {
  try {
    const [onglet] = await chrome.tabs.query({ active: true, currentWindow: true });
    const titre = (onglet && onglet.title) || "";
    if (titre.trim().length < 8) return null;
    const r = await chrome.i18n.detectLanguage(titre);
    const premier = r && r.languages && r.languages[0];
    if (!premier) return null;
    const code = String(premier.language).split("-")[0];
    if (!LANGUES_DEPART.some(([c]) => c === code)) return null;
    return { code, fiable: Boolean(r.isReliable), titre };
  } catch (err) {
    return null;
  }
}

let tradDevinette = null;

function tradMajAide() {
  if (!tradCible.value) {
    tradAide.textContent = "Aucune traduction : le texte de Parakeet, tel quel.";
    return;
  }
  if (tradSource.value === tradCible.value) {
    tradAide.textContent =
      "Départ et arrivée sont la même langue : il n'y a rien à traduire.";
    return;
  }
  const base = `Traduction ${nomDe(tradSource.value)} → ${nomDe(tradCible.value)}.`;
  tradAide.textContent = tradDevinette
    ? base + ` Départ deviné sur le titre de l'onglet (${tradDevinette.fiable ? "fiable" : "peu sûr"}).`
    : base;
}

async function tradCharger() {
  let memorise = null;
  try {
    const range = await chrome.storage.local.get(TRAD_CLE);
    memorise = range[TRAD_CLE] || null;
  } catch (err) {
    /* premier lancement */
  }

  if (memorise && memorise.source) {
    tradSource.value = memorise.source;
  } else {
    tradDevinette = await devinerDepart();
    tradSource.value = (tradDevinette && tradDevinette.code) || "fr";
    if (tradDevinette) {
      console.log(
        `🔤 LiveSub : langue de départ devinée « ${tradDevinette.code} » ` +
          `(fiable ${tradDevinette.fiable}) sur le titre « ${tradDevinette.titre} »`
      );
    }
  }
  tradCible.value = (memorise && memorise.cible) || "";
  tradMajAide();
}

function tradMemoriser() {
  chrome.storage.local
    .set({ [TRAD_CLE]: { source: tradSource.value, cible: tradCible.value } })
    .catch(() => {});
  tradMajAide();
  // ⚠️ LE BOUTON CHANGE DE SENS AVEC LA LANGUE D'ARRIVEE, et il doit le dire
  // TOUT DE SUITE. Sur une video deja preparee, choisir une langue deja en
  // memoire donne « afficher » (instantane) et une langue absente donne
  // « traduire » (quelques secondes) : ce sont deux actions differentes
  // derriere le meme bouton, donc deux libelles differents.
  prepMajUI();
}

tradSource.addEventListener("change", tradMemoriser);
tradCible.addEventListener("change", tradMemoriser);

// ---------------------------------------------------------------------------
// Installer la paire — DANS LE GESTIONNAIRE DE CLIC
// ---------------------------------------------------------------------------
//
// ⚠️ Cette fonction doit etre appelee depuis le clic, et le `await` qui la
// precede doit etre le PREMIER : l'activation utilisateur de Chrome dure ~5 s et
// ne survit pas a une attente longue. Mesure du 2026-08-31 : `create()` appele
// 10 s apres le clic, sur une paire absente, echoue avec
// `NotAllowedError`, alors que le meme appel immediat reussit et telecharge
// 79,6 Mo en 20,5 s.
//
// Renvoie { ok: true } ou { ok: false, message }. AUCUN repli : un echec ici
// empeche la preparation de demarrer.
async function tradInstallerPaire(source, cible) {
  if (!cible) return { ok: true, sansTraduction: true };
  if (source === cible) {
    return {
      ok: false,
      message:
        `Départ et arrivée sont tous deux « ${nomDe(source)} ».\n` +
        `Choisis « Langue d'origine » si tu ne veux pas de traduction.`,
    };
  }
  if (!("Translator" in self)) {
    return {
      ok: false,
      message: "Ce Chrome n'a pas l'API Translator.\nIl faut Chrome 138 ou plus récent.",
    };
  }

  const t0 = performance.now();
  let dernierPourcent = -1;
  try {
    const traducteur = await Translator.create({
      sourceLanguage: source,
      targetLanguage: cible,
      // ⚠️ LE SEUL TEMOIN HONNETE. `availability()` n'est pas consulte : il
      // annonce "downloadable" aussi bien pour une paire deja presente que pour
      // une paire de 80 Mo a descendre.
      monitor(m) {
        m.addEventListener("downloadprogress", (evenement) => {
          // `loaded` est une FRACTION de 0 a 1, `total` vaut 1. Pas des octets.
          const total = evenement.total || 1;
          const pourcent = Math.round((evenement.loaded / total) * 100);
          if (pourcent === dernierPourcent) return;
          dernierPourcent = pourcent;
          prepSetStatus(
            `⬇️ Installation ${nomDe(source)} → ${nomDe(cible)} : ${pourcent} %`,
            "#4f46e5"
          );
        });
      },
    });
    // On rend le traducteur tout de suite : celui qui traduira vit dans le
    // document offscreen. Ce qui compte, c'est que la PAIRE soit installee --
    // elle l'est pour tout le navigateur, pas pour ce document.
    try { if (traducteur.destroy) traducteur.destroy(); } catch (e) { /* deja ferme */ }
    return { ok: true, ms: Math.round(performance.now() - t0), pourcentVu: dernierPourcent };
  } catch (err) {
    // L'erreur ENTIERE : `NotAllowedError` (paire absente, plus d'activation) et
    // `NotSupportedError` (Chrome ne sait pas faire cette paire) ne se reglent
    // pas de la meme facon, et un message resume les confondrait.
    return {
      ok: false,
      message:
        `Traduction ${nomDe(source)} → ${nomDe(cible)} impossible.\n` +
        `${(err && err.name) || "Erreur"} : ${(err && err.message) || err}`,
    };
  }
}

// ---------------------------------------------------------------------------

let prepActif = false;
let prepMessage = null;

function prepSetStatus(texte, couleur) {
  prepStatus.textContent = texte;
  prepStatus.style.color = couleur;
  prepStatus.title = texte;
}

// ---------------------------------------------------------------------------
// LA MEMOIRE, VUE DE LA POPUP
// ---------------------------------------------------------------------------
//
// ⚠️ LA POPUP NE DEVINE RIEN, ICI NON PLUS. Elle demande au service worker
// (`MEMOIRE_ETAT`) ce qu'il y a en memoire pour la video de l'onglet actif, et
// elle affiche la reponse. C'est lui qui a le storage, et lui seul qui sait si
// la duree correspond.
let memEtat = null;

// Ce que le bouton principal va faire, en un mot. C'est la SEULE fonction qui
// en decide -- le libelle, l'action au clic et le bouton « Refaire » lisent tous
// les trois celle-ci, donc ils ne peuvent pas se contredire.
//
//   "demarrer"  video inconnue        -> preparation complete (des minutes)
//   "afficher"  tout est en memoire   -> rien a calculer (instantane)
//   "traduire"  transcription en
//               memoire, pas cette
//               langue d'arrivee      -> retraduction seule (des secondes)
function memModeBouton() {
  if (!memEtat || !memEtat.connue || !memEtat.resume) return "demarrer";
  const cible = tradCible.value;
  if (!cible) return "afficher";
  return (memEtat.resume.langues || []).includes(cible) ? "afficher" : "traduire";
}

function memDate(quand) {
  if (!quand) return "date inconnue";
  try {
    return new Date(quand).toLocaleString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (err) {
    return String(quand);
  }
}

function memKo(octets) {
  return Math.round((Number(octets) || 0) / 1024).toLocaleString("fr-FR") + " Ko";
}

// ⚠️ LA PLACE EST AFFICHEE TOUJOURS, meme quand la video est inconnue. Le
// storage est borne a ~10 Mo et il n'y a PAS de permission `unlimitedStorage` :
// voir le compteur monter est la seule facon de ne pas etre surpris le jour ou
// une preparation en chasse une autre.
function memMajInfo() {
  if (!memEtat) {
    memInfo.textContent = "";
    return;
  }
  const lignes = [];

  if (memEtat.connue && memEtat.resume) {
    const r = memEtat.resume;
    lignes.push(
      `✅ Déjà préparé — ${r.nbMots.toLocaleString("fr-FR")} mots, le ${memDate(r.quand)}`
    );
    const langues = r.langues || [];
    lignes.push(
      langues.length
        ? `🌍 Traductions en mémoire : ${langues.map(nomDe).join(", ")}`
        : "🌍 Aucune traduction en mémoire (texte d'origine seul)"
    );
    if (memModeBouton() === "traduire") {
      lignes.push(
        `↳ ${nomDe(tradCible.value)} n'y est pas : il TRADUIRA seulement, ` +
          `sans retranscrire.`
      );
    }
    lignes.push(`📦 Cette vidéo : ${memKo(r.octets)}`);
  } else if (memEtat.raison) {
    lignes.push("🆕 Pas en mémoire — " + memEtat.raison);
  } else if (memEtat.erreur) {
    lignes.push("⚠️ " + memEtat.erreur);
  } else {
    lignes.push("🆕 Vidéo inconnue — la préparation va tout transcrire.");
  }

  const place = memEtat.place;
  if (place) {
    const n = (memEtat.inventaire || []).length;
    lignes.push(
      `💾 Mémoire : ${memKo(place.octets)} / ${memKo(place.quota)} (${place.pourcent} %) — ` +
        `${n} préparation${n > 1 ? "s" : ""}`
    );
  }

  memInfo.textContent = lignes.join("\n");
}

function prepMajUI() {
  prepBtn.disabled = false;
  const mode = memModeBouton();

  if (prepActif) {
    prepBtn.textContent = "⏹️ Arreter";
    prepBtn.className = "stop";
  } else if (mode === "afficher") {
    prepBtn.textContent = "✅ Deja prepare — afficher les sous-titres";
    prepBtn.className = "memoire";
  } else if (mode === "traduire") {
    prepBtn.textContent = "✅ Deja prepare — traduire vers " + nomDe(tradCible.value);
    prepBtn.className = "memoire";
  } else {
    prepBtn.textContent = "▶️ Demarrer";
    prepBtn.className = "";
  }

  // ⚠️ « Refaire » n'existe que s'il y a quelque chose a refaire.
  refaireBtn.hidden = prepActif || mode === "demarrer";
  memMajInfo();

  if (prepMessage) {
    prepSetStatus(prepMessage.texte, prepMessage.couleur);
  } else if (prepActif) {
    prepSetStatus("⏳ Preparation en cours — voir la video", "#4f46e5");
  } else if (mode === "afficher") {
    prepSetStatus("⏸️ Rien a preparer : clique pour afficher", "#0f9d63");
  } else if (mode === "traduire") {
    prepSetStatus("⏸️ Transcription en memoire : il ne reste qu'a traduire", "#0f9d63");
  } else {
    prepSetStatus("⏸️ Pret a demarrer", "#666");
  }
}

// Applique la reponse du background : c'est LUI qui dit ce qui se passe
// vraiment. La popup n'affiche jamais une supposition -- si le demarrage
// echoue, elle le montre au lieu de faire comme si.
function prepAppliquerEtat(reponse) {
  prepActif = Boolean(reponse && reponse.active);

  if (reponse && reponse.error) {
    prepMessage = { texte: "❌ " + reponse.error, couleur: "#dc2626" };
  } else if (reponse && reponse.resume && typeof reponse.resume.nbMots === "number") {
    const r = reponse.resume;
    const minutes = Math.floor(r.dureeCouverteS / 60);
    const secondes = Math.round(r.dureeCouverteS % 60);
    let texte =
      `✅ Pret — ${r.nbMots} mots, ${minutes} min ${String(secondes).padStart(2, "0")} s couvertes`;
    let couleur = "#0f9d63";

    // ⚠️ LA TRADUCTION DIT AUSSI CE QUI N'A PAS MARCHE. Un bilan qui ne
    // mentionnerait que les succes laisserait « ca s'affiche quand meme »
    // passer pour « ca marche ».
    const t = r.traduction;
    if (t) {
      texte += `\n🌍 ${nomDe(t.source)} → ${nomDe(t.cible)} : ${t.nbTraduits}/${t.nbSegments} segments`;
      if (t.nbEchecs) {
        texte += `\n❌ ${t.nbEchecs} segment(s) NON traduits`;
        couleur = "#dc2626";
      }
      if (t.verification && !t.verification.accord) {
        texte +=
          `\n❌ Langue déclarée « ${t.verification.declaree} », entendue ` +
          `« ${t.verification.entendue} »`;
        couleur = "#dc2626";
      }
    }
    prepMessage = { texte, couleur };
  } else if (prepActif) {
    prepMessage = null;
  } else {
    prepMessage = { texte: "⏹️ Preparation arretee", couleur: "#666" };
  }

  prepMajUI();
}

// Lancer une preparation complete. `refaire` vaut true quand on ecrase
// volontairement une preparation deja en memoire.
//
// ⚠️ L'ORDRE DES DEUX PREMIERES LIGNES N'EST PAS NEGOCIABLE. L'installation de
// la paire doit etre le PREMIER `await` -- pas de `sendMessage`, pas de
// `storage.get` avant elle, sinon l'activation utilisateur (~5 s) expire et
// `Translator.create` leve `NotAllowedError`. L'oubli de la memoire, lui, peut
// attendre : il ne demande aucune activation.
async function prepLancerPreparation(refaire) {
  const paire = { source: tradSource.value, cible: tradCible.value };

  prepSetStatus(
    paire.cible
      ? `⏳ Vérification ${nomDe(paire.source)} → ${nomDe(paire.cible)}...`
      : "⏳ Demarrage...",
    "#666"
  );
  const installation = await tradInstallerPaire(paire.source, paire.cible);

  if (!installation.ok) {
    // JAMAIS de repli silencieux vers « pas de traduction » : on s'arrete, et on
    // dit pourquoi. Demarrer quand meme rendrait une preparation entiere de
    // texte non traduit qui aurait l'air de fonctionner.
    prepMessage = { texte: "❌ " + installation.message, couleur: "#dc2626" };
    prepActif = false;
    prepMajUI();
    return;
  }
  if (!installation.sansTraduction) {
    console.log(
      `🌍 LiveSub : paire ${paire.source} → ${paire.cible} prête en ${installation.ms} ms ` +
        `(dernier downloadprogress : ${installation.pourcentVu} %)`
    );
  }

  // ⚠️ ON OUBLIE AVANT DE RELANCER. Sans ca, la nouvelle preparation serait
  // FUSIONNEE avec l'ancienne (meme cle, meme duree) : les anciennes traductions
  // survivraient a une transcription refaite, et decriraient un texte qui
  // n'existe plus. « Refaire » doit vouloir dire refaire.
  if (refaire) {
    try {
      const oubli = await chrome.runtime.sendMessage({ type: "MEMOIRE_OUBLIER" });
      console.log("🗑️ LiveSub : memoire oubliee avant de refaire —", JSON.stringify(oubli));
    } catch (err) {
      console.warn("⚠️ LiveSub : impossible d'oublier la memoire —", err);
    }
    memEtat = null;
  }

  prepSetStatus("⏳ Demarrage...", "#666");
  try {
    prepAppliquerEtat(
      await chrome.runtime.sendMessage({
        type: "PREPARATION_DEMARRER",
        traduction: paire.cible ? paire : null,
      })
    );
  } catch (err) {
    prepMessage = { texte: "❌ Echec : " + (err.message || err), couleur: "#dc2626" };
    prepActif = false;
    prepMajUI();
  }
}

// Relire la memoire. C'est l'action normale sur une video connue.
//
// ⚠️ QUAND LA TRADUCTION DEMANDEE EST DEJA EN MEMOIRE, IL N'Y A AUCUN `await`
// AVANT L'ENVOI : pas de `Translator.create`, donc aucune activation
// utilisateur necessaire, donc rien a installer. C'est ce chemin-la qui doit
// fonctionner meme si le dossier du modele a disparu -- il ne touche ni le
// modele, ni le traducteur.
async function memLancerAffichage() {
  const paire = { source: tradSource.value, cible: tradCible.value };
  const dejaTraduit =
    !paire.cible || ((memEtat && memEtat.resume && memEtat.resume.langues) || []).includes(paire.cible);

  if (!dejaTraduit) {
    // Nouvelle langue d'arrivee : la paire doit etre installee, et c'est ici le
    // seul instant ou l'activation utilisateur existe.
    prepSetStatus(`⏳ Vérification ${nomDe(paire.source)} → ${nomDe(paire.cible)}...`, "#666");
    const installation = await tradInstallerPaire(paire.source, paire.cible);
    if (!installation.ok) {
      prepMessage = { texte: "❌ " + installation.message, couleur: "#dc2626" };
      prepMajUI();
      return;
    }
  }

  prepSetStatus(
    dejaTraduit ? "⏳ Lecture de la mémoire..." : `⏳ Traduction vers ${nomDe(paire.cible)}...`,
    "#4f46e5"
  );

  const t0 = performance.now();
  let r;
  try {
    r = await chrome.runtime.sendMessage({
      type: "MEMOIRE_AFFICHER",
      traduction: paire.cible ? paire : null,
    });
  } catch (err) {
    r = { ok: false, erreur: String((err && err.message) || err) };
  }
  const ms = Math.round(performance.now() - t0);

  if (!r || !r.ok) {
    prepMessage = {
      texte: "❌ " + ((r && r.erreur) || "La mémoire n'a rien rendu"),
      couleur: "#dc2626",
    };
    prepMajUI();
    return;
  }

  // ⚠️ LE CHIFFRE QUI COMPTE EST AFFICHE, PAS SEULEMENT LE SUCCES. « Ça
  // s'affiche » ne dit pas si ça a coûté 40 ms ou quatre minutes -- et c'est
  // toute la question.
  let texte = `✅ Depuis la mémoire — ${r.nbMots.toLocaleString("fr-FR")} mots, ${r.nbBlocs} blocs, ${ms} ms`;
  if (r.traductionNeuve) {
    texte += `\n🌍 Traduit vers ${nomDe(paire.cible)} en ${r.msTraduction} ms — AUCUNE retranscription`;
    if (r.echecsTraduction) texte += `\n❌ ${r.echecsTraduction} segment(s) non traduits`;
  }
  if (!r.blocsRepris) texte += "\n(découpage refait : la mémoire n'en portait pas)";
  prepMessage = {
    texte,
    couleur: r.echecsTraduction ? "#dc2626" : "#0f9d63",
  };
  console.log(`📼 LiveSub : affichage depuis la memoire en ${ms} ms —`, JSON.stringify(r));

  // La memoire vient peut-etre de changer (nouvelle langue rangee) : on la relit
  // pour que le bouton et le compteur de place disent la verite.
  await memCharger();
}

prepBtn.addEventListener("click", async () => {
  prepMessage = null;
  prepBtn.disabled = true;
  refaireBtn.disabled = true;

  if (prepActif) {
    prepSetStatus("⏳ Arret...", "#666");
    try {
      prepAppliquerEtat(await chrome.runtime.sendMessage({ type: "PREPARATION_ARRETER" }));
    } catch (err) {
      prepMessage = { texte: "❌ Echec : " + (err.message || err), couleur: "#dc2626" };
      prepActif = false;
      prepMajUI();
    }
    refaireBtn.disabled = false;
    return;
  }

  // ⚠️ `memModeBouton()` est SYNCHRONE et lue AVANT le moindre `await` :
  // l'activation utilisateur est intacte quand `tradInstallerPaire` s'execute,
  // dans les deux branches.
  const mode = memModeBouton();
  if (mode === "demarrer") {
    await prepLancerPreparation(false);
  } else {
    await memLancerAffichage();
  }
  refaireBtn.disabled = false;
});

// « Refaire la preparation » : on repaie volontairement les minutes, parce que
// la transcription rangee etait mauvaise.
refaireBtn.addEventListener("click", async () => {
  prepMessage = null;
  prepBtn.disabled = true;
  refaireBtn.disabled = true;
  await prepLancerPreparation(true);
  refaireBtn.disabled = false;
});

// ---------------------------------------------------------------------------
// Demander a la memoire ce qu'elle a
// ---------------------------------------------------------------------------
async function memCharger() {
  try {
    memEtat = await chrome.runtime.sendMessage({ type: "MEMOIRE_ETAT" });
  } catch (err) {
    memEtat = { connue: false, erreur: String((err && err.message) || err) };
  }
  // ⚠️ LA LANGUE DE DEPART DE LA PREPARATION RANGEE L'EMPORTE SUR LA DEVINETTE.
  // Retraduire un texte francais en declarant « anglais » donnerait du charabia,
  // et la devinette sur le titre de l'onglet se trompe. Ce qui est en memoire a
  // ete utilise pour de vrai : il vaut mieux que la devinette.
  if (memEtat && memEtat.connue && memEtat.resume && memEtat.resume.langueSource) {
    const code = memEtat.resume.langueSource;
    if (LANGUES_DEPART.some(([c]) => c === code)) tradSource.value = code;
  }
  console.log("💾 LiveSub : etat de la memoire —", JSON.stringify(memEtat && memEtat.resume ? memEtat.resume : memEtat));
  prepMajUI();
}

async function prepCharger() {
  // On demande l'etat au background, on ne le devine pas : le service worker
  // est ephemere, mais l'etat vit dans chrome.storage.session.
  try {
    const etat = await chrome.runtime.sendMessage({ type: "PREPARATION_ETAT" });
    prepActif = Boolean(etat && etat.active);
  } catch (err) {
    prepActif = false;
  }
  prepMajUI();
}

// La preparation se termine toute seule a la fin de la video, peut-etre pendant
// que la popup est ouverte : on se resynchronise sans attendre un clic.
chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes.preparationState;
  if (!change) return;
  const etaitActif = prepActif;
  prepActif = Boolean(change.newValue && change.newValue.active);
  // Une preparation qui vient de se terminer : on va chercher le bilan.
  if (etaitActif && !prepActif) {
    chrome.runtime
      .sendMessage({ type: "PREPARATION_STOCK" })
      .then((resume) => {
        prepAppliquerEtat({ active: false, resume });
        // La preparation qui vient de finir est en train de se ranger : on relit
        // la memoire pour que le bouton change de sens tout de suite.
        // ⚠️ C EST UNE COURSE, ET ELLE EST ASSUMEE : content.js range apres avoir
        // construit ses blocs. Si on arrive avant lui, la popup montre l etat
        // d avant -- elle ne ment pas, elle est juste en avance. La prochaine
        // ouverture montrera la verite.
        memCharger();
      })
      .catch(() => prepMajUI());
    return;
  }
  prepMajUI();
});

// ⚠️ DANS CET ORDRE. `tradCharger` pose la langue d'arrivee, `prepCharger` dit
// si une preparation tourne, et `memCharger` a besoin des deux pour choisir le
// libelle du bouton. Les lancer en parallele ferait clignoter le bouton entre
// deux sens differents.
(async () => {
  await tradCharger();
  await prepCharger();
  await memCharger();
})();
