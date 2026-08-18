console.log("🎧 Offscreen document LiveSub est pret !");

let audioContext = null;
let mediaStream = null;
let isCapturing = false;
let audioElement = null;
let vad = null;
let analyser = null;

// Noeud de retard insere UNIQUEMENT sur le chemin des haut-parleurs.
// Voir le montage du graphe dans startCapture : c'est la que se joue toute la
// fonctionnalite, et c'est la qu'il ne faut pas se tromper de branche.
let delayNode = null;

// ---------------------------------------------------------------------------
// Calibration automatique du retard
// ---------------------------------------------------------------------------
//
// Le but, en langage clair : quand un sous-titre apparait, l'utilisateur doit
// etre en train d'entendre le PREMIER mot de ce sous-titre, pas le dernier. Il
// doit pouvoir lire et ecouter en meme temps.
//
// Le bon retard est donc l'ecart entre le DEBUT du segment et le moment ou son
// texte s'affiche :
//     retard = duree du segment + temps de transcription (+ transport)
// Soit, en pratique, 8 a 12 s -- et pas 2 s. Deux secondes, c'est l'ecart
// depuis la FIN du segment : avec ce reglage, l'utilisateur a deja fini
// d'entendre la phrase quand le texte arrive.
//
// On ne devine pas ces valeurs : les deux reperes sont deja mesures (voir
// debutSegment dans transcrireSegment), on les lit.
let modeRetard = 0; // 0 (desactive) | un nombre de secondes | "auto"
let echantillonsRetard = [];
let retardApplique = null; // renseigne des que la calibration a tranche

// « ✅ Pret » ne se dit qu'une fois par capture : ensuite l'overlay appartient
// aux vrais sous-titres.
let statutPretEnvoye = false;

// ---------------------------------------------------------------------------
// Messages du service worker
// ---------------------------------------------------------------------------
//
// ⚠️ Ce listener s'enregistre AVANT tout le reste, et notamment avant la
// creation du worker Whisper. background.js n'attend que 500 ms entre la
// creation de ce document et son premier message : tout ce qui retarde
// l'enregistrement du listener fait echouer le demarrage de la capture avec
// « Le module audio n'a pas repondu ». (Vu pour de vrai : le worker Whisper
// place avant suffisait a passer a cote de la fenetre.)
//
// C'est aussi la bonne separation : un Whisper lent ou casse ne doit jamais
// empecher la capture audio de demarrer.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("📩 Offscreen a recu un message :", request);

  if (request.type === "START_CAPTURE") {
    // On repond APRES le demarrage reel. Avant, on repondait "success" tout de
    // suite sans attendre : si getUserMedia echouait ensuite, l'erreur restait
    // dans cette console et le background enregistrait quand meme "actif" --
    // la popup affichait "✅ Actif" alors que rien ne capturait.
    startCapture(
      request.streamId,
      request.memoBackend,
      request.langue,
      request.retard,
      request.retardCalibre
    ).then(sendResponse);
    return true; // reponse asynchrone
  }

  // La langue a change dans la popup pendant qu'on capture. On ne touche a
  // rien d'autre : le segment en cours de transcription part avec l'ancienne
  // langue, le suivant prendra la nouvelle.
  if (request.type === "LANGUE") {
    langueCourante = request.langue;
    console.log("🗣️ Langue des sous-titres :", langueCourante);
    return; // pas de reponse attendue
  }

  // Le retard du son a change dans la popup pendant qu'on capture. Le noeud
  // existe deja dans le graphe : il suffit de changer sa valeur, le son
  // s'ajuste sans coupure et sans redemarrage.
  if (request.type === "RETARD") {
    modeRetard = request.retard ?? 0;

    if (modeRetard === "auto") {
      // On repart d'une calibration neuve : le service worker vient d'effacer
      // l'ancienne mesure, on remet le son a plat et on remesure.
      echantillonsRetard = [];
      retardApplique = null;
      if (delayNode) delayNode.delayTime.value = 0;
      console.log("⏱️ Retard du son : auto (calibration en cours)");
    } else {
      // Reglage manuel : il fige la valeur et coupe toute calibration.
      retardApplique = Number(modeRetard) || 0;
      if (delayNode) delayNode.delayTime.value = retardApplique;
      console.log("⏱️ Retard du son :", retardApplique, "s");
    }
    return; // pas de reponse attendue
  }

  if (request.type === "STOP_CAPTURE") {
    // Meme raison : on ne confirme l'arret qu'une fois tout relache.
    stopCapture().then(() => sendResponse({ success: true }));
    return true; // reponse asynchrone
  }
});

// ---------------------------------------------------------------------------
// Whisper : le worker de transcription
// ---------------------------------------------------------------------------
//
// Le VAD (plus bas) decoupe la parole en segments ; on les envoie ici. Whisper
// tourne dans un Web Worker et PAS dans ce document : l'inference bloque le fil
// sur lequel elle tourne, et ce fil-ci fait tourner l'AudioContext, le worklet
// du VAD et la redirection du son vers les haut-parleurs. Une inference ici
// hacherait le son de l'onglet.
//
// Pour l'instant le texte part seulement dans cette console. L'overlay
// (content.js) viendra apres.

// Le worker n'est PAS cree au chargement du script, mais au demarrage de la
// capture (voir demarrerWhisper). Le creer ici rendait le document offscreen
// injoignable : background.js n'attend que 500 ms entre la creation du document
// et son premier message, et la capture echouait sur « Le module audio n'a pas
// repondu ». Whisper n'a de toute facon rien a faire tant qu'on ne capture pas.
let whisperWorker = null;

// Chaque segment envoye recoit un numero ; le worker le renvoie avec le texte,
// ce qui permet de retrouver a quel segment la reponse correspond.
let prochainSegmentId = 1;
const segmentsEnCours = new Map();

// Segments deja partis au worker mais dont on ne veut plus le texte : le filet
// de securite de transcrireSegment les a sortis de la file. On ne peut pas
// annuler un travail deja envoye, alors on note son numero et on jettera sa
// reponse au retour.
const segmentsAbandonnes = new Set();

// Compteurs de la capture en cours, remis a zero au demarrage. Ils servent au
// diagnostic : « combien de parole a-t-on perdue au demarrage ? »
let segmentsIgnoresAttente = 0; // jetes parce que Whisper n'etait pas pret
let segmentsIgnoresFile = 0;    // jetes parce que la file debordait
let segmentsIgnoresSilence = 0; // jetes parce que quasiment pas de parole dedans
let sousTitresRejetes = 0;      // textes recus mais refuses (radotage, phrase fantome)

// Renseigne quand le worker a fini de charger le modele.
//
// Tant que c'est faux, les segments sont JETES (voir transcrireSegment). Avant,
// ils partaient quand meme et le worker les empilait : au premier lancement sur
// une machine (telechargement du modele + mesure GPU/CPU, ~90 s), toute cette
// parole se deversait d'un coup des que Whisper devenait pret -- une minute de
// sous-titres perimes qui defilaient. Mieux vaut ne rien afficher.
let whisperPret = false;

