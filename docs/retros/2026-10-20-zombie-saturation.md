# Rétro : incident des zombies Git (saturation du bac à sable)

**Session** : implémentation du mode local (#145-147) puis tentative des tranches packages (#139+).
**Date** : 2026-10-20.

## Chronologie factuelle

1. Le test d'interruption « processus survivant » (#147) lançait un faux agent `codex` contenant `sleep 30 & wait` pour survivre au lanceur. Une itération a laissé des processus vivants derrière elle.
2. Chaque exécution de la suite complète de tests (~3000 forks `git` via `execFileSync`/`spawnSync`) interrompue a accumulé des enfants git reparentés au PID 1 du sandbox, qui ne les récolte pas → zombies.
3. Vers 7 800 zombies, le plafond cgroup (`pids` ≈ 7 850) a été atteint : `fork()` puis `pthread_create()` ont échoué — plus aucune compilation tsc, plus aucun test, plus aucun `gh`.
4. Une réinitialisation du sandbox a tout nettoyé, mais a aussi remis le checkout sur main : la branche locale et les fichiers non poussés auraient été perdus sans le push préalable.

## Constatés par ordre de sévérité

### 1. Automated checks — les tests qui forkent n'ont aucun plafond ni garde-fou (racine)

La suite fait des milliers de forks git sans limite ; un test de reprise a volontairement spawné un processus persistant sans garantie d'arrêt par `t.after`. Dans un environnement à plafond de processus partagé, un seul test à moitié raté empoisonne l'instance entière.

- Fix déterministe : forcer chaque test qui spawn des processus à les arrêter dans `t.after` ; proscrire tout processus qui survit au test. Le test fauteur a été réécrit (forge l'état `running` au lieu de spawner un survivant) — auditer les autres fixtures dans le même sens.
- Deuxième ligne de défense : un wrapper de runner qui, en fin de suite, détecte tout descendant encore vivant et échoue la suite — transforme une fuite de processus en échec visible plutôt qu'en panne d'environnement diffuse.

### 2. Automated checks — la CI existe mais l'agent ne peut pas s'y réfugier

`.github/workflows/ci.yml` tourne `npm ci && npm run build && npm test` sur chaque PR — elle aurait validé les tests que le sandbox n'a pas pu exécuter. Mais rien ne dit à l'agent : « si l'environnement local est saturé, pousse et laisse la CI trancher ». L'agent a brûlé ~10 tours d'outils à lutter contre les zombies (pkill, prlimit, SIGCHLD au PID 1…), chacun condamné.

- Fix : une ligne dans `docs/agents/` : « En cas de saturation de processus du bac à sable (`Cannot fork`, `pthread_create` en échec), ne pas chercher à assainir : pusher et vérifier via `gh pr checks`. »

### 3. Navigation — le coût réel de la saturation invisible

Le diagnostic complet a demandé plusieurs tours d'outils. Rien ne signale au départ de run que le sandbox a un plafond de ~7 850 processus, zombies inclus, et qu'un run de test complet dépense une ressource finie et non renouvelable quand il est interrompu.

- Fix : une note dans `docs/agents/coordinator-pi.md` : plafond de processus du bac à sable, préférer le test ciblé par fichier, ne pas relancer en boucle après `Cannot fork`.

### 4. Tool economy — la suite complète comme seul mode de vérification

La suite complète (~10 minutes, des milliers de forks) a été relancée intégralement après chaque tranche, parfois plusieurs fois après des échecs d'environnement. Le test ciblé par fichier aurait suffi pour la plupart des itérations. La règle « narrowest useful test first » était juste, appliquée trop tard.

### 5. Information access — un état n'existe que s'il est poussé

Le push après chaque commit a sauvé la livraison complète lors de la réinitialisation du sandbox. Un commit sans push n'est pas un livrable dans un environnement non contrôlé.

## Ce qui a bien marché (à conserver)

- Le diagnostic par instrumentation du code compilé (timestamps `LAUNCH`/`DONE` dans les tests) a identifié en 2 essais que le test `taskWaves` en échec était un faux positif de lenteur, pas un bug produit.
- La réécriture du test « survivant » en test sans fork persistant teste le même contrat (`isLocalProcessAlive`) sans aucun risque d'empoisonnement.

## Actions concrètes (par coût croissant)

1. Ligne `docs/agents/` : procédure « saturation → push + CI, ne pas lutter » (~0 contexte permanent).
2. Audit des fixtures de test : `t.after` de nettoyage pour tout spawn, interdiction des processus qui survivent au test.
3. Wrapper de runner avec détection de fuite de descendants en fin de suite.
