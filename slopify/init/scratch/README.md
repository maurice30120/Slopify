# Local preparation files

`.scratch/slopify/` contains local specifications and task batches prepared before a Slopify run. GitHub issues may be normalized into these files; retain every issue or document URL in each task's `source`. Initialization never creates, edits, comments on, labels, or closes tracker items.

The starter V2 batch sets `defaults` to `agent: "codex"`, `model: "gpt-6-luna"` and `effort: "medium"`. The Agent Host should choose the runner, model and effort for each task, and write task-level values when a task needs a different setup. A task can override any default; omitted values inherit from `defaults`.

`agent` selects the runner and must be `pi` or `codex`. `model` and `effort` overrides are supported for Codex tasks; Pi uses its configured model and rejects task-level `model` or `effort`. The Codex effort values accepted by the batch validator are `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. `slopify init --host` chooses which Agent Host integration files to install. The separate `.acp/acp-agents.json` configuration applies to ACP pipelines, not `slopify tasks run` batches.
