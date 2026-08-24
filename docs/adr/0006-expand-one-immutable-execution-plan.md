# Expand one immutable execution plan

After task creation, Slopify validates the authoritative Ticket Graph and expands the main Sandbox Run once with its dynamic nodes. The resulting Execution Plan becomes immutable before implementation starts. Discovering additional work requires a new plan version rather than mutating an active plan.

The versioned Execution Plan format is persisted in the run snapshot so recovery reuses the exact same graph. Each node has a stable identity derived from its ticket rather than its position in a list.

The runtime starts ready nodes up to the run's configured concurrency limit. A node that exhausts its retries blocks its descendants; already active nodes finish cleanly, and the runtime starts no additional nodes. Retries preserve the node identity and receive distinct attempt numbers.

Each descendant sandbox is prepared from the integrated Agent Checkpoints of its dependencies in deterministic order. An integration conflict suspends the run as an Integration Conflict without mutating the host workspace.

The final review depends on every terminal node. It starts only after their Agent Checkpoints have been integrated into one provisional Pipeline Change Set. A rejected review invalidates that provisional result. The pipeline therefore retains one execution state and one atomic promotion decision while gaining dependency-aware parallelism.
