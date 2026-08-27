console.log("🔧 Service Worker LiveSub est pret !");

// ---------------------------------------------------------------------------
// Etat de la capture : UNE seule source de verite
// ---------------------------------------------------------------------------
// On ne garde PAS l'etat dans une variable du service worker : Chrome tue le
// service worker au bout de ~30 s d'inactivite et toute variable est perdue.
// L'etat vit donc dans chrome.storage.session (efface a la fermeture de Chrome,
// ce qui est exactement ce qu'on veut pour un etat "en cours de capture").
const STATE_KEY = "captureState";
const EMPTY_STATE = { active: false, tabId: null };

async function readState() {
  const stored = await chrome.storage.session.get(STATE_KEY);
  return stored[STATE_KEY] || EMPTY_STATE;
}

async function writeState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: state });
  return state;
}

// Etat reel de la capture.
//
// Le flag stocke peut mentir : si l'extension est rechargee ou si l'offscreen
// document disparait, plus rien ne capture alors que le flag dit "actif".
// hasDocument() sert de garde-fou -- pas d'offscreen = pas de capture, point.
// (L'inverse n'est pas vrai : on garde l'offscreen ouvert apres un stop, donc
// hasDocument() seul ne suffit pas a dire qu'on capture.)
async function getCaptureState() {
  const state = await readState();

  if (state.active && !(await chrome.offscreen.hasDocument())) {
    console.log("♻️ Etat perime (plus d'offscreen document), remise a zero");
    return writeState(EMPTY_STATE);
  }

  return state;
}

// ---------------------------------------------------------------------------
// Memoire du backend Whisper (GPU ou CPU)
// ---------------------------------------------------------------------------
// Le worker Whisper chronometre le GPU et le CPU au tout premier lancement,
// puis garde le plus rapide. On range le verdict ici pour ne pas refaire la
// mesure (~1 a 2 min) a chaque demarrage de capture.
//
// ⚠️ Pourquoi ici, dans le service worker, et pas dans l'offscreen qui s'en
// sert ? Parce que dans un document offscreen chrome.storage s'est revele non
// fiable : `get()` renvoie parfois un resultat vide alors que la cle existe, et
// parfois ne repond jamais -- ce qui gelait le demarrage de Whisper. Le service
// worker, lui, n'a pas ce probleme. L'offscreen recoit donc le verdict dans le
// message START_CAPTURE et nous renvoie le sien par WHISPER_BACKEND.
//
// storage.local (et pas .session) : c'est une propriete de la machine, elle
// doit survivre a la fermeture du navigateur.
const BACKEND_KEY = "whisperBackend";

