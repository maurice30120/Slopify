# 02: State management and lifecycle documentation

**What to build:** Document all private properties tracking state: `runtimes` (active pipeline runtimes by run ID), `runLogs` (persistence logs deleted after terminal results), `activeAgentNodes` (executing agent nodes), and per-run-node caches (`activityByNode`, `streamedContentByNode`, `streamedTextByNode`, `blockStreamByNode`). Add structured comments explaining the lifecycle of `cleanupTerminalResult`, documenting what triggers cleanup (terminal status, not paused), why it's necessary (memory safety, stale callbacks), which caches are cleared, and the key-prefix cleanup logic for per-run-node state.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Private properties documented with purpose, lifecycle, and cleanup order
- [ ] `runtimes`, `runLogs`, `activeAgentNodes` maps clearly explained
- [ ] Per-run-node caches (`activityByNode`, `streamedContentByNode`, etc.) documented
- [ ] `cleanupTerminalResult` method has structured comments explaining triggers, necessity, cleared caches
- [ ] Key-prefix matching logic for cleanup is documented
- [ ] Comments explain invariants: paused runs attach; terminal runs clean up
- [ ] Memory safety guarantees are explicitly stated
