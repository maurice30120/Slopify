---
name: slopify-launch
description: Choisir et lancer le pipeline Slopify le plus léger adapté à une demande, en respectant les pipelines explicitement imposés.
---

# Routage et lancement Slopify

Utiliser ce skill lorsqu’un utilisateur demande de lancer Slopify, de choisir un
pipeline, ou de faire exécuter une demande par un pipeline. Ce skill est un
routeur et un guide de lancement : il ne modifie pas le code applicatif, ne
crée pas de pipeline et ne remplace pas la demande explicite de l’utilisateur.

## Choisir le pipeline

1. Identifier l’étape de la demande : nouvelle demande, ticket déjà approuvé,
   ou revue d’une livraison existante.
2. Depuis la racine du workspace, vérifier les pipelines réellement disponibles
   avec `slopify list --json --cwd <workspace>`. Dans ce dépôt, utiliser
   `npm run slopify -- list --json --cwd <workspace>` si le binaire `slopify`
   n’est pas installé globalement.
3. Lire [pipeline-choice.md](references/pipeline-choice.md), puis appliquer ses
   prérequis et exclusions aux pipelines retournés par la commande.
4. Choisir le pipeline le plus léger qui couvre clairement la demande. Le
   nombre de nœuds, la présence d’agents sandbox et la durée approximative ne
   justifient pas à eux seuls un pipeline plus lourd si ses étapes ne sont pas
   nécessaires.

Un pipeline explicitement demandé par l’utilisateur est prioritaire. Vérifier
qu’il existe dans la sortie de `list --json`, l’utiliser tel quel et ne jamais
le remplacer silencieusement par un autre. S’il est absent, arrêter avec la
liste des pipelines disponibles ; ne pas choisir un repli.

Pour une sélection déduite de la demande, annoncer le pipeline retenu, sa
justification et ses prérequis, puis obtenir la confirmation explicite avant
de lancer une opération mutante. Une demande qui nomme clairement un pipeline
et demande de le lancer constitue déjà l’autorisation d’exécution ; ne pas
ajouter une confirmation redondante.

## Garde-fou pour les petites demandes

Une modification simple d’un fichier, comme ajouter quelques commentaires ou
un test ciblé, ne doit jamais déclencher silencieusement le pipeline complet.
Dans le dépôt actuel, aucun pipeline léger générique n’est disponible :
`grill-spec-tickets-implement-review` est le seul point d’entrée général pour
une nouvelle demande. Dans ce cas, signaler explicitement que le pipeline
disponible est surdimensionné et demander si l’utilisateur veut le lancer ou
préférer une implémentation directe hors Slopify.

Si l’utilisateur n’a pas demandé de lancement Slopify, ne pas utiliser ce skill
pour une modification directe ; laisser le flux d’implémentation approprié
prendre le relais.

## Lancer

Après confirmation, exécuter uniquement le pipeline sélectionné avec l’interface
CLI actuelle :

```text
slopify run <pipeline-id> "<demande confirmée>" --cwd <workspace>
```

Utiliser la variante `npm run slopify -- run ...` lorsque le binaire local est
nécessaire. Passer les arguments séparément ou avec un échappement shell sûr ;
ne jamais interpoler le texte utilisateur comme du code shell. Ne pas inventer
les options `catalog`, `--brief` ou d’autres commandes absentes de la CLI
actuelle.

`--yes` peut approuver les pauses d’approbation ordinaires uniquement ; il ne
valide jamais la promotion finale. Ne pas reprendre, annuler, relancer ou
changer de pipeline automatiquement après une erreur ou une absence d’activité.
Proposer ces actions uniquement sur demande explicite de l’utilisateur.

## Contrôle de portée

Avant le lancement, vérifier que le prompt reste limité à l’objectif confirmé,
aux fichiers concernés et aux critères de validation annoncés. Le skill ne doit
pas demander au pipeline de toucher à des fichiers sans rapport ni transformer
une petite tâche en spécification et découpage complets sans l’expliquer.
