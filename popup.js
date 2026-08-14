// La popup n'a plus d'etat a elle : elle AFFICHE l'etat du background.
// Une popup est detruite a chaque fermeture, donc toute variable locale
// repartirait a zero -- c'etait la cause de la desynchronisation du bouton.
let isActive = false;

// Recuperer le bouton et la zone de statut
const toggleBtn = document.getElementById("toggleBtn");
const statusDiv = document.getElementById("status");

// Fonction pour mettre a jour l'affichage du bouton
function updateUI() {
  toggleBtn.disabled = false;

  if (isActive) {
    toggleBtn.textContent = "⏹️ Arreter";
    toggleBtn.className = "stop";
    statusDiv.textContent = "✅ Actif";
    statusDiv.style.color = "#0f9d63";
  } else {
    toggleBtn.textContent = "▶️ Demarrer";
    toggleBtn.className = "";
    statusDiv.textContent = "⏸️ Arrete";
    statusDiv.style.color = "#666";
  }
}

function showError(message) {
  statusDiv.textContent = "❌ " + message;
  statusDiv.style.color = "#dc2626";
}

// Demander l'etat courant au background (source de verite).
async function loadState() {
  toggleBtn.disabled = true;
  statusDiv.textContent = "⏳ ...";

  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    isActive = Boolean(state && state.active);
    updateUI();
  } catch (err) {
    isActive = false;
    updateUI();
    showError("Background injoignable");
  }
}

// Quand on clique sur le bouton
toggleBtn.addEventListener("click", async () => {
  // On ne devine plus le nouvel etat : on demande l'action, et c'est le
  // background qui nous dit ce qui s'est reellement passe.
  const wanted = !isActive;

  toggleBtn.disabled = true;
  statusDiv.textContent = wanted ? "⏳ Demarrage..." : "⏳ Arret...";
  statusDiv.style.color = "#666";

  try {
    const state = await chrome.runtime.sendMessage({
      type: "TOGGLE_SUBTITLES",
      active: wanted
    });

    isActive = Boolean(state && state.active);
    updateUI();

    if (state && state.error) {
      showError(state.error);
    }
  } catch (err) {
    await loadState();
    showError("Echec : " + (err.message || err));
  }
});

// Si l'etat change pendant que la popup est ouverte (onglet capture ferme,
// arret automatique...), on se resynchronise sans attendre un clic.
chrome.storage.session.onChanged.addListener((changes) => {
  const change = changes.captureState;
  if (!change) return;

  isActive = Boolean(change.newValue && change.newValue.active);
  updateUI();
});

// Au depart, on demande l'etat au background au lieu de supposer "arrete".
loadState();
