console.log("LiveSub charge sur cette page !");

// ===========================================================================
// INTERRUPTEUR DE COMPARAISON — mode « preparer d'abord » UNIQUEMENT
// ===========================================================================
//
// Deux facons d'afficher un stock DEJA prepare, et une seule sera gardee :
//
//   "blocs" — des PHRASES ENTIERES qui se remplacent l'une l'autre, comme les
//             sous-titres d'un film. Un bloc apparait a l'instant de son
//             PREMIER mot et reste jusqu'a l'arrivee du suivant. On lit donc la
//             fin de la phrase un peu AVANT de l'entendre : c'est voulu, c'est
//             ce qui laisse le temps de lire.
//
//   "mots"  — l'ancien : chaque mot sort a l'instant exact ou il a ete
//             prononce. Parfaitement synchrone, mais fatigant a lire, et le
//             moindre a-coup se voit.
//
// ⚠️ Volontairement PAS un reglage de la popup. Une option est souvent une
// decision qu'on n'a pas prise : on compare a l'oeil, on tranche, et on
// supprime le perdant.
//
// ⚠️ Le mode DIRECT n'est pas concerne, et ne peut pas l'etre : grouper en
// phrases suppose de connaitre l'heure du mot qui SUIT, donc d'avoir le texte
// d'avance. Le direct court apres la parole, il ne l'a jamais.
const PREP_LECT_STYLE = "blocs"; // "blocs" | "mots"

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
//   3. les mots sortent UN PAR UN, chacun A L'HEURE OU IL A ETE PRONONCE (voir
//      « L'horloge des mots » plus bas) : sinon cinq mots apparaissent d'un
//      bloc et l'effet direct disparait.

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
// La boîte apparaît et disparaît en FONDU, jamais d'un coup.
//
// ⚠️ Ce n'est pas de la décoration. Le mode « préparer d'abord » efface la boîte
// dès qu'un sous-titre a fait son temps sans que le suivant soit là (voir
// BLOC_APRES_PAROLE) : sans fondu, cette absence se lit comme un plantage —
// « l'overlay disparaît soudainement et réapparaît soudainement ». Avec un
// fondu de 220 ms, elle se lit pour ce qu'elle est : il n'y a rien à dire ici.
subtitleBox.style.transition = "opacity 220ms ease";
// Une boîte fixée par-dessus la page ne doit jamais intercepter un clic destiné
// au lecteur qui est dessous.
subtitleBox.style.pointerEvents = "none";

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

// Le texte affiche : une liste de { mot }, et combien en sont deja sortis.
// C'est la boucle de lecture de la preparation qui les remplit (voir
// prepLectRendre) ; `rendre()` ne fait que les ecrire a l'ecran.
//
// ⚠️ Le champ `instant` a disparu de cette liste avec l'horloge des mots : en
// preparation, l'heure d'un mot est lue directement dans le stock, et c'est
// `currentTime` de la video qui decide -- pas une minuterie.
let motsCible = [];
let nbVisibles = 0;

// ⚠️ CE QUI A DISPARU ICI (etape 5, retrait du mode direct) :
//
//   - les deux modes d'affichage « stable seulement » / « avec la fin
//     provisoire » : ils decrivaient LocalAgreement-2, qui n'existe plus ;
//   - l'horloge des mots et le retard d'affichage OBSERVE : ils compensaient
//     la latence du direct (un mot prononce a T n'existait en texte qu'a
//     T + 2 a 6 s). En preparation, le texte est deja la AVANT la lecture :
//     il n'y a rien a compenser, c'est `currentTime` qui commande ;
//   - la reception du FLUX (ruban + provisoire), le decoupage en mots,
//     l'alignement sur l'affiche et le remplissage des instants manquants.
//
// Ce qui RESTE de l'affichage est ce dont la preparation se sert vraiment :
// la boite, `motsCible` / `nbVisibles`, `rendre()` et `afficherStatut()`.

