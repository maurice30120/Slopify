# Slopify V2 launch guide

1. Put the complete specification and a validated batch in `.scratch/slopify/`. Every task has `id`, complete `prompt`, `agent` (`pi` or `codex`), `dependsOn`, and retained `source` URL.
2. Launch with `slopify tasks run .scratch/slopify/batch.json --json`. Slopify runs at most five ready tasks in a wave and integrates them in JSON order on `feature/slopify-<run-id>`.
3. Monitor with `slopify tasks status <run-id> --json`. Read progress, issues, evidence paths, and next actions.
4. After an interruption, ensure the old process is stopped, then use `slopify tasks resume <run-id> --json` or `resume-task` for one task. Resolve conflicts only with the explicit conflict commands shown by status.
5. Present the integrated result and validations. Never merge into or alter the user's checked-out branch automatically.
