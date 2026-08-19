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
// Le but, en langage clair : quand un mot apparait a l'ecran, l'utilisateur
// doit etre en train de l'entendre. Il lit et il ecoute en meme temps.
//
// ⚠️ CE CALCUL A CHANGE AVEC LE FLUX -- et il a beaucoup diminue.
//
// Avant, un sous-titre s'affichait d'un bloc et couvrait 7 s de passe : au
// moment ou il apparaissait, la voix de son PREMIER mot etait deja loin
// derriere. Il fallait donc retarder le son de la duree du segment PLUS le
// temps de transcription, soit 8 a 12 s.
//
// Maintenant les mots s'ajoutent au fil de la parole : le mot qui vient
// d'apparaitre vient d'etre prononce. Le bon retard n'est plus qu'un seul
// terme, l'AGE DE L'AUDIO LE PLUS RECENT quand son texte s'affiche -- soit, a
// peu de chose pres, la duree d'une inference. On attend 2 a 3 s.
//
// On ne devine pas cette valeur : le repere est mesure (finAudioMs, pose sur
// chaque trame et transporte par la passe), on le lit.
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

// Il n'y a PLUS de file de segments ni de numeros a rattraper : une seule
// inference est en vol a la fois (voir passeEnVol, plus bas). Toute la
// machinerie qui surveillait, alertait et vidait la file a disparu avec elle --
// c'etait le remede a un mal que le moteur ne produit plus.