// Ecrit a l'ecran ce qui doit y etre, et fait couler le texte.
//
// C'est ici que se produit le defilement : quand le texte depasse les deux
// lignes, on le remonte d'exactement ce qui deborde. Le debut sort par le haut
// et disparait ; la derniere ligne reste collee en bas.
function rendre() {
  ligne.textContent = motsCible
    .slice(0, nbVisibles)
    .map((m) => m.mot)
    .join(" ");
  const debordement = Math.max(0, ligne.scrollHeight - zone.clientHeight);
  ligne.style.transform = debordement ? `translateY(${-debordement}px)` : "";
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
//
// ⚠️ Il ne remet plus a zero les reperes de l'horloge des mots : ils sont
// partis avec le mode direct a l'etape 5.
function toggleOverlay(show) {
  if (show) {
    motsCible = [];
    nbVisibles = 0;
    premierTexteAffiche = false;

    subtitleBox.style.display = "block";
    subtitleBox.style.opacity = "1";
    subtitleBox.style.fontStyle = "normal";
    ligne.style.transform = "";
    ligne.textContent = "🎬 Ecoute du son en cours...";
    console.log("✅ Overlay AFFICHE sur la page");
  } else {
    subtitleBox.style.display = "none";
    console.log("⏸️ Overlay CACHE sur la page");
  }
}

// Par défaut, l'overlay est caché
toggleOverlay(false);


// ===========================================================================
// MODE « PREPARER D'ABORD » — etape A : piloter le lecteur de la page
// ===========================================================================
//
// C'est desormais le seul mode. Ce qui suit pilote le LECTEUR de la page : ces deux
// affichages ne tournent jamais en meme temps, et s'ils se croisaient ils ne
// se marcheraient pas dessus. Tout ce qui appartient a la preparation porte le
// prefixe `prep`.
//
// Ce fichier est le seul a pouvoir toucher la <video> : ni le service worker ni
// le document offscreen n'ont acces au DOM de la page.
//
// ⚠️ Le contrat le plus important est celui de la RESTAURATION : on emprunte le
// lecteur de quelqu'un d'autre. Position, vitesse, conservation de la hauteur
// et etat de pause sont releves AVANT, et remis APRES, quoi qu'il arrive --
// y compris si la preparation echoue en cours de route.

const PREP_PAS_TICK = 500;      // rafraichissement de la progression
const PREP_MARGE_FIN = 0.35;    // a moins de ca de la fin, on considere fini
const PREP_RECALAGES_MAX = 3;   // combien de fois on re-impose la vitesse

let prepVideo = null;
let prepAvant = null;      // { position, vitesse, hauteur, enPause }
let prepVitesseCible = 2;
let prepTick = null;
let prepEnCours = false;
let prepFinSignalee = false;
let prepRecalages = 0;
let prepPositionMax = 0;   // la progression ne recule JAMAIS
let prepVeille = null;     // filet de securite de la restauration

// Combien de temps on accepte d'attendre l'ordre de restauration avant de
// rendre le lecteur de nous-memes.
//
// ⚠️ CE FILET EXISTE PARCE QUE LE CAS S'EST PRODUIT. Un blocage cote offscreen
// a empeche le service worker d'envoyer PREPARATION_RESTAURER : la video est
// restee a x2, sur la page de l'utilisateur, sans le moindre message. On
// emprunte le lecteur de quelqu'un d'autre -- le rendre ne doit dependre de
// personne d'autre que nous.
const PREP_VEILLE_MS = 60000;

// Au-dela de ca sans que la position avance alors que la lecture est censee
// tourner, on considere le lecteur perdu.
const PREP_ENLISEMENT_MS = 20000;
let prepDerniereProgression = { position: -1, quand: 0 };

function prepFormaterDuree(secondes) {
  if (!Number.isFinite(secondes) || secondes < 0) return "?";
  const total = Math.round(secondes);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  if (min === 0) return `${sec} s`;
  return `${min} min ${String(sec).padStart(2, "0")} s`;
}

// L'overlay de la preparation. Il utilise la meme boite que les sous-titres
// mais n'appelle PAS afficherStatut : celui-la a sa propre regle (« un statut
// n'ecrase jamais du vrai texte »), qui n'a rien a voir avec ce qu'on fait ici.
function prepAfficher(texte, discret) {
  // Le premier affichage normal qui suit un echec rend a la boite ses reglages
  // d'origine. Se reparer toute seule vaut mieux que compter sur un appel pose
  // au bon endroit : il y a plusieurs chemins pour recommencer une preparation.
  if (prepBoiteEnErreur) prepBoiteNormale();
  subtitleBox.style.display = "block";
  subtitleBox.style.opacity = discret ? "0.8" : "1";
  subtitleBox.style.fontStyle = discret ? "italic" : "normal";
  ligne.style.transform = "";
  ligne.textContent = texte;
}

// ---------------------------------------------------------------------------
// UN MESSAGE D'ECHEC N'EST JAMAIS COUPE
// ---------------------------------------------------------------------------
//
// ⚠️ CE QUI ARRIVAIT SANS CETTE FONCTION, VU A L'ECRAN LE 2026-08-30 (capture a
// l'appui) : `zone` fait deux lignes de hauteur FIXE avec `overflow: hidden`,
// donc l'overlay affichait
//
//     « ❌ La capture silencieuse a echoue : Parakeet n'a pas pu charger :
//       Can't create a session. ERROR_CODE: 2, ERROR_MESSAGE: No graph was »
//
// et s'arretait la. La fin du message etait sous la coupe, invisible. Un
// message qui doit dire ce qui manque, ou, et quoi faire ne tiendra JAMAIS en
// deux lignes de 24 px : le dire sans le montrer ne vaut rien.
//
// La boite s'agrandit donc pour ce cas-la, et pour lui seul :
//   - `prepAfficher` garde ses deux lignes fixes pour tout le reste (statuts,
//     progression, avertissements en cours de route) ;
//   - un echec n'est JAMAIS suivi de sous-titres -- la preparation s'est
//     arretee. La boite ne peut donc pas « sauter » pendant une lecture : il
//     n'y aura pas de lecture. L'acquis « la boite ne change pas de hauteur »
//     porte sur l'affichage du texte, et il est intact.
//
// `pre-line` rend les retours a la ligne du message : les trois choses a dire
// sont sur trois lignes, pas dans un mur de texte.
let prepBoiteEnErreur = false;

function prepAfficherErreur(texte) {
  prepBoiteEnErreur = true;
  subtitleBox.style.display = "block";
  subtitleBox.style.opacity = "1";
  subtitleBox.style.fontStyle = "normal";
  ligne.style.transform = "";
  ligne.style.whiteSpace = "pre-line";
  subtitleBox.style.fontSize = "19px";
  zone.style.height = "auto";
  zone.style.overflow = "visible";
  // La boite est rendue a ses reglages d'origine des qu'on reaffiche du texte
  // (voir prepBoiteNormale) ; le cache de hauteur est invalide pour que
  // `prepLectHauteur` reapplique la sienne au lieu de se croire deja bon.
  prepLectHauteurCourante = null;
  ligne.textContent = texte;
}

// Remet la boite exactement comme elle etait avant `prepAfficherErreur`.
// Appelee des qu'on recommence a afficher quoi que ce soit d'autre : sans elle,
// un echec suivi d'une preparation reussie laisserait les sous-titres en 19 px
// sur une boite sans hauteur fixe.
function prepBoiteNormale() {
  prepBoiteEnErreur = false;
  ligne.style.whiteSpace = "";
  subtitleBox.style.fontSize = "24px";
  zone.style.overflow = "hidden";
  zone.style.height = `${LIGNES_VISIBLES * HAUTEUR_LIGNE}em`;
  prepLectHauteurCourante = LIGNES_VISIBLES;
}

// La <video> a piloter.
//
// On prend la plus GRANDE de celles qui ont une duree : une page peut contenir
// des vignettes animees, des pubs, des lecteurs caches. La plus grande a
// l'ecran est celle que l'utilisateur regarde.
//
// ⚠️ content.js ne tourne que dans le cadre principal (pas de `all_frames` dans
// le manifeste) : une video dans une iframe est INVISIBLE d'ici. C'est une
// limite reelle, pas un oubli -- et elle donne un message clair plutot qu'un
// silence.
function prepTrouverVideo() {
  const candidates = Array.from(document.querySelectorAll("video"));
  if (!candidates.length) return null;

  const notee = candidates
    .map((v) => {
      const r = v.getBoundingClientRect();
      return { v, aire: Math.max(0, r.width) * Math.max(0, r.height), duree: v.duration };
    })
    // Une video sans duree connue n'est pas pilotable : on ne saurait ni ou on
    // en est ni quand s'arreter.
    .filter((c) => Number.isFinite(c.duree) && c.duree > 0)
    .sort((a, b) => b.aire - a.aire);

  return notee.length ? notee[0].v : null;
}

// La <video> COURANTE, re-resolue a chaque fois qu'on en a besoin.
//
// ⚠️ POURQUOI CETTE FONCTION EXISTE. La version precedente retenait l'element
// une bonne fois pour toutes dans `prepVideo`. Sur YouTube, ca a donne un
// blocage silencieux complet : le lecteur reconstruit sa source media en cours
// de route, et la reference gardee devenait un element mort -- `duration` a
// `null`, `readyState` a 0, position bloquee a 0. La progression se figeait,
// la fin n'etait jamais detectee, et la preparation ne s'arretait plus jamais
// (constate : 1176 s « couvertes » sur une video qui n'en compte que 1037).
//
// On re-resout donc, et on signale le remplacement au lieu de le subir.
let prepVideoRemplacements = 0;

function prepVideoResolue() {
  const memorisee = prepVideo;

  // L'element memorise est-il encore dans le document ET utilisable ?
  const utilisable =
    memorisee &&
    memorisee.isConnected &&
    Number.isFinite(memorisee.duration) &&
    memorisee.duration > 0;
  if (utilisable) return memorisee;

  const neuve = prepTrouverVideo();
  if (neuve && neuve !== memorisee) {
    // On ne compte un REMPLACEMENT que si on etait deja branche sur un element.
    // Le premier accrochage (memorisee = null, notamment apres la restauration
    // qui remet la reference a zero) n'en est pas un -- le compter fausserait
    // la seule preuve qu'on ait que la re-resolution sert a quelque chose.
    if (memorisee) {
      prepVideoRemplacements++;
      console.warn(
        `⚠️ LiveSub : la <video> a ete remplacee (${prepVideoRemplacements}), on se rebranche dessus`
      );
    }
    prepVideo = neuve;
    return neuve;
  }

  // Meme element, momentanement inutilisable (source en cours de
  // reconstruction). On le rend quand meme : c'est a l'appelant de decider
  // s'il attend ou s'il abandonne.
  return neuve || memorisee || null;
}

function prepDecrireVideo() {
  const v = prepTrouverVideo();
  if (!v) {
    return {
      success: false,
      erreur:
        "Aucune vidéo lisible sur cette page. " +
        "(Une vidéo dans un cadre intégré n'est pas visible depuis ici.)",
    };
  }
  return { success: true, position: v.currentTime, duree: v.duration };
}

// ---------------------------------------------------------------------------
// Piloter
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Piloter le lecteur, puis le remettre exactement comme on l'a trouve
// ---------------------------------------------------------------------------
//
// ⚠️ CE QUI A DISPARU ICI (etape 5) : le releve du VOCABULAIRE de la page.
// On lisait le titre, le nom de la chaine et les noms propres de la
// description pour les souffler a Whisper en amorce (decoder_input_ids) --
// il ecorchait les noms propres. Parakeet n'a pas d'equivalent, et le message
// PREPARATION_VOCABULAIRE n'a plus de destinataire : tout est parti, ici et
// dans offscreen.js.

async function prepPiloter(vitesse) {
  const v = prepTrouverVideo();
  if (!v) return prepDecrireVideo(); // renvoie le message d'erreur clair

  prepVideo = v;
  prepVitesseCible = vitesse || 2;
  prepRecalages = 0;
  prepFinSignalee = false;
  prepPositionMax = v.currentTime;

  // Ce qu'on emprunte, releve AVANT d'y toucher.
  prepAvant = {
    position: v.currentTime,
    vitesse: v.playbackRate,
    hauteur: v.preservesPitch !== undefined ? v.preservesPitch : null,
    enPause: v.paused,
  };
  console.log("📌 Preparation : etat du lecteur avant —", JSON.stringify(prepAvant));

  try {
    // preservesPitch = false : on veut un simple reechantillonnage, pas un
    // etirement temporel qui garderait la hauteur de voix. C'est ce qui rend le
    // son remontable a sa vitesse normale d'un seul coup, cote offscreen.
    v.preservesPitch = false;
    if ("webkitPreservesPitch" in v) v.webkitPreservesPitch = false;
    v.playbackRate = prepVitesseCible;
  } catch (err) {
    prepRestaurer();
    return {
      success: false,
      erreur: "Ce lecteur refuse de changer de vitesse : " + (err && err.message ? err.message : err),
    };
  }

  // Le changement a-t-il PRIS ? Certains lecteurs ignorent l'affectation, ou la
  // remettent a 1 aussitot. Un mode qui croit defiler a x2 alors qu'il defile a
  // x1 produirait un stock au son deux fois trop lent -- du charabia, sans la
  // moindre erreur.
  if (Math.abs(v.playbackRate - prepVitesseCible) > 0.01) {
    const obtenue = v.playbackRate;
    prepRestaurer();
    return {
      success: false,
      erreur: `Ce lecteur impose sa vitesse (x${obtenue} au lieu de x${prepVitesseCible})`,
    };
  }

  try {
    await v.play();
  } catch (err) {
    prepRestaurer();
    return {
      success: false,
      erreur: "La lecture n'a pas pu démarrer : " + (err && err.message ? err.message : err),
    };
  }

  // Une nouvelle preparation remplace la precedente : son affichage n'a plus
  // rien a dire sur cette video-ci.
  prepLectArreter();
  prepLectStock = [];
  prepLectZone = null;
  prepLectMesures = [];

  prepEnCours = true;
  prepDerniereProgression = { position: v.currentTime, quand: Date.now() };
  v.addEventListener("ended", prepSurFin);
  prepTick = setInterval(prepBattre, PREP_PAS_TICK);
  prepBattre();

  console.log(`▶️ Preparation : defilement a x${prepVitesseCible} depuis ${v.currentTime.toFixed(2)} s`);
  // ⚠️ DEUX positions, et elles ne servent pas a la meme chose.
  //   `position`       — celle d'AVANT qu'on touche au lecteur. C'est elle
  //                      qu'on rendra a l'utilisateur en restaurant.
  //   `positionDepart` — celle d'APRES `play()`, donc celle du premier son
  //                      reellement capte. C'est elle qui date le stock.
  // Les confondre datait tout le stock trop tot de ce que la video avance
  // pendant le demarrage du lecteur.
  return {
    success: true,
    position: prepAvant.position,
    positionDepart: v.currentTime,
    duree: v.duration,
  };
}

function prepBattre() {
  if (!prepEnCours) return;

  const precedente = prepVideo;
  const v = prepVideoResolue();
  if (!v) {
    prepAfficher("⚠️ La vidéo a disparu de la page. Préparation arrêtée.");
    prepSurFin();
    return;
  }

  // L'element a change sous nos pieds : il faut lui re-imposer le regime, sinon
  // on capterait du son a vitesse normale en croyant capter du x2.
  if (v !== precedente) {
    try {
      v.preservesPitch = false;
      if ("webkitPreservesPitch" in v) v.webkitPreservesPitch = false;
      v.playbackRate = prepVitesseCible;
      v.play().catch(() => {});
    } catch (err) {
      console.warn("⚠️ Preparation : nouvelle <video> non pilotable —", err);
    }
  }

  // ⚠️ DETECTEUR D'ENLISEMENT. Une video qui n'avance plus alors qu'elle n'est
  // pas en pause, c'est le symptome exact du lecteur demonte. Sans ce garde-fou
  // la preparation tourne indefiniment sur du silence.
  if (!v.paused && Math.abs(v.currentTime - prepDerniereProgression.position) > 0.05) {
    prepDerniereProgression = { position: v.currentTime, quand: Date.now() };
  } else if (!v.paused && Date.now() - prepDerniereProgression.quand > PREP_ENLISEMENT_MS) {
    prepAfficher("⚠️ La vidéo n'avance plus (lecteur rechargé ?). Préparation arrêtée.");
    console.warn("⚠️ Preparation : enlisement, position figee a", v.currentTime);
    prepSurFin();
    return;
  }

  // Garde-fou : le lecteur a-t-il repris la main sur la vitesse ? On la
  // re-impose, mais pas indefiniment -- au bout de PREP_RECALAGES_MAX on le
  // DIT, au lieu de lutter en silence contre la page.
  if (Math.abs(v.playbackRate - prepVitesseCible) > 0.01) {
    if (prepRecalages < PREP_RECALAGES_MAX) {
      prepRecalages++;
      v.preservesPitch = false;
      v.playbackRate = prepVitesseCible;
      console.warn(`⚠️ Preparation : vitesse remise a x${prepVitesseCible} (${prepRecalages})`);
    } else {
      prepAfficher(
        `⚠️ Le lecteur reprend la main sur la vitesse (x${v.playbackRate}). Préparation arrêtée.`
      );
      prepSurFin();
      return;
    }
  }

  // ⚠️ LA POSITION PART A CHAQUE BATTEMENT, ET C'EST CE QUI DATE LES MOTS.
  //
  // `offscreen.js` ne voit que du son : sans ce message il en deduit l'heure de
  // chaque mot en supposant que la video avance d'exactement deux secondes par
  // seconde d'horloge. Un rechargement de tampon, une publicite, un lecteur qui
  // reprend une seconde la main sur la vitesse, et l'ecart s'ajoute pour de bon
  // a tout ce qui suit. Ici on lui donne la seule chose qu'il ne peut pas
  // deviner : ou en est REELLEMENT la video (voir prepAncres).
  chrome.runtime
    .sendMessage({ type: "PREPARATION_POSITION", position: v.currentTime })
    .catch(() => {});

  // Progression : en temps de VIDEO, et jamais en arriere.
  if (v.currentTime > prepPositionMax) prepPositionMax = v.currentTime;
  const fait = prepPositionMax - prepAvant.position;
  const total = Number.isFinite(v.duration) ? v.duration - prepAvant.position : null;

  prepAfficher(
    total
      ? `⏳ Préparation… ${prepFormaterDuree(fait)} sur ${prepFormaterDuree(total)}`
      : `⏳ Préparation… ${prepFormaterDuree(fait)}`,
    true
  );

  const finie =
    v.ended ||
    (Number.isFinite(v.duration) && v.currentTime >= v.duration - PREP_MARGE_FIN);
  if (finie) prepSurFin();
}

// Fin du defilement : on met le lecteur en PAUSE tout de suite (plus aucun son
// ne part vers la capture), puis on previent le service worker. C'est lui qui
// fera vider la file de transcription avant de nous demander de restaurer :
// restaurer maintenant renverrait la video au debut, en x1, pendant que
// l'offscreen enregistre encore.
function prepSurFin() {
  if (!prepEnCours || prepFinSignalee) return;
  prepFinSignalee = true;
  prepEnCours = false;

  if (prepTick) {
    clearInterval(prepTick);
    prepTick = null;
  }
  try {
    prepVideo.removeEventListener("ended", prepSurFin);
    prepVideo.pause();
  } catch (err) {
    /* le lecteur a pu disparaitre entre-temps */
  }

  prepAfficher("⏳ Préparation… derniers mots en cours de transcription", true);
  chrome.runtime.sendMessage({ type: "PREPARATION_FIN" }).catch(() => {});

  // Si l'ordre de restauration n'arrive pas, on rend le lecteur quand meme.
  if (prepVeille) clearTimeout(prepVeille);
  prepVeille = setTimeout(async () => {
    prepVeille = null;
    if (!prepVideo) return; // deja restaure, tout va bien
    console.warn("⚠️ Preparation : aucun ordre de restauration, on rend le lecteur");
    await prepRestaurer();
    prepAfficher("⚠️ Préparation interrompue — le lecteur a été remis en état");
  }, PREP_VEILLE_MS);
}

// ---------------------------------------------------------------------------
// Restaurer — le contrat
// ---------------------------------------------------------------------------

async function prepRestaurer() {
  if (!prepVideo || !prepAvant) return null;

  // On rend l'element COURANT : si le lecteur a ete reconstruit pendant la
  // preparation, c'est lui qu'il faut remettre en etat, pas la reference morte.
  const v = prepVideoResolue() || prepVideo;
  const avant = prepAvant;
  if (!v) return null;

  if (prepVeille) {
    clearTimeout(prepVeille);
    prepVeille = null;
  }
  prepEnCours = false;
  if (prepTick) {
    clearInterval(prepTick);
    prepTick = null;
  }
  try {
    v.removeEventListener("ended", prepSurFin);
  } catch (err) {
    /* deja retire */
  }

  try {
    v.playbackRate = avant.vitesse;
    if (avant.hauteur !== null) v.preservesPitch = avant.hauteur;
    v.currentTime = avant.position;
  } catch (err) {
    console.warn("⚠️ Preparation : restauration partielle —", err);
  }

  // Attendre que le saut ait vraiment eu lieu : `currentTime` relu juste apres
  // l'affectation rend encore l'ancienne valeur. Sans cette attente, la preuve
  // « la video est bien revenue » serait fausse alors que le code est juste.
  await new Promise((resoudre) => {
    let fini = false;
    const fin = () => {
      if (fini) return;
      fini = true;
      v.removeEventListener("seeked", fin);
      resoudre();
    };
    v.addEventListener("seeked", fin);
    setTimeout(fin, 1500); // un flux peut ne jamais confirmer le saut
  });

  try {
    if (avant.enPause) v.pause();
    else v.play().catch(() => {});
  } catch (err) {
    /* rien de plus a faire */
  }

  const apres = {
    position: v.currentTime,
    vitesse: v.playbackRate,
    hauteur: v.preservesPitch !== undefined ? v.preservesPitch : null,
    enPause: v.paused,
  };
  console.log("📌 Preparation : etat du lecteur apres —", JSON.stringify(apres));

  prepVideo = null;
  prepAvant = null;
  return { avant, apres };
}

// ---------------------------------------------------------------------------
// Messages — un listener A PART
// ---------------------------------------------------------------------------
//
// Un second addListener plutot que des branches ajoutees dans le premier : le
// listener du mode direct n'est pas touche d'une ligne.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "PREPARATION_VERIFIER") {
    sendResponse(prepDecrireVideo());
    return;
  }

  if (request.type === "PREPARATION_PILOTER") {
    prepPiloter(request.vitesse)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ success: false, erreur: String((err && err.message) || err) })
      );
    return true;
  }

  if (request.type === "PREPARATION_STATUT") {
    // Un statut ne doit jamais recouvrir la progression, qui est plus utile.
    if (!prepEnCours) prepAfficher(request.texte, true);
    return;
  }

  if (request.type === "PREPARATION_RESTAURER") {
    prepRestaurer()
      .then((etats) => {
        const r = request.resume;
        if (request.erreur) {
          // ⚠️ `prepAfficherErreur`, pas `prepAfficher` : un message d'echec doit
          // etre lu EN ENTIER. Avec `prepAfficher` il etait coupe au bout de deux
          // lignes -- et c'est justement la fin d'un message d'echec (« voici
          // quoi faire ») qui compte le plus.
          prepAfficherErreur("❌ " + request.erreur);
        } else if (r && typeof r.nbMots === "number") {
          prepAfficher(
            `✅ Prêt — ${r.nbMots} mots préparés, ${prepFormaterDuree(r.dureeCouverteS)} couvertes`
          );
          // Le stock est complet et la video est revenue a sa place : on passe
          // a l'affichage. Rien ne bouge tant que l'utilisateur ne lance pas la
          // lecture -- c'est `currentTime` qui commande, pas une minuterie.
          if (r.nbMots > 0) prepLectCharger(r);
        } else {
          prepAfficher("⏹️ Préparation arrêtée");
        }
        sendResponse({ success: true, etats });
      })
      .catch((err) =>
        sendResponse({ success: false, erreur: String((err && err.message) || err) })
      );
    return true;
  }
});



