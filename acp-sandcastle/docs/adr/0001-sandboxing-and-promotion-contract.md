# ADR-0001 : Sandboxing and promotion contract

**Status**: Accepted

## Context

ACP integrations use Sandcastle to let coding agents modify a repository without writing directly to the host workspace. The same Sandcastle package is consumed by multiple surfaces, including VS Code and Pi. Those consumers have different lifecycles, but the sandboxing guarantee must stay identical.

Implementation agents need an autonomous mode: they should be able to run tools and edit files without asking for every operation. That autonomy is acceptable only if it is confined to an isolated worktree and followed by an explicit promotion decision.

## Decision

Sandcastle owns the filesystem safety contract for sandboxed runs.

The contract is:

- A Sandcastle run writes to a disposable Git worktree, not directly to the host workspace.
- Host workspace mutation happens only through promotion.
- `sideEffects: workspace` means "changes may be promoted", not "changes are already applied".
- Consumers may run sandboxed implementers with permissive tool approval, including `allowAll`, because the mutation boundary is the worktree.
- Promotion outcomes are part of the shared contract: `applied`, `no_changes`, `rejected`, `cancelled`.
- `rejected` means an explicit decision to discard changes.
- `cancelled` means no explicit promotion decision was made; the sandbox is still discarded.
- A failed apply must not partially mutate the host workspace.

## Consequences

### Positive

- Consumers can run implementation agents in autonomous mode without giving them direct host writes.
- VS Code and Pi can share the same mental model despite different runtime lifecycles.
- Promotion remains the final safety boundary.

### Negative

- Consumers must implement and test the promotion lifecycle, not only process execution.
- Bugs in worktree setup or promotion are high-impact because they define the safety boundary.

### Neutral

- Sandcastle does not dictate whether a consumer keeps a long-lived bridge or starts one process per run.
- Consumers may expose different UI for promotion as long as the outcomes remain compatible.
