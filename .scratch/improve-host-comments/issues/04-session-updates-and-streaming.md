# 04: Session updates and streaming documentation

**What to build:** Document the `reportSessionUpdate` method with clear explanation of its three phases: filtering (only agent_thought_chunk and agent_message_chunk), phase detection (comparing previous and new activity kinds), and content streaming. Add structured comments explaining that thoughts are excluded from persistent logs (see `sanitizeSessionNotification`) but displayed in verbose mode. Document markdown block streaming logic: when enabled (TTY + ANSI), use `MarkdownBlockStream`; otherwise, write raw text. Explain delta-vs.-cumulative logic (some adapters send deltas; others send accumulated text; only render new suffix to avoid duplication). Document phase transitions: when switching from thought to message (or vice versa), flush previous stream and output phase label. Include environment variable `SLOPIFY_ANSI_STREAM=0` documentation for disabling block rendering.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `reportSessionUpdate` method has clear documentation of three phases
- [ ] Phase filtering logic is explained (agent_thought_chunk, agent_message_chunk)
- [ ] Phase detection and transition logic is documented
- [ ] Comment explains thought exclusion from persistent logs vs. verbose display
- [ ] `MarkdownBlockStream` usage and configuration is documented
- [ ] TTY vs. non-TTY stream behavior is explained
- [ ] Delta-vs.-cumulative text handling is documented with suffix logic
- [ ] Phase transition behavior (flush, label output) is explained
- [ ] Environment variable `SLOPIFY_ANSI_STREAM=0` is documented
- [ ] Streaming verbosity control (active only in verbose log level) is noted
