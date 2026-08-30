console.log("🎧 Offscreen document LiveSub est pret !");

// ---------------------------------------------------------------------------
// Ce document ne fait plus qu'UNE chose : la preparation.
// ---------------------------------------------------------------------------
//
// Le mode DIRECT a ete retire (etape 5). Il avait servi a demontrer le triangle
// impossible -- texte synchrone avec le son, son synchrone avec l'image,
// transcription en direct : on ne peut en avoir que deux. Il a prouve ce qu'il
// avait a prouver, il n'a plus de raison de tourner.
//
// Ont disparu avec lui : la fenetre glissante re-transcrite, LocalAgreement-2
// (ruban stable / provisoire), le VAD, la calibration du retard du son, le
// worker Whisper, le graphe audio vers les haut-parleurs, et les filtres de
// texte qui ne servaient qu'a lui (radotage du direct, phrases fantomes).
//
// ⚠️ NE PAS CONFONDRE avec les garde-fous de la PREPARATION, qui RESTENT :
// `prepEstSilence` et `prepEstBoucle`. Ce sont deux mecanismes differents, sur
// deux chemins differents.
//
// ⚠️ CE FICHIER NE TOUCHE JAMAIS chrome.storage. Regle verifiee dans Chrome :
// `chrome.storage` est INDEFINI dans un document offscreen alors que `chrome`
// existe. Une seule ligne qui y touche leve un TypeError AU CHARGEMENT et tue
// tout le reste du fichier, en silence.

// Forme comparable d'un texte : minuscules, sans accents, sans ponctuation,
// espaces reduits. La ponctuation devient un ESPACE et non rien du tout, pour
// que « sous-titres » et « d'Amara » donnent « sous titres » et « d amara ».
//
// Seule rescapee de l'ancien moteur : la preparation s'en sert pour comparer
// des mots (prepOterDoublons) et pour juger la diversite d'un texte
// (prepEstBoucle).
function normaliserTexte(texte) {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")             // accents
    .replace(/[^\p{L}\p{N}\s]/gu, " ")  // ponctuation, tirets, apostrophes...
    .replace(/\s+/g, " ")
    .trim();
}

// ===========================================================================
// MODE « PREPARER D'ABORD » — etape A : constituer le stock, en silence
// ===========================================================================
//
// C'est desormais le SEUL mode de LiveSub. La video defile a `PREP_VITESSE` en
// silence, tout est transcrit d'avance, puis le stock est affiche a l'heure
// pendant la lecture normale.
//
// Tout ce qui appartient a la preparation porte le prefixe `prep` -- c'etait la
// marque d'un mode qui vivait a COTE du direct ; c'est reste, parce que le
// renommer n'apporterait rien et ferait perdre le lien avec l'historique.
//
// ⚠️ CE FICHIER NE TOUCHE JAMAIS chrome.storage. Regle de CLAUDE.md, verifiee
// dans Chrome : `chrome.storage` est INDEFINI dans un document offscreen, et la
// ligne qui l'appelle tue tout le fichier au chargement -- sans erreur visible,
// le bouton Demarrer cesse simplement de repondre. Langue, backend et position
// de depart arrivent donc par message, comme tout le reste.
//
// Ce qu'on fait ici, et rien de plus : capter le son de l'onglet qui defile en
// accelere, le ramener a sa vitesse normale, le decouper en blocs de 30 s de
// CONTENU, les transcrire, et garder les { mot, instant } en memoire.
// L'affichage pendant la lecture, c'est l'etape B.

// Vitesse de defilement. Mesuree le 2026-08-27 : a x2 le texte reste identique
// a 98,6 % (EN) et 94,9 % (FR) de celui obtenu a x1, et le signal restitue
// correle a r = 1,00 avec l'original.
const PREP_VITESSE = 2;

// Taille d'un bloc, en secondes de CONTENU (pas de temps d'horloge).
//
// ⚠️ 15 ET PAS 30, ET C'EST UN RENONCEMENT SUBI, PAS UN CHOIX.
//
// Cote VITESSE, 30 s est nettement meilleur : Whisper complete tout extrait a
// 30 s avant de le traiter, donc un bloc de 15 s paie du silence de
// remplissage. Mesure du 2026-08-27, memes fragments, worker unique, tailles
// alternees :
//   15 s -> 6,15 s par bloc, soit 2,44x le temps reel
//   30 s -> 7,15 s par bloc, soit 4,20x le temps reel  (+16 % de temps pour 2x
//                                                       plus de contenu)
//
// Un plafond de jetons a longtemps interdit d'aller au-dela de 15 s : Whisper
// s'arretait d'ecrire au bout de 60 jetons et coupait la fin du bloc en
// silence. Cette contrainte a disparu deux fois -- d'abord parce que le
// plafond a ete dimensionne sur la duree du bloc, puis DEFINITIVEMENT a
// l'etape 5 : Parakeet est un TRANSDUCTEUR, il emet au rythme des trames
// audio, il n'a pas de quota a atteindre ni a depasser.
//
// ⚠️ MISE A JOUR DU 2026-08-28 (2) : ON PASSE A 20 s, ET C'EST UNE QUESTION DE
// SURVIE, PAS DE CONFORT.
//
// LE PROBLEME CONSTATE. Journaux d'un run reel : trois blocs consecutifs quatre
// fois plus lents que les autres (15,1 s / 26,0 s / 23,3 s au lieu de ~6,5 s),
// puis retour a la normale. A 15 s de contenu, la video a x2 livre un bloc
// toutes les 7,5 s d'horloge et un bloc coute ~6,15 s : la marge est de 1,35 s
// par bloc. Un incident de 40 s de retard demande donc TRENTE blocs pour etre
// rattrape -- c'est-a-dire jamais, a l'echelle d'une video. Le retard ne se
// resorbe pas, il attend la fin et se paie d'un coup.
//
// POURQUOI UN BLOC PLUS GROS VA PLUS VITE. Whisper complete tout extrait a 30 s
// avant de le traiter : l'ENCODEUR coute donc exactement pareil pour 10 s ou
// pour 27 s de contenu. Doubler la taille du bloc, c'est payer deux fois moins
// d'encodeurs par minute de video.
//
// Mesure du 2026-08-28, vrai whisper-tiny fp32 sous Node, piste de 115 s,
// contexte de 3 s inclus, deux passages alternes. On lit les RAPPORTS, pas les
// millisecondes (le CPU de Node n'est pas le WASM de Chrome) :
//
//   bloc    debit      rapport a 15 s
//   10 s     6,77x         0,75
//   15 s     9,00x         1,00   (ce qu'on faisait)
//   20 s    10,80x         1,20
//   25 s    12,46x         1,38
//   27 s    14,92x         1,66
//
// Reporte sur la mesure Chrome de 2,44x a 15 s, 20 s donne ~2,93x. La marge par
// bloc passe de 1,35 s a ~3,2 s, soit un retard rattrape 2,4 fois plus vite, et
// 20 % de debit en plus sur toute la video.
//
// ⚠️ POURQUOI PAS 27 s, QUI SERAIT ENCORE MEILLEUR : la borne des 30 s est un
// MUR, pas une preference. Ce qu'on envoie vaut au pire
//     PREP_BLOC_CONTENU + PREP_RESERVE_FIN + PREP_CONTEXTE
// soit 20 + 5 + 3 = 28 s. A 25 s de bloc on serait a 33 s, et Whisper couperait
// les 3 dernieres secondes SANS RIEN DIRE.
const PREP_BLOC_CONTENU = 20;

// Ce que Whisper attend.
const PREP_TAUX = 16000;

// ---------------------------------------------------------------------------
// LA FIN DE LA VIDEO : un reste court est un reste FAUX
// ---------------------------------------------------------------------------
//
// ⚠️ C'EST LA CAUSE DES FAUTES EN FIN DE VIDEO, ET ELLE EST MESUREE.
//
// A l'arret, la pompe transcrivait TOUT ce qui restait, aussi court que ce
// soit -- le plancher etait a 1 s de contenu. Or un bloc de la preparation n'a
// AUCUN contexte : contrairement au moteur en flux, il n'y a pas de
// recouvrement, chaque bloc est transcrit une fois, seul. Sur un extrait d'une
// seconde, whisper-tiny n'a plus rien pour s'appuyer : il n'ecoute plus, il
// recite.
//
// Mesure du 2026-08-28, vrai whisper-tiny fp32 sous Node, meme extrait (JFK),
// on ne garde que la FIN et on la transcrit seule :
//
//   reste    texte rendu                              verdict
//   0,5 s    « You »                                  invente
//   1,0 s    « God, free. »                           invente (vrai : « your country. »)
//   1,5 s    « for your country. »                    juste
//   2,0 s    « can do for your country. »             juste
//   3,0 s    « Ask what you can do for your country. » juste
//
// La bascule est nette et elle est basse : en dessous de ~1,5 s le modele
// fabrique une phrase credible qui n'a aucun rapport avec le son. Et c'est
// exactement le symptome decrit -- des fautes qui n'apparaissent QUE quand la
// video approche de sa fin, parce que le reste de fin est le SEUL bloc dont la
// duree n'est pas choisie : c'est ce qui tombe.
//
// (Le meme phenomene etait deja note dans content.js, vu dans Chrome le
// 2026-08-27 : « Whisper part en repetition EN FIN DE PISTE et entasse 14 mots
// en 940 ms ». La fusion de blocs qui y repond soigne la lisibilite, pas le
// texte.)
//
// LE CORRECTIF : on ne laisse plus la fin decider de la taille du dernier bloc.
// La pompe garde en reserve PREP_RESERVE_FIN secondes de contenu et ne coupe un
// bloc plein que s'il en reste au moins autant derriere lui. Le dernier bloc
// fait donc toujours entre PREP_RESERVE_FIN et PREP_BLOC_CONTENU +
// PREP_RESERVE_FIN secondes -- jamais 1 s.
//
// 5 s et pas 2 : la bascule mesuree est a ~1,5 s sur de l'anglais propre, et on
// veut de la marge pour du francais bruite (1,55 jeton par mot, et une fin de
// video est souvent musique + generique). 5 s coute une attente de 5 s de
// contenu dans la file -- soit 2,5 s d'horloge a x2 -- et rien d'autre : la
// preparation tourne plus vite que la video, elle a le temps.
//
// Le bloc de fin peut donc atteindre 20 s de contenu. C'est sans danger :
// Parakeet n'a ni fenetre de 30 s ni plafond de jetons -- rien ne borne la
// longueur d'un bloc de ce cote-la.
const PREP_RESERVE_FIN = 5.0;