// Renseigne quand le worker a fini de charger le modele.
//
// Tant que c'est faux, aucune passe n'est lancee (voir peutLancerPasse). Avant,
// les segments partaient quand meme et le worker les empilait : au premier
// lancement sur une machine (telechargement du modele + mesure GPU/CPU, ~90 s),
// toute cette parole se deversait d'un coup des que Whisper devenait pret --
// une minute de sous-titres perimes qui defilaient. Mieux vaut ne rien afficher.
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
      // Resultat d'une passe qui n'a plus de fenetre a laquelle s'appliquer :
      // capture arretee entre-temps, ou fenetre videe. On le jette.
      if (!passeEnVol || passeEnVol.id !== message.id) {
        console.log(`   (résultat de la passe #${message.id} ignoré : périmé)`);
        break;
      }

      const passe = passeEnVol;
      passeEnVol = null;
      passesFaites++;

      // --- Calibration du retard du son ------------------------------------
      //
      // ⚠️ CE QUI A CHANGE AVEC LE FLUX.
      //
      // Avant, un sous-titre couvrait 7 s de passe : quand il s'affichait, la
      // voix correspondante etait deja loin, et il fallait retarder le son de
      // DUREE_MAX + latence (~9 s) pour que l'utilisateur entende le PREMIER
      // mot du sous-titre au moment ou il le lisait.
      //
      // Ce n'est plus vrai. Les mots s'ajoutent au fur et a mesure, et le mot
      // qui vient d'apparaitre a l'ecran vient d'etre prononce. Le bon retard
      // est donc l'AGE DE L'AUDIO LE PLUS RECENT au moment de l'affichage --
      // c'est-a-dire, a peu de chose pres, la duree d'une inference. On attend
      // 2 a 3 s la ou on avait 9.
      //
      // ⚠️ Cette mesure passe AVANT le filtre des passes sans texte : une passe
      // muette n'a rien a afficher, mais c'est un chronometre parfaitement
      // valable, et s'en priver rallongerait la calibration.
      if (modeRetard === "auto" && retardApplique === null) {
        const besoin = (Date.now() - passe.finAudioMs) / 1000;
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

          chrome.runtime
            .sendMessage({ type: "RETARD_CALIBRE", valeur: retardApplique })
            .catch(() => {});

          if (!statutPretEnvoye) {
            statutPretEnvoye = true;
            envoyerStatut("✅ Prêt");
          }
        }
      }

      // --- Garde-fous sur le texte de la passe -----------------------------
      //
      // ⚠️ REGLE COMMUNE AUX TROIS : quand une passe est refusee, ON NE TOUCHE
      // A RIEN. Le ruban, le provisoire et l'affichage restent exactement tels
      // quels -- l'utilisateur ne voit pas son texte disparaitre, il voit
      // seulement les mots ne pas avancer pendant une passe.
      //
      // Et `motsPassePrecedente` n'est PAS mis a jour : une hypothese inventee
      // ne doit pas servir de point de comparaison a la suivante, sinon elle
      // contaminerait le prefixe commun et du texte faux deviendrait stable.
      const texte = message.texte;
      let refus = null;
      if (!texte || !/[\p{L}\p{N}]/u.test(texte)) refus = "sans texte exploitable";
      else if (estPhraseFantome(texte)) refus = "phrase fantôme";
      else if (estUnRadotage(texte)) refus = "radotage";

      if (refus === "sans texte exploitable") {
        console.log(`   (passe #${passe.id} sans texte exploitable)`);
      } else if (refus) {
        textesRejetes++;
        console.warn(
          `🚫 Passe #${passe.id} rejetée (${refus}) : "${texte}" ` +
            `(${textesRejetes} rejet(s) depuis le début, affichage inchangé)`
        );
      } else {
        accepterTexte(texte);
        const age = ((Date.now() - passe.finAudioMs) / 1000).toFixed(1);
        console.log(
          `📝 Passe #${passe.id} en ${(message.ms / 1000).toFixed(1)} s ` +
            `(âge du son : ${age} s) | stable « …${ruban.slice(-70)} » ` +
            `| provisoire « ${provisoire} »`
        );
        envoyerFlux(passe.finAudioMs);
      }

      // --- Cloture de la fenetre -------------------------------------------
      // Cette passe etait la derniere de sa fenetre : son provisoire n'aura
      // jamais de passe suivante pour le corriger, il devient definitif.
      if (passe.cloturante) {
        // Le motif compte : sur « fenetre pleine » on a coupe en plein mot, et
        // c'est le recouvrement qui le retranscrira (voir figerFenetre).
        figerFenetre(passe.cloturante);
        cloturerFenetre(passe);
        envoyerFlux(passe.finAudioMs);
      }

      // --- Et on repart aussitot -------------------------------------------
      // C'est LA que la cadence se regle toute seule : la passe suivante part
      // au moment ou la precedente rend la main, jamais avant. Une machine
      // lente fait moins de passes, elle ne prend pas de retard.
      lancerPasseSiPossible();
      break;
    }

    case "error": {
      // La passe a echoue : on libere la place, et on laisse l'affichage tel
      // quel. La prochaine trame relancera.
      if (passeEnVol && passeEnVol.id === message.id) passeEnVol = null;
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
// Le moteur : une FENETRE qu'on re-transcrit, au lieu de blocs qu'on oublie
// ---------------------------------------------------------------------------
//
// AVANT : la parole etait decoupee en blocs de 7 s ; chaque bloc etait
// transcrit UNE fois, puis oublie, et son texte REMPLACAIT le precedent a
// l'ecran. D'ou l'effet qu'on veut supprimer : une phrase entiere qui saute
// toutes les 7 secondes, sans lien avec la precedente.
//
// MAINTENANT : on garde la phrase EN COURS dans une fenetre, et on la
// re-transcrit ENTIEREMENT, depuis son debut, des que Whisper est libre.
//
// Pourquoi c'est jouable : Whisper complete TOUT extrait a 30 s avant de le
// traiter. Transcrire 4 s ou 11 s coute donc presque pareil. Re-transcrire
// depuis le debut est quasi gratuit -- et chaque passe a PLUS de contexte que
// la precedente, jamais moins. C'est l'exact inverse du decoupage en blocs, ou
// chaque bloc etait aveugle a ce qui le precedait.
//
// ⚠️ LA REGLE QUI TIENT TOUT LE RESTE : UNE SEULE INFERENCE EN VOL.
// Des qu'une passe rend son texte, on relance sur la fenetre telle qu'elle est
// A CET INSTANT. L'audio arrive pendant le calcul sera couvert par la passe
// suivante. Il n'y a donc aucune file d'attente, et la latence ne PEUT PAS
// diverger : la cadence s'adapte toute seule a la machine. C'est ce qui rend
// obsolete toute la surveillance de file de la version precedente.

const TAUX = 16000; // le VAD travaille en 16 kHz mono

// Longueur maximale de la fenetre. Au-dela : on fige le texte courant et on
// repart sur une fenetre neuve.
//
// Pourquoi une borne. Sans elle, quelqu'un qui parle trois minutes sans
// s'arreter donnerait une fenetre de trois minutes -- que Whisper tronquerait
// de toute facon a 30 s (son maximum), en perdant le debut, sans rien dire. Et
// la memoire grandirait sans fin. 12 s laisse largement de quoi construire une
// phrase tout en restant sous les 30 s.
const FENETRE_MAX = 12;

// Ce qu'on garde de la fin d'une fenetre pour amorcer la suivante : la coupure
// a FENETRE_MAX tombe n'importe ou, souvent en plein mot.
const RECOUVREMENT_FENETRE = 0.5;

// Audio NOUVEAU minimum avant de relancer une passe.
//
// Sans ce plancher, on relancerait sur une fenetre quasi identique a la
// precedente : meme cout, meme texte, rien de gagne -- et on empecherait
// surtout la fenetre de s'allonger. 0,7 s, c'est a peu pres un mot : en
// dessous, il n'y a litteralement rien de neuf a entendre.
const MIN_NOUVEAU = 0.7;

// Ce qu'on garde en reserve avant le declenchement du VAD, pour ne pas manger
// le debut du premier mot. (La librairie a son propre preSpeechPadMs, mais il
// ne s'applique qu'a SON tampon, pas au notre.)
const PRE_PAROLE = 0.3;

// En dessous, ce n'est pas de la parole : Whisper n'en tirerait que du bruit.
// S'applique AUSSI a la passe finale : sur 0,3 s de son, whisper-tiny n'ecoute
// pas, il recite (voir PHRASES_FANTOMES).
const DUREE_MIN = 0.4;

// ---------------------------------------------------------------------------
// Garde-fou : une fenetre doit contenir de la VRAIE parole
// ---------------------------------------------------------------------------
//
// Le VAD nous donne, pour chaque trame, la probabilite qu'elle contienne de la
// parole. On s'en sert pour refuser d'envoyer a Whisper une fenetre
// majoritairement silencieuse.
//
// Pourquoi : sur du silence, du bruit ou de la musique, whisper-tiny n'echoue
// pas, il INVENTE -- il se rabat sur les phrases les plus frequentes de son
// entrainement (des sous-titres YouTube : « Thank you for watching »,
// « n'oubliez pas de vous abonner »). Le meilleur moyen d'eviter ces phrases
// est de ne pas le faire travailler sur du vide.
//
// ⚠️ CE QUI A CHANGE : la proportion se calcule maintenant sur la FENETRE
// entiere, et non plus sur un segment ferme. Le SEUIL, lui, ne bouge pas -- il
// avait ete mesure, pas choisi (voir plus bas).
//
// Au-dessus de ce seuil, la trame compte comme parlee. 0,5 = le point neutre du
// modele Silero (il sort une probabilite entre 0 et 1). A ne pas confondre avec
// positiveSpeechThreshold, qui sert au VAD a decider quand OUVRIR un segment :
// ici on ne decide rien, on compte.
const SEUIL_TRAME_PAROLE = 0.5;

// Proportion minimale de trames parlees pour qu'une fenetre merite Whisper.
//
// ⚠️ Cette valeur a ete MESUREE, pas choisie. Un premier essai a 0,30 rejetait
// de la VRAIE parole -- exactement le defaut invisible qu'il faut eviter : le
// sous-titre manque, sans erreur, sans trace.
//
//   son SANS parole      : silence 0 %, bruit de fond 0 %, musique seule 2 %
//   vraie parole, pire cas : 19 %
//   vraie parole, courant  : 26 a 75 %
//
// Le trou entre 2 % et 19 % est large : on se place au milieu. 0,10 laisse
// passer toute la vraie parole mesuree tout en bloquant le silence, le bruit et
// la musique. Remonter vers 0,30 fait reapparaitre le probleme. Tout rejet est
// journalise avec sa proportion : regarder la console avant d'y toucher.
//
// La fenetre est un cas PLUS FAVORABLE que l'ancien segment : elle commence sur
// de la parole et s'arrete peu apres, elle contient donc proportionnellement
// moins de silence. Le seuil garde donc au moins la meme marge qu'avant.
const PART_PAROLE_MIN = 0.1;

// ---------------------------------------------------------------------------
// Etat de la fenetre
// ---------------------------------------------------------------------------

let fenetre = [];       // trames (Float32Array, ~32 ms chacune)
let fenetreParole = []; // meme longueur : cette trame contenait-elle de la parole ?
let fenetreSamples = 0;
let enParole = false;

// Horodatage du DERNIER echantillon entre dans la fenetre. C'est l'age de ce
// point-la, au moment ou le texte s'affiche, qui donne le bon retard du son
// (voir la calibration en haut de fichier).
let finAudioMs = 0;

// La passe en vol, ou null. UN SEUL element possible : c'est toute la regle du
// moteur. { id, trames, finAudioMs, envoiMs, cloturante }
let passeEnVol = null;
let prochainePasseId = 1;

// Taille de la fenetre au dernier envoi, pour mesurer l'audio NOUVEAU.
let samplesAuDernierEnvoi = 0;

// Une cloture est demandee : la prochaine passe sera la DERNIERE de cette
// fenetre, et son texte sera definitif. Vaut null, "fin de parole" (le VAD a
// signale la fin) ou "fenetre pleine" (FENETRE_MAX atteint).
let cloture = null;

// Une cloture « fin de parole » annulee par une reprise de la phrase. Si cette
// reprise se revele etre du bruit (onVADMisfire), il faut la remettre : sans
// cette memoire l'information est perdue, et la fenetre ne se fermerait plus.
let clotureAvantParole = null;

// ---------------------------------------------------------------------------
// Etat du TEXTE : stable / provisoire
// ---------------------------------------------------------------------------
//
// C'est ce qui permet d'AJOUTER des mots au lieu de remplacer la phrase.
//
// Deux passes successives partagent presque tout leur texte, puisque l'audio du
// debut est le meme. Leur PREFIXE COMMUN n'a donc plus aucune raison de
// changer : on le declare STABLE et on le verse dans le ruban pour de bon. Ce
// qui vient apres reste PROVISOIRE : la passe suivante peut encore le corriger.
//
// C'est l'algorithme LocalAgreement-2 de whisper-streaming.

// Tout le texte devenu stable. Ne recule jamais.
let ruban = "";

// La fin encore incertaine, telle que la voit la derniere passe acceptee.
let provisoire = "";

// L'hypothese de la passe PRECEDENTE, pour la comparer a la suivante.
let motsPassePrecedente = [];

// Combien de mots de la fenetre COURANTE sont deja passes dans le ruban.
let motsConfirmes = 0;

// Le ruban n'a pas a porter toute la session : l'overlay n'affiche que deux
// lignes. On garde de quoi les remplir largement, pas davantage.
const RUBAN_MAX = 300;

// Compteurs de la capture en cours, remis a zero au demarrage. Ils servent au
// diagnostic.
let passesIgnoreesAttente = 0; // pas lancees : Whisper n'etait pas pret
let passesIgnoreesSilence = 0; // pas lancees : fenetre quasi muette
let textesRejetes = 0;         // textes recus mais refuses (radotage, fantome)
let passesFaites = 0;

// ---------------------------------------------------------------------------
// Fenetre : mesures et manipulations
// ---------------------------------------------------------------------------

function dureeFenetre() {
  return fenetreSamples / TAUX;
}

// Duree de ce qui est entre dans la fenetre depuis le dernier envoi.
function dureeNouveau() {
  return (fenetreSamples - samplesAuDernierEnvoi) / TAUX;
}

// Proportion de trames parlees dans la fenetre, entre 0 et 1.
// Une fenetre vide vaut 0 : rien a transcrire, donc rien a envoyer.
function partParole() {
  if (fenetreParole.length === 0) return 0;
  let parlees = 0;
  for (const estParole of fenetreParole) {
    if (estParole) parlees++;
  }
  return parlees / fenetreParole.length;
}

// Colle les trames en un seul Float32Array continu, pret pour Whisper.
// Le tableau produit est NEUF : on peut le transferer au worker sans perdre la
// fenetre, qui doit survivre pour la passe suivante.
function assemblerFenetre() {
  const audio = new Float32Array(fenetreSamples);
  let position = 0;
  for (const trame of fenetre) {
    audio.set(trame, position);
    position += trame.length;
  }
  return audio;
}

// Remplace la fenetre par la liste de trames donnee.
function remplacerFenetre(trames, paroles) {
  fenetre = trames;
  fenetreParole = paroles;
  fenetreSamples = trames.reduce((total, t) => total + t.length, 0);
  samplesAuDernierEnvoi = 0;
}

function viderFenetre() {
  remplacerFenetre([], []);
  cloture = null;
}

// Etat texte de la fenetre courante, remis a neuf.
function reinitialiserTexteFenetre() {
  provisoire = "";
  motsPassePrecedente = [];
  motsConfirmes = 0;
}

// Sommes-nous au repos ? (rien en cours, rien a finir, rien d'affiche en
// provisoire) Dans ce cas la fenetre ne sert que de reserve d'amorce.
function auRepos() {
  return (
    !enParole && !cloture && !passeEnVol && motsPassePrecedente.length === 0 && !provisoire
  );
}

// ---------------------------------------------------------------------------
// Stable / provisoire : LocalAgreement-2
// ---------------------------------------------------------------------------

function decouperEnMots(texte) {
  return String(texte || "").trim().split(/\s+/).filter(Boolean);
}

// On COMPARE des formes normalisees (minuscules, sans accents ni ponctuation)
// pour qu'une virgule ajoutee d'une passe a l'autre ne fasse pas croire a un
// changement de mot -- mais on AFFICHE le mot d'origine, ponctuation comprise.
function prefixeCommun(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && normaliserTexte(a[i]) === normaliserTexte(b[i])) {
    i++;
  }
  return i;
}

