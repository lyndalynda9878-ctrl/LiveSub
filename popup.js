// La popup de LiveSub : UN bouton, aucun reglage.
//
// ⚠️ CE QUI A DISPARU A L'ETAPE 5, AVEC LE MODE DIRECT :
//
//   - le bouton Demarrer/Arreter du direct, son statut, son `updateUI` et les
//     messages GET_STATE / TOGGLE_SUBTITLES ;
//   - le selecteur de MODE (`modeLiveSub`) : il n'y a plus qu'un mode ;
//   - le menu de LANGUE (`langueSousTitres`) : Parakeet detecte la langue tout
//     seul, son vocabulaire ne contient aucun jeton de langue. Le menu etait
//     devenu un bouton debranche ;
//   - le RETARD DU SON (`retardAudio`) et son affichage de calibration : ils
//     recalaient le son sur des sous-titres en retard, ce qui n'a plus d'objet
//     quand le texte est pret avant la lecture ;
//   - la case « Afficher la fin provisoire » (`afficherProvisoire`) : elle
//     decrivait LocalAgreement-2, qui n'existe plus.
//
// Les cles de storage correspondantes sont effacees par background.js
// (voir CLES_PERIMEES) : plus personne ne les lit, et une vieille valeur
// laissee dans le storage d'un utilisateur ne peut donc rien casser.

const prepBtn = document.getElementById("prepBtn");
const prepStatus = document.getElementById("prepStatus");

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
    prepMessage = {
      texte: `✅ Pret — ${r.nbMots} mots, ${minutes} min ${String(secondes).padStart(2, "0")} s couvertes`,
      couleur: "#0f9d63",
    };
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
  prepSetStatus(voulu ? "⏳ Demarrage..." : "⏳ Arret...", "#666");

  try {
    prepAppliquerEtat(
      await chrome.runtime.sendMessage({
        type: voulu ? "PREPARATION_DEMARRER" : "PREPARATION_ARRETER",
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

prepCharger();
