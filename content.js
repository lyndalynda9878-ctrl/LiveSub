console.log("LiveSub charge sur cette page !");

// ---------------------------------------------------------------------------
// L'overlay : un RUBAN qui coule, pas un sous-titre qui saute
// ---------------------------------------------------------------------------
//
// AVANT : chaque texte recu remplacait le precedent. L'ecran ne bougeait qu'une
// fois toutes les 7 secondes, et d'un coup -- une phrase entiere apparaissait,
// sans lien visible avec celle d'avant.
//
// MAINTENANT : le texte s'AJOUTE a la suite, mot par mot, et quand la deuxieme
// ligne est pleine tout remonte d'une ligne : le debut sort par le haut. C'est
// l'effet des sous-titres automatiques de YouTube.
//
// Trois choses le produisent, et il faut les trois :
//   1. la boite fait DEUX LIGNES de hauteur FIXE, contenu aligne en bas, ce qui
//      depasse est coupe (voir `zone` et `rendre`) ;
//   2. l'offscreen n'envoie plus un sous-titre isole mais l'ETAT COMPLET du
//      texte -- `ruban` (stable) + `provisoire` (fin encore incertaine) ;
//   3. les mots nouveaux sont reveles UN PAR UN (voir PAS_REVELATION), sinon
//      cinq mots apparaissent d'un bloc et l'effet direct disparait.

// La boite noire, inchangee : position, largeur, couleurs, bordure.
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

// Hauteur d'une ligne, ecrite noir sur blanc : c'est elle qui fixe la hauteur
// de la boite. Sans valeur explicite on heriterait du line-height de la PAGE,
// qui change d'un site a l'autre -- et la boite ne ferait plus exactement deux
// lignes.
const LIGNES_VISIBLES = 2;
const HAUTEUR_LIGNE = 1.35;
subtitleBox.style.lineHeight = String(HAUTEUR_LIGNE);

// La fenetre de lecture : hauteur FIXE de deux lignes, et ce qui depasse est
// coupe. Elle ne grandit pas, ne retrecit pas, ne saute pas -- meme quand elle
// est vide, meme quand le texte fait quatre lignes.
const zone = document.createElement("div");
zone.style.height = `${LIGNES_VISIBLES * HAUTEUR_LIGNE}em`;
zone.style.overflow = "hidden";

// Le texte lui-meme. On le fait remonter a la main (voir `rendre`) plutot que
// de s'en remettre a un alignement en bas du navigateur : ici on connait
// exactement de combien ca depasse, donc le resultat est le meme partout.
const ligne = document.createElement("div");
zone.appendChild(ligne);
subtitleBox.appendChild(zone);
document.body.appendChild(subtitleBox);

console.log("✅ Overlay cree sur la page");

// ---------------------------------------------------------------------------
// Etat de l'affichage
// ---------------------------------------------------------------------------

// Un vrai texte a-t-il deja ete affiche pour cette capture ?
//
// C'est la seule regle qui compte pour les messages d'etat : ils occupent
// l'overlay tant qu'il n'y a rien de mieux a montrer, et ils s'effacent pour
// toujours des le premier vrai texte. Un « chargement du modele » qui
// recouvrirait une phrase transcrite serait pire que pas de message du tout.
let premierTexteAffiche = false;

// Le texte VISE (ruban + provisoire), decoupe en mots, et combien sont
// reellement a l'ecran. L'ecart entre les deux, c'est ce qu'il reste a reveler.
let motsCible = [];
let nbAffiches = 0;
let minuterie = null;

// Instant ou le dernier son transcrit a ete capte, pour la passe en cours
// d'affichage. Sert a mesurer l'AGE du mot le plus recent quand il apparait.
let finAudioCible = null;

// Delai entre deux mots reveles. Assez lent pour qu'on voie les mots arriver,
// assez rapide pour ne jamais accumuler de retard : une passe apporte rarement
// plus de 5 mots, soit 400 ms, alors qu'elle dure 2 a 3 s.
const PAS_REVELATION = 80;