// En dessous de ca, un reste de fin n'est pas transcrit du tout : il n'y a plus
// aucune chance d'en tirer autre chose qu'une invention.
const PREP_RESTE_MIN_CONTENU = 1.0;

// ---------------------------------------------------------------------------
// Un bloc SANS LE MOINDRE SON n'est pas envoye a Whisper
// ---------------------------------------------------------------------------
//
// Mesure du meme jour, toujours whisper-tiny fp32 : sur du silence numerique
// pur, quelle qu'en soit la duree (1 s, 3 s, 10 s), le modele ecrit « you ».
// Il ecrit toujours quelque chose -- c'est un decodeur, il ne sait pas se taire.
// En francais, c'est la phrase de generique (« Sous-titres realises par… ») qui
// sort. Une video qui se termine par un fondu au silence recolte donc un mot
// invente, pose pile a la fin.
//
// Ce n'est PAS le filtre anti-hallucination que ce fichier s'interdit plus bas :
// on ne juge pas le texte rendu, on constate qu'il n'y a rien a transcrire AVANT
// de demander. Aucun mot ne peut etre perdu par ce test -- s'il n'y a pas de
// son, il n'y a pas de mot.
//
// Les seuils sont volontairement absurdes de severite : -80 dBFS en moyenne ET
// -50 dBFS en crete. De la parole tres basse est 100 fois au-dessus. Une video
// en pause rend exactement 0.
const PREP_SILENCE_RMS = 1e-4;
const PREP_SILENCE_CRETE = 3e-3;

// ---------------------------------------------------------------------------
// Ou couper un bloc : au silence le plus proche, jamais en plein mot
// ---------------------------------------------------------------------------
//
// Une coupure a l'echantillon pres tombe ou elle tombe. La parole occupe la
// plus grande partie du temps, donc une coupure aveugle tombe le plus souvent
// A L'INTERIEUR d'un mot : ce mot est perdu deux fois -- ampute a la fin d'un
// bloc, et ampute au debut du suivant, ou il donne en plus a whisper-tiny une
// attaque qui ne ressemble a rien.
//
// Contrairement au moteur en flux, il n'y a ici aucun recouvrement pour
// rattraper le mot coupe : chaque bloc est transcrit UNE fois. La coupure doit
// donc etre bonne du premier coup.
//
// On recule donc d'au plus PREP_RECUL_COUPE secondes de contenu pour tomber sur
// la tranche la moins bruyante -- entre deux mots, entre deux phrases. Le bloc
// est alors un peu plus court, jamais plus long : rien n'est saute, le reste
// part avec le bloc suivant.
const PREP_RECUL_COUPE = 1.5;   // secondes de CONTENU
const PREP_TRAME_COUPE = 0.02;  // 20 ms : la resolution de la recherche

// ---------------------------------------------------------------------------
// Chaque bloc entend la fin du precedent
// ---------------------------------------------------------------------------
//
// ⚠️ LE DEFAUT DE FOND DU DECOUPAGE EN BLOCS : chaque bloc etait transcrit
// AVEUGLE. Whisper attaquait 15 s de son sans rien savoir de ce qui precede --
// ni la phrase en cours, ni la voix, ni le sujet. C'est exactement l'inverse du
// moteur en flux, ou chaque passe reprend la fenetre depuis son debut.
//
// On lui redonne donc les dernieres secondes du bloc precedent, en AUDIO. Il
// transcrit l'ensemble, et on ne garde que les mots qui tombent apres le
// contexte -- ceux d'avant sont deja au stock.
//
// Mesure du 2026-08-28, vrai whisper-tiny fp32, 9 situations (3 niveaux de
// musique x 3 points de coupe), 198 mots de reference :
//
//   contexte   fautes   WER      temps du bloc
//    0 s        63     31,8 %     1517 ms   (ce qu'on faisait)
//    1 s        58     29,3 %     1541 ms   +2 %
//    2 s        54     27,3 %     1553 ms   +2 %
//    3 s        51     25,8 %     1583 ms   +4 %   <- retenu
//    4 s        51     25,8 %     1589 ms   +5 %
//    6 s        54     27,3 %     1661 ms   +10 %
//
// Un cinquieme des fautes en moins pour 4 % de temps. Le surcout est faible
// parce que Whisper complete tout extrait a 30 s de toute facon : les 3 s en
// plus ne coutent que les quelques mots supplementaires a decoder.
//
// Et ca ne remonte pas indefiniment : a 6 s c'est deja moins bon qu'a 3. Un
// contexte trop long dilue le bloc dans un extrait ou Whisper a le droit de
// s'arreter avant d'y arriver.
//
// ⚠️ La borne des 30 s reste respectee : le plus gros bloc possible fait
// PREP_BLOC_CONTENU + PREP_RESERVE_FIN = 20 s, plus 3 s de contexte = 23 s.
const PREP_CONTEXTE = 3.0;

// Un mot ne tombe jamais pile sur la frontiere. La marge dit de quel cote on
// range celui qui commence juste avant la fin du contexte ; ce qui passe quand
// meme est rattrape par prepOterDoublons.
const PREP_CONTEXTE_MARGE = 0.2;

// ---------------------------------------------------------------------------
// LE GARDE-FOU « RADOTAGE » : un texte qui tourne en boucle est jete
// ---------------------------------------------------------------------------
//
// ⚠️ IL A ETE AJOUTE POUR UNE CAUSE QUI N'EXISTE PLUS, ET IL EST GARDE QUAND
// MEME -- provisoirement, et c'est une decision a prendre separement.
//
// Sa cause : l'AMORCE. On soufflait a Whisper le vocabulaire de la page (titre,
// noms propres) pour qu'il ecrive « Emmanuel Macron » au lieu de l'ecorcher.
// Le prix, mesure : sur du son SANS PAROLE, l'amorce multipliait les mots
// inventes par dix (7 -> 75 sur cinq extraits de silence et de musique seule),
// et toujours sous la meme forme -- une BOUCLE (« The United States, the
// United States, the United… »).
//
// L'amorce est partie a l'etape 4 (c'etait `decoder_input_ids`, propre a
// Whisper ; Parakeet n'a pas d'equivalent), et Whisper lui-meme a l'etape 5.
// Ce filet n'a donc plus de cause connue. On le garde pour l'instant : chaque
// declenchement est journalise AVEC son texte et compte dans prepResume, ce
// qui permettra de trancher sur des mesures plutot que sur une intuition.
//
// La mesure : un texte en boucle a tres peu de mots DISTINCTS. Sur les sorties
// mesurees, une boucle tourne autour de 0,20 a 0,25 de mots distincts, une
// vraie phrase autour de 0,60. Le seuil est pose a 0,35, a mi-chemin et loin
// des deux.
//
// ⚠️ Ce filtre-la juge le texte rendu -- c'est exactement ce que prepTraiterBloc
// s'interdit plus bas, et ce n'est PAS une contradiction : on ne l'ajoute que
// parce qu'on vient d'ajouter la cause. Sans amorce, il ne se declenche jamais.
const PREP_DIVERSITE_MIN = 0.35;

// En dessous, un texte est trop court pour qu'un taux de repetition veuille
// dire quoi que ce soit.
const PREP_BOUCLE_MOTS_MIN = 10;

let prepActif = false;
let prepContext = null;
let prepStream = null;
let prepSource = null;
let prepNoeud = null;
let prepTauxCapture = 48000;

let prepWorker = null;
let prepWorkerPret = false;
let prepAttentes = new Map();
let prepProchainId = 1;

// Position de la video au moment ou elle a commence a defiler, en secondes.
// Elle arrive APRES le demarrage de la capture (le service worker ne la connait
// qu'une fois content.js reellement lance) -- d'ou le drapeau ci-dessous.
let prepPositionDepart = 0;
let prepDepartConfirme = false;

// ---------------------------------------------------------------------------
// L'heure des mots est LUE sur la video, pas deduite du nombre d'echantillons
// ---------------------------------------------------------------------------
//
// ⚠️ CE QUI NE MARCHAIT PAS. L'instant d'un mot valait
// `positionDepart + echantillonsConsommes / taux * VITESSE` : une regle
// d'arithmetique qui suppose que la video avance d'exactement deux secondes par
// seconde d'horloge, du debut a la fin. Elle ne le fait pas. Un rechargement de
// tampon, une coupure publicitaire, un lecteur qui reprend brievement la main
// sur la vitesse (content.js en accepte jusqu'a PREP_RECALAGES_MAX), et la
// capture continue d'empiler du son pendant que `currentTime`, lui, n'avance
// pas.
//
// L'ecart ne se rattrape jamais : il s'AJOUTE. Tout ce qui suit le premier
// incident est date trop tard, et le decalage grandit a chaque incident
// suivant. A l'ecran, c'est du texte juste affiche au mauvais moment -- ce qui
// se lit exactement comme une transcription fausse.
//
// Donc : content.js envoie la position reelle de la video a chaque battement
// (500 ms), et on garde le lien « autant d'echantillons captes <-> la video en
// etait la ». L'heure d'un mot est INTERPOLEE dans cette table. Un arret de la
// video n'avance plus la position, donc il ne decale plus rien.
let prepAncres = [];  // [{ echantillons, position }], les deux croissants

