# Rétrospective — interaction Slopify / agent hôte

Run audité : `7cff4e89-0b8b-4129-9756-bdc1595a2e33` — lot « Signaux d'activité » (tickets #66–#72), lancé le 17 octobre 2026 depuis `.scratch/slopify/signaux-activite-v2/batch.json`, base `b00622b8`, agent `pi` pour les sept tâches.

Résultat : `failed` (exit 2). sa-1 (#68), sa-3 (#66) et sa-6 (#71) intégrées ; sa-2 (#67) et sa-5 (#69) échouées ; sa-4 (#70) et sa-7 (#72) bloquées par dépendance. Reprise possible via `tasks resume` après correction du problème S1.

Sources : `~/.local/share/slopify/task-runs/5a25319d1a72db3c/7cff4e89-0b8b-4129-9756-bdc1595a2e33/` (state.json, `attempts/*/report.md`, `attempts/*/pi-review-results.json`, `attempts/*/stdout.log` et `stderr.log`), état des runs voisins du même store, `sbx ls`, source de `slopify/src/piTaskAdapter.ts`.

## Synthèse

| # | Problème | Sévérité | Catégorie |
|---|----------|----------|-----------|
| S1 | Délégation de revue cassée dans toutes les sandboxes + adjudication non déterministe | critique | checks automatisés |
| S2 | Runs zombies « running » : ni abandon, ni liveness | élevé | accès à l'information |
| S3 | Échec tout-ou-rien : checkpoints verts jetés, resume = tout refaire | moyen | accès à l'information |
| S4 | Chaque appel CLI rebuild le monorepo ; binaire non lié | moyen | économie d'outils |
| S5 | Événements progress verbeux ; nextActions trompeurs | moyen | économie d'outils |
| S6 | Guide coordinateur non pointé depuis AGENTS.md ; chemin du store trompeur | faible | navigation |
| S7 | Sandboxes stopped accumulées, aucun conseil de nettoyage | faible | économie d'outils |

Priorité recommandée : S1 (règle mécanique + sonde préalable, testables sans Docker), puis S2 (abandon + liveness) qui conditionne la confiance dans le store, puis S3 qui ne paie qu'une fois S1 corrigé.

## S1 — La revue indépendante n'a jamais tourné, et le lot l'a validée 3 fois sur 5

L'extension subagent de Pi (1.3.0, `examples/extensions/subagent/index.ts`) a rejeté 146 invocations sur 150 dans ce run — « Invalid parameters. Provide exactly one mode ». C'est la branche `modeCount !== 1` de l'extension : les paramètres `agent`, `task` et `tasks` n'atteignent jamais `execute()`, quelle que soit la forme d'appel documentée (single, parallel, chain).

Rejets par tentative (`pi-review-results.json`) :

- sa-1 : 18 rejets / 20 appels — statut final `succeeded`
- sa-3 : 17 / 19 — `succeeded`
- sa-6 : 17 / 17 — `succeeded`
- sa-2 : 37 / 37 — `failed`
- sa-5 : 57 / 57 — `failed`

Aucune revue indépendante n'a donc jamais été exécutée dans ce run. Deux défaillances en cascade :

1. **Détection absente.** L'extension répond `isError: false`, donc le diagnostic `pi_subagent_error` de `slopify/src/piTaskAdapter.ts` (déclenché sur `isError === true`) ne s'est jamais émis. Le store contient la preuve complète du problème sans jamais le signaler comme issue du run.
2. **Adjudication laissée à l'honnêteté de l'agent.** La règle du harness « Missing or invalid verdicts fail the task » n'est mécanisée nulle part. Sur des preuves identiques, trois tâches ont été marquées `succeeded` et deux `failed` — sa-2 et sa-5 pour avoir déclaré honnêtement le manquement (rapports : « échec de mécanisme de délégation, pas une omission de ma part »). Le même état du monde produit deux verdicts opposés : la porte de validation est un pile ou face.

Corrections, de la moins chère à la plus structurelle :

- **Règle mécanique dans l'adaptateur** : si tous les résultats de revue collectés ont `details.results` vide ou contiennent « Invalid parameters », émettre un diagnostic `review_delegation_broken` au niveau du run et refuser l'intégration. Test unitaire sur les événements déjà parsés — couvert par la CI existante (build + test) sans Docker.
- **Sonde préalable** : un appel subagent canari vers `standards` au démarrage de la sandbox, avant d'engager une demi-heure de travail. Échec de la sonde = échec immédiat et diagnostiqué, au lieu de 146 appels gaspillés puis un verdict aléatoire.
- **Cause racine** : pourquoi les arguments d'appel d'outil sont dépouillés entre le modèle et `execute()` dans Pi 1.3.0. À épingler sur une version connue bonne ou à vendoriser — l'extension n'est qu'un « exemple » du paquet installé.

## S2 — Trois runs sur quatre sont des zombies « running »

`2ea4a2d5`, `1ff89307` et `44fcc7d6` sont tous marqués `running` dans le store alors qu'ils sont morts. Le stderr de la tentative du premier se termine par « The operation was aborted » sans qu'aucun état ne soit sauvegardé : l'interruption brute laisse l'état en cours. La documentation renvoie ensuite le fardeau à l'agent hôte (« vérifier que le précédent processus a terminé ») sans fournir de commande pour le faire — vérification faite à la main via `ps` et `sbx ls` avant de relancer, exactement le risque de contention Docker anticipé.

Corrections : gestionnaire SIGINT/SIGTERM qui marque la tentative `interrupted` avant de sortir ; commande `tasks abandon <run-id>` ; âge de dernière écriture et PID exposés dans `tasks status` pour que le diagnostic de péremption soit auto-service plutôt qu'une enquête hors-bande.

## S3 — Un échec de revue jette une implémentation verte

sa-2 (commit `d76da1b`, 435 tests verts) et sa-5 (`fd85c56`, 450 tests verts) sont complètes et validées mais échouées ; et contrairement aux réussites, leurs tentatives n'ont pas de `checkpoint.bundle` — le travail n'existe que dans les sandboxes retenues. Le `resume` prévu relance chaque tâche entière depuis le prompt (réamorçage de contexte complet) pour un travail déjà fait.

Corrections : persister le checkpoint dès qu'un commit existe, y compris en échec ; ajouter `resume-task --review-only` qui adopte le checkpoint et ne rejoue que la revue — d'autant plus rentable que S1, une fois corrigé, rend la revue rejouable isolément.

## S4 — Chaque appel CLI paie un rebuild du monorepo

`npm run slopify --` exécute `npm run build -w slopify` (quatre bibliothèques + `tsc --incremental false`) avant chaque commande, y compris les `tasks status` de consultation ; le binaire global n'est pas lié (`npm link -w slopify` de la doc jamais exécuté). Contournement utilisé : appeler `node slopify/dist/src/cli.js` directement. Un chemin rapide documenté (binaire lié, ou appel direct du dist à jour) supprime ce coût à chaque consultation.

## S5 — Événements progress verbeux, nextActions trompeurs

Chaque ligne `progress` sur stderr embarque la liste complète des tâches, toutes les issues et tous les nextActions (~2,5–4 Ko) à chaque changement d'état ; l'agent hôte qui poll lit l'état entier dix fois pour un delta d'un champ. Pendant que sa-1 et sa-3 tournaient, nextActions proposait « Explicitly retry task sa-1 » — une relance pour une tâche active.

Corrections : deltas par événement (uniquement les champs changés) ; supprimer les propositions de retry pour les tâches `running` (offrir l'inspection à la place). C'est le problème que les tickets #66–#72 cherchent à résoudre côté exécution ; le constater en tant que consommateur en est la meilleure justification.

## S6 — Navigation

AGENTS.md pointe l'issue tracker, le triage et le domaine, mais rien n'indique que lancer un lot Slopify passe par `docs/agents/coordinator-pi.md` (trouvé via le README). Une ligne de pointer dans AGENTS.md corrige. Au passage : la doc situe le store à `~/.local/share/slopify/task-runs/`, mais les runs vivent dans un sous-répertoire par cwd (`5a25319d1a72db3c/`) — le chemin documenté ne montre rien.

## S7 — Hygiène Docker

`sbx ls` montre plus de quinze sandboxes stopped accumulées (smoke tests, runs morts), certaines avec workspaces disparus. Rien dans la doc ni dans nextActions ne suggère `sbx prune` ou un TTL ; le risque de contention grandit silencieusement à chaque run.

## État du lot et suite

Le run `7cff4e89` reste relançable : `tasks resume` rejouera sa-2 et sa-5 puis débloquera sa-4 et sa-7 — mais tant que S1 n'est pas corrigé, la revue rejouée échouera de la même façon. Recommandation : corriger S1 avant toute reprise.

Commande de reprise (après correction S1) :

```bash
node slopify/dist/src/cli.js tasks resume 7cff4e89-0b8b-4129-9756-bdc1595a2e33 \
  --cwd /Users/dhuyet/Documents/POC/Slopify \
  --store ~/.local/share/slopify/task-runs/5a25319d1a72db3c --json
```
