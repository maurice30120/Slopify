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

## Smoke tests réels — **uniquement en local sur le poste de développement**

Ces commandes ne font pas partie de `npm test` ni de `.github/workflows/ci.yml`. Elles consomment de vrais appels fournisseurs et préservent les logs/preuves dans un dépôt temporaire.

```bash
# Pi/Codex natifs, aucun Docker :
npm run smoke:local

# Pi/Codex dans Docker Sandboxes (sbx installé et actif) :
npm run smoke:docker
```

Les deux smoke tests utilisent `--mode` explicite, vérifient le résultat Git, les checkpoints et l'absence de changement dans le workspace hôte. Le répertoire de preuves est affiché au lancement et conservé même en cas d'échec. Ils sont lancés **manuellement** sur le Mac, en dernier ressort pour valider les intégrations réelles, jamais automatiquement dans la CI.
