// Telecharge le modele Parakeet depuis Hugging Face vers models/.
//
// Pourquoi ce script existe : les 640 Mo de poids ne sont PAS dans le depot
// (voir .gitignore). Quelqu'un qui clone le projet n'a donc pas le modele, et
// l'extension le lui dit maintenant en toutes lettres -- avec le nom de cette
// commande. Le message de `offscreen.js` et le nom du script npm doivent rester
// identiques au caractere pres :
//
//     « Lancez « npm run fetch-model » dans le dossier du projet,
//       puis rechargez l'extension. »
//
// ⚠️ C'EST LE SEUL FICHIER DU PROJET QUI PARLE A INTERNET, et il ne tourne que
// quand on le lance a la main. L'extension, elle, ne fait aucune requete
// externe -- ni au demarrage, ni pendant une transcription. C'est l'argument
// central du projet, et il ne tiendrait pas si le telechargement vivait dans
// l'extension.
//
// Meme mecanisme que vendor/ (voir copy-assets.js) : dossier gitignore, rempli
// par un script npm, jamais versionne. La seule difference est la source : ici
// on telecharge, la-bas on copie depuis node_modules.
//
// ⚠️ CE QUI A DISPARU AVEC WHISPER (etape 5) : le choix du depot en argument,
// la table des dtypes (`SUFFIXES`), les fichiers du tokenizer de Transformers.js
// et le sous-dossier `onnx/`. Parakeet n'a qu'un jeu de fichiers, a plat, et
// personne n'a de variante a choisir.

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const DEPOT = "ysdede/parakeet-tdt-0.6b-v3-onnx";
const DOSSIER = path.join(ROOT, "models", "parakeet-tdt-0.6b-v3");

// ---------------------------------------------------------------------------
// LES CINQ FICHIERS, AVEC LEUR TAILLE EXACTE
// ---------------------------------------------------------------------------
//
// ⚠️ LA TAILLE EXACTE EST LE COEUR DE CE SCRIPT, pas une decoration. Elle sert
// trois fois :
//   1. decider s'il y a quelque chose a telecharger (« present » ne suffit pas :
//      un fichier a moitie ecrit est present) ;
//   2. refuser un telechargement incomplet AVANT qu'il ne prenne la place du
//      vrai fichier ;
//   3. servir de denominateur au pourcentage -- et c'est ce qui l'empeche de
//      reculer (voir plus bas).
//
// Valeurs relevees sur le depot lui-meme le 2026-08-30, pas recopiees de
// memoire. Elles doivent rester alignees sur PREP_MODELE_FICHIERS d'offscreen.js
// (les cinq memes noms) : c'est cette liste-la que l'extension verifie au
// demarrage d'une preparation.
const FICHIERS = [
  { nom: "encoder-model.int8.onnx", octets: 652183999 },
  { nom: "decoder_joint-model.int8.onnx", octets: 18202004 },
  { nom: "nemo128.onnx", octets: 137641 },
  { nom: "vocab.txt", octets: 102132 },
  { nom: "config.json", octets: 101 },
];

const TOTAL_ATTENDU = FICHIERS.reduce((somme, f) => somme + f.octets, 0);

function url(fichier) {
  return `https://huggingface.co/${DEPOT}/resolve/main/${fichier}`;
}

function formater(octets) {
  if (octets >= 1024 * 1024) return `${(octets / 1024 / 1024).toFixed(1)} Mo`;
  if (octets >= 1024) return `${Math.round(octets / 1024)} Ko`;
  return `${octets} o`;
}

function tailleSurDisque(chemin) {
  try {
    return fs.statSync(chemin).size;
  } catch (err) {
    return -1; // absent
  }
}

// ---------------------------------------------------------------------------
// LA PROGRESSION, ET POURQUOI ELLE NE PEUT PAS RECULER
// ---------------------------------------------------------------------------
//
// ⚠️ « Le pourcentage de telechargement du modele repart en arriere » est un
// defaut connu, ecrit noir sur blanc dans les notes du projet. Un pourcentage
// qui recule est un pourcentage qui ment, et il ne se corrige pas en le
// bridant : il se corrige en supprimant sa CAUSE.
//
// La cause d'un pourcentage qui recule, c'est toujours un DENOMINATEUR QUI
// CHANGE. On ne prend donc PAS `content-length` de la reponse (qui n'arrive
// qu'apres la redirection, differe d'un miroir a l'autre, et peut manquer) :
// on prend les tailles exactes ecrites plus haut, connues AVANT la premiere
// requete. Le denominateur est une constante.
//
// Le numerateur, lui, est `octetsAcquis` : les octets des fichiers deja valides
// plus ceux recus pour le fichier en cours. Il ne fait que croitre dans un
// passage -- un fichier deja compte n'est jamais retelecharge dans le meme
// passage.
//
// Reste le filet : si malgre tout la valeur baissait, on ne la CACHE pas, on le
// DIT. Une valeur bridee en silence redonnerait exactement le defaut d'origine,
// en le rendant invisible.
let octetsAcquis = 0;
let dernierEntier = -1;
let dernierePourcentage = -1;
let reculsDetectes = 0;

