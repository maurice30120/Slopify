# Tests et smoke tests V2

## Suite automatisée (CI et poste développeur)

```bash
npm ci
npm run build
npm test
```

`npm test` est **déterministe et sans Docker ni identifiants Pi/Codex** : les tests pilotent de vrais dépôts Git temporaires et des agents/`sbx` simulés. La CI GitHub Actions lance uniquement cette suite et le build, **jamais** les smoke tests réels.

Le runner `scripts/run-tests.mjs` lance chaque suite de package dans son propre groupe de processus POSIX. Après l'exécution, il détecte également les descendants réaffectés au PID 1 et les zombies encore présents dans ce groupe. Toute fuite fait échouer la suite ; les processus encore vivants reçoivent SIGTERM puis SIGKILL. Les zombies déjà orphelins ne peuvent pas être récoltés par Slopify : seul leur parent (souvent le PID 1) peut appeler `wait`. C'est pourquoi les tests doivent **toujours** attendre la fin de leurs enfants et enregistrer un nettoyage via `t.after` pour chaque processus asynchrone ou minuterie. Un simple `kill` sans `wait` n'est pas une solution.

### Vérification ciblée avant la suite complète

```bash
npm run build
npm run test -w @slopify/task-batches -- dist/test/localMode.test.js
npm test
```

Toujours commencer par le test le plus ciblé qui couvre le changement. Ne lancer la suite complète qu'après les tests ciblés et avant une livraison ; ne pas la relancer en boucle si le conteneur de travail atteint sa limite de processus.

Si `Cannot fork` ou `pthread_create` apparaît dans un environnement de développement saturé, arrêter immédiatement les relances, pousser le commit sur une branche et consulter les contrôles de CI de la PR. N'essayez pas d'effacer au hasard les processus du système ni de tuer PID 1.

### Tests sensibles à l'environnement

Ces tests sont verts en CI (Linux et macOS) mais peuvent échouer isolément dans un conteneur contraint (CPU partagé, scheduling lent) :

- `localMode` : « aborting a real local Pi launcher stops its descendant process group » — surveille un groupe de processus POSIX réel ; un état `unknown` dans un conteneur fait échouer l'assertion `dead`.
- `taskWaves` : les deux « twelve ready mixed-agent tasks refill available capacity » — capacité concurrente sensible aux performances.
- `taskActivityTick` : « le tick se tait sans tâche active ni intégration » — l'assertion `firedTicks >= 3` court contre un hook Git `sleep 0.3` réel.

Réflexe : échec isolé de l'un de ces tests + CI verte sur la PR = environnement, pas régression. Ne pas itérer localement ; pousser et laisser la CI juger.

### Comparer avec une baseline proprement

`git stash` ne recompile pas `dist/` : un test lancé juste après un stash exécute encore le code compilé des changements retirés, ce qui produit une fausse baseline. Toujours relancer `npm run build` entre le stash et le test, puis restaurer et rebuilder avant de continuer.

## Smoke tests réels — **uniquement en local sur le poste de développement**

Ces commandes ne font pas partie de `npm test` ni de `.github/workflows/ci.yml`. Elles consomment de vrais appels fournisseurs et préservent les logs/preuves dans un dépôt temporaire.

```bash
# Pi/Codex natifs, aucun Docker :
npm run smoke:local

# Pi/Codex dans Docker Sandboxes (sbx installé et actif) :
npm run smoke:docker
```

Les deux smoke tests utilisent `--mode` explicite, vérifient le résultat Git, les checkpoints et l'absence de changement dans le workspace hôte. Le répertoire de preuves est affiché au lancement et conservé même en cas d'échec. Ils sont lancés **manuellement** sur le Mac, en dernier ressort pour valider les intégrations réelles, jamais automatiquement dans la CI.

## Validations de la revue finale

Un lot peut définir ses commandes de validation avec le champ facultatif
`validationCommands` de `batch.json` :

```json
{
  "specFile": "spec.md",
  "validationCommands": ["python3 -m unittest discover"],
  "tasks": [
    {
      "id": "implement",
      "agent": "codex",
      "prompt": "Implémenter le ticket selon la spec.",
      "source": "ticket.md",
      "dependsOn": []
    }
  ]
}
```

Chaque commande est une chaîne non vide sur une seule ligne, à exécuter par
l'agent de revue depuis la racine du dépôt. La liste explicite est non vide ; les
retours à la ligne et les octets NUL sont refusés. Un échec de commande ou un
prérequis manquant impose un verdict d'échec, même si les fichiers produits
semblent corrects. Ces instructions ne constituent pas un nouveau runner de
commandes côté Controller : les sorties réelles de l'agent restent les preuves
à examiner.

La liste et le prompt de revue sont figés à la création du run ; modifier le
batch source ne change pas les validations d'une reprise. Sans liste explicite,
la revue utilise les commandes documentées dans les instructions, guides et
manifests versionnés au commit de base du run, puis vérifie les critères de la
spec. Un dépôt sans infrastructure de build/test est décrit factuellement avec
les vérifications réellement effectuées ; aucune commande npm n'est présumée.
Les anciens états conservent leur prompt de revue déjà persisté.

## Validation des processus et reprises sur macOS/Linux

La surveillance des agents locaux utilise une identité du processus et un groupe POSIX
propre à la tentative. La présence d'un PID n'est pas une preuve suffisante : sa
création peut avoir été réutilisée par un autre processus. L'inspection renvoie
`alive`, `dead` ou `unknown`. En cas d'état incertain, `resume` et `resume-task`
**refusent** d'ouvrir une nouvelle tentative ; les logs et clones conservés
permettent une inspection manuelle. Les tentatives réussies possèdent leurs
checkpoints/bundles et ne doivent pas rejouer l'agent à la reprise.

Si le lanceur a été tué sans pouvoir exécuter de nettoyage (SIGKILL, coupure),
examiner l'ancien processus **et ses descendants** avant toute relance. Le verrou
`.resume-lock` d'un run interdit deux reprises concurrentes : si son propriétaire
n'est pas prouvé mort ou si le fichier de métadonnées manque, ne pas forcer
la reprise et inspecter le run. Une preuve absente n'est jamais interprétée
comme une confirmation d'arrêt.

Sur macOS, utiliser le script d'installation dans un shell zsh et les tests de
processus locaux ciblés sans fournisseurs. Les smokes réels restent manuels
et sont **distincts** du job macOS automatisé sans Docker.
