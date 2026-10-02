// CANDIDAT A -- API Translator de Chrome, contexte A3 : page d'extension a bouton.
//
// Rien de ce fichier ne touche a la production. Il MESURE, il ne branche rien.
//
// ⚠️ availability() ment par conception : Chrome annonce une paire comme
// "downloadable" tant que personne n'a essaye. On appelle donc create() pour de
// vrai, et on colle l'erreur ENTIERE si ca echoue.

const logDiv = document.getElementById("log");
const lignes = [];
function log(m) {
  console.log(m);
  lignes.push(m);
  logDiv.textContent = lignes.join("\n");
}

// L'erreur COMPLETE, pas un resume : nom, message, pile, et les champs propres
// a l'API s'il y en a.
function erreurEntiere(e) {
  const o = {
    toString: String(e),
    name: e && e.name,
    message: e && e.message,
    stack: e && e.stack,
  };
  if (e && typeof e === "object") {
    for (const k of Object.getOwnPropertyNames(e)) {
      if (!(k in o)) {
        try { o[k] = String(e[k]); } catch (_) {}
      }
    }
  }
  return o;
}

const SOURCE_FR = "La mort de mes premières étoiles, les trous noirs supermassifs se sont nourris pendant des milliards d'années de matière, de gaz, d'étoiles parfois, ou même d'autres trou noirs. La surface d'un trou noir marque l'espace, à l'intérieur duquel matière et lumière restent piégées sans espoir de retour. C'est l'horizon des événements. Autour d'eux. La matière tourbillonne avant de disparaître à tout jamais. Elle dessine un contour qui dévoile l'invisible.";

const SOURCE_EN = "it possible to detect these mergers are very new, so we're currently discovering a lot of exciting things. Like two massive black holes that we detected in a galaxy 17 billion light years away. As they spun around each other violently, they released more energy in the form of gravitational waves than the combined light from all the stars in the Milky Way in 4400 years. The new black hole they formed is about the size of Germany and is 142 solar masses. And here we hit a curious gap in scale there are lots of black holes up to 150 solar masses and then there's nothing for a long time. Until we suddenly hit black holes that are millions of times more";

const PAIRES = [
  { cle: "fr->en", src: "fr", dst: "en", texte: SOURCE_FR },
  { cle: "en->fr", src: "en", dst: "fr", texte: SOURCE_EN },
  { cle: "fr->ar", src: "fr", dst: "ar", texte: SOURCE_FR },
];

// Exactement 2493 mots, construits en repetant mon texte -- c'est la taille de
// la mesure de reference de Parakeet (CLAUDE.md).
function texte2493() {
  const mots = SOURCE_FR.split(/\s+/).filter(Boolean);
  const out = [];
  while (out.length < 2493) out.push(mots[out.length % mots.length]);
  return out.slice(0, 2493).join(" ");
}

function etatActivation() {
  return {
    isActive: navigator.userActivation ? navigator.userActivation.isActive : null,
    hasBeenActive: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
  };
}

// ---------------------------------------------------------------------------
// 1. La sonde
// ---------------------------------------------------------------------------
async function sonde() {
  const r = {
    contexte: "A3 page d'extension",
    url: location.href,
    isSecureContext,
    translatorDansSelf: "Translator" in self,
    languageDetectorDansSelf: "LanguageDetector" in self,
    typeofTranslatorCreate: typeof (self.Translator && self.Translator.create),
    activation: etatActivation(),
    availability: {},
  };
  for (const p of PAIRES) {
    try {
      r.availability[p.cle] = await self.Translator.availability({
        sourceLanguage: p.src,
        targetLanguage: p.dst,
      });
    } catch (e) {
      r.availability[p.cle] = { ECHEC: erreurEntiere(e) };
    }
  }
  try {
    r.availabilityLanguageDetector = await self.LanguageDetector.availability();
  } catch (e) {
    r.availabilityLanguageDetector = { ECHEC: erreurEntiere(e) };
  }
  log("SONDE\n" + JSON.stringify(r, null, 2));
  window.SONDE = r;
  return r;
}

