# Specification: Improve Comments in slopify/src/host.ts

## Problem Statement

The `slopify/src/host.ts` file contains a mix of French and English comments, some of which lack sufficient detail or clarity about the architectural reasoning, lifecycle invariants, and complex internal logic. Developers and future maintainers struggle to understand:

- The purpose and architectural role of major classes and their public APIs
- Why certain design decisions were made (e.g., when to keep runs attached vs. cleanup)
- Complex state-management invariants and lifecycle transitions
- Event handling patterns and session update workflows
- The behavior and cleanup logic for terminal results, logs, and streaming content
- Pause/resume mechanics and state restoration

This makes the codebase harder to navigate, maintain, and extend.

## Solution

Translate all French comments into English and comprehensively document `host.ts` with:

1. **JSDoc for major classes, exports, and public methods** — explaining purpose, responsibilities, and key invariants
2. **Structured inline comments** for complex internal logic — clarifying architectural decisions, state transitions, and cleanup behavior
3. **Concise, technical documentation** of event callbacks, session attachment, log persistence, and streaming
4. **Accurate explanation of lifecycle management** — paused runs remain attached; terminal runs are cleaned up
5. **Details on key technical behaviors** — key-prefix cleanup, markdown block streaming, session notification sanitization, activity tracking

All comments remain accurate and avoid restating obvious code. The changes are **comments only** — no implementation, API, control flow, or type changes.

## User Stories

1. As a new developer joining the project, I want to understand the overall responsibility of the `CliPipelineHost` class and its lifecycle hooks, so that I can quickly grasp how it orchestrates pipeline execution within the CLI.

2. As a maintainer, I want to understand why paused runs remain in memory while terminal runs are cleaned up, so that I can correctly handle state transitions without introducing memory leaks or data loss.

3. As a contributor debugging streaming output, I want clear documentation of how thoughts and messages are streamed to the terminal, including markdown block rendering and handling of delta vs. cumulative text, so that I can reason about and fix streaming bugs.

4. As an engineer extending event handling, I want to understand the event callback flow — including how runtime events, session updates, and status changes propagate through the logging system, so that I can add new event handlers correctly.

5. As someone implementing a new backend, I want to understand how `createDefaultSessionFactory` wraps a runner, logs agent lifecycle events, and attaches logs to active nodes, so that I can implement compatible backends.

6. As a developer investigating log persistence bugs, I want clear documentation of `PipelineRunLog`'s structure, the distinction between run-level and node-level logs, and how events are serialized to JSONL, so that I can trace log flow and debug serialization issues.

7. As someone working with agent state, I want to understand the maps tracking active agent nodes, streaming content, and activity phases (thoughts vs. messages), so that I can correctly maintain and clean up these caches.

8. As a terminal/UI developer, I want to understand how session notifications are sanitized to exclude internal reasoning from persistent logs while still displaying it to verbose output, so that I can trust the privacy and compliance guarantees.

9. As an operator deploying Slopify, I want to understand how terminal-result cleanup works (deleting runtimes, runLogs, and related caches by run ID prefix), so that I can verify memory safety and monitor cleanup in production.

10. As a TypeScript developer reading the code, I want all comments to be in English with clear technical vocabulary, so that I can collaborate cross-linguistically and search documentation effectively.

11. As someone understanding lifecycle state machines, I want documentation explaining the flow from start → active → pause/resume → terminal, including checkpoint restoration, run recovery, and cancellation, so that I can trace execution paths.

12. As a developer tuning log verbosity, I want clear comments explaining the interaction between `LogLevel` filtering, `shouldLog()`, terminal output control, and the host logger's behavior, so that I can understand and modify diagnostic output.

13. As an engineer working with block streams for TTY rendering, I want to understand when markdown block streaming is enabled (TTY + ANSI support), how streams are flushed, and how to transition between thought and message phases, so that I can maintain or extend the streaming logic.

14. As someone analyzing the initialization flow, I want to understand how the constructor initializes the logger, backend, programs, and session factory, including the fallback logic when `createSession` is not provided, so that I can trace setup correctly.

15. As a developer working on error formatting, I want clear comments documenting `serializeError`, `formatError`, and `formatErrorValue` functions, including their handling of custom error properties (code, data, cause), so that I can extend error diagnostics reliably.

## Implementation Decisions

### 1. Module-Level Documentation
- Add a file-level JSDoc comment explaining the module's overall purpose: adapting the pipeline runtime to the CLI lifecycle, managing runs, logging, and event streaming.
- Include a brief note on the key invariant: paused runs remain attached for resumption; terminal runs are cleaned up immediately.

### 2. Class and Public API Documentation
- `CliPipelineHost`: Document its role as the main orchestrator. Explain that it manages multiple concurrent pipeline runs, maintains state for agent nodes and streaming content, and ensures cleanup on terminal results.
- Constructor: Document initialization of backend, programs, logger, and session factory. Note the fallback when `createSession` is not provided.
- Public methods (`listPipelines`, `start`, `resume`, `cancel`, `recover`, `dispose`): Add JSDoc explaining each method's purpose, parameters, return type, and key side effects (e.g., cleanup behavior after terminal results).

