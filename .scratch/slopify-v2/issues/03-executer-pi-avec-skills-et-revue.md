# 03: Exécuter Pi avec Mistral, skills et revue parallèle

**Ticket ID:** T03

**What to build:** Une tâche Pi dispose d’un sandbox Pi dédié utilisant Mistral, des skills partagés en lecture seule et des sous-agents indépendants pour la revue officielle, puis retourne un résultat observable au coordinateur.

**Blocked by:** 01 — Valider et figer le lot complet.

**Status:** ready-for-agent

- [ ] Le kit Pi utilise l’image Pi et Mistral par le proxy Docker, sans liaison Anthropic ni kit Vibe.
- [ ] Le fournisseur et le modèle sont configurés correctement ; aucune clé réelle ne figure dans le contexte ou les logs.
- [ ] Le magasin `sbx skills` est monté en lecture seule et déclaré à Pi via `--skill` ; tous les skills et ressources sont accessibles sans réécriture.
- [ ] L’extension officielle d’exemple `subagent` et les agents Standards/Spec sont disponibles dès le lancement, avec standards, spec et pointeurs de preuve.
- [ ] Les reviewers reçoivent explicitement les instructions AGENTS du dépôt, la spec complète et la baseline officielle ; les erreurs de chaque sous-agent sont visibles et ne sont pas masquées par un processus parent réussi.
- [ ] Le prompt est transmis sans conversion et le résultat comprend sortie, erreurs, compte rendu et références de revue réellement observables.
- [ ] L’absence de capacités ou une erreur de fournisseur échoue avec un diagnostic exploitable ; les chemins propres au compte du prototype ne sont pas codés en dur.

**Public seam:** exécuteur de tâche Docker public, appelé par le lancement du lot ; résultats du run consultables.

**Validation:** tests du contrat externe Docker avec exécuteur substitué, build TypeScript ; les mêmes comportements seront vérifiés avec Pi réel dans le smoke final.