// Verse des mots dans le ruban, en le bornant a RUBAN_MAX.
function ajouterAuRuban(mots) {
  if (!mots.length) return;
  ruban = ruban ? `${ruban} ${mots.join(" ")}` : mots.join(" ");

  if (ruban.length > RUBAN_MAX) {
    // ⚠️ On coupe sur une frontiere de MOT. content.js aligne l'affichage sur
    // les mots : un ruban tranche en plein mot lui ferait croire que tout a
    // change, et il re-revelerait du texte deja lu.
    ruban = ruban.slice(ruban.length - RUBAN_MAX);
    const espace = ruban.indexOf(" ");
    if (espace > 0) ruban = ruban.slice(espace + 1);
  }
}

// Applique le texte d'une passe : ce qui est confirme part au ruban, le reste
// devient le provisoire.
function accepterTexte(texte) {
  const mots = decouperEnMots(texte);
  const commun = prefixeCommun(motsPassePrecedente, mots);

  if (commun > motsConfirmes) {
    // On verse la version de la passe LA PLUS RECENTE (meilleure ponctuation).
    ajouterAuRuban(mots.slice(motsConfirmes, commun));
    motsConfirmes = commun;
  }

  provisoire = mots.slice(motsConfirmes).join(" ");
  motsPassePrecedente = mots;
}