### 3. Private Properties Documentation
- Document the purpose and lifecycle of maps tracking:
  - `runtimes`: Active `PipelineRuntime` instances keyed by run ID.
  - `runLogs`: `PipelineRunLog` instances for persistence, deleted after terminal results.
  - `activeAgentNodes`: Agent nodes currently executing, cleared on terminal results.
  - `activityByNode`, `streamedContentByNode`, `streamedTextByNode`, `blockStreamByNode`: Streaming and activity state, keyed by `runId:nodeId`, cleaned up by run-ID prefix after terminal results.

### 4. Lifecycle and State Transitions
- Add a structured comment in `cleanupTerminalResult` explaining:
  - What triggers cleanup (terminal status, not paused).
  - Why cleanup is necessary (to avoid memory leaks and stale callbacks).
  - Which caches are cleared and why (runtimes, logs, node trackers, streaming state).
  - The cleanup logic for per-run-node state using key-prefix matching.

### 5. Event Handling and Logging Integration
- In the `createRuntime` callback (`onEvent`):
  - Explain how runtime events are logged and dispatched.
  - Document the relationship between `eventNode` and logging.
  - Clarify when nodes are added/removed from `activeAgentNodes`.
  - Note that non-agent nodes (pause nodes) are still logged.
  - Explain formatting of node_started, node_completed, and node_failed messages for terminal output.

### 6. Session Factory and Agent Wrapping
- In `createDefaultSessionFactory`:
  - Explain that this factory wraps the runner to add logging, error handling, and active-node attachment.
  - Document how `onSessionUpdate` propagates session notifications to logs and UI.
  - Clarify how `onStatus` provides diagnostic status messages for debug logging.
  - Note the return statement uses `PipelineRuntimeAgentAdapter` to adapt the wrapped runner to the session factory interface.

### 7. Session Update and Streaming
- In `reportSessionUpdate`:
  - Explain the purpose: forward session notifications (thoughts, messages) to logs and UI.
  - Document the three phases: filtering (only agent_thought_chunk and agent_message_chunk), phase detection (previous activity kind vs. new kind), and content streaming.
  - Clarify that thoughts are excluded from persistent logs (see `sanitizeSessionNotification`) but displayed in verbose mode.
  - Explain the markdown block streaming logic: when enabled (TTY + ANSI), use `MarkdownBlockStream`; otherwise, write raw text.
  - Document the delta-vs.-cumulative logic: some adapters send deltas; others send full accumulated text. Only render the new suffix to avoid duplication.
  - Explain the phase transition: when switching from thought to message (or vice versa), flush the previous stream and output a phase label.

### 8. Content Streaming and Block Rendering
- In `reportSessionUpdate` (streaming section):
  - Document that streaming is active only in verbose log level.
  - Explain the `MarkdownBlockStream` usage: terminal width configuration, flushing behavior, and block-based rendering.
  - Note the environment variable `SLOPIFY_ANSI_STREAM=0` to disable block rendering and fallback to plain text.
  - Clarify that non-TTY streams (pipes, tests) use plain text by default.

### 9. Terminal Result Cleanup
- Add a structured comment documenting `cleanupTerminalResult`:
  - Triggers only on non-paused results (failed, completed, cancelled).
  - Removes the runtime from memory.
  - Removes the run log.
  - Clears active agent nodes.
  - Removes all per-run-node state by key-prefix matching on `runId:`.
  - Explain that this prevents memory leaks and stale callback invocations.

### 10. Pause/Resume and Recovery
- In `resume` and `recover`:
  - Explain that these methods reuse the existing runtime (or restore it via `requireRuntime`).
  - Note that the run log persists during pause/resume cycles.
  - Clarify that cleanup only occurs after the run reaches a terminal status.

### 11. Runtime Restoration
- In `requireRuntime`:
  - Explain that this method checks for an active runtime; if not found, it attempts to restore from the run store using a snapshot.
  - Document the fallback logic: use `restoreProgram` if provided, otherwise find the program by pipeline ID.
  - Note that restoration only succeeds if the snapshot exists and is in 'paused' or 'running' status.

### 12. Logging Infrastructure
- Document `PipelineRunLog`:
  - Explain its purpose: persist run and node events to JSONL files in `.acp/logs`.
  - Note that each run creates a main log file named with ISO timestamp, pipeline ID, and run ID.
  - Explain node-level logging: each agent node gets a separate log file for diagnostic isolation.
  - Document the static factory (`create`) and cleanup (`clear`).

### 13. Session Notification Sanitization
- In `sanitizeSessionNotification`:
  - Explain that this function excludes internal reasoning (agent_thought_chunk) from persistent logs for privacy and compliance.
  - Clarify that the log retains only the size (in bytes) of the thought, not its content.
  - Note that message chunks (agent_message_chunk) are preserved in full.
  - Document that agent thoughts are still displayed to the user in verbose mode (see `reportSessionUpdate`).

### 14. Error Handling and Formatting
- Document `serializeError`: converts an Error to a serializable object with name, message, stack, and custom properties (code, data).
- Document `formatError`: formats an error for terminal display, including code, data, and nested cause chains.
- Document `formatErrorValue`: handles nested values in error properties, using JSON serialization when possible.

