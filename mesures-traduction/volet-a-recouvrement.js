// VOLET A — « la traduction a-t-elle vraiment eu lieu ? »
//
// Si rien n'etait traduit, rien ne changerait a l'ecran pour qui ne regarde pas
// de pres. On COMPTE donc : combien de mots du texte AFFICHE existent, a
// l'identique, dans le texte d'origine ?
//
// Sur une vraie traduction ce doit etre une petite minorite -- il reste les noms
// propres, les chiffres, et les quelques mots que les deux langues partagent.
// Si presque tout est identique, le texte n'a pas ete traduit.
const fs = require("fs");

const norme = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const fichier = process.argv[2];
const d = JSON.parse(fs.readFileSync(fichier, "utf8"));

const motsOrigine = new Set();
for (const b of d.blocs) for (const m of norme(b.texteOrigine).split(/\s+/)) if (m) motsOrigine.add(m);

let total = 0, identiques = 0;
const trouves = [];
for (const b of d.blocs) {
  for (const m of norme(b.texte).split(/\s+/)) {
    if (!m) continue;
    total++;
    if (motsOrigine.has(m)) { identiques++; trouves.push(m); }
  }
}

console.log(`fichier            : ${fichier}`);
console.log(`paire              : ${d.traduction ? d.traduction.source + " -> " + d.traduction.cible : "AUCUNE"}`);
console.log(`blocs              : ${d.nbBlocs}`);
console.log(`mots affiches      : ${total}`);
console.log(`presents tels quels dans l'original : ${identiques} (${((identiques / total) * 100).toFixed(1)} %)`);
console.log(`les voici          : ${[...new Set(trouves)].join(", ") || "(aucun)"}`);