// Fin de fenetre : le provisoire n'a plus de passe suivante pour le corriger,
// il devient definitif.
//
// `motif` dit POURQUOI la fenetre se ferme, et ca change ce qu'on fige :
//
//   "fin de parole"  -> la personne s'est tue. Le dernier mot est entier, on
//                       garde tout.
//
//   "fenetre pleine" -> on a coupe au chronometre, en plein milieu de la
//                       parole. Le dernier mot est donc coupe en deux, et
//                       Whisper l'a rendu tel qu'il l'a entendu : un demi-mot.
//                       On le JETTE -- le recouvrement garde son debut, la
//                       fenetre suivante le retranscrira en entier.
//
// ⚠️ Sans ce tri, le demi-mot etait fige POUR DE BON dans le ruban, puis le
// recouvrement ajoutait la version complete juste apres. Mesure au banc, sur
// 45 s de parole continue : « apres une pa. pause et doit », « la deuxi.
// deuxieme phrase » -- un demi-mot double a chaque fermeture, soit toutes les
// ~11 s.
//
// Et on ne jette QUE dans ce cas : partout ailleurs (fenetre abandonnee, texte
// fige sans recouvrement), personne ne repasserait derriere pour rattraper le
// mot -- il serait perdu.
function figerFenetre(motif) {
  let mots = provisoire ? decouperEnMots(provisoire) : [];

  // On ne jette le dernier mot que s'il en reste au moins un : sur un provisoire
  // d'un seul mot, mieux vaut un demi-mot que rien du tout -- le recouvrement
  // le ramenera, et le doublon se verra a peine.
  if (motif === "fenetre pleine" && mots.length > 1) mots = mots.slice(0, -1);

  if (mots.length) ajouterAuRuban(mots);
  reinitialiserTexteFenetre();
}

