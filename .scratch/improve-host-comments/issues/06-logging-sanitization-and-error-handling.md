# 06: Logging, sanitization, and error handling documentation

**What to build:** Document `PipelineRunLog` explaining its purpose (persist run and node events to JSONL files in `.acp/logs`). Clarify that each run creates a main log file with ISO timestamp, pipeline ID, and run ID. Explain node-level logging: each agent node gets separate log file for diagnostic isolation. Document static factory (`create`) and cleanup (`clear`). Add structured comments for `sanitizeSessionNotification` explaining that it excludes internal reasoning (agent_thought_chunk) from persistent logs for privacy/compliance, retaining only thought size in bytes, while preserving message chunks (agent_message_chunk) in full. Document `serializeError` converting Error to serializable object with name, message, stack, and custom properties (code, data). Document `formatError` formatting error for terminal display including code, data, and nested cause chains. Document `formatErrorValue` handling nested values in error properties using JSON serialization.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `PipelineRunLog` class documented with purpose and file structure
- [ ] Log file naming and location is explained
- [ ] Node-level log isolation is documented
- [ ] Static factory (`create`) and cleanup (`clear`) are explained
- [ ] `sanitizeSessionNotification` privacy/compliance rationale is clear
- [ ] Thought exclusion and size-only retention is documented
- [ ] Message chunk preservation is explained
- [ ] `serializeError` conversion logic is documented
- [ ] `formatError` terminal formatting including nesting is explained
- [ ] `formatErrorValue` nested value handling is documented
- [ ] Custom error properties (code, data, cause) are clearly listed
