# 01: Tests unitaires pour l'interprétation du verdict de l'agent

**What to build:** une suite de tests unitaires dédiée au module qui
interprète le verdict `SLOPIFY_RESULT` du message final de l'agent, couvrant
tous les cas de contrat observables : verdict absent, verdict multiple, JSON
invalide, statut invalide, échec déclaré avec et sans raison, succès sans
diagnostic.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Un fichier de test dédié couvre la fonction d'interprétation du verdict
      au seam public, sans toucher au code de production.
- [ ] Message final sans ligne `SLOPIFY_RESULT` : diagnostic `agent_outcome_missing`.
- [ ] Message final avec deux lignes de verdict : diagnostic `agent_outcome_missing`.
- [ ] Verdict avec JSON invalide : diagnostic `agent_outcome_invalid`.
- [ ] Verdict avec statut autre que `succeeded`/`failed` ou sans statut :
      diagnostic `agent_outcome_invalid`.
- [ ] Verdict `failed` sans `reason` : diagnostic `agent_reported_failure` avec
      le message par défaut ; avec `reason` : le message reporte cette raison.
- [ ] Verdict `succeeded` : aucune entrée de diagnostic, liste vide.
- [ ] Les verdicts sont reconnus sur des lignes avec espaces et retours CRLF.
- [ ] La suite complète du paquet passe (compilation incluse) après ajout du
      fichier de test.

**Interfaces de test approuvées :**

- `agentOutcomeDiagnostics(finalMessage: string): TaskBatchDiagnostic[]`
  — entrée : message final complet de l'agent ; sortie : liste de
  diagnostics, vide si et seulement si le verdict est `succeeded`.
- `TaskBatchDiagnostic` : `{ code: string, message: string }`.
