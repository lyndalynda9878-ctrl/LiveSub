// Journal d'avancement — fichier de MESURE, il ne touche a rien.
//
// Il repond a la seule question qui separe « c'est long » de « c'est bloque » :
// est-ce que les compteurs de TRAVAIL bougent ? On releve, toutes les 5 s :
//   - la position de la video (via l'onglet prepare)
//   - la file en attente, en secondes de contenu
//   - les blocs partis et les blocs TERMINES
//   - le temps depuis le dernier bloc termine
//
// ⚠️ Cette page est un DOCUMENT D'EXTENSION, pas le service worker : elle ne
// meurt pas au bout de 30 s. Si le journal s'arrete, ce n'est donc pas
// l'observateur qui est mort -- c'est ce qu'on observe. Le service worker, lui,
// est surveille a part (champ `swVivant`).
const logDiv = document.getElementById("log");
const JOURNAL = [];
window.JOURNAL = JOURNAL;

const t0 = Date.now();

async function sonder() {
  const ligne = { ms: Date.now() - t0 };

  // Le service worker repond-il encore ? C'est une question a part entiere :
  // un SW tue pendant une longue vidange laisse la reponse de STOP_PREPARATION
  // dans le vide, et personne ne restaure ni ne livre le stock.
  try {
    const etat = await chrome.runtime.sendMessage({ type: "PREPARATION_ETAT" });
    ligne.swVivant = true;
    ligne.prepActive = Boolean(etat && etat.active);
    ligne.tabId = etat && etat.tabId;
  } catch (e) {
    ligne.swVivant = false;
    ligne.erreurSw = String(e.message || e);
  }

  try {
    const p = await chrome.runtime.sendMessage({ type: "PREPARATION_PROGRES" });
    if (p && p.success) {
      ligne.blocsPartis = p.blocsPartis;
      ligne.blocsTermines = p.blocsTermines;
      ligne.fileS = p.fileS;
      ligne.contenuTraiteS = p.contenuTraiteS;
      ligne.debitS = p.debitS;
      ligne.depuisDernierBlocMs = p.msDepuisDernierBlocFini;
      ligne.nbMots = p.nbMots;
      ligne.nbSegments = p.nbSegments;
      ligne.actif = p.actif;
      ligne.arretDemande = p.arretDemande;
      ligne.workerVivant = p.workerVivant;
    } else {
      ligne.progresIndisponible = (p && p.error) || "pas de reponse";
    }
  } catch (e) {
    ligne.progresIndisponible = String(e.message || e);
  }

  // La position de la video, lue sur l'onglet prepare.
  if (ligne.tabId) {
    try {
      const r = await chrome.tabs.sendMessage(ligne.tabId, { type: "PREPARATION_MESURES" });
      ligne.contentRepond = Boolean(r && r.success);
    } catch (e) {
      ligne.contentRepond = false;
    }
  }

  JOURNAL.push(ligne);
  logDiv.textContent = JOURNAL.map((l) =>
    `${String((l.ms / 1000).toFixed(0)).padStart(5)} s  ` +
    `partis ${String(l.blocsPartis ?? "-").padStart(3)}  ` +
    `finis ${String(l.blocsTermines ?? "-").padStart(3)}  ` +
    `file ${String(l.fileS ?? "-").padStart(7)} s  ` +
    `traite ${String(l.contenuTraiteS ?? "-").padStart(7)} s  ` +
    `debit ${String(l.debitS ?? "-").padStart(6)}  ` +
    `dernier bloc il y a ${String(l.depuisDernierBlocMs ?? "-").padStart(7)} ms  ` +
    `mots ${String(l.nbMots ?? "-").padStart(5)}  ` +
    `sw ${l.swVivant ? "ok" : "MORT"}  ` +
    (l.progresIndisponible ? `  ⚠️ ${l.progresIndisponible}` : "")
  ).join("\n");
}

sonder();
setInterval(sonder, 5000);