// ===========================================================================
// MODE « PREPARER D'ABORD » — etape B : afficher le stock pendant la lecture
// ===========================================================================
//
// Ici, et c'est TOUTE la difference avec le mode direct : on connait deja
// l'heure exacte de chaque mot, et on connait a chaque instant ou en est la
// video. Il n'y a donc plus rien a estimer.
//
// Le mode direct doit inventer un retard parce qu'il court apres la parole : il
// observe le percentile 90 des vingt derniers lots, ajoute une marge, et se
// borne a un plafond. Tout cet appareillage n'avait qu'un but -- compenser le fait
// qu'on ne sait pas quand un mot a ete prononce.
//
// Ici on le sait. La regle tient donc en une ligne :
//
//     un mot est affiche des que video.currentTime atteint son instant.
//
// Pas de p90, pas de plafond, pas de file a etaler, pas de PAS_REVELATION. Et
// comme le repere est la position de la VIDEO et non l'horloge murale, tout ce
// que fait l'utilisateur est gere sans un cas particulier : mettre en pause
// arrete currentTime donc arrete le texte, sauter en avant fait bondir
// currentTime donc fait bondir le texte, revenir en arriere le fait reculer.

// Combien de mots on garde dans le ruban. La boite ne montre que deux lignes ;
// au-dela on paierait un `scrollHeight` sur des milliers de mots a chaque
// image, pour afficher exactement la meme chose.
const PREP_LECT_FENETRE = 40;