// Une ancre toutes les 500 ms : 7200 pour une heure de video. La borne existe
// pour qu'une seance tres longue ne fasse pas enfler la memoire indefiniment ;
// au-dela on garde une ancre sur deux, ce qui double simplement le pas.
const PREP_ANCRES_MAX = 8000;

// Le vocabulaire de la page (titre + description), tel que content.js l'a releve.

// La fin du bloc precedent, gardee pour la donner en contexte au suivant.
// Au taux de la CAPTURE, comme prepBlocs.
let prepContexteAudio = new Float32Array(0);

// Le son capte, en attente de decoupage. Au taux de la CAPTURE (48 kHz), pas
// encore ramene a la vitesse normale.
let prepBlocs = [];
let prepEnAttente = 0;   // echantillons dans prepBlocs
let prepConsommes = 0;   // echantillons deja partis vers Whisper
let prepArretDemande = false;
let prepPompeEnCours = null;

// Le stock. C'est TOUT ce qu'on garde : un mot, et la seconde de la video ou il
// a ete prononce. Rien sur le disque (regle de l'enonce).
let prepMots = [];

// Temoin de seance : le temps de chaque bloc. Si le dernier a derive de plus de
// 15 % du premier, la machine s'est fatiguee pendant la mesure et les chiffres
// ne valent plus rien (memoire `mesures-whisper-seance-usee`).
let prepTemoins = [];

// Combien de blocs ont probablement ete coupes par le quota de jetons.
let prepBlocsTronques = 0;

// Le NUMERO du bloc dans le journal. Distinct de prepTemoins.length : celui-ci
// ne compte que les blocs transcrits, donc un bloc muet ou en boucle donnait son
// numero au suivant -- deux lignes du journal parlaient du meme numero sans
// parler du meme bloc.
let prepBlocsVus = 0;

// Combien de blocs sont partis en boucle de repetition (et ont donc ete jetes).
let prepBlocsEnBoucle = 0;

// Combien de blocs ont du etre refaits sans l'amorce. C'est le prix de l'amorce,
// en clair : s'il monte, c'est qu'elle gene plus qu'elle n'aide sur cette video.

// La memoire WebAssembly du worker Parakeet, telle qu'il la mesure lui-meme.
// ⚠️ `performance.memory` ne compte QUE le tas JavaScript : les poids du modele
// vivent dans la memoire lineaire du WASM, qui n'y figure pas. C'est le worker
// qui garde une reference sur son objet WebAssembly.Memory et nous renvoie sa
// taille reelle (voir parakeet.worker.js).
let prepMemoireWasmMo = null;

// Combien de fois chaque garde-fou anti-hallucination s'est declenche. Ils sont
// GARDES pour l'instant, mais on veut savoir s'ils servent encore avec un
// transducteur : chaque declenchement est journalise avec son texte, et le
// total est rappele a la fin de la preparation.
let prepBlocsSilencieux = 0;

// Les blocs perdus pour de bon : une exception dans la pompe. C'est ce compteur
// qui repond a « combien de blocs abandonnes ? » -- la ligne rouge dans la
// console est facile a rater, un nombre dans le resume ne l'est pas.
let prepBlocsAbandonnes = 0;

// ⚠️ CHAQUE DECLENCHEMENT D'UN GARDE-FOU, AVEC SON TEXTE.
//
// Les garde-fous sont gardes pour l'instant, mais il faut pouvoir juger s'ils
// servent encore avec un transducteur -- et pour ca il faut VOIR ce qu'ils ont
// jete, pas seulement combien de fois. Le journal de l'offscreen le dit deja,
// mais ce document n'est pas une cible DevTools dans une session pilotee (voir
// CLAUDE.md, « les trois consoles ») : sans cette liste, le texte jete serait
// invisible pour qui ne peut pas ouvrir cette console-la.
let prepGardeFous = [];

// ⚠️ LA PROMESSE DE CHARGEMENT DU MODELE, ET POURQUOI ELLE EXISTE.
//
// Sans elle, un modele qui ne charge pas donnait ceci (mesure du 2026-08-30,
// contre-preuve du volet A : dossier de modele renomme) : la preparation
// demarrait, la barre de progression montait normalement de 0 a 2 min 48 s, et
// la video se terminait sur « ✅ Prêt — 0 mots préparés ». Une coche VERTE sur
// un echec total. C'est exactement la panne que CLAUDE.md decrit : « une barre
// de progression n'est pas une preuve de travail ».
//
// La raison etait mecanique : `prepStatut` ecrit dans l'overlay, mais
// content.js ignore un statut tant que la progression tourne (« Un statut ne
// doit jamais recouvrir la progression »). Le message d'erreur etait donc
// produit, envoye... et jete.
//
// Le seul chemin qui aboutit vraiment a un « ❌ » a l'ecran est celui de
// l'ECHEC AU DEMARRAGE : `demarrerPreparation` rejette -> background.js
// l'attrape -> il envoie PREPARATION_RESTAURER avec `erreur` -> content.js
// affiche « ❌ ... » et remet le lecteur en place. On attend donc le `ready`
// AVANT de rendre la main.
let prepChargement = null;

// L'horloge de la seance : Date.now() au tout premier bloc traite. Sert a dire,
// a chaque bloc, de combien la transcription est en retard sur le defilement.
let prepDepartHorloge = 0;

function prepStatut(texte) {
  console.log("💬 Preparation :", texte);
  chrome.runtime.sendMessage({ type: "PREPARATION_STATUT", texte }).catch(() => {});
}

function prepReinitialiser() {
  prepBlocs = [];
  prepEnAttente = 0;
  prepConsommes = 0;
  prepMots = [];
  prepTemoins = [];
  prepBlocsTronques = 0;
  prepBlocsEnBoucle = 0;
  prepBlocsSilencieux = 0;
  prepBlocsAbandonnes = 0;
  prepGardeFous = [];
  prepChargement = null;
  prepMemoireWasmMo = null;
  prepBlocsVus = 0;
  prepDepartHorloge = 0;
  prepArretDemande = false;
  prepDepartConfirme = false;
  prepPositionDepart = 0;
  prepAncres = [];
  prepContexteAudio = new Float32Array(0);
  prepAttentes.clear();
}

// ---------------------------------------------------------------------------
// La table « echantillons captes <-> position de la video »
// ---------------------------------------------------------------------------

// Combien d'echantillons ont ete captes en tout depuis le debut de
// l'enregistrement -- ceux deja partis vers Whisper PLUS ceux qui attendent.
// C'est le repere commun a tout ce qui suit.
function prepEchantillonsTotal() {
  return prepConsommes + prepEnAttente;
}

// Une position de video vient d'arriver : on la relie a la quantite de son
// captee a cet instant.
//
// ⚠️ Strictement croissante, dans les DEUX colonnes. Un utilisateur ne peut pas
// reculer pendant la preparation (content.js pilote le lecteur), mais un lecteur
// qui se reconstruit peut renvoyer un `currentTime` de 0 pendant une image ou
// deux. Une ancre qui recule ferait reculer l'interpolation avec elle, et
// jetterait tout le stock qui suit dans le passe.
function prepNoterPosition(position) {
  if (!Number.isFinite(position)) return;
  const echantillons = prepEchantillonsTotal();
  const derniere = prepAncres.length ? prepAncres[prepAncres.length - 1] : null;

  if (derniere) {
    if (position <= derniere.position || echantillons <= derniere.echantillons) return;
  }

  prepAncres.push({ echantillons, position });

  // Trop d'ancres : on garde une sur deux. Le pas double, la table reste juste.
  if (prepAncres.length > PREP_ANCRES_MAX) {
    prepAncres = prepAncres.filter((_, i) => i % 2 === 0 || i === prepAncres.length - 1);
  }
}

// La position de la video quand on avait capte `echantillons` echantillons.
//
// Entre deux ancres : interpolation lineaire. Avant la premiere ou apres la
// derniere : on prolonge a la vitesse nominale, faute de mieux -- c'est
// exactement l'ancien calcul, mais il ne s'applique plus qu'aux bords.
function prepPositionDe(echantillons) {
  if (!prepAncres.length) {
    return prepPositionDepart + prepSecondesContenu(echantillons);
  }

  const premiere = prepAncres[0];
  if (echantillons <= premiere.echantillons) {
    return premiere.position - prepSecondesContenu(premiere.echantillons - echantillons);
  }

  const derniere = prepAncres[prepAncres.length - 1];
  if (echantillons >= derniere.echantillons) {
    return derniere.position + prepSecondesContenu(echantillons - derniere.echantillons);
  }

  let bas = 0;
  let haut = prepAncres.length - 1;
  while (haut - bas > 1) {
    const milieu = (bas + haut) >> 1;
    if (prepAncres[milieu].echantillons <= echantillons) bas = milieu;
    else haut = milieu;
  }
  const a = prepAncres[bas];
  const b = prepAncres[haut];
  const largeur = b.echantillons - a.echantillons;
  if (largeur <= 0) return a.position;
  return a.position + ((echantillons - a.echantillons) / largeur) * (b.position - a.position);
}

// Combien d'echantillons de capture font un bloc.
// A x2, 30 s de contenu tiennent dans 15 s d'horloge : c'est bien la vitesse
// qui divise, pas qui multiplie.
function prepEchantillonsParBloc() {
  return Math.round((PREP_BLOC_CONTENU * prepTauxCapture) / PREP_VITESSE);
}

