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
const retardSelect = document.getElementById("retardAudio");
const provisoireCase = document.getElementById("afficherProvisoire");

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

// ---------------------------------------------------------------------------
// Afficher la fin provisoire ?
// ---------------------------------------------------------------------------
//
// Le moteur produit deux textes : le STABLE (deux passes successives sont
// tombees d'accord dessus, il ne bougera plus jamais) et la FIN PROVISOIRE (la
// derniere hypothese, que la passe suivante a le droit de corriger).
//
// Decoche -- le DEFAUT -- on n'affiche que le stable : le texte ne fait que
// s'allonger, plus rien ne se reecrit sous les yeux. Prix assume : environ une
// cadence de retard en plus (~2 s).
//
// ⚠️ On n'ecrit QUE dans storage.local, et on ne previent personne : c'est
// content.js qui ecoute storage.onChanged et bascule tout seul, dans l'onglet,
// sans redemarrer la capture. Passer par le service worker n'apporterait rien
// ici -- et le ferait echouer quand rien ne capture.
const CLE_PROVISOIRE = "afficherProvisoire";
const PROVISOIRE_PAR_DEFAUT = false;

async function chargerProvisoire() {
  try {
    const stored = await chrome.storage.local.get(CLE_PROVISOIRE);
    provisoireCase.checked = Boolean(stored[CLE_PROVISOIRE] ?? PROVISOIRE_PAR_DEFAUT);
  } catch (err) {
    provisoireCase.checked = PROVISOIRE_PAR_DEFAUT;
  }
}

provisoireCase.addEventListener("change", async () => {
  try {
    await chrome.storage.local.set({ [CLE_PROVISOIRE]: provisoireCase.checked });
  } catch (err) {
    console.warn("Option d'affichage non memorisee :", err);
  }
  // Le bon retard du son n'est pas le meme dans les deux modes : l'info affichee
  // sous le menu doit suivre.
  await afficherInfoRetard();
});

// ---------------------------------------------------------------------------
// Retard du son
// ---------------------------------------------------------------------------
//
// Meme mecanique que la langue, a deux differences pres :
//   - les valeurs chiffrees sont rangees en NOMBRE, pas en texte
//     (`select.value` rend toujours une chaine, et c'est un nombre que
//     l'AudioContext attend pour delayTime) ;
//   - "auto" reste une CHAINE : ce n'est pas une duree, c'est un mode.
const CLE_RETARD = "retardAudio";
// ⚠️ Doit rester identique a RETARD_CALIBRE_KEY dans background.js : le nom
// porte le moteur ET la forme de la valeur, pour qu'une mesure faite par un
// moteur ou un affichage precedent ne soit jamais reappliquee. Voir le long
// commentaire la-bas. La valeur est un objet { avecProvisoire, stable }.
const CLE_RETARD_CALIBRE = "retardCalibreFluxParMode";
const RETARD_PAR_DEFAUT = 0;

const retardInfo = document.getElementById("retardInfo");

// En mode auto, on montre ou en est la mesure : sans ca, l'utilisateur ne
// saurait pas si le retard est deja cale ou encore en cours de calcul.
async function afficherInfoRetard() {
  if (retardSelect.value !== "auto") {
    retardInfo.textContent = "";
    return;
  }

  try {
    const stored = await chrome.storage.local.get(CLE_RETARD_CALIBRE);
    const calibre = stored[CLE_RETARD_CALIBRE];

    // Deux valeurs sont mesurees en un seul passage, une par mode d'affichage :
    // le texte stable arrive une cadence plus tard que la fin provisoire, donc
    // il faut retarder le son d'autant en plus. On montre celle QUI S'APPLIQUE.
    const mode = provisoireCase.checked ? "avecProvisoire" : "stable";
    const valeur = calibre && calibre[mode];

    retardInfo.textContent =
      typeof valeur === "number"
        ? `aligné à ${valeur.toFixed(1)} s (${provisoireCase.checked ? "avec provisoire" : "stable"})`
        : "calibration…";
  } catch (err) {
    retardInfo.textContent = "calibration…";
  }
}

async function chargerRetard() {
  try {
    const stored = await chrome.storage.local.get(CLE_RETARD);
    retardSelect.value = String(stored[CLE_RETARD] ?? RETARD_PAR_DEFAUT);
  } catch (err) {
    retardSelect.value = String(RETARD_PAR_DEFAUT);
  }
  await afficherInfoRetard();
}

retardSelect.addEventListener("change", async () => {
  const brut = retardSelect.value;
  // "auto" est un mode, pas une duree : il ne passe pas par Number().
  const retard = brut === "auto" ? "auto" : Number(brut);

  try {
    await chrome.storage.local.set({ [CLE_RETARD]: retard });
    // Comme pour la langue : le background relaie a l'offscreen, ce qui permet
    // d'ajuster le retard sans redemarrer la capture. Si rien ne capture, le
    // relais echoue sans consequence.
    await chrome.runtime.sendMessage({ type: "SET_RETARD", retard });
  } catch (err) {
    console.warn("Changement de retard non transmis :", err);
  }

  await afficherInfoRetard();
});

// La calibration se termine pendant que la popup est ouverte : on rafraichit
// l'affichage au lieu de laisser « calibration… » indefiniment.
chrome.storage.onChanged.addListener((changes, zone) => {
  if (zone === "local" && changes[CLE_RETARD_CALIBRE]) afficherInfoRetard();
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
// La case doit etre lue AVANT le retard : afficherInfoRetard s'en sert pour
// choisir laquelle des deux valeurs calibrees elle annonce.
chargerProvisoire().then(chargerRetard);
