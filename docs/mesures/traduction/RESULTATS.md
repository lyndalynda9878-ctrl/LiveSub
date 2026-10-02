# Traduction dans LiveSub — mesure des deux candidats (2026-08-31)

Machine : Windows 11 26200, Intel Iris Xe / Wi-Fi 6E.
Chrome **151.0.7922.174**, profil `%USERPROFILE%\.cache\chrome-devtools-mcp\chrome-profile`.
Extension chargee non empaquetee, ID `gahilnfeeoofbbokajafblpidjmbngjl`.

Texte de mesure : la transcription REELLE de `bancs/audio/extrait-fr-dur.wav` par Parakeet
(`docs/mesures/traduction/source-fr.txt`, 69 mots) et celle de l'extrait anglais
(`source-en.txt`, 123 mots). Le texte de 2493 mots est `source-fr.txt` repete
jusqu'a 2493 mots exactement — la taille de la mesure de reference de Parakeet.

---

## Trois reserves a lire AVANT les chiffres

1. **Ce Chrome n'est pas un Chrome ordinaire.** Il est lance par l'outil avec
   `--disable-background-networking` et
   `--disable-features=Translate,OptimizationHints,...`. Les paquets de langue de
   TranslateKit se telechargent quand meme (mesure ci-dessous, 20,5 s pour en->ja),
   mais **le verdict `unavailable` de `LanguageDetector` peut etre un artefact de
   ces drapeaux** : le modele de detection est livre par l'Optimization Guide, qui
   est desactive, et le dossier `optimization_guide_model_store` est absent du
   profil. NON TRANCHE.
2. **Le contexte A2 (script de contenu) n'a PAS ete teste.** Il exige soit une
   deuxieme entree `content_scripts` dans `manifest.json`, soit la permission
   `scripting`. Les deux sont interdites par la consigne. Voir plus bas.
3. **Le reseau a ete coupe par le proxy systeme (HKCU), pas par l'adaptateur.**
   Le shell n'est pas eleve : `netsh wlan` renvoie deja « erreur 5, requiert une
   elevation ». La coupure porte sur TOUT le reseau de Chrome, processus
   navigateur compris, et un temoin `fetch()` prouve qu'elle a pris.

---

## 1. Le tableau

| | Candidat A — API Translator de Chrome | Candidat B — NLLB-200 600M q8 (transformers.js) |
|---|---|---|
| **Marche ?** | oui, dans les 2 contextes testes (A1, A3) | oui, dans un Web Worker — mais pas au premier essai |
| **Poids livre avec l'extension** | **0 o** | **911 962 632 o** (869,7 Mio) dans `test-nllb-model/` |
| **Poids sur disque hors extension** | 79,6 Mo par paquet, dans le profil Chrome (mesure : `en_ja` = 79 567 210 o). Pour fr<->en + fr<->ar : `en_fr` 81 039 103 o + `ar_en` 80 851 510 o + `libtranslatekit.dll` 19 339 416 o = **181 230 029 o** | idem ci-contre (le modele EST le poids) |
| **Memoire** | **+99 Mio** de Chrome, dans un **processus dedie** (97 Mio) — rien dans l'espace de l'extension | **2 364,7 Mo** de memoire lineaire WASM au chargement, **3 269,5 Mo** apres les 3 traductions. Au niveau processus : **1 580 Mio** rendus par `worker.terminate()` |
| **Temps de mise en route** | `create()` 145–335 ms (paquet deja installe) ; **20 533 ms** au tout premier telechargement | **35 679 ms** de chargement du modele |
| **Mon texte, fr->en (69 mots)** | **207 ms** (2e passage 102 ms) | **27 958 ms** |
| **Mon texte, en->fr (123 mots)** | **207 ms** (2e passage 149 ms) | **58 992 ms** |
| **Mon texte, fr->ar (69 mots)** | **240 ms** (2e passage 209 ms) | **39 600 ms** |
| **2493 mots, fr->en** | **2 099 ms**, un seul appel | **1 366 060 ms** (22 min 46 s), 54 morceaux |
| **Reseau, 1re traduction d'une paire installee** | 0 requete | 0 requete |
| **Reseau, 1er telechargement** | 20,5 s ; **2 domaines** : `update.googleapis.com:443` et `edgedl.me.gvt1.com:80` ; **56 490 050 o** de CRX sur le fil, 79 567 210 o sur disque | 0 dans le navigateur (le modele est descendu hors navigateur par `bancs/test-nllb-fetch.js`) |
| **Reseau, 2e traduction** | **0 requete** (onglet Reseau de la page) | **0 requete** |
| **Hors ligne** | **traduit** (volet B) | **traduit** |
| **Langue detectee toute seule** | `LanguageDetector` present mais `availability` = `unavailable`, `create()` echoue | sans objet : NLLB exige `src_lang` explicite |