function prepSecondesContenu(echantillons) {
  return (echantillons / prepTauxCapture) * PREP_VITESSE;
}

// ---------------------------------------------------------------------------
// Le worker Whisper de la preparation (le sien, pas celui du direct)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LE MOTEUR DE LA PREPARATION : Parakeet, dans SON worker
// ---------------------------------------------------------------------------
//
// ⚠️ LE WORKER EST TERMINE A LA FIN DE CHAQUE PREPARATION -- CONTRAINTE DE
// MEMOIRE, PAS DE STYLE. Il occupe 1 335 Mo de memoire WebAssembly (mesure a
// l'etape 3 -- et `performance.memory` ne compte PAS cette memoire-la), sur une
// machine qui plafonne a ~2 100 Mo. Le laisser charge pendant toute la lecture
// ne laisserait plus de place a grand-chose. Voir prepTerminerWorker, appele
// par arreterPreparation.
//
// ⚠️ AUCUN REPLI, NULLE PART. Si Parakeet ne charge pas, la preparation echoue
// et le DIT. Il n'y a plus d'autre moteur vers lequel se rabattre de toute
// facon : whisper.worker.js a ete supprime a l'etape 5.
function prepDemarrerParakeet() {
  if (prepWorker) return prepChargement;

  console.log("⏳ Preparation : chargement de Parakeet dans son worker...");
  prepStatut("⏳ Chargement du modèle de transcription…");

  prepWorker = new Worker(chrome.runtime.getURL("parakeet.worker.js"), { type: "module" });

  let charge;
  let echoue;
  prepChargement = new Promise((resolve, reject) => { charge = resolve; echoue = reject; });

  prepWorker.onmessage = (evenement) => {
    const m = evenement.data;
    switch (m.type) {
      case "ready":
        prepWorkerPret = true;
        prepMemoireWasmMo = m.memoireWasmMo ?? null;
        console.log(
          `✅ Preparation : Parakeet pret en ${(m.msChargement / 1000).toFixed(1)} s ` +
            `(ONNX Runtime ${m.versionOrt || "?"}, bundle ${m.bundle}, ${m.fils} fil(s), ` +
            `memoire WASM ${prepMemoireWasmMo === null ? "non mesuree" : prepMemoireWasmMo + " Mo"})`
        );
        charge();
        prepLancerPompe();
        break;
      case "result": {
        const a = prepAttentes.get(m.id);
        prepAttentes.delete(m.id);
        if (m.memoireWasmMo != null) prepMemoireWasmMo = m.memoireWasmMo;
        if (a) a.resolve(m);
        break;
      }
      case "error": {
        const cle = m.id == null ? "init" : m.id;
        const a = prepAttentes.get(cle);
        prepAttentes.delete(cle);
        // ⚠️ Un echec de chargement n'a pas d'`id` : personne ne l'attend, et il
        // passerait donc inapercu. On le fait remonter a l'ecran.
        if (a) {
          a.reject(new Error(m.message));
        } else {
          console.error("❌ Preparation, Parakeet :", m.message);
          prepStatut("❌ Transcription impossible : " + m.message);
          echoue(new Error("Parakeet n'a pas pu charger : " + m.message));
        }
        break;
      }
      default:
        console.log("ℹ️ Preparation, Parakeet :", JSON.stringify(m).slice(0, 200));
    }
  };

  // ⚠️ Une erreur de CHARGEMENT du worker (CSP, import introuvable, dossier de
  // modele absent) n'arrive pas dans onmessage : elle arrive ici. Sans ce
  // gestionnaire, la preparation attendrait un `ready` qui ne viendrait jamais,
  // barre de progression comprise.
  prepWorker.onerror = (evenement) => {
    const err = new Error(evenement.message || "erreur inconnue dans le worker Parakeet");
    for (const a of prepAttentes.values()) a.reject(err);
    prepAttentes.clear();
    console.error("❌ Preparation, worker Parakeet :", err.message);
    prepStatut("❌ Transcription impossible : " + err.message);
    echoue(new Error("Parakeet n'a pas pu charger : " + err.message));
  };

  // `chrome.runtime` existe dans un document offscreen (c'est `chrome.storage`
  // qui n'y est pas). Le worker, lui, est un worker DEDIE : `chrome.*` n'y
  // existe pas du tout. C'est donc ici qu'on construit les URL des modeles.
  prepWorker.postMessage({
    type: "init",
    urls: {
      encodeur: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/encoder-model.int8.onnx"),
      decodeur: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/decoder_joint-model.int8.onnx"),
      vocab: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/vocab.txt"),
      preproc: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/nemo128.onnx"),
      config: chrome.runtime.getURL("models/parakeet-tdt-0.6b-v3/config.json"),
    },
  });

  return prepChargement;
}

// Termine le worker de la preparation et libere ses 1,3 Go. Appele a la fin de
// chaque preparation : sans ca, le modele resterait charge pendant toute la
// lecture, et le mode direct n'aurait plus la place de charger le sien.
function prepTerminerWorker() {
  if (!prepWorker) return;
  console.log(
    `🧹 Preparation : on termine le worker Parakeet ` +
      `(memoire WASM au moment de l'arret : ${prepMemoireWasmMo === null ? "non mesuree" : prepMemoireWasmMo + " Mo"}).`
  );
  prepWorker.terminate();
  prepWorker = null;
  prepWorkerPret = false;
  for (const a of prepAttentes.values()) a.reject(new Error("worker termine"));
  prepAttentes.clear();
}

// Une inference. Rien d'autre a passer que le son.
//
// ⚠️ CE QUI A DISPARU ICI, ET POURQUOI :
//   - `maxJetons` (PREP_JETONS_PAR_S) : `max_new_tokens` est un reglage de
//     Whisper, qui ecrit jeton par jeton jusqu'a un quota. Parakeet est un
//     TRANSDUCTEUR : il emet au rythme des trames audio, il n'a pas de quota a
//     atteindre ni a depasser. Le plafond coupait la fin des blocs (« bloc
//     INCOMPLET — dernier mot a 15,5 s sur 18,6 s ») ; il n'a plus d'objet.
//   - `amorce` (decoder_input_ids) : mecanisme propre a Whisper, qui accepte un
//     « contexte precedent » avant ses jetons de depart. Parakeet n'a pas
//     d'equivalent. Le vocabulaire de la page continue d'arriver dans
//     `prepAmorce` (content.js l'envoie, on ne touche pas a content.js) : il
//     n'est simplement plus utilise, et `demarrerPreparation` le journalise.
//
// ⚠️ LE TAMPON EST TRANSFERE, DONC LE MEME AUDIO NE PEUT PARTIR QU'UNE FOIS.
// C'est ce qui produisait « bloc abandonne — An ArrayBuffer is detached and
// could not be cloned » : l'ancienne passe de secours renvoyait le MEME
// Float32Array apres l'avoir deja transfere. Il n'y a plus qu'une passe, donc
// plus de second envoi -- et si un jour il y en avait un, le garde-fou
// ci-dessous le dit clairement au lieu de laisser passer un message cryptique.
function prepTranscrire(audio) {
  if (!audio.byteLength) {
    throw new Error(
      "tampon audio deja transfere (detache) — un bloc ne peut partir qu'une fois vers le worker"
    );
  }
  const id = prepProchainId++;
  const promesse = new Promise((resolve, reject) => {
    prepAttentes.set(id, { resolve, reject });
  });
  prepWorker.postMessage({ type: "transcribe", id, audio, taux: PREP_TAUX }, [audio.buffer]);
  return promesse;
}

// ---------------------------------------------------------------------------
// Ramener le son a sa vitesse normale
// ---------------------------------------------------------------------------
//
// ⚠️ LE PIEGE, ET IL SE TROMPE DANS LE BON SENS SI ON N'Y PREND PAS GARDE.
// Le reflexe « x2 -> doubler le taux » (declarer 96 kHz) ACCELERE encore au
// lieu de ralentir. Verifie au test a blanc du 2026-08-27 : 6 s de contenu
// revenaient a 1,71 s.
//
// Un buffer declare a un taux PLUS BAS est interprete comme durant plus
// longtemps, donc joue plus lentement. Pour defaire un x2, on declare donc la
// MOITIE du taux de capture : 48 000 / 2 = 24 000 Hz.
//
// Le reechantillonnage lui-meme est confie a OfflineAudioContext, c'est-a-dire
// au resampler de Chrome : on ne veut pas mesurer la qualite d'une
// interpolation ecrite a la main.
async function prepReechantillonner(brut) {
  const tauxDeclare = prepTauxCapture / PREP_VITESSE; // 24 000, PAS 96 000
  const longueur = Math.max(1, Math.floor((brut.length * PREP_TAUX) / tauxDeclare));
  const hors = new OfflineAudioContext(1, longueur, PREP_TAUX);
  const tampon = new AudioBuffer({
    length: brut.length,
    sampleRate: tauxDeclare,
    numberOfChannels: 1,
  });
  tampon.copyToChannel(brut, 0);
  const source = hors.createBufferSource();
  source.buffer = tampon;
  source.connect(hors.destination);
  source.start();
  const rendu = await hors.startRendering();
  return new Float32Array(rendu.getChannelData(0));
}

// ---------------------------------------------------------------------------
// La pompe : un bloc plein -> une inference, une a la fois
// ---------------------------------------------------------------------------

function prepPrendre(taille) {
  const sortie = new Float32Array(taille);
  let ecrit = 0;
  while (ecrit < taille && prepBlocs.length) {
    const tete = prepBlocs[0];
    const reste = taille - ecrit;
    if (tete.length <= reste) {
      sortie.set(tete, ecrit);
      ecrit += tete.length;
      prepBlocs.shift();
    } else {
      sortie.set(tete.subarray(0, reste), ecrit);
      prepBlocs[0] = tete.subarray(reste);
      ecrit += reste;
    }
  }
  prepEnAttente -= ecrit;
  return ecrit === taille ? sortie : sortie.subarray(0, ecrit);
}

