---
status: accepted
---

# Vendoriser l'extension subagent de Pi plutôt que de dépendre de son « exemple »

## Contexte

La porte de validation de Slopify — la Revue indépendante — repose sur l'extension
subagent de Pi, qui n'est qu'un fichier « example » du paquet installé
(`examples/extensions/subagent/index.ts`). En Pi 1.3.0, cette extension dépouille
les arguments d'appel d'outil entre le modèle et `execute()` et rejette tout appel
avec `isError: false` (branche `modeCount !== 1`) : dans le run `7cff4e89`, 146
invocations sur 150 ont été rejetées sans qu'aucun signal d'erreur ne remonte.
Aucune version de Pi connue bonne n'est identifiée, et l'erreur est muette.

## Décision

Vendoriser l'extension subagent dans Slopify, corriger le bug localement (paramètre
`task` requis dans le schéma, erreur explicite), et contribuer le correctif en
amont en parallèle (ticket #80).

## Conséquences

- La porte de validation est sous le contrôle de Slopify : plus de dépendance à un
  fichier d'exemple d'un paquet tiers pour une fonction critique.
- Risque assumé de divergence avec l'amont : la veille de version de Pi doit
  comparer l'extension vendorisée à l'exemple du paquet à chaque montée de version.
- Alternatives écartées : épingler une version de Pi (aucune version bonne connue,
  le bug est vivant en 1.3.0) ; attendre l'amont seul (la porte de validation
  resterait hors de contrôle pour une durée indéterminée).
