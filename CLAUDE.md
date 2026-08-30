# LiveSub — Mémoire du projet

> ## ⚠️ LIRE CECI D'ABORD — mise à jour du 2026-08-30 : CHANGEMENT DE MOTEUR
>
> **whisper-tiny a été remplacé par NVIDIA Parakeet TDT 0.6B v3, et le mode direct a
> été supprimé.** Beaucoup de paragraphes ci-dessous décrivent Whisper ou le direct.
> Ils sont **datés, pas effacés** : ce sont des leçons payées, chiffrées, et plusieurs
> valent encore.
>
> **Comment les lire.** Un bloc qui s'ouvre sur
> `⏳ VRAI JUSQU'AU 30/08/2026, PLUS D'ACTUALITÉ` décrit l'état d'avant. Son texte
> d'origine est **intact**, et une flèche `→ Ce qui a changé` dit ce qui le remplace.
>
> ⛔ **AUCUNE RÈGLE tirée d'un bloc daté ne doit être appliquée aujourd'hui.** Les
> mesures, elles, restent valables pour ce qu'elles mesuraient.

## Vue d'ensemble
LiveSub est une **extension de navigateur (Chrome, Manifest V3)** qui capte le son de
l'onglet, le transcrit (**Parakeet TDT 0.6B v3**, 100 % local) et affiche des
sous-titres en overlay sur la page. La traduction reste à faire.

Il n'y a **qu'un seul mode** : « préparer d'abord ». La vidéo défile en accéléré et en
silence, tout est transcrit d'avance, puis le texte s'affiche à l'heure pendant la
lecture normale. Le mode direct a existé, a prouvé ce qu'il avait à prouver, et a été
retiré — voir « Le mode direct » plus bas.

**Contrainte fondamentale : tout tourne 100 % en local, hors ligne, aucun envoi vers
un serveur tiers.** C'est l'argument central du projet.

## Règles à respecter (non négociables)
- **100 % local / hors ligne** : aucune API distante pour la transcription ou la
  traduction. Le son ne quitte jamais la machine.
- **Aucun CDN** : toute librairie est copiée dans `vendor/` et chargée localement
  (voir la skill `extension-vendor-lib`).
- Chrome uniquement (MV3) ; audio d'un **onglet** (pas le système entier, pour la V1).
- **Une tâche à la fois** : implémenter → tester → valider → committer. Expliquer les
  changements en français simple.

## Architecture (le flux)

**Aujourd'hui — mode « préparer d'abord », le seul :**

