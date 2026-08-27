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

// Le texte VISE : une liste de { mot, instant, du }.
//   `instant` = quand le mot a ete PRONONCE (heure absolue, venue du moteur) ;
//   `du`      = quand il DOIT apparaitre, soit `instant + retard`.
// `nbVisibles` dit combien sont deja sortis ; l'ecart, c'est ce qui attend son
// heure.
let motsCible = [];
let nbVisibles = 0;
let minuterie = null;

// Instant du mot le plus recent de la cible, et « son age a-t-il deja ete
// mesure ? ». Sert a la trace de diagnostic, qui doit sortir UNE fois par lot.
let instantDernierMot = null;
let ageDejaMesure = false;

// ---------------------------------------------------------------------------
// Deux modes d'affichage : « stable seulement » ou « avec la fin provisoire »
// ---------------------------------------------------------------------------
//
// L'offscreen envoie TOUJOURS les deux textes -- `ruban` (stable, ne bougera
// plus jamais) et `provisoire` (la fin que la passe suivante a le droit de
// corriger). C'est ICI, a l'affichage, qu'on decide lequel on montre.
//
// AFFICHER LE PROVISOIRE, c'est accepter que du texte deja lu SE REECRIVE sous
// les yeux : « Je ne me » devient « Je n'aime pas, je deteste. » Ce n'est pas
// un defaut qu'on peut corriger, c'est la definition meme du provisoire.
//
// NE MONTRER QUE LE STABLE supprime ce phenomene par construction : le ruban ne
// recule jamais, donc le texte ne peut QUE s'allonger. Le prix est connu et
// assume : un mot n'apparait qu'une fois qu'une SECONDE passe l'a confirme,
// soit environ une cadence de retard en plus (~2 s).
//
// Le choix se fait a l'oeil, pas au chiffre -- d'ou une option, basculable A
// CHAUD (voir l'ecoute de storage.onChanged plus bas) pour comparer les deux
// modes sur la meme video sans redemarrer la capture.
//
// Defaut : false, donc mode stable. C'est le reproche « ca se reecrit » qu'on
// cherche a faire disparaitre ; celui qui veut la reactivite maximale coche.
const CLE_AFFICHER_PROVISOIRE = "afficherProvisoire";
let afficherProvisoire = false;

// Le dernier FLUX recu, garde tel quel. Sans lui, une bascule de mode devrait
// attendre la passe suivante pour se voir : on veut qu'elle soit immediate.
let dernierFlux = null;

// ---------------------------------------------------------------------------
// L'HORLOGE DES MOTS : chaque mot sort a l'heure ou il a ete prononce
// ---------------------------------------------------------------------------
//
// AVANT : un mot toutes les 80 ms, quoi qu'il arrive. On savait LESQUELS, pas
// QUAND -- alors on les jetait a l'ecran a cadence fixe. D'ou des rafales
// suivies de trous, sans rapport avec le rythme reel de la parole. Et les
// silences n'existaient pas : entre deux phrases, le texte continuait de
// defiler comme si on parlait encore.
//
// MAINTENANT : chaque mot arrive avec l'heure a laquelle il a ete prononce
// (voir « Les instants » dans CLAUDE.md). Il sort a cette heure-la, plus un
// retard. Parole rapide -> texte rapide. Parole lente -> texte lent. Pause ->
// l'ecran s'arrete, comme sur YouTube.
//
// Un seul reveil, 20 fois par seconde, qui ne fait que regarder l'heure.
const PAS_HORLOGE = 50;

