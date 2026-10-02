// Enregistreur pour la page de mesure `test-anticipation.html`.
//
// Pourquoi un AudioWorklet et pas un ScriptProcessorNode : le ScriptProcessor a
// justement le defaut qu'on veut MESURER ici (il ne se declenche pas s'il n'est
// pas relie a une destination). Utiliser un noeud qui porte deja le biais
// rendrait la question 3 indecidable.
//
// Deux choses sont remontees, et il ne faut pas les confondre :
//   - `appels`   : combien de fois le moteur audio a reclame du son. Zero =
//                  le graphe n'est pas "tire" du tout.
//   - `rms/max`  : ce que valait ce son. Zero avec des appels non nuls = le
//                  graphe tourne mais la capture ne livre rien.
// C'est exactement la difference entre "Chrome n'execute pas mon noeud" et
// "tabCapture ne capte plus".

const TAILLE_BLOC = 4096; // on regroupe : 128 echantillons par message = 375 msg/s

class Enregistreur extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.envoyer = !!o.envoyer; // false = statistiques seules (question 3)
    this.actif = true;

    this.appels = 0;
    this.appelsAvecEntree = 0;
    this.echantillons = 0;
    this.sommeCarres = 0;
    this.max = 0;

    this.tampon = new Float32Array(TAILLE_BLOC);
    this.remplissage = 0;

    this.port.onmessage = (e) => {
      if (e.data === "stop") {
        this.viderTampon();
        this.port.postMessage({ type: "fin", ...this.statistiques() });
        this.actif = false;
      } else if (e.data === "stats") {
        this.port.postMessage({ type: "stats", ...this.statistiques() });
      }
    };
  }

  statistiques() {
    return {
      appels: this.appels,
      appelsAvecEntree: this.appelsAvecEntree,
      echantillons: this.echantillons,
      rms: this.echantillons ? Math.sqrt(this.sommeCarres / this.echantillons) : 0,
      max: this.max,
      tauxContexte: sampleRate,
      instantContexte: currentTime,
    };
  }

  viderTampon() {
    if (this.envoyer && this.remplissage > 0) {
      this.port.postMessage({
        type: "audio",
        bloc: this.tampon.slice(0, this.remplissage),
      });
      this.remplissage = 0;
    }
  }

  process(entrees) {
    if (!this.actif) return false;
    this.appels++;

    const canal = entrees[0] && entrees[0][0];
    if (!canal) {
      // Entree deconnectee : on continue de tourner, c'est une information.
      return true;
    }
    this.appelsAvecEntree++;

    for (let i = 0; i < canal.length; i++) {
      const v = canal[i];
      this.sommeCarres += v * v;
      const a = v < 0 ? -v : v;
      if (a > this.max) this.max = a;

      if (this.envoyer) {
        this.tampon[this.remplissage++] = v;
        if (this.remplissage === TAILLE_BLOC) {
          this.port.postMessage({ type: "audio", bloc: this.tampon.slice(0) });
          this.remplissage = 0;
        }
      }
    }
    this.echantillons += canal.length;
    return true;
  }
}

registerProcessor("enregistreur", Enregistreur);
