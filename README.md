# LiveSub

**Une extension Chrome qui sous-titre et traduit les vidéos de n'importe quel site,
100 % en local : le son ne quitte jamais votre ordinateur.**

## Ce que ça fait

- **Sous-titre la vidéo de l'onglet** : YouTube, un cours en ligne, un site d'actualité…
  tout ce qui a une balise `<video>`.
- **Traduit les sous-titres** vers 37 langues : la phrase d'origine reste affichée,
  sa traduction s'affiche juste en dessous.
- **Affiche chaque phrase à l'heure exacte** où elle est prononcée, même après une
  pause ou un retour en arrière.
- **Reconnaît seul la langue parlée** parmi 25 langues européennes.
- **Garde en mémoire** les vidéos déjà préparées : la deuxième fois, pas d'attente.
- **Ne dépend d'aucun service en ligne** : ni API de transcription, ni serveur, ni compte.

## Comment ça marche

1. **Capture** : l'extension écoute le son de l'onglet (API `tabCapture` de Chrome).
2. **Préparation en accéléré** : la vidéo défile à ×2, en silence, pendant que le son
   est découpé en blocs de 20 s.
3. **Transcription** : chaque bloc est transcrit par le modèle **NVIDIA Parakeet**,
   qui tourne dans un Web Worker (la page ne fige jamais), sur le processeur.
4. **Un instant par mot** : le modèle donne l'heure de chaque mot. Les heures sont
   recalées sur la position réelle de la vidéo, même si elle a calé pendant la préparation.
5. **Affichage synchronisé** : à la fin, la vidéo revient où elle était. Pendant la
   lecture, chaque phrase apparaît quand la vidéo atteint l'heure de son premier mot.
6. **Traduction par phrase** : le texte est découpé en phrases, traduites par l'API
   Translator intégrée à Chrome. Chaque phrase traduite reprend l'heure de début et de
   fin de la phrase d'origine.

```
onglet ──son──▶ document offscreen ──blocs de 20 s──▶ Web Worker (Parakeet, ONNX/WASM, 4 fils)
                       │                                        │
                       │◀──────────── mots + instants ──────────┘
                       ├──▶ API Translator de Chrome (phrase par phrase)
                       ▼
               service worker ──stock complet──▶ script de la page (affichage à l'heure)
```

## Les chiffres

Tous ces chiffres ont été **mesurés**, pas estimés. Les relevés bruts sont dans
[`docs/mesures/`](docs/mesures/) et les pages qui les ont produits dans [`bancs/`](bancs/).
Machine de mesure : Windows 11, processeur à 12 fils, GPU intégré Intel Iris Xe,
Chrome 151.