// ---------------------------------------------------------------------------
// LE RETARD D'AFFICHAGE : mesure, pas choisi
// ---------------------------------------------------------------------------
//
// ⚠️ C'est le seul reglage delicat de tout l'affichage, et le figer dans le code
// serait une erreur.
//
// Un mot prononce a l'instant T n'existe en texte qu'a T + la latence du
// moteur : on ne peut pas l'afficher avant, c'est physique. Si le retard etait
// PLUS COURT que cette latence, chaque mot arriverait deja en retard, sortirait
// immediatement, et on retomberait trait pour trait sur les rafales qu'on
// cherche a supprimer -- l'horloge ne servirait a rien.
//
// Or cette latence depend de la machine (2 s ici, 6 s sur une machine lente
// simulee) ET du mode d'affichage : le mode stable attend une confirmation de
// plus, soit une cadence de retard en plus. Une constante ecrite ici serait
// juste pour une machine et fausse pour toutes les autres.
//
// On l'OBSERVE donc : a chaque flux on note l'age du mot le plus frais au
// moment ou il arrive, et le retard suit un haut percentile des dernieres
// mesures. C'est un tampon de gigue, exactement comme en lecture video.
// ⚠️ ET ON OBSERVE LE MOT LE PLUS ANCIEN EN ATTENTE, PAS LE PLUS FRAIS.
//
// C'est le point qui decide de tout, et il a ete tranche au banc, pas au
// raisonnement. Les mots n'arrivent pas un par un : ils arrivent par LOTS, un
// lot couvrant une cadence de parole. Le mot le plus ancien d'un lot est donc
// plus vieux que le plus frais d'exactement une cadence.
//
// Caler le retard sur le plus frais laisse tous les autres deja en retard : ils
// sortent d'un bloc. Mesure sur une piste a rythme variable (rapide / pause de
// 2 s / lent) :
//
//                        cale sur le plus frais    cale sur le plus ancien
//   normale, stable      30 ms, rafales de 5       20 ms, rafales de 1
//   normale, provisoire  180 ms, rafales de 4      20 ms, rafales de 1
//   lente, provisoire    300 ms, PAUSE PERDUE      20 ms, pause conservee
//
// Le prix est reel et assume : +1,5 s de retard a l'ecran (4,9 -> 6,4 s en mode
// stable). C'est ce qu'il en coute pour que les mots sortent un par un au bon
// rythme au lieu de gicler par paquets.
const MEMOIRE_AGES = 20;    // sur combien de flux on observe
const PERCENTILE_AGE = 0.9; // on couvre 9 arrivees sur 10
const MARGE_RETARD = 200;   // ms au-dessus de l'age observe
const RETARD_MIN = 300;

// Plafond. Au-dela, ce n'est plus de la gigue : la machine ne suit pas.
//
// ⚠️ Ce plafond a un effet VISIBLE, et c'est voulu.
//
// Le retard dont on aurait besoin vaut environ 2 cadences en mode provisoire et
// 3 en mode stable (une confirmation de plus). Sur une machine tres lente -- 6 s
// par passe -- ca ferait 12 a 18 s : un sous-titre a 18 s de retard n'est plus
// lisible en face d'une video, il n'a plus rien a voir avec l'image. On prefere
// alors reafficher par paquets. Moins beau, mais utilisable.
//
// La valeur, elle, se deduit de la machine de reference : 2,2 s par passe
// mesures, donc ~6,6 s de besoin en mode stable. A 8 s le plafond mordait des
// qu'une machine etait 25 % plus lente ; a 10 s il laisse de la marge tout en
// restant dans ce qu'on sait lire (les sous-titres du direct a la television
// tournent autour de 5 a 8 s).
const RETARD_MAX = 10000;

// Ecartement par defaut entre deux mots quand AUCUN instant n'est connu (passe
// dont les horodatages ont ete ecartes). C'est le repli : on etale les mots sur
// une cadence plausible au lieu de tout lacher d'un coup. Moins beau qu'un vrai
// rythme -- pas de vraies pauses -- mais ca marche.
const ESPACEMENT_DEFAUT = 280;

// Les ages observes, UN JEU PAR MODE : les deux modes n'affichent pas le meme
// dernier mot, donc pas le meme age. Les melanger ferait suivre au retard une
// moyenne qui ne decrit ni l'un ni l'autre.
//
// On ne les remet PAS a zero entre deux captures : ils decrivent la machine, pas
// la video. Les jeter obligerait a re-observer une minute a chaque demarrage.
const agesArrivee = { stable: [], avecProvisoire: [] };

function modeCourant() {
  return afficherProvisoire ? "avecProvisoire" : "stable";
}

