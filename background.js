console.log("🔧 Service Worker LiveSub est pret !");

// ---------------------------------------------------------------------------
// LiveSub n'a plus qu'UN mode : la preparation.
// ---------------------------------------------------------------------------
//
// Le mode DIRECT a ete retire a l'etape 5. Avec lui sont partis, de ce
// fichier : l'etat de capture (`captureState`), le choix de langue, le retard du
// son et sa calibration, la case « fin provisoire », le verdict de backend
// GPU/CPU de Whisper, le relais `FLUX` et les messages GET_STATE /
// TOGGLE_SUBTITLES / SET_LANGUE / SET_RETARD / SET_PROVISOIRE / WHISPER_BACKEND.
//
// ⚠️ Le service worker est EPHEMERE : Chrome le tue au bout de ~30 s
// d'inactivite et toute variable est perdue. Tout etat vit donc dans
// chrome.storage.session, jamais dans une variable de ce fichier.

// ---------------------------------------------------------------------------
// Menage des reglages devenus orphelins
// ---------------------------------------------------------------------------
//
// Ces cles ont ete ecrites dans le storage des utilisateurs par les versions
// precedentes. Plus personne ne les lit : les laisser ne casserait rien, mais
// autant ne pas encombrer.
//
// ⚠️ LE MENAGE EST UN CONFORT, PAS LA PROTECTION. La protection, c'est que plus
// aucun `chrome.storage.local.get` de ce projet ne mentionne ces noms : meme si
// ce nettoyage ne tournait jamais (onInstalled ne se declenche qu'a
// l'installation ou a la mise a jour), une vieille valeur resterait inerte.
const CLES_PERIMEES = [
  "captureState",              // etat du mode direct
  "langueSousTitres",          // menu de langue (Parakeet detecte tout seul)
  "retardAudio",               // retard du son, propre au direct
  "retardCalibre",             // trois generations de calibration du retard
  "retardCalibreFlux",
  "retardCalibreFluxParMode",
  "afficherProvisoire",        // case « afficher la fin provisoire »
  "whisperBackend",            // verdict GPU/CPU de Whisper
  "modeLiveSub",               // choix entre les deux modes
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(CLES_PERIMEES).catch(() => {});
  chrome.storage.session.remove(CLES_PERIMEES).catch(() => {});
});

// ---------------------------------------------------------------------------
// Offscreen document
// ---------------------------------------------------------------------------
// Deux appels simultanes a createDocument() levent une erreur : on memorise la
// creation en cours pour que le second attende la premiere au lieu de relancer.
let creatingOffscreen = null;

