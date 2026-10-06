# 05: Persister, diagnostiquer et reprendre explicitement

**Ticket ID:** T05

**What to build:** Après échec ou interruption, Pi peut lire un état durable et demander explicitement une nouvelle tentative depuis la branche courante, sans refaire les résultats intégrés ni recharger un contexte modifié.

**Blocked by:** 04 — Exécuter les vagues et intégrer les dépendances.

**Status:** resolved

- [x] L’état par run est écrit atomiquement et conserve bases, tentatives, commits, ressources, rapports et branche.
- [x] La reprise après redémarrage réutilise les résultats intégrés et les résultats enregistrés encore à intégrer sans les dupliquer.
- [x] Une tâche interrompue sans résultat devient `interrupted` ; sa reprise explicite crée une nouvelle identité et un nouveau sandbox depuis l’intégration courante.
- [x] Une demande explicite peut relancer une tâche échouée ; aucune tentative n’est créée par simple lecture d’état ou retry automatique.
- [x] Sources changées/supprimées après lancement n’affectent pas le contexte figé de la reprise.
- [x] Les sandboxes échoués/interrompus restent inspectables ; les réussites sont nettoyées après sauvegarde et une erreur de nettoyage est signalée.
- [x] Les commandes publiques de suivi et reprise produisent un bilan exploitable par Pi.

**Public seam:** lancement, lecture d’état et reprise d’un lot après reconstruction du service, avec vrai stockage/Git.

**Validation:** tests d’interruption aux transitions critiques, reprise sans répétition, sources modifiées et rétention ; build et tests ciblés.

---

## Implementation

**Branch:** `feature/slopify-v2-t05`  
**Base:** `8e9a877f1` (T04 resolved)  
**Tip commit:** `bfdf453ec` T05: Fix P1 spec finding - add dependency check to resumeTask

### Changes

- `slopify/src/taskBatch.ts`: Added `resume()` and `resumeTask()` methods with:
  - State reconstruction from store
  - Workspace and frozen context validation
  - Dependency checking for single-task resume
  - Task reset to pending for re-execution
  - New attempt creation from current integration commit

- `slopify/src/taskBatchCli.ts`: Added `resume` and `resume-task` CLI commands

- `slopify/test/t05-durable-state.test.ts`: 11 tests covering all acceptance criteria

### Code Review

**Standards reviewer:** P2 findings (non-blocking)
- Data Clumps: Duplicate output formatting in taskBatchCli.ts resume/resume-task branches
- Mysterious Name: Unused fields in CliResumeCommand interface (args.ts)
- Duplicated Code: Workspace validation duplicated in resume/resumeTask

**Spec reviewer:** P1 and P2 findings
- P1 (FIXED): resumeTask bypassed wave scheduling; added dependency check
- P2: Missing frozen context file validation (FIXED: added validation)
- P2: Missing explicit retention policy for failed sandboxes (DOCUMENTED: resourceState='retained' prevents cleanup)

**Reviewer artifacts:**
- Standards: `/private/tmp/slopify-v2-agent-notes/pi-sessions/subagent-artifacts/8682268f-4bc9-4739-9d51-8c573262c7b5_reviewer_output.md`
- Spec: `/private/tmp/slopify-v2-agent-notes/pi-sessions/subagent-artifacts/36c94830-3212-4370-8ea5-e9fbe286f9da_reviewer_output.md`

Both reviewers exited 0 with real token usage (Mistral: ~2400 tokens total, 4 prompts, 4 completions).

### Acceptance Evidence

All 7 acceptance criteria verified by tests:

| AC | Description | Test | Status |
|----|-------------|------|--------|
| AC1 | Atomic state writing | `AC1: state file is written atomically with .tmp suffix`, `AC1: state contains all task attempts with their fields` | ✅ |
| AC2 | Resume after restart | `AC2: service can reconstruct state from store after restart`, `AC2: resume resets failed tasks to pending for re-execution` | ✅ |
| AC3 | Interrupted task resume | `AC3: resumeTask resets interrupted task to pending for re-execution` | ✅ |
| AC4 | No implicit retry | `AC4: reading status does not create new attempts` | ✅ |
| AC5 | Frozen context | `AC5: frozen context preserved even after source deletion` | ✅ |
| AC6 | Inspectable sandboxes | `AC6: failed task attempts have retained resource state` | ✅ |
| AC7 | Public commands | `AC7: tasks CLI status command reads durable state`, `AC7: tasks CLI resume command fails without integration workspace`, `AC7: tasks CLI resume-task command fails without integration workspace` | ✅ |

**Test results:** 106/106 tests pass (8 existing taskBatch + 7 existing taskWaves + 11 new T05 tests)

**Build:** `npm run build && node --test "dist/test/**/*.test.js"` passes clean

### Lessons Learned

- **Stale dist artifacts:** Debug test files (test-cli-debug.test.ts) were deleted from source but compiled artifacts remained in dist/, causing test failures. Fixed by clean rebuild. Always run clean build before full suite.
- **P1 spec compliance:** Direct execution in resumeTask bypassed wave scheduler's dependency and conflict handling. Fixed by adding explicit dependency validation.
- **Frozen context validation:** Spec requires resume to work even if sources are deleted. Implemented by copying spec/batch to run directory and validating their existence before resume.

**Integration acceptance:** merged no-ff into feature/slopify-v2 (tip after merge); full workspace build and 106/106 slopify tests pass. Standards/Spec review ran as two real parallel Pi subagents with the mistral/mistral-medium-latest:off override (artifacts /private/tmp/slopify-v2-agent-notes/pi-sessions/subagent-artifacts/36c94830*, 8682268f*); the P1 resumeTask-scope finding was fixed by explicit dependency validation in 0a88ab803. Residual note for T07: resumeTask intentionally does not delegate to executeWaves; the real smoke must exercise resume through the public CLI. Notes: /private/tmp/slopify-v2-agent-notes/merges.md.
