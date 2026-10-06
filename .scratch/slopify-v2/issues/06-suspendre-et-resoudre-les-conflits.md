# 06: Suspendre et résoudre les conflits sur action explicite

**Ticket ID:** T06

**What to build:** Un conflit arrête les nouveaux lancements et l’intégration en conservant tous les résultats ; Pi peut présenter le conflit et, après autorisation de l’utilisateur, déclencher une résolution isolée puis reprendre.

**Blocked by:** 05 — Persister, diagnostiquer et reprendre explicitement.

**Status:** claimed

- [x] Le run publie les tâches, bases et fichiers en conflit et conserve les checkpoints, logs et résultats en attente.
- [x] Les tâches déjà lancées finissent ; aucun résultat supplémentaire n’est fusionné et aucune nouvelle vague ne part tant que le conflit subsiste.
- [x] Une commande explicite de résolution crée un sandbox dédié depuis le contexte de conflit ; aucune résolution automatique.
- [x] Un résultat non valide ou une résolution échouée laisse le run suspendu et les preuves inspectables.
- [x] Après résolution validée, les résultats en attente sont intégrés et la frontière recalculée sans refaire les tâches réussies.
- [x] Une interruption pendant la résolution reste récupérable et ne modifie pas le dépôt utilisateur.

**Implementation:**

- `TaskBatchService.resolveConflict()`: Supports three strategies:
  - `use-current`: Reject incoming changes, mark conflicted task as failed
  - `use-incoming`: Accept incoming changes, update checkpoint to incoming commit
  - `manual`: Create dedicated sandbox from conflict context with `slopify-resolution-{runId}-{attemptId}-{uuid}` naming
- `TaskBatchService.validateResolution()`: Validates manual resolution from dedicated sandbox, creates bundle, integrates pending results
- `TaskBatchService.getConflict()`: Returns conflict details for inspection
- `TaskBatchService.getResolution()`: Returns resolution details for inspection
- CLI commands added: `resolve-conflict`, `validate-resolution`, `conflict`, `resolution`
- Conflict suspension: `executeWaves` returns early when `snapshot.conflict` is set, stopping new wave launches
- New interfaces: `TaskBatchResolution` for tracking manual resolution state

**Acceptance evidence:**

All 6 acceptance criteria verified by tests in `slopify/test/t06-conflict-resolution.test.ts`:
- AC1: `AC1: conflict detection publishes tasks, bases, conflicting files, checkpoints and logs`
- AC2: `AC2: suspension stops new wave launches while conflict stands`
- AC3: `AC3: explicit resolve command creates dedicated sandbox from conflict context` (use-current strategy)
- AC3 (manual): `AC3 (manual): manual resolution creates dedicated sandbox from conflict context`
- AC4: `AC4: failed resolution leaves run suspended with inspectable evidence`
- AC5: `AC5: after resolution pending results integrate without redoing succeeded tasks`
- AC6: `AC6: interruption during resolution is recoverable and does not modify user repo`
- CLI: `CLI: tasks resolve-conflict command works with use-current strategy`
- CLI: `CLI: tasks conflict command displays conflict details`
- CLI: `CLI: tasks resolve-conflict with invalid strategy fails gracefully`

116 tests passing (106 original + 10 new T06 tests).

**Public seam:** lancement/état, résolution et reprise du lot sur de vrais commits Git incompatibles.

**Validation:** deux tâches modifiant la même ligne, résolution autorisée réussie/échouée, résultats indépendants conservés et redémarrage ; build et tests ciblés.