// UNE seule ligne pendant la lecture -- en mode « mots » UNIQUEMENT.
//
// ⚠️ Le mode « blocs » garde les DEUX lignes (LIGNES_VISIBLES) et n'y touche
// jamais : un bloc n'est pas un ruban qui coule, c'est une phrase entiere, et il
// lui faut la place de tenir. Comme les messages d'etat sont eux aussi sur deux
// lignes, la boite ne change alors PLUS JAMAIS de hauteur, du debut a la fin.
//
// Le mode direct en montre deux, et il a ses raisons : il ne sait pas quand un
// mot a ete prononce, donc il lache des paquets de mots, et la ligne du dessus
// laisse le temps de finir de lire ce qui vient de passer.
//
// Ici, rien de tout ca : chaque mot sort a son heure, au rythme de la parole.
// La ligne du dessus ne montre plus que la phrase deja entendue -- elle occupe
// l'ecran sans rien apporter. On garde donc le ruban qui coule, mais sur une
// seule ligne.
//
// ⚠️ `zone` est PARTAGEE avec le mode direct : on modifie sa hauteur a chaud, et
// il est donc obligatoire de la remettre a deux lignes en s'arretant. Sans ca,
// le direct se retrouverait avec un affichage sur une ligne sans qu'une seule
// de ses lignes de code ait change -- le genre de regression qu'on ne relie
// jamais a sa cause.
const PREP_LECT_LIGNES = 1;

// Les messages d'etat (« au-dela de la preparation », « Pret — N mots… ») sont
// plus longs qu'un bout de phrase : sur une seule ligne ils seraient coupes.
// La boite reprend donc ses deux lignes le temps de les afficher.
let prepLectHauteurCourante = null;

function prepLectHauteur(lignes) {
  if (prepLectHauteurCourante === lignes) return;
  prepLectHauteurCourante = lignes;
  zone.style.height = `${lignes * HAUTEUR_LIGNE}em`;
}

// Tolerance autour de la zone preparee, en secondes.
const PREP_LECT_MARGE_ZONE = 1.0;

// Au-dela de cet ecart entre la position attendue et la position reelle, c'est
// que l'utilisateur a saute. Les mots reveles a ce moment-la ne sont pas des
// revelations « a l'heure » : les compter fausserait la mesure.
const PREP_LECT_SAUT_S = 0.35;

let prepLectStock = [];           // [{ mot, instant }], instants croissants
let prepLectZone = null;          // { debut, fin } en secondes de video
let prepLectResume = "";          // le texte « Pret — N mots… »
let prepLectActif = false;
let prepLectRaf = null;
let prepLectMinuterie = null;

// Pas de la minuterie de secours, en ms. Voir prepLectDemarrer : c'est elle qui
// empeche l'affichage de se figer quand les images de la page s'arretent.
const PREP_LECT_PAS_MS = 20;
let prepLectVisibles = -1;        // dernier nombre de mots dus (pour ne rendre que si ca change)
let prepLectEtatAffiche = "";     // pour ne pas reecrire le meme message a 60 Hz

// Suivi de la position, pour distinguer une lecture continue d'un saut.
let prepLectDernierTick = 0;
let prepLectDernierePosition = 0;

