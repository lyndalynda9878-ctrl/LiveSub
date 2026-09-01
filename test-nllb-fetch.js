// Telechargement du CANDIDAT B (NLLB-200 distilled 600M, quantification q8)
// dans un dossier de TEST. Ce n'est pas un choix fait : rien ne va dans models/.
//
// q8 dans transformers.js = les fichiers suffixes "_quantized.onnx".
// Pour un seq2seq, transformers.js charge l'encodeur + le decodeur FUSIONNE.
//
// Le denominateur est la somme des tailles EXACTES, connue avant la premiere
// requete : une reponse HF peut ne pas porter de content-length fiable, et une
// barre qui recule est le defaut qu'on a deja paye une fois (voir CLAUDE.md).

const fs = require("fs");
const path = require("path");

const DEPOT = "Xenova/nllb-200-distilled-600M";
const RACINE = path.join(__dirname, "test-nllb-model", DEPOT);

const FICHIERS = [
  { chemin: "config.json", octets: 873 },
  { chemin: "generation_config.json", octets: 189 },
  { chemin: "tokenizer.json", octets: 17331224 },
  { chemin: "tokenizer_config.json", octets: 544 },
  { chemin: "special_tokens_map.json", octets: 3548 },
  { chemin: "onnx/encoder_model_quantized.onnx", octets: 419120483 },
  { chemin: "onnx/decoder_model_merged_quantized.onnx", octets: 475505771 },
];

const TOTAL = FICHIERS.reduce((s, f) => s + f.octets, 0);

async function main() {
  console.log(`Depot   : ${DEPOT}`);
  console.log(`Dossier : ${RACINE}`);
  console.log(`Total   : ${TOTAL} o (${(TOTAL / 1048576).toFixed(1)} Mio) sur ${FICHIERS.length} fichiers\n`);

  let dejaLa = 0;
  const t0 = Date.now();

  for (const f of FICHIERS) {
    const dest = path.join(RACINE, f.chemin);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (fs.existsSync(dest) && fs.statSync(dest).size === f.octets) {
      dejaLa += f.octets;
      console.log(`= ${f.chemin} deja complet (${f.octets} o)`);
      continue;
    }

    const url = `https://huggingface.co/${DEPOT}/resolve/main/${f.chemin}`;
    const rep = await fetch(url);
    if (!rep.ok) throw new Error(`${f.chemin} : HTTP ${rep.status} ${rep.statusText}`);

    const flux = fs.createWriteStream(dest);
    let recus = 0;
    let dernierPourcent = -1;

    for await (const morceau of rep.body) {
      flux.write(morceau);
      recus += morceau.length;
      const p = Math.floor(((dejaLa + recus) / TOTAL) * 100);
      if (p !== dernierPourcent) {
        dernierPourcent = p;
        process.stdout.write(`\r${p} %  ${f.chemin}                    `);
      }
    }
    await new Promise((r) => flux.end(r));

    const taille = fs.statSync(dest).size;
    dejaLa += f.octets;
    console.log(`\n+ ${f.chemin} : ${taille} o attendu ${f.octets} o ${taille === f.octets ? "OK" : "!! ECART !!"}`);
  }

  console.log(`\nTermine en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error("ECHEC :", e);
  process.exit(1);
});
