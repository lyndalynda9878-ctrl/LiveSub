# Bancs de mesure

Ces pages ne font **pas** partie de l'extension utilisée au quotidien. Ce sont les
instruments qui ont servi à **mesurer** avant de décider : vitesse du moteur,
nombre de fils, mémoire, qualité et coût de la traduction. Chaque chiffre du README
principal sort de l'une d'elles. Les relevés bruts sont dans [`../docs/mesures/`](../docs/mesures/).

Les pages `.html` s'ouvrent dans Chrome, extension chargée, à l'adresse
`chrome-extension://<ID de l'extension>/bancs/<page>.html`.

## Ce qu'il y a ici

| Page | Ce qu'elle mesure |
|---|---|
| `test-parakeet.html` | Parakeet sur le fil principal : texte, instant de chaque mot, vitesse. On choisit un `.wav`. |
| `test-parakeet-worker.html` | Le même moteur dans son Web Worker, comme en production. On choisit un `.wav`. |
| `test-fils.html?fils=N&passes=P` | Vitesse du moteur selon le nombre de fils WASM, dans une page d'extension. |
| `test-fils-offscreen.html?fils=N` | La même chose **dans le document offscreen**, là où tourne la production. Ne s'ouvre pas dans un onglet : elle est lancée depuis la console du service worker par `chrome.offscreen.createDocument({ url: "bancs/test-fils-offscreen.html?fils=4", reasons: ["USER_MEDIA"], justification: "mesure" })`. |
| `test-i18n-offscreen.html` | Ce qui est disponible dans un document offscreen (`chrome.storage`, `chrome.i18n`, `Translator`). Même mode de lancement. |
| `test-traduction-a1-offscreen.html`, `test-traduction-a3.html` | L'API Translator de Chrome dans l'offscreen et dans une page : disponibilité, téléchargement, vitesse. |
| `test-traduction-nllb.html` | Le candidat écarté pour la traduction, NLLB-200 (voir plus bas). |
| `test-traduction-source.html` | Produit le texte source des mesures de traduction (transcription réelle d'un `.wav`). |
| `test-progres.html` | Journal d'avancement d'une préparation, relevé toutes les 5 s. |
| `test-video.js`, `test-video-traduction.js` | Petits serveurs Node (`node bancs/test-video.js`, ports 8732 et 8733) qui servent une vraie page avec une balise `<video>` : l'extension ne peut pas agir sur ses propres pages. |
| `test-nllb-fetch.js` | Télécharge les poids de NLLB dans `bancs/test-nllb-model/` (870 Mo, ignoré par Git). |

### Quatre pages qui ne marchent plus

`test-whisper.html`, `test-bench.html`, `test-bruit.html` et `test-anticipation.html`
mesuraient l'ancien moteur, **Whisper**. Elles appellent `whisper.worker.js`, retiré
du dépôt le 30/08/2026 quand Parakeet l'a remplacé. Elles sont gardées parce que leurs
mesures sont citées dans `CLAUDE.md`. Pour les relancer, il faut restaurer ce fichier
depuis l'historique Git, au commit « Anticipation : Parakeet TDT 0.6B v3 remplace
whisper-tiny ».

## Les fichiers audio

Un seul fichier audio est fourni : `audio/speech.wav`, un extrait du discours de
J. F. Kennedy (domaine public). Les extraits d'émissions utilisés pour les mesures ne
sont pas publiés, pour une question de droits.

Pour utiliser vos propres fichiers, déposez-les dans `bancs/audio/` (ce dossier est
ignoré par Git, sauf `speech.wav`) :

| Page | Fichier attendu | Pour en changer |
|---|---|---|
| `test-parakeet.html`, `test-parakeet-worker.html` | n'importe quel `.wav` | bouton « Fichier » de la page |
| `test-fils.html` | `audio/extrait-fr-dur-75s.wav` | `?audio=bancs/audio/mon-fichier.wav` |
| `test-fils-offscreen.html` | `audio/extrait-fr-dur-75s.wav` | renommer votre fichier |
| `test-traduction-source.html` | `audio/extrait-fr-dur.wav` | `?wav=bancs/audio/mon-fichier.wav` |
| `test-video.js` | `audio/speech.wav` (fourni) | — |
| `test-video-traduction.js` | `audio/extrait-fr-dur.wav` et `audio/extrait-en.wav` | renommer vos fichiers |

Un `.wav` mono ou stéréo, de quelques dizaines de secondes de parole, suffit. Pour
les mesures de vitesse, prenez au moins 23 s : c'est la taille d'un bloc en
production (20 s de contenu + 3 s de contexte).

## Licence de NLLB

NLLB-200 (`facebook/nllb-200-distilled-600M`, export ONNX `Xenova/nllb-200-distilled-600M`),
de **Meta AI**, est sous licence **CC-BY-NC-4.0** : usage **non commercial**
uniquement. Il n'est utilisé **que** dans ces bancs, pour comparer, et n'est ni livré
ni chargé par l'extension, qui traduit avec l'API Translator de Chrome. Ce qui a
tranché, mesuré : 2 493 mots traduits en **2,1 s** par l'API contre **22 min 46 s** par
NLLB, et **0 octet** à livrer contre 870 Mo (voir
[`docs/mesures/traduction/RESULTATS.md`](../docs/mesures/traduction/RESULTATS.md)).
Texte de la licence :
<https://creativecommons.org/licenses/by-nc/4.0/>
