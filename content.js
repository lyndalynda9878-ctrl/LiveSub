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


// ===========================================================================
// MODE « PREPARER D'ABORD » — etape A : piloter le lecteur de la page
// ===========================================================================
//
// Un mode a COTE du direct. Rien ici ne touche a `motsCible`, `nbVisibles`,
// `dernierFlux`, `premierTexteAffiche` ni a l'horloge des mots : ces deux
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
// mais n'appelle NI afficherStatut NI afficherFlux : ces deux-la ont leurs
// propres regles (« un statut n'ecrase jamais du vrai texte »), qui n'ont rien
// a voir avec ce qu'on fait ici.
function prepAfficher(texte, discret) {
  arreterHorloge();
  subtitleBox.style.display = "block";
  subtitleBox.style.opacity = discret ? "0.8" : "1";
  subtitleBox.style.fontStyle = discret ? "italic" : "normal";
  ligne.style.transform = "";
  ligne.textContent = texte;
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
  return { success: true, position: prepAvant.position, duree: v.duration };
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
          prepAfficher("❌ " + request.erreur);
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
// borne a RETARD_MAX. Tout cet appareillage n'a qu'un but -- compenser le fait
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

// UNE seule ligne pendant la lecture, et pas deux.
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
  prepLectEtatAffiche = "";
  prepLectDernierTick = 0;
  prepLectDernierePosition = 0;
  prepLectRaf = requestAnimationFrame(prepLectBoucleRaf);
  prepLectMinuterie = setInterval(prepLectBattre, PREP_LECT_PAS_MS);
  console.log(
    `▶️ LiveSub : affichage du stock — ${prepLectStock.length} mots, ` +
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

// ---------------------------------------------------------------------------
// Messages — mesure uniquement
// ---------------------------------------------------------------------------
//
// Ces deux-la ne sont branches sur aucun reglage et ne servent qu'a prouver que
// l'affichage fait ce qu'il pretend. Sans eux la mesure serait impossible : un
// content script vit dans un monde isole, la console de la page ne peut pas
// lire ses variables.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Le mode direct prend la main : il reinitialise `motsCible` et `nbVisibles`
  // dans son propre toggleOverlay. Si la boucle de lecture continuait, les deux
  // ecriraient dans le meme ruban a 60 Hz. On s'efface -- sans repondre, pour
  // laisser le listener du mode direct repondre comme avant.
  if (request.type === "TOGGLE_SUBTITLES") {
    prepLectArreter();
    return;
  }

  if (request.type === "PREPARATION_MESURES") {
    const v = prepLectMesures.slice().sort((a, b) => a - b);
    const mediane = v.length
      ? v.length % 2
        ? v[(v.length - 1) / 2]
        : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2)
      : null;
    sendResponse({
      success: true,
      n: v.length,
      medianeMs: mediane,
      maxMs: v.length ? v[v.length - 1] : null,
      minMs: v.length ? v[0] : null,
      decalageTestMs: prepLectDecalageTestMs,
      motsAffiches: prepLectVisibles,
      remplacementsVideo: prepVideoRemplacements,
      etat: prepLectEtatAffiche,
    });
    return;
  }

  if (request.type === "PREPARATION_TEST_DECALAGE") {
    prepLectDecalageTestMs = Number(request.ms) || 0;
    prepLectMesures = [];
    prepLectVisibles = -1;
    prepLectEtatAffiche = "";
    console.warn(`🧪 LiveSub : décalage de test = ${prepLectDecalageTestMs} ms`);
    sendResponse({ success: true, decalageTestMs: prepLectDecalageTestMs });
    return;
  }

  if (request.type === "PREPARATION_MESURES_RAZ") {
    prepLectMesures = [];
    sendResponse({ success: true });
    return;
  }
});