// Lire dans la file SANS rien consommer. Sert uniquement a chercher ou couper :
// on doit regarder la fin du bloc avant de decider de sa taille.
function prepRegarder(debut, longueur) {
  const sortie = new Float32Array(longueur);
  let saute = 0;
  let ecrit = 0;
  for (const morceau of prepBlocs) {
    if (ecrit >= longueur) break;
    if (saute + morceau.length <= debut) {
      saute += morceau.length;
      continue;
    }
    const depuis = Math.max(0, debut - saute);
    const prend = Math.min(morceau.length - depuis, longueur - ecrit);
    sortie.set(morceau.subarray(depuis, depuis + prend), ecrit);
    ecrit += prend;
    saute += morceau.length;
  }
  return ecrit === longueur ? sortie : sortie.subarray(0, ecrit);
}

// Le meilleur endroit ou couper un bloc de `taille` echantillons : la tranche
// de 20 ms la moins bruyante dans la derniere PREP_RECUL_COUPE seconde de
// contenu. On rend la taille effective du bloc, toujours <= `taille`.
//
// Quand la parole est continue et qu'aucune tranche ne sort du lot, le minimum
// tombe ou il tombe et on n'a rien perdu : c'est la coupure aveugle d'avant.
function prepTailleJusquAuSilence(taille) {
  const recul = Math.round((PREP_RECUL_COUPE * prepTauxCapture) / PREP_VITESSE);
  const trame = Math.round((PREP_TRAME_COUPE * prepTauxCapture) / PREP_VITESSE);
  if (recul <= trame * 2 || taille <= recul + trame) return taille;

  const zone = prepRegarder(taille - recul, recul);
  if (zone.length < trame * 2) return taille;

  let meilleur = -1;
  let meilleureEnergie = Infinity;
  for (let f = 0; f + trame <= zone.length; f += trame) {
    let energie = 0;
    for (let i = f; i < f + trame; i++) energie += zone[i] * zone[i];
    // `<=` et pas `<` : a energie egale on garde la tranche la PLUS TARDIVE.
    // Sur du silence pur (ou sur un signal parfaitement plat), toutes les
    // tranches se valent -- et le bloc doit alors garder sa taille pleine, pas
    // se faire raccourcir de PREP_RECUL_COUPE a chaque fois pour rien.
    if (energie <= meilleureEnergie) {
      meilleureEnergie = energie;
      meilleur = f;
    }
  }
  if (meilleur < 0) return taille;

  // On coupe au MILIEU de la tranche la plus calme : c'est le point le plus
  // eloigne de la parole qui la precede et de celle qui la suit.
  return taille - recul + meilleur + (trame >> 1);
}

// Les { mot, instant } d'un bloc, en secondes de VIDEO.
//
// `debut` sort de Whisper en secondes depuis le debut du bloc. On le rapporte
// aux positions de video REELLEMENT observees aux deux bouts du bloc (voir
// prepPositionDe) plutot qu'a un compte d'echantillons.
//
// `echelle` vaut 1 quand tout s'est bien passe : la video a avance d'exactement
// la duree de contenu du bloc. Elle ne s'en ecarte que si la video a cale ou
// saute pendant ce bloc-la. On ne la suit alors que dans une fourchette etroite :
// au-dela, l'incident n'est pas une lente derive mais un trou franc, et etirer
// les mots dessus les mettrait tous au mauvais endroit plutot qu'un seul.
// `dureeContexte` : les premieres secondes de l'extrait envoye ne sont PAS ce
// bloc-ci, c'est la fin du precedent (voir PREP_CONTEXTE). Les mots qui y
// tombent sont deja au stock, on les jette.
// Les mots d'un bloc, ramenes a la position REELLE dans la video.
//
// ⚠️ ON NE RECOLLE RIEN ICI, ET C'EST VOULU. Un « mot » de Whisper n'en etait
// pas un (« J'adore, » arrivait en « J » puis « 'adore, ») : l'ancien moteur
// devait les recoller en se servant de l'espace qui precede. Parakeet, lui,
// assemble ses mots a partir du marqueur SentencePiece `▁`, et le worker les
// rend deja entiers, avec un debut, une fin et une confiance. Recoller une
// deuxieme fois ne ferait que casser ce qui est juste.
//
// Le reste du traitement ne change PAS : filtre du contexte, bornage dans le
// bloc, instants croissants, mise a l'echelle sur les positions video observees
// (prepAncres). La sortie garde exactement la meme forme, { mot, instant }.
function prepMotsDuBloc(mots, posDebut, posFin, dureeBloc, dureeContexte = 0) {
  let echelle = dureeBloc > 0 ? (posFin - posDebut) / dureeBloc : 1;
  if (!Number.isFinite(echelle) || echelle < 0.8 || echelle > 1.25) echelle = 1;

  const sortie = [];
  let precedent = 0;
  let horloge = 0; // l'heure dans le repere « contexte + bloc »

  for (const mot of mots || []) {
    const texte = String(mot.text || "").trim();
    if (!texte) continue;

    let t = mot.start_time;
    if (t == null || !Number.isFinite(t)) t = horloge;
    if (t < horloge) t = horloge; // jamais en arriere
    horloge = t;

    // Ce mot appartient au contexte audio : le bloc precedent l'a deja verse au
    // stock.
    if (t < dureeContexte - PREP_CONTEXTE_MARGE) continue;

    let u = t - dureeContexte;
    if (u < 0) u = 0;
    if (u > dureeBloc) u = dureeBloc;
    if (u < precedent) u = precedent;
    precedent = u;

    sortie.push({
      mot: texte,
      instant: Number((posDebut + u * echelle).toFixed(3)),
    });
  }
  return sortie;
}

// Le filet du filtre par l'heure : un mot du contexte qui commence dans la marge
// passe quand meme. On enleve donc les premiers mots neufs qui repetent, dans
// l'ordre, la fin de ce qui est deja au stock.
//
// Trois mots au plus : au-dela, une vraie repetition de la parole (« oui, oui,
// oui ») serait avalee -- et le bloc precedent a ete coupe dans un silence,
// donc un chevauchement long n'a pas lieu d'etre.
function prepOterDoublons(neufs) {
  if (!neufs.length || !prepMots.length) return neufs;
  const norme = (m) => normaliserTexte(String(m || "")).trim();
  const maximum = Math.min(3, neufs.length, prepMots.length);
  for (let k = maximum; k >= 1; k--) {
    let pareil = true;
    for (let i = 0; i < k; i++) {
      const a = norme(prepMots[prepMots.length - k + i].mot);
      const b = norme(neufs[i].mot);
      // Deux morceaux sans lettre ni chiffre ne « se ressemblent » pas : ils
      // sont juste vides tous les deux.
      if (!a || a !== b) { pareil = false; break; }
    }
    if (pareil) return neufs.slice(k);
  }
  return neufs;
}

// Vrai si le texte rendu est une boucle de repetition plutot qu'une phrase.
// Voir PREP_DIVERSITE_MIN : c'est le prix de l'amorce, et le seul cas ou on
// jette du texte.
function prepEstBoucle(mots) {
  if (mots.length < PREP_BOUCLE_MOTS_MIN) return false;
  const formes = [];
  for (const m of mots) {
    const forme = normaliserTexte(String(m.mot || "")).trim();
    if (forme) formes.push(forme);
  }
  if (formes.length < PREP_BOUCLE_MOTS_MIN) return false;
  const distincts = new Set(formes).size;
  return distincts / formes.length < PREP_DIVERSITE_MIN;
}

// Vrai si le bloc ne contient aucun son audible. Deux mesures et pas une : une
// moyenne (RMS) seule serait trompee par un long silence contenant un unique
// craquement, une crete seule par un souffle continu tres bas.
function prepEstSilence(brut) {
  if (!brut.length) return true;
  let somme = 0;
  let crete = 0;
  for (let i = 0; i < brut.length; i++) {
    const v = brut[i];
    somme += v * v;
    const a = v < 0 ? -v : v;
    if (a > crete) crete = a;
  }
  const rms = Math.sqrt(somme / brut.length);
  return rms < PREP_SILENCE_RMS && crete < PREP_SILENCE_CRETE;
}

