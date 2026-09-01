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
// Mesure du 2026-08-31 (mesures-traduction/RESULTATS.md) :
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

function prepMajUI() {
  prepBtn.disabled = false;
  prepBtn.textContent = prepActif ? "⏹️ Arreter" : "▶️ Demarrer";
  prepBtn.className = prepActif ? "stop" : "";

  if (prepMessage) {
    prepSetStatus(prepMessage.texte, prepMessage.couleur);
  } else if (prepActif) {
    prepSetStatus("⏳ Preparation en cours — voir la video", "#4f46e5");
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

prepBtn.addEventListener("click", async () => {
  const voulu = !prepActif;
  prepMessage = null;
  prepBtn.disabled = true;

  if (!voulu) {
    prepSetStatus("⏳ Arret...", "#666");
    try {
      prepAppliquerEtat(await chrome.runtime.sendMessage({ type: "PREPARATION_ARRETER" }));
    } catch (err) {
      prepMessage = { texte: "❌ Echec : " + (err.message || err), couleur: "#dc2626" };
      prepActif = false;
      prepMajUI();
    }
    return;
  }

  const paire = { source: tradSource.value, cible: tradCible.value };

  // ⚠️ L'INSTALLATION D'ABORD, ET SANS RIEN AVANT ELLE. Pas de `sendMessage`,
  // pas de `storage.get` : le premier `await` de ce gestionnaire doit etre
  // celui-la, sinon l'activation utilisateur a le temps d'expirer.
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
});

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
      .then((resume) => prepAppliquerEtat({ active: false, resume }))
      .catch(() => prepMajUI());
    return;
  }
  prepMajUI();
});

tradCharger();
prepCharger();
