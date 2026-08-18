console.log("LiveSub charge sur cette page !");

// Créer l'overlay (la barre noire)
const subtitleBox = document.createElement("div");
subtitleBox.id = "livesub-overlay";
subtitleBox.style.position = "fixed";
subtitleBox.style.bottom = "40px";
subtitleBox.style.left = "50%";
subtitleBox.style.transform = "translateX(-50%)";
subtitleBox.style.width = "80%";
subtitleBox.style.maxWidth = "800px";
subtitleBox.style.background = "rgba(0, 0, 0, 0.85)";
subtitleBox.style.color = "white";
subtitleBox.style.padding = "16px 24px";
subtitleBox.style.borderRadius = "14px";
subtitleBox.style.textAlign = "center";
subtitleBox.style.fontSize = "24px";
subtitleBox.style.fontWeight = "bold";
subtitleBox.style.zIndex = "999999";
subtitleBox.style.boxShadow = "0 8px 30px rgba(0,0,0,0.6)";
subtitleBox.style.border = "2px solid #4f46e5";
subtitleBox.style.display = "none"; // Caché au départ
subtitleBox.innerText = "🎬 Sous-titres actifs...";
document.body.appendChild(subtitleBox);

console.log("✅ Overlay cree sur la page");

// Un vrai sous-titre a-t-il deja ete affiche pour cette capture ?
//
// C'est la seule regle qui compte pour les messages d'etat : ils occupent
// l'overlay tant qu'il n'y a rien de mieux a montrer, et ils s'effacent pour
// toujours des le premier vrai texte. Un « chargement du modele » qui
// recouvrirait une phrase transcrite serait pire que pas de message du tout.
let premierSousTitreAffiche = false;

// Fonction pour afficher/cacher l'overlay
function toggleOverlay(show) {
  if (show) {
    subtitleBox.style.display = "block";
    subtitleBox.innerText = "🎬 Ecoute du son en cours...";
    subtitleBox.style.opacity = "1";
    subtitleBox.style.fontStyle = "normal";
    premierSousTitreAffiche = false; // nouvelle capture : les statuts reprennent la main
    console.log("✅ Overlay AFFICHE sur la page");
  } else {
    subtitleBox.style.display = "none";
    console.log("⏸️ Overlay CACHE sur la page");
  }
}

// Afficher un texte transcrit. Chaque segment REMPLACE le precedent : un
// sous-titre, c'est ce qui vient d'etre dit, pas l'historique de la video.
function afficherSousTitre(texte, finParole) {
  if (!texte) return;

  subtitleBox.innerText = texte;
  premierSousTitreAffiche = true;

  // Retour au style plein : le texte precedent etait peut-etre un statut.
  subtitleBox.style.opacity = "1";
  subtitleBox.style.fontStyle = "normal";

  // Le texte peut arriver juste avant le TOGGLE_SUBTITLES (les deux voyagent
  // par des chemins differents). On ne force pas l'affichage pour autant :
  // c'est TOGGLE_SUBTITLES qui decide si l'overlay est visible, et le texte
  // sera deja en place quand il s'affichera.

  // Latence bout en bout : de la fermeture du segment (cote offscreen) a cet
  // affichage. C'est le chiffre qui compte pour l'utilisateur -- il englobe la
  // transcription, l'attente en file et les deux sauts de messages.
  const latence = finParole ? ((Date.now() - finParole) / 1000).toFixed(1) : "?";
  console.log(`📝 Sous-titre affiche (${latence} s apres la fin de parole) :`, texte);
}

// Afficher un message d'etat (chargement du modele, calibration...).
//
// Volontairement attenue -- plus pale et en italique -- pour qu'on voie d'un
// coup d'oeil que ce n'est pas de la parole transcrite.
function afficherStatut(texte) {
  if (!texte) return;

  // Un statut n'ecrase JAMAIS un vrai sous-titre.
  if (premierSousTitreAffiche) {
    console.log("ℹ️ Statut ignore (des sous-titres sont deja affiches) :", texte);
    return;
  }

  subtitleBox.innerText = texte;
  subtitleBox.style.opacity = "0.75";
  subtitleBox.style.fontStyle = "italic";
  console.log("💬 Statut affiche :", texte);
}

// Écouter les messages du service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("📩 Message recu dans content.js :", request);

  if (request.type === "TOGGLE_SUBTITLES") {
    toggleOverlay(request.active);
    sendResponse({ success: true });
  }

  if (request.type === "SUBTITLE") {
    afficherSousTitre(request.texte, request.finParole);
    sendResponse({ success: true });
  }

  if (request.type === "STATUT") {
    afficherStatut(request.texte);
    sendResponse({ success: true });
  }
});

// Par défaut, l'overlay est caché
toggleOverlay(false);