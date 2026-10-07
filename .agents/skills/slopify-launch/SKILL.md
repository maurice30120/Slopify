---
name: slopify-launch
description: "Choisir, lancer et suivre l'exécution d'un pipeline Slopify : sélection du niveau, lancement en processus d'arrière-plan, suivi de l'avancement via la sortie et les logs du run, reprise après interruption."
---

# Routage, lancement et suivi Slopify

Utiliser cette skill lorsqu’un utilisateur demande de lancer Slopify, de
choisir un niveau, de faire exécuter une demande par un pipeline, ou de
suivre ou reprendre un run en cours.

## Choisir le niveau

1. Identifier si la demande est nouvelle, fondée sur un ticket approuvé, ou
   une revue d’une livraison existante.
2. Vérifier les pipelines réellement disponibles avec
   `slopify list --json --cwd <workspace>`. Dans ce dépôt, utiliser
   `npm run slopify -- list --json --cwd <workspace>` si le binaire global n’est
   pas installé.
3. Lire [pipeline-choice.md](references/pipeline-choice.md) et appliquer ses
   prérequis.
4. Choisir le niveau le plus léger qui couvre clairement la demande.
5. Si le niveau retenu est `implement-ticket`, vérifier qu’un ticket approuvé
   existe : un fichier `<workspace>/.scratch/<effort>/issues/NN-<slug>.md`.
   Sinon, exécuter d’abord la skill `to-tickets` pour découper la spécification
   en tickets, puis lancer `implement-ticket` sur un ticket créé ; ne jamais
   lancer `implement-ticket` avec une spécification seule.

Un niveau explicitement demandé par l’utilisateur est prioritaire. Vérifier
qu’il existe dans la sortie de `list --json`, l’utiliser tel quel et ne jamais
le remplacer silencieusement par un autre. S’il est absent, arrêter avec la
liste des niveaux disponibles.

Pour une sélection déduite de la demande, annoncer le niveau retenu, sa
justification et ses prérequis avant une opération mutante. Une demande qui
nomme clairement un niveau et demande de le lancer constitue déjà
l’autorisation d’exécution.

## Lancer

Après sélection, lancer uniquement le pipeline demandé ou retenu, en
processus d’arrière-plan (le run est long et interactif ; l’agent doit
pouvoir lire la sortie pendant l’exécution) :

```text
slopify run <niveau> "<demande confirmée>" --agent "<agent configuré>" --cwd <workspace> [--yes] [--json] [--verbose]
```

Utiliser `npm run slopify -- run ...` lorsque le binaire local est nécessaire.
Passer les arguments séparément ou avec un échappement shell sûr.
`--agent` est obligatoire pour `run` et sélectionne un nom défini dans
`<workspace>/.acp/acp-agents.json` (clé exacte de `agents`, par exemple
`Codex CLI` ou `Codex Sandbox`). Tous les nœuds agent du pipeline utilisent
ce choix, quel que soit leur transport. Ne pas réintroduire `agent:` dans les
fichiers `.acp/pipelines/*.yaml` pour choisir un transport.

Dès le démarrage, capturer le run-id : le répertoire `<workspace>/.acp/logs/`
est vidé à chaque lancement puis rempli par le run courant ; le nom du fichier
`<date>-<pipelineId>-<runId>.jsonl` et l’événement `run_started` (première
ligne) portent le run-id. Conserver le run-id et l’identifiant du processus
pour toute la session.

`--yes` approuve les pauses ordinaires uniquement ; il ne valide jamais une
promotion finale. Une pause non approuvée automatiquement bloque le processus
en attente d’une décision : lire la question sur la sortie, la soumettre à
l’utilisateur, puis relancer `resume` ou écrire la réponse au processus selon
le mécanisme du lanceur.

## Suivre l’avancement

Pendant que le processus tourne, consulter deux sources :

1. Sortie incrémentale du processus (stderr), lue au fil de l’eau :
   - `[slopify] Starting ticket N/M: <id>` et `Completed N ticket
     pipeline(s); starting review.` : avancement du découpage en tickets ;
   - `[slopify] <nœud> réfléchit` / `répond` : activité du nœud agent courant ;
   - avec `--verbose` : `[runtime] node_started|node_completed|node_failed
     node=<id>`, un événement par changement d’état d’un nœud.
2. Journal du run : `<workspace>/.acp/logs/<date>-<pipelineId>-<runId>.jsonl`
   (un fichier par nœud agent : `<même préfixe>-<nodeId>-<agent>.jsonl`).
   Chaque ligne est un événement horodaté. Le dernier `runtime_event` de type
   `node_started` désigne le nœud actif ; `node_completed` et `node_failed`
   cumulent l’avancement réalisé.

Le run est terminé quand le processus atteint son état final : `--json`
imprime `{ runId, status, artifact?, error? }` avec `status` parmi
`completed`, `rejected`, `cancelled`, `failed` ; `error.nodeId` identifie le
nœud en échec. Relayer à l’utilisateur les changements de phase (nouveau
nœud, nouveau ticket, pause, échec), et non chaque ligne de log.

## Reprendre

Après une interruption du processus, relancer le même run avec le même
`--agent` (il reconstruit le programme après un redémarrage) :

```text
slopify resume <run-id> --agent "<agent configuré>" --cwd <workspace>
```

Après une erreur, ne pas reprendre, annuler, relancer ou changer de niveau
automatiquement. Proposer ces actions sur demande explicite.

## Portée

Le prompt transmis doit rester limité à l’objectif, aux fichiers concernés et
aux critères de validation annoncés. Cette skill route, lance et suit les
pipelines ; elle ne modifie pas le code applicatif.
