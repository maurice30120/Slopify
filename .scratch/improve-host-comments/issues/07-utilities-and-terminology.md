# 07: Utilities, helpers, and terminology documentation

**What to build:** Document helper functions and constants: `activityKey` (constructs `runId:nodeId` key for caching streaming/activity state); `formatAgentLabel` (formats agent node label for terminal, distinguishing node ID from agent name when different); `formatDuration`, `formatBytes`, `formatCompletionParts` (utilities for formatting run completion summaries). Document `LOG_LEVEL_RANK` (rank map comparing log levels, used by `shouldLog`). Document `AGENT_EXIT_LOG` (regex pattern filtering spurious agent exit diagnostics from verbose output). Ensure all comments use English exclusively, apply consistent domain vocabulary from CONTEXT.md (e.g., "Sandbox Run", "Promotion", "Reprise"). Provide technical clarity without restating code logic; comments explain *why* and *what invariants*, not *what the code does*.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `activityKey` purpose and format is documented
- [ ] `formatAgentLabel` logic and use cases are explained
- [ ] `formatDuration`, `formatBytes`, `formatCompletionParts` purposes are documented
- [ ] `LOG_LEVEL_RANK` and `shouldLog` integration is explained
- [ ] `AGENT_EXIT_LOG` regex pattern and filtering behavior is documented
- [ ] All French comments are translated to English
- [ ] Domain vocabulary from CONTEXT.md (Sandbox Run, Promotion, Reprise) is used consistently
- [ ] Comments avoid restating obvious code; they explain *why* and invariants
- [ ] Technical terminology is accurate and consistent throughout
- [ ] Comments assume TypeScript/async/await knowledge but explain Slopify concepts
