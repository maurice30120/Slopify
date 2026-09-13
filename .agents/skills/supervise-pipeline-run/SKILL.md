---
name: supervise-pipeline-run
description: Run and supervise a Slopify pipeline when the user wants an explicit provider or pipeline tested end to end, with verbose events, preserved sandboxes, interactive checkpoint handling, and evidence-backed failure reporting.
---

# Supervise a Slopify pipeline

Use this skill for supervised pipeline tests and diagnostics. The result is an execution verdict, not an assumed success: report the furthest completed node, the first failing node, the run ID, and the evidence that supports the verdict.

## Before launching

Resolve the exact pipeline requested by the user. Use `slopify list --json` and inspect the selected YAML when the name, provider, promotion policy, or node graph is unclear. Never silently substitute the default pipeline or another provider.

Check the workspace with `git status --short --branch`. Preserve existing changes. If the user asked for a clean run and the workspace is dirty, use a disposable clean clone/worktree or stop for direction; do not use `git reset --hard`, `git clean`, or an implicit stash.

Confirm authorization at the boundary that matters:

- A pipeline using Codex, OpenCode, Copilot, Vibe, or another remote provider may transmit project code or prompts externally. Obtain explicit user authorization before launch unless it was already granted for this exact run.
- A pipeline with `promotion: auto-apply` can modify the workspace, including generated documentation or commits. Make that consequence clear before launching and prefer an isolated clean workspace for tests.
- `--yes` approves ordinary approval pauses only; it is not authorization to share code, consume a usage reset, or change Promotion policy.

## Launch

Use the CLI help output as the source of truth for flags, then launch with the requested pipeline, verbose events, and retained sandboxes:

```sh
slopify run -v -k -y -p <pipeline-id> "<user prompt>"
```

Attach a real TTY when the pipeline can interview or pause for input. Without a TTY, a question-capable planner can finish with `Terminal input closed` before downstream nodes run. Keep the process session open and poll it in bounded intervals; do not close stdin while the pipeline is active.

## Handle checkpoints

When a planner pauses with questions, follow the user's instruction about who answers:

- If the user asked for a test and authorized self-directed answers, answer from the agent's recommendations while keeping the requested scope and provider unchanged.
- Otherwise expose the questions and wait for the user rather than inventing product decisions.

Send one coherent answer for the current question round. If the planner has enough information and the workflow uses `/done` to finish its interview, send `/done` only after the intended decisions have been recorded. Continue supervising after the planner emits `<interview_state>ready</interview_state>`; that is a checkpoint, not pipeline completion.

Treat approval pauses according to the pipeline policy and the authorization already obtained. Never claim that a pause was approved unless the CLI reports that the run resumed.

## Supervise to a terminal verdict

Track the runtime events in order and announce meaningful transitions such as `node_started`, `node_completed`, `paused`, `node_failed`, and `completed`. For each node, record its provider, duration when available, artifact summary, and whether the next node actually started.

Only call the pipeline successful when the process exits successfully and the runtime reports completion after the final review/delivery stage. A successful `plan`, `spec`, or `tasks` node is partial progress. A generated artifact or an auto-applied checkpoint is not proof that implementation or review completed.

On failure, capture before changing anything:

1. The exact first error and failing node.
2. The run ID and pipeline ID.
3. The pipeline JSONL log under `.acp/logs/` and any retained sandbox diagnostic path.
4. `git status --short --branch` and the latest relevant commits.
5. The last successful node and the artifacts/files it produced.

Redact credentials, authorization headers, tokens, and sensitive prompt content from displayed logs. Preserve the sandbox by default because the user requested supervision and diagnostics; remove it only on an explicit cleanup request.

## Interpret common failures

- `Weekly usage limit reached`, authentication errors, or provider transport errors are external-provider failures. Do not retry repeatedly, switch providers, or consume a usage-reset credit without explicit user direction.
- `Terminal input closed` during an interview is an invocation/TTY failure. Retry with a real TTY and keep stdin open.
- `invalid_sequential_delivery` or `no Markdown adapter` means the ticket graph and promoted Markdown adapters disagree. Compare the graph artifact with `.scratch/<feature>/issues/` files. A graph synthesized before sandbox Promotion can be stale even when the workspace is clean afterward; report this as a pipeline/runtime defect rather than as an agent implementation failure.
- A clean Git status does not prove that no work occurred: `auto-apply` may have created commits. Inspect the commit range and artifact summary before reporting the workspace state.

## Finish

Return a concise evidence-backed summary in the user's language containing:

- selected pipeline and provider;
- whether the run reached the final stage;
- completed nodes and first failure, if any;
- run ID, retained sandbox, and log links/paths;
- workspace/commit impact;
- the smallest safe next action, only when it does not assume new authorization.
