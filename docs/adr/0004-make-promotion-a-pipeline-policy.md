# Make promotion a pipeline policy

Promotion is configured once for the complete pipeline instead of independently on agent nodes. Nodes retain filesystem, terminal and network policies, while the pipeline selects one final outcome strategy: discard, ask, auto-apply or auto-reject. A single policy matches the atomic multi-agent change set and prevents contradictory node-level promotion decisions.
