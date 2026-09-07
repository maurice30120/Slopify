# Enrichir le commentaire d'un run de pipeline

Le mode par défaut de `slopify run` n'affiche que des lignes d'activité brute (`Starting node agent`, `réfléchit`/`répond`) sans transition de graphe, sans durée, ni résumé d'artefact. Nous enrichissons les `PipelineRuntimeEvent` (`durationMs`, `artifactSummary`) calculés côté runtime plutôt que côté host, et introduisons quatre niveaux de verbosité (`--quiet` / défaut / `--verbose` / `--debug`) avec un rendu en lignes plates (`▶`/`✓` + timing + résumé). Les anciens messages d'activité sont poussés en `--verbose` pour réduire le bruit en mode défaut. Les durées et résumés sont calculés par le runtime car lui seul connaît le cycle de vie complet d'un nœud (retries, sessions, pauses) ; le host n'a pas à déduire le timing ni à lire l'état interne du snapshot.

**Considered Options:**
- *Host lit le snapshot au `node_completed`* : rejeté, car le snapshot est un état interne du runtime ; l'y coupler casse l'encapsulation et complique la gestion des replay/retry/resume.
- *Parser le Markdown des artefacts pour extraire des résumés* : rejeté, car le format n'est pas contractuel. On n'exploite que ce qui est déjà structuré (`acp.ticket-graph/v1` JSON) ou déjà disponible (`checkpoint.fileCount`).
- *Compteur de nœuds global dynamique* : rejeté, car le nombre de tickets est inconnu avant le nœud `tasks` et le total change en cours de route. Deux compteurs distincts (pipeline fixe `N/4`, delivery `ticket N/M`) restent honnêtes.

**Consequences:**
- `PipelineRuntimeEvent` gagne deux champs optionnels (`durationMs`, `artifactSummary`) ; les consumers existants les ignorent s'ils ne les utilisent pas.
- `artifactSummary.filesChanged` est best-effort : omis si le checkpoint sandbox n'est pas prêt au moment du `node_completed`.
- Le contrat d'event est désormais la seule source de timing ; les logs persistants `.acp/logs/*.jsonl` en bénéficient automatiquement.