async function readWhisperBackend() {
  try {
    return (await chrome.storage.local.get(BACKEND_KEY))[BACKEND_KEY] || null;
  } catch (err) {
    // Sans memoire on remesurera : c'est lent, mais rien n'est casse.
    console.warn("⚠️ Lecture du backend Whisper impossible :", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Langue parlee dans la video
// ---------------------------------------------------------------------------
// Choisie par l'utilisateur dans la popup, rangee dans storage.local.
//
// Meme raison que pour le backend Whisper : c'est nous qui lisons le storage,
// pas l'offscreen (ou chrome.storage s'est revele non fiable). L'offscreen la
// recoit dans START_CAPTURE, puis par le message LANGUE si elle change en
// cours de capture.
const LANGUE_KEY = "langueSousTitres";
const LANGUE_DEFAUT = "french";

async function readLangue() {
  try {
    return (await chrome.storage.local.get(LANGUE_KEY))[LANGUE_KEY] || LANGUE_DEFAUT;
  } catch (err) {
    // Sans memoire, on retombe sur le francais : la capture doit demarrer.
    console.warn("⚠️ Lecture de la langue impossible :", err);
    return LANGUE_DEFAUT;
  }
}

// ---------------------------------------------------------------------------
// Retard du son
// ---------------------------------------------------------------------------
// Sert a recaler ce qu'on entend sur les sous-titres, qui arrivent forcement
// en retard. Deux formes possibles :
//   - un NOMBRE de secondes (0 = desactive) : reglage manuel ;
//   - la chaine "auto" : l'offscreen mesure le bon retard sur les 5 premiers
//     segments, puis nous le renvoie pour qu'on le retienne.
//
// Meme circuit que la langue : lu ici, transmis dans START_CAPTURE, puis par le
// message RETARD s'il change en cours de capture.
const RETARD_KEY = "retardAudio";
const RETARD_DEFAUT = 0;

// Le retard mesure en mode auto, une fois la calibration faite. Absent tant
// qu'on n'a jamais calibre -- l'offscreen calibrera alors au prochain
// demarrage.
//
// ⚠️ LE NOM DE LA CLE PORTE LE NOM DU MOTEUR, et ce n'est pas cosmetique.
//
// Le bon retard depend entierement de la facon dont le texte est produit. Le
// moteur par blocs affichait une phrase entiere d'un coup : il fallait retarder
// le son de 8 a 12 s pour que l'utilisateur entende le PREMIER mot du
// sous-titre en le lisant. Le moteur de flux ajoute les mots au fil de la
// parole : le bon retard n'est plus que 2 a 3 s.
//
// Une valeur mesuree par l'ancien moteur est donc FAUSSE pour celui-ci -- et
// comme elle est memorisee pour de bon, elle ne serait jamais remesuree :
// l'utilisateur qui met a jour l'extension aurait un son en retard de 9 s sur
// un texte en avance de 2 s, sans aucun message d'erreur. En changeant de cle,
// l'ancienne mesure est simplement ignoree et la calibration recommence.
//
// EXACTEMENT LA MEME CHOSE VIENT DE SE REPRODUIRE AVEC L'AFFICHAGE, d'ou un
// deuxieme changement de cle.
//
// Il n'y a plus UN bon retard mais DEUX, un par mode d'affichage :
//   - << avec la fin provisoire >> : le dernier mot affiche est le dernier de
//     la fenetre. Le bon retard est son age, ~2 s.
//   - << stable seulement >> : le dernier mot affiche est celui que DEUX passes
//     ont confirme. Il est plus vieux d'une cadence, et le bon retard aussi.
//
// La valeur rangee est donc un objet { avecProvisoire, stable }, et non plus un
// nombre. Une ancienne valeur (un nombre) relue sous le meme nom serait traitee
// comme un objet sans champs -> `undefined` partout, silencieusement. On change
// de nom pour que ce cas ne puisse tout simplement pas se produire.
const RETARD_CALIBRE_KEY = "retardCalibreFluxParMode";

// Les cles des generations precedentes, gardees UNIQUEMENT pour etre effacees.
//   "retardCalibre"     : moteur par blocs, ~9 s -- la valeur a ne jamais revoir.
//   "retardCalibreFlux" : moteur de flux, mais un seul mode d'affichage.
const RETARD_CALIBRE_CLES_PERIMEES = ["retardCalibre", "retardCalibreFlux"];

// Efface les mesures perimees : elles ne serviront plus jamais, autant ne pas
// les laisser trainer dans le storage de l'utilisateur.
//
// Ce menage est un CONFORT, pas la protection. La protection, c'est le NOM de
// la cle : readRetardCalibre ne lit que RETARD_CALIBRE_KEY. Meme si ce
// nettoyage ne tournait jamais -- onInstalled ne se declenche qu'a
// l'installation ou a la mise a jour -- l'ancienne valeur ne serait pas relue,
// elle resterait juste inerte dans le storage.
//
// Dans onInstalled et PAS au premier niveau du fichier : le service worker est
// reveille sans arret (voir plus haut), et ce menage n'a de sens qu'une fois.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(RETARD_CALIBRE_CLES_PERIMEES).catch(() => {});
});

async function readRetard() {
  try {
    return (await chrome.storage.local.get(RETARD_KEY))[RETARD_KEY] ?? RETARD_DEFAUT;
  } catch (err) {
    // Sans memoire, pas de retard : c'est le comportement d'origine.
    console.warn("⚠️ Lecture du retard audio impossible :", err);
    return RETARD_DEFAUT;
  }
}

// Rend { avecProvisoire, stable } ou null. C'est l'offscreen qui choisit lequel
// des deux appliquer, puisque c'est lui qui suit le mode d'affichage.
async function readRetardCalibre() {
  try {
    const valeur = (await chrome.storage.local.get(RETARD_CALIBRE_KEY))[RETARD_CALIBRE_KEY];
    // Ceinture et bretelles : on n'accepte que la forme attendue. Un nombre
    // (l'ancienne forme) est refuse net plutot qu'a moitie utilise.
    return valeur && typeof valeur === "object" ? valeur : null;
  } catch (err) {
    // Sans memoire, l'offscreen recalibrera : c'est lent mais correct.
    console.warn("⚠️ Lecture du retard calibre impossible :", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Mode d'affichage (stable seul / avec la fin provisoire)
// ---------------------------------------------------------------------------
// C'est content.js qui l'applique a l'ecran, et il le lit lui-meme dans le
// storage. Le background ne le lit que pour UNE raison : l'offscreen doit
// savoir lequel des deux retards calibres appliquer au son des haut-parleurs.
const PROVISOIRE_KEY = "afficherProvisoire";

async function readAfficherProvisoire() {
  try {
    return Boolean((await chrome.storage.local.get(PROVISOIRE_KEY))[PROVISOIRE_KEY]);
  } catch (err) {
    // Sans memoire, le defaut : mode stable.
    console.warn("⚠️ Lecture du mode d'affichage impossible :", err);
    return false;
  }
}

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
// Demarrage / arret de la capture
// ---------------------------------------------------------------------------

// Affiche ou cache l'overlay. Isole dans son propre try : une page sans content
// script (chrome://, page ouverte avant l'installation) ne doit pas faire
// echouer la capture ni corrompre l'etat.
async function toggleOverlay(tabId, active) {
  if (!tabId) return;

  try {
    await chrome.tabs.sendMessage(tabId, { type: "TOGGLE_SUBTITLES", active });
    console.log(active ? "✅ Overlay active sur la page" : "✅ Overlay desactive sur la page");
  } catch (err) {
    console.warn("⚠️ Overlay injoignable sur cet onglet (content.js absent) :", err.message);
  }
}

// Relaie le flux de texte vers l'overlay de l'onglet capture.
//
// L'offscreen produit le texte mais ne peut pas l'envoyer lui-meme : il n'a pas
// acces a chrome.tabs. C'est donc nous qui faisons le pont, et nous seuls
// savons quel onglet est capture (chrome.storage.session).
//
// Ce message a remplace SUBTITLE. La difference n'est pas cosmetique : SUBTITLE
// portait UN sous-titre qui remplacait le precedent, FLUX porte l'etat COMPLET
// du texte -- `ruban` (ce qui est stable) et `provisoire` (la fin encore
// incertaine). C'est ce qui permet a l'overlay d'ajouter des mots au lieu de
// tout reecrire.
//
// Meme precaution que toggleOverlay : une page sans content script (chrome://,
// page ouverte avant l'installation) ne doit pas faire de bruit a chaque
// passe -- on log une fois en warn et on continue.
//
// ⚠️ ON RELAIE LE MESSAGE ENTIER, on ne le reconstruit pas champ par champ.
//
// Ce n'est pas un raccourci d'ecriture, c'est la correction d'un defaut reel.
// Cette fonction prenait `(ruban, provisoire, finAudio)` et reassemblait un
// objet a partir de ces trois-la. Tout champ ajoute par l'offscreen etait donc
// jete ICI, en silence : le destinataire ne voit pas la difference entre « le
// champ n'a pas ete envoye » et « le champ a ete perdu en route ».
//
// C'est arrive : `finAudioStable` -- le repere du mode « stable seulement » --
// etait produit par l'offscreen et attendu par content.js, mais n'a jamais
// traverse. content.js retombait sur `finAudioStable || finAudio`, donc rien ne
// plantait, rien ne s'affichait de travers : seule la mesure d'age du mode
// stable etait fausse d'une cadence, dans une ligne de console. Un repli qui
// marche est exactement ce qui rend ce genre de perte invisible.
//
// Les instants des mots (`rubanInstants`, `provisoireInstants`) prenaient le
// meme chemin et auraient disparu pareil.
async function sendFlux(flux) {
  const { active, tabId } = await readState();
  if (!active || !tabId) return; // capture arretee entre-temps

  try {
    // Tel quel : `ruban`, `provisoire`, les instants de chaque mot, et les deux
    // reperes temporels. content.js mesure l'AGE du mot le plus recent au
    // moment ou il l'affiche vraiment, et affichera chaque mot a son heure.
    await chrome.tabs.sendMessage(tabId, flux);
  } catch (err) {
    console.warn("⚠️ Flux non affiche (content.js injoignable) :", err.message);
  }
}

// Un statut peut arriver AVANT que l'etat "actif" soit ecrit : l'offscreen
// annonce « preparation du modele » pendant que nous sommes encore en train
// d'attendre sa reponse a START_CAPTURE (voir doStartAudioCapture, etapes 4 a
// 6). Sans ce garde-manger, le message le plus utile -- celui de la toute
// premiere minute -- serait justement le seul a ne jamais s'afficher.
//
// Variable memoire assumee : elle n'a de sens que dans le fil d'un demarrage,
// entre deux lignes de la meme fonction. Si le service worker meurt entre les
// deux, on perd un message d'ambiance, rien de plus.
let statutEnAttente = null;

// Relaie un message d'etat (« chargement », « calibration »...) vers l'overlay.
// Meme chemin et memes precautions que sendSubtitle : l'offscreen n'a pas acces
// a chrome.tabs, et une page sans content script ne doit pas faire de bruit.
async function sendStatut(texte) {
  const { active, tabId } = await readState();
  if (!active || !tabId) {
    statutEnAttente = texte; // pas encore d'overlay : on le garde pour l'etape 6
    return;
  }

  statutEnAttente = null;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "STATUT", texte });
  } catch (err) {
    console.warn("⚠️ Statut non affiche (content.js injoignable) :", err.message);
  }
}

// Renvoie toujours l'etat resultant -> c'est lui que la popup affiche.
function startAudioCapture() {
  return serializeCapture(doStartAudioCapture);
}

async function doStartAudioCapture() {
  // Garde anti double-capture : si une capture tourne deja, on ne demarre pas
  // une deuxieme (elle volerait le flux de la premiere).
  const current = await getCaptureState();
  if (current.active) {
    console.log("ℹ️ Capture deja active sur l'onglet", current.tabId, "- on ignore");
    return current;
  }

  // Un statut reste peut-etre d'un demarrage rate : il n'a plus rien a dire
  // sur celui-ci.
  statutEnAttente = null;

  try {
    console.log("🎤 Demarrage capture audio...");

    // 1. Créer l'offscreen document
    await createOffscreen();

    // 2. Récupérer l'onglet actif
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("Aucun onglet actif");
    console.log("📌 Onglet actif :", tab.id);

    // 3. Démarrer la capture audio
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id
    });
    console.log("✅ StreamId obtenu :", streamId);

    // 4. Envoyer le streamId à l'offscreen document et ATTENDRE son verdict.
    // L'offscreen ne repond qu'une fois getUserMedia et l'AudioContext
    // reellement demarres : c'est cette reponse qui fait foi, pas le simple
    // fait que le message soit parti.
    console.log("📤 Envoi du message a l'offscreen...");
    const response = await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      streamId: streamId,
      tabId: tab.id,
      // L'offscreen ne peut pas lire chrome.storage de facon fiable : on lui
      // passe le backend deja mesure (null au premier lancement).
      memoBackend: await readWhisperBackend(),
      // Idem pour la langue choisie dans la popup.
      langue: await readLangue(),
      // Et pour le retard applique au son des haut-parleurs.
      retard: await readRetard(),
      // En mode "auto", les valeurs deja calibrees (null si jamais mesurees) :
      // elles evitent de repasser par la calibration a chaque lancement.
      retardCalibre: await readRetardCalibre(),
      // Et le mode d'affichage, qui dit laquelle des deux s'applique.
      afficherProvisoire: await readAfficherProvisoire()
    });

    if (!response || !response.success) {
      throw new Error(
        (response && response.error) ||
        "L'offscreen document n'a pas confirme le demarrage de la capture"
      );
    }
    console.log("✅ Offscreen a confirme le demarrage");

    // 5. Etat officiel : on capture. On n'arrive ici que si TOUT a reussi.
    const state = await writeState({ active: true, tabId: tab.id });

    // 6. Dire à content.js d'afficher l'overlay
    await toggleOverlay(tab.id, true);

    // 7. L'overlay existe enfin : on lui donne le statut arrive trop tot.
    if (statutEnAttente) {
      const texte = statutEnAttente;
      statutEnAttente = null;
      chrome.tabs.sendMessage(tab.id, { type: "STATUT", texte }).catch(() => {});
    }

    // Le VAD peut avoir echoue sans empecher la capture : on fait remonter
    // l'avertissement a la popup au lieu de le laisser en console.
    return response.warning ? { ...state, warning: response.warning } : state;

  } catch (error) {
    console.error("❌ Erreur startAudioCapture :", error);

    // L'echec peut survenir apres que l'offscreen a ouvert un flux : on le
    // referme, sinon un onglet resterait marque "en cours de capture" par
    // Chrome alors que l'extension se croit a l'arret.
    try {
      await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    } catch (err) {
      // Normal s'il n'y a pas (ou plus) d'offscreen document.
    }

    // On remet l'etat a zero : sans ca la popup afficherait "Actif" alors que
    // rien ne tourne, et le bouton refuserait de redemarrer.
    await writeState(EMPTY_STATE);
    return { ...EMPTY_STATE, error: describeError(error) };
  }
}

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

