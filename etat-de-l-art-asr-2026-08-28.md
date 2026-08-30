# État de l'art — quel modèle de transcription pour LiveSub ?

**Date du relevé : 28 août 2026.** Catalogue Hugging Face interrogé ce jour.
Objectif : français + anglais, dans un navigateur, hors ligne.

⚠️ **Ce document sépare strictement ce qui est MESURÉ de ce qui est ESTIMÉ.**
Les seuls chiffres de vitesse mesurés sont ceux de la machine de Lynda, déjà au
dossier. Tout le reste est marqué `NON MESURÉ`.

---

## Les quatre barrières

Un modèle n'est utilisable par LiveSub que s'il passe **les quatre**. La plupart
des candidats meurent à la première ou à la deuxième — et ce ne sont pas celles
qu'on croit.

| # | barrière | pourquoi elle existe |
|---|---|---|
| 1 | **Se charge dans transformers.js** | c'est la seule bibliothèque d'inférence qu'on embarque. Un modèle ONNX qui a besoin d'un runtime Python ne sert à rien ici. |
| 2 | **Donne l'heure de chaque mot** | toute la chaîne d'affichage de LiveSub repose sur `return_timestamps: "word"`. Sans instant par mot : pas de rythme, pas de synchro, pas de .srt. |
| 3 | **Parle français ET anglais** | les deux langues cibles du projet. |
| 4 | **Tourne assez vite** | WASM, **un seul thread** (la CSP de MV3 bloque le multithread). Budget : voir plus bas. |

**La barrière 2 est la vraie surprise du projet.** Ce n'est pas « il n'y a que
Whisper en ONNX » — c'est **« il n'y a que Whisper qui donne l'heure de chaque
mot »**. Les modèles ASR les plus performants sortis en 2026 rendent un bloc de
texte, sans horodatage. Pour un lecteur de sous-titres, c'est éliminatoire.

---

## Barrière 1 — ne se charge pas dans transformers.js

