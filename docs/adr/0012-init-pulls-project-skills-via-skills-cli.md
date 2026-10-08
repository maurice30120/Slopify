---
status: accepted
---

# `slopify init` tire les skills du projet via la CLI `skills` ; le store global sbx reste vérifié au préflight uniquement

## Contexte

Les nœuds de pipeline résolvent leurs skills depuis `<workspace>/.agents/skills/`,
montées en lecture seule dans la sandbox ; la CLI `skills` (`npx skills add`) installe
des copies éditables dans le projet et maintient `skills-lock.json`. Par ailleurs, le
chemin `tasks` exige `implement`, `tdd` et `code-review` dans le store global `sbx`
(`sbx skills ls --json`), monté en lecture seule dans le conteneur — ce check vit au
préflight de l'exécuteur Docker. `slopify init` prépare un projet à utiliser Slopify
et n'écrit par ailleurs que dans le projet cible.

## Décision

`init` tire les skills dans le projet cible en exécutant
`npx skills@latest add mattpocock/skills` (project-scope, via la CLI `skills`).
`init` ne touche jamais au store global `sbx` : sa vérification reste au préflight
de l'exécuteur, au moment où elle a un effet. Un échec du pull de skills n'empêche
pas l'installation des fichiers d'`init` ; le préflight du premier run reste
l'autorité sur l'état de l'environnement.

## Conséquences

- La règle « `init` n'écrit que dans le projet » tient : le pull passe par la CLI
  `skills`, qui écrit dans le projet.
- Un projet fraîchement initialisé a les skills de nœuds (pipeline) mais rien ne
  garantit le store global `sbx` (chemin `tasks`) — c'est le préflight qui le dit,
  pas `init`.
- Le pull dépend du réseau et de la CLI `skills` ; toute régression de cette
  commande extérieure se manifeste comme un avertissement d'`init`, pas comme un
  échec de préparation.