// Fin d'une fenetre : on ne garde que ce qui est arrive PENDANT l'inference de
// la passe cloturante -- la phrase a pu reprendre entre-temps, et cet audio-la
// n'a encore ete transcrit par personne.
//
// Si la fenetre etait simplement PLEINE (et non finie), on garde en plus un
// bout de sa fin : la coupure a FENETRE_MAX tombe n'importe ou, souvent en
// plein mot, et Whisper inventerait la suite des deux cotes.
//
// Prix a payer, assume : ce recouvrement est re-transcrit, donc un mot peut
// apparaitre deux fois dans le ruban a la jonction. Un mot en double se lit ;
// un mot invente, non.
function cloturerFenetre(passe) {
  const apres = fenetre.slice(passe.trames);
  const apresParole = fenetreParole.slice(passe.trames);

  const tete = [];
  const teteParole = [];
  if (passe.cloturante === "fenetre pleine") {
    const cible = RECOUVREMENT_FENETRE * TAUX;
    let gardes = 0;
    for (let i = passe.trames - 1; i >= 0 && gardes < cible; i--) {
      tete.unshift(fenetre[i]);
      teteParole.unshift(fenetreParole[i]); // la trame garde son etiquette
      gardes += fenetre[i].length;
    }
  }

  remplacerFenetre(tete.concat(apres), teteParole.concat(apresParole));
  cloture = null;
}

