# Use Docker Sandboxes global network policies

Slopify exposes Docker Sandboxes’ three global network choices—Open, Balanced and Locked Down—and initializes `sbx` with the corresponding `allow-all`, `balanced` or `deny-all` policy on first use. Node-level `enabled` and `disabled` network policies are removed. Sandboxes inherit Docker’s global policy so Slopify does not duplicate an evolving security ruleset or present a conflicting network model.
