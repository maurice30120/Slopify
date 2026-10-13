# 03: Tests unitaires pour l'exécuteur de tâche Docker

**What to build:** une suite de tests unitaires dédiée à l'exécuteur de
tâche Docker, couvrant la sélection d'adaptateur (Pi/Codex/agent inconnu), la
création des fichiers d'évidence dans le répertoire de résultats
(stdout.log, stderr.log, commands.jsonl, report.md), la journalisation des
commandes transmises au sous-processus et le rejet propre d'un agent
indisponible — en doublant l'exécuteur de sous-processus.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Un fichier de test dédié couvre l'exécuteur au seam public, sans
      toucher au code de production.
- [ ] Un agent inconnu de la demande produit une erreur observable sans
      création de sandbox (le message mentionne l'agent demandé).
- [ ] `execute` crée le répertoire de résultats avec les fichiers d'évidence
      attendus et y journalise chaque commande lancée (entrée et sortie,
      exitCode) dans commands.jsonl.
- [ ] La sortie et l'erreur des commandes sont ajoutées aux fichiers
      stdout.log et stderr.log, y compris quand le sous-processus ne
      fournit pas de flux en direct.
- [ ] L'exécuteur choisit l'adaptateur correspondant à l'agent de la
      demande et transmet au sous-processus doublé des arguments cohérents
      (commande `sbx`, nom de sandbox stable dérivé de run/tâche/tentative).
- [ ] Le résultat d'exécution expose exitCode, chemins stdout/stderr,
      diagnostics ; les diagnostics d'un échec de commande sont observables.
- [ ] `cleanup` transmet la suppression de la sandbox au sous-processus.
- [ ] La suite complète du paquet passe (compilation incluse) après ajout du
      fichier de test.

**Interfaces de test approuvées :**

- `new DockerTaskExecutor({ executor, adapters })` — `executor` :
  `SubprocessExecutor` doublé par un stub (les arguments sont capturés, les
  réponses simulées) ; `adapters` : adaptateurs de test optionnels.
- `execute(request: TaskExecutionRequest): Promise<TaskExecutionResult>` —
  `TaskExecutionRequest` construit avec un répertoire de résultats
  temporaire réel ; `TaskExecutionResult` expose `exitCode`, `stdoutPath`,
  `stderrPath`, `reportPath?`, `diagnostics`.
- `cleanup(resource: TaskSandboxResource): Promise<void>`.