### 15. Helper Functions and Constants
- Document `activityKey`: constructs the `runId:nodeId` key for caching streaming and activity state.
- Document `formatAgentLabel`: formats the agent node label for terminal display, distinguishing node ID from agent name when different.
- Document `formatDuration`, `formatBytes`, and `formatCompletionParts`: utilities for formatting run completion summaries.
- Document `LOG_LEVEL_RANK`: rank map for comparing log levels; used by `shouldLog`.
- Document `AGENT_EXIT_LOG`: regex pattern that filters out spurious agent exit diagnostics from verbose output.

### 16. Comment Style and Terminology
- Use English exclusively, except for established domain terms already in the project glossary (e.g., "Sandbox Run", "Agent Checkpoint", "Promotion", "Reprise").
- Use domain vocabulary from `CONTEXT.md` consistently: e.g., "Sandbox Run" instead of "container run", "Promotion" instead of "apply".
- Provide technical clarity without restating code logic; comments explain *why* and *what invariants must hold*, not *what the code does*.
- Use JSDoc for public APIs; structured inline comments (// Comment\n// for multi-line) for complex internal logic.
- Include examples in comments only when they clarify a non-obvious pattern or edge case.

## Testing Decisions

### What Makes a Good Test
Tests should verify external behavior (public APIs, lifecycle transitions, log output, cleanup) without coupling to implementation details (private properties, internal map structure, helper function specifics). Tests should be minimal and focused on a single behavioral concern.

### Which Modules Will Be Tested
- **No new tests are needed** because this is a comments-only change that does not alter runtime behavior, API signatures, or control flow.
- **Existing test coverage** (if any) for `host.ts` should remain green after comment changes.

### Testing Seam: TypeScript Build/Type-Check
- **Testing seam**: Run the targeted TypeScript build and type-check command already defined in the repository.
- The seam validates that comments are syntactically correct (no broken JSDoc), types remain sound, and no accidental code changes were introduced.
- **Verification process**:
  1. Review the final diff to confirm only comments changed.
  2. Run the TypeScript build/type-check for the `slopify` package or containing module.
  3. Confirm no new TypeScript errors, warnings, or import issues.
  4. If linting includes comment checks (e.g., JSDoc linting), run that as well.

### Prior Art
- The `slopify/src/host.ts` file likely already has TypeScript strict mode enabled and may have existing JSDoc on exports.
- Existing comments (French and partial English) provide context for what documentation is needed.
- No need for unit tests; the change is purely documentation.

## Out of Scope

- **Implementation refactoring**: No changes to control flow, algorithms, or logic.
- **API changes**: No modification to method signatures, exports, or public contracts.
- **Type system changes**: No alterations to interfaces, types, or generic parameters.
- **New tooling or tests**: No addition of linters, test frameworks, or testing infrastructure.
- **Formatting unrelated to comments**: No blanket reformatting, indentation changes, or whitespace normalization beyond what is necessary to support comment improvements.
- **Files under `.scratch/`**: This specification file is documentation-only; no implementation or product files are created or modified.
- **Glossary or CONTEXT.md updates**: Domain terms are already established in `CONTEXT.md`. No new terms need to be added.
- **Architecture Decision Records (ADRs)**: This is a documentation task, not a design decision that requires an ADR.
- **New documentation files**: All documentation is added via comments in the source file; no separate `.md` files are created.

## Further Notes

### Comment Completeness
The improved comments should cover:

1. **File-level context**: High-level purpose and key invariants.
2. **Class-level context**: Responsibilities, lifecycle, and architectural role.
3. **Method-level context**: Purpose, parameters, return value, side effects, and key behaviors.
4. **Complex internal logic**: State-machine transitions, invariants, cleanup order, and design rationale.
5. **Edge cases**: Non-obvious behavior, special handling for TTY vs. non-TTY streams, delta vs. cumulative text, etc.
6. **Integration points**: How the class interacts with `PipelineRuntime`, backend, logger, and terminal.

### Translation and Tone
- All French comments are translated to English with technical precision.
- Comments use vocabulary from the project's domain glossary (`CONTEXT.md`), e.g., "Sandbox Run", "Promotion", "Reprise".
- The tone is professional and concise; comments avoid humor or colloquialisms.
- Comments assume the reader has basic TypeScript and async/await knowledge but may not be familiar with the Slopify architecture; explanations are self-contained.

### Verification Checklist
After implementation:
- [ ] All French comments are translated to English.
- [ ] File-level JSDoc explains the module purpose and key invariants.
- [ ] All public classes and methods have JSDoc.
- [ ] Complex internal logic is documented with inline structured comments.
- [ ] Event handling, session updates, and lifecycle transitions are clearly explained.
- [ ] Cleanup behavior and state-management invariants are documented.
- [ ] Comments do not restate obvious code; they explain *why* and *what matters*.
- [ ] Diff shows only comment changes; no code, type, or API changes.
- [ ] TypeScript build/type-check passes without new errors or warnings.
- [ ] No existing tests are broken by the comment changes.
