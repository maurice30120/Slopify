# ADR-0002 : Vibe provider sandbox contract

**Status**: Accepted

## Context

Vibe is used as a Sandcastle provider for implementation work. In sandboxed non-interactive mode it is launched inside the sandbox and streams JSON events. Some Vibe runs emit assistant output in `reasoning_content` while leaving `content` empty.

Without a shared provider contract, consumers can disagree on whether a run produced assistant output. That creates pipeline failures where the agent worked and ran tools but the pipeline receives an empty step result, or the opposite failure where an early reasoning chunk is treated as a successful final implementation result.

Vibe sandboxed programmatic mode also requires the user prompt to be passed through the `--prompt` CLI option. Passing the prompt only on stdin can start Vibe in programmatic mode without a prompt, causing the provider to fail with `No prompt provided for programmatic mode` after the pipeline has already launched a sandbox run.

This ADR is not an ACP protocol contract. ACP clients and bridges may still exchange prompts as normal ACP `session/prompt` text blocks. The decision below only applies when a Sandcastle runtime translates that ACP prompt into the Vibe CLI command executed inside the sandbox.

## Decision

Sandcastle treats Vibe as a supported sandbox provider.

The sandboxed Vibe CLI provider contract is:

- Vibe runs with `vibe --prompt '<escaped prompt>' --output streaming --trust`.
- The prompt is passed as the `--prompt` argument, never only through stdin.
- Prompt values are shell-escaped before being interpolated into the command.
- `VIBE_ACTIVE_MODEL` carries the configured model.
- `VIBE_HOME` inside the sandbox is `/home/agent/.vibe`.
- The host Vibe home is mounted or prepared as writable sandbox state.
- A Vibe assistant event emits text from `content` when present.
- If `content` is empty, `reasoning_content` may be streamed as assistant text, but it is not promoted to a final result.
- Session identifiers emitted by Vibe are preserved as provider session metadata when available.
- Sandboxed Vibe defaults to at least 5 max iterations, matching implementation-agent work instead of a single inspection pass.

Pipeline prompts that use Vibe Sandcastle as an implementation agent must make the implementation contract explicit:

- Planner prompts ask for likely code areas to change, concrete implementation steps, validation commands, and acceptance criteria.
- Implementer prompts require actual workspace changes, prohibit stopping after inventory or analysis, and require a blocker explanation if no change can be made.
- Implementer prompts require a final diff-oriented summary of changed files and validation.

Regression coverage must assert the built sandbox print command includes `--prompt '<escaped prompt>'` and does not rely on a `stdin` prompt. This coverage is required in every consumer that owns a Vibe Sandcastle runtime implementation.

## Consequences

### Positive

- Vibe Sandcastle can be used consistently by VS Code and Pi.
- Pipelines can stream reasoning-only Vibe responses without treating them as completed implementation results.
- Vibe implementation runs have enough default iterations to inspect, edit, and summarize.
- Pipeline implementation runs do not fail because the sandboxed Vibe CLI receives an empty programmatic prompt.
- Authentication and provider state are kept outside the repository tree while still being available inside the sandbox.

### Negative

- Consumers must keep their stream parsing aligned with this contract.
- Consumers must shell-escape prompt arguments correctly before command construction.
- Default pipeline prompt templates must stay aligned with the implementation-agent contract.
- Sandcastle images must include a working `vibe` executable for this provider to work.

### Neutral

- This does not require Vibe to be the only Sandcastle implementer.
- Consumers may still choose Codex, Cursor, or Pi providers for other workflows.