async function prepTraiterBloc(taille) {
  // Les deux bornes du bloc, EN ECHANTILLONS CAPTES depuis le debut : c'est le
  // repere de la table des ancres. On les releve avant de consommer.
  const debutEchantillons = prepConsommes;

  // Un bloc PLEIN se coupe au silence le plus proche ; un reste de fin part tel
  // quel (il n'y a plus rien apres lui pour reprendre ce qu'on laisserait).
  //
  // ⚠️ « il reste quelque chose derriere » fait partie de la definition : a
  // l'arret, le dernier bloc peut faire exactement la taille d'un bloc plein.
  // Le couper au silence rendrait alors a la file un morceau de moins d'une
  // seconde -- soit exactement le reste court qu'on vient d'interdire.
  const complet = taille === prepEchantillonsParBloc() && prepEnAttente > taille;
  const brut = prepPrendre(complet ? prepTailleJusquAuSilence(taille) : taille);
  if (!brut.length) return;

  prepBlocsVus++;
  prepConsommes += brut.length;
  const dureeBloc = prepSecondesContenu(brut.length);

  // Les positions de video observees aux deux bouts. Elles remplacent le calcul
  // « depart + contenu deja consomme », qui derivait a chaque fois que la video
  // s'arretait sans que la capture s'arrete (voir prepAncres).
  const posDebut = prepPositionDe(debutEchantillons);
  const posFin = prepPositionDe(debutEchantillons + brut.length);

  // ⚠️ RIEN A ECOUTER = RIEN A DEMANDER. Voir PREP_SILENCE_RMS : sur du silence
  // Whisper ecrit quand meme un mot, et ce mot atterrit pile a la fin de la
  // video. On avance quand meme prepConsommes : la zone reste couverte, elle ne
  // porte simplement aucun mot -- ce que prepResume sait deja representer.
  // On garde la fin de CE bloc pour le suivant. Avant tout `await` : entre deux
  // reprises, prepTraiterBloc peut avoir ete rappelee.
  const contexte = prepContexteAudio;
  const dureeContexte = prepSecondesContenu(contexte.length);
  const aGarder = Math.round((PREP_CONTEXTE * prepTauxCapture) / PREP_VITESSE);
  prepContexteAudio =
    brut.length > aGarder ? brut.slice(brut.length - aGarder) : brut.slice();

  // ⚠️ GARDE-FOU 1 sur 2 : LE SILENCE (prepEstSilence). Ce n'est pas un filtre
  // anti-hallucination au sens strict -- on ne juge pas le texte rendu, on
  // constate qu'il n'y a rien a transcrire AVANT de demander. Aucun mot ne peut
  // etre perdu : s'il n'y a pas de son, il n'y a pas de mot. On le garde, et on
  // le compte, pour savoir s'il sert encore.
  if (prepEstSilence(brut)) {
    prepBlocsSilencieux++;
    prepGardeFous.push({
      garde: "silence",
      bloc: prepBlocsVus,
      position: Number(posDebut.toFixed(1)),
      dureeS: Number(dureeBloc.toFixed(1)),
      texte: null, // rien n'a ete demande au modele : il n'y a pas de texte
    });
    console.log(
      `🔇 GARDE-FOU « silence » : bloc ${prepBlocsVus} sans le moindre son ` +
        `(${dureeBloc.toFixed(1)} s a partir de ${posDebut.toFixed(1)} s) — non transcrit, ` +
        `aucun texte concerne (rien n'a ete demande au modele)`
    );
    return;
  }

  // Le contexte devant, le bloc derriere. Whisper transcrit les deux ; seuls
  // les mots qui tombent apres le contexte entrent au stock.
  let ensemble = brut;
  if (contexte.length) {
    ensemble = new Float32Array(contexte.length + brut.length);
    ensemble.set(contexte, 0);
    ensemble.set(brut, contexte.length);
  }

  const debutReech = performance.now();
  const audio = await prepReechantillonner(ensemble);
  const msReech = Math.round(performance.now() - debutReech);

  if (!prepDepartHorloge) prepDepartHorloge = Date.now();

  // Une seule passe. La passe de SECOURS a disparu avec l'amorce : elle
  // existait pour refaire un bloc « sans vocabulaire » quand l'amorce faisait
  // renoncer Whisper en plein bloc. Sans amorce, il n'y a rien a refaire -- et
  // c'est aussi ce qui supprime le second envoi du meme tampon, donc l'erreur
  // « ArrayBuffer is detached ».
  const debut = performance.now();
  const resultat = await prepTranscrire(audio);
  const ms = Math.round(performance.now() - debut);

  const nouveaux = prepOterDoublons(
    prepMotsDuBloc(resultat.words, posDebut, posFin, dureeBloc, dureeContexte)
  );
  const dernierMot = nouveaux.length ? nouveaux[nouveaux.length - 1].instant - posDebut : 0;
  const couvert = dureeBloc > 0 ? dernierMot / dureeBloc : 1;
  const enBoucle = prepEstBoucle(nouveaux);

  prepTemoins.push(ms);

  // ⚠️ GARDE-FOU 2 sur 2 : LE RADOTAGE (prepEstBoucle). C'est le seul endroit
  // de ce fichier ou du texte est jete.
  //
  // Il avait ete ajoute parce qu'on venait d'ajouter sa cause : l'amorce faisait
  // partir whisper-tiny en boucle sur du son sans parole (7 mots inventes sans
  // amorce, 75 avec). L'amorce n'existe plus sur ce chemin, et Parakeet est un
  // transducteur -- il n'a pas de raison de radoter. On le GARDE quand meme
  // pour le moment, et on journalise chaque declenchement AVEC LE TEXTE, pour
  // savoir s'il sert encore. Voir le compte final dans arreterPreparation.
  if (enBoucle) {
    prepBlocsEnBoucle++;
    prepGardeFous.push({
      garde: "radotage",
      bloc: prepBlocsVus,
      position: Number(posDebut.toFixed(1)),
      dureeS: Number(dureeBloc.toFixed(1)),
      texte: nouveaux.map((m) => m.mot).join(" "),
    });
    console.warn(
      `🔁 GARDE-FOU « radotage » : bloc ${prepBlocsVus} a ${posDebut.toFixed(1)} s — ` +
        `${nouveaux.length} mots JETES.\n   texte jete : « ${nouveaux.map((m) => m.mot).join(" ")} »`
    );
    prepStatut(`⚠️ ${prepBlocsEnBoucle} bloc(s) écarté(s) : texte en boucle`);
    return;
  }

  prepMots.push(...nouveaux);

  // ⚠️ DETECTEUR DE TRONCATURE — GARDE EXPRES, MEME S'IL NE DEVRAIT PLUS RIEN
  // TROUVER.
  //
  // Il servait a rendre visible une coupure par `max_new_tokens` : le bloc
  // rendait un texte credible, simplement plus court que l'audio, et rien dans
  // le resultat ne disait « j'ai ete coupe ». Ce plafond n'existe plus sur ce
  // chemin.
  //
  // On ne retire pas le detecteur pour autant : le supprimer rendrait « zero
  // bloc incomplet » vrai par construction, donc sans valeur. En le gardant, le
  // zero est une MESURE. La mention du plafond de jetons, elle, disparait du
  // message : elle n'aurait plus de sens.
  const morceaux = nouveaux.length;
  const dernier = dernierMot;
  if (couvert < 0.9 && morceaux >= 12) {
    console.warn(
      `⚠️ Preparation : bloc ${prepBlocsVus} INCOMPLET — ` +
        `${morceaux} mots, dernier mot a ${dernier.toFixed(1)} s sur ${dureeBloc.toFixed(1)} s ` +
        `(${Math.round(couvert * 100)} % couvert)`
    );
    prepBlocsTronques++;
    prepGardeFous.push({
      garde: "troncature",
      bloc: prepBlocsVus,
      position: Number(posDebut.toFixed(1)),
      dureeS: Number(dureeBloc.toFixed(1)),
      couvert: Number(couvert.toFixed(2)),
      // Rien n'est jete ici : on signale, on garde le texte.
      texte: nouveaux.map((m) => m.mot).join(" "),
    });
    prepStatut(`⚠️ Texte incomplet sur ${prepBlocsTronques} bloc(s)`);
  }

  // ⚠️ CE JOURNAL EST UN INSTRUMENT DE MESURE, PAS UNE DECORATION. Il porte de
  // quoi trancher, sans rien deviner, les deux questions qui se posent quand la
  // preparation traine :
  //   « video » : de combien la video a REELLEMENT avance pendant ce bloc. Si
  //       c'est nettement moins que la duree de contenu, le lecteur a cale --
  //       et c'est le lecteur qu'il faut regarder, pas Whisper.
  //   « file »  : ce qui attend derriere. C'est ca qui se paiera a la fin.
  //   « retard »: l'ecart entre le temps d'horloge ecoule et le temps qu'aurait
  //       pris la video a x2. Il monte quand un bloc est lent et redescend
  //       quand ils sont normaux. S'il ne redescend jamais, la marge est trop
  //       mince -- c'est ce qui a fait passer les blocs de 15 s a 20 s.
  const avanceVideo = posFin - posDebut;
  const fileS = prepSecondesContenu(prepEnAttente);
  const retard =
    (Date.now() - prepDepartHorloge) / 1000 - prepSecondesContenu(prepConsommes) / PREP_VITESSE;
  console.log(
    `📦 Preparation : bloc ${prepBlocsVus} — ` +
      `${dureeBloc.toFixed(1)} s de contenu a partir de ${posDebut.toFixed(1)} s (video) ` +
      `+ ${dureeContexte.toFixed(1)} s de contexte, ` +
      `${nouveaux.length} mots, ${ms} ms ` +
      `(${(dureeBloc / (ms / 1000)).toFixed(2)}x le temps reel) ` +
      `| reech ${msReech} ms | video +${avanceVideo.toFixed(1)} s ` +
      `| file ${fileS.toFixed(1)} s | retard ${retard >= 0 ? "+" : ""}${retard.toFixed(1)} s`
  );

  // Aucun filtre anti-hallucination ici, et c'est deliberé : un filtre qui
  // jette un bloc de 30 s rendrait faux le seul controle simple dont on
  // dispose -- le nombre de mots rapporte a la duree. On garde tout, quitte a
  // voir le probleme, plutot que de le masquer.
}