function noterAge(age) {
  const ages = agesArrivee[modeCourant()];
  ages.push(Math.max(0, age));
  if (ages.length > MEMOIRE_AGES) ages.shift();
}

function retardCourant() {
  const ages = agesArrivee[modeCourant()];
  if (!ages.length) return RETARD_MIN; // rien d'observe encore
  const tries = [...ages].sort((a, b) => a - b);
  const rang = Math.min(tries.length - 1, Math.floor(tries.length * PERCENTILE_AGE));
  return Math.min(RETARD_MAX, Math.max(RETARD_MIN, tries[rang] + MARGE_RETARD));
}

// ⚠️ `RETARD_MAX_MOTS` A DISPARU ICI, et c'est le signe que l'horloge fait son
// travail. C'etait une borne sur le nombre de mots qu'on acceptait d'animer :
// sans elle, un simple recalage (ruban rogne par la gauche, passe repartant
// d'un texte different) faisait re-reveler la soixantaine de mots du ruban a
// 80 ms piece -- 5 secondes a ranimer du texte deja lu, pendant lesquelles
// l'affichage prenait un retard qu'il ne rattrapait jamais. Mesure de
// l'epoque : l'age du mot le plus recent passait de 2,0 s a 7 puis 9,5 s, et il
// GRANDISSAIT.
//
// Avec l'horloge, le probleme ne peut plus se poser : un vieux mot porte un
// vieil instant, son heure est passee depuis longtemps, il est visible tout de
// suite. Il n'y a plus rien a « rattraper » -- donc plus rien a borner. Idem
// pour `PAS_REVELATION` : c'etaient deux rustines pour compenser l'absence
// d'horloge.

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
// ⚠️ SON ROLE A CHANGE AVEC L'HORLOGE, et il reste indispensable. Ce n'est plus
// lui qui decide ce qu'on montre -- c'est l'heure. Il sert maintenant de
// PLANCHER : ce qui est deja sorti ne doit jamais disparaitre, meme si la passe
// suivante re-estime legerement l'instant d'un mot deja lu. Sans ce plancher,
// un mot redate de 50 ms plus tard clignoterait.
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
  ligne.textContent = motsCible
    .slice(0, nbVisibles)
    .map((m) => m.mot)
    .join(" ");
  const debordement = Math.max(0, ligne.scrollHeight - zone.clientHeight);
  ligne.style.transform = debordement ? `translateY(${-debordement}px)` : "";
}

// Combien de mots ont deja atteint leur heure ?
//
// Les instants sont croissants (garanti par l'offscreen, et re-garanti par
// `completerInstants`), donc `du` l'est aussi : ce qui est du forme toujours un
// PREFIXE. C'est ce qui permet de simplement compter.
function combienDues(maintenant) {
  let n = 0;
  while (n < motsCible.length && motsCible[n].du <= maintenant) n++;
  return n;
}

// Le battement : il ne « revele » rien de lui-meme, il regarde l'heure.
function battre() {
  const dues = combienDues(Date.now());
  if (dues > nbVisibles) {
    nbVisibles = dues;
    rendre();
  }

  if (nbVisibles >= motsCible.length) {
    // Le mot le plus recent vient de sortir : c'est MAINTENANT qu'on mesure son
    // age reel. C'est ce chiffre qui doit rester stable dans le temps -- s'il
    // grandit, l'affichage prend du retard sur la parole.
    if (!ageDejaMesure && instantDernierMot) {
      ageDejaMesure = true;
      const age = ((Date.now() - instantDernierMot) / 1000).toFixed(1);
      console.log(`📝 Mot le plus récent affiché ${age} s après avoir été prononcé`);
    }
    arreterHorloge();
  }
}

function demarrerHorloge() {
  if (minuterie || nbVisibles >= motsCible.length) return;
  minuterie = setInterval(battre, PAS_HORLOGE);
}

function arreterHorloge() {
  if (!minuterie) return;
  clearInterval(minuterie);
  minuterie = null;
}

