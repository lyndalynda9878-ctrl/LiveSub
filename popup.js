// La popup n'a plus d'etat a elle : elle AFFICHE l'etat du background.
// Une popup est detruite a chaque fermeture, donc toute variable locale
// repartirait a zero -- c'etait la cause de la desynchronisation du bouton.
let isActive = false;

// Dernier message renvoye par le background.
// On le garde ici parce que l'echec declenche aussi un evenement
// storage.onChanged : sans ca, le repaint provoque par cet evenement effacerait
// l'erreur avant meme qu'elle soit lue.
let errorMessage = null;
let warningMessage = null;

// Recuperer le bouton et la zone de statut
const toggleBtn = document.getElementById("toggleBtn");
const statusDiv = document.getElementById("status");
const langueSelect = document.getElementById("langue");

// ---------------------------------------------------------------------------
// Langue parlee dans la video
// ---------------------------------------------------------------------------
//
// storage.local (et pas .session) : le choix doit survivre a la fermeture du
// navigateur, c'est une preference de l'utilisateur.
//
// La popup est detruite a chaque fermeture : sans cette relecture au
// chargement, le menu repartirait toujours sur la premiere option.
const CLE_LANGUE = "langueSousTitres";
const LANGUE_PAR_DEFAUT = "french";

async function chargerLangue() {
  try {
    const stored = await chrome.storage.local.get(CLE_LANGUE);
    langueSelect.value = stored[CLE_LANGUE] || LANGUE_PAR_DEFAUT;
  } catch (err) {
    // Sans storage on affiche le defaut : rien de casse, juste pas memorise.
    langueSelect.value = LANGUE_PAR_DEFAUT;
  }
}

langueSelect.addEventListener("change", async () => {
  const langue = langueSelect.value;

  try {
    await chrome.storage.local.set({ [CLE_LANGUE]: langue });
    // On previent le background, qui relaie a l'offscreen : ca permet de
    // changer de langue SANS redemarrer la capture. Si rien ne capture, le
    // relais echoue sans consequence -- la valeur rangee ci-dessus sera lue au
    // prochain demarrage.
    await chrome.runtime.sendMessage({ type: "SET_LANGUE", langue });
  } catch (err) {
    console.warn("Changement de langue non transmis :", err);
  }
});

function setStatus(text, color) {
  statusDiv.textContent = text;
  statusDiv.style.color = color;
  // La popup est etroite : l'infobulle permet de lire un message tronque.
  statusDiv.title = text;
}

// Fonction pour mettre a jour l'affichage du bouton
function updateUI() {
  toggleBtn.disabled = false;

  if (isActive) {
    toggleBtn.textContent = "⏹️ Arreter";
    toggleBtn.className = "stop";
  } else {
    toggleBtn.textContent = "▶️ Demarrer";
    toggleBtn.className = "";
  }

  // Une erreur prime sur l'etat : elle reste affichee tant que l'utilisateur
  // n'a pas relance une action. Et comme isActive vaut false en cas d'echec,
  // le bouton est deja revenu sur "Demarrer".
  if (errorMessage) {
    setStatus("❌ " + errorMessage, "#dc2626");
  } else if (isActive && warningMessage) {
    setStatus("⚠️ " + warningMessage, "#b45309");
  } else if (isActive) {
    setStatus("✅ Actif", "#0f9d63");
  } else {
    setStatus("⏸️ Arrete", "#666");
  }
}

// Applique la reponse du background : c'est LUI qui dit si la capture tourne
// vraiment. On n'affiche jamais "Actif" sur une supposition de la popup.
function applyState(state) {
  isActive = Boolean(state && state.active);
  errorMessage = (state && state.error) || null;
  warningMessage = (state && state.warning) || null;
  updateUI();
}

// Demander l'etat courant au background (source de verite).
async function loadState() {
  toggleBtn.disabled = true;
  setStatus("⏳ ...", "#666");

  try {
    applyState(await chrome.runtime.sendMessage({ type: "GET_STATE" }));
  } catch (err) {
    applyState({ active: false, error: "Background injoignable" });
  }
}

// Quand on clique sur le bouton
toggleBtn.addEventListener("click", async () => {
  // On ne devine plus le nouvel etat : on demande l'action, et c'est le
  // background qui nous dit ce qui s'est reellement passe.
  const wanted = !isActive;

  // Nouvelle tentative : on repart d'une ardoise propre.
  errorMessage = null;
  warningMessage = null;

  toggleBtn.disabled = true;
  setStatus(wanted ? "⏳ Demarrage..." : "⏳ Arret...", "#666");

  try {
    applyState(await chrome.runtime.sendMessage({
      type: "TOGGLE_SUBTITLES",
      active: wanted
    }));
  } catch (err) {
    // Le background n'a pas repondu : on redemande l'etat reel, mais on garde
    // l'erreur affichee par-dessus.
    const message = "Echec : " + (err.message || err);
    try {
      const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      applyState({ ...(state || {}), error: message });
    } catch (err2) {
      applyState({ active: false, error: message });
    }
  }
});

// Si l'etat change pendant que la popup est ouverte (onglet capture ferme,
// arret automatique...), on se resynchronise sans attendre un clic.
chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes.captureState;
  if (!change) return;

  isActive = Boolean(change.newValue && change.newValue.active);

  // Le storage ne transporte que l'etat, pas les messages : on ne jette
  // l'erreur affichee que si une capture vient de demarrer pour de bon.
  if (isActive) {
    errorMessage = null;
  }

  updateUI();
});

// Au depart, on demande l'etat au background au lieu de supposer "arrete".
loadState();
chargerLangue();
