# Skills sur disque dans Docker Sandbox et Codex

Recherche documentaire du 6 octobre 2026, sans lancement d’agent ni modification du code.

## Résultats confirmés

- Docker documente la copie de fichiers et de dossiers vers un sandbox avec `sbx cp`. Le chemin cible dans le sandbox doit être absolu. [Docker — Usage](https://docs.docker.com/ai/sandboxes/usage/).
- Docker propose aussi un magasin partagé de skills via `sbx skills add` et `sbx skills import`, avec accès en lecture seule par défaut pour les agents pris en charge. Ce mécanisme est expérimental et le magasin peut changer pendant la vie d’un sandbox ; une copie propre à un run convient mieux à l’exigence de version figée. Cette préférence est une recommandation de conception. [Docker — Share agent skills](https://docs.docker.com/ai/sandboxes/workflows/agent-skills/).
- Codex découvre les skills dans `.agents/skills` au niveau du dépôt et dans `$HOME/.agents/skills` au niveau utilisateur. Il charge d’abord leurs métadonnées, puis lit le contenu du skill sélectionné. L’invocation explicite utilise `$skill-name` ; `/skills` est le sélecteur interactif. [OpenAI — Build skills](https://learn.chatgpt.com/docs/build-skills).
- OpenAI fournit un exemple non interactif `codex exec` qui mentionne explicitement un skill avec le préfixe `$`. Un prompt court peut donc invoquer un skill installé sans que Slopify y recopie ses instructions. [OpenAI — Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills).

## Vérification de l’installation locale

Les commandes en lecture seule `sbx version`, `sbx skills --help`, `sbx skills add --help`, `sbx skills import --help` et `sbx cp --help` ont été exécutées. La version locale est `v0.45.1` et expose les deux mécanismes. L’aide locale de l’import ne mentionne pas Vibe parmi les agents pris en charge ; elle ne suffit donc pas à garantir un montage automatique pour Vibe.

## Limites

Ces résultats confirment la faisabilité documentaire et la présence des commandes locales, pas une exécution bout en bout dans un sandbox. La [recherche Docker et Vibe](docker-vibe-skill-discovery.md) confirme la découverte sur disque et l’interprétation de `/implement` en mode non interactif par lecture du code officiel ; une vérification sur la version du template choisi reste nécessaire.