// Donne un instant a CHAQUE mot, y compris a ceux qui n'en ont pas.
//
// Un mot sans instant, ca arrive : l'offscreen ecarte les horodatages d'une
// passe entiere quand le recollage ne retombe pas sur les mots affiches (voir
// `motsSansInstant`). Plutot que de lacher ces mots-la d'un coup, on les etale.
//
//   - trou au MILIEU  -> interpolation entre les deux instants connus qui
//                        l'encadrent : c'est la meilleure estimation possible,
//                        on connait le debut, la fin et le nombre de mots ;
//   - trou au DEBUT   -> on remonte a reculons depuis le premier instant connu ;
//   - trou a la FIN   -> on avance depuis le dernier connu, sans jamais depasser
//                        le repere (la fin du son deja transcrit) : un mot ne
//                        peut pas avoir ete prononce apres ;
//   - AUCUN instant   -> on etale tout le lot a reculons depuis le repere. C'est
//                        exactement le repli « etaler sur la cadence » : moins
//                        beau qu'un vrai rythme, mais jamais une rafale.
function completerInstants(nbMots, instants, repere, maintenant) {
  const sortie = new Array(nbMots).fill(null);
  for (let i = 0; i < nbMots; i++) {
    const t = instants ? instants[i] : null;
    if (typeof t === "number" && isFinite(t)) sortie[i] = t;
  }

  const fin = repere || maintenant;
  let premier = -1;
  for (let i = 0; i < nbMots; i++) {
    if (sortie[i] != null) {
      premier = i;
      break;
    }
  }

  if (premier === -1) {
    for (let i = 0; i < nbMots; i++) sortie[i] = fin - (nbMots - 1 - i) * ESPACEMENT_DEFAUT;
    return sortie;
  }

  for (let i = premier - 1; i >= 0; i--) sortie[i] = sortie[i + 1] - ESPACEMENT_DEFAUT;

  let i = premier + 1;
  while (i < nbMots) {
    if (sortie[i] != null) {
      i++;
      continue;
    }
    let j = i;
    while (j < nbMots && sortie[j] == null) j++;
    if (j >= nbMots) break; // trou de fin : traite juste apres
    const pas = (sortie[j] - sortie[i - 1]) / (j - i + 1);
    for (let k = i; k < j; k++) sortie[k] = sortie[i - 1] + pas * (k - i + 1);
    i = j + 1;
  }

  let dernier = nbMots - 1;
  while (dernier >= 0 && sortie[dernier] == null) dernier--;
  for (let k = dernier + 1; k < nbMots; k++) {
    sortie[k] = Math.min(fin, sortie[k - 1] + ESPACEMENT_DEFAUT);
  }

  // Jamais en arriere : l'ecran lit cette liste dans l'ordre, et un instant qui
  // recule bloquerait tout ce qui suit.
  for (let k = 1; k < nbMots; k++) if (sortie[k] < sortie[k - 1]) sortie[k] = sortie[k - 1];
  return sortie;
}

// Un tableau d'instants de la BONNE longueur, quoi qu'on ait recu.
function instantsPour(nbMots, recus) {
  const sortie = new Array(nbMots).fill(null);
  if (!Array.isArray(recus)) return sortie;
  for (let i = 0; i < nbMots && i < recus.length; i++) sortie[i] = recus[i];
  return sortie;
}

// Reception du flux : ruban (stable) + provisoire (fin incertaine).
//
// On garde le message TEL QUEL avant de l'appliquer : c'est ce qui permet a une
// bascule de mode de se voir tout de suite, sans attendre la passe suivante.
function afficherFlux(message) {
  // `recuA` : l'heure d'ARRIVEE, figee ici. C'est elle qui sert a mesurer l'age
  // du mot le plus frais -- pas `Date.now()` au moment du calcul. Sans ca, une
  // bascule de mode, qui re-applique le meme flux plusieurs secondes plus tard,
  // ferait croire a une arrivee tardive et gonflerait le retard pour rien.
  //
  // `ageNotePour` : l'age n'est note qu'UNE fois par mode. Re-appliquer le meme
  // flux ne doit pas empiler dix fois la meme observation.
  dernierFlux = Object.assign({}, message, { recuA: Date.now(), ageNotePour: {} });
  appliquerFlux();
}