// Langue parlee dans la video, choisie par l'utilisateur dans la popup.
//
// Elle nous arrive du service worker : dans START_CAPTURE au demarrage, puis
// par le message LANGUE si l'utilisateur en change en cours de route. On ne lit
// pas chrome.storage d'ici, pour la meme raison que le backend (voir plus bas).
//
// La valeur initiale n'est qu'un filet : en pratique START_CAPTURE arrive
// toujours avant le premier segment.
let langueCourante = "french";

// ⚠️ Le backend mesure (GPU ou CPU) est memorise dans chrome.storage, mais PAS
// depuis ici : dans un document offscreen, chrome.storage s'est revele non
// fiable. Selon les fois, `chrome.storage.local.get()` renvoie un resultat vide
// alors que la cle existe, ou ne repond jamais du tout -- et dans ce dernier
// cas le `await` gelait le demarrage de Whisper pour de bon.
//
// C'est donc le service worker qui lit et ecrit la mesure :
//   - il nous passe le verdict connu dans le message START_CAPTURE ;
//   - on lui renvoie le verdict mesure par WHISPER_BACKEND.
// Les messages, eux, marchent parfaitement depuis un offscreen.

// Message d'etat vers l'overlay de la page : « le modele charge », « je
// calibre »... Sans ca, l'utilisateur voit « Ecoute du son en cours... » pendant
// une minute au premier lancement et croit que c'est casse.
//
// Meme chemin que les sous-titres -- offscreen -> service worker -> content.js --
// parce qu'un document offscreen n'a pas acces a chrome.tabs. Le .catch() vide
// est normal : si personne n'ecoute (capture deja arretee), ce n'est pas une
// erreur, et un statut perdu n'a aucune consequence.
function envoyerStatut(texte) {
  console.log("💬 Statut :", texte);
  chrome.runtime.sendMessage({ type: "STATUT", texte }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Garde-fous sur le TEXTE recu de Whisper
// ---------------------------------------------------------------------------
//
// Meme avec un segment bien rempli, whisper-tiny peut encore inventer. Deux
// formes, tres reconnaissables, et deux filtres separes :
//   - le radotage : il part en boucle sur les memes mots ;
//   - la phrase fantome : il recite un morceau de ses donnees d'entrainement
//     (des sous-titres YouTube), toujours la meme poignee de phrases.
//
// ⚠️ Regle absolue ici : un filtre qui supprime du VRAI texte ne se voit pas --
// le sous-titre manque, sans erreur, sans trace. Chaque rejet est donc
// journalise avec sa raison ET le texte rejete, pour qu'un faux positif soit
// visible en console.

// Forme comparable d'un texte : minuscules, sans accents, sans ponctuation,
// espaces reduits. La ponctuation devient un ESPACE et non rien du tout, pour
// que « sous-titres » et « d'Amara » donnent « sous titres » et « d amara ».
function normaliserTexte(texte) {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")             // accents
    .replace(/[^\p{L}\p{N}\s]/gu, " ")  // ponctuation, tirets, apostrophes...
    .replace(/\s+/g, " ")
    .trim();
}

// Nombre de mots en dessous duquel on ne juge pas la diversite : sur une phrase
// courte, un vocabulaire pauvre est normal (« oui, oui, oui d'accord »).
const RADOTAGE_MOTS_MIN = 8;

// Part de mots DIFFERENTS en dessous de laquelle le texte radote. 0,40 veut
// dire : moins de 4 mots distincts pour 10 mots ecrits.
const RADOTAGE_DIVERSITE_MIN = 0.4;

// Nombre de repetitions COLLEES tolerees pour un meme mot (« non non non... »).
const RADOTAGE_SUITE_MAX = 5;

function estUnRadotage(texte) {
  const mots = normaliserTexte(texte).split(" ").filter(Boolean);
  if (mots.length === 0) return false;

  // 1. Vocabulaire trop pauvre pour la longueur du texte.
  if (mots.length >= RADOTAGE_MOTS_MIN) {
    const differents = new Set(mots).size;
    if (differents / mots.length < RADOTAGE_DIVERSITE_MIN) return true;
  }

  // 2. Le meme mot colle a lui-meme un nombre anormal de fois.
  let suite = 1;
  for (let i = 1; i < mots.length; i++) {
    suite = mots[i] === mots[i - 1] ? suite + 1 : 1;
    if (suite > RADOTAGE_SUITE_MAX) return true;
  }

  return false;
}

// Les phrases que whisper-tiny recite quand il n'a rien entendu. Elles sont
// ecrites sous leur forme NORMALISEE (voir normaliserTexte) : c'est a cette
// forme-la qu'on compare.
//
// ⚠️ La comparaison est une EGALITE sur le sous-titre entier, jamais une
// inclusion. « Merci d'avoir regardé cette vidéo, maintenant passons a la
// suite » est de la vraie parole et doit passer ; seule la phrase toute seule
// est une hallucination.
const PHRASES_FANTOMES = [
  // Francais
  "sous titres realises par la communaute d amara org",
  "sous titrage societe radio canada",
  "merci d avoir regarde cette video",
  "merci d avoir regarde",
  "n oubliez pas de vous abonner",
  "abonnez vous",
  "sous titrage st 501",
  // Anglais
  "thank you for watching",
  "thanks for watching",
  "don t forget to subscribe",
  "please subscribe to my channel",
  "subscribe to my channel",
  // Marqueurs que Whisper produit sur du son sans parole. « you » seul en fait
  // partie : c'est sa sortie la plus frequente sur du silence.
  "music",
  "musique",
  "blank audio",
  "you",
];

function estPhraseFantome(texte) {
  // Rien que des notes de musique : la normalisation les effacerait (ce ne sont
  // ni des lettres ni des chiffres), donc on regarde le texte brut.
  if (/^[\s♪♫♬♩]+$/u.test(texte)) return true;

  return PHRASES_FANTOMES.includes(normaliserTexte(texte));
}

function surMessageWhisper(event) {
  const message = event.data;

  switch (message.type) {
    case "ready": {
      whisperPret = true;
      const ou = message.backend === "webgpu" ? "GPU (WebGPU)" : "CPU (WASM)";
      console.log(`✅ Whisper pret en ${Math.round(message.ms / 1000)} s, sur ${ou}`);
      if (message.mesures) {
        const chiffre = (ms) => (ms == null ? "indisponible" : `${(ms / 1000).toFixed(2)} s`);
        console.log(
          `   (premiere mesure : GPU ${chiffre(message.mesures.webgpu)} / ` +
            `CPU ${chiffre(message.mesures.wasm)} -- verdict memorise)`
        );
      }
      // Au service worker de le ranger : voir le commentaire plus haut.
      chrome.runtime.sendMessage({
        type: "WHISPER_BACKEND",
        backend: message.backend,
        signature: message.signature,
      });

      // On dit a l'utilisateur ou on en est. Le modele est pret, mais en mode
      // auto non calibre il reste une etape avant que le son soit aligne :
      // autant l'annoncer plutot que de laisser l'overlay muet.
      if (modeRetard === "auto" && retardApplique === null) {
        envoyerStatut("🎚️ Calibration du décalage…");
      } else if (!statutPretEnvoye) {
        statutPretEnvoye = true;
        envoyerStatut("✅ Prêt");
      }
      break;
    }

    case "progress":
      // Telechargement du modele, au premier lancement.
      console.log(`⬇️  Whisper : ${message.fichier} ${message.pourcent} %`);
      envoyerStatut(`⬇️ Téléchargement du modèle : ${Math.round(message.pourcent)} %`);
      break;

    case "info":
      // Repli d'un backend sur l'autre, mesure en cours... Non bloquant.
      console.log(`ℹ️  Whisper : ${message.message}`);
      break;

    case "result": {
      // Segment sorti de la file par le filet de securite (voir
      // transcrireSegment) : son texte est trop vieux pour etre affiche, et il
      // ne doit pas non plus servir de mesure de calibration. On le jette ici,
      // au retour, parce qu'un travail deja parti au worker ne se rappelle pas.
      if (segmentsAbandonnes.has(message.id)) {
        segmentsAbandonnes.delete(message.id);
        console.log(`   (resultat du segment #${message.id} ignore : abandonne)`);
        break;
      }

      const segment = segmentsEnCours.get(message.id);
      segmentsEnCours.delete(message.id);
      surveillerFile(); // la file se vide aussi ici, pas seulement a l'envoi

      // Calibration du retard. ⚠️ AVANT le filtre des segments sans texte :
      // un segment vide n'a rien a afficher, mais c'est une mesure de temps
      // parfaitement valable -- et s'en priver rallongerait la calibration.
      if (modeRetard === "auto" && retardApplique === null && segment) {
        // ⚠️ On calibre sur le PIRE CAS, pas sur ce qu'on vient d'entendre.
        //
        // Mesurer la duree reelle du segment (Date.now() - debutSegment) donnait
        // une valeur qui dependait du CONTENU : 6,7 s sur un passage a segments
        // courts, 9,1 s sur de la parole continue. La valeur calibree sur l'un
        // etait fausse pour l'autre -- et elle est memorisee pour de bon.
        //
        // Or la duree d'un segment ne depasse JAMAIS DUREE_MAX : c'est une
        // constante du code, pas une mesure. On prend donc DUREE_MAX + le seul
        // terme reellement variable, la latence depuis la fin de la parole
        // (transcription + attente en file + transport).
        //
        // Consequence assumee : sur un passage a segments courts, le texte
        // apparaitra legerement EN AVANCE sur la voix. C'est le bon sens de
        // l'erreur -- un sous-titre en avance se lit, un sous-titre en retard ne
        // sert a rien.
        const latence = (Date.now() - segment.finParole) / 1000;
        const besoin = DUREE_MAX + latence;
        echantillonsRetard.push(besoin);
        console.log(
          `🎚️ Calibration ${echantillonsRetard.length}/5 : ${besoin.toFixed(1)} s`
        );

        if (echantillonsRetard.length === 5) {
          // Le MAXIMUM, pas la moyenne : mieux vaut un texte legerement EN
          // AVANCE sur la voix qu'en retard. Un sous-titre en avance se lit
          // tranquillement ; un sous-titre en retard ne sert plus a rien.
          // +0,3 s de marge, et 18 s de plafond (le noeud en accepte 20).
          retardApplique = Math.min(18, Math.max(...echantillonsRetard) + 0.3);
          if (delayNode) delayNode.delayTime.value = retardApplique;
          console.log(`🎚️ Retard calibré : ${retardApplique.toFixed(1)} s`);

          // Memorise par le service worker : les prochains lancements
          // l'appliqueront tout de suite, sans retraverser la calibration.
          chrome.runtime
            .sendMessage({ type: "RETARD_CALIBRE", valeur: retardApplique })
            .catch(() => {});

          if (!statutPretEnvoye) {
            statutPretEnvoye = true;
            envoyerStatut("✅ Prêt");
          }
        }
      }

      const texte = message.texte;
      // Sur un segment sans parole nette, Whisper renvoie souvent une chaine
      // vide ou juste de la ponctuation : inutile de polluer la console.
      if (!texte || !/[\p{L}\p{N}]/u.test(texte)) {
        console.log("   (segment sans texte exploitable)");
        break;
      }

      // Whisper a recite une phrase de son entrainement au lieu d'ecouter.
      if (estPhraseFantome(texte)) {
        sousTitresRejetes++;
        console.warn(
          `🚫 Sous-titre rejeté (phrase fantôme) : "${texte}" ` +
            `(${sousTitresRejetes} rejet(s) depuis le début)`
        );
        break;
      }

      // Whisper est parti en boucle.
      if (estUnRadotage(texte)) {
        sousTitresRejetes++;
        console.warn(
          `🚫 Sous-titre rejeté (radotage) : "${texte}" ` +
            `(${sousTitresRejetes} rejet(s) depuis le début)`
        );
        break;
      }

      const duree = segment ? `${segment.secondes} s de parole` : "segment";
      // Latence reelle : temps entre la fermeture du segment et maintenant.
      // Elle inclut l'attente en file quand Whisper a du retard, pas seulement
      // l'inference -- c'est bien ce qu'on veut mesurer.
      const latence = segment ? (Date.now() - segment.finParole) / 1000 : null;
      console.log(
        `📝 « ${texte} »\n   (${duree}, transcrit en ${(message.ms / 1000).toFixed(1)} s ` +
          `sur ${message.backend}` +
          (latence === null ? "" : `, latence ${latence.toFixed(1)} s`) +
          `)`
      );

      // Vers l'overlay de la page. On passe par le service worker : un document
      // offscreen ne peut pas parler directement a un content script (il n'a pas
      // acces a chrome.tabs), et c'est le service worker qui sait quel onglet
      // est capture.
      //
      // On joint finParole pour que content.js mesure la latence jusqu'a
      // l'affichage REEL, bout en bout (meme machine, donc Date.now()
      // comparable d'un contexte a l'autre).
      chrome.runtime.sendMessage({
        type: "TRANSCRIPT",
        texte,
        finParole: segment ? segment.finParole : null,
      });
      break;
    }

    case "error": {
      segmentsEnCours.delete(message.id);
      segmentsAbandonnes.delete(message.id); // pas de reponse a attendre : on oublie
      console.error("❌ Whisper :", message.message);
      break;
    }
  }
}

// Erreur non rattrapee dans le worker (ex : l'import de Transformers.js echoue
// au demarrage). Sans ce handler, le worker mourrait en silence et les segments
// partiraient dans le vide.
function surErreurWhisper(event) {
  console.error("❌ Le worker Whisper a plante :", event.message || event);
  console.error(
    "💡 A verifier : le dossier vendor/ existe-t-il (npm install) ? " +
      "L'extension a-t-elle ete rechargee depuis chrome://extensions ?"
  );
}

// Cree le worker et lance le chargement du modele. Appele au demarrage de la
// capture, PAS au chargement du script (voir le commentaire sur whisperWorker).
//
// On le fait des le debut de la capture et pas a la premiere parole : le
// chargement prend plusieurs secondes (et bien plus au tout premier lancement,
// avec le telechargement du modele et la mesure des backends). Autant que ce
// soit en route pendant que l'utilisateur lance sa video.
//
// `memo` = le verdict deja mesure, fourni par le service worker dans le message
// START_CAPTURE (null la premiere fois). Rien de bloquant ici : pas un seul
// appel a chrome.storage, justement.
function demarrerWhisper(memo) {
  if (whisperWorker) return; // deja demarre, on ne recharge pas le modele

  console.log("⏳ Whisper : chargement du modele dans le worker...");

  // type: "module" -> le worker peut faire `import` de Transformers.js.
  whisperWorker = new Worker(chrome.runtime.getURL("whisper.worker.js"), {
    type: "module",
  });
  whisperWorker.onmessage = surMessageWhisper;
  whisperWorker.onerror = surErreurWhisper;

  whisperWorker.postMessage({ type: "init", memo: memo ?? null });
}

// ---------------------------------------------------------------------------
// Decoupage des segments : on n'attend plus forcement le silence
// ---------------------------------------------------------------------------
//
// Le VAD ne ferme un segment que sur une pause. Sur quelqu'un qui parle sans
// s'arreter, ca donnait des segments de 20 a 40 s : le sous-titre arrivait
// bien apres la phrase. On assemble donc les segments NOUS-MEMES, a partir des
// trames que le VAD nous passe une par une (onFrameProcessed), et on coupe des
// qu'on atteint DUREE_MAX -- meme si ca parle encore.
//
// C'est pour ca qu'on ignore l'audio fourni par onSpeechEnd : il contient tout
// le passage depuis le debut de la parole, donc ce qu'on a deja envoye. On ne
// garde de onSpeechEnd que le SIGNAL de fin.

const TAUX = 16000; // le VAD travaille en 16 kHz mono

// 7 s, et pas 2,5 s comme avant. C'est contre-intuitif -- attendre plus pour
// etre moins en retard -- mais c'est ce que disent les mesures.
//
// Whisper complete TOUT extrait a 30 s avant de le traiter. Un segment de 2,5 s
// lui coute donc presque aussi cher qu'un de 7 s : ~1,4 s de calcul dans les
// deux cas. Couper fin ne fait rien gagner, ca multiplie juste le nombre
// d'appels. A 2,5 s, on demandait une inference toutes les ~2,5 s pour ~1,4 s
// de calcul plus les segments fermes en avance par les silences : le debit
// demande depassait le debit possible, la file grossissait sans jamais se
// vider, et le retard grandissait de +0,3 s par seconde d'audio -- mesure : 5 s
// de retard au bout de 10 s, 32 s au bout de 90 s.
//
// A 7 s, on divise le nombre d'inferences par ~3 pour le meme cout unitaire.
// Et ca corrige aussi le TEXTE : whisper-tiny est tres instable en dessous de
// ~5 s, il n'a pas assez de contexte et se rabat sur les phrases les plus
// frequentes de son entrainement (d'ou les « Thank you for watching » et
// « don't forget to subscribe » observes dans les tests).
//
// Le prix a payer : le premier sous-titre d'une phrase arrive apres 7 s de
// parole au lieu de 2,5 s. Mais avant il arrivait avec 30 s de retard, donc
// c'est un gain net.
const DUREE_MAX = 7;

// Quand on coupe a DUREE_MAX, la coupure tombe n'importe ou -- souvent en plein
// milieu d'un mot. Whisper recevait alors un demi-mot en fin de segment et un
// demi-mot au debut du suivant, et il inventait la suite dans les deux cas.
//
// On garde donc la fin du segment comme debut du suivant : le mot coupe est
// entier d'un cote au moins. Le mot en question peut apparaitre deux fois de
// suite a l'ecran, mais chaque sous-titre remplace le precedent -- une legere
// repetition est bien moins genante qu'un mot invente.
//
// Uniquement sur les coupures a DUREE_MAX : quand c'est le VAD qui ferme sur un
// silence, la phrase est finie, il n'y a rien a rattraper.
const RECOUVREMENT = 0.5;

// Ce qu'on garde en reserve avant le declenchement du VAD, pour ne pas manger
// le debut du premier mot. (La librairie a son propre preSpeechPadMs, mais il
// ne s'applique qu'a SON tampon, pas au notre.)
const PRE_PAROLE = 0.3;

// En dessous, ce n'est pas de la parole : Whisper n'en tirerait que du bruit.
const DUREE_MIN = 0.4;

// Duree en dessous de laquelle on prefere ATTENDRE la suite plutot qu'envoyer.
//
// DUREE_MAX borne le haut, mais le VAD ferme aussi sur les silences : sans
// plancher, on continue d'envoyer des bouts d'une seconde. Or c'est exactement
// la que whisper-tiny invente -- faute de contexte, il sort les phrases les
// plus frequentes de son entrainement (« Thank you for watching », « And
// not! »). Mesure : avec DUREE_MAX a 7 s mais aucun plancher, la moitie des
// sous-titres etaient encore des hallucinations.
//
// Donc quand le VAD ferme sur un segment trop court, on ne l'envoie pas tout de
// suite : on laisse une chance a la phrase de reprendre, et on recolle les deux
// morceaux.
const DUREE_MIN_ENVOI = 3;

// ... mais pas indefiniment : si le silence dure, la phrase est vraiment finie
// et il faut afficher ce qu'on a, meme court. C'est le prix de l'attente :
// jusqu'a 1,5 s de latence en plus sur le dernier bout d'une phrase.
const SILENCE_MAX = 1.5;

// ---------------------------------------------------------------------------
// Garde-fou : un segment doit contenir de la VRAIE parole
// ---------------------------------------------------------------------------
//
// Le VAD nous donne, pour chaque trame, la probabilite qu'elle contienne de la
// parole. On jetait cette information ; on s'en sert maintenant pour refuser
// d'envoyer a Whisper un segment majoritairement silencieux.
//
// Pourquoi : sur du silence, du bruit ou de la musique, whisper-tiny n'echoue
// pas, il INVENTE -- il se rabat sur les phrases les plus frequentes de son
// entrainement (des sous-titres YouTube : « Thank you for watching »,
// « n'oubliez pas de vous abonner »). Le meilleur moyen d'eviter ces phrases
// est de ne pas le faire travailler sur du vide.
//
// Au-dessus de ce seuil, la trame compte comme parlee. 0,5 = le point neutre du
// modele Silero (il sort une probabilite entre 0 et 1). A ne pas confondre avec
// positiveSpeechThreshold, qui sert au VAD a decider quand OUVRIR un segment :
// ici on ne decide rien, on compte.
const SEUIL_TRAME_PAROLE = 0.5;

// Proportion minimale de trames parlees pour qu'un segment merite Whisper.
//
// ⚠️ Cette valeur a ete MESUREE, pas choisie. Un premier essai a 0,30 rejetait
// de la VRAIE parole -- exactement le defaut invisible qu'il faut eviter : le
// sous-titre manque, sans erreur, sans trace.
//
// Mesures sur les deux extraits du depot (test/speech.wav et test/speech-fr.mp3),
// en reconstituant les formes de segment que la production peut produire
// (PRE_PAROLE en tete, puis parole, puis le silence de fin -- borne a ~2,2 s par
// la redemption du VAD et SILENCE_MAX) :
//
//   son SANS parole      : silence 0 %, bruit de fond 0 %, musique seule 2 %
//   vraie parole, pire cas : 19 %  (1,5 s de parole suivie de 2,2 s de silence)
//   vraie parole, courant  : 26 a 75 %
//
// Le trou entre 2 % et 19 % est large : on se place au milieu. 0,10 laisse
// passer toute la vraie parole mesuree (5x de marge sous le pire cas) tout en
// bloquant le silence, le bruit et la musique (5x au-dessus du pire cas).
//
// Remonter cette valeur vers 0,30 fait reapparaitre le probleme. Tout rejet est
// journalise avec sa proportion : regarder la console avant d'y toucher.
const PART_PAROLE_MIN = 0.1;

let tampon = [];        // trames accumulees (Float32Array de 16 kHz)
let tamponSamples = 0;  // leur total en echantillons, pour eviter de recompter
let enParole = false;

// Parallele a `tampon`, une entree par trame : cette trame contenait-elle de la
// parole ? Les deux tableaux DOIVENT etre modifies ensemble partout (ajout,
// purge au repos, recouvrement, vidage) -- sinon la proportion se decale et le
// garde-fou se met a rejeter n'importe quoi.
let tamponParole = [];

// Ce que le tampon contient de DEJA ENVOYE : le recouvrement repris au segment
// precedent. Sert a ne pas retranscrire deux fois le meme demi-mot si le VAD
// ferme juste apres une coupure a DUREE_MAX.
let reportSamples = 0;

// Le VAD a ferme, mais le segment etait trop court pour etre envoye tel quel :
// on garde tout et on attend de voir si la phrase reprend (voir
// DUREE_MIN_ENVOI). `silenceSamples` compte le silence ecoule depuis.
let enAttente = false;
let silenceSamples = 0;

// Etions-nous en attente juste avant que le VAD ne crie « parole » ?
//
// Sert uniquement au cas de la fausse alerte : si ce declenchement se revele
// etre du bruit, il faut pouvoir revenir a l'etat d'avant au lieu de tout
// jeter. Sans cette memoire, l'information est perdue -- onSpeechStart remet
// deja enAttente a false.
let attenteAvantParole = false;

function dureeTampon() {
  return tamponSamples / TAUX;
}

// Duree de ce qui n'a encore jamais ete envoye a Whisper.
function dureeNouveaute() {
  return (tamponSamples - reportSamples) / TAUX;
}

function viderTampon() {
  tampon = [];
  tamponParole = []; // toujours en meme temps que `tampon`
  tamponSamples = 0;
  reportSamples = 0;
  enAttente = false;
  silenceSamples = 0;
  attenteAvantParole = false;
}

// Proportion de trames parlees dans le tampon actuel, entre 0 et 1.
// Un tampon vide vaut 0 : rien a transcrire, donc rien a envoyer.
function partParole() {
  if (tamponParole.length === 0) return 0;
  let parlees = 0;
  for (const estParole of tamponParole) {
    if (estParole) parlees++;
  }
  return parlees / tamponParole.length;
}

// Colle les trames en un seul Float32Array continu, pret pour Whisper.
function assemblerTampon() {
  const audio = new Float32Array(tamponSamples);
  let position = 0;
  for (const trame of tampon) {
    audio.set(trame, position);
    position += trame.length;
  }
  return audio;
}

// Ferme le segment courant et l'envoie a Whisper. `raison` sert au log.
//
// `recouvrement` (en secondes) = ce qu'on garde de la FIN de ce segment pour
// demarrer le suivant. Voir le commentaire de RECOUVREMENT.
function fermerSegment(raison, recouvrement = 0) {
  // On teste ce qu'il y a de NOUVEAU, pas la taille du tampon : juste apres une
  // coupure a DUREE_MAX, le tampon contient deja le recouvrement, qui a ete
  // envoye avec le segment precedent. Le renvoyer seul afficherait un
  // sous-titre en double.
  if (dureeNouveaute() < DUREE_MIN) {
    viderTampon();
    return;
  }

  const audio = assemblerTampon();

  // Mesure AVANT de tailler le recouvrement : c'est la proportion du segment
  // qu'on envoie, pas celle de ce qu'il en restera.
  const part = partParole();

  if (recouvrement > 0) {
    // On reprend les dernieres trames en repartant de la fin, jusqu'a couvrir
    // la duree voulue. On raisonne en trames entieres : elles font ~32 ms, donc
    // l'arrondi est sans consequence, et ca evite de decouper un Float32Array.
    const cible = recouvrement * TAUX;
    const queue = [];
    const queueParole = [];
    let gardes = 0;
    for (let i = tampon.length - 1; i >= 0 && gardes < cible; i--) {
      queue.unshift(tampon[i]);
      queueParole.unshift(tamponParole[i]); // la trame garde son etiquette
      gardes += tampon[i].length;
    }
    tampon = queue;
    tamponParole = queueParole;
    tamponSamples = gardes;
    reportSamples = gardes; // tout ce qui reste vient d'etre envoye
    enAttente = false;
    silenceSamples = 0;
  } else {
    viderTampon();
  }

  transcrireSegment(audio, raison, part);
}

// Appelee pour CHAQUE trame analysee par le VAD (~32 ms), qu'il y ait parole
// ou non. C'est ici qu'on decide de couper.
function surTrame(trame, estParole) {
  tampon.push(trame);
  tamponParole.push(estParole);
  tamponSamples += trame.length;

  if (!enParole) {
    // Cas 1 : on retient un segment trop court en esperant la suite. On garde
    // TOUT (y compris ce silence : Whisper s'en accommode tres bien, et ca
    // conserve le rythme de la phrase si elle reprend).
    if (enAttente) {
      silenceSamples += trame.length;
      // Le silence s'installe : la phrase etait bel et bien finie, on envoie ce
      // qu'on a plutot que de faire attendre le sous-titre davantage.
      if (silenceSamples / TAUX >= SILENCE_MAX) {
        fermerSegment("silence prolonge");
      }
      return;
    }

    // Cas 2 : au repos. Le tampon ne sert que de reserve : on jette ce qui
    // depasse PRE_PAROLE, sinon il grossirait indefiniment pendant les silences.
    while (dureeTampon() > PRE_PAROLE && tampon.length > 1) {
      tamponSamples -= tampon.shift().length;
      tamponParole.shift(); // meme trame, meme sort
    }
    // On vient peut-etre de jeter des trames comptees dans le report : sans ce
    // recalage, dureeNouveaute() sous-estimerait le neuf et on finirait par
    // jeter des segments valables.
    reportSamples = Math.min(reportSamples, tamponSamples);
    return;
  }

  // Ca parle toujours mais le segment est plein : on coupe sans attendre, en
  // gardant la fin pour le segment suivant (la coupure tombe en plein mot).
  if (dureeTampon() >= DUREE_MAX) {
    fermerSegment("duree max", RECOUVREMENT);
  }
}

// ---------------------------------------------------------------------------
// Surveillance de la file
// ---------------------------------------------------------------------------
//
// Whisper traite les segments un par un. Tant qu'il transcrit plus vite que la
// parole n'arrive, la file reste vide et la latence est celle d'un segment. Des
// qu'il ralentit (machine chargee, segments plus courts donc plus nombreux), la
// file s'allonge et la latence derive sans jamais revenir toute seule : c'est le
// signe que le reglage est trop agressif pour cette machine.
//
// On previent au franchissement du seuil, pas a chaque segment : sinon
// l'avertissement noierait la console au moment ou on en a le plus besoin.
const FILE_ALERTE = 3;
let fileSignalee = false;

// Au-dela, on n'avertit plus : on jette (voir la fin de transcrireSegment).
// FILE_ALERTE previent, FILE_MAX agit -- les deux restent independants.
const FILE_MAX = 4;

function surveillerFile() {
  const enAttente = segmentsEnCours.size;

  if (!fileSignalee && enAttente > FILE_ALERTE) {
    fileSignalee = true;
    console.warn(
      `⚠️  La transcription prend du retard : ${enAttente} segments en attente. ` +
        `Les sous-titres vont s'afficher de plus en plus tard. ` +
        `Si ca persiste, rallonger encore DUREE_MAX (actuellement ${DUREE_MAX} s) : ` +
        `un segment long ne coute pas plus cher qu'un court, Whisper les complete ` +
        `tous a 30 s.`
    );
    return;
  }

  // Retour a la normale : utile a savoir, ca distingue un a-coup passager
  // (le chargement du modele, par exemple) d'un vrai sous-dimensionnement.
  if (fileSignalee && enAttente <= 1) {
    fileSignalee = false;
    console.log("✅ La transcription a rattrape son retard (file vide).");
  }
}

// Envoie un segment de parole au worker. Rien a decoder : le VAD produit deja
// du Float32Array mono a 16 kHz, exactement ce que Whisper attend.
//
// `audio` nous appartient (on vient de l'assembler), donc on le transfere
// directement : aucune copie.
function transcrireSegment(audio, raison, partDeParole = 1) {
  // Le VAD ne peut pas tourner sans capture, et la capture demarre Whisper :
  // en pratique on ne passe jamais ici sans worker. Garde-fou quand meme.
  if (!whisperWorker) {
    console.warn("⚠️  Segment ignore : le worker Whisper n'est pas demarre");
    return;
  }

  // Whisper n'est pas encore pret : on JETTE le segment au lieu de l'empiler.
  //
  // Un segment mis en file pendant 90 s produira un sous-titre perime de 90 s.
  // Il vaut mieux ne rien afficher qu'afficher du faux -- et pendant ce temps
  // l'overlay explique ce qui se passe (voir envoyerStatut).
  if (!whisperPret) {
    segmentsIgnoresAttente++;
    console.log(
      `⏭️ Segment ignoré : Whisper n'est pas encore prêt ` +
        `(${(audio.length / TAUX).toFixed(1)} s, ${segmentsIgnoresAttente} depuis le début)`
    );
    return;
  }

  // Presque rien de parle la-dedans : on n'envoie pas. C'est exactement sur ces
  // segments-la que Whisper invente (voir PART_PAROLE_MIN).
  if (partDeParole < PART_PAROLE_MIN) {
    segmentsIgnoresSilence++;
    console.log(
      `⏭️ Segment ignoré : seulement ${Math.round(partDeParole * 100)} % de parole réelle ` +
        `(${(audio.length / TAUX).toFixed(1)} s, raison « ${raison} », ` +
        `${segmentsIgnoresSilence} depuis le début)`
    );
    return;
  }

  const id = prochainSegmentId++;
  const secondes = (audio.length / TAUX).toFixed(1);

  // Deux reperes de temps, et il ne faut pas les confondre :
  //   finParole    = maintenant, l'instant ou le segment est clos. Sert a
  //                  mesurer la latence de transcription.
  //   debutSegment = quand la premiere syllabe du segment a ete prononcee.
  //                  Sert a calibrer le retard du son : pour que l'utilisateur
  //                  entende le PREMIER mot pile quand le texte s'affiche,
  //                  c'est de ce repere-la qu'il faut partir.
  const dureeMs = (audio.length / TAUX) * 1000;
  segmentsEnCours.set(id, {
    secondes,
    finParole: Date.now(),
    debutSegment: Date.now() - dureeMs,
  });

  // 2e argument : liste des buffers TRANSFERES. Le tableau change de
  // proprietaire au lieu d'etre copie pour passer au worker.
  whisperWorker.postMessage(
    { type: "transcribe", id, audio, langue: langueCourante },
    [audio.buffer]
  );

  // La proportion de parole est journalisee meme quand on accepte : c'est le
  // seul moyen de verifier que PART_PAROLE_MIN reste loin des vrais segments.
  console.log(
    `➡️  Segment #${id} envoye a Whisper : ${secondes} s (${raison}, ` +
      `${Math.round(partDeParole * 100)} % de parole)`
  );

  // Filet de securite, meme quand Whisper est pret : sur une machine lente la
  // file peut recommencer a diverger. On abandonne alors les PLUS ANCIENS --
  // un sous-titre en retard de 30 s est pire qu'un sous-titre manquant, et ce
  // sont les vieux qui sont perimes, pas les nouveaux.
  //
  // Une Map parcourt ses cles dans l'ordre d'insertion : les premieres sont
  // donc les plus anciennes.
  if (segmentsEnCours.size > FILE_MAX) {
    const aJeter = segmentsEnCours.size - FILE_MAX;
    let jetes = 0;
    for (const vieuxId of segmentsEnCours.keys()) {
      if (jetes >= aJeter) break;
      segmentsEnCours.delete(vieuxId);
      segmentsAbandonnes.add(vieuxId); // sa reponse sera ignoree au retour
      jetes++;
    }
    segmentsIgnoresFile += jetes;
    console.warn(
      `🗑️ File saturee : ${jetes} segment(s) abandonne(s) pour rester a ${FILE_MAX} ` +
        `(${segmentsIgnoresFile} depuis le début de la capture)`
    );
  }

  surveillerFile();
}


// Démarrer la capture.
// Ne rejette JAMAIS : renvoie toujours { success, error?, warning? }, parce que
// c'est cette reponse qui decide si le background a le droit d'ecrire "actif".
async function startCapture(streamId, memoBackend, langue, retard, retardCalibre) {
  try {
    console.log("🎤 Offscreen : demarrage capture avec streamId :", streamId);

    // La langue du choix utilisateur, transmise par le service worker.
    if (langue) langueCourante = langue;
    console.log("🗣️ Langue des sous-titres :", langueCourante);

    // Si on a déjà une capture, on l'arrête d'abord
    if (mediaStream) {
      console.log("🔄 Flux deja existant, on le ferme d'abord");
      await stopCapture();
    }

    // Whisper se met en route en parallele : le chargement du modele prend
    // plusieurs secondes et la capture audio n'a pas a l'attendre. Les segments
    // produits avant qu'il soit pret sont JETES, pas mis en file (voir
    // transcrireSegment) : on l'annonce a l'utilisateur juste en dessous.
    demarrerWhisper(memoBackend);

    // Compteurs et statuts repartent de zero a chaque capture.
    segmentsAbandonnes.clear();
    segmentsIgnoresAttente = 0;
    segmentsIgnoresFile = 0;
    segmentsIgnoresSilence = 0;
    sousTitresRejetes = 0;
    statutPretEnvoye = false;

    // Au tout premier lancement sur une machine, il se passe une minute entre
    // ce point et le premier sous-titre (telechargement du modele + mesure
    // GPU/CPU). Sans un mot, l'utilisateur croit que l'extension est cassee.
    if (!whisperPret) {
      envoyerStatut("⏳ Préparation du modèle… (première utilisation : jusqu'à 1 min)");
    }

    // Créer le contexte audio
    audioContext = new AudioContext();

    // Dans un offscreen document il n'y a aucun clic utilisateur, donc le
    // contexte peut demarrer "suspended" -- et dans ce cas rien n'est traite,
    // ni l'analyseur de volume ni le worklet du VAD.
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    console.log("🎛️ AudioContext :", audioContext.state, "@", audioContext.sampleRate, "Hz");

    // Capturer le flux audio à partir du streamId
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    mediaStream = stream;
    isCapturing = true;
    console.log("✅ Offscreen : flux audio capture !");

    // Créer une source audio à partir du flux
    const source = audioContext.createMediaStreamSource(stream);

    // -----------------------------------------------------------------------
    // Retard du son : sur les haut-parleurs SEULEMENT
    // -----------------------------------------------------------------------
    //
    // Le sous-titre arrive forcement apres la parole : il faut le temps de la
    // transcrire (~2 s). Retarder le son d'autant le fait coincider avec le
    // texte affiche.
    //
    // ⚠️ LE POINT A NE PAS RATER : le retard ne doit toucher QUE ce qu'on
    // entend. Le flux analyse (`stream`) part vers le VAD et Whisper SANS
    // passer par ce noeud. Si on retardait aussi ce chemin-la, la parole
    // arriverait a Whisper avec 2 s de retard supplementaires, la transcription
    // sortirait 2 s plus tard, et le decalage serait exactement le meme
    // qu'avant : l'option ne servirait a rien.
    //
    // D'ou deux branches distinctes qui partent de la meme source :
    //   source ──> delayNode ──> sortie ──> audioElement   (ce qu'on ENTEND, retarde)
    //   stream ─────────────────────────> VAD ──> Whisper  (ce qu'on ANALYSE, immediat)
    //
    // 20 s de capacite maximale. createDelay fixe un PLAFOND : avec 5, une
    // valeur calibree a 9 s serait silencieusement ramenee a 5 et l'alignement
    // serait faux sans qu'aucune erreur ne le signale.
    delayNode = audioContext.createDelay(20);
    const sortie = audioContext.createMediaStreamDestination();
    source.connect(delayNode);
    delayNode.connect(sortie);

    // Trois cas de figure pour la valeur de depart :
    modeRetard = retard ?? 0;
    echantillonsRetard = [];
    retardApplique = null;

    if (modeRetard === "auto" && typeof retardCalibre === "number") {
      // 1. Mode auto, deja calibre sur cette machine -> on applique tout de
      //    suite. C'est ce qui evite de repasser par le trou de calibration a
      //    chaque lancement.
      retardApplique = retardCalibre;
      delayNode.delayTime.value = retardCalibre;
    } else if (modeRetard === "auto") {
      // 2. Mode auto, jamais calibre -> on part sans retard et on mesure les
      //    5 premiers segments (voir le case "result").
      delayNode.delayTime.value = 0;
    } else {
      // 3. Reglage manuel (0 = desactive) -> on applique, sans calibrer.
      delayNode.delayTime.value = Number(modeRetard) || 0;
    }

    // Rediriger le son vers les haut-parleurs (pour que l'utilisateur l'entende)
    audioElement = new Audio();
    audioElement.srcObject = sortie.stream;
    audioElement.play();
    console.log(
      `🔊 Offscreen : son redirige vers les haut-parleurs (retard ${delayNode.delayTime.value} s)`
    );

    // Créer un analyseur pour mesurer le volume (pour la détection de parole)
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    // Démarrer l'analyse du volume
    analyseVolume(analyser);

    // Démarrer le VAD (détection de parole).
    // Un VAD en panne n'empeche pas d'entendre le son : ce n'est pas un echec
    // de la capture, mais ca ne doit plus passer inapercu non plus -> on le
    // remonte en avertissement jusqu'a la popup.
    //
    // On lui passe `stream`, le flux D'ORIGINE, surtout pas la sortie retardee :
    // voir l'explication au montage du noeud de retard plus haut.
    const vadStatus = await startVAD(stream);

    return {
      success: true,
      warning: vadStatus.ok ? null : "Sous-titres indisponibles : " + vadStatus.error
    };

  } catch (error) {
    console.error("❌ Offscreen : erreur startCapture :", error);

    // On ne laisse pas une capture a moitie ouverte derriere nous : sans ce
    // nettoyage, isCapturing/mediaStream resteraient incoherents et le
    // prochain demarrage repartirait d'un etat batard.
    await stopCapture();

    return { success: false, error: error.message || String(error) };
  }
}

// Démarrer le VAD. Renvoie { ok: true } ou { ok: false, error } -- l'appelant
// decide quoi en faire, au lieu que l'echec finisse seulement en console.
async function startVAD(stream) {
  try {
    console.log("🎤 Demarrage du VAD (détection de parole)...");

    // La librairie est chargee par <script src="vendor/bundle.min.js"> dans
    // offscreen.html : elle expose self.vad. On ne peut PAS faire
    // import("@ricky0123/vad-web") ici, un navigateur ne sait pas resoudre un
    // nom de package npm.
    if (!self.vad || !self.vad.MicVAD) {
      throw new Error(
        "self.vad est introuvable : vendor/bundle.min.js n'a pas ete charge. " +
        "Lance `npm install` pour remplir le dossier vendor/."
      );
    }

    vad = await self.vad.MicVAD.new({
      // On reutilise notre AudioContext au lieu de laisser la librairie en
      // creer un deuxieme (elle ne le fermera pas : c'est nous qui le gerons).
      audioContext: audioContext,

      // Par defaut la librairie ouvre le MICRO via getUserMedia. Nous, on veut
      // le son de l'onglet qu'on vient de capturer, donc on lui fournit notre
      // flux. Ces trois fonctions remplacent tout son cycle de vie du flux :
      getStream: async () => stream,
      // Le defaut ferait track.stop() -> ca tuerait la capture de l'onglet.
      pauseStream: async () => {},
      // Le defaut rappellerait getUserMedia (le micro).
      resumeStream: async () => stream,

      // Silero VAD v5 (le defaut de la librairie est l'ancien modele "legacy").
      model: "v5",

      // Combien de silence avant de declarer la parole finie. Defaut : 1400 ms,
      // soit presque une seconde et demie ajoutee a CHAQUE sous-titre. A 700 ms
      // on coupe sur les vraies respirations sans hacher les phrases.
      redemptionMs: 700,

      // Duree minimale pour qu'un bruit compte comme de la parole. On garde le
      // defaut (400 ms) : le baisser ferait passer des toux et des bruits de
      // clavier pour de la parole, et Whisper en ferait du texte inutile.
      minSpeechMs: 400,

      // Ou trouver vad.worklet.bundle.min.js et silero_vad_v5.onnx
      baseAssetPath: chrome.runtime.getURL("vendor/"),
      // Ou trouver ort-wasm-simd-threaded.mjs et .wasm
      onnxWASMBasePath: chrome.runtime.getURL("vendor/"),

      ortConfig: (ort) => {
        ort.env.logLevel = "error";
        // Un seul thread : les workers d'ONNX Runtime sont crees depuis des
        // blob: URLs, que la CSP d'une extension MV3 bloque.
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
      },

      // Toutes les trames passent par ici (~32 ms chacune), parole ou pas :
      // c'est nous qui assemblons et decoupons les segments.
      onFrameProcessed: (probs, trame) => {
        // `probs` vaut { isSpeech, notSpeech } (verifie dans la librairie :
        // dist/models/v5.js, c'est le modele qu'on utilise). On ne garde que le
        // verdict oui/non : la proportion de trames parlees du segment sert
        // ensuite a refuser les segments quasi vides (voir PART_PAROLE_MIN).
        surTrame(trame, probs.isSpeech > SEUIL_TRAME_PAROLE);
      },

      onSpeechStart: () => {
        console.log("🗣️ PAROLE DETECTEE ! (debut)");
        // Le tampon contient deja PRE_PAROLE secondes de son : le debut du
        // premier mot est dedans, on repart de la sans rien jeter.
        //
        // Et si on etait en attente (segment trop court), le tampon contient en
        // plus tout le morceau precedent : la phrase se recolle d'elle-meme.
        // On note l'etat d'avant : si cette « parole » se revele etre du bruit
        // (onVADMisfire), il faudra y revenir sans jeter ce qu'on retenait.
        attenteAvantParole = enAttente;
        enParole = true;
        enAttente = false;
        silenceSamples = 0;
      },

      // On ignore l'audio que la librairie nous tend : il repart du debut de la
      // parole, donc il contient ce qu'on a deja envoye a chaque coupure. Seul
      // le signal de fin nous interesse.
      onSpeechEnd: () => {
        console.log("🔇 PAROLE TERMINEE ! (fin)");
        enParole = false;

        // Assez de matiere : on envoie tout de suite.
        if (dureeNouveaute() >= DUREE_MIN_ENVOI) {
          fermerSegment("fin de parole");
          return;
        }

        // Trop court : on retient, en esperant que la phrase reprenne. C'est
        // surTrame qui tranchera, au bout de SILENCE_MAX.
        enAttente = true;
        silenceSamples = 0;
      },

      onVADMisfire: () => {
        console.log("❌ Fausse alerte du VAD (bruit)");
        enParole = false;

        // AVANT : viderTampon() -- on jetait TOUT le tampon.
        //
        // C'etait faux des qu'on retenait un segment court en attendant la
        // suite de la phrase : un simple bruit (musique, effet sonore) suffisait
        // a effacer de la vraie parole, jamais transcrite. Mesure sur une
        // source avec musique : 4 a 5,5 % du son captee partait comme ca.
        //
        // MAINTENANT : on ne jette que le bruit. Si on retenait quelque chose,
        // on retourne simplement en attente, tampon intact.
        if (attenteAvantParole) {
          enAttente = true;
          attenteAvantParole = false;
          return;
        }

        // Rien n'etait retenu : pas besoin de vider non plus. La branche « au
        // repos » de surTrame ramene le tampon a PRE_PAROLE toute seule, ce qui
        // preserve l'amorce du mot suivant.
      }
    });

    // Pas besoin d'appeler vad.start() : MicVAD.new() demarre deja tout seul
    // (option startOnLoad, activee par defaut).
    console.log("✅ VAD demarre !");
    return { ok: true };

  } catch (error) {
    // On n'avale surtout pas l'erreur : sans ce message, le VAD echoue en
    // silence et tout a l'air de fonctionner (le son passe, le volume s'affiche).
    console.error("❌ LE VAD N'A PAS DEMARRE :", error);
    console.error(
      "💡 A verifier : le dossier vendor/ existe-t-il (npm install) ? " +
      "L'extension a-t-elle ete rechargee depuis chrome://extensions ?"
    );
    vad = null;
    return { ok: false, error: error.message || String(error) };
  }
}

// Arrêter la capture
async function stopCapture() {
  console.log("⏸️ Offscreen : arret de la capture");

  // Arrêter le VAD (destroy() met en pause puis libere le modele ; la methode
  // stop() n'existe pas dans cette version de la librairie)
  if (vad) {
    try {
      await vad.destroy();
      console.log("✅ VAD arrete");
    } catch (err) {
      console.warn("Erreur arret VAD :", err);
    }
    vad = null;
  }

  // Arrêter l'élément audio
  if (audioElement) {
    audioElement.pause();
    audioElement.srcObject = null;
    audioElement = null;
  }

  // Debrancher le noeud de retard. Sans ca, il resterait connecte au graphe et
  // le prochain demarrage empilerait un second chemin vers les haut-parleurs --
  // on entendrait le son en double, decale.
  if (delayNode) {
    try {
      delayNode.disconnect();
    } catch (err) {
      console.warn("Erreur deconnexion du noeud de retard (normal si deja ferme)");
    }
    delayNode = null;
  }

  // La calibration ne survit pas a la capture : le prochain demarrage repartira
  // de la valeur memorisee (mode auto deja calibre) ou remesurera.
  echantillonsRetard = [];
  retardApplique = null;

  // Arrêter toutes les pistes du flux
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => {
      track.stop();
      track.enabled = false;
    });
    mediaStream = null;
  }

  // Fermer le contexte audio
  if (audioContext) {
    audioContext.close().catch(err => {
      console.warn("Erreur fermeture audioContext (normal si deja ferme)");
    });
    audioContext = null;
  }

  isCapturing = false;
  analyser = null;

  // Le tampon de trames ne doit pas survivre a la capture : sans ca, la
  // prochaine commencerait avec la fin de l'audio de la precedente.
  enParole = false;
  viderTampon();
  fileSignalee = false;

  console.log("✅ Offscreen : tout est bien ferme");
}

// Analyser le volume (pour la console)
function analyseVolume(analyser) {
  const dataArray = new Float32Array(analyser.fftSize);

  function updateLevel() {
    if (!isCapturing || !mediaStream) {
      return;
    }

    try {
      analyser.getFloatTimeDomainData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / dataArray.length);
      const volume = Math.min(rms * 100, 100);

      // Afficher le volume seulement si il y a du son
      if (volume > 0.1) {
        // On affiche moins souvent pour ne pas spammer
        if (Math.random() < 0.1) {
          console.log("🔊 Volume :", Math.round(volume * 10) / 10);
        }
      }
    } catch (error) {
      // Silencieux
    }

    if (isCapturing) {
      requestAnimationFrame(updateLevel);
    }
  }

  updateLevel();
}
