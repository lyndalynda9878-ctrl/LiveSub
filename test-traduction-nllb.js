// CANDIDAT B -- la page qui pilote le worker NLLB. Elle ne calcule rien.

const logDiv = document.getElementById("log");
const lignes = [];
function log(m) {
  console.log(m);
  lignes.push(m);
  logDiv.textContent = lignes.join("\n");
}

const SOURCE_FR = "La mort de mes premières étoiles, les trous noirs supermassifs se sont nourris pendant des milliards d'années de matière, de gaz, d'étoiles parfois, ou même d'autres trou noirs. La surface d'un trou noir marque l'espace, à l'intérieur duquel matière et lumière restent piégées sans espoir de retour. C'est l'horizon des événements. Autour d'eux. La matière tourbillonne avant de disparaître à tout jamais. Elle dessine un contour qui dévoile l'invisible.";

const SOURCE_EN = "it possible to detect these mergers are very new, so we're currently discovering a lot of exciting things. Like two massive black holes that we detected in a galaxy 17 billion light years away. As they spun around each other violently, they released more energy in the form of gravitational waves than the combined light from all the stars in the Milky Way in 4400 years. The new black hole they formed is about the size of Germany and is 142 solar masses. And here we hit a curious gap in scale there are lots of black holes up to 150 solar masses and then there's nothing for a long time. Until we suddenly hit black holes that are millions of times more";

const PAIRES = [
  { cle: "fr->en", src: "fr", dst: "en", texte: SOURCE_FR },
  { cle: "en->fr", src: "en", dst: "fr", texte: SOURCE_EN },
  { cle: "fr->ar", src: "fr", dst: "ar", texte: SOURCE_FR },
];

// Le meme texte de 2493 mots que pour le candidat A -- sinon les temps ne se
// comparent pas.
function texte2493() {
  const mots = SOURCE_FR.split(/\s+/).filter(Boolean);
  const out = [];
  while (out.length < 2493) out.push(mots[out.length % mots.length]);
  return out.slice(0, 2493).join(" ");
}

// NLLB est un modele a longueur bornee (512 jetons). 2493 mots ne passent pas
// d'un coup : on decoupe par phrases, et on additionne. C'est aussi ce qu'il
// faudrait faire en production.
function enMorceaux(texte, motsMax) {
  const phrases = texte.split(/(?<=\.)\s+/);
  const out = [];
  let courant = [];
  let n = 0;
  for (const p of phrases) {
    const m = p.split(/\s+/).filter(Boolean).length;
    if (n + m > motsMax && courant.length) {
      out.push(courant.join(" "));
      courant = [];
      n = 0;
    }
    courant.push(p);
    n += m;
  }
  if (courant.length) out.push(courant.join(" "));
  return out;
}

let worker = null;
let prochainId = 1;
const enAttente = new Map();

function creerWorker() {
  worker = new Worker(chrome.runtime.getURL("test-traduction-nllb.worker.js"), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "ready") {
      const r = enAttente.get("init");
      if (r) { enAttente.delete("init"); r.resolve(m); }
    } else if (m.type === "result") {
      const r = enAttente.get(m.id);
      if (r) { enAttente.delete(m.id); r.resolve(m); }
    } else if (m.type === "error") {
      const cle = m.phase === "init" ? "init" : m.id;
      const r = enAttente.get(cle);
      if (r) { enAttente.delete(cle); r.reject(m); }
      else log("ERREUR non reclamee : " + JSON.stringify(m, null, 2));
    }
  };
  worker.onerror = (e) => {
    log("worker.onerror : " + e.message);
    const r = enAttente.get("init");
    if (r) { enAttente.delete("init"); r.reject({ message: "worker.onerror : " + e.message }); }
  };
}

function demander(cle, message) {
  return new Promise((resolve, reject) => {
    enAttente.set(cle, { resolve, reject });
    worker.postMessage(message);
  });
}

async function charger() {
  if (!worker) creerWorker();
  log("chargement du modele...");
  try {
    const m = await demander("init", { type: "init" });
    window.NLLB_READY = m;
    log("PRET\n" + JSON.stringify({
      msChargement: m.msChargement,
      memoireWasm: m.memoireWasm,
      tasJsMo: m.tasJsMo,
      numThreads: m.numThreads,
      journal: m.journal,
    }, null, 2));
  } catch (e) {
    window.NLLB_ERREUR = e;
    log("ECHEC du chargement\n" + JSON.stringify(e, null, 2));
  }
}

async function traduireTout() {
  const res = {};
  for (const p of PAIRES) {
    log("--- " + p.cle + " ...");
    try {
      const id = prochainId++;
      const m = await demander(id, { type: "translate", id, texte: p.texte, src: p.src, dst: p.dst });
      res[p.cle] = { ms: m.ms, texte: m.texte, motsEntree: m.motsEntree, memoireWasm: m.memoireWasm };
      log(p.cle + " : " + m.ms + " ms\n" + m.texte);
    } catch (e) {
      res[p.cle] = { erreur: e };
      log(p.cle + " ECHEC\n" + JSON.stringify(e, null, 2));
    }
  }
  window.TRADUCTIONS_B = res;
  log("TERMINE");
}

async function gros() {
  const texte = texte2493();
  const morceaux = enMorceaux(texte, 60);
  log(`2493 mots decoupes en ${morceaux.length} morceaux (NLLB borne a 512 jetons)`);
  const t0 = performance.now();
  let mots = 0;
  let caracteresSortie = 0;
  let debut = "";
  try {
    for (let i = 0; i < morceaux.length; i++) {
      const id = prochainId++;
      const m = await demander(id, { type: "translate", id, texte: morceaux[i], src: "fr", dst: "en" });
      mots += m.motsEntree;
      caracteresSortie += m.texte.length;
      if (i === 0) debut = m.texte.slice(0, 300);
      if (i % 5 === 0) log(`  morceau ${i + 1}/${morceaux.length} — cumul ${Math.round(performance.now() - t0)} ms`);
    }
    window.GROS_B = {
      mots, morceaux: morceaux.length,
      msTotal: Math.round(performance.now() - t0),
      caracteresSortie, debut,
    };
    log("2493 MOTS\n" + JSON.stringify(window.GROS_B, null, 2));
  } catch (e) {
    window.GROS_B = { erreur: e, msAvantEchec: Math.round(performance.now() - t0) };
    log("2493 MOTS ECHEC\n" + JSON.stringify(e, null, 2));
  }
}

document.getElementById("btnCharger").onclick = () => charger();
document.getElementById("btnTraduire").onclick = () => traduireTout();
document.getElementById("btnGros").onclick = () => gros();
document.getElementById("btnFin").onclick = () => {
  if (worker) { worker.terminate(); worker = null; log("worker termine"); }
};

log("page chargee.");