// --- Mode « blocs » : des phrases entieres qui se remplacent ---------------
//
// Le decoupage est fait UNE SEULE FOIS, au chargement du stock
// (prepBlocsDepuisMots). Pendant la lecture il ne reste plus qu'a lire l'heure :
// le bloc en vigueur est le dernier dont le premier mot est deja passe. Rien a
// rattraper, rien a etaler -- chaque bloc a son heure exacte, il n'y a qu'a la
// respecter.
//
// Les bornes ne sont pas des gouts, elles viennent de ce qu'on demande a l'ecran :
//
//   PONCT_FORTE  — une phrase finie est une unite de lecture. On coupe la.
//   PONCT_FAIBLE — une virgule ne coupe QUE si le bloc est deja long, sinon on
//                  hacherait « Bonjour, tout le monde » en deux miettes.
//   MOTS / SPAN  — au-dela, le bloc ne tient plus sur deux lignes, ou il couvre
//                  trop de parole pour rester en face de l'image.
//   DUREE_MIN    — un bloc qui reste moins de 1,5 s a l'ecran n'est pas lisible.
//                  On le FUSIONNE avec le suivant plutot que de le faire
//                  clignoter. Cette regle gagne sur MOTS et SPAN.
//   *_ABSOLU     — le seul garde-fou qui gagne sur DUREE_MIN. La boite est en
//                  « overflow: hidden » : un bloc qui deborde n'est pas mal
//                  affiche, il est INVISIBLE. Un texte court est moins grave
//                  qu'un texte qu'on ne voit pas.
//
// ⚠️ SPAN et DUREE ne sont PAS la meme chose, et les confondre donne des bornes
// fausses. Le « span » est la parole couverte (premier mot -> dernier mot) ;
// la « duree » est le temps a l'ecran (premier mot -> premier mot du suivant).
// Un silence de 8 s apres une phrase courte fait une duree de 8 s pour un span
// de 1 s -- et c'est le bon comportement : le bloc doit rester, sinon l'ecran se
// viderait pendant le silence.
// ⚠️ COMBIEN DE TEMPS APRES SON DERNIER MOT UN BLOC RESTE-T-IL ?
//
// La regle d'origine etait « il disparait quand le suivant arrive ». Elle
// suppose que le stock couvre toute la parole. Il ne la couvre pas : mesure du
// 2026-08-28, decoupage de production, 37 % de la parole n'a AUCUN mot dans le
// stock -- une fenetre de preparation sur trois s'effondre et ne rend que 8 mots
// la ou les autres en rendent 26.
//
// Consequence a l'ecran : le bloc precedent restait seul pendant tout le trou.
// Mesure : jusqu'a 13,5 s. Ca ne ressemble pas a un trou, ca ressemble a une
// application qui s'est bloquee -- et c'est exactement ce qui a ete rapporte.
//
// Un sous-titre reste donc au plus BLOC_APRES_PAROLE apres son DERNIER mot,
// puis la boite s'efface jusqu'au bloc suivant. Un ecran vide pendant qu'on
// parle est un aveu, et c'est ce qu'on veut : il dit « il n'y a rien ici »
// au lieu de laisser croire que la phrase affichee est celle qu'on entend.
//
// ⚠️ Sur du texte normal cette borne ne mord pas : un bloc couvre au plus
// BLOC_SPAN_MAX de parole et le suivant arrive avant. Mesure sur la piste
// propre : mediane 4,3 s a l'ecran, maximum 6,1 s. Elle ne se declenche que sur
// les vrais trous.
//
// Pour revenir au comportement d'origine -- un bloc qui reste jusqu'au suivant,
// quoi qu'il arrive -- mettre cette constante a Infinity.
// 3,0 et plus 1,5 depuis le 2026-08-28. 1,5 s avait ete choisi contre des trous
// de 13,5 s dans le stock -- des trous dus au plafond de jetons de Whisper, qui
// coupait le francais au bout de 13 s de bloc. Ce moteur est parti a l'etape 5
// et son plafond avec ; les trous restants sont ceux de la vraie
// parole : des respirations et des silences courts. Les couvrir vaut mieux que
// de clignoter dessus. Au-dela de 3 s, la boite s'efface toujours -- en fondu.
const BLOC_APRES_PAROLE = 3.0;

const BLOC_MOTS_MAX = 10;
const BLOC_SPAN_MAX = 5.0;        // secondes de parole couvertes
const BLOC_DUREE_MIN = 1.5;       // secondes a l'ecran
const BLOC_CARACTERES_MAX = 84;   // ~42 par ligne, sur deux lignes
const BLOC_VIRGULE_MOTS = 6;
const BLOC_VIRGULE_S = 2.5;
const BLOC_MOTS_ABSOLU = 14;
// 88 et pas 104 : MESURE dans Chrome le 2026-08-27, boite de 800 px, 24 px gras.
// 58 caracteres tiennent sur UNE ligne ; 85 remplissent les deux EXACTEMENT
// (scrollHeight 65 px pour une zone de 65 px, zero debordement). Laisser 104
// autorisait donc une fusion qui deborde -- c'est-a-dire du texte invisible.
// Sur une fenetre plus etroite la boite retrecit et 85 peut redevenir trop :
// c'est prepBlocRendre qui le voit alors, le compte et le dit dans la console.
const BLOC_CARACTERES_ABSOLU = 88;

// La ponctuation, lue caractere par caractere plutot qu'en expression
// reguliere : « il a dit "bonjour." » se termine par un guillemet, pas par un
// point, et le point est bien la fin de phrase. On saute donc une eventuelle
// fermeture avant de regarder le signe.
const BLOC_FERMETURES = ['"', '»', ')', ']'];
const BLOC_FORTE = '.!?…';
const BLOC_FAIBLE = ',;:';

function blocFinitPar(mot, signes) {
  let i = mot.length - 1;
  if (i >= 0 && BLOC_FERMETURES.indexOf(mot.charAt(i)) !== -1) i--;
  return i >= 0 && signes.indexOf(mot.charAt(i)) !== -1;
}

let prepLectBlocs = [];        // [{ instant, fin, texte, nbMots }]
let prepLectBlocCourant = -2;  // -2 = rien rendu encore, -1 = avant le premier bloc
let prepBlocDebordements = 0;

// Mesures propres au mode blocs (criteres 1 et 3).
let prepBlocEcarts = [];       // ms entre l'instant du premier mot et l'apparition
let prepBlocDurees = [];       // ms reellement passes a l'ecran, lecture continue
let prepBlocApparuA = null;    // position video a laquelle le bloc courant est apparu

// --- Mesure (criteres 1 et 2) ----------------------------------------------
//
// Pour chaque mot revele en lecture CONTINUE, on note l'ecart entre la position
// de la video au moment ou il apparait et l'instant ou il a ete prononce.
// C'est exactement « un mot prononce a T apparait a quel instant ».
let prepLectMesures = [];
let prepLectMesuresMax = 400;

// ⚠️ DECALAGE DE TEST, ET RIEN D'AUTRE. Il sert a la contre-preuve : si on
// decale tous les instants de +3 s et que l'ecart mesure ne monte pas de 3 s,
// c'est que la mesure ne mesure rien. Il vaut toujours 0 en usage normal, il
// n'est expose par aucun reglage, et il ne s'active que par un message envoye
// a la main depuis la console.
let prepLectDecalageTestMs = 0;

function prepLectInstantAffichage(i) {
  return prepLectStock[i].instant + prepLectDecalageTestMs / 1000;
}

// Combien de mots ont atteint leur heure a la position `t` ?
// Les instants sont croissants, donc les mots dus forment un prefixe : une
// recherche dichotomique suffit, et elle reste gratuite sur 2500 mots a 60 Hz.
function prepLectCombien(t) {
  let bas = 0;
  let haut = prepLectStock.length;
  while (bas < haut) {
    const milieu = (bas + haut) >> 1;
    if (prepLectInstantAffichage(milieu) <= t) bas = milieu + 1;
    else haut = milieu;
  }
  return bas;
}

