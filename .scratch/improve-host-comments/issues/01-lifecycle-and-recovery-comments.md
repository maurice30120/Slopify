# 01: Clarifier le cycle de vie, la reprise et le nettoyage

**What to build:** Réviser les commentaires qui expliquent le cycle de vie des runs et de leur état en mémoire, afin qu’un mainteneur puisse distinguer une Reprise d’une Réparation ou d’une nouvelle tentative et comprendre quand un runtime reste disponible ou est nettoyé.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Le commentaire de `CliPipelineHost` explique clairement le maintien des runs en pause pour préserver leurs sessions et le retrait des runs terminaux.
- [ ] Les commentaires autour de `start`, `resume`, `recover`, `cancel` et `dispose` précisent les invariants utiles du cycle actif → pause → Reprise/récupération → état terminal, sans documenter un comportement absent.
- [ ] La restauration via le run store indique qu’un snapshot est requis, que les statuts `paused` et `running` sont acceptés, et que `restoreProgram` précède la recherche du programme par identifiant.
- [ ] Le nettoyage terminal explique le retrait du runtime, des journaux et des caches indexés par `runId:nodeId`, tandis qu’un run en pause n’est pas nettoyé prématurément.
- [ ] Les termes `Reprise`, `Réparation`, `Agent Checkpoint`, `Pipeline Change Set`, `Promotion`, `Rejection` et `Cancellation` sont employés uniquement lorsqu’ils décrivent l’invariant concerné.
- [ ] Seul le texte des commentaires de la zone de cycle de vie est modifié.

