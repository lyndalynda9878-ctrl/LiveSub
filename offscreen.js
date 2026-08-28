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
//
// ---------------------------------------------------------------------------
// ⚠️ IL N'Y A PLUS UN BON RETARD, MAIS DEUX -- UN PAR MODE D'AFFICHAGE.
// ---------------------------------------------------------------------------
//
// La regle est la meme dans les deux cas : ON MESURE L'AGE DU DERNIER MOT
// REELLEMENT AFFICHE. Ce qui change, c'est quel mot c'est.
//
//   « avec la fin provisoire » -> le dernier mot affiche est le dernier mot de
//   la passe, donc le bout de la fenetre. Repere : `passe.finAudioMs`.
//
//   « stable seulement »       -> le dernier mot affiche est le dernier mot
//   CONFIRME, c'est-a-dire le dernier sur lequel deux passes successives sont
//   tombees d'accord. LocalAgreement-2 le borne par l'hypothese PRECEDENTE :
//   un mot ne peut pas etre confirme s'il n'etait pas deja dans la passe
//   d'avant. Repere : `finAudioPassePrecedente`.
//
// L'ecart entre les deux reperes, c'est exactement l'audio avale entre deux
// passes -- la cadence. D'ou l'attendu : retard stable ≈ retard provisoire + 1
// cadence.
//
// Prendre `finAudioMs` dans les deux cas etait le defaut a corriger : en mode
// stable, on calait le son sur la fin de la FENETRE alors que l'ecran montrait
// du texte plus vieux d'une cadence. Le son passait donc systematiquement en
// avance sur le texte lu.
//
// Les deux sont mesures dans le MEME passage de calibration : les deux reperes
// vivent sur les memes passes, faire calibrer l'utilisateur deux fois n'aurait
// servi a rien -- et cocher la case doit recaler le son tout de suite.
let modeRetard = 0; // 0 (desactive) | un nombre de secondes | "auto"
let echantillonsRetard = [];       // mode « avec la fin provisoire »
let echantillonsRetardStable = []; // mode « stable seulement »
let retardApplique = null; // renseigne des que la calibration a tranche

// Les deux verdicts de la calibration, une fois qu'elle a tranche. Gardes pour
// pouvoir basculer d'un mode a l'autre A CHAUD sans remesurer.
let retardsCalibres = null; // { avecProvisoire, stable }

// Le mode d'affichage courant. L'offscreen ne l'utilise QUE pour choisir lequel
// des deux retards appliquer au son : c'est content.js qui decide ce qui
// s'affiche. Defaut false = stable seul, comme dans content.js et la popup.
let afficherProvisoire = false;