function stopAudioCapture() {
  return serializeCapture(doStopAudioCapture);
}

async function doStopAudioCapture() {
  console.log("⏸️ Arret de la capture audio...");

  // On lit l'onglet AVANT de remettre l'etat a zero : c'est l'onglet capture,
  // pas forcement l'onglet actif au moment du clic.
  const { tabId } = await readState();

  try {
    await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" });
    console.log("✅ Message STOP envoye a l'offscreen");
  } catch (err) {
    console.warn("Erreur lors de l'arret (normal si l'offscreen est deja ferme)");
  }

  await toggleOverlay(tabId, false);

  const state = await writeState(EMPTY_STATE);
  console.log("✅ Capture audio arretee");
  return state;
}

// Si l'onglet capture est ferme, le flux meurt avec lui : on nettoie l'etat
// pour que la popup ne reste pas bloquee sur "Actif".
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await readState();
  if (state.active && state.tabId === tabId) {
    console.log("🗑️ Onglet capture ferme, arret de la capture");
    await stopAudioCapture();
  }
});

// ---------------------------------------------------------------------------
// Messages de la popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("📩 Message recu dans background :", request);

  // Flux de texte de l'offscreen -> overlay de l'onglet capture.
  if (request.type === "FLUX") {
    sendFlux(request);
    return; // pas de reponse attendue
  }

  // Message d'etat de l'offscreen (chargement du modele, calibration...) ->
  // meme onglet, meme chemin que FLUX.
  if (request.type === "STATUT") {
    sendStatut(request.texte);
    return; // pas de reponse attendue
  }

  // La popup a change de langue -> on previent l'offscreen, qui l'appliquera
  // au prochain segment. Ca evite d'avoir a redemarrer la capture.
  if (request.type === "SET_LANGUE") {
    // try/catch : il n'y a pas forcement d'offscreen document (aucune capture
    // en cours). Ce n'est pas une erreur -- la langue est deja rangee dans
    // storage.local par la popup, et sera lue au prochain demarrage.
    chrome.runtime
      .sendMessage({ type: "LANGUE", langue: request.langue })
      .then(() => console.log("🗣️ Langue transmise a l'offscreen :", request.langue))
      .catch(() => console.log("ℹ️ Pas de capture en cours : langue rangee pour plus tard"));
    return; // pas de reponse attendue
  }

  // La popup a change le retard du son -> on previent l'offscreen, qui ajuste
  // son noeud de retard a chaud. Meme fonctionnement que SET_LANGUE.
  if (request.type === "SET_RETARD") {
    // Repasser sur "auto" doit REMESURER : on efface la valeur calibree avant
    // de relayer, sinon l'offscreen reappliquerait l'ancienne mesure -- qui
    // peut dater d'une machine plus rapide ou d'un autre reglage.
    const prepare =
      request.retard === "auto"
        ? chrome.storage.local.remove(RETARD_CALIBRE_KEY).catch(() => {})
        : Promise.resolve();

    prepare.then(() => {
      // try/catch : pas forcement d'offscreen document (aucune capture en
      // cours). La valeur est deja rangee dans storage.local par la popup.
      chrome.runtime
        .sendMessage({ type: "RETARD", retard: request.retard })
        .then(() => console.log("⏱️ Retard transmis a l'offscreen :", request.retard))
        .catch(() => console.log("ℹ️ Pas de capture en cours : retard range pour plus tard"));
    });
    return; // pas de reponse attendue
  }

  // La popup a coche/decoche « Afficher la fin provisoire ».
  //
  // L'overlay, lui, n'a besoin de personne : content.js lit le storage tout
  // seul (un content script y a acces). Ce relais ne sert qu'a l'offscreen, qui
  // n'a PAS acces a chrome.storage et doit pourtant savoir lequel des deux
  // retards calibres appliquer au son. Meme chemin que SET_LANGUE et
  // SET_RETARD : si rien ne capture, l'envoi echoue sans consequence, la valeur
  // sera lue au prochain demarrage (voir readAfficherProvisoire).
  if (request.type === "SET_PROVISOIRE") {
    chrome.runtime
      .sendMessage({ type: "PROVISOIRE", afficherProvisoire: request.afficherProvisoire })
      .then(() => console.log("👁️ Mode d'affichage transmis a l'offscreen :", request.afficherProvisoire))
      .catch(() => console.log("ℹ️ Pas de capture en cours : mode d'affichage range pour plus tard"));
    return; // pas de reponse attendue
  }

  // L'offscreen a fini de mesurer les bons retards : on les retient, pour que
  // les prochains lancements les appliquent des la premiere seconde.
  //
  // Les DEUX modes sont mesures en un seul passage, sur les memes passes : il
  // n'y a aucune raison de faire calibrer l'utilisateur deux fois -- et cocher
  // la case doit recaler le son tout de suite, pas relancer une calibration.
  if (request.type === "RETARD_CALIBRE") {
    const valeurs = {
      avecProvisoire: request.avecProvisoire,
      stable: request.stable
    };
    chrome.storage.local
      .set({ [RETARD_CALIBRE_KEY]: valeurs })
      .then(() =>
        console.log(
          `💾 Retards calibres memorises : ${valeurs.avecProvisoire} s (avec provisoire) / ` +
            `${valeurs.stable} s (stable seul)`
        )
      )
      .catch((err) => console.warn("⚠️ Memorisation du retard impossible :", err));
    return; // pas de reponse attendue
  }

  // L'offscreen a fini de choisir son backend : on le retient pour la prochaine
  // fois, ce qui evite de refaire la mesure GPU/CPU a chaque capture.
  if (request.type === "WHISPER_BACKEND") {
    chrome.storage.local
      .set({ [BACKEND_KEY]: { backend: request.backend, signature: request.signature } })
      .then(() => console.log("💾 Backend Whisper memorise :", request.backend))
      .catch((err) => console.warn("⚠️ Memorisation du backend impossible :", err));
    return; // pas de reponse attendue
  }

  // La popup demande l'etat courant a son ouverture.
  if (request.type === "GET_STATE") {
    getCaptureState().then(sendResponse);
    return true; // reponse asynchrone
  }

  if (request.type === "TOGGLE_SUBTITLES") {
    const action = request.active ? startAudioCapture() : stopAudioCapture();
    // On renvoie l'etat REEL obtenu : si le demarrage echoue, la popup le sait
    // et raffiche "Demarrer" au lieu de mentir.
    action.then(sendResponse);
    return true; // reponse asynchrone
  }
});