// Nombre maximum de mots qu'on accepte de reveler un par un. Au-dela, on saute
// directement a la fin et on n'anime que les derniers.
//
// ⚠️ CETTE BORNE N'EST PAS UN CONFORT, C'EST UNE CORRECTION MESUREE.
//
// Le ruban est bien plus long que ce que deux lignes montrent : son debut a
// deja defile hors de la boite. Sans cette borne, un simple recalage (le ruban
// est rogne par la gauche, ou une passe repart d'un texte different) faisait
// re-reveler la soixantaine de mots du ruban a 80 ms piece -- pres de 5
// secondes passees a ranimer du texte que l'utilisateur avait deja lu, et
// pendant lesquelles l'affichage prenait un retard qu'il ne rattrapait jamais.
//
// Mesure avant/apres, sur la meme source : l'age du mot le plus recent au
// moment ou il s'affiche passait de 2,0 s (a la sortie du moteur) a 7 puis
// 9,5 s a l'ecran, et il GRANDISSAIT. Avec la borne, il colle a la mesure du
// moteur.
//
// 12 mots, c'est a peu pres une ligne : on anime ce qui arrive, jamais ce qui
// est deja lu.
const RETARD_MAX_MOTS = 12;

function decouperEnMots(texte) {
  return String(texte || "").trim().split(/\s+/).filter(Boolean);
}

// Deux mots sont-ils LE MEME mot ?
//
// On compare des formes normalisees -- minuscules, sans accents ni ponctuation
// -- et pas les chaines brutes. Sans ca, la moindre virgule ajoutee d'une passe
// a l'autre ferait croire a un mot different.
//
// ⚠️ CE N'EST PAS UNE PRECAUTION THEORIQUE, c'est un defaut mesure au banc.
// La toute premiere passe rend « bonjour. » (Whisper ponctue la fin de ce qu'il
// entend) ; la suivante, ce mot n'est plus le dernier et devient « bonjour ».
// En comparaison brute les deux differaient, alignerSurAffiche renvoyait 0, et
// l'ecran SE VIDAIT ENTIEREMENT avant de re-ecrire la phrase -- exactement
// l'effet de saut qu'on veut supprimer. Mesure : ecran vide a 1,51 s sur un run
// de 15 s.
//
// C'est la meme regle que `prefixeCommun` cote offscreen, et pour la meme
// raison : on COMPARE normalise, on AFFICHE le mot d'origine, ponctuation
// comprise.
function memeMot(a, b) {
  return normaliserMot(a) === normaliserMot(b);
}

function normaliserMot(mot) {
  return String(mot)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")            // accents
    .replace(/[^\p{L}\p{N}]/gu, "");   // ponctuation, tirets, apostrophes...
}

// Combien de mots de la nouvelle cible sont DEJA a l'ecran ?
//
// On ne peut pas simplement garder le compte, pour DEUX raisons :
//   - le ruban est rogne par la GAUCHE quand il depasse sa longueur maximale
//     (cote offscreen), donc les mots deja affiches glissent vers le debut ;
//   - la FIN du texte est provisoire par nature : la passe suivante a le droit
//     de la corriger. « Je ne me » devient « Je n'aime pas, je déteste. »
//
// On cherche donc le plus long PREFIXE COMMUN entre ce qui est affiche et la
// nouvelle cible, en essayant tous les decalages a gauche. Ce prefixe est deja
// bon a l'ecran ; seul ce qui suit doit etre revele.
//
// ⚠️ La version precedente exigeait que TOUT l'affiche soit un prefixe de la
// cible. Des que le provisoire changeait d'un mot -- c'est-a-dire presque a
// chaque passe -- elle renvoyait 0 et l'affichage repartait de zero. Mesure :
// « 0 déjà à l'écran » sur chacun des 12 messages d'un run, soit une ligne qui
// se ré-ecrivait entierement toutes les 2 secondes au lieu de s'allonger.
function alignerSurAffiche(affiches, cible) {
  let meilleur = 0;
  for (let k = 0; k < affiches.length; k++) {
    let i = 0;
    while (i < affiches.length - k && i < cible.length && memeMot(affiches[k + i], cible[i])) i++;
    if (i > meilleur) meilleur = i;
  }
  return Math.min(meilleur, cible.length);
}

// Ecrit a l'ecran ce qui doit y etre, et fait couler le texte.
//
// C'est ici que se produit le defilement : quand le texte depasse les deux
// lignes, on le remonte d'exactement ce qui deborde. Le debut sort par le haut
// et disparait ; la derniere ligne reste collee en bas.
function rendre() {
  ligne.textContent = motsCible.slice(0, nbAffiches).join(" ");
  const debordement = Math.max(0, ligne.scrollHeight - zone.clientHeight);
  ligne.style.transform = debordement ? `translateY(${-debordement}px)` : "";
}

