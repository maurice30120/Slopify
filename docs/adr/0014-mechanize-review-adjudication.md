---
status: accepted
---

# Adjudiquer les tentatives mécaniquement sur les revues réellement exécutées

## Contexte

Dans le run `7cff4e89`, l'extension subagent de Pi 1.3.0 a rejeté 146 invocations
sur 150 en répondant `isError: false` : aucune Revue indépendante n'a été exécutée,
le diagnostic `pi_subagent_error` (déclenché sur `isError === true`) ne s'est jamais
émis, et la règle du harness « Missing or invalid verdicts fail the task » n'était
mécanisée nulle part. Sur des preuves identiques, trois tâches ont été marquées
`succeeded` et deux `failed` — les deux échecs revenant aux agents ayant déclaré
honnêtement le manquement. Le verdict dépendait de l'auto-déclaration de l'agent,
pas de l'état du monde.

## Décision

L'adjudication d'une tentative est mécanisée en trois branches, fondée uniquement
sur les revues réellement exécutées :

1. Zéro Revue indépendante exécutée (tous les résultats vides ou rejetés) : la
   tentative est marquée « revue bloquée » — état distinct, ni succès ni échec de
   l'agent — avec un diagnostic `review_delegation_broken` au niveau du run et refus
   d'intégration. Une sonde canari (un appel subagent vers `standards` au démarrage
   de chaque tentative) détecte ce cas avant d'engager le travail ; son échec
   n'affecte que la tentative sondée, pas le lot.
2. Au moins une revue exécutée : le verdict s'appuie sur les revues réelles ; un
   rejet subagent isolé ne fait pas échouer la tentative à lui seul (ticket #86).
3. Aucune adjudication fondée sur l'auto-déclaration de l'agent.

La règle s'applique prospectivement : les trois tentatives du run `7cff4e89`
intégrées sans revue exécutée restent intégrées ; les statuts historiques du store
ne sont pas retouchés.

## Conséquences

- Un même état du monde produit toujours le même verdict, indépendamment de
  l'honnêteté de l'agent d'implémentation.
- « Revue bloquée » préserve le travail : le checkpoint est persisté dès qu'un
  commit existe (même en échec de revue), et la reprise `--review-only` rejoue la
  revue seule dans une sandbox fraîche semée par le bundle.
- Le ticket #86 reste compatible : la stricte totalité (zéro revue) déclenche
  l'échec mécanique ; la partialité (au moins une revue) laisse la tentative à la
  merci de ses revues réelles, pas d'un rejet isolé.
