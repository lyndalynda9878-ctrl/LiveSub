---
name: tester-extension
description: >
  Tester l'extension LiveSub dans Chrome après une modification : recharger
  l'extension, ouvrir la bonne console (service worker ou offscreen), et vérifier les
  logs attendus. À utiliser à chaque test ou validation d'une modif de l'extension.
---

# Tester l'extension LiveSub

## Étapes
1. **Recharger l'extension** : `chrome://extensions` → bouton 🔄 sur la carte LiveSub.
   Indispensable après TOUTE modif de fichier (sinon Chrome garde l'ancienne version).
2. **Recharger la page** (F5) si un onglet était déjà ouvert : le content script n'est
   injecté qu'au chargement de la page.
3. **Ouvrir la bonne console** selon ce qu'on teste :
   - Logs du **service worker** (`background.js`) : `chrome://extensions` → LiveSub →
     « Inspecter les vues → service worker ».
   - Logs du **VAD / capture audio** (`offscreen.js`) : « Inspecter les vues →
     **offscreen.html** ». ⚠️ Console séparée, PAS celle de la page. Le lien n'apparaît
     que quand l'offscreen existe → démarrer la capture d'abord.
   - Test **Whisper isolé** : ouvrir `chrome-extension://<ID>/bancs/test-whisper.html`
     (l'ID est sur la carte de l'extension). Le résultat s'affiche sur la page ET dans
     la console (F12).

## Avec le serveur MCP chrome-devtools
S'il est disponible, l'utiliser pour charger l'extension, déclencher l'action, lire la
console et prendre des captures automatiquement (au lieu du copier-coller manuel).
Pour la capture d'onglet, utiliser `trigger_extension_action` : cliquer l'icône
accorde la permission `activeTab` ; ouvrir `popup.html` comme un onglet ne l'accorde
pas.

## Pièges fréquents
- Oublier de recharger l'extension → on teste l'ancienne version.
- Regarder la console de la page au lieu de celle de l'**offscreen** → on ne voit pas
  les logs du VAD.
- « Extension has not been invoked for the current page » → l'action n'a pas été
  déclenchée via l'icône (permission `activeTab`).

## Logs de succès attendus
- VAD : `✅ VAD demarre !`, `🗣️ PAROLE DETECTEE`, `🔇 PAROLE TERMINEE`.
- Whisper (test) : `✅ Modele charge...` puis `📝 TEXTE TRANSCRIT ...`.
