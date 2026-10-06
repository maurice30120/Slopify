# 01: Valider et figer le lot complet

**Ticket ID:** T01

**What to build:** Pi peut soumettre un lot contenant la spec et tous les tickets, et obtenir soit un contexte local figé consultable, soit un diagnostic complet sans création de sandbox ni exécution partielle.

**Blocked by:** None (can start immediately).

**Status:** claimed

- [x] Le contrat `specFile` / `tasks` avec `id`, `prompt`, `dependsOn`, `agent` et `source` accepte Pi/Codex et les références de fichiers/issues.
- [x] JSON invalide, champs mal typés, doublons, agent inconnu, références absentes et cycles sont refusés avant tout effet d’exécution.
- [x] Les chemins sont résolus depuis le lot et la lisibilité du contexte est vérifiée.
- [x] Spec, prompts et références sont copiés durablement ; l’état public initial est consultable sans dépendre des sources modifiables.
- [x] L’interface publique de lot et une entrée CLI dédiée rendent ce comportement vérifiable ; aucune interprétation des invocations de skills.

**Public seam:** lancement et lecture d’état d’un lot, via API publique et CLI.

**Validation:** tests ciblés aux interfaces convenues, build TypeScript ; un lot invalide n’effectue aucun appel d’exécution externe.

**Implementation:** verified in feature/slopify-v2-t01; integration pending before resolution.
