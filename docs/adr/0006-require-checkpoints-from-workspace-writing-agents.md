# Require checkpoints from workspace-writing agents

Every successful agent node whose normalized policy can mutate the workspace must retain an Agent Checkpoint, including when the resulting diff is empty. Read-only agents and pause nodes do not need checkpoints.

The pipeline runtime enforces this invariant for every adapter. `createSession` and `PipelineAgentRunner` remain injection seams, but they do not create a checkpoint-free execution mode. Test doubles and external adapters must implement the same contract as production sandbox adapters.

This keeps descendant composition deterministic and fail-closed: a missing checkpoint is treated as lost execution state, never as proof that the parent made no changes. It also avoids capability flags and compatibility branches whose only purpose would be to preserve incomplete adapters.