function progresser(nomFichier, forcer = false) {
  const pourcentage = (octetsAcquis / TOTAL_ATTENDU) * 100;

  if (pourcentage < dernierePourcentage - 1e-9) {
    reculsDetectes++;
    console.error(
      `\n⚠️ ANOMALIE : la progression a recule (${dernierePourcentage.toFixed(2)} % → ` +
        `${pourcentage.toFixed(2)} %). C'est un defaut, pas un affichage a corriger.`
    );
  }
  dernierePourcentage = Math.max(dernierePourcentage, pourcentage);

  const entier = Math.floor(pourcentage);
  if (!forcer && entier === dernierEntier) return;
  dernierEntier = entier;

  const ligne =
    `   ${String(entier).padStart(3)} %  ` +
    `${formater(octetsAcquis)} / ${formater(TOTAL_ATTENDU)}  ${nomFichier}`;

  // Sur un vrai terminal on redessine la meme ligne ; sinon (journal, CI, sortie
  // redirigee) on ecrit une ligne par valeur, pour que la suite des valeurs
  // reste LISIBLE et donc verifiable apres coup.
  if (process.stdout.isTTY) process.stdout.write("\r" + ligne + "   ");
  else console.log(ligne);
}

// GET qui suit les redirections : huggingface.co renvoie un 302 vers son CDN.
function telecharger(adresse, temporaire, fichier, sauts = 0) {
  return new Promise((resolve, reject) => {
    if (sauts > 5) return reject(new Error("trop de redirections"));

    const requete = https.get(
      adresse,
      { headers: { "User-Agent": "LiveSub/1.0" } },
      (reponse) => {
        const code = reponse.statusCode;

        if (code >= 300 && code < 400 && reponse.headers.location) {
          reponse.resume(); // vider la reponse, sinon la socket reste ouverte
          // `location` peut etre RELATIF (huggingface.co le fait) : on le resout
          // par rapport a l'adresse courante, sinon on obtient « Invalid URL ».
          const suivante = new URL(reponse.headers.location, adresse).href;
          return resolve(telecharger(suivante, temporaire, fichier, sauts + 1));
        }
        if (code !== 200) {
          reponse.resume();
          return reject(new Error(`HTTP ${code}`));
        }

        // ⚠️ On ecrit dans « .part » et on ne renomme QU'APRES verification de la
        // taille. Une coupure de reseau, un Ctrl-C, une panne de courant : il
        // reste un « .part » que personne ne prendra pour le vrai fichier, et le
        // passage suivant le refera. Sans ca, un fichier tronque porterait le bon
        // nom et l'extension chargerait des poids incomplets.
        const sortie = fs.createWriteStream(temporaire);
        const depart = octetsAcquis;

        // ⚠️ NOTRE PROPRE COMPTEUR, PAS `sortie.bytesWritten`. Ce dernier suit
        // ce qui est REELLEMENT parti sur le disque, donc il retarde sur ce qui
        // est recu et n'avance pas au meme rythme que les evenements « data ».
        // L'utiliser ici ferait osciller le total -- c'est-a-dire reculer le
        // pourcentage, exactement le defaut qu'on est en train de corriger.
        // `recus` ne fait qu'additionner des longueurs de morceaux : il ne peut
        // pas decroitre.
        let recus = 0;
        reponse.on("data", (morceau) => {
          recus += morceau.length;
          octetsAcquis = depart + recus;
          progresser(fichier.nom);
        });

        reponse.on("error", (err) => {
          sortie.destroy();
          reject(err);
        });

        sortie.on("error", (err) => reject(err));
        sortie.on("finish", () => sortie.close(() => resolve(depart)));

        reponse.pipe(sortie);
      }
    );

    requete.on("error", reject);
    // Un reseau qui ne repond plus doit echouer, pas suspendre le script pour
    // toujours : sans ce delai, `npm run fetch-model` peut rester muet des
    // heures et ressembler a un blocage du script lui-meme.
    requete.setTimeout(60000, () => {
      requete.destroy(new Error("aucune reponse du serveur pendant 60 s"));
    });
  });
}

