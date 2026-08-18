// Telecharge le modele Whisper depuis Hugging Face vers models/.
//
// Pourquoi ? Jusqu'ici le modele n'etait pas dans l'extension : Transformers.js
// allait le chercher sur huggingface.co a chaque demarrage. Mesure sur trois
// captures consecutives : trois telechargements complets de ~150 Mo. Le cache
// du navigateur ne survit pas d'une session a l'autre pour ces requetes.
//
// Consequence : sans internet, l'extension ne demarrait pas -- ce qui contredit
// l'argument central du projet (« 100 % local, hors ligne »).
//
// Meme mecanisme que vendor/ (voir copy-assets.js) : dossier gitignore, rempli
// par un script npm, jamais versionne. La seule difference est la source : ici
// on telecharge, la-bas on copie depuis node_modules.
//
// Lance automatiquement apres `npm install` (script postinstall), ou a la main
// avec `npm run build:model`.
//
// Usage avance (page de comparaison test-bench.html uniquement) :
//   node scripts/fetch-model.js Xenova/whisper-base:fp32,q8
// Sans argument, seul le modele de PRODUCTION est telecharge.

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const MODELS = path.join(ROOT, "models");

// Le modele de production. Doit rester aligne sur MODELE_DEFAUT et
// DTYPE_DEFAUT dans whisper.worker.js : c'est ce couple-la que l'extension
// chargera au demarrage, et avec allowRemoteModels = false il n'y a plus de
// filet -- un fichier manquant est une erreur, pas un aller sur internet.
const PRODUCTION = [{ repo: "Xenova/whisper-tiny", dtypes: ["fp32"] }];

// Correspondance dtype -> suffixe de fichier .onnx. C'est la table de
// Transformers.js (DEFAULT_DTYPE_SUFFIX_MAPPING), recopiee ici : si elle
// changeait cote librairie, on telechargerait les mauvais fichiers.
const SUFFIXES = {
  fp32: "",
  fp16: "_fp16",
  q8: "_quantized",
  int8: "_int8",
  uint8: "_uint8",
  q4: "_q4",
  q4f16: "_q4f16",
  bnb4: "_bnb4",
};

// Fichiers non-.onnx. Les cinq premiers sont ceux que Transformers.js reclame
// vraiment (ce sont exactement ceux qu'on voyait passer dans l'onglet Reseau) ;
// les suivants sont optionnels selon le modele, on les prend s'ils existent
// parce qu'ils ne pesent rien et qu'un 404 en production serait un aller-retour
// inutile.
const FICHIERS_REQUIS = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
];
const FICHIERS_OPTIONNELS = [
  "added_tokens.json",
  "special_tokens_map.json",
  "normalizer.json",
  "vocab.json",
];

function url(repo, fichier) {
  return `https://huggingface.co/${repo}/resolve/main/${fichier}`;
}

// GET qui suit les redirections : huggingface.co renvoie un 302 vers son CDN.
function telecharger(adresse, destination, sauts = 0) {
  return new Promise((resolve, reject) => {
    if (sauts > 5) return reject(new Error("trop de redirections"));

    https
      .get(adresse, { headers: { "User-Agent": "LiveSub/1.0" } }, (reponse) => {
        const code = reponse.statusCode;

        if (code >= 300 && code < 400 && reponse.headers.location) {
          reponse.resume(); // il faut vider la reponse, sinon la socket reste ouverte
          // Location peut etre RELATIF (huggingface.co le fait) : on le resout
          // par rapport a l'adresse courante, sinon on obtient « Invalid URL ».
          const suivante = new URL(reponse.headers.location, adresse).href;
          return resolve(telecharger(suivante, destination, sauts + 1));
        }
        if (code !== 200) {
          reponse.resume();
          return reject(new Error(`HTTP ${code}`));
        }

        // On ecrit dans un fichier temporaire puis on renomme : une coupure en
        // cours de route laisserait sinon un fichier tronque que le prochain
        // passage prendrait pour un telechargement deja fait.
        const temporaire = destination + ".part";
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const sortie = fs.createWriteStream(temporaire);

        reponse.pipe(sortie);
        sortie.on("finish", () => {
          sortie.close(() => {
            fs.renameSync(temporaire, destination);
            resolve(fs.statSync(destination).size);
          });
        });
        sortie.on("error", (err) => {
          fs.rmSync(temporaire, { force: true });
          reject(err);
        });
      })
      .on("error", reject);
  });
}

function formater(octets) {
  return octets >= 1024 * 1024
    ? `${(octets / 1024 / 1024).toFixed(1)} Mo`
    : `${Math.round(octets / 1024)} Ko`;
}

async function recuperer(repo, fichier, { optionnel = false } = {}) {
  const destination = path.join(MODELS, repo.replace("/", path.sep), fichier);

  if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
    console.log(`  ⏭️  deja la : ${fichier} (${formater(fs.statSync(destination).size)})`);
    return 0;
  }

  process.stdout.write(`  ⬇️  ${fichier} ... `);
  try {
    const octets = await telecharger(url(repo, fichier), destination);
    console.log(formater(octets));
    return octets;
  } catch (err) {
    if (optionnel) {
      console.log(`absent chez ${repo}, ignore`);
      return 0;
    }
    console.log("ECHEC");
    throw new Error(`${repo}/${fichier} : ${err.message}`);
  }
}

// "Xenova/whisper-base:fp32,q8" -> { repo, dtypes }
function analyserArgument(argument) {
  const [repo, liste] = argument.split(":");
  const dtypes = (liste || "fp32").split(",");
  for (const d of dtypes) {
    if (!(d in SUFFIXES)) {
      throw new Error(`dtype inconnu : « ${d} ». Connus : ${Object.keys(SUFFIXES).join(", ")}`);
    }
  }
  return { repo, dtypes };
}

(async () => {
  const arguments_ = process.argv.slice(2);
  const modeles = arguments_.length ? arguments_.map(analyserArgument) : PRODUCTION;

  console.log("📦 Telechargement des modeles Whisper vers models/ ...");
  if (!arguments_.length) {
    console.log("   (modele de production ; passe un argument pour en ajouter d'autres)");
  }

  let total = 0;

  for (const { repo, dtypes } of modeles) {
    console.log(`\n🧠 ${repo} [${dtypes.join(", ")}]`);

    for (const fichier of FICHIERS_REQUIS) total += await recuperer(repo, fichier);
    for (const fichier of FICHIERS_OPTIONNELS) {
      total += await recuperer(repo, fichier, { optionnel: true });
    }

    // Les .onnx vont dans un sous-dossier onnx/ : c'est la ou Transformers.js
    // les cherche, on ne choisit pas cette structure.
    for (const dtype of dtypes) {
      const suffixe = SUFFIXES[dtype];
      for (const base of ["encoder_model", "decoder_model_merged"]) {
        total += await recuperer(repo, `onnx/${base}${suffixe}.onnx`);
      }
    }
  }

  console.log(
    `\n✅ Modeles prets dans models/ ` +
      (total ? `(${formater(total)} telecharges)` : "(rien a telecharger)")
  );
  console.log("   Rappel : models/ est gitignore, comme vendor/.");
})().catch((err) => {
  console.error(`\n❌ Telechargement du modele impossible : ${err.message}`);
  console.error("   Verifie ta connexion, puis relance `npm run build:model`.");
  process.exit(1);
});
