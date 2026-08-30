# LiveSub

LiveSub est une extension Chrome qui sous-titre la vidéo de l'onglet où vous êtes.
Elle écoute le son de l'onglet, le transcrit avec un modèle de reconnaissance vocale
qui tourne **sur votre machine**, et affiche les sous-titres en surimpression sur la page.

---

## Installation

### Ce qu'il vous faut d'abord

- **Node.js 18 ou plus** et npm (`node --version` pour vérifier). Node sert uniquement
  à l'installation — à copier les librairies dans `vendor/` et à télécharger le modèle.
  L'extension, une fois installée, n'a pas besoin de Node.
- **Google Chrome**, sur ordinateur.
- **1 Go d'espace disque** : 640 Mo de modèle, le reste en dépendances.

*(Testé avec Node 24.16 et npm 11.13.)*

### Les commandes

```bash
git clone <URL-du-dépôt>
cd LiveSub
npm install
npm run fetch-model
```

`npm run fetch-model` télécharge les **640 Mo** du modèle depuis Hugging Face. C'est
long (environ une minute sur une bonne connexion), et **c'est une seule fois** : la
commande relancée ne retélécharge rien si les fichiers sont déjà là et complets.
Le modèle n'est pas versionné dans git — c'est pour ça qu'il faut cette étape.

Puis, dans Chrome :

1. ouvrez `chrome://extensions` ;
2. activez le **mode développeur** (interrupteur en haut à droite) ;
3. cliquez **Charger l'extension non empaquetée** et choisissez le dossier `LiveSub`.

### Utilisation

1. ouvrez une page contenant une vidéo, et **lancez la lecture une fois** (Chrome
   n'autorise une extension à piloter un lecteur qu'après un geste de votre part) ;
2. cliquez sur l'icône LiveSub, puis sur **Démarrer** ;
3. la vidéo défile en accéléré et **en silence** pendant que LiveSub la transcrit ;
4. à la fin, la vidéo revient exactement où elle était. Lancez la lecture : les
   sous-titres s'affichent à l'heure.

Si le modèle manque, l'extension vous le dit en clair et vous renvoie à
`npm run fetch-model` — elle ne reste jamais bloquée sur une barre qui tourne.

---

## Configuration recommandée

Le moteur de transcription tourne dans un Web Worker et occupe environ **1,3 Go de
mémoire WebAssembly** pendant la préparation (mesuré : 1 335 Mo). Ce n'est pas de la
mémoire JavaScript ordinaire, et le gestionnaire des tâches de Chrome la compte à part.

En pratique :

- **8 Go de RAM au minimum**, 16 Go pour être tranquille ;
- fermez les onglets lourds pendant une préparation ;
- le worker est **arrêté dès la préparation finie** : les 1,3 Go sont rendus, ils ne
  restent pas occupés pendant que vous regardez la vidéo.

Aucun GPU n'est nécessaire : tout tourne sur le processeur.

---

## 100 % local

LiveSub ne communique avec aucun serveur pendant son fonctionnement : mesuré à
21 requêtes, toutes internes à l'extension, 0 externe. Le modèle est téléchargé une
seule fois, à l'installation, exactement comme les dépendances npm. Une fois installé,
débranchez le réseau : l'extension continue de transcrire.

Concrètement : le son de votre onglet ne quitte jamais votre machine. Il n'est envoyé
à aucune API de transcription, il n'est stocké nulle part, il n'est pas envoyé non plus
au dépôt du modèle. Le seul fichier du projet qui contacte Internet est
`scripts/fetch-model.js`, et il ne s'exécute que lorsque vous tapez `npm run fetch-model`.

---

## Limites connues

- **25 langues européennes**, détectées automatiquement. Il n'y a aucun réglage de
  langue dans l'extension, et ce n'est pas un oubli : le modèle reconnaît la langue
  seul.
- **Pas d'arabe, de chinois, de japonais ni de turc** en transcription. Ces langues
  ne font pas partie des 25.
- **Chrome uniquement, sur ordinateur.** Pas de Firefox, pas de Safari, pas de mobile.
- La vidéo doit être dans la page elle-même : une vidéo dans un cadre intégré
  (`iframe`) n'est pas visible par l'extension.

---

## Licences et attribution

Le code de LiveSub est publié sous licence ISC (voir `package.json`).

### Le modèle : NVIDIA Parakeet TDT 0.6B v3

LiveSub utilise le modèle **`nvidia/parakeet-tdt-0.6b-v3`**, créé par **NVIDIA**, sous
licence **Creative Commons Attribution 4.0 (CC-BY-4.0)**.

> **L'attribution à NVIDIA est une condition de la licence, pas une politesse.**
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

- **[onnxruntime-web](https://github.com/microsoft/onnxruntime)** (Microsoft) — licence MIT.
  C'est le moteur qui exécute le modèle.
- **[@huggingface/transformers](https://github.com/huggingface/transformers.js)** — licence Apache-2.0.
- **[@ricky0123/vad-web](https://github.com/ricky0123/vad)** — licence ISC ; le détecteur
  de parole Silero qu'il embarque est sous licence MIT.