// Ecrit a l'ecran le dernier flux recu, dans le mode d'affichage courant.
//
// Le ruban ne s'efface JAMAIS. Entre deux phrases, il n'arrive simplement plus
// rien de nouveau et le dernier texte reste affiche.
function appliquerFlux() {
  if (!dernierFlux) return;

  const { ruban, provisoire, rubanInstants, provisoireInstants, finAudio, finAudioStable } =
    dernierFlux;

  // LE point de bascule, et il tient en une ligne : en mode stable on ignore
  // purement et simplement le provisoire. Tout le reste de la fonction --
  // plancher, horloge, defilement -- ne change pas d'un iota.
  const fin = afficherProvisoire ? provisoire : "";

  // Le repere temporel doit suivre le mode, sinon la mesure d'age (et donc la
  // calibration du retard du son) parlerait d'un texte qui n'est pas affiche :
  //   - avec le provisoire, le dernier mot montre est le dernier de la fenetre
  //     -> `finAudio` ;
  //   - en stable seul, il est celui que DEUX passes ont confirme, donc plus
  //     ancien d'environ une cadence -> `finAudioStable`.
  // Repli sur `finAudio` si l'offscreen ne fournit pas encore le second repere
  // (rien de stable n'a encore ete confirme).
  const repere = afficherProvisoire ? finAudio : finAudioStable || finAudio;

  const motsRuban = decouperEnMots(ruban);
  const motsFin = decouperEnMots(fin);
  const nouveau = motsRuban.concat(motsFin);

  // Rien a montrer : on ne touche a rien. C'est le cas des toutes premieres
  // secondes en mode stable, quand aucune passe n'a encore ete confirmee --
  // l'ecran garde ce qu'il a (message d'etat, ou texte de la phrase d'avant)
  // plutot que de clignoter a vide.
  if (!nouveau.length) return;

  // Les instants suivent le meme decoupage que les mots : ruban puis fin.
  const instantsRecus = instantsPour(motsRuban.length, rubanInstants).concat(
    afficherProvisoire ? instantsPour(motsFin.length, provisoireInstants) : []
  );

  const maintenant = Date.now();
  const instants = completerInstants(nouveau.length, instantsRecus, repere, dernierFlux.recuA);
  const instantFrais = instants[instants.length - 1];

  // L'age du mot le plus frais A SON ARRIVEE : c'est lui qui dit de combien le
  // retard doit couvrir la latence du moteur. Note une seule fois par mode.
  // Ce qui est deja sorti ne doit JAMAIS disparaitre ni etre re-anime : c'est le
  // role du plancher (voir alignerSurAffiche). L'heure decide du reste.
  const dejaAffiches = motsCible.slice(0, nbVisibles).map((m) => m.mot);
  const plancherProvisoire = alignerSurAffiche(dejaAffiches, nouveau);

  const mode = modeCourant();
  if (!dernierFlux.ageNotePour[mode] && premierTexteAffiche) {
    dernierFlux.ageNotePour[mode] = true;
    const iAttente = Math.min(plancherProvisoire, nouveau.length - 1);
    noterAge(dernierFlux.recuA - instants[iAttente]);
  }
  const retard = retardCourant();

  motsCible = nouveau.map((mot, i) => ({
    mot,
    instant: instants[i],
    du: instants[i] + retard,
  }));
  instantDernierMot = instantFrais;
  ageDejaMesure = false;

  nbVisibles = Math.max(plancherProvisoire, combienDues(maintenant));

  // Le tout premier texte de la capture remplace un message d'etat (« Ecoute du
  // son en cours… »). Avec nbVisibles a 0, `rendre` ecrivait une chaine vide :
  // la boite se vidait completement avant que le premier mot n'apparaisse.
  // Mesure au banc : 80 ms d'ecran noir. On montre donc le premier mot tout de
  // suite -- le message cede la place a du texte, pas a du vide.
  if (!premierTexteAffiche && nbVisibles === 0) nbVisibles = 1;

  // Trace d'arrivee, distincte de la trace d'affichage plus bas. Les deux
  // ensemble disent OU le temps passe : entre le micro et ce message (le
  // moteur), ou entre ce message et l'ecran (l'attente de l'heure).
  console.log(
    `📥 Flux [${afficherProvisoire ? "avec provisoire" : "stable seul"}] : ` +
      `${motsCible.length} mots (${nbVisibles} à l'écran, ` +
      `${motsCible.length - nbVisibles} en attente de leur heure), ` +
      `son vieux de ${repere ? ((maintenant - repere) / 1000).toFixed(1) : "?"} s, ` +
      `retard d'affichage ${(retard / 1000).toFixed(1)} s`
  );

  premierTexteAffiche = true;
  subtitleBox.style.opacity = "1";
  subtitleBox.style.fontStyle = "normal";

  rendre();
  demarrerHorloge();
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
    // (Les ages observes, eux, SURVIVENT : ils decrivent la machine, pas la
    // video. Les jeter obligerait a re-observer une minute a chaque demarrage.)
    arreterHorloge();
    motsCible = [];
    nbVisibles = 0;
    instantDernierMot = null;
    ageDejaMesure = false;
    dernierFlux = null;
    premierTexteAffiche = false;

    subtitleBox.style.display = "block";
    subtitleBox.style.opacity = "1";
    subtitleBox.style.fontStyle = "normal";
    ligne.style.transform = "";
    ligne.textContent = "🎬 Ecoute du son en cours...";
    console.log("✅ Overlay AFFICHE sur la page");
  } else {
    subtitleBox.style.display = "none";
    arreterHorloge();
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
    // Le message entier : il porte maintenant un instant par mot, et le relais
    // du service worker ne reconstruit plus rien.
    afficherFlux(request);
    sendResponse({ success: true });
  }

  if (request.type === "STATUT") {
    afficherStatut(request.texte);
    sendResponse({ success: true });
  }
});