| Mesure | Résultat |
|---|---|
| Fautes de transcription sur une vidéo française de 17 min (2 493 mots) | **1** avec Parakeet, contre **29** avec Whisper (l'ancien moteur) |
| Écart entre le mot prononcé et le mot affiché | **12 ms** (médiane) |
| Écart entre la phrase prononcée et sa traduction affichée | **7 à 8 ms** (médiane) |
| Gain du calcul sur 4 fils au lieu d'un | **×1,95** : de ~0,28 à ~0,14 s de calcul par seconde de son, texte rigoureusement identique |
| Coût de la traduction sur une préparation de 119 s | **+0,3 à +0,5 s** |
| Traduction de 2 493 mots | **2,1 s** |
| Requêtes vers l'extérieur pendant l'utilisation | **0** (paquet de langue déjà installé) |
| Mémoire du moteur pendant la préparation | **~1,3 Go**, rendus dès la préparation finie |

## Choix techniques

**Parakeet plutôt que Whisper.** Le projet a commencé avec Whisper (version *tiny*).
Le critère décisif n'était pas la vitesse mais **l'heure de chaque mot** : sans elle,
impossible d'afficher le texte au bon moment. Parakeet la fournit aussi, avec 29 fois
moins de fautes sur le même texte, pour une vitesse comparable. Le prix à payer : il ne
reconnaît que 25 langues européennes. L'arabe, le chinois, le japonais et le turc, que
Whisper transcrivait, sont perdus.

**Pas de WebGPU.** Sur un GPU intégré, le calcul sur la carte graphique s'est révélé
2,2 fois **plus lent** que sur le processeur. Surtout, il rendait **un texte faux**
(« d'étoil » au lieu de « d'étoiles »), sans le moindre message d'erreur. Le moteur
charge donc une version d'ONNX Runtime qui ne contient pas WebGPU : il ne peut pas
s'activer par accident.

**Préparer d'abord plutôt que transcrire en direct.** Une première version transcrivait
au fil de la parole. Elle a montré qu'on ne peut pas avoir à la fois un texte calé sur
le son, un son calé sur l'image et une transcription en direct : un mot n'existe en texte
qu'environ 2 s après avoir été prononcé. En transcrivant toute la vidéo avant de la
regarder, on connaît l'heure de chaque mot à l'avance, et le texte tombe juste
(médiane : 12 ms). Le mode direct a été retiré.

**Traduire par phrase, pas par mot.** Une traduction n'a ni le même nombre de mots ni
le même ordre que l'original. Placer chaque mot traduit à l'heure d'un mot d'origine
reviendrait à inventer des horaires. Chaque phrase traduite reprend donc les heures,
mesurées, de sa phrase d'origine. Pour le moteur de traduction, l'API de Chrome a été
préférée à un modèle embarqué (NLLB-200) : 2,1 s contre près de 23 minutes pour le
même texte, et rien à télécharger avec l'extension.

## Installation

### Ce qu'il vous faut

- **Google Chrome 138 ou plus récent**, sur ordinateur. C'est la version qui apporte
  l'API Translator. Sans elle, la transcription marche, mais pas la traduction.
- **Node.js 18 ou plus récent**, avec npm. Il ne sert qu'à l'installation.
- **1 Go d'espace disque** : 640 Mo pour le modèle, le reste pour les dépendances.
- **8 Go de mémoire vive au minimum** (16 Go conseillés) : le moteur occupe ~1,3 Go
  pendant la préparation.

*(Testé avec Node 24.16 et npm 11.13.)*

### Les commandes

```bash
git clone https://github.com/lyndalynda9878-ctrl/LiveSub.git
cd LiveSub
npm install
npm run fetch-model
```

`npm run fetch-model` télécharge les **640 Mo** du modèle depuis Hugging Face, une seule
fois. Relancée, la commande ne retélécharge rien si les fichiers sont déjà là et
complets. Le modèle n'est pas versionné dans Git, d'où cette étape.

Puis, dans Chrome :

1. ouvrez `chrome://extensions` ;
2. activez le **mode développeur** (en haut à droite) ;
3. cliquez sur **Charger l'extension non empaquetée** et choisissez le dossier `LiveSub`.

## Utilisation

1. Ouvrez une page avec une vidéo et **lancez la lecture une fois**. Chrome n'autorise
   une extension à piloter un lecteur qu'après un geste de votre part.
2. Cliquez sur l'icône LiveSub.
3. Choisissez les langues :
   - **Langue de départ** : la langue parlée dans la vidéo. Elle est pré-remplie à
     partir du titre de l'onglet. Vérifiez-la, car l'API de Chrome ne sait pas la deviner.
   - **Langue d'arrivée** : la langue de la traduction. Choisissez **« Langue d'origine
     (pas de traduction) »** pour n'avoir que les sous-titres d'origine.
4. Cliquez sur **Démarrer**. La vidéo défile en accéléré et en silence pendant la
   transcription. Comptez environ **la moitié de la durée de la vidéo**.
5. À la fin, la vidéo revient exactement où elle était. Lancez la lecture : les
   sous-titres s'affichent à l'heure.

**La première fois qu'une paire de langues est utilisée**, Chrome télécharge lui-même
son paquet de traduction : environ **80 Mo**, une vingtaine de secondes, avec une
progression en pourcentage dans la popup. Il faut donc être en ligne cette fois-là.
Ensuite, la paire est installée dans Chrome et la traduction marche hors ligne.

Si le modèle manque, l'extension le dit en clair et renvoie à `npm run fetch-model`.

## Limites connues

- **Transcription : 25 langues européennes.** Pas d'arabe, de chinois, de japonais ni de
  turc en langue parlée.
- **Traduction : dépend de Chrome.** Les langues proposées sont celles que l'API Translator
  offrait sur la machine de test (37). Une autre version ou configuration de Chrome peut
  en proposer moins, et la qualité est celle du traducteur de Chrome.
- **Le premier usage d'une paire de langues demande Internet**, pour le téléchargement
  du paquet par Chrome. Seul Chrome contacte alors le réseau : le son et le texte, jamais.
- **Il faut attendre la préparation** : environ la moitié de la durée de la vidéo. Ce
  n'est pas un sous-titrage en direct.
- **Chrome uniquement, sur ordinateur.** Pas de Firefox, de Safari ni de mobile.
- Une vidéo placée dans un **cadre intégré** (`iframe`) n'est pas visible par l'extension.

## Licences et attribution

Le code de LiveSub est publié sous licence **ISC** (voir [`LICENSE`](LICENSE)).

### Le modèle : NVIDIA Parakeet TDT 0.6B v3

LiveSub utilise le modèle **`nvidia/parakeet-tdt-0.6b-v3`**, créé par **NVIDIA**, sous
licence **Creative Commons Attribution 4.0 (CC-BY-4.0)**.

> **L'attribution à NVIDIA est une condition de la licence.**
> Toute redistribution de LiveSub, ou de tout travail dérivé qui embarque ce modèle,
> doit citer NVIDIA comme auteur du modèle et mentionner la licence CC-BY-4.0.

Les poids employés sont l'export ONNX publié par **ysdede** dans le dépôt
[`ysdede/parakeet-tdt-0.6b-v3-onnx`](https://huggingface.co/ysdede/parakeet-tdt-0.6b-v3-onnx),
lui-même dérivé de la conversion de `istupakov/parakeet-tdt-0.6b-v3-onnx`. Ce dépôt
conserve la licence CC-BY-4.0 du modèle d'origine.

Texte de la licence : <https://creativecommons.org/licenses/by/4.0/>

### La bibliothèque : parakeet.js

Le chargement et le décodage passent par **[parakeet.js](https://github.com/ysdede/parakeet.js)**
(version 1.4.4), de **Yunus Seyhan Dede (ysdede)**, sous licence **MIT**.

### Autres dépendances

- **[onnxruntime-web](https://github.com/microsoft/onnxruntime)** (Microsoft), licence MIT.
  C'est le moteur qui exécute le modèle.
- **[@huggingface/transformers](https://github.com/huggingface/transformers.js)**, licence Apache-2.0.
- **[@ricky0123/vad-web](https://github.com/ricky0123/vad)**, licence ISC. Le détecteur
  de parole Silero qu'il embarque est sous licence MIT.

Ces deux dernières ne servent plus qu'aux pages de mesure de l'ancien moteur, dans
[`bancs/`](bancs/). Le modèle de traduction NLLB-200, utilisé lui aussi uniquement dans
les bancs pour comparer, est sous licence CC-BY-NC-4.0 : voir
[`bancs/README.md`](bancs/README.md).

## Comment ce projet a été développé

J'ai développé LiveSub avec **Claude Code**, un assistant de programmation. Je fixais
les objectifs, je faisais les mesures et je validais chaque étape avant de passer à la
suivante, selon le principe « on mesure, on ne suppose pas ». Le fichier
[`CLAUDE.md`](CLAUDE.md) est la mémoire du projet : chaque décision y est notée avec
la mesure qui l'a justifiée, y compris les erreurs corrigées en route.