// ---------------------------------------------------------------------------
// 2. create() + traduire, avec la progression du telechargement
// ---------------------------------------------------------------------------
async function creerEtTraduire(p, options) {
  options = options || {};
  const texte = options.texte != null ? options.texte : p.texte;
  const r = { paire: p.cle, activationAuCreate: etatActivation() };
  const progres = [];
  const t0 = performance.now();
  let tr;
  try {
    tr = await self.Translator.create({
      sourceLanguage: p.src,
      targetLanguage: p.dst,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          progres.push({ ms: Math.round(performance.now() - t0), loaded: e.loaded, total: e.total });
        });
      },
    });
  } catch (e) {
    r.createOk = false;
    r.createErreur = erreurEntiere(e);
    r.msCreate = Math.round(performance.now() - t0);
    r.progres = progres;
    return r;
  }
  r.createOk = true;
  r.msCreate = Math.round(performance.now() - t0);
  r.progres = progres;
  r.nbEvenementsProgres = progres.length;
  r.dernierProgres = progres[progres.length - 1] || null;

  const t1 = performance.now();
  try {
    r.traduction = await tr.translate(texte);
    r.msTraduction = Math.round(performance.now() - t1);
    r.motsEntree = texte.split(/\s+/).filter(Boolean).length;
  } catch (e) {
    r.traduireErreur = erreurEntiere(e);
    r.msTraduction = Math.round(performance.now() - t1);
  }

  // La DEUXIEME traduction : c'est elle qui dit si le reseau est encore requis.
  const t2 = performance.now();
  try {
    r.traduction2 = await tr.translate(texte);
    r.msTraduction2 = Math.round(performance.now() - t2);
    r.identiques = r.traduction2 === r.traduction;
  } catch (e) {
    r.traduire2Erreur = erreurEntiere(e);
  }
  try { if (tr.destroy) tr.destroy(); } catch (_) {}
  return r;
}

async function traduireTout() {
  const res = {};
  for (const p of PAIRES) {
    log("--- " + p.cle + " : create()...");
    res[p.cle] = await creerEtTraduire(p);
    log(JSON.stringify(res[p.cle], null, 2));
  }
  window.TRADUCTIONS_A = res;
  log("TERMINE traduireTout");
  return res;
}

// ---------------------------------------------------------------------------
// 3. LanguageDetector
// ---------------------------------------------------------------------------
async function detecteur() {
  const r = { present: "LanguageDetector" in self, activation: etatActivation() };
  try {
    r.availability = await self.LanguageDetector.availability();
    const t0 = performance.now();
    const d = await self.LanguageDetector.create({
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          r.dernierProgres = { loaded: e.loaded, total: e.total };
        });
      },
    });
    r.msCreate = Math.round(performance.now() - t0);
    r.createOk = true;
    r.surTexteFr = await d.detect(SOURCE_FR);
    r.surTexteEn = await d.detect(SOURCE_EN);
    try { if (d.destroy) d.destroy(); } catch (_) {}
  } catch (e) {
    r.createOk = false;
    r.erreur = erreurEntiere(e);
  }
  log("LANGUAGEDETECTOR\n" + JSON.stringify(r, null, 2));
  window.DETECTEUR = r;
  return r;
}

// ---------------------------------------------------------------------------
// 4. 2493 mots
// ---------------------------------------------------------------------------
async function gros() {
  const texte = texte2493();
  const r = { mots: texte.split(/\s+/).length, caracteres: texte.length };
  const t0 = performance.now();
  try {
    const tr = await self.Translator.create({ sourceLanguage: "fr", targetLanguage: "en" });
    r.msCreate = Math.round(performance.now() - t0);
    const t1 = performance.now();
    const sortie = await tr.translate(texte);
    r.msTraduction = Math.round(performance.now() - t1);
    r.caracteresSortie = sortie.length;
    r.debutSortie = sortie.slice(0, 300);
    try { if (tr.destroy) tr.destroy(); } catch (_) {}
  } catch (e) {
    r.erreur = erreurEntiere(e);
  }
  log("2493 MOTS\n" + JSON.stringify(r, null, 2));
  window.GROS = r;
  return r;
}