// ---------------------------------------------------------------------------
// L'option d'affichage : lue au chargement, puis suivie A CHAUD
// ---------------------------------------------------------------------------
//
// Un content script accede directement a chrome.storage : pas besoin de passer
// par le service worker, et surtout pas besoin de redemarrer la capture. On
// coche dans la popup, l'ecran change a la passe... non, tout de suite : on
// re-applique le dernier flux recu.
//
// C'est ce qui rend la comparaison possible A L'OEIL, sur la meme video et la
// meme phrase -- ce qu'aucun chiffre ne remplace.
function appliquerMode(valeur, origine) {
  const avant = afficherProvisoire;
  afficherProvisoire = Boolean(valeur);
  if (afficherProvisoire === avant && origine !== "chargement") return;

  console.log(
    `👁️ Affichage : ${afficherProvisoire ? "ruban + fin provisoire" : "texte stable seulement"}` +
      ` (${origine})`
  );

  // Re-appliquer tout de suite. En passant en mode stable la cible RETRECIT :
  // le plancher trouve alors que toute la cible est deja a l'ecran, donc la fin
  // provisoire disparait d'un coup, sans re-animer un seul mot deja lu.
  //
  // Le retard, lui, change de jeu d'observations en meme temps que le mode --
  // et il se re-observe des le premier flux du nouveau mode.
  appliquerFlux();
}

try {
  chrome.storage.local.get(CLE_AFFICHER_PROVISOIRE, (stored) => {
    // Absent du storage = jamais coche = mode stable. C'est le defaut voulu.
    appliquerMode(stored && stored[CLE_AFFICHER_PROVISOIRE], "chargement");
  });

  chrome.storage.onChanged.addListener((changes, zone) => {
    if (zone !== "local" || !changes[CLE_AFFICHER_PROVISOIRE]) return;
    appliquerMode(changes[CLE_AFFICHER_PROVISOIRE].newValue, "bascule à chaud");
  });
} catch (err) {
  // Sans storage on reste sur le defaut : le texte ne se reecrit pas, c'est le
  // comportement le plus sur des deux.
  console.warn("Option d'affichage illisible, mode stable par defaut :", err);
}

// Par défaut, l'overlay est caché
toggleOverlay(false);
