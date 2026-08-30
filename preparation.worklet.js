// Enregistreur du mode « preparer d'abord ».
//
// Pourquoi un AudioWorklet et pas un ScriptProcessorNode : le ScriptProcessor
// ne se declenche QUE s'il est relie a une destination. Or c'est precisement ce
// qu'on refuse ici -- rien ne doit partir vers les haut-parleurs pendant la
// preparation. Mesure du 2026-08-27 : un AudioWorklet sans aucune connexion a
// `destination` recoit 20,01 s de son sur 20 s demandees (rms 0,131), soit
// exactement autant que le temoin cable sur les haut-parleurs.
//
// Il ne fait presque rien : accumuler les echantillons et les renvoyer par
// paquets. Le reechantillonnage et le decoupage en blocs se font dans
// offscreen.js, ou il est possible de se servir d'un OfflineAudioContext.
//
// ⚠️ LE SEUL TRAITEMENT QU'IL FAIT, C'EST LA MOYENNE DES CANAUX, ET IL COMPTE.
//
// Avant, cette classe lisait `entrees[0][0]` -- le canal GAUCHE, et lui seul.
// La moitie du son de l'onglet partait a la poubelle, et laquelle etait tiree
// au sort : dans un mixage video, la voix est au centre (identique a gauche et
// a droite) tandis que la musique et les effets sont etales entre les deux.
// Prendre un seul canal, c'est garder toute la musique de ce cote-la et toute
// la voix -- alors que la moyenne (G+D)/2 garde toute la voix et fait s'annuler
// en partie ce qui differe entre les deux canaux.
//
// Mesure du 2026-08-28, vrai whisper-tiny fp32, extrait JFK + lit musical,
// 44 mots de reference par ligne :
//
//   mixage                          canal gauche seul   moyenne (G+D)/2
//   musique identique G/D                  19 fautes         19 fautes
//   musique etalee (decorrelee)            19 fautes          4 fautes
//   musique a gauche                       19 fautes          4 fautes
//   musique a droite                        0 faute           6 fautes
//   -------------------------------------------------------------------
//   TOTAL                                  57 / 176          33 / 176
//
// La derniere ligne est le prix honnete : quand la musique est justement du
// cote qu'on ne prenait pas, on avait de la chance, et on la perd. Mais c'est
// bien de la CHANCE -- le canal gauche est un tirage au sort, et sur les trois
// autres cas il coute 15 fautes de plus. Le rapport signal/bruit gagne jusqu'a
// 5,6 dB, et c'est une mesure physique, pas une opinion.

const TAILLE_PAQUET = 4096; // 128 echantillons par message = 375 msg/s, trop.

class EnregistreurPreparation extends AudioWorkletProcessor {
  constructor() {
    super();
    this.actif = true;
    this.tampon = new Float32Array(TAILLE_PAQUET);
    this.remplissage = 0;
    this.canauxAnnonces = 0;

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

    const canaux = entrees[0];
    // Pas d'entree connectee : on reste en vie, ce n'est pas une erreur.
    if (!canaux || !canaux.length || !canaux[0]) return true;

    // On le dit UNE fois : sans ca, personne ne saurait si l'onglet arrive en
    // mono ou en stereo, et donc si la moyenne ci-dessous sert a quelque chose.
    if (this.canauxAnnonces !== canaux.length) {
      this.canauxAnnonces = canaux.length;
      this.port.postMessage({ type: "canaux", nombre: canaux.length });
    }

    const canal = canaux[0];
    const nb = canaux.length;
    for (let i = 0; i < canal.length; i++) {
      let somme = 0;
      for (let c = 0; c < nb; c++) somme += canaux[c][i];
      this.tampon[this.remplissage++] = somme / nb;
      if (this.remplissage === TAILLE_PAQUET) {
        this.port.postMessage({ type: "audio", bloc: this.tampon.slice(0) });
        this.remplissage = 0;
      }
    }
    return true;
  }
}

registerProcessor("enregistreur-preparation", EnregistreurPreparation);
