// ===========================================================================
// BANC — la memoire des preparations, sans Chrome
// ===========================================================================
//
// Charge content.js, background.js et offscreen.js TELS QUELS dans trois
// contextes `vm` distincts, avec un bus de messages et un chrome.storage.local
// qui a un vrai quota. Ce qui est mesure ici :
//
//   - qu'une preparation se range et se relit ;
//   - que les instants relus sont IDENTIQUES, mot a mot (contre-preuve B) ;
//   - que la mediane bloc -> ecran est la meme dans les deux cas (critere 3) ;
//   - la place occupee (critere 5) et l'eviction du plus ancien (point 4) ;
//   - que ?t=120 et &list=... ne changent pas la cle (critere 6) ;
//   - qu'une duree differente fait ignorer la memoire.
//
// ⚠️ CE QUE CE BANC NE PROUVE PAS. Le bouchon `chrome` est ecrit a la main : il
// ne prouve rien sur ce que Chrome rend reellement disponible (lecon payee, voir
// `offscreen-sans-chrome-storage`). Le bouchon de l'OFFSCREEN n'a donc NI
// `chrome.storage` NI `chrome.i18n`, comme dans la realite. Et les hauteurs de
// texte sont SIMULEES (un modele « caracteres par ligne ») : le vrai decoupage
// se mesure dans Chrome.

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const RACINE = process.argv[2] || ".";
const lire = (f) => fs.readFileSync(path.join(RACINE, f), "utf8");

// ---------------------------------------------------------------------------
// L'horloge virtuelle
// ---------------------------------------------------------------------------
let horlogeMs = 1_000_000;
const maintenant = () => horlogeMs;

// ---------------------------------------------------------------------------
// chrome.storage.local — AVEC un quota, comme le vrai
// ---------------------------------------------------------------------------
//
// La taille d'une entree est modelisee comme Chrome la documente : longueur de
// la cle + longueur de la valeur serialisee en JSON.
function creerStorageLocal(quota) {
  const donnees = new Map();
  const taille = (c, v) => c.length + JSON.stringify(v).length;
  const total = () => {
    let n = 0;
    for (const [c, v] of donnees) n += taille(c, v);
    return n;
  };
  return {
    QUOTA_BYTES: quota,
    async get(cles) {
      if (cles === null || cles === undefined) return Object.fromEntries(donnees);
      const liste = Array.isArray(cles) ? cles : [cles];
      const r = {};
      for (const c of liste) if (donnees.has(c)) r[c] = donnees.get(c);
      return r;
    },
    async set(objet) {
      // On simule l'atomicite de Chrome : soit tout passe, soit rien.
      const copie = new Map(donnees);
      for (const [c, v] of Object.entries(objet)) copie.set(c, JSON.parse(JSON.stringify(v)));
      let n = 0;
      for (const [c, v] of copie) n += taille(c, v);
      if (n > quota) {
        const e = new Error("QUOTA_BYTES quota exceeded");
        throw e;
      }
      for (const [c, v] of copie) donnees.set(c, v);
    },
    async remove(cles) {
      const liste = Array.isArray(cles) ? cles : [cles];
      for (const c of liste) donnees.delete(c);
    },
    async getBytesInUse(cles) {
      if (cles === null || cles === undefined) return total();
      const liste = Array.isArray(cles) ? cles : [cles];
      let n = 0;
      for (const c of liste) if (donnees.has(c)) n += taille(c, donnees.get(c));
      return n;
    },
    _donnees: donnees,
    _total: total,
  };
}

function creerStorageSession() {
  const d = new Map();
  return {
    async get(c) {
      const l = Array.isArray(c) ? c : [c];
      const r = {};
      for (const k of l) if (d.has(k)) r[k] = d.get(k);
      return r;
    },
    async set(o) {
      for (const [k, v] of Object.entries(o)) d.set(k, v);
    },
    async remove(c) {
      const l = Array.isArray(c) ? c : [c];
      for (const k of l) d.delete(k);
    },
    onChanged: { addListener() {} },
  };
}

// ---------------------------------------------------------------------------
// Le bus de messages
// ---------------------------------------------------------------------------
const ecouteurs = { background: [], offscreen: [], content: [] };