---

## 2. Candidat A — les trois contextes

| | A1 document offscreen | A2 script de contenu | A3 page d'extension a bouton |
|---|---|---|---|
| `"Translator" in self` | **true** | **NON TESTE** | **true** |
| `"LanguageDetector" in self` | **true** | **NON TESTE** | **true** |
| `typeof Translator.create` | `"function"` | **NON TESTE** | `"function"` |
| `navigator.userActivation` | `isActive:false`, `hasBeenActive:false` | **NON TESTE** | `isActive:true` apres clic |
| `typeof chrome.storage` | `"undefined"` (confirme une fois de plus) | **NON TESTE** | n/a |
| `availability("fr","en")` | `available` | **NON TESTE** | `available` |
| `availability("en","fr")` | `available` | **NON TESTE** | `available` |
| `availability("fr","ar")` | `available` | **NON TESTE** | `available` |
| `availability("en","nl")` (non installe) | `downloadable` | **NON TESTE** | `downloadable` |
| `create()` fr->en | **OK, 207 ms** | **NON TESTE** | **OK, 335 ms** |
| `create()` en->fr | **OK, 117 ms** | **NON TESTE** | **OK, 145 ms** |
| `create()` fr->ar | **OK, 159 ms** | **NON TESTE** | **OK, 257 ms** |
| `create()` en->nl (non installe) | **ECHEC** — `NotAllowedError` | **NON TESTE** | **ECHEC** — `NotAllowedError` |
| `LanguageDetector.create()` | **ECHEC** — `NotSupportedError: Model not available` | **NON TESTE** | **ECHEC**, meme erreur, avec clic frais |

### Pourquoi A2 n'a pas ete teste — c'est une decision, pas un oubli

Un script de contenu ne peut etre injecte que de deux facons :

- une entree `content_scripts` supplementaire dans `manifest.json` — donc **une
  declaration dans manifest.json** ;
- `chrome.scripting.executeScript` — donc **la permission `scripting`**, absente du
  manifeste.

`content.js` existe deja et est injecte partout, mais c'est un fichier de PRODUCTION.
Evaluer du code depuis DevTools dans la page ne repond pas a la question : cela
s'execute dans le monde PRINCIPAL de la page, pas dans le monde ISOLE du script de
contenu, et c'est justement ce monde-la qui est en cause.

**Ce qu'il faudrait autoriser, en une ligne** : dans `manifest.json`,
`"content_scripts"` recevrait un deuxieme objet
`{ "matches": ["<all_urls>"], "js": ["test-traduction-a2-content.js"] }`.

### Les erreurs, entieres

`create()` sur une paire `downloadable` sans geste utilisateur (A1, et A3 apres 10 s) :

```
NotAllowedError: Requires a user gesture when availability is "downloading" or "downloadable".
  name    : NotAllowedError
  message : Requires a user gesture when availability is "downloading" or "downloadable".
  stack   : NotAllowedError: Requires a user gesture when availability is "downloading" or "downloadable".
```

`LanguageDetector.create()`, dans les deux contextes, clic frais compris :

```
NotSupportedError: Model not available
  name    : NotSupportedError
  message : Model not available
```

`create()` a 17:48, AVANT que le moindre paquet ne soit installe, avec un clic
garanti (releve conserve dans `a3-traductions.json`) :

```
NotSupportedError: Unable to create translator for the given source and target language.
  name    : NotSupportedError
  message : Unable to create translator for the given source and target language.
  stack   : NotSupportedError: Unable to create translator for the given source and target language.
  msCreate: 9656
```

Cette erreur-la contredit la mesure de 18:22, qui reussit sur les memes paires. La
seule chose qui a change entre les deux, c'est que les paquets sont installes.
`availability()` disait `downloadable` dans les deux cas : **le meme mot recouvre
« ca va marcher » et « ca ne marchera pas ».**

---

## 3. Le premier telechargement d'un paquet — mesure de bout en bout

Fait sur `en->ja`, jamais installe sur cette machine, depuis un vrai clic.

| | |
|---|---|
| `availability()` avant | `downloadable` |
| `availability()` apres | `available` |
| duree totale de `create()` | **20 533 ms** |
| evenements `downloadprogress` | **96** |
| premier evenement | 992 ms |
| dernier evenement | 19 853 ms |
| **domaines contactes** | `update.googleapis.com` (142.250.74.174:443) et `edgedl.me.gvt1.com` (34.104.35.123:**80**) |
| **octets sur le fil** | **56 490 050 o** (le CRX depose dans `component_crx_cache` a 18:21:27) |
| **octets sur disque** | **79 567 210 o** (`TranslateKit\models\en_ja`, dossier cree a 18:21:07) |
| compteur Wi-Fi de la machine | +80 472 410 o sur la fenetre — borne haute, bruit de fond compris |

