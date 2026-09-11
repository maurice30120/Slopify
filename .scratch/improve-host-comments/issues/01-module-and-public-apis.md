# 01: Module overview and public APIs documentation

**What to build:** Add comprehensive file-level JSDoc explaining the module's overall purpose as an adapter bridging the pipeline runtime to CLI lifecycle management. Document the `CliPipelineHost` class responsibilities, key architectural invariant (paused runs attach; terminal runs clean up), and JSDoc for all public methods (`listPipelines`, `start`, `resume`, `cancel`, `recover`, `dispose`). Each public method should explain its purpose, parameters, return type, and key side effects, particularly cleanup behavior after terminal results.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] File-level JSDoc comment added explaining module purpose and key invariants
- [ ] `CliPipelineHost` class JSDoc added describing responsibilities and lifecycle
- [ ] Constructor JSDoc added with initialization details and fallback logic
- [ ] All public methods have JSDoc with purpose, parameters, return type, and side effects
- [ ] Cleanup behavior after terminal results is clearly documented
- [ ] Comments follow technical terminology from CONTEXT.md (e.g., "Sandbox Run", "Promotion")
