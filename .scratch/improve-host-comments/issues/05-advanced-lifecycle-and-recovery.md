# 05: Advanced lifecycle and recovery documentation

**What to build:** Document the `resume` and `recover` methods explaining that they reuse existing runtimes (or restore via `requireRuntime`). Add note that run logs persist during pause/resume cycles and cleanup occurs only after terminal status. Document `requireRuntime` method explaining that it checks for active runtime; if not found, attempts restoration from run store using snapshot. Explain fallback logic: use `restoreProgram` if provided, otherwise find program by pipeline ID. Note that restoration succeeds only if snapshot exists and is in 'paused' or 'running' status. Include structured comments on checkpoint restoration, run recovery, and cancellation flow from start → active → pause/resume → terminal.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `resume` method documented with explanation of runtime reuse and log persistence
- [ ] `recover` method documented explaining snapshot-based restoration
- [ ] `requireRuntime` method has clear comments on lookup and fallback logic
- [ ] Snapshot existence and status checks are explained
- [ ] `restoreProgram` fallback and program lookup are documented
- [ ] Lifecycle flow (start → active → pause/resume → terminal) is documented
- [ ] Checkpoint restoration behavior is explained
- [ ] Cancellation handling is documented
- [ ] State transition preconditions and postconditions are clear
