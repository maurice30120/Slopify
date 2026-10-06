# 01: Valider et figer le lot complet

**Ticket ID:** T01

**What to build:** Pi peut soumettre un lot contenant la spec et tous les tickets, et obtenir soit un contexte local figé consultable, soit un diagnostic complet sans création de sandbox ni exécution partielle.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Le contrat `specFile` / `tasks` avec `id`, `prompt`, `dependsOn`, `agent` et `source` accepte Pi/Codex et les références de fichiers/issues.
- [ ] JSON invalide, champs mal typés, doublons, agent inconnu, références absentes et cycles sont refusés avant tout effet d’exécution.
- [ ] Les chemins sont résolus depuis le lot et la lisibilité du contexte est vérifiée.
- [ ] Spec, prompts et références sont copiés durablement ; l’état public initial est consultable sans dépendre des sources modifiables.
- [ ] L’interface publique de lot et une entrée CLI dédiée rendent ce comportement vérifiable ; aucune interprétation des invocations de skills.

**Public seam:** lancement et lecture d’état d’un lot, via API publique et CLI.

**Validation:** tests ciblés aux interfaces convenues, build TypeScript ; un lot invalide n’effectue aucun appel d’exécution externe.