// ===========================================================================
// MODE « PREPARER D'ABORD » — etape A : l'orchestration
// ===========================================================================
//
// Un mode a COTE du direct. Ni `captureState`, ni `doStartAudioCapture`, ni
// `sendFlux`, ni le listener de messages existant ne sont touches : ce qui suit
// s'ajoute, avec son propre etat, ses propres messages et son propre listener.
//
// Le service worker meurt au bout de ~30 s d'inactivite, et une preparation
// dure des minutes. Tout l'etat vit donc dans chrome.storage.session, comme
// pour le direct -- une variable memoire aurait disparu en plein milieu.
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

// Meme garde-fou que getCaptureState : un etat qui dit « actif » alors que
// l'offscreen a disparu est un etat qui ment.
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
  const direct = await getCaptureState();
  if (direct.active) {
    return { active: false, error: "Le mode direct capture deja cet onglet : arrete-le d'abord" };
  }

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
    const reponse = await chrome.runtime.sendMessage({
      type: "START_PREPARATION",
      streamId,
      // L'offscreen n'a pas acces a chrome.storage : tout arrive par message.
      langue: await readLangue(),
      memoBackend: await readWhisperBackend(),
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
    await chrome.runtime
      .sendMessage({ type: "PREPARATION_POSITION", position: pilote.position })
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

// Les deux operations passent par la MEME file que le direct : c'est ce qui
// garantit qu'un demarrage direct et un demarrage de preparation ne peuvent pas
// se croiser et ouvrir deux captures sur le meme onglet.
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
// entre un content script et un document offscreen. On relaie, exactement comme
// FLUX le fait dans l'autre sens pour le mode direct.
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
