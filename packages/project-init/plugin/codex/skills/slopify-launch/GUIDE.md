# Slopify V2 launch guide

## Agent Host, task agent and model

`slopify init --host pi|codex|all` selects which Agent Host integration files to install in the target project. The starter batch also sets defaults to `agent: "codex"`, `model: "gpt-6-luna"` and `effort: "medium"`.

As Agent Host, choose the runner, model and effort that fit each task. Omitted task fields inherit `defaults`; set task-level `agent`, `model` and/or `effort` to override them. For example, choose `agent: "codex"`, `model: "gpt-6-luna"`, `effort: "medium"` for a balanced Codex task, or use another Codex model and an effort supported by that model when the task calls for it. `agent` must be `pi` or `codex`.

For a Codex task that needs more reasoning than the starter's `medium` default, the Agent Host can write:

```json
{
  "id": "complex-task",
  "prompt": "...",
  "agent": "codex",
  "model": "gpt-6-luna",
  "effort": "high",
  "dependsOn": [],
  "source": "issues/complex-task.md"
}
```

Codex tasks pass `model` through `--model` and `effort` through `-c model_reasoning_effort=...`. `model` and `effort` are Codex-only settings: Pi uses its configured `zai-glm-5-3` model, and task-level Pi model/effort overrides are rejected. Codex defaults are not inherited by a task whose effective agent is Pi.

The `.acp/acp-agents.json` profiles configure the separate ACP pipeline runtime; they do not configure `slopify tasks run` V2 batches.

## Launch and monitor

1. Put the complete specification and a validated batch in `.scratch/slopify/`. Every task has `id`, complete `prompt`, `dependsOn`, and retained `source` URL; `agent` can inherit from defaults or be overridden per task.
2. Launch with `slopify tasks run .scratch/slopify/batch.json --json`. Slopify runs at most ten ready tasks in a wave and integrates them in JSON order on `feature/slopify-<run-id>`.
3. Monitor with `slopify tasks status <run-id> --json`. Read progress, issues, evidence paths, and next actions.
4. After an interruption, ensure the old process is stopped, then use `slopify tasks resume <run-id> --json` or `resume-task` for one task. Resolve conflicts only with the explicit conflict commands shown by status.
5. Present the integrated result and validations. Never merge into or alter the user's checked-out branch automatically.