**`downloadprogress` ne donne PAS d'octets.** `e.total` vaut **1** et `e.loaded` va de
0 a 1 : c'est une fraction normalisee. Une barre de progression est possible, mais
aucun chiffre en octets n'en sortira.

**`availability()` ment dans les DEUX sens.** `en->es` etait annonce `downloadable` et
`create()` a mis **208 ms** sans rien telecharger — le paquet etait deja la. `en->ja`,
annonce pareil, a mis **20 533 ms**. Le meme mot pour deux situations qui different
d'un facteur 100.

### La deuxieme traduction

Onglet Reseau de `bancs/test-traduction-a3.html` apres les 3 paires traduites deux fois
chacune : **3 requetes en tout**, `bancs/test-traduction-a3.html` et `bancs/test-traduction-a3.js`
(deux fois, module). **Zero requete pour une traduction, la premiere comme la seconde.**

---

## 4. Candidat B — ce qui a resiste

### Il ne se charge PAS avec les reglages evidents

```
Can't create a session. ERROR_CODE: 1, ERROR_MESSAGE: qdq_actions.cc:137
TransposeDQWeightsForMatMulNBits Missing required scale:
model.shared.weight_merged_0_scale for node: model.shared.weight_transposed_DequantizeLinear
```

C'est **mot pour mot** la panne deja payee sur le q8 de Whisper (CLAUDE.md,
« Contraintes techniques connues »), et le remede est le meme :
`session_options: { graphOptimizationLevel: "basic" }`. Ce ne sont pas les poids qui
sont casses, ce sont les passes de fusion `extended` d'ONNX Runtime.

### La memoire, obtenue comme pour Parakeet

`performance.memory` est **`undefined`** dans ce worker — il n'aurait meme pas menti,
il n'aurait rien dit. La vraie mesure vient de l'espion pose sur `WebAssembly.Memory`
**avant** l'import de transformers.js, puis lu par `buffer.byteLength` :

| moment | memoire lineaire WASM | nombre de `WebAssembly.Memory` |
|---|---|---|
| modele charge | **2 364,7 Mo** | 1 |
| apres les 3 traductions | **3 269,5 Mo** | 1 |

Et au niveau processus (`Get-Process chrome`, hors navigateur) : 2 474 Mio avec le
worker, 894 Mio apres `terminate()`, soit **1 580 Mio rendus**. Les deux chiffres ne se
contredisent pas : `byteLength` mesure la memoire lineaire **allouee**, le working set
mesure ce qui est **resident**.

### La regle du bundle ONNX n'a PAS pu etre tenue

La consigne etait `ort.wasm.bundle.min.mjs`, dont l'interet est structurel : **ce
bundle ne contient pas le provider WebGPU**, donc WebGPU ne peut pas s'activer par
accident. Or **transformers.js 4.2.0 embarque son propre ONNX Runtime et choisit son
binaire lui-meme**. L'onglet Reseau montre ce qu'il a reellement charge :

```
GET vendor/transformers/ort-wasm-simd-threaded.asyncify.mjs   [200]
GET vendor/transformers/ort-wasm-simd-threaded.asyncify.wasm  [200]
```

`asyncify` est **la variante qui porte WebGPU** (CLAUDE.md). Ce qui a pu etre force l'a
ete — `device: "wasm"`, `numThreads = 1`, `proxy = false` — et le calcul tourne bien sur
le CPU. Mais **la garantie de structure n'existe pas ici** : il ne reste qu'un reglage,
exactement ce que CLAUDE.md dit de ne pas se contenter.

### Faits bruts sur les sorties (ce ne sont pas des jugements de qualite)

- `en->fr` : la sortie commence a « Les deux trous noirs massifs… » ; la premiere
  phrase de la source (« it possible to detect these mergers… ») n'apparait pas.
- `fr->ar` : la sortie s'arrete a « حولهم. » ; les deux dernieres phrases de la source
  n'apparaissent pas.
- 2493 mots : 11 597 caracteres en sortie, contre 14 408 pour le candidat A.

Les textes integraux sont dans `TRADUCTIONS-COTE-A-COTE.md`. Je ne les departage pas.

---

## 5. Contre-preuve, volet A — l'activation utilisateur

| essai | paire | `availability` avant | `isActive` au `create()` | resultat |
|---|---|---|---|---|
| create() **immediat** apres le clic | en->es | `downloadable` | **true** | **OK, 208 ms** |
| create() **immediat** apres le clic | en->ja | `downloadable` | **true** | **OK, 20 533 ms**, telechargement reel |
| create() **10 s apres**, sans nouveau clic | en->nl | `downloadable` | **false** | **ECHEC — `NotAllowedError`** |
| create() **10 s apres**, sans nouveau clic | en->fr | `available` | **false** | **OK, 204 ms** |
| create() dans l'**offscreen**, jamais de clic | fr->en, en->fr, fr->ar | `available` | **false** | **OK** |
| create() dans l'**offscreen**, jamais de clic | en->nl | `downloadable` | **false** | **ECHEC — `NotAllowedError`** |