function prepPeutTraiter() {
  if (!prepWorkerPret) return 0;
  const besoin = prepEchantillonsParBloc();
  const reserve = Math.round((PREP_RESERVE_FIN * prepTauxCapture) / PREP_VITESSE);

  // ⚠️ TANT QUE LA VIDEO DEFILE : on ne coupe un bloc plein que s'il reste de
  // quoi faire un reste DECENT derriere lui. C'est tout le correctif : sans
  // cette reserve, la video peut s'arreter juste apres une coupure et le
  // dernier bloc ne fait alors qu'une poignee de dixiemes de seconde -- une
  // duree sur laquelle whisper-tiny invente (voir PREP_RESERVE_FIN).
  if (!prepArretDemande) {
    return prepEnAttente >= besoin + reserve ? besoin : 0;
  }

  // A L'ARRET : on vide, mais toujours en blocs assez longs.
  //   - il reste plus d'un bloc + la reserve  -> un bloc plein, il restera au
  //     moins la reserve derriere ;
  //   - il reste moins que ca                 -> TOUT part d'un coup, quitte a
  //     faire un bloc de 20 s de contenu. C'est sans danger (Whisper complete
  //     a 30 s) et c'est ce qui garantit qu'aucun reste court n'existe.
  const minimum = Math.round((PREP_RESTE_MIN_CONTENU * prepTauxCapture) / PREP_VITESSE);
  if (prepEnAttente > besoin + reserve) return besoin;
  if (prepEnAttente >= minimum) return prepEnAttente;
  return 0;
}

// Une seule inference en vol, comme dans le moteur en flux -- mais ici on ne
// jette RIEN : ce qui arrive pendant le calcul attend son tour. La preparation
// tourne a 4,2x le temps reel pour un contenu qui arrive a 2x : la file se
// vide plus vite qu'elle ne se remplit, elle ne peut pas diverger.
function prepLancerPompe() {
  if (prepPompeEnCours) return prepPompeEnCours;

  const promesse = (async () => {
    // ⚠️ CE PREMIER `await` N'EST PAS DECORATIF, ET SON ABSENCE A COUTE UN RUN.
    //
    // Le corps d'une fonction async s'execute EN SYNCHRONE jusqu'au premier
    // await. Quand il n'y a rien a traiter, la boucle ci-dessous ne s'execute
    // pas : sans ce `await`, tout le corps -- `finally` compris -- se deroulait
    // avant que `prepPompeEnCours = promesse` ait eu lieu. Le `finally` remettait
    // donc la variable a null AVANT l'affectation, et celle-ci la laissait
    // ensuite pointer pour toujours sur une promesse DEJA RESOLUE.
    //
    // Consequence observee : la toute premiere sollicitation de la pompe tombe
    // sur une file vide (l'audio n'est pas encore arrive), la pompe meurt la, et
    // plus AUCUN bloc n'est jamais transcrit ensuite -- sans erreur, sans trace,
    // avec une barre de progression qui avance normalement jusqu'au bout.
    // Puis `prepViderFile` bouclait a vide et gelait le document offscreen.
    await Promise.resolve();

    try {
      let taille;
      while ((taille = prepPeutTraiter()) > 0) {
        await prepTraiterBloc(taille);
      }
    } catch (err) {
      prepBlocsAbandonnes++;
      console.error("❌ Preparation : bloc abandonne —", err && err.message ? err.message : err);
      prepStatut("⚠️ Un bloc n'a pas pu être transcrit : " + (err && err.message ? err.message : err));
    } finally {
      prepPompeEnCours = null;
    }
  })();

  prepPompeEnCours = promesse;
  return promesse;
}

async function prepViderFile() {
  // La pompe s'arrete quand il ne reste pas de quoi faire un bloc ; a l'arret
  // le critere change, donc on relance tant qu'elle a de quoi travailler.
  //
  // ⚠️ ET ON VERIFIE QU'ELLE AVANCE. Une boucle `while (true)` dont le corps
  // n'attend rien de reel ne rend jamais la main a l'evenementiel : le document
  // offscreen cesse de repondre aux messages, donc le service worker attend sa
  // reponse indefiniment, la popup reste figee, et le lecteur de la page reste
  // a x2. Un blocage parfaitement muet -- exactement ce que ce projet s'interdit.
  while (true) {
    const restantAvant = prepEnAttente;
    await prepLancerPompe();
    if (prepPeutTraiter() === 0) return;
    if (prepEnAttente >= restantAvant) {
      console.warn(
        `⚠️ Preparation : la file n'avance plus (${prepEnAttente} echantillons restants), on s'arrete la`
      );
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Demarrage / arret
// ---------------------------------------------------------------------------

// ⚠️ AUCUNE LANGUE N'EST PASSEE, ET CE N'EST PAS UN OUBLI.
//
// Parakeet detecte la langue tout seul : son vocabulaire ne contient aucun
// jeton de langue, il n'y a rien a lui indiquer. Whisper, lui, en avait besoin
// (`language: "french"` dans les options de generation) -- d'ou l'ancien menu
// deroulant de la popup, retire a l'etape 5 en meme temps que le mode direct.
//
// `options` ne porte plus que `streamId`.
async function demarrerPreparation(options) {
  if (prepActif) {
    console.log("ℹ️ Preparation deja en cours");
    return { success: true, deja: true };
  }

  prepReinitialiser();

  // Le modele d'abord : il met du temps a charger, autant qu'il commence
  // pendant qu'on branche l'audio. Rien ne sera transcrit avant `ready` de
  // toute facon.
  //
  // ⚠️ `options.memoBackend` n'est plus utilise : c'etait le verdict GPU/CPU
  // memorise pour Whisper. Parakeet tourne sur le CPU, sans mesure prealable.
  prepDemarrerParakeet();

  prepStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: options.streamId,
      },
    },
  });

  prepContext = new AudioContext();
  if (prepContext.state === "suspended") await prepContext.resume();
  prepTauxCapture = prepContext.sampleRate;
  console.log("🎛️ Preparation : AudioContext a", prepTauxCapture, "Hz");

  await prepContext.audioWorklet.addModule(chrome.runtime.getURL("preparation.worklet.js"));

  prepSource = prepContext.createMediaStreamSource(prepStream);
  prepNoeud = new AudioWorkletNode(prepContext, "enregistreur-preparation", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  prepSource.connect(prepNoeud);

  // ⚠️ ET C'EST TOUT. Aucun `connect(prepContext.destination)`, aucun
  // MediaStreamAudioDestinationNode, aucun `new Audio()`. C'est ce qui rend la
  // preparation SILENCIEUSE : le son de l'onglet est deja coupe par
  // tabCapture, et rien ici ne le renvoie vers les haut-parleurs.
  //
  // Verifie le 2026-08-27 : un AudioWorklet non relie a une destination recoit
  // quand meme 20,01 s de son sur 20 s (rms 0,131, max 0,863), soit autant que
  // le temoin cable sur la sortie. Le graphe est bien execute.

  prepNoeud.port.onmessage = (evenement) => {
    const m = evenement.data;

    // Combien de canaux l'onglet nous envoie reellement. En mono, la moyenne du
    // worklet ne change rien ; en stereo, c'est elle qui recupere la voix
    // centrale au lieu d'un seul cote (voir preparation.worklet.js).
    if (m.type === "canaux") {
      console.log(`🎚️ Preparation : l'onglet arrive en ${m.nombre} canal(aux)`);
      chrome.runtime
        .sendMessage({ type: "PREPARATION_STATUT", texte: `🎚️ ${m.nombre} canal(aux) captés` })
        .catch(() => {});
      return;
    }

    if (m.type !== "audio") return;

    // Tant que la position de depart n'est pas connue, on JETTE : ce son-la est
    // celui d'avant le passage en accelere (video encore a x1, ou a l'arret).
    // Le garder decalerait tous les instants du stock.
    if (!prepDepartConfirme) return;

    prepBlocs.push(m.bloc);
    prepEnAttente += m.bloc.length;
    prepLancerPompe();
  };

  // ⚠️ ON ATTEND QUE LE MODELE SOIT LA AVANT DE RENDRE LA MAIN.
  //
  // Le chargement a demarre tout en haut de cette fonction, en parallele du
  // branchement audio : on ne perd donc que ce qui depasse. Mais on ne rend
  // « success » qu'une fois le modele pret -- sinon un echec de chargement
  // devient une preparation qui tourne dans le vide avec une belle barre de
  // progression (voir prepChargement).
  //
  // AUCUN REPLI VERS WHISPER ICI NI AILLEURS : si ca ne charge pas, ca echoue.
  try {
    await prepChargement;
  } catch (err) {
    console.error("❌ Preparation : abandon au demarrage —", err.message);
    prepTerminerWorker();
    try {
      prepNoeud.port.postMessage("stop");
      prepSource.disconnect();
      prepNoeud.disconnect();
    } catch (e) { /* deja debranche */ }
    if (prepStream) {
      prepStream.getTracks().forEach((piste) => { piste.stop(); piste.enabled = false; });
      prepStream = null;
    }
    if (prepContext) { prepContext.close().catch(() => {}); prepContext = null; }
    prepSource = null;
    prepNoeud = null;
    prepActif = false;
    throw err; // -> background.js -> PREPARATION_RESTAURER { erreur } -> « ❌ » a l'ecran
  }

  prepActif = true;
  console.log("✅ Preparation : capture silencieuse demarree");
  return { success: true };
}