async function recuperer(fichier) {
  const destination = path.join(DOSSIER, fichier.nom);
  const temporaire = destination + ".part";
  const taille = tailleSurDisque(destination);

  // ⚠️ « DEJA LA » VEUT DIRE « DE LA BONNE TAILLE », pas « existe ». Un fichier
  // tronque a la moitie existe, lui aussi -- et le passer serait exactement la
  // panne qu'on veut eviter : le script jurerait que tout est en place pendant
  // que l'extension refuserait de demarrer.
  if (taille === fichier.octets) {
    octetsAcquis += fichier.octets;
    console.log(`  ⏭️  deja la  ${fichier.nom} (${formater(taille)}, taille exacte)`);
    progresser(fichier.nom, true);
    return false;
  }
  if (taille >= 0) {
    console.log(
      `  ♻️  a refaire ${fichier.nom} : ${formater(taille)} sur le disque, ` +
        `${formater(fichier.octets)} attendus`
    );
  }

  console.log(`  ⬇️  ${fichier.nom} (${formater(fichier.octets)})`);
  fs.mkdirSync(DOSSIER, { recursive: true });
  fs.rmSync(temporaire, { force: true });

  const depart = octetsAcquis;
  try {
    await telecharger(url(fichier.nom), temporaire, fichier);
  } catch (err) {
    fs.rmSync(temporaire, { force: true });
    octetsAcquis = depart;
    throw new Error(`${fichier.nom} : ${err.message}`);
  }

  // La verification, sur le « .part », AVANT qu'il ne prenne le nom du vrai
  // fichier. Un fichier de la mauvaise taille n'atteint jamais le disque sous
  // son vrai nom.
  const obtenue = tailleSurDisque(temporaire);
  if (obtenue !== fichier.octets) {
    fs.rmSync(temporaire, { force: true });
    octetsAcquis = depart;
    throw new Error(
      `${fichier.nom} : telechargement incomplet (${obtenue} octets recus, ` +
        `${fichier.octets} attendus). Le fichier a ete supprime.`
    );
  }

  fs.renameSync(temporaire, destination);
  octetsAcquis = depart + fichier.octets;
  progresser(fichier.nom, true);
  if (process.stdout.isTTY) process.stdout.write("\n");
  return true;
}

(async () => {
  const debut = Date.now();
  console.log(`📦 Modele Parakeet TDT 0.6B v3 → models/parakeet-tdt-0.6b-v3/`);
  console.log(`   Source : huggingface.co/${DEPOT}`);
  console.log(`   ${FICHIERS.length} fichiers, ${formater(TOTAL_ATTENDU)} au total.\n`);

  let telecharges = 0;
  for (const fichier of FICHIERS) {
    if (await recuperer(fichier)) telecharges++;
  }

  const secondes = (Date.now() - debut) / 1000;
  console.log(
    `\n✅ Modele complet dans models/parakeet-tdt-0.6b-v3/ ` +
      `(${telecharges === 0 ? "rien a telecharger" : `${telecharges} fichier(s) telecharge(s)`}` +
      `, ${secondes.toFixed(1)} s).`
  );
  if (reculsDetectes) {
    console.error(`⚠️ La progression a recule ${reculsDetectes} fois : c'est un defaut a corriger.`);
  }
  console.log("   models/ est gitignore, comme vendor/ : le modele ne part jamais dans git.");
  console.log("   Rechargez maintenant l'extension dans chrome://extensions (🔄).");
})().catch((err) => {
  console.error(`\n❌ Telechargement du modele impossible : ${err.message}`);
  console.error("");
  console.error("   Que faire :");
  console.error("   1. verifiez votre connexion (le script contacte huggingface.co) ;");
  console.error("   2. relancez « npm run fetch-model » : les fichiers deja complets");
  console.error("      sont conserves, seul ce qui manque est repris ;");
  console.error("   3. si ca echoue encore, telechargez les 5 fichiers a la main depuis");
  console.error(`      https://huggingface.co/${DEPOT}/tree/main`);
  console.error(`      et placez-les dans models/parakeet-tdt-0.6b-v3/.`);
  process.exit(1);
});
