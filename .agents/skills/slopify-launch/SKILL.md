---
name: slopify-launch
description: Choisir et lancer le niveau Slopify adapté à une demande.
---

# Routage et lancement Slopify

Utiliser cette skill lorsqu’un utilisateur demande de lancer Slopify, de
choisir un niveau, ou de faire exécuter une demande par un pipeline.

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

Un niveau explicitement demandé par l’utilisateur est prioritaire. Vérifier
qu’il existe dans la sortie de `list --json`, l’utiliser tel quel et ne jamais
le remplacer silencieusement par un autre. S’il est absent, arrêter avec la
liste des niveaux disponibles.

Pour une sélection déduite de la demande, annoncer le niveau retenu, sa
justification et ses prérequis avant une opération mutante. Une demande qui
nomme clairement un niveau et demande de le lancer constitue déjà
l’autorisation d’exécution.

## Lancer

Après sélection, exécuter uniquement le pipeline demandé ou retenu :

```text
slopify run <niveau> "<demande confirmée>" --agent "<agent configuré>" --cwd <workspace>
```

Utiliser `npm run slopify -- run ...` lorsque le binaire local est nécessaire.
Passer les arguments séparément ou avec un échappement shell sûr.
Le pipeline ne porte plus le choix de l’agent : `--agent` est obligatoire pour
`run` et sélectionne un nom défini dans `.acp/acp-agents.json`. Tous les nœuds
agent du pipeline utilisent ce choix, quel que soit leur transport. Pour
`resume`, fournir le même `--agent` afin de reconstruire le programme après un
redémarrage du processus :

```text
slopify resume <run-id> --agent "<agent configuré>" --cwd <workspace>
```

Utiliser la clé exacte de `agents` dans
`<workspace>/.acp/acp-agents.json` (par exemple `Codex CLI` ou
`Codex Sandbox`). Ne pas réintroduire `agent:` dans les fichiers
`.acp/pipelines/*.yaml` pour choisir un transport.

`--yes` approuve les pauses ordinaires uniquement ; il ne valide jamais une
promotion finale. Après une erreur, ne pas reprendre, annuler, relancer ou
changer de niveau automatiquement. Proposer ces actions sur demande explicite.

## Portée

Le prompt transmis doit rester limité à l’objectif, aux fichiers concernés et
aux critères de validation annoncés. Cette skill route et lance les pipelines ;
elle ne modifie pas le code applicatif.
