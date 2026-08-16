console.log("🎧 Offscreen document LiveSub est pret !");

let audioContext = null;
let mediaStream = null;
let isCapturing = false;
let audioElement = null;
let vad = null;
let analyser = null;

// Écouter les messages du service worker
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("📩 Offscreen a recu un message :", request);

  if (request.type === "START_CAPTURE") {
    // On repond APRES le demarrage reel. Avant, on repondait "success" tout de
    // suite sans attendre : si getUserMedia echouait ensuite, l'erreur restait
    // dans cette console et le background enregistrait quand meme "actif" --
    // la popup affichait "✅ Actif" alors que rien ne capturait.
    startCapture(request.streamId).then(sendResponse);
    return true; // reponse asynchrone
  }

  if (request.type === "STOP_CAPTURE") {
    // Meme raison : on ne confirme l'arret qu'une fois tout relache.
    stopCapture().then(() => sendResponse({ success: true }));
    return true; // reponse asynchrone
  }
});

// Démarrer la capture.
// Ne rejette JAMAIS : renvoie toujours { success, error?, warning? }, parce que
// c'est cette reponse qui decide si le background a le droit d'ecrire "actif".
async function startCapture(streamId) {
  try {
    console.log("🎤 Offscreen : demarrage capture avec streamId :", streamId);

    // Si on a déjà une capture, on l'arrête d'abord
    if (mediaStream) {
      console.log("🔄 Flux deja existant, on le ferme d'abord");
      await stopCapture();
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
        console.log("📦 Segment audio capturé, taille :", audio.length, "échantillons");

        // Ici on pourra envoyer le segment à Whisper plus tard !
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
