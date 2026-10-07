---
name: issue-tracker
description: "Conventions du tracker local en Markdown de Slopify : structure .scratch/<feature>/, spec, tickets numérotés, statuts de triage et vocabulaire des étiquettes."
display_name: Issue Tracker Slopify
icon: book
---

# Tracker local : issues et specs en Markdown

Les issues et les spécifications d'un workspace Slopify vivent dans des
fichiers Markdown sous `.scratch/`. Ces conventions servent de vocabulaire
aux skills `to-spec` et `to-tickets`.

## Structure

- Une fonctionnalité par répertoire : `.scratch/<feature-slug>/`.
- La spécification : `.scratch/<feature-slug>/spec.md`.
- Les tickets d'implémentation : un fichier par ticket dans
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numérotés depuis `01`,
  jamais un fichier de tickets combiné.
- L'état de triage est une ligne `Status:` proche du haut de chaque fichier.
- Les commentaires et l'historique s'ajoutent en bas du fichier sous un
  titre `## Comments`.

## Champs usuels d'un ticket

```markdown
# <Titre>

Status: ready-for-agent
Spec: .scratch/<feature-slug>/spec.md
Type: task

## Résumé ...
## Critères d'acceptation ...
## Hors périmètre ...
## Comments
```

## Étiquettes de triage

| Rôle | Étiquette | Signification |
| --- | --- | --- |
| needs-triage | `needs-triage` | Le mainteneur doit évaluer l'issue |
| needs-info | `needs-info` | En attente d'informations du rapporteur |
| ready-for-agent | `ready-for-agent` | Entièrement spécifié, prêt pour un agent AFK |
| ready-for-human | `ready-for-human` | Nécessite une implémentation humaine |
| wontfix | `wontfix` | Ne sera pas traité |

Une spec ou un ticket est `ready-for-agent` quand il est suffisant pour
qu'un agent l'implémente sans retour utilisateur.

## Publication et lecture

- « Publier dans le tracker » = créer un fichier sous
  `.scratch/<feature-slug>/` (créer le répertoire si nécessaire), puis
  appliquer l'étiquette de triage adaptée dans `Status:`.
- « Récupérer le ticket pertinent » = lire le fichier au chemin ou au
  numéro passé par l'utilisateur.
- Le pipeline `implement-ticket` exige un ticket approuvé existant : ne
  jamais le lancer avec une spécification seule.