`content.js` met la vidéo à ×2 en silence → onglet (son) → `background.js`
(`getMediaStreamId`) → `offscreen.js` (getUserMedia sur l'onglet) →
`preparation.worklet.js` empile le son par blocs de 20 s → `parakeet.worker.js` les
transcrit un par un (Web Worker, CPU) → les mots **avec leur instant** s'empilent dans
le stock de `offscreen.js` → à la fin, `background.js` rend le lecteur et livre le
stock → `content.js` affiche chaque bloc quand `video.currentTime` atteint son heure.

⏳ **VRAI JUSQU'AU 30/08/2026, PLUS D'ACTUALITÉ — l'architecture du mode direct.**

> onglet (son) → `background.js` (`getMediaStreamId`) → `offscreen.js` (getUserMedia sur
> l'onglet) → **VAD** alimente une **fenêtre de parole** (voir « Le flux » plus bas) →
> `whisper.worker.js` la re-transcrit en boucle (Web Worker, GPU ou CPU selon la mesure) →
> `background.js` relaie le message `FLUX` — `ruban` (stable) + `provisoire` — parce que
> l'offscreen n'a pas accès à `chrome.tabs` → `content.js` révèle les mots un par un.

→ **Ce qui a changé** : le mode direct est supprimé, donc le VAD, la fenêtre glissante,
le message `FLUX` et le couple ruban/provisoire avec lui. `whisper.worker.js` est
supprimé du dépôt. **Pourquoi** : le direct ne pouvait pas tenir les trois côtés du
triangle impossible (voir « Les instants ») ; la préparation, elle, connaît l'heure de
chaque mot avant que la lecture commence, donc elle n'a plus rien à estimer.

## Fichiers
- `manifest.json` — MV3 ; permissions (storage, tabCapture, activeTab, offscreen) ;
  CSP avec `wasm-unsafe-eval`.
- `background.js` — service worker : orchestre la capture, gère l'offscreen, stocke
  l'état dans `chrome.storage.session`. ⚠️ Le SW est tué régulièrement → ne jamais
  stocker l'état dans une simple variable mémoire.
- `popup.html` / `popup.js` — bouton Démarrer/Arrêter ; demande l'état au background
  (`GET_STATE`), ne le devine pas.
- `content.js` — pilote la vidéo pendant la préparation (×2, silence, restitution) et
  affiche le stock pendant la lecture : **un bloc apparaît quand `video.currentTime`
  atteint l'instant de son premier mot**. Boîte de deux lignes de hauteur fixe ; un
  message d'échec, lui, fait grandir la boîte pour ne jamais être coupé
  (`prepAfficherErreur`).
- `offscreen.html` / `offscreen.js` — capture audio (getUserMedia sur l'onglet),
  découpage en blocs, table des ancres, stock des mots. **Vérifie aussi les cinq
  fichiers du modèle AVANT tout chargement** (`prepModeleManquant`).
- `preparation.worklet.js` — AudioWorklet qui empile le son capté. Fait la **moyenne des
  deux canaux** (voir 5 bis).
- `parakeet.worker.js` — **Web Worker** de transcription : c'est là que vivent
  parakeet.js et ONNX Runtime, pour que le fil principal ne fige jamais.
- `models/parakeet-tdt-0.6b-v3/` — les 5 fichiers de poids, 640 Mo. Gitignoré,
  téléchargé par `npm run fetch-model` (`scripts/fetch-model.js`).
- `vendor/` — librairies locales. Gitignoré, régénéré par `scripts/copy-assets.js`
  (postinstall).
- `README.md` — installation, licences, attribution NVIDIA (condition CC-BY-4.0).
- `test-parakeet.html` / `.js`, `test-parakeet-worker.html` / `.js` — pages de mesure du
  moteur actuel.

⏳ **VRAI JUSQU'AU 30/08/2026, PLUS D'ACTUALITÉ — les fichiers du mode direct.**

> - `content.js` — overlay de sous-titres : boîte de **deux lignes de hauteur fixe**, les
>   mots nouveaux révélés **un par un** (`PAS_REVELATION`), le début qui sort par le haut.
>   `RETARD_MAX_MOTS` empêche l'affichage de traîner derrière la parole. C'est aussi lui
>   qui décide **ce qu'on montre** — stable seul, ou stable + provisoire (voir « Les deux
>   modes d'affichage »).
> - `offscreen.html` / `offscreen.js` — capture audio (getUserMedia sur l'onglet) + VAD
>   (Silero via `@ricky0123/vad-web` ; `getStream/pauseStream/resumeStream` pour écouter
>   l'onglet et PAS le micro ; `model: "v5"`).
> - `vendor/` — librairies locales (VAD + Transformers.js + runtime ONNX). Gitignoré,
>   régénéré par `scripts/copy-assets.js` (postinstall).
> - `whisper.worker.js` — **Web Worker** de transcription : c'est là que vivent
>   Transformers.js et Whisper, pour que le fil principal ne fige jamais. Choisit aussi
>   le backend (GPU/CPU) — voir « Choix du backend » plus bas.
> - `test-whisper.html` / `test-whisper.js` — page de test isolée : prouve que Whisper
>   transcrit (Transformers.js, `Xenova/whisper-tiny`, `dtype: "fp32"`) depuis le worker,
>   sans figer la page. C'est aussi la page qui lit/écrit le backend mémorisé.
> - `test-bench.html` / `test-bench.js` — page de **comparaison** : fait tourner plusieurs
>   variantes du modèle sur le même audio (fragments à la taille de production + extrait
>   complet, EN et FR), chronomètre, et affiche les textes côte à côte. Le worker accepte
>   `?modele=…&dtype=…&opt=…` uniquement pour elle ; en production personne ne passe de
>   paramètre.

→ **Ce qui a changé** : `whisper.worker.js` est **supprimé du dépôt**. Le VAD n'est plus
utilisé (la préparation découpe par blocs de durée fixe, pas par tours de parole). Les
pages `test-whisper.*` et `test-bench.*` sont encore sur le disque mais ne mesurent plus
le moteur de production. **Pourquoi** : voir le bandeau en tête de fichier.

## Dépendances
- `parakeet.js` (ysdede, **MIT**) — chargement et décodage de Parakeet. C'est elle qui
  tourne en production. ⚠️ Elle a un bug d'espacement en français : voir « Le bug de
  `parakeet.js` ».
- `onnxruntime-web` — moteur d'exécution des modèles.
- `@ricky0123/vad-web` — détection de parole. ⏳ **Plus utilisée en production** depuis le
  retrait du mode direct ; la dépendance reste installée.
- `@huggingface/transformers` — Whisper. ⏳ **Plus utilisée en production** ; ne sert plus
  qu'aux anciennes pages de mesure.

⚠️ **Le modèle n'est pas une dépendance npm.** `nvidia/parakeet-tdt-0.6b-v3` est sous
**CC-BY-4.0** : l'attribution à NVIDIA est une **condition de la licence**, pas une
politesse. Voir `README.md`.

## Le choix du modèle : ce qui bloquait n'était pas ONNX, c'était l'horodatage par mot

**Aujourd'hui : NVIDIA Parakeet TDT 0.6B v3**, export ONNX int8 de `ysdede`, chargé par
la librairie **`parakeet.js` (MIT)**. 640 Mo, sur le CPU.

⚠️ **CORRECTION D'UNE ERREUR QUI A COÛTÉ DU TEMPS.** Il était écrit, et cru, qu'**« aucun
autre modèle n'existe : en ONNX pour le navigateur, il n'y a QUE Whisper »**. **C'est
faux.** La vraie barrière n'a jamais été ONNX ni le navigateur : c'était **l'HORODATAGE
PAR MOT**. Sans l'heure de chaque mot, rien de ce projet ne tient — ni l'affichage à
l'heure, ni les ancres, ni la mesure de la médiane. Beaucoup de modèles savent
transcrire ; peu rendent des instants par mot. C'est ce critère-là qu'il fallait chercher,
et le chercher plus tôt.

**La leçon de méthode** : une conclusion négative (« ça n'existe pas ») mérite le même
niveau de preuve qu'une conclusion positive. Formulée sur le mauvais critère, elle ferme
la porte pour des mois.

### Les langues : 25, détectées seules, aucun réglage

- **25 langues européennes**, **détectées automatiquement**. Le vocabulaire de Parakeet ne
  contient **aucun jeton de langue** : il n'y a rien à lui indiquer.
- Il n'y a donc **plus de sélecteur de langue** dans la popup, et c'est pour ça — pas par
  simplification. Le menu était devenu un bouton débranché.
- ⛔ **Perdu au change, et c'est un vrai renoncement** : **plus d'arabe, de chinois, de
  japonais ni de turc** en transcription. Whisper les faisait.

⏳ **VRAI JUSQU'AU 30/08/2026 — les 15 langues du mode direct.**

> « 15 langues source, mémorisées, à chaud » : le direct proposait un menu déroulant, le
> choix était rangé dans `chrome.storage` et transmis à Whisper (`language: "french"`),
> et il pouvait changer sans redémarrer la capture.

→ **Ce qui a changé** : plus de menu, plus de clé, plus de message. **Pourquoi** : Whisper
avait besoin qu'on lui dise la langue, Parakeet non.

### ⏳ Les vitesses des Whisper — mesurées avant le 30/08/2026, conservées

Relevé sur cette machine, en **% du temps réel** (plus bas = plus rapide) :

| modèle | % du temps réel |
|---|---|
| tiny | **31 %** |
| base q8 | 59 % |
| base fp32 | 75 % |
| small q8 | 211 % (disqualifié) |
| turbo (809 M) | ~700 % |
| large-v3 (1,55 Md) | ~1300 % |

Pour tenir le défilement ×2 il fallait être **sous 50 %**.

⬜ **RESTE OUVERT, et le restera** : `base` n'a jamais été mesuré sur du son **bruité**. Il
a été écarté sur du son propre — donc sur les mauvaises données. La question ne se pose
plus pour la production, mais l'erreur de méthode, elle, est à retenir.

### Les résultats du nouveau moteur (mesurés, 30/08/2026)

| | Whisper (avant) | Parakeet (après) |
|---|---|---|
| fautes sur **2 493 mots** | **29** | **1** |
| médiane mot prononcé → affiché | — | **12 ms** |
| RTF (facteur temps réel) | 0,31 (tiny) | **0,283** |
| requêtes externes | 0 | **0** |

---

## WebGPU : plus lent, ET il ne rend pas le même texte

**Deux reproches, et le second est bien plus grave que le premier.**

1. **Il est plus lent.** ×2,2 en défaveur du GPU sur cette machine (Intel Iris Xe). C'est
   le même verdict que pour Whisper — voir la section datée « Choix du backend » : sur un
   GPU intégré, le décodeur enchaîne de toutes petites étapes et le coût de lancement de
   chaque calcul dépasse le gain de parallélisme.
2. ⛔ **IL NE REND PAS LE MÊME TEXTE.** « d'étoil » au lieu de « d'étoiles ». Ce n'est pas
   une question de vitesse : c'est un résultat **faux**, sans le moindre message.

⚠️ **Et dans un worker, il DÉTRUIT la sortie : 8 mots au lieu de 69.**

**La signature à reconnaître : une confiance de 0,6234.** Quand cette valeur apparaît,
c'est WebGPU qui calcule, quoi qu'on croie avoir configuré.

### ⚠️ Ce n'est pas le bundle, c'est le PROVIDER — mais la consigne ne change pas

La première explication était « le mauvais bundle charge le mauvais `.wasm` ». **La vraie
cause est le provider d'exécution** : c'est `executionProviders` qui décide, pas le nom du
fichier importé.

**Et pourtant la consigne reste la même : importer `ort.wasm.bundle.min.mjs`.** Pour une
bien meilleure raison qu'avant :

> **ce bundle ne CONTIENT PAS le provider WebGPU.**

C'est une **garantie de structure**, pas un réglage qu'on peut oublier. Un réglage se
perd, se surcharge, se contredit ailleurs dans le code ; un provider absent du binaire ne
peut pas s'activer par accident. ⛔ **Ne pas remplacer par `ort.bundle.min.mjs`.**

---

## Le bug de `parakeet.js` : l'espace avalé devant les accents

⛔ **RÈGLE : toujours dériver le texte de `res.words`. JAMAIS de `res.utterance_text`.**

`parakeet.js` recolle son texte avec `text.replace(/\s+(?=[^\w\s])/g, "")`. **Vérifié
dans la librairie installée le 31/08/2026 : `node_modules/parakeet.js/src/tokenizer.js`,
ligne 82**, commentée « Remove space before punctuation ». C'est `tokenizer.decode()` qui
l'applique, et `utterance_text` en sort — `words`, non. En
JavaScript, **`\w` vaut `[A-Za-z0-9_]` — de l'ASCII pur**. Les lettres accentuées n'en
font pas partie, tombent donc dans la classe « ponctuation », et l'espace qui les précède
est effacé :

> « premieresetoiles », « desevenements », « disparaitrea »

**En anglais ça ne se voit jamais. En français ça hache le texte à chaque accent.**

`res.words` est juste : il est construit ailleurs, par `raw.startsWith("▁")`, un test
direct sur le marqueur SentencePiece qui ne passe pas par cette expression régulière.

⚠️ **En le corrigeant, ne pas refaire la même erreur** : le test « ce morceau commence-t-il
par de la ponctuation ? » doit exclure lettres et chiffres **au sens Unicode**
(`/^[^\p{L}\p{N}]/u`, drapeau `u`).

---

## Panne silencieuse dans un worker : le guichet doit être posé en PREMIÈRE ligne

⛔ **RÈGLE : `self.onmessage` s'installe à la première ligne exécutée du worker, avant
tout `await` de niveau module.**

Un `await` au niveau du module — un `import()` dynamique, par exemple — laisse **la boucle
d'événements du worker tourner**. Un message envoyé par la page pendant cette attente est
distribué tout de suite ; s'il n'y a pas encore de `onmessage`, il est **jeté en silence**.

**Aucune erreur. Aucun échec. Aucun délai.** La page attend une réponse qui ne viendra
jamais. Mesuré : le worker chargeait son bundle correctement puis restait muet
**227 secondes**, et l'onglet Réseau montrait que le `init` n'avait rien déclenché.

**La parade** : installer le gestionnaire dès la première ligne, empiler les messages
reçus dans une file, et rejouer la file une fois le moteur prêt.

⚠️ C'est **exactement la même forme de panne** que le `chrome.storage` dans l'offscreen
(voir « Contraintes techniques connues ») : ce qui la rend invisible, c'est qu'elle
n'échoue nulle part.

---

## La mémoire : `performance.memory` aurait annoncé 1,2 Mo au lieu de 1 335 Mo

Le worker Parakeet occupe **~1 335 Mo de mémoire WebAssembly**. C'est ce qui oblige à le
**terminer à la fin de chaque préparation** (`prepTerminerWorker`), sur une machine qui
plafonne à ~2 100 Mo.

⛔ **`performance.memory` ne compte QUE le tas JavaScript.** Les poids du modèle vivent
dans la **mémoire linéaire du WebAssembly**, qui n'y figure pas. Interrogé seul, il aurait
répondu **1,2 Mo** — un chiffre rassurant et **faux d'un facteur mille**.

**La parade** : garder une référence sur l'objet `WebAssembly.Memory` que le runtime crée
(en enveloppant le constructeur **avant** de charger ONNX Runtime) et lire
`buffer.byteLength`. Si le runtime change de façon de faire, la référence reste nulle et
**on le dit** au lieu d'inventer un chiffre.

---

## ⏳ Le mode direct — RETIRÉ LE 30/08/2026, et ce qu'il a prouvé

Le mode direct transcrivait au fil de la parole. Il a été **supprimé** : plus de bouton,
plus de sélecteur de mode, plus de `whisper.worker.js`, plus de VAD, plus de `FLUX`.

**Il n'a pas été un détour pour rien — il a démontré le triangle impossible** (voir « Les
instants ») : on ne peut pas avoir à la fois le texte synchrone avec le son, le son
synchrone avec l'image, et la transcription faite en direct. Deux sur trois au mieux. Ce
constat est ce qui a fait choisir « préparer d'abord », et il tient toujours.

Les sections datées qui le décrivent restent en place : « Les deux modes d'affichage »,
« Le retard du son », « Le flux », « L'horloge des mots », « Choix du backend ».

⚠️ **Conséquence pour l'acquis n° 8.** Le bloc « ACQUIS À NE PAS PERDRE » (dans
`REPRISE-LIVESUB.md`) comptait un huitième point : « Le MODE DIRECT fonctionne toujours,
sans une ligne modifiée ». **Il n'a plus d'objet : il ne reste que 7 acquis.**

---

## Défauts corrigés le 30/08/2026 — ne plus les compter comme ouverts

| défaut | état |
|---|---|
| Le pourcentage de téléchargement du modèle repart en arrière | ✅ **corrigé** — le dénominateur est désormais la somme des 5 tailles exactes, connue avant la première requête ; jamais `content-length`. Vérifié : 106 valeurs relevées, **0 recul** |
| Si `models/` manque, l'overlay reste bloqué à l'infini | ✅ **corrigé** — les 5 fichiers sont vérifiés **avant tout chargement** ; message nommant le fichier, le dossier et la commande, en **moins de 700 ms**, sans qu'aucune barre ne démarre |
| « bloc abandonné, ArrayBuffer detached » | ✅ **corrigé** |
| « bloc INCOMPLET — dernier mot à X s sur Y s » | ✅ **sans objet** — c'était le plafond de jetons de Whisper (voir le point 1, daté) |


## ⏳ Choix du backend : WebGPU ou CPU ? On mesure, on ne suppose pas — MÉCANIQUE RETIRÉE LE 30/08/2026
⏳ **VRAI JUSQU'AU 30/08/2026, PLUS D'ACTUALITÉ — la mesure GPU/CPU au premier lancement.**

Cette mécanique appartenait à `whisper.worker.js`, supprimé. Parakeet tourne **sur le
CPU, sans mesure préalable** : il n'y a plus de verdict à mémoriser, plus de clé
`whisperBackend`, plus de worker neuf par backend.

⛔ **Ne pas appliquer les règles de cette section.** Le texte qui suit est conservé
intact : les mesures restent vraies pour ce qu'elles mesuraient.

---
**WebGPU n'est PAS toujours plus rapide.** Sur un GPU intégré (ex : Intel Iris Xe,
`gen-12lp`), WebGPU est ~2× **plus lent** que le CPU sur whisper-tiny : le décodeur
enchaîne des dizaines de toutes petites étapes, et le coût de lancement de chaque
calcul sur le GPU dépasse le gain de parallélisme. Sur une carte dédiée, c'est
l'inverse. D'où le choix : **mesurer les deux et garder le plus rapide**, plutôt que
de forcer le GPU.

Comment ça marche :
- Au **tout premier lancement**, le worker chronomètre le GPU et le CPU sur la même
  charge de test, puis garde le gagnant. Les lancements suivants ne remesurent plus.
- Le verdict est mémorisé dans `chrome.storage.local` (clé `whisperBackend`), **par la
  page** : `chrome` est indéfini dans un worker dédié (vérifié). Le worker reçoit le
  verdict dans le message `init` et le renvoie dans `ready`.
- Chaque backend est chronométré dans un **worker neuf**. ONNX Runtime ne charge qu'un
  seul moteur WASM par worker, et le premier backend initialisé l'impose aux suivants :
  mesurer le CPU dans le worker qui vient d'initialiser le GPU le fait tourner sur le
  moteur du GPU (variante `asyncify`) et fausse le classement.
- On garde le **meilleur de 3 passages** : une machine occupée ne peut qu'ajouter du
  temps. Un passage unique a donné 2,4 s puis 6,5 s pour le même backend — assez pour
  inverser un classement qui, lui, est mémorisé pour de bon.
- Repli automatique : si le backend retenu ne charge pas ou ne transcrit pas, on
  bascule sur le CPU sans erreur visible.

Ordres de grandeur mesurés sur cette machine (Intel Iris Xe, extrait de ~10 s) :
CPU ~2,3 s, GPU ~4 à 5 s. *(L'ancien chiffre de « ~12 s » n'est plus d'actualité : il
datait de l'inférence sur le fil principal, chargement du modèle compris.)*


→ **Ce qui a changé** : plus aucun choix de backend à l'exécution. **Pourquoi** : la
question « GPU ou CPU ? » a été tranchée pour de bon avec Parakeet, et dans le mauvais
sens pour le GPU — voir « WebGPU : plus lent, ET il ne rend pas le même texte ». Le
constat de fond de cette section, lui, s'est **confirmé une deuxième fois** : sur cette
machine le GPU intégré perd contre le CPU.
## ⏳ Les deux modes d'affichage — RETIRÉS LE 30/08/2026 (mode direct)
⏳ **VRAI JUSQU'AU 30/08/2026, PLUS D'ACTUALITÉ — l'option « Afficher la fin provisoire ».**

`ruban` / `provisoire` décrivaient **LocalAgreement-2**, propre au mode direct. La case
de la popup, la clé `afficherProvisoire` et le message `SET_PROVISOIRE` ont été retirés
en même temps que le direct.

⛔ **Ne pas appliquer les règles de cette section.** Le texte qui suit est conservé
intact : les mesures restent vraies pour ce qu'elles mesuraient.

---
Le moteur produit **deux** textes : le `ruban` (stable — deux passes successives sont
tombées d'accord dessus, il ne bougera plus jamais) et le `provisoire` (la dernière
hypothèse, que la passe suivante a le droit de corriger).

Afficher le provisoire, **c'est** accepter que du texte déjà lu se réécrive sous les
yeux : « nouve. » devient « nouvelle », « rembobi. » devient « rembobiner ». Ce n'est
pas un défaut qu'on peut corriger — c'est la définition du mot « provisoire ».

D'où une **option**, et pas un remplacement : case « Afficher la fin provisoire » dans la
popup, **décochée par défaut**, rangée dans `chrome.storage.local` sous
`afficherProvisoire`.

- **Décochée (défaut) — stable seulement.** Le texte ne peut que s'allonger. Prix assumé :
  un mot n'apparaît qu'une fois confirmé, soit **une cadence de retard en plus**.
- **Cochée — avec la fin provisoire.** Plus réactif, mais les derniers mots se corrigent
  en direct.

⚠️ **La bascule est à chaud, et c'est le point important** : le choix se juge à l'œil, sur
la même vidéo et la même phrase — aucun redémarrage de capture, aucune recalibration.
`offscreen.js` **n'est pas au courant des modes** pour ce qu'il produit : il envoie
toujours `ruban` ET `provisoire`. C'est l'affichage qui tranche.

Les deux destinataires ne sont **pas** prévenus de la même façon, et ce n'est pas un
caprice (voir « `chrome.storage` est indisponible dans l'offscreen ») :
- `content.js` lit `chrome.storage` lui-même et écoute `storage.onChanged` — un content
  script y a accès ;
- `offscreen.js` est prévenu par **message** (`SET_PROVISOIRE` → `PROVISOIRE`), relayé par
  le service worker, exactement comme la langue et le retard.

Mesuré au banc, 2 min 10 s de parole continue (voir « Comment tester ») :

| | avec provisoire | stable seulement |
|---|---|---|
| mots déjà affichés qui **changent** | **50** | **0** |
| mots prononcés jamais affichés | 0 | 0 |
| écrans vides | 0 | 0 |
| âge du son affiché | 1,9 s | 3,2 s |

⚠️ **La dernière ligne date d'avant l'horloge des mots** (étape 2) : l'écran ajoute
désormais le retard d'affichage, mesuré au banc à 4,4 s avec provisoire et 6,4 s en
stable. Les trois premières lignes, elles, tiennent toujours. Et « mots déjà affichés qui
changent » devrait baisser en mode provisoire — un mot qui attend son heure a le temps
d'être corrigé avant d'apparaître : **4 → 1 sur le flux de 7 messages du banc de chaîne**.
Le run de 2 min 10 s n'a pas été refait, donc le « 50 » du tableau n'a pas d'équivalent
mesuré après l'étape 2.

Aucun mot n'est perdu en mode stable : c'est la **clôture de fenêtre** qui le garantit —
`figerFenetre` verse tout le provisoire dans le ruban quand la fenêtre se ferme, donc la
fin de phrase finit toujours par s'afficher.


→ **Ce qui a changé** : plus de provisoire, donc plus rien qui se réécrive sous les yeux
— la préparation livre du texte **définitif** avant que la lecture commence.
**Pourquoi** : voir le bandeau en tête de fichier. Tous les chiffres ci-dessus restent
vrais pour le moteur qu'ils mesuraient.
## ⏳ Le retard du son : DEUX valeurs, une par mode — RETIRÉ LE 30/08/2026
⏳ **VRAI JUSQU'AU 30/08/2026, PLUS D'ACTUALITÉ — la calibration du retard audio par mode.**

Le retard du son servait à recaler la voix sur un texte qui arrivait **en retard**. En
préparation, le texte est prêt AVANT la lecture : il n'y a plus de retard à rattraper.
`retardCalibreFluxParMode` n'est plus lue ni écrite.

⛔ **Ne pas appliquer les règles de cette section.** Le texte qui suit est conservé
intact : les mesures restent vraies pour ce qu'elles mesuraient.

---
Le retard audio aligne ce qu'on **entend** sur ce qu'on **lit**. La règle est la même dans
les deux modes — *on mesure l'âge du dernier mot réellement affiché* — mais ce mot n'est
pas le même :

- **avec provisoire** → le dernier mot est le bout de la fenêtre. Repère : `finAudioMs`.
- **stable seulement** → le dernier mot est le dernier **confirmé**. LocalAgreement-2 le
  borne par l'hypothèse *précédente* : un mot ne peut pas être confirmé s'il n'était pas
  déjà dans la passe d'avant. Repère : `finAudioPassePrecedente`.

L'écart entre les deux repères est exactement l'audio avalé entre deux passes — **une
cadence**. Mesuré : 1,8 s / 3,3 s sur machine normale (écart 1,5 s), 4,3 s / 8,3 s sur
machine lente simulée (écart 4,0 s).

Prendre `finAudioMs` dans les deux cas était le défaut : en mode stable on calait le son
sur la fin de la *fenêtre* alors que l'écran montrait du texte plus vieux d'une cadence,
donc le son passait systématiquement en avance sur le texte lu.

Les **deux** valeurs sont mesurées dans le même passage de calibration (les deux repères
vivent sur les mêmes passes) et mémorisées ensemble sous
`retardCalibreFluxParMode = { avecProvisoire, stable }`. Cocher la case recale donc le son
**tout de suite**, sans remesurer.

⚠️ **Le nom de la clé porte la génération, et ce n'est toujours pas cosmétique.** Une
valeur mémorisée par une génération précédente est fausse pour celle-ci, et comme elle
est mémorisée pour de bon elle ne serait jamais remesurée. Trois générations à ce jour :
`retardCalibre` (moteur par blocs, ~9 s), `retardCalibreFlux` (flux, un seul mode),
`retardCalibreFluxParMode` (l'actuelle). Les deux premières sont effacées dans
`onInstalled` — mais **le ménage n'est qu'un confort** : la vraie protection est que
`readRetardCalibre` ne lit que le nom courant, et refuse toute valeur qui n'a pas les deux
champs attendus. Vérifié au banc sur un storage contenant les trois clés.


→ **Ce qui a changé** : plus de retard audio du tout, et plus de réglage dans la popup.
**Pourquoi** : voir le bandeau en tête de fichier.

⚠️ **La leçon de la clé qui porte sa génération, elle, reste bonne et s'applique encore** :
une valeur mémorisée par une génération précédente est fausse pour la suivante, et comme
elle est mémorisée pour de bon elle ne serait jamais remesurée. C'est une règle de
méthode, pas un détail de Whisper.
## ⏳ Le flux : une fenêtre qu'on re-transcrit — RETIRÉ LE 30/08/2026 (mode direct)
⏳ **VRAI JUSQU'AU 30/08/2026, PLUS D'ACTUALITÉ — le moteur en flux (fenêtre glissante + LocalAgreement-2).**

`FENETRE_MAX`, `MIN_NOUVEAU`, `RECOUVREMENT_FENETRE`, `passeEnVol` : tout cela vivait
dans le mode direct.

⛔ **Ne pas appliquer les règles de cette section.** Le texte qui suit est conservé
intact : les mesures restent vraies pour ce qu'elles mesuraient.

---
C'est le cœur du moteur, et c'est ce qui donne l'effet « sous-titres YouTube » : les mots
s'ajoutent au fil de la parole au lieu qu'une phrase entière saute toutes les 7 secondes.

**La propriété qui rend tout possible : Whisper complète TOUT extrait à 30 s avant de le
traiter.** Transcrire 4 s ou 11 s coûte donc presque pareil. Re-transcrire une phrase
depuis son début est quasi gratuit — et chaque passe a *plus* de contexte que la
précédente, jamais moins. C'est l'exact inverse du découpage en blocs, où chaque bloc
était aveugle à ce qui le précédait.

**La règle qui tient tout le reste : UNE SEULE INFÉRENCE EN VOL** (`passeEnVol`). Dès
qu'une passe rend son texte, on relance sur la fenêtre telle qu'elle est *à cet instant*.
Il n'y a donc aucune file d'attente, et la latence **ne peut pas** diverger : la cadence
s'adapte toute seule à la machine. Toute l'ancienne surveillance de file (`FILE_MAX`,
`segmentsAbandonnes`…) a disparu avec elle — c'était le remède à un mal que le moteur ne
produit plus.

**Stable / provisoire (LocalAgreement-2)** — c'est ce qui permet d'*ajouter* des mots
plutôt que de réécrire la phrase. Deux passes successives partagent presque tout leur
texte : leur **préfixe commun** n'a plus aucune raison de changer, on le verse dans le
`ruban` pour de bon. Ce qui suit reste `provisoire`, la passe suivante peut le corriger.
On **compare** des formes normalisées (sans accents ni ponctuation) mais on **affiche** le
mot d'origine.

Réglages (`offscreen.js`) :
- `FENETRE_MAX = 12` — au-delà on fige et on repart. Sans borne, Whisper tronquerait à
  30 s en perdant le début, sans rien dire.
- `MIN_NOUVEAU = 0,7` — audio neuf minimum avant de relancer (~un mot). Sans ce plancher
  on relancerait sur une fenêtre identique, et elle ne s'allongerait jamais.
- `RECOUVREMENT_FENETRE = 0,5` — la coupure à `FENETRE_MAX` tombe en plein mot.
- À la fermeture « fenêtre pleine », **on jette le dernier mot du provisoire** : il est
  coupé en deux, et le recouvrement le retranscrira entier. Sans ce tri, le demi-mot était
  figé pour de bon puis doublé (« apres une **pa. pause** et doit »).

Ce que ça a remplacé (`DUREE_MAX = 7`, `DUREE_MIN_ENVOI = 3`, `SILENCE_MAX`,
`RECOUVREMENT`) : des blocs transcrits **une fois** puis oubliés, dont le texte
*remplaçait* le précédent à l'écran.

Résultat mesuré au banc (voir « Comment tester ») : l'âge du son au moment de l'affichage
reste **plat** — 1,5 s sur machine normale, 4,0 s sur machine lente simulée — au lieu de
dériver (+0,3 s par seconde d'audio dans l'ancien moteur : 32 s de retard après 90 s). Le
ruban ne recule jamais, aucun mot prononcé n'est perdu.

⚠️ Le piège reste le même qu'avant : baisser les bornes « pour être plus réactif » dégrade
la latence *et* le texte. Sous ~5 s de contexte, whisper-tiny n'écoute plus, il récite les
phrases les plus fréquentes de son entraînement (« Thank you for watching »).


→ **Ce qui a changé** : la préparation découpe en **blocs de 20 s transcrits une seule
fois**, avec 3 s de contexte audio à la jointure (voir 5 ter). **Pourquoi** : voir le
bandeau en tête de fichier.

⚠️ **ATTENTION, UNE PHRASE DE CETTE SECTION EST FAUSSE POUR PARAKEET** :
« Whisper complète TOUT extrait à 30 s avant de le traiter » est une propriété de
**Whisper**, et c'est elle qui rendait la re-transcription quasi gratuite. Parakeet est
un **transducteur** : son coût suit la durée réelle du son. Ne pas réutiliser ce
raisonnement tel quel — NON MESURÉ sur Parakeet.
## Les instants : chaque mot connaît l'heure à laquelle il a été prononcé

⚠️ **CE QUI EST TOUJOURS VRAI, ET CE QUI NE L'EST PLUS (30/08/2026).**

- ✅ **Le triangle impossible reste vrai**, et c'est la leçon la plus durable du projet.
- ✅ **Chaque mot porte toujours son instant** : Parakeet rend des horodatages par mot,
  comme Whisper. C'était d'ailleurs **la vraie barrière au changement de modèle** — pas
  ONNX, pas le navigateur : l'horodatage par mot. Voir « Le choix du modèle ».
- ⏳ **Le coût mesuré (+3 à +20 %) est celui de `return_timestamps: "word"` de Whisper.**
  Chez Parakeet l'horodatage n'est pas une option qu'on active : le transducteur émet au
  rythme des trames, l'instant vient avec le mot. **Surcoût : NON MESURÉ, sans objet.**
- ⏳ **« Whisper complète tout extrait à 30 s »** ne vaut pas pour Parakeet.
- ⏳ **Le chemin décrit plus bas (`whisper.worker.js` → `FLUX` → `rubanInstants`) est
  celui du mode direct**, supprimé. Les instants voyagent aujourd'hui dans le stock de la
  préparation.

**Le triangle impossible, d'abord.** Trois choses souhaitables, on ne peut en avoir que
deux : *(1)* le texte synchrone avec le son, *(2)* le son synchrone avec l'image, *(3)* la
transcription faite en direct depuis l'onglet. On ne peut pas transcrire un mot avant
qu'il soit prononcé : le mot dit à l'instant T n'existe en texte qu'à T + ~2 s. YouTube
n'a pas ce problème parce qu'il ne fait pas du direct — la vidéo est transcrite sur ses
serveurs *avant* d'être lue. **On abandonne donc le point 1** : le texte restera derrière
la voix. Ce qui est réparable, et complètement, c'est que ce retard soit **régulier**.

**La maladie que ça soigne.** `content.js` révélait les mots à cadence fixe
(`PAS_REVELATION`, 80 ms) parce qu'il savait *lesquels* mais pas *quand*. D'où des rafales
suivies de trous, sans rapport avec le rythme réel de la parole, et des silences qui
n'existaient pas à l'écran. Avec l'instant de chaque mot, l'affichage peut le sortir à
l'heure : parole rapide → texte rapide, pause → l'écran s'arrête.

### Ce que ça coûte : mesuré, pas supposé (2026-08-20, `test-bruit.html`)
| fenêtre | mots/passe | sans | avec | surcoût |
|---|---|---|---|---|
| 7 s | 11 | 2 201 ms | 2 276 ms | +3 % |
| 8 s | 13 | 1 924 ms | 2 153 ms | +12 % |
| 10 s | 15 | 1 932 ms | 2 227 ms | +15 % |
| 11 s | 17 | 2 013 ms | 2 409 ms | **+20 %** |
| 12 s | 20 | 2 100 ms | 2 504 ms | **+19 %** |

Le coût suit le **nombre de mots décodés**, pas la durée du son (Whisper complète tout
extrait à 30 s). Le seuil qu'on s'était donné pour renoncer était +40 % : on est à la
moitié. Et **rien ne s'accumule** — 14 passes consécutives du même worker sur le même
fragment, les deux courbes restent plates.

### La justesse des instants sous le bruit : intacte
| musique | signal/bruit | mots retrouvés | écart médian | p90 | instants non croissants |
|---|---|---|---|---|---|
| 0.2 | 4,3 dB | 100 % | 20 ms | 160 ms | 0 |
| 0.4 | **−1,8 dB** | 97 % | 20 ms | 180 ms | 0 |

À −1,8 dB la musique est *plus forte que la voix*, et les instants ne bougent que de
20 ms. Le bruit abîme le **mot**, pas l'**heure**.

### ⚠️ Deux pièges trouvés à la mesure, tous deux traités dans le code
- **Un mot peut être daté APRÈS la fin de la fenêtre.** Sur une fenêtre de 11 s, 9 mots
  au-delà de la fin, dont un à **+7,4 s** : Whisper complète l'extrait à 30 s et
  l'alignement place parfois la fin dans ce silence de remplissage. Un mot daté dans le
  futur ne s'afficherait jamais à l'heure — l'écran resterait figé à l'attendre. D'où le
  bornage dans `instantsAbsolus`.
- **Un « mot » de Whisper n'est pas un mot.** « J'adore, » arrive en **deux** morceaux,
  `" J"` puis `"'adore,"`. Ce qui distingue deux morceaux du même mot de deux mots
  différents, c'est **l'espace qui précède** — d'où le texte transmis **sans `.trim()`**
  par le worker. Trimmer effaçait la seule information permettant de recoller.

### Le chemin, maillon par maillon
1. `whisper.worker.js` demande `return_timestamps: "word"` **en production**
   (`?horodatage=non` désactive, pour les pages de mesure seulement). La signature du
   backend porte `|ts=word` : une mesure GPU/CPU faite sans horodatage ne vaut plus, elle
   est donc automatiquement refaite.
2. `offscreen.js` recolle les morceaux (`recollerMots`), convertit en heure absolue
   (`instantsAbsolus` : `finAudioMs - samples/TAUX` donne le début de fenêtre), borne, et
   garantit des instants croissants.
3. **LocalAgreement-2 n'a pas changé d'une ligne** : il compare toujours des mots,
   l'instant voyage à côté. `ruban` et `provisoire` sont devenus des **listes de
   `{mot, instant}`** — la chaîne est *dérivée*, pour qu'une troncature ne puisse pas
   désynchroniser les mots et leurs heures.
4. `FLUX` porte `rubanInstants` et `provisoireInstants`, un instant par mot.

**Garde-fou** : si le recollage ne redonne pas exactement les mots affichés, on renonce
aux instants **pour cette passe** (compteur `motsSansInstant`) plutôt que de les décaler
d'un cran. Un mot affiché à l'heure de son voisin serait pire que pas d'heure du tout.

### ⚠️ Le relais du service worker ne doit RIEN reconstruire
`sendFlux` prenait `(ruban, provisoire, finAudio)` et réassemblait un objet. Tout champ
ajouté par l'offscreen était donc **jeté là, en silence**. C'est arrivé : `finAudioStable`
— le repère du mode « stable seulement » — était produit et attendu, mais n'a jamais
traversé ; `content.js` retombait sur `finAudioStable || finAudio`, donc rien ne plantait
et seule la mesure d'âge du mode stable était fausse d'une cadence. **Un repli qui marche
est exactement ce qui rend ce genre de perte invisible.** `sendFlux` relaie désormais le
message entier.

## ⏳ L'horloge des mots : le retard OBSERVÉ — RETIRÉ LE 30/08/2026 (mode direct)
⏳ **VRAI JUSQU'AU 30/08/2026, PLUS D'ACTUALITÉ — le retard d'affichage observé (percentile 90) et son plafond.**

Tout cet appareillage n'avait qu'un but : compenser le fait qu'en direct on ne sait pas
quand un mot a été prononcé. En préparation on le sait, et c'est `video.currentTime` qui
commande. `RETARD_MAX` a disparu avec le reste.

⛔ **Ne pas appliquer les règles de cette section.** Le texte qui suit est conservé
intact : les mesures restent vraies pour ce qu'elles mesuraient.

---
`PAS_REVELATION = 80` et `RETARD_MAX_MOTS = 12` **ont disparu**, et c'est le signe que
l'étape 2 a fait son travail : c'étaient deux rustines pour compenser l'absence
d'horloge. Un seul réveil toutes les 50 ms, qui sort tout mot dont l'heure est venue.

`RETARD_MAX_MOTS` ne peut même plus avoir de raison d'être : un vieux mot porte un vieil
instant, son heure est passée depuis longtemps, il est visible immédiatement. Il n'y a
plus rien à « rattraper », donc plus rien à borner.

### ⚠️ Le retard d'affichage se cale sur le mot le plus ANCIEN en attente, pas le plus frais
C'est le point qui décide de tout, et il a été tranché au banc. Les mots n'arrivent pas un
par un : ils arrivent **par lots**, un lot couvrant une cadence de parole. Le plus ancien
d'un lot est donc plus vieux que le plus frais d'exactement une cadence — et si le retard
est calé sur le plus frais, tous les autres sont déjà en retard et sortent d'un bloc.

Mesuré sur une piste à rythme variable (rapide 180 ms/mot, **pause de 2 s**, lent
520 ms/mot) :

| | calé sur le plus frais | calé sur le plus ancien en attente |
|---|---|---|
| normale, stable | 30 ms d'écart, rafales de **5** | **20 ms, rafales de 1** |
| normale, provisoire | 180 ms, rafales de 4 | **20 ms, rafales de 1** |
| lente, provisoire | 300 ms, **pause perdue** | **20 ms, pause conservée** |

Prix assumé : **+1,5 s de retard à l'écran** (4,9 → 6,4 s en mode stable). C'est ce qu'il
en coûte pour que les mots sortent un par un au bon rythme au lieu de gicler par paquets.

Le retard n'est **pas** une constante : il est **observé** (percentile 90 des 20 derniers
lots, un jeu par mode), parce qu'il doit couvrir la latence du moteur — 2 s ici, 6 s sur
une machine lente, plus une cadence en mode stable. Une valeur écrite en dur serait juste
pour une machine et fausse pour toutes les autres.

**Vérifié dans Chrome, pas seulement au banc** : intervalles prononcés 200 / 1500 / 600 /
600 / 600 ms → affichés 196 / **1504** / 597 / 603 / 598 ms. La pause est restée une pause
à 4 ms près.

### La limite, et pourquoi on la choisit
`RETARD_MAX = 10 s`. Le retard nécessaire vaut ~2 cadences en mode provisoire et ~3 en
mode stable. Sur une machine à 6 s par passe, ça ferait 12 à 18 s — un sous-titre qui n'a
plus aucun rapport avec l'image. Au-delà du plafond on réaffiche donc par paquets :
moins beau, mais lisible. Sur la machine de référence (2,2 s par passe, ~6,6 s de besoin
en stable) le plafond ne mord pas.

*Effet de bord agréable, mesuré : en mode provisoire, les mots déjà lus qui se réécrivent
sont passés de 4 à 1 sur le même flux — un mot qui attend son heure a le temps d'être
corrigé avant d'être affiché.*

⚠️ **Conséquence pour le retard du son (étape 3)** : l'âge du texte affiché n'est plus
celui que `offscreen.js` calibre. La calibration mesure l'âge du mot **à son arrivée** ;
l'écran, lui, ajoute maintenant le retard d'affichage. `retardCalibreFluxParMode` sous-
estime donc l'âge réel. À reprendre à l'étape 3 — qui prévoit de toute façon de mettre le
retard du son à zéro par défaut.


→ **Ce qui a changé** : la règle tient en une ligne — un mot s'affiche quand
`video.currentTime` atteint son instant. Plus de p90, plus de plafond, plus de file à
étaler. **Pourquoi** : voir le bandeau en tête de fichier.

✅ **Ce qui a SURVÉCU, et c'est le plus utile** : « le retard se cale sur le mot le plus
ANCIEN en attente, pas le plus frais » reste la bonne intuition, et les mesures
d'affichage par blocs qui en découlent tiennent toujours — mesuré le 30/08/2026 sur
Parakeet : **médiane 12 ms** entre l'instant d'un mot et son affichage.
## Mode « préparer d'abord » : trois défauts, une seule maladie (2026-08-28)

> ⚠️ **CETTE SECTION A ÉTÉ ÉCRITE SOUS WHISPER. Voici ce qu'il faut en garder — relu le
> 30/08/2026.** Le mode, lui, n'a pas changé : c'est le seul qui reste.
>
> ✅ **TOUJOURS EN PLACE, avec Parakeet** — points **2** (coupure au silence), **3** (la
> table des ancres : l'heure des mots lue sur la vidéo, pas calculée), **4** (l'overlay
> qui s'efface en fondu), **5 bis** (moyenne des deux canaux), **5 ter** (3 s de contexte
> audio avant chaque bloc), **6 bis** (blocs de 20 s) et **7**.
>
> ⛔ **RETIRÉ, ne pas remettre** — point **1** (le plafond de jetons `maxJetons`) et points
> **6 ter / 6 quater** (l'amorce `decoder_input_ids` et sa passe de secours). Ce sont des
> mécanismes de Whisper ; Parakeet n'a pas d'équivalent.
>
> ❓ **NON MESURÉ SUR PARAKEET** — points **5** (« sous 1,5 s le modèle invente ») et **6**
> (« sur du silence il écrit quand même »). Les garde-fous sont gardés par prudence.
>
> ⏳ **« blocs de 15 s » dans le paragraphe ci-dessous est dépassé** : `PREP_BLOC_CONTENU`
> est passé à **20 s** au point 6 bis, et n'a pas rebougé.

Le mode fait défiler la vidéo à x2 en silence, transcrit tout d'avance en blocs de 15 s,
puis affiche le stock à l'heure pendant la lecture normale. Trois symptômes ont été
rapportés — *l'overlay disparaît puis réapparaît d'un coup*, *des phrases entières
manquent*, *le texte est parfois faux*. **Ce sont trois façons de voir le même trou dans
le stock**, plus une désynchronisation qui s'y ajoute.

### ⏳ 1. `CONFIRMÉ` — 60 jetons coupent le français au bout de 13 s — SANS OBJET DEPUIS LE 30/08/2026

⛔ **`maxJetons` / `PREP_JETONS_PAR_S` ont été RETIRÉS du chemin Parakeet. Ne pas les
remettre.** `max_new_tokens` est un réglage de Whisper, qui écrit jeton par jeton
jusqu'à un quota. Parakeet est un **transducteur** : il émet au rythme des trames audio,
il n'a ni quota à atteindre ni quota à dépasser. Le défaut « bloc INCOMPLET — dernier mot
à 15,5 s sur 18,6 s » qu'il causait **a disparu avec lui**.

Le comptage jetons/mot ci-dessous reste une mesure juste sur le tokenizer de Whisper.


`whisper.worker.js` imposait `max_new_tokens = 60` à **tout le monde**. Cette valeur avait
été dimensionnée pour les segments de 7 s du mode direct ; la préparation, elle, envoie des
blocs de 15 s.

Mesure du 2026-08-28, tokenizer de `whisper-tiny` chargé en local :

| langue | mots | jetons | jetons/mot |
|---|---|---|---|
| français (documentaire) | 31 | 48 | **1,55** |
| français (conversation) | 33 | 51 | **1,55** |
| anglais (JFK) | 22 | 23 | 1,05 |

60 jetons valent donc **39 mots français**. Un bloc de 15 s ne tient sous ce plafond que si
on parle à **moins de 2,6 mots/s** — un documentaire est à ~3, une conversation à ~4. Au
delà, Whisper est coupé net **sans rien signaler** : le bloc rend un texte crédible qui
s'arrête au bout de 10 à 13 s, et les dernières secondes de *chaque* bloc n'ont aucun mot
dans le stock. C'est la source principale des trous.

Correctif : le plafond est un **paramètre du message `transcribe`** (`maxJetons`), borné à
400 côté worker. Le direct garde 60 ; la préparation demande `PREP_JETONS_PAR_S = 12`
jetons par seconde de contenu, soit 180 pour un bloc de 15 s (~7,7 mots français/s, le
double du débit le plus rapide). La protection anti-boucle ne repose plus sur le plafond
mais sur `no_repeat_ngram_size`, qui empêche la boucle de *commencer*.

*Ce qui prouverait que c'est faux* : des blocs qui, plafond levé, s'arrêtent toujours au
même endroit — ce serait Whisper qui renonce, pas le quota. Le détecteur de troncature de
`prepTraiterBloc` le dit maintenant à partir de 12 morceaux (au lieu de 30, seuil qui
n'avait de sens que sous l'ancien plafond).

### 2. `CONFIRMÉ` — la coupure des blocs tombait en plein mot

Contrairement au moteur en flux, **il n'y a aucun recouvrement** ici : chaque bloc est
transcrit une fois et jamais revu. Une coupure à l'échantillon près tombe donc là où elle
tombe — le plus souvent à l'intérieur d'un mot, qui est perdu deux fois (amputé à la fin
d'un bloc, amputé au début du suivant, où il donne en plus à whisper-tiny une attaque qui
ne ressemble à rien).

Correctif : `prepTailleJusquAuSilence` recule d'au plus **1,5 s de contenu** pour couper au
milieu de la tranche de 20 ms la moins bruyante. Le bloc est un peu plus court, jamais plus
long : rien n'est sauté, le reste part avec le bloc suivant.

Mesuré au banc (`banc-coupe.js`, bruit + un silence de 120 ms placé à un endroit connu) :

| silence à | coupure | résultat |
|---|---|---|
| −0,2 s | −0,15 s | dans le silence |
| −0,5 s | −0,45 s | dans le silence |
| −1,0 s | −0,95 s | dans le silence |
| −1,4 s | −1,35 s | dans le silence |
| −3,0 s | −0,93 s | hors de portée : coupure quelconque, comme avant |

⚠️ Le départage des ex æquo est `<=`, pas `<` : sur du silence pur toutes les tranches se
valent, et avec `<` le bloc se faisait raccourcir de 1,5 s **à chaque fois, pour rien**.

### 3. `CONFIRMÉ` — l'heure des mots était calculée, pas observée

L'instant d'un mot valait `positionDepart + échantillonsConsommés / taux × 2`. C'est de
l'arithmétique : elle suppose que la vidéo avance d'exactement deux secondes par seconde
d'horloge, du début à la fin. Un rechargement de tampon, une publicité, un lecteur qui
reprend une seconde la main sur la vitesse (`content.js` en accepte jusqu'à
`PREP_RECALAGES_MAX`), et la capture continue d'empiler du son pendant que `currentTime`
n'avance pas. **L'écart ne se rattrape jamais, il s'ajoute** — et du texte juste affiché au
mauvais moment se lit exactement comme une transcription fausse.

Correctif : `content.js` envoie la position réelle de la vidéo à **chaque battement**
(500 ms) ; `offscreen.js` garde la table `prepAncres` (« autant d'échantillons captés ↔ la
vidéo en était là ») et **interpole** l'heure de chaque mot dedans.

Mesuré au banc Node/vm (`banc-ancres.js`, capture simulée de 120 s, un calage de 6 s au
milieu — la vidéo s'arrête, la capture continue) :

| | avant | après |
|---|---|---|
| sans incident, écart max | 0,17 s | 0,17 s |
| calage 6 s — écart sur les **deux derniers** blocs | **12,17 s** | **0,06 s** |

12 s et pas 6 : pendant 6 s d'horloge la vidéo aurait avancé de 12 s de contenu. Avec
l'ancien calcul ce décalage restait jusqu'à la fin de la vidéo ; avec la table il a disparu
dès le bloc suivant. (Dans le bloc qui *contient* le calage, l'écart reste grand des deux
côtés : le silence du calage n'a de toute façon pas de mots à placer.)

Au passage : la position de départ du stock est maintenant relevée **après** `play()`
(`positionDepart`), pas avant (`position`, qui sert à rendre le lecteur tel qu'on l'a
trouvé). Les confondre datait tout le stock trop tôt du temps de démarrage du lecteur.

### 4. L'overlay qui disparaît : le symptôme, traité en symptôme

`BLOC_APRES_PAROLE` efface la boîte quand un sous-titre a fait son temps sans que le
suivant soit là. C'est **volontaire** — un sous-titre qui traîne pendant qu'on parle a l'air
de fonctionner, ce qui est pire qu'une absence. Mais deux choses le rendaient brutal :

- la valeur, **1,5 s**, avait été choisie contre des trous de 13,5 s dus au plafond de
  jetons (défaut 1). Ce plafond levé, les trous restants sont des respirations : la tenue
  passe à **3 s** ;
- l'effacement se faisait par `display: none`, qui **ne se transitionne pas** — la boîte
  disparaissait d'une image à l'autre, ce qui se lit comme une panne. Elle s'efface
  maintenant par l'**opacité**, avec un fondu de 220 ms posé sur la boîte (et
  `pointer-events: none`, pour qu'une boîte invisible n'intercepte pas les clics).

### 5. `CONFIRMÉ` (pour Whisper) — le dernier bloc était le seul dont personne ne choisissait la durée

⚠️ **« SOUS ~1,5 SECONDE, LE MODÈLE INVENTE » EST UNE PROPRIÉTÉ DE WHISPER — NON MESURÉ
SUR PARAKEET.** Le tableau ci-dessous a été relevé sur whisper-tiny fp32. Un transducteur
n'a aucune raison mécanique de se comporter pareil, mais **personne ne l'a vérifié**.
`PREP_RESERVE_FIN = 5` s est donc gardé par prudence, pas par mesure.


Symptôme rapporté : *des fautes qui apparaissent quand la vidéo approche de sa fin*.

Tous les blocs font 15 s **sauf le dernier** : lui, c'est ce qui reste quand la
vidéo s'arrête. Il pouvait donc faire 1 s. Et un bloc de la préparation n'a **aucun
contexte** — pas de recouvrement, chaque bloc est transcrit une fois, seul.

Mesure du 2026-08-28, vrai whisper-tiny fp32 sous Node (voir la mémoire
`whisper-reel-sous-node`), même extrait, on ne garde que la fin :

| reste seul | texte rendu | verdict |
|---|---|---|
| 0,5 s | « You » | inventé |
| 1,0 s | « God, free. » | inventé (vrai : « your country. ») |
| 1,5 s | « for your country. » | juste |
| 2,0 s | « can do for your country. » | juste |
| 3,0 s | « Ask what you can do for your country. » | juste |

La bascule est nette et basse : **sous ~1,5 s, le modèle fabrique une phrase
crédible sans rapport avec le son**. Et il ne s'agit pas d'un cas de bord rare —
banc Node/vm sur **401 durées de vidéo** (20 s à 220 s, pas de 0,5 s) :

| | avant | après |
|---|---|---|
| dernier bloc le plus court | **1,01 s** | **5,03 s** |
| vidéos dont la fin tombe sous 1,5 s | 13 / 401 (3,2 %) | 0 |
| vidéos dont la fin **n'est pas transcrite du tout** | 25 / 401 (6,2 %) | 0 |
| bloc le plus long | 15,0 s | 20,0 s (sans danger : Whisper complète à 30 s) |

Les 6,2 % sont l'autre moitié du défaut : sous `PREP_RESTE_MIN_CONTENU`, le reste
était **jeté en silence** — les derniers mots de la vidéo n'existaient nulle part.

Correctif : la pompe garde `PREP_RESERVE_FIN = 5` s de contenu en réserve et ne
coupe un bloc plein que s'il en reste au moins autant derrière lui. La fin de
vidéo part alors d'un seul bloc de 5 à 20 s. Coût : 5 s de contenu (2,5 s
d'horloge à x2) d'attente dans la file, et rien d'autre — la préparation tourne
plus vite que la vidéo.

⚠️ **Le corollaire dans `prepTraiterBloc`** : « bloc plein » ne veut plus dire
« taille == un bloc », mais « et il reste quelque chose derrière ». Sinon la
coupure au silence rendrait à la file un morceau de moins d'une seconde — soit
exactement le reste court qu'on vient d'interdire.

*Ce qui prouverait que c'est faux* : des fins de vidéo encore fausses alors que le
journal de l'offscreen montre un dernier bloc de 5 s ou plus. Ce serait alors la
qualité de whisper-tiny sur ce son-là, pas la durée du bloc.

### 6. `CONFIRMÉ` (pour Whisper) — sur du silence, Whisper écrit quand même

⚠️ **NON MESURÉ SUR PARAKEET.** `prepEstSilence` est gardé : il ne juge pas le texte
rendu, il constate qu'il n'y a rien à transcrire *avant* de demander — donc il ne peut
faire perdre aucun mot, quel que soit le modèle.


Même séance : sur du silence numérique pur, **quelle qu'en soit la durée** (1 s,
3 s, 10 s), whisper-tiny rend « you ». En français, c'est la phrase de générique
(« Sous-titres réalisés par… »). C'est un décodeur : il ne sait pas se taire. Une
vidéo qui se termine par un fondu au silence récoltait donc un mot inventé, posé
pile à la fin.

Correctif : `prepEstSilence` — un bloc sous **-80 dBFS en moyenne ET -50 dBFS en
crête** n'est pas envoyé à Whisper. `prepConsommes` avance quand même, donc la zone
reste couverte : elle ne porte simplement aucun mot. Banc : une vidéo de 40 s sans
aucun son donnait **40 mots inventés**, elle en donne **0**.

⚠️ **Ce n'est pas le filtre anti-hallucination que `prepTraiterBloc` s'interdit** :
on ne juge pas le texte rendu, on constate qu'il n'y a rien à transcrire *avant* de
demander. Aucun mot ne peut être perdu — s'il n'y a pas de son, il n'y a pas de mot.
Les seuils sont absurdes de sévérité exprès : de la parole très basse est 100 fois
au-dessus, une vidéo en pause rend exactement 0.

### 5 bis. `CONFIRMÉ` — on ne captait qu'un canal sur deux

Symptôme : *des fautes de transcription, partout, pas seulement à la fin*.

`preparation.worklet.js` lisait `entrees[0][0]` — le canal **gauche**, et lui seul.
La moitié du son de l'onglet partait à la poubelle, et **laquelle était tirée au
sort**. Or dans un mixage vidéo la voix est au centre (identique à gauche et à
droite) tandis que la musique et les effets sont étalés : prendre un seul canal
garde toute la musique de ce côté-là, alors que la moyenne (G+D)/2 garde toute la
voix et fait s'annuler en partie ce qui diffère entre les deux.

Mesure du 2026-08-28, vrai whisper-tiny fp32, extrait JFK + lit musical, deux
niveaux de musique, 44 mots de référence par ligne :

| mixage | canal gauche seul | moyenne (G+D)/2 |
|---|---|---|
| musique identique G/D (mono) | 19 fautes | 19 fautes |
| musique étalée (décorrélée) | 19 fautes | **4 fautes** |
| musique à gauche | 19 fautes | **4 fautes** |
| musique à droite | **0 faute** | 6 fautes |
| **total** | **57 / 176** | **33 / 176** |

Le rapport signal/bruit gagne jusqu'à **5,6 dB** — une mesure physique, pas une
opinion.

⚠️ **La quatrième ligne est le prix honnête** : quand la musique était justement du
côté qu'on ne prenait pas, on avait de la chance, et on la perd. Mais c'est bien de
la *chance* : le canal gauche est un tirage au sort, et sur les trois autres cas il
coûte 15 fautes de plus. La moyenne, elle, ne peut jamais être pire que le pire des
deux canaux.

Le worklet annonce désormais le nombre de canaux reçus (`🎚️ l'onglet arrive en N
canal(aux)`). **Si la console dit 1, ce correctif n'apporte rien sur cette page-là** —
et c'est ça qui prouverait qu'il ne sert à rien ici.

### 5 ter. `CONFIRMÉ` — chaque bloc était transcrit aveugle

Contrairement au moteur en flux, où chaque passe reprend la fenêtre depuis son
début, un bloc de la préparation n'avait **aucun contexte** : Whisper attaquait 15 s
de son sans rien savoir de la phrase en cours. On lui redonne les dernières
secondes du bloc précédent, **en audio** ; il transcrit l'ensemble, et seuls les
mots qui tombent après le contexte entrent au stock.

Combien de contexte ? Mesuré, 9 situations (3 niveaux de musique × 3 points de
coupe), 198 mots de référence :

| contexte | fautes | WER | temps du bloc |
|---|---|---|---|
| 0 s | 63 | 31,8 % | 1517 ms |
| 1 s | 58 | 29,3 % | +2 % |
| 2 s | 54 | 27,3 % | +2 % |
| **3 s** | **51** | **25,8 %** | **+4 %** |
| 4 s | 51 | 25,8 % | +5 % |
| 6 s | 54 | 27,3 % | +10 % |

Un cinquième des fautes en moins pour 4 % de temps — le surcoût est faible parce que
Whisper complète tout extrait à 30 s de toute façon. **Et ça ne monte pas
indéfiniment** : à 6 s c'est déjà moins bon qu'à 3.

⏳ **LE « +4 % » EST UN CHIFFRE WHISPER, ET SA RAISON N'EST PLUS VRAIE (noté le
30/08/2026).** Le surcoût était faible *parce que* Whisper complétait tout extrait à 30 s :
rallonger l'envoi de 3 s ne lui coûtait rien. **Parakeet est un transducteur — son coût
suit la durée réelle du son** (voir « Le flux »), donc cette raison-là est tombée. Ce que
coûtent réellement 3 s de contexte sur un bloc de 20 s avec Parakeet : **NON MESURÉ.**
Ce qui est gardé, c'est le **réglage** (3 s) et le constat de forme — le contexte soigne
les jointures, et à 6 s c'est déjà moins bon qu'à 3. Les fautes mesurées, elles, restent
vraies pour ce qu'elles mesuraient : whisper-tiny.

Sur la chaîne complète (offscreen.js réel + vrai whisper, piste de 46 s, blocs de
15 s), le gain est plus modeste parce qu'il n'y a que deux jointures : **27 → 24
fautes**, 0 doublon, 0 instant qui recule, aucun mot perdu. C'est logique — le
contexte soigne les *jointures*, et un bloc de 15 s en compte peu.

⚠️ **Deux pièges, tous deux traités** :
- `recollerMots` doit tourner sur **tout** l'extrait, contexte compris, *avant* le
  filtrage. Un « mot » de Whisper n'est pas un mot ; filtrer d'abord laisserait un
  début de mot orphelin au bord.
- le filtre par l'heure laisse passer un mot du contexte qui commence dans la marge.
  `prepOterDoublons` enlève les premiers mots neufs qui répètent la fin du stock —
  trois au plus, pour ne pas avaler une vraie répétition de la parole.

### ⏳ 5 quater. Ce qui a été essayé et ÉCARTÉ — MESURES WHISPER, conservées le 30/08/2026

⚠️ `num_beams` et `no_repeat_ngram_size` sont des options du pipeline de
**transformers.js**. Elles n'ont plus de chemin vers le moteur actuel. Les deux autres
lignes (normalisation du niveau, préparation à ×1) restent des leçons générales.


- `num_beams` (recherche par faisceaux) : **le pipeline de transformers.js 4.2.0
  l'ignore**. Texte rigoureusement identique à 3 et à 5 faisceaux, temps identique,
  alors que `max_new_tokens` passe bien par le même chemin. Ce n'est pas « le beam
  search n'aide pas » — c'est « cette option n'arrive pas au modèle ».
- `no_repeat_ngram_size` mis à 0 : **aucune différence** sur 88 mots à quatre
  niveaux de musique. Le garde-fou ne coûte pas de mots justes. On le garde.
- **Normalisation du niveau** : aucun gain. Un son ramené à 8 % de son niveau donne
  *moins* de fautes que le même son normalisé (20 contre 30 sur 88). Whisper
  normalise déjà ce qu'il faut ; y toucher est au mieux inutile.
- **Passer la préparation à x1** : l'aller-retour de rééchantillonnage à x2 ne coûte
  aucun mot dans la mesure (il en fait même gagner, par effet passe-bas). Rien à
  gagner à ralentir, donc `PREP_VITESSE = 2` reste.

### 6 bis. `CONFIRMÉ` — l'attente à la fin n'est pas le dernier bloc, c'est la dette

Journaux d'un run réel, temps par bloc de 15 s : **6,9 / 15,2 / 26,0 / 23,3 / 6,5 /
puis ~6,5 s**. Trois blocs quatre fois plus lents, puis retour à la normale.

À x2, la vidéo livre 15 s de contenu toutes les **7,5 s** d'horloge, et un bloc coûte
~6,15 s. La marge est donc de **1,35 s par bloc**. Le retard accumulé :

| bloc | coût | budget | dette cumulée |
|---|---|---|---|
| 1 | 6,9 s | 7,5 s | −0,6 s |
| 2 | 15,2 s | 7,5 s | **+7,1 s** |
| 3 | 26,0 s | 7,5 s | **+25,6 s** |
| 4 | 23,3 s | 7,5 s | **+41,4 s** |
| 5 à 10 | 6,5 s | 7,5 s | 35,4 s |

**41 s de dette, remboursée à 1 s par bloc : il faut 41 blocs, soit 10 minutes de
vidéo, pour revenir à zéro.** Sur toute vidéo plus courte que ça, la dette est encore
là à la fin — et se paie d'un coup, en ~30 s d'attente. C'est bien **un seul
problème**, pas deux : régler les blocs lents règle l'attente finale.

⚠️ **Et la vraie leçon est ailleurs** : une marge de 1,35 s sur 7,5 s ne pardonne
aucun incident. Le système n'avait aucune capacité de récupération. C'est ça qu'on
corrige, pas seulement l'incident.

⏳ **CE QUI SUIT REPOSE ENTIÈREMENT SUR UNE PROPRIÉTÉ DE WHISPER (noté le 30/08/2026).**
« L'encodeur coûte pareil pour 10 s ou 27 s » et « les 30 s sont un mur » sont vrais de
**Whisper**, qui complète tout extrait à 30 s. **Parakeet est un transducteur : il n'a ni
ce palier, ni ce mur.** À lire dans les deux sens :

- ⛔ **NE PLUS OPPOSER LE BUDGET DES 28 S** pour refuser d'agrandir le bloc.
  `PREP_BLOC_CONTENU + PREP_RESERVE_FIN + PREP_CONTEXTE` = 28 s n'est plus borné par un
  plafond à 30 s, et Parakeet ne coupe pas en silence à 30 s.
- ⬜ **Le gain de 1,20× entre 15 s et 20 s n'est pas transposable** : il venait du nombre
  d'*encodeurs* par minute de vidéo, pas de la durée du son. **NON MESURÉ sur Parakeet**,
  où un bloc deux fois plus gros coûte a priori deux fois plus cher à encoder.
- ✅ **`PREP_BLOC_CONTENU = 20 s` reste en place** — mais par continuité et par prudence,
  **pas** parce que la mesure ci-dessous le justifie encore.

Le tableau qui suit reste vrai pour ce qu'il mesurait : **whisper-tiny fp32**.

**Le levier : la taille du bloc.** Whisper complète tout extrait à 30 s, donc
l'*encodeur* coûte pareil pour 10 s ou 27 s de contenu. Un bloc deux fois plus gros,
c'est deux fois moins d'encodeurs par minute de vidéo. Mesuré (whisper-tiny fp32,
piste de 115 s, contexte de 3 s inclus, deux passages alternés) :

| bloc | débit | rapport à 15 s | reporté sur Chrome (2,44x à 15 s) | marge par bloc |
|---|---|---|---|---|
| 10 s | 6,77x | 0,75 | ~1,83x | négative |
| 15 s | 9,00x | 1,00 | 2,44x | 1,35 s |
| **20 s** | **10,80x** | **1,20** | **~2,93x** | **~3,2 s** |
| 25 s | 12,46x | 1,38 | ~3,38x | ~5,1 s |
| 27 s | 14,92x | 1,66 | ~4,05x | ~7,4 s |

`PREP_BLOC_CONTENU` passe donc de 15 à **20 s** : 20 % de débit en plus, et un retard
rattrapé **2,4 fois plus vite** (41 s effacés en 13 blocs au lieu de 41).

⚠️ **Pourquoi pas 27 s, qui serait encore mieux** : les 30 s sont un **mur**. Ce qu'on
envoie vaut au pire `PREP_BLOC_CONTENU + PREP_RESERVE_FIN + PREP_CONTEXTE` = 20 + 5 + 3
= **28 s**. À 25 s de bloc on serait à 33 s, et Whisper couperait les 3 dernières
secondes **sans rien dire**.

**La cause des blocs lents eux-mêmes reste ouverte** :
- `PROBABLE` — la page était occupée (rechargement de tampon, changement de qualité).
  Ce qui va dans ce sens : un bloc **entièrement muet** a été signalé dans la même
  zone, et une vidéo qui cale ne produit plus de son alors que la capture continue.
- `ÉCARTÉ` — la longueur du texte : 54 mots en 26 s contre 35 mots en 6,6 s, ça ne
  suit pas.

D'où l'instrumentation : chaque bloc journalise désormais `reech` (le
rééchantillonnage), `video +X s` (de combien la vidéo a **réellement** avancé pendant
ce bloc), `file` (ce qui attend derrière) et `retard` (la dette du tableau ci-dessus,
en direct). **Si `video +X s` est nettement inférieur à la durée du bloc, c'est le
lecteur qui a calé, pas Whisper.** Et à l'arrêt, deux lignes disent en clair si
l'attente finale vient de la dette ou du seul dernier bloc.

### ⏳ 6 ter. `CONFIRMÉ` — on peut souffler le vocabulaire de la page à Whisper — RETIRÉ LE 30/08/2026

⛔ **L'AMORCE A ÉTÉ RETIRÉE DU CHEMIN PARAKEET. Ne pas la remettre.** `decoder_input_ids`
est un mécanisme propre à Whisper, qui accepte un « contexte précédent » avant ses jetons
de départ. **Parakeet n'a pas d'équivalent** : son décodeur ne prend pas de préfixe
textuel. `content.js` relève encore le vocabulaire de la page et l'envoie (`prepAmorce`) —
il n'est simplement plus utilisé.

Conséquence directe : `prepEstBoucle`, qui n'existait que parce que l'amorce provoquait
des boucles, n'a plus de cause à traiter. Tout ce qui suit reste une mesure juste sur
Whisper.


Whisper accepte un « contexte précédent » : des jetons introduits par
`<|startofprev|>`, placés avant `<|startoftranscript|>`. Le modèle devient beaucoup
plus enclin à écrire les mots qu'il y a vus — c'est ce qui répare les noms propres
(« Emmanuel Macron », « Algérie ») que whisper-tiny écorche.

⚠️ **transformers.js 4.2.0 ne l'implémente pas sous son nom officiel.** Le champ
`prompt_ids` existe dans `WhisperGenerationConfig`, il est même documenté — et
`_retrieve_init_tokens` ne le lit **jamais**. Le passer ne fait rien, exactement comme
`num_beams`. Ce qui marche : **`decoder_input_ids`**, que `generate` prend à la place
des jetons de départ qu'il aurait construits. On construit donc la séquence à la main.

Mesure (extrait JFK + musique, 5 niveaux, 110 mots de référence) :

| | fautes |
|---|---|
| sans amorce | 39 |
| amorce « titre de la vidéo » | **16** |
| amorce **hors sujet** (recettes de cuisine) | **20** |

⚠️ **Lire la troisième ligne.** Une amorce qui parle de cuisine répare presque autant
qu'une amorce juste. L'essentiel du gain ne vient donc **pas** du vocabulaire : il
vient du fait qu'il y ait une amorce du tout, qui change le régime de décodage. Le
vocabulaire vaut les 4 fautes entre 20 et 16 — le quart du gain. C'est réel, et il ne
faut pas raconter l'inverse.

**D'où vient la liste, et pourquoi c'est 100 % local** : `content.js` relève le titre,
le nom de la chaîne et les noms propres de la description — du texte **déjà affiché
dans l'onglet**. Aucune requête, aucune API. Liens, hashtags et chapitrage sont
retirés ; 300 caractères au plus, recoupés à 100 jetons par le worker.

⚠️ **LE PRIX, MESURÉ AUSSI, ET IL EST LOURD** : sur du son **sans parole**, l'amorce
multiplie les mots inventés par **dix** :

| condition | sans amorce | avec amorce |
|---|---|---|
| silence 3 s | 1 mot | **26 mots** |
| silence 15 s | 1 mot | **29 mots** |
| musique 0,2 / 10 s | 1 | 1 |
| musique 0,4 / 10 s | 2 | 1 |
| musique 0,6 / 15 s | 2 | **18 mots** |
| **total** | **7** | **75** |

Et la forme est toujours la même : une **boucle** (« The United States, the United
States, the United… »). Le bloc muet est déjà écarté par `prepEstSilence` ; la boucle,
elle, arrive sur de la musique forte, qui n'est pas du silence. D'où
**`prepEstBoucle`** : un texte dont moins de **35 %** des mots sont distincts est jeté.
Mesuré sur de vraies sorties — boucles à 0,22 / 0,25 / 0,26, vraies phrases à 0,64 /
0,91 / 0,97. Le seuil est à mi-chemin, loin des deux.

⚠️ **C'est le seul endroit du fichier où du texte est jeté**, et c'est une exception
assumée à la règle « aucun filtre anti-hallucination » : on ne l'ajoute que parce
qu'on vient d'ajouter la cause. Sans amorce, il ne se déclenche jamais.

### ⏳ 6 quater. `CONFIRMÉ` — l'amorce faisait RENONCER Whisper — SANS OBJET DEPUIS LE 30/08/2026

⛔ L'amorce étant retirée (voir 6 ter), la **passe de secours** qui la rattrapait
(`PREP_COUVERTURE_SECOURS`) n'a plus d'objet non plus.

✅ **MAIS LA LEÇON DE MÉTHODE, ELLE, EST LA PLUS CHÈRE DU FICHIER — ELLE S'APPLIQUE
TOUJOURS** : un gain mesuré sur un extrait court ne dit rien de ce qui arrive sur un bloc
long et difficile. C'est la deuxième fois que ce piège s'est refermé sur ce projet.


⚠️ **LE CHIFFRE DE 39 → 16 FAUTES CI-DESSUS A ÉTÉ MESURÉ SUR LA MAUVAISE CONDITION,
ET LA SUITE LE PROUVE.** Il portait sur des extraits de 11 s d'une seule phrase.
Rejoué sur la vraie chaîne — piste de 115 s, blocs de 20 s, musique forte — l'amorce
fait l'inverse :

| musique 0,45 | mots | fautes | trous > 3 s | pire trou | écran vide |
|---|---|---|---|---|---|
| sans amorce | 228 | 45 | **0** | 0 s | 0 s |
| avec amorce | 190 | 63 | **3** | **9,4 s** | **11,0 s** |

Et le journal dit pourquoi : *« bloc 4 INCOMPLET — dernier mot à 10,5 s sur 19,9 s
(53 % couvert) »*. Whisper ne part pas en boucle : **il renonce en plein bloc**. La
seconde moitié n'a alors aucun mot — et comme un bloc fait 20 s, le trou dépasse
largement les 3 s au bout desquelles `content.js` efface la boîte.

**C'est exactement le symptôme rapporté : « l'overlay a redisparu à plusieurs
reprises ».** Deux changements se sont additionnés : l'amorce a créé les trous, les
blocs de 20 s les ont rendus deux fois plus visibles.

⚠️ **Et cette leçon était DÉJÀ écrite dans ce fichier, pour q8** : « ne jamais valider
une variante sur le seul chargement : toujours lire la sortie, et sur des fragments
courts, pas seulement sur un extrait propre ». Il fallait la lire dans l'autre sens
aussi — **un gain mesuré sur un extrait court ne dit rien de ce qui arrive sur un bloc
long et difficile**. C'est la deuxième fois que ce piège se referme sur ce projet.

**Le correctif — la passe de secours.** On ne renonce pas à l'amorce, on l'empêche de
nuire : quand un bloc revient tronqué (couverture < `PREP_COUVERTURE_SECOURS` = 80 %)
ou en boucle **alors qu'on avait mis une amorce**, on refait le même bloc **sans
elle**, et on garde la meilleure des deux passes. L'amorce ne peut plus que gagner ;
au pire elle coûte une inférence de plus sur les blocs difficiles.

| musique 0,45, après correctif | mots | fautes | trous > 3 s | écran vide | passes de secours |
|---|---|---|---|---|---|
| sans amorce | 228 | 45 | 0 | 0 s | — |
| avec amorce | **229** | **43** | **0** | **0 s** | 2 blocs sur 6 |

L'amorce redevient un gain net (43 contre 45) au lieu d'un désastre (63), et il n'y a
plus un seul trou.

**La mesure du symptôme, désormais journalisée à chaque fin de préparation** :

```
🕳️ Preparation : N trou(s) de plus de 3 s dans le stock, le pire X s,
   Y s d'ecran vide au total. (secours N, boucles N, tronques N)
```

C'est le seul chiffre qui dit si « l'overlay disparaît » est réglé, et il ne dépend
d'aucune théorie sur la cause. **Si `secours` est élevé, l'amorce gêne plus qu'elle
n'aide sur cette vidéo-là** — c'est le signal pour la couper.

### 7. Ce qui reste ouvert sur la fin de vidéo

- `HYPOTHÈSE` — **le silence capté après la pause du lecteur étire le dernier bloc.**
  `prepSurFin` met la vidéo en pause, puis l'offscreen enregistre encore ~0,3 s
  (aller-retour du message + les 250 ms d'attente du worklet). Ce silence entre dans
  le dernier bloc, mais `prepPositionDe` l'extrapole comme si la vidéo avait avancé
  pendant ce temps — donc `echelle` peut monter à ~1,1 sur un bloc de 5 s, soit
  jusqu'à 0,5 s de retard sur les tout derniers mots. Non mesuré. Ce qui le
  trancherait : comparer l'instant du dernier mot du stock à sa position réelle dans
  la vidéo.
- `PREP_MARGE_FIN = 0,35` s de content.js : les 0,35 dernières secondes de la vidéo
  ne sont jamais captées. Voulu, mais c'est bien du son jamais transcrit.

⚠️ Si l'écran continue de se vider souvent après tout ça, **ce n'est plus l'affichage** :
c'est qu'il reste des trous dans le stock. `PREPARATION_BLOCS` rend `ecranVideS` — le temps
total sans aucun sous-titre — et c'est cette mesure-là qu'il faut regarder, pas l'écran.

## Contraintes techniques connues
- ⚠️ **`chrome.storage` est indisponible dans un document offscreen.** Vérifié dans
  Chrome : `typeof chrome === "object"` mais `typeof chrome.storage === "undefined"`.
  Tout ce qui touche au storage passe donc par le service worker — c'est déjà le cas du
  backend, de la langue et du retard, et ça vaut aussi pour le mode d'affichage.

  **Ce que ça coûte quand on l'oublie** (arrivé une fois, à ne pas refaire) : un
  `chrome.storage.onChanged.addListener` ajouté dans `offscreen.js` lève un `TypeError`
  **au chargement**. Le fichier meurt à cette ligne : tout ce qui suit n'est jamais évalué,
  et les `let` déclarés plus bas restent en zone morte. Le listener de messages, lui, était
  déjà enregistré — donc `START_CAPTURE` arrive, `startCapture` rejette, et comme la
  réponse était branchée en `.then(sendResponse)` **sans `.catch`**, `sendResponse` n'est
  jamais appelé. Le service worker attend sa réponse indéfiniment, la popup reste sur
  « Démarrage… », et **rien n'apparaît nulle part** : ni erreur, ni échec, ni délai. Le
  bouton Démarrer ne répond plus.

  D'où deux règles : *(1)* l'offscreen ne touche jamais `chrome.storage` ; *(2)* tout
  `return true` dans un `onMessage` doit avoir un `.catch` qui répond — sinon la moindre
  erreur devient un blocage muet.
- CSP MV3 : `wasm-unsafe-eval` requis pour le WASM ; les workers `blob:` sont bloqués
  → `proxy = false`.
- ⚠️ **`numThreads = 1` N'EST PLUS UNE FATALITÉ — ET C'EST UNE QUESTION OUVERTE, PAS UN
  ACQUIS.** Il était écrit ici que « la CSP de MV3 bloque le multithread ». **C'est faux.**
  Mesuré le 30/08/2026 : **4 fils ont fonctionné dans une page d'extension**,
  `SharedArrayBuffer` était disponible, et le gain était de **2,4×**.

  ❓ **CE QUI N'EST PAS VÉRIFIÉ : le document offscreen.** Toute la production tourne là,
  et une page d'extension n'est pas un document offscreen — l'isolation d'origine croisée
  peut y différer. Tant que ce n'est pas mesuré **dans l'offscreen**, on reste à
  `numThreads = 1` en production. Ce qui trancherait : lire `crossOriginIsolated` et
  `typeof SharedArrayBuffer` depuis `offscreen.js`, puis chronométrer 1 fil contre 4 sur
  le même bloc.
- **Parakeet : les poids `int8` du dépôt `ysdede/parakeet-tdt-0.6b-v3-onnx`**, exécutés
  sur le CPU (`executionProviders: ["wasm"]`). Pas de choix de dtype à faire : le dépôt
  publie l'export int8 et c'est celui qu'on prend. 640 Mo pour les 5 fichiers.

  ⚠️ **« 640 Mo » et « 652 Mo » ne se contredisent PAS — ce ne sont ni les mêmes fichiers
  ni la même unité**, et le fichier ne le disait nulle part. Tailles exactes, lues dans
  `scripts/fetch-model.js` : encodeur **652 183 999 o**, décodeur/joint **18 202 004 o**,
  `nemo128.onnx` **137 641 o**, `vocab.txt` **102 132 o**, `config.json` **101 o** —
  **total 670 625 877 o**. Soit **640 Mio pour les cinq** (l'unité du script, `/1024/1024`)
  et **622 Mio pour le seul encodeur** — que les sections plus bas appellent « 652 » en
  comptant ses octets en méga **décimaux**. Aucun des deux chiffres n'est faux ; ils ne
  répondent pas à la même question.
- ⏳ **VRAI JUSQU'AU 30/08/2026 — le choix de dtype de Whisper.** Whisper : `dtype: "fp32"`,
  **sur les deux backends**. Choix mesuré, pas par défaut — voir le long commentaire dans
  `whisper.worker.js` *(fichier supprimé)*. En résumé :
  - Si un export quantifié refuse de charger (`Missing required scale ... MatMulNBits`
    pour q8, `SimplifiedLayerNormFusion` pour fp16), **ce ne sont pas les poids** : ce
    sont des passes de fusion de niveau `extended` d'ONNX Runtime. Avec
    `session_options: { graphOptimizationLevel: "basic" }`, les deux chargent et
    transcrivent.
  - q8 marche donc (42 Mo au lieu de 147, ~18 % plus rapide) mais **dégrade le texte**
    en conditions réelles : « What **you are** country » au lieu de « What **your**
    country », « as what » au lieu de « ask what ». Comme la latence est déjà stable
    en fp32, ces 18 % n'achètent rien. Écarté.
  - fp16 sur CPU est 1,3 à 1,4× **plus lent** que fp32 (pas d'unité fp16 native).
  - En WebGPU, `fp16` / `q4f16` **chargent mais produisent du texte cassé** (boucles de
    répétition « Je ne m'aime pas. Je ne m'aime pas… »). Ne jamais valider une variante
    sur le seul chargement : toujours lire la sortie, et sur des fragments courts, pas
    seulement sur un extrait propre (q8 donne 0 % de WER sur extrait propre et se
    dégrade quand même en production).
  - Piste si le poids devient critique (modèle embarqué) : **whisper-base en q8**, 77 Mo,
    soit moins que tiny fp32, et moins sujet aux hallucinations. À mesurer.
- ⏳ **VRAI JUSQU'AU 30/08/2026** — WebGPU (ONNX Runtime 1.26) passe par la variante WASM
  `asyncify` (ou `jspi`), **pas** par `jsep` comme dans les versions 1.19–1.21. Les 4
  variantes sont copiées dans `vendor/`, laisser comme ça.
  → **Ce qui a changé** : `vendor/` ne sert plus au moteur de production. Le worker
  Parakeet charge ONNX Runtime depuis
  `node_modules/parakeet.js/node_modules/onnxruntime-web/dist/`, et **n'active jamais
  WebGPU** — voir « WebGPU : plus lent, ET il ne rend pas le même texte ».
- `chrome.*` est **indisponible dans un worker dédié** : dériver les URL de
  `self.location`, et laisser la page faire ce qui touche à `chrome.storage`.
- ⚠️ **Une réponse `chrome-extension://` ne porte PAS de `content-length`.** Mesuré le
  30/08/2026 sur les 5 fichiers du modèle : ses en-têtes sont `cache-control`,
  `content-security-policy`, `content-type`, `etag`, `last-modified` — et rien d'autre. Un
  contrôle de taille fondé sur `content-length` aurait donc trouvé **tous les fichiers
  vides, tout le temps**.

  **La parade, et elle est bon marché** : lire **un seul morceau** du corps. Sur
  l'encodeur de **652 Mo, le premier `read()` rend 1 024 octets en 2,8 ms** — puis on
  annule le flux, le reste n'est jamais lu. Un fichier absent ne rend pas un 404 : `fetch`
  **rejette** (`TypeError: Failed to fetch`, ~1 ms). Un fichier vide répond `ok` et son
  premier `read()` rend `done` immédiatement.
- Le service worker est éphémère : toujours re-vérifier l'état réel via
  `chrome.offscreen.hasDocument()` et `chrome.storage.session`.

## Comment tester
Recharger l'extension (`chrome://extensions` → 🔄) puis la page (F5). Console du
service worker : « Inspecter les vues → service worker ». Console de la capture :
« Inspecter les vues → **offscreen.html** ». Test du moteur isolé : ouvrir
`chrome-extension://<ID>/test-parakeet-worker.html`. (Voir la skill `tester-extension`.)
⏳ *`test-whisper.html` existe encore mais ne mesure plus le moteur de production.*

⚠️ **UNE SÉANCE DE MESURE S'USE QUATRE FOIS PLUS VITE QU'AVANT.** Un worker Whisper
pesait 147 Mo ; un worker Parakeet en pèse **652**, et occupe **~1 335 Mo** de mémoire
WebAssembly. Là où on tenait une vingtaine de configurations dans une séance, on en tient
**trois ou quatre**.

⛔ **Conséquence pratique, à respecter** : prévoir 3 ou 4 configurations par série, pas 20,
et **redémarrer le navigateur entre deux séries**. Recharger la page ne suffit pas — c'est
la machine entière qui est descendue (voir le témoin ci-dessous).

**Sans Chrome** : `offscreen.js` et `content.js` se chargent tels quels dans un contexte
`vm` de Node avec des bouchons (`chrome`, `Worker`, DOM, `Date.now`), ce qui permet de
jouer une piste de parole simulée trame par trame sur une horloge virtuelle et de mesurer
le moteur pour de vrai — dérive de latence, ruban qui recule, mots perdus, demi-mots
figés, mots révélés un par un. Voir la mémoire `banc-essai-node-vm`. Ça ne remplace pas
Chrome pour la latence réelle, la qualité du texte, le VAD et WebGPU.

⚠️ **Une séance de mesure s'use, et le témoin le prouve.** Après une vingtaine de workers
instanciés (147 Mo de poids chacun), le même fragment passe de **2,1 s à 7,7 s** — y
compris pour la variante *sans* la fonctionnalité mesurée. Recharger la page ne répare
rien : c'est la machine entière qui est descendue. C'est comme ça qu'un surcoût
d'horodatage a été mesuré à **+71 %** puis à **+19 %** sur exactement le même audio. Donc :
ne jamais comparer deux chiffres absolus pris à des moments différents ; faire tourner les
deux variantes **alternées fragment par fragment** et ne conclure que sur le **rapport**.
Si le témoin lui-même a dérivé, la séance est finie — redémarrer avant de mesurer autre
chose.

⚠️ **Un banc Node ne prouve rien sur ce que le navigateur rend disponible.** Le bouchon
`chrome` du banc est écrit à la main : s'il offre `chrome.storage` à `offscreen.js`, le
banc passe au vert sur du code que Chrome refuse. C'est exactement comme ça que le bug
ci-dessus est passé. Les bouchons doivent **ressembler à la réalité, pas la rendre
confortable** — celui de l'offscreen n'a donc plus de `chrome.storage` du tout. Et toute
modif qui touche au démarrage se vérifie **dans Chrome, popup réel ouvert**, pas seulement
au banc.

⏳ **VRAI JUSQU'AU 30/08/2026 — le banc en deux temps.** *(Le message `FLUX` et les deux
modes ont disparu avec le direct ; le principe « rejouer le même enregistrement dans deux
instances pour que la comparaison soit honnête » reste, lui, la bonne méthode.)*

Le banc le plus utile est celui **en deux temps** : on fait tourner le moteur une fois, on
enregistre la suite exacte des messages `FLUX`, puis on la **rejoue dans deux instances de
`content.js`** — une par mode. Les deux modes voient alors rigoureusement le même flux, ce
qui rend la comparaison honnête (mots réécrits, mots perdus, âge du son). C'est comme ça
que le tableau des deux modes plus haut a été obtenu, et c'est là qu'on injecte une
bascule de la case en plein milieu du run pour vérifier qu'elle ne perd ni mot ni image.

## Avancement

### Depuis le 30/08/2026 — changement de moteur
- ✅ **Parakeet TDT 0.6B v3 remplace whisper-tiny.** 1 faute sur 2 493 mots contre 29,
  RTF 0,283 contre 0,31, médiane mot prononcé → affiché **12 ms**, 0 requête externe.
- ✅ **Mode direct supprimé**, et le sélecteur de langue avec lui (Parakeet détecte seul,
  25 langues européennes).
- ✅ **Installation livrable** : `npm run fetch-model` (5 fichiers, tailles exactes
  vérifiées, progression qui ne recule jamais) et `README.md` avec l'attribution NVIDIA.
- ✅ **Modèle manquant : message clair au lieu d'une barre infinie**, en moins de 700 ms.
- ⬜ **Multithread WASM dans l'OFFSCREEN : question ouverte.** 4 fils ont marché dans une
  page d'extension (×2,4), **jamais vérifié dans le document offscreen**.
- ⬜ **Fin de vidéo courte et silence : NON MESURÉ sur Parakeet.** Les garde-fous hérités
  de Whisper (`PREP_RESERVE_FIN`, `prepEstSilence`) sont gardés par prudence.
- ⬜ Traduction, personnalisation de l'overlay, historique/export.

### Avant le 30/08/2026 — l'ère Whisper *(conservé)*
- ✅ Structure de l'extension (popup, overlay, messages).
- ✅ Capture audio de l'onglet + VAD (segments de parole), avec état popup robuste.
- ✅ Whisper dans un Web Worker (la page ne fige plus) + choix mesuré du backend
  GPU/CPU, mémorisé.
- ✅ Segments du VAD branchés au worker puis à l'overlay : la chaîne complète tourne.
- ✅ Découpage réglé (7 s / plancher 3 s / recouvrement) : latence stable au lieu de
  dériver jusqu'à 32 s, et plus d'hallucinations.
- ✅ **Mode flux** : fenêtre re-transcrite + LocalAgreement-2 + une seule inférence en vol,
  overlay qui révèle les mots un par un sur deux lignes. Les sous-titres s'écrivent au fil
  de la parole. Voir « Le flux » plus haut.
- ✅ **Option « texte stable seulement »** (défaut) : plus rien ne se réécrit sous les yeux,
  bascule à chaud pour comparer. Retard du son calibré par mode. Voir les deux sections
  dédiées plus haut.
- ✅ **Étape 0 — chiffrer avant de s'engager** : coût des horodatages (+20 %, sous le seuil
  de renoncement de 40 %), absence de dérive sur 14 passes, justesse des instants sous
  musique (20 ms à −1,8 dB). Page `test-bruit.html`.
- ✅ **Étape 1 — les instants voyagent** : worker → offscreen → service worker → `FLUX`.
  Chaque mot porte l'heure à laquelle il a été prononcé. Voir « Les instants » plus haut.
- ✅ **Étape 2 — `content.js` affiche à l'heure** : `PAS_REVELATION` et `RETARD_MAX_MOTS`
  ont disparu, les mots sortent un par un au rythme réel, les pauses redeviennent des
  pauses. Voir « L'horloge des mots » plus haut.
- ✅ **Mode « préparer d'abord » — les trois trous bouchés** : plafond de jetons dimensionné
  sur le bloc, coupure au silence, heure des mots lue sur la vidéo au lieu d'être calculée.
  Voir la section dédiée plus haut. ⚠️ Validé **au banc Node/vm uniquement** — la coupure au
  silence et le plafond de jetons demandent une vérification sur du son réel dans Chrome
  (couverture par bloc, `ecranVideS`).
- ✅ **Moins de fautes, sans changer de modèle** : les deux canaux de l'onglet au lieu
  d'un seul (jusqu'à 5,6 dB de rapport signal/bruit gagnés, 57 → 33 fautes sur le banc)
  et 3 s de contexte audio avant chaque bloc (−19 % de fautes en isolé, 27 → 24 sur la
  chaîne complète, +4 % de temps). Quatre autres pistes mesurées et écartées. Voir les
  points 5 bis à 5 quater. ⚠️ **À vérifier dans Chrome** : la console de l'offscreen doit
  annoncer `🎚️ l'onglet arrive en 2 canal(aux)` — si elle dit 1, le premier correctif
  n'apporte rien sur cette page.
- ✅ **Fin de vidéo — les fautes de la dernière minute** : le dernier bloc ne peut plus
  être court (`PREP_RESERVE_FIN`), et un bloc sans le moindre son n'est plus envoyé à
  Whisper. Mesuré sur le vrai whisper-tiny (sous 1,5 s il invente ; sur du silence il
  écrit « you ») et au banc sur 401 durées de vidéo. Voir les points 5 et 6 de la
  section « préparer d'abord ». ⚠️ **Pas encore vérifié dans Chrome sur une vraie
  vidéo** : le journal de l'offscreen doit montrer un dernier bloc ≥ 5 s.
- ✅ **Blocs de 20 s + instrumentation du retard** : la préparation récupère 2,4 fois
  plus vite après un incident, et chaque bloc dit en clair si c'est le lecteur ou
  Whisper qui a traîné. Voir le point 6 bis.
- ✅ **Vocabulaire de la page soufflé à Whisper** (`decoder_input_ids`, pas
  `prompt_ids` qui est mort dans transformers.js), **avec sa passe de secours** : sans
  elle, l'amorce faisait renoncer Whisper en plein bloc et revidait l'overlay (3 trous,
  9,4 s le pire). Avec, 0 trou et un gain net. Voir les points 6 ter et 6 quater.
  ⚠️ **Une seule chose à regarder dans Chrome** : la ligne `🕳️` de fin de préparation.
- ⬜ **La cause des blocs 4x plus lents** : instrumentée, pas encore élucidée. Le
  prochain run tranche avec `video +X s` et `reech`.
- ⬜ **Étape 3 — retard du son à zéro par défaut** : garder les lèvres synchrones et
  laisser le texte suivre à ~2-3 s, comme les sous-titres du direct à la télé. L'option
  « Auto » reste pour qui préfère l'inverse.
- ⬜ Traduction, personnalisation de l'overlay, historique/export, hors-ligne complet
  (bundler le modèle).
- ⬜ **Qualité du texte sur son BRUITÉ** — le reproche qui reste. whisper-base a été écarté
  sur une mesure faite sur du son *propre* (WER 0 %, donc aucun gain à espérer), mais le
  problème se pose sur du son bruité (documentaire avec musique : « lourire » pour
  « nourrir »). Cette condition n'a jamais été mesurée : la décision a été prise sur les
  mauvaises données. À reprendre — tiny/base/small × trois niveaux de musique.
- ⏳ **CORRIGÉ LE 30/08/2026** — le texte d'origine disait : « Pistes de latence non
  explorées : multithread WASM (on est à `numThreads = 1` à cause des workers `blob:`
  bloqués par la CSP — 2 à 3× à gagner si on débloque). Ça se verrait directement : moins
  de temps par passe = mots révélés plus tôt. »
  → **Ce qui a changé** : **la CSP ne bloque pas le multithread.** 4 fils ont tourné dans
  une page d'extension, `SharedArrayBuffer` disponible, **×2,4**. L'estimation « 2 à 3× »
  était donc juste ; c'est la cause invoquée qui était fausse.
  ❓ **Reste ouvert** : rien de tout cela n'a été vérifié **dans le document offscreen**,
  qui est le seul endroit qui compte pour la production. Voir « Contraintes techniques
  connues ».

## Débogage — les trois consoles

Une extension MV3 n'a pas une console mais TROIS, et elles ne se voient pas entre elles :

| console          | ce qui s'y écrit                                    |
|------------------|-----------------------------------------------------|
| l'onglet         | `content.js` (l'overlay)                            |
| service worker   | `background.js`                                     |
| offscreen.html   | `offscreen.js`, le VAD, Whisper, la capture         |

⚠️ **Le document offscreen n'apparaît PAS comme cible DevTools** dans une session pilotée.
C'est pourtant là que vivent les erreurs les plus graves — celle de `chrome.storage` avait
tout cassé en silence. Ses messages importants doivent donc remonter au service worker,
préfixés `[OFFSCREEN]`. Côté humain, il reste inspectable à la main :
chrome://extensions → « Inspecter les vues : offscreen.html ».

**RÈGLE : ne jamais dire « aucune erreur » sans préciser sur quelle cible on était
branché.** Une console propre ne prouve rien sur les deux autres.

Et sur chrome://extensions, le bouton « Erreurs » n'apparaît que si le **mode développeur**
est activé. Sans lui, une absence d'erreur ne prouve rien du tout.

## Quand quelque chose casse — la forme de réponse attendue

1. **LA CAUSE, pas le symptôme.** « Ça ne s'affiche pas » n'est pas une cause ; « le
   message n'arrive jamais parce que le relais reconstruit l'objet et jette les champs
   ajoutés » en est une.

2. **Les solutions possibles, classées par niveau de confiance :**
   - `CONFIRMÉ` — j'ai la preuve, la voici
   - `PROBABLE` — cohérent avec les faits, voici lesquels
   - `HYPOTHÈSE` — je n'ai rien pour trancher

3. **Pour chacune : qu'est-ce qui prouverait qu'elle est FAUSSE ?**

⛔ **Pas de pourcentage inventé.** « 80 % de chances » sans mesure est une fausse
précision, et c'est pire que « je ne sais pas ».

⚠️ **Une barre de progression n'est pas une preuve de travail.** Elle ne prouve que
l'écoulement du temps. Vécu : la pompe de transcription se tuait elle-même (le `finally`
d'une fonction `async` s'exécutait avant l'affectation de la promesse), plus aucun bloc
n'était transcrit — et la barre avançait normalement jusqu'au bout.