| modèle | langues | pourquoi c'est mort |
|---|---|---|
| **NVIDIA Parakeet TDT 0.6B v3** ([lien](https://hf.co/istupakov/parakeet-tdt-0.6b-v3-onnx)) | fr, en + 23 | 388 000 téléchargements, licence CC-BY, ONNX, et il **donne des timings**. Mais son décodage (TDT/RNNT) n'existe pas dans transformers.js : le runtime prévu est `onnx-asr`, en Python. Il faudrait écrire le décodeur soi-même en JS. |
| **NVIDIA Nemotron 3.5 ASR streaming 0.6B** ([lien](https://hf.co/onnx-community/nemotron-3.5-asr-streaming-0.6b-onnx-int4)) | fr, en, ar + 32 | même famille, format `nemo`. Même mur. |
| Kyutai STT, NVIDIA Canary | fr, en | aucun export ONNX navigateur trouvé au 28/08/2026. |

⚠️ **C'est le point le plus intéressant à écrire dans le rapport** : Parakeet
n'est pas écarté parce qu'il est mauvais — il est écarté parce que **le pont
logiciel entre lui et le navigateur n'a pas été construit**. Ce n'est pas une
limite de l'IA, c'est une limite de l'écosystème JavaScript.

---

## Barrière 2 — pas d'horodatage par mot

| modèle | taille | ce que dit sa fiche |
|---|---|---|
| **Cohere Transcribe 03-2026** ([lien](https://hf.co/onnx-community/cohere-transcribe-03-2026-ONNX)) | 2 milliards | Sorti en mars 2026, `transformers.js`, **fr + en + ar**, « best-in-class » revendiqué. Sa propre fiche : *« Timestamps / Speaker diarization: the model does not feature either of these. »* En prime : encodeur de **7,5 Go** en fp32, **2 Go** même en q4. Impossible à embarquer, impossible à faire tourner sur WASM 1 thread. |
| **Moonshine tiny / base** ([lien](https://hf.co/onnx-community/moonshine-base-ONNX)) | 27 / 61 M | Conçu pour l'embarqué, très rapide, `transformers.js`. Mais **anglais uniquement**, et pas d'horodatage par mot. |
| **Voxtral Mini 3B / 4B** ([lien](https://hf.co/onnx-community/Voxtral-Mini-4B-Realtime-2602-ONNX)) | 3–4 milliards | LLM audio. Trop gros de deux ordres de grandeur, et pas d'horodatage mot. |

---

## Barrière 3 — ne parle pas les bonnes langues

| modèle | taille | langues | note |
|---|---|---|---|
| **CrisperWhisper 2.0 small** ([lien](https://hf.co/nyralabs/CrisperWhisper2.0_small)) | 242 M | **en + de** | Le candidat le plus frustrant. C'est un Whisper **spécialement retravaillé pour la précision des horodatages par mot** — exactement notre besoin. Mais pas de français. |
| ⚠️ `onnx-community/CrisperWhisper2.0_small-ONNX-timestamped` | — | — | **Le dépôt est VIDE.** Un README de 30 octets, zéro fichier de poids. Le nom promet tout, il ne contient rien. **Piège classique : un nom de dépôt n'est pas une preuve d'existence.** |
| CrisperWhisper v1 ONNX ([lien](https://hf.co/onnx-community/CrisperWhisper-ONNX)) | 1,5 Md | en, de | basé sur large-v3 → voir barrière 4. |
| whisper-**tiny.en** / **base.en** / **small.en** | 39 / 74 / 244 M | **en seul** | Écartés comme modèle unique, mais **utiles en renfort** : à taille égale, un modèle dédié anglais bat le multilingue sur l'anglais. À garder en tête si LiveSub finit par choisir son modèle selon la langue. |
| kotoba-whisper (ja), kb-whisper (sv) | — | — | hors sujet. |

---

## Barrière 4 — trop lent

Rappel du budget. En mode anticipation la vidéo défile à `PREP_VITESSE`, donc
le modèle doit transcrire **plus vite que la vidéo ne se déroule** :

- pour tenir ×2 → sous **50 %** du temps réel
- pour tenir ×1,5 → sous **66 %**
- pour tenir ×1 → sous **100 %**

⚠️ **`PREP_VITESSE = 2` est un choix, pas une loi.** Ralentir la préparation ne
coûte **que de l'attente** : ni qualité, ni désynchronisation. C'est le levier
principal du dossier, et la décision appartient à Lynda.

| modèle | paramètres | % temps réel | source du chiffre |
|---|---|---|---|
| whisper-large-v3 | 1 550 M | ~1300 % | mesuré |
| whisper-large-v3-turbo | 809 M | ~700 % | mesuré |
| distil-large-v3.5 ONNX | 756 M | — | `NON MESURÉ` — même ordre que turbo |
| whisper-medium | 769 M | — | `NON MESURÉ` — même ordre que turbo |
| whisper-small (q8) | 244 M | **211 %** | mesuré |
| **whisper-small-cv11-french** ([lien](https://hf.co/onnx-community/whisper-small-cv11-french-ONNX)) | 244 M | — | `NON MESURÉ`. Même taille que small → **attendu du même ordre**, donc probablement disqualifié. Mais c'est **le meilleur français atteignable** dans le format : utile à mesurer une fois, juste pour connaître le plafond de qualité. |
| lite-whisper-large-v3-turbo ([lien](https://hf.co/onnx-community/lite-whisper-large-v3-turbo-ONNX)) | encodeur compressé | — | `NON MESURÉ`. ⚠️ **Ne réglerait rien** : lite-whisper compresse l'**encodeur**, or chez nous c'est le **décodeur** qui coûte (c'est pour ça que le GPU est plus lent que le CPU — voir CLAUDE.md). |

---

## Ce qui reste : le palmarès des survivants

| modèle | taille fp32 | % temps réel | vitesse de prépa max | attente sur 17 min de vidéo |
|---|---|---|---|---|
| **whisper-tiny fp32** *(actuel)* | 147 Mo | **31 %** | ×2 (plafond) | **8,5 min** |
| **whisper-base q8** | ~77 Mo | **59 %** | ×1,7 | 10,0 min |
| **whisper-base fp32** | ~290 Mo | **75 %** | ×1,3 | **12,8 min** |
| whisper-base.en fp32 | ~290 Mo | `NON MESURÉ` | — | anglais seul, en renfort |

Fine-tunes français de whisper-base trouvés au catalogue
([Dok75](https://hf.co/Dok75/whisper-base-french-arun100-onnx),
[EvgenyShivchenkoUIT](https://hf.co/EvgenyShivchenkoUIT/whisper-base-ONNX-french-full)) :
**2 à 12 téléchargements, aucun README, exports d'un particulier.** À traiter
comme non vérifiés — un export ONNX peut se charger et produire du texte cassé
(c'est déjà arrivé sur ce projet avec fp16 en WebGPU).

---

## LA conclusion, en une phrase

**L'échelle de Whisper est 39 → 74 → 244 → 769 → 1550 millions de paramètres.
Il n'y a rien entre 74 et 244.** Or 74 (base) coûte 75 % du temps réel et 244
(small) en coûte 211 %. Le seul pas que LiveSub peut monter, c'est **tiny → base**.
Au-dessus, c'est un mur, pas une pente.

Tout le reste du catalogue 2026 — Cohere, Parakeet, Nemotron, Moonshine,
CrisperWhisper — est soit sans horodatage par mot, soit sans français, soit sans
runtime JavaScript, soit dix fois trop gros.

## La seule question encore ouverte, et elle est mesurable

**`base` est-il meilleur que `tiny` sur du son BRUITÉ, en français ?**

`base` avait été écarté sur du son **propre** (WER 0 % pour les deux — donc aucun
gain visible). C'était la mauvaise condition : le reproche porte sur le son
bruité (documentaire avec musique : « lourire » pour « nourrir »).

**Ce qui prouverait que changer de modèle ne sert à rien** : `base` qui fait
autant de fautes que `tiny` sur le même extrait musical. Alors les 4 minutes
d'attente supplémentaires seraient payées pour rien, et le dossier se referme
définitivement.
