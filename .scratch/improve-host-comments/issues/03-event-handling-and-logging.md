# 03: Event handling and logging integration documentation

**What to build:** Document the `createRuntime` callback explaining how runtime events are logged and dispatched through the event system. Add structured comments explaining the relationship between `eventNode` and logging, when nodes are added/removed from `activeAgentNodes`, why non-agent nodes (pause nodes) are still logged, and formatting of node_started, node_completed, and node_failed messages for terminal output. Document `createDefaultSessionFactory` explaining that it wraps the runner to add logging, error handling, and active-node attachment. Clarify how `onSessionUpdate` propagates notifications to logs and UI, and how `onStatus` provides diagnostic messages for debug logging.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `createRuntime` callback has structured comments explaining event logging and dispatch
- [ ] `eventNode` and logging relationship is documented
- [ ] `activeAgentNodes` add/remove logic is clearly explained
- [ ] Non-agent node logging (pause nodes) is documented
- [ ] Node event message formatting is explained
- [ ] `createDefaultSessionFactory` wrapper logic is documented
- [ ] `onSessionUpdate` propagation to logs and UI is clarified
- [ ] `onStatus` diagnostic status behavior is explained
- [ ] Relationship between wrapper and `PipelineRuntimeAgentAdapter` is documented
