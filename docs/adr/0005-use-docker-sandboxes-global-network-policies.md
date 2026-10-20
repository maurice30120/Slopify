# Use Docker Sandboxes global network policies

> Les essais Docker Engine proposés dans l’[ADR 0018](0018-use-docker-engine-for-v2-workers.md) ne reproduiront pas les politiques `sbx`. Le prototype d’architecture précède toute adoption de cette alternative en V2.

Slopify exposes Docker Sandboxes’ three global network choices—Open, Balanced and Locked Down—and initializes `sbx` with the corresponding `allow-all`, `balanced` or `deny-all` policy on first use. Node-level `enabled` and `disabled` network policies are removed. Sandboxes inherit Docker’s global policy so Slopify does not duplicate an evolving security ruleset or present a conflicting network model.
