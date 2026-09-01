# Traductions cote a cote — texte integral, aucune retouche

Releve le 2026-08-31. Candidat A = API Translator de Chrome 151.0.7922.174,
console de `test-traduction-a3.html`. Candidat B = Xenova/nllb-200-distilled-600M q8
dans un Web Worker, console de `test-traduction-nllb.html`.

Aucun jugement de qualite n'est porte ici : ce fichier ne contient que les sorties.

---

## fr->en

### Source (transcription Parakeet de `test/extrait-fr-dur.wav`)

> La mort de mes premières étoiles, les trous noirs supermassifs se sont nourris pendant des milliards d'années de matière, de gaz, d'étoiles parfois, ou même d'autres trou noirs. La surface d'un trou noir marque l'espace, à l'intérieur duquel matière et lumière restent piégées sans espoir de retour. C'est l'horizon des événements. Autour d'eux. La matière tourbillonne avant de disparaître à tout jamais. Elle dessine un contour qui dévoile l'invisible.

### Candidat A — API Translator (207 ms)

> The death of my first stars, the supermassive black holes fed on billions of years of matter, gas, stars sometimes, or even other black holes. The surface of a black hole marks the space, inside which matter and light remain trapped without hope of return. This is the horizon of events. around them. The material swirls before disappearing forever. She draws an outline that reveals the invisible.

### Candidat B — NLLB-200 600M q8 (27958 ms)

> The death of my first stars, supermassive black holes have been feeding for billions of years on matter, gas, stars sometimes, or even other black holes. The surface of a black hole marks the space, inside which matter and light remain trapped with no hope of returning. It's the event horizon. Around them. Matter swirls before it disappears forever. It draws a contour that reveals the invisible.

---

## en->fr

### Source (transcription Parakeet de `test/extrait-fr-dur.wav`)

> it possible to detect these mergers are very new, so we're currently discovering a lot of exciting things. Like two massive black holes that we detected in a galaxy 17 billion light years away. As they spun around each other violently, they released more energy in the form of gravitational waves than the combined light from all the stars in the Milky Way in 4400 years. The new black hole they formed is about the size of Germany and is 142 solar masses. And here we hit a curious gap in scale there are lots of black holes up to 150 solar masses and then there's nothing for a long time. Until we suddenly hit black holes that are millions of times more

### Candidat A — API Translator (207 ms)

> Il est possible de détecter que ces fusions sont très nouvelles, nous découvrons donc actuellement beaucoup de choses passionnantes. Comme deux énormes trous noirs que nous avons détectés dans une galaxie à 17 milliards d'années-lumière. Alors qu'ils se tournaient violemment, ils libèrent plus d'énergie sous forme d'ondes gravitationnelles que la lumière combinée de toutes les étoiles de la Voie lactée en 4400 ans. Le nouveau trou noir qu'ils ont formé a à peu près la taille de l'Allemagne et est de 142 masses solaires. Et ici, nous atteignons un curieux écart d'échelle, il y a beaucoup de trous noirs jusqu'à 150 masses solaires, puis il n'y a rien pendant longtemps. Jusqu'à ce que nous atteignions soudainement des trous noirs qui sont des millions de fois plus

### Candidat B — NLLB-200 600M q8 (58992 ms)

> Les deux trous noirs massifs que nous avons détectés dans une galaxie à 17 milliards d'années-lumière de distance. Ils se sont tournés les uns autour des autres avec violence, ils ont libéré plus d'énergie sous la forme d'ondes gravitationnelles que la lumière combinée de toutes les étoiles de la Voie lactée en 4400 ans. Le nouveau trou noir qu'ils ont formé est de la taille de l'Allemagne et est de 142 masses solaires. Et ici, nous avons atteint un écart curieux dans l'échelle il y a beaucoup de trous noirs jusqu'à 150 masses solaires et il n'y a rien pendant longtemps. jusqu'à ce que nous avons soudainement frappé des trous noirs qui sont des millions de fois plus

---

## fr->ar

### Source (transcription Parakeet de `test/extrait-fr-dur.wav`)

> La mort de mes premières étoiles, les trous noirs supermassifs se sont nourris pendant des milliards d'années de matière, de gaz, d'étoiles parfois, ou même d'autres trou noirs. La surface d'un trou noir marque l'espace, à l'intérieur duquel matière et lumière restent piégées sans espoir de retour. C'est l'horizon des événements. Autour d'eux. La matière tourbillonne avant de disparaître à tout jamais. Elle dessine un contour qui dévoile l'invisible.

### Candidat A — API Translator (240 ms)

> موت نجومي الأولى ، الثقوب السوداء الهائلة التي تتغذى على مليارات السنين من المادة ، الغاز ، النجوم أحيانًا ، أو حتى الثقوب السوداء الأخرى. ويشير سطح الثقب الأسود إلى المساحة التي تظل فيها المادة والضوء محاصرة دون أمل في العودة. هذا هو أفق الأحداث. من حولهم. تدور المادة قبل أن تختفي إلى الأبد. إنها ترسم مخططًا يكشف غير المرئي.

### Candidat B — NLLB-200 600M q8 (39600 ms)

> عندما ماتت أول نجومي، تناولت الثقوب السوداء الكبيرة المليارات من المادة والغاز والنجوم في بعض الأحيان، أو حتى الثقوب السوداء الأخرى، ويحدد سطح الثقب الأسود الفضاء، حيث يبقى المادة والضوء محاصرين فيه دون أي أمل في العودة. هذا هو أفق الأحداث. حولهم.