// Applique au noeud de retard la valeur calibree qui correspond au mode
// d'affichage courant. Appelee a la fin de la calibration, et a chaque fois que
// la case de la popup change -- c'est ce qui fait que cocher/decocher recale le
// son immediatement, sans redemarrer la capture ni remesurer.
//
// Ne fait rien hors du mode auto : un reglage manuel est un ordre, pas une
// suggestion, et il ne doit pas bouger sous les pieds de l'utilisateur.
function appliquerRetardDuMode(origine) {
  if (modeRetard !== "auto" || !retardsCalibres) return;

  const valeur = afficherProvisoire
    ? retardsCalibres.avecProvisoire
    : retardsCalibres.stable;
  if (typeof valeur !== "number") return;

  retardApplique = valeur;
  if (delayNode) delayNode.delayTime.value = valeur;
  console.log(
    `🎚️ Retard du son : ${valeur.toFixed(1)} s ` +
      `(${afficherProvisoire ? "avec provisoire" : "stable seul"}, ${origine})`
  );
}

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
      request.retardCalibre,
      request.afficherProvisoire
    )
      .then(sendResponse)
      // ⚠️ CE CATCH N'EST PAS DECORATIF.
      //
      // `return true` promet une reponse. Si la promesse est rejetee sans etre
      // rattrapee, sendResponse n'est JAMAIS appele : le service worker attend
      // sa reponse indefiniment, la popup reste sur « Demarrage… », et rien
      // n'apparait nulle part -- ni erreur, ni echec, ni delai.
      //
      // C'est ce qui s'est produit quand une erreur de chargement a laisse ce
      // fichier a moitie evalue : startCapture rejetait avant meme son try, et
      // le bouton Demarrer ne repondait plus. Un bug muet par construction.
      // Desormais, quoi qu'il arrive, la popup recoit une reponse.
      .catch((err) => {
        console.error("❌ startCapture a rejete :", err);
        sendResponse({
          success: false,
          error: "Le module audio a echoue : " + (err && err.message ? err.message : err),
        });
      });
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
      // l'ancienne mesure, on remet le son a plat et on remesure. Les DEUX
      // series repartent de zero, sinon la moitie du verdict serait un melange
      // de l'ancienne et de la nouvelle mesure.
      echantillonsRetard = [];
      echantillonsRetardStable = [];
      retardsCalibres = null;
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

  // La case « Afficher la fin provisoire » a change dans la popup. Ici, ca ne
  // change RIEN a ce qu'on produit -- on envoie toujours ruban ET provisoire,
  // c'est content.js qui choisit ce qu'il affiche. Ca ne sert qu'a recaler le
  // son : le texte stable arrive une cadence plus tard, donc le bon retard
  // n'est pas le meme dans les deux modes.
  //
  // ⚠️ POURQUOI UN MESSAGE ET PAS chrome.storage.onChanged ICI :
  // `chrome.storage` est INDEFINI dans un document offscreen (verifie dans
  // Chrome : `typeof chrome.storage === "undefined"`, alors que `chrome` existe).
  // Une premiere version ecoutait le storage directement : la ligne levait un
  // TypeError AU CHARGEMENT, tuant tout le reste du fichier, et la capture
  // restait bloquee sur « Demarrage… » sans le moindre message d'erreur.
  // C'est exactement pour ca que la langue et le retard passent deja par le
  // service worker -- on suit la meme voie, il n'y en a pas d'autre.
  if (request.type === "PROVISOIRE") {
    afficherProvisoire = Boolean(request.afficherProvisoire);
    appliquerRetardDuMode("bascule à chaud");
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
        const maintenant = Date.now();

        // Repere 1 : la fin de la fenetre, donc le dernier mot du provisoire.
        const besoin = (maintenant - passe.finAudioMs) / 1000;
        echantillonsRetard.push(besoin);

        // Repere 2 : la fin de l'hypothese PRECEDENTE, donc le dernier mot que
        // le prefixe commun peut rendre stable.
        //
        // Tant qu'aucune passe n'a encore ete acceptee (premiere passe de la
        // capture, ou juste apres une fermeture de fenetre), il n'y a pas
        // d'hypothese precedente : on retombe sur le meme repere. Cet
        // echantillon-la SOUS-ESTIME donc le retard stable -- sans consequence,
        // puisqu'on garde le MAXIMUM des cinq et que les suivants, eux, ont un
        // predecesseur.
        const repereStable = finAudioPassePrecedente || passe.finAudioMs;
        const besoinStable = (maintenant - repereStable) / 1000;
        echantillonsRetardStable.push(besoinStable);

        console.log(
          `🎚️ Calibration ${echantillonsRetard.length}/5 : ${besoin.toFixed(1)} s ` +
            `(avec provisoire) / ${besoinStable.toFixed(1)} s (stable seul)`
        );

        if (echantillonsRetard.length === 5) {
          // Le MAXIMUM, pas la moyenne : mieux vaut un texte legerement EN
          // AVANCE sur la voix qu'en retard. Un sous-titre en avance se lit
          // tranquillement ; un sous-titre en retard ne sert plus a rien.
          // +0,3 s de marge, et 18 s de plafond (le noeud en accepte 20).
          const arrondir = (echantillons) =>
            Math.round(Math.min(18, Math.max(...echantillons) + 0.3) * 10) / 10;

          retardsCalibres = {
            avecProvisoire: arrondir(echantillonsRetard),
            stable: arrondir(echantillonsRetardStable)
          };

          console.log(
            `🎚️ Retards calibrés : ${retardsCalibres.avecProvisoire.toFixed(1)} s ` +
              `(avec provisoire) / ${retardsCalibres.stable.toFixed(1)} s (stable seul) ` +
              `— écart ${(retardsCalibres.stable - retardsCalibres.avecProvisoire).toFixed(1)} s, ` +
              `soit une cadence`
          );

          appliquerRetardDuMode("calibration");

          chrome.runtime
            .sendMessage({
              type: "RETARD_CALIBRE",
              avecProvisoire: retardsCalibres.avecProvisoire,
              stable: retardsCalibres.stable
            })
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
        // Les instants arrivent a cote du texte, et n'influencent RIEN de ce qui
        // precede : les garde-fous, LocalAgreement-2 et le ruban se comportent
        // exactement comme avant. Si l'alignement echoue, `instants` vaut null
        // et on retombe sur le comportement d'avant l'etape 1.
        const instants = instantsAbsolus(message.mots, decouperEnMots(texte), passe);
        if (message.mots && !instants) {
          motsSansInstant++;
          console.warn(
            `⏱️ Passe #${passe.id} : horodatages ecartes (recollage != mots affiches). ` +
              `${motsSansInstant} depuis le debut. Texte : "${texte}"`
          );
        }
        accepterTexte(texte, instants);

        // Le ruban vient d'avancer jusqu'au prefixe commun avec l'hypothese
        // PRECEDENTE : le dernier mot stable ne peut donc pas etre plus recent
        // que la fin de cette passe-la. C'est le repere qu'on envoie a
        // content.js pour qu'il mesure l'age de ce qu'il affiche vraiment.
        if (finAudioPassePrecedente) finAudioStableMs = finAudioPassePrecedente;
        finAudioPassePrecedente = passe.finAudioMs;

        const age = ((Date.now() - passe.finAudioMs) / 1000).toFixed(1);
        const ageStable = finAudioStableMs
          ? ((Date.now() - finAudioStableMs) / 1000).toFixed(1)
          : age;
        console.log(
          `📝 Passe #${passe.id} en ${(message.ms / 1000).toFixed(1)} s ` +
            `(âge du son : ${age} s avec provisoire, ${ageStable} s stable seul) ` +
            `| stable « …${texteDe(rubanMots).slice(-70)} » | provisoire « ${texteDe(provisoireMots)} »`
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

        // TOUT le provisoire vient de devenir stable : le texte stable atteint
        // maintenant la fin de la fenetre. C'est le seul moment ou les deux
        // reperes se rejoignent -- et c'est ce qui garantit qu'aucun mot de fin
        // de phrase n'est perdu en mode stable : la cloture les y verse tous.
        //
        // (Sur « fenetre pleine » on a jete le dernier demi-mot, donc le stable
        // s'arrete en realite un mot avant. On surestime alors sa fraicheur de
        // ~0,4 s, ce qui pousse le son a passer legerement en avance -- le bon
        // sens de l'erreur.)
        finAudioStableMs = passe.finAudioMs;

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
// point-la, au moment ou le texte s'affiche, qui donne le bon retard du son en
// mode « avec la fin provisoire » (voir la calibration en haut de fichier).
let finAudioMs = 0;

// Les deux reperes du mode « stable seulement ».
//
// `finAudioStableMs` : jusqu'ou va le son dont le texte est DEJA dans le ruban.
// C'est lui qu'on envoie a content.js, qui mesure l'age de ce qu'il affiche
// vraiment. Il reste en arriere de `finAudioMs` d'environ une cadence.
//
// `finAudioPassePrecedente` : la fin de fenetre de la passe qui a fourni
// `motsPassePrecedente`. Les deux vont ensemble et sont remis a zero ensemble
// (voir reinitialiserTexteFenetre) : le prefixe commun est calcule contre cette
// hypothese-la, donc le ruban ne peut pas depasser ce point.
let finAudioStableMs = 0;
let finAudioPassePrecedente = 0;

// La passe en vol, ou null. UN SEUL element possible : c'est toute la regle du
// moteur. { id, trames, samples, finAudioMs, envoiMs, cloturante }
//
// `samples` sert a dater les mots : Whisper rend l'instant de chaque mot en
// secondes DEPUIS LE DEBUT DE L'EXTRAIT ENVOYE. Pour en faire une heure, il faut
// savoir quand cet extrait commencait -- soit `finAudioMs - samples / TAUX`.
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
//
// ⚠️ C'EST UNE LISTE DE MOTS, PLUS UNE CHAINE, et c'est le changement central de
// l'etape 1 : chaque entree vaut { mot, instant }, ou `instant` est l'heure
// ABSOLUE (echelle Date.now) a laquelle ce mot a ete prononce -- ou null si la
// passe n'a pas fourni d'horodatage exploitable.
//
// Pourquoi une liste et pas « la chaine d'un cote, les instants de l'autre » :
// le ruban est tronque par le debut quand il depasse RUBAN_MAX, et une
// troncature qui ne tomberait pas au meme endroit dans les deux structures
// afficherait chaque mot a l'heure de son voisin -- un decalage silencieux,
// impossible a voir en lisant le code. Ici la chaine est DERIVEE (`texteDe`),
// elle ne peut pas diverger.
let rubanMots = [];

// La fin encore incertaine, telle que la voit la derniere passe acceptee.
// Meme forme que le ruban.
let provisoireMots = [];

// La chaine, pour l'affichage et les journaux. Toujours calculee, jamais
// stockee : voir ci-dessus.
function texteDe(entrees) {
  return entrees.map((e) => e.mot).join(" ");
}

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
// Passes ou Whisper a bien rendu des horodatages, mais ou le recollage ne
// retombait pas sur les mots affiches : on les a ecartes. Doit rester a 0 ou
// tres bas -- s'il grimpe, la regle de recollage a un trou.
let motsSansInstant = 0;
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
  provisoireMots = [];
  motsPassePrecedente = [];
  motsConfirmes = 0;
  // Va de pair avec motsPassePrecedente : plus d'hypothese precedente, donc
  // plus de repere. Le laisser trainer ferait croire que du texte de la fenetre
  // d'AVANT est encore en attente de confirmation.
  finAudioPassePrecedente = 0;
}

// Sommes-nous au repos ? (rien en cours, rien a finir, rien d'affiche en
// provisoire) Dans ce cas la fenetre ne sert que de reserve d'amorce.
function auRepos() {
  return (
    !enParole &&
    !cloture &&
    !passeEnVol &&
    motsPassePrecedente.length === 0 &&
    provisoireMots.length === 0
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

// ---------------------------------------------------------------------------
// Les instants : de « 2,36 s dans l'extrait » a « telle heure »
// ---------------------------------------------------------------------------

// Recolle les morceaux de Whisper en mots typographiques.
//
// ⚠️ Un « mot » de Whisper n'en est pas un. « J'adore, » arrive en DEUX
// morceaux : « J » puis « 'adore, ». Ce qui distingue deux morceaux du meme mot
// de deux mots differents, c'est l'ESPACE qui precede -- verifie dans Chrome :
//
//   [" J", "'adore,", " j", "'aime,", " je", " n", "'aime", " pas,", ...]
//
// D'ou le texte transmis sans `.trim()` par le worker : trimmer effacait la
// seule information qui permet de recoller.
//
// L'instant retenu pour un mot est celui de son PREMIER morceau : c'est le
// moment ou on commence a l'entendre, donc celui ou il doit s'afficher.
function recollerMots(morceaux) {
  const mots = [];
  for (const morceau of morceaux) {
    const brut = String(morceau.mot || "");
    if (!brut.trim()) continue; // morceau vide : rien a recoller
    if (mots.length === 0 || /^\s/.test(brut)) {
      mots.push({ mot: brut.trim(), debut: morceau.debut });
    } else {
      mots[mots.length - 1].mot += brut.trim();
    }
  }
  return mots;
}

// Un instant absolu par mot affiche, ou null si on ne peut pas garantir
// l'alignement.
//
// `motsAffiches` sont les mots tels que l'overlay les verra (decouperEnMots).
// Le recollage doit redonner EXACTEMENT ceux-la.
function instantsAbsolus(morceaux, motsAffiches, passe) {
  if (!Array.isArray(morceaux) || morceaux.length === 0) return null;

  const recolles = recollerMots(morceaux);

  // ⚠️ LE GARDE-FOU QUI REND CETTE ETAPE SANS RISQUE. Si le recollage ne redonne
  // pas mot pour mot ce qui sera affiche, on renonce aux instants POUR CETTE
  // PASSE plutot que de les decaler d'un cran. Un mot affiche a l'heure de son
  // voisin serait pire que pas d'heure du tout, et le decalage se propagerait
  // sans jamais rien casser de visible. content.js sait retomber sur sa cadence
  // quand l'instant manque : le pire cas est l'affichage d'avant, pas un bug.
  if (recolles.length !== motsAffiches.length) return null;
  for (let i = 0; i < recolles.length; i++) {
    if (normaliserTexte(recolles[i].mot) !== normaliserTexte(motsAffiches[i])) return null;
  }

  const debutFenetreMs = passe.finAudioMs - (passe.samples / TAUX) * 1000;
  const instants = [];
  let precedent = debutFenetreMs;

  for (const recolle of recolles) {
    let t =
      recolle.debut == null || !Number.isFinite(recolle.debut)
        ? null
        : debutFenetreMs + recolle.debut * 1000;

    // ⚠️ Whisper complete TOUT extrait a 30 s avant de le traiter, et
    // l'alignement place parfois les derniers mots dans ce silence de
    // remplissage. Mesure a l'etape 0 : sur une fenetre de 11 s, 9 mots dates
    // au-dela de la fin, dont un a +7,4 s. Un mot date dans le futur ne
    // s'afficherait JAMAIS a l'heure -- l'ecran resterait fige a l'attendre.
    // On le ramene donc dans la fenetre, ou il a forcement ete prononce.
    if (t == null) t = precedent;
    if (t < debutFenetreMs) t = debutFenetreMs;
    if (t > passe.finAudioMs) t = passe.finAudioMs;

    // Et jamais en arriere : l'affichage lit cette liste dans l'ordre, un
    // instant qui recule bloquerait tout ce qui suit.
    if (t < precedent) t = precedent;

    instants.push(Math.round(t));
    precedent = t;
  }
  return instants;
}

// ---------------------------------------------------------------------------

// Verse des mots dans le ruban, en le bornant a RUBAN_MAX.
// `entrees` : [{ mot, instant }].
function ajouterAuRuban(entrees) {
  if (!entrees.length) return;
  rubanMots.push(...entrees);

  // On jette les plus vieux mots par le debut, un mot entier a la fois.
  // ⚠️ La coupure tombe donc TOUJOURS sur une frontiere de mot -- c'etait deja
  // la regle du temps ou le ruban etait une chaine, parce que content.js aligne
  // son affichage sur les mots : un ruban tranche en plein mot lui ferait croire
  // que tout a change, et il re-revelerait du texte deja lu. Avec une liste,
  // cette regle n'est plus une precaution, elle est structurelle.
  while (rubanMots.length > 1 && texteDe(rubanMots).length > RUBAN_MAX) {
    rubanMots.shift();
  }
}

// Applique le texte d'une passe : ce qui est confirme part au ruban, le reste
// devient le provisoire.
//
// `instants` : un instant par mot de `texte`, dans le meme ordre, ou null si
// cette passe n'en a pas fourni d'exploitable. LocalAgreement-2 lui-meme n'a PAS
// change d'une ligne -- il compare toujours des mots ; l'instant voyage a cote.
function accepterTexte(texte, instants) {
  const mots = decouperEnMots(texte);
  const commun = prefixeCommun(motsPassePrecedente, mots);
  const entree = (i) => ({ mot: mots[i], instant: instants ? instants[i] : null });

  if (commun > motsConfirmes) {
    // On verse la version de la passe LA PLUS RECENTE (meilleure ponctuation).
    const neufs = [];
    for (let i = motsConfirmes; i < commun; i++) neufs.push(entree(i));
    ajouterAuRuban(neufs);
    motsConfirmes = commun;
  }

  provisoireMots = [];
  for (let i = motsConfirmes; i < mots.length; i++) provisoireMots.push(entree(i));
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
  let mots = provisoireMots.slice();

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
// On envoie TOUJOURS les deux textes, ruban ET provisoire, quel que soit le
// mode d'affichage : c'est content.js qui choisit ce qu'il montre. Le moteur,
// lui, ne connait pas les modes -- il produit, il n'affiche pas.
//
// Deux reperes temporels l'accompagnent, un par mode, parce que les deux modes
// n'affichent pas le meme dernier mot :
//   `finAudio`       = fin de la fenetre        -> age du dernier mot PROVISOIRE
//   `finAudioStable` = fin de l'hypothese d'avant -> age du dernier mot STABLE
//
// content.js prend celui qui correspond a ce qu'il affiche, et mesure l'age du
// mot le plus recent au moment ou il apparait. C'est ce chiffre-la qui donne le
// bon retard du son.
function envoyerFlux(finAudio) {
  chrome.runtime
    .sendMessage({
      type: "FLUX",
      ruban: texteDe(rubanMots),
      provisoire: texteDe(provisoireMots),
      // Un instant par mot, dans le meme ordre que les mots de la chaine.
      // `null` la ou la passe n'a pas fourni d'horodatage exploitable :
      // content.js retombe alors sur sa cadence pour ce mot-la, il n'y a pas de
      // trou a l'ecran.
      rubanInstants: rubanMots.map((e) => e.instant),
      provisoireInstants: provisoireMots.map((e) => e.instant),
      finAudio,
      finAudioStable: finAudioStableMs || null
    })
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
    samples: fenetreSamples, // pour dater les mots : voir instantsAbsolus
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
async function startCapture(
  streamId,
  memoBackend,
  langue,
  retard,
  retardCalibre,
  modeProvisoire
) {
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
    motsSansInstant = 0;
    rubanMots = [];
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
    echantillonsRetardStable = [];
    retardApplique = null;

    // Le mode d'affichage arrive du service worker. Il ne sert ICI qu'a choisir
    // laquelle des deux valeurs calibrees appliquer au son ; ensuite c'est
    // storage.onChanged qui suit les bascules (voir appliquerRetardDuMode).
    afficherProvisoire = Boolean(modeProvisoire);

    // La memoire ne vaut que si elle porte les DEUX modes. Une valeur d'une
    // generation precedente (un simple nombre) est refusee net : mieux vaut
    // 30 s de recalibration qu'un son cale sur un texte qui n'existe plus.
    retardsCalibres =
      retardCalibre &&
      typeof retardCalibre.avecProvisoire === "number" &&
      typeof retardCalibre.stable === "number"
        ? retardCalibre
        : null;

    if (modeRetard === "auto" && retardsCalibres) {
      // 1. Mode auto, deja calibre sur cette machine -> on applique tout de
      //    suite celui qui correspond au mode d'affichage. C'est ce qui evite
      //    de repasser par le trou de calibration a chaque lancement.
      appliquerRetardDuMode("mémorisé");
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
  // des valeurs memorisees (mode auto deja calibre) ou remesurera.
  echantillonsRetard = [];
  echantillonsRetardStable = [];
  retardsCalibres = null;
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
  rubanMots = [];
  // Les reperes aussi : sans ca, la prochaine capture daterait ses premiers
  // mots stables de la video precedente et calculerait un age absurde.
  finAudioMs = 0;
  finAudioStableMs = 0;

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


// ===========================================================================
// MODE « PREPARER D'ABORD » — etape A : constituer le stock, en silence
// ===========================================================================
//
// Un mode a COTE du direct, pas une variante du direct. Rien de ce qui suit ne
// touche a une seule variable du moteur en flux : ni `fenetre`, ni `rubanMots`,
// ni `audioContext`, ni `whisperWorker`. Tout ce qui appartient a la
// preparation porte le prefixe `prep`, y compris son propre worker Whisper et
// son propre AudioContext. Les deux modes ne tournent jamais ensemble (le
// service worker refuse de demarrer l'un si l'autre est actif), mais s'ils se
// croisaient, ils ne se marcheraient pas dessus.
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
// Sauf que whisper.worker.js impose `max_new_tokens: MAX_JETONS` avec
// MAX_JETONS = 60 -- une valeur dimensionnee pour les segments de 7 s de
// l'ancien decoupage (« ~20 a 25 mots », dit son commentaire). Un bloc de 30 s
// de parole continue depasse ce quota et le texte est COUPE EN PLEIN MILIEU.
//
// Mesure directe du meme jour, extrait de parole continue, worker de production :
//   bloc de 15 s -> dernier mot a 14,86 s, soit 99 % du bloc couvert
//   bloc de 30 s -> dernier mot a 25,82 s, soit 86 % -- 14 % de perdus
// Et le premier run complet le confirme : 46,9 mots par bloc de 30 s, soit
// exactement le plafond de 60 jetons.
//
// ⚠️ MISE A JOUR DU 2026-08-28 : LE PLAFOND EST LEVE, LA CONTRAINTE NE TIENT
// PLUS -- MAIS ON N'A PAS ENCORE MESURE LA SUITE.
//
// whisper.worker.js accepte desormais un plafond de jetons par requete, et la
// preparation le dimensionne sur la duree du bloc (PREP_JETONS_PAR_S). La seule
// raison de rester a 15 s a donc disparu, et 30 s redevient possible -- ce qui
// ferait passer la preparation de 2,44x a 4,20x le temps reel, soit de « ca
// passe sans marge » a « c'est fini bien avant la video ».
//
// On ne le fait PAS dans la meme fournee : un bloc plus long est aussi un trou
// plus grand quand Whisper renonce sur ce bloc-la, et c'est justement ce qu'on
// est en train de corriger. A mesurer separement, sur du son reel : couverture
// et nombre de mots par seconde a 15 s contre 30 s.
const PREP_BLOC_CONTENU = 15;

// Ce que Whisper attend.
const PREP_TAUX = 16000;

// En dessous de ca, un reste de fin n'est pas transcrit : sur moins d'une
// seconde whisper-tiny n'ecoute plus, il recite (voir CLAUDE.md).
const PREP_RESTE_MIN_CONTENU = 1.0;

// ---------------------------------------------------------------------------
// Combien de jetons Whisper a le droit d'ecrire pour UN bloc
// ---------------------------------------------------------------------------
//
// ⚠️ LE PLAFOND PAR DEFAUT DU WORKER (60 jetons) COUPE LE FRANCAIS EN PLEIN
// MILIEU, ET C'EST MESURE.
//
// Mesure du 2026-08-28, tokenizer de whisper-tiny, en local :
//     francais  1,55 jeton par mot   (« Les chercheurs ont decouvert… » : 31
//                                     mots -> 48 jetons)
//     anglais   1,05 jeton par mot   (JFK : 22 mots -> 23 jetons)
//
// 60 jetons valent donc 39 mots francais. Un bloc de 15 s ne tient sous ce
// plafond que si on parle a MOINS DE 2,6 MOTS PAR SECONDE -- c'est-a-dire
// presque jamais : un documentaire tourne autour de 3 mots/s, une conversation
// autour de 4. Au-dela, Whisper est coupe net, sans rien signaler : le bloc rend
// un texte parfaitement credible qui s'arrete au bout de 10 a 13 s, et les
// dernieres secondes de CHAQUE bloc n'ont aucun mot dans le stock.
//
// C'est exactement la maladie constatee -- des phrases entieres qui manquent, et
// un overlay qui s'efface tout seul en plein milieu de la parole.
//
// Le plafond n'est pas supprime pour autant : il est ce qui empeche une boucle
// de repetition de monopoliser le worker. Il est simplement DIMENSIONNE SUR LE
// BLOC : 12 jetons par seconde de contenu, soit ~7,7 mots francais par seconde,
// le double du debit le plus rapide. Une boucle de repetition reste bornee, et
// `no_repeat_ngram_size` l'empeche de toute facon de commencer.
const PREP_JETONS_PAR_S = 12;

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

let prepLangue = "french";

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
  prepArretDemande = false;
  prepDepartConfirme = false;
  prepPositionDepart = 0;
  prepAncres = [];
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

function prepDemarrerWhisper(memo) {
  if (prepWorker) return;
  console.log("⏳ Preparation : chargement du modele...");
  prepWorker = new Worker(chrome.runtime.getURL("whisper.worker.js"), { type: "module" });

  prepWorker.onmessage = (evenement) => {
    const m = evenement.data;
    switch (m.type) {
      case "ready":
        prepWorkerPret = true;
        console.log(`✅ Preparation : Whisper pret sur ${m.backend}`);
        // Meme chemin que le direct : c'est le service worker qui range le
        // verdict, l'offscreen n'a pas acces a chrome.storage.
        chrome.runtime
          .sendMessage({ type: "WHISPER_BACKEND", backend: m.backend, signature: m.signature })
          .catch(() => {});
        prepLancerPompe();
        break;
      case "progress":
        prepStatut(`⬇️ Téléchargement du modèle : ${Math.round(m.pourcent)} %`);
        break;
      case "info":
        console.log("ℹ️  Preparation :", m.message);
        break;
      case "result": {
        const a = prepAttentes.get(m.id);
        prepAttentes.delete(m.id);
        if (a) a.resolve(m);
        break;
      }
      case "error": {
        const cle = m.id == null ? "init" : m.id;
        const a = prepAttentes.get(cle);
        prepAttentes.delete(cle);
        if (a) a.reject(new Error(m.message));
        else console.error("❌ Preparation, Whisper :", m.message);
        break;
      }
    }
  };

  prepWorker.onerror = (evenement) => {
    const err = new Error(evenement.message || "erreur inconnue dans le worker");
    for (const a of prepAttentes.values()) a.reject(err);
    prepAttentes.clear();
    console.error("❌ Preparation, worker :", err.message);
  };

  prepWorker.postMessage({ type: "init", memo: memo ?? null });
}

function prepTranscrire(audio, dureeContenu) {
  const id = prepProchainId++;
  const promesse = new Promise((resolve, reject) => {
    prepAttentes.set(id, { resolve, reject });
  });
  // Le plafond de jetons est dimensionne SUR LE BLOC, pas herite du direct.
  // Voir PREP_JETONS_PAR_S : 60 jetons coupent le francais au bout de 13 s.
  prepWorker.postMessage(
    {
      type: "transcribe",
      id,
      audio,
      langue: prepLangue,
      maxJetons: Math.ceil((dureeContenu || PREP_BLOC_CONTENU) * PREP_JETONS_PAR_S),
    },
    [audio.buffer]
  );
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
function prepMotsDuBloc(morceaux, posDebut, posFin, dureeBloc) {
  let echelle = dureeBloc > 0 ? (posFin - posDebut) / dureeBloc : 1;
  if (!Number.isFinite(echelle) || echelle < 0.8 || echelle > 1.25) echelle = 1;

  // recollerMots() est la fonction du moteur en flux, reutilisee telle quelle :
  // un « mot » de Whisper n'est pas un mot typographique (« J'adore, » arrive
  // en deux morceaux, « J » puis « 'adore, »), et c'est l'espace qui precede
  // qui distingue les deux cas.
  const recolles = recollerMots(morceaux || []);
  const sortie = [];
  let precedent = 0;

  for (const recolle of recolles) {
    let t = recolle.debut;
    if (t == null || !Number.isFinite(t)) t = precedent;

    // ⚠️ Whisper complete tout extrait a 30 s : sur un bloc plus court, ou en
    // fin de video, l'alignement place parfois des mots DANS le silence de
    // remplissage -- mesure a +7,4 s au-dela de la fin. Un mot date apres la
    // fin du bloc serait attribue au bloc suivant et desynchroniserait tout.
    if (t < 0) t = 0;
    if (t > dureeBloc) t = dureeBloc;
    if (t < precedent) t = precedent; // jamais en arriere
    precedent = t;

    sortie.push({
      mot: recolle.mot,
      instant: Number((posDebut + t * echelle).toFixed(3)),
    });
  }
  return sortie;
}

async function prepTraiterBloc(taille) {
  // Les deux bornes du bloc, EN ECHANTILLONS CAPTES depuis le debut : c'est le
  // repere de la table des ancres. On les releve avant de consommer.
  const debutEchantillons = prepConsommes;

  // Un bloc PLEIN se coupe au silence le plus proche ; un reste de fin part tel
  // quel (il n'y a plus rien apres lui pour reprendre ce qu'on laisserait).
  const complet = taille === prepEchantillonsParBloc();
  const brut = prepPrendre(complet ? prepTailleJusquAuSilence(taille) : taille);
  if (!brut.length) return;

  prepConsommes += brut.length;
  const dureeBloc = prepSecondesContenu(brut.length);

  // Les positions de video observees aux deux bouts. Elles remplacent le calcul
  // « depart + contenu deja consomme », qui derivait a chaque fois que la video
  // s'arretait sans que la capture s'arrete (voir prepAncres).
  const posDebut = prepPositionDe(debutEchantillons);
  const posFin = prepPositionDe(debutEchantillons + brut.length);

  const audio = await prepReechantillonner(brut);

  const debut = performance.now();
  const resultat = await prepTranscrire(audio, dureeBloc);
  const ms = Math.round(performance.now() - debut);
  prepTemoins.push(ms);

  const nouveaux = prepMotsDuBloc(resultat.mots, posDebut, posFin, dureeBloc);
  prepMots.push(...nouveaux);

  // ⚠️ DETECTEUR DE TRONCATURE — pour qu'une perte de texte ne soit JAMAIS muette.
  //
  // `max_new_tokens` coupe la sortie de Whisper sans rien signaler : le bloc
  // rend un texte parfaitement credible, simplement plus court que l'audio.
  // Rien dans le resultat ne dit « j'ai ete coupe ». Le seul indice est que le
  // dernier mot date d'AVANT la fin du bloc alors qu'on parlait encore.
  //
  // Un bloc qui se termine par du silence declenche le meme signal, d'ou la
  // condition sur le nombre de morceaux : peu de mots = vrai silence, beaucoup
  // de mots = quota atteint.
  const morceaux = Array.isArray(resultat.mots) ? resultat.mots.length : 0;
  const dernier = nouveaux.length ? nouveaux[nouveaux.length - 1].instant - posDebut : 0;
  const couvert = dureeBloc > 0 ? dernier / dureeBloc : 1;
  // ⚠️ Le seuil de morceaux a BAISSE (30 -> 12) le 2026-08-28. Il valait 30
  // parce que le plafond de jetons etait a 60 : sous 30 morceaux, un bloc court
  // ne pouvait etre que du silence. Le plafond suit maintenant la duree du bloc,
  // donc un bloc de 15 s qui ne rend que 12 mots n'est plus un bloc coupe par le
  // quota : c'est un bloc ou Whisper a renonce. C'est ca qu'on veut voir.
  if (couvert < 0.9 && morceaux >= 12) {
    console.warn(
      `⚠️ Preparation : bloc ${prepTemoins.length} INCOMPLET — ` +
        `${morceaux} morceaux, dernier mot a ${dernier.toFixed(1)} s sur ${dureeBloc.toFixed(1)} s ` +
        `(${Math.round(couvert * 100)} % couvert, plafond ${Math.ceil(dureeBloc * PREP_JETONS_PAR_S)} jetons)`
    );
    prepBlocsTronques++;
    prepStatut(`⚠️ Texte incomplet sur ${prepBlocsTronques} bloc(s)`);
  }

  console.log(
    `📦 Preparation : bloc ${prepTemoins.length} — ` +
      `${dureeBloc.toFixed(1)} s de contenu a partir de ${posDebut.toFixed(1)} s (video), ` +
      `${nouveaux.length} mots, ${ms} ms ` +
      `(${(dureeBloc / (ms / 1000)).toFixed(2)}x le temps reel)`
  );

  // Aucun filtre anti-hallucination ici, et c'est deliberé : un filtre qui
  // jette un bloc de 30 s rendrait faux le seul controle simple dont on
  // dispose -- le nombre de mots rapporte a la duree. On garde tout, quitte a
  // voir le probleme, plutot que de le masquer.
}

function prepPeutTraiter() {
  if (!prepWorkerPret) return 0;
  const besoin = prepEchantillonsParBloc();
  if (prepEnAttente >= besoin) return besoin;
  // A l'arret, on transcrit le reste meme s'il est incomplet.
  if (prepArretDemande) {
    const minimum = Math.round((PREP_RESTE_MIN_CONTENU * prepTauxCapture) / PREP_VITESSE);
    if (prepEnAttente >= minimum) return prepEnAttente;
  }
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

async function demarrerPreparation(options) {
  if (prepActif) {
    console.log("ℹ️ Preparation deja en cours");
    return { success: true, deja: true };
  }

  prepReinitialiser();
  prepLangue = options.langue || "french";

  // Whisper d'abord : le modele met du temps a charger (jusqu'a une minute au
  // tout premier lancement), autant qu'il commence pendant qu'on branche
  // l'audio. Rien ne sera transcrit avant `ready` de toute facon.
  prepDemarrerWhisper(options.memoBackend);

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
    if (m.type !== "audio") return;

    // Tant que la position de depart n'est pas connue, on JETTE : ce son-la est
    // celui d'avant le passage en accelere (video encore a x1, ou a l'arret).
    // Le garder decalerait tous les instants du stock.
    if (!prepDepartConfirme) return;

    prepBlocs.push(m.bloc);
    prepEnAttente += m.bloc.length;
    prepLancerPompe();
  };

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

  // 3. Fermer.
  if (prepContext) {
    prepContext.close().catch(() => {});
    prepContext = null;
  }
  prepSource = null;
  prepNoeud = null;
  prepActif = false;

  const resume = prepResume();
  console.log(
    `✅ Preparation terminee : ${resume.nbMots} mots, ` +
      `${resume.dureeCouverteS.toFixed(1)} s couvertes, ` +
      `${resume.motsParSeconde.toFixed(2)} mots/s`
  );
  return { success: true, ...resume };
}

// Ce que le service worker et l'overlay ont besoin de savoir. Le stock lui-meme
// (prepMots) RESTE ICI, en memoire : c'est l'etape B qui viendra le chercher.
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
