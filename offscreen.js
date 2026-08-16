console.log("🎧 Offscreen document LiveSub est pret !");

let audioContext = null;
let mediaStream = null;
let isCapturing = false;
let audioElement = null;
let vad = null;
let analyser = null;

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
    startCapture(request.streamId, request.memoBackend).then(sendResponse);
    return true; // reponse asynchrone
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

// Renseigne quand le worker a fini de charger le modele. Tant que c'est faux,
// les segments partent quand meme : le worker les met dans sa propre file et
// les traitera des qu'il sera pret.
let whisperPret = false;

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
      break;
    }

    case "progress":
      // Telechargement du modele, au premier lancement.
      console.log(`⬇️  Whisper : ${message.fichier} ${message.pourcent} %`);
      break;

    case "info":
      // Repli d'un backend sur l'autre, mesure en cours... Non bloquant.
      console.log(`ℹ️  Whisper : ${message.message}`);
      break;

    case "result": {
      const segment = segmentsEnCours.get(message.id);
      segmentsEnCours.delete(message.id);

      const texte = message.texte;
      // Sur un segment sans parole nette, Whisper renvoie souvent une chaine
      // vide ou juste de la ponctuation : inutile de polluer la console.
      if (!texte || !/[\p{L}\p{N}]/u.test(texte)) {
        console.log("   (segment sans texte exploitable)");
        break;
      }

      const duree = segment ? `${segment.secondes} s de parole` : "segment";
      console.log(
        `📝 « ${texte} »\n   (${duree}, transcrit en ${(message.ms / 1000).toFixed(1)} s ` +
          `sur ${message.backend})`
      );
      break;
    }

    case "error": {
      segmentsEnCours.delete(message.id);
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

// Envoie un segment de parole au worker. Rien a decoder : le VAD produit deja
// du Float32Array mono a 16 kHz, exactement ce que Whisper attend.
function transcrireSegment(audio) {
  // Le VAD ne peut pas tourner sans capture, et la capture demarre Whisper :
  // en pratique on ne passe jamais ici sans worker. Garde-fou quand meme.
  if (!whisperWorker) {
    console.warn("⚠️  Segment ignore : le worker Whisper n'est pas demarre");
    return;
  }

  const id = prochainSegmentId++;
  const secondes = (audio.length / 16000).toFixed(1);
  segmentsEnCours.set(id, { secondes });

  // On envoie une COPIE, et c'est elle qu'on transfere. Transferer directement
  // le tableau du VAD viderait un buffer dont la librairie est proprietaire.
  // La copie coute quelques centaines de Ko, le risque n'en vaut pas la peine.
  const copie = new Float32Array(audio);

  // 2e argument : liste des buffers TRANSFERES. Le tableau change de
  // proprietaire au lieu d'etre copie une seconde fois pour passer au worker.
  whisperWorker.postMessage(
    { type: "transcribe", id, audio: copie, langue: null },
    [copie.buffer]
  );

  const attente = whisperPret ? "" : " (le modele charge encore, ca patientera)";
  console.log(`➡️  Segment #${id} envoye a Whisper : ${secondes} s${attente}`);

  // Un retard qui s'installe se voit ici : la transcription ne suit plus la
  // parole. Utile a savoir avant de brancher l'overlay.
  if (segmentsEnCours.size > 3) {
    console.warn(`⚠️  ${segmentsEnCours.size} segments en attente de transcription`);
  }
}


// Démarrer la capture.
// Ne rejette JAMAIS : renvoie toujours { success, error?, warning? }, parce que
// c'est cette reponse qui decide si le background a le droit d'ecrire "actif".
async function startCapture(streamId, memoBackend) {
  try {
    console.log("🎤 Offscreen : demarrage capture avec streamId :", streamId);

    // Si on a déjà une capture, on l'arrête d'abord
    if (mediaStream) {
      console.log("🔄 Flux deja existant, on le ferme d'abord");
      await stopCapture();
    }

    // Whisper se met en route en parallele : le chargement du modele prend
    // plusieurs secondes et la capture audio n'a pas a l'attendre. Les premiers
    // segments arriveront peut-etre avant qu'il soit pret -- le worker les garde
    // dans sa file et les traitera dans l'ordre.
    demarrerWhisper(memoBackend);

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

    // Rediriger le son vers les haut-parleurs (pour que l'utilisateur l'entende)
    audioElement = new Audio();
    audioElement.srcObject = stream;
    audioElement.play();
    console.log("🔊 Offscreen : son redirige vers les haut-parleurs");

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

      onSpeechStart: () => {
        console.log("🗣️ PAROLE DETECTEE ! (debut)");
      },
      onSpeechEnd: (audio) => {
        console.log("🔇 PAROLE TERMINEE ! (fin)");
        // Le segment part a Whisper : Float32Array mono 16 kHz, deja au bon
        // format. Le texte arrivera dans la console via whisperWorker.onmessage.
        transcrireSegment(audio);
      },
      onVADMisfire: () => {
        console.log("❌ Fausse alerte du VAD (bruit)");
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
