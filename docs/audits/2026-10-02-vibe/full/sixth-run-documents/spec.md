# Specification: Fix Docker Sandbox Diagnostics

## Problem Statement

The current `assertSuccess` method in `acp-sandbox/src/runtime.ts` uses `result.stderr.trim() || result.stdout.trim()` to construct error messages. This approach masks stdout when stderr is present, potentially hiding useful diagnostic information from users. When a Docker command fails, both stderr and stdout may contain relevant information for debugging, but the current implementation only shows stderr.

## Solution

Modify the `assertSuccess` method to preserve both stdout and stderr streams in error messages when a subprocess fails. The error message will include both streams with clear labels, separated by newlines, showing only non-empty trimmed streams.

## User Stories

1. As a developer debugging a Docker sandbox failure, I want to see both stdout and stderr from failed commands, so that I can understand the complete context of what went wrong.

2. As a maintainer of the ACP pipeline, I want consistent error formatting for subprocess failures, so that diagnostic information is always presented in a predictable and readable format.

3. As a user encountering sandbox execution errors, I want clear labeling of stdout and stderr content, so that I can distinguish between the different output streams.

## Implementation Decisions

- **Error message format**: Text Error message with labels `[stderr]` and `[stdout]`, separated by newline. Each stream is trimmed, and only non-empty streams are displayed.
- **Prefix preservation**: Keep the existing `Unable to <action>: ` prefix for consistency with current error messages.
- **Fallback behavior**: Display the exit code (e.g., `exit code N`) when neither stdout nor stderr contains any content.
- **No truncation or deduplication**: Do not apply additional truncation or deduplication logic beyond trimming whitespace.
- **Test coverage**: Add unit tests via `fakeExecutor` on `DockerSandboxRuntime` covering:
  - Both stdout and stderr present
  - Only stdout present
  - Only stderr present
  - Neither stdout nor stderr present (fallback to exit code)
  - Success case unchanged (no error thrown)
- **Public interfaces and diagnostics schema**: Remain unchanged to maintain backward compatibility.
- **No domain vocabulary changes**: No updates to `CONTEXT.md` or ADRs required.

## Testing Decisions

- **Test approach**: Unit tests using `fakeExecutor` to simulate different subprocess result scenarios without requiring actual Docker execution.
- **Test cases**: Each test will create a `DockerSandboxRuntime` instance with a `fakeExecutor` that returns specific `SubprocessResult` configurations to verify the error message formatting.
- **Validation**: Run `npm test` to ensure all existing tests continue to pass and new tests validate the corrected behavior.
- **Test file**: Add tests to `acp-sandbox/test/runtime.test.ts` in a dedicated test suite for `assertSuccess` behavior.

## Out of Scope

- Changes to public interfaces or diagnostics schema
- Updates to domain vocabulary or ADRs
- Modifications to other parts of the codebase beyond `assertSuccess` method
- Integration tests requiring actual Docker execution
- Changes to error handling behavior beyond message formatting

## Further Notes

The fix addresses a specific diagnostic visibility issue where important stdout information was being suppressed when stderr was present. This is particularly important for Docker sandbox operations where both streams may contain valuable debugging information. The solution maintains backward compatibility while improving the debugging experience.