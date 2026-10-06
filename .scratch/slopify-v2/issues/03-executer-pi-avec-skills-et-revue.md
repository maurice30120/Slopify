# 03: Exécuter Pi avec Mistral, skills et revue parallèle

**Ticket ID:** T03

**What to build:** Une tâche Pi dispose d’un sandbox Pi dédié utilisant Mistral, des skills partagés en lecture seule et des sous-agents indépendants pour la revue officielle, puis retourne un résultat observable au coordinateur.

**Blocked by:** 01 — Valider et figer le lot complet.

**Status:** resolved

**Implementation:** feature/slopify-v2-t03 ; base 5f438dbb553d157851ff509d8a06dbdff4bbb1c7.

- [x] Le kit Pi utilise l’image Pi et Mistral par le proxy Docker, sans liaison Anthropic ni kit Vibe.
- [x] Le fournisseur et le modèle sont configurés correctement ; aucune clé réelle ne figure dans le contexte ou les logs.
- [x] Le magasin `sbx skills` est monté en lecture seule et déclaré à Pi via `--skill` ; tous les skills et ressources sont accessibles sans réécriture.
- [x] L’extension officielle d’exemple `subagent` et les agents Standards/Spec sont disponibles dès le lancement, avec standards, spec et pointeurs de preuve.
- [x] Les reviewers reçoivent explicitement les instructions AGENTS du dépôt, la spec complète et la baseline officielle ; les erreurs de chaque sous-agent sont visibles et ne sont pas masquées par un processus parent réussi.
- [x] Le prompt est transmis sans conversion et le résultat comprend sortie, erreurs, compte rendu et références de revue réellement observables.
- [x] L’absence de capacités ou une erreur de fournisseur échoue avec un diagnostic exploitable ; les chemins propres au compte du prototype ne sont pas codés en dur.

**Public seam:** exécuteur de tâche Docker public, appelé par le lancement du lot ; résultats du run consultables.

**Validation:** tests du contrat externe Docker avec exécuteur substitué, build TypeScript ; les mêmes comportements seront vérifiés avec Pi réel dans le smoke final.


**Acceptance evidence:** public `TaskBatchService` tests exercise production Pi registration with only the sbx subprocess boundary replaced and real Git/files. Six tests verify integrated isolated output, dirty host preservation, Mistral proxy kit and supportsStore:false configuration, readonly store/capability rejection, original prompt, official extension discovery, full Standards/Spec roles and actual parallel result references, parent-zero child/provider failures and retained resources. Build and npm test pass; TDD evidence is `/private/tmp/slopify-v2-agent-notes/t03.md`.

**Real validation:** generated kit passes the local sbx validator. The validator warns that the proxy credential domain is not listed in a kit allowlist because the kit inherits global policy. Actual Mistral proxy injection and full model execution remain to be checked in T07's authorized mixed-agent smoke; this contract test does not assert perfect LLM TDD compliance.

**Integration acceptance:** `f9e94a4cbf64ddfec887405f608734734d1ab3e9` merged by `f28d1dae62a1f5cd76be7bfe6da86529e9ace685`. Full workspace build and public Pi/Codex contract tests pass (13/13). Default Pi registration, common live logs and native Codex evidence are preserved. The generated Pi kit inherits global network policy; real Mistral proxy injection remains an explicit T07 smoke check. Notes: `/private/tmp/slopify-v2-agent-notes/merges.md`.
