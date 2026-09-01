// Sonde : de quoi dispose-t-on DANS LE DOCUMENT OFFSCREEN ?
// chrome.storage n'y existe pas (CLAUDE.md). chrome.i18n ? Translator ?
// Fichier de MESURE, il ne touche a rien.
(async () => {
  const r = {
    url: location.href,
    typeofChromeStorage: typeof (chrome && chrome.storage),
    typeofChromeI18n: typeof (chrome && chrome.i18n),
    typeofDetectLanguage: typeof (chrome && chrome.i18n && chrome.i18n.detectLanguage),
    translatorDansSelf: "Translator" in self,
  };
  const FR = "La mort de mes premieres etoiles, les trous noirs supermassifs se sont nourris pendant des milliards d'annees de matiere, de gaz, d'etoiles parfois, ou meme d'autres trou noirs.";
  const EN = "it possible to detect these mergers are very new, so we're currently discovering a lot of exciting things. Like two massive black holes that we detected in a galaxy 17 billion light years away.";
  try { r.detFr = await chrome.i18n.detectLanguage(FR); } catch (e) { r.detFr = String(e); }
  try { r.detEn = await chrome.i18n.detectLanguage(EN); } catch (e) { r.detEn = String(e); }
  chrome.runtime.sendMessage({ type: "SONDE_I18N", resultat: r });
})();