// ---------------------------------------------------------------------------
// Mode « blocs » : du stock de mots a une liste de phrases
// ---------------------------------------------------------------------------
//
// Une seule passe, gloutonne. A chaque mot on se demande « est-ce que je coupe
// ICI ? », et l'ORDRE des questions EST la regle :
//
//   1. le garde-fou de la boite    (un bloc invisible est le pire des cas)
//   2. le plancher de lisibilite   (trop court : on fusionne, on ne coupe pas)
//   3. la ponctuation forte        (une phrase finie est une unite de lecture)
//   4. la virgule, si deja long    (respirer sans hacher)
//   5. les bornes hautes           (mots, parole couverte, caracteres)
//
// Le resultat porte l'heure d'apparition (`instant`, celle du PREMIER mot) et
// l'heure de disparition (`fin`, celle du premier mot du bloc SUIVANT). Il n'y
// a donc ni trou ni recouvrement : a tout instant de la zone preparee il y a
// exactement un bloc en vigueur, et un seul.
function prepBlocsDepuisMots(mots, finZone) {
  const blocs = [];
  if (!Array.isArray(mots) || !mots.length) return blocs;

  // La fin de la zone preparee borne le dernier bloc. Si elle tombe AVANT le
  // dernier mot (stock plus long que la zone annoncee), on la repousse : une
  // duree negative rendrait la mesure absurde et le dernier bloc invisible.
  const fin = Math.max(
    Number(finZone) || 0,
    mots[mots.length - 1].instant + BLOC_DUREE_MIN
  );
  const finDe = (i) => (i + 1 < mots.length ? mots[i + 1].instant : fin);

  let debut = 0;
  let caracteres = 0;

  for (let i = 0; i < mots.length; i++) {
    const texte = String(mots[i].mot || "");
    caracteres += (i > debut ? 1 : 0) + texte.length; // le +1 est l'espace

    const nb = i - debut + 1;
    const dureeEcran = finDe(i) - mots[debut].instant;   // temps a l'ecran
    const span = mots[i].instant - mots[debut].instant;  // parole deja couverte

    // ⚠️ La borne de parole se regarde EN AVANT, sur le mot suivant, et pas en
    // arriere sur le mot courant. Trouve au banc : teste en arriere, elle ne
    // reagit qu'APRES avoir avale le mot fautif, et un silence de 10 s entre
    // deux mots faisait un bloc couvrant 11 s de parole -- on lisait la fin
    // d'une phrase qu'on n'entendrait que dix secondes plus tard.
    //
    // Regardee en avant, la meme borne fait d'une pierre deux coups : elle
    // plafonne la parole couverte ET elle coupe AVANT tout silence de plus de
    // BLOC_SPAN_MAX. Le bloc reste alors seul a l'ecran pendant le silence, ce
    // qui est exactement ce qu'on veut : rien de neuf a lire tant que personne
    // ne parle, et surtout pas un ecran vide.
    const spanAvecSuivant =
      i + 1 < mots.length ? mots[i + 1].instant - mots[debut].instant : span;

    let couper;
    if (nb >= BLOC_MOTS_ABSOLU || caracteres >= BLOC_CARACTERES_ABSOLU) {
      couper = true;  // la boite d'abord : un bloc coupe reste lisible, un bloc
                      // qui deborde est purement et simplement invisible.
    } else if (dureeEcran < BLOC_DUREE_MIN) {
      couper = false; // trop court pour etre lu : on fusionne avec le suivant
    } else if (blocFinitPar(texte, BLOC_FORTE)) {
      couper = true;
    } else if (
      blocFinitPar(texte, BLOC_FAIBLE) &&
      (nb >= BLOC_VIRGULE_MOTS || span >= BLOC_VIRGULE_S)
    ) {
      couper = true;
    } else {
      couper =
        nb >= BLOC_MOTS_MAX ||
        spanAvecSuivant > BLOC_SPAN_MAX ||
        caracteres >= BLOC_CARACTERES_MAX;
    }

    if (couper || i === mots.length - 1) {
      blocs.push({ premier: debut, dernier: i });
      debut = i + 1;
      caracteres = 0;
    }
  }

  // FUSION EN ARRIERE, en dernier recours.
  //
  // La boucle ci-dessus fusionne toujours vers l'AVANT : un bloc trop court
  // avale le suivant. Deux cas lui echappent, et tous deux se reglent ici.
  //
  //   1. Le DERNIER bloc n'a pas de suivant a avaler.
  //   2. Le garde-fou de la boite a force une coupure alors que le plancher de
  //      lisibilite l'interdisait. Mesure dans Chrome le 2026-08-27 : Whisper
  //      part en repetition en fin de piste (« Je vous ai dit que je vous ai
  //      dit que… ») et entasse 14 mots en 940 ms. Un bloc de 940 ms n'est pas
  //      lisible ; recolle au precedent il fait 4,3 s et 85 caracteres.
  //
  // La condition est en CARACTERES et non en mots, et c'est mesure, pas suppose :
  // dans Chrome, le bloc le plus long de la piste -- 58 caracteres -- tient sur
  // UNE ligne d'une boite qui en fait deux. C'est la longueur du texte qui
  // decide du debordement, la longueur seule.
  const longueurDe = (b) => {
    let n = 0;
    for (let i = b.premier; i <= b.dernier; i++) n += (i > b.premier ? 1 : 0) + mots[i].mot.length;
    return n;
  };

  for (let k = blocs.length - 1; k >= 1; k--) {
    const q = blocs[k];
    const suivant = k + 1 < blocs.length ? mots[blocs[k + 1].premier].instant : fin;
    if (suivant - mots[q.premier].instant >= BLOC_DUREE_MIN) continue;
    const p = blocs[k - 1];
    const fusion = { premier: p.premier, dernier: q.dernier };
    if (longueurDe(fusion) > BLOC_CARACTERES_ABSOLU) continue; // la boite d'abord
    p.dernier = q.dernier;
    blocs.splice(k, 1);
  }

  return blocs.map((b, k) => {
    const debutBloc = mots[b.premier].instant;
    const finParole = mots[b.dernier].instant;
    const suivant = k + 1 < blocs.length ? mots[blocs[k + 1].premier].instant : fin;
    return {
      instant: debutBloc,
      fin: suivant,
      finParole,
      // L'heure a laquelle le bloc quitte l'ecran. Trois bornes, et la plus
      // petite gagne :
      //   - l'arrivee du suivant (on ne se recouvre jamais) ;
      //   - son dernier mot plus BLOC_APRES_PAROLE (on ne survit pas a ce qu'on
      //     dit) ;
      //   - jamais avant BLOC_DUREE_MIN, sinon un bloc court redeviendrait
      //     illisible, ce qu'on vient justement d'interdire.
      disparition: Math.min(
        suivant,
        Math.max(finParole + BLOC_APRES_PAROLE, debutBloc + BLOC_DUREE_MIN)
      ),
      nbMots: b.dernier - b.premier + 1,
      texte: mots
        .slice(b.premier, b.dernier + 1)
        .map((m) => m.mot)
        .join(" "),
    };
  });
}

// Le bloc en vigueur a la position `t` : le dernier dont le premier mot est
// deja passe. -1 quand on est avant le tout premier.
function prepBlocIndex(t) {
  let bas = 0;
  let haut = prepLectBlocs.length;
  while (bas < haut) {
    const milieu = (bas + haut) >> 1;
    if (prepLectBlocs[milieu].instant + prepLectDecalageTestMs / 1000 <= t) bas = milieu + 1;
    else haut = milieu;
  }
  return bas - 1;
}

// Un bloc a l'ecran.
//
// La boite garde ses DEUX LIGNES et sa hauteur, toujours : c'est `zone` qui est
// haute de deux lignes, pas le texte. Un bloc d'une seule ligne se pose donc sur
// la ligne du BAS, comme un sous-titre de film -- d'ou le decalage vers le bas,
// plutot qu'un alignement herite de la page, qui changerait d'un site a l'autre.
function prepBlocRendre(k) {
  prepLectHauteur(LIGNES_VISIBLES);
  subtitleBox.style.display = "block";
  subtitleBox.style.opacity = "1";
  subtitleBox.style.fontStyle = "normal";
  ligne.style.transform = "";
  ligne.textContent = prepLectBlocs[k].texte;

  const reste = zone.clientHeight - ligne.scrollHeight;
  if (reste < 0) {
    // Ne devrait pas arriver : BLOC_MOTS_ABSOLU et BLOC_CARACTERES_ABSOLU sont
    // la pour ca. Si ca arrive quand meme, on montre le DEBUT -- le ruban, lui,
    // montre la fin, mais ici rien ne coule, la suite ne viendra jamais -- et on
    // le DIT, plutot que de laisser du texte disparaitre en silence.
    prepBlocDebordements++;
    console.warn(
      "⚠️ LiveSub : bloc trop long pour la boite (" + -reste + " px) — « " +
        prepLectBlocs[k].texte + " »"
    );
  }
  ligne.style.transform = reste > 0 ? "translateY(" + reste + "px)" : "";
  prepLectEtatAffiche = "bloc";
}

// Le battement du mode blocs. Il ne fait rien tant que le bloc en vigueur n'a
// pas change -- comme celui du mode mots, et pour la meme raison : il est appele
// par deux horloges independantes, il doit donc etre idempotent.
// Le bloc quitte l'ecran -- remplace par le suivant, ou efface parce que son
// dernier mot est passe depuis trop longtemps. Dans les deux cas c'est ICI que
// se mesure le temps qu'il y a reellement passe (critere 3).
function prepBlocQuitte(t, continu) {
  if (
    continu &&
    prepBlocApparuA !== null &&
    prepBlocDurees.length < prepLectMesuresMax
  ) {
    prepBlocDurees.push(Math.round((t - prepBlocApparuA) * 1000));
  }
  prepBlocApparuA = null;
}