function distribuer(cibles, msg) {
  return new Promise((resolve, reject) => {
    let repondu = false;
    let asynchrone = false;
    const sendResponse = (r) => {
      if (repondu) return;
      repondu = true;
      resolve(r);
    };
    for (const groupe of cibles) {
      for (const l of ecouteurs[groupe]) {
        let res;
        try {
          res = l(msg, {}, sendResponse);
        } catch (e) {
          console.error(`[banc] un ecouteur de ${groupe} a leve sur ${msg.type} :`, e);
        }
        if (res === true) asynchrone = true;
        if (repondu) return;
      }
    }
    if (!asynchrone) {
      // Personne ne repondra : c'est exactement ce que Chrome fait.
      reject(new Error("Could not establish connection. Receiving end does not exist."));
    } else {
      setTimeout(() => {
        if (!repondu) reject(new Error("[banc] personne n'a repondu a " + msg.type));
      }, 10000).unref();
    }
  });
}

// ---------------------------------------------------------------------------
// La page : une <video> et un DOM juste assez reel
// ---------------------------------------------------------------------------
//
// ⚠️ LES HAUTEURS SONT SIMULEES. `scrollHeight` vaut « nombre de lignes x
// hauteur de ligne », avec un nombre de caracteres par ligne fixe. C'est
// deterministe -- donc bon pour comparer deux passages entre eux -- mais ce
// n'est PAS la mesure de Chrome.
const CARACTERES_PAR_LIGNE = 66;
const HAUTEUR_LIGNE_PX = 33;