function planifierRevelation() {
  if (minuterie || nbAffiches >= motsCible.length) return;

  minuterie = setInterval(() => {
    if (nbAffiches >= motsCible.length) {
      clearInterval(minuterie);
      minuterie = null;

      // Le mot le plus recent vient d'apparaitre : c'est MAINTENANT qu'on peut
      // mesurer son age. C'est ce chiffre qui doit rester stable dans le temps
      // -- s'il grandit, c'est que l'affichage prend du retard sur la parole.
      if (finAudioCible) {
        const age = ((Date.now() - finAudioCible) / 1000).toFixed(1);
        console.log(`📝 Mot le plus récent affiché ${age} s après avoir été prononcé`);
      }
      return;
    }
    nbAffiches++;
    rendre();
  }, PAS_REVELATION);
}

// Reception du flux : ruban (stable) + provisoire (fin incertaine).
//
// Le ruban ne s'efface JAMAIS. Entre deux phrases, il n'arrive simplement plus
// rien de nouveau et le dernier texte reste affiche.
function afficherFlux(ruban, provisoire, finAudio) {
  const nouveau = decouperEnMots(`${ruban || ""} ${provisoire || ""}`);
  if (!nouveau.length) return;

  // ⚠️ Une revelation en retard n'a pas le droit de retarder la suivante. Si
  // des mots arrivent alors que les precedents ne sont pas tous apparus, on
  // affiche tout le retard d'un coup et on repart de la. L'affichage ne doit
  // JAMAIS prendre du retard sur la parole -- mieux vaut un a-coup qu'un texte
  // qui traine trois secondes derriere la voix.
  if (nbAffiches < motsCible.length) nbAffiches = motsCible.length;

  const dejaAffiches = motsCible.slice(0, nbAffiches);
  motsCible = nouveau;
  nbAffiches = alignerSurAffiche(dejaAffiches, motsCible);

  // Jamais plus de RETARD_MAX_MOTS a reveler : le reste apparait d'un coup.
  // C'est ce qui empeche l'affichage de traîner derriere la parole.
  nbAffiches = Math.max(nbAffiches, motsCible.length - RETARD_MAX_MOTS);

  finAudioCible = finAudio || null;

  // Trace d'arrivee, distincte de la trace d'affichage plus bas. Les deux
  // ensemble disent OU le temps passe : entre le micro et ce message (le
  // moteur), ou entre ce message et l'ecran (la revelation).
  console.log(
    `📥 Flux reçu : ${motsCible.length} mots (${nbAffiches} déjà à l'écran, ` +
      `${motsCible.length - nbAffiches} à révéler), son vieux de ` +
      `${finAudio ? ((Date.now() - finAudio) / 1000).toFixed(1) : "?"} s`
  );

  premierTexteAffiche = true;
  subtitleBox.style.opacity = "1";
  subtitleBox.style.fontStyle = "normal";

  rendre();
  planifierRevelation();
}

// Message d'etat (chargement du modele, calibration...).
//
// Volontairement attenue -- plus pale et en italique -- pour qu'on voie d'un
// coup d'oeil que ce n'est pas de la parole transcrite.
function afficherStatut(texte) {
  if (!texte) return;

  // Un statut n'ecrase JAMAIS du vrai texte.
  if (premierTexteAffiche) {
    console.log("ℹ️ Statut ignore (du texte est deja affiche) :", texte);
    return;
  }

  ligne.textContent = texte;
  ligne.style.transform = "";
  subtitleBox.style.opacity = "0.75";
  subtitleBox.style.fontStyle = "italic";
  console.log("💬 Statut affiche :", texte);
}

// Afficher/cacher l'overlay.
function toggleOverlay(show) {
  if (show) {
    // Nouvelle capture : le ruban de la precedente n'a rien a faire ici.
    if (minuterie) {
      clearInterval(minuterie);
      minuterie = null;
    }
    motsCible = [];
    nbAffiches = 0;
    finAudioCible = null;
    premierTexteAffiche = false;

    subtitleBox.style.display = "block";
    subtitleBox.style.opacity = "1";
    subtitleBox.style.fontStyle = "normal";
    ligne.style.transform = "";
    ligne.textContent = "🎬 Ecoute du son en cours...";
    console.log("✅ Overlay AFFICHE sur la page");
  } else {
    subtitleBox.style.display = "none";
    if (minuterie) {
      clearInterval(minuterie);
      minuterie = null;
    }
    console.log("⏸️ Overlay CACHE sur la page");
  }
}

// Écouter les messages du service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "TOGGLE_SUBTITLES") {
    toggleOverlay(request.active);
    sendResponse({ success: true });
  }

  if (request.type === "FLUX") {
    afficherFlux(request.ruban, request.provisoire, request.finAudio);
    sendResponse({ success: true });
  }

  if (request.type === "STATUT") {
    afficherStatut(request.texte);
    sendResponse({ success: true });
  }
});

// Par défaut, l'overlay est caché
toggleOverlay(false);