function prepBlocBattre(t, continu) {
  const k = prepBlocIndex(t);

  if (k < 0) {
    prepLectMessage("attente", prepLectResume || "✅ Prêt — lance la lecture");
    prepLectBlocCourant = -1;
    prepBlocApparuA = null;
    return;
  }

  // Le bloc a-t-il fait son temps ? Le decalage de test se retrouve ici aussi :
  // il decale les instants, donc il decale l'heure de disparition avec eux.
  const bloc = prepLectBlocs[k];
  const expire = t >= bloc.disparition + prepLectDecalageTestMs / 1000;

  if (expire) {
    if (prepLectEtatAffiche !== "vide") {
      prepBlocQuitte(t, continu);
      prepLectEtatAffiche = "vide";
      // On EFFACE la boite au lieu de la vider : un rectangle noir vide en bas
      // de l'ecran serait plus genant qu'une absence, et il donnerait toujours
      // l'impression qu'il se passe quelque chose.
      //
      // ⚠️ Par l'opacite, PAS par `display: none`. `display` ne se transitionne
      // pas : il fait disparaitre la boite d'une image a l'autre, ce qui se lit
      // comme une panne. L'opacite, elle, suit le fondu pose sur la boite -- et
      // `pointer-events: none` fait que la boite invisible n'intercepte rien.
      subtitleBox.style.opacity = "0";
    }
    prepLectBlocCourant = k;
    return;
  }

  const nouveau = k !== prepLectBlocCourant;
  if (!nouveau && prepLectEtatAffiche === "bloc") return;

  if (nouveau && continu) {
    // Critere 1 : l'ecart entre l'instant du premier mot et son apparition.
    // ⚠️ On compare a l'instant D'ORIGINE, jamais a l'instant decale -- c'est ce
    // qui fait que la contre-preuve a +3 s se voit dans le chiffre.
    if (prepBlocEcarts.length < prepLectMesuresMax) {
      prepBlocEcarts.push(Math.round((t - bloc.instant) * 1000));
    }
    // Le bloc precedent laisse la place. D'un bloc au suivant seulement : apres
    // un saut, la duree ne serait plus celle d'un affichage mais celle d'un
    // deplacement.
    if (k === prepLectBlocCourant + 1) prepBlocQuitte(t, continu);
    else prepBlocApparuA = null;
  }

  prepBlocApparuA = t;
  prepLectBlocCourant = k;
  prepBlocRendre(k);
}

// Le ruban, avec les mots reellement en vigueur.
//
// On reutilise `rendre()` du mode direct sans y toucher une ligne : elle lit
// `motsCible` et `nbVisibles`, et c'est elle qui fait couler le texte quand il
// depasse les deux lignes. Meme boite, memes lignes, meme style.
function prepLectRendre(n) {
  const debut = Math.max(0, n - PREP_LECT_FENETRE);
  motsCible = prepLectStock.slice(debut, n).map((m) => ({ mot: m.mot }));
  nbVisibles = n - debut;
  prepLectHauteur(PREP_LECT_LIGNES);
  subtitleBox.style.display = "block";
  subtitleBox.style.opacity = "1";
  subtitleBox.style.fontStyle = "normal";
  rendre();
  prepLectEtatAffiche = "ruban";
}

function prepLectMessage(cle, texte) {
  if (prepLectEtatAffiche === cle) return;
  prepLectEtatAffiche = cle;
  prepLectHauteur(LIGNES_VISIBLES); // un message entier, pas un message coupe
  prepAfficher(texte, true);
}

// Le battement. Il est appele par DEUX horloges independantes (voir
// prepLectDemarrer) : il doit donc etre idempotent, et il l'est -- il ne fait
// rien tant que le nombre de mots dus n'a pas change.
function prepLectBattre() {
  if (!prepLectActif) return;

  const v = prepVideoResolue();
  if (!v) {
    prepLectMessage("sansvideo", "⚠️ Vidéo introuvable sur cette page");
    return;
  }

  const t = v.currentTime;
  const maintenant = performance.now();

  // Lecture continue, ou saut ? On compare la position attendue a la position
  // reelle. Un saut n'invalide pas l'affichage -- il invalide la MESURE.
  const dt = (maintenant - prepLectDernierTick) / 1000;
  const attendue = v.paused
    ? prepLectDernierePosition
    : prepLectDernierePosition + dt * v.playbackRate;
  const continu =
    prepLectDernierTick > 0 && !v.paused && Math.abs(t - attendue) <= PREP_LECT_SAUT_S;
  prepLectDernierTick = maintenant;
  prepLectDernierePosition = t;

  // Hors de la zone preparee : on le DIT. Un ruban qui reste fige sur ses
  // derniers mots pendant qu'on parle a l'ecran serait le pire des affichages,
  // parce qu'il a l'air de fonctionner.
  if (prepLectZone) {
    if (t > prepLectZone.fin + PREP_LECT_MARGE_ZONE) {
      prepLectMessage("apres", "⏭️ Au-delà de la préparation — aucun sous-titre ici");
      return;
    }
    if (t < prepLectZone.debut - PREP_LECT_MARGE_ZONE) {
      prepLectMessage("avant", "⏮️ Avant la zone préparée — aucun sous-titre ici");
      return;
    }
  }

  // Le mode blocs prend la main ICI, et seulement ici : tout ce qui precede --
  // resolution de la video, detection du saut, bornes de la zone preparee -- est
  // commun aux deux, et c'est voulu. Les deux affichages doivent voir exactement
  // la meme lecture, sinon la comparaison entre eux ne vaudrait rien.
  if (PREP_LECT_STYLE === "blocs") return prepBlocBattre(t, continu);

  const n = prepLectCombien(t);

  if (n === 0) {
    prepLectMessage("attente", prepLectResume || "✅ Prêt — lance la lecture");
    prepLectVisibles = 0;
    return;
  }

  if (n !== prepLectVisibles || prepLectEtatAffiche !== "ruban") {
    // Mesure : uniquement les mots reveles en lecture continue.
    if (continu && n > prepLectVisibles && prepLectVisibles >= 0) {
      for (let i = prepLectVisibles; i < n; i++) {
        if (prepLectMesures.length >= prepLectMesuresMax) break;
        // ⚠️ On compare a l'instant D'ORIGINE, jamais a l'instant decale : c'est
        // ce qui fait que la contre-preuve a +3 s se voit dans le chiffre.
        prepLectMesures.push(Math.round((t - prepLectStock[i].instant) * 1000));
      }
    }
    prepLectVisibles = n;
    prepLectRendre(n);
  }
}

// DEUX horloges, et c'est le correctif du figement.
//
// ⚠️ requestAnimationFrame S'ARRETE des que la page cesse d'etre rendue : autre
// fenetre par-dessus, onglet mis de cote, plein ecran d'une autre application.
// L'affichage se fige alors, puis lache d'un coup tous les mots devenus dus des
// que le rendu reprend -- c'est exactement le « ca fige puis ca rattrape », et
// c'est aussi ce qui fait apparaitre des mots loin de leur heure pendant le
// rattrapage. Mesure du 2026-08-27, meme code, meme video :
//
//     fenetre au premier plan        ->  mediane   8 ms, max   44 ms
//     fenetre pas au premier plan    ->  mediane 479 ms, max 1002 ms
//
// Le 1002 ms n'est pas un hasard : c'est rAF ramene a une image par seconde.
//
// La minuterie, elle, continue de tourner : Chrome ne bride serieusement les
// timers que dans un onglet d'ARRIERE-PLAN, et un onglet qui joue du son y
// echappe largement. On garde donc les deux -- rAF pour la finesse quand la
// page est rendue, la minuterie comme plancher quand elle ne l'est plus.
// Le battement etant idempotent, les faire tourner ensemble ne coute rien.
function prepLectBoucleRaf() {
  if (!prepLectActif) return;
  prepLectRaf = requestAnimationFrame(prepLectBoucleRaf);
  prepLectBattre();
}

function prepLectDemarrer() {
  if (prepLectActif || !prepLectStock.length) return;
  prepLectActif = true;
  prepLectVisibles = -1;
  prepLectBlocCourant = -2;
  prepBlocApparuA = null;
  prepLectEtatAffiche = "";
  prepLectDernierTick = 0;
  prepLectDernierePosition = 0;
  prepLectRaf = requestAnimationFrame(prepLectBoucleRaf);
  prepLectMinuterie = setInterval(prepLectBattre, PREP_LECT_PAS_MS);
  console.log(
    `▶️ LiveSub : affichage du stock — ${prepLectStock.length} mots, ` +
      (PREP_LECT_STYLE === "blocs" ? `${prepLectBlocs.length} blocs, ` : `mot par mot, `) +
      `zone ${prepLectZone.debut.toFixed(1)} s → ${prepLectZone.fin.toFixed(1)} s`
  );
}