async function createOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    console.log("ℹ️ Offscreen deja cree");
    return;
  }

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Capture audio pour sous-titrage en temps reel'
  });

  try {
    await creatingOffscreen;
    console.log("✅ Offscreen document cree");

    // Laisser le temps a offscreen.js d'enregistrer son listener de messages.
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log("✅ Offscreen pret, on peut continuer");
  } finally {
    creatingOffscreen = null;
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Serialisation des demarrages / arrets
// ---------------------------------------------------------------------------
// Le garde-fou "est-ce que c'est deja actif ?" lit l'etat au debut mais ne
// l'ecrit qu'a la toute fin (apres createOffscreen + getMediaStreamId). Entre
// les deux, un second demarrage lance en parallele lit encore "inactif" et
// passe le garde : on se retrouve avec DEUX captures, celle qui reste volant le
// flux de l'autre. On fait donc passer start et stop dans une file d'attente :
// une operation a la fois, le garde voit toujours l'etat definitif.
//
// C'est bien une variable en memoire, mais ce n'est PAS de l'etat : elle ne
// sert qu'a ordonner des appels concurrents, qui sont forcement dans la meme
// vie du service worker. La verite reste dans chrome.storage.session.
let captureQueue = Promise.resolve();

function serializeCapture(operation) {
  const result = captureQueue.then(operation, operation);
  // La file ne doit jamais rester bloquee sur un echec.
  captureQueue = result.catch(() => {});
  return result;
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Messages d'erreur lisibles
// ---------------------------------------------------------------------------
// Traduit les messages bruts de Chrome en quelque chose d'actionnable.
// Le message d'origine reste dans la console pour le debug.
function describeError(error) {
  const raw = (error && error.message) || String(error);

  // Le cas le plus frequent : apres un rechargement de l'extension, la
  // permission activeTab n'est accordee qu'une fois l'icone cliquee.
  // Attention a l'ordre : ce message de Chrome contient AUSSI la phrase sur
  // les pages chrome://, alors que ce n'est pas la vraie cause.
  if (raw.includes("has not been invoked")) {
    return "Clique sur l'icone LiveSub puis reessaie";
  }
  if (raw.includes("Chrome pages cannot be captured") || raw.includes("cannot be captured")) {
    return "Cette page ne peut pas etre capturee (page chrome:// ou Web Store)";
  }
  if (raw.includes("Aucun onglet actif")) {
    return "Aucun onglet actif a capturer";
  }
  if (raw.includes("Could not establish connection")) {
    return "Le module audio n'a pas repondu, reessaie";
  }

  return raw;
}

// ===========================================================================
// LA PREPARATION — l'orchestration
// ===========================================================================
//
// Le service worker meurt au bout de ~30 s d'inactivite, et une preparation
// dure des minutes. Tout l'etat vit donc dans chrome.storage.session -- une
// variable memoire aurait disparu en plein milieu.
// (L'offscreen et content.js, eux, survivent : ce sont eux qui tiennent le
// travail en cours, le service worker ne fait que les mettre en relation.)

const PREP_STATE_KEY = "preparationState";
const PREP_ETAT_VIDE = { active: false, tabId: null };

// x2 : la vitesse mesuree le 2026-08-27 (texte identique a 98,6 % / 94,9 %,
// signal restitue a r = 1,00). Monter plus haut demanderait de revalider les
// deux, et le plafond de la machine est de toute facon ~x4.
const PREP_VITESSE = 2;

async function prepLireEtat() {
  const range = await chrome.storage.session.get(PREP_STATE_KEY);
  return range[PREP_STATE_KEY] || PREP_ETAT_VIDE;
}

async function prepEcrireEtat(etat) {
  await chrome.storage.session.set({ [PREP_STATE_KEY]: etat });
  return etat;
}

// Un etat qui dit « actif » alors que l'offscreen a disparu est un etat qui
// ment : on le corrige au lieu de le croire.
async function prepEtatReel() {
  const etat = await prepLireEtat();
  if (etat.active && !(await chrome.offscreen.hasDocument())) {
    console.log("♻️ Preparation perimee (plus d'offscreen), remise a zero");
    return prepEcrireEtat(PREP_ETAT_VIDE);
  }
  return etat;
}

// ---------------------------------------------------------------------------
// Demarrage
// ---------------------------------------------------------------------------
//
// L'ORDRE DES ETAPES N'EST PAS ARBITRAIRE :
//   1. y a-t-il une video ? -- on demande AVANT de capturer, pour ne pas
//      ouvrir un flux sur une page qui ne pourra rien preparer ;
//   2. la capture silencieuse demarre -- elle jette tout ce qu'elle recoit
//      tant qu'elle ne connait pas la position de depart ;
//   3. le defilement commence, et content.js dit A QUELLE SECONDE ;
//   4. cette position part vers l'offscreen, qui se met alors a enregistrer.
//
// Sans l'etape 4 en dernier, la seconde ou deux captees entre 2 et 3 (video
// encore a x1, ou a l'arret) seraient traitees comme du x2 et decaleraient
// tous les instants du stock.
async function doPreparationDemarrer() {
  const deja = await prepEtatReel();
  if (deja.active) {
    console.log("ℹ️ Preparation deja en cours sur l'onglet", deja.tabId);
    return deja;
  }

  let tabId = null;
  try {
    console.log("🎬 Preparation : demarrage...");
    await createOffscreen();

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("Aucun onglet actif");
    tabId = tab.id;

    // 1. Une video pilotable sur cette page ?
    let verification;
    try {
      verification = await chrome.tabs.sendMessage(tabId, { type: "PREPARATION_VERIFIER" });
    } catch (err) {
      throw new Error("LiveSub n'est pas charge sur cette page : recharge-la (F5) puis reessaie");
    }
    if (!verification || !verification.success) {
      throw new Error((verification && verification.erreur) || "Aucune video pilotable sur cette page");
    }
    console.log(
      `📼 Video trouvee : ${verification.duree.toFixed(1)} s, position ${verification.position.toFixed(1)} s`
    );

    // 2. Capture silencieuse.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    // ⚠️ RIEN D'AUTRE QUE LE FLUX. Il n'y a plus de langue a transmettre :
    // Parakeet la detecte seul, son vocabulaire ne contient aucun jeton de
    // langue. Et plus de verdict de backend : c'etait la mesure GPU/CPU de
    // Whisper.
    const reponse = await chrome.runtime.sendMessage({
      type: "START_PREPARATION",
      streamId,
    });
    if (!reponse || !reponse.success) {
      throw new Error((reponse && reponse.error) || "Le module audio n'a pas confirme la capture");
    }

    // 3. Defilement accelere.
    const pilote = await chrome.tabs.sendMessage(tabId, {
      type: "PREPARATION_PILOTER",
      vitesse: PREP_VITESSE,
    });
    if (!pilote || !pilote.success) {
      throw new Error((pilote && pilote.erreur) || "Le lecteur de la page n'a pas demarre");
    }

    // 4. La position de depart debloque l'enregistrement.
    //
    // ⚠️ `positionDepart` (relevee APRES `play()`), pas `position` (relevee
    // AVANT qu'on touche au lecteur). La seconde sert a rendre le lecteur tel
    // qu'on l'a trouve ; l'utiliser ici daterait tout le stock trop tot, de ce
    // que la video avance pendant que le lecteur demarre.
    await chrome.runtime
      .sendMessage({
        type: "PREPARATION_POSITION",
        position: pilote.positionDepart ?? pilote.position,
      })
      .catch(() => {});

    console.log(`✅ Preparation lancee sur l'onglet ${tabId} a x${PREP_VITESSE}`);
    return prepEcrireEtat({
      active: true,
      tabId,
      depart: pilote.position,
      duree: pilote.duree,
    });
  } catch (error) {
    console.error("❌ Preparation :", error);

    // Tout defaire, dans les deux sens : le flux capte ET le lecteur emprunte.
    // Un lecteur laisse a x2 sur la page de quelqu'un serait le pire des
    // echecs -- celui qu'on ne comprend pas.
    try {
      await chrome.runtime.sendMessage({ type: "STOP_PREPARATION" });
    } catch (err) {
      /* pas (ou plus) d'offscreen : normal */
    }
    if (tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: "PREPARATION_RESTAURER",
          erreur: describeError(error),
        });
      } catch (err) {
        /* page sans content script */
      }
    }

    await prepEcrireEtat(PREP_ETAT_VIDE);
    return { active: false, error: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// Arret (volontaire, ou fin de la video)
// ---------------------------------------------------------------------------
//
// L'ORDRE COMPTE ICI AUSSI : on fait d'abord vider la file de transcription
// (STOP_PREPARATION attend que les derniers blocs soient passes), et SEULEMENT
// ensuite on rend le lecteur. Restaurer d'abord renverrait la video a sa
// position d'origine, en x1, pendant que l'offscreen enregistre encore.
async function doPreparationArreter() {
  const etat = await prepLireEtat();
  const tabId = etat.tabId;
  console.log("⏸️ Preparation : arret demande");

  let resume = null;
  try {
    resume = await chrome.runtime.sendMessage({ type: "STOP_PREPARATION" });
  } catch (err) {
    console.warn("Preparation : offscreen injoignable (deja ferme ?)");
  }

  if (tabId) {
    try {
      const restauration = await chrome.tabs.sendMessage(tabId, {
        type: "PREPARATION_RESTAURER",
        resume,
      });
      if (restauration && restauration.etats) {
        console.log("📌 Lecteur restaure :", JSON.stringify(restauration.etats));
      }
    } catch (err) {
      console.warn("⚠️ Preparation : onglet injoignable, lecteur non restaure :", err.message);
    }
  }

  await prepEcrireEtat(PREP_ETAT_VIDE);
  if (resume) {
    console.log(
      `✅ Preparation terminee : ${resume.nbMots} mots sur ${resume.dureeCouverteS?.toFixed(1)} s ` +
        `(${resume.motsParSeconde?.toFixed(2)} mots/s, ${resume.nbBlocs} blocs)`
    );
  }
  return { active: false, resume: resume || null };
}

// Les deux operations passent par la file : deux demarrages lances coup sur
// coup ne peuvent pas se croiser et ouvrir deux captures sur le meme onglet.
function preparationDemarrer() {
  return serializeCapture(doPreparationDemarrer);
}

function preparationArreter() {
  return serializeCapture(doPreparationArreter);
}

// L'onglet prepare est ferme : le flux meurt avec lui, et il n'y a plus de
// lecteur a rendre. On nettoie pour que la popup ne reste pas sur « Actif ».
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const etat = await prepLireEtat();
  if (etat.active && etat.tabId === tabId) {
    console.log("🗑️ Onglet prepare ferme, arret de la preparation");
    await preparationArreter();
  }
});