// Vers l'overlay de la page. On passe par le service worker : un document
// offscreen ne peut pas parler directement a un content script (il n'a pas
// acces a chrome.tabs), et c'est le service worker qui sait quel onglet est
// capture.
//
// `finAudio` = l'instant ou le dernier echantillon transcrit a ete capte.
// content.js s'en sert pour mesurer l'AGE du mot le plus recent au moment ou il
// s'affiche -- c'est ce chiffre-la qui donne le bon retard du son.
function envoyerFlux(finAudio) {
  chrome.runtime
    .sendMessage({ type: "FLUX", ruban, provisoire, finAudio })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Lancement des passes
// ---------------------------------------------------------------------------

// Peut-on lancer une passe maintenant ?
function peutLancerPasse() {
  if (!whisperWorker) return false;

  // Whisper n'est pas encore pret : on ne met RIEN en file. Un travail empile
  // pendant 90 s produirait un texte perime de 90 s. Pendant ce temps
  // l'overlay explique ce qui se passe (voir envoyerStatut).
  if (!whisperPret) return false;

  // La regle du moteur : jamais deux inferences en vol.
  if (passeEnVol) return false;

  if (dureeFenetre() < DUREE_MIN) return false;

  // Une cloture doit partir meme si presque rien de neuf n'est arrive : c'est
  // la derniere chance de transcrire cette fenetre.
  if (!cloture && dureeNouveau() < MIN_NOUVEAU) return false;

  return true;
}

function lancerPasseSiPossible() {
  if (!peutLancerPasse()) {
    // On ne compte que ce qui est reellement perdu : une fenetre pleine de
    // parole qu'on n'a pas pu traiter parce que Whisper n'etait pas pret.
    if (!whisperPret && cloture && dureeFenetre() >= DUREE_MIN) {
      passesIgnoreesAttente++;
      viderFenetre();
      reinitialiserTexteFenetre();
    }
    return;
  }

  const part = partParole();
  const cloturante = cloture;

  // Presque rien de parle la-dedans : on n'envoie pas. C'est exactement sur ces
  // fenetres-la que Whisper invente (voir PART_PAROLE_MIN).
  if (part < PART_PAROLE_MIN) {
    passesIgnoreesSilence++;
    console.log(
      `⏭️ Passe ignorée : seulement ${Math.round(part * 100)} % de parole réelle ` +
        `(${dureeFenetre().toFixed(1)} s, ${passesIgnoreesSilence} depuis le début)`
    );
    // ⚠️ On repousse le seuil de MIN_NOUVEAU, sinon `dureeNouveau()` resterait
    // au-dessus et on repasserait ici a CHAQUE trame -- une trentaine de lignes
    // de console par seconde, sur le cas precis ou on veut pouvoir lire.
    samplesAuDernierEnvoi = fenetreSamples;

    // Meme muette, une fenetre close doit liberer la place.
    if (cloturante) {
      figerFenetre();
      viderFenetre();
    }
    return;
  }

  const audio = assemblerFenetre();
  const id = prochainePasseId++;

  passeEnVol = {
    id,
    trames: fenetre.length, // pour retrouver ce qui est arrive PENDANT l'inference
    finAudioMs,
    envoiMs: Date.now(),
    cloturante,
  };
  samplesAuDernierEnvoi = fenetreSamples;
  cloture = null; // la demande est consommee par CETTE passe

  // 2e argument : liste des buffers TRANSFERES. `audio` vient d'etre assemble
  // rien que pour ce message, la fenetre elle-meme n'est pas touchee.
  whisperWorker.postMessage(
    { type: "transcribe", id, audio, langue: langueCourante },
    [audio.buffer]
  );

  console.log(
    `➡️  Passe #${id} : ${dureeFenetre().toFixed(1)} s de fenêtre` +
      (cloturante ? ` (clôture : ${cloturante})` : "") +
      `, ${Math.round(part * 100)} % de parole`
  );
}

// ---------------------------------------------------------------------------
// Arrivee des trames du VAD
// ---------------------------------------------------------------------------

// Appelee pour CHAQUE trame analysee par le VAD (~32 ms), qu'il y ait parole ou
// non. C'est ici que la fenetre grandit, et qu'on decide de relancer.
function surTrame(trame, estParole) {
  fenetre.push(trame);
  fenetreParole.push(estParole);
  fenetreSamples += trame.length;
  finAudioMs = Date.now();

  // Au repos : la fenetre ne sert que de reserve d'amorce, on jette ce qui
  // depasse PRE_PAROLE. Sans ca elle grossirait indefiniment pendant les
  // silences.
  if (auRepos()) {
    while (dureeFenetre() > PRE_PAROLE && fenetre.length > 1) {
      fenetreSamples -= fenetre.shift().length;
      fenetreParole.shift(); // meme trame, meme sort
    }
    samplesAuDernierEnvoi = 0;
    return;
  }

  // La fenetre est pleine : on la fera clore par la prochaine passe. On ne
  // coupe PAS ici -- une passe est peut-etre en vol sur cette fenetre-la, et
  // son texte doit encore pouvoir s'y appliquer.
  if (!cloture && dureeFenetre() >= FENETRE_MAX) {
    cloture = "fenetre pleine";
  }

  lancerPasseSiPossible();
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
    // plusieurs secondes et la capture audio n'a pas a l'attendre. Tant qu'il
    // n'est pas pret, aucune passe n'est lancee et rien n'est mis en file (voir
    // peutLancerPasse) : on l'annonce a l'utilisateur juste en dessous.
    demarrerWhisper(memoBackend);

    // Compteurs et statuts repartent de zero a chaque capture.
    passeEnVol = null;
    passesFaites = 0;
    passesIgnoreesAttente = 0;
    passesIgnoreesSilence = 0;
    textesRejetes = 0;
    ruban = "";
    reinitialiserTexteFenetre();
    viderFenetre();
    clotureAvantParole = null;
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
        // La fenetre contient deja PRE_PAROLE secondes de son : le debut du
        // premier mot est dedans, on repart de la sans rien jeter.
        //
        // Et si le VAD venait de signaler une fin qu'AUCUNE passe n'a encore
        // consommee, c'est que la phrase reprend : on annule la cloture, et les
        // deux morceaux se recollent d'eux-memes dans la meme fenetre. C'est ce
        // qui evite les fenetres d'une seconde -- celles sur lesquelles
        // whisper-tiny n'ecoute pas mais recite (voir PHRASES_FANTOMES).
        //
        // On note l'etat d'avant : si cette « parole » se revele etre du bruit
        // (onVADMisfire), il faudra remettre la cloture.
        clotureAvantParole = cloture;
        if (cloture === "fin de parole") cloture = null;
        enParole = true;
      },

      // On ignore l'audio que la librairie nous tend : il repart du debut de la
      // parole et ne connait pas notre fenetre. Seul le SIGNAL de fin nous
      // interesse.
      onSpeechEnd: () => {
        console.log("🔇 PAROLE TERMINEE ! (fin)");
        enParole = false;

        // Une derniere passe sur la fenetre complete : ce texte-la sera
        // definitif. On ne vide surtout pas la fenetre ici -- c'est le RETOUR
        // de cette passe qui le fera (voir cloturerFenetre), sinon on
        // transcrirait dans le vide.
        if (!cloture) cloture = "fin de parole";
        lancerPasseSiPossible();
      },

      onVADMisfire: () => {
        console.log("❌ Fausse alerte du VAD (bruit)");
        enParole = false;

        // On ne jette RIEN. L'ancienne version vidait tout le tampon ici, et un
        // simple bruit (musique, effet sonore) suffisait alors a effacer de la
        // vraie parole jamais transcrite -- 4 a 5,5 % du son sur une source
        // avec musique.
        //
        // Si ce declenchement avait annule une cloture, on la remet : la phrase
        // precedente etait bel et bien finie.
        if (clotureAvantParole) cloture = clotureAvantParole;
        clotureAvantParole = null;
        lancerPasseSiPossible();
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

  // Ni la fenetre ni le ruban ne doivent survivre a la capture : sans ca, la
  // prochaine commencerait avec la fin de l'audio de la precedente, et
  // l'overlay rouvrirait sur le texte de la video d'avant.
  enParole = false;
  passeEnVol = null;
  clotureAvantParole = null;
  viderFenetre();
  reinitialiserTexteFenetre();
  ruban = "";

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