function prepLectArreter() {
  prepLectActif = false;
  if (prepLectRaf) {
    cancelAnimationFrame(prepLectRaf);
    prepLectRaf = null;
  }
  if (prepLectMinuterie) {
    clearInterval(prepLectMinuterie);
    prepLectMinuterie = null;
  }
  // ⚠️ OBLIGATOIRE : `zone` est partagee avec le mode direct, qui compte sur ses
  // deux lignes. La laisser a une ligne le casserait a distance.
  prepLectHauteur(LIGNES_VISIBLES);
}

// Va chercher le stock aupres du service worker, qui le demande a l'offscreen.
async function prepLectCharger(resume) {
  try {
    const reponse = await chrome.runtime.sendMessage({ type: "PREPARATION_STOCK_COMPLET" });
    if (!reponse || !reponse.success || !Array.isArray(reponse.mots) || !reponse.mots.length) {
      prepAfficher("⚠️ Aucun texte préparé à afficher");
      return;
    }

    prepLectStock = reponse.mots;
    prepLectZone = {
      debut: Number(reponse.positionDepart) || 0,
      fin: (Number(reponse.positionDepart) || 0) + (Number(reponse.dureeCouverteS) || 0),
    };
    // Le decoupage en phrases se fait UNE fois, ici, sur le stock complet. C'est
    // la seule facon d'avoir la duree d'un bloc : elle depend du premier mot du
    // bloc SUIVANT, donc de texte qui n'existe pas encore en direct.
    prepLectBlocs =
      PREP_LECT_STYLE === "blocs"
        ? prepBlocsDepuisMots(prepLectStock, prepLectZone.fin)
        : [];
    if (resume && typeof resume.nbMots === "number") {
      prepLectResume =
        `✅ Prêt — ${resume.nbMots} mots préparés, ` +
        `${prepFormaterDuree(resume.dureeCouverteS)} couvertes`;
    }
    prepLectDemarrer();
  } catch (err) {
    prepAfficher("⚠️ Stock illisible : " + (err && err.message ? err.message : err));
  }
}

// Mediane, minimum, maximum d'une liste de mesures.
//
// La MEDIANE et pas la moyenne : une seule valeur aberrante -- un onglet passe
// a l'arriere-plan une seconde, un `seek` compte a tort comme continu -- suffit
// a deplacer une moyenne, et donnerait un chiffre plus mauvais que la realite.
// Le MINIMUM et le MAXIMUM sont rendus tels quels, jamais arrondis : c'est la
// ou se voient les cas qui derangent.
function prepStats(liste) {
  const v = liste.slice().sort((a, b) => a - b);
  if (!v.length) return { n: 0, medianeMs: null, minMs: null, maxMs: null };
  const mediane =
    v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2);
  return { n: v.length, medianeMs: mediane, minMs: v[0], maxMs: v[v.length - 1] };
}

// Remet a zero TOUT ce qui est mesure, dans les deux modes, et force le prochain
// battement a re-rendre. Appele par la contre-preuve : garder des mesures faites
// avant le decalage les melangerait a celles d'apres, et le +3 s ne se verrait
// plus que de moitie.
function prepRazMesures() {
  prepLectMesures = [];
  prepLectVisibles = -1;
  prepBlocEcarts = [];
  prepBlocDurees = [];
  prepBlocApparuA = null;
  prepLectBlocCourant = -2;
  prepBlocDebordements = 0;
  prepLectEtatAffiche = "";
}

// ---------------------------------------------------------------------------
// Messages — mesure uniquement
// ---------------------------------------------------------------------------
//
// Ces deux-la ne sont branches sur aucun reglage et ne servent qu'a prouver que
// l'affichage fait ce qu'il pretend. Sans eux la mesure serait impossible : un
// content script vit dans un monde isole, la console de la page ne peut pas
// lire ses variables.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "PREPARATION_MESURES") {
    sendResponse({
      success: true,
      style: PREP_LECT_STYLE,
      // Mode mots : un ecart par MOT revele. Inchange.
      ...prepStats(prepLectMesures),
      decalageTestMs: prepLectDecalageTestMs,
      motsAffiches: prepLectVisibles,
      remplacementsVideo: prepVideoRemplacements,
      etat: prepLectEtatAffiche,
      // Mode blocs : un ecart par BLOC (critere 1) et le temps reellement passe
      // a l'ecran par chacun (critere 3).
      blocCourant: prepLectBlocCourant,
      ecartBlocs: prepStats(prepBlocEcarts),
      dureeBlocs: prepStats(prepBlocDurees),
      debordementsVus: prepBlocDebordements,
    });
    return;
  }

  // L'AUDIT DES BLOCS (criteres 3 et 4).
  //
  // La hauteur n'est pas calculee, elle est MESUREE : on ecrit reellement chaque
  // bloc dans l'element d'affichage et on lit son `scrollHeight`. Meme element,
  // meme police, meme largeur, meme retour a la ligne que ce que verra l'oeil --
  // une estimation en « caracteres par ligne » se tromperait sur les mots longs
  // et sur toute page qui change la police.
  //
  // C'est synchrone du premier au dernier bloc, donc le navigateur ne repeint
  // pas entre deux : rien ne clignote, et l'affichage est remis en place avant
  // de rendre la main.
  if (request.type === "PREPARATION_BLOCS") {
    const sauveTexte = ligne.textContent;
    const sauveTransform = ligne.style.transform;
    const hauteurZone = zone.clientHeight;

    let debordent = 0;
    let hauteurMax = 0;
    let plusLong = null;

    const durees = [];
    const courts = [];
    let vide = 0; // secondes ou la boite est effacee, faute de texte a montrer

    for (const b of prepLectBlocs) {
      ligne.style.transform = "";
      ligne.textContent = b.texte;
      const h = ligne.scrollHeight;
      if (h > hauteurZone) debordent++;
      if (h > hauteurMax) hauteurMax = h;
      if (!plusLong || b.texte.length > plusLong.texte.length) {
        plusLong = { texte: b.texte, nbMots: b.nbMots, hauteurPx: h };
      }
      // Le temps VISIBLE, pas la largeur du creneau : depuis l'etape du
      // 2026-08-28 un bloc s'efface quand son dernier mot est passe depuis
      // BLOC_APRES_PAROLE, meme si le suivant n'est pas encore la.
      const d = Math.round((b.disparition - b.instant) * 1000);
      durees.push(d);
      vide += b.fin - b.disparition;
      if (d < BLOC_DUREE_MIN * 1000) courts.push({ ms: d, texte: b.texte });
    }

    ligne.textContent = sauveTexte;
    ligne.style.transform = sauveTransform;

    sendResponse({
      success: true,
      style: PREP_LECT_STYLE,
      nbBlocs: prepLectBlocs.length,
      nbMots: prepLectStock.length,
      dureePlan: prepStats(durees),
      // Le temps total sans aucun sous-titre a l'ecran. C'est la mesure du
      // probleme AMONT (des trous dans le stock), rendue visible plutot que
      // masquee par un bloc qui trainait.
      ecranVideS: Math.round(vide * 10) / 10,
      nbCourts: courts.length,
      exemplesCourts: courts.slice(0, 5),
      motsMax: prepLectBlocs.reduce((m, b) => Math.max(m, b.nbMots), 0),
      caracteresMax: prepLectBlocs.reduce((m, b) => Math.max(m, b.texte.length), 0),
      hauteurZonePx: hauteurZone,
      hauteurMaxPx: hauteurMax,
      nbDebordent: debordent,
      debordementsVus: prepBlocDebordements,
      plusLong,
      // La liste, plafonnee : elle sert a verifier DEPUIS LA PAGE que le texte
      // reellement affiche est bien celui qu'on attendait, a l'heure qu'on
      // attendait. Un message de diagnostic ne doit pas pouvoir devenir enorme
      // sur une video de deux heures -- d'ou le plafond, et d'ou `tronquee`,
      // parce qu'une liste coupee en silence ferait croire a une couverture
      // complete.
      blocs: prepLectBlocs.slice(0, 400).map((b) => ({
        instant: b.instant,
        fin: b.fin,
        finParole: b.finParole,
        disparition: b.disparition,
        nbMots: b.nbMots,
        texte: b.texte,
      })),
      tronquee: prepLectBlocs.length > 400,
    });
    return;
  }

  if (request.type === "PREPARATION_TEST_DECALAGE") {
    prepLectDecalageTestMs = Number(request.ms) || 0;
    prepRazMesures();
    console.warn(`🧪 LiveSub : décalage de test = ${prepLectDecalageTestMs} ms`);
    sendResponse({ success: true, decalageTestMs: prepLectDecalageTestMs });
    return;
  }

  if (request.type === "PREPARATION_MESURES_RAZ") {
    prepRazMesures();
    sendResponse({ success: true });
    return;
  }
});
