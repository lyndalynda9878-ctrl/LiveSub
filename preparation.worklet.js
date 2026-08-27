// Enregistreur du mode « preparer d'abord ».
//
// Pourquoi un AudioWorklet et pas un ScriptProcessorNode : le ScriptProcessor
// ne se declenche QUE s'il est relie a une destination. Or c'est precisement ce
// qu'on refuse ici -- rien ne doit partir vers les haut-parleurs pendant la
// preparation. Mesure du 2026-08-27 : un AudioWorklet sans aucune connexion a
// `destination` recoit 20,01 s de son sur 20 s demandees (rms 0,131), soit
// exactement autant que le temoin cable sur les haut-parleurs.
//
// Il ne fait qu'une chose : accumuler les echantillons et les renvoyer par
// paquets. Aucun traitement -- le reechantillonnage et le decoupage en blocs
// se font dans offscreen.js, ou il est possible de se servir d'un
// OfflineAudioContext.

const TAILLE_PAQUET = 4096; // 128 echantillons par message = 375 msg/s, trop.

class EnregistreurPreparation extends AudioWorkletProcessor {
  constructor() {
    super();
    this.actif = true;
    this.tampon = new Float32Array(TAILLE_PAQUET);
    this.remplissage = 0;

    this.port.onmessage = (evenement) => {
      if (evenement.data === "stop") {
        // Rendre ce qui reste AVANT de mourir : sans ca, la fin de la video
        // (jusqu'a 4096 echantillons) serait perdue en silence.
        this.vider();
        this.port.postMessage({ type: "fin" });
        this.actif = false;
      }
    };
  }

  vider() {
    if (this.remplissage > 0) {
      this.port.postMessage({ type: "audio", bloc: this.tampon.slice(0, this.remplissage) });
      this.remplissage = 0;
    }
  }

  process(entrees) {
    if (!this.actif) return false;

    const canal = entrees[0] && entrees[0][0];
    // Pas d'entree connectee : on reste en vie, ce n'est pas une erreur.
    if (!canal) return true;

    for (let i = 0; i < canal.length; i++) {
      this.tampon[this.remplissage++] = canal[i];
      if (this.remplissage === TAILLE_PAQUET) {
        this.port.postMessage({ type: "audio", bloc: this.tampon.slice(0) });
        this.remplissage = 0;
      }
    }
    return true;
  }
}

registerProcessor("enregistreur-preparation", EnregistreurPreparation);