// ---------------------------------------------------------------------------
// Volet A -- l'activation utilisateur est-elle vraiment la contrainte ?
// ---------------------------------------------------------------------------
// ⚠️ Le volet A ne veut rien dire sur une paire DEJA installee : dans ce cas
// availability vaut "available" et l'API n'exige plus aucun geste. On le teste
// donc sur une paire encore "downloadable", et on releve availability AVANT
// create() pour que la lecture soit verifiable.
async function voletA(delaiMs, cle, dst) {
  dst = dst || "ar";
  const r = { cle, delaiMs, cible: dst, activationAuClic: etatActivation() };
  try {
    r.availabilityAvant = await self.Translator.availability({ sourceLanguage: "en", targetLanguage: dst });
  } catch (e) { r.availabilityAvant = { ECHEC: erreurEntiere(e) }; }
  if (delaiMs) await new Promise((res) => setTimeout(res, delaiMs));
  r.activationApresDelai = etatActivation();
  const t0 = performance.now();
  const progres = [];
  try {
    const tr = await self.Translator.create({
      sourceLanguage: "en",
      targetLanguage: dst,
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          progres.push({ ms: Math.round(performance.now() - t0), loaded: e.loaded, total: e.total });
        });
      },
    });
    r.createOk = true;
    r.ms = Math.round(performance.now() - t0);
    r.progres = progres;
    r.nbEvenementsProgres = progres.length;
    r.dernierProgres = progres[progres.length - 1] || null;
    r.echantillon = await tr.translate("The surface of a black hole marks space.");
    try { if (tr.destroy) tr.destroy(); } catch (_) {}
  } catch (e) {
    r.createOk = false;
    r.erreur = erreurEntiere(e);
    r.progres = progres;
    r.ms = Math.round(performance.now() - t0);
  }
  try {
    r.availabilityApres = await self.Translator.availability({ sourceLanguage: "en", targetLanguage: dst });
  } catch (e) { r.availabilityApres = { ECHEC: erreurEntiere(e) }; }
  log("VOLET A " + cle + "\n" + JSON.stringify(r, null, 2));
  window["VOLET_A_" + cle] = r;
  return r;
}

// ---------------------------------------------------------------------------
// Volet B -- retraduire une fois le reseau coupe
// ---------------------------------------------------------------------------
async function horsLigne() {
  const r = { onLine: navigator.onLine, quand: new Date().toISOString(), paires: {} };
  // Temoin : une requete reseau reelle DOIT echouer si la coupure a pris.
  const t0 = performance.now();
  try {
    const rep = await fetch("https://huggingface.co/favicon.ico", { cache: "no-store" });
    r.temoinReseau = { aboutit: true, status: rep.status, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    r.temoinReseau = { aboutit: false, erreur: erreurEntiere(e), ms: Math.round(performance.now() - t0) };
  }
  for (const p of PAIRES) {
    try {
      const t1 = performance.now();
      const tr = await self.Translator.create({ sourceLanguage: p.src, targetLanguage: p.dst });
      const msCreate = Math.round(performance.now() - t1);
      const t2 = performance.now();
      const sortie = await tr.translate(p.texte);
      r.paires[p.cle] = {
        ok: true,
        msCreate,
        msTraduction: Math.round(performance.now() - t2),
        sortie,
      };
      try { if (tr.destroy) tr.destroy(); } catch (_) {}
    } catch (e) {
      r.paires[p.cle] = { ok: false, erreur: erreurEntiere(e) };
    }
  }
  log("VOLET B (hors ligne)\n" + JSON.stringify(r, null, 2));
  window.HORS_LIGNE = r;
  return r;
}

// Une paire par clic : chaque create() part avec une activation NEUVE.
async function unePaire(i) {
  const p = PAIRES[i];
  log("--- " + p.cle + " (clic propre) : create()...");
  const r = await creerEtTraduire(p);
  log(JSON.stringify(r, null, 2));
  window.PAIRE = window.PAIRE || {};
  window.PAIRE[p.cle] = r;
  window.DERNIERE_PAIRE = r;
  return r;
}
document.getElementById("btnP0").onclick = () => unePaire(0);
document.getElementById("btnP1").onclick = () => unePaire(1);
document.getElementById("btnP2").onclick = () => unePaire(2);
document.getElementById("btnSonde").onclick = () => sonde();
document.getElementById("btnTraduire").onclick = () => traduireTout();
document.getElementById("btnDetecteur").onclick = () => detecteur();
document.getElementById("btnGros").onclick = () => gros();
document.getElementById("btnVoletA1").onclick = () => voletA(0, "immediat", "es");
document.getElementById("btnVoletA2").onclick = () => voletA(10000, "apres10s", "nl");
document.getElementById("btnVoletA3").onclick = () => voletA(10000, "apres10s_dejaInstalle", "fr");
document.getElementById("btnJa").onclick = () => voletA(0, "premierTelechargement", "ja");
document.getElementById("btnHorsLigne").onclick = () => horsLigne();

log("page chargee. Translator dans self : " + ("Translator" in self)
  + " | LanguageDetector dans self : " + ("LanguageDetector" in self));