function creerElement(nom) {
  const el = {
    tagName: (nom || "div").toUpperCase(),
    style: new Proxy({}, { get: (t, k) => t[k] ?? "", set: (t, k, v) => ((t[k] = v), true) }),
    children: [],
    _texte: "",
    isConnected: true,
    get textContent() {
      return this._texte;
    },
    set textContent(v) {
      this._texte = String(v == null ? "" : v);
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    remove() {},
    getBoundingClientRect() {
      return { width: 800, height: 118, top: 0, left: 0 };
    },
    get scrollHeight() {
      const n = Math.max(1, Math.ceil(this._texte.length / CARACTERES_PAR_LIGNE));
      return n * HAUTEUR_LIGNE_PX;
    },
    get clientHeight() {
      const h = parseInt(String(this.style.height), 10);
      return Number.isFinite(h) ? h : 2 * HAUTEUR_LIGNE_PX;
    },
  };
  return el;
}

const video = {
  tagName: "VIDEO",
  currentTime: 0,
  duration: 0,
  playbackRate: 1,
  paused: true,
  volume: 1,
  muted: false,
  isConnected: true,
  play() {
    this.paused = false;
    return Promise.resolve();
  },
  pause() {
    this.paused = true;
  },
  addEventListener() {},
  removeEventListener() {},
  getBoundingClientRect() {
    return { width: 1280, height: 720, top: 0, left: 0 };
  },
};

let adresse = "https://www.youtube.com/watch?v=aBcDeF12345";
let titre = "Une video de demonstration — LiveSub";

function creerDocument() {
  const body = creerElement("body");
  return {
    get title() {
      return titre;
    },
    body,
    documentElement: creerElement("html"),
    createElement: creerElement,
    querySelectorAll(sel) {
      return sel === "video" ? [video] : [];
    },
    querySelector(sel) {
      return sel === "video" ? video : null;
    },
    addEventListener() {},
    getElementById() {
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Les trois contextes
// ---------------------------------------------------------------------------
const storageLocal = creerStorageLocal(10485760);
const storageSession = creerStorageSession();

function chromeCommun(origine) {
  return {
    runtime: {
      id: "banc",
      getURL: (p) => "chrome-extension://banc/" + p,
      onMessage: {
        addListener: (l) => ecouteurs[origine].push(l),
      },
      sendMessage: (msg) => {
        // content -> l'extension (background + offscreen) ;
        // background <-> offscreen.
        if (origine === "content") return distribuer(["background", "offscreen"], msg);
        if (origine === "background") return distribuer(["offscreen"], msg);
        return distribuer(["background"], msg);
      },
      lastError: null,
    },
  };
}

function contexteDeBase(origine, avecDom) {
  const c = chromeCommun(origine);
  const g = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    performance: { now: maintenant },
    Date: new Proxy(Date, { get: (t, k) => (k === "now" ? maintenant : t[k]) }),
    chrome: c,
    URL,
    JSON,
    Math,
    Promise,
    Array,
    Object,
    Number,
    String,
    Boolean,
    Map,
    Set,
    Error,
    TypeError,
    RangeError,
    Float32Array,
    Uint8Array,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
  };
  if (avecDom) {
    g.document = creerDocument();
    g.location = { get href() { return adresse; } };
    g.window = g;
    g.getComputedStyle = () => ({ getPropertyValue: () => "" });
    g.MutationObserver = class { observe() {} disconnect() {} };
  }
  g.self = g;
  g.globalThis = g;
  return vm.createContext(g);
}

// --- background -------------------------------------------------------------
const ctxBg = contexteDeBase("background", false);
ctxBg.chrome.storage = { local: storageLocal, session: storageSession };
ctxBg.chrome.offscreen = {
  hasDocument: async () => true,
  createDocument: async () => {},
};
ctxBg.chrome.tabs = {
  query: async () => [{ id: 7, title: titre, url: adresse }],
  sendMessage: async (tabId, msg) => distribuer(["content"], msg),
  onRemoved: { addListener() {} },
};
ctxBg.chrome.tabCapture = { getMediaStreamId: async () => "faux" };
ctxBg.chrome.i18n = { detectLanguage: async () => ({ languages: [{ language: "fr", percentage: 99 }], isReliable: true }) };
ctxBg.chrome.runtime.onInstalled = { addListener() {} };
vm.runInContext(lire("background.js"), ctxBg, { filename: "background.js" });

// --- offscreen --------------------------------------------------------------
// ⚠️ PAS de chrome.storage, PAS de chrome.i18n : comme dans le vrai document
// offscreen. Un bouchon confortable rendrait vert du code que Chrome refuse.
const ctxOff = contexteDeBase("offscreen", false);
ctxOff.chrome.runtime.getURL = (p) => "chrome-extension://banc/" + p;
ctxOff.navigator = { mediaDevices: {}, userActivation: { isActive: false } };
ctxOff.AudioContext = class {};
ctxOff.Worker = class { constructor() {} postMessage() {} terminate() {} };
ctxOff.WebAssembly = { Memory: class {} };
ctxOff.fetch = async () => ({ ok: true, body: null });
// L'API Translator, bouchonnee : elle met un prefixe, ce qui suffit a verifier
// que le texte traduit voyage bien jusqu'a l'ecran et jusqu'au storage.
let tradAppels = 0;
ctxOff.Translator = {
  async create({ sourceLanguage, targetLanguage }) {
    return {
      async translate(t) {
        tradAppels++;
        return `[${targetLanguage}] ` + t;
      },
      destroy() {},
    };
  },
};
vm.runInContext(lire("offscreen.js"), ctxOff, { filename: "offscreen.js" });

// --- content ----------------------------------------------------------------
const ctxCt = contexteDeBase("content", true);
vm.runInContext(lire("content.js"), ctxCt, { filename: "content.js" });

// ---------------------------------------------------------------------------
// Le stock de test : des mots avec des instants, et rien d'invente
// ---------------------------------------------------------------------------
const PHRASE = (
  "Le vent se leve sur la plaine et les premieres etoiles apparaissent " +
  "au-dessus des collines. Personne ne parle. On entend seulement le bruit " +
  "de l'eau qui coule entre les pierres, et parfois un oiseau qui s'envole. " +
  "Demain il faudra repartir vers le nord, avant que la neige ne ferme les " +
  "cols. C'est ainsi depuis toujours, et ce sera ainsi longtemps encore."
).split(/\s+/);

function fabriquerMots(nb, depart) {
  const mots = [];
  let t = depart;
  for (let i = 0; i < nb; i++) {
    mots.push({
      // Des instants a plusieurs decimales, expres : c'est la ou un arrondi se
      // verrait.
      mot: PHRASE[i % PHRASE.length],
      instant: Math.round(t * 1000) / 1000,
    });
    // Un rythme irregulier, avec de vraies respirations.
    t += 0.31 + ((i * 7919) % 97) / 1000;
    if (i % 23 === 22) t += 1.4;
  }
  return mots;
}

// ---------------------------------------------------------------------------
// Injecter un stock dans l'offscreen, comme si la preparation venait de finir
// ---------------------------------------------------------------------------
function poserStockOffscreen(mots, depart, duree, traduction) {
  const N = 48000 * (duree / 2); // duree de contenu a x2
  ctxOff.__mots = mots;
  ctxOff.__trad = traduction;
  vm.runInContext(
    `
    prepMots = __mots;
    prepSegments = [];
    prepTraduction = __trad || null;
    prepPositionDepart = ${depart};
    prepDepartConfirme = true;
    prepTauxCapture = 48000;
    prepConsommes = ${N};
    prepAncres = [{ echantillons: 0, position: ${depart} }, { echantillons: ${N}, position: ${depart + duree} }];
    if (prepTraduction) { prepSegments = prepDecouperEnPhrases(prepMots).map(s => ({...s, texteTraduit: "[" + prepTraduction.cible + "] " + s.texteOrigine})); }
    `,
    ctxOff
  );
  return vm.runInContext("({ nbMots: prepMots.length, nbSegments: prepSegments.length })", ctxOff);
}

// ---------------------------------------------------------------------------
// Jouer la video et mesurer, exactement comme content.js le fait a l'ecran
// ---------------------------------------------------------------------------
function jouer(deS, aS, pasMs) {
  video.currentTime = deS;
  video.paused = false;
  video.playbackRate = 1;
  // Un premier battement pour poser le point de depart de la mesure de
  // continuite (sinon le tout premier bloc n'est jamais compte comme continu).
  vm.runInContext("prepLectBattre()", ctxCt);
  while (video.currentTime < aS) {
    horlogeMs += pasMs;
    video.currentTime = Math.round((video.currentTime + pasMs / 1000) * 1000) / 1000;
    vm.runInContext("prepLectBattre()", ctxCt);
  }
}

function mesures() {
  return vm.runInContext(
    `(function(){ let r=null; const l = { type: "PREPARATION_MESURES" };
       chrome.runtime.onMessage; return { ecartBlocs: prepStats(prepBlocEcarts), dureeBlocs: prepStats(prepBlocDurees),
         nbBlocs: prepLectBlocs.length, nbMots: prepLectStock.length, debordements: prepBlocDebordements,
         etat: prepLectEtatAffiche, vientDeLaMemoire: prepLectVientDeLaMemoire }; })()`,
    ctxCt
  );
}

const empreinte = () =>
  vm.runInContext(
    `({ mots: prepLectStock, blocs: prepLectBlocs, zone: prepLectZone, traduction: prepLectTraduction,
        nbSegments: prepLectSegments.length, vientDeLaMemoire: prepLectVientDeLaMemoire })`,
    ctxCt
  );

// ===========================================================================
// LE SCENARIO
// ===========================================================================
const resultats = {};
const dire = (...a) => console.log(...a);

(async () => {
  const NB_MOTS = 1400; // ~8 minutes de parole
  const DEPART = 0;
  const mots = fabriquerMots(NB_MOTS, DEPART);
  const DUREE_PAROLE = mots[mots.length - 1].instant;
  const DUREE_VIDEO = Math.round((DUREE_PAROLE + 6) * 1000) / 1000;
  video.duration = DUREE_VIDEO;

  dire("=".repeat(74));
  dire(`STOCK DE TEST : ${NB_MOTS} mots, ${DUREE_PAROLE.toFixed(1)} s de parole, video ${DUREE_VIDEO.toFixed(1)} s`);
  dire("=".repeat(74));

  // -------------------------------------------------------------------------
  // 1re PREPARATION (sans traduction)
  // -------------------------------------------------------------------------
  poserStockOffscreen(mots, DEPART, DUREE_VIDEO, null);
  await vm.runInContext(
    `prepLectCharger({ nbMots: ${NB_MOTS}, dureeCouverteS: ${DUREE_VIDEO} })`,
    ctxCt
  );
  await new Promise((r) => setTimeout(r, 30)); // laisser memEnregistrer finir

  const emp1 = empreinte();
  dire(`\n1re preparation : ${emp1.mots.length} mots, ${emp1.blocs.length} blocs, zone ${JSON.stringify(emp1.zone)}`);

  jouer(0, Math.min(DUREE_PAROLE, 240), 20);
  const mes1 = mesures();
  dire(`   mediane bloc -> ecran : ${mes1.ecartBlocs.medianeMs} ms (n=${mes1.ecartBlocs.n}, min ${mes1.ecartBlocs.minMs}, max ${mes1.ecartBlocs.maxMs})`);
  resultats.premiere = { emp: emp1, mes: mes1 };

  const octets1 = await storageLocal.getBytesInUse("prep:yt:aBcDeF12345");
  const total1 = await storageLocal.getBytesInUse(null);
  dire(`   place : entree ${(octets1 / 1024).toFixed(1)} Ko, storage total ${(total1 / 1024).toFixed(1)} Ko`);
  resultats.octets1 = octets1;

  // -------------------------------------------------------------------------
  // « Je ferme l'onglet, je rouvre » : un content.js TOUT NEUF
  // -------------------------------------------------------------------------
  dire("\n--- fermeture de l'onglet : on repart d'un content.js neuf ---");
  ecouteurs.content.length = 0;
  const ctx2 = contexteDeBase("content", true);
  vm.runInContext(lire("content.js"), ctx2, { filename: "content.js" });
  // L'URL change comme dans la vraie vie : on rouvre avec un &t= et une playlist.
  adresse = "https://www.youtube.com/watch?v=aBcDeF12345&t=120s&list=PLxxxxxxxx&pp=ygUJdGVzdA%3D%3D";
  video.currentTime = 0;

  const t0 = Date.now();
  const r2 = await ctxBg.chrome.runtime.sendMessage
    ? await distribuer(["background"], { type: "MEMOIRE_AFFICHER", traduction: null })
    : null;
  const msAffichage = Date.now() - t0;
  dire(`MEMOIRE_AFFICHER -> ${JSON.stringify(r2)}`);
  resultats.affichage = r2;

  const emp2 = vm.runInContext(
    `({ mots: prepLectStock, blocs: prepLectBlocs, zone: prepLectZone, traduction: prepLectTraduction,
        nbSegments: prepLectSegments.length, vientDeLaMemoire: prepLectVientDeLaMemoire })`,
    ctx2
  );
  dire(`2e ouverture : ${emp2.mots.length} mots, ${emp2.blocs.length} blocs, vient de la memoire = ${JSON.stringify(emp2.vientDeLaMemoire)}`);

  // ---- CONTRE-PREUVE B : les instants, mot a mot -------------------------
  let ecartMax = 0;
  let differents = 0;
  let motsDifferents = 0;
  const n = Math.max(emp1.mots.length, emp2.mots.length);
  for (let i = 0; i < n; i++) {
    const a = emp1.mots[i];
    const b = emp2.mots[i];
    if (!a || !b) {
      differents++;
      continue;
    }
    if (a.mot !== b.mot) motsDifferents++;
    const d = Math.abs(a.instant - b.instant);
    if (d > ecartMax) ecartMax = d;
    if (d !== 0) differents++;
  }
  dire(`\n⭐ CONTRE-PREUVE B — instants : ${emp1.mots.length} mots avant, ${emp2.mots.length} apres ; ` +
    `${differents} instant(s) different(s), ecart max ${ecartMax} s ; ${motsDifferents} mot(s) different(s)`);
  resultats.contrepreuveB = { avant: emp1.mots.length, apres: emp2.mots.length, differents, ecartMax, motsDifferents };

  // Les blocs aussi.
  let blocsDifferents = 0;
  for (let i = 0; i < Math.max(emp1.blocs.length, emp2.blocs.length); i++) {
    const a = emp1.blocs[i], b = emp2.blocs[i];
    if (!a || !b) { blocsDifferents++; continue; }
    for (const cle of ["instant", "fin", "finParole", "disparition", "nbMots", "texte"]) {
      if (a[cle] !== b[cle]) { blocsDifferents++; break; }
    }
  }
  dire(`   blocs : ${emp1.blocs.length} avant, ${emp2.blocs.length} apres, ${blocsDifferents} different(s)`);
  resultats.contrepreuveB.blocsDifferents = blocsDifferents;

  // ---- CRITERE 3 : la meme mediane ----------------------------------------
  // On rejoue exactement le meme passage, sur la meme horloge virtuelle.
  const ctxCtSauve = ctxCt;
  jouerDans(ctx2, 0, Math.min(DUREE_PAROLE, 240), 20);
  const mes2 = vm.runInContext(
    `({ ecartBlocs: prepStats(prepBlocEcarts), dureeBlocs: prepStats(prepBlocDurees), debordements: prepBlocDebordements })`,
    ctx2
  );
  dire(`\n⭐ CRITERE 3 — mediane bloc -> ecran :`);
  dire(`   1re preparation : ${mes1.ecartBlocs.medianeMs} ms (n=${mes1.ecartBlocs.n}, max ${mes1.ecartBlocs.maxMs})`);
  dire(`   depuis memoire  : ${mes2.ecartBlocs.medianeMs} ms (n=${mes2.ecartBlocs.n}, max ${mes2.ecartBlocs.maxMs})`);
  resultats.critere3 = { premiere: mes1.ecartBlocs, memoire: mes2.ecartBlocs };

  // -------------------------------------------------------------------------
  // CRITERE 4 : changer de langue d'arrivee -> il traduit seulement
  // -------------------------------------------------------------------------
  dire("\n--- critere 4 : nouvelle langue d'arrivee sur une video en memoire ---");
  const avantTrad = vm.runInContext("({ workerVivant: prepWorker !== null, nbMots: prepMots.length })", ctxOff);
  const t1 = Date.now();
  const r3 = await distribuer(["background"], {
    type: "MEMOIRE_AFFICHER",
    traduction: { source: "fr", cible: "en" },
  });
  const msTrad = Date.now() - t1;
  dire(`MEMOIRE_AFFICHER (fr->en) -> ${JSON.stringify(r3)}`);
  dire(`   temps total banc : ${msTrad} ms — worker Parakeet avant : ${avantTrad.workerVivant}, apres : ` +
    vm.runInContext("(prepWorker !== null)", ctxOff));
  const emp3 = vm.runInContext(
    `({ nbBlocs: prepLectBlocs.length, traduction: prepLectTraduction, premierBloc: prepLectBlocs[0], nbSegments: prepLectSegments.length })`,
    ctx2
  );
  dire(`   affichage : ${emp3.nbBlocs} blocs, traduction ${JSON.stringify(emp3.traduction)}`);
  dire(`   premier bloc : ${JSON.stringify(emp3.premierBloc)}`);
  resultats.critere4 = { reponse: r3, ms: msTrad, emp: emp3, tradAppels };

  // La transcription n'a pas bouge d'un octet ?
  const brut = await storageLocal.get("prep:yt:aBcDeF12345");
  const entree = brut["prep:yt:aBcDeF12345"];
  dire(`   entree rangee : ${entree.mots.length} mots, blocs ${entree.blocs.length}, ` +
    `traductions [${Object.keys(entree.traductions).join(", ")}]`);
  let motsIntacts = entree.mots.length === mots.length;
  for (let i = 0; motsIntacts && i < mots.length; i++) {
    if (entree.mots[i].mot !== mots[i].mot || entree.mots[i].instant !== mots[i].instant) motsIntacts = false;
  }
  dire(`   ⭐ transcription intacte apres retraduction : ${motsIntacts}`);
  resultats.critere4.motsIntacts = motsIntacts;

  const octets2 = await storageLocal.getBytesInUse("prep:yt:aBcDeF12345");
  dire(`   place apres la traduction anglaise : ${(octets2 / 1024).toFixed(1)} Ko ` +
    `(+${((octets2 - octets1) / 1024).toFixed(1)} Ko)`);
  resultats.octets2 = octets2;

  // ---- la MEME langue une 2e fois : les blocs doivent etre REPRIS ---------
  const blocsEn1 = vm.runInContext("prepLectBlocs.map(b=>({i:b.instant,f:b.fin,d:b.disparition,n:b.nbMots,t:b.texte,tt:b.texteTraduit}))", ctx2);
  const r4 = await distribuer(["background"], { type: "MEMOIRE_AFFICHER", traduction: { source: "fr", cible: "en" } });
  dire(`   2e fois en anglais -> blocsRepris = ${r4.blocsRepris}, traductionNeuve = ${r4.traductionNeuve}, ${r4.nbBlocs} blocs`);
  const blocsEn2 = vm.runInContext("prepLectBlocs.map(b=>({i:b.instant,f:b.fin,d:b.disparition,n:b.nbMots,t:b.texte,tt:b.texteTraduit}))", ctx2);
  const memesBlocsEn = JSON.stringify(blocsEn1) === JSON.stringify(blocsEn2);
  dire(`   ⭐ blocs traduits identiques d une fois sur l autre : ${memesBlocsEn}`);
  resultats.memeLangue2eFois = { blocsRepris: r4.blocsRepris, traductionNeuve: r4.traductionNeuve, memesBlocsEn };

  // ---- une SECONDE langue : la premiere ne doit pas bouger ----------------
  const appelsAvant = tradAppels;
  const r5 = await distribuer(["background"], { type: "MEMOIRE_AFFICHER", traduction: { source: "fr", cible: "es" } });
  const brut2 = await storageLocal.get("prep:yt:aBcDeF12345");
  const e2 = brut2["prep:yt:aBcDeF12345"];
  dire(`   espagnol ajoute -> langues en memoire [${Object.keys(e2.traductions).join(", ")}], ` +
    `${tradAppels - appelsAvant} appels au traducteur, mots toujours ${e2.mots.length}`);
  dire(`   la traduction anglaise a-t-elle survecu ? ${e2.traductions.en.segments.length} segments en, ${e2.traductions.en.blocs.length} blocs en`);
  resultats.deuxiemeLangue = { langues: Object.keys(e2.traductions), nbMots: e2.mots.length, en: e2.traductions.en.segments.length };

  // ---- retour a « Langue d origine » --------------------------------------
  const r6 = await distribuer(["background"], { type: "MEMOIRE_AFFICHER", traduction: null });
  dire(`   retour a la langue d origine -> ${r6.nbBlocs} blocs, blocsRepris = ${r6.blocsRepris}, traduction = ` +
    JSON.stringify(vm.runInContext("prepLectTraduction", ctx2)));
  resultats.retourOrigine = { nbBlocs: r6.nbBlocs, blocsRepris: r6.blocsRepris };

  // -------------------------------------------------------------------------
  // CRITERE 6 : ?t= et &list= ne changent pas la cle ; une autre duree, si
  // -------------------------------------------------------------------------
  dire("\n--- critere 6 : la cle video ---");
  const adresses = [
    "https://www.youtube.com/watch?v=aBcDeF12345",
    "https://www.youtube.com/watch?v=aBcDeF12345&t=120s",
    "https://www.youtube.com/watch?v=aBcDeF12345&list=PLabc&index=3",
    "https://m.youtube.com/watch?v=aBcDeF12345&t=42",
    "https://youtu.be/aBcDeF12345?t=120",
    "https://www.youtube.com/shorts/aBcDeF12345",
    "https://www.youtube.com/watch?v=AUTREVIDEO1",
    "https://exemple.fr/cours/lecon-3?autoplay=1#t=10",
    "https://exemple.fr/cours/lecon-3",
    "https://exemple.fr/cours/lecon-4",
  ];
  const cles = [];
  for (const a of adresses) {
    adresse = a;
    const id = vm.runInContext("memCleVideo()", ctx2);
    cles.push([a, id]);
    dire(`   ${id.padEnd(20)}  <-  ${a}`);
  }
  resultats.cles = cles;

  // Meme cle, duree differente -> la memoire doit etre ignoree.
  adresse = "https://www.youtube.com/watch?v=aBcDeF12345&t=99";
  video.duration = DUREE_VIDEO + 45;
  const etatFausseDuree = await distribuer(["background"], { type: "MEMOIRE_ETAT" });
  dire(`\n   duree ${DUREE_VIDEO.toFixed(1)} s en memoire, ${(DUREE_VIDEO + 45).toFixed(1)} s sur la page ` +
    `-> connue = ${etatFausseDuree.connue} (${etatFausseDuree.raison || ""})`);
  const afficheFausseDuree = await distribuer(["background"], { type: "MEMOIRE_AFFICHER", traduction: null });
  dire(`   MEMOIRE_AFFICHER -> ok = ${afficheFausseDuree.ok} : ${afficheFausseDuree.erreur || ""}`);
  resultats.dureeDifferente = { etat: etatFausseDuree, affichage: afficheFausseDuree };

  // Une tolerance de 1 s doit, elle, passer.
  video.duration = DUREE_VIDEO + 0.4;
  const etatTolerance = await distribuer(["background"], { type: "MEMOIRE_ETAT" });
  dire(`   duree a +0,4 s -> connue = ${etatTolerance.connue}`);
  resultats.tolerance = etatTolerance.connue;
  video.duration = DUREE_VIDEO;
  adresse = "https://www.youtube.com/watch?v=aBcDeF12345";

  // -------------------------------------------------------------------------
  // CRITERE 5 : combien de videos tiennent dans 10 Mo, et l'eviction
  // -------------------------------------------------------------------------
  dire("\n--- critere 5 : la place, et ce qui se passe quand elle manque ---");
  const parVideo = await storageLocal.getBytesInUse("prep:yt:aBcDeF12345");
  dire(`   une video de ~8 min (transcription + 1 traduction) : ${(parVideo / 1024).toFixed(1)} Ko`);
  dire(`   -> ${Math.floor(10485760 / parVideo)} videos de cette taille dans 10 Mo`);
  resultats.critere5 = { octetsParVideo: parVideo, combien: Math.floor(10485760 / parVideo) };

  // On remplit jusqu'a l'eviction.
  dire("\n   remplissage jusqu'a saturation...");
  let posees = 0;
  let evictions = 0;
  const journalEviction = [];
  for (let k = 0; k < 200; k++) {
    horlogeMs += 60000;
    adresse = `https://www.youtube.com/watch?v=REMPLISSAGE${String(k).padStart(3, "0")}`;
    titre = `Video de remplissage ${k}`;
    video.duration = DUREE_VIDEO;
    // On repose un stock neuf et on passe par le VRAI chemin d'enregistrement.
    ecouteurs.content.length = 0;
    const ctxK = contexteDeBase("content", true);
    vm.runInContext(lire("content.js"), ctxK, { filename: "content.js" });
    poserStockOffscreen(mots, DEPART, DUREE_VIDEO, null);
    await vm.runInContext(`prepLectCharger({ nbMots: ${NB_MOTS}, dureeCouverteS: ${DUREE_VIDEO} })`, ctxK);
    await new Promise((r) => setTimeout(r, 5));
    posees++;
    const inv = await distribuer(["background"], { type: "MEMOIRE_PLACE" });
    if (inv.nbPreparations < posees + 1) {
      evictions = posees + 1 - inv.nbPreparations;
      journalEviction.push({ posees, enMemoire: inv.nbPreparations, octets: inv.place.octets, pourcent: inv.place.pourcent });
      if (evictions >= 2) break;
    }
  }
  const invFinal = await distribuer(["background"], { type: "MEMOIRE_PLACE" });
  dire(`   ${posees} preparations posees, ${invFinal.nbPreparations} en memoire, ` +
    `${(invFinal.place.octets / 1024).toFixed(0)} Ko / ${(invFinal.place.quota / 1024).toFixed(0)} Ko (${invFinal.place.pourcent} %)`);
  dire(`   journal des evictions : ${JSON.stringify(journalEviction)}`);
  // La plus ancienne est-elle bien celle qui est partie ?
  const restantes = invFinal.inventaire.map((e) => e.cle);
  dire(`   la toute premiere video (yt:aBcDeF12345) est-elle encore la ? ${restantes.includes("yt:aBcDeF12345")}`);
  dire(`   la plus ancienne restante : ${invFinal.inventaire[invFinal.inventaire.length - 1].cle}`);
  resultats.eviction = { posees, enMemoire: invFinal.nbPreparations, place: invFinal.place, journalEviction, premiereEncoreLa: restantes.includes("yt:aBcDeF12345") };

  dire("\n" + "=".repeat(74));
  fs.writeFileSync(
    path.join(process.argv[3] || ".", "banc-memoire-resultats.json"),
    JSON.stringify(resultats, (k, v) => (k === "emp" || k === "mots" || k === "blocs" ? undefined : v), 2)
  );
  dire("Resultats detailles : banc-memoire-resultats.json");
})().catch((e) => {
  console.error("BANC EN ECHEC :", e);
  process.exit(1);
});

// Jouer dans un contexte donne.
function jouerDans(ctx, deS, aS, pasMs) {
  video.currentTime = deS;
  video.paused = false;
  video.playbackRate = 1;
  vm.runInContext("prepLectBattre()", ctx);
  while (video.currentTime < aS) {
    horlogeMs += pasMs;
    video.currentTime = Math.round((video.currentTime + pasMs / 1000) * 1000) / 1000;
    vm.runInContext("prepLectBattre()", ctx);
  }
}