**L'activation utilisateur n'est une contrainte QUE pour le telechargement.** Une paire
deja installee se cree sans le moindre geste, y compris dans le document offscreen — le
contexte de production de LiveSub. Une paire non installee ne se cree jamais sans un
clic de moins de 5 secondes, et l'offscreen n'en recevra jamais.

Le document offscreen n'est donc pas condamne d'avance : il est bloque **le premier
jour**, pour chaque paire, une seule fois.

---

## 6. Contre-preuve, volet B — hors ligne

Reseau de Chrome coupe par le proxy systeme `127.0.0.1:1` (HKCU), restauration par
minuterie. **Temoin** : `fetch("https://huggingface.co/favicon.ico")` echoue
(`TypeError: Failed to fetch`, apres 2 037 ms), puis `fetch("https://update.googleapis.com/")`
echoue de meme. Guetteur TCP : **aucune connexion sortante nouvelle** ouverte par
Chrome pendant la fenetre.

| passage | fr->en | en->fr | fr->ar |
|---|---|---|---|
| 1er (texte integral) | **OK** 111/110 ms | **ECHEC — `NotSupportedError: Unable to create translator for the given source and target language.`** | **OK** 126/202 ms |
| 2e (phrase courte, 6 essais dont 3 en->fr) | **OK** 82 ms | **OK** 171 / 82 / 90 ms | **OK** 127 ms |
| 3e (texte integral, 2 traductions chacune) | **OK** 98 / 114 ms | **OK** 172 / 123 ms | **OK** 199 / 193 ms |

**L'API Translator traduit hors ligne.** Le paquet telecharge rend bien l'extension
autonome ; le reseau est un cout d'installation, pas un cout par traduction.

**Une reserve honnete** : `en->fr` a echoue **1 fois sur 4** hors ligne, avec
`NotSupportedError`, sur un `create()` immediatement consecutif au `destroy()` d'un
traducteur partageant le meme paquet `en_fr`. Non reproduit sur les 3 essais suivants.
Cause **non elucidee** — ce n'est pas le reseau, puisque les autres paires passaient au
meme instant.

---

## 7. Contre-preuve, volet C — NLLB est-il vraiment local ?

`test-nllb-model/` renomme en `test-nllb-model-RENOMME-VOLET-C`, page rechargee,
chargement relance.

```
`local_files_only=true` or `env.allowRemoteModels=false` and file was not found
locally at "chrome-extension://gahilnfeeoofbbokajafblpidjmbngjl/test-nllb-model/Xenova/nllb-200-distilled-600M/config.json".
```

Onglet Reseau : **6 requetes, toutes en `chrome-extension://`**, la derniere en
`net::ERR_FILE_NOT_FOUND`. **Aucune requete vers huggingface.co.**

**NLLB est bien local.** Il echoue quand on lui retire ses fichiers, il ne va pas les
chercher ailleurs. Ses chiffres tiennent. Le dossier a ete remis a son nom.

---

## 8. Ou j'ai regarde, mesure par mesure

| mesure | console / outil |
|---|---|
| A1 : presence, availability, create, traductions | **console du service worker** (`background.js`) — le document offscreen n'est pas une cible DevTools en session pilotee, le resultat remonte par `chrome.runtime.sendMessage` |
| A3 : sonde, create, traductions, 2493 mots, LanguageDetector, volets A et B | **console de la page** `bancs/test-traduction-a3.html` (`window.SONDE`, `TRADUCTIONS_A`, `GROS`, `DETECTEUR`, `VOLET_A_*`, `HORS_LIGNE`) |
| requetes de la 2e traduction, volet C | **onglet Reseau** de la page concernee |
| domaines du 1er telechargement | **guetteur TCP Windows** (`Get-NetTCPConnection` sur les processus `chrome`), hors navigateur — l'onglet Reseau de la page ne voit RIEN de ce telechargement, il est fait par le processus navigateur |
| octets sur le fil | taille du CRX depose dans `component_crx_cache` du profil |
| octets sur disque | `Get-ChildItem -Recurse` sur `TranslateKit\models` |
| octets Wi-Fi | `Get-NetAdapterStatistics` |
| memoire du candidat A | `Get-Process chrome` (somme des `WorkingSet64`) |
| B : chargement, memoire WASM, traductions | **console de la page** `bancs/test-traduction-nllb.html`, alimentee par les messages du worker |
| memoire WASM de B | espion sur `WebAssembly.Memory` **dans le worker**, lu par `buffer.byteLength` |
| version et drapeaux de Chrome | `chrome://version` |