async function arreterPreparation() {
  if (!prepActif) {
    return { success: true, ...prepResume() };
  }

  console.log("⏸️ Preparation : arret");
  prepArretDemande = true;

  // ⚠️ CE QUI SUIT REPOND A UNE QUESTION PRECISE : « l'attente a la fin, c'est le
  // dernier bloc qui est lent, ou c'est la file qui se vide ? » On releve donc
  // l'heure exacte ou la video se termine et ce qui reste a traiter a cet
  // instant, pour pouvoir comparer avec l'heure du dernier bloc.
  const heureFinVideo = Date.now();
  const fileALaFin = prepSecondesContenu(prepEnAttente);
  const blocsAvant = prepTemoins.length;
  console.log(
    `🏁 Preparation : la video est finie. Il reste ${fileALaFin.toFixed(1)} s de contenu ` +
      `en file (${blocsAvant} blocs deja traites).`
  );

  // 1. Demander au worklet de rendre son tampon, puis debrancher la source :
  //    plus rien n'arrive apres ce point.
  try {
    prepNoeud.port.postMessage("stop");
  } catch (err) {
    console.warn("Preparation : worklet deja arrete");
  }
  await new Promise((r) => setTimeout(r, 250));

  try {
    prepSource.disconnect();
    prepNoeud.disconnect();
  } catch (err) {
    console.warn("Preparation : noeuds deja debranches");
  }

  if (prepStream) {
    prepStream.getTracks().forEach((piste) => {
      piste.stop();
      piste.enabled = false;
    });
    prepStream = null;
  }

  // 2. Transcrire ce qui reste AVANT de fermer : la fin de la video est
  //    justement le morceau qu'on perdrait sans ca.
  try {
    await prepViderFile();
  } catch (err) {
    console.error("❌ Preparation : fin de file en echec —", err);
  }

  // 3. Fermer. LE WORKER D'ABORD : c'est lui qui tient les 1,3 Go. Tant qu'il
  //    vit, le mode direct n'a pas la place de charger le sien.
  prepTerminerWorker();

  if (prepContext) {
    prepContext.close().catch(() => {});
    prepContext = null;
  }
  prepSource = null;
  prepNoeud = null;
  prepActif = false;

  const apres = Math.round((Date.now() - heureFinVideo) / 1000);
  console.log(
    `⏱️ Preparation : ${apres} s d'attente APRES la fin de la video, ` +
      `pour ${prepTemoins.length - blocsAvant} bloc(s) restant(s) et ${fileALaFin.toFixed(1)} s de contenu. ` +
      (fileALaFin > PREP_BLOC_CONTENU
        ? "⚠️ La file avait pris du retard PENDANT la video — ce n'est pas le dernier bloc qui est lent."
        : "La file etait a jour : l'attente est celle du dernier bloc, rien de plus.")
  );

  const resume = prepResume();
  console.log(
    `🕳️ Preparation : ${resume.trous.nombre} trou(s) de plus de ${PREP_TROU_VISIBLE} s dans le stock, ` +
      `le pire ${resume.trous.pire.toFixed(1)} s, ${resume.trous.videS.toFixed(1)} s d'ecran vide au total. ` +
      `(boucles ${prepBlocsEnBoucle}, tronques ${prepBlocsTronques})`
  );

  // ⚠️ LE COMPTE DES GARDE-FOUS. Ils sont gardes pour l'instant ; ce sont ces
  // trois chiffres qui diront s'ils servent encore maintenant que le moteur est
  // un transducteur. Chaque declenchement a ete journalise plus haut AVEC le
  // texte concerne.
  console.log(
    `🛡️ Preparation, garde-fous : silence ${prepBlocsSilencieux} bloc(s), ` +
      `radotage ${prepBlocsEnBoucle} bloc(s) jete(s), ` +
      `troncature ${prepBlocsTronques} bloc(s) signale(s) — sur ${prepBlocsVus} bloc(s) vus. ` +
      (prepBlocsEnBoucle === 0 && prepBlocsTronques === 0
        ? "Aucun filtre de texte n'a mordu."
        : "⚠️ Au moins un filtre a mordu : lire les lignes 🔁 / ⚠️ ci-dessus.")
  );
  console.log(
    `✅ Preparation terminee : ${resume.nbMots} mots, ` +
      `${resume.dureeCouverteS.toFixed(1)} s couvertes, ` +
      `${resume.motsParSeconde.toFixed(2)} mots/s`
  );
  return { success: true, ...resume };
}

// Ce que le service worker et l'overlay ont besoin de savoir. Le stock lui-meme
// (prepMots) RESTE ICI, en memoire : c'est l'etape B qui viendra le chercher.
// ⚠️ LA MESURE DU SYMPTOME, ET PAS DE SON EXPLICATION. « L'overlay disparait »
// se traduit ici par : un ecart de plus de BLOC_APRES_PAROLE secondes entre deux
// mots consecutifs du stock. C'est le seul chiffre qui dit si le probleme est
// regle, et il ne depend d'aucune theorie sur sa cause.
const PREP_TROU_VISIBLE = 3.0; // = BLOC_APRES_PAROLE de content.js

function prepTrousDuStock() {
  if (!prepMots.length) return { nombre: 0, pire: 0, videS: 0 };
  let nombre = 0, pire = 0, videS = 0;
  let precedent = prepMots[0].instant;
  for (let i = 1; i < prepMots.length; i++) {
    const trou = prepMots[i].instant - precedent;
    if (trou > PREP_TROU_VISIBLE) {
      nombre++;
      videS += trou - PREP_TROU_VISIBLE;
      if (trou > pire) pire = trou;
    }
    precedent = prepMots[i].instant;
  }
  return { nombre, pire, videS };
}

function prepResume() {
  // La zone preparee se lit sur la video, pas sur le compteur d'echantillons :
  // c'est elle qui dit jusqu'ou l'affichage a le droit de promettre du texte.
  const dureeCouverteS = Math.max(0, prepPositionDe(prepConsommes) - prepPositionDepart);
  const premier = prepTemoins.length ? prepTemoins[0] : null;
  const dernier = prepTemoins.length ? prepTemoins[prepTemoins.length - 1] : null;
  const derive = premier && dernier ? Math.round(((dernier - premier) / premier) * 100) : null;

  return {
    nbMots: prepMots.length,
    dureeCouverteS,
    positionDepart: prepPositionDepart,
    motsParSeconde: dureeCouverteS > 0 ? prepMots.length / dureeCouverteS : 0,
    nbBlocs: prepTemoins.length,
    blocsTronques: prepBlocsTronques,
    blocsEnBoucle: prepBlocsEnBoucle,
    // ⚠️ AJOUTE POUR POUVOIR MESURER SANS LA CONSOLE DE L'OFFSCREEN. Ce
    // document n'est pas une cible DevTools dans une session pilotee (voir
    // CLAUDE.md, « les trois consoles ») : sans ces champs, « zero bloc
    // abandonne » ne serait qu'une affirmation.
    blocsVus: prepBlocsVus,
    blocsAbandonnes: prepBlocsAbandonnes,
    blocsSilencieux: prepBlocsSilencieux,
    memoireWasmMo: prepMemoireWasmMo,
    workerVivant: prepWorker !== null,
    gardeFous: prepGardeFous,
    trous: prepTrousDuStock(),
    // Contre-preuve : si la capture ne recevait rien, cette liste serait vide.
    premiersMots: prepMots.slice(0, 30),
    // Temoin de seance : au-dela de 15 % de derive, la mesure est a jeter.
    temoins: { premierMs: premier, dernierMs: dernier, derivePourcent: derive, tous: prepTemoins },
  };
}

// ---------------------------------------------------------------------------
// Messages — un listener A PART
// ---------------------------------------------------------------------------
//
// Un second addListener plutot que des branches ajoutees dans le premier : le
// listener du mode direct n'est pas touche d'une ligne. Chrome livre le message
// aux deux, et comme les types ne se recouvrent pas, un seul repond.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "START_PREPARATION") {
    demarrerPreparation(request)
      .then(sendResponse)
      // ⚠️ Meme regle que pour START_CAPTURE : tout `return true` doit avoir un
      // catch qui REPOND. Sans lui, une erreur laisse le service worker en
      // attente indefinie et le bouton ne repond plus, sans le moindre message.
      .catch((err) => {
        console.error("❌ demarrerPreparation a rejete :", err);
        prepActif = false;
        sendResponse({
          success: false,
          error: "La capture silencieuse a echoue : " + (err && err.message ? err.message : err),
        });
      });
    return true;
  }

  // La position de la video. Le PREMIER message debloque l'enregistrement et
  // fixe le depart ; tous les suivants (content.js en envoie un par battement,
  // soit toutes les 500 ms) alimentent la table des ancres.
  //
  // ⚠️ `prepPositionDepart` ne se remet PAS a jour a chaque message. C'est la
  // borne basse de la zone preparee : la deplacer en cours de route ferait
  // avancer le debut de la zone au fur et a mesure de la video, et l'affichage
  // finirait par declarer « avant la zone preparee » tout ce qu'il vient de
  // preparer.
  if (request.type === "PREPARATION_POSITION") {
    const position = Number(request.position) || 0;
    if (!prepDepartConfirme) {
      prepPositionDepart = position;
      prepDepartConfirme = true;
      console.log("📍 Preparation : depart a", prepPositionDepart.toFixed(2), "s");
    }
    prepNoterPosition(position);
    sendResponse({ success: true });
    return;
  }

  if (request.type === "STOP_PREPARATION") {
    arreterPreparation()
      .then(sendResponse)
      .catch((err) => {
        console.error("❌ arreterPreparation a rejete :", err);
        sendResponse({ success: false, error: String((err && err.message) || err) });
      });
    return true;
  }

  // Lecture du stock, pour verification (et, plus tard, pour l'etape B).
  if (request.type === "PREPARATION_RESUME") {
    sendResponse({ success: true, ...prepResume() });
    return;
  }
});

// ---------------------------------------------------------------------------
// Etape B : livrer le stock a content.js
// ---------------------------------------------------------------------------
//
// `prepResume` ne rend que les 30 premiers mots -- c'est un resume, fait pour
// tenir dans une console. L'affichage pendant la lecture a besoin de TOUT, plus
// les bornes de la zone preparee (c'est elle, et pas l'instant du dernier mot,
// qui dit jusqu'ou l'affichage peut promettre quelque chose : une fin de video
// silencieuse est preparee sans porter un seul mot).
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "PREPARATION_STOCK_OFFSCREEN") {
    sendResponse({
      success: true,
      mots: prepMots,
      positionDepart: prepPositionDepart,
      dureeCouverteS: Math.max(0, prepPositionDe(prepConsommes) - prepPositionDepart),
    });
    return;
  }
});
