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
async function doPreparationDemarrer(traduction) {
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
    // ⚠️ LA PAIRE VIENT DE LA POPUP, ET DE NULLE PART AILLEURS. Elle n'est pas
    // relue dans le storage ici : c'est la popup qui vient de l'INSTALLER, au
    // clic, dans le seul contexte ou l'activation utilisateur existe. Relire le
    // storage rendrait possible un decalage entre la paire installee et la
    // paire demandee -- exactement le genre d'ecart qui ne se voit pas.
    const reponse = await chrome.runtime.sendMessage({
      type: "START_PREPARATION",
      streamId,
      traduction: traduction || null,
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

    console.log(
      `✅ Preparation lancee sur l'onglet ${tabId} a x${PREP_VITESSE}` +
        (traduction && traduction.cible
          ? ` — traduction ${traduction.source} → ${traduction.cible}`
          : " — sans traduction")
    );
    return prepEcrireEtat({
      active: true,
      tabId,
      depart: pilote.position,
      duree: pilote.duree,
      traduction: traduction || null,
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
function preparationDemarrer(traduction) {
  return serializeCapture(() => doPreparationDemarrer(traduction));
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
    preparationDemarrer(request.traduction || null).then(sendResponse);
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

  // ---------------------------------------------------------------------
  // Le detecteur de langue, prete au document offscreen
  // ---------------------------------------------------------------------
  //
  // ⚠️ `chrome.i18n` N'EXISTE PAS dans un document offscreen. Verifie dans
  // Chrome le 2026-08-31 : `typeof chrome.i18n === "undefined"` la-bas, comme
  // `chrome.storage`. C'est la MEME famille de piege, et elle a deja tout casse
  // une fois. Le service worker, lui, l'a : il fait donc le travail et renvoie
  // la reponse.
  //
  // 100 % local : `chrome.i18n.detectLanguage` est le detecteur compact
  // embarque dans Chrome. Aucune requete ne sort.
  if (request.type === "PREPARATION_DETECTER_LANGUE") {
    chrome.i18n
      .detectLanguage(String(request.texte || ""))
      .then((r) => {
        const premier = r && r.languages && r.languages[0];
        sendResponse({
          success: true,
          langue: premier ? premier.language : null,
          pourcentage: premier ? premier.percentage : null,
          fiable: Boolean(r && r.isReliable),
        });
      })
      .catch((err) => sendResponse({ success: false, error: String((err && err.message) || err) }));
    return true;
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
  // L'avancement, demande par content.js. Meme chemin que le stock : un content
  // script n'a aucun canal direct vers un document offscreen, le service worker
  // relaie.
  if (request.type === "PREPARATION_PROGRES") {
    chrome.runtime
      .sendMessage({ type: "PREPARATION_PROGRES_OFFSCREEN" })
      .then(sendResponse)
      // ⚠️ Un `.catch` qui REPOND, toujours. Ici il porte en plus une
      // information : si l'offscreen ne repond plus, c'est un fait, et c'est
      // exactement ce que le chien de garde a besoin de savoir.
      .catch((err) =>
        sendResponse({ success: false, injoignable: true, error: String((err && err.message) || err) })
      );
    return true;
  }

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


// ===========================================================================
// LA MEMOIRE DES PREPARATIONS — chrome.storage.local, ET ICI SEULEMENT
// ===========================================================================
//
// ⚠️ POURQUOI TOUT LE STORAGE EST DANS CE FICHIER. `chrome.storage` est
// INDISPONIBLE dans le document offscreen (verifie dans Chrome : `chrome` est
// bien un objet, `chrome.storage` est `undefined`). Y toucher la-bas leve un
// TypeError AU CHARGEMENT, le fichier meurt a cette ligne, et plus rien ne
// repond -- sans erreur, sans echec, sans delai. C'est deja arrive une fois.
//
// L'offscreen ENVOIE donc, et c'est le service worker qui RANGE. content.js
// aurait pu ecrire lui-meme (un content script a bien acces au storage), mais
// alors la memoire serait ecrite depuis deux endroits, avec deux idees de ce
// qu'elle contient et deux facons de faire de la place. Un seul ecrivain.
//
// ⚠️ AUCUNE PERMISSION AJOUTEE. `storage` etait deja la, et il n'y a PAS de
// `unlimitedStorage` : on tient dans les ~10 Mo de `chrome.storage.local`, et
// quand ils sont pleins on supprime la preparation la plus ancienne en le
// disant. Ajouter `unlimitedStorage` serait une decision, pas un detail.

const MEM_PREFIXE = "prep:";
const MEM_INDEX = "preparationsIndex";
const MEM_VERSION = 1;

// 10 485 760 octets. `QUOTA_BYTES` est lu sur l'API quand elle l'expose, pour
// que la valeur ne puisse pas mentir si Chrome la change un jour.
const MEM_QUOTA = chrome.storage.local.QUOTA_BYTES || 10485760;

// ⚠️ LA DUREE NE SE COMPARE PAS AU MILLIEME. `video.duration` d'un flux adaptatif
// bouge de quelques dizaines de millisecondes d'une session a l'autre (le dernier
// segment n'a pas toujours la meme longueur). Une egalite stricte ferait donc
// rater la memoire a peu pres a chaque fois. Une seconde de tolerance : c'est
// large devant ce bruit-la, et tres serre devant « ce n'est pas la meme video ».
const MEM_TOLERANCE_DUREE_S = 1.0;

function memCleRangee(cle) {
  return MEM_PREFIXE + cle;
}

// L'INDEX : un petit resume par preparation, dans une seule cle.
//
// ⚠️ POURQUOI UN INDEX PLUTOT QUE DE TOUT RELIRE. La popup a besoin de savoir,
// a chaque ouverture, ce qui est en memoire. Sans index il faudrait charger et
// analyser jusqu'a 10 Mo de JSON pour afficher deux lignes -- a chaque clic sur
// l'icone. L'index fait quelques centaines d'octets.
//
// Il est ecrit DANS LE MEME `set` que l'entree qu'il decrit : les deux arrivent
// ensemble ou pas du tout, donc il ne peut pas annoncer une preparation qui
// n'existe pas.
async function memIndex() {
  const r = await chrome.storage.local.get(MEM_INDEX);
  const i = r[MEM_INDEX];
  return i && typeof i === "object" ? i : {};
}

function memResumeIndex(entree, octets) {
  return {
    titre: entree.titre || "",
    url: entree.url || "",
    quand: entree.quand || 0,
    dureeVideo: entree.dureeVideo,
    dureeCouverteS: entree.dureeCouverteS,
    nbMots: Array.isArray(entree.mots) ? entree.mots.length : 0,
    langueSource: entree.langueSource || null,
    langues: Object.keys(entree.traductions || {}),
    octets: octets || 0,
  };
}

async function memPlace() {
  const octets = await chrome.storage.local.getBytesInUse(null);
  return {
    octets,
    quota: MEM_QUOTA,
    pourcent: Math.round((octets / MEM_QUOTA) * 1000) / 10,
    libreOctets: Math.max(0, MEM_QUOTA - octets),
  };
}

async function memLireEntree(cle) {
  if (!cle) return null;
  const r = await chrome.storage.local.get(memCleRangee(cle));
  const e = r[memCleRangee(cle)];
  if (!e || typeof e !== "object") return null;
  // ⚠️ Une entree ecrite par une generation precedente est FAUSSE pour
  // celle-ci, et comme elle est memorisee pour de bon elle ne serait jamais
  // refaite. La protection n'est pas le menage, c'est ce test : on ne lit que
  // la version courante. (Meme lecon que les trois generations de
  // `retardCalibre` de l'ere Whisper.)
  if (e.version !== MEM_VERSION) return null;
  if (!Array.isArray(e.mots) || !e.mots.length) return null;
  return e;
}

// « Est-ce bien la meme video ? » — la cle NE SUFFIT PAS.
function memMemeVideo(entree, duree) {
  if (!entree) return false;
  if (!Number.isFinite(duree) || duree <= 0) return false;
  if (!Number.isFinite(entree.dureeVideo)) return false;
  return Math.abs(entree.dureeVideo - duree) <= MEM_TOLERANCE_DUREE_S;
}

// ---------------------------------------------------------------------------
// Ecrire, et faire de la place quand il n'y en a plus
// ---------------------------------------------------------------------------
//
// ⚠️ ON N'ESTIME PAS LA PLACE, ON LA CONSTATE. Un calcul « taille du JSON contre
// place libre » se tromperait : le storage a son propre encodage, et une
// estimation trop optimiste laisserait passer une ecriture qui echoue, une
// estimation trop prudente supprimerait des preparations pour rien. On ECRIT,
// et si Chrome refuse pour cause de quota, on supprime la plus ancienne et on
// recommence.
//
// ⚠️ ET ON NE SIMPLIFIE JAMAIS LES DONNEES POUR LES FAIRE RENTRER. Si une seule
// preparation ne tient pas dans un storage vide, on le DIT au lieu de rogner
// les instants ou de jeter des mots.
async function memRanger(cle, entree) {
  const clePleine = memCleRangee(cle);
  entree.version = MEM_VERSION;
  entree.quand = Date.now();

  let index = await memIndex();
  const evincees = [];

  for (;;) {
    const nouvelIndex = { ...index, [cle]: memResumeIndex(entree) };
    try {
      await chrome.storage.local.set({ [clePleine]: entree, [MEM_INDEX]: nouvelIndex });
      // La taille REELLE, lue apres coup : c'est la seule qui compte.
      const octets = await chrome.storage.local.getBytesInUse(clePleine);
      nouvelIndex[cle] = memResumeIndex(entree, octets);
      await chrome.storage.local.set({ [MEM_INDEX]: nouvelIndex });
      return { ok: true, octets, evincees, place: await memPlace() };
    } catch (err) {
      const brut = String((err && err.message) || err);
      if (!/quota/i.test(brut)) throw err;

      const victime = memPlusAncienne(index, cle);
      if (!victime) {
        return {
          ok: false,
          evincees,
          erreur:
            "Cette preparation ne tient pas dans les " +
            Math.round(MEM_QUOTA / 1024) +
            " Ko de chrome.storage.local, et il n'y a plus rien de plus ancien a supprimer.\n" +
            "Rien n'a ete simplifie ni tronque : la preparation n'est simplement pas rangee.",
        };
      }
      await chrome.storage.local.remove(memCleRangee(victime));
      evincees.push({ cle: victime, ...index[victime] });
      delete index[victime];
      await chrome.storage.local.set({ [MEM_INDEX]: index });
      console.warn(
        `🗑️ Memoire pleine : preparation la plus ancienne supprimee — ${victime} ` +
          `(${(evincees[evincees.length - 1].titre || "sans titre").slice(0, 60)}, ` +
          `${Math.round((evincees[evincees.length - 1].octets || 0) / 1024)} Ko)`
      );
    }
  }
}

// La plus ancienne, celle qu'on n'est pas en train d'ecrire.
function memPlusAncienne(index, sauf) {
  let choisie = null;
  for (const [cle, r] of Object.entries(index)) {
    if (cle === sauf) continue;
    if (!choisie || (r.quand || 0) < (index[choisie].quand || 0)) choisie = cle;
  }
  return choisie;
}

// ---------------------------------------------------------------------------
// Fusionner : la transcription d'un cote, les traductions de l'autre
// ---------------------------------------------------------------------------
//
// ⚠️ C'EST ICI QUE VIT LA REGLE DE STRUCTURE. La transcription (`mots`,
// `blocs`) est ecrite une fois par video ; chaque traduction se range sous SA
// langue d'arrivee, a cote des autres. Ajouter une langue n'efface pas les
// precedentes, et ne touche pas d'un octet a la transcription.
function memFusionner(existante, charge) {
  const entree =
    existante && memMemeVideo(existante, charge.dureeVideo)
      ? existante
      : { version: MEM_VERSION, cle: charge.cle, traductions: {} };

  if (!entree.traductions || typeof entree.traductions !== "object") entree.traductions = {};

  if (Array.isArray(charge.mots) && charge.mots.length) {
    entree.cle = charge.cle;
    entree.url = charge.url;
    entree.titre = charge.titre;
    entree.dureeVideo = charge.dureeVideo;
    entree.positionDepart = charge.positionDepart;
    entree.dureeCouverteS = charge.dureeCouverteS;
    entree.mots = charge.mots;
    entree.blocs = Array.isArray(charge.blocs) ? charge.blocs : [];
    if (charge.langueSource) entree.langueSource = charge.langueSource;
    if (charge.langueEntendue) entree.langueEntendue = charge.langueEntendue;
    if (!entree.quandTranscription) entree.quandTranscription = Date.now();
  }

  const t = charge.traduction;
  if (t && t.cible) {
    entree.traductions[t.cible] = {
      source: t.source,
      cible: t.cible,
      quand: Date.now(),
      // Les deux formes, et c'est voulu : les SEGMENTS sont la sortie brute du
      // traducteur, les BLOCS le resultat de la fusion pour la lecture. Garder
      // les deux, c'est pouvoir re-decouper sans jamais retraduire.
      segments: Array.isArray(charge.segments) ? charge.segments : [],
      blocs: Array.isArray(charge.blocsTraduits) ? charge.blocsTraduits : [],
    };
  }

  return entree;
}

// ---------------------------------------------------------------------------
// L'identite de l'onglet actif, demandee a content.js
// ---------------------------------------------------------------------------
async function memIdentiteOnglet() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("Aucun onglet actif");
  let identite;
  try {
    identite = await chrome.tabs.sendMessage(tab.id, { type: "MEMOIRE_IDENTITE" });
  } catch (err) {
    throw new Error("LiveSub n'est pas charge sur cette page : recharge-la (F5) puis reessaie");
  }
  if (!identite || !identite.cle) throw new Error("Cette page n'a pas d'adresse exploitable");
  return { tabId: tab.id, ...identite };
}

// ---------------------------------------------------------------------------
// Ce que la popup demande a l'ouverture
// ---------------------------------------------------------------------------
async function memEtat() {
  const place = await memPlace();
  const index = await memIndex();
  const inventaire = Object.entries(index)
    .map(([cle, r]) => ({ cle, ...r }))
    .sort((a, b) => (b.quand || 0) - (a.quand || 0));

  let identite = null;
  let erreur = null;
  try {
    identite = await memIdentiteOnglet();
  } catch (err) {
    erreur = String((err && err.message) || err);
  }
  if (!identite) return { connue: false, place, inventaire, erreur };

  const entree = await memLireEntree(identite.cle);
  if (!entree) {
    return { connue: false, identite, place, inventaire, raison: "aucune preparation pour cette video" };
  }
  if (!memMemeVideo(entree, identite.duree)) {
    // ⚠️ ON LE DIT. Une memoire ignoree en silence se lit comme « la memoire ne
    // marche pas » ; ici elle a marche, c'est la video qui a change.
    console.warn(
      `⚠️ Memoire ignoree pour ${identite.cle} : duree en memoire ` +
        `${entree.dureeVideo} s, duree de la page ${identite.duree} s`
    );
    return {
      connue: false,
      identite,
      place,
      inventaire,
      raison: `duree differente (memoire ${Math.round(entree.dureeVideo)} s, page ${Math.round(identite.duree || 0)} s) : ce n'est pas la meme video`,
    };
  }

  return {
    connue: true,
    identite,
    place,
    inventaire,
    resume: {
      cle: entree.cle,
      titre: entree.titre,
      quand: entree.quand,
      quandTranscription: entree.quandTranscription || entree.quand,
      nbMots: entree.mots.length,
      nbBlocs: Array.isArray(entree.blocs) ? entree.blocs.length : 0,
      dureeVideo: entree.dureeVideo,
      dureeCouverteS: entree.dureeCouverteS,
      langueSource: entree.langueSource || null,
      langues: Object.keys(entree.traductions || {}),
      octets: (index[entree.cle] && index[entree.cle].octets) || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Afficher depuis la memoire
// ---------------------------------------------------------------------------
//
// ⭐ LE POINT QUI DECIDE DE TOUT : QUAND AUCUNE TRADUCTION NEUVE N'EST
// NECESSAIRE, ON NE CREE MEME PAS LE DOCUMENT OFFSCREEN. Pas d'offscreen, pas de
// worker, pas de Parakeet, pas un octet du modele touche. C'est ce qui fait que
// la contre-preuve (renommer models/) est une VRAIE contre-preuve : s'il
// retranscrivait en douce, il echouerait.
async function memAfficher(traduction) {
  const identite = await memIdentiteOnglet();
  const entree = await memLireEntree(identite.cle);
  if (!entree) return { ok: false, erreur: "Aucune preparation en memoire pour cette video" };
  if (!memMemeVideo(entree, identite.duree)) {
    return {
      ok: false,
      erreur:
        `La video n'a pas la meme duree qu'en memoire ` +
        `(${Math.round(entree.dureeVideo)} s contre ${Math.round(identite.duree || 0)} s).`,
    };
  }

  const cible = traduction && traduction.cible ? traduction.cible : null;
  let rangee = cible ? entree.traductions[cible] : null;
  let msTraduction = 0;
  let traductionNeuve = false;
  let echecsTraduction = 0;

  if (cible && !rangee) {
    // ⚠️ ON RETRADUIT, ON NE RETRANSCRIT PAS. Les mots et leurs instants sont
    // deja la : seule la traduction depend de la langue d'arrivee. L'offscreen
    // est cree UNIQUEMENT pour ca, et `PREPARATION_RETRADUIRE` ne charge aucun
    // modele.
    const t0 = Date.now();
    await createOffscreen();
    let r;
    try {
      r = await chrome.runtime.sendMessage({
        type: "PREPARATION_RETRADUIRE",
        mots: entree.mots,
        traduction: { source: traduction.source, cible },
      });
    } catch (err) {
      return { ok: false, erreur: "Le module de traduction n'a pas repondu : " + ((err && err.message) || err) };
    }
    if (!r || !r.success) {
      return { ok: false, erreur: (r && r.error) || "La retraduction a echoue" };
    }
    msTraduction = Date.now() - t0;
    traductionNeuve = true;
    echecsTraduction = r.nbEchecs || 0;
    rangee = {
      source: traduction.source,
      cible,
      quand: Date.now(),
      segments: r.segments,
      // Le decoupage en blocs se fait dans la page (il mesure une hauteur
      // reelle) : content.js le fera et nous le renverra pour rangement.
      blocs: [],
    };
    entree.traductions[cible] = rangee;
    const range = await memRanger(identite.cle, entree);
    if (!range.ok) console.warn("⚠️ Traduction non rangee : " + range.erreur);
    console.log(
      `🌍 Retraduction ${traduction.source} → ${cible} : ${r.nbSegments} segments en ${msTraduction} ms ` +
        `(${echecsTraduction} echec(s)) — AUCUNE retranscription`
    );
  }

  const blocs = rangee ? rangee.blocs : entree.blocs;
  const envoi = {
    type: "MEMOIRE_AFFICHER",
    cle: entree.cle,
    quand: entree.quand,
    mots: entree.mots,
    blocs: Array.isArray(blocs) && blocs.length ? blocs : null,
    segments: rangee ? rangee.segments : [],
    traduction: rangee ? { source: rangee.source, cible: rangee.cible } : null,
    positionDepart: entree.positionDepart,
    dureeCouverteS: entree.dureeCouverteS,
    // Le decoupage vient d'etre refait : content.js le rangera.
    aRanger: traductionNeuve,
  };

  let reponse;
  try {
    reponse = await chrome.tabs.sendMessage(identite.tabId, envoi);
  } catch (err) {
    return { ok: false, erreur: "L'onglet n'a pas repondu : " + ((err && err.message) || err) };
  }
  if (!reponse || !reponse.success) {
    return { ok: false, erreur: (reponse && reponse.erreur) || "L'affichage a refuse le stock" };
  }

  return {
    ok: true,
    // ⚠️ CE DRAPEAU EST LA PREUVE, ET IL VAUT `false` PAR CONSTRUCTION : aucune
    // ligne de cette fonction ne demarre une capture ni ne charge un modele.
    retranscrit: false,
    nbMots: reponse.nbMots,
    nbBlocs: reponse.nbBlocs,
    blocsRepris: reponse.blocsRepris,
    traductionNeuve,
    msTraduction,
    echecsTraduction,
    langues: Object.keys(entree.traductions || {}),
    quand: entree.quand,
    place: await memPlace(),
  };
}

// ---------------------------------------------------------------------------
// Messages — un listener A PART
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "MEMOIRE_ETAT") {
    memEtat()
      .then(sendResponse)
      // Tout `return true` a son `.catch` qui REPOND : sans lui, la popup
      // resterait figee sans le moindre message.
      .catch((err) => sendResponse({ connue: false, erreur: String((err && err.message) || err) }));
    return true;
  }

  if (request.type === "MEMOIRE_ENREGISTRER") {
    (async () => {
      const charge = request.charge || {};
      if (!charge.cle) return { ok: false, erreur: "Pas de cle video" };
      if (!Number.isFinite(charge.dureeVideo) || charge.dureeVideo <= 0) {
        return { ok: false, erreur: "Duree de la video inconnue : impossible de la reconnaitre plus tard" };
      }
      const existante = await memLireEntree(charge.cle);
      // La langue de DEPART DECLAREE dans la popup, quand la preparation s'est
      // faite sans traduction (aucune paire n'a alors ete transmise).
      // ⚠️ Elle est DECLAREE, pas detectee : c'est pour ca qu'elle porte ce
      // nom-la et pas « langue de la video ».
      if (!charge.langueSource) {
        const r = await chrome.storage.local.get("traductionPaire");
        const paire = r.traductionPaire;
        if (paire && paire.source) charge.langueSource = paire.source;
      }
      if (charge.traduction && charge.traduction.source) charge.langueSource = charge.traduction.source;
      return memRanger(charge.cle, memFusionner(existante, charge));
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, erreur: String((err && err.message) || err) }));
    return true;
  }

  if (request.type === "MEMOIRE_AFFICHER") {
    memAfficher(request.traduction || null)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, erreur: String((err && err.message) || err) }));
    return true;
  }

  // « Refaire la preparation » : on oublie AVANT de relancer, pour que la
  // nouvelle preparation ne se retrouve pas fusionnee avec l'ancienne.
  if (request.type === "MEMOIRE_OUBLIER") {
    (async () => {
      const cle = request.cle || (await memIdentiteOnglet()).cle;
      const index = await memIndex();
      const avait = Boolean(index[cle]);
      delete index[cle];
      await chrome.storage.local.remove(memCleRangee(cle));
      await chrome.storage.local.set({ [MEM_INDEX]: index });
      console.log(`🗑️ Memoire : preparation oubliee (${cle})` + (avait ? "" : " — il n'y en avait pas"));
      return { ok: true, avait, place: await memPlace() };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, erreur: String((err && err.message) || err) }));
    return true;
  }

  // La place occupee, en clair. Sert a la popup ET a la mesure.
  if (request.type === "MEMOIRE_PLACE") {
    (async () => {
      const place = await memPlace();
      const index = await memIndex();
      const inventaire = Object.entries(index)
        .map(([cle, r]) => ({ cle, ...r }))
        .sort((a, b) => (b.quand || 0) - (a.quand || 0));
      return { ok: true, place, inventaire, nbPreparations: inventaire.length };
    })()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, erreur: String((err && err.message) || err) }));
    return true;
  }
});
