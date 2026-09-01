// CANDIDAT A -- contexte A1 : le DOCUMENT OFFSCREEN.
//
// C'est le contexte de production de LiveSub, et sa particularite tient en une
// ligne : AUCUN CLIC N'Y ARRIVE JAMAIS. Il n'a pas d'interface, personne ne le
// regarde, navigator.userActivation n'y est jamais actif.
//
// ⚠️ Ce document ne touche PAS a chrome.storage : il est indisponible ici
// (CLAUDE.md). Tout remonte au service worker par message, prefixe [OFFSCREEN],
// parce que le document offscreen n'apparait pas comme cible DevTools dans une
// session pilotee.

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
  // Une paire NON installee : c'est elle qui dit si l'offscreen peut declencher
  // un telechargement, ce qu'aucun clic ne pourra jamais autoriser ici.
  { cle: "en->nl (non installe)", src: "en", dst: "nl", texte: SOURCE_EN },
];

async function mesurer() {
  const r = {
    contexte: "A1 document offscreen",
    url: location.href,
    isSecureContext,
    translatorDansSelf: "Translator" in self,
    languageDetectorDansSelf: "LanguageDetector" in self,
    typeofTranslatorCreate: typeof (self.Translator && self.Translator.create),
    // Personne n'a jamais clique ici, et personne ne le fera.
    activation: {
      isActive: navigator.userActivation ? navigator.userActivation.isActive : null,
      hasBeenActive: navigator.userActivation ? navigator.userActivation.hasBeenActive : null,
    },
    // chrome.storage : la verification qui a deja tout casse une fois.
    chromeStorage: typeof (chrome && chrome.storage),
    availability: {},
    create: {},
  };

  if (!r.translatorDansSelf) {
    return r;
  }

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

  for (const p of PAIRES) {
    const c = {};
    const t0 = performance.now();
    try {
      const tr = await self.Translator.create({ sourceLanguage: p.src, targetLanguage: p.dst });
      c.ok = true;
      c.msCreate = Math.round(performance.now() - t0);
      const t1 = performance.now();
      c.traduction = await tr.translate(p.texte);
      c.msTraduction = Math.round(performance.now() - t1);
      const t2 = performance.now();
      c.traduction2 = await tr.translate(p.texte);
      c.msTraduction2 = Math.round(performance.now() - t2);
      c.identiques = c.traduction2 === c.traduction;
      try { if (tr.destroy) tr.destroy(); } catch (_) {}
    } catch (e) {
      c.ok = false;
      c.msCreate = Math.round(performance.now() - t0);
      c.erreur = erreurEntiere(e);
    }
    r.create[p.cle] = c;
  }

  // Le detecteur de langue, dans ce contexte-la aussi.
  const d = { present: "LanguageDetector" in self };
  try {
    const det = await self.LanguageDetector.create();
    d.createOk = true;
    d.surTexteFr = await det.detect(SOURCE_FR);
    d.surTexteEn = await det.detect(SOURCE_EN);
    try { if (det.destroy) det.destroy(); } catch (_) {}
  } catch (e) {
    d.createOk = false;
    d.erreur = erreurEntiere(e);
  }
  r.languageDetector = d;

  return r;
}

mesurer()
  .then((r) => chrome.runtime.sendMessage({ type: "MESURE_A1", ok: true, resultat: r }))
  .catch((e) => chrome.runtime.sendMessage({ type: "MESURE_A1", ok: false, erreur: erreurEntiere(e) }));
