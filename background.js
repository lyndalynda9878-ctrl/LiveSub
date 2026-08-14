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

// Renvoie toujours l'etat resultant -> c'est lui que la popup affiche.
async function startAudioCapture() {
  // Garde anti double-capture : si une capture tourne deja, on ne demarre pas
  // une deuxieme (elle volerait le flux de la premiere).
  const current = await getCaptureState();
  if (current.active) {
    console.log("ℹ️ Capture deja active sur l'onglet", current.tabId, "- on ignore");
    return current;
  }

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

    // 4. Envoyer le streamId à l'offscreen document
    console.log("📤 Envoi du message a l'offscreen...");
    await chrome.runtime.sendMessage({
      type: "START_CAPTURE",
      streamId: streamId,
      tabId: tab.id
    });
    console.log("✅ Message envoye a l'offscreen");

    // 5. Etat officiel : on capture.
    const state = await writeState({ active: true, tabId: tab.id });

    // 6. Dire à content.js d'afficher l'overlay
    await toggleOverlay(tab.id, true);

    return state;

  } catch (error) {
    console.error("❌ Erreur startAudioCapture :", error);
    // On remet l'etat a zero : sans ca la popup afficherait "Actif" alors que
    // rien ne tourne, et le bouton refuserait de redemarrer.
    await writeState(EMPTY_STATE);
    return { ...EMPTY_STATE, error: error.message || String(error) };
  }
}

async function stopAudioCapture() {
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