// ---------------------------------------------------------------------------
// Messages — un listener A PART
// ---------------------------------------------------------------------------
//
// Un second addListener plutot que des branches ajoutees dans le premier : le
// listener existant n'est pas touche d'une ligne. Chrome livre le message aux
// deux ; les types ne se recouvrent pas, donc un seul repond.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "PREPARATION_DEMARRER") {
    preparationDemarrer().then(sendResponse);
    return true;
  }

  if (request.type === "PREPARATION_ARRETER") {
    preparationArreter().then(sendResponse);
    return true;
  }

  if (request.type === "PREPARATION_ETAT") {
    prepEtatReel().then(sendResponse);
    return true;
  }

  // content.js a vu la fin de la video. Meme chemin que l'arret volontaire.
  if (request.type === "PREPARATION_FIN") {
    console.log("🏁 Preparation : fin de la video signalee par la page");
    preparationArreter();
    return; // pas de reponse attendue
  }

  // Message d'etat de l'offscreen -> overlay de l'onglet prepare.
  // On ne passe PAS par sendStatut : celui-la n'ecrit que si `captureState`
  // est actif, ce qui n'est jamais le cas en preparation.
  if (request.type === "PREPARATION_STATUT") {
    prepLireEtat().then(({ active, tabId }) => {
      if (!active || !tabId) return;
      chrome.tabs
        .sendMessage(tabId, { type: "PREPARATION_STATUT", texte: request.texte })
        .catch(() => {});
    });
    return; // pas de reponse attendue
  }

  // Lecture du stock prepare (verification maintenant, etape B plus tard).
  if (request.type === "PREPARATION_STOCK") {
    chrome.runtime
      .sendMessage({ type: "PREPARATION_RESUME" })
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: String(err.message || err) }));
    return true;
  }
});

// ---------------------------------------------------------------------------
// Etape B : le pont entre le stock (offscreen) et l'affichage (content.js)
// ---------------------------------------------------------------------------
//
// content.js ne peut pas parler a l'offscreen : il n'y a pas de canal direct
// entre un content script et un document offscreen. Le service worker relaie.
//
// Deux types distincts et non un seul, volontairement : celui qui arrive et
// celui qui repart ne doivent pas pouvoir etre confondus si un jour un autre
// contexte ecoute.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "PREPARATION_STOCK_COMPLET") {
    chrome.runtime
      .sendMessage({ type: "PREPARATION_STOCK_OFFSCREEN" })
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, error: "Stock illisible : " + (err.message || err) })
      );
    return true; // reponse asynchrone
  }
});
